#!/usr/bin/env node
// arca — the command line over the vault.
//
// The usage text used to live in a comment at the top of this file, which no
// program has ever shown anyone. Commands were an if/else chain, so an unknown
// one printed a bare list, a misspelled flag was accepted and ignored, and
// there was no --help and no --version. Everything a person needs to find
// their way around now comes out of the same table the dispatcher reads, which
// is the only arrangement where help and behaviour cannot drift apart.
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import nodePath from 'path';
import fs from 'fs';

// The index pulls in native modules. `restore`, `install` and `resurrect` are
// exactly what someone runs when the index is broken or absent, so they must
// not import them. Everything index-backed loads on demand instead.
const lazy = {
  search: () => import('./lib/search.js'),
  show: () => import('./lib/show.js'),
  db: () => import('./lib/db.js'),
  restore: () => import('./lib/restore.js'),
  install: () => import('./lib/install.js'),
  resurrect: () => import('./lib/resurrect.js'),
  importer: () => import('./import-claude-ai.js'),
};

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
let dbModule = null;

function version() {
  try {
    return JSON.parse(fs.readFileSync(nodePath.join(HERE, 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

function human(bytes) {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

// A usage mistake is not a crash. Exit 2 keeps the two apart for anything
// driving arca from a script.
class UsageError extends Error {}

function fail(msg) { throw new UsageError(msg); }

function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return d[a.length][b.length];
}

function nearest(word, candidates) {
  return candidates
    .map((c) => [c, distance(word, c)])
    .filter(([, d]) => d <= Math.max(2, Math.floor(word.length / 3)))
    .sort((x, y) => x[1] - y[1])[0]?.[0];
}

// --- flags -----------------------------------------------------------------
//
// Each command declares its own. A flag the command does not take is an error
// rather than something silently dropped, and a boolean is known to be one, so
// `--dry-run --project x` no longer swallows `--project` as a value.

function parse(spec, argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith('--')) { positional.push(a); continue; }

    const eq = a.indexOf('=');
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    const inline = eq === -1 ? null : a.slice(eq + 1);
    const def = spec[name];
    if (!def) {
      const guess = nearest(name, Object.keys(spec));
      fail(`unknown option --${name}${guess ? ` (did you mean --${guess}?)` : ''}`);
    }
    if (def.boolean) {
      if (inline !== null) fail(`--${name} takes no value`);
      flags[name] = true;
      continue;
    }
    if (inline !== null) { flags[name] = inline; continue; }
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) fail(`--${name} needs a value`);
    flags[name] = argv[++i];
  }
  return { flags, positional };
}

function num(value, name) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) fail(`--${name} wants a whole number, got "${value}"`);
  return n;
}

// Shared flag shapes, so the same option reads the same way everywhere.
const F = {
  project: { value: 'NAME', describe: 'only this project' },
  source: { value: 'ID', describe: 'only this assistant (see `arca sources`)' },
  limit: { value: 'N', describe: 'how many to show' },
  dryRun: { boolean: true, describe: 'show what would happen, write nothing' },
  includeAgents: { boolean: true, describe: 'also search subagent sidechains' },
};

// --- commands --------------------------------------------------------------

const COMMANDS = {
  search: {
    summary: 'search past sessions',
    usage: 'arca search "query" ["query" ...] [options]',
    detail: [
      'One query runs a hybrid of vector similarity and full-text search, fused',
      'by reciprocal rank. Two or more run a multi-concept AND: every concept',
      'has to be present, which is the precise end of the tool.',
    ],
    flags: {
      mode: { value: 'hybrid|semantic|keyword', describe: 'retrieval mode (default hybrid)' },
      limit: F.limit,
      after: { value: 'YYYY-MM-DD', describe: 'only after this date' },
      before: { value: 'YYYY-MM-DD', describe: 'only before this date' },
      project: F.project,
      source: F.source,
      'include-agents': F.includeAgents,
    },
    examples: [
      'arca search "why did we drop better-sqlite3"',
      'arca search "tokenizer" "glibc" --limit 5',
      'arca search "deploy" --project ai-cl --after 2026-06-01',
    ],
    async run({ flags, positional }) {
      if (!positional.length) fail('search needs a query');
      const mode = flags.mode || 'hybrid';
      if (!['hybrid', 'semantic', 'keyword'].includes(mode)) {
        fail(`--mode wants hybrid, semantic or keyword, got "${mode}"`);
      }
      const opts = {
        mode,
        limit: num(flags.limit, 'limit') ?? 10,
        after: flags.after,
        before: flags.before,
        project: flags.project,
        source: flags.source,
        includeAgents: !!flags['include-agents'],
      };
      const S = await lazy.search();
      if (positional.length >= 2) {
        const results = await S.searchMultiConcept(positional, opts);
        console.log(S.formatMultiConceptMarkdown(results, positional));
      } else {
        console.log(S.formatResultsMarkdown(await S.search(positional[0], opts)));
      }
    },
  },

  read: {
    summary: 'print a conversation as markdown',
    usage: 'arca read <path> [startLine] [endLine]',
    detail: [
      'Reads in chunks, so ten lines out of a 500 MB transcript cost what ten',
      'lines should. Without a range it prints the head and says what it left.',
    ],
    flags: {},
    examples: ['arca read ~/.claude-vault/my-project/abc.jsonl 1 200'],
    async run({ positional }) {
      const [file, start, end] = positional;
      if (!file) fail('read needs a path');
      if (!fs.existsSync(file)) fail(`no such file: ${file}`);
      const { showConversation } = await lazy.show();
      console.log(showConversation(
        file,
        start ? Number(start) : undefined,
        end ? Number(end) : undefined,
      ));
    },
  },

  stats: {
    summary: 'what the vault and the index hold',
    usage: 'arca stats',
    flags: {},
    async run() {
      dbModule = await lazy.db();
      const s = dbModule.getStats();
      console.log(`arca index: ${s.turns} turns, ${s.projects} projects, ${s.files} files`);
      let prompts = null;
      try { prompts = dbModule.promptStats(); } catch { /* table may predate this */ }
      const layers = [
        ['prompts', prompts?.total
          ? `${prompts.total} (${prompts.orphans} with no surviving session)`
          : 'none — run `arca prompts --import`'],
        ['essence extracts', s.essence_extracts],
        ['entities', `${s.entities} (${s.cross_project_entities} cross-project)`],
        ['kg triples', `${s.kg_triples} (${s.kg_current} current)`],
        ['observations', s.observations],
        ['threads', `${s.threads} (${s.cross_session_threads} cross-session)`],
        ['system noise', s.system_noise],
      ];
      console.log('');
      for (const [name, value] of layers) console.log(`  ${name.padEnd(18)} ${value}`);

      if (s.sources?.length > 1) {
        console.log('');
        console.log('  assistants');
        for (const r of s.sources) {
          console.log(`    ${(r.source || '(unknown)').padEnd(14)} ${String(r.count).padStart(7)} turns  ${r.sessions} sessions`);
        }
      }

      if (s.machines?.length) {
        console.log('');
        console.log('  machines');
        for (const m of s.machines) {
          const who = m.machine || '(unclaimed)';
          console.log(`    ${who.padEnd(16)} ${String(m.count).padStart(7)} turns  ${m.projects} projects`);
        }
      }
      if (s.shared_projects?.length) {
        // Not a warning. Project names come from filesystem paths, so the same
        // name on two machines is ordinary — it is only worth saying out loud,
        // because a search across both will mix them without mentioning it.
        console.log('');
        console.log(`  ${s.shared_projects.length} project name(s) appear on more than one machine:`);
        for (const p of s.shared_projects.slice(0, 10)) {
          console.log(`    ${p.project}  (${p.machines} machines)`);
        }
        if (s.shared_projects.length > 10) console.log(`    ... and ${s.shared_projects.length - 10} more`);
      }

      // What Claude Code itself still holds, against what the vault kept.
      // The gap is the reason this exists, and it is better shown than
      // claimed.
      const { summary } = await import('./lib/retention.js');
      const r = summary();
      if (r) {
        console.log('');
        console.log('  retention');
        console.log(`    Claude Code holds ${r.held} session(s), oldest ${r.oldest.slice(0, 10)} (${r.days} days)`);
        // Not a subtraction: the live directory holds transcripts the index
        // never took, so the two counts are of different things. The number
        // worth printing is how many archived sessions have lost their
        // original, which only an intersection can say.
        const { live } = await import('./lib/retention.js');
        const here = live();
        const archived = (await import('./lib/db.js')).getDb()
          .prepare("SELECT DISTINCT session_id FROM turns WHERE source = 'claude_code' AND session_id IS NOT NULL")
          .all().map((x) => String(x.session_id));
        const orphaned = archived.filter((id) => !here.has(id)).length;
        if (orphaned) console.log(`    ${orphaned} archived session(s) no longer exist there`);
        if (r.lastLoss) {
          console.log(`    last loss: ${r.lastLoss.gone.length} session(s) between ${String(r.lastLoss.since).slice(0, 16)} and ${r.lastLoss.at.slice(0, 16)}`);
        } else if (r.samples < 2) {
          console.log(`    watching since ${r.samples ? 'today' : 'now'} — a loss needs two samples to be seen`);
        }
      }
    },
  },

  index: {
    summary: 'fold new turns into the index',
    usage: 'arca index [--full]',
    detail: [
      'Incremental by default and safe to re-run. --full re-reads every archive',
      'and reconciles: an archive that is gone leaves the index too.',
      '',
      'The index is derived. Nothing in it cannot be rebuilt from the vault.',
    ],
    flags: { full: { boolean: true, describe: 'rebuild from every archive' } },
    passthrough: true,
    async run({ argv }) {
      // The indexer loads the embedding model and has its own lifecycle, so it
      // runs as a child rather than being pulled into this process.
      const r = spawnSync(process.execPath, [nodePath.join(HERE, 'indexer.js'), ...argv], {
        stdio: 'inherit',
      });
      process.exitCode = r.status === null ? 1 : r.status;
    },
  },

  restore: {
    summary: 'put back a session Claude Code no longer has',
    usage: 'arca restore [<id>] [options]',
    detail: [
      'With no id, lists archived sessions missing from ~/.claude/projects/.',
      'With an id, copies that one back, where it appears in `claude --resume`',
      'for its project.',
      '',
      'A live transcript is never replaced without --force, and even then the',
      'copy it replaced is kept beside it.',
    ],
    flags: {
      limit: F.limit,
      project: F.project,
      force: { boolean: true, describe: 'replace a live transcript (the old one is kept)' },
      'include-imported': {
        boolean: true,
        describe: 'include claude.ai imports, which Claude Code cannot resume',
      },
    },
    examples: ['arca restore', 'arca restore 3f9c1a2b --force'],
    async run({ flags, positional }) {
      const { listRestorable, restoreSession } = await lazy.restore();
      const id = positional[0];
      if (id) {
        const r = restoreSession(id, { force: !!flags.force });
        console.log(`Restored ${r.id} into ${r.project}`);
        console.log(`  ${r.to}`);
        if (r.overwrote) {
          console.log(`  (overwrote the live transcript; the replaced copy is at ${r.preserved})`);
        }
        if (r.dirFiles) console.log(`  plus ${r.dirFiles} file(s) of its session directory (subagents, tool results)`);
        if (r.dirFailed) console.log(`  ${r.dirFailed} file(s) of its session directory could not be copied back`);
        if (r.note) console.log(`  note: ${r.note}`);
        console.log('');
        console.log('It will appear in `claude --resume` for that project.');
        return;
      }
      let db = null;
      try { dbModule = await lazy.db(); db = dbModule.getDb(); }
      catch { /* the listing works without the index */ }
      const filter = {
        project: flags.project || null,
        includeImported: !!flags['include-imported'],
      };
      const rows = listRestorable({ ...filter, limit: num(flags.limit, 'limit') ?? 20, db });
      // The total obeys the same filters as the rows, or the header promises
      // sessions the listing does not show.
      const total = listRestorable({ ...filter, limit: 0, db: null }).length;
      if (!total) {
        console.log('Nothing to restore — every archived session is still in ~/.claude/projects/.');
        return;
      }
      console.log(`${total} archived session(s) Claude Code no longer has. Most recent first:`);
      console.log('');
      for (const r of rows) {
        const when = r.last ? `${r.first} -> ${r.last}` : '(not indexed)';
        const ex = r.turns ? `${r.turns} turns` : '';
        console.log(`  ${r.id}  ${human(r.bytes).padStart(8)}  ${when}  ${ex}`);
        console.log(`    ${r.project}`);
      }
      console.log('');
      console.log('Restore one with:  arca restore <id>');
    },
  },

  resurrect: {
    summary: 'fork a transcript that resume cannot open',
    usage: 'arca resurrect [<id>] [options]',
    detail: [
      'Some transcripts grow past what the resume parser will load. With no id,',
      'lists the ones at risk. With an id, forks a new session from the last',
      'compact boundary — everything before it is already summarised there.',
      '',
      'The original is never touched.',
    ],
    flags: {
      project: F.project,
      all: { boolean: true, describe: 'list every transcript, not only the troubled ones' },
      'dry-run': F.dryRun,
    },
    examples: ['arca resurrect', 'arca resurrect 8d21ff90 --dry-run'],
    async run({ flags, positional }) {
      const { diagnose, forkSession } = await lazy.resurrect();
      const id = positional[0];
      if (id) {
        const r = await forkSession(id, { dryRun: !!flags['dry-run'] });
        const tag = r.dryRun ? '[dry-run] ' : '';
        const pct = (r.kept / r.lines * 100).toFixed(1);
        console.log(`${tag}${r.id} in ${r.project}`);
        console.log(`${tag}  ${r.lines} lines, last compact boundary at ${r.lastBoundary}`);
        console.log(`${tag}  keeping ${r.kept} lines (${pct}%) as ${r.newId}`);
        console.log('');
        if (r.dryRun) {
          console.log('Nothing was written. Run without --dry-run to fork.');
        } else {
          console.log(`  ${r.to}`);
          console.log(`  ${human(r.bytes)} -> ${human(r.newBytes)}`);
          console.log('');
          console.log('The original is untouched. The fork appears in `claude --resume`.');
        }
        return;
      }
      const all = !!flags.all;
      const rows = diagnose({ project: flags.project || null, all });
      if (!rows.length) {
        console.log(all
          ? 'No transcripts found.'
          : 'No transcript is large enough to trouble the resume parser.');
        return;
      }
      console.log(`${rows.length} transcript(s), largest first:`);
      console.log('');
      for (const r of rows) {
        console.log(`  ${r.status.toUpperCase().padEnd(8)} ${human(r.bytes).padStart(9)}  ${r.id}`);
        console.log(`    ${r.project}`);
      }
      console.log('');
      console.log('Fork one from its last compact boundary with:  arca resurrect <id>');
    },
  },

  import: {
    summary: 'fold a claude.ai export into the vault',
    usage: 'arca import <dir-with-export-zips> [options]',
    detail: [
      'Point it at the directory your claude.ai data export landed in. Safe to',
      'run again: a conversation that has not changed is left alone.',
    ],
    flags: {
      'dry-run': F.dryRun,
      'keep-temp': { boolean: true, describe: 'leave the unpacked export for inspection' },
    },
    examples: ['arca import ~/Downloads --dry-run'],
    async run({ flags, positional }) {
      const src = positional[0];
      if (!src) fail('import needs the directory holding the export zips');
      const { runImport } = await lazy.importer();
      const dryRun = !!flags['dry-run'];
      const s = runImport(src, { dryRun, keepTemp: !!flags['keep-temp'] });
      const tag = dryRun ? '[dry-run] ' : '';
      console.log(`${tag}conversations ${s.conversations}: ${s.created} new, ${s.updated} changed, `
        + `${s.unchanged} unchanged, ${s.empty} empty, ${s.unreadable} unreadable`);
      if (!dryRun && (s.created || s.updated)) {
        console.log('Run `arca index` to fold them into the index.');
      }
    },
  },

  prompts: {
    summary: 'search what you typed, including where the session is gone',
    usage: 'arca prompts ["query"] [options]',
    detail: [
      'Claude Code keeps every prompt you have typed in ~/.claude/history.jsonl,',
      'outside the per-project transcripts and outliving them. So it still holds',
      'the questions from sessions that were cleaned up — before arca existed,',
      'or before the hook was installed.',
      '',
      '--import copies new entries into the vault, where they travel with it,',
      'and folds them into the index. Nothing is copied wholesale: only entries',
      'newer than what is already stored, so the vault copy stays append-only.',
      '',
      'A prompt is an orphan when no turn in the index opens with it. Those',
      'are the ones nothing else can recover.',
    ],
    flags: {
      import: { boolean: true, describe: 'pull new entries from ~/.claude/history.jsonl' },
      orphans: { boolean: true, describe: 'only prompts whose session is gone' },
      project: F.project,
      limit: F.limit,
    },
    examples: [
      'arca prompts --import',
      'arca prompts "xtts"',
      'arca prompts "docker" --orphans',
    ],
    async run({ flags, positional }) {
      const H = await import('./lib/history.js');
      dbModule = await lazy.db();

      if (flags.import) {
        const synced = H.syncToVault();
        console.log(`history: ${synced.appended} new entr(ies) archived, ${synced.total} in the vault`);
        const stored = dbModule.upsertPrompts(H.readVault(), H.promptId, H.echoHash);
        const echoes = dbModule.markPromptEchoes(H.echoHash);
        console.log(`index:   ${stored} new prompt(s); ${echoes.matched} still have their session `
          + `(${echoes.byText} matched word for word), ${echoes.orphans} do not`);
        console.log('');
      }

      const limit = num(flags.limit, 'limit') ?? 20;
      const query = positional.join(' ').trim();
      if (!query) {
        const s = dbModule.promptStats();
        if (!s.total) {
          console.log('No prompts stored yet. Run `arca prompts --import`.');
          return;
        }
        console.log(`${s.total} prompts, ${s.orphans} with no surviving session`);
        console.log(`${(s.first || '').slice(0, 10)} -> ${(s.last || '').slice(0, 10)}`);
        if (s.machines.length > 1) {
          console.log('');
          for (const m of s.machines) {
            console.log(`  ${(m.machine || '(unknown)').padEnd(16)} ${String(m.c).padStart(7)}  ${m.orphans} orphaned`);
          }
        }
        console.log('');
        console.log('Search them with:  arca prompts "query"');
        return;
      }

      const rows = dbModule.searchPrompts(query, {
        project: flags.project || null,
        orphansOnly: !!flags.orphans,
        limit,
      });
      if (!rows.length) {
        console.log(`Nothing matched "${query}".`);
        return;
      }
      console.log(`${rows.length} prompt(s):`);
      console.log('');
      for (const r of rows) {
        const mark = r.has_session ? ' ' : '!';
        const text = r.text.replace(/\s+/g, ' ').trim();
        console.log(`${mark} ${r.timestamp.slice(0, 16).replace('T', ' ')}  ${r.project}`);
        console.log(`    ${text.length > 160 ? `${text.slice(0, 160)}...` : text}`);
      }
      console.log('');
      console.log('! = no surviving session for this prompt');
    },
  },

  sources: {
    summary: 'history from other assistants, not just Claude Code',
    usage: 'arca sources [--import] [options]',
    detail: [
      'The engine underneath arca never knew what Claude Code was — it takes',
      'text and gives back ranked text. Only the way in was Claude-shaped.',
      '',
      "A source adapter finds another assistant's sessions and converts them",
      'into the same archive format, so search, essence, entities and threads',
      'all see them with no special case. Imported sessions share the project',
      'directory of the Claude Code sessions run in the same place, because',
      'they are the same project.',
      '',
      'They mix into ordinary search; `--source <id>` narrows to one.',
      '',
      'Which assistants are read is your choice and it is remembered. Run',
      '`arca sources --select` for a checklist, or --enable / --disable from a',
      'script. Until you choose, everything detected is read.',
      '',
      'Claude Code is listed but has no adapter: the SessionStart hook copies',
      'its transcripts byte for byte, which is what lets `arca restore` hand',
      'one back to `claude --resume`. Re-rendering them through an adapter',
      'would lose the tool calls, the sidechains and the exact bytes.',
      '',
      'An adapter marked as built from the format has never been run against a',
      'real file on this machine.',
    ],
    flags: {
      import: { boolean: true, describe: 'fold enabled sessions into the vault' },
      select: { boolean: true, describe: 'choose which assistants to read' },
      enable: { value: 'IDS', describe: 'turn these on (comma separated)' },
      disable: { value: 'IDS', describe: 'turn these off (comma separated)' },
      only: { value: 'ID', describe: 'just this source, ignoring the selection' },
      'dry-run': F.dryRun,
      force: { boolean: true, describe: 're-read sessions even if unchanged' },
    },
    examples: [
      'arca sources',
      'arca sources --select',
      'arca sources --enable codex,cline',
      'arca sources --import --dry-run',
    ],
    async run({ flags }) {
      const S = await import('./lib/sources/index.js');
      const sel = await import('./lib/sources/selection.js');
      const { checklist, interactive } = await import('./lib/checklist.js');
      const { projectsDir } = await import('./lib/transcripts.js');

      const ids = (value) => String(value || '').split(',').map((x) => x.trim()).filter(Boolean);
      const known = S.ADAPTERS.map((a) => a.id);
      for (const id of [...ids(flags.enable), ...ids(flags.disable), flags.only].filter(Boolean)) {
        if (!known.includes(id)) fail(`no source called "${id}" (have: ${known.join(', ')})`);
      }

      const found = S.detectAll();

      // Claude Code belongs in the listing and not in the registry: the hook
      // copies its transcripts verbatim, and that is what restore depends on.
      const claudeCode = {
        id: 'claude-code',
        label: 'Claude Code',
        present: fs.existsSync(projectsDir()),
        managed: 'kept by the SessionStart hook, not by an adapter',
      };

      const applyFlags = () => {
        if (!flags.enable && !flags.disable) return false;
        const current = sel.load();
        const on = new Set(current.chosen
          ? current.enabled
          : found.filter((d) => d.present).map((d) => d.id));
        for (const id of ids(flags.enable)) on.add(id);
        for (const id of ids(flags.disable)) on.delete(id);
        sel.save([...on]);
        return true;
      };

      const runPicker = async () => {
        if (!interactive()) {
          fail('--select needs a terminal; use --enable / --disable from a script');
        }
        const current = sel.load();
        const items = found.map((d) => ({
          id: d.id,
          label: d.label,
          disabled: !d.present,
          checked: current.chosen ? current.enabled.includes(d.id) : true,
          note: d.present
            ? (d.verifiedAgainst === 'live' ? '' : '(built from the format, unverified here)')
            : '— not on this machine',
        }));
        const chosen = await checklist(items, {
          title: 'Which assistants should arca read?\n',
        });
        if (chosen === null) {
          console.log('Left as it was.');
          return false;
        }
        sel.save(chosen);
        return true;
      };

      if (flags.enable || flags.disable) applyFlags();
      if (flags.select) await runPicker();

      const doImport = flags.import;
      if (doImport && !sel.load().chosen && !flags.only && interactive()) {
        // First import on a machine: ask before reading anyone's history.
        console.log('No choice recorded yet.');
        console.log('');
        await runPicker();
      }

      const selection = sel.load();
      const enabled = (id) => (flags.only ? id === flags.only : sel.isEnabled(id, selection));

      if (!doImport) {
        console.log('');
        for (const d of found) {
          const box = !d.present ? '   ' : enabled(d.id) ? '[x]' : '[ ]';
          const where = d.present ? d.root : 'not on this machine';
          const proof = d.present && d.verifiedAgainst !== 'live'
            ? '   (built from the format, unverified here)' : '';
          console.log(`  ${box} ${d.id.padEnd(12)} ${d.label.padEnd(16)} ${where}${proof}`);
          if (d.note) console.log(`      ${d.note}`);
        }
        const where = claudeCode.present ? claudeCode.managed : 'not on this machine';
        console.log(`   ·  ${claudeCode.id.padEnd(12)} ${claudeCode.label.padEnd(16)} ${where}`);
        console.log('');
        console.log(selection.chosen
          ? `Chosen${selection.updated ? ` on ${selection.updated.slice(0, 10)}` : ''} · change it with:  arca sources --select`
          : 'Nothing chosen yet, so everything detected would be read.  arca sources --select');
        console.log('Fold them in with:  arca sources --import');
        return;
      }

      const dryRun = !!flags['dry-run'];
      const tag = dryRun ? '[dry-run] ' : '';
      let any = false;
      for (const d of found) {
        if (!d.present || !enabled(d.id)) continue;
        any = true;
        const adapter = S.byId(d.id);
        const t0 = Date.now();
        const s = S.importSource(adapter, { dryRun, force: !!flags.force, log: (m) => console.error(m) });
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`${tag}${d.id}: ${s.conversations} session(s) — ${s.created} new, ${s.updated} changed, `
          + `${s.unchanged} unchanged, ${s.empty} empty, ${s.unreadable} unreadable  (${secs}s)`);
      }
      if (!any) {
        console.log(selection.chosen
          ? 'Nothing enabled is on this machine.  arca sources --select'
          : 'Nothing detected on this machine.');
        return;
      }
      if (!dryRun) {
        console.log('');
        console.log('Run `arca index` to fold them into the index.');
      }
    },
  },
  machines: {
    summary: 'which machine each session came from',
    usage: 'arca machines [--adopt]',
    detail: [
      'The vault is a git repository, so a second machine folds in with a pull.',
      'What a pull cannot say is which machine a session came from — and two',
      'machines can hold projects with the same directory name that are not the',
      'same project at all.',
      '',
      'Each machine writes one append-only manifest naming the sessions it',
      'produced, and only ever its own, so two vaults merge without a conflict',
      'and nothing is renamed to make room.',
      '',
      '--adopt claims every session no manifest covers yet. Run it on each',
      'machine BEFORE adding a remote: afterwards, sessions pulled from',
      'elsewhere are indistinguishable from your own and adopting would put',
      'your name on them.',
    ],
    flags: { adopt: { boolean: true, describe: 'claim every unclaimed session as this machine' } },
    examples: ['arca machines', 'arca machines --adopt'],
    async run({ flags }) {
      const M = await import('./lib/machine.js');
      const { walkTranscripts, vaultDir } = await import('./lib/transcripts.js');

      if (flags.adopt) {
        const r = M.adopt((root) => walkTranscripts(root).map((t) => ({
          session: t.id,
          project: t.project,
        })));
        if (r.foreign && !r.alreadyDone) {
          console.log(`Careful: ${r.foreign} other machine(s) have already written here.`);
          console.log('Only sessions no manifest covered were claimed.');
        }
        console.log(r.adopted
          ? `Claimed ${r.adopted} session(s) for this machine.`
          : 'Nothing to claim — every session already has a machine.');
        if (r.alreadyDone) console.log('(this vault had been adopted before)');
      }

      // Label the index too, where it exists. Driven off session id, so this
      // also catches sessions a pull brought in with someone else's manifest.
      try {
        dbModule = await lazy.db();
        const labelled = dbModule.syncMachines(M.owners());
        if (labelled) console.log(`Labelled ${labelled} turn(s) in the index.`);
      } catch { /* the manifest is the record; the index is derived */ }

      const rows = M.machines();
      if (!rows.length) {
        console.log('No machine has claimed anything yet. Run `arca machines --adopt`.');
        return;
      }
      const self = M.machineId();
      const unowned = walkTranscripts(vaultDir()).length - [...M.owners().keys()].length;
      console.log('');
      for (const m of rows) {
        const mark = m.id === self ? '*' : ' ';
        const when = m.created ? m.created.slice(0, 10) : '';
        console.log(`${mark} ${m.id}  ${String(m.sessions).padStart(6)} sessions  ${m.hostname} ${m.platform} ${when}`);
      }
      console.log('');
      console.log(`* this machine${unowned > 0 ? `   ·   ${unowned} session(s) unclaimed` : ''}`);
    },
  },

  config: {
    summary: 'keep the agents, skills, commands and settings, not just the talk',
    usage: 'arca config [--sync] [--restore] [--scan] [options]',
    detail: [
      'A transcript says what was done. It does not say what it was done with:',
      'which agents existed, which skills, which hooks fired, what the settings',
      'were. Restore a session from six months ago onto a clean machine and it',
      'reads like instructions to a toolbox that is no longer there.',
      '',
      'So the vault takes a copy of ~/.claude as well. It rides in the same git',
      'repository as the transcripts, which means a snapshot is a commit, the',
      'history is "git log", and going back is "git checkout" — none of which',
      'had to be built.',
      '',
      'What is copied: CLAUDE.md, settings.json, statusline, agents, commands,',
      'skills, hooks, the plugin list, and the per-project memory files. What',
      'is not: credentials, node_modules, audio, logs, the skills Claude Code',
      'downloads for itself, and the per-session state in plans, tasks and',
      'todos — that last one is 14,000 files of churn and no configuration.',
      '',
      'A file that looks like it holds an API key is left behind and named. To',
      'keep one anyway, put its path in the allow file this prints.',
      '',
      '--restore writes the copy back. It refuses to overwrite anything unless',
      'you say --force, and even then it keeps the previous file beside the new',
      'one.',
      '',
      '--scan reads the whole vault, transcripts included, and reports what',
      'looks like a credential. Worth running before adding a git remote: a',
      'key that was printed during a session is in the archive verbatim.',
    ],
    flags: {
      sync: { boolean: true, describe: 'copy the configuration into the vault now' },
      restore: { boolean: true, describe: 'write the copy back into ~/.claude' },
      scan: { boolean: true, describe: 'look for credentials across the whole vault' },
      force: { boolean: true, describe: 'with --restore, overwrite what is there' },
      'dry-run': F.dryRun,
    },
    examples: [
      'arca config',
      'arca config --sync',
      'arca config --scan',
      'arca config --restore --dry-run',
    ],
    async run({ flags }) {
      const CV = await import('./lib/config-vault.js');
      const dryRun = !!flags['dry-run'];
      const tag = dryRun ? '[dry-run] ' : '';

      if (flags.scan) {
        const { scanTree } = await import('./lib/secrets.js');
        const { vaultDir } = await import('./lib/transcripts.js');
        const root = vaultDir();
        let seen = 0;
        const hits = scanTree(root, {
          // arca's own artifacts: the git objects, the SQLite index and the
          // 90 MB embedding model. None of them is text anyone wrote.
          skip: (name) => name === '.git' || name === 'index' || name === '.cache' || name === 'models',
          onFile: () => { seen++; },
        });
        console.log(`Scanned ${seen} file(s) in ${root}`);
        if (!hits.length) {
          console.log('Nothing that looks like a credential.');
          return;
        }
        const rules = new Map();
        for (const h of hits) for (const f of h.findings) rules.set(f.rule, (rules.get(f.rule) || 0) + 1);
        console.log(`${hits.length} file(s) hold something that looks like one:`);
        console.log('');
        for (const h of hits.slice(0, 40)) {
          console.log(`  ${h.file}`);
          for (const f of h.findings.slice(0, 4)) {
            console.log(`      line ${String(f.line).padStart(5)}  ${f.kind.padEnd(10)} ${f.rule.padEnd(20)} ${f.masked}`);
          }
        }
        if (hits.length > 40) console.log(`  ... and ${hits.length - 40} more`);
        console.log('');
        console.log(`by rule: ${[...rules].map(([r, n]) => `${r}=${n}`).join('  ')}`);
        console.log('');
        console.log('These are already committed. Rewriting the history of an archive is');
        console.log('its own kind of loss, so the honest move is usually to rotate the');
        console.log('credentials and keep the vault private.');
        return;
      }

      if (flags.restore) {
        const r = CV.restore({ dryRun, force: !!flags.force });
        if (r.empty) {
          console.log('Nothing to restore — the vault holds no configuration yet.');
          console.log('Run "arca config --sync" on the machine that has one.');
          return;
        }
        console.log(`${tag}wrote      ${r.written.length}`);
        console.log(`${tag}identical  ${r.identical}`);
        console.log(`${tag}in the way ${r.conflicts.length}`);
        for (const c of r.conflicts.slice(0, 20)) console.log(`    ${c}`);
        if (r.conflicts.length > 20) console.log(`    ... and ${r.conflicts.length - 20} more`);
        if (r.conflicts.length && !flags.force) {
          console.log('');
          console.log('Those differ from the copy and were left alone. --force replaces them,');
          console.log('keeping each previous file as <name>.before-arca-restore.');
        }
        return;
      }

      // --sync means now, whatever the cooldown says — and it stamps the
      // clock, so the hook does not immediately repeat the same pass.
      const r = flags.sync && !dryRun
        ? CV.syncIfDue({ cooldownMs: 0 })
        : CV.sync({ dryRun: true });
      if (r.sourceEmpty) {
        console.log(`Nothing readable in ${CV.claudeHome()} — the snapshot was left alone.`);
        console.log('Nothing to read is not the same as nothing to keep.');
        return;
      }
      const changed = r.added.length + r.changed.length + r.removed.length;
      const total = r.unchanged + r.added.length + r.changed.length;
      console.log(`${total} file(s), ${(r.bytes / 1048576).toFixed(1)} MB from ${CV.claudeHome()}`);
      console.log(`into ${CV.configDir()}`);
      const others = CV.configMachines().filter((m) => CV.configDir(m) !== CV.configDir());
      if (others.length) {
        console.log(`${others.length} other machine(s) keep a snapshot here: ${others.join(', ')}`);
      }
      console.log('');
      console.log(`  added     ${r.added.length}`);
      console.log(`  changed   ${r.changed.length}`);
      console.log(`  removed   ${r.removed.length}`);
      console.log(`  unchanged ${r.unchanged}`);

      if (r.skipped.length) {
        console.log('');
        console.log(`${r.skipped.length} file(s) held back — they look like they hold a credential:`);
        for (const s of r.skipped) {
          console.log(`  ${s.file}`);
          for (const f of s.findings.slice(0, 3)) {
            console.log(`      line ${String(f.line).padStart(5)}  ${f.kind.padEnd(10)} ${f.rule.padEnd(20)} ${f.masked}`);
          }
        }
        console.log('');
        console.log(`To keep one anyway, add its path to ${CV.allowFile()}`);
      }

      if (!flags.sync) {
        console.log('');
        console.log(changed
          ? `${changed} file(s) would be copied. Run "arca config --sync" to do it.`
          : 'Nothing to do — the copy is current.');
        console.log('The SessionStart hook also does this, so it usually is.');
      }
    },
  },

  install: {
    summary: 'register the hook, the MCP server and the skills',
    usage: 'arca install [options]',
    detail: [
      'Writes into ~/.claude/settings.json and the MCP config, backing up what',
      'it touches. It only claims entries that point into this package — a hook',
      'of yours that happens to share a name is reported and left alone.',
    ],
    flags: {
      'dry-run': F.dryRun,
      'no-seed': { boolean: true, describe: 'do not archive existing transcripts on install' },
      'replace-hook': { boolean: true, describe: 'take over a session-vault hook registered by something else' },
    },
    examples: ['arca install --dry-run'],
    async run({ flags }) {
      const { install } = await lazy.install();
      const r = install({ dryRun: !!flags['dry-run'], seed: !flags['no-seed'], replaceHook: !!flags['replace-hook'] });
      const tag = r.dryRun ? '[dry-run] ' : '';
      console.log(`${tag}arca at ${r.root}`);
      console.log(`${tag}settings.json: ${r.settings}`);
      console.log(`${tag}mcp config:    ${r.mcp}`);
      console.log(`${tag}files:         ${r.files.length ? r.files.join(', ') : 'all current'}`);
      for (const b of r.backups) console.log(`  backed up: ${b}`);
      if (r.seeded) console.log(`${tag}seed:          ${r.seeded}`);
      if (r.dryRun) {
        console.log('');
        console.log('Nothing was written. Run without --dry-run to apply.');
      }
    },
  },
};

// --- help ------------------------------------------------------------------

function pad(rows) {
  const w = Math.max(...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `  ${left.padEnd(w)}  ${right}`);
}

function overview() {
  return [
    'arca — a vault for everything Claude Code throws away.',
    '',
    'Usage: arca <command> [options]',
    '',
    'Commands:',
    ...pad(Object.entries(COMMANDS).map(([name, c]) => [name, c.summary])),
    '',
    ...pad([
      ['-h, --help', 'this, or `arca help <command>` for one command'],
      ['-V, --version', 'print the version'],
    ]),
    '',
    'The vault lives in ~/.claude-vault and is a git repository. The index is',
    'derived from it, and `arca index --full` rebuilds it from scratch.',
  ].join('\n');
}

function commandHelp(name) {
  const c = COMMANDS[name];
  if (!c) fail(unknownCommand(name));
  const out = [c.summary, '', `Usage: ${c.usage}`];
  if (c.detail) out.push('', ...c.detail);
  const flags = Object.entries(c.flags);
  if (flags.length) {
    out.push('', 'Options:', ...pad(flags.map(([f, d]) => [
      d.boolean ? `--${f}` : `--${f} <${d.value}>`,
      d.describe,
    ])));
  }
  if (c.examples) out.push('', 'Examples:', ...c.examples.map((e) => `  ${e}`));
  return out.join('\n');
}

function unknownCommand(word) {
  const names = Object.keys(COMMANDS);
  const guess = nearest(word, names);
  return guess
    ? `unknown command "${word}" (did you mean "${guess}"?)`
    : `unknown command "${word}"\n\nCommands: ${names.join(', ')}`;
}

// --- dispatch --------------------------------------------------------------

const argv = process.argv.slice(2);

try {
  const first = argv[0];

  if (!first || first === '-h' || first === '--help') {
    console.log(overview());
  } else if (first === 'help') {
    console.log(argv[1] ? commandHelp(argv[1]) : overview());
  } else if (first === '-V' || first === '--version') {
    console.log(version());
  } else {
    const command = COMMANDS[first];
    if (!command) fail(unknownCommand(first));
    const rest = argv.slice(1);
    if (rest.includes('--help') || rest.includes('-h')) {
      console.log(commandHelp(first));
    } else if (command.passthrough) {
      // Validated here for the sake of a good error, then handed on verbatim.
      parse(command.flags, rest);
      await command.run({ argv: rest });
    } else {
      await command.run({ ...parse(command.flags, rest), argv: rest });
    }
  }
} catch (e) {
  console.error(`arca: ${e.message}`);
  if (e instanceof UsageError) {
    console.error('');
    console.error('Try `arca --help`.');
    process.exit(2);
  }
  process.exit(1);
} finally {
  if (dbModule) dbModule.closeDb();
}
