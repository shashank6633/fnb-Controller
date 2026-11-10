/**
 * Requisition print (owner ruling #126) — the one number the Store desk's
 * "Print all", the print sheet and /api/requisitions/print-people share.
 *
 * The ids travel in the print page's URL, and the production nginx refuses a
 * request line over its default 8 KB (414). One id costs 39 bytes there (a
 * 36-character UUID plus an encoded comma), so 120 ids is ~4.7 KB — room for
 * the path, the context line and a /login?next= round trip. A Store desk tab is
 * far below it in practice; beyond it, the desk prints the first 120 and says so.
 */
export const MAX_PRINT_IDS = 120;
