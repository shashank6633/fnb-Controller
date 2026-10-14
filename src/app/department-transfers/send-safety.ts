/**
 * SEND SAFETY for the Department Transfers screen: idempotency keys, reading a
 * POST's outcome honestly, and remembering an unconfirmed send across a reload.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ONE STEP means a send MOVES STOCK the instant the server commits it. So the
 * one thing this screen must never do is lose a reply and then tell the cook
 * "nothing was sent" — they type it in again and the books move twice (round 1's
 * verifier measured exactly that: a retried send became a second transfer).
 *
 * THE KEY. Every send carries `client_key`, minted ONCE per tray and re-sent
 * unchanged on every retry of that tray; the server answers a repeat with the
 * transfer the key already made (200, duplicate:true) and writes nothing. A new
 * key is minted only after a send is CONFIRMED. A key the server REFUSED (any
 * 4xx) wrote nothing — the idempotency gate runs first inside the send's
 * transaction, and every refusal rolls back — so the same key may be reused
 * after the cook edits the tray.
 *
 * THE OUTCOME (classifySend). Three answers, never two:
 *   sent     — 2xx carrying the transfer document. Stock has moved.
 *   refused  — a 4xx with the server's words. Provably NOTHING was written.
 *   unknown  — no reply, a timeout, a 5xx (a gateway can time out AFTER the
 *              app committed), a 408/499, or a 2xx we cannot read. It MAY have
 *              gone through. The screen locks that tray, says so, and offers
 *              only the same-key retry (which either finds the transfer or
 *              makes it — once) or an explicit discard.
 *
 * THE PENDING RECORD. Written to this device's storage BEFORE the POST leaves
 * and cleared only on a definite outcome, so a tablet that reloads or dies
 * mid-send comes back knowing a send may be in flight. Storage is a per-device
 * convenience (try/catch everywhere, private mode just means no memory) — the
 * server's key check is the guard, not this record.
 *
 * Pure functions and a type or two: no React, no fetch. The page imports them;
 * a node harness exercises them directly.
 */

/** Shape the server accepts: 8–120 of [A-Za-z0-9._:-] (dept-ledger CLIENT_KEY_RE). */
export const CLIENT_KEY_RE = /^[A-Za-z0-9._:-]{8,120}$/;

/** A fresh idempotency key. `prefix` names what it is for ('dt' send, 'rv' reverse). */
export function mintClientKey(prefix = 'dt'): string {
  let body = '';
  try {
    const c: Crypto | undefined = typeof globalThis !== 'undefined' ? (globalThis as { crypto?: Crypto }).crypto : undefined;
    if (c && typeof c.randomUUID === 'function') body = c.randomUUID();
    else if (c && typeof c.getRandomValues === 'function') {
      const a = new Uint8Array(16);
      c.getRandomValues(a);
      body = Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch { body = ''; }
  if (!body) body = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}-${body}`.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 120);
}

export type SendOutcome =
  | { kind: 'sent'; transfer: any; duplicate: boolean }
  | { kind: 'refused'; status: number; error: string; reason: string | null; materialId: string | null }
  | { kind: 'unknown'; detail: string };

/**
 * Read a send / reverse POST's reply. `status` is null when fetch itself threw
 * (offline, DNS, aborted by our timeout); `json` is the parsed body or null.
 */
export function classifySend(status: number | null, json: any): SendOutcome {
  if (status == null || !Number.isFinite(status) || status === 0) {
    return { kind: 'unknown', detail: 'no reply from the server' };
  }
  if (status >= 200 && status < 300) {
    const t = json && typeof json === 'object' ? json.transfer : null;
    if (t && typeof t === 'object' && t.id) {
      return { kind: 'sent', transfer: t, duplicate: !!json.duplicate || status === 200 };
    }
    // A 2xx we cannot read (a login page after a redirect, a truncated body):
    // something answered, but nothing proves what happened to the stock.
    return { kind: 'unknown', detail: `the server answered ${status} without the transfer` };
  }
  // 408 / 499: the request may never have reached the app — or may have, and
  // only the reply was cut. Either way nobody can say it did not happen.
  if (status === 408 || status === 499) return { kind: 'unknown', detail: `the request timed out (${status})` };
  if (status >= 500) {
    return { kind: 'unknown', detail: `the server failed while answering (${status})${json?.error ? ` — ${String(json.error)}` : ''}` };
  }
  if (status >= 400) {
    // Every 4xx on these routes is decided BEFORE anything is written (auth,
    // CSRF and body checks) or is a refusal thrown inside the send's own
    // transaction, which rolls the whole document back.
    return {
      kind: 'refused',
      status,
      error: String(json?.error || `Refused (${status})`),
      reason: json?.reason ? String(json.reason) : null,
      materialId: json?.material_id ? String(json.material_id) : null,
    };
  }
  return { kind: 'unknown', detail: `unexpected reply ${status}` };
}

/** One tray line exactly as POSTed (PURCHASE units, as typed). */
export interface SendBodyLine { material_id: string; quantity_purchase: number; unit: 'purchase' }
export interface SendBody {
  from_department_id: string;
  to_department_id: string;
  client_key: string;
  notes: string;
  lines: SendBodyLine[];
}
/** A send that left this device and whose outcome is not yet known. */
export interface PendingSend {
  v: 1;
  body: SendBody;
  /** For the banner only — the server's document is the record. */
  from_name: string;
  to_name: string;
  items: Array<{ material_id: string; name: string; qty: number; pu: string }>;
  /** When it was first sent from this device (ISO). */
  at: string;
}

const pendingKey = (userId: string) => `fnb.dept-transfers.pending-send.v1:${userId || 'anon'}`;

export function readPendingSend(userId: string): PendingSend | null {
  try {
    const raw = window.localStorage.getItem(pendingKey(userId));
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || v.v !== 1 || !v.body || !CLIENT_KEY_RE.test(String(v.body.client_key || ''))
      || !Array.isArray(v.body.lines) || v.body.lines.length === 0) return null;
    return v as PendingSend;
  } catch { return null; }
}
export function writePendingSend(userId: string, p: PendingSend): void {
  try { window.localStorage.setItem(pendingKey(userId), JSON.stringify(p)); } catch { /* private mode */ }
}
export function clearPendingSend(userId: string): void {
  try { window.localStorage.removeItem(pendingKey(userId)); } catch { /* private mode */ }
}

/** The document a key made, if it is among `docs` (each carries client_key). */
export function findByClientKey<T extends { client_key?: string }>(docs: T[], key: string): T | null {
  const k = String(key || '').trim();
  if (!k) return null;
  return docs.find((d) => String(d?.client_key || '').trim() === k) || null;
}
