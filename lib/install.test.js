// install writes into settings.json, which is the file on the machine that
// can least afford a careless write: it holds the permission rules, every
// hook, and the environment. A bad merge here does not lose a feature, it
// loses the configuration.
//
// The home directory is resolved when the module is first loaded, so the
// sandbox has to exist before the import — hence the top-level await rather
// than a helper per test.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-install-'));
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;

const { install } = await import('./install.js');

const SETTINGS = path.join(home, '.claude', 'settings.json');
const read = () => JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));

/** A settings.json with the shape a real one has: hooks, permissions, env. */
function settings(sessionStartHooks) {
  fs.writeFileSync(SETTINGS, JSON.stringify({
    env: { TTS_STREAM: '1' },
    permissions: { allow: ['Bash(git status)'] },
    hooks: {
      SessionStart: [{ matcher: '', hooks: sessionStartHooks }],
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'node other.js' }] }],
    },
  }, null, 2));
}

const starts = () => read().hooks.SessionStart.flatMap((b) => b.hooks).map((h) => h.command);

test('a session-vault hook belonging to something else is left alone', () => {
  settings([{ type: 'command', command: 'node C:/elsewhere/session-vault.js' }]);
  const r = install({ seed: false });
  assert.match(r.settings, /left alone/);
  assert.match(r.settings, /--replace-hook/, 'the way forward is not named');
  assert.deepEqual(starts(), ['node C:/elsewhere/session-vault.js']);
});

test('asked explicitly, it takes that registration over', () => {
  // vault-memory, the project this grew out of, registers a hook of the same
  // name. Without this the upgrade is silently partial: the MCP server
  // appears and the archiving stays on the old code.
  settings([{ type: 'command', command: 'node C:/elsewhere/session-vault.js' }]);
  const r = install({ seed: false, replaceHook: true });
  assert.match(r.settings, /taken over/);
  const after = starts();
  assert.equal(after.length, 1);
  assert.ok(after[0].includes('arca') || after[0].includes('session-vault.js'));
  assert.ok(!after[0].includes('C:/elsewhere'), 'the old command survived');
});

test('a takeover keeps every other hook on the same event', () => {
  // Three hooks run at SessionStart on the machine this was written on.
  // Replacing one of them must not be how the other two disappear.
  settings([
    { type: 'command', command: 'node C:/elsewhere/session-vault.js' },
    { type: 'command', command: 'C:/hooks/peon-ping/hook.cmd' },
    { type: 'command', command: 'node C:/hooks/identity-capture/session-start.js' },
  ]);
  install({ seed: false, replaceHook: true });
  const after = starts();
  assert.equal(after.length, 3);
  assert.ok(after.includes('C:/hooks/peon-ping/hook.cmd'));
  assert.ok(after.includes('node C:/hooks/identity-capture/session-start.js'));
});

test('a takeover keeps everything else in the file', () => {
  settings([{ type: 'command', command: 'node C:/elsewhere/session-vault.js' }]);
  install({ seed: false, replaceHook: true });
  const after = read();
  assert.deepEqual(after.env, { TTS_STREAM: '1' }, 'the environment was dropped');
  assert.deepEqual(after.permissions, { allow: ['Bash(git status)'] }, 'the permission rules were dropped');
  assert.equal(after.hooks.Stop[0].hooks[0].command, 'node other.js', 'another event was dropped');
});

test('a dry run reports the takeover and writes nothing', () => {
  settings([{ type: 'command', command: 'node C:/elsewhere/session-vault.js' }]);
  const before = fs.readFileSync(SETTINGS, 'utf8');
  const r = install({ seed: false, replaceHook: true, dryRun: true });
  assert.match(r.settings, /taken over/);
  assert.equal(fs.readFileSync(SETTINGS, 'utf8'), before, 'a dry run edited settings.json');
});

test('the file it replaced is kept', () => {
  settings([{ type: 'command', command: 'node C:/elsewhere/session-vault.js' }]);
  const r = install({ seed: false, replaceHook: true });
  assert.ok(r.backups.length, 'settings.json was rewritten with no backup');
  const kept = JSON.parse(fs.readFileSync(r.backups.find((b) => b.includes('settings')), 'utf8'));
  assert.equal(kept.hooks.SessionStart[0].hooks[0].command, 'node C:/elsewhere/session-vault.js');
});

test('installing twice changes nothing the second time', () => {
  settings([]);
  install({ seed: false });
  const once = fs.readFileSync(SETTINGS, 'utf8');
  const again = install({ seed: false });
  assert.equal(again.settings, 'unchanged');
  assert.equal(fs.readFileSync(SETTINGS, 'utf8'), once);
});

test('settings.json with no hooks at all is not a crash', () => {
  fs.writeFileSync(SETTINGS, JSON.stringify({ env: {} }));
  assert.doesNotThrow(() => install({ seed: false }));
  assert.equal(starts().length, 1);
});

test.after(() => fs.rmSync(home, { recursive: true, force: true }));
