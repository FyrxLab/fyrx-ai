/**
 * lib/config.js
 * Per-guild configuration store. Everything the module needs (support
 * channels, wiki sources, AI provider + key, custom persona) is set from
 * Discord via `.fyrxai` commands (see commands.js) and persisted here as
 * one JSON file per guild — no env vars, no code edits required.
 */

const fs = require('fs');
const path = require('path');
const { encryptText, decryptText } = require('./crypto');
const { DATA_DIR } = require('./dataDir');

function fileFor(guildId) {
    return path.join(DATA_DIR, `${guildId}.json`);
}

function defaultConfig() {
    return { channels: [], wikis: {}, provider: null, persona: null, exemptUsers: [], exemptRoles: [] };
}

function getGuildConfig(guildId) {
    const file = fileFor(guildId);
    if (!fs.existsSync(file)) return defaultConfig();
    try {
        return { ...defaultConfig(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (err) {
        console.error(`[FyrxAI] Failed to read config for guild ${guildId}:`, err.message);
        return defaultConfig();
    }
}

function saveGuildConfig(guildId, config) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(fileFor(guildId), JSON.stringify(config, null, 2));
}

function getDecryptedProvider(guildId) {
    const config = getGuildConfig(guildId);
    if (!config.provider) return null;
    try {
        return { ...config.provider, apiKey: decryptText(config.provider.apiKey) };
    } catch (err) {
        console.error(`[FyrxAI] Failed to decrypt provider key for guild ${guildId}:`, err.message);
        return null;
    }
}

function setProvider(guildId, { name, model, apiKey }) {
    const config = getGuildConfig(guildId);
    config.provider = { name, model, apiKey: encryptText(apiKey) };
    saveGuildConfig(guildId, config);
}

function removeProvider(guildId) {
    const config = getGuildConfig(guildId);
    config.provider = null;
    saveGuildConfig(guildId, config);
}

function addChannel(guildId, channelId) {
    const config = getGuildConfig(guildId);
    if (!config.channels.includes(channelId)) config.channels.push(channelId);
    saveGuildConfig(guildId, config);
    return config;
}

function removeChannel(guildId, channelId) {
    const config = getGuildConfig(guildId);
    config.channels = config.channels.filter(id => id !== channelId);
    saveGuildConfig(guildId, config);
    return config;
}

function addWiki(guildId, name, url, description) {
    const config = getGuildConfig(guildId);
    config.wikis[name.toLowerCase()] = { url, description: description || '', docsText: '', keywords: [], crawledAt: null };
    saveGuildConfig(guildId, config);
    return config;
}

/** Stores the result of a crawl (lib/crawler.js) + keyword pass (lib/keywords.js) for an existing wiki entry. */
function setWikiDocs(guildId, name, { docsText, keywords, pageCount }) {
    const config = getGuildConfig(guildId);
    const key = name.toLowerCase();
    if (!config.wikis[key]) return config;
    config.wikis[key] = { ...config.wikis[key], docsText, keywords: keywords || [], pageCount: pageCount || 0, crawledAt: new Date().toISOString() };
    saveGuildConfig(guildId, config);
    return config;
}

function removeWiki(guildId, name) {
    const config = getGuildConfig(guildId);
    delete config.wikis[name.toLowerCase()];
    saveGuildConfig(guildId, config);
    return config;
}

function setPersona(guildId, text) {
    const config = getGuildConfig(guildId);
    config.persona = text || null;
    saveGuildConfig(guildId, config);
    return config;
}

/** Users/roles exempt from the per-user attention rate-limit (see lib/supportAgent.js). */
function addExemptUser(guildId, userId) {
    const config = getGuildConfig(guildId);
    if (!config.exemptUsers.includes(userId)) config.exemptUsers.push(userId);
    saveGuildConfig(guildId, config);
    return config;
}

function removeExemptUser(guildId, userId) {
    const config = getGuildConfig(guildId);
    config.exemptUsers = config.exemptUsers.filter(id => id !== userId);
    saveGuildConfig(guildId, config);
    return config;
}

function addExemptRole(guildId, roleId) {
    const config = getGuildConfig(guildId);
    if (!config.exemptRoles.includes(roleId)) config.exemptRoles.push(roleId);
    saveGuildConfig(guildId, config);
    return config;
}

function removeExemptRole(guildId, roleId) {
    const config = getGuildConfig(guildId);
    config.exemptRoles = config.exemptRoles.filter(id => id !== roleId);
    saveGuildConfig(guildId, config);
    return config;
}

module.exports = {
    getGuildConfig, saveGuildConfig, getDecryptedProvider, setProvider, removeProvider,
    addChannel, removeChannel, addWiki, setWikiDocs, removeWiki, setPersona,
    addExemptUser, removeExemptUser, addExemptRole, removeExemptRole
};
