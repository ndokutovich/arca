import fs from 'fs';

/**
 * Read a JSONL conversation and format as markdown.
 * Supports line-range pagination (1-indexed).
 */
export function showConversation(filePath, startLine, endLine) {
  const content = fs.readFileSync(filePath, 'utf-8');
  let lines = content.split('\n').filter(l => l.trim());

  const totalLines = lines.length;

  if (startLine || endLine) {
    const start = (startLine || 1) - 1;
    const end = endLine || totalLines;
    lines = lines.slice(start, end);
  }

  let out = '';
  const rangeInfo = startLine || endLine
    ? ` (lines ${startLine || 1}-${endLine || totalLines} of ${totalLines})`
    : ` (${totalLines} lines)`;
  out += `# Conversation${rangeInfo}\n\n`;

  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (!parsed.message) continue;
    const { role, content: msgContent } = parsed.message;

    if (role !== 'user' && role !== 'assistant') continue;

    const text = extractText(msgContent);
    const toolUses = extractToolUses(msgContent);
    const ts = parsed.timestamp ? ` _${parsed.timestamp.slice(0, 19)}_` : '';

    if (role === 'user') {
      out += `## User${ts}\n\n${text || '(tool results)'}\n\n`;
    } else {
      out += `## Assistant${ts}\n\n`;
      if (text) out += `${text}\n\n`;
      if (toolUses.length > 0) {
        for (const tu of toolUses) {
          out += `> **Tool**: ${tu.name}\n`;
          if (tu.inputSnippet) out += `> Input: \`${tu.inputSnippet}\`\n`;
          out += '\n';
        }
      }
    }
  }

  return out;
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(b => b.type === 'text' && b.text)
    .map(b => b.text)
    .join('\n');
}

function extractToolUses(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter(b => b.type === 'tool_use')
    .map(b => ({
      name: b.name || 'unknown',
      inputSnippet: b.input ? JSON.stringify(b.input).slice(0, 120) : null,
    }));
}
