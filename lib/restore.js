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
import path from 'path';
import { vaultDir, projectsDir, walkTranscripts, sizeNote } from './transcripts.js';

const livePath = (project, id) => path.join(projectsDir(), project, `${id}.jsonl`);

// What an interrupted copy leaves behind — the hook's .tmp and .tmp-*, a
// restore's own .arca-tmp-*. Never a file of the session; putting one back
// would hand Claude Code half a tool result under a name it never wrote.
const HALF_WRITTEN = /\.tmp$|\.tmp-|\.arca-tmp-/;

/**
 * Put back what is missing from a session's directory: subagents/, the
 * tool-results/ its transcript points at, the .meta.json beside each agent.
 * A file already there is never replaced — not even under --force, which is a
 * decision about the transcript. The live directory may hold output the
 * archive has not seen yet, and nothing here can tell which copy is newer.
 */
function restoreSessionDir(from, to) {
  const out = { restored: 0, failed: 0 };
  const walk = (src, dst) => {
    let entries;
    try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const a = path.join(src, e.name);
      const b = path.join(dst, e.name);
      if (e.isDirectory()) { walk(a, b); continue; }
      if (!e.isFile() || HALF_WRITTEN.test(e.name) || fs.existsSync(b)) continue;
      const tmp = `${b}.arca-tmp-${process.pid}`;
      try {
        fs.mkdirSync(dst, { recursive: true });
        fs.copyFileSync(a, tmp);
        fs.renameSync(tmp, b);
        out.restored++;
      } catch {
        try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
        out.failed++;
      }
    }
  };
  walk(from, to);
  return out;
}

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
  let rows = walkTranscripts(vaultDir()).filter((s) => !isLive(s.project, s.id));
  // A conversation that was never a Claude Code session cannot be resumed as
  // one, so offering to put it back would be offering something that never
  // existed. That is true of a claude.ai export and equally of a Codex or
  // OpenCode session — the test is the source, not the shape.
  //
  // The project-name prefix was only ever a proxy for this, and a poor one: a
  // real Claude Code project named claude-ai-something vanished from the
  // listing for no reason. The index knows the answer; the prefix stays as the
  // fallback for sessions that are not indexed yet.
  if (!includeImported) {
    let importedIds = null;
    if (db) {
      try {
        importedIds = new Set(
          db.prepare(`SELECT DISTINCT session_id FROM exchanges WHERE source != 'claude_code'`)
            .all().map((r) => r.session_id).filter(Boolean)
        );
      } catch { importedIds = null; }
    }
    rows = importedIds
      ? rows.filter((s) => !importedIds.has(s.id))
      : rows.filter((s) => !s.project.startsWith('claude-ai'));
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

/**
 * Copy an archived session back into ~/.claude/projects/ so Claude Code can
 * resume it. Refuses to clobber a live transcript unless asked: the live copy
 * may hold turns the archive never saw.
 */
export function restoreSession(id, { force = false } = {}) {
  const matches = walkTranscripts(vaultDir()).filter((s) => s.id === id || s.id.startsWith(id));
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
  // --force exists to overwrite a live transcript, so an interrupted copy here
  // destroys exactly the file the guard above was protecting. Copy to a
  // sibling, keep the live one aside, then rename.
  const tmp = `${target}.arca-tmp-${process.pid}`;
  let preserved = null;
  try {
    fs.copyFileSync(s.file, tmp);
    if (existed) {
      preserved = `${target}.arca-replaced-${Date.now()}`;
      fs.copyFileSync(target, preserved);
    }
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw e;
  }

  // The transcript is back; now the directory it refers to. Its tool results
  // and subagents are part of the session, and a transcript restored without
  // them points at files that are not there.
  const dir = restoreSessionDir(
    path.join(path.dirname(s.file), s.id),
    path.join(projectsDir(), s.project, s.id)
  );

  return {
    id: s.id,
    project: s.project,
    from: s.file,
    to: target,
    bytes: s.bytes,
    note: sizeNote(s.bytes),
    overwrote: existed,
    preserved,
    dirFiles: dir.restored,
    dirFailed: dir.failed,
  };
}
