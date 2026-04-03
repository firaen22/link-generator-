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
        // Standard UTF-8 to Base64 trick
        const bytes = new TextEncoder().encode(str);
        const binString = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
        const base64 = btoa(binString);
        // Convert to URL-safe (replaces + with - and / with _)
        return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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

    // If it's a full URL (R2, Vercel Blob or tokenized Firebase URL)
    if (fileFromProp.includes('://') || fileFromProp.includes('firebasestorage.googleapis.com')) {
        // If it's a Cloudflare R2 URL (usually custom domain or r2.cloudflarestorage.com or contains R2 key pattern)
        // For simplicity, if we know it's being stored as an R2 key in Firestore, we handle it.
        // If the path starts with 'reports/' and isn't a firebase URL, it might be R2.
        // But the most robust way is to check the URL or a prefix.
        if (fileFromProp.includes('r2.cloudflarestorage.com') || fileFromProp.includes('r2.dev')) {
             return `r2_${toUrlSafeBase64(fileFromProp)}`;
        }
        return `vblob_${toUrlSafeBase64(fileFromProp)}`;
    }

    // Direct R2 key support (if f is just the key and we want to distinguish from firebase)
    if (fileFromProp.startsWith('r2:')) {
        return `r2_${toUrlSafeBase64(fileFromProp.slice(3))}`;
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
