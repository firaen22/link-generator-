import { useEffect, useState } from 'react';
import type { JargonTerm } from '../jargon';

interface Props {
    terms: JargonTerm[];
    isDarkMode: boolean;
    visible: boolean;
}

export function JargonCard({ terms, isDarkMode, visible }: Props) {
    const [index, setIndex] = useState(0);

    useEffect(() => {
        setIndex(0);
        if (terms.length <= 1) return;
        const interval = window.setInterval(() => {
            setIndex(i => (i + 1) % terms.length);
        }, 8000);
        return () => window.clearInterval(interval);
    }, [terms]);

    if (!visible || terms.length === 0) return null;

    const current = terms[index] || terms[0];

    return (
        <div
            className={`fixed left-4 z-20 max-w-[360px] rounded-xl border px-4 py-2.5 shadow-[0_8px_24px_rgba(0,0,0,0.12)] backdrop-blur pointer-events-none ${isDarkMode
                ? 'bg-[#1E2026]/95 border-white/10'
                : 'bg-white/95 border-slate-200'
                }`}
            style={{ bottom: 'calc(6.5rem + env(safe-area-inset-bottom))' }}
        >
            <div key={index}>
                <div className="flex items-center justify-between gap-4 mb-1">
                    <span className={`text-[9px] font-mono uppercase tracking-widest ${isDarkMode ? 'text-[#C6A867]' : 'text-[#B8964F]'}`}>
                        術語解說
                    </span>
                    {terms.length > 1 && (
                        <span className={`text-[9px] font-mono ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>
                            {index + 1}/{terms.length}
                        </span>
                    )}
                </div>
                <div className={`text-sm font-semibold ${isDarkMode ? 'text-slate-100' : 'text-[#1C2A3A]'}`}>{current.term}</div>
                <div className={`text-xs leading-snug ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{current.explanation}</div>
            </div>
        </div>
    );
}
