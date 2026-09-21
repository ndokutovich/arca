// The point of this log is to name the moment Claude Code forgot something.
// A log that quietly records nothing looks exactly like a machine that never
// lost a session, so every test here is about it noticing.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-ret-'));
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude-vault', '.arca'), { recursive: true });
  return home;
}

/** Everything resolves the vault from the home directory at call time. */
async function withHome(home, fn) {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn(await import('./retention.js'));
  } finally {
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
  }
}

function session(home, project, id) {
  const dir = path.join(home, '.claude', 'projects', project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, '{}\n');
  return file;
}

const clean = (home) => fs.rmSync(home, { recursive: true, force: true });

test('what Claude Code holds is read off the disk, across projects', () => {
  const home = sandbox();
  return withHome(home, ({ live }) => {
    session(home, 'proj-a', 'aaa');
    session(home, 'proj-a', 'bbb');
    session(home, 'proj-b', 'ccc');
    fs.writeFileSync(path.join(home, '.claude', 'projects', 'proj-a', 'notes.md'), 'x');
    const held = live(path.join(home, '.claude'));
    assert.deepEqual([...held.keys()].sort(), ['aaa', 'bbb', 'ccc']);
    assert.equal(held.get('ccc').project, 'proj-b');
    clean(home);
  });
});

test('the first sample has nothing to compare against and says so', () => {
  const home = sandbox();
  return withHome(home, ({ record }) => {
    session(home, 'p', 'aaa');
    const r = record({ home: path.join(home, '.claude') });
    assert.equal(r.held, 1);
    assert.deepEqual(r.gone, []);
    assert.equal(r.since, null);
    clean(home);
  });
});

test('a session that disappears is named in the next sample', () => {
  // This is the whole point: the vault already keeps the transcript, but until
  // now it could not say when the copy stopped having an original.
  const home = sandbox();
  return withHome(home, ({ record }) => {
    const claude = path.join(home, '.claude');
    session(home, 'p', 'keeper');
    const doomed = session(home, 'p', 'doomed');
    record({ home: claude });

    fs.rmSync(doomed);
    const r = record({ home: claude, force: true });
    assert.deepEqual(r.gone, ['doomed']);
    assert.equal(r.held, 1);
    assert.ok(r.since, 'the window it went missing in is not recorded');
    clean(home);
  });
});

test('a session already gone is not reported a second time', () => {
  const home = sandbox();
  return withHome(home, ({ record }) => {
    const claude = path.join(home, '.claude');
    session(home, 'p', 'keeper');
    const doomed = session(home, 'p', 'doomed');
    record({ home: claude });
    fs.rmSync(doomed);
    record({ home: claude, force: true });

    const third = record({ home: claude, force: true });
    assert.deepEqual(third.gone, [], 'the same loss was reported twice');
    clean(home);
  });
});

test('the log holds counts, not three thousand session ids', () => {
  // Several samples a day with the full id list would put a hundred kilobytes
  // into git each time; the list lives beside the log instead.
  const home = sandbox();
  return withHome(home, ({ record, logPath, idsPath }) => {
    for (let i = 0; i < 40; i++) session(home, 'p', `s${i}`);
    record({ home: path.join(home, '.claude') });
    const line = fs.readFileSync(logPath(), 'utf8').trim();
    assert.ok(!line.includes('s39'), 'the id list is in the committed log');
    assert.ok(line.length < 300, `the log line is ${line.length} bytes`);
    assert.ok(fs.readFileSync(idsPath(), 'utf8').includes('s39'), 'the ids were not kept for the next diff');
    clean(home);
  });
});

test('sampling every session start would say nothing new, so it does not', () => {
  const home = sandbox();
  return withHome(home, ({ record, history }) => {
    const claude = path.join(home, '.claude');
    session(home, 'p', 'aaa');
    assert.ok(record({ home: claude }));
    assert.equal(record({ home: claude }), null, 'the cooldown did not hold');
    assert.equal(history().length, 1);
    clean(home);
  });
});

test('enough time passing lets the next sample through', () => {
  const home = sandbox();
  return withHome(home, ({ record, history }) => {
    const claude = path.join(home, '.claude');
    session(home, 'p', 'aaa');
    record({ home: claude });
    record({ home: claude, now: Date.now() + 7 * 60 * 60 * 1000 });
    assert.equal(history().length, 2);
    clean(home);
  });
});

test('a half-written line costs that sample and not the log', () => {
  const home = sandbox();
  return withHome(home, ({ record, history, logPath }) => {
    session(home, 'p', 'aaa');
    record({ home: path.join(home, '.claude') });
    fs.appendFileSync(logPath(), '{"at":"2026-01-01T00:00:00.000Z","hel');
    assert.equal(history().length, 1, 'the good sample was lost with the bad one');
    clean(home);
  });
});

test('the boundary is reported with how old it is', () => {
  const home = sandbox();
  return withHome(home, ({ summary }) => {
    const claude = path.join(home, '.claude');
    const old = session(home, 'p', 'old');
    session(home, 'p', 'new');
    const longAgo = Date.now() - 40 * 86400000;
    fs.utimesSync(old, longAgo / 1000, longAgo / 1000);

    const s = summary({ home: claude });
    assert.equal(s.held, 2);
    assert.ok(s.days >= 39 && s.days <= 41, `oldest reported as ${s.days} days`);
    clean(home);
  });
});

test('an empty projects directory is not a crash', () => {
  const home = sandbox();
  return withHome(home, ({ summary, record }) => {
    const claude = path.join(home, '.claude');
    assert.equal(summary({ home: claude }), null);
    assert.doesNotThrow(() => record({ home: claude }));
    clean(home);
  });
});
