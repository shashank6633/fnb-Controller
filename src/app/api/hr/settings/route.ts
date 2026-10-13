/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, logAuditEvent } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { canAdminHr, canManageHr } from '@/lib/hr';
import {
  getHrDayCutoff,
  getHrPunchDebounceMin,
  getHrOrgState,
  getHrRosterRotateShifts,
  getHrRosterOffsWeekdays,
  getHrWeeklyOffPolicy,
  getHrPayrollProrationBasis,
} from '@/lib/hr-attendance';
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
 * Plus the PAYROLL state scope (same KV, same gates):
 *   · hr_org_state         free text, default '' — the state payroll resolves
 *                          statutory rates in, matched EXACTLY against
 *                          hr_statutory_configs.state. '' IS A LEGITIMATE VALUE
 *                          meaning all-India rates only (what payroll did before
 *                          this setting existed), NOT an absence — which is why
 *                          it is the one key handled outside PUT_ALLOWLIST below.
 *
 * Plus the four ROSTER-GENERATOR policy knobs (same KV, same gates), each
 * defaulting to today's behaviour so registering them changes nothing:
 *   · hr_roster_rotate_shifts    0/1, default 1 — rotate people between shifts
 *                          (owner: "Usually should rotate"), or 0 to keep each
 *                          person on their usual shift and move only the off.
 *   · hr_roster_offs_weekdays CSV of 0=Sun..6=Sat, default '1,2,3,4' (Mon-Thu)
 *                          — the owner's HARD RULE, "it is a Pub, weekend is
 *                          more busy". EMPTY IS REFUSED, never read as "any day".
 *   · hr_weekly_off_policy  'unpaid' (default, = today: an off day is recorded
 *                          nowhere) or 'paid' (the generator writes an
 *                          hr_attendance WEEKLY_OFF row, which payroll already
 *                          treats as paid — no payroll arithmetic changes).
 *   · hr_payroll_proration_basis 'calendar_days' (default, = today) or
 *                          'working_days'; only meaningful once offs are
 *                          recorded, i.e. with hr_weekly_off_policy='paid'.
 *
 * ⚠️ THIS ROUTE'S PUT IS AN EXPLICIT ALLOWLIST, and so is the save() body on
 * /hr/settings. A key missing from EITHER side is ignored in silence and the
 * setting can then never be changed — that exact bug shipped in this repo this
 * week. Add a new key to BOTH, and prove the round trip.
 *
 * OWNERSHIP: the generic /api/settings route registers the `hr_` prefix in
 * KEY_POLICY/OWNED_PREFIXES and routes hr_* keys HERE (already wired) — this
 * route is the only writer, so the canAdminHr gate below actually holds.
 *
 * GET → { settings: <every key above>, configured_states: string[] }
 *       Management tier. Values are the EFFECTIVE ones (defaults applied when
 *       absent/invalid) via the same getters the engine itself reads through
 *       (src/lib/hr-attendance.ts) — the UI can never show a value the pairing
 *       engine is not actually using. configured_states lists the state
 *       spellings hr_statutory_configs rows already use, so the payroll-state
 *       control offers them instead of inviting a typo that matches nothing.
 * PUT { any subset of the keys above } → { settings }
 *       Admin only. Validates before writing: cutoff must be a real clock time
 *       'HH:MM' (stored zero-padded), debounce a positive integer ≤ 60, the
 *       roster knobs per their parsers below, hr_org_state text ≤ 64 chars.
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

/** Parse the rotate toggle into its STORED form '0' | '1', or null if invalid.
 *  Accepts a boolean, 0/1, or the strings 'true'/'false' — the page sends a
 *  checkbox and a scripted caller sends whichever it has. */
function parseRotate(v: unknown): '0' | '1' | null {
  const raw = String(v ?? '').trim().toLowerCase();
  if (raw === '1' || raw === 'true') return '1';
  if (raw === '0' || raw === 'false') return '0';
  return null;
}

/**
 * Parse the allowed off-weekdays into canonical sorted CSV ('1,2,3,4'), or null.
 * Accepts an array ([1,2,3]) or a CSV string; blank entries from a trailing
 * comma are skipped, but any non-weekday token is a refusal.
 *
 * AN EMPTY SELECTION IS A 400, NOT A STORED ''. A stored empty value is exactly
 * the thing the getter must never read as "any day is fine" — refusing it here
 * means the dangerous value never reaches the KV in the first place.
 *
 * Weekend days (0=Sun, 5=Fri, 6=Sat) are ACCEPTED when an admin deliberately
 * ticks one. The owner's hard rule is Mon-Thu and that is the default, but a
 * setting that cannot express a closed Monday is a setting he would have to go
 * around; the page warns in red before saving one instead of a server that
 * silently drops it.
 */
function parseOffsWeekdays(v: unknown): string | null {
  const parts = Array.isArray(v) ? v : String(v ?? '').split(',');
  const seen = new Set<number>();
  for (const p of parts) {
    const t = String(p ?? '').trim();
    if (!t) continue;
    // Single digit only — '3.5' and '12' are typos, never weekday 3 or 1.
    if (!/^\d$/.test(t)) return null;
    const n = Number(t);
    if (n < 0 || n > 6) return null;
    seen.add(n);
  }
  if (seen.size === 0) return null;
  return [...seen].sort((a, b) => a - b).join(',');
}

/** Parse the weekly-off policy, or null. 'unpaid' = today's behaviour. */
function parseWeeklyOffPolicy(v: unknown): 'unpaid' | 'paid' | null {
  const raw = String(v ?? '').trim().toLowerCase();
  return raw === 'unpaid' || raw === 'paid' ? raw : null;
}

/** Parse the proration basis, or null. 'calendar_days' = today's behaviour. */
function parseProrationBasis(v: unknown): 'calendar_days' | 'working_days' | null {
  const raw = String(v ?? '').trim().toLowerCase();
  return raw === 'calendar_days' || raw === 'working_days' ? raw : null;
}

/**
 * THE PUT ALLOWLIST. Every settable key appears here exactly once with its
 * parser; a key absent from this table is ignored in silence and can then never
 * be changed through this route. Adding a setting means adding a row HERE **and**
 * a field to save() on /hr/settings — both, or the knob is decorative.
 *
 * `parse` returns the value in its STORED form (string | number), or null for
 * "invalid", and `error` is the 400 message for that case.
 *
 * ONE DELIBERATE EXCEPTION: hr_org_state is handled explicitly in PUT below,
 * because '' is a legitimate value for it and it needs two distinct 400s (not
 * text / too long) where this table carries one message per key. It is NOT a
 * key that was forgotten — grep hr_org_state in PUT before concluding it is.
 */
const PUT_ALLOWLIST: Array<{
  key: string;
  parse: (v: unknown) => string | number | null;
  error: string;
}> = [
  {
    key: 'hr_day_cutoff',
    parse: parseCutoff,
    error: 'Day cutoff must be a time in HH:MM format (e.g. 04:00)',
  },
  {
    key: 'hr_punch_debounce_min',
    parse: parseDebounce,
    error: 'Punch debounce must be a whole number of minutes between 1 and 60',
  },
  {
    key: 'hr_roster_rotate_shifts',
    parse: parseRotate,
    error: 'Shift rotation must be on or off (1 or 0)',
  },
  {
    key: 'hr_roster_offs_weekdays',
    parse: parseOffsWeekdays,
    error:
      'Pick at least one weekday for weekly offs (0=Sunday … 6=Saturday). ' +
      'An empty list is not allowed — it would mean "any day".',
  },
  {
    key: 'hr_weekly_off_policy',
    parse: parseWeeklyOffPolicy,
    error: "Weekly-off policy must be 'unpaid' or 'paid'",
  },
  {
    key: 'hr_payroll_proration_basis',
    parse: parseProrationBasis,
    error: "Payroll proration basis must be 'calendar_days' or 'working_days'",
  },
];

/**
 * Every setting this route serves, read through THE getters the engine and the
 * generator themselves read through — so the UI can never show, and the audit
 * trail can never record, a value the code is not actually using (a garbage
 * stored value reports as the default it falls back to).
 *
 * ONE function, THREE callers (GET, the PUT before-image, the PUT after-image):
 * a second hand-written copy of this object is how a key ends up served by GET
 * and missing from the audit, or vice versa.
 */
function effectiveSettings(db: ReturnType<typeof getDb>) {
  return {
    hr_day_cutoff: getHrDayCutoff(db),
    hr_punch_debounce_min: getHrPunchDebounceMin(db),
    // Payroll's statutory state scope. Served from HERE and not hand-copied into
    // GET, so it cannot be served by GET and missing from the audit after-image —
    // which is how the payroll fix would silently stop being observable.
    hr_org_state: getHrOrgState(db),
    // Echoed in the STORED shapes (0/1 and CSV), not as a boolean and an array:
    // the page round-trips exactly what it will PUT back.
    hr_roster_rotate_shifts: getHrRosterRotateShifts(db) ? 1 : 0,
    hr_roster_offs_weekdays: getHrRosterOffsWeekdays(db).join(','),
    hr_weekly_off_policy: getHrWeeklyOffPolicy(db),
    hr_payroll_proration_basis: getHrPayrollProrationBasis(db),
  };
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
    // ONE settings object for the WHOLE page: the payroll card reads
    // hr_org_state + configured_states out of it and the roster card reads the
    // four hr_roster_*/hr_weekly_off/hr_payroll_proration keys, so dropping
    // either group here blanks a card that still PUTs its fields back.
    return Response.json({
      settings: effectiveSettings(db),
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
  const updates: Array<{ key: string; value: string }> = [];
  for (const field of PUT_ALLOWLIST) {
    if (body?.[field.key] === undefined) continue;
    const parsed = field.parse(body[field.key]);
    if (parsed === null) return Response.json({ error: field.error }, { status: 400 });
    // The KV column is TEXT — store every value as its string form.
    updates.push({ key: field.key, value: String(parsed) });
  }
  // hr_org_state — the state payroll resolves statutory rates in. '' is a
  // LEGITIMATE value, not an absence: it means "all-India rates only", which is
  // what payroll did before this setting existed. So it is tracked with its own
  // flag rather than by null-ness, or clearing it back to '' would be
  // indistinguishable from not sending it and could never be undone. That is
  // also why it is NOT a PUT_ALLOWLIST row: the loop above treats a parser's
  // null as "reject", leaving no way to say "store the empty string".
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
  // BOTH halves count as something to update. `updates.length === 0` alone would
  // 400 a PUT that only clears the payroll state, and the two groups arrive from
  // two independent cards on /hr/settings.
  if (updates.length === 0 && orgState === null) {
    return Response.json({ error: 'Nothing to update' }, { status: 400 });
  }

  // better-sqlite3 is synchronous — resolve every await BEFORE db.transaction.
  const outletId = await getCurrentOutletId();

  try {
    const db = getDb();

    // Before-image reads through the SAME effective getters as GET, so the
    // audit trail records the value the engine was actually using (a garbage
    // stored value audits as the default it fell back to).
    const before = effectiveSettings(db);

    const upsert = db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`);
    const write = db.transaction(() => {
      for (const u of updates) upsert.run(u.key, u.value);
      // Written on its own line, outside the allowlist loop, for the '' reason
      // above — a cleared payroll state must still reach the KV.
      if (orgState !== null) upsert.run('hr_org_state', orgState);

      // Re-read rather than merge the parsed values in: the after-image is then
      // what the getters will hand the generator on the very next request, which
      // is the only claim worth auditing (and the only one a reader can trust).
      const after = effectiveSettings(db);
      // The re-read is also what makes a CLEAR auditable: effectiveSettings goes
      // back to the KV, so emptying hr_org_state audits as ''. The merge it
      // replaced had to say `orgState ?? before` and NOT `orgState || before`,
      // because || would have quietly discarded exactly that clear.

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
