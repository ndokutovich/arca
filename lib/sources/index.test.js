// The registry is the part that decides where a foreign session lands and what
// it is labelled. Both are irreversible in practice: once a thousand sessions
// are in the vault under the wrong project or with no source tag, sorting it
// out means re-importing everything and re-embedding it.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-sources-'));
  fs.mkdirSync(path.join(home, '.claude-vault'), { recursive: true });
  return home;
}

async function withHome(home, fn) {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn(await import('./index.js'));
  } finally {
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
  }
}

/** A stand-in assistant, so these tests do not depend on any real format. */
function fake(overrides = {}) {
  return {
    id: 'fake',
    label: 'Fake Assistant',
    verifiedAgainst: 'fixtures',
    detect: () => ({ present: true, root: '/anywhere' }),
    discover: () => [{
      sessionId: 'abc123',
      project: 'w--app',
      cwd: 'w:' + String.fromCharCode(92) + 'app',
      file: '/anywhere/abc123',
      mtime: 0,
    }],
    read: () => [
      { role: 'user', text: 'a question', ts: '2026-01-01T00:00:00.000Z' },
      { role: 'assistant', text: 'an answer', ts: '2026-01-01T00:00:01.000Z' },
    ],
    ...overrides,
  };
}

function written(home, project = 'w--app', id = 'abc123') {
  const file = path.join(home, '.claude-vault', project, `${id}.jsonl`);
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

test('a session is written where the parser will find it, tagged with its source', () => {
  const home = sandbox();
  return withHome(home, ({ importSource }) => {
    const stats = importSource(fake());
    assert.equal(stats.created, 1);
    const rows = written(home);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.message.role), ['user', 'assistant']);
    assert.equal(rows[0].source, 'fake', 'without this every import looks like Claude Code');
    assert.equal(rows[0].sessionId, 'abc123');
    assert.equal(rows[0].cwd, 'w:' + String.fromCharCode(92) + 'app');
    fs.rmSync(home, { recursive: true, force: true });
  });
});

test('a source that is not installed is absent, not broken', () => {
  const home = sandbox();
  return withHome(home, ({ importSource }) => {
    const stats = importSource(fake({ detect: () => ({ present: false, root: null }) }));
    assert.equal(stats.absent, true);
    assert.equal(stats.conversations, 0);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

test('a dry run writes nothing but still counts', () => {
  const home = sandbox();
  return withHome(home, ({ importSource }) => {
    const stats = importSource(fake(), { dryRun: true });
    assert.equal(stats.created, 1);
    assert.equal(fs.existsSync(path.join(home, '.claude-vault', 'w--app')), false);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

test('importing twice writes nothing the second time', () => {
  const home = sandbox();
  return withHome(home, ({ importSource }) => {
    importSource(fake());
    const again = importSource(fake(), { force: true });
    assert.equal(again.created, 0);
    assert.equal(again.unchanged, 1);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

test('an unchanged session is not even read again', () => {
  // Re-reading 3 GB to discover nothing changed is the difference between a
  // command you run daily and one you run once.
  const home = sandbox();
  return withHome(home, ({ importSource }) => {
    importSource(fake());
    let reads = 0;
    const counting = fake({
      discover: () => [{ sessionId: 'abc123', project: 'w--app', cwd: null, file: '/x', mtime: 1 }],
      read: () => { reads++; return []; },
    });
    importSource(counting);
    assert.equal(reads, 0, 'the mtime check did not skip the read');
    fs.rmSync(home, { recursive: true, force: true });
  });
});

test('one unreadable session does not cost the run', () => {
  const home = sandbox();
  return withHome(home, ({ importSource }) => {
    const said = [];
    const stats = importSource(fake({
      discover: () => [
        { sessionId: 'bad', project: 'p', cwd: null, file: '/bad', mtime: 0 },
        { sessionId: 'good', project: 'p', cwd: null, file: '/good', mtime: 0 },
      ],
      read: (f) => {
        if (f === '/bad') throw new Error('corrupt');
        return [{ role: 'user', text: 'q', ts: '2026-01-01T00:00:00.000Z' },
          { role: 'assistant', text: 'a', ts: '2026-01-01T00:00:01.000Z' }];
      },
    }), { log: (m) => said.push(m) });
    assert.equal(stats.unreadable, 1);
    assert.equal(stats.created, 1, 'the good session still landed');
    assert.ok(said.some((m) => m.includes('unreadable')), 'and it was said out loud');
    fs.rmSync(home, { recursive: true, force: true });
  });
});

test('a failing detect is reported, never thrown', () => {
  const home = sandbox();
  return withHome(home, ({ detectAll, ADAPTERS }) => {
    const rows = detectAll();
    assert.equal(rows.length, ADAPTERS.length);
    for (const r of rows) {
      assert.ok(typeof r.present === 'boolean', `${r.id} has no presence`);
      assert.ok(r.verifiedAgainst === 'live' || r.verifiedAgainst === 'fixtures',
        `${r.id} does not say how it was verified`);
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
});

test('empty turns make an empty session, not a broken transcript', () => {
  const home = sandbox();
  return withHome(home, ({ importSource }) => {
    const stats = importSource(fake({ read: () => [{ role: 'user', text: '   ' }] }));
    assert.equal(stats.empty, 1);
    assert.equal(stats.created, 0);
    fs.rmSync(home, { recursive: true, force: true });
  });
});
