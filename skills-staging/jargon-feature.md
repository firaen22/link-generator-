---
name: jargon-feature
description: Load when touching /api/explain-jargon, src/viewer/jargon.ts, jargonGlossary.ts, useJargon, JargonCard, PdfStage text/image extraction, or when jargon explanations are wrong, stale, or missing.
---

# Jargon explainer — pipeline & change rules (2026-07-13, PRs #15 #17 #18)

## Pipeline
PdfStage extracts page text via pdfjs `getTextContent()`; if < 40 chars
(scanned page, or iOS Safari where getTextContent throws), it rasterizes an
offscreen ≤1280px JPEG (quality 0.7→0.5) instead (PdfStage.tsx:58-117).
`useJargon` debounces 600ms, checks a per-key in-memory cache, POSTs
`/api/explain-jargon` `{text|imageBase64, fileId, page}` with stale-response
guards. Server: `jg:store:<ip>` 600/h pre-gate → L1 cache (24h TTL, 500 cap)
→ R2 sidecar `jargon/<sha256(fileId#page#path#contentHash)>.json` → spend
gates (`jg:ip` 40/h + `jg:global` 200/h, peek-then-commit) → in-flight dedup →
Gemini STANDARD_MODELS under a 45s route deadline → store (awaited) → serve.
`applyJargonGlossary` overrides wording at every return point (4 call sites:
:1250 cache, :1258 store, :1268 dedup follower, :1333 fresh).

## Invariants
1. **Stores hold RAW model output; the curated glossary overrides at serve
   time** (C13, all four call sites above). Applying overrides before storing
   freezes wording into R2 and glossary edits stop propagating to cached pages.
2. **contentHash stays in the R2 key** — it's the anti-poisoning property:
   an unauthenticated POST can only write the sidecar matching its own
   content. Removing it lets attackers seed explanations for other readers.
3. **Image path caps**: base64 ≤ 900_000 chars enforced on BOTH client
   (`JARGON_IMAGE_MAX_B64_LEN`, jargon.ts:9) and server (server.ts:1107), to
   fit the 1mb express.json cap; server also requires JPEG magic bytes
   (0xFF 0xD8 0xFF). Only `data:image/jpeg;base64,` is accepted client-side.
4. **Negative caching**: an empty `{terms:[]}` sentinel is written on genuine
   model success only; `readJargonStore` is three-way — null=miss/error,
   []=sentinel, terms. Collapsing null and [] re-spends budget on known-empty
   pages or permanently caches transient errors.
5. **Text minimum**: 40 trimmed chars (`JARGON_MIN_TEXT_LEN`) on both ends;
   text capped at 6000 chars; ≤4 terms, term ≤80 chars, explanation ≤200.
6. Known accepted quirks: peek/commit can burn one per-IP token when the
   global cap is saturated (accepted); jg caps are per-instance (accepted,
   Gemini daily quotas are the backstop); `jargon/*` R2 objects from the
   image path grow per-rendering-stack — the 90-day bucket lifecycle rule is
   what bounds them.

## Editing the curated glossary (src/viewer/jargonGlossary.ts)
41 zh-TW entries, HK terminology (存續期, not Taiwan's 存續期間). Rules:
every entry needs ≥1 alias and a non-empty explanation (the test gate
enforces this); first-alias-wins on collision; a blank explanation ''
deliberately falls through to model wording. Aliases are matched after
`normalizeTerm` (lowercase, collapse whitespace, strip CJK/ASCII brackets and
trailing punctuation).
Done when: `npx tsx src/viewer/jargonGlossary.test.ts` prints ALL TESTS
PASSED — and note the override reaches users immediately, no cache purge
needed (invariant 1).

## Card UX contract (PRs #15/#18)
Show/hide is a GLOBAL preference (localStorage `ag_jargon`, '0'=hidden) with
a 關鍵詞 reopen pill; card label is 關鍵詞解釋 (renamed 040251d); card body is
pointer-events-none so it never steals page taps; terms auto-rotate every 8s
unless dismissed/off-screen/single-term; respects the content guard via its
`visible` prop; mobile font sizes are mobile-first larger (`text-[11px]
sm:text-[10px]` pattern — #18 legibility fix). 503 from the endpoint is
silently ignored (AI not configured); other failures log once per key.

## Provenance note
Ported from the `marketview-index` project which used NIM+Redis — this repo
deliberately rebuilt it on house patterns (Gemini rotation + R2 + in-memory
limiter). Don't reintroduce NIM/Redis pieces from the old code.

Re-verify: `npx tsx src/viewer/jargon.test.ts && npx tsx src/viewer/jargonGlossary.test.ts` and `grep -n "applyJargonGlossary" server.ts` (5 hits: import + serve-time call sites).
