import 'dotenv/config';
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import LZString from 'lz-string';

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
console.log('------------------------------');

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
      const decoded = JSON.parse(LZString.decompressFromEncodedURIComponent(q));
      if (decoded) {
        if (decoded.c) cName = decoded.c;
        if (decoded.r) rName = decoded.r;
        if (decoded.i) imageParam = decoded.i;
        if (decoded.d) descParam = decoded.d;
        if (decoded.t) titleParam = decoded.t;
        if (decoded.f) {
          const isFirebasePath = decoded.f.startsWith('reports/');
          // Base64 encode the string (path or full URL)
          const base64 = Buffer.from(decoded.f).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
          finalFileId = isFirebasePath ? `f_${base64}` : `vblob_${base64}`;
        }
      }
    } catch (e) {
      console.error("Failed to decode compressed payload:", e);
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
  // If we have 'q', we pass 'q' to viewer, otherwise we pass file_id and params
  const viewerUrl = q
    ? `${process.env.APP_URL || ''}/view?q=${encodeURIComponent(q as string)}`
    : `${process.env.APP_URL || ''}/view/${finalFileId}?c=${encodeURIComponent(cName)}&r=${encodeURIComponent(rName)}`;

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
          // 延遲 0.8 秒跳轉，確保 OG Tag 被抓取，也給客戶一點「載入中」的專業感
          setTimeout(function() {
              window.location.href = "${viewerUrl}";
          }, 800);
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
app.get("/l/:shortId", async (req, res) => {
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
    const response = await fetch(docUrl);

    if (!response.ok) {
      console.error(`Firestore fetch failed (${response.status}) for ID: ${shortId}`);
      return res.status(404).send("找不到此連結或連結已失效");
    }

    const data = await response.json();
    const q = data.fields?.q?.stringValue;

    if (!q) return res.status(404).send("連結內容損毀");

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
    const appBaseUrl = process.env.APP_URL || `https://${req.headers.host}`;
    const viewerUrl = `${appBaseUrl}/view?q=${encodeURIComponent(q)}`;

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
        <meta property="og:url" content="${appBaseUrl}/l/${shortId}" />
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
            // 如果 3 秒後還沒跳轉，手動強制跳轉
            setTimeout(function() { window.location.replace("${viewerUrl}"); }, 3000);
            // 正常跳轉
            setTimeout(function() { window.location.href = "${viewerUrl}"; }, 800);
        </script>
    </head>
    <body onload="setTimeout(function(){ window.location.href='${viewerUrl}'; }, 1000)">
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

// Proxy Endpoint for PDF
app.get("/api/pdf/:file_id", async (req, res) => {
  const { file_id } = req.params;

  // Handle Firebase/Blob proxy
  if (file_id.startsWith('vblob_') || file_id.startsWith('f_')) {
    try {
      let blobUrl = "";
      if (file_id.startsWith('f_')) {
        // Decompress shorter Firebase ID (Expected path example: "reports/file.pdf")
        let base64 = file_id.slice(2).replace(/-/g, '+').replace(/_/g, '/');
        // Add back padding if missing
        while (base64.length % 4) base64 += '=';

        const path = Buffer.from(base64, 'base64').toString('utf8');
        const bucket = process.env.VITE_FIREBASE_STORAGE_BUCKET || "market-update-56e1c.firebasestorage.app";
        console.log(`[PROXY_F] Using bucket: ${bucket}`);

        // Reconstruct encoded path (Firebase expects / to be %2F)
        const encodedPath = encodeURIComponent(path);
        blobUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodedPath}?alt=media`;
        console.log(`[PROXY_F] Path: ${path} | Final URL: ${blobUrl}`);
      } else {
        // Old full URL Base64
        let base64 = file_id.slice(6).replace(/-/g, '+').replace(/_/g, '/');
        while (base64.length % 4) base64 += '=';
        blobUrl = Buffer.from(base64, 'base64').toString('utf8');
        console.log(`[PROXY_V] URL: ${blobUrl}`);
      }

      console.log(`[PROXY] Fetching: ${blobUrl}`);
      const response = await fetch(blobUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Referer': 'https://firebasestorage.googleapis.com/'
        }
      });
      if (!response.ok) throw new Error(`Firebase storage fetch failed: ${response.status} ${response.statusText}`);

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'inline; filename="report.pdf"');

      // Use streaming to mitigate Vercel 10s timeout
      if (response.body) {
        // @ts-ignore
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
      } else {
        const arrayBuffer = await response.arrayBuffer();
        res.send(Buffer.from(arrayBuffer));
      }
      return;
    } catch (error) {
      console.error("Vblob Proxy Error:", error);
      res.status(404).send("Document not found");
      return;
    }
  }

  const driveUrl = `https://drive.google.com/uc?export=download&id=${file_id}`;

  try {
    const response = await fetch(driveUrl);

    if (!response.ok) {
      console.error(`[PDF PROXY] Failed to fetch from Drive. Status: ${response.status} ${response.statusText}`);
      throw new Error(`Failed to fetch PDF: ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type");
    console.log(`[PDF PROXY] Fetch success. Content-Type: ${contentType}`);

    if (contentType && contentType.includes("text/html")) {
      console.error("[PDF PROXY] Received HTML instead of PDF. Likely a permission issue or virus scan warning.");
      throw new Error("Google Drive returned HTML instead of PDF. Check file permissions.");
    }

    if (req.query.large === 'true' || (file_id && file_id.length > 20 && !req.query.large)) {
      // Direct redirect for large files to avoid timeout
      return res.redirect(driveUrl);
    }

    // Forward headers
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="document.pdf"`);

    // Stream the body to prevent 10s timeout on Vercel
    if (response.body) {
      // @ts-ignore
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value); // Stream chunks to bypass 10s timeout
      }
      res.end();
    } else {
      const arrayBuffer = await response.arrayBuffer();
      res.send(Buffer.from(arrayBuffer));
    }
  } catch (error) {
    console.error("PDF Proxy Error:", error);
    res.status(500).send("Error loading document");
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

// AI-Powered Session Analysis Endpoint
app.post("/api/session-end", async (req, res) => {
  const { event, session_id, client_name, report_name, file_id, total_duration_sec, total_pages, pages_data, navigation_path } = req.body;
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
      const behaviorSummary = Object.entries(pages_data || {}).map(([page, data]: [string, any]) => {
        const activeSec = Math.round((data.activeDwellMs || 0) / 1000);
        const totalSec = Math.round(data.dwellMs / 1000);
        return `第 ${page} 頁: 總預估 ${totalSec}s (主動交互 ${activeSec}s), 縮放 ${data.maxScale.toFixed(1)}x`;
      }).join('\n');

      const pathSummary = navigation_path?.join(' -> ') || '未知';

      const prompt = `你是金融科技系統「Antigravity」的高階行為財務學分析引擎。
你的任務是解析來自 Viewer.tsx 的邊緣設備數據（Edge Metrics），並結合 Deep Search 市場邏輯，為理財顧問提供一份「客戶心理特徵與銷售導航報告」。

📥 本次會話輸入數據：
1. 會話 ID：${session_id}
2. 客戶姓名：${client_name}
3. 報告名稱：${report_name}
4. 閱讀總歷時：${total_duration_sec} 秒
5. 閱讀路徑：${pathSummary}
6. 逐頁行為矩陣（已過濾閒置時長）：
${behaviorSummary}

🧠 數據清洗與診斷指令：
1. 【偵測閒置 (Idle Bloat)】：
   - 關注「主動交互時間」而非「總停留時間」。若主動交互時間極低，判定為「掛機」。
2. 【區分興趣與分心】：
   - 真正的「深鑽 (Deep Dive)」標誌：主動交互時間長 + >1.2x 的縮放行為 + 出現「回看」路徑。

🧠 分析指令：請從以下維度深度解碼，嚴格遵循 HTML 格式輸出（使用 <b> 標籤，不含 Markdown）：

1. 🔍 閱讀模式與行為診斷：
   - 診斷模式：線性閱讀 (1->2->3)、跳躍搜索 (1->5->8)、反覆糾結 (1->2->3->2->3)。
   - 標記心理偏誤：如「多選障礙」或「損失規避」。

2. 📊 閱讀配速與確定性分析：
   - 透過「主動交互」計算其真實心流情況。

3. 📊 量化指標 (Quant Impact)：
   - Z-Score：行為異常值。 情緒分：心理喚醒度。 衝擊度：組合影響。

4. 💡 銷售導航 (NBA)：
   - 針對「回看」或「深鑽」頁面，提供一段 WhatsApp 破冰話術（香港金融術語）。

輸出格式：
🧠 <b>行為心理診斷：</b>
- <b>標籤：</b> [ Emoji + 心理標籤 ]
- <b>意圖解碼：</b> (描述客戶糾結或感興趣的熱點)

🔬 <b>交互體徵：</b>
- <b>物理訊號：</b> (縮放、主動交互佔比、路徑特徵)
- <b>異常檢測：</b> (閒置、快速掠過或重點糾結)

📊 <b>市場研判：</b>
- <b>Z-Score：</b> [值] | <b>情緒分：</b> [值] | <b>衝擊度：</b> [值]/100
- <b>焦點：</b> (結合報告主題)

💡 <b>NBA 破冰話術：</b>
(提供一段專業文字)`;

      let aiInsights = '';
      let success = false;
      let lastError: any = null;

      const modelsToTry = [
        "gemini-3.1-flash-lite-preview",
        "gemini-2.5-flash",
        "gemini-2.5-flash-lite",
        "gemini-2.0-flash-lite",
        "gemini-2.0-flash",
        "gemini-1.5-flash"
      ];

      // Rotate through all available keys until one succeeds
      const startIndex = Math.floor(Math.random() * apiKeys.length);
      for (let i = 0; i < apiKeys.length; i++) {
        const keyIndex = (startIndex + i) % apiKeys.length;
        const currentKey = apiKeys[keyIndex];

        // Inside each key, try different models
        for (const modelName of modelsToTry) {
          try {
            const genAI = new GoogleGenerativeAI(currentKey);
            const model = genAI.getGenerativeModel({ model: modelName });

            // Set a short timeout for the AI call to fail fast and move to next model/key
            const result = await Promise.race([
              model.generateContent(prompt),
              new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 15000))
            ]) as any;

            aiInsights = result.response.text() || '無法分析。';
            success = true;
            console.log(`[GEMINI] Key ${keyIndex + 1} | Model ${modelName} success.`);
            break;
          } catch (err) {
            const errMsg = (err as any).message || '';
            console.warn(`[GEMINI WARN] Key ${keyIndex + 1} | Model ${modelName} failed: ${errMsg.slice(0, 50)}...`);
            lastError = err;
            // If it's a model mismatch or quota, the inner loop continues to next model
          }
        }
        if (success) break;
      }

      if (!success) {
        throw lastError || new Error("All API keys exhausted or failed.");
      }

      let rawAiInsights = aiInsights.replace(/^```(html)?|```$/gm, '').trim();
      let safeAiInsights = escapeHTML(rawAiInsights);
      safeAiInsights = safeAiInsights.replace(/&lt;b&gt;(.*?)&lt;\/b&gt;/g, '<b>$1</b>');
      safeAiInsights = safeAiInsights.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');

      text = `🎯 <b>【Antigravity 銷售導航】</b>\n\n👤 <b>客戶：</b> ${client_name}\n📄 <b>報告：</b> ${report_name}\n🆔 <b>會話：</b> <code>${session_id?.slice(0, 8)}</code>\n\n${safeAiInsights}`;
    } catch (err) {
      text = `📊 <b>閱讀結算 (基礎)</b>\n\n👤 <b>客戶：</b> ${client_name}\n📄 <b>報告：</b> ${report_name}\n📖 <b>進度：</b> ${maxReachedPage} / ${total_pages || '?'}\n⏱️ <b>歷時：</b> ${total_duration_sec}s\n⚠️ 分析失敗: ${(err as any).message}`;
    }
  } else if (!isDeepRead) {
    text = `📊 <b>閱讀結算 (快速翻閱)</b>\n\n👤 <b>客戶：</b> ${client_name}\n📄 <b>報告：</b> ${report_name}\n📖 <b>進度：</b> ${maxReachedPage} / ${total_pages} (${progressPercent.toFixed(1)}%)\n⏱️ <b>歷時：</b> ${total_duration_sec}s\n💡 提示：客戶僅快速掃描。`;
  } else {
    text = `📊 <b>閱讀結算 (無 AI)</b>\n\n👤 <b>客戶：</b> ${client_name}\n📄 <b>報告：</b> ${report_name}\n📖 <b>頁數：</b> ${maxReachedPage} / ${total_pages || '?'}\n⏱️ <b>長度：</b> ${total_duration_sec}s`;
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
