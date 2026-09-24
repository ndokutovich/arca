#!/usr/bin/env node
/**
 * session-vault.js — SessionStart hook
 *
 * Git-backed session backup OUTSIDE ~/.claude/ to survive cleanup bugs.
 *
 * Flow:
 *   1. Copy new/changed session JSONLs from ~/.claude/projects/ → ~/.claude-vault/,
 *      and mirror each session's directory (subagents, tool results) beside it
 *   2. git add + git commit (atomic snapshot with timestamp)
 *
 * Vault lives at ~/.claude-vault/ (git repo, local only).
 * Structure mirrors projects/:
 *   ~/.claude-vault/<project-name>/<session-id>.jsonl
 *   ~/.claude-vault/<project-name>/<session-id>/subagents/...  tool-results/...
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
import { fileURLToPath, pathToFileURL } from 'url';

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

// Git is how the vault keeps its history, not how it keeps its files. Without
// it the archive still fills, the manifests still record which machine wrote
// what, and the index still builds — what is lost is the ability to see when
// a transcript changed, and to sync with another machine. That is a smaller
// loss than refusing to archive anything, so it is a degradation, not a
// failure.
//
// Checked once per process, and said out loud once per vault rather than on
// every session, because a line in the log every few minutes is noise nobody
// reads.
let gitAvailable = null;

function hasGit() {
  if (gitAvailable !== null) return gitAvailable;
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    gitAvailable = true;
  } catch {
    gitAvailable = false;
    const marker = path.join(VAULT_DIR, '.arca', 'no-git');
    if (!fs.existsSync(marker)) {
      note('git not found: archiving without history. Transcripts, manifests and '
        + 'indexing all continue; `git log`, remotes and machine sync do not.');
      try {
        fs.mkdirSync(path.dirname(marker), { recursive: true });
        fs.writeFileSync(marker, new Date().toISOString() + String.fromCharCode(10));
      } catch { /* the note is the important half */ }
    }
  }
  return gitAvailable;
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
  // Order matters, and it used to be wrong: a legacy `vault-memory` checkout
  // under CONOTI_LEARN_REPO outranked the package the hook is part of, so a
  // hook running from inside an arca checkout loaded an older copy next door
  // and every module that copy lacked failed to import. An explicit override
  // still wins; nothing implicit outranks the code this file shipped with.
  const candidates = [
    home || null,                                            // explicit, deliberate
    path.join(__dirname, '..'),                              // the package this hook is part of
    repo ? path.join(repo, 'arca') : null,
    path.join(__dirname, '..', '..', 'arca'),                // source layout
    path.join(__dirname, '..', 'arca'),                      // deployed alongside
    repo ? path.join(repo, 'vault-memory') : null,           // legacy name, last resort
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

// Everything derived or local, which is everything that must never reach a
// remote: the search index, the 90 MB embedding model, logs, and the file
// naming which machine this is — if that one travelled, a pull would tell the
// other machine it was this one.
const IGNORED = [
  // *.tmp-* is the half-written file an interrupted copy leaves behind. It
  // is skipped when reading the vault back, so nothing ever removes it, and
  // `git add -A` would commit it forever.
  'index/', '.cache/', 'models/', '*.tmp', '*.tmp-*', '*.log',
  '.arca/this-machine', '.arca/adopted',
  // Which assistants this machine reads. Two machines hold different ones and
  // can want different answers; a choice made here must not arrive there.
  '.arca/sources.json',
  // When the configuration was last copied. Per machine, like the rest.
  '.arca/config-synced',
  // The id list exists only to diff against the next sample; the log beside
  // it is the part worth keeping.
  '.arca/retention/*.ids',
];

function ensureGitignore() {
  const gi = path.join(VAULT_DIR, '.gitignore');
  let current = '';
  try { current = fs.readFileSync(gi, 'utf8'); } catch { /* absent */ }
  const have = new Set(current.split(String.fromCharCode(10)).map((l) => l.trim()));
  const missing = IGNORED.filter((rule) => !have.has(rule));
  if (!missing.length) return;
  // Append rather than rewrite: a vault may have rules of its own.
  try {
    const sep = current && !current.endsWith(String.fromCharCode(10)) ? String.fromCharCode(10) : '';
    fs.appendFileSync(gi, sep + missing.join(String.fromCharCode(10)) + String.fromCharCode(10));
  } catch { /* the hook must not fail over a gitignore */ }
}

// Repacking a vault of half-gigabyte transcripts runs one delta window per CPU
// with no memory cap by default, and dies: "out of memory" on an allocation a
// machine with 13 GB free could have served ten times over. Auto-gc then gives
// up silently, and the repository grows to a hundred gigabytes of loose
// objects that nothing ever packs.
//
// Applied to every vault, not just new ones -- an existing vault is exactly
// the one already in that state -- and only when a value is missing, so a
// deliberate setting of yours is never overwritten.
function ensurePackLimits() {
  if (!hasGit()) return;
  for (const [key, value] of [['pack.windowMemory', '1g'], ['pack.threads', '1']]) {
    try {
      const current = gitRead(['config', '--get', key]).trim();
      if (current) continue;
    } catch { /* unset exits non-zero, which is the case we are here for */ }
    try { gitExec(['config', key, value]); }
    catch (e) { note('could not set ' + key + ': ' + ((e && e.message) || e)); }
  }
}

// A session is not one file. Beside each transcript Claude Code keeps a
// directory named after the session: subagents/ (workflow agents one level
// deeper, in subagents/workflows/wf_<id>/), tool-results/ that the transcript
// points at, a .meta.json per agent. The hook used to copy the transcript and
// walk past the directory, so a vault that was meant to lose nothing lost
// every subagent newer Claude Code writes and every large tool output — and a
// restored session came back with references to files that were gone.
const SESSION_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Copy one file into the vault unless the copy there is already current.
 * 'copied' | 'skipped' | 'error'. One rule for transcripts and for everything
 * in a session directory, so the two cannot drift apart.
 */
function copyIfChanged(src, dst) {
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
      if (sameSize && notOlder) return 'skipped';
      if (dstStat.size > srcStat.size && notOlder) return 'skipped';
    } catch { /* re-copy on error */ }
  }

  // Transactional copy: write to .tmp then rename. A run killed halfway
  // leaves a .tmp (ignored by git), never a truncated file under the real
  // name — which the next run's size check could take for a finished copy.
  const tmp = dst + '.tmp';
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dst);
    return 'copied';
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    return 'error';
  }
}

/**
 * Mirror a session directory into the vault, file by file. Links are not
 * followed — one can loop, or point outside the session entirely.
 * `transcripts` lists the subagent transcripts it copied, for the indexer.
 */
function mirrorSessionDir(srcDir, dstDir) {
  const r = { copied: 0, skipped: 0, errors: 0, transcripts: [] };
  const walk = (src, dst, inSubagents) => {
    let entries;
    try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch { r.errors++; return; }
    for (const e of entries) {
      const from = path.join(src, e.name);
      const to = path.join(dst, e.name);
      if (e.isDirectory()) { walk(from, to, inSubagents || e.name === 'subagents'); continue; }
      if (!e.isFile()) continue;
      const outcome = copyIfChanged(from, to);
      if (outcome === 'copied') {
        r.copied++;
        if (inSubagents && e.name.endsWith('.jsonl')) r.transcripts.push(to);
      } else if (outcome === 'skipped') r.skipped++;
      else r.errors++;
    }
  };
  walk(srcDir, dstDir, false);
  return r;
}

// Async only because the machine manifest is an ESM module loaded on demand;
// everything else here is deliberately synchronous.
async function backup() {
  if (!fs.existsSync(PROJECTS_DIR)) return;
  if (!fs.existsSync(VAULT_DIR)) fs.mkdirSync(VAULT_DIR, { recursive: true });
  // Tie the repo to .git, not to the directory. Opening the index creates
  // VAULT_DIR for index/vault.db, so keying on the directory meant init
  // never ran and every later commit failed with 'git add' on no repo.
  if (hasGit() && !fs.existsSync(path.join(VAULT_DIR, '.git'))) {
    try {
      gitExec(['init']);
      gitExec(['config', 'user.name', 'session-vault']);
      gitExec(['config', 'user.email', 'vault@local']);
    } catch (e) { note('git init failed: ' + ((e && e.message) || e)); }
  }
  ensurePackLimits();
  ensureGitignore();

  let copied = 0;
  let skipped = 0;
  let errors = 0;
  // Transcripts copied this run: what the machine claims and the commit
  // message counts. Session-directory files are not sessions, so they are
  // counted apart and never claimed.
  const copiedFiles = [];
  let dirCopied = 0;
  // What the indexer should read: the transcripts above plus the subagent
  // transcripts copied out of session directories.
  const toIndex = [];

  const projects = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory());

  for (const proj of projects) {
    const projPath = path.join(PROJECTS_DIR, proj.name);

    // Transcripts at the project's top level; beside them, a directory per
    // session. memory/ and anything else not named like a session belongs to
    // somebody else — the config snapshot keeps memory/.
    let entries;
    try {
      entries = fs.readdirSync(projPath, { withFileTypes: true });
    } catch { continue; }
    const files = entries.filter(f => f.isFile() && f.name.endsWith('.jsonl'));
    const sessionDirs = entries.filter(d => d.isDirectory() && SESSION_DIR.test(d.name));

    // A project with session directories and no transcripts is exactly what
    // Claude Code's cleanup leaves behind: it deletes the .jsonl and keeps the
    // directory. Skipping it for having no transcripts would lose the rest.
    if (files.length === 0 && sessionDirs.length === 0) continue;

    const vaultProjDir = path.join(VAULT_DIR, proj.name);

    for (const file of files) {
      const dst = path.join(vaultProjDir, file.name);
      const outcome = copyIfChanged(path.join(projPath, file.name), dst);
      if (outcome === 'copied') {
        copied++;
        copiedFiles.push(dst);
        toIndex.push(dst);
      } else if (outcome === 'skipped') skipped++;
      else errors++;
    }

    for (const dir of sessionDirs) {
      const r = mirrorSessionDir(path.join(projPath, dir.name), path.join(vaultProjDir, dir.name));
      dirCopied += r.copied;
      skipped += r.skipped;
      errors += r.errors;
      toIndex.push(...r.transcripts);
    }
  }

  // Name this machine as the origin of what it just archived, before the
  // commit, so the claim travels in the same commit as the transcript. Two
  // vaults merged later can then still say which machine each session came
  // from, which is the only thing a pull cannot work out for itself.
  //
  // Best effort: an unwritable manifest must not cost the archive.
  const arcaDir = vaultMemoryDir();
  if (arcaDir && copiedFiles.length > 0) {
    try {
      // pathToFileURL, not the path: on Windows `import('W:/...')` is rejected
      // by the ESM loader as an unknown protocol 'w:'. It threw on every
      // session, was caught, logged, and nobody read the log — so no claim
      // was ever recorded by the hook on this platform.
      const { claim } = await import(pathToFileURL(path.join(arcaDir, 'lib', 'machine.js')).href);
      claim(copiedFiles.map((f) => ({
        session: path.basename(f, '.jsonl'),
        project: path.basename(path.dirname(f)),
      })));
    } catch (e) {
      note('machine claim skipped: ' + ((e && e.message) || e));
    }
  }

  // Prompts outlive their transcripts: ~/.claude/history.jsonl keeps every one
  // ever typed, including from sessions that were deleted before this vault
  // existed. Only entries newer than what is stored are appended, so the copy
  // stays small in git.
  if (arcaDir) {
    try {
      const { syncToVault } = await import(pathToFileURL(path.join(arcaDir, 'lib', 'history.js')).href);
      const r = syncToVault();
      if (r.appended) note(`history: +${r.appended} prompt(s)`);
    } catch (e) {
      note('history sync skipped: ' + ((e && e.message) || e));
    }
  }

  // Claude Code deletes transcripts on a rolling thirty-day window, and on
  // this machine the setting meant to stop it is ignored — a known open bug.
  // The vault already survives that by copying first; what it could not do is
  // say when a sweep happened. Each sample names what went missing since the
  // last one. Rate-limited to a few a day inside.
  if (arcaDir) {
    try {
      const { record } = await import(pathToFileURL(path.join(arcaDir, 'lib', 'retention.js')).href);
      const r = record();
      if (r && r.gone.length) note(`retention: ${r.gone.length} session(s) gone since ${r.since}`);
    } catch (e) {
      note('retention sample skipped: ' + ((e && e.message) || e));
    }
  }

  // The transcript says what was done; this says what it was done with.
  // Agents, skills, commands, hooks and settings ride in the same commit, so
  // a session restored a year from now can be read against the toolbox it
  // actually had. Rate-limited inside: a full pass is a second and a half
  // and almost always finds nothing.
  if (arcaDir) {
    try {
      const { syncIfDue } = await import(pathToFileURL(path.join(arcaDir, 'lib', 'config-vault.js')).href);
      const r = syncIfDue();
      if (r) {
        const touched = r.added.length + r.changed.length + r.removed.length;
        if (touched) note(`config: ${r.added.length} new, ${r.changed.length} changed, ${r.removed.length} gone`);
        if (r.skipped.length) note(`config: ${r.skipped.length} file(s) held back, look like credentials`);
      }
    } catch (e) {
      note('config sync skipped: ' + ((e && e.message) || e));
    }
  }

  // Commit whenever the repository is dirty, not only when this run copied
  // something. A commit that failed once used to strand its transcripts
  // outside git indefinitely: the next run skipped the already-copied files,
  // so `copied` stayed 0 and the commit was never retried.
  try {
    if (!hasGit()) throw new Error('no git');
    clearStaleLock();
    let dirty = '';
    try { dirty = gitRead(['status', '--porcelain']) || ''; } catch { dirty = ''; }
    if (dirty.trim()) {
      const pending = dirty.trim().split(String.fromCharCode(10)).length;
      const stamp = new Date().toISOString().slice(0, 19);
      const msg = copied > 0 || dirCopied > 0
        ? `vault: ${copied} sessions${dirCopied ? `, ${dirCopied} session-dir files` : ''} (${stamp})`
        : `vault: ${pending} pending changes (${stamp})`;
      gitExec(['add', '-A']);
      // The vault ignores index/, models/, *.tmp and *.log for its own
      // artifacts, and those names are ordinary inside somebody's skills.
      // Without -f a captured file can be copied and then silently never
      // committed, which is the one thing a backup must not do.
      try { gitExec(['add', '-f', 'config']); } catch { /* no config copy yet */ }
      gitExec(['commit', '-m', msg]);
    }
  } catch (e) { note('git commit failed: ' + ((e && e.message) ? e.message.slice(0, 200) : e)); }

  // Append to log
  try {
    const logFile = path.join(VAULT_DIR, 'vault.log');
    const line = `${new Date().toISOString()} copied=${copied} dir=${dirCopied} skipped=${skipped} errors=${errors}\n`;
    fs.appendFileSync(logFile, line);
  } catch {}

  // Trigger arca incremental indexing for copied files (fire-and-forget)
  // ARCA_HOOK_NO_INDEX lets the hook's own test exercise copy + commit
  // without spawning the indexer, which would pull the embedding model.
  if (toIndex.length > 0 && !process.env.ARCA_HOOK_NO_INDEX) {
    try {
      const vm = vaultMemoryDir();
      if (vm) {
        // One detached child, which runs the chain in order and waits between
        // stages. Four detached children raced each other; the ordering this
        // comment used to claim was never actually enforced.
        const runner = path.join(__dirname, 'pipeline.js');
        if (!fs.existsSync(runner)) { note('missing pipeline.js'); }
        else {
          // Windows caps a command line at 32,767 characters. The first run on
          // a machine with thousands of files — or the first after session
          // directories began to be mirrored — overflowed it, the spawn threw,
          // and nothing copied in that run was ever indexed by the hook. Past
          // the budget, ask for one incremental pass over the whole vault; it
          // skips whatever is already indexed.
          const ARGV_BUDGET = 24000;
          const argLength = toIndex.reduce((n, f) => n + f.length + 3, 0);
          const targets = argLength > ARGV_BUDGET ? ['--all'] : toIndex;
          const child = spawn('node', [runner, vm, ...targets], { stdio: 'ignore', detached: true });
          child.unref();
        }
      }
    } catch (e) { note('indexing spawn failed: ' + ((e && e.message) ? e.message : e)); }
  }
}

try {
  await backup();
} catch (e) {
  // Never break session start — but never vanish either. Claude Code shows
  // nothing when a hook fails, so the log is the only place a failure can
  // surface. Swallowing it here is what let an ESM/CJS mismatch run silent.
  try { note('hook failed: ' + ((e && e.stack) || e)); } catch {}
}
