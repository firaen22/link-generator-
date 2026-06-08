#!/usr/bin/env node
/**
 * Private Wealth Pack — link generator MCP server (zero-dependency).
 *
 * A pure HTTP client of the deployed app (default https://share.pmd-hk.com).
 * Holds NO secrets: PDF upload reuses the server's /api/r2-presign flow (R2
 * keys live only on Vercel) and link creation calls /api/create-link.
 *
 * Implements the MCP stdio transport (newline-delimited JSON-RPC 2.0) by hand
 * so it runs with just Node — no npm install, no node_modules.
 *
 * Tools:
 *   - create_share_link : upload a local PDF + mint one personalised link per client
 *   - get_whatsapp_link : turn a share link into a wa.me click-to-chat URL
 *
 * Config (env): PWP_BASE_URL — base URL of the deployed app.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const BASE_URL = (process.env.PWP_BASE_URL || "https://share.pmd-hk.com").replace(/\/$/, "");
const API_KEY = process.env.PWP_API_KEY || "";
const SERVER_INFO = { name: "pwp-links", version: "1.1.0" };
const DEFAULT_PROTOCOL = "2024-11-05";

const TOOLS = [
  {
    name: "create_share_link",
    description:
      "Upload a local PDF report and generate a personalised, trackable share link for each client. " +
      "Returns one https://<domain>/l/<id> link per client name. The link shows an Open Graph preview " +
      "card in WhatsApp when previewImage is supplied (must be a public HTTPS image URL, ideally <300KB " +
      "or WhatsApp silently drops it). reportName/title default to the PDF filename if omitted.",
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
          description: "Headline shown on the WhatsApp preview card. Defaults to the report name.",
        },
        description: { type: "string", description: "Sub-text shown on the WhatsApp preview card." },
        previewImage: {
          type: "string",
          description: "Public HTTPS image URL for the WhatsApp preview card. Omit for no card / default image.",
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

async function createShareLink(args) {
  const { pdfPath, clients, reportName, title, description, previewImage, advisorWhatsapp } = args;
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

  const { links } = await postJson("/api/create-link", {
    clients: names,
    f: `r2:${r2Key}`,
    ...(reportName ? { r: reportName } : {}),
    ...(title ? { t: title } : {}),
    ...(description ? { d: description } : {}),
    ...(previewImage ? { i: previewImage } : {}),
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
