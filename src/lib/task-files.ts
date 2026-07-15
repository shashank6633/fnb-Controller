// Blob file store for Task-module attachments (video / voice / large files).
//
// Images keep using the existing inline-base64 path (ImageUpload component) so
// this store only carries the heavier binary kinds. BLOBs live in the
// `task_files` table (see db.ts). better-sqlite3 round-trips a Node Buffer to a
// SQLite BLOB natively.
import type Database from 'better-sqlite3';
import { generateId } from './db';

export interface StoredFile {
  id: string;
  mime: string;
  filename: string;
  data: Buffer;
  size: number;
  created_by: string;
  created_at: string;
}

/**
 * Persist a binary attachment and return its generated id.
 * `buffer` is the raw bytes; `size` is stored from the buffer length so the
 * caller never has to compute it. Never throws for the happy path — a bad
 * insert surfaces as a normal better-sqlite3 error to the caller.
 */
export function storeFile(
  db: Database.Database,
  file: { mime: string; filename: string; buffer: Buffer; by?: string }
): string {
  const id = generateId();
  const size = file.buffer.length;
  db.prepare(
    `INSERT INTO task_files (id, mime, filename, data, size, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, file.mime || '', file.filename || '', file.buffer, size, file.by || '');
  return id;
}

/**
 * Read a stored file back by id. Returns null if the id is unknown.
 * `data` comes back as a Node Buffer ready to stream to the HTTP response.
 */
export function readFile(db: Database.Database, id: string): StoredFile | null {
  const row = db
    .prepare(
      `SELECT id, mime, filename, data, size, created_by, created_at
       FROM task_files WHERE id = ?`
    )
    .get(id) as StoredFile | undefined;
  if (!row) return null;
  // better-sqlite3 returns BLOBs as Buffer already; normalize just in case.
  if (row.data && !Buffer.isBuffer(row.data)) {
    row.data = Buffer.from(row.data as unknown as ArrayBuffer);
  }
  return row;
}
