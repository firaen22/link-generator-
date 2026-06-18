/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef } from 'react';
import { Copy, Check, Share2, UploadCloud, MessageCircle, Loader2, ImagePlus, Sparkles } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// ── Types ────────────────────────────────────────────────────────────────────
interface GeneratedClient {
  name: string;
  shortId: string;
  shortLink: string;
  copied: boolean;
}

// ── Client-side image compression ──────────────────────────────────────────────
// WhatsApp/Telegram drop preview images over ~300KB, so compress to JPEG in the
// browser before upload. Scales down to a sensible OG width, then steps quality
// (and, if needed, dimensions) down until the blob fits comfortably under cap.
async function compressImageToJpeg(file: File, maxBytes = 290 * 1024): Promise<Blob> {
  const dataUrl: string = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(new Error('讀取圖片失敗'));
    fr.readAsDataURL(file);
  });

  const img: HTMLImageElement = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('圖片格式無法解析'));
    i.src = dataUrl;
  });

  const MAX_DIM = 1200; // ideal OG width; bigger gains nothing for a preview card
  let baseW = img.width;
  let baseH = img.height;
  if (Math.max(baseW, baseH) > MAX_DIM) {
    const scale = MAX_DIM / Math.max(baseW, baseH);
    baseW = Math.round(baseW * scale);
    baseH = Math.round(baseH * scale);
  }

  const encode = (w: number, h: number, q: number): Promise<Blob> => {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return Promise.reject(new Error('瀏覽器不支援圖片壓縮'));
    // Flatten transparency onto white — JPEG has no alpha channel.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return new Promise((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('壓縮失敗'))),
        'image/jpeg',
        q
      )
    );
  };

  // Try quality first at full size, then progressively shrink dimensions.
  for (const dimScale of [1, 0.85, 0.7, 0.55, 0.4]) {
    const w = Math.max(1, Math.round(baseW * dimScale));
    const h = Math.max(1, Math.round(baseH * dimScale));
    for (const q of [0.85, 0.75, 0.65, 0.55, 0.45]) {
      const blob = await encode(w, h, q);
      if (blob.size <= maxBytes) return blob;
    }
  }
  // Last resort — smallest attempt, return whatever we got.
  return encode(Math.max(1, Math.round(baseW * 0.4)), Math.max(1, Math.round(baseH * 0.4)), 0.4);
}

export default function App() {
  // Bulk client list (one name per line) replaces single clientName input
  const [clientList, setClientList] = useState('');
  const [reportName, setReportName] = useState('');
  const [previewImage, setPreviewImage] = useState('');
  const [linkTitle, setLinkTitle] = useState('');
  const [description, setDescription] = useState('');
  const [whatsappNumber, setWhatsappNumber] = useState('');
  // Per-user access key (sent as x-pwp-key). Persisted so it's entered once.
  const [accessKey, setAccessKey] = useState(() => localStorage.getItem('pwp_api_key') || '');
  const [isUploading, setIsUploading] = useState(false);
  const [isBulkGenerating, setIsBulkGenerating] = useState(false);
  const [isImageUploading, setIsImageUploading] = useState(false);
  const [isGeneratingMeta, setIsGeneratingMeta] = useState(false);

  // Bulk results — one entry per client name
  const [generatedClients, setGeneratedClients] = useState<GeneratedClient[]>([]);

  // Legacy single-link state (kept for WhatsApp preview panel)
  const [generatedLink, setGeneratedLink] = useState('');
  const [copied, setCopied] = useState(false);
  const [imageSizeWarning, setImageSizeWarning] = useState('');

  React.useEffect(() => {
    if (!previewImage) {
      setImageSizeWarning('');
      return;
    }

    if (!previewImage.startsWith('http')) {
      setImageSizeWarning('請輸入以 http:// 或 https:// 開頭的完整圖片網址。');
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/check-image-size?url=${encodeURIComponent(previewImage)}`, {
          headers: { 'x-pwp-key': accessKey },
        });
        if (!res.ok) return;
        const data = await res.json();
        
        if (data.sizeBytes != null) {
          const kb = Math.round(data.sizeBytes / 1024);
          if (kb > 300) {
            const mb = (data.sizeBytes / (1024 * 1024)).toFixed(2);
            setImageSizeWarning(`警告：此圖片大小為 ${mb} MB (${kb} KB)，已大幅超出 WhatsApp / Telegram 預覽圖上限 300 KB。預覽圖很可能無法正常顯示！建議將圖片壓縮並轉為 JPG 後再重新上傳。`);
          } else {
            setImageSizeWarning('');
          }
        } else {
          setImageSizeWarning('');
        }
      } catch (err) {
        console.error('[CHECK_IMAGE_SIZE] Failed to query size:', err);
        setImageSizeWarning('');
      }
    }, 600);

    return () => clearTimeout(timer);
  }, [previewImage, accessKey]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const SESSION_CACHE_KEY = 'pw_uploaded_files';

  // Upload the PDF to R2 once (cached per file in this session) and return its
  // r2: reference. Shared by link generation and auto title/description.
  const uploadPdfIfNeeded = async (file: File): Promise<string> => {
    const fileIdentifier = `${file.name}_${file.size}`;
    const sessionCache = JSON.parse(sessionStorage.getItem(SESSION_CACHE_KEY) || '{}');
    if (sessionCache[fileIdentifier]) {
      console.log('[UPLOAD] Reusing cached path:', sessionCache[fileIdentifier]);
      return sessionCache[fileIdentifier];
    }

    console.log('[UPLOAD] Requesting R2 pre-signed URL...');
    const presignRes = await fetch('/api/r2-presign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-pwp-key': accessKey },
      body: JSON.stringify({ fileName: file.name, contentType: file.type || 'application/pdf' }),
    });
    if (presignRes.status === 401) throw new Error('存取金鑰無效或未填寫，請於上方輸入正確的存取金鑰');
    if (!presignRes.ok) throw new Error('無法取得上傳授權');
    const { uploadUrl, r2Key } = await presignRes.json();

    console.log('[UPLOAD] Uploading directly to R2...');
    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': file.type || 'application/pdf' },
    });
    if (!uploadRes.ok) throw new Error('檔案上傳至 R2 失敗');

    const cleanFileURL = `r2:${r2Key}`; // 'r2:' prefix so pdfBridge resolves it
    sessionStorage.setItem(SESSION_CACHE_KEY, JSON.stringify({ ...sessionCache, [fileIdentifier]: cleanFileURL }));
    console.log('[UPLOAD] Success:', cleanFileURL);
    return cleanFileURL;
  };

  // Read the PDF's content via Gemini and fill the title + description fields.
  // Editable afterwards — this is a starting point, not a lock-in.
  const handleAutoGenerate = async () => {
    const file = fileInputRef.current?.files?.[0];
    if (!file) return alert('請先選擇 PDF 檔案');
    if (!accessKey) return alert('請先於上方輸入存取金鑰');

    setIsGeneratingMeta(true);
    try {
      const f = await uploadPdfIfNeeded(file);
      const res = await fetch('/api/generate-meta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-pwp-key': accessKey },
        body: JSON.stringify({ f }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || '自動生成失敗');
      }
      const { title, description: desc } = await res.json();
      if (title) setLinkTitle(title);
      if (desc) setDescription(desc);
    } catch (error) {
      console.error('自動生成失敗:', error);
      alert(error instanceof Error ? error.message : '自動生成失敗');
    } finally {
      setIsGeneratingMeta(false);
    }
  };

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    const file = fileInputRef.current?.files?.[0];
    if (!file) return alert("請選擇檔案上傳");

    const names = clientList
      .split('\n')
      .map(n => n.trim())
      .filter(Boolean);

    if (names.length === 0) return alert("請輸入至少一個客戶名稱");

    setIsUploading(true);
    setGeneratedClients([]);

    try {
      // ── Step 1: Upload PDF once, reuse path for all clients ─────────────────
      const cleanFileURL = await uploadPdfIfNeeded(file);

      setIsUploading(false);
      setIsBulkGenerating(true);

      // ── Step 2: Create short links via server endpoint (single source of truth) ──
      const customDomain = import.meta.env.VITE_APP_URL;
      const origin = customDomain
        ? (customDomain.endsWith('/') ? customDomain.slice(0, -1) : customDomain)
        : window.location.origin;

      const fallbackReportName = file ? file.name.replace(/\.[^/.]+$/, "") : "Document";

      const createRes = await fetch('/api/create-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-pwp-key': accessKey },
        body: JSON.stringify({
          clients: names,
          f: cleanFileURL,
          r: reportName || fallbackReportName,
          t: linkTitle || fallbackReportName,
          d: description,
          i: previewImage,
          w: whatsappNumber, // server strips to digits for the "預約顧問" CTA
          origin,
        }),
      });

      if (!createRes.ok) {
        const errBody = await createRes.json().catch(() => ({}));
        throw new Error(errBody.error || '建立短連結失敗');
      }

      const { links } = await createRes.json();
      const results: GeneratedClient[] = (links || []).map(
        (l: { name: string; shortId: string; shortLink: string }) => ({ ...l, copied: false })
      );
      setGeneratedClients(results);

      // Set first link as the WhatsApp preview link
      if (results.length > 0) setGeneratedLink(results[0].shortLink);

    } catch (error) {
      console.error("批量生成過程中出錯:", error);
      alert(error instanceof Error ? error.message : "發生未知錯誤");
    } finally {
      setIsUploading(false);
      setIsBulkGenerating(false);
    }
  };

  // Compress a chosen image to <300KB, upload to R2, and auto-fill the preview
  // image URL — replaces the manual "upload to meee.com.tw and paste" step.
  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!accessKey) {
      alert('請先於上方輸入存取金鑰，再上傳預覽圖');
      e.target.value = '';
      return;
    }

    setIsImageUploading(true);
    setImageSizeWarning('');
    try {
      const blob = await compressImageToJpeg(file);

      const baseName = file.name.replace(/\.[^/.]+$/, '') || 'preview';
      const presignRes = await fetch('/api/r2-presign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-pwp-key': accessKey },
        body: JSON.stringify({ fileName: `${baseName}.jpg`, contentType: 'image/jpeg' }),
      });
      if (presignRes.status === 401) throw new Error('存取金鑰無效或未填寫');
      if (!presignRes.ok) throw new Error('無法取得圖片上傳授權');
      const { uploadUrl, publicPath } = await presignRes.json();

      const uploadRes = await fetch(uploadUrl, {
        method: 'PUT',
        body: blob,
        headers: { 'Content-Type': 'image/jpeg' },
      });
      if (!uploadRes.ok) throw new Error('圖片上傳至 R2 失敗');

      const customDomain = import.meta.env.VITE_APP_URL;
      const origin = customDomain
        ? (customDomain.endsWith('/') ? customDomain.slice(0, -1) : customDomain)
        : window.location.origin;

      setPreviewImage(`${origin}${publicPath}`);
    } catch (error) {
      console.error('圖片上傳失敗:', error);
      alert(error instanceof Error ? error.message : '圖片處理失敗');
    } finally {
      setIsImageUploading(false);
      e.target.value = ''; // allow re-selecting the same file
    }
  };

  const copyClientLink = (index: number) => {
    navigator.clipboard.writeText(generatedClients[index].shortLink);
    setGeneratedClients(prev =>
      prev.map((c, i) => ({ ...c, copied: i === index }))
    );
    setTimeout(() => {
      setGeneratedClients(prev =>
        prev.map((c, i) => ({ ...c, copied: i === index ? false : c.copied }))
      );
    }, 2000);
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(generatedLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Preview Data logic aligned with server.ts
  const firstClient = clientList.split('\n').map(n => n.trim()).filter(Boolean)[0];
  const previewCName = firstClient || "貴客";
  const previewTitleActual = linkTitle
    ? (linkTitle.includes('：') || linkTitle.includes(':') ? linkTitle : `${linkTitle}：${previewCName}`)
    : `專案報告：${previewCName}`;

  const previewDescActual = description || "為您整理的最新市場動態，包含 AI 股分析及日圓走勢預測。";

  // Image logic including server-side meee.com.tw auto-fix
  let previewImageActual = previewImage || "https://images.unsplash.com/photo-1554224155-8d04cb21cd6c?q=80&w=1200&auto=format&fit=crop&.jpg";
  if (previewImageActual.includes('meee.com.tw') && !previewImageActual.includes('i.meee.com.tw')) {
    const replaced = previewImageActual.replace('meee.com.tw', 'i.meee.com.tw');
    previewImageActual = /\.(png|jpe?g|gif|webp)$/i.test(replaced) ? replaced : replaced + '.png';
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col md:flex-row font-sans text-slate-900">
      {/* Left Panel: Input Form */}
      <div className="w-full md:w-1/2 p-6 md:p-12 flex flex-col justify-center bg-white shadow-xl z-10">
        <div className="max-w-md mx-auto w-full">
          <div className="flex justify-between items-start mb-4">
            <div className="bg-indigo-600 w-12 h-12 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-200">
              <Share2 className="w-6 h-6 text-white" />
            </div>
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">Link Generator</h1>
          <p className="text-slate-500 mt-2">Create professional preview links for WhatsApp sharing.</p>
        </div>

        <form onSubmit={handleGenerate} className="space-y-5">
          <div>
            <label htmlFor="linkTitle" className="block text-sm font-semibold text-slate-700 mb-1.5">
              Link Title
            </label>
            <input
              type="text"
              id="linkTitle"
              value={linkTitle}
              onChange={(e) => setLinkTitle(e.target.value)}
              placeholder="專案報告"
              className="block w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all outline-none text-sm bg-slate-50 focus:bg-white"
            />
          </div>

          <div>
            <label htmlFor="reportName" className="block text-sm font-semibold text-slate-700 mb-1.5">
              Report Name
            </label>
            <input
              type="text"
              id="reportName"
              value={reportName}
              onChange={(e) => setReportName(e.target.value)}
              placeholder="e.g., Monthly Financial Report"
              className="block w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all outline-none text-sm bg-slate-50 focus:bg-white"
            />
          </div>

          <div>
            <label htmlFor="description" className="block text-sm font-semibold text-slate-700 mb-1.5">
              Link Description
            </label>
            <textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="為您整理的最新市場動態..."
              rows={2}
              className="block w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all outline-none text-sm bg-slate-50 focus:bg-white resize-none"
            />
            {/* AI auto-fill: reads the PDF and fills Title + Description above */}
            <button
              type="button"
              onClick={handleAutoGenerate}
              disabled={isGeneratingMeta}
              className="mt-2.5 w-full flex items-center justify-center gap-2 py-2.5 px-4 border border-indigo-200 rounded-xl text-sm font-semibold text-indigo-600 bg-indigo-50/50 hover:bg-indigo-50 transition-all disabled:opacity-75 disabled:cursor-wait cursor-pointer"
            >
              {isGeneratingMeta ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> 依 PDF 內容生成中...</>
              ) : (
                <><Sparkles className="w-4 h-4" /> 自動生成標題與描述（依 PDF 內容）</>
              )}
            </button>
            <p className="text-xs text-slate-400 mt-1.5 ml-1">
              需先選擇下方的 PDF 檔案。生成後可自行修改。
            </p>
          </div>

          <div>
            <label htmlFor="accessKey" className="block text-sm font-semibold text-slate-700 mb-1.5">
              存取金鑰 Access Key <span className="text-rose-500 font-normal">(必填)</span>
            </label>
            <input
              type="password"
              id="accessKey"
              value={accessKey}
              onChange={(e) => {
                setAccessKey(e.target.value);
                localStorage.setItem('pwp_api_key', e.target.value);
              }}
              placeholder="請輸入您的專屬存取金鑰"
              className="block w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all outline-none text-sm bg-slate-50 focus:bg-white"
            />
            <p className="text-xs text-slate-400 mt-1.5 ml-1">
              只需輸入一次（會記住於此瀏覽器）。沒有金鑰將無法產生連結。
            </p>
          </div>

          <div>
            <label htmlFor="whatsappNumber" className="block text-sm font-semibold text-slate-700 mb-1.5">
              預約顧問 WhatsApp 號碼 <span className="text-slate-400 font-normal">(Optional)</span>
            </label>
            <input
              type="text"
              id="whatsappNumber"
              value={whatsappNumber}
              onChange={(e) => setWhatsappNumber(e.target.value)}
              placeholder="85265387638"
              className="block w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all outline-none text-sm bg-slate-50 focus:bg-white"
            />
            <p className="text-xs text-slate-400 mt-1.5 ml-1">
              客戶點擊「預約顧問」按鈕時打開的 WhatsApp 號碼（含國家碼，留空則用預設 85265387638）。
            </p>
          </div>

          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1.5">
              Upload Document (PDF)
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
                <UploadCloud className="h-5 w-5 text-slate-400" />
              </div>
              <input
                type="file"
                ref={fileInputRef}
                accept="application/pdf"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    const cleanName = file.name.replace(/\.[^/.]+$/, "");
                    if (!reportName) {
                      setReportName(cleanName);
                    }
                    if (!linkTitle) {
                      setLinkTitle(cleanName);
                    }
                  }
                }}
                className="block w-full pl-11 pr-4 py-2 border border-slate-200 rounded-xl file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100 transition-all outline-none text-sm bg-slate-50 focus:bg-white cursor-pointer"
              />
            </div>
            <p className="text-xs text-slate-400 mt-1.5 ml-1">
              Supports up to 50MB directly via Firebase Storage.
            </p>
          </div>

          <div>
            <label htmlFor="clientList" className="block text-sm font-semibold text-slate-700 mb-1.5">
              Client Names <span className="text-slate-400 font-normal">(one per line — generates a unique link per client)</span>
            </label>
            <textarea
              id="clientList"
              value={clientList}
              onChange={(e) => setClientList(e.target.value)}
              placeholder={"陳大文\n李小明\n王美美"}
              rows={4}
              className="block w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all outline-none text-sm bg-slate-50 focus:bg-white resize-none font-mono"
            />
            {clientList.trim() && (
              <p className="text-xs text-indigo-500 mt-1.5 ml-1 font-medium">
                {clientList.split('\n').filter(n => n.trim()).length} client{clientList.split('\n').filter(n => n.trim()).length !== 1 ? 's' : ''} detected
              </p>
            )}
          </div>

          <div>
            <label htmlFor="previewImage" className="block text-sm font-semibold text-slate-700 mb-1.5">
              Preview Image URL <span className="text-slate-400 font-normal">(Optional)</span>
            </label>
            <input
              type="url"
              id="previewImage"
              value={previewImage}
              onChange={(e) => setPreviewImage(e.target.value)}
              placeholder="https://example.com/image.jpg"
              className="block w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all outline-none text-sm bg-slate-50 focus:bg-white"
            />
            <p className="text-xs text-slate-400 mt-1.5 ml-1">
              Custom image for WhatsApp/Telegram preview card.
            </p>

            {/* Upload + auto-compress: fills the URL above automatically */}
            <label
              className={`mt-2.5 flex items-center justify-center gap-2 py-2.5 px-4 border border-dashed border-indigo-200 rounded-xl text-sm font-semibold text-indigo-600 bg-indigo-50/50 transition-all ${isImageUploading ? 'opacity-75 cursor-wait' : 'hover:bg-indigo-50 cursor-pointer'}`}
            >
              {isImageUploading ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> 壓縮並上傳中...</>
              ) : (
                <><ImagePlus className="w-4 h-4" /> 上傳圖片（自動壓縮至 300KB 以下）</>
              )}
              <input
                type="file"
                accept="image/*"
                onChange={handleImageUpload}
                disabled={isImageUploading}
                className="hidden"
              />
            </label>
            <p className="text-xs text-slate-400 mt-1.5 ml-1">
              選擇任何圖片即可，系統會自動壓縮並產生可用的預覽圖網址（毋須再用 meee.com.tw）。
            </p>

            {imageSizeWarning && (
              <p className="text-xs text-rose-600 mt-2.5 ml-1 font-semibold bg-rose-50 border border-rose-100 rounded-xl p-3 flex items-start gap-2 shadow-sm shadow-rose-50/50">
                <span className="shrink-0 text-sm leading-none">⚠️</span>
                <span>{imageSizeWarning}</span>
              </p>
            )}
          </div>

          <div className="flex gap-3">
            <button
              type="submit"
              disabled={isUploading || isBulkGenerating}
              className="flex-1 flex justify-center items-center gap-2 py-3.5 px-4 border border-transparent rounded-xl shadow-lg shadow-indigo-200 text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 transition-all transform hover:-translate-y-0.5 cursor-pointer disabled:opacity-75 disabled:cursor-not-allowed"
            >
              {isUploading ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Uploading PDF...</>
              ) : isBulkGenerating ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Generating Links...</>
              ) : (
                'Generate Links'
              )}
            </button>
          </div>
        </form>

        {/* ── Bulk Results Panel ─────────────────────────────────── */}
        <AnimatePresence>
          {generatedClients.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mt-8 bg-slate-50 rounded-2xl p-5 border border-slate-200"
            >
              <div className="flex items-center justify-between mb-3">
                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider">
                  {generatedClients.length} Link{generatedClients.length !== 1 ? 's' : ''} Generated
                </label>
                <span className="text-xs text-green-600 font-semibold bg-green-50 px-2 py-0.5 rounded-full">
                  30-day TTL set
                </span>
              </div>

              <div className="flex flex-col gap-2 max-h-72 overflow-y-auto pr-1">
                {generatedClients.map((client, i) => (
                  <motion.div
                    key={client.shortId}
                    initial={{ opacity: 0, x: -6 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.04 }}
                    className="flex items-center gap-2 bg-white border border-slate-200 rounded-xl px-3 py-2 shadow-sm"
                  >
                    {/* Client name */}
                    <span className="text-sm font-semibold text-slate-700 w-24 shrink-0 truncate">
                      {client.name}
                    </span>

                    {/* Short link */}
                    <code className="flex-1 text-xs font-mono text-indigo-600 truncate">
                      {client.shortLink}
                    </code>

                    {/* Copy button */}
                    <button
                      onClick={() => copyClientLink(i)}
                      className="shrink-0 p-1.5 rounded-lg hover:bg-indigo-50 transition-colors cursor-pointer"
                      title="Copy link"
                    >
                      {client.copied
                        ? <Check className="w-4 h-4 text-green-500" />
                        : <Copy className="w-4 h-4 text-slate-400 hover:text-indigo-500" />}
                    </button>

                    {/* WhatsApp button */}
                    <a
                      href={`https://wa.me/?text=${encodeURIComponent(client.shortLink)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 p-1.5 rounded-lg hover:bg-green-50 transition-colors"
                      title="Send via WhatsApp"
                    >
                      <MessageCircle className="w-4 h-4 text-green-500" />
                    </a>
                  </motion.div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Right Panel: WhatsApp Preview */}
      <div className="w-full md:w-1/2 bg-[#e5ddd5] p-6 md:p-12 flex flex-col items-center justify-center relative overflow-hidden">
        {/* WhatsApp Background Pattern (CSS approximation) */}
        <div className="absolute inset-0 opacity-10 pointer-events-none"
          style={{ backgroundImage: 'radial-gradient(#4a4a4a 1px, transparent 1px)', backgroundSize: '20px 20px' }}>
        </div>

        <div className="max-w-sm w-full relative z-10">
          <div className="text-center mb-6">
            <h2 className="text-xl font-bold text-slate-700">WhatsApp Preview</h2>
            <p className="text-sm text-slate-500">How it looks to your client</p>
          </div>

          {/* WhatsApp Bubble */}
          <motion.div
            layout
            className="bg-white rounded-lg shadow-sm p-1 max-w-[330px] mx-auto relative"
            style={{ borderRadius: '0px 12px 12px 12px' }} // Message tail style
          >
            {/* Tail */}
            <div className="absolute top-0 -left-2 w-4 h-4 bg-white"
              style={{ clipPath: 'polygon(100% 0, 0 0, 100% 100%)' }}></div>

            {/* Link Preview Card */}
            <div className="bg-[#f0f2f5] rounded-md overflow-hidden cursor-pointer border border-slate-100">
              {/* Image */}
              <div className="h-40 bg-slate-200 relative overflow-hidden">
                <img
                  src={previewImageActual}
                  alt="Preview"
                  className="w-full h-full object-cover"
                  onError={(e) => {
                    // Fallback if image fails to load
                    (e.target as HTMLImageElement).src = "https://images.unsplash.com/photo-1554224155-8d04cb21cd6c?q=80&w=1200&auto=format&fit=crop&.jpg";
                  }}
                />
              </div>

              {/* Text Content */}
              <div className="p-3 bg-[#f0f2f5]">
                <h3 className="font-semibold text-slate-900 text-sm leading-tight mb-1 line-clamp-2">
                  {previewTitleActual}
                </h3>
                <p className="text-xs text-slate-500 line-clamp-2 mb-1">
                  {previewDescActual}
                </p>
                <p className="text-[10px] text-slate-400 uppercase tracking-wide">
                  {window.location.host || 'your-app-url.com'}
                </p>
              </div>
            </div>

            {/* Link Text */}
            <div className="px-2 pb-1 pt-1">
              <p className="text-sm text-[#009de2] hover:underline break-all">
                {generatedLink || 'https://...'}
              </p>
            </div>

            {/* Timestamp & Status */}
            <div className="flex justify-end items-center px-2 pb-1 gap-1">
              <span className="text-[10px] text-slate-400">12:42 PM</span>
              <div className="flex">
                <Check className="w-3 h-3 text-[#53bdeb]" />
                <Check className="w-3 h-3 text-[#53bdeb] -ml-1.5" />
              </div>
            </div>
          </motion.div>
        </div>
      </div>
    </div >
  );
}

