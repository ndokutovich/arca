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
 *   projects/<uuid>.json    -> claude-ai-projects/<uuid>.jsonl
 *
 * The export arrives as one zip per kind of thing, and it has grown kinds
 * since this was written. Anything unrecognised is now named in the output
 * rather than passed over, so a bucket that appears later announces itself
 * instead of being silently dropped.
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
import { fileURLToPath } from 'url';
import { StringDecoder } from 'string_decoder';
import { slug, line as transcriptLine, messageText, writeConversation, newStats }
  from './lib/transcript-write.js';

const VAULT_DIR = path.join(os.homedir(), '.claude-vault');
const SOURCE = 'claude_ai';

const NL = String.fromCharCode(10);
const BRACE_OPEN = 123;   // {
const BRACE_CLOSE = 125;  // }
const QUOTE = 34;         // "
const BACKSLASH = 92;

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
    // A file cut short mid-array leaves the scanner inside an object or a
    // string. Reporting that as a clean import silently drops the conversation
    // it stopped in — and every one after it, if the truncation is early.
    if (depth !== 0 || inString) {
      throw new Error(`${filePath} ends inside a JSON value — the export looks truncated`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

// Same shape as every other source; only the tag differs.
const line = (role, text, ts, sessionId) =>
  transcriptLine({ role, text, ts, sessionId, source: SOURCE });

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

// A claude.ai Project is not a conversation — it is the standing context the
// user wrote for one: a description, a prompt template, and knowledge
// documents. None of it appears in any transcript, and it is often the most
// deliberate writing in the whole export. Rendered as a one-turn transcript so
// the rest of the pipeline needs no special case.
function importProjects(dir, stats, dryRun) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (_) { return; }
  const dest = path.join(VAULT_DIR, 'claude-ai-projects');
  for (const f of files) {
    let proj;
    try { proj = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { stats.unreadable++; continue; }

    const parts = [];
    if (proj.description) parts.push('## Description' + NL + NL + proj.description);
    if (proj.prompt_template) parts.push('## Instructions' + NL + NL + proj.prompt_template);
    for (const doc of proj.docs || []) {
      if (!doc || !doc.content) continue;
      parts.push('## ' + (doc.filename || 'document') + NL + NL + doc.content);
    }

    stats.conversations++;
    if (!parts.length) { stats.empty++; continue; }

    const when = proj.created_at || proj.updated_at;
    const rows = [
      line('user', 'Project: ' + (proj.name || proj.uuid), when, proj.uuid),
      line('assistant', parts.join(NL + NL), proj.updated_at || when, proj.uuid),
    ];
    writeConversation(dest, proj.uuid, rows, stats, dryRun);
  }
}

/**
 * Convert a claude.ai export into vault transcripts.
 * Returns the tally so a caller can report it however it likes.
 */
export function runImport(src, { dryRun = false, keepTemp = false, log = console.error } = {}) {
  if (!src) throw new Error('an export directory is required');
  if (!fs.existsSync(src)) throw new Error(`no such directory: ${src}`);

  // Accept either the zip directory or an already-extracted one.
  let work = src;
  const zips = fs.existsSync(src)
    ? fs.readdirSync(src).filter((f) => f.endsWith('.zip'))
    : [];
  if (zips.length) {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ai-export-'));
    for (const z of zips) {
      try {
        execFileSync('unzip', ['-q', '-o', path.join(src, z), '-d', work], { stdio: 'ignore' });
      } catch (e) {
        throw new Error(
          `could not run unzip on ${z}. arca shells out to unzip, which a plain Windows install does not have — ` +
          `extract the export yourself and pass the directory instead. (${(e && e.message) || e})`
        );
      }
    }
    log(`extracted ${zips.length} archive(s) to ${work}`);
  }

  const stats = newStats();

  try {
    const convFile = path.join(work, 'conversations.json');
    if (fs.existsSync(convFile)) {
      log('reading conversations.json...');
      importConversations(convFile, stats, dryRun);
    }
    importDesignChats(path.join(work, 'design_chats'), stats, dryRun);
    importProjects(path.join(work, 'projects'), stats, dryRun);

    // Everything the export contained that nothing above reads. users.json and
    // login_history.json are deliberately skipped -- they are account records,
    // not history, and one of them holds a phone number. Anything else is a
    // bucket this importer has not learned yet, and saying so is how the next
    // one gets noticed.
    const KNOWN = new Set([
      'conversations.json', 'design_chats', 'projects',
      'users.json', 'login_history.json',
    ]);
    let present = [];
    try { present = fs.readdirSync(work); } catch (_) { /* nothing to report */ }
    const unknown = present.filter((e) => !KNOWN.has(e));
    if (unknown.length) {
      stats.unknown = unknown;
      log('not imported, unrecognised: ' + unknown.join(', '));
    }
  } finally {
    // An export is a full copy of someone's conversation history. Leaving it
    // unpacked in the temp directory because the parse threw is the one case
    // where cleanup matters most.
    if (work !== src && !keepTemp) {
      try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    }
  }

  return stats;
}

function main() {
  const args = process.argv.slice(2);
  const src = args.find((a) => !a.startsWith('--'));
  if (!src) {
    console.error('usage: node import-claude-ai.js <dir-with-export-zips> [--dry-run] [--keep-temp]');
    process.exit(1);
  }
  const dryRun = args.includes('--dry-run');
  const stats = runImport(src, { dryRun, keepTemp: args.includes('--keep-temp') });
  console.error(
    `${dryRun ? '[dry-run] ' : ''}conversations ${stats.conversations}: ` +
    `${stats.created} new, ${stats.updated} changed, ${stats.unchanged} unchanged, ` +
    `${stats.empty} empty, ${stats.unreadable} unreadable`
  );
  if (!dryRun && (stats.created || stats.updated)) {
    console.error('next: arca index   (picks the new files up incrementally)');
  }
}

// Only self-run when invoked directly; `arca import` calls runImport().
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
