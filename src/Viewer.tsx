import { useState, useRef, useEffect, useCallback } from 'react';
import type { TouchEvent } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { pdfjs } from 'react-pdf';
import { TransformComponent, TransformWrapper } from 'react-zoom-pan-pinch';
import type { ReactZoomPanPinchContentRef, ReactZoomPanPinchRef } from 'react-zoom-pan-pinch';
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
import { useJargon } from './viewer/hooks/useJargon';
import { ViewerHeader } from './viewer/components/ViewerHeader';
import { PdfStage } from './viewer/components/PdfStage';
import { TextModeView } from './viewer/components/TextModeView';
import { BottomNavBar } from './viewer/components/BottomNavBar';
import { JargonCard } from './viewer/components/JargonCard';
import { DisclaimerModal } from './viewer/components/DisclaimerModal';
import { SafeExitScreen } from './viewer/components/SafeExitScreen';
import { Toast } from './viewer/components/Toast';

const FONT_STACK = "'PingFang TC','Noto Sans TC',-apple-system,'Segoe UI',sans-serif";
const MIN_PDF_SCALE = 0.5;
const MAX_PDF_SCALE = 2.0;
const DOUBLE_TAP_MAX_DELAY_MS = 300;
const DOUBLE_TAP_MAX_DISTANCE_PX = 40;

function clampPdfScale(next: number) {
  return Math.min(Math.max(next, MIN_PDF_SCALE), MAX_PDF_SCALE);
}

export default function Viewer() {
  const { fileId: fileIdParam } = useParams();
  const [searchParams] = useSearchParams();

  const { clientName, reportName, fileId, pdfUrl, whatsappNumber } = resolveReportParams(searchParams, fileIdParam);

  // Cross-cutting state owned by the orchestrator
  const [numPages, setNumPages] = useState<number | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Dark mode: restore the reader's saved choice, else follow the OS preference.
  const [isDarkMode, setIsDarkMode] = useState(() => {
    try {
      const stored = localStorage.getItem('ag_darkmode');
      if (stored === '1') return true;
      if (stored === '0') return false;
    } catch (e) {
      // ignore storage errors (privacy mode)
    }
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  });
  const [showDisclaimer, setShowDisclaimer] = useState(true);
  const [isClosed, setIsClosed] = useState(false);
  // Text mode: render the page's extracted text as readable prose instead of
  // the (tiny-at-fit-width) canvas. Extraction happens in PdfStage regardless,
  // so the map fills page-by-page as the reader flips.
  const [isTextMode, setIsTextMode] = useState(false);
  const [pageTexts, setPageTexts] = useState<Record<number, string>>({});

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

  const { scale, setScale, zoomIn, zoomOut } = usePdfZoom();
  const containerWidth = useContainerWidth();
  const { isFullscreen, toggleFullscreen } = useFullscreen();

  // Wraps the page; its padding-bottom reserves the floating bottom bar (incl.
  // safe-area inset). Measured by useFitHeight so the page fit is exact.
  const contentRef = useRef<HTMLDivElement>(null);

  // Real vertical room for the page, measured from the live layout. Re-measured
  // on the fullscreen toggle (it changes <main>'s top padding). Drives fit-to-
  // page so the whole page is visible without scrolling at 100% zoom.
  const availableHeight = useFitHeight(containerRef, contentRef, isFullscreen);
  const transformRef = useRef<ReactZoomPanPinchContentRef | null>(null);
  const committedScaleRef = useRef(scale);
  const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(null);

  useEffect(() => {
    committedScaleRef.current = scale;
  }, [scale]);

  const { toast, showToast } = useToast();

  const {
    sendTrackingEvent, markOpenTracked, recordCtaClick,
    numPagesRef, scaleRef, handleExitRef,
  } = useTelemetry({ fileId, clientName, reportName, pageNumber, scale, numPages, loading, containerRef });

  const { previousPage, nextPage } = usePageNavigation({
    setPageNumber, numPages, numPagesRef, scaleRef, containerRef, showDisclaimer,
  });

  const { isWindowFocused } = useContentGuard({ sendTrackingEvent, numPages, pageNumber, showToast });
  const jargonEnabled = !showDisclaimer && !isClosed && !loadError;
  const jargon = useJargon({ enabled: jargonEnabled, pdfUrl, fileId });

  // Single stable sink for PdfStage's per-page extraction: stores the text for
  // text mode (first result wins) and forwards to the jargon pipeline when
  // enabled. Must be useCallback — PdfStage's extraction effect keys on it.
  const handlePageText = useCallback((page: number, text: string, imageDataUrl?: string) => {
    setPageTexts(prev => (prev[page] !== undefined ? prev : { ...prev, [page]: text }));
    if (jargonEnabled) jargon.onPageText(page, text, imageDataUrl);
  }, [jargonEnabled, jargon.onPageText]);

  useEffect(() => {
    jargon.onPageChange();
  }, [pageNumber, jargon.onPageChange]);

  // Shown after the disclaimer is dismissed and the PDF has loaded — whichever
  // happens last calls this; the ref guard keeps it to a single appearance.
  const maybeShowSwipeHint = (totalPages: number | null) => {
    if (swipeHintShownRef.current) return;
    if (!totalPages || totalPages <= 1) return;
    if (!window.matchMedia('(pointer: coarse)').matches) return;
    swipeHintShownRef.current = true;
    showToast('💡 左右滑動即可翻頁');
  };

  const handleToggleDark = () => {
    const next = !isDarkMode;
    try {
      localStorage.setItem('ag_darkmode', next ? '1' : '0');
    } catch (e) {
      // ignore storage errors (quota, privacy)
    }
    setIsDarkMode(next);
  };

  // Direct jump (from the page counter input). Clamped; pageNumber stays owned
  // here so telemetry keeps seeing every page change.
  const jumpToPage = (page: number) => {
    if (!numPages || !Number.isInteger(page)) return;
    setPageNumber(Math.min(Math.max(page, 1), numPages));
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

  const resetGestureTransform = (ref = transformRef.current) => {
    ref?.setTransform(0, 0, 1, 0);
  };

  const applyScrollCompensation = (oldScale: number, newScale: number) => {
    if (!Number.isFinite(oldScale) || oldScale === 0 || !Number.isFinite(newScale)) return;
    const el = containerRef.current;
    if (!el) return;
    const ratio = newScale / oldScale;
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    el.scrollLeft *= ratio;
    el.scrollTop *= ratio;
  };

  const commitScale = (nextScale: number) => {
    if (!Number.isFinite(nextScale) || nextScale <= 0) return;
    const previousScale = committedScaleRef.current;
    const committedScale = clampPdfScale(nextScale);
    setScale(committedScale);
    committedScaleRef.current = committedScale;
    applyScrollCompensation(previousScale, committedScale);
  };

  const handleGestureZoomStop = (ref: ReactZoomPanPinchRef) => {
    const gestureScale = ref.state.scale;
    if (!Number.isFinite(gestureScale) || gestureScale <= 0) {
      resetGestureTransform(ref);
      return;
    }
    commitScale(committedScaleRef.current * gestureScale);
    resetGestureTransform(ref);
  };

  const handleDoubleTap = (event: TouchEvent<HTMLDivElement>) => {
    if (event.changedTouches.length !== 1 || event.touches.length !== 0) return;
    const touch = event.changedTouches[0];
    const now = Date.now();
    const previousTap = lastTapRef.current;
    lastTapRef.current = { time: now, x: touch.clientX, y: touch.clientY };
    if (!previousTap || now - previousTap.time > DOUBLE_TAP_MAX_DELAY_MS) return;
    const dx = touch.clientX - previousTap.x;
    const dy = touch.clientY - previousTap.y;
    if (Math.hypot(dx, dy) > DOUBLE_TAP_MAX_DISTANCE_PX) return;
    lastTapRef.current = null;
    commitScale(committedScaleRef.current > 1.05 ? 1.0 : 1.6);
    resetGestureTransform();
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
        isTextMode={isTextMode}
        scale={scale}
        onClose={handleManualClose}
        onToggleDark={handleToggleDark}
        onToggleTextMode={() => setIsTextMode(prev => !prev)}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
      />

      <main
        className={`cs-mask flex-1 overflow-x-auto overflow-y-auto overscroll-contain scroll-smooth select-none transition-all duration-500 ease-in-out relative ${isFullscreen
          ? `pt-4 sm:pt-6 ${isDarkMode ? 'bg-[#0e0f12]' : 'bg-[#1C2A3A]'}`
          : `pt-16 sm:pt-20 ${isDarkMode ? 'bg-[#15161A]' : 'bg-[#F5F4F1]'}`
          } ${(isWindowFocused || isFullscreen)
            ? ''
            : 'opacity-0 blur-3xl select-none pointer-events-none'
          }`}
        ref={containerRef}
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* w-max + min-w-full: sized to the (possibly zoomed) page so main can
            scroll to both edges; flex/justify-center would clip the left side. */}
        <TransformWrapper
          ref={transformRef}
          minScale={0.5}
          maxScale={4}
          limitToBounds={false}
          centerZoomedOut={false}
          panning={{ disabled: true }}
          trackPadPanning={{ disabled: true }}
          wheel={{ activationKeys: ['Control', 'Meta'], step: 0.08 }}
          pinch={{ disabled: false, step: 5, allowPanning: false }}
          doubleClick={{ disabled: true }}
          onZoomStop={handleGestureZoomStop}
        >
          <TransformComponent
            wrapperClass="w-max min-w-full mx-auto"
            wrapperStyle={{ overflow: 'visible' }}
            contentStyle={{ touchAction: 'pan-x pan-y' }}
            contentProps={{ onTouchEnd: handleDoubleTap }}
          >
            <div ref={contentRef} className="w-max min-w-full mx-auto flex flex-col items-center" style={{ paddingBottom: 'calc(7rem + env(safe-area-inset-bottom))' }}>
              {/* PdfStage stays mounted in text mode (hidden) — it is the text
                  extractor and keeps the canvas warm for switching back. */}
              <div className={isTextMode ? 'hidden' : 'w-full flex flex-col items-center'}>
                <PdfStage
                  pdfUrl={pdfUrl}
                  pageNumber={pageNumber}
                  scale={scale}
                  containerWidth={containerWidth}
                  availableHeight={availableHeight}
                  isDarkMode={isDarkMode}
                  clientName={clientName}
                  onLoadSuccess={onDocumentLoadSuccess}
                  onLoadError={(error) => {
                    console.error('Error loading PDF:', error);
                    setLoadError(error.message);
                  }}
                  onPageText={handlePageText}
                />
              </div>

              {isTextMode && (
                /* Explicit viewport width: the ancestors are w-max (sized to the
                   zoomable canvas), which would let prose lines run off-screen. */
                <div className="w-screen max-w-[100vw]">
                  <TextModeView
                    text={pageTexts[pageNumber] ?? null}
                    pageNumber={pageNumber}
                    isDarkMode={isDarkMode}
                  />
                </div>
              )}

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
          </TransformComponent>
        </TransformWrapper>
      </main>

      <BottomNavBar
        pageNumber={pageNumber}
        numPages={numPages}
        isFullscreen={isFullscreen}
        isDarkMode={isDarkMode}
        scale={scale}
        onPrev={previousPage}
        onNext={nextPage}
        onJumpToPage={jumpToPage}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onToggleFullscreen={toggleFullscreen}
        onCtaClick={handleCtaClick}
      />

      {numPages !== null && !showDisclaimer && (
        <JargonCard terms={jargon.terms} isDarkMode={isDarkMode} visible={isWindowFocused || isFullscreen} />
      )}

      <Toast message={toast} isDarkMode={isDarkMode} />
    </div>
  );
}
