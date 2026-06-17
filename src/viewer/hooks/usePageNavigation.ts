import { useEffect } from 'react';
import type React from 'react';

interface UsePageNavigationParams {
  setPageNumber: React.Dispatch<React.SetStateAction<number>>;
  numPages: number | null;
  numPagesRef: React.MutableRefObject<number | null>;
  scaleRef: React.MutableRefObject<number>;
  containerRef: React.MutableRefObject<HTMLDivElement | null>;
  showDisclaimer: boolean;
}

/**
 * All page navigation: bounds-clamped changePage, keyboard ←/→, and single-finger
 * swipe. pageNumber state itself is owned by the orchestrator (so useTelemetry can
 * read it without a circular hook dependency); this hook only mutates it. Bounds
 * come from numPagesRef (live) so the gesture effects bind once.
 */
export function usePageNavigation({
  setPageNumber,
  numPages,
  numPagesRef,
  scaleRef,
  containerRef,
  showDisclaimer,
}: UsePageNavigationParams) {
  function changePage(offset: number) {
    setPageNumber(prevPageNumber => {
      const newPage = prevPageNumber + offset;
      if (newPage >= 1 && (numPages === null || newPage <= numPages)) {
        return newPage;
      }
      return prevPageNumber;
    });
  }

  const previousPage = () => changePage(-1);
  const nextPage = () => changePage(1);

  // Keyboard navigation: ← / → page through the report. We deliberately use only
  // the horizontal arrows — PageUp/PageDown/Home/End and Space stay with the
  // browser so a reader can still scroll within a page taller than the viewport.
  // Modified combos (Alt+←, ⌘+→, Ctrl+…) are ignored so browser/system shortcuts
  // keep working.
  useEffect(() => {
    const handleNavKey = (e: KeyboardEvent) => {
      if (showDisclaimer) return; // don't flip pages behind the consent modal
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
      const total = numPagesRef.current;
      if (!total) return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        setPageNumber(p => (p < total ? p + 1 : p));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setPageNumber(p => (p > 1 ? p - 1 : p));
      }
    };
    window.addEventListener('keydown', handleNavKey);
    return () => window.removeEventListener('keydown', handleNavKey);
  }, [showDisclaimer]);

  // Touch swipe navigation (mobile): a dominant horizontal swipe flips pages.
  // Single-finger only (ignores pinch-zoom); requires horizontal travel to
  // clearly beat vertical so it never hijacks normal scrolling.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let startX = 0, startY = 0, tracking = false;
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) { tracking = false; return; }
      tracking = true;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    };
    const onEnd = (e: TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      // When the reader has zoomed in — pinch-zoom (visualViewport) on mobile or
      // the in-app zoom control — a horizontal drag is a pan to read the page
      // edge, not a page flip. Leave it to the browser. (visualViewport is
      // optional-chained for older engines; Chromium-based browsers like Comet
      // support it.)
      if ((window.visualViewport?.scale ?? 1) > 1.01 || scaleRef.current > 1.01) return;
      const total = numPagesRef.current;
      if (!total) return;
      if (dx < 0) setPageNumber(p => (p < total ? p + 1 : p)); // swipe left → next
      else setPageNumber(p => (p > 1 ? p - 1 : p));            // swipe right → previous
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchend', onEnd);
    };
  }, []);

  return { previousPage, nextPage };
}
