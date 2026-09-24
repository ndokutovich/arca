// A session is not one file. Claude Code keeps a directory beside each
// transcript: subagents/ (including subagents/workflows/wf_*/), tool-results/
// that the transcript refers to, and .meta.json files describing each agent.
// The hook copied the transcript and walked past the directory, the indexer
// did the same, and restore put back a transcript whose tool outputs and
// subagents were gone. 5881 subagent files and 1858 tool results were outside
// the vault, which was supposed to lose nothing.
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(ROOT, 'hooks', 'session-vault.js');
const SID = '11111111-2222-4333-8444-555555555555';

const line = (role, text) => JSON.stringify({
  type: role, message: { role, content: text },
  timestamp: '2026-09-24T10:00:00.000Z', sessionId: SID,
});
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const rel = (root, p) => path.relative(root, p).split(path.sep).join('/');

/** The files a session directory holds, relative to the project. */
const SESSION_FILES = {
  [`${SID}/subagents/agent-a1.jsonl`]: [line('user', 'go look'), line('assistant', 'found it')].join('\n') + '\n',
  [`${SID}/subagents/agent-a1.meta.json`]: '{"agentType":"Explore"}',
  [`${SID}/subagents/workflows/wf_abc/agent-b2.jsonl`]: [line('user', 'step'), line('assistant', 'done')].join('\n') + '\n',
  [`${SID}/tool-results/r1.txt`]: 'a large tool output',
};

function claudeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-sessdir-'));
  const proj = path.join(home, '.claude', 'projects', 'demo');
  write(path.join(proj, `${SID}.jsonl`), [line('user', 'hello'), line('assistant', 'hi')].join('\n') + '\n');
  for (const [p, text] of Object.entries(SESSION_FILES)) write(path.join(proj, p), text);
  write(path.join(proj, 'memory', 'MEMORY.md'), '# project memory');
  return home;
}

function runHook(home) {
  execFileSync(process.execPath, [HOOK], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    input: JSON.stringify({ session_id: SID, cwd: home }),
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 120000,
  });
}

const cleanup = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows */ } };

test('the hook mirrors a session directory into the vault', () => {
  const home = claudeHome();
  try {
    runHook(home);
    const vaultProj = path.join(home, '.claude-vault', 'demo');
    for (const [p, text] of Object.entries(SESSION_FILES)) {
      const copy = path.join(vaultProj, p);
      assert.ok(fs.existsSync(copy), `not in the vault: ${p}`);
      assert.equal(fs.readFileSync(copy, 'utf8'), text, `copied wrong: ${p}`);
    }
  } finally { cleanup(home); }
});

test('an unchanged session directory is not copied again', () => {
  const home = claudeHome();
  try {
    runHook(home);
    const copy = path.join(home, '.claude-vault', 'demo', SID, 'tool-results', 'r1.txt');
    assert.ok(fs.existsSync(copy), 'the first pass did not copy it');
    const before = fs.statSync(copy).mtimeMs;
    runHook(home);
    assert.equal(fs.statSync(copy).mtimeMs, before, 'rewritten although nothing changed');
  } finally { cleanup(home); }
});

test('project memory is left to the config snapshot, not mirrored as a session', () => {
  const home = claudeHome();
  try {
    runHook(home);
    assert.ok(!fs.existsSync(path.join(home, '.claude-vault', 'demo', 'memory')),
      'memory/ is not a session directory');
  } finally { cleanup(home); }
});

test('only the session is claimed for this machine, not what its directory holds', () => {
  const home = claudeHome();
  try {
    runHook(home);
    const dir = path.join(home, '.claude-vault', '.arca', 'machines');
    const claims = (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
      .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean))
      .map((l) => JSON.parse(l))
      .filter((e) => e.t === 'claim');
    assert.ok(claims.some((c) => c.session === SID && c.project === 'demo'), 'the session was not claimed');
    const stray = claims.filter((c) => c.session !== SID || c.project !== 'demo');
    assert.deepEqual(stray, [], 'claimed something that is not a session');
  } finally { cleanup(home); }
});

test('the indexer walk finds sidechains inside session directories, and nothing else', async () => {
  const T = await import('./transcripts.js');
  assert.equal(typeof T.findArchivedTranscripts, 'function', 'findArchivedTranscripts is not exported');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-walk-'));
  try {
    write(path.join(root, 'demo', `${SID}.jsonl`), '{}\n');
    for (const [p, text] of Object.entries(SESSION_FILES)) write(path.join(root, 'demo', p), text);
    write(path.join(root, 'demo', SID, 'tool-results', 'r2.json'), '{}');
    // Neither of these is a transcript: prompt history has its own format, and
    // the config snapshot is a copy of ~/.claude, not of any session.
    write(path.join(root, '.arca', 'history', 'abcdef.jsonl'), '{}\n');
    write(path.join(root, 'config', 'aaaaaaaaaaaa', 'plugins', 'x.jsonl'), '{}\n');

    const found = T.findArchivedTranscripts(root)
      .map((f) => [rel(root, f.path), f.project, !!f.sidechain])
      .sort((a, b) => a[0].localeCompare(b[0]));
    assert.deepEqual(found, [
      [`demo/${SID}.jsonl`, 'demo', false],
      [`demo/${SID}/subagents/agent-a1.jsonl`, 'demo', true],
      [`demo/${SID}/subagents/workflows/wf_abc/agent-b2.jsonl`, 'demo', true],
    ]);
  } finally { cleanup(root); }
});

async function withHome(home, fn) {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn(await import('./restore.js'));
  } finally {
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
  }
}

function archivedOnly() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-restore-dir-'));
  const vaultProj = path.join(home, '.claude-vault', 'demo');
  write(path.join(vaultProj, `${SID}.jsonl`), [line('user', 'hello'), line('assistant', 'hi')].join('\n') + '\n');
  for (const [p, text] of Object.entries(SESSION_FILES)) write(path.join(vaultProj, p), text);
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  return home;
}

test('restoring a session brings its directory back as well', async () => {
  const home = archivedOnly();
  try {
    await withHome(home, (R) => R.restoreSession(SID));
    const live = path.join(home, '.claude', 'projects', 'demo');
    assert.ok(fs.existsSync(path.join(live, `${SID}.jsonl`)), 'the transcript was not restored');
    for (const [p, text] of Object.entries(SESSION_FILES)) {
      const back = path.join(live, p);
      assert.ok(fs.existsSync(back), `not restored: ${p}`);
      assert.equal(fs.readFileSync(back, 'utf8'), text, `restored wrong: ${p}`);
    }
  } finally { cleanup(home); }
});

test('a file already in the live session directory is never replaced', async () => {
  const home = archivedOnly();
  try {
    const liveResult = path.join(home, '.claude', 'projects', 'demo', SID, 'tool-results', 'r1.txt');
    write(liveResult, 'LIVE VERSION');
    await withHome(home, (R) => R.restoreSession(SID));
    assert.equal(fs.readFileSync(liveResult, 'utf8'), 'LIVE VERSION', 'a live file was overwritten');
    assert.ok(fs.existsSync(path.join(home, '.claude', 'projects', 'demo', SID, 'subagents', 'agent-a1.jsonl')),
      'the missing files were not added beside it');
  } finally { cleanup(home); }
});
