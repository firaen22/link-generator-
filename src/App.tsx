/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef } from 'react';
import { Link, Copy, Check, FileText, Share2, UploadCloud } from 'lucide-react';
import { motion } from 'motion/react';
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { storage } from "./firebase";

export default function App() {
  const [clientName, setClientName] = useState('');
  const [reportName, setReportName] = useState('');
  const [previewImage, setPreviewImage] = useState('');
  const [linkTitle, setLinkTitle] = useState('');
  const [description, setDescription] = useState('');
  const [generatedLink, setGeneratedLink] = useState('');
  const [copied, setCopied] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadedFileId, setUploadedFileId] = useState('');
  const [lastFileFingerprint, setLastFileFingerprint] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();

    let targetFileId = '';

    // Handle Firebase Upload
    const file = fileInputRef.current?.files?.[0];
    if (file) {
      const currentFingerprint = `${file.name}-${file.size}`;

      // Skip upload if it's the same file we already uploaded
      if (uploadedFileId && lastFileFingerprint === currentFingerprint) {
        targetFileId = uploadedFileId;
      } else {
        setIsUploading(true);
        try {
          // Create a unique file path in storage
          const storageRef = ref(storage, `reports/${Date.now()}_${file.name}`);

          // Direct upload to Firebase (supports large files)
          const snapshot = await uploadBytes(storageRef, file);
          const downloadURL = await getDownloadURL(snapshot.ref);

          // Encode the URL as base64 with vblob_ prefix for the Viewer
          const safeBase64 = btoa(downloadURL).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
          targetFileId = `vblob_${safeBase64}`;

          // Cache the results
          setUploadedFileId(targetFileId);
          setLastFileFingerprint(currentFingerprint);
        } catch (error) {
          console.error('Firebase 上傳失敗', error);
          alert(`上傳失敗：${error instanceof Error ? error.message : '請檢查網路或 Firebase 設定'}`);
          setIsUploading(false);
          return;
        }
        setIsUploading(false);
      }
    }

    if (!targetFileId) {
      alert("請選擇檔案上傳");
      return;
    }

    // --- Blobs are already shortened in the upload block ---
    let finalId = targetFileId;

    const origin = window.location.origin;
    const params = new URLSearchParams();
    // Shorthand: c=client, r=report, i=image, d=description, t=title
    if (clientName) params.append('c', clientName);
    if (reportName) params.append('r', reportName);
    if (previewImage) params.append('i', previewImage);
    if (description) params.append('d', description);
    if (linkTitle) params.append('t', linkTitle);

    const link = `${origin}/s/${finalId}?${params.toString()}`;
    setGeneratedLink(link);
    setCopied(false);
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(generatedLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Preview Data
  const previewTitle = reportName && clientName
    ? `${reportName} for ${clientName}`
    : reportName
      ? `${reportName} for Client`
      : clientName
        ? `Document for ${clientName}`
        : "Document for Client";

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col md:flex-row font-sans text-slate-900">
      {/* Left Panel: Input Form */}
      <div className="w-full md:w-1/2 p-6 md:p-12 flex flex-col justify-center bg-white shadow-xl z-10">
        <div className="max-w-md mx-auto w-full">
          <div className="mb-8">
            <div className="bg-indigo-600 w-12 h-12 rounded-xl flex items-center justify-center mb-4 shadow-lg shadow-indigo-200">
              <Share2 className="w-6 h-6 text-white" />
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
                Bypasses 4.5MB limit by uploading directly to Vercel Blob.
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
              <div className="flex items-center gap-2">
                <code className="flex-1 block w-full p-3 bg-white border border-slate-200 rounded-xl text-xs font-mono text-slate-600 break-all shadow-sm">
                  {generatedLink}
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
            </motion.div>
          )}
        </div>
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
                  src={previewImage || "https://images.unsplash.com/photo-1554224155-8d04cb21cd6c?q=80&w=600&auto=format&fit=crop"}
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
                  {previewTitle}
                </h3>
                <p className="text-xs text-slate-500 line-clamp-2 mb-1">
                  Please review the shared document. Click to open in Google Drive.
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
    </div>
  );
}

