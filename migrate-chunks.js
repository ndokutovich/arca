#!/usr/bin/env node
// One-off: turn existing single-file sessions past the threshold into parts.
//
// The hook only chunks what it writes from now on, and deliberately never
// converts a file that is already in the vault. This is the deliberate
// conversion, for a vault that accumulated large transcripts before chunking
// existed.
//
// Order matters: the parts are written and verified against the original before
// the original is removed. A failure leaves the single file exactly as it was.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { syncChunks, listParts, manifestPath, DEFAULTS } from './lib/chunks.js';
import { vaultDir } from './lib/transcripts.js';

const SKIP = new Set(['.git', '.arca', 'config', 'index', 'models', 'node_modules']);

function candidates(threshold) {
  const root = vaultDir();
  const out = [];
  let projects = [];
  try { projects = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const p of projects) {
    if (!p.isDirectory() || SKIP.has(p.name)) continue;
    const projDir = path.join(root, p.name);
    let files = [];
    try { files = fs.readdirSync(projDir, { withFileTypes: true }); } catch { continue; }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const file = path.join(projDir, f.name);
      let size;
      try { size = fs.statSync(file).size; } catch { continue; }
      if (size < threshold) continue;
      const sessionDir = path.join(projDir, f.name.replace(/\.jsonl$/, ''));
      if (fs.existsSync(manifestPath(sessionDir))) continue; // already chunked
      out.push({ file, sessionDir, size, project: p.name });
    }
  }
  return out.sort((a, b) => b.size - a.size);
}

// Streamed, not read in one piece: a transcript can be larger than the buffer
// Node will allocate, and reading it whole is also the one read pattern that
// has been seen to stall this machine's storage stack.
const HASH_CHUNK = 8 * 1024 * 1024;

function feedHash(h, file) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(HASH_CHUNK);
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, HASH_CHUNK, null);
      if (!n) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
}

const hashFile = (file) => {
  const h = crypto.createHash('sha256');
  feedHash(h, file);
  return h.digest('hex');
};

/** Hash the parts in order, as if they were one file. */
function hashChunks(sessionDir) {
  const h = crypto.createHash('sha256');
  for (const p of listParts(sessionDir)) feedHash(h, p.path);
  return h.digest('hex');
}

const gb = (n) => `${(n / 1073741824).toFixed(2)} ГБ`;

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const threshold = Number(process.env.ARCA_CHUNK_THRESHOLD || DEFAULTS.thresholdBytes);
  // A file the storage stack will not read cannot be converted, and trying
  // again only adds another process parked on it. Skipping is reported, not
  // silent: the session stays a single file and keeps working.
  const skip = (process.env.ARCA_MIGRATE_SKIP || '').split(',').map((s) => s.trim()).filter(Boolean);
  const rows = candidates(threshold).filter((r) => {
    const hit = skip.find((s) => r.file.includes(s));
    if (hit) console.log(`  пропущено (${hit}): ${r.file}`);
    return !hit;
  });

  if (!rows.length) {
    console.log('Нечего перенарезать: сессий больше порога без кусков нет.');
    return;
  }

  let total = 0;
  console.log(`${dryRun ? 'ПЛАН' : 'ПЕРЕНАРЕЗКА'} · порог ${gb(threshold)} · ${rows.length} сессий\n`);
  for (const r of rows) {
    total += r.size;
    console.log(`  ${gb(r.size).padStart(9)}  ${r.project}/${path.basename(r.file)}`);

    if (dryRun) continue;

    const before = hashFile(r.file);
    try {
      syncChunks(r.sessionDir, r.file);
      const after = hashChunks(r.sessionDir);
      if (after !== before) {
        console.log('    ОТКАЗ: склейка не совпала с оригиналом, файл оставлен');
        continue;
      }
      fs.unlinkSync(r.file);
      const parts = listParts(r.sessionDir).length;
      console.log(`    ок → ${parts} кусков, оригинал удалён`);
    } catch (e) {
      console.log(`    ОШИБКА: ${e && e.message ? e.message : e}`);
    }
  }

  console.log(`\nвсего ${gb(total)}`);
  if (dryRun) console.log('запустить без --dry-run, чтобы выполнить');
}

main();
