# Transcript chunks

A session transcript is the unit the vault stores, the indexer reads, and
`restore` puts back. One of them reached gigabytes, and every store that meets
it pays for the size: git re-hashes the blob, the hook copies it whole, the
indexer parses it in one pass. Chunking splits a large transcript into fixed
pieces that are written once and never touched again, so the cost of a session
becomes the cost of the part that is actually growing.

## Layout

A chunked session owns the same directory that already holds its subagent
files:

```
<vault>/<project-slug>/<session-id>/
    transcript/
        part-0001.jsonl      closed, immutable
        part-0002.jsonl      closed, immutable
        part-0003.jsonl      growing — the only file that changes
        manifest.json
    subagents/               as before
    tool-results/            as before
```

A session below the threshold keeps today's shape — `<session-id>.jsonl` — and
nothing about it changes. Both forms coexist; a resolver decides which one it is
looking at.

## Manifest

```json
{
  "format": 1,
  "session": "dafe4e7b-71f4-47f8-befc-235771855e51",
  "partBytes": 8388608,
  "parts": [
    { "name": "part-0001.jsonl", "bytes": 8388608, "lines": 41233,
      "sha256": "…", "closed": true },
    { "name": "part-0002.jsonl", "bytes": 3145728, "lines": 0,
      "sha256": null, "closed": false }
  ]
}
```

The growing part carries no hash and no line count: recomputing either on every
session start would defeat the point. Line counts for a closed part are filled
in once, when it closes.

## Writing

The source in `~/.claude/projects` stays a single file. Claude Code knows
nothing about any of this.

The hook already knows how much of the source the vault holds. Chunked writing
applies the same rule with one addition: when the growing part reaches
`partBytes` at a line boundary, it is closed — hash and line count recorded —
and the next part starts at the following line. A run killed mid-append leaves
a short growing part, and the next run appends from its actual length; the
overlap probe that guards the single-file copy guards this one too.

Compaction does not rewrite a transcript — it ends one session and starts
another with a summary — so an append-only writer is correct.

If the source ever turns out to be shorter than the vault's total, the parts are
not patched: the session is rebuilt from scratch, because a shorter source means
the append-only assumption was wrong and incremental reasoning no longer holds.

## Reading back

`restore` concatenates the parts in manifest order and writes one `.jsonl` where
Claude Code expects it. `read` does the same and pages over the result, so a
chunked session reads exactly like a single-file one.

`walkTranscripts` groups part files by their session directory and yields one
entry per session, carrying the ordered part list instead of one path. Callers
that take a path (the indexer, the retention sweep) get a reader that streams
parts in order, so neither needs to know the shape changed.

The indexer tags every row with `session_id` and `part`; `search` groups hits by
session and reports which part to open. A hit from part 3 opens at part 3
without loading parts 1 and 2.

Retention deletes the session directory wholesale, which now removes the parts
along with the subagent files.

## Thresholds

| Setting | Default | Why |
|---|---|---|
| `chunkThresholdBytes` | 50 MB | below this, a single file is cheaper than a manifest |
| `partBytes` | 8 MB | small enough that git deltas stay cheap, large enough to keep the file count sane |

Both live in `.arca/hook.json` beside `commitIntervalMinutes`.

## What this buys

- a session that grows by a megabyte costs one appended file, not a rewritten
  blob
- git sees immutable files and diffs them once, when they close
- the indexer can re-read a single part instead of a whole session
- the transcript never crosses the size where git's hashing outlasts the hook

## Not doing

- No re-chunking of existing large transcripts. They keep the single-file shape;
  `restore`, `read`, and `search` handle both. A migration is a separate,
  measurable operation.
- No compression of parts. Git already compresses at pack time, and a second
  layer would make `read` and `restore` slower for a saving the packer already
  takes.
- No splitting across files of a single message. A part boundary always falls
  between lines.
