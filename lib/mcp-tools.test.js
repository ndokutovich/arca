// The MCP tool list and the dispatcher are two lists that have to agree. A
// tool declared with no handler answers every call with an error; a handler
// with no declaration is invisible and dead. Neither shows up until someone
// tries the tool, and the README has already been wrong about the count once.
//
// This reads the source rather than booting a server: the failure mode is a
// mismatch between two literals in one file, which is exactly what text can
// see and a running server cannot tell you cheaply.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp-server.js'),
  'utf8',
);

const declared = [...SRC.matchAll(/^ {6}name: '([a-z_]+)',$/gm)].map((m) => m[1]);
const handled = [...SRC.matchAll(/if \(name === '([a-z_]+)'\)/g)].map((m) => m[1]);

test('the source yields a plausible tool list at all', () => {
  // A positive control. If the patterns above stop matching — the file gets
  // reformatted, say — every other assertion here would pass vacuously.
  assert.ok(declared.length >= 15, `only found ${declared.length} declarations`);
  assert.ok(handled.length >= 15, `only found ${handled.length} handlers`);
  assert.ok(declared.includes('search'), 'search should always be there');
});

test('every declared tool has a handler', () => {
  const missing = declared.filter((n) => !handled.includes(n));
  assert.deepEqual(missing, [], 'declared but unreachable');
});

test('every handler is declared', () => {
  const extra = handled.filter((n) => !declared.includes(n));
  assert.deepEqual(extra, [], 'reachable but invisible');
});

test('no tool is declared twice', () => {
  const seen = new Set();
  const dupes = declared.filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
  assert.deepEqual(dupes, []);
});

test('every tool says what it is for', () => {
  // A tool with no description is one the model will not reach for.
  for (const name of declared) {
    const at = SRC.indexOf(`name: '${name}',`);
    const window = SRC.slice(at, at + 400);
    assert.match(window, /description:/, `${name} has no description`);
  }
});

test('tools that write are not marked read-only', () => {
  // readOnlyHint on a writing tool is worse than no hint: it tells the host it
  // is safe to call without asking.
  for (const name of ['kg_add', 'kg_invalidate', 'observation_add']) {
    const at = SRC.indexOf(`name: '${name}',`);
    assert.ok(at > 0, `${name} is missing`);
    const window = SRC.slice(at, at + 1600);
    assert.doesNotMatch(window, /readOnlyHint: true/, `${name} claims to be read-only`);
  }
});
