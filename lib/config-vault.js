// The configuration half of the vault.
//
// arca already keeps what was said. This keeps what it was said with: the
// agents, skills, commands, hooks and settings that make one person's Claude
// Code different from everyone else's. Same vault, same git, same commits —
// so a snapshot is a commit, history is `git log`, and going back is
// `git checkout`, none of which has to be built.
//
// The patterns come from divine-set's config vault (Express server era,
// isomorphic-git), which worked this out first and is where `.credentials.json`
// leading the exclusions comes from. Three of its entries are deliberately not
// here: plans/, tasks/ and todos/ are per-session state rather than
// configuration, and todos/ alone is 14,257 files on this machine of which 188
// hold anything — that much churn in a commit per session is how a repository
// becomes unusable.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { vaultDir } from './transcripts.js';
import { scan } from './secrets.js';

/** What a new machine would need to feel like this one. */
export const INCLUDE = [
  'CLAUDE.md',
  'settings.json',
  'statusline.sh',
  'agents/**/*',
  'commands/**/*.md',
  'commands/**/*.skill',
  'skills/**/*',
  'hooks/**/*',
  'plugins/config.json',
  'plugins/known_marketplaces.json',
  'plugins/installed_plugins.json',
  // Claude Code's own notes about each project, since v2.1.59.
  'projects/*/memory/*.md',
];

/**
 * Never, whatever the includes say.
 *
 * `.credentials.json` is first for a reason: the vault is a git repository
 * that people are meant to be able to push somewhere.
 */
export const EXCLUDE = [
  '**/.credentials.json',
  '**/node_modules/**',
  '**/.git/**',
  '**/*.wav', '**/*.mp3', '**/*.ogg', '**/*.flac', '**/*.m4a',
  '**/*.log',
  '**/.DS_Store',
  // A bare .env is never a template.
  '**/.env',
  // Runtime leftovers from whatever wrote them. Not configuration, and the
  // vault ignores *.tmp for its own reasons — so a captured one is copied
  // and then silently never committed.
  '**/*.tmp',
  // What this module itself leaves behind: an interrupted copy, and the file
  // --restore keeps when it replaces one. Both sit next to a real config
  // file and match the same patterns, so without these they are captured as
  // configuration and committed.
  '**/*.tmp-*',
  '**/*.before-arca-restore',
  // Skills Claude Code downloads for itself. They are 9 MB of Office XML
  // schemas and fonts here, they are identical on every machine, and they
  // come back on their own after a login.
  'skills/synced/**',
];

export const claudeHome = () => process.env.ARCA_CLAUDE_HOME || path.join(os.homedir(), '.claude');
export const configDir = () => path.join(vaultDir(), 'config');

/**
 * `**` spans directories, `*` does not, and a dot is a dot.
 *
 * Written as a scan rather than a chain of `.replace()` calls: the chain needs
 * a placeholder to hold `**` while `*` is rewritten, and every placeholder is
 * either a character that can legally appear in a path or an invisible one.
 */
function toRegExp(pattern) {
  const special = '.+^${}()|[]?';
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` spans zero directories as well as many, so `commands/**/*.md`
        // has to match `commands/deploy.md` and not only `commands/a/b.md`.
        if (pattern[i + 2] === '/') { out += '(.*/)?'; i += 2; } else { out += '.*'; i++; }
      } else {
        out += '[^/]*';
      }
    } else if (special.includes(c) || c === String.fromCharCode(92)) {
      out += String.fromCharCode(92) + c;
    } else {
      out += c;
    }
  }
  return new RegExp('^' + out + '$');
}

const INCLUDE_RE = INCLUDE.map(toRegExp);
const EXCLUDE_RE = EXCLUDE.map(toRegExp);

export function isExcluded(rel) {
  return EXCLUDE_RE.some((re) => re.test(rel));
}

export function isIncluded(rel) {
  return INCLUDE_RE.some((re) => re.test(rel)) && !isExcluded(rel);
}

/**
 * Every configuration file under ~/.claude, as paths relative to it.
 *
 * Walks once and tests each file, rather than expanding each pattern: the
 * directories involved hold tens of thousands of files and a pattern-at-a-time
 * expansion walks them again for every entry in the list.
 */
export function collect(home = claudeHome()) {
  const out = [];
  // Keeping skills or agents in a git repo of their own and linking them into
  // ~/.claude is an ordinary arrangement, and readdir reports the link as
  // neither a file nor a directory. Without following it the whole tree is
  // skipped in silence, which is the worst answer a backup can give.
  //
  // Following links means a link can point at an ancestor, so each directory
  // is entered once by its real path.
  const entered = new Set();
  const walk = (dir, rel) => {
    let real;
    try { real = fs.realpathSync(dir); } catch { return; }
    if (entered.has(real)) return;
    entered.add(real);

    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        // statSync follows; a broken link has nothing to follow.
        try { const st = fs.statSync(full); isDir = st.isDirectory(); isFile = st.isFile(); } catch { continue; }
      }
      if (isDir) {
        // Pruning here rather than per-file is what keeps node_modules from
        // costing a walk of itself.
        if (isExcluded(`${childRel}/`) || isExcluded(childRel) || e.name === 'node_modules' || e.name === '.git') continue;
        walk(full, childRel);
      } else if (isFile && isIncluded(childRel)) {
        out.push(childRel);
      }
    }
  };
  walk(home, '');
  return out.sort();
}

const hashOf = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Paths the user has said are fine, one per line, `#` for a comment. */
export const allowFile = () => path.join(vaultDir(), '.arca', 'config-allow');

/**
 * Relative paths are written with forward slashes everywhere in this module,
 * including on Windows. A path copied out of Explorer or a PowerShell prompt
 * names the same file and should be accepted as one.
 */
const toPosix = (p) => String(p).trim().split(String.fromCharCode(92)).join('/');

function readAllow() {
  try {
    return new Set(fs.readFileSync(allowFile(), 'utf8')
      .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
  } catch {
    return new Set();
  }
}

/**
 * What in this file looks like a credential.
 *
 * Binary files are not read: a font decoded as UTF-8 is megabytes of noise for
 * the rules to match against, and nothing that matches means anything.
 */
function inspect(buf) {
  if (buf.subarray(0, 8192).includes(0)) return [];
  return scan(buf.toString('utf8'));
}

/**
 * Copy the configuration into the vault, and remove what is no longer there.
 *
 * Only changed files are written: the hook runs this on every session start,
 * and rewriting a thousand identical files would put a thousand-file diff in
 * every commit.
 *
 * A file that looks like it holds a credential is left behind and reported.
 * If an earlier run copied it — before a rule existed, or before it had the
 * secret in it — it is taken back out of the vault. That only removes it from
 * the working tree; a commit that already contains it still does, and the
 * report says which files so the user can decide what that is worth.
 *
 * @param {{dryRun?: boolean, home?: string, dest?: string, allow?: Set<string>}} opts
 */
export function sync({ dryRun = false, home = claudeHome(), dest = configDir(), allow = null } = {}) {
  const wanted = collect(home);
  const allowed = new Set([...(allow || readAllow())].map(toPosix));
  const report = { added: [], changed: [], removed: [], skipped: [], unchanged: 0, bytes: 0 };

  for (const rel of wanted) {
    const from = path.join(home, rel);
    const to = path.join(dest, rel);
    let buf;
    try { buf = fs.readFileSync(from); } catch { continue; }

    if (!allowed.has(rel)) {
      const findings = inspect(buf);
      if (findings.length) {
        report.skipped.push({ file: rel, findings });
        if (!dryRun && fs.existsSync(to)) { try { fs.rmSync(to, { force: true }); } catch { /* already gone */ } }
        continue;
      }
    }

    // Counted after the skip: the size reported is the size of the copy, and
    // a held-back file is not in the copy.
    report.bytes += buf.length;

    const before = fs.existsSync(to) ? hashOf(fs.readFileSync(to)) : null;
    const after = hashOf(buf);
    if (before === after) { report.unchanged++; continue; }

    (before === null ? report.added : report.changed).push(rel);
    if (dryRun) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    // Written beside and renamed: an interrupted copy would otherwise leave a
    // half-file that the next run reads as "changed" forever.
    const tmp = to + '.tmp-' + process.pid;
    try {
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, to);
    } catch {
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    }
  }

  // Anything in the vault that is no longer in ~/.claude was deleted there,
  // and the snapshot should say so rather than keeping it forever.
  const have = new Set(wanted);
  for (const rel of existing(dest)) {
    if (have.has(rel)) continue;
    report.removed.push(rel);
    if (!dryRun) { try { fs.rmSync(path.join(dest, rel), { force: true }); } catch { /* gone already */ } }
  }
  return report;
}

/**
 * Put the configuration back.
 *
 * Refuses to overwrite anything by default. A restore usually runs on a fresh
 * machine where nothing is in the way, and the one time it does not, the file
 * in the way is this machine's live settings — which is not a thing to replace
 * because a flag was passed by habit. Conflicts are reported and skipped.
 *
 * With `force`, an existing file is copied to `<name>.before-arca-restore`
 * first. Overwriting settings.json wholesale is how a configuration gets lost,
 * and the copy is what makes it recoverable.
 *
 * @param {{dryRun?: boolean, home?: string, dest?: string, force?: boolean}} opts
 * @returns {{written: string[], conflicts: string[], identical: number, empty: boolean}}
 */
export function restore({ dryRun = false, home = claudeHome(), dest = configDir(), force = false } = {}) {
  const report = { written: [], conflicts: [], identical: 0, empty: false };
  const have = existing(dest);
  if (have.length === 0) { report.empty = true; return report; }

  for (const rel of have) {
    const from = path.join(dest, rel);
    const to = path.join(home, rel);
    let src;
    try { src = fs.readFileSync(from); } catch { continue; }

    if (fs.existsSync(to)) {
      let current = null;
      try { current = fs.readFileSync(to); } catch { /* unreadable counts as different */ }
      if (current && hashOf(current) === hashOf(src)) { report.identical++; continue; }
      if (!force) { report.conflicts.push(rel); continue; }
      if (!dryRun && current) {
        try { fs.writeFileSync(`${to}.before-arca-restore`, current); } catch { /* best effort */ }
      }
    }

    report.written.push(rel);
    if (dryRun) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const tmp = `${to}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tmp, src);
      fs.renameSync(tmp, to);
    } catch {
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    }
  }
  return report;
}

/**
 * How long to leave it alone.
 *
 * divine-set, which worked this out first, snapshotted at most once an hour.
 * The hook here runs on every session start, which on a working day is far
 * more often than that, and a full pass costs a second and a half to discover
 * that nothing changed. Anything the cooldown skips is still picked up by the
 * next run, and `arca config --sync` ignores it entirely.
 */
export const COOLDOWN_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Gitignored: two machines sync on their own schedules. */
export const stampFile = () => path.join(vaultDir(), '.arca', 'config-synced');

export function dueForSync({ now = Date.now(), cooldownMs = COOLDOWN_MS, dest = configDir() } = {}) {
  // A missing copy is due whatever the clock says — otherwise a vault whose
  // config directory was deleted would never rebuild it.
  let has = false;
  try { has = fs.statSync(dest).isDirectory(); } catch { /* not there */ }
  if (!has) return true;
  try {
    const age = now - fs.statSync(stampFile()).mtimeMs;
    // Two different futures. A stamp a fraction of a millisecond ahead is
    // an integer Date.now() minus a fractional mtime, and the sync really
    // did just happen, so it holds. A stamp a day ahead is a clock that
    // moved, the cooldown would last until the clock caught up, and the
    // honest answer is to go ahead.
    if (age < -DAY_MS) return true;
    return Math.max(age, 0) >= cooldownMs;
  } catch {
    return true;
  }
}

/**
 * Sync, unless it was done recently enough.
 *
 * @returns the usual report, or null when the cooldown said no.
 */
export function syncIfDue(opts = {}) {
  if (!dueForSync(opts)) return null;
  const report = sync(opts);
  if (!opts.dryRun) {
    try {
      const stamp = stampFile();
      fs.mkdirSync(path.dirname(stamp), { recursive: true });
      fs.writeFileSync(stamp, new Date().toISOString());
    } catch { /* a missed stamp costs one extra pass, nothing more */ }
  }
  return report;
}

/** What the vault currently holds, relative to the config directory. */
export function existing(dest = configDir()) {
  const out = [];
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), childRel);
      else if (e.isFile() && !e.name.includes('.tmp-')) out.push(childRel);
    }
  };
  walk(dest, '');
  return out.sort();
}
