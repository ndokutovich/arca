// What the configuration half of the vault must never do: take a credential,
// take a hundred megabytes of somebody else's node_modules, or overwrite a
// live settings.json because a flag was passed out of habit.
//
// Every exclusion test plants an included file next to the excluded one. A
// collect() that returned nothing at all would otherwise pass all of them.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collect, sync, restore, existing, dueForSync, syncIfDue } from './config-vault.js';

const PAT = `github_pat_${'A'.repeat(20)}9`;

function write(root, rel, body = 'x') {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return full;
}

/** A home with one of everything that matters. */
function fakeHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-cfg-'));
  write(root, 'CLAUDE.md', '# rules');
  write(root, 'settings.json', '{"env":{}}');
  write(root, 'agents/eng/backend.md', 'an agent');
  write(root, 'commands/deploy.md', 'a command');
  write(root, 'skills/mine/SKILL.md', 'a skill');
  write(root, 'hooks/peon-ping/config.json', '{}');
  write(root, 'plugins/config.json', '{}');
  write(root, 'projects/w--app/memory/MEMORY.md', '# what I know');
  return root;
}

function sandbox() {
  const home = fakeHome();
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-dest-'));
  return {
    home,
    dest,
    clean() {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(dest, { recursive: true, force: true });
    },
  };
}

test('the things that make one machine different from another are taken', () => {
  const s = sandbox();
  try {
    const got = collect(s.home);
    for (const want of ['CLAUDE.md', 'settings.json', 'agents/eng/backend.md',
      'commands/deploy.md', 'skills/mine/SKILL.md', 'hooks/peon-ping/config.json',
      'plugins/config.json', 'projects/w--app/memory/MEMORY.md']) {
      assert.ok(got.includes(want), `${want} was not taken`);
    }
  } finally { s.clean(); }
});

test('credentials are never taken', () => {
  const s = sandbox();
  try {
    write(s.home, 'plugins/.credentials.json', '{"token":"real"}');
    const got = collect(s.home);
    assert.ok(got.includes('plugins/config.json'), 'the control file was not taken either');
    assert.ok(!got.some((f) => f.includes('.credentials.json')), 'a credentials file was taken');
  } finally { s.clean(); }
});

test('a vendored node_modules is not the user configuration', () => {
  // 30 MB of it lives under skills/ on the machine this was written on, and
  // it is a dependency of a script, not a thing anyone chose.
  const s = sandbox();
  try {
    write(s.home, 'skills/presale/scripts/node_modules/codepage/cptable.js', 'x'.repeat(1000));
    const got = collect(s.home);
    assert.ok(got.includes('skills/mine/SKILL.md'), 'the control file was not taken either');
    assert.ok(!got.some((f) => f.includes('node_modules')), 'node_modules was taken');
  } finally { s.clean(); }
});

test('the skills Claude Code downloads for itself are not taken', () => {
  const s = sandbox();
  try {
    write(s.home, 'skills/synced/abc-123/docx/schemas/sml.xsd', 'x'.repeat(1000));
    const got = collect(s.home);
    assert.ok(got.includes('skills/mine/SKILL.md'), 'the control file was not taken either');
    assert.ok(!got.some((f) => f.startsWith('skills/synced/')), 'a synced skill was taken');
  } finally { s.clean(); }
});

test('audio is not configuration', () => {
  const s = sandbox();
  try {
    write(s.home, 'hooks/peon-ping/packs/user/ready.wav', 'RIFF....');
    const got = collect(s.home);
    assert.ok(got.includes('hooks/peon-ping/config.json'), 'the control file was not taken either');
    assert.ok(!got.some((f) => f.endsWith('.wav')), 'a sound file was taken');
  } finally { s.clean(); }
});

test('a copy is made, and making it twice changes nothing', () => {
  const s = sandbox();
  try {
    const first = sync({ home: s.home, dest: s.dest, allow: new Set() });
    assert.ok(first.added.length >= 8);
    assert.equal(first.changed.length, 0);
    assert.ok(fs.existsSync(path.join(s.dest, 'agents/eng/backend.md')));

    const second = sync({ home: s.home, dest: s.dest, allow: new Set() });
    assert.equal(second.added.length, 0, 'the second run copied files again');
    assert.equal(second.changed.length, 0);
    assert.equal(second.unchanged, first.added.length);
  } finally { s.clean(); }
});

test('an edit is a change, not a re-copy of everything', () => {
  const s = sandbox();
  try {
    sync({ home: s.home, dest: s.dest, allow: new Set() });
    write(s.home, 'CLAUDE.md', '# different rules');
    const r = sync({ home: s.home, dest: s.dest, allow: new Set() });
    assert.deepEqual(r.changed, ['CLAUDE.md']);
    assert.equal(r.added.length, 0);
    assert.equal(fs.readFileSync(path.join(s.dest, 'CLAUDE.md'), 'utf8'), '# different rules');
  } finally { s.clean(); }
});

test('a dry run writes nothing and still says what it would do', () => {
  const s = sandbox();
  try {
    const r = sync({ home: s.home, dest: s.dest, allow: new Set(), dryRun: true });
    assert.ok(r.added.length >= 8);
    assert.equal(existing(s.dest).length, 0, 'a dry run wrote files');
  } finally { s.clean(); }
});

test('deleting a skill deletes it from the copy too', () => {
  const s = sandbox();
  try {
    sync({ home: s.home, dest: s.dest, allow: new Set() });
    fs.rmSync(path.join(s.home, 'skills/mine/SKILL.md'));
    const r = sync({ home: s.home, dest: s.dest, allow: new Set() });
    assert.deepEqual(r.removed, ['skills/mine/SKILL.md']);
    assert.ok(!fs.existsSync(path.join(s.dest, 'skills/mine/SKILL.md')));
  } finally { s.clean(); }
});

test('a file that holds a credential is left behind and named', () => {
  const s = sandbox();
  try {
    write(s.home, 'projects/w--app/memory/deploy.md', `the key is ${PAT}`);
    const r = sync({ home: s.home, dest: s.dest, allow: new Set() });
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].file, 'projects/w--app/memory/deploy.md');
    assert.equal(r.skipped[0].findings[0].rule, 'github-pat');
    assert.ok(!fs.existsSync(path.join(s.dest, 'projects/w--app/memory/deploy.md')));
    assert.ok(fs.existsSync(path.join(s.dest, 'projects/w--app/memory/MEMORY.md')),
      'the clean file beside it was not copied either');
  } finally { s.clean(); }
});

test('a file that gains a credential is taken back out of the copy', () => {
  // The rule may not have existed when the file was first copied, or the
  // secret may have been pasted in afterwards. Leaving the old copy in the
  // working tree would put it in the next commit regardless.
  const s = sandbox();
  try {
    write(s.home, 'projects/w--app/memory/deploy.md', 'nothing yet');
    sync({ home: s.home, dest: s.dest, allow: new Set() });
    assert.ok(fs.existsSync(path.join(s.dest, 'projects/w--app/memory/deploy.md')));

    write(s.home, 'projects/w--app/memory/deploy.md', `now it says ${PAT}`);
    const r = sync({ home: s.home, dest: s.dest, allow: new Set() });
    assert.equal(r.skipped.length, 1);
    assert.ok(!fs.existsSync(path.join(s.dest, 'projects/w--app/memory/deploy.md')),
      'the older clean copy is still sitting in the vault');
  } finally { s.clean(); }
});

test('a file the user has vouched for is taken anyway', () => {
  const s = sandbox();
  try {
    write(s.home, 'projects/w--app/memory/deploy.md', `the key is ${PAT}`);
    const r = sync({
      home: s.home,
      dest: s.dest,
      allow: new Set(['projects/w--app/memory/deploy.md']),
    });
    assert.equal(r.skipped.length, 0);
    assert.ok(fs.existsSync(path.join(s.dest, 'projects/w--app/memory/deploy.md')));
  } finally { s.clean(); }
});

test('restoring onto an empty machine writes everything', () => {
  const s = sandbox();
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-fresh-'));
  try {
    sync({ home: s.home, dest: s.dest, allow: new Set() });
    const r = restore({ home: fresh, dest: s.dest });
    assert.ok(r.written.length >= 8);
    assert.equal(r.conflicts.length, 0);
    assert.equal(fs.readFileSync(path.join(fresh, 'CLAUDE.md'), 'utf8'), '# rules');
  } finally {
    s.clean();
    fs.rmSync(fresh, { recursive: true, force: true });
  }
});

test('restoring never overwrites what is already there', () => {
  // The file in the way is this machine's live settings, and replacing it
  // wholesale is how a configuration gets lost.
  const s = sandbox();
  try {
    sync({ home: s.home, dest: s.dest, allow: new Set() });
    write(s.home, 'settings.json', '{"env":{"mine":true}}');
    const r = restore({ home: s.home, dest: s.dest });
    assert.ok(r.conflicts.includes('settings.json'));
    assert.ok(!r.written.includes('settings.json'));
    assert.equal(fs.readFileSync(path.join(s.home, 'settings.json'), 'utf8'), '{"env":{"mine":true}}');
  } finally { s.clean(); }
});

test('forcing an overwrite keeps the file it replaced', () => {
  const s = sandbox();
  try {
    sync({ home: s.home, dest: s.dest, allow: new Set() });
    write(s.home, 'settings.json', '{"env":{"mine":true}}');
    const r = restore({ home: s.home, dest: s.dest, force: true });
    assert.ok(r.written.includes('settings.json'));
    assert.equal(fs.readFileSync(path.join(s.home, 'settings.json'), 'utf8'), '{"env":{}}');
    assert.equal(
      fs.readFileSync(path.join(s.home, 'settings.json.before-arca-restore'), 'utf8'),
      '{"env":{"mine":true}}',
      'the replaced file was not kept',
    );
  } finally { s.clean(); }
});

test('an identical file is neither a conflict nor a write', () => {
  const s = sandbox();
  try {
    sync({ home: s.home, dest: s.dest, allow: new Set() });
    const r = restore({ home: s.home, dest: s.dest });
    assert.equal(r.written.length, 0);
    assert.equal(r.conflicts.length, 0);
    assert.ok(r.identical >= 8);
  } finally { s.clean(); }
});

test('restoring from a vault that has no configuration says so', () => {
  const s = sandbox();
  try {
    const r = restore({ home: s.home, dest: s.dest });
    assert.equal(r.empty, true);
    assert.equal(r.written.length, 0);
  } finally { s.clean(); }
});

test('a missing copy is due however recently the clock was stamped', () => {
  const s = sandbox();
  try {
    const gone = path.join(s.dest, 'not-here');
    assert.equal(dueForSync({ dest: gone }), true);
  } finally { s.clean(); }
});

test('the cooldown skips the pass and the next one picks it up', () => {
  const s = sandbox();
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  const fakeVaultHome = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-vault-'));
  process.env.HOME = fakeVaultHome;
  process.env.USERPROFILE = fakeVaultHome;
  try {
    const opts = { home: s.home, dest: s.dest, allow: new Set() };
    const first = syncIfDue(opts);
    assert.ok(first, 'the first run should not have been skipped');
    assert.ok(first.added.length >= 8);

    write(s.home, 'CLAUDE.md', '# edited during the cooldown');
    assert.equal(syncIfDue(opts), null, 'the cooldown did not hold');
    assert.equal(fs.readFileSync(path.join(s.dest, 'CLAUDE.md'), 'utf8'), '# rules');

    const later = syncIfDue({ ...opts, cooldownMs: 0 });
    assert.deepEqual(later.changed, ['CLAUDE.md'], 'the edit was never picked up');
  } finally {
    process.env.HOME = savedHome;
    process.env.USERPROFILE = savedProfile;
    fs.rmSync(fakeVaultHome, { recursive: true, force: true });
    s.clean();
  }
});

test('a linked skills directory is followed, not skipped in silence', () => {
  // Keeping skills in a repo of their own and linking them into ~/.claude is
  // an ordinary arrangement. readdir calls the link neither a file nor a
  // directory, so the first version captured the whole tree as nothing and
  // said nothing about it.
  const s = sandbox();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-repo-'));
  try {
    fs.writeFileSync(path.join(elsewhere, 'SKILL.md'), 'a skill kept elsewhere');
    const link = path.join(s.home, 'skills', 'linked');
    try {
      fs.symlinkSync(elsewhere, link, 'junction');
    } catch {
      try { fs.symlinkSync(elsewhere, link, 'dir'); } catch { return; } // no privilege to link
    }
    const got = collect(s.home);
    assert.ok(got.includes('skills/mine/SKILL.md'), 'the control file was not taken either');
    assert.ok(got.includes('skills/linked/SKILL.md'), 'the linked tree was skipped');
  } finally {
    s.clean();
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('a link pointing at an ancestor does not loop forever', () => {
  const s = sandbox();
  try {
    const link = path.join(s.home, 'skills', 'up');
    try {
      fs.symlinkSync(s.home, link, 'junction');
    } catch {
      try { fs.symlinkSync(s.home, link, 'dir'); } catch { return; }
    }
    const got = collect(s.home);
    assert.ok(got.includes('skills/mine/SKILL.md'));
  } finally { s.clean(); }
});

test('a broken link is not an error', () => {
  const s = sandbox();
  try {
    const link = path.join(s.home, 'skills', 'dangling');
    try {
      fs.symlinkSync(path.join(os.tmpdir(), 'arca-does-not-exist'), link, 'junction');
    } catch {
      try { fs.symlinkSync(path.join(os.tmpdir(), 'arca-does-not-exist'), link, 'dir'); } catch { return; }
    }
    assert.doesNotThrow(() => collect(s.home));
    assert.ok(collect(s.home).includes('skills/mine/SKILL.md'));
  } finally { s.clean(); }
});

test('what this module leaves behind is not configuration', () => {
  // An interrupted copy leaves <name>.tmp-<pid>, and --force leaves
  // <name>.before-arca-restore. Both sit next to a real file under agents/ or
  // skills/, match the same patterns, and were captured and committed.
  const s = sandbox();
  try {
    write(s.home, 'agents/eng/backend.md.tmp-9999', 'half a copy');
    // Somebody else's leftovers, and the vault ignores *.tmp for its own
    // reasons — a captured one is copied and then never committed.
    write(s.home, 'hooks/conoti-learn/drift-state.json.118324.tmp', '{}');
    write(s.home, 'agents/eng/backend.md.before-arca-restore', 'the previous one');
    const got = collect(s.home);
    assert.ok(got.includes('agents/eng/backend.md'), 'the control file was not taken either');
    assert.ok(!got.some((f) => f.includes('.tmp-')), 'a half-written copy was taken');
    assert.ok(!got.some((f) => f.includes('.before-arca-restore')), 'a restore backup was taken');
    assert.ok(!got.some((f) => f.endsWith('.tmp')), 'a runtime temp file was taken');
  } finally { s.clean(); }
});

test('the size reported is the size of the copy', () => {
  // A held-back file is not in the copy, so counting its bytes makes the
  // printed total describe something that does not exist.
  const s = sandbox();
  try {
    const clean = sync({ home: s.home, dest: s.dest, allow: new Set(), dryRun: true }).bytes;
    write(s.home, 'projects/w--app/memory/deploy.md', `${'x'.repeat(5000)} ${PAT}`);
    const withSecret = sync({ home: s.home, dest: s.dest, allow: new Set(), dryRun: true });
    assert.equal(withSecret.skipped.length, 1);
    assert.equal(withSecret.bytes, clean, 'the held-back file was counted into the size');
  } finally { s.clean(); }
});

test('an allowed path written the Windows way is the same path', () => {
  const s = sandbox();
  try {
    write(s.home, 'projects/w--app/memory/deploy.md', `the key is ${PAT}`);
    const back = String.fromCharCode(92);
    const r = sync({
      home: s.home,
      dest: s.dest,
      allow: new Set([['projects', 'w--app', 'memory', 'deploy.md'].join(back)]),
    });
    // The allow set is normalised on the way in, so a path copied out of
    // Explorer or a PowerShell prompt works like one typed with slashes.
    assert.equal(r.skipped.length, 0, 'a backslash path did not match');
  } finally { s.clean(); }
});
