import { useState } from 'react';

/** PDF zoom state. Clamps to [0.5, 2.0] in 0.1 steps, matching the original. */
export function usePdfZoom() {
  const [scale, setScale] = useState(1.0);
  const zoomIn = () => setScale(prev => Math.min(prev + 0.1, 2.0));
  const zoomOut = () => setScale(prev => Math.max(prev - 0.1, 0.5));
  return { scale, zoomIn, zoomOut };
}
