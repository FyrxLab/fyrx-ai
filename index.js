/**
 * FyrxAI — drop-in AI support agent for discord.js bots.
 * Usage: require('fyrxai')(client);  (after client.login, or before — it
 * only attaches listeners, order doesn't matter)
 */

const { commandData, trainCommands, handleInteraction } = require('./lib/slashCommands');
const { handleSupportMessage, ensureIndexes } = require('./lib/supportAgent');
const { getGuildConfig } = require('./lib/config');
const { checkForUpdate } = require('./lib/updateCheck');
const { printStartupBanner } = require('./lib/banner');
const logger = require('./lib/logger');

// Guild-scoped registration only, deliberately not global: global commands
// take up to ~1h to propagate and, more importantly, registering BOTH global
// and per-guild for the same name creates two separate command entries that
// Discord's client lists as visible duplicates in the picker. Guild-only is
// instant and has exactly one entry per guild.
// create() upserts by name; set() would overwrite every other addon's guild commands.
function registerGuild(guild) {
    return Promise.all([commandData, ...trainCommands].map(c => guild.commands.create(c)
        .catch((err) => logger.error('[FyrxAI] Failed to register ' + c.name + ' in guild ' + guild.id + ':', err.message))));
}

async function registerCommands(client) {
    await Promise.all(client.guilds.cache.map(registerGuild));
}

/**
 * @param {import('discord.js').Client} client - a logged-in (or about to
 *   log in) discord.js Client with the MessageContent intent enabled.
 */
function setupFyrxAI(client) {
    logger.log(`[FyrxAI] starting v${require('./package.json').version} node=${process.version} console=${logger.getSettings().consoleLogs ? 'on' : 'off'}`);
    // discord.js renamed 'ready' to 'clientReady' but both currently fire on
    // v14 (only 'clientReady' will remain in v15) - guard so this only runs once.
    let registered = false;
    const ready = () => {
        if (registered) return;
        registered = true;
        registerCommands(client).then(() => printStartupBanner(client));
        // Build missing wiki indexes now, not on the first user's message.
        for (const g of client.guilds.cache.values()) ensureIndexes(g.id, getGuildConfig(g.id).wikis).catch(err => logger.error('[FyrxAI] Index build failed:', err.message));
        checkForUpdate();
    };
    client.once('clientReady', ready);
    client.once('ready', ready);

    client.on('guildCreate', registerGuild);

    client.on('interactionCreate', async (interaction) => {
        try {
            await handleInteraction(interaction);
        } catch (err) {
            logger.error('[FyrxAI] Unhandled interaction error:', err);
        }
    });

    client.on('messageCreate', async (message) => {
        if (message.author.bot || !message.guild) return;
        try {
            await handleSupportMessage(message);
        } catch (err) {
            logger.error('[FyrxAI] Unhandled error:', err);
        }
    });
}

module.exports = setupFyrxAI;
