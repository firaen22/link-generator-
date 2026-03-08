/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef } from 'react';
import { Copy, Check, Share2, UploadCloud } from 'lucide-react';
import { motion } from 'motion/react';
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { doc, setDoc } from "firebase/firestore";
import { storage, db } from "./firebase";
import LZString from 'lz-string';

export default function App() {
  const [clientName, setClientName] = useState('');
  const [reportName, setReportName] = useState('');
  const [previewImage, setPreviewImage] = useState('');
  const [linkTitle, setLinkTitle] = useState('');
  const [description, setDescription] = useState('');
  const [generatedLink, setGeneratedLink] = useState('');
  const [copied, setCopied] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [shortLink, setShortLink] = useState('');
  const [isShortening, setIsShortening] = useState(false);
  const [lastCompressed, setLastCompressed] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const SESSION_CACHE_KEY = 'pw_uploaded_files';

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    const file = fileInputRef.current?.files?.[0];
    if (!file) return alert("請選擇檔案上傳");

    setIsUploading(true);
    try {
      // 0. Check sessionStorage for same file in this session
      const fileIdentifier = `${file.name}_${file.size}`;
      const sessionCache = JSON.parse(sessionStorage.getItem(SESSION_CACHE_KEY) || '{}');
      let cleanFileURL: string = sessionCache[fileIdentifier] || '';

      if (cleanFileURL) {
        console.log('File already uploaded this session, reusing path:', cleanFileURL);
      } else {
        // 1. Upload to Firebase
        console.log('Starting upload...');
        const fileName = `${Date.now().toString(36)}_${file.name}`;
        const storageRef = ref(storage, `reports/${fileName}`);

        try {
          const snapshot = await uploadBytes(storageRef, file);
          const downloadUrl = await getDownloadURL(snapshot.ref);
          cleanFileURL = downloadUrl;
          // Persist to sessionStorage for dedup
          sessionStorage.setItem(SESSION_CACHE_KEY, JSON.stringify({
            ...sessionCache,
            [fileIdentifier]: cleanFileURL,
          }));
        } catch (uploadError) {
          console.error('Firebase Upload Error:', uploadError);
          throw new Error(`Firebase 上傳失敗：${uploadError instanceof Error ? uploadError.message : '權限不足'}`);
        }
      }

      // 2. 打包並壓縮數據
      let compressed = "";
      try {
        const payload = {
          c: clientName || "貴客",
          r: reportName || "Document",
          t: linkTitle,
          d: description,
          i: previewImage,
          f: cleanFileURL // Now a shorter path if it's Firebase
        };
        compressed = LZString.compressToEncodedURIComponent(JSON.stringify(payload));
      } catch (compError) {
        throw new Error("數據壓縮失敗");
      }

      setLastCompressed(compressed);

      // 3. 準備長連結
      const origin = window.location.origin;
      const longLink = `${origin}/s?q=${compressed}`;

      setGeneratedLink(longLink);
      setShortLink('');
      setCopied(false);
    } catch (error) {
      console.error("生成過程中出錯:", error);
      alert(error instanceof Error ? error.message : "發生未知錯誤");
    } finally {
      setIsUploading(false);
    }
  };


  const handleShorten = async () => {
    if (!lastCompressed) return;
    setIsShortening(true);
    try {
      // 1. 產生 6 碼隨機短 ID 並寫入 Firestore
      const shortId = Math.random().toString(36).substring(2, 8);

      await setDoc(doc(db, "links", shortId), {
        q: lastCompressed,
        createdAt: new Date().toISOString()
      });

      // 2. 生成專屬短連結
      const customDomain = import.meta.env.VITE_APP_URL;
      const origin = customDomain ? (customDomain.endsWith('/') ? customDomain.slice(0, -1) : customDomain) : window.location.origin;
      const internalShortLink = `${origin}/l/${shortId}`;
      setShortLink(internalShortLink);
    } catch (error) {
      console.error("生成短連結失敗:", error);
      alert("無法產生短連結，請檢查 Firebase 設定");
    } finally {
      setIsShortening(false);
    }
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(shortLink || generatedLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Preview Data logic aligned with server.ts
  const previewCName = clientName || "貴客";
  const previewTitleActual = linkTitle
    ? (linkTitle.includes('：') || linkTitle.includes(':') ? linkTitle : `${linkTitle}：${previewCName}`)
    : `專案報告：${previewCName}`;

  const previewDescActual = description || "為您整理的最新市場動態，包含 AI 股分析及日圓走勢預測。";

  // Image logic including server-side meee.com.tw auto-fix
  let previewImageActual = previewImage || "https://images.unsplash.com/photo-1554224155-8d04cb21cd6c?q=80&w=600&auto=format&fit=crop";
  if (previewImageActual.includes('meee.com.tw') && !previewImageActual.includes('i.meee.com.tw')) {
    previewImageActual = previewImageActual.replace('meee.com.tw', 'i.meee.com.tw') + '.png';
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
                className="block w-full pl-11 pr-4 py-2 border border-slate-200 rounded-xl file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100 transition-all outline-none text-sm bg-slate-50 focus:bg-white cursor-pointer"
              />
            </div>
            <p className="text-xs text-slate-400 mt-1.5 ml-1">
              Supports up to 50MB directly via Firebase Storage.
            </p>
          </div>

          <div>
            <label htmlFor="clientName" className="block text-sm font-semibold text-slate-700 mb-1.5">
              Client Name
            </label>
            <input
              type="text"
              id="clientName"
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              placeholder="e.g., Acme Corp"
              className="block w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all outline-none text-sm bg-slate-50 focus:bg-white"
            />
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
          </div>

          <div className="flex gap-3">
            <button
              type="submit"
              disabled={isUploading}
              className="flex-1 flex justify-center py-3.5 px-4 border border-transparent rounded-xl shadow-lg shadow-indigo-200 text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 transition-all transform hover:-translate-y-0.5 cursor-pointer disabled:opacity-75 disabled:cursor-not-allowed"
            >
              {isUploading ? 'Uploading...' : 'Generate Link'}
            </button>
          </div>
        </form>

        {generatedLink && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-8 bg-slate-50 rounded-2xl p-5 border border-slate-200"
          >
            <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">
              Ready to Share
            </label>
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <code className="flex-1 block w-full p-3 bg-white border border-slate-200 rounded-xl text-xs font-mono text-slate-600 break-all shadow-sm">
                  {shortLink || generatedLink}
                </code>
                <button
                  onClick={copyToClipboard}
                  className="flex-shrink-0 p-3 bg-white border border-slate-200 rounded-xl hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-600 transition-all cursor-pointer shadow-sm group"
                  title="Copy to clipboard"
                >
                  {copied ? (
                    <Check className="w-5 h-5 text-green-500" />
                  ) : (
                    <Copy className="w-5 h-5 text-slate-400 group-hover:text-indigo-500" />
                  )}
                </button>
              </div>

              {/* 當還沒產生短連結時，顯示轉換按鈕 */}
              {!shortLink && (
                <button
                  type="button"
                  onClick={handleShorten}
                  disabled={isShortening}
                  className="w-full flex justify-center py-2 px-4 border border-indigo-200 text-indigo-700 bg-indigo-50 rounded-xl hover:bg-indigo-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 transition-all cursor-pointer disabled:opacity-75 disabled:cursor-not-allowed text-sm font-semibold mt-1"
                >
                  {isShortening ? '🔄 正在轉換短連結...' : '✨ 將長連結轉為 Firestore 短連結'}
                </button>
              )}
            </div>
          </motion.div>
        )}
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
                    (e.target as HTMLImageElement).src = "https://images.unsplash.com/photo-1554224155-8d04cb21cd6c?q=80&w=600&auto=format&fit=crop";
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

