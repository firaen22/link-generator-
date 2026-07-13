# Manifest — link-generator skill library (2026-07-13, commit d125074)

One line per file: what it is → the evidence backing it (what would falsify it).

- **START-HERE.md** — router by observed state → repo layout + all files below; falsified if any listed file is renamed.
- **build-and-env.md** — install/run/build/test commands + env pitfalls → every command executed this session (lint, build, both test gates passed; node v25.9.0); `.env.example` staleness verified by grep diff against `process.env.*` in source.
- **verification-and-qa.md** — what "green" covers, evidence ladder → `.github/workflows/deploy.yml` read (build-only); incident f668b13 (green CI, broken prod); test-gate runs reproduced.
- **serverless-deploy-contract.md** — ESM `.js` imports, await-before-respond, FUNCTION_INVOCATION_FAILED triage, in-memory state rules → incidents f668b13, 225fdde, 25f0812; AGENTS.md; server.ts:10-14/:1928-1966 read; import verified in api/[...path].ts.
- **debugging-playbook.md** — symptom→triage from 11 real incidents → commits 225fdde, f535c48, 4ce5358, ec6fddc, d4b6546, 02c9990, 89c57c5 (git archaeology pass); rate-limit keys/lines from server.ts deep read; falsified if handlers move materially.
- **failure-archaeology.md** — 10 dead ends/reverts/settled decisions with tripwires → revert 37333d6; PR #4 HMAC/KV decision record (project memory); user's 2026-07-07 GA4 decision; storage-churn commits 5d54c64/d440c9d; `git cherry` branch verification run this session.
- **architecture-contract.md** — 13 numbered invariants (C1-C13) → server.ts deep-read with file:line for each; each invariant traces to a fixing commit (4ce5358, f535c48, 02c9990, ec6fddc…); falsified by refactors that move the cited symbols.
- **security-model.md** — 7 gates encoding five hardening rounds → commits f535c48, 25f0812, 76e4b14, 4ce5358, 9440103, 02c9990; guard functions read at server.ts:28-95; `redirect:'manual'` count (3) verified by grep.
- **config-and-flags.md** — exact env inventory + formats + rotation runbooks → generated from `grep -oE "process\.env\.[A-Z0-9_]+"` this session; formats from server.ts:288-309; prod bucket name from 2026-07-12 memory (console-verified then, see UNCERTAINTY #1).
- **run-and-operate.md** — deploy path, external accounts, retention state, ops runbooks → deploy.yml + vercel.json read; R2/GCP facts from 2026-07-12 console session (UNCERTAINTY #1-2); `expireAt` code verified at server.ts:687-688.
- **ai-calls-gemini.md** — model tiers, key rotation, timeout-race pattern, cost map → server.ts:25/:1420-1486 read; incidents d4b6546 and 89c57c5; `apiCall.catch` count (4) verified by grep.
- **telemetry-pipeline.md** — capture→analyse→deliver flow + add-a-signal checklist → useTelemetry.ts deep read (frontend pass); PR #4/#10 decision records; tasks/plan.md architecture section; every checklist box traces to a named past bug.
- **jargon-feature.md** — pipeline, 6 invariants, glossary editing rules → PRs #15/#17/#18; jargon design memory (2026-07-12); both test gates run and passing; serve-time-override call sites grep-verified.
- **viewer-frontend.md** — pdfjs pin, render discipline, mobile/UX invariants → frontend deep read (Viewer.tsx, PdfStage, hooks, per-commit UX fixes #11/#12/#18); pin verified in package.json; stale App.tsx copy confirmed.
- **mcp-pwp-links.md** — MCP tools, flow, install.sh facts, change rules → mcp/server.mjs + install.sh full read (file:line pass); `node --check` run; v1.2.0 from mcp/package.json.
- **UNCERTAINTY.md** — 14 unsettled items, each with a safe default → by construction.

Review status: three fresh-context review passes run 2026-07-13 — factual (~75 claims checked, 3 discrepancies, all fixed), doctrine (1 IMPORTANT outward-action gate + 5 MINOR hedges, all applied), usability (10 scenarios; 4 blocking gaps fixed: dependency-bump routing, MCP release mechanism, vercel-build probe procedure, telemetry file/endpoint targeting). Residue in UNCERTAINTY.md §15-17.

Re-verify the library wholesale: `git -C "/Users/yauch/Documents/link generator/link-generator-" log --oneline -1` — if HEAD ≠ d125074, spot-check file:line references before trusting them.
