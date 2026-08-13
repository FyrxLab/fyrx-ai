const wavespeed = require('./wavespeed');
const openrouter = require('./openrouter');
const googleai = require('./googleai');
const claude = require('./claude');

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
    return impl.call({ apiKey: providerConfig.apiKey, model: providerConfig.model, systemPrompt, userMessage });
}

module.exports = { callProvider, PROVIDER_NAMES: Object.keys(PROVIDERS) };
