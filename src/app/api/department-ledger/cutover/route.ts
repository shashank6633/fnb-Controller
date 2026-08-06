import type Database from 'better-sqlite3';
import { getDb, logAuditEvent } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { postDeptLedger, deptOnHand, cutoverAt } from '@/lib/dept-ledger';
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
 * is a fresh count, not a looser guard.
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
    if (adopt) {
      const rows = db.prepare(`
        SELECT id, material_id, physical_stock, notes
          FROM closing_stock
         WHERE department_id = ? AND date = ?
         ORDER BY created_at
      `).all(departmentId, cutoverDate) as Array<{ id: string; material_id: string; physical_stock: number; notes: string | null }>;
      if (rows.length === 0) {
        return Response.json(
          { error: `No closing count recorded for ${dept.name} on ${cutoverDate}. Record the count first (Inventory → Closing Stock), or send lines[].` },
          { status: 400 },
        );
      }
      adoptedCountIds = rows.map(r => r.id);
      intended = rows.map(r => ({
        material_id: String(r.material_id),
        quantity: Number(r.physical_stock) || 0,
        unit: null,                     // already recipe units — see above
        note: String(r.notes ?? ''),
      }));
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
    const movedSinceCount: Array<{ material_id: string; name: string; moved_rows: number; count_at: string }> = [];

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
       * error that has already bitten this database once. */
      const pf = packFactor(m);
      const ru = norm(m.unit);
      const pu = norm(m.purchase_unit || m.unit);
      const given = norm(it.unit);
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
       * Only in adopt mode, and only when a COUNT is what currently anchors
       * this pair: if the department has moved since that count, writing the
       * opening now would re-anchor forward and drop those movements out of the
       * balance for good. windowFrom comes from deptOnHand — the SAME resolver
       * the balance uses — so this guard and the balance can never disagree
       * about where the window starts. */
      if (adopt) {
        const bal = deptOnHand(db, departmentId, m.id);
        if (bal.anchorSource === 'count' && bal.windowFrom) {
          const moved = db.prepare(`
            SELECT COUNT(*) AS n FROM department_material_transactions
             WHERE department_id = ? AND material_id = ? AND type <> 'opening'
               AND ${LEDGER_TS_SQL} > ?
          `).get(departmentId, m.id, bal.windowFrom) as { n: number } | undefined;
          const n = Number(moved?.n) || 0;
          if (n > 0) {
            movedSinceCount.push({ material_id: m.id, name: m.name, moved_rows: n, count_at: bal.windowFrom });
            continue;
          }
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
    if (movedSinceCount.length) {
      return Response.json(
        {
          error:
            `${movedSinceCount.length} material(s) in ${dept.name} have moved since the ${cutoverDate} count. Adopting it now would drop those movements ` +
            `out of the balance. Take a fresh count dated today and adopt that, or send lines[] with the quantities on the shelf right now.`,
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

    const outletId = await getCurrentOutletId();
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
     * whole cutover back rather than leaving a department half-opened. */
    let stampedNow = '';
    const run = db.transaction(() => {
      const postedIds: string[] = [];
      for (const p of planned) {
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
    run();

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
