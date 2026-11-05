import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId, isManagement } from '@/lib/auth';
import { fssaiToday } from '@/lib/fssai';
import { fssaiCsrfGuard, fssaiAudit, fssaiAppAudit } from '@/lib/fssai-server';
import {
  VENDOR_APPROVALS, isVendorApproval, vendorApprovalLabel, vendorRegisterReady,
  stripVendorRegister, supplierLicencesByVendor, shapeRegisterRow,
} from './fssai-register';
import { splitPoVendorStats } from '@/lib/vendor-po-stats';

/* THE APPROVED-VENDOR REGISTER rides on this route (Hyderabad audit checklist:
 * "Approved vendor list maintained"):
 *   GET   ?register=1                         the register as one list
 *   PATCH { id, approval, supplies?, note? }  management marks a vendor
 * The ordinary GETs below strip the register's five columns (stripVendorRegister)
 * so every purchasing, GRN and PO screen that reads this route gets the reply it
 * got before those columns existed, byte for byte. POST and PUT never touch them. */

export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    const search = url.searchParams.get('search') || '';
    const includeStats = url.searchParams.get('stats') === '1';

    if (url.searchParams.get('register') === '1') return registerList(db);

    if (id) {
      const v = stripVendorRegister(db.prepare('SELECT * FROM vendors WHERE id = ?').get(id));
      return Response.json({ vendor: v });
    }

    const where = search ? `WHERE v.name LIKE ?` : '';
    const params = search ? [`%${search}%`] : [];

    if (includeStats) {
      // PO count / Lifetime ₹ follow the LINE vendors (src/lib/vendor-po-stats.ts).
      // A PO whose lines are all its header's vendor — every single-vendor PO —
      // stays on the header query below, so its figures are exactly what they
      // were. A merged / mixed PO (header "Mixed (N vendors)", vendor_id NULL)
      // used to count for NO vendor; a drifted header credited one vendor with
      // another's lines. Those "split" POs are taken out of the header query and
      // each line vendor is credited its own share instead.
      const split = splitPoVendorStats(db);
      if (split.splitPoIds.length === 0) {
        const rows = db.prepare(`
          SELECT v.*,
                 (SELECT COUNT(*) FROM purchase_orders po WHERE po.vendor_id = v.id) AS po_count,
                 (SELECT COALESCE(SUM(total_cost), 0) FROM purchase_orders po
                  WHERE po.vendor_id = v.id AND po.status IN ('approved', 'received')) AS lifetime_spend,
                 (SELECT MAX(date) FROM purchase_orders po WHERE po.vendor_id = v.id AND po.status = 'received') AS last_received
          FROM vendors v
          ${where}
          ORDER BY v.name ASC
        `).all(...params);
        return Response.json({ vendors: rows.map(stripVendorRegister) });
      }
      const notSplit = `AND po.id NOT IN (SELECT value FROM json_each(?))`;
      const ids = JSON.stringify(split.splitPoIds);
      const rows = db.prepare(`
        SELECT v.*,
               (SELECT COUNT(*) FROM purchase_orders po WHERE po.vendor_id = v.id ${notSplit}) AS po_count,
               (SELECT COALESCE(SUM(total_cost), 0) FROM purchase_orders po
                WHERE po.vendor_id = v.id AND po.status IN ('approved', 'received') ${notSplit}) AS lifetime_spend,
               (SELECT MAX(date) FROM purchase_orders po WHERE po.vendor_id = v.id AND po.status = 'received' ${notSplit}) AS last_received
        FROM vendors v
        ${where}
        ORDER BY v.name ASC
      `).all(ids, ids, ids, ...params) as any[];
      for (const r of rows) {
        const share = split.byVendor.get(String(r.id));
        if (!share) continue;
        r.po_count = (Number(r.po_count) || 0) + share.po_count;
        // Rounded only when a share is actually added, so a vendor whose split
        // POs carry no spend (draft, pending) keeps the header sum as SQL gave it.
        if (share.lifetime_spend !== 0) {
          r.lifetime_spend = Math.round(((Number(r.lifetime_spend) || 0) + share.lifetime_spend) * 100) / 100;
        }
        if (share.last_received && (!r.last_received || share.last_received > String(r.last_received))) {
          r.last_received = share.last_received;
        }
      }
      return Response.json({ vendors: rows.map(stripVendorRegister) });
    }

    const rows = db.prepare(`SELECT * FROM vendors ${where} ORDER BY name ASC`).all(...params);
    return Response.json({ vendors: rows.map(stripVendorRegister) });
  } catch (e: any) { return Response.json({ error: e.message }, { status: 500 }); }
}

/** GET ?register=1 — every vendor with its approval and the supplier licence on
 *  file, as one list. Read by /vendors (the register view and its download).
 *
 *  SIGNED-IN ONLY. The proxy checks only that a session cookie is PRESENT on a
 *  GET, so a forged or expired cookie reaches this handler, and the register
 *  carries staff data (approval_by is the approving manager's login email) and
 *  compliance data (licence number, expiry, document id). A failed session
 *  lookup refuses too: it is never read as "no user, carry on". The ordinary
 *  vendor GETs above are unchanged (they are what every purchasing screen reads,
 *  and they carry none of the register's columns). */
async function registerList(db: ReturnType<typeof getDb>) {
  const today = fssaiToday();
  const me = await getCurrentUser().catch(() => null);
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!vendorRegisterReady(db)) {
    // Said, never shown as an empty register: an empty list here would read as
    // "nobody is approved" when the truth is "the columns did not migrate".
    return Response.json({
      error: 'The approved-vendor register is not set up on this database yet (the vendor columns did not migrate). Restart the app; if it persists, the server log says why.',
    }, { status: 503 });
  }
  const rows = db.prepare(`SELECT * FROM vendors ORDER BY name ASC`).all() as any[];
  const licences = supplierLicencesByVendor(db, today);
  const vendors = rows.map((r) => shapeRegisterRow(r, licences.get(String(r.id)) || null));
  const live = vendors.filter((v) => v.is_active);
  return Response.json({
    vendors,
    counts: {
      active: live.length,
      approved: live.filter((v) => v.approval === 'approved').length,
      not_approved: live.filter((v) => v.approval === 'not_approved').length,
      not_reviewed: live.filter((v) => v.approval === '').length,
      no_licence: live.filter((v) => !v.licence).length,
      licence_expired: live.filter((v) => v.licence?.state === 'expired').length,
      licence_expiring: live.filter((v) => v.licence?.state === 'expiring').length,
      would_warn: live.filter((v) => v.would_warn).length,
    },
    approvals: VENDOR_APPROVALS,
    can_manage: isManagement(me),
    licence_source: 'The licence number and expiry come from the supplier licence filed for this vendor under FSSAI → Documents (type "Supplier FSSAI licence"). Renewing it there updates this list.',
    today,
  });
}

/**
 * PATCH — mark a vendor approved / not approved / not reviewed, and record what
 * they supply. Management only. Written with the compliance audit row in the
 * same transaction, so a decision that cannot be recorded is not applied.
 *
 * This writes ONLY the five fssai_* columns. It does not touch updated_at or any
 * column purchasing reads, and it never blocks anything: the receiving screen
 * reads the result and warns.
 */
export async function PATCH(request: Request) {
  const csrf = fssaiCsrfGuard(request);
  if (csrf) return csrf;
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!isManagement(me)) {
    return Response.json({ error: 'Approving a vendor is a management decision. Ask a manager to mark it.' }, { status: 403 });
  }
  let b: any = {};
  try { b = await request.json(); } catch { b = {}; }
  try {
    const db = getDb();
    if (!vendorRegisterReady(db)) {
      return Response.json({ error: 'The approved-vendor register is not set up on this database yet. Restart the app.' }, { status: 503 });
    }
    const id = typeof b.id === 'string' ? b.id.trim() : '';
    if (!id) return Response.json({ error: 'Which vendor? No id was sent.' }, { status: 400 });
    const row = db.prepare(
      `SELECT id, name, fssai_approval, fssai_approval_by, fssai_approval_at, fssai_supplies, fssai_approval_note
         FROM vendors WHERE id = ?`,
    ).get(id) as any;
    if (!row) return Response.json({ error: 'That vendor is not in the vendor list.' }, { status: 404 });

    const approval = b.approval === undefined ? String(row.fssai_approval || '') : String(b.approval ?? '');
    if (!isVendorApproval(approval)) {
      return Response.json({ error: `"${approval}" is not a choice here. Use approved, not approved, or not reviewed yet.` }, { status: 400 });
    }
    const supplies = (b.supplies === undefined ? String(row.fssai_supplies || '') : String(b.supplies ?? '')).trim().slice(0, 500);
    const note = (b.note === undefined ? String(row.fssai_approval_note || '') : String(b.note ?? '')).trim().slice(0, 1000);
    if (approval === 'not_approved' && note.length < 4) {
      return Response.json({ error: 'Say why this vendor is not approved — the note is what an inspector reads next to the name.' }, { status: 400 });
    }

    const before = {
      fssai_approval: String(row.fssai_approval || ''), fssai_approval_by: String(row.fssai_approval_by || ''),
      fssai_approval_at: String(row.fssai_approval_at || ''), fssai_supplies: String(row.fssai_supplies || ''),
      fssai_approval_note: String(row.fssai_approval_note || ''),
    };
    const approvalChanged = approval !== before.fssai_approval;
    if (!approvalChanged && supplies === before.fssai_supplies && note === before.fssai_approval_note) {
      return Response.json({ vendor: { ...before, id, name: String(row.name || '') }, unchanged: true });
    }
    // Who and when describe the APPROVAL DECISION, so they move only when it does.
    const after = {
      fssai_approval: approval,
      fssai_approval_by: approvalChanged ? String(me.email || '') : before.fssai_approval_by,
      fssai_approval_at: approvalChanged ? new Date().toISOString() : before.fssai_approval_at,
      fssai_supplies: supplies,
      fssai_approval_note: note,
    };
    const outletId = (await getCurrentOutletId().catch(() => null)) || '';
    // better-sqlite3 is synchronous: nothing is awaited inside this transaction.
    db.transaction(() => {
      db.prepare(
        `UPDATE vendors SET fssai_approval = ?, fssai_approval_by = ?, fssai_approval_at = ?,
                            fssai_supplies = ?, fssai_approval_note = ?
          WHERE id = ?`,
      ).run(after.fssai_approval, after.fssai_approval_by, after.fssai_approval_at, after.fssai_supplies, after.fssai_approval_note, id);
      fssaiAudit(db, {
        entity_table: 'vendors', entity_id: id, action: 'approval',
        field: approvalChanged ? 'fssai_approval' : '',
        before, after, reason: note,
        actor: { email: me.email, name: me.name }, outlet_id: outletId,
      });
    })();
    try {
      fssaiAppAudit(db, {
        event_type: 'fssai_vendor_approval', entity_type: 'vendors', entity_id: id, actor_email: me.email,
        before: { approval: before.fssai_approval }, after: { approval, supplies },
        note: `${String(row.name || '')}: ${vendorApprovalLabel(approval)}`,
      });
    } catch (e) { console.error('vendor approval: app audit mirror failed (the decision and its fssai audit row stand):', e); }
    return Response.json({ vendor: { ...after, id, name: String(row.name || '') }, updated: true });
  } catch (e: any) {
    return Response.json({ error: e?.message || 'Could not save the approval' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const db = getDb();
    const b = await request.json();
    // Trim at the write boundary. The name is the join key back to purchases.vendor
    // (LOWER(TRIM(name)) in vendors/for-material, materials-summary, vendor-contracts
    // and the PO vendor_id lookups), so a trailing space typed on a phone keyboard
    // would persist and desync those matches. JS trim() also strips tabs/NBSP, which
    // SQLite's TRIM() does not. A whitespace-only name is no name — 400 as before.
    const name = typeof b.name === 'string' ? b.name.trim() : b.name;
    if (!name) return Response.json({ error: 'name required' }, { status: 400 });
    const id = generateId();
    db.prepare(`
      INSERT INTO vendors (id, name, contact_person, phone, email, gstin, address, payment_terms, lead_time_days, is_active, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, b.contact_person || '', b.phone || '', b.email || '', b.gstin || '',
            b.address || '', b.payment_terms || '', Number(b.lead_time_days) || 0,
            b.is_active === false ? 0 : 1, b.notes || '');
    const v = stripVendorRegister(db.prepare('SELECT * FROM vendors WHERE id = ?').get(id));
    return Response.json({ vendor: v }, { status: 201 });
  } catch (e: any) { return Response.json({ error: e.message }, { status: 500 }); }
}

export async function PUT(request: Request) {
  try {
    const db = getDb();
    const b = await request.json();
    if (!b.id) return Response.json({ error: 'id required' }, { status: 400 });
    db.prepare(`
      UPDATE vendors SET
        name = COALESCE(?, name),
        contact_person = COALESCE(?, contact_person),
        phone = COALESCE(?, phone),
        email = COALESCE(?, email),
        gstin = COALESCE(?, gstin),
        address = COALESCE(?, address),
        payment_terms = COALESCE(?, payment_terms),
        lead_time_days = COALESCE(?, lead_time_days),
        is_active = COALESCE(?, is_active),
        notes = COALESCE(?, notes),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      // Same write-boundary trim as POST. A whitespace-only edit binds NULL so
      // COALESCE keeps the stored name — blanking it would orphan every
      // LOWER(TRIM(name)) join back to purchases.vendor.
      b.name != null ? (String(b.name).trim() || null) : null,
      b.contact_person ?? null, b.phone ?? null, b.email ?? null,
      b.gstin ?? null, b.address ?? null, b.payment_terms ?? null,
      b.lead_time_days != null ? Number(b.lead_time_days) : null,
      b.is_active != null ? (b.is_active ? 1 : 0) : null,
      b.notes ?? null, b.id,
    );
    const v = stripVendorRegister(db.prepare('SELECT * FROM vendors WHERE id = ?').get(b.id));
    return Response.json({ vendor: v });
  } catch (e: any) { return Response.json({ error: e.message }, { status: 500 }); }
}

export async function DELETE(request: Request) {
  try {
    const db = getDb();
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return Response.json({ error: 'id required' }, { status: 400 });
    // Soft delete — preserve history
    db.prepare(`UPDATE vendors SET is_active = 0, updated_at = datetime('now') WHERE id = ?`).run(id);
    return Response.json({ success: true });
  } catch (e: any) { return Response.json({ error: e.message }, { status: 500 }); }
}
