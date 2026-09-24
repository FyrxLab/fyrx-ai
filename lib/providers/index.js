const wavespeed = require('./wavespeed');
const openrouter = require('./openrouter');
const googleai = require('./googleai');
const claude = require('./claude');

const logger = require('../logger');

const PROVIDERS = { wavespeed, openrouter, googleai, claude };

/**
 * Single entry point for every configured AI provider — the rest of the
 * module never talks to a provider's API directly.
 * @param {{name: string, apiKey: string, model?: string}} providerConfig
 * @param {{systemPrompt: string, userMessage: string}} payload
 * @returns {Promise<string>}
 */
async function callProvider(providerConfig, { systemPrompt, userMessage }) {
    const impl = PROVIDERS[providerConfig?.name];
    if (!impl) {
        throw new Error(`Unknown or unconfigured AI provider: "${providerConfig?.name}". Valid: ${Object.keys(PROVIDERS).join(', ')}`);
    }
    const started = Date.now();
    const tag = `[FyrxAI/AI] provider=${providerConfig.name} model=${providerConfig.model || 'default'}`;
    try {
        const out = await impl.call({ apiKey: providerConfig.apiKey, model: providerConfig.model, systemPrompt, userMessage });
        logger.log(`${tag} ok ms=${Date.now() - started} promptChars=${systemPrompt.length + userMessage.length} replyChars=${out.length}`);
        return out;
    } catch (err) {
        logger.error(`${tag} FAILED ms=${Date.now() - started}:`, err.message);
        throw err;
    }
}

module.exports = { callProvider, PROVIDER_NAMES: Object.keys(PROVIDERS) };
