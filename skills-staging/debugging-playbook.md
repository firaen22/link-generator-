---
name: debugging-playbook
description: Load when a production or local symptom matches one of these observed states — a 500 on /api routes, missing Telegram messages, empty/zero telemetry values, PDF viewer errors, OG preview cards not showing in WhatsApp, 401s on link creation, or links that suddenly 404.
---

# Debugging playbook — symptom-keyed, from real incidents (2026-07-13)

Each entry: verbatim symptom → mechanism → fix/check. Hashes are real commits.

## "FUNCTION_INVOCATION_FAILED" on /api/*, /s/*, /l/*
Module-load crash of the single serverless function, almost never a logic bug.
Full triage in `serverless-deploy-contract.md` Rule 3. Prime suspects:
extensionless relative import (f668b13), missing prod dependency, top-level
throw. Local `tsx` dev CANNOT reproduce it — use `vercel build`.

## Telegram message never arrives (prod), but code "sends" it
1. Was the send awaited before the response? Fire-and-forget dies on Vercel
   (225fdde; again in 25f0812). Check the handler for un-awaited
   `sendTelegram`.
2. Rate limiter: `tg:<ip>` is 12/60s (server.ts:1411, :1915) — bursts drop
   silently by design.
3. Advisor routing: `PWP_TELEGRAM_CHATS` is `name:chatId,name:chatId`
   (server.ts:301-309); an unmapped advisor falls back — the OWNER chat
   (`TELEGRAM_CHAT_ID`) must always get a copy (revert 37333d6 restored
   this invariant; don't re-narrow it).
4. HTML parse failure: `sendTelegram` retries as plain text on "can't parse
   entities" (server.ts:167-179) — if you see plain-text messages, some
   interpolated value isn't escaped; find it and wrap with `escapeHTML`.
5. No token: with TELEGRAM_BOT_TOKEN unset, sends are dry-run console.logs
   (server.ts:151-156) — check env before suspecting code.

## Telemetry values are zero/empty when they shouldn't be
- Scroll depth / velocity always ~0: reading scroll from `window` — the app
  scrolls the `<main>` container, not the window (fixed in f535c48; sampler
  reads `containerRef.current.scrollTop`, useTelemetry.ts:139-193). Any new
  scroll-derived signal must read the container.
- Heartbeat page number empty: client/server key mismatch — /api/track reads
  `page`, an earlier client sent `current_page` (4ce5358). When adding a
  field, grep BOTH useTelemetry.ts and the /api/track handler for the same key.
- `total_pages: null` in heartbeats: a deps-`[]` timer captured mount-time
  state — read live refs (`numPagesRef.current`), never closure state, inside
  the heartbeat (ec6fddc; useTelemetry.ts:517-546).
- Session-end missing for long sessions: `sendBeacon` returns false on big
  payloads; the code already falls back to `keepalive` fetch and decimates
  >60000 chars (useTelemetry.ts:418-437) — preserve both paths.

## Viewer crashes on mount inside WhatsApp/Line in-app browser
`localStorage` access throws `SecurityError` in storage-blocked webviews.
All reads/writes must go through the guarded helpers (`safeGetItem`/
`safeRemoveItem`, useTelemetry.ts:27-32; hardened in 02c9990). New
localStorage usage that bypasses the guards will crash exactly this cohort.

## WhatsApp/Telegram link preview (OG card) doesn't show
The preview image must be < 300KB or WhatsApp silently drops the card
(documented threshold; mcp/README.md). Check the actual hosted image size
(`/api/check-image-size?url=...` with an `x-pwp-key`). The App UI and the MCP
server both compress to ~290KB JPEG targets for this reason.

## 401 on /api/create-link, /api/r2-presign, /api/shorten, /api/generate-meta
These are `x-pwp-key`-gated and **fail-closed**: empty/missing `PWP_API_KEYS`
means every key is rejected (server.ts:288-297, :315-317). Key format is
comma-separated `name:key` pairs. The client stores its key in localStorage
`pwp_api_key` (App.tsx:87). Rotate/add keys in Vercel env, then redeploy —
changes take effect on next deploy only.

## A share link that used to work now 404s / PDF won't load
R2 bucket `marketupdate` has a 90-day delete lifecycle rule (set 2026-07-12
in the user's Cloudflare console; unverified in-repo — see UNCERTAINTY #1) —
objects older than 90 days are gone, and the link effectively dies even
though the Firestore `links` doc may still exist (Firestore TTL is NOT
enabled; blocked on Spark plan billing). Confirm the object is actually
absent before concluding "expected retention": extract the `f` file path from
the link's decoded payload (or take the `file_id` from the `/view` URL the
short link redirects to) and GET `/api/pdf/<file_id>` — an upstream 404 with
other links working = retention; anything else, keep debugging. See
`run-and-operate.md`.

## "API version does not match Worker version" in the viewer console
pdfjs-dist / react-pdf version drift. `pdfjs-dist` is exact-pinned to 5.4.296
and the worker is bundler-imported (`pdf.worker.min.mjs?url`, Viewer.tsx:3-10).
Do not bump pdfjs-dist independently of react-pdf. See `viewer-frontend.md`.

## Gemini analysis silently absent from Telegram summary
1. Rate caps hit: session-end AI is gated `ai:s:<sid>` 1/60s AND `ai:ip` 30/h
   AND `ai:global` 40/h (server.ts:1618-1620); throttled sessions get the
   non-AI fallback summary — by design, message may read「無 AI」.
2. A model in the wrong tier fails silently: a non-thinking model placed in
   THINKING_MODELS errors on `thinkingConfig` and falls through every time
   (89c57c5). See `ai-calls-gemini.md` before touching the lists.
3. `aiEnabled` false: GEMINI_API_KEY unset/empty → /api/explain-jargon 503s
   and session-end skips analysis.

## Crash: ERR_HTTP_HEADERS_SENT in R2 streaming routes
Mid-stream failure after headers were sent — catch blocks must check
`res.headersSent` and destroy the response instead of res.status() (02c9990,
in /api/pdf and /api/img). Keep that guard when editing the streamers.

## Unhandled rejection kills the function after a slow Gemini call
The timeout won the `Promise.race`, then the loser rejected with no handler.
Every raced API call needs `apiCall.catch(() => {})` attached BEFORE the race
(d4b6546; four sites — server.ts:1074, :1300, :1791, :1826). If you see this
crash, someone removed one.

Re-verify line numbers: `grep -n "apiCall.catch" server.ts` and `grep -n "x-real-ip\|headersSent" server.ts` — if hits moved, update this file.
