import { getDb, logAuditEvent } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { lineUnitNeedsReview } from '@/lib/issue-stock';
import { STALE_UNIT_SHORT, staleUnitFacts, staleUnitNames } from '@/lib/stale-line-unit';

/**
 * Submit a draft requisition → moves to 'submitted'.
 * The head chef will see it in their inbox.
 * Either the drafter or admin can submit.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id } = await params;
    const db = getDb();
    const r = db.prepare('SELECT * FROM requisitions WHERE id = ?').get(id) as any;
    if (!r) return Response.json({ error: 'Not found' }, { status: 404 });
    if (r.status !== 'draft') {
      return Response.json({ error: `Only drafts can be submitted (current: ${r.status})` }, { status: 400 });
    }
    if (r.drafted_by !== me.email && me.role !== 'admin') {
      return Response.json({ error: 'Only the drafter or admin can submit' }, { status: 403 });
    }
    const items = db.prepare('SELECT COUNT(*) AS n FROM requisition_items WHERE req_id = ?').get(id) as any;
    if (!items || items.n === 0) return Response.json({ error: 'Cannot submit an empty requisition' }, { status: 400 });

    // STALE LINE UNIT (owner ruling 128, "new or edited requisitions always take
    // the item's CURRENT unit"). A draft started before an item's units changed
    // keeps the old unit on its line (YELLOW CHEDDAR in 'PKT' after the item
    // became g / kg / ×1000), and the detail row's Submit sends it on without
    // going through the edit form. Such a line can never be issued: the stock
    // writer cannot read its unit (issue-stock.ts lineUnitNeedsReview IS
    // lineFactor().needsReview, the call that makes the issue record 0 and
    // move nothing). So it is refused here, with the facts, and nothing is
    // written — the draft stays a draft. No unit is converted or re-stamped:
    // the person removes the line and adds it again. A draft whose every line
    // reads is untouched.
    {
      const lines = db.prepare(`
        SELECT ri.unit AS line_unit, rm.name, rm.unit, rm.purchase_unit, rm.pack_size
        FROM requisition_items ri
        JOIN raw_materials rm ON rm.id = ri.material_id
        WHERE ri.req_id = ?
      `).all(id) as Array<{ line_unit: string | null; name: string | null; unit: string | null; purchase_unit: string | null; pack_size: number | null }>;
      const stale = lines.filter(x => lineUnitNeedsReview(x.line_unit, x));
      if (stale.length > 0) {
        return Response.json({
          error: stale.map(x => {
            const buy = staleUnitNames(x.line_unit, x).buy;
            return `${String(x.name || 'A line')}: ${STALE_UNIT_SHORT}. ${staleUnitFacts(x.line_unit, x)} `
              + `Edit the draft, remove that line and add it again${buy ? ` in ${buy}` : ''}.`;
          }).join(' ') + ' Nothing was submitted.',
          code: 'unit_review',
          lines: stale.map(x => ({
            material: String(x.name || ''), line_unit: String(x.line_unit ?? ''),
            unit: String(x.unit ?? ''), purchase_unit: String(x.purchase_unit ?? ''),
          })),
        }, { status: 400 });
      }
    }

    // Phase 1 §2 — submission time windows. Each department may declare allowed
    // submission slots ("11:00,18:30") with a grace window. Admins can override
    // with `force_outside_window: true` in the body.
    const body = await req.json().catch(() => ({}));
    const force = body?.force_outside_window === true && me.role === 'admin';
    if (!force) {
      const dept = db.prepare('SELECT submission_windows, submission_grace_minutes, name FROM departments WHERE id = ?').get(r.department_id) as any;
      const windows = String(dept?.submission_windows || '').split(',').map((s: string) => s.trim()).filter(Boolean);
      if (windows.length > 0) {
        const now = new Date();
        const nowMin = now.getHours() * 60 + now.getMinutes();
        const grace = Number(dept?.submission_grace_minutes) || 30;
        const allowed = windows.some((w: string) => {
          const m = w.match(/^(\d{1,2}):(\d{2})$/); if (!m) return false;
          const slotMin = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
          return Math.abs(nowMin - slotMin) <= grace;
        });
        if (!allowed) {
          return Response.json({
            error: `Submission window closed. ${dept.name} accepts requisitions at: ${windows.join(', ')} (±${grace} min). Admin override available.`,
            outside_window: true,
            allowed_windows: windows,
            grace_minutes: grace,
          }, { status: 400 });
        }
      }
    }

    db.prepare(`
      UPDATE requisitions
      SET status = 'submitted', submitted_at = datetime('now'), submitted_by = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(me.email, id);
    // Audit: seed the requisition's timeline at submission so chef edits/approvals chain off a known origin.
    try {
      logAuditEvent(db, {
        event_type: 'requisition.submit',
        entity_type: 'requisition',
        entity_id: id,
        actor_email: me.email,
        before: { status: 'draft' },
        after: { status: 'submitted', items: items.n, force_outside_window: force || false },
      });
    } catch { /* audit must never break the action */ }
    return Response.json({ success: true, status: 'submitted' });
  } catch (e: any) {
    console.error('[req submit]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
