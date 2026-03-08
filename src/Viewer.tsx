import React, { useState, useEffect, useRef } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Document, Page, pdfjs } from 'react-pdf';
import {
  ChevronLeft, ChevronRight, Clock, Eye, AlertCircle, Calendar,
  ZoomIn, ZoomOut, Maximize, Minimize, Download, FileText, Moon, Sun, LayoutPanelTop, X
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

import LZString from 'lz-string';

declare global {
  interface Window {
    gtag: (command: string, ...args: any[]) => void;
    dataLayer: any[];
    _uxa?: any[];
  }
}

export default function Viewer() {
  const { fileId: fileIdParam } = useParams();
  const [searchParams] = useSearchParams();
  const [loadError, setLoadError] = useState<string | null>(null);

  // Initial values from query/params
  const q = searchParams.get('q');
  let clientName = searchParams.get('c') || searchParams.get('client_name') || searchParams.get('name') || '貴客';
  let reportName = searchParams.get('r') || searchParams.get('report_name') || 'Document';
  let initialFileId = fileIdParam;
  let fileFromProp = '';

  // Handle compressed payload
  if (q) {
    try {
      const decoded = JSON.parse(LZString.decompressFromEncodedURIComponent(q));
      if (decoded) {
        if (decoded.c) clientName = decoded.c;
        if (decoded.r) reportName = decoded.r;
        if (decoded.f) fileFromProp = decoded.f;
      }
    } catch (e) {
      console.error("Failed to decode compressed payload:", e);
    }
  }

  const toUrlSafeBase64 = (str: string) => {
    // Standard trick to btoa Unicode strings: utf-8 -> latin1 -> btoa
    try {
      const latin1 = unescape(encodeURIComponent(str));
      return btoa(latin1).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    } catch (e) {
      console.error("Base64 encoding error:", e);
      return "";
    }
  };

  const fileId = initialFileId || (fileFromProp ? (
    fileFromProp.startsWith('reports/')
      ? `f_${toUrlSafeBase64(fileFromProp)}`
      : `vblob_${toUrlSafeBase64(fileFromProp)}`
  ) : '');

  const [numPages, setNumPages] = useState<number | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
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
  const [isClosed, setIsClosed] = useState(false);

  // Expose exit handler for manual closing
  const handleExitRef = useRef<(() => void) | null>(null);

  const handleManualClose = () => {
    if (handleExitRef.current) handleExitRef.current();
    setIsClosed(true);
    // 延遲一點點確保存檔後嘗試自動關閉分頁
    setTimeout(() => {
      window.close();
    }, 300);
  };

  // 1. Unified Fullscreen Control (with native & software fallback)
  const toggleFullscreen = async () => {
    try {
      if (!isFullscreen) {
        if (document.documentElement.requestFullscreen) {
          await document.documentElement.requestFullscreen();
        } else if ((document.documentElement as any).webkitRequestFullscreen) {
          await (document.documentElement as any).webkitRequestFullscreen();
        } else {
          // Fallback (Software Focus Mode for Mobile Safari)
          setIsFullscreen(true);
        }
      } else {
        if (document.exitFullscreen && document.fullscreenElement) {
          await document.exitFullscreen();
        } else if ((document as any).webkitExitFullscreen && (document as any).webkitFullscreenElement) {
          await (document as any).webkitExitFullscreen();
        } else {
          // Fallback exit
          setIsFullscreen(false);
        }
      }
    } catch (err) {
      console.error("Fullscreen toggle error:", err);
      setIsFullscreen(!isFullscreen); // Ensure software fallback works even on API failure
    }
  };

  // 2. Listen to native browser fullscreen changes (e.g. user pressing ESC)
  useEffect(() => {
    const handleFullscreenChange = () => {
      const isNativeFull = !!(document.fullscreenElement || (document as any).webkitFullscreenElement);
      setIsFullscreen(isNativeFull);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
    };
  }, []);

  // Focus Mode / Personal Pacing tracking
  const [estLeftMins, setEstLeftMins] = useState(0);

  // 0. Session Identity
  const sessionIdRef = useRef(crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 15));

  // Tracking refs
  const startTimeRef = useRef(Date.now());
  const lastPingRef = useRef(Date.now());
  const hasTrackedOpenRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // 1. Activity Monitoring (Active vs Passive)
  const lastActivityRef = useRef(Date.now());
  const isActiveRef = useRef(true);
  const activeTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const updateActivity = () => {
      lastActivityRef.current = Date.now();
      if (!isActiveRef.current) {
        isActiveRef.current = true;
        // console.log("[TRACK] User background -> active");
      }
    };

    const activityEvents = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'];
    activityEvents.forEach(e => window.addEventListener(e, updateActivity, { passive: true }));

    // Checker: If no activity for 30s, mark as passive
    const interval = setInterval(() => {
      const now = Date.now();
      if (now - lastActivityRef.current > 30000 && isActiveRef.current) {
        isActiveRef.current = false;
        // console.log("[TRACK] User active -> idle");
      }
    }, 1000);

    return () => {
      activityEvents.forEach(e => window.removeEventListener(e, updateActivity));
      clearInterval(interval);
    };
  }, []);

  // Advanced behavior tracking
  const sessionDataRef = useRef<Record<number, { dwellMs: number, activeDwellMs: number, maxScale: number }>>({});
  const navigationPathRef = useRef<number[]>([]);
  const currentPageRef = useRef(1);
  const pageEnterTimeRef = useRef(Date.now());
  const hasSentSessionEndRef = useRef(false);
  const scaleRef = useRef(1.0);
  const numPagesRef = useRef<number | null>(null);

  useEffect(() => { scaleRef.current = scale; }, [scale]);
  useEffect(() => { numPagesRef.current = numPages; }, [numPages]);

  // LocalStorage Key for this specific report session
  const storageKey = `ag_report_log_${fileId}_${clientName}`;

  // Helper to accumulate telemetry
  const updateSessionData = (pageNum: number, durationMs: number, currentScale: number, wasActive: boolean) => {
    if (!sessionDataRef.current[pageNum]) {
      sessionDataRef.current[pageNum] = { dwellMs: 0, activeDwellMs: 0, maxScale: 1.0 };
    }
    sessionDataRef.current[pageNum].dwellMs += durationMs;
    if (wasActive) {
      sessionDataRef.current[pageNum].activeDwellMs += durationMs;
    }
    if (currentScale > sessionDataRef.current[pageNum].maxScale) {
      sessionDataRef.current[pageNum].maxScale = currentScale;
    }

    // Update navigation path if it's a new entry point
    if (navigationPathRef.current[navigationPathRef.current.length - 1] !== pageNum) {
      navigationPathRef.current.push(pageNum);
    }

    // Persist to LocalStorage for robustness
    try {
      localStorage.setItem(storageKey, JSON.stringify({
        pages_data: sessionDataRef.current,
        path: navigationPathRef.current,
        startTime: startTimeRef.current,
        sessionId: sessionIdRef.current
      }));
    } catch (e) { /* ignore quota issues */ }
  };

  // Dispatch final session payload
  useEffect(() => {
    const handleExit = () => {
      // 若已發送，則跳過
      if (hasSentSessionEndRef.current) return;

      const now = Date.now();
      const durationMs = now - pageEnterTimeRef.current;

      updateSessionData(currentPageRef.current, durationMs, scaleRef.current, isActiveRef.current);

      const totalActiveTime = Math.floor((now - startTimeRef.current) / 1000);

      // 如果時間太短 (< 2s)，防誤觸不發送
      if (totalActiveTime < 2) return;

      hasSentSessionEndRef.current = true;

      const payload = {
        event: 'session_end',
        session_id: sessionIdRef.current,
        file_id: fileId,
        client_name: clientName,
        report_name: reportName,
        total_duration_sec: totalActiveTime,
        total_pages: numPagesRef.current,
        pages_data: sessionDataRef.current,
        navigation_path: navigationPathRef.current,
        timestamp: new Date().toISOString()
      };

      // Clear LocalStorage on successful (attempted) send
      localStorage.removeItem(storageKey);

      try {
        const url = '/api/session-end';
        const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
        navigator.sendBeacon(url, blob);
      } catch (err) {
        fetch('/api/session-end', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true
        }).catch(e => console.error('Session end dispatch failed', e));
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        console.log("偵測到用戶離開分頁，立即結算分析報告...");
        handleExit();
      } else if (document.visibilityState === 'visible') {
        // 客戶返回了，如果之前已經發送過報告，那我們當作新的開始
        if (hasSentSessionEndRef.current) {
          console.log("用戶重返報告，開啟全新會話 tracking...");
          hasSentSessionEndRef.current = false;
          startTimeRef.current = Date.now();
          pageEnterTimeRef.current = Date.now();
          sessionDataRef.current = {};
          navigationPathRef.current = [];
          // Note: Keep sessionId same to link segments? User requested "UUID per initialization", so we keep it.
        }
      }
    };

    handleExitRef.current = handleExit;

    window.addEventListener('beforeunload', () => handleExit());
    window.addEventListener('pagehide', () => handleExit());
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Initial check for recovery
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        sessionDataRef.current = parsed.pages_data || {};
        navigationPathRef.current = parsed.path || [];
        if (parsed.startTime) startTimeRef.current = parsed.startTime;
        if (parsed.sessionId) sessionIdRef.current = parsed.sessionId;
        console.log(`[TRACK] Recovered session ${sessionIdRef.current.slice(0, 8)} from LocalStorage`);
      } catch (e) { }
    }

    return () => {
      window.removeEventListener('beforeunload', () => handleExit());
      window.removeEventListener('pagehide', () => handleExit());
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [fileId, clientName, reportName]);

  // Track Page Dwell & Zoom Changes
  useEffect(() => {
    const now = Date.now();
    const durationMs = now - pageEnterTimeRef.current;

    // Save state for previous page
    updateSessionData(currentPageRef.current, durationMs, scaleRef.current, isActiveRef.current);

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
      session_id: sessionIdRef.current,
      file_id: fileId,
      client_name: clientName,
      report_name: reportName,
      total_pages: numPages,
      timestamp: new Date().toISOString(),
      ...data
    };

    // 1. 保留原本的後端追蹤
    fetch('/api/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(err => console.error('Tracking failed', err));

    // 2. 新增 GA4 事件追蹤
    if (typeof window.gtag === 'function') {
      window.gtag('event', event, {
        ...data,
        file_id: fileId,
        client_name: clientName,
        report_name: reportName
      });
    }

    // 3. ContentSquare 自訂事件
    // 使用 _uxa.push 傳送 Dynamic Variables，方便你喺 CS 後台 filter 數據
    if (typeof window._uxa !== 'undefined') {
      window._uxa.push(['trackDynamicVariable', { key: 'action_event', value: event }]);
      if (data.page) {
        window._uxa.push(['trackDynamicVariable', { key: 'pdf_page', value: String(data.page) }]);
      }
    }
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

  // Track page views when pageNumber changes
  useEffect(() => {
    if (!loading && numPages) {
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

  // Safe Exit Fallback Screen (for Safari/Chrome that block tab closing)
  if (isClosed) {
    return (
      <div className={`min-h-screen flex flex-col items-center justify-center font-sans ${isDarkMode ? 'bg-[#121212]' : 'bg-[#F9FAFB]'}`}>
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className={`p-8 rounded-2xl max-w-sm mx-4 w-full text-center shadow-2xl border ${isDarkMode ? 'bg-slate-900 border-slate-800 shadow-black/50' : 'bg-white border-slate-100 shadow-slate-200/50'}`}
        >
          <div className="w-16 h-16 bg-emerald-500/10 border border-emerald-500/20 text-emerald-500 rounded-full flex items-center justify-center mx-auto mb-6">
            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className={`text-xl font-bold mb-3 ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>閱覽已安全結束</h2>
          <p className={`text-sm leading-relaxed mb-8 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
            為保障您的資訊安全，文件實體已被銷毀。<br /><br />
            (若視窗無法自動關閉，請滑動關閉此 Safari/Chrome 分頁)
          </p>
          <button
            onClick={() => {
              window.close();
              window.location.href = "about:blank";
            }}
            className={`w-full font-medium py-3 px-4 rounded-xl transition-colors text-sm ${isDarkMode ? 'bg-slate-800 hover:bg-slate-700 text-slate-300' : 'bg-slate-50 hover:bg-slate-100 text-slate-600'}`}
          >
            強制關閉
          </button>
        </motion.div>
      </div>
    );
  }

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

      {/* Professional Header - 專注模式下自動往上滑動隱藏 */}
      <header className={`backdrop-blur-md border-b shadow-[0_4px_20px_rgba(0,0,0,0.03)] h-14 sm:h-16 flex items-center justify-between px-3 sm:px-6 fixed top-0 w-full z-50 transition-all duration-300 ease-in-out ${isFullscreen ? '-translate-y-full' : 'translate-y-0'} ${isDarkMode ? 'bg-[#121212]/95 border-slate-800' : 'bg-white/95 border-slate-100'}`}>
        {/* Top subtle gold line for premium feel */}
        <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-amber-300 via-amber-400 to-amber-300"></div>

        {/* Left: Close & Report Details */}
        <div className="flex items-center gap-3 sm:gap-4">
          <button
            onClick={() => {
              try {
                // 1. Try to close if running inside Telegram Mini App
                if ((window as any).Telegram && (window as any).Telegram.WebApp) {
                  (window as any).Telegram.WebApp.close();
                  return;
                }

                // 2. Clear Document immediately for security and show fallback UI
                setIsClosed(true);

                // 3. Desktop / Permissive browser close
                window.close();
                window.location.href = "about:blank";

              } catch (e) {
                console.warn('Tab close blocked by browser');
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

      {/* Main Content - 專注模式下動態調整 Padding 與背景色 */}
      <main
        className={`cs-mask flex-1 flex justify-center overflow-y-auto scroll-smooth select-none transition-all duration-500 ease-in-out relative ${isFullscreen
          ? 'pt-4 sm:pt-6 bg-slate-900' // 全螢幕：極小頂部留白 + 沉浸式深色背景
          : `pt-16 sm:pt-20 ${isDarkMode ? 'bg-[#121212]' : 'bg-[#F9FAFB]'}` // 正常：預留 Header 空間 + 使用者選的深淺色背景
          } ${(isWindowFocused && !isScreenshotting)
            ? ''
            : 'opacity-0 blur-3xl select-none pointer-events-none' // 資安防護
          }`}
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
        <div className="w-full max-w-6xl flex flex-col items-center pb-32">
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
                  <div className="text-[10px] text-red-500 font-mono bg-red-50/50 px-3 py-2 rounded-lg border border-red-100 max-w-sm mb-4">
                    <b>載入錯誤：</b> {loadError}
                  </div>
                )}
                <div className="flex gap-3">
                  <button
                    onClick={() => window.location.reload()}
                    className="px-4 py-2 bg-slate-100 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-200"
                  >
                    重試加載
                  </button>
                </div>
              </div>
            }
            onLoadError={(error) => {
              console.error('Error loading PDF:', error);
              setLoadError(error.message);
            }}
            className="flex flex-col items-center gap-8"
          >
            <AnimatePresence mode="wait">
              <motion.div
                key={pageNumber}
                initial={{ opacity: 0, y: 15, scale: 0.98, filter: 'blur(8px)' }}
                animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
                exit={{ opacity: 0, y: -15, scale: 0.98, filter: 'blur(8px)' }}
                transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                className="relative"
              >
                <Page
                  pageNumber={pageNumber}
                  scale={scale}
                  width={Math.min(containerWidth - 32, 1000)}
                  renderTextLayer={true}
                  renderAnnotationLayer={true}
                  className="shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-slate-100 rounded-sm bg-white"
                  loading={null}
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
            </AnimatePresence>
          </Document>

          {/* Manual Close Button underneath document */}
          {numPages && (
            <div className="mt-8 mb-8 w-full flex justify-center">
              <button
                onClick={handleManualClose}
                className={`flex items-center gap-2 px-6 py-3.5 rounded-2xl font-medium transition-all shadow-lg hover:shadow-xl active:scale-95 border ${isDarkMode
                  ? 'bg-slate-800 text-slate-300 hover:bg-slate-700 border-slate-700 shadow-black/40'
                  : 'bg-white text-slate-700 hover:bg-slate-50 border-slate-200/80 shadow-slate-200/50'
                  }`}
              >
                <div className="bg-red-500/10 p-1.5 rounded-full">
                  <X className="w-5 h-5 text-red-500" />
                </div>
                安全結束並關閉報告
              </button>
            </div>
          )}
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

              {/* WhatsApp Appointment */}
              <button
                onClick={() => {
                  sendTrackingEvent('click_appointment');
                  // 使用你的 WhatsApp 連結
                  window.open('https://wa.me/85265387638', '_blank');
                }}
                className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold transition-all animate-pulse mr-2 bg-amber-500 text-blue-950 shadow-lg shadow-amber-500/40 scale-105 hover:bg-amber-400"
              >
                <Calendar className="w-3.5 h-3.5" />
                {/* 更新文字：與顧問預約 15 分鐘 */}
                <span className="hidden sm:inline">與顧問預約 15 分鐘</span>
                <span className="sm:hidden">預約顧問</span>
              </button>

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
                onClick={toggleFullscreen}
                className="p-1.5 sm:p-2 hover:bg-white/10 text-slate-300 hover:text-amber-400 rounded-full transition-colors block"
                title={isFullscreen ? "Exit Fullscreen" : "Maximize View"}
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
