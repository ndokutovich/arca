// The SessionStart hook is tested by RUNNING it, not by reading it.
//
// 0.2.0 shipped this file as CommonJS inside a package declaring
// "type": "module". It threw on its first line at every session start, Claude
// Code swallowed the failure without a trace, and the vault stayed empty while
// the MCP server, the CLI and the index all reported healthy. `node --check`
// passed the whole time: `require(...)` is valid syntax, it just does not exist
// at runtime in ESM. Only executing the file catches that — so these tests do.
//
// Each test runs the hook as a subprocess against a throwaway HOME, which is
// also the only honest way to test something whose entire job is to touch
// ~/.claude and ~/.claude-vault.
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(ROOT, 'hooks', 'session-vault.js');

const SESSION = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' }, timestamp: '2026-09-18T10:00:00.000Z', sessionId: 's1' }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'hi' }, timestamp: '2026-09-18T10:00:01.000Z', sessionId: 's1' }),
].join('\n') + '\n';

/** A HOME with one project holding one transcript. */
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-hook-'));
  const proj = path.join(home, '.claude', 'projects', 'test-project');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 's1.jsonl'), SESSION);
  return home;
}

function runHook(home, env = {}) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: 's1', hook_event_name: 'SessionStart' }),
    env: { ...process.env, HOME: home, USERPROFILE: home, ARCA_HOOK_NO_INDEX: '1', ...env },
    encoding: 'utf8',
  });
}

/** The same run, with nothing on PATH — so `git` cannot be found. */
function runHookWithoutGit(home) {
  // Node is invoked by absolute path, so an empty PATH removes git and
  // nothing else the hook needs.
  return runHook(home, { PATH: '', Path: '' });
}

const cleanup = (home) => {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* temp dir */ }
};

test('the hook runs at all — it must not be CommonJS in an ESM package', () => {
  const home = makeHome();
  try {
    const r = runHook(home);
    assert.equal(r.status, 0, `hook exited ${r.status}: ${r.stderr}`);
    assert.ok(
      !/require is not defined|Cannot use import statement/.test(r.stderr || ''),
      `module system mismatch: ${r.stderr}`
    );
  } finally {
    cleanup(home);
  }
});

test('the hook copies transcripts into the vault', () => {
  const home = makeHome();
  try {
    runHook(home);
    const copied = path.join(home, '.claude-vault', 'test-project', 's1.jsonl');
    assert.ok(fs.existsSync(copied), 'transcript was not copied into the vault');
    assert.equal(fs.readFileSync(copied, 'utf8'), SESSION, 'copied transcript differs from the source');
  } finally {
    cleanup(home);
  }
});

test('the hook initialises the git repo even when the vault directory already exists', () => {
  const home = makeHome();
  try {
    // Opening the index creates the vault directory before the hook ever runs.
    // 0.2.0 keyed `git init` on the directory, so this case skipped it and every
    // later commit failed with `git add` against no repository.
    fs.mkdirSync(path.join(home, '.claude-vault', 'index'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude-vault', 'index', 'vault.db'), 'not a real db');

    const r = runHook(home);
    assert.equal(r.status, 0, `hook exited ${r.status}: ${r.stderr}`);
    assert.ok(fs.existsSync(path.join(home, '.claude-vault', '.git')), 'git init never ran');
  } finally {
    cleanup(home);
  }
});

test('the hook leaves a log line describing what it did', () => {
  const home = makeHome();
  try {
    runHook(home);
    const log = path.join(home, '.claude-vault', 'vault.log');
    assert.ok(fs.existsSync(log), 'vault.log was not written');
    const text = fs.readFileSync(log, 'utf8');
    assert.match(text, /copied=\d+/, `log says nothing useful: ${text}`);
    assert.doesNotMatch(text, /hook failed:/, `the hook logged a failure: ${text}`);
  } finally {
    cleanup(home);
  }
});

test('the vault commit keeps the index out of git', () => {
  const home = makeHome();
  try {
    runHook(home);
    const vault = path.join(home, '.claude-vault');
    if (!fs.existsSync(path.join(vault, '.git'))) return; // git unavailable
    const ignored = execFileSync('git', ['-C', vault, 'check-ignore', 'index/vault.db'], {
      encoding: 'utf8',
    }).trim();
    assert.equal(ignored, 'index/vault.db', 'the database is not gitignored');
  } finally {
    cleanup(home);
  }
});

test('without git the archive still fills', () => {
  // Git is how the vault keeps its history, not how it keeps its files. A
  // machine with no git installed must still end up with its transcripts
  // copied somewhere safe — refusing to archive would be a far worse failure
  // than losing `git log`.
  const home = makeHome();
  try {
    const r = runHookWithoutGit(home);
    assert.equal(r.status, 0, `hook exited ${r.status}: ${r.stderr}`);
    const archived = path.join(home, '.claude-vault', 'test-project', 's1.jsonl');
    assert.ok(fs.existsSync(archived), 'the transcript was not archived');
    assert.equal(fs.readFileSync(archived, 'utf8'), SESSION, 'and it must be byte for byte');
    assert.ok(!fs.existsSync(path.join(home, '.claude-vault', '.git')), 'no repo should have been made');
  } finally {
    cleanup(home);
  }
});

test('without git the machine manifest is still written', () => {
  // The manifest is what makes two vaults mergeable later. It is a file, not
  // a commit, so losing git must not lose it.
  const home = makeHome();
  try {
    runHookWithoutGit(home);
    const dir = path.join(home, '.claude-vault', '.arca', 'machines');
    assert.ok(fs.existsSync(dir), 'no manifest directory');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    assert.equal(files.length, 1, 'expected exactly this machine');
    const claims = fs.readFileSync(path.join(dir, files[0]), 'utf8')
      .split(String.fromCharCode(10)).filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(claims.some((c) => c.t === 'claim' && c.session === 's1'), 's1 was not claimed');
  } finally {
    cleanup(home);
  }
});

test('a missing git is reported once, not every session', () => {
  // A line in the log every few minutes is noise nobody reads, and the point
  // of the log is that a real failure stands out in it.
  const home = makeHome();
  try {
    runHookWithoutGit(home);
    const log = path.join(home, '.claude-vault', 'vault.log');
    const first = fs.readFileSync(log, 'utf8');
    assert.match(first, /git not found/, 'the degradation was never mentioned');

    runHookWithoutGit(home);
    const second = fs.readFileSync(log, 'utf8');
    const count = (second.match(/git not found/g) || []).length;
    assert.equal(count, 1, `said it ${count} times`);
  } finally {
    cleanup(home);
  }
});
