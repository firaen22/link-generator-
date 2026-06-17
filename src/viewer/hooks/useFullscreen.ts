import { useState, useEffect } from 'react';

/**
 * Fullscreen state machine with a three-tier toggle:
 * native requestFullscreen → webkit prefix → software fallback (Mobile Safari).
 * Also mirrors native fullscreenchange (e.g. the user pressing ESC).
 */
export function useFullscreen() {
  const [isFullscreen, setIsFullscreen] = useState(false);

  const toggleFullscreen = async () => {
    try {
      if (!isFullscreen) {
        if (document.documentElement.requestFullscreen) {
          await document.documentElement.requestFullscreen();
        } else if ((document.documentElement as any).webkitRequestFullscreen) {
          await (document.documentElement as any).webkitRequestFullscreen();
        } else {
          // Fallback (Software Focus Mode for Mobile Safari)
          setIsFullscreen(true);
        }
      } else {
        if (document.exitFullscreen && document.fullscreenElement) {
          await document.exitFullscreen();
        } else if ((document as any).webkitExitFullscreen && (document as any).webkitFullscreenElement) {
          await (document as any).webkitExitFullscreen();
        } else {
          // Fallback exit
          setIsFullscreen(false);
        }
      }
    } catch (err) {
      console.error('Fullscreen toggle error:', err);
      setIsFullscreen(!isFullscreen); // Ensure software fallback works even on API failure
    }
  };

  useEffect(() => {
    const handleFullscreenChange = () => {
      const isNativeFull = !!(document.fullscreenElement || (document as any).webkitFullscreenElement);
      setIsFullscreen(isNativeFull);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
    };
  }, []);

  return { isFullscreen, toggleFullscreen };
}
