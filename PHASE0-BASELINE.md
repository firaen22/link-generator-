# Phase 0 — Efficiency baseline (static cost model + traffic status)

Date: 2026-09-14. Method: two independent static reads of `server.ts`
(codex `gpt-5.6-luna` + grok `grok-4.6`), cross-checked; live traffic probed
via the Vercel connector. Every row is line-referenced in each model's raw
output under the session scratchpad.

## A. Live traffic weights — UNAVAILABLE from Vercel (blocker)
- Vercel project `link-generator` (prj_QwgPp3…), team plan = **hobby**.
- **Web Analytics: not enabled** (API 404). No route pageview/visit counts.
- **Runtime logs: empty** for the last 24h and 7d (hobby retention is short
  and/or low production traffic). No invocation/duration/byte counts.
- Real usage telemetry for this app lives in **GA4 + Telegram** (per project
  design), not Vercel. That is where per-route hit counts must come from.
- => The per-route cost model below is the RANKING SKELETON. It is NOT yet
  weighted by how often each route is actually called. Weighting is pending a
  traffic source (see "To unblock").

## B. Static per-invocation cost ranking (cross-checked)

CONFIRMED HIGH by BOTH models (the real cost centers):
1. POST /api/session-end   — Gemini thinking-model + fallback loop, worst case
   ~K×7 SEQUENTIAL model calls on a large telemetry prompt; then Firestore
   reader read/write + Telegram. Cheap when AI path is skipped.
2. POST /api/generate-meta — up to 14 MiB PDF pulled from R2 and sent to Gemini
   as inline data; sequential K×5 retry across rotated keys/models.
3. GET  /api/pdf/:file_id  — UNCAPPED PDF egress (R2 / Firebase / vblob proxy);
   cost = file size × invocations; optional 1 Firestore lifecycle read.

HIGH on cache MISS (measure hit rate before trusting placement):
4. POST /api/explain-jargon — Gemini on text/JPEG on miss, R2 get/put around it;
   LOW on in-memory (L1) or R2-store hit.

DATA-DEPENDENT — models split (adjudicate with real counts):
   GET /api/cron/silent-links — codex HIGH / grok MED. Per RUN: up to 300 FS
     reads + up to 300 FS writes + SEQUENTIAL per-advisor Telegram. Runs 1×/day,
     so total cost is small; per-invocation heavy. NOT an unbounded scan
     (filtered createdAt≥14d, limit 300, no paging). grok caveat: query omits
     openCount/silentAlertAt so it still reads up to 300 recent docs each run,
     and if >300 links were created in 14d, older silent ones are never seen
     (a correctness gap, out of efficiency scope).
   POST /api/create-link — codex HIGH / grok MED. 1–20 Firestore creates in
     Promise.all, each up to 5 sequential retries on ID collision => worst case
     ~5N writes. Typical N small => MED; worst case HIGH.

MED: GET /api/img/:file_id (uncapped but smaller, 1-day cache) ; GET /api/links
   (up to 300 FS reads) .
LOW: /api/unlock-link, /l/:shortId, /api/revoke-link, /api/extend-link,
   /api/replace-link-file, /api/r2-presign, /api/shorten, /api/check-image-size,
   /api/track, /api/share (·/s).

## C. Findings that resolve open plan questions
- Rate-limiter memory (revised-plan step 6) is CONFIRMED a non-issue: the store
  prunes stale keys and hard-caps at 5000 keys; cost counters are a separate,
  deliberately-non-clearable map. No unbounded growth.
- Streaming (step 7): pdf/img stream on the Web-stream path but FALL BACK TO
  BUFFERING when response.body is absent — so "it streams" is conditional;
  verify on the deployed function.
- No route performs an unbounded collection scan.

## D. The dominant cost mechanism (both models, unprompted)
Gemini retry FAN-OUT, not any single call: session-end and generate-meta both
loop sequentially across multiple keys AND multiple models on
timeout/failure (K×5 to K×7 full-payload calls). Token spend and latency are
set by the RETRY multiplier, not the happy path. This is the first thing to
measure and the highest-leverage thing to bound.

## To unblock traffic weighting (pick one)
1. Enable Vercel Web Analytics on the project (free on hobby), collect ~7 days,
   re-pull by requestPath. Cheapest, but only counts, not durations.
2. Pull per-route/event hit counts from GA4 (where this app already reports).
3. Add a lightweight per-route counter (invocations + duration + resp bytes)
   logged so hobby-retention captures it, collect a few days.
Until one is in place, weight the ranking above by your own knowledge of which
routes get called most (viewer /api/pdf + /api/track + /api/session-end on every
share open are the obvious high-frequency ones).
