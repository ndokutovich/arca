#!/usr/bin/env node
/**
 * Incremental indexer for arca.
 *
 * Scans ~/.claude-vault/ for transcripts — each project's top level and the
 * subagents inside every session directory — parses them into exchanges,
 * generates embeddings, and stores in SQLite with vec + FTS5.
 *
 * Exchange-level delta: hashes each exchange by content,
 * only embeds new ones. Handles growing session files correctly.
 *
 * Usage:
 *   node indexer.js              # incremental (default)
 *   node indexer.js --full       # re-index everything
 *   node indexer.js --file path  # index single file
 */

import path from 'path';
import os from 'os';
import { parseTranscript } from './lib/parser.js';
import { getDb, closeDb, getIndexedIds, upsertExchange, deleteByArchive, upsertEssence, listIndexedArchives } from './lib/db.js';
import { embedExchange, initEmbeddings } from './lib/embeddings.js';
import { extractExchangeEssence } from './lib/essence.js';
import { findArchivedTranscripts, projectOf } from './lib/transcripts.js';

const VAULT_DIR = path.join(os.homedir(), '.claude-vault');

async function indexFile(filePath, project, fullReindex = false) {
  const exchanges = await parseTranscript(filePath, project);

  // Clear before the empty check, not after it. A transcript that became empty
  // or unparseable returned early and kept every exchange it used to have,
  // which is exactly the case --full exists to correct.
  const existingIds = fullReindex ? new Set() : getIndexedIds(filePath);
  if (fullReindex) {
    deleteByArchive(filePath);
  }

  if (exchanges.length === 0) return { indexed: 0, skipped: 0 };

  let indexed = 0;
  let skipped = 0;

  // A sidechain's entries carry isSidechain themselves, but the filename is
  // the part that cannot be wrong: agent-*.jsonl is a subagent transcript
  // whatever its contents claim. Without this, a file missing the flag joins
  // the default results silently — the failure nobody notices.
  const sidechain = path.basename(filePath).startsWith('agent-');

  for (const exchange of exchanges) {
    if (existingIds.has(exchange.id)) {
      skipped++;
      continue;
    }

    const toolNames = exchange.toolCalls?.map(t => t.toolName);
    const embedding = await embedExchange(
      exchange.userMessage,
      exchange.assistantMessage,
      toolNames
    );

    upsertExchange(sidechain ? { ...exchange, isSidechain: true } : exchange, embedding);
    if (!exchange.isSystemNoise) {
      const extracts = extractExchangeEssence(exchange);
      upsertEssence(exchange.id, exchange.project, extracts);
    }
    indexed++;
  }

  return { indexed, skipped };
}

async function main() {
  const args = process.argv.slice(2);
  const fullReindex = args.includes('--full');
  const fileIdx = args.indexOf('--file');
  const singleFile = fileIdx !== -1 ? args[fileIdx + 1] : null;
  const quiet = args.includes('--quiet');

  const log = quiet ? () => {} : (msg) => console.error(msg);

  log('Initializing embedding model...');
  await initEmbeddings();

  getDb();

  let totalIndexed = 0;
  let totalSkipped = 0;
  let totalFiles = 0;

  if (singleFile) {
    const project = projectOf(path.resolve(singleFile), VAULT_DIR);
    log(`Indexing ${singleFile}...`);
    const { indexed, skipped } = await indexFile(singleFile, project, fullReindex);
    totalIndexed = indexed;
    totalSkipped = skipped;
    totalFiles = 1;
  } else {
    // One walk shared with the tests, so what the indexer reads and what the
    // reconciliation below keeps are the same set. A private top-level-only
    // copy missed every subagent inside a session directory — and would have
    // dropped any the hook had indexed as "no longer on disk".
    const files = findArchivedTranscripts(VAULT_DIR);
    totalFiles = files.length;
    log(`Found ${files.length} JSONL files in vault`);

    for (let i = 0; i < files.length; i++) {
      const { path: filePath, project } = files[i];
      const { indexed, skipped } = await indexFile(filePath, project, fullReindex);
      totalIndexed += indexed;
      totalSkipped += skipped;
      if (indexed > 0) {
        log(`  [${i + 1}/${files.length}] ${project}: +${indexed} exchanges`);
      }
    }

    // A file deleted from the archive was never visited again, so its exchanges
    // stayed searchable forever — a full reindex that only ever adds is not a
    // reconciliation. Drop what the scan no longer sees.
    const onDisk = new Set(files.map((f) => f.path));
    const stale = listIndexedArchives().filter((p) => !onDisk.has(p));
    for (const p of stale) deleteByArchive(p);
    if (stale.length) log(`Removed ${stale.length} archive(s) no longer on disk`);
  }

  closeDb();
  log(`Done: ${totalIndexed} indexed, ${totalSkipped} skipped across ${totalFiles} files`);

  return { indexed: totalIndexed, skipped: totalSkipped, files: totalFiles };
}

main().catch(err => {
  console.error('Indexer error:', err);
  process.exit(1);
});
