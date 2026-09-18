// BERT WordPiece, reproduced from the tokenizer.json that ships with the model.
//
// This lived inside @huggingface/transformers, which charged 174 MB for it: an
// image-processing native binary that loaded on every embedding, and a browser
// ONNX runtime that never loaded at all. The tokenizer itself is stock BERT.
//
// Every step below mirrors HuggingFace's BertNormalizer, BertPreTokenizer and
// WordPiece. A divergence would not throw — it would quietly produce vectors
// that disagree with the ones already in the index, which is worse than a
// crash. tokenizer.test.js pins this against ids captured from the original.

const CLS = '[CLS]';
const SEP = '[SEP]';
const UNK = '[UNK]';
const PREFIX = '##';

const MAX_LEN = 512;          // tokenizer_config.json: model_max_length
const MAX_WORD_CHARS = 100;   // tokenizer.json: max_input_chars_per_word

const CONTROL = /\p{C}/u;
const SPACE = /\s/u;
const PUNCT = /\p{P}/u;
const MARKS = /\p{Mn}/gu;
const SURROGATE = /[\uD800-\uDFFF]/;

// handle_chinese_chars: every CJK codepoint becomes its own word.
function isCjk(cp) {
  return (cp >= 0x4e00 && cp <= 0x9fff)
    || (cp >= 0x3400 && cp <= 0x4dbf)
    || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0x20000 && cp <= 0x2a6df)
    || (cp >= 0x2a700 && cp <= 0x2b73f)
    || (cp >= 0x2b740 && cp <= 0x2b81f)
    || (cp >= 0x2b820 && cp <= 0x2ceaf)
    || (cp >= 0x2f800 && cp <= 0x2fa1f);
}

// HuggingFace counts these ASCII ranges as punctuation on top of the Unicode
// P category, which pulls in symbols like $, backslash and ~. Written as
// ranges rather than a literal: a string of every punctuation mark is exactly
// the kind of thing an escape quietly eats one character out of.
function isAsciiPunct(cp) {
  return (cp >= 33 && cp <= 47)
    || (cp >= 58 && cp <= 64)
    || (cp >= 91 && cp <= 96)
    || (cp >= 123 && cp <= 126);
}

function isPunct(ch) {
  const cp = ch.codePointAt(0);
  return cp < 128 ? isAsciiPunct(cp) : PUNCT.test(ch);
}

function normalize(text) {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === 0 || cp === 0xfffd) continue;
    if (cp === 9 || cp === 10 || cp === 13) { out += ' '; continue; }
    if (cp < 128) {
      // Most of a transcript is ASCII; property lookups here cost more than
      // the model run does.
      if (cp < 32 || cp === 127) continue;
      out += ch;
      continue;
    }
    if (CONTROL.test(ch)) continue;
    if (SPACE.test(ch)) { out += ' '; continue; }
    out += isCjk(cp) ? ` ${ch} ` : ch;
  }
  // strip_accents is null in the config, which HuggingFace resolves to the
  // value of lowercase — true. So "é" becomes "e", and Russian "ё" becomes "е".
  return out.normalize('NFD').replace(MARKS, '').toLowerCase();
}

function split(text) {
  const out = [];
  for (const chunk of text.split(' ')) {
    if (!chunk) continue;
    let buf = '';
    for (const ch of chunk) {
      if (!isPunct(ch)) { buf += ch; continue; }
      if (buf) { out.push(buf); buf = ''; }
      out.push(ch);
    }
    if (buf) out.push(buf);
  }
  return out;
}

// Greedy longest-match-first. A word with any unmatchable piece is [UNK] whole,
// not partially — that is what makes it greedy-with-backtracking-off.
function pieces(word, vocab) {
  // Slicing a string by UTF-16 index would cut a surrogate pair in half, and
  // HuggingFace slices by codepoint. Pay for the array only when it matters.
  const chars = SURROGATE.test(word) ? [...word] : word;
  if (chars.length > MAX_WORD_CHARS) return [UNK];

  const out = [];
  let start = 0;
  while (start < chars.length) {
    let end = chars.length;
    let found = null;
    while (start < end) {
      const slice = typeof chars === 'string'
        ? chars.slice(start, end)
        : chars.slice(start, end).join('');
      const candidate = start > 0 ? PREFIX + slice : slice;
      if (vocab.has(candidate)) { found = candidate; break; }
      end--;
    }
    if (found === null) return [UNK];
    out.push(found);
    start = end;
  }
  return out;
}

/**
 * Build an encoder from a parsed tokenizer.json.
 * @param {object} json
 * @returns {{ encode(text: string): number[] }}
 */
export function loadTokenizer(json) {
  // A Map, not the raw object: a vocabulary entry named `constructor` or
  // `__proto__` would otherwise answer a lookup it never contained.
  const vocab = new Map(Object.entries(json.model.vocab));
  const unkId = vocab.get(UNK);
  const clsId = vocab.get(CLS);
  const sepId = vocab.get(SEP);
  if (unkId === undefined || clsId === undefined || sepId === undefined) {
    throw new Error('tokenizer.json is missing [UNK], [CLS] or [SEP]');
  }

  function encode(text) {
    const ids = [clsId];
    outer: for (const word of split(normalize(text))) {
      for (const piece of pieces(word, vocab)) {
        ids.push(vocab.get(piece) ?? unkId);
        // transformers.js truncates the sequence after the template has added
        // [CLS] and [SEP], by slicing it — so a text long enough to fill the
        // window loses its [SEP] rather than its last word. HuggingFace's
        // Python tokenizer does the opposite. The index was built with this
        // one, and it is the only place the two disagree.
        if (ids.length >= MAX_LEN) break outer;
      }
    }
    if (ids.length < MAX_LEN) ids.push(sepId);
    return ids;
  }

  return { encode };
}
