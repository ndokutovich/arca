#!/usr/bin/env node
/**
 * Backfill — populate the new analytic columns + essence layer for
 * exchanges already in the DB, without touching embeddings.
 *
 * Idempotent: safe to re-run. Reads each exchange, computes
 * is_system_noise + prompt_kind + essence_extracts, writes them back.
 */

import { getDb, closeDb, upsertEssence } from './lib/db.js';
import { isSystemNoise } from './lib/noise.js';
import { classifyPrompt } from './lib/control.js';
import { extractExchangeEssence } from './lib/essence.js';

function main() {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as c FROM exchanges').get().c;
  console.error(`Backfilling ${total} exchanges...`);

  const update = db.prepare(`
    UPDATE exchanges
    SET is_system_noise = ?, prompt_kind = ?
    WHERE id = ?
  `);

  const rows = db.prepare(`
    SELECT id, project, user_message, assistant_message
    FROM exchanges
  `).all();

  const tx = db.transaction(() => {
    let processed = 0;
    let noiseCount = 0;
    let essenceCount = 0;
    const t0 = Date.now();
    for (const row of rows) {
      const noise = isSystemNoise(row.user_message);
      const kind = classifyPrompt(row.user_message);
      update.run(noise ? 1 : 0, kind, row.id);
      if (!noise) {
        const extracts = extractExchangeEssence({
          userMessage: row.user_message,
          assistantMessage: row.assistant_message,
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
  console.error(`Done: ${result.processed} exchanges`);
  console.error(`  system-noise: ${result.noiseCount}`);
  console.error(`  essence extracts: ${result.essenceCount}`);
  closeDb();
}

main();
