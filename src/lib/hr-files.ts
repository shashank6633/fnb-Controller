// BLOB file store for the HRMS document vault (hr_documents).
//
// Modelled 1:1 on src/lib/task-files.ts, but writes to its OWN table: the
// task_files read gate is "any signed-in user", while hr_documents sits behind
// the HR-role + per-employee gate in /api/hr/documents (contract D4 in
// docs/HRMS_DECISIONS.md). Bytes live as BLOBs in SQLite per contract D4;
// scripts/backup-db.sh already switched to VACUUM INTO for exactly this table
// (the old `.dump | gzip` path hex-doubles BLOBs).
//
// Size gate: Next 16 with a proxy silently truncates request bodies over 10 MB
// and nginx allows 25 MB, so neither will save us — WE are the gate. The
// 5 MB hard cap below must be enforced client-side, in the route's
// Content-Length pre-check, AND here as the last line of defense.
import type Database from 'better-sqlite3';
import { generateId } from './db';

/** Hard upper bound for a stored HR document, in bytes (5 MB). */
export const HR_DOC_MAX_BYTES = 5_000_000;

export interface StoredHrDocument {
  id: string;
  employee_id: string;
  doc_type: string;
  doc_number: string;
  issue_date: string;
  expiry_date: string;
  filename: string;
  mime: string;
  size_bytes: number;
  data: Buffer;
  verify_status: string;
  verified_by: string;
  uploaded_by: string;
  created_at: string;
}

/**
 * Persist an HR document (metadata + raw bytes) and return its generated id.
 * `size_bytes` is stored from the buffer length so the caller never has to
 * compute it. employee_id must be an hr_employees.id and uploadedBy the acting
 * user's email (actor column) — the route validates the employee exists before
 * calling. Throws if the buffer exceeds HR_DOC_MAX_BYTES (defense-in-depth;
 * the route should have already rejected with a 400).
 */
export function storeHrDocument(
  db: Database.Database,
  doc: {
    employee_id: string;
    doc_type?: string;
    doc_number?: string;
    issue_date?: string;
    expiry_date?: string;
    filename?: string;
    mime?: string;
    buffer: Buffer;
    uploadedBy?: string;
  }
): string {
  if (doc.buffer.length > HR_DOC_MAX_BYTES) {
    throw new Error('hr-document exceeds the 5 MB limit');
  }
  const id = generateId();
  const size = doc.buffer.length;
  db.prepare(
    `INSERT INTO hr_documents
       (id, employee_id, doc_type, doc_number, issue_date, expiry_date,
        filename, mime, size_bytes, data, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    doc.employee_id,
    doc.doc_type || '',
    doc.doc_number || '',
    doc.issue_date || '',
    doc.expiry_date || '',
    doc.filename || '',
    doc.mime || '',
    size,
    doc.buffer,
    doc.uploadedBy || ''
  );
  return id;
}

/**
 * Read a stored HR document back by id. Returns null if the id is unknown.
 * `data` comes back as a Node Buffer ready to stream to the HTTP response —
 * remember the route must send it with Cache-Control: private, no-store.
 */
export function readHrDocument(
  db: Database.Database,
  id: string
): StoredHrDocument | null {
  const row = db
    .prepare(
      `SELECT id, employee_id, doc_type, doc_number, issue_date, expiry_date,
              filename, mime, size_bytes, data, verify_status, verified_by,
              uploaded_by, created_at
       FROM hr_documents WHERE id = ?`
    )
    .get(id) as StoredHrDocument | undefined;
  if (!row) return null;
  // better-sqlite3 returns BLOBs as Buffer already; normalize just in case.
  if (row.data && !Buffer.isBuffer(row.data)) {
    row.data = Buffer.from(row.data as unknown as ArrayBuffer);
  }
  return row;
}
