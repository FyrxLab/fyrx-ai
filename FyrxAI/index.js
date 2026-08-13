/**
 * FyrxAI — drop-in AI support agent for discord.js bots.
 * Usage: require('./FyrxAI')(client);  (after client.login, or before — it
 * only attaches listeners, order doesn't matter)
 */

const { commandData, handleInteraction } = require('./lib/slashCommands');
const { handleSupportMessage } = require('./lib/supportAgent');

async function registerCommands(client) {
    try {
        await client.application.commands.set([commandData]); // global, can take up to ~1h to propagate for new guilds
        await Promise.all(client.guilds.cache.map(g => g.commands.set([commandData]).catch(() => {}))); // instant for guilds already joined
    } catch (err) {
        console.error('[FyrxAI] Failed to register /fyrxai command:', err.message);
    }
}

/**
 * @param {import('discord.js').Client} client - a logged-in (or about to
 *   log in) discord.js Client with the MessageContent intent enabled.
 */
function setupFyrxAI(client) {
    // discord.js renamed 'ready' to 'clientReady' but both currently fire on
    // v14 (only 'clientReady' will remain in v15) - guard so this only runs once.
    let registered = false;
    const ready = () => {
        if (registered) return;
        registered = true;
        registerCommands(client).then(() => console.log('[FyrxAI] Ready — /fyrxai help in any server.'));
    };
    client.once('clientReady', ready);
    client.once('ready', ready);

    client.on('guildCreate', (guild) => guild.commands.set([commandData]).catch(() => {}));

    client.on('interactionCreate', async (interaction) => {
        try {
            await handleInteraction(interaction);
        } catch (err) {
            console.error('[FyrxAI] Unhandled interaction error:', err);
        }
    });

    client.on('messageCreate', async (message) => {
        if (message.author.bot || !message.guild) return;
        try {
            await handleSupportMessage(message);
        } catch (err) {
            console.error('[FyrxAI] Unhandled error:', err);
        }
    });
}

module.exports = setupFyrxAI;
