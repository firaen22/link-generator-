#!/usr/bin/env node
/**
 * Private Wealth Pack — link generator MCP server.
 *
 * A pure HTTP client of the deployed app (default https://share.pmd-hk.com).
 * It holds NO secrets: PDF upload reuses the server's /api/r2-presign flow
 * (R2 keys live only on Vercel) and link creation calls /api/create-link.
 *
 * Tools:
 *   - create_share_link   : upload a local PDF + mint one personalised link per client
 *   - get_whatsapp_link   : turn a share link into a wa.me click-to-chat URL
 *
 * Config (env): PWP_BASE_URL  — base URL of the deployed app.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BASE_URL = (process.env.PWP_BASE_URL || "https://share.pmd-hk.com").replace(/\/$/, "");

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
        pdfPath: {
          type: "string",
          description: "Absolute path to the local PDF file to upload.",
        },
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
        description: {
          type: "string",
          description: "Sub-text shown on the WhatsApp preview card.",
        },
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
        message: {
          type: "string",
          description: "Optional text to prepend before the link in the pre-filled message.",
        },
      },
      required: ["shortLink"],
    },
  },
];

async function postJson(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${path} failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
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

  // 1. Read local PDF.
  let bytes;
  try {
    bytes = await readFile(pdfPath);
  } catch (e) {
    throw new Error(`Cannot read PDF at "${pdfPath}": ${e.message}`);
  }
  const fileName = basename(pdfPath);

  // 2. Presigned upload URL (R2 keys stay on the server).
  const { uploadUrl, r2Key } = await postJson("/api/r2-presign", {
    fileName,
    contentType: "application/pdf",
  });
  if (!uploadUrl || !r2Key) throw new Error("Presign response missing uploadUrl/r2Key.");

  // 3. Upload bytes straight to R2.
  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/pdf" },
    body: bytes,
  });
  if (!putRes.ok) {
    throw new Error(`R2 upload failed (HTTP ${putRes.status}): ${(await putRes.text()).slice(0, 200)}`);
  }

  // 4. Create one short link per client (single source of truth on the server).
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
  return {
    summary: `Created ${links?.length || 0} link(s) from ${fileName}:\n${list}`,
    links: links || [],
  };
}

function getWhatsappLink(args) {
  const { shortLink, message } = args;
  if (!shortLink || typeof shortLink !== "string") throw new Error("shortLink is required.");
  const text = message ? `${message} ${shortLink}` : shortLink;
  const waUrl = `https://wa.me/?text=${encodeURIComponent(text)}`;
  return { summary: `WhatsApp click-to-chat URL:\n${waUrl}`, waUrl };
}

const server = new Server(
  { name: "pwp-links", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    let result;
    if (name === "create_share_link") result = await createShareLink(args);
    else if (name === "get_whatsapp_link") result = getWhatsappLink(args);
    else throw new Error(`Unknown tool: ${name}`);

    return {
      content: [{ type: "text", text: result.summary }],
      structuredContent: result,
    };
  } catch (e) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error: ${e.message}` }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[pwp-links] MCP server ready (base: ${BASE_URL})`);
