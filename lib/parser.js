import fs from 'fs';
import readline from 'readline';
import crypto from 'crypto';
import { isSystemNoise } from './noise.js';
import { classifyPrompt } from './control.js';

/**
 * @typedef {Object} ToolCall
 * @property {string} id
 * @property {string} turnId
 * @property {string} toolName
 * @property {string} [toolInput]
 * @property {boolean} isError
 * @property {string} timestamp
 */

/**
 * @typedef {Object} Turn
 * @property {string} id - MD5 hash of content (not position — survives reindexing)
 * @property {string} project
 * @property {string} timestamp
 * @property {string} promptText
 * @property {string} replyText
 * @property {string} transcriptPath
 * @property {number} firstLine
 * @property {number} lastLine
 * @property {string} [sessionId]
 * @property {string} [cwd]
 * @property {string} [branch]
 * @property {boolean} [fromAgent]
 * @property {string} [source]
 * @property {ToolCall[]} [toolCalls]
 */

/**
 * Parse a JSONL transcript into turns (user→assistant pairs).
 * Turn ID = MD5 of user+assistant content — stable across re-indexes.
 *
 * @param {string} filePath
 * @param {string} project
 * @returns {Promise<Turn[]>}
 */
export async function parseTranscript(filePath, project) {
  const turns = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  let lineNo = 0;
  let current = null;

  const finalize = () => {
    if (!current || current.assistantParts.length === 0) return;

    const replyText = current.assistantParts.join('\n\n');
    const bodyHash = crypto
      .createHash('md5')
      .update(current.promptText + '\n' + replyText)
      .digest('hex');

    // Content alone is not identity. Keyed on the hash of the two messages,
    // the same turn occurring twice — a repeated question in another
    // project, a retried prompt later in the same session — collapsed onto one
    // primary key, and whichever was indexed last silently overwrote the other.
    // Episodes are told apart by where they happened; the content hash stays
    // alongside so identical text is still recognisable as such.
    //
    // sessionId is missing from a few older transcripts, so the transcript path
    // is the fallback. Both are stable across re-parses of the same file, which
    // is what keeps incremental indexing idempotent.
    const id = crypto
      .createHash('md5')
      .update([project || '', current.sessionId || filePath, String(current.promptLine), bodyHash].join(String.fromCharCode(0)))
      .digest('hex');

    turns.push({
      id,
      bodyHash,
      project,
      timestamp: current.timestamp,
      promptText: current.promptText,
      replyText,
      transcriptPath: filePath,
      firstLine: current.promptLine,
      lastLine: current.lastLine,
      sessionId: current.sessionId,
      cwd: current.cwd,
      branch: current.branch,
      fromAgent: current.fromAgent || false,
      source: current.source || 'claude_code',
      isNoise: isSystemNoise(current.promptText),
      promptClass: classifyPrompt(current.promptText),
      toolCalls: current.toolCalls.length > 0 ? current.toolCalls : undefined,
    });
  };

  for await (const line of rl) {
    lineNo++;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (parsed.type !== 'user' && parsed.type !== 'assistant') continue;
    if (!parsed.message) continue;

    const text = extractText(parsed.message.content);
    const toolCalls = parsed.message.role === 'assistant'
      ? extractToolCalls(parsed.message.content, parsed.timestamp)
      : [];

    if (!text.trim() && toolCalls.length === 0) continue;

    // Skip episodic-memory summarizer turns
    if (parsed.message.role === 'user' && text.includes('Context: This summary will be shown')) continue;

    if (parsed.message.role === 'user') {
      finalize();
      current = {
        promptText: text || '(tool results)',
        promptLine: lineNo,
        lastLine: lineNo,
        timestamp: parsed.timestamp || new Date().toISOString(),
        sessionId: parsed.sessionId,
        cwd: parsed.cwd,
        branch: parsed.gitBranch,
        fromAgent: parsed.isSidechain,
        source: parsed.source,
        assistantParts: [],
        toolCalls: [],
      };
    } else if (parsed.message.role === 'assistant' && current) {
      if (text.trim()) current.assistantParts.push(text);
      current.lastLine = lineNo;
      if (toolCalls.length > 0) current.toolCalls.push(...toolCalls);
      if (parsed.timestamp) current.timestamp = parsed.timestamp;
      if (parsed.sessionId) current.sessionId = parsed.sessionId;
      if (parsed.cwd) current.cwd = parsed.cwd;
      if (parsed.gitBranch) current.branch = parsed.gitBranch;
    }
  }

  finalize();
  return turns;
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(b => b.type === 'text' && b.text)
    .map(b => b.text)
    .join('\n');
}

function extractToolCalls(content, timestamp) {
  if (!Array.isArray(content)) return [];
  return content
    .filter(b => b.type === 'tool_use')
    .map(b => ({
      id: crypto.randomUUID(),
      turnId: '',
      toolName: b.name || 'unknown',
      toolInput: b.input ? JSON.stringify(b.input) : undefined,
      isError: false,
      timestamp: timestamp || new Date().toISOString(),
    }));
}
