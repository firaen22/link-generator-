import { AnimatePresence, motion } from 'motion/react';

/** Transient bottom-center status toast (replaces the original alert() popups). */
export function Toast({ message, isDarkMode }: { message: string | null; isDarkMode: boolean }) {
  return (
    <AnimatePresence>
      {message && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          role="status"
          aria-live="polite"
          className="fixed left-1/2 -translate-x-1/2 bottom-28 sm:bottom-32 z-[110] px-4 py-2.5 max-w-[88vw]"
          style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
        >
          <div className={`px-4 py-2.5 rounded-xl text-sm font-medium text-center shadow-lg border ${isDarkMode ? 'bg-[#1B1C20] border-white/10 text-slate-200' : 'bg-white border-slate-200 text-[#1C2A3A]'}`}>
            {message}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
