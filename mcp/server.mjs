#!/usr/bin/env node
/**
 * Private Wealth Pack — link generator MCP server.
 *
 * A pure HTTP client of the deployed app (default https://share.pmd-hk.com).
 * Holds NO secrets: PDF upload reuses the server's /api/r2-presign flow (R2
 * keys live only on Vercel) and link creation calls /api/create-link.
 *
 * Implements the MCP stdio transport (newline-delimited JSON-RPC 2.0) by hand.
 * One dependency, sharp, is used to compress preview images to <300KB before
 * upload (WhatsApp/Telegram silently drop larger OG images) — run `npm install`
 * in this folder before first use.
 *
 * Tools:
 *   - create_share_link : upload a local PDF + mint one personalised link per client
 *   - get_whatsapp_link : turn a share link into a wa.me click-to-chat URL
 *
 * Config (env): PWP_BASE_URL — base URL of the deployed app.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import sharp from "sharp";

const BASE_URL = (process.env.PWP_BASE_URL || "https://share.pmd-hk.com").replace(/\/$/, "");
const API_KEY = process.env.PWP_API_KEY || "";
const SERVER_INFO = { name: "pwp-links", version: "1.2.0" };
const DEFAULT_PROTOCOL = "2024-11-05";

const TOOLS = [
  {
    name: "create_share_link",
    description:
      "Upload a local PDF report and generate a personalised, trackable share link for each client. " +
      "Returns one https://<domain>/l/<id> link per client name. The link shows an Open Graph preview " +
      "card in WhatsApp. For the card image, prefer previewImagePath (a local image file) — it is " +
      "auto-compressed to <300KB, uploaded, and hosted for you. Alternatively pass previewImage as an " +
      "already-public HTTPS URL. If title or description is omitted, it is auto-generated from the " +
      "PDF's actual content; reportName defaults to the PDF filename if omitted.",
    inputSchema: {
      type: "object",
      properties: {
        pdfPath: { type: "string", description: "Absolute path to the local PDF file to upload." },
        clients: {
          type: "array",
          items: { type: "string" },
          description: "One or more client names. A unique personalised link is created per name.",
          minItems: 1,
        },
        reportName: {
          type: "string",
          description: "Internal report label (used in tracking notifications). Defaults to the PDF filename.",
        },
        title: {
          type: "string",
          description: "Headline on the WhatsApp preview card. Omit to auto-generate from the PDF content.",
        },
        description: {
          type: "string",
          description: "Sub-text on the WhatsApp preview card. Omit to auto-generate from the PDF content.",
        },
        previewImagePath: {
          type: "string",
          description:
            "Absolute path to a local image for the WhatsApp preview card. Auto-compressed to <300KB JPEG, " +
            "uploaded, and hosted. Takes precedence over previewImage. Use this instead of pre-hosting an image.",
        },
        previewImage: {
          type: "string",
          description:
            "Already-public HTTPS image URL for the WhatsApp preview card. Ignored if previewImagePath is set. " +
            "Must be <300KB or WhatsApp silently drops it. Omit both for no card / default image.",
        },
        advisorWhatsapp: {
          type: "string",
          description: "Advisor WhatsApp number for the in-report 預約顧問 CTA. Any format; digits are extracted.",
        },
      },
      required: ["pdfPath", "clients"],
    },
  },
  {
    name: "get_whatsapp_link",
    description:
      "Convert a share link into a WhatsApp click-to-chat (wa.me) URL that pre-fills a message. " +
      "Tapping it opens WhatsApp with the text ready to send — it does NOT auto-send.",
    inputSchema: {
      type: "object",
      properties: {
        shortLink: { type: "string", description: "The /l/<id> share link to send." },
        message: { type: "string", description: "Optional text to prepend before the link." },
      },
      required: ["shortLink"],
    },
  },
];

// ── Tool implementations ──────────────────────────────────────────────────────

async function postJson(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(API_KEY ? { "x-pwp-key": API_KEY } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (res.status === 401) {
    throw new Error(
      "Unauthorised (401): missing or invalid access key. Set PWP_API_KEY in the MCP server's env."
    );
  }
  if (!res.ok) throw new Error(`${path} failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path} returned non-JSON: ${text.slice(0, 300)}`);
  }
}

// Compress an image buffer to a WhatsApp/Telegram-friendly JPEG under ~290KB
// (headroom below the 300KB cap). Steps quality down, then dimensions, until it
// fits. Mirrors the web app's client-side canvas compression.
async function compressToJpegUnder(bytes, maxBytes = 290 * 1024) {
  const render = (width, quality) =>
    sharp(bytes)
      .rotate() // honour EXIF orientation
      .flatten({ background: "#ffffff" }) // JPEG has no alpha
      .resize({ width, height: width, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();

  let out = null;
  for (const q of [85, 75, 65, 55, 45, 35]) {
    out = await render(1200, q);
    if (out.length <= maxBytes) return out;
  }
  for (const w of [1000, 800, 600]) {
    out = await render(w, 45);
    if (out.length <= maxBytes) return out;
  }
  return out; // best effort — return the smallest we produced
}

// Read a local image, compress it, upload to R2, and return its hosted URL.
async function uploadPreviewImage(imagePath) {
  let bytes;
  try {
    bytes = await readFile(imagePath);
  } catch (e) {
    throw new Error(`Cannot read image at "${imagePath}": ${e.message}`);
  }

  const jpeg = await compressToJpegUnder(bytes);
  const fileName = `${basename(imagePath).replace(/\.[^/.]+$/, "") || "preview"}.jpg`;

  const { uploadUrl, publicPath } = await postJson("/api/r2-presign", {
    fileName,
    contentType: "image/jpeg",
  });
  if (!uploadUrl || !publicPath) throw new Error("Presign response missing uploadUrl/publicPath.");

  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "image/jpeg" },
    body: jpeg,
  });
  if (!putRes.ok) {
    throw new Error(`Image upload failed (HTTP ${putRes.status}): ${(await putRes.text()).slice(0, 200)}`);
  }
  return `${BASE_URL}${publicPath}`;
}

async function createShareLink(args) {
  const { pdfPath, clients, reportName, title, description, previewImage, previewImagePath, advisorWhatsapp } = args;
  if (!pdfPath || typeof pdfPath !== "string") throw new Error("pdfPath is required.");
  const names = Array.isArray(clients) ? clients.map((c) => String(c).trim()).filter(Boolean) : [];
  if (names.length === 0) throw new Error("At least one client name is required.");

  let bytes;
  try {
    bytes = await readFile(pdfPath);
  } catch (e) {
    throw new Error(`Cannot read PDF at "${pdfPath}": ${e.message}`);
  }
  const fileName = basename(pdfPath);

  const { uploadUrl, r2Key } = await postJson("/api/r2-presign", {
    fileName,
    contentType: "application/pdf",
  });
  if (!uploadUrl || !r2Key) throw new Error("Presign response missing uploadUrl/r2Key.");

  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/pdf" },
    body: bytes,
  });
  if (!putRes.ok) {
    throw new Error(`R2 upload failed (HTTP ${putRes.status}): ${(await putRes.text()).slice(0, 200)}`);
  }

  // previewImagePath (local file, auto-compressed + hosted) wins over a raw URL.
  const finalPreviewImage = previewImagePath
    ? await uploadPreviewImage(previewImagePath)
    : previewImage;

  // Auto-generate title/description from the PDF content when omitted (parity
  // with the web app). Non-fatal: on failure, fall back to defaults below.
  let finalTitle = title;
  let finalDescription = description;
  if (!finalTitle || !finalDescription) {
    try {
      const meta = await postJson("/api/generate-meta", { f: `r2:${r2Key}` });
      if (!finalTitle && meta.title) finalTitle = meta.title;
      if (!finalDescription && meta.description) finalDescription = meta.description;
    } catch (e) {
      console.error(`[create_share_link] auto title/description failed: ${e.message}`);
    }
  }

  const { links } = await postJson("/api/create-link", {
    clients: names,
    f: `r2:${r2Key}`,
    ...(reportName ? { r: reportName } : {}),
    ...(finalTitle ? { t: finalTitle } : {}),
    ...(finalDescription ? { d: finalDescription } : {}),
    ...(finalPreviewImage ? { i: finalPreviewImage } : {}),
    ...(advisorWhatsapp ? { w: advisorWhatsapp } : {}),
    origin: BASE_URL,
  });

  const list = (links || []).map((l) => `• ${l.name}: ${l.shortLink}`).join("\n");
  return { summary: `Created ${links?.length || 0} link(s) from ${fileName}:\n${list}`, links: links || [] };
}

function getWhatsappLink(args) {
  const { shortLink, message } = args;
  if (!shortLink || typeof shortLink !== "string") throw new Error("shortLink is required.");
  const text = message ? `${message} ${shortLink}` : shortLink;
  const waUrl = `https://wa.me/?text=${encodeURIComponent(text)}`;
  return { summary: `WhatsApp click-to-chat URL:\n${waUrl}`, waUrl };
}

// ── MCP stdio JSON-RPC plumbing ───────────────────────────────────────────────

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const replyError = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    reply(id, {
      protocolVersion: params?.protocolVersion || DEFAULT_PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
    return;
  }
  if (method === "notifications/initialized") return; // notification, no reply
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, { tools: TOOLS });

  if (method === "tools/call") {
    const { name, arguments: args = {} } = params || {};
    try {
      let result;
      if (name === "create_share_link") result = await createShareLink(args);
      else if (name === "get_whatsapp_link") result = getWhatsappLink(args);
      else throw new Error(`Unknown tool: ${name}`);
      reply(id, { content: [{ type: "text", text: result.summary }], structuredContent: result });
    } catch (e) {
      reply(id, { isError: true, content: [{ type: "text", text: `Error: ${e.message}` }] });
    }
    return;
  }

  if (id !== undefined) replyError(id, -32601, `Method not found: ${method}`);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg).catch((e) => console.error("[pwp-links] handler error:", e.message));
  }
});
process.stdin.on("end", () => process.exit(0));
console.error(`[pwp-links] MCP server ready (base: ${BASE_URL})`);
