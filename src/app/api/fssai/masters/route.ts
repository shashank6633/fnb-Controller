/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import {
  FSSAI_QTYPES, FSSAI_FREQUENCIES, FSSAI_TARGET_KINDS, FSSAI_SHIFTS,
  FSSAI_MODULE_KEYS, FSSAI_EVIDENCE_RULES, FSSAI_EQUIPMENT_KINDS,
} from '@/lib/fssai';
import { requireFssaiAdmin } from '@/lib/fssai-server';

/**
 * EVERYTHING THE CHECKLIST BUILDER NEEDS TO FILL ITS DROPDOWNS, in one call
 * (/api/fssai/masters). ADMIN ONLY — it exists for the authoring screens.
 *
 * ⚠️ READ-ONLY, AND IT CREATES NOTHING. Owner §21 / HARD RULE 4: departments,
 * roles and users are production configuration the owner sets in his own
 * screens. FSSAI never writes them, and a new item, vendor, employee or ROLE
 * master inside this module is an automatic critical defect. This route is a
 * projection of tables that already exist — nothing more.
 *
 * It also returns the engine's own vocabularies so the builder cannot drift
 * from the server: one list of question types, frequencies, target kinds,
 * shifts, evidence rules and food-safety areas, defined once in
 * src/lib/fssai.ts and served from here.
 *
 * Note on names: live department names contain double spaces ("Akan  Indian").
 * MATCH ON ID, never on name (RECON §5 row 5).
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const g = await requireFssaiAdmin();
  if ('resp' in g) return g.resp;
  try {
    const db = getDb();

    const departments = db.prepare(
      `SELECT id, name, code, is_active FROM departments WHERE is_active = 1 ORDER BY name ASC`,
    ).all() as any[];

    // include_inactive is deliberate: a deactivated role still governs the
    // users assigned to it (auth.ts:104-107), so a template may legitimately
    // point at one and the builder must be able to show its name.
    const roles = db.prepare(
      `SELECT id, name, base_role, is_active, sort_order FROM roles ORDER BY sort_order ASC, name ASC`,
    ).all() as any[];

    const users = db.prepare(
      `SELECT email, name, position, department_id FROM users WHERE is_active = 1 ORDER BY name ASC`,
    ).all() as any[];

    // fssai_equipment is this module's own table (there is no equipment master
    // anywhere in the app — RECON §5 row 7). It is empty until P4 seeds it
    // from production_batches.storage_location; returning it now lets the
    // builder offer equipment targets the moment it has rows.
    const equipment = db.prepare(
      `SELECT id, name, kind, location_label, department_id, min_temp, max_temp, temp_uom
         FROM fssai_equipment WHERE is_active = 1 ORDER BY sort_order ASC, name ASC`,
    ).all() as any[];

    return Response.json({
      departments,
      roles,
      users,
      equipment,
      vocab: {
        qtypes: FSSAI_QTYPES,
        frequencies: FSSAI_FREQUENCIES,
        target_kinds: FSSAI_TARGET_KINDS,
        shifts: FSSAI_SHIFTS,
        module_keys: FSSAI_MODULE_KEYS,
        evidence_rules: FSSAI_EVIDENCE_RULES,
        equipment_kinds: FSSAI_EQUIPMENT_KINDS,
      },
      generated_at: new Date().toISOString(),
    });
  } catch (e: any) {
    console.error('GET /api/fssai/masters failed:', e);
    return Response.json({ error: e?.message || 'Failed to load the lists' }, { status: 500 });
  }
}
