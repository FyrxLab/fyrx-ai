const { EmbedBuilder } = require('discord.js');

// Fyrx's own bot account — its avatar is used as the footer icon regardless
// of which bot account is actually running this module, so every reply
// carries the same "Fyrx AI" branding.
const FYRX_BOT_ID = '987357771412439050';
const FOOTER_TEXT = 'Respuesta automática de Fyrx AI';
const EMBED_COLOR = 0x5865f2;

let cachedIconUrl; // undefined = not fetched yet, null = fetch failed

async function getFooterIcon(client) {
    if (cachedIconUrl !== undefined) return cachedIconUrl;
    try {
        const fyrxUser = await client.users.fetch(FYRX_BOT_ID);
        cachedIconUrl = fyrxUser.displayAvatarURL({ extension: 'png', size: 128 });
    } catch (err) {
        console.error('[FyrxAI/embeds] Could not fetch Fyrx bot avatar for footer icon:', err.message);
        cachedIconUrl = null;
    }
    return cachedIconUrl;
}

/**
 * @param {import('discord.js').Client} client
 * @param {string} content
 * @returns {Promise<EmbedBuilder>}
 */
async function buildSupportEmbed(client, content) {
    const icon = await getFooterIcon(client);
    return new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setDescription(content)
        .setFooter({ text: FOOTER_TEXT, iconURL: icon || undefined });
}

module.exports = { buildSupportEmbed };
