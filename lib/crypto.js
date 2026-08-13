/**
 * lib/crypto.js
 * AES-256-GCM helper for API keys at rest. Unlike a typical setup this needs
 * NO env var: on first use it generates a random 32-byte key and persists it
 * next to the config data, so the whole module works with zero required
 * configuration. Delete data/.encryption.key to invalidate stored keys.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./dataDir');

const ALGORITHM = 'aes-256-gcm';
const KEY_FILE = path.join(DATA_DIR, '.encryption.key');

let cachedKey = null;

function getMasterKey() {
    if (cachedKey) return cachedKey;

    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    if (fs.existsSync(KEY_FILE)) {
        cachedKey = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
    } else {
        cachedKey = crypto.randomBytes(32);
        fs.writeFileSync(KEY_FILE, cachedKey.toString('hex'), { mode: 0o600 });
    }
    return cachedKey;
}

function encryptText(plainText) {
    const key = getMasterKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(plainText, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return { iv: iv.toString('hex'), encrypted, tag: cipher.getAuthTag().toString('hex') };
}

function decryptText(encryptedObj) {
    const key = getMasterKey();
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(encryptedObj.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(encryptedObj.tag, 'hex'));
    let decrypted = decipher.update(encryptedObj.encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

module.exports = { encryptText, decryptText };
