---
name: security-model
description: Load when a change adds or modifies - an outbound fetch of a user-influenced URL, an R2/Firestore key built from request input, a Telegram or HTML response containing request data, a new public endpoint, or anything in the rate limiter. This repo has had five hardening rounds; new code must clear the same bars.
---

# Security model — the gates every change must clear (2026-07-13)

History: five real hardening rounds (f535c48, 25f0812/#3, 76e4b14/#4,
4ce5358/#8, 9440103/#9, 02c9990/#16), several surfaced by multi-model
adversarial review. The gaps below were all REAL; the checklists encode them.

## Gate 1 — outbound fetch of anything user-influenced (SSRF)
Trigger: `fetch(...)` where any part of the URL derives from request input.
Checklist (all boxes required):
- [ ] Host allowlisted (`ALLOWED_PDF_HOSTS`, server.ts:45-61) OR validated by
      `isPublicHttpUrl` (server.ts:68-95 — rejects private IPv4 ranges,
      loopback, 169.254 metadata, `.local`, and IPv6 literals as verified at
      d125074; IPv6 was a real hole closed in 02c9990 — re-read the function
      before relying on its coverage).
- [ ] `redirect: 'manual'` — the allowlist is checked on the initial URL only;
      a 302 from an allowed host reached internal targets before 4ce5358.
      R2 presigned GETs never legitimately 3xx.
- [ ] `AbortSignal.timeout(...)` set (30s proxies, 8s check-image-size) —
      unbounded fetches tie up the serverless worker.
- [ ] https-only where the allowlist path is used.
Done when: all four hold at the new call site.
BAD (observed shape): "the URL comes from our own presign flow, it's safe" —
the `vblob_` path also decodes arbitrary URLs from old links; validate anyway.

## Gate 2 — request data reaching Telegram or HTML
Every interpolated value: `escapeHTML()` (Telegram HTML + OG text nodes),
`escapeHTMLAttr()` (attributes), `JSON.stringify(url).replace(/</g,'\\u003c')`
(inline script strings). Reflected inputs in error responses count — the
`/l/:shortId` 404 once reflected the raw id into text/html (25f0812).
Done when: `grep` of your handler shows no `${...}` of request data without a
wrapper.

## Gate 3 — keys/paths built from request input
- R2: sanitize to basename (`replace(/[\\/]/g,"_").replace(/\.\./g,"_")`,
  server.ts:762) and enforce the route's prefix on read (C7 in
  architecture-contract.md).
- Firestore: validate charset before path interpolation
  (`/^[a-z0-9]{1,32}$/i`, server.ts:505).
- file_id: only via the established `f_`/`vblob_`/`r2_` decode helpers.

## Gate 4 — new endpoint auth decision
Default: creation/advisor-facing endpoints take `requireApiKey` (`x-pwp-key`
vs `PWP_API_KEYS`, fail-closed). Public-reader endpoints (called by the viewer
without credentials) instead need rate-limit gates BEFORE any paid or
notification side effect:
- Paid AI work → a spend cap chain in `rlCost` keys (see C4) — per-session,
  per-IP, and a global backstop.
- Telegram → `tg:<ip>`-style hits cap.
- Storage/CPU-cheap lookups → a sprayable pre-gate (e.g. `jg:store:<ip>`
  600/h) before hashing/R2 reads.
An unauthenticated endpoint that proxies a PAID third-party API with no cap
was a real bug (/api/shorten → Dub.co, fixed 25f0812 by gating it).
Done when: you can state, for the new endpoint, what bounds (a) Gemini spend,
(b) Telegram volume, (c) storage reads — per instance and globally.

## Gate 5 — rate limiter edits
Read C4/C5 in `architecture-contract.md` first. Never bulk-clear `rlCost`;
never put a spend key in the sprayable store; keep `x-real-ip` (Vercel-set)
as the IP source; peek-then-commit ordering for multi-cap checks.

## Gate 6 — client-side secrets
No server secret may enter the Vite build. A dead `define` once wired
GEMINI_API_KEY into the client bundle (removed 25f0812). Anything prefixed
`VITE_` IS PUBLIC. Check `vite.config.ts` and grep the built `dist/assets`
for new secret names after adding env vars.

## Gate 7 — response streaming
Catch blocks in streaming handlers check `res.headersSent` and
`res.destroy()` instead of sending status — otherwise mid-stream errors throw
ERR_HTTP_HEADERS_SENT (02c9990).

## Standing review practice
Security-sensitive PRs here get an independent fresh-context review (the
historical rounds each found gaps the author missed — the #16 `req.protocol`
subtlety was caught in review before landing). For any change touching Gates
1-4, request a second-opinion review pass before merge; report findings as
location + mechanism + fix, severity-ranked.

Re-verify: `grep -c "redirect: \"manual\"\|redirect: 'manual'" server.ts` (≥3 expected: pdf, img, check-image-size).
