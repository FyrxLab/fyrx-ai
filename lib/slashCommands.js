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
const logger = require('./logger');

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
    .addSubcommandGroup(g => g.setName('exempt').setDescription('Skip the per-user cooldown for specific users/roles')
        .addSubcommand(s => s.setName('adduser').setDescription('Exempt a user from the cooldown')
            .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)))
        .addSubcommand(s => s.setName('removeuser').setDescription('Remove a user\'s cooldown exemption')
            .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)))
        .addSubcommand(s => s.setName('addrole').setDescription('Exempt a role (e.g. moderators) from the cooldown')
            .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)))
        .addSubcommand(s => s.setName('removerole').setDescription('Remove a role\'s cooldown exemption')
            .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)))
        .addSubcommand(s => s.setName('list').setDescription('List exempt users/roles')))
    .addSubcommand(s => s.setName('limit').setDescription('Max paid AI answers per hour for this server (hard cap)')
        .addIntegerOption(o => o.setName('calls_per_hour').setDescription('0 = never call the AI').setRequired(true).setMinValue(0).setMaxValue(1000)))
    .addSubcommand(s => s.setName('logs').setDescription('Show or hide log lines in the console (debug.txt is always written)')
        .addBooleanOption(o => o.setName('console').setDescription('true = print to console, false = only debug.txt').setRequired(true)))
    .addSubcommand(s => s.setName('debug').setDescription('Get debug.txt (recent internal activity) to share for troubleshooting'))
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
    '`/fyrxai exempt adduser|removeuser|addrole|removerole|list` — usuarios/roles (ej. moderadores) sin cooldown de uso',
    '`/fyrxai limit <n>` — máximo de respuestas con IA por hora en este servidor (0 = nunca)',
    '`/fyrxai logs <true|false>` — mostrar u ocultar logs en consola (debug.txt siempre se guarda)',
    '`/fyrxai debug` — te envía debug.txt para compartirlo al pedir ayuda',
    '`/fyrxai status` — muestra la configuración actual'
].join('\n');

async function crawlAndStore(guildId, name, url) {
    const pages = await crawlDocs(url).catch((err) => { logger.error('[FyrxAI] Crawl failed:', err.message); return []; });
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

    logger.log(`[FyrxAI/CMD] user=${interaction.user.tag} guild=${guildId} /fyrxai ${group || ''} ${sub}`.replace(/  +/g, ' '));

    if (sub === 'limit') {
        const cfg = config.getGuildConfig(guildId);
        cfg.maxAiCallsPerHour = interaction.options.getInteger('calls_per_hour', true);
        config.saveGuildConfig(guildId, cfg);
        await ephemeralReply(`Límite actualizado: ${cfg.maxAiCallsPerHour} respuestas con IA por hora.`);
        return true;
    }
    if (sub === 'logs') {
        const on = interaction.options.getBoolean('console', true);
        logger.setConsoleLogs(on);
        await ephemeralReply(on ? 'Logs en consola activados.' : 'Logs en consola desactivados — todo sigue guardándose en debug.txt.');
        return true;
    }
    if (sub === 'debug') {
        await interaction.reply({ content: 'debug.txt (contiene fragmentos de mensajes de canales de soporte; compártelo solo con quien te ayuda).', files: [logger.DEBUG_FILE], flags: MessageFlags.Ephemeral });
        return true;
    }

    if (sub === 'help') { await ephemeralReply(HELP_TEXT); return true; }

    if (sub === 'status') {
        const cfg = config.getGuildConfig(guildId);
        const lines = [
            `Canales: ${cfg.channels.length ? cfg.channels.map(id => `<#${id}>`).join(', ') : '(ninguno)'}`,
            `Wikis: ${Object.keys(cfg.wikis).join(', ') || '(ninguna)'}`,
            `Proveedor: ${cfg.provider ? `${cfg.provider.name} (${cfg.provider.model})` : '(sin configurar)'}`,
            `Persona: ${cfg.persona ? 'configurada' : '(por defecto)'}`,
            `Exentos de cooldown: ${cfg.exemptUsers.length} usuario(s), ${cfg.exemptRoles.length} rol(es)`,
            `Límite de IA: ${cfg.maxAiCallsPerHour} respuestas/hora`,
            `Logs en consola: ${logger.getSettings().consoleLogs ? 'sí' : 'no (solo debug.txt)'}`
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

    if (group === 'exempt') {
        if (sub === 'list') {
            const cfg = config.getGuildConfig(guildId);
            const lines = [
                `Usuarios: ${cfg.exemptUsers.length ? cfg.exemptUsers.map(id => `<@${id}>`).join(', ') : '(ninguno)'}`,
                `Roles: ${cfg.exemptRoles.length ? cfg.exemptRoles.map(id => `<@&${id}>`).join(', ') : '(ninguno)'}`
            ];
            await ephemeralReply(lines.join('\n'));
            return true;
        }
        if (sub === 'adduser') {
            const user = interaction.options.getUser('user', true);
            config.addExemptUser(guildId, user.id);
            await ephemeralReply(`${user} ya no tiene cooldown de uso.`);
            return true;
        }
        if (sub === 'removeuser') {
            const user = interaction.options.getUser('user', true);
            config.removeExemptUser(guildId, user.id);
            await ephemeralReply(`${user} vuelve a tener cooldown de uso.`);
            return true;
        }
        if (sub === 'addrole') {
            const role = interaction.options.getRole('role', true);
            config.addExemptRole(guildId, role.id);
            await ephemeralReply(`El rol **${role.name}** ya no tiene cooldown de uso.`);
            return true;
        }
        if (sub === 'removerole') {
            const role = interaction.options.getRole('role', true);
            config.removeExemptRole(guildId, role.id);
            await ephemeralReply(`El rol **${role.name}** vuelve a tener cooldown de uso.`);
            return true;
        }
    }

    await ephemeralReply(HELP_TEXT);
    return true;
}

module.exports = { commandData, handleInteraction };
