import { motion } from 'motion/react';
import { Check } from 'lucide-react';

/** Shown after a manual close when the browser blocks tab-closing. */
export function SafeExitScreen({ isDarkMode }: { isDarkMode: boolean }) {
  return (
    <div className={`min-h-dvh flex flex-col items-center justify-center font-sans ${isDarkMode ? 'bg-[#15161A]' : 'bg-[#F5F4F1]'}`}>
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
        className={`p-8 rounded-2xl max-w-sm mx-4 w-full text-center border ${isDarkMode ? 'bg-[#1B1C20] border-white/10' : 'bg-white border-slate-200'}`}
      >
        <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-6 bg-emerald-500/10 text-emerald-600">
          <Check className="w-7 h-7" strokeWidth={2.25} />
        </div>
        <h2 className={`text-lg font-medium mb-3 ${isDarkMode ? 'text-slate-100' : 'text-[#1C2A3A]'}`}>閱覽已安全結束</h2>
        <p className={`text-[15px] leading-relaxed mb-8 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
          為保障您的資訊安全，文件已關閉。<br />
          若視窗無法自動關閉，請手動關閉此分頁。
        </p>
        <button
          onClick={() => {
            window.close();
            window.location.href = 'about:blank';
          }}
          className={`w-full min-h-11 font-medium py-3 px-4 rounded-xl transition-colors text-sm ${isDarkMode ? 'bg-white/5 hover:bg-white/10 text-slate-300' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'}`}
        >
          手動關閉
        </button>
      </motion.div>
    </div>
  );
}
