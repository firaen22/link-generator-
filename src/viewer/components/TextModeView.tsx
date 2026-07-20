const MAX_TEXT_LEN = 20000;

export interface TextModeViewProps {
  /** Extracted text of the page, null while extraction is in progress */
  text: string | null;
  /** Page number (1-based) */
  pageNumber: number;
  /** Whether the app is in dark mode */
  isDarkMode: boolean;
}

/** Split the flat PDF text-run string into readable paragraphs: double spaces /
 *  newlines first, then a sentence-grouping fallback for one giant blob. */
function splitIntoParagraphs(input: string): string[] {
  let parts = input.split(/ {2,}|\n/).map(p => p.trim()).filter(p => p !== '');
  if (parts.length === 1 && parts[0].length > 600) {
    const sentences = parts[0].match(/[^。！？.!?]+[。！？.!?](?:\s|$)/g) || [];
    const grouped: string[] = [];
    for (let i = 0; i < sentences.length; i += 3) {
      grouped.push(sentences.slice(i, i + 3).join(' ').trim());
    }
    const fallback = grouped.filter(p => p !== '');
    // A blob with no recognised sentence punctuation must still render.
    if (fallback.length > 0) parts = fallback;
  }
  // Glue fragments (stray citation numbers, headings split from their body)
  // onto the following paragraph so they don't render as one-word paragraphs.
  const merged: string[] = [];
  let pending = '';
  for (const part of parts) {
    const candidate = pending === '' ? part : `${pending} ${part}`;
    if (candidate.length < 40) {
      pending = candidate;
      continue;
    }
    merged.push(candidate);
    pending = '';
  }
  if (pending !== '') merged.push(pending);
  return merged;
}

/**
 * Text-mode reading view: renders the extracted text of the current PDF page
 * as comfortable-size prose for phones. Purely presentational — the parent
 * owns extraction and supplies `text` (null while still extracting).
 */
export function TextModeView({ text, pageNumber, isDarkMode }: TextModeViewProps) {
  if (text === null) {
    return (
      <div className="flex items-center justify-center text-slate-500 min-h-[40vh]">
        正在擷取本頁文字…
      </div>
    );
  }

  let displayText = text;
  if (displayText.length > MAX_TEXT_LEN) {
    displayText = displayText.slice(0, MAX_TEXT_LEN) + '…';
  }

  if (displayText.trim() === '') {
    return (
      <div className="flex items-center justify-center text-center px-6 text-slate-500 min-h-[40vh]">
        本頁沒有可擷取的文字（可能是圖表或掃描頁），請切換回原文模式檢視。
      </div>
    );
  }

  const paragraphs = splitIntoParagraphs(displayText);
  const proseColor = isDarkMode ? 'text-slate-200' : 'text-[#1C2A3A]';

  return (
    <div className={`max-w-[42rem] mx-auto px-5 pt-4 pb-8 ${proseColor}`}>
      <div className="text-xs text-slate-500 mb-3">
        文字模式 · 第 {pageNumber} 頁 · 版面經簡化，圖表請切換回原文模式
      </div>
      {paragraphs.map((para, idx) => (
        <p
          key={idx}
          className="mb-4"
          style={{ fontSize: '17px', lineHeight: 1.9, letterSpacing: '0.01em' }}
        >
          {para}
        </p>
      ))}
    </div>
  );
}
