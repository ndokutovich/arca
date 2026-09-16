import { test } from 'node:test';
import assert from 'node:assert';
import { cosine, driftBoundaries, segmentSession, louvain, buildThreads, assembleThreads } from './threads.js';

const D = 8;
function dir(i) { const v = new Float32Array(D); v[i] = 1; return v; }       // unit basis vector
function block(i, n) { return Array.from({ length: n }, () => dir(i)); }      // n exchanges on one topic

test('cosine: orthogonal=0, identical=1', () => {
  assert.ok(Math.abs(cosine(dir(0), dir(1))) < 1e-6);
  assert.ok(Math.abs(cosine(dir(0), dir(0)) - 1) < 1e-6);
});

test('driftBoundaries finds the topic shift', () => {
  const embs = [...block(0, 4), ...block(1, 4)];
  const b = driftBoundaries(embs);
  assert.ok(b.includes(4), `expected a cut at 4, got ${b}`);
});

test('segmentSession splits two topics into two segments', () => {
  const embs = [...block(0, 4), ...block(1, 4)];
  const segs = segmentSession(embs);
  assert.strictEqual(segs.length, 2);
  assert.deepStrictEqual(segs[0], { a: 0, b: 4 });
  assert.deepStrictEqual(segs[1], { a: 4, b: 8 });
});

test('segmentSession micro-merges a too-short span', () => {
  // 4 on topic A, 2 on topic B (below minSeg=3), 4 on topic A again.
  const embs = [...block(0, 4), ...block(1, 2), ...block(0, 4)];
  const segs = segmentSession(embs, { minSeg: 3 });
  // the 2-exchange B span must not survive as its own segment
  assert.ok(segs.every((s) => s.b - s.a >= 3), `all segments >= minSeg, got ${JSON.stringify(segs)}`);
});

test('louvain separates two weakly-linked cliques', () => {
  const edges = [
    [0, 1, 1], [1, 2, 1], [0, 2, 1],   // clique X
    [3, 4, 1], [4, 5, 1], [3, 5, 1],   // clique Y
    [2, 3, 0.01],                       // weak bridge
  ];
  const c = louvain(6, edges, { gamma: 1 });
  assert.strictEqual(c[0], c[1]); assert.strictEqual(c[1], c[2]);
  assert.strictEqual(c[3], c[4]); assert.strictEqual(c[4], c[5]);
  assert.notStrictEqual(c[0], c[3]);
});

test('buildThreads links the same topic across two sessions', () => {
  const mk = (id, i, n, ts) => block(i, n).map((emb, j) => ({
    id: `${id}:${j}`, ts, text: `topic${i}`, summary: `topic${i}`, emb,
  }));
  // session 1: topicA then topicB ; session 2: topicB then topicC
  const sessions = [
    { sessionId: 's1', project: 'p1', items: [...mk('s1a', 0, 4, '2026-01-01'), ...mk('s1b', 1, 4, '2026-01-02')] },
    { sessionId: 's2', project: 'p2', items: [...mk('s2b', 1, 4, '2026-02-01'), ...mk('s2c', 2, 4, '2026-02-02')] },
  ];
  const opts = { edgeFloor: 0.2, strong: 0.2, dfMax: 0.9, lambda: 0, gamma: 1 };
  const { segments } = buildThreads(sessions, opts);
  // 2 segments per session
  assert.strictEqual(segments.length, 4);
  const s1B = segments.find((s) => s.sessionId === 's1' && s.seq === 1);
  const s2B = segments.find((s) => s.sessionId === 's2' && s.seq === 0);
  const s1A = segments.find((s) => s.sessionId === 's1' && s.seq === 0);
  assert.strictEqual(s1B.community, s2B.community, 'topicB segments from both sessions share a thread');
  assert.notStrictEqual(s1A.community, s1B.community, 'topicA and topicB are different threads');
});

test('assembleThreads aggregates spans and is deterministic', () => {
  const mk = (id, i, n, ts) => block(i, n).map((emb, j) => ({
    id: `${id}:${j}`, ts, text: `topic${i}`, summary: `topic${i}`, emb,
  }));
  const sessions = [
    { sessionId: 's1', project: 'p1', items: [...mk('s1a', 0, 4, '2026-01-01'), ...mk('s1b', 1, 4, '2026-01-02')] },
    { sessionId: 's2', project: 'p2', items: [...mk('s2b', 1, 4, '2026-02-01'), ...mk('s2c', 2, 4, '2026-02-02')] },
  ];
  const opts = { edgeFloor: 0.2, strong: 0.2, dfMax: 0.9, lambda: 0, gamma: 1 };
  const a = assembleThreads(buildThreads(sessions, opts).segments);
  const b = assembleThreads(buildThreads(sessions, opts).segments);
  assert.deepStrictEqual(a.threads.map((t) => t.id), b.threads.map((t) => t.id));
  // the cross-session topicB thread spans 2 sessions, 2 projects
  const cross = a.threads.find((t) => t.n_sessions >= 2);
  assert.ok(cross, 'a cross-session thread exists');
  assert.strictEqual(cross.n_projects, 2);
});
