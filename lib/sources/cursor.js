// Cursor.
//
// Everything lives in SQLite, and not where the obvious place would be. Each
// workspace has a state.vscdb holding `aiService.prompts` — the things typed,
// with no replies and no timestamps — while the conversations themselves are
// global:
//
//   <Cursor>/User/globalStorage/state.vscdb
//     cursorDiskKV
//       composerData:<composerId>              a session: name, createdAt
//       bubbleId:<composerId>:<bubbleId>       one message
//
// A bubble's `type` is 1 for the person and 2 for Cursor. Most bubbles carry
// no text at all — they are diffs, tool results and checkpoints — and most
// composers have no texted bubbles either, because an opened-and-abandoned
// composer is still a row.
//
// composerData has a `fullConversationHeadersOnly` list that would give the
// order, and on this machine 55 of 58 sessions have it empty. The bubble key
// carries the composer id, so the messages are grouped from the key and
// ordered by their own createdAt instead.
//
// There is no workspace field. What there is, scattered through the session's
// context, are file:// URIs — so the working directory is the longest path
// they all share.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { projectKey } from '../history.js';

const NL = String.fromCharCode(10);
const URI = /file:\/\/\/[^"\\]{5,400}/g;

function candidates() {
  if (process.env.ARCA_CURSOR_DIR) return [process.env.ARCA_CURSOR_DIR];
  const home = os.homedir();
  const bases = [];
  if (process.env.APPDATA) bases.push(process.env.APPDATA);
  bases.push(path.join(home, 'Library', 'Application Support'));
  bases.push(path.join(home, '.config'));
  return bases.map((b) => path.join(b, 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
}

// Opened read-only and kept for the run: discover and read both need it, and
// a session is one query rather than one connection.
const cache = new Map();

function open(file) {
  if (cache.has(file)) return cache.get(file);
  let db = null;
  try { db = new DatabaseSync(file, { readOnly: true }); } catch { db = null; }
  cache.set(file, db);
  return db;
}

/**
 * Let go of the database.
 * Windows will not delete a file something still holds open, so a cached
 * handle turns a tidy-up into an EPERM — in a test, and in anything that
 * imports and then moves the vault.
 */
function dispose() {
  for (const db of cache.values()) {
    try { db?.close(); } catch { /* already gone */ }
  }
  cache.clear();
}

function parse(value) {
  try { return JSON.parse(String(value)); } catch { return null; }
}

/**
 * The directory every referenced file sits under.
 * With a single file referenced the shared prefix is that file, so the last
 * segment comes off — otherwise a session is filed under a project named
 * after a README.
 */
function commonDirectory(json) {
  const uris = [...json.matchAll(URI)]
    .map((m) => { try { return decodeURIComponent(m[0].replace('file:///', '')); } catch { return ''; } })
    .filter(Boolean);
  if (!uris.length) return null;

  const split = uris.map((u) => u.split('/'));
  const common = [];
  for (let i = 0; ; i++) {
    const seg = split[0][i];
    if (seg === undefined || !split.every((s) => s[i] === seg)) break;
    common.push(seg);
  }
  if (!common.length) return null;
  const joined = common.join('/');
  return uris.includes(joined) ? common.slice(0, -1).join('/') || null : joined;
}

/** composerId -> its texted bubbles, in the order they happened */
function bubbles(db) {
  const byComposer = new Map();
  let rows = [];
  try {
    rows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'").all();
  } catch { return byComposer; }

  for (const row of rows) {
    const cid = String(row.key).split(':')[1];
    if (!cid) continue;
    const b = parse(row.value);
    if (!b || typeof b.text !== 'string' || !b.text.trim()) continue;
    const role = b.type === 1 ? 'user' : b.type === 2 ? 'assistant' : null;
    if (!role) continue;
    if (!byComposer.has(cid)) byComposer.set(cid, []);
    byComposer.get(cid).push({ role, text: b.text.trim(), ts: b.createdAt || null });
  }
  for (const list of byComposer.values()) {
    list.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  }
  return byComposer;
}

export default {
  id: 'cursor',
  label: 'Cursor',
  verifiedAgainst: 'live',
  dispose,

  detect() {
    for (const file of candidates()) {
      if (fs.existsSync(file)) return { present: true, root: file };
    }
    return { present: false, root: null };
  },

  discover(file) {
    const db = open(file);
    if (!db) return [];
    const texted = bubbles(db);
    if (!texted.size) return [];

    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { /* keep 0 */ }

    // Sessions are the composers that actually said something. An opened and
    // abandoned composer is still a row, and there are far more of those.
    const meta = new Map();
    try {
      for (const row of db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all()) {
        const cid = String(row.key).split(':')[1];
        if (!texted.has(cid)) continue;
        meta.set(cid, { json: String(row.value), data: parse(row.value) });
      }
    } catch { /* the bubbles are enough */ }

    const out = [];
    for (const cid of texted.keys()) {
      const m = meta.get(cid);
      const cwd = m ? commonDirectory(m.json) : null;
      out.push({
        sessionId: cid,
        cwd,
        project: cwd ? projectKey(cwd) : 'cursor-unknown',
        file,
        mtime,
        title: m?.data?.name || null,
      });
    }
    return out;
  },

  read(file, session) {
    const db = open(file);
    if (!db || !session?.sessionId) return [];
    const turns = bubbles(db).get(session.sessionId) || [];
    if (!turns.length) return [];
    // The composer's name is the only thing that says what a session was for,
    // and it is not a message — so it leads the first turn rather than
    // becoming one.
    if (session.title && turns[0].role === 'user') {
      return [{ ...turns[0], text: `${session.title}${NL}${NL}${turns[0].text}` }, ...turns.slice(1)];
    }
    return turns;
  },
};
