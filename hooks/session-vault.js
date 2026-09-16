#!/usr/bin/env node
/**
 * session-vault.js — SessionStart hook
 *
 * Git-backed session backup OUTSIDE ~/.claude/ to survive cleanup bugs.
 *
 * Flow:
 *   1. Copy new/changed session JSONLs from ~/.claude/projects/ → ~/.claude-vault/
 *   2. git add + git commit (atomic snapshot with timestamp)
 *
 * Vault lives at ~/.claude-vault/ (git repo, local only).
 * Structure mirrors projects/:
 *   ~/.claude-vault/<project-name>/<session-id>.jsonl
 *
 * Incremental: skips files already in vault with same or larger size.
 * Transactional: writes to .tmp then renames before git commit.
 * Historical: git log shows full append history, detects replacements.
 *
 * Timeout: 30s in settings.json (plenty for copy + commit).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HOME = process.env.HOME || process.env.USERPROFILE;
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const VAULT_DIR = path.join(HOME, '.claude-vault');

function gitExec(args) {
  execFileSync('git', args, { cwd: VAULT_DIR, stdio: 'ignore' });
}

// Where arca actually lives. The old two-levels-up path only resolved
// from the source tree; once the hook is deployed to ~/.claude/hooks/ it points
// at a directory that does not exist -- and existsSync turned that into silence.
// The indexer never ran once.
function vaultMemoryDir() {
  const tried = [];
  // ARCA_HOME points at the arca checkout. VAULT_MEMORY_HOME and CONOTI_LEARN_REPO
  // are honoured as legacy aliases from the names this carried before.
  const home = process.env.ARCA_HOME || process.env.VAULT_MEMORY_HOME;
  const repo = process.env.CONOTI_LEARN_REPO;
  const candidates = [
    home || null,
    repo ? path.join(repo, 'arca') : null,
    repo ? path.join(repo, 'vault-memory') : null,          // legacy name
    path.join(__dirname, '..'),                              // hook inside the checkout
    path.join(__dirname, '..', '..', 'arca'),                // source layout
    path.join(__dirname, '..', 'arca'),                      // deployed alongside
  ].filter(Boolean);
  for (const c of candidates) {
    tried.push(c);
    if (fs.existsSync(path.join(c, 'index-incremental.js'))) return c;
  }
  note('arca not found, indexing skipped; tried: ' + tried.join(' | '));
  return null;
}

// Anything the hook silently swallowed before now leaves a trace next to the
// copy counters. A derivative layer that stops building must be visible.
function note(msg) {
  try {
    fs.appendFileSync(path.join(VAULT_DIR, 'vault.log'),
      new Date().toISOString() + ' ' + msg + String.fromCharCode(10));
  } catch (_) {}
}

// A hook killed mid-commit leaves .git/index.lock, silently breaking all future
// commits. Clear it if stale (older than 30s — no real git runs that long here).
function clearStaleLock() {
  const lock = path.join(VAULT_DIR, '.git', 'index.lock');
  try {
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    if (age > 30_000) fs.unlinkSync(lock);
  } catch { /* no lock — fine */ }
}

// The search index (index/vault.db) is a large, rebuildable derivative — never
// commit it. Written on init so re-created vaults stay clean.
function ensureGitignore() {
  const gi = path.join(VAULT_DIR, '.gitignore');
  if (!fs.existsSync(gi)) {
    try { fs.writeFileSync(gi, 'index/\n*.tmp\nvault.log\n'); } catch {}
  }
}

function backup() {
  if (!fs.existsSync(PROJECTS_DIR)) return;
  if (!fs.existsSync(VAULT_DIR)) {
    fs.mkdirSync(VAULT_DIR, { recursive: true });
    gitExec(['init']);
    gitExec(['config', 'user.name', 'session-vault']);
    gitExec(['config', 'user.email', 'vault@local']);
  }
  ensureGitignore();

  let copied = 0;
  let skipped = 0;
  let errors = 0;
  const copiedFiles = [];

  const projects = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory());

  for (const proj of projects) {
    const projPath = path.join(PROJECTS_DIR, proj.name);

    // Find session JSONLs at project root (not in subagents/ subdirs)
    let files;
    try {
      files = fs.readdirSync(projPath, { withFileTypes: true })
        .filter(f => f.isFile() && f.name.endsWith('.jsonl') && !f.name.startsWith('agent-'));
    } catch { continue; }

    if (files.length === 0) continue;

    const vaultProjDir = path.join(VAULT_DIR, proj.name);

    for (const file of files) {
      const src = path.join(projPath, file.name);
      const dst = path.join(vaultProjDir, file.name);
      const tmp = dst + '.tmp';

      // Skip if already in vault and vault copy is same size or larger
      if (fs.existsSync(dst)) {
        try {
          const srcStat = fs.statSync(src);
          const dstStat = fs.statSync(dst);
          if (dstStat.size >= srcStat.size) {
            skipped++;
            continue;
          }
        } catch { /* re-copy on error */ }
      }

      // Transactional copy: write to .tmp then rename
      try {
        if (!fs.existsSync(vaultProjDir)) fs.mkdirSync(vaultProjDir, { recursive: true });
        fs.copyFileSync(src, tmp);
        fs.renameSync(tmp, dst);
        copied++;
        copiedFiles.push(dst);
      } catch {
        // Clean up failed tmp
        try { fs.unlinkSync(tmp); } catch {}
        errors++;
      }
    }
  }

  // Git commit if anything changed
  if (copied > 0) {
    try {
      clearStaleLock();
      const msg = `vault: ${copied} sessions (${new Date().toISOString().slice(0, 19)})`;
      gitExec(['add', '-A']);
      gitExec(['commit', '-m', msg]);
    } catch (e) { note('git commit failed: ' + ((e && e.message) ? e.message.slice(0, 200) : e)); }
  }

  // Append to log
  try {
    const logFile = path.join(VAULT_DIR, 'vault.log');
    const line = `${new Date().toISOString()} copied=${copied} skipped=${skipped} errors=${errors}\n`;
    fs.appendFileSync(logFile, line);
  } catch {}

  // Trigger arca incremental indexing for copied files (fire-and-forget)
  if (copiedFiles.length > 0) {
    try {
      const vm = vaultMemoryDir();
      if (vm) {
        const { spawn } = require('child_process');
        const fire = (script, args) => {
          const target = path.join(vm, script);
          if (!fs.existsSync(target)) { note('missing ' + script); return; }
          const child = spawn('node', [target, ...args], { stdio: 'ignore', detached: true });
          child.unref();
        };
        // Exchanges first; the derived layers read what it wrote.
        fire('index-incremental.js', copiedFiles);
        fire('build-entities.js', ['--quiet']);
        fire('build-kg.js', ['--quiet']);
        fire('build-threads.js', ['--quiet']);
      }
    } catch (e) { note('indexing spawn failed: ' + ((e && e.message) ? e.message : e)); }
  }
}

try {
  backup();
} catch { /* never break session start */ }
