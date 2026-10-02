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
 *
 * The blocks are where the work is. A tool call carries the artifact's HTML,
 * the file it wrote, the edit it made — and reading only `text` threw all of it
 * away. A claude.ai export came in complete, but 1671 artifacts, 1186 edits and
 * 607 file writes arrived in the vault as "This block is not supported on your
 * current device yet", the placeholder standing exactly where the code had
 * been. So blocks are rendered rather than skipped.
 */
function contentBlocks(m) {
  const c = m.content;
  if (Array.isArray(c)) return c;
  if (c && Array.isArray(c.contentBlocks)) return c.contentBlocks;
  return [];
}

// Where a tool keeps its payload. `content` is an artifact or a written file,
// `file_text` a create_file, `widget_code` a rendered widget.
const CALL_BODY = ['file_text', 'widget_code', 'content', 'code', 'text'];

const isCall = (b) => Boolean(b && typeof b === 'object' && (b.toolCall || b.type === 'tool_use'));

function renderCall(name, input, output) {
  const inp = input && typeof input === 'object' ? input : {};
  const parts = [`[tool ${name || 'unknown'}]${inp.description ? ' ' + inp.description : ''}`];
  const meta = ['path', 'filepaths', 'asset', 'id', 'command', 'title']
    .filter((k) => inp[k] !== undefined && inp[k] !== null && inp[k] !== '')
    .map((k) => `${k}: ${Array.isArray(inp[k]) ? inp[k].join(', ') : inp[k]}`);
  if (meta.length) parts.push(meta.join(' | '));
  // A str_replace carries its own before and after; keep both so the edit can
  // be replayed, not merely read.
  for (const k of ['old_str', 'new_str', ...CALL_BODY]) {
    if (typeof inp[k] === 'string' && inp[k].length) parts.push(`[${k}]${NL}${inp[k]}`);
  }
  if (typeof output === 'string' && output.length) parts.push(`[result]${NL}${output}`);
  return parts.join(NL);
}

function renderBlock(b) {
  if (typeof b === 'string') return b;
  if (!b || typeof b !== 'object') return '';
  if (typeof b.text === 'string' && b.text) return b.text;
  if (typeof b.thinking === 'string' && b.thinking) return `[thinking]${NL}${b.thinking}`;
  if (b.toolCall) return renderCall(b.toolCall.name, b.toolCall.input, b.toolCall.output);
  if (b.type === 'tool_use') return renderCall(b.name, b.input);
  if (b.type === 'tool_result') {
    const c = b.content;
    if (typeof c === 'string') return c ? `[result]${NL}${c}` : '';
    if (Array.isArray(c)) return c.map((x) => (x && x.text) || '').filter(Boolean).join(NL);
  }
  return '';
}

export function messageText(m) {
  if (!m) return '';
  const blocks = contentBlocks(m);
  if (blocks.length) {
    const rendered = blocks.map((b) => ({ block: b, text: renderBlock(b) }));
    const parts = rendered.filter((r) => r.text).map((r) => r.text);
    // A handful of messages leave every text block empty and keep the words in
    // `text` alone — 12 of 4540 in one export. Rendering only the blocks would
    // drop them, so `text` speaks when no block did. It is not taken otherwise:
    // for every other message `text` is the rendered view, and there it holds
    // little but the placeholders this change exists to replace.
    const spoke = rendered.some((r) => r.text && r.block && r.block.type === 'text');
    if (!spoke && typeof m.text === 'string' && m.text.trim()) parts.unshift(m.text.trim());
    return parts.join(NL).trim();
  }
  if (typeof m.text === 'string' && m.text.length) return m.text;
  const c = m.content;
  if (typeof c === 'string') return c;
  if (c && typeof c.content === 'string') return c.content;
  return '';
}

/** How many tool calls a message carried — what the old reading discarded. */
export function messageToolCalls(m) {
  return m ? contentBlocks(m).filter(isCall).length : 0;
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
  return { conversations: 0, created: 0, updated: 0, unchanged: 0, empty: 0, unreadable: 0, toolCalls: 0 };
}
