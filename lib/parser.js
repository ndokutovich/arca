import fs from 'fs';
import readline from 'readline';
import crypto from 'crypto';
import { isSystemNoise } from './noise.js';
import { classifyPrompt } from './control.js';

/**
 * @typedef {Object} ToolCall
 * @property {string} id
 * @property {string} exchangeId
 * @property {string} toolName
 * @property {string} [toolInput]
 * @property {boolean} isError
 * @property {string} timestamp
 */

/**
 * @typedef {Object} Exchange
 * @property {string} id - MD5 hash of content (not position — survives reindexing)
 * @property {string} project
 * @property {string} timestamp
 * @property {string} userMessage
 * @property {string} assistantMessage
 * @property {string} archivePath
 * @property {number} lineStart
 * @property {number} lineEnd
 * @property {string} [sessionId]
 * @property {string} [cwd]
 * @property {string} [gitBranch]
 * @property {boolean} [isSidechain]
 * @property {string} [source]
 * @property {ToolCall[]} [toolCalls]
 */

/**
 * Parse a JSONL transcript into exchanges (user→assistant pairs).
 * Exchange ID = MD5 of user+assistant content — stable across re-indexes.
 *
 * @param {string} filePath
 * @param {string} project
 * @returns {Promise<Exchange[]>}
 */
export async function parseTranscript(filePath, project) {
  const exchanges = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  let lineNumber = 0;
  let current = null;

  const finalize = () => {
    if (!current || current.assistantParts.length === 0) return;

    const assistantMessage = current.assistantParts.join('\n\n');
    const contentHash = crypto
      .createHash('md5')
      .update(current.userMessage + '\n' + assistantMessage)
      .digest('hex');

    exchanges.push({
      id: contentHash,
      project,
      timestamp: current.timestamp,
      userMessage: current.userMessage,
      assistantMessage,
      archivePath: filePath,
      lineStart: current.userLine,
      lineEnd: current.lastLine,
      sessionId: current.sessionId,
      cwd: current.cwd,
      gitBranch: current.gitBranch,
      isSidechain: current.isSidechain || false,
      source: current.source || 'claude_code',
      isSystemNoise: isSystemNoise(current.userMessage),
      promptKind: classifyPrompt(current.userMessage),
      toolCalls: current.toolCalls.length > 0 ? current.toolCalls : undefined,
    });
  };

  for await (const line of rl) {
    lineNumber++;
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

    // Skip episodic-memory summarizer exchanges
    if (parsed.message.role === 'user' && text.includes('Context: This summary will be shown')) continue;

    if (parsed.message.role === 'user') {
      finalize();
      current = {
        userMessage: text || '(tool results)',
        userLine: lineNumber,
        lastLine: lineNumber,
        timestamp: parsed.timestamp || new Date().toISOString(),
        sessionId: parsed.sessionId,
        cwd: parsed.cwd,
        gitBranch: parsed.gitBranch,
        isSidechain: parsed.isSidechain,
        source: parsed.source,
        assistantParts: [],
        toolCalls: [],
      };
    } else if (parsed.message.role === 'assistant' && current) {
      if (text.trim()) current.assistantParts.push(text);
      current.lastLine = lineNumber;
      if (toolCalls.length > 0) current.toolCalls.push(...toolCalls);
      if (parsed.timestamp) current.timestamp = parsed.timestamp;
      if (parsed.sessionId) current.sessionId = parsed.sessionId;
      if (parsed.cwd) current.cwd = parsed.cwd;
      if (parsed.gitBranch) current.gitBranch = parsed.gitBranch;
    }
  }

  finalize();
  return exchanges;
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
      exchangeId: '',
      toolName: b.name || 'unknown',
      toolInput: b.input ? JSON.stringify(b.input) : undefined,
      isError: false,
      timestamp: timestamp || new Date().toISOString(),
    }));
}
