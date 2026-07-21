import type Database from 'better-sqlite3';
import { generateId, genScanCode } from '@/lib/db';

/**
 * Promote an order (a customer 'pending_approval' staging order, or one created
 * fresh for direct QR ordering) to 'open' and FIRE its items to the kitchen:
 * group remaining lines by station → one KOT each → stamp items 'fired' → assign
 * a per-outlet/day order number, OR merge into the table's existing open order
 * (one bill per table). Returns the fired KOTs so the caller can emitKds AFTER
 * commit. Runs its own transaction, so callers must NOT wrap it in another.
 *
 * Shared by the Captain approve action and the direct-ordering customer POST, so
 * both service modes fire identically.
 */
export function fireStagingOrder(
  db: Database.Database,
  orderId: string,
  opts: { firedBy: string; serverId: string; edits?: Array<{ id: string; qty: number }> },
): { targetId: string; merged: boolean; subtotal: number; firedKots: any[] } {
  const firedBy = opts.firedBy || 'QR Order';
  const serverId = opts.serverId || '';
  const firedKots: any[] = [];

  const run = db.transaction(() => {
    const staging = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any;
    if (!staging) throw new Error('Order not found');

    // Optional per-line quantity edits (captain "modify"), then fire what remains.
    const edits = Array.isArray(opts.edits) ? opts.edits : [];
    if (edits.length) {
      const upd = db.prepare('UPDATE order_items SET quantity = ?, line_total = ROUND(unit_price * ?, 2) WHERE id = ? AND order_id = ?');
      const del = db.prepare('DELETE FROM order_items WHERE id = ? AND order_id = ?');
      for (const e of edits) {
        const itemId = String(e?.id || ''); if (!itemId) continue;
        const qty = Math.max(0, Math.floor(Number(e?.qty) || 0));
        if (qty <= 0) del.run(itemId, orderId); else upd.run(qty, qty, itemId, orderId);
      }
    }

    const fireItems = db.prepare(`
      SELECT oi.*, mi.item_type AS item_type, mi.prep_minutes AS mi_prep_minutes
      FROM order_items oi LEFT JOIN menu_items mi ON oi.menu_item_id = mi.id
      WHERE oi.order_id = ? AND oi.quantity > 0
    `).all(orderId) as any[];
    if (fireItems.length === 0) throw new Error('Nothing to fire — all lines were removed');

    // One bill per table: merge into a live OPEN order if the table has one.
    const live = db.prepare(`
      SELECT * FROM orders WHERE table_id = ? AND status = 'open' AND id != ?
      ORDER BY created_at ASC LIMIT 1
    `).get(staging.table_id, orderId) as any;

    let targetId: string, targetOutlet: string | null, targetNumber: number, targetServer: string, merged: boolean;
    if (live) {
      db.prepare('UPDATE order_items SET order_id = ? WHERE order_id = ?').run(live.id, orderId);
      db.prepare(`
        UPDATE orders SET status = 'void', voided_at = datetime('now'), updated_at = datetime('now'),
          subtotal = 0, tax_total = 0, total = 0,
          notes = TRIM(COALESCE(notes,'') || ' [merged into order #' || CAST(? AS INTEGER) || ']')
        WHERE id = ?
      `).run(live.order_number, orderId);
      // ^ zero the merged shell's totals: its items now belong to the live order,
      // so a void with a non-zero total would be double-counted as a cancellation
      // in the Sales Dashboard's cancel breakup.
      // Carry the guest's name/mobile (QR details page) onto the live bill —
      // backfill ONLY when the target's fields are empty, never overwrite what
      // a captain already recorded.
      db.prepare(`
        UPDATE orders SET
          guest_name   = CASE WHEN COALESCE(guest_name,'')   = '' THEN ? ELSE guest_name   END,
          guest_mobile = CASE WHEN COALESCE(guest_mobile,'') = '' THEN ? ELSE guest_mobile END
        WHERE id = ?
      `).run(String(staging.guest_name || ''), String(staging.guest_mobile || ''), live.id);
      targetId = live.id; targetOutlet = live.outlet_id;
      targetNumber = live.order_number; targetServer = live.server_name; merged = true;
    } else {
      const seq = db.prepare(`
        SELECT COALESCE(MAX(order_number), 0) + 1 AS n FROM orders
        WHERE (outlet_id = ? OR outlet_id IS NULL) AND date(created_at) = date('now')
      `).get(staging.outlet_id) as any;
      db.prepare(`
        UPDATE orders SET status = 'open', order_number = ?, server_id = ?, server_name = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(seq.n, serverId, firedBy, orderId);
      targetId = orderId; targetOutlet = staging.outlet_id;
      targetNumber = seq.n; targetServer = firedBy; merged = false;
    }

    const tableRow = staging.table_id
      ? db.prepare('SELECT table_number, zone FROM restaurant_tables WHERE id = ?').get(staging.table_id) as any
      : null;
    const byStation: Record<string, any[]> = {};
    for (const it of fireItems) {
      const st = (it.station && String(it.station).trim()) || 'kitchen';
      (byStation[st] ||= []).push(it);
    }
    const setKot = db.prepare("UPDATE order_items SET kot_id = ?, status = 'fired', fired_at = datetime('now'), prep_minutes = ?, scan_code = ? WHERE id = ?");
    for (const [station, its] of Object.entries(byStation)) {
      const kseq = db.prepare(`
        SELECT COALESCE(MAX(kot_number), 0) + 1 AS n FROM kots
        WHERE (outlet_id = ? OR outlet_id IS NULL) AND date(created_at) = date('now')
      `).get(targetOutlet) as any;
      const kotId = generateId();
      db.prepare(`
        INSERT INTO kots (id, outlet_id, order_id, kot_number, station, status, fired_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'new', ?, datetime('now'), datetime('now'))
      `).run(kotId, targetOutlet, targetId, kseq.n, station, firedBy);
      for (const it of its) { it.scan_code = genScanCode(db); setKot.run(kotId, Number(it.mi_prep_minutes) || 15, it.scan_code, it.id); }
      firedKots.push({
        id: kotId, outlet_id: targetOutlet, order_id: targetId, kot_number: kseq.n, station, status: 'new',
        order_number: targetNumber, order_type: 'dine-in',
        table_number: tableRow?.table_number || null, zone: tableRow?.zone || null,
        captain: targetServer || null, fired_by: firedBy, reprint_count: 0,
        items: its.map((x) => ({ id: x.id, scan_code: x.scan_code, name: x.name, quantity: x.quantity, notes: x.notes, item_type: x.item_type })),
      });
    }

    const sub = (db.prepare('SELECT COALESCE(SUM(line_total),0) AS s FROM order_items WHERE order_id = ?').get(targetId) as any).s || 0;
    const subtotal = Math.round(sub * 100) / 100;
    db.prepare("UPDATE orders SET subtotal = ?, total = ?, updated_at = datetime('now') WHERE id = ?").run(subtotal, subtotal, targetId);
    return { targetId, merged, subtotal };
  });

  const out = run();
  return { ...out, firedKots };
}
