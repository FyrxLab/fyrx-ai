/**
 * lib/updateCheck.js
 * Checks GitHub for a newer tagged release on startup and, if one exists,
 * logs a heads-up — nothing is downloaded or applied automatically. Silent
 * auto-update would mean every bot with FyrxAI installed runs whatever code
 * lands in a future push with no review; a log line the bot owner can act
 * on (or ignore) is the safe version of "let people know there's an update".
 */

const REPO = 'FyrxLab/fyrx-ai';
const CURRENT_VERSION = require('../package.json').version;

function isNewer(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] || 0, y = pb[i] || 0;
        if (x !== y) return x > y;
    }
    return false;
}

async function checkForUpdate() {
    try {
        const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
            headers: { 'User-Agent': 'FyrxAI-UpdateCheck', 'Accept': 'application/vnd.github+json' }
        });
        if (!res.ok) return; // repo private/unreachable/rate-limited - never block startup over this

        const data = await res.json();
        const latest = (data.tag_name || '').replace(/^v/, '');
        if (latest && isNewer(latest, CURRENT_VERSION)) {
            console.log(`[FyrxAI] Nueva versión disponible: v${latest} (tienes v${CURRENT_VERSION}) — https://github.com/${REPO}/releases/latest`);
        }
    } catch {
        // offline or GitHub unreachable - this is a nice-to-have, fail silent
    }
}

module.exports = { checkForUpdate };
