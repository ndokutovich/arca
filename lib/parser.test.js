// parseTranscript had no test of its own. It is called only by the indexers, so
// every rename inside it — and there were many — could go wrong with the suite
// still green. A user line followed by a reply is the whole job; these hold it.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTranscript } from './parser.js';

const write = (lines) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-parser-'));
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'));
  return file;
};

const user = (text, extra = {}) => ({
  type: 'user', message: { role: 'user', content: text },
  timestamp: '2026-10-01T10:00:00.000Z', ...extra,
});
const assistant = (text, extra = {}) => ({
  type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] },
  timestamp: '2026-10-01T10:00:05.000Z', ...extra,
});

test('a question and its reply become one turn', async () => {
  const file = write([user('a question'), assistant('an answer')]);
  const turns = await parseTranscript(file, 'demo');
  assert.equal(turns.length, 1);
  const [t] = turns;
  assert.equal(t.promptText, 'a question');
  assert.equal(t.replyText, 'an answer');
  assert.equal(t.transcriptPath, file);
  assert.equal(t.project, 'demo');
  assert.equal(t.firstLine, 1);
  assert.equal(t.lastLine, 2);
});

test('the wire fields survive under this repository\'s names', async () => {
  const file = write([
    user('q', { sessionId: 's1', cwd: '/demo', gitBranch: 'main' }),
    assistant('a', { sessionId: 's1', cwd: '/demo', gitBranch: 'main' }),
  ]);
  const [t] = await parseTranscript(file, 'demo');
  assert.equal(t.sessionId, 's1');
  assert.equal(t.cwd, '/demo');
  assert.equal(t.branch, 'main', 'parsed.gitBranch landed on the wrong key');
  assert.equal(t.fromAgent, false, 'parsed.isSidechain landed on the wrong key');
  assert.equal(t.source, 'claude_code');
});

test('the same file parses to the same ids', async () => {
  const file = write([user('q'), assistant('a')]);
  const first = await parseTranscript(file, 'demo');
  const second = await parseTranscript(file, 'demo');
  assert.deepEqual(first.map((t) => t.id), second.map((t) => t.id));
  assert.equal(first[0].bodyHash.length, 32);
});

test('a subagent transcript is marked as one', async () => {
  const file = write([user('q', { isSidechain: true }), assistant('a')]);
  const [t] = await parseTranscript(file, 'demo');
  assert.equal(t.fromAgent, true);
});

test('a question with no reply is not a turn', async () => {
  const file = write([user('q')]);
  const turns = await parseTranscript(file, 'demo');
  assert.equal(turns.length, 0, 'a turn with no reply is not a turn');
});
