// A period of work, grouped by project, with nothing thrown away.
//
// This is the deterministic half of a retrospective: the window, what was
// typed in it, which sessions were open, and the counts. Deciding what
// mattered is not decided here — a person reads it, or a model turns the JSON
// into prose. Splitting it this way keeps the numbers honest and the
// judgement where it belongs.
//
// Noise is counted and marked, never filtered out. An automated review run is
// evidence that work happened; a report that silently drops it reads as if
// that hour never existed.
import { readVault } from './history.js';

const AUTOMATED = /^Review this change for security/i;
const COMMAND = /^<(command-name|command-message|arg|local-command|bash-stdout|bash-stderr|task-notification)/i;
const SUMMARIZER = /this summary will be shown in a list to help users/i;

/** What kind of thing this prompt was. Nothing is ever "not worth counting". */
export function classifyPrompt(text) {
  const t = String(text || '').trim();
  if (AUTOMATED.test(t)) return 'automated';
  if (COMMAND.test(t)) return 'command';
  return 'human';
}

export function classifyTitle(title) {
  const t = String(title || '').trim();
  if (!t) return 'untitled';
  if (AUTOMATED.test(t)) return 'automated';
  if (SUMMARIZER.test(t)) return 'untitled';
  return 'human';
}

const day = (ts) => new Date(ts).toISOString().slice(5, 16).replace('T', ' ');
const iso = (ts) => new Date(ts).toISOString();

/**
 * @param {object} opts
 * @param {number} opts.sinceMs   inclusive lower bound, epoch ms
 * @param {string} [opts.project] substring filter on the project path
 * @param {Array}  [opts.sessions] rows from listSessions; when omitted the
 *                                 digest covers prompts only and says so
 * @param {boolean}[opts.includeNoise] keep automated and command entries in
 *                                 the `entries` list instead of only counting them
 */
export function buildDigest({ sinceMs, project = '', sessions = null, includeNoise = false } = {}) {
  const projectLc = String(project).toLowerCase();
  const untilMs = Date.now();

  const groups = new Map();
  const groupFor = (key) => {
    if (!groups.has(key)) {
      groups.set(key, {
        path: key, prompts: 0, human: 0, automated: 0, commands: 0,
        entries: [], sessions: [], first: null, last: null,
      });
    }
    return groups.get(key);
  };

  for (const p of readVault()) {
    if (!Number.isFinite(p.ts) || p.ts < sinceMs) continue;
    const key = p.projectPath || p.project || '(unknown project)';
    if (projectLc && !key.toLowerCase().includes(projectLc)) continue;
    const g = groupFor(key);
    const kind = classifyPrompt(p.text);
    g.prompts++;
    if (kind === 'human') g.human++;
    else if (kind === 'automated') g.automated++;
    else g.commands++;
    if (g.first === null || p.ts < g.first) g.first = p.ts;
    if (g.last === null || p.ts > g.last) g.last = p.ts;
    if (kind === 'human' || includeNoise) {
      g.entries.push({ ts: p.ts, kind, text: p.text });
    }
  }

  if (Array.isArray(sessions)) {
    for (const s of sessions) {
      const key = s.cwd || s.slug || '(unknown project)';
      if (projectLc && !key.toLowerCase().includes(projectLc)) continue;
      const when = new Date(s.mtime).getTime();
      if (Number.isFinite(sinceMs) && when < sinceMs) continue;
      const g = groups.get(key) || groupFor(key);
      g.sessions.push({
        id: s.id, mtime: s.mtime, bytes: s.sizeBytes,
        title: s.title || '', kind: classifyTitle(s.title),
        lastPrompt: (s.lastPrompt || '').slice(0, 120),
      });
      if (g.first === null || when < g.first) g.first = when;
      if (g.last === null || when > g.last) g.last = when;
    }
  }

  const projects = [...groups.values()].sort((a, b) => b.prompts - a.prompts || (b.last || 0) - (a.last || 0));
  for (const g of projects) {
    g.entries.sort((a, b) => a.ts - b.ts);
    g.sessions.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
  }

  const totals = projects.reduce((t, g) => ({
    prompts: t.prompts + g.prompts,
    human: t.human + g.human,
    automated: t.automated + g.automated,
    commands: t.commands + g.commands,
    sessions: t.sessions + g.sessions.length,
  }), { prompts: 0, human: 0, automated: 0, commands: 0, sessions: 0 });

  return {
    since: iso(sinceMs), until: iso(untilMs),
    sessionsIncluded: Array.isArray(sessions),
    totals: { ...totals, projects: projects.length },
    projects,
  };
}

export function formatDigestMarkdown(d, { width = 130 } = {}) {
  const out = [];
  const head = `# Дайджест ${d.since.slice(0, 10)} — ${d.until.slice(0, 10)}`;
  out.push(head, '');
  out.push(`промптов ${d.totals.prompts} · проектов ${d.totals.projects}`
    + (d.sessionsIncluded ? ` · сессий ${d.totals.sessions}` : ' · сессии не включены (--sessions)'));
  out.push(`  из них: ${d.totals.human} человеческих, ${d.totals.automated} автоматических, ${d.totals.commands} командных`);
  out.push('');

  for (const g of d.projects) {
    const span = g.first && g.last ? ` · ${d.since.slice(5, 10)}…${new Date(g.last).toISOString().slice(5, 10)}` : '';
    out.push(`## ${g.path}`);
    out.push(`${g.prompts} промптов (${g.human}ч / ${g.automated}а / ${g.commands}к)`
      + (d.sessionsIncluded ? ` · ${g.sessions.length} сессий` : '') + span);
    out.push('');

    if (d.sessionsIncluded && g.sessions.length) {
      for (const s of g.sessions) {
        const title = s.kind === 'untitled'
          ? `(без заголовка) ${s.lastPrompt}`.trim()
          : s.title;
        out.push(`  · ${s.mtime.slice(5, 16).replace('T', ' ')}  ${s.id.slice(0, 8)}  ${title.slice(0, 70)}`);
      }
      out.push('');
    }

    for (const e of g.entries) {
      const mark = e.kind === 'human' ? '' : ` [${e.kind}]`;
      out.push(`  ${day(e.ts)}  ${e.text.replace(/\s+/g, ' ').slice(0, width)}${mark}`);
    }
    const hidden = g.prompts - g.entries.length;
    if (hidden > 0) out.push(`  … ещё ${hidden} автоматических/командных строк (--all чтобы показать)`);
    out.push('');
  }
  return out.join('\n');
}
