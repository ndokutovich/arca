#!/usr/bin/env node
/**
 * Lightweight incremental indexer for use from session-vault hook.
 * Only indexes files that were copied in the current vault backup.
 *
 * Usage: node index-incremental.js <file1> <file2> ...
 * Or:    echo '["file1","file2"]' | node index-incremental.js --stdin
 */

import fs from 'fs';
import path from 'path';
import { parseTranscript } from './lib/parser.js';
import { getDb, closeDb, getIndexedIds, upsertExchange } from './lib/db.js';
import { embedExchange, initEmbeddings } from './lib/embeddings.js';

const args = process.argv.slice(2);

let files = [];
if (args.includes('--stdin')) {
  const input = fs.readFileSync(0, 'utf-8').trim();
  try { files = JSON.parse(input); } catch { files = []; }
} else {
  files = args.filter(a => a.endsWith('.jsonl'));
}

if (files.length === 0) {
  process.exit(0);
}

try {
  await initEmbeddings();
  getDb();

  let totalIndexed = 0;

  for (const filePath of files) {
    if (!fs.existsSync(filePath)) continue;
    const project = path.basename(path.dirname(filePath));
    const exchanges = await parseTranscript(filePath, project);
    const existingIds = getIndexedIds(filePath);

    for (const exchange of exchanges) {
      if (existingIds.has(exchange.id)) continue;
      const toolNames = exchange.toolCalls?.map(t => t.toolName);
      const embedding = await embedExchange(exchange.userMessage, exchange.assistantMessage, toolNames);
      upsertExchange(exchange, embedding);
      totalIndexed++;
    }
  }

  closeDb();
  if (totalIndexed > 0) {
    console.error(`arca: indexed ${totalIndexed} new exchanges from ${files.length} files`);
  }
} catch (err) {
  console.error('arca index error:', err.message);
}
