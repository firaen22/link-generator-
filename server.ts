import 'dotenv/config';
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import Database from 'better-sqlite3';

const db = new Database('analytics.db');

// 初始化表格
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_name TEXT,
    report_name TEXT,
    file_id TEXT,
    duration_sec INTEGER,
    total_pages INTEGER,
    max_page INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

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
app.get(["/api/share/:file_id", "/s/:file_id"], (req, res) => {
  const { file_id } = req.params;
  const { client_name, name, report_name, preview_image, c, r, i, d, desc, t, title: tParam } = req.query;

  // Handle shorthand or full names
  const cName = (c || name || client_name || "貴客") as string;
  const rName = (r || report_name || "Document") as string;
  const imageParam = (i || preview_image) as string;
  const descParam = (d || desc) as string;
  const titleParam = (t || tParam) as string;

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
  // Pass shortened params to viewer as well
  const viewerUrl = `${process.env.APP_URL || ''}/view/${file_id}?c=${encodeURIComponent(cName)}&r=${encodeURIComponent(rName)}`;

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
      <meta property="og:type" content="website" />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:image" content="${ogImage}" />
      
      <style>
          body { font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f9f9f9; color: #333; }
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

// Proxy Endpoint for PDF (Streams from Google Drive or redirects to Vercel Blob)
app.get("/api/pdf/:file_id", async (req, res) => {
  const { file_id } = req.params;

  // Handle Firebase/Blob proxy
  if (file_id.startsWith('vblob_') || file_id.startsWith('f_')) {
    try {
      let blobUrl = "";
      if (file_id.startsWith('f_')) {
        // Decompress shorter Firebase ID
        const bucketPrefix = "https://firebasestorage.googleapis.com/v0/b/market-update-56e1c.firebasestorage.app/o/";
        const base64 = file_id.slice(2).replace(/-/g, '+').replace(/_/g, '/');
        const path = Buffer.from(base64, 'base64').toString('utf8');
        blobUrl = bucketPrefix + path;
      } else {
        // Old full URL Base64
        const base64 = file_id.slice(6).replace(/-/g, '+').replace(/_/g, '/');
        blobUrl = Buffer.from(base64, 'base64').toString('utf8');
      }

      console.log(`[VBLOB PROXY] Fetching: ${blobUrl}`);
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
  const { event, client_name, report_name, file_id, total_duration_sec, total_pages, pages_data } = req.body;
  console.log(`🚀 [BACKEND] 接收到分析請求: ${client_name} | ${report_name} (${total_duration_sec}s)`);

  if (event !== 'session_end') return res.json({ status: "ignored" });

  console.log(`[SESSION END] ${client_name} | ${report_name} | ${total_duration_sec}s | Pages: ${total_pages}`);

  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    return res.json({ status: "skipped" });
  }

  const maxReachedPage = pages_data && Object.keys(pages_data).length > 0
    ? Math.max(...Object.keys(pages_data).map(Number))
    : 1;

  // 儲存到數據庫
  try {
    const stmt = db.prepare('INSERT INTO sessions (client_name, report_name, file_id, duration_sec, total_pages, max_page) VALUES (?, ?, ?, ?, ?, ?)');
    stmt.run(client_name, report_name, file_id, total_duration_sec, total_pages, maxReachedPage);
  } catch (dbErr) {
    console.error('[DB ERROR] Failed to save session:', dbErr);
  }

  const progressPercent = total_pages ? (maxReachedPage / total_pages) * 100 : 0;
  const isDeepRead = progressPercent >= 50;

  console.log(`[SESSION END] ${client_name} | Progress: ${maxReachedPage}/${total_pages} (${progressPercent.toFixed(1)}%) | AI Triggered: ${isDeepRead}`);

  const telegramUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  let text = "";

  if (aiEnabled && isDeepRead) {
    try {
      // Structure the data for LLM
      const behaviorSummary = Object.entries(pages_data || {}).map(([page, data]: [string, any]) => {
        return `第 ${page} 頁: 停留 ${Math.round(data.dwellMs / 1000)} 秒, 最大縮放 ${data.maxScale.toFixed(1)}x`;
      }).join('\n');

      const prompt = `你是金融科技系統「Antigravity」的高階行為財務學分析引擎。
你的任務是解析來自 Viewer.tsx 的邊緣設備數據（Edge Metrics），並結合 Deep Search 市場邏輯，為理財顧問提供一份「客戶心理特徵與銷售導航報告」。

📥 本次會話輸入數據：
1. 客戶姓名：${client_name}
2. 報告名稱：${report_name}
3. 閱讀總歷時：${total_duration_sec} 秒
4. 閱讀進度：讀到第 ${maxReachedPage} / ${total_pages || '?'} 頁
5. 逐頁行為矩陣（Page-Level Biometrics）：
${behaviorSummary}

🧠 數據清洗與診斷指令：
1. 【偵測閒置 (Idle Bloat)】：
   - 若某頁停留時間超過 180 秒，但「最大縮放 (maxScale)」精確等於 1.0x，判定為「離屏閒置」而非「深度閱讀」。
   - 若最後一頁的停留時間剛好接近系統冷卻閾值，請在報告中標記為「讀者已離開」。

2. 【區分興趣與分心】：
   - 真正的「深鑽 (Deep Dive)」必須伴隨 >1.2x 的縮放行為。
   - 只有長時間停留且有縮放的頁面，才能被解碼為「高價值銷售意圖」。

🧠 分析指令：請從以下維度進行深度解碼，並嚴格遵循 HTML 格式輸出（使用 <b> 標籤，不含 Markdown）：

1. 🔍 閱讀模式與行為診斷：
   - 如果某頁停留時間極長且 maxScale > 1.5x：判定為「深鑽表格數據」。分析其是否在比對利息、配息或下行保護條款。
   - 如果出現「滑動急煞」或「重覆縮放」：判定為「挫折迴圈 (Frustration Loop)」，顯示客戶對該處數據感到焦慮或難以理解。
   - 標記心理偏誤：如「損失規避」（對負面數據停留久）或「定錨效應」（反覆對比歷史績效）。

2. 📊 閱讀配速與確定性分析：
   - 計算平均每頁配速。若速度遠超 240 WPM，標記為「掠奪式閱讀/無耐心」；若穩定且緩慢，標記為「高確定性心流」。
   - 預估剩餘閱讀抗拒感：分析客戶是否因篇幅過長而產生「認知疲勞」。

3. 📊 量化指標 (Quant Impact)：
   - Z-Score：行為異常值（與標準閱讀曲線的偏離度）。
   - 情緒分：基於縮放強度與停留時間推算的心理喚醒度。
   - 衝擊度：該章節內容對其資產組合的潛在影響係數。

4. 💡 Speed Delivery 銷售導航 (NBA)：
   - 針對偵測到的「行為熱點」提供一段 WhatsApp 破冰話術。
   - 必須使用香港金融術語（如：理專、保費融資、派息、K線、美股）。

輸出格式要求：
直接輸出以下四個區塊，嚴格禁止任何廢話或開場白：

🧠 <b>行為心理診斷：</b>
(如果偵測到閒置，請在此處加入：⚠️ 注意：偵測到尾端閒置行為，已自動過濾無效時長。)
- <b>標籤：</b> [ Emoji + 心理偏誤標籤 ]
- <b>意圖解碼：</b> (描述客戶在特定頁面的數據糾結或興趣點)

🔬 <b>微觀體徵與導航狀態：</b>
- <b>物理訊號：</b> (描述縮放強度、表格停留、滑動節奏等指標)
- <b>建議優化：</b> (如：建議下次開啟 Liquid Mode 或簡化此章節卡片化)

📊 <b>量化衝擊與市場研判：</b>
- <b>Z-Score：</b> [數值] | <b>情緒分：</b> [數值] | <b>衝擊度：</b> [數值]/100
- <b>市場焦點：</b> (結合報告主題，給出一個當下最能擊中其痛點的市場動態)

💡 <b>Next-Best-Action 破冰話術：</b>
(提供一段極具專業感且針對其「糾結點」的破冰文字，可直接複製發送)`;

      // Select a random API key for simple load balancing
      const randomKey = apiKeys[Math.floor(Math.random() * apiKeys.length)];
      const genAI = new GoogleGenerativeAI(randomKey);

      const modelsToTry = [
        "gemini-2.0-flash",
        "gemini-1.5-flash",
        "gemini-flash-latest"
      ];

      let aiInsights = '';
      let success = false;
      let lastError = null;

      for (const modelName of modelsToTry) {
        try {
          console.log(`[GEMINI] Trying model: ${modelName}`);
          const model = genAI.getGenerativeModel({
            model: modelName,
            safetySettings: [
              {
                category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
                threshold: HarmBlockThreshold.BLOCK_NONE,
              },
              {
                category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
                threshold: HarmBlockThreshold.BLOCK_NONE,
              },
              {
                category: HarmCategory.HARM_CATEGORY_HARASSMENT,
                threshold: HarmBlockThreshold.BLOCK_NONE,
              },
              {
                category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
                threshold: HarmBlockThreshold.BLOCK_NONE,
              },
            ]
          });

          const result = await model.generateContent(prompt);
          const response = await result.response;
          aiInsights = response.text() || '無法分析該次行為。';
          success = true;
          console.log(`[GEMINI] Model ${modelName} succeeded.`);
          break; // Stop trying if successful
        } catch (err) {
          console.warn(`[GEMINI WARN] Model ${modelName} failed:`, (err as any).message);
          lastError = err;
        }
      }

      if (!success) {
        throw new Error(`All models failed. Last error: ${(lastError as any)?.message}`);
      }

      // Clean response text
      let rawAiInsights = aiInsights.replace(/^```(html)?|```$/gm, '').trim();

      // Escape for Telegram HTML parse mode, then restore <b> tags
      let safeAiInsights = escapeHTML(rawAiInsights);
      safeAiInsights = safeAiInsights.replace(/&lt;b&gt;(.*?)&lt;\/b&gt;/g, '<b>$1</b>');
      safeAiInsights = safeAiInsights.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');

      text = `🎯 <b>【Antigravity 實時偵測 - 銷售機遇導航】</b>\n\n` +
        `👤 <b>客戶：</b> ${client_name}\n` +
        `📄 <b>觸發場景：</b> 正在閱讀《${report_name}》\n` +
        `📖 <b>閱讀進度：</b> 讀到第 ${maxReachedPage} / ${total_pages || '?'} 頁\n\n` +
        safeAiInsights;

    } catch (err) {
      console.error("[GEMINI ERROR]", err);
      text = `📊 <b>閱讀結算 (無 AI 分析)</b>\n\n👤 <b>客戶：</b> ${client_name}\n📄 <b>報告：</b> ${report_name}\n📖 <b>閱讀進度：</b> 讀到第 ${maxReachedPage} / ${total_pages || '?'} 頁\n⏱️ <b>總歷時：</b> ${total_duration_sec} 秒\n⚠️ 原因: ${(err as any).message}`;
    }
  } else if (!isDeepRead) {
    // Progress-based skip
    text = `📊 <b>閱讀結算 (未讀過半，跳過 AI)</b>\n\n👤 <b>客戶：</b> ${client_name}\n📄 <b>報告：</b> ${report_name}\n📖 <b>閱讀進度：</b> 讀到第 ${maxReachedPage} / ${total_pages} 頁 (${progressPercent.toFixed(1)}%)\n⏱️ <b>總歷時：</b> ${total_duration_sec} 秒\n💡 <i>提示：讀者翻閱進度較快，建議過一陣子再視情況提供更深度的解釋。</i>`;
  } else {
    // Basic fallback if no API key is provided
    text = `📊 <b>閱讀結算 (未設定 AI Key)</b>\n\n👤 <b>客戶：</b> ${client_name}\n📄 <b>報告：</b> ${report_name}\n📖 <b>閱讀進度：</b> 讀到第 ${maxReachedPage} / ${total_pages || '?'} 頁\n⏱️ <b>總歷時：</b> ${total_duration_sec} 秒`;
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

// 新增 Dashboard 數據 API
app.get("/api/dashboard-stats", (req, res) => {
  try {
    const stats = {
      total_views: db.prepare('SELECT COUNT(*) as count FROM sessions').get().count,
      avg_duration: db.prepare('SELECT AVG(duration_sec) as avg FROM sessions').get().avg || 0,
      recent_sessions: db.prepare('SELECT * FROM sessions ORDER BY timestamp DESC LIMIT 10').all()
    };
    res.json(stats);
  } catch (err) {
    console.error('[DB ERROR] Stats query failed:', err);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
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
