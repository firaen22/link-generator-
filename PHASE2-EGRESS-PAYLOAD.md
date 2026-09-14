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

**Validate #1's transfer delta (FOT+FDT) on a Vercel preview against Phase 0 before
claiming the saving.**

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

## Next
Analysis only — no code changed by this report. The must-do (#1, `r2_` redirect) is a
self-contained handler split whose correctness hinges on R2 CORS + the expiry/range
choice above; the create-path win (#2) is independent. Validate #1's FOT+FDT delta on a
Vercel preview against Phase 0 before claiming the saving.

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
