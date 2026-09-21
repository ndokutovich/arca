// Watching Claude Code forget.
//
// Transcripts are deleted from ~/.claude/projects on a thirty-day rolling
// window. On this machine `cleanupPeriodDays: 10000` is set and ignored, which
// is a known open bug: a process started with restricted setting sources never
// loads the user settings, falls back to the thirty-day default, and sweeps
// every project rather than its own.
//
// The vault already survives that — it copies before the sweep. What it could
// not do is say *when* a sweep happened, which is the one fact needed to work
// out what triggered it. So each sample records what Claude Code still holds,
// and the next sample names what went missing in between.
//
// Nothing here tries to prevent the deletion. That is upstream, and a fix
// there does not make the record less useful: a vault that can say "four
// hundred sessions disappeared between Tuesday and Wednesday" is worth having
// whatever the cause turns out to be.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vaultDir } from './transcripts.js';
import { machineId } from './machine.js';

const claudeHome = () => process.env.ARCA_CLAUDE_HOME || path.join(os.homedir(), '.claude');

/** Per machine, like the session manifests: two vaults merge without a conflict. */
export const logPath = (id = machineId()) => path.join(vaultDir(), '.arca', 'retention', `${id}.jsonl`);

// The id list is only ever needed to diff against the next sample, and at
// three thousand sessions it is a hundred kilobytes. Keeping it in the log
// would put that in git several times a day; keeping it beside the log, and
// out of git, keeps the log itself permanent and tiny.
export const idsPath = (id = machineId()) => path.join(vaultDir(), '.arca', 'retention', `${id}.ids`);

function previousIds(id = machineId()) {
  try {
    return new Set(fs.readFileSync(idsPath(id), 'utf8').split(String.fromCharCode(10)).filter(Boolean));
  } catch {
    return null;
  }
}

/**
 * Every session id Claude Code currently holds, with the day it last changed.
 *
 * Read from the filesystem rather than the index: the question is what is on
 * disk right now, and the index is a record of what once was.
 */
export function live(home = claudeHome()) {
  const out = new Map();
  const projects = path.join(home, 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(projects, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let files = [];
    try { files = fs.readdirSync(path.join(projects, d.name)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      let mtime = 0;
      try { mtime = fs.statSync(path.join(projects, d.name, f)).mtimeMs; } catch { continue; }
      out.set(f.slice(0, -6), { project: d.name, mtime });
    }
  }
  return out;
}

/** What the log already holds, oldest first. */
export function history(id = machineId()) {
  const out = [];
  let text = '';
  try { text = fs.readFileSync(logPath(id), 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    // A sample interrupted mid-write costs that sample, not the log.
    try { out.push(JSON.parse(line)); } catch { /* half-written */ }
  }
  return out;
}

/**
 * Record what Claude Code holds now, and what has gone since last time.
 *
 * @param {{home?: string, now?: number, minGapMs?: number, force?: boolean}} opts
 * @returns {null | {at: string, held: number, oldest: string|null, gone: string[], since: string|null}}
 */
export function record({ home = claudeHome(), now = Date.now(), minGapMs = 6 * 60 * 60 * 1000, force = false } = {}) {
  const past = history();
  const last = past[past.length - 1] || null;

  if (!force && last) {
    const age = now - Date.parse(last.at);
    // A sample every session start would be thousands a week and would say
    // nothing a few a day does not.
    if (age >= 0 && age < minGapMs) return null;
  }

  const held = live(home);
  const ids = [...held.keys()].sort();
  const oldest = ids.length
    ? new Date(Math.min(...[...held.values()].map((v) => v.mtime))).toISOString()
    : null;

  // Only against the previous sample: a session absent from both was already
  // gone and is not news twice.
  const before = previousIds();
  const gone = before ? [...before].filter((id) => !held.has(id)).sort() : [];

  const sample = {
    at: new Date(now).toISOString(),
    held: ids.length,
    oldest,
    gone,
    since: last ? last.at : null,
  };

  try {
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    fs.appendFileSync(logPath(), JSON.stringify(sample) + String.fromCharCode(10));
    // Written after the log: a crash between the two costs one diff, while
    // the other order would lose the sample that explains it.
    fs.writeFileSync(idsPath(), ids.join(String.fromCharCode(10)));
  } catch {
    return null;
  }
  return sample;
}

/**
 * The retention boundary as it stands, for `arca stats`.
 *
 * @returns {null | {held: number, oldest: string|null, days: number|null, lastLoss: object|null, losses: number}}
 */
export function summary({ home = claudeHome(), now = Date.now() } = {}) {
  const held = live(home);
  if (!held.size) return null;
  const oldestMs = Math.min(...[...held.values()].map((v) => v.mtime));
  const past = history();
  const withLoss = past.filter((s) => s.gone && s.gone.length);
  return {
    held: held.size,
    oldest: new Date(oldestMs).toISOString(),
    days: Math.floor((now - oldestMs) / 86400000),
    lastLoss: withLoss.length ? withLoss[withLoss.length - 1] : null,
    losses: withLoss.reduce((a, s) => a + s.gone.length, 0),
    samples: past.length,
  };
}
