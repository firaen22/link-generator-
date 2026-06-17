import {
  resolveFileId,
  getProxiedPdfUrl,
  decodeCompressedPayload,
  extractFileName,
  fromUrlSafeBase64,
} from '../../utils/pdfBridge';
import type { ResolvedReportParams } from '../types';

/**
 * Pure resolver for all reader inputs. Mirrors the original Viewer.tsx
 * resolution chain byte-for-byte — the fallback ORDER is load-bearing:
 *   - clientName: c || client_name || name || '貴客', then decoded.c override
 *   - reportName: r || report_name || 'Document', then decoded.r, then (only if
 *     still 'Document') extractFileName(fileFromProp) BEFORE the f_/vblob_/r2_
 *     prefix decode
 *   - whatsappNumber: w || '85265387638', then decoded.w
 *   - fileId: route :fileId wins, else resolveFileId(fileFromProp from decoded.f)
 */
export function resolveReportParams(
  searchParams: URLSearchParams,
  fileIdParam: string | undefined,
): ResolvedReportParams {
  let clientName = searchParams.get('c') || searchParams.get('client_name') || searchParams.get('name') || '貴客';
  let reportName = searchParams.get('r') || searchParams.get('report_name') || 'Document';
  const initialFileId = fileIdParam;
  let fileFromProp = '';
  // Advisor WhatsApp number for the "預約顧問" CTA — falls back to the default below
  let whatsappNumber = searchParams.get('w') || '85265387638';

  const q = searchParams.get('q');
  const decoded = decodeCompressedPayload(q);
  if (decoded) {
    console.log('[VIEWER] Decoded payload:', decoded);
    if (decoded.c) clientName = decoded.c;
    if (decoded.r) reportName = decoded.r;
    if (decoded.f) fileFromProp = decoded.f;
    if (decoded.w) whatsappNumber = decoded.w;
  }

  // Fallback to extract clean filename from fileFromProp if reportName is generic
  if (reportName === 'Document' && fileFromProp) {
    const extracted = extractFileName(fileFromProp);
    if (extracted && extracted !== 'Document') {
      reportName = extracted;
    }
  }

  const fileId = initialFileId || resolveFileId(fileFromProp);

  // Fallback if reportName is still 'Document' but we have initialFileId / fileId
  if (reportName === 'Document' && fileId) {
    try {
      let decodedPath = '';
      if (fileId.startsWith('f_')) {
        decodedPath = fromUrlSafeBase64(fileId.slice(2));
      } else if (fileId.startsWith('vblob_')) {
        decodedPath = fromUrlSafeBase64(fileId.slice(6));
      } else if (fileId.startsWith('r2_')) {
        decodedPath = fromUrlSafeBase64(fileId.slice(3));
      }
      if (decodedPath) {
        const extracted = extractFileName(decodedPath);
        if (extracted && extracted !== 'Document') {
          reportName = extracted;
        }
      }
    } catch (e) {
      // ignore
    }
  }

  console.log('[VIEWER] Final File ID:', fileId);
  const pdfUrl = getProxiedPdfUrl(fileId);
  console.log('[VIEWER] PDF Proxy URL:', pdfUrl);

  return { clientName, reportName, fileId, pdfUrl, whatsappNumber };
}
