# arca MCP tools — which one to reach for

The MCP server sends every tool's full parameter schema when it connects, so
repeating those tables here would pay for the same information twice. What a
schema cannot say is *which* tool answers the question you actually have.

All tools are prefixed `mcp__arca__`. Nineteen of them, in six layers.

## Find what was said

| Question | Tool |
|---|---|
| "Have I solved this before?" | `search` — hybrid vector + FTS5. Pass 2-5 queries as an array for an AND. |
| "Show me that whole conversation" | `read` — always after `search`, on the path it returned |
| "I asked this once, but the session is gone" | `prompt_search` — every prompt ever typed, including from sessions Claude Code deleted |

`search` narrows with `project`, `after`/`before`, and `source` — the assistant
a session came from (`claude_code`, `codex`, `opencode`, `gemini`, `cursor`,
`cline`, `antigravity`, `claude_ai`). Without `source`, everything is searched
together.

## Find what was decided

| Question | Tool |
|---|---|
| "What did we decide, and what constrained it?" | `essence_search` — only Decisions, Constraints, Tensions and Anti-patterns, about 5% of the corpus and none of the prose |

Reach for this before `search` when the question is about a decision rather
than about code. It is a much smaller index and the answers are already
compressed.

## Find what connects

| Question | Tool |
|---|---|
| "Where else does this tool/tech/idea appear?" | `entity_search` — one named thing, its footprint across projects |
| "What threads through everything I do?" | `entity_profile` — entities ranked by how many projects they span |
| "Where did this line of thought go?" | `thread_search`, then `thread_detail` on the id it returns |
| "What storylines do I keep returning to?" | `thread_list` — ranked by session reach; `return_count` is how fragmented |

## Facts that change over time

| Question | Tool |
|---|---|
| "What port is it on? What was it in April?" | `kg_query` — pass `as_of` for a point in time |
| "How did that change?" | `kg_timeline` — every recorded value, oldest first |
| "Remember this fact" | `kg_add` — single-valued predicates supersede automatically |
| "That is no longer true" | `kg_invalidate` |

## Learnings worth keeping

| Question | Tool |
|---|---|
| "Did we hit this before?" | `observation_search` |
| "What have I been learning lately?" | `observation_index` — titles and dates only, then fetch what matters |
| "Record this" | `observation_add` — typed: discovery, change, decision, gotcha, trade-off, bugfix, feature |

Record the why and the what-changed, not the narration.

## About the corpus itself

| Question | Tool |
|---|---|
| "How big is this, and what is in it?" | `stats` |
| "How do I actually work?" | `operator_profile` — the distribution of prompt kinds |
| "What was I waiting on?" | `recent_status_pings` |

## The one ordering that matters

`search` returns snippets, not conversations. Anything that needs the full
reasoning takes a `read` afterwards — and reading three whole sessions to answer
one question is what the `search-conversations` agent exists to avoid.
