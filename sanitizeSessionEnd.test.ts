import { sanitizeSessionEnd } from './sanitizeSessionEnd';

let failed = false;
const assertEq = (actual: unknown, expected: unknown, label: string) => {
  if (actual === expected) console.log(`PASS ${label}`);
  else { failed = true; console.error(`FAIL ${label}: expected ${expected}, got ${actual}`); }
};

assertEq(sanitizeSessionEnd({}).ask_page_clicks, 0, 'missing');
assertEq(sanitizeSessionEnd({ ask_page_clicks: 3 }).ask_page_clicks, 3, 'three');
assertEq(sanitizeSessionEnd({ ask_page_clicks: -1 }).ask_page_clicks, 0, 'negative');
assertEq(sanitizeSessionEnd({ ask_page_clicks: 1.5 }).ask_page_clicks, 0, 'fraction');
assertEq(sanitizeSessionEnd({ ask_page_clicks: '2' }).ask_page_clicks, 2, 'numeric string');
assertEq(sanitizeSessionEnd({ ask_page_clicks: 10001 }).ask_page_clicks, 0, 'oversized');
assertEq(sanitizeSessionEnd({ ask_page_clicks: NaN }).ask_page_clicks, 0, 'NaN');
assertEq(sanitizeSessionEnd(null).ask_page_clicks, 0, 'non-object');

if (failed) process.exit(1);
console.log('sanitizeSessionEnd.test.ts OK');
