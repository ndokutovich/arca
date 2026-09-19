// Reading other assistants' history.
//
// arca's retrieval engine never knew anything about Claude Code: it takes text
// and gives back ranked text. Only the way in was Claude-shaped. A source
// adapter is the way in for everyone else — it finds sessions and reads them
// into turns, and lib/transcript-write.js turns those into the JSONL the
// existing parser, indexer and layers already handle. No layer below here
// learns a second format.
//
// An adapter is deliberately small. The history viewer's equivalents also do
// pagination, search, stats and writes; arca has its own and needs none of it.
//
//   {
//     id, label,
//     verifiedAgainst: 'live' | 'fixtures',
//     detect()               -> { present, root, note? }
//     discover(root)         -> [{ sessionId, project, cwd, file, mtime }]
//     read(file, session)    -> [{ role, text, ts }]
//     dispose?()             release anything held open
//   }
//
// `file` is a locator the adapter understands, not necessarily a path: most
// hand back a file, OpenCode a session document, Antigravity a directory and
// Cursor a database — which is why `read` gets the whole session row too.
import fs from 'node:fs';
import path from 'node:path';
import { vaultDir } from '../transcripts.js';
import { line, writeConversation, newStats } from '../transcript-write.js';
import codex from './codex.js';
import opencode from './opencode.js';
import gemini from './gemini.js';
import antigravity from './antigravity.js';
import cline from './cline.js';
import cursor from './cursor.js';

export const ADAPTERS = [codex, opencode, gemini, antigravity, cline, cursor];

export function byId(id) {
  return ADAPTERS.find((a) => a.id === id) || null;
}

/**
 * What is on this machine.
 * A provider that is simply not installed is not an error, and must never be
 * reported as one.
 */
export function detectAll() {
  return ADAPTERS.map((a) => {
    let found = { present: false, root: null };
    try { found = a.detect() || found; }
    catch (e) { found = { present: false, root: null, note: `detection failed: ${e.message}` }; }
    return { id: a.id, label: a.label, verifiedAgainst: a.verifiedAgainst, ...found };
  });
}

/**
 * Fold one source's sessions into the vault.
 *
 * Sessions land in the same project directories as Claude Code, keyed the same
 * way — a Codex session run in a directory really is the same project as a
 * Claude session run there, and the entity and thread layers are better for
 * seeing both. Session ids come from different id spaces, so nothing collides.
 *
 * @param {object} adapter
 * @param {{dryRun?: boolean, log?: (m: string) => void, force?: boolean}} opts
 */
export function importSource(adapter, { dryRun = false, log = () => {}, force = false } = {}) {
  const stats = newStats();
  const found = adapter.detect();
  if (!found || !found.present) {
    stats.absent = true;
    return stats;
  }

  let sessions = [];
  try { sessions = adapter.discover(found.root) || []; }
  catch (e) {
    stats.unreadable++;
    log(`${adapter.id}: could not list sessions (${e.message})`);
    return stats;
  }

  const vault = vaultDir();
  for (const s of sessions) {
    stats.conversations++;
    const destDir = path.join(vault, s.project || 'unknown');
    const dest = path.join(destDir, `${s.sessionId}.jsonl`);

    // Re-reading 3 GB to discover nothing changed is the difference between a
    // usable command and one nobody runs twice. The byte comparison in
    // writeConversation still backstops this; the mtime only skips the read.
    if (!force && s.mtime) {
      try {
        if (fs.statSync(dest).mtimeMs >= s.mtime) { stats.unchanged++; continue; }
      } catch { /* not archived yet */ }
    }

    let turns;
    // `file` is whatever locator the adapter handed back — a path for most of
    // them, a database for Cursor, which also needs the session row to know
    // which conversation inside it to read.
    try { turns = adapter.read(s.file, s) || []; }
    catch (e) {
      stats.unreadable++;
      log(`${adapter.id}: ${path.basename(s.file)} unreadable (${e.message})`);
      continue;
    }

    const rows = turns
      .filter((t) => t && typeof t.text === 'string' && t.text.trim())
      .map((t) => line({
        role: t.role,
        text: t.text,
        ts: t.ts,
        sessionId: s.sessionId,
        cwd: s.cwd || null,
        source: adapter.id,
      }));

    writeConversation(destDir, s.sessionId, rows, stats, dryRun);
  }

  // An adapter holding a database open stops the vault being moved or tidied
  // afterwards, and on Windows that is an EPERM rather than a warning.
  try { adapter.dispose?.(); } catch { /* nothing to release */ }
  return stats;
}
