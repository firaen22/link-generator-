import { useState, useRef, useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { pdfjs } from 'react-pdf';
import { X } from 'lucide-react';

import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

import { resolveReportParams } from './viewer/utils/resolveReportParams';
import { useTelemetry } from './viewer/hooks/useTelemetry';
import { usePageNavigation } from './viewer/hooks/usePageNavigation';
import { useFullscreen } from './viewer/hooks/useFullscreen';
import { useContentGuard } from './viewer/hooks/useContentGuard';
import { usePdfZoom } from './viewer/hooks/usePdfZoom';
import { useContainerWidth } from './viewer/hooks/useContainerWidth';
import { useFitHeight } from './viewer/hooks/useFitHeight';
import { useToast } from './viewer/hooks/useToast';
import { ViewerHeader } from './viewer/components/ViewerHeader';
import { PdfStage } from './viewer/components/PdfStage';
import { BottomNavBar } from './viewer/components/BottomNavBar';
import { DisclaimerModal } from './viewer/components/DisclaimerModal';
import { SafeExitScreen } from './viewer/components/SafeExitScreen';
import { Toast } from './viewer/components/Toast';

const FONT_STACK = "'PingFang TC','Noto Sans TC',-apple-system,'Segoe UI',sans-serif";

export default function Viewer() {
  const { fileId: fileIdParam } = useParams();
  const [searchParams] = useSearchParams();

  const { clientName, reportName, fileId, pdfUrl, whatsappNumber } = resolveReportParams(searchParams, fileIdParam);

  // Cross-cutting state owned by the orchestrator
  const [numPages, setNumPages] = useState<number | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [showDisclaimer, setShowDisclaimer] = useState(true);
  const [isClosed, setIsClosed] = useState(false);

  // The single scrollable <main> element, shared (by reference) with telemetry
  // (scroll/zoom sampling) and navigation (swipe binding).
  const containerRef = useRef<HTMLDivElement>(null);

  // Persist last read page so a returning reader resumes where they left off.
  useEffect(() => {
    if (numPages) {
      try {
        localStorage.setItem(`ag_lastpage_${fileId}`, String(pageNumber));
      } catch (e) {
        // ignore storage errors (quota, privacy)
      }
    }
  }, [pageNumber, numPages, fileId]);

  // Fire the swipe hint once: the left/right swipe (usePageNavigation) is a hidden
  // gesture, so touch clients get a one-time cue. Skipped on mouse/desktop and
  // single-page docs (nothing to flip to).
  const swipeHintShownRef = useRef(false);

  const { scale, zoomIn, zoomOut } = usePdfZoom();
  const containerWidth = useContainerWidth();
  const { isFullscreen, toggleFullscreen } = useFullscreen();

  // Wraps the page; its padding-bottom reserves the floating bottom bar (incl.
  // safe-area inset). Measured by useFitHeight so the page fit is exact.
  const contentRef = useRef<HTMLDivElement>(null);

  // Real vertical room for the page, measured from the live layout. Re-measured
  // on the fullscreen toggle (it changes <main>'s top padding). Drives fit-to-
  // page so the whole page is visible without scrolling at 100% zoom.
  const availableHeight = useFitHeight(containerRef, contentRef, isFullscreen);

  const { toast, showToast } = useToast();

  const {
    sendTrackingEvent, markOpenTracked, recordCtaClick,
    numPagesRef, scaleRef, handleExitRef,
  } = useTelemetry({ fileId, clientName, reportName, pageNumber, scale, numPages, loading, containerRef });

  const { previousPage, nextPage } = usePageNavigation({
    setPageNumber, numPages, numPagesRef, scaleRef, containerRef, showDisclaimer,
  });

  const { isWindowFocused } = useContentGuard({ sendTrackingEvent, numPages, pageNumber, showToast });

  // Shown after the disclaimer is dismissed and the PDF has loaded — whichever
  // happens last calls this; the ref guard keeps it to a single appearance.
  const maybeShowSwipeHint = (totalPages: number | null) => {
    if (swipeHintShownRef.current) return;
    if (!totalPages || totalPages <= 1) return;
    if (!window.matchMedia('(pointer: coarse)').matches) return;
    swipeHintShownRef.current = true;
    showToast('💡 左右滑動即可翻頁');
  };

  const handleManualClose = () => {
    if (handleExitRef.current) handleExitRef.current();
    setIsClosed(true);
    // 延遲一點點確保存檔後嘗試自動關閉分頁
    setTimeout(() => { window.close(); }, 300);
  };

  function onDocumentLoadSuccess(loadedNumPages: number) {
    setNumPages(loadedNumPages);
    setLoading(false);
    markOpenTracked(loadedNumPages);
    // Restore last read page if available
    try {
      const stored = localStorage.getItem(`ag_lastpage_${fileId}`) || '';
      // Strict digits-only parse: "2.9" / "2abc" must not restore.
      const saved = /^[1-9]\d*$/.test(stored) ? Number(stored) : NaN;
      if (Number.isInteger(saved) && saved >= 2 && saved <= loadedNumPages && saved !== pageNumber) {
        setPageNumber(saved);
        showToast('已回到上次閱讀位置');
      }
    } catch (e) {
      // ignore storage errors (e.g., privacy mode)
    }
    if (!showDisclaimer) maybeShowSwipeHint(loadedNumPages);
  }

  const handleCtaClick = (page: number) => {
    recordCtaClick(page);
    window.open(`https://wa.me/${whatsappNumber}`, '_blank');
  };

  if (isClosed) {
    return <SafeExitScreen isDarkMode={isDarkMode} />;
  }

  return (
    <div
      className={`min-h-dvh flex flex-col transition-colors duration-300 ${isDarkMode ? 'bg-[#15161A] text-slate-200' : 'bg-[#F5F4F1] text-[#1C2A3A]'}`}
      style={{ fontFamily: FONT_STACK }}
    >
      {showDisclaimer && (
        <DisclaimerModal isDarkMode={isDarkMode} onDismiss={() => { setShowDisclaimer(false); maybeShowSwipeHint(numPages); }} />
      )}

      <ViewerHeader
        reportName={reportName}
        clientName={clientName}
        isFullscreen={isFullscreen}
        isDarkMode={isDarkMode}
        scale={scale}
        onClose={handleManualClose}
        onToggleDark={() => setIsDarkMode(!isDarkMode)}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
      />

      <main
        className={`cs-mask flex-1 flex justify-center overflow-y-auto overscroll-contain scroll-smooth select-none transition-all duration-500 ease-in-out relative ${isFullscreen
          ? `pt-4 sm:pt-6 ${isDarkMode ? 'bg-[#0e0f12]' : 'bg-[#1C2A3A]'}`
          : `pt-16 sm:pt-20 ${isDarkMode ? 'bg-[#15161A]' : 'bg-[#F5F4F1]'}`
          } ${(isWindowFocused || isFullscreen)
            ? ''
            : 'opacity-0 blur-3xl select-none pointer-events-none'
          }`}
        ref={containerRef}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div ref={contentRef} className="w-full max-w-6xl flex flex-col items-center" style={{ paddingBottom: 'calc(7rem + env(safe-area-inset-bottom))' }}>
          <PdfStage
            pdfUrl={pdfUrl}
            pageNumber={pageNumber}
            scale={scale}
            containerWidth={containerWidth}
            availableHeight={availableHeight}
            isDarkMode={isDarkMode}
            clientName={clientName}
            loadError={loadError}
            onLoadSuccess={onDocumentLoadSuccess}
            onLoadError={(error) => {
              console.error('Error loading PDF:', error);
              setLoadError(error.message);
            }}
          />

          {numPages && (
            <div className="mt-8 mb-8 w-full flex justify-center">
              <button
                onClick={handleManualClose}
                className={`flex items-center gap-2 min-h-11 px-5 py-3 rounded-xl text-sm font-medium transition-all active:scale-95 border ${isDarkMode
                  ? 'bg-white/5 text-slate-300 hover:bg-white/10 border-white/10'
                  : 'bg-white text-slate-600 hover:bg-slate-50 border-slate-200'
                  }`}
              >
                <X className="w-4 h-4 text-red-500" />
                安全結束並關閉報告
              </button>
            </div>
          )}
        </div>
      </main>

      <BottomNavBar
        pageNumber={pageNumber}
        numPages={numPages}
        isFullscreen={isFullscreen}
        isDarkMode={isDarkMode}
        onPrev={previousPage}
        onNext={nextPage}
        onToggleFullscreen={toggleFullscreen}
        onCtaClick={handleCtaClick}
      />

      <Toast message={toast} isDarkMode={isDarkMode} />
    </div>
  );
}
