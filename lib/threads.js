// Threads modality — recovers topic-threads from linear sessions and links
// them across the whole corpus. A session is linear in time but a wandering
// walk in meaning: you work a topic, detour, return, get pulled back. This
// derives that structure deterministically from the substrate's embeddings.
//
// Recipe (each step earned by experiment, not assumed — see proto runs):
//   1. drift segmentation   — cut a session where adjacent-exchange similarity
//                             dips to a local minimum below mean-k*std.
//   2. micro-merge          — fold sub-MIN_SEG segments into their nearest
//                             temporal neighbour (short spans give noisy centroids).
//   3. global mean-center    — subtract the corpus-common component so the
//                             distinctive topic signal dominates, not "dev work".
//   4. IDF distinctive entities — drop entities present in > DF_MAX of segments
//                             (claude/mcp/skill) so common tags don't bind.
//   5. fused edge weight     — cos * (1 + LAMBDA*jaccard(distinctive entities)),
//                             with a doubt-zone gate: weak cosine + no shared
//                             distinctive entity => no edge (kills gpu/cuda collisions).
//   6. Louvain with gamma    — community detection; gamma is the zoom knob
//                             (higher = finer threads). Resists both blob-attraction
//                             and single-linkage chaining.
//
// Pure + deterministic: fixed node iteration order, no RNG. Entity extraction is
// the only external dependency (deterministic too). Tests inject synthetic data.

import { extractEntities } from './entities.js';

export const THREAD_DEFAULTS = {
  driftK: 0.8,      // boundary if adjacent-sim < mean - driftK*std (and local min)
  minSeg: 3,        // segments shorter than this get merged into a neighbour
  dfMax: 0.10,      // entity in > dfMax fraction of segments = common, dropped
  strong: 0.55,     // cosine above this binds even without shared entity
  edgeFloor: 0.38,  // below this, never an edge
  lambda: 2.0,      // entity-jaccard amplification of edge weight
  gamma: 2.0,       // Louvain resolution; >1 = smaller/finer threads
};

export function cosine(a, b) {
  let d = 0, na = 0, nb = 0;
  const n = a.length;
  for (let i = 0; i < n; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

function meanVector(vectors) {
  const D = vectors[0].length;
  const c = new Float64Array(D);
  for (const v of vectors) for (let i = 0; i < D; i++) c[i] += v[i];
  for (let i = 0; i < D; i++) c[i] /= vectors.length;
  return c;
}

function unit(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) + 1e-9;
  const out = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/**
 * Drift boundaries within one session. Returns sorted cut indices: a cut at i
 * means a boundary BEFORE element i. Cuts where adjacent similarity is a local
 * minimum and below mean - k*std.
 */
export function driftBoundaries(embs, k = THREAD_DEFAULTS.driftK) {
  if (embs.length < 2) return [];
  const sim = [];
  for (let i = 1; i < embs.length; i++) sim.push(cosine(embs[i - 1], embs[i]));
  const mean = sim.reduce((a, b) => a + b, 0) / sim.length;
  const std = Math.sqrt(sim.reduce((a, b) => a + (b - mean) ** 2, 0) / sim.length);
  const thr = mean - k * std;
  const bnd = [];
  for (let i = 0; i < sim.length; i++) {
    const isLocalMin = (i === 0 || sim[i] <= sim[i - 1]) && (i === sim.length - 1 || sim[i] <= sim[i + 1]);
    if (sim[i] < thr && isLocalMin) bnd.push(i + 1);
  }
  return bnd;
}

/**
 * Segment a session into {a,b} index ranges (half-open), with micro-merge.
 * embs: array of vectors, time-ordered.
 */
export function segmentSession(embs, opts = {}) {
  const { driftK = THREAD_DEFAULTS.driftK, minSeg = THREAD_DEFAULTS.minSeg } = opts;
  const cuts = [0, ...driftBoundaries(embs, driftK), embs.length];
  let ranges = [];
  for (let s = 0; s < cuts.length - 1; s++) {
    if (cuts[s + 1] > cuts[s]) ranges.push({ a: cuts[s], b: cuts[s + 1] });
  }
  // micro-merge: fold any range shorter than minSeg into the temporal neighbour
  // whose centroid is more similar. Repeat until stable or single range.
  const cen = (r) => meanVector(embs.slice(r.a, r.b));
  let changed = true;
  while (changed && ranges.length > 1) {
    changed = false;
    for (let i = 0; i < ranges.length; i++) {
      if (ranges[i].b - ranges[i].a >= minSeg) continue;
      const me = cen(ranges[i]);
      const prev = i > 0 ? cosine(me, cen(ranges[i - 1])) : -Infinity;
      const next = i < ranges.length - 1 ? cosine(me, cen(ranges[i + 1])) : -Infinity;
      if (prev === -Infinity && next === -Infinity) break;
      const j = next > prev ? i + 1 : i - 1;
      const lo = Math.min(i, j), hi = Math.max(i, j);
      ranges.splice(lo, 2, { a: ranges[lo].a, b: ranges[hi].b });
      changed = true;
      break;
    }
  }
  return ranges;
}

/**
 * Louvain community detection (single level, local moving). Deterministic:
 * nodes visited in index order. edges: [i, j, weight] undirected.
 * Returns Int32Array of community labels.
 */
export function louvain(N, edges, opts = {}) {
  const { gamma = THREAD_DEFAULTS.gamma, maxIter = 80 } = opts;
  const adj = Array.from({ length: N }, () => new Map());
  let m2 = 0;
  for (const [i, j, w] of edges) {
    adj[i].set(j, (adj[i].get(j) || 0) + w);
    adj[j].set(i, (adj[j].get(i) || 0) + w);
    m2 += 2 * w;
  }
  const m = m2 || 1;
  const k = adj.map((nb) => [...nb.values()].reduce((a, b) => a + b, 0));
  const comm = new Int32Array(N);
  for (let i = 0; i < N; i++) comm[i] = i;
  const sumTot = k.slice();
  const kIn = (i, c) => { let s = 0; for (const [j, w] of adj[i]) if (comm[j] === c) s += w; return s; };
  let improved = true, iter = 0;
  while (improved && iter++ < maxIter) {
    improved = false;
    for (let i = 0; i < N; i++) {
      const ci = comm[i];
      sumTot[ci] -= k[i];
      const cand = new Set([ci]);
      for (const [j] of adj[i]) cand.add(comm[j]);
      let best = ci, bestGain = kIn(i, ci) - gamma * sumTot[ci] * k[i] / m;
      for (const c of cand) {
        const gain = kIn(i, c) - gamma * sumTot[c] * k[i] / m;
        if (gain > bestGain + 1e-12) { bestGain = gain; best = c; }
      }
      if (best !== ci) { comm[i] = best; sumTot[best] += k[i]; improved = true; }
      else sumTot[ci] += k[i];
    }
  }
  return comm;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Build the thread graph over many sessions.
 * @param {Array} sessions [{ sessionId, project, items: [{ emb:Float32Array, text, id, ts, summary, promptKind }] }]
 * @returns {{ segments: Array }} each segment carries .community (thread cluster id)
 */
export function buildThreads(sessions, opts = {}) {
  const o = { ...THREAD_DEFAULTS, ...opts };

  // 1+2. segment each session.
  const segs = [];
  for (const s of sessions) {
    const embs = s.items.map((it) => it.emb);
    if (embs.length < 2) continue;
    const ranges = segmentSession(embs, o);
    ranges.forEach((r, seq) => {
      const slice = s.items.slice(r.a, r.b);
      const ent = new Set();
      for (const it of slice) {
        if (!it.text) continue;
        for (const e of extractEntities(it.text.slice(0, 3000))) ent.add(e.key);
      }
      segs.push({
        sessionId: s.sessionId, project: s.project, seq,
        n: slice.length,
        tsStart: slice[0].ts, tsEnd: slice[slice.length - 1].ts,
        exchStart: slice[0].id, exchEnd: slice[slice.length - 1].id,
        summary: (slice[0].summary || '').slice(0, 90),
        ent, _embs: slice.map((it) => it.emb),
      });
    });
  }
  const N = segs.length;
  if (N === 0) return { segments: [] };

  // 3. global mean-center; raw + centered centroids per segment.
  const allEmbs = segs.flatMap((s) => s._embs);
  const mu = meanVector(allEmbs);
  for (const s of segs) {
    s.rawCentroid = unit(meanVector(s._embs)); // for vec storage / semantic search
    const centered = s._embs.map((e) => {
      const c = new Float64Array(e.length);
      for (let i = 0; i < e.length; i++) c[i] = e[i] - mu[i];
      return unit(c);
    });
    s.cen = unit(meanVector(centered));
    delete s._embs;
  }

  // 4. IDF distinctive entities.
  const df = new Map();
  for (const s of segs) for (const e of s.ent) df.set(e, (df.get(e) || 0) + 1);
  const common = new Set([...df.entries()].filter(([, c]) => c / N > o.dfMax).map(([e]) => e));
  for (const s of segs) s.dist = new Set([...s.ent].filter((e) => !common.has(e)));

  // 5. fused edges with doubt-zone gate.
  const edges = [];
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const c = cosine(segs[i].cen, segs[j].cen);
      if (c <= o.edgeFloor) continue;
      const dj = jaccard(segs[i].dist, segs[j].dist);
      if (c < o.strong && dj === 0) continue;
      edges.push([i, j, c * (1 + o.lambda * dj)]);
    }
  }

  // 6. Louvain.
  const comm = louvain(N, edges, o);
  // relabel communities to dense 0..M-1 in first-seen order (deterministic)
  const remap = new Map();
  for (let i = 0; i < N; i++) {
    if (!remap.has(comm[i])) remap.set(comm[i], remap.size);
    segs[i].community = remap.get(comm[i]);
  }
  segs.forEach((s) => { delete s.cen; });
  return { segments: segs, commonEntities: [...common] };
}

/**
 * Assemble thread aggregates from clustered segments. Pure.
 * Computes label, spans, return_count (timeline fragmentation), centroid.
 * @returns {{ threads: Array, segments: Array }} segments get .threadId
 */
export function assembleThreads(segments) {
  // global time order for fragmentation metric
  const ordered = [...segments].sort((a, b) => String(a.tsStart).localeCompare(String(b.tsStart)));
  ordered.forEach((s, i) => { s._gi = i; });

  const byComm = new Map();
  for (const s of segments) {
    if (!byComm.has(s.community)) byComm.set(s.community, []);
    byComm.get(s.community).push(s);
  }

  const threads = [];
  let tid = 0;
  // stable order: by exchange mass desc
  const comms = [...byComm.entries()].sort(
    (a, b) => b[1].reduce((x, s) => x + s.n, 0) - a[1].reduce((x, s) => x + s.n, 0)
  );
  for (const [, mem] of comms) {
    tid += 1;
    for (const s of mem) s.threadId = tid;
    const tally = new Map();
    for (const s of mem) for (const e of s.dist) tally.set(e, (tally.get(e) || 0) + 1);
    const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    const sessions = new Set(mem.map((s) => s.sessionId));
    const projects = [...new Set(mem.map((s) => s.project))];
    const sorted = [...mem].sort((a, b) => a._gi - b._gi);
    let returns = 0;
    for (let i = 1; i < sorted.length; i++) if (sorted[i]._gi - sorted[i - 1]._gi > 1) returns++;
    const centroid = unit(meanVector(mem.map((s) => s.rawCentroid)));
    const tss = mem.map((s) => s.tsStart).filter(Boolean).sort();
    threads.push({
      id: tid,
      label: top.map(([e]) => e).slice(0, 4).join(' · ') || '(untagged)',
      n_segments: mem.length,
      n_exchanges: mem.reduce((x, s) => x + s.n, 0),
      n_sessions: sessions.size,
      n_projects: projects.length,
      first_ts: tss[0] || null,
      last_ts: tss[tss.length - 1] || null,
      return_count: returns,
      entities: top,
      projects,
      centroid: Array.from(centroid),
    });
  }
  segments.forEach((s) => { delete s._gi; });
  return { threads, segments };
}
