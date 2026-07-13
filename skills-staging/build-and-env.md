---
name: build-and-env
description: Load when setting up a fresh checkout of this repo, when npm/tsc/vite commands fail, when you need to know how to run the app locally, when an env var appears undefined at runtime, or when asked to bump/add npm dependencies.
---

# Build & environment (verified 2026-07-13, node v25.9.0, commit d125074)

## Commands — all verified by running them

| Task | Command | Notes |
|---|---|---|
| Install | `npm ci` (CI) / `npm install` (local) | Node 18+ required (README); v25.9.0 works |
| Dev server | `npm run dev` = `tsx server.ts` | One process on :3000 serves API **and** Vite middleware (HMR). There is no separate `vite dev`. |
| Type-check | `npm run lint` = `tsc --noEmit` | This is the ONLY whole-project type gate. Covers server.ts too. |
| Frontend build | `npm run build` = `vite build` → `dist/` | Passes with a chunk-size warning (normal, pdfjs is big). |
| Prod server (VPS mode) | `npm start` = `node server.ts` | Serves `dist/` statically. Not used on Vercel. |
| Test gate 1 | `npx tsx src/viewer/jargon.test.ts` | 36-case zero-dep gate; per-case `PASS` lines, exits 1 on failure |
| Test gate 2 | `npx tsx src/viewer/jargonGlossary.test.ts` | Validates the real production glossary |

There is **no `npm test` script**. If you add tests, follow the existing
zero-dependency `assertEq` + `process.exit(1)` pattern in
`src/viewer/jargon.test.ts` and run them with `npx tsx <file>`.

## Trigger: `tsc --noEmit` fails on a file you didn't touch
Steps: check whether the failing file is a scratch/experiment file at repo
root (this happened before — dead `test_upload.js`/`test_list.ts` importing a
removed `@vercel/blob` dep were the only tsc errors until commit 25f0812
deleted them). Delete or fix the stray file; do not exclude it in tsconfig.
Done when: `npm run lint` exits 0.

## Trigger: no `.env` yet — can I run locally?
Yes, in degraded mode: `npm run dev` boots without secrets and prints a
startup status block (server.ts:321-330) showing ✅/❌ per subsystem. Without
secrets: Telegram sends become console dry-run logs, AI endpoints 503/skip,
R2 upload/presign fails, creation endpoints 401 (fail-closed). For full local
function copy `.env.example` to `.env` and fill the gaps listed below, or
pull real values with `vercel env pull` (needs Vercel login —
user-must-provide).

## Trigger: an env var reads as undefined
`.env.example` is **stale**. Verified 2026-07-13: it is missing
`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`,
`PWP_API_KEYS`, `PWP_TELEGRAM_CHATS`. The authoritative inventory is
`config-and-flags.md`; the ground truth is
`grep -oE "process\.env\.[A-Z0-9_]+" server.ts | sort -u`.
For real values, pull from Vercel: `vercel env pull` (vercel CLI is installed
at /opt/homebrew/bin/vercel; requires the linked project + login —
user-must-provide).
Done when: the var appears in your `.env` AND the startup warning block
(server.ts:320-330 area logs missing R2/PWP config at boot) no longer fires.

## Trigger: dev works but you need to reproduce the PROD module graph
`tsx` resolves extensionless ESM imports; Vercel does not. Local dev passing
proves nothing about module loading in prod. Run `vercel build` and import the
built function artifact with `node` — see `serverless-deploy-contract.md` for
the full procedure and why (real incident f668b13).

## Trigger: asked to bump/add dependencies (§deps)
Steps:
1. `pdfjs-dist` (exact-pinned 5.4.296) and `react-pdf` move ONLY together —
   read `viewer-frontend.md` first; a mismatch throws "API version does not
   match Worker version" at runtime, not build time.
2. Anything server.ts imports must be in `dependencies`, not
   `devDependencies` — Vercel doesn't install dev deps for the function.
3. There is no dependency-update policy/automation in this repo (no
   renovate/dependabot config — verified 2026-07-13). Blanket "bump
   everything" is NOT house style; bump what the task needs (surgical-change
   doctrine).
4. After any bump, run the full ladder: `npm run lint`, `npm run build`, both
   test gates, and — if the bump touches server-side modules — the
   `vercel build` probe (serverless-deploy-contract.md Rule 3). For pdf/viewer
   deps, also load a real PDF in the browser.
Done when: the ladder passes AND the lockfile diff contains only the intended
packages.

## Layout facts a newcomer needs
- `server.ts` at repo root is the whole backend (~2000 lines, one Express app).
- `api/[...path].ts` is the only Vercel function; it just re-exports the app.
- `src/` is the React 19 + Vite 6 + Tailwind 4 frontend; `src/viewer/` is the
  PDF reader (components/hooks/utils split).
- `mcp/` is a self-contained npm package (own package.json, dep: sharp).
  `mcp/node_modules` is committed-adjacent on this machine but installed by
  `mcp/install.sh` on user machines — don't import from the main app into it.
- `dist/` is build output; `tasks/` holds historical plan/todo docs (read-only
  context, both phases complete).
- Vite alias `@` → repo root (vite.config.ts + tsconfig paths).
- `pdfjs-dist` is exact-pinned to `5.4.296` (no caret) — load-bearing; see
  `viewer-frontend.md` before bumping.

Re-verify: `cd "/Users/yauch/Documents/link generator/link-generator-" && npm run lint && npx tsx src/viewer/jargon.test.ts && npx tsx src/viewer/jargonGlossary.test.ts`
