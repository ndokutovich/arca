/**
 * Essence extractor — STYX-style structural compression.
 *
 * Extracts 4 categories of load-bearing sentences from prose:
 *   - DECISION    — what was decided / chosen / agreed
 *   - CONSTRAINT  — limits, requirements, hard facts that shape the space
 *   - TENSION     — open contradictions, trade-offs, unresolved choices
 *   - ANTIPATTERN — explicit "don't / never / avoid"
 *
 * Discards narrative content. Empirically achieves ~95% compression
 * on conversation transcripts and 94-99% on specification documents.
 *
 * Pure deterministic: no embeddings, no LLM calls.
 */

import { withUnicodeBoundary } from './regex-utils.js';

function fix(re) {
  return new RegExp(withUnicodeBoundary(re.source), re.flags);
}
function fixCategory(arr) {
  return arr.map(fix);
}

const SENT_SPLIT = /(?<=[.!?])\s+(?=[A-ZА-ЯЁ0-9«"'`])|\n{2,}/;
const CODE_BLOCK = /```[\s\S]*?```|`[^`\n]+`/g;

const NOISE = /^(?:```|<\w|http[s]?:\/\/|\$\s|>\s|\/[a-z\-]+\s*$|let me |i'?ll |okay,? |great,? |perfect,? )/i;

const META_NOISE = /(?:Stop hook|tool result|tool_use|<system-reminder>|hooks?\s+config|SessionStart|PostToolUse|PreToolUse)/i;

const SPEC_SHAPE = /^\s*[-*\d]+[.)]\s+|--[a-z][\w-]*|\$\{[^}]+\}|`[^`]+`.*`[^`]+`|^[A-Z_][A-Z_0-9]{4,}\s/m;

const PATTERNS_RAW = {
  DECISION: [
    /\bwe (?:decided|chose|picked|went with|agreed|landed on|settled on)\b/i,
    /\bi(?:'ll| will| am going to)\s+\w+/i,
    /\b(?:let'?s|gonna|going to)\s+\w+/i,
    /\bdecision[:\-]\s*\w/i,
    /\b(?:final|approved|locked in)\b/i,
    /\bдавай(?:те)?\b/i,
    /\b(?:решил[аи]?|выбрал[аи]?|остановил[ис]ь на|идём с|идем с|берём|берем)\b/i,
    /\bокей[,.]?\s+(?:делаем|погнали|поехали)\b/i,
    /\bпог(?:на|ё)ли\b/i,
  ],
  CONSTRAINT: [
    /\b(?:must|cannot|can'?t|must not|never|always|required|requires?)\b/i,
    /\b(?:max|min|limit|deadline|by [A-Z][a-z]+ \d+|within \d+)\b/i,
    /\b(?:only|exactly|at most|at least)\s+\d/i,
    /\b(?:не\s+(?:может|можем|должн[оы]|разреша))/i,
    /\b(?:обязательно|нельзя|должн[оы]|только)\b/i,
    /\b(?:максимум|минимум|до \d+|не более|не менее)\b/i,
  ],
  TENSION: [
    /\b(?:trade[- ]?off|tradeoff|on the other hand)\b/i,
    /\b(?:vs\.?|versus)\s+\w+/i,
    /\b(?:not sure|unclear|ambiguous|unresolved|tbd|todo)\b/i,
    /\b(?:но|однако|с другой стороны|компромисс|с одной стороны)\b/i,
    /\b(?:не\s+уверен|непонятно|неясно|спорн[оы])\b/i,
    /\b(?:either\s+\w+\s+or|выбрать между|или\s+\w+\s+или)\b/i,
  ],
  ANTIPATTERN: [
    /\b(?:don'?t|do not|never|avoid|stop|please don'?t)\b/i,
    /\bnot\s+(?:to|gonna)\b/i,
    /\b(?:не\s+(?:делай|надо|стоит|пиши|используй))\b/i,
    /\b(?:никогда|ни в коем случае|избегай)\b/i,
  ],
};
const PATTERNS = Object.fromEntries(
  Object.entries(PATTERNS_RAW).map(([k, regs]) => [k, fixCategory(regs)])
);

const PRIORITY = ['DECISION', 'ANTIPATTERN', 'CONSTRAINT', 'TENSION'];
const CATEGORIES = ['DECISION', 'CONSTRAINT', 'TENSION', 'ANTIPATTERN'];

/**
 * Split prose into sentences, dropping code blocks and chrome.
 *
 * @param {string} text
 * @param {object} opts
 * @returns {string[]}
 */
function splitSentences(text, { minLen = 6, maxLen = 400, dropMeta = true } = {}) {
  const stripped = text.replace(CODE_BLOCK, ' ');
  const out = [];
  for (const part of stripped.split(SENT_SPLIT)) {
    const s = part.trim();
    if (!s || s.length < minLen || s.length > maxLen) continue;
    if (NOISE.test(s)) continue;
    if (dropMeta && META_NOISE.test(s)) continue;
    out.push(s);
  }
  return out;
}

function classify(sentence, { strictAnti = true } = {}) {
  const hits = {};
  for (const cat of CATEGORIES) {
    for (const r of PATTERNS[cat]) {
      if (r.test(sentence)) {
        hits[cat] = (hits[cat] || 0) + 1;
        break;
      }
    }
  }
  const keys = Object.keys(hits);
  if (keys.length === 0) return null;
  // Priority on tie: DECISION > ANTIPATTERN > CONSTRAINT > TENSION
  let best = keys[0];
  for (const k of keys) {
    if (hits[k] > hits[best]) best = k;
    else if (hits[k] === hits[best] && PRIORITY.indexOf(k) < PRIORITY.indexOf(best)) best = k;
  }
  if (strictAnti && best === 'ANTIPATTERN' && SPEC_SHAPE.test(sentence)) {
    return null;
  }
  return best;
}

/**
 * Extract structural items from a single message.
 *
 * @param {string} text - source text
 * @param {string} speaker - 'user' | 'assistant' | 'doc'
 * @param {object} [opts]
 * @returns {Array<{category:string, speaker:string, text:string}>}
 */
export function extractEssence(text, speaker, opts = {}) {
  if (!text) return [];
  const out = [];
  for (const s of splitSentences(text, opts)) {
    const cat = classify(s, opts);
    if (cat) out.push({ category: cat, speaker, text: s });
  }
  return out;
}

/**
 * Extract from a full exchange (user + assistant).
 */
export function extractExchangeEssence(exchange, opts = {}) {
  return [
    ...extractEssence(exchange.userMessage || '', 'user', opts),
    ...extractEssence(exchange.assistantMessage || '', 'assistant', opts),
  ];
}

export const ESSENCE_CATEGORIES = CATEGORIES;
