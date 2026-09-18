// Register arca with Claude Code: the SessionStart hook, the MCP server, and
// the skill/command/agent surface.
//
// This edits two files a person's whole setup depends on — ~/.claude/settings.json
// and ~/.claude.json — so it works by surgical merge, never by rewriting. Each
// file is backed up before it is touched, only arca's own entries are added,
// and running twice changes nothing the second time. A wholesale write here
// would take someone's permissions, env and every other hook with it.
import fs from 'fs';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const MCP_CONFIG = path.join(HOME, '.claude.json');

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const hookCommand = () => `node "${path.join(PKG_ROOT, 'hooks', 'session-vault.js')}"`;
const mcpArgs = () => [path.join(PKG_ROOT, 'mcp-server.js')];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error(`${file} is not readable JSON (${e.message}) — fix or move it before installing`);
  }
}

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${file}.arca-backup-${stamp}`;
  fs.copyFileSync(file, dest);
  return dest;
}

// A direct write can truncate on a crash or a full disk, and these two files
// hold every permission, hook and server the user has. Write a sibling, flush
// it, then rename — rename is the only step that is atomic.
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.arca-tmp-${process.pid}`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, `${JSON.stringify(data, null, 2)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already gone */ } }
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw e;
  }
}

/** Restore a file from the copy taken before it was touched. */
function rollback(file, backupPath) {
  if (!backupPath) return;
  try { fs.copyFileSync(backupPath, file); } catch { /* the backup is still on disk */ }
}

/** Add the SessionStart hook if an identical command is not already registered. */
function planHook(settings) {
  const cmd = hookCommand();
  const hooks = settings.hooks || {};
  const starts = hooks.SessionStart || [];
  // Matching on "contains session-vault.js" meant a registration left behind by
  // an older or moved copy counted as ours and was reported unchanged, so the
  // hook kept pointing at an executable that no longer exists. Match exactly,
  // and repoint anything that is ours but stale.
  // "Ours" means it points into this package — not merely that it mentions
  // session-vault.js. Another installation of this hook, or the copy someone
  // vendored into their own hooks directory, belongs to them; repointing it at
  // us would hijack a working setup that happens to share a filename.
  const ourRoot = PKG_ROOT.split(String.fromCharCode(92)).join('/');
  const isOurs = (h) => typeof h.command === 'string'
    && h.command.split(String.fromCharCode(92)).join('/').includes(ourRoot);
  const isForeign = (h) => typeof h.command === 'string'
    && h.command.includes('session-vault.js') && !isOurs(h);
  const foreign = starts.flatMap((block) => (block.hooks || []).filter(isForeign));
  const ours = starts.flatMap((block) => (block.hooks || []).filter(isOurs));
  // Someone else already archives sessions here. Adding a second hook would
  // double the work and the commits; say so and change nothing.
  if (!ours.length && foreign.length) {
    return { changed: false, settings, stale: false, foreign: foreign[0].command };
  }
  if (ours.length && ours.every((h) => h.command === cmd)) {
    return { changed: false, settings, stale: false };
  }
  if (ours.length) {
    const repointed = starts.map((block) => ({
      ...block,
      hooks: (block.hooks || []).map((h) => (isOurs(h) ? { ...h, command: cmd, timeout: h.timeout ?? 30 } : h)),
    }));
    return { changed: true, stale: true, settings: { ...settings, hooks: { ...hooks, SessionStart: repointed } } };
  }

  const next = {
    ...settings,
    hooks: {
      ...hooks,
      SessionStart: [...starts, { matcher: '', hooks: [{ type: 'command', command: cmd, timeout: 30 }] }],
    },
  };
  return { changed: true, settings: next };
}

/** Point an `arca` MCP server at this checkout. */
function planMcp(config) {
  const servers = config.mcpServers || {};
  const desired = { command: 'node', args: mcpArgs() };
  const current = servers.arca;
  if (current && current.command === desired.command
      && JSON.stringify(current.args) === JSON.stringify(desired.args)) {
    return { changed: false, config };
  }
  return {
    changed: true,
    config: { ...config, mcpServers: { ...servers, arca: desired } },
  };
}

/** Copy the skill/command/agent surface into ~/.claude/. */
function planSurface() {
  const jobs = [];
  for (const [src, destDir] of [
    ['command', path.join(CLAUDE_DIR, 'commands')],
    ['agent', path.join(CLAUDE_DIR, 'agents')],
    ['skill', path.join(CLAUDE_DIR, 'skills')],
  ]) {
    const from = path.join(PKG_ROOT, src);
    if (!fs.existsSync(from)) continue;
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        jobs.push({ from: path.join(from, entry.name), to: path.join(destDir, entry.name) });
      } else if (entry.isDirectory()) {
        for (const f of fs.readdirSync(path.join(from, entry.name))) {
          jobs.push({
            from: path.join(from, entry.name, f),
            to: path.join(destDir, entry.name, f),
          });
        }
      }
    }
  }
  return jobs;
}

/**
 * Install (or report what installing would do).
 * Returns a summary rather than printing, so the CLI owns presentation.
 */
export function install({ dryRun = false, seed = true } = {}) {
  const report = { dryRun, backups: [], settings: 'unchanged', mcp: 'unchanged', files: [], root: PKG_ROOT, seeded: null };

  let settingsBackup = null;
  const settings = readJson(SETTINGS) || {};
  const hookPlan = planHook(settings);
  if (hookPlan.foreign) report.settings = `left alone — another session-vault hook is registered: ${hookPlan.foreign}`;
  if (hookPlan.changed) {
    report.settings = hookPlan.stale ? 'hook repointed' : 'hook registered';
    if (!dryRun) {
      settingsBackup = backup(SETTINGS);
      if (settingsBackup) report.backups.push(settingsBackup);
      writeJson(SETTINGS, hookPlan.settings);
    }
  }

  const config = readJson(MCP_CONFIG) || {};
  const mcpPlan = planMcp(config);
  if (mcpPlan.changed) {
    report.mcp = config.mcpServers?.arca ? 'mcp server repointed' : 'mcp server registered';
    if (!dryRun) {
      const b = backup(MCP_CONFIG);
      if (b) report.backups.push(b);
      try {
        writeJson(MCP_CONFIG, mcpPlan.config);
      } catch (e) {
        // settings.json already changed; leaving half an install behind is
        // worse than leaving none, so put the first file back.
        rollback(SETTINGS, settingsBackup);
        throw e;
      }
    }
  }

  for (const job of planSurface()) {
    const same = fs.existsSync(job.to) && fs.readFileSync(job.to, 'utf8') === fs.readFileSync(job.from, 'utf8');
    if (same) continue;
    report.files.push(path.relative(CLAUDE_DIR, job.to));
    if (!dryRun) {
      // These destinations are generic — commands/last-session.md is a name
      // anyone might already own. Overwriting one without a copy alongside it
      // destroys a customisation with no way back.
      if (fs.existsSync(job.to)) {
        const b = backup(job.to);
        if (b) report.backups.push(b);
      }
      fs.mkdirSync(path.dirname(job.to), { recursive: true });
      fs.copyFileSync(job.from, job.to);
    }
  }

  // The hook only fires at SessionStart, so a fresh install leaves the vault
  // empty until Claude Code is restarted — while the MCP server and CLI already
  // report healthy. Run it once now so `arca stats` means something immediately.
  if (!dryRun && seed) {
    try {
      execFileSync(process.execPath, [path.join(PKG_ROOT, 'hooks', 'session-vault.js')], {
        input: JSON.stringify({ session_id: 'arca-install', hook_event_name: 'SessionStart' }),
        timeout: 120000,
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      report.seeded = 'vault seeded from existing sessions';
    } catch (e) {
      report.seeded = `initial seed failed: ${(e && e.message) || e}`;
    }
  }

  return report;
}
