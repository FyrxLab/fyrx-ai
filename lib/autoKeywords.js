/**
 * lib/autoKeywords.js
 * Regex-based keyword extraction from crawled docs text — runs automatically
 * on every `.wiki add`/`wiki refresh`, no AI provider required. This is what
 * guarantees a wiki always has *some* real vocabulary for semantic matching
 * (lib/semanticMatch.js) even before/without an AI provider being configured;
 * lib/keywords.js's AI-generated list, when available, is merged on top.
 *
 * Pulls from the parts of docs text that are already curated by the doc's
 * author and cheap to mine without any NLP: section headers, inline-code
 * spans (command syntax, config keys), and %placeholder% style variables.
 */

const MAX_KEYWORDS = 100;

function extractHeaders(text) {
    return [...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map(m => m[1].trim());
}

function extractInlineCode(text) {
    return [...text.matchAll(/`([^`\n]{2,40})`/g)].map(m => m[1].trim());
}

function extractPlaceholders(text) {
    return [...text.matchAll(/%[\w.\-]+%/g)].map(m => m[0]);
}

function extractSlashCommands(text) {
    return [...text.matchAll(/\/[a-z][\w-]*(?:\s+[a-z][\w-]*){0,2}/gi)].map(m => m[0].trim());
}

/**
 * @param {string} docsText
 * @returns {string[]} up to MAX_KEYWORDS deduplicated keywords
 */
function extractKeywords(docsText) {
    if (!docsText) return [];

    const raw = [
        ...extractHeaders(docsText),
        ...extractInlineCode(docsText),
        ...extractPlaceholders(docsText),
        ...extractSlashCommands(docsText)
    ];

    const seen = new Set();
    const keywords = [];
    for (const k of raw) {
        const cleaned = k.replace(/\s+/g, ' ').trim().toLowerCase();
        if (!cleaned || cleaned.length > 60 || seen.has(cleaned)) continue;
        seen.add(cleaned);
        keywords.push(cleaned);
        if (keywords.length >= MAX_KEYWORDS) break;
    }
    return keywords;
}

module.exports = { extractKeywords };
