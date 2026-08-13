/**
 * lib/slashCommands.js
 * All configuration happens via the `/fyrxai` slash command — no env vars,
 * no code edits. Slash commands (not `.` prefix text commands) so Discord's
 * own permission system can hide the command from non-managers by default,
 * and so sensitive replies (the provider API key confirmation) can be sent
 * ephemeral — visible only to whoever ran the command, never posted as
 * plain text in the channel at all.
 */

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const { PROVIDER_NAMES } = require('./providers');
const config = require('./config');
const { crawlDocs } = require('./crawler');
const { generateKeywords } = require('./keywords');
const { extractKeywords } = require('./autoKeywords');

const commandData = new SlashCommandBuilder()
    .setName('fyrxai')
    .setDescription('Configure the FyrxAI support agent')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommandGroup(g => g.setName('channel').setDescription('Support channels')
        .addSubcommand(s => s.setName('add').setDescription('Add a support channel')
            .addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum, ChannelType.PublicThread)))
        .addSubcommand(s => s.setName('remove').setDescription('Remove a support channel')
            .addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)))
        .addSubcommand(s => s.setName('list').setDescription('List support channels')))
    .addSubcommandGroup(g => g.setName('wiki').setDescription('Documentation sources')
        .addSubcommand(s => s.setName('add').setDescription('Crawl a doc site and add it as a source')
            .addStringOption(o => o.setName('name').setDescription('Short name, e.g. "solver"').setRequired(true))
            .addStringOption(o => o.setName('url').setDescription('Doc site URL').setRequired(true))
            .addStringOption(o => o.setName('description').setDescription('Short description (improves topic detection)')))
        .addSubcommand(s => s.setName('refresh').setDescription('Re-crawl an existing wiki (same URL)')
            .addStringOption(o => o.setName('name').setDescription('Wiki name').setRequired(true)))
        .addSubcommand(s => s.setName('remove').setDescription('Remove a wiki')
            .addStringOption(o => o.setName('name').setDescription('Wiki name').setRequired(true)))
        .addSubcommand(s => s.setName('list').setDescription('List configured wikis')))
    .addSubcommandGroup(g => g.setName('provider').setDescription('AI provider')
        .addSubcommand(s => s.setName('set').setDescription('Set the AI provider that answers questions')
            .addStringOption(o => o.setName('provider').setDescription('Provider').setRequired(true)
                .addChoices(...PROVIDER_NAMES.map(n => ({ name: n, value: n }))))
            .addStringOption(o => o.setName('model').setDescription('Model name').setRequired(true))
            .addStringOption(o => o.setName('apikey').setDescription('API key (only you see this)').setRequired(true)))
        .addSubcommand(s => s.setName('remove').setDescription('Remove the configured AI provider')))
    .addSubcommandGroup(g => g.setName('persona').setDescription('Custom assistant instructions')
        .addSubcommand(s => s.setName('set').setDescription('Set extra system-prompt instructions')
            .addStringOption(o => o.setName('text').setDescription('Instructions').setRequired(true)))
        .addSubcommand(s => s.setName('remove').setDescription('Remove custom instructions')))
    .addSubcommand(s => s.setName('status').setDescription('Show current configuration'))
    .addSubcommand(s => s.setName('help').setDescription('List all commands'))
    .toJSON();

const HELP_TEXT = [
    '**FyrxAI — comandos de configuración** (requieren permiso *Gestionar servidor*)',
    '`/fyrxai channel add|remove|list` — canales donde el bot responde soporte automáticamente',
    '`/fyrxai wiki add` — escanea un sitio de docs (sigue enlaces/llms.txt/sitemap) y lo añade como fuente',
    '`/fyrxai wiki refresh` — vuelve a escanear una wiki ya añadida (misma URL)',
    '`/fyrxai wiki remove|list`',
    `\`/fyrxai provider set\` (${PROVIDER_NAMES.join('|')}) — proveedor de IA que responde; respuesta visible solo para ti`,
    '`/fyrxai provider remove`',
    '`/fyrxai persona set|remove` — instrucciones extra para el asistente (opcional)',
    '`/fyrxai status` — muestra la configuración actual'
].join('\n');

async function crawlAndStore(guildId, name, url) {
    const pages = await crawlDocs(url).catch((err) => { console.error('[FyrxAI] Crawl failed:', err.message); return []; });
    const docsText = pages.map(p => `--- ${p.url} ---\n${p.text}`).join('\n\n').slice(0, 400000);

    const provider = config.getDecryptedProvider(guildId);
    const [autoKeywords, aiKeywords] = await Promise.all([
        Promise.resolve(extractKeywords(docsText)),
        generateKeywords(provider, docsText)
    ]);
    const keywords = [...new Set([...autoKeywords, ...aiKeywords])].slice(0, 150);

    config.setWikiDocs(guildId, name, { docsText, keywords, pageCount: pages.length });
    return { pageCount: pages.length, keywordCount: keywords.length };
}

async function handleInteraction(interaction) {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'fyrxai') return false;
    if (!interaction.guild) {
        await interaction.reply({ content: 'Este comando solo funciona dentro de un servidor.', flags: MessageFlags.Ephemeral });
        return true;
    }

    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand(false);
    const guildId = interaction.guild.id;
    const ephemeralReply = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });

    if (sub === 'help') { await ephemeralReply(HELP_TEXT); return true; }

    if (sub === 'status') {
        const cfg = config.getGuildConfig(guildId);
        const lines = [
            `Canales: ${cfg.channels.length ? cfg.channels.map(id => `<#${id}>`).join(', ') : '(ninguno)'}`,
            `Wikis: ${Object.keys(cfg.wikis).join(', ') || '(ninguna)'}`,
            `Proveedor: ${cfg.provider ? `${cfg.provider.name} (${cfg.provider.model})` : '(sin configurar)'}`,
            `Persona: ${cfg.persona ? 'configurada' : '(por defecto)'}`
        ];
        await ephemeralReply(lines.join('\n'));
        return true;
    }

    if (group === 'channel') {
        if (sub === 'list') {
            const cfg = config.getGuildConfig(guildId);
            await ephemeralReply(cfg.channels.length ? cfg.channels.map(id => `<#${id}>`).join(', ') : 'No hay canales configurados.');
            return true;
        }
        const channel = interaction.options.getChannel('channel', true);
        if (sub === 'add') { config.addChannel(guildId, channel.id); await ephemeralReply(`Canal <#${channel.id}> añadido a soporte automático.`); return true; }
        if (sub === 'remove') { config.removeChannel(guildId, channel.id); await ephemeralReply(`Canal <#${channel.id}> quitado de soporte automático.`); return true; }
    }

    if (group === 'wiki') {
        if (sub === 'list') {
            const cfg = config.getGuildConfig(guildId);
            const names = Object.keys(cfg.wikis);
            await ephemeralReply(names.length
                ? names.map(n => `**${n}** — ${cfg.wikis[n].pageCount || 0} página(s), ${cfg.wikis[n].keywords?.length || 0} keywords — ${cfg.wikis[n].url}`).join('\n')
                : 'No hay wikis configuradas.');
            return true;
        }
        if (sub === 'remove') {
            const name = interaction.options.getString('name', true);
            config.removeWiki(guildId, name);
            await ephemeralReply(`Wiki **${name}** eliminada.`);
            return true;
        }
        if (sub === 'add' || sub === 'refresh') {
            let name = interaction.options.getString('name', true);
            let url;
            if (sub === 'add') {
                url = interaction.options.getString('url', true);
                config.addWiki(guildId, name, url, interaction.options.getString('description') || '');
            } else {
                const existing = config.getGuildConfig(guildId).wikis[name.toLowerCase()];
                if (!existing) { await ephemeralReply(`No existe una wiki llamada **${name}**. Usa \`/fyrxai wiki add\`.`); return true; }
                url = existing.url;
            }

            await interaction.reply({ content: `Escaneando **${url}**... esto puede tardar unos segundos.`, flags: MessageFlags.Ephemeral });
            const { pageCount, keywordCount } = await crawlAndStore(guildId, name, url);
            await interaction.followUp({
                content: `Wiki **${name}** ${sub === 'add' ? 'añadida' : 'actualizada'}: ${pageCount} página(s) escaneada(s), ${keywordCount} keywords.`,
                flags: MessageFlags.Ephemeral
            });
            return true;
        }
    }

    if (group === 'provider') {
        if (sub === 'remove') { config.removeProvider(guildId); await ephemeralReply('Proveedor de IA eliminado.'); return true; }
        if (sub === 'set') {
            const name = interaction.options.getString('provider', true);
            const model = interaction.options.getString('model', true);
            const apiKey = interaction.options.getString('apikey', true);
            config.setProvider(guildId, { name, model, apiKey });
            await ephemeralReply(`Proveedor configurado: **${name}** (${model}). Solo tú puedes ver este mensaje.`);
            return true;
        }
    }

    if (group === 'persona') {
        if (sub === 'remove') { config.setPersona(guildId, null); await ephemeralReply('Persona personalizada eliminada.'); return true; }
        if (sub === 'set') {
            const text = interaction.options.getString('text', true);
            config.setPersona(guildId, text);
            await ephemeralReply('Persona personalizada actualizada.');
            return true;
        }
    }

    await ephemeralReply(HELP_TEXT);
    return true;
}

module.exports = { commandData, handleInteraction };
