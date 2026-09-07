import { pdfjs } from 'react-pdf';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { extractPdfPageText } from './viewer/pdfText';
import { isJargonEligible, prepareJargonText } from './viewer/jargon';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

export async function prewarmJargon(file: File, fileId: string): Promise<void> {
  let doc: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']> | null = null;
  try {
    doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    const text = await extractPdfPageText(doc, 1);
    if (!isJargonEligible(text)) return;
    await fetch('/api/explain-jargon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: prepareJargonText(text), fileId, page: 1 }),
    });
  } catch (err) {
    console.warn('[prewarm] jargon skipped', err);
  } finally {
    void doc?.destroy().catch(() => {});
  }
}
