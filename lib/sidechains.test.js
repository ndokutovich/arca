// Subagent transcripts were excluded everywhere, on the reasoning that a
// sidechain is not a session. True for resuming, false for remembering: what
// an agent looked at and discarded reaches the main transcript only as a
// conclusion, and 6203 files of it were being dropped on the floor.
//
// They are archived and indexed now, and kept out of search results unless
// asked for. These tests hold both halves of that: that they arrive, and that
// they do not show up uninvited.
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTranscript, isSidechainFile, isArchivable } from './transcripts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(ROOT, 'hooks', 'session-vault.js');

test('a session is a transcript; a sidechain is not', () => {
  assert.equal(isTranscript('abc-123.jsonl'), true);
  assert.equal(isTranscript('agent-a7d67a0.jsonl'), false);
  assert.equal(isSidechainFile('agent-a7d67a0.jsonl'), true);
  assert.equal(isSidechainFile('abc-123.jsonl'), false);
});

test('both are archivable — what you cannot resume you may still want to search', () => {
  assert.equal(isArchivable('abc-123.jsonl'), true);
  assert.equal(isArchivable('agent-a7d67a0.jsonl'), true);
  assert.equal(isArchivable('notes.md'), false);
});

test('the hook copies sidechains into the vault', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-sidechain-'));
  const proj = path.join(home, '.claude', 'projects', 'demo');
  fs.mkdirSync(proj, { recursive: true });
  const line = (role, text) => JSON.stringify({
    type: role, message: { role, content: text },
    timestamp: '2026-09-21T10:00:00.000Z', sessionId: 's1', isSidechain: role === 'user' ? undefined : undefined,
  });
  fs.writeFileSync(path.join(proj, 'session-1.jsonl'), [line('user', 'hello'), line('assistant', 'hi')].join('\n'));
  fs.writeFileSync(path.join(proj, 'agent-deadbeef.jsonl'), [line('user', 'go look'), line('assistant', 'found it')].join('\n'));

  execFileSync(process.execPath, [HOOK], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    input: JSON.stringify({ session_id: 's1', cwd: home }),
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 60000,
  });

  const vault = path.join(home, '.claude-vault', 'demo');
  const copied = fs.existsSync(vault) ? fs.readdirSync(vault) : [];
  assert.ok(copied.includes('session-1.jsonl'), 'the session was not archived: ' + copied.join(', '));
  assert.ok(copied.includes('agent-deadbeef.jsonl'), 'the sidechain was dropped: ' + copied.join(', '));
  fs.rmSync(home, { recursive: true, force: true });
});

// The search half needs a database, so it gets its own home and its own
// import — DB_PATH is resolved when db.js first loads.
const searchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-sidechain-db-'));
fs.mkdirSync(path.join(searchHome, '.claude-vault', 'index'), { recursive: true });
process.env.HOME = searchHome;
process.env.USERPROFILE = searchHome;

const { upsertTurn, closeDb } = await import('./db.js');
const { search } = await import('./search.js');

const zeros = new Float32Array(384);
const row = (id, text, fromAgent) => ({
  id, project: 'demo', timestamp: '2026-09-21T10:00:00.000Z',
  promptText: text, replyText: text,
  transcriptPath: `/vault/demo/${fromAgent ? 'agent-x' : 'session-1'}.jsonl`,
  firstLine: 1, lastLine: 2, sessionId: 's1', cwd: '/demo',
  fromAgent, toolCalls: [], isNoise: false,
});

test('a sidechain answers only when asked for', async () => {
  // Distinct wording on purpose: identical text collapses on content hash,
  // which would make this a test of deduplication rather than of the filter.
  upsertTurn(row('main-1', 'peregrine falcon telemetry from the session', false), zeros);
  upsertTurn(row('side-1', 'peregrine falcon telemetry the agent gathered', true), zeros);

  const quiet = (await search('peregrine falcon telemetry', { mode: 'keyword', limit: 10 })).map(r => r.id);
  assert.ok(quiet.includes('main-1'), 'the session turn was lost');
  assert.ok(!quiet.includes('side-1'), 'a sidechain answered uninvited');

  const asked = (await search('peregrine falcon telemetry', { mode: 'keyword', limit: 10, includeAgents: true })).map(r => r.id);
  assert.ok(asked.includes('main-1'), 'the session turn was lost');
  assert.ok(asked.includes('side-1'), 'the sidechain stayed hidden although asked for');
});

test.after(() => {
  try { closeDb(); } catch { /* already shut */ }
  try { fs.rmSync(searchHome, { recursive: true, force: true }); } catch { /* Windows still holding it */ }
});
