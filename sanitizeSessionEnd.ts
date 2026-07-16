export type SanitizeResult = {
  total_duration_sec: number;
  total_pages: number | null;
  cta_click_page: number | null;
  tab_switch_count: number;
  return_visit_count: number;
  peak_scroll_velocity: number;
  engaged_60s_page: number | null;
  device_type: 'mobile' | 'desktop' | 'unknown';
  navigation_path: number[];
  nav_history: Array<{ page: number; t: number }>;
  zoom_clusters: Array<{ x: number; y: number; page: number; scale: number; t: number }>;
  scroll_samples: Array<{ v: number; t: number }>;
  pages_data: Record<string, { dwellMs: number; activeDwellMs: number; maxScale: number; maxScrollDepthPct: number }>;
};

function num<F>(v: any, min: number, max: number, fallback: F): number | F {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function intClamp<F>(v: any, min: number, max: number, fallback: F): number | F {
  const n = Number(v);
  if (!Number.isFinite(n) || Math.floor(n) !== n) return fallback;
  if (n < min || n > max) return fallback;
  return n;
}

export function sanitizeSessionEnd(body: any): SanitizeResult {
  if (!body || typeof body !== 'object') {
    return {
      total_duration_sec: 0,
      total_pages: null,
      cta_click_page: null,
      tab_switch_count: 0,
      return_visit_count: 0,
      peak_scroll_velocity: 0,
      engaged_60s_page: null,
      device_type: 'unknown',
      navigation_path: [],
      nav_history: [],
      zoom_clusters: [],
      scroll_samples: [],
      pages_data: {},
    };
  }

  const total_duration_sec = num(body.total_duration_sec, 0, 86400, 0);
  const total_pages = intClamp(body.total_pages, 1, 10000, null);
  const cta_click_page = intClamp(body.cta_click_page, 1, 10000, null);
  const tab_switch_count = num(body.tab_switch_count, 0, 10000, 0);
  const return_visit_count = num(body.return_visit_count, 0, 10000, 0);
  const peak_scroll_velocity = num(body.peak_scroll_velocity, 0, 1000, 0);
  const engaged_60s_page = intClamp(body.engaged_60s_page, 1, 10000, null);

  const device_type =
    body.device_type === 'mobile' || body.device_type === 'desktop'
      ? body.device_type
      : 'unknown';

  // navigation_path
  const navPathRaw = Array.isArray(body.navigation_path) ? body.navigation_path : [];
  const navigation_path: number[] = [];
  for (const v of navPathRaw) {
    if (navigation_path.length >= 2000) break;
    const n = Number(v);
    if (Number.isFinite(n) && Number.isInteger(n) && n >= 1 && n <= 10000) {
      navigation_path.push(n);
    }
  }

  // nav_history
  const navHistRaw = Array.isArray(body.nav_history) ? body.nav_history : [];
  const nav_history: Array<{ page: number; t: number }> = [];
  for (const item of navHistRaw) {
    if (nav_history.length >= 2000) break;
    if (item && typeof item === 'object') {
      const page = num(item.page, 1, 10000, null);
      const t = num(item.t, 0, Number.MAX_SAFE_INTEGER, null);
      if (Number.isInteger(page) && page >= 1 && page <= 10000 && Number.isFinite(t) && t >= 0) {
        nav_history.push({ page, t });
      }
    }
  }

  // zoom_clusters
  const zoomRaw = Array.isArray(body.zoom_clusters) ? body.zoom_clusters : [];
  const zoom_clusters: Array<{ x: number; y: number; page: number; scale: number; t: number }> = [];
  for (const item of zoomRaw) {
    if (zoom_clusters.length >= 1000) break;
    if (item && typeof item === 'object') {
      const x = num(item.x, 0, 1, null);
      const y = num(item.y, 0, 1, null);
      const page = intClamp(item.page, 1, 10000, null);
      const scale = num(item.scale, 0, 100, null);
      const t = num(item.t, 0, Number.MAX_SAFE_INTEGER, null);
      if (
        x !== null && y !== null && page !== null && scale !== null && t !== null &&
        Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(scale) && Number.isFinite(t)
      ) {
        zoom_clusters.push({ x, y, page: page as number, scale, t });
      }
    }
  }

  // scroll_samples
  const scrollRaw = Array.isArray(body.scroll_samples) ? body.scroll_samples : [];
  const scroll_samples: Array<{ v: number; t: number }> = [];
  for (const item of scrollRaw) {
    if (scroll_samples.length >= 2000) break;
    if (item && typeof item === 'object') {
      const v = num(item.v, 0, 1000, null);
      const t = num(item.t, 0, Number.MAX_SAFE_INTEGER, null);
      if (v !== null && t !== null && Number.isFinite(v) && Number.isFinite(t) && v >= 0 && t >= 0) {
        scroll_samples.push({ v, t });
      }
    }
  }

  // pages_data
  const pagesRaw = body.pages_data && typeof body.pages_data === 'object' ? body.pages_data : {};
  const pages_data: Record<string, { dwellMs: number; activeDwellMs: number; maxScale: number; maxScrollDepthPct: number }> = {};
  const keys = Object.keys(pagesRaw).slice(0, 5000);
  for (const k of keys) {
    const numKey = Number(k);
    if (!Number.isFinite(numKey) || Math.floor(numKey) !== numKey) continue;
    if (numKey < 1 || numKey > 10000) continue;
    const entry = pagesRaw[k];
    if (!entry || typeof entry !== 'object') continue;
    let dwellMs = num(entry.dwellMs, 0, 86400000, 0);
    let activeDwellMs = num(entry.activeDwellMs, 0, 86400000, 0);
    if (activeDwellMs > dwellMs) activeDwellMs = dwellMs;
    const maxScale = num(entry.maxScale, 0, 100, 0);
    const maxScrollDepthPct = num(entry.maxScrollDepthPct, 0, 100, 0);
    // Key by the normalized integer, not the raw key: "1" and "1.0" both parse
    // to page 1 and would otherwise produce two entries for the same page.
    pages_data[String(numKey)] = { dwellMs, activeDwellMs, maxScale, maxScrollDepthPct };
  }

  return {
    total_duration_sec,
    total_pages,
    cta_click_page,
    tab_switch_count,
    return_visit_count,
    peak_scroll_velocity,
    engaged_60s_page,
    device_type,
    navigation_path,
    nav_history,
    zoom_clusters,
    scroll_samples,
    pages_data,
  };
}
