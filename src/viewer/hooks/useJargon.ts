import { useCallback, useEffect, useRef, useState } from 'react';
import {
    extractJargonImageBase64,
    isJargonEligible,
    jargonCacheKey,
    parseJargonResponse,
    prepareJargonText,
    type JargonTerm,
} from '../jargon';

interface Options {
    enabled: boolean;
    pdfUrl: string;
    fileId: string;
}

interface LatestPageText {
    key: string;
    pdfUrl: string;
    page: number;
    text: string;
    image?: string;
}

export function useJargon(opts: Options): {
    terms: JargonTerm[];
    onPageText: (page: number, text: string, imageDataUrl?: string) => void;
    onPageChange: () => void;
} {
    const { enabled, pdfUrl, fileId } = opts;
    const [terms, setTerms] = useState<JargonTerm[]>([]);
    const cacheRef = useRef(new Map<string, JargonTerm[]>());
    const latestRef = useRef<LatestPageText | null>(null);
    const activeRequestKeyRef = useRef<string | null>(null);
    const debounceRef = useRef<number | null>(null);
    const enabledRef = useRef(enabled);
    const pdfUrlRef = useRef(pdfUrl.trim());
    const fileIdRef = useRef(fileId);
    const warnedFailureKeysRef = useRef(new Set<string>());

    const clearDebounce = useCallback(() => {
        if (debounceRef.current !== null) {
            window.clearTimeout(debounceRef.current);
            debounceRef.current = null;
        }
    }, []);

    const warnFailure = useCallback((key: string, error: unknown) => {
        if (warnedFailureKeysRef.current.has(key)) return;
        warnedFailureKeysRef.current.add(key);
        console.warn('Failed to fetch jargon explanations', error);
    }, []);

    const runPipeline = useCallback((page: number, text: string, imageDataUrl?: string) => {
        const currentPdfUrl = pdfUrlRef.current;
        latestRef.current = { key: '', pdfUrl: currentPdfUrl, page, text, image: imageDataUrl };
        if (!enabledRef.current) return;
        clearDebounce();

        const imageBase64 = isJargonEligible(text) ? null : extractJargonImageBase64(imageDataUrl);
        const path: 'text' | 'image' | null = isJargonEligible(text)
            ? 'text'
            : imageBase64
                ? 'image'
                : null;
        if (!path) {
            activeRequestKeyRef.current = null;
            setTerms([]);
            return;
        }

        const key = jargonCacheKey(currentPdfUrl, page, path);
        latestRef.current = { key, pdfUrl: currentPdfUrl, page, text, image: imageDataUrl };

        const cached = cacheRef.current.get(key);
        if (cached) {
            activeRequestKeyRef.current = null;
            setTerms(cached);
            return;
        }

        setTerms([]);
        activeRequestKeyRef.current = key;
        debounceRef.current = window.setTimeout(async () => {
            const requestKey = key;
            const requestPath = path;
            try {
                const body = requestPath === 'text'
                    ? { text: prepareJargonText(text), fileId: fileIdRef.current, page }
                    : { imageBase64, fileId: fileIdRef.current, page };
                const response = await fetch('/api/explain-jargon', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                if (!response.ok) {
                    if (response.status !== 503) warnFailure(requestKey, new Error(`HTTP ${response.status}`));
                    if (activeRequestKeyRef.current === requestKey) {
                        const latest = latestRef.current;
                        const currentKey = latest && latest.pdfUrl === pdfUrlRef.current
                            ? jargonCacheKey(pdfUrlRef.current, latest.page, requestPath)
                            : null;
                        if (currentKey === requestKey) setTerms([]);
                    }
                    return;
                }

                let payload: unknown;
                try {
                    payload = await response.json();
                } catch (error) {
                    warnFailure(requestKey, error);
                    payload = null;
                }

                const nextTerms = parseJargonResponse(payload);
                cacheRef.current.set(requestKey, nextTerms);
                const latest = latestRef.current;
                const currentKey = latest && latest.pdfUrl === pdfUrlRef.current
                    ? jargonCacheKey(pdfUrlRef.current, latest.page, requestPath)
                    : null;
                if (activeRequestKeyRef.current === requestKey && currentKey === requestKey) {
                    setTerms(nextTerms);
                }
            } catch (error) {
                warnFailure(requestKey, error);
                const latest = latestRef.current;
                const currentKey = latest && latest.pdfUrl === pdfUrlRef.current
                    ? jargonCacheKey(pdfUrlRef.current, latest.page, requestPath)
                    : null;
                if (activeRequestKeyRef.current === requestKey && currentKey === requestKey) {
                    setTerms([]);
                }
            }
        }, 600);
    }, [clearDebounce, warnFailure]);

    const onPageText = useCallback((page: number, text: string, imageDataUrl?: string) => {
        runPipeline(page, text, imageDataUrl);
    }, [runPipeline]);

    const onPageChange = useCallback(() => {
        clearDebounce();
        activeRequestKeyRef.current = null;
        setTerms([]);
    }, [clearDebounce]);

    useEffect(() => {
        fileIdRef.current = fileId;
    }, [fileId]);

    useEffect(() => {
        pdfUrlRef.current = pdfUrl.trim();
        clearDebounce();
        activeRequestKeyRef.current = null;
        setTerms([]);
    }, [pdfUrl, clearDebounce]);

    useEffect(() => {
        enabledRef.current = enabled;
        if (!enabled) {
            clearDebounce();
            activeRequestKeyRef.current = null;
            setTerms([]);
            return;
        }

        const latest = latestRef.current;
        if (latest && latest.pdfUrl === pdfUrlRef.current) {
            runPipeline(latest.page, latest.text, latest.image);
        }
    }, [enabled, clearDebounce, runPipeline]);

    useEffect(() => {
        return () => clearDebounce();
    }, [clearDebounce]);

    return { terms, onPageText, onPageChange };
}
