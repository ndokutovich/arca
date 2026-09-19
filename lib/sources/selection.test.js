// Which assistants get read is a decision about someone's history, so the
// failure that matters is the quiet one: a half-written file that reads back
// as "never asked", silently widening what gets imported on the next run.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-selection-'));
  fs.mkdirSync(path.join(home, '.claude-vault'), { recursive: true });
  return home;
}

async function withHome(home, fn) {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn(await import('./selection.js'));
  } finally {
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
  }
}

test('before anyone chooses, everything counts as on', async () => {
  // `--import` is already an explicit instruction. Refusing to act on it until
  // a second command has been run would be a riddle, not a safeguard.
  const home = sandbox();
  await withHome(home, (sel) => {
    const state = sel.load();
    assert.equal(state.chosen, false);
    assert.equal(sel.isEnabled('codex', state), true);
    assert.equal(sel.isEnabled('anything-at-all', state), true);
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('a choice is remembered, and everything outside it is off', async () => {
  const home = sandbox();
  await withHome(home, (sel) => {
    sel.save(['codex', 'cline']);
    const state = sel.load();
    assert.equal(state.chosen, true);
    assert.deepEqual(state.enabled, ['cline', 'codex']);
    assert.equal(sel.isEnabled('codex', state), true);
    assert.equal(sel.isEnabled('cursor', state), false);
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('choosing nothing is a choice, not an absence of one', async () => {
  // An empty list read back as "never asked" would import everything the next
  // time, which is the opposite of what was asked for.
  const home = sandbox();
  await withHome(home, (sel) => {
    sel.save([]);
    const state = sel.load();
    assert.equal(state.chosen, true);
    assert.equal(sel.isEnabled('codex', state), false);
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('a damaged file is treated as never asked, not as an empty choice', async () => {
  const home = sandbox();
  await withHome(home, (sel) => {
    sel.save(['codex']);
    const file = path.join(home, '.claude-vault', '.arca', 'sources.json');
    fs.writeFileSync(file, '{ "enabled": ');
    const state = sel.load();
    assert.equal(state.chosen, false, 'a truncated file must not read as a decision');
    assert.equal(sel.isEnabled('cursor', state), true);
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('saving twice replaces rather than accumulates', async () => {
  const home = sandbox();
  await withHome(home, (sel) => {
    sel.save(['codex', 'cursor']);
    sel.save(['cline']);
    assert.deepEqual(sel.load().enabled, ['cline']);
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('the file records when the choice was made', async () => {
  const home = sandbox();
  await withHome(home, (sel) => {
    sel.save(['codex']);
    assert.match(sel.load().updated, /^\d{4}-\d{2}-\d{2}T/);
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('the choice is local, and not where a pull would carry it', async () => {
  // Two machines hold different assistants and can want different answers.
  const home = sandbox();
  await withHome(home, (sel) => {
    sel.save(['codex']);
    const file = path.join(home, '.claude-vault', '.arca', 'sources.json');
    assert.ok(fs.existsSync(file));
    // The hook writes this path into the vault's .gitignore; if the location
    // moves, that rule has to move with it deliberately.
    assert.equal(path.relative(path.join(home, '.claude-vault'), file), path.join('.arca', 'sources.json'));
  });
  fs.rmSync(home, { recursive: true, force: true });
});
