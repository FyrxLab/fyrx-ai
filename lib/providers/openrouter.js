const DEFAULT_MODEL = 'openrouter/auto';

/** OpenRouter's OpenAI-compatible chat completions endpoint. */
async function call({ apiKey, model, systemPrompt, userMessage }) {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'X-Title': 'FyrxAI Support Module'
        },
        body: JSON.stringify({
            model: model || DEFAULT_MODEL,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage }
            ],
            max_tokens: 700
        })
    });

    if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(`OpenRouter error ${response.status}: ${errBody.error?.message || response.statusText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('OpenRouter returned an empty response.');
    return content;
}

module.exports = { call, DEFAULT_MODEL };
