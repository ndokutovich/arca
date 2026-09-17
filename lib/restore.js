// Bring back a session Claude Code no longer has.
//
// The vault keeps every transcript it ever archived; ~/.claude/projects/ does
// not. Sessions disappear from there — cleanup, a reinstall, a machine move —
// while the vault still holds them. On the corpus this was built against, four
// out of five archived sessions exist only in the vault. Restoring one copies
// it back into the exact path Claude Code reads, so `claude --resume` lists it
// again and the work continues where it stopped.
//
// The transcript is the same bytes either way; nothing is rewritten. The only
// judgement here is about size: the resume parser chokes on very large files,
// so a restore reports the size and says so rather than handing back something
// that will fail to open.
import fs from 'fs';
import os from 'os';
import path from 'path';

const VAULT_DIR = path.join(os.homedir(), '.claude-vault');
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// Thresholds the resume parser starts struggling at, in bytes.
const WARN_BYTES = 50 * 1024 * 1024;
const DANGER_BYTES = 100 * 1024 * 1024;

const SKIP_DIRS = new Set(['index', '.git', 'node_modules']);

function isTranscript(name) {
  return name.endsWith('.jsonl') && !name.startsWith('agent-');
}

/** Every archived transcript, as { id, project, file, bytes, mtime }. */
function walkVault() {
  const out = [];
  let projects;
  try {
    projects = fs.readdirSync(VAULT_DIR, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const dir of projects) {
    if (!dir.isDirectory() || SKIP_DIRS.has(dir.name)) continue;
    const projDir = path.join(VAULT_DIR, dir.name);
    let files;
    try {
      files = fs.readdirSync(projDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !isTranscript(f.name)) continue;
      const file = path.join(projDir, f.name);
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      out.push({
        id: f.name.replace(/\.jsonl$/, ''),
        project: dir.name,
        file,
        bytes: st.size,
        mtime: st.mtimeMs,
      });
    }
  }
  return out;
}

const livePath = (project, id) => path.join(PROJECTS_DIR, project, `${id}.jsonl`);

/** True when Claude Code still has this session under the same project slug. */
function isLive(project, id) {
  return fs.existsSync(livePath(project, id));
}

/**
 * Sessions held by the vault that Claude Code no longer has.
 * Enriched from the index when it is available, so the listing can show what a
 * session was about rather than only a uuid.
 */
export function listRestorable({ limit = 20, project = null, db = null, includeImported = false } = {}) {
  let rows = walkVault().filter((s) => !isLive(s.project, s.id));
  // claude.ai conversations enter the vault as synthetic transcripts under
  // claude-ai-* project slugs. They index and search like everything else, but
  // they were never Claude Code sessions, so putting them back into
  // ~/.claude/projects/ would offer a resume that never existed.
  if (!includeImported) {
    rows = rows.filter((s) => !s.project.startsWith('claude-ai'));
  }
  if (project) {
    const needle = project.toLowerCase();
    rows = rows.filter((s) => s.project.toLowerCase().includes(needle));
  }

  if (db) {
    const stmt = db.prepare(
      `SELECT count(*) n, min(date(timestamp)) first, max(date(timestamp)) last
         FROM exchanges WHERE session_id = ?`
    );
    for (const s of rows) {
      try {
        const r = stmt.get(s.id);
        if (r && r.n) {
          s.exchanges = r.n;
          s.first = r.first;
          s.last = r.last;
        }
      } catch {
        // an unindexed session is still restorable; it just lists thinner
      }
    }
  }

  rows.sort((a, b) => (b.last || '').localeCompare(a.last || '') || b.mtime - a.mtime);
  return limit > 0 ? rows.slice(0, limit) : rows;
}

/** Size note for a transcript, or null when it is comfortably small. */
export function sizeNote(bytes) {
  if (bytes >= DANGER_BYTES) {
    return `${(bytes / 1048576).toFixed(0)} MB — very likely too large for resume to open; fork it from its last compact boundary instead`;
  }
  if (bytes >= WARN_BYTES) {
    return `${(bytes / 1048576).toFixed(0)} MB — large enough that resume may struggle`;
  }
  return null;
}

/**
 * Copy an archived session back into ~/.claude/projects/ so Claude Code can
 * resume it. Refuses to clobber a live transcript unless asked: the live copy
 * may hold turns the archive never saw.
 */
export function restoreSession(id, { force = false } = {}) {
  const matches = walkVault().filter((s) => s.id === id || s.id.startsWith(id));
  // An explicit id may name an imported conversation; restoring one is allowed
  // when asked for by name, only never offered by the listing.
  if (matches.length === 0) {
    throw new Error(`no archived session matches "${id}"`);
  }
  if (matches.length > 1) {
    const names = matches.slice(0, 5).map((m) => `${m.id} (${m.project})`).join(', ');
    throw new Error(`"${id}" matches ${matches.length} sessions: ${names}`);
  }

  const s = matches[0];
  const target = livePath(s.project, s.id);
  const existed = fs.existsSync(target);
  if (existed && !force) {
    throw new Error(
      `${s.id} is already in ~/.claude/projects/${s.project}/ — the live copy may be newer than the archive; pass --force to overwrite it`
    );
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(s.file, target);

  return {
    id: s.id,
    project: s.project,
    from: s.file,
    to: target,
    bytes: s.bytes,
    note: sizeNote(s.bytes),
    overwrote: existed,
  };
}
