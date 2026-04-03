import 'dotenv/config';
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import LZString from 'lz-string';
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const apiKeys = (process.env.GEMINI_API_KEY || "").split(',').map(k => k.trim()).filter(Boolean);
const aiEnabled = apiKeys.length > 0;

// Helper to escape HTML for Telegram
const escapeHTML = (text: string) => {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
};

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

// Middleware to parse JSON
app.use(express.json());

// Startup status check
console.log('--- Server Status ---');
console.log(`Telegram Bot: ${process.env.TELEGRAM_BOT_TOKEN ? '✅ LOADED' : '❌ MISSING'}`);
console.log(`Telegram Chat ID: ${process.env.TELEGRAM_CHAT_ID ? '✅ LOADED' : '❌ MISSING'}`);
console.log(`Firebase Project ID: ${process.env.VITE_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID || '❌ MISSING'}`);
console.log(`Firebase Bucket: ${process.env.VITE_FIREBASE_STORAGE_BUCKET || process.env.FIREBASE_STORAGE_BUCKET || '❌ MISSING'}`);
console.log(`Cloudflare R2: ${process.env.R2_ACCOUNT_ID ? '✅ LOADED' : '❌ MISSING'}`);
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
app.get(["/api/share/:file_id", "/s/:file_id", "/s"], (req, res) => {
  const { file_id } = req.params;
  const { q, client_name, name, report_name, preview_image, c, r, i, d, desc, t, title: tParam } = req.query;

  // Handle shorthand or full names
  let cName = (c || name || client_name || "貴客") as string;
  let rName = (r || report_name || "Document") as string;
  let imageParam = (i || preview_image) as string;
  let descParam = (d || desc) as string;
  let titleParam = (t || tParam) as string;
  let finalFileId = file_id || "";

  // Handle compressed payload if present
  if (q && typeof q === 'string') {
    try {
      const decompressed = LZString.decompressFromEncodedURIComponent(q);
      console.log(`[SHARE] Decompressed payload: ${decompressed?.slice(0, 50)}...`);
      const decoded = JSON.parse(decompressed);
      if (decoded) {
        if (decoded.c) cName = decoded.c;
        if (decoded.r) rName = decoded.r;
        if (decoded.i) imageParam = decoded.i;
        if (decoded.d) descParam = decoded.d;
        if (decoded.t) titleParam = decoded.t;
        if (decoded.f) {
          const isFirebasePath = decoded.f.startsWith('reports/');
          // Standard URL-safe Base64 normalization
          const base64 = Buffer.from(decoded.f, 'utf8').toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
          finalFileId = isFirebasePath ? `f_${base64}` : `vblob_${base64}`;
          console.log(`[SHARE] Resolved file_id: ${finalFileId} from path: ${decoded.f}`);
        }
      }
    } catch (e) {
      console.error("[SHARE] Failed to decode compressed payload:", e);
    }
  }

  // Professional OG Image (Keep file size small for WhatsApp ~ < 300KB)
  let ogImage = "https://images.unsplash.com/photo-1554224155-8d04cb21cd6c?q=80&w=600&auto=format&fit=crop";
  if (imageParam && imageParam.startsWith('http')) {
    ogImage = imageParam;

    // Auto-fix for meee.com.tw (image host) viewer links to direct links
    if (ogImage.includes('meee.com.tw') && !ogImage.includes('i.meee.com.tw')) {
      ogImage = ogImage.replace('meee.com.tw', 'i.meee.com.tw') + '.png';
      console.log(`[OG_IMAGE] Auto-fixed meee link: ${ogImage}`);
    }
  }

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

  // Send Telegram Notification (Fire and Forget)
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    const telegramUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;

    // Telegram HTML Format
    const text = `🔔 <b>閱讀通知</b>\n\n` +
      `👤 <b>客戶：</b> ${cName}\n` +
      `📄 <b>報告：</b> ${rName} (${file_id})\n` +
      `⏰ <b>時間：</b> 剛剛`;

    fetch(telegramUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: text,
        parse_mode: 'HTML'
      })
    })
      .then(r => {
        if (!r.ok) console.error(`Telegram API Error (Share): ${r.status} ${r.statusText}`);
      })
      .catch(err => console.error('Telegram notification failed (Share):', err));
  } else {
    console.log('[TELEGRAM] Skip share notification: Token or Chat ID missing');
  }

  // No changes needed here, cleaned up redundant block.

  const html = `
  <!DOCTYPE html>
  <html lang="zh-HK">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${title}</title>
      <meta property="og:title" content="${title}" />
      <meta property="og:description" content="${description}" />
      <meta property="og:image" content="${ogImage}" />
      <meta property="og:image:alt" content="${title}" />
      <meta property="og:type" content="website" />
      <meta property="og:site_name" content="Antigravity 財富管理" />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:image" content="${ogImage}" />
      
      <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #ffffff; color: #1e293b; }
          .loader { border: 4px solid #f3f3f3; border-top: 4px solid #3498db; border-radius: 50%; width: 30px; height: 30px; animation: spin 1s linear infinite; margin-bottom: 20px; }
          @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
          .container { text-align: center; }
      </style>
      
      <script>
          // Use window.location.origin to ensure absolute path redirect
          const targetUrl = window.location.origin + "${viewerUrl}";
          console.log('[SHARE] Client-side redirecting to:', targetUrl);
          setTimeout(function() {
              window.location.replace(targetUrl);
          }, 500);
      </script>
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
  const isCrawler = /WhatsApp|Telegram|facebookexternalhit|Twitterbot/i.test(userAgent);

  if (!projectId) {
    console.error("Missing Project ID in env");
    return res.status(500).send("伺服器缺少 Firebase Project ID 設定");
  }

  try {
    const docUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/links/${shortId}`;
    console.log(`[SHORT_LINK] Resolving ID: ${shortId} via ${docUrl}`);

    const response = await fetch(docUrl);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[SHORT_LINK] Firestore error (${response.status}) for ID: ${shortId}: ${errorText}`);
      return res.status(404).send(`找不到此連結 (${shortId}) 或連結已失效 (Status: ${response.status})`);
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

    try {
      const decoded = JSON.parse(LZString.decompressFromEncodedURIComponent(q));
      if (decoded) {
        if (decoded.c) cName = decoded.c;
        if (decoded.r) rName = decoded.r;
        if (decoded.i) imageParam = decoded.i;
        if (decoded.d) descParam = decoded.d;
        if (decoded.t) titleParam = decoded.t;
      }
    } catch (e) {
      console.error("解碼失敗:", e);
    }

    let ogImage = "https://images.unsplash.com/photo-1554224155-8d04cb21cd6c?q=80&w=600&auto=format&fit=crop";
    if (imageParam && imageParam.startsWith('http')) {
      ogImage = imageParam;
      if (ogImage.includes('meee.com.tw') && !ogImage.includes('i.meee.com.tw')) {
        ogImage = ogImage.replace('meee.com.tw', 'i.meee.com.tw') + '.png';
      }
    }

    const title = titleParam
      ? (titleParam.includes('：') || titleParam.includes(':') ? titleParam : `${titleParam}：${cName}`)
      : `專案報告：${cName}`;
    const description = descParam || "為您整理的最新市場動態，包含 AI 股分析及日圓走勢預測。";

    // Use relative path for reliability and origin consistency
    const viewerUrl = `/view?q=${encodeURIComponent(q)}`;

    console.log(`[SHORT_LINK] Resolved: ${shortId} -> Redirecting to: ${viewerUrl}`);

    // 只有真實用戶點擊才通知，過濾爬蟲
    if (!isCrawler && process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      const telegramUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
      const text = `🔔 <b>閱讀通知 (短連結)</b>\n\n👤 <b>客戶：</b> ${cName}\n📄 <b>報告：</b> ${rName}\n🔗 <b>ID：</b> ${shortId}\n⏰ <b>時間：</b> 剛剛`;
      fetch(telegramUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' })
      }).catch(err => console.error('TG通知失敗:', err));
    }

    const html = `<!DOCTYPE html>
    <html lang="zh-HK" prefix="og: http://ogp.me/ns#">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${title}</title>
        <meta name="description" content="${description}" />
        <meta property="og:title" content="${title}" />
        <meta property="og:description" content="${description}" />
        <meta property="og:image" content="${ogImage}" />
        <meta property="og:image:secure_url" content="${ogImage}" />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:image:alt" content="${title}" />
        <meta property="og:site_name" content="Antigravity 財富管理" />
        <meta property="og:type" content="website" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:image" content="${ogImage}" />
        
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #ffffff; color: #1e293b; }
            .loader { border: 4px solid #f3f3f3; border-top: 4px solid #3498db; border-radius: 50%; width: 32px; height: 32px; animation: spin 1s linear infinite; margin-bottom: 20px; }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            .container { text-align: center; padding: 20px; }
        </style>
        
        <script>
            const targetUrl = window.location.origin + "${viewerUrl}";
            console.log('[SHORT_LINK] Redirection Target:', targetUrl);
            setTimeout(function() { 
                window.location.replace(targetUrl); 
            }, 500);
        </script>
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

// Cloudflare R2: Generate Pre-signed URL for client-side PUT upload
app.post("/api/r2-presign", async (req, res) => {
  const { fileName, contentType } = req.body;

  if (!fileName || !contentType) {
    return res.status(400).json({ error: "Missing fileName or contentType" });
  }

  try {
    const bucketName = process.env.R2_BUCKET_NAME || "reports";
    // Avoid filename collisions by prefixing with timestamp
    const r2Key = `reports/${Date.now().toString(36)}_${fileName}`;
    
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: r2Key,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    
    res.json({ uploadUrl, r2Key });
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
      // Shorthand Firebase Path: f_<base64(path)>
      const rawBase64 = file_id.slice(2);
      let base64 = rawBase64.replace(/-/g, '+').replace(/_/g, '/');
      while (base64.length % 4) base64 += '=';

      const filePath = Buffer.from(base64, 'base64').toString('utf8');

      // Firebase Storage REST API encoding: slashes must be %2F
      const encodedPath = encodeURIComponent(filePath).replace(/\//g, "%2F");

      const bucket = process.env.VITE_FIREBASE_STORAGE_BUCKET || process.env.FIREBASE_STORAGE_BUCKET || "market-update-56e1c.firebasestorage.app";

      console.log(`[PDF_PROXY] Decoding f_ ID. Path: ${filePath} | Bucket: ${bucket}`);

      blobUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodedPath}?alt=media`;
      console.log(`[PDF_PROXY] Final Blob URL: ${blobUrl}`);
    } else if (file_id.startsWith('vblob_')) {
      // Direct encoded URL (usually includes access token): vblob_<base64(url)>
      let base64 = file_id.slice(6).replace(/-/g, '+').replace(/_/g, '/');
      // Fix missing padding
      while (base64.length % 4) base64 += '=';
      blobUrl = Buffer.from(base64, 'base64').toString('utf8');
      console.log(`[PDF_PROXY] vblob_ ID: ${file_id.slice(0, 15)}... | Resolved URL: ${blobUrl.split('?')[0]}...`);
    } else if (file_id.startsWith('r2_')) {
      // Cloudflare R2 Path: r2_<base64(key)>
      const rawBase64 = file_id.slice(3);
      let base64 = rawBase64.replace(/-/g, '+').replace(/_/g, '/');
      while (base64.length % 4) base64 += '=';
      const r2Key = Buffer.from(base64, 'base64').toString('utf8');
      
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

    // 2. Fetch with browser-like headers to avoid bot filters
    const response = await fetch(blobUrl, {
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
    console.error("[PDF_PROXY_CRITICAL] Exception:", error.message);
    res.status(500).send("A critical error occurred while retrieving the document.");
  }
});

// 新增：Dub.co 短連結轉換 API 端點
app.post("/api/shorten", async (req, res) => {
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


// Tracking Endpoint
app.post("/api/track", async (req, res) => {
  const { event, client_name, report_name, file_id, duration_seconds, page } = req.body;

  console.log(`[TRACK] ${event} | ${client_name} | ${report_name}`);

  // Send Telegram Notification
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    const telegramUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    let text = "";

    if (event === 'open') {
      const totalPages = req.body.total_pages || "未知";
      text = `🔔 <b>報告已開啟</b>\n\n👤 <b>客戶：</b> ${client_name}\n📄 <b>報告：</b> ${report_name}\n📑 <b>總頁數：</b> ${totalPages}\n🔗 <b>ID：</b> ${file_id}`;
    } else if (event === 'security_alert') {
      const { type } = req.body;
      let actionDesc = '截圖報告';
      if (type === 'print_attempt') actionDesc = '列印報告';
      if (type === 'screenshot_detected_win') actionDesc = 'Windows 截圖';
      if (type === 'screenshot_detected_mac') actionDesc = 'Mac 截圖 (Cmd+Shift)';
      if (type === 'potential_screenshot_mac') actionDesc = '潛在 Mac 截圖 (Cmd+Shift)';

      text = `🚨 <b>安全警報：偵測到未經授權的操作</b> 🚨\n\n` +
        `👤 <b>客戶：</b> ${client_name}\n` +
        `📄 <b>報告：</b> ${report_name}\n` +
        `⚠️ <b>行為：</b> 嘗試 ${actionDesc} !!`;
    } else if (event === 'click_appointment') {
      text = `🔥 <b>高價值意向！</b>\n\n👤 客戶 <b>${client_name}</b> 點擊咗<b>預約顧問</b>按鈕！\n請準備透過 WhatsApp 跟進。`;
    }
    // Commenting out heartbeat completely, keeping only milestones for clean alerts
    // else if (event === 'heartbeat' && duration_seconds % 60 === 0 && duration_seconds > 0) { ... }

    if (text) {
      try {
        const r = await fetch(telegramUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: text,
            parse_mode: 'HTML'
          })
        });
        if (!r.ok) console.error(`Telegram API Error: ${r.status} ${r.statusText}`);
      } catch (err) {
        console.error('Telegram notification failed:', err);
      }
    }
  } else {
    console.log('[TELEGRAM] Skip notification: Token or Chat ID missing');
  }

  res.json({ status: "ok" });
});

// THINKING_MODELS support thinkingLevel + native JSON schema (response_schema).
// STANDARD_MODELS are fallbacks that cannot honour those config options.
const THINKING_MODELS = [
  "gemini-3.1-flash-lite-preview",      // RPD: 500, RPM: 15 (Highest Quota)
  "gemini-3-flash-preview",           // RPD: 20, RPM: 5
  "gemini-2.5-flash",                 // RPD: 20, RPM: 5
];
const STANDARD_MODELS = [
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
    nba_whatsapp: {
      type: "string",
      description: "A customised, highly targeted opening message for the advisor to send directly to the client via WhatsApp (Hong Kong financial Cantonese).",
    },
  },
  required: ["intent_archetype", "z_score", "friction_points", "psych_bias", "nba_whatsapp"],
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
app.post("/api/session-end", async (req, res) => {
  const {
    event, session_id, client_name, report_name, file_id,
    total_duration_sec, total_pages, pages_data, navigation_path,
    // Phase 3 deep telemetry
    nav_history, zoom_clusters, scroll_samples, peak_scroll_velocity
  } = req.body;
  console.log(`🚀 [BACKEND] 分析請求: ${client_name} | Session: ${session_id?.slice(0, 8)}`);

  if (event !== 'session_end') return res.json({ status: "ignored" });

  const maxReachedPage = pages_data && Object.keys(pages_data).length > 0
    ? Math.max(...Object.keys(pages_data).map(Number))
    : 1;

  const progressPercent = total_pages ? (maxReachedPage / total_pages) * 100 : 0;
  const isDeepRead = progressPercent >= 30;

  const telegramUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  let text = "";

  if (aiEnabled && isDeepRead) {
    try {
      // ── Pre-calculate Z-score server-side (AI receives it, not calculates it) ──
      // Baseline: empirical mean/σ for a typical advisory session.
      // Replace with real Firestore aggregate when you have enough historical data.
      const MU = 120;   // seconds — historical average session duration
      const SIGMA = 60; // seconds — historical standard deviation
      const zScore = parseFloat(((total_duration_sec - MU) / SIGMA).toFixed(2));

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
        const totalSec = Math.round(data.dwellMs / 1000);
        return `Page ${page}: ${totalSec}s total (${activeSec}s active), zoom ${data.maxScale.toFixed(1)}x`;
      }).join('\n');

      const pathSummary = navigation_path?.join(' → ') || 'unknown';
      const skimRate = peak_scroll_velocity != null
        ? `${peak_scroll_velocity} px/ms peak`
        : 'not captured';

      // ── System prompt: behavioural finance framework, no HTML instructions ──
      const systemPrompt = `You are the Antigravity behavioural intelligence engine for a Hong Kong wealth management firm.
Your role is to perform multi-step analytical inference on raw document telemetry, map it to Kahneman's System 1/System 2 framework, and produce a deterministic JSON Sales Navigation report.
Rules:
- Apply Prospect Theory: loss aversion signals (micro-loops between yield and risk pages) are weighted 2x.
- A zoom cluster on fee/compliance content = System 2 activation (skepticism/verification mode).
- High skim rate on educational pages = experienced investor profile (bypass introductory dialogue).
- Your output MUST strictly follow the provided JSON schema. No additional keys. No markdown.`;

      const userPrompt = `Analyse this client session and return the Sales Navigation JSON.

SESSION DATA:
- Client: ${client_name}
- Report: ${report_name}
- Duration: ${total_duration_sec}s
- Pre-calculated Z-Score: ${zScore} (pass this value into the z_score field)
- Navigation path: ${pathSummary}
- Micro-loops detected: ${microLoops.length > 0 ? microLoops.join('; ') : 'none'}
- Top zoom clusters: ${zoomSummary}
- Peak scroll velocity (skim rate): ${skimRate}
- Per-page behaviour matrix:
${behaviorSummary}

Apply high-level multi-step reasoning. Cross-reference the micro-loops and zoom coordinates with Prospect Theory to determine the dominant psych_bias. Then produce a personalised nba_whatsapp opening message in Hong Kong financial Cantonese (traditional characters).`;

      let aiResult: any = null;
      let usedModel = '';
      let success = false;
      let lastError: any = null;
      let isThinkingModel = false;

      const startIndex = Math.floor(Math.random() * apiKeys.length);

      // ── Try thinking-capable models first ────────────────────────────────
      outer: for (let i = 0; i < apiKeys.length; i++) {
        const keyIndex = (startIndex + i) % apiKeys.length;
        const currentKey = apiKeys[keyIndex];

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

            const result = await Promise.race([
              model.generateContent(systemPrompt + '\n\n' + userPrompt),
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
        outer2: for (let i = 0; i < apiKeys.length; i++) {
          const keyIndex = (startIndex + i) % apiKeys.length;
          const currentKey = apiKeys[keyIndex];

          for (const modelName of STANDARD_MODELS) {
            try {
              const genAI = new GoogleGenerativeAI(currentKey);
              const model = genAI.getGenerativeModel({ model: modelName });

              const fallbackPrompt = `${systemPrompt}\n\n${userPrompt}\n\nRespond with ONLY a valid JSON object matching this schema: ${JSON.stringify(RESPONSE_SCHEMA)}`;

              const result = await Promise.race([
                model.generateContent(fallbackPrompt),
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
      const nba = escapeHTML(aiResult.nba_whatsapp || '—');
      const frictionList = (aiResult.friction_points || [])
        .map((f: string) => `• ${escapeHTML(f)}`)
        .join('\n') || '• none detected';
      const modelTag = isThinkingModel ? '🧠 Thinking' : '⚡ Standard';

      text = `🎯 <b>【Antigravity 銷售導航】</b>
👤 <b>客戶：</b> ${escapeHTML(client_name)}  📄 <b>報告：</b> ${escapeHTML(report_name)}
🆔 <b>會話：</b> <code>${session_id?.slice(0, 8)}</code>  ${modelTag} (<code>${usedModel}</code>)

🧠 <b>Intent Archetype：</b> ${archetype}
📊 <b>Z-Score：</b> ${aiResult.z_score ?? zScore}
🔬 <b>Psych Bias：</b> ${bias}

🔴 <b>Friction Points：</b>
${frictionList}

💡 <b>NBA WhatsApp 話術：</b>
${nba}`;

    } catch (err) {
      text = `📊 <b>閱讀結算 (基礎)</b>\n\n👤 <b>客戶：</b> ${escapeHTML(client_name)}\n📄 <b>報告：</b> ${escapeHTML(report_name)}\n📖 <b>進度：</b> ${maxReachedPage} / ${total_pages || '?'}\n⏱️ <b>歷時：</b> ${total_duration_sec}s\n⚠️ AI 分析失敗: ${escapeHTML((err as any).message)}`;
    }
  } else if (!isDeepRead) {
    text = `📊 <b>閱讀結算 (快速翻閱)</b>\n\n👤 <b>客戶：</b> ${escapeHTML(client_name)}\n📄 <b>報告：</b> ${escapeHTML(report_name)}\n📖 <b>進度：</b> ${maxReachedPage} / ${total_pages} (${progressPercent.toFixed(1)}%)\n⏱️ <b>歷時：</b> ${total_duration_sec}s\n💡 提示：客戶僅快速掃描。`;
  } else {
    text = `📊 <b>閱讀結算 (無 AI)</b>\n\n👤 <b>客戶：</b> ${escapeHTML(client_name)}\n📄 <b>報告：</b> ${escapeHTML(report_name)}\n📖 <b>頁數：</b> ${maxReachedPage} / ${total_pages || '?'}\n⏱️ <b>長度：</b> ${total_duration_sec}s`;
  }

  // Send to Telegram
  try {
    const r = await fetch(telegramUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: text, parse_mode: 'HTML' })
    });
    if (!r.ok) {
      const errorDetail = await r.json();
      console.error(`[TELEGRAM ERROR] Status: ${r.status}, Detail: ${JSON.stringify(errorDetail)}`);

      // Fallback to plain text if HTML parsing failed
      if (errorDetail.description?.includes('can\'t parse entities')) {
        console.log('[TELEGRAM] Retrying with plain text fallback...');
        await fetch(telegramUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: text.replace(/<[^>]*>/g, '') // Strip all tags
          })
        });
      }
    }
  } catch (err) {
    console.error('Telegram notification failed:', err);
  }

  res.json({ status: "ok" });
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
