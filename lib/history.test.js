// history.jsonl is the only record of prompts whose session is gone, so the
// two things that must not be wrong are the project mapping — get it wrong and
// every prompt looks orphaned — and the watermark, which is what keeps the
// vault copy from growing by 10 MB on every commit.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-history-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude-vault'), { recursive: true });
  return home;
}

async function withHome(home, fn) {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn(await import('./history.js'));
  } finally {
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
  }
}

function writeHistory(home, entries) {
  fs.writeFileSync(
    path.join(home, '.claude', 'history.jsonl'),
    entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
}

const BS = String.fromCharCode(92);

test('a cwd maps to the directory name Claude Code gives it', async () => {
  // history.jsonl stores the raw path; the vault and the index use the name
  // Claude Code derives from it. If these two ever disagree, every prompt
  // looks like it has no session and the whole feature lies.
  const home = sandbox();
  await withHome(home, (H) => {
    assert.equal(H.projectKey(`w:${BS}_proj${BS}_own${BS}_ai-cl`), 'w---proj--own--ai-cl');
    assert.equal(H.projectKey(`C:${BS}Users${BS}xxx`), 'C--Users-xxx');
    assert.equal(H.projectKey('/home/me/app'), '-home-me-app');
    assert.equal(H.projectKey(''), '');
    assert.equal(H.projectKey(undefined), '');
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('entries without text or a timestamp are dropped', async () => {
  const home = sandbox();
  writeHistory(home, [
    { display: 'real one', timestamp: 1000, project: 'w:' },
    { display: '   ', timestamp: 2000, project: 'w:' },
    { display: 'no timestamp', project: 'w:' },
    { timestamp: 3000, project: 'w:' },
  ]);
  await withHome(home, (H) => {
    const rows = H.readSource();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].text, 'real one');
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('a malformed line costs only that line', async () => {
  const home = sandbox();
  fs.writeFileSync(path.join(home, '.claude', 'history.jsonl'), [
    JSON.stringify({ display: 'before', timestamp: 1, project: 'p' }),
    '{"display": "half',
    JSON.stringify({ display: 'after', timestamp: 2, project: 'p' }),
    '',
  ].join('\n'));
  await withHome(home, (H) => {
    assert.deepEqual(H.readSource().map((r) => r.text), ['before', 'after']);
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('a missing history file is empty, not an error', async () => {
  const home = sandbox();
  await withHome(home, (H) => {
    assert.deepEqual(H.readSource(), []);
    assert.deepEqual(H.readVault(), []);
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('sync copies once and then copies nothing', async () => {
  // Claude Code rewrites history.jsonl in place. Copying it wholesale on every
  // session would put a 10 MB blob in the vault on every commit; only what is
  // new may travel.
  const home = sandbox();
  writeHistory(home, [
    { display: 'one', timestamp: 1000, project: 'p' },
    { display: 'two', timestamp: 2000, project: 'p' },
  ]);
  await withHome(home, (H) => {
    const first = H.syncToVault();
    assert.equal(first.appended, 2);
    const second = H.syncToVault();
    assert.equal(second.appended, 0, 'nothing new means nothing written');
    assert.equal(second.total, 2);
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('sync picks up entries added after the watermark', async () => {
  const home = sandbox();
  writeHistory(home, [{ display: 'one', timestamp: 1000, project: 'p' }]);
  await withHome(home, (H) => {
    H.syncToVault();
    writeHistory(home, [
      { display: 'one', timestamp: 1000, project: 'p' },
      { display: 'three', timestamp: 3000, project: 'p' },
    ]);
    assert.equal(H.syncToVault().appended, 1);
    assert.deepEqual(H.readVault().map((r) => r.text), ['one', 'three']);
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('two entries in the same millisecond both survive', async () => {
  // A watermark that assumed strictly increasing timestamps would drop the
  // second one forever, silently.
  const home = sandbox();
  writeHistory(home, [{ display: 'first', timestamp: 5000, project: 'p' }]);
  await withHome(home, (H) => {
    H.syncToVault();
    writeHistory(home, [
      { display: 'first', timestamp: 5000, project: 'p' },
      { display: 'second', timestamp: 5000, project: 'p' },
    ]);
    assert.equal(H.syncToVault().appended, 1);
    assert.deepEqual(H.readVault().map((r) => r.text).sort(), ['first', 'second']);
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('the vault copy is read back with its machine attached', async () => {
  const home = sandbox();
  writeHistory(home, [{ display: 'hello', timestamp: 1000, project: `w:${BS}app`, pastedContents: { a: 1 } }]);
  await withHome(home, async (H) => {
    H.syncToVault();
    const { machineId } = await import('./machine.js');
    const [row] = H.readVault();
    assert.equal(row.machine, machineId());
    assert.equal(row.project, 'w--app');
    assert.equal(row.projectPath, `w:${BS}app`);
    assert.equal(row.pasted, 1);
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('a prompt id is stable and separates machines', async () => {
  const home = sandbox();
  await withHome(home, (H) => {
    const base = { machine: 'aaa', project: 'p', ts: 1, text: 'hi' };
    assert.equal(H.promptId(base), H.promptId({ ...base }));
    assert.notEqual(H.promptId(base), H.promptId({ ...base, machine: 'bbb' }));
    assert.notEqual(H.promptId(base), H.promptId({ ...base, ts: 2 }));
    assert.notEqual(H.promptId(base), H.promptId({ ...base, text: 'ho' }));
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('the echo hash separates identical text in different projects', async () => {
  const home = sandbox();
  await withHome(home, (H) => {
    assert.equal(H.echoHash('p', 'same'), H.echoHash('p', 'same'));
    assert.notEqual(H.echoHash('p', 'same'), H.echoHash('q', 'same'));
  });
  fs.rmSync(home, { recursive: true, force: true });
});
