# pwp-links MCP server

Generate Private Wealth Pack share links (and WhatsApp click-to-chat URLs)
conversationally from Claude Desktop or Codex.

It is a **pure HTTP client** of the deployed app (`https://share.pmd-hk.com`) and
holds **no secrets**: PDF upload reuses the server's `/api/r2-presign` flow (R2 keys
live only on Vercel) and link creation calls `/api/create-link`.

## Tools

| Tool | What it does |
|------|--------------|
| `create_share_link` | Uploads a local PDF and mints one personalised `/l/<id>` link per client name. Optional `title`, `description`, `previewImage` (WhatsApp OG card), `advisorWhatsapp` (in-report CTA). |
| `get_whatsapp_link` | Turns a share link into a `wa.me/?text=…` click-to-chat URL (opens WhatsApp with the message pre-filled; does not auto-send). |

> The OG preview card only appears in WhatsApp if `previewImage` is a **public HTTPS**
> image URL, ideally **< 300 KB** (WhatsApp silently drops larger images).

## Setup

```bash
cd mcp && npm install   # installs @modelcontextprotocol/sdk
```

### Claude Desktop
Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "pwp-links": {
      "command": "node",
      "args": ["/Users/yauch/Private Wealth Pack/link-generator-/mcp/server.mjs"]
    }
  }
}
```

### Codex
Edit `~/.codex/config.toml`:

```toml
[mcp_servers.pwp-links]
command = "node"
args = ["/Users/yauch/Private Wealth Pack/link-generator-/mcp/server.mjs"]
```

Restart the host after editing. To point at a different deployment, set
`PWP_BASE_URL` in the server's `env` block.

## Example prompts

- "Generate share links for Peter and Mary using ~/reports/may.pdf, title 五月市場展望,
  preview image https://…/cover.jpg, advisor WhatsApp 85291234567."
- "Make a WhatsApp send link for https://share.pmd-hk.com/l/abc123."
