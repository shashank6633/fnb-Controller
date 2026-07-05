import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser, canIssueAsStore } from '@/lib/auth';

/**
 * Per-item store issue endpoint — the workhorse of /store-requisitions.
 *
 * Unlike POST /store-process (which is one-shot: issue everything + raise a PO
 * + mark fulfilled), this endpoint lets the store manager act on items
 * INCREMENTALLY: issue what's on hand now, defer what's not, come back later
 * to clear deferred items. Every action is timestamped + actor-stamped + logged
 * to audit_events for an iron-clad chain of custody.
 *
 * Body: {
 *   lines: [
 *     {
 *       id: string,                    // requisition_item id
 *       action: 'issue' | 'defer' | 'undo' | 'reject' | 'unreject',
 *       quantity?: number,             // for 'issue': how much was handed over now
 *       defer_until?: string,          // for 'defer': ISO datetime the store will issue later
 *       reason?: string,               // for 'defer'/'reject': free-text "out of cold storage" / "discontinued"
 *     }
 *   ],
 *   note?: string,                     // optional req-level note (e.g. "Bar pickup at 7pm")
 * }
 *
 * Effects per action:
 *   issue    → quantity_issued += qty (append to issue_history JSON);
 *              issued_at=now, issued_by=me; clear deferred fields.
 *              current_stock is NEVER touched (recipe-deduction owns that).
 *   defer    → deferred_until + defer_reason set. quantity_issued unchanged.
 *   undo     → clears issued/deferred fields. Use to fix mistakes.
 *              (Does NOT clear a store rejection — use 'unreject' for that.)
 *   reject   → store-rejects the line: store_rejected=1, store_reject_reason=reason,
 *              quantity_issued=0, deferred fields cleared. DISTINCT from the chef's
 *              is_rejected — this is the store saying it cannot fulfil the line.
 *   unreject → clears store_rejected + store_reject_reason (line becomes issuable again).
 *
 * Parent requisition status auto-advances to 'fulfilled' when every
 * non-rejected item has quantity_issued >= effective_qty (chef_approved_qty
 * if set, else quantity_requested). A line rejected by the chef (is_rejected)
 * OR by the store (store_rejected) counts as "done" and is not required to be
 * issued. Otherwise stays 'mgmt_approved' / 'chef_approved' / 'store_processed'
 * so it remains in the store queue.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    // STRICT: only the store person (is_store_manager) issues stock — deliberately
    // no admin bypass. Issuing is a physical handover at the store; admin issuing
    // from a desk left requisitions stuck half-processed in the issue queue.
    if (!canIssueAsStore(me)) {
      return Response.json({ error: 'Only the Store person can issue items to a department.' }, { status: 403 });
    }

    const { id } = await params;
    const db = getDb();
    const r = db.prepare('SELECT * FROM requisitions WHERE id = ?').get(id) as any;
    if (!r) return Response.json({ error: 'Not found' }, { status: 404 });
    // Allow store actions on every "post-approval, pre-final" state.
    const okStatuses = new Set(['mgmt_approved', 'chef_approved', 'store_processed']);
    if (!okStatuses.has(r.status)) {
      return Response.json({ error: `Cannot issue items — current status: ${r.status}` }, { status: 400 });
    }

    const body = await req.json().catch(() => ({}));
    const note: string = body?.note || '';
    const lines = Array.isArray(body?.lines) ? body.lines : [];
    if (lines.length === 0) return Response.json({ error: 'No lines submitted' }, { status: 400 });

    const allItems = db.prepare(`
      SELECT ri.*, rm.name AS material_name
      FROM requisition_items ri
      JOIN raw_materials rm ON rm.id = ri.material_id
      WHERE ri.req_id = ?
    `).all(id) as any[];
    const itemMap = new Map<string, any>();
    for (const it of allItems) itemMap.set(it.id, it);

    const updIssue = db.prepare(`
      UPDATE requisition_items
      SET quantity_issued = ?, issued_at = ?, issued_by = ?,
          deferred_until = NULL, defer_reason = '',
          issue_history = ?
      WHERE id = ?
    `);
    const updDefer = db.prepare(`
      UPDATE requisition_items
      SET deferred_until = ?, defer_reason = ?
      WHERE id = ?
    `);
    const updUndo = db.prepare(`
      UPDATE requisition_items
      SET quantity_issued = 0, issued_at = NULL, issued_by = NULL,
          deferred_until = NULL, defer_reason = '',
          issue_history = '[]'
      WHERE id = ?
    `);
    // Store-side rejection. Distinct from the chef's is_rejected. Reset any issue
    // progress + deferred fields so the line reads cleanly as "store-rejected".
    const updReject = db.prepare(`
      UPDATE requisition_items
      SET store_rejected = 1, store_reject_reason = ?,
          quantity_issued = 0, issued_at = NULL, issued_by = NULL,
          deferred_until = NULL, defer_reason = '',
          issue_history = '[]'
      WHERE id = ?
    `);
    const updUnreject = db.prepare(`
      UPDATE requisition_items
      SET store_rejected = 0, store_reject_reason = ''
      WHERE id = ?
    `);

    const auditPerLine: any[] = [];
    const nowIso = new Date().toISOString();

    const txn = db.transaction(() => {
      for (const ln of lines) {
        const it = itemMap.get(ln.id);
        if (!it) continue;                          // unknown line — skip silently
        if (it.is_rejected) continue;               // chef rejected — never issue
        const action = String(ln.action || '').toLowerCase();
        const before = {
          quantity_issued: it.quantity_issued || 0,
          deferred_until:  it.deferred_until,
          defer_reason:    it.defer_reason,
          store_rejected:  it.store_rejected || 0,
          store_reject_reason: it.store_reject_reason || '',
        };
        // A store-rejected line accepts only 'unreject' — clear the rejection
        // first before issuing/deferring/undoing it again.
        if (it.store_rejected && action !== 'unreject') continue;
        if (action === 'issue') {
          const addQty = Number(ln.quantity);
          if (!Number.isFinite(addQty) || addQty <= 0) continue;
          const newQty = (Number(it.quantity_issued) || 0) + addQty;
          const history = (() => {
            try { return JSON.parse(it.issue_history || '[]'); } catch { return []; }
          })();
          history.push({ qty: addQty, at: nowIso, by: me.email, note: ln.note || '' });
          updIssue.run(newQty, nowIso, me.email, JSON.stringify(history), it.id);
          auditPerLine.push({ id: it.id, material: it.material_name, action, before, after: {
            quantity_issued: newQty, issued_at: nowIso, issued_by: me.email, added: addQty,
          }});
        } else if (action === 'defer') {
          const until = String(ln.defer_until || '').trim();
          const reason = String(ln.reason || '').trim();
          if (!until) continue;
          updDefer.run(until, reason, it.id);
          auditPerLine.push({ id: it.id, material: it.material_name, action, before, after: {
            deferred_until: until, defer_reason: reason,
          }});
        } else if (action === 'undo') {
          updUndo.run(it.id);
          auditPerLine.push({ id: it.id, material: it.material_name, action, before, after: {
            quantity_issued: 0, issued_at: null, issued_by: null,
          }});
        } else if (action === 'reject') {
          const reason = String(ln.reason || '').trim();
          updReject.run(reason, it.id);
          auditPerLine.push({ id: it.id, material: it.material_name, action, before, after: {
            store_rejected: 1, store_reject_reason: reason, quantity_issued: 0,
          }});
        } else if (action === 'unreject') {
          updUnreject.run(it.id);
          auditPerLine.push({ id: it.id, material: it.material_name, action, before, after: {
            store_rejected: 0, store_reject_reason: '',
          }});
        }
      }

      // --- Auto-advance parent status if fully fulfilled.
      // Treat is_rejected items as "complete" (chef said no).
      // Treat store_rejected items as "complete" too (store said it can't fulfil).
      // Treat items with deferred_until in the future as still-open (don't fulfill).
      const fresh = db.prepare(`
        SELECT id, is_rejected, store_rejected, quantity_requested, chef_approved_qty, quantity_issued, deferred_until
        FROM requisition_items WHERE req_id = ?
      `).all(id) as any[];
      const allDone = fresh.every(it => {
        if (it.is_rejected) return true;
        if (it.store_rejected) return true;
        const eff = (it.chef_approved_qty != null ? Number(it.chef_approved_qty) : Number(it.quantity_requested)) || 0;
        const got = Number(it.quantity_issued) || 0;
        return got >= eff && !it.deferred_until;     // deferred = still pending even if qty matches
      });

      if (allDone) {
        db.prepare(`
          UPDATE requisitions
          SET status = 'fulfilled',
              fulfilled_at = COALESCE(fulfilled_at, datetime('now')),
              fulfilled_by = COALESCE(fulfilled_by, ?),
              store_processed_at = COALESCE(store_processed_at, datetime('now')),
              store_processed_by = COALESCE(store_processed_by, ?),
              store_note = CASE WHEN ? != '' THEN ? ELSE store_note END,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(me.email, me.email, note, note, id);
      } else {
        // Mark in-progress so the queue knows it's been touched
        if (r.status === 'mgmt_approved' || r.status === 'chef_approved') {
          db.prepare(`
            UPDATE requisitions
            SET status = 'store_processed',
                store_processed_at = COALESCE(store_processed_at, datetime('now')),
                store_processed_by = COALESCE(store_processed_by, ?),
                store_note = CASE WHEN ? != '' THEN ? ELSE store_note END,
                updated_at = datetime('now')
            WHERE id = ?
          `).run(me.email, note, note, id);
        } else if (note) {
          db.prepare(`UPDATE requisitions SET store_note = ?, updated_at = datetime('now') WHERE id = ?`).run(note, id);
        }
      }
    });
    txn();

    // Audit: log each per-line action so /audit timeline shows the chain of custody.
    try {
      for (const a of auditPerLine) {
        logAuditEvent(db, {
          event_type: `req_item.store_${a.action}`,
          entity_type: 'requisition_item',
          entity_id: a.id,
          actor_email: me.email,
          before: a.before,
          after: a.after,
          note: `${a.material}: ${a.action}`,
        });
      }
      logAuditEvent(db, {
        event_type: 'requisition.store_issue_batch',
        entity_type: 'requisition',
        entity_id: id,
        actor_email: me.email,
        after: { actions: auditPerLine.length, note },
        note,
      });
    } catch { /* never block on audit */ }

    // Re-read final status for response
    const after = db.prepare('SELECT status FROM requisitions WHERE id = ?').get(id) as any;
    return Response.json({ success: true, status: after?.status, applied: auditPerLine.length });
  } catch (e: any) {
    console.error('[req store-issue]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
