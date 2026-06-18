import { useState, useLayoutEffect, type RefObject } from 'react';

/**
 * The exact vertical space a page can occupy without scrolling, measured from the
 * live layout instead of guessed. The CSS already reserves the chrome:
 *   - <main> padding-top  = header clearance (adapts to fullscreen + breakpoints)
 *   - content padding-bottom = bottom-bar clearance, incl. env(safe-area-inset-bottom)
 * So usable height = main.clientHeight − main.paddingTop − content.paddingBottom.
 * Re-measured on resize, orientation, and the fullscreen toggle, which is why the
 * effect re-runs on `recalcKey`.
 */
export function useFitHeight(
  mainRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  recalcKey: unknown,
): number {
  const [height, setHeight] = useState(0);

  useLayoutEffect(() => {
    const main = mainRef.current;
    const content = contentRef.current;
    if (!main || !content) return;

    const measure = () => {
      const top = parseFloat(getComputedStyle(main).paddingTop) || 0;
      const bottom = parseFloat(getComputedStyle(content).paddingBottom) || 0;
      setHeight(Math.max(280, main.clientHeight - top - bottom));
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(main);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [mainRef, contentRef, recalcKey]);

  return height;
}
