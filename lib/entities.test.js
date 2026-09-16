import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractEntities, normalizeKey } from './entities.js';

const keys = (t) => new Set(extractEntities(t).map((e) => e.key));
const has = (t, k) => keys(t).has(k);

test('catches shape-pattern entities', () => {
  const k = keys('XTTS-v2 on ChromaDB and sqlite-vec via WebSocket, OmniSVG render');
  for (const e of ['xtts-v2', 'chromadb', 'sqlite-vec', 'websocket', 'omnisvg']) {
    assert.ok(k.has(e), `missing ${e}`);
  }
});

test('catches plain-capitalized gazetteer names the shapes miss', () => {
  const k = keys('Docker and Kokoro and Silero and Whisper and Prisma and Remotion');
  for (const e of ['docker', 'kokoro', 'silero', 'whisper', 'prisma', 'remotion']) {
    assert.ok(k.has(e), `missing ${e}`);
  }
});

test('keeps gazetteer-anchored lowercase hyphenated product names', () => {
  // anchored by a gazetteer segment (docker, sqlite) or exact gazetteer membership
  const k = keys('claude-code and docker-compose and better-sqlite3 and sqlite-vec');
  for (const e of ['claude-code', 'docker-compose', 'better-sqlite3', 'sqlite-vec']) {
    assert.ok(k.has(e), `dropped real product ${e}`);
  }
});

test('keeps capitalized novel hyphenated names (Git-Bash) but drops all-lowercase phrases', () => {
  assert.ok(has('I use Git-Bash on Windows', 'git-bash'), 'dropped Git-Bash');
  assert.ok(!has('a copy-paste of the work', 'copy-paste'), 'kept lowercase phrase');
});

test('keeps real LLM models with letter-digit shape', () => {
  assert.ok(has('we tried GPT-5 and o3', 'gpt-5'));
});

test('rejects hyphenated English phrases', () => {
  const noise = ['end-to-end', 'self-hosted', 'production-ready', 'open-source',
    'anti-patterns', 'near-duplicate', 'one-paragraph', 'property-based',
    'side-by-side', 'read-only', 'evidence-based', 'ai-powered'];
  const k = keys('This is ' + noise.join(' and ') + ' work.');
  for (const n of noise) assert.ok(!k.has(n), `leaked phrase ${n}`);
});

test('rejects doc/requirement refs but not real models', () => {
  const k = keys('FR-1 and N-1 and T-2 violate the spec; use GPT-4 instead');
  for (const ref of ['fr-1', 'n-1', 't-2']) assert.ok(!k.has(ref), `leaked ref ${ref}`);
  assert.ok(k.has('gpt-4'), 'dropped real model gpt-4');
});

test('rejects generic acronyms and common words', () => {
  const k = keys('The API and the UI and JSON and HTML, OK? README says so.');
  for (const n of ['api', 'ui', 'json', 'html', 'the', 'ok', 'readme']) {
    assert.ok(!k.has(n), `leaked generic ${n}`);
  }
});

test('strips fenced code blocks', () => {
  const k = keys('Real Docker here.\n```\nconst FooBar = new BazQux();\n```\n');
  assert.ok(k.has('docker'));
  assert.ok(!k.has('foobar') && !k.has('bazqux'), 'extracted from code block');
});

test('normalizeKey lowercases and trims punctuation, keeps code suffixes', () => {
  assert.equal(normalizeKey('  XTTS-v2.  '), 'xtts-v2');
  assert.equal(normalizeKey('voice.sh'), 'voice.sh');
  assert.equal(normalizeKey('(Docker)'), 'docker');
});
