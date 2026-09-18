// 384-dimension sentence embeddings from all-MiniLM-L6-v2, run directly on
// ONNX Runtime.
//
// This used to go through @huggingface/transformers, which brought 174 MB of
// things this file never asks for: a browser ONNX runtime that is never loaded
// under Node, and an image-processing native binary that was loaded on every
// single embedding. What is actually needed is a tokenizer, one session, a
// mean pool and a normalize.
//
// The arithmetic below mirrors transformers.js down to where the rounding
// happens, because the vectors in the index were produced by it.
import fs from 'node:fs';
import path from 'node:path';
import { loadTokenizer } from './tokenizer.js';
import { ensureModel } from './model.js';

const HIDDEN = 384;

let ready = null;

async function getModel() {
  if (ready) return ready;
  ready = (async () => {
    const dir = await ensureModel();
    const ort = (await import('onnxruntime-node')).default;
    const tokenizer = loadTokenizer(
      JSON.parse(fs.readFileSync(path.join(dir, 'tokenizer.json'), 'utf8')),
    );
    const session = await ort.InferenceSession.create(path.join(dir, 'onnx', 'model.onnx'));
    return { ort, tokenizer, session };
  })().catch((e) => { ready = null; throw e; });
  return ready;
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

// Sum along the sequence, divide by the unmasked count, then scale to unit
// length. Accumulating in a plain number and storing once is what gives the
// same float32 as transformers.js; summing into the Float32Array would round
// on every token instead.
function pool(data, seq) {
  const out = new Float32Array(HIDDEN);
  for (let k = 0; k < HIDDEN; k++) {
    let sum = 0;
    for (let j = 0; j < seq; j++) sum += data[j * HIDDEN + k];
    out[k] = sum / seq;
  }
  let norm = 0;
  for (let k = 0; k < HIDDEN; k++) norm += out[k] ** 2;
  norm = norm ** 0.5;
  for (let k = 0; k < HIDDEN; k++) out[k] /= norm;
  return out;
}

/**
 * Generate a 384-dimension embedding for text.
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export async function embed(text) {
  const { ort, tokenizer, session } = await getModel();
  const ids = tokenizer.encode(smartTruncate(text));
  const seq = ids.length;

  // One sequence per call, so nothing is padded and the attention mask is all
  // ones — which is why the pool above can divide by the length.
  const dims = [1, seq];
  const big = BigInt64Array.from(ids, BigInt);
  const ones = new BigInt64Array(seq).fill(1n);
  const zeros = new BigInt64Array(seq);

  const out = await session.run({
    input_ids: new ort.Tensor('int64', big, dims),
    attention_mask: new ort.Tensor('int64', ones, dims),
    token_type_ids: new ort.Tensor('int64', zeros, dims),
  });

  return Array.from(pool(out.last_hidden_state.data, seq));
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
  await getModel();
}
