/**
 * lib/dataDir.js
 * Where persistent state (guild config, encryption key) lives. Deliberately
 * NOT inside this package's own install directory (node_modules/fyrxai/data)
 * - node_modules gets wiped on every `npm ci`/redeploy in most setups, which
 * would silently lose every guild's config and encryption key on the next
 * deploy. Defaults to a folder in the *consuming bot's* own working
 * directory instead, which persists the same way the rest of its code does.
 */

const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'fyrxai-data');

module.exports = { DATA_DIR };
