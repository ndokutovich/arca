---
description: Ask what the assistant itself remembers — from context only, no transcript archaeology. Use after /compact to check whether its understanding of what you were doing still matches yours. For the full disk-based reconstruction use /last-session.
---

Recall what we were working on in the previous session and where we stopped.

---

Answer **from the current context only** — from what you actually remember right
now.

- Do not read transcripts, do not go to git, do not call arca. No tools at all.
- Where you do not remember, or remember vaguely, say so. A gap **is the
  result** here; closing it with a guess destroys the answer.
- Keep it short: what we were doing → where we stopped → what you think comes
  next.

The point of this command is to show what survived compaction. If your
understanding has drifted from mine I will correct it, which is cheaper than
working on from a context we no longer share. For a reconstruction from disk,
use `/last-session`.
