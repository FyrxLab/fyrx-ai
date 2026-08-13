/**
 * lib/htmlUtils.js
 * Strips a rendered doc-site HTML page down to plain text - most doc
 * generators (GitBook, Docusaurus, ReadTheDocs, ...) only serve HTML at
 * their normal URL, not raw markdown, and admins will naturally paste that
 * URL rather than hunting for a raw-text export.
 */
function stripHtml(text) {
    return text
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
        .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

module.exports = { stripHtml };
