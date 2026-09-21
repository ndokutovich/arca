# Changelog

Notable changes per release. Dates are the tag's date.

The version numbers are small and the releases are close together because
this was written quickly and corrected often; several of them exist only
because a review found something that had already shipped.

## Unreleased

### Added
- Subagent sidechains (`agent-*.jsonl`) are archived and indexed. They were
  excluded everywhere on the reasoning that a sidechain is not a session —
  true for resuming, false for remembering. A delegated agent's conclusion
  reaches the main transcript; what it read and discarded does not. Search
  leaves them out unless asked: `--include-agents`, or `include_agents` on
  the MCP tool.
- `arca install --replace-hook` takes over a `session-vault` registration
  that belongs to something else. Without it an upgrade from the project
  this grew out of was silently partial: the MCP server appeared and the
  archiving stayed on the old code.

### Changed
- Publishing uses OIDC trusted publishing rather than a stored npm token.
- The thread map shortens project names by the prefix the projects actually
  share, instead of by one machine's directory layout.

## 0.11.0 — 2026-09-21

### Added
- `arca stats` reports what Claude Code still holds and what has gone missing
  since the last sample. The setting meant to stop the deletion is ignored
  upstream, so the boundary is measured rather than asserted.
- A LongMemEval harness for retrieval quality, resumable across runs.

### Fixed
- The skill routed to three tools and there are nineteen.

## 0.10.1 — 2026-09-20

### Fixed
- Documentation credited a reference in the wrong place.

## 0.10.0 — 2026-09-19

### Added
- The config vault: `~/.claude` — commands, agents, skills, hooks, settings —
  is snapshotted into the vault alongside the transcripts, so a machine can be
  rebuilt and not just remembered. Credentials are held back.

### Fixed
- Six defects a review found in the config layer, each confirmed by
  measurement before the fix.

## 0.9.1 — 2026-09-19

### Fixed
- Credit for the three projects arca was built from.

## 0.9.0 — 2026-09-19

### Added
- Other assistants: Codex, OpenCode, Gemini CLI, Cline, Cursor, and
  Antigravity, whose replies are documents rather than messages.
- `arca sources` chooses which of them to read.

## 0.8.0 — 2026-09-19

### Added
- Prompts are recovered from `~/.claude/history.jsonl`, which outlives the
  transcripts: a question survives even when the session that answered it
  has been deleted.
- Each session records the machine it came from.

### Fixed
- The pack limits are applied to vaults that already exist — an existing
  vault is exactly the one already in the state they prevent.
- Git is optional, and two reasons the hook never ran on Windows.
- Model weights no longer enter the vault's git history.

## 0.7.0 — 2026-09-19

### Changed
- `better-sqlite3` replaced by Node's built-in SQLite. A native module
  compiled against one Node version stops loading on the next, which is how
  the MCP server died after a routine upgrade.

## 0.6.0 — 2026-09-19

### Fixed
- Eight rounds of it: `--full` reconciles rather than appends, tool
  annotations stop overstating, the importer admits truncation, writes are
  atomic, a fork point is really a fork point, large reads fit in memory, the
  hook's indexing chain runs in order, and the three input-boundary holes an
  outside review found are closed.

## 0.5.1 — 2026-09-18

### Fixed
- The thread map UI, and the library's Russian is documented rather than
  surprising.

## 0.5.0 — 2026-09-18

### Changed
- The review findings closed before the repository went anywhere.

## 0.4.0 — 2026-09-18

### Added
- `arca import` for Claude.ai exports, and `arca resurrect` for sessions
  Claude Code can no longer open.

## 0.3.0 — 2026-09-18

### Changed
- Node 22+, current dependencies, no deprecations and no advisories.

## 0.2.1 — 2026-09-18

### Fixed
- The SessionStart hook never ran: it was CommonJS in a package declaring
  `"type": "module"`. It threw on its first line at every session start,
  Claude Code swallowed the failure, and the vault stayed empty while the
  MCP server, the CLI and the index all reported healthy. `node --check`
  passed the whole time.

## 0.2.0 — 2026-09-17

### Added
- Session restoration, installation into Claude Code, and an externalised
  gazetteer.

## 0.1.0 — 2026-09-17

First release: the vault, the hook that fills it, the index, and search.
