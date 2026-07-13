---
name: architecture-contract
description: Load before editing server.ts handlers, the rate limiter, file_id handling, the Firestore link schema, or viewer state management — these are the invariants whose violation compiles fine and fails only in production or under attack.
---

# Architecture contract — load-bearing invariants (2026-07-13, commit d125074)

Numbered so reviews can cite them. Each: the invariant → why → the tempting
change that breaks it.

## C1. One Express app is the only entry point
All server behavior lives in `server.ts`'s app; `api/[...path].ts` re-exports
it; vercel.json routes everything there. Never add sibling files under `api/`
(dead/shadowed — see failure-archaeology §6). `/api/create-link` is the single
source of truth for minting links (both the web UI and the MCP server call it).

## C2. ESM `.js` extensions + await-before-respond
The two prod-killers. Full rules in `serverless-deploy-contract.md` (Rules 1-2).

## C3. The telemetry endpoints stay unauthenticated + fail-open limited
`/api/track`, `/api/session-end`, `/api/explain-jargon` are called by the
public reader and CANNOT use `requireApiKey`. Protection is layered in-memory
rate caps that fail open (never wrongly drop a real reader). Decision record:
failure-archaeology §2. Tempting change: adding auth "to fix the security
smell" — breaks every issued link's analytics.

## C4. Rate limiter: two stores with different clearing rules (server.ts:204-254)
- `rlCost` (keys `ai:global`, `ai:ip:*`, `jg:global`, `jg:ip:*`): stale-pruned
  only, NEVER bulk-cleared. Clearing it lets an attacker spray unique keys to
  reset the paid-Gemini spend caps (that exact bypass existed; fixed 4ce5358).
- `rlHits` (keys `tg:*`, `ai:s:*`, `jg:store:*`): sprayable, may `.clear()` at
  5000 keys.
- `allow(key, max, window, commit=false)` peeks without charging — jargon
  checks both caps with peek then commits both; session-end relies on
  short-circuit `&&` ordering. Reordering to commit-then-check burns real
  users' budget on rejected requests.
Tempting change: "unify the two maps / simplify the predicate" — the split IS
the security property. New spend-capped keys must go in the cost predicate
(`isCostKey`, server.ts:229-230); new sprayable keys must NOT.

## C5. Client IP = `x-real-ip`, trusted only on Vercel
`TRUST_PROXY_HEADERS = !!process.env.VERCEL` (server.ts:265). Do not set
Express `trust proxy` and do not read the leftmost `x-forwarded-for` (spoofable
→ per-IP caps bypassed). Corollary: `req.protocol` reads 'http' behind Vercel;
scheme checks use `x-forwarded-proto` (server.ts:679-685 origin logic).

## C6. file_id prefix contract is duplicated — change all sites or none
Formats: `f_<urlsafe-b64 firebase path>`, `vblob_<urlsafe-b64 URL>`,
`r2_<urlsafe-b64 R2 key>`. Parsed independently in `/api/share`, `/api/pdf`,
`/api/img`, `/api/track`, `/api/session-end` (server.ts:365-369, :388-394,
:796-826, :879-889, :1352-1358, :1564-1570) and produced in `/api/r2-presign`
and the client. Changing the encoding in one place silently breaks the others,
and old links in the wild use every historical format.

## C7. R2 key discipline
Presign writes only under `reports/` or `images/` prefixes with a sanitized
basename (server.ts:762-767). Reads enforce prefix: `/api/pdf` requires
`reports/`, `/api/img` requires `images/` (server.ts:811-813, :887-889).
Jargon sidecars live under `jargon/<sha256>.json` where the hash INCLUDES the
page content hash so unauthenticated POSTs can't poison other readers' cached
explanations. Loosening any prefix check = cross-prefix object access (was a
real gap, fixed 02c9990).

## C8. Firestore `links` schema (REST, no SDK)
Doc `links/{shortId}`: `q` (LZ-string payload), `clientName`, `createdAt`
(ISO string), `expireAt` (timestampValue, now+30d, written for a TTL policy
that is NOT yet enabled — Spark plan), `adv` (advisor name). Writes are
create-only (`currentDocument.exists=false`) with up to 5 retries on 6-char
base36 id collision (server.ts:695-738) — unconditional writes once silently
overwrote existing links (f535c48). shortId must match `/^[a-z0-9]{1,32}$/i`
before path interpolation (server.ts:505-507).

## C9. The `q` payload is the link — Firestore only stores the envelope
Link content travels as an LZ-string-compressed JSON blob (keys c/r/t/d/i/f/w)
either in the URL (`/s?q=...`, stateless) or in the Firestore doc (`/l/<id>`).
Renaming those one-letter keys breaks every existing link and the MCP client.

## C10. Viewer state: refs, not useState (except `pageNumber`)
All telemetry accumulators and PDF bookkeeping are `useRef` to keep the PDF
canvas from re-rendering (useTelemetry.ts:107 "all useRef — zero re-renders";
docRef in PdfStage.tsx:29). Timers bind with deps-`[]` and read live refs —
reading closure state gave `total_pages: null` heartbeats (ec6fddc). The one
deliberate exception: `pageNumber` is orchestrator state in Viewer.tsx:39 so
telemetry sees every page change. Tempting change: "convert these refs to
state for readability" — measurable canvas jank + frozen-closure bugs.

## C11. sanitizeSessionEnd is the single choke point
Every `/api/session-end` body read happens AFTER `sanitizeSessionEnd()`
(server.ts:1552-1558). New fields go into the sanitizer (with clamps/caps in
its style), never read raw.

## C12. escapeHTML everything that reaches Telegram-HTML or OG pages
`escapeHTML` / `escapeHTMLAttr` (server.ts:28-40) wrap ALL user-influenced
values in Telegram `parse_mode:HTML` messages and OG meta HTML; the redirect
script embeds URLs via `JSON.stringify(...).replace(/</g,'\\u003c')`
(server.ts:430). escapeHTML coerces null/undefined deliberately — don't
"optimize" that away (missing client_name once hung throttled responses).

## C13. Glossary overrides at serve time; stores keep raw model output
`applyJargonGlossary` runs at EVERY /api/explain-jargon return point — four
serve-time call sites at d125074: L1 cache (server.ts:1250), R2 store
(:1258), in-flight-dedup follower (:1268), fresh result (:1333) — so glossary
edits take effect immediately for already-cached pages. Adding a return path
means adding a fifth call site. Applying it before storing would freeze old wording
into R2. (jargon-feature.md has the full pipeline.)

Re-verify: `grep -n "isCostKey\|TRUST_PROXY_HEADERS\|currentDocument" server.ts` — all three must still exist; if lines moved, update references.
