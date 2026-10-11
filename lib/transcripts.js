// What restore and resurrect both need to agree on.
//
// They answer the two halves of "I lost my session" — one brings a transcript
// back from the vault, the other repairs one resume cannot open — so they walk
// the same trees, recognise the same files, and judge size against the same
// numbers. Keeping two copies of that meant two names for one threshold and two
// vocabularies for one condition in the output.
//
// The paths are functions rather than constants because HOME is read per call:
// a module-level snapshot is taken at import, which is wrong for anything that
// runs against a different home — every test in this repo, for a start.
import fs from 'fs';
import os from 'os';
import path from 'path';

/** Where Claude Code keeps live transcripts. */
export const projectsDir = () => path.join(os.homedir(), '.claude', 'projects');

/** Where arca keeps the archive. */
export const vaultDir = () => path.join(os.homedir(), '.claude-vault');

/**
 * Directories inside the vault that hold no transcripts. `.arca` and `.cache`
 * are arca's own: the machine manifests under `.arca/machines/` are .jsonl
 * files, and a walk that treated them as sessions would offer to restore them.
 */
export const SKIP_DIRS = new Set(['index', '.git', 'node_modules', '.arca', '.cache', 'models']);

/** A sidechain: the transcript of a subagent, not of a session. */
export const isSidechainFile = (name) => name.startsWith('agent-');

/**
 * A session transcript. Sidechains are excluded here because nothing resumes
 * one, and a walk that offered to restore one would be offering a subagent.
 * Archiving and indexing take them anyway — `isArchivable` at a project's top
 * level, `findArchivedTranscripts` inside session directories: what you cannot
 * resume you may still want to search. What a subagent looked at and
 * discarded reaches the main transcript only as a conclusion, if at all.
 */
export const isTranscript = (name) => name.endsWith('.jsonl') && !isSidechainFile(name);

/** Worth copying into the vault and indexing: sessions and their sidechains. */
export const isArchivable = (name) => name.endsWith('.jsonl');

/**
 * A session's directory. Claude Code keeps one beside each transcript, named
 * after the session: subagents/ (and subagents/workflows/wf_<id>/ for workflow
 * agents), tool-results/ that the transcript refers to, and a .meta.json per
 * agent. Anything else in a project directory — memory/ above all — is not a
 * session and is somebody else's to keep.
 */
export const isSessionDirName = (name) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name);

// Where the resume parser starts to struggle, then to fail outright. Measured
// in bytes because that is what it actually chokes on, not turn count.
export const AT_RISK_BYTES = 50 * 1024 * 1024;
export const BROKEN_BYTES = 100 * 1024 * 1024;

/** `ok` | `at-risk` | `broken`, by size alone. */
export function sizeStatus(bytes) {
  if (bytes >= BROKEN_BYTES) return 'broken';
  if (bytes >= AT_RISK_BYTES) return 'at-risk';
  return 'ok';
}

/** A sentence about the size, or null when there is nothing to say. */
export function sizeNote(bytes) {
  const mb = (bytes / 1048576).toFixed(0);
  switch (sizeStatus(bytes)) {
    case 'broken':
      return `${mb} MB — very likely too large for resume to open; fork it from its last compact boundary with \`arca resurrect\``;
    case 'at-risk':
      return `${mb} MB — large enough that resume may struggle`;
    default:
      return null;
  }
}

export const humanBytes = (b) =>
  b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1024).toFixed(0)} KB`;

/**
 * Every transcript under a root laid out as <root>/<project>/<id>.jsonl.
 * Unreadable directories are skipped rather than fatal: a vault with one bad
 * permission should still list the rest.
 */
export function walkTranscripts(root, { skip = SKIP_DIRS } = {}) {
  const out = [];
  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory() || skip.has(dir.name)) continue;
    const projDir = path.join(root, dir.name);
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

/** Every .jsonl below a directory. Links are not followed: a link can loop. */
function jsonlUnder(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsonlUnder(full));
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

/**
 * Every transcript the indexer reads: each project's sessions and sidechains
 * at its top level, and the subagent transcripts Claude Code keeps inside each
 * session's directory. Those used to be walked past — the top level was all
 * anyone looked at — and newer Claude Code writes most of its subagents there.
 *
 * Tool results and .meta.json files sit in the same directories and are
 * archived, but they are not conversations. config/ is a copy of ~/.claude and
 * .arca/ is arca's own bookkeeping; both hold .jsonl files that are not
 * transcripts of anything.
 */
export function findArchivedTranscripts(root = vaultDir()) {
  const out = [];
  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory() || SKIP_DIRS.has(dir.name) || dir.name === 'config') continue;
    const projDir = path.join(root, dir.name);
    let entries;
    try {
      entries = fs.readdirSync(projDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && isArchivable(e.name)) {
        out.push({ path: path.join(projDir, e.name), project: dir.name, sidechain: isSidechainFile(e.name) });
      } else if (e.isDirectory() && isSessionDirName(e.name)) {
        for (const file of jsonlUnder(path.join(projDir, e.name, 'subagents'))) {
          out.push({ path: file, project: dir.name, sidechain: true });
        }
      }
    }
  }
  return out;
}

/**
 * The project a vault file belongs to: the directory directly under the vault.
 * `basename(dirname(file))` is right only for a top-level transcript — for a
 * sidechain in <project>/<session>/subagents/ it names "subagents", and every
 * turn in it would be filed under a project that does not exist.
 */
export function projectOf(file, root = vaultDir()) {
  const rel = path.relative(root, file);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    const parts = rel.split(path.sep);
    if (parts.length > 1 && parts[0]) return parts[0];
  }
  return path.basename(path.dirname(file));
}
