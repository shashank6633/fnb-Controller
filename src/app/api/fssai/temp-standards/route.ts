/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentOutletId, isManagement } from '@/lib/auth';
import {
  FSSAI_TEMP_LOG_KINDS, FSSAI_TEMP_UOMS, FSSAI_EQUIPMENT_KINDS,
  FSSAI_OIL_TPM_LIMIT_PCT, isFssaiTempLogKind,
} from '@/lib/fssai';
import {
  requireFssaiUser, requireFssaiAdmin, fssaiCsrfGuard, fssaiAudit, str,
} from '@/lib/fssai-server';
import { fssaiNum, fssaiInt } from '../_p4/lib';

/**
 * WAS THIS A UNIQUE-INDEX REFUSAL?
 *
 * ⚠️ WHY NOT `constraintMessage` FROM fssai-server, which exists for exactly this
 * and is used by five other routes. It returns its `fallback` for any constraint
 * it does not recognise, and it recognises the P1 indexes only — `uq_fssai_std_code`
 * is not among them (it may not be: the shared file is W1's and not this lane's to
 * edit). Called as `constraintMessage(e, '')` it would hand back `''`, which is
 * FALSY, so an `if (msg)` guard would sail straight past a real duplicate code and
 * answer 500 instead of 409. That is the "guard that reads correctly and never
 * fires" shape this project has been bitten by four times, so the test is made
 * explicit here instead of being inferred from a truthy string.
 *
 * ⚠️ UNIQUE ONLY — NOT EVERY CONSTRAINT (measured 2026-10-14). This used to
 * match any `SQLITE_CONSTRAINT*`, so a NOT NULL failure (create_suggested bound
 * a missing `notes` as NULL into `notes TEXT NOT NULL`) came back as "One of
 * those rules already exists under the same code" on an EMPTY table — 409,
 * nothing written, and cooling could never be switched on. A NOT NULL or CHECK
 * failure is a bug in this route and must surface as one (500 with the
 * message), never be dressed up as a duplicate.
 */
function isUniqueRefusal(e: any): boolean {
  const code = String(e?.code || '');
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

/** Cooling and reheating — the kinds judged on a clock, whose rule can carry a
 *  starting temperature for the schedule line. */
function isRateAppliesTo(v: string): boolean {
  return !!FSSAI_TEMP_LOG_KINDS.find((k) => k.key === v)?.window_minutes;
}

/**
 * THE SAFE RANGES (/api/fssai/temp-standards) — owner §5 made real:
 * "Temperature standards configurable from Settings, NEVER hard-coded."
 *
 * ── WHAT A STANDARD IS ──────────────────────────────────────────────────────
 * One rule: a minimum, a maximum, optionally a target and a clock, a unit, and
 * what it applies to. `applies_to` is a temperature KIND (`FSSAI_TEMP_LOG_KINDS`)
 * or `'oil'` / `'water'`, so a reading finds its rule by kind and — optionally —
 * by equipment kind or by item. A rule for ONE unit does not live here at all: it
 * lives on `fssai_equipment.min_temp` / `max_temp`, which WINS. Most specific
 * first, resolved in one place (`_p4/lib.ts` → `resolveFssaiRange`).
 *
 * ── THIS ROUTE IS SHARED WITH P5, DELIBERATELY ──────────────────────────────
 * `fssai_temp_standards` also carries the oil rule (`applies_to='oil'`, the TPM
 * percentage) and the water rules (`'water'`, pH / residual chlorine / TDS).
 * P4 owns the table per the phase split, so this is the ONE authoring surface for
 * all of them and the oil and water lanes READ it rather than writing a second
 * one. That is the rival-helper trap avoided on purpose: two routes inserting into
 * one table with two different notions of what `uom` means would disagree
 * silently, which is exactly how this project lost a day to two `sales-slice.ts`
 * files with the same export signature.
 *
 * ── NOTHING IS SEEDED HERE, AND THAT IS NOT AN OVERSIGHT ────────────────────
 * `GET` returns a SUGGESTED list the admin can create with one press, including
 * the FSSAI TPM limit of 25%. It does NOT write them. A seed that runs on boot or
 * on first read RESURRECTS ROWS AN ADMIN DELETED — db.ts's own HRMS block states
 * the trap in those words, because `INSERT OR IGNORE` keyed on `code` cannot tell
 * "never seeded" from "seeded and then deliberately retired". The idempotency
 * machinery for a real pack is `fssai_seed_log` + `uq_fssai_seed_item`, and that
 * belongs to P8. Until then, every row here was created by a person, and the
 * audit row says who.
 *
 * ── NO DELETE (owner §19) ───────────────────────────────────────────────────
 * A standard is RETIRED (`is_active = 0`). Readings that cited it keep
 * `standard_id` pointing at it, so the record can still name the rule it was
 * judged by. Deleting the row would turn every one of those into an unanswerable
 * question.
 *
 *   GET  [?applies_to=&include_inactive=1]
 *   POST { action: 'create' | 'update' | 'retire' | 'restore' | 'create_suggested', … }
 */
export const dynamic = 'force-dynamic';

/** `applies_to` values that are not a temperature kind. */
const EXTRA_APPLIES_TO: readonly { key: string; label: string; hint: string }[] = [
  { key: 'oil',   label: 'Frying oil',  hint: 'Total polar materials, free fatty acids or a strip reading.' },
  { key: 'water', label: 'Water & ice', hint: 'pH, residual chlorine, TDS or a lab parameter.' },
] as const;

function isAppliesTo(v: string): boolean {
  return isFssaiTempLogKind(v) || EXTRA_APPLIES_TO.some((e) => e.key === v);
}

function appliesToLabel(v: string): string {
  return FSSAI_TEMP_LOG_KINDS.find((k) => k.key === v)?.label
    || EXTRA_APPLIES_TO.find((e) => e.key === v)?.label
    || v;
}

/**
 * The units a standard may be expressed in.
 *
 * ⚠️ WIDER THAN `FSSAI_TEMP_UOMS` ON PURPOSE, and this is the one place in P4
 * where that matters. The table's own comment says `uom` is `C|F|pct|ppm|pH`,
 * because the same table holds the oil TPM percentage and the water chlorine
 * figure. `FSSAI_TEMP_UOMS` is the TEMPERATURE pair and is used verbatim for the
 * equipment register and the reading form; this list is the standard's own, and it
 * is derived from that pair rather than retyping °C and °F — so adding a
 * temperature unit in `fssai.ts` reaches here with no edit.
 */
const STANDARD_UOMS: readonly { key: string; label: string }[] = [
  ...FSSAI_TEMP_UOMS,
  { key: 'pct', label: '%' },
  { key: 'ppm', label: 'ppm' },
  { key: 'pH', label: 'pH' },
  { key: 'min', label: 'minutes' },
];

const STD_SELECT = `
  SELECT s.id, s.code, s.label, s.applies_to, s.equipment_kind, s.material_id,
         s.min_value, s.max_value, s.target_value, s.uom, s.decimals, s.max_minutes,
         s.authority, s.notes, s.is_active, s.is_seeded, s.sort_order,
         s.created_by, s.created_at, s.updated_at, s.start_value,
         IFNULL(m.name,'') AS material_name
    FROM fssai_temp_standards s
    LEFT JOIN raw_materials m ON m.id = s.material_id`;

function shapeStandard(row: any) {
  const min = fssaiNum(row.min_value);
  const max = fssaiNum(row.max_value);
  return {
    id: String(row.id),
    code: String(row.code || ''),
    label: String(row.label || ''),
    applies_to: String(row.applies_to || ''),
    applies_to_label: appliesToLabel(String(row.applies_to || '')),
    equipment_kind: String(row.equipment_kind || ''),
    equipment_kind_label: FSSAI_EQUIPMENT_KINDS.find((k) => k.key === String(row.equipment_kind))?.label || '',
    material_id: String(row.material_id || ''),
    material_name: String(row.material_name || ''),
    min_value: min,
    max_value: max,
    target_value: fssaiNum(row.target_value),
    /* A standard with NEITHER bound and NO clock judges nothing. Said as a flag
     * rather than left to the screen to work out, because a list of rules that
     * silently includes a rule that cannot fire is the inert-guard shape. */
    judges_anything: min !== null || max !== null || (fssaiInt(row.max_minutes) ?? 0) > 0,
    uom: String(row.uom || 'C'),
    decimals: fssaiInt(row.decimals) ?? 1,
    max_minutes: fssaiInt(row.max_minutes),
    /* Cooling / reheating: the temperature the schedule line starts from at 0
     * minutes when a batch has no 0-minute reading. null = none, and such a
     * batch's readings short of the target are then failed, never passed. */
    start_value: fssaiNum(row.start_value),
    authority: String(row.authority || ''),
    notes: String(row.notes || ''),
    is_active: Number(row.is_active) ? 1 : 0,
    is_seeded: Number(row.is_seeded) ? 1 : 0,
    sort_order: Number(row.sort_order) || 0,
    created_by: String(row.created_by || ''),
    created_at: String(row.created_at || ''),
    updated_at: String(row.updated_at || ''),
  };
}

/**
 * THE RULES AN ADMIN IS MOST LIKELY TO WANT, offered and never written.
 *
 * ⚠️ READ THIS BEFORE CHANGING A NUMBER BELOW. These are STARTING POINTS the
 * owner edits, not the law of the module. Nothing in the code compares a reading
 * against any constant here: every verdict goes through the stored row, which is
 * the whole point of §5. The one figure that is a published FSSAI limit —
 * 25% total polar materials in frying oil — comes from `FSSAI_OIL_TPM_LIMIT_PCT`
 * in `src/lib/fssai.ts` rather than being retyped, so there is exactly one place
 * it can be wrong.
 *
 * `authority` is filled in with where the number came from, in words, because an
 * inspector's first question about a range is "whose number is that".
 *
 * `start_value` (cooling and reheating only) is the schedule line's 0-minute
 * anchor for a batch with no 0-minute reading of its own, picked on the STRICT
 * side of where such food starts: cooling from 60 °C (cooked food is at or above
 * it, and a lower start draws a lower — stricter — line), reheating from 5 °C
 * (chilled food is at or below it, and a higher start draws a higher — stricter —
 * line). `notes` is bound as '' because the column is NOT NULL: leaving it out
 * bound NULL and made this button answer 409 on an empty table.
 */
function suggestedStandards() {
  return [
    { code: 'TEMP-CHILLER', label: 'Chiller and cold room', applies_to: 'equipment', equipment_kind: 'chiller', min_value: 0, max_value: 5, target_value: 4, uom: 'C', decimals: 1, max_minutes: null, start_value: null, notes: '', authority: 'Common chilled-storage practice — confirm against your own equipment.' },
    { code: 'TEMP-COLDROOM', label: 'Cold room', applies_to: 'equipment', equipment_kind: 'cold_room', min_value: 0, max_value: 5, target_value: 4, uom: 'C', decimals: 1, max_minutes: null, start_value: null, notes: '', authority: 'Common chilled-storage practice — confirm against your own equipment.' },
    { code: 'TEMP-FREEZER', label: 'Freezer', applies_to: 'equipment', equipment_kind: 'freezer', min_value: null, max_value: -18, target_value: -20, uom: 'C', decimals: 1, max_minutes: null, start_value: null, notes: '', authority: 'Frozen storage at or below −18 °C.' },
    { code: 'TEMP-HOTHOLD', label: 'Hot holding', applies_to: 'hot_holding', equipment_kind: '', min_value: 60, max_value: null, target_value: 65, uom: 'C', decimals: 1, max_minutes: null, start_value: null, notes: '', authority: 'Hot food held at or above 60 °C.' },
    { code: 'TEMP-COOKING', label: 'Cooking core temperature', applies_to: 'cooking', equipment_kind: '', min_value: 75, max_value: null, target_value: 75, uom: 'C', decimals: 1, max_minutes: null, start_value: null, notes: '', authority: 'Core temperature at the end of cooking.' },
    { code: 'TEMP-COOLING', label: 'Cooling after cooking', applies_to: 'cooling', equipment_kind: '', min_value: null, max_value: 5, target_value: 5, uom: 'C', decimals: 1, max_minutes: 240, start_value: 60, notes: '', authority: 'Cooked food brought down within a set time — a RATE, not a level.' },
    { code: 'TEMP-REHEAT', label: 'Reheating', applies_to: 'reheating', equipment_kind: '', min_value: 75, max_value: null, target_value: 75, uom: 'C', decimals: 1, max_minutes: 120, start_value: 5, notes: '', authority: 'Reheated through within a set time.' },
    { code: 'TEMP-DELIVERY-CHILL', label: 'Chilled delivery at the door', applies_to: 'delivery', equipment_kind: '', min_value: null, max_value: 5, target_value: null, uom: 'C', decimals: 1, max_minutes: null, start_value: null, notes: '', authority: 'Chilled goods on arrival.' },
    { code: 'OIL-TPM', label: 'Frying oil — total polar materials', applies_to: 'oil', equipment_kind: 'fryer', min_value: null, max_value: FSSAI_OIL_TPM_LIMIT_PCT, target_value: null, uom: 'pct', decimals: 1, max_minutes: null, start_value: null, notes: '', authority: `FSSAI limit on total polar materials in frying oil: ${FSSAI_OIL_TPM_LIMIT_PCT}%. Oil above it must not be used.` },
  ];
}

export async function GET(request: Request) {
  // Readable by any signed-in user: the reading form shows the applicable range
  // before the number is typed, and a staff member who cannot see it cannot tell
  // a not-judged reading from a bug.
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;

  try {
    const db = getDb();
    const url = new URL(request.url);
    const appliesTo = str(url.searchParams.get('applies_to'));
    const includeInactive = url.searchParams.get('include_inactive') === '1';

    const where: string[] = [];
    const args: any[] = [];
    if (appliesTo) {
      if (!isAppliesTo(appliesTo)) {
        return Response.json({ error: `"${appliesTo}" is not something a standard can apply to.` }, { status: 400 });
      }
      where.push('s.applies_to = ?'); args.push(appliesTo);
    }
    if (!includeInactive) where.push('s.is_active = 1');

    const rows = db.prepare(
      `${STD_SELECT}
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY s.is_active DESC, s.applies_to ASC, s.sort_order ASC, s.label ASC
       LIMIT 300`,
    ).all(...args) as any[];

    const standards = rows.map(shapeStandard);
    const haveCodes = new Set(
      (db.prepare(`SELECT code FROM fssai_temp_standards WHERE code <> ''`).all() as any[])
        .map((r) => String(r.code)),
    );

    return Response.json({
      standards,
      /* Only the ones not already created, so the button never offers a duplicate
       * that `uq_fssai_std_code` would then refuse. */
      suggested: suggestedStandards().filter((s) => !haveCodes.has(s.code)),
      can_edit: me.role === 'admin',
      is_management: isManagement(me),
      vocab: {
        applies_to: [
          ...FSSAI_TEMP_LOG_KINDS.map((k) => ({ key: k.key as string, label: k.label, hint: k.hint })),
          ...EXTRA_APPLIES_TO,
        ],
        uoms: STANDARD_UOMS,
        equipment_kinds: FSSAI_EQUIPMENT_KINDS,
        /* Which kinds are judged on a CLOCK as well as a level, so the form shows
         * the minutes field only where it means something. */
        clock_kinds: FSSAI_TEMP_LOG_KINDS.filter((k) => k.window_minutes).map((k) => k.key as string),
      },
      /* THE RULE AN ADMIN MUST KNOW BEFORE EDITING, in the payload so no screen
       * can forget to say it. */
      law: 'A range set on one unit beats the general rule for its kind. Changing a rule here never re-grades a reading already in the file — each reading keeps the range that was actually applied to it.',
    });
  } catch (e: any) {
    console.error('GET /api/fssai/temp-standards failed:', e);
    return Response.json({ error: e?.message || 'Failed to load the safe ranges' }, { status: 500 });
  }
}

function validateStandard(body: any, existing: any | null): { error: string } | { ok: true; v: any } {
  const label = str(body?.label ?? existing?.label).slice(0, 200);
  if (!label) return { error: 'Give the rule a name, so a record can say which rule judged it.' };

  const appliesTo = str(body?.applies_to ?? existing?.applies_to) || 'equipment';
  if (!isAppliesTo(appliesTo)) return { error: `"${appliesTo}" is not something a standard can apply to.` };

  const uom = str(body?.uom ?? existing?.uom) || 'C';
  if (!STANDARD_UOMS.some((u) => u.key === uom)) {
    return { error: `"${uom}" is not a unit this rule can be written in.` };
  }

  const equipmentKind = str(body?.equipment_kind ?? existing?.equipment_kind);
  if (equipmentKind && !FSSAI_EQUIPMENT_KINDS.some((k) => k.key === equipmentKind)) {
    return { error: `"${equipmentKind}" is not a kind of unit this register knows.` };
  }

  const pick = (k: string) => (body?.[k] !== undefined ? fssaiNum(body[k]) : fssaiNum(existing?.[k]));
  const min = pick('min_value');
  const max = pick('max_value');
  const target = pick('target_value');
  const maxMinutes = body?.max_minutes !== undefined ? fssaiInt(body.max_minutes) : fssaiInt(existing?.max_minutes);

  if (body?.min_value !== undefined && str(body.min_value) !== '' && min === null) return { error: 'The minimum is not a number.' };
  if (body?.max_value !== undefined && str(body.max_value) !== '' && max === null) return { error: 'The maximum is not a number.' };
  if (min !== null && max !== null && min > max) {
    return { error: `This rule reads ${min} to ${max}. A minimum above its maximum would fail every reading taken against it.` };
  }
  if (maxMinutes !== null && maxMinutes <= 0) {
    return { error: 'A time limit has to be more than zero minutes. Leave it empty if this rule is about a level and not a clock.' };
  }
  /* A RULE THAT CANNOT FIRE IS REFUSED, not silently stored. This is the
   * inert-guard shape the whole project has been bitten by four times: a guard
   * that exists, reads correctly and never fires. A standard with no bound and no
   * clock would appear on the settings screen, be cited by `standard_id` on
   * readings, and judge nothing at all. */
  if (min === null && max === null && maxMinutes === null) {
    return {
      error: 'This rule has no minimum, no maximum and no time limit, so it could never judge a reading — it would sit on the list looking like a safeguard. Set at least one of them.',
    };
  }

  /* ── COOLING AND REHEATING: THE TEMPERATURE TO REACH, AND WHERE THE LINE STARTS ──
   * A rate rule with no temperature to reach (no target and no bound on the safe
   * side) can never say a pot got there, so every reading short of it would be
   * "not judged" — the inert-guard shape again. Refused. */
  const rate = isRateAppliesTo(appliesTo);
  const dir = FSSAI_TEMP_LOG_KINDS.find((k) => k.key === appliesTo)?.direction || 'either';
  const goal = target !== null ? target : (dir === 'hot' ? min : max);
  if (rate && goal === null) {
    return {
      error: dir === 'hot'
        ? 'A reheating rule needs the temperature the food has to reach — a target or a minimum. Without one nothing can say whether it got there.'
        : 'A cooling rule needs the temperature the food has to come down to — a target or a maximum. Without one nothing can say whether it got there.',
    };
  }
  const startRaw = body?.start_value !== undefined ? body.start_value : existing?.start_value;
  const startValue = fssaiNum(startRaw);
  if (body?.start_value !== undefined && str(body.start_value) !== '' && body.start_value !== null && startValue === null) {
    return { error: 'The starting temperature is not a number.' };
  }
  if (startValue !== null && !rate) {
    return {
      error: 'A starting temperature belongs only to a cooling or reheating rule — it is where the schedule line starts. Leave it empty for this one.',
    };
  }
  if (startValue !== null && goal !== null && (dir === 'hot' ? startValue >= goal : startValue <= goal)) {
    return {
      error: dir === 'hot'
        ? `Reheating starts below the temperature it has to reach. A starting temperature of ${startValue} with a target of ${goal} would draw no schedule at all.`
        : `Cooling starts above the temperature it has to come down to. A starting temperature of ${startValue} with a target of ${goal} would draw no schedule at all.`,
    };
  }

  const decimals = body?.decimals !== undefined ? fssaiInt(body.decimals) : fssaiInt(existing?.decimals);
  const d = decimals === null || decimals < 0 || decimals > 3 ? 1 : decimals;

  return {
    ok: true,
    v: {
      code: str(body?.code ?? existing?.code).slice(0, 60),
      label,
      applies_to: appliesTo,
      equipment_kind: equipmentKind,
      material_id: str(body?.material_id ?? existing?.material_id),
      min_value: min,
      max_value: max,
      target_value: target,
      uom,
      decimals: d,
      max_minutes: maxMinutes,
      start_value: startValue,
      authority: str(body?.authority ?? existing?.authority).slice(0, 500),
      notes: str(body?.notes ?? existing?.notes).slice(0, 2000),
      sort_order: Number(body?.sort_order ?? existing?.sort_order) || 0,
    },
  };
}

export async function POST(request: Request) {
  const csrf = fssaiCsrfGuard(request);
  if (csrf) return csrf;
  const g = await requireFssaiAdmin();
  if ('resp' in g) return g.resp;
  const me = g.me;

  let body: any = {};
  try { body = await request.json(); } catch { /* validated below */ }

  try {
    const db = getDb();
    const outletId = (await getCurrentOutletId()) || '';
    const action = str(body?.action) || 'create';

    const insert = (v: any, isSeeded: 0) => {
      const id = generateId();
      db.prepare(
        `INSERT INTO fssai_temp_standards
           (id, code, label, applies_to, equipment_kind, material_id,
            min_value, max_value, target_value, uom, decimals, max_minutes,
            authority, notes, is_active, is_seeded, sort_order, created_by, outlet_id,
            start_value)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      ).run(
        /* Every TEXT NOT NULL column goes through str(): a value left out of the
         * object binds NULL and fails the NOT NULL, which is how the
         * suggested-rules button refused on an empty table. */
        id, str(v.code), str(v.label), str(v.applies_to), str(v.equipment_kind), str(v.material_id),
        fssaiNum(v.min_value), fssaiNum(v.max_value), fssaiNum(v.target_value), str(v.uom) || 'C',
        fssaiInt(v.decimals) ?? 1, fssaiInt(v.max_minutes),
        str(v.authority), str(v.notes), isSeeded, Number(v.sort_order) || 0, me.email || '', outletId,
        fssaiNum(v.start_value),
      );
      fssaiAudit(db, {
        entity_table: 'fssai_temp_standards', entity_id: id, action: 'create',
        after: v, reason: str(body?.reason) || 'Safe range created',
        actor: { email: me.email, name: me.name }, outlet_id: outletId,
      });
      return id;
    };

    /* ══════════════════════════════════════════════════════════════════════
     * CREATE_SUGGESTED — the admin presses it; nothing boots it.
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'create_suggested') {
      const wanted: string[] = Array.isArray(body?.codes)
        ? body.codes.map((c: unknown) => str(c)).filter(Boolean)
        : suggestedStandards().map((s) => s.code);
      const pool = suggestedStandards().filter((s) => wanted.includes(s.code));
      if (!pool.length) {
        return Response.json({ error: 'None of those is a rule this screen can offer.' }, { status: 400 });
      }
      /* THE OFFERED RULES PASS THE SAME GATE A TYPED ONE DOES — so this button can
       * never store a rule validateStandard would refuse (an inert one, or an
       * anchor on the wrong side of its target). */
      for (const s of pool) {
        const chk = validateStandard(s, null);
        if ('error' in chk) {
          return Response.json({ error: `The offered rule ${s.code} is not valid: ${chk.error}`, code: 'bad_suggestion' }, { status: 500 });
        }
      }
      const created: string[] = [];
      const skipped: string[] = [];
      const tx = db.transaction(() => {
        for (const s of pool) {
          const dupe = db.prepare(
            `SELECT id FROM fssai_temp_standards WHERE code = ? AND outlet_id = ? LIMIT 1`,
          ).get(s.code, outletId) as any;
          if (dupe) { skipped.push(s.code); continue; }
          /* `is_seeded` STAYS 0. The column means "this row came from a seed pack
           * recorded in fssai_seed_log", and nothing here writes that log — so
           * claiming it would make P8 believe a pack had already run and skip the
           * twelve checklists. These rows were created by a person; the audit row
           * says which person. */
          insert({ ...s, material_id: '', sort_order: created.length }, 0);
          created.push(s.code);
        }
      });
      try { tx(); } catch (e: any) {
        if (isUniqueRefusal(e)) {
          return Response.json(
            { error: 'One of those rules already exists under the same code. Reload the list and try again.', code: 'duplicate_code' },
            { status: 409 },
          );
        }
        throw e;
      }
      return Response.json({
        ok: true, created, skipped,
        note: created.length
          ? `${created.length} rule${created.length === 1 ? '' : 's'} created. They are starting points, not the law — check every number against your own equipment and your licence conditions, and change what does not fit.`
          : 'Nothing was created — all of those rules are already on the list.',
      });
    }

    /* ══════════════════════════════════════════════════════════════════════
     * CREATE
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'create') {
      const checked = validateStandard(body, null);
      if ('error' in checked) return Response.json({ error: checked.error }, { status: 400 });
      let id = '';
      try {
        const tx = db.transaction(() => { id = insert(checked.v, 0); });
        tx();
      } catch (e: any) {
        /* `uq_fssai_std_code` is PARTIAL — unique on (outlet_id, code) only where
         * `code <> ''`. So two rules with a blank code are legitimate and only a
         * real reused code lands here. The refusal names it. */
        if (isUniqueRefusal(e)) {
          return Response.json(
            { error: `A rule with the code "${checked.v.code}" already exists. Codes are how a seed and a report find a rule again, so they cannot repeat.`, code: 'duplicate_code' },
            { status: 409 },
          );
        }
        throw e;
      }
      const row = db.prepare(`${STD_SELECT} WHERE s.id = ?`).get(id) as any;
      return Response.json({ ok: true, standard: shapeStandard(row) });
    }

    /* ══════════════════════════════════════════════════════════════════════
     * UPDATE
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'update') {
      const id = str(body?.id);
      if (!id) return Response.json({ error: 'Which rule? No id was sent.' }, { status: 400 });
      const existing = db.prepare(`SELECT * FROM fssai_temp_standards WHERE id = ?`).get(id) as any;
      if (!existing) return Response.json({ error: 'That rule is no longer on the list.' }, { status: 404 });

      const checked = validateStandard(body, existing);
      if ('error' in checked) return Response.json({ error: checked.error }, { status: 400 });
      const v = checked.v;

      try {
        const tx = db.transaction(() => {
          db.prepare(
            `UPDATE fssai_temp_standards
                SET code=?, label=?, applies_to=?, equipment_kind=?, material_id=?,
                    min_value=?, max_value=?, target_value=?, uom=?, decimals=?, max_minutes=?,
                    authority=?, notes=?, sort_order=?, start_value=?, updated_at=datetime('now')
              WHERE id=?`,
          ).run(
            str(v.code), str(v.label), str(v.applies_to), str(v.equipment_kind), str(v.material_id),
            v.min_value, v.max_value, v.target_value, str(v.uom) || 'C', v.decimals, v.max_minutes,
            str(v.authority), str(v.notes), v.sort_order, v.start_value, id,
          );
          fssaiAudit(db, {
            entity_table: 'fssai_temp_standards', entity_id: id, action: 'update',
            before: {
              code: existing.code, label: existing.label, applies_to: existing.applies_to,
              equipment_kind: existing.equipment_kind, material_id: existing.material_id,
              min_value: fssaiNum(existing.min_value), max_value: fssaiNum(existing.max_value),
              target_value: fssaiNum(existing.target_value), uom: existing.uom,
              max_minutes: fssaiInt(existing.max_minutes),
              start_value: fssaiNum(existing.start_value),
            },
            after: v,
            reason: str(body?.reason) || 'Safe range changed',
            actor: { email: me.email, name: me.name }, outlet_id: outletId || existing.outlet_id || '',
          });
        });
        tx();
      } catch (e: any) {
        if (isUniqueRefusal(e)) {
          return Response.json({ error: `A rule with the code "${v.code}" already exists.`, code: 'duplicate_code' }, { status: 409 });
        }
        throw e;
      }

      const cited = Number((db.prepare(
        `SELECT COUNT(*) AS n FROM fssai_temperature_logs WHERE standard_id = ? AND status <> 'void'`,
      ).get(id) as any)?.n) || 0;

      const row = db.prepare(`${STD_SELECT} WHERE s.id = ?`).get(id) as any;
      return Response.json({
        ok: true,
        standard: shapeStandard(row),
        records_unchanged: cited,
        note: `The new numbers apply from now on. The ${cited} reading${cited === 1 ? '' : 's'} already judged by this rule keep the range that was actually applied to them.`,
      });
    }

    /* ══════════════════════════════════════════════════════════════════════
     * RETIRE / RESTORE — never a delete (owner §19).
     * ════════════════════════════════════════════════════════════════════ */
    if (action === 'retire' || action === 'restore') {
      const id = str(body?.id);
      if (!id) return Response.json({ error: 'Which rule? No id was sent.' }, { status: 400 });
      const existing = db.prepare(`SELECT * FROM fssai_temp_standards WHERE id = ?`).get(id) as any;
      if (!existing) return Response.json({ error: 'That rule is no longer on the list.' }, { status: 404 });

      const wantActive = action === 'restore' ? 1 : 0;
      if (Number(existing.is_active) === wantActive) {
        return Response.json(
          { error: wantActive ? 'That rule is already in use.' : 'That rule is already retired.', code: 'already' },
          { status: 409 },
        );
      }
      const reason = str(body?.reason).slice(0, 2000);
      if (!wantActive && reason.length < 4) {
        return Response.json(
          {
            error: 'Say why this rule is being retired. Readings taken after it goes will be recorded and marked as not judged unless another rule covers them, so somebody will ask.',
            code: 'reason_required',
          },
          { status: 400 },
        );
      }

      const tx = db.transaction(() => {
        const res = db.prepare(
          `UPDATE fssai_temp_standards SET is_active=?, updated_at=datetime('now') WHERE id=? AND is_active=?`,
        ).run(wantActive, id, wantActive ? 0 : 1);
        if (res.changes !== 1) throw new Error('FSSAI_STD_MOVED');
        fssaiAudit(db, {
          entity_table: 'fssai_temp_standards', entity_id: id,
          action: wantActive ? 'reopen' : 'void', field: 'is_active',
          before: { is_active: Number(existing.is_active) ? 1 : 0 },
          after: { is_active: wantActive },
          reason: reason || 'Back in use',
          actor: { email: me.email, name: me.name }, outlet_id: outletId || existing.outlet_id || '',
        });
      });
      try { tx(); } catch (e: any) {
        if (String(e?.message) === 'FSSAI_STD_MOVED') {
          return Response.json({ error: 'Somebody has just changed this rule. Reload and try again.', code: 'already_moved' }, { status: 409 });
        }
        throw e;
      }

      const row = db.prepare(`${STD_SELECT} WHERE s.id = ?`).get(id) as any;
      return Response.json({
        ok: true,
        standard: shapeStandard(row),
        note: wantActive
          ? 'Back in use. It applies to readings taken from now on.'
          : 'Retired. Readings already judged by it still name it, so the file can still say what rule was applied.',
      });
    }

    return Response.json(
      { error: `"${action}" is not something that can be done to a safe range. Use create, update, retire, restore or create_suggested.` },
      { status: 400 },
    );
  } catch (e: any) {
    console.error('POST /api/fssai/temp-standards failed:', e);
    return Response.json({ error: e?.message || 'Failed to save that' }, { status: 500 });
  }
}

/* No DELETE. See the header: a reading that cited a rule must still be able to
 * name it, so a rule is retired and never removed (owner §19). */
