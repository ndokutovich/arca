# Arca

*A vault for everything Claude Code throws away.*

Episodic memory for Claude Code. It archives your session transcripts, indexes them,
and serves them back through MCP — so a new session can recall what earlier ones
decided, and why.

Claude Code writes every session to `~/.claude/projects/` as JSONL and never reads it
again. Compaction throws away the conversation the current session can no longer hold.
This keeps that history, in git, and makes it searchable.

Everything runs locally. Embeddings are computed on your machine; nothing is sent
anywhere.

## What it gives you

Four layers, each answering a different question, built from the same transcripts:

| Layer | Question it answers |
|---|---|
| **Search** | "Have I solved this before?" — hybrid vector + FTS5 over every exchange |
| **Essence** | "What was decided?" — decisions, constraints, tensions and anti-patterns, extracted |
| **Entities** | "Where else does this appear?" — tools, tech and concepts ranked by how many projects they span |
| **Threads** | "Where did this line of thought go?" — topic clusters linked across sessions |

Plus a small temporal knowledge graph (`x runs_on_port 3001` *since* a date), so
"what port was that on in April?" has an answer.

## Install

Requires Node 22+ and a C toolchain for the native modules.

```bash
git clone https://github.com/ndokutovich/arca.git
cd arca
npm install
```

**First run downloads an embedding model** (`@huggingface/transformers`, about 80 MB) into its own cache. It happens once, it takes a while, and nothing works until it
finishes.

**The native modules are the fragile part.** `better-sqlite3` and `sqlite-vec` compile
against your platform. On Windows this means Visual Studio Build Tools; on Linux,
`build-essential` and `python3`. If `npm install` fails, it will be here, and the error
will name one of those two packages.

## Use

```bash
node indexer.js              # index new exchanges (incremental, safe to re-run)
node indexer.js --full       # re-index everything from scratch
node build-entities.js       # rebuild the entity layer
node build-kg.js             # rebuild the knowledge graph
node build-threads.js        # rebuild topic threads
node build-thread-map.js     # render threads to an interactive thread-map.html
node cli.js search "query"   # search from the shell
node cli.js restore          # sessions Claude Code no longer has
node cli.js install          # register with Claude Code
```

Run the three `build-*` scripts **in that order and one at a time** — they each rewrite
whole tables, and running them against a live indexer will collide on the write lock.

## Restore a session Claude Code lost

This is the part nothing else does.

`~/.claude/projects/` is not permanent. Sessions vanish from it — cleanup, a
reinstall, a new machine — and once they are gone `claude --resume` cannot offer
them. The vault still has them. On the corpus this was built against, **four out
of five archived sessions exist only in the vault**.

```bash
arca restore                 # what the vault has and Claude Code does not
arca restore <session-id>    # put one back where Claude Code reads it
```

A restore copies the transcript, byte for byte, into
`~/.claude/projects/<project>/<id>.jsonl`. Nothing is rewritten. The session
reappears in `claude --resume` for that project and the work continues where it
stopped.

Two things it is careful about. It will not overwrite a live transcript without
`--force`, because the live copy may hold turns the archive never saw. And it
reports the file size, because the resume parser struggles past ~50 MB — for a
transcript that large, fork it from its last compact boundary instead.

Conversations imported from claude.ai are left out of the listing: they index and
search like everything else, but they were never Claude Code sessions, so
offering to resume one would be offering something that never existed. Name one
explicitly if you want it back anyway.

## Wire it up

```bash
arca install             # register the hook, the MCP server, the skills
arca install --no-seed   # skip the one-time backfill of existing sessions
arca install --dry-run   # show what it would change, write nothing
```

The installer merges: it adds only its own entries, backs up
`~/.claude/settings.json` and `~/.claude.json` before touching either, and does
nothing the second time. It never rewrites those files wholesale — they hold
your permissions, environment and every other hook.

If you would rather wire it by hand, the two pieces are these.

**The hook** keeps the archive current. `hooks/session-vault.js` runs on `SessionStart`:
it copies new and changed session files into `~/.claude-vault/`, commits them, and kicks
off incremental indexing. Register it in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "", "hooks": [
        { "type": "command", "command": "node /path/to/arca/hooks/session-vault.js" }
      ]}
    ]
  }
}
```

Set `ARCA_HOME` to the checkout if the hook lives elsewhere. It logs failures to
`~/.claude-vault/vault.log` rather than failing silently — worth watching the first few
sessions.

**The MCP server** exposes 18 tools to Claude Code — search, essence, entities, KG,
threads, observations. In `~/.claude.json`:

```json
{
  "mcpServers": {
    "arca": {
      "command": "node",
      "args": ["/path/to/arca/mcp-server.js"]
    }
  }
}
```

`skill/SKILL.md` and `agent/search-conversations.md` are installable Claude Code
surfaces for the same thing, if you prefer a skill over an MCP server.

## Your own names

The entity layer ships with a generic list of tools and technologies. Your own
projects, tools and people go in `~/.claude-vault/gazetteer.json`:

```json
{ "peon-ping": "tool", "hexcrawl": "concept", "ada": "person" }
```

Types are `tech`, `tool`, `person`, `concept`. Entries live in your vault, not in
the package, so upgrades never clobber them. Set `ARCA_GAZETTEER` to keep the
file somewhere else.

One caution: an entry qualifies an entity on a single mention. A distinctive
name earns its place; a common word like `carrier` will tag every ordinary use of
it across your whole corpus.

## Where things live

```
~/.claude/projects/     source transcripts, written by Claude Code
~/.claude-vault/        the archive — a git repo, one dir per project
~/.claude-vault/index/  vault.db (SQLite + sqlite-vec + FTS5)
~/.claude-vault/vault.log
```

The archive is a normal git repository. Back it up, push it somewhere private, or
`git log` it like anything else.

## Importing claude.ai history

A claude.ai data export can be folded into the same index:

```bash
node import-claude-ai.js /path/to/export-dir
```

It takes the directory of zips the export arrives as, converts each conversation into
the JSONL shape Claude Code writes, and drops them into the archive — so the same
parser, indexer and layers handle them with no special cases. Re-running on a fresh
export only writes what changed. Rows carry `source = 'claude_ai'` to keep them
distinguishable.

## Tests

```bash
npm test
```

24 tests over the parsing, entity, KG and thread layers. No network, no database.

## Scale

For reference, a corpus of ~25,600 exchanges across 114 projects and ~5,000 transcript
files produces a ~330 MB database, with ~58,000 essence extracts, ~9,600 entities and
~127 threads on top of it. Incremental indexing of a single new session is a second or
two; a full re-index of that corpus is a coffee break, dominated by embedding.

## Name

*Arca* is Latin for chest, strongbox, coffer — the word `archive` descends from it
(arca → archivum), and so does `ark`: the vessel that carries everything through the
flood and out the other side. That is the job. Claude Code discards its transcripts at
every boundary; this keeps them, and hands back what they turn out to contain.

## License

MIT.
