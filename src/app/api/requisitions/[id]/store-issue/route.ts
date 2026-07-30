import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser, canIssueAsStore } from '@/lib/auth';
import { applyPartyFulfillment } from '@/lib/party-fulfillment';
import { applyIssueDelta } from '@/lib/issue-stock';

/**
 * A replayed POST carrying a client_token it already spent collides on
 * requisition_issue_ledger's partial unique index (db.ts:1271). better-sqlite3
 * rolls the WHOLE transaction back, so nothing was applied twice — the honest
 * answer is 200 "you already did this", not a 500.
 *
 * SQLite words the failure with the COLUMNS, not the index name
 * ("UNIQUE constraint failed: requisition_issue_ledger.client_token,
 * requisition_issue_ledger.req_item_id"), so match on that and keep the index
 * name as a fallback. Deliberately narrow: any other constraint failure is a
 * real bug and must keep surfacing as a 500.
 */
function isIssueTokenReplay(e: any): boolean {
  const code = String(e?.code || '');
  const msg = String(e?.message || '');
  if (!code.startsWith('SQLITE_CONSTRAINT')) return false;
  return msg.includes('uq_req_issue_token_item')
    || msg.includes('requisition_issue_ledger.client_token');
}

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
 *              issued_at=now, issued_by=me; clears the deferred fields ONLY
 *              when the line is now fully satisfied (see THE DEFER RULE below).
 *              current_stock moves only through applyIssueDelta, and only when
 *              settings.requisition_deduct_at_issue = '1' (default '0' = the
 *              historical behaviour: recipe-deduction owns current_stock).
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
 *
 * ── THE DEFER RULE (half-transfer) ─────────────────────────────────────────
 * An 'issue' used to blank deferred_until + defer_reason unconditionally, so
 * "requested 4, issue 2, defer the other 2" was impossible on ONE line: the
 * issue destroyed the defer the moment it landed. An issue now clears the
 * defer ONLY when the line is fully satisfied:
 *
 *     newQty >= (chef_approved_qty ?? quantity_requested)
 *
 * — character-for-character the predicate the auto-advance below uses, on
 * purpose. If the two ever disagreed, a line could satisfy the auto-advance's
 * qty test while still carrying a deferred_until, and its `!deferred_until`
 * clause would keep the requisition out of 'fulfilled' forever. A line that is
 * not deferred is unaffected: the partial UPDATE simply leaves an already-NULL
 * deferred_until and an already-empty defer_reason alone.
 *
 * ── STOCK ──────────────────────────────────────────────────────────────────
 * Every write to quantity_issued here is mirrored to applyIssueDelta()
 * (src/lib/issue-stock.ts), THE single writer of requisition stock. Per its
 * caller contract this route: reads the before-quantity INSIDE the transaction
 * immediately before the UPDATE (undo/reject zero the column and blank
 * issue_history in one statement — read it late and the pre-image is gone),
 * and calls the helper inside this route's own transaction so its writes roll
 * back with ours. The helper owns the settings flag, the party skip, the unit
 * conversion, the inventory_transactions row, the ledger row and the
 * department credit; none of that is duplicated here.
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
    // Optional per-gesture idempotency token. One token covers the whole batch:
    // the unique index is (client_token, req_item_id), so distinct lines of the
    // same POST never collide with each other, only with a REPLAY of themselves.
    const clientToken: string | null =
      typeof body?.client_token === 'string' && body.client_token.trim()
        ? body.client_token.trim()
        : null;

    const allItems = db.prepare(`
      SELECT ri.*, rm.name AS material_name
      FROM requisition_items ri
      JOIN raw_materials rm ON rm.id = ri.material_id
      WHERE ri.req_id = ?
    `).all(id) as any[];
    const itemMap = new Map<string, any>();
    for (const it of allItems) itemMap.set(it.id, it);

    // THE LIVE PRE-IMAGE. allItems/itemMap above is a snapshot taken before
    // `await req.json()` yielded; it is used ONLY to prove a line belongs to
    // THIS requisition and to name the material in the audit trail. Every
    // mutable field is re-read from here INSIDE the transaction, immediately
    // before the UPDATE that changes it.
    const selLine = db.prepare(`
      SELECT id, quantity_issued, issue_history, is_rejected, store_rejected,
             store_reject_reason, deferred_until, defer_reason,
             quantity_requested, chef_approved_qty
      FROM requisition_items
      WHERE id = ? AND req_id = ?
    `);

    // Fully-satisfied issue: clears the defer. See THE DEFER RULE in the header.
    const updIssue = db.prepare(`
      UPDATE requisition_items
      SET quantity_issued = ?, issued_at = ?, issued_by = ?,
          deferred_until = NULL, defer_reason = '',
          issue_history = ?
      WHERE id = ?
    `);
    // Partial issue: identical, minus the defer wipe. On a line with no defer
    // this writes exactly the same row as updIssue (deferred_until is already
    // NULL and defer_reason already '' — updDefer sets the two together and
    // undo/reject clear the two together, so they are never half-set).
    const updIssuePartial = db.prepare(`
      UPDATE requisition_items
      SET quantity_issued = ?, issued_at = ?, issued_by = ?,
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
    // Carried out of the rolled-back transaction. A plain `let` narrowed to
    // null would defeat the check below, because TS does not track assignments
    // made inside a closure.
    const abort: { statusConflict?: string } = {};

    const txn = db.transaction(() => {
      // TOCTOU. The status read at the top of this handler happened BEFORE
      // `await req.json()` yielded the event loop, so two concurrent POSTs both
      // cleared that guard and both issued — the second one against a
      // requisition the first had already driven to 'fulfilled'. Re-assert it
      // here. better-sqlite3 is synchronous and there is no `await` anywhere
      // inside this transaction, so from this SELECT to the last UPDATE no other
      // request can interleave: the check and the writes are one atomic step.
      const rNow = db.prepare('SELECT status FROM requisitions WHERE id = ?').get(id) as any;
      if (!rNow || !okStatuses.has(rNow.status)) {
        abort.statusConflict = String(rNow?.status ?? 'unknown');
        throw new Error('req_status_changed');
      }

      for (const ln of lines) {
        const it = itemMap.get(ln.id);
        if (!it) continue;                          // unknown line — skip silently
        // STALE SNAPSHOT. itemMap was read before the transaction opened, so
        // two 'issue' entries for the SAME line id in one POST both computed
        // their new total from the same base and the second UPDATE silently
        // swallowed the first (same for issue_history). Re-read the line here.
        const cur = selLine.get(ln.id, id) as any;
        if (!cur) continue;                         // vanished mid-flight
        if (cur.is_rejected) continue;              // chef rejected — never issue
        const action = String(ln.action || '').toLowerCase();
        const before = {
          quantity_issued: cur.quantity_issued || 0,
          deferred_until:  cur.deferred_until,
          defer_reason:    cur.defer_reason,
          store_rejected:  cur.store_rejected || 0,
          store_reject_reason: cur.store_reject_reason || '',
        };
        // A store-rejected line accepts only 'unreject' — clear the rejection
        // first before issuing/deferring/undoing it again.
        if (cur.store_rejected && action !== 'unreject') continue;
        if (action === 'issue') {
          const addQty = Number(ln.quantity);
          if (!Number.isFinite(addQty) || addQty <= 0) continue;
          const beforeQty = Number(cur.quantity_issued) || 0;   // in-txn pre-image
          const newQty = beforeQty + addQty;
          const history = (() => {
            try { return JSON.parse(cur.issue_history || '[]'); } catch { return []; }
          })();
          history.push({ qty: addQty, at: nowIso, by: me.email, note: ln.note || '' });
          // THE DEFER RULE — half-transfer. Same expression as the auto-advance
          // below; see the header for why they must stay identical.
          const eff = (cur.chef_approved_qty != null
            ? Number(cur.chef_approved_qty)
            : Number(cur.quantity_requested)) || 0;
          const fullySatisfied = newQty >= eff;
          const stmt = fullySatisfied ? updIssue : updIssuePartial;
          stmt.run(newQty, nowIso, me.email, JSON.stringify(history), cur.id);
          applyIssueDelta(db, {
            reqItemId: cur.id, beforeLineQty: beforeQty, afterLineQty: newQty,
            reason: 'issue', actor: me.email, clientToken,
          });
          auditPerLine.push({ id: it.id, material: it.material_name, action, before, after: {
            quantity_issued: newQty, issued_at: nowIso, issued_by: me.email, added: addQty,
          }});
        } else if (action === 'defer') {
          const until = String(ln.defer_until || '').trim();
          const reason = String(ln.reason || '').trim();
          if (!until) continue;
          // NO STOCK EFFECT. defer touches neither quantity_issued nor stock —
          // it only records when the store will hand the rest over.
          updDefer.run(until, reason, cur.id);
          auditPerLine.push({ id: it.id, material: it.material_name, action, before, after: {
            deferred_until: until, defer_reason: reason,
          }});
        } else if (action === 'undo') {
          // Capture the pre-image FIRST: updUndo zeroes quantity_issued and
          // blanks issue_history in the same statement.
          const beforeQty = Number(cur.quantity_issued) || 0;
          updUndo.run(cur.id);
          applyIssueDelta(db, {
            reqItemId: cur.id, beforeLineQty: beforeQty, afterLineQty: 0,
            reason: 'undo', actor: me.email, clientToken,
          });
          auditPerLine.push({ id: it.id, material: it.material_name, action, before, after: {
            quantity_issued: 0, issued_at: null, issued_by: null,
          }});
        } else if (action === 'reject') {
          const reason = String(ln.reason || '').trim();
          // Same pre-image rule as undo — updReject also zeroes the column.
          const beforeQty = Number(cur.quantity_issued) || 0;
          updReject.run(reason, cur.id);
          applyIssueDelta(db, {
            reqItemId: cur.id, beforeLineQty: beforeQty, afterLineQty: 0,
            reason: 'store_reject', actor: me.email, clientToken,
          });
          auditPerLine.push({ id: it.id, material: it.material_name, action, before, after: {
            store_rejected: 1, store_reject_reason: reason, quantity_issued: 0,
          }});
        } else if (action === 'unreject') {
          // EXPLICITLY NO STOCK MOVEMENT, and applyIssueDelta is deliberately
          // NOT called. unreject clears store_rejected + store_reject_reason
          // and nothing else; quantity_issued is already 0 (the matching
          // 'reject' zeroed it and already returned the negative delta), so
          // before === after === 0 by construction and the correct delta is 0.
          // The helper is not asked for that zero because its needs-unit-review
          // branch (issue-stock.ts:168-172) writes a ledger row even at delta 0,
          // which would make lineHasMovedStock() true for a line this action
          // never moved a gram of.
          updUnreject.run(cur.id);
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
        // Party path also TRANSFERS store → department (store deduction + dept
        // credit). The helper is idempotent via the party_consumption ledger row,
        // so re-fulfilment or the store-process path can never double-transfer.
        if (r.purpose === 'party') {
          applyPartyFulfillment(db, id, me.email);
        }
      } else {
        // Mark in-progress so the queue knows it's been touched.
        // rNow, not r: r.status was read before the body parse yielded.
        if (rNow.status === 'mgmt_approved' || rNow.status === 'chef_approved') {
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
    try {
      txn();
    } catch (e: any) {
      // Lost the status race — the requisition moved on between the guard above
      // and the write lock. Nothing was written (the throw rolled the whole
      // transaction back); answer with the same 400 the pre-flight guard gives.
      if (abort.statusConflict) {
        return Response.json(
          { error: `Cannot issue items — current status: ${abort.statusConflict}` },
          { status: 400 },
        );
      }
      // Replayed gesture token. Also fully rolled back, so the earlier POST's
      // effect is the only one that exists — report success, not failure.
      // Falls through to the audit skip below deliberately: those events were
      // written by the original POST.
      if (isIssueTokenReplay(e)) {
        const now = db.prepare('SELECT status FROM requisitions WHERE id = ?').get(id) as any;
        return Response.json({ success: true, replayed: true, status: now?.status, applied: 0 });
      }
      throw e;
    }

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
