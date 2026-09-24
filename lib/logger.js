/**
 * lib/logger.js
 * Every log line always goes to <data dir>/debug.txt (rotated at 2 MB to
 * debug.old.txt); echoing to the console is a toggle (`/fyrxai logs`),
 * persisted in settings.json. Never log API keys or decrypted secrets here —
 * debug.txt is meant to be shared for troubleshooting.
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./dataDir');

const DEBUG_FILE = path.join(DATA_DIR, 'debug.txt');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const MAX_BYTES = 2 * 1024 * 1024;

let settings = null;

function getSettings() {
    if (!settings) {
        try { settings = { consoleLogs: true, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; }
        catch { settings = { consoleLogs: true }; }
    }
    return settings;
}

function setConsoleLogs(enabled) {
    getSettings().consoleLogs = enabled;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function writeFile(line) {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        if (fs.existsSync(DEBUG_FILE) && fs.statSync(DEBUG_FILE).size > MAX_BYTES) {
            fs.renameSync(DEBUG_FILE, path.join(DATA_DIR, 'debug.old.txt'));
        }
        fs.appendFileSync(DEBUG_FILE, `[${new Date().toISOString()}] ${line}\n`);
    } catch { /* logging must never crash the bot */ }
}

const fmt = (args) => args.map(a => (a instanceof Error ? a.stack || a.message : String(a))).join(' ');

function log(...args) {
    const line = fmt(args);
    writeFile(line);
    if (getSettings().consoleLogs) console.log(line);
}

function error(...args) {
    const line = fmt(args);
    writeFile(`ERROR ${line}`);
    if (getSettings().consoleLogs) console.error(line);
}

module.exports = { log, error, setConsoleLogs, getSettings, DEBUG_FILE };
