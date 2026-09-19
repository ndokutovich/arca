// Cursor keeps its conversations in a global key-value table where the only
// thing tying a message to a session is a colon in the key, most rows carry no
// text, and most sessions carry no messages. An adapter that trusts the
// structure Cursor documents — an ordered header list on each session — reads
// 55 of 58 sessions as empty on this machine.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import cursor from './cursor.js';

const NL = String.fromCharCode(10);

/**
 * A globalStorage database in the shape Cursor writes.
 * @param {Array<{id, name?, uris?, bubbles: Array<{type, text?, createdAt?}>}>} composers
 */
function sandbox(composers) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-cursor-'));
  const file = path.join(dir, 'state.vscdb');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)');
  const put = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');

  for (const c of composers) {
    put.run(`composerData:${c.id}`, JSON.stringify({
      composerId: c.id,
      name: c.name,
      createdAt: 1,
      fullConversationHeadersOnly: [],
      context: { fileSelections: (c.uris || []).map((u) => ({ uri: `file:///${u}` })) },
    }));
    (c.bubbles || []).forEach((b, i) => {
      put.run(`bubbleId:${c.id}:b${i}`, JSON.stringify({
        bubbleId: `b${i}`, type: b.type, text: b.text, createdAt: b.createdAt,
      }));
    });
  }
  db.close();
  return { dir, file };
}

const ask = (text, createdAt) => ({ type: 1, text, createdAt });
const said = (text, createdAt) => ({ type: 2, text, createdAt });

test('a session is grouped from the key, not from the header list', () => {
  // fullConversationHeadersOnly is empty on almost every real session.
  const { dir, file } = sandbox([{
    id: 'c1',
    bubbles: [ask('a question', '2026-01-01T00:00:01Z'), said('an answer', '2026-01-01T00:00:02Z')],
  }]);
  const [s] = cursor.discover(file);
  assert.equal(s.sessionId, 'c1');
  assert.deepEqual(cursor.read(file, s).map((t) => [t.role, t.text]), [
    ['user', 'a question'], ['assistant', 'an answer'],
  ]);
  cursor.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('type 1 is the person and type 2 is Cursor', () => {
  const { dir, file } = sandbox([{
    id: 'c1', bubbles: [said('mine', '2026-01-01T00:00:02Z'), ask('yours', '2026-01-01T00:00:01Z')],
  }]);
  const [s] = cursor.discover(file);
  const turns = cursor.read(file, s);
  assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant'], 'and they come back in time order');
  cursor.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a bubble with no text is not a message', () => {
  // Most rows are diffs, tool results and checkpoints.
  const { dir, file } = sandbox([{
    id: 'c1',
    bubbles: [ask('kept', '2026-01-01T00:00:01Z'), { type: 2, createdAt: '2026-01-01T00:00:02Z' }, said('   ', '2026-01-01T00:00:03Z')],
  }]);
  const [s] = cursor.discover(file);
  assert.deepEqual(cursor.read(file, s).map((t) => t.text), ['kept']);
  cursor.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a composer that never said anything is not a session', () => {
  const { dir, file } = sandbox([
    { id: 'empty', bubbles: [] },
    { id: 'abandoned', bubbles: [{ type: 2, createdAt: '2026-01-01T00:00:01Z' }] },
    { id: 'real', bubbles: [ask('hi', '2026-01-01T00:00:01Z')] },
  ]);
  assert.deepEqual(cursor.discover(file).map((s) => s.sessionId), ['real']);
  cursor.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the working directory is the path every referenced file shares', () => {
  const { dir, file } = sandbox([{
    id: 'c1',
    uris: ['c%3A/proj/app/src/a.ts', 'c%3A/proj/app/src/b.ts', 'c%3A/proj/app/README.md'],
    bubbles: [ask('hi', '2026-01-01T00:00:01Z')],
  }]);
  const [s] = cursor.discover(file);
  assert.equal(s.cwd, 'c:/proj/app');
  assert.equal(s.project, 'c--proj-app');
  cursor.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('one referenced file gives its directory, not itself', () => {
  // With a single file the shared prefix is that file, and a session filed
  // under a project named after a README helps nobody.
  const { dir, file } = sandbox([{
    id: 'c1',
    uris: ['c%3A/proj/app/frontend/NPC_FIX.md', 'c%3A/proj/app/frontend/NPC_FIX.md'],
    bubbles: [ask('hi', '2026-01-01T00:00:01Z')],
  }]);
  const [s] = cursor.discover(file);
  assert.equal(s.cwd, 'c:/proj/app/frontend');
  cursor.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a session that references no files is named as unknown', () => {
  const { dir, file } = sandbox([{ id: 'c1', bubbles: [ask('hi', '2026-01-01T00:00:01Z')] }]);
  const [s] = cursor.discover(file);
  assert.equal(s.cwd, null);
  assert.equal(s.project, 'cursor-unknown');
  cursor.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the composer name leads the conversation instead of becoming a turn', () => {
  const { dir, file } = sandbox([{
    id: 'c1', name: 'Dialog system layout',
    bubbles: [ask('fix the footer', '2026-01-01T00:00:01Z'), said('done', '2026-01-01T00:00:02Z')],
  }]);
  const [s] = cursor.discover(file);
  const turns = cursor.read(file, s);
  assert.equal(turns.length, 2, 'the name must not be a message of its own');
  assert.equal(turns[0].text, `Dialog system layout${NL}${NL}fix the footer`);
  cursor.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a corrupt row costs that row', () => {
  const { dir, file } = sandbox([{ id: 'c1', bubbles: [ask('survives', '2026-01-01T00:00:01Z')] }]);
  const db = new DatabaseSync(file);
  db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run('bubbleId:c1:bad', '{ not json');
  db.close();
  const [s] = cursor.discover(file);
  assert.deepEqual(cursor.read(file, s).map((t) => t.text), ['survives']);
  cursor.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a database without the table is empty, not an error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-cursor-'));
  const file = path.join(dir, 'state.vscdb');
  new DatabaseSync(file).close();
  assert.deepEqual(cursor.discover(file), []);
  cursor.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('absence is not an error', () => {
  const saved = process.env.ARCA_CURSOR_DIR;
  try {
    process.env.ARCA_CURSOR_DIR = path.join(os.tmpdir(), 'arca-no-cursor-here.vscdb');
    assert.equal(cursor.detect().present, false);
  } finally {
    if (saved === undefined) delete process.env.ARCA_CURSOR_DIR; else process.env.ARCA_CURSOR_DIR = saved;
  }
});

test('reads the real corpus when there is one here', (t) => {
  const found = cursor.detect();
  if (!found.present) {
    t.skip('no Cursor data on this machine; the synthetic cases above still ran');
    return;
  }
  const sessions = cursor.discover(found.root);
  if (!sessions.length) {
    t.skip('a Cursor database exists but holds no conversations');
    return;
  }
  let total = 0;
  for (const s of sessions) {
    for (const turn of cursor.read(s.file, s)) {
      assert.ok(turn.role === 'user' || turn.role === 'assistant', `stray role ${turn.role}`);
      assert.ok(turn.text.trim(), 'an empty turn got through');
      total++;
    }
  }
  assert.ok(total > 0, 'sessions were found but every one of them read as empty');
});
