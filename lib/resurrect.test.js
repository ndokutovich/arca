// Forking a transcript is destructive if it picks the wrong point: everything
// before the last compact boundary was already discarded by /compact, but
// everything after it is live conversation. These tests pin the boundary
// choice, the shape of what comes out, and the promise that the original is
// never touched.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROJECT = 'test-project';

/** A transcript with two compact boundaries; only the last one is the fork point. */
function transcript() {
  const L = [];
  L.push(JSON.stringify({ type: 'last-prompt', prompt: 'header, no uuid' }));
  L.push(JSON.stringify({ type: 'file-history-snapshot', files: [] }));
  L.push(JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, sessionId: 'old', message: { role: 'user', content: 'ancient' } }));
  L.push(JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 'old', message: { role: 'assistant', content: 'ancient reply' } }));
  L.push(JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'b1', parentUuid: null, sessionId: 'old' }));
  L.push(JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: 'b1', sessionId: 'old', isCompactSummary: true, message: { role: 'user', content: 'first summary' } }));
  L.push(JSON.stringify({ type: 'user', uuid: 'u3', parentUuid: 'u2', sessionId: 'old', message: { role: 'user', content: 'middle turn' } }));
  // the second boundary is the one a fork must use
  L.push(JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'b2', parentUuid: null, sessionId: 'old' }));
  L.push(JSON.stringify({ type: 'user', uuid: 'u4', parentUuid: 'b2', sessionId: 'old', isCompactSummary: true, message: { role: 'user', content: 'SECOND summary' } }));
  L.push(JSON.stringify({ type: 'assistant', uuid: 'a4', parentUuid: 'u4', sessionId: 'old', message: { role: 'assistant', content: 'live tail' } }));
  return L.join('\n') + '\n';
}

function makeHome(body = transcript(), id = 'sess-1') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-res-'));
  const dir = path.join(home, '.claude', 'projects', PROJECT);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), body);
  return { home, dir, file: path.join(dir, `${id}.jsonl`) };
}

/** resurrect.js reads HOME at import time, so each case gets a fresh module. */
async function withHome(home, fn) {
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const mod = await import(`../lib/resurrect.js?t=${Date.now()}${Math.random()}`);
    return await fn(mod);
  } finally {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevProfile;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* temp */ }
  }
}

test('fork uses the LAST compact boundary, not the first', async () => {
  const { home, dir } = makeHome();
  await withHome(home, async (m) => {
    const r = await m.forkSession('sess-1');
    const out = fs.readFileSync(r.to, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const summaries = out.filter((x) => x.isCompactSummary);
    assert.equal(summaries.length, 1, 'the fork must carry exactly one summary');
    assert.equal(summaries[0].message.content, 'SECOND summary', 'forked from the wrong boundary');
    assert.ok(!out.some((x) => x.uuid === 'u1'), 'pre-boundary turns leaked into the fork');
    assert.ok(out.some((x) => x.uuid === 'a4'), 'the live tail was dropped');
    assert.ok(fs.existsSync(path.join(dir, 'sess-1.jsonl')), 'the original must survive');
  });
});

test('the fork keeps the header records that carry no uuid', async () => {
  const { home } = makeHome();
  await withHome(home, async (m) => {
    const r = await m.forkSession('sess-1');
    const out = fs.readFileSync(r.to, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(out[0].type, 'last-prompt', 'the meta header was lost');
    assert.ok(out.some((x) => x.type === 'file-history-snapshot'), 'the snapshot header was lost');
  });
});

test('every record in the fork is retagged to the new session id', async () => {
  const { home } = makeHome();
  await withHome(home, async (m) => {
    const r = await m.forkSession('sess-1');
    const out = fs.readFileSync(r.to, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const stale = out.filter((x) => x.sessionId !== undefined && x.sessionId !== r.newId);
    assert.equal(stale.length, 0, 'a record still claims the old session id');
    assert.equal(path.basename(r.to), `${r.newId}.jsonl`, 'the file must be named for its session');
  });
});

test('a transcript with no compact boundary is refused, not truncated', async () => {
  const body = [
    JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, sessionId: 'x', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 'x', message: { role: 'assistant', content: 'yo' } }),
  ].join('\n') + '\n';
  const { home } = makeHome(body, 'nocompact');
  await withHome(home, async (m) => {
    await assert.rejects(() => m.forkSession('nocompact'), /no compact boundary/i);
  });
});

test('diagnose reports size and stays quiet about healthy files', async () => {
  const { home } = makeHome();
  await withHome(home, async (m) => {
    assert.equal(m.diagnose().length, 0, 'a small transcript is not a problem');
    const all = m.diagnose({ all: true });
    assert.equal(all.length, 1);
    assert.equal(all[0].status, 'ok');
    assert.ok(all[0].bytes > 0);
  });
});

test('dry run reports the plan and writes nothing', async () => {
  const { home, dir } = makeHome();
  await withHome(home, async (m) => {
    const before = fs.readdirSync(dir);
    const r = await m.forkSession('sess-1', { dryRun: true });
    assert.equal(r.dryRun, true);
    assert.ok(r.kept > 0 && r.kept < r.lines, 'the plan must drop something and keep something');
    assert.deepEqual(fs.readdirSync(dir), before, 'a dry run created a file');
  });
});
