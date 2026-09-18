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

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

/** Add the SessionStart hook if an identical command is not already registered. */
function planHook(settings) {
  const cmd = hookCommand();
  const hooks = settings.hooks || {};
  const starts = hooks.SessionStart || [];
  const already = starts.some((block) =>
    (block.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes('session-vault.js'))
  );
  if (already) return { changed: false, settings };

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
  if (current && JSON.stringify(current.args) === JSON.stringify(desired.args)) {
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

  const settings = readJson(SETTINGS) || {};
  const hookPlan = planHook(settings);
  if (hookPlan.changed) {
    report.settings = 'hook registered';
    if (!dryRun) {
      const b = backup(SETTINGS);
      if (b) report.backups.push(b);
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
      writeJson(MCP_CONFIG, mcpPlan.config);
    }
  }

  for (const job of planSurface()) {
    const same = fs.existsSync(job.to) && fs.readFileSync(job.to, 'utf8') === fs.readFileSync(job.from, 'utf8');
    if (same) continue;
    report.files.push(path.relative(CLAUDE_DIR, job.to));
    if (!dryRun) {
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
