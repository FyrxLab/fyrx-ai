/**
 * lib/embeddings.js
 * One local, offline multilingual sentence-embedding model shared by the
 * intent classifier (lib/intent.js) and the wiki index (lib/docsIndex.js).
 * Downloaded once (~120 MB) into the transformers cache, then CPU only - no
 * API key, no per-message network call. Vectors are L2-normalized, so the
 * dot product is the cosine similarity.
 */

const logger = require('./logger');

const MODEL_NAME = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';

let extractorPromise = null;

function getExtractor() {
    if (!extractorPromise) {
        extractorPromise = (async () => {
            try {
                const { pipeline } = require('@xenova/transformers');
                return await pipeline('feature-extraction', MODEL_NAME, { quantized: true });
            } catch (err) {
                logger.error('[FyrxAI/embeddings] Failed to load local model:', err.message);
                return null;
            }
        })();
    }
    return extractorPromise;
}

/** @returns {Promise<Float32Array|null>} */
async function embed(text) {
    const extractor = await getExtractor();
    if (!extractor) return null;
    const out = await extractor(text, { pooling: 'mean', normalize: true });
    return Float32Array.from(out.data);
}

function dot(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
    return sum;
}

module.exports = { embed, dot, MODEL_NAME };
