// Large transcripts, split into pieces that stop changing.
//
// A transcript is appended to and never rewritten, so a session can be stored
// as a run of parts where only the last one grows. Everything downstream — git,
// the copy, the indexer — then costs the size of that last part instead of the
// session. See docs/transcript-chunks.md.
//
// A part always ends at a line boundary: a JSON line split across two files
// would break every reader that walks the vault without knowing about chunks.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULTS = {
  partBytes: 8 * 1024 * 1024,
  thresholdBytes: 50 * 1024 * 1024,
};

// How much of the overlap is compared before appending. Same guard as the
// single-file copy: "the source grew" and "the source was rewritten and is
// longer" are identical from stat.
const OVERLAP_PROBE = 4096;

export const transcriptDir = (sessionDir) => path.join(sessionDir, 'transcript');
export const manifestPath = (sessionDir) => path.join(transcriptDir(sessionDir), 'manifest.json');
export const partPath = (sessionDir, name) => path.join(transcriptDir(sessionDir), name);

export function readManifest(sessionDir) {
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath(sessionDir), 'utf8'));
    if (!Array.isArray(m.parts)) return null;
    return m;
  } catch {
    return null;
  }
}

export function hasChunks(sessionDir) {
  return readManifest(sessionDir) !== null;
}

function writeManifest(sessionDir, manifest) {
  const dir = transcriptDir(sessionDir);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `manifest.json.tmp-${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  fs.renameSync(tmp, manifestPath(sessionDir));
}

/** Ordered part files, growing one last. */
export function listParts(sessionDir) {
  const m = readManifest(sessionDir);
  if (!m) return [];
  return m.parts.map((p) => ({ ...p, path: partPath(sessionDir, p.name) }));
}

export function totalBytes(manifest) {
  return (manifest?.parts || []).reduce((n, p) => n + p.bytes, 0);
}

const partName = (n) => `part-${String(n).padStart(4, '0')}.jsonl`;

function readAt(fd, position, length) {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, position);
  return n === length ? buf : buf.subarray(0, n);
}

function countLines(file) {
  const buf = fs.readFileSync(file);
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
  return n;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Freeze a part: record its hash and line count, and never touch it again. */
function closePart(sessionDir, manifest, name) {
  const file = partPath(sessionDir, name);
  const entry = manifest.parts.find((p) => p.name === name);
  entry.sha256 = sha256(file);
  entry.lines = countLines(file);
  entry.closed = true;
}

function freshManifest(sessionId, partBytes) {
  return { format: 1, session: sessionId, partBytes, parts: [] };
}

/** Wipe the parts of a session — used when the source turns out to disagree. */
function resetParts(sessionDir) {
  const dir = transcriptDir(sessionDir);
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith('part-') || f.startsWith('manifest.json.tmp-')) fs.unlinkSync(path.join(dir, f));
    }
  } catch { /* nothing to remove */ }
}

/**
 * Bring a session's parts up to date with the source transcript.
 *
 * 'unchanged' | 'created' | 'appended' | 'rebuilt'. `rebuilt` means the source
 * was shorter than what the vault held: the append-only assumption no longer
 * holds, so the parts are replaced rather than patched.
 */
export function syncChunks(sessionDir, srcPath, opts = {}) {
  const partBytes = opts.partBytes ?? DEFAULTS.partBytes;
  const m = readManifest(sessionDir) || freshManifest(path.basename(sessionDir), partBytes);
  const srcSize = fs.statSync(srcPath).size;
  const held = totalBytes(m);

  if (srcSize === held && m.parts.length) return 'unchanged';

  let rebuilt = false;
  if (srcSize < held) {
    resetParts(sessionDir);
    Object.assign(m, freshManifest(path.basename(sessionDir), partBytes));
    rebuilt = true;
  }

  const created = !m.parts.length;
  const srcFd = fs.openSync(srcPath, 'r');
  try {
    // Verify the joint before trusting it: the bytes the vault already holds
    // must equal the source at the same offset.
    const from = totalBytes(m);
    if (from > 0) {
      const last = m.parts[m.parts.length - 1];
      const probe = Math.min(OVERLAP_PROBE, last.bytes);
      const dstFd = fs.openSync(partPath(sessionDir, last.name), 'r');
      let same;
      try {
        same = readAt(srcFd, from - probe, probe)
          .equals(readAt(dstFd, last.bytes - probe, probe));
      } finally { fs.closeSync(dstFd); }
      if (!same) {
        resetParts(sessionDir);
        Object.assign(m, freshManifest(path.basename(sessionDir), partBytes));
        rebuilt = true;
      }
    }

    const start = totalBytes(m);
    if (start === srcSize) {
      writeManifest(sessionDir, m);
      return created ? 'created' : 'unchanged';
    }

    fs.mkdirSync(transcriptDir(sessionDir), { recursive: true });
    let buf = Buffer.alloc(0);
    let pos = start;

    const ensureOpen = () => {
      if (!m.parts.length || m.parts[m.parts.length - 1].closed) {
        const name = partName(m.parts.length + 1);
        fs.writeFileSync(partPath(sessionDir, name), '');
        m.parts.push({ name, bytes: 0, lines: 0, sha256: null, closed: false });
      }
      return m.parts[m.parts.length - 1];
    };

    const writeToOpen = (data) => {
      const part = ensureOpen();
      const fd = fs.openSync(partPath(sessionDir, part.name), 'a');
      try { fs.writeSync(fd, data); } finally { fs.closeSync(fd); }
      part.bytes += data.length;
    };

    const closeOpen = () => {
      const part = m.parts[m.parts.length - 1];
      if (part && !part.closed) closePart(sessionDir, m, part.name);
    };

    while (pos < srcSize) {
      const take = Math.min(partBytes, srcSize - pos);
      buf = Buffer.concat([buf, readAt(srcFd, pos, take)]);
      pos += take;

      // Write whole lines, one part at a time. The boundary is measured from
      // what the open part has left, not from the buffer: a part that already
      // holds half its budget must not be handed another full one.
      for (;;) {
        const part = ensureOpen();
        const room = partBytes - part.bytes;
        if (room <= 0) { closeOpen(); continue; }
        if (buf.length < room) break;

        // Prefer a line ending inside the room. A line longer than the whole
        // part ends the part instead of being split across two files.
        let cut = buf.lastIndexOf(0x0a, room - 1);
        if (cut < 0) cut = buf.indexOf(0x0a, room);
        if (cut < 0) {
          if (buf.length >= 4 * partBytes) { writeToOpen(buf); buf = Buffer.alloc(0); closeOpen(); }
          break;
        }
        writeToOpen(buf.subarray(0, cut + 1));
        buf = buf.subarray(cut + 1);
        if (m.parts[m.parts.length - 1].bytes >= partBytes) closeOpen();
      }
    }
    // The last part stays open on purpose: it is the one that keeps growing,
    // and closing it here would start a new part on every session start.
    if (buf.length) writeToOpen(buf);

    writeManifest(sessionDir, m);
    if (rebuilt) return 'rebuilt';
    return created ? 'created' : 'appended';
  } finally {
    fs.closeSync(srcFd);
  }
}

/** Concatenate the parts, in order, into one stream. */
export async function* readChunks(sessionDir) {
  for (const p of listParts(sessionDir)) {
    const stream = fs.createReadStream(p.path, { highWaterMark: 1024 * 1024 });
    for await (const chunk of stream) yield chunk;
  }
}

/** Write the whole session — parts glued back together — to `outPath`. */
export async function assembleChunks(sessionDir, outPath) {
  const out = fs.createWriteStream(outPath);
  try {
    for await (const chunk of readChunks(sessionDir)) {
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  return fs.statSync(outPath).size;
}
