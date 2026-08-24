import { getDb } from '@/lib/db';
import { getCurrentUser, requireRole } from '@/lib/auth';
import {
  varianceBar, VARIANCE_BAR_KEYS,
  VARIANCE_BAR_MAX_VALUE, VARIANCE_BAR_MAX_QTY,
  VARIANCE_ALERT_MAX_VALUE, VARIANCE_ALERT_MAX_PCT,
  ALERT_MIN_VALUE, ALERT_MIN_QTY, AUTO_APPLY_HARD_VALUE_CEILING,
  AUTO_APPLY_BATCH_VALUE, AUTO_APPLY_BATCH_ROWS,
} from '@/lib/variance-approval';

/**
 * THE VARIANCE BAR — read it, and (admin only) set it.
 * ═══════════════════════════════════════════════════════════════════════════
 * Four numbers, all stored in `settings` like every other tunable in this app,
 * all defaulting to 0 = OFF:
 *
 *   closing_variance_bar_value   ₹ — at or under this, a variance APPLIES ITSELF
 *   closing_variance_bar_qty     purchase units — same, on the quantity axis
 *   closing_variance_alert_value ₹ — at or over this, the immediate alert fires
 *   closing_variance_alert_pct   % of the item's own system stock — same
 *
 * The bar's two axes are an AND, not an OR: a variance is only "small" when
 * every axis the admin has configured agrees it is small. The alert's two are an
 * OR — whichever fires first — because it is an alert and its job is to catch
 * the case the other axis misses.
 *
 * ── WHY THIS ROUTE EXISTS AT ALL ──────────────────────────────────────────
 * The generic PUT /api/settings is MANAGER-OR-ADMIN. This bar decides how much
 * stock movement happens with no admin in the loop, so a manager who could write
 * it could lift the very gate they are subject to — the same self-lift hole
 * KEY_POLICY closes for purchase_backdate_limit_days and po_require_admin_approval
 * (src/app/api/settings/route.ts:44-59). This route is the ADMIN-ONLY door.
 *
 * ALL FOUR KEYS ARE NOW REGISTERED THERE as `write: 'admin'`, so the generic
 * endpoint 403s a manager on them too. Keep both: this route validates and
 * clamps, that table is the blanket rule, and the reader varianceBar() clamps a
 * third time. Do NOT delete the KEY_POLICY rows as "redundant with this route"
 * — the generic writer takes any key it is not told about, and being told is
 * the whole mechanism.
 *
 * The clamps are NOT the containment they were once described as. They bound
 * quantity and percentage; they have no rupee opinion, so a qty-only bar
 * auto-applied ₹1.27 lakh on a single bottle line. The rupee containment is
 * AUTO_APPLY_HARD_VALUE_CEILING in the lib, enforced on every auto-apply.
 *
 * ── WHAT IT DELIBERATELY CANNOT DO ────────────────────────────────────────
 * Writing a bar NEVER moves stock, and never re-decides a row. The bar is read
 * only at count time for the count being saved (see recordCountVariance), so
 * lowering it tomorrow cannot silently apply yesterday's held variances, and
 * raising it cannot un-apply anything. A pending row stays pending until a human
 * decides it. This route runs no UPDATE outside `settings`.
 *
 * GET  → the effective (clamped) bar + the limits, for any signed-in user. The
 *        numbers are policy, not a system-stock oracle: knowing "differences
 *        under ₹50 apply themselves" tells a counter nothing about what any
 *        item's system figure IS. Blind counts are untouched.
 * PUT  → admin only. Body: any subset of
 *        { bar_value, bar_qty, alert_value, alert_pct }. Returns the effective
 *        bar AFTER the write, so a clamped value is visible as clamped rather
 *        than echoed back as typed.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const LIMITS = {
  bar_value: VARIANCE_BAR_MAX_VALUE,
  bar_qty: VARIANCE_BAR_MAX_QTY,
  alert_value: VARIANCE_ALERT_MAX_VALUE,
  alert_pct: VARIANCE_ALERT_MAX_PCT,
} as const;

const FIELD_TO_KEY = {
  bar_value: VARIANCE_BAR_KEYS.value,
  bar_qty: VARIANCE_BAR_KEYS.qty,
  alert_value: VARIANCE_BAR_KEYS.alertValue,
  alert_pct: VARIANCE_BAR_KEYS.alertPct,
} as const;

type Field = keyof typeof FIELD_TO_KEY;

function payload(db: ReturnType<typeof getDb>) {
  const bar = varianceBar(db);
  return {
    bar: {
      bar_value: bar.value,
      bar_qty: bar.qty,
      alert_value: bar.alertValue,
      alert_pct: bar.alertPct,
    },
    limits: LIMITS,
    keys: FIELD_TO_KEY,
    /** true when at least one auto-apply axis is armed. */
    auto_apply_enabled: bar.value > 0 || bar.qty > 0,
    /** true when at least one alert axis is armed. */
    alerts_enabled: bar.alertValue > 0 || bar.alertPct > 0,
    /**
     * The fixed guards around the two tunables. SERVED rather than duplicated in
     * the page, because the queue draws its own "Large — look now" pill from a
     * client-side twin of isBigVariance(): a literal copied into a .tsx is a
     * drift surface, and a pill that disagrees with the bell about which rows
     * are big is worse than no pill. Not settable — see the lib for why each is
     * a constant.
     *
     *  alert_min_value / alert_min_qty  the materiality floor UNDER the alert's
     *      share axis (₹, and purchase units for unpriced materials). A counted
     *      0 is 100% by arithmetic; without a floor the share axis fires on
     *      70-100% of every upload.
     *  auto_apply_max_value  no variance worth more than this may EVER apply
     *      itself, whichever axis is configured.
     *  auto_apply_batch_value / _rows  the circuit-breaker on ONE upload: past
     *      these, the rest of that upload is held rather than applied.
     */
    guards: {
      alert_min_value: ALERT_MIN_VALUE,
      alert_min_qty: ALERT_MIN_QTY,
      auto_apply_max_value: AUTO_APPLY_HARD_VALUE_CEILING,
      auto_apply_batch_value: AUTO_APPLY_BATCH_VALUE,
      auto_apply_batch_rows: AUTO_APPLY_BATCH_ROWS,
    },
  };
}

export async function GET() {
  // SELF-AUTHENTICATING. src/proxy.ts guards PAGES, not API routes, so every
  // route here checks its own caller.
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  return Response.json(payload(getDb()));
}

export async function PUT(request: Request) {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* empty body */ }

  const db = getDb();
  const write = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const changed: string[] = [];

  for (const field of Object.keys(FIELD_TO_KEY) as Field[]) {
    if (!(field in body)) continue;                 // absent = leave alone
    const raw = body[field];
    // An explicit null/'' means "turn this axis off", which is 0 — the same
    // value a fresh install has. Anything unparseable is a refusal, not a
    // silent 0: writing 0 for a typo would quietly disarm a bar an admin
    // believes is set, and disarming reads as "nothing is being auto-applied"
    // long before anyone notices.
    let n: number;
    if (raw === null || raw === '') {
      n = 0;
    } else {
      n = Number(raw);
      if (!Number.isFinite(n) || n < 0) {
        return Response.json(
          { error: `${field} must be a number >= 0 (0 turns this axis off)` }, { status: 400 },
        );
      }
      if (n > LIMITS[field]) {
        return Response.json({
          error: `${field} may not exceed ${LIMITS[field]}. `
            + (field === 'bar_value' || field === 'bar_qty'
              ? 'This is the ceiling on what may move stock with no admin in the loop — a bigger difference has to be looked at.'
              : 'That is past any useful alert threshold.'),
        }, { status: 400 });
      }
    }
    write.run(FIELD_TO_KEY[field], String(n));
    changed.push(field);
  }

  if (changed.length === 0) {
    return Response.json(
      { error: 'Nothing to change — send at least one of bar_value, bar_qty, alert_value, alert_pct.' },
      { status: 400 },
    );
  }

  // Re-read through varianceBar() so what comes back is the EFFECTIVE bar after
  // clamping, not what was typed.
  return Response.json({ ok: true, changed, ...payload(db) });
}

// POST is an alias for PUT, matching /api/settings — the write is an idempotent
// upsert on a PRIMARY KEY, and some clients POST.
export const POST = PUT;
