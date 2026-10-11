---
description: Recover context from the previous session — what we worked on, what got done, and exactly where we stopped. Use when starting fresh, after /compact, or when the user asks "where were we", "what were we doing", "catch me up", "restore context".
argument-hint: "[optional: topic to focus on]"
---

# Last Session — restoring context

Reconstruct what was being worked on and where it stopped. **The raw transcript
is the source of truth**, not memory and not a cache. Run whatever can be run in
parallel.

## Step 1: find the previous session

Transcripts live in `~/.claude/projects/<project-slug>/*.jsonl`.

```bash
ls -t ~/.claude/projects/*/*.jsonl | head -5
```

- The newest file is the **current** session, being written right now. Skip it.
- The next one is the **previous** session. With several project directories,
  take the slug matching the current `cwd`.
- Given an argument, search for the session about that topic rather than simply
  the most recent one.

## Step 2: read the tail — "where we stopped" lives there

The last few turns matter more than everything before them. From the tail,
pull out:

- the final user request and what it was answered with;
- anything left unfinished — a process still running, an open question, a next
  step that was promised;
- explicit stop signals: an unanswered question, an error, a decision being
  waited on.

The JSONL shape is `{ type, message: { role, content } }` — **unwrap through
`.message`**; there are no top-level `role` or `content` fields.

## Step 3: in parallel, the factual traces

Run these at the same time:

- `git log --oneline -15 --format='%h %cd %s' --date=format:'%m-%d %H:%M'` —
  what was actually committed
- `git status --short` — **uncommitted means unfinished**, the most honest signal
  of where the work was dropped
- `git stash list` — what was set aside
- arca `thread_detail` / `thread_list` — the through-line, when the topic spans
  several sessions
- arca `observation_search` — typed lessons on the topic

For a long session, do not read all of it: take the opening (what was intended),
the middle at its turning points, and the tail (where it stalled).

## Step 4: report

Keep it **compact**. Do not retell the conversation.

```
## Previous session — <date, duration>

**Working on:** 2-4 points, most important first

**Done:** commits, files, facts — with `file:line` references and hashes

**Stopped at:** one specific point — what exactly was left open

**Loose ends:**
- uncommitted: <files>
- unfinished: <process / question / decision>

**Next step:** one sentence — what it makes sense to do first
```

## Rules

- **Do not invent.** If it is not there, say so; never "we were probably...".
- Separate what was **done** (a commit, a file) from what was **discussed**
  (only talk).
- The tail beats coverage: an exact stopping point is worth more than a full
  summary.
- If the previous session is the same thread as this one after a `/compact`, say
  so plainly.
- Do not start working. Restore the context and wait.
