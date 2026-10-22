import type Database from 'better-sqlite3';
import { getDb, logAuditEvent } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { postDeptLedger, deptOnHand, deptSendableFor, cutoverAt } from '@/lib/dept-ledger';
import { isStoreMappedMaterial } from '@/lib/store-engine';
import { packFactor } from '@/lib/pack-units';

/**
 * THE CUTOVER — the ONLY way an `opening` balance is ever created.
 *
 *   GET  /api/department-ledger/cutover   → per-department checklist   (signed in)
 *   POST /api/department-ledger/cutover   → write the opening rows     (admin)
 *
 * ── WHY THIS IS A ROUTE AND NOT A MIGRATION ────────────────────────────────
 * Department balances start from a PHYSICAL COUNT taken on a chosen day, not
 * from anything a deploy can compute. Decision D says there is no backfill: the
 * 14,149 historic issued lines get no department movements, so the rail has no
 * starting balance until a human counts the shelves and records it here. A boot
 * migration that invented one would be writing admin-owned state on deploy,
 * which is exactly what scripts/check-boot-migrations.js exists to stop. Do not
 * "helpfully" seed openings in db.ts — the gate will fail and, worse, the
 * numbers would be fiction.
 *
 * ── WHAT AN OPENING ROW MEANS ──────────────────────────────────────────────
 * type='opening', quantity = the counted quantity in RECIPE units,
 * reference_id = 'cutover:<YYYY-MM-DD>', source='cutover'. deptOnHand() picks
 * it as the ANCHOR, and every movement after it sums on top. It supersedes
 * everything before it — which is the whole point of a physical count, and the
 * reason this route does not care what the ledger did beforehand in `lines`
 * mode (see the adopt-mode exception below, which is a different question).
 *
 * ── TWO MODES ──────────────────────────────────────────────────────────────
 *   lines  — the admin submits {material_id, quantity, unit} rows. The count
 *            was taken NOW, so the opening row is stamped now and supersedes
 *            any earlier movement.
 *   adopt  — the department already recorded a closing count for that date via
 *            /api/closing-stock; this materialises it as opening rows so the
 *            rail has an explicit, auditable start and the checklist below can
 *            report the department as cut over.
 *
 * ── THE ADOPT TRAP (do not remove the refusal) ─────────────────────────────
 * A closing count anchors at the moment it was TAKEN. An opening row anchors at
 * the moment it is WRITTEN. Adopting a three-day-old count therefore moves the
 * anchor forward by three days while keeping the older quantity, and every
 * issue and consumption in between silently drops out of the balance. So adopt
 * refuses any pair that has moved since its count and names the count. The fix
 * is a fresh count, not a looser guard. The trap is measured from the count
 * being ADOPTED, and refuses outright when a NEWER count exists for the pair
 * (COUNT_NOT_CURRENT) — see adoptTrap() for what windowing from the current
 * anchor instead let through. It also refuses (MOVED_SINCE_COUNT) when the
 * opening would leave the balance alone but RAISE the transfer send figure: a
 * count older than the cutover floor with an outflow hidden behind the floor
 * (adoptTrap, floor_hidden).
 *
 * ── IDEMPOTENT, BY REFUSING ────────────────────────────────────────────────
 * One opening row per (department, material), ever. A second attempt is
 * answered 409 with the existing rows NAMED — never a second row. Two opening
 * rows would make "the anchor" a question of which one sorted last, and the
 * older one would sit in the audit looking like a correction nobody made.
 *
 * ── LIQUOR IS REFUSED, NOT SKIPPED ─────────────────────────────────────────
 * Store-mapped materials live on the TGBCL rail (store_stock_ledger /
 * store_locations) and are carved out of BOTH legs of the department rail. A
 * liquor line in a department cutover is a mistake upstream, so it fails the
 * whole request loudly. A silent skip is what a future engineer will reach for;
 * it would leave the admin believing the bar was cut over when nothing of the
 * sort happened.
 *
 * ── THE STAMP ──────────────────────────────────────────────────────────────
 * settings.dept_ledger_cutover_at is written ONCE, on the first successful run,
 * from the first opening row's own timestamp. It is the hard floor on every
 * balance window (dept-ledger.cutoverAt) and the date every "history excluded"
 * label reads. Later departments cut over later and simply anchor later; the
 * floor never moves again. Re-stamping it would retroactively delete movement
 * from every department that went first.
 */

export const dynamic = 'force-dynamic';

/* ── shared numeric conventions (identical to dept-ledger.ts) ────────────── */
const EPS = 1e-9;
const r6 = (n: number) => Math.round((Number(n) || 0) * 1e6) / 1e6;
const fmt = (n: number) => {
  const v = r6(n);
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
};

type Db = Database.Database;

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

/** A RECIPE-unit quantity for a message, LEADING with the purchase unit when
 *  the material converts (owner rule; packFactor carries the both-halves
 *  guard): "0.5 BTL (= 375 ml)", or "2 kg" when there is nothing to convert. */
function qtyLabel(m: { unit: string; purchase_unit: string | null; pack_size: number | null } | undefined, recipeQty: number): string {
  if (!m) return fmt(recipeQty);
  const pf = packFactor(m);
  return pf > 1
    ? `${fmt(recipeQty / pf)} ${m.purchase_unit} (= ${fmt(recipeQty)} ${m.unit})`
    : `${fmt(recipeQty)} ${m.unit}`;
}

/** Defensive: this route reads three tables that arrived with the cutover. A
 *  503 that says "run the migration" beats a 500 stack trace on the one screen
 *  an owner reaches for at 1am on cutover night. */
function tableExists(db: Db, name: string): boolean {
  try {
    return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(name);
  } catch { return false; }
}

/** IST calendar day — the house convention (sales-reports.ts). A cutover typed
 *  at 11pm belongs to tonight's business date, not tomorrow's UTC one. */
function istToday(db: Db): string {
  try {
    return String((db.prepare(`SELECT date('now', '+330 minutes') AS d`).get() as { d: string }).d);
  } catch { return new Date().toISOString().slice(0, 10); }
}

/** The date an existing opening row was cut over for. reference_id is the
 *  authority ('cutover:<date>' is what this route writes); event_date and the
 *  row timestamp are fallbacks for a row written by an older shape. */
function openingDate(row: { reference_id?: string | null; event_date?: string | null; created_at?: string | null }): string {
  const m = /^cutover:(\d{4}-\d{2}-\d{2})$/.exec(String(row.reference_id ?? '').trim());
  if (m) return m[1];
  const ev = String(row.event_date ?? '').trim().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(ev)) return ev;
  return String(row.created_at ?? '').trim().slice(0, 10);
}

/**
 * Timestamp normaliser IN SQL, byte-compatible with dept-ledger.ts's
 * LEDGER_TS_SQL. Kept as a literal rather than imported because dept-ledger
 * does not export it; if that file's normalisation ever changes, this changes
 * with it. 19 chars, 'T' → ' '. Comparing a raw ISO stamp against a raw ledger
 * stamp is the trap: 'T' (0x54) > ' ' (0x20) shifts a whole day of movement.
 */
const LEDGER_TS_SQL = `REPLACE(SUBSTR(created_at, 1, 19), 'T', ' ')`;

/**
 * WHERE A CLOSING COUNT ANCHORS — a literal mirror of dept-ledger.ts's
 * countAnchorAt() (not exported), for the same reason LEDGER_TS_SQL is one:
 * MIN(IST day-end of the count date, when the count was saved), 19 chars.
 * It is never trusted alone: adoptTrap() cross-checks the result against
 * deptOnHand() and refuses on any disagreement, so if the two ever drift the
 * adopt fails CLOSED instead of writing an opening.
 */
function countAnchorAt(date: string, createdAt: string): string {
  const dayEnd = `${String(date || '').slice(0, 10)} 18:29:59`;
  const saved = countSavedAt(createdAt);
  return saved && saved < dayEnd ? saved : dayEnd;
}

/** When a closing count was SAVED, in the ledger's 19-char UTC basis ('' when
 *  the row carries no time). countAnchorAt's own normalisation, split out so
 *  a refusal can say when the count was typed as well as where it stands. */
function countSavedAt(createdAt: string): string {
  const s = String(createdAt ?? '').trim();
  return !s ? '' : /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s} 00:00:00` : s.slice(0, 19).replace('T', ' ');
}

/** A ledger time (19-char UTC) for a message, in the house's IST:
 *  '2026-10-13 19:30:00' → '01:00 IST on 2026-10-14'. */
function istLabel(ts: string): string {
  const d = new Date(`${String(ts || '').replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return String(ts || '');
  const ist = new Date(d.getTime() + 330 * 60_000).toISOString();
  return `${ist.slice(11, 16)} IST on ${ist.slice(0, 10)}`;
}

/** One ledger movement inside a floor_hidden gap, for the refusal. */
interface GapRow { type: string; quantity: number; at: string }

/** A count being adopted: where it anchors (`at`, the ledger's count rule),
 *  its quantity, the date it is labelled for and when it was saved. */
interface AdoptedCount { at: string; qty: number; date: string; saved: string }

/** One adopt refusal. `newer_count` and `not_the_anchor` mean the count being
 *  adopted is not the one the balance stands on; `moved` means it is, but the
 *  pair has moved since it; `floor_hidden` means the balance is unchanged but
 *  the SEND figure would rise (see adoptTrap). floor_hidden splits its gap by
 *  the moment the count was SAVED, because the two halves are different
 *  physical stories and the refusal must tell the one that happened:
 *  booked_after_save went out after the count was typed (case W);
 *  booked_before_save was booked before the count was typed but after the day
 *  it is DATED had ended (case V10) — the count may already include it. */
type AdoptRefusal =
  | { kind: 'newer_count'; newest_count_date: string; newest_count_qty: number; newest_count_at: string }
  | { kind: 'not_the_anchor'; anchor_source: string; anchor_at: string | null; anchor_qty: number | null }
  | { kind: 'moved'; moved_rows: number }
  | {
      kind: 'floor_hidden'; moved_rows: number; hidden_outflow: number; send_figure_now: number; cutover_floor: string;
      count_date: string; count_saved_at: string;
      /** Up to GAP_ROWS_LISTED each; *_rows and *_net (signed, RECIPE units)
       *  are over the whole half. */
      booked_before_save: GapRow[]; booked_before_save_rows: number; booked_before_save_net: number;
      booked_after_save: GapRow[]; booked_after_save_rows: number; booked_after_save_net: number;
    };

/** How many gap rows a floor_hidden refusal carries per half (JSON). */
const GAP_ROWS_LISTED = 20;

/** The refusals the admin answers with a fresh count (MOVED_SINCE_COUNT), as
 *  opposed to adopting a different count date (COUNT_NOT_CURRENT). */
type MovedRefusal = Extract<AdoptRefusal, { kind: 'moved' | 'floor_hidden' }>;
const isMovedRefusal = (r: AdoptRefusal): r is MovedRefusal => r.kind === 'moved' || r.kind === 'floor_hidden';

/**
 * THE ADOPT TRAP, measured from the ADOPTED count — never from whatever count
 * currently anchors the pair.
 *
 * An opening row is stamped when it is WRITTEN (now) and carries the adopted
 * count's quantity. The balance is unchanged by that only if (a) the adopted
 * count IS the pair's anchor, and (b) nothing the balance counts has moved
 * since it. Each refusal below is one way an adopt silently rewrites a balance:
 *
 *   newer_count — a later count exists. The opening would re-assert the OLDER
 *     figure on top of it and drop every movement since the older count. When
 *     one of those movements is a transfer leg, its twin stays on the other
 *     department: measured before this check (scratchpad conserve-adopt,
 *     adopt-x.cjs) — receiver side 4 kg in no ledger (K 5 + T 1 from 10
 *     physical), sender side 4 kg in two (K 10 + M 4 from 10, after which the
 *     send check let 10 kg leave a 6 kg shelf). The old trap could not see it
 *     because it windowed from deptOnHand's CURRENT anchor — the newer count —
 *     and nothing had moved since THAT.
 *   not_the_anchor — the resolver the balance uses disagrees about which count
 *     anchors the pair (duplicate same-date rows, or drift between this file's
 *     countAnchorAt and dept-ledger's). Refused rather than guessed.
 *   moved — the adopted count anchors the pair, but the ledger moved after it.
 *     The window is the ledger's own rule ("A TRANSFER PAIR IS NEVER SPLIT",
 *     dept-ledger deptOnHand): every movement after MAX(count, cutover floor),
 *     and transfer legs after the count itself, never the floor. A movement
 *     that rule leaves out of the balance today stays out after the opening, so
 *     it cannot be dropped FROM THE BALANCE and is not counted here.
 *   floor_hidden — the balance is unchanged, but the SEND figure would rise.
 *     A count taken before the cutover floor (on cutover day, counted before
 *     the first department's cutover stamped it) has movement between the
 *     count and the floor that the balance hides. The send check does not:
 *     deptSendable is MIN(balance, count + every movement after it), so a
 *     wastage or staff meal booked in that gap holds the send figure down to
 *     what is really on the shelf. An opening is stamped NOW, after the floor,
 *     so that MIN disappears and the send figure jumps back to the count.
 *     Measured before this check (scratchpad adopt-r3, floor-hide.cjs W):
 *     Kitchen counted 6, wasted 2, floor stamped, count adopted: 200, send
 *     figure 4 → 6, then "ACCEPTED 6 kg from a 4 kg shelf". The 2 phantom kilos
 *     would land in the receiver's ledger. The check reads the send figure from
 *     the ledger's own deptSendableFor, so it cannot drift from the send check:
 *     with nothing moved (the check above), the opening makes that figure
 *     exactly the count, so the adopt is refused only when the figure is
 *     LOWER than the count today. A hidden RECEIPT never trips it: the figure
 *     is already capped at the count, and stays there (prod parity, D4/W2).
 *     THE SAME REFUSAL, A DIFFERENT STORY (case V10): a count typed at 01:00
 *     IST on the 14th but DATED the 13th stands at the 13th's day end (the
 *     count rule's MIN), so a KOT consumed at 00:30 IST — BEFORE the count was
 *     typed — sits in the gap too. The rule and the status are the same (the
 *     ledger cannot tell whether the counted figure already includes it), but
 *     "used after the count" would be false, so the refusal splits the gap by
 *     the count's SAVE time and the message tells each half as it happened.
 *
 * Run twice: while planning (so every refusal is answered in one list), and
 * again inside the IMMEDIATE write transaction, so nothing that posts between
 * the plan and the write can be swallowed by the opening.
 */
function adoptTrap(
  db: Db, departmentId: string, materialId: string,
  adopted: AdoptedCount,
): AdoptRefusal | null {
  const counts = db.prepare(`
    SELECT date, physical_stock, created_at FROM closing_stock
     WHERE department_id = ? AND material_id = ?
  `).all(departmentId, materialId) as Array<{ date: string; physical_stock: number; created_at: string }>;
  let newest: { date: string; qty: number; at: string } | null = null;
  for (const c of counts) {
    const at = countAnchorAt(c.date, c.created_at);
    if (at > adopted.at && (!newest || at >= newest.at)) newest = { date: String(c.date), qty: Number(c.physical_stock) || 0, at };
  }
  if (newest) return { kind: 'newer_count', newest_count_date: newest.date, newest_count_qty: r6(newest.qty), newest_count_at: newest.at };

  const bal = deptOnHand(db, departmentId, materialId);
  if (bal.anchorSource !== 'count' || bal.anchorAt !== adopted.at || r6(Number(bal.anchorQty)) !== r6(adopted.qty)) {
    return { kind: 'not_the_anchor', anchor_source: bal.anchorSource, anchor_at: bal.anchorAt, anchor_qty: bal.anchorQty };
  }

  const floor = cutoverAt(db);
  const windowFrom = floor && floor > adopted.at ? floor : adopted.at;
  const moved = db.prepare(`
    SELECT COUNT(*) AS n FROM department_material_transactions
     WHERE department_id = ? AND material_id = ? AND type <> 'opening'
       AND (${LEDGER_TS_SQL} > ?
            OR (type IN ('transfer_out', 'transfer_in') AND ${LEDGER_TS_SQL} > ?))
  `).get(departmentId, materialId, windowFrom, adopted.at) as { n: number } | undefined;
  const n = Number(moved?.n) || 0;
  if (n > 0) return { kind: 'moved', moved_rows: n };

  /* floor_hidden (see above). Nothing has moved, so the balance IS the count
   * and the opening would make the send figure exactly the count. */
  const send = deptSendableFor(db, departmentId, materialId);
  const qty = r6(adopted.qty);
  if (r6(send.available) < qty - EPS) {
    /* The same rows the send figure's MIN subtracts (sinceAnchorFigure: every
     * non-opening movement after the anchor), listed so the refusal can name
     * them. Split at the SAVE time — see the type's note: a row at or before
     * the save was booked before the count was typed (only possible when the
     * count is dated a day that had already ended, case V10). A count with no
     * saved time cannot be split; its rows are told as after the dated day. */
    const gap = db.prepare(`
      SELECT type, quantity, ${LEDGER_TS_SQL} AS at FROM department_material_transactions
       WHERE department_id = ? AND material_id = ? AND type <> 'opening' AND ${LEDGER_TS_SQL} > ?
       ORDER BY at, rowid
    `).all(departmentId, materialId, adopted.at) as Array<{ type: string; quantity: number; at: string }>;
    const rows: GapRow[] = gap.map(g => ({ type: String(g.type), quantity: r6(Number(g.quantity)), at: String(g.at) }));
    const before = adopted.saved ? rows.filter(g => g.at <= adopted.saved) : [];
    const after = adopted.saved ? rows.filter(g => g.at > adopted.saved) : rows;
    const net = (xs: GapRow[]) => r6(xs.reduce((s, g) => s + g.quantity, 0));
    return {
      kind: 'floor_hidden',
      moved_rows: rows.length,
      hidden_outflow: r6(qty - Number(send.available)),
      send_figure_now: r6(Number(send.available)),
      cutover_floor: floor,
      count_date: adopted.date,
      count_saved_at: adopted.saved,
      booked_before_save: before.slice(0, GAP_ROWS_LISTED),
      booked_before_save_rows: before.length,
      booked_before_save_net: net(before),
      booked_after_save: after.slice(0, GAP_ROWS_LISTED),
      booked_after_save_rows: after.length,
      booked_after_save_net: net(after),
    };
  }
  return null;
}

const signedQty = (m: Mat | undefined, q: number) => `${q < 0 ? '−' : '+'}${qtyLabel(m, Math.abs(q))}`;

/** A movement list for a message: "consumption −2 kg at 00:30 IST on
 *  2026-10-14", or at most three then "+N more (−3.75 kg in all)". */
function gapList(m: Mat | undefined, rows: GapRow[], total: number, totalNet: number): string {
  const shown = rows.slice(0, 3).map(g => `${g.type.replace(/_/g, ' ')} ${signedQty(m, g.quantity)} at ${istLabel(g.at)}`);
  const more = total > shown.length ? `, +${total - shown.length} more (${signedQty(m, totalNet)} in all)` : '';
  return `${shown.join(', ')}${more}`;
}
const wasWere = (n: number) => (n === 1 ? 'was' : 'were');

/**
 * What a floor_hidden refusal says about ONE material — physically true for
 * both stories (see AdoptRefusal). One sentence, no trailing full stop:
 *   datedLate — something in the gap was booked BEFORE the count was saved:
 *     the count is dated a day that had already ended when it was typed. Say
 *     so, with both times; the counted figure may already include it.
 *   otherwise — everything in the gap was booked after the count was saved
 *     and before the rail went live: it really did leave after the count.
 * `figures` (balance vs transfer check) are the two readings that disagree;
 * the balance is the count itself here, because nothing else has moved.
 */
function floorHiddenDetail(
  name: string, m: Mat | undefined,
  h: Extract<AdoptRefusal, { kind: 'floor_hidden' }>, countQty: number,
): { datedLate: boolean; savedKnown: boolean; body: string; text: string } {
  const figures = `balance ${qtyLabel(m, countQty)}, transfer check ${qtyLabel(m, h.send_figure_now)}`;
  const savedKnown = !!h.count_saved_at;
  const afterList = gapList(m, h.booked_after_save, h.booked_after_save_rows, h.booked_after_save_net);
  let datedLate = false;
  let body: string;
  if (h.booked_before_save_rows + h.booked_after_save_rows === 0) {
    /* Cannot happen while this listing and the send figure read the same rows
     * (both: every non-opening movement after the anchor). Kept so a future
     * drift between them still produces a sentence, not an empty list. */
    body = `the transfer check is ${qtyLabel(m, h.hidden_outflow)} below the count; ${figures}`;
  } else if (h.booked_before_save_rows > 0) {
    datedLate = true;
    const afterBit = h.booked_after_save_rows > 0
      ? `; ${afterList} ${wasWere(h.booked_after_save_rows)} booked after the save, before the department rail went live`
      : '';
    body =
      `the count is dated ${h.count_date} but was saved at ${istLabel(h.count_saved_at)}, and ` +
      `${gapList(m, h.booked_before_save, h.booked_before_save_rows, h.booked_before_save_net)} ` +
      `${wasWere(h.booked_before_save_rows)} booked after ${h.count_date} ended, before the count was saved` +
      `${afterBit}; ${figures}`;
  } else {
    body = `${afterList}; ${figures}`;
  }
  return { datedLate, savedKnown, body, text: `${name}: ${body}` };
}

/** Why a dated-late count is refused — the count rule (MIN of the dated day's
 *  end and the save), said for the case where the day end wins. Exact only
 *  for that case, which is the only one it is used for (datedLate ⇒ a row
 *  after the anchor and at or before the save ⇒ anchor = the day end). */
const DATED_LATE_WHY =
  'A count saved after the day it is dated has ended stands at the end of that day (23:59 IST), so the app reads ' +
  'anything booked between then and the save as after the count, and cannot tell whether the counted figure already includes it.';

/** Up to three material sentences, then "+N more the same way". */
function detailSentences(texts: string[]): string {
  const shown = texts.slice(0, 3);
  return shown.map(t => `${t}.`).join(' ') + (texts.length > shown.length ? ` +${texts.length - shown.length} more the same way.` : '');
}

/** Thrown inside the write transaction when the re-run trap refuses — rolls
 *  the whole cutover back; the route answers 409. */
class AdoptRaced extends Error {
  constructor(readonly materialId: string, readonly refusal: AdoptRefusal) {
    super(`adopt refused at write time for ${materialId}: ${refusal.kind}`);
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * GET — the runbook's checklist
 * ──────────────────────────────────────────────────────────────────────────*/

export async function GET() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const db = getDb();
    if (!tableExists(db, 'department_material_transactions')) {
      return Response.json(
        { error: 'The department ledger has not been created yet — restart the app so the migration runs' },
        { status: 503 },
      );
    }

    const stamp = cutoverAt(db) || null;

    const depts = db.prepare(`
      SELECT id, name, parent_id, COALESCE(is_active, 1) AS is_active
        FROM departments ORDER BY name
    `).all() as Array<{ id: string; name: string; parent_id: string | null; is_active: number }>;

    /* Openings already written, per department. */
    const openRows = db.prepare(`
      SELECT department_id, material_id, reference_id, event_date, created_at
        FROM department_material_transactions
       WHERE type = 'opening'
    `).all() as Array<{ department_id: string; material_id: string; reference_id: string | null; event_date: string | null; created_at: string }>;

    const openByDept = new Map<string, { materials: Set<string>; rows: number; dates: Set<string>; first: string; last: string }>();
    for (const r of openRows) {
      let e = openByDept.get(r.department_id);
      if (!e) { e = { materials: new Set(), rows: 0, dates: new Set(), first: r.created_at, last: r.created_at }; openByDept.set(r.department_id, e); }
      e.materials.add(r.material_id);
      e.rows += 1;
      e.dates.add(openingDate(r));
      if (r.created_at < e.first) e.first = r.created_at;
      if (r.created_at > e.last) e.last = r.created_at;
    }

    /* Work remaining: pairs this department has already MOVED or COUNTED that
     * still carry no opening row. This is what makes the checklist honest —
     * "3 opening rows written" means nothing next to "and 180 materials the
     * kitchen is already moving with no starting balance at all". */
    const awaiting = db.prepare(`
      SELECT x.department_id AS department_id, COUNT(*) AS n FROM (
        SELECT DISTINCT department_id, material_id
          FROM department_material_transactions WHERE type <> 'opening'
        UNION
        SELECT DISTINCT department_id, material_id
          FROM closing_stock WHERE TRIM(COALESCE(department_id, '')) <> ''
      ) x
      WHERE NOT EXISTS (
        SELECT 1 FROM department_material_transactions o
         WHERE o.type = 'opening' AND o.department_id = x.department_id AND o.material_id = x.material_id
      )
      GROUP BY x.department_id
    `).all() as Array<{ department_id: string; n: number }>;
    const awaitingByDept = new Map(awaiting.map(r => [r.department_id, Number(r.n) || 0]));

    /* The latest closing count per department — the date an `adopt` run would
     * quote, so the runbook does not have to go hunting for it. */
    const counts = db.prepare(`
      SELECT department_id, MAX(date) AS last_date, COUNT(DISTINCT material_id) AS materials
        FROM closing_stock
       WHERE TRIM(COALESCE(department_id, '')) <> ''
       GROUP BY department_id
    `).all() as Array<{ department_id: string; last_date: string; materials: number }>;
    const countByDept = new Map(counts.map(r => [r.department_id, r]));

    /* The cutover doc requires the variance-approval queue to be CLEAR before
     * the count is adopted: a pending approval is a count whose stock movement
     * has not happened yet, so cutting over on top of it bakes in a figure the
     * admin is still deciding about. Reported, not enforced — clearing the
     * queue is the admin's job, not this route's. */
    const pendingVa = tableExists(db, 'variance_approvals')
      ? db.prepare(`
          SELECT department_id, COUNT(*) AS n FROM variance_approvals
           WHERE status = 'pending' AND TRIM(COALESCE(department_id, '')) <> ''
           GROUP BY department_id
        `).all() as Array<{ department_id: string; n: number }>
      : [];
    const pendingByDept = new Map(pendingVa.map(r => [r.department_id, Number(r.n) || 0]));

    const departments = depts.map(d => {
      const open = openByDept.get(d.id);
      const openMaterials = open ? open.materials.size : 0;
      const left = awaitingByDept.get(d.id) || 0;
      const c = countByDept.get(d.id);
      return {
        id: d.id,
        name: d.name,
        parent_id: d.parent_id,
        is_active: !!Number(d.is_active),
        status: openMaterials === 0 ? 'not_started' : (left > 0 ? 'partial' : 'done'),
        opening_rows: open ? open.rows : 0,
        opening_materials: openMaterials,
        cutover_dates: open ? [...open.dates].sort() : [],
        first_opening_at: open ? open.first : null,
        last_opening_at: open ? open.last : null,
        /** Materials already moving or counted with NO opening row yet. */
        materials_awaiting_opening: left,
        last_closing_count_date: c?.last_date || null,
        closing_counted_materials: Number(c?.materials) || 0,
        pending_variance_approvals: pendingByDept.get(d.id) || 0,
      };
    });

    return Response.json({
      /** '' / null until the first successful POST. While it is null NO balance
       *  on any department screen is trustworthy, and those screens must say so
       *  rather than presenting a number built on no starting count. */
      cutover_at: stamp,
      started: !!stamp,
      today_ist: istToday(db),
      departments,
      totals: {
        departments: departments.length,
        done: departments.filter(d => d.status === 'done').length,
        partial: departments.filter(d => d.status === 'partial').length,
        not_started: departments.filter(d => d.status === 'not_started').length,
        materials_awaiting_opening: departments.reduce((s, d) => s + d.materials_awaiting_opening, 0),
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Failed';
    console.error('[department-ledger cutover GET]', e);
    return Response.json({ error: msg || 'Failed to load cutover status' }, { status: 500 });
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * POST — write the opening rows
 * ──────────────────────────────────────────────────────────────────────────*/

interface InLine { material_id?: string; quantity?: number | string; unit?: string | null; notes?: string }

interface Mat {
  id: string; name: string; category: string;
  unit: string; purchase_unit: string | null; pack_size: number | null; case_size: number | null;
}

interface Planned {
  material_id: string;
  name: string;
  /** What the admin typed, echoed back so the response is checkable. */
  entered_quantity: number;
  entered_unit: string;
  /** RECIPE units — what actually gets posted. */
  quantity: number;
  /** 'recipe' = 1:1, 'purchase' = multiplied by the pack factor. */
  basis: 'recipe' | 'purchase';
  pack_factor: number;
}

interface Refused { material_id: string; name: string; reason: string; detail: string }

export async function POST(request: Request) {
  try {
    /* ADMIN ONLY. An opening balance is the number every future department
     * variance is measured against — get it wrong and every kitchen's figures
     * are wrong for as long as it stands, with nothing on screen to say why.
     * Same reasoning as the station→department map: managers read, admin
     * writes. */
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (me.role !== 'admin') {
      return Response.json({ error: 'Admin role required to run the department cutover' }, { status: 403 });
    }

    const db = getDb();
    if (!tableExists(db, 'department_material_transactions')) {
      return Response.json(
        { error: 'The department ledger has not been created yet — restart the app so the migration runs' },
        { status: 503 },
      );
    }

    const body = await request.json().catch(() => ({} as Record<string, unknown>)) as Record<string, unknown>;
    const departmentId = String(body?.department_id ?? '').trim();
    const cutoverDate = String(body?.cutover_date ?? '').trim().slice(0, 10);
    const adopt = body?.adopt_count === true;
    const dryRun = body?.dry_run === true;
    const countSheetId = String(body?.count_sheet_id ?? '').trim();
    const freeNote = String(body?.notes ?? '').trim();
    const rawLines: InLine[] = Array.isArray(body?.lines) ? (body.lines as InLine[]) : [];

    if (!departmentId) return Response.json({ error: 'department_id required' }, { status: 400 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoverDate)) {
      return Response.json({ error: 'cutover_date required, as YYYY-MM-DD' }, { status: 400 });
    }
    /* A count cannot be taken tomorrow. Allowing a future date would let an
     * opening row be labelled for a day that has not happened while anchoring
     * at today — two different truths on one row. */
    const today = istToday(db);
    if (cutoverDate > today) {
      return Response.json(
        { error: `cutover_date ${cutoverDate} is in the future (today is ${today} IST) — a physical count cannot be dated ahead` },
        { status: 400 },
      );
    }

    if (adopt && rawLines.length > 0) {
      return Response.json(
        { error: 'Send either adopt_count (use the recorded closing count) or lines (type the quantities) — not both' },
        { status: 400 },
      );
    }
    if (!adopt && rawLines.length === 0) {
      return Response.json({ error: 'No lines to open — send lines[] or adopt_count: true' }, { status: 400 });
    }

    const dept = db.prepare(
      `SELECT id, name, COALESCE(is_active, 1) AS is_active FROM departments WHERE id = ?`,
    ).get(departmentId) as { id: string; name: string; is_active: number } | undefined;
    if (!dept) return Response.json({ error: 'Unknown department' }, { status: 404 });

    /* Resolved HERE, before the first ledger read, so nothing between the
     * checks below and the write transaction awaits. An await in that gap
     * (it used to sit just before the write) lets another request post a
     * movement after the adopt trap passed and before the opening lands — and
     * the opening, stamped later, would then swallow it. */
    const outletId = await getCurrentOutletId();

    const warnings: string[] = [];
    if (!Number(dept.is_active)) {
      warnings.push(`${dept.name} is switched off — its opening balance will not be visible on the active-department screens.`);
    }

    /* ── the date must not go BACKWARDS ─────────────────────────────────────
     * Opening rows are stamped when they are WRITTEN, so a second cutover
     * labelled for an earlier date produces a row that anchors later while
     * claiming to describe an earlier day. The audit then reads as if the
     * department was counted twice in reverse. Checked against this
     * department's own openings AND the global stamp. */
    const priorOpen = db.prepare(`
      SELECT material_id, reference_id, event_date, quantity, ${LEDGER_TS_SQL} AS at
        FROM department_material_transactions
       WHERE department_id = ? AND type = 'opening'
    `).all(departmentId) as Array<{ material_id: string; reference_id: string | null; event_date: string | null; quantity: number; at: string }>;

    const priorByMat = new Map<string, { date: string; quantity: number; at: string }>();
    let maxPriorDate = '';
    for (const p of priorOpen) {
      const d = openingDate({ reference_id: p.reference_id, event_date: p.event_date, created_at: p.at });
      if (d > maxPriorDate) maxPriorDate = d;
      const seen = priorByMat.get(p.material_id);
      if (!seen || d > seen.date) priorByMat.set(p.material_id, { date: d, quantity: Number(p.quantity) || 0, at: p.at });
    }
    if (maxPriorDate && cutoverDate < maxPriorDate) {
      return Response.json(
        {
          error: `${dept.name} already has an opening dated ${maxPriorDate}; a cutover cannot be dated earlier (${cutoverDate}).`,
          code: 'CUTOVER_DATE_BACKWARDS',
          existing_cutover_date: maxPriorDate,
        },
        { status: 409 },
      );
    }
    const stamp = cutoverAt(db);
    if (stamp && cutoverDate < stamp.slice(0, 10)) {
      return Response.json(
        {
          error: `The department rail went live on ${stamp.slice(0, 10)}; a cutover cannot be dated before it (${cutoverDate}).`,
          code: 'CUTOVER_BEFORE_STAMP',
          cutover_at: stamp,
        },
        { status: 409 },
      );
    }

    /* ── gather the intended lines ──────────────────────────────────────────
     * adopt: the recorded closing count for (department, date). physical_stock
     * is already in RECIPE units — closing-stock/route.ts compares it directly
     * against raw_materials.current_stock — so it is taken VERBATIM. Do not add
     * a pack conversion here; that is the 1,000× class of bug the unit canon
     * exists to prevent. */
    let intended: Array<{ material_id: string; quantity: number; unit: string | null; note: string }> = [];
    let adoptedCountIds: string[] = [];
    /* adopt only: where each adopted count anchors (the ledger's count rule),
     * which is what the adopt trap measures from — plus when it was saved,
     * which the floor_hidden refusal needs to tell its story truthfully. */
    const adoptedAt = new Map<string, AdoptedCount>();
    if (adopt) {
      const rows = db.prepare(`
        SELECT id, material_id, physical_stock, notes, created_at
          FROM closing_stock
         WHERE department_id = ? AND date = ?
         ORDER BY created_at
      `).all(departmentId, cutoverDate) as Array<{ id: string; material_id: string; physical_stock: number; notes: string | null; created_at: string }>;
      if (rows.length === 0) {
        return Response.json(
          { error: `No closing count recorded for ${dept.name} on ${cutoverDate}. Record the count first (Inventory → Closing Stock), or send lines[].` },
          { status: 400 },
        );
      }
      /* ONE line per material. The closing-stock writers upsert per
       * (date, material, department), but nothing in the schema enforces it,
       * and two rows for one material here would plan TWO opening rows for one
       * pair. The later-anchoring row is the one the ledger anchors on; if the
       * resolver disagrees, adoptTrap refuses (not_the_anchor). */
      const byMat = new Map<string, (typeof rows)[number] & { at: string }>();
      for (const r of rows) {
        const at = countAnchorAt(cutoverDate, r.created_at);   // every row is dated cutoverDate (WHERE above)
        const seen = byMat.get(String(r.material_id));
        if (!seen || at >= seen.at) byMat.set(String(r.material_id), { ...r, at });
      }
      adoptedCountIds = [...byMat.values()].map(r => r.id);
      intended = [...byMat.values()].map(r => {
        adoptedAt.set(String(r.material_id), {
          at: r.at, qty: Number(r.physical_stock) || 0, date: cutoverDate, saved: countSavedAt(r.created_at),
        });
        return {
          material_id: String(r.material_id),
          quantity: Number(r.physical_stock) || 0,
          unit: null,                     // already recipe units — see above
          note: String(r.notes ?? ''),
        };
      });
    } else {
      const seen = new Set<string>();
      for (const l of rawLines) {
        const id = String(l?.material_id ?? '').trim();
        if (!id) return Response.json({ error: 'Every line needs a material_id' }, { status: 400 });
        /* Two lines for one material is an ambiguous count, not a sum. Refusing
         * beats silently adding two figures the counter may have meant to
         * replace one with the other. */
        if (seen.has(id)) {
          return Response.json({ error: `Material ${id} appears twice — send one line per material` }, { status: 400 });
        }
        seen.add(id);
        intended.push({
          material_id: id,
          quantity: Number(l?.quantity),
          unit: l?.unit == null ? null : String(l.unit),
          note: String(l?.notes ?? ''),
        });
      }
    }

    /* ── resolve, validate, plan (nothing is written yet) ───────────────────
     * Every problem is collected and answered in ONE list. A cutover of 300
     * materials fixed one 400 at a time is how an owner gives up halfway and
     * leaves the rail half-open. */
    const mats = new Map<string, Mat>();
    const getMat = db.prepare(`
      SELECT id, name, category, unit, purchase_unit, pack_size, case_size
        FROM raw_materials WHERE id = ?
    `);

    const planned: Planned[] = [];
    const skipped: Refused[] = [];
    const unknown: string[] = [];
    const storeMapped: Array<{ material_id: string; name: string; category: string }> = [];
    const badUnit: Refused[] = [];
    const badQty: Refused[] = [];
    const already: Array<{ material_id: string; name: string; cutover_date: string; quantity: number }> = [];
    const movedSinceCount: Array<{ material_id: string; name: string; count_at: string } & MovedRefusal> = [];
    const notCurrent: Array<{ material_id: string; name: string; adopted_count_at: string } & Exclude<AdoptRefusal, MovedRefusal>> = [];

    for (const it of intended) {
      const m = getMat.get(it.material_id) as Mat | undefined;
      if (!m) { unknown.push(it.material_id); continue; }
      mats.set(m.id, m);

      /* LIQUOR CARVE-OUT — refuse, never skip. Store-mapped materials are
       * excluded from BOTH legs of the department rail; an opening row here
       * would create a department balance for goods the TGBCL ledger is
       * simultaneously tracking, and the two would drift apart with nothing
       * reconciling them. */
      if (isStoreMappedMaterial(db, m.id)) {
        storeMapped.push({ material_id: m.id, name: m.name, category: m.category });
        continue;
      }

      /* IDEMPOTENCY — one opening per (department, material), ever. */
      const prior = priorByMat.get(m.id);
      if (prior) {
        already.push({ material_id: m.id, name: m.name, cutover_date: prior.date, quantity: r6(prior.quantity) });
        continue;
      }

      const qty = Number(it.quantity);
      if (!Number.isFinite(qty)) {
        badQty.push({ material_id: m.id, name: m.name, reason: 'not_a_number', detail: `quantity '${String(it.quantity)}' is not a number` });
        continue;
      }
      if (qty < 0) {
        badQty.push({ material_id: m.id, name: m.name, reason: 'negative', detail: `a physical count cannot be negative (${fmt(qty)})` });
        continue;
      }

      /* A COUNTED ZERO IS NOT NOTHING — but it cannot be an opening row.
       * postDeptLedger refuses a zero-quantity movement (a zero row teaches the
       * audit that a department received nothing), and that refusal is right.
       * The department still needs an anchor saying "counted, found none", and
       * a closing_stock row of 0 provides exactly that — deptOnHand anchors on
       * a count whatever its quantity. So this is reported, with the fix named,
       * rather than quietly dropped. */
      if (Math.abs(qty) < EPS) {
        skipped.push({
          material_id: m.id, name: m.name, reason: 'zero',
          detail: 'a zero opening posts no ledger row — record a closing count of 0 instead, which anchors the balance at nil',
        });
        continue;
      }

      /* ── unit basis ────────────────────────────────────────────────────────
       * packFactor() carries the BOTH-HALVES guard (pack_size > 1 AND recipe
       * unit ≠ purchase unit), so PICKLED GINGER 1.5KG — unit kg, purchase_unit
       * kg, pack_size 1.5 — correctly converts ×1 and is not inflated 1.5×.
       *
       * The unit is REQUIRED whenever a real factor exists, and guessing is
       * refused. Owner rule says purchase/inventory screens LEAD with the
       * purchase unit, so a bare number is genuinely ambiguous on those very
       * materials — and the wrong guess on a 1,000 g/kg pack is the 1,000×
       * error that has already bitten this database once.
       *
       * ADOPT IS NOT A BARE NUMBER. closing_stock.physical_stock is RECIPE
       * units by contract (see the gather above, and dept-sheet/route.ts), and
       * deptOnHand anchors on that same figure verbatim — so the basis is
       * known, not guessed. Without this, adopt refused EVERY packed material
       * with 'unit_required', a refusal the admin could not answer: adopt mode
       * takes no lines, so there is nowhere to say the unit. */
      const pf = packFactor(m);
      const ru = norm(m.unit);
      const pu = norm(m.purchase_unit || m.unit);
      const given = adopt ? ru : norm(it.unit);
      let basis: 'recipe' | 'purchase';
      if (!given) {
        if (pf > 1) {
          badUnit.push({
            material_id: m.id, name: m.name, reason: 'unit_required',
            detail: `1 ${m.purchase_unit} = ${pf} ${m.unit} — say which unit the count is in ('${m.unit}' or '${m.purchase_unit}')`,
          });
          continue;
        }
        basis = 'recipe';                    // one basis only; nothing to guess
      } else if (given === ru) {
        basis = 'recipe';
      } else if (given === pu) {
        basis = 'purchase';
      } else {
        badUnit.push({
          material_id: m.id, name: m.name, reason: 'unknown_unit',
          detail: `'${it.unit}' is neither the recipe unit ('${m.unit}') nor the purchase unit ('${m.purchase_unit || m.unit}')`,
        });
        continue;
      }
      const recipeQty = r6(basis === 'purchase' ? qty * pf : qty);

      /* ── the adopt trap ──────────────────────────────────────────────────
       * Measured from the ADOPTED count (adoptTrap, above): it must be the
       * count the balance stands on, and the pair must not have moved since
       * it — transfer legs from the count itself, never the floor (dept-ledger
       * deptOnHand, "A TRANSFER PAIR IS NEVER SPLIT"; this is the fourth place
       * that rule is implemented). It used to window from deptOnHand's CURRENT
       * anchor, so adopting an older count after a newer one passed: the
       * opening re-asserted the older figure and dropped every movement since. */
      if (adopt) {
        const a = adoptedAt.get(m.id);
        const ref: AdoptRefusal | null = a
          ? adoptTrap(db, departmentId, m.id, a)
          : { kind: 'not_the_anchor', anchor_source: 'none', anchor_at: null, anchor_qty: null };
        if (ref) {
          if (isMovedRefusal(ref)) {
            movedSinceCount.push({ material_id: m.id, name: m.name, count_at: a ? a.at : '', ...ref });
          } else {
            notCurrent.push({ material_id: m.id, name: m.name, adopted_count_at: a ? a.at : '', ...ref });
          }
          continue;
        }
      }

      planned.push({
        material_id: m.id,
        name: m.name,
        entered_quantity: r6(qty),
        entered_unit: (given || (basis === 'purchase' ? pu : ru)),
        quantity: recipeQty,
        basis,
        pack_factor: pf,
      });
    }

    /* ── hard refusals, atomic ───────────────────────────────────────────── */
    if (unknown.length) {
      return Response.json(
        { error: `${unknown.length} line(s) reference a material that does not exist`, code: 'UNKNOWN_MATERIAL', material_ids: unknown },
        { status: 400 },
      );
    }
    if (storeMapped.length) {
      return Response.json(
        {
          error:
            `${storeMapped.length} line(s) are store-mapped (liquor) materials. Liquor is not department stock — it is counted on the TGBCL store ledger ` +
            `(Inventory → Liquor Store → Record Closing Stock). Remove these lines and run the cutover again.`,
          code: 'STORE_MAPPED_MATERIAL',
          materials: storeMapped,
        },
        { status: 400 },
      );
    }
    if (badQty.length || badUnit.length) {
      return Response.json(
        {
          error: `${badQty.length + badUnit.length} line(s) could not be read — nothing was written`,
          code: 'INVALID_LINE',
          invalid: [...badQty, ...badUnit],
        },
        { status: 400 },
      );
    }
    /* The count being adopted is not the one the balance stands on. Adopting
     * it would put an OLDER figure on top of a newer count and drop every
     * movement since — the kilos-in-two-ledgers / in-none case. Named, with the
     * count date that WOULD be adoptable, and answered before MOVED_SINCE_COUNT
     * because the admin's next step differs (adopt the newer date, not
     * recount). */
    if (notCurrent.length) {
      const newerDates = [...new Set(notCurrent
        .map(n => (n.kind === 'newer_count' ? n.newest_count_date : ''))
        .filter(Boolean))].sort();
      const latest = newerDates[newerDates.length - 1] || '';
      return Response.json(
        {
          error:
            `${notCurrent.length} material(s) in ${dept.name} are not standing on the ${cutoverDate} count` +
            `${latest ? ` — a newer count exists (latest ${latest})` : ''}. Adopting the older count would overwrite the newer one and drop ` +
            `every movement since it out of the balance. ` +
            `${latest ? `Adopt the latest count date instead (cutover_date ${latest})` : 'Take a fresh count dated today and adopt that'}, ` +
            `or send lines[] with the quantities on the shelf right now. Nothing was written.`,
          code: 'COUNT_NOT_CURRENT',
          latest_count_date: latest || null,
          materials: notCurrent,
          moved_since_count: movedSinceCount,
        },
        { status: 409 },
      );
    }
    if (movedSinceCount.length) {
      /* THE WORDS MUST BE PHYSICALLY TRUE. A plain move (kind 'moved') reads
       * exactly as production always said it. A floor_hidden pair is told as
       * what actually happened (floorHiddenDetail): stock booked out AFTER the
       * count was saved (case W), or booked before the count was saved but
       * after the day it is DATED had ended (case V10 — "used after the count"
       * would be false there; the count may already include it). The rule and
       * the status are the same for all three; only the story differs. */
      const plainN = movedSinceCount.filter(x => x.kind === 'moved').length;
      const details = movedSinceCount.flatMap(x => (x.kind === 'floor_hidden'
        ? [floorHiddenDetail(x.name, mats.get(x.material_id), x, adoptedAt.get(x.material_id)?.qty ?? 0)]
        : []));
      const afterSave = details.filter(d => !d.datedLate);
      const datedLate = details.filter(d => d.datedLate);
      const sentences: string[] = [];
      const lead = (n: number) => (sentences.length ? `${n} more` : `${n} material(s) in ${dept.name}`);
      if (plainN > 0) {
        sentences.push(
          `${plainN} material(s) in ${dept.name} have moved since the ${cutoverDate} count. ` +
          `Adopting it now would drop those movements out of the balance.`,
        );
      }
      if (afterSave.length) {
        sentences.push(
          `For ${lead(afterSave.length)}, stock was booked out after the ${cutoverDate} count` +
          `${afterSave.every(d => d.savedKnown) ? ' was saved' : ''} and before the department rail went live. ` +
          `${detailSentences(afterSave.map(d => d.text))} The balance already leaves that out; the transfer check does not, ` +
          `and adopting would let more leave the shelf than is on it.`,
        );
      }
      if (datedLate.length) {
        sentences.push(
          `For ${lead(datedLate.length)}, the ${cutoverDate} count cannot be adopted as it stands. ` +
          `${detailSentences(datedLate.map(d => d.text))} ${DATED_LATE_WHY}`,
        );
      }
      sentences.push(details.length
        ? `Count again dated today (${today}) and adopt that, or send lines[] with the quantities on the shelf right now. Nothing was written.`
        : `Take a fresh count dated today and adopt that, or send lines[] with the quantities on the shelf right now.`);
      return Response.json(
        {
          error: sentences.join(' '),
          code: 'MOVED_SINCE_COUNT',
          materials: movedSinceCount,
        },
        { status: 409 },
      );
    }
    /* Already-opened pairs: refuse by default and NAME them. `skip_existing`
     * lets a resumed cutover finish the remainder — it still never stacks a
     * second opening on a pair that has one. */
    if (already.length && body?.skip_existing !== true) {
      return Response.json(
        {
          error:
            `${dept.name} already has an opening balance for ${already.length} of these material(s) — ` +
            `${already.slice(0, 5).map(a => `${a.name} (${fmt(a.quantity)}, ${a.cutover_date})`).join('; ')}` +
            `${already.length > 5 ? `, +${already.length - 5} more` : ''}. ` +
            `An opening is written once per material. Send skip_existing: true to open only the remaining materials, ` +
            `or record a closing count to re-base the ones already open.`,
          code: 'OPENING_EXISTS',
          existing: already,
          would_open: planned.length,
        },
        { status: 409 },
      );
    }
    if (planned.length === 0) {
      return Response.json(
        {
          error: 'Nothing to open — every line was already open, zero, or excluded',
          code: 'NOTHING_TO_OPEN',
          existing: already,
          skipped,
        },
        { status: 400 },
      );
    }

    /* outletId was resolved before the first ledger read — see above. From
     * the trap to the write below there is deliberately no await. */
    const refId = `cutover:${cutoverDate}`;
    const noteBits = [
      countSheetId ? `count sheet ${countSheetId}` : '',
      adopt ? `adopted closing count ${cutoverDate}` : `counted ${cutoverDate}`,
      freeNote,
    ].filter(Boolean);
    const note = noteBits.join(' — ');

    if (dryRun) {
      return Response.json({
        ok: true,
        dry_run: true,
        department: { id: dept.id, name: dept.name },
        cutover_date: cutoverDate,
        mode: adopt ? 'adopt' : 'lines',
        would_open: planned,
        would_open_count: planned.length,
        already_open: already,
        skipped,
        warnings,
        cutover_at: stamp || null,
        would_stamp_cutover: !stamp,
      });
    }

    /* ── write ──────────────────────────────────────────────────────────────
     * One transaction. postDeptLedger is the ONLY writer of department stock —
     * it inserts the ledger row and maintains the department_materials cache as
     * one pair, and it throws on anything it will not accept, which rolls this
     * whole cutover back rather than leaving a department half-opened.
     *
     * IMMEDIATE, and in adopt mode the trap runs AGAIN inside it, per pair,
     * just before that pair's opening is posted. IMMEDIATE takes the write lock
     * before the re-check reads, so no other connection can post a movement
     * between the check and the opening that would then swallow it. */
    let stampedNow = '';
    const run = db.transaction(() => {
      const postedIds: string[] = [];
      for (const p of planned) {
        if (adopt) {
          const a = adoptedAt.get(p.material_id);
          const ref: AdoptRefusal | null = a
            ? adoptTrap(db, departmentId, p.material_id, a)
            : { kind: 'not_the_anchor', anchor_source: 'none', anchor_at: null, anchor_qty: null };
          if (ref) throw new AdoptRaced(p.material_id, ref);
        }
        const res = postDeptLedger(db, {
          departmentId,
          materialId: p.material_id,
          type: 'opening',
          quantity: p.quantity,           // signed, positive, RECIPE units
          outletId,
          referenceId: refId,
          source: 'cutover',
          eventDate: cutoverDate,
          notes: note,
          user: me.email,
        });
        postedIds.push(res.id);
        if (!stampedNow) stampedNow = res.createdAt;
      }

      /* THE STAMP — first successful run only, and never re-written.
       * The UPDATE is guarded on the value still being blank so two admins
       * cutting over two departments in the same minute cannot move the floor;
       * the second one's WHERE simply matches nothing. Moving the floor forward
       * later would retroactively delete movement from whichever department
       * went first. The row itself is seeded by db.ts, so this only ever
       * updates. */
      const before = cutoverAt(db);
      if (!before) {
        db.prepare(`
          UPDATE settings SET value = ?
           WHERE key = 'dept_ledger_cutover_at' AND TRIM(COALESCE(value, '')) = ''
        `).run(stampedNow);
        db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('dept_ledger_cutover_at', ?)`).run(stampedNow);
      }

      logAuditEvent(db, {
        event_type: 'dept_ledger.cutover',
        entity_type: 'department',
        entity_id: departmentId,
        actor_email: me.email,
        outlet_id: outletId,
        after: {
          cutover_date: cutoverDate,
          mode: adopt ? 'adopt' : 'lines',
          opened: planned.length,
          skipped_existing: already.length,
          adopted_count_ids: adoptedCountIds,
          ledger_row_ids: postedIds,
          stamped: before ? null : stampedNow,
        },
        note: `Department cutover: ${dept.name} — ${planned.length} opening row(s) dated ${cutoverDate}`,
      });
    });
    try {
      run.immediate();
    } catch (e: unknown) {
      if (!(e instanceof AdoptRaced)) throw e;
      const name = mats.get(e.materialId)?.name || e.materialId;
      /* floor_hidden is told the same physically-true way as at planning
       * time (floorHiddenDetail); the other two keep their words. */
      let why: string;
      if (e.refusal.kind === 'floor_hidden') {
        const d = floorHiddenDetail(name, mats.get(e.materialId), e.refusal, adoptedAt.get(e.materialId)?.qty ?? 0);
        why = d.datedLate
          ? `: ${d.body}. ${DATED_LATE_WHY} `
          : `: stock was booked out after the ${cutoverDate} count${d.savedKnown ? ' was saved' : ''} and before the department rail went live — ` +
            `${d.body}. Adopting would let more leave the shelf than is on it. `;
      } else {
        why = ` (${e.refusal.kind === 'moved'
          ? 'it moved after the ' + cutoverDate + ' count'
          : 'its ' + cutoverDate + ' count is no longer the latest'}). `;
      }
      return Response.json(
        {
          error:
            `${name} in ${dept.name} changed while the cutover was being written${why}` +
            `Nothing was written. Run the cutover again.`,
          code: isMovedRefusal(e.refusal) ? 'MOVED_SINCE_COUNT' : 'COUNT_NOT_CURRENT',
          materials: [{ material_id: e.materialId, name, ...e.refusal }],
        },
        { status: 409 },
      );
    }

    /* Read the balance back through deptOnHand — the same function every screen
     * uses — so the response PROVES the opening landed rather than asserting
     * it. Read after commit, deliberately: a figure read inside the transaction
     * proves only what the transaction believed. */
    const opened = planned.map(p => {
      const bal = deptOnHand(db, departmentId, p.material_id);
      return {
        ...p,
        on_hand_after: bal.onHand,
        anchor_source: bal.anchorSource,
        anchor_at: bal.anchorAt,
      };
    });

    const stampAfter = cutoverAt(db) || null;
    return Response.json({
      ok: true,
      department: { id: dept.id, name: dept.name },
      cutover_date: cutoverDate,
      mode: adopt ? 'adopt' : 'lines',
      opened,
      opened_count: opened.length,
      skipped_existing: already,
      skipped,
      warnings,
      cutover_at: stampAfter,
      cutover_stamped_now: !!stampedNow && stampAfter === stampedNow.slice(0, 19).replace('T', ' '),
      /** Said plainly on every cutover response, because the screens that read
       *  this balance must repeat it: nothing before the cutover is in these
       *  numbers, by design (decision D — no backfill). */
      history_note: `Department balances start from this count. Requisition history before ${stampAfter || cutoverDate} is shown separately and is never added to on-hand.`,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Failed';
    console.error('[department-ledger cutover POST]', e);
    return Response.json({ error: msg || 'Cutover failed' }, { status: 500 });
  }
}
