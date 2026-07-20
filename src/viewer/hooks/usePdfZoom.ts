import { useState } from 'react';

/** PDF zoom state. Clamps to [0.5, 2.0] in 0.1 steps, matching the original. */
export function usePdfZoom() {
  const [scale, setScaleState] = useState(1.0);
  const setScale = (next: number) => {
    setScaleState(prev => {
      if (!Number.isFinite(next) || next <= 0) return prev;
      return Math.min(Math.max(next, 0.5), 2.0);
    });
  };
  const zoomIn = () => setScaleState(prev => Math.min(prev + 0.1, 2.0));
  const zoomOut = () => setScaleState(prev => Math.max(prev - 0.1, 0.5));
  return { scale, setScale, zoomIn, zoomOut };
}
