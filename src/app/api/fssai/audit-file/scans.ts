/* eslint-disable @typescript-eslint/no-explicit-any */
import type Database from 'better-sqlite3';

/**
 * The registers whose attached files belong in the audit file. A scan is served
 * or printed only from these — never, say, a hygiene-round photograph of a
 * person, which the audit file does not list and has no reason to hand out.
 */
export const AUDIT_FILE_SCAN_TABLES: readonly string[] = [
  'fssai_documents',
  'fssai_water_tests',
  'fssai_pest_services',
  'fssai_equipment_events',
  'fssai_inspections',
];

const DATA_URI = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i;

/** A stored data URI → its bytes and declared type. null when it is not one. */
export function decodeImageDataUri(uri: string): { mime: string; bytes: Buffer } | null {
  const m = String(uri || '').match(DATA_URI);
  if (!m) return null;
  try {
    const bytes = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
    return bytes.length ? { mime: m[1].toLowerCase(), bytes } : null;
  } catch {
    return null;
  }
}

/**
 * What a PDF can draw. pdfkit embeds JPEG and PNG only; the format is read from
 * the file's own first bytes, because a label can be wrong and a mislabelled
 * image makes pdfkit throw half-way through a document.
 */
export function pdfImageKind(bytes: Buffer): 'jpeg' | 'png' | '' {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  return '';
}

/** The stored images for these attachments, by id. Missing / dropped ones are absent. */
export function loadScanImages(db: Database.Database, ids: string[]): Map<string, { mime: string; bytes: Buffer }> {
  const out = new Map<string, { mime: string; bytes: Buffer }>();
  const uniq = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 200) {
    const chunk = uniq.slice(i, i + 200);
    const rows = db.prepare(
      `SELECT id, entity_table, data_uri FROM fssai_attachments
        WHERE data_uri <> '' AND id IN (${chunk.map(() => '?').join(',')})`,
    ).all(...chunk) as any[];
    for (const r of rows) {
      if (!AUDIT_FILE_SCAN_TABLES.includes(String(r.entity_table))) continue;
      const img = decodeImageDataUri(String(r.data_uri || ''));
      if (img) out.set(String(r.id), img);
    }
  }
  return out;
}
