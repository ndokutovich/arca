# Contributing

Small repository, few moving parts, three dependencies and no build step.

```bash
git clone https://github.com/ndokutovich/arca.git
cd arca
npm test
```

`npm test` runs everything, needs no network, and must stay that way — several
of its tests exist precisely to hold that line. There is no build step and no
dev dependency; adding a dependency is a decision, not a convenience.

## The two things that break quietly

**The tokenizer.** `lib/tokenizer.js` and `lib/embeddings.js` reproduce the
output of `transformers.js` bit for bit, which is why its 275 MB of tree is not
a dependency. Changing either one silently invalidates every vector already in
an index, and nothing fails — the search simply starts answering worse. If you
touch them, re-verify against vectors that are already stored.

**The hook.** `hooks/session-vault.js` runs at every session start. A hook that
throws costs a session. `node --check` passes a CommonJS file inside an ESM
package quite happily, so test it by running it, not by reading it.

## Releasing

A release is a tag push. `.github/workflows/release.yml` validates the tag
against `package.json`, runs the suite on Linux, macOS and Windows, then
publishes over npm trusted publishing. Never `npm publish` by hand — there is no
token to publish with, and a local failure with `ENEEDAUTH` is the system
working.

Note that npm serves the README out of the published tarball: a README change
reaches npm only in the next release, not when it reaches `main`.

## The rest

`CLAUDE.md` holds what was learned the expensive way — read it before changing
anything it mentions. `README.md` is the reference for what arca is and does.
