import 'dotenv/config';
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

// Middleware to parse JSON
app.use(express.json());

// Startup status check
console.log('--- Wealth OS Server Status ---');
console.log(`Telegram Bot: ${process.env.TELEGRAM_BOT_TOKEN ? '✅ LOADED' : '❌ MISSING'}`);
console.log(`Telegram Chat ID: ${process.env.TELEGRAM_CHAT_ID ? '✅ LOADED' : '❌ MISSING'}`);
console.log('------------------------------');

// API Route for the Link Preview
app.get("/api/share/:file_id", (req, res) => {
  const { file_id } = req.params;
  const { client_name, name, report_name, preview_image } = req.query;

  // Default values
  // Support 'name' as alias for 'client_name' from the snippet
  const cName = (typeof name === 'string' && name) ? name :
    (typeof client_name === 'string' && client_name) ? client_name : "貴客";
  const rName = typeof report_name === 'string' && report_name ? report_name : "Document";

  // Professional OG Image (Keep file size small for WhatsApp ~ < 300KB)
  let ogImage = "https://images.unsplash.com/photo-1554224155-8d04cb21cd6c?q=80&w=600&auto=format&fit=crop";
  if (typeof preview_image === 'string' && preview_image.startsWith('http')) {
    ogImage = preview_image;
  }

  // Wealth OS Branding
  const title = `📈 專屬市場簡報：${cName}`;
  const description = "Wealth OS 為您整理的最新市場動態，包含 AI 股分析及日圓走勢預測。";

  // Target URL: Points to our internal Viewer to maintain tracking capabilities
  const viewerUrl = `${process.env.APP_URL || ''}/view/${file_id}?client_name=${encodeURIComponent(cName)}&report_name=${encodeURIComponent(rName)}`;

  // Send Telegram Notification (Fire and Forget)
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    const telegramUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;

    // Wealth OS HTML Format
    const text = `🔔 <b>Wealth OS 閱讀通知</b>\n\n` +
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

  // Handle Firebase/Blob proxy - Forced Proxy Mode to bypass CORS
  if (file_id.startsWith('vblob_')) {
    try {
      const base64 = file_id.slice(6).replace(/-/g, '+').replace(/_/g, '/');
      const blobUrl = Buffer.from(base64, 'base64').toString('utf8');

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
app.post("/api/track", (req, res) => {
  const { event, client_name, report_name, file_id, duration_seconds, page } = req.body;

  console.log(`[TRACK] ${event} | ${client_name} | ${report_name}`);

  // Send Telegram Notification
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    const telegramUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    let text = "";

    if (event === 'open') {
      const totalPages = req.body.total_pages || "未知";
      text = `🔔 <b>報告已開啟</b>\n\n👤 <b>客戶：</b> ${client_name}\n📄 <b>報告：</b> ${report_name}\n📑 <b>總頁數：</b> ${totalPages}\n🔗 <b>ID：</b> ${file_id}`;
    } else if (event === 'heartbeat' && duration_seconds % 60 === 0 && duration_seconds > 0) {
      const currentPage = req.body.current_page || 1;
      const totalPages = req.body.total_pages || 1;
      const progress = Math.round((currentPage / totalPages) * 100);

      text = `⏱ <b>正在閱讀中...</b>\n\n👤 <b>客戶：</b> ${client_name}\n📄 <b>報告：</b> ${report_name}\n⏳ <b>累計時間：</b> ${duration_seconds / 60} 分鐘\n📊 <b>目前進度：</b> 第 ${currentPage} 頁 (${progress}%)`;
    } else if (event === 'page_view') {
      // Optional: Notify on every page turn (can be spammy, maybe just log)
      // text = `📄 *翻頁*\n\n👤 客戶：${client_name}\n📍 第 ${page} 頁`;
    }

    if (text) {
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
          if (!r.ok) console.error(`Telegram API Error: ${r.status} ${r.statusText}`);
        })
        .catch(err => console.error('Telegram notification failed:', err));
    }
  } else {
    console.log('[TELEGRAM] Skip notification: Token or Chat ID missing');
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
