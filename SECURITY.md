# Security

## What arca holds

arca copies your Claude Code sessions into `~/.claude-vault` and keeps them
in git. The vault therefore holds everything arca has seen, in full, for as
long as you keep it — which is the point of the tool and also the thing to
understand about it.

It cannot reach back past its own installation. A session deleted before arca
was installed is gone, and the other assistants are read only once they are
named in `arca sources`. What is in the vault is complete from that point on,
not from the beginning.

It holds four stores:

| Path | Contents |
|---|---|
| `~/.claude-vault/<project>/*.jsonl` | session transcripts, copied verbatim |
| `~/.claude-vault/<project>/<session>/` | what Claude Code keeps beside a transcript: subagent transcripts and tool outputs, copied verbatim |
| `~/.claude-vault/.arca/history/` | every prompt you typed, including those whose session is gone |
| `~/.claude-vault/config/<machine-id>/` | a snapshot of each machine's `~/.claude`: commands, agents, skills, hooks, settings |

**Transcripts are not filtered.** If you pasted a key, a password, a customer
record or a private document into a conversation, it is in the transcript, and
the transcript is in the vault. The same holds for tool output: a command
that printed a `.env` file printed it into `tool-results/`, and that is in the
vault too. arca does not scan, redact or mask any of it. Treat
the vault as exactly as sensitive as the most sensitive thing you ever typed
into a chat.

**The config snapshot is filtered**, because configuration is where
credentials tend to sit. Before a file is copied, it is scanned for eighteen
credential shapes that announce themselves — Anthropic, OpenAI, GitHub,
GitLab, AWS, Google, Stripe, Slack, npm, SendGrid, DigitalOcean, HuggingFace,
RunPod, OpenRouter keys and PEM private key blocks — plus one heuristic for a
long opaque string next to a word like `token` or `password`. A file with a
finding is skipped whole and deleted from the vault if an earlier run put it
there. It is not redacted: partial copies of a credentialed file are worse
than none.

That filter is pattern matching. It will miss a credential in a format it does
not know, and it does not look at transcripts at all. It is a floor, not a
guarantee.

## The vault is a git repository

arca commits, and nothing else. It never adds a remote and never pushes. If
you add one, everything above goes wherever you point it, and a private
repository is the only sane choice. A vault pushed to a public remote
publishes your conversation history, and git history keeps what you later
delete.

The index, the embedding model and the logs are kept out of git deliberately;
the transcripts and the config snapshot are the parts that are committed.

## Reducing what you keep

- `arca config --scan` looks for credentials across the whole vault, including
  the transcripts the copier does not filter. It reports; it does not delete.
- A file the filter skipped can be kept anyway by adding its path to
  `~/.claude-vault/.arca/config-allow`, one per line. Do that deliberately.
- The vault is a directory. Deleting a project's folder and committing removes
  it going forward; rewriting git history removes it from the past.
- If you do not want a machine's sessions in a shared vault at all, do not
  install the hook on it. The MCP server and CLI read whatever is there.

## Reporting a vulnerability

Open a security advisory on the repository:
<https://github.com/ndokutovich/arca/security/advisories/new>. If you would
rather not use GitHub, open an issue saying only that you have something to
report, and a private channel will be arranged.

Please include what you did, what happened, and what you expected. A proof of
concept helps; a working exploit against your own vault helps more.

Expect an acknowledgement within a week. This is one person's project, not a
funded program, and the honest promise is attention rather than a schedule.

## Scope

In scope: anything that writes outside the vault and `~/.claude`, anything
that puts a credential into the vault that the filter should have caught,
anything that exposes the vault to another user on the same machine, and any
path where arca's own dependencies execute untrusted transcript content.

Out of scope: that transcripts are stored unencrypted and unfiltered — that is
documented above and is the design. Encrypting the vault at rest is your
filesystem's job.
