import { useState, useEffect, useRef } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Document, Page, pdfjs } from 'react-pdf';
import {
  ChevronLeft, ChevronRight, Clock, Eye, AlertCircle,
  ZoomIn, ZoomOut, Maximize, Minimize, Download
} from 'lucide-react';
import { motion } from 'motion/react';

// Force consistent worker version to fix "API version does not match Worker version"
pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@5.5.207/build/pdf.worker.min.mjs`;

import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

export default function Viewer() {
  const { fileId } = useParams();
  const [searchParams] = useSearchParams();
  const [loadError, setLoadError] = useState<string | null>(null);
  const clientName = searchParams.get('client_name') || searchParams.get('name') || '貴客';
  const reportName = searchParams.get('report_name') || 'Document';

  const [numPages, setNumPages] = useState<number | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [loading, setLoading] = useState(true);
  const [timeSpent, setTimeSpent] = useState(0);
  const [scale, setScale] = useState(1.0);
  const [containerWidth, setContainerWidth] = useState(window.innerWidth);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Tracking refs
  const startTimeRef = useRef(Date.now());
  const lastPingRef = useRef(Date.now());
  const hasTrackedOpenRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Handle Window Resize
  useEffect(() => {
    const handleResize = () => setContainerWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Send tracking event to backend
  const sendTrackingEvent = (event: string, data: any = {}) => {
    const payload = {
      event,
      file_id: fileId,
      client_name: clientName,
      report_name: reportName,
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

      // Send heartbeat every 30 seconds
      if (now - lastPingRef.current > 30000) {
        sendTrackingEvent('heartbeat', { duration_seconds: sessionDuration });
        lastPingRef.current = now;
      }
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  // Forced Proxy Mode: Always route through backend to bypass CORS
  const pdfUrl = `/api/pdf/${fileId}`;

  const downloadUrl = fileId?.startsWith('vblob_')
    ? pdfUrl
    : `https://drive.google.com/file/d/${fileId}/view`;

  return (
    <div className="min-h-screen bg-[#F3F4F6] flex flex-col font-sans text-slate-900">
      {/* Professional Header */}
      <header className="bg-white border-b border-slate-200 h-16 flex items-center justify-between px-4 sm:px-6 fixed top-0 w-full z-50 shadow-sm">
        {/* Left: Brand & Title */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white font-bold text-sm shadow-md shadow-blue-200">W</div>
            <span className="font-bold text-lg tracking-tight hidden sm:block text-slate-800">Wealth OS</span>
          </div>
          <div className="h-6 w-px bg-slate-200 mx-2 hidden sm:block"></div>
          <div className="flex flex-col">
            <h1 className="text-sm font-bold text-slate-900 leading-tight truncate max-w-[150px] sm:max-w-xs">{reportName}</h1>
            <span className="text-[10px] sm:text-xs text-slate-500 font-medium truncate max-w-[150px] sm:max-w-xs">Prepared for {clientName}</span>
          </div>
        </div>

        {/* Right: Stats & Actions */}
        <div className="flex items-center gap-3 sm:gap-4">
          {/* Time Tracker */}
          <div className="hidden sm:flex items-center gap-2 text-slate-500 bg-slate-50 px-3 py-1.5 rounded-full border border-slate-100">
            <Clock className="w-3.5 h-3.5 text-slate-400" />
            <span className="text-xs font-medium font-mono">
              {Math.floor(timeSpent / 60)}:{(timeSpent % 60).toString().padStart(2, '0')}
            </span>
          </div>

          {/* Zoom Controls (Desktop) */}
          <div className="hidden md:flex items-center gap-1 bg-slate-50 rounded-lg p-1 border border-slate-200">
            <button
              onClick={zoomOut}
              className="p-1.5 hover:bg-white hover:shadow-sm rounded-md transition-all text-slate-600 active:scale-95"
              title="Zoom Out"
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <span className="text-xs font-medium w-12 text-center select-none">{Math.round(scale * 100)}%</span>
            <button
              onClick={zoomIn}
              className="p-1.5 hover:bg-white hover:shadow-sm rounded-md transition-all text-slate-600 active:scale-95"
              title="Zoom In"
            >
              <ZoomIn className="w-4 h-4" />
            </button>
          </div>

          {/* Action Button: Fullscreen placeholder or just nothing to keep protection */}
          <button
            onClick={() => setIsFullscreen(!isFullscreen)}
            className="p-2 text-slate-500 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
            title="Maximize View"
          >
            <Maximize className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main
        className="flex-1 pt-24 pb-32 px-4 flex justify-center overflow-y-auto scroll-smooth select-none"
        ref={containerRef}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div className="w-full max-w-6xl flex justify-center">
          <Document
            file={pdfUrl}
            onLoadSuccess={onDocumentLoadSuccess}
            loading={
              <div className="flex flex-col items-center justify-center h-[60vh] w-full space-y-6">
                <div className="relative w-20 h-20 flex items-center justify-center">
                  {/* Outer spinning ring */}
                  <div className="absolute inset-0 rounded-full border-t-2 border-l-2 border-blue-500 animate-[spin_1.5s_linear_infinite] opacity-70"></div>
                  {/* Inner spinning ring (reverse) */}
                  <div className="absolute inset-2 rounded-full border-b-2 border-r-2 border-indigo-600 animate-[spin_2s_linear_infinite_reverse] opacity-80"></div>
                  {/* Center logo */}
                  <div className="h-12 w-12 bg-gradient-to-tr from-blue-50 to-indigo-100 rounded-full flex items-center justify-center shadow-inner animate-pulse">
                    <div className="w-6 h-6 bg-blue-600 rounded-md flex items-center justify-center text-white font-bold text-xs shadow-md">W</div>
                  </div>
                </div>
                <div className="text-center space-y-2">
                  <h3 className="text-slate-800 font-bold text-lg">Secure Document Loading</h3>
                  <p className="text-sm text-slate-500 font-medium animate-pulse max-w-xs mx-auto">
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
                className="shadow-2xl shadow-slate-200/50 rounded-sm bg-white"
                loading={
                  <div className="h-[800px] w-[600px] bg-white shadow-xl rounded-sm animate-pulse"></div>
                }
              />
            </motion.div>
          </Document>
        </div>
      </main>

      {/* Bottom Floating Navigation Bar */}
      {numPages && (
        <div className="fixed bottom-8 left-1/2 transform -translate-x-1/2 z-50">
          <motion.div
            initial={{ y: 50, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            className="bg-slate-900/90 backdrop-blur-xl text-white pl-2 pr-4 py-1.5 rounded-full shadow-2xl flex items-center gap-3 border border-white/10 ring-1 ring-black/5"
          >
            <div className="flex items-center gap-1">
              <button
                onClick={previousPage}
                disabled={pageNumber <= 1}
                className="p-2 hover:bg-white/10 rounded-full disabled:opacity-30 disabled:hover:bg-transparent transition-colors active:scale-95"
                title="Previous Page"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>

              <span className="font-mono text-sm font-medium min-w-[60px] text-center select-none">
                {pageNumber} <span className="text-slate-500">/</span> {numPages}
              </span>

              <button
                onClick={nextPage}
                disabled={pageNumber >= numPages}
                className="p-2 hover:bg-white/10 rounded-full disabled:opacity-30 disabled:hover:bg-transparent transition-colors active:scale-95"
                title="Next Page"
              >
                <ChevronRight className="w-5 h-5" />
              </button>
            </div>

            {/* Divider */}
            <div className="w-px h-6 bg-white/20"></div>

            {/* Mobile Zoom (Simple Toggle) */}
            <button
              onClick={() => setScale(s => s === 1 ? 1.5 : 1)}
              className="p-2 hover:bg-white/10 rounded-full transition-colors md:hidden"
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
              className="p-2 hover:bg-white/10 rounded-full transition-colors hidden sm:block"
              title="Toggle Fullscreen"
            >
              {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
            </button>
          </motion.div>
        </div>
      )}
    </div>
  );
}
