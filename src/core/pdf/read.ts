/**
 * The one function the rest of the app needs from this folder: bytes and a
 * password in, lines of text out.
 */

import { PdfDocument, PdfPasswordError, looksLikePdf, pdfIsEncrypted } from './document.ts';
import { PdfUnsupportedEncryptionError } from './security.ts';
import { extractPageItems, itemsToLines } from './text.ts';
import type { TextLine } from './text.ts';

export { PdfPasswordError, PdfUnsupportedEncryptionError, pdfIsEncrypted, looksLikePdf };
export type { TextLine, TextItem } from './text.ts';

export interface PdfText {
  /** Every line in the document, in reading order, page by page. */
  lines: TextLine[];
  pageCount: number;
  encrypted: boolean;
  /** Which password opened it: useful for saying "that was the owner password". */
  openedWith: 'user' | 'owner' | 'empty' | 'none';
}

export class PdfReadError extends Error {}

/**
 * Read a PDF's text.
 *
 * Throws `PdfPasswordError` when the file is encrypted and the password is
 * wrong or missing — the one failure the caller is expected to recover from by
 * asking the user.
 */
export function readPdfText(bytes: Uint8Array, password = ''): PdfText {
  if (!looksLikePdf(bytes)) {
    throw new PdfReadError('That file does not look like a PDF.');
  }

  const doc = new PdfDocument(bytes, password);
  const pages = doc.pages();
  const lines: TextLine[] = [];

  for (const [index, page] of pages.entries()) {
    let items;
    try {
      items = extractPageItems(doc, page);
    } catch {
      // One unreadable page should not cost the other eleven.
      continue;
    }
    // Shift to the page's own origin, so a media box that does not start at
    // zero cannot skew the column positions the statement parser reads.
    const [originX, originY] = page.mediaBox;
    for (const item of items) {
      item.x -= originX;
      item.endX -= originX;
      item.y -= originY;
    }
    lines.push(...itemsToLines(items, index + 1));
  }

  if (!lines.length) {
    throw new PdfReadError(
      pages.length
        ? 'No text could be read from this PDF. It may be a scan — an image of a statement rather than a text one.'
        : 'No pages could be read from this PDF.',
    );
  }

  return {
    lines,
    pageCount: pages.length,
    encrypted: doc.encrypted,
    openedWith: doc.openedWith,
  };
}
