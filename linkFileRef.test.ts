// Zero-dependency gate for linkFileRef.ts (run: npx tsx linkFileRef.test.ts)
//
// The load-bearing property: for every legal shape of `f`, the id the READER
// derives (resolveFileId, the real client function) must be accepted by the
// PROXY's check, and any other document's id must be rejected.
import { fileIdMatchesLink, refFromFileField, refFromFileId } from './linkFileRef';
import { resolveFileId, fromUrlSafeBase64 } from './src/utils/pdfBridge';

let failed = false;
const assertEq = (actual: unknown, expected: unknown, label: string) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        console.log(`PASS ${label}`);
    } else {
        failed = true;
        console.error(`FAIL ${label}: expected ${e}, got ${a}`);
    }
};

const decode = fromUrlSafeBase64;

// --- Round trip against the real client encoder ---------------------------
const LEGAL_F = [
    'r2:reports/kp38d7c2_Janice_Report.pdf',
    'reports/kp38d7c2_Janice_Report.pdf',
    'https://firebasestorage.googleapis.com/v0/b/x/o/reports%2Fa.pdf?alt=media&token=abc',
    'https://acct.r2.cloudflarestorage.com/reports/a.pdf',
    'https://pub-xyz.r2.dev/reports/a.pdf',
    'https://blob.vercel-storage.com/reports/a.pdf',
    'reports/中文報告.pdf',
    'r2:reports/中文報告.pdf',
];

for (const f of LEGAL_F) {
    assertEq(fileIdMatchesLink(resolveFileId(f), f, decode), true, `round trip: ${f.slice(0, 46)}`);
}

// --- Cross-document rejection (the actual attack) -------------------------
// A live link must not act as a key for a different object in the same bucket.
assertEq(
    fileIdMatchesLink(resolveFileId('r2:reports/other_client.pdf'), 'r2:reports/mine.pdf', decode),
    false,
    'live lid cannot fetch a different r2 key',
);
assertEq(
    fileIdMatchesLink(resolveFileId('reports/other.pdf'), 'reports/mine.pdf', decode),
    false,
    'live lid cannot fetch a different storage path',
);

// A bare path and an "r2:" key are DIFFERENT backends (Firebase Storage vs R2),
// so the same-looking key under the other shape must not satisfy the check —
// the reader derives the id from `f`, so it never sends the other shape anyway.
assertEq(
    fileIdMatchesLink(resolveFileId('reports/a.pdf'), 'r2:reports/a.pdf', decode),
    false,
    'bare path does not satisfy an r2: link',
);
assertEq(
    refFromFileField('reports/a.pdf'),
    { kind: 'f', raw: 'reports/a.pdf' },
    'bare path classifies as f_',
);
assertEq(
    refFromFileField('r2:reports/a.pdf'),
    { kind: 'r2', raw: 'reports/a.pdf' },
    'r2: prefix strips to the bare key',
);

// --- Malformed / empty input ----------------------------------------------
assertEq(refFromFileField(''), null, 'empty f');
assertEq(refFromFileField(undefined as any), null, 'undefined f');
assertEq(refFromFileField(null as any), null, 'null f');
assertEq(refFromFileId('', decode), null, 'empty file id');
assertEq(refFromFileId('nope_abc', decode), null, 'unknown file id prefix');
assertEq(refFromFileId('r2_', decode), null, 'r2_ with nothing after it');
assertEq(refFromFileId('f_', decode), null, 'f_ with nothing after it');
assertEq(refFromFileId('vblob_', decode), null, 'vblob_ with nothing after it');
assertEq(fileIdMatchesLink('r2_', 'r2:reports/a.pdf', decode), false, 'empty id never matches');
assertEq(fileIdMatchesLink(resolveFileId('r2:reports/a.pdf'), '', decode), false, 'empty f never matches');
assertEq(
    fileIdMatchesLink(undefined as any, 'r2:reports/a.pdf', decode),
    false,
    'non-string id never matches',
);

// --- r2: prefix with an empty key -----------------------------------------
// /api/create-link rejects this at write time; the proxy must not treat the
// resulting empty raw as a wildcard match either.
assertEq(refFromFileField('r2:'), { kind: 'r2', raw: '' }, 'r2: with empty key');
assertEq(fileIdMatchesLink('r2_', 'r2:', decode), false, 'empty raw on both sides is not a match');

if (failed) {
    console.error('linkFileRef.test.ts FAILED');
    process.exit(1);
}
console.log('linkFileRef.test.ts OK');
