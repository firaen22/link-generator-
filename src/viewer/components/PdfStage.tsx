import { useState } from 'react';
import { Document, Page } from 'react-pdf';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { AlertCircle } from 'lucide-react';

interface PdfStageProps {
  pdfUrl: string;
  pageNumber: number;
  scale: number;
  containerWidth: number;
  isDarkMode: boolean;
  clientName: string;
  loadError: string | null;
  onLoadSuccess: (numPages: number) => void;
  onLoadError: (error: Error) => void;
}

/** The PDF render surface: Document/Page, honest loading + error states, the
 *  per-page turn animation, and a GPU-cheap tiled watermark. */
export function PdfStage({
  pdfUrl, pageNumber, scale, containerWidth, isDarkMode, clientName,
  loadError, onLoadSuccess, onLoadError,
}: PdfStageProps) {
  const reduceMotion = useReducedMotion();
  const [progress, setProgress] = useState<number | null>(null);

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

  return (
    <Document
      file={pdfUrl}
      onLoadSuccess={({ numPages }) => onLoadSuccess(numPages)}
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
        </div>
      }
      error={
        <div className="flex flex-col items-center justify-center h-[60vh] w-full p-8 text-center">
          <div className={`p-4 rounded-full mb-4 ${isDarkMode ? 'bg-red-500/10' : 'bg-red-50'}`}>
            <AlertCircle className="w-8 h-8 text-red-500" />
          </div>
          <h3 className={`text-lg font-medium mb-2 ${isDarkMode ? 'text-slate-100' : 'text-[#1C2A3A]'}`}>暫時無法載入此報告</h3>
          <p className={`text-sm max-w-md mx-auto mb-4 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
            請稍後再試，或直接聯絡您的顧問。
          </p>
          {loadError && (
            <div className="text-[10px] text-red-500 font-mono bg-red-50/50 px-3 py-2 rounded-lg border border-red-100 max-w-sm mb-4">
              <b>載入錯誤：</b> {loadError}
            </div>
          )}
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
              width={Math.min(containerWidth - 32, 1000)}
              renderTextLayer={true}
              renderAnnotationLayer={true}
              className={`rounded-md bg-white border ${isDarkMode ? 'border-white/10 ring-1 ring-black/5 brightness-[0.97]' : 'border-slate-200'} shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.08)]`}
              loading={null}
            />
          </motion.div>
        </AnimatePresence>

        {/* Tiled watermark — sibling of the animating page, so it isn't repainted on flip */}
        <div
          className="absolute inset-0 pointer-events-none rounded-md"
          style={{ backgroundImage: wmUrl, backgroundRepeat: 'repeat', opacity: isDarkMode ? 0.09 : 0.05 }}
        />
      </div>
    </Document>
  );
}
