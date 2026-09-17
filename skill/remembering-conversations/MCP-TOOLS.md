# Vault Memory MCP Tools Reference

## search

Search past Claude Code conversations using hybrid semantic + full-text search with RRF fusion.

**Tool name:** `mcp__arca__search`

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | `string` or `string[]` | Yes | Search query. String for single-concept, array of 2-5 strings for multi-concept AND |
| `mode` | `"vector"` \| `"text"` \| `"both"` | No | Search mode (default: `"both"`) |
| `limit` | `number` | No | Max results, 1-50 (default: 10) |
| `after` | `string` | No | Date filter YYYY-MM-DD |
| `before` | `string` | No | Date filter YYYY-MM-DD |
| `project` | `string` | No | Filter by project directory name |
| `response_format` | `"markdown"` \| `"json"` | No | Output format (default: `"markdown"`) |

### Search Modes

- **`vector`** — Semantic similarity (sqlite-vec, 384d embeddings)
- **`text`** — FTS5 full-text with BM25 ranking
- **`both`** — Reciprocal Rank Fusion of vector + text results (recommended)

## read

Display a full conversation from vault with optional line-range pagination.

**Tool name:** `mcp__arca__read`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | Yes | Absolute path to JSONL file |
| `startLine` | `number` | No | Start line (1-indexed) |
| `endLine` | `number` | No | End line (1-indexed) |

## stats

Get vault index statistics.

**Tool name:** `mcp__arca__stats`

No parameters. Returns exchange count, project count, file count.
