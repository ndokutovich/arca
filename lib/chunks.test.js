import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  syncChunks, assembleChunks, listParts, readManifest, DEFAULTS,
} from './chunks.js';

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-chunks-'));
  const session = path.join(root, 's1');
  const src = path.join(root, 'src.jsonl');
  fs.mkdirSync(session, { recursive: true });
  return { root, session, src, cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} } };
}

const line = (n) => JSON.stringify({ type: 'user', message: { role: 'user', content: `line ${n}` } }) + '\n';

async function assembled(session) {
  const out = path.join(path.dirname(session), 'out.jsonl');
  await assembleChunks(session, out);
  const text = fs.readFileSync(out, 'utf8');
  fs.unlinkSync(out);
  return text;
}

test('a session is chunked and glues back together', async () => {
  const s = sandbox();
  try {
    fs.writeFileSync(s.src, Array.from({ length: 50 }, (_, i) => line(i)).join(''));
    assert.equal(syncChunks(s.session, s.src), 'created');

    const parts = listParts(s.session);
    assert.equal(parts.length, 1, 'a small source needs one part');
    assert.equal(await assembled(s.session), fs.readFileSync(s.src, 'utf8'));
  } finally { s.cleanup(); }
});

test('an append touches only the growing part', async () => {
  const s = sandbox();
  try {
    fs.writeFileSync(s.src, Array.from({ length: 40 }, (_, i) => line(i)).join(''));
    syncChunks(s.session, s.src);
    const before = fs.readFileSync(listParts(s.session)[0].path);

    fs.appendFileSync(s.src, line(999));
    assert.equal(syncChunks(s.session, s.src), 'appended');

    const after = fs.readFileSync(listParts(s.session)[0].path);
    assert.ok(after.length > before.length);
    assert.equal(after.subarray(0, before.length).toString(), before.toString(), 'the existing bytes moved');
    assert.equal(await assembled(s.session), fs.readFileSync(s.src, 'utf8'));
  } finally { s.cleanup(); }
});

test('parts rotate at a line boundary, and every part but the last is closed', async () => {
  const s = sandbox();
  try {
    const rows = Array.from({ length: 400 }, (_, i) => line(i));
    fs.writeFileSync(s.src, rows.join(''));
    syncChunks(s.session, s.src, { partBytes: 2048 });

    const parts = listParts(s.session);
    assert.ok(parts.length > 1, 'rotation never happened');
    for (const p of parts.slice(0, -1)) {
      assert.equal(p.closed, true, `${p.name} is not closed`);
      assert.ok(p.sha256, `${p.name} has no hash`);
      assert.ok(p.bytes <= 2048 + 256, `${p.name} overshot the part size: ${p.bytes}`);
      const body = fs.readFileSync(p.path, 'utf8');
      assert.ok(body.endsWith('\n'), `${p.name} does not end on a line boundary`);
    }
    assert.equal(parts[parts.length - 1].closed, false, 'the growing part must stay open');
    assert.equal(await assembled(s.session), fs.readFileSync(s.src, 'utf8'));
  } finally { s.cleanup(); }
});

test('a rewritten source replaces the parts instead of appending to them', async () => {
  const s = sandbox();
  try {
    fs.writeFileSync(s.src, Array.from({ length: 20 }, (_, i) => line(i)).join(''));
    syncChunks(s.session, s.src, { partBytes: 512 });
    const first = listParts(s.session).map((p) => p.name);

    fs.writeFileSync(s.src, Array.from({ length: 30 }, (_, i) => line(i + 100)).join(''));
    assert.equal(syncChunks(s.session, s.src, { partBytes: 512 }), 'rebuilt');

    assert.notDeepEqual(listParts(s.session).map((p) => p.name), first, 'old parts survived a rebuild');
    assert.equal(await assembled(s.session), fs.readFileSync(s.src, 'utf8'));
  } finally { s.cleanup(); }
});

test('a shorter source also rebuilds', async () => {
  const s = sandbox();
  try {
    fs.writeFileSync(s.src, Array.from({ length: 30 }, (_, i) => line(i)).join(''));
    syncChunks(s.session, s.src);
    fs.writeFileSync(s.src, line(1));
    assert.equal(syncChunks(s.session, s.src), 'rebuilt');
    assert.equal(await assembled(s.session), fs.readFileSync(s.src, 'utf8'));
  } finally { s.cleanup(); }
});

test('a single line longer than a part still lands whole', async () => {
  const s = sandbox();
  try {
    const giant = JSON.stringify({ content: 'x'.repeat(5000) }) + '\n';
    fs.writeFileSync(s.src, line(0) + giant + line(1));
    syncChunks(s.session, s.src, { partBytes: 1024 });

    assert.equal(await assembled(s.session), fs.readFileSync(s.src, 'utf8'));
  } finally { s.cleanup(); }
});

test('syncing an unchanged source writes nothing', async () => {
  const s = sandbox();
  try {
    fs.writeFileSync(s.src, Array.from({ length: 10 }, (_, i) => line(i)).join(''));
    syncChunks(s.session, s.src);
    const m1 = readManifest(s.session);
    const stamps = listParts(s.session).map((p) => fs.statSync(p.path).mtimeMs);

    assert.equal(syncChunks(s.session, s.src), 'unchanged');
    assert.deepEqual(listParts(s.session).map((p) => fs.statSync(p.path).mtimeMs), stamps, 'files were rewritten');
    assert.deepEqual(readManifest(s.session).parts.length, m1.parts.length);
  } finally { s.cleanup(); }
});

test('default thresholds are the documented ones', () => {
  assert.equal(DEFAULTS.partBytes, 8 * 1024 * 1024);
  assert.equal(DEFAULTS.thresholdBytes, 50 * 1024 * 1024);
});

test('a chunked session reads as one conversation', async () => {
  const { showConversation } = await import('./show.js');
  const { manifestPath } = await import('./chunks.js');
  const s = sandbox();
  try {
    const rows = Array.from({ length: 60 },
      (_, i) => JSON.stringify({ type: 'user', message: { role: 'user', content: `line ${i}` } }) + '\n');
    fs.writeFileSync(s.src, rows.join(''));
    syncChunks(s.session, s.src, { partBytes: 512 });
    assert.ok(listParts(s.session).length > 1, 'the fixture did not split');

    const md = showConversation(manifestPath(s.session));
    assert.match(md, /line 0/, 'the first part is missing from the reading');
    assert.match(md, /line 59/, 'the last part is missing from the reading');
  } finally { s.cleanup(); }
});
