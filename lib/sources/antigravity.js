// Antigravity.
//
// ~/.gemini/antigravity/brain/<uuid>/ — one directory per session, holding the
// documents it produced (task.md, implementation_plan.md, walkthrough.md,
// code_review.md) and, under .system_generated/logs/, a transcript.
//
// The transcript is not a conversation. It records what the user asked, what
// the model was thinking, and every tool call — but a PLANNER_RESPONSE carries
// `thinking` and `tool_calls` and nothing else. Antigravity never writes its
// replies to disk at all.
//
// What it writes instead is the documents, and walkthrough.md reads exactly
// like the reply: "Игра успешно создана и готова к запуску! Я использовал…".
// So a session becomes what was asked and what came of it, and that is said
// plainly here and in the README rather than dressed up as a transcript.
//
// There is no working directory anywhere in the data: Antigravity works inside
// its own brain directory, so every session is filed under `antigravity` and
// none pretends to belong to a project it cannot name.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NL = String.fromCharCode(10);

// walkthrough first: it is the report. The rest is what the report is about.
const ARTIFACTS = ['walkthrough.md', 'implementation_plan.md', 'task.md', 'code_review.md'];

function root() {
  return process.env.ARCA_ANTIGRAVITY_DIR
    || path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/**
 * The request, without the wrappers the CLI staples around it.
 * A USER_INPUT is <USER_REQUEST>…</USER_REQUEST> followed by blocks of local
 * time and settings changes, none of which anyone typed.
 */
function requestText(content) {
  if (typeof content !== 'string') return '';
  const m = content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  if (m) return m[1].trim();
  // No wrapper: drop the trailing metadata blocks and keep the rest.
  return content.split('<ADDITIONAL_METADATA>')[0].trim();
}

function requests(dir) {
  const file = path.join(dir, '.system_generated', 'logs', 'transcript.jsonl');
  const raw = readText(file);
  if (!raw) return [];
  const out = [];
  for (const l of raw.split(NL)) {
    if (!l.trim()) continue;
    let rec;
    try { rec = JSON.parse(l); } catch { continue; }
    if (rec.type !== 'USER_INPUT') continue;
    const text = requestText(rec.content);
    if (text) out.push({ text, ts: rec.created_at });
  }
  return out;
}

function artifacts(dir) {
  const parts = [];
  const summaries = [];
  let newest = null;
  for (const name of ARTIFACTS) {
    // `.resolved` and `.resolved.N` beside these are earlier versions; only
    // the bare document is current.
    const body = readText(path.join(dir, name));
    if (!body || !body.trim()) continue;
    parts.push(`## ${name}${NL}${NL}${body.trim()}`);
    const meta = readText(path.join(dir, `${name}.metadata.json`));
    if (meta) {
      try {
        const { updatedAt, summary } = JSON.parse(meta);
        if (updatedAt && (!newest || updatedAt > newest)) newest = updatedAt;
        if (summary) summaries.push(summary);
      } catch { /* the document is what matters */ }
    }
  }
  return { text: parts.join(`${NL}${NL}`), ts: newest, summaries };
}

export default {
  id: 'antigravity',
  label: 'Antigravity',
  verifiedAgainst: 'live',

  detect() {
    const base = root();
    const present = fs.existsSync(base);
    return { present, root: present ? base : null };
  },

  discover(base) {
    let dirs = [];
    try {
      dirs = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch { return []; }

    const out = [];
    for (const d of dirs) {
      const dir = path.join(base, d.name);
      let mtime = 0;
      try { mtime = fs.statSync(dir).mtimeMs; } catch { /* keep 0 */ }
      out.push({
        sessionId: d.name,
        cwd: null,
        project: 'antigravity',
        file: dir,
        mtime,
      });
    }
    return out;
  },

  read(dir) {
    const asked = requests(dir);
    const made = artifacts(dir);
    if (!asked.length && !made.text) return [];

    // One exchange, not one per request. The documents are the outcome of the
    // whole session and cannot be attributed to any single ask — and a request
    // with nothing after it is dropped by the parser, so splitting them would
    // lose every request but the last.
    const turns = [];
    if (asked.length) {
      turns.push({
        role: 'user',
        text: asked.map((r) => r.text).join(`${NL}${NL}`),
        ts: asked[0].ts,
      });
    } else if (made.text) {
      // Some sessions keep their documents and no transcript. An exchange
      // needs something on the user side or the parser drops it, and with it
      // every word of the work. This is a label, not a reconstruction, and it
      // is written so that it reads as one — the same choice the claude.ai
      // project importer makes for a project that is all standing context.
      const what = made.summaries.length ? `: ${made.summaries.join('; ')}` : '';
      turns.push({
        role: 'user',
        text: `Antigravity session ${path.basename(dir)}${what}`,
        ts: made.ts,
      });
    }
    if (made.text) {
      turns.push({
        role: 'assistant',
        text: made.text,
        ts: made.ts || asked[asked.length - 1]?.ts,
      });
    }
    return turns;
  },
};
