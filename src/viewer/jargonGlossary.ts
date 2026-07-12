// Curated financial-jargon glossary for the PDF reader's explanation card.
// Ported from marketview-index (lib/jargonGlossary.ts); trimmed to zh-TW only,
// since this reader has no English path.
//
// PURPOSE — stop the AI from explaining terms wrongly. When Gemini returns a term
// that MATCHES an entry here AND that entry has a vetted explanation, the model's
// wording is REPLACED with the house-approved text verbatim (applyJargonGlossary).
// The model still handles the long tail of terms not listed here.
//
// To edit:
//  - Change `explanation` freely; keep it short — it renders in a small card.
//  - An EMPTY string ('') is IGNORED, so the AI's own explanation is used until
//    you fill it in. Blank entries are safe to ship.
//  - `aliases` = every surface form that should map to this entry (abbreviations,
//    English and 繁中 spellings, e.g. 'bps', 'basis point', '基點'). Matching is
//    case-insensitive and ignores surrounding brackets / punctuation / spaces.

export interface GlossaryEntry {
    aliases: string[];
    explanation: string;
}

export const JARGON_GLOSSARY: GlossaryEntry[] = [
    { aliases: ["money market fund", "mmf", "貨幣市場基金"], explanation: "一種低風險基金，投資於短期債務，類似銀行儲蓄戶口，但回報可能略高且不設存款保障。" },
    { aliases: ["accumulating", "accumulation", "acc", "累積", "累積類別"], explanation: "基金將賺取的股息或利息自動重新投資以買入更多基金單位，而非向您派發現金。" },
    { aliases: ["distributing", "distribution", "dist", "派息", "分派", "派息類別"], explanation: "基金定期（如每月或每季）將賺取的利息或股息，以現金形式直接派發給投資者。" },
    { aliases: ["share class", "class a", "a class", "a類別", "a 類別", "類別"], explanation: "同一隻基金的不同版本（如A類或I類），投資於相同資產，但收費或最低投資額不同。" },
    { aliases: ["nav", "net asset value", "資產淨值", "每單位資產淨值"], explanation: "基金每單位的價格，由基金總資產扣除負債後，除以發行在外的總單位數求得。" },
    { aliases: ["management fee", "管理費"], explanation: "支付給基金經理的管理服務年費，通常按投資總額的某個百分比（如1%）計算。" },
    { aliases: ["expense ratio", "ongoing charges", "ter", "費用比率", "經常性開支"], explanation: "營運基金的年度總成本（包括管理和行政費），佔投資額的百分比（如每年1.5%）。" },
    { aliases: ["subscription", "認購", "申購"], explanation: "投資者投入資金以買入基金新單位的過程。" },
    { aliases: ["redemption", "贖回"], explanation: "投資者將持有的基金單位賣回給基金公司，以取回現金。" },
    { aliases: ["aum", "assets under management", "資產管理規模", "管理資產"], explanation: "某基金或金融機構代投資者管理的所有資產之總市場價值。" },
    { aliases: ["duration", "存續期", "久期"], explanation: "衡量債券價格對利率變動的敏感度。若存續期為5年，利率上升1%時債券價格約下跌5%。" },
    { aliases: ["modified duration", "修正存續期"], explanation: "利率每變動1%時，債券價格預期變動的精確百分比。" },
    { aliases: ["yield to maturity", "ytm", "到期收益率", "到期殖利率"], explanation: "若今天買入債券並持有至到期日，在發行人沒有違約下，預期獲得的平均年化回報率。" },
    { aliases: ["coupon", "coupon rate", "票息", "票面利率"], explanation: "債券發行人定期支付給持有人的固定利息，按債券面值的年利率計算。" },
    { aliases: ["basis point", "basis points", "bp", "bps", "基點", "個基點"], explanation: "金融計量單位，等於百分之零點零一（0.01%）。例如減息50個基點即減息0.5%。" },
    { aliases: ["credit spread", "spread", "信用利差", "息差", "利差"], explanation: "風險債券與同期限安全國債之間的收益率差距，用作補償投資者承擔的違約風險。" },
    { aliases: ["investment grade", "ig", "投資級", "投資級別"], explanation: "評級在BBB-或以上的債券，代表發行人違約風險較低，屬於較安全的投資。" },
    { aliases: ["high yield", "junk bond", "non-investment grade", "高收益", "非投資級"], explanation: "評級較低（BBB-以下）的債券，因違約風險較高，故需支付較高利息吸引投資者。" },
    { aliases: ["yield curve", "收益率曲線", "殖利率曲線"], explanation: "顯示不同期限債券收益率關係的曲線。通常期限越長，收益率越高。" },
    { aliases: ["maturity", "到期", "到期日"], explanation: "債券合約結束的日期，屆時發行人必須向投資者全數歸還借入的本金。" },
    { aliases: ["credit rating", "信用評級", "信貸評級"], explanation: "評級機構對債務人還款能力的評估（如AAA級最安全，D級代表已違約）。" },
    { aliases: ["p/e ratio", "pe ratio", "price-to-earnings", "pe", "市盈率", "本益比"], explanation: "股票價格除以每股盈利。市盈率15倍代表您為企業每1元的年利潤支付15元。" },
    { aliases: ["eps", "earnings per share", "每股盈利", "每股盈餘"], explanation: "企業總利潤除以發行在外的股票總數，代表每股股票所分攤到的淨利潤。" },
    { aliases: ["ebitda", "稅息折舊及攤銷前利潤"], explanation: "扣除利息、稅項、折舊及攤銷前的企業利潤，反映其核心業務的賺錢能力。" },
    { aliases: ["dividend yield", "股息率", "股息收益率"], explanation: "年度每股股息除以股價。如股息率是4%，代表持有一百元股票每年可收四元股息。" },
    { aliases: ["market cap", "market capitalization", "market capitalisation", "市值", "市場資本"], explanation: "公司所有發行在外股票的總價值。如有一百萬股，每股五十元，市值即五千萬元。" },
    { aliases: ["free cash flow", "fcf", "自由現金流"], explanation: "企業扣除營運開支及購買設備等資本開支後，剩下可自由分配給股東的現金。" },
    { aliases: ["federal funds rate", "fed funds rate", "policy rate", "聯邦基金利率", "政策利率"], explanation: "美國聯邦儲備局設定的基準利率，決定商業銀行之間的隔夜借貸成本，影響全球息率。" },
    { aliases: ["inflation", "cpi", "consumer price index", "通脹", "通膨", "消費者物價指數"], explanation: "物價隨時間持續上升的現象，會令貨幣購買力下降。通脹率3%即今年百元商品明年賣百三元。" },
    { aliases: ["gdp", "gross domestic product", "國內生產總值", "本地生產總值"], explanation: "一國在特定時期內生產的所有最終商品和服務的總價值，用以衡量經濟規模。" },
    { aliases: ["hawkish", "鷹派"], explanation: "央行傾向提高利率以抑制通脹的立場，即使這可能會拖慢經濟增長步伐。" },
    { aliases: ["dovish", "鴿派"], explanation: "央行傾向降低利率以刺激經濟和就業的立場，對通脹的容忍度通常較高。" },
    { aliases: ["soft landing", "軟著陸"], explanation: "央行提高利率成功抑制通脹，同時避免經濟陷入衰退或導致失業率飆升。" },
    { aliases: ["contango", "期貨溢價", "正價差"], explanation: "期貨價格高於現貨價格的情況，通常因為持有合約至到期需要支付倉儲和保險成本。" },
    { aliases: ["backwardation", "期貨貼水", "逆價差"], explanation: "期貨價格低於現貨價格的情況，通常反映市場對現貨的即時需求非常急切或供應短缺。" },
    { aliases: ["volatility", "vol", "波動率", "波幅"], explanation: "衡量資產價格在一段時間內上下波動幅度和速度的指標。" },
    { aliases: ["hedging", "hedge", "對沖", "避險"], explanation: "透過進行相反方向的投資來降低現有資產價格波動風險的策略，如同為投資買保險。" },
    { aliases: ["leverage", "gearing", "槓桿"], explanation: "利用借入的資金來放大投資的潛在回報，但同時亦會按比例放大潛在的虧損風險。" },
    { aliases: ["liquidity", "流動性", "流通性"], explanation: "資產在市場上變現的難易及快捷程度，且不會對其市場價格造成重大影響。" },
    { aliases: ["diversification", "分散投資", "多元化"], explanation: "將資金分配到不同的資產類別以降低整體風險，俗稱「不要把所有雞蛋放在同一個籃子裡」。" },
];

// Match key: lower-case, whitespace-collapsed, and stripped of the brackets and
// punctuation that models sprinkle around terms (e.g. "A類別（累積）", "bps.").
// Chinese characters are unaffected by lower-casing.
export function normalizeTerm(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/[()（）[\]【】「」.,、，。：:;；]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

export function buildGlossaryLookup(entries: GlossaryEntry[]): Map<string, GlossaryEntry> {
    const lookup = new Map<string, GlossaryEntry>();
    for (const entry of entries) {
        for (const alias of entry.aliases) {
            const key = normalizeTerm(alias);
            // First alias wins on collision — keeps behaviour deterministic if two
            // entries accidentally share a surface form.
            if (key && !lookup.has(key)) lookup.set(key, entry);
        }
    }
    return lookup;
}

// Returns the vetted explanation for a term, or null when the term is unknown OR
// its explanation is still blank.
export function lookupExplanation(term: string, lookup: Map<string, GlossaryEntry>): string | null {
    const entry = lookup.get(normalizeTerm(term));
    if (!entry) return null;
    const vetted = entry.explanation.trim();
    return vetted ? vetted : null;
}

// Deterministic override: replace the explanation of any term that has a vetted
// glossary entry. Terms without a (filled) entry pass through untouched, so the
// model's own explanation is kept for everything else.
export function overrideExplanations<T extends { term: string; explanation: string }>(
    terms: T[],
    lookup: Map<string, GlossaryEntry>,
): T[] {
    return terms.map(item => {
        const vetted = lookupExplanation(item.term, lookup);
        return vetted ? { ...item, explanation: vetted } : item;
    });
}

const DEFAULT_LOOKUP = buildGlossaryLookup(JARGON_GLOSSARY);

// Production convenience wrapper bound to the real glossary above.
export function applyJargonGlossary<T extends { term: string; explanation: string }>(terms: T[]): T[] {
    return overrideExplanations(terms, DEFAULT_LOOKUP);
}
