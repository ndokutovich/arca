// The list exists to be trusted at a glance: a title that says the wrong thing
// sends someone into the wrong session, and a missing row hides a conversation
// that is still there. So the tests are about the ladder, the noise filter, and
// the two ways rows can go wrong — twins from the vault, and a limit that
// silently reads everything.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSessions, extractMeta, NOISE } from './sessions.js';

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-sessions-'));
  return { root, cache: path.join(root, '.cache.json') };
}

const user = (text, extra = {}) => ({ type: 'user', message: { role: 'user', content: text }, ...extra });
const assistant = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

function writeSession(root, slug, id, lines, mtime) {
  const dir = path.join(root, slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  if (mtime) fs.utimesSync(file, new Date(mtime), new Date(mtime));
  return file;
}

const run = (root, cache, opts = {}) => listSessions({ root, cache, ...opts });

test('a manual rename beats the generated title, which beats the summary', async () => {
  const { root, cache } = sandbox();
  writeSession(root, 'p-a', 's1', [
    user('первый вопрос'),
    { type: 'summary', summary: 'generated summary' },
    { type: 'ai-title', aiTitle: 'generated title' },
    { type: 'custom-title', customTitle: 'my own name' },
  ]);

  const [row] = await run(root, cache);
  assert.equal(row.title, 'my own name');
  assert.equal(row.lastPrompt, 'первый вопрос');
});

test('the ladder falls through: ai-title, then summary, then the first prompt', async () => {
  const { root, cache } = sandbox();
  writeSession(root, 'p-a', 's-ai', [user('q'), { type: 'ai-title', aiTitle: 'from ai' }]);
  writeSession(root, 'p-a', 's-sum', [user('q'), { type: 'summary', summary: 'from summary' }]);
  writeSession(root, 'p-a', 's-plain', [user('just a question')]);

  const rows = await run(root, cache);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.title]));
  assert.equal(byId['s-ai'], 'from ai');
  assert.equal(byId['s-sum'], 'from summary');
  assert.equal(byId['s-plain'], 'just a question');
});

test('the last rename in the file wins, not the first', async () => {
  const { root, cache } = sandbox();
  writeSession(root, 'p-a', 's1', [
    { type: 'custom-title', customTitle: 'old name' },
    user('q'),
    { type: 'custom-title', customTitle: 'new name' },
  ]);
  const [row] = await run(root, cache);
  assert.equal(row.title, 'new name');
});

test('slash-command echoes, task notifications and meta never become a title', async () => {
  const { root, cache } = sandbox();
  NOISE.forEach((prefix, i) => {
    writeSession(root, 'p-noise', `n-${i}`, [user(`${prefix}>something`), user('a real question')]);
  });
  writeSession(root, 'p-noise', 'meta', [user('hidden', { isMeta: true }), user('a real question')]);
  writeSession(root, 'p-noise', 'compacted', [
    user('a summary of the past', { isCompactSummary: true }),
    user('a real question'),
  ]);

  const rows = await run(root, cache, { project: 'p-noise' });
  assert.equal(rows.length, NOISE.length + 2);
  for (const r of rows) assert.equal(r.title, 'a real question', `wrong title for ${r.id}`);
});

test('a small transcript still reports its last prompt', async () => {
  const { root, cache } = sandbox();
  writeSession(root, 'p-a', 's1', [user('first'), assistant('ok'), user('second')]);
  const [row] = await run(root, cache);
  assert.equal(row.title, 'first');
  assert.equal(row.lastPrompt, 'second');
});

test('a transcript larger than one chunk is read from both ends', async () => {
  const { root } = sandbox();
  const filler = 'x'.repeat(4000);
  const bulk = Array.from({ length: 12 }, (_, i) => assistant(`${i} ${filler}`));
  const file = writeSession(root, 'p-big', 's1', [
    user('the opening question'),
    ...bulk,
    user('the closing question'),
  ]);
  assert.ok(fs.statSync(file).size > 32 * 1024, 'fixture must exceed one chunk');

  const meta = await extractMeta(file);
  assert.equal(meta.title, 'the opening question');
  assert.equal(meta.lastPrompt, 'the closing question');
});

test('a long session ending in tool chatter still finds its last prompt', async () => {
  const { root } = sandbox();
  const filler = 'y'.repeat(4000);
  // The last user line sits past one chunk, but inside the wider window.
  const lines = [user('the real closing question'), ...Array.from({ length: 20 }, (_, i) => assistant(`${i} ${filler}`))];
  const file = writeSession(root, 'p', 'long', lines);
  const size = fs.statSync(file).size;
  assert.ok(size > 32 * 1024 && size < 256 * 1024, 'fixture must sit between the two windows');

  const meta = await extractMeta(file);
  assert.equal(meta.lastPrompt, 'the real closing question');
});

test('a session with no user records at all has no last prompt, and says so', async () => {
  const { root, cache } = sandbox();
  const filler = 'z'.repeat(4000);
  writeSession(root, 'p', 'no-user', Array.from({ length: 12 }, (_, i) => assistant(`${i} ${filler}`)));
  const [row] = await run(root, cache);
  assert.equal(row.lastPrompt, '');
  assert.equal(row.title, '(no title)');
});

test('the wider window is bounded: a prompt further back than the cap stays unfound', async () => {
  const { root } = sandbox();
  const filler = 'w'.repeat(8000);
  const lines = [user('too far back to find'), ...Array.from({ length: 40 }, (_, i) => assistant(`${i} ${filler}`))];
  const file = writeSession(root, 'p', 'huge', lines);
  assert.ok(fs.statSync(file).size > 256 * 1024, 'fixture must exceed the cap');

  const meta = await extractMeta(file);
  assert.equal(meta.lastPrompt, undefined);
  assert.equal(meta.title, 'too far back to find');
});

test('cwd is taken from the transcript, not guessed from the directory name', async () => {
  const { root, cache } = sandbox();
  writeSession(root, 'w---proj--x', 's1', [{ ...user('q'), cwd: 'w:\\_proj\\x' }]);
  const [row] = await run(root, cache);
  assert.equal(row.cwd, 'w:\\_proj\\x');
  assert.equal(row.slug, 'w---proj--x');
  assert.equal(row.file, path.join(root, 'w---proj--x', 's1.jsonl'));
});

test('filters: project, query, since, and limit', async () => {
  const { root, cache } = sandbox();
  const t = Date.UTC(2026, 0, 10);
  writeSession(root, 'proj-alpha', 'a1', [user('about jira')], t);
  writeSession(root, 'proj-alpha', 'a2', [user('about docker')], t + 1000);
  writeSession(root, 'proj-beta', 'b1', [user('jira again')], t + 2000);

  assert.equal((await run(root, cache)).length, 3);
  assert.deepEqual((await run(root, cache, { project: 'alpha' })).map((r) => r.id).sort(), ['a1', 'a2']);
  assert.deepEqual((await run(root, cache, { query: 'jira' })).map((r) => r.id).sort(), ['a1', 'b1']);
  assert.deepEqual((await run(root, cache, { since: new Date(t + 1500) })).map((r) => r.id), ['b1']);
  assert.deepEqual((await run(root, cache, { limit: 1 })).map((r) => r.id), ['b1']);
});

test('query matches the id as well as the title', async () => {
  const { root, cache } = sandbox();
  writeSession(root, 'p', '0f3a9c11-aaaa', [user('unrelated')]);
  writeSession(root, 'p', 'bbbb', [user('unrelated too')]);
  const rows = await run(root, cache, { query: '0f3a9c11' });
  assert.equal(rows.length, 1);
});

test('archived sessions are listed once, live winning over the vault copy', async () => {
  const { root, cache } = sandbox();
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-sessions-vault-'));
  writeSession(root, 'p', 'twin', [user('live copy')]);
  writeSession(vault, 'p', 'twin', [user('vault copy')]);
  writeSession(vault, 'p', 'only-vault', [user('gone from live')]);

  const live = await run(root, cache);
  assert.equal(live.length, 1, 'archived rows must not appear unless asked for');

  const rows = await run(root, cache, { archived: true, vault });
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(rows.length, 2);
  assert.equal(byId.twin.source, 'live');
  assert.equal(byId.twin.alsoArchived, true);
  assert.equal(byId.twin.title, 'live copy');
  assert.equal(byId['only-vault'].source, 'archived');
  assert.equal(byId['only-vault'].alsoArchived, undefined);
});

test('subagent sidechains are excluded unless agents is asked for', async () => {
  const { root, cache } = sandbox();
  writeSession(root, 'p', 'main', [user('the session')]);
  writeSession(root, 'p', 'agent-a1b2c3', [user('the subagent')]);

  assert.deepEqual((await run(root, cache)).map((r) => r.id), ['main']);
  assert.deepEqual((await run(root, cache, { agents: true })).map((r) => r.id).sort(), ['agent-a1b2c3', 'main']);
});

test('a fresh cache entry is used instead of rereading the transcript', async () => {
  const { root, cache } = sandbox();
  const file = writeSession(root, 'p', 's1', [user('from the file')]);
  const st = fs.statSync(file);
  fs.writeFileSync(cache, JSON.stringify({
    [file]: { key: `${st.mtimeMs}:${st.size}`, title: 'from the cache', lastPrompt: '', cwd: '' },
  }));

  const [row] = await run(root, cache);
  assert.equal(row.title, 'from the cache');
});

test('a stale cache entry is ignored and rewritten', async () => {
  const { root, cache } = sandbox();
  const file = writeSession(root, 'p', 's1', [user('from the file')]);
  fs.writeFileSync(cache, JSON.stringify({
    [file]: { key: '0:0', title: 'stale', lastPrompt: '', cwd: '' },
  }));

  const [row] = await run(root, cache);
  assert.equal(row.title, 'from the file');
  const written = JSON.parse(fs.readFileSync(cache, 'utf8'));
  assert.equal(written[file].title, 'from the file');
});

test('a partial pass does not drop the cached entries it never looked at', async () => {
  const { root, cache } = sandbox();
  writeSession(root, 'p', 'new', [user('newest')], Date.UTC(2026, 5, 1));
  const untouched = { '/somewhere/else.jsonl': { key: '1:1', title: 'kept', lastPrompt: '', cwd: '' } };
  fs.writeFileSync(cache, JSON.stringify(untouched));

  await run(root, cache, { limit: 1 });
  const written = JSON.parse(fs.readFileSync(cache, 'utf8'));
  assert.ok(written['/somewhere/else.jsonl'], 'entries outside this pass must survive');
});

test('a malformed since is an error, not a silent empty list', async () => {
  const { root, cache } = sandbox();
  writeSession(root, 'p', 's1', [user('q')]);
  await assert.rejects(() => run(root, cache, { since: 'not-a-date' }), /not a date/);
});

test('a transcript of unreadable lines costs that transcript, not the run', async () => {
  const { root, cache } = sandbox();
  const dir = path.join(root, 'p');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'broken.jsonl'),
    '{"type":"user" broken\nnot json at all\n{"type":"assistant", "message":\n');
  assert.ok(fs.statSync(path.join(dir, 'broken.jsonl')).size >= 64, 'must clear the size floor');
  writeSession(root, 'p', 'good', [user('fine, and long enough to clear the size floor')]);

  const rows = await run(root, cache);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.ok(byId.good.title.startsWith('fine'), 'a good file next to a broken one still reads');
  assert.ok(byId.broken, 'a broken file is still a session');
  assert.equal(byId.broken.title, '(no title)');
});
