import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { canManageHr } from '@/lib/hr';
import { commitRosterPlan, generateRosterPlan } from '@/lib/hr-roster-generate';
import { todayIST } from '@/lib/format-date';
import { reportServerError } from '@/lib/error-alerts';

/**
 * Roster GENERATOR endpoint (/api/hr/roster/generate) — HRMS roster Stage 2.
 *
 * POST { department_id, week_start?, commit?, allow_breaches?,
 *        rotate_shifts?, offs_weekdays? }
 *
 * PREVIEW IS THE DEFAULT. Without `commit: true` nothing is written at all —
 * generateRosterPlan is pure and this handler simply hands the plan back, so a
 * manager can read the offs, the reasons and the breaches before anything
 * touches hr_rosters.
 *   → 200 { preview: true, plan }   even when plan.ok is false: a refusal that
 *     names what is missing IS the useful answer, and the plan carries
 *     plan.refusals / plan.breaches / plan.warnings.
 *
 * COMMIT NEEDS THE EXPLICIT FLAG, and writes SHIFT rows only (offs are not
 * persisted — see src/lib/hr-roster-generate.ts for the owner's ruling and the
 * two measured reasons). A MANUAL EDIT WINS: a day whose hr_rosters row was not
 * written by the generator is left exactly as it is and reported in
 * result.kept_manual.
 *   → 200 { committed: true, plan, result }
 *   → 409 { error, plan }  refused plan, or unacknowledged coverage breaches
 *     (pass allow_breaches: true to commit a week that knowingly breaks a floor)
 *
 * week_start defaults to the MONDAY of the current IST week — the same anchor
 * /hr/roster's own week grid uses, so "generate" and the grid cannot land on
 * different weeks.
 *
 * Gated on canManageHr — the same predicate GET/POST /api/hr/roster uses, so a
 * manager who can save the grid by hand can also generate it, and nobody else
 * can do either. This verb re-authenticates: the proxy does NOT guard API
 * routes (HRMS §2.1).
 */
export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Trimmed string from any body value ('' for null/undefined). */
function s(v: unknown): string {
  return String(v ?? '').trim();
}

/** The Monday of the week containing `date` (ISO weeks start Monday here, as on
 *  /hr/roster). Pure YYYY-MM-DD / UTC arithmetic — no timezone drift. */
function mondayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  // getUTCDay: 0=Sun..6=Sat → step back to Monday (Sunday belongs to the week
  // that just ended, which is how the grid already pages).
  const shift = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - shift);
  return d.toISOString().slice(0, 10);
}

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    /* handled by the field checks below */
  }

  // better-sqlite3 is synchronous — every await is resolved BEFORE commit opens
  // its transaction.
  const outletId = await getCurrentOutletId();

  try {
    const db = getDb();

    const departmentId = s(body.department_id);
    const rawWeekStart = s(body.week_start);
    if (rawWeekStart && !DATE_RE.test(rawWeekStart)) {
      return Response.json(
        { error: 'Invalid week_start (expected YYYY-MM-DD)' },
        { status: 400 },
      );
    }
    const weekStart = rawWeekStart ? mondayOf(rawWeekStart) : mondayOf(todayIST());

    // What-if overrides for the preview. Both are optional and both degrade to
    // the saved setting — an empty offs_weekdays is NEVER read as "any day".
    const rotateOverride =
      typeof body.rotate_shifts === 'boolean' ? (body.rotate_shifts as boolean) : undefined;
    const offsOverride = Array.isArray(body.offs_weekdays)
      ? (body.offs_weekdays as unknown[]).map((n) => Number(n)).filter((n) => Number.isInteger(n))
      : undefined;

    const plan = generateRosterPlan(db, {
      department_id: departmentId,
      week_start: weekStart,
      ...(rotateOverride === undefined ? {} : { rotate_shifts: rotateOverride }),
      ...(offsOverride === undefined ? {} : { offs_weekdays: offsOverride }),
    });

    if (body.commit !== true) {
      return Response.json({ preview: true, plan });
    }

    if (!plan.ok) {
      return Response.json(
        {
          error:
            plan.refusals[0]?.message ??
            'The week cannot be generated — required configuration is missing',
          plan,
        },
        { status: 409 },
      );
    }

    const result = commitRosterPlan(
      db,
      plan,
      { email: me.email, outlet_id: outletId },
      { allow_breaches: body.allow_breaches === true },
    );
    if (!result.ok) {
      return Response.json({ error: result.error, plan, result }, { status: 409 });
    }
    return Response.json({ committed: true, plan, result });
  } catch (e) {
    console.error('POST /api/hr/roster/generate failed:', e);
    reportServerError(e, { url: request.url });
    // GENERIC on 500 — never e.message (house rule).
    return Response.json({ error: 'Failed to generate the roster' }, { status: 500 });
  }
}
