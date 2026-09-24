/**
 * lib/supportAgent.js
 * Generic automated support agent. Runs on every message inside a guild's
 * configured support channels — no mention needed. Fully data-driven: every
 * "product"/topic it can answer about is a wiki source an admin registered
 * via `.fyrxai wiki add`, nothing is hardcoded here.
 */

const { classifySource } = require('./semanticMatch');
const { callProvider } = require('./providers');
const { buildSupportEmbed } = require('./embeds');
const { getGuildConfig, getDecryptedProvider } = require('./config');
const logger = require('./logger');

const CLARIFICATION_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Hard ceiling on paid AI calls per guild (config.maxAiCallsPerHour, `/fyrxai limit`), regardless of any heuristic.
const aiCallTimes = new Map(); // guildId -> [timestamps]

function underHourlyCap(guildId, max) {
    const now = Date.now();
    const recent = (aiCallTimes.get(guildId) || []).filter(t => now - t < 3600000);
    aiCallTimes.set(guildId, recent);
    if (recent.length >= max) return false;
    recent.push(now);
    return true;
}

const ATTENTION_MAX = 100;
const ATTENTION_COST = 60;
const ATTENTION_REGEN_SECONDS = 90;
const ATTENTION_REGEN_PER_SEC = ATTENTION_MAX / ATTENTION_REGEN_SECONDS;

// es/en/pt/it question-shape and problem-wording markers — generic, not tied
// to any product vocabulary.
const QUESTION_HINT = /[?¿]|(^|\b)(qu[eé]|c[oó]mo|cu[aá]ndo|cu[aá]nto|por ?qu[eé]|d[oó]nde|quem|onde|quando|quanto|porqu[eê]|poderia|voc[eê] pode|che ?cosa|cosa|come|perch[eé]|dove|posso|puoi|potresti|how|why|what|when|where|does|can i|can you|is there|could you|would you)\b/i;
const PROBLEM_HINT = /\b(error|erro|errore|crash\w*|bug|no funciona|no me funciona|n[aã]o funciona|non funziona|not working|doesn'?t work|falla|fallando|ayuda|help|ajuda|aiuto|problema|problem|issue|trouble|instal(ar|l)|configura|setup|c[oó]mo uso|c[oó]mo se usa|no ?(me )?(deja|permite|puedo|muestra)|no (conecta|entra|carga|anda)|no\s+(?:\w+\s+){0,2}sirv\w*|no me sale|no doy pie con bola|no jala|est[aá] rot[oa]|n[aã]o ?(me )?(deixa|permite|consigo)|n[aã]o (conecta|entra|carrega|trava)|non ?(mi )?(lascia|permette|riesco|posso)|non (connette|entra|carica)|si blocca|bloccato|stuck|broken|can'?t|cannot|won'?t (let|work)|blocked|banned|kicked|denied|rejected|bloquead[oa]|bloqueou|baneado|banido|bannato|expulsad[oa]|expulso|espulso)\b/i;
const POSITIVE_SENTIMENT_HINT = /\b(love|amazing|awesome|great|best (plugin|server|mod|addon)|nice work|well done|gg|encanta|genial|incre[ií]ble|excelente|adoro|ottimo|fantastico|complimenti|obrigad[oa]|maravilhoso)\b/i;

// Small talk/greetings that QUESTION_HINT's bare-word matching (que/como/what/
// how...) would otherwise catch with no real question behind them - only
// used to gate the single-topic bypass below, where there's no second
// "names the topic" gate to filter these out naturally.
const GREETING_HINT = /\b(que tal|qu[eé] onda|c[oó]mo est[aá]s?|c[oó]mo andas?|c[oó]mo va(s|i)?|come stai|how are you|hola+|holi+|buenas?|buenos? d[ií]as|buenas? tardes|buenas? noches|(?:ja){2,}|(?:je){2,}|(?:js){2,}|lol+|xd+|lmao)\b/i;

const LANG_NAMES = { es: 'Spanish', en: 'English', pt: 'Portuguese', it: 'Italian' };
const LANG_UNIQUE = {
    es: /[ñ¿¡]|\b(cu[aá]l|d[oó]nde|puedo|puedes|quiero|necesito|deja)\b/gi,
    pt: /[ãõ]|ç[aã]o\w*|\b(voc[eê]|n[aã]o|obrigad[oa]|preciso|deixa)\b/gi,
    it: /\b(perch[eé]|sono|questo|grazie|ciao|voglio|molto|pu[oò]|lascia)\b/gi,
    en: /\b(the|and|of|does|doesn'?t|won'?t|can'?t|hello|thanks)\b/gi
};
const LANG_WEAK = {
    es: /\b(qu[eé]|c[oó]mo|est[aá]|hay|para|con|sobre|esto|problema|ayuda|servidor|hola|favor|gracias|tiene|hacer)\b/gi,
    pt: /\b(como|est[aá]|para|com|sobre|isso|problema|ajuda|servidor|ol[aá]|posso)\b/gi,
    it: /\b(come|dove|posso|puoi|potresti|per|con|su|problema|aiuto|server)\b/gi,
    en: /\b(is|are|can|you|please|want|need|have|there|about|this|that|problem|help|server|let me|how|what)\b/gi
};

function detectMessageLanguage(content) {
    const scores = {};
    for (const lang of Object.keys(LANG_UNIQUE)) {
        const unique = (content.match(LANG_UNIQUE[lang]) || []).length;
        const weak = (content.match(LANG_WEAK[lang]) || []).length;
        scores[lang] = unique * 3 + weak;
    }
    const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const [topLang, topScore] = sorted[0];
    const [, secondScore] = sorted[1];
    if (topScore === 0 || topScore === secondScore) return null;
    return topLang;
}

// In-memory, per-process — reset on restart, which is fine.
const attentionState = new Map(); // userId -> { attention, updatedAt }
const pendingClarifications = new Map(); // userId -> { originalMessage, askedAt, guildId }

function getCurrentAttention(userId) {
    const state = attentionState.get(userId);
    if (!state) return ATTENTION_MAX;
    const elapsedSec = (Date.now() - state.updatedAt) / 1000;
    return Math.min(ATTENTION_MAX, state.attention + elapsedSec * ATTENTION_REGEN_PER_SEC);
}

function spendAttention(userId) {
    attentionState.set(userId, { attention: getCurrentAttention(userId) - ATTENTION_COST, updatedAt: Date.now() });
}

function logDecision(action, reason, message, extra = {}) {
    const preview = message.content.replace(/\s+/g, ' ').trim().slice(0, 80);
    const extraStr = Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(' ');
    logger.log(
        `[FyrxAI] ${action} - ${reason} | user=${message.author.tag} channel=#${message.channel.name || message.channel.id}` +
        (extraStr ? ` ${extraStr}` : '') + ` | "${preview}${message.content.length > 80 ? '…' : ''}"`
    );
}

function levenshtein(a, b) {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    return dp[a.length][b.length];
}

/**
 * Detects every configured wiki source a message names. Two passes: exact
 * substring match first (cheap, catches the common case), then a fuzzy pass
 * for near-misses caused by spacing/pluralization ("conditional event" vs
 * "conditionalevents") or a typo, using edit distance on the same
 * normalized (spaces/punctuation stripped) form as the substring check -
 * not a semantic thing, so the local embedding model isn't the right tool
 * for this at all.
 */
function detectSources(content, wikis) {
    const lower = content.toLowerCase();
    const normalizedContent = lower.replace(/[^a-z0-9]/g, '');
    const found = new Set();

    for (const name of Object.keys(wikis)) {
        if (lower.includes(name)) found.add(name);
    }
    if (found.size > 0) return [...found];

    // Fuzzy fallback: slide a window the length of each wiki name across the
    // normalized message and accept if within a tolerance scaled to name
    // length (roughly 20%, min 1, max 3 edits).
    for (const name of Object.keys(wikis)) {
        const tolerance = Math.min(3, Math.max(1, Math.round(name.length * 0.2)));
        for (let i = 0; i <= normalizedContent.length - Math.max(1, name.length - tolerance); i++) {
            const window = normalizedContent.slice(i, i + name.length);
            if (window.length < name.length - tolerance) break;
            if (levenshtein(window, name) <= tolerance) { found.add(name); break; }
        }
    }
    return [...found];
}

function looksLikeSupportQuestion(content, wikis) {
    if (!content || content.trim().length < 8) return false;
    const hasQuestionShape = QUESTION_HINT.test(content);
    const hasProblemWording = PROBLEM_HINT.test(content);
    const mentionsSource = detectSources(content, wikis).length > 0;

    if (hasProblemWording) return true;
    if (hasQuestionShape && mentionsSource) return true;
    return false;
}

// Docs are crawled once, at `.fyrxai wiki add`/`wiki refresh` time (see
// lib/crawler.js + commands.js), and stored on the wiki entry itself -
// answering a question is just reading that snapshot, no per-question
// network fetch. Re-run `wiki refresh <name>` after the upstream docs change.
// Sending a whole wiki (up to 400k chars) with every question is what makes
// answers expensive; send only the chunks most related to the question.
const MAX_DOC_CHARS = 32000;
const CHUNK_CHARS = 2500;
const WHOLE_PAGE_CHARS = 8000;

const fourGrams = (w) => { const g = []; for (let i = 0; i + 4 <= w.length; i++) g.push(w.slice(i, i + 4)); return g; };

// Questions and docs are often in different languages ("comandos" vs "commands"),
// so besides whole-word hits, long words also score on shared 4-letter fragments.
function relevance(words, text) {
    let score = 0;
    for (const w of words) {
        if (text.includes(w)) score += 2;
        else if (w.length >= 5 && fourGrams(w).some(g => text.includes(g))) score += 1;
    }
    return score;
}

function getDocsContext(wiki, question) {
    const docs = wiki.docsText || '';
    if (docs.length <= MAX_DOC_CHARS) return docs;

    const words = [...new Set(question.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [])];
    const chunks = [];
    for (const page of docs.split(/\n\n(?=--- https?:\/\/\S+ ---\n)/)) {
        const m = page.match(/^--- (\S+) ---\n([\s\S]*)$/);
        if (!m) continue;
        const slug = decodeURIComponent(m[1].split('/').pop() || '').toLowerCase().replace(/[-_]/g, ' ');
        const size = m[2].length <= WHOLE_PAGE_CHARS ? m[2].length : CHUNK_CHARS; // small pages stay in one piece
        for (let i = 0; i < m[2].length; i += size) {
            const t = m[2].slice(i, i + size);
            chunks.push({ url: m[1], t, order: chunks.length, score: relevance(words, slug + ' ' + t.toLowerCase()) });
        }
    }
    chunks.sort((a, b) => b.score - a.score || a.order - b.order);

    const picked = [];
    let total = 0;
    for (const c of chunks) {
        if (total + c.t.length > MAX_DOC_CHARS) break;
        picked.push(c);
        total += c.t.length;
    }
    return picked.sort((a, b) => a.order - b.order).map(c => `--- ${c.url} ---\n${c.t}`).join('\n\n');
}

function buildSystemPrompt(sources, langHint, persona) {
    const langDirective = langHint
        ? `IMPORTANT: Respond in ${LANG_NAMES[langHint]} - the user's message was detected as ${LANG_NAMES[langHint]}. Do not switch to any other language, even if the documentation below is in English.\n\n`
        : '';

    const personaLine = persona ? `${persona}\n\n` : '';

    const intro = `${langDirective}${personaLine}You are an automated technical support assistant in this Discord server. You help users with questions using the documentation provided below.

Answer using ONLY the documentation context provided below plus well-established general knowledge relevant to the topic. NEVER invent a command, setting, or step that isn't in the provided docs context - if you're not sure, say so plainly and suggest the user ping a human staff member instead of guessing.

Do NOT open with a disclaimer about being an AI or lacking access/permissions - skip straight to the actual answer instead. You DO have the documentation - if it contains a step that solves this, lead with that, stated with confidence. If a step requires an ADMIN to run it (not the user asking), just say clearly who needs to run it and what to run.

You have NO tools, NO ability to check, run, look up, or execute anything, and NO way to send a follow-up message - this single reply is the entire interaction. NEVER claim or imply you are about to do something ("let me check", "I'll investigate", "give me a moment") - if checking something requires an action you can't take, say plainly who can and what to run, in this same message.

Reply in the same language the user wrote in${langHint ? ` (${LANG_NAMES[langHint]}, per the instruction above)` : ''}. Keep answers concise and use Discord markdown (\`code\`, **bold**, bullet lists) - this is a chat reply, not a wiki page. Do NOT start your reply with any tag or self-identification - go straight into answering.

Each documentation block below is split into pages, each preceded by its exact source URL on a line like "--- <url> ---". End your answer with the URL(s) of the specific page(s) you actually drew from, on their own line(s) starting with "Fuente:" (or "Source:"/"Fonte:" in the user's language - pt and it both use "Fonte") - copy the URL exactly as shown, do not invent or guess one. If your answer came from general knowledge rather than a specific page, omit this line entirely instead of citing something you didn't use.`;

    if (sources.length === 0) {
        return `${intro}\n\nNo specific documented topic was detected in the question - answer from general knowledge if you reasonably can, or say you're not sure.`;
    }

    const scopeNote = sources.length > 1
        ? `\nThe user's question may involve multiple topics: ${sources.map(s => s.name).join(', ')}. Use whichever documentation block below is relevant to each part of the question.`
        : `\nThe user's question appears to be about: ${sources[0].name}.`;

    const blocks = sources.map(s => `--- Documentation for ${s.name} ---\n${s.docsContext || '(no docs available)'}`).join('\n\n');
    return `${intro}${scopeNote}\n\n${blocks}`;
}

// Always exempt regardless of guild config, at the requester's explicit
// insistence (flagged once: this hardcodes a personal Discord ID into a
// public repo, which the rest of this module deliberately avoids doing -
// left in because they overrode that concern knowingly). Prefer
// config.exemptUsers/exemptRoles (/fyrxai exempt) for anyone else.
const HARDCODED_EXEMPT_USER_IDS = ['993585477808562268'];

function isExemptFromCooldown(message, config) {
    if (HARDCODED_EXEMPT_USER_IDS.includes(message.author.id)) return true;
    if (config.exemptUsers.includes(message.author.id)) return true;
    const memberRoles = message.member?.roles?.cache;
    return Boolean(memberRoles && config.exemptRoles.some(roleId => memberRoles.has(roleId)));
}

async function answerSupportQuestion(message, config, opts = {}) {
    const exempt = isExemptFromCooldown(message, config);
    const currentAttention = getCurrentAttention(message.author.id);
    if (!exempt && currentAttention < ATTENTION_COST) {
        logDecision('DISCARD', 'low attention for this user (rate limiting)', message, { attention: Math.round(currentAttention) });
        return false;
    }

    const provider = getDecryptedProvider(message.guild.id);
    if (!provider) {
        logDecision('DISCARD', 'no AI provider configured for this guild', message);
        return false;
    }

    const sourceNames = opts.sourceNames || detectSources(message.content, config.wikis);
    const userMessage = opts.overrideContent || message.content;

    if (sourceNames.length && sourceNames.every(n => !config.wikis[n]?.docsText)) {
        logDecision('DISCARD', 'matched wiki has no crawled docs (run /fyrxai wiki refresh)', message);
        return false;
    }
    if (!underHourlyCap(message.guild.id, config.maxAiCallsPerHour)) {
        logDecision('DISCARD', `guild hit the ${config.maxAiCallsPerHour} AI calls/hour cap (/fyrxai limit)`, message);
        return false;
    }
    logDecision('TRIGGER', opts.reason || 'looks like a support question, answering', message, { sources: sourceNames.join(',') || 'none' });

    try {
        await message.channel.sendTyping();

        const sources = sourceNames.map((name) => ({ name, docsContext: getDocsContext(config.wikis[name], userMessage) }));

        const systemPrompt = buildSystemPrompt(sources, detectMessageLanguage(userMessage), config.persona);
        const answer = await callProvider(provider, { systemPrompt, userMessage });

        if (!exempt) spendAttention(message.author.id);
        const embed = await buildSupportEmbed(message.client, answer.slice(0, 3800));
        await message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
        return true;
    } catch (err) {
        logger.error('[FyrxAI] Error answering support question:', err.message);
        return false;
    }
}

async function askWhichSource(message, config) {
    logDecision('TRIGGER', 'ambiguous support question, asking which topic (local, no AI)', message);
    pendingClarifications.set(message.author.id, { originalMessage: message.content, askedAt: Date.now(), guildId: message.guild.id });

    const names = Object.keys(config.wikis).join(', ') || '(no topics configured yet)';
    const prompt = [
        'Entiendo que puede ser un problema de soporte, pero no reconocí de cuál tema se trata. ¿Cuál de estos es?',
        "I think this might be a support question, but I couldn't tell which topic it's about. Which one is it?"
    ].join('\n');
    const embed = await buildSupportEmbed(message.client, `${prompt}\n${names}`);
    await message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
    return true;
}

function pickSourceNames(content, wikis) {
    const named = detectSources(content, wikis);
    if (named.length > 0) return named;
    const wikiNames = Object.keys(wikis);
    return wikiNames.length === 1 ? wikiNames : []; // no topic named, but nothing to disambiguate either
}

/**
 * Handles an @mention - guaranteed to answer (subject only to the attention
 * rate-limit and a provider being configured), skipping every heuristic gate
 * below since a direct mention is unambiguous intent. Works in any channel,
 * not just configured support channels.
 *
 * If the mention is itself a Discord reply to another message, answers about
 * THAT message instead of the mention text - "@FyrxAI what does this mean?"
 * as a reply to someone else's confusing message answers their message, with
 * whatever the replier typed as extra context.
 * @returns {Promise<boolean>}
 */
async function handleMention(message, config) {
    const mentionText = message.content.replace(/<@!?\d+>/g, '').trim();

    if (message.reference) {
        try {
            const referenced = await message.fetchReference();
            const combinedContent = mentionText ? `${referenced.content}\n\n(${mentionText})` : referenced.content;
            return answerSupportQuestion(message, config, {
                sourceNames: pickSourceNames(combinedContent, config.wikis),
                overrideContent: combinedContent,
                reason: 'mentioned while replying - answering about the referenced message'
            });
        } catch (err) {
            logger.error('[FyrxAI] Failed to fetch referenced message, falling back to mention text:', err.message);
        }
    }

    const content = mentionText || message.content;
    return answerSupportQuestion(message, config, {
        sourceNames: pickSourceNames(content, config.wikis),
        overrideContent: content,
        reason: 'mentioned directly - guaranteed answer'
    });
}

/**
 * Passive entry point — call for every non-command message. Acts inside a
 * guild's configured support channels, or anywhere the bot is @mentioned.
 * @returns {Promise<boolean>} true if it handled (replied to) the message
 */
async function handleSupportMessage(message) {
    if (!message.guild) return false;
    if (message.fyrxAssistedHandled) { logDecision('SKIP', 'already answered by fyrx-assisted', message); return false; }
    const config = getGuildConfig(message.guild.id);
    // Default has() also counts @everyone/@here and role pings as mentioning the bot.
    const isMentioned = message.mentions.has(message.client.user, { ignoreEveryone: true, ignoreRoles: true });

    if (isMentioned) { logDecision('MENTION', 'bot mentioned', message); return handleMention(message, config); }

    const isInSupportChannel = config.channels.includes(message.channel.id)
        || (message.channel.isThread?.() && config.channels.includes(message.channel.parentId));
    if (!isInSupportChannel) {
        logDecision('IGNORE', 'not a support channel and bot not mentioned (/fyrxai channel add)', message);
        return false;
    }

    // A "?" inside a URL (watch?v=...) looks like a question; judge only the prose.
    const text = message.content.replace(/https?:\/\/\S+/gi, ' ').trim();
    if (text.length < 8) {
        logDecision('DISCARD', 'link/attachment only or too short', message);
        return false;
    }

    const pending = pendingClarifications.get(message.author.id);
    if (pending && pending.guildId === message.guild.id) {
        pendingClarifications.delete(message.author.id);
        if (Date.now() - pending.askedAt < CLARIFICATION_TTL_MS) {
            const resolvedNames = detectSources(message.content, config.wikis);
            if (resolvedNames.length > 0) {
                return answerSupportQuestion(message, config, {
                    sourceNames: resolvedNames, overrideContent: pending.originalMessage, reason: 'clarification resolved'
                });
            }
        }
    }

    const sourceNames = detectSources(text, config.wikis);
    if (sourceNames.length > 0) {
        if (!looksLikeSupportQuestion(text, config.wikis)) {
            logDecision('DISCARD', 'mentions a topic but does not look like a question', message);
            return false;
        }
        return answerSupportQuestion(message, config, { sourceNames });
    }

    // Only one topic configured - nothing to disambiguate, so skip both the
    // semantic guess and "which topic?" entirely and just answer with it.
    // Uses the full (loose) QUESTION_HINT/PROBLEM_HINT so a bare "como hago
    // X" with no "?" still counts - that laxness was only safe before
    // because it was also gated on naming the topic, so it's gated on
    // GREETING_HINT instead here to keep "hola que tal"/"jajaja" out.
    const wikiNames = Object.keys(config.wikis);
    const looksLikeQuestionStrict = (QUESTION_HINT.test(text) || PROBLEM_HINT.test(text))
        && !GREETING_HINT.test(text);
    if (wikiNames.length === 1 && looksLikeQuestionStrict) {
        return answerSupportQuestion(message, config, { sourceNames: wikiNames, reason: 'only one topic configured' });
    }

    const isPureCompliment = POSITIVE_SENTIMENT_HINT.test(text)
        && !PROBLEM_HINT.test(text) && !QUESTION_HINT.test(text);
    const semanticGuess = isPureCompliment ? null : await classifySource(message.guild.id, config.wikis, text);
    logger.log(`[FyrxAI] semantic classifier -> ${semanticGuess || 'no match'}`);
    if (semanticGuess) {
        return answerSupportQuestion(message, config, { sourceNames: [semanticGuess], reason: 'semantic fallback matched a topic' });
    }

    if (!looksLikeSupportQuestion(text, config.wikis)) {
        logDecision('DISCARD', 'in a support channel but does not look like a question', message);
        return false;
    }

    // Asking "which topic?" is only meaningful when there are at least two to choose from.
    if (wikiNames.length < 2) {
        logDecision('DISCARD', 'support-like but fewer than 2 topics, nothing to disambiguate', message);
        return false;
    }

    return askWhichSource(message, config);
}

module.exports = { getDocsContext, handleSupportMessage, looksLikeSupportQuestion, detectSources, detectMessageLanguage };
