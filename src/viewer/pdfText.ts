import type { PDFDocumentProxy } from 'pdfjs-dist';

export async function extractPdfPageText(doc: PDFDocumentProxy, pageNumber: number): Promise<string> {
  const page = await doc.getPage(pageNumber);
  const tc = await page.getTextContent();
  return tc.items.map(it => typeof (it as any).str === 'string' ? (it as any).str : '').join(' ');
}
