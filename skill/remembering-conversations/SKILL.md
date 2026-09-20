---
name: remembering-conversations
description: Use when user asks 'how should I...' or 'what's the best approach...' after exploring code, OR when you've tried to solve something and are stuck, OR for unfamiliar workflows, OR when user references past work. Searches conversation history.
---

# Remembering Conversations

**Core principle:** Search before reinventing. Searching costs nothing; reinventing or repeating mistakes costs everything.

## Mandatory: Use the Search Agent

**YOU MUST dispatch the search-conversations agent for any search that needs
conversations read and synthesised.**

Announce: "Dispatching search agent to find [topic]."

Then use the Agent tool with `subagent_type: "search-conversations"`:

```
Agent tool:
  description: "Search past conversations for [topic]"
  prompt: "Search for [specific query or topic]. Focus on [what you're looking for - e.g., decisions, patterns, gotchas, code examples]."
  subagent_type: "search-conversations"
```

The agent will:
1. Search with the `mcp__arca__search` tool
2. Read top 2-5 results with the `mcp__arca__read` tool
3. Synthesize findings (200-1000 words)
4. Return actionable insights + sources

**Saves 50-100x context vs. loading raw conversations.**

## Not everything is a conversation search

The agent reads whole conversations and synthesises them. That is the right
shape for "how did we approach this" and the wrong shape for a single fact —
it costs several reads to answer something one call already knows. Call these
directly instead:

- a decision, constraint or anti-pattern → `essence_search`
- a fact with a value, like a port or a version → `kg_query` (with `as_of` for a past date)
- one named tool, tech or idea across projects → `entity_search`
- a storyline you keep returning to → `thread_search`, then `thread_detail`
- a prompt whose session no longer exists → `prompt_search`
- something worth keeping from this session → `observation_add`

`MCP-TOOLS.md` has the full routing table for all nineteen tools.

## When to Use

Search memory once you understand what you're being asked:

**After understanding the task:**
- User asks "how should I..." or "what's the best approach..."
- You've explored current codebase and need to make architectural decisions
- User asks for implementation approach after describing what they want

**When you're stuck:**
- You've investigated a problem and can't find the solution
- Facing a complex problem without obvious solution in current code
- Need to follow an unfamiliar workflow or process

**When historical signals are present:**
- User says "last time", "before", "we discussed", "you implemented"
- User asks "why did we...", "what was the reason..."
- User says "do you remember...", "what do we know about..."

**Don't search first:**
- For current codebase structure (use Grep/Read to explore first)
- For info in current conversation
- Before understanding what you're being asked to do

## Direct CLI access

For a quick look without dispatching anything:

```bash
arca search "query"
arca prompts "query"    # prompts whose session is gone
arca help              # every command
```

Use the agent for anything that needs several results read and synthesised.
