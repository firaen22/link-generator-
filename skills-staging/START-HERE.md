---
name: start-here
description: Load first in any session on this repo (link-generator / Private Wealth Pack, share.pmd-hk.com) — before editing server.ts, src/, mcp/, or debugging a production 500. Routes you to the right skill by observed state.
---

# START HERE — link-generator skill library router

Written 2026-07-13 against commit d125074. Sources win on conflict: the repo
itself > these files. If a file:line here doesn't match the repo, re-verify
before acting and treat the skill line as stale.

**What this project is:** a full-stack TypeScript app for a Hong Kong insurance
advisor. Advisors upload a market-report PDF, mint personalised share links
(`/l/<id>`), send them to clients over WhatsApp; clients read the PDF in a
tracked in-browser viewer; reading behaviour is analysed by Gemini and pushed
to the advisor's Telegram. One Express app (`server.ts`, ~2000 lines) serves
everything, deployed on Vercel serverless. A companion MCP server (`mcp/`)
lets advisors mint links from Claude/Codex conversationally.

## Route by observed state

| You observe | Load |
|---|---|
| Fresh checkout, need to install/run/build/type-check | `build-and-env.md` |
| About to claim "done / it works / tests pass" | `verification-and-qa.md` |
| Editing server.ts, adding a route, or touching anything that ships to Vercel | `serverless-deploy-contract.md` then `architecture-contract.md` |
| Production route returns 500 / FUNCTION_INVOCATION_FAILED / Telegram silent / rate-limit weirdness | `debugging-playbook.md` |
| Tempted to add auth, a database, HMAC, a dashboard, or "clean up" a pattern that looks wrong | `failure-archaeology.md` FIRST — it was probably tried |
| Touching routes that fetch URLs, send Telegram, take user input, or handle R2 keys | `security-model.md` |
| Need an env var name, key format, or "why is X not configured" | `config-and-flags.md` |
| Operating the live system: retention, keys, Telegram chats, GA4, Cloudflare/GCP consoles | `run-and-operate.md` |
| Touching Gemini calls, model lists, timeouts, or structured output | `ai-calls-gemini.md` |
| Touching /api/track, /api/session-end, useTelemetry, or the analysis prompt | `telemetry-pipeline.md` |
| Touching /api/explain-jargon, JargonCard, jargon.ts, or the glossary | `jargon-feature.md` |
| Touching mcp/server.mjs, install.sh, or shipping an MCP version | `mcp-pwp-links.md` |
| Editing the viewer UI (PdfStage, hooks, dark mode, zoom, mobile) | `viewer-frontend.md` |
| Bumping/adding npm dependencies or editing package.json | `build-and-env.md` §deps + `viewer-frontend.md` (pdfjs pin) |

`MANIFEST.md` lists every skill with the evidence behind it. `UNCERTAINTY.md`
lists everything unsettled — check it before trusting a volatile claim.

## Non-negotiables (full rules in the linked files)

1. Relative imports in server-side TS need explicit `.js` extensions —
   `serverless-deploy-contract.md`.
2. `await` every Telegram/R2/async side effect before `res.json` —
   `serverless-deploy-contract.md`.
3. CI green ≠ server correct. CI only builds the frontend —
   `verification-and-qa.md`.
4. `/api/track`, `/api/session-end`, `/api/explain-jargon` stay
   unauthenticated with the fail-open limiter. Do not "fix" this —
   `failure-archaeology.md` §HMAC/KV.
5. The repo has no `npm test`; the two test gates run via
   `npx tsx src/viewer/jargon.test.ts` and `npx tsx src/viewer/jargonGlossary.test.ts`.

Re-verify: `git -C "/Users/yauch/Documents/link generator/link-generator-" log --oneline -1` (this library was written at d125074).
