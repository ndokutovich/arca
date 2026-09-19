// Restoring puts a transcript back where Claude Code reads it, so the listing
// must only ever offer sessions Claude Code could actually open. A claude.ai
// conversation cannot be resumed, and neither can a Codex or OpenCode one —
// offering either is offering something that never existed, and the person
// only finds out when `claude --resume` shows them an empty session.
//
// The index is the authority on what a session came from. A fake one here
// keeps the suite free of a real database.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function sandbox(sessions) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-restore-'));
  for (const { project, id } of sessions) {
    const dir = path.join(home, '.claude-vault', project);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), '{}\n');
  }
  // ~/.claude/projects exists but is empty, so nothing is "live" and every
  // archived session is a restore candidate.
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  return home;
}

async function withHome(home, fn) {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn(await import('./restore.js'));
  } finally {
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
  }
}

/**
 * Enough of the database interface for listRestorable, and no more — but it
 * does read the condition it was given rather than answering the same way to
 * anything mentioning "source". A fake that ignores the query cannot tell a
 * correct filter from a broken one, and the first version of this file passed
 * against both.
 */
function fakeDb(rows) {
  return {
    prepare(sql) {
      const m = sql.match(/source\s*(!?=)\s*'([a-z_]+)'/);
      if (m) {
        const [, op, value] = m;
        return {
          all: () => rows
            .filter((r) => (op === '=' ? r.source === value : r.source !== value))
            .map((r) => ({ session_id: r.id })),
        };
      }
      // the per-session enrichment query
      return { get: () => null, all: () => [] };
    },
  };
}

test('a session from another assistant is not offered for restore', () => {
  const home = sandbox([
    { project: 'w--app', id: 'claude-one' },
    { project: 'w--app', id: 'codex-one' },
    { project: 'w--app', id: 'opencode-one' },
  ]);
  return withHome(home, ({ listRestorable }) => {
    const rows = listRestorable({ limit: 0, db: fakeDb([
      { id: 'claude-one', source: 'claude_code' },
      { id: 'codex-one', source: 'codex' },
      { id: 'opencode-one', source: 'opencode' },
    ]) });
    assert.deepEqual(rows.map((r) => r.id).sort(), ['claude-one']);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

test('--include-imported asks for them back', () => {
  const home = sandbox([
    { project: 'w--app', id: 'claude-one' },
    { project: 'w--app', id: 'codex-one' },
  ]);
  return withHome(home, ({ listRestorable }) => {
    const rows = listRestorable({ limit: 0, includeImported: true, db: fakeDb([
      { id: 'claude-one', source: 'claude_code' },
      { id: 'codex-one', source: 'codex' },
    ]) });
    assert.equal(rows.length, 2);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

test('with no index it falls back to the project-name prefix', () => {
  // The listing has to work when the index is missing or broken — that is
  // exactly when someone is trying to restore something.
  const home = sandbox([
    { project: 'w--app', id: 'claude-one' },
    { project: 'claude-ai-web', id: 'imported-one' },
  ]);
  return withHome(home, ({ listRestorable }) => {
    const rows = listRestorable({ limit: 0, db: null });
    assert.deepEqual(rows.map((r) => r.id), ['claude-one']);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

test('a real project named claude-ai-something is not mistaken for an import', () => {
  // The prefix is a fallback, not the rule. When the index can answer, it does.
  const home = sandbox([{ project: 'claude-ai-toolkit', id: 'real-one' }]);
  return withHome(home, ({ listRestorable }) => {
    const rows = listRestorable({ limit: 0, db: fakeDb([{ id: 'real-one', source: 'claude_code' }]) });
    assert.deepEqual(rows.map((r) => r.id), ['real-one']);
    fs.rmSync(home, { recursive: true, force: true });
  });
});
