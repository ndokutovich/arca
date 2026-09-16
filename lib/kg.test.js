import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFacts } from './kg.js';

const facts = (t, opts) => extractFacts(t, opts);
const find = (fs, s, p) => fs.find((f) => f.subject === s && f.predicate === p);

test('associates a port with the entity it follows', () => {
  const f = facts('XTTS on port 8021, Kokoro at :8880, Silero native on port 8882.');
  assert.equal(find(f, 'xtts', 'runs_on_port')?.object, '8021');
  assert.equal(find(f, 'kokoro', 'runs_on_port')?.object, '8880');
  assert.equal(find(f, 'silero', 'runs_on_port')?.object, '8882');
});

test('requires explicit port context (no bare "on N")', () => {
  const f = facts('Docker ran on 1038 lines of output.');
  assert.equal(find(f, 'docker', 'runs_on_port'), undefined);
});

test('accepts software versions, rejects scores and section numbers', () => {
  assert.equal(find(facts('claude-code 2.8.0 shipped'), 'claude-code', 'has_version')?.object, '2.8.0');
  assert.equal(find(facts('torch==2.6.0 pinned'), 'torch', 'has_version')?.object, '2.6.0');
  // scores / learning rates / leaderboard floats — not versions
  assert.equal(find(facts('adamw 0.041 lr'), 'adamw', 'has_version'), undefined);
  assert.equal(find(facts('Kaggle 1.04290 score'), 'kaggle', 'has_version'), undefined);
  // single-dot without a v/== cue is ambiguous (section 2.3) — rejected
  assert.equal(find(facts('BABOK 2.3 reference'), 'babok', 'has_version'), undefined);
  // single-dot WITH a cue is accepted
  assert.equal(find(facts('upgraded to v3.4 today'), null, null), undefined); // no entity → nothing
});

test('known-gate drops facts about unrecognized subjects', () => {
  const known = new Set(['xtts']);
  const f = facts('Foobar on port 9001 and XTTS on port 8021', { known });
  assert.equal(find(f, 'xtts', 'runs_on_port')?.object, '8021');
  assert.equal(find(f, 'foobar', 'runs_on_port'), undefined);
});

test('gazetteer entities pass the gate even if not in known set', () => {
  const f = facts('Kokoro on port 8880', { known: new Set() });
  assert.equal(find(f, 'kokoro', 'runs_on_port')?.object, '8880');
});

test('extracts replaced_by transitions between recognized entities', () => {
  const f = facts('switched from Kokoro to XTTS for cloning');
  assert.equal(find(f, 'kokoro', 'replaced_by')?.object, 'xtts');
});

test('port range bounds enforced', () => {
  const f = facts('Service on port 80 and Other on port 70000');
  assert.equal(f.filter((x) => x.predicate === 'runs_on_port').length, 0);
});
