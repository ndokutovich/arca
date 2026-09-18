// The MCP `read` tool takes a path. Anything that can influence the caller's
// input can therefore ask it for a file, so the confinement to the transcript
// trees is a security property, not a convenience — and one that is easy to
// undo by accident while editing the handler. These tests pin it.
//
// They exercise the same predicate the server uses rather than booting an MCP
// session: the decision is a path comparison, and that is what can regress.
import { test } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import { vaultDir, projectsDir } from './transcripts.js';

/** The confinement rule, as mcp-server.js applies it. */
function isInside(filePath) {
  const resolved = path.resolve(filePath);
  return [vaultDir(), projectsDir()]
    .map((r) => path.resolve(r))
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
