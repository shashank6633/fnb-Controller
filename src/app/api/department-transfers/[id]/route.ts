import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { getDeptTransfer } from '@/lib/dept-ledger';
import { loadDepartments, canSeeTransfer } from '../access';
import { presentChecked } from '../send-back-check';

/**
 * GET /api/department-transfers/<id> — one transfer document with its lines
 * (each quantity in RECIPE units as stored, and the PURCHASE unit), its
 * disputes, its reverse links, and what the caller may do with it
 * (`permissions`: can_flag_dispute, can_reverse + reverse_prefill — the exact
 * quantities a one-tap reverse would move, offered only when the ledger would
 * take it, else reverse_refused says why (../send-back-check.ts) — and
 * dismissable_dispute_ids).
 * Visible to anyone who may see either end (../access.ts). GET-only — no CSRF
 * surface.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id } = await params;
    const db = getDb();
    const doc = getDeptTransfer(db, String(id || ''));
    if (!doc) return Response.json({ error: 'Transfer not found' }, { status: 404 });
    const depts = loadDepartments(db);
    if (!canSeeTransfer(me, doc, depts)) {
      return Response.json({ error: 'Not allowed for this transfer' }, { status: 403 });
    }
    return Response.json({ transfer: presentChecked(me, doc, depts, db) });
  } catch (e: any) {
    console.error('[department-transfers/[id] GET]', e);
    return Response.json({ error: e?.message || 'Failed to load transfer' }, { status: 500 });
  }
}
