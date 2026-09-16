let pipeline = null;

async function getPipeline() {
  if (pipeline) return pipeline;
  const { pipeline: createPipeline } = await import('@huggingface/transformers');
  console.error('Loading embedding model (first run downloads ~80MB)...');
  pipeline = await createPipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  console.error('Embedding model ready');
  return pipeline;
}

/**
 * Smart truncation: cut at sentence boundary near limit, not mid-word.
 * MiniLM has 512 token limit (~2000 chars), but we aim for 1800 with clean cuts.
 */
function smartTruncate(text, maxChars = 1800) {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSentence = cut.search(/[.!?\n][^.!?\n]*$/);
  if (lastSentence > maxChars * 0.6) return cut.slice(0, lastSentence + 1);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > maxChars * 0.8) return cut.slice(0, lastSpace);
  return cut;
}

/**
 * Generate a 384-dimension embedding for text.
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export async function embed(text) {
  const pipe = await getPipeline();
  const truncated = smartTruncate(text);
  const output = await pipe(truncated, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

/**
 * Generate embedding for an exchange (user + assistant + tools).
 * @param {string} userMessage
 * @param {string} assistantMessage
 * @param {string[]} [toolNames]
 * @returns {Promise<number[]>}
 */
export async function embedExchange(userMessage, assistantMessage, toolNames) {
  let combined = `User: ${userMessage}\n\nAssistant: ${assistantMessage}`;
  if (toolNames && toolNames.length > 0) {
    combined += `\n\nTools: ${toolNames.join(', ')}`;
  }
  return embed(combined);
}

export async function initEmbeddings() {
  await getPipeline();
}
