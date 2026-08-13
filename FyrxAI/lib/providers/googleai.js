const { GoogleGenerativeAI } = require('@google/generative-ai');

const DEFAULT_MODEL = 'gemini-2.0-flash';

/** Google AI Studio via the official SDK. */
async function call({ apiKey, model, systemPrompt, userMessage }) {
    const genAI = new GoogleGenerativeAI(apiKey);
    const genModel = genAI.getGenerativeModel({ model: model || DEFAULT_MODEL, systemInstruction: systemPrompt });
    const result = await genModel.generateContent(userMessage);
    const text = result.response.text();
    if (!text) throw new Error('Google AI Studio returned an empty response.');
    return text;
}

module.exports = { call, DEFAULT_MODEL };
