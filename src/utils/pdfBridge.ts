/**
 * PDF Bridge Utility
 * Centralizes the logic for generating secure, proxied PDF URLs
 * supporting both shorthand Firebase IDs and full tokenized URLs.
 */

import LZString from 'lz-string';

/**
 * Converts a string to a URL-safe Base64 format compatible with the backend.
 */
export const toUrlSafeBase64 = (str: string): string => {
    if (!str) return '';
    try {
        // Use a more robust browser-side URL-safe base64 encoding
        const bytes = new TextEncoder().encode(str);
        const binString = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
        return btoa(binString)
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
    } catch (e) {
        console.error('[PDF_BRIDGE] Base64 encoding error:', e);
        return '';
    }
};

/**
 * Determines the final proxied file ID based on the raw file path/URL.
 */
export const resolveFileId = (fileFromProp: string | null): string => {
    if (!fileFromProp) return '';

    // If it's a full URL (Vercel Blob or tokenized Firebase URL)
    if (fileFromProp.includes('://') || fileFromProp.includes('firebasestorage.googleapis.com')) {
        return `vblob_${toUrlSafeBase64(fileFromProp)}`;
    }

    // Assume shorthand path relative to Firebase Storage (e.g. "reports/...")
    return `f_${toUrlSafeBase64(fileFromProp)}`;
};

/**
 * Generates the full API proxy URL for a given file ID.
 */
export const getProxiedPdfUrl = (fileId: string): string => {
    if (!fileId) return '';
    return `/api/pdf/${fileId}`;
};

/**
 * Decodes the 'q' parameter from the URL, which contains the compressed payload.
 */
export const decodeCompressedPayload = (q: string | null) => {
    if (!q) return null;
    try {
        const decompressed = LZString.decompressFromEncodedURIComponent(q);
        if (!decompressed) return null;
        return JSON.parse(decompressed);
    } catch (e) {
        console.error('[PDF_BRIDGE] Failed to decode payload:', e);
        return null;
    }
};
