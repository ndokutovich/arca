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

Requires Node 22.13+. There is no compiler step: SQLite comes from Node
itself, and the two remaining native pieces ship prebuilt binaries.

```bash
git clone https://github.com/ndokutovich/arca.git
cd arca
npm install
```

Three dependencies. `npm install` pulls about 315 MB, nearly all of it the
ONNX runtime, which ships every platform's binaries in one package.

**First run downloads the embedding model** — all-MiniLM-L6-v2, about 90 MB,
into `~/.claude-vault/models/`. It happens once, the files are checksum-pinned,
and nothing works until it finishes. It sits with the rest of the vault rather
than inside `node_modules`, so upgrading arca does not throw it away.

**Nothing here compiles.** SQLite is Node's own `node:sqlite`; `sqlite-vec` and
the ONNX runtime ship prebuilt binaries. No node-gyp, no Python, no toolchain.

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
node cli.js resurrect        # sessions resume cannot open
node cli.js import <dir>     # fold in a claude.ai export
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

## Resurrect a session Claude Code cannot open

The other way a session is lost. The transcript is still there and still
intact, but resume refuses it — the file grew past what the parser will read,
or its schema drifted across a CLI upgrade. The failure is quiet and easy to
misread: resume appears to work, and you get a session with no memory of
anything, appending turns to a history it never loaded.

```bash
arca resurrect               # transcripts big enough to trouble the parser
arca resurrect <id>          # fork one from its last compact boundary
arca resurrect <id> --dry-run
```

The fork follows the parser's own logic. On resume it finds the last
`compact_boundary`, injects the synthetic summary that follows it as the
conversation's memory, and replays the rest. Everything before that boundary
was already discarded when `/compact` ran — forking does not lose it, the
compact did. So the fork keeps every turn resume would have used, drops only
what it would have ignored, and lands in a file small enough to open.

The original is never touched. The fork gets a new id and every record is
retagged to it, so the file agrees with its own name.

## Wire it up

```bash
arca install             # register the hook, the MCP server, the skills
arca install --no-seed   # skip the one-time backfill of existing sessions
arca install --dry-run   # show what it would change, write nothing
```

The installer merges: it adds only its own entries, writes through a
temporary file and a rename so an interrupted write cannot truncate anything,
backs up
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

## It reads more than English

The layers that classify and extract work on Russian as well as English, because
that is what the corpus they were built against looks like. Prompt
classification recognises Russian go-aheads and approvals; essence extraction
picks up decisions and constraints phrased in Russian; and the word-boundary
helper exists because JavaScript's `\b` does not treat Cyrillic as word
characters, so a naive `\bдавай\b` silently matches nothing.

Nothing is English-only by design — but nothing else is deliberately supported
yet either. Another language needs its own patterns in `lib/control.js` and
`lib/essence.js`; the machinery around them is language-agnostic.

## Platforms, and the ARM footnote

Both native pieces — `sqlite-vec` and the ONNX runtime behind the embeddings —
ship linux-arm64 binaries, so a Raspberry Pi, an OrangePi or an ARM server is a
supported target rather than a curiosity.

What trips it up is glibc, not the architecture. The floor, read off the
shipped binaries rather than off a changelog:

| binary | needs |
|---|---|
| `sqlite-vec` `vec0.so` | glibc 2.17 |
| `onnxruntime_binding.node` | glibc 2.17 on arm64, 2.14 on x64 |
| `libonnxruntime.so.1` | **glibc 2.28** |

So 2.28 — Debian 10, Ubuntu 18.10, anything from 2019 on. Armbian's Debian 11
and 12 images clear it comfortably.

It used to be 2.34, and the failure was an unreadable loader error deep inside
a dependency. `better-sqlite3` wanted that, and `@huggingface/transformers`
brought an image-processing library that loaded a native binary on every
embedding — of text. Both are gone.

One honest expectation: embeddings run on the CPU through ONNX, and a
single-board computer will index at a fraction of a laptop's pace. Search,
restore and resurrect are unaffected — they touch no model at all.

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
arca import /path/to/export-dir
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

44 tests over the parsing, entity, KG and thread layers. No network, no database.

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
