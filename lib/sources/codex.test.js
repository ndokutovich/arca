// The Codex adapter decides what counts as a turn in someone else's
// transcript. Getting that wrong does not throw — it silently indexes tool
// output as conversation, or drops half the dialogue, and the only symptom is
// that search answers slightly worse than it should.
//
// Synthetic fixtures below, shaped from real files under ~/.codex/sessions.
// The last test runs against those real files when they are there and skips
// honestly when they are not.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import codex from './codex.js';

const NL = String.fromCharCode(10);

function sandbox(lines, { dir = '2026/01/02' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-codex-'));
  const sessions = path.join(home, 'sessions', ...dir.split('/'));
  fs.mkdirSync(sessions, { recursive: true });
  const file = path.join(sessions, 'rollout-2026-01-02T10-00-00-abc.jsonl');
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join(NL) + NL);
  return { home, file };
}

const meta = (cwd = 'w:' + String.fromCharCode(92) + 'app') => ({
  timestamp: '2026-01-02T10:00:00.000Z',
  type: 'session_meta',
  payload: { id: 'sess-1', cwd, timestamp: '2026-01-02T10:00:00.000Z' },
});

const msg = (role, text, ts = '2026-01-02T10:00:01.000Z') => ({
  timestamp: ts,
  type: 'response_item',
  payload: {
    type: 'message',
    role,
    content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
  },
});

test('detect finds a codex directory and reports absence quietly', () => {
  const { home } = sandbox([meta(), msg('user', 'hi')]);
  const saved = process.env.ARCA_CODEX_DIR;
  try {
    process.env.ARCA_CODEX_DIR = home;
    assert.equal(codex.detect().present, true);
    process.env.ARCA_CODEX_DIR = path.join(home, 'nowhere');
    const absent = codex.detect();
    assert.equal(absent.present, false, 'a provider that is not installed is not an error');
    assert.equal(absent.root, null);
  } finally {
    if (saved === undefined) delete process.env.ARCA_CODEX_DIR; else process.env.ARCA_CODEX_DIR = saved;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('discovery takes the id and cwd from session_meta', () => {
  const { home } = sandbox([meta(), msg('user', 'hi')]);
  const [s] = codex.discover(home);
  assert.equal(s.sessionId, 'sess-1');
  assert.equal(s.cwd, 'w:' + String.fromCharCode(92) + 'app');
  // The same rule Claude Code uses for its own directory names, so a Codex
  // session and a Claude session in one place land in one project.
  assert.equal(s.project, 'w--app');
  fs.rmSync(home, { recursive: true, force: true });
});

test('a session with no session_meta is skipped, not invented', () => {
  // Naming it after the file would mint a session id nothing else shares.
  const { home } = sandbox([msg('user', 'orphan')]);
  assert.deepEqual(codex.discover(home), []);
  fs.rmSync(home, { recursive: true, force: true });
});

test('user and assistant turns are read, in order', () => {
  const { home, file } = sandbox([
    meta(),
    msg('user', 'first'),
    msg('assistant', 'second'),
    msg('user', 'third'),
  ]);
  const turns = codex.read(file);
  assert.deepEqual(turns.map((t) => [t.role, t.text]), [
    ['user', 'first'], ['assistant', 'second'], ['user', 'third'],
  ]);
  fs.rmSync(home, { recursive: true, force: true });
});

test('developer turns are protocol and are not conversation', () => {
  // Sandbox policy and base instructions. Codex never shows them as a turn.
  const { home, file } = sandbox([
    meta(),
    msg('developer', '<permissions instructions> ...'),
    msg('user', 'real'),
  ]);
  assert.deepEqual(codex.read(file).map((t) => t.text), ['real']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('the event stream is not read twice', () => {
  // event_msg/agent_message duplicates every assistant turn that
  // response_item/message already carries. Reading both doubles the corpus.
  const { home, file } = sandbox([
    meta(),
    msg('assistant', 'said once'),
    { timestamp: '2026-01-02T10:00:02.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'said once' } },
  ]);
  assert.equal(codex.read(file).length, 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test('tool calls and reasoning are not conversation', () => {
  const { home, file } = sandbox([
    meta(),
    { timestamp: '2026-01-02T10:00:01.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell' } },
    { timestamp: '2026-01-02T10:00:02.000Z', type: 'response_item', payload: { type: 'function_call_output', output: 'x' } },
    { timestamp: '2026-01-02T10:00:03.000Z', type: 'response_item', payload: { type: 'reasoning', summary: [] } },
    msg('user', 'the only turn'),
  ]);
  assert.deepEqual(codex.read(file).map((t) => t.text), ['the only turn']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('a malformed line costs only that line', () => {
  const { home, file } = sandbox([
    meta(),
    msg('user', 'before'),
    '{"type":"response_item","payload":{"type":"mess',
    msg('assistant', 'after'),
  ]);
  assert.deepEqual(codex.read(file).map((t) => t.text), ['before', 'after']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('empty content is not a turn', () => {
  const { home, file } = sandbox([meta(), msg('user', '   '), msg('assistant', 'kept')]);
  assert.deepEqual(codex.read(file).map((t) => t.text), ['kept']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('a turn longer than the read buffer survives', () => {
  // read() works in 1 MB chunks, and single lines in this corpus exceed that.
  // A naive chunk loop splits the line and loses both halves.
  const long = 'x'.repeat(3 * 1024 * 1024);
  const { home, file } = sandbox([meta(), msg('user', long), msg('assistant', 'after')]);
  const turns = codex.read(file);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].text.length, long.length, 'the long turn came back truncated');
  assert.equal(turns[1].text, 'after', 'and the line after it was lost');
  fs.rmSync(home, { recursive: true, force: true });
});

test('multibyte text is not cut at a chunk boundary', () => {
  // Buffer.toString on a chunk edge splits a UTF-8 sequence in half and yields
  // a replacement character on each side. Whether that happens depends on the
  // exact byte offset, so guessing a padding length proves nothing — the first
  // version of this test passed against a reader that had no decoder at all.
  // Measure where the text actually lands and place it on the seam.
  const CHUNK = 1024 * 1024;
  const tail = 'привет — ёж 🔥';
  const tailBytes = Buffer.from(tail, 'utf8');

  // One probe run to learn how many bytes precede the padding.
  const probe = sandbox([meta(), msg('user', 'PAD' + tail)]);
  const raw = fs.readFileSync(probe.file);
  const padStart = raw.indexOf(tailBytes) - 3;
  fs.rmSync(probe.home, { recursive: true, force: true });
  assert.ok(padStart > 0, 'could not locate the payload in the probe file');

  let straddled = false;
  for (let delta = -4; delta <= 4; delta++) {
    const padLen = CHUNK - padStart + delta;
    const { home, file } = sandbox([meta(), msg('user', 'a'.repeat(padLen) + tail)]);
    try {
      const at = fs.readFileSync(file).indexOf(tailBytes);
      // A character of this string crosses the seam when it starts before the
      // boundary and ends after it.
      if (at < CHUNK && at + tailBytes.length > CHUNK) straddled = true;
      const [turn] = codex.read(file);
      assert.ok(turn, `nothing read at delta ${delta}`);
      assert.ok(
        turn.text.endsWith(tail),
        `delta ${delta}: tail came back as ${JSON.stringify(turn.text.slice(-20))}`,
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
  // Without this the whole test can pass by never touching the boundary.
  assert.ok(straddled, 'no case actually placed a character across the chunk edge');
});

test('reads the real corpus when there is one here', (t) => {
  const found = codex.detect();
  if (!found.present) {
    t.skip('no Codex history on this machine; the synthetic cases above still ran');
    return;
  }
  const sessions = codex.discover(found.root);
  assert.ok(sessions.length > 0, 'a codex directory exists but no sessions were found');
  for (const s of sessions) {
    assert.match(s.sessionId, /^[A-Za-z0-9][A-Za-z0-9_-]*$/, `unusable session id: ${s.sessionId}`);
    assert.ok(s.project, `no project for ${s.file}`);
  }
  // One real file, read end to end.
  const biggest = sessions
    .map((s) => ({ s, bytes: (() => { try { return fs.statSync(s.file).size; } catch { return 0; } })() }))
    .sort((a, b) => b.bytes - a.bytes)[0];
  const turns = codex.read(biggest.s.file);
  for (const turn of turns) {
    assert.ok(turn.role === 'user' || turn.role === 'assistant', `stray role ${turn.role}`);
    assert.ok(turn.text.trim(), 'an empty turn got through');
    assert.ok(turn.ts, 'a turn with no timestamp');
  }
});
