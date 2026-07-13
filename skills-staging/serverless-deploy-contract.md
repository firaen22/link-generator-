---
name: serverless-deploy-contract
description: Load when editing server.ts or api/, adding/renaming a server-side file or import, adding a route, adding any async side effect to a request handler, or when prod returns FUNCTION_INVOCATION_FAILED while local dev works.
---

# Serverless deploy contract — Vercel + one Express app (2026-07-13)

## Topology (server.ts:277, :1945-1966; api/[...path].ts; vercel.json)
- One Express `app` in `server.ts`, exported default. Locally `tsx server.ts`
  runs it on :3000 with Vite middleware. On Vercel, `api/[...path].ts` does
  `import app from '../server.js'` and re-exports it — every `/api/*`, `/s*`,
  `/l/*` request (vercel.json routes) hits this single function.
- `process.env.VERCEL` gates the local listen/static block (server.ts:1948)
  and proxy-header trust (`TRUST_PROXY_HEADERS`, server.ts:265).
- Consequence: **standalone files under `api/` are dead code** — vercel.json
  sends all `/api/(.*)` to `api/[...path]` first. A duplicate `api/pdf.ts`
  once shipped a second, drifting copy of the SSRF allowlist and had to be
  patched twice, then deleted (commits f535c48 → 25f0812). Never add a second
  file under `api/`.

## Rule 1 — ESM `.js` extensions on relative server imports
Trigger: you are writing or changing an `import ... from './anything'` in
server.ts, sanitizeSessionEnd.ts, or any file the serverless function loads.
Steps: the specifier must end in `.js` (yes, `.js`, even though the source is
`.ts`) — e.g. `import { sanitizeSessionEnd } from "./sanitizeSessionEnd.js"`
(server.ts:14). Vercel compiles TS files individually and preserves
specifiers; extensionless imports crash the whole function at load with
`ERR_MODULE_NOT_FOUND`.
Done when: `grep -nE "from ['\"]\./[^'\"]+['\"]" server.ts api/*.ts` shows
every relative specifier ending in `.js`.

GOOD: `import { applyJargonGlossary } from "./src/viewer/jargonGlossary.js";`
BAD (the actual incident, PR #10 → f668b13): `import { sanitizeSessionEnd }
from "./sanitizeSessionEnd"` — "it runs fine locally, ship it." tsx resolves
it; Vercel doesn't; every `/api/*` route 500'd in prod.

## Rule 2 — await every async side effect before responding
Trigger: a handler sends Telegram, writes R2/Firestore, or starts any promise,
and you are about to `res.json(...)` / `res.send(...)`.
Steps: `await` the side effect first. Vercel freezes the function immediately
after the response; fire-and-forget work silently never executes.
Done when: no promise is created in the handler that isn't awaited (or
explicitly `.catch(()=>{})`-detached as a timeout-race guard, see
`ai-calls-gemini.md`) before the response call.

GOOD: `await sendTelegramTo(notif, chatIds); return res.redirect(viewerUrl);`
(pattern at server.ts:578-581).
BAD (actual incident 225fdde, repeated in 25f0812 for /api/track): "the
notification isn't critical, don't block the redirect on it" — result: reads
were never reported at all in prod, while local dev looked perfect.

## Rule 3 — FUNCTION_INVOCATION_FAILED triage (verbatim symptom)
Symptom: every (or one) `/api/*`/`/s/*`/`/l/*` request returns 500
`FUNCTION_INVOCATION_FAILED`.
Steps, in order:
1. It is a **module-load crash, not a logic bug** (AGENTS.md; incident
   f668b13). Suspect first: a new extensionless relative import (Rule 1), a
   new top-level await/throw, or a dependency missing from `dependencies`
   (devDependencies are not installed for the function).
2. Reproduce truthfully: run `vercel build`, then locate the built function
   with `find .vercel/output -name "*.js" | head`, then `node -e
   "import('<that path>')"` and watch it throw the real load error. If your
   first path guess errors with ENOENT, that means you have the wrong path —
   find the artifact; do NOT skip the probe. (`unverified`: this session did
   not run `vercel build`; procedure from AGENTS.md + the f668b13 fix. The
   find-then-import sequence is the reliable form.)
3. Probe a **MATCHED** route — i.e. one that actually exists, e.g.
   `curl -i https://share.pmd-hk.com/api/pdf/anything` (expect a 4xx JSON
   error, NOT FUNCTION_INVOCATION_FAILED). Probing only unmatched paths is
   misleading: unmatched `/api/*` returns a clean JSON 404/405 from the
   fallthrough (server.ts:1928-1942), which can mask a broken deploy.
Done when: you can name the exact import/line that fails at load, and the
matched-route probe returns 200 after the fix.

## Rule 4 — in-memory state is per-instance and mortal
Trigger: you are adding a cache, counter, dedup map, or "remember this" in
server.ts.
Facts: rate-limiter maps, jargon L1 cache, and in-flight dedup are all
in-memory and deliberately fail-open (see `architecture-contract.md`).
Cold starts wipe them; concurrent instances each have their own copy; caps
multiply by instance count. Any new in-memory state must be correct when it
vanishes or fans out. If it must survive, the only durable stores in this
stack are Firestore (`links` collection, REST) and R2 sidecar objects
(`jargon/` pattern) — do not add new infra without the user.
Done when: your addition documents (in a comment) what happens on cold start
and multi-instance, matching the style at server.ts:204-219.

Re-verify: `grep -n "from '../server.js'" "api/[...path].ts" && grep -c "await sendTelegram" server.ts` (import intact; sends awaited).
