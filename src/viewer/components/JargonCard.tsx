import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, X, Lightbulb } from 'lucide-react';
import type { JargonTerm } from '../jargon';

interface Props {
    terms: JargonTerm[];
    isDarkMode: boolean;
    visible: boolean;
}

// Reader's show/hide choice is a global UI preference (like ag_darkmode), not
// per-file: someone who dislikes the card wants it off everywhere. '0' = hidden.
const JARGON_PREF_KEY = 'ag_jargon';

export function JargonCard({ terms, isDarkMode, visible }: Props) {
    const [index, setIndex] = useState(0);
    // Restore the reader's saved choice; default to shown.
    const [dismissed, setDismissed] = useState(() => {
        try {
            return localStorage.getItem(JARGON_PREF_KEY) === '0';
        } catch {
            return false; // privacy mode / storage disabled → default shown
        }
    });
    // Bumped on manual navigation to restart the auto-rotate countdown, so a
    // reader-selected card gets a full interval instead of flipping immediately.
    const [timerKey, setTimerKey] = useState(0);

    // Reset to the first term whenever the term set changes (e.g. page flip).
    useEffect(() => {
        setIndex(0);
    }, [terms]);

    // Auto-rotate every 8s. Skipped (burns no timer) while off-screen (content
    // guard), while the reader has hidden the card, or with a single term — and
    // torn down when any of those flip, so it never ticks behind a hidden card.
    // Restarts on term change and on manual nav (timerKey).
    useEffect(() => {
        if (!visible || dismissed || terms.length <= 1) return;
        const interval = window.setInterval(() => {
            setIndex(i => (i + 1) % terms.length);
        }, 8000);
        return () => window.clearInterval(interval);
    }, [visible, terms, dismissed, timerKey]);

    // Content guard: hide entirely when the window is unfocused (and not
    // fullscreen), and when there is nothing to explain — for both the card and
    // the reopen pill.
    if (!visible || terms.length === 0) return null;

    const persist = (hidden: boolean) => {
        try {
            localStorage.setItem(JARGON_PREF_KEY, hidden ? '0' : '1');
        } catch {
            // ignore storage errors (quota, privacy mode)
        }
    };
    const hide = () => { setDismissed(true); persist(true); };
    const show = () => { setDismissed(false); persist(false); };
    const go = (delta: number) => {
        setIndex(i => (i + delta + terms.length) % terms.length);
        setTimerKey(k => k + 1); // restart the auto-rotate countdown
    };

    const anchor = { bottom: 'calc(6.5rem + env(safe-area-inset-bottom))' } as const;

    // Reader hid the card → offer a compact pill in the same corner to bring it
    // back. It is a real button (interactive), unlike the card body below.
    if (dismissed) {
        return (
            <button
                onClick={show}
                aria-label="顯示關鍵詞解釋"
                className={`fixed left-4 z-20 flex items-center gap-1.5 rounded-full border px-3.5 py-2.5 shadow-[0_8px_24px_rgba(0,0,0,0.12)] backdrop-blur text-[11px] font-mono uppercase tracking-widest transition-colors ${isDarkMode
                    ? 'bg-[#1E2026]/95 border-white/10 text-[#C6A867] hover:bg-white/5'
                    : 'bg-white/95 border-slate-200 text-[#B8964F] hover:bg-slate-50'
                    }`}
                style={anchor}
            >
                <Lightbulb className="w-4 h-4" />
                關鍵詞
            </button>
        );
    }

    const current = terms[index] || terms[0];
    const multi = terms.length > 1;
    const ctrlBtn = isDarkMode
        ? 'text-slate-400 hover:bg-white/10 hover:text-white'
        : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600';

    return (
        <div
            className={`fixed left-4 z-20 max-w-[360px] rounded-xl border px-4 py-2.5 shadow-[0_8px_24px_rgba(0,0,0,0.12)] backdrop-blur pointer-events-none ${isDarkMode
                ? 'bg-[#1E2026]/95 border-white/10'
                : 'bg-white/95 border-slate-200'
                }`}
            style={anchor}
        >
            <div key={index}>
                <div className="flex items-center justify-between gap-2 mb-1">
                    <span className={`text-[11px] sm:text-[10px] font-mono uppercase tracking-widest ${isDarkMode ? 'text-[#C6A867]' : 'text-[#B8964F]'}`}>
                        關鍵詞解釋
                    </span>
                    {/* The card body stays pointer-events-none so it never steals
                        taps from the reader surface; only these controls opt back in. */}
                    <div className="flex items-center gap-0.5 pointer-events-auto">
                        {multi && (
                            <>
                                <button
                                    onClick={() => go(-1)}
                                    aria-label="上一個關鍵詞"
                                    className={`flex items-center justify-center w-9 h-9 rounded-md transition-colors ${ctrlBtn}`}
                                >
                                    <ChevronLeft className="w-4 h-4" />
                                </button>
                                <span className={`text-[11px] sm:text-[10px] font-mono tabular-nums select-none ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>
                                    {index + 1}/{terms.length}
                                </span>
                                <button
                                    onClick={() => go(1)}
                                    aria-label="下一個關鍵詞"
                                    className={`flex items-center justify-center w-9 h-9 rounded-md transition-colors ${ctrlBtn}`}
                                >
                                    <ChevronRight className="w-4 h-4" />
                                </button>
                            </>
                        )}
                        <button
                            onClick={hide}
                            aria-label="隱藏關鍵詞解釋"
                            className={`flex items-center justify-center w-9 h-9 rounded-md transition-colors ${ctrlBtn}`}
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                </div>
                <div className={`text-sm font-semibold ${isDarkMode ? 'text-slate-100' : 'text-[#1C2A3A]'}`}>{current.term}</div>
                <div className={`text-[13px] sm:text-xs leading-snug ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{current.explanation}</div>
            </div>
        </div>
    );
}
