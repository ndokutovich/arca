/**
 * Temporal fact extractor — precision-first triples over entity-anchored prose.
 *
 * Reliable triple extraction from arbitrary text is noisy, so this targets a
 * few high-precision, high-value, time-varying relations in the corpus:
 *   - runs_on_port  — "XTTS on port 8021", "Kokoro :8880"
 *   - has_version   — "vite 5.4.2", "torch==2.6.0"
 *   - replaced_by   — "switched from X to Y", "replaced X with Y"
 *
 * Every fact is anchored to a recognized entity (via entities.js), so a port
 * or version with no nearby entity is dropped rather than guessed. Pure
 * deterministic: no LLM. The valid-time windows are built by build-kg.js,
 * which feeds facts in chronological order so single-valued predicates
 * supersede correctly.
 */

import { extractEntities, normalizeKey, GAZETTEER } from './entities.js';

const SENT_SPLIT = /(?<=[.!?;\n])\s+|\n+/;
const FENCED_CODE = /```[\s\S]*?```/g;

// explicit port context only — bare "on N" matched line numbers / counts
const PORT_RE = /(?:\bport\s+|localhost:|127\.0\.0\.1:|0\.0\.0\.0:|:)(\d{4,5})\b/gi;
const PORT_MIN = 1024, PORT_MAX = 65535;
const PORT_WINDOW = 64; // max char distance entity↔port to associate

// version right after an entity surface. Group1 = cue (pin op / 'v'), group2 = version.
const VER_AFTER = /^(\s*[=<>~^@]=?\s*|\s+v|\s+)(\d{1,2}(?:\.\d{1,3}){1,3})\b/i;

/** Accept only software-shaped versions: short segments, no leading-zero pad,
 *  and either x.y.z form (strong) or a cue (v-prefix / pin operator) for x.y. */
function validVersion(cue, ver) {
  const segs = ver.split('.');
  if (segs.some((s) => s.length > 3 || /^0\d/.test(s) || +s > 999)) return false;
  const dots = segs.length - 1;
  if (dots >= 2) return true;                       // 2.8.0 — strongly version-like
  return /[=v]/i.test(cue);                          // 1.5 only with ==/v cue
}

const TRANSITION = [
  /\b(?:switched|moved|migrated|swapped|went)\s+from\s+([\w.-]+)\s+(?:to|back\s+to|→|->)\s+([\w.-]+)/gi,
  /\breplaced\s+([\w.-]+)\s+with\s+([\w.-]+)/gi,
];

/** Is this token a recognized entity (gazetteer or strong shape)? Returns its key or null. */
function entityKey(token) {
  if (!token) return null;
  const key = normalizeKey(token);
  if (GAZETTEER.has(key)) return key;
  const ents = extractEntities(token);
  return ents.length === 1 ? ents[0].key : null;
}

function splitSentences(text) {
  return text.replace(FENCED_CODE, ' ').split(SENT_SPLIT).map((s) => s.trim()).filter(Boolean);
}

/**
 * Extract triples from one text blob.
 * @param {string} text
 * @param {object} [opts]
 * @param {Set<string>} [opts.known] — if given, only facts about these entity keys
 *   are emitted (gates the KG to resolved entities, killing weak-acronym noise).
 * @returns {Array<{subject,predicate,object,confidence}>}
 */
export function extractFacts(text, opts = {}) {
  if (!text || typeof text !== 'string') return [];
  const known = opts.known || null;
  const ok = (key) => !known || known.has(key) || GAZETTEER.has(key);
  const out = [];
  const push = (subject, predicate, object, confidence) => {
    if (subject && object && subject !== object && ok(subject)) {
      out.push({ subject, predicate, object: String(object), confidence });
    }
  };

  for (const sent of splitSentences(text)) {
    if (sent.length > 600) continue; // skip long prose blobs — too ambiguous
    const ents = extractEntities(sent).map((e) => ({ ...e, pos: sent.indexOf(e.surface) })).filter((e) => e.pos >= 0);
    if (ents.length === 0) continue;

    // ports — associate to nearest entity within window
    PORT_RE.lastIndex = 0;
    let m;
    while ((m = PORT_RE.exec(sent)) !== null) {
      const port = parseInt(m[1], 10);
      if (port < PORT_MIN || port > PORT_MAX) continue;
      const at = m.index;
      // a port belongs to the entity it follows: prefer the nearest PRECEDING
      // entity ("Kokoro at :8880"); fall back to nearest overall.
      // bind only to the nearest PRECEDING entity within the window; a port with
      // no entity before it is skipped rather than bound to a following one.
      let best = null, bestD = Infinity;
      for (const e of ents) {
        if (e.pos <= at) { const d = at - e.pos; if (d < bestD) { bestD = d; best = e; } }
      }
      if (best && bestD <= PORT_WINDOW) push(best.key, 'runs_on_port', port, 0.8);
    }

    // versions — token immediately after an entity surface
    for (const e of ents) {
      const tail = sent.slice(e.pos + e.surface.length);
      const v = tail.match(VER_AFTER);
      if (v && validVersion(v[1], v[2])) push(e.key, 'has_version', v[2], 0.85);
    }

    // transitions — replaced_by between two recognized entities
    for (const re of TRANSITION) {
      re.lastIndex = 0;
      let t;
      while ((t = re.exec(sent)) !== null) {
        const a = entityKey(t[1]), b = entityKey(t[2]);
        if (a && b && ok(a) && ok(b)) push(a, 'replaced_by', b, 0.7);
      }
    }
  }
  return dedupe(out);
}

function dedupe(facts) {
  const seen = new Set();
  const out = [];
  for (const f of facts) {
    const k = `${f.subject}|${f.predicate}|${f.object}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
}

const KG_PREDICATES = ['runs_on_port', 'has_version', 'replaced_by'];
