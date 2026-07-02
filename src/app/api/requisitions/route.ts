import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId, canApproveAsMgmt, canProcessAsStore, canIssueAsStore } from '@/lib/auth';
import { requisitionVisibility, isMainDeptHead, isAnyMainDeptHead, effectiveCategoriesForUser } from '@/lib/dept-hierarchy';

// Statuses at which a requisition can be edited, by whom:
//   draft                                            → drafter or admin
//   submitted                                        → head chef or admin (pre-approval tweaks)
//   chef_approved (not yet store-processed)         → admin only (rare; bypasses workflow)
// Beyond that (store_processed / fulfilled / cancelled / rejected) → no edits, only audit trail.
const EDITABLE_STATUSES = ['draft', 'submitted', 'chef_approved'];

/**
 * Internal Department Requisitions REST API.
 *
 * Lifecycle:
 *   draft → submitted → chef_approved → store_processed → fulfilled
 *                    ↘  chef_rejected
 *   cancelled is terminal from any non-terminal state.
 *
 * GET    /api/requisitions                                  → list (filter by ?status=&department_id=&from=&to=)
 * GET    /api/requisitions?id=<uuid>                        → detail with items + linked PO
 * POST   /api/requisitions                                  → create draft
 *        body: { date, department_id, notes, items: [{material_id, quantity_requested, notes?}] }
 * PUT    /api/requisitions                                  → update draft
 *        body: { id, date?, notes?, items? }
 * DELETE /api/requisitions?id=<uuid>                        → delete draft
 *
 * Action endpoints under /api/requisitions/[id]/[action]:
 *   submit, chef-approve, chef-reject, store-process, cancel
 */

function nextReqNumber(db: ReturnType<typeof getDb>, isoDate: string): string {
  const year = isoDate.slice(0, 4);
  const lastRow = db.prepare(`
    SELECT req_number FROM requisitions
    WHERE req_number LIKE 'REQ-' || ? || '-%'
    ORDER BY req_number DESC LIMIT 1
  `).get(year) as any;
  const last = lastRow?.req_number ? parseInt(lastRow.req_number.split('-').pop() || '0', 10) : 0;
  return `REQ-${year}-${String(last + 1).padStart(4, '0')}`;
}

// What requisitions can a given user see?
//   - admin / store mgr / head chef: all in their outlet
//   - if visible_department_ids is set (JSON array): those dept IDs
//   - else dept staff: only requisitions for their own department
//   - else (no dept, no flag): only requisitions they personally drafted
// Visibility (main-department model): admin + store see all; a main-dept HEAD
// sees every requisition under their main dept (all sub-departments); everyone
// else sees ONLY the requisitions they personally drafted. See requisitionVisibility.
async function visibilityFilter() {
  const me = await getCurrentUser();
  if (!me) return { sql: '0=1', params: [] as any[], me: null };
  const vis = requisitionVisibility(getDb(), me);
  if (!vis) return { sql: '1=1', params: [], me };       // null = see all (admin/store)
  return { sql: vis.sql, params: vis.params, me };
}

// ---------- GET ----------
export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    const { sql: visSql, params: visParams, me: visMe } = await visibilityFilter();

    if (id) {
      const r = db.prepare(`
        SELECT r.*, d.name AS department_name, d.code AS department_code,
               po.po_number AS linked_po_number, po.status AS linked_po_status
        FROM requisitions r
        JOIN departments d ON d.id = r.department_id
        LEFT JOIN purchase_orders po ON po.id = r.linked_po_id
        WHERE r.id = ? AND (${visSql})
      `).get(id, ...visParams) as any;
      if (!r) return Response.json({ error: 'Not found' }, { status: 404 });
      // ri.* already includes the new chef_approved_qty, is_rejected, chef_note
      // columns added by the migration in db.ts. Explicit COALESCE on last_purchase_price
      // because some schemas may not have it as a real column (it's computed in the
      // inventory route — for the detail view we just want the latest purchase).
      const items = db.prepare(`
        SELECT ri.*, rm.name AS material_name, rm.sku AS material_sku, rm.unit AS material_unit,
               COALESCE(rm.purchase_unit, rm.unit) AS material_purchase_unit,
               COALESCE(rm.pack_size, 1)          AS material_pack_size,
               rm.current_stock, rm.average_price,
               (SELECT unit_price FROM purchases WHERE material_id = rm.id ORDER BY date DESC, created_at DESC LIMIT 1) AS last_purchase_price,
               d.name AS item_department_name, d.code AS item_department_code
        FROM requisition_items ri
        JOIN raw_materials rm ON rm.id = ri.material_id
        LEFT JOIN departments d ON d.id = ri.department_id
        WHERE ri.req_id = ?
        ORDER BY d.name, rm.name
      `).all(id);
      // Per-req approve permission for the detail view: only this req's main-dept head.
      const can_approve_chef = visMe ? isMainDeptHead(db, visMe, r.department_id) : false;
      return Response.json({ requisition: { ...r, items, can_approve_chef } });
    }

    const status       = url.searchParams.get('status');
    const departmentId = url.searchParams.get('department_id');
    const from         = url.searchParams.get('from');
    const to           = url.searchParams.get('to');
    const inbox        = url.searchParams.get('inbox');     // 'chef' | 'mgmt' | 'store'
    const purpose      = url.searchParams.get('purpose');   // 'internal' | 'party'
    const eventName    = url.searchParams.get('event_name');

    const where: string[] = [visSql];
    const params: any[] = [...visParams];

    const outletId = await getCurrentOutletId();
    if (outletId) { where.push('(r.outlet_id = ? OR r.outlet_id IS NULL)'); params.push(outletId); }

    if (status)        { where.push('r.status = ?');          params.push(status); }
    if (departmentId)  { where.push('r.department_id = ?');   params.push(departmentId); }
    if (from)          { where.push('r.date >= ?');           params.push(from); }
    if (to)            { where.push('r.date <= ?');           params.push(to); }
    if (inbox === 'chef')  { where.push("r.status = 'submitted'"); }
    if (inbox === 'mgmt')  { where.push("r.status = 'chef_approved'"); }
    // 'store' inbox is the issue desk — it lists every requisition currently
    // waiting on the store team to hand over goods, regardless of purpose.
    //
    // Mgmt approval gate behaviour is controlled by the `require_mgmt_approval`
    // setting (admin-managed on /settings/integrations):
    //   require_mgmt_approval=false (default) → chef_approved goes straight to store
    //                                            for BOTH internal and party.
    //   require_mgmt_approval=true            → party reqs need Chef + Mgmt; internal
    //                                            kitchen reqs still skip Mgmt (they
    //                                            never had a Mgmt gate by design).
    // Partially-issued reqs (store_processed) always stay in the inbox until every
    // line is fully issued, so they don't vanish after the first hand-over.
    if (inbox === 'store') {
      const mgmtRow = db.prepare("SELECT value FROM settings WHERE key = 'require_mgmt_approval'").get() as { value: string } | undefined;
      const requireMgmt = mgmtRow?.value === '1';
      if (requireMgmt) {
        where.push(`(
          (r.purpose = 'internal' AND r.status IN ('chef_approved', 'store_processed'))
          OR
          (r.purpose = 'party'    AND r.status IN ('mgmt_approved',  'store_processed'))
        )`);
      } else {
        where.push(`r.status IN ('chef_approved', 'mgmt_approved', 'store_processed')`);
      }
    }
    if (purpose)           { where.push('r.purpose = ?'); params.push(purpose); }
    if (eventName)         { where.push('r.event_name = ?'); params.push(eventName); }

    const rows = db.prepare(`
      SELECT r.*, d.name AS department_name, d.code AS department_code,
             po.po_number AS linked_po_number, po.status AS linked_po_status,
             (SELECT COUNT(*) FROM requisition_items WHERE req_id = r.id) AS item_count,
             (SELECT COALESCE(SUM(
                  ri.quantity_requested
                  * (CASE WHEN ri.unit = rm.purchase_unit AND COALESCE(rm.pack_size, 1) > 1 THEN rm.pack_size ELSE 1 END)
                  * rm.average_price), 0)
                FROM requisition_items ri JOIN raw_materials rm ON rm.id = ri.material_id
                WHERE ri.req_id = r.id) AS estimated_value
      FROM requisitions r
      JOIN departments d ON d.id = r.department_id
      LEFT JOIN purchase_orders po ON po.id = r.linked_po_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.date DESC, r.created_at DESC
    `).all(...params);

    const me = await getCurrentUser();
    // Per-requisition approve permission: only the head of THAT requisition's
    // main department (or admin) may approve it. The global flag is just a hint
    // for the UI (is this user a head anywhere?) — the per-row flag is authoritative.
    const rowsWithPerm = (rows as any[]).map((r) => ({
      ...r,
      can_approve_chef: me ? isMainDeptHead(db, me, r.department_id) : false,
    }));
    return Response.json({
      requisitions: rowsWithPerm,
      viewer_role: me?.role || 'guest',
      viewer_email: me?.email || '',
      viewer_can_approve_chef: me ? (me.role === 'admin' || isAnyMainDeptHead(db, me)) : false,
      viewer_can_approve_mgmt: me ? canApproveAsMgmt(me) : false,
      viewer_can_process_store: me ? canProcessAsStore(me) : false,
      // STRICT issue permission — store person only, no admin bypass. Drives the
      // Issue / Store-Process buttons; the routes enforce it server-side too.
      viewer_can_issue_store: me ? canIssueAsStore(me) : false,
    });
  } catch (e: any) {
    console.error('[/api/requisitions GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

// ---------- POST (create draft) ----------
export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const b = await request.json();
    const { date, department_id, notes, items, purpose, event_notes } = b;
    // event_name / date / guest_count / customer may be overridden by the
    // sheet-truth guard below for non-admin party requisitions, so they
    // must be mutable.
    let { event_name, event_date, guest_count, customer } = b;
    // Sheet-origin keys persisted on the requisition so the list page can
    // re-fetch live Column P data even after the sheet row updates later.
    const fpId           = (b.fp_id           || '').toString().trim();
    const partyUniqueId  = (b.party_unique_id || '').toString().trim();

    if (!Array.isArray(items) || items.length === 0) {
      return Response.json({ error: 'items array required' }, { status: 400 });
    }
    // Per-line departments: each item must carry its own department_id.
    // Fall back to the req-level department_id if a line omits it (legacy clients).
    const validItems = items
      .map((it: any) => ({
        ...it,
        department_id: it.department_id || department_id || null,
      }))
      .filter((it: any) => it.material_id && Number(it.quantity_requested) > 0);
    if (validItems.length === 0) {
      return Response.json({ error: 'no valid items (need material + qty)' }, { status: 400 });
    }
    const missingDept = validItems.find((it: any) => !it.department_id);
    if (missingDept) {
      return Response.json({ error: 'Every item line needs a department' }, { status: 400 });
    }
    // The req-level department is now derived (used by legacy reports + visibility).
    // We pick the first item's dept so existing code that joins on r.department_id keeps working.
    const reqDeptId = department_id || validItems[0].department_id;
    // Party requisitions need event metadata so we can roll up per-event P&L.
    const purposeNorm = String(purpose || 'internal').toLowerCase();
    if (purposeNorm === 'party') {
      if (!String(event_name || '').trim()) return Response.json({ error: 'event_name required for party requisitions' }, { status: 400 });
      if (!String(event_date || '').match(/^\d{4}-\d{2}-\d{2}$/)) return Response.json({ error: 'event_date (YYYY-MM-DD) required for party requisitions' }, { status: 400 });

      // If the client claims this came from the AKAN Party Manager sheet
      // (body.from_sheet === true), only admins can stray from the sheet's
      // canonical name/date/customer. This stops staff/manager from typing
      // over values that should stay synced to the sheet.
      if (b.from_sheet && me.role !== 'admin') {
        // We trust the sheet cache: look up the row by party_unique_id / fp_id
        // and re-assert its values onto this requisition.
        try {
          const cache = db.prepare(`SELECT value FROM settings WHERE key = 'upcoming_parties_cache'`).get() as { value: string } | undefined;
          if (cache) {
            const sheetParties = (JSON.parse(cache.value).parties || []) as any[];
            const match = sheetParties.find(p =>
              (b.party_unique_id && p.party_unique_id === b.party_unique_id) ||
              (b.fp_id && p.fp_id === b.fp_id)
            );
            if (match) {
              // Force-overwrite client values with sheet truth.
              // Per AKAN sheet convention:
              //   Column N (company)       → Company Name
              //   Column P (contact_person) → Customer Name (the actual person)
              //   Column AQ (guest_name)   → free-text, fallback only
              event_name  = match.contact_person || match.guest_name || match.fp_id;
              event_date  = match.date_of_event;
              // Min guarantee = contracted headcount kitchen cooks for; pax_expected is sales optimism.
              guest_count = match.min_guarantee || match.pax_expected || null;
              // Customer field carries ONLY the company name (no phone, no name) —
              // the page renders Customer Name and Company Name from separate fields.
              customer    = match.company || '';
            }
          }
        } catch { /* soft-fail — fall back to client values */ }
      }
    }

    // Non-admin/non-privileged users can only raise for their own department.
    // With per-line depts, every item must belong to their dept.
    if (me.role !== 'admin' && !me.is_head_chef && !me.is_store_manager) {
      if (me.department_id) {
        const offender = validItems.find((it: any) => it.department_id !== me.department_id);
        if (offender) {
          return Response.json({ error: 'You can only raise requisitions for your own department' }, { status: 403 });
        }
      }
    }

    // Server-side category guard (defense in depth): a department user — including
    // a dept head — can only requisition materials within their MAIN department's
    // category whitelist, even if the client is bypassed with a crafted material_id.
    // Admin + store are exempt (they buy across all departments).
    if (me.role !== 'admin' && !me.is_store_manager) {
      const wl = effectiveCategoriesForUser(db, me);
      if (wl && wl.length) {
        const allow = new Set(wl);
        const ids = validItems.map((it: any) => it.material_id);
        const rows = db.prepare(
          `SELECT id, COALESCE(NULLIF(category, ''), 'other') AS category FROM raw_materials WHERE id IN (${ids.map(() => '?').join(',')})`,
        ).all(...ids) as { id: string; category: string }[];
        const catById = new Map(rows.map((r) => [r.id, r.category]));
        const offender = validItems.find((it: any) => !allow.has(catById.get(it.material_id) || ' '));
        if (offender) {
          return Response.json({ error: "One or more items are outside your department's allowed categories." }, { status: 403 });
        }
      }
    }

    const isoDate = String(date || new Date().toISOString().slice(0, 10));
    const id = generateId();
    const reqNumber = nextReqNumber(db, isoDate);
    const outletId = await getCurrentOutletId();

    const txn = db.transaction(() => {
      db.prepare(`
        INSERT INTO requisitions (id, req_number, department_id, date, status, notes,
                                  drafted_by, outlet_id,
                                  purpose, event_name, event_date, guest_count, customer, event_notes,
                                  fp_id, party_unique_id,
                                  created_at, updated_at)
        VALUES (?, ?, ?, ?, 'draft', ?, ?, ?,
                ?, ?, ?, ?, ?, ?,
                ?, ?,
                datetime('now'), datetime('now'))
      `).run(id, reqNumber, reqDeptId, isoDate, notes || '', me.email, outletId,
              purposeNorm, event_name || '', event_date || null,
              guest_count != null ? Number(guest_count) || null : null,
              customer || '', event_notes || '',
              fpId, partyUniqueId);

      const insItem = db.prepare(`
        INSERT INTO requisition_items (id, req_id, material_id, quantity_requested, unit, notes, department_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const it of validItems) {
        insItem.run(generateId(), id, it.material_id, Number(it.quantity_requested),
                    (it.unit || '').toString(), it.notes || '', it.department_id);
      }
    });
    txn();

    const r = db.prepare('SELECT * FROM requisitions WHERE id = ?').get(id);
    return Response.json({ requisition: r }, { status: 201 });
  } catch (e: any) {
    console.error('[/api/requisitions POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

// ---------- PUT (update draft) ----------
export async function PUT(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const b = await request.json();
    const { id, date, notes, items } = b;
    if (!id) return Response.json({ error: 'id required' }, { status: 400 });

    const r = db.prepare('SELECT * FROM requisitions WHERE id = ?').get(id) as any;
    if (!r) return Response.json({ error: 'Not found' }, { status: 404 });
    if (!EDITABLE_STATUSES.includes(r.status)) {
      return Response.json({ error: `Cannot edit requisition in '${r.status}' state` }, { status: 400 });
    }

    // Permission matrix per status:
    //   draft         → original drafter OR admin
    //   submitted     → head chef OR admin (lets chef tweak qtys before approving)
    //   chef_approved → admin only (escape hatch; bypasses normal flow)
    const isAdmin = me.role === 'admin';
    const isAuthor = r.drafted_by === me.email;
    // Only the head of THIS requisition's main department (or admin) may tweak a
    // submitted req before approving it.
    const isChef = isMainDeptHead(db, me, r.department_id);
    let allowed = false;
    if (r.status === 'draft')               allowed = isAuthor || isAdmin;
    else if (r.status === 'submitted')      allowed = isChef || isAdmin;
    else if (r.status === 'chef_approved')  allowed = isAdmin;
    if (!allowed) {
      return Response.json({
        error: r.status === 'submitted'
          ? 'Only the head chef or admin can edit a submitted requisition.'
          : r.status === 'chef_approved'
            ? 'Only admin can edit an already-chef-approved requisition.'
            : 'Only the drafter or admin can edit this requisition.',
      }, { status: 403 });
    }

    // Pull all editable metadata off the body — for party reqs, the UI may
    // resend any of these on a draft edit. COALESCE keeps unspecified fields
    // unchanged (so a partial update doesn't blank anything out).
    const eventName   = typeof b.event_name   === 'string' ? b.event_name.trim()   : undefined;
    const eventDate   = typeof b.event_date   === 'string' ? b.event_date          : undefined;
    const guestCount  = b.guest_count != null ? Number(b.guest_count) : undefined;
    const customer    = typeof b.customer     === 'string' ? b.customer.trim()     : undefined;
    const eventNotes  = typeof b.event_notes  === 'string' ? b.event_notes.trim()  : undefined;
    const departmentId = typeof b.department_id === 'string' ? b.department_id     : undefined;

    const txn = db.transaction(() => {
      db.prepare(`
        UPDATE requisitions SET
          date          = COALESCE(?, date),
          notes         = COALESCE(?, notes),
          event_name    = COALESCE(?, event_name),
          event_date    = COALESCE(?, event_date),
          guest_count   = COALESCE(?, guest_count),
          customer      = COALESCE(?, customer),
          event_notes   = COALESCE(?, event_notes),
          department_id = COALESCE(?, department_id),
          updated_at = datetime('now')
        WHERE id = ?
      `).run(
        date ?? null, notes ?? null,
        eventName ?? null, eventDate ?? null,
        guestCount ?? null, customer ?? null, eventNotes ?? null,
        departmentId ?? null,
        id,
      );

      if (Array.isArray(items)) {
        db.prepare('DELETE FROM requisition_items WHERE req_id = ?').run(id);
        const ins = db.prepare(`
          INSERT INTO requisition_items (id, req_id, material_id, quantity_requested, unit, notes, department_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const it of items) {
          const qty = Number(it.quantity_requested) || 0;
          if (!it.material_id || qty <= 0) continue;
          // Fall back to req-level dept if line omits it
          const deptId = it.department_id || r.department_id;
          ins.run(generateId(), id, it.material_id, qty,
                  (it.unit || '').toString(), it.notes || '', deptId);
        }
      }
    });
    txn();

    const fresh = db.prepare('SELECT * FROM requisitions WHERE id = ?').get(id);
    return Response.json({ requisition: fresh });
  } catch (e: any) {
    console.error('[/api/requisitions PUT]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

// ---------- DELETE (drafts only) ----------
export async function DELETE(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return Response.json({ error: 'id required' }, { status: 400 });
    const r = db.prepare('SELECT * FROM requisitions WHERE id = ?').get(id) as any;
    if (!r) return Response.json({ error: 'Not found' }, { status: 404 });
    if (r.status !== 'draft') return Response.json({ error: 'Only drafts can be deleted' }, { status: 400 });
    if (r.drafted_by !== me.email && me.role !== 'admin') {
      return Response.json({ error: 'Only the drafter or admin can delete' }, { status: 403 });
    }
    db.prepare('DELETE FROM requisitions WHERE id = ?').run(id);
    return Response.json({ success: true });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
