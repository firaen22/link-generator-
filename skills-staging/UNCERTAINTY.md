# Uncertainty register (2026-07-13)

Everything unsettled or unverifiable from inside this repo. Each item ends
with a safe default.

## Environment / infra (cannot verify without user consoles or secrets)
1. **R2 lifecycle rule + bucket name `marketupdate`** — from a project memory
   note dated 2026-07-12 (set via the user's Cloudflare console). Not
   verifiable in-repo. Safe default: treat 90-day object deletion as live;
   confirm in the Cloudflare console before promising longer retention.
2. **GCP Spark plan / Firestore TTL 403** — same memory source, 2026-07-12.
   Safe default: assume TTL is absent; don't write code that depends on
   `links` docs disappearing.
3. **Actual Vercel env values** (PWP_API_KEYS members, R2_BUCKET_NAME=…) —
   user-must-provide via `vercel env pull`. Safe default: never hardcode.
4. **`vercel build` artifact probe procedure** (serverless-deploy-contract
   Rule 3, step 2) — the procedure comes from AGENTS.md and the f668b13 fix
   description; the exact built-file path was NOT re-run in this session.
   Safe default: run `vercel build` and `find .vercel/output -name "*.js"`
   to locate the artifact before quoting a path.

## Stale references discovered during authoring
5. **`tasks/check-retention.ts` does not exist** although the project memory
   file `retention-cleanup-r2-firestore.md` links to it. Either it was never
   committed or was removed. Safe default: don't cite it; if a retention
   diagnostic is needed, write a fresh read-only script.
6. **`.env.example` is stale** (missing R2_*, PWP_API_KEYS,
   PWP_TELEGRAM_CHATS; contains unwired VITE_GA_ID). Repo is read-only this
   session, so not fixed. Safe default: trust config-and-flags.md / grep, not
   the example file.
7. **App.tsx:495 "via Firebase Storage" copy is stale** (uploads go to R2).
   Known, low-stakes. Safe default: fix only as part of user-approved work.

## Gaps with no ground truth yet
8. **No test gate for `sanitizeSessionEnd.ts`** — highest-risk untested file
   (single choke point for hostile input). Safe default: manual malformed-
   payload probes before merging any edit; ideal next step is a jargon-style
   zero-dep gate.
9. **No MCP test harness** — mcp/server.mjs verified only by `node --check`
   and manual host use. Safe default: hand-drive initialize/tools-list over
   stdio after edits.
10. **pdfjs-dist pin rationale is git-archaeological** (commits 847b6ce,
    f895e58 per code exploration), not documented in-code. The compatible
    version pairing with react-pdf 10.4.1 was not independently re-verified
    against upstream docs. Safe default: bump react-pdf and pdfjs-dist only
    together, verify by loading a PDF.
11. **Gemini model capability claims** (which models accept thinkingConfig)
    reflect the code comments and incident 89c57c5, not a fresh API check.
    Model availability/quotas drift. Safe default: verify against current
    Gemini docs before editing the lists.
12. **Line numbers throughout the library** are accurate for commit d125074
    and will drift. Safe default: treat file:line as a locator hint; re-grep
    the named symbol.

## Review-pass residue (2026-07-13, three fresh-context reviews)
15. Factual review checked ~75 claims, found 3 discrepancies — all fixed
    (test-gate output strings, 36 vs 37 cases, three→four glossary call
    sites). All 26 cited commit hashes verified to exist.
16. Minor usability findings deliberately NOT fixed (judged noise or
    inherently external): no `git clone` step (assumed baseline); Cloudflare
    R2 console access requires the user's login (llovegemini31@gmail.com per
    memory) — any console-dependent runbook step is user-must-provide;
    the Telegram debug list is intentionally ordered 1→5 by likelihood.
17. Doctrine reviewer's verdict: ship-worthy after the outward-action gate
    fix (applied to run-and-operate.md + config-and-flags.md +
    mcp-pwp-links.md release note).

## Judgment calls made without user confirmation
13. Skill granularity (14 files) errs toward more, smaller triggers rather
    than fewer mega-files; if the consumer model under-loads them, merge
    telemetry-pipeline + ai-calls-gemini first.
14. The four merged-but-undeleted remote branches are labeled "safe to
    delete" based on `git cherry` patch-equivalence — deletion itself is an
    outward action left to the user.
