---
name: failure-archaeology
description: Load BEFORE proposing any of - adding auth/HMAC to telemetry endpoints, adding a database/KV/dashboard, changing notification routing, changing storage backends, restoring removed viewer "security" features, or deleting the four stale-looking git branches. These were all tried, decided, or reverted.
---

# Failure archaeology — dead ends, reverts, and settled decisions (2026-07-13)

Each entry: what was tried → why it died → residue left in the code → tripwire
(the tempting change that would repeat the mistake).

## 1. Advisor-only Telegram routing — REVERTED (36a33e3 → 37333d6)
Tried: route read-notifications to the mapped advisor only, owner as fallback.
Died: the owner is the master audit log and stopped seeing reads for any
advisor who HAD a mapped chat. Reverted same day.
Residue: `sendTelegramTo(notif, [advisorChat, TELEGRAM_CHAT_ID])` fan-out —
owner always included (server.ts:575-581).
Tripwire: "the owner doesn't need duplicates, send to the advisor only." No —
dual delivery is the intended invariant.

## 2. HMAC tokens / durable KV for telemetry abuse — REJECTED (PR #4 decision)
Tried (proposed in review): sign telemetry requests, or count in Upstash/
Firestore.
Died: HMAC breaks analytics for every already-issued link and isn't a rate
cap; durable KV adds infra/latency/cost and can throttle a hyper-engaged real
client. The user's stated priority is "never drop legitimate telemetry."
Residue: in-memory fail-open sliding-window limiter (server.ts:204-254) with
the layered ai:/tg:/jg: caps. Accepted residual risk: a distributed flood
across many real IPs needs a WAF, not app code.
Tripwire: "these endpoints are unauthenticated, let me add auth/a durable
counter." That reverses a deliberate, documented decision — ask the user first.

## 3. Firestore analytics store + dashboard — REJECTED by user (2026-07-07)
Died: user interrupted mid-build: analytics warehouse is GA4
(`G-DWWL0K4KWZ`), advisor realtime surface is Telegram. A custom store
duplicates GA.
Residue: session-end mirrors a flat scalar event `report_session_end` to GA4
with session_id; behaviour detail goes in Telegram message text.
Tripwire: "let me persist sessions to a DB so we can build reports." Don't,
unless the user explicitly reopens this decision — new behavioural signals go
(a) to GA4 as flat params, (b) into the Telegram message body.

## 4. Storage backend churn: Vercel Blob → Firebase Storage → Cloudflare R2
5d54c64 left Vercel Blob (50MB limit was the constraint); d440c9d moved blobs
to R2 with presigned PUTs. Firestore stays for `links` docs; legacy Firebase
Storage reads remain supported (`f_` file_id prefix + allowlist hosts).
Residue: `src/firebase.ts` initializes Firebase client SDK but is imported
NOWHERE in src/ — vestigial. App.tsx:495 copy still says "via Firebase
Storage" though uploads go to R2 (stale copy, known).
Tripwire 1: "clean up the unused firebase.ts / Firebase env vars" — the
VITE_FIREBASE_* project-id/bucket vars ARE still read server-side for
Firestore REST and legacy reads (server.ts:493, :655-656, :799). Deleting them
breaks short links.
Tripwire 2: "old `f_` links are legacy, drop the branch" — old links in the
wild still resolve through it.
Also dead here: a Google Drive URL fallback in the PDF proxy — added, then cut
(25732d4, returns 400 now). The abandoned Vercel Blob experiments left broken
scratch files (`test_upload.js`, `test_list.ts`) that were the only tsc errors
until 25f0812 deleted them.

## 5. "Security theater" viewer features — DELIBERATELY REMOVED (ec6fddc)
Removed: fake "AI 智能篩選" claim, fake reading-pace estimate, "Decrypting/
Tunnel" loading copy, over-broad screenshot blocking, alarming tracking
headline (moved to honest in-modal `<details>`), native alert()s.
Tripwire: "add back a screenshot blocker / cooler loading screen" — the
project standard is honest UX; capture-blocking is known-ineffective and was
narrowed on purpose.

## 6. Duplicate serverless files — DELETED (f535c48 → 25f0812)
`api/pdf.ts` duplicated the Express `/api/pdf` handler and carried a second
SSRF allowlist copy that had to be patched in parallel, then was deleted:
vercel.json routes all `/api/*` to the one function, so standalone api/ files
are unreachable anyway.
Tripwire: "add a quick api/foo.ts serverless function" — it will be shadowed
dead code, or worse, a drifting duplicate.

## 7. Gemini model-tier mismatch — silent failure (89c57c5)
`gemini-3.1-flash-lite` sat in THINKING_MODELS but doesn't support
`thinkingConfig` — it errored every call and silently fell through, wasting
the highest-quota model. Moved to top of STANDARD_MODELS.
Tripwire: "add the new model to THINKING_MODELS, it's newer so it must
think." Verify `thinkingConfig` + `responseSchema` support first; a wrong
tier placement produces zero errors in logs you'll notice — just quota waste.

## 8. Early Vercel routing churn (9f6c68d, 6d9f2ae and neighbors)
Multiple rewrites/routes reshuffles trying to make `/l/` resolve; settled on
the current vercel.json `routes` array with a `filesystem` handle and SPA
catch-all. Tripwire: "modernize vercel.json to `rewrites`" — it was migrated
AWAY from rewrites deliberately; don't churn it without end-to-end testing
`/l/<id>`, `/s`, `/api/*`, deep-linked SPA paths, and static assets.

## 9. The four remote branches are MERGED leftovers, not WIP
`feat/auto-generate-title-description`, `feat/create-link-endpoint`,
`fix/security-and-telemetry`, `feat/viewer-reader-mobile-ux` — all confirmed
patch-equivalent in main (squash merges; verified via `git cherry`, 2026-07-13).
`git branch --merged` misreports them because of squash-merging.
Tripwire: "there's unmerged work on these branches, let me rescue it."
There isn't. (Deleting them is safe but is an outward action — user's call.)

## 10. sanitizeSessionEnd exists because raw body fields crashed things
NaN-shaped numbers, oversized arrays, and missing client_name (escapeHTML on
undefined threw and hung throttled responses) all occurred. The single choke
point `sanitizeSessionEnd()` clamps everything (sanitizeSessionEnd.ts:31-152)
and MUST run before any use of the body (server.ts:1552-1558).
Tripwire: "read one extra field straight off req.body, it's just a number."

Re-verify: `git log --oneline | grep -iE "revert|theater|migrate" | head` — if new reverts appeared since d125074, this file is incomplete.
