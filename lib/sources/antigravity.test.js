// Antigravity is the one source where the adapter makes a judgement rather
// than a translation: it never writes its replies to disk, so what gets paired
// with a request is what the session produced. That decision has to be visible
// and it has to be stable, because the alternative — passing the model's
// private reasoning off as its reply — would look identical in search results
// and be quietly wrong.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import antigravity from './antigravity.js';

const NL = String.fromCharCode(10);

function sandbox(sessions) {
  const brain = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-antigravity-'));
  for (const s of sessions) {
    const dir = path.join(brain, s.id);
    fs.mkdirSync(dir, { recursive: true });

    for (const [name, body] of Object.entries(s.artifacts || {})) {
      fs.writeFileSync(path.join(dir, name), body);
    }
    for (const [name, meta] of Object.entries(s.metadata || {})) {
      fs.writeFileSync(path.join(dir, `${name}.metadata.json`), JSON.stringify(meta));
    }
    if (s.transcript) {
      const logs = path.join(dir, '.system_generated', 'logs');
      fs.mkdirSync(logs, { recursive: true });
      fs.writeFileSync(
        path.join(logs, 'transcript.jsonl'),
        s.transcript.map((r) => JSON.stringify(r)).join(NL) + NL,
      );
    }
  }
  return brain;
}

const ask = (text, at = '2026-06-04T22:57:30Z') => ({
  step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE',
  created_at: at,
  content: `<USER_REQUEST>${NL}${text}${NL}</USER_REQUEST>${NL}<ADDITIONAL_METADATA>${NL}The current local time is: whatever.${NL}</ADDITIONAL_METADATA>`,
});

const thinking = () => ({
  step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE',
  created_at: '2026-06-04T22:57:31Z',
  thinking: 'I should probably start by reading the files.',
  tool_calls: [{ name: 'search_web', args: {} }],
});

test('the request is unwrapped and the metadata blocks are dropped', () => {
  const brain = sandbox([{
    id: 'ses-1',
    transcript: [ask('build me a game')],
    artifacts: { 'walkthrough.md': '# Done' },
  }]);
  const [turn] = antigravity.read(path.join(brain, 'ses-1'));
  assert.equal(turn.role, 'user');
  assert.equal(turn.text, 'build me a game', 'the wrappers came through');
  fs.rmSync(brain, { recursive: true, force: true });
});

test("the model's private reasoning is never passed off as its reply", () => {
  // A PLANNER_RESPONSE holds `thinking` and tool calls and no reply. Using
  // the thinking would look plausible in a search result and be wrong.
  const brain = sandbox([{
    id: 'ses-1',
    transcript: [ask('do the thing'), thinking()],
    artifacts: { 'walkthrough.md': '# What I did' },
  }]);
  const turns = antigravity.read(path.join(brain, 'ses-1'));
  const assistant = turns.find((t) => t.role === 'assistant');
  assert.ok(assistant, 'no assistant side at all');
  assert.doesNotMatch(assistant.text, /start by reading the files/, 'thinking leaked into the reply');
  assert.match(assistant.text, /What I did/);
  fs.rmSync(brain, { recursive: true, force: true });
});

test('the walkthrough leads, because it is the report', () => {
  const brain = sandbox([{
    id: 'ses-1',
    transcript: [ask('go')],
    artifacts: {
      'task.md': '# Tasks',
      'walkthrough.md': '# Overview',
      'implementation_plan.md': '# Plan',
    },
  }]);
  const assistant = antigravity.read(path.join(brain, 'ses-1')).find((t) => t.role === 'assistant');
  assert.ok(assistant.text.indexOf('Overview') < assistant.text.indexOf('Plan'));
  assert.ok(assistant.text.indexOf('Plan') < assistant.text.indexOf('Tasks'));
  fs.rmSync(brain, { recursive: true, force: true });
});

test('every request is kept, not just the last one', () => {
  // The documents belong to the session, not to any one ask, and a request
  // with nothing after it is dropped by the parser — so splitting them into
  // separate turns would lose all but the final question.
  const brain = sandbox([{
    id: 'ses-1',
    transcript: [ask('first ask'), thinking(), ask('second ask'), ask('third ask')],
    artifacts: { 'walkthrough.md': '# Done' },
  }]);
  const [user] = antigravity.read(path.join(brain, 'ses-1'));
  for (const text of ['first ask', 'second ask', 'third ask']) {
    assert.match(user.text, new RegExp(text), `${text} was lost`);
  }
  fs.rmSync(brain, { recursive: true, force: true });
});

test('a session with documents and no transcript is labelled, not invented', () => {
  // Without a user side the parser drops the turn and every word of the
  // work with it. The label has to read as a label.
  const brain = sandbox([{
    id: 'ses-2',
    artifacts: { 'walkthrough.md': '# Fixes' },
    metadata: { 'walkthrough.md': { summary: 'Walkthrough of the completed fixes.' } },
  }]);
  const turns = antigravity.read(path.join(brain, 'ses-2'));
  assert.equal(turns.length, 2);
  assert.match(turns[0].text, /^Antigravity session ses-2: Walkthrough of the completed fixes\.$/);
  assert.match(turns[1].text, /Fixes/);
  fs.rmSync(brain, { recursive: true, force: true });
});

test('an earlier version of a document is not mistaken for the current one', () => {
  const brain = sandbox([{
    id: 'ses-1',
    transcript: [ask('go')],
    artifacts: {
      'walkthrough.md': '# the current text',
      'walkthrough.md.resolved': '# a stale copy',
      'walkthrough.md.resolved.0': '# an older stale copy',
    },
  }]);
  const assistant = antigravity.read(path.join(brain, 'ses-1')).find((t) => t.role === 'assistant');
  assert.match(assistant.text, /the current text/);
  assert.doesNotMatch(assistant.text, /stale copy/);
  fs.rmSync(brain, { recursive: true, force: true });
});

test('an empty session yields nothing rather than an empty turn', () => {
  const brain = sandbox([{ id: 'ses-3' }]);
  assert.deepEqual(antigravity.read(path.join(brain, 'ses-3')), []);
  fs.rmSync(brain, { recursive: true, force: true });
});

test('a corrupt transcript line costs that line', () => {
  const brain = sandbox([{
    id: 'ses-1',
    transcript: [ask('before')],
    artifacts: { 'walkthrough.md': '# Done' },
  }]);
  const log = path.join(brain, 'ses-1', '.system_generated', 'logs', 'transcript.jsonl');
  fs.appendFileSync(log, '{"type":"USER_INP' + NL + JSON.stringify(ask('after')) + NL);
  const [user] = antigravity.read(path.join(brain, 'ses-1'));
  assert.match(user.text, /before/);
  assert.match(user.text, /after/);
  fs.rmSync(brain, { recursive: true, force: true });
});

test('sessions are filed under antigravity, with no invented project', () => {
  // There is no working directory anywhere in the data; guessing one would put
  // this work inside a project it has nothing to do with.
  const brain = sandbox([{ id: 'ses-1', artifacts: { 'walkthrough.md': '# x' } }]);
  const [s] = antigravity.discover(brain);
  assert.equal(s.project, 'antigravity');
  assert.equal(s.cwd, null);
  assert.equal(s.sessionId, 'ses-1');
  fs.rmSync(brain, { recursive: true, force: true });
});

test('absence is not an error', () => {
  const saved = process.env.ARCA_ANTIGRAVITY_DIR;
  try {
    process.env.ARCA_ANTIGRAVITY_DIR = path.join(os.tmpdir(), 'arca-no-antigravity-here');
    assert.equal(antigravity.detect().present, false);
  } finally {
    if (saved === undefined) delete process.env.ARCA_ANTIGRAVITY_DIR;
    else process.env.ARCA_ANTIGRAVITY_DIR = saved;
  }
});

test('reads the real corpus when there is one here', (t) => {
  const found = antigravity.detect();
  if (!found.present) {
    t.skip('no Antigravity data on this machine; the synthetic cases above still ran');
    return;
  }
  const sessions = antigravity.discover(found.root);
  if (!sessions.length) {
    t.skip('the brain directory exists but is empty');
    return;
  }
  for (const s of sessions) {
    const turns = antigravity.read(s.file);
    for (const turn of turns) {
      assert.ok(turn.role === 'user' || turn.role === 'assistant', `stray role ${turn.role}`);
      assert.ok(turn.text.trim(), 'an empty turn got through');
    }
    if (turns.length) {
      assert.equal(turns[0].role, 'user', 'a session must open with the user side or it is dropped');
    }
  }
});
