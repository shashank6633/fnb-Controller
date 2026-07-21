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
import { bridgePrintBatch, type PrinterTarget, type PrintDoc } from './bridge-client';

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
  backup?: string;        // failover printer "ip:port" (PrintStation.backup_target)
  usedBackup?: boolean;   // true once we've switched to the backup printer
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

// Apply a print result to a job: mark printed, or fail over to the backup printer
// after 2 failed attempts on the primary. Returns the resulting status.
async function applyResult(job: PrintJob, ok: boolean, error?: string): Promise<'printed' | 'pending' | 'failed'> {
  if (ok) {
    // Printed jobs are only kept for dedup/housekeeping — drop the payload so a
    // raster sticker (~20-45KB of base64) doesn't sit in IndexedDB for the 6h
    // prunePrinted window and get structured-cloned by every counts()/getAll poll.
    delete job.doc.payload; delete job.doc.payload_b64;
    job.status = 'printed'; job.lastError = ''; await put(job);
    logJobResult(job, 'printed').catch(() => {});
    return 'printed';
  }
  job.attempts += 1; job.lastError = error || 'unknown';
  // Failover: after a couple of failed tries on the primary, switch to the
  // configured backup printer (e.g. another bar/kitchen printer on the floor).
  if (job.backup && !job.usedBackup && job.attempts >= 2) {
    job.usedBackup = true; job.attempts = 0;
    job.printer = { ...job.printer, target: job.backup };
    job.lastError = `primary failed, failing over to backup ${job.backup}`;
    await put(job); logJobResult(job, 'queued').catch(() => {});
    return 'pending';
  }
  if (job.attempts >= MAX_ATTEMPTS) job.status = 'failed';
  await put(job);
  logJobResult(job, job.status === 'failed' ? 'failed' : 'queued').catch(() => {});
  return job.status === 'failed' ? 'failed' : 'pending';
}

/**
 * Send every pending job to the bridge. Jobs are grouped by printer and each
 * printer's batch is sent in ONE call → the bridge prints that printer's tickets
 * on a single connection, back-to-back (no per-ticket reconnect gap, e.g. the
 * tandoor ticket lagging the first by ~2s). Different printers run in PARALLEL,
 * so a table that fires tandoor+chinese+bar prints in ~1× time, not N×.
 *
 * A big backlog is split into size/count-bounded chunks per printer (sequential,
 * order preserved): the bridge hard-kills any /print-batch body over 4MB, and
 * raster sticker docs run ~20-45KB of base64 each — one giant batch after an
 * outage would be destroyed on every retry and could never print.
 */
export async function drainOutbox(): Promise<{ printed: number; stillPending: number }> {
  if (draining) return { printed: 0, stillPending: 0 };
  draining = true;
  let printed = 0, stillPending = 0;
  try {
    const all = await allJobs();
    const pending = all.filter((j) => j.status === 'pending').sort((a, b) => a.createdAt - b.createdAt);
    if (pending.length === 0) return { printed: 0, stillPending: 0 };
    const groups = new Map<string, PrintJob[]>();
    for (const j of pending) {
      const key = `${j.printer.transport}:${j.printer.target}`;
      (groups.get(key) || groups.set(key, []).get(key)!).push(j);
    }
    const MAX_BATCH_JOBS = 25, MAX_BATCH_BYTES = 1_000_000; // well under the bridge's 4MB body cap
    const perPrinter = await Promise.allSettled([...groups.values()].map(async (jobs) => {
      let p = 0, sp = 0;
      for (let i = 0; i < jobs.length; ) {
        const chunk: PrintJob[] = [];
        let bytes = 0;
        while (i < jobs.length && chunk.length < MAX_BATCH_JOBS) {
          const size = JSON.stringify({ jobId: jobs[i].id, printer: jobs[i].printer, doc: jobs[i].doc }).length;
          if (chunk.length && bytes + size > MAX_BATCH_BYTES) break;
          bytes += size; chunk.push(jobs[i]); i++;
        }
        let batch: { ok: boolean; results: Array<{ jobId: string; ok: boolean; error?: string }> };
        try { batch = await bridgePrintBatch(chunk.map((j) => ({ jobId: j.id, printer: j.printer, doc: j.doc }))); }
        catch { batch = { ok: false, results: [] }; }
        const byId = new Map(batch.results.map((r) => [r.jobId, r]));
        for (const job of chunk) {          // tickets for this chunk went out on one connection
          const r = byId.get(job.id);
          const status = await applyResult(job, !!r?.ok, r ? r.error : 'bridge unreachable');
          if (status === 'printed') p++; else if (status === 'pending') sp++;
        }
        // Bridge itself unreachable → stop burning attempts on the rest of this
        // printer's backlog; the untouched jobs stay pending for the next tick.
        if (!batch.ok && (batch.results.length === 0 || batch.results.every((r) => !r.ok && r.error === 'bridge unreachable'))) {
          sp += jobs.length - i; break;
        }
      }
      return { p, sp };
    }));
    for (const r of perPrinter) if (r.status === 'fulfilled') { printed += r.value.p; stillPending += r.value.sp; }
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
