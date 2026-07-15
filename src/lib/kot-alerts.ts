import type Database from 'better-sqlite3';

/**
 * KOT trouble alerts — "a kitchen ticket has an issue; a human needs to act".
 *
 * A directly-fired customer/QR order (QR Ordering Mode = Direct) reaches the
 * kitchen with NO captain in the loop, so if its KOT never prints — printer
 * offline, no print agent running, bridge unreachable, or the fire itself failed
 * — nobody would notice. These helpers raise a row in `kot_alerts` for exactly
 * those cases, which then surfaces to:
 *   • the RESPECTIVE CAPTAIN — CaptainShell poll + the /captain/requests board
 *     (scoped by `server_id`, the table's owning captain; unclaimed → all captains)
 *   • the FLOOR MANAGER / kitchen — the /dine-in/kitchen KDS red banner
 *
 * All three failure paths funnel through raiseKotAlert() so the alert shape and
 * de-duplication are identical. See callers:
 *   • fire failure  → src/app/api/customer/orders/route.ts (direct branch)
 *   • print failure → src/app/api/dine-in/offline-print/jobs/route.ts (status 'failed')
 *   • not-printed   → sweepDirectKotDeliveries(), run on every kot-alerts GET
 */

export type KotAlertKind = 'manual' | 'fire_failed' | 'print_failed' | 'unprinted';

/** How long a directly-fired KOT may sit unconfirmed before we flag it. */
export const KOT_PRINT_GRACE_SECONDS = 45;

export interface RaiseKotAlertInput {
  orderId?: string | null;
  kotId?: string | null;
  outletId?: string | null;
  kotNumber?: number;
  station?: string;
  tableNumber?: string;
  serverId?: string;        // the table's owning captain; '' = unclaimed (→ all captains)
  reason: string;
  kind?: KotAlertKind;
  createdBy?: string;
}

/**
 * Insert a KOT alert, resolving any missing table/outlet/owning-captain context
 * from the order. De-duplicated: if an OPEN alert of the same kind already
 * exists for this KOT (or, when there is no KOT id, this order), nothing is
 * inserted — so the sweep + print retries can't spam duplicates. Returns true
 * only when a NEW alert row was created (lets callers fire a live notification).
 */
export function raiseKotAlert(db: Database.Database, input: RaiseKotAlertInput): boolean {
  const kind: KotAlertKind = input.kind || 'manual';
  const kotId = input.kotId || null;
  const orderId = input.orderId || null;

  let outletId = input.outletId ?? null;
  let tableNumber = input.tableNumber ?? '';
  let serverId = input.serverId ?? '';
  if (orderId && (!outletId || !tableNumber || !serverId)) {
    const o = db.prepare(`
      SELECT o.outlet_id, o.server_id, rt.table_number
      FROM orders o LEFT JOIN restaurant_tables rt ON rt.id = o.table_id
      WHERE o.id = ?
    `).get(orderId) as any;
    if (o) {
      outletId = outletId || o.outlet_id || null;
      tableNumber = tableNumber || o.table_number || '';
      serverId = serverId || o.server_id || '';
    }
  }

  // Already flagged and still open? Don't duplicate. A KOT-scoped issue dedups on
  // the KOT; a KOT-less issue (e.g. a self-order that never became a KOT) dedups
  // on the TABLE — otherwise each retry mints a fresh order id and the dedup could
  // never match, letting a replayed token pile up alerts for one broken table.
  const dupe = kotId
    ? db.prepare("SELECT 1 FROM kot_alerts WHERE kot_id = ? AND kind = ? AND resolved_at IS NULL LIMIT 1").get(kotId, kind)
    : tableNumber
      ? db.prepare("SELECT 1 FROM kot_alerts WHERE kind = ? AND table_number = ? AND outlet_id IS ? AND resolved_at IS NULL LIMIT 1").get(kind, tableNumber, outletId)
      : orderId
        ? db.prepare("SELECT 1 FROM kot_alerts WHERE order_id = ? AND kind = ? AND resolved_at IS NULL LIMIT 1").get(orderId, kind)
        : null;
  if (dupe) return false;

  db.prepare(`
    INSERT INTO kot_alerts
      (id, kot_id, order_id, outlet_id, kot_number, station, table_number, reason, kind, server_id, created_by, created_at)
    VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    kotId, orderId, outletId, input.kotNumber ?? 0, input.station || '',
    tableNumber, (input.reason || '').slice(0, 240), kind, serverId, input.createdBy || 'system',
  );
  return true;
}

/**
 * Flag directly-fired KOTs (fired_by = 'QR Order') that are still 'new', older
 * than the grace window, and have NO successful print confirmation — i.e. the
 * self-order reached the DB but likely never printed. Skips KOTs the kitchen has
 * already picked up (status advanced past 'new') and any already-alerted KOT.
 * Idempotent + cheap; run at the top of the kot-alerts GET. Returns #new alerts.
 */
export function sweepDirectKotDeliveries(db: Database.Database, outletId: string | null): number {
  let stale: any[] = [];
  try {
    stale = db.prepare(`
      SELECT k.id AS kot_id, k.order_id, k.outlet_id, k.kot_number, k.station,
             o.server_id, rt.table_number
      FROM kots k
      JOIN orders o ON o.id = k.order_id
      LEFT JOIN restaurant_tables rt ON rt.id = o.table_id
      WHERE k.fired_by = 'QR Order'
        AND k.status = 'new'
        AND (k.outlet_id = ? OR k.outlet_id IS NULL)
        AND k.created_at <= datetime('now', ?)
        AND k.created_at >= datetime('now', '-6 hours')
        AND NOT EXISTS (SELECT 1 FROM print_jobs j WHERE j.ref_id = k.id AND j.status = 'printed')
        AND NOT EXISTS (SELECT 1 FROM kot_alerts a WHERE a.kot_id = k.id)
    `).all(outletId, '-' + KOT_PRINT_GRACE_SECONDS + ' seconds') as any[];
  } catch {
    return 0; // never let the sweep break the alerts list
  }

  // Is ANY kitchen (KOT-role, non-master) printer actually configured? If not,
  // every KOT is silently dropped at print time (resolveKotPrinter → null) — so
  // say exactly that instead of "check the X printer" (there is no X printer).
  let hasKotPrinter = true;
  try {
    hasKotPrinter = !!db.prepare(
      `SELECT 1 FROM print_stations
       WHERE role = 'kot' AND is_active = 1 AND COALESCE(is_master, 0) = 0
         AND (outlet_id = ? OR outlet_id IS NULL) LIMIT 1`
    ).get(outletId); // outlet-scoped, like the stale-KOT query above — one outlet's
  } catch { hasKotPrinter = true; } // printer must not mask another's missing one

  let n = 0;
  for (const k of stale) {
    const ok = raiseKotAlert(db, {
      kotId: k.kot_id, orderId: k.order_id, outletId: k.outlet_id,
      kotNumber: k.kot_number, station: k.station, tableNumber: k.table_number, serverId: k.server_id,
      reason: hasKotPrinter
        ? `Self-order KOT #${k.kot_number} not confirmed at the printer — please check ${k.station || 'the kitchen'} printer.`
        : `Self-order KOT #${k.kot_number} could not print — no kitchen (KOT) printer is set up. Add one under Printers.`,
      kind: 'unprinted', createdBy: 'system',
    });
    if (ok) n++;
  }
  return n;
}

/**
 * Auto-close alerts that have since sorted themselves out, so the Kitchen board
 * doesn't accumulate stale "action needed" rows a human must dismiss by hand.
 * An 'unprinted'/'print_failed' alert clears once EITHER the KOT actually printed
 * (a print_jobs row for it reached 'printed') OR the kitchen picked it up (its
 * status advanced past 'new' — they clearly saw it on the KDS). Human-raised
 * ('manual') and hard fire failures ('fire_failed') are left for a human to
 * close. Scoped to the outlet; idempotent; never throws. Returns #rows resolved.
 */
export function autoResolveKotAlerts(db: Database.Database, outletId: string | null): number {
  try {
    const r = db.prepare(`
      UPDATE kot_alerts
      SET resolved_at = datetime('now')
      WHERE resolved_at IS NULL
        AND kind IN ('unprinted', 'print_failed')
        AND kot_id IS NOT NULL
        AND (outlet_id = ? OR outlet_id IS NULL)
        AND (
          -- THIS KOT's own station ticket printed. Exclude the master/expediter
          -- consolidated copy: it is journaled under ref_id = fireKey (a real KOT
          -- id, the batch's smallest) with id 'master_…', so without this filter a
          -- printed expediter copy would clear that one KOT's alert even if its own
          -- station never printed. Per-station jobs are id 'kot_…'.
          EXISTS (SELECT 1 FROM print_jobs j
                    WHERE j.ref_id = kot_alerts.kot_id AND j.status = 'printed'
                      AND j.id NOT LIKE 'master_%')
          -- …or the kitchen has clearly picked it up (advanced past 'new').
          OR EXISTS (SELECT 1 FROM kots k WHERE k.id = kot_alerts.kot_id AND k.status <> 'new')
        )
    `).run(outletId);
    return r.changes || 0;
  } catch {
    return 0; // never let auto-resolve break the alerts list
  }
}
