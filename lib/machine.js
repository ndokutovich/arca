// Two machines, one history.
//
// The vault is a git repository, so folding in a second machine is a pull
// away. What a pull cannot tell you is which machine a turn came from,
// and project directories are named after filesystem paths — so the same
// directory name on two machines may be the same project, or two unrelated
// ones that happen to sit at the same path. Merging them silently would be a
// lie, and renaming either would be damage.
//
// So nothing is renamed and nothing is merged away. Each machine writes one
// append-only file naming the sessions it produced, and only ever its own
// file. Two vaults then merge without a conflict — git takes both files — and
// "whose session is this?" keeps an answer afterwards.
//
// The local identity is deliberately NOT committed. If it travelled, a pull
// would tell the other machine it was this one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { vaultDir } from './transcripts.js';

const DIR = () => path.join(vaultDir(), '.arca');
const SELF = () => path.join(DIR(), 'this-machine');
const MACHINES = () => path.join(DIR(), 'machines');

function readLines(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    // A half-written last line is possible if the process died mid-append.
    // One unreadable line must not cost the whole manifest.
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
}

function append(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
}

/**
 * This machine's id, created once and never rewritten.
 * @returns {string}
 */
export function machineId() {
  const self = SELF();
  try {
    const existing = fs.readFileSync(self, 'utf8').trim();
    if (existing) return existing;
  } catch { /* first run */ }

  // Hostname alone is not enough — two machines can share one, and a rename
  // would silently split a machine's history in two. Random, recorded once.
  const id = crypto.randomBytes(6).toString('hex');
  fs.mkdirSync(path.dirname(self), { recursive: true });
  fs.writeFileSync(self, `${id}\n`);
  append(manifestPath(id), {
    t: 'machine',
    id,
    hostname: os.hostname(),
    platform: process.platform,
    created: new Date().toISOString(),
  });
  return id;
}

export function manifestPath(id) {
  return path.join(MACHINES(), `${id}.jsonl`);
}

/**
 * Every machine that has ever written into this vault, with what it owns.
 * @returns {Array<{id, hostname, platform, created, sessions}>}
 */
export function machines() {
  let files = [];
  try { files = fs.readdirSync(MACHINES()).filter((f) => f.endsWith('.jsonl')); }
  catch { return []; }

  const out = [];
  for (const file of files) {
    const id = file.slice(0, -6);
    let identity = { id, hostname: '(unknown)', platform: '', created: null };
    let sessions = 0;
    for (const rec of readLines(path.join(MACHINES(), file))) {
      if (rec.t === 'machine') identity = { ...identity, ...rec };
      else if (rec.t === 'claim') sessions++;
    }
    out.push({ ...identity, sessions });
  }
  return out.sort((a, b) => b.sessions - a.sessions);
}

/**
 * Session id -> machine id, across every manifest in the vault.
 * @returns {Map<string, string>}
 */
export function owners() {
  const map = new Map();
  let files = [];
  try { files = fs.readdirSync(MACHINES()).filter((f) => f.endsWith('.jsonl')); }
  catch { return map; }
  for (const file of files) {
    const id = file.slice(0, -6);
    for (const rec of readLines(path.join(MACHINES(), file))) {
      // First claim wins. If two machines ever claim one session — only
      // possible if a vault was copied rather than pulled — the earlier
      // manifest keeps it rather than the later one overwriting.
      if (rec.t === 'claim' && rec.session && !map.has(rec.session)) map.set(rec.session, id);
    }
  }
  return map;
}

/**
 * Record that this machine produced these sessions. Already-claimed sessions
 * are left alone, by any machine, so this is safe to call on every archive.
 * @param {Array<{session: string, project: string}>} entries
 * @returns {number} how many were newly claimed
 */
export function claim(entries) {
  if (!entries.length) return 0;
  const known = owners();
  const id = machineId();
  const file = manifestPath(id);
  const at = new Date().toISOString();
  let n = 0;
  for (const e of entries) {
    if (!e.session || known.has(e.session)) continue;
    append(file, { t: 'claim', session: e.session, project: e.project, at });
    known.set(e.session, id);
    n++;
  }
  return n;
}

/**
 * One-time adoption of everything already in the vault.
 *
 * Run before a remote is added, while everything present is genuinely this
 * machine's. Afterwards it claims only what no manifest covers, which is the
 * honest thing to do but will not retroactively tell two merged vaults apart —
 * hence the marker, and hence the warning in the CLI.
 *
 * @param {(dir: string) => Array<{session, project}>} scan
 * @returns {{ adopted: number, alreadyDone: boolean, foreign: number }}
 */
export function adopt(scan) {
  const marker = path.join(DIR(), 'adopted');
  const alreadyDone = fs.existsSync(marker);
  const before = owners();
  const foreign = new Set([...before.values()]);
  foreign.delete(machineId());

  const claimed = claim(scan(vaultDir()));
  if (!alreadyDone) {
    fs.mkdirSync(DIR(), { recursive: true });
    fs.writeFileSync(marker, `${new Date().toISOString()}\n`);
  }
  return { adopted: claimed, alreadyDone, foreign: foreign.size };
}
