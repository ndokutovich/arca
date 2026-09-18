import fs from 'fs';

// Reading ten lines out of a broken 500 MB transcript used to allocate the
// whole file, then a split of it, then a filtered copy — three times the file
// in memory for a request that wanted a few hundred bytes, reachable straight
// from the MCP read tool. Chunks are read and discarded as they go instead.
const CHUNK = 1 << 20;

// Without a range, an unbounded read is still an unbounded read. Show the head
// and say what was left out rather than returning a transcript nobody asked for.
const DEFAULT_MAX_LINES = 2000;

/**
 * Collect the requested line range without holding the whole file.
 * Returns { lines, scanned, truncated } where `scanned` counts non-empty lines
 * seen so far — it is the exact total only when the file was read to its end.
 */
function collect(filePath, start, end) {
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(CHUNK);
  const lines = [];
  let carry = '';
  let scanned = 0;
  let truncated = false;

  try {
    for (;;) {
      const read = fs.readSync(fd, buf, 0, CHUNK, null);
      if (read === 0) break;
      const text = carry + buf.toString('utf8', 0, read);
      const parts = text.split('\n');
      carry = parts.pop() ?? '';

      for (const part of parts) {
        if (!part.trim()) continue;
        scanned++;
        if (scanned >= start && scanned <= end) lines.push(part);
      }
      if (scanned > end) { truncated = true; break; }
    }
    if (!truncated && carry.trim()) {
      scanned++;
      if (scanned >= start && scanned <= end) lines.push(carry);
    }
  } finally {
    fs.closeSync(fd);
  }

  return { lines, scanned, truncated };
}

/**
 * Read a JSONL conversation and format as markdown.
 * Supports line-range pagination (1-indexed).
 */
export function showConversation(filePath, startLine, endLine) {
  const ranged = Boolean(startLine || endLine);
  const start = startLine || 1;
  const end = endLine || (ranged ? Number.MAX_SAFE_INTEGER : start + DEFAULT_MAX_LINES - 1);

  const { lines, scanned, truncated } = collect(filePath, start, end);

  // `scanned` is the whole file only when nothing stopped the read early.
  const total = truncated ? `${scanned}+` : String(scanned);
  const rangeInfo = ranged
    ? ` (lines ${start}-${endLine || scanned} of ${total})`
    : truncated
      ? ` (first ${lines.length} lines of ${total}; pass startLine/endLine for the rest)`
      : ` (${scanned} lines)`;

  let out = '';
  out += `# Conversation${rangeInfo}\n\n`;

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = entry.message;
    if (!msg || !msg.role) continue;

    const text = typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.map((b) => (typeof b === 'string' ? b : b?.text || '')).join('\n')
        : '';
    if (!text.trim()) continue;

    const who = msg.role === 'user' ? 'User' : 'Assistant';
    const when = entry.timestamp ? ` · ${String(entry.timestamp).slice(0, 19)}` : '';
    out += `## ${who}${when}\n\n${text.trim()}\n\n`;
  }

  return out;
}
