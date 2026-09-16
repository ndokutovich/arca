#!/usr/bin/env node
/**
 * Incremental indexer for arca.
 *
 * Scans ~/.claude-vault/ for JSONL files, parses into exchanges,
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

import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseTranscript } from './lib/parser.js';
import { getDb, closeDb, getIndexedIds, upsertExchange, deleteByArchive, upsertEssence } from './lib/db.js';
import { embedExchange, initEmbeddings } from './lib/embeddings.js';
import { extractExchangeEssence } from './lib/essence.js';

const VAULT_DIR = path.join(os.homedir(), '.claude-vault');

function findJsonlFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'index') {
      const projDir = path.join(dir, entry.name);
      for (const file of fs.readdirSync(projDir, { withFileTypes: true })) {
        if (file.isFile() && file.name.endsWith('.jsonl')) {
          results.push({
            path: path.join(projDir, file.name),
            project: entry.name,
          });
        }
      }
    }
  }
  return results;
}

async function indexFile(filePath, project, fullReindex = false) {
  const exchanges = await parseTranscript(filePath, project);
  if (exchanges.length === 0) return { indexed: 0, skipped: 0 };

  const existingIds = fullReindex ? new Set() : getIndexedIds(filePath);

  if (fullReindex) {
    deleteByArchive(filePath);
  }

  let indexed = 0;
  let skipped = 0;

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

    upsertExchange(exchange, embedding);
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
    const project = path.basename(path.dirname(singleFile));
    log(`Indexing ${singleFile}...`);
    const { indexed, skipped } = await indexFile(singleFile, project, fullReindex);
    totalIndexed = indexed;
    totalSkipped = skipped;
    totalFiles = 1;
  } else {
    const files = findJsonlFiles(VAULT_DIR);
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
  }

  closeDb();
  log(`Done: ${totalIndexed} indexed, ${totalSkipped} skipped across ${totalFiles} files`);

  return { indexed: totalIndexed, skipped: totalSkipped, files: totalFiles };
}

main().catch(err => {
  console.error('Indexer error:', err);
  process.exit(1);
});
