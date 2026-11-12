// Sessions as a list, not as a search result.
//
// `search` answers "what did we say about X" but cannot answer "what sessions
// do I have" — it needs a query and returns turns. This walks the project tree,
// reads only the ends of each transcript for a title, and returns rows that
// `read` accepts directly: the file field is the path, so the two tools chain
// without the caller knowing the layout.
//
// Transcripts reach 100+ MB, so nothing here parses a whole file. The title
// ladder mirrors what Claude Code itself writes: a manual rename wins, then the
// generated title, then the compaction summary, then the first real prompt.
//
// The vault holds sessions Claude Code has already pruned. They are restorable
// with `arca restore` and readable with `arca read`, so `archived` adds them —
// one row per session either way, deduplicated by id, live winning, because two
// rows with one title and two timestamps is noise, not information.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promises as fsp } from 'fs';
import { projectsDir, vaultDir, walkTranscripts } from './transcripts.js';

const CHUNK = 32 * 1024;
const CONCURRENCY = 48;

// Bumped whenever extractMeta starts reading something it read wrong before.
// Without it a cached row keeps its wrong title for as long as the transcript
// stays unchanged — which, for an archived session, is forever.
const META_VERSION = 4;

/** Cache key for a transcript: file identity plus the parser version. */
export const metaKey = (mtimeMs, bytes) => `${META_VERSION}:${mtimeMs}:${bytes}`;

// Echoes of slash commands, local shell output, task notifications. None of
// these is something a person typed, so none may become a title.
export const NOISE = [
  '<command-name', '<command-message', '<command-args', '<local-command',
  '<bash-stdout', '<bash-stderr', '<task-notification', '<tick', '<teammate-message',
];

// A compaction entry sometimes stores the summarizer's own instruction rather
// than a summary. It was being taken as the session title, which is how half
// the index ended up named "Context: This summary will be shown in a list…".
const SUMMARIZER_PREAMBLE = /this summary will be shown in a list to help users/i;

/** Where the metadata cache lives: arca's own bookkeeping dir, not the vault. */
export const cacheFile = () => path.join(os.homedir(), '.claude-vault', '.arca', 'sessions-cache.json');

const textOf = (content, sep) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c && c.type === 'text').map((c) => c.text ?? '').join(sep);
};

/**
 * The last prompt someone typed, looked for from the end in a bounded window.
 *
 * A long session can end in nothing but tool results and assistant turns —
 * the user's last line then sits further back than one chunk. Reading forward
 * from the start would cost the whole file; reading the last `cap` bytes costs
 * the same as one chunk and answers the question in the case that matters.
 */
async function lastPromptFromEnd(file, size, cap = 256 * 1024) {
  const len = Math.min(cap, size);
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i].trim();
      if (!t.startsWith('{')) continue;
      let obj;
      try {
        obj = JSON.parse(t);
      } catch {
        continue; // a line cut by the window boundary
      }
      if (obj.type !== 'user') continue;
      const clean = textOf(obj.message?.content, ' ').trim();
      if (!clean || obj.isMeta || obj.isCompactSummary === true) continue;
      if (NOISE.some((p) => clean.startsWith(p))) continue;
      if (SUMMARIZER_PREAMBLE.test(clean)) continue;
      return clean.slice(0, 120);
    }
  } catch {
    // unreadable file: no last prompt, and no reason to fail the session
  } finally {
    await fh?.close().catch(() => {});
  }
  return undefined;
}

async function readEnds(file, size) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const headBuf = Buffer.alloc(Math.min(CHUNK, size));
    await fh.read(headBuf, 0, headBuf.length, 0);
    let tailBuf = Buffer.alloc(0);
    if (size > CHUNK) {
      tailBuf = Buffer.alloc(CHUNK);
      await fh.read(tailBuf, 0, CHUNK, size - CHUNK);
    }
    return { head: headBuf.toString('utf8'), tail: tailBuf.toString('utf8') };
  } catch {
    return { head: '', tail: '' };
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * Title, last prompt and cwd from the two ends of a transcript.
 *
 * A rename is appended, so the last `custom-title` in the file is the current
 * one — which is why this scans the tail after the head and lets a later one
 * overwrite. Both ends are partial reads, so a custom-title older than the last
 * 32 KB is invisible; that is the price of never parsing a whole transcript.
 */
export async function extractMeta(file, size = fs.statSync(file).size) {
  const { head, tail } = await readEnds(file, size);
  let title;
  let cwd;
  let firstPrompt;
  let lastPrompt;

  const scan = (text, isTail) => {
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      let obj;
      try {
        obj = JSON.parse(t);
      } catch {
        continue; // a line cut by the chunk boundary
      }
      if (!cwd && typeof obj.cwd === 'string') cwd = obj.cwd;
      if (obj.type === 'custom-title' && typeof obj.customTitle === 'string') {
        title = obj.customTitle;
      } else if (!title && obj.type === 'ai-title' && typeof obj.aiTitle === 'string') {
        title = obj.aiTitle;
      } else if (!title && obj.type === 'summary' && typeof obj.summary === 'string'
        && !SUMMARIZER_PREAMBLE.test(obj.summary)) {
        title = obj.summary;
      } else if (obj.type === 'user') {
        const clean = textOf(obj.message?.content, ' ').trim();
        if (!clean || obj.isMeta || obj.isCompactSummary === true) continue;
        if (NOISE.some((p) => clean.startsWith(p))) continue;
        // The summarizer's own instruction is recorded as a user turn in some
        // sessions. It is not something a person typed, and as a first prompt
        // it became the title of half the index.
        if (SUMMARIZER_PREAMBLE.test(clean)) continue;
        if (!firstPrompt && !isTail) firstPrompt = clean.slice(0, 120);
        if (isTail) lastPrompt = clean.slice(0, 120);
      }
    }
  };

  scan(head, false);
  // A transcript shorter than one chunk has no tail: the head is the whole
  // file, so it is the last prompt's only source too.
  if (tail) scan(tail, true);
  else scan(head, true);
  // The newest chunk of a long session can be all tool results. Falling back to
  // a wider window is bounded and happens only when the cheap read found nothing.
  if (!lastPrompt && size > CHUNK) lastPrompt = await lastPromptFromEnd(file, size);
  return { title: title ?? firstPrompt, lastPrompt, cwd };
}

async function pool(items, fn, width = CONCURRENCY) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

async function readCache(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Write the cache atomically and privately: it holds titles and first lines,
 * which is conversation content. A temp file created with mode 0600 and then
 * renamed never exposes a half-written cache and never inherits the permissions
 * of an older file.
 */
async function writeCache(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
    await fsp.chmod(tmp, 0o600).catch(() => {});
    await fsp.rename(tmp, file);
  } catch {
    // the cache is an acceleration, not state: without it this is just slower
    await fsp.unlink(tmp).catch(() => {});
  }
}

const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * One row per session, newest first.
 *
 * `project` matches a substring of the directory name (the encoded cwd);
 * `query` a substring of title, last prompt, cwd or id; `since` a Date or an
 * ISO string. `archived` also walks the vault and marks rows `source`.
 * `agents` admits subagent sidechains, which are excluded by default.
 *
 * Without a query the list is ordered by mtime alone, so only the `limit`
 * newest are read — stat is cheap, a 32 KB read per file is not. With a query
 * every title is needed, and there is no such shortcut.
 */
export async function listSessions({
  root = projectsDir(),
  vault = vaultDir(),
  project = '',
  query = '',
  since,
  limit = 50,
  archived = false,
  agents = false,
  cache = cacheFile(),
} = {}) {
  const sinceMs = since ? new Date(since).getTime() : null;
  if (sinceMs !== null && Number.isNaN(sinceMs)) throw new Error(`not a date: ${since}`);

  const projectLc = String(project).toLowerCase();
  const queryLc = String(query).toLowerCase();

  const entries = [];
  for (const e of walkTranscripts(root, { agents })) entries.push({ ...e, source: 'live' });
  if (archived) {
    for (const e of walkTranscripts(vault, { agents })) entries.push({ ...e, source: 'archived' });
  }

  const keep = (e) =>
    e.bytes >= 64 &&
    (!projectLc || e.project.toLowerCase().includes(projectLc)) &&
    (sinceMs === null || e.mtime >= sinceMs);

  // One session can be live and archived at once — a restored transcript stays
  // in the vault. Keeping both would list twins, so the live row wins and says
  // that a copy is also on ice.
  const byId = new Map();
  for (const e of entries) {
    if (!keep(e)) continue;
    const seen = byId.get(e.id);
    if (!seen) byId.set(e.id, e);
    else if (seen.source === 'archived' && e.source === 'live') byId.set(e.id, { ...e, alsoArchived: true });
    else if (seen.source === 'live' && e.source === 'archived') seen.alsoArchived = true;
  }

  const list = [...byId.values()].sort((a, b) => b.mtime - a.mtime);
  const needsEveryTitle = Boolean(queryLc) || !(limit > 0);
  const work = needsEveryTitle ? list : list.slice(0, limit);

  const cachePath = cache;
  const cached = await readCache(cachePath);
  const fresh = {};
  const rows = [];

  await pool(work, async (e) => {
    const key = metaKey(e.mtime, e.bytes);
    let meta = cached[e.file];
    if (!meta || meta.key !== key) {
      meta = { key, ...(await extractMeta(e.file, e.bytes)) };
    }
    fresh[e.file] = meta;
    rows.push({
      id: e.id,
      slug: e.project,
      source: e.source,
      ...(e.alsoArchived ? { alsoArchived: true } : {}),
      cwd: meta.cwd ?? '',
      title: squash(meta.title ?? meta.lastPrompt ?? '(no title)'),
      lastPrompt: squash(meta.lastPrompt),
      mtime: new Date(e.mtime).toISOString(),
      sizeBytes: e.bytes,
      file: e.file,
      _mtime: e.mtime,
    });
  });

  // A partial pass must not drop the entries it did not look at.
  await writeCache(cachePath, needsEveryTitle ? fresh : { ...cached, ...fresh });

  let out = rows;
  if (queryLc) {
    out = out.filter((r) => `${r.title} ${r.lastPrompt} ${r.cwd} ${r.id}`.toLowerCase().includes(queryLc));
  }
  out.sort((a, b) => b._mtime - a._mtime);
  if (limit > 0) out = out.slice(0, limit);

  return out.map(({ _mtime, ...rest }) => rest);
}
