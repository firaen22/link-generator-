# pwp-links MCP server

Generate Private Wealth Pack share links (and WhatsApp click-to-chat URLs)
conversationally from Claude or Codex.

It is a **zero-dependency, pure HTTP client** of the deployed app
(`https://share.pmd-hk.com`). It holds no R2/Firebase secrets — PDF upload reuses
the server's `/api/r2-presign` flow and link creation calls `/api/create-link`.

Access is gated by a **per-user access key** (`PWP_API_KEY`), validated against the
server's allowlist. Without a valid key the endpoints return `401`.

## Tools

| Tool | What it does |
|------|--------------|
| `create_share_link` | Uploads a local PDF and mints one personalised `/l/<id>` link per client name. Optional `title`, `description`, `previewImage` (WhatsApp OG card), `advisorWhatsapp` (in-report CTA). |
| `get_whatsapp_link` | Turns a share link into a `wa.me/?text=…` click-to-chat URL (opens WhatsApp with the message pre-filled; does not auto-send). |

> The OG preview card only appears in WhatsApp if `previewImage` is a **public HTTPS**
> image URL, ideally **< 300 KB** (WhatsApp silently drops larger images).

## Install (one line — Claude and/or Codex)

```bash
curl -fsSL https://raw.githubusercontent.com/firaen22/link-generator-/main/mcp/install.sh | bash
```

It downloads the server to `~/.pwp-links/server.mjs`, prompts for your access key,
and auto-registers with whichever hosts are present: the Codex config
(`~/.codex/config.toml`) and/or Claude (`claude mcp add`, user scope). To pass the
key non-interactively:

```bash
PWP_API_KEY=your-key bash -c "$(curl -fsSL https://raw.githubusercontent.com/firaen22/link-generator-/main/mcp/install.sh)"
```

Restart Codex afterwards. (If Codex.app is open it may rewrite `config.toml` on
launch — re-run the installer if the block disappears.)

## Manual config

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.pwp-links]
command = "node"
args = ["/ABSOLUTE/PATH/TO/server.mjs"]

[mcp_servers.pwp-links.env]
PWP_API_KEY = "your-key"
```

**Claude** (`claude mcp add`):

```bash
claude mcp add pwp-links --scope user -e PWP_API_KEY=your-key -- node /ABSOLUTE/PATH/TO/server.mjs
```

Set `PWP_BASE_URL` in the env block to point at a different deployment.

## Admin: managing keys

Keys live only in the Vercel env var `PWP_API_KEYS` (comma-separated `name:key`
pairs), e.g. `owner:abc,advisor1:def`. Add a teammate by appending a pair; revoke
by removing theirs. Changes take effect on the next deploy.

## Example prompts

- "Generate share links for Peter and Mary using ~/reports/may.pdf, title 五月市場展望,
  preview image https://…/cover.jpg, advisor WhatsApp 85291234567."
- "Make a WhatsApp send link for https://share.pmd-hk.com/l/abc123."
