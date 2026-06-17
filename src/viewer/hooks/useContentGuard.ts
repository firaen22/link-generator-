import { useState, useEffect } from 'react';

interface UseContentGuardParams {
  sendTrackingEvent: (event: string, data?: any) => void;
  numPages: number | null;
  pageNumber: number;
  showToast: (message: string) => void;
}

/**
 * Anti-screenshot / content-protection layer. Owns isWindowFocused (used to blur
 * the content when the window loses focus), and intercepts print + screenshot
 * shortcuts. Capture-key detection is best-effort deterrence only — browsers
 * cannot truly block PrintScreen or the OS snip overlay; the watermark + tracking
 * are the real protections.
 */
export function useContentGuard({ sendTrackingEvent, numPages, pageNumber, showToast }: UseContentGuardParams) {
  const [isWindowFocused, setIsWindowFocused] = useState(true);

  // Monitor window focus & mouse out: blur content aggressively
  useEffect(() => {
    const handleBlur = () => setIsWindowFocused(false);
    const handleFocus = () => setIsWindowFocused(true);
    const handleMouseLeave = () => setIsWindowFocused(false);
    const handleMouseEnter = () => setIsWindowFocused(true);
    const handleVisibilityChange = () => {
      if (document.hidden) setIsWindowFocused(false);
      else setIsWindowFocused(true);
    };

    window.addEventListener('blur', handleBlur);
    window.addEventListener('focus', handleFocus);
    document.addEventListener('mouseleave', handleMouseLeave);
    document.addEventListener('mouseenter', handleMouseEnter);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('mouseleave', handleMouseLeave);
      document.removeEventListener('mouseenter', handleMouseEnter);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // Keyboard protection: intercept print + known screenshot shortcuts.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Intercept print (Ctrl+P or Cmd+P)
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        sendTrackingEvent('security_alert', { type: 'print_attempt' });
        showToast('本文件受保護，不支援列印。');
        return;
      }

      // Windows: legacy PrintScreen key (cannot be preventDefaulted — log only)
      if (e.key === 'PrintScreen') {
        sendTrackingEvent('security_alert', { type: 'screenshot_detected_win' });
        showToast('系統偵測到截圖動作，請注意文件安全。');
        return;
      }

      // Narrowed capture combos only (was: any Cmd+Shift, which fired on benign
      // Mac shortcuts). Mac screenshots: ⌘⇧3/4/5. Windows Snipping Tool: ⊞⇧S
      // (the Windows key surfaces as metaKey in browsers).
      if (e.metaKey && e.shiftKey) {
        const k = e.key.toLowerCase();
        if (k === '3' || k === '4' || k === '5') {
          setIsWindowFocused(false);
          sendTrackingEvent('security_alert', { type: 'potential_screenshot_mac' });
          showToast('系統偵測到截圖動作，請注意文件安全。');
        } else if (k === 's') {
          setIsWindowFocused(false);
          sendTrackingEvent('security_alert', { type: 'screenshot_detected_win' });
          showToast('系統偵測到截圖動作，請注意文件安全。');
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // Handler reads only the stable showToast (useCallback) and sendTrackingEvent
    // (reads live refs), so bind once — numPages/pageNumber were unused churn.
  }, []);

  return { isWindowFocused };
}
