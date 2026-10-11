# CLAUDE.md

Guidance for working in this repository. Everything here is something that was
learned the expensive way; anything derivable from the code is not repeated.

## What this is

A vault for Claude Code session transcripts: archived into git, indexed into
SQLite, served back over MCP. `README.md` is the reference — it is kept current
and is the right place to look before asking the code.

No build step. `node --test` runs everything (321 tests across 33 files), needs
no network, and must stay that way.

## Releasing

**A release is a tag push. Never `npm publish` by hand.**

```bash
npm version …        # or edit package.json
git tag -a v0.0.0 -m "…"
git push origin main && git push origin v0.0.0
```

`.github/workflows/release.yml` validates the tag against `package.json`, runs
the suite on Linux, macOS and Windows, then publishes over OIDC: npm trusts a
short-lived identity scoped to this repository and workflow filename. There is
no token anywhere — not in repository secrets, not on a developer machine — so
a local `npm publish` failing with `ENEEDAUTH` is the system working. Check
`gh run list --workflow=release.yml` and `npm view @ndokutovich/arca version`,
not the local shell.

Recreating the GitHub repository silently invalidates that trust. The npm page
still shows the same owner and repository and still says Valid, and every
publish answers `404` on PUT — which reads as "package not found" and is not.
Delete the trusted-publisher entry on npmjs.com and add it again; the new one
starts as Pending validation until one publish succeeds through it.

## Dependencies are load-bearing by their absence

Three: `@modelcontextprotocol/sdk`, `onnxruntime-node`, `sqlite-vec`. No dev
dependencies. SQLite is Node's own (`node:sqlite`, hence the 22.13 floor).

`transformers.js` and its 275 MB of tree were removed by reimplementing BERT
WordPiece tokenisation and mean pooling directly. `lib/tokenizer.js` and
`lib/embeddings.js` reproduce its output *bit for bit*, including a quirk: it
truncates after the template adds `[CLS]`/`[SEP]`, so a text long enough to
fill the window loses its `[SEP]` rather than its last word. Changing either
file silently invalidates every vector already in the index. Re-verify against
stored vectors before touching them.

Adding a dependency is a decision, not a convenience.

## The vault is the only copy

`~/.claude-vault` holds transcripts that exist nowhere else — Claude Code
deletes its own. Treat destructive git operations there as irreversible.

`pack.windowMemory=1g` and `pack.threads=1` are applied by the hook and are not
tuning: without them `git gc` allocates per-thread windows without bound and
dies on a 161 MB malloc with gigabytes free. A vault that cannot gc grows
without limit.

## The hook must never cost a session

`hooks/session-vault.js` runs on SessionStart. Every step is best effort and
every failure is caught — but a caught failure nobody reads is worse than a
crash. The machine claim and history sync ran for a whole release on Windows
without working, because `import('W:/...')` is rejected as an unknown protocol
`w:` and the error went to a log.

**Dynamic imports of absolute paths need `pathToFileURL(...).href`.** This will
bite again.

Test hooks by *running* them. `lib/hook.test.js` spawns the hook as a
subprocess against a throwaway `HOME`, because `node --check` happily passes a
CommonJS file in an ESM package and only execution catches it — which is how
0.2.0 shipped a hook that threw on its first line at every session start.

## Secrets

`lib/secrets.js` decides what never leaves the machine. Findings are always
masked: a scanner that echoes what it caught has published it twice. Never
print a candidate secret into a log, a test name or a commit message.

The rules use spelled-out character classes and no backslash shorthand. `\d`
survives one round-trip through a tool or a heredoc and not the next, and a
silently broken secret scanner is indistinguishable from a clean vault.

## Restore

`arca restore` must only ever offer `source = 'claude_code'`. Everything else —
claude.ai exports, Codex, Gemini, Cursor and the rest — is re-rendered text
that `claude --resume` cannot open. Claude Code's own transcripts are copied
byte for byte precisely so that it can.

## Style

Comments say why, never what. Tests are named as sentences about behaviour, and
each one states the failure it prevents. Where something has not been verified
against real data, say so in the code — the source adapters carry
`verifiedAgainst: 'live' | 'fixtures'` for exactly that reason.

Claims in the README are measured, not estimated. If a number appears there,
it came from a command that was actually run.

## Writing files with escapes

Regexes and string escapes lose a level of backslashes through bash heredocs —
`\\n` collapses, `\\[` becomes `\[`. Use the Write tool, or
`String.fromCharCode(92)`, and verify with `cat -v` before believing it.
