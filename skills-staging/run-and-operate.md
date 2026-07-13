---
name: run-and-operate
description: Load when operating the live system - a deploy is needed, retention/cleanup questions come up, links are expiring, external consoles (Cloudflare R2, GCP/Firestore, Telegram, GA4) are involved, or the user asks "why did X stop working in production".
---

# Run & operate — the live system (facts dated; verify before relying)

## Deploy
- Production deploys happen via **Vercel's GitHub integration** on push/merge
  to main — NOT via the GitHub Action (which only builds an artifact; its SSH
  deploy job is commented out). To ship: merge to main, watch the Vercel check.
- **Outward-action gate:** merging to main, editing prod env vars, and
  redeploying all change production. Confirm with the user before executing
  any of them; state exactly what the action triggers.
- Env var changes (keys, chats) take effect **only on the next deploy**. Edit
  them in the Vercel dashboard (project → Settings → Environment Variables)
  or `vercel env add/rm` — both are user-approval actions.
- `vercel build` locally reproduces the prod module graph (see
  serverless-deploy-contract.md Rule 3).

## External surfaces & accounts (as of 2026-07-12/13; volatile)
| Surface | Detail |
|---|---|
| Prod app | `https://share.pmd-hk.com` |
| Cloudflare R2 | bucket `marketupdate`, account `095afdbd2b0c1eedbdc442f9ac524d5b`, login llovegemini31@gmail.com. Prefixes: `reports/` (PDFs), `images/` (OG previews), `jargon/` (AI sidecar JSON). |
| GCP / Firebase | project `market-update-56e1c`, **Spark (free) plan, billing disabled**. Firestore collection `links`. |
| Telegram | owner chat via `TELEGRAM_CHAT_ID`; advisors via `PWP_TELEGRAM_CHATS` map |
| GA4 | `G-DWWL0K4KWZ`, loaded statically in index.html; ContentSquare also loaded there |

## Retention — current state (configured 2026-07-12)
- **R2: LIVE lifecycle rule `delete-after-90-days`** on ALL objects in
  `marketupdate`. Consequence: every PDF, preview image, and jargon sidecar
  dies at 90 days; share links then 404 even though their Firestore doc
  remains. This is the intended lifecycle, not an incident.
- **Firestore TTL: NOT enabled.** Code writes `expireAt = createdAt + 30d`
  (server.ts:687-688) ready for a TTL policy, but creating one returns
  `403: Project has billing disabled` on Spark. Docs accumulate forever
  (tiny, ~hundreds of bytes — accepted). Options if the user wants it:
  enable Blaze billing then add TTL policy (collection `links`, field
  `expireAt`, offset 0); or a Vercel-cron REST cleanup; or nothing.
- There is **no cleanup script in the repo** (a memory note references
  `tasks/check-retention.ts`; verified 2026-07-13 it does NOT exist —
  see UNCERTAINTY.md).

## Trigger: "a link from N months ago is dead"
Expected if N ≥ 3 (R2 lifecycle). Confirm by checking object existence in the
R2 console or a presigned GET via `/api/pdf/<file_id>` returning upstream 404.
Not a code bug; re-mint the link from the original PDF if needed.

## Trigger: advisor reports no Telegram notifications
Runbook order: (1) is the advisor in `PWP_TELEGRAM_CHATS` and was the app
redeployed after the change? (2) did the OWNER chat get the message (if yes,
routing map problem; if no, see debugging-playbook Telegram entry)? (3) has
the bot been blocked/removed from the chat? (external check).

## Trigger: Gemini quota exhausted / spend anomaly
Per-instance caps bound spend (ai:global 40/h, jg:global 200/h) but multiply
across serverless instances (documented, accepted). Absolute backstop = the
Gemini per-key daily quotas themselves. If abuse is suspected: check Telegram
for spam patterns, consider tightening caps in server.ts, and remember the
deliberate fail-open design (failure-archaeology §2) before proposing infra.

## Known open items (2026-07-13)
- GCP console flags the Gemini/Firebase API keys as **unrestricted** —
  standing hardening task, needs the user's console access.
- Firestore TTL blocked on billing (above).
- Manual prod end-to-end test of the Phase-1..4 telemetry additions was left
  unchecked in tasks/todo.md.

Re-verify volatile facts: R2 lifecycle + plan status require console access (user-must-provide); in-repo, `grep -n "expireAt" server.ts`.
