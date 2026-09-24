# Arca

*A vault for everything Claude Code throws away.*

It archives your session transcripts, indexes them, and serves them back through
MCP — so a new session can recall what earlier ones decided, and why.

Claude Code writes every session to `~/.claude/projects/` as JSONL and never reads it
again. Compaction throws away the conversation the current session can no longer hold.
Cleanup throws away the file. This keeps both, in git, and makes them searchable.

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

And three kinds of recovery, which are the part nothing else does:

| | |
|---|---|
| `arca restore` | sessions Claude Code no longer has |
| `arca resurrect` | sessions `--resume` cannot open |
| `arca prompts` | questions whose session is gone entirely |

## Quickstart

```bash
npm install -g @ndokutovich/arca
arca install
arca prompts --import
```

`arca install` registers the SessionStart hook, the MCP server and the skills,
and archives what you already have. `arca` on its own lists everything else.

Requires Node 22.13+.

## Install from source

```bash
git clone https://github.com/ndokutovich/arca.git
cd arca
npm install
```

Three dependencies, 116 packages, about 315 MB — nearly all of it the ONNX
runtime, which ships every platform's binaries in one package.

**Nothing here compiles.** SQLite is Node's own `node:sqlite`; `sqlite-vec` and
the ONNX runtime ship prebuilt binaries. No node-gyp, no Python, no toolchain.

**First run downloads the embedding model** — all-MiniLM-L6-v2, about 90 MB,
into `~/.claude-vault/.cache/models/`. It happens once, both files are
checksum-pinned, and nothing works until it finishes. It lives outside
`node_modules`, so upgrading arca does not throw it away, and outside git, so
it never reaches a remote.

## Commands

```bash
arca                      # what all of this is
arca help <command>       # and what one of them does

arca search "query"       # hybrid search; two or more queries is an AND
arca prompts "query"      # search what you typed, session or no session
arca read <path>          # print a conversation as markdown
arca stats                # what the vault and the index hold

arca index                # fold new exchanges in (incremental, safe to re-run)
arca index --full         # rebuild from every archive, and reconcile

arca restore              # sessions Claude Code no longer has
arca resurrect            # transcripts resume cannot open
arca import <dir>         # fold in a claude.ai export
arca sources              # history from other assistants
arca machines             # which machine each session came from
arca config               # keep the agents, skills and settings too
arca install              # register with Claude Code
```

The derived layers rebuild with `build-entities.js`, `build-kg.js` and
`build-threads.js`, **in that order and one at a time** — each rewrites whole
tables, and running them against a live indexer collides on the write lock. The
hook runs them in order for you through `hooks/pipeline.js`.
`build-thread-map.js` renders threads to an interactive `thread-map.html`.

## The MCP tools

Nineteen, all read-only unless noted.

**Finding things**

| Tool | For |
|---|---|
| `search` | hybrid vector + FTS5 over every exchange; 2-5 concepts for an AND |
| `read` | one conversation in full, with line-range pagination |
| `prompt_search` | every prompt ever typed, including where the session is gone |
| `essence_search` | only decisions, constraints, tensions, anti-patterns (~5% of the corpus) |
| `stats` | counts across every layer |

**Entities — what threads through the work**

| Tool | For |
|---|---|
| `entity_search` | one named thing's footprint: which projects, how often, first and last seen |
| `entity_profile` | everything ranked by how many projects it spans |

**Knowledge graph — facts with a validity window**

| Tool | For |
|---|---|
| `kg_query` | facts about a subject, optionally *as of* a date |
| `kg_timeline` | how those facts changed, oldest first |
| `kg_add` | record one *(writes)* |
| `kg_invalidate` | mark one no longer true *(writes)* |

**Observations — things worth keeping deliberately**

| Tool | For |
|---|---|
| `observation_add` | record a typed learning: discovery, decision, gotcha, trade-off, bugfix *(writes)* |
| `observation_search` | hybrid search over them |
| `observation_index` | a cheap list — id, type, title, date — for priming a session |

**Threads — a storyline across sessions**

| Tool | For |
|---|---|
| `thread_list` | threads by session reach; `return_count` says how often you came back |
| `thread_search` | find the thread for a topic |
| `thread_detail` | walk one thread's segments in order, across every session |

**You, as an operator**

| Tool | For |
|---|---|
| `operator_profile` | the distribution of your prompt kinds — trust versus correction, flow versus polling |
| `recent_status_pings` | "what was I waiting on" — recent pokes at in-flight work |

## Restore a session Claude Code lost

`~/.claude/projects/` is not permanent. Sessions vanish from it — cleanup, a
reinstall, a new machine — and once they are gone `claude --resume` cannot offer
them. The vault still has them. On the corpus this was built against, **three out
of four archived sessions exist only in the vault** — 4,246 of 5,769.

```bash
arca restore                 # what the vault has and Claude Code does not
arca restore <session-id>    # put one back where Claude Code reads it
```

A restore copies the transcript, byte for byte, into
`~/.claude/projects/<project>/<id>.jsonl`, and puts back whatever is missing from
the session directory beside it — subagents, tool results. Nothing is rewritten,
and no file already there is replaced. The session
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

## Prompts whose session is gone

The deepest recovery, and the cheapest. Claude Code keeps every prompt you have
ever typed in `~/.claude/history.jsonl` — outside the per-project transcripts,
and outliving them. So it still holds the questions from sessions deleted before
you installed any of this.

```bash
arca prompts --import        # archive new entries and index them
arca prompts "query"         # search them
arca prompts "q" --orphans   # only the ones with no session left
```

On the corpus this was built against: 30,247 prompts back to September 2025, of
which **15,174 have no surviving session** — everything before the vault existed
is simply gone in every other form.

A prompt counts as surviving if the index holds the exchange it opened, or any
exchange from the same project within half an hour. Text alone is not enough: a
slash command is stored in the transcript expanded, not as the seven characters
you typed, so `/effort` would look lost while its whole session sat in the vault.

The file is never copied wholesale — Claude Code rewrites it in place, and a
plain copy would add a 10 MB blob to the vault on every commit. Only entries past
the stored watermark are appended.

## More than one assistant

The engine underneath arca never knew what Claude Code was. It takes text and
gives back ranked text; only the way in was Claude-shaped.

A source adapter finds another assistant's sessions and converts them into the
same archive format, so search, essence, entities and threads all see them with
no special case anywhere below.

```bash
arca sources                     # what is on this machine, and what is read
arca sources --select            # a checklist: present ones on, absent greyed
arca sources --enable codex      # or decide from a script
arca sources --import --dry-run  # counts, nothing written
arca sources --import            # fold them in
arca index                       # then index as usual

arca search "glibc"              # everything, provenance shown per result
arca search "glibc" --source codex
```

Which assistants get read is your decision and it is remembered, in
`~/.claude-vault/.arca/sources.json`. It is deliberately not committed: two
machines hold different assistants and can want different answers. Until you
choose, everything detected is read — `--import` is already an explicit
instruction, and refusing to act on it until a second command has been run
would be a riddle rather than a safeguard. The first interactive `--import`
asks before it reads anyone's history.

Claude Code is in the listing and has no adapter, on purpose. The hook copies
its transcripts **byte for byte**, and that is exactly what lets `arca restore`
hand one back to `claude --resume`. An adapter would read them into turns and
write them out again, losing the tool calls, the sidechains and the precise
bytes — two paths writing the same files, the second quietly breaking the
first.

Imported sessions land in the **same project directory** as the Claude Code
sessions run in the same place, because they are the same project — and the
entity and thread layers are better for seeing both halves of the work. They
mix into ordinary search; a result from another assistant is labelled, one from
Claude Code is not, so a single-source vault reads exactly as it did.

`arca restore` never offers them. A session that was not a Claude Code session
cannot be resumed as one.

| adapter | verified against |
|---|---|
| `codex` | a real 3.3 GB corpus, 453 sessions |
| `opencode` | a real corpus, 120 sessions across 11,167 files |
| `gemini` | a real corpus, 10 sessions |
| `antigravity` | a real corpus, 2 sessions |
| `cline` | a real corpus, 2 tasks |
| `cursor` | a real corpus, 3 conversations |

Antigravity is the one that is not a translation. It never writes its replies
to disk — its transcript holds the request, the model's private reasoning and
every tool call, and nothing else — so what gets paired with a request is what
the session produced: its walkthrough, plan, task list and code review. The
reasoning is never passed off as the reply, and a session that kept its
documents but no transcript gets a line that reads as a label rather than an
invented question.

Three more are known and not yet written: Aider, ForgeCode, and Claude Code
itself as an explicit adapter. None of them has data on the machine this was
built against, so each will be built from the format and marked as such. An adapter that has
never been run against a real file says so in `arca sources`, because a parser
built from a format description is a claim, not a result — and Gemini is the
reason that matters: its own shipped fixtures describe a message shape the CLI
does not write, and an adapter built from them reads every real session as
empty while reporting success.

## More than one machine

The vault is a git repository, so a second machine folds in with a pull. What a
pull cannot work out is which machine a session came from — and project
directories are named after filesystem paths, so the same directory name on two
machines may be one project or two unrelated ones.

Nothing is renamed and nothing is merged away to resolve that. Each machine
writes one append-only manifest naming the sessions it produced, and only ever
its own file, so two vaults merge with no conflict and the question keeps an
answer.

```bash
arca machines            # who has written here, and what they own
arca machines --adopt    # claim every session no manifest covers yet
```

**Adopt on each machine before you add a remote.** Afterwards, sessions pulled
from elsewhere are indistinguishable from your own, and adopting would put your
name on them. A session another machine has claimed is never taken.

`arca stats` then breaks down by machine and names the project names that appear
on more than one. That is not a warning — it is an ambiguity that used to be
invisible.

## The toolbox, not just the talk

A transcript says what was done. It does not say what it was done with.

Restore a session from six months ago and it will reference an agent you
deleted, a skill you renamed, a hook that no longer fires. The words survive and
the machinery around them does not, which makes the words progressively harder
to read. On a new machine it is worse: the session restores perfectly into an
environment that never had any of it.

So the vault keeps a copy of `~/.claude` too.

```bash
arca config                 # what would be copied, and what is held back
arca config --sync          # copy it now
arca config --restore       # write it back, on this machine or another
arca config --scan          # look for credentials across the whole vault
```

It rides in the same git repository as the transcripts, which is the whole
trick: a snapshot is a commit, the history is `git log`, going back is
`git checkout`, and a second machine gets it with `git pull`. None of that had
to be built.

| kept | not kept |
|---|---|
| `CLAUDE.md`, `settings.json`, statusline | anything that looks like a credential |
| `agents/`, `commands/`, `skills/`, `hooks/` | `node_modules/` vendored inside a skill |
| the plugin list | the skills Claude Code downloads for itself |
| `projects/*/memory/` — what Claude learned about each project | audio, logs, `.env` |
| | `plans/`, `tasks/`, `todos/` — session state, not configuration |

That last exclusion is not fastidiousness. `todos/` alone is 14,257 files on the
machine this was written on, of which 188 hold anything, and every session start
churns them. The whole capture as it stands is about 1,800 files and 10 MB, and
only what changed goes into a commit.

The `SessionStart` hook does this for you, at most once an hour — a full pass
costs a second and a half to discover that nothing moved. `arca config --sync`
ignores the cooldown.

### Credentials

A vault is a git repository, and the point of a git repository is that it can be
pushed somewhere. So nothing is copied without being read first.

```
4 file(s) held back — they look like they hold a credential:
  projects/w--app/memory/project_v8_launch_state.md
      line    77  prefixed   github-pat           github...(93 chars)
      line    75  prefixed   huggingface-token    hf_oEC...(37 chars)
```

Rules come in two kinds. A **prefixed** rule matches an issued credential by the
shape its issuer gave it — `ghp_`, `hf_`, `AKIA`, `sk-ant-` — and is near
enough to certain. A **contextual** rule matches a long opaque string next to a
word like `password`, which is a guess, and says so. Findings are reported
masked: a scanner that echoes what it caught has published it twice.

To keep a file anyway, put its path in `~/.claude-vault/.arca/config-allow`.

`arca config --scan` points the same rules at the entire vault, transcripts
included. **Run it before adding a git remote.** A key printed into a terminal
during a session is in the archive verbatim, and no amount of care taken since
has removed it.

### Restoring

`--restore` refuses to overwrite anything. On a fresh machine nothing is in the
way; the one time something is, it is that machine's live `settings.json`, which
is not a file to replace because a flag was passed out of habit. Conflicts are
listed and skipped. `--force` replaces them and keeps each previous file as
`<name>.before-arca-restore`.

## Wire it up

```bash
arca install             # register the hook, the MCP server, the skills
arca install --no-seed   # skip the one-time backfill of existing sessions
arca install --dry-run   # show what it would change, write nothing
```

The installer merges: it adds only its own entries, writes through a
temporary file and a rename so an interrupted write cannot truncate anything,
backs up `~/.claude/settings.json` and `~/.claude.json` before touching either,
and does nothing the second time. It never rewrites those files wholesale — they
hold your permissions, environment and every other hook. An entry that does not
point into this package is reported and left alone.

If you would rather wire it by hand, the two pieces are these.

**The hook** keeps the archive current. `hooks/session-vault.js` runs on `SessionStart`:
it copies new and changed session files into `~/.claude-vault/` — each with its
session directory: subagents, workflow agents, tool results — claims them for this
machine, syncs new prompts, commits, and kicks off incremental indexing.

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

**The MCP server** exposes the nineteen tools above. In `~/.claude.json`:

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

Claude Desktop and Cowork keep no conversation store on disk — only logs — so the
export is the only channel for those, and it already covers them.

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
restore, resurrect and prompts are unaffected — they touch no model at all.

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
~/.claude/projects/           source transcripts, written by Claude Code
~/.claude/history.jsonl       every prompt ever typed, written by Claude Code
~/.claude-vault/              the archive — a git repo, one dir per project
~/.claude-vault/.arca/        machine manifests and archived prompts (in git)
~/.claude-vault/config/       a copy of ~/.claude (in git)
~/.claude-vault/index/        vault.db — SQLite + sqlite-vec + FTS5 (not in git)
~/.claude-vault/.cache/       the embedding model (not in git)
~/.claude-vault/vault.log
```

The archive is a normal git repository. Back it up, push it somewhere private, or
`git log` it like anything else. Everything derived — the index, the model, the
logs, and the file naming which machine this is — is ignored, because only the
transcripts are irreplaceable.

## Where this came from

Three projects, and the first of them is the reason there is a second.

**[episodic-memory](https://github.com/obra/episodic-memory)** — Jesse Vincent,
MIT. This started as his, and a lot of it still is: the same four dependencies
(MCP SDK, transformers.js, better-sqlite3, sqlite-vec), the same file layout —
db, embeddings, indexer, parser, paths, search, show, mcp-server — and `search`
and `read` matching his down to the parameter names and the values of their
enums. Calling a tool like this an episodic memory is his phrasing, and this
README used to open with it.

It was good at everything I wanted except two things, and both were about what
a session is made of. Its index keeps which tools ran and what they were given,
but a `tool_result` block comes back on a user turn and the parser leaves that
case empty, with a TODO where the handling would go — so what a command
actually returned is not searchable. And while it does archive the transcript,
nothing puts one back: there is no restore, so a session Claude Code has
deleted stays deleted whatever is on disk.

Those two are the whole reason arca exists. Wanting a session back is what put
the transcripts in git, and once they were in git the rest followed — the
history of how one changed, restore, resurrect, and the four derived layers
that had somewhere to be derived from.

**[MemPalace](https://github.com/mempalace/mempalace)** — Milla Jovovich, Ben
Sigman, Igor Lins e Silva. Read in June 2026 and folded in the same week. Two
things came from it. Verbatim storage: keep the transcript byte for byte rather
than a summary of it. And the framing — that the hard part is not storing but
recalling something half-remembered, "that thing we talked about", which
keyword search cannot do and which is why half of this search is a vector.

**[claude-mem](https://github.com/thedotmack/claude-mem)** — Alex Newman.
Installed, used, and measured against more than once. Its answer to the same
problem is compression: summarise, so the next session starts knowing. arca
went the other way and keeps everything, and that choice was made against a
working example of the alternative rather than in the abstract.

This list was recovered using arca. The session where the three were compared
is gone — its transcript was deleted long before this was written — and what
survived is the prompts, in `~/.claude/history.jsonl`, which is the argument
for `arca prompts` in one example.

## Prior art

Very little else here is new either. What is new is the combination, and that
it runs against your own transcripts.

| | What it contributed |
|---|---|
| Vannevar Bush, *As We May Think* (1945) | the memex and its associative trails — which is what threads are |
| Endel Tulving (1972) | episodic versus semantic memory; the whole shape of episodes below, derived layers above |
| Niklas Luhmann's *Zettelkasten* | structure emerging from links rather than hierarchy |
| Park et al., *Generative Agents* (2023) | memory stream → reflection → higher-level observations; the essence layer is exactly this |
| Packer et al., *MemGPT* / Letta | an agent editing its own memory — `kg_add`, `observation_add` |
| Lewis et al., *RAG* (2020) | retrieval in front of generation |
| Cormack, Clarke & Büttcher (2009) | Reciprocal Rank Fusion, the formula that merges vector and FTS results here |
| Reimers & Gurevych, *Sentence-BERT* (2019) | all-MiniLM-L6-v2 comes from this line |
| Richard Snodgrass, bitemporal databases | `valid_from` / `valid_to` — "what was true in April" |
| Zep / Graphiti | a temporal knowledge graph for agent memory; the nearest living relative |
| Jamie Zawinski's threading algorithm (1997) | stitching a conversation into threads; this one stitches by embedding instead |
| git | content-addressed append-only history as the substrate — the vault *is* a repository |
| Richard Hipp (SQLite, FTS5), Alex Garcia (sqlite-vec) | the engine |
| Obsidian, Roam | `[[name]]` as a first-class link |
| rewind.ai, Screenpipe | total personal recall, kept local |

## Tests

```bash
npm test
```

265 tests over parsing, the tokenizer, the CLI, the hook, machine manifests,
prompt history, the claude.ai importer, source adapters, restore's refusal to
offer what it cannot restore, the model cache, path confinement, the
configuration vault and the credential scanner that guards it, and the
entity, KG and thread layers. No network, no database.

## Scale

For reference, a corpus of ~31,300 exchanges across 138 projects and ~3,700
transcript files produces a ~500 MB database, with ~60,800 essence extracts,
~9,100 entities, 844 knowledge-graph facts and ~122 threads on top of it, plus
~30,200 prompts. That corpus spans seven assistants; Claude Code is 28,091 of
those exchanges and the other six make up the rest. Incremental indexing of a single new session is a second or
two; a full re-index of that corpus is a coffee break, dominated by embedding.

## Name

*Arca* is Latin for chest, strongbox, coffer — the word `archive` descends from it
(arca → archivum), and so does `ark`: the vessel that carries everything through the
flood and out the other side. That is the job. Claude Code discards its transcripts at
every boundary; this keeps them, and hands back what they turn out to contain.

## License

MIT.
