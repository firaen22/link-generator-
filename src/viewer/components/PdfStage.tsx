import { useEffect, useRef, useState } from 'react';
import { Document, Page } from 'react-pdf';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { AlertCircle } from 'lucide-react';
import { extractJargonImageBase64, jargonImageDims, JARGON_MIN_TEXT_LEN } from '../jargon';

interface PdfStageProps {
  pdfUrl: string;
  pageNumber: number;
  scale: number;
  containerWidth: number;
  availableHeight: number;
  isDarkMode: boolean;
  clientName: string;
  onLoadSuccess: (numPages: number) => void;
  onLoadError: (error: Error) => void;
  onPageText?: (page: number, text: string, imageDataUrl?: string) => void;
}

/** The PDF render surface: Document/Page, honest loading + error states, the
 *  per-page turn animation, and a GPU-cheap tiled watermark. */
export function PdfStage({
  pdfUrl, pageNumber, scale, containerWidth, availableHeight, isDarkMode, clientName,
  onLoadSuccess, onLoadError, onPageText,
}: PdfStageProps) {
  const reduceMotion = useReducedMotion();
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  // True when loading has made no progress for a while — the spinner alone
  // reads as "broken" on a stalled connection, so we add a hint + retry.
  const [stalled, setStalled] = useState(false);
  // Page aspect ratio (width / height), learned from the first rendered page.
  const [aspectRatio, setAspectRatio] = useState<number | null>(null);
  // Local copy of the page count, needed to bound the next-page prefetch.
  const [numPages, setNumPages] = useState<number | null>(null);

  // Fit the whole page inside the viewport: bound by width on phones, by height
  // on desktop/landscape. `scale` then multiplies this so zoom stays an override.
  const maxWidth = Math.min(containerWidth - 32, 1000);
  const fitWidth = aspectRatio ? Math.min(maxWidth, availableHeight * aspectRatio) : maxWidth;

  // One tiled SVG node instead of 30 rotated divs — never re-rasterizes on flip.
  // NOTE: clientName is URL-controllable. It is safe HERE only because wmSvg is
  // encodeURIComponent'd into a CSS background-image data: URL — never live DOM.
  // Do NOT move wmSvg into dangerouslySetInnerHTML or an inline <svg>.
  const wmText = clientName === '貴客' ? '機密文件' : `${clientName} · 機密`;
  const wmSvg = `<svg xmlns='http://www.w3.org/2000/svg' width='280' height='190'><text x='10' y='120' transform='rotate(-30 140 95)' font-family='-apple-system, sans-serif' font-size='17' font-weight='600' fill='%231C2A3A'>${wmText}</text></svg>`;
  const wmUrl = `url("data:image/svg+xml,${encodeURIComponent(wmSvg)}")`;

  const enter = reduceMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.12 } }
    : {
        initial: { opacity: 0, y: 8 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: -8 },
        transition: { duration: 0.18, ease: 'easeOut' as const },
      };

  // Arm a 20s no-progress watchdog: reset whenever bytes arrive, disarm once
  // the document is loaded (numPages set).
  useEffect(() => {
    if (numPages !== null) return;
    setStalled(false);
    const timer = window.setTimeout(() => setStalled(true), 20000);
    return () => window.clearTimeout(timer);
  }, [progress, numPages]);

  useEffect(() => {
    const doc = docRef.current;
    if (!doc || !onPageText) return;
    let cancelled = false;
    let renderTask: RenderTask | null = null;

    const captureImage = (text: string) => {
      doc.getPage(pageNumber)
        .then(async page => {
          if (cancelled) return;
          const sourceViewport = page.getViewport({ scale: 1 });
          const target = jargonImageDims(sourceViewport.width, sourceViewport.height);
          const renderScale = sourceViewport.width > 0 ? target.width / sourceViewport.width : 1;
          const viewport = page.getViewport({ scale: renderScale });
          const canvas = document.createElement('canvas');
          canvas.width = target.width;
          canvas.height = target.height;
          const context = canvas.getContext('2d');
          if (!context) return;
          renderTask = page.render({ canvasContext: context, canvas, viewport });
          await renderTask.promise;
          renderTask = null;
          if (cancelled) return;

          let imageDataUrl = canvas.toDataURL('image/jpeg', 0.7);
          if (!extractJargonImageBase64(imageDataUrl)) {
            imageDataUrl = canvas.toDataURL('image/jpeg', 0.5);
          }
          const valid = extractJargonImageBase64(imageDataUrl);
          if (!cancelled && valid) {
            onPageText(pageNumber, text, imageDataUrl);
          }
        })
        .catch((err) => {
          if (err?.name === 'RenderingCancelledException') return;
          console.warn('Failed to capture PDF page image', err);
        });
    };

    doc.getPage(pageNumber)
      .then(page => page.getTextContent())
      .then(tc => {
        if (cancelled) return;
        const text = tc.items.map((it: any) => (typeof it.str === 'string' ? it.str : '')).join(' ');
        onPageText(pageNumber, text);
        if (text.trim().length >= JARGON_MIN_TEXT_LEN) return;
        captureImage(text);
      })
      .catch((err) => {
        console.warn('Failed to extract PDF page text', err);
        if (cancelled) return;
        onPageText(pageNumber, '');
        captureImage('');
      });

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [numPages, pageNumber, onPageText]);

  return (
    <Document
      file={pdfUrl}
      onLoadSuccess={(pdf) => {
        docRef.current = pdf;
        setNumPages(pdf.numPages);
        onLoadSuccess(pdf.numPages);
      }}
      onLoadProgress={({ loaded, total }) => {
        if (total) setProgress(Math.min(100, Math.round((loaded / total) * 100)));
      }}
      onLoadError={(error) => onLoadError(error)}
      loading={
        <div className="flex flex-col items-center justify-center h-[70vh] w-full gap-5">
          <div className={`w-10 h-10 rounded-full border-2 ${isDarkMode ? 'border-slate-700 border-t-[#C6A867]' : 'border-slate-200 border-t-[#B8964F]'} ${reduceMotion ? '' : 'animate-spin'}`} />
          <p className={`text-sm ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>正在載入報告…</p>
          {progress !== null && (
            <div className={`w-40 h-1 rounded-full overflow-hidden ${isDarkMode ? 'bg-slate-700' : 'bg-slate-200'}`}>
              <div className="h-full bg-[#B8964F] transition-[width] duration-200" style={{ width: `${progress}%` }} />
            </div>
          )}
          {stalled && (
            <>
              <p className={`text-xs max-w-xs text-center ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>
                載入時間較長，請稍作等候，或重新整理頁面
              </p>
              <button
                onClick={() => window.location.reload()}
                className={`min-h-11 px-4 py-2 rounded-xl text-sm font-medium ${isDarkMode ? 'bg-white/5 hover:bg-white/10 text-slate-300' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'}`}
              >
                重新載入
              </button>
            </>
          )}
        </div>
      }
      error={
        <div className="flex flex-col items-center justify-center h-[60vh] w-full p-8 text-center">
          <div className={`p-4 rounded-full mb-4 ${isDarkMode ? 'bg-red-500/10' : 'bg-red-50'}`}>
            <AlertCircle className="w-8 h-8 text-red-500" />
          </div>
          <h3 className={`text-lg font-medium mb-2 ${isDarkMode ? 'text-slate-100' : 'text-[#1C2A3A]'}`}>暫時無法載入此報告</h3>
          <p className={`text-sm max-w-md mx-auto mb-4 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
            請重新整理頁面，或直接聯絡您的顧問。
          </p>
          <button
            onClick={() => window.location.reload()}
            className={`min-h-11 px-4 py-2 rounded-xl text-sm font-medium ${isDarkMode ? 'bg-white/5 hover:bg-white/10 text-slate-300' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'}`}
          >
            重新載入
          </button>
        </div>
      }
      className="flex flex-col items-center gap-8"
    >
      <div className="relative">
        <AnimatePresence mode="wait">
          <motion.div
            key={pageNumber}
            initial={enter.initial}
            animate={enter.animate}
            exit={enter.exit}
            transition={enter.transition}
          >
            <Page
              pageNumber={pageNumber}
              scale={scale}
              width={fitWidth}
              onLoadSuccess={(page) => setAspectRatio(page.originalWidth / page.originalHeight)}
              renderTextLayer={true}
              renderAnnotationLayer={true}
              className={`rounded-md bg-white border ${isDarkMode ? 'border-white/10 ring-1 ring-black/5 brightness-[0.87] contrast-[1.02]' : 'border-slate-200'} shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.08)]`}
              loading={null}
            />
          </motion.div>
        </AnimatePresence>

        {/* Pre-rasterize the next page offscreen so a page turn is instant.
            Hidden + aria-hidden; no text/annotation layers (pixels only). */}
        {numPages !== null && pageNumber < numPages && (
          <div className="hidden" aria-hidden="true">
            <Page
              pageNumber={pageNumber + 1}
              scale={scale}
              width={fitWidth}
              renderTextLayer={false}
              renderAnnotationLayer={false}
              loading={null}
            />
          </div>
        )}

        {/* Tiled watermark — sibling of the animating page, so it isn't repainted on flip */}
        <div
          className="absolute inset-0 pointer-events-none rounded-md"
          style={{ backgroundImage: wmUrl, backgroundRepeat: 'repeat', opacity: isDarkMode ? 0.09 : 0.05 }}
        />
      </div>
    </Document>
  );
}
