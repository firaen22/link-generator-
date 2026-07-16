import 'dotenv/config';
import express from "express";
import { createHash } from "node:crypto";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenerativeAI } from "@google/generative-ai";
import LZString from 'lz-string';
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
// The .js extension is required: Vercel's Node runtime compiles each TS file
// separately and keeps import specifiers as-is, so an extensionless relative
// import crashes the whole function at load (ERR_MODULE_NOT_FOUND) even though
// tsx resolves it fine in local dev.
import { sanitizeSessionEnd } from "./sanitizeSessionEnd.js";
import {
  JARGON_IMAGE_MAX_B64_LEN,
  JARGON_MAX_TEXT_LEN,
  JARGON_MIN_TEXT_LEN,
  type JargonTerm,
} from "./src/viewer/jargon.js";
import { applyJargonGlossary } from "./src/viewer/jargonGlossary.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const apiKeys = (process.env.GEMINI_API_KEY || "").split(',').map(k => k.trim()).filter(Boolean);
const aiEnabled = apiKeys.length > 0;
const rotatedKeys = (startIndex: number): string[] => apiKeys.map((_, i) => apiKeys[(startIndex + i) % apiKeys.length]);
const timeRotatedKeys = (): string[] => rotatedKeys(apiKeys.length ? Math.floor(Date.now() / 60_000) % apiKeys.length : 0);

const escapeHTML = (text: unknown) =>
  String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Attribute-safe escaping for values interpolated into HTML attributes / elements
// in the OG preview pages. Also escapes quotes so attacker input can't break out
// of a content="..." attribute (reflected XSS).
const escapeHTMLAttr = (text: unknown): string =>
  String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// Allowlist of hosts the PDF proxy may fetch a user-supplied (vblob_) URL from.
// Prevents SSRF: without this, an attacker could encode an internal URL
// (e.g. http://169.254.169.254/...) and have the server fetch + stream it back.
const ALLOWED_PDF_HOSTS = [
  'firebasestorage.googleapis.com',
  'storage.googleapis.com',
  '.r2.cloudflarestorage.com',
  '.r2.dev',
  '.blob.vercel-storage.com',
];
const isAllowedUpstreamUrl = (raw: string): boolean => {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return ALLOWED_PDF_HOSTS.some((s) => (s.startsWith('.') ? host.endsWith(s) : host === s));
  } catch {
    return false;
  }
};

// Blocks obvious SSRF targets for endpoints that must fetch arbitrary *public*
// image URLs (where the strict PDF allowlist above is too narrow). Rejects
// non-http(s), localhost, link-local metadata (169.254.x / cloud metadata), and
// RFC1918 private ranges given as IP literals. Not a substitute for a network
// egress policy, but stops the cheap internal-scan attempts.
const isPublicHttpUrl = (raw: string): boolean => {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === '0.0.0.0' || host.endsWith('.local')) return false;
  if (host === '::1' || host === '[::1]') return false;
  // Reject ALL IPv6 literals (ULA fc00::/7, link-local fe80::/10, loopback,
  // IPv4-mapped, unspecified). Legit public images use hostnames, not IPv6
  // literals, so this is safe hardening. DNS names that resolve to private
  // IPv6 remain a residual handled by network egress policy, not here.
  const stripped = host.replace(/^\[/, '').replace(/\]$/, '');
  if (stripped.includes(':')) return false;
  // IPv4 literal private / link-local / loopback ranges.
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false; // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
  }
  return true;
};

const fromUrlSafeBase64 = (encoded: string): string => {
  let base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  return Buffer.from(base64, 'base64').toString('utf8');
};

const toUrlSafeBase64 = (str: string): string =>
  Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const extractFileName = (filePath: string | null | undefined): string => {
  if (!filePath) return "Document";
  // Strip prefixes like "r2:" or "r2_"
  let pathStr = filePath.replace(/^(r2|f|vblob)[:_]/, "");
  // Get the last path segment (filename)
  let baseName = pathStr.substring(pathStr.lastIndexOf('/') + 1);
  // Strip timestamp prefix if any (e.g. kp38d7c2_Janice_Report.pdf or 1716584284000_Janice_Report.pdf)
  baseName = baseName.replace(/^[a-z0-9]{8,13}_/, "");
  // Strip extension
  baseName = baseName.replace(/\.[^/.]+$/, "");
  return baseName || "Document";
};

const decodeLzPayload = (q: string): Record<string, any> | null => {
  try {
    const raw = LZString.decompressFromEncodedURIComponent(q);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const resolveOgImage = (imageParam: string): string => {
  const fallback = 'https://images.unsplash.com/photo-1554224155-8d04cb21cd6c?q=80&w=1200&auto=format&fit=crop&.jpg';
  if (!imageParam?.startsWith('http')) return fallback;
  
  let resolved = imageParam;
  if (imageParam.includes('meee.com.tw') && !imageParam.includes('i.meee.com.tw')) {
    resolved = imageParam.replace('meee.com.tw', 'i.meee.com.tw');
  }

  // Ensure strict crawlers (like WhatsApp) see a standard image extension
  if (!/\.(png|jpe?g|gif|webp|svg)/i.test(resolved)) {
    resolved = resolved.includes('?') ? resolved + '&.jpg' : resolved + '.jpg';
  }
  return resolved;
};

const sendTelegram = async (text: string, chatId?: string): Promise<void> => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const targetChat = chatId || process.env.TELEGRAM_CHAT_ID;
  if (!token || !targetChat) {
    // Local/dev without credentials: surface the would-be message so the
    // notification content is verifiable without a live bot.
    console.log(`[TELEGRAM DRY-RUN]\n${text}`);
    return;
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: targetChat, text, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) {
      const detail = await r.json().catch(() => ({}));
      console.error(`[TELEGRAM ERROR] ${r.status}`, detail);
      if ((detail as any).description?.includes("can't parse entities")) {
        const plain = text
          .replace(/<[^>]*>/g, '')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&');
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: targetChat, text: plain }),
          signal: AbortSignal.timeout(5000),
        });
      }
    }
  } catch (err) {
    console.error('Telegram notification failed:', err);
  }
};

// Send the same message to several chats, de-duplicated (skips empty targets).
const sendTelegramTo = async (text: string, chatIds: Array<string | undefined>): Promise<void> => {
  const targets = [...new Set(chatIds.filter((c): c is string => !!c))];
  await Promise.all(targets.map((c) => sendTelegram(text, c)));
};

const getHkTimeOfDay = (): { name: 'morning' | 'afternoon' | 'evening' | 'late night'; label: string } => {
  const h = parseInt(
    new Date().toLocaleString('en-US', { timeZone: 'Asia/Hong_Kong', hour: '2-digit', hour12: false }).slice(0, 2),
    10
  );
  const hour = h === 24 ? 0 : h;
  if (hour >= 5 && hour < 12) return { name: 'morning', label: '☀️ Morning' };
  if (hour >= 12 && hour < 18) return { name: 'afternoon', label: '🌤 Afternoon' };
  if (hour >= 18 && hour < 23) return { name: 'evening', label: '🌆 Evening' };
  return { name: 'late night', label: '🌙 Late Night' };
};

// Best-effort, per-process sliding-window rate limiter for the two UNauthenticated
// telemetry endpoints (/api/track, /api/session-end). They can't use requireApiKey
// (the public reader calls them), so this caps abuse: forged session_end requests
// would otherwise loop the paid Gemini API + spam Telegram.
//
// Deliberately in-memory and fail-OPEN: on Vercel each serverless instance keeps
// its own window, and a cold start / map reset only ever ALLOWS more through — so a
// real reader's telemetry is never wrongly dropped. It stops drive-by abuse and
// blunts single-source floods; a distributed multi-IP flood is out of scope for
// app-level code (would need a WAF or a durable global counter).
const RL_MAX_WINDOW_MS = 3_600_000; // longest window any caller uses (per-IP / global AI caps)
// Cost counters (ai:global, ai:ip:<ip>, jg:global, jg:ip:<ip>) live in a SEPARATE map that is never bulk-
// cleared. They're bounded by the number of real client IPs (x-real-ip, set by the
// platform), so a single attacker can't grow them — and they must NOT be wipeable, or
// an attacker could spray unique session ids into the map below to force a clear and
// reset the Gemini spend caps for telemetry or jargon explanation.
const rlCost = new Map<string, number[]>();
// Sprayable counters (tg:<ip>, ai:s:<session_id> — session id is request-supplied).
const rlHits = new Map<string, number[]>();
// commit=false peeks whether a call would be allowed without consuming budget — used
// where multiple caps must ALL pass before any of them is charged (e.g. jargon's
// per-IP + global caps must not burn a user's per-IP budget on a request that the
// global cap will reject anyway).
const allow = (key: string, max: number, windowMs: number, commit = true): boolean => {
  const now = Date.now();
  const isCostKey = key === "ai:global" || key.startsWith("ai:ip:") || key === "jg:global" || key.startsWith("jg:ip:");
  const store = isCostKey ? rlCost : rlHits;

  // Bound memory under a key-spraying flood. Prune only entries whose newest hit is
  // already older than the longest window (genuinely expired). If a fresh-key flood
  // still overruns the sprayable store, clear THAT store only (fail-open) — the cost
  // store is never cleared, so spraying can't reset the AI spend caps.
  if (store.size > 5000) {
    const stale = now - RL_MAX_WINDOW_MS;
    for (const [k, ts] of store) {
      if (ts.length === 0 || ts[ts.length - 1] <= stale) store.delete(k);
    }
    if (!isCostKey && store.size > 5000) store.clear();
  }

  const cutoff = now - windowMs;
  const hits = (store.get(key) || []).filter((t) => t > cutoff);
  if (hits.length >= max) {
    if (commit) store.set(key, hits);
    return false;
  }
  if (!commit) return true;
  hits.push(now);
  store.set(key, hits);
  return true;
};

// Best-effort client IP. Prefer Vercel's x-real-ip (set by the platform to the true
// client IP) over the leftmost x-forwarded-for hop, which is client-supplied and
// trivially spoofable. Still best-effort — the per-session and global AI caps below
// do NOT rely on the IP, so an attacker who spoofs it can't bypass those.
// Only trust proxy-set forwarding headers when actually running behind a trusted
// proxy (Vercel sets x-real-ip to the true client IP). On a standalone `node`
// deployment these headers are attacker-supplied and spoofable, so an attacker
// could rotate x-real-ip to dodge the per-IP AI cap — fall back to the real
// socket address there. (The global AI cap bounds spend regardless.)
const TRUST_PROXY_HEADERS = !!process.env.VERCEL;
const clientIp = (req: express.Request): string => {
  if (TRUST_PROXY_HEADERS) {
    const realIp = req.headers["x-real-ip"];
    if (realIp) return Array.isArray(realIp) ? realIp[0] : realIp;
    const xff = req.headers["x-forwarded-for"];
    const raw = Array.isArray(xff) ? xff[0] : xff;
    if (raw) return raw.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
};

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

// Parse JSON, capped at 1mb. A long deep-read session_end (scroll_samples every
// 500ms) is ~250KB, so 1mb fits any real session while rejecting abusive payloads.
app.use(express.json({ limit: "1mb" }));

// ── Access control for link-creation endpoints ────────────────────────────────
// PWP_API_KEYS = comma-separated "name:key" pairs (name optional). Requests to the
// creation endpoints must send a matching key in the "x-pwp-key" header.
// Fail-closed: if no keys are configured, all creation requests are rejected.
const allowedKeys = new Map<string, string>(); // key -> owner name (for attribution)
(process.env.PWP_API_KEYS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .forEach((pair) => {
    const idx = pair.indexOf(":");
    if (idx > 0) allowedKeys.set(pair.slice(idx + 1).trim(), pair.slice(0, idx).trim());
    else allowedKeys.set(pair, pair);
  });

// Advisor name -> Telegram chat id, for routing read-notifications to the
// advisor who created the link. PWP_TELEGRAM_CHATS = "name:chatId,name:chatId".
const advisorChats = new Map<string, string>();
(process.env.PWP_TELEGRAM_CHATS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .forEach((pair) => {
    const idx = pair.indexOf(":");
    if (idx > 0) advisorChats.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  });

// Returns the owner name on success, or null after sending a 401 response.
function requireApiKey(req: express.Request, res: express.Response): string | null {
  const raw = req.headers["x-pwp-key"];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (key && allowedKeys.has(key)) return allowedKeys.get(key) as string;
  res.status(401).json({ error: "未授權：缺少或無效的存取金鑰 (x-pwp-key)" });
  return null;
}

// Startup status check
console.log('--- Server Status ---');
console.log(`Telegram Bot: ${process.env.TELEGRAM_BOT_TOKEN ? '✅ LOADED' : '❌ MISSING'}`);
console.log(`Telegram Chat ID: ${process.env.TELEGRAM_CHAT_ID ? '✅ LOADED' : '❌ MISSING'}`);
console.log(`Firebase Project ID: ${process.env.VITE_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID || '❌ MISSING'}`);
console.log(`Firebase Bucket: ${process.env.VITE_FIREBASE_STORAGE_BUCKET || process.env.FIREBASE_STORAGE_BUCKET || '❌ MISSING'}`);
console.log(`Cloudflare R2: ${process.env.R2_ACCOUNT_ID ? '✅ LOADED' : '❌ MISSING'}`);
console.log(`Access keys (PWP_API_KEYS): ${allowedKeys.size > 0 ? `✅ ${allowedKeys.size} configured` : '❌ NONE — creation endpoints will reject all requests'}`);
console.log(`Advisor TG chats (PWP_TELEGRAM_CHATS): ${advisorChats.size > 0 ? `✅ ${advisorChats.size} mapped` : '— none (owner-only notifications)'}`);
console.log('------------------------------');

// Cloudflare R2 Client
const s3Client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
  },
});

// API Route for the Link Preview (Supports both old and new shorter path)
app.get(["/api/share/:file_id", "/s/:file_id", "/s"], async (req, res) => {
  const { file_id } = req.params;
  const { q, client_name, name, report_name, preview_image, c, r, i, d, desc, t, title: tParam } = req.query;
  const userAgent = req.headers['user-agent'] || '';
  const isCrawler = /WhatsApp|Telegram|facebookexternalhit|Twitterbot|Slackbot|Discordbot|Line|WeChat/i.test(userAgent);

  // Handle shorthand or full names
  let cName = (c || name || client_name || "貴客") as string;
  let rName = (r || report_name || "Document") as string;
  let imageParam = (i || preview_image) as string;
  let descParam = (d || desc) as string;
  let titleParam = (t || tParam) as string;
  let finalFileId = file_id || "";

  if (q && typeof q === 'string') {
    const decoded = decodeLzPayload(q);
    if (decoded) {
      console.log(`[SHARE] Decompressed payload: ${JSON.stringify(decoded).slice(0, 50)}...`);
      if (decoded.c) cName = decoded.c;
      if (decoded.r) rName = decoded.r;
      if (decoded.i) imageParam = decoded.i;
      if (decoded.d) descParam = decoded.d;
      if (decoded.t) titleParam = decoded.t;
      if (decoded.f) {
        const isFirebasePath = decoded.f.startsWith('reports/');
        const base64 = Buffer.from(decoded.f, 'utf8').toString('base64')
          .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        finalFileId = isFirebasePath ? `f_${base64}` : `vblob_${base64}`;
        console.log(`[SHARE] Resolved file_id: ${finalFileId} from path: ${decoded.f}`);
        
        if (rName === "Document" && decoded.f) {
          const extracted = extractFileName(decoded.f);
          if (extracted && extracted !== "Document") {
            rName = extracted;
          }
        }
      }
    } else {
      console.error('[SHARE] Failed to decode compressed payload');
    }
  }

  // Fallback from file_id if rName is still Document
  if (rName === "Document" && finalFileId) {
    try {
      let decodedPath = "";
      if (finalFileId.startsWith('f_')) {
        decodedPath = fromUrlSafeBase64(finalFileId.slice(2));
      } else if (finalFileId.startsWith('vblob_')) {
        decodedPath = fromUrlSafeBase64(finalFileId.slice(6));
      } else if (finalFileId.startsWith('r2_')) {
        decodedPath = fromUrlSafeBase64(finalFileId.slice(3));
      }
      if (decodedPath) {
        const extracted = extractFileName(decodedPath);
        if (extracted && extracted !== "Document") {
          rName = extracted;
        }
      }
    } catch (e) {
      // ignore
    }
  }

  const ogImage = resolveOgImage(imageParam);

  // Branding
  const title = titleParam
    ? (titleParam.includes('：') || titleParam.includes(':') ? titleParam : `${titleParam}：${cName}`)
    : `專案報告：${cName}`;
  const description = descParam || "為您整理的最新市場動態，包含 AI 股分析及日圓走勢預測。";

  // Target URL: Points to our internal Viewer
  // Use relative paths to avoid dependency on APP_URL environment variable
  const viewerUrl = q
    ? `/view?q=${encodeURIComponent(q as string)}`
    : `/view/${finalFileId}?c=${encodeURIComponent(cName)}&r=${encodeURIComponent(rName)}`;

  console.log(`[SHARE] Redirecting to: ${viewerUrl}`);

  // Escape everything that lands in the HTML/attributes below (reflected XSS guard)
  const safeTitle = escapeHTMLAttr(title);
  const safeDescription = escapeHTMLAttr(description);
  const safeOgImage = escapeHTMLAttr(ogImage);
  const safeOgUrl = escapeHTMLAttr(`${req.protocol}://${req.get('host')}${req.originalUrl}`);
  // JS-string-safe form for the redirect <script> below. finalFileId is a raw
  // path param, so a plain "${viewerUrl}" would allow JS-string / </script>
  // breakout. JSON.stringify quotes+escapes; the <-replace blocks </script>.
  const safeViewerJs = JSON.stringify(viewerUrl).replace(/</g, '\\u003c');

  if (!isCrawler) {
    // cName/rName/file_id are attacker-controllable (raw query params / route
    // param) and sent with parse_mode:'HTML' — escape them like /api/session-end.
    // Rate-limited per client IP like /api/track: this route is unauthenticated,
    // so an un-gated send lets a GET loop spam the advisor's Telegram.
    if (allow(`tg:${clientIp(req)}`, 12, 60_000)) {
      await sendTelegram(
        `🔔 <b>閱讀通知</b>\n\n` +
        `👤 <b>客戶：</b> ${escapeHTML(String(cName))}\n` +
        `📄 <b>報告：</b> ${escapeHTML(String(rName))} (${escapeHTML(String(file_id ?? ''))})\n` +
        `⏰ <b>時間：</b> 剛剛`
      );
    } else {
      console.warn(`[SHARE] Telegram rate-limited for ${clientIp(req)}`);
    }
  }

  const html = `
  <!DOCTYPE html>
  <html lang="zh-HK">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${safeTitle}</title>
      <meta property="og:title" content="${safeTitle}" />
      <meta property="og:description" content="${safeDescription}" />
      <meta property="og:image" content="${safeOgImage}" />
      <meta property="og:image:alt" content="${safeTitle}" />
      <meta property="og:type" content="website" />
      <meta property="og:site_name" content="Antigravity 財富管理" />
      <meta property="og:url" content="${safeOgUrl}" />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:image" content="${safeOgImage}" />
      
      <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #ffffff; color: #1e293b; }
          .loader { border: 4px solid #f3f3f3; border-top: 4px solid #3498db; border-radius: 50%; width: 30px; height: 30px; animation: spin 1s linear infinite; margin-bottom: 20px; }
          @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
          .container { text-align: center; }
      </style>
      
      ${!isCrawler ? `
      <script>
          // Use window.location.origin to ensure absolute path redirect
          const targetUrl = window.location.origin + ${safeViewerJs};
          console.log('[SHARE] Client-side redirecting to:', targetUrl);
          setTimeout(function() {
              window.location.replace(targetUrl);
          }, 500);
      </script>
      ` : ''}
  </head>
  <body>
      <div class="container">
          <div class="loader"></div>
          <p>正在為您開啟專屬市場報告...</p>
      </div>
  </body>
  </html>
  `;

  res.send(html);
});

// 新增：自家 Firestore 短連結解析路由
app.get(["/l/:shortId", "/api/l/:shortId"], async (req, res) => {
  const { shortId } = req.params;
  const projectId = process.env.VITE_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID;
  const userAgent = req.headers['user-agent'] || '';
  const isCrawler = /WhatsApp|Telegram|facebookexternalhit|Twitterbot|Slackbot|Discordbot|Line|WeChat/i.test(userAgent);

  if (!projectId) {
    console.error("Missing Project ID in env");
    return res.status(500).send("伺服器缺少 Firebase Project ID 設定");
  }

  // shortId is interpolated into the Firestore REST path; restrict it to the
  // charset our generator produces (base36) so an encoded '/' or '..' can't
  // reshape the upstream request path.
  if (!/^[a-z0-9]{1,32}$/i.test(shortId)) {
    return res.status(404).send(`找不到此連結 (${escapeHTMLAttr(shortId)})`);
  }

  try {
    const docUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/links/${shortId}`;
    console.log(`[SHORT_LINK] Resolving ID: ${shortId} via ${docUrl}`);

    const response = await fetch(docUrl);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[SHORT_LINK] Firestore error (${response.status}) for ID: ${shortId}: ${errorText}`);
      return res.status(404).send(`找不到此連結 (${escapeHTMLAttr(shortId)}) 或連結已失效 (Status: ${response.status})`);
    }

    const data = await response.json();
    const q = data.fields?.q?.stringValue;

    if (!q) {
      console.error(`[SHORT_LINK] Fields 'q' not found in ID: ${shortId}`, data);
      return res.status(404).send("連結內容損毀 (Data Empty)");
    }

    let cName = "貴客";
    let rName = "Document";
    let imageParam = "";
    let descParam = "";
    let titleParam = "";

    const decoded = decodeLzPayload(q);
    if (decoded) {
      if (decoded.c) cName = decoded.c;
      if (decoded.r) rName = decoded.r;
      if (decoded.i) imageParam = decoded.i;
      if (decoded.d) descParam = decoded.d;
      if (decoded.t) titleParam = decoded.t;
      
      if (rName === "Document" && decoded.f) {
        const extracted = extractFileName(decoded.f);
        if (extracted && extracted !== "Document") {
          rName = extracted;
        }
      }
    } else {
      console.error("解碼失敗:", shortId);
    }

    const ogImage = resolveOgImage(imageParam);

    const title = titleParam
      ? (titleParam.includes('：') || titleParam.includes(':') ? titleParam : `${titleParam}：${cName}`)
      : `專案報告：${cName}`;
    const description = descParam || "為您整理的最新市場動態，包含 AI 股分析及日圓走勢預測。";

    // Use relative path for reliability and origin consistency
    const viewerUrl = `/view?q=${encodeURIComponent(q)}`;

    console.log(`[SHORT_LINK] Resolved: ${shortId} -> Redirecting to: ${viewerUrl}`);

    // Escape everything that lands in the HTML/attributes below (reflected XSS guard)
    const safeTitle = escapeHTMLAttr(title);
    const safeDescription = escapeHTMLAttr(description);
    const safeOgImage = escapeHTMLAttr(ogImage);
    const safeOgUrl = escapeHTMLAttr(`${req.protocol}://${req.get('host')}${req.originalUrl}`);
    // JS-string-safe form for the redirect <script> below (defense in depth —
    // viewerUrl here is already encodeURIComponent'd, but keep both routes uniform).
    const safeViewerJs = JSON.stringify(viewerUrl).replace(/</g, '\\u003c');

    if (!isCrawler) {
      const advisor = data.fields?.adv?.stringValue || "";
      const advisorLine = advisor ? `\n👨‍💼 <b>顧問：</b> ${escapeHTML(advisor)}` : "";
      const notif = `🔔 <b>閱讀通知 (短連結)</b>\n\n👤 <b>客戶：</b> ${escapeHTML(cName)}\n📄 <b>報告：</b> ${escapeHTML(rName)}${advisorLine}\n🔗 <b>ID：</b> ${shortId}\n⏰ <b>時間：</b> 剛剛`;
      // Route to the advisor who created it (if mapped) AND the owner master log.
      // Awaited: on serverless the function is frozen after the response, so a
      // fire-and-forget fetch would be killed before Telegram receives it.
      // Rate-limited per client IP like /api/track — the route is unauthenticated.
      if (allow(`tg:${clientIp(req)}`, 12, 60_000)) {
        await sendTelegramTo(notif, [advisor ? advisorChats.get(advisor) : undefined, process.env.TELEGRAM_CHAT_ID]);
      } else {
        console.warn(`[SHORT_LINK] Telegram rate-limited for ${clientIp(req)}`);
      }
    }

    const html = `<!DOCTYPE html>
    <html lang="zh-HK" prefix="og: http://ogp.me/ns#">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${safeTitle}</title>
        <meta name="description" content="${safeDescription}" />
        <meta property="og:title" content="${safeTitle}" />
        <meta property="og:description" content="${safeDescription}" />
        <meta property="og:image" content="${safeOgImage}" />
        <meta property="og:image:secure_url" content="${safeOgImage}" />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:image:alt" content="${safeTitle}" />
        <meta property="og:site_name" content="Antigravity 財富管理" />
        <meta property="og:type" content="website" />
        <meta property="og:url" content="${safeOgUrl}" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:image" content="${safeOgImage}" />
        
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #ffffff; color: #1e293b; }
            .loader { border: 4px solid #f3f3f3; border-top: 4px solid #3498db; border-radius: 50%; width: 32px; height: 32px; animation: spin 1s linear infinite; margin-bottom: 20px; }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            .container { text-align: center; padding: 20px; }
        </style>
        
        ${!isCrawler ? `
        <script>
            const targetUrl = window.location.origin + ${safeViewerJs};
            console.log('[SHORT_LINK] Redirection Target:', targetUrl);
            setTimeout(function() { 
                window.location.replace(targetUrl); 
            }, 500);
        </script>
        ` : ''}
    </head>
    <body>
        <div class="container">
            <div class="loader"></div>
            <p>正在為您開啟專屬市場報告...</p>
        </div>
    </body>
    </html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (error) {
    console.error("Firestore 短連結讀取錯誤:", error);
    res.status(500).send("系統發生錯誤，無法載入報告");
  }
});

// 新增：建立短連結（伺服器端單一真實來源，供網頁 UI 與 MCP 共用）
// 接收已上傳檔案的參照 (f) + 中繼資料 + 客戶清單，逐一寫入 Firestore links/{shortId}
app.post("/api/create-link", async (req, res) => {
  const advisor = requireApiKey(req, res);
  if (advisor === null) return;
  const { clients, f, r, t, d, i, w, origin: originInput } = req.body || {};

  const names: string[] = Array.isArray(clients)
    ? clients.map((n: any) => String(n).trim()).filter(Boolean)
    : [];

  if (names.length === 0) {
    return res.status(400).json({ error: "請提供至少一個客戶名稱 (clients)" });
  }
  if (!f || typeof f !== "string") {
    return res.status(400).json({ error: "請提供已上傳檔案的參照 (f)，例如 r2:reports/...." });
  }

  const projectId = process.env.VITE_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID;
  const apiKey = process.env.VITE_FIREBASE_API_KEY || process.env.FIREBASE_API_KEY;
  if (!projectId || !apiKey) {
    return res.status(500).json({ error: "伺服器缺少 Firebase 設定 (Project ID / API Key)" });
  }

  // 報告名稱後備：由檔案參照推導，與 OG 渲染邏輯一致
  const reportName = (r && String(r).trim()) || extractFileName(f);
  const title = (t && String(t).trim()) || reportName;
  const cleanWhatsapp = w ? String(w).replace(/\D/g, "") : "";

  // 建立連結的 origin：優先環境變數，其次用請求 host（與 App.tsx 的 customDomain 邏輯一致）
  const envOrigin = process.env.VITE_APP_URL || process.env.APP_URL;
  // req.protocol is 'http' behind Vercel's proxy (no app-level trust proxy —
  // deliberate, see clientIp above), so derive the scheme from x-forwarded-proto
  // only when running behind the trusted platform proxy.
  const proto = TRUST_PROXY_HEADERS
    ? String(req.headers["x-forwarded-proto"] || req.protocol).split(",")[0].trim()
    : req.protocol;
  const requestOrigin = `${proto}://${req.get("host")}`;
  const normalize = (s: string) => (s.endsWith("/") ? s.slice(0, -1) : s);
  // Only honor a client-supplied origin if it matches a trusted origin
  // (the configured app URL or the request host). Otherwise ignore it so a
  // misused advisor key cannot mint short links under an arbitrary domain.
  const candidate = originInput ? normalize(String(originInput)) : "";
  const trusted = new Set(
    [envOrigin, requestOrigin].filter(Boolean).map((s) => normalize(String(s)))
  );
  const baseOrigin = trusted.has(candidate)
    ? candidate
    : normalize(String(envOrigin || requestOrigin));

  // 30 天後過期（Firestore Timestamp，供 TTL 政策使用）
  const expireAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const createdAt = new Date().toISOString();
  const fsBase = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/links`;

  try {
    const results = await Promise.all(
      names.map(async (name) => {
        const payload: Record<string, string> = { c: name, r: reportName, t: title, f };
        if (d) payload.d = String(d);
        if (i) payload.i = String(i);
        if (cleanWhatsapp) payload.w = cleanWhatsapp;

        const compressed = LZString.compressToEncodedURIComponent(JSON.stringify(payload));
        const body = JSON.stringify({
          fields: {
            q: { stringValue: compressed },
            clientName: { stringValue: name },
            createdAt: { stringValue: createdAt },
            expireAt: { timestampValue: expireAt },
            adv: { stringValue: advisor }, // advisor who created it (for read-notification routing)
          },
        });

        // Create-only write: currentDocument.exists=false makes Firestore reject
        // (precondition failed) instead of silently overwriting an existing link.
        // Retry with a fresh id on collision.
        let shortId = "";
        for (let attempt = 0; attempt < 5; attempt++) {
          const candidate = Math.random().toString(36).substring(2, 8);
          const writeRes = await fetch(
            `${fsBase}/${candidate}?key=${apiKey}&currentDocument.exists=false`,
            { method: "PATCH", headers: { "Content-Type": "application/json" }, body }
          );

          if (writeRes.ok) {
            shortId = candidate;
            break;
          }

          const errText = await writeRes.text();
          // 409 / FAILED_PRECONDITION => id already taken; regenerate and retry.
          if (writeRes.status === 409 || /exists|FAILED_PRECONDITION/i.test(errText)) {
            console.warn(`[CREATE_LINK] ID collision on ${candidate}, retrying (${attempt + 1}/5)`);
            continue;
          }
          throw new Error(`Firestore 寫入失敗 (${writeRes.status}) for ${name}: ${errText.slice(0, 200)}`);
        }

        if (!shortId) throw new Error(`短連結 ID 連續碰撞，請重試 (${name})`);

        return { name, shortId, shortLink: `${baseOrigin}/l/${shortId}` };
      })
    );

    res.json({ links: results });
  } catch (error: any) {
    console.error("[CREATE_LINK] Error:", error.message);
    res.status(500).json({ error: "建立短連結失敗", detail: error.message });
  }
});

// Cloudflare R2: Generate Pre-signed URL for client-side PUT upload
app.post("/api/r2-presign", async (req, res) => {
  if (!requireApiKey(req, res)) return;
  const { fileName, contentType } = req.body;

  if (!fileName || !contentType) {
    return res.status(400).json({ error: "Missing fileName or contentType" });
  }

  try {
    const bucketName = process.env.R2_BUCKET_NAME || "reports";
    // Sanitize to a basename so a caller can't escape the prefix via
    // slashes or "../" segments in fileName.
    const safeName = String(fileName).replace(/[\\/]/g, "_").replace(/\.\./g, "_");
    // Preview images live under images/, reports (PDFs) under reports/.
    const isImage = String(contentType).startsWith("image/");
    const prefix = isImage ? "images" : "reports";
    // Avoid filename collisions by prefixing with timestamp
    const r2Key = `${prefix}/${Date.now().toString(36)}_${safeName}`;

    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: r2Key,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

    // Stable, crawler-public URL for OG previews (.jpg suffix keeps strict
    // crawlers happy; /api/img strips it before decoding the key).
    const publicPath = `/api/img/r2_${toUrlSafeBase64(r2Key)}.jpg`;

    res.json({ uploadUrl, r2Key, publicPath });
  } catch (error: any) {
    console.error("[R2_PRESIGN] Error:", error.message);
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

// Proxy Endpoint for PDF - Ensures cross-domain compatibility and bypassing Vercel limits
app.get("/api/pdf/:file_id", async (req, res) => {
  const { file_id } = req.params;

  try {
    let blobUrl = "";

    // 1. Resolve logical PDF source URL
    if (file_id.startsWith('f_')) {
      const filePath = fromUrlSafeBase64(file_id.slice(2));
      const encodedPath = encodeURIComponent(filePath).replace(/\//g, "%2F");
      const bucket = process.env.VITE_FIREBASE_STORAGE_BUCKET || process.env.FIREBASE_STORAGE_BUCKET || "market-update-56e1c.firebasestorage.app";
      console.log(`[PDF_PROXY] Decoding f_ ID. Path: ${filePath} | Bucket: ${bucket}`);
      blobUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodedPath}?alt=media`;
    } else if (file_id.startsWith('vblob_')) {
      blobUrl = fromUrlSafeBase64(file_id.slice(6));
      if (!isAllowedUpstreamUrl(blobUrl)) {
        console.error(`[PDF_PROXY] Blocked disallowed vblob_ host: ${blobUrl.split('?')[0]}`);
        return res.status(400).send("Invalid file ID format.");
      }
      console.log(`[PDF_PROXY] vblob_ ID: ${file_id.slice(0, 15)}... | Resolved URL: ${blobUrl.split('?')[0]}...`);
    } else if (file_id.startsWith('r2_')) {
      const r2Key = fromUrlSafeBase64(file_id.slice(3));
      if (!r2Key.startsWith('reports/')) {
        return res.status(400).send("Invalid file ID format.");
      }
      
      const bucket = process.env.R2_BUCKET_NAME || "reports";
      console.log(`[PDF_PROXY] R2 ID. Key: ${r2Key} | Bucket: ${bucket}`);
      
      // We can generate a GET presigned URL for the proxy to fetch from R2
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: r2Key,
      });
      blobUrl = await getSignedUrl(s3Client, command, { expiresIn: 60 });
    } else {
      return res.status(400).send("Invalid file ID format.");
    }

    const projectId = process.env.VITE_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID || "market-update-56e1c";
    console.log(`[PDF_PROXY] Request: ${file_id.slice(0, 10)}... | Project: ${projectId}`);

    // 2. Fetch with browser-like headers to avoid bot filters.
    // redirect:'manual' — the vblob_ host allowlist is validated on the INITIAL url
    // only, so following a 3xx from an allowed host to an internal target would be an
    // SSRF bypass. Object stores serve bytes directly (200), so legit flows never 3xx.
    const response = await fetch(blobUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(30000), // cap slow upstreams so they can't tie up a worker
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
      }
    });

    if (!response.ok) {
      console.error(`[PDF_PROXY] Upstream failure: ${response.status} ${response.statusText}`);
      return res.status(response.status).send(`Upstream Fetch Error: ${response.statusText}`);
    }

    // 3. Forward critical PDF headers
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="report_secure.pdf"');
    res.setHeader("Cache-Control", "private, max-age=3600"); // Cache for 1 hour for performance

    // 4. Stream response body to client (avoids loading whole file into Vercel memory)
    if (response.body) {
      // Modern Node.js/Web Stream iteration
      // @ts-ignore
      for await (const chunk of response.body) {
        res.write(chunk);
      }
      res.end();
    } else {
      const buffer = await response.arrayBuffer();
      res.send(Buffer.from(buffer));
    }
  } catch (error: any) {
    if (res.headersSent) { res.destroy(error); return; }
    console.error("[PDF_PROXY_CRITICAL] Exception:", error.message);
    res.status(500).send("A critical error occurred while retrieving the document.");
  }
});

// Proxy for preview/OG images stored in R2. Kept PUBLIC (no API key) so the
// WhatsApp/Telegram crawlers can fetch the og:image. Mirrors /api/pdf's r2_
// branch: a short-lived presigned GET is generated per request, so the public
// URL stays stable for the whole link lifetime without a public bucket.
app.get("/api/img/:file_id", async (req, res) => {
  // The public URL carries an image extension so strict crawlers accept it;
  // strip it before decoding the R2 key.
  const file_id = req.params.file_id.replace(/\.(png|jpe?g|gif|webp)$/i, "");

  if (!file_id.startsWith("r2_")) {
    return res.status(400).send("Invalid image ID format.");
  }

  try {
    const r2Key = fromUrlSafeBase64(file_id.slice(3));
    if (!r2Key.startsWith('images/')) {
      return res.status(400).send("Invalid image ID format.");
    }
    const bucket = process.env.R2_BUCKET_NAME || "reports";

    const command = new GetObjectCommand({ Bucket: bucket, Key: r2Key });
    const blobUrl = await getSignedUrl(s3Client, command, { expiresIn: 60 });

    // redirect:'manual' for parity with /api/pdf — R2 presigned GETs serve bytes
    // directly (200), so a 3xx would never be a legitimate response here.
    const response = await fetch(blobUrl, { redirect: 'manual', signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
      console.error(`[IMG_PROXY] Upstream failure: ${response.status} ${response.statusText}`);
      return res.status(response.status).send("Upstream Fetch Error");
    }

    res.setHeader("Content-Type", response.headers.get("content-type") || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");

    if (response.body) {
      // @ts-ignore — Web stream iteration
      for await (const chunk of response.body) res.write(chunk);
      res.end();
    } else {
      res.send(Buffer.from(await response.arrayBuffer()));
    }
  } catch (error: any) {
    if (res.headersSent) { res.destroy(error); return; }
    console.error("[IMG_PROXY_CRITICAL] Exception:", error.message);
    res.status(500).send("Failed to retrieve image.");
  }
});

// 新增：Dub.co 短連結轉換 API 端點
app.post("/api/shorten", async (req, res) => {
  if (!requireApiKey(req, res)) return; // advisor-only: forwards to the paid Dub.co API
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: "請提供需要縮短的網址 (url)" });
  }

  if (!process.env.DUB_API_KEY) {
    console.error("缺少 DUB_API_KEY 環境變數");
    return res.status(500).json({ error: "伺服器未設定短連結 API 金鑰" });
  }

  try {
    const dubResponse = await fetch("https://api.dub.co/links", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.DUB_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url }), // 將長連結傳給 Dub.co
    });

    if (!dubResponse.ok) {
      const errorText = await dubResponse.text();
      console.error("Dub.co API 錯誤:", dubResponse.status, errorText);
      throw new Error(`Dub.co API 錯誤: ${dubResponse.status}`);
    }

    const data = await dubResponse.json();
    res.json({ shortLink: data.shortLink }); // 回傳短連結
  } catch (error) {
    console.error("縮網址失敗:", error);
    res.status(500).json({ error: "無法產生短連結，請稍後再試" });
  }
});

// 新增：圖片大小檢查 API 端點
app.get("/api/check-image-size", async (req, res) => {
  if (!requireApiKey(req, res)) return; // advisor-only utility; also limits SSRF surface
  const { url } = req.query;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "缺少 url 參數" });
  }

  // 使用 resolveOgImage 解析最終的圖片網址 (自動修正 meee.com.tw 等)
  const resolvedUrl = resolveOgImage(url);

  // SSRF guard: this fetches a caller-supplied URL, so block internal/private
  // targets and never follow a redirect from a public host into an internal one.
  if (!isPublicHttpUrl(resolvedUrl)) {
    return res.status(400).json({ error: "不支援的圖片網址" });
  }
  const ssrfSafeFetch = (u: string, method: "HEAD" | "GET") =>
    fetch(u, { method, redirect: "manual", signal: AbortSignal.timeout(8000) });

  try {
    // 優先使用輕量 HEAD 請求
    let response = await ssrfSafeFetch(resolvedUrl, "HEAD");
    let contentLength = response.headers.get("content-length");

    // 若 HEAD 回傳無大小，嘗試用 GET 讀取標頭
    if (!contentLength) {
      response = await ssrfSafeFetch(resolvedUrl, "GET");
      contentLength = response.headers.get("content-length");
    }

    if (contentLength) {
      const sizeBytes = parseInt(contentLength, 10);
      return res.json({ resolvedUrl, sizeBytes });
    }

    res.json({ resolvedUrl, sizeBytes: null });
  } catch (error: any) {
    console.error("[CHECK_IMAGE_SIZE] 錯誤:", error.message);
    res.status(500).json({ error: "無法取得圖片大小資訊" });
  }
});

// Auto-generate a WhatsApp preview title + description from the uploaded PDF's
// actual content. Advisor-gated (requireApiKey), so no public-abuse rate limit
// is needed — the heavy AI gating on /api/session-end is for its unauth callers.
app.post("/api/generate-meta", async (req, res) => {
  if (!requireApiKey(req, res)) return;
  if (apiKeys.length === 0) {
    return res.status(500).json({ error: "伺服器未設定 GEMINI_API_KEY" });
  }

  const { f } = req.body;
  if (!f || typeof f !== "string" || !f.startsWith("r2:")) {
    return res.status(400).json({ error: "缺少或不支援的檔案參考 (f)，僅支援 R2 上傳" });
  }

  const MAX_PDF_BYTES = 14 * 1024 * 1024;

  // Resolve the PDF bytes from R2 via a short-lived presigned GET (same pattern
  // as the /api/pdf proxy).
  let pdfBuffer: Buffer;
  try {
    const r2Key = f.slice(3);
    const bucket = process.env.R2_BUCKET_NAME || "reports";
    const command = new GetObjectCommand({ Bucket: bucket, Key: r2Key });
    const url = await getSignedUrl(s3Client, command, { expiresIn: 60 });
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`R2 fetch ${resp.status}`);
    // Gemini's inline-data request cap is ~20MB and base64 inflates ~1.33×, so
    // guard at 14MB raw. Check Content-Length first to avoid buffering an
    // oversized object into memory; fall back to a post-read check if absent.
    const declaredSize = Number(resp.headers.get("content-length") || 0);
    if (declaredSize > MAX_PDF_BYTES) {
      return res.status(413).json({ error: "PDF 過大，無法自動生成，請手動填寫標題與描述" });
    }
    pdfBuffer = Buffer.from(await resp.arrayBuffer());
  } catch (e: any) {
    console.error("[GENERATE_META] PDF fetch failed:", e.message);
    return res.status(502).json({ error: "無法讀取 PDF 內容" });
  }

  if (pdfBuffer.length > MAX_PDF_BYTES) {
    return res.status(413).json({ error: "PDF 過大，無法自動生成，請手動填寫標題與描述" });
  }

  const prompt = `你是一家香港財富管理公司的內容編輯。以下是一份要透過 WhatsApp 分享給客戶的報告 PDF。
請依據 PDF 的實際內容，產生用於 WhatsApp 連結預覽卡的「標題」與「描述」。
要求：
- 一律使用繁體中文。
- title：簡潔有力，最多 20 字，點出報告主題；不要包含客戶名稱或日期。
- description：一句吸引客戶閱讀的摘要，最多 60 字，帶出閱讀的價值。
- 只輸出 JSON 物件：{"title":"...","description":"..."}`;

  const pdfPart = {
    inlineData: { mimeType: "application/pdf", data: pdfBuffer.toString("base64") },
  };

  // Rotate keys over time; lite/high-quota models lead since this is a simple,
  // frequent task. JSON is requested via mime-type + prompt and parsed defensively
  // (no responseSchema — keeps the whole fallback list compatible).
  for (const key of timeRotatedKeys()) {
    for (const modelName of STANDARD_MODELS) {
      try {
        const genAI = new GoogleGenerativeAI(key);
        const model = genAI.getGenerativeModel({
          model: modelName,
          // Gemma models have no JSON mode and reject responseMimeType — omit it
          // for them (the prompt + defensive parse still yields JSON). Mirrors the
          // telemetry fallback, which never sets responseMimeType on standard models.
          ...(modelName.startsWith("gemma")
            ? {}
            : { generationConfig: { responseMimeType: "application/json" } as any }),
        });
        const apiCall = model.generateContent([prompt, pdfPart]);
        apiCall.catch(() => {}); // avoid unhandled rejection if the timeout wins the race
        const result = (await Promise.race([
          apiCall,
          new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 20000)),
        ])) as any;
        const raw = result.response.text().replace(/^```json|```$/gm, "").trim();
        const parsed = JSON.parse(raw);
        const title = String(parsed?.title || "").trim();
        const description = String(parsed?.description || "").trim();
        if (title && description) {
          console.log(`[GENERATE_META] Success | ${modelName}`);
          return res.json({ title, description });
        }
        throw new Error("Empty title/description");
      } catch (err: any) {
        console.warn(`[GENERATE_META WARN] ${modelName}: ${(err.message || "").slice(0, 60)}`);
      }
    }
  }

  return res.status(502).json({ error: "自動生成失敗，請稍後再試或手動填寫" });
});

const JARGON_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const JARGON_ROUTE_DEADLINE_MS = 45_000;
const JARGON_CACHE_MAX = 500;
const jargonCache = new Map<string, { terms: JargonTerm[]; at: number }>();
const jargonInFlight = new Map<string, Promise<JargonTerm[] | null>>();

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

const isValidJargonImageBase64 = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  if (value.length < 100 || value.length > JARGON_IMAGE_MAX_B64_LEN) return false;
  if (value.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/=]+$/.test(value)) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  return true;
};

const hasJpegMagic = (base64: string): boolean => {
  try {
    const bytes = Buffer.from(base64.slice(0, 12), "base64");
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  } catch {
    return false;
  }
};

const sanitizeJargonTerms = (terms: unknown): JargonTerm[] => {
  if (!Array.isArray(terms)) return [];
  return terms
    .filter((entry): entry is { term: unknown; explanation: unknown } => !!entry && typeof entry === "object")
    .map((entry) => ({
      term: typeof entry.term === "string" ? entry.term.trim().slice(0, 80) : "",
      explanation: typeof entry.explanation === "string" ? entry.explanation.trim().slice(0, 240) : "",
    }))
    .filter((entry) => entry.term.length > 0 && entry.explanation.length > 0)
    .slice(0, 4);
};

const setJargonCache = (key: string, terms: JargonTerm[]): void => {
  if (!jargonCache.has(key) && jargonCache.size >= JARGON_CACHE_MAX) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [entryKey, entry] of jargonCache) {
      if (entry.at < oldestAt) {
        oldestAt = entry.at;
        oldestKey = entryKey;
      }
    }
    if (oldestKey) jargonCache.delete(oldestKey);
  }
  jargonCache.set(key, { terms, at: Date.now() });
};

const readJargonStore = async (key: string): Promise<JargonTerm[] | null> => {
  try {
    const command = new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME || "reports", Key: key });
    const response = await s3Client.send(command);
    const body = response.Body as { transformToString?: () => Promise<string> } | undefined;
    const raw = body?.transformToString ? await body.transformToString() : "";
    const parsed = JSON.parse(raw);
    const terms = sanitizeJargonTerms(parsed?.terms);
    return Array.isArray(parsed?.terms) ? terms : null;
  } catch (err: any) {
    console.warn(`[JARGON] store read failed: ${(err?.message || "").slice(0, 60)}`);
    return null;
  }
};

const writeJargonStore = async (key: string, terms: JargonTerm[]): Promise<void> => {
  try {
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME || "reports",
      Key: key,
      Body: JSON.stringify({ terms: sanitizeJargonTerms(terms), at: Date.now() }),
      ContentType: "application/json",
    });
    await s3Client.send(command);
  } catch (err: any) {
    console.warn(`[JARGON] store write failed: ${(err?.message || "").slice(0, 60)}`);
  }
};

app.post("/api/explain-jargon", async (req, res) => {
  res.set("Cache-Control", "no-store");

  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const textCandidate = typeof body.text === "string" ? body.text.trim().slice(0, JARGON_MAX_TEXT_LEN) : "";
    let pathType: "text" | "image" | null = null;
    let basis = "";
    let prompt = "";
    let imageBase64 = "";

    if (textCandidate.length >= JARGON_MIN_TEXT_LEN) {
      pathType = "text";
      basis = textCandidate;
      prompt = `你是一場財經簡報的即時助理。請從下方的頁面文字中，找出最多 4 個完全沒有金融背景的客戶可能不懂的金融專業術語（jargon）。
每個術語請用繁體中文寫一段解說：
- 用完全沒有金融背景的人一看就懂的日常語言，絕不能用術語解釋術語，也不能只是換句話說
- 在適當情況下，用一個具體數字、比較或生活化比喻讓概念落地（例如「1 個基點 = 0.01%，50 個基點就是半個百分點」）
- 最多 50 個中文字
術語本身保留頁面上的原文寫法，最重要的術語放最前面。
只挑真正的專業術語（如 存續期、基點、EBITDA 利潤率）——跳過常見詞彙、公司名稱和數字。
如果沒有術語，回傳空清單。
頁面文字：
${textCandidate}
只輸出 JSON：{ "terms": [ { "term": "...", "explanation": "..." } ] }`;
    } else if (isValidJargonImageBase64(body.imageBase64)) {
      if (!hasJpegMagic(body.imageBase64)) {
        return res.status(400).json({ success: false, error: "Missing text or image" });
      }
      pathType = "image";
      imageBase64 = body.imageBase64;
      basis = imageBase64;
      prompt = `你是一場財經簡報的即時助理。請先閱讀這張頁面圖片中所有可見文字，再從中找出最多 4 個完全沒有金融背景的客戶可能不懂的金融專業術語（jargon）。
每個術語請用繁體中文寫一段解說：
- 用完全沒有金融背景的人一看就懂的日常語言，絕不能用術語解釋術語，也不能只是換句話說
- 在適當情況下，用一個具體數字、比較或生活化比喻讓概念落地（例如「1 個基點 = 0.01%，50 個基點就是半個百分點」）
- 最多 50 個中文字
術語本身保留頁面上的原文寫法，最重要的術語放最前面。
只挑真正的專業術語（如 存續期、基點、EBITDA 利潤率）——跳過常見詞彙、公司名稱和數字。
如果沒有術語，回傳空清單。
查找位置：術語通常藏在較長的詞組裡——基金名稱、標題、欄位、註腳。
例如基金名稱「美元貨幣市場基金 A類別（累積）」就包含術語 貨幣市場基金、A類別、累積。
絕對不要挑：基金/代號代碼（如 B12、X03#）、頁面行數、百分比或日期。
只輸出 JSON：{ "terms": [ { "term": "...", "explanation": "..." } ] }`;
    }

    if (!pathType) {
      return res.status(400).json({ success: false, error: "Missing text or image" });
    }

    if (apiKeys.length === 0) {
      return res.status(503).json({ success: false, error: "AI 未設定" });
    }

    const ip = clientIp(req);
    if (!allow(`jg:store:${ip}`, 600, 3_600_000)) {
      return res.status(429).json({ success: false, error: "Rate limited" });
    }

    const fileId = typeof body.fileId === "string" ? body.fileId.trim().slice(0, 200) : "";
    const page = Number.isInteger(body.page) && body.page >= 1 ? body.page : 0;
    const contentHash = sha256Hex(basis);
    const cacheKey = `jg:${fileId || "-"}#${page || 0}#${pathType}#${contentHash}`;
    const storeKey = fileId && page
      ? `jargon/${sha256Hex(`${fileId}#${page}#${pathType}#${contentHash}`)}.json`
      : "";
    // Glossary override is applied at SERVE time (not before storing), so the
    // R2/L1 copy stays the raw model output and editing the glossary takes
    // effect immediately for already-cached pages.
    const cached = jargonCache.get(cacheKey);
    if (cached && Date.now() - cached.at < JARGON_CACHE_TTL_MS) {
      return res.json({ success: true, terms: applyJargonGlossary(cached.terms), source: "cache" });
    }
    if (cached) jargonCache.delete(cacheKey);

    if (storeKey) {
      const stored = await readJargonStore(storeKey);
      if (stored !== null) {
        setJargonCache(cacheKey, stored);
        return res.json({ success: true, terms: applyJargonGlossary(stored), source: "store" });
      }
    }

    const inFlight = jargonInFlight.get(cacheKey);
    if (inFlight) {
      const terms = await inFlight.catch(() => null);
      if (terms === null) {
        return res.status(502).json({ success: false, error: "AI processing failed" });
      }
      return res.json({ success: true, terms: applyJargonGlossary(terms) });
    }

    if (!allow(`jg:ip:${ip}`, 40, 3_600_000, false) || !allow("jg:global", 200, 3_600_000, false)) {
      return res.status(429).json({ success: false, error: "Rate limited" });
    }
    allow(`jg:ip:${ip}`, 40, 3_600_000);
    allow("jg:global", 200, 3_600_000);

    const run = (async (): Promise<JargonTerm[] | null> => {
      const routeStart = Date.now();
      for (const key of timeRotatedKeys()) {
        for (const modelName of STANDARD_MODELS) {
          const remainingMs = JARGON_ROUTE_DEADLINE_MS - (Date.now() - routeStart);
          if (remainingMs <= 0) return null;
          try {
            const genAI = new GoogleGenerativeAI(key);
            const model = genAI.getGenerativeModel({
              model: modelName,
              ...(modelName.startsWith("gemma")
                ? {}
                : { generationConfig: { responseMimeType: "application/json" } as any }),
            });
            const parts = pathType === "image"
              ? [prompt, { inlineData: { mimeType: "image/jpeg", data: imageBase64 } }]
              : prompt;
            // No-op handler: if the timeout race wins first, a later rejection
            // from the still-running call must not become an unhandled promise
            // rejection (fatal on Node 15+, would kill the serverless instance).
            const apiCall = model.generateContent(parts);
            apiCall.catch(() => {});
            const result = (await Promise.race([
              apiCall,
              new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), Math.min(20_000, remainingMs))),
            ])) as any;
            const raw = result.response.text().replace(/^```json|```$/gm, "").trim();
            const parsed = JSON.parse(raw);
            // A JSON reply WITHOUT a terms array is schema drift, not "no jargon
            // found" — it must not persist an empty sentinel for this page.
            if (!Array.isArray(parsed?.terms)) throw new Error("Missing terms array");
            const terms = sanitizeJargonTerms(parsed.terms);
            console.log(`[JARGON] Success | ${modelName}`);
            setJargonCache(cacheKey, terms);
            if (storeKey) await writeJargonStore(storeKey, terms);
            return terms;
          } catch (err: any) {
            console.warn(`[JARGON WARN] ${modelName}: ${(err.message || "").slice(0, 60)}`);
          }
        }
      }

      return null;
    })();

    jargonInFlight.set(cacheKey, run);
    let result: JargonTerm[] | null;
    try {
      result = await run;
    } finally {
      jargonInFlight.delete(cacheKey);
    }

    if (result !== null) {
      return res.json({ success: true, terms: applyJargonGlossary(result) });
    }

    return res.status(502).json({ success: false, error: "AI processing failed" });
  } catch (err: any) {
    console.error(`[JARGON] Failed: ${(err?.message || "").slice(0, 120)}`);
    if (!res.headersSent) return res.status(500).json({ success: false, error: "Failed to process" });
  }
});


// Tracking Endpoint
app.post("/api/track", async (req, res) => {
  const { event, client_name, report_name, file_id, duration_seconds, page } = req.body;

  let rName = report_name || "Document";
  if (rName === "Document" && file_id) {
    try {
      let decodedPath = "";
      if (file_id.startsWith('f_')) {
        decodedPath = fromUrlSafeBase64(file_id.slice(2));
      } else if (file_id.startsWith('vblob_')) {
        decodedPath = fromUrlSafeBase64(file_id.slice(6));
      } else if (file_id.startsWith('r2_')) {
        decodedPath = fromUrlSafeBase64(file_id.slice(3));
      }
      if (decodedPath) {
        const extracted = extractFileName(decodedPath);
        if (extracted && extracted !== "Document") {
          rName = extracted;
        }
      }
    } catch (e) {
      // ignore
    }
  }

  console.log(`[TRACK] ${event} | ${client_name} | ${rName}`);

  // /api/track is unauthenticated and these values come from the request body;
  // they're sent with parse_mode:'HTML', so escape them — mirrors /api/session-end.
  const cn = escapeHTML(String(client_name ?? ''));
  const rn = escapeHTML(String(rName));
  const fid = escapeHTML(String(file_id ?? ''));

  let text = "";

  if (event === 'open') {
    const totalPages = escapeHTML(String(req.body.total_pages ?? "未知"));
    text = `🔔 <b>報告已開啟</b>\n\n👤 <b>客戶：</b> ${cn}\n📄 <b>報告：</b> ${rn}\n📑 <b>總頁數：</b> ${totalPages}\n🔗 <b>ID：</b> ${fid}`;
  } else if (event === 'security_alert') {
    const { type } = req.body;
    let actionDesc = '截圖報告';
    if (type === 'print_attempt') actionDesc = '列印報告';
    if (type === 'screenshot_detected_win') actionDesc = 'Windows 截圖';
    if (type === 'screenshot_detected_mac') actionDesc = 'Mac 截圖 (Cmd+Shift)';
    if (type === 'potential_screenshot_mac') actionDesc = '潛在 Mac 截圖 (Cmd+Shift)';
    text = `🚨 <b>安全警報：偵測到未經授權的操作</b> 🚨\n\n` +
      `👤 <b>客戶：</b> ${cn}\n` +
      `📄 <b>報告：</b> ${rn}\n` +
      `⚠️ <b>行為：</b> 嘗試 ${actionDesc} !!`;
  } else if (event === 'click_appointment') {
    const pageNote = page != null ? `（停留喺第 ${escapeHTML(String(page))} 頁）` : '';
    text = `🔥 <b>高價值意向！</b>\n\n👤 客戶 <b>${cn}</b> 點擊咗<b>預約顧問</b>按鈕${pageNote}！\n請準備透過 WhatsApp 跟進。`;
  } else if (event === 'engaged_60s') {
    // One-shot client milestone (fired once per session at >=60s). Replaces the
    // old heartbeat 60-90s window check, which silently missed the alert when
    // the single qualifying heartbeat was dropped (hidden tab / network blip).
    const pageNote = page != null ? `（目前喺第 ${escapeHTML(String(page))} 頁）` : '';
    text = `🟢 <b>正在閱讀中</b>\n\n👤 客戶 <b>${cn}</b> 已閱讀 <b>${rn}</b> 超過 1 分鐘${pageNote}。\n建議：準備 WhatsApp，等客戶讀完馬上跟進。`;
  }

  // Await on serverless: a fire-and-forget send is killed when the function is
  // frozen after res.json (same reason the /l/:shortId handler awaits).
  // Rate-limit the send per client IP: a real reader fires only a handful of
  // Telegram-worthy events (open / heartbeat / click) per session, so 12/min is
  // far above legitimate use while it caps an attacker spamming forged events.
  if (text) {
    if (allow(`tg:${clientIp(req)}`, 12, 60_000)) {
      await sendTelegram(text);
    } else {
      console.warn(`[TRACK] Telegram rate-limited for ${clientIp(req)} (${event})`);
    }
  }

  res.json({ status: "ok" });
});

// THINKING_MODELS support thinkingLevel + native JSON schema (response_schema).
// STANDARD_MODELS are fallbacks that cannot honour those config options.
const THINKING_MODELS = [
  "gemini-3-flash-preview",           // RPD: 20, RPM: 5
  "gemini-2.5-flash",                 // RPD: 20, RPM: 5
];
const STANDARD_MODELS = [
  "gemini-3.1-flash-lite",            // RPD: 500, RPM: 15 (Highest Quota) — GA May 2026
  "gemini-2.5-flash-lite",            // RPD: 20, RPM: 10
  "gemini-2.0-flash",                 // Formal release
  "gemma-3-27b-it",                   // High-quota fallback (RPD: 14.4K)
  "gemini-1.5-flash-latest"           // Ultimate safety fallback
];

// Native JSON response schema — enum constraints keep output deterministic.
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    intent_archetype: {
      type: "string",
      enum: ["Deep Diver", "Yield Seeker", "Verification Mode", "Momentum Buyer", "Disengaged"],
      description: "Categorisation of the client's primary objective based on multi-step telemetry analysis.",
    },
    z_score: {
      type: "number",
      description: "Pre-normalised engagement score passed in; return it as-is after validating it matches the observed pattern.",
    },
    friction_points: {
      type: "array",
      items: { type: "string" },
      description: "Document sections or page ranges where scroll velocity dropped to zero or zoom clustering occurred.",
    },
    psych_bias: {
      type: "string",
      enum: ["Loss Aversion", "Overconfidence", "Confirmation Bias", "Status Quo Bias", "FOMO"],
      description: "Primary cognitive bias detected via multi-step analysis of digital body language.",
    },
    rep_system: {
      type: "string",
      enum: ["Visual", "Auditory Digital", "Kinesthetic"],
      description: "NLP representational system inferred from telemetry. Visual: high scroll velocity, rapid page jumps, short per-page dwell. Auditory Digital: long dwell on data/compliance/text pages, zoom on numbers, low velocity on analytical content. Kinesthetic: micro-loops, long pauses, slow deliberate movement between pages.",
    },
    advisor_nlp_approach: {
      type: "string",
      description: "Concrete NLP-grounded follow-up tactic for the advisor. Must specify: (1) pace and sensory predicates to match the client's rep_system, (2) one Milton Model pattern to bypass resistance, (3) one reframe for their dominant psych_bias. Write as a direct instruction to the advisor in English.",
    },
    spin_question: {
      type: "string",
      description: "The single most impactful SPIN question to open the follow-up conversation, derived from intent_archetype and friction_points. Format: '[SPIN Type]: [exact question in English]'. Mapping: Disengaged→Situation (re-establish context); Yield Seeker→Problem (explore the gap); Verification Mode or friction on compliance pages→Implication (amplify consequences of unresolved concern); Deep Diver or Momentum Buyer→Need-Payoff (let client articulate the value). The question must reference the specific content area where friction was detected.",
    },
    cialdini_lever: {
      type: "string",
      description: "The primary Cialdini influence principle for this client, mapped from psych_bias and intent_archetype, plus one concrete tactic. Format: '[Principle]: [one-sentence tactic in English]'. Mapping: Loss Aversion→Scarcity (make cost of delay tangible); FOMO→Social Proof (peer story of similar client who acted); Status Quo Bias→Consistency (anchor to their own stated values) + Authority (expert review framing); Overconfidence→Social Proof (peer comparison to calibrate); Confirmation Bias→Unity (you already know this matters — this confirms it).",
    },
    voss_label: {
      type: "string",
      description: "A Chris Voss tactical empathy label targeting the highest-friction page or behaviour detected. Must use 'It sounds like…', 'It seems like…', or 'It looks like…' format. Must name the specific emotion behind the friction (skepticism, overwhelm, hesitation, comparison anxiety) — not the content. Follow with one calibrated 'What' or 'How' question to draw out the real concern. Write in English. Under 50 words total.",
    },
    nba_whatsapp: {
      type: "string",
      description: "A customised WhatsApp opening message in Hong Kong financial Cantonese (traditional characters). Must use language predicates matching the client's rep_system and embed one presupposition that assumes the next meeting.",
    },
  },
  required: ["intent_archetype", "z_score", "friction_points", "psych_bias", "rep_system", "advisor_nlp_approach", "spin_question", "cialdini_lever", "voss_label", "nba_whatsapp"],
  additionalProperties: false,
};

// Helper: detect micro-loops from timestamped navigation history
function detectMicroLoops(navHistory: Array<{ page: number; t: number }>): string[] {
  const loops: string[] = [];
  const WINDOW_MS = 120_000; // 2-minute analysis window
  const MIN_CYCLES = 3;

  if (navHistory.length < MIN_CYCLES * 2) return loops;

  const pagePairs = new Map<string, number[]>();
  for (let i = 1; i < navHistory.length; i++) {
    const prev = navHistory[i - 1].page;
    const curr = navHistory[i].page;
    if (prev !== curr) {
      const key = `${Math.min(prev, curr)}<->${Math.max(prev, curr)}`;
      if (!pagePairs.has(key)) pagePairs.set(key, []);
      pagePairs.get(key)!.push(navHistory[i].t);
    }
  }

  pagePairs.forEach((timestamps, key) => {
    if (timestamps.length >= MIN_CYCLES) {
      const span = timestamps[timestamps.length - 1] - timestamps[0];
      if (span <= WINDOW_MS) {
        loops.push(`Pages ${key} (${timestamps.length}x in ${Math.round(span / 1000)}s)`);
      }
    }
  });

  return loops;
}

// AI-Powered Session Analysis Endpoint
// Compact per-page reader-behaviour block for the Telegram summaries. The raw
// matrix used to be visible only inside the Gemini prompt, so a throttled or
// failed AI run threw the behaviour data away. Inputs are sanitized numerics
// (no escaping needed); top-5 pages keeps the message far below Telegram's
// 4096-char limit.
const buildBehaviorBlock = (
  pagesData: Record<string, { dwellMs: number; activeDwellMs: number; maxScale: number; maxScrollDepthPct: number }>,
  navigationPath: number[],
): string => {
  const entries = Object.entries(pagesData)
    .map(([page, d]) => ({ page: Number(page), ...d }))
    .filter(e => Number.isFinite(e.page) && e.dwellMs > 0)
    .sort((a, b) => b.dwellMs - a.dwellMs)
    .slice(0, 5);
  if (entries.length === 0) return "";
  const lines = entries.map(e => {
    const totalSec = Math.round(e.dwellMs / 1000);
    const activeSec = Math.round(e.activeDwellMs / 1000);
    const zoom = e.maxScale > 1 ? `｜🔍 ${e.maxScale.toFixed(1)}x` : "";
    return `• 第 ${e.page} 頁：${totalSec}s（專注 ${activeSec}s）｜深度 ${Math.round(e.maxScrollDepthPct)}%${zoom}`;
  });
  const path = navigationPath.length > 1
    ? `\n🧭 <b>路徑：</b> ${navigationPath.slice(0, 20).join(' → ')}${navigationPath.length > 20 ? ' …' : ''}`
    : "";
  return `\n\n📖 <b>閱讀行為（最專注頁面）：</b>\n${lines.join('\n')}${path}`;
};

const formatReturnVisitGap = (mins: number): string => {
  if (mins >= 2880) return `${Math.round(mins / 1440)} 日`;
  if (mins >= 60) return `${Math.round(mins / 60)} 小時`;
  return `${mins} 分鐘`;
};

app.post("/api/session-end", async (req, res) => {
  const { event, session_id, client_name, report_name, file_id } = req.body;
  // Everything numeric/array below is unauthenticated client input. Coerce and
  // clamp it in one place (kills NaN poisoning, oversized arrays, and HTML
  // injection via number-shaped fields interpolated into Telegram parse_mode).
  const {
    total_duration_sec, total_pages, pages_data, navigation_path,
    // Phase 3 deep telemetry
    nav_history, zoom_clusters, scroll_samples, peak_scroll_velocity,
    // Phase 4 enrichment
    cta_click_page, mins_since_last_visit, device_id, device_type, tab_switch_count, return_visit_count, engaged_60s_page
  } = sanitizeSessionEnd(req.body);

  let rName = report_name || "Document";
  if (rName === "Document" && file_id) {
    try {
      let decodedPath = "";
      if (file_id.startsWith('f_')) {
        decodedPath = fromUrlSafeBase64(file_id.slice(2));
      } else if (file_id.startsWith('vblob_')) {
        decodedPath = fromUrlSafeBase64(file_id.slice(6));
      } else if (file_id.startsWith('r2_')) {
        decodedPath = fromUrlSafeBase64(file_id.slice(3));
      }
      if (decodedPath) {
        const extracted = extractFileName(decodedPath);
        if (extracted && extracted !== "Document") {
          rName = extracted;
        }
      }
    } catch (e) {
      // ignore
    }
  }

  console.log(`🚀 [BACKEND] 分析請求: ${client_name} | 報告: ${rName} | Session: ${session_id?.slice(0, 8)}`);

  if (event !== 'session_end') return res.json({ status: "ignored" });

  // pages_data is unauthenticated request input. Guard against (a) non-numeric keys
  // (Number('x') → NaN poisoning the whole computation) and (b) a huge object whose
  // key spread into Math.max(...) would throw a RangeError / stall the worker.
  const pageNumbers =
    pages_data && typeof pages_data === "object"
      ? Object.keys(pages_data).map(Number).filter(Number.isFinite).slice(0, 5000)
      : [];
  const maxReachedPage = pageNumbers.length > 0 ? Math.max(...pageNumbers) : 1;

  const totalPagesNum = Number(total_pages);
  const progressPercent = Number.isFinite(totalPagesNum) && totalPagesNum > 0
    ? (maxReachedPage / totalPagesNum) * 100
    : 0;
  const isDeepRead = progressPercent >= 30;
  // Return visit = at least the second session for this file+client combo. Strong buying signal —
  // always trigger AI analysis even if this individual session was short.
  // return_visit_count only increments on genuine re-opens after a completed
  // session (unlike tab_switch_count, which counts every tab-hide/glance-away).
  const isReturnVisit = (return_visit_count ?? 0) >= 1;
  const wantsAnalysis = aiEnabled && (isDeepRead || isReturnVisit);

  // Gate the paid Gemini loop with three checks (short-circuit && — a slot is only
  // consumed once all prior checks pass):
  //   1. per session_id, 1/min  — stops replay storms of a single forged session.
  //   2. per IP, 30/hour        — caps a flood that rotates session_ids from one IP.
  //   3. global, 40/hour        — final backstop that bounds total Gemini spend on
  //      this instance even if the attacker also spoofs the IP. Scales with traffic
  //      (Vercel adds instances, each with its own budget).
  // A genuine return visit gets a FRESH session_id (see useTelemetry), so every real
  // return still gets its own analysis — the limits only bite abuse. When throttled,
  // flow falls through to the cheap summary branches below (the advisor is still
  // notified; no Gemini call is made).
  const ip = clientIp(req);
  const aiAllowed = wantsAnalysis
    && allow(`ai:s:${session_id ?? "none"}`, 1, 60_000)
    && allow(`ai:ip:${ip}`, 30, 3_600_000)
    && allow("ai:global", 40, 3_600_000);

  let text = "";
  const behaviorBlock = buildBehaviorBlock(pages_data, navigation_path);

  if (aiAllowed) {
    try {
      // ── Pre-calculate Z-score server-side (AI receives it, not calculates it) ──
      // Baseline: empirical mean/σ for a typical advisory session.
      // Replace with real Firestore aggregate when you have enough historical data.
      const MU = 120;   // seconds — historical average session duration
      const SIGMA = 60; // seconds — historical standard deviation
      const durationSec = Number(total_duration_sec);
      const zScore = Number.isFinite(durationSec)
        ? parseFloat(((durationSec - MU) / SIGMA).toFixed(2))
        : 0;

      const microLoops = detectMicroLoops(nav_history || []);
      const topZoomPages = (zoom_clusters || [])
        .reduce((acc: Record<number, number>, z: any) => {
          acc[z.page] = (acc[z.page] || 0) + 1;
          return acc;
        }, {});
      const zoomSummary = Object.entries(topZoomPages)
        .sort(([, a]: any, [, b]: any) => b - a)
        .slice(0, 3)
        .map(([page, count]) => `Page ${page} (${count} zoom events)`)
        .join(', ') || 'none';

      const behaviorSummary = Object.entries(pages_data || {}).map(([page, data]: [string, any]) => {
        const activeSec = Math.round((data.activeDwellMs || 0) / 1000);
        const totalSec = Math.round((data.dwellMs || 0) / 1000);
        const maxScale = typeof data.maxScale === 'number' ? data.maxScale : 1;
        const depth = data.maxScrollDepthPct != null ? `${data.maxScrollDepthPct}%` : 'n/a';
        return `Page ${page}: ${totalSec}s total (${activeSec}s active), zoom ${maxScale.toFixed(1)}x, scroll depth ${depth}`;
      }).join('\n');

      const pathSummary = navigation_path?.join(' → ') || 'unknown';
      // Sanitizer maps "absent" to 0, so 0 now means not captured.
      const skimRate = peak_scroll_velocity > 0
        ? `${peak_scroll_velocity} px/ms peak`
        : 'not captured';

      // Skim profile from the full sample series (peak alone over-weights one
      // flick). 3 px/ms matches the Visual rep-system threshold in the prompt.
      const SKIM_THRESHOLD = 3;
      const scrollProfile = scroll_samples.length > 0
        ? (() => {
            const avg = scroll_samples.reduce((sum, s) => sum + s.v, 0) / scroll_samples.length;
            const fastCount = scroll_samples.filter((s) => s.v > SKIM_THRESHOLD).length;
            const fastPct = Math.round((fastCount / scroll_samples.length) * 100);
            return `avg ${avg.toFixed(2)} px/ms over ${scroll_samples.length} samples, ${fastPct}% above skim threshold (${SKIM_THRESHOLD} px/ms)`;
          })()
        : 'not captured';

      // ── System prompt: behavioural finance framework, no HTML instructions ──
      const systemPrompt = `You are the Antigravity behavioural intelligence engine for a Hong Kong wealth management firm.
Your role is to perform multi-step analytical inference on raw document telemetry, map it to Kahneman's System 1/System 2 framework and NLP representational systems, and produce a deterministic JSON Sales Navigation report.

BEHAVIOURAL FINANCE RULES:
- Apply Prospect Theory: loss aversion signals (micro-loops between yield and risk pages) are weighted 2x.
- A zoom cluster on fee/compliance content = System 2 activation (skepticism/verification mode).
- High skim rate on educational pages = experienced investor profile (bypass introductory dialogue).
- Scroll depth < 40% on a page with dwell > 20s = reader stopped mid-page = STRONG friction point (something on the upper half of that page raised a concern or question). Reference this in friction_points.
- Scroll depth > 80% on a page with low dwell = client confirmed the page quickly = comfortable with content.
- Scroll depth > 80% on a page with high dwell = thorough reading = key interest area.
- CTA CLICK SIGNAL (cta_click_page): if the client clicked the WhatsApp appointment button, the page they were on at that moment is their PEAK INTEREST page. This overrides other signals — that page's content is what motivated them to act. Reference cta_click_page explicitly in spin_question, advisor_nlp_approach, and nba_whatsapp. intent_archetype should lean toward "Momentum Buyer" when cta_click_page is set.

CONTEXT SIGNALS:
- Device mobile: weight engagement signals 1.3× — mobile reading requires more intent than desktop. Keep advisor_nlp_approach and nba_whatsapp concise (mobile users have short attention windows).
- Device desktop: assume seated reading context — more deliberate evaluation. Advisor can use longer, more detailed follow-up.
- return_visit_count >= 1: RETURN VISIT — client came back to re-read after a completed session = strongest organic buying signal. Elevate intent_archetype toward Deep Diver or Momentum Buyer. cialdini_lever MUST be Consistency ("You've come back to this several times — this clearly matters to you") or Scarcity (cost of further delay). When mins_since_last_visit is a number, reference the concrete gap in nba_whatsapp (for example, returned after N minutes/hours — treat a short gap under 24h as high urgency).
- return_visit_count = 0: single-sitting read = casual evaluation, not yet a return-buyer pattern.
- tab_switch_count: attention switches DURING reading (glances at other tabs/apps). High count on a single sitting = distracted context, not a buying signal — weigh dwell/scroll signals accordingly.
- Time of day: morning/afternoon = work-context reading (often interrupted); evening = personal/family-context reading (higher emotional weight, better follow-up window); late night = high personal motivation but defer outreach until next morning.

NLP REPRESENTATIONAL SYSTEM INFERENCE (from telemetry):
- Prefer the scroll PROFILE (% of samples above skim threshold) over the single peak value — one fast flick does not make a Visual reader; a sustained >30% skim share does.
- Visual (V): peak scroll velocity > 3 px/ms OR average page dwell < 15s AND many pages covered rapidly. Client is result-oriented and impatient — get to the point, use visual language (清晰, 前景, 一目了然).
- Auditory Digital (Ad): long dwell (>45s) on data-heavy or compliance pages, zoom clusters on numbers/text, low scroll velocity on analytical content. Client is analytical and self-talks — provide logic, step-by-step reasoning, use language like 明白, 分析, 理解.
- Kinesthetic (K): micro-loops present, slow deliberate navigation, long pauses between page changes, short active dwell vs total dwell ratio. Client is feeling-based — slow down, create feelings, use language like 感受, 掌握, 如釋重負.

ADVISOR_NLP_APPROACH CONSTRUCTION RULES:
1. Pace: match the client's rep_system pace (V=fast/direct, Ad=logical/sequential, K=slow/empathic).
2. Milton Model pattern: choose one that fits — use Cause & Effect for Ad ("Because you've reviewed the details, you can see..."), Presupposition for V ("When we meet next week..."), Embedded Command for K ("...and begin to feel how this protects what matters most").
3. Reframe for psych_bias: Loss Aversion → content reframe ("every premium = a guardian for your family"); FOMO → cause-effect ("the earlier you act, the more compounding works for you"); Status Quo Bias → context reframe ("what worked before may cost more to fix later"); Overconfidence → chunk-up ("even the best plans have a gap — let's find yours"); Confirmation Bias → utilisation ("you already know protection matters — this confirms it").

SPIN SELLING — SPIN_QUESTION RULES:
- Disengaged → Situation: re-establish what matters to them before anything else.
- Yield Seeker → Problem: surface the gap between what they have and what they need.
- Verification Mode OR friction detected on compliance/fee pages → Implication: amplify the consequence of the unresolved concern ("If this gap isn't closed, what changes for your family?"). Reference the specific friction page.
- Deep Diver → Need-Payoff: let them articulate the value ("If this were sorted, what would that mean for your planning?").
- Momentum Buyer → Need-Payoff: confirm and accelerate ("You've clearly thought about this — what's the one thing that would make this feel right?").
- The question must sound natural in a follow-up conversation, not clinical.

CIALDINI INFLUENCE — CIALDINI_LEVER RULES:
- Loss Aversion → Scarcity: make the cost of delay concrete and time-bound.
- FOMO → Social Proof: reference a peer story of a similar client who acted (same life stage, same concern).
- Status Quo Bias → Consistency: anchor to a value they stated + Authority (position yourself as the expert reviewer, not the salesperson).
- Overconfidence → Social Proof: use peer comparison to introduce calibrated uncertainty ("Most clients at your stage discover one gap they didn't expect").
- Confirmation Bias → Unity: "You already know this matters — this just confirms what you've been thinking."
- Output: one principle name + one tactical sentence the advisor can actually say or do.

VOSS NEGOTIATION — VOSS_LABEL RULES:
- Target the page or behaviour with the highest friction (longest dwell + zoom cluster, or micro-loop page pair).
- Name the emotion behind the friction — not the content. Possible emotions: skepticism, overwhelm, hesitation, comparison anxiety, hidden concern.
- Use "It sounds like…" / "It seems like…" / "It looks like…" — never "I feel".
- Follow immediately with one calibrated question: "What…" or "How…" — never "Why".
- The label + question together should make the client feel understood before they've said anything.

NBA_WHATSAPP RULES:
- Use Cantonese sensory predicates matching the rep_system.
- Embed one presupposition that assumes the next touchpoint (e.g., "下次見面前" or "當你細閱之後").
- Keep under 60 characters. No emojis. Natural conversational tone, not salesy.

Your output MUST strictly follow the provided JSON schema. No additional keys. No markdown.`;

      const userPrompt = `Analyse this client session and return the Sales Navigation JSON.

SESSION DATA:
- Client: ${client_name}
- Report: ${rName}
- Duration: ${total_duration_sec}s
- Pre-calculated Z-Score: ${zScore} (pass this value into the z_score field)
- Navigation path: ${pathSummary}
- Micro-loops detected: ${microLoops.length > 0 ? microLoops.join('; ') : 'none'}
- Top zoom clusters: ${zoomSummary}
- Peak scroll velocity (skim rate): ${skimRate}
- Scroll profile: ${scrollProfile}
- 60s engagement milestone: ${engaged_60s_page != null ? `crossed while on page ${engaged_60s_page} — sustained early engagement there` : 'not reached (session under 60s or milestone page unknown)'}
- CTA click page (WhatsApp appointment button): ${cta_click_page != null ? `Page ${cta_click_page} — STRONGEST INTEREST SIGNAL` : 'not clicked'}
- Device: ${device_type || 'unknown'}
- Return visits (completed sessions re-opened): ${return_visit_count ?? 0}
- Minutes since last visit: ${mins_since_last_visit ?? "n/a"}
- Tab switch count (attention switches while reading): ${tab_switch_count ?? 0}
- Time of day (HK): ${getHkTimeOfDay().name}
- Per-page behaviour matrix:
${behaviorSummary}

STEP 1 — Infer rep_system: cross-reference scroll velocity, per-page dwell, micro-loops, and zoom patterns against the NLP inference rules.
STEP 2 — Determine psych_bias: apply Prospect Theory weighting to micro-loops and zoom clusters.
STEP 3 — Classify intent_archetype from the overall navigation pattern and engagement depth.
STEP 4 — Write advisor_nlp_approach using the rep_system pace + one Milton Model pattern + one psych_bias reframe.
STEP 5 — Write spin_question: select the SPIN type from intent_archetype, then craft the exact question referencing the highest-friction content area.
STEP 6 — Write cialdini_lever: map psych_bias to the correct Cialdini principle and write one concrete tactic sentence.
STEP 7 — Write voss_label: identify the highest-friction page/behaviour, name its emotion with "It sounds like…", follow with one "What" or "How" calibrated question.
STEP 8 — Write nba_whatsapp in Hong Kong financial Cantonese with matching sensory predicates and one embedded presupposition.`;

      let aiResult: any = null;
      let usedModel = '';
      let success = false;
      let lastError: any = null;
      let isThinkingModel = false;

      const randomStartIndex = apiKeys.length ? Math.floor(Math.random() * apiKeys.length) : 0;
      const rotationOrder = rotatedKeys(randomStartIndex);

      // ── Try thinking-capable models first ────────────────────────────────
      outer: for (const [i, currentKey] of rotationOrder.entries()) {
        const keyIndex = (randomStartIndex + i) % apiKeys.length;

        for (const modelName of THINKING_MODELS) {
          try {
            const genAI = new GoogleGenerativeAI(currentKey);
            const model = genAI.getGenerativeModel({
              model: modelName,
              generationConfig: {
                thinkingConfig: { thinkingBudget: -1 }, // -1 = dynamic (high thinking)
                responseMimeType: "application/json",
                responseSchema: RESPONSE_SCHEMA as any,
              } as any,
            });

            const apiCall = model.generateContent(systemPrompt + '\n\n' + userPrompt);
            apiCall.catch(() => {}); // avoid unhandled rejection if the timeout wins the race
            const result = await Promise.race([
              apiCall,
              new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 25000))
            ]) as any;

            aiResult = JSON.parse(result.response.text());
            usedModel = modelName;
            isThinkingModel = true;
            success = true;
            console.log(`[GEMINI] Thinking model success: Key ${keyIndex + 1} | ${modelName}`);
            break outer;
          } catch (err) {
            const errMsg = (err as any).message || '';
            console.warn(`[GEMINI WARN] Thinking | Key ${keyIndex + 1} | ${modelName}: ${errMsg.slice(0, 60)}`);
            lastError = err;
          }
        }
      }

      // ── Fallback: standard models, simplified prompt, regex JSON extraction ─
      if (!success) {
        console.log('[GEMINI] Thinking models exhausted. Falling back to standard models...');
        outer2: for (const [i, currentKey] of rotationOrder.entries()) {
          const keyIndex = (randomStartIndex + i) % apiKeys.length;

          for (const modelName of STANDARD_MODELS) {
            try {
              const genAI = new GoogleGenerativeAI(currentKey);
              const model = genAI.getGenerativeModel({ model: modelName });

              const fallbackPrompt = `${systemPrompt}\n\n${userPrompt}\n\nRespond with ONLY a valid JSON object matching this schema: ${JSON.stringify(RESPONSE_SCHEMA)}`;

              const apiCall = model.generateContent(fallbackPrompt);
              apiCall.catch(() => {}); // avoid unhandled rejection if the timeout wins the race
              const result = await Promise.race([
                apiCall,
                new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 15000))
              ]) as any;

              const raw = result.response.text().replace(/^```json|```$/gm, '').trim();
              aiResult = JSON.parse(raw);
              usedModel = modelName;
              isThinkingModel = false;
              success = true;
              console.log(`[GEMINI] Standard fallback success: Key ${keyIndex + 1} | ${modelName}`);
              break outer2;
            } catch (err) {
              const errMsg = (err as any).message || '';
              console.warn(`[GEMINI WARN] Standard | Key ${keyIndex + 1} | ${modelName}: ${errMsg.slice(0, 60)}`);
              lastError = err;
            }
          }
        }
      }

      if (!success || !aiResult) {
        throw lastError || new Error("All models and API keys exhausted.");
      }

      // ── Inject structured JSON into Telegram message ──────────────────────
      const archetype = escapeHTML(aiResult.intent_archetype || '—');
      const bias = escapeHTML(aiResult.psych_bias || '—');
      const repSystem = escapeHTML(aiResult.rep_system || '—');
      const nlpApproach = escapeHTML(aiResult.advisor_nlp_approach || '—');
      const spinQuestion = escapeHTML(aiResult.spin_question || '—');
      const cialdiniLever = escapeHTML(aiResult.cialdini_lever || '—');
      const vossLabel = escapeHTML(aiResult.voss_label || '—');
      const nba = escapeHTML(aiResult.nba_whatsapp || '—');
      const frictionList = (aiResult.friction_points || [])
        .map((f: string) => `• ${escapeHTML(f)}`)
        .join('\n') || '• none detected';
      const modelTag = isThinkingModel ? '🧠 Thinking' : '⚡ Standard';

      const deviceIcon = device_type === 'mobile' ? '📱' : device_type === 'desktop' ? '💻' : '❓';
      const timeLabel = getHkTimeOfDay().label;
      const ctaLine = cta_click_page != null ? `\n🔥 <b>CTA Clicked on Page：</b> ${cta_click_page}` : '';
      const returnVisitLine = isReturnVisit
        ? `\n🔄 <b>RETURN VISIT</b> — Client came back to re-read${mins_since_last_visit != null ? `（上次閱讀 ${formatReturnVisitGap(mins_since_last_visit)} 前）` : ''}`
        : '';

      text = `🎯 <b>【Antigravity 銷售導航】</b>
👤 <b>客戶：</b> ${escapeHTML(client_name)}  📄 <b>報告：</b> ${escapeHTML(rName)}
🆔 <b>會話：</b> <code>${session_id?.slice(0, 8)}</code>  ${modelTag} (<code>${usedModel}</code>)
${deviceIcon} ${escapeHTML(device_type || 'unknown')}  ${timeLabel}  🔁 Returns: ${return_visit_count ?? 0}${returnVisitLine}${ctaLine}

🧠 <b>Intent Archetype：</b> ${archetype}
📊 <b>Z-Score：</b> ${aiResult.z_score ?? zScore}
🔬 <b>Psych Bias：</b> ${bias}
👁 <b>Rep System：</b> ${repSystem}

🔴 <b>Friction Points：</b>
${frictionList}

🎯 <b>NLP Advisor Approach：</b>
${nlpApproach}

❓ <b>SPIN Question：</b>
${spinQuestion}

⚡ <b>Cialdini Lever：</b>
${cialdiniLever}

🎙 <b>Voss Label：</b>
${vossLabel}

💡 <b>NBA WhatsApp 話術：</b>
${nba}${behaviorBlock}`;

    } catch (err) {
      text = `📊 <b>閱讀結算 (基礎)</b>\n\n👤 <b>客戶：</b> ${escapeHTML(client_name)}\n📄 <b>報告：</b> ${escapeHTML(rName)}\n📖 <b>進度：</b> ${maxReachedPage} / ${total_pages || '?'}\n⏱️ <b>歷時：</b> ${total_duration_sec}s\n⚠️ AI 分析失敗: ${escapeHTML((err as any).message)}${behaviorBlock}`;
    }
  } else if (!isDeepRead) {
    text = `📊 <b>閱讀結算 (快速翻閱)</b>\n\n👤 <b>客戶：</b> ${escapeHTML(client_name)}\n📄 <b>報告：</b> ${escapeHTML(rName)}\n📖 <b>進度：</b> ${maxReachedPage} / ${total_pages} (${progressPercent.toFixed(1)}%)\n⏱️ <b>歷時：</b> ${total_duration_sec}s\n💡 提示：客戶僅快速掃描。${behaviorBlock}`;
  } else {
    text = `📊 <b>閱讀結算 (無 AI)</b>\n\n👤 <b>客戶：</b> ${escapeHTML(client_name)}\n📄 <b>報告：</b> ${escapeHTML(rName)}\n📖 <b>頁數：</b> ${maxReachedPage} / ${total_pages || '?'}\n⏱️ <b>長度：</b> ${total_duration_sec}s${behaviorBlock}`;
  }

  // Telegram rejects messages over 4096 chars; the AI-generated fields are
  // unbounded, so truncate defensively. A cut mid-tag is fine — sendTelegram
  // already falls back to a tag-stripped plain resend on parse errors.
  if (text.length > 3900) text = text.slice(0, 3900) + '…';

  // The AI path is already volume-bounded by aiAllowed; gate the cheaper summary
  // sends per IP so forged session_end requests can't spam Telegram.
  if (text && (aiAllowed || allow(`tg:${ip}`, 12, 60_000))) {
    await sendTelegram(text);
  } else if (text) {
    console.warn(`[SESSION-END] Telegram rate-limited for ${ip}`);
  }

  try {
    const validReaderInput =
      device_id !== null &&
      typeof file_id === "string" && file_id.trim() !== "" &&
      typeof client_name === "string" && client_name.trim() !== "" &&
      total_duration_sec >= 10;

    if (validReaderInput) {
      const projectId = process.env.VITE_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID;
      const apiKey = process.env.VITE_FIREBASE_API_KEY || process.env.FIREBASE_API_KEY;
      if (!projectId || !apiKey) {
        console.error("[SESSION-END] Missing Firebase config for second-reader detection");
      } else {
        const readerKey = createHash('sha256').update(`${file_id}|${client_name}`).digest('hex').slice(0, 40);
        const docBase = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
        const docUrl = `${docBase}/readers/${readerKey}`;
        const nowIso = new Date().toISOString();
        const readRes = await fetch(docUrl);

        if (readRes.status === 404) {
          await fetch(`${docUrl}?key=${apiKey}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              fields: {
                deviceIds: { arrayValue: { values: [{ stringValue: device_id }] } },
                updatedAt: { timestampValue: nowIso },
              },
            }),
          }).then(async (writeRes) => {
            if (!writeRes.ok) {
              const detail = await writeRes.text().catch(() => "");
              console.error(`[SESSION-END] Reader create failed (${writeRes.status}): ${detail.slice(0, 200)}`);
            }
          });
        } else if (!readRes.ok) {
          const detail = await readRes.text().catch(() => "");
          console.error(`[SESSION-END] Reader GET failed (${readRes.status}): ${detail.slice(0, 200)}`);
        } else {
          const readerDoc = await readRes.json().catch(() => ({}));
          const rawDevices = readerDoc.fields?.deviceIds?.arrayValue?.values;
          const deviceIds = Array.isArray(rawDevices)
            ? rawDevices.map((v: any) => v?.stringValue).filter((v: any): v is string => typeof v === "string")
            : [];

          if (!deviceIds.includes(device_id)) {
            const nextDeviceIds = [...deviceIds, device_id].slice(-10);
            // Plain GET+PATCH read-modify-write; no transaction. Concurrent
            // sessions may double-alert, acceptable at this volume.
            const updateUrl = `${docUrl}?key=${apiKey}&updateMask.fieldPaths=deviceIds&updateMask.fieldPaths=updatedAt`;
            const updateRes = await fetch(updateUrl, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                fields: {
                  deviceIds: { arrayValue: { values: nextDeviceIds.map((id) => ({ stringValue: id })) } },
                  updatedAt: { timestampValue: nowIso },
                },
              }),
            });

            if (!updateRes.ok) {
              const detail = await updateRes.text().catch(() => "");
              console.error(`[SESSION-END] Reader update failed (${updateRes.status}): ${detail.slice(0, 200)}`);
            } else if (deviceIds.length >= 1) {
              const secondReaderText =
                `👥 <b>偵測到第二位讀者</b>\n\n` +
                `👤 <b>客戶：</b> ${escapeHTML(client_name)}\n` +
                `📄 <b>報告：</b> ${escapeHTML(rName)}\n` +
                `📱 裝置：${escapeHTML(device_type)}（第 ${nextDeviceIds.length} 部裝置）\n` +
                `💡 連結可能已被轉發給其他決策者（配偶／家人）。`;
              if (allow(`tg:${ip}`, 12, 60_000)) {
                await sendTelegram(secondReaderText);
              } else {
                console.warn(`[SESSION-END] Second-reader Telegram rate-limited for ${ip}`);
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.error("[SESSION-END] Second-reader detection failed:", err);
  }

  res.json({ status: "ok" });
});

// Unmatched /api/* requests: clean JSON 404, or 405 (with Allow header) when the
// path exists under a different method. Registered after every /api route so it
// only sees fall-throughs; non-/api paths keep Express's default handling (and
// the SPA/static handlers added below for local runs).
app.use((req, res, next) => {
  if (!req.path.startsWith("/api/")) return next();
  const allowed = new Set<string>();
  for (const layer of (app as any)._router.stack) {
    if (layer.route && layer.regexp?.test(req.path)) {
      Object.keys(layer.route.methods).forEach((m) => allowed.add(m.toUpperCase()));
    }
  }
  allowed.delete("_ALL");
  if (allowed.size > 0) {
    res.set("Allow", [...allowed].join(", "));
    return res.status(405).json({ error: "Method not allowed" });
  }
  res.status(404).json({ error: "Not found" });
});

// For Vercel Serverless Functions
export default app;

// Start Server locally if not running on Vercel
if (!process.env.VERCEL) {
  async function startServer() {
    // Vite middleware for development
    if (process.env.NODE_ENV !== "production") {
      const { createServer: createViteServer } = await import("vite");
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: "spa",
      });
      app.use(vite.middlewares);
    } else {
      // Production static file serving
      app.use(express.static(path.resolve(__dirname, "dist")));
      app.get("*", (req, res) => {
        res.sendFile(path.resolve(__dirname, "dist", "index.html"));
      });
    }

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  }

  startServer();
}
