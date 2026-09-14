# Phase 1 — Bundle & Cold-Start Efficiency Review

Follow-up to `PHASE0-BASELINE.md`. Scope: frontend bundle transfer cost and
serverless cold-start init cost. Method: local build + isolated import timing,
cross-checked by three model lenses (codex/OpenAI, grok/xAI, agy/Gemini) and
every load-bearing premise reproduced against the source.

**Traffic assumption** (unmeasured — see `traffic-source-not-vercel`): the hot
path is a client opening a shared report link (`/l/:id` or `/s/:id` → `/view`
PDF reader). The report-**creation** UI (`/`) is low-volume (advisors only).
Rank impact accordingly.

## Headline

The single Vercel catch-all evaluates `@aws-sdk/client-s3` at isolate init on
*every* cold start, including short-link redirects that never touch S3. But S3
**is** needed one hop later on the reader flow (`/api/pdf`, `/api/img` for `r2_`
files), so deferring it **shifts** rather than saves cost for the dominant reader
path — the clean saving is narrower than it first looks (see must-do #1).
Frontend route code-splitting is real but helps almost only the **low-volume
`/` route**; on the hot `/view` path it saves ~3%.

Only `/api/*`, `/s*` and `/l/*` reach the serverless function — `/view` and its
JS/CSS are static assets served by Vercel's `handle: filesystem` before the
catch-all `[verified: vercel.json]`, so they carry no function cold-start cost.

## Measurements (all `[verified: local]`)

### Bundle (`vite build`)
- Current: **one** JS chunk `index.js` **952.85 kB (291.60 gzip)**; `index.css`
  50.67 kB (9.53 gzip); `pdf.worker` 1046.21 kB (separate file, gzip not
  measured); dist total 2.0 MB.
- Cause: `src/main.tsx` eagerly imports both `App` and `Viewer`; no `React.lazy`,
  no `manualChunks`. Every visitor downloads App + Viewer + pdfjs regardless of
  route.
- Probe (App/Viewer → `React.lazy`, reverted after): index 74.86 gzip · App 9.28 ·
  Viewer 36.45 · `pdfBridge` (pdfjs) **172.16** · Viewer.css 2.00.

| Path | current gzip JS | split gzip JS | delta |
|---|--:|--:|--:|
| `/` creation (low-volume) | 291.60 | ~84 (index+App) | **−207 kB (−71%)** |
| `/view` reader (**hot**) | 291.60 | 283.47 (index+Viewer+pdfBridge) | **−8.1 kB (−3%)** |

The −8 kB is just the App chunk not loading; pdfjs (172 gzip) is unavoidable on
`/view`.

### Cold-start (single catch-all `api/[...path].ts` → `server.ts`)
Top-level imports evaluated on every cold start, for every route. Isolated
warm-disk import times (this machine; **local measurements only — not bounds and
not Vercel predictions; the direction of the gap to production is unverified**):

| module | ms | used by hot redirect? |
|---|--:|---|
| `@aws-sdk/client-s3` | 82.1 | not at redirect, **yes at next hop** (`/api/pdf`,`/api/img`) — defer = shift |
| `@aws-sdk/s3-request-presigner` | 1.0 | same as above |
| `google-auth-library` | 29.1 | **YES** on `/l` (Firestore REST, `server.ts:880`); `/s` is Firestore-free — keep eager |
| `@google/generative-ai` | 1.1 | no (per-call already) |
| `express` | 55.9 | yes (the app) |
| `lz-string` | 0.6 | — |

`s3Client` is a module-top singleton (`server.ts:621`) used at ~6 handler sites;
redirects (`/s`, `/l`, lines 682–1200) never reference it `[verified: grep]`.

### Vestigial dependency
`src/firebase.ts` (Firebase client SDK) is imported nowhere — never enters the
bundle. `firebase` (39 MB installed) is dead weight in `package.json` only.

## Recommendations (ranked)

### Primary lever (low-risk; reader benefit unproven — validate before claiming)
Ranked first as the only server-side init lever, **not** as a proven reader win:
its benefit for the dominant r2 reader is ~zero (shift, below), so its real payoff
is the minority request classes plus general init hygiene. The unmeasured
`pdf.worker` transfer/caching (nice-to-have #4) may be a larger real `/view` win
and should be measured alongside it.

1. **Defer `@aws-sdk/client-s3` + `s3-request-presigner`** behind a lazy,
   memoized async getter (`await import('@aws-sdk/client-s3')` *inside* the
   handlers; **not** top-level await, which would defeat it — move the
   `new S3Client()` construction into the getter too).

   **What this actually buys — smaller than the raw 83 ms.** S3 is on the reader's
   critical path one hop after the redirect: `/l` → `/view` → `pdfBridge` fetches
   `/api/pdf/:id?lid=` (`pdfBridge.ts:65`), which for `r2_` files calls
   `getSignedUrl(s3Client,…)` (`server.ts:1966`); `/api/img` (2041) too. If
   `/api/pdf` lands on the isolate the redirect just warmed, the getter **shifts**
   the ~83 ms from redirect TTFB to first-PDF-fetch — **net ~zero for the r2
   reader**. It is a true saving only for requests that never reach `/api/pdf`:
   PIN-gate pages, revoked/expired/max-opens pages, non-`r2_` (`f_`/`vblob_`)
   files, and crawler hits (though crawlers then fetch `/api/img/r2_…`, which also
   uses S3). Figures are warm-disk; Vercel absolute unverified.

   **Implementer caveats** (from code review):
   - **Move *every* runtime `@aws-sdk/client-s3` import into the lazy getter**, not
     just `S3Client`: `GetObjectCommand` and `PutObjectCommand` are imported on the
     same top-level line (`server.ts:8`), and `getSignedUrl` from
     `@aws-sdk/s3-request-presigner`. Leave any one of them as a top-level `import`
     and the package still loads at init — the deferral is **entirely defeated**.
     Check for transitive eager imports (a helper that pulls the SDK) too.
   - Type-only references must be `import type { S3Client }` — a value import of a
     type is what keeps the eager load; `isolatedModules` does not erase it for you.
   - Memoize the **promise**, not the resolved client, and reset it on a *client-
     construction* rejection so concurrent first calls don't build two clients.
     Note a failure inside `import()` itself (module evaluation) is cached by the
     ESM loader and a getter reset cannot retry it — only construction failures are
     retryable.
   - `new S3Client()` interpolates `R2_*` env into its endpoint/credentials, but the
     `|| ""` fallbacks mean construction never throws; a misconfig already surfaces
     at the first `.send()` today and still will after deferral — so this is **not**
     a new failure mode, just relocated slightly later in the same request class.
   - **Validation is required, not optional**: running the *built* artifact
     establishes evaluation timing (init vs first-use), and a Vercel deploy
     establishes the actual latency impact — Vercel traces/bundles the package
     regardless, so source inspection alone proves nothing.

### Nice-to-have
2. **`React.lazy` App vs Viewer** — but only with `/view` `modulepreload` to
   avoid a fetch waterfall, and sold honestly as a **low-volume `/`** win
   (−71%), not a `/view` win (−3%).
3. **Remove `firebase`** from `package.json` (install/CI only; 0 runtime).
   Verified nothing imports it beyond the vestigial `src/firebase.ts`.
4. **Cache/compress `pdf.worker`** — immutable hashed URL + confirm CDN
   brotli/gzip (it's the largest `/view` asset; gzip unmeasured).
5. Fold in per-call **`@google/generative-ai`** dynamic import if touching those
   handlers anyway (~1 ms; not its own task).

### Skip this phase
- Deferring `google-auth-library` — **needed eagerly on `/l`** (Firestore REST at
  `server.ts:880`), so a lazy getter only shifts its ~29 ms onto the same request,
  like S3. `/s` is Firestore-free and could benefit on `/s`-dominant traffic, but
  the `/s`-vs-`/l` split is unmeasured — leave eager for now (agy and grok both
  proposed deferring it; the shift-vs-save reasoning applies here too).
- **Edge-caching the redirect response** (agy proposed) — the `/l` handler has
  required side effects: `incrementLinkOpenCount`, `sendShortLinkOpenNotification`
  (advisor "client opened" alert), PIN gating, max-opens enforcement. Caching
  would suppress open tracking and bypass open limits — that is the fundamental
  blocker, independent of cache key. (The handler also branches on User-Agent, so a
  non-UA-keyed cache would additionally poison crawler/human responses; a UA-keyed
  cache fixes *that* but not the side-effect suppression.) **Rejected.**
- Splitting the catch-all / replacing Express on redirects (right idea, wrong
  phase), chasing `lucide-react`/`pdfjs-dist` **install** sizes as if they were
  request cost, `lz-string` deferral (~0.6 ms), a slimmer pdfjs without a probe.

### Considered & deferred — Cloudflare D1 / Workers migration
Out of Phase 1 scope, and no motivation from Phase 0 (dominant cost is the Gemini
fan-out, not the datastore). The architectural reason it's unattractive *while
compute stays on Vercel*: D1's low latency comes from Workers bindings; reached
from Vercel over its HTTP API it's a cross-cloud hop per short-link resolve — the
same shape as today's Firestore REST call, with no relational need (the workload
is key-value: resolve id, increment open-count, check PIN/lifecycle). It would
plausibly pay off only bundled with a move to Cloudflare Workers (where R2 already
lives), which is a strategic platform rewrite, not an efficiency tweak. Throughput
limits and the exact latency trade are unquantified here — the scope call, not a
benchmark, is what defers it.

## Corrections to the working assumptions (recorded)
- Warm-disk import time is a **local opportunity estimate**, neither a bound nor a
  Vercel latency prediction; the direction of the gap to production is genuinely
  unverified (codex).
- Isolated import times are not strictly additive (shared sub-deps).
- `firebase` is **never imported**, so "tree-shaken" is imprecise — it's simply
  dead `package.json` weight (grok).
- The "aws-sdk 11M" install figure is ambiguous (scoped v3 vs legacy) — not used
  as the cold-start cost; the timed cost is the 82 ms above.

## Next
Phase 1 findings are analysis only — no code changed. If greenlit, the must-do
(lazy aws-sdk getter) is a small, self-contained PR; validate cold vs warm on a
Vercel preview before claiming the saving (codex).

---
*Analysis cross-checked by codex (OpenAI), grok (xAI), agy (Gemini); every
load-bearing premise reproduced against source. Pre-commit review completed as a
dual-family gate — Fable (Claude) and codex-astra (OpenAI) both returned FIX.
Fable: the S3-on-reader-path correction, the `filesystem` routing correction, and
the implementer caveats. codex-astra: the "move every SDK import (incl.
GetObjectCommand/PutObjectCommand) or deferral is defeated" catch, the corrected
`R2_*`-env failure caveat, the timing-language contradiction, the google-auth
`/s` nuance, the cache-key qualification, and the softened D1 absolutes. All
findings reproduced and applied.*

---

## Validation — eager vs deferred A/B (post-merge, 2026-09-14)

The lazy getter shipped in `9e9770f` (merged to `main` as `987b50f`, PR #38).
This section records the measurement promised above ("validate cold vs warm
before claiming the saving").

**Why a local A/B, not a Vercel one.** A production A/B is impossible after
merge — the eager code is gone from `main`, so there is no "before" isolate to
measure. Preview deployments are SSO-protected: every request 302s to
`vercel.com/sso-api` at the edge *before* the function runs, so a preview cannot
be cold-started or read externally `[verified: curl -D-]`. External TTFB from
HK to the `iad1` function region is 350–800 ms, dominated by the cross-Pacific
hop + 82 ms TLS — it cannot isolate an ~80 ms module-eval component. The clean
instrument is a **fresh-process module-eval A/B on the built source**: it
isolates exactly the delta the code changes, and the Vercel container overhead
it omits is identical across both variants, so that overhead cancels out of the
delta. Method: `git worktree` at `41eac22` (last eager commit) vs current
`main`; fresh `node --import tsx` process per iteration, `VERCEL=1` (no listen).

**End-to-end `server.ts` import** (warm tsx + OS cache, min of 12):

| variant | min | p50 | max |
|---|--:|--:|--:|
| deferred (current) | 63.5 | 64.6 | 66.0 |
| eager (`41eac22`) | 107.3 | 109.9 | 130.2 |
| **delta** | **~44 ms** | ~45 ms | — |

ms. The two trees differ *only* in the aws-sdk imports + module-scope
`new S3Client()`, so the delta is fully attributable to the deferral.

**Payload isolated** (fresh process: `import client-s3 + s3-request-presigner`
then `new S3Client`):
- warm OS cache: **~35 ms** (import 33.6 + construct 1.5), stable across 14 runs
- cold disk (first run, files not yet in page cache): **~83 ms** — corroborates
  the 82.1 ms Phase 1 figure
- client construction alone: ~1.5 ms (negligible)

**Reading it for Vercel.** A cold start is a fresh container with a *cold* file
cache, so the representative saving is the **~83 ms** end (same files: 35 ms warm
vs 83 ms cold ≈ 2.4×), paid once per cold isolate. The warm ~44 ms is the firm
lower bound. Consistent with the headline: the saving lands on cold starts that
never touch S3 (short-link redirects, PIN gates, expired/revoked/max-opens
pages); for the r2 reader path it **shifts** to first `/api/pdf`, not saves
(must-do #1 caveat, unchanged). All figures warm-disk local — a lower bound on,
not a prediction of, the Vercel cold-container number.
