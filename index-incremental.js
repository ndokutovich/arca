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
import { extractTurnEssence } from './lib/essence.js';
import { getDb, closeDb, getIndexedIds, upsertTurn, upsertEssence } from './lib/db.js';
import { embedTurn, warmModel } from './lib/embeddings.js';
import { projectOf, isSidechainFile } from './lib/transcripts.js';

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
  await warmModel();
  getDb();

  let totalIndexed = 0;

  for (const filePath of files) {
    if (!fs.existsSync(filePath)) continue;
    // The directory under the vault, not the file's parent: a subagent in
    // <project>/<session>/subagents/ would otherwise be filed under "subagents".
    const project = projectOf(path.resolve(filePath));
    // As in the full indexer: agent-*.jsonl is a sidechain whatever its
    // entries claim, and one missing the flag would join default results.
    const sidechain = isSidechainFile(path.basename(filePath));
    const turns = await parseTranscript(filePath, project);
    const existingIds = getIndexedIds(filePath);

    for (const turn of turns) {
      if (existingIds.has(turn.id)) continue;
      const toolsUsed = turn.toolCalls?.map(t => t.toolName);
      const embedding = await embedTurn(turn.promptText, turn.replyText, toolsUsed);
      upsertTurn(sidechain ? { ...turn, fromAgent: true } : turn, embedding);
      // The full indexer writes the essence layer here too. Leaving it out
      // meant every turn the hook indexed had no decisions, constraints or
      // tensions extracted — the layer was silently only as current as the
      // last full re-index.
      upsertEssence(turn.id, turn.project, extractTurnEssence(turn));
      totalIndexed++;
    }
  }

  if (totalIndexed > 0) {
    console.error(`arca: indexed ${totalIndexed} new turns from ${files.length} files`);
  }
} catch (err) {
  // The hook's pipeline decides whether to rebuild the derived layers from
  // this run's exit status, so reporting failure as success let it rebuild
  // entities, the graph and threads from a half-written index.
  console.error('arca index error:', err.message);
  process.exitCode = 1;
} finally {
  try { closeDb(); } catch { /* already closed or never opened */ }
}
