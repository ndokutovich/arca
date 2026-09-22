// The snapshot used to be one directory shared by every machine on the vault,
// which turned a backup into a fight: machine B's sync deleted what machine A
// had, A's next sync deleted B's, and a restore handed you whichever of them
// had started a session most recently. Transcripts were always separated by
// project and stamped with a machine; the snapshot never was.
//
// And a sync whose source could not be read collected zero files, then pruned
// the snapshot to match — deleting all of it in one silent pass.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-cfgm-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const CV = await import('./config-vault.js');

const ls = (dir) => {
  try { return fs.readdirSync(dir).sort(); } catch { return []; }
};
/** A ~/.claude with one shared command and one of its own. */
function machineHome(name, own) {
  const h = path.join(home, name);
  fs.mkdirSync(path.join(h, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(h, 'commands', 'shared.md'), 'both have this');
  fs.writeFileSync(path.join(h, 'commands', own), 'only here');
  return h;
}

test('two machines keep their own snapshot instead of deleting each others', () => {
  const root = path.join(home, 'vault-a');
  const A = machineHome('m-a', 'a-only.md');
  const B = machineHome('m-b', 'b-only.md');
  const destA = path.join(root, 'aaaaaaaaaaaa');
  const destB = path.join(root, 'bbbbbbbbbbbb');

  CV.sync({ home: A, dest: destA });
  const afterA = CV.sync({ home: B, dest: destB });

  assert.deepEqual(ls(path.join(destA, 'commands')), ['a-only.md', 'shared.md']);
  assert.deepEqual(ls(path.join(destB, 'commands')), ['b-only.md', 'shared.md']);
  assert.equal(afterA.removed.length, 0, 'syncing one machine removed another machine files');
});

test('a sync still prunes what its own machine deleted', () => {
  const dest = path.join(home, 'vault-prune', 'cccccccccccc');
  const h = machineHome('m-c', 'c-only.md');
  CV.sync({ home: h, dest });
  assert.deepEqual(ls(path.join(dest, 'commands')), ['c-only.md', 'shared.md']);

  fs.rmSync(path.join(h, 'commands', 'c-only.md'));
  const r = CV.sync({ home: h, dest });
  assert.deepEqual(ls(path.join(dest, 'commands')), ['shared.md']);
  assert.equal(r.removed.length, 1);
});

test('an unreadable source deletes nothing', () => {
  const dest = path.join(home, 'vault-empty', 'dddddddddddd');
  const h = machineHome('m-d', 'd-only.md');
  CV.sync({ home: h, dest });
  const before = ls(path.join(dest, 'commands'));
  assert.equal(before.length, 2);

  fs.rmSync(h, { recursive: true, force: true });
  const r = CV.sync({ home: h, dest });

  assert.equal(r.sourceEmpty, true, 'the report did not say the source was unreadable');
  assert.equal(r.removed.length, 0, 'an unreadable source pruned the snapshot');
  assert.deepEqual(ls(path.join(dest, 'commands')), before, 'the snapshot changed');
});

test('a snapshot written before the split moves under the machine that wrote it', () => {
  const root = path.join(home, 'vault-legacy', 'config');
  fs.mkdirSync(path.join(root, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# how I work');
  fs.writeFileSync(path.join(root, 'commands', 'old.md'), 'from before');

  const r = CV.migrateFlatConfig({ root, id: 'eeeeeeeeeeee' });

  assert.ok(r.moved.includes('CLAUDE.md'));
  assert.ok(r.moved.includes('commands'));
  assert.deepEqual(ls(root), ['eeeeeeeeeeee'], 'something stayed loose at the top');
  assert.equal(fs.readFileSync(path.join(root, 'eeeeeeeeeeee', 'CLAUDE.md'), 'utf8'), '# how I work');
  assert.equal(fs.readFileSync(path.join(root, 'eeeeeeeeeeee', 'commands', 'old.md'), 'utf8'), 'from before');
});

test('migrating an already-split snapshot moves nothing', () => {
  const root = path.join(home, 'vault-done', 'config');
  fs.mkdirSync(path.join(root, 'ffffffffffff'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ffffffffffff', 'CLAUDE.md'), 'x');
  const r = CV.migrateFlatConfig({ root, id: 'eeeeeeeeeeee' });
  assert.deepEqual(r.moved, []);
  assert.deepEqual(ls(root), ['ffffffffffff']);
});

test('the vault can name the machines that keep a snapshot', () => {
  const root = path.join(home, 'vault-list', 'config');
  for (const id of ['aaaaaaaaaaaa', 'bbbbbbbbbbbb']) fs.mkdirSync(path.join(root, id), { recursive: true });
  fs.writeFileSync(path.join(root, 'stray.md'), 'not a machine');
  assert.deepEqual(CV.configMachines({ root }), ['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
});

test.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* Windows */ } });
