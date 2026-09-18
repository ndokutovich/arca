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

import fs from 'fs';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';

// vaultMemoryDir() builds three of its six search candidates on __dirname,
// which ESM does not provide.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HOME = process.env.HOME || process.env.USERPROFILE;
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const VAULT_DIR = path.join(HOME, '.claude-vault');

function gitExec(args) {
  execFileSync('git', args, { cwd: VAULT_DIR, stdio: 'ignore' });
}

/** Same, but returns stdout — `git status` is useless without it. */
function gitRead(args) {
  return execFileSync('git', args, { cwd: VAULT_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
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
// A lock older than half a minute used to be deleted outright. On a vault with
// thousands of files a legitimate `git add` can take longer than that, and two
// hooks starting together could each decide the other's live lock was stale —
// removing it mid-write is how an index gets corrupted. Wait for it instead,
// and only break one that is old enough that no plausible operation is still
// running behind it.
const LOCK_WAIT_MS = 15_000;
const LOCK_BREAK_MS = 10 * 60_000;

function clearStaleLock() {
  const lock = path.join(VAULT_DIR, '.git', 'index.lock');
  const deadline = Date.now() + LOCK_WAIT_MS;

  for (;;) {
    let age;
    try {
      age = Date.now() - fs.statSync(lock).mtimeMs;
    } catch {
      return; // no lock at all, which is the common case
    }
    if (age > LOCK_BREAK_MS) {
      try { fs.unlinkSync(lock); note(`broke a git lock ${Math.round(age / 60000)} min old`); } catch { /* raced */ }
      return;
    }
    if (Date.now() >= deadline) {
      note('git index.lock still held; skipping the commit this run');
      throw new Error('vault git index is locked');
    }
    // Busy-wait briefly: this runs at SessionStart and must not stall it.
    const until = Date.now() + 250;
    while (Date.now() < until) { /* spin */ }
  }
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
  if (!fs.existsSync(VAULT_DIR)) fs.mkdirSync(VAULT_DIR, { recursive: true });
  // Tie the repo to .git, not to the directory. Opening the index creates
  // VAULT_DIR for index/vault.db, so keying on the directory meant init
  // never ran and every later commit failed with 'git add' on no repo.
  if (!fs.existsSync(path.join(VAULT_DIR, '.git'))) {
    try {
      gitExec(['init']);
      gitExec(['config', 'user.name', 'session-vault']);
      gitExec(['config', 'user.email', 'vault@local']);
    } catch (e) { note('git init failed: ' + ((e && e.message) || e)); }
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

      // Size is not identity. Transcripts are append-only in normal use, but a
      // replaced or rewritten one that happens to be the same size or smaller
      // was skipped forever — and the file's own comment claimed replacements
      // were detected. Compare size and mtime, and fall back to copying.
      if (fs.existsSync(dst)) {
        try {
          const srcStat = fs.statSync(src);
          const dstStat = fs.statSync(dst);
          const sameSize = dstStat.size === srcStat.size;
          const notOlder = dstStat.mtimeMs >= srcStat.mtimeMs;
          if (sameSize && notOlder) { skipped++; continue; }
          if (dstStat.size > srcStat.size && notOlder) { skipped++; continue; }
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

  // Commit whenever the repository is dirty, not only when this run copied
  // something. A commit that failed once used to strand its transcripts
  // outside git indefinitely: the next run skipped the already-copied files,
  // so `copied` stayed 0 and the commit was never retried.
  try {
    clearStaleLock();
    let dirty = '';
    try { dirty = gitRead(['status', '--porcelain']) || ''; } catch { dirty = ''; }
    if (dirty.trim()) {
      const pending = dirty.trim().split(String.fromCharCode(10)).length;
      const msg = copied > 0
        ? `vault: ${copied} sessions (${new Date().toISOString().slice(0, 19)})`
        : `vault: ${pending} pending changes (${new Date().toISOString().slice(0, 19)})`;
      gitExec(['add', '-A']);
      gitExec(['commit', '-m', msg]);
    }
  } catch (e) { note('git commit failed: ' + ((e && e.message) ? e.message.slice(0, 200) : e)); }

  // Append to log
  try {
    const logFile = path.join(VAULT_DIR, 'vault.log');
    const line = `${new Date().toISOString()} copied=${copied} skipped=${skipped} errors=${errors}\n`;
    fs.appendFileSync(logFile, line);
  } catch {}

  // Trigger arca incremental indexing for copied files (fire-and-forget)
  // ARCA_HOOK_NO_INDEX lets the hook's own test exercise copy + commit
  // without spawning the indexer, which would pull the embedding model.
  if (copiedFiles.length > 0 && !process.env.ARCA_HOOK_NO_INDEX) {
    try {
      const vm = vaultMemoryDir();
      if (vm) {
        // One detached child, which runs the chain in order and waits between
        // stages. Four detached children raced each other; the ordering this
        // comment used to claim was never actually enforced.
        const runner = path.join(__dirname, 'pipeline.js');
        if (!fs.existsSync(runner)) { note('missing pipeline.js'); }
        else {
          const child = spawn('node', [runner, vm, ...copiedFiles], { stdio: 'ignore', detached: true });
          child.unref();
        }
      }
    } catch (e) { note('indexing spawn failed: ' + ((e && e.message) ? e.message : e)); }
  }
}

try {
  backup();
} catch (e) {
  // Never break session start — but never vanish either. Claude Code shows
  // nothing when a hook fails, so the log is the only place a failure can
  // surface. Swallowing it here is what let an ESM/CJS mismatch run silent.
  try { note('hook failed: ' + ((e && e.stack) || e)); } catch {}
}
