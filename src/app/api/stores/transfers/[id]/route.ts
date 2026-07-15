import { getDb, logAuditEvent } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import type { SessionUser } from '@/lib/auth';
import {
  getTransfer, issueTransfer, receiveTransfer, cancelTransfer, userStoreAccess,
} from '@/lib/store-engine';

/**
 * One store → store transfer (view + workflow actions).
 *
 * GET  /api/stores/transfers/[id]
 *   Full transfer with items and computed per-item in_transit/discrepancy
 *   (= qty_issued − qty_received) + header rollups.
 *   Visibility: elevated (admin/manager/store-manager/HOD) OR can_view on the
 *   source or destination store. → { transfer: TransferRow }
 *
 * PATCH /api/stores/transfers/[id]
 *   { action: 'issue' | 'receive' | 'cancel', items?: [...] }
 *     issue   — items:[{material_id, qty_issued}]  (debits SOURCE).
 *               Store source → gate: source can_procure OR can_adjust.
 *               Grocery source (from_central) → gate: elevated (admin/manager/
 *               store-manager/HOD); issue debits raw_materials.current_stock.
 *               Only 'requested'.
 *     receive — items:[{material_id, qty_received}] (credits DEST store).
 *               Gate: dest can_close_stock OR can_adjust. Only 'issued'.
 *     cancel  — no items. Gate: view on source or dest. Only 'requested'.
 *   Actor is always the signed-in user (client-supplied `by` is ignored).
 *   → { ok, transfer: TransferRow }
 *
 * CSRF: '/api/stores' is in proxy.ts CSRF_REQUIRED_PREFIXES — PATCH must carry
 * the double-submit header (use the api() client helper).
 */
export const dynamic = 'force-dynamic';

function isElevated(user: SessionUser): boolean {
  return user.role === 'admin' || user.role === 'manager' || user.is_store_manager || user.is_head_chef;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id } = await params;
    const db = getDb();

    const transfer = getTransfer(db, id);
    if (!transfer) return Response.json({ error: 'Transfer not found' }, { status: 404 });

    if (!isElevated(me)) {
      const canView =
        userStoreAccess(db, me, transfer.from_store_id).can_view ||
        userStoreAccess(db, me, transfer.to_store_id).can_view;
      if (!canView) return Response.json({ error: 'You do not have access to this transfer' }, { status: 403 });
    }

    return Response.json({ transfer });
  } catch (e: any) {
    console.error('[/api/stores/transfers/[id] GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id } = await params;
    const db = getDb();

    const existing = getTransfer(db, id);
    if (!existing) return Response.json({ error: 'Transfer not found' }, { status: 404 });

    const b = await request.json().catch(() => ({}));
    const action = String(b?.action || '').trim().toLowerCase();
    const items = Array.isArray(b?.items) ? b.items : [];

    if (action === 'issue') {
      if (existing.from_central) {
        // Grocery source has no per-store access — issuing debits the central
        // grocery, so require elevation (admin / manager / store-manager / HOD).
        if (!isElevated(me)) {
          return Response.json({ error: 'You are not authorized to issue stock from the central grocery' }, { status: 403 });
        }
      } else {
        const src = userStoreAccess(db, me, existing.from_store_id);
        if (!(src.can_procure || src.can_adjust)) {
          return Response.json({ error: `You are not authorized to issue stock from ${existing.from_store_name}` }, { status: 403 });
        }
      }
    } else if (action === 'receive') {
      const dst = userStoreAccess(db, me, existing.to_store_id);
      if (!(dst.can_close_stock || dst.can_adjust)) {
        return Response.json({ error: `You are not authorized to receive stock at ${existing.to_store_name}` }, { status: 403 });
      }
    } else if (action === 'cancel') {
      if (!isElevated(me)) {
        const canView =
          userStoreAccess(db, me, existing.from_store_id).can_view ||
          userStoreAccess(db, me, existing.to_store_id).can_view;
        if (!canView) return Response.json({ error: 'You do not have access to this transfer' }, { status: 403 });
      }
    } else {
      return Response.json({ error: "action must be 'issue', 'receive' or 'cancel'" }, { status: 400 });
    }

    let transfer;
    try {
      if (action === 'issue') {
        transfer = issueTransfer(db, id, {
          items: items.map((it: any) => ({
            material_id: String(it?.material_id || '').trim(),
            qty_issued: Number(it?.qty_issued ?? it?.qty ?? 0),
          })),
          by: me.email,
        });
      } else if (action === 'receive') {
        transfer = receiveTransfer(db, id, {
          items: items.map((it: any) => ({
            material_id: String(it?.material_id || '').trim(),
            qty_received: Number(it?.qty_received ?? it?.qty ?? 0),
          })),
          by: me.email,
        });
      } else {
        transfer = cancelTransfer(db, id, me.email);
      }
    } catch (err: any) {
      // Engine state/validation errors (wrong status, item not in transfer, bad qty).
      return Response.json({ error: err.message }, { status: 400 });
    }

    logAuditEvent(db, {
      event_type: `store.transfer.${action}`,
      entity_type: 'store_transfer',
      entity_id: transfer.id,
      actor_email: me.email,
      after: {
        from_store_id: transfer.from_store_id, from_store: transfer.from_store_name,
        to_store_id: transfer.to_store_id, to_store: transfer.to_store_name,
        status: transfer.status,
        total_requested: transfer.total_requested,
        total_issued: transfer.total_issued,
        total_received: transfer.total_received,
        total_in_transit: transfer.total_in_transit,
      },
      note: `Transfer ${action} ${transfer.from_store_name} → ${transfer.to_store_name} (now ${transfer.status})`,
    });

    return Response.json({ ok: true, transfer });
  } catch (e: any) {
    console.error('[/api/stores/transfers/[id] PATCH]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
