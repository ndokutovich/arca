#!/usr/bin/env node
/**
 * Cross-project entity derivation pass.
 *
 * Reads already-indexed turns (no re-embedding), extracts named
 * entities, aggregates them across projects, and writes the entity layer.
 * An entity qualifies if it is in the gazetteer, spans >=2 projects, or
 * is mentioned >= MIN_MENTIONS times — killing one-off noise while
 * surfacing the connective tissue that threads the operator's work.
 *
 * Usage:
 *   node build-entities.js          # full rebuild of the entity layer
 *   node build-entities.js --quiet
 */

import { transaction, getDb, closeDb, upsertEntityMentions, recomputeEntityAggregates } from './lib/db.js';
import { extractEntities, mentionSnippet, GAZETTEER } from './lib/entities.js';

const MIN_MENTIONS = 4;       // single-project entities need this many to survive
const KEEP_PER_PROJECT = 8;   // cap stored mentions per (entity, project), preserves span

function main() {
  const quiet = process.argv.includes('--quiet');
  const log = quiet ? () => {} : (m) => console.error(m);

  const db = getDb();
  const rows = db.prepare(`
    SELECT id, project, timestamp, prompt_text, reply_text
    FROM turns
    WHERE is_noise = 0
  `).all();
  log(`Scanning ${rows.length} turns...`);

  // Pass 1 — accumulate candidates globally.
  // key -> { type, projects:Set, mentions:[{turnId,project,timestamp,speaker,surface,snippet}] }
  const cand = new Map();
  const addMention = (key, type, exId, project, ts, speaker, surface, snippet) => {
    let e = cand.get(key);
    if (!e) { e = { type, projects: new Set(), mentions: [] }; cand.set(key, e); }
    e.projects.add(project);
    e.mentions.push({ turnId: exId, project, timestamp: ts, speaker, surface, snippet });
  };

  for (const r of rows) {
    for (const [msg, speaker] of [[r.prompt_text, 'user'], [r.reply_text, 'assistant']]) {
      if (!msg) continue;
      for (const ent of extractEntities(msg)) {
        addMention(ent.key, ent.type, r.id, r.project, r.timestamp, speaker,
          ent.surface, mentionSnippet(msg, ent.surface));
      }
    }
  }
  log(`  ${cand.size} raw candidate keys`);

  // Pass 2 — qualify, cap per project, collect mentions per turn.
  // entity_mentions is keyed (entity_id, turn_id, speaker), so we group writes by turn.
  const byTurn = new Map(); // turnId -> mentions[]
  const typeByKey = new Map();
  let qualified = 0;

  for (const [key, e] of cand) {
    const qualifies = GAZETTEER.has(key) || e.projects.size >= 2 || e.mentions.length >= MIN_MENTIONS;
    if (!qualifies) continue;
    qualified++;
    typeByKey.set(key, e.type);

    // cap per project, newest first — preserves exact project span
    const perProj = new Map();
    e.mentions.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
    for (const m of e.mentions) {
      const n = perProj.get(m.project) || 0;
      if (n >= KEEP_PER_PROJECT) continue;
      perProj.set(m.project, n + 1);
      const list = byTurn.get(m.turnId) || [];
      list.push({ entityId: key, project: m.project, timestamp: m.timestamp,
        speaker: m.speaker, surface: m.surface, snippet: m.snippet });
      byTurn.set(m.turnId, list);
    }
  }
  log(`  ${qualified} entities qualified`);

  // Pass 3 — write mentions (idempotent per turn), recompute aggregates.
  // Clear stale layer first for a clean full rebuild.
  // The clear used to sit outside the transaction below, so an extraction or
  // insert failure left the entity layer empty rather than stale. Stale is
  // recoverable; empty is not.
  let written = 0;
  const tx = transaction(() => {
    db.exec('DELETE FROM entity_mentions');
    for (const [turnId, mentions] of byTurn) {
      upsertEntityMentions(turnId, mentions);
      written += mentions.length;
    }
  });
  tx();
  const n = recomputeEntityAggregates((key) => typeByKey.get(key) || 'concept');
  log(`Done: ${n} entities, ${written} mentions written`);

  // Show the connective tissue: top entities by project span.
  if (!quiet) {
    const top = db.prepare(`
      SELECT canonical, type, project_count, mention_count
      FROM entities ORDER BY project_count DESC, mention_count DESC LIMIT 25
    `).all();
    console.error('\nTop entities by project span:');
    for (const t of top) {
      console.error(`  ${String(t.project_count).padStart(3)} proj  ${String(t.mention_count).padStart(5)} ment  [${t.type}] ${t.canonical}`);
    }
  }

  closeDb();
}

main();
