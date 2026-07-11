// Zero-dependency edge-case gate for src/viewer/jargon.ts (run: npx tsx src/viewer/jargon.test.ts)
import {
    JARGON_IMAGE_MAX_B64_LEN,
    extractJargonImageBase64,
    isJargonEligible,
    jargonCacheKey,
    jargonImageDims,
    parseJargonResponse,
    prepareJargonText,
} from './jargon';

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

// jargonImageDims — NaN/zero/negative/oversize/undersize/bad maxDim
assertEq(jargonImageDims(NaN, 500), { width: 1, height: 1 }, 'dims NaN width');
assertEq(jargonImageDims(0, 0), { width: 1, height: 1 }, 'dims zero');
assertEq(jargonImageDims(-5, 10), { width: 1, height: 1 }, 'dims negative');
assertEq(jargonImageDims(2000, 1000), { width: 1280, height: 640 }, 'dims downscale landscape');
assertEq(jargonImageDims(1000, 2000), { width: 640, height: 1280 }, 'dims downscale portrait');
assertEq(jargonImageDims(100, 50), { width: 100, height: 50 }, 'dims never upscale');
assertEq(jargonImageDims(2000, 1000, 0), { width: 1280, height: 640 }, 'dims maxDim=0 falls back');
assertEq(jargonImageDims(2000, 1000, -1), { width: 1280, height: 640 }, 'dims maxDim<0 falls back');
assertEq(jargonImageDims(2000, 1000, NaN), { width: 1280, height: 640 }, 'dims maxDim NaN falls back');

// extractJargonImageBase64 — rejects
assertEq(extractJargonImageBase64(123), null, 'b64 non-string');
assertEq(extractJargonImageBase64(''), null, 'b64 empty');
assertEq(extractJargonImageBase64('null'), null, 'b64 literal null');
assertEq(extractJargonImageBase64('undefined'), null, 'b64 literal undefined');
assertEq(extractJargonImageBase64('data:image/png;base64,AAAA'), null, 'b64 wrong mime');
assertEq(extractJargonImageBase64('AAA'), null, 'b64 len%4');
assertEq(extractJargonImageBase64('AA=A'), null, 'b64 padding mid-string');
assertEq(extractJargonImageBase64('AAA!'), null, 'b64 bad char');
assertEq(extractJargonImageBase64('A'.repeat(JARGON_IMAGE_MAX_B64_LEN + 4)), null, 'b64 oversized');
// accepts
assertEq(extractJargonImageBase64('data:image/jpeg;base64,' + 'A'.repeat(400)), 'A'.repeat(400), 'b64 data url ok');
assertEq(extractJargonImageBase64('A'.repeat(400)), 'A'.repeat(400), 'b64 bare ok');
assertEq(extractJargonImageBase64('AB=='), 'AB==', 'b64 trailing padding ok');
assertEq(JARGON_IMAGE_MAX_B64_LEN, 900_000, 'b64 cap aligned under 1mb body limit');

// isJargonEligible
assertEq(isJargonEligible(''), false, 'eligible empty');
assertEq(isJargonEligible('x'.repeat(39)), false, 'eligible 39');
assertEq(isJargonEligible('x'.repeat(40)), true, 'eligible 40');
assertEq(isJargonEligible('   ' + 'x'.repeat(10) + '   '), false, 'eligible padded short');
assertEq(isJargonEligible(undefined as any), false, 'eligible undefined no-throw');

// prepareJargonText
assertEq(prepareJargonText('  a\n\n b\tc  '), 'a b c', 'prepare collapse');
assertEq(prepareJargonText('y'.repeat(7000)).length, 6000, 'prepare cap 6000');

// jargonCacheKey (lang dropped in this port)
assertEq(jargonCacheKey('u', 3, 'text'), 'u#3#text', 'cache key shape');

// parseJargonResponse
assertEq(parseJargonResponse(null), [], 'parse null');
assertEq(parseJargonResponse([]), [], 'parse array');
assertEq(parseJargonResponse({ success: false, terms: [] }), [], 'parse success=false');
assertEq(parseJargonResponse({ success: true, terms: 'x' }), [], 'parse terms non-array');
assertEq(
    parseJargonResponse({
        success: true,
        terms: [
            { term: '  T  ', explanation: '  E  ' },
            { term: '', explanation: 'e' },
            { term: 't', explanation: '' },
            null,
            'str',
            { term: 'A'.repeat(100), explanation: 'B'.repeat(300) },
        ],
    }),
    [
        { term: 'T', explanation: 'E' },
        { term: 'A'.repeat(80), explanation: 'B'.repeat(200) },
    ],
    'parse sanitize/truncate',
);
assertEq(
    parseJargonResponse({
        success: true,
        terms: [1, 2, 3, 4, 5, 6].map((i) => ({ term: `t${i}`, explanation: `e${i}` })),
    }).length,
    4,
    'parse cap 4',
);

process.exit(failed ? 1 : 0);
