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

const escapeHTML = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const fromUrlSafeBase64 = (encoded: string): string => {
  let base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  return Buffer.from(base64, 'base64').toString('utf8');
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
  const fallback = 'https://images.unsplash.com/photo-1554224155-8d04cb21cd6c?q=80&w=600&auto=format&fit=crop';
  if (!imageParam?.startsWith('http')) return fallback;
  if (imageParam.includes('meee.com.tw') && !imageParam.includes('i.meee.com.tw')) {
    const replaced = imageParam.replace('meee.com.tw', 'i.meee.com.tw');
    return /\.(png|jpe?g|gif|webp)$/i.test(replaced) ? replaced : replaced + '.png';
  }
  return imageParam;
};

const sendTelegram = async (text: string): Promise<void> => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
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
          body: JSON.stringify({ chat_id: chatId, text: plain }),
        });
      }
    }
  } catch (err) {
    console.error('Telegram notification failed:', err);
  }
};

const getHkTimeOfDay = (): { name: 'morning' | 'afternoon' | 'evening' | 'late night'; label: string } => {
  const h = parseInt(
    new Date().toLocaleString('en-US', { timeZone: 'Asia/Hong_Kong', hour: '2-digit', hour12: false }).slice(0, 2),
    10
  );
  if (h >= 5 && h < 12) return { name: 'morning', label: '☀️ Morning' };
  if (h >= 12 && h < 18) return { name: 'afternoon', label: '🌤 Afternoon' };
  if (h >= 18 && h < 23) return { name: 'evening', label: '🌆 Evening' };
  return { name: 'late night', label: '🌙 Late Night' };
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
      }
    } else {
      console.error('[SHARE] Failed to decode compressed payload');
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

  sendTelegram(
    `🔔 <b>閱讀通知</b>\n\n` +
    `👤 <b>客戶：</b> ${cName}\n` +
    `📄 <b>報告：</b> ${rName} (${file_id})\n` +
    `⏰ <b>時間：</b> 剛剛`
  );

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
  const isCrawler = /WhatsApp|Telegram|facebookexternalhit|Twitterbot|Slackbot|Discordbot|Line|WeChat/i.test(userAgent);

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

    const decoded = decodeLzPayload(q);
    if (decoded) {
      if (decoded.c) cName = decoded.c;
      if (decoded.r) rName = decoded.r;
      if (decoded.i) imageParam = decoded.i;
      if (decoded.d) descParam = decoded.d;
      if (decoded.t) titleParam = decoded.t;
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

    if (!isCrawler) {
      sendTelegram(
        `🔔 <b>閱讀通知 (短連結)</b>\n\n👤 <b>客戶：</b> ${cName}\n📄 <b>報告：</b> ${rName}\n🔗 <b>ID：</b> ${shortId}\n⏰ <b>時間：</b> 剛剛`
      );
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
      const filePath = fromUrlSafeBase64(file_id.slice(2));
      const encodedPath = encodeURIComponent(filePath).replace(/\//g, "%2F");
      const bucket = process.env.VITE_FIREBASE_STORAGE_BUCKET || process.env.FIREBASE_STORAGE_BUCKET || "market-update-56e1c.firebasestorage.app";
      console.log(`[PDF_PROXY] Decoding f_ ID. Path: ${filePath} | Bucket: ${bucket}`);
      blobUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodedPath}?alt=media`;
    } else if (file_id.startsWith('vblob_')) {
      blobUrl = fromUrlSafeBase64(file_id.slice(6));
      console.log(`[PDF_PROXY] vblob_ ID: ${file_id.slice(0, 15)}... | Resolved URL: ${blobUrl.split('?')[0]}...`);
    } else if (file_id.startsWith('r2_')) {
      const r2Key = fromUrlSafeBase64(file_id.slice(3));
      
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
    const pageNote = page != null ? `（停留喺第 ${page} 頁）` : '';
    text = `🔥 <b>高價值意向！</b>\n\n👤 客戶 <b>${client_name}</b> 點擊咗<b>預約顧問</b>按鈕${pageNote}！\n請準備透過 WhatsApp 跟進。`;
  } else if (event === 'heartbeat' && duration_seconds != null && duration_seconds >= 60 && duration_seconds < 90) {
    const pageNote = page != null ? `（目前喺第 ${page} 頁）` : '';
    text = `🟢 <b>正在閱讀中</b>\n\n👤 客戶 <b>${client_name}</b> 已閱讀 <b>${report_name}</b> 超過 1 分鐘${pageNote}。\n建議：準備 WhatsApp，等客戶讀完馬上跟進。`;
  }

  if (text) void sendTelegram(text);

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
app.post("/api/session-end", async (req, res) => {
  const {
    event, session_id, client_name, report_name, file_id,
    total_duration_sec, total_pages, pages_data, navigation_path,
    // Phase 3 deep telemetry
    nav_history, zoom_clusters, scroll_samples, peak_scroll_velocity,
    // Phase 4 enrichment
    cta_click_page, device_type, tab_switch_count
  } = req.body;
  console.log(`🚀 [BACKEND] 分析請求: ${client_name} | Session: ${session_id?.slice(0, 8)}`);

  if (event !== 'session_end') return res.json({ status: "ignored" });

  const maxReachedPage = pages_data && Object.keys(pages_data).length > 0
    ? Math.max(...Object.keys(pages_data).map(Number))
    : 1;

  const progressPercent = total_pages ? (maxReachedPage / total_pages) * 100 : 0;
  const isDeepRead = progressPercent >= 30;
  // Return visit = at least the second session for this file+client combo. Strong buying signal —
  // always trigger AI analysis even if this individual session was short.
  const isReturnVisit = (tab_switch_count ?? 0) >= 2;

  let text = "";

  if (aiEnabled && (isDeepRead || isReturnVisit)) {
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
        const depth = data.maxScrollDepthPct != null ? `${data.maxScrollDepthPct}%` : 'n/a';
        return `Page ${page}: ${totalSec}s total (${activeSec}s active), zoom ${data.maxScale.toFixed(1)}x, scroll depth ${depth}`;
      }).join('\n');

      const pathSummary = navigation_path?.join(' → ') || 'unknown';
      const skimRate = peak_scroll_velocity != null
        ? `${peak_scroll_velocity} px/ms peak`
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
- tab_switch_count >= 2: RETURN VISIT — client came back to re-read = strongest organic buying signal. Elevate intent_archetype toward Deep Diver or Momentum Buyer. cialdini_lever MUST be Consistency ("You've come back to this several times — this clearly matters to you") or Scarcity (cost of further delay).
- tab_switch_count = 0 or 1: single-sitting read = casual evaluation, not yet a return-buyer pattern.
- Time of day: morning/afternoon = work-context reading (often interrupted); evening = personal/family-context reading (higher emotional weight, better follow-up window); late night = high personal motivation but defer outreach until next morning.

NLP REPRESENTATIONAL SYSTEM INFERENCE (from telemetry):
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
- Report: ${report_name}
- Duration: ${total_duration_sec}s
- Pre-calculated Z-Score: ${zScore} (pass this value into the z_score field)
- Navigation path: ${pathSummary}
- Micro-loops detected: ${microLoops.length > 0 ? microLoops.join('; ') : 'none'}
- Top zoom clusters: ${zoomSummary}
- Peak scroll velocity (skim rate): ${skimRate}
- CTA click page (WhatsApp appointment button): ${cta_click_page != null ? `Page ${cta_click_page} — STRONGEST INTEREST SIGNAL` : 'not clicked'}
- Device: ${device_type || 'unknown'}
- Tab switch count (cumulative returns to this report): ${tab_switch_count ?? 0}
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
      const returnVisitLine = isReturnVisit ? `\n🔄 <b>RETURN VISIT</b> — Client came back to re-read` : '';

      text = `🎯 <b>【Antigravity 銷售導航】</b>
👤 <b>客戶：</b> ${escapeHTML(client_name)}  📄 <b>報告：</b> ${escapeHTML(report_name)}
🆔 <b>會話：</b> <code>${session_id?.slice(0, 8)}</code>  ${modelTag} (<code>${usedModel}</code>)
${deviceIcon} ${escapeHTML(device_type || 'unknown')}  ${timeLabel}  🔁 Returns: ${tab_switch_count ?? 0}${returnVisitLine}${ctaLine}

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
${nba}`;

    } catch (err) {
      text = `📊 <b>閱讀結算 (基礎)</b>\n\n👤 <b>客戶：</b> ${escapeHTML(client_name)}\n📄 <b>報告：</b> ${escapeHTML(report_name)}\n📖 <b>進度：</b> ${maxReachedPage} / ${total_pages || '?'}\n⏱️ <b>歷時：</b> ${total_duration_sec}s\n⚠️ AI 分析失敗: ${escapeHTML((err as any).message)}`;
    }
  } else if (!isDeepRead) {
    text = `📊 <b>閱讀結算 (快速翻閱)</b>\n\n👤 <b>客戶：</b> ${escapeHTML(client_name)}\n📄 <b>報告：</b> ${escapeHTML(report_name)}\n📖 <b>進度：</b> ${maxReachedPage} / ${total_pages} (${progressPercent.toFixed(1)}%)\n⏱️ <b>歷時：</b> ${total_duration_sec}s\n💡 提示：客戶僅快速掃描。`;
  } else {
    text = `📊 <b>閱讀結算 (無 AI)</b>\n\n👤 <b>客戶：</b> ${escapeHTML(client_name)}\n📄 <b>報告：</b> ${escapeHTML(report_name)}\n📖 <b>頁數：</b> ${maxReachedPage} / ${total_pages || '?'}\n⏱️ <b>長度：</b> ${total_duration_sec}s`;
  }

  await sendTelegram(text);

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
