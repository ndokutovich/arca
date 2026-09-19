// OpenCode.
//
// ~/.local/share/opencode/storage, or $XDG_DATA_HOME/opencode/storage, laid
// out as four tables of one-JSON-file-per-row:
//
//   project/<projectID>.json          worktree path
//   session/<projectID>/<sesID>.json  directory, title, times
//   message/<sesID>/<msgID>.json      role and time — but no text
//   part/<msgID>/<prtID>.json         the text, one part at a time
//
// A message carries no content at all; reading one means a three-way walk down
// to its parts. On this machine that is 120 sessions spread over 11,167 files.
//
// Parts come in five types — text, reasoning, tool, step-start, step-finish —
// and only `text` is conversation. A part marked synthetic was generated
// rather than said, so it is not either.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectKey } from '../history.js';

const NL = String.fromCharCode(10);

function storageRoots() {
  if (process.env.ARCA_OPENCODE_DIR) return [process.env.ARCA_OPENCODE_DIR];
  const roots = [];
  if (process.env.XDG_DATA_HOME) roots.push(path.join(process.env.XDG_DATA_HOME, 'opencode'));
  roots.push(path.join(os.homedir(), '.local', 'share', 'opencode'));
  return roots;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function listFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

function mtimeOf(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

/**
 * The storage directory a session file belongs to.
 *
 * read() is handed a path and nothing else, and the messages live in a sibling
 * tree. Walking up until both sibling tables appear is steadier than counting
 * directory levels — sessions sit one level deep under a project id, except
 * the ones under `global`, which look identical.
 */
function storageOf(sessionFile) {
  let dir = path.dirname(sessionFile);
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'message')) && fs.existsSync(path.join(dir, 'part'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

export default {
  id: 'opencode',
  label: 'OpenCode',
  verifiedAgainst: 'live',

  detect() {
    for (const base of storageRoots()) {
      const storage = path.join(base, 'storage');
      if (fs.existsSync(path.join(storage, 'session'))) return { present: true, root: storage };
      // ARCA_OPENCODE_DIR may point at the storage directory itself.
      if (fs.existsSync(path.join(base, 'session'))) return { present: true, root: base };
    }
    return { present: false, root: null };
  },

  discover(storage) {
    const out = [];
    for (const projectDir of listDirs(path.join(storage, 'session'))) {
      for (const file of listFiles(projectDir)) {
        const session = readJson(file);
        if (!session || !session.id) continue;
        // `directory` is the worktree this session ran in, which is what makes
        // it the same project as a Claude Code session run in the same place.
        const cwd = session.directory || null;
        out.push({
          sessionId: session.id,
          cwd,
          project: projectKey(cwd) || 'opencode-unknown',
          file,
          // A session file is rewritten when its summary changes, but new
          // messages land in a sibling directory — take whichever moved last,
          // or an ongoing session looks unchanged forever.
          mtime: Math.max(mtimeOf(file), mtimeOf(path.join(storage, 'message', session.id))),
        });
      }
    }
    return out;
  },

  read(sessionFile) {
    const storage = storageOf(sessionFile);
    const session = readJson(sessionFile);
    if (!storage || !session || !session.id) return [];

    const messages = listFiles(path.join(storage, 'message', session.id))
      .map(readJson)
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
      .sort((a, b) => (a.time?.created || 0) - (b.time?.created || 0));

    const turns = [];
    for (const m of messages) {
      // Parts are named with a monotonic id, and their own time fields are
      // zero in practice, so the id is the only ordering there is.
      const parts = listFiles(path.join(storage, 'part', m.id))
        .sort()
        .map(readJson)
        .filter((p) => p && p.type === 'text' && !p.synthetic && typeof p.text === 'string');

      const text = parts.map((p) => p.text).join(NL).trim();
      if (!text) continue;
      turns.push({
        role: m.role,
        text,
        ts: m.time?.created ? new Date(m.time.created).toISOString() : undefined,
      });
    }
    return turns;
  },
};
