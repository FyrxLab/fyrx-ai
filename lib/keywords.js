/**
 * lib/keywords.js
 * Asks the guild's configured AI provider to distill a crawled wiki's real
 * content into 40-100 keywords/short phrases - used to build much richer
 * semantic reference vectors (lib/semanticMatch.js) than a hand-typed
 * one-line description alone could give.
 */

const { callProvider } = require('./providers');
const logger = require('./logger');

const SYSTEM_PROMPT = `You extract search keywords from software/plugin documentation. Given raw docs text, output a flat list of 40 to 100 short keywords and short phrases (1-4 words each) that someone might type when asking a support question about this topic - feature names, command names, error/symptom terms, and synonyms. One per line, no numbering, no bullets, no explanation, nothing else.`;

/**
 * @param {Object} provider - decrypted provider config ({name, apiKey, model})
 * @param {string} docsText
 * @returns {Promise<string[]>} up to 100 keywords, or [] on failure
 */
async function generateKeywords(provider, docsText) {
    if (!provider || !docsText || docsText.trim().length < 50) return [];

    try {
        const raw = await callProvider(provider, {
            systemPrompt: SYSTEM_PROMPT,
            userMessage: docsText.slice(0, 12000)
        });
        return raw
            .split('\n')
            .map(line => line.replace(/^[-*\d.)\s]+/, '').trim().toLowerCase())
            .filter(Boolean)
            .slice(0, 100);
    } catch (err) {
        logger.error('[FyrxAI/keywords] Keyword generation failed:', err.message);
        return [];
    }
}

module.exports = { generateKeywords };
