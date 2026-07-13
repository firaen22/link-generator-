---
name: telemetry-pipeline
description: Load when adding/changing a reader-behaviour signal, editing useTelemetry.ts, /api/track, /api/session-end, sanitizeSessionEnd.ts, the analysis prompt/schema, or the Telegram session summary.
---

# Telemetry pipeline — capture → analyse → deliver (2026-07-13)

## Flow
`src/viewer/hooks/useTelemetry.ts` (refs-only accumulators) →
- realtime: `sendTrackingEvent` fans out to `/api/track` (keepalive fetch) +
  GA4 `gtag` + ContentSquare (useTelemetry.ts:284-324). Events: open,
  heartbeat (~30s), engaged_60s (once), click_appointment, security_alert.
- exit: `handleExit` → `navigator.sendBeacon('/api/session-end', blob)`,
  falling back to `keepalive` fetch when sendBeacon refuses; payload
  decimated in a loop while >60000 chars (useTelemetry.ts:328-437). Fires on
  beforeunload/pagehide/visibilitychange-hidden, deduped; a fresh session
  (new UUID, cleared accumulators) starts if the tab returns.
Server: `/api/track` (server.ts:1345) formats + escapes + rate-limits + awaits
Telegram. `/api/session-end` (server.ts:1547) sanitizes → rate-gates → Gemini
analysis (RESPONSE_SCHEMA) → Telegram summary (truncated to 3900 chars) + is
mirrored client-side to GA4 as flat `report_session_end`.

## Delivery policy (user decision 2026-07-07 — failure-archaeology §3)
New behavioural signals must go BOTH to (a) GA4 as flat scalar params with
`session_id`, and (b) the Telegram message body as compact text — not into a
new database/dashboard, unless the user reopens that decision (see
failure-archaeology §3). Detail belongs in the Telegram message, the
warehouse is GA4.

## Adding a signal — the checklist that past bugs wrote
- [ ] Capture with a **ref**, not useState (C10); passive listeners only.
- [ ] Read scroll from the `<main>` container ref, never `window` (window
      never scrolls here — signals silently read 0; f535c48).
- [ ] Timer-read values come from live refs (`xRef.current`), not closures
      (`total_pages: null` heartbeat bug, ec6fddc).
- [ ] Same JSON key on both ends — grep useTelemetry.ts AND the server
      handler for the exact key (`current_page` vs `page` mismatch, 4ce5358).
- [ ] Pick the right endpoint: realtime/event-shaped signals go through
      `sendTrackingEvent` → `/api/track`; per-session accumulators ride the
      exit payload → `/api/session-end`.
- [ ] Server side (session-end only): add the field to `sanitizeSessionEnd()`
      — a separate file at repo root, `sanitizeSessionEnd.ts` — with clamp/cap
      in its existing style; never read it raw off req.body (C11).
- [ ] localStorage only via safeGetItem/safeRemoveItem (webview SecurityError,
      02c9990).
- [ ] Cap any new array (existing caps: scroll samples ring-buffer 1200
      client / 2000 server, nav path 2000, zoom clusters 300 client / 1000
      server, pages_data keys 5000).
- [ ] If the AI should use it: extend RESPONSE_SCHEMA additively + both model
      paths (ai-calls-gemini.md), and add a concise prompt rule — the prompt
      budget target is ~2K tokens (tasks/plan.md).
- [ ] Payload growth: session_end must stay comfortably under the 1mb body
      cap (a 30-min deep read is ~250KB; the cap was deliberately NOT lowered
      to 64kb because real payloads exceeded it).
Done when: a real browser session shows the new field non-zero in the
/api/track or session-end body AND it appears in the Telegram message and GA4
event.

## Rate-limit contract (do not weaken/reorder — C4)
session-end AI: `ai:s:<session_id>` 1/60s && `ai:ip:<ip>` 30/h &&
`ai:global` 40/h (short-circuit order matters). Telegram: `tg:<ip>` 12/60s
shared by track + session-end summary; the AI-result message bypasses the tg
cap (already bounded by ai caps). Throttled sessions still notify via the
cheap fallback summary. A returning client gets a FRESH session_id, so
genuine return visits always get analysis.

## Session identity & recovery facts
session_id = crypto.randomUUID() per session; return visit detection uses
tab_switch_count persisted per file+client in localStorage
(`ag_tabswitch_<fileId>_<clientName>`); a session snapshot for recovery lives
at `ag_report_log_<fileId>_<clientName>`. The heartbeat is ONE 1s interval
reading refs — don't add more timers; hook new periodic work into it.

## z-score baseline
Dwell-time anomaly scoring uses hardcoded MU=120/SIGMA=60 in server.ts — a
deliberate placeholder; only replace if the user asks to pull baselines from
the GA4 BigQuery export.

Re-verify: `grep -n "sendBeacon\|ag_tabswitch\|report_session_end" src/viewer/hooks/useTelemetry.ts | head`
