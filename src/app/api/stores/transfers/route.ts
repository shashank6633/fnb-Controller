import { getDb, logAuditEvent } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import type { SessionUser } from '@/lib/auth';
import {
  listTransfers, createTransfer, userStoreAccess,
  type StoreAccess, type TransferStatus,
} from '@/lib/store-engine';

/**
 * Store → Store transfers (multi-floor bar requisition / issue / receive).
 *
 * GET  /api/stores/transfers?store=<id>&status=<s>&direction=<in|out>
 *   List transfer headers (with rollups: total_requested/issued/received/
 *   in_transit) newest-first. Filters:
 *     store     — matches FROM or TO store
 *     status    — requested | issued | received | cancelled
 *     direction — with store: 'in' (store is dest) | 'out' (store is source)
 *   Visibility: elevated viewers (admin / manager / store-manager / HOD) see
 *   all; everyone else sees only transfers touching a store they can_view. A
 *   `store` filter they cannot view → 403.
 *   → { transfers: TransferSummary[] }
 *
 * POST /api/stores/transfers
 *   { from_store_id?, to_store_id, from_central?, items:[{material_id, qty_requested, note?}], note? }
 *   Raise a transfer REQUEST (status='requested', no stock moves). Two sources:
 *     • STORE source (default): from_store_id required. Gate: dest-floor access
 *       (userStoreAccess(to).can_view) — the floor asking for stock. Admin/
 *       manager bypass.
 *     • CENTRAL GROCERY source (from_central=true): from_store_id ignored/empty;
 *       the source is the central grocery (raw_materials.current_stock). Grocery
 *       has NO per-store access, so gate on elevation (admin / manager /
 *       store-manager / HOD) — mirrors who may later issue from grocery.
 *   → { ok, transfer: TransferRow }
 *
 * CSRF: '/api/stores' is in proxy.ts CSRF_REQUIRED_PREFIXES — POST must carry
 * the double-submit header (use the api() client helper).
 */
export const dynamic = 'force-dynamic';

const STATUSES: TransferStatus[] = ['requested', 'issued', 'received', 'cancelled'];

/** Elevated viewers may see EVERY transfer (mirrors the consolidated board). */
function isElevated(user: SessionUser): boolean {
  return user.role === 'admin' || user.role === 'manager' || user.is_store_manager || user.is_head_chef;
}

/** Memoised per-request store-access resolver. */
function accessResolver(db: ReturnType<typeof getDb>, user: SessionUser) {
  const cache = new Map<string, StoreAccess>();
  return (storeId: string): StoreAccess => {
    let a = cache.get(storeId);
    if (!a) { a = userStoreAccess(db, user, storeId); cache.set(storeId, a); }
    return a;
  };
}

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();

    const url = new URL(request.url);
    const storeId = (url.searchParams.get('store') || url.searchParams.get('store_id') || '').trim();
    const statusRaw = (url.searchParams.get('status') || '').trim();
    const direction = (url.searchParams.get('direction') || '').trim().toLowerCase();
    const status = STATUSES.includes(statusRaw as TransferStatus) ? (statusRaw as TransferStatus) : undefined;

    const elevated = isElevated(me);
    const access = accessResolver(db, me);

    // A store filter the (non-elevated) user cannot view is a hard 403.
    if (storeId && !elevated && !access(storeId).can_view) {
      return Response.json({ error: 'You do not have access to that store' }, { status: 403 });
    }

    let list = listTransfers(db, { storeId: storeId || undefined, status });

    if (storeId && (direction === 'in' || direction === 'out')) {
      list = list.filter(t => direction === 'in' ? t.to_store_id === storeId : t.from_store_id === storeId);
    }

    // Non-elevated: keep only transfers touching a store the user can view.
    // Grocery-source (from_central) transfers have no source store to grant on,
    // so they qualify only via the destination floor the user can view.
    if (!elevated) {
      list = list.filter(t => (!t.from_central && access(t.from_store_id).can_view) || access(t.to_store_id).can_view);
    }

    // Source label: 'Grocery' for a central-grocery source, else the store name.
    const transfers = list.map(t => ({ ...t, source_label: t.from_central ? 'Grocery' : t.from_store_name }));

    return Response.json({ transfers });
  } catch (e: any) {
    console.error('[/api/stores/transfers GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();

    const b = await request.json().catch(() => ({}));
    const fromCentral = !!b?.from_central;
    const fromStoreId = String(b?.from_store_id || '').trim();
    const toStoreId = String(b?.to_store_id || '').trim();
    const rawItems = Array.isArray(b?.items) ? b.items : [];

    if (!toStoreId) {
      return Response.json({ error: 'to_store_id is required' }, { status: 400 });
    }
    if (!fromCentral && !fromStoreId) {
      return Response.json({ error: 'from_store_id and to_store_id are required' }, { status: 400 });
    }
    if (rawItems.length === 0) {
      return Response.json({ error: 'A transfer needs at least one item' }, { status: 400 });
    }

    if (fromCentral) {
      // Central-grocery source: no per-store access exists to grant on, so only
      // an elevated user (admin / manager / store-manager / HOD) may raise a
      // grocery-source transfer — the same set that may issue it.
      if (!isElevated(me)) {
        return Response.json({ error: 'You are not authorized to transfer stock from the central grocery' }, { status: 403 });
      }
    } else if (!isElevated(me) && !userStoreAccess(db, me, toStoreId).can_view) {
      // Store source: the requesting floor must have dest-store access.
      return Response.json({ error: 'You are not authorized to request stock for the destination store' }, { status: 403 });
    }

    const items = rawItems.map((it: any) => ({
      material_id: String(it?.material_id || '').trim(),
      qty_requested: Number(it?.qty_requested ?? it?.qty ?? 0),
      note: String(it?.note || ''),
    }));

    let transfer;
    try {
      transfer = createTransfer(db, {
        from: fromStoreId,
        to: toStoreId,
        from_central: fromCentral,
        items,
        by: me.email,
        note: String(b?.note || ''),
      });
    } catch (err: any) {
      // Engine validation (unknown material, same store, inactive, bad qty, …).
      return Response.json({ error: err.message }, { status: 400 });
    }

    logAuditEvent(db, {
      event_type: 'store.transfer.request',
      entity_type: 'store_transfer',
      entity_id: transfer.id,
      actor_email: me.email,
      after: {
        from_central: transfer.from_central,
        from_store_id: transfer.from_store_id, from_store: transfer.from_store_name,
        to_store_id: transfer.to_store_id, to_store: transfer.to_store_name,
        item_count: transfer.items.length, total_requested: transfer.total_requested,
        note: transfer.note,
      },
      note: `Transfer request ${transfer.from_store_name} → ${transfer.to_store_name} (${transfer.items.length} item${transfer.items.length === 1 ? '' : 's'})`,
    });

    return Response.json({ ok: true, transfer }, { status: 201 });
  } catch (e: any) {
    console.error('[/api/stores/transfers POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
