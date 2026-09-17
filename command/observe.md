---
description: Extract typed learnings from recent work into vault-memory observations
argument-hint: optional focus (e.g. "the auth refactor")
---

# /observe — session-as-observer

Absorb the claude-mem observer design without its separate-SDK overhead: **you, the
running session, are the observer.** Extract durable, typed learnings from the work
just done and persist them to vault-memory via the `observation_add` MCP tool. Zero
extra provider, zero background tokens, retrieval rides vault's live sqlite-vec + FTS5.

## What to extract

Scan the recent work (this session, or the focus in `$ARGUMENTS` if given). Record
only **high-signal, durable learnings** — things worth recalling weeks later. One
observation per distinct insight.

For each, call `observation_add` with:

- **type** — one of: `discovery` (how something actually works / a non-obvious fact),
  `change` (what was modified and why), `decision` (a choice made + rationale),
  `gotcha` (a trap, footgun, or surprising failure mode), `trade-off` (a tension and
  which side was taken), `bugfix` (root cause + fix), `feature` (capability added).
- **title** — concise, specific headline. This is the searchable handle. Name the
  real subject (e.g. "XTTS rejects effort param on Sonnet 4.5 → HTTP 400"), not
  "fixed a bug".
- **narrative** — 2-3 sentences: what was learned/decided/changed **and why**. Carry
  the causal core. No step-by-step narration.
- **concepts** — comma-separated tags from: `how-it-works`, `why-it-exists`,
  `what-changed`, `problem-solution`, `gotcha`, `pattern`, `trade-off`.
- **project** — the current project directory name (derive from cwd).

## Rules (the anti-slop discipline)

- **Record nothing rather than record noise.** If a turn was routine, skip it. A
  ToolSearch or a status ping is not an observation.
- **Causality over chronology.** "We chose X over Y because Z" beats "first we tried X".
- **Verbatim-anchor when it matters** — keep exact identifiers (ports, versions, error
  strings, file:line) in the narrative; they make recall precise.
- **Idempotent** — re-running `/observe` updates same-titled observations, not dupes.
- Aim for the few that matter (typically 1-6 per session), not exhaustiveness.

## After recording

Briefly report what was captured: `#id [type] title` per observation. Then note the
running total via `observation_index` if useful.

Recall later with `observation_search "<question>"` — "did we already learn this?".
