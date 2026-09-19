// The scanner decides what never leaves this machine. Every test here is a
// case that was wrong at some point in an afternoon, and would be wrong again
// silently: a scanner that finds nothing looks exactly like a clean vault.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scan, scanTree, mask, looksSecret } from './secrets.js';

// Never a real credential. Shaped like one, issued by nobody.
const PAT = `github_pat_${'A'.repeat(20)}9`;
const HF = `hf_${'q'.repeat(34)}`;

test('an issued token is found and named', () => {
  const found = scan(`the deploy key is ${PAT} — do not share`);
  assert.equal(found.length, 1);
  assert.equal(found[0].rule, 'github-pat');
  assert.equal(found[0].kind, 'prefixed');
});

test('a finding never carries the secret it found', () => {
  // Findings are printed to terminals and written to logs. A scanner that
  // echoes what it caught has published it a second time.
  const found = scan(`token: ${PAT}`);
  assert.ok(found.length >= 1);
  for (const f of found) {
    assert.ok(!f.masked.includes(PAT), `${f.rule} put the whole secret in the report`);
    assert.ok(!f.masked.includes(PAT.slice(10)), `${f.rule} put the tail of it in the report`);
    assert.ok(f.masked.length < 30, `${f.rule} reported too much of it`);
  }
});

test('the line number points at it', () => {
  const [f] = scan(`one\ntwo\nthree ${HF}\nfour`);
  assert.equal(f.line, 3);
});

test('talking about a key is not having one', () => {
  assert.deepEqual(scan('We rotate the api key every quarter.'), []);
  assert.deepEqual(scan('password: hunter2'), []);
  assert.deepEqual(scan('See the token owner for access.'), []);
});

test('a git sha is not a secret', () => {
  assert.deepEqual(scan('fixed in 3cec97b8fd838158e7d7d9dfe506a16af584234a'), []);
});

test('a prefix inside a word is not a prefix', () => {
  // `disk-looks-like-code-defects` contains `sk-looks-like-code-defects`, and
  // the first version of the OpenAI rule reported three memory files as
  // leaking keys because of it.
  assert.deepEqual(scan('name: full-disk-looks-like-code-defects'), []);
  assert.deepEqual(scan('the task-list_hf_variant branch'), []);
  assert.deepEqual(scan('my-glpat-notes.md'), []);
});

test('an underscore before the naming word does not hide the assignment', () => {
  // Fixing the boundary above broke this: HF_TOKEN= has an underscore before
  // TOKEN, and the boundary rejected exactly the shape being looked for.
  const found = scan(`HF_TOKEN=${'z'.repeat(40)}`);
  assert.equal(found.length, 1, 'an env-var assignment is the common case');
  assert.equal(found[0].kind, 'contextual');
});

test('a placeholder is not a credential', () => {
  assert.deepEqual(scan('JWT_SECRET=your-secret-key-change-in-production'), []);
  assert.deepEqual(scan('API_KEY=replace-me-with-a-real-key-here-ok'), []);
});

test('a placeholder exemption does not cover an issued token', () => {
  // The word "example" appearing inside a real token must not excuse it.
  const found = scan(`github_pat_example${'B'.repeat(20)}`);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'prefixed');
});

test('the same secret twice is one finding', () => {
  assert.equal(scan(`${PAT} and again ${PAT}`).length, 1);
});

test('nothing to scan is not a crash', () => {
  assert.deepEqual(scan(''), []);
  assert.deepEqual(scan(null), []);
  assert.deepEqual(scan(undefined), []);
});

test('looksSecret answers the only question most callers have', () => {
  assert.equal(looksSecret(`key ${PAT}`), true);
  assert.equal(looksSecret('nothing here'), false);
});

test('mask says how long it was without saying what it was', () => {
  assert.ok(mask('short').endsWith('...'));
  assert.ok(mask('a'.repeat(40)).includes('40 chars'));
});

test('a tree is searched file by file, and binaries are left out of it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-scan-'));
  try {
    fs.mkdirSync(path.join(root, 'deep', 'deeper'), { recursive: true });
    fs.writeFileSync(path.join(root, 'clean.md'), 'nothing of interest');
    fs.writeFileSync(path.join(root, 'deep', 'deeper', 'notes.md'), `key ${PAT}`);
    // A font decoded as UTF-8 is noise to match rules against, and any match
    // in it means nothing.
    fs.writeFileSync(path.join(root, 'font.ttf'),
      Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.from(PAT)]));

    let counted = 0;
    const hits = scanTree(root, { onFile: () => { counted++; } });
    assert.equal(counted, 3, 'every file should have been looked at');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].file, 'deep/deeper/notes.md');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a tree scan can be told what to walk past', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-scan-'));
  try {
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, '.git', 'packed'), `key ${PAT}`);
    const hits = scanTree(root, { skip: (name) => name === '.git' });
    assert.equal(hits.length, 0, 'a skipped directory was still read');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The chunk size inside scanFile. Hard-coded here on purpose: if it changes,
// these tests stop straddling the boundary and would start passing for the
// wrong reason, so the number is worth stating twice.
const CHUNK = 8 * 1024 * 1024;

test('a secret is found on the far side of a chunk boundary', () => {
  // Reading the file whole is not a slow path for a transcript this size, it
  // is a thrown TypeError: a JS string stops at about 512 MB and the biggest
  // transcripts in a real vault are past 500.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-big-'));
  try {
    const file = path.join(root, 'huge.jsonl');
    const filler = `${'a'.repeat(999)}\n`;
    const fd = fs.openSync(file, 'w');
    let written = 0;
    while (written < CHUNK + 2 * 1024 * 1024) { fs.writeSync(fd, filler); written += filler.length; }
    fs.writeSync(fd, `token ${PAT} here\n`);
    fs.closeSync(fd);

    const hits = scanTree(root);
    assert.equal(hits.length, 1, 'the second chunk was never read');
    assert.equal(hits[0].findings.length, 1);
    assert.equal(hits[0].findings[0].rule, 'github-pat');
    const expectedLine = written / filler.length + 1;
    assert.equal(hits[0].findings[0].line, expectedLine,
      'lines are counted per chunk, not from the start of the file');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a secret lying across the boundary is still whole somewhere', () => {
  // Without the overlap this is the one credential a chunked read cannot see:
  // each half is meaningless and neither chunk holds both.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-big-'));
  try {
    const file = path.join(root, 'huge.jsonl');
    // A space before it, or the word boundary rejects the prefix and the
    // test proves nothing about chunking.
    const head = 'a'.repeat(CHUNK - Math.floor(PAT.length / 2) - 1) + ' ';
    fs.writeFileSync(file, `${head}${PAT} ${'b'.repeat(1024 * 1024)}`);
    const hits = scanTree(root);
    assert.equal(hits.length, 1, 'a secret split across two chunks was missed');
    assert.equal(hits[0].findings[0].rule, 'github-pat');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the same secret inside the overlap is reported once', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-big-'));
  try {
    const file = path.join(root, 'huge.jsonl');
    // 100 bytes before the boundary: inside the 4 KB both chunks can see.
    const head = 'a'.repeat(CHUNK - 101) + ' ';
    fs.writeFileSync(file, `${head}${PAT} ${'b'.repeat(1024 * 1024)}`);
    const hits = scanTree(root);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].findings.length, 1, 'the overlap reported it twice');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
