# Changelog

Notable changes per release. Dates are the tag's date.

The version numbers are small and the releases are close together because
this was written quickly and corrected often; several of them exist only
because a review found something that had already shipped.

## 0.12.3 — 2026-10-11

### Changed

- **The index schema is renamed throughout.** The table is `turns`, not
  `exchanges`; the columns are `prompt_text`, `reply_text`, `transcript_path`,
  `first_line`, `last_line`, `branch`, `from_agent`, `tools_used`, `is_noise`,
  `prompt_class`, `body_hash` and `indexed_ms`; the derived layers key on
  `turn_id`; and `--mode` takes `semantic`, `keyword` or `hybrid` in place of
  `vector`, `text` and `both`.
- **Upgrading rebuilds the index, and the derived layers with it.** The index is
  derived and disposable, so a database from the previous layout has its turn,
  essence, entity and thread tables dropped when it is first opened: leaving
  them would have kept the old column names, and every write to them would then
  have failed. `arca index` refills the turns and their essence extracts;
  `build-entities.js`, `build-kg.js` and `build-threads.js` refill the rest.
  Nothing is searchable until the first of those finishes, and it embeds the
  whole corpus: minutes, not seconds.

### Added

- `lib/parser.test.js` and `lib/migration.test.js`. `parseTranscript` had no test
  of its own, which is how a rename inside it survived a fully green suite; and
  the upgrade path had none either, which is how the layout change shipped
  broken against any database that already existed.

### Fixed

- The published tarball includes `CHANGELOG.md` and `SECURITY.md`.
- The high and critical advisories reported against the lockfile are cleared.

## 0.12.2 — 2026-10-03

### Added
- `command/vault-maintenance.md` — what to do when the vault's git store grows
  out of proportion to the archive it holds. A vault that keeps every version of
  every transcript is always larger than its tree; the question is by how much.
  In one vault it was 241 GB against 8.3 GB, and the cause was a single session:
  892 MB, committed 580 times. `core.bigFileThreshold` defaults to 512m and git
  will not deltify above it, so every change cost the full size — 138 GB for one
  file's history. The command carries the diagnosis, a sample measurement to
  take before repacking hundreds of gigabytes on faith, and the batched repack
  that does the work safely: small windows on the oversized objects, a deep one
  on the rest, `prune-packed` after each batch so a run stopped by memory or a
  clock resumes where it left off. Five traps are named, all met on the way. It
  produced `.git` 241 → 61 GB, loose objects 150 GiB → 0, 3138 commits intact,
  free space 26 → 195 GB.
- Chunking large transcripts is recorded there as the cure that is not done: it
  needs a split and join that `restore` reverses exactly, and until that exists
  the archive stays as it is.

## 0.12.1 — 2026-10-02

### Fixed
- A claude.ai import no longer throws away the work a conversation produced. A
  message keeps its text in one place and its tool calls in another, and the
  importer read only the text: an artifact's HTML, a `create_file`'s body, every
  `str_replace` edit and every widget's code were dropped — while the rendered
  placeholder, "This block is not supported on your current device yet", was
  kept in their place. One export carried 1671 artifacts, 1186 edits and 607
  file writes across its 314 web conversations; 5687 tool calls in all. The
  export was complete the whole time and none of it reached the vault. Tool
  calls are rendered now, with `old_str` and `new_str` both kept so an edit can
  be replayed rather than only read, and the run reports how many it kept.
- A message whose text blocks are empty keeps its words. Twelve messages in one
  export hold the prose in `text` alone, and rendering the blocks dropped them.
- The vault path is resolved when the import runs, not when the module loads.
  Read once at startup, it could not be pointed at another home — which is also
  what the tests needed to run in a sandbox.

### Upgrading
Re-run the import to recover what earlier versions left behind: `arca import
<dir>`, then `arca index`. Only conversations whose content actually changes are
rewritten, so a second run over an unchanged export writes nothing. The vault
grows: an artifact-heavy conversation roughly doubles.

## 0.12.0 — 2026-09-24

### Added
- Session directories are archived. Claude Code keeps a directory beside each
  transcript — `subagents/` (including `subagents/workflows/wf_*/`), the
  `tool-results/` the transcript refers to, a `.meta.json` per agent — and
  deletes it along with the transcript. The hook copied the transcript and
  walked past the directory; on one working machine that left 1.8 GB outside
  the vault: 5881 files under `subagents/` and 1858 tool results. They are
  mirrored now, and `arca restore` brings a session's directory back with it,
  adding only what is missing and never replacing a live file.
- Subagent transcripts are indexed as sidechains. They were excluded
  everywhere on the reasoning that a sidechain is not a session — true for
  resuming, false for remembering: a delegated agent's conclusion reaches the
  main transcript, what it read and discarded does not. Search leaves them out
  unless asked: `--include-agents`, or `include_agents` on the MCP tool.
- `arca install --replace-hook` takes over a `session-vault` registration
  that belongs to something else. Without it an upgrade from the project
  this grew out of was silently partial: the MCP server appeared and the
  archiving stayed on the old code.

### Upgrading
The first session start after upgrading mirrors every existing session
directory: on a large vault that is minutes of copying and one large commit,
far past the 30 seconds a hook is given. It converges over later starts, but
slowly — a `git add` killed at the limit leaves a lock that is only broken
ten minutes later. Run the hook once by hand instead:

    node "$(npm root -g)/@ndokutovich/arca/hooks/session-vault.js"

After that, a start walks only the directories of sessions that moved, plus a
full walk once a day.

### Fixed
- Each machine keeps its own config snapshot, under `config/<machine-id>/`.
  One shared directory made the snapshot a fight rather than a backup: each
  machine's sync deleted what the other had, and a restore handed you
  whichever machine had started a session last. A vault with the old flat
  layout is moved under this machine on its next sync.
- A sync that cannot read `~/.claude` changes nothing. It used to collect
  zero files and prune the snapshot to match — deleting all of it in one
  silent pass, from a hook that runs at every session start.

### Changed
- Publishing goes through npm trusted publishing (OIDC) alone. The stored
  token expired and held this release back; there is none to expire now.
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
