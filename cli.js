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
 */

import { search, searchMultiConcept, formatResultsMarkdown, formatMultiConceptMarkdown } from './lib/search.js';
import { showConversation } from './lib/show.js';
import { getStats, closeDb } from './lib/db.js';
import fs from 'fs';

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
      const results = await searchMultiConcept(queries, opts);
      console.log(formatMultiConceptMarkdown(results, queries));
    } else {
      const results = await search(queries[0], opts);
      console.log(formatResultsMarkdown(results));
    }
  } else if (cmd === 'read') {
    const filePath = args[1];
    const startLine = args[2] ? parseInt(args[2]) : undefined;
    const endLine = args[3] ? parseInt(args[3]) : undefined;

    if (!filePath || !fs.existsSync(filePath)) {
      console.error('Usage: node cli.js read <path> [startLine] [endLine]');
      process.exit(1);
    }

    console.log(showConversation(filePath, startLine, endLine));
  } else if (cmd === 'stats') {
    const stats = getStats();
    console.log(`Vault Memory Index: ${stats.exchanges} exchanges, ${stats.projects} projects, ${stats.files} files`);
  } else {
    console.error('Commands: search, read, stats');
    process.exit(1);
  }
} finally {
  closeDb();
}
