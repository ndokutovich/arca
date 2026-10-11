/**
 * Cross-project entity extractor — the connective-tissue modality.
 *
 * Detects named entities (tools, tech, projects, concepts) that recur
 * ACROSS sessions and projects. Where essence.js compresses a single
 * turn to its load-bearing sentences, this layer threads a single
 * entity (e.g. "XTTS", "sqlite-vec") through every project it touches.
 *
 * An entity's value is its project span: a name in one project is local
 * noise; a name across twelve is the spine of the operator's work. The
 * aggregator (build-entities.js) ranks by project_count, not frequency.
 *
 * Pure deterministic: no embeddings, no LLM. Mirrors essence.js ethos.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

const FENCED_CODE = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]+`/g;

// Hyphenated tech names: F5-TTS, XTTS-v2, claude-code, better-sqlite3.
const HYPHEN_TECH = /\b[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+\b/g;
// CamelCase: ChromaDB, SQLite, OmniSVG, FluxUI, WebRTC.
const CAMEL = /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/g;
// Acronyms / all-caps tokens (>=2), optional digit/version suffix: XTTS, CUDA, TTS, RTX, GPU, MCP, GPT4.
const ACRONYM = /\b[A-Z]{2,}[0-9]*\b/g;
// dotted/pathy tech tokens: voice.sh, mcp-server.js — handled via HYPHEN_TECH for dashes; skip raw paths.

/**
 * High-precision gazetteer. Membership alone qualifies an entity even if
 * it appears only once, and pins its type. Keep curated and domain-true;
 * this is a precision booster, not the primary signal.
 */
const BUILTIN_GAZETTEER = new Map([
  // TTS / voice
  ['xtts', 'tech'], ['xtts-v2', 'tech'], ['kokoro', 'tech'], ['silero', 'tech'],
  ['f5-tts', 'tech'], ['pipecat', 'tech'], ['whisper', 'tech'], ['qwen3', 'tech'],
  ['qwen3-tts', 'tech'], ['speecht5', 'tech'], ['piper', 'tech'], ['coqui', 'tech'],
  // infra / libs
  ['chromadb', 'tech'], ['sqlite', 'tech'], ['sqlite-vec', 'tech'], ['ollama', 'tech'],
  ['docker', 'tech'], ['cuda', 'tech'], ['remotion', 'tech'], ['ffmpeg', 'tech'],
  ['llama.cpp', 'tech'], ['pytorch', 'tech'], ['torch', 'tech'], ['torchaudio', 'tech'],
  ['onnx', 'tech'], ['fastapi', 'tech'],
  ['better-sqlite3', 'tech'], ['fts5', 'tech'], ['webrtc', 'tech'],
  // web frameworks — dotted/lowercase forms the shape patterns miss
  ['next.js', 'tech'], ['nextjs', 'tech'], ['node.js', 'tech'], ['nodejs', 'tech'],
  ['vue.js', 'tech'], ['vuejs', 'tech'], ['nuxt', 'tech'], ['vite', 'tech'],
  ['svelte', 'tech'], ['express', 'tech'], ['nest.js', 'tech'], ['nestjs', 'tech'],
  ['astro', 'tech'], ['remix', 'tech'], ['tailwind', 'tech'], ['vitest', 'tech'],
  ['fastify', 'tech'], ['prisma', 'tech'], ['drizzle', 'tech'], ['three.js', 'tech'],
  ['flutter', 'tech'], ['livewire', 'tech'], ['fluxui', 'tech'],
  // agent tooling
  ['claude-code', 'tool'], ['arca', 'tool'], ['mcp', 'tool'],
  // Add your own projects and tools here. Entries qualify on a single
  // mention, so keep them distinctive: a common English word like "carrier"
  // will tag every ordinary use of it across the whole corpus.
  // LLM models — letter-digit shape collides with doc-refs (FR-1); pin the real ones
  ['gpt-4', 'tech'], ['gpt-5', 'tech'], ['gpt-4o', 'tech'], ['gpt-3', 'tech'],
  ['o1', 'tech'], ['o3', 'tech'], ['claude', 'tech'], ['gemini', 'tech'],
  ['llama', 'tech'], ['mistral', 'tech'], ['deepseek', 'tech'], ['qwen', 'tech'],
]);

/**
 * Your own projects, tools and people, kept out of this package.
 *
 * The built-in list is deliberately generic: an entry qualifies an entity on a
 * single mention, so shipping someone's private names would tag nothing useful
 * for anyone else — and shipping a common word like "carrier" would tag every
 * ordinary use of it across a whole corpus. Put yours in
 * ~/.claude-vault/gazetteer.json instead, as {"name": "tech|tool|person|concept"}.
 * They survive upgrades, because they never live in the code.
 */
function loadUserGazetteer() {
  const file = process.env.ARCA_GAZETTEER || path.join(os.homedir(), '.claude-vault', 'gazetteer.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  try {
    const obj = JSON.parse(raw);
    return Object.entries(obj)
      .filter(([k, v]) => typeof k === 'string' && typeof v === 'string' && k.trim())
      .map(([k, v]) => [k.trim().toLowerCase(), v]);
  } catch (e) {
    console.error(`arca: ignoring ${file} — ${e.message}`);
    return [];
  }
}

export const GAZETTEER = new Map([...BUILTIN_GAZETTEER, ...loadUserGazetteer()]);

/**
 * Tokens that match the shape patterns but are never entities.
 * Acronyms and CamelCase chrome that pollute technical prose.
 */
const STOPSET = new Set([
  // pronouns / chrome that can appear capitalized
  'I', 'A', 'OK', 'OKAY', 'YES', 'NO', 'TODO', 'FIXME', 'NOTE', 'WARNING',
  'ERROR', 'INFO', 'DEBUG', 'TRUE', 'FALSE', 'NULL', 'NONE', 'AND', 'OR',
  'NOT', 'IF', 'THE', 'BUT', 'FOR', 'YOU', 'WE', 'IT', 'SO', 'TO', 'OF',
  'IN', 'ON', 'AT', 'BY', 'IS', 'BE', 'AS', 'AN', 'US',
  // markdown/diff/log chrome
  'PM', 'AM', 'UTC', 'GMT', 'ID', 'URL', 'URI', 'HTTP', 'HTTPS', 'JSON',
  'YAML', 'CSV', 'XML', 'HTML', 'CSS', 'PDF', 'PNG', 'JPG', 'GIF', 'WAV',
  // generic acronyms that are never useful connective tissue
  'API', 'APP', 'CLI', 'SDK', 'IDE', 'OS', 'CPU', 'RAM', 'SSH', 'NPM',
  'VM', 'PR', 'CI', 'CD', 'ENV', 'TMP', 'SRC', 'DIR', 'CWD', 'FAQ',
]);

/**
 * Combined word-boundary regex over gazetteer keys, so plain-capitalized
 * names (Docker, Zeratul, Kokoro) that the shape patterns can't see are
 * still detected. Boundary uses lookaround to survive dots and hyphens.
 */
const GAZ_RE = new RegExp(
  '(?<![\\w-])(' +
  [...GAZETTEER.keys()]
    .sort((a, b) => b.length - a.length) // longest-first: xtts-v2 before xtts
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|') +
  ')(?![\\w-])',
  'gi'
);

/**
 * Common English words + generic acronyms that pass the shape patterns but
 * are background noise, not connective tissue. Used two ways: a bare token
 * matching here is rejected; a hyphenated token is rejected when EVERY
 * segment matches here (self-contained, end-to-end, re-run, top-level).
 * Gazetteer membership bypasses this filter.
 */
const COMMON_WORDS = new Set([
  // generic tech acronyms (ubiquitous → not distinctive)
  'js', 'ts', 'ui', 'ux', 'ai', 'llm', 'kb', 'mb', 'gb', 'cdn', 'crud',
  'sql', 'rest', 'readme', 'claude', 'cors', 'jwt', 'dom', 'orm', 'dto',
  'mvp', 'poc', 'eta', 'aka', 'fyi', 'wip', 'rc', 'lts',
  'get', 'put', 'post', 'head', 'patch', 'delete', 'ok', 'err',
  // shouted English from markdown emphasis / headings / reminders
  'critical', 'important', 'memory', 'arguments', 'warning', 'example',
  'default', 'output', 'input', 'summary', 'context', 'result', 'value',
  'name', 'type', 'list', 'data', 'file', 'path', 'code', 'test', 'do',
  'loc', 'do', 'must', 'should', 'never', 'always', 'yes', 'no', 'none',
  'true', 'false', 'null', 'step', 'task', 'goal', 'plan', 'fix', 'add',
  // hyphen-phrase segments (open-source, end-to-end, anti-patterns, ai-assisted)
  'to', 'by', 'as', 'is', 'in', 'on', 'of', 'at', 'source', 'assisted',
  'generated', 'accurate', 'reference', 'dark', 'light', 'patterns',
  'anti', 'driven', 'specific', 'related', 'friendly', 'grade', 'party',
  'aware', 'domain', 'word', 'free', 'rich', 'safe', 'less', 'like',
  // prefixes that head English compounds (near-duplicate, self-hosted, co-located)
  'near', 'self', 'non', 'inter', 'intra', 'semi', 'pseudo', 'quasi',
  'super', 'co', 'un', 'over', 'under', 'mid', 'mini', 'micro', 'macro',
  // common nouns that tail compounds (one-paragraph, two-line)
  'paragraph', 'duplicate', 'sentence', 'section', 'version', 'number',
  'minute', 'hour', 'day', 'week', 'month', 'year', 'line', 'page',
  'byte', 'bit', 'pixel', 'char', 'item', 'entry', 'record', 'three',
  'save', 'bad', 'good', 'best', 'worst', 'fast', 'slow', 'big', 'small',
  // function / common words that get capitalized at sentence or heading start
  'the', 'and', 'for', 'you', 'all', 'but', 'not', 'are', 'was', 'can',
  'will', 'with', 'this', 'that', 'from', 'have', 'has', 'had', 'our',
  'your', 'their', 'before', 'after', 'note', 'also', 'only', 'more',
  'most', 'some', 'any', 'each', 'when', 'then', 'than', 'what', 'which',
  'who', 'how', 'why', 'where', 'here', 'there', 'well', 'known', 'long',
  'short', 'full', 'half', 'multi', 'cross', 'non', 'pre', 'post', 'sub',
  'out', 'off', 'set', 'new', 'old', 'high', 'low', 'left', 'right',
  'open', 'close', 'start', 'stop', 'next', 'last', 'first', 'back',
  'done', 'todo', 'self', 'contained', 'end', 'run', 'top', 'level', 're',
  'follow', 'up', 'trade', 'one', 'two', 'use', 'used', 'using', 'via',
  'real', 'time', 'side', 'line', 'based', 'driven', 'aware', 'ready',
  'wide', 'deep', 'fine', 'hard', 'soft', 'core', 'main', 'auto', 'semi',
]);

/** Adjectival suffixes: a hyphenated token ending in one is an English compound, not an entity. */
const ADJ_SUFFIX = new Set([
  'based', 'ready', 'powered', 'driven', 'aware', 'friendly', 'grade',
  'specific', 'related', 'oriented', 'centric', 'free', 'rich', 'safe',
  'only', 'side', 'wide', 'trip', 'generation', 'compatible', 'enabled',
  'like', 'level', 'first', 'agnostic', 'proof', 'heavy', 'light', 'dark',
  'hosted', 'sized', 'shaped', 'looking', 'facing', 'wise', 'ish',
]);

const NORMALIZE_KEEP_DOT = /[.](?:js|sh|py|ts|md)$/i;

/**
 * Reject background noise. `surface` is the original-cased match.
 *   - bare common word / generic acronym
 *   - all-common hyphenated compound (top-level, follow-up)
 *   - any all-lowercase hyphenated token with no gazetteer segment — an
 *     English phrase (end-to-end, read-only, open-source), since real
 *     lowercase hyphenated tech is anchored by a known segment (docker-compose)
 *     and the rest carry caps or digits (XTTS-v2, F5-TTS).
 */
function isCommonNoise(key, surface) {
  if (GAZETTEER.has(key)) return false;
  if (COMMON_WORDS.has(key)) return true;
  // doc/requirement refs: FR-1, N-1, T-2 (real models like gpt-5 are gazetteered above)
  if (/^[a-z]{1,4}-\d+$/.test(key)) return true;
  // leaked unicode codepoint escapes from transcripts: U0001F534
  if (/^u[0-9a-f]{5,}$/i.test(key)) return true;
  if (key.includes('-')) {
    const parts = key.split('-');
    if (parts.some((p) => GAZETTEER.has(p))) return false;
    if (parts.every((p) => COMMON_WORDS.has(p) || /^[0-9]+$/.test(p))) return true;
    if (surface && /^[a-z][a-z-]*$/.test(surface)) return true; // all-lowercase phrase
    if (ADJ_SUFFIX.has(parts[parts.length - 1])) return true;    // X-based, X-ready
  }
  return false;
}

/**
 * Normalize a surface form to a stable cross-project key.
 * Lowercase, strip surrounding punctuation, keep meaningful dotted suffix.
 */
export function normalizeKey(surface) {
  let s = surface.trim().replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9.]+$/g, '');
  // preserve voice.sh / lib.js style; drop other trailing dots
  if (!NORMALIZE_KEEP_DOT.test(s)) s = s.replace(/\.+$/, '');
  return s.toLowerCase();
}

function classify(surface, key) {
  if (GAZETTEER.has(key)) return GAZETTEER.get(key);
  if (key.includes('-')) return 'tool';
  if (/^[A-Z]{2,}[0-9]*$/.test(surface)) return 'tech';
  if (/[a-z]/.test(surface) && /[A-Z]/.test(surface)) return 'tech'; // CamelCase
  return 'concept';
}

/**
 * Extract entity surface forms from one text blob.
 *
 * @param {string} text
 * @returns {Array<{surface:string, key:string, type:string}>}
 */
export function extractEntities(text) {
  if (!text || typeof text !== 'string') return [];
  const cleaned = text.replace(FENCED_CODE, ' ').replace(INLINE_CODE, ' ');
  const seen = new Map(); // key -> {surface, key, type}

  // Gazetteer scan first — catches plain-capitalized names the shapes miss.
  GAZ_RE.lastIndex = 0;
  let g;
  while ((g = GAZ_RE.exec(cleaned)) !== null) {
    const surface = g[1];
    const key = surface.toLowerCase();
    if (!seen.has(key)) seen.set(key, { surface, key, type: GAZETTEER.get(key) || 'concept' });
  }

  for (const re of [HYPHEN_TECH, CAMEL, ACRONYM]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(cleaned)) !== null) {
      const surface = m[0];
      if (STOPSET.has(surface.toUpperCase())) continue;
      const key = normalizeKey(surface);
      if (key.length < 2) continue;
      if (STOPSET.has(key.toUpperCase())) continue;
      // pure numbers or version-only tokens
      if (/^[0-9.]+$/.test(key)) continue;
      if (isCommonNoise(key, surface)) continue;
      if (!seen.has(key)) seen.set(key, { surface, key, type: classify(surface, key) });
    }
  }
  return [...seen.values()];
}

/**
 * Build a short context window around the first occurrence of a surface.
 */
export function mentionSnippet(text, surface, radius = 70) {
  const idx = text.indexOf(surface);
  if (idx === -1) return text.slice(0, radius * 2).replace(/\s+/g, ' ').trim();
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + surface.length + radius);
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
}

const ENTITY_TYPES = ['tech', 'tool', 'person', 'concept'];
