/**
 * lib/crawler.js
 * Discovers every documentation page under a wiki's base URL, instead of
 * fetching only the single page an admin pasted. Tries, in order:
 *  1. `llms.txt` at the site root or the given path (GitBook and an increasingly common
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
    return {
        text: typeof res.data === 'string' ? res.data : JSON.stringify(res.data),
        contentType: res.headers?.['content-type'] || '',
        finalUrl: res.request?.res?.responseUrl || url // after redirects (docs.x.com -> x.com/docs)
    };
}

function originOf(url) {
    try { return new URL(url).origin; } catch { return null; }
}

/**
 * Origin + path of the URL the admin pasted, without trailing slash. Crawled
 * pages must live under it: for a wiki at github.com/org/repo/wiki, the
 * site-wide github.com/llms.txt and sitemap describe unrelated pages.
 */
function scopeOf(url) {
    try { const u = new URL(url); return (u.origin + u.pathname).replace(/\/$/, ''); } catch { return null; }
}

function inScope(url, scope) {
    return url === scope || url.startsWith(scope + '/');
}

/** GitBook (and similar) llms.txt: a markdown list of `[Title](url): desc` links. */
async function tryLlmsTxt(baseUrl) {
    const origin = originOf(baseUrl);
    if (!origin) return null;
    for (const candidate of [`${baseUrl.replace(/\/$/, '')}/llms.txt`, `${origin}/llms.txt`]) {
        try {
            const { text } = await fetchText(candidate);
            const urls = [...text.matchAll(/\]\((https?:\/\/[^\s)]+)\)/g)].map(m => m[1]).filter(u => inScope(u, scopeOf(baseUrl)));
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
        const urls = [...text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(m => m[1]).filter(u => inScope(u, scopeOf(baseUrl)));
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
            if (inScope(abs.split('#')[0].replace(/\/$/, ''), scopeOf(baseUrl)) && !/\.(png|jpg|jpeg|svg|gif|css|js|ico|webp)(\?|$)|\/(_history|_compare|_edit|_new)(\/|$)/i.test(abs)) {
                found.add(abs.split('#')[0]);
            }
        } catch { /* invalid URL, skip */ }
    }
    return [...found];
}

/** Downloads each page and turns it into plain text; failed/empty pages are skipped. */
async function fetchPages(pageUrls, seedFetch) {
    const { stripHtml } = require('./htmlUtils');
    const pages = [];
    let totalBytes = 0;

    for (const url of pageUrls) {
        if (totalBytes >= MAX_TOTAL_BYTES) break;
        try {
            const { text: raw, contentType } = seedFetch && url === seedFetch.url ? seedFetch : await fetchText(url);
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

/** A local folder of .md/.txt/.html files as a wiki: fully offline, edit the files and refresh. */
function readLocalDocs(dir) {
    const fs = require('fs');
    const path = require('path');
    const { stripHtml } = require('./htmlUtils');
    const pages = [];
    let totalBytes = 0;
    for (const rel of fs.readdirSync(dir, { recursive: true }).sort()) {
        if (!/\.(md|markdown|txt|html?)$/i.test(rel) || totalBytes >= MAX_TOTAL_BYTES) continue;
        const raw = fs.readFileSync(path.join(dir, rel), 'utf8');
        const text = (/\.html?$/i.test(rel) ? stripHtml(raw) : raw).slice(0, MAX_TOTAL_BYTES - totalBytes);
        if (text.trim().length < 20) continue;
        pages.push({ url: `file:${String(rel).replace(/\\/g, '/').replace(/\s/g, '%20')}`, text });
        totalBytes += text.length;
    }
    return pages;
}

function isLocalDir(source) {
    try { return !/^https?:\/\//i.test(source) && require('fs').statSync(source).isDirectory(); } catch { return false; }
}

/**
 * Discovers and downloads every page under a doc site (or reads a local folder).
 * @returns {Promise<Array<{url: string, text: string}>>}
 */
async function crawlDocs(inputUrl) {
    if (isLocalDir(inputUrl)) return readLocalDocs(inputUrl);

    const seedFetch = await fetchText(inputUrl).catch(() => null);
    const baseUrl = (seedFetch?.finalUrl || inputUrl).replace(/\/$/, '');

    let pageUrls = (await tryLlmsTxt(baseUrl)) || (await trySitemap(baseUrl));
    if (!pageUrls) {
        pageUrls = seedFetch ? extractSameOriginLinks(seedFetch.text, seedFetch.finalUrl) : [];
        pageUrls.unshift(baseUrl);
    }
    pageUrls = [...new Set(pageUrls.map(u => u.replace(/\/$/, '')))].slice(0, MAX_PAGES);

    return fetchPages(pageUrls, seedFetch && { ...seedFetch, url: baseUrl });
}

/**
 * Refresh without discovery: re-downloads only the routes already stored for
 * the wiki (or re-reads the local folder). No AI, no link-following.
 */
async function refreshRoutes(source, routes) {
    if (isLocalDir(source)) return readLocalDocs(source);
    return fetchPages(routes.filter(r => /^https?:\/\//.test(r)));
}

/** Page URLs stored in a wiki's docsText ("--- url ---" headers). */
function routesOf(docsText) {
    return [...(docsText || '').matchAll(/^--- (\S+) ---$/gm)].map(m => m[1]);
}

module.exports = { crawlDocs, refreshRoutes, routesOf };
