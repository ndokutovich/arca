// The MCP `read` tool takes a path. Anything that can influence the caller's
// input can therefore ask it for a file, so the confinement to the transcript
// trees is a security property, not a convenience — and one that is easy to
// undo by accident while editing the handler. These tests pin it.
//
// They exercise the same predicate the server uses rather than booting an MCP
// session: the decision is a path comparison, and that is what can regress.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vaultDir, projectsDir } from './transcripts.js';

// This mirrors mcp-server.js. The first version of these tests mirrored the
// *lexical* check the server used at the time, so they passed while a symlink
// planted in either root walked straight out — a test that reproduces the
// implementation's mistake proves nothing. Canonicalise, like the server does.
function canon(p) {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

function isInside(filePath) {
  const resolved = canon(path.resolve(filePath));
  return [vaultDir(), projectsDir()]
    .map(canon)
    .some((root) => resolved === root || resolved.startsWith(root + path.sep));
}

test('transcripts in either tree are readable', () => {
  assert.ok(isInside(path.join(vaultDir(), 'some-project', 'abc.jsonl')));
  assert.ok(isInside(path.join(projectsDir(), 'some-project', 'abc.jsonl')));
});

test('files outside both trees are refused', () => {
  for (const outside of [
    path.join(os.homedir(), '.ssh', 'id_rsa'),
    path.join(os.homedir(), '.claude', 'settings.json'),
    path.join(os.tmpdir(), 'anything.jsonl'),
  ]) {
    assert.equal(isInside(outside), false, `${outside} must not be readable`);
  }
});

test('traversal out of the vault is refused', () => {
  const escape = path.join(vaultDir(), '..', '.ssh', 'id_rsa');
  assert.equal(isInside(escape), false, 'a ../ escape got through');
});

test('a sibling directory sharing the prefix is not inside', () => {
  // `<vault>-backup` starts with the vault path as a string but is a different
  // directory; the separator check is what keeps prefix matching honest.
  assert.equal(isInside(`${vaultDir()}-backup/x.jsonl`), false);
});

test('a symlink planted inside the vault does not lead out of it', (t) => {
  // The escape this predicate exists to stop. Skipped rather than failed where
  // the platform refuses to create links unprivileged — a skip is honest, a
  // silent pass is not.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-link-'));
  const vault = path.join(home, '.claude-vault');
  const outside = path.join(home, 'outside');
  fs.mkdirSync(vault, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.jsonl'), '{}\n');

  const link = path.join(vault, 'escape');
  try {
    fs.symlinkSync(outside, link, 'junction');
  } catch {
    t.skip('this platform will not create links here');
    return;
  }

  const target = path.join(link, 'secret.jsonl');
  const canonTarget = fs.realpathSync.native(target);
  const canonVault = fs.realpathSync.native(vault);
  const escaped = !(canonTarget === canonVault || canonTarget.startsWith(canonVault + path.sep));
  assert.ok(escaped, 'the link should resolve outside the vault for this test to mean anything');

  // And the lexical check that shipped in 0.5.0 would have let it through.
  const lexical = path.resolve(target).startsWith(path.resolve(vault) + path.sep);
  assert.ok(lexical, 'the lexical predicate was the hole; this documents it');

  fs.rmSync(home, { recursive: true, force: true });
});
