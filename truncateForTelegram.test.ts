// Zero-dependency gate for truncateForTelegram.ts
import { truncateForTelegram, TELEGRAM_SAFE_LIMIT } from './truncateForTelegram';

let failed = false;
const assertEq = (actual: unknown, expected: unknown, label: string) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) console.log(`PASS ${label}`);
    else { failed = true; console.error(`FAIL ${label}: expected ${e}, got ${a}`); }
};
const hasLoneSurrogate = (s: string) => {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
            const n = s.charCodeAt(i + 1);
            if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
            i++;
        } else if (c >= 0xdc00 && c <= 0xdfff) return true;
    }
    return false;
};

// --- The regression: an astral emoji straddling the cut ---------------------
const straddling = 'x'.repeat(TELEGRAM_SAFE_LIMIT - 1) + '\u{1F464}'; // 👤, 2 code units
assertEq(straddling.length > TELEGRAM_SAFE_LIMIT, true, 'fixture is long enough to truncate');
assertEq(hasLoneSurrogate(truncateForTelegram(straddling)), false, 'no lone surrogate when an emoji straddles the cut');
assertEq(truncateForTelegram(straddling).length, TELEGRAM_SAFE_LIMIT, 'backed off exactly one code unit');

// A pair that lands wholly before the cut must NOT be backed off.
const aligned = 'x'.repeat(TELEGRAM_SAFE_LIMIT - 2) + '\u{1F464}' + 'yyy';
assertEq(hasLoneSurrogate(truncateForTelegram(aligned)), false, 'aligned pair stays intact');
assertEq(truncateForTelegram(aligned).length, TELEGRAM_SAFE_LIMIT + 1, 'aligned cut keeps the full limit');

// --- Pass-through ----------------------------------------------------------
assertEq(truncateForTelegram('short'), 'short', 'short string unchanged');
assertEq(truncateForTelegram(''), '', 'empty string unchanged');
assertEq(truncateForTelegram('x'.repeat(TELEGRAM_SAFE_LIMIT)), 'x'.repeat(TELEGRAM_SAFE_LIMIT), 'exactly at the limit is unchanged');
assertEq(truncateForTelegram('x'.repeat(TELEGRAM_SAFE_LIMIT + 1)).endsWith('…'), true, 'one over the limit gets an ellipsis');

// --- Degenerate limits -----------------------------------------------------
assertEq(truncateForTelegram('\u{1F464}ab', 1), '…', 'limit 1 splitting a pair backs off to empty');
assertEq(truncateForTelegram('abc', 0), '…', 'limit 0');
assertEq(truncateForTelegram(undefined as any), '', 'non-string input');
assertEq(truncateForTelegram(null as any), '', 'null input');

// --- An all-emoji message (the real cron message shape) --------------------
const emojiMsg = '\u{1F464}'.repeat(4000);
const out = truncateForTelegram(emojiMsg);
assertEq(hasLoneSurrogate(out), false, 'all-emoji message truncates cleanly');
assertEq(out.length <= TELEGRAM_SAFE_LIMIT + 1, true, 'all-emoji result stays within budget');

if (failed) { console.error('truncateForTelegram.test.ts FAILED'); process.exit(1); }
console.log('truncateForTelegram.test.ts OK');
