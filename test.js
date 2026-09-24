// Self-check: node test.js (first run downloads the ~120 MB local model).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fyrxai-test-'));
const home = process.cwd();
process.chdir(tmp); // DATA_DIR = cwd/fyrxai-data

const { classifyIntent } = require(path.join(home, 'lib/intent'));
const docsIndex = require(path.join(home, 'lib/docsIndex'));
const { routesOf } = require(path.join(home, 'lib/crawler'));
const config = require(path.join(home, 'lib/config'));

const docs = [
    '--- https://x.test/wiki/Premium ---\nHow to activate Premium\nRun /premium activate in the lobby after buying Plus. Premium accounts skip the login step.',
    '--- https://x.test/wiki/VPN ---\nVPN and proxies\nConnections from VPNs or proxies are blocked automatically. Disable your VPN and rejoin; appeals go to the ticket channel.',
    '--- https://x.test/wiki/Commands ---\nCommands\n/fg reload - reload config\n/fg status - show status\n/fg whitelist add <player>'
].join('\n\n');

(async () => {
    assert.deepStrictEqual(routesOf(docs), ['https://x.test/wiki/Premium', 'https://x.test/wiki/VPN', 'https://x.test/wiki/Commands']);
    assert.strictEqual(await docsIndex.buildIndex('g', 'demo', docs), 3);

    // Cross-language relevance: Spanish questions find English pages; chat stays far away.
    const vpn = await docsIndex.search('g', ['demo'], 'me banearon por usar vpn, qué hago?');
    assert.strictEqual(vpn.hits[0].p.url, 'https://x.test/wiki/VPN');
    const cmds = await docsIndex.search('g', ['demo'], 'que comandos tiene fg');
    assert.strictEqual(cmds.hits[0].p.url, 'https://x.test/wiki/Commands');
    const chat = await docsIndex.search('g', ['demo'], 'qué hago si me pican los cocos');
    assert(chat.best < vpn.best && chat.best < 0.3, `off-topic relevance too high: ${chat.best}`);
    assert(docsIndex.buildContext('g', vpn.hits).length > 0);

    assert.strictEqual((await classifyIntent('no puedo entrar al servidor, me sale error de conexion', [])).label, 'support');
    assert.strictEqual((await classifyIntent('write a python script that prints hello world', [])).label, 'task');
    assert.strictEqual((await classifyIntent('jajaja xd', [])).label, 'chat');

    // A guild's own labels win over the built-in examples.
    const msg = 'meteré instrucciones de seguridad';
    for (const t of [msg, 'meteré más reglas al bot', 'voy a meter instrucciones nuevas']) config.addTrainingExample('g', t, 'chat');
    assert.strictEqual((await classifyIntent('meteré instrucciones de seguridad al bot', config.getGuildConfig('g').trainingExamples)).label, 'chat');

    process.chdir(home);
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('ok');
})().catch((err) => { console.error(err); process.exit(1); });
