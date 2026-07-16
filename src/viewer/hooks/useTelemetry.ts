import { useEffect, useRef, useCallback } from 'react';
import type React from 'react';
import type { PageSessionData, SessionDataMap } from '../types';

interface UseTelemetryParams {
  fileId: string;
  clientName: string;
  reportName: string;
  pageNumber: number;
  scale: number;
  numPages: number | null;
  loading: boolean;
  /** The single scrollable <main> element, owned by the orchestrator and shared
   *  with navigation. The rAF scroll sampler and zoom collector read from it. */
  containerRef: React.MutableRefObject<HTMLDivElement | null>;
}

/** Fresh per-session identifier; crypto.randomUUID with a non-secure fallback. */
function genSessionId() {
  return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 15);
}

/** LocalStorage reads that never throw. Sandboxed iframes, private-mode Safari,
 *  and storage-blocked in-app browsers (WhatsApp/Line webviews) raise a
 *  SecurityError on any localStorage access; unguarded, that would crash the
 *  entire viewer mount. Writes elsewhere in this hook are already try/wrapped. */
function safeGetItem(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeRemoveItem(key: string) {
  try { localStorage.removeItem(key); } catch { /* storage blocked — ignore */ }
}

/**
 * The reader's full tracking engine. Owns session identity, activity monitoring,
 * per-page dwell/scroll/zoom accumulation, LocalStorage persistence + recovery,
 * the session_end beacon, the single 1s heartbeat timer, and the central
 * sendTrackingEvent fan-out (/api/track + gtag + ContentSquare).
 *
 * It also owns the shared mutable refs (currentPageRef/scaleRef/numPagesRef/
 * startTimeRef/handleExitRef) and hands them out by reference so navigation,
 * content-guard and manual-close read the SAME physical ref — never a copy.
 */
export function useTelemetry({
  fileId,
  clientName,
  reportName,
  pageNumber,
  scale,
  numPages,
  loading,
  containerRef,
}: UseTelemetryParams) {
  // 0. Session Identity
  const sessionIdRef = useRef(genSessionId());

  // Tracking refs
  const startTimeRef = useRef(Date.now());
  const lastPingRef = useRef(Date.now());
  const hasTrackedOpenRef = useRef(false);

  // Activity Monitoring (Active vs Passive)
  const lastActivityRef = useRef(Date.now());
  const isActiveRef = useRef(true);

  useEffect(() => {
    const updateActivity = () => {
      lastActivityRef.current = Date.now();
      if (!isActiveRef.current) {
        isActiveRef.current = true;
      }
    };

    const activityEvents = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'];
    activityEvents.forEach(e => window.addEventListener(e, updateActivity, { passive: true }));

    // Checker: If no activity for 30s, mark as passive
    const interval = setInterval(() => {
      const now = Date.now();
      if (now - lastActivityRef.current > 30000 && isActiveRef.current) {
        isActiveRef.current = false;
      }
    }, 1000);

    return () => {
      activityEvents.forEach(e => window.removeEventListener(e, updateActivity));
      clearInterval(interval);
    };
  }, []);

  // Advanced behavior tracking
  const sessionDataRef = useRef<SessionDataMap>({});
  const navigationPathRef = useRef<number[]>([]);
  const currentPageRef = useRef(pageNumber);
  const pageEnterTimeRef = useRef(Date.now());
  const hasSentSessionEndRef = useRef(false);
  const hasSentEngaged60Ref = useRef(false);
  // Page the reader was on when the 60s milestone fired — carried into the
  // session_end payload so the AI analysis can reference it.
  const engaged60PageRef = useRef<number | null>(null);
  const scaleRef = useRef(1.0);
  const numPagesRef = useRef<number | null>(null);

  useEffect(() => { scaleRef.current = scale; }, [scale]);
  useEffect(() => { numPagesRef.current = numPages; }, [numPages]);

  // ── Deep Telemetry Refs (all useRef — zero re-renders) ──────────────────────
  const navHistoryRef = useRef<Array<{ page: number; t: number }>>([]);
  const zoomClustersRef = useRef<Array<{ x: number; y: number; page: number; scale: number; t: number }>>([]);
  const scrollSamplesRef = useRef<Array<{ v: number; t: number }>>([]);
  const lastScrollYRef = useRef(0);
  const lastScrollTRef = useRef(performance.now());
  const rAFScrollRef = useRef<number | null>(null);
  const lastSampleTRef = useRef(performance.now());

  const ctaClickPageRef = useRef<number | null>(null);

  const deviceTypeRef = useRef<'mobile' | 'desktop'>(
    /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth < 768
      ? 'mobile'
      : 'desktop'
  );

  const tabSwitchKey = `ag_tabswitch_${fileId}_${clientName}`;
  const tabSwitchCountRef = useRef<number>(
    parseInt(safeGetItem(tabSwitchKey) || '0', 10) || 0
  );

  // Genuine return visits: sessions started AFTER a previous session for this
  // file+client completed. Unlike tab_switch_count (which increments on every
  // tab-hide, i.e. mere glances away), this only counts real re-opens — the
  // ended-flag stores WHEN a session_end was dispatched, and is consumed on the
  // next session start (same-tab resume or fresh mount) only if the reader was
  // away long enough that it reads as "came back to re-read", not a WhatsApp
  // glance or an instant reload.
  const RETURN_VISIT_MIN_GAP_MS = 5 * 60_000;
  const returnVisitKey = `ag_returnvisit_${fileId}_${clientName}`;
  const sessionEndedKey = `ag_sessionended_${fileId}_${clientName}`;
  const returnVisitCountRef = useRef<number>(
    parseInt(safeGetItem(returnVisitKey) || '0', 10) || 0
  );
  const maybeRecordReturnVisit = () => {
    const endedAt = Number(safeGetItem(sessionEndedKey));
    if (!Number.isFinite(endedAt) || endedAt <= 0) return;
    // Too-recent gap = transient backgrounding, not a return. Leave the flag:
    // the next handleExit overwrites its timestamp anyway.
    if (Date.now() - endedAt < RETURN_VISIT_MIN_GAP_MS) return;
    returnVisitCountRef.current += 1;
    try { localStorage.setItem(returnVisitKey, String(returnVisitCountRef.current)); } catch (e) { /* quota */ }
    safeRemoveItem(sessionEndedKey);
  };

  const handleExitRef = useRef<(() => void) | null>(null);

  // Register page transitions into navHistoryRef
  useEffect(() => {
    if (navHistoryRef.current.length >= 600) navHistoryRef.current.shift();
    navHistoryRef.current.push({ page: pageNumber, t: performance.now() });
  }, [pageNumber]);

  // Scroll velocity + depth collector — rAF throttled, sampled every 500ms
  useEffect(() => {
    const measure = () => {
      // The PDF scrolls inside the <main> container (overflow-y-auto), not the
      // window — read scroll state from that element, or telemetry is always ~0.
      const el = containerRef.current;
      if (!el) {
        rAFScrollRef.current = requestAnimationFrame(measure);
        return;
      }

      const now = performance.now();
      const currentY = el.scrollTop;
      const dt = now - lastScrollTRef.current;

      if (dt > 0) {
        const v = Math.abs(currentY - lastScrollYRef.current) / dt; // px/ms
        if (now - lastSampleTRef.current >= 500) {
          const sampleV = parseFloat(v.toFixed(4));
          if (sampleV !== 0) {
            if (scrollSamplesRef.current.length >= 1200) {
              let writeIndex = 0;
              for (let readIndex = 0; readIndex < scrollSamplesRef.current.length; readIndex += 2) {
                scrollSamplesRef.current[writeIndex] = scrollSamplesRef.current[readIndex];
                writeIndex += 1;
              }
              scrollSamplesRef.current.length = writeIndex;
            }
            scrollSamplesRef.current.push({ v: sampleV, t: now });
          }
          lastSampleTRef.current = now;
        }
      }

      // Track max scroll depth per page (0–100 %)
      const docHeight = el.scrollHeight - el.clientHeight;
      if (docHeight > 0) {
        const depthPct = Math.min(100, (currentY / docHeight) * 100);
        const page = currentPageRef.current;
        if (!sessionDataRef.current[page]) {
          sessionDataRef.current[page] = { dwellMs: 0, activeDwellMs: 0, maxScale: 1.0, maxScrollDepthPct: 0 };
        }
        if (depthPct > sessionDataRef.current[page].maxScrollDepthPct) {
          sessionDataRef.current[page].maxScrollDepthPct = parseFloat(depthPct.toFixed(1));
        }
      }

      lastScrollYRef.current = currentY;
      lastScrollTRef.current = now;
      rAFScrollRef.current = requestAnimationFrame(measure);
    };

    rAFScrollRef.current = requestAnimationFrame(measure);
    return () => {
      if (rAFScrollRef.current !== null) cancelAnimationFrame(rAFScrollRef.current);
    };
  }, []);

  // Zoom cluster collector — wheel & pinch events on the PDF container
  const handleZoomEvent = useCallback((e: WheelEvent | TouchEvent) => {
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    let clientX = 0;
    let clientY = 0;

    if (e instanceof WheelEvent) {
      if (!e.ctrlKey && !e.metaKey) return;
      clientX = e.clientX;
      clientY = e.clientY;
    } else if (e instanceof TouchEvent && e.touches.length >= 2) {
      clientX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      clientY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    } else {
      return;
    }

    // Container can be zero-sized mid-layout; dividing then would yield
    // NaN/Infinity coordinates that serialize to null in the payload.
    if (rect.width === 0 || rect.height === 0) return;
    const normX = parseFloat(((clientX - rect.left) / rect.width).toFixed(3));
    const normY = parseFloat(((clientY - rect.top) / rect.height).toFixed(3));

    if (zoomClustersRef.current.length >= 300) zoomClustersRef.current.shift();
    zoomClustersRef.current.push({
      x: normX,
      y: normY,
      page: currentPageRef.current,
      scale: parseFloat(scaleRef.current.toFixed(2)),
      t: performance.now(),
    });
  }, [containerRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.addEventListener('wheel', handleZoomEvent, { passive: true });
    container.addEventListener('touchstart', handleZoomEvent as EventListener, { passive: true });
    return () => {
      container.removeEventListener('wheel', handleZoomEvent);
      container.removeEventListener('touchstart', handleZoomEvent as EventListener);
    };
  }, [handleZoomEvent, containerRef]);

  // LocalStorage Key for this specific report session
  const storageKey = `ag_report_log_${fileId}_${clientName}`;

  // Helper to accumulate telemetry
  const updateSessionData = (pageNum: number, durationMs: number, currentScale: number, wasActive: boolean) => {
    if (!sessionDataRef.current[pageNum]) {
      sessionDataRef.current[pageNum] = { dwellMs: 0, activeDwellMs: 0, maxScale: 1.0, maxScrollDepthPct: 0 };
    }
    sessionDataRef.current[pageNum].dwellMs += durationMs;
    if (wasActive) {
      sessionDataRef.current[pageNum].activeDwellMs += durationMs;
    }
    if (currentScale > sessionDataRef.current[pageNum].maxScale) {
      sessionDataRef.current[pageNum].maxScale = currentScale;
    }

    if (navigationPathRef.current[navigationPathRef.current.length - 1] !== pageNum) {
      if (navigationPathRef.current.length >= 2000) navigationPathRef.current.shift();
      navigationPathRef.current.push(pageNum);
    }

    persistSessionSnapshot();
  };

  // Single writer for the recovery blob — also called right when engaged_60s
  // fires, so a tab killed without pagehide can't replay the milestone.
  const persistSessionSnapshot = () => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({
        pages_data: sessionDataRef.current,
        path: navigationPathRef.current,
        startTime: startTimeRef.current,
        sessionId: sessionIdRef.current,
        engaged60: hasSentEngaged60Ref.current,
        engaged60Page: engaged60PageRef.current,
        lastActiveAt: Date.now(),
      }));
    } catch (e) { /* ignore quota issues */ }
  };

  // Send tracking event to backend (+ GA4 + ContentSquare). Defined fresh each
  // render so effects with changing deps capture the current closure; the
  // deps-[] heartbeat timer deliberately captures the mount-time instance.
  const sendTrackingEvent = (event: string, data: any = {}) => {
    const payload = {
      event,
      session_id: sessionIdRef.current,
      file_id: fileId,
      client_name: clientName,
      report_name: reportName,
      // Live ref, not the `numPages` state: the deps-[] heartbeat timer holds the
      // mount-time closure where the state is still null, so reading the ref keeps
      // total_pages correct for heartbeats (and harmless for every other caller).
      total_pages: numPagesRef.current,
      timestamp: new Date().toISOString(),
      ...data,
    };

    fetch('/api/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(err => console.error('Tracking failed', err));

    if (typeof window.gtag === 'function') {
      window.gtag('event', event, {
        ...data,
        // session_id lets GA4 Explorations / BigQuery join all events of one
        // reading session (GA's own session scope resets on tab-hide re-opens).
        session_id: sessionIdRef.current,
        file_id: fileId,
        client_name: clientName,
        report_name: reportName,
      });
    }

    if (typeof window._uxa !== 'undefined') {
      window._uxa.push(['trackDynamicVariable', { key: 'action_event', value: event }]);
      if (data.page) {
        window._uxa.push(['trackDynamicVariable', { key: 'pdf_page', value: String(data.page) }]);
      }
    }
  };

  // Dispatch final session payload + visibility/recovery wiring
  useEffect(() => {
    const handleExit = () => {
      if (hasSentSessionEndRef.current) return;

      const now = Date.now();
      // Clamp: a backward system-clock adjustment mid-session would otherwise
      // produce negative dwell times in the telemetry payload.
      const durationMs = Math.max(0, now - pageEnterTimeRef.current);

      updateSessionData(currentPageRef.current, durationMs, scaleRef.current, isActiveRef.current);

      const totalActiveTime = Math.floor((now - startTimeRef.current) / 1000);

      // 如果時間太短 (< 2s)，防誤觸不發送
      if (totalActiveTime < 2) return;

      hasSentSessionEndRef.current = true;

      const scrollVelocities = scrollSamplesRef.current.map(s => s.v);
      const peakScrollVelocity = scrollVelocities.length > 0
        ? parseFloat(Math.max(...scrollVelocities).toFixed(4))
        : 0;

      const payload = {
        event: 'session_end',
        session_id: sessionIdRef.current,
        file_id: fileId,
        client_name: clientName,
        report_name: reportName,
        total_duration_sec: totalActiveTime,
        total_pages: numPagesRef.current,
        pages_data: sessionDataRef.current,
        navigation_path: navigationPathRef.current,
        timestamp: new Date().toISOString(),
        nav_history: navHistoryRef.current,
        zoom_clusters: zoomClustersRef.current,
        scroll_samples: scrollSamplesRef.current,
        peak_scroll_velocity: peakScrollVelocity,
        cta_click_page: ctaClickPageRef.current,
        device_type: deviceTypeRef.current,
        tab_switch_count: tabSwitchCountRef.current,
        return_visit_count: returnVisitCountRef.current,
        engaged_60s_page: engaged60PageRef.current,
      };

      while (
        JSON.stringify(payload).length > 60000 &&
        (
          payload.scroll_samples.length > 8 ||
          payload.zoom_clusters.length > 8 ||
          payload.nav_history.length > 8
        )
      ) {
        payload.scroll_samples = payload.scroll_samples.filter((_, index) => index % 2 === 0);
        payload.zoom_clusters = payload.zoom_clusters.filter((_, index) => index % 2 === 0);
        payload.nav_history = payload.nav_history.filter((_, index) => index % 2 === 0);
      }

      safeRemoveItem(storageKey);

      // Mirror a FLAT session summary to GA4 — GA is the long-term analytics
      // store, but its event params must stay scalar, so the arrays live only
      // in the /api/session-end payload.
      if (typeof window.gtag === 'function') {
        // Recovery can restore corrupt localStorage rows, so filter to finite
        // values and clamp the ratio — GA silently drops params it can't parse.
        const pagesViewed = Object.keys(sessionDataRef.current).map(Number).filter(Number.isFinite);
        const maxPageReached = pagesViewed.length > 0 ? Math.max(...pagesViewed) : 0;
        const perPage: PageSessionData[] = Object.values(sessionDataRef.current);
        const dwellTotalMs = perPage.reduce((sum, p) => sum + (Number.isFinite(p.dwellMs) ? p.dwellMs : 0), 0);
        const activeTotalMs = perPage.reduce((sum, p) => sum + (Number.isFinite(p.activeDwellMs) ? p.activeDwellMs : 0), 0);
        const totalPages = numPagesRef.current;
        window.gtag('event', 'report_session_end', {
          session_id: sessionIdRef.current,
          file_id: fileId,
          client_name: clientName,
          report_name: reportName,
          total_duration_sec: totalActiveTime,
          total_pages: totalPages ?? 0,
          max_page_reached: maxPageReached,
          progress_pct: totalPages && maxPageReached > 0 ? Math.min(100, Math.round((maxPageReached / totalPages) * 100)) : 0,
          active_ratio_pct: dwellTotalMs > 0 ? Math.min(100, Math.max(0, Math.round((activeTotalMs / dwellTotalMs) * 100))) : 0,
          pages_viewed: pagesViewed.length,
          tab_switch_count: tabSwitchCountRef.current,
          return_visit_count: returnVisitCountRef.current,
          cta_click_page: ctaClickPageRef.current ?? 0,
          device_type: deviceTypeRef.current,
          peak_scroll_velocity: peakScrollVelocity,
          // Fires during pagehide/visibilitychange — ask gtag for beacon transport.
          transport_type: 'beacon',
        });
      }

      const sendViaFetch = () => {
        fetch('/api/session-end', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true,
        }).catch(e => console.error('Session end dispatch failed', e));
      };

      try {
        const url = '/api/session-end';
        const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
        // sendBeacon returns false (without throwing) when the payload exceeds the
        // browser's beacon limit or the queue is full — fall back to keepalive fetch
        // so a long session's telemetry isn't silently dropped.
        const queued = typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(url, blob);
        if (!queued) sendViaFetch();
      } catch (err) {
        sendViaFetch();
      }

      // Record WHEN this session completed: a later session start for this
      // file+client (same-tab resume or fresh open, after a real gap) is a
      // genuine return visit.
      try { localStorage.setItem(sessionEndedKey, String(Date.now())); } catch (e) { /* quota */ }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        tabSwitchCountRef.current += 1;
        try { localStorage.setItem(tabSwitchKey, String(tabSwitchCountRef.current)); } catch (e) { /* quota */ }
        console.log('偵測到用戶離開分頁，立即結算分析報告...');
        handleExit();
      } else if (document.visibilityState === 'visible') {
        if (hasSentSessionEndRef.current) {
          console.log('用戶重返報告，開啟全新會話 tracking...');
          maybeRecordReturnVisit();
          // Fresh session: new id + clear every per-session accumulator, so the
          // next session_end isn't polluted with the previous visit's path,
          // zoom/scroll samples, or CTA page.
          hasSentSessionEndRef.current = false;
          sessionIdRef.current = genSessionId();
          startTimeRef.current = Date.now();
          pageEnterTimeRef.current = Date.now();
          lastPingRef.current = Date.now();
          sessionDataRef.current = {};
          navigationPathRef.current = [];
          navHistoryRef.current = [];
          zoomClustersRef.current = [];
          scrollSamplesRef.current = [];
          ctaClickPageRef.current = null;
          hasSentEngaged60Ref.current = false;
          engaged60PageRef.current = null;
        }
      }
    };

    handleExitRef.current = handleExit;

    window.addEventListener('beforeunload', handleExit);
    window.addEventListener('pagehide', handleExit);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // A previous session for this file+client completed and this is a fresh
    // mount after a real gap — count it as a genuine return visit. (Same-tab
    // resumes are counted in the visibilitychange handler above; the min-gap
    // check plus flag removal keeps effect re-runs from double-counting.)
    maybeRecordReturnVisit();

    // Initial check for recovery
    const saved = safeGetItem(storageKey);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        // Recovery is for a killed tab of the SAME sitting. A stale snapshot
        // (reopened minutes-to-days later) would restore the old startTime, so
        // the heartbeat's first tick sees a huge sessionDuration and fires a
        // false engaged_60s the instant the reader returns — and session_end
        // reports the gap as reading time. Discard instead of restoring.
        const staleMs = Date.now() - Number(parsed.lastActiveAt);
        if (!Number.isFinite(staleMs) || staleMs > 5 * 60_000) {
          safeRemoveItem(storageKey);
        } else {
          sessionDataRef.current = parsed.pages_data || {};
          navigationPathRef.current = parsed.path || [];
          if (parsed.startTime) startTimeRef.current = parsed.startTime;
          if (parsed.sessionId) sessionIdRef.current = parsed.sessionId;
          if (parsed.engaged60) hasSentEngaged60Ref.current = true;
          if (Number.isInteger(parsed.engaged60Page) && parsed.engaged60Page >= 1) {
            engaged60PageRef.current = parsed.engaged60Page;
          }
          console.log(`[TRACK] Recovered session ${sessionIdRef.current.slice(0, 8)} from LocalStorage`);
        }
      } catch (e) { if (import.meta.env.DEV) console.warn('[telemetry] session recovery failed:', e); }
    }

    return () => {
      window.removeEventListener('beforeunload', handleExit);
      window.removeEventListener('pagehide', handleExit);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [fileId, clientName, reportName]);

  // Track Page Dwell & Zoom Changes
  useEffect(() => {
    const now = Date.now();
    const durationMs = Math.max(0, now - pageEnterTimeRef.current);

    updateSessionData(currentPageRef.current, durationMs, scaleRef.current, isActiveRef.current);

    currentPageRef.current = pageNumber;
    pageEnterTimeRef.current = now;
  }, [pageNumber, scale]);

  // Track page views when pageNumber changes
  useEffect(() => {
    if (!loading && numPages) {
      sendTrackingEvent('page_view', { page: pageNumber });
    }
  }, [pageNumber, loading, numPages]);

  // Heartbeat: the single 1s timer. Reads live refs (the interval binds once with
  // deps [], so closing over numPages/pageNumber state would freeze them at their
  // mount values). Sends a heartbeat every ~30s.
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      const sessionDuration = Math.floor((now - startTimeRef.current) / 1000);

      if (!hasSentEngaged60Ref.current && sessionDuration >= 60) {
        hasSentEngaged60Ref.current = true;
        engaged60PageRef.current = currentPageRef.current;
        // Persist the flag NOW — waiting for the next updateSessionData would
        // let a tab killed without pagehide recover with engaged60=false and
        // replay the milestone (duplicate advisor notification).
        persistSessionSnapshot();
        sendTrackingEvent('engaged_60s', {
          duration_seconds: sessionDuration,
          page: currentPageRef.current,
        });
      }

      if (now - lastPingRef.current > 30000) {
        // Refresh the snapshot's lastActiveAt: a reader parked on one page
        // never triggers updateSessionData, and without this their snapshot
        // would go "stale" (>5min) and lose legitimate crash recovery.
        persistSessionSnapshot();
        sendTrackingEvent('heartbeat', {
          duration_seconds: sessionDuration,
          // Server /api/track reads `page` (not current_page) for the heartbeat
          // 「正在閱讀中」 page note — send under that key so it isn't dropped.
          page: currentPageRef.current,
        });
        lastPingRef.current = now;
      }
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  /** Fire the 'open' event exactly once, when the document first loads. */
  const markOpenTracked = (loadedNumPages: number) => {
    if (!hasTrackedOpenRef.current) {
      sendTrackingEvent('open', { total_pages: loadedNumPages });
      hasTrackedOpenRef.current = true;
    }
  };

  /** Record the page the client was on when clicking the WhatsApp CTA. */
  const recordCtaClick = (page: number) => {
    ctaClickPageRef.current = page;
    sendTrackingEvent('click_appointment', { page });
  };

  return {
    sendTrackingEvent,
    markOpenTracked,
    recordCtaClick,
    currentPageRef,
    scaleRef,
    numPagesRef,
    startTimeRef,
    handleExitRef,
  };
}
