# Phase 3 — Validation & Measurement (close the unmeasured caveats)

Follow-up to `PHASE0-BASELINE.md` / `PHASE1-BUNDLE-COLDSTART.md` /
`PHASE2-EGRESS-PAYLOAD.md`. **Scope: measure, do not build.** Phase 2 shipped four
flag-gated efficiency levers (`PDF_R2_REDIRECT`, `META_TEXT_EXTRACT`,
`PDF_NOLID_CDN_CACHE`, `META_CACHE`) and Phase 1 did cold-start work (code-split, lazy
`@aws-sdk` import); each is *live and correct* but **not one is measured** on real
traffic. Phase 3 turns the "unmeasured payoff" caveats into numbers **where the existing
instrument can produce them**, marks the rest **unobtainable on Hobby** (or names the
minimal instrumentation to propose for approval), and defines a data-driven go/no-go for a
possible Phase 4 (storage / request-count). If the numbers show the levers already did the
job, **the arc ends at Phase 3** — a speculative Phase 4 is out of scope by design.

## Instrument reality (read this before the metrics)
The cross-family review of this scope (Fable + codex-astra) reproduced the instrument and
found several originally-planned metrics **unobtainable as specified**. The measurement
plan below is written to that reality:
- **Primary instrument = `vercel logs <deployment> --json`** (structured: `requestPath`,
  `responseStatusCode`, `cache`, `timestamp`, `id`, `logs`). The `-x` form is for reading;
  `--json` is the countable form. `requestPath` **strips the query string** — so anything
  keyed on a query param (e.g. `?lid=`) is invisible to log counting.
- **CDN HITs never invoke the function** → they are **absent from runtime logs**. Any
  metric that needs a CDN hit/miss *rate over real traffic* is unobtainable from logs on
  Hobby (Web Analytics off, no per-route CDN breakdown — `traffic-source-not-vercel`).
- **Runtime-log retention on Hobby is short (~1h) [assumed: Vercel docs — verify]** and
  logs are **per-deployment**. A 7-day span therefore requires repeated appended pulls,
  not one end-of-window read (see Window & cadence).
- GA4 supplies traffic *weighting* only, and only as far as its own coverage is validated
  (client events can be blocked/dropped) — it is not a 1:1 count of server operations.

## Non-goals (hard boundary)
- **No new features, no code optimization.** Any fix that measurement *motivates* is a new
  phase with its own review gate.
- **No new instrumentation code except two named, pre-approved additions** (M4 `lid=1|0`
  token, M5 `bootAt` line — see those rows). Each is proposed **for your approval before
  writing**; until approved, its metric is reported "unobtainable with current
  instrumentation."
- **No `/l/` opens to manufacture data.** The revocation/notification/openCount side
  effects live in the `/l/` handler only. A **no-lid** `/api/pdf/f_…` or `/api/generate-meta`
  request is inert w.r.t. counters and notifications, so it is the *only* permitted probe —
  and only for the narrowly-scoped cacheability check in M4. No synthetic `/l/` traffic.

## Metrics — each tied to a lever, each with a REAL source + a falsifiable threshold
Every metric is reproduced first-hand from a log pull (R0) before it is written down. A
metric the instrument cannot produce is reported **"unobtainable on Hobby"**, never
estimated. `[verified: server.ts:<line>]` tags mark facts checked against source.

| # | Lever | Metric (obtainable form) | Source | Falsifiable threshold |
|---|-------|--------------------------|--------|-----------------------|
| M1 | #1 `r2_` redirect | of `/api/pdf/*` requests, share by `responseStatusCode`: 302 (`r2_` redirect) vs 200 (`f_`/`vblob_` proxied); exclude 403/410 lifecycle blocks from the denominator | `requestPath` prefix `/api/pdf/` + `responseStatusCode` | report **request share only**; client sets `disableRange` [verified: server.ts:2003] so requests≈opens. **Byte savings unmeasurable without response sizes — marked so.** "Bytes never enter the function" = PDF *payload* bytes on the 302 path |
| M2 | #2 text-extract | of generate-meta attempts that reach extraction, partition into `text mode \| N chars` / `extract too short` / `text extract failed` | those three `[GENERATE_META]` log lines | denominator = the three lines only; the unlogged remainder (`extractBudget<2000` silent full-PDF [verified: server.ts:2410], flag-off) = `[GENERATE_META] Success − ΣM2`. Threshold: **≥80% text-mode over ≥10 extraction attempts** on the live zh-Hant corpus (F3) |
| M3 | #5 `META_CACHE` | avoided Gemini fan-outs = `cache hit` ÷ (`cache hit` + `Success` + failures) | `[GENERATE_META] cache hit` + `[GENERATE_META] Success` (the `[GENERATE_META]` prefix is required — bare `Success \| <model>` also matches `[JARGON] Success` [verified: server.ts:2515 vs 2860]) | **any sustained hit rate over ≥20 generations** ⇒ cache earns its keep; **~0 over ≥20** ⇒ not earning its keep, flag for removal (NOT "deferral was right" — #5 shipped) |
| M4 | #4 `PDF_NOLID_CDN_CACHE` | **traffic-wide hit rate: UNOBTAINABLE on Hobby** (query strings stripped → can't split lid/no-lid from `requestPath`; CDN HITs absent from function logs). Report instead: (a) **structural bound** — only `f_`/`vblob_` no-lid opens reach the cacheable branch [verified: server.ts:2064 comment], so real effect ≤ non-`r2_` share from M1; (b) **cacheability probe** — two side-effect-free no-lid `/api/pdf/f_…` GETs, expect `x-vercel-cache: HIT` on the 2nd (proves *cacheability*, not rate) | structural (M1) + one permitted probe | probe: 2nd response is `HIT` ⇒ caching active. Optional approved add: one-token `lid=1\|0` in the existing `[PDF_PROXY]` log line → then no-lid share becomes countable |
| M5 | Phase 1 cold-start | **frequency: obtainable** — count module-init log bursts (`Telegram Bot: ✅ LOADED` / `Advisor TG chats …`, module-scope [verified: server.ts:~706], print once per cold init) ÷ total invocations. **Duration: needs approval** — a module-scope `bootAt` + one first-request log line | init-burst count vs invocation count | report cold-start frequency per route; tie to the actual lever (lazy `@aws-sdk` only helps requests that never reach `/api/pdf`). Duration = "unobtainable until `bootAt` approved" |
| M6 | (Phase 4 axis: request-count) | invocations per open, by route, from `requestPath` — `/api/track` heartbeats dominated Fable's sample (34/43) | same `--json` pull | free from the M1 pull; establishes the request-count baseline Phase 4 would optimize |

**Side finding (out of Phase 3 scope, logged as a Phase 4 candidate):** extraction runs
*before* the cache check [verified: `text mode` at server.ts:2437, `META_CACHE` lookup at
2461], so a cache hit still pays up to a 12s text extraction before returning cached meta
— a real efficiency bug, not fixed here.

## Firestore / R2 accounting — an explicit MODEL, not a measurement
This section is a **projection**, labeled as such (it does not violate the "not estimated"
rule, which governs M1–M6): handler operation-counts × GA4-weighted volume, with
assumptions stated.
- **Firestore reads/writes per lid open** = **≥2 GETs + 1 commit**: the `/l/` resolve GET
  [verified: server.ts:905] + the `/api/pdf` `checkPdfLinkLifecycle` GET on `links/{lid}`
  [verified: server.ts:1882] + the non-crawler `openCount`/`lastOpenAt` commit. Multiply by
  GA4 open volume (a **model**, flagged; GA4≠server-op count) → distance to the Firestore
  free-tier **daily** read/write caps.
- **R2 request volume** (omitted originally): PDF GETs (proxy path + the presigned-GET the
  302 authorizes) and `meta/<sha>.json` L2 reads/writes (#5). Count request classes, don't
  assume.
- **Storage**: object count + bytes under `reports/` **and** the `meta/<sha>.json` sidecars,
  sampled at **≥2 points** (a single snapshot cannot measure growth). R2 has a live 90-day
  delete rule → **R2 storage is bounded**; **Firestore is the unbounded store** (TTL
  Blaze-blocked, `retention-cleanup-r2-firestore`) — do not conflate them.

## The Phase 4 gate (decide from numbers, with an escape hatch)
Open Phase 4 **only if** a measured/modeled quantity crosses a concrete cliff:
- Firestore **daily** reads or writes projected to approach the free-tier cap at current
  growth, **or** Firestore document count/bytes growing unbounded (no TTL) on a horizon
  worth acting on (state the horizon, e.g. 90 days).
- **Not** R2 storage on its own — the 90-day delete bounds it.
Outcomes are **three**, not two: **yes** (cliff crossed — name it), **no** (headroom ample
— name the margin), or **inconclusive** (evidence insufficient — name what's missing and
what pull would resolve it). A missing measurement yields *inconclusive*, never a silent
"no."

## Window & cadence (feasible against ~1h retention)
- Runtime-log retention ~1h [assumed — verify] and per-deployment ⇒ **append `--json`
  pulls to a local `.jsonl` at ≤ every ~50 min**, dedupe by `id`, and **report coverage %**
  (sampled, not continuous, if gaps appear).
- Any **prod redeploy** in the window splits the log stream **and flushes the L1 meta cache**
  (affects M3) — note redeploys against the timeline.
- Target a real-traffic window (~7 days, extend if open volume is thin); representativeness
  is **conditional on GA4-measured coverage**, not assumed from calendar time.

## Deliverable & exit criteria
A **Phase 3 results** section appended here: M1–M6 each with a number or an explicit
"unobtainable on Hobby"; the Firestore/R2 model with its assumptions; and a Phase 4
verdict — **yes / no / inconclusive** — with the numbers behind it. Done when every
Phase 1/2 "unmeasured" caveat is resolved to a number, mapped to a metric, or marked
unobtainable, and the gate is decided (or explicitly inconclusive) with evidence.

## Risks / caveats
- **Passive observation only.** Reading logs is inert; the sole permitted active probe is
  the side-effect-free no-lid GET in M4. No `/l/` opens (they notify real people + bump
  counts — the reason the #1 e2e test was a single revoked labeled link).
- **No controlled comparison under this scope** — the levers are already enabled, so any
  before/after is observational, not an A/B.
- **Traffic assumption unproven**: readers ≫ advisors is assumed (`traffic-source-not-vercel`);
  M1/M4/M6 lean on it, so GA4 open volume is the weighting ground truth *as far as GA4
  coverage is validated*, logs the per-request detail.

---

## Phase 3 — Run 1 results (2026-09-15, deployment `3o9756n8z`, built from `47f099b` — post-#43/#44)

**Method:** passive log pull + ONE authorized controlled generation. "One generation" =
two `create_share_link` calls on **identical PDF bytes** (title/desc omitted → `generate-meta`
fired): call 1 = cache miss + real Gemini generation, call 2 = cache hit (no new generation).
Both links revoked. No `/l/` reader opens; no synthetic traffic beyond this one approved probe
(the other traffic in-window — self-test heartbeats, the revoked `/l/irxagz`, revoke calls — is
pre-existing, not initiated here). [verified: `vercel logs --json/-x`, server.ts read]
Reviewed cross-family (codex-luna + agy + grok-4.6 analysis, then Fable + codex-astra
pre-commit gate); all reproduced findings folded in below.

### Coverage reality (the headline)
Across the captured records, the only traffic was leftover self-test `/api/track` heartbeats
(client `E2E-TEST-DELETE`, now stopped), the revoked `/l/irxagz` (2× 410, revoke still live),
2 revoke calls, and my two probe generations. **No organic reader/advisor traffic in the
captured records.** Caveat: `--json` pulls **hit the 100-line cap** (the `3uqjamgni` pull
returned exactly 100 lines), so the captured span is the last ~100 records per deployment —
**not a guaranteed full retained hour.** "Zero organic" is therefore established for the
captured records, not proven absent across the whole window. Either way the rate/share metrics
that need real reader/advisor volume are **uncovered this run** — the thin-traffic case the
scope pre-registered.

### Per-metric outcome

| # | Metric | Run-1 result | Status |
|---|--------|--------------|--------|
| M1 | `r2_` redirect share (302 vs 200 on `/api/pdf/*`) | **0 observed `/api/pdf` requests** — link creation never hits `/api/pdf`; only a reader open does [assumed: `/l/`→`/api/pdf?lid=` route architecture]. Empty denominator (not a measured 0% share) | **uncovered** — needs real reader opens |
| M2 | text-extract partition | **2** `[GENERATE_META]` extraction lines (the M2 denominator), both `extract too short (0 chars)` → **text-mode 0/2**; **1 unique input**. Call 2 re-ran extraction before hitting cache (side finding), so it is a 2nd extraction line. What the log proves: pdfjs opened the doc and found **0 text items in the first ≤3 pages** [verified: server.ts:2429,2439; extractor propagates load errors, not swallowed]; "image slide deck, no text layer" is the author's characterization of the input [assumed] | **below ≥10 lines and ≥80% threshold** — needs window |
| M3 | `META_CACHE` hit | **miss→hit CONFIRMED live**: call 1 `Success \| gemini-3.5-flash-lite`, call 2 `cache hit (L1)` — no 2nd `Success`, no fan-out (early return server.ts:2480). Descriptive rate = 1/(1+1+0)=50% on N=2 | **L1 hit-path verified**; ~73s gap does **not** exercise the 24h TTL (#41/#42 untested here); L2 write is fire-and-forget with **no log line** (server.ts:2521) → L2/cross-instance unverified; rate (≥20) needs window |
| M4 | `PDF_NOLID_CDN_CACHE` hit | probe not runnable (no `f_`/`vblob_` no-lid URL; manufacturing one has side effects this run's authorization forbids). Bound is **architectural** (only `f_`/`vblob_` no-lid reach the cacheable branch) [relayed: scope/code premise], **not** computed from this run's empty M1 | **structural bound only** (unchanged) |
| M5 | cold-start frequency | init-burst marker = module-scope [verified: server.ts:699-704], so it's a valid cold-init signal. **1 burst** appears in the pull. But per-invocation attribution is **not established** (no per-line timestamps; the burst is transcribed after `Success`, an ordering anomaly), and the scope fraction (bursts ÷ **total invocations**) was **not constructed**: the 96 `/api/track` invocations' cold/warm status isn't in the 100-line-capped pull, so neither `1/2` nor `1/102` is valid | **marker validated**; frequency needs window; duration needs `bootAt` (approval) |
| M6 | request mix by route | captured routes: `/api/track` 96 + `/l/irxagz` 2 + `/api/revoke-link` 2 + `/api/generate-meta` 2 = **102**; **0 reader opens** → invocations-per-open undefined | not representative — needs window |

### Side finding — CONFIRMED empirically (Phase 4 candidate)
Extraction (server.ts:2410) runs **before** the cache check (server.ts:2461). Proof: call 2,
a cache hit, logged `extract too short (0 chars)` **then** `cache hit (L1)` — a cache hit
**still pays the extraction attempt** before returning cached meta. The cache saves the Gemini
fan-out, **not** the extraction. Code-confirmed (2410 < 2461) AND log-confirmed. Cost note:
call 2's extraction was a **completed 0-char parse, not a timeout**; its cost is the actual
parse time, not the 12s cap (`Math.min(12000,…)`, server.ts:2407) — a text-layer PDF running
nearer the budget would pay more, but the elapsed cost is **unmeasured** (no timing line). Fix
= check cache before extracting. This is a **compute/latency** inefficiency, distinct from the
storage/request axis the Phase 4 gate targets.

### Scope-doc issue surfaced by Run 1 (resolve before the window run — do NOT ship a formula here)
The scope's M2 residual formula (`unlogged full-PDF = Success − ΣM2`) **breaks when a cache hit
interleaves**: a cache-hit request adds to ΣM2 (it extracts) but returns without a `Success`,
so `Success − ΣM2` goes **negative** (this run: 1 − 2 = −1). The residual cannot be derived
from `Success`/`ΣM2` aggregates alone once cache hits exist, and the original formula also
ignores `failures`. The correct count (silent `extractBudget<2000` full-PDF generations)
requires **per-request pairing** of log lines — which the `-x` grouping provides. The exact
counting rule must be worked out and validated **during the window run**; this doc deliberately
ships **no replacement formula** (a candidate tried here was itself wrong), only the flag.

### Corpus behavior (hypothesis, not a Run-1 finding)
This run's single probe → 0 text items → fallback. A prior run logged `text mode | 331 chars`
on a different, text-layer PDF [relayed: memory, phase2-egress-payload]. So **at least two
extraction behaviors exist**, but corpus composition (what share of the real zh-Hant corpus
takes text mode) is **uncharacterized** — N=1 cannot establish it. Do **not** treat "mixed
corpus" as measured. The text-extract path itself is **not re-confirmed live on `3o9756n8z`**
(this probe only exercised the fallback).

### Firestore / R2 model
Still **blocked** — needs a GA4 open-volume number (no GA4 CLI/MCP available here). GA4
sufficiency for the full storage model is itself unproven; at minimum it's the missing volume input.

### Phase 4 gate — Run 1 verdict: **INCONCLUSIVE**
Verdict unchanged after all corrections were folded (codex/agy/grok analysis + Fable/codex-astra
gate all independently reached INCONCLUSIVE; their agreement raised priority, the reproduction
against code/logs is what confirms it). A real inconclusive, not a disguised "no":
- M1 — empty denominator (0 observed opens), not a measured 0% redirect share.
- M2 — 2 extraction lines on 1 probe; 0% text-mode is expected for a 0-text-item PDF; N≪10.
- M3 — the lever's hit path **works** (L1); ≥20-gen sustained rate untested; L2 unverified.
- M4 — probe not runnable; Hobby traffic-wide rate unobtainable by design.
- M5 / M6 — method/window gaps, not failed levers.
- Storage cliff — unmodeled (GA4 volume missing).
The one qualitative Phase 4 candidate **confirmed** — extraction-before-cache — is a code fix,
not a storage/request-count driver; carry it as its own item, not a gate trigger.

### What would resolve it
1. Real-traffic window (≤50-min appended `--json` pulls) — but with **overflow detection**: the
   100-line cap can drop records, so detect cap-hits and paginate/shorten intervals; dedupe by
   `id`. → M1, M2-threshold (≥10 on the zh-Hant corpus), M3-rate (≥20), a valid M5 denominator.
2. A GA4 30/90-day open count → the Firestore/R2 storage model + its cliff decision.
3. One generation on a **text-layer** PDF → confirms the text path live on this deploy (still
   below ≥10; and a text-layer PDF does not guarantee ≥120 extracted chars).
4. Rework the M2 residual counting rule (per-request pairing, include `failures`) before relying
   on it in the window run.

---
*Scope + Run 1 results. Scope cross-family reviewed (Fable + codex-astra, both FIX→folded);
Run 1 reviewed by codex-luna + agy + grok-4.6 (analysis) then Fable + codex-astra (pre-commit
gate, both FIX→folded). Gate verdict: INCONCLUSIVE — a real-traffic window + GA4 volume remain
to close M1/M2/M3-rate/M4 and the storage cliff.*
