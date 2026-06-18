# pwp-links MCP — Upgrade Guide

## One-line upgrade

Run the same installer you used the first time — it is safe to re-run on an existing install:

```bash
curl -fsSL https://raw.githubusercontent.com/firaen22/link-generator-/main/mcp/install.sh | PWP_API_KEY=your-key bash
```

Or omit `PWP_API_KEY=` to be prompted interactively:

```bash
curl -fsSL https://raw.githubusercontent.com/firaen22/link-generator-/main/mcp/install.sh | bash
```

The script will:
1. Download the latest `server.mjs` to `~/.pwp-links/`
2. Update `sharp` (the image-compression dependency) if needed
3. Skip re-registering your key — existing Codex / Claude config entries are left unchanged

**Restart Claude or Codex** after the script finishes to load the new server.

---

## What's new in v1.2.0

### `previewImagePath` — local image auto-compress & upload

Pass a local image file instead of a pre-hosted URL:

```
"Generate a share link for Peter using ~/reports/may.pdf,
 preview image ~/Desktop/cover.png"
```

The server compresses the image to **< 300 KB JPEG** (required for WhatsApp / Telegram OG cards) and hosts it automatically — no manual image upload needed.

### Auto-generated title & description

Omit `title` and `description` and they are generated from the PDF's actual content (Traditional Chinese, WhatsApp-card length):

```
"Generate share links for Peter and Mary using ~/reports/warsh.pdf,
 advisor WhatsApp 85291234567"
```

The server reads the PDF, calls the AI backend, and fills both fields before creating the link. You can still supply your own values to override.
