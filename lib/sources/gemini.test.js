// Gemini CLI writes something other than what its own fixture files describe.
// The fixtures next to the real data have a `role` field and a uniform content
// object; the CLI writes a `type` field, an array for the user and a bare
// string for itself. An adapter built from the fixture reads every real
// session as empty — and reports success doing it.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import gemini from './gemini.js';

const BS = String.fromCharCode(92);

function sandbox({ projects = {}, sessions = [] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-gemini-'));
  fs.mkdirSync(path.join(home, 'tmp'), { recursive: true });
  if (projects) {
    fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ projects }));
  }
  for (const s of sessions) {
    const chats = path.join(home, 'tmp', s.dir, 'chats');
    fs.mkdirSync(chats, { recursive: true });
    fs.writeFileSync(path.join(chats, `session-${s.id}.json`), JSON.stringify({
      sessionId: s.id,
      startTime: '2026-04-11T01:00:00Z',
      messages: s.messages,
    }));
  }
  return home;
}

const user = (text) => ({ id: 'm', type: 'user', content: [{ text }], timestamp: '2026-04-11T01:00:01Z' });
const model = (text) => ({ id: 'm', type: 'gemini', content: text, timestamp: '2026-04-11T01:00:02Z' });

test('the user speaks in blocks and Gemini speaks in a string', () => {
  const home = sandbox({
    sessions: [{ dir: 'app', id: 'a1', messages: [user('a question'), model('an answer')] }],
  });
  const file = path.join(home, 'tmp', 'app', 'chats', 'session-a1.json');
  assert.deepEqual(gemini.read(file).map((t) => [t.role, t.text]), [
    ['user', 'a question'], ['assistant', 'an answer'],
  ]);
  fs.rmSync(home, { recursive: true, force: true });
});

test('a message with neither type nor a known role is not a turn', () => {
  const home = sandbox({
    sessions: [{
      dir: 'app', id: 'a1',
      messages: [{ id: 'x', type: 'tool', content: 'ran something' }, model('kept')],
    }],
  });
  const file = path.join(home, 'tmp', 'app', 'chats', 'session-a1.json');
  assert.deepEqual(gemini.read(file).map((t) => t.text), ['kept']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('the fixture shape is read too, since it sits in the same directory', () => {
  // `role` with an object content is what the shipped test sessions look like.
  const home = sandbox({
    sessions: [{
      dir: 'app', id: 'a1',
      messages: [
        { id: 'm1', role: 'user', content: { type: 'text', text: 'from a fixture' } },
        { id: 'm2', role: 'model', content: { type: 'text', text: 'and its reply' } },
      ],
    }],
  });
  const file = path.join(home, 'tmp', 'app', 'chats', 'session-a1.json');
  assert.deepEqual(gemini.read(file).map((t) => [t.role, t.text]), [
    ['user', 'from a fixture'], ['assistant', 'and its reply'],
  ]);
  fs.rmSync(home, { recursive: true, force: true });
});

test('the short directory name is resolved back to a working directory', () => {
  // Without this a Gemini session can never share a project with a Claude Code
  // one, because the two would be keyed on different things entirely.
  const home = sandbox({
    projects: { [`w:${BS}_proj${BS}app`]: 'app' },
    sessions: [{ dir: 'app', id: 'a1', messages: [user('hi')] }],
  });
  const [s] = gemini.discover(home);
  assert.equal(s.cwd, `w:${BS}_proj${BS}app`);
  assert.equal(s.project, 'w---proj-app');
  fs.rmSync(home, { recursive: true, force: true });
});

test('an unmapped directory is named as unmapped, not guessed at', () => {
  // Guessing would merge unrelated work into a real project under a name that
  // looks authoritative.
  const home = sandbox({
    projects: {},
    sessions: [{ dir: 'deadbeef', id: 'a1', messages: [user('hi')] }],
  });
  const [s] = gemini.discover(home);
  assert.equal(s.cwd, null);
  assert.equal(s.project, 'gemini-deadbeef');
  fs.rmSync(home, { recursive: true, force: true });
});

test('a missing projects.json costs the mapping, not the import', () => {
  const home = sandbox({ sessions: [{ dir: 'app', id: 'a1', messages: [user('hi')] }] });
  fs.rmSync(path.join(home, 'projects.json'));
  const [s] = gemini.discover(home);
  assert.equal(s.sessionId, 'a1');
  assert.equal(s.project, 'gemini-app');
  fs.rmSync(home, { recursive: true, force: true });
});

test('a corrupt session is skipped, not fatal', () => {
  const home = sandbox({ sessions: [{ dir: 'app', id: 'good', messages: [user('hi'), model('there')] }] });
  fs.writeFileSync(path.join(home, 'tmp', 'app', 'chats', 'session-bad.json'), '{ not json');
  const found = gemini.discover(home);
  assert.deepEqual(found.map((s) => s.sessionId), ['good']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('absence is not an error', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-gemini-'));
  const saved = process.env.ARCA_GEMINI_DIR;
  try {
    process.env.ARCA_GEMINI_DIR = home;
    assert.equal(gemini.detect().present, false);
  } finally {
    if (saved === undefined) delete process.env.ARCA_GEMINI_DIR; else process.env.ARCA_GEMINI_DIR = saved;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('reads the real corpus when there is one here', (t) => {
  const found = gemini.detect();
  if (!found.present) {
    t.skip('no Gemini history on this machine; the synthetic cases above still ran');
    return;
  }
  const sessions = gemini.discover(found.root);
  if (!sessions.length) {
    t.skip('a .gemini directory exists but holds no sessions');
    return;
  }
  let total = 0;
  for (const s of sessions) {
    for (const turn of gemini.read(s.file)) {
      assert.ok(turn.role === 'user' || turn.role === 'assistant', `stray role ${turn.role}`);
      assert.ok(turn.text.trim(), 'an empty turn got through');
      total++;
    }
  }
  assert.ok(total > 0, 'sessions were found but every one of them read as empty');
});
