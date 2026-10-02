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

test('a conversation keeps the code its tool calls carried', () => {
  // An artifact's HTML lives in a tool call, never in the text of the message
  // that produced it. Reading only `text` left the placeholder in the vault and
  // the code in the export — the page was there the whole time.
  const home = sandbox();
  fs.writeFileSync(path.join(home, 'export', 'conversations.json'), JSON.stringify([{
    uuid: 'c-1',
    name: 'atlas',
    created_at: '2026-08-22T00:00:00Z',
    chat_messages: [
      {
        sender: 'human',
        created_at: '2026-08-22T00:00:01Z',
        text: 'нарисуй карту расселения',
        content: [{ type: 'text', text: 'нарисуй карту расселения' }],
      },
      {
        sender: 'assistant',
        created_at: '2026-08-22T00:00:02Z',
        text: 'готово',
        content: [
          { type: 'text', text: 'готово' },
          { type: 'thinking', thinking: 'беру skill по фронтенд-дизайну' },
          {
            type: 'tool_use', name: 'create_file',
            input: { description: 'атлас гаплогрупп', path: '/out/atlas.html', file_text: '<!DOCTYPE html>\n<title>Две летописи</title>' },
          },
          {
            type: 'tool_use', name: 'str_replace',
            input: { description: 'архаичные корни', path: '/out/atlas.html', old_str: 'Денисовцы', new_str: 'Денисовцы, неандертальцы' },
          },
        ],
      },
    ],
  }]));

  return withHome(home, ({ runImport }) => {
    const stats = runImport(path.join(home, 'export'), { log: quiet });
    assert.equal(stats.created, 1);
    assert.equal(stats.toolCalls, 2, 'both calls are counted');
    const text = fs.readFileSync(path.join(home, '.claude-vault', 'claude-ai-web', 'c-1.jsonl'), 'utf8');
    assert.match(text, /Две летописи/, 'the artifact body is the point');
    assert.match(text, /\[tool create_file\] атлас гаплогрупп/);
    assert.match(text, /Денисовцы, неандертальцы/);
    assert.match(text, /\[thinking\]/, 'reasoning survives too');
    fs.rmSync(home, { recursive: true, force: true });
  });
});

test('a message whose blocks are silent keeps its words', () => {
  // Some messages carry an empty text block and put the prose in `text` alone.
  // Rendering the blocks without this fallback dropped them in silence.
  const home = sandbox();
  fs.writeFileSync(path.join(home, 'export', 'conversations.json'), JSON.stringify([{
    uuid: 'c-2',
    name: 'silent blocks',
    created_at: '2026-08-26T00:00:00Z',
    chat_messages: [{
      sender: 'assistant',
      created_at: '2026-08-26T00:00:01Z',
      text: 'Мидлварь нужна, чтобы маппинг шёл в обе стороны.',
      content: [
        { type: 'text', text: '' },
        { type: 'tool_use', name: 'web_fetch', input: { description: 'смотрю доки', path: 'https://example.org' } },
      ],
    }],
  }]));

  return withHome(home, ({ runImport }) => {
    runImport(path.join(home, 'export'), { log: quiet });
    const text = fs.readFileSync(path.join(home, '.claude-vault', 'claude-ai-web', 'c-2.jsonl'), 'utf8');
    assert.match(text, /Мидлварь нужна/, 'the words survive');
    assert.match(text, /\[tool web_fetch\]/);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

test('a design chat keeps what its tool calls wrote', () => {
  // Design chats nest the same thing differently: blocks under content.contentBlocks,
  // calls under a toolCall object.
  const home = sandbox();
  const dir = path.join(home, 'export', 'design_chats');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'd-1.json'), JSON.stringify({
    uuid: 'd-1',
    title: 'Chat',
    project: { name: 'Art of War' },
    created_at: '2026-05-31T00:00:00Z',
    messages: [
      {
        role: 'user',
        created_at: '2026-05-31T00:00:01Z',
        content: { content: 'сделай дизайн', contentBlocks: [{ type: 'text', text: 'сделай дизайн' }] },
      },
      {
        role: 'assistant',
        created_at: '2026-05-31T00:00:02Z',
        content: {
          content: 'готово',
          contentBlocks: [
            { type: 'text', text: 'готово' },
            {
              type: 'tool_call',
              toolCall: {
                name: 'write_file',
                input: { asset: 'Искусство войны', content: '<!DOCTYPE html>\n<html lang="ru">' },
                output: 'Wrote js/app.jsx',
              },
            },
          ],
        },
      },
    ],
  }));

  return withHome(home, ({ runImport }) => {
    const stats = runImport(path.join(home, 'export'), { log: quiet });
    assert.equal(stats.created, 1);
    assert.equal(stats.toolCalls, 1);
    const text = fs.readFileSync(path.join(home, '.claude-vault', 'claude-ai-design-art-of-war', 'd-1.jsonl'), 'utf8');
    assert.match(text, /\[tool write_file\]/);
    assert.match(text, /asset: Искусство войны/);
    assert.match(text, /lang=\\?"ru\\?"/, 'the written markup is in the vault');
    assert.match(text, /Wrote js\/app\.jsx/);
    fs.rmSync(home, { recursive: true, force: true });
  });
});
