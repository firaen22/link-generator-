# Phase 2 — PDF-proxy egress & generate-meta payload

Follow-up to `PHASE0-BASELINE.md` / `PHASE1-BUNDLE-COLDSTART.md`. Scope: the two
**data-cost** mechanisms Phase 0 flagged but did not size — the `/api/pdf` proxy
(Vercel transfer on every reader open) and `/api/generate-meta` (full PDF re-sent to
Gemini per fan-out attempt). Compute cost (the Gemini fan-out) was Phase 0/PR #36–37.
Method: read the handlers + client, size against Vercel Hobby limits, cross-check by
five model lenses (codex/OpenAI, grok/xAI, agy/Gemini, opencode/muse-spark,
nim/nemotron); every load-bearing premise reproduced against source; dual-family
pre-commit gate (Fable + codex-astra) applied to this report and its fixes folded in.

**Traffic assumption** (unmeasured — see `traffic-source-not-vercel`): readers ≫
advisors. `/api/pdf` runs on ~every report open; `/api/generate-meta` runs once per
link creation. Rank accordingly: A dominates aggregate transfer, B has the largest
per-request waste.

## Headline
The one lever that changes the cost *axis* is stopping `/api/pdf` from streaming PDF
bytes through the function: check lifecycle, then **302 to a short-lived R2 presign**
for `r2_` files, so bytes go R2→client and never transit Vercel. Everything else is a
low-volume create-time saving or a cache trick bounded by the lifecycle contract.

## Reproduced facts (`[verified: read server.ts / src]` unless tagged otherwise)
- `/api/pdf` presigns an R2 GET, `fetch()`es the object and **streams it chunk-by-chunk**
  (`for await … res.write`) to the client (`server.ts` ~1941–2052) — it does not buffer
  the whole file, but every byte still transits the function.
- **Two Vercel-metered hops, not one.** The response is metered as **Fast Origin
  Transfer** (function→CDN) *and* **Fast Data Transfer** (CDN→client)
  `[relayed: vercel.com/docs/manage-cdn-usage — confirmed by both reviewers]`. R2→function
  is ingress + an R2 Class B GET; **R2 egress is $0**. So the earlier "double egress ≈ one
  metered hop" framing was wrong in both directions.
- Cache headers: `lid` → `private, max-age=60`; no-lid → `private, max-age=3600`.
  `private` = browser only, no shared cache → every distinct viewer is a full re-proxy.
- The handler sends **no `Accept-Ranges` and ignores `Range`** (always full 200). The
  viewer feeds the proxy URL to react-pdf/pdf.js with default options
  (`PdfStage.tsx:131` `file={pdfUrl}`; single consumer, `pdfBridge.ts:65`), which
  therefore does **one full GET** — there is **no range multiplier today** (grok's worst
  case, checked and refuted).
- `vblob_` uses `redirect:'manual'` because the SSRF allowlist is validated on the
  initial URL only (`server.ts:86`, ~2010).
- `/api/generate-meta` fetches the full PDF (≤14 MB), base64-encodes it (~1.33× →
  ≤18.6 MB) and sends it as `inlineData` on **every** attempt of the nested
  `timeRotatedKeys() × STANDARD_MODELS` loop (~2184–2288). One create can upload ~18 MB
  several times to write ≤20+≤60 zh-Hant characters.

### Hobby-plan transfer cliffs (published limits)
Fast Data Transfer included = **100 GB**; Fast Origin Transfer included ≈ **10 GB**
`[relayed: vercel pricing — reviewers flag 10 GB as the tighter meter; confirm before quoting]`.
A full-proxy PDF response consumes **both**, so **FOT is the ~10× sooner cliff**:

| Avg PDF | Opens to exhaust 100 GB **FDT** | Opens to exhaust ~10 GB **FOT** (the real limit) |
|---|--:|--:|
| 2 MB | ~50k | ~5k |
| 5 MB | ~20k | ~2k |
| 8 MB | ~12.5k | ~1.25k |
| 14 MB | ~7.1k | ~0.7k |

Grows with **readers**, linearly. `private,max-age=60` saves only the *same* browser's
60 s reopen — nothing for the next reader. Lever #1 eliminates **both** meters for `r2_`.

## Recommendations (ranked by payoff on this traffic model)

### 1. `/api/pdf` `r2_`: lifecycle-check, then 302 to a short-lived presign — the Phase 2 lever
**Status: ✅ SHIPPED & LIVE (2026-09-15).** PR #39 (`45f37f8`, merged to `main`),
gated behind `PDF_R2_REDIRECT` (default OFF). Flag set to `1` on Vercel **production**
+ redeployed; R2 CORS configured on bucket `marketupdate` first. Chose option (a)
(`disableRange` + ≤60 s presign). Dual-family pre-commit gate (Fable + codex-astra)
both PROCEED. See "## Progress" below.

Eliminates ~100% of both Vercel transfer meters on the hot path and frees the worker
from pumping bytes at the client's download speed. **Split the handler — `r2_`
redirects; `vblob_` and `f_` keep proxying** (see Blocked).

**Mandatory steps (not optional):**
- **R2 CORS is a hard prerequisite**, not a latency nicety. pdf.js loads `file={pdfUrl}`
  via `fetch` in CORS mode; a cross-origin 302 to R2 without `Access-Control-Allow-Origin`
  fails the load outright and **breaks every reader open**. Configure R2 CORS (`GET`/
  `HEAD`, and *expose* `Content-Length`/`Accept-Ranges`/`Content-Range`).
- `Cache-Control: no-store` on the **302 itself** (its body is a presign that expires;
  a cached 302 would hand back a dying URL on reload).
- Put `ResponseContentType` + `ResponseContentDisposition: inline; filename=
  "report_secure.pdf"` on the `GetObjectCommand` so the redirected response renders inline.
- Keep the `r2Key.startsWith('reports/')` guard and the `lid` regex; run
  `checkPdfLinkLifecycle` **before** the 302.

**The revocation trade-off (adjudicated — not a single lens's claim):** a 302-to-presign
is **a new, bounded authorization lease**, not the same thing as today's browser cache.
A cache entry lets a viewer reuse bytes it *already* fetched; a presign authorizes **new
origin requests** for its lifetime — usable after the viewer clears its cache, and
**copyable to anyone** (a bearer token → maxOpens and `lid`↔`f` binding bypass for
whoever holds it). The *nominal* grace is comparable to the existing `max-age=60`, but
`max-age` is a freshness lifetime, not a revocation SLA, and the R2 response has its own
cache policy independent of the 302. Bound the lease by choosing an expiry policy — see
next — and accept the shareability delta consciously (this app's anti-key-sharing binding
is an explicit control).

**Expiry vs range-loading is a fork — pick one, don't claim both:**
- **(a) `options={{disableRange:true}}` + short presign (≤60 s).** One full GET, matches
  today's single-GET behavior, keeps the lease window tight. Simplest; recommended first.
- **(b) range-loading on + longer presign.** Once CORS exposes `Accept-Ranges`, pdf.js
  (range + auto-fetch on by default) issues *many* GETs across a reading session, each
  signature-checked at its own start — so a ≤60 s presign 403s a slow/paused reader
  mid-session. Enabling ranges therefore requires an expiry that covers a session, which
  *widens* the shareability window. The range "latency win" is real only under (b) and is
  not free.

**Transfer-delta validation (done, with a caveat):** a Vercel-preview A/B was
infeasible — preview + deployment-specific URLs are SSO-walled (every request 302s to
`vercel.com/sso-api` at the edge before the function runs). The FOT+FDT elimination is
**structural, not measured**: a 302 means the PDF bytes never enter the function, so
both meters go to ~0 for `r2_` opens by construction. Confirmed live on prod that the
handler now emits the 302 (see Progress); the byte-path change follows from that.

### 2. `/api/generate-meta`: send a cover excerpt / first page, not 14 MB, per attempt
Biggest per-call win: extract text server-side (pdf.js/`unpdf`, buffer already in hand)
and send ~30–50 KB (~8–12k tokens) instead of ≤18.6 MB `inlineData` — ~100–400× fewer
bytes per attempt, ×fan-out, and it removes the case where the 20 s `Promise.race` per
attempt is lost just uploading 18 MB. Aggregate $ is small (advisor-volume), but it
de-risks the create-path timeout. **Bound:** scanned/image-only PDFs extract empty →
fallback to first 1–2 pages as an image (or Vision OCR); a fixed excerpt can miss topic
if content is late (use first-pages + headings).

### 3. Gemini Files API: upload once, reference by `fileUri` across the fan-out
Stops re-transmitting the payload each retry (≤18.6 MB × N → one upload + cheap refs).
**Bound:** Gemini files are scoped to the **project**, not the individual key — so
same-project key rotation *can* share one upload; only rotation across *distinct
projects* forces separate uploads (verify `timeRotatedKeys()`'s project topology). Upload
still counts against the 45 s budget. Smaller once #2 is done; do #2 first.

### 4. no-lid responses → shared/CDN cacheable (`public, s-maxage`)
Bounded and smaller than it looks: a CDN hit still sends the PDF **CDN→client (FDT)**, so
it saves the **function invocation + Fast Origin Transfer**, not the FDT meter. Only for
the no-lid branch (`/view?q=`, `/s/:file_id`) which has no lifecycle to enforce, and it
overlaps with #1 for `r2_` objects (those already bypass Vercel once redirected). **Never
for `lid`** — a shared cache bypasses revoke/expiry/maxOpens. Caveat (nim): the no-lid
path is already an un-revocable route to the bytes; caching adds no exposure it didn't
already have, but don't extend it to `lid`. (No defensible payoff ratio — depends on the
unmeasured no-lid share and hit rate.)

### 5. Memoize `{title,description}` by an immutable content key
Cache the generated meta so a re-linked report skips Gemini. **Bound:** `f = r2:reports/…`
is a storage *key*, not proof of content-addressing — overwriting the object at that key
would serve stale metadata. Key the cache on an object version / content digest (or a key
you know is immutable), not the path alone. Free money but low hit rate (few links per
object). Also consider narrowing the fan-out breadth for this simple task (codex) — one
primary model, fall back only on quota/transient/model errors, not every empty parse.

## Blocked / illusory (do not implement)
- **302 for `vblob_` / `f_`** — keep both proxied. NB the reason is **not** client-side
  SSRF (a 302 makes the *client* fetch; server-side SSRF is about the server following
  redirects in its own `fetch`, which `redirect:'manual'` guards). The real reasons:
  `vblob_` is an arbitrary allowlisted upstream URL that a redirect would expose to the
  client and that may be unstable/credentialed; `f_` (Firebase Storage) has no equally
  safe short-lived signed URL to hand out.
- **CDN-cache `lid` responses** — bypasses `checkPdfLinkLifecycle` (revoke/expiry/
  maxOpens invisible for the TTL). The `private` header is the intentional tradeoff.
- **Client-side metadata generation** — advisor browsers can't hold `GEMINI_API_KEY`.
- **Chasing base64/PDF compression** — base64 isn't Gemini's semantic cost and PDFs are
  usually already compressed; low payoff vs #2.

## Progress
_Updated 2026-09-15._

- **#1 `/api/pdf` `r2_` redirect — ✅ SHIPPED & LIVE in prod.**
  - Code: PR #39 (`45f37f8`), flag `PDF_R2_REDIRECT` (default OFF), client `disableRange`
    (option a). Reviewed by Fable + codex-astra (both PROCEED, no blocking defects).
  - Infra: R2 bucket `marketupdate` CORS set — reader rule (`GET`/`HEAD` from
    `https://share.pmd-hk.com`, exposing `Content-Length`/`Content-Range`/`Accept-Ranges`/
    `Content-Type`/`ETag`) ahead of the preserved advisor-upload rule (`PUT`/`POST` + `*`).
    Verified: preflight from the reader origin returns the scoped `ACAO`; a real GET
    returns the expose-headers.
  - Enabled: `PDF_R2_REDIRECT=1` on Vercel **production** + redeploy (aliased to
    `share.pmd-hk.com`). Verified live: prod `/api/pdf/<r2_…>` → `302`, `no-store`,
    presign `X-Amz-Expires=60`, inline `application/pdf`.
  - **Residual (open):** no end-to-end load of a *real* report through a *real* `/l/<id>`
    tested — that fires the advisor "opened" notification and bumps open counts, so it was
    left for a human open. Every component is verified; only their live composition is not.
- **#2 `/api/generate-meta` text extraction — ✅ CODE COMPLETE & GATED, PR OPEN (merge held).**
  - Code: flag `META_TEXT_EXTRACT` (default OFF). When on, `extractPdfCoverText`
    (already-shipped `pdfjs-dist`, no new dep, reads the content stream — no canvas)
    pulls the first ≤3 pages / 40 000 chars of text and sends ~tens of KB to Gemini
    instead of the ≤18.6 MB base64 PDF per key×model attempt. Falls back to the
    unchanged full-PDF path when extraction throws/aborts/times-out or yields <120 chars
    (scanned/image-only reports), so enabling the flag cannot break those. Flag OFF is
    byte-for-byte the current `[prompt, {inlineData}]` request.
  - Reviewed: 3-lens (codex `gpt-5.6-luna`, agy `gemini-3.8-flash-high`, grok-4.6) then
    dual-family pre-commit gate (Fable + codex `gpt-6-astra`). Fixes applied from review:
    clear the extraction timeout on every race outcome (a dangling timer kept the
    invocation billed ~12 s past the response); `AbortSignal` → `loadingTask.destroy()`
    so a lost race stops the parser; hold the loading task + destroy in `finally` (runs
    even when `getDocument` rejects); reserve one 20 s fan-out attempt of the 45 s budget
    (guard `>= 2000`) so extraction can't starve the fan-out into a 502 on a slow-R2 tail;
    fence the extracted text as untrusted data in the prompt; `verbosity: 0` to silence a
    per-call warning.
  - **Known bound (F1, reproduced):** on Node, pdfjs parses via microtasks on the request
    thread, so the timeout/abort are COOPERATIVE — they land only at the per-page
    `setImmediate` yield, not mid-page. A single pathological page's `getTextContent`
    runs to completion; the real bound is `maxPages=3` + advisor gate + 14 MB cap. The
    per-page yield caps a runaway to one page. True preemption (worker_threads) is a
    follow-up, not this change.
  - **Deferred (D):** a single page's items are joined before the `maxChars` check —
    `getTextContent()` already materializes all items, so peak is one report page; not
    worth extra code at 3-page scope.
  - **Rollout note (F3):** predefined-CMap CJK fonts (no `cMapUrl` set) extract no text →
    `<120` → full-PDF fallback (safe, but no savings). Prod evidence: the browser reader
    already extracts these zh-Hant reports via the same pdfjs API (jargon feature), so the
    real corpus uses embedded fonts / ToUnicode. **Watch the `extract too short` log rate
    after enabling** to confirm on the live corpus.
- **#3–#5 — assessed against the code after #2; recommend NOT building #3, and treating
  #4/#5 as your call (evidence below, verified by direct read 2026-09-15).**
  - **#3 Gemini Files API — RECOMMEND SKIP.** The fan-out reuses one `contentParts` array
    (`server.ts:2402`) and stops on the first success (`return res.json` at
    `server.ts:2436`), so the payload is sent **once on the hot path**; upload-once only
    saves the retry tail and would itself cost an ~18 MB upload before attempt 1 (charged
    to the 45 s budget) plus Files-API lifecycle. With #2 the text-path payload is already
    KB, not MB. Low value on both paths — not worth the complexity.
  - **#4 CDN cache on no-lid — YOUR CALL (cheap, but unmeasured + a privacy tradeoff).**
    One `!lid`-scoped line at `server.ts:2057` (`private, max-age=3600` → `public,
    s-maxage=…`). The no-lid path (`/view?q=`, `/s/:file_id`) is already un-revocable and
    un-authenticated, so no NEW exposure — but it means a **shared CDN caches client report
    PDFs**, the payoff is unmeasured (no-lid share × hit rate unknown), and #1's `r2_`
    redirect (`server.ts:2015`, `no-store`) already bypasses this path for `r2_` objects,
    leaving only `f_`/`vblob_` no-lid opens. Implementable flag-gated (default OFF) like
    the others if you want a measurable lever; not built pending your decision.
  - **#5 memoize {title,description} — RECOMMEND DEFER (marginal).** generate-meta runs
    once per link creation and holds only the storage key `f` (`server.ts:2278`), no
    digest — a correct cache must hash `pdfBuffer` (`sha256Hex` exists at `server.ts:2458`)
    to avoid serving stale meta when an R2 key is overwritten. The jargon two-tier cache
    (in-mem Map + R2 sidecar, `server.ts:2490-2536`) is the reusable pattern but is
    single-feature, so #5 = generalize it + add content hashing. Low-frequency op × low
    hit rate (few links per identical PDF) → non-trivial code for a tiny win.

_Rollback for #1: set `PDF_R2_REDIRECT=0` (or unset) on Vercel prod + redeploy → instant
revert to the proxy path. R2 CORS additions are backward-compatible (upload rule
untouched) and can stay. #2 is inert until `META_TEXT_EXTRACT=1` is set on Vercel prod
(held for a human) — a merged PR changes zero prod behavior._

---
*Cross-checked by codex (OpenAI), grok (xAI), agy (Gemini), opencode (muse-spark),
nim (nemotron); all five ranked the `r2_` redirect #1 and text/first-page extraction as
the top B lever, and rejected the same three blocked levers. Pre-commit dual-family gate
(Fable + codex-astra) both returned FIX; both independently caught the Fast Origin
Transfer omission and the CORS/range/expiry interaction. Applied: two-metered-hop egress
model + FOT cliff; R2 CORS as a hard prerequisite; the presign-expiry-vs-range fork;
no-store on the 302; revocation reframed as a bounded authorization lease (shareability
the real delta); corrected client-302-vs-SSRF rationale; dropped the CDN payoff ratio;
Gemini files project- (not key-) scoped; content-key immutability caveat. The lid-redirect
risk analysis is the report's own adjudication, not any single lens's.*
