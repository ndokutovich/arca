import { getDb } from './db.js';
import { embed, warmModel } from './embeddings.js';

/**
 * Hybrid search: vector (sqlite-vec) + text (FTS5) with Reciprocal Rank Fusion.
 *
 * @param {string} query
 * @param {Object} options
 * @param {number} [options.limit=10]
 * @param {'semantic'|'keyword'|'hybrid'} [options.mode='hybrid']
 * @param {string} [options.after]  - YYYY-MM-DD
 * @param {string} [options.before] - YYYY-MM-DD
 * @param {string} [options.project]
 * @param {string} [options.source] only this assistant: claude_code, claude_ai, codex, ...
 * @param {boolean} [options.includeAgents=false] also return subagent sidechains
 * @returns {Promise<Array<{id:string, project:string, timestamp:string, promptText:string, replyText:string, transcriptPath:string, firstLine:number, lastLine:number, score:number, retrieval:string, provider:string}>>}
 */
export async function search(query, options = {}) {
  const { limit = 10, mode = 'hybrid', after, before, project, source, includeAgents = false } = options;
  const db = getDb();

  const K = 60; // RRF constant

  let vectorResults = [];
  let textResults = [];

  if (mode === 'semantic' || mode === 'hybrid') {
    await warmModel();
    const queryEmb = await embed(query);
    const embBuf = Buffer.from(new Float32Array(queryEmb).buffer);

    const fetchLimit = mode === 'hybrid' ? limit * 3 : limit;

    let sql = `
      SELECT e.*, vec.distance
      FROM vec_turns AS vec
      JOIN turns AS e ON vec.id = e.id
      WHERE vec.embedding MATCH ? AND k = ?
    `;
    const params = [embBuf, fetchLimit];

    if (after) { sql += ' AND e.timestamp >= ?'; params.push(after); }
    if (before) { sql += ' AND e.timestamp <= ?'; params.push(before); }
    if (project) { sql += ' AND e.project = ? COLLATE NOCASE'; params.push(project); }
    if (source) { sql += ' AND e.source = ?'; params.push(source); }
    if (!includeAgents) sql += ' AND e.from_agent = 0';

    sql += ' ORDER BY vec.distance ASC';

    vectorResults = db.prepare(sql).all(...params);
  }

  if (mode === 'keyword' || mode === 'hybrid') {
    const fetchLimit = mode === 'hybrid' ? limit * 3 : limit;
    const ftsQuery = tokenizeForFts(query);

    let sql = `
      SELECT e.*, fts.rank AS fts_rank
      FROM fts_turns AS fts
      JOIN turns AS e ON fts.id = e.id
      WHERE fts_turns MATCH ?
    `;
    const params = [ftsQuery];

    if (after) { sql += ' AND e.timestamp >= ?'; params.push(after); }
    if (before) { sql += ' AND e.timestamp <= ?'; params.push(before); }
    if (project) { sql += ' AND e.project = ? COLLATE NOCASE'; params.push(project); }
    if (source) { sql += ' AND e.source = ?'; params.push(source); }
    if (!includeAgents) sql += ' AND e.from_agent = 0';

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

  if (mode === 'semantic') return formatRows(vectorResults, limit);
  if (mode === 'keyword') return formatRows(textResults, limit, 'keyword');

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
  const { limit = 10, after, before, project, source, mode = 'hybrid', includeAgents = false } = options;

  // The mode was accepted and ignored: --mode keyword on a multi-concept query
  // still ran semantic-only, so asking for exact terms quietly got you
  // neighbours instead.
  const perConcept = await Promise.all(
    concepts.map(c => search(c, { limit: limit * 5, mode, after, before, project, source, includeAgents }))
  );

  const byConversation = new Map();
  perConcept.forEach((results, ci) => {
    for (const r of results) {
      const key = r.transcriptPath;
      if (!byConversation.has(key)) byConversation.set(key, { hits: new Map(), firstResult: r });
      byConversation.get(key).hits.set(ci, r.score);
    }
  });

  const matches = [];
  for (const [transcriptPath, { hits, firstResult }] of byConversation) {
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
  let sql = `SELECT * FROM turns WHERE (prompt_text LIKE ? OR reply_text LIKE ?)`;
  const params = [`%${query}%`, `%${query}%`];
  if (after) { sql += ' AND timestamp >= ?'; params.push(after); }
  if (before) { sql += ' AND timestamp <= ?'; params.push(before); }
  if (project) { sql += ' AND project = ? COLLATE NOCASE'; params.push(project); }
  if (source) { sql += ' AND source = ?'; params.push(source); }
  sql += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}

// `retrieval` is how this row was found; `provider` is which assistant wrote
// it. Both were called "source" until the second one existed, and the third
// argument here quietly shadowed the column.
function mapRow(row, score, retrieval = 'semantic') {
  return {
    id: row.id,
    project: row.project,
    provider: row.source || 'claude_code',
    timestamp: row.timestamp,
    promptText: row.prompt_text,
    replyText: row.reply_text,
    transcriptPath: row.transcript_path,
    firstLine: row.first_line,
    lastLine: row.last_line,
    sessionId: row.session_id,
    toolsUsed: row.tools_used,
    score,
    retrieval,
  };
}

function formatRows(rows, limit, retrieval = 'semantic') {
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
    const preview = (r.promptText || '').slice(0, 200).replace(/\s+/g, ' ').trim();

    // The provider is named only when it is not Claude Code: on a vault with
    // one source it would be a word repeated on every line.
    const from = r.provider && r.provider !== 'claude_code' ? `${r.provider} · ` : '';
    out += `${i + 1}. **[${from}${r.project}, ${date}]**`;
    if (scorePct !== null && r.retrieval !== 'hybrid') out += ` — ${scorePct}% match`;
    if (r.retrieval === 'hybrid') out += ` — rank #${i + 1}`;
    out += '\n';
    out += `   "${preview}${r.promptText?.length > 200 ? '...' : ''}"\n`;
    if (r.toolsUsed) out += `   Tools: ${r.toolsUsed}\n`;
    out += `   Lines ${r.firstLine}-${r.lastLine} in ${r.transcriptPath}\n\n`;
  }

  return out;
}

export function formatMultiConceptMarkdown(results, concepts) {
  if (results.length === 0) return `No conversations matching all concepts: ${concepts.join(', ')}`;

  let out = `Found ${results.length} conversation${results.length > 1 ? 's' : ''} matching [${concepts.join(' + ')}]:\n\n`;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const date = r.timestamp?.slice(0, 10) || 'unknown';
    const scorePct = Math.round(r.score * 100);
    const preview = (r.promptText || '').slice(0, 200).replace(/\s+/g, ' ').trim();

    const from = r.provider && r.provider !== 'claude_code' ? `${r.provider} · ` : '';
    out += `${i + 1}. **[${from}${r.project}, ${date}]** — ${scorePct}% avg match\n`;
    out += `   "${preview}${r.promptText?.length > 200 ? '...' : ''}"\n`;
    out += `   Lines ${r.firstLine}-${r.lastLine} in ${r.transcriptPath}\n\n`;
  }

  return out;
}
