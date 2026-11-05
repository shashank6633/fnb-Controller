/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentOutletId, isManagement } from '@/lib/auth';
import { requireFssaiUser, fssaiCsrfGuard, fssaiAppAudit, str } from '@/lib/fssai-server';
import {
  FSSAI_VOIDABLE_RECORDS, FSSAI_VOIDABLE_MISSING, FSSAI_VOIDABLE_ORPHANS,
  FSSAI_ADMIN_MAY_VOID_OWN_RECORD,
  fssaiVoidableRecord, fssaiVoidRefusalForRecord, voidFssaiRecord,
  describeFssaiRecord, fssaiTableExists,
} from '@/lib/fssai-void';

/**
 * CANCEL A COMPLIANCE RECORD — the owner's §19, as ONE endpoint (P10).
 *
 *   GET  ?entity_table=&id=   what this record is, and whether I may cancel it
 *   GET  ?tables=1            the registers this endpoint can cancel, for a screen
 *   POST { entity_table, id, reason }
 *
 * ── WHAT §19 ASKS FOR AND WHAT THIS DOES ────────────────────────────────────
 * "Sensitive records are voided with a mandatory reason, never deleted." So this
 * route holds no DELETE — grep it — and cancelling a record changes exactly four
 * columns plus the status: voided_at, voided_by, void_reason, updated_at. It
 * never touches a reading, a verdict, a photograph or a signature. The row stays
 * in the file, readable, with the reason on it, and the before-and-after is frozen
 * into fssai_audit_log inside the same transaction.
 *
 * ── WHY ONE ENDPOINT FOR ELEVEN TABLES ──────────────────────────────────────
 * Because §19 is one rule. Eleven copies of it is eleven chances for one register
 * to forget the reason check or to use a kinder refusal than the others, and this
 * project has already paid for two lanes writing the same helper twice. The
 * per-table facts (which column holds the author, what identifies the row) are
 * data in src/lib/fssai-void.ts, and the authority check is one function.
 *
 * ── THE TWO TABLES THIS ROUTE DELIBERATELY REFUSES ──────────────────────────
 * `fssai_runs` and `fssai_corrective_actions` already had a void path before P10
 * (runs/route.ts action 'void'; corrective-actions action 'cancel'), and both do
 * more than a generic void can: the run void interacts with the slot rule, and a
 * CA cancel guards the status it is leaving. A second writer of the same rows is
 * exactly the drift this file exists to prevent, so those two are answered with a
 * 409 that NAMES the endpoint to use. The refusal carries `use_endpoint` so a
 * screen can follow it without a hard-coded map.
 *
 * ── WHO ─────────────────────────────────────────────────────────────────────
 * Management (manager · head of department · admin), never the person who filed
 * the record, with the single admin exception documented in fssai-void.ts. The
 * refusal comes back in words, the same words a screen shows, from one function.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;

  /* Management only, even to READ. A staff member has no use for "may I cancel
   * this", and the answer carries the record's own contents. */
  if (!isManagement(me)) {
    return Response.json(
      { error: 'Only a manager, head of department or admin can cancel a compliance record.' },
      { status: 403 },
    );
  }

  try {
    const db = getDb();
    const url = new URL(request.url);

    /* ══ the registers this endpoint serves ════════════════════════════════ */
    if (url.searchParams.get('tables') === '1') {
      return Response.json({
        tables: FSSAI_VOIDABLE_RECORDS.map((r) => ({
          table: r.table,
          one: r.one,
          many: r.many,
          path: r.path,
          void_status: r.voidStatus,
          exists: fssaiTableExists(db, r.table),
          handled_here: !r.delegate,
          use_endpoint: r.delegate?.endpoint || '/api/fssai/void',
          use_action: r.delegate?.action || 'void',
        })),
        /* Said out loud rather than left to a comment: if a later wave adds a
         * record table and forgets the descriptor, this array stops being empty
         * and the screen can show it. */
        missing_descriptors: FSSAI_VOIDABLE_MISSING,
        orphan_descriptors: FSSAI_VOIDABLE_ORPHANS,
        admin_may_void_own_record: FSSAI_ADMIN_MAY_VOID_OWN_RECORD,
      });
    }

    const table = str(url.searchParams.get('entity_table'));
    const id = str(url.searchParams.get('id'));
    if (!table || !id) {
      return Response.json(
        { error: 'Which record? Send entity_table and id, or tables=1 for the list.' },
        { status: 400 },
      );
    }

    const desc = fssaiVoidableRecord(table);
    if (!desc) {
      return Response.json(
        { error: `"${table}" is not a compliance register this module can cancel a record in.` },
        { status: 400 },
      );
    }
    if (!fssaiTableExists(db, desc.table)) {
      return Response.json(
        { error: `The ${desc.many.toLowerCase()} register is not in this database yet.` },
        { status: 409 },
      );
    }

    const row = db.prepare(`SELECT * FROM ${desc.table} WHERE id = ?`).get(id) as any;
    if (!row) {
      return Response.json({ error: `That ${desc.one} no longer exists.` }, { status: 404 });
    }

    const refusal = desc.delegate
      ? `A ${desc.one} is cancelled on ${desc.delegate.endpoint}. ${desc.delegate.why}`
      : fssaiVoidRefusalForRecord(me, row, 'placeholder reason', desc);

    return Response.json({
      record: describeFssaiRecord(row, desc),
      /* The refusal above was computed with a placeholder reason on purpose: the
       * screen is asking "could I cancel this at all", before the manager has
       * typed anything. The real reason is checked again on POST — the route, not
       * the form, is the gate. */
      can_void: !desc.delegate && !refusal,
      refusal,
      reason_min_length: 4,
      handled_here: !desc.delegate,
      use_endpoint: desc.delegate?.endpoint || '/api/fssai/void',
      use_action: desc.delegate?.action || 'void',
    });
  } catch (e: any) {
    console.error('GET /api/fssai/void failed:', e);
    return Response.json({ error: e?.message || 'Could not read that record.' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const csrf = fssaiCsrfGuard(request);
  if (csrf) return csrf;

  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;

  try {
    let body: any = {};
    try { body = await request.json(); } catch { body = {}; }

    const table = str(body?.entity_table);
    const id = str(body?.id);
    const reason = str(body?.reason).trim();
    if (!table || !id) {
      return Response.json({ error: 'Which record? Send entity_table and id.' }, { status: 400 });
    }

    const desc = fssaiVoidableRecord(table);
    if (!desc) {
      return Response.json(
        { error: `"${table}" is not a compliance register this module can cancel a record in.` },
        { status: 400 },
      );
    }
    if (desc.delegate) {
      return Response.json(
        {
          error: `A ${desc.one} is cancelled on ${desc.delegate.endpoint}. ${desc.delegate.why}`,
          use_endpoint: desc.delegate.endpoint,
          use_action: desc.delegate.action,
        },
        { status: 409 },
      );
    }

    const db = getDb();
    if (!fssaiTableExists(db, desc.table)) {
      return Response.json(
        { error: `The ${desc.many.toLowerCase()} register is not in this database yet.` },
        { status: 409 },
      );
    }

    const row = db.prepare(`SELECT * FROM ${desc.table} WHERE id = ?`).get(id) as any;
    if (!row) {
      return Response.json({ error: `That ${desc.one} no longer exists.` }, { status: 404 });
    }

    const refusal = fssaiVoidRefusalForRecord(me, row, reason, desc);
    if (refusal) {
      /* 400 when the manager simply has not said why yet; 403 when the answer
       * would not change whatever they type. The screen shows the sentence
       * either way — the status is for anything that is not a screen. */
      const needsReason = reason.length < 4;
      return Response.json({ error: refusal }, { status: needsReason ? 400 : 403 });
    }

    /* THE RECORD'S OUTLET WINS, and the session's is only the fallback. A manager
     * switched to outlet 2 cancelling an outlet-1 reading must not file the audit
     * row under outlet 2 — the trail would then be unfindable from the outlet
     * whose register changed. The session is asked ONLY when the row itself cannot
     * say, which also keeps a cookie read off the common path. */
    const outletId = str(row.outlet_id) || (await getCurrentOutletId()) || '';
    const result = voidFssaiRecord(db, {
      desc,
      row,
      reason,
      actor: { email: me.email, name: me.name, role: me.role },
      outletId,
    });

    if ('conflict' in result) {
      return Response.json({ error: result.conflict }, { status: 409 });
    }

    /* The app-wide trail too (RECON §5 row 13 — no second audit table), AFTER
     * the transaction: the compliance row is the one that must be atomic, and a
     * failure to mirror must not undo a lawful cancellation. */
    fssaiAppAudit(db, {
      event_type: 'fssai.record.void',
      entity_type: desc.table,
      entity_id: result.id,
      actor_email: me.email,
      before: { status: row.status },
      after: { status: result.status, self_void: result.self_void },
      note: reason,
    });

    return Response.json({
      ...result,
      record: describeFssaiRecord(
        { ...row, status: result.status, voided_at: result.voided_at, voided_by: result.voided_by, void_reason: result.void_reason },
        desc,
      ),
      message: `That ${desc.one} is cancelled. It stays in the file with the reason on it — nothing is deleted.`,
    });
  } catch (e: any) {
    console.error('POST /api/fssai/void failed:', e);
    return Response.json(
      { error: e?.message || 'That record could not be cancelled.' },
      { status: 500 },
    );
  }
}
