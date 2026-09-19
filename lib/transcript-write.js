// Writing a foreign conversation into the vault as a Claude Code transcript.
//
// This was worked out once for the claude.ai importer and is the whole trick
// behind reading other assistants' history: convert to the JSONL shape Claude
// Code writes, drop it in the archive, and every layer downstream — parser,
// indexer, embeddings, essence, entities, threads — handles it with no special
// case at all. An adapter therefore needs no knowledge of any of them.
//
// Extracted here unchanged so a second, third and ninth source can use it.
// import-claude-ai.js keeps its tests: they are the proof this move preserved
// behaviour rather than quietly rewriting it.
import fs from 'node:fs';
import path from 'node:path';

const NL = String.fromCharCode(10);

/** A filesystem-safe fragment of a name, for a project directory. */
export function slug(name) {
  return String(name || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'untitled';
}

/**
 * One transcript line, in the shape lib/parser.js reads.
 * @param {{role: string, text: string, ts?: string, sessionId?: string,
 *          source?: string, cwd?: string|null, gitBranch?: string|null}} row
 */
export function line(row) {
  const role = row.role === 'assistant' ? 'assistant' : 'user';
  return JSON.stringify({
    type: role,
    message: { role, content: row.text },
    timestamp: row.ts,
    sessionId: row.sessionId,
    cwd: row.cwd ?? null,
    gitBranch: row.gitBranch ?? null,
    isSidechain: false,
    source: row.source || 'claude_code',
  });
}

/**
 * Pull the text out of a message however the source chose to nest it.
 * Sources put it in `text`, in `content`, inside `content.content`, or spread
 * across an array of typed blocks.
 */
export function messageText(m) {
  if (!m) return '';
  if (typeof m.text === 'string' && m.text.length) return m.text;
  const c = m.content;
  if (typeof c === 'string') return c;
  if (c && typeof c.content === 'string') return c.content;
  if (Array.isArray(c)) {
    return c.map((b) => (typeof b === 'string' ? b : (b && b.text) || '')).join(NL).trim();
  }
  return '';
}

// Ids come from someone else's files, so they are untrusted input that ends up
// as a path component. An id of "../../evil" would otherwise write outside the
// vault entirely, and a missing one collapses every conversation into
// undefined.jsonl.
const UUIDISH = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function safeId(id) {
  const s = typeof id === 'string' ? id.trim() : '';
  return UUIDISH.test(s) && !s.includes('..') ? s : null;
}

/**
 * Write one conversation, or recognise that it is already there.
 *
 * Idempotent by byte comparison rather than by timestamp, because a source
 * export always contains the full history and re-running it must not rewrite
 * thousands of identical files — that would make every import a fresh commit
 * of the whole vault.
 *
 * @param {string} destDir absolute project directory inside the vault
 * @param {string} id session id, used as the filename
 * @param {string[]} rows output of `line()`
 * @param {{created:number, updated:number, unchanged:number, empty:number, unreadable:number}} stats
 * @param {boolean} dryRun
 */
export function writeConversation(destDir, id, rows, stats, dryRun) {
  if (!rows.length) { stats.empty++; return; }
  const safe = safeId(id);
  if (!safe) { stats.unreadable++; return; }

  const body = rows.join(NL) + NL;
  const file = path.join(destDir, safe + '.jsonl');
  // Belt and braces: even a regex-clean id must land where we meant it to.
  if (path.relative(destDir, file).includes('..')) { stats.unreadable++; return; }

  try {
    if (fs.readFileSync(file, 'utf8') === body) { stats.unchanged++; return; }
    stats.updated++;
  } catch (_) {
    stats.created++;
  }
  if (dryRun) return;

  fs.mkdirSync(destDir, { recursive: true });
  // An interrupted overwrite would replace a good archive with a truncated one.
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw e;
  }
}

/** The tally every importer reports. */
export function newStats() {
  return { conversations: 0, created: 0, updated: 0, unchanged: 0, empty: 0, unreadable: 0 };
}
