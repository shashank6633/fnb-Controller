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
export type PrintDoc = Record<string, any> & { type: 'kot' | 'bill' };
export type PrintResult = { ok: boolean; jobId: string; bytes?: number; error?: string };

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
