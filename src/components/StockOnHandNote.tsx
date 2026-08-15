'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ THE ONLY RENDERER of the in-hand Store + Departments figure.             ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * CONTRACT §5. Three surfaces mount this — the PO composer's picker, the GRN
 * ad-hoc picker, and the "Stock when PO raised" column on /purchases. No
 * surface may format these figures itself: two hand-rolled copies is exactly
 * how the PO picker and the GRN picker would come to disagree about the same
 * material on the same afternoon.
 *
 * ── WHAT IT PROMISES ─────────────────────────────────────────────────────────
 *
 * 1. TWO FIGURES, NEVER ONE. Store and Dept are printed separately, always.
 *    A single merged "4 kg on hand" hides the fact that 3 kg of it is already
 *    in the kitchen, which is the whole question the buyer is asking.
 *
 * 2. PURCHASE UNITS, THROUGH THE SHARED LAYER. Every figure arrives in RECIPE
 *    units and is converted exactly once, here, by toPurchaseQty() — whose
 *    packFactor carries the both-halves guard (pack_size > 1 AND recipe unit
 *    != purchase unit). PICKLED GINGER 1.5KG (kg/kg, pack 1.5, stock 6) must
 *    render 6 kg, never 4. The pack rule is NEVER re-derived in this file.
 *    Conversion uses the pack meta the SERVER sent with the figure, not a
 *    catalogue row, so a snapshot cannot be restated by a later pack edit.
 *
 * 3. AN ABSENT FIGURE NEVER RENDERS A NUMERAL. There is no `?? 0` in this file
 *    and there must never be one. Four distinct not-a-number states, each
 *    visually distinct from a real zero:
 *        unavailable    — we could not read the figure at all
 *        not counted    — no department has ever anchored a count
 *        restricted     — this viewer may not see the department rail
 *        not recorded   — ('cell') the PO predates the snapshot record
 *    A recorded zero ALWAYS carries its unit ("0 kg") and normal weight, so it
 *    can never be confused with any of the above at any font size.
 */

import { toPurchaseQty, fmtQtyNum } from '@/lib/pack-units';
import { fmtIST } from '@/lib/format-date';
import type { StockOnHand, StockLeg, DeptScope } from '@/lib/use-stock-on-hand';

export type { StockOnHand, StockLeg, DeptScope };

/** How many department legs are spelled out before "+N more". */
const MAX_LEGS = 3;
/** Legs must reconcile to their own total within this many recipe units. */
const RECONCILE_EPS = 1e-6;

const GREY = 'text-[#B8A590]';
const MUTED = 'text-[#8B7355]';

/* ── unit-safe formatting ──────────────────────────────────────────────────
 * Every quantity string this file prints is built by qtyText(), on a line that
 * carries BOTH the shared converter and the purchase-unit label. Nothing below
 * interpolates a raw quantity, so no render site can accidentally lead in
 * grams. */

/** The purchase-unit label. Falls back to the recipe unit exactly as
 *  packFactor's own guard does — when there is no purchase unit, the recipe
 *  unit IS the purchase unit and no conversion happens. */
const puOf = (d: StockOnHand): string => String(d.purchase_unit || d.unit || '').trim();

/** "6 kg" — a recipe quantity rendered in the PURCHASE basis, with its unit. */
const qtyText = (recipeQty: number, d: StockOnHand): string =>
  `${fmtQtyNum(toPurchaseQty(recipeQty, d))} ${puOf(d)}`.trim();

/** "Akan Main Kitchen 3 kg" / "Old Bakery 2 kg (inactive)". */
const legText = (l: StockLeg, d: StockOnHand): string =>
  `${l.name || 'unnamed'} ${qtyText(l.qty, d)}${l.inactive ? ' (inactive)' : ''}`;

const sum = (legs: StockLeg[]) => legs.reduce((a, l) => a + (Number(l.qty) || 0), 0);

/**
 * Store legs for display, or null when they cannot be shown honestly.
 *
 * The wire carries grocery as the scalar `central_qty` and the other locations
 * as `stores`, so the grocery leg is synthesised here — unless the server
 * already sent one (the snapshot's stores_json does include it), in which case
 * it is used as-is and nothing is added twice.
 *
 * Returns null when the legs do not add up to store_total_qty. A breakdown that
 * disagrees with its own total reads as a stock discrepancy that does not
 * exist; the total alone is the honest render.
 */
function storeLegs(d: StockOnHand): StockLeg[] | null {
  const hasGrocery = d.stores.some(l => l.id === null || /^grocery$/i.test(l.name));
  const legs: StockLeg[] = hasGrocery
    ? [...d.stores]
    : [{ id: null, name: 'Grocery', qty: d.central_qty }, ...d.stores];
  if (Math.abs(sum(legs) - d.store_total_qty) > RECONCILE_EPS) return null;
  // Grocery first, then the biggest holdings.
  legs.sort((a, b) => (a.id === null ? -1 : b.id === null ? 1 : b.qty - a.qty));
  return legs;
}

/** Department legs, or null when they do not reconcile to dept_counted_qty. */
function deptLegs(d: StockOnHand): StockLeg[] | null {
  if (d.dept_counted_qty === null || d.depts.length === 0) return null;
  if (Math.abs(sum(d.depts) - d.dept_counted_qty) > RECONCILE_EPS) return null;
  return [...d.depts].sort((a, b) => b.qty - a.qty);
}

/** "Grocery 6 kg · LIQUOR STORE 0 kg" — every leg, for a tooltip. */
const allLegsText = (legs: StockLeg[] | null, d: StockOnHand): string =>
  legs ? legs.map(l => legText(l, d)).join(' · ') : '';

/** "Grocery 6 kg · Bar 2 kg · +2 more" — the first few, for the screen. */
function someLegsText(legs: StockLeg[] | null, d: StockOnHand, max: number): string {
  if (!legs) return '';
  const shown = legs.filter(l => l.qty !== 0).slice(0, max);
  if (shown.length === 0) return '';
  const rest = legs.filter(l => l.qty !== 0).length - shown.length;
  return shown.map(l => legText(l, d)).join(' · ') + (rest > 0 ? ` · +${rest} more` : '');
}

/* ── the department rail's four possible states ───────────────────────────── */

type DeptState =
  | { kind: 'restricted' }
  | { kind: 'uncounted' }
  | { kind: 'counted'; qty: number; marks: string };

/**
 * `marks` carries BOTH markers when both apply. Dropping one to keep the line
 * tidy would silently un-say a caveat the number depends on.
 *   *  some departments have never been counted → the total is not everything
 *   †  the viewer can only see some departments → the total is not everything
 */
function deptState(d: StockOnHand, scope: DeptScope): DeptState {
  if (scope === 'none') return { kind: 'restricted' };
  // ORDER MATTERS, AND THIS IS THE BUG THAT WAS HERE. 'uncounted' was tested
  // before the partial-scope case, so a viewer who can see 1 of 19 departments
  // was told "no department has ever recorded a count for this material" while
  // 88 kg sat in a department hidden from them — and the marker meaning "you
  // cannot see everything" could never attach, because this branch returned
  // first. The sentence read as a fact about the MATERIAL when it was only a
  // fact about the VIEWER, and it causes over-ordering. A restricted viewer
  // with no visible count now gets 'restricted', which says the truth.
  if (d.dept_counted_qty === null || d.dept_counted_count === 0) {
    return scope === 'partial' ? { kind: 'restricted' } : { kind: 'uncounted' };
  }
  const marks = (d.dept_uncounted_count > 0 ? '*' : '') + (scope === 'partial' ? '†' : '');
  return { kind: 'counted', qty: d.dept_counted_qty, marks };
}

/** "18 of 19 departments never counted" — null when every one is counted. */
function uncountedNote(d: StockOnHand): string | null {
  if (d.dept_uncounted_count <= 0) return null;
  const total = d.dept_counted_count + d.dept_uncounted_count;
  return `${d.dept_uncounted_count} of ${total} department${total === 1 ? '' : 's'} never counted`;
}

/** "only the 3 departments you can see" — the honest form when we lack a count. */
const partialNote = (visible: number): string =>
  visible > 0
    ? `only the ${visible} department${visible === 1 ? '' : 's'} you can see`
    : 'only the departments you can see';

/* USE THE REPO'S PARSER, NEVER new Date() ON A DB STRING.
 *
 * The snapshot's taken_at is written by SQLite datetime('now'):
 * "2026-08-14 16:37:36" — UTC, space-separated, NO zone. V8 parses that shape
 * as LOCAL time, so this used to render an instant 5h30m adrift and could name
 * the wrong DAY: a true 15 Aug 01:00 IST (19:30 UTC) printed as 14 Aug. An
 * audit record whose own "when" is wrong is not an audit record.
 *
 * fmtIST() wraps parseDb(), which normalises exactly this shape by appending
 * the missing Z before parsing, then formats in Asia/Kolkata. It already
 * existed and was simply bypassed here by a hand-rolled formatter. */
const stamp = (iso?: string | null): string => (iso ? fmtIST(iso) : '');

/* ── the legend, pinned inside a picker dropdown ──────────────────────────── */

/**
 * CONTRACT §5.1. Always rendered wherever the `row` variant is listed, so the
 * two markers are never a mystery. Kept in this file for the same reason as the
 * renderer: one definition, no drift.
 */
export function StockOnHandLegend({ className = '' }: { className?: string }) {
  return (
    <div className={`text-[9px] ${GREY} leading-snug ${className}`}>
      Store = grocery + store locations · Dept = stock issued to departments
      {' · '}* some departments never counted · † only departments you can see
    </div>
  );
}

/* ── the renderer ─────────────────────────────────────────────────────────── */

export default function StockOnHandNote({
  data,
  variant,
  deptScope = 'all',
  visibleDepts = 0,
  asOf,
  poNumber,
  loading = false,
  className = '',
}: {
  /** undefined = we do not have this material's figure. NOT zero. */
  data?: StockOnHand | null;
  variant: 'row' | 'line' | 'cell';
  deptScope?: DeptScope;
  /** dept_scope.visible, for the 'partial' wording. 0 = the server did not say. */
  visibleDepts?: number;
  /** 'cell' only — when the snapshot was taken. */
  asOf?: string | null;
  /** 'cell' only — the PO the snapshot belongs to, for the tooltip. */
  poNumber?: string | null;
  /** The fetch is still in flight. Renders "checking…", never a figure. */
  loading?: boolean;
  className?: string;
}) {
  /* ── no figure ─────────────────────────────────────────────────────────── */
  if (!data) {
    if (variant === 'cell') {
      // NO FIGURE. Grey ITALIC and wordy, so it can never be mistaken for a
      // quantity at any column width.
      //
      // THE TOOLTIP MUST NOT EXPLAIN WHY. It used to assert "this PO was raised
      // before stock was recorded on purchase orders" — a confident claim about
      // the past that was false for 100% of rows, including POs raised minutes
      // earlier WITH snapshot rows sitting on disk. There are several reasons a
      // figure can be absent (the PO predates the feature, the line came in by a
      // path that does not snapshot, or the row simply is not joined here) and
      // this component cannot tell them apart. So it now says only what it
      // actually knows: there is no record. A blank that admits ignorance beats
      // a sentence that invents a cause.
      return (
        <span className={`text-[11px] italic ${GREY} ${className}`}
              title="No stock figure was recorded for this line.">
          not recorded
        </span>
      );
    }
    if (variant === 'row') {
      return (
        <span className={`text-[9px] italic ${GREY} ${className}`}>
          in hand — {loading ? 'checking…' : 'unavailable'}
        </span>
      );
    }
    return (
      <div className={`text-[10px] italic ${GREY} ${className}`}>
        In hand now — {loading ? 'checking…' : 'unavailable, reopen to retry'}
      </div>
    );
  }

  const dept = deptState(data, deptScope);
  const sLegs = storeLegs(data);
  const dLegs = deptLegs(data);
  const uncounted = uncountedNote(data);

  // Built once, used by every variant, so the three can never word the same
  // figure differently.
  const storeFigure = `Store ${qtyText(data.store_total_qty, data)}`;
  const deptFigure =
    dept.kind === 'restricted' ? 'Dept restricted'
    : dept.kind === 'uncounted' ? 'Dept not counted'
    : `Dept ${qtyText(dept.qty, data)}${dept.marks}`;

  const fullTitle = [
    storeFigure,
    allLegsText(sLegs, data),
    deptFigure,
    dept.kind === 'counted' ? allLegsText(dLegs, data) : '',
    dept.kind === 'counted' ? uncounted || '' : '',
    dept.kind === 'counted' && deptScope === 'partial' ? partialNote(visibleDepts) : '',
    dept.kind === 'restricted' ? 'You do not have access to department stock.' : '',
    dept.kind === 'uncounted' ? 'No department has ever recorded a count for this material.' : '',
  ].filter(Boolean).join(' · ');

  /* ── row — one line inside a picker dropdown ───────────────────────────── */
  if (variant === 'row') {
    const soft = dept.kind !== 'counted';
    return (
      <span className={`text-[9px] ${MUTED} ${className}`} title={fullTitle}>
        in hand — {storeFigure}
        {' · '}
        <span className={soft ? `italic ${GREY}` : ''}>{deptFigure}</span>
      </span>
    );
  }

  /* ── cell — the /purchases snapshot column ─────────────────────────────── */
  if (variant === 'cell') {
    const when = stamp(asOf);
    const title = [
      when ? `Recorded ${when}${poNumber ? ` when ${poNumber} was raised` : ''}` : '',
      fullTitle,
    ].filter(Boolean).join(' · ');
    return (
      <span className={`text-[11px] leading-tight block ${className}`} title={title}>
        <span className="block text-[#2D1B0E]">{storeFigure}</span>
        <span className={`block ${dept.kind === 'counted' ? 'text-[#2D1B0E]' : `italic ${GREY}`}`}>
          {deptFigure}
        </span>
      </span>
    );
  }

  /* ── line — under the picked material, where the decision is made ──────── */
  const storeBreak = someLegsText(sLegs, data, MAX_LEGS);
  const deptBreak = dept.kind === 'counted' ? someLegsText(dLegs, data, MAX_LEGS) : '';
  const deptTail = [
    deptBreak,
    dept.kind === 'counted' && uncounted ? uncounted : '',
    dept.kind === 'counted' && deptScope === 'partial' ? partialNote(visibleDepts) : '',
  ].filter(Boolean).join(' · ');

  return (
    <div className={`text-[10px] ${MUTED} leading-snug ${className}`} title={fullTitle}>
      <div>
        In hand now · <b className="font-semibold text-[#2D1B0E]">{storeFigure}</b>
        {storeBreak && <span className={GREY}> — {storeBreak}</span>}
      </div>
      <div>
        {dept.kind === 'counted' ? (
          <>
            In hand now · <b className="font-semibold text-[#2D1B0E]">{deptFigure}</b>
            {deptTail && <span className={GREY}> — {deptTail}</span>}
          </>
        ) : (
          <span className={`italic ${GREY}`}>
            In hand now · Dept — {dept.kind === 'restricted'
              ? 'restricted'
              : 'not counted in any department yet'}
          </span>
        )}
      </div>
    </div>
  );
}
