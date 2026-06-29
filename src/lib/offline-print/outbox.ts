/**
 * Offline print outbox — IndexedDB queue so KOTs/bills survive a brief outage
 * of the bridge or printer.
 *
 * Every print goes in here first (keyed by a stable job id), then we try to send
 * it to the local bridge immediately. If that fails (printer off, bridge not yet
 * started, paper out), the job stays "pending" and a background loop retries it.
 * Dedup is by job id: enqueuing the same id twice is a no-op, and once a job is
 * "printed" it's never sent again — so nothing double-prints.
 *
 * No service worker is involved (the app disables those); this is plain
 * IndexedDB + a setInterval drain loop that lives for the browser session.
 */
import { bridgePrint, type PrinterTarget, type PrintDoc } from './bridge-client';

const DB_NAME = 'fnb-print';
const STORE = 'jobs';
const MAX_ATTEMPTS = 10;

export interface PrintJob {
  id: string;
  status: 'pending' | 'printed' | 'failed';
  attempts: number;
  lastError: string;
  createdAt: number;
  printer: PrinterTarget;
  doc: PrintDoc;
  meta: { stationId?: string; stationName?: string; docType: 'kot' | 'bill'; source: string; refId?: string };
}

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return idb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function getJob(id: string): Promise<PrintJob | undefined> {
  return tx('readonly', (s) => s.get(id)) as Promise<PrintJob | undefined>;
}

export async function allJobs(): Promise<PrintJob[]> {
  return (await tx('readonly', (s) => s.getAll())) as PrintJob[];
}

/** Add a job. Idempotent: a duplicate id (or one already printed) is ignored. */
export async function enqueue(job: Omit<PrintJob, 'status' | 'attempts' | 'lastError' | 'createdAt'> & Partial<PrintJob>): Promise<boolean> {
  const existing = await getJob(job.id);
  if (existing) return false; // dedup — already queued/printed
  const full: PrintJob = {
    status: 'pending', attempts: 0, lastError: '', createdAt: Date.now(),
    ...job,
  } as PrintJob;
  await tx('readwrite', (s) => s.put(full));
  return true;
}

async function put(job: PrintJob): Promise<void> { await tx('readwrite', (s) => s.put(job)); }

export async function counts(): Promise<{ pending: number; failed: number; printed: number }> {
  const all = await allJobs();
  return {
    pending: all.filter((j) => j.status === 'pending').length,
    failed: all.filter((j) => j.status === 'failed').length,
    printed: all.filter((j) => j.status === 'printed').length,
  };
}

/** Clear printed jobs older than `ms` (housekeeping). */
export async function prunePrinted(ms = 6 * 3600_000): Promise<void> {
  const all = await allJobs();
  const cutoff = Date.now() - ms;
  for (const j of all) if (j.status === 'printed' && j.createdAt < cutoff) await tx('readwrite', (s) => s.delete(j.id));
}

/** Reset a failed job back to pending so the next drain retries it. */
export async function retryFailed(): Promise<void> {
  const all = await allJobs();
  for (const j of all) if (j.status === 'failed') { j.status = 'pending'; j.attempts = 0; j.lastError = ''; await put(j); }
}

let draining = false;

/** Try to send every pending job to the bridge. Safe to call often. */
export async function drainOutbox(): Promise<{ printed: number; stillPending: number }> {
  if (draining) return { printed: 0, stillPending: 0 };
  draining = true;
  let printed = 0, stillPending = 0;
  try {
    const all = await allJobs();
    const pending = all.filter((j) => j.status === 'pending').sort((a, b) => a.createdAt - b.createdAt);
    for (const job of pending) {
      let res: { ok: boolean; error?: string };
      try { res = await bridgePrint({ jobId: job.id, printer: job.printer, doc: job.doc }); }
      catch (e: any) { res = { ok: false, error: e?.message || 'print failed' }; }

      if (res.ok) {
        job.status = 'printed'; job.lastError = ''; await put(job); printed++;
        logJobResult(job, 'printed').catch(() => {});
      } else {
        job.attempts += 1; job.lastError = res.error || 'unknown';
        if (job.attempts >= MAX_ATTEMPTS) job.status = 'failed';
        await put(job);
        if (job.status !== 'failed') stillPending++;
        logJobResult(job, job.status === 'failed' ? 'failed' : 'queued').catch(() => {});
      }
    }
  } finally { draining = false; }
  return { printed, stillPending };
}

/** Best-effort server journal (works only when the cloud is reachable). */
async function logJobResult(job: PrintJob, status: 'printed' | 'failed' | 'queued') {
  try {
    const { api } = await import('@/lib/api');
    await api('/api/dine-in/offline-print/jobs', {
      method: 'POST',
      body: {
        id: job.id, station_id: job.meta.stationId || null, doc_type: job.meta.docType,
        source: job.meta.source, ref_id: job.meta.refId || null, status,
        attempts: job.attempts, last_error: job.lastError,
      },
    });
  } catch { /* offline — that's fine, the outbox is the source of truth */ }
}

// ── background drain loop (one per browser session) ──────────────────────────
let loopStarted = false;
export function ensureDrainLoop(intervalMs = 15000): void {
  if (loopStarted || typeof window === 'undefined') return;
  loopStarted = true;
  const tick = () => { drainOutbox().catch(() => {}); };
  window.addEventListener('online', tick);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  setInterval(tick, intervalMs);
  tick();
}
