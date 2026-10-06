/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, logAuditEvent } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { canAdminHr, canManageHr } from '@/lib/hr';
import { getHrDayCutoff, getHrPunchDebounceMin, getHrOrgState } from '@/lib/hr-attendance';
import { reportServerError } from '@/lib/error-alerts';

/**
 * HR attendance settings (/api/hr/settings) — Phase 2.
 *
 * Contract: docs/HRMS_DECISIONS.md §8.2 — the two attendance knobs live in the
 * shared settings KV as BENIGN keys (§2.7: nothing sensitive ever goes there):
 *   · hr_day_cutoff        'HH:MM' IST, default '04:00'. The business-day
 *                          boundary — a punch before the cutoff belongs to the
 *                          PREVIOUS attendance day (a 1 AM checkout is
 *                          yesterday's).
 *   · hr_punch_debounce_min positive integer minutes, default 3. Consecutive
 *                          punches inside this window are duplicates (kept,
 *                          marked ignored — never deleted).
 *
 * OWNERSHIP: the generic /api/settings route registers the `hr_` prefix in
 * KEY_POLICY/OWNED_PREFIXES and routes hr_* keys HERE (already wired) — this
 * route is the only writer, so the canAdminHr gate below actually holds.
 *
 * GET → { settings: { hr_day_cutoff, hr_punch_debounce_min } }
 *       Management tier. Values are the EFFECTIVE ones (defaults applied when
 *       absent/invalid) via the same getters the engine itself reads through
 *       (src/lib/hr-attendance.ts) — the UI can never show a value the pairing
 *       engine is not actually using.
 * PUT { hr_day_cutoff?, hr_punch_debounce_min? } → { settings }
 *       Admin only. Validates before writing: cutoff must be a real clock time
 *       'HH:MM' (stored zero-padded), debounce a positive integer ≤ 60.
 *       INSERT OR REPLACE into the shared settings KV; audited with
 *       before/after (hr.settings.update).
 *
 * Error bodies are GENERIC on 500 (never e.message).
 */
export const dynamic = 'force-dynamic';

/** Parse a cutoff body value into zero-padded 'HH:MM', or null if invalid.
 *  Accepts '4:00' and normalises to '04:00' — the stored form is always
 *  2-digit so string comparisons and the engine's parser stay trivial. */
function parseCutoff(v: unknown): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? '').trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** Parse a debounce body value into a positive integer ≤ 60, or null.
 *  Rejects floats ('3.5') — a fractional minute is a typo, not a policy. */
function parseDebounce(v: unknown): number | null {
  const raw = String(v ?? '').trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > 60) return null;
  return n;
}

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }
  try {
    const db = getDb();
    // The state spellings ALREADY used by statutory config rows. Both sides of
    // the match are free text and compared exactly, so a 'telangana' here
    // against a 'Telangana' there silently deducts nothing — the exact failure
    // this setting exists to end. Offering the stored spellings lets the UI
    // present them as choices instead of asking an admin to retype one.
    const configured_states = db
      .prepare(
        `SELECT DISTINCT state FROM hr_statutory_configs
          WHERE state <> '' ORDER BY state`,
      )
      .all() as Array<{ state: string }>;
    return Response.json({
      settings: {
        hr_day_cutoff: getHrDayCutoff(db),
        hr_punch_debounce_min: getHrPunchDebounceMin(db),
        hr_org_state: getHrOrgState(db),
      },
      configured_states: configured_states.map((r) => r.state),
    });
  } catch (e) {
    console.error('GET /api/hr/settings failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to load HR settings' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) return Response.json({ error: 'Admin role required' }, { status: 403 });

  let body: any = {};
  try { body = await request.json(); } catch { /* handled by field checks below */ }

  // Validate EVERYTHING before writing ANYTHING — a half-applied settings PUT
  // (cutoff updated, debounce rejected) would silently shift business days.
  let cutoff: string | null = null;
  if (body?.hr_day_cutoff !== undefined) {
    cutoff = parseCutoff(body.hr_day_cutoff);
    if (cutoff === null) {
      return Response.json(
        { error: 'Day cutoff must be a time in HH:MM format (e.g. 04:00)' },
        { status: 400 },
      );
    }
  }
  let debounce: number | null = null;
  if (body?.hr_punch_debounce_min !== undefined) {
    debounce = parseDebounce(body.hr_punch_debounce_min);
    if (debounce === null) {
      return Response.json(
        { error: 'Punch debounce must be a whole number of minutes between 1 and 60' },
        { status: 400 },
      );
    }
  }
  // hr_org_state — the state payroll resolves statutory rates in. '' is a
  // LEGITIMATE value, not an absence: it means "all-India rates only", which is
  // what payroll did before this setting existed. So it is tracked with its own
  // flag rather than by null-ness, or clearing it back to '' would be
  // indistinguishable from not sending it and could never be undone.
  let orgState: string | null = null;
  if (body?.hr_org_state !== undefined) {
    if (typeof body.hr_org_state !== 'string') {
      return Response.json({ error: 'Payroll state must be text' }, { status: 400 });
    }
    // String(...) rather than body.hr_org_state.trim(): `body` is `any`, so
    // assigning from it leaves orgState as `string | null` and every later use
    // needs a null check. This narrows it properly at the source.
    orgState = String(body.hr_org_state).trim();
    if (orgState.length > 64) {
      return Response.json({ error: 'Payroll state is too long' }, { status: 400 });
    }
  }
  if (cutoff === null && debounce === null && orgState === null) {
    return Response.json({ error: 'Nothing to update' }, { status: 400 });
  }

  // better-sqlite3 is synchronous — resolve every await BEFORE db.transaction.
  const outletId = await getCurrentOutletId();

  try {
    const db = getDb();

    // Before-image reads through the SAME effective getters as GET, so the
    // audit trail records the value the engine was actually using (a garbage
    // stored value audits as the default it fell back to).
    const before = {
      hr_day_cutoff: getHrDayCutoff(db),
      hr_punch_debounce_min: getHrPunchDebounceMin(db),
      hr_org_state: getHrOrgState(db),
    };

    const upsert = db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`);
    const write = db.transaction(() => {
      if (cutoff !== null) upsert.run('hr_day_cutoff', cutoff);
      if (debounce !== null) upsert.run('hr_punch_debounce_min', String(debounce));
      if (orgState !== null) upsert.run('hr_org_state', orgState);

      const after = {
        hr_day_cutoff: cutoff ?? before.hr_day_cutoff,
        hr_punch_debounce_min: debounce ?? before.hr_punch_debounce_min,
        // `orgState ?? before` and NOT `orgState || before`: '' is a real value
        // here (all-India rates only), and || would quietly discard a clear.
        hr_org_state: orgState ?? before.hr_org_state,
      };
      logAuditEvent(db, {
        event_type: 'hr.settings.update',
        entity_type: 'hr_settings',
        entity_id: 'attendance',
        actor_email: me.email,
        outlet_id: outletId,
        before,
        after,
      });
      return after;
    });
    const settings = write();

    return Response.json({ settings });
  } catch (e) {
    console.error('PUT /api/hr/settings failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to save HR settings' }, { status: 500 });
  }
}
