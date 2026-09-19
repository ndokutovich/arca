// Cline's conversation is mostly tool traffic wrapped in scaffolding the
// extension re-injects on every single turn. Keep the scaffolding and one task
// puts the same paragraph in the corpus a dozen times; strip too much and the
// file it wrote goes with it.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cline from './cline.js';

const NL = String.fromCharCode(10);

function sandbox(tasks) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-cline-'));
  for (const t of tasks) {
    const dir = path.join(root, 'tasks', t.id);
    fs.mkdirSync(dir, { recursive: true });
    if (t.history !== null) {
      fs.writeFileSync(path.join(dir, 'api_conversation_history.json'), JSON.stringify(t.history || []));
    }
    if (t.ui) fs.writeFileSync(path.join(dir, 'ui_messages.json'), JSON.stringify(t.ui));
  }
  return root;
}

const msg = (role, ...texts) => ({
  role,
  content: texts.map((text) => ({ type: 'text', text })),
});

const ENV = `<environment_details>${NL}# VSCode Visible Files${NL}(none)${NL}Current Working Directory (w:/proj/app)${NL}</environment_details>`;
const TODO = `# TODO LIST RECOMMENDED${NL}When starting a new task, it is recommended to create a todo list.`;

test('the task wrapper comes off and the scaffolding goes', () => {
  const root = sandbox([{
    id: '1700000000000',
    history: [msg('user', `<task>${NL}build me tetris${NL}</task>`, TODO, ENV)],
  }]);
  const [turn] = cline.read(path.join(root, 'tasks', '1700000000000'));
  assert.equal(turn.text, 'build me tetris');
  fs.rmSync(root, { recursive: true, force: true });
});

test('the todo reminder is removed whole, not down to its first line', () => {
  // A lazy match under the multiline flag stops at the first line end and
  // leaves the rest of the reminder in every turn of every task.
  const root = sandbox([{
    id: '1700000000000',
    history: [msg('user', '<task>go</task>', TODO)],
  }]);
  const [turn] = cline.read(path.join(root, 'tasks', '1700000000000'));
  assert.doesNotMatch(turn.text, /recommended to create a todo list/);
  assert.equal(turn.text, 'go');
  fs.rmSync(root, { recursive: true, force: true });
});

test('tool traffic is kept, because the file it wrote is in it', () => {
  const root = sandbox([{
    id: '1700000000000',
    history: [
      msg('user', '<task>go</task>'),
      msg('assistant', `<write_to_file>${NL}<path>tetris.py</path>${NL}<content>import random</content>${NL}</write_to_file>`),
      msg('user', `[write_to_file for 'tetris.py'] Result: done`, ENV),
    ],
  }]);
  const turns = cline.read(path.join(root, 'tasks', '1700000000000'));
  assert.equal(turns.length, 3);
  assert.match(turns[1].text, /import random/);
  assert.match(turns[2].text, /write_to_file for/);
  assert.doesNotMatch(turns[2].text, /VSCode Visible Files/, 'the environment block survived');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a turn that was nothing but scaffolding is not a turn', () => {
  const root = sandbox([{
    id: '1700000000000',
    history: [msg('user', '<task>go</task>'), msg('user', TODO, ENV), msg('assistant', 'done')],
  }]);
  assert.deepEqual(cline.read(path.join(root, 'tasks', '1700000000000')).map((t) => t.text), ['go', 'done']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('timestamps come from the panel, by the index it records', () => {
  // api_conversation_history.json has no times at all. ui_messages.json has
  // one per entry and the history index it belongs to.
  const root = sandbox([{
    id: '1700000000000',
    history: [msg('user', '<task>go</task>'), msg('assistant', 'done')],
    ui: [
      { ts: 1700000005000, conversationHistoryIndex: 1 },
      { ts: 1700000001000, conversationHistoryIndex: 0 },
      { ts: 1700000009000, conversationHistoryIndex: 0 },
    ],
  }]);
  const turns = cline.read(path.join(root, 'tasks', '1700000000000'));
  assert.equal(turns[0].ts, new Date(1700000001000).toISOString(), 'the earliest entry for that index');
  assert.equal(turns[1].ts, new Date(1700000005000).toISOString());
  fs.rmSync(root, { recursive: true, force: true });
});

test('with no panel record the task start time is used', () => {
  const root = sandbox([{ id: '1700000000000', history: [msg('user', 'hi'), msg('assistant', 'hello')] }]);
  const [turn] = cline.read(path.join(root, 'tasks', '1700000000000'));
  assert.equal(turn.ts, new Date(1700000000000).toISOString());
  fs.rmSync(root, { recursive: true, force: true });
});

test('the working directory is taken from the line Cline writes about itself', () => {
  // There is no field for it anywhere; the conversation is the only source.
  const root = sandbox([{ id: '1700000000000', history: [msg('user', '<task>go</task>', ENV)] }]);
  const [s] = cline.discover(root);
  assert.equal(s.cwd, 'w:/proj/app');
  assert.equal(s.project, 'w--proj-app');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a task that never says where it ran is named as unknown', () => {
  const root = sandbox([{ id: '1700000000000', history: [msg('user', 'hi')] }]);
  const [s] = cline.discover(root);
  assert.equal(s.cwd, null);
  assert.equal(s.project, 'cline-unknown');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a task directory with no history is not a session', () => {
  const root = sandbox([{ id: '1700000000000', history: null }]);
  assert.deepEqual(cline.discover(root), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a corrupt history reads as empty rather than throwing', () => {
  const root = sandbox([{ id: '1700000000000', history: [] }]);
  fs.writeFileSync(path.join(root, 'tasks', '1700000000000', 'api_conversation_history.json'), '{ not json');
  assert.deepEqual(cline.read(path.join(root, 'tasks', '1700000000000')), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('absence is not an error', () => {
  const saved = process.env.ARCA_CLINE_DIR;
  try {
    process.env.ARCA_CLINE_DIR = path.join(os.tmpdir(), 'arca-no-cline-here');
    assert.equal(cline.detect().present, false);
  } finally {
    if (saved === undefined) delete process.env.ARCA_CLINE_DIR; else process.env.ARCA_CLINE_DIR = saved;
  }
});

test('reads the real corpus when there is one here', (t) => {
  const found = cline.detect();
  if (!found.present) {
    t.skip('no Cline data on this machine; the synthetic cases above still ran');
    return;
  }
  const sessions = cline.discover(found.root);
  assert.ok(sessions.length > 0, 'the extension directory exists but holds no tasks');
  let total = 0;
  for (const s of sessions) {
    for (const turn of cline.read(s.file)) {
      assert.ok(turn.role === 'user' || turn.role === 'assistant', `stray role ${turn.role}`);
      assert.ok(turn.text.trim(), 'an empty turn got through');
      assert.doesNotMatch(turn.text, /TODO LIST RECOMMENDED/, 'scaffolding reached the corpus');
      assert.doesNotMatch(turn.text, /<environment_details>/, 'scaffolding reached the corpus');
      total++;
    }
  }
  assert.ok(total > 0, 'tasks were found but every one of them read as empty');
});
