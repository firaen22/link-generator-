export interface JargonTerm {
    term: string;
    explanation: string;
}

export const JARGON_MIN_TEXT_LEN = 40;
export const JARGON_MAX_TEXT_LEN = 6000;
export const JARGON_IMAGE_MAX_DIM = 1280;
export const JARGON_IMAGE_MAX_B64_LEN = 900_000;

export function jargonCacheKey(pdfUrl: string, page: number, path: 'text' | 'image'): string {
    return `${pdfUrl}#${page}#${path}`;
}

export function isJargonEligible(text: string): boolean {
    return typeof text === 'string' && text.trim().length >= JARGON_MIN_TEXT_LEN;
}

export function jargonImageDims(w: number, h: number, maxDim = JARGON_IMAGE_MAX_DIM): { width: number; height: number } {
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
        return { width: 1, height: 1 };
    }

    const safeMaxDim = Number.isFinite(maxDim) && maxDim > 0 ? maxDim : JARGON_IMAGE_MAX_DIM;
    const scale = Math.min(1, safeMaxDim / Math.max(w, h));
    return {
        width: Math.max(1, Math.floor(w * scale)),
        height: Math.max(1, Math.floor(h * scale)),
    };
}

export function extractJargonImageBase64(dataUrl: unknown): string | null {
    if (typeof dataUrl !== 'string') return null;
    if (dataUrl.length === 0 || dataUrl === 'null' || dataUrl === 'undefined') return null;
    if (dataUrl.startsWith('data:') && !dataUrl.startsWith('data:image/jpeg;base64,')) return null;

    const base64 = dataUrl.startsWith('data:image/jpeg;base64,')
        ? dataUrl.slice('data:image/jpeg;base64,'.length)
        : dataUrl;

    if (base64.length === 0 || base64.length > JARGON_IMAGE_MAX_B64_LEN) return null;
    if (base64.length % 4 !== 0) return null;
    if (!/^[A-Za-z0-9+/=]+$/.test(base64)) return null;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;
    return base64;
}

export function prepareJargonText(text: string): string {
    return text.trim().replace(/\s+/g, ' ').slice(0, JARGON_MAX_TEXT_LEN);
}

export function parseJargonResponse(payload: unknown): JargonTerm[] {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
    const data = payload as { success?: unknown; terms?: unknown };
    if (data.success !== true || !Array.isArray(data.terms)) return [];

    return data.terms
        .filter((entry): entry is { term: unknown; explanation: unknown } => !!entry && typeof entry === 'object')
        .map(entry => ({
            term: typeof entry.term === 'string' ? entry.term.trim().slice(0, 80) : '',
            explanation: typeof entry.explanation === 'string' ? entry.explanation.trim().slice(0, 200) : '',
        }))
        .filter(entry => entry.term.length > 0 && entry.explanation.length > 0)
        .slice(0, 4);
}
