// ~/.claude/history.jsonl — every prompt you have typed, and the only record
// of the ones whose transcript is gone.
//
// Claude Code keeps it outside the per-project transcripts and it survives
// their deletion, so it holds questions the vault cannot otherwise answer:
// what you were working on in a session that was cleaned up before arca
// existed, or before the hook was installed.
//
// It is per-machine, like the transcripts, and it gets rewritten in place by
// Claude Code. So it is not copied wholesale — that would put a 10 MB blob in
// the vault on every commit. New entries are appended to this machine's own
// file under .arca/history/, which makes the vault copy append-only, small in
// git, and mergeable with another machine's the same way the manifests are.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { vaultDir } from './transcripts.js';
import { machineId } from './machine.js';

/** Where Claude Code writes it. */
export const sourceFile = () => path.join(os.homedir(), '.claude', 'history.jsonl');

/** Where the vault keeps this machine's copy. */
export const vaultFile = (id) => path.join(vaultDir(), '.arca', 'history', `${id}.jsonl`);

/**
 * Claude Code names a project directory by replacing everything that is not a
 * letter or a digit with a dash — so `w:\_proj\app` becomes `w---proj-app`.
 * history.jsonl stores the raw path instead, and matching the two up is the
 * only way a prompt can be tied to the sessions it belongs with.
 */
export function projectKey(cwd) {
  return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
}

function parseLines(raw) {
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const text = typeof rec.display === 'string' ? rec.display : '';
    if (!text.trim()) continue;
    if (!Number.isFinite(rec.timestamp)) continue;
    out.push({
      text,
      ts: rec.timestamp,
      projectPath: rec.project || '',
      project: projectKey(rec.project),
      pasted: rec.pastedContents && typeof rec.pastedContents === 'object'
        ? Object.keys(rec.pastedContents).length
        : 0,
    });
  }
  return out;
}

export function readSource() {
  try { return parseLines(fs.readFileSync(sourceFile(), 'utf8')); }
  catch { return []; }
}

/**
 * Copy entries this machine has not archived yet into the vault.
 *
 * Keyed on the highest timestamp already stored rather than on file length,
 * because Claude Code rewrites the file in place and a byte offset would go
 * stale the first time it trimmed.
 *
 * @returns {{ appended: number, total: number, file: string }}
 */
export function syncToVault() {
  const id = machineId();
  const file = vaultFile(id);
  const existing = readVault();
  let watermark = 0;
  const seen = new Set();
  for (const rec of existing) {
    if (rec.ts > watermark) watermark = rec.ts;
    seen.add(`${rec.ts}\u0000${rec.text}`);
  }

  const fresh = readSource().filter((r) => {
    if (r.ts > watermark) return true;
    // Entries can share a millisecond, so anything at the watermark itself is
    // checked properly rather than assumed to be already stored.
    return r.ts === watermark && !seen.has(`${r.ts}\u0000${r.text}`);
  });

  if (fresh.length) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, fresh.map((r) => JSON.stringify({
      t: r.ts, p: r.projectPath, x: r.text, n: r.pasted,
    })).join('\n') + '\n');
  }
  return { appended: fresh.length, total: existing.length + fresh.length, file };
}

/** Every archived prompt, from every machine that has written into this vault. */
export function readVault() {
  const dir = path.join(vaultDir(), '.arca', 'history');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); }
  catch { return []; }

  const out = [];
  for (const f of files) {
    const machine = f.slice(0, -6);
    let raw = '';
    try { raw = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (!rec.x || !Number.isFinite(rec.t)) continue;
      out.push({
        machine,
        ts: rec.t,
        text: rec.x,
        projectPath: rec.p || '',
        project: projectKey(rec.p),
        pasted: rec.n || 0,
      });
    }
  }
  return out;
}

/**
 * A prompt's identity: the machine, when it was typed, and what it said.
 * Two machines can hold the same text at the same millisecond in the same
 * project only if a vault was copied, and then they really are one prompt.
 */
export function promptId(rec) {
  return crypto.createHash('md5')
    .update([rec.machine || '', rec.project || '', String(rec.ts), rec.text].join('\u0000'))
    .digest('hex');
}

/**
 * The hash that ties a prompt to the turn it opened, when one survives.
 * Project plus exact text: the same question asked twice in one project is
 * deliberately one echo, because that is as precisely as this can be known.
 */
export function echoHash(project, text) {
  return crypto.createHash('md5').update(`${project || ''}\u0000${text}`).digest('hex');
}
