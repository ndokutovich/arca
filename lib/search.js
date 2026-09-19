import { getDb } from './db.js';
import { embed, initEmbeddings } from './embeddings.js';

/**
 * Hybrid search: vector (sqlite-vec) + text (FTS5) with Reciprocal Rank Fusion.
 *
 * @param {string} query
 * @param {Object} options
 * @param {number} [options.limit=10]
 * @param {'vector'|'text'|'both'} [options.mode='both']
 * @param {string} [options.after]  - YYYY-MM-DD
 * @param {string} [options.before] - YYYY-MM-DD
 * @param {string} [options.project]
 * @param {string} [options.source] only this assistant: claude_code, claude_ai, codex, ...
 * @returns {Promise<Array<{id:string, project:string, timestamp:string, userMessage:string, assistantMessage:string, archivePath:string, lineStart:number, lineEnd:number, score:number, retrieval:string, provider:string}>>}
 */
export async function search(query, options = {}) {
  const { limit = 10, mode = 'both', after, before, project, source } = options;
  const db = getDb();

  const K = 60; // RRF constant

  let vectorResults = [];
  let textResults = [];

  if (mode === 'vector' || mode === 'both') {
    await initEmbeddings();
    const queryEmb = await embed(query);
    const embBuf = Buffer.from(new Float32Array(queryEmb).buffer);

    const fetchLimit = mode === 'both' ? limit * 3 : limit;

    let sql = `
      SELECT e.*, vec.distance
      FROM vec_exchanges AS vec
      JOIN exchanges AS e ON vec.id = e.id
      WHERE vec.embedding MATCH ? AND k = ?
    `;
    const params = [embBuf, fetchLimit];

    if (after) { sql += ' AND e.timestamp >= ?'; params.push(after); }
    if (before) { sql += ' AND e.timestamp <= ?'; params.push(before); }
    if (project) { sql += ' AND e.project = ?'; params.push(project); }
    if (source) { sql += ' AND e.source = ?'; params.push(source); }

    sql += ' ORDER BY vec.distance ASC';

    vectorResults = db.prepare(sql).all(...params);
  }

  if (mode === 'text' || mode === 'both') {
    const fetchLimit = mode === 'both' ? limit * 3 : limit;
    const ftsQuery = tokenizeForFts(query);

    let sql = `
      SELECT e.*, fts.rank AS fts_rank
      FROM fts_exchanges AS fts
      JOIN exchanges AS e ON fts.id = e.id
      WHERE fts_exchanges MATCH ?
    `;
    const params = [ftsQuery];

    if (after) { sql += ' AND e.timestamp >= ?'; params.push(after); }
    if (before) { sql += ' AND e.timestamp <= ?'; params.push(before); }
    if (project) { sql += ' AND e.project = ?'; params.push(project); }
    if (source) { sql += ' AND e.source = ?'; params.push(source); }

    sql += ' ORDER BY fts.rank LIMIT ?';
    params.push(fetchLimit);

    try {
      textResults = db.prepare(sql).all(...params);
    } catch (e) {
      // Only a malformed MATCH expression earns the LIKE fallback. Catching
      // everything turned a corrupt or missing FTS table into a quietly worse
      // search that still reported success — the failure mode you least want
      // from something whose whole job is recall.
      const msg = String((e && e.message) || e);
      const isSyntax = /fts5: syntax error|malformed MATCH|unrecognized token|no such column/i.test(msg);
      if (!isSyntax) throw e;
      textResults = fallbackLikeSearch(db, query, { limit: fetchLimit, after, before, project, source });
    }
  }

  if (mode === 'vector') return formatRows(vectorResults, limit);
  if (mode === 'text') return formatRows(textResults, limit, 'text');

  // RRF fusion
  const scores = new Map();
  const rowMap = new Map();

  vectorResults.forEach((row, rank) => {
    const id = row.id;
    rowMap.set(id, row);
    scores.set(id, (scores.get(id) || 0) + 1 / (K + rank + 1));
  });

  textResults.forEach((row, rank) => {
    const id = row.id;
    if (!rowMap.has(id)) rowMap.set(id, row);
    scores.set(id, (scores.get(id) || 0) + 1 / (K + rank + 1));
  });

  const fused = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, score]) => {
      const row = rowMap.get(id);
      return mapRow(row, score, 'hybrid');
    });

  return fused;
}

/**
 * Multi-concept AND search: all concepts must appear in the same conversation.
 */
export async function searchMultiConcept(concepts, options = {}) {
  const { limit = 10, after, before, project, source, mode = 'both' } = options;

  // The mode was accepted and ignored: --mode text on a multi-concept query
  // still ran vector-only, so asking for exact terms quietly got you semantic
  // neighbours instead.
  const conceptResults = await Promise.all(
    concepts.map(c => search(c, { limit: limit * 5, mode, after, before, project, source }))
  );

  const byConversation = new Map();
  conceptResults.forEach((results, ci) => {
    for (const r of results) {
      const key = r.archivePath;
      if (!byConversation.has(key)) byConversation.set(key, { hits: new Map(), firstResult: r });
      byConversation.get(key).hits.set(ci, r.score);
    }
  });

  const matches = [];
  for (const [archivePath, { hits, firstResult }] of byConversation) {
    if (hits.size < concepts.length) continue;
    const avgScore = [...hits.values()].reduce((a, b) => a + b, 0) / concepts.length;
    matches.push({ ...firstResult, score: avgScore });
  }

  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, limit);
}

function tokenizeForFts(query) {
  return query
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2)
    .map(w => `"${w}"`)
    .join(' OR ');
}

function fallbackLikeSearch(db, query, { limit, after, before, project, source }) {
  let sql = `SELECT * FROM exchanges WHERE (user_message LIKE ? OR assistant_message LIKE ?)`;
  const params = [`%${query}%`, `%${query}%`];
  if (after) { sql += ' AND timestamp >= ?'; params.push(after); }
  if (before) { sql += ' AND timestamp <= ?'; params.push(before); }
  if (project) { sql += ' AND project = ?'; params.push(project); }
  if (source) { sql += ' AND source = ?'; params.push(source); }
  sql += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}

// `retrieval` is how this row was found; `provider` is which assistant wrote
// it. Both were called "source" until the second one existed, and the third
// argument here quietly shadowed the column.
function mapRow(row, score, retrieval = 'vector') {
  return {
    id: row.id,
    project: row.project,
    provider: row.source || 'claude_code',
    timestamp: row.timestamp,
    userMessage: row.user_message,
    assistantMessage: row.assistant_message,
    archivePath: row.archive_path,
    lineStart: row.line_start,
    lineEnd: row.line_end,
    sessionId: row.session_id,
    toolNames: row.tool_names,
    score,
    retrieval,
  };
}

function formatRows(rows, limit, retrieval = 'vector') {
  return rows.slice(0, limit).map((row, i) => {
    let score;
    if (row.distance != null) {
      // sqlite-vec returns L2 distance for normalized vectors
      // For normalized vectors: L2² = 2(1 - cosine_similarity)
      // So: cosine_similarity = 1 - L2²/2
      score = Math.max(0, 1 - (row.distance * row.distance) / 2);
    } else {
      score = row.fts_rank ? Math.min(1, -row.fts_rank / 10) : 1;
    }
    return mapRow(row, score, retrieval);
  });
}

/**
 * Format results as markdown for MCP response.
 */
export function formatResultsMarkdown(results) {
  if (results.length === 0) return 'No results found.';

  let out = `Found ${results.length} result${results.length > 1 ? 's' : ''}:\n\n`;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const date = r.timestamp?.slice(0, 10) || 'unknown';
    const scorePct = typeof r.score === 'number' ? Math.round(r.score * 100) : null;
    const snippet = (r.userMessage || '').slice(0, 200).replace(/\s+/g, ' ').trim();

    // The provider is named only when it is not Claude Code: on a vault with
    // one source it would be a word repeated on every line.
    const from = r.provider && r.provider !== 'claude_code' ? `${r.provider} · ` : '';
    out += `${i + 1}. **[${from}${r.project}, ${date}]**`;
    if (scorePct !== null && r.retrieval !== 'hybrid') out += ` — ${scorePct}% match`;
    if (r.retrieval === 'hybrid') out += ` — rank #${i + 1}`;
    out += '\n';
    out += `   "${snippet}${r.userMessage?.length > 200 ? '...' : ''}"\n`;
    if (r.toolNames) out += `   Tools: ${r.toolNames}\n`;
    out += `   Lines ${r.lineStart}-${r.lineEnd} in ${r.archivePath}\n\n`;
  }

  return out;
}

export function formatMultiConceptMarkdown(results, concepts) {
  if (results.length === 0) return `No conversations matching all concepts: ${concepts.join(', ')}`;

  let out = `Found ${results.length} conversation${results.length > 1 ? 's' : ''} matching [${concepts.join(' + ')}]:\n\n`;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const date = r.timestamp?.slice(0, 10) || 'unknown';
    const avgPct = Math.round(r.score * 100);
    const snippet = (r.userMessage || '').slice(0, 200).replace(/\s+/g, ' ').trim();

    const from = r.provider && r.provider !== 'claude_code' ? `${r.provider} · ` : '';
    out += `${i + 1}. **[${from}${r.project}, ${date}]** — ${avgPct}% avg match\n`;
    out += `   "${snippet}${r.userMessage?.length > 200 ? '...' : ''}"\n`;
    out += `   Lines ${r.lineStart}-${r.lineEnd} in ${r.archivePath}\n\n`;
  }

  return out;
}
