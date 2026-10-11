#!/usr/bin/env node
// Run the indexing chain in order, in one process.
//
// The hook used to spawn four detached children at once — the incremental
// indexer plus the three derived-layer builders — under a comment claiming the
// layers read what the indexer had written. They did not: all four started
// together, so the knowledge graph could read the entity tables while they were
// being cleared, and every builder could read turns the indexer had not
// inserted yet. The order was documented and never enforced.
//
// The hook cannot wait for this itself, because SessionStart must return
// immediately. So it spawns exactly one detached child — this file — which does
// the waiting. Each stage runs only if the one before it succeeded; a failure
// stops the chain and is written to the vault log, because a derived layer
// rebuilt from a half-written index is worse than one left stale.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const VAULT_DIR = path.join(os.homedir(), '.claude-vault');
const LOG = path.join(VAULT_DIR, 'vault.log');

function note(msg) {
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch { /* the log is best-effort; never let it break the chain */ }
}

const [, , packageRoot, ...files] = process.argv;
if (!packageRoot) {
  console.error('usage: pipeline.js <package-root> [copied-file...]');
  process.exit(1);
}

// --all instead of a file list: the hook copied more than one command line can
// carry (Windows stops at 32,767 characters), so index the whole vault
// incrementally — it skips every turn it already has.
const all = files[0] === '--all';

// Turns first; each derived layer reads what the step before it wrote.
const STAGES = [
  all ? ['indexer.js', ['--quiet']] : ['index-incremental.js', files],
  ['build-entities.js', ['--quiet']],
  ['build-kg.js', ['--quiet']],
  ['build-threads.js', ['--quiet']],
];

let ran = 0;
for (const [script, args] of STAGES) {
  const target = path.join(packageRoot, script);
  if (!fs.existsSync(target)) {
    note(`pipeline: missing ${script}, chain stopped after ${ran} stage(s)`);
    process.exit(1);
  }
  const r = spawnSync(process.execPath, [target, ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    const why = (r.stderr || '').trim().split('\n').slice(-1)[0] || `exit ${r.status}`;
    note(`pipeline: ${script} failed (${why.slice(0, 200)}), chain stopped after ${ran} stage(s)`);
    process.exit(1);
  }
  ran++;
}

note(`pipeline: ${ran} stage(s) ok${all ? ' for the whole vault' : files.length ? ` for ${files.length} file(s)` : ''}`);
