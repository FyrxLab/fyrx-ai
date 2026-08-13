/**
 * Minimal example showing how to wire FyrxAI into a discord.js bot.
 * Run with: DISCORD_TOKEN=... node example/bot.js
 */

const { Client, GatewayIntentBits } = require('discord.js');
const setupFyrxAI = require('../FyrxAI');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

setupFyrxAI(client);

client.once('ready', () => console.log(`Logged in as ${client.user.tag}`));
client.login(process.env.DISCORD_TOKEN);
