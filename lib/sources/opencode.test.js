// OpenCode splits a conversation across four directories and puts the text in
// none of the obvious ones: a message file has a role and a timestamp and no
// content at all. An adapter that stops one level short reads every session as
// empty and reports success.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import opencode from './opencode.js';

const BS = String.fromCharCode(92);

/**
 * A storage tree in the shape OpenCode writes.
 * @param {Array<{id, project, directory, messages: Array<{id, role, created, parts}>}>} sessions
 */
function sandbox(sessions) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-opencode-'));
  const storage = path.join(home, 'storage');
  for (const s of sessions) {
    const sdir = path.join(storage, 'session', s.project || 'proj-1');
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(path.join(sdir, `${s.id}.json`), JSON.stringify({
      id: s.id,
      projectID: s.project || 'proj-1',
      directory: s.directory ?? `w:${BS}app`,
      title: 'a session',
      time: { created: 1, updated: 2 },
    }));

    for (const m of s.messages || []) {
      const mdir = path.join(storage, 'message', s.id);
      fs.mkdirSync(mdir, { recursive: true });
      fs.writeFileSync(path.join(mdir, `${m.id}.json`), JSON.stringify({
        id: m.id, sessionID: s.id, role: m.role, time: { created: m.created ?? 1 },
      }));

      const pdir = path.join(storage, 'part', m.id);
      fs.mkdirSync(pdir, { recursive: true });
      (m.parts || []).forEach((p, i) => {
        fs.writeFileSync(path.join(pdir, `prt_${String(i).padStart(3, '0')}.json`), JSON.stringify({
          id: `prt_${String(i).padStart(3, '0')}`, messageID: m.id, sessionID: s.id, ...p,
        }));
      });
    }
  }
  return { home, storage };
}

const sessionFile = (storage, project, id) =>
  path.join(storage, 'session', project, `${id}.json`);

test('detect finds the storage tree, and its absence is not an error', () => {
  const { home, storage } = sandbox([{ id: 'ses_1', project: 'p', messages: [] }]);
  const saved = process.env.ARCA_OPENCODE_DIR;
  try {
    process.env.ARCA_OPENCODE_DIR = home;
    assert.deepEqual(opencode.detect(), { present: true, root: storage });
    process.env.ARCA_OPENCODE_DIR = path.join(home, 'nope');
    assert.equal(opencode.detect().present, false);
  } finally {
    if (saved === undefined) delete process.env.ARCA_OPENCODE_DIR; else process.env.ARCA_OPENCODE_DIR = saved;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the session directory is what makes it the same project', () => {
  const { home, storage } = sandbox([{ id: 'ses_1', project: 'p', directory: `w:${BS}app`, messages: [] }]);
  const [s] = opencode.discover(storage);
  assert.equal(s.sessionId, 'ses_1');
  assert.equal(s.cwd, `w:${BS}app`);
  assert.equal(s.project, 'w--app', 'the same key Claude Code would produce');
  fs.rmSync(home, { recursive: true, force: true });
});

test('text lives in the parts, not the message', () => {
  const { home, storage } = sandbox([{
    id: 'ses_1', project: 'p',
    messages: [
      { id: 'msg_1', role: 'user', created: 10, parts: [{ type: 'text', text: 'a question' }] },
      { id: 'msg_2', role: 'assistant', created: 20, parts: [{ type: 'text', text: 'an answer' }] },
    ],
  }]);
  const turns = opencode.read(sessionFile(storage, 'p', 'ses_1'));
  assert.deepEqual(turns.map((t) => [t.role, t.text]), [
    ['user', 'a question'], ['assistant', 'an answer'],
  ]);
  fs.rmSync(home, { recursive: true, force: true });
});

test('a message with several text parts is one turn', () => {
  const { home, storage } = sandbox([{
    id: 'ses_1', project: 'p',
    messages: [{
      id: 'msg_1', role: 'assistant', created: 10,
      parts: [{ type: 'text', text: 'first half' }, { type: 'text', text: 'second half' }],
    }],
  }]);
  const [turn] = opencode.read(sessionFile(storage, 'p', 'ses_1'));
  assert.match(turn.text, /first half[\s\S]*second half/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('tool calls, reasoning and step markers are not conversation', () => {
  const { home, storage } = sandbox([{
    id: 'ses_1', project: 'p',
    messages: [{
      id: 'msg_1', role: 'assistant', created: 10,
      parts: [
        { type: 'step-start' },
        { type: 'reasoning', text: 'thinking out loud' },
        { type: 'tool', tool: 'bash' },
        { type: 'text', text: 'the reply' },
        { type: 'step-finish' },
      ],
    }],
  }]);
  const [turn] = opencode.read(sessionFile(storage, 'p', 'ses_1'));
  assert.equal(turn.text, 'the reply');
  fs.rmSync(home, { recursive: true, force: true });
});

test('a synthetic part was generated, not said', () => {
  const { home, storage } = sandbox([{
    id: 'ses_1', project: 'p',
    messages: [{
      id: 'msg_1', role: 'user', created: 10,
      parts: [{ type: 'text', text: 'injected', synthetic: true }, { type: 'text', text: 'typed' }],
    }],
  }]);
  const [turn] = opencode.read(sessionFile(storage, 'p', 'ses_1'));
  assert.equal(turn.text, 'typed');
  fs.rmSync(home, { recursive: true, force: true });
});

test('turns come back in the order they happened', () => {
  // Directory listings are alphabetical, and these ids are not.
  const { home, storage } = sandbox([{
    id: 'ses_1', project: 'p',
    messages: [
      { id: 'msg_zzz', role: 'user', created: 10, parts: [{ type: 'text', text: 'asked first' }] },
      { id: 'msg_aaa', role: 'assistant', created: 20, parts: [{ type: 'text', text: 'answered second' }] },
    ],
  }]);
  const turns = opencode.read(sessionFile(storage, 'p', 'ses_1'));
  assert.deepEqual(turns.map((t) => t.text), ['asked first', 'answered second']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('a message with no text parts is not an empty turn', () => {
  const { home, storage } = sandbox([{
    id: 'ses_1', project: 'p',
    messages: [
      { id: 'msg_1', role: 'assistant', created: 10, parts: [{ type: 'tool', tool: 'bash' }] },
      { id: 'msg_2', role: 'user', created: 20, parts: [{ type: 'text', text: 'kept' }] },
    ],
  }]);
  assert.deepEqual(opencode.read(sessionFile(storage, 'p', 'ses_1')).map((t) => t.text), ['kept']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('a corrupt part costs that part, not the session', () => {
  const { home, storage } = sandbox([{
    id: 'ses_1', project: 'p',
    messages: [{ id: 'msg_1', role: 'user', created: 10, parts: [{ type: 'text', text: 'survives' }] }],
  }]);
  fs.writeFileSync(path.join(storage, 'part', 'msg_1', 'prt_broken.json'), '{ not json');
  assert.deepEqual(opencode.read(sessionFile(storage, 'p', 'ses_1')).map((t) => t.text), ['survives']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('a session whose messages are gone reads as empty, not as a crash', () => {
  const { home, storage } = sandbox([{ id: 'ses_1', project: 'p', messages: [] }]);
  assert.deepEqual(opencode.read(sessionFile(storage, 'p', 'ses_1')), []);
  fs.rmSync(home, { recursive: true, force: true });
});

test('an ongoing session is seen as changed when only its messages moved', () => {
  // The session file is rewritten on summary changes, but new messages land in
  // a sibling directory. Watching only the session file makes a live session
  // look untouched forever.
  const { home, storage } = sandbox([{
    id: 'ses_1', project: 'p',
    messages: [{ id: 'msg_1', role: 'user', created: 10, parts: [{ type: 'text', text: 'one' }] }],
  }]);
  const before = opencode.discover(storage)[0].mtime;
  const later = Date.now() + 60_000;
  fs.utimesSync(path.join(storage, 'message', 'ses_1'), later / 1000, later / 1000);
  const after = opencode.discover(storage)[0].mtime;
  assert.ok(after > before, 'a new message did not move the watermark');
  fs.rmSync(home, { recursive: true, force: true });
});

test('reads the real corpus when there is one here', (t) => {
  const found = opencode.detect();
  if (!found.present) {
    t.skip('no OpenCode history on this machine; the synthetic cases above still ran');
    return;
  }
  const sessions = opencode.discover(found.root);
  assert.ok(sessions.length > 0, 'a storage tree exists but no sessions were found');
  let total = 0;
  for (const s of sessions) {
    assert.match(s.sessionId, /^[A-Za-z0-9][A-Za-z0-9_-]*$/, `unusable id: ${s.sessionId}`);
    for (const turn of opencode.read(s.file)) {
      assert.ok(turn.role === 'user' || turn.role === 'assistant', `stray role ${turn.role}`);
      assert.ok(turn.text.trim(), 'an empty turn got through');
      total++;
    }
  }
  assert.ok(total > 0, 'sessions were found but every one of them read as empty');
});
