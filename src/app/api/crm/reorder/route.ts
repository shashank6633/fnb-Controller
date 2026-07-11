/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { reorderSuggestionsEnriched } from '@/lib/crm-analyst-data';
import { createDraftPosFromReorder, type ReorderPoItemInput } from '@/lib/crm-reorder-po';

/**
 * Smart Reorder (/crm/reorder).
 *
 * GET  /api/crm/reorder
 *        → reorder suggestions (same trigger/qty math as the AI Analyst view)
 *          enriched per material with mapped vendors, a preferred vendor and a
 *          ₹/purchase-unit price (contract → last purchase → average×pack).
 * POST /api/crm/reorder  { items: [{ material_id, qty, vendor_id|null, unit_price }] }
 *        → groups items by vendor and creates one DRAFT purchase order per
 *          vendor through the same code shape as POST /api/purchase-orders
 *          (see src/lib/crm-reorder-po.ts) — the normal submit/approve/receive
 *          flow applies from there. Returns { orders: [{id, po_number, …}] }.
 *
 * Gate (both verbs): admin, HOD (is_head_chef) or Store Manager
 * (is_store_manager) — the people who raise POs today.
 */
export const dynamic = 'force-dynamic';

async function gate(): Promise<{ me: any } | { resp: Response }> {
  const me = await getCurrentUser();
  if (!me) return { resp: Response.json({ error: 'Sign in required' }, { status: 401 }) };
  if (!(me.role === 'admin' || me.is_head_chef || me.is_store_manager)) {
    return { resp: Response.json({ error: 'Not authorised' }, { status: 403 }) };
  }
  return { me };
}

export async function GET() {
  const g = await gate();
  if ('resp' in g) return g.resp;
  try {
    return Response.json(reorderSuggestionsEnriched(getDb()));
  } catch (e: any) {
    console.error('GET /api/crm/reorder failed:', e);
    return Response.json({ error: e?.message || 'Failed to load suggestions' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const g = await gate();
  if ('resp' in g) return g.resp;
  const me = g.me;

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }
  const items: ReorderPoItemInput[] = Array.isArray(body?.items) ? body.items : [];
  if (items.length === 0) {
    return Response.json({ error: 'items array required' }, { status: 400 });
  }

  try {
    const db = getDb();
    const outletId = await getCurrentOutletId();
    const orders = createDraftPosFromReorder(db, items, me.email || 'system', outletId);
    return Response.json({ orders }, { status: 201 });
  } catch (e: any) {
    // createDraftPosFromReorder throws user-facing messages on bad input.
    const msg = e?.message || 'Failed to create purchase orders';
    const isInput = /^(Unknown material|Unknown vendor|Each item|items array)/.test(msg);
    if (!isInput) console.error('POST /api/crm/reorder failed:', e);
    return Response.json({ error: msg }, { status: isInput ? 400 : 500 });
  }
}
