---
name: ai-calls-gemini
description: Load when touching any Gemini call site, the THINKING_MODELS/STANDARD_MODELS lists, timeouts around AI calls, structured-output schemas, or when AI output is silently missing in production.
---

# Gemini call contract (2026-07-13, commit d125074)

## The two tiers (server.ts:1420-1433) — placement is a correctness decision
- `THINKING_MODELS` = ["gemini-3.6-flash", "gemini-2.5-flash"] —
  support `thinkingConfig` + native `responseSchema`. Used ONLY by
  /api/session-end (first pass, server.ts:1778).
- `STANDARD_MODELS` = ["gemini-3.5-flash-lite", "gemini-2.5-flash-lite",
  "gemini-2.0-flash", "gemma-3-27b-it", "gemini-1.5-flash-latest"] — no
  thinkingConfig; schema goes into the prompt text and output is
  fence-stripped + JSON.parsed. Used by generate-meta, explain-jargon, and
  session-end fallback.
- Gemma models additionally reject `responseMimeType` — call sites special-case
  them (server.ts:1069-1071, :1289-1291).

Trigger: adding/moving a model. Steps: (1) confirm via the Gemini API docs
(ai.google.dev) whether it accepts `thinkingConfig` AND `responseSchema` —
that decides the tier; (2) order within STANDARD_MODELS is by quota
(highest requests-per-day first — the list is the fallback order; RPD/RPM =
requests per day/minute); (3) note the RPD/RPM in the adjacent comment as the
existing entries do. Done when: a real request succeeds through each endpoint
that uses the changed list — STANDARD_MODELS: /api/generate-meta,
/api/explain-jargon, and the /api/session-end fallback; THINKING_MODELS:
/api/session-end first pass — (or falls through with a logged model error,
not silence).
BAD (real incident 89c57c5): "gemini-3.1-flash-lite is the newest, put it in
THINKING" — it doesn't support thinkingConfig, so it errored invisibly on
every call and the highest-quota model was never used.

## Key rotation
`GEMINI_API_KEY` is comma-split into `apiKeys[]` (server.ts:25). Call sites
iterate keys × models: generate-meta/jargon start at a time-based index,
session-end at a random index. `aiEnabled = apiKeys.length > 0` gates every
AI feature.

## The timeout-race pattern — copy it exactly
Every Gemini call is raced against a timeout. The in-flight promise MUST get
a no-op catch BEFORE the race, or a post-timeout rejection crashes the
serverless instance (real crash, d4b6546):

```ts
const apiCall = model.generateContent(...);
apiCall.catch(() => {}); // late rejection must never be unhandled
const result = await Promise.race([apiCall, timeoutRejecting(ms)]);
```
Four existing sites: server.ts:1073-1078, :1299-1304 (with explanatory
comment), :1790-1795, :1825-1830. Timeouts: generate-meta 20s; jargon
min(20s, remaining-of-45s route deadline); session-end 25s thinking / 15s
standard.
Done when: any new call site has the detached catch, a bounded timeout, and
(if in a loop) respects a route-level deadline.

## Structured output
session-end uses `RESPONSE_SCHEMA` (server.ts:1436-1486) with enum-constrained
fields and `additionalProperties:false` — enums keep Telegram rendering
deterministic. Extend the schema additively (old fields unchanged) and mirror
any new field in BOTH the thinking path (native schema) and the standard path
(schema-in-prompt + parse). The standard path's parser strips code fences with
a regex before JSON.parse — model output is NOT trusted to be clean JSON.

## Budget gates come BEFORE the call
No Gemini call without passing its rlCost chain (C4). explain-jargon
additionally dedups concurrent identical requests via an in-flight map keyed
by cacheKey (followers await the leader — keep this when refactoring).

## Cost surface map (what spends money)
| Endpoint | Models | Bound by |
|---|---|---|
| /api/session-end | THINKING then STANDARD | ai:s 1/min, ai:ip 30/h, ai:global 40/h |
| /api/explain-jargon | STANDARD | jg:ip 40/h, jg:global 200/h, caches first |
| /api/generate-meta | STANDARD | x-pwp-key auth (trusted callers only) |

Re-verify: `sed -n '1420,1435p' server.ts` (lists unchanged?) and `grep -c "apiCall.catch" server.ts` (expect 4).
