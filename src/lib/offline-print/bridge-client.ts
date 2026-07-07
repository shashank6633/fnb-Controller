/**
 * Browser ↔ local print bridge client.
 *
 * The bridge runs on the SAME machine as the POS browser (the counter PC),
 * listening on http://localhost:9920. Browsers treat http://localhost as a
 * "secure context", so an HTTPS-served POS page is still allowed to call it —
 * and because it's all on-box, printing works with no internet.
 *
 * This talks to the bridge directly (not through @/lib/api): it's a different
 * origin (localhost), needs no app CSRF, and the bridge sets its own CORS.
 */

const LS_KEY = 'fnb:bridge:url';
const DEFAULT_URL = 'http://localhost:9920';

export function getBridgeUrl(): string {
  if (typeof window === 'undefined') return DEFAULT_URL;
  return (localStorage.getItem(LS_KEY) || DEFAULT_URL).replace(/\/+$/, '');
}

export function setBridgeUrl(url: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(LS_KEY, url.trim().replace(/\/+$/, '') || DEFAULT_URL);
}

async function withTimeout<T>(p: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await p(ctrl.signal); }
  finally { clearTimeout(t); }
}

export type BridgeHealth = { ok: boolean; version: string; platform: string; uptimeSec: number };

/** Returns health info if the bridge is reachable, else null (never throws). */
export async function probeBridge(timeoutMs = 2500): Promise<BridgeHealth | null> {
  try {
    return await withTimeout(async (signal) => {
      const r = await fetch(`${getBridgeUrl()}/health`, { signal, cache: 'no-store' });
      if (!r.ok) return null;
      return (await r.json()) as BridgeHealth;
    }, timeoutMs);
  } catch { return null; }
}

export type PrinterStatus = { reachable: boolean; supported: boolean; paperOut: boolean; paperLow: boolean; coverOpen: boolean; error: boolean };

/** Live status of a network printer via the bridge (paper/cover/reachable). null if the bridge itself is unreachable. */
export async function bridgeStatus(target: string, timeoutMs = 3000): Promise<PrinterStatus | null> {
  try {
    return await withTimeout(async (signal) => {
      const r = await fetch(`${getBridgeUrl()}/printer-status?target=${encodeURIComponent(target)}`, { signal, cache: 'no-store' });
      if (!r.ok) return null;
      const j = await r.json();
      return { reachable: !!j.reachable, supported: !!j.supported, paperOut: !!j.paperOut, paperLow: !!j.paperLow, coverOpen: !!j.coverOpen, error: !!j.error };
    }, timeoutMs);
  } catch { return null; }
}

export type PrinterTarget = { transport: 'ip' | 'usb' | 'file'; target: string; width?: 32 | 48 };
// 'tspl'/'raw' carry a ready-made command string in `payload` that the bridge
// (v2.4.0+) sends to the printer verbatim — used for TSPL2 label jobs (TSC TE210).
export type PrintDoc = Record<string, any> & { type: 'kot' | 'bill' | 'tspl' | 'raw' };
export type PrintResult = { ok: boolean; jobId: string; bytes?: number; error?: string };

export type BatchJob = { jobId: string; printer: PrinterTarget; doc: PrintDoc };
export type BatchResult = { ok: boolean; results: Array<{ jobId: string; ok: boolean; error?: string }> };

/**
 * Send many jobs in ONE call. On a v2.0.0+ bridge the bridge groups them by
 * printer and prints each printer's tickets on a single connection (back-to-back,
 * no reconnect gap), printers in parallel.
 *
 * COMPATIBILITY: an OLD bridge (≤ v1.x) has no /print-batch and answers 404. That
 * 404 means nothing was printed, so we transparently FALL BACK to per-job /print
 * (which every bridge has) — printing keeps working without updating the counter
 * PC, just without the no-gap batching. We do NOT fall back on a network
 * error/timeout (the batch may have already printed on a new bridge → would
 * double-print); those just fail and the outbox retries.
 */
export async function bridgePrintBatch(jobs: BatchJob[], timeoutMs = 20000): Promise<BatchResult> {
  let endpointMissing = false;
  try {
    const res = await withTimeout(async (signal) => {
      const r = await fetch(`${getBridgeUrl()}/print-batch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobs }), signal,
      });
      if (r.status === 404 || r.status === 405) { endpointMissing = true; return null; } // old bridge
      const j = await r.json().catch(() => ({ ok: false, results: [] }));
      return { ok: !!j.ok, results: Array.isArray(j.results) ? j.results : [] } as BatchResult;
    }, timeoutMs);
    if (res) return res;
  } catch {
    if (!endpointMissing) return { ok: false, results: jobs.map((j) => ({ jobId: j.jobId, ok: false, error: 'bridge unreachable' })) };
  }
  // Fallback: old bridge without /print-batch → send each job via /print.
  const results: BatchResult['results'] = [];
  for (const j of jobs) {
    try {
      const r = await bridgePrint({ jobId: j.jobId, printer: j.printer, doc: j.doc });
      results.push({ jobId: j.jobId, ok: r.ok, error: r.error });
    } catch (e: any) {
      results.push({ jobId: j.jobId, ok: false, error: e?.message || 'print failed' });
    }
  }
  return { ok: results.every((r) => r.ok), results };
}

/** Send a document to a printer via the bridge. Resolves with the bridge's result. */
export async function bridgePrint(opts: { printer: PrinterTarget; doc: PrintDoc; jobId?: string }, timeoutMs = 8000): Promise<PrintResult> {
  return withTimeout(async (signal) => {
    const r = await fetch(`${getBridgeUrl()}/print`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
      signal,
    });
    const j = await r.json().catch(() => ({ ok: false, error: 'bad response' }));
    return { ok: !!j.ok, jobId: j.jobId || opts.jobId || '', bytes: j.bytes, error: j.error } as PrintResult;
  }, timeoutMs);
}
