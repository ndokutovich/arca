#!/usr/bin/env node
/**
 * Threads derivation pass — recovers topic-threads from sessions and links
 * them across the whole corpus. Reads already-indexed exchanges and their
 * embeddings (NO re-embedding), segments each session by semantic drift,
 * then clusters segments globally into cross-session threads.
 *
 * Usage:
 *   node build-threads.js                 # full rebuild over all projects
 *   node build-threads.js --project=foo   # restrict to projects matching foo
 *   node build-threads.js --gamma=3       # finer threads (zoom knob)
 *   node build-threads.js --quiet
 */

import { getDb, closeDb, rebuildThreads } from './lib/db.js';
import { buildThreads, assembleThreads, THREAD_DEFAULTS } from './lib/threads.js';

const MIN_SESS_EX = 8; // sessions shorter than this carry no thread structure

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
}

function main() {
  const quiet = process.argv.includes('--quiet');
  const log = quiet ? () => {} : (m) => console.error(m);
  const projectFilter = arg('project', null);
  const opts = {
    gamma: parseFloat(arg('gamma', THREAD_DEFAULTS.gamma)),
    dfMax: parseFloat(arg('df', THREAD_DEFAULTS.dfMax)),
    edgeFloor: parseFloat(arg('floor', THREAD_DEFAULTS.edgeFloor)),
    lambda: parseFloat(arg('lambda', THREAD_DEFAULTS.lambda)),
  };

  const db = getDb();
  const where = ['is_system_noise = 0', 'session_id IS NOT NULL'];
  const params = [];
  // --project used to filter the scan, and the rebuild then replaced the
  // global thread tables with that subset — every other project's threads
  // were deleted. Threads are cross-project by construction: clustering a
  // slice produces different, worse clusters anyway. The filter now applies
  // to what is reported, not to what is rebuilt.

  const rows = db.prepare(`
    SELECT id, project, session_id, timestamp, line_start, user_message, assistant_message
    FROM exchanges WHERE ${where.join(' AND ')}
    ORDER BY session_id, timestamp ASC, line_start ASC
  `).all(...params);
  log(`Scanning ${rows.length} exchanges...`);

  // pull embeddings; group into sessions
  const vecStmt = db.prepare('SELECT embedding FROM vec_exchanges WHERE id = ?');
  const bySession = new Map();
  let missing = 0;
  for (const r of rows) {
    const v = vecStmt.get(r.id);
    if (!v) { missing++; continue; }
    const buf = v.embedding;
    const emb = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    if (!bySession.has(r.session_id)) bySession.set(r.session_id, []);
    bySession.get(r.session_id).push({
      id: r.id, project: r.project, ts: r.timestamp,
      text: `${r.user_message || ''} ${r.assistant_message || ''}`,
      summary: (r.user_message || '').replace(/\s+/g, ' '),
      emb,
    });
  }

  const sessions = [];
  for (const [sid, items] of bySession) {
    if (items.length < MIN_SESS_EX) continue;
    sessions.push({ sessionId: sid, project: items[0].project, items });
  }
  log(`  ${bySession.size} sessions, ${sessions.length} with >=${MIN_SESS_EX} exchanges (${missing} exchanges lacked embeddings)`);

  const t0 = Date.now();
  const { segments, commonEntities } = buildThreads(sessions, opts);
  const { threads } = assembleThreads(segments);
  log(`  segmented + clustered in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  log(`  ${segments.length} segments -> ${threads.length} threads`);
  if (commonEntities) log(`  dropped ${commonEntities.length} common entities: {${commonEntities.slice(0, 14).join(', ')}${commonEntities.length > 14 ? ', …' : ''}}`);

  const written = rebuildThreads({ threads, segments });
  log(`Done: ${written.threads} threads, ${written.segments} segments written.`);

  if (!quiet) {
    const shown = projectFilter
      ? threads.filter((t) => (t.projects || []).some((p) => String(p).toLowerCase().includes(projectFilter.toLowerCase())))
      : threads;
    const cross = shown.filter((t) => t.n_sessions >= 2)
      .sort((a, b) => b.n_sessions - a.n_sessions).slice(0, 20);
    console.error(`\nTop cross-session threads (γ=${opts.gamma}):`);
    for (const t of cross) {
      console.error(
        `  ${String(t.n_exchanges).padStart(4)}ex ${String(t.n_sessions).padStart(2)}sess ` +
        `${t.n_projects}proj ${t.return_count ? '⤺' + String(t.return_count).padStart(2) : '   '}  ${t.label}`
      );
    }
  }
  closeDb();
}

main();
