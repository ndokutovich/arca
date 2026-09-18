#!/usr/bin/env node
/**
 * arca CLI — search and read past sessions.
 *
 * Usage:
 *   node cli.js search "query"                    # hybrid search
 *   node cli.js search "query" --mode vector      # vector only
 *   node cli.js search "query" --limit 5          # limit results
 *   node cli.js search "query" --after 2026-03-01 # date filter
 *   node cli.js search "query" --project ai-cl    # project filter
 *   node cli.js search "q1" "q2" "q3"             # multi-concept AND
 *   node cli.js read <path> [startLine] [endLine]  # read conversation
 *   node cli.js stats                              # index stats
 *   node cli.js restore                            # sessions Claude Code lost
 *   node cli.js restore <id>                       # put one back
 *   node cli.js install [--dry-run]                # register hook, MCP, skills
 *   node cli.js index [--full]                     # index new exchanges
 *   node cli.js import <export-dir> [--dry-run]    # fold in a claude.ai export
 *   node cli.js resurrect                          # transcripts resume cannot open
 *   node cli.js resurrect <id> [--dry-run]         # fork one from its last compact
 */

import { listRestorable, restoreSession } from './lib/restore.js';
import { install } from './lib/install.js';
import { diagnose, forkSession } from './lib/resurrect.js';
import { runImport } from './import-claude-ai.js';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import nodePath from 'path';
import fs from 'fs';

// The index pulls in native modules (better-sqlite3, sqlite-vec). `restore` and
// `install` are exactly what someone runs when those failed to build, so they
// must not import them. Everything index-backed loads on demand instead.
const lazy = {
  search: () => import('./lib/search.js'),
  show: () => import('./lib/show.js'),
  db: () => import('./lib/db.js'),
};
let dbModule = null;

const args = process.argv.slice(2);
const cmd = args[0];

// Flags that stand alone. Without this list a bare `--include-imported` was
// taken as a positional argument and looked up as a session id, and a boolean
// placed before another option swallowed that option's value.
const BOOLEAN_FLAGS = new Set([
  'dry-run', 'force', 'all', 'include-imported', 'keep-temp', 'no-seed', 'full', 'quiet',
]);

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const name = a.slice(2);
    if (BOOLEAN_FLAGS.has(name)) { flags[name] = true; continue; }
    if (i + 1 < args.length && !args[i + 1].startsWith('--')) { flags[name] = args[++i]; continue; }
    flags[name] = true;
  }
  return { flags, positional };
}

await (async () => {
try {
  if (cmd === 'search') {
    const { flags, positional } = parseFlags(args.slice(1));
    const queries = positional;

    if (queries.length === 0) {
      console.error('Usage: node cli.js search "query" [--mode both] [--limit 10] [--after YYYY-MM-DD] [--before YYYY-MM-DD] [--project name]');
      process.exit(1);
    }

    const opts = {
      mode: flags.mode || 'both',
      limit: parseInt(flags.limit || '10'),
      after: flags.after,
      before: flags.before,
      project: flags.project,
    };

    if (queries.length >= 2) {
      const S = await lazy.search();
      const results = await S.searchMultiConcept(queries, opts);
      console.log(S.formatMultiConceptMarkdown(results, queries));
    } else {
      const S = await lazy.search();
      const results = await S.search(queries[0], opts);
      console.log(S.formatResultsMarkdown(results));
    }
  } else if (cmd === 'read') {
    const filePath = args[1];
    const startLine = args[2] ? parseInt(args[2]) : undefined;
    const endLine = args[3] ? parseInt(args[3]) : undefined;

    if (!filePath || !fs.existsSync(filePath)) {
      console.error('Usage: node cli.js read <path> [startLine] [endLine]');
      process.exit(1);
    }

    const { showConversation } = await lazy.show();
    console.log(showConversation(filePath, startLine, endLine));
  } else if (cmd === 'restore') {
    const { flags, positional } = parseFlags(args.slice(1));
    const id = positional[0];
    if (!id) {
      let db = null;
      try { dbModule = await lazy.db(); db = dbModule.getDb(); }
      catch { /* listing works without the index */ }
      const rows = listRestorable({
        limit: flags.limit ? parseInt(flags.limit) : 20,
        project: flags.project || null,
        includeImported: !!flags['include-imported'],
        db,
      });
      // The total must obey the same filters as the rows, or the header promises
      // sessions the listing does not show.
      const total = listRestorable({ limit: 0, db: null, project: flags.project || null, includeImported: !!flags['include-imported'] }).length;
      if (!total) {
        console.log('Nothing to restore — every archived session is still in ~/.claude/projects/.');
      } else {
        console.log(`${total} archived session(s) Claude Code no longer has. Most recent first:\n`);
        for (const r of rows) {
          const size = r.bytes > 1048576 ? `${(r.bytes / 1048576).toFixed(1)} MB` : `${(r.bytes / 1024).toFixed(0)} KB`;
          const when = r.last ? `${r.first} -> ${r.last}` : '(not indexed)';
          const ex = r.exchanges ? `${r.exchanges} exchanges` : '';
          console.log(`  ${r.id}  ${size.padStart(8)}  ${when}  ${ex}`);
          console.log(`    ${r.project}`);
        }
        console.log(`\nRestore one with:  arca restore <id>`);
      }
    } else {
      const r = restoreSession(id, { force: !!flags.force });
      console.log(`Restored ${r.id} into ${r.project}`);
      console.log(`  ${r.to}`);
      if (r.overwrote) console.log(`  (overwrote the live transcript; the replaced copy is at ${r.preserved})`);
      if (r.note) console.log(`  note: ${r.note}`);
      console.log('\nIt will appear in `claude --resume` for that project.');
    }
  } else if (cmd === 'install') {
    const { flags: iflags } = parseFlags(args.slice(1));
    const r = install({ dryRun: !!iflags['dry-run'], seed: !iflags['no-seed'] });
    const tag = r.dryRun ? '[dry-run] ' : '';
    console.log(`${tag}arca at ${r.root}`);
    console.log(`${tag}settings.json: ${r.settings}`);
    console.log(`${tag}mcp config:    ${r.mcp}`);
    console.log(`${tag}files:         ${r.files.length ? r.files.join(', ') : 'all current'}`);
    for (const b of r.backups) console.log(`  backed up: ${b}`);
    if (r.seeded) console.log(`${tag}seed:          ${r.seeded}`);
    if (r.dryRun) console.log('\nNothing was written. Run without --dry-run to apply.');
  } else if (cmd === 'index') {
    // Two places told people to run `arca index` and no such command existed.
    // The indexer is a script with its own lifecycle (it loads the embedding
    // model), so it runs as a child rather than being pulled into this process.
    const here = nodePath.dirname(fileURLToPath(import.meta.url));
    const r = spawnSync(process.execPath, [nodePath.join(here, 'indexer.js'), ...args.slice(1)], {
      stdio: 'inherit',
    });
    process.exitCode = r.status === null ? 1 : r.status;
  } else if (cmd === 'import') {
    const { flags, positional } = parseFlags(args.slice(1));
    const src = positional[0];
    if (!src) {
      console.error('usage: arca import <dir-with-export-zips> [--dry-run] [--keep-temp]');
      process.exit(1);
    }
    const dryRun = !!flags['dry-run'];
    const stats = runImport(src, { dryRun, keepTemp: !!flags['keep-temp'] });
    const tag = dryRun ? '[dry-run] ' : '';
    console.log(`${tag}conversations ${stats.conversations}: ${stats.created} new, ${stats.updated} changed, ${stats.unchanged} unchanged, ${stats.empty} empty, ${stats.unreadable} unreadable`);
    if (!dryRun && (stats.created || stats.updated)) {
      console.log('Run `arca index` to fold them into the index.');
    }
  } else if (cmd === 'resurrect') {
    const { flags, positional } = parseFlags(args.slice(1));
    const id = positional[0];
    if (!id) {
      const all = !!flags.all;
      const rows = diagnose({ project: flags.project || null, all });
      if (!rows.length) {
        console.log(all ? 'No transcripts found.' : 'No transcript is large enough to trouble the resume parser.');
      } else {
        console.log(`${rows.length} transcript(s), largest first:`);
        console.log('');
        for (const r of rows) {
          const size = r.bytes > 1048576 ? `${(r.bytes / 1048576).toFixed(1)} MB` : `${(r.bytes / 1024).toFixed(0)} KB`;
          console.log(`  ${r.status.toUpperCase().padEnd(8)} ${size.padStart(9)}  ${r.id}`);
          console.log(`    ${r.project}`);
        }
        console.log('');
        console.log('Fork one from its last compact boundary with:  arca resurrect <id>');
      }
    } else {
      const r = await forkSession(id, { dryRun: !!flags['dry-run'] });
      const tag = r.dryRun ? '[dry-run] ' : '';
      console.log(`${tag}${r.id} in ${r.project}`);
      console.log(`${tag}  ${r.lines} lines, last compact boundary at ${r.lastBoundary}`);
      console.log(`${tag}  keeping ${r.kept} lines (${(r.kept / r.lines * 100).toFixed(1)}%) as ${r.newId}`);
      if (r.dryRun) {
        console.log('');
        console.log('Nothing was written. Run without --dry-run to fork.');
      } else {
        console.log(`  ${r.to}`);
        console.log(`  ${(r.bytes / 1048576).toFixed(1)} MB -> ${(r.newBytes / 1048576).toFixed(1)} MB`);
        console.log('');
        console.log('The original is untouched. The fork appears in `claude --resume` for that project.');
      }
    }
  } else if (cmd === 'stats') {
    dbModule = await lazy.db();
    const stats = dbModule.getStats();
    console.log(`arca index: ${stats.exchanges} exchanges, ${stats.projects} projects, ${stats.files} files`);
  } else {
    console.error('Commands: search, read, stats, index, restore, resurrect, import, install');
    process.exit(1);
  }
} finally {
  if (dbModule) dbModule.closeDb();
}
})();
