// The claude.ai export arrives as one zip per kind of thing, and it has gained
// kinds over time. The importer read two of them and passed over the rest in
// silence, which is how a whole bucket of project knowledge sat in an export
// on disk for weeks without anyone knowing it was there.
//
// These run the real entry point against a synthetic already-extracted export,
// so no zip tool and no network are involved.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-import-'));
  fs.mkdirSync(path.join(home, 'export'), { recursive: true });
  return home;
}

async function withHome(home, fn) {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn(await import('../import-claude-ai.js'));
  } finally {
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
  }
}

const quiet = () => {};

function writeProject(home, project) {
  const dir = path.join(home, 'export', 'projects');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${project.uuid}.json`), JSON.stringify(project));
}

test('a project with knowledge documents becomes a transcript', () => {
  // The standing context a user wrote for a project — its instructions and
  // reference documents — appears in no conversation anywhere.
  const home = sandbox();
  writeProject(home, {
    uuid: 'p-1',
    name: 'Flutter The Greatest',
    description: 'everything about the app',
    prompt_template: 'Always answer in Dart.',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-02-01T00:00:00Z',
    docs: [{ uuid: 'd1', filename: 'architecture.md', content: 'The widget tree is the truth.' }],
  });
  return withHome(home, ({ runImport }) => {
    const stats = runImport(path.join(home, 'export'), { log: quiet });
    assert.equal(stats.created, 1);
    const file = path.join(home, '.claude-vault', 'claude-ai-projects', 'p-1.jsonl');
    assert.ok(fs.existsSync(file), 'no transcript written');
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /Flutter The Greatest/);
    assert.match(text, /Always answer in Dart/, 'the instructions are the point');
    assert.match(text, /architecture\.md/);
    assert.match(text, /widget tree is the truth/);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

test('a project with nothing in it is counted, not written', () => {
  // Most projects are an empty shell. Writing a transcript containing only a
  // title would put noise into every search result for that name.
  const home = sandbox();
  writeProject(home, { uuid: 'p-2', name: 'empty', docs: [] });
  return withHome(home, ({ runImport }) => {
    const stats = runImport(path.join(home, 'export'), { log: quiet });
    assert.equal(stats.empty, 1);
    assert.equal(stats.created, 0);
    assert.ok(!fs.existsSync(path.join(home, '.claude-vault', 'claude-ai-projects', 'p-2.jsonl')));
    fs.rmSync(home, { recursive: true, force: true });
  });
});

test('importing twice writes nothing the second time', () => {
  const home = sandbox();
  writeProject(home, {
    uuid: 'p-3', name: 'stable', prompt_template: 'unchanged', docs: [],
  });
  return withHome(home, ({ runImport }) => {
    assert.equal(runImport(path.join(home, 'export'), { log: quiet }).created, 1);
    const again = runImport(path.join(home, 'export'), { log: quiet });
    assert.equal(again.created, 0);
    assert.equal(again.unchanged, 1);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

test('an unreadable project costs only that project', () => {
  const home = sandbox();
  writeProject(home, { uuid: 'p-4', name: 'fine', prompt_template: 'ok', docs: [] });
  fs.writeFileSync(path.join(home, 'export', 'projects', 'broken.json'), '{ not json');
  return withHome(home, ({ runImport }) => {
    const stats = runImport(path.join(home, 'export'), { log: quiet });
    assert.equal(stats.unreadable, 1);
    assert.equal(stats.created, 1, 'the good one still landed');
    fs.rmSync(home, { recursive: true, force: true });
  });
});

test('a bucket the importer does not know is named, not ignored', () => {
  // The failure this is here to stop: a future export gains a kind of history
  // and nothing says so. Account records are skipped deliberately and must not
  // be reported as a discovery.
  const home = sandbox();
  const dir = path.join(home, 'export');
  fs.writeFileSync(path.join(dir, 'users.json'), '[]');
  fs.writeFileSync(path.join(dir, 'login_history.json'), '{}');
  fs.mkdirSync(path.join(dir, 'cowork_sessions'), { recursive: true });
  const said = [];
  return withHome(home, ({ runImport }) => {
    const stats = runImport(dir, { log: (m) => said.push(String(m)) });
    assert.deepEqual(stats.unknown, ['cowork_sessions']);
    assert.ok(said.some((m) => m.includes('cowork_sessions')), 'it has to be said out loud');
    assert.ok(!said.some((m) => m.includes('users.json')), 'account records are not a discovery');
    fs.rmSync(home, { recursive: true, force: true });
  });
});

test('an export with nothing recognisable does not throw', () => {
  const home = sandbox();
  return withHome(home, ({ runImport }) => {
    const stats = runImport(path.join(home, 'export'), { log: quiet });
    assert.equal(stats.conversations, 0);
    fs.rmSync(home, { recursive: true, force: true });
  });
});
