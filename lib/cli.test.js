// The CLI is the only part of arca a person types at, so its failures are the
// ones that read as "this tool is broken". These run it as a process, because
// argv handling and exit codes are what regress, and neither is visible from
// an import.
//
// Only the parsing surface is exercised: nothing here touches the index, so
// the suite still passes on a machine where the vault has never been built.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');

function run(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

test('bare invocation prints help rather than an error', () => {
  const r = run();
  assert.equal(r.code, 0);
  assert.match(r.out, /Usage: arca <command>/);
  assert.match(r.out, /search/);
});

test('--help and -h agree with each other', () => {
  assert.equal(run('--help').out, run('-h').out);
  assert.equal(run('--help').out, run().out);
});

test('--version prints something version-shaped', () => {
  const r = run('--version');
  assert.equal(r.code, 0);
  assert.match(r.out.trim(), /^\d+\.\d+\.\d+/);
  assert.equal(r.out, run('-V').out);
});

test('every command has help, and it names the command', () => {
  // Catches a command added to the table without a usage line, which would
  // otherwise only show up as a blank screen for whoever asked.
  const listed = run().out
    .split('\n')
    .filter((l) => /^ {2}\w/.test(l) && !l.includes('--'))
    .map((l) => l.trim().split(/\s+/)[0]);
  assert.ok(listed.length >= 8, `expected the command list, got ${listed.join(',')}`);
  for (const name of listed) {
    const r = run('help', name);
    assert.equal(r.code, 0, `arca help ${name} failed`);
    assert.match(r.out, new RegExp(`Usage: arca ${name}`), `no usage line for ${name}`);
  }
});

test('`<command> --help` does not run the command', () => {
  // install --help must print, not install.
  const r = run('install', '--help');
  assert.equal(r.code, 0);
  assert.match(r.out, /Usage: arca install/);
  assert.doesNotMatch(r.out, /settings\.json:/);
});

test('an unknown command exits 2 and suggests the near one', () => {
  const r = run('serach', 'x');
  assert.equal(r.code, 2, 'a usage mistake is not a crash');
  assert.match(r.err, /unknown command "serach"/);
  assert.match(r.err, /did you mean "search"/);
});

test('an unknown command with no near match lists what there is', () => {
  const r = run('wumpus');
  assert.equal(r.code, 2);
  assert.match(r.err, /Commands: search, read/);
});

test('an unknown option is refused instead of ignored', () => {
  // The old parser accepted anything beginning with -- and dropped it, so a
  // typo in --project silently searched every project.
  const r = run('restore', '--projekt', 'foo');
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown option --projekt/);
  assert.match(r.err, /did you mean --project/);
});

test('an option belonging to another command is still unknown', () => {
  const r = run('install', '--limit', '5');
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown option --limit/);
});

test('a value option with no value is refused', () => {
  const r = run('search', 'q', '--limit');
  assert.equal(r.code, 2);
  assert.match(r.err, /--limit needs a value/);
});

test('a boolean given a value is refused', () => {
  const r = run('restore', '--force=yes');
  assert.equal(r.code, 2);
  assert.match(r.err, /--force takes no value/);
});

test('a boolean before a value option does not swallow it', () => {
  // `--dry-run --project x` used to bind "x" to nothing and lose --project.
  // Reaching "needs the directory" proves both flags parsed and the command
  // got as far as checking its positional argument.
  const r = run('import', '--dry-run', '--keep-temp');
  assert.equal(r.code, 2);
  assert.match(r.err, /import needs the directory/);
});

test('--flag=value is accepted', () => {
  const r = run('search', '--mode=sideways', 'q');
  assert.equal(r.code, 2);
  assert.match(r.err, /--mode wants hybrid, semantic or keyword, got "sideways"/);
});

test('a non-numeric count is refused before anything opens the index', () => {
  const r = run('search', 'q', '--limit', 'abc');
  assert.equal(r.code, 2);
  assert.match(r.err, /--limit wants a whole number/);
});

test('a missing query is a usage error, not a stack trace', () => {
  const r = run('search');
  assert.equal(r.code, 2);
  assert.match(r.err, /search needs a query/);
  assert.doesNotMatch(r.err, /at Object|at Module/);
});

test('read of a missing file says so plainly', () => {
  const r = run('read', 'definitely-not-here.jsonl');
  assert.equal(r.code, 2);
  assert.match(r.err, /no such file/);
});
