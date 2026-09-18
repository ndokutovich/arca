// Locate the embedding model, fetching it once if it is not there.
//
// transformers.js kept this cache inside its own node_modules directory, so
// every `npm update -g` deleted 90 MB and downloaded it again. The vault is
// where the rest of arca's state lives and npm does not reach into it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const REPO = 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main';

// Pinned. A truncated download or a substituted file would not throw — it
// would produce vectors that quietly disagree with every one already indexed.
// These are the checksums of the copy that built the current index.
const FILES = [
  {
    name: 'tokenizer.json',
    bytes: 711661,
    sha256: 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0',
  },
  {
    name: 'onnx/model.onnx',
    bytes: 90387606,
    sha256: '759c3cd2b7fe7e93933ad23c4c9181b7396442a2ed746ec7c1d46192c469c46e',
  },
];

export function modelDir() {
  return process.env.ARCA_MODEL_DIR
    || path.join(os.homedir(), '.claude-vault', 'models', 'all-MiniLM-L6-v2');
}

function digest(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1 << 20);
  try {
    for (;;) {
      const read = fs.readSync(fd, buf, 0, buf.length, null);
      if (read === 0) break;
      hash.update(buf.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

async function download(spec, dest) {
  const url = `${REPO}/${spec.name}`;
  const mb = Math.round(spec.bytes / 1048576);
  console.error(`arca: fetching ${spec.name} (${mb} MB) from Hugging Face...`);

  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Written beside the target and renamed, so a killed process leaves a stray
  // temp file rather than a half-model that passes the existence check.
  const tmp = `${dest}.${process.pid}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
    const got = digest(tmp);
    if (got !== spec.sha256) {
      throw new Error(`${spec.name}: checksum ${got.slice(0, 12)} != ${spec.sha256.slice(0, 12)}`);
    }
    fs.renameSync(tmp, dest);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
}

/**
 * Ensure the model is on disk and return its directory.
 * @returns {Promise<string>}
 */
export async function ensureModel() {
  const dir = modelDir();
  for (const spec of FILES) {
    const dest = path.join(dir, spec.name);
    // Size is the cheap check; hashing 90 MB on every process start is not.
    // The hash is verified when the file is written, which is the moment it
    // can be wrong.
    let stat = null;
    try { stat = fs.statSync(dest); } catch { /* absent */ }
    if (stat && stat.size === spec.bytes) continue;
    if (stat) fs.rmSync(dest, { force: true });
    await download(spec, dest);
  }
  return dir;
}
