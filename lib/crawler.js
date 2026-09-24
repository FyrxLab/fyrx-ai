/**
 * lib/crawler.js
 * Discovers every documentation page under a wiki's base URL, instead of
 * fetching only the single page an admin pasted. Tries, in order:
 *  1. `llms.txt` at the site root (GitBook and an increasingly common
 *     convention elsewhere) - a plain-text index of every page, often with
 *     direct links to clean markdown versions.
 *  2. `sitemap.xml` - standard for most doc generators (Docusaurus, MkDocs,
 *     ReadTheDocs, VitePress, ...).
 *  3. Fallback: fetch the base page itself and follow same-origin links one
 *     level deep.
 *
 * ponytail: crawl depth is fixed at "one hop from the seed" and capped at
 * MAX_PAGES/MAX_TOTAL_BYTES - enough for a typical plugin wiki without
 * risking a runaway crawl of an entire large docs site. If a site needs
 * deeper crawling, raise MAX_PAGES or add real depth tracking.
 */

const axios = require('axios');
const logger = require('./logger');

const MAX_PAGES = 25;
const MAX_TOTAL_BYTES = 400000; // ~100k tokens worth of raw text, generous headroom before slicing later
const FETCH_TIMEOUT_MS = 8000;
const UA = 'Mozilla/5.0 (compatible; FyrxAI-DocsCrawler/1.0)';

async function fetchText(url) {
    const res = await axios.get(url, { timeout: FETCH_TIMEOUT_MS, headers: { 'User-Agent': UA }, validateStatus: s => s === 200 });
    return { text: typeof res.data === 'string' ? res.data : JSON.stringify(res.data), contentType: res.headers?.['content-type'] || '' };
}

function originOf(url) {
    try { return new URL(url).origin; } catch { return null; }
}

/** GitBook (and similar) llms.txt: a markdown list of `[Title](url): desc` links. */
async function tryLlmsTxt(baseUrl) {
    const origin = originOf(baseUrl);
    if (!origin) return null;
    for (const candidate of [`${baseUrl.replace(/\/$/, '')}/llms.txt`, `${origin}/llms.txt`]) {
        try {
            const { text } = await fetchText(candidate);
            const urls = [...text.matchAll(/\]\((https?:\/\/[^\s)]+)\)/g)].map(m => m[1]);
            if (urls.length > 0) return [...new Set(urls)];
        } catch { /* try next candidate */ }
    }
    return null;
}

/** Standard sitemap.xml - extracts every <loc> on the same origin as baseUrl. */
async function trySitemap(baseUrl) {
    const origin = originOf(baseUrl);
    if (!origin) return null;
    try {
        const { text } = await fetchText(`${origin}/sitemap.xml`);
        const urls = [...text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(m => m[1]).filter(u => originOf(u) === origin);
        return urls.length > 0 ? [...new Set(urls)] : null;
    } catch {
        return null;
    }
}

/** Same-origin links found in the seed page's HTML, one hop only. */
function extractSameOriginLinks(html, baseUrl) {
    const origin = originOf(baseUrl);
    if (!origin) return [];
    const found = new Set();
    for (const m of html.matchAll(/href=["']([^"'#]+)["']/gi)) {
        try {
            const abs = new URL(m[1], baseUrl).href;
            if (originOf(abs) === origin && !/\.(png|jpg|jpeg|svg|gif|css|js|ico|webp)(\?|$)/i.test(abs)) {
                found.add(abs.split('#')[0]);
            }
        } catch { /* invalid URL, skip */ }
    }
    return [...found];
}

/**
 * @param {string} baseUrl
 * @returns {Promise<Array<{url: string, text: string}>>}
 */
async function crawlDocs(baseUrl) {
    let pageUrls = (await tryLlmsTxt(baseUrl)) || (await trySitemap(baseUrl));

    const seedFetch = await fetchText(baseUrl).catch(() => null);
    if (!pageUrls) {
        pageUrls = seedFetch ? extractSameOriginLinks(seedFetch.text, baseUrl) : [];
        pageUrls.unshift(baseUrl);
    }
    pageUrls = [...new Set(pageUrls)].slice(0, MAX_PAGES);

    const { stripHtml } = require('./htmlUtils');
    const pages = [];
    let totalBytes = 0;

    for (const url of pageUrls) {
        if (totalBytes >= MAX_TOTAL_BYTES) break;
        try {
            const { text: raw, contentType } = url === baseUrl && seedFetch ? seedFetch : await fetchText(url);
            const looksLikeHtml = /html/i.test(contentType) || /^\s*<(!DOCTYPE html|html)/i.test(raw);
            const text = (looksLikeHtml ? stripHtml(raw) : raw).slice(0, MAX_TOTAL_BYTES - totalBytes);
            if (text.trim().length < 20) continue; // empty/near-empty page, not worth keeping
            pages.push({ url, text });
            totalBytes += text.length;
        } catch (err) {
            logger.error(`[FyrxAI/crawler] Failed to fetch ${url}:`, err.message);
        }
    }

    return pages;
}

module.exports = { crawlDocs };
