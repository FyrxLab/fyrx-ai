const logger = require('./logger');
/**
 * lib/semanticMatch.js
 * Local (no network per-call) semantic fallback for detectSources(): when a
 * message doesn't literally name one of the guild's configured wiki sources,
 * embed it with a small local ONNX model and compare it against reference
 * vectors built from each source's name + admin-provided description.
 *
 * Two accuracy improvements over a naive "one phrase per class, fixed
 * threshold" setup:
 *  - Template augmentation: each source gets several paraphrased reference
 *    phrases ("problem with X", "how does X work", "error in X", ...)
 *    instead of just its bare name/description, since a 2-4 word description
 *    alone embeds poorly for an intent-style query.
 *  - Margin check: the top match must beat the runner-up by MARGIN, not just
 *    clear the absolute threshold — catches messages that sit ambiguously
 *    between two sources instead of confidently picking whichever is first.
 *
 * Always available offline (no provider/API key needed) — this is the "local
 * model" referenced in the README, separate from the 4 answer-generating
 * providers in lib/providers/.
 */

const SIMILARITY_THRESHOLD = 0.45;
const MARGIN = 0.05;
const MODEL_NAME = 'Xenova/paraphrase-MiniLM-L3-v2';

const TEMPLATES = [
    '{s}',
    'problem with {s}',
    'error in {s}',
    'how does {s} work',
    'how do I set up {s}',
    "{s} isn't working",
    'help with {s}'
];

let extractorPromise = null;
// guildId -> { hash, vectorsPromise } — rebuilt only when the guild's wikis change.
const guildVectorCache = new Map();

function getExtractor() {
    if (!extractorPromise) {
        extractorPromise = (async () => {
            try {
                const { pipeline } = require('@xenova/transformers');
                return await pipeline('feature-extraction', MODEL_NAME, { quantized: true });
            } catch (err) {
                logger.error('[FyrxAI/semanticMatch] Failed to load local model, semantic fallback disabled:', err.message);
                return null;
            }
        })();
    }
    return extractorPromise;
}

async function embed(extractor, text) {
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    return output.data;
}

function dot(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
    return sum;
}

function wikisHash(wikis) {
    return Object.entries(wikis).map(([k, v]) => `${k}:${v.description || ''}:${(v.keywords || []).length}`).sort().join('|');
}

async function getGuildVectors(guildId, wikis) {
    const hash = wikisHash(wikis);
    const cached = guildVectorCache.get(guildId);
    if (cached && cached.hash === hash) return cached.vectorsPromise;

    const extractor = await getExtractor();
    const vectorsPromise = (async () => {
        if (!extractor) return null;
        const vectors = {};
        for (const [name, info] of Object.entries(wikis)) {
            const subject = info.description ? `${name}: ${info.description}` : name;
            // Template-paraphrased reference phrases (robust for short queries)
            // plus, when available, the AI-generated keyword list crawled from
            // the real docs (lib/keywords.js) - each keyword embedded on its
            // own gives much denser coverage of the topic's actual vocabulary
            // than the hand-written description alone.
            const phrases = [...TEMPLATES.map(t => t.replace('{s}', subject)), ...(info.keywords || [])];
            vectors[name] = await Promise.all(phrases.map(p => embed(extractor, p)));
        }
        return vectors;
    })();

    guildVectorCache.set(guildId, { hash, vectorsPromise });
    return vectorsPromise;
}

/**
 * Best-guess source name for a message that named none explicitly.
 * @param {string} guildId
 * @param {Object} wikis - config.wikis, { name: { url, description } }
 * @param {string} content
 * @returns {Promise<string|null>}
 */
async function classifySource(guildId, wikis, content) {
    if (!content || content.trim().length < 8 || Object.keys(wikis).length === 0) return null;

    const extractor = await getExtractor();
    if (!extractor) return null;
    const referenceVectors = await getGuildVectors(guildId, wikis);
    if (!referenceVectors) return null;

    const vec = await embed(extractor, content);
    const scored = Object.entries(referenceVectors)
        .map(([name, refVecs]) => ({ name, score: Math.max(...refVecs.map(rv => dot(vec, rv))) }))
        .sort((a, b) => b.score - a.score);

    if (scored.length === 0) return null;
    const [best, second] = scored;
    if (best.score < SIMILARITY_THRESHOLD) return null;
    if (second && best.score - second.score < MARGIN) return null; // too ambiguous
    return best.name;
}

module.exports = { classifySource };
