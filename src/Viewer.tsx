import React, { useState, useEffect, useRef } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Document, Page, pdfjs } from 'react-pdf';
import {
  ChevronLeft, ChevronRight, Clock, Eye, AlertCircle,
  ZoomIn, ZoomOut, Maximize, Minimize, Download, FileText, Moon, Sun, LayoutPanelTop, X
} from 'lucide-react';
import { motion } from 'motion/react';

// Match the API version reported in the error (5.4.296) to fix mismatch
pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@5.4.296/build/pdf.worker.min.mjs`;

import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

export default function Viewer() {
  const { fileId } = useParams();
  const [searchParams] = useSearchParams();
  const [loadError, setLoadError] = useState<string | null>(null);
  const clientName = searchParams.get('c') || searchParams.get('client_name') || searchParams.get('name') || '貴客';
  const reportName = searchParams.get('r') || searchParams.get('report_name') || 'Document';

  const [numPages, setNumPages] = useState<number | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const notifiedMilestones = useRef<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [timeSpent, setTimeSpent] = useState(0);
  const [scale, setScale] = useState(1.0);
  const [containerWidth, setContainerWidth] = useState(window.innerWidth);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isWindowFocused, setIsWindowFocused] = useState(true);
  const [isScreenshotting, setIsScreenshotting] = useState(false);
  const [showDisclaimer, setShowDisclaimer] = useState(true);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [isLiquidMode, setIsLiquidMode] = useState(false);

  // Focus Mode / Personal Pacing tracking
  const [estLeftMins, setEstLeftMins] = useState(0);

  // Tracking refs
  const startTimeRef = useRef(Date.now());
  const lastPingRef = useRef(Date.now());
  const hasTrackedOpenRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Advanced behavior tracking
  const sessionDataRef = useRef<Record<number, { dwellMs: number, maxScale: number }>>({});
  const currentPageRef = useRef(1);
  const pageEnterTimeRef = useRef(Date.now());
  const hasSentSessionEndRef = useRef(false);
  const scaleRef = useRef(1.0);

  useEffect(() => { scaleRef.current = scale; }, [scale]);

  // Helper to accumulate telemetry
  const updateSessionData = (pageNum: number, durationMs: number, currentScale: number) => {
    if (!sessionDataRef.current[pageNum]) {
      sessionDataRef.current[pageNum] = { dwellMs: 0, maxScale: 1.0 };
    }
    sessionDataRef.current[pageNum].dwellMs += durationMs;
    if (currentScale > sessionDataRef.current[pageNum].maxScale) {
      sessionDataRef.current[pageNum].maxScale = currentScale;
    }
  };

  // Dispatch final session payload
  useEffect(() => {
    const handleExit = () => {
      if (hasSentSessionEndRef.current) return;
      hasSentSessionEndRef.current = true;

      const durationMs = Date.now() - pageEnterTimeRef.current;
      updateSessionData(currentPageRef.current, durationMs, scaleRef.current);

      const totalActiveTime = Math.floor((Date.now() - startTimeRef.current) / 1000);

      // Only send if they were here for at least some minimum seconds, or just send always.
      if (totalActiveTime < 1) return;

      const payload = {
        event: 'session_end',
        file_id: fileId,
        client_name: clientName,
        report_name: reportName,
        total_duration_sec: totalActiveTime,
        pages_data: sessionDataRef.current,
        timestamp: new Date().toISOString()
      };

      // Use fetch with keepalive: true (more reliable than sendBeacon for JSON)
      fetch('/api/session-end', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(err => console.error('Session end dispatch failed', err));
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        // We do not immediately trigger handleExit on hidden, because they might be just switching apps
        // but since we want to capture everything before mobile browser kills us, iOS needs this.
        // For accurate single-report we will do it on 'pagehide'.
      }
    };

    window.addEventListener('beforeunload', handleExit);
    window.addEventListener('pagehide', handleExit);

    return () => {
      window.removeEventListener('beforeunload', handleExit);
      window.removeEventListener('pagehide', handleExit);
      // Removed the unmount trigger to avoid duplicate or premature triggers during React strict mode rewrites 
    };
  }, [fileId, clientName, reportName]);

  // Track Page Dwell & Zoom Changes
  useEffect(() => {
    const now = Date.now();
    const durationMs = now - pageEnterTimeRef.current;

    // Save state for previous page
    updateSessionData(currentPageRef.current, durationMs, scaleRef.current);

    // Reset loop for new tracking segment
    currentPageRef.current = pageNumber;
    pageEnterTimeRef.current = now;
  }, [pageNumber, scale]);

  // Handle Window Resize
  useEffect(() => {
    const handleResize = () => setContainerWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // 1. Monitor window focus & mouse out: blur content aggressively
  useEffect(() => {
    const handleBlur = () => setIsWindowFocused(false);
    const handleFocus = () => setIsWindowFocused(true);
    const handleMouseLeave = () => setIsWindowFocused(false);
    const handleMouseEnter = () => setIsWindowFocused(true);
    const handleVisibilityChange = () => {
      if (document.hidden) setIsWindowFocused(false);
      else setIsWindowFocused(true);
    };

    window.addEventListener('blur', handleBlur);
    window.addEventListener('focus', handleFocus);
    document.addEventListener('mouseleave', handleMouseLeave);
    document.addEventListener('mouseenter', handleMouseEnter);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // High-frequency "Paranoia" Check (captures fast mouse-shortcuts that events might miss)
    let animationFrameId: number;
    const checkFocus = () => {
      if (!document.hasFocus() && isWindowFocused) {
        setIsWindowFocused(false);
      }
      animationFrameId = requestAnimationFrame(checkFocus);
    };
    animationFrameId = requestAnimationFrame(checkFocus);

    return () => {
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('mouseleave', handleMouseLeave);
      document.removeEventListener('mouseenter', handleMouseEnter);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // 2. Keyboard Protection: intercept common screenshot and print commands
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Intercept print (Ctrl+P or Cmd+P)
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        sendTrackingEvent('security_alert', { type: 'print_attempt' });
        alert("本文件受保護，不支援列印。");
      }

      if (e.key === 'PrintScreen') {
        sendTrackingEvent('security_alert', { type: 'screenshot_detected_win' });
        alert("系統偵測到截圖動作，請注意文件安全。");
      }

      // Detect Mac Screenshot (Cmd + Shift)
      if (e.metaKey && e.shiftKey) {
        setIsWindowFocused(false);
        sendTrackingEvent('security_alert', { type: 'potential_screenshot_mac' });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [numPages, pageNumber]);

  // Send tracking event to backend
  const sendTrackingEvent = (event: string, data: any = {}) => {
    const payload = {
      event,
      file_id: fileId,
      client_name: clientName,
      report_name: reportName,
      total_pages: numPages,
      timestamp: new Date().toISOString(),
      ...data
    };

    // Send to backend (fire and forget)
    fetch('/api/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(err => console.error('Tracking failed', err));
  };

  function onDocumentLoadSuccess({ numPages }: { numPages: number }) {
    setNumPages(numPages);
    setLoading(false);

    // Track 'open' event only once per session
    if (!hasTrackedOpenRef.current) {
      sendTrackingEvent('open', { total_pages: numPages });
      hasTrackedOpenRef.current = true;
    }
  }

  function changePage(offset: number) {
    setPageNumber(prevPageNumber => {
      const newPage = prevPageNumber + offset;
      // Ensure we stay within bounds
      if (newPage >= 1 && (numPages === null || newPage <= numPages)) {
        return newPage;
      }
      return prevPageNumber;
    });
  }

  // Track page views and milestones when pageNumber changes
  useEffect(() => {
    if (!loading && numPages) {
      const progress = Math.round((pageNumber / numPages) * 100);
      const milestones = [50, 80, 100];

      // Find highest milestone reached but not yet notified
      const currentMilestone = milestones
        .filter(m => progress >= m && !notifiedMilestones.current.has(m))
        .pop();

      if (currentMilestone) {
        notifiedMilestones.current.add(currentMilestone);

        sendTrackingEvent('milestone', {
          progress: currentMilestone,
          current_page: pageNumber,
          total_pages: numPages
        });
      }

      sendTrackingEvent('page_view', { page: pageNumber });
    }
  }, [pageNumber, loading, numPages]);

  function previousPage() {
    changePage(-1);
  }

  function nextPage() {
    changePage(1);
  }

  // Zoom handlers
  const zoomIn = () => setScale(prev => Math.min(prev + 0.1, 2.0));
  const zoomOut = () => setScale(prev => Math.max(prev - 0.1, 0.5));

  // Timer for "Time Spent" and Heartbeat
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      const sessionDuration = Math.floor((now - startTimeRef.current) / 1000);
      setTimeSpent(sessionDuration);

      // Dynamically calculate estimated time left
      if (numPages && pageNumber < numPages) {
        const avgPace = pageNumber > 1 ? (sessionDuration / (pageNumber - 1)) : 45; // default 45s per page initially
        const estSeconds = (numPages - pageNumber) * avgPace;
        setEstLeftMins(Math.max(1, Math.ceil(estSeconds / 60)));
      } else {
        setEstLeftMins(0);
      }

      // Send heartbeat every 30 seconds
      if (now - lastPingRef.current > 30000) {
        sendTrackingEvent('heartbeat', {
          duration_seconds: sessionDuration,
          current_page: pageNumber
        });
        lastPingRef.current = now;
      }
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  // Forced Proxy Mode: Always route through backend to bypass CORS
  const pdfUrl = `/api/pdf/${fileId}`;

  const downloadUrl = pdfUrl;

  return (
    <div className={`min-h-screen flex flex-col font-sans transition-colors duration-300 ${isDarkMode ? 'bg-[#121212] text-slate-300' : 'bg-[#F9FAFB] text-slate-900'}`}>
      {/* Disclaimer Modal */}
      {showDisclaimer && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            className={`rounded-2xl shadow-2xl w-full max-w-md overflow-hidden border ${isDarkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-100'}`}
          >
            <div className="px-6 py-8 sm:p-8">
              <div className="w-12 h-12 bg-amber-500/10 rounded-full flex items-center justify-center mb-5 border border-amber-500/20">
                <span className="text-xl">✨</span>
              </div>

              <h2 className={`text-lg font-bold mb-4 tracking-tight ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>專屬閱讀與免責提示</h2>

              <div className={`space-y-4 text-[15px] sm:text-sm leading-relaxed mb-8 ${isDarkMode ? 'text-slate-300' : 'text-slate-600'}`}>
                <p>為持續提升您的服務體驗，本系統會根據您的閱讀偏好，為您智能篩選專屬的市場資訊。</p>
                <div className={`p-3.5 rounded-xl text-xs sm:text-sm border ${isDarkMode ? 'bg-slate-800 border-slate-700 text-slate-400' : 'bg-slate-50 border-slate-100 text-slate-500'}`}>
                  <strong className="text-red-500 font-semibold mb-1 flex items-center gap-1.5"><AlertCircle className="w-3.5 h-3.5" /> 請注意</strong>
                  本系統推送之所有內容僅供資訊參考，不構成任何投資邀約或建議。
                </div>
              </div>

              <div className="flex flex-col sm:flex-row-reverse items-center gap-3">
                <button
                  onClick={() => setShowDisclaimer(false)}
                  className="w-full sm:w-auto flex-1 bg-gradient-to-r from-blue-900 to-blue-950 text-white font-medium py-3 px-5 rounded-xl hover:from-blue-800 hover:to-blue-900 transition-all shadow-md shadow-blue-900/20 active:scale-[0.98]"
                >
                  明白並繼續
                </button>
                <button
                  onClick={() => alert('私隱與免責條款：\n\n本系統會以匿名方式追蹤系統互動以提升服務質素。所有市場分析與數據僅供資訊參考，不構成任何形式的投資建議、邀約或指導。閣下在作出任何投資決定前，應獨立評估相關風險，並考慮尋求專業意見。投資涉及風險，證券價格可升可跌。')}
                  className={`w-full sm:w-auto text-xs font-medium py-3 px-4 rounded-xl transition-colors ${isDarkMode ? 'text-slate-400 hover:text-white hover:bg-slate-800' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-50'}`}
                >
                  了解私隱與免責詳情
                </button>
              </div>
            </div>
          </motion.div>
        </div>
      )}

      {/* Professional Header */}
      <header className={`backdrop-blur-md border-b shadow-[0_4px_20px_rgba(0,0,0,0.03)] h-14 sm:h-16 flex items-center justify-between px-3 sm:px-6 fixed top-0 w-full z-50 transition-all ${isDarkMode ? 'bg-[#121212]/95 border-slate-800' : 'bg-white/95 border-slate-100'}`}>
        {/* Top subtle gold line for premium feel */}
        <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-amber-300 via-amber-400 to-amber-300"></div>

        {/* Left: Close & Report Details */}
        <div className="flex items-center gap-3 sm:gap-4">
          <button
            onClick={() => {
              if (window.history.length > 1) {
                window.history.back();
              } else {
                window.close();
                // Fallback for browsers that don't allow window.close() on non-script-opened tabs
                setTimeout(() => window.location.href = "about:blank", 100);
              }
            }}
            className={`p-1.5 sm:p-2 rounded-full transition-all ${isDarkMode ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
            title="關閉報告"
          >
            <X className="w-5 h-5 sm:w-6 sm:h-6" />
          </button>

          <div className="flex flex-col">
            <h1 className={`text-xs sm:text-sm font-bold leading-tight truncate max-w-[140px] sm:max-w-xs ${isDarkMode ? 'text-slate-100' : 'text-blue-950'}`}>{reportName}</h1>
            <span className="text-[9px] sm:text-xs text-amber-500/90 font-medium truncate max-w-[140px] sm:max-w-xs uppercase tracking-wider">
              Prepared for {clientName}
            </span>
          </div>
        </div>

        {/* Right: Stats & Actions */}
        <div className="flex items-center gap-3 sm:gap-4">
          {/* Action: Liquid Mode Applet */}
          <button
            onClick={() => {
              setIsLiquidMode(!isLiquidMode);
              if (!isLiquidMode) alert("✨ 卡片式表格佈局 (Liquid Mode) 觸發中！\n系統正透過 AI 將複雜財報表格降維成卡片式佈局，並凍結首行索引，消除橫向滾動。");
            }}
            className={`hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[11px] font-bold transition-all shadow-sm ${isLiquidMode ? 'bg-amber-100 text-amber-800 border-amber-300' : isDarkMode ? 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700' : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-white'}`}
          >
            <LayoutPanelTop className="w-3.5 h-3.5" />
            表格降維
          </button>

          {/* Action: Dark Mode (Smart Invert) */}
          <button
            onClick={() => setIsDarkMode(!isDarkMode)}
            className={`p-1.5 sm:p-2 rounded-lg transition-all ${isDarkMode ? 'text-amber-400 hover:bg-slate-800' : 'text-slate-500 hover:text-blue-600 hover:bg-blue-50'}`}
            title="Dark Mode (Smart Invert)"
          >
            {isDarkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>

          {/* Zoom Controls (Desktop) */}
          <div className={`hidden md:flex items-center gap-1 rounded-lg p-1 border ${isDarkMode ? 'bg-slate-800 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
            <button
              onClick={zoomOut}
              className={`p-1.5 rounded-md transition-all active:scale-95 ${isDarkMode ? 'hover:bg-slate-700 text-slate-400' : 'hover:bg-white hover:shadow-sm text-slate-600'}`}
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <span className={`text-xs font-medium w-12 text-center select-none ${isDarkMode ? 'text-slate-300' : ''}`}>{Math.round(scale * 100)}%</span>
            <button
              onClick={zoomIn}
              className={`p-1.5 rounded-md transition-all active:scale-95 ${isDarkMode ? 'hover:bg-slate-700 text-slate-400' : 'hover:bg-white hover:shadow-sm text-slate-600'}`}
            >
              <ZoomIn className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main
        className={`flex-1 pt-16 sm:pt-20 pb-28 sm:pb-32 flex justify-center overflow-y-auto scroll-smooth select-none transition-all duration-300 relative ${(isWindowFocused && !isScreenshotting) ? '' : 'opacity-0 blur-3xl select-none pointer-events-none'} ${isDarkMode ? 'bg-[#121212]' : 'bg-[#F9FAFB]'}`}
        ref={containerRef}
        onContextMenu={(e) => e.preventDefault()}
      >
        {isDarkMode && (
          <style>{`
            .react-pdf__Page__canvas {
              filter: invert(1) hue-rotate(180deg) contrast(0.9);
            }
          `}</style>
        )}
        <div className="w-full max-w-6xl flex justify-center">
          <Document
            file={pdfUrl}
            onLoadSuccess={onDocumentLoadSuccess}
            loading={
              <div className="flex flex-col items-center justify-center h-[60vh] w-full space-y-6">
                <div className="relative w-20 h-20 flex items-center justify-center">
                  {/* Outer spinning ring (Navy) */}
                  <div className="absolute inset-0 rounded-full border-t-2 border-l-2 border-blue-900 animate-[spin_1.5s_linear_infinite] opacity-80"></div>
                  {/* Inner spinning ring (Amber) */}
                  <div className="absolute inset-2 rounded-full border-b-2 border-r-2 border-amber-400 animate-[spin_2s_linear_infinite_reverse] opacity-90"></div>
                  {/* Center branding removed, keeping rings */}
                  <div className="h-12 w-12 bg-gradient-to-tr from-white to-slate-50 rounded-full flex items-center justify-center shadow-inner animate-pulse">
                    <FileText className="w-6 h-6 text-blue-900 opacity-50" />
                  </div>
                </div>
                <div className="text-center space-y-2">
                  <h3 className="text-blue-950 font-bold text-lg">Secure Document Loading</h3>
                  <p className="text-sm text-amber-600/80 font-medium animate-pulse max-w-xs mx-auto">
                    Retrieving large report from encrypted storage...
                  </p>
                </div>
              </div>
            }
            error={
              <div className="flex flex-col items-center justify-center h-[60vh] w-full p-8 text-center text-slate-500">
                <div className="bg-red-50 p-4 rounded-full mb-4">
                  <AlertCircle className="w-8 h-8 text-red-500" />
                </div>
                <h3 className="text-lg font-bold text-slate-800 mb-2">Unable to load document</h3>
                <p className="text-sm max-w-md mx-auto text-slate-600 mb-2">
                  This usually happens if the file permissions are restricted, or the file is too large.
                </p>
                {loadError && (
                  <div className="text-[10px] text-red-400 font-mono bg-red-50/50 px-2 py-1 rounded">
                    Error Details: {loadError}
                  </div>
                )}
              </div>
            }
            onLoadError={(error) => {
              console.error('Error loading PDF:', error);
              setLoadError(error.message);
            }}
            className="flex flex-col items-center gap-8"
          >
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, ease: "easeOut" }}
              className="relative"
            >
              <Page
                pageNumber={pageNumber}
                scale={scale}
                width={Math.min(containerWidth - 32, 1000)}
                renderTextLayer={true}
                renderAnnotationLayer={true}
                className="shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-slate-100 rounded-sm bg-white"
                loading={
                  <div className="h-[800px] w-[600px] bg-white shadow-xl rounded-sm animate-pulse"></div>
                }
              />

              {/* Dynamic Watermark Overlay */}
              <div className="absolute inset-0 pointer-events-none overflow-hidden z-10 opacity-[0.06] select-none flex flex-wrap gap-x-16 sm:gap-x-32 gap-y-16 sm:gap-y-32 rotate-[-30deg] scale-150 items-center justify-center">
                {Array.from({ length: 30 }).map((_, i) => (
                  <div key={i} className="text-sm sm:text-xl font-bold whitespace-nowrap text-slate-900 tracking-widest uppercase">
                    {clientName} • CONFIDENTIAL
                  </div>
                ))}
              </div>
            </motion.div>
          </Document>
        </div>

        {/* Floating AI Pacing / Reading Target Tag */}
        {numPages && estLeftMins > 0 && (
          <div className={`fixed bottom-24 right-4 sm:bottom-8 sm:right-8 px-4 py-2.5 rounded-2xl backdrop-blur-md shadow-lg border text-xs sm:text-sm font-medium flex flex-col items-end gap-1 transition-all duration-500 z-40 ${isDarkMode ? 'bg-[#1e1e1e]/80 border-slate-700 text-slate-300 shadow-black/50' : 'bg-white/80 border-slate-200 text-slate-600'}`}>
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full animate-pulse ${estLeftMins < 2 ? 'bg-amber-400' : 'bg-emerald-500'}`}></div>
              預估剩餘閱讀時間
            </div>
            <div className={`font-mono text-base sm:text-lg font-bold tracking-tight ${isDarkMode ? 'text-slate-100' : 'text-blue-950'}`}>
              ~{estLeftMins} 分鐘
            </div>
          </div>
        )}
      </main>

      {/* Bottom Floating Navigation Bar */}
      {
        numPages && (
          <div className="fixed bottom-6 sm:bottom-8 left-1/2 transform -translate-x-1/2 z-50 w-full max-w-xs sm:max-w-md px-4 pointer-events-none flex justify-center">
            <motion.div
              initial={{ y: 50, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              className="bg-blue-950/85 backdrop-blur-2xl text-white pl-1.5 pr-3 py-1 sm:py-1.5 rounded-full shadow-[0_8px_30px_-5px_rgba(30,58,138,0.5)] border border-white/10 ring-1 ring-amber-400/20 flex items-center justify-between pointer-events-auto"
            >
              <div className="flex items-center gap-0.5 sm:gap-1">
                <button
                  onClick={previousPage}
                  disabled={pageNumber <= 1}
                  className="p-1.5 sm:p-2 hover:bg-white/10 text-slate-300 hover:text-amber-400 rounded-full disabled:opacity-30 disabled:hover:bg-transparent transition-colors active:scale-95"
                  title="Previous Page"
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>

                <span className="font-mono text-sm font-medium min-w-[65px] sm:min-w-[70px] whitespace-nowrap text-center select-none text-slate-200">
                  {pageNumber} <span className="text-amber-400/60">/</span> {numPages}
                </span>

                <button
                  onClick={nextPage}
                  disabled={pageNumber >= numPages}
                  className="p-1.5 sm:p-2 hover:bg-white/10 text-slate-300 hover:text-amber-400 rounded-full disabled:opacity-30 disabled:hover:bg-transparent transition-colors active:scale-95"
                  title="Next Page"
                >
                  <ChevronRight className="w-5 h-5 sm:w-5 sm:h-5" />
                </button>
              </div>

              {/* Divider */}
              <div className="w-px h-5 sm:h-6 bg-white/10 mx-1 sm:mx-2"></div>

              {/* Mobile Zoom (Simple Toggle) */}
              <button
                onClick={() => setScale(s => s === 1 ? 1.5 : 1)}
                className="p-1.5 hover:bg-white/10 text-slate-300 hover:text-amber-400 rounded-full transition-colors md:hidden mr-1"
                title="Toggle Zoom"
              >
                {scale > 1 ? <ZoomOut className="w-4 h-4" /> : <ZoomIn className="w-4 h-4" />}
              </button>

              {/* Fullscreen Toggle */}
              <button
                onClick={() => {
                  if (!document.fullscreenElement) {
                    document.documentElement.requestFullscreen();
                    setIsFullscreen(true);
                  } else {
                    document.exitFullscreen();
                    setIsFullscreen(false);
                  }
                }}
                className="p-2 hover:bg-white/10 text-slate-300 hover:text-amber-400 rounded-full transition-colors hidden sm:block"
                title="Toggle Fullscreen"
              >
                {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
              </button>
            </motion.div>
          </div>
        )
      }
    </div >
  );
}
