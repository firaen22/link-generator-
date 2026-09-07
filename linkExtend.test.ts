import { computeExtendedExpiry } from './linkExtend';

let failed = false;
const assertEq = (actual: unknown, expected: unknown, label: string) => {
  if (actual === expected) console.log(`PASS ${label}`);
  else { failed = true; console.error(`FAIL ${label}: expected ${expected}, got ${actual}`); }
};

const now = Date.parse('2026-01-01T00:00:00.000Z');
assertEq(computeExtendedExpiry('2026-01-10T00:00:00.000Z', now, 30), '2026-02-09T00:00:00.000Z', 'unexpired extends from expiry');
assertEq(computeExtendedExpiry('2025-12-01T00:00:00.000Z', now, 30), '2026-01-31T00:00:00.000Z', 'expired extends from now');
assertEq(computeExtendedExpiry(undefined, now, 30), '2026-01-31T00:00:00.000Z', 'undefined extends from now');
assertEq(computeExtendedExpiry('garbage', now, 30), '2026-01-31T00:00:00.000Z', 'garbage extends from now');
assertEq(computeExtendedExpiry(undefined, now, 1), '2026-01-02T00:00:00.000Z', 'one day');
assertEq(computeExtendedExpiry(undefined, now, 365), '2027-01-01T00:00:00.000Z', '365 days');
assertEq(computeExtendedExpiry('2026-12-01T00:00:00.000Z', now, 365), '2027-01-01T00:00:00.000Z', 'capped at now+365d');
assertEq(computeExtendedExpiry('2026-12-25T00:00:00.000Z', now, 30), '2027-01-01T00:00:00.000Z', 'short extend near cap clamps, not rejects');
assertEq(Number.isFinite(Date.parse(computeExtendedExpiry(undefined, now, 1))), true, 'result is ISO');

if (failed) process.exit(1);
console.log('linkExtend.test.ts OK');
