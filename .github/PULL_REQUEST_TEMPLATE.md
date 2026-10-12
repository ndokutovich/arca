**What this changes**

**How it was checked**

- [ ] `npm test` passes — it needs no network, and must stay that way
- [ ] if `lib/tokenizer.js` or `lib/embeddings.js` changed: re-verified against
      vectors already stored in an index
- [ ] if `hooks/session-vault.js` changed: run it, not read it

<!--
Both boxes above exist because both have shipped broken before. The tokenizer
reproduces transformers.js output bit for bit — that is why it is not a
dependency — and a change to it silently invalidates every vector already in an
index. The hook runs at every session start, and one that throws costs a
session. Neither failure is visible in a test that only reads the code.
-->

**Anything that writes to `~/.claude-vault`**

<!--
The vault is a git repository of transcripts that exist nowhere else. Say what
happens if this change is interrupted halfway.
-->
