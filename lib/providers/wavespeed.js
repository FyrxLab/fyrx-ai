const logger = require('../logger');

const DEFAULT_MODEL = 'anthropic/claude-3-haiku';

/** WaveSpeed's OpenAI-compatible chat completions endpoint. */
async function call({ apiKey, model, systemPrompt, userMessage }) {
    const response = await fetch('https://llm.wavespeed.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
            model: model || DEFAULT_MODEL,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage }
            ],
            max_tokens: 700,
            temperature: 0.4
        })
    });

    if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(`WaveSpeed error ${response.status}: ${errBody.error?.message || response.statusText}`);
    }

    const data = await response.json();
    if (data.usage) logger.log(`[FyrxAI/AI] wavespeed usage prompt_tokens=${data.usage.prompt_tokens} completion_tokens=${data.usage.completion_tokens}`);
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('WaveSpeed returned an empty response.');
    return content;
}

module.exports = { call, DEFAULT_MODEL };
