/**
 * Kitchen scan queue — IndexedDB so barcode/QR scans survive a network outage.
 *
 * The camera scanner enqueues every scan here first (keyed by a stable id), then
 * tries to flush it to /api/kitchen-production/scan immediately. If that POST
 * fails (offline, server down) the scan stays "queued" and a later flush — kicked
 * by the browser 'online' event or an interval — retries it. On a successful
 * flush the looked-up batch is written to a small scan-history store so the UI
 * can show "last N scans" even after a reload.
 *
 * This mirrors src/lib/offline-print/outbox.ts: plain IndexedDB (no service
 * worker) + a session-scoped drain loop. Two object stores in one DB:
 *   - 'queue'   pending scans not yet acknowledged by the server
 *   - 'history' recent scans + their resolved batch (capped, newest-first)
 */
import { api } from '@/lib/api';

const DB_NAME = 'fnb-kitchen-scan';
const DB_VERSION = 1;
const QUEUE_STORE = 'queue';
const HISTORY_STORE = 'history';
const HISTORY_CAP = 100;

export interface QueuedScan {
  id: string;          // stable dedup id
  barcode: string;
  ts: number;          // client scan epoch-ms
  attempts: number;
  lastError: string;
  createdAt: number;
}

export interface ScanHistoryEntry {
  id: string;          // same id as the queued scan
  barcode: string;
  ts: number;          // when it was scanned (client)
  syncedAt: number;    // when the server ack'd it
  found: boolean;      // whether a batch matched the barcode
  batch: any | null;   // enriched batch from the scan endpoint (or null = unknown)
}

// ── low-level IndexedDB plumbing (mirrors offline-print/outbox.ts) ───────────
function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(QUEUE_STORE)) db.createObjectStore(QUEUE_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(HISTORY_STORE)) db.createObjectStore(HISTORY_STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return idb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
      }),
  );
}

function genId(): string {
  try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch {}
  return `scan_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// ── queue API ────────────────────────────────────────────────────────────────

/** Queue a scan for flushing. Returns the queued row (with its generated id). */
export async function enqueueScan(input: { barcode: string; ts?: number; id?: string }): Promise<QueuedScan> {
  const barcode = (input.barcode || '').trim();
  const row: QueuedScan = {
    id: input.id || genId(),
    barcode,
    ts: input.ts && input.ts > 0 ? input.ts : Date.now(),
    attempts: 0,
    lastError: '',
    createdAt: Date.now(),
  };
  await tx(QUEUE_STORE, 'readwrite', (s) => s.put(row));
  return row;
}

/** All still-queued scans, oldest-first. */
export async function listQueued(): Promise<QueuedScan[]> {
  const all = (await tx(QUEUE_STORE, 'readonly', (s) => s.getAll())) as QueuedScan[];
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

/** Count of pending scans (for a badge). */
export async function queuedCount(): Promise<number> {
  return (await tx(QUEUE_STORE, 'readonly', (s) => s.count())) as number;
}

async function removeQueued(id: string): Promise<void> {
  await tx(QUEUE_STORE, 'readwrite', (s) => s.delete(id));
}

async function putQueued(row: QueuedScan): Promise<void> {
  await tx(QUEUE_STORE, 'readwrite', (s) => s.put(row));
}

// ── history API ──────────────────────────────────────────────────────────────

async function recordHistory(entry: ScanHistoryEntry): Promise<void> {
  await tx(HISTORY_STORE, 'readwrite', (s) => s.put(entry));
  // Cap the store: drop oldest beyond HISTORY_CAP.
  const all = (await tx(HISTORY_STORE, 'readonly', (s) => s.getAll())) as ScanHistoryEntry[];
  if (all.length > HISTORY_CAP) {
    all.sort((a, b) => b.syncedAt - a.syncedAt);
    for (const old of all.slice(HISTORY_CAP)) await tx(HISTORY_STORE, 'readwrite', (s) => s.delete(old.id));
  }
}

/** Recent scans + resolved batch, newest-first (default 20). */
export async function listHistory(limit = 20): Promise<ScanHistoryEntry[]> {
  const all = (await tx(HISTORY_STORE, 'readonly', (s) => s.getAll())) as ScanHistoryEntry[];
  all.sort((a, b) => b.syncedAt - a.syncedAt);
  return all.slice(0, Math.max(0, limit));
}

/** Wipe scan history (keeps the pending queue). */
export async function clearHistory(): Promise<void> {
  await tx(HISTORY_STORE, 'readwrite', (s) => s.clear());
}

// ── flush ────────────────────────────────────────────────────────────────────
let flushing = false;

/**
 * POST every queued scan to /api/kitchen-production/scan. On a 2xx the scan is
 * removed from the queue and appended to history (with its looked-up batch, or
 * null for an unknown barcode). On failure the scan is kept and its attempt
 * count bumped so the next flush retries it.
 */
export async function flushQueue(): Promise<{ flushed: number; stillQueued: number }> {
  if (flushing || typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { flushed: 0, stillQueued: await queuedCount().catch(() => 0) };
  }
  flushing = true;
  let flushed = 0;
  try {
    const pending = await listQueued();
    for (const scan of pending) {
      try {
        const res = await api('/api/kitchen-production/scan', {
          method: 'POST',
          body: { barcode: scan.barcode, ts: scan.ts },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json().catch(() => ({}));
        const batch = data?.batch ?? null;
        await recordHistory({
          id: scan.id,
          barcode: scan.barcode,
          ts: scan.ts,
          syncedAt: Date.now(),
          found: !!batch,
          batch,
        });
        await removeQueued(scan.id);
        flushed += 1;
      } catch (e: any) {
        scan.attempts += 1;
        scan.lastError = e?.message || 'flush failed';
        await putQueued(scan);
        // Stop the run on the first hard failure — likely offline; retry later.
        break;
      }
    }
  } finally {
    flushing = false;
  }
  return { flushed, stillQueued: await queuedCount().catch(() => 0) };
}

/**
 * Enqueue a scan and immediately try to flush. Returns the flush result so the
 * caller can optimistically read back the just-synced history entry. If the
 * flush fails (offline) the scan simply waits in the queue.
 */
export async function scanAndFlush(input: { barcode: string; ts?: number }): Promise<{ queued: QueuedScan; flushed: number; stillQueued: number }> {
  const queued = await enqueueScan(input);
  const { flushed, stillQueued } = await flushQueue();
  return { queued, flushed, stillQueued };
}

// ── background drain loop (one per browser session) ──────────────────────────
let loopStarted = false;

/** Wire flushing to the 'online' event + a poll interval. Call once from the scanner page. */
export function ensureScanFlushLoop(intervalMs = 15000): void {
  if (loopStarted || typeof window === 'undefined') return;
  loopStarted = true;
  const tick = () => { flushQueue().catch(() => {}); };
  window.addEventListener('online', tick);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  setInterval(tick, intervalMs);
  tick();
}
