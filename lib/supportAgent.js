/**
 * lib/supportAgent.js
 * Support agent for a guild's configured support channels (and @mentions).
 * Decides locally, with no AI call, whether a message deserves an answer:
 *  1. intent    - k-NN over multilingual embeddings (lib/intent.js): support / chat / task
 *  2. relevance - how close the message is to the guild's wikis (lib/docsIndex.js)
 * Only a support question about the wikis reaches the paid AI, and then with
 * just the passages that matter. Server admins (and OWNER_IDS) can @mention
 * it for anything; everyone else only gets wiki-grounded support.
 */

const { PermissionFlagsBits } = require('discord.js');
const { classifyIntent } = require('./intent');
const docsIndex = require('./docsIndex');
const { callProvider } = require('./providers');
const { buildSupportEmbed } = require('./embeds');
const { getGuildConfig, getDecryptedProvider } = require('./config');
const logger = require('./logger');

// Thresholds measured on real server chat against a real wiki. Three bands:
//  clear    -> answer (local signals agree it's a question about the docs)
//  doubtful -> ~260-token YES/NO pre-check with the AI, full answer only on YES
//  no       -> silent, free
// Local embeddings alone can't split the middle band: real questions and
// chat both land at rel 0.30-0.37 there.
const TASK_CONFIDENCE = 0.7; // "write me code" etc.
const STRONG_RELEVANCE = 0.45; // this close to the wiki is about it, whatever the intent says ("que es foxgate?")
const CLEAR_CONFIDENCE = 0.9;
const CLEAR_RELEVANCE = 0.38;
const DOUBT_CONFIDENCE = 0.5;
const DOUBT_RELEVANCE = 0.25;
const MENTION_MIN_RELEVANCE = 0.15; // below this a mention gets the canned "not in the docs" reply
const DOCS_MIN_RELEVANCE = 0.3; // admins' off-topic asks carry no docs
const SLOW_REPLY_MS = 8000; // past this, post a "looking into it" placeholder the answer then edits
const REPLY_TIMEOUT_MS = 90000;

// Always privileged regardless of guild config, at the requester's explicit
// insistence (this hardcodes a personal Discord ID into a public repo; left in
// knowingly). Server admins are privileged too.
const OWNER_IDS = ['993585477808562268'];

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
 * Wiki sources a message names explicitly: exact substring first, then a
 * fuzzy (edit distance, ~20% of the name) pass for typos/spacing
 * ("conditional event" vs "conditionalevents").
 */
function detectSources(content, wikis) {
    const lower = content.toLowerCase();
    const normalizedContent = lower.replace(/[^a-z0-9]/g, '');
    const found = new Set();

    for (const name of Object.keys(wikis)) {
        if (lower.includes(name)) found.add(name);
    }
    if (found.size > 0) return [...found];

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

// Guilds configured before the local index existed have docsText but no
// index file; build it from the stored text once (no network).
const building = new Map(); // guildId:wiki -> Promise
async function ensureIndexes(guildId, wikis) {
    await Promise.all(Object.entries(wikis).map(([name, w]) => {
        if (!w.docsText || docsIndex.loadIndex(guildId, name)) return null;
        const key = `${guildId}:${name}`;
        if (!building.has(key)) building.set(key, docsIndex.buildIndex(guildId, name, w.docsText).finally(() => building.delete(key)));
        return building.get(key);
    }));
}

function isPrivileged(message) {
    return OWNER_IDS.includes(message.author.id)
        || Boolean(message.member?.permissions?.has(PermissionFlagsBits.Administrator));
}

function isExemptFromCooldown(message, config) {
    if (isPrivileged(message)) return true;
    if (config.exemptUsers.includes(message.author.id)) return true;
    const memberRoles = message.member?.roles?.cache;
    return Boolean(memberRoles && config.exemptRoles.some(roleId => memberRoles.has(roleId)));
}

function cannedText(kind, lang, topics) {
    const t = `**${topics.join(', ') || '—'}**`;
    const es = {
        task: `Solo puedo ayudar con soporte sobre ${t}. No creo ni depuro código, ni respondo temas fuera de esa documentación.`,
        chat: `¡Hola! Soy el asistente de soporte de ${t}. Pregúntame lo que necesites sobre eso.`,
        offtopic: `No encontré nada sobre eso en la documentación de ${t}. Si es un problema de soporte, explícalo con más detalle o espera a alguien del staff.`
    };
    const en = {
        task: `I can only help with support about ${t}. I don't write or debug code, or answer topics outside that documentation.`,
        chat: `Hi! I'm the support assistant for ${t}. Ask me anything about it.`,
        offtopic: `I couldn't find anything about that in the ${t} documentation. If it's a support issue, add more detail or wait for a staff member.`
    };
    return (lang === 'en' ? en : es)[kind];
}

async function replyEmbed(message, text) {
    const embed = await buildSupportEmbed(message.client, text.slice(0, 3800));
    await message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
}

function buildSystemPrompt(blocks, topics, langHint, persona, open) {
    const langDirective = langHint
        ? `IMPORTANT: Respond in ${LANG_NAMES[langHint]} - the user's message was detected as ${LANG_NAMES[langHint]}. Do not switch to any other language, even if the documentation below is in English.\n\n`
        : '';
    const personaLine = persona ? `${persona}\n\n` : '';

    const scope = open
        ? 'The user is an administrator of this server: help with whatever they ask. Use the documentation below when it is relevant.'
        : `You provide support about: ${topics.join(', ')}. Users are usually players or server owners asking about it in their own words ("why can't I join", "what is this").
If the message asks for something unrelated to ${topics.join(', ')} (writing or debugging code, general knowledge, other products), say in one sentence that you only help with ${topics.join(', ')}.
Base the answer on the documentation below: explain what it says that applies to the user's situation. NEVER invent a command, setting, or step that isn't in it; if the documentation doesn't settle it, say what is likely from it and suggest contacting a staff member.`;

    const docs = blocks.length
        ? blocks.map(b => `--- ${b.url} ---\n${b.text}`).join('\n\n')
        : '(no relevant documentation found)';

    return `${langDirective}${personaLine}You are an automated technical support assistant in this Discord server.

${scope}

Do NOT open with a disclaimer about being an AI - go straight to the answer. If a step requires an ADMIN to run it, say clearly who needs to run it and what to run. You have NO tools and NO way to send a follow-up message - never say "let me check" or "give me a moment".

Keep answers concise and use Discord markdown (\`code\`, **bold**, bullet lists) - this is a chat reply, not a wiki page. Do NOT start with any tag or self-identification.

The documentation excerpts below are each preceded by their source URL on a line like "--- <url> ---". End your answer with the URL(s) you actually drew from, on their own line(s) starting with "Fuente:" (or "Source:"/"Fonte:" in the user's language) - copy the URL exactly; skip this line if you used none. Never cite a "file:" source.

Documentation excerpts:
${docs}`;
}

/** Short description of each wiki for the pre-check: admin description, else the start of its first page. */
function aboutTopics(guildId, config, topics) {
    return topics.map(name => {
        const desc = config.wikis[name]?.description
            || (docsIndex.loadIndex(guildId, name) || []).slice(0, 2).map(p => p.text).join(' ').replace(/\s+/g, ' ').slice(0, 400);
        return `${name} - ${desc}`;
    }).join('\n');
}

/** Cheap YES/NO: is this a support question about the topics? (~260 tokens, no docs) */
async function precheck(provider, message, config, topics, text) {
    const systemPrompt = `You filter messages for the support bot of a Discord server. Documented topics:
${aboutTopics(message.guild.id, config, topics)}
Reply YES if the message asks for help, reports a problem, or asks a question a user of this server could have about these topics (joining, being kicked/blocked, accounts, purchases, commands, configuration). Reply NO if it is casual conversation, an opinion or comment, talk between people, or unrelated. Reply with only YES or NO.`;
    const reply = await callProvider(provider, { systemPrompt, userMessage: text });
    return /^\W*(yes|s[ií])\b/i.test(reply);
}

/**
 * Calls the AI with the relevant passages. `mode`: 'passive' | 'mention' |
 * 'open' (admin, anything). `doubtful` runs the cheap pre-check first.
 */
async function answer(message, config, { question, text, search, topics, mode, reason, lang, doubtful }) {
    const exempt = isExemptFromCooldown(message, config);
    const currentAttention = getCurrentAttention(message.author.id);
    if (!exempt && currentAttention < ATTENTION_COST) {
        logDecision('DISCARD', 'low attention for this user (rate limiting)', message, { attention: Math.round(currentAttention) });
        if (mode !== 'passive') await message.react('⏳').catch(() => {});
        return false;
    }
    const provider = getDecryptedProvider(message.guild.id);
    if (!provider) {
        logDecision('DISCARD', 'no AI provider configured for this guild', message);
        return false;
    }
    if (doubtful) {
        const yes = await precheck(provider, message, config, topics, text).catch((err) => {
            logger.error('[FyrxAI] Pre-check failed:', err.message);
            return false;
        });
        logDecision('PRECHECK', yes ? 'AI says support question' : 'AI says not a support question', message, { mode });
        if (!yes) {
            if (mode === 'mention') await replyEmbed(message, cannedText('offtopic', lang, topics));
            return mode === 'mention';
        }
    }
    if (!underHourlyCap(message.guild.id, config.maxAiCallsPerHour)) {
        logDecision('DISCARD', `guild hit the ${config.maxAiCallsPerHour} AI calls/hour cap (/fyrxai limit)`, message);
        if (mode !== 'passive') await message.react('⏳').catch(() => {});
        return false;
    }

    const minRelevance = mode === 'open' ? DOCS_MIN_RELEVANCE : MENTION_MIN_RELEVANCE;
    const blocks = search.best >= minRelevance ? docsIndex.buildContext(message.guild.id, search.hits) : [];
    logDecision('TRIGGER', reason, message, { mode, passages: blocks.length });

    // Providers sometimes take 40s+. Discord's typing indicator lasts ~10s, so
    // keep it alive, and past SLOW_REPLY_MS post a placeholder that the real
    // answer then edits in place.
    const typing = () => message.channel.sendTyping().catch(() => {});
    typing();
    const typingTimer = setInterval(typing, 8000);
    let placeholder = null;
    const placeholderTimer = setTimeout(() => {
        // Assigned synchronously, so deliver() always waits for it instead of posting a second message.
        placeholder = buildSupportEmbed(message.client, lang === 'en'
            ? '🔎 Looking into this in depth, the answer will appear here in a moment…'
            : '🔎 Estoy investigando a fondo, la respuesta aparecerá aquí en un momento…')
            .then(embed => message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } }))
            .catch(() => null);
    }, SLOW_REPLY_MS);
    const deliver = async (text) => {
        const embed = await buildSupportEmbed(message.client, text.slice(0, 3800));
        const sent = await placeholder;
        if (sent) await sent.edit({ embeds: [embed] });
        else await message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
    };

    try {
        const systemPrompt = buildSystemPrompt(blocks, topics, lang, config.persona, mode === 'open');
        const reply = (await Promise.race([
            callProvider(provider, { systemPrompt, userMessage: question }),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`no reply after ${REPLY_TIMEOUT_MS / 1000}s`)), REPLY_TIMEOUT_MS))
        ])).trim();
        clearTimeout(placeholderTimer);
        if (!exempt) spendAttention(message.author.id);
        await deliver(reply);
        return true;
    } catch (err) {
        clearTimeout(placeholderTimer);
        logger.error('[FyrxAI] Error answering support question:', err.message);
        if (mode !== 'passive' || placeholder) {
            await deliver(lang === 'en'
                ? 'The AI service is taking too long right now. Please try again in a few minutes or wait for a staff member.'
                : 'El servicio de IA está tardando demasiado ahora mismo. Intenta de nuevo en unos minutos o espera a alguien del staff.').catch(() => {});
        }
        return false;
    } finally {
        clearInterval(typingTimer);
    }
}

/**
 * Passive entry point — call for every non-command message. Acts inside a
 * guild's configured support channels, or anywhere the bot is @mentioned.
 * @returns {Promise<boolean>} true if it replied
 */
async function handleSupportMessage(message) {
    if (!message.guild) return false;
    if (message.fyrxAssistedHandled) { logDecision('SKIP', 'already answered by fyrx-assisted', message); return false; }
    const config = getGuildConfig(message.guild.id);
    // Default has() also counts @everyone/@here and role pings as mentioning the bot.
    const isMentioned = message.mentions.has(message.client.user, { ignoreEveryone: true, ignoreRoles: true });

    if (!isMentioned) {
        const isInSupportChannel = config.channels.includes(message.channel.id)
            || (message.channel.isThread?.() && config.channels.includes(message.channel.parentId));
        if (!isInSupportChannel) {
            logDecision('IGNORE', 'not a support channel and bot not mentioned (/fyrxai channel add)', message);
            return false;
        }
    }

    // Mentioned while replying to someone: answer about THAT message.
    let question = message.content.replace(/<@!?\d+>/g, ' ');
    if (isMentioned && message.reference) {
        const referenced = await message.fetchReference().catch(() => null);
        if (referenced?.content) question = `${referenced.content}\n\n(${question.trim()})`;
    }
    question = question.trim();
    // A "?" inside a URL looks like a question; judge only the prose.
    const text = question.replace(/https?:\/\/\S+/gi, ' ').replace(/\s+/g, ' ').trim();
    if (text.length < 3 || (!isMentioned && text.length < 8)) {
        logDecision('DISCARD', 'link/attachment only or too short', message);
        return false;
    }

    const topics = Object.keys(config.wikis);
    const named = detectSources(text, config.wikis);
    await ensureIndexes(message.guild.id, config.wikis);
    const search = await docsIndex.search(message.guild.id, named.length ? named : topics, text);
    const lang = detectMessageLanguage(text);
    const rel = search.best.toFixed(2);

    if (isMentioned && isPrivileged(message)) {
        return answer(message, config, { question, text, search, topics, lang, mode: 'open', reason: 'mentioned by a server admin - unrestricted' });
    }

    const intent = await classifyIntent(text, config.trainingExamples);
    if (!intent) { logDecision('DISCARD', 'local model unavailable', message); return false; }
    const stats = { intent: intent.label, conf: intent.confidence.toFixed(2), rel };

    const isTask = intent.label === 'task' && intent.confidence >= TASK_CONFIDENCE;
    const isSupport = (min) => intent.label === 'support' && intent.confidence >= min;
    const clear = !isTask && (search.best >= STRONG_RELEVANCE || (isSupport(CLEAR_CONFIDENCE) && search.best >= CLEAR_RELEVANCE));
    const why = `(${stats.intent} ${stats.conf}, rel ${rel})`;

    if (!isMentioned) {
        if (clear) return answer(message, config, { question, text, search, topics, lang, mode: 'passive', reason: `clear support question ${why}` });
        if (!isTask && isSupport(DOUBT_CONFIDENCE) && search.best >= DOUBT_RELEVANCE) {
            return answer(message, config, { question, text, search, topics, lang, mode: 'passive', doubtful: true, reason: `doubtful, pre-checked ${why}` });
        }
        logDecision('DISCARD', intent.label === 'support' ? 'support-like but not about the wikis' : 'not a support request', message, stats);
        return false;
    }

    // Mentioned by a regular member: support only, canned (free) replies otherwise.
    if (intent.label === 'task') {
        logDecision('REFUSE', 'request outside support scope (canned, no AI)', message, stats);
        await replyEmbed(message, cannedText('task', lang, topics));
        return true;
    }
    if (search.best < MENTION_MIN_RELEVANCE || (intent.label === 'chat' && intent.confidence >= 0.8)) {
        const kind = intent.label === 'chat' ? 'chat' : 'offtopic';
        logDecision('REFUSE', `${kind} (canned, no AI)`, message, stats);
        await replyEmbed(message, cannedText(kind, lang, topics));
        return true;
    }
    return answer(message, config, { question, text, search, topics, lang, mode: 'mention', doubtful: !clear, reason: `mentioned ${why}` });
}

module.exports = { handleSupportMessage, ensureIndexes, detectSources, detectMessageLanguage };
