const DEFAULT_MODEL = 'claude-3-haiku-20240307';

/** Claude Platform (Anthropic Messages API), raw fetch — no SDK dependency. */
async function call({ apiKey, model, systemPrompt, userMessage }) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
        },
        body: JSON.stringify({
            model: model || DEFAULT_MODEL,
            system: systemPrompt,
            max_tokens: 700,
            messages: [{ role: 'user', content: userMessage }]
        })
    });

    if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(`Claude API error ${response.status}: ${errBody.error?.message || response.statusText}`);
    }

    const data = await response.json();
    const content = data.content?.[0]?.text;
    if (!content) throw new Error('Claude returned an empty response.');
    return content;
}

module.exports = { call, DEFAULT_MODEL };
