import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { ChevronLeft, ChevronRight, Calendar, Maximize, Minimize, ZoomIn, ZoomOut } from 'lucide-react';

interface BottomNavBarProps {
  pageNumber: number;
  numPages: number | null;
  isFullscreen: boolean;
  isDarkMode: boolean;
  scale: number;
  onPrev: () => void;
  onNext: () => void;
  onJumpToPage: (page: number) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onToggleFullscreen: () => void;
  onCtaClick: (page: number) => void;
}

/** Floating bottom bar: page-turn + tappable counter (jump to page), a separated
 *  WhatsApp CTA, fullscreen, and zoom controls while fullscreen (the header —
 *  and its zoom — slides away in fullscreen). */
export function BottomNavBar({
  pageNumber, numPages, isFullscreen, isDarkMode, scale,
  onPrev, onNext, onJumpToPage, onZoomIn, onZoomOut, onToggleFullscreen, onCtaClick,
}: BottomNavBarProps) {
  const [editingPage, setEditingPage] = useState(false);
  const [pageInput, setPageInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingPage) inputRef.current?.focus();
  }, [editingPage]);

  if (!numPages) return null;

  const surface = isDarkMode
    ? 'bg-[#1B1C20]/92 border-white/10 text-slate-200'
    : 'bg-[rgba(252,251,249,0.92)] border-slate-200/70 text-slate-700';
  const ghostBtn = isDarkMode
    ? 'text-slate-400 hover:bg-white/10 hover:text-white'
    : 'text-slate-500 hover:bg-slate-100 hover:text-[#1C2A3A]';

  const commitPageInput = () => {
    setEditingPage(false);
    // Strict digits-only parse: "2.9" / "2abc" must not jump.
    if (/^[1-9]\d*$/.test(pageInput)) onJumpToPage(Number(pageInput));
    setPageInput('');
  };

  return (
    <div
      className="fixed bottom-6 sm:bottom-10 left-1/2 -translate-x-1/2 z-50 w-full max-w-md sm:max-w-xl px-4 flex justify-center gap-2.5"
      style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
    >
      <motion.div
        initial={{ y: 40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.3, ease: 'easeOut' }}
        className={`backdrop-blur-xl pl-1.5 pr-2 py-1.5 rounded-2xl shadow-[0_6px_20px_rgba(0,0,0,0.10)] border flex items-center gap-1 ${surface}`}
      >
        <button
          onClick={onPrev}
          disabled={pageNumber <= 1}
          aria-label="上一頁"
          title="上一頁"
          className={`min-h-11 min-w-11 flex items-center justify-center rounded-xl disabled:opacity-25 transition-all active:scale-90 ${ghostBtn}`}
        >
          <ChevronLeft className="w-5 h-5" />
        </button>

        {editingPage ? (
          <form
            className="px-1 flex items-center gap-1 whitespace-nowrap"
            onSubmit={(e) => { e.preventDefault(); commitPageInput(); }}
          >
            <input
              ref={inputRef}
              type="text"
              inputMode="numeric"
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ''))}
              onBlur={commitPageInput}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setEditingPage(false); setPageInput(''); }
              }}
              aria-label="跳至頁碼"
              placeholder={String(pageNumber)}
              className={`w-12 min-h-9 text-center text-[13px] font-medium rounded-lg border outline-none ${isDarkMode
                ? 'bg-white/5 border-white/15 text-slate-200 placeholder:text-slate-500'
                : 'bg-white border-slate-300 text-slate-700 placeholder:text-slate-400'
                }`}
            />
            <span className="text-[13px] font-medium select-none">/ {numPages}</span>
          </form>
        ) : (
          <button
            onClick={() => setEditingPage(true)}
            aria-label={`第 ${pageNumber} 頁，共 ${numPages} 頁。跳至指定頁碼`}
            title="跳至指定頁碼"
            className={`px-3 min-h-11 text-[13px] font-medium whitespace-nowrap rounded-xl transition-all ${ghostBtn}`}
          >
            <span aria-live="polite">
              {isFullscreen ? `${pageNumber} / ${numPages}` : `第 ${pageNumber} / ${numPages} 頁`}
            </span>
          </button>
        )}

        <button
          onClick={onNext}
          disabled={pageNumber >= (numPages || 1)}
          aria-label="下一頁"
          title="下一頁"
          className={`min-h-11 min-w-11 flex items-center justify-center rounded-xl disabled:opacity-25 transition-all active:scale-90 ${ghostBtn}`}
        >
          <ChevronRight className="w-5 h-5" />
        </button>

        {/* Zoom lives in the header, which slides away in fullscreen — so it
            surfaces here only while fullscreen. */}
        {isFullscreen && (
          <>
            <div className={`h-6 w-px mx-1 ${isDarkMode ? 'bg-white/10' : 'bg-slate-200'}`} />
            <button
              onClick={onZoomOut}
              aria-label="縮小"
              title={`縮小（目前 ${Math.round(scale * 100)}%）`}
              className={`min-h-11 min-w-11 flex items-center justify-center rounded-xl transition-all active:scale-90 ${ghostBtn}`}
            >
              <ZoomOut className="w-5 h-5" />
            </button>
            <button
              onClick={onZoomIn}
              aria-label="放大"
              title={`放大（目前 ${Math.round(scale * 100)}%）`}
              className={`min-h-11 min-w-11 flex items-center justify-center rounded-xl transition-all active:scale-90 ${ghostBtn}`}
            >
              <ZoomIn className="w-5 h-5" />
            </button>
          </>
        )}

        <div className={`hidden sm:block h-6 w-px mx-1 ${isDarkMode ? 'bg-white/10' : 'bg-slate-200'}`} />

        <button
          onClick={onToggleFullscreen}
          aria-label={isFullscreen ? '退出全螢幕' : '進入全螢幕'}
          aria-pressed={isFullscreen}
          title={isFullscreen ? '退出全螢幕' : '進入全螢幕'}
          className={`flex min-h-11 min-w-11 items-center justify-center rounded-xl transition-all active:scale-90 ${isFullscreen ? (isDarkMode ? 'text-[#C6A867] bg-white/10' : 'text-[#B8964F] bg-slate-100') : ghostBtn}`}
        >
          {isFullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
        </button>
      </motion.div>

      {/* Commercial CTA — separated from page-turn, quiet outline (no gradient/sheen).
          In fullscreen the pill gains zoom buttons, so on phones the CTA yields
          the space; it stays visible on sm+ and returns on exiting fullscreen. */}
      <motion.button
        initial={{ y: 40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.3, ease: 'easeOut', delay: 0.05 }}
        onClick={() => onCtaClick(pageNumber)}
        className={`${isFullscreen ? 'hidden sm:flex' : 'flex'} min-h-11 backdrop-blur-xl items-center gap-2 px-4 rounded-2xl text-[13px] font-medium border shadow-[0_6px_20px_rgba(0,0,0,0.10)] transition-all active:scale-95 ${isDarkMode ? 'bg-[#1B1C20]/92 border-[#C6A867]/40 text-[#C6A867] hover:bg-white/5' : 'bg-[rgba(252,251,249,0.92)] border-[#B8964F]/40 text-[#9c7d3f] hover:bg-white'}`}
      >
        <Calendar className="w-4 h-4" />
        <span className="hidden sm:inline">預約顧問 (15分鐘)</span>
        <span className="sm:hidden">預約顧問</span>
      </motion.button>
    </div>
  );
}
