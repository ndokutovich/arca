// Codex CLI.
//
// ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl, plus an
// archived_sessions/ beside it with the same shape.
//
// Every line is {timestamp, type, payload}. Four types matter:
//
//   session_meta   once, first: payload.id and payload.cwd
//   response_item  the model transcript; payload.type 'message' carries a role
//                  and content blocks, other payload types are tool calls and
//                  reasoning
//   event_msg      the UI event stream, which duplicates assistant turns as
//                  'agent_message' — read one or the other, never both
//   compacted      a compaction boundary
//
// Roles are user, assistant and developer. Developer is protocol — sandbox
// policy, instructions — and Codex never shows it as a turn, so neither do we.
// Some user messages are injections too (<environment_context>, <user_action>),
// but lib/noise.js already recognises that shape for Claude Code transcripts
// and there is no reason to treat the same thing differently here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { projectKey } from '../history.js';

const NL = String.fromCharCode(10);

function root() {
  return process.env.ARCA_CODEX_DIR || path.join(os.homedir(), '.codex');
}

/** Session files live under dated directories, so this walks depth-first. */
function* walk(dir, depth = 0) {
  if (depth > 6) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, depth + 1);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p;
  }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (typeof b === 'string' ? b : (b && typeof b.text === 'string' ? b.text : '')))
    .filter(Boolean)
    .join(NL)
    .trim();
}

/**
 * Read only as far as the first session_meta.
 *
 * Discovery needs the id and the working directory, and nothing else. Parsing
 * whole files here would mean reading the entire corpus twice — and on this
 * machine that corpus is 3.3 GB.
 */
function head(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    if (!read) return null;
    const first = buf.toString('utf8', 0, read).split(NL, 1)[0];
    if (!first) return null;
    const rec = JSON.parse(first);
    if (rec.type !== 'session_meta') return null;
    return rec.payload || null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

export default {
  id: 'codex',
  label: 'Codex CLI',
  verifiedAgainst: 'live',

  detect() {
    const base = root();
    const sessions = path.join(base, 'sessions');
    const archived = path.join(base, 'archived_sessions');
    const present = fs.existsSync(sessions) || fs.existsSync(archived);
    return { present, root: present ? base : null };
  },

  discover(base) {
    const out = [];
    for (const dir of ['sessions', 'archived_sessions']) {
      const start = path.join(base, dir);
      if (!fs.existsSync(start)) continue;
      for (const file of walk(start)) {
        const meta = head(file);
        // No session_meta means no id and no cwd. Naming it after the file
        // would invent a session id that nothing else in the corpus shares.
        if (!meta || !meta.id) continue;
        let mtime = 0;
        try { mtime = fs.statSync(file).mtimeMs; } catch { /* keep 0 */ }
        out.push({
          sessionId: meta.id,
          cwd: meta.cwd || null,
          project: projectKey(meta.cwd) || 'codex-unknown',
          file,
          mtime,
        });
      }
    }
    return out;
  },

  read(file) {
    const turns = [];
    // Line-by-line rather than a whole-file read: single sessions here reach
    // tens of megabytes, and the biggest transcript in this corpus is 530 MB.
    //
    // Through a StringDecoder, because a chunk boundary lands mid-character
    // sooner or later and Buffer.toString would hand back two replacement
    // characters where one letter was. It corrupts a single word in a single
    // turn, which nothing downstream would ever report.
    const fd = fs.openSync(file, 'r');
    const decoder = new StringDecoder('utf8');
    const chunk = Buffer.alloc(1 << 20);
    let carry = '';
    try {
      for (;;) {
        const read = fs.readSync(fd, chunk, 0, chunk.length, null);
        if (read === 0) break;
        const parts = (carry + decoder.write(chunk.subarray(0, read))).split(NL);
        carry = parts.pop() ?? '';
        for (const l of parts) collect(l, turns);
      }
      carry += decoder.end();
      if (carry.trim()) collect(carry, turns);
    } finally {
      fs.closeSync(fd);
    }
    return turns;
  },
};

function collect(l, turns) {
  if (!l.trim()) return;
  let rec;
  try { rec = JSON.parse(l); } catch { return; }
  if (rec.type !== 'response_item') return;
  const p = rec.payload;
  if (!p || p.type !== 'message') return;
  if (p.role !== 'user' && p.role !== 'assistant') return;
  const text = textOf(p.content);
  if (!text) return;
  turns.push({ role: p.role, text, ts: rec.timestamp });
}
