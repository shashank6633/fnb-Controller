import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { ensureBohSchema } from '@/lib/boh-schema';
import { getBoh, closeBoh, BohError } from '@/lib/boh';
import { canCloseBoh } from '@/lib/boh-access';

/**
 * POST /api/boh/[id]/close — close a BOH that STILL CARRIES A BALANCE.
 *
 * ── THIS IS NOT HOW A PAID BILL CLOSES ─────────────────────────────────────
 * A BOH whose balance reaches zero closes ITSELF, inside recordBohPayment().
 * That is arithmetic, and arithmetic needs no approval. This route is the other
 * thing entirely: a WRITE-OFF (`write_off`), or the reconciliation of a bill
 * that was collected through the POS while this record was open
 * (`settled_outside_boh`). Both are judgement, both carry mandatory remarks,
 * and both are audited as their own distinct event — never the same button as
 * "record payment".
 *
 * ── MANAGEMENT ONLY, AND STRICTER THAN HOLD ON PURPOSE ─────────────────────
 * Hold is a FORWARD commitment a cashier makes with a guest standing there.
 * Closing an unpaid BOH is the WRITE-OFF OF AN ACCOUNTABILITY RECORD ABOUT THAT
 * CASHIER. Letting the responsible user close their own outstanding bill would
 * remove the only thing this module is for, so isManagement() gates it — a
 * different and stricter predicate than the settleAuthority() that gates every
 * other action here.
 *
 * A NON-ZERO CLOSE NEVER TOUCHES THE ORDER. Writing off a debt is a decision
 * about the debt, not a collection: it must not settle a bill nobody paid, and
 * it must not un-hold one. The rail guard in closeBoh() enforces that.
 */
export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const gate = canCloseBoh(me);
    if (!gate.allowed) return Response.json({ error: gate.message }, { status: gate.status });

    const db = getDb();
    if (!ensureBohSchema(db)) return Response.json({ error: 'The Bills on Hold tables are unavailable on this database.' }, { status: 503 });
    const { id } = await params;

    const boh = getBoh(db, id);
    if (!boh) return Response.json({ error: 'BOH not found' }, { status: 404 });
    // A zero-balance record should never reach this route — it would already be
    // closed. Say so rather than writing a write-off for nothing.
    if (boh.status === 'open' && boh.balance_amount <= 0.005) {
      return Response.json({
        error: 'This BOH has no outstanding balance — record the final payment and it closes itself. A write-off is only for money that will not be collected.',
      }, { status: 400 });
    }

    const b = await req.json().catch(() => ({}));
    // `acknowledge_collected` is the manager saying, on the record, that they
    // have checked what was actually taken. It is only ever asked for when this
    // BOH already carries collections of its own AND the till has settled the
    // bill — i.e. when the guest may have paid twice. closeBoh() refuses with a
    // 409 and the figure until it arrives, and stamps the figure permanently
    // into close_remarks and the audit row once it does.
    const updated = closeBoh(db, id, String(b?.kind || 'write_off'), String(b?.remarks || ''), {
      id: me.id, email: me.email, name: me.name, role: me.role,
    }, { acknowledgeCollected: b?.acknowledge_collected === true });
    return Response.json({ boh: updated });
  } catch (e: any) {
    if (e instanceof BohError) return Response.json({ error: e.message }, { status: e.status });
    console.error('[/api/boh/[id]/close POST]', e);
    return Response.json({ error: e?.message || 'Failed to close' }, { status: 500 });
  }
}
