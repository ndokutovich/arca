#!/usr/bin/env node
/**
 * Temporal knowledge-graph derivation pass.
 *
 * Reads indexed exchanges in CHRONOLOGICAL order and feeds extracted facts to
 * addTriple(), so single-valued predicates (runs_on_port, has_version)
 * supersede correctly and build valid-time windows. Auto-extracted triples are
 * cleared and rebuilt each run; manually-added facts (method='manual') are kept.
 *
 * Usage:
 *   node build-kg.js          # rebuild auto facts
 *   node build-kg.js --quiet
 */

import { transaction, getDb, closeDb, clearAutoTriples, addTriple, kgStats } from './lib/db.js';
import { extractFacts } from './lib/kg.js';

const METHOD = { runs_on_port: 'auto:port', has_version: 'auto:version', replaced_by: 'auto:transition' };

function main() {
  const quiet = process.argv.includes('--quiet');
  const log = quiet ? () => {} : (m) => console.error(m);

  const db = getDb();
  // Clearing before extraction meant any failure during the rebuild removed the
  // previous graph for good. Collect everything first, then swap in one
  // transaction: a failed run now leaves the old graph untouched.
  const pendingFacts = [];

  // Gate facts to resolved entities (project span >= 2) — KG rides on real nodes.
  const known = new Set(db.prepare('SELECT id FROM entities WHERE project_count >= 2').all().map((r) => r.id));
  log(`${known.size} known entity subjects.`);

  const rows = db.prepare(`
    SELECT id, project, timestamp, user_message, assistant_message
    FROM exchanges
    WHERE is_system_noise = 0
    ORDER BY COALESCE(timestamp, '') ASC, id ASC
  `).all();
  log(`Scanning ${rows.length} exchanges chronologically...`);

  // Extract first, into memory; nothing in the database has changed yet.
  for (const r of rows) {
    const day = (r.timestamp || '').slice(0, 10) || null;
    for (const msg of [r.user_message, r.assistant_message]) {
      if (!msg) continue;
      for (const f of extractFacts(msg, { known })) {
        pendingFacts.push({
          subject: f.subject, predicate: f.predicate, object: f.object,
          valid_from: day, confidence: f.confidence,
          method: METHOD[f.predicate] || 'auto', source_exchange: r.id, source_project: r.project,
        });
      }
    }
  }

  // Then swap: clear the previous auto-layer and write the new one together,
  // so an interrupted rebuild leaves the old graph rather than no graph.
  let added = 0;
  let removed = 0;
  transaction(() => {
    removed = clearAutoTriples();
    for (const f of pendingFacts) {
      if (addTriple(f)) added++;
    }
  })();
  log(`Cleared ${removed} prior auto-triples.`);

  const s = kgStats();
  log(`Done: ${added} triple-writes · ${s.triples} total (${s.current} current) across ${s.subjects} subjects`);

  if (!quiet) {
    console.error('\nPredicates:');
    for (const p of s.predicates) console.error(`  ${String(p.c).padStart(4)}  ${p.predicate}`);
    console.error('\nSample current facts:');
    const sample = db.prepare(`
      SELECT subject, predicate, object, valid_from FROM kg_triples
      WHERE valid_to IS NULL AND method LIKE 'auto:%'
      ORDER BY subject, predicate LIMIT 25
    `).all();
    for (const t of sample) console.error(`  ${t.subject} —${t.predicate}→ ${t.object}  (since ${t.valid_from || '?'})`);
  }

  closeDb();
}

main();
