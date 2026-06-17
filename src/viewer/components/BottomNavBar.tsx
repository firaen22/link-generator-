import { motion } from 'motion/react';
import { ChevronLeft, ChevronRight, Calendar, Maximize, Minimize } from 'lucide-react';

interface BottomNavBarProps {
  pageNumber: number;
  numPages: number | null;
  isFullscreen: boolean;
  isDarkMode: boolean;
  onPrev: () => void;
  onNext: () => void;
  onToggleFullscreen: () => void;
  onCtaClick: (page: number) => void;
}

/** Floating bottom bar: page-turn + counter, a separated WhatsApp CTA, fullscreen. */
export function BottomNavBar({
  pageNumber, numPages, isFullscreen, isDarkMode,
  onPrev, onNext, onToggleFullscreen, onCtaClick,
}: BottomNavBarProps) {
  if (!numPages) return null;

  const surface = isDarkMode
    ? 'bg-[#1B1C20]/92 border-white/10 text-slate-200'
    : 'bg-[rgba(252,251,249,0.92)] border-slate-200/70 text-slate-700';
  const ghostBtn = isDarkMode
    ? 'text-slate-400 hover:bg-white/10 hover:text-white'
    : 'text-slate-500 hover:bg-slate-100 hover:text-[#1C2A3A]';

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

        <div className="px-3 text-[13px] font-medium select-none whitespace-nowrap" aria-live="polite">
          第 {pageNumber} / {numPages} 頁
        </div>

        <button
          onClick={onNext}
          disabled={pageNumber >= (numPages || 1)}
          aria-label="下一頁"
          title="下一頁"
          className={`min-h-11 min-w-11 flex items-center justify-center rounded-xl disabled:opacity-25 transition-all active:scale-90 ${ghostBtn}`}
        >
          <ChevronRight className="w-5 h-5" />
        </button>

        <div className={`hidden sm:block h-6 w-px mx-1 ${isDarkMode ? 'bg-white/10' : 'bg-slate-200'}`} />

        <button
          onClick={onToggleFullscreen}
          aria-label={isFullscreen ? '退出全螢幕' : '進入全螢幕'}
          aria-pressed={isFullscreen}
          title={isFullscreen ? '退出全螢幕' : '進入全螢幕'}
          className={`hidden sm:flex min-h-11 min-w-11 items-center justify-center rounded-xl transition-all active:scale-90 ${isFullscreen ? (isDarkMode ? 'text-[#C6A867] bg-white/10' : 'text-[#B8964F] bg-slate-100') : ghostBtn}`}
        >
          {isFullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
        </button>
      </motion.div>

      {/* Commercial CTA — separated from page-turn, quiet outline (no gradient/sheen) */}
      <motion.button
        initial={{ y: 40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.3, ease: 'easeOut', delay: 0.05 }}
        onClick={() => onCtaClick(pageNumber)}
        className={`min-h-11 backdrop-blur-xl flex items-center gap-2 px-4 rounded-2xl text-[13px] font-medium border shadow-[0_6px_20px_rgba(0,0,0,0.10)] transition-all active:scale-95 ${isDarkMode ? 'bg-[#1B1C20]/92 border-[#C6A867]/40 text-[#C6A867] hover:bg-white/5' : 'bg-[rgba(252,251,249,0.92)] border-[#B8964F]/40 text-[#9c7d3f] hover:bg-white'}`}
      >
        <Calendar className="w-4 h-4" />
        <span className="hidden sm:inline">預約顧問 (15分鐘)</span>
        <span className="sm:hidden">預約顧問</span>
      </motion.button>
    </div>
  );
}
