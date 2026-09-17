const { ALERT_CHAT_ID, ALERT_WEBHOOK_URL } = require('./config');

// Outgoing "something is wrong" messages.
//
// The point is to find out about a broken server from the server itself rather
// than from a student who can't find their pair. Set ALERT_WEBHOOK_URL to a
// Telegram bot, Discord or Slack webhook; with nothing set, alerts are only
// written to the log and the app behaves exactly as before.
//
// Deliberately fire-and-forget: an alert that fails (or a webhook that is slow)
// must never delay or break the request that triggered it.

const THROTTLE_MS = 10 * 60 * 1000;
const lastSentAt = new Map();

function buildPayload(text) {
    const url = ALERT_WEBHOOK_URL;

    if (url.includes('api.telegram.org')) {
        return { chat_id: ALERT_CHAT_ID, text, disable_web_page_preview: true };
    }

    if (url.includes('discord.com') || url.includes('discordapp.com')) {
        return { content: text };
    }

    // Slack and most self-made receivers take a plain { text }.
    return { text };
}

/**
 * @param {string} text - what happened, in the words the reader needs
 * @param {object} [options]
 * @param {string} [options.key] - same key is sent at most once per 10 minutes,
 *   so a failure repeating on every request doesn't turn into a flood
 */
function notify(text, { key } = {}) {
    const stamp = new Date().toISOString();
    console.error(`[alert] ${text}`);

    if (!ALERT_WEBHOOK_URL) {
        return;
    }

    if (key) {
        const previous = lastSentAt.get(key) || 0;

        if (Date.now() - previous < THROTTLE_MS) {
            return;
        }

        lastSentAt.set(key, Date.now());
    }

    const body = JSON.stringify(buildPayload(`🛫 КАИ Расписание · ${stamp}\n${text}`));

    fetch(ALERT_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(5000)
    }).catch((error) => {
        console.error('[alert] Could not deliver the alert:', error.message);
    });
}

module.exports = { notify };
