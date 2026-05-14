# Implementation Plan: Enhanced Client Behaviour Analysis

## Overview

Deepen the telemetry captured in `Viewer.tsx` and the AI analysis in `server.ts` to give advisors richer, more actionable intelligence from each client reading session. The work is split into four vertical slices — each delivering end-to-end value independently — plus a real-time alert improvement that can ship at any point.

---

## Architecture

```
Viewer.tsx  (browser — telemetry capture)
    │  sendBeacon / fetch
    ▼
/api/session-end  (server.ts — analysis)
    │
    ├── RESPONSE_SCHEMA  (Gemini structured output)
    │       └── AI fields: archetype, bias, rep_system, nlp, spin, cialdini, voss, whatsapp
    │
    └── Telegram notification  (advisor delivery)

/api/track  (server.ts — real-time events)
    └── Telegram: open, security_alert, click_appointment, [heartbeat milestone]
```

**Dependency rule:** All client-side changes in Viewer.tsx are independent of each other. Server-side schema/prompt changes in server.ts depend only on new fields being present in the payload. Each task is a complete vertical slice.

---

## Architecture Decisions

- **No new backend storage.** All new signals are passed in the existing `session-end` payload. No database schema changes needed.
- **Refs only for new tracking** — no new `useState` calls to avoid PDF canvas re-renders.
- **AI schema additions are backward-compatible** — old fields remain unchanged; new fields are additive.
- **Real-time alert uses existing `/api/track`** — no new endpoint needed.

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Payload size growth | Low | Scroll depth is one number per page, not raw samples |
| PDF canvas stutter from new listeners | Medium | Use refs and passive event listeners only |
| AI prompt becoming too long | Medium | New rules are concise; total prompt stays under 2K tokens |
| Gemini rejecting extended schema | Low | Test locally with curl before deploying |

---

## Open Questions

- Should return visit sessions be merged into one Telegram report or sent as separate reports?
- Should the real-time "reading now" alert include a link to the document?

---

## Task List

### Phase 1: Scroll Depth + CTA Page Context

---

#### Task 1: Track scroll depth per page in Viewer.tsx

**Description:** For each page, capture the maximum vertical scroll position reached as a percentage of total page height. This tells the AI whether the client read the bottom half of a page or just glanced at the top. Uses a ref (no re-renders).

**Acceptance criteria:**
- [ ] A `scrollDepthRef` map (`Record<number, number>`) tracks `maxDepthPct` (0–100) per page
- [ ] Depth is sampled on every `scroll` event using `scrollY / (documentHeight - viewportHeight)`
- [ ] Per-page depth is included in `pages_data` alongside existing `dwellMs` and `maxScale`
- [ ] No new `useState` calls — ref only

**Verification:**
- [ ] Manual: open a multi-page report, scroll halfway on page 2, close — check payload in DevTools Network tab shows `scrollDepthPct: ~50` for page 2
- [ ] Build: `npm run build` succeeds

**Dependencies:** None

**Files touched:**
- `src/Viewer.tsx`

**Estimated scope:** S

---

#### Task 2: Surface scroll depth in AI analysis

**Description:** Pass scroll depth to the server and add inference rules: a page with high dwell but low scroll depth = client read top half then stopped (strong friction signal). Update RESPONSE_SCHEMA description for `friction_points` to reference depth, and add a rule to the system prompt.

**Acceptance criteria:**
- [ ] `pages_data` entries in the `session-end` payload include `scrollDepthPct`
- [ ] System prompt includes: "scrollDepthPct < 40 on a high-dwell page = reader stopped mid-page = friction point"
- [ ] `friction_points` descriptions reference scroll depth where relevant (e.g. "Page 4: stopped at 35% depth")

**Verification:**
- [ ] Manual: trigger a test session with low scroll depth on one page; check Telegram friction_points output mentions that page
- [ ] Build succeeds

**Dependencies:** Task 1

**Files touched:**
- `server.ts`

**Estimated scope:** S

---

#### Task 3: Track CTA click page context

**Description:** When the client clicks the WhatsApp appointment button, also record which page they were on. This is the strongest buying signal — the page they were reading at the moment of conversion is their peak interest page. Pass it in the `session-end` payload.

**Acceptance criteria:**
- [ ] A `ctaClickPageRef` ref records `{ page, t }` when the appointment button is clicked
- [ ] `session-end` payload includes `cta_click_page: number | null`
- [ ] Server prompt uses this: "if cta_click_page is set, this is the highest-interest page — reference it in spin_question and advisor_nlp_approach"

**Verification:**
- [ ] Manual: click appointment button on page 5, close — payload shows `cta_click_page: 5`
- [ ] Telegram SPIN question references page 5

**Dependencies:** None (server enrichment depends on Task 2 being complete for ordering, but technically independent)

**Files touched:**
- `src/Viewer.tsx`
- `server.ts`

**Estimated scope:** S

---

### Checkpoint: After Phase 1 (Tasks 1–3)
- [ ] Build succeeds: `npm run build`
- [ ] Manual end-to-end: create a test session, verify scroll depth and CTA page appear in Telegram report
- [ ] Commit and deploy to Vercel before proceeding

---

### Phase 2: Context Signals (Device + Time-of-Day + Tab Switches)

---

#### Task 4: Capture device type and tab switch count

**Description:** Detect whether the client is on mobile or desktop (via `navigator.userAgent` / `window.innerWidth`). Count how many times they switched tabs and returned. Both go into the `session-end` payload. Tab switch count is a strong return-intent signal.

**Acceptance criteria:**
- [ ] `deviceType` is `"mobile"` or `"desktop"` detected at session start
- [ ] `tabSwitchCount` increments on every `visibilitychange` → hidden transition after the initial load
- [ ] Both fields included in `session-end` payload

**Verification:**
- [ ] Manual: open on mobile (or simulate), switch tabs twice, close — payload shows correct device and count
- [ ] Build succeeds

**Dependencies:** None

**Files touched:**
- `src/Viewer.tsx`

**Estimated scope:** S

---

#### Task 5: Incorporate device and tab switch into AI analysis

**Description:** Add inference rules to the system prompt. Mobile sessions should lower the `isDeepRead` threshold interpretation (mobile = harder to read long docs, so same engagement = higher intent). Tab switching > 2 = returning reader = strong buying signal.

**Acceptance criteria:**
- [ ] System prompt rule: "mobile device: weight engagement signals 1.3× — mobile reading requires more intent than desktop"
- [ ] System prompt rule: "tabSwitchCount > 2: client returned multiple times = elevate intent_archetype toward Deep Diver or Momentum Buyer"
- [ ] `advisor_nlp_approach` references device context where relevant ("client was on mobile — keep follow-up concise")
- [ ] Time-of-day (extracted from session `timestamp`) surfaced in Telegram: morning / afternoon / evening label

**Verification:**
- [ ] Manual: trigger analysis with `tabSwitchCount: 3` — check archetype is elevated
- [ ] Telegram notification shows time-of-day label

**Dependencies:** Task 4

**Files touched:**
- `server.ts`

**Estimated scope:** S

---

### Checkpoint: After Phase 2 (Tasks 4–5)
- [ ] Build succeeds
- [ ] Manual: full test session on mobile with tab switching — Telegram shows device, time, tab count, adjusted analysis
- [ ] Commit and deploy

---

### Phase 3: Return Visit Detection

---

#### Task 6: Detect and flag return visits

**Description:** The `localStorage` recovery path already exists in Viewer.tsx. Extend it to set a `isReturnVisit: boolean` flag when prior session data is found. Pass it in `session-end`. On the server, a return visit overrides the `isDeepRead` threshold — any return visit triggers AI analysis regardless of progress %.

**Acceptance criteria:**
- [ ] `isReturnVisitRef` is `true` when `localStorage` contains prior session data for this `fileId + clientName`
- [ ] `session-end` payload includes `is_return_visit: boolean`
- [ ] Server skips `isDeepRead` check if `is_return_visit === true`
- [ ] Telegram report includes "🔄 Return Visit" label when applicable
- [ ] System prompt rule: "is_return_visit: true = client came back to re-read = strongest buying signal; elevate cialdini_lever to Consistency or Scarcity"

**Verification:**
- [ ] Manual: open a report, close after 5s (below deep read threshold), reopen — Telegram report fires and shows return visit label
- [ ] First visit with < 30% progress: no AI analysis. Return visit: AI analysis fires.

**Dependencies:** None (independent of Phase 2)

**Files touched:**
- `src/Viewer.tsx`
- `server.ts`

**Estimated scope:** M

---

### Checkpoint: After Phase 3 (Task 6)
- [ ] Build succeeds
- [ ] Manual: two-session test (first short, second return) — verify second triggers AI with return visit label
- [ ] Commit and deploy

---

### Phase 4: Real-Time "Reading Now" Alert

---

#### Task 7: Milestone heartbeat alert in /api/track

**Description:** The heartbeat fires every 30s but is currently suppressed. Add one specific milestone alert: at exactly 60 seconds of reading, send a Telegram "🟢 Client is reading RIGHT NOW" notification. This gives the advisor a live signal to be ready for inbound contact.

**Acceptance criteria:**
- [ ] `sendTrackingEvent('heartbeat')` payload includes `duration_seconds`
- [ ] Server `/api/track` sends Telegram when `event === 'heartbeat'` AND `duration_seconds === 60`
- [ ] Message format: `🟢 <b>正在閱讀中</b> — [client_name] 已閱讀 [report_name] 超過 1 分鐘`
- [ ] Only fires once per session (not at 120s, 180s, etc.)

**Verification:**
- [ ] Manual: open a report, wait 65 seconds — Telegram alert fires within 5s
- [ ] Does not fire again at 90s or 120s

**Dependencies:** None

**Files touched:**
- `server.ts`

**Estimated scope:** XS

---

### Checkpoint: Final
- [ ] All 7 tasks complete
- [ ] Full end-to-end test: open report on mobile, read 3 pages, switch tabs twice, click WhatsApp button, close — verify Telegram shows: open alert → reading now alert (60s) → appointment click alert → session analysis with all new fields
- [ ] `npm run build` succeeds
- [ ] Deployed to production and verified on `share.pmd-hk.com`
