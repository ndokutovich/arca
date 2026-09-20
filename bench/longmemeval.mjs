// LongMemEval against arca's real retrieval path.
//
//   node bench/longmemeval.mjs --data <longmemeval_s_cleaned.json> [--limit N] [--k 5]
//
// Why this benchmark and not one built from arca's own corpus: a label set
// derived from the derived layers would mostly confirm that the vectors agree
// with themselves, since threads and entities are built from the same
// embeddings the search uses. The knowledge graph avoids that — it extracts by
// pattern — but its facts are largely artifacts: a port read off
// `index.html:1038:7`, a version read out of a lockfile dump. Of 844 triples,
// 23 defensible questions survived filtering.
//
// LongMemEval is human-labelled, external, and is what the neighbours publish
// against, so the number can be compared rather than merely stated.
//
// The protocol is the benchmark's own: each question gets a fresh index of its
// own ~40 haystack sessions, the question text is the query, and a hit is any
// of that question's evidence sessions appearing in the top k. Everything runs
// through arca's real db, embeddings and search — RRF and FTS5 included — in
// an isolated vault under a temporary HOME, so the machine's own vault is
// neither read nor touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const DATA = flag('data');
const LIMIT = flag('limit') ? Number(flag('limit')) : null;
const K = Number(flag('k', '5'));
const OUT = flag('out', 'bench/longmemeval-results.jsonl');

if (!DATA || !fs.existsSync(DATA)) {
  console.error('usage: node bench/longmemeval.mjs --data <longmemeval_s_cleaned.json> [--limit N] [--k 5]');
  console.error('');
  console.error('Get it from:');
  console.error('  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned');
  console.error('  longmemeval_s_cleaned.json  (277 MB, 500 questions, ~40 sessions each)');
  process.exit(2);
}

// The vault directory is resolved from the home directory when lib/db.js is
// first imported, so this has to happen before any arca module is loaded.
// A run killed with SIGKILL never reaches its exit handler, so its sandbox
// survives. Three of them were left behind before this swept them up.
function sweepStale() {
  const tmp = os.tmpdir();
  for (const name of fs.readdirSync(tmp)) {
    if (!name.startsWith("arca-lme-")) continue;
    try { fs.rmSync(path.join(tmp, name), { recursive: true, force: true }); } catch { /* in use */ }
  }
}
sweepStale();

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-lme-'));
const realHome = os.homedir();
process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;
// Keep using the model that is already downloaded rather than fetching 90 MB
// into a directory that is about to be deleted.
process.env.ARCA_MODEL_DIR = process.env.ARCA_MODEL_DIR
  || path.join(realHome, '.claude-vault', '.cache', 'models', 'all-MiniLM-L6-v2');

const { getDb, upsertExchange, deleteByArchive, closeDb } = await import('../lib/db.js');
const { embedExchange, initEmbeddings } = await import('../lib/embeddings.js');
const { runModes, summarise, table } = await import('../lib/bench.js');

const cleanup = () => {
  try { closeDb(); } catch { /* not open */ }
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* windows may hold it */ }
};
process.on('exit', cleanup);

console.log(`reading ${path.basename(DATA)} …`);
const raw = JSON.parse(fs.readFileSync(DATA, 'utf8'));
// The file is ordered by question type, so taking the first N would measure
// one category — the first forty are all single-session-user, the easiest
// kind. A subset takes its share of each type instead, in file order, so the
// same N always gives the same questions.
function stratified(all, n) {
  const byType = new Map();
  for (const q of all) {
    if (!byType.has(q.question_type)) byType.set(q.question_type, []);
    byType.get(q.question_type).push(q);
  }
  const out = [];
  for (const [, group] of byType) {
    const take = Math.max(1, Math.round((group.length / all.length) * n));
    out.push(...group.slice(0, take));
  }
  return out.slice(0, n);
}

const items = LIMIT ? stratified(raw, LIMIT) : raw;

// A full run is nearly two hours, and on a loaded machine it is liable to be
// killed for memory it is not using — the process holds a flat 500 MB while
// the OOM killer looks for something long-lived. Each question is written as
// it finishes, so a kill costs one question and the next invocation carries
// on. Delete the file to start over.
const done = new Map();
if (fs.existsSync(OUT)) {
  for (const line of fs.readFileSync(OUT, 'utf8').split(String.fromCharCode(10))) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); done.set(r.question_id, r); } catch { /* half-written last line */ }
  }
}
const todo = items.filter((q) => !done.has(q.question_id));

const sessions = items.reduce((a, q) => a + q.haystack_sessions.length, 0);
const turns = items.reduce((a, q) => a + q.haystack_sessions.reduce((b, s) => b + s.length, 0), 0);
console.log(`${items.length} questions, ${sessions} sessions, ${turns} turns to embed`);
console.log(`isolated vault: ${sandbox}`);
console.log('');

await initEmbeddings();
getDb();

const id = (...parts) => crypto.createHash('sha1').update(parts.join('␟')).digest('hex').slice(0, 32);

/**
 * Dates arrive as `2023/05/20 (Sat) 02:21`, which Date cannot parse: the
 * weekday in brackets makes it an invalid time value rather than a slow path.
 */
function stamp(text) {
  const m = String(text).match(/([0-9]{4})[/]([0-9]{2})[/]([0-9]{2}).*?([0-9]{2}):([0-9]{2})/);
  if (!m) return new Date(0).toISOString();
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00.000Z`;
}

/**
 * Turn one question's haystack into exchanges in the index.
 *
 * A session is a flat list of turns; arca's unit is a user turn with the
 * assistant turn that answered it, which is how the real corpus is shaped and
 * therefore what the search was tuned against. A trailing user turn with no
 * answer is still indexed, with an empty assistant side.
 */
async function indexHaystack(q, archivePath) {
  let n = 0;
  for (let s = 0; s < q.haystack_sessions.length; s++) {
    const sessionId = q.haystack_session_ids[s];
    const date = (q.haystack_dates && q.haystack_dates[s]) || '2024-01-01 00:00';
    const turnsIn = q.haystack_sessions[s];

    for (let t = 0; t < turnsIn.length; t++) {
      if (turnsIn[t].role !== 'user') continue;
      const user = turnsIn[t].content || '';
      const next = turnsIn[t + 1];
      const assistant = next && next.role === 'assistant' ? (next.content || '') : '';
      if (!user.trim() && !assistant.trim()) continue;

      const exchange = {
        id: id(q.question_id, sessionId, String(t)),
        project: 'longmemeval',
        timestamp: stamp(date),
        userMessage: user,
        assistantMessage: assistant,
        archivePath,
        lineStart: t,
        lineEnd: t + 1,
        // The gold is keyed on the session, so this is what a hit is checked
        // against.
        sessionId,
        cwd: null,
        gitBranch: null,
        isSidechain: false,
        toolCalls: null,
        isSystemNoise: false,
        promptKind: null,
        source: 'longmemeval',
        contentHash: null,
      };
      upsertExchange(exchange, await embedExchange(user, assistant, ''));
      n++;
    }
  }
  return n;
}

const questions = todo.map((q) => ({
  query: q.question,
  gold: new Set(q.answer_session_ids.map(String)),
  group: q.question_type,
  item: q,
}));

const t0 = Date.now();
let embedded = 0;
let peakRss = 0;
let seen = 0;
const tty = Boolean(process.stdout.isTTY);

const prepare = async (q) => {
  embedded += await indexHaystack(q.item, `lme/${q.item.question_id}`);
};

// Torn down straight away: leaving each haystack in place would mean every
// later question searched against every earlier question's sessions, which is
// a different and much harder task than the one being reported.
const teardown = async (q) => {
  deleteByArchive(`lme/${q.item.question_id}`);
  // Without this the write-ahead log grows for the whole run: a quarter of a
  // million inserts and deletes, each its own transaction, and nothing ever
  // folds them back into the database. The first full run was killed for
  // memory on a machine with 4 GB free.
  getDb().exec('PRAGMA wal_checkpoint(TRUNCATE)');
  // The haystack is done with; holding it keeps all 500 alive to the end.
  q.item.haystack_sessions = null;
  // Measured here rather than in the progress callback: that one only runs
  // under a TTY, so piping the run into grep silently reported zero.
  const rss = process.memoryUsage().rss / 1048576;
  if (rss > peakRss) peakRss = rss;
  // A line every 25 questions, so a run that is quietly growing is visible
  // in the log before it is killed rather than after.
  seen++;
  if (seen % 25 === 0 && !process.stdout.isTTY) {
    console.log(`  ${seen} questions, ${embedded} exchanges, ${Math.round((Date.now() - t0) / 1000)}s, rss ${rss.toFixed(0)} MB`);
  }
};

const fresh = await runModes(questions, {
  k: K,
  keyOf: (row) => row.sessionId ?? row.session_id,
  prepare,
  teardown,
  onResult: (q, ranks) => {
    const row = { question_id: q.item.question_id, group: q.group, gold: q.gold.size, ranks };
    fs.appendFileSync(OUT, JSON.stringify(row) + String.fromCharCode(10));
    done.set(row.question_id, row);
  },
  onProgress: tty
    ? (d, t) => {
        const rss = process.memoryUsage().rss / 1048576;
        process.stdout.write(String.fromCharCode(13) + `  ${d}/${t}q  ${embedded} exch  ${Math.round((Date.now() - t0) / 1000)}s  ${rss.toFixed(0)}MB   `);
      }
    : undefined,
});
if (tty) process.stdout.write(`\r${' '.repeat(72)}\r`);
void fresh;

// Summarised from every question ever recorded in this file, not only the
// ones this invocation ran — which is what makes a killed run resumable
// rather than lost.
const records = items.map((q) => done.get(q.question_id)).filter(Boolean);
const reports = summarise(records, { k: K });

console.log(`indexed ${embedded} exchanges in ${Math.round((Date.now() - t0) / 1000)}s, peak rss ${peakRss.toFixed(0)} MB`);
console.log('');
console.log(`LongMemEval_S · ${records.length} of ${items.length} questions · top ${K}`);
console.log('');
for (const line of table(reports)) console.log(line);

const both = reports.find((r) => r.mode === 'both');
const best = Math.max(...reports.filter((r) => r.mode !== 'both').map((r) => r.recall[K]));
console.log('');
console.log(both.recall[K] > best
  ? `Fusion earns its keep: R@${K} is ${(both.recall[K] * 100).toFixed(1)}% against ${(best * 100).toFixed(1)}% for the better half alone.`
  : `Fusion is not paying for itself: the better half alone reaches ${(best * 100).toFixed(1)}% against ${(both.recall[K] * 100).toFixed(1)}%.`);

for (const r of reports) if (r.failed) console.log(`${r.mode}: ${r.failed} queries threw and were counted as misses.`);

console.log('');
console.log(`by question type (mode: both, R@${K})`);
// From the recorded results, so a resumed run reports every question rather
// than only the ones it happened to run itself.
for (const g of [...new Set(records.map((r) => r.group))]) {
  const mine = records.filter((r) => r.group === g);
  const found = mine.filter((r) => r.ranks.both && r.ranks.both <= K).length;
  console.log(`  ${g.padEnd(28)} ${String(mine.length).padStart(4)}q   ${((found / mine.length) * 100).toFixed(0)}%`);
}

console.log('');
console.log('Retrieval only: whether the evidence session comes back, not whether');
console.log('an answer generated from it would be correct. The official headline');
console.log('metric is QA accuracy with a judge model, which this does not run.');
