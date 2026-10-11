import { DatabaseSync } from 'node:sqlite';
import * as sqliteVec from 'sqlite-vec';
import path from 'path';
import fs from 'fs';
import os from 'os';

const VAULT_DIR = path.join(os.homedir(), '.claude-vault');
const INDEX_DIR = path.join(VAULT_DIR, 'index');
const DB_PATH = path.join(INDEX_DIR, 'vault.db');

let _db = null;

function run(db, sql) { db.exec(sql); }

function tableExists(db, name) {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
}


export function getDb() {
  if (_db) return _db;

  if (!fs.existsSync(INDEX_DIR)) {
    fs.mkdirSync(INDEX_DIR, { recursive: true });
  }

  // Node's built-in SQLite instead of better-sqlite3. That module's prebuilt
  // binary is linked against glibc 2.34, which is newer than a lot of ARM
  // single-board systems ship — the failure is an unreadable loader error deep
  // in a dependency. The extension it loads needs only glibc 2.17, so dropping
  // the driver removes the whole class of problem rather than documenting it.
  const db = new DatabaseSync(DB_PATH, { allowExtension: true });
  db.enableLoadExtension(true);
  db.loadExtension(sqliteVec.getLoadablePath());
  db.enableLoadExtension(false);

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  // Derived layers (entities, KG, threads) rebuild whole tables in one
  // transaction while the indexer is still writing turns. The 5s
  // better-sqlite3 default is far too short for that and killed a full
  // reindex with SQLITE_BUSY.
  db.exec('PRAGMA busy_timeout = 60000');

  run(db, `CREATE TABLE IF NOT EXISTS schema_state (key TEXT PRIMARY KEY, value TEXT)`);

  // The index is derived, so a layout change is answered by dropping the
  // affected tables rather than migrating them: `arca index` and the builders
  // refill everything. It is keyed on a version because it must happen once —
  // `CREATE TABLE IF NOT EXISTS` cannot change a table that already exists, so
  // a database predating this layout would keep `exchange_id` where the code
  // now says `turn_id`, and every statement naming the new column would fail.
  // Doing it on every open would be the worse bug: it would empty the derived
  // layers on each connection.
  // The stamp alone is not enough to trust: it records that a migration ran,
  // not that it ran correctly. A database stamped by a build that dropped the
  // wrong tables would otherwise skip this for good.
  //
  // So the schema is checked as well — but against the vocabulary that was
  // renamed away, not against the names that replaced it. The old names are a
  // finite, known set; naming the new ones instead means naming every column of
  // every table, and silently missing whichever one is forgotten. Anything
  // still carrying an old name has not been brought forward, whichever table it
  // is in, and one rebuild is a price worth paying to be sure.
  const LAYOUT = 'turns-v1';
  const LEGACY_TABLES = ['exchanges', 'vec_exchanges', 'fts_exchanges'];
  const LEGACY_COLUMNS = new Set([
    'exchange_id', 'user_message', 'assistant_message', 'archive_path',
    'line_start', 'line_end', 'git_branch', 'is_sidechain', 'tool_names',
    'prompt_kind', 'is_system_noise', 'content_hash', 'indexed_at',
    'n_exchanges', 'exch_start', 'exch_end',
  ]);
  const legacyNameRemains = () => {
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
    ).all();
    for (const { name } of tables) {
      // Bound, not interpolated: a table name is data read back out of the
      // database, and pragma_table_info takes it as a value.
      for (const col of db.prepare('SELECT name FROM pragma_table_info(?)').all(name)) {
        if (LEGACY_COLUMNS.has(col.name)) return true;
      }
    }
    return false;
  };
  const laidOutRight = () =>
    tableExists(db, 'turns')
    && !LEGACY_TABLES.some((t) => tableExists(db, t))
    && !legacyNameRemains();

  // IMMEDIATE, and not a read followed by writes: two processes opening the
  // same index at once would both see no stamp, and the second would drop the
  // tables the first had just rebuilt — leaving turns whose essence the next
  // incremental run would then skip. The write lock is taken before the read.
  try {
    db.exec('BEGIN IMMEDIATE');
    const stamped = db.prepare(`SELECT value FROM schema_state WHERE key = 'layout'`).get();
    if (stamped?.value !== LAYOUT || !laidOutRight()) {
      for (const stale of [
        'exchanges', 'vec_exchanges', 'fts_exchanges',        // the turn layer itself
        'essence_extracts', 'fts_essence', 'entity_mentions', // keyed on the turn id
        'entities', 'fts_entities',                           // aggregates over those
        'threads', 'thread_segments', 'fts_threads', 'vec_threads',
      ]) {
        run(db, `DROP TABLE IF EXISTS ${stale}`);
      }
      db.prepare(`INSERT OR REPLACE INTO schema_state (key, value) VALUES ('layout', ?)`)
        .run(LAYOUT);
    }
    db.exec('COMMIT');
  } catch (e) {
    // A failed BEGIN has no transaction to roll back; a failed migration does.
    try { db.exec('ROLLBACK'); } catch { /* no transaction, or already rolled back */ }
    try { db.close(); } catch { /* nothing to close */ }
    throw e;
  }

  run(db, `
    CREATE TABLE IF NOT EXISTS turns (
      id              TEXT PRIMARY KEY,
      session_id      TEXT,
      project         TEXT NOT NULL,
      timestamp       TEXT NOT NULL,
      prompt_text     TEXT NOT NULL,
      reply_text      TEXT NOT NULL,
      transcript_path TEXT NOT NULL,
      first_line      INTEGER NOT NULL,
      last_line       INTEGER NOT NULL,
      cwd             TEXT,
      branch          TEXT,
      from_agent      BOOLEAN DEFAULT 0,
      tools_used      TEXT,
      is_noise        BOOLEAN DEFAULT 0,
      prompt_class    TEXT,
      source          TEXT DEFAULT 'claude_code',
      body_hash       TEXT,
      machine         TEXT,
      indexed_ms      INTEGER NOT NULL
    )
  `);

  // Columns that arrived after the first release. On a database created by this
  // file they already exist, so each ALTER is refused with "duplicate column"
  // and ignored; on an older one this is what adds them.
  //
  //   source    the product the turn came from. Until this column existed the
  //             only clue was a 'claude-ai-' prefix on the project name, which
  //             breaks the moment a real project is named that way.
  //   body_hash the id is episode-scoped, so identical text no longer shares a
  //             key; the hash keeps "have we said this exact thing before" a
  //             question the index can answer.
  //   machine   filled from the vault's machine manifests by session id rather
  //             than on insert, so it stays right after a pull brings another
  //             machine's sessions in without re-indexing anything.
  for (const [col, def] of [
    ['is_noise',     'BOOLEAN DEFAULT 0'],
    ['prompt_class', 'TEXT'],
    ['source',       "TEXT DEFAULT 'claude_code'"],
    ['body_hash',    'TEXT'],
    ['machine',      'TEXT'],
  ]) {
    try { run(db, `ALTER TABLE turns ADD COLUMN ${col} ${def}`); }
    catch (e) { if (!String(e.message).includes('duplicate column')) throw e; }
  }
  run(db, `CREATE INDEX IF NOT EXISTS idx_turns_kind ON turns(prompt_class)`);
  run(db, `CREATE INDEX IF NOT EXISTS idx_turns_source ON turns(source)`);
  run(db, `CREATE INDEX IF NOT EXISTS idx_turns_content ON turns(body_hash)`);
  run(db, `CREATE INDEX IF NOT EXISTS idx_turns_machine ON turns(machine)`);
  run(db, `CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id)`);
  // This ran on every open and rewrote rows every time, so a Claude Code
  // session in a project genuinely named claude-ai* was relabelled as imported
  // on the next connection — overruling what the indexer had explicitly
  // written. It is a one-time backfill for rows that predate the column, and
  // it records that it has run.
  run(db, `CREATE TABLE IF NOT EXISTS schema_state (key TEXT PRIMARY KEY, value TEXT)`);
  const done = db.prepare(`SELECT value FROM schema_state WHERE key = 'source_backfill'`).get();
  if (!done) {
    run(db, `UPDATE turns SET source = 'claude_ai'
             WHERE source IS NULL AND project LIKE 'claude-ai%'`);
    run(db, `UPDATE turns SET source = 'claude_code' WHERE source IS NULL`);
    db.prepare(`INSERT INTO schema_state (key, value) VALUES ('source_backfill', ?)`)
      .run(new Date().toISOString());
  }
  run(db, `CREATE INDEX IF NOT EXISTS idx_turns_noise ON turns(is_noise)`);

  // Essence layer: structural extracts (decisions/constraints/tensions/anti-patterns).
  run(db, `
    CREATE TABLE IF NOT EXISTS essence_extracts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      turn_id TEXT NOT NULL,
      project TEXT NOT NULL,
      category TEXT NOT NULL,
      speaker TEXT NOT NULL,
      text TEXT NOT NULL
    )
  `);
  run(db, `DROP INDEX IF EXISTS idx_essence_exchange`); // the name this index carried before
  run(db, `CREATE INDEX IF NOT EXISTS idx_essence_turn ON essence_extracts(turn_id)`);
  run(db, `CREATE INDEX IF NOT EXISTS idx_essence_category ON essence_extracts(category)`);
  run(db, `CREATE INDEX IF NOT EXISTS idx_essence_project  ON essence_extracts(project)`);

  run(db, `
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_essence USING fts5(
      text,
      category UNINDEXED,
      speaker UNINDEXED,
      project UNINDEXED,
      turn_id UNINDEXED,
      tokenize='porter unicode61'
    )
  `);

  // Entity layer: cross-project named entities (tools/tech/projects/concepts).
  // entity_mentions is the source of truth (one row per entity×turn);
  // entities is an aggregate cache recomputed from mentions via GROUP BY.
  run(db, `
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      canonical TEXT NOT NULL,
      type TEXT DEFAULT 'concept',
      aliases TEXT DEFAULT '[]',
      mention_count INTEGER DEFAULT 0,
      project_count INTEGER DEFAULT 0,
      first_seen TEXT,
      last_seen TEXT
    )
  `);
  run(db, `
    CREATE TABLE IF NOT EXISTS entity_mentions (
      entity_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      project TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      speaker TEXT NOT NULL,
      surface TEXT NOT NULL,
      snippet TEXT,
      PRIMARY KEY (entity_id, turn_id, speaker)
    )
  `);
  run(db, `CREATE INDEX IF NOT EXISTS idx_em_entity  ON entity_mentions(entity_id)`);
  run(db, `CREATE INDEX IF NOT EXISTS idx_em_project ON entity_mentions(project)`);
  run(db, `DROP INDEX IF EXISTS idx_em_exchange`); // the name this index carried before
  run(db, `CREATE INDEX IF NOT EXISTS idx_em_turn ON entity_mentions(turn_id)`);
  run(db, `CREATE INDEX IF NOT EXISTS idx_entities_span ON entities(project_count DESC)`);
  run(db, `
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_entities USING fts5(
      canonical,
      aliases,
      type UNINDEXED,
      entity_id UNINDEXED,
      tokenize='porter unicode61'
    )
  `);

  // Temporal knowledge graph: subject -predicate-> object with validity windows.
  // valid_to IS NULL = currently true. Single-valued predicates auto-supersede
  // (the old open fact's valid_to is stamped when a newer value arrives).
  run(db, `
    CREATE TABLE IF NOT EXISTS kg_triples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      valid_from TEXT,
      valid_to TEXT,
      confidence REAL DEFAULT 1.0,
      method TEXT DEFAULT 'manual',
      source_exchange TEXT,
      source_project TEXT,
      extracted_at INTEGER NOT NULL
    )
  `);
  run(db, `CREATE INDEX IF NOT EXISTS idx_kg_subject ON kg_triples(subject)`);
  run(db, `CREATE INDEX IF NOT EXISTS idx_kg_object  ON kg_triples(object)`);
  run(db, `CREATE INDEX IF NOT EXISTS idx_kg_pred    ON kg_triples(predicate)`);
  run(db, `CREATE INDEX IF NOT EXISTS idx_kg_valid   ON kg_triples(valid_from, valid_to)`);

  // Observations layer: typed learnings extracted from work (the claude-mem
  // observer design, absorbed). Retrieval rides vault's own sqlite-vec + FTS5.
  run(db, `
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      narrative TEXT NOT NULL,
      concepts TEXT DEFAULT '',
      project TEXT,
      session_id TEXT,
      source_exchange TEXT,
      created_at TEXT NOT NULL
    )
  `);
  run(db, `CREATE INDEX IF NOT EXISTS idx_obs_project ON observations(project)`);
  run(db, `CREATE INDEX IF NOT EXISTS idx_obs_type    ON observations(type)`);
  run(db, `CREATE INDEX IF NOT EXISTS idx_obs_created ON observations(created_at DESC)`);
  run(db, `
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_observations USING fts5(
      title, narrative, concepts,
      type UNINDEXED, project UNINDEXED, obs_id UNINDEXED,
      tokenize='porter unicode61'
    )
  `);
  run(db, `
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_observations USING vec0(
      obs_id INTEGER PRIMARY KEY,
      embedding FLOAT[384]
    )
  `);

  // Threads layer: topic-threads recovered from sessions (drift segmentation)
  // and linked across the corpus (mean-centered + entity-fused Louvain).
  // thread_segments is a coherent span of turns; threads are cross-session
  // clusters of segments. Both rebuilt wholesale by build-threads.js.
  run(db, `
    CREATE TABLE IF NOT EXISTS threads (
      id INTEGER PRIMARY KEY,
      label TEXT,
      n_segments INTEGER DEFAULT 0,
      n_turns INTEGER DEFAULT 0,
      n_sessions INTEGER DEFAULT 0,
      n_projects INTEGER DEFAULT 0,
      first_ts TEXT,
      last_ts TEXT,
      return_count INTEGER DEFAULT 0,
      entities TEXT DEFAULT '[]',
      projects TEXT DEFAULT '[]'
    )
  `);
  run(db, `
    CREATE TABLE IF NOT EXISTS thread_segments (
      id TEXT PRIMARY KEY,
      thread_id INTEGER,
      session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      seq INTEGER NOT NULL,
      ts_start TEXT,
      ts_end TEXT,
      n_turns INTEGER DEFAULT 0,
      turn_start TEXT,
      turn_end TEXT,
      entities TEXT DEFAULT '[]',
      summary TEXT
    )
  `);
  run(db, `CREATE INDEX IF NOT EXISTS idx_tseg_thread  ON thread_segments(thread_id)`);
  run(db, `CREATE INDEX IF NOT EXISTS idx_tseg_session ON thread_segments(session_id)`);
  run(db, `CREATE INDEX IF NOT EXISTS idx_threads_span ON threads(n_sessions DESC, n_turns DESC)`);
  run(db, `
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_threads USING fts5(
      label, entities,
      thread_id UNINDEXED,
      tokenize='porter unicode61'
    )
  `);
  run(db, `
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_threads USING vec0(
      thread_id INTEGER PRIMARY KEY,
      embedding FLOAT[384]
    )
  `);

  run(db, `
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_turns USING vec0(
      id TEXT PRIMARY KEY,
      embedding FLOAT[384]
    )
  `);

  run(db, `
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_turns USING fts5(
      id UNINDEXED,
      prompt_text,
      reply_text,
      tools_used,
      content='turns',
      content_rowid='rowid',
      tokenize='porter unicode61'
    )
  `);

  run(db, `CREATE INDEX IF NOT EXISTS idx_turns_project ON turns(project)`);
  run(db, `CREATE INDEX IF NOT EXISTS idx_turns_timestamp ON turns(timestamp DESC)`);
  run(db, `CREATE INDEX IF NOT EXISTS idx_turns_transcript ON turns(transcript_path)`);
  run(db, `CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id)`);

  run(db, `
    CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
      INSERT INTO fts_turns(rowid, id, prompt_text, reply_text, tools_used)
      VALUES (new.rowid, new.id, new.prompt_text, new.reply_text, new.tools_used);
    END
  `);
  run(db, `
    CREATE TRIGGER IF NOT EXISTS turns_ad AFTER DELETE ON turns BEGIN
      INSERT INTO fts_turns(fts_turns, rowid, id, prompt_text, reply_text, tools_used)
      VALUES ('delete', old.rowid, old.id, old.prompt_text, old.reply_text, old.tools_used);
    END
  `);
  run(db, `
    CREATE TRIGGER IF NOT EXISTS turns_au AFTER UPDATE ON turns BEGIN
      INSERT INTO fts_turns(fts_turns, rowid, id, prompt_text, reply_text, tools_used)
      VALUES ('delete', old.rowid, old.id, old.prompt_text, old.reply_text, old.tools_used);
      INSERT INTO fts_turns(rowid, id, prompt_text, reply_text, tools_used)
      VALUES (new.rowid, new.id, new.prompt_text, new.reply_text, new.tools_used);
    END
  `);

  // Prompts, from ~/.claude/history.jsonl. Not turns: there is no reply,
  // no session id and no transcript — which is the point. Claude Code keeps
  // this file outside the per-project transcripts and it outlives them, so it
  // is the only record of a question asked in a session that has since been
  // deleted. `echo_hash` ties a prompt to the turn it opened where one
  // still exists; the ones with no match are the recovered part.
  run(db, `
    CREATE TABLE IF NOT EXISTS prompts (
      id TEXT PRIMARY KEY,
      machine TEXT,
      project TEXT,
      project_path TEXT,
      ts INTEGER NOT NULL,
      timestamp TEXT NOT NULL,
      text TEXT NOT NULL,
      pasted INTEGER DEFAULT 0,
      echo_hash TEXT,
      has_session INTEGER DEFAULT 0
    )
  `);
  run(db, `CREATE INDEX IF NOT EXISTS idx_prompts_ts ON prompts(ts DESC)`);
  run(db, `CREATE INDEX IF NOT EXISTS idx_prompts_project ON prompts(project)`);
  run(db, `CREATE INDEX IF NOT EXISTS idx_prompts_machine ON prompts(machine)`);
  run(db, `CREATE INDEX IF NOT EXISTS idx_prompts_echo ON prompts(echo_hash)`);
  run(db, `CREATE INDEX IF NOT EXISTS idx_prompts_orphan ON prompts(has_session)`);
  run(db, `
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_prompts USING fts5(
      id UNINDEXED,
      text,
      project,
      content='prompts',
      content_rowid='rowid',
      tokenize='porter unicode61'
    )
  `);
  run(db, `
    CREATE TRIGGER IF NOT EXISTS prompts_ai AFTER INSERT ON prompts BEGIN
      INSERT INTO fts_prompts(rowid, id, text, project)
      VALUES (new.rowid, new.id, new.text, new.project);
    END
  `);
  run(db, `
    CREATE TRIGGER IF NOT EXISTS prompts_ad AFTER DELETE ON prompts BEGIN
      INSERT INTO fts_prompts(fts_prompts, rowid, id, text, project)
      VALUES ('delete', old.rowid, old.id, old.text, old.project);
    END
  `);

  _db = db;
  return db;
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/** Every archive path the index still has rows for. */
export function listIndexedArchives() {
  return getDb().prepare('SELECT DISTINCT transcript_path FROM turns').all()
    .map((r) => r.transcript_path).filter(Boolean);
}

export function getIndexedIds(transcriptPath) {
  const db = getDb();
  const rows = db.prepare('SELECT id FROM turns WHERE transcript_path = ?').all(transcriptPath);
  return new Set(rows.map(r => r.id));
}

export function upsertTurn(turn, embedding) {
  const db = getDb();
  // The relational row, the FTS row and the vector row are one logical write.
  // Split across three statements, a failure after the first left a turn
  // indexed but unsearchable by vector, or searchable with a stale embedding —
  // damage that only shows up much later, as a result that should have ranked
  // and did not.
  transaction(() => {
    const now = Date.now();
    const toolsUsed = turn.toolCalls
      ? turn.toolCalls.map(t => t.toolName).join(', ')
      : null;
    const isNoise = turn.isNoise ? 1 : 0;
    const promptClass = turn.promptClass || null;
    const source = turn.source || 'claude_code';
  const bodyHash = turn.bodyHash || null;

    const existing = db.prepare('SELECT id FROM turns WHERE id = ?').get(turn.id);

    if (existing) {
      db.prepare(`
        UPDATE turns SET
          project = ?, timestamp = ?, prompt_text = ?, reply_text = ?,
          transcript_path = ?, first_line = ?, last_line = ?,
          session_id = ?, cwd = ?, branch = ?, from_agent = ?,
          tools_used = ?, is_noise = ?, prompt_class = ?, source = ?, body_hash = ?, indexed_ms = ?
        WHERE id = ?
      `).run(
        turn.project, turn.timestamp, turn.promptText, turn.replyText,
        turn.transcriptPath, turn.firstLine, turn.lastLine,
        turn.sessionId || null, turn.cwd || null, turn.branch || null,
        turn.fromAgent ? 1 : 0, toolsUsed, isNoise, promptClass, source, bodyHash, now, turn.id
      );

      db.prepare('DELETE FROM vec_turns WHERE id = ?').run(turn.id);
    } else {
      db.prepare(`
        INSERT INTO turns
        (id, project, timestamp, prompt_text, reply_text, transcript_path,
         first_line, last_line, session_id, cwd, branch, from_agent,
         tools_used, is_noise, prompt_class, source, body_hash, indexed_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        turn.id, turn.project, turn.timestamp,
        turn.promptText, turn.replyText, turn.transcriptPath,
        turn.firstLine, turn.lastLine,
        turn.sessionId || null, turn.cwd || null, turn.branch || null,
        turn.fromAgent ? 1 : 0, toolsUsed, isNoise, promptClass, source, bodyHash, now
      );
    }

    const embBuf = Buffer.from(
      (embedding instanceof Float32Array ? embedding : new Float32Array(embedding)).buffer
    );
    db.prepare('INSERT INTO vec_turns (id, embedding) VALUES (?, ?)').run(turn.id, embBuf);
  })();
}

export function deleteByArchive(transcriptPath) {
  const db = getDb();
  const ids = db.prepare('SELECT id FROM turns WHERE transcript_path = ?').all(transcriptPath);
  const delVec = db.prepare('DELETE FROM vec_turns WHERE id = ?');
  const delEx = db.prepare('DELETE FROM turns WHERE id = ?');
  const delEss = db.prepare('DELETE FROM essence_extracts WHERE turn_id = ?');
  const delEssFts = db.prepare('DELETE FROM fts_essence WHERE turn_id = ?');
  const delMen = db.prepare('DELETE FROM entity_mentions WHERE turn_id = ?');
  for (const { id } of ids) {
    delVec.run(id);
    delEss.run(id);
    delEssFts.run(id);
    delMen.run(id);
    delEx.run(id);
  }
  // Entity aggregates now stale for affected nodes — caller recomputes.
}

/**
 * Replace all entity mentions for a turn (idempotent).
 * @param {string} turnId
 * @param {Array<{entityId,canonical,type,project,timestamp,speaker,surface,snippet}>} mentions
 */
export function upsertEntityMentions(turnId, mentions) {
  const db = getDb();
  db.prepare('DELETE FROM entity_mentions WHERE turn_id = ?').run(turnId);
  if (!mentions || mentions.length === 0) return;
  const ins = db.prepare(`
    INSERT OR REPLACE INTO entity_mentions
    (entity_id, turn_id, project, timestamp, speaker, surface, snippet)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = transaction(() => {
    for (const m of mentions) {
      ins.run(m.entityId, turnId, m.project, m.timestamp, m.speaker, m.surface, m.snippet || null);
    }
  });
  tx();
}

/**
 * Rebuild the entities aggregate cache + fts_entities from entity_mentions.
 * Self-healing: drops entities with zero mentions, recomputes counts,
 * picks the most frequent surface form as canonical. Cheap full pass.
 *
 * @param {(key:string)=>string} [typeOf] — optional key→type resolver
 */
export function recomputeEntityAggregates(typeOf) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT entity_id,
           COUNT(*)                       AS mention_count,
           COUNT(DISTINCT project)        AS project_count,
           MIN(timestamp)                 AS first_seen,
           MAX(timestamp)                 AS last_seen
    FROM entity_mentions
    GROUP BY entity_id
  `).all();

  // most-common surface per entity → canonical
  const surfRows = db.prepare(`
    SELECT entity_id, surface, COUNT(*) c
    FROM entity_mentions GROUP BY entity_id, surface
  `).all();
  const canon = new Map();
  for (const r of surfRows) {
    const cur = canon.get(r.entity_id);
    if (!cur || r.c > cur.c) canon.set(r.entity_id, { surface: r.surface, c: r.c });
  }
  // aliases = all distinct surfaces
  const aliasMap = new Map();
  for (const r of surfRows) {
    if (!aliasMap.has(r.entity_id)) aliasMap.set(r.entity_id, new Set());
    aliasMap.get(r.entity_id).add(r.surface);
  }

  const tx = transaction(() => {
    db.exec('DELETE FROM entities');
    db.exec('DELETE FROM fts_entities');
    const insE = db.prepare(`
      INSERT INTO entities (id, canonical, type, aliases, mention_count, project_count, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insF = db.prepare(`
      INSERT INTO fts_entities (canonical, aliases, type, entity_id) VALUES (?, ?, ?, ?)
    `);
    for (const r of rows) {
      const canonical = canon.get(r.entity_id)?.surface || r.entity_id;
      const aliases = [...(aliasMap.get(r.entity_id) || [])];
      const type = typeOf ? typeOf(r.entity_id) : 'concept';
      insE.run(r.entity_id, canonical, type, JSON.stringify(aliases),
        r.mention_count, r.project_count, r.first_seen, r.last_seen);
      insF.run(canonical, aliases.join(' '), type, r.entity_id);
    }
  });
  tx();
  return rows.length;
}

/**
 * Replace all essence extracts for a turn (idempotent).
 */
export function upsertEssence(turnId, project, extracts) {
  const db = getDb();
  db.prepare('DELETE FROM essence_extracts WHERE turn_id = ?').run(turnId);
  db.prepare('DELETE FROM fts_essence WHERE turn_id = ?').run(turnId);
  if (!extracts || extracts.length === 0) return;
  const ins = db.prepare(`
    INSERT INTO essence_extracts (turn_id, project, category, speaker, text)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insFts = db.prepare(`
    INSERT INTO fts_essence (text, category, speaker, project, turn_id)
    VALUES (?, ?, ?, ?, ?)
  `);
  const tx = transaction(() => {
    for (const e of extracts) {
      ins.run(turnId, project, e.category, e.speaker, e.text);
      insFts.run(e.text, e.category, e.speaker, project, turnId);
    }
  });
  tx();
}

// ── Temporal knowledge graph ────────────────────────────────────────────────

// Predicates that hold at most one current value — a newer value supersedes the old.
const SINGLE_VALUED = new Set([
  'has_version', 'runs_on_port', 'located_at', 'listens_on', 'model_is', 'status_is',
]);

/**
 * Add a triple. Dedups identical still-open facts. For single-valued predicates,
 * a newer-dated value closes the prior open fact (valid_to = new valid_from),
 * yielding a correct valid-time window. Returns the row id.
 */
export function addTriple(t) {
  const db = getDb();
  const subject = String(t.subject).toLowerCase().trim();
  const predicate = String(t.predicate).trim();
  const object = String(t.object).trim();
  const valid_from = t.valid_from || null;
  const valid_to = t.valid_to || null;
  if (!subject || !predicate || !object) return null;

  const open = db.prepare(
    'SELECT id FROM kg_triples WHERE subject=? AND predicate=? AND object=? AND valid_to IS NULL'
  ).get(subject, predicate, object);
  if (open && valid_to === null) return open.id;

  if (SINGLE_VALUED.has(predicate) && valid_from) {
    db.prepare(`
      UPDATE kg_triples SET valid_to=?
      WHERE subject=? AND predicate=? AND object!=? AND valid_to IS NULL
        AND (valid_from IS NULL OR valid_from < ?)
    `).run(valid_from, subject, predicate, object, valid_from);
  }

  const r = db.prepare(`
    INSERT INTO kg_triples
    (subject, predicate, object, valid_from, valid_to, confidence, method, source_exchange, source_project, extracted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(subject, predicate, object, valid_from, valid_to,
    t.confidence ?? 1.0, t.method || 'manual', t.source_exchange || null, t.source_project || null, Date.now());
  return r.lastInsertRowid;
}

/** Close an open fact (mark no longer true) by id, or by subject/predicate/object. */
export function invalidateTriple({ id, subject, predicate, object, ended }) {
  const db = getDb();
  const when = ended || new Date().toISOString().slice(0, 10);
  if (id) {
    return db.prepare('UPDATE kg_triples SET valid_to=? WHERE id=? AND valid_to IS NULL').run(when, id).changes;
  }
  return db.prepare(`
    UPDATE kg_triples SET valid_to=?
    WHERE subject=? AND predicate=? AND object=? AND valid_to IS NULL
  `).run(when, String(subject).toLowerCase().trim(), predicate, object).changes;
}

/** Facts about a subject. Optional predicate filter and point-in-time (as_of). */
export function queryTriples(subject, { predicate = null, as_of = null, includeExpired = true } = {}) {
  const db = getDb();
  const where = ['subject = ?'];
  const params = [String(subject).toLowerCase().trim()];
  if (predicate) { where.push('predicate = ?'); params.push(predicate); }
  if (as_of) {
    where.push('(valid_from IS NULL OR valid_from <= ?)'); params.push(as_of);
    where.push('(valid_to   IS NULL OR valid_to   >  ?)'); params.push(as_of);
  } else if (!includeExpired) {
    where.push('valid_to IS NULL');
  }
  return db.prepare(`
    SELECT * FROM kg_triples WHERE ${where.join(' AND ')}
    ORDER BY predicate, valid_from
  `).all(...params);
}

/** Chronological fact timeline for a subject (oldest first). */
export function kgTimeline(subject, limit = 100) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM kg_triples WHERE subject = ?
    ORDER BY COALESCE(valid_from, '') ASC, id ASC LIMIT ?
  `).all(String(subject).toLowerCase().trim(), limit);
}

/** Drop auto-extracted triples (method LIKE 'auto:%'); preserves manual facts. */
export function clearAutoTriples() {
  return getDb().prepare("DELETE FROM kg_triples WHERE method LIKE 'auto:%'").run().changes;
}

export function kgStats() {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) c FROM kg_triples').get().c;
  const open = db.prepare('SELECT COUNT(*) c FROM kg_triples WHERE valid_to IS NULL').get().c;
  const subjects = db.prepare('SELECT COUNT(DISTINCT subject) c FROM kg_triples').get().c;
  const preds = db.prepare('SELECT predicate, COUNT(*) c FROM kg_triples GROUP BY predicate ORDER BY c DESC').all();
  return { triples: total, current: open, subjects, predicates: preds };
}

// ── Observations (typed learnings) ───────────────────────────────────────────

export const OBSERVATION_TYPES = ['discovery', 'change', 'decision', 'gotcha', 'trade-off', 'bugfix', 'feature'];

/**
 * Add a typed observation with its embedding. Idempotent on (title, project):
 * re-adding the same title in the same project updates rather than duplicates.
 * @param {object} obs {type,title,narrative,concepts,project,session_id,source_exchange,created_at}
 * @param {number[]} embedding 384-dim
 */
export function addObservation(obs, embedding) {
  const db = getDb();
  const created_at = obs.created_at || new Date().toISOString();
  const existing = db.prepare('SELECT id FROM observations WHERE title = ? AND IFNULL(project,\'\') = IFNULL(?,\'\')').get(obs.title, obs.project || null);
  let id;
  if (existing) {
    id = existing.id;
    db.prepare(`UPDATE observations SET type=?, narrative=?, concepts=?, session_id=?, source_exchange=?, created_at=? WHERE id=?`)
      .run(obs.type, obs.narrative, obs.concepts || '', obs.session_id || null, obs.source_exchange || null, created_at, id);
    db.prepare('DELETE FROM fts_observations WHERE obs_id = ?').run(id);
    db.prepare('DELETE FROM vec_observations WHERE obs_id = ?').run(id);
  } else {
    const r = db.prepare(`
      INSERT INTO observations (type, title, narrative, concepts, project, session_id, source_exchange, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(obs.type, obs.title, obs.narrative, obs.concepts || '', obs.project || null, obs.session_id || null, obs.source_exchange || null, created_at);
    id = Number(r.lastInsertRowid); // BigInt → Number for sqlite-vec integer PK
  }
  db.prepare('INSERT INTO fts_observations (title, narrative, concepts, type, project, obs_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(obs.title, obs.narrative, obs.concepts || '', obs.type, obs.project || null, id);
  if (embedding) {
    const buf = Buffer.from((embedding instanceof Float32Array ? embedding : new Float32Array(embedding)).buffer);
    // sqlite-vec integer PK requires true INTEGER affinity — BigInt forces it.
    db.prepare('INSERT INTO vec_observations (obs_id, embedding) VALUES (?, ?)').run(BigInt(id), buf);
  }
  return id;
}

/** Hybrid search over observations: sqlite-vec semantic + FTS5, RRF-fused. */
export function searchObservations(queryEmbedding, queryText, { type = null, project = null, limit = 10 } = {}) {
  const db = getDb();
  const K = Math.max(limit * 3, 30);
  const rank = new Map(); // obs_id -> {row, score}

  if (queryEmbedding) {
    const buf = Buffer.from(new Float32Array(queryEmbedding).buffer);
    const rows = db.prepare(`
      SELECT o.*, v.distance FROM vec_observations AS v
      JOIN observations AS o ON o.id = v.obs_id
      WHERE v.embedding MATCH ? AND k = ?
      ORDER BY v.distance ASC
    `).all(buf, K);
    rows.forEach((r, i) => rank.set(r.id, { row: r, score: (rank.get(r.id)?.score || 0) + 1 / (60 + i) }));
  }
  if (queryText) {
    try {
      const rows = db.prepare(`
        SELECT o.* FROM fts_observations AS f
        JOIN observations AS o ON o.id = f.obs_id
        WHERE fts_observations MATCH ? LIMIT ?
      `).all(queryText, K);
      rows.forEach((r, i) => rank.set(r.id, { row: r, score: (rank.get(r.id)?.score || 0) + 1 / (60 + i) }));
    } catch { /* FTS syntax error on odd queries — skip */ }
  }
  let results = [...rank.values()].map((x) => x.row);
  if (type) results = results.filter((r) => r.type === type);
  if (project) results = results.filter((r) => (r.project || '').includes(project));
  results.sort((a, b) => (rank.get(b.id).score) - (rank.get(a.id).score));
  return results.slice(0, limit);
}

/** Progressive-disclosure index: compact rows (id/type/title/date) for injection. */
export function observationIndex({ project = null, type = null, limit = 40 } = {}) {
  const db = getDb();
  const where = []; const params = [];
  if (project) { where.push('project LIKE ?'); params.push(`%${project}%`); }
  if (type) { where.push('type = ?'); params.push(type); }
  params.push(limit);
  return db.prepare(`
    SELECT id, type, title, project, substr(created_at,1,10) AS day
    FROM observations ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY created_at DESC LIMIT ?
  `).all(...params);
}

export function getObservation(id) {
  return getDb().prepare('SELECT * FROM observations WHERE id = ?').get(id);
}

function observationStats() {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) c FROM observations').get().c;
  const byType = db.prepare('SELECT type, COUNT(*) c FROM observations GROUP BY type ORDER BY c DESC').all();
  return { observations: total, by_type: byType };
}

/**
 * Wholesale rebuild of the threads layer from a derivation pass.
 * @param {{threads:Array, segments:Array}} data from buildThreads+assembleThreads
 */
export function rebuildThreads({ threads, segments }) {
  const db = getDb();
  const tx = transaction(() => {
    db.exec('DELETE FROM threads; DELETE FROM thread_segments; DELETE FROM fts_threads; DELETE FROM vec_threads;');
    const insT = db.prepare(`
      INSERT INTO threads (id, label, n_segments, n_turns, n_sessions, n_projects, first_ts, last_ts, return_count, entities, projects)
      VALUES (@id, @label, @n_segments, @n_turns, @n_sessions, @n_projects, @first_ts, @last_ts, @return_count, @entities, @projects)
    `);
    const insF = db.prepare('INSERT INTO fts_threads (label, entities, thread_id) VALUES (?, ?, ?)');
    const insV = db.prepare('INSERT INTO vec_threads (thread_id, embedding) VALUES (?, ?)');
    for (const t of threads) {
      insT.run({
        id: t.id, label: t.label,
        n_segments: t.n_segments, n_turns: t.n_turns,
        n_sessions: t.n_sessions, n_projects: t.n_projects,
        first_ts: t.first_ts, last_ts: t.last_ts, return_count: t.return_count,
        entities: JSON.stringify(t.entities || []),
        projects: JSON.stringify(t.projects || []),
      });
      insF.run(t.label, (t.entities || []).map((e) => e[0]).join(' '), t.id);
      if (t.centroid) {
        const buf = Buffer.from(new Float32Array(t.centroid).buffer);
        insV.run(BigInt(t.id), buf);
      }
    }
    const insS = db.prepare(`
      INSERT INTO thread_segments (id, thread_id, session_id, project, seq, ts_start, ts_end, n_turns, turn_start, turn_end, entities, summary)
      VALUES (@id, @thread_id, @session_id, @project, @seq, @ts_start, @ts_end, @n_turns, @turn_start, @turn_end, @entities, @summary)
    `);
    for (const s of segments) {
      insS.run({
        id: `${s.sessionId}:${s.seq}`,
        thread_id: s.threadId || null,
        session_id: s.sessionId, project: s.project, seq: s.seq,
        ts_start: s.tsStart || null, ts_end: s.tsEnd || null,
        n_turns: s.n, turn_start: s.turnStart || null, turn_end: s.turnEnd || null,
        entities: JSON.stringify([...(s.dist || [])].slice(0, 20)),
        summary: s.summary || null,
      });
    }
  });
  tx();
  return { threads: threads.length, segments: segments.length };
}

function clearThreads() {
  getDb().exec('DELETE FROM threads; DELETE FROM thread_segments; DELETE FROM fts_threads; DELETE FROM vec_threads;');
}

/** Top threads by reach. Cross-session first — span is the connective signal. */
export function listThreads({ min_sessions = 1, project = null, limit = 30 } = {}) {
  const db = getDb();
  const where = ['n_sessions >= ?'];
  const params = [min_sessions];
  if (project) { where.push('projects LIKE ?'); params.push(`%${project}%`); }
  params.push(limit);
  return db.prepare(`
    SELECT * FROM threads WHERE ${where.join(' AND ')}
    ORDER BY n_sessions DESC, n_turns DESC LIMIT ?
  `).all(...params);
}

/** Hybrid search over threads: sqlite-vec semantic + FTS5, RRF-fused. */
export function searchThreads(queryEmbedding, queryText, { project = null, limit = 10 } = {}) {
  const db = getDb();
  const K = Math.max(limit * 3, 30);
  const rank = new Map();
  if (queryEmbedding) {
    const buf = Buffer.from(new Float32Array(queryEmbedding).buffer);
    const rows = db.prepare(`
      SELECT t.*, v.distance FROM vec_threads AS v
      JOIN threads AS t ON t.id = v.thread_id
      WHERE v.embedding MATCH ? AND k = ?
      ORDER BY v.distance ASC
    `).all(buf, K);
    rows.forEach((r, i) => rank.set(r.id, { row: r, score: (rank.get(r.id)?.score || 0) + 1 / (60 + i) }));
  }
  if (queryText) {
    try {
      const rows = db.prepare(`
        SELECT t.* FROM fts_threads AS f
        JOIN threads AS t ON t.id = f.thread_id
        WHERE fts_threads MATCH ? LIMIT ?
      `).all(queryText, K);
      rows.forEach((r, i) => rank.set(r.id, { row: r, score: (rank.get(r.id)?.score || 0) + 1 / (60 + i) }));
    } catch { /* FTS syntax error — skip */ }
  }
  let results = [...rank.values()].map((x) => x.row);
  if (project) results = results.filter((r) => (r.projects || '').includes(project));
  results.sort((a, b) => rank.get(b.id).score - rank.get(a.id).score);
  return results.slice(0, limit);
}

/** One thread with its member segments in timeline order. */
export function getThread(id) {
  const db = getDb();
  const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(id);
  if (!thread) return null;
  const segments = db.prepare(`
    SELECT * FROM thread_segments WHERE thread_id = ?
    ORDER BY ts_start ASC
  `).all(id);
  return { thread, segments };
}

function threadStats() {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) c FROM threads').get().c;
  const cross = db.prepare('SELECT COUNT(*) c FROM threads WHERE n_sessions >= 2').get().c;
  const segs = db.prepare('SELECT COUNT(*) c FROM thread_segments').get().c;
  return { threads: total, cross_session_threads: cross, segments: segs };
}

// better-sqlite3 provided transaction(); node:sqlite does not. This is that,
// with one addition it always needed: these functions call each other —
// build-kg wraps a loop over addTriple, which is itself atomic — and BEGIN
// inside BEGIN is an error. Nested calls use a savepoint instead, so an inner
// failure rolls back only its own work.
let savepointDepth = 0;

export function transaction(fn) {
  return (...args) => {
    const db = getDb();
    if (db.isTransaction) {
      const name = `arca_sp_${savepointDepth++}`;
      db.exec(`SAVEPOINT ${name}`);
      try {
        const out = fn(...args);
        db.exec(`RELEASE ${name}`);
        return out;
      } catch (e) {
        try { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); } catch { /* gone */ }
        throw e;
      } finally {
        savepointDepth--;
      }
    }
    db.exec('BEGIN');
    try {
      const out = fn(...args);
      db.exec('COMMIT');
      return out;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    }
  };
}

/**
 * Stamp turns with the machine that produced their session.
 *
 * Driven off session id rather than set on insert, so a pull that brings
 * another machine's sessions and manifest in gets them labelled without
 * re-indexing anything. Re-running it is free and self-correcting.
 *
 * @param {Map<string, string>} owners session id -> machine id
 * @returns {number} rows labelled
 */
export function syncMachines(owners) {
  const db = getDb();
  const stmt = db.prepare('UPDATE turns SET machine = ? WHERE session_id = ? AND (machine IS NULL OR machine != ?)');
  let n = 0;
  transaction(() => {
    for (const [session, machine] of owners) {
      n += stmt.run(machine, session, machine).changes;
    }
  })();
  return n;
}

/**
 * Store prompts read out of the archived history files.
 * @param {Array<object>} records from lib/history.js readVault()
 * @param {(r: object) => string} idOf
 * @param {(project: string, text: string) => string} hashOf
 * @returns {number} newly stored
 */
export function upsertPrompts(records, idOf, hashOf) {
  const db = getDb();
  const has = db.prepare('SELECT 1 FROM prompts WHERE id = ?');
  const ins = db.prepare(`
    INSERT INTO prompts (id, machine, project, project_path, ts, timestamp, text, pasted, echo_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let n = 0;
  transaction(() => {
    for (const r of records) {
      const id = idOf(r);
      if (has.get(id)) continue;
      ins.run(
        id, r.machine || null, r.project || null, r.projectPath || null,
        r.ts, new Date(r.ts).toISOString(), r.text, r.pasted || 0,
        hashOf(r.project, r.text),
      );
      n++;
    }
  })();
  return n;
}

// How far from a prompt a turn may sit and still be from the same
// sitting. Generous on purpose: the question is whether that moment survived
// at all, not which turn the prompt became.
const SAME_SITTING_MS = 30 * 60 * 1000;

/**
 * Mark which prompts still have a session behind them.
 *
 * Exact text is not enough on its own. A slash command is stored in the
 * transcript expanded, not as the few characters that were typed, so `/effort`
 * would look lost while its whole session sits in the vault. So a prompt
 * counts as surviving if the index holds either the turn it opened or any
 * turn from the same project within half an hour of it.
 *
 * Recomputed in full rather than maintained incrementally: turns come and
 * go with re-indexing, and a stale "this one is lost" is the wrong thing to be
 * confident about.
 *
 * @param {(project: string, text: string) => string} hashOf
 * @returns {{ matched: number, orphans: number, byText: number }}
 */
export function markPromptEchoes(hashOf) {
  const db = getDb();
  const live = new Set();
  /** @type {Map<string, number[]>} project -> sorted turn times */
  const times = new Map();

  // Read in pages. `iterate()` would be the natural shape, but it landed after
  // the Node version this package claims to support, and a whole corpus of
  // user messages in memory at once is a lot of text for a hash set.
  const page = db.prepare('SELECT project, prompt_text, timestamp FROM turns LIMIT ? OFFSET ?');
  for (let offset = 0; ; offset += 2000) {
    const rows = page.all(2000, offset);
    if (!rows.length) break;
    for (const row of rows) {
      live.add(hashOf(row.project, row.prompt_text));
      const t = Date.parse(row.timestamp);
      if (!Number.isFinite(t)) continue;
      if (!times.has(row.project)) times.set(row.project, []);
      times.get(row.project).push(t);
    }
  }
  for (const list of times.values()) list.sort((a, b) => a - b);

  const near = (project, ts) => {
    const list = times.get(project);
    if (!list) return false;
    let lo = 0;
    let hi = list.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] < ts) lo = mid + 1; else hi = mid - 1;
    }
    // lo is the first entry at or after ts; its neighbour is the last before.
    return (lo < list.length && list[lo] - ts <= SAME_SITTING_MS)
      || (lo > 0 && ts - list[lo - 1] <= SAME_SITTING_MS);
  };

  const rows = db.prepare('SELECT id, echo_hash, project, ts FROM prompts').all();
  const set = db.prepare('UPDATE prompts SET has_session = ? WHERE id = ?');
  let matched = 0;
  let byText = 0;
  transaction(() => {
    for (const r of rows) {
      const exact = live.has(r.echo_hash);
      if (exact) byText++;
      const hit = exact || near(r.project, r.ts) ? 1 : 0;
      matched += hit;
      set.run(hit, r.id);
    }
  })();
  return { matched, orphans: rows.length - matched, byText };
}

/**
 * Full-text search over prompts.
 * @param {string} query
 * @param {{ project?: string|null, orphansOnly?: boolean, limit?: number }} opts
 */
export function searchPrompts(query, { project = null, orphansOnly = false, limit = 20 } = {}) {
  const db = getDb();
  const where = ['fts_prompts MATCH ?'];
  const args = [query];
  if (project) { where.push('p.project LIKE ?'); args.push(`%${project}%`); }
  if (orphansOnly) where.push('p.has_session = 0');
  args.push(limit);
  return db.prepare(`
    SELECT p.id, p.machine, p.project, p.project_path, p.timestamp, p.text,
           p.pasted, p.has_session, bm25(fts_prompts) AS score
    FROM fts_prompts
    JOIN prompts p ON p.rowid = fts_prompts.rowid
    WHERE ${where.join(' AND ')}
    ORDER BY score
    LIMIT ?
  `).all(...args);
}

export function promptStats() {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) c FROM prompts').get().c;
  const orphans = db.prepare('SELECT COUNT(*) c FROM prompts WHERE has_session = 0').get().c;
  const span = db.prepare('SELECT MIN(timestamp) a, MAX(timestamp) b FROM prompts').get();
  const byMachine = db.prepare(`
    SELECT machine, COUNT(*) c, SUM(has_session = 0) orphans
    FROM prompts GROUP BY machine ORDER BY c DESC
  `).all();
  return { total, orphans, first: span?.a || null, last: span?.b || null, machines: byMachine };
}

export function getStats() {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as count FROM turns').get();
  const projects = db.prepare('SELECT COUNT(DISTINCT project) as count FROM turns').get();
  const files = db.prepare('SELECT COUNT(DISTINCT transcript_path) as count FROM turns').get();
  const noise = db.prepare('SELECT COUNT(*) as count FROM turns WHERE is_noise = 1').get();
  const essence = db.prepare('SELECT COUNT(*) as count FROM essence_extracts').get();
  const entities = db.prepare('SELECT COUNT(*) as count FROM entities').get();
  const crossProj = db.prepare('SELECT COUNT(*) as count FROM entities WHERE project_count >= 2').get();
  const triples = db.prepare('SELECT COUNT(*) as count FROM kg_triples').get();
  const triplesOpen = db.prepare('SELECT COUNT(*) as count FROM kg_triples WHERE valid_to IS NULL').get();
  const obs = db.prepare('SELECT COUNT(*) as count FROM observations').get();
  const threadsN = db.prepare('SELECT COUNT(*) as count FROM threads').get();
  const threadsCross = db.prepare('SELECT COUNT(*) as count FROM threads WHERE n_sessions >= 2').get();
  const kinds = db.prepare(`
    SELECT prompt_class, COUNT(*) as count
    FROM turns
    WHERE prompt_class IS NOT NULL AND is_noise = 0
    GROUP BY prompt_class
    ORDER BY count DESC
  `).all();
  const machines = db.prepare(`
    SELECT machine, COUNT(*) as count, COUNT(DISTINCT project) as projects
    FROM turns GROUP BY machine ORDER BY count DESC
  `).all();
  const sources = db.prepare(`
    SELECT source, COUNT(*) as count, COUNT(DISTINCT session_id) as sessions
    FROM turns GROUP BY source ORDER BY count DESC
  `).all();
  // A project directory is named after a filesystem path, so the same name on
  // two machines is ordinary and means nothing by itself. Saying which ones
  // those are is the whole point: it turns an invisible ambiguity into a list.
  const shared = db.prepare(`
    SELECT project, COUNT(DISTINCT machine) as machines
    FROM turns WHERE machine IS NOT NULL
    GROUP BY project HAVING machines > 1 ORDER BY machines DESC, project
  `).all();
  return {
    turns: total.count,
    projects: projects.count,
    files: files.count,
    system_noise: noise.count,
    essence_extracts: essence.count,
    entities: entities.count,
    cross_project_entities: crossProj.count,
    kg_triples: triples.count,
    kg_current: triplesOpen.count,
    observations: obs.count,
    threads: threadsN.count,
    cross_session_threads: threadsCross.count,
    prompt_classs: kinds,
    machines,
    sources,
    shared_projects: shared,
  };
}
