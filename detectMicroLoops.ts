// Micro-loop detection for reader telemetry: a client bouncing repeatedly
// between the same two pages in a short span is a loss-aversion signal (see the
// behavioural-finance rules in the /api/session-end prompt).
//
// Extracted from server.ts so the windowing logic can be tested directly.

export const MICRO_LOOP_WINDOW_MS = 120_000; // 2-minute analysis window
export const MICRO_LOOP_MIN_CYCLES = 3;

export function detectMicroLoops(navHistory: Array<{ page: number; t: number }>): string[] {
  const loops: string[] = [];
  const WINDOW_MS = MICRO_LOOP_WINDOW_MS;
  const MIN_CYCLES = MICRO_LOOP_MIN_CYCLES;

  // MIN_CYCLES transitions on one pair need MIN_CYCLES + 1 entries (1,2,1,2 is
  // 4 entries and 3 transitions). The old guard demanded MIN_CYCLES * 2, so a
  // genuine loop in a 4- or 5-entry history was discarded before analysis.
  if (navHistory.length < MIN_CYCLES + 1) return loops;

  const pagePairs = new Map<string, number[]>();
  for (let i = 1; i < navHistory.length; i++) {
    const prev = navHistory[i - 1].page;
    const curr = navHistory[i].page;
    if (prev !== curr) {
      const key = `${Math.min(prev, curr)}<->${Math.max(prev, curr)}`;
      if (!pagePairs.has(key)) pagePairs.set(key, []);
      pagePairs.get(key)!.push(navHistory[i].t);
    }
  }

  pagePairs.forEach((rawTimestamps, key) => {
    if (rawTimestamps.length < MIN_CYCLES) return;
    // nav_history is unauthenticated client input and is not guaranteed to be in
    // chronological order; the window scan below needs it sorted (and an
    // unsorted series could otherwise produce a negative span).
    const timestamps = [...rawTimestamps].sort((a, b) => a - b);

    // Densest burst inside any WINDOW_MS-wide window. The previous version
    // measured first-to-last across the WHOLE session, so one early visit to the
    // same pair pushed the span past the window and hid a real micro-loop that
    // happened later — the exact pattern this function exists to catch.
    let best = 0;
    let bestSpan = 0;
    let start = 0;
    for (let end = 0; end < timestamps.length; end++) {
      while (timestamps[end] - timestamps[start] > WINDOW_MS) start++;
      const count = end - start + 1;
      if (count > best) {
        best = count;
        bestSpan = timestamps[end] - timestamps[start];
      }
    }

    if (best >= MIN_CYCLES) {
      loops.push(`Pages ${key} (${best}x in ${Math.round(bestSpan / 1000)}s)`);
    }
  });

  return loops;
}
