#!/usr/bin/env node
/**
 * Import a claude.ai data export into the vault.
 *
 * The export is not in vault format, so this converts it into the same JSONL
 * shape Claude Code writes. Everything downstream — parser, indexer, embeddings,
 * essence, entities — then works unchanged. That was the original design call
 * back in May; the script implementing it was never committed, so this is a
 * reconstruction from the archive it left behind.
 *
 *   conversations.json      -> claude-ai-web/<conversation-uuid>.jsonl
 *   design_chats/<id>.json  -> claude-ai-design-<project-slug>/<id>.jsonl
 *
 * Idempotent: a conversation whose JSONL is already on disk byte-for-byte is
 * left alone, so re-importing a fresh export only writes what actually changed.
 * The export always contains the full history, so this is the normal case.
 *
 * Usage:
 *   node import-claude-ai.js <dir-with-zips>      # extracts, converts
 *   node import-claude-ai.js <dir> --dry-run      # report only, write nothing
 *   node import-claude-ai.js <dir> --keep-temp    # leave the extraction behind
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { StringDecoder } from 'string_decoder';

const VAULT_DIR = path.join(os.homedir(), '.claude-vault');
const SOURCE = 'claude_ai';

const NL = String.fromCharCode(10);
const BRACE_OPEN = 123;   // {
const BRACE_CLOSE = 125;  // }
const QUOTE = 34;         // "
const BACKSLASH = 92;

function slug(name) {
  return String(name || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'untitled';
}

/**
 * Yield each top-level object of a JSON array file without holding the whole
 * document in memory. conversations.json is 150MB; JSON.parse on it costs well
 * over a gigabyte of heap.
 */
function* streamArrayObjects(filePath) {
  const decoder = new StringDecoder('utf8');   // chunk boundaries split UTF-8
  const fd = fs.openSync(filePath, 'r');
  const chunk = Buffer.alloc(1 << 20);
  let buf = '';
  let scanned = 0;        // brace state already applied up to here — never re-scan
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  try {
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      buf += decoder.write(chunk.subarray(0, read));

      for (let i = scanned; i < buf.length; i++) {
        const c = buf.charCodeAt(i);
        if (inString) {
          if (escaped) escaped = false;
          else if (c === BACKSLASH) escaped = true;
          else if (c === QUOTE) inString = false;
          continue;
        }
        if (c === QUOTE) { inString = true; continue; }
        if (c === BRACE_OPEN) {
          if (depth === 0) start = i;
          depth++;
        } else if (c === BRACE_CLOSE) {
          depth--;
          if (depth === 0 && start !== -1) {
            yield JSON.parse(buf.slice(start, i + 1));
            buf = buf.slice(i + 1);
            i = -1;
            scanned = 0;
            start = -1;
          }
        }
      }
      scanned = buf.length;
      // Between objects nothing but separators is left; drop it so the buffer
      // never grows past a single conversation.
      if (depth === 0) { buf = ''; scanned = 0; }
    }
  } finally {
    fs.closeSync(fd);
  }
}

const line = (role, text, ts, sessionId) => JSON.stringify({
  type: role === 'assistant' ? 'assistant' : 'user',
  message: { role: role === 'assistant' ? 'assistant' : 'user', content: text },
  timestamp: ts,
  sessionId,
  cwd: null,
  gitBranch: null,
  isSidechain: false,
  source: SOURCE,
});

// A message carries its text in `text` (conversations) or nested inside
// `content` (design chats). Fall back to concatenating structured blocks.
function messageText(m) {
  if (typeof m.text === 'string' && m.text.length) return m.text;
  const c = m.content;
  if (typeof c === 'string') return c;
  if (c && typeof c.content === 'string') return c.content;
  if (Array.isArray(c)) {
    return c.map((b) => (typeof b === 'string' ? b : (b && b.text) || '')).join(NL).trim();
  }
  return '';
}

function writeConversation(destDir, id, rows, stats, dryRun) {
  if (!rows.length) { stats.empty++; return; }
  const body = rows.join(NL) + NL;
  const file = path.join(destDir, id + '.jsonl');
  try {
    if (fs.readFileSync(file, 'utf8') === body) { stats.unchanged++; return; }
    stats.updated++;
  } catch (_) {
    stats.created++;
  }
  if (dryRun) return;
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(file, body);
}

function importConversations(file, stats, dryRun) {
  const dest = path.join(VAULT_DIR, 'claude-ai-web');
  for (const conv of streamArrayObjects(file)) {
    const msgs = conv.chat_messages || [];
    const rows = [];
    for (const m of msgs) {
      const text = messageText(m);
      if (!text.trim()) continue;
      const role = m.sender === 'assistant' ? 'assistant' : 'user';
      rows.push(line(role, text, m.created_at || conv.created_at, conv.uuid));
    }
    stats.conversations++;
    writeConversation(dest, conv.uuid, rows, stats, dryRun);
  }
}

function importDesignChats(dir, stats, dryRun) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (_) { return; }
  for (const f of files) {
    let chat;
    try { chat = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { stats.unreadable++; continue; }
    const project = slug(chat.project && chat.project.name);
    const dest = path.join(VAULT_DIR, 'claude-ai-design-' + project);
    const rows = [];
    for (const m of chat.messages || []) {
      const text = messageText(m);
      if (!text.trim()) continue;
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      rows.push(line(role, text, m.created_at || chat.created_at, chat.uuid));
    }
    stats.conversations++;
    writeConversation(dest, chat.uuid, rows, stats, dryRun);
  }
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const keepTemp = args.includes('--keep-temp');
  const src = args.find((a) => !a.startsWith('--'));
  if (!src) {
    console.error('usage: node import-claude-ai.js <dir-with-export-zips> [--dry-run] [--keep-temp]');
    process.exit(1);
  }

  // Accept either the zip directory or an already-extracted one.
  let work = src;
  const zips = fs.existsSync(src)
    ? fs.readdirSync(src).filter((f) => f.endsWith('.zip'))
    : [];
  if (zips.length) {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ai-export-'));
    for (const z of zips) {
      execFileSync('unzip', ['-q', '-o', path.join(src, z), '-d', work], { stdio: 'ignore' });
    }
    console.error(`extracted ${zips.length} archive(s) to ${work}`);
  }

  const stats = { conversations: 0, created: 0, updated: 0, unchanged: 0, empty: 0, unreadable: 0 };

  const convFile = path.join(work, 'conversations.json');
  if (fs.existsSync(convFile)) {
    console.error('reading conversations.json...');
    importConversations(convFile, stats, dryRun);
  }
  importDesignChats(path.join(work, 'design_chats'), stats, dryRun);

  if (work !== src && !keepTemp) {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {}
  }

  console.error(
    `${dryRun ? '[dry-run] ' : ''}conversations ${stats.conversations}: ` +
    `${stats.created} new, ${stats.updated} changed, ${stats.unchanged} unchanged, ` +
    `${stats.empty} empty, ${stats.unreadable} unreadable`
  );
  if (!dryRun && (stats.created || stats.updated)) {
    console.error('next: node indexer.js   (picks the new files up incrementally)');
  }
}

main();
