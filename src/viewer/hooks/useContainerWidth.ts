import { useState, useEffect } from 'react';

/** Tracks window.innerWidth for the responsive <Page width> cap. */
export function useContainerWidth(): number {
  const [containerWidth, setContainerWidth] = useState(window.innerWidth);

  useEffect(() => {
    const handleResize = () => setContainerWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return containerWidth;
}
