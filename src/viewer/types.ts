// Shared types for the viewer module tree.

declare global {
  interface Window {
    gtag: (command: string, ...args: any[]) => void;
    dataLayer: any[];
    _uxa?: any[];
  }
}

/** Per-page accumulated reading telemetry. */
export interface PageSessionData {
  dwellMs: number;
  activeDwellMs: number;
  maxScale: number;
  maxScrollDepthPct: number;
}

export type SessionDataMap = Record<number, PageSessionData>;

export interface NavHistoryEntry { page: number; t: number }
export interface ZoomClusterEntry { x: number; y: number; page: number; scale: number; t: number }
export interface ScrollSample { v: number; t: number }

/** Result of resolving all reader inputs from the route + query string. */
export interface ResolvedReportParams {
  clientName: string;
  reportName: string;
  fileId: string;
  pdfUrl: string;
  whatsappNumber: string;
}

export {};
