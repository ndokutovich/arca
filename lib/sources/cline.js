// Cline.
//
// A VS Code extension, so its data sits in the editor's global storage:
// <editor>/User/globalStorage/saoudrizwan.claude-dev/tasks/<started-at-ms>/
//
//   api_conversation_history.json  what the model saw: Anthropic-shaped
//                                  {role, content:[{type:'text',text}]}
//   ui_messages.json               what the panel showed, with a timestamp per
//                                  entry and the index of the history message
//                                  it belongs to
//   task_metadata.json             models used, files in context
//
// Two things are worth knowing before reading it. The conversation is mostly
// tool traffic — Cline drives everything through XML tool blocks, so an
// assistant turn is often `<write_to_file>` and nothing else, which is still
// worth keeping because the file it wrote is in there. And every user turn
// carries an <environment_details> block and a TODO-list reminder, repeated
// verbatim from the first turn to the last; indexing those once per turn would
// put the same paragraph in the corpus dozens of times per task.
//
// There is no working directory field anywhere. Cline states it inside the
// conversation, in a line of its own making, and that line is the only source.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectKey } from '../history.js';

const NL = String.fromCharCode(10);
const EXTENSION = 'saoudrizwan.claude-dev';

// Cline runs in anything VS Code shaped, and more than one of them can be
// installed at once.
const EDITORS = ['Code', 'Cursor', 'VSCodium', 'Windsurf', 'Code - Insiders'];

function candidateRoots() {
  if (process.env.ARCA_CLINE_DIR) return [process.env.ARCA_CLINE_DIR];
  const home = os.homedir();
  const bases = [];
  if (process.env.APPDATA) bases.push(process.env.APPDATA);                        // Windows
  bases.push(path.join(home, 'Library', 'Application Support'));                   // macOS
  bases.push(path.join(home, '.config'));                                          // Linux

  const out = [];
  for (const base of bases) {
    for (const editor of EDITORS) {
      out.push(path.join(base, editor, 'User', 'globalStorage', EXTENSION));
    }
  }
  return out;
}

function taskCount(root) {
  try {
    return fs.readdirSync(path.join(root, 'tasks'), { withFileTypes: true })
      .filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * Strip what the extension injects into every turn.
 * The environment block and the todo reminder are identical from the first
 * turn to the last, and a task is dozens of turns long.
 */
function clean(text) {
  if (typeof text !== 'string') return '';
  // The reminder arrives as a content block of its own, so it is recognised
  // whole rather than carved out of surrounding text — a lazy match with the
  // multiline flag stops at the first line end and leaves the rest behind,
  // which is exactly what the first version of this did.
  if (/^#\s*TODO LIST RECOMMENDED/.test(text.trim())) return '';
  const out = text.replace(/<environment_details>[\s\S]*?<\/environment_details>/g, '');
  // <task>…</task> wraps what the person actually typed.
  const task = out.match(/<task>([\s\S]*?)<\/task>/);
  if (task) {
    const rest = out.replace(/<task>[\s\S]*?<\/task>/, '').trim();
    return rest ? `${task[1].trim()}${NL}${NL}${rest}` : task[1].trim();
  }
  return out.trim();
}

function textOf(content) {
  if (typeof content === 'string') return clean(content);
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => clean(b.text))
    .filter(Boolean)
    .join(NL)
    .trim();
}

/** history index -> the earliest time the panel showed anything for it */
function timesByIndex(dir) {
  const ui = readJson(path.join(dir, 'ui_messages.json'));
  const map = new Map();
  if (!Array.isArray(ui)) return map;
  for (const entry of ui) {
    const i = entry?.conversationHistoryIndex;
    if (!Number.isInteger(i) || !Number.isFinite(entry.ts)) continue;
    if (!map.has(i) || entry.ts < map.get(i)) map.set(i, entry.ts);
  }
  return map;
}

export default {
  id: 'cline',
  label: 'Cline',
  verifiedAgainst: 'live',

  detect() {
    const found = candidateRoots()
      .map((root) => ({ root, tasks: taskCount(root) }))
      .filter((r) => r.tasks > 0)
      .sort((a, b) => b.tasks - a.tasks);
    if (!found.length) return { present: false, root: null };
    const note = found.length > 1
      ? `installed in ${found.length} editors; reading the fullest (${found.map((f) => `${path.basename(path.dirname(path.dirname(path.dirname(f.root))))}:${f.tasks}`).join(', ')})`
      : undefined;
    return { present: true, root: found[0].root, note };
  },

  discover(root) {
    let dirs = [];
    try {
      dirs = fs.readdirSync(path.join(root, 'tasks'), { withFileTypes: true })
        .filter((e) => e.isDirectory());
    } catch { return []; }

    const out = [];
    for (const d of dirs) {
      const dir = path.join(root, 'tasks', d.name);
      const history = path.join(dir, 'api_conversation_history.json');
      if (!fs.existsSync(history)) continue;

      // Cline names the directory after the millisecond the task started, and
      // states the working directory inside the conversation rather than
      // beside it.
      let cwd = null;
      const raw = (() => {
        try { return fs.readFileSync(history, 'utf8'); } catch { return ''; }
      })();
      const m = raw.match(/Current Working Directory \(([^)]{1,300})\)/);
      if (m) cwd = m[1].trim();

      let mtime = 0;
      try { mtime = Math.max(...[history, path.join(dir, 'ui_messages.json')]
        .map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } })); } catch { /* keep 0 */ }

      out.push({
        sessionId: d.name,
        cwd,
        project: cwd ? projectKey(cwd) : 'cline-unknown',
        file: dir,
        mtime,
      });
    }
    return out;
  },

  read(dir) {
    const history = readJson(path.join(dir, 'api_conversation_history.json'));
    if (!Array.isArray(history)) return [];
    const times = timesByIndex(dir);
    // The directory name is the millisecond the task started — the fallback
    // for any turn the panel has no record of.
    const started = Number(path.basename(dir)) || null;

    const turns = [];
    history.forEach((m, i) => {
      if (!m || (m.role !== 'user' && m.role !== 'assistant')) return;
      const text = textOf(m.content);
      if (!text) return;
      const ts = times.get(i) ?? started;
      turns.push({
        role: m.role,
        text,
        ts: ts ? new Date(ts).toISOString() : undefined,
      });
    });
    return turns;
  },
};
