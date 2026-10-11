#!/usr/bin/env node
/**
 * Backfill — populate the new analytic columns + essence layer for
 * turns already in the DB, without touching embeddings.
 *
 * Idempotent: safe to re-run. Reads each turn, computes
 * is_noise + prompt_class + essence_extracts, writes them back.
 */

import { getDb, closeDb, upsertEssence, transaction } from './lib/db.js';
import { isSystemNoise } from './lib/noise.js';
import { classifyPrompt } from './lib/control.js';
import { extractTurnEssence } from './lib/essence.js';

function main() {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as c FROM turns').get().c;
  console.error(`Backfilling ${total} turns...`);

  const update = db.prepare(`
    UPDATE turns
    SET is_noise = ?, prompt_class = ?
    WHERE id = ?
  `);

  const rows = db.prepare(`
    SELECT id, project, prompt_text, reply_text
    FROM turns
  `).all();

  const tx = transaction(() => {
    let processed = 0;
    let noiseCount = 0;
    let essenceCount = 0;
    const t0 = Date.now();
    for (const row of rows) {
      const noise = isSystemNoise(row.prompt_text);
      const kind = classifyPrompt(row.prompt_text);
      update.run(noise ? 1 : 0, kind, row.id);
      if (!noise) {
        const extracts = extractTurnEssence({
          promptText: row.prompt_text,
          replyText: row.reply_text,
        });
        upsertEssence(row.id, row.project, extracts);
        essenceCount += extracts.length;
      } else {
        noiseCount++;
      }
      processed++;
      if (processed % 500 === 0) {
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        console.error(`  [${processed}/${total}]  noise=${noiseCount}  extracts=${essenceCount}  ${dt}s`);
      }
    }
    return { processed, noiseCount, essenceCount };
  });

  const result = tx();
  console.error('');
  console.error(`Done: ${result.processed} turns`);
  console.error(`  system-noise: ${result.noiseCount}`);
  console.error(`  essence extracts: ${result.essenceCount}`);
  closeDb();
}

main();
