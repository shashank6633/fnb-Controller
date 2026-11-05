/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentOutletId, isManagement } from '@/lib/auth';
import {
  canRunFssaiCheck, fssaiToday, fssaiRecordStatusMeta, isFssaiRecordStatus,
  fssaiVoidRefusal,
} from '@/lib/fssai';
import {
  requireFssaiUser, fssaiCsrfGuard, fssaiAudit, fssaiAuditBestEffort,
  fssaiAppAudit, str,
} from '@/lib/fssai-server';
import {
  P5_LIST_LIMIT, num, readBusinessDate, readClock, attachP5Files,
  readP5AttachmentIndex, voidP5Record, real, voidFields,
} from '../../_p5/records';

/**
 * USED COOKING OIL LEAVING THE BUILDING — the RUCO register
 * (/api/fssai/oil/disposals). Owner §12.
 *
 * ── WHAT AN INSPECTOR IS ACTUALLY ASKING ────────────────────────────────────
 * Not "did you change the oil" — that is the oil check. This answers "where did
 * the used oil GO". A food business that fries has to be able to name the
 * collector, his registration, the quantity and the receipt. That is the whole
 * record, and it is why agency_reg_no is the column this table exists for.
 *
 * ── THERE IS NO MONEY COLUMN AND THERE WILL NOT BE ──────────────────────────
 * A collector's receipt usually carries a value. The moment this table held one
 * it would become a second place the business records income, outside the
 * purchasing and sales ledgers that own that number — two authorities on one
 * figure, which is how a ledger becomes unexplainable. The schema has no such
 * column, this route reads no such field off the body, and a caller who sends
 * `amount` or `rate` changes nothing. Said here so nobody adds one "just for
 * reference".
 *
 * ── IT DOES NOT MOVE STOCK EITHER ───────────────────────────────────────────
 * HARD RULE 5. Used oil leaving the building is an observation; if a stock figure
 * needs adjusting, that happens in the inventory screens by whoever owns it.
 *
 *   GET  ?id=<collection>
 *   GET  [?from=&to=&vendor_id=&status=&q=]
 *   POST { action: 'record' | 'link' | 'void', … }
 */
export const dynamic = 'force-dynamic';

/** See the note in the FIFO route: a stand-in reason, never written anywhere. */
const VOID_REASON_PROBE = '----';

const DISPOSAL_SELECT = `
  SELECT dp.*, v.name AS vendor_name,
         (SELECT COUNT(*) FROM fssai_oil_checks o
           WHERE o.disposal_id = dp.id AND o.status <> 'void') AS check_count,
         (SELECT IFNULL(SUM(o.qty_discarded), 0) FROM fssai_oil_checks o
           WHERE o.disposal_id = dp.id AND o.status <> 'void' AND o.qty_discarded IS NOT NULL) AS checks_qty
    FROM fssai_oil_disposals dp
    LEFT JOIN vendors v ON v.id = dp.vendor_id`;

function shapeDisposal(row: any) {
  const quantity = real(row.quantity);
  const checksQty = real(row.checks_qty);
  return {
    id: String(row.id),
    business_date: String(row.business_date || ''),
    collected_at: String(row.collected_at || ''),
    vendor_id: String(row.vendor_id || ''),
    vendor_name: String(row.vendor_name || ''),
    collector_name: String(row.collector_name || ''),
    agency_reg_no: String(row.agency_reg_no || ''),
    vehicle_no: String(row.vehicle_no || ''),
    /* NULL means the quantity was not written down — never 0 litres, which would
     * read as a collection that carried nothing away. */
    quantity,
    uom: String(row.uom || 'L'),
    receipt_no: String(row.receipt_no || ''),
    document_id: String(row.document_id || ''),
    handed_over_by: String(row.handed_over_by || ''),
    note: String(row.note || ''),
    status: String(row.status || 'submitted'),
    status_label: fssaiRecordStatusMeta(row.status).label,
    created_by: String(row.created_by || ''),
    created_at: String(row.created_at || ''),
    updated_at: String(row.updated_at || ''),
    /* How much the oil CHECKS say was discarded against this collection, beside
     * what the collector's receipt says. They will not always agree (oil is
     * drained over several days and measured by eye) and that is exactly why both
     * numbers are shown rather than one being presented as the truth. */
    linked_checks: Number(row.check_count) || 0,
    linked_discarded_qty: checksQty,
    quantity_matches_checks: quantity !== null && checksQty !== null && checksQty > 0
      ? Math.abs(quantity - checksQty) < 0.5
      : null,
    ...voidFields(row),
  };
}

export async function GET(request: Request) {
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;

  try {
    const db = getDb();
    const url = new URL(request.url);

    const id = str(url.searchParams.get('id'));
    if (id) {
      const row = db.prepare(`${DISPOSAL_SELECT} WHERE dp.id = ?`).get(id) as any;
      if (!row) return Response.json({ error: 'That collection no longer exists.' }, { status: 404 });
      /* NO DEPARTMENT SCOPE HERE, deliberately: fssai_oil_disposals has no
       * department column, because used oil leaves the building as one load from
       * the whole restaurant. Every signed-in user may read the register. */
      const checks = db.prepare(
        `SELECT o.id, o.business_date, o.equipment_label, o.qty_discarded, o.qty_uom, o.is_fail
           FROM fssai_oil_checks o
          WHERE o.disposal_id = ? AND o.status <> 'void'
          ORDER BY o.business_date ASC, o.rowid ASC`,
      ).all(id) as any[];
      const voidRefusal = fssaiVoidRefusal(me, row, VOID_REASON_PROBE);
      return Response.json({
        disposal: shapeDisposal(row),
        checks: checks.map((c) => ({
          id: String(c.id),
          business_date: String(c.business_date || ''),
          equipment_label: String(c.equipment_label || ''),
          qty_discarded: real(c.qty_discarded),
          qty_uom: String(c.qty_uom || ''),
          is_fail: Number(c.is_fail) === 1,
        })),
        documents: readP5AttachmentIndex(db, 'fssai_oil_disposals', [id]).get(id) || [],
        can_void: !voidRefusal,
        void_refusal: voidRefusal,
        has_money_column: false,
      });
    }

    const where: string[] = [];
    const args: any[] = [];
    const from = str(url.searchParams.get('from'));
    const to = str(url.searchParams.get('to'));
    if (from) { where.push('dp.business_date >= ?'); args.push(from); }
    if (to) { where.push('dp.business_date <= ?'); args.push(to); }
    const vendorId = str(url.searchParams.get('vendor_id'));
    if (vendorId) { where.push('dp.vendor_id = ?'); args.push(vendorId); }

    const status = str(url.searchParams.get('status')) || 'live';
    if (status === 'live') where.push(`dp.status <> 'void'`);
    else if (status !== 'all') {
      if (!isFssaiRecordStatus(status)) {
        return Response.json({ error: `"${status}" is not a state a record can be in.` }, { status: 400 });
      }
      where.push('dp.status = ?'); args.push(status);
    }

    const rows = db.prepare(
      `${DISPOSAL_SELECT}
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY dp.business_date DESC, dp.collected_at DESC, dp.created_at DESC, dp.rowid DESC
       LIMIT ${P5_LIST_LIMIT}`,
    ).all(...args) as any[];

    const q = str(url.searchParams.get('q')).toLowerCase();
    const shaped = rows.map(shapeDisposal).filter((r) => !q
      || r.vendor_name.toLowerCase().includes(q)
      || r.collector_name.toLowerCase().includes(q)
      || r.agency_reg_no.toLowerCase().includes(q)
      || r.receipt_no.toLowerCase().includes(q)
      || r.vehicle_no.toLowerCase().includes(q));

    const docs = readP5AttachmentIndex(db, 'fssai_oil_disposals', shaped.map((r) => r.id));

    /* OIL THAT WAS DISCARDED AND NEVER COLLECTED — the gap this register exists
     * to show. A kitchen that files twenty oil changes and no collections has a
     * question to answer, and a screen that only listed the collections would
     * never raise it. */
    const orphans = db.prepare(
      `SELECT COUNT(*) AS n, IFNULL(SUM(qty_discarded), 0) AS qty
         FROM fssai_oil_checks
        WHERE status <> 'void' AND disposal_id = ''
          AND qty_discarded IS NOT NULL AND qty_discarded > 0`,
    ).get() as any;

    const vendors = db.prepare(
      `SELECT id, name FROM vendors WHERE is_active = 1 ORDER BY name ASC`,
    ).all() as any[];

    return Response.json({
      disposals: shaped.map((r) => ({ ...r, documents: docs.get(r.id) || [] })),
      uncollected: {
        checks: Number(orphans?.n) || 0,
        quantity: Number(orphans?.qty) || 0,
        note: 'Oil checks that recorded a quantity discarded but are not yet attached to a collection.',
      },
      vendors,
      can_record: canRunFssaiCheck(me),
      is_management: isManagement(me),
      me: me.email || '',
      /* Stated in the payload so a later report built on this endpoint cannot
       * quietly start treating the register as a financial record. */
      has_money_column: false,
      moves_stock: false,
      truncated: rows.length >= P5_LIST_LIMIT,
    });
  } catch (e: any) {
    console.error('GET /api/fssai/oil/disposals failed:', e);
    return Response.json({ error: e?.message || 'Failed to load the used-oil collections' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const csrf = fssaiCsrfGuard(request);
  if (csrf) return csrf;
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;

  let body: any = {};
  try { body = await request.json(); } catch { /* validated below */ }

  try {
    const db = getDb();
    const outletId = (await getCurrentOutletId()) || '';
    const today = fssaiToday();
    const action = str(body?.action) || 'record';

    /* ══ VOID ═══════════════════════════════════════════════════════════════ */
    if (action === 'void') {
      const id = str(body?.id);
      const reason = str(body?.reason).slice(0, 1000);
      if (!id) return Response.json({ error: 'Which collection? No id was sent.' }, { status: 400 });
      const row = db.prepare(`SELECT * FROM fssai_oil_disposals WHERE id = ?`).get(id) as any;
      if (!row) return Response.json({ error: 'That collection no longer exists.' }, { status: 404 });

      const refusal = fssaiVoidRefusal(me, row, reason);
      if (refusal) {
        const needsReason = !fssaiVoidRefusal(me, row, VOID_REASON_PROBE);
        return Response.json({ error: refusal }, { status: needsReason ? 400 : 403 });
      }

      const doVoid = db.transaction(() => {
        const changes = voidP5Record(db, 'fssai_oil_disposals', {
          id, reason, actor: { email: me.email, name: me.name },
        });
        if (changes !== 1) throw new Error('FSSAI_DISPOSAL_ALREADY_VOID');
        /* THE OIL CHECKS ARE RELEASED, NOT VOIDED. Voiding a collection says the
         * collection did not happen that way; it says nothing about the oil that
         * was drained, which was genuinely drained. So the checks go back to
         * "discarded, not yet collected" and reappear in the `uncollected`
         * figure, which is the honest state. */
        db.prepare(
          `UPDATE fssai_oil_checks SET disposal_id = '', updated_at = datetime('now')
            WHERE disposal_id = ?`,
        ).run(id);
        fssaiAudit(db, {
          entity_table: 'fssai_oil_disposals', entity_id: id, action: 'void', field: 'status',
          before: {
            status: String(row.status || ''), quantity: real(row.quantity),
            receipt_no: String(row.receipt_no || ''), agency_reg_no: String(row.agency_reg_no || ''),
          },
          after: { status: 'void', released_checks: true },
          reason, actor: { email: me.email, name: me.name }, outlet_id: outletId || row.outlet_id,
        });
      });
      try { doVoid(); } catch (e: any) {
        if (String(e?.message) === 'FSSAI_DISPOSAL_ALREADY_VOID') {
          return Response.json({ error: 'That collection has already been voided.' }, { status: 409 });
        }
        throw e;
      }

      fssaiAppAudit(db, {
        event_type: 'fssai.oil_disposal.void', entity_type: 'fssai_oil_disposals', entity_id: id,
        actor_email: me.email, before: { status: row.status }, after: { status: 'void' }, note: reason,
      });

      const fresh = db.prepare(`${DISPOSAL_SELECT} WHERE dp.id = ?`).get(id) as any;
      return Response.json({
        ok: true, disposal: shapeDisposal(fresh),
        kept: 'The collection stays in the file with your reason on it. The oil checks it covered now read as discarded but not yet collected.',
      });
    }

    /* ══ ATTACH OIL CHECKS TO A COLLECTION ══════════════════════════════════ */
    if (action === 'link') {
      if (!canRunFssaiCheck(me)) {
        return Response.json({ error: 'You are not able to file food-safety records.' }, { status: 403 });
      }
      const id = str(body?.id);
      const checkIds: string[] = Array.isArray(body?.check_ids)
        ? body.check_ids.map((c: unknown) => str(c)).filter(Boolean) : [];
      if (!id) return Response.json({ error: 'Which collection? No id was sent.' }, { status: 400 });
      if (!checkIds.length) return Response.json({ error: 'No oil checks were selected.' }, { status: 400 });

      const disposal = db.prepare(`SELECT * FROM fssai_oil_disposals WHERE id = ?`).get(id) as any;
      if (!disposal) return Response.json({ error: 'That collection no longer exists.' }, { status: 404 });
      if (String(disposal.status) === 'void') {
        return Response.json({ error: 'That collection has been voided, so nothing can be attached to it.' }, { status: 409 });
      }

      const linked: string[] = [];
      const refused: { id: string; why: string }[] = [];

      const apply = db.transaction(() => {
        for (const checkId of checkIds) {
          const chk = db.prepare(
            `SELECT id, disposal_id, status, equipment_label FROM fssai_oil_checks WHERE id = ?`,
          ).get(checkId) as any;
          if (!chk) { refused.push({ id: checkId, why: 'That oil check no longer exists.' }); continue; }
          if (String(chk.status) === 'void') {
            refused.push({ id: checkId, why: 'That oil check has been voided.' }); continue;
          }
          /* ONE COLLECTION PER CHECK. Re-pointing a check at a second collection
           * would mean the same drained oil left the building twice, so it is
           * refused by name rather than silently overwritten. */
          if (String(chk.disposal_id || '') && String(chk.disposal_id) !== id) {
            refused.push({ id: checkId, why: 'That oil check is already attached to another collection.' });
            continue;
          }
          const res = db.prepare(
            `UPDATE fssai_oil_checks SET disposal_id = ?, updated_at = datetime('now')
              WHERE id = ? AND status <> 'void' AND disposal_id IN ('', ?)`,
          ).run(id, checkId, id);
          if (res.changes === 1) linked.push(checkId);
        }
        if (linked.length) {
          fssaiAuditBestEffort(db, {
            entity_table: 'fssai_oil_disposals', entity_id: id, action: 'update', field: 'disposal_id',
            after: { linked_oil_checks: linked },
            reason: 'Oil checks attached to this collection.',
            actor: { email: me.email, name: me.name }, outlet_id: outletId || disposal.outlet_id,
          });
        }
      });
      apply();

      const fresh = db.prepare(`${DISPOSAL_SELECT} WHERE dp.id = ?`).get(id) as any;
      return Response.json({ ok: true, disposal: shapeDisposal(fresh), linked, refused });
    }

    if (action !== 'record') {
      return Response.json(
        { error: `"${action}" is not something this screen does. Use record, link or void.` },
        { status: 400 },
      );
    }

    /* ══ RECORD A COLLECTION ════════════════════════════════════════════════ */
    if (!canRunFssaiCheck(me)) {
      return Response.json({ error: 'You are not able to file food-safety records.' }, { status: 403 });
    }

    const date = readBusinessDate(body?.business_date, today);
    if (!date.ok) return Response.json({ error: date.error }, { status: 400 });

    const vendorId = str(body?.vendor_id);
    let collectorName = str(body?.collector_name).slice(0, 200);
    if (vendorId) {
      const v = db.prepare(`SELECT id, name FROM vendors WHERE id = ?`).get(vendorId) as any;
      if (!v) {
        return Response.json(
          { error: 'That collector is not in the vendor list. Add him there first — this screen never creates vendors.' },
          { status: 400 },
        );
      }
      if (!collectorName) collectorName = String(v.name || '');
    }
    if (!vendorId && !collectorName) {
      return Response.json(
        { error: 'Who collected it? Pick the agency from the list, or type the collector\'s name.' },
        { status: 400 },
      );
    }

    /* THE REGISTRATION IS THE POINT OF THE RECORD. Used oil handed to somebody
     * unregistered is the finding an inspector is looking for, so a blank
     * registration is REFUSED unless the person says in words why there is none
     * — which is itself the honest record, and better than a blank box nobody
     * can interpret later. */
    const agencyRegNo = str(body?.agency_reg_no).slice(0, 120);
    const note = str(body?.note).slice(0, 2000);
    if (!agencyRegNo && !note) {
      return Response.json(
        {
          error: 'Enter the collector\'s registration number. If he has none, say so in the note — that is the thing an inspector will ask about, and a blank box answers nothing.',
          code: 'registration_or_note',
        },
        { status: 400 },
      );
    }

    const quantity = num(body?.quantity);
    if (quantity !== null && quantity <= 0) {
      return Response.json(
        { error: `A collection of ${quantity} is not a quantity. Leave it blank if it was not measured.` },
        { status: 400 },
      );
    }

    const id = generateId();
    const files = Array.isArray(body?.documents) ? body.documents : [];
    const checkIds: string[] = Array.isArray(body?.check_ids)
      ? body.check_ids.map((c: unknown) => str(c)).filter(Boolean) : [];

    let attached: ReturnType<typeof attachP5Files> = [];
    const linked: string[] = [];

    const write = db.transaction(() => {
      db.prepare(
        `INSERT INTO fssai_oil_disposals
           (id, business_date, collected_at, vendor_id, collector_name, agency_reg_no,
            vehicle_no, quantity, uom, receipt_no, document_id, handed_over_by, note,
            status, created_by, outlet_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, 'submitted', ?, ?)`,
      ).run(
        id, date.date, readClock(body?.collected_at), vendorId, collectorName, agencyRegNo,
        str(body?.vehicle_no).slice(0, 60), quantity, str(body?.uom) || 'L',
        str(body?.receipt_no).slice(0, 120),
        /* WHO HANDED IT OVER defaults to the person filing, which is almost
         * always true and is the name an inspector asks for. It is overridable
         * because the storekeeper often writes up what the kitchen porter did. */
        str(body?.handed_over_by) || me.email || '',
        note, me.email || '', outletId,
      );

      attached = attachP5Files(db, {
        entityTable: 'fssai_oil_disposals', entityId: id, files,
        actor: { email: me.email, name: me.name }, outletId,
      });

      for (const checkId of checkIds) {
        const res = db.prepare(
          `UPDATE fssai_oil_checks SET disposal_id = ?, updated_at = datetime('now')
            WHERE id = ? AND status <> 'void' AND disposal_id = ''`,
        ).run(id, checkId);
        if (res.changes === 1) linked.push(checkId);
      }

      fssaiAuditBestEffort(db, {
        entity_table: 'fssai_oil_disposals', entity_id: id, action: 'create',
        after: {
          business_date: date.date, vendor_id: vendorId, collector_name: collectorName,
          agency_reg_no: agencyRegNo, quantity, uom: str(body?.uom) || 'L',
          receipt_no: str(body?.receipt_no), linked_oil_checks: linked, documents: attached.length,
        },
        reason: date.backdated ? `Filed on ${today} for ${date.date}.` : '',
        actor: { email: me.email, name: me.name }, outlet_id: outletId,
      });
    });

    try {
      write();
    } catch (e: any) {
      const m = String(e?.message || '');
      if (m.startsWith('P5_BAD_PHOTO:')) {
        return Response.json({ error: m.slice('P5_BAD_PHOTO:'.length) }, { status: 413 });
      }
      if (m.startsWith('P5_TOO_MANY_PHOTOS:')) {
        return Response.json({ error: m.slice('P5_TOO_MANY_PHOTOS:'.length) }, { status: 400 });
      }
      throw e;
    }

    fssaiAppAudit(db, {
      event_type: 'fssai.oil_disposal.record', entity_type: 'fssai_oil_disposals', entity_id: id,
      actor_email: me.email,
      after: { collector_name: collectorName, agency_reg_no: agencyRegNo, quantity },
    });

    const fresh = db.prepare(`${DISPOSAL_SELECT} WHERE dp.id = ?`).get(id) as any;
    return Response.json({
      ok: true,
      disposal: shapeDisposal(fresh),
      documents: attached,
      linked,
      refused_links: checkIds.filter((c) => !linked.includes(c)),
      has_money_column: false,
      stock_unchanged: true,
      ...(agencyRegNo ? {} : {
        warning: 'This collection has no registration number against it. An inspector will ask. The note you wrote is what he will read.',
      }),
    });
  } catch (e: any) {
    console.error('POST /api/fssai/oil/disposals failed:', e);
    return Response.json({ error: e?.message || 'Failed to save the collection' }, { status: 500 });
  }
}

/* No DELETE. A collection is voided with a written reason (§19) and the oil
 * checks it covered are released back to "not yet collected", never voided with
 * it — the oil really was drained. */
