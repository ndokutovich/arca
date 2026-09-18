// Machine manifests are the part of consolidation that must not be clever.
// Getting them wrong does not throw — it silently attributes one machine's
// history to another, or drops a claim, and neither is visible until two
// vaults have already been merged and the evidence is gone.
//
// Each test runs against a throwaway HOME so it touches no real vault.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-machine-'));
  fs.mkdirSync(path.join(home, '.claude-vault'), { recursive: true });
  return home;
}

// transcripts.js reads HOME per call, so swapping it is enough — but the
// module caches nothing, and neither does machine.js, so a fresh import is
// not needed between cases.
async function withHome(home, fn) {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn(await import('./machine.js'));
  } finally {
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
  }
}

test('the machine id is created once and then never changes', async () => {
  const home = sandbox();
  await withHome(home, (M) => {
    const first = M.machineId();
    assert.match(first, /^[0-9a-f]{12}$/);
    assert.equal(M.machineId(), first, 'a second call must not mint a new id');
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('the local id is not written where git would pick it up', async () => {
  // If this file travelled, a pull would tell the other machine it was this
  // one, and every subsequent claim would be filed under the wrong machine.
  const home = sandbox();
  await withHome(home, (M) => {
    M.machineId();
    const self = path.join(home, '.claude-vault', '.arca', 'this-machine');
    assert.ok(fs.existsSync(self));
    // The name is what the hook and installer put in .gitignore. If it moves,
    // this test is the thing that has to be updated deliberately.
    assert.equal(path.basename(self), 'this-machine');
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('claims are recorded and read back', async () => {
  const home = sandbox();
  await withHome(home, (M) => {
    const n = M.claim([
      { session: 'aaa', project: 'p1' },
      { session: 'bbb', project: 'p2' },
    ]);
    assert.equal(n, 2);
    const own = M.owners();
    assert.equal(own.get('aaa'), M.machineId());
    assert.equal(own.get('bbb'), M.machineId());
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('re-claiming the same session writes nothing', async () => {
  const home = sandbox();
  await withHome(home, (M) => {
    M.claim([{ session: 'aaa', project: 'p1' }]);
    const file = M.manifestPath(M.machineId());
    const before = fs.readFileSync(file, 'utf8');
    assert.equal(M.claim([{ session: 'aaa', project: 'p1' }]), 0);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'the manifest must not grow');
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('a session another machine claimed is left to that machine', async () => {
  // The case consolidation exists for: after a pull, this machine must not
  // put its name on sessions that arrived from elsewhere.
  const home = sandbox();
  await withHome(home, (M) => {
    const foreign = path.join(home, '.claude-vault', '.arca', 'machines', 'ffff00000000.jsonl');
    fs.mkdirSync(path.dirname(foreign), { recursive: true });
    fs.writeFileSync(foreign, [
      JSON.stringify({ t: 'machine', id: 'ffff00000000', hostname: 'other', created: '2026-01-01T00:00:00Z' }),
      JSON.stringify({ t: 'claim', session: 'theirs', project: 'shared-name' }),
      '',
    ].join('\n'));

    const claimed = M.claim([
      { session: 'theirs', project: 'shared-name' },
      { session: 'mine', project: 'shared-name' },
    ]);
    assert.equal(claimed, 1, 'only the unclaimed one');
    const own = M.owners();
    assert.equal(own.get('theirs'), 'ffff00000000', 'the other machine keeps its session');
    assert.equal(own.get('mine'), M.machineId());
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('two machines can hold the same project name without collision', async () => {
  // Project directories are named after filesystem paths, so the same name on
  // two machines is expected and means nothing on its own. What must survive
  // is knowing which sessions under it came from where.
  const home = sandbox();
  await withHome(home, (M) => {
    const foreign = path.join(home, '.claude-vault', '.arca', 'machines', 'ffff00000000.jsonl');
    fs.mkdirSync(path.dirname(foreign), { recursive: true });
    fs.writeFileSync(foreign, `${JSON.stringify({ t: 'claim', session: 's1', project: 'w---proj-app' })}\n`);
    M.claim([{ session: 's2', project: 'w---proj-app' }]);

    const own = M.owners();
    assert.notEqual(own.get('s1'), own.get('s2'), 'same project, different machines');
    assert.equal(M.machines().length, 2);
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('a truncated manifest line costs only that line', async () => {
  const home = sandbox();
  await withHome(home, (M) => {
    M.claim([{ session: 'good1', project: 'p' }]);
    const file = M.manifestPath(M.machineId());
    fs.appendFileSync(file, '{"t":"claim","session":"half\n');
    M.claim([{ session: 'good2', project: 'p' }]);
    const own = M.owners();
    assert.ok(own.has('good1'), 'the claim before the damage survives');
    assert.ok(own.has('good2'), 'and the one after it');
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('adopt claims what is present and says when it has run before', async () => {
  const home = sandbox();
  await withHome(home, (M) => {
    const scan = () => [{ session: 'x', project: 'p' }, { session: 'y', project: 'p' }];
    const first = M.adopt(scan);
    assert.equal(first.adopted, 2);
    assert.equal(first.alreadyDone, false);

    const second = M.adopt(scan);
    assert.equal(second.adopted, 0);
    assert.equal(second.alreadyDone, true, 'the marker has to persist');
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('adopt reports other machines rather than quietly absorbing them', async () => {
  const home = sandbox();
  await withHome(home, (M) => {
    const foreign = path.join(home, '.claude-vault', '.arca', 'machines', 'ffff00000000.jsonl');
    fs.mkdirSync(path.dirname(foreign), { recursive: true });
    fs.writeFileSync(foreign, `${JSON.stringify({ t: 'claim', session: 'theirs', project: 'p' })}\n`);
    const r = M.adopt(() => [{ session: 'theirs', project: 'p' }, { session: 'mine', project: 'p' }]);
    assert.equal(r.foreign, 1, 'the warning the CLI prints depends on this');
    assert.equal(r.adopted, 1);
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('an empty vault lists no machines instead of throwing', async () => {
  const home = sandbox();
  await withHome(home, (M) => {
    assert.deepEqual(M.machines(), []);
    assert.equal(M.owners().size, 0);
  });
  fs.rmSync(home, { recursive: true, force: true });
});
