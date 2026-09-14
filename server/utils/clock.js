/**
 * The one place the server asks "what time is it". Everything that decides
 * whether a pair has already happened, which week of the semester it is, or
 * where a template edit takes effect goes through here.
 *
 * KAI_FAKE_NOW (an ISO datetime) pins the clock so tests can walk a full
 * academic year — semester start, edits mid-term, the rollover to spring —
 * through the real HTTP routes. It is ignored in production, so a stray
 * environment variable can never move a live teacher's hours.
 */
function now() {
    const fake = process.env.KAI_FAKE_NOW;

    if (fake && process.env.NODE_ENV !== 'production') {
        const parsed = new Date(fake);

        if (!Number.isNaN(parsed.getTime())) {
            return parsed;
        }
    }

    return new Date();
}

module.exports = { now };
