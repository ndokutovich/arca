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
 */

import { listRestorable, restoreSession } from './lib/restore.js';
import { install } from './lib/install.js';
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

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && i + 1 < args.length) {
      flags[args[i].slice(2)] = args[++i];
    } else {
      positional.push(args[i]);
    }
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
        includeImported: args.includes('--include-imported'),
        db,
      });
      const total = listRestorable({ limit: 0, db: null, includeImported: args.includes('--include-imported') }).length;
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
      const r = restoreSession(id, { force: args.includes('--force') });
      console.log(`Restored ${r.id} into ${r.project}`);
      console.log(`  ${r.to}`);
      if (r.overwrote) console.log('  (overwrote the live transcript)');
      if (r.note) console.log(`  note: ${r.note}`);
      console.log('\nIt will appear in `claude --resume` for that project.');
    }
  } else if (cmd === 'install') {
    const r = install({ dryRun: args.includes('--dry-run') });
    const tag = r.dryRun ? '[dry-run] ' : '';
    console.log(`${tag}arca at ${r.root}`);
    console.log(`${tag}settings.json: ${r.settings}`);
    console.log(`${tag}mcp config:    ${r.mcp}`);
    console.log(`${tag}files:         ${r.files.length ? r.files.join(', ') : 'all current'}`);
    for (const b of r.backups) console.log(`  backed up: ${b}`);
    if (r.dryRun) console.log('\nNothing was written. Run without --dry-run to apply.');
  } else if (cmd === 'stats') {
    dbModule = await lazy.db();
    const stats = dbModule.getStats();
    console.log(`Vault Memory Index: ${stats.exchanges} exchanges, ${stats.projects} projects, ${stats.files} files`);
  } else {
    console.error('Commands: search, read, stats, restore, install');
    process.exit(1);
  }
} finally {
  if (dbModule) dbModule.closeDb();
}
})();
