# Private Wealth Pack (PWP) Link Generator

This web application lets wealth advisors generate personalized, trackable PDF report links (`/l/<id>` and `/s/<id>`) for clients, captures client-reading telemetry (scroll depth, dwell time, zoom, device type, tab switches, return visits), analyzes engagement behavior via the Gemini API, and notifies advisors in real time through Telegram.

## Architecture

- **Frontend (`src/`)** — Vite React single-page app (Tailwind CSS). Key entrypoints: `src/App.tsx` (advisor dashboard / link creator) and `src/Viewer.tsx` (client-facing PDF viewer that captures telemetry).
- **Backend (`server.ts` + `api/`)** — an Express app exposed as a single Vercel serverless function through `api/[...path].ts`. In production there is no long-running Node process; Vercel routes `/api/*`, `/s/*`, and `/l/*` through that one function.
- **MCP server (`mcp/`)** — a Node Model Context Protocol server (`mcp/server.mjs`) for conversational link generation and WhatsApp short-link creation from Claude/Codex.
- **External services** — Gemini API (`@google/generative-ai`: behavior analytics + jargon explanation), Cloudflare R2 (`@aws-sdk/client-s3`: report file storage), Firebase Firestore & Storage (link metadata), Telegram Bot API (alerts), Dub.co API (short links).

## Local development

```bash
npm install
npm run dev      # tsx server.ts on port 3000 — Express + Vite dev middleware
npm run build    # build frontend assets
npm start        # run the built app locally (tsx server.ts)
```

## Environment variables

Server-side (`process.env`):
- `GEMINI_API_KEY` — accepts comma-separated multiple keys; requests rotate across them
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
- `PWP_API_KEYS` — comma-separated `name:key` client authorization allowlist
- `PWP_TELEGRAM_CHATS` — comma-separated `name:chatId` per-advisor routing
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`
- `VITE_FIREBASE_PROJECT_ID`/`FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`/`FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_API_KEY`/`FIREBASE_API_KEY`
- `VITE_APP_URL`/`APP_URL`, `DUB_API_KEY`, `PORT`, `NODE_ENV`, `VERCEL`

Client-side (`import.meta.env`): `VITE_APP_URL`, `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID`, `VITE_GA_ID` (optional).

## Deployment

Deploys run through the Vercel Git integration (the GitHub Actions workflow only builds and tests).

**CRITICAL RULE** — every relative import in serverless code (`server.ts` and anything it imports at runtime) **must** end with an explicit `.js` extension (e.g. `import app from '../server.js'`). Omitting the extension works locally with `tsx` but crashes every route on Vercel at module load (`ERR_MODULE_NOT_FOUND` → `FUNCTION_INVOCATION_FAILED`). See `skills-staging/serverless-deploy-contract.md`. This is mechanized: `npm run check:serverless` (also run in CI) greps for extensionless relative imports and type-checks the serverless surface with `tsconfig.server.json`.

## Testing

```bash
npm test                  # viewer jargon parser + glossary tests
npm run lint              # tsc --noEmit (frontend surface)
npm run check:serverless  # import-extension guard + serverless type-check
```
