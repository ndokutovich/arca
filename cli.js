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
  limit: { value: 'N', describe: 'how many to show' },
  dryRun: { boolean: true, describe: 'show what would happen, write nothing' },
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
      mode: { value: 'both|vector|text', describe: 'retrieval mode (default both)' },
      limit: F.limit,
      after: { value: 'YYYY-MM-DD', describe: 'only after this date' },
      before: { value: 'YYYY-MM-DD', describe: 'only before this date' },
      project: F.project,
    },
    examples: [
      'arca search "why did we drop better-sqlite3"',
      'arca search "tokenizer" "glibc" --limit 5',
      'arca search "deploy" --project ai-cl --after 2026-06-01',
    ],
    async run({ flags, positional }) {
      if (!positional.length) fail('search needs a query');
      const mode = flags.mode || 'both';
      if (!['both', 'vector', 'text'].includes(mode)) {
        fail(`--mode wants both, vector or text, got "${mode}"`);
      }
      const opts = {
        mode,
        limit: num(flags.limit, 'limit') ?? 10,
        after: flags.after,
        before: flags.before,
        project: flags.project,
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
      console.log(`arca index: ${s.exchanges} exchanges, ${s.projects} projects, ${s.files} files`);
      const layers = [
        ['essence extracts', s.essence_extracts],
        ['entities', `${s.entities} (${s.cross_project_entities} cross-project)`],
        ['kg triples', `${s.kg_triples} (${s.kg_current} current)`],
        ['observations', s.observations],
        ['threads', `${s.threads} (${s.cross_session_threads} cross-session)`],
        ['system noise', s.system_noise],
      ];
      console.log('');
      for (const [name, value] of layers) console.log(`  ${name.padEnd(18)} ${value}`);

      if (s.machines?.length) {
        console.log('');
        console.log('  machines');
        for (const m of s.machines) {
          const who = m.machine || '(unclaimed)';
          console.log(`    ${who.padEnd(16)} ${String(m.count).padStart(7)} exchanges  ${m.projects} projects`);
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
    },
  },

  index: {
    summary: 'fold new exchanges into the index',
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
        const ex = r.exchanges ? `${r.exchanges} exchanges` : '';
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
        if (labelled) console.log(`Labelled ${labelled} exchange(s) in the index.`);
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
    },
    examples: ['arca install --dry-run'],
    async run({ flags }) {
      const { install } = await lazy.install();
      const r = install({ dryRun: !!flags['dry-run'], seed: !flags['no-seed'] });
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
