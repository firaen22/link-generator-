---
name: viewer-frontend
description: Load when editing src/Viewer.tsx, src/viewer/** components/hooks, App.tsx UI, bumping pdfjs-dist/react-pdf, or when the PDF canvas janks, zoom/autofit misbehaves, or mobile UX regresses.
---

# Viewer frontend — PDF reader rules (2026-07-13)

## The pdfjs pin is load-bearing
`pdfjs-dist` is exact-pinned `"5.4.296"` (package.json — the only exact pin in
the file) and the worker is bundler-imported:
`import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'` then
`GlobalWorkerOptions.workerSrc = pdfWorker` (Viewer.tsx:3-10). react-pdf
10.4.1 bundles a specific pdfjs API version; API and worker must byte-match
or the viewer throws "API version does not match Worker version". There is
NO in-code comment saying this — history only (downgrade commit 847b6ce;
CDN-to-bundler worker f895e58).
Trigger: any dependency bump touching react-pdf or pdfjs-dist. Steps: bump
them TOGETHER to versions react-pdf declares compatible; `npm run build`;
load a PDF locally and check the console. Done when a multi-page PDF renders
with no version-mismatch error.

## Render-performance discipline (C10 in architecture-contract.md)
Refs for everything telemetry/PDF-bookkeeping; `pageNumber` is the single
deliberate state exception. Gesture/keyboard/timer effects bind once
(deps `[]`) and read live refs. New listeners: passive only.

## Geometry & zoom (fragile — test on device sizes)
- `useFitHeight`: real vertical room via useLayoutEffect + ResizeObserver,
  re-runs on fullscreen toggle, floor 280px.
- `PdfStage`: `fitWidth = min(maxWidth, availableHeight × aspectRatio)`,
  aspect learned from page 1; `usePdfZoom` scale clamps [0.5, 2.0] step 0.1.
- Zoom handler must skip zero-sized rects (NaN/Infinity guard, 02c9990).
- Next-page prefetch renders `pageNumber+1` offscreen with text/annotation
  layers off — keep layers off or prefetch cost doubles.
- Dark mode: pages get `brightness-[0.87] contrast-[1.02]` to cut glare (#12);
  preference in localStorage `ag_darkmode`, falls back to prefers-color-scheme.

## Mobile/UX invariants (each fixed a real complaint — don't regress)
- iOS zoom-on-focus: any input the reader can focus needs ≥16px font on
  mobile (`text-base sm:text-[13px]` pattern in BottomNavBar page input, #18).
- Tap targets ≥ `min-h-11 min-w-11`; safe-area insets reserved via
  `env(safe-area-inset-bottom)` (Viewer.tsx:203, BottomNavBar, JargonCard).
- DisclaimerModal is a consent gate: focus-trapped, Esc deliberately does NOT
  close it (#11). Initial focus on confirm.
- One-time swipe hint toast (coarse pointers + multipage only), last-read-page
  resume (`ag_lastpage_<fileId>`, digits-only parse, restores only page ≥2),
  page-jump input validates `/^[1-9]\d*$/` and clamps.
- Reduced motion honored via useReducedMotion (PdfStage).
- All localStorage access through the SecurityError-safe helpers (webviews).
- Honest UX only: no fake security/AI claims in copy (failure-archaeology §5).

## App.tsx (advisor UI) facts
- PDF uploaded once per session via `/api/r2-presign` + presigned PUT; the
  `r2:<key>` ref is cached in sessionStorage.
- Preview image is client-compressed to ~290KB JPEG before upload (WhatsApp
  300KB OG limit).
- Access key lives in localStorage `pwp_api_key`, sent as `x-pwp-key`.
- KNOWN STALE COPY: the upload label still says "via Firebase Storage"
  (App.tsx:495) — uploads go to R2. Fix opportunistically only with user OK.
- `src/firebase.ts` is imported nowhere in src/ — vestigial; see
  failure-archaeology §4 before "cleaning it up" (its env vars are shared
  with the server).

Re-verify: `grep -n '"pdfjs-dist"' package.json` (still exact-pinned) and `npm run build`.
