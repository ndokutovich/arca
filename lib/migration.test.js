// The upgrade path had no test, and the layout change broke it in silence:
// `CREATE TABLE IF NOT EXISTS` cannot alter a table that already exists, so a
// database from before the rename kept `exchange_id` while the code now wrote
// `turn_id`, and every insert into the derived layers failed — after the turn
// itself was already in. These build the older database by hand and open it
// with the current code, in the two shapes that matter: no stamp at all, and a
// stamp claiming a migration that never really happened.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const LEGACY = `
  CREATE TABLE exchanges (
    id TEXT PRIMARY KEY, project TEXT NOT NULL, timestamp TEXT NOT NULL,
    user_message TEXT NOT NULL, assistant_message TEXT NOT NULL,
    archive_path TEXT NOT NULL, line_start INTEGER NOT NULL,
    line_end INTEGER NOT NULL, session_id TEXT, cwd TEXT, git_branch TEXT,
    is_sidechain BOOLEAN DEFAULT 0, tool_names TEXT, indexed_at INTEGER NOT NULL,
    is_system_noise BOOLEAN DEFAULT 0, prompt_kind TEXT,
    source TEXT DEFAULT 'claude_code', content_hash TEXT, machine TEXT
  );
  CREATE TABLE essence_extracts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, exchange_id TEXT NOT NULL,
    project TEXT NOT NULL, category TEXT NOT NULL, speaker TEXT NOT NULL,
    text TEXT NOT NULL
  );
  CREATE TABLE entity_mentions (
    entity_id TEXT NOT NULL, exchange_id TEXT NOT NULL, project TEXT NOT NULL,
    timestamp TEXT NOT NULL, speaker TEXT NOT NULL, surface TEXT NOT NULL,
    snippet TEXT, PRIMARY KEY (entity_id, exchange_id, speaker)
  );
  CREATE TABLE fts_essence (
    text, category UNINDEXED, speaker UNINDEXED, project UNINDEXED,
    exchange_id UNINDEXED
  );
  INSERT INTO exchanges VALUES
    ('old-1','demo','2026-09-01T00:00:00.000Z','q','a','/v/demo/s.jsonl',1,2,
     's1','/demo','main',0,NULL,1,0,NULL,'claude_code',NULL,NULL);
`;

function vaultFrom(name, ddl) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `arca-mig-${name}-`));
  const dir = path.join(home, '.claude-vault', 'index');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'vault.db'));
  db.exec(ddl);
  db.close();
  return home;
}
const legacyVault = (name, extra = '') => vaultFrom(name, LEGACY + extra);

// A distinct specifier per scenario, so each gets its own module instance and
// its own DB_PATH — which db.js reads from the home directory as it loads.
function openVault(home, tag) {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return import(`./db.js?${tag}`);
}

const columnsOf = (db, table) =>
  new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
const tablesOf = (db) =>
  new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((r) => r.name));

const NEW_TURN = {
  id: 'new-1', project: 'demo', timestamp: '2026-10-01T00:00:00.000Z',
  promptText: 'a question', replyText: 'an answer',
  transcriptPath: '/v/demo/s.jsonl', firstLine: 1, lastLine: 2,
  sessionId: 's1', cwd: '/demo', branch: 'main', fromAgent: false,
  toolCalls: [], isNoise: false,
};

// ── The previous layout, no stamp ─────────────────────────────────────────
const homePlain = legacyVault('plain');
const plain = await openVault(homePlain, 'plain');

test('a database from the previous layout is brought forward, not left inconsistent', () => {
  const db = plain.getDb();
  for (const gone of ['exchanges', 'vec_exchanges', 'fts_exchanges']) {
    assert.ok(!tablesOf(db).has(gone), `${gone} survived the layout change`);
  }
  assert.ok(columnsOf(db, 'turns').has('prompt_text'), 'turns was never brought forward');
  assert.ok(columnsOf(db, 'essence_extracts').has('turn_id'), 'essence_extracts kept exchange_id');
  assert.ok(columnsOf(db, 'entity_mentions').has('turn_id'), 'entity_mentions kept exchange_id');
  assert.ok(!columnsOf(db, 'essence_extracts').has('exchange_id'));
  assert.ok(!columnsOf(db, 'entity_mentions').has('exchange_id'));
});

test('a turn and its essence can be written afterwards', () => {
  plain.upsertTurn(NEW_TURN, new Float32Array(384));
  plain.upsertEssence('new-1', 'demo', [{ category: 'DECISION', speaker: 'user', text: 'x' }]);
  const n = plain.getDb()
    .prepare(`SELECT COUNT(*) c FROM essence_extracts WHERE turn_id = ?`).get('new-1').c;
  assert.equal(n, 1, 'essence could not be written under the new column');
});

test('the layout is stamped', () => {
  const row = plain.getDb().prepare(`SELECT value FROM schema_state WHERE key = 'layout'`).get();
  assert.equal(row?.value, 'turns-v1');
});

// ── Same vault, opened again: the migration must not run a second time ────
const plainAgain = await openVault(homePlain, 'plain-again');

test('an already-migrated index is left alone, not emptied on every open', () => {
  const db = plainAgain.getDb();
  assert.ok(tablesOf(db).has('turns'));
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM turns WHERE id = 'new-1'`).get().c, 1,
    'the turn written through the first connection was dropped by the second');
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM essence_extracts WHERE turn_id = 'new-1'`).get().c, 1,
    'the essence written through the first connection was dropped by the second');
});

// ── Stamped as current, but the old shape underneath ──────────────────────
const homeStamped = legacyVault('stamped', `
  CREATE TABLE schema_state (key TEXT PRIMARY KEY, value TEXT);
  INSERT INTO schema_state VALUES ('layout', 'turns-v1');
`);
const stamped = await openVault(homeStamped, 'stamped');

test('a stamp is not trusted over the shape it claims', () => {
  const db = stamped.getDb();
  assert.ok(!tablesOf(db).has('exchanges'), 'a stamped database kept the old turn table');
  assert.ok(columnsOf(db, 'essence_extracts').has('turn_id'), 'a stamped database kept exchange_id');
  assert.ok(columnsOf(db, 'entity_mentions').has('turn_id'), 'a stamped database kept exchange_id');
});

// ── Half migrated: the turn shape is current, the FTS essence table is not ──
// The state a partly-applied migration leaves behind, and the one a check that
// looked at three tables out of seven would wave straight through.
const MIXED = `
  CREATE TABLE turns (
    id TEXT PRIMARY KEY, session_id TEXT, project TEXT NOT NULL,
    timestamp TEXT NOT NULL, prompt_text TEXT NOT NULL, reply_text TEXT NOT NULL,
    transcript_path TEXT NOT NULL, first_line INTEGER NOT NULL,
    last_line INTEGER NOT NULL, cwd TEXT, branch TEXT,
    from_agent BOOLEAN DEFAULT 0, tools_used TEXT, is_noise BOOLEAN DEFAULT 0,
    prompt_class TEXT, source TEXT DEFAULT 'claude_code', body_hash TEXT,
    machine TEXT, indexed_ms INTEGER NOT NULL
  );
  CREATE TABLE essence_extracts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, turn_id TEXT NOT NULL,
    project TEXT NOT NULL, category TEXT NOT NULL, speaker TEXT NOT NULL,
    text TEXT NOT NULL
  );
  CREATE TABLE entity_mentions (
    entity_id TEXT NOT NULL, turn_id TEXT NOT NULL, project TEXT NOT NULL,
    timestamp TEXT NOT NULL, speaker TEXT NOT NULL, surface TEXT NOT NULL,
    snippet TEXT, PRIMARY KEY (entity_id, turn_id, speaker)
  );
  CREATE TABLE fts_essence (
    text, category UNINDEXED, speaker UNINDEXED, project UNINDEXED,
    exchange_id UNINDEXED
  );
  CREATE TABLE schema_state (key TEXT PRIMARY KEY, value TEXT);
  INSERT INTO schema_state VALUES ('layout', 'turns-v1');
`;
const homeMixed = vaultFrom('mixed', MIXED);
const mixed = await openVault(homeMixed, 'mixed');

test('a stamp over a half-migrated shape is repaired, not believed', () => {
  const db = mixed.getDb();
  assert.ok(columnsOf(db, 'fts_essence').has('turn_id'),
    'fts_essence kept exchange_id — the shape check did not look at it');
  mixed.upsertEssence('mixed-1', 'demo', [{ category: 'DECISION', speaker: 'user', text: 'y' }]);
  assert.equal(
    db.prepare(`SELECT COUNT(*) c FROM essence_extracts WHERE turn_id = ?`).get('mixed-1').c, 1
  );
});

// ── One stray old column, in a table a list-driven check did not reach ─────
// Everything else is current; only `thread_segments` still carries the renamed
// thread counters. Checking the new names per table would have had to remember
// `n_turns` and `turn_end` here too, and an earlier attempt remembered only
// `turn_start`.
const STRAY = `
  CREATE TABLE turns (
    id TEXT PRIMARY KEY, session_id TEXT, project TEXT NOT NULL,
    timestamp TEXT NOT NULL, prompt_text TEXT NOT NULL, reply_text TEXT NOT NULL,
    transcript_path TEXT NOT NULL, first_line INTEGER NOT NULL,
    last_line INTEGER NOT NULL, cwd TEXT, branch TEXT,
    from_agent BOOLEAN DEFAULT 0, tools_used TEXT, is_noise BOOLEAN DEFAULT 0,
    prompt_class TEXT, source TEXT DEFAULT 'claude_code', body_hash TEXT,
    machine TEXT, indexed_ms INTEGER NOT NULL
  );
  CREATE TABLE thread_segments (
    id TEXT PRIMARY KEY, thread_id INTEGER, session_id TEXT NOT NULL,
    project TEXT NOT NULL, seq INTEGER NOT NULL, ts_start TEXT, ts_end TEXT,
    n_exchanges INTEGER DEFAULT 0, turn_start TEXT, exch_end TEXT,
    entities TEXT DEFAULT '[]', summary TEXT
  );
  CREATE TABLE schema_state (key TEXT PRIMARY KEY, value TEXT);
  INSERT INTO schema_state VALUES ('layout', 'turns-v1');
`;
const homeStray = vaultFrom('stray', STRAY);
const stray = await openVault(homeStray, 'stray');

test('a single old column anywhere re-migrates, not only where a list looked', () => {
  const cols = columnsOf(stray.getDb(), 'thread_segments');
  assert.ok(cols.has('n_turns'), 'thread_segments kept n_exchanges');
  assert.ok(cols.has('turn_end'), 'thread_segments kept exch_end');
  assert.ok(!cols.has('n_exchanges'));
  assert.ok(!cols.has('exch_end'));
});

// The other half of the guard: the names it treats as proof of an old layout
// must not appear in a healthy one. If one ever does — a future column reusing
// an old name — every healthy database would be judged un-laid-out and dropped
// on every open. That is a worse failure than the one the guard exists to fix,
// so it is checked here rather than trusted.
test('a healthy index carries none of the names this rename removed', () => {
  const LEGACY = [
    'exchange_id', 'user_message', 'assistant_message', 'archive_path',
    'line_start', 'line_end', 'git_branch', 'is_sidechain', 'tool_names',
    'prompt_kind', 'is_system_noise', 'content_hash', 'indexed_at',
    'n_exchanges', 'exch_start', 'exch_end',
  ];
  const db = plain.getDb();
  const tables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
  ).all();
  const found = [];
  for (const { name } of tables) {
    for (const col of db.prepare('SELECT name FROM pragma_table_info(?)').all(name)) {
      if (LEGACY.includes(col.name)) found.push(`${name}.${col.name}`);
    }
  }
  assert.deepEqual(found, [], 'a name the guard treats as legacy is in the schema');
});

test.after(() => {
  for (const [mod, home] of [
    [plain, homePlain], [plainAgain, homePlain], [stamped, homeStamped],
    [mixed, homeMixed], [stray, homeStray],
  ]) {
    try { mod.closeDb(); } catch { /* already shut */ }
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* windows holds it */ }
  }
});
