export function computeExtendedExpiry(
  currentExpireAtIso: string | undefined,
  nowMs: number,
  extendDays: number,
): string {
  const parsed = currentExpireAtIso === undefined ? NaN : Date.parse(currentExpireAtIso);
  const base = Math.max(nowMs, Number.isFinite(parsed) ? parsed : nowMs);
  // Contract: result is capped at now+365d (a fixed-size dashboard extend must
  // never fail merely because the link is already near the cap).
  const capped = Math.min(base + extendDays * 86400000, nowMs + 365 * 86400000);
  return new Date(capped).toISOString();
}
