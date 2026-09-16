/**
 * Regex helpers — Unicode-aware word boundaries.
 *
 * JavaScript's `\b` is ASCII-only: it doesn't recognize Cyrillic letters
 * as word characters, so `\bдавай\b` fails on the string "давай". This
 * helper rewrites a pattern source to use lookbehind/lookahead boundaries
 * that work with both Latin and Cyrillic.
 */

const WORD = '[A-Za-zА-Яа-яЁё\\d_]';

/**
 * Translate `\b` into Cyrillic-safe boundaries.
 *
 * Replaces `\b` with `(?<!WORD)` if followed by a word char,
 * or `(?!WORD)` if preceded by a word char. Falls back to the
 * union if neither side resolves (rare).
 *
 * @param {string} src - regex pattern source (no flags, no leading/trailing `/`)
 * @returns {string}
 */
export function withUnicodeBoundary(src) {
  // Walk char by char, replace \b based on context.
  let out = '';
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\\' && src[i + 1] === 'b') {
      const prev = out[out.length - 1] || '';
      const next = src[i + 2] || '';
      const prevIsWord = /[A-Za-zА-Яа-яЁё\d_]/.test(prev);
      const nextIsWord = /[A-Za-zА-Яа-яЁё\d_]/.test(next);
      if (nextIsWord && !prevIsWord) {
        out += `(?<!${WORD})`;
      } else if (prevIsWord && !nextIsWord) {
        out += `(?!${WORD})`;
      } else {
        // Ambiguous (e.g., between groups) — emit both, the engine picks.
        out += `(?:(?<!${WORD})|(?!${WORD}))`;
      }
      i++; // skip 'b'
    } else {
      out += src[i];
    }
  }
  return out;
}

/**
 * Build a RegExp with Unicode-safe word boundaries.
 *
 * @param {string} src
 * @param {string} [flags='i']
 * @returns {RegExp}
 */
export function ub(src, flags = 'i') {
  return new RegExp(withUnicodeBoundary(src), flags);
}
