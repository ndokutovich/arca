// Finding credentials in text that was never meant to hold them.
//
// The vault is a git repository, and the point of a git repository is that it
// can be pushed somewhere. Everything here exists so that "push it to GitHub"
// is not the same sentence as "publish my API keys".
//
// Two kinds of rule. A *prefixed* rule matches an issued credential by the
// shape its issuer gave it — `ghp_`, `hf_`, `AKIA` — and is near enough to
// certain. A *contextual* rule matches a long opaque string next to a word
// like `password`, which is a guess, and is labelled as one.
//
// No regex here uses a backslash escape: every class is spelled out. Shorthand
// like \d survives one round-trip through a tool or a heredoc and not the next,
// and a silently broken secret scanner is worse than none.

import fs from 'node:fs';
import path from 'node:path';

const ALNUM = '[A-Za-z0-9]';
const TOKEN = '[A-Za-z0-9_-]';

/** Credentials that announce themselves. */
const PREFIXED = [
  ['anthropic-key', `sk-ant-${TOKEN}{20,}`],
  ['openai-key', `sk-${ALNUM}{40,}`],
  ['openai-project-key', `sk-proj-${TOKEN}{40,}`],
  ['github-pat', `github_pat_${TOKEN}{20,}`],
  ['github-token', `gh[pousr]_${ALNUM}{30,}`],
  ['gitlab-token', `glpat-${TOKEN}{15,}`],
  ['huggingface-token', `hf_${ALNUM}{30,}`],
  ['runpod-key', `rpa_${ALNUM}{30,}`],
  ['slack-token', `xox[baprs]-${TOKEN}{10,}`],
  ['aws-access-key', 'AKIA[0-9A-Z]{16}'],
  ['google-api-key', `AIza${TOKEN}{35}`],
  ['stripe-key', `[srp]k_(live|test)_${ALNUM}{20,}`],
  ['npm-token', `npm_${ALNUM}{36}`],
  ['sendgrid-key', `SG[.]${TOKEN}{20,}[.]${TOKEN}{20,}`],
  ['digitalocean-token', `dop_v1_${ALNUM}{60,}`],
  ['openrouter-key', `sk-or-v1-${ALNUM}{40,}`],
  ['private-key', '-----BEGIN ([A-Z]+ )?PRIVATE KEY-----'],
];

/** A word that turns a long opaque string into a probable secret. */
const NEARBY = '(api[_ -]?key|secret|passwd|password|token|credential|authorization|bearer)';

/**
 * A guess, not a match. Requires the naming word, an assignment, and 24+
 * opaque characters — `password: hunter2` is not caught, and neither is a
 * sentence that merely says the word "token".
 */
const CONTEXTUAL = [
  ['assigned-secret', `${NEARBY}["']?[ ]*[:=][ ]*["'\`]?(${TOKEN}|[+/=]){24,}`],
];

/**
 * Filler that people put where a secret will go.
 *
 * Only ever applied to contextual findings: an issued token that happens to
 * contain the letters "example" is still an issued token.
 */
const PLACEHOLDER = /your[_ -]|change[_ -]?me|changeinproduction|replace[_ -]?me|placeholder|example|sample|dummy|xxxx|<[a-z]|\.\.\./i;

// A prefix only means something at the start of a word. Without this,
// `disk-looks-like-code-defects` contains an OpenAI key and `hf_` is inside
// half the identifiers ever written. The one rule that legitimately starts
// with punctuation is left alone.
const BOUNDARY = '(?<![A-Za-z0-9_-])';
// Only the prefixed rules take it. A contextual rule matches a naming word,
// and naming words live inside identifiers on purpose: HF_TOKEN= and
// RUNPOD_API_KEY= are the exact shape being looked for.
const compile = (rules, flags, bounded) => rules.map(([id, src]) =>
  [id, new RegExp(bounded && !src.startsWith('-') ? BOUNDARY + src : src, flags)]);
const PREFIXED_RE = compile(PREFIXED, 'g', true);
const CONTEXTUAL_RE = compile(CONTEXTUAL, 'gi', false);

/**
 * What in this text looks like a credential.
 *
 * Returns the rule that fired, a masked sample and where it was, never the
 * secret itself: findings travel through logs and terminals, and a scanner
 * that prints what it finds has leaked it a second time.
 *
 * @param {string} text
 * @param {{contextual?: boolean}} opts  contextual rules are on by default
 * @returns {Array<{rule: string, kind: 'prefixed'|'contextual', masked: string, line: number}>}
 */
export function scan(text, { contextual = true } = {}) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const raw = [];
  const seen = new Set();
  const run = (rules, kind) => {
    for (const [rule, re] of rules) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        // A zero-width match would spin here forever on a malformed rule.
        if (m[0].length === 0) { re.lastIndex++; continue; }
        const key = `${rule}:${m[0]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (kind === 'contextual' && PLACEHOLDER.test(m[0])) continue;
        raw.push({ rule, kind, masked: mask(m[0]), index: m.index });
      }
    }
  };
  run(PREFIXED_RE, 'prefixed');
  if (contextual) run(CONTEXTUAL_RE, 'contextual');
  if (raw.length === 0) return [];

  // Line numbers in one pass over the text, not one pass per finding.
  // Counting from the start for each match is quadratic, and measurably so:
  // 200 findings cost 8 ms, 800 cost 45. An 8 MB chunk is two hundred times
  // larger than the text that was measured.
  raw.sort((a, b) => a.index - b.index);
  const found = [];
  let line = 1;
  let at = 0;
  for (const f of raw) {
    while (at < f.index) {
      if (text.charCodeAt(at) === 10) line++;
      at++;
    }
    found.push({ rule: f.rule, kind: f.kind, masked: f.masked, line });
  }
  return found;
}

/** Enough to recognise a secret you already know, not enough to use one. */
export function mask(value) {
  const s = String(value);
  if (s.length <= 10) return `${s.slice(0, 2)}...`;
  return `${s.slice(0, 6)}...(${s.length} chars)`;
}

/** Whether this text should stay out of a repository that might be pushed. */
export function looksSecret(text, opts) {
  return scan(text, opts).length > 0;
}

// A JavaScript string tops out at about 512 MB, and the four largest
// transcripts in this vault are 532, 521, 415 and 230 MB. Reading one whole
// is not a slow path, it is a thrown TypeError — and those are exactly the
// files most likely to have had a key printed into them.
const CHUNK = 8 * 1024 * 1024;

// Longer than any credential, so one straddling a chunk boundary is whole
// somewhere. The re-read starts at a different offset, which also repairs any
// multibyte character the previous chunk cut in half.
const OVERLAP = 4096;

/** Binary content cannot hold a credential in a form these rules read. */
const isBinary = (buf) => buf.subarray(0, 8192).includes(0);

function countNewlines(buf) {
  let n = 0;
  let at = buf.indexOf(10);
  while (at !== -1) { n++; at = buf.indexOf(10, at + 1); }
  return n;
}

/**
 * Findings in one file, whatever its size.
 *
 * @param {string} full
 * @returns {ReturnType<typeof scan>}
 */
export function scanFile(full) {
  let size = 0;
  try { size = fs.statSync(full).size; } catch { return []; }

  if (size <= CHUNK) {
    let buf;
    try { buf = fs.readFileSync(full); } catch { return []; }
    return isBinary(buf) ? [] : scan(buf.toString('utf8'));
  }

  let fd;
  try { fd = fs.openSync(full, 'r'); } catch { return []; }
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    const out = [];
    const seen = new Set();
    let pos = 0;
    let line = 1;
    let first = true;
    while (pos < size) {
      let n = 0;
      try { n = fs.readSync(fd, buf, 0, CHUNK, pos); } catch { break; }
      if (n <= 0) break;
      const slice = buf.subarray(0, n);
      if (first && isBinary(slice)) return [];
      first = false;

      for (const f of scan(slice.toString('utf8'))) {
        const at = line + f.line - 1;
        // The overlap shows the same finding twice; the absolute line is the
        // same both times, which is what makes it recognisable as one.
        const key = `${f.rule}:${f.masked}:${at}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ ...f, line: at });
      }

      const advance = n < CHUNK ? n : n - OVERLAP;
      line += countNewlines(slice.subarray(0, advance));
      pos += advance;
    }
    return out;
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

/**
 * Every file under `root` that looks like it holds a credential.
 *
 * Reads one file at a time and keeps only the findings, so a vault of
 * thousands of transcripts costs memory for the largest single file rather
 * than for all of them.
 *
 * @param {string} root
 * @param {{skip?: (name: string, rel: string) => boolean, onFile?: (rel: string) => void}} opts
 * @returns {Array<{file: string, findings: ReturnType<typeof scan>}>}
 */
export function scanTree(root, { skip = () => false, onFile = () => {} } = {}) {
  const hits = [];
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (skip(e.name, childRel)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, childRel); continue; }
      if (!e.isFile()) continue;
      onFile(childRel);
      const findings = scanFile(full);
      if (findings.length) hits.push({ file: childRel, findings });
    }
  };
  walk(root, '');
  return hits;
}

