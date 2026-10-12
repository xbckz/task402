export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const MAX_DOCUMENT_PAGES = 100;
export const MAX_DOCUMENT_TEXT_BYTES = 5 * 1024 * 1024;
export const MAX_DOCUMENT_PAGE_TEXT_CHARS = 256 * 1024;
export const MAX_DOCUMENT_INDEX_BYTES = 8 * 1024 * 1024;
export const MAX_DOCUMENT_BLOCKS = 50_000;

export class DocumentError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
