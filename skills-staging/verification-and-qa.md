---
name: verification-and-qa
description: Load before claiming any change is done, working, or safe to merge; when a PR check is green and you are tempted to treat that as proof; or when deciding what evidence a change needs.
---

# Verification & QA — what "green" actually covers (2026-07-13)

## The core fact: CI does NOT verify the server
`.github/workflows/deploy.yml` runs only `npm ci && npm run build` — the
**frontend Vite build**. It does not type-check, does not run the server, does
not run the test gates. The real deploy is Vercel's own GitHub integration (a
separate "Vercel" check on the PR). A green Action proves only that the React
bundle compiles.

BAD (rationalization actually observed in this repo's history): "CI is green,
the server change is fine." PR #10 was green and every `/api/*` route in prod
then returned FUNCTION_INVOCATION_FAILED, because CI never loads server code
(incident f668b13, see `failure-archaeology.md`).

GOOD: "CI is green (frontend compiles). Separately: `npm run lint` passes
locally (server types), both jargon gates pass, and I probed the changed route
against a `vercel build` artifact."

## Minimum evidence ladder — run the rungs your change touches

| Change touches | Required evidence before "done" |
|---|---|
| Any TS file | `npm run lint` exits 0 |
| Frontend (`src/`, index.html, vite config) | `npm run build` exits 0; for UX changes, load the page and exercise the flow |
| `src/viewer/jargon*.ts` | `npx tsx src/viewer/jargon.test.ts` (prints one `PASS <label>` line per case, no summary line, exit 0) and `npx tsx src/viewer/jargonGlossary.test.ts` (prints `ALL TESTS PASSED`, exit 0) |
| `server.ts` / `api/` / `sanitizeSessionEnd.ts` / any import graph change | All of the above PLUS the prod-module probe in `serverless-deploy-contract.md` (`vercel build` + node-import the artifact + curl a **matched** route) |
| Telemetry / Telegram / Gemini paths | A real request through the endpoint (curl with a realistic body) and observe the side effect or its dry-run log — `sendTelegram` logs `[DRY-RUN]`-style console output when TELEGRAM_BOT_TOKEN is unset, so you can verify routing/formatting without secrets |
| `mcp/server.mjs` | Drive it over stdio (it's JSON-RPC on stdin/stdout) or at minimum `node --check mcp/server.mjs` + review; there is no MCP test harness (unverified gap) |

## Trigger: you're about to write "tests pass" in a report
Steps: (1) write down the expected output first (e.g. "gate 1: 36 PASS lines,
no FAIL, exit 0; gate 2: ALL TESTS PASSED, exit 0"); (2) run the command;
(3) compare. Quote the actual
tail of output in your report. If you didn't run it, say "not run" — this
repo's history includes multiple rounds of review catching claims that
weren't reproduced.
Done when: the report distinguishes verified-by-me / relayed / assumed.

## Trigger: change involves a judgment-bearing function (sanitizer, validator, glossary, rate-limit predicate)
This repo's convention is a zero-dep executable gate colocated with the code
(`jargon.test.ts` pattern: expected-before-actual `assertEq`, exit 1 on fail).
Extend the existing gate rather than adding a framework. `sanitizeSessionEnd.ts`
currently has NO gate (unverified by tests — treat edits to it as high-risk and
test manually with malformed payloads: NaN, huge arrays, HTML in string fields).
Done when: the new/changed behavior has a failing-then-passing case in a gate,
or the report explicitly states the gap.

## Manual end-to-end (production) checklist
The tasks/todo.md final checkpoint left "Manual end-to-end test in production"
unchecked — that is the standing standard for telemetry features:
1. Mint a link (App UI or MCP), open it on a phone, read a few pages.
2. Confirm Telegram: open notification, 60s milestone, session-end analysis.
3. Confirm GA4 events arrive (report_session_end with session_id).
This requires prod secrets and a real device — user-must-provide; never fake it.

Re-verify: `cat .github/workflows/deploy.yml | grep -A2 "run:"` (still only npm ci + npm run build as of 2026-07-13).
