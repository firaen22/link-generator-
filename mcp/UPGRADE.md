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
2. Install / update `sharp` (the image-compression dependency) into `~/.pwp-links/node_modules/`
3. Leave your existing Codex / Claude config entries unchanged — no need to re-enter your access key

**Restart Claude or Codex** after the script finishes to load the new server.

---

## What's new in v1.2.0

### 1 — `previewImagePath`: local image auto-compress & upload

Previously you had to manually upload a cover image somewhere public, copy the URL, and paste it in. Now just point at a local file:

```
"Generate a share link for Peter using ~/reports/may.pdf,
 preview image ~/Desktop/cover.png, advisor WhatsApp 85291234567"
```

The MCP server will:
- Read the image from disk
- Compress it to **< 300 KB JPEG** (the threshold above which WhatsApp and Telegram silently drop OG preview cards)
- Upload and host it automatically via the shared R2 bucket
- Attach the hosted URL to the link's OG card

`previewImagePath` accepts any common image format (PNG, JPEG, WEBP, HEIC …). It takes precedence over `previewImage` if both are supplied. Compression steps through quality levels (85 → 35) then dimensions (1200 → 600 px) until the file is under 300 KB.

> **Dependency note:** this feature requires `sharp`, a native Node.js image library. The upgrade script installs it automatically. If you installed the MCP manually (without the script), run `npm install` inside `~/.pwp-links/` once.

---

### 2 — Auto-generated title & description

Previously `title` and `description` were required if you wanted a proper WhatsApp OG card. Now both fields are optional — omit them and the server reads the PDF content and generates them for you (Traditional Chinese, tuned to WhatsApp card length):

```
"Generate share links for Peter and Mary using ~/reports/warsh.pdf"
```

Example output:
- **Title:** 聯儲局結束前瞻指引，全球資產進入重新定價時代
- **Description:** 聯儲局轉向「數據依賴」模式，政策波動性顯著加劇。了解市場新常態與科技股面臨的重估壓力，幫助您提前部署資產配置。

You can still pass your own values to override:

```
"Generate a share link for Peter using ~/reports/warsh.pdf,
 title 五月市場展望, description 聯儲局政策分析"
```

Auto-generation is non-fatal: if the AI call fails the link is still created, just without a title/description.

---

## Updated parameter reference

| Parameter | Type | Notes |
|-----------|------|-------|
| `pdfPath` | string | **Required.** Absolute path to the local PDF. |
| `clients` | string[] | **Required.** One link per name. |
| `reportName` | string | Internal label for tracking. Defaults to the PDF filename. |
| `title` | string | OG card headline. **Now optional** — auto-generated if omitted. |
| `description` | string | OG card sub-text. **Now optional** — auto-generated if omitted. |
| `previewImagePath` | string | **New.** Local image file — auto-compressed to < 300 KB and hosted. |
| `previewImage` | string | Already-public HTTPS image URL. Ignored if `previewImagePath` is set. |
| `advisorWhatsapp` | string | Advisor number for the in-report 預約顧問 CTA. |
