/**
 * lib/banner.js
 * A short, readable status summary logged once on startup - version, bot
 * identity, guild count, and whether an AI provider is configured anywhere
 * yet - so a bot owner watching the console can tell at a glance that
 * FyrxAI came up correctly, without digging through per-message logs.
 */

const { version } = require('../package.json');
const { getGuildConfig } = require('./config');

function printStartupBanner(client) {
    const guildCount = client.guilds.cache.size;
    const configuredGuilds = client.guilds.cache.filter(g => getGuildConfig(g.id).provider).size;

    const lines = [
        `FyrxAI v${version}`,
        `Bot: ${client.user.tag}`,
        `Guilds: ${guildCount} (${configuredGuilds} with an AI provider configured)`,
        `Config: /fyrxai help`
    ];
    const width = Math.max(...lines.map(l => l.length)) + 4;
    const border = '─'.repeat(width);

    console.log(`┌${border}┐`);
    for (const line of lines) console.log(`│  ${line.padEnd(width - 2)}│`);
    console.log(`└${border}┘`);
}

module.exports = { printStartupBanner };
