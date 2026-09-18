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

/**
 * Subagent transcripts (`agent-*.jsonl`) are excluded everywhere: they are
 * side conversations, not sessions anyone resumes.
 */
export const isTranscript = (name) => name.endsWith('.jsonl') && !name.startsWith('agent-');

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
