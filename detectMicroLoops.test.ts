// Zero-dependency gate for detectMicroLoops.ts (run: npx tsx detectMicroLoops.test.ts)
import { detectMicroLoops, MICRO_LOOP_WINDOW_MS } from './detectMicroLoops';

let failed = false;
const assertEq = (actual: unknown, expected: unknown, label: string) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        console.log(`PASS ${label}`);
    } else {
        failed = true;
        console.error(`FAIL ${label}: expected ${e}, got ${a}`);
    }
};

const nav = (...pairs: Array<[number, number]>) => pairs.map(([page, t]) => ({ page, t }));

// --- The regression this module was extracted for -------------------------
// An early visit to the same page pair, then a genuine 3-transition micro-loop
// ~10 minutes later. The old first-to-last span (600s) exceeded the 120s window,
// so the real loop was discarded. The window scan must still find it.
assertEq(
    detectMicroLoops(nav([1, 0], [2, 1_000], [1, 600_000], [2, 600_500], [1, 601_000])),
    ['Pages 1<->2 (3x in 1s)'],
    'late micro-loop after an early visit to the same pair',
);

// --- Basic detection ------------------------------------------------------
assertEq(
    detectMicroLoops(nav([1, 0], [2, 1_000], [1, 2_000], [2, 3_000])),
    ['Pages 1<->2 (3x in 2s)'],
    'tight 3-transition loop',
);

// A 4-entry history is enough for 3 transitions; the old `length < MIN_CYCLES*2`
// guard rejected anything under 6 entries.
assertEq(
    detectMicroLoops(nav([3, 0], [4, 10], [3, 20], [4, 30])).length,
    1,
    'four-entry history is not discarded',
);

// --- Correct negatives ----------------------------------------------------
assertEq(detectMicroLoops([]), [], 'empty history');
assertEq(detectMicroLoops(nav([1, 0])), [], 'single entry');
assertEq(detectMicroLoops(nav([1, 0], [2, 1_000], [1, 2_000])), [], 'only 2 transitions');
assertEq(
    detectMicroLoops(nav([1, 0], [1, 1_000], [1, 2_000], [1, 3_000], [1, 4_000])),
    [],
    'same page repeated is not a loop',
);
// Three transitions spread wider than the window: genuinely not a micro-loop.
assertEq(
    detectMicroLoops(nav([1, 0], [2, 500_000], [1, 1_000_000], [2, 1_500_000])),
    [],
    'transitions spread beyond the window',
);

// --- Window boundary ------------------------------------------------------
// Transitions are timestamped at navHistory[i].t for i >= 1, so the first
// transition here is at t=1 and the span is (last transition - 1).
assertEq(
    detectMicroLoops(nav([1, 0], [2, 1], [1, 2], [2, MICRO_LOOP_WINDOW_MS + 2])).length,
    0,
    'span exactly one ms past the window',
);
assertEq(
    detectMicroLoops(nav([1, 0], [2, 1], [1, 2], [2, MICRO_LOOP_WINDOW_MS + 1])).length,
    1,
    'span exactly at the window edge',
);

// --- Unsorted input (nav_history is unauthenticated client input) ---------
// Must not yield a negative span, and must still find the burst.
assertEq(
    detectMicroLoops(nav([1, 601_000], [2, 0], [1, 600_500], [2, 1_000], [1, 600_000])).some(
        (s) => s.includes('-'),
    ),
    false,
    'unsorted history produces no negative span',
);

// --- Multiple pairs -------------------------------------------------------
assertEq(
    detectMicroLoops(nav([1, 0], [2, 100], [1, 200], [2, 300], [5, 400], [6, 500], [5, 600], [6, 700])).length,
    2,
    'two independent looping pairs both reported',
);

if (failed) {
    console.error('detectMicroLoops.test.ts FAILED');
    process.exit(1);
}
console.log('detectMicroLoops.test.ts OK');
