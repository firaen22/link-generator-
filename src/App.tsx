/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef } from 'react';
import { Link, Copy, Check, FileText, Share2, Eye, UploadCloud } from 'lucide-react';
import { motion } from 'motion/react';
import { upload } from '@vercel/blob/client';

export default function App() {
  const [fileId, setFileId] = useState('');
  const [clientName, setClientName] = useState('');
  const [reportName, setReportName] = useState('');
  const [previewImage, setPreviewImage] = useState('');
  const [generatedLink, setGeneratedLink] = useState('');
  const [copied, setCopied] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();

    let targetFileId = fileId;
    let extractedId = fileId;
    const urlMatch = targetFileId.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (urlMatch && urlMatch[1]) {
      targetFileId = urlMatch[1];
    }

    // Handle Blob Upload
    if (!targetFileId && fileInputRef.current?.files?.[0]) {
      setIsUploading(true);
      try {
        const file = fileInputRef.current.files[0];
        const newBlob = await upload(file.name, file, {
          access: 'public',
          handleUploadUrl: '/api/upload',
        });
        targetFileId = newBlob.url.split('/').pop() || '';
      } catch (error) {
        console.error('上傳失敗', error);
        alert('上傳失敗，請檢查檔案大小或網路。');
        setIsUploading(false);
        return;
      }
      setIsUploading(false);
    }

    if (!targetFileId) {
      alert("請填寫 Google Drive ID 或選擇檔案上傳");
      return;
    }

    const origin = window.location.origin;
    const params = new URLSearchParams();
    if (clientName) params.append('client_name', clientName);
    if (reportName) params.append('report_name', reportName);
    if (previewImage) params.append('preview_image', previewImage);

    const link = `${origin}/api/share/${targetFileId}?${params.toString()}`;
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
              <label htmlFor="fileId" className="block text-sm font-semibold text-slate-700 mb-1.5">
                Google Drive File ID
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
                  <FileText className="h-5 w-5 text-slate-400" />
                </div>
                <input
                  type="text"
                  id="fileId"
                  value={fileId}
                  onChange={(e) => setFileId(e.target.value)}
                  placeholder="Paste File ID here..."
                  className="block w-full pl-11 pr-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all outline-none text-sm bg-slate-50 focus:bg-white"
                />
              </div>
              <p className="text-xs text-slate-400 mt-1.5 ml-1">
                From: drive.google.com/file/d/<b>FILE_ID</b>/view
              </p>
            </div>

            <div className="flex items-center">
              <div className="flex-grow h-px bg-slate-200"></div>
              <span className="px-3 text-xs text-slate-400 font-semibold uppercase tracking-wider">OR</span>
              <div className="flex-grow h-px bg-slate-200"></div>
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
                  onChange={() => setFileId('')} // clear drive ID if file selected
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
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  // Extract File ID
                  let extractedId = fileId;
                  const urlMatch = fileId.match(/\/d\/([a-zA-Z0-9_-]+)/);
                  if (urlMatch && urlMatch[1]) {
                    extractedId = urlMatch[1];
                  }

                  if (!extractedId) {
                    alert("Please enter a valid Google Drive File ID");
                    return;
                  }

                  const params = new URLSearchParams();
                  if (clientName) params.append('client_name', clientName);
                  if (reportName) params.append('report_name', reportName);

                  const url = `/view/${extractedId}?${params.toString()}`;
                  window.open(url, '_blank');
                }}
                className="flex-none px-4 py-3.5 border border-slate-200 rounded-xl text-slate-600 font-semibold text-sm hover:bg-slate-50 hover:text-indigo-600 hover:border-indigo-200 transition-all focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 cursor-pointer"
                title="Preview Document"
              >
                <Eye className="w-5 h-5" />
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

