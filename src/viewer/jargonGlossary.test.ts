// Zero-dependency gate for src/viewer/jargonGlossary.ts
// (run: npx tsx src/viewer/jargonGlossary.test.ts)
import {
    JARGON_GLOSSARY,
    applyJargonGlossary,
    buildGlossaryLookup,
    lookupExplanation,
    normalizeTerm,
    overrideExplanations,
    type GlossaryEntry,
} from './jargonGlossary';

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

const ENTRIES: GlossaryEntry[] = [
    { aliases: ['basis point', 'bps', '基點'], explanation: '1 個基點 = 0.01%。' },
    { aliases: ['duration', '存續期'], explanation: '' }, // blank — must be ignored
];
const LOOKUP = buildGlossaryLookup(ENTRIES);

// normalizeTerm
assertEq(normalizeTerm('  Basis   Point '), 'basis point', 'normalize lower/trim/collapse');
assertEq(normalizeTerm('（A類別）'), 'a類別', 'normalize strips CJK brackets');
assertEq(normalizeTerm('bps.'), 'bps', 'normalize strips trailing punctuation');
assertEq(normalizeTerm('基點'), '基點', 'normalize leaves CJK intact');

// lookupExplanation
assertEq(lookupExplanation('Basis Point', LOOKUP), '1 個基點 = 0.01%。', 'lookup by english alias, case-insensitive');
assertEq(lookupExplanation('BPS', LOOKUP), '1 個基點 = 0.01%。', 'lookup by abbreviation');
assertEq(lookupExplanation('基點', LOOKUP), '1 個基點 = 0.01%。', 'lookup by CJK alias');
assertEq(lookupExplanation('EBITDA', LOOKUP), null, 'lookup unknown term -> null');
assertEq(lookupExplanation('存續期', LOOKUP), null, 'lookup blank entry -> null');

// overrideExplanations
const overridden = overrideExplanations(
    [
        { term: 'Basis Point', explanation: 'model wording that could be wrong' },
        { term: 'EBITDA', explanation: 'model wording, kept' },
    ],
    LOOKUP,
);
assertEq(overridden[0].explanation, '1 個基點 = 0.01%。', 'override replaces matched term');
assertEq(overridden[1].explanation, 'model wording, kept', 'override leaves unknown term untouched');
assertEq(
    overrideExplanations([{ term: '存續期', explanation: 'model wording, kept' }], LOOKUP)[0].explanation,
    'model wording, kept',
    'override keeps model wording for blank entry',
);
// preserves extra fields on the term object
assertEq(
    overrideExplanations([{ term: '基點', explanation: 'x', rank: 3 } as any], LOOKUP)[0],
    { term: '基點', explanation: '1 個基點 = 0.01%。', rank: 3 },
    'override preserves extra fields',
);

// applyJargonGlossary — bound to the real production glossary
assertEq(
    applyJargonGlossary([{ term: '存續期', explanation: 'AI 亂答' }])[0].explanation,
    '衡量債券價格對利率變動的敏感度。若存續期為5年，利率上升1%時債券價格約下跌5%。',
    'production glossary overrides 存續期',
);
assertEq(
    applyJargonGlossary([{ term: 'EBITDA', explanation: 'AI 亂答' }])[0].explanation,
    '扣除利息、稅項、折舊及攤銷前的企業利潤，反映其核心業務的賺錢能力。',
    'production glossary overrides EBITDA (english alias)',
);
assertEq(
    applyJargonGlossary([{ term: '某個不存在的詞', explanation: '保留原文' }])[0].explanation,
    '保留原文',
    'production glossary passes through unknown term',
);

// every production entry has at least one alias and a non-empty explanation
const emptyEntries = JARGON_GLOSSARY.filter(e => e.aliases.length === 0 || !e.explanation.trim());
assertEq(emptyEntries.length, 0, 'all production entries have aliases + explanation');

if (failed) {
    console.error('\nSOME TESTS FAILED');
    process.exit(1);
} else {
    console.log('\nALL TESTS PASSED');
}
