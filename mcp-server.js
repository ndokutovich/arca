#!/usr/bin/env node
/**
 * arca MCP server.
 *
 * Provides hybrid semantic + full-text search over git-backed
 * Claude Code session transcripts stored in ~/.claude-vault/.
 *
 * Tools:
 *   search — hybrid vector + FTS5 with RRF fusion
 *   read   — show full conversation with line-range pagination
 *   show   — database stats
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import nodePath from 'path';
import { vaultDir, projectsDir } from './lib/transcripts.js';
import {
  search,
  searchMultiConcept,
  formatResultsMarkdown,
  formatMultiConceptMarkdown,
} from './lib/search.js';
import { showConversation } from './lib/show.js';
import { getDb, getStats, closeDb, addTriple, invalidateTriple, queryTriples, kgTimeline,
  addObservation, searchObservations, observationIndex, getObservation, OBSERVATION_TYPES,
  listThreads, searchThreads, getThread,
  searchPrompts, promptStats } from './lib/db.js';
import { embed } from './lib/embeddings.js';

const server = new Server(
  { name: 'arca', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'search',
      description:
        'Search past Claude Code conversations using semantic similarity, full-text search, or both. ' +
        'Supports single string query or array of 2-5 concepts for precise AND matching. ' +
        'Returns ranked results with project, date, snippets, line ranges, and file paths. ' +
        'Use this to recover decisions, solutions, and context from past sessions.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            oneOf: [
              { type: 'string', minLength: 2 },
              { type: 'array', items: { type: 'string', minLength: 2 }, minItems: 2, maxItems: 5 },
            ],
            description: 'Search query — string for semantic/text, array for multi-concept AND',
          },
          mode: {
            type: 'string',
            enum: ['vector', 'text', 'both'],
            default: 'both',
            description: 'Search mode: vector (semantic), text (FTS5+BM25), both (RRF fusion)',
          },
          limit: { type: 'number', minimum: 1, maximum: 50, default: 10 },
          after: {
            type: 'string',
            pattern: '^\\d{4}-\\d{2}-\\d{2}$',
            description: 'Only results after this date (YYYY-MM-DD)',
          },
          before: {
            type: 'string',
            pattern: '^\\d{4}-\\d{2}-\\d{2}$',
            description: 'Only results before this date (YYYY-MM-DD)',
          },
          project: {
            type: 'string',
            description: 'Filter by project directory name',
          },
          response_format: {
            type: 'string',
            enum: ['markdown', 'json'],
            default: 'markdown',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: {
        title: 'Search arca',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: 'read',
      description:
        'Read full conversation from a JSONL file. Use after search to get complete context. ' +
        'Supports startLine/endLine pagination for large conversations.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', minLength: 1, description: 'Absolute path to JSONL file' },
          startLine: { type: 'number', minimum: 1, description: 'Start line (1-indexed)' },
          endLine: { type: 'number', minimum: 1, description: 'End line (1-indexed)' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      annotations: {
        title: 'Read Conversation',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: 'stats',
      description: 'Get arca index statistics: total exchanges, projects, files, system-noise count, essence extracts, prompt-kind distribution.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: {
        title: 'Vault Stats',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: 'essence_search',
      description:
        'Search the structural essence layer — only Decisions, Constraints, Tensions, and Anti-patterns extracted from past conversations. ' +
        'Much smaller index than full search (~5% of raw vault), useful for recovering load-bearing context without prose noise.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 2, description: 'FTS5 query against essence text' },
          category: { type: 'string', enum: ['DECISION', 'CONSTRAINT', 'TENSION', 'ANTIPATTERN'], description: 'Filter by category' },
          project: { type: 'string', description: 'Filter by project substring' },
          limit: { type: 'number', minimum: 1, maximum: 100, default: 20 },
        },
        // The handler cannot do anything without a query; declaring it
        // optional made an empty call a runtime error instead of a schema one.
        required: ['query'],
        additionalProperties: false,
      },
      annotations: { title: 'Essence Search', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'operator_profile',
      description:
        'Show distribution of user prompt-kinds (GO, APPROVE, STATUS, CONTINUE, TASK, PASTE, etc.) across the vault, ' +
        'optionally per-project. Reveals operator style: trust-vs-correction ratio, polling-heavy vs flow-heavy projects.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Filter by project substring (optional)' },
          group_by: { type: 'string', enum: ['none', 'project'], default: 'none' },
        },
        additionalProperties: false,
      },
      annotations: { title: 'Operator Profile', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'recent_status_pings',
      description:
        'Show recent STATUS-kind prompts (the user pinging an in-flight task). Useful for "what was I waiting on" — ' +
        'reveals tasks the user expected to be running. Returns project, timestamp, prompt text, and assistant reply head.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Filter by project substring' },
          limit: { type: 'number', minimum: 1, maximum: 50, default: 15 },
        },
        additionalProperties: false,
      },
      annotations: { title: 'Recent Status Pings', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'prompt_search',
      description:
        'Search every prompt the user has ever typed, including ones whose session no longer exists. ' +
        'Claude Code keeps these in a history file outside the per-project transcripts, so they survive ' +
        'the transcript being deleted — this is the only way to recover what was asked in a session that ' +
        'is gone. Set lost_only to see just those. Returns date, project, machine, and the prompt text. ' +
        'A prompt has no reply attached: for the conversation itself, use search.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 2, description: 'Full-text query over prompt text' },
          project: { type: 'string', description: 'Filter by project substring' },
          lost_only: { type: 'boolean', default: false, description: 'Only prompts with no surviving session' },
          limit: { type: 'number', minimum: 1, maximum: 100, default: 20 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: { title: 'Prompt Search', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'entity_profile',
      description:
        'Show named entities (tools, tech, projects, concepts) ranked by how many projects they span — ' +
        'the connective tissue threading the operator\'s work across all sessions. ' +
        'An entity in one project is local; one across many is a spine. Filter by type or minimum project span.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['tech', 'tool', 'person', 'concept'], description: 'Filter by entity type' },
          min_projects: { type: 'number', minimum: 1, default: 2, description: 'Minimum project span (default 2 = cross-project only)' },
          limit: { type: 'number', minimum: 1, maximum: 100, default: 30 },
        },
        additionalProperties: false,
      },
      annotations: { title: 'Entity Profile', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'entity_search',
      description:
        'Look up a named entity and get its cross-project footprint: which projects mention it, ' +
        'how often, when it first and last appeared, and sample context per project. ' +
        'Use to trace a tool/tech/concept (e.g. "XTTS", "sqlite-vec") across every session it touched.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 2, description: 'Entity name or partial (e.g. "xtts", "docker")' },
          limit: { type: 'number', minimum: 1, maximum: 20, default: 5, description: 'Max matching entities to return' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: { title: 'Entity Search', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'kg_query',
      description:
        'Query the temporal knowledge graph for facts about a subject (e.g. ports, versions). ' +
        'Each fact is subject -predicate-> object with a validity window. Pass as_of (YYYY-MM-DD) ' +
        'to ask what was true at a point in time — e.g. "what port was XTTS on in April?".',
      inputSchema: {
        type: 'object',
        properties: {
          subject: { type: 'string', minLength: 1, description: 'Entity key (e.g. "xtts", "sqlite-vec")' },
          predicate: { type: 'string', description: 'Filter by relation (e.g. runs_on_port, has_version, replaced_by)' },
          as_of: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Point in time (YYYY-MM-DD); omit for all facts' },
          current_only: { type: 'boolean', default: false, description: 'Only facts still true now' },
        },
        required: ['subject'],
        additionalProperties: false,
      },
      annotations: { title: 'KG Query', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'kg_timeline',
      description: 'Chronological fact timeline for a subject — every recorded fact oldest-first, with validity windows. Shows how ports/versions changed over time.',
      inputSchema: {
        type: 'object',
        properties: {
          subject: { type: 'string', minLength: 1 },
          limit: { type: 'number', minimum: 1, maximum: 200, default: 50 },
        },
        required: ['subject'],
        additionalProperties: false,
      },
      annotations: { title: 'KG Timeline', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'kg_add',
      description:
        'Add a fact to the knowledge graph: subject -predicate-> object, with an optional validity window. ' +
        'For single-valued predicates (runs_on_port, has_version, located_at, status_is) a newer-dated ' +
        'value automatically supersedes the prior one. Use to record durable facts you want recalled later.',
      inputSchema: {
        type: 'object',
        properties: {
          subject: { type: 'string', minLength: 1 },
          predicate: { type: 'string', minLength: 1, description: 'e.g. runs_on_port, has_version, uses, located_at, status_is' },
          object: { type: 'string', minLength: 1 },
          valid_from: { type: 'string', description: 'YYYY-MM-DD when it became true (optional)' },
          valid_to: { type: 'string', description: 'YYYY-MM-DD when it stopped (optional; omit = current)' },
          confidence: { type: 'number', minimum: 0, maximum: 1, default: 1 },
        },
        required: ['subject', 'predicate', 'object'],
        additionalProperties: false,
      },
      annotations: { title: 'KG Add', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    {
      name: 'kg_invalidate',
      description: 'Mark a fact no longer true (stamps valid_to). Identify it by id, or by subject+predicate+object. Use when a port/version/status changes.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Triple id (from kg_query)' },
          subject: { type: 'string' },
          predicate: { type: 'string' },
          object: { type: 'string' },
          ended: { type: 'string', description: 'YYYY-MM-DD it stopped being true (default: today)' },
        },
        additionalProperties: false,
      },
      annotations: { title: 'KG Invalidate', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    {
      name: 'observation_add',
      description:
        'Record a typed learning extracted from work — a durable observation that survives the session. ' +
        'Types: discovery, change, decision, gotcha, trade-off, bugfix, feature. Embedded for semantic recall. ' +
        'Idempotent on (title, project). Use to capture WHY/HOW/what-changed, not narration.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: OBSERVATION_TYPES },
          title: { type: 'string', minLength: 3, description: 'Concise headline (the searchable handle)' },
          narrative: { type: 'string', minLength: 10, description: '2-3 sentences: what was learned/decided/changed and why' },
          concepts: { type: 'string', description: 'Comma-separated tags: how-it-works, why-it-exists, gotcha, pattern, trade-off, problem-solution' },
          project: { type: 'string', description: 'Project directory name (optional)' },
          session_id: { type: 'string' },
        },
        required: ['type', 'title', 'narrative'],
        additionalProperties: false,
      },
      annotations: { title: 'Observation Add', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'observation_search',
      description:
        'Hybrid semantic + full-text search over recorded observations (typed learnings). ' +
        'Answers "did we learn/decide/hit this before?". Filter by type or project. Returns title, narrative, type, date.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 2 },
          type: { type: 'string', enum: OBSERVATION_TYPES, description: 'Filter by observation type' },
          project: { type: 'string', description: 'Filter by project substring' },
          limit: { type: 'number', minimum: 1, maximum: 50, default: 10 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: { title: 'Observation Search', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'observation_index',
      description:
        'Progressive-disclosure index of recent observations — compact list (id, type, title, date) without full narratives. ' +
        'Cheap session-priming: scan the index, then observation_search or get the few that matter. Filter by project/type.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          type: { type: 'string', enum: OBSERVATION_TYPES },
          limit: { type: 'number', minimum: 1, maximum: 100, default: 40 },
        },
        additionalProperties: false,
      },
      annotations: { title: 'Observation Index', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'thread_list',
      description:
        'List topic-threads — coherent storylines recovered from sessions and linked across the corpus. ' +
        'A thread is a cluster of conversation segments on one topic; a thread spanning many sessions is a ' +
        'storyline you keep returning to. Ranked by session reach. return_count = how fragmented (times you ' +
        'left and came back). Use to see "what threads run through my work" or scope by project.',
      inputSchema: {
        type: 'object',
        properties: {
          min_sessions: { type: 'number', minimum: 1, default: 2, description: 'Min sessions a thread spans (2 = cross-session only)' },
          project: { type: 'string', description: 'Restrict to threads touching a project substring' },
          limit: { type: 'number', minimum: 1, maximum: 100, default: 30 },
        },
        additionalProperties: false,
      },
      annotations: { title: 'Thread List', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'thread_search',
      description:
        'Find topic-threads by meaning or keyword (hybrid semantic + full-text). Returns matching storylines ' +
        'with their span and fragmentation. Use to locate the thread for a topic — e.g. "voice synthesis", ' +
        '"postgres reactive", "the svg art work" — then thread_detail to walk its segments across sessions.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 2, description: 'Topic to find (e.g. "tts voice cloning")' },
          project: { type: 'string', description: 'Restrict to a project substring' },
          limit: { type: 'number', minimum: 1, maximum: 30, default: 10 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: { title: 'Thread Search', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'thread_detail',
      description:
        'Walk one thread: its member segments in timeline order, across every session they came from. ' +
        'Shows how a storyline wove through your work — which sessions, which projects, where you returned. ' +
        'Pass the thread id from thread_list / thread_search.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Thread id' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      annotations: { title: 'Thread Detail', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    if (name === 'search') {
      const { query, mode = 'both', limit = 10, after, before, project, response_format = 'markdown' } = args;

      let resultText;

      if (Array.isArray(query)) {
        const results = await searchMultiConcept(query, { limit, after, before, project });
        resultText = response_format === 'json'
          ? JSON.stringify({ results, count: results.length, concepts: query }, null, 2)
          : formatMultiConceptMarkdown(results, query);
      } else {
        const results = await search(query, { limit, mode, after, before, project });
        resultText = response_format === 'json'
          ? JSON.stringify({ results, count: results.length, mode }, null, 2)
          : formatResultsMarkdown(results);
      }

      return { content: [{ type: 'text', text: resultText }] };
    }

    if (name === 'read') {
      const { path: filePath, startLine, endLine } = args;
      // Confine reads to the transcript trees. This tool exists to open a
      // conversation the index pointed at, and an MCP tool that will read any
      // absolute path is a file-disclosure primitive for whatever can influence
      // the caller's input. Both roots are legitimate: search returns archive
      // paths, and a live session under ~/.claude/projects is the same kind of
      // file. Anything else is refused by name rather than silently emptied.
      // realpath, not resolve: resolve is lexical and happily walks through a
      // symlink planted inside either root, which would turn confinement into
      // decoration. Roots are canonicalised too, or a symlinked home defeats it
      // from the other side.
      const canon = (p) => { try { return fs.realpathSync.native(p); } catch { return nodePath.resolve(p); } };
      const resolved = canon(nodePath.resolve(filePath));
      const roots = [vaultDir(), projectsDir()].map(canon);
      const inside = roots.some(
        (root) => resolved === root || resolved.startsWith(root + nodePath.sep)
      );
      if (!inside) {
        throw new Error(
          `Refusing to read outside the vault: ${filePath}. arca reads transcripts under ${roots.join(' or ')}.`
        );
      }
      if (!fs.existsSync(resolved)) {
        throw new Error(`File not found: ${filePath}`);
      }
      const markdown = showConversation(resolved, startLine, endLine);
      return { content: [{ type: 'text', text: markdown }] };
    }

    if (name === 'stats') {
      const stats = getStats();
      const lines = [
        'arca index:',
        `- ${stats.exchanges} exchanges`,
        `- ${stats.projects} projects`,
        `- ${stats.files} session files`,
        `- ${stats.system_noise} system-injected (filtered)`,
        `- ${stats.essence_extracts} essence extracts`,
        `- ${stats.entities} entities (${stats.cross_project_entities} cross-project)`,
        `- ${stats.kg_triples} KG facts (${stats.kg_current} current)`,
        `- ${stats.observations} observations`,
        `- ${stats.threads} threads (${stats.cross_session_threads} cross-session)`,
      ];
      if (stats.prompt_kinds && stats.prompt_kinds.length) {
        lines.push('', 'Prompt kinds:');
        for (const k of stats.prompt_kinds.slice(0, 12)) {
          lines.push(`  ${k.prompt_kind.padEnd(18)} ${k.count}`);
        }
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    if (name === 'essence_search') {
      const { query, category, project, limit = 20 } = args;
      const db = getDb();
      const conds = [`fts_essence MATCH ?`];
      const params = [query];
      if (category) { conds.push('category = ?'); params.push(category); }
      if (project)  { conds.push('project LIKE ?'); params.push(`%${project}%`); }
      params.push(limit);
      const rows = db.prepare(`
        SELECT text, category, speaker, project, exchange_id
        FROM fts_essence
        WHERE ${conds.join(' AND ')}
        LIMIT ?
      `).all(...params);
      const lines = [`Essence search: "${query}"${category ? ' [' + category + ']' : ''}${project ? ' in ' + project : ''}`, `${rows.length} results`, ''];
      for (const r of rows) {
        lines.push(`[${r.category}] (${r.speaker}, ${r.project})`);
        lines.push(`  ${r.text}`);
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    if (name === 'operator_profile') {
      const { project, group_by = 'none' } = args;
      const db = getDb();
      const where = ['is_system_noise = 0', 'prompt_kind IS NOT NULL'];
      const params = [];
      if (project) { where.push('project LIKE ?'); params.push(`%${project}%`); }
      if (group_by === 'project') {
        const rows = db.prepare(`
          SELECT project, prompt_kind, COUNT(*) as count
          FROM exchanges WHERE ${where.join(' AND ')}
          GROUP BY project, prompt_kind
          ORDER BY project, count DESC
        `).all(...params);
        const byProj = {};
        for (const r of rows) {
          (byProj[r.project] = byProj[r.project] || []).push([r.prompt_kind, r.count]);
        }
        const lines = ['Operator profile by project:', ''];
        for (const [proj, kinds] of Object.entries(byProj)) {
          lines.push(`## ${proj}`);
          const total = kinds.reduce((s, [, c]) => s + c, 0);
          for (const [k, c] of kinds) {
            lines.push(`  ${k.padEnd(18)} ${String(c).padStart(5)}  ${(100 * c / total).toFixed(1)}%`);
          }
          lines.push('');
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }
      const rows = db.prepare(`
        SELECT prompt_kind, COUNT(*) as count
        FROM exchanges WHERE ${where.join(' AND ')}
        GROUP BY prompt_kind ORDER BY count DESC
      `).all(...params);
      const total = rows.reduce((s, r) => s + r.count, 0) || 1;
      const lines = [`Operator profile${project ? ' [' + project + ']' : ''}:`, ''];
      for (const r of rows) {
        lines.push(`  ${r.prompt_kind.padEnd(18)} ${String(r.count).padStart(6)}  ${(100 * r.count / total).toFixed(1)}%`);
      }
      const goApprove = rows.filter(r => ['GO', 'APPROVE'].includes(r.prompt_kind)).reduce((s, r) => s + r.count, 0);
      const steer = rows.find(r => r.prompt_kind === 'STEER')?.count || 0;
      lines.push('', `GO+APPROVE / STEER ratio: ${steer ? (goApprove / steer).toFixed(1) : '∞'}`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    if (name === 'recent_status_pings') {
      const { project, limit = 15 } = args;
      const db = getDb();
      const where = ['prompt_kind = ?', 'is_system_noise = 0'];
      const params = ['STATUS'];
      if (project) { where.push('project LIKE ?'); params.push(`%${project}%`); }
      params.push(limit);
      const rows = db.prepare(`
        SELECT project, timestamp, user_message, substr(assistant_message, 1, 240) as reply_head
        FROM exchanges WHERE ${where.join(' AND ')}
        ORDER BY timestamp DESC LIMIT ?
      `).all(...params);
      const lines = [`Recent STATUS pings${project ? ' in ' + project : ''} — ${rows.length} hits`, ''];
      for (const r of rows) {
        const head = r.user_message.split('\n', 1)[0].slice(0, 120);
        const reply = (r.reply_head || '').replace(/\s+/g, ' ').slice(0, 200);
        lines.push(`[${r.timestamp.slice(0, 16)}] (${r.project})`);
        lines.push(`  Q: ${head}`);
        lines.push(`  A: ${reply}…`);
        lines.push('');
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    if (name === 'prompt_search') {
      const { query, project, lost_only = false, limit = 20 } = args;
      const rows = searchPrompts(query, { project: project || null, orphansOnly: !!lost_only, limit });
      const s = promptStats();
      const lines = [
        `${rows.length} prompt(s) for "${query}"${lost_only ? ', none of which has a surviving session' : ''}`,
        `(${s.total} prompts stored, ${s.orphans} with no session behind them)`,
        '',
      ];
      for (const r of rows) {
        const text = r.text.replace(/\s+/g, ' ').trim();
        lines.push(`[${r.timestamp.slice(0, 16).replace('T', ' ')}] (${r.project})${r.has_session ? '' : '  — session lost'}`);
        lines.push(`  ${text.length > 400 ? `${text.slice(0, 400)}…` : text}`);
        lines.push('');
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    if (name === 'entity_profile') {
      const { type, min_projects = 2, limit = 30 } = args;
      const db = getDb();
      const where = ['project_count >= ?'];
      const params = [min_projects];
      if (type) { where.push('type = ?'); params.push(type); }
      params.push(limit);
      const rows = db.prepare(`
        SELECT canonical, type, project_count, mention_count, first_seen, last_seen
        FROM entities WHERE ${where.join(' AND ')}
        ORDER BY project_count DESC, mention_count DESC LIMIT ?
      `).all(...params);
      const lines = [
        `Entity profile${type ? ' [' + type + ']' : ''} — span >= ${min_projects} projects — ${rows.length} entities`,
        '',
      ];
      for (const r of rows) {
        lines.push(`${String(r.project_count).padStart(3)} proj  ${String(r.mention_count).padStart(5)} ment  [${r.type}] ${r.canonical}`);
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    if (name === 'entity_search') {
      const { query, limit = 5 } = args;
      const db = getDb();
      const key = query.trim().toLowerCase();
      // exact id, then FTS, then LIKE on canonical/aliases
      let ents = db.prepare('SELECT * FROM entities WHERE id = ?').all(key);
      if (ents.length === 0) {
        try {
          const ids = db.prepare('SELECT entity_id FROM fts_entities WHERE fts_entities MATCH ? LIMIT ?')
            .all(query, limit).map(r => r.entity_id);
          if (ids.length) {
            ents = db.prepare(`SELECT * FROM entities WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
          }
        } catch { /* FTS syntax error on odd queries — fall through to LIKE */ }
      }
      if (ents.length === 0) {
        ents = db.prepare(`
          SELECT * FROM entities WHERE canonical LIKE ? OR aliases LIKE ?
          ORDER BY project_count DESC LIMIT ?
        `).all(`%${query}%`, `%${query}%`, limit);
      }
      ents = ents.sort((a, b) => b.project_count - a.project_count).slice(0, limit);
      if (ents.length === 0) {
        return { content: [{ type: 'text', text: `No entity matching "${query}".` }] };
      }
      const lines = [];
      for (const e of ents) {
        lines.push(`# ${e.canonical}  [${e.type}]`);
        lines.push(`spans ${e.project_count} projects, ${e.mention_count} mentions · ${(e.first_seen || '').slice(0, 10)} → ${(e.last_seen || '').slice(0, 10)}`);
        const byProj = db.prepare(`
          SELECT project, COUNT(*) c, MAX(timestamp) last
          FROM entity_mentions WHERE entity_id = ?
          GROUP BY project ORDER BY c DESC LIMIT 15
        `).all(e.id);
        for (const p of byProj) {
          lines.push(`  ${String(p.c).padStart(3)}×  ${p.project}`);
        }
        const sample = db.prepare(`
          SELECT project, snippet FROM entity_mentions
          WHERE entity_id = ? AND snippet IS NOT NULL
          ORDER BY timestamp DESC LIMIT 3
        `).all(e.id);
        if (sample.length) {
          lines.push('  recent context:');
          for (const s of sample) lines.push(`    · ${s.snippet}`);
        }
        lines.push('');
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    if (name === 'kg_query') {
      const { subject, predicate, as_of, current_only = false } = args;
      const rows = queryTriples(subject, { predicate, as_of, includeExpired: !current_only });
      if (rows.length === 0) {
        return { content: [{ type: 'text', text: `No facts for "${subject}"${as_of ? ' as of ' + as_of : ''}.` }] };
      }
      const lines = [`Facts: ${subject}${as_of ? ' (as of ' + as_of + ')' : ''} — ${rows.length}`, ''];
      for (const r of rows) {
        const window = r.valid_to
          ? `${(r.valid_from || '?').slice(0, 10)} → ${r.valid_to.slice(0, 10)}`
          : `since ${(r.valid_from || '?').slice(0, 10)} (current)`;
        lines.push(`  ${r.predicate} → ${r.object}   [${window}]  ·${r.method}`);
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    if (name === 'kg_timeline') {
      const { subject, limit = 50 } = args;
      const rows = kgTimeline(subject, limit);
      if (rows.length === 0) return { content: [{ type: 'text', text: `No timeline for "${subject}".` }] };
      const lines = [`Timeline: ${subject} — ${rows.length} facts`, ''];
      for (const r of rows) {
        const state = r.valid_to ? `ended ${r.valid_to.slice(0, 10)}` : 'current';
        lines.push(`  ${(r.valid_from || '?').slice(0, 10)}  ${r.predicate} → ${r.object}  (${state})`);
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    if (name === 'kg_add') {
      const { subject, predicate, object, valid_from, valid_to, confidence = 1 } = args;
      const id = addTriple({ subject, predicate, object, valid_from, valid_to, confidence, method: 'manual' });
      return { content: [{ type: 'text', text: id ? `Added #${id}: ${subject} -${predicate}-> ${object}` : 'Not added (invalid or duplicate).' }] };
    }

    if (name === 'kg_invalidate') {
      const { id, subject, predicate, object, ended } = args;
      if (!id && !(subject && predicate && object)) {
        throw new Error('Provide id, or subject+predicate+object.');
      }
      const changed = invalidateTriple({ id, subject, predicate, object, ended });
      return { content: [{ type: 'text', text: `${changed} fact(s) invalidated.` }] };
    }

    if (name === 'observation_add') {
      const { type, title, narrative, concepts, project, session_id } = args;
      const embedding = await embed(`${title}\n${narrative}\n${concepts || ''}`);
      const id = addObservation({ type, title, narrative, concepts, project, session_id }, embedding);
      return { content: [{ type: 'text', text: `Recorded observation #${id} [${type}]: ${title}` }] };
    }

    if (name === 'observation_search') {
      const { query, type, project, limit = 10 } = args;
      const qEmb = await embed(query);
      const rows = searchObservations(qEmb, query, { type, project, limit });
      if (rows.length === 0) return { content: [{ type: 'text', text: `No observations matching "${query}".` }] };
      const lines = [`Observations: "${query}"${type ? ' [' + type + ']' : ''} — ${rows.length}`, ''];
      for (const r of rows) {
        lines.push(`#${r.id} [${r.type}] ${r.title}  (${(r.created_at || '').slice(0, 10)}${r.project ? ', ' + r.project : ''})`);
        lines.push(`   ${String(r.narrative).replace(/\s+/g, ' ').slice(0, 220)}`);
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    if (name === 'observation_index') {
      const { project, type, limit = 40 } = args;
      const rows = observationIndex({ project, type, limit });
      if (rows.length === 0) return { content: [{ type: 'text', text: 'No observations recorded yet.' }] };
      const lines = [`Observation index — ${rows.length} recent${project ? ' in ' + project : ''} (scan, then observation_search for detail):`, ''];
      for (const r of rows) lines.push(`  #${r.id} [${r.type}] ${r.day}  ${r.title}`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    if (name === 'thread_list') {
      const { min_sessions = 2, project, limit = 30 } = args;
      const rows = listThreads({ min_sessions, project, limit });
      if (rows.length === 0) return { content: [{ type: 'text', text: 'No threads (run build-threads.js).' }] };
      const lines = [`Topic-threads — span >= ${min_sessions} sessions${project ? ' · ' + project : ''} — ${rows.length}`, ''];
      for (const t of rows) {
        const ret = t.return_count ? `⤺${String(t.return_count).padStart(3)}` : '    ';
        lines.push(`#${String(t.id).padStart(3)} ${String(t.n_exchanges).padStart(4)}ex ${String(t.n_sessions).padStart(2)}sess ${String(t.n_projects).padStart(2)}proj ${ret}  ${t.label}`);
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    if (name === 'thread_search') {
      const { query, project, limit = 10 } = args;
      const emb = await embed(query);
      const rows = searchThreads(emb, query, { project, limit });
      if (rows.length === 0) return { content: [{ type: 'text', text: `No thread matching "${query}".` }] };
      const lines = [`Threads matching "${query}" — ${rows.length}`, ''];
      for (const t of rows) {
        const ret = t.return_count ? `⤺${t.return_count}` : '';
        lines.push(`#${t.id} [${t.n_exchanges}ex ${t.n_sessions}sess ${t.n_projects}proj ${ret}]  ${t.label}`);
        lines.push(`     ${(t.first_ts || '').slice(0, 10)} → ${(t.last_ts || '').slice(0, 10)} · ${JSON.parse(t.projects || '[]').join(', ')}`);
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    if (name === 'thread_detail') {
      const { id } = args;
      const data = getThread(id);
      if (!data) return { content: [{ type: 'text', text: `No thread #${id}.` }] };
      const { thread, segments } = data;
      const lines = [
        `# Thread #${thread.id}: ${thread.label}`,
        `${thread.n_exchanges} exchanges · ${thread.n_segments} segments · ${thread.n_sessions} sessions · ${thread.n_projects} projects · ${thread.return_count} returns`,
        `${(thread.first_ts || '').slice(0, 10)} → ${(thread.last_ts || '').slice(0, 10)}`,
        `projects: ${JSON.parse(thread.projects || '[]').join(', ')}`,
        '',
        'Segments in timeline order:',
      ];
      for (const s of segments) {
        lines.push(`  ${(s.ts_start || '').slice(0, 10)} ${String(s.n_exchanges).padStart(3)}ex  [${s.project}]  "${s.summary || ''}"`);
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error.message || error}` }],
      isError: true,
    };
  }
});

process.on('SIGINT', () => { closeDb(); process.exit(0); });
process.on('SIGTERM', () => { closeDb(); process.exit(0); });

async function main() {
  console.error('arca MCP server running via stdio');
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  console.error('Server error:', err);
  process.exit(1);
});
