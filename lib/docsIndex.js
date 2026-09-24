/**
 * lib/docsIndex.js
 * Local semantic index of a wiki's crawled text. Built once at `wiki add` /
 * `wiki refresh` (embedding every ~600-char passage with the local model),
 * stored next to the guild config, and queried per message with no network
 * call. Used for two things:
 *  - relevance gate: how close is the message to anything the wiki says?
 *    (cross-language: "comandos" finds a page titled "Commands")
 *  - retrieval: only the few best passages go to the AI, not the whole wiki.
 */

const fs = require('fs');
const path = require('path');
const { embed, dot, MODEL_NAME } = require('./embeddings');
const { DATA_DIR } = require('./dataDir');
const logger = require('./logger');

const PASSAGE_CHARS = 600; // the model reads ~128 tokens; longer passages get truncated
const CONTEXT_CHARS = 12000; // ~3k tokens of docs sent per answer
const TOP_PASSAGES = 8;

const memo = new Map(); // file -> { mtimeMs, index }

function indexFile(guildId, wikiName) {
    return path.join(DATA_DIR, 'index', `${guildId}-${wikiName.replace(/[^\w-]/g, '_')}.json`);
}

/** Splits docsText ("--- url ---\ntext" pages) into passages on paragraph/line boundaries. */
function toPassages(docsText) {
    const passages = [];
    for (const page of (docsText || '').split(/\n\n(?=--- https?:\/\/\S+ ---\n|--- file:\S+ ---\n)/)) {
        const m = page.match(/^--- (\S+) ---\n([\s\S]*)$/);
        if (!m) continue;
        const title = decodeURIComponent(m[1].split('/').pop() || '').replace(/[-_]/g, ' ').replace(/\.\w+$/, '');
        let buf = '';
        const flush = () => { if (buf.trim().length > 20) passages.push({ url: m[1], title, text: buf.trim() }); buf = ''; };
        for (const line of m[2].split('\n')) {
            if (buf.length + line.length > PASSAGE_CHARS && buf) flush();
            buf += (buf ? '\n' : '') + line.slice(0, PASSAGE_CHARS * 2);
        }
        flush();
    }
    return passages;
}

async function buildIndex(guildId, wikiName, docsText) {
    const passages = toPassages(docsText);
    const vectors = [];
    for (const p of passages) {
        const v = await embed(`${p.title}\n${p.text}`);
        if (!v) return null;
        vectors.push(Buffer.from(v.buffer).toString('base64'));
    }
    const file = indexFile(guildId, wikiName);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ model: MODEL_NAME, passages, vectors }));
    memo.delete(file);
    logger.log(`[FyrxAI/index] ${wikiName}: ${passages.length} passages embedded`);
    return passages.length;
}

function loadIndex(guildId, wikiName) {
    const file = indexFile(guildId, wikiName);
    let stat;
    try { stat = fs.statSync(file); } catch { return null; }
    const cached = memo.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.index;
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (raw.model !== MODEL_NAME) return null; // built with another model, needs a refresh
        const index = raw.passages.map((p, i) => {
            const b = Buffer.from(raw.vectors[i], 'base64');
            return { ...p, order: i, v: new Float32Array(b.buffer, b.byteOffset, b.length / 4) };
        });
        memo.set(file, { mtimeMs: stat.mtimeMs, index });
        return index;
    } catch (err) {
        logger.error(`[FyrxAI/index] Failed to load ${file}:`, err.message);
        return null;
    }
}

function removeIndex(guildId, wikiName) {
    fs.rmSync(indexFile(guildId, wikiName), { force: true });
}

// Exact-word bonus on top of the embedding score, for short names/commands
// ("fg", "/premium") that sentence embeddings blur.
function lexicalBonus(words, p) {
    const hay = `${p.title} ${p.text}`.toLowerCase();
    return words.filter(w => w.length >= 2 && new RegExp(`(?<![\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u').test(hay)).length;
}

/**
 * Best passages across the given wikis for a question.
 * @returns {Promise<{best: number, bestWiki: string|null, hits: Array}>} best = top cosine similarity (relevance)
 */
async function search(guildId, wikiNames, question) {
    const qv = await embed(question);
    if (!qv) return { best: 0, bestWiki: null, hits: [] };
    const words = [...new Set(question.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [])];
    const hits = [];
    for (const wiki of wikiNames) {
        for (const p of loadIndex(guildId, wiki) || []) {
            const sim = dot(qv, p.v);
            hits.push({ wiki, p, sim, score: sim + 0.04 * Math.min(lexicalBonus(words, p), 3) });
        }
    }
    hits.sort((a, b) => b.score - a.score);
    const bestHit = hits.reduce((m, h) => (h.sim > (m?.sim ?? -1) ? h : m), null);
    return { best: bestHit?.sim || 0, bestWiki: bestHit?.wiki || null, hits };
}

/** Docs excerpt for the AI: the top passages plus their neighbours, in page order. */
function buildContext(guildId, hits) {
    const picked = new Map(); // wiki:order -> passage, filled best-hit first until the budget runs out
    let total = 0;
    for (const h of hits.slice(0, TOP_PASSAGES)) {
        const index = loadIndex(guildId, h.wiki);
        for (const o of [h.p.order, h.p.order + 1, h.p.order - 1]) {
            const p = index[o];
            const key = `${h.wiki}:${o}`;
            if (!p || p.url !== h.p.url || picked.has(key) || total + p.text.length > CONTEXT_CHARS) continue;
            picked.set(key, { wiki: h.wiki, p });
            total += p.text.length;
        }
    }
    return [...picked.values()]
        .sort((a, b) => a.wiki.localeCompare(b.wiki) || a.p.order - b.p.order)
        .map(({ wiki, p }) => ({ wiki, url: p.url, text: p.text }));
}

module.exports = { buildIndex, loadIndex, removeIndex, search, buildContext, toPassages };
