import { useEffect, useRef } from 'react';
import type React from 'react';
import { motion } from 'motion/react';
import { ShieldCheck, AlertCircle, ChevronDown } from 'lucide-react';

/**
 * HK-residency consent gate. Quiet Premium styling + a real accessible dialog
 * (role/aria + initial focus). Copy is honest: the prior "AI 智能篩選市場資訊"
 * claim (which the system never did) is gone. The headline stays light so the
 * client doesn't feel watched on open; the anonymous-tracking disclosure still
 * lives — truthfully — in the in-modal <details> ("私隱與免責詳情") that replaced
 * the native alert().
 */
export function DisclaimerModal({ isDarkMode, onDismiss }: { isDarkMode: boolean; onDismiss: () => void }) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => { confirmRef.current?.focus(); }, []);

  // Focus trap: Tab cycles within the dialog. Esc deliberately does NOT dismiss —
  // this is a consent gate, so leaving requires the explicit confirm button.
  const handleTrapKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusables = dialog.querySelectorAll<HTMLElement>(
      'button, summary, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
      <motion.div
        ref={dialogRef}
        onKeyDown={handleTrapKeyDown}
        role="dialog"
        aria-modal="true"
        aria-labelledby="disclaimer-title"
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.22, ease: 'easeOut' }}
        className={`rounded-2xl w-full max-w-md overflow-hidden border ${isDarkMode ? 'bg-[#1B1C20] border-white/10' : 'bg-white border-slate-200'}`}
      >
        <div className="px-6 py-8 sm:p-8">
          <div className={`w-12 h-12 rounded-full flex items-center justify-center mb-5 ${isDarkMode ? 'bg-white/5 text-[#C6A867]' : 'bg-slate-100 text-[#B8964F]'}`}>
            <ShieldCheck className="w-6 h-6" />
          </div>

          <h2 id="disclaimer-title" className={`text-lg font-medium mb-4 ${isDarkMode ? 'text-slate-100' : 'text-[#1C2A3A]'}`}>
            香港境內確認及免責提示
          </h2>

          <div className={`space-y-4 text-[15px] leading-relaxed mb-6 ${isDarkMode ? 'text-slate-300' : 'text-slate-600'}`}>
            <p>本報告由您的顧問私人分享，僅供香港境內人士參考。</p>
            <div className={`p-3.5 rounded-xl text-sm border ${isDarkMode ? 'bg-white/5 border-white/10 text-slate-400' : 'bg-slate-50 border-slate-200 text-slate-500'}`}>
              <strong className="text-red-500 font-medium mb-1 flex items-center gap-1.5"><AlertCircle className="w-3.5 h-3.5" /> 聲明並請注意：</strong>
              本人在此聲明並確認，本人目前位於香港境內。本系統推送之所有內容僅供資訊參考，不構成任何投資邀約或建議。
            </div>
          </div>

          <details className={`group mb-7 rounded-xl border ${isDarkMode ? 'border-white/10' : 'border-slate-200'}`}>
            <summary className={`flex items-center justify-between cursor-pointer list-none px-3.5 py-3 text-sm font-medium rounded-xl transition-colors ${isDarkMode ? 'text-slate-300 hover:bg-white/5' : 'text-slate-600 hover:bg-slate-50'}`}>
              私隱與免責詳情
              <ChevronDown className="w-4 h-4 transition-transform group-open:rotate-180" />
            </summary>
            <div className={`px-3.5 pb-3.5 pt-1 text-[14px] sm:text-[13px] leading-relaxed ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
              本系統僅供香港境內人士閱讀。本人在此聲明並確認，本人目前位於香港境內。本系統會以匿名方式記錄系統互動以提升服務質素。所有市場分析與數據僅供資訊參考，不構成任何形式的投資建議、邀約或指導。閣下在作出任何投資決定前，應獨立評估相關風險，並考慮尋求專業意見。投資涉及風險，證券價格可升可跌。
            </div>
          </details>

          <button
            ref={confirmRef}
            onClick={onDismiss}
            className="w-full min-h-11 bg-[#1C2A3A] text-white font-medium py-3 px-5 rounded-xl hover:opacity-95 transition-all active:scale-[0.98]"
          >
            確認位於香港並繼續
          </button>
        </div>
      </motion.div>
    </div>
  );
}
