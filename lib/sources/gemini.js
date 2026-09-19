// Gemini CLI.
//
// ~/.gemini/tmp/<project>/chats/session-<date>-<id>.json, one JSON document
// per session with a flat `messages` array.
//
// A message has no `role`. It has a `type`, which is either `user` — whose
// content is an array of {text} blocks — or `gemini`, whose content is a plain
// string. Documentation and the fixture files that ship alongside real data
// both show a `role` field and a uniform content shape; neither matches what
// the CLI actually writes, which is why this is built from the files.
//
// The directory under tmp/ is a short project name, not a path, so it cannot
// be turned into the key Claude Code would use. ~/.gemini/projects.json holds
// the mapping the other way round — full path to short name — and inverting it
// is what lets a Gemini session share a project with a Claude Code one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectKey } from '../history.js';

const NL = String.fromCharCode(10);

function root() {
  return process.env.ARCA_GEMINI_DIR || path.join(os.homedir(), '.gemini');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** short project name -> the working directory it stands for */
function projectPaths(base) {
  const doc = readJson(path.join(base, 'projects.json'));
  const map = new Map();
  const entries = doc && doc.projects && typeof doc.projects === 'object' ? doc.projects : {};
  for (const [fullPath, short] of Object.entries(entries)) {
    if (typeof short === 'string' && short && !map.has(short)) map.set(short, fullPath);
  }
  return map;
}

function textOf(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'string' ? b : (b && typeof b.text === 'string' ? b.text : '')))
      .filter(Boolean)
      .join(NL)
      .trim();
  }
  if (content && typeof content.text === 'string') return content.text.trim();
  return '';
}

export default {
  id: 'gemini',
  label: 'Gemini CLI',
  verifiedAgainst: 'live',

  detect() {
    const base = root();
    const present = fs.existsSync(path.join(base, 'tmp'));
    return { present, root: present ? base : null };
  },

  discover(base) {
    const paths = projectPaths(base);
    const out = [];
    let dirs = [];
    try {
      dirs = fs.readdirSync(path.join(base, 'tmp'), { withFileTypes: true })
        .filter((e) => e.isDirectory());
    } catch { return out; }

    for (const dir of dirs) {
      const chats = path.join(base, 'tmp', dir.name, 'chats');
      let files = [];
      try {
        files = fs.readdirSync(chats).filter((f) => f.startsWith('session-') && f.endsWith('.json'));
      } catch { continue; }

      const cwd = paths.get(dir.name) || null;
      for (const name of files) {
        const file = path.join(chats, name);
        const doc = readJson(file);
        if (!doc || !Array.isArray(doc.messages)) continue;
        const id = typeof doc.sessionId === 'string' && doc.sessionId
          ? doc.sessionId
          : name.replace(/\.json$/, '');
        let mtime = 0;
        try { mtime = fs.statSync(file).mtimeMs; } catch { /* keep 0 */ }
        out.push({
          sessionId: id,
          cwd,
          // Without the mapping there is no path to key on, and guessing one
          // would silently merge unrelated work into a real project.
          project: cwd ? projectKey(cwd) : `gemini-${dir.name}`,
          file,
          mtime,
        });
      }
    }
    return out;
  },

  read(file) {
    const doc = readJson(file);
    if (!doc || !Array.isArray(doc.messages)) return [];
    const turns = [];
    for (const m of doc.messages) {
      if (!m) continue;
      // `type` is where the role lives, and `role` is where it does not.
      const kind = m.type || m.role;
      const role = kind === 'user' ? 'user'
        : (kind === 'gemini' || kind === 'model' || kind === 'assistant') ? 'assistant'
          : null;
      if (!role) continue;
      const text = textOf(m.content);
      if (!text) continue;
      turns.push({ role, text, ts: m.timestamp || doc.startTime });
    }
    return turns;
  },
};
