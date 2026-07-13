---
name: mcp-pwp-links
description: Load when editing mcp/server.mjs or mcp/install.sh, adding an MCP tool or parameter, shipping an MCP version bump, or when a user's installed MCP misbehaves (401s, sharp errors, missing registration).
---

# pwp-links MCP server (v1.2.0 as of 2026-07-13)

## What it is
A single-file stdio JSON-RPC server (`mcp/server.mjs`) — a pure HTTP client of
the deployed app. Holds NO storage secrets; auth is one header `x-pwp-key:
$PWP_API_KEY` sent only to app endpoints (never on raw presigned R2 PUTs).
Base URL `PWP_BASE_URL` defaults to `https://share.pmd-hk.com`. One dep:
sharp (image compression). Tools: `create_share_link` (pdfPath + clients
required; reportName/title/description/previewImagePath/previewImage/
advisorWhatsapp optional) and `get_whatsapp_link`.

## create_share_link flow (server.mjs:260-332)
validate (clients ≤100, non-string names filtered) → elicit missing optional
fields → read PDF → POST /api/r2-presign → PUT bytes (120s timeout) →
optional preview image: sharp compress to ≤290KB (quality 85→35 at width
1200, then width 1000→800→600 at q45; EXIF-rotate + white-flatten) → presign
+ PUT (60s) → optional POST /api/generate-meta for missing title/description
(NON-FATAL: failures are swallowed to stderr, link still mints) → POST
/api/create-link with short keys `{clients, f:"r2:<key>", r,t,d,i,w, origin}`.

## Elicitation contract (added 062d38e)
Only runs if the client advertised the elicitation capability during
initialize; sends `elicitation/create` with `required: []` (every field
skippable); `cancel` aborts link creation, `decline`/empty keeps defaults;
elicitation errors fall back to defaults rather than blocking (10min timeout).
Protocol version advertised: 2025-06-18. When adding a tool param, decide
explicitly: elicit it (add to ELICIT_FIELDS) or default it — and keep
`required: []` so nothing becomes a hard prompt.

## Change rules
1. **Timeouts on every outbound fetch** (30s JSON / 120s PDF PUT / 60s image
   PUT) — MCP stdio has no transport timeout; an unbounded fetch hangs the
   host forever (hardening round 9440103). New calls copy the pattern.
2. **Errors return `{isError:true}` content, never throw** out of tools/call;
   HTTP error bodies truncated to ~200-300 chars.
3. **node_modules must sit beside server.mjs** — sharp is imported relative
   to the install dir (`~/.pwp-links/`). Moving server.mjs alone breaks it.
4. Node ≥18 required at runtime (`fetch`, `AbortSignal.timeout`); the
   installer checks presence only, not version — an old node fails at runtime.
5. Version bumps: update `mcp/package.json` version AND document in
   `mcp/UPGRADE.md` (the existing v1.2.0 section is the template).
   **Release mechanism:** there is no registry or build step — install.sh
   downloads `server.mjs` straight from
   `https://raw.githubusercontent.com/firaen22/link-generator-/main/mcp/`
   (the `REPO_RAW` var in install.sh), so **merging to main IS the release**
   (an outward action — user go-ahead required). Users pick it up by
   re-running install.sh (idempotent, preserves existing host config/keys)
   and restarting their host.

## install.sh facts (verified against the script)
Downloads server.mjs to `~/.pwp-links/`, writes a minimal package.json
pinning sharp ^0.33.5, `npm install --omit=dev`; registers with Codex by
RAW TEXT APPEND to `~/.codex/config.toml` (idempotence = one grep for the
section header — malformed sections aren't repaired) and with Claude via
`claude mcp remove` + `claude mcp add --scope user`. Key comes from
$PWP_API_KEY or interactive /dev/tty prompt. Known fragilities: Codex.app may
rewrite config.toml on launch (re-run installer if the block vanishes,
documented in README); the API key is stored plaintext in config.toml; a
remove-succeeds/add-fails sequence leaves Claude unregistered (script only
warns).

## Debugging a user's install
- 401 from tools → PWP_API_KEY missing/revoked; check the host env block,
  then `PWP_API_KEYS` server-side (config-and-flags.md).
- `Cannot find module 'sharp'` → run `npm install` inside `~/.pwp-links/`.
- Tool present but Codex doesn't see it → config.toml block was rewritten by
  Codex.app; re-run installer, restart Codex.
- Testing without a host: pipe JSON-RPC lines to `node mcp/server.mjs` (it
  reads stdin line-by-line and tolerates partial buffers); minimum handshake
  is `initialize` → `tools/list`. `unverified`: no scripted harness exists.

Re-verify: `node --check mcp/server.mjs && grep -n "PWP_BASE_URL" mcp/server.mjs | head -2`
