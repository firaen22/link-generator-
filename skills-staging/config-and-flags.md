---
name: config-and-flags
description: Load when you need an exact env var name or format, when behavior differs between environments, when a feature is mysteriously disabled (AI, Telegram, R2, auth), or before adding a new env var.
---

# Config & flags — authoritative env inventory (verified 2026-07-13 by grep of source)

Values live in Vercel project env (prod) and local `.env` (dev). `vercel env
pull` fetches them (needs login — user-must-provide). **`.env.example` is
stale** — do not trust it; this table is generated from source.

## Server (`server.ts`)
| Var | Format / default | Effect when unset |
|---|---|---|
| `GEMINI_API_KEY` | comma-separated list of keys (rotation) | `aiEnabled=false`: explain-jargon 503s, generate-meta 500s, session-end falls back to non-AI summary |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | bot token / owner master chat id | sends become console dry-run logs |
| `PWP_TELEGRAM_CHATS` | `name:chatId,name:chatId` advisor map (server.ts:301-309) | advisors get no direct copy; owner still notified |
| `PWP_API_KEYS` | `name:key,name:key` allowlist (server.ts:288-297) | **fail-closed**: all creation endpoints 401 |
| `R2_ACCOUNT_ID` `R2_ACCESS_KEY_ID` `R2_SECRET_ACCESS_KEY` | Cloudflare R2 credentials | uploads/presign/jargon-store fail |
| `R2_BUCKET_NAME` | **prod value is `marketupdate`** — code default `"reports"` is wrong for prod | reads/writes hit the wrong bucket |
| `VITE_FIREBASE_PROJECT_ID` (fallback `FIREBASE_PROJECT_ID`) | GCP project `market-update-56e1c` | short links `/l/<id>` cannot resolve |
| `VITE_FIREBASE_API_KEY` (fallback `FIREBASE_API_KEY`) | Firebase web API key | create-link Firestore writes fail (reads work unauthenticated) |
| `VITE_FIREBASE_STORAGE_BUCKET` (fallback `FIREBASE_STORAGE_BUCKET`) | default `market-update-56e1c.firebasestorage.app` (server.ts:799) | legacy `f_` PDF links break |
| `APP_URL` / `VITE_APP_URL` | canonical origin, e.g. `https://share.pmd-hk.com` | origin fallback logic uses request host |
| `DUB_API_KEY` | Dub.co key for `/api/shorten` (legacy path) | shorten 500s (endpoint is key-gated anyway) |
| `VERCEL` | set by platform | toggles serverless mode + proxy-header trust — never set manually |
| `PORT` | default 3000 | local only |
| `NODE_ENV` | `production` switches static-serving vs Vite middleware locally | dev mode |

## Client (Vite — `VITE_*` is PUBLIC, bundled into JS)
`VITE_APP_URL` (App.tsx link origin), `VITE_FIREBASE_*` six vars (only
consumed by vestigial `src/firebase.ts` client-side — but the PROJECT_ID /
STORAGE_BUCKET / API_KEY ones are ALSO read server-side, so keep them),
`VITE_GA_ID` documented in .env.example but GA4 id `G-DWWL0K4KWZ` is
hardcoded in index.html (the env var is not wired — verified by grep).

## MCP (`mcp/server.mjs`)
| Var | Default |
|---|---|
| `PWP_BASE_URL` | `https://share.pmd-hk.com` |
| `PWP_API_KEY` | none — without it, API calls go out unauthenticated and 401 |

## Trigger: adding a new env var
Steps: (1) read it exactly once near the top of the file or handler,
following the `||`-fallback style; (2) decide unset behavior explicitly —
this codebase's convention is fail-open for reader-facing features (dry-run
Telegram, disabled AI) and fail-closed for auth (`PWP_API_KEYS`); (3) add it
to the startup warning block if its absence should be loud; (4) add it to
Vercel env AND note that changes only apply on next deploy; (5) never
`VITE_`-prefix a secret (Gate 6, security-model.md).
Done when: `grep -oE "process\.env\.[A-Z0-9_]+" server.ts mcp/server.mjs |
sort -u` includes your var and its unset behavior is stated in the PR.

## Key rotation runbooks
(All of these edit prod env + require a redeploy — outward actions; get
explicit user go-ahead first, per run-and-operate.md.)
- **Advisor access key**: edit `PWP_API_KEYS` in Vercel env (append/remove
  `name:key` pair) → redeploy. Client side: advisor re-enters key in the App
  UI (stored in localStorage `pwp_api_key`); MCP users re-run install.sh or
  edit `~/.pwp-links` host config.
- **Advisor Telegram chat**: edit `PWP_TELEGRAM_CHATS` → redeploy (a redeploy
  purely to load new chats has precedent: d2093a2).
- **Gemini key**: comma-append to `GEMINI_API_KEY` (rotation picks it up).

Re-verify: `grep -oE "process\.env\.[A-Z0-9_]+" server.ts mcp/server.mjs | sort -u` and diff against this table.
