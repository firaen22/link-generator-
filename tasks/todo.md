# Task List — Enhanced Client Behaviour Analysis

## Phase 1: Scroll Depth + CTA Page Context

- [x] **Task 1** — Track scroll depth per page (`scrollDepthPct` ref in Viewer.tsx) — `src/Viewer.tsx` — Size: S
- [x] **Task 2** — Surface scroll depth in AI analysis (system prompt rule + friction_points) — `server.ts` — Size: S
- [x] **Task 3** — Track CTA click page context (`ctaClickPageRef`, pass `cta_click_page` in payload) — `src/Viewer.tsx`, `server.ts` — Size: S

### Checkpoint 1 ✅

---

## Phase 2: Context Signals

- [x] **Task 4** — Capture device type + tab switch count in Viewer.tsx — `src/Viewer.tsx` — Size: S
- [x] **Task 5** — Incorporate device + tab switch + time-of-day into AI analysis — `server.ts` — Size: S

### Checkpoint 2 ✅

---

## Phase 3: Return Visit Detection

- [x] **Task 6** — Detect return visit (tab_switch_count >= 2), skip isDeepRead gate, add Telegram label + Cialdini Consistency rule — `server.ts` — Size: M

### Checkpoint 3 ✅

---

## Phase 4: Real-Time Alert

- [x] **Task 7** — 60-second milestone heartbeat Telegram alert — `server.ts` — Size: XS

### Final Checkpoint ✅
- [x] Build passes (`npm run build`)
- [x] Type-check clean
- [ ] Manual end-to-end test in production
