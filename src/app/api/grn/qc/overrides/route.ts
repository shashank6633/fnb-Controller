import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId, isManagement } from '@/lib/auth';

/**
 * THE OVERRIDE REPORT — every receipt inwarded WITHOUT a kitchen check.
 *
 *   GET /api/grn/qc/overrides?from=&to=[&format=csv]
 *
 * The owner's decision 2, second half: an override is allowed, but "the GRN is
 * PERMANENTLY marked 'inwarded without kitchen QC' and appears on a report".
 * This is that report.
 *
 * ── IT READS THE COLUMN, NOT THE AUDIT LOG ─────────────────────────────────
 * qc_outcome / qc_override_by / qc_override_at / qc_override_reason are
 * COMMITTED COLUMNS on goods_receipt_notes, written inside the same transaction
 * that moved the stock. The audit_events row is written too, best-effort — but
 * an audit trail is a log and logs get pruned, and "permanently marked" has to
 * survive that. So the mark is on the document and this report reads the
 * document.
 *
 * A VOIDED override still appears, struck through by `status`: it happened, and
 * a report of overrides that quietly dropped the ones somebody later cancelled
 * would be exactly the report nobody should trust.
 *
 * ── WHO MAY READ IT ────────────────────────────────────────────────────────
 * MANAGEMENT ONLY (admin | manager | head chef). This is a list of the times
 * the control was bypassed, by name — it is a supervision report, not an
 * operational screen, and it is the one surface in this feature where a wider
 * gate would be wrong. isManagement fails closed on a missing session.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const csvCell = (v: any): string => {
  let s = String(v ?? '');
  if (/^[=+\-@]/.test(s) && !Number.isFinite(Number(s))) s = "'" + s;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const HEADER = ['GRN No.', 'DATE', 'VENDOR', 'INVOICE', 'CHECKER OWED', 'CATEGORIES HELD',
  'RELEASED BY', 'RELEASED AT (UTC)', 'REASON', 'RECEIVED BY', 'LINES', 'VALUE INWARDED', 'STATUS'];

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!isManagement(me)) {
      return Response.json({
        error: 'The override report lists every time the kitchen check was bypassed, and by whom. Management only.',
      }, { status: 403 });
    }
    const db = getDb();
    const outletId = await getCurrentOutletId();
    const url = new URL(request.url);
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');

    const where: string[] = [`g.qc_outcome = 'override'`];
    const params: any[] = [];
    if (outletId) { where.push('(g.outlet_id = ? OR g.outlet_id IS NULL)'); params.push(outletId); }
    if (from) { where.push('g.date >= ?'); params.push(from); }
    if (to)   { where.push('g.date <= ?'); params.push(to); }

    const rows = db.prepare(`
      SELECT g.id, g.grn_number, g.date, g.vendor, g.invoice_number, g.status,
             g.qc_checker, g.qc_override_by, g.qc_override_at, g.qc_override_reason,
             g.received_by, g.po_id, po.po_number AS po_number,
             (SELECT COUNT(*) FROM goods_receipt_note_items WHERE grn_id = g.id) AS line_count,
             -- rate-basis: purchase — quantity_accepted is PURCHASE units and
             -- unit_price is Rs/purchase-unit on a GRN line (canon). This is the
             -- value that entered stock on somebody's say-so with no check.
             (SELECT COALESCE(ROUND(SUM(quantity_accepted * unit_price), 2), 0)
                FROM goods_receipt_note_items WHERE grn_id = g.id) AS inwarded_value
        FROM goods_receipt_notes g
        LEFT JOIN purchase_orders po ON po.id = g.po_id
       WHERE ${where.join(' AND ')}
       ORDER BY g.qc_override_at DESC, g.date DESC
       LIMIT 1000
    `).all(...params) as any[];

    // The categories that were held are not stored per GRN (qc_checker is), so
    // they are derived from the lines — the same join the queue uses. Cheap at
    // this row count and honest: it is what those lines ARE now, which is the
    // only thing anyone can check the release against.
    const catsOf = db.prepare(`
      SELECT DISTINCT COALESCE(NULLIF(TRIM(rm.category), ''), 'other') AS c
        FROM goods_receipt_note_items gi JOIN raw_materials rm ON rm.id = gi.material_id
       WHERE gi.grn_id = ? ORDER BY c
    `);
    const out = rows.map(r => ({
      ...r,
      categories: (catsOf.all(r.id) as any[]).map(x => String(x.c)),
    }));

    if (String(url.searchParams.get('format') || '').toLowerCase() === 'csv') {
      const lines = [HEADER.join(',')];
      for (const r of out) {
        lines.push([r.grn_number, r.date, r.vendor, r.invoice_number, r.qc_checker,
          r.categories.join(' / '), r.qc_override_by, r.qc_override_at, r.qc_override_reason,
          r.received_by, r.line_count, r.inwarded_value, r.status].map(csvCell).join(','));
      }
      const filename = `GRN-inwarded-without-kitchen-QC-${from || 'all'}_to_${to || 'all'}.csv`;
      return new Response(lines.join('\n'), {
        status: 200,
        headers: {
          'Content-Type': 'text/csv;charset=utf-8;',
          'Content-Disposition': `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    return Response.json({
      rows: out,
      count: out.length,
      total_value: Math.round(out.reduce((s, r) => s + (Number(r.inwarded_value) || 0), 0) * 100) / 100,
    });
  } catch (e: any) {
    console.error('[/api/grn/qc/overrides]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
