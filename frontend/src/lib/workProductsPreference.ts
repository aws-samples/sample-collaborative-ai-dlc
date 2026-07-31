export type DocumentOrder = 'oldest-first' | 'newest-first';

const STORAGE_KEY = 'aidlc.workProducts.documentOrder.v1';

export function getDocumentOrder(): DocumentOrder {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'newest-first' ? 'newest-first' : 'oldest-first';
  } catch {
    return 'oldest-first';
  }
}

export function setDocumentOrder(order: DocumentOrder): void {
  try {
    localStorage.setItem(STORAGE_KEY, order);
  } catch {
    /* best-effort persistence */
  }
}
