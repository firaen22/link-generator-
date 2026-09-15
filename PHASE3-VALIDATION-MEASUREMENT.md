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
*Scope only — no results yet. Cross-family review gate (Fable [Anthropic] + codex-astra
[OpenAI]) applied to this scope; both returned FIX, all reproduced findings folded in above
before any measurement begins.*
