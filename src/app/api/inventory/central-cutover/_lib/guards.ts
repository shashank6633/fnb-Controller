import { getCurrentUser, isManagement, type SessionUser } from '@/lib/auth';
import {
  CutoverError,
  type CutoverErrorCode,
  type CutoverSheetRow,
  type CutoverPreview,
  type CutoverLine,
} from '@/lib/central-cutover';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ Access, blind-count stripping and error mapping for the cutover routes.  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Private `_lib` of the central-cutover route family. One copy of each rule so
 * seven routes cannot drift apart on who may see the book figure.
 *
 * ── THREE GATES, NOT ONE ───────────────────────────────────────────────────
 *  READ the sheet   — any signed-in user. They are the ones walking the store,
 *                     and what they get is blind: no book quantity, no rupees.
 *                     The material master itself is already readable by every
 *                     signed-in user through /api/inventory.
 *  STAGE a count    — admin, store manager, or management (manager / HOD).
 *                     Matches api/inventory/round-trip-import (admin OR
 *                     is_store_manager) widened by isManagement, which is the
 *                     helper this repo already uses for management-only
 *                     inventory surfaces. Staging writes nothing to stock.
 *  COMMIT           — ADMIN ONLY, and it is the only gate that matters: the
 *                     commit is the write that re-bases the book.
 *
 * ── BLIND COUNTS ARE A HARD REQUIREMENT HERE, NOT A PREFERENCE ─────────────
 * api/closing-stock/by-location:105-110 and api/closing-stock/route.ts:98-102
 * strip system stock and variance server-side for non-admins so the expected
 * number never reaches the browser. A cutover is the one count where confirming
 * the book instead of counting the shelf would bake six months of drift in
 * permanently, so the same strip is applied to every payload here. The rupee
 * columns go with it: they are cost data, gated the same way on the closing
 * surfaces, and they are derived from the book figure anyway.
 */

export type Access = {
  user: SessionUser;
  isAdmin: boolean;
  /** May open a draft, stage counts, upload a sheet, remove a line, cancel. */
  canStage: boolean;
};

type Denied = { error: Response };

function deny(message: string, status: number): Denied {
  return { error: Response.json({ error: message }, { status }) };
}

/** Any signed-in user. Payloads are blind unless access.isAdmin. */
export async function requireUser(): Promise<Access | Denied> {
  const user = await getCurrentUser();
  if (!user) return deny('Sign in required', 401);
  const isAdmin = user.role === 'admin';
  return { user, isAdmin, canStage: isAdmin || !!user.is_store_manager || isManagement(user) };
}

/** Admin, store manager or management. */
export async function requireStager(): Promise<Access | Denied> {
  const a = await requireUser();
  if ('error' in a) return a;
  if (!a.canStage) return deny('Admin, store manager or management only', 403);
  return a;
}

/** Admin only — the commit, and every surface that shows a variance. */
export async function requireAdmin(): Promise<Access | Denied> {
  const a = await requireUser();
  if ('error' in a) return a;
  if (!a.isAdmin) return deny('Admin only', 403);
  return a;
}

export function denied(a: Access | Denied): a is Denied {
  return 'error' in a;
}

/** Who to record as the actor on a batch/line. Email is stable; name is not. */
export function actorOf(a: Access): string {
  return a.user.email || a.user.name || a.user.id;
}

// ── blind-count stripping ───────────────────────────────────────────────────

/** Sheet rows for a non-admin: the book quantity and both rupee figures go.
 *  Nulled rather than deleted so the client renders a dash in a stable column
 *  instead of an undefined that silently reads as 0. */
export function blindSheetRow(r: CutoverSheetRow, isAdmin: boolean): CutoverSheetRow | Record<string, unknown> {
  if (isAdmin) return r;
  return { ...r, book_qty: null, book_qty_purchase: null, book_value: null, unit_value: null };
}

/**
 * Preview for a non-admin: everything derived from the book goes, including
 * `will_alert` — knowing a line WILL raise a variance is knowing the count does
 * not match, which is the number the blind count exists to hide. The
 * operational flags (blocked / moved / pack changed) stay: they say re-count
 * this one, not what to write.
 */
export function blindPreview(p: CutoverPreview, isAdmin: boolean): CutoverPreview | Record<string, unknown> {
  if (isAdmin) return p;
  return {
    ...p,
    lines: p.lines.map((l) => ({
      ...l,
      book_qty_recipe: null,
      book_qty_purchase: null,
      variance_recipe: null,
      variance_purchase: null,
      unit_value: null,
      variance_value: null,
      will_alert: null,
    })),
    summary: {
      counted_lines: p.summary.counted_lines,
      zero_counts: p.summary.zero_counts,
      uncounted_materials: p.summary.uncounted_materials,
      blocked_lines: p.summary.blocked_lines,
      variance_lines: null,
      net_variance_value: null,
      shortage_value: null,
      excess_value: null,
      no_rate_lines: null,
    },
  };
}

/** A recorded line for a non-admin. Same rule, applied to history. */
export function blindLine(l: CutoverLine, isAdmin: boolean): CutoverLine | Record<string, unknown> {
  if (isAdmin) return l;
  return {
    ...l,
    book_qty_at_stage: null,
    book_qty_recipe: null,
    variance_recipe: null,
    unit_value: null,
    variance_value: null,
    alert: null,
  };
}

/** Batch totals for a non-admin: the counts stay, the rupees go. */
export function blindBatch<T extends {
  variance_lines: number; net_variance_value: number; shortage_value: number; excess_value: number;
}>(b: T, isAdmin: boolean): T | Record<string, unknown> {
  if (isAdmin) return b;
  return { ...b, variance_lines: null, net_variance_value: null, shortage_value: null, excess_value: null };
}

// ── errors ──────────────────────────────────────────────────────────────────

/** CutoverErrorCode -> HTTP status. 409 = "the world moved, look again";
 *  400 = "this request is wrong"; 404 = "no such batch". */
const STATUS: Record<CutoverErrorCode, number> = {
  UNKNOWN_BATCH: 404,
  NOT_DRAFT: 409,
  MOVED_SINCE_COUNT: 409,
  PACK_FACTOR_CHANGED: 409,
  STORE_MAPPED_MATERIAL: 400,
  UNKNOWN_MATERIAL: 400,
  FUTURE_DATE: 400,
  CUTOVER_BEFORE_STAMP: 400,
  NO_LINES: 400,
  WRITE_FAILED: 500,
};

/**
 * Turn any throw into a response. A CutoverError keeps its code AND its
 * `details` — MOVED_SINCE_COUNT carries the offending materials with their
 * staged_at, book-at-stage and book-now, and that payload is the entire
 * difference between a refusal the operator can act on and one they cannot.
 * Anything else is a 500 with the message, logged with the route tag.
 */
export function cutoverError(tag: string, e: unknown): Response {
  if (e instanceof CutoverError) {
    return Response.json(
      { error: e.message, code: e.code, details: e.details ?? null },
      { status: STATUS[e.code] ?? 400 },
    );
  }
  console.error('[' + tag + ']', e);
  const msg = e instanceof Error ? e.message : 'Unexpected error';
  return Response.json({ error: msg }, { status: 500 });
}

// ── the on-screen copy ──────────────────────────────────────────────────────

/**
 * Consequences the screen must state, served from the API so the page, the
 * preview and the confirmation dialog cannot drift apart on what they promise.
 * The same idea as /api/variance-report's self-describing `report` object.
 *
 * Every line is a real consequence of how the commit works, not decoration.
 * Do not trim this list on a redesign — each entry exists because leaving it
 * out makes a true behaviour look like a bug (or worse, hides a hazard).
 */
export function cutoverNotices(storeExcludedReason: string): Array<{ id: string; text: string }> {
  return [
    { id: 'liquor', text: storeExcludedReason },
    {
      id: 'no_ledger_row',
      text: 'Central stock will jump with NO inventory transaction behind it. That is deliberate: a negative '
        + 'adjustment row is not report-neutral — the top-consumed chart, the consumption-frequency ranking and '
        + 'the idle-capital list all count any negative row as consumption, so writing one would push this '
        + 'correction into reports it must never reach. The cutover lines on this page ARE the ledger and the '
        + 'only record of why the number moved.',
    },
    {
      id: 'information_only',
      text: 'The rupee figures here are INFORMATION ONLY. This is not a gain or a loss — it is months of missing '
        + 'paperwork written off in one stroke. Nothing here enters consumption, P&L, or any variance or loss '
        + 'report, and no purchase row is created. Average price and last purchase price are not touched.',
    },
    {
      id: 'unit_audit_first',
      text: 'RUNBOOK ORDER: finish Unit Audit BEFORE counting. Changing a pack size rescales current stock, so a '
        + 'unit correction made after a cutover multiplies the counted figure. The commit refuses any line whose '
        + 'pack size changed while it was staged, but it cannot defend a change made afterwards.',
    },
    {
      id: 'backup',
      text: 'Take a file backup before committing (scripts/backup-db.sh). Current stock has no history of its own '
        + 'and cannot be reconstructed from the transaction table on this data — the cutover lines are the only '
        + 'record of the pre-cutover book.',
    },
    {
      id: 'single_pool',
      text: 'This re-bases the single global central pool, building-wide. Central stock has no outlet dimension, so '
        + 'this is not a per-outlet cutover no matter which outlet you are signed in to.',
    },
    {
      id: 'dept_sheet_shift',
      text: 'Department closing-sheet variance figures WILL shift the moment this commits, because that sheet '
        + 'compares a department count against central stock. That is a consequence of the correction, not a bug '
        + 'to chase.',
    },
    {
      id: 'sub_recipes',
      text: 'Sub-recipes (semi-finished) are out of scope by construction, not by choice: the app keeps no running '
        + 'balance for them, so there is nothing to re-base.',
    },
  ];
}
