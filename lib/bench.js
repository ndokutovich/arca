// The harness for measuring whether the search actually finds things.
//
// Every memory tool claims good retrieval and almost none publishes a number.
// This is the machinery for producing one; it holds no questions of its own,
// because where the questions come from is the part that decides whether the
// number means anything.
//
// A label set built from arca's own derived layers would mostly confirm that
// the vectors agree with themselves: threads and entities are built from the
// same embeddings the search uses. The knowledge graph looked like a way out —
// `build-kg.js` extracts by pattern and never touches an embedding — but its
// facts turned out to be mostly extraction artifacts: a port read off
// `index.html:1038:7`, a version read out of a lockfile dump. Of 844 triples,
// 23 defensible questions survived filtering, which is not a benchmark.
//
// So the questions come from outside, from a human-labelled set. See
// `bench/longmemeval.mjs`.
import { search } from './search.js';

/**
 * @typedef {Object} Question
 * @property {string} query      what to search for
 * @property {Set<string>} gold  keys that count as correct
 */

/** Where the first correct answer landed, or 0 for nowhere in the list. */
function firstHit(results, gold, keyOf) {
  for (let i = 0; i < results.length; i++) {
    const keys = keyOf(results[i]);
    for (const key of (Array.isArray(keys) ? keys : [keys])) {
      if (gold.has(String(key))) return i + 1;
    }
  }
  return 0;
}

/**
 * Run questions through one search mode.
 *
 * `keyOf` maps a result to whatever the gold set is keyed on — a turn id
 * for a corpus labelled at that level, a session id for LongMemEval.
 *
 * `prepare` runs before each question, for label sets that index a fresh
 * corpus per question rather than searching one standing index.
 *
 * @param {Question[]} qs
 * @param {{mode?: string, k?: number, keyOf?: Function, prepare?: Function, onProgress?: Function}} opts
 */
export async function run(qs, {
  mode = 'hybrid',
  k = 10,
  keyOf = (r) => r.id,
  prepare,
  onProgress,
} = {}) {
  const cuts = [...new Set([1, 5, k])].sort((a, b) => a - b);
  const hits = Object.fromEntries(cuts.map((c) => [c, 0]));
  let reciprocal = 0;
  let failed = 0;
  const misses = [];

  for (let i = 0; i < qs.length; i++) {
    const q = qs[i];
    if (prepare) await prepare(q);

    let results = [];
    try {
      results = await search(q.query, { mode, limit: k });
    } catch {
      // A failed query counts as a miss and is counted separately. Skipping it
      // would quietly raise the score of a search that crashed.
      failed++;
    }

    const rank = firstHit(results, q.gold, keyOf);
    if (rank) {
      reciprocal += 1 / rank;
      for (const c of cuts) if (rank <= c) hits[c]++;
    } else if (misses.length < 20) {
      misses.push({ query: q.query, gold: q.gold.size, group: q.group });
    }
    if (onProgress) onProgress(i + 1, qs.length);
  }

  return {
    mode,
    n: qs.length,
    failed,
    recall: Object.fromEntries(cuts.map((c) => [c, qs.length ? hits[c] / qs.length : 0])),
    mrr: qs.length ? reciprocal / qs.length : 0,
    misses,
  };
}

/**
 * Every mode over the same questions, so the fusion can be compared with the
 * halves it fuses. If `both` does not beat `vector` and `text`, the fusion is
 * costing time for nothing and that is worth knowing.
 */
export async function compare(qs, opts = {}) {
  const out = [];
  for (const mode of ['semantic', 'keyword', 'hybrid']) {
    out.push(await run(qs, {
      ...opts,
      mode,
      onProgress: opts.onProgress && ((d, t) => opts.onProgress(mode, d, t)),
    }));
  }
  return out;
}

/**
 * All modes over each question, one question at a time.
 *
 * The order matters when `prepare` builds a fresh corpus per question: running
 * mode after mode over the whole set would leave every question's corpus in
 * the index at once, so the first mode would be measured in isolation and the
 * rest against every other question's distractors. Same questions, same index,
 * three searches, then the corpus is torn down.
 *
 * @param {Question[]} qs
 * @param {{modes?: string[], k?: number, keyOf?: Function, prepare?: Function, teardown?: Function, onProgress?: Function}} opts
 */
export async function runModes(qs, {
  modes = ['semantic', 'keyword', 'hybrid'],
  k = 10,
  keyOf = (r) => r.id,
  prepare,
  teardown,
  onResult,
  onProgress,
} = {}) {
  const cuts = [...new Set([1, 5, k])].sort((a, b) => a - b);
  const state = new Map(modes.map((m) => [m, {
    mode: m, n: qs.length, failed: 0, reciprocal: 0,
    hits: Object.fromEntries(cuts.map((c) => [c, 0])),
    misses: [], foundBy: new Set(),
  }]));

  for (let i = 0; i < qs.length; i++) {
    const q = qs[i];
    if (prepare) await prepare(q);
    const ranks = {};
    for (const mode of modes) {
      const s = state.get(mode);
      let results = [];
      try {
        results = await search(q.query, { mode, limit: k });
      } catch {
        s.failed++;
      }
      const rank = firstHit(results, q.gold, keyOf);
      ranks[mode] = rank;
      if (rank) {
        s.reciprocal += 1 / rank;
        for (const c of cuts) if (rank <= c) s.hits[c]++;
        s.foundBy.add(i);
      } else if (s.misses.length < 20) {
        s.misses.push({ query: q.query, gold: q.gold.size, group: q.group });
      }
    }
    if (onResult) await onResult(q, Object.fromEntries(modes.map((m) => [m, ranks[m]])));
    if (teardown) await teardown(q);
    if (onProgress) onProgress(i + 1, qs.length);
  }

  return modes.map((m) => {
    const s = state.get(m);
    return {
      mode: m,
      n: s.n,
      failed: s.failed,
      recall: Object.fromEntries(cuts.map((c) => [c, s.n ? s.hits[c] / s.n : 0])),
      mrr: s.n ? s.reciprocal / s.n : 0,
      misses: s.misses,
      foundBy: s.foundBy,
    };
  });
}

/** Recall and MRR broken down by whatever `group` the questions carry. */
export function byGroup(qs, results) {
  const groups = [...new Set(qs.map((q) => q.group).filter(Boolean))];
  if (!groups.length) return [];
  const missed = new Set(results.misses.map((m) => m.query));
  return groups.map((g) => {
    const mine = qs.filter((q) => q.group === g);
    const found = mine.filter((q) => !missed.has(q.query)).length;
    return { group: g, n: mine.length, found };
  });
}

/** A table of modes against recall cut-offs, for printing. */
export function table(reports) {
  const cuts = Object.keys(reports[0].recall).map(Number).sort((a, b) => a - b);
  const pct = (x) => `${(x * 100).toFixed(1)}%`.padStart(7);
  const lines = [`  mode     ${cuts.map((c) => `R@${c}`.padStart(7)).join('  ')}     MRR`];
  for (const r of reports) {
    lines.push(`  ${r.mode.padEnd(7)}  ${cuts.map((c) => pct(r.recall[c])).join('  ')}  ${r.mrr.toFixed(3).padStart(6)}`);
  }
  return lines;
}

/**
 * Metrics from recorded per-question ranks.
 *
 * Kept separate from running the questions so a run can be written to disk as
 * it goes and summarised afterwards — which is what makes it survivable on a
 * machine where a two-hour process is liable to be killed for memory it is not
 * using.
 *
 * @param {Array<{ranks: Record<string, number>, group?: string}>} records
 */
export function summarise(records, { k = 10, modes = ['semantic', 'keyword', 'hybrid'] } = {}) {
  const cuts = [...new Set([1, 5, k])].sort((a, b) => a - b);
  return modes.map((mode) => {
    const ranks = records.map((r) => r.ranks[mode] ?? 0);
    const n = ranks.length;
    return {
      mode,
      n,
      failed: 0,
      recall: Object.fromEntries(cuts.map((c) => [c, n ? ranks.filter((r) => r && r <= c).length / n : 0])),
      mrr: n ? ranks.reduce((a, r) => a + (r ? 1 / r : 0), 0) / n : 0,
      misses: [],
      foundBy: new Set(records.map((r, i) => (r.ranks[mode] ? i : -1)).filter((i) => i >= 0)),
    };
  });
}
