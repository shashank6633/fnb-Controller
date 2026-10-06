/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { isManagement } from '@/lib/auth';
import { fssaiDocState, fssaiToday, daysBetweenISO, isISODate, addDaysISO } from '@/lib/fssai';
import { requireFssaiUser, FSSAI_NO_MATCH } from '@/lib/fssai-server';
import { bucket, deptFence, fssaiTablesPresent, numOrBlank, intOr, whereAll, departmentNames } from '../_p9/lib';

/**
 * THE COMPLIANCE DASHBOARD'S FIGURES (/api/fssai/dashboard) — owner §1.
 *
 * ── WHAT THIS ROUTE IS ALLOWED TO SAY ───────────────────────────────────────
 * This is the first screen of a food-safety module. Three rules bind every
 * figure it returns, and all three are about not lying:
 *
 *  1. A MISSING REGISTER IS NOT A CLEAN KITCHEN. Wave 1 declared nineteen new
 *     tables and did not open the database read-write, so they arrive on the next
 *     cold start — measured today in this worktree: 11 of 30 fssai_ tables exist.
 *     A figure whose table is absent comes back `state:'unavailable'`, never 0.
 *     "0 temperature breaches" printed above an absent temperature register is
 *     the single most dangerous sentence this module could render.
 *  2. ONE BUCKET MUST NEVER KILL THE SCREEN. Each figure runs in its own guard
 *     (the notifications-inbox pattern, RECON §7.7). A broken one says so on its
 *     own tile; the others still count.
 *  3. THE FROZEN VERDICT IS READ, NEVER RECOMPUTED. is_fail / is_judged /
 *     min_used are what the standard said at the time. A dashboard that re-tests
 *     yesterday's reading against today's range rewrites history.
 *
 * ── WHO SEES WHAT (owner §7 Q10, provisional) ───────────────────────────────
 * /fssai is open to every signed-in user in the page catalog, so a porter opens
 * it. Management sees the whole restaurant. Everybody else sees their own
 * department plus records they filed themselves, and the figures that are
 * inherently premises-wide — the licence cupboard, the pest contract, used-oil
 * collection — are withheld with `state:'restricted'` rather than shown as 0.
 * `scope` in the response says which of the two the reader got, so the screen
 * can label it instead of implying it is the whole picture.
 *
 * GET only. The dashboard writes nothing.
 */
export const dynamic = 'force-dynamic';

/** A figure withheld because this reader may not see premises-wide state. */
function restricted<T>(value: T) {
  return {
    value,
    state: 'restricted' as const,
    why: 'This figure covers the whole premises, so it is shown to management only.',
  };
}

export async function GET(request: Request) {
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me as any;

  try {
    const db = getDb();
    const url = new URL(request.url);
    const today = fssaiToday();
    const mgmt = isManagement(me);
    const present = fssaiTablesPresent(db);
    const deptMap = departmentNames(db);

    /** How far back the "recently" figures look. 7 days unless asked otherwise. */
    const windowDays = (() => {
      const n = Number(url.searchParams.get('days'));
      return Number.isFinite(n) && n >= 1 && n <= 90 ? Math.trunc(n) : 7;
    })();
    const since = addDaysISO(today, -(windowDays - 1));

    const myDept = String(me.department_id || '') || FSSAI_NO_MATCH;
    const myEmail = String(me.email || '') || FSSAI_NO_MATCH;

    /* ══════════════════════════════════════════════════════════════════════
     * 1. WHAT IS DUE TODAY, AND WHAT OF IT HAS BEEN FILED
     * ══════════════════════════════════════════════════════════════════════
     * ⚠️ THE DEFINITION OF "DUE" IS COPIED FROM THE PICKER ON PURPOSE, not
     * invented here. src/app/fssai/checklists/run/page.tsx:333-343 decides what
     * a member of staff is shown as due:
     *     dueToday = next_due_date === '' || next_due_date <= today
     *     overdue  = next_due_date !== '' && next_due_date <  today
     * If this route used a different rule, the dashboard would promise a number
     * of rounds that the screen staff actually open would not list — which is
     * exactly the disagreement the rival-helper trap produces. Same predicate,
     * stated once here in SQL, with the source named.
     *
     * "Filed" means the SLOT is closed, and the slot is
     * (template_id, business_date, target_id, shift) — uq_fssai_runs_open's own
     * key, minus the trailing recorded_by. A voided run does NOT close a slot.
     */
    const due = bucket(db, 'due_today', ['fssai_assignments', 'fssai_runs'], {
      due: 0, overdue: 0, recorded: 0, outstanding: 0, rows: [] as any[],
    }, () => {
      const fence = mgmt
        ? { sql: '', args: [] as any[] }
        : {
            sql: `((a.department_id <> '' AND a.department_id = ?) OR lower(IFNULL(a.assignee_email,'')) = lower(?) OR (a.department_id = '' AND a.assignee_email = ''))`,
            args: [myDept, myEmail],
          };
      const w = whereAll([
        { sql: `a.is_active = 1 AND a.frequency <> 'on_event'`, args: [] },
        { sql: `(a.next_due_date = '' OR a.next_due_date <= ?)`, args: [today] },
        fence,
      ]);
      const rows = db.prepare(
        `SELECT a.id, a.template_id, a.target_id, a.target_label, a.shift, a.department_id,
                a.next_due_date, a.assignee_email, a.frequency,
                t.name AS template_name, t.code AS template_code,
                (SELECT r.id FROM fssai_runs r
                  WHERE r.template_id = a.template_id
                    AND r.business_date = ?
                    AND r.target_id = a.target_id
                    AND r.shift = a.shift
                    AND r.status IN ('submitted','verified')
                  LIMIT 1) AS filed_run_id,
                (SELECT r.id FROM fssai_runs r
                  WHERE r.template_id = a.template_id
                    AND r.business_date = ?
                    AND r.target_id = a.target_id
                    AND r.shift = a.shift
                    AND r.status = 'in_progress'
                  LIMIT 1) AS open_run_id
           FROM fssai_assignments a
           JOIN fssai_templates t ON t.id = a.template_id
           ${w.sql}
          ORDER BY a.next_due_date ASC, t.name ASC
          LIMIT 200`,
      ).all(today, today, ...w.args) as any[];

      let recorded = 0; let overdue = 0;
      const shaped = rows.map((r) => {
        const filed = !!r.filed_run_id;
        if (filed) recorded++;
        const isOverdue = !!r.next_due_date && isISODate(r.next_due_date) && daysBetweenISO(r.next_due_date, today) > 0;
        if (isOverdue && !filed) overdue++;
        return {
          assignment_id: String(r.id),
          template_id: String(r.template_id),
          template_name: String(r.template_name || ''),
          template_code: String(r.template_code || ''),
          target_label: String(r.target_label || ''),
          shift: String(r.shift || ''),
          department_id: String(r.department_id || ''),
          department_name: deptMap.get(String(r.department_id || '')) || '',
          next_due_date: String(r.next_due_date || ''),
          filed: filed,
          filed_run_id: String(r.filed_run_id || ''),
          open_run_id: String(r.open_run_id || ''),
          overdue: isOverdue && !filed,
        };
      });
      return {
        due: shaped.length,
        overdue,
        recorded,
        outstanding: shaped.length - recorded,
        rows: shaped.filter((r) => !r.filed).slice(0, 12),
      };
    }, present);

    /* ══════════════════════════════════════════════════════════════════════
     * 2. ROUNDS LEFT HALF-FILLED, AND ROUNDS WAITING FOR A SECOND PAIR OF EYES
     * ══════════════════════════════════════════════════════════════════════ */
    const openRounds = bucket(db, 'open_rounds', ['fssai_runs'], { mine: 0, all: 0 }, () => {
      const mine = db.prepare(
        `SELECT COUNT(*) AS n FROM fssai_runs
          WHERE status = 'in_progress' AND lower(recorded_by) = lower(?)`,
      ).get(myEmail) as any;
      const fence = deptFence(me, 'r');
      const w = whereAll([{ sql: `r.status = 'in_progress'`, args: [] }, fence]);
      const all = db.prepare(`SELECT COUNT(*) AS n FROM fssai_runs r ${w.sql}`).get(...w.args) as any;
      return { mine: intOr(mine?.n), all: intOr(all?.n) };
    }, present);

    const awaitingVerification = bucket(db, 'awaiting_verification', ['fssai_runs'], { n: 0, failed: 0 }, () => {
      /* Awaiting verification = submitted and not yet decided. Only management
       * may verify (canVerifyFssai is strictly narrower than the runner gate),
       * so for everybody else this is informational, not a queue. */
      const fence = deptFence(me, 'r');
      const w = whereAll([{ sql: `r.status = 'submitted'`, args: [] }, fence]);
      const row = db.prepare(
        `SELECT COUNT(*) AS n, SUM(CASE WHEN r.outcome = 'fail' THEN 1 ELSE 0 END) AS failed
           FROM fssai_runs r ${w.sql}`,
      ).get(...w.args) as any;
      return { n: intOr(row?.n), failed: intOr(row?.failed) };
    }, present);

    /* ══════════════════════════════════════════════════════════════════════
     * 3. WHAT FAILED — today, and across the window
     * ══════════════════════════════════════════════════════════════════════ */
    const failures = bucket(db, 'failures', ['fssai_runs', 'fssai_responses'], {
      rounds_today: 0, rounds_window: 0, answers_window: 0, rows: [] as any[],
    }, () => {
      const fence = deptFence(me, 'r');
      const wToday = whereAll([{ sql: `r.outcome = 'fail' AND r.status <> 'void' AND r.business_date = ?`, args: [today] }, fence]);
      const wWin = whereAll([
        { sql: `r.outcome = 'fail' AND r.status <> 'void' AND r.business_date >= ? AND r.business_date <= ?`, args: [since, today] },
        fence,
      ]);
      const a = db.prepare(`SELECT COUNT(*) AS n FROM fssai_runs r ${wToday.sql}`).get(...wToday.args) as any;
      const b = db.prepare(`SELECT COUNT(*) AS n FROM fssai_runs r ${wWin.sql}`).get(...wWin.args) as any;
      const wAns = whereAll([
        { sql: `p.is_fail = 1 AND r.status <> 'void' AND r.business_date >= ? AND r.business_date <= ?`, args: [since, today] },
        fence,
      ]);
      const c = db.prepare(
        `SELECT COUNT(*) AS n FROM fssai_responses p JOIN fssai_runs r ON r.id = p.run_id ${wAns.sql}`,
      ).get(...wAns.args) as any;
      const rows = db.prepare(
        `SELECT p.prompt_snapshot, p.value_text, p.value_num, p.uom, r.business_date, r.department_id,
                r.recorded_name, r.recorded_by, r.id AS run_id
           FROM fssai_responses p JOIN fssai_runs r ON r.id = p.run_id ${wAns.sql}
          ORDER BY r.business_date DESC, p.sort_order ASC LIMIT 8`,
      ).all(...wAns.args) as any[];
      return {
        rounds_today: intOr(a?.n),
        rounds_window: intOr(b?.n),
        answers_window: intOr(c?.n),
        rows: rows.map((r) => ({
          run_id: String(r.run_id),
          business_date: String(r.business_date || ''),
          prompt: String(r.prompt_snapshot || ''),
          // NULL value_num stays blank. A failure for "no reading" is not 0 °C.
          answer: String(r.value_text || '') || (r.value_num === null || r.value_num === undefined ? '' : `${numOrBlank(r.value_num, 1)} ${String(r.uom || '')}`.trim()),
          department_name: deptMap.get(String(r.department_id || '')) || '',
          by: String(r.recorded_name || r.recorded_by || ''),
        })),
      };
    }, present);

    /* ══════════════════════════════════════════════════════════════════════
     * 4. CORRECTIVE ACTIONS
     * ══════════════════════════════════════════════════════════════════════ */
    const correctiveActions = bucket(db, 'corrective_actions', ['fssai_corrective_actions'], {
      open: 0, overdue: 0, awaiting_check: 0, mine: 0, rows: [] as any[],
    }, () => {
      const fence = mgmt
        ? { sql: '', args: [] as any[] }
        : {
            sql: `((c.department_id <> '' AND c.department_id = ?) OR lower(IFNULL(c.owner_email,'')) = lower(?))`,
            args: [myDept, myEmail],
          };
      const base = whereAll([{ sql: `c.status IN ('open','in_progress')`, args: [] }, fence]);
      const open = db.prepare(`SELECT COUNT(*) AS n FROM fssai_corrective_actions c ${base.sql}`).get(...base.args) as any;
      const od = whereAll([
        { sql: `c.status IN ('open','in_progress') AND c.due_date <> '' AND c.due_date < ?`, args: [today] },
        fence,
      ]);
      const overdue = db.prepare(`SELECT COUNT(*) AS n FROM fssai_corrective_actions c ${od.sql}`).get(...od.args) as any;
      const dw = whereAll([{ sql: `c.status = 'done'`, args: [] }, fence]);
      const done = db.prepare(`SELECT COUNT(*) AS n FROM fssai_corrective_actions c ${dw.sql}`).get(...dw.args) as any;
      const mine = db.prepare(
        `SELECT COUNT(*) AS n FROM fssai_corrective_actions c
          WHERE c.status IN ('open','in_progress') AND lower(c.owner_email) = lower(?)`,
      ).get(myEmail) as any;
      const rows = db.prepare(
        `SELECT c.id, c.ca_number, c.title, c.severity, c.status, c.due_date, c.owner_email, c.department_id
           FROM fssai_corrective_actions c ${base.sql}
          ORDER BY (CASE WHEN c.due_date = '' THEN 1 ELSE 0 END) ASC, c.due_date ASC LIMIT 8`,
      ).all(...base.args) as any[];
      return {
        open: intOr(open?.n),
        overdue: intOr(overdue?.n),
        awaiting_check: intOr(done?.n),
        mine: intOr(mine?.n),
        rows: rows.map((r) => ({
          id: String(r.id),
          ca_number: String(r.ca_number || ''),
          title: String(r.title || ''),
          severity: String(r.severity || ''),
          status: String(r.status || ''),
          due_date: String(r.due_date || ''),
          owner_email: String(r.owner_email || ''),
          department_name: deptMap.get(String(r.department_id || '')) || '',
          overdue: !!String(r.due_date || '') && String(r.due_date) < today,
        })),
      };
    }, present);

    /* ══════════════════════════════════════════════════════════════════════
     * 5. THE LICENCE CUPBOARD — premises-wide, so management only
     * ══════════════════════════════════════════════════════════════════════
     * THE STATE IS DERIVED ON EVERY READ, never stored: a saved 'expiring' goes
     * stale at midnight with nothing to wake it, and a licence rendering "Valid"
     * the day after it lapsed is the worst row this module could print.
     */
    const documents = mgmt
      ? bucket(db, 'documents', ['fssai_documents'], { expired: 0, expiring: 0, total: 0, rows: [] as any[] }, () => {
          const rows = db.prepare(
            `SELECT id, title, doc_type, reference_no, expiry_date, reminder_days, owner_email
               FROM fssai_documents
              WHERE status <> 'void' AND is_active = 1
              ORDER BY (CASE WHEN expiry_date = '' THEN 1 ELSE 0 END) ASC, expiry_date ASC`,
          ).all() as any[];
          let expired = 0; let expiring = 0;
          const flagged: any[] = [];
          for (const r of rows) {
            const st = fssaiDocState(r.expiry_date, today, intOr(r.reminder_days, 30));
            if (st === 'expired') expired++;
            if (st === 'expiring') expiring++;
            if (st === 'expired' || st === 'expiring') {
              flagged.push({
                id: String(r.id), title: String(r.title || ''), doc_type: String(r.doc_type || ''),
                reference_no: String(r.reference_no || ''), expiry_date: String(r.expiry_date || ''), state: st,
                owner_email: String(r.owner_email || ''),
              });
            }
          }
          return { expired, expiring, total: rows.length, rows: flagged.slice(0, 8) };
        }, present)
      : restricted({ expired: 0, expiring: 0, total: 0, rows: [] as any[] });

    /* ══════════════════════════════════════════════════════════════════════
     * 6. TEMPERATURE
     * ══════════════════════════════════════════════════════════════════════ */
    const temperature = bucket(db, 'temperature', ['fssai_temperature_logs'], {
      readings_today: 0, breaches_today: 0, breaches_window: 0, unjudged_window: 0, rows: [] as any[],
    }, () => {
      const fence = deptFence(me, 'tl');
      const wToday = whereAll([{ sql: `tl.status <> 'void' AND tl.business_date = ?`, args: [today] }, fence]);
      const t = db.prepare(
        `SELECT COUNT(*) AS n, SUM(CASE WHEN tl.is_fail = 1 THEN 1 ELSE 0 END) AS fails
           FROM fssai_temperature_logs tl ${wToday.sql}`,
      ).get(...wToday.args) as any;
      const wWin = whereAll([
        { sql: `tl.status <> 'void' AND tl.business_date >= ? AND tl.business_date <= ?`, args: [since, today] },
        fence,
      ]);
      const win = db.prepare(
        `SELECT SUM(CASE WHEN tl.is_fail = 1 THEN 1 ELSE 0 END) AS fails,
                SUM(CASE WHEN tl.is_judged = 0 THEN 1 ELSE 0 END) AS unjudged
           FROM fssai_temperature_logs tl ${wWin.sql}`,
      ).get(...wWin.args) as any;
      const wRows = whereAll([
        { sql: `tl.is_fail = 1 AND tl.status <> 'void' AND tl.business_date >= ? AND tl.business_date <= ?`, args: [since, today] },
        fence,
      ]);
      const rows = db.prepare(
        `SELECT tl.id, tl.business_date, tl.reading_at, tl.log_kind, tl.equipment_label, tl.area_label,
                tl.value_num, tl.uom, tl.decimals, tl.min_used, tl.max_used, tl.fail_reason, tl.action_taken
           FROM fssai_temperature_logs tl ${wRows.sql}
          ORDER BY tl.business_date DESC, tl.reading_at DESC LIMIT 8`,
      ).all(...wRows.args) as any[];
      return {
        readings_today: intOr(t?.n),
        breaches_today: intOr(t?.fails),
        breaches_window: intOr(win?.fails),
        unjudged_window: intOr(win?.unjudged),
        rows: rows.map((r) => ({
          id: String(r.id),
          business_date: String(r.business_date || ''),
          reading_at: String(r.reading_at || ''),
          log_kind: String(r.log_kind || ''),
          where_label: String(r.equipment_label || r.area_label || ''),
          reading: `${numOrBlank(r.value_num, intOr(r.decimals, 1))} ${String(r.uom || '')}`.trim(),
          min_used: r.min_used === null || r.min_used === undefined ? null : Number(r.min_used),
          max_used: r.max_used === null || r.max_used === undefined ? null : Number(r.max_used),
          fail_reason: String(r.fail_reason || ''),
          action_taken: String(r.action_taken || ''),
        })),
      };
    }, present);

    /* ══════════════════════════════════════════════════════════════════════
     * 7. DELIVERIES
     * ══════════════════════════════════════════════════════════════════════ */
    const receiving = bucket(db, 'receiving', ['fssai_receiving_checks'], {
      checked_today: 0, failed_window: 0, rejected_window: 0, licence_lapsed: 0,
    }, () => {
      const fence = deptFence(me, 'c', 'checked_by');
      const wToday = whereAll([{ sql: `c.status <> 'void' AND c.business_date = ?`, args: [today] }, fence]);
      const a = db.prepare(`SELECT COUNT(*) AS n FROM fssai_receiving_checks c ${wToday.sql}`).get(...wToday.args) as any;
      const wWin = whereAll([
        { sql: `c.status <> 'void' AND c.business_date >= ? AND c.business_date <= ?`, args: [since, today] },
        fence,
      ]);
      const b = db.prepare(
        `SELECT SUM(CASE WHEN c.fail_count > 0 THEN 1 ELSE 0 END) AS failed,
                SUM(c.rejected_count) AS rejected,
                SUM(CASE WHEN c.supplier_licence_expiry <> '' AND c.supplier_licence_expiry < ? THEN 1 ELSE 0 END) AS lapsed
           FROM fssai_receiving_checks c ${wWin.sql}`,
      ).get(today, ...wWin.args) as any;
      return {
        checked_today: intOr(a?.n),
        failed_window: intOr(b?.failed),
        rejected_window: intOr(b?.rejected),
        licence_lapsed: intOr(b?.lapsed),
      };
    }, present);

    /* ══════════════════════════════════════════════════════════════════════
     * 8. EXPIRY
     * ══════════════════════════════════════════════════════════════════════ */
    const expiry = bucket(db, 'expiry', ['fssai_expiry_items'], { expired_open: 0, near_open: 0, discarded_window: 0 }, () => {
      const fence = deptFence(me, 'x');
      const w = whereAll([{ sql: `x.status <> 'void'`, args: [] }, fence]);
      const row = db.prepare(
        `SELECT SUM(CASE WHEN x.state = 'expired'     AND x.action_taken = '' THEN 1 ELSE 0 END) AS expired_open,
                SUM(CASE WHEN x.state = 'near_expiry' AND x.action_taken = '' THEN 1 ELSE 0 END) AS near_open
           FROM fssai_expiry_items x ${w.sql}`,
      ).get(...w.args) as any;
      const wWin = whereAll([
        { sql: `x.status <> 'void' AND x.discard_qty IS NOT NULL AND x.business_date >= ? AND x.business_date <= ?`, args: [since, today] },
        fence,
      ]);
      const d = db.prepare(`SELECT COUNT(*) AS n FROM fssai_expiry_items x ${wWin.sql}`).get(...wWin.args) as any;
      return { expired_open: intOr(row?.expired_open), near_open: intOr(row?.near_open), discarded_window: intOr(d?.n) };
    }, present);

    /* ══════════════════════════════════════════════════════════════════════
     * 9. OIL, WATER AND PESTS
     * ══════════════════════════════════════════════════════════════════════ */
    const oil = bucket(db, 'oil', ['fssai_oil_checks'], { checks_window: 0, over_limit_window: 0, changed_window: 0 }, () => {
      const fence = deptFence(me, 'o');
      const w = whereAll([
        { sql: `o.status <> 'void' AND o.business_date >= ? AND o.business_date <= ?`, args: [since, today] },
        fence,
      ]);
      const row = db.prepare(
        `SELECT COUNT(*) AS n,
                SUM(CASE WHEN o.is_fail = 1 THEN 1 ELSE 0 END) AS over_limit,
                SUM(CASE WHEN o.oil_changed = 1 THEN 1 ELSE 0 END) AS changed
           FROM fssai_oil_checks o ${w.sql}`,
      ).get(...w.args) as any;
      return { checks_window: intOr(row?.n), over_limit_window: intOr(row?.over_limit), changed_window: intOr(row?.changed) };
    }, present);

    const water = bucket(db, 'water', ['fssai_water_tests'], { tests_window: 0, failed_window: 0, next_due_overdue: 0 }, () => {
      const fence = deptFence(me, 't');
      const w = whereAll([
        { sql: `t.status <> 'void' AND t.business_date >= ? AND t.business_date <= ?`, args: [since, today] },
        fence,
      ]);
      const row = db.prepare(
        `SELECT COUNT(*) AS n, SUM(CASE WHEN t.is_fail = 1 THEN 1 ELSE 0 END) AS failed
           FROM fssai_water_tests t ${w.sql}`,
      ).get(...w.args) as any;
      /* "Next due already past" looks at the LATEST test of each kind, not at
       * every row — an old certificate whose next_due_date has passed is not
       * overdue if a newer one exists. */
      const od = db.prepare(
        `SELECT COUNT(*) AS n FROM (
            SELECT test_kind, MAX(business_date) AS last_date,
                   (SELECT t2.next_due_date FROM fssai_water_tests t2
                     WHERE t2.test_kind = t1.test_kind AND t2.status <> 'void'
                     ORDER BY t2.business_date DESC LIMIT 1) AS next_due
              FROM fssai_water_tests t1
             WHERE t1.status <> 'void'
             GROUP BY test_kind
          ) WHERE next_due <> '' AND next_due < ?`,
      ).get(today) as any;
      return { tests_window: intOr(row?.n), failed_window: intOr(row?.failed), next_due_overdue: intOr(od?.n) };
    }, present);

    const pest = mgmt
      ? bucket(db, 'pest', ['fssai_pest_services', 'fssai_pest_sightings'], {
          visits_window: 0, missed: 0, next_due_overdue: 0, sightings_open: 0,
        }, () => {
          const v = db.prepare(
            `SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'missed' THEN 1 ELSE 0 END) AS missed
               FROM fssai_pest_services
              WHERE status <> 'void' AND business_date >= ? AND business_date <= ?`,
          ).get(since, today) as any;
          const od = db.prepare(
            `SELECT COUNT(*) AS n FROM (
                SELECT next_due_date AS next_due FROM fssai_pest_services
                 WHERE status <> 'void' ORDER BY business_date DESC LIMIT 1
              ) WHERE next_due <> '' AND next_due < ?`,
          ).get(today) as any;
          const s = db.prepare(
            `SELECT COUNT(*) AS n FROM fssai_pest_sightings
              WHERE status <> 'void' AND closed_at = ''`,
          ).get() as any;
          return {
            visits_window: intOr(v?.n), missed: intOr(v?.missed),
            next_due_overdue: intOr(od?.n), sightings_open: intOr(s?.n),
          };
        }, present)
      : restricted({ visits_window: 0, missed: 0, next_due_overdue: 0, sightings_open: 0 });

    /* ══════════════════════════════════════════════════════════════════════
     * 10. INSPECTIONS — somebody else's findings. Management only.
     * ══════════════════════════════════════════════════════════════════════ */
    const inspections = mgmt
      ? bucket(db, 'inspections', ['fssai_inspections', 'fssai_inspection_findings'], {
          visits_year: 0, open_points: 0, overdue_points: 0, reply_due: 0, last: null as any,
        }, () => {
          const yearStart = `${today.slice(0, 4)}-01-01`;
          const v = db.prepare(
            `SELECT COUNT(*) AS n FROM fssai_inspections
              WHERE status <> 'void' AND business_date >= ?`,
          ).get(yearStart) as any;
          const f = db.prepare(
            `SELECT SUM(CASE WHEN f.status <> 'closed' THEN 1 ELSE 0 END) AS open_points,
                    SUM(CASE WHEN f.status <> 'closed' AND f.due_date <> '' AND f.due_date < ? THEN 1 ELSE 0 END) AS overdue_points
               FROM fssai_inspection_findings f
               JOIN fssai_inspections i ON i.id = f.inspection_id
              WHERE i.status <> 'void'`,
          ).get(today) as any;
          const rd = db.prepare(
            `SELECT COUNT(*) AS n FROM fssai_inspections
              WHERE status NOT IN ('void','closed') AND reply_due_date <> '' AND reply_due_date >= ?`,
          ).get(today) as any;
          const last = db.prepare(
            `SELECT id, business_date, inspection_kind, authority, inspector_name, grade, outcome, score, score_max, status
               FROM fssai_inspections WHERE status <> 'void'
              ORDER BY business_date DESC LIMIT 1`,
          ).get() as any;
          return {
            visits_year: intOr(v?.n),
            open_points: intOr(f?.open_points),
            overdue_points: intOr(f?.overdue_points),
            reply_due: intOr(rd?.n),
            last: last
              ? {
                  id: String(last.id), business_date: String(last.business_date || ''),
                  inspection_kind: String(last.inspection_kind || ''), authority: String(last.authority || ''),
                  inspector_name: String(last.inspector_name || ''), grade: String(last.grade || ''),
                  outcome: String(last.outcome || ''), status: String(last.status || ''),
                  score: last.score === null || last.score === undefined ? null : Number(last.score),
                  score_max: last.score_max === null || last.score_max === undefined ? null : Number(last.score_max),
                }
              : null,
          };
        }, present)
      : restricted({ visits_year: 0, open_points: 0, overdue_points: 0, reply_due: 0, last: null as any });

    /* ══════════════════════════════════════════════════════════════════════
     * 11. HAS ANYTHING AT ALL BEEN RECORDED?
     * ══════════════════════════════════════════════════════════════════════
     * The honest-empty state. The dashboard said for three weeks, truthfully,
     * that it showed no counts because there was nothing to count. That sentence
     * must disappear the moment a single record exists and must not disappear
     * before — so it is a measured fact, not a constant.
     */
    const corpus = bucket(db, 'corpus', ['fssai_runs'], { records: 0, templates: 0, published: 0, assignments: 0 }, () => {
      const r = db.prepare(`SELECT COUNT(*) AS n FROM fssai_runs`).get() as any;
      const t = db.prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN status='published' THEN 1 ELSE 0 END) AS pub FROM fssai_templates`).get() as any;
      const a = present.has('fssai_assignments')
        ? (db.prepare(`SELECT COUNT(*) AS n FROM fssai_assignments WHERE is_active = 1`).get() as any)
        : { n: 0 };
      return { records: intOr(r?.n), templates: intOr(t?.n), published: intOr(t?.pub), assignments: intOr(a?.n) };
    }, present);

    const registersMissing = [
      'fssai_receiving_checks', 'fssai_temperature_logs', 'fssai_expiry_items', 'fssai_oil_checks',
      'fssai_water_tests', 'fssai_pest_services', 'fssai_documents', 'fssai_inspections',
    ].filter((t) => !present.has(t));

    return Response.json({
      today,
      window_days: windowDays,
      window_from: since,
      scope: mgmt ? 'restaurant' : 'department',
      scope_note: mgmt
        ? 'You are seeing the whole restaurant.'
        : 'You are seeing your own department and the records you filed yourself. Premises-wide figures are management only.',
      can_verify: mgmt,
      due,
      open_rounds: openRounds,
      awaiting_verification: awaitingVerification,
      failures,
      corrective_actions: correctiveActions,
      documents,
      temperature,
      receiving,
      expiry,
      oil,
      water,
      pest,
      inspections,
      corpus,
      /* Named so the screen can say WHICH registers are not in this database
       * yet, rather than printing a zero for each of them. */
      registers_missing: registersMissing,
      generated_at: new Date().toISOString(),
    });
  } catch (e: any) {
    console.error('GET /api/fssai/dashboard failed:', e);
    return Response.json({ error: e?.message || 'Failed to load the dashboard figures' }, { status: 500 });
  }
}
