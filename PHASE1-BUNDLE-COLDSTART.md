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
warm-disk import times (this machine; **lower bound, not a Vercel prediction**):

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

### Must-do
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
   - Import `getSignedUrl` lazily too; annotate with `import type { S3Client }`
     — `isolatedModules` is on, so a value import of the type keeps the eager load.
   - Memoize the **promise**, not the resolved client, and reset it on rejection:
     otherwise concurrent first calls build two clients, or a failed import is
     cached forever.
   - `new S3Client()` reads `R2_*` env at construction — moving it into the getter
     moves a misconfiguration from "every cold start logs" to "first PDF request
     500s"; fail loud with a clear log.
   - **Validation is required, not optional**: confirm the deferral on a *built
     Vercel preview* (init-timing log, cold vs warm), not from source — Vercel
     traces/bundles the package regardless; only a preview proves it isn't
     evaluated at init.

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
- Deferring `google-auth-library` — **needed on the hot redirect path** (Firestore
  REST). Both agy and grok proposed deferring it; reproduction refuted the premise.
- **Edge-caching the redirect response** (agy proposed) — the `/l` handler has
  required side effects: `incrementLinkOpenCount`, `sendShortLinkOpenNotification`
  (advisor "client opened" alert), PIN gating, max-opens enforcement. Caching
  would suppress open tracking and bypass open limits. Also unsafe because the
  handler branches on User-Agent (crawler vs human), so a shared cache entry would
  poison one audience with the other's response. **Rejected.**
- Splitting the catch-all / replacing Express on redirects (right idea, wrong
  phase), chasing `lucide-react`/`pdfjs-dist` **install** sizes as if they were
  request cost, `lz-string` deferral (~0.6 ms), a slimmer pdfjs without a probe.

### Considered & deferred — Cloudflare D1 / Workers migration
Replacing Firestore-over-REST with D1 does not pay off **while compute stays on
Vercel**: D1's speed comes from Workers bindings; from Vercel you'd hit D1's
HTTP API — a cross-cloud hop per short-link resolve, same shape as today's
Firestore REST call, with tighter throughput limits and no relational need
(the workload is key-value: resolve id, increment open-count, check PIN/
lifecycle). It only makes sense bundled with a full move to Cloudflare Workers
(where R2 already lives) — a strategic platform rewrite, out of Phase 1 scope,
and unmotivated by Phase 0 (dominant cost is the Gemini fan-out, not the datastore).

## Corrections to the working assumptions (recorded)
- Warm-disk import time is a **lower bound / opportunity estimate**, not a Vercel
  latency prediction; direction of the gap is genuinely unverified (codex).
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
load-bearing premise reproduced against source. Pre-commit review: Fable
(Claude) returned FIX — the S3-on-reader-path correction, the `filesystem`
routing correction, and the implementer caveats above are its findings,
reproduced and applied. codex-astra (OpenAI) hung without a verdict, so this
pre-commit pass is single-lens — gap recorded.*
