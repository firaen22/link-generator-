import { ZoomIn, ZoomOut, Moon, Sun, X } from 'lucide-react';

interface ViewerHeaderProps {
  reportName: string;
  clientName: string;
  isFullscreen: boolean;
  isDarkMode: boolean;
  scale: number;
  onClose: () => void;
  onToggleDark: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
}

/** Quiet glass header. Slides up in fullscreen (behavioral — preserved). */
export function ViewerHeader({
  reportName, clientName, isFullscreen, isDarkMode, scale,
  onClose, onToggleDark, onZoomIn, onZoomOut,
}: ViewerHeaderProps) {
  return (
    <header
      className={`backdrop-blur-md border-b h-14 sm:h-16 flex items-center justify-between px-3 sm:px-6 fixed top-0 w-full z-50 transition-all duration-500 ease-in-out ${isFullscreen ? '-translate-y-full opacity-0' : 'translate-y-0 opacity-100'} ${isDarkMode ? 'bg-[#1B1C20]/85 border-white/10' : 'bg-[rgba(252,251,249,0.85)] border-slate-200/60'}`}
    >
      {/* Signature: a single restrained gold hairline */}
      <div className="absolute top-0 left-0 w-full h-px bg-gradient-to-r from-transparent via-[#B8964F]/55 to-transparent" />

      {/* Left: Close & Report Details */}
      <div className="flex items-center gap-3 sm:gap-4 min-w-0">
        <button
          onClick={onClose}
          aria-label="關閉報告"
          title="關閉報告"
          className={`shrink-0 min-h-11 min-w-11 flex items-center justify-center rounded-xl transition-all active:scale-90 ${isDarkMode ? 'hover:bg-white/10 text-slate-400 hover:text-white' : 'hover:bg-slate-100 text-slate-500'}`}
        >
          <X className="w-5 h-5" />
        </button>

        <div className="flex flex-col min-w-0">
          <h1 className={`text-sm font-medium leading-tight truncate max-w-[60vw] sm:max-w-md ${isDarkMode ? 'text-slate-100' : 'text-[#1C2A3A]'}`}>
            {reportName}
          </h1>
          <span className={`text-xs mt-0.5 truncate ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
            {clientName}
          </span>
        </div>
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-2 sm:gap-3 shrink-0">
        <button
          onClick={onToggleDark}
          aria-label={isDarkMode ? '切換至淺色模式' : '切換至深色模式'}
          aria-pressed={isDarkMode}
          title={isDarkMode ? '切換至淺色模式' : '切換至深色模式'}
          className={`min-h-11 min-w-11 flex items-center justify-center rounded-xl transition-all ${isDarkMode ? 'text-[#C6A867] hover:bg-white/10' : 'text-slate-500 hover:text-[#B8964F] hover:bg-slate-100'}`}
        >
          {isDarkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
        </button>

        {/* Zoom controls (desktop) */}
        <div className={`hidden md:flex items-center gap-1 rounded-xl p-1 border ${isDarkMode ? 'bg-white/5 border-white/10' : 'bg-white border-slate-200'}`}>
          <button
            onClick={onZoomOut}
            aria-label="縮小"
            title="縮小"
            className={`min-h-9 min-w-9 flex items-center justify-center rounded-lg transition-all active:scale-95 ${isDarkMode ? 'hover:bg-white/10 text-slate-400' : 'hover:bg-slate-100 text-slate-600'}`}
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <span className={`text-xs font-medium w-12 text-center select-none ${isDarkMode ? 'text-slate-300' : 'text-slate-600'}`}>
            {Math.round(scale * 100)}%
          </span>
          <button
            onClick={onZoomIn}
            aria-label="放大"
            title="放大"
            className={`min-h-9 min-w-9 flex items-center justify-center rounded-lg transition-all active:scale-95 ${isDarkMode ? 'hover:bg-white/10 text-slate-400' : 'hover:bg-slate-100 text-slate-600'}`}
          >
            <ZoomIn className="w-4 h-4" />
          </button>
        </div>
      </div>
    </header>
  );
}
