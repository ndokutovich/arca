// Repair a session Claude Code cannot open.
//
// This is the sibling of restore.js, for the other way a session is lost.
// Restore brings back a transcript that is gone from ~/.claude/projects/.
// Resurrect fixes one that is still there and still intact, but that the
// resume parser refuses — usually because the file grew past what it will read,
// sometimes because its schema drifted across a CLI upgrade. The failure looks
// identical from the outside: resume "succeeds" into a session with no memory
// of anything, appending new turns to a file whose history it never loaded.
//
// The fix follows the parser's own logic. On resume it finds the last
// `compact_boundary`, injects the synthetic `isCompactSummary` user message
// that follows it as the conversation's memory, and replays everything after.
// Everything before that boundary was already discarded by `/compact` — it is
// not lost by forking, it was lost when the compact ran. So a fork from the
// last boundary keeps every turn the parser would have used and drops only
// what it would have ignored, in a file small enough to actually open.
//
// The original is never touched.
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import crypto from 'crypto';
import { projectsDir, isTranscript, sizeStatus, AT_RISK_BYTES, BROKEN_BYTES } from './transcripts.js';

/** Every live transcript, with its size and health. */
export function diagnose({ project = null, all = false } = {}) {
  const rows = [];
  let dirs;
  try {
    dirs = fs.readdirSync(projectsDir(), { withFileTypes: true });
  } catch {
    return rows;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    if (project && !dir.name.toLowerCase().includes(project.toLowerCase())) continue;
    const projDir = path.join(projectsDir(), dir.name);
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
      const status = sizeStatus(st.size);
      if (!all && status === 'ok') continue;
      rows.push({
        id: f.name.replace(/\.jsonl$/, ''),
        project: dir.name,
        file,
        bytes: st.size,
        mtime: st.mtimeMs,
        status,
      });
    }
  }
  rows.sort((a, b) => b.bytes - a.bytes);
  return rows;
}

function findTranscript(id) {
  const matches = [];
  let dirs;
  try {
    dirs = fs.readdirSync(projectsDir(), { withFileTypes: true });
  } catch {
    return matches;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    let files;
    try {
      files = fs.readdirSync(path.join(projectsDir(), dir.name));
    } catch {
      continue;
    }
    for (const name of files) {
      if (!isTranscript(name)) continue;
      const base = name.replace(/\.jsonl$/, '');
      if (base === id || base.startsWith(id)) {
        matches.push({ id: base, project: dir.name, file: path.join(projectsDir(), dir.name, name) });
      }
    }
  }
  return matches;
}

/** Read the file once, noting the meta header and the last compact boundary. */
async function scan(file) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  const header = [];
  let lastBoundary = -1;
  let n = 0;
  let sawTurn = false;
  for await (const line of rl) {
    if (line.trim()) {
      let rec = null;
      try {
        rec = JSON.parse(line);
      } catch {
        // a truncated final line is normal on a file still being appended to
      }
      if (rec) {
        // The meta header carries no uuid and no parent; it belongs in the fork.
        if (!sawTurn && rec.uuid === undefined && rec.parentUuid === undefined) header.push(line);
        else sawTurn = true;
        if (rec.type === 'system' && rec.subtype === 'compact_boundary') lastBoundary = n;
        else if (rec.compact_boundary || rec.isCompactBoundary) lastBoundary = n;
      }
    }
    n++;
  }
  return { lines: n, lastBoundary, header };
}

/**
 * Fork a transcript from its last compact boundary into a new, small session
 * file beside it. The original is left alone; the fork gets a fresh id, and
 * every record's sessionId is set to it so the file agrees with its own name.
 */
export async function forkSession(id, { dryRun = false } = {}) {
  const matches = findTranscript(id);
  if (matches.length === 0) throw new Error(`no live transcript matches "${id}"`);
  if (matches.length > 1) {
    throw new Error(`"${id}" matches ${matches.length} sessions: ${matches.slice(0, 5).map((m) => m.id).join(', ')}`);
  }
  const src = matches[0];
  const { lines, lastBoundary, header } = await scan(src.file);
  if (lastBoundary < 0) {
    throw new Error(
      `${src.id} has no compact boundary — there is nothing to fork from. A transcript that never ran /compact has no point at which history was already discarded, so forking it would throw away real turns.`
    );
  }

  const newId = crypto.randomUUID();
  const dest = path.join(projectsDir(), src.project, `${newId}.jsonl`);
  const kept = lines - lastBoundary;

  if (dryRun) {
    return { id: src.id, project: src.project, newId, from: src.file, to: dest,
             lines, lastBoundary, kept, bytes: fs.statSync(src.file).size, dryRun: true };
  }

  const out = fs.createWriteStream(dest, { encoding: 'utf8' });
  const retag = (line) => {
    try {
      const rec = JSON.parse(line);
      if (rec.sessionId !== undefined) {
        rec.sessionId = newId;
        return JSON.stringify(rec);
      }
    } catch { /* leave unparseable lines exactly as they are */ }
    return line;
  };

  for (const h of header) out.write(`${retag(h)}\n`);

  const rl = readline.createInterface({
    input: fs.createReadStream(src.file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let n = 0;
  for await (const line of rl) {
    if (n >= lastBoundary && line.trim()) out.write(`${retag(line)}\n`);
    n++;
  }
  await new Promise((resolve, reject) => out.end(resolve).on('error', reject));

  return {
    id: src.id,
    project: src.project,
    newId,
    from: src.file,
    to: dest,
    lines,
    lastBoundary,
    kept,
    bytes: fs.statSync(src.file).size,
    newBytes: fs.statSync(dest).size,
  };
}

export { AT_RISK_BYTES, BROKEN_BYTES };
