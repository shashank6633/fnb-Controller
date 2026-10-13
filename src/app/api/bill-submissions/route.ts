import { getCurrentUser } from '@/lib/auth';
import {
  billHandoverDb,
  canConfirmBillHandover,
  canRecordBillHandover,
  canViewBillHandovers,
  createBillHandover,
  listBillHandovers,
  accountsRoleState,
  cutoffState,
  ACCOUNTS_ROLE_NAME,
  BH_PENDING,
  BH_SUBMITTED,
  BH_RECEIVED,
  BH_VOID,
  type BillHandoverStatus,
} from '@/lib/bill-handover';

/**
 * BILL SUBMISSION QUALITY CHECK — the register (collection route)
 * ==============================================================
 *
 *   GET  /api/bill-submissions
 *        ?status=pending_submission|submitted|received|void|open|all
 *        &from=YYYY-MM-DD &to=YYYY-MM-DD &vendor= &q= &include_void=1
 *        &page= &pageSize=
 *        -> { rows, total, page, pageSize, cutoff, accounts_role, can }
 *
 *        The handover history the owner asked both the Store Manager and
 *        Accounts to be able to track. Every row carries the bill number,
 *        vendor, bill value, the store submission timestamp, the accounts
 *        confirmation timestamp and the current status.
 *
 *   POST /api/bill-submissions
 *        { grn_id? , bill_no?, vendor_id?, vendor_name?, bill_date?,
 *          received_date?, bill_value?, note?, submit_now?, confirm_duplicate? }
 *        -> { handover } | 4xx { error, ... }
 *
 *        grn_id present  = the normal path. Identity is read FROM the goods
 *                          receipt; the store person retypes nothing.
 *        grn_id absent   = the manual fallback for a bill with no purchase
 *                          behind it. Requires bill_no + vendor.
 *
 * ── THIS ROUTE GATES ITSELF ────────────────────────────────────────────────
 * src/proxy.ts guards PAGES, not APIs, and canAccessPage fails open four ways.
 * Worse, on the live database role_id is set on 0 of 9 users and page_access is
 * NULL on 8 of 9 — so page gating is effectively INERT today and the catalog is
 * no protection at all. The checks below are the entire boundary.
 *
 * ── CSRF ───────────────────────────────────────────────────────────────────
 * '/api/bill-submissions' is registered in CSRF_REQUIRED_PREFIXES (src/proxy.ts),
 * so every POST here needs the fnb_csrf cookie + x-csrf-token header. Clients
 * MUST use api()/apiJson() from @/lib/api, which inject it; a bare fetch() POST
 * will 403.
 *
 * PATH SAFETY (checked, not assumed): this path contains no "print" substring —
 * proxy.ts:125 makes ANY path containing '/print' publicly unauthenticated — and
 * ends in no file extension, which proxy.ts:141 would also make public.
 */
export const dynamic = 'force-dynamic';

const VALID_STATUS = new Set<string>([BH_PENDING, BH_SUBMITTED, BH_RECEIVED, BH_VOID, 'open', 'all']);

function s(v: unknown): string {
  return String(v ?? '').trim();
}

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canViewBillHandovers(me)) {
    return Response.json(
      { error: `Only the Store team or the ${ACCOUNTS_ROLE_NAME} team can view vendor bill submissions.` },
      { status: 403 },
    );
  }

  try {
    const db = billHandoverDb();
    const sp = new URL(request.url).searchParams;

    const rawStatus = s(sp.get('status')) || 'all';
    if (!VALID_STATUS.has(rawStatus)) {
      return Response.json({ error: 'Unknown status filter' }, { status: 400 });
    }

    const page = Math.max(1, parseInt(sp.get('page') || '1', 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(sp.get('pageSize') || '50', 10) || 50));

    const { rows, total, cutoff } = listBillHandovers(db, {
      status: rawStatus as BillHandoverStatus | 'all' | 'open',
      from: s(sp.get('from')) || undefined,
      to: s(sp.get('to')) || undefined,
      vendor: s(sp.get('vendor')) || undefined,
      q: s(sp.get('q')) || undefined,
      include_void: s(sp.get('include_void')) === '1',
      page,
      pageSize,
    });

    return Response.json({
      rows,
      total,
      page,
      pageSize,
      cutoff,
      // For the banner on the Accounts screen. Diagnosis only — never a gate.
      accounts_role: accountsRoleState(db),
      // So the screens render the right buttons instead of guessing at the rule.
      can: {
        record: canRecordBillHandover(me),
        confirm: canConfirmBillHandover(me),
      },
    });
  } catch (e) {
    console.error('GET /api/bill-submissions failed:', e);
    return Response.json({ error: 'Could not load the bill register.' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canRecordBillHandover(me)) {
    // The message names the real rule. "Manager or Admin" would misstate it:
    // a staff-tier storekeeper with is_store_manager passes, and an Accounts-role
    // holder is deliberately refused here so the two ends stay two jobs.
    return Response.json(
      {
        error:
          'Only Management or the Store Manager can record a vendor bill handover. The Accounts team confirms receipt; it does not record the handover.',
      },
      { status: 403 },
    );
  }

  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return Response.json({ error: 'Send a JSON body.' }, { status: 400 });
    }

    const db = billHandoverDb();
    const result = createBillHandover(
      db,
      {
        grn_id: s(body.grn_id),
        bill_no: s(body.bill_no),
        invoice_id: s(body.invoice_id),
        vendor_id: s(body.vendor_id),
        vendor_name: s(body.vendor_name),
        bill_date: s(body.bill_date),
        received_date: s(body.received_date),
        bill_value: body.bill_value === undefined ? 0 : Number(body.bill_value),
        outlet_id: body.outlet_id ? s(body.outlet_id) : null,
        note: s(body.note),
        submit_now: body.submit_now === true,
        confirm_duplicate: body.confirm_duplicate === true,
      },
      me,
    );

    if (!result.ok) {
      return Response.json(
        { error: result.error, ...(result.extra as object | undefined) },
        { status: result.status },
      );
    }
    return Response.json({ handover: result.value, cutoff: cutoffState(db) }, { status: 201 });
  } catch (e) {
    console.error('POST /api/bill-submissions failed:', e);
    return Response.json({ error: 'Could not record the bill handover.' }, { status: 500 });
  }
}
