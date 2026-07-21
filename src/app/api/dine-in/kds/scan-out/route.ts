import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { emitKds } from '@/lib/kds-bus';

/**
 * Kitchen Scan-Out — the kitchen supervisor scans each plated item's sticker
 * (a QR of the order_item id) as it leaves the kitchen. That flips the line to
 * `kitchen_sent` and pushes an `item.sent` SSE event so the captain tablet lights
 * it "Out of kitchen" live. This is purely additive tracking: it never inserts a
 * KOT, deducts stock, or sets `served`/`completed_at`.
 *
 * GET  → the fired-but-not-yet-sent lines (outlet-scoped) for the scan board /
 *        manual tap fallback.
 * POST { code } → advance-only flip of that order_item to kitchen_sent. Idempotent:
 *        a re-scan (already sent/served) is a no-op that reports the current state.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const outletId = await getCurrentOutletId();
    const items = db.prepare(`
      SELECT oi.id, oi.name, oi.quantity, oi.fired_at, oi.notes,
             k.kot_number, k.station,
             o.id AS order_id, o.order_number,
             rt.table_number, rt.zone
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      LEFT JOIN kots k ON k.id = oi.kot_id
      LEFT JOIN restaurant_tables rt ON rt.id = o.table_id
      WHERE oi.status = 'fired' AND oi.kitchen_sent_at IS NULL
        AND o.status = 'open'
        AND (o.outlet_id = @outlet OR o.outlet_id IS NULL)
      ORDER BY oi.fired_at ASC
      LIMIT 300
    `).all({ outlet: outletId });
    return Response.json({ items }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    console.error('[GET /api/dine-in/kds/scan-out]', e);
    return Response.json({ error: e?.message || 'Failed to load' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    // The sticker's QR encodes the order_item id; a HID scanner types it + Enter.
    // Accept `code` (scanned) or `item_id` (on-screen tap). Trim CR/whitespace.
    const code = String(body?.code ?? body?.item_id ?? '').trim();
    if (!code) return Response.json({ error: 'No code scanned' }, { status: 400 });

    const db = getDb();
    const outletId = await getCurrentOutletId();
    // The sticker encodes the short scan_code; also accept the raw order_item id
    // (older stickers / manual id entry). scan_code match is case-insensitive.
    // Outlet-scoped (mirrors the GET) so a user can't flip another outlet's item.
    const row = db.prepare(`
      SELECT oi.id, oi.name, oi.status, oi.kitchen_sent_at, oi.order_id,
             o.status AS order_status, o.outlet_id, rt.table_number, k.station
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      LEFT JOIN kots k ON k.id = oi.kot_id
      LEFT JOIN restaurant_tables rt ON rt.id = o.table_id
      WHERE (oi.id = @code OR UPPER(oi.scan_code) = UPPER(@code))
        AND (o.outlet_id = @outlet OR o.outlet_id IS NULL)
      LIMIT 1
    `).get({ code, outlet: outletId }) as any;

    if (!row) {
      return Response.json({ error: 'No item matches this code', code }, { status: 404 });
    }

    // Advance-only: only a fired, not-yet-sent line flips. Re-scans / served /
    // still-pending lines are inert no-ops (report current state, don't error).
    const res = db.prepare(
      "UPDATE order_items SET status = 'kitchen_sent', kitchen_sent_at = datetime('now') WHERE id = ? AND status = 'fired'",
    ).run(row.id);

    const fresh = db.prepare(
      'SELECT id, name, status, kitchen_sent_at FROM order_items WHERE id = ?',
    ).get(row.id) as any;

    const flipped = res.changes === 1;
    if (flipped) {
      // Push to the captain tablet(s) AND the Kitchen Display after the write.
      // Carry the KOT's real station: the KDS stream drops events whose station
      // doesn't match its ?station=/section filter, so '' never reached a
      // station-filtered Kitchen Display.
      emitKds({
        type: 'item.sent',
        outlet_id: row.outlet_id ?? null,
        station: row.station || '',
        order_id: row.order_id,
        item: { id: fresh.id, name: fresh.name, kitchen_sent_at: fresh.kitchen_sent_at },
      });
    }

    return Response.json({
      ok: true,
      flipped,
      already: !flipped,
      // Why it didn't flip (for a helpful toast): already sent, already served, or not fired yet.
      reason: flipped ? 'sent'
        : fresh?.kitchen_sent_at ? 'already_sent'
        : fresh?.status === 'served' ? 'already_served'
        : 'not_fired',
      item: {
        id: fresh.id, name: fresh.name, status: fresh.status,
        kitchen_sent_at: fresh.kitchen_sent_at, table_number: row.table_number,
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    console.error('[POST /api/dine-in/kds/scan-out]', e);
    return Response.json({ error: e?.message || 'Scan failed' }, { status: 500 });
  }
}
