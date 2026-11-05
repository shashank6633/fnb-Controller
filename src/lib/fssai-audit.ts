import { FSSAI_RECORD_TABLES } from '@/lib/fssai';

/**
 * P10 — THE WORDS THE CHANGE-AND-VOID TRAIL IS READ IN.
 *
 * fssai_audit_log has been filled since the checklist engine shipped: every
 * create, edit, submit, signature, verification, cancellation and dropped
 * photograph wrote its own row with the before value, the after value, the actor
 * and the reason. Nothing was waiting for P10 except somewhere to read it.
 *
 * ── WHY THIS FILE IS SEPARATE FROM fssai-void.ts ────────────────────────────
 * This one must import cleanly into a CLIENT component — the screen renders the
 * same labels and the same diff the CSV export writes, and a vocabulary that the
 * server and the screen each keep their own copy of is the drift this module has
 * been bitten by. fssai-void.ts reaches for better-sqlite3 and fssai-server, so
 * it can never be imported by a page. Nothing below touches a database.
 *
 * ── THE HOUSE RULE FOR EVERY LOOKUP HERE ────────────────────────────────────
 * fssai_audit_log.action has NO CHECK constraint (nothing in db.ts does — ALTER
 * cannot add one), so a row can carry an action this file has never heard of,
 * and a sibling lane shipping its own register will write actions nobody declared
 * yet. An unknown value must therefore render AS ITSELF and never as a blank: a
 * food-safety trail that silently drops the lines it does not recognise is worse
 * than one that prints "pest_fumigation". Every *Meta function below falls back
 * to the raw key, exactly as fssaiCaStatusMeta does.
 */

export interface FssaiAuditActionMeta {
  key: string;
  /** the verb as a manager reads it */
  label: string;
  /** one line: what this row means happened */
  means: string;
  /** tailwind chip classes, house palette */
  color: string;
  /** a row that took information out of the live register — the §19 rows */
  isOverride?: true;
}

const CHIP_NEUTRAL = 'bg-gray-100 text-gray-700 border-gray-200';
const CHIP_TEAL = 'bg-teal-100 text-teal-700 border-teal-200';
const CHIP_GREEN = 'bg-green-100 text-green-700 border-green-200';
const CHIP_AMBER = 'bg-amber-100 text-amber-800 border-amber-200';
const CHIP_RED = 'bg-red-100 text-red-700 border-red-200';
const CHIP_BLUE = 'bg-blue-100 text-blue-700 border-blue-200';

export const FSSAI_AUDIT_ACTIONS: readonly FssaiAuditActionMeta[] = [
  { key: 'create', label: 'Created', means: 'The row was first written.', color: CHIP_TEAL },
  { key: 'update', label: 'Edited', means: 'A field was changed. The old and new values are on the line.', color: CHIP_AMBER },
  { key: 'open', label: 'Round opened', means: 'Somebody started a checklist round.', color: CHIP_NEUTRAL },
  { key: 'submit', label: 'Submitted', means: 'A check was filed. From here it is history.', color: CHIP_TEAL },
  { key: 'snapshot', label: 'Sheet frozen', means: 'The checklist as it was asked, frozen at submit so a later rename cannot re-label this record.', color: CHIP_NEUTRAL },
  { key: 'sign', label: 'Signed', means: 'A person attested to the record, with a digest over every answer and photograph.', color: CHIP_GREEN },
  { key: 'unsign', label: 'Signature withdrawn', means: 'A signature was removed before the record was filed.', color: CHIP_AMBER, isOverride: true },
  { key: 'verify', label: 'Verified', means: 'A second pair of eyes accepted the record. It did not change what the record says.', color: CHIP_GREEN },
  { key: 'reject', label: 'Sent back', means: 'A record was not accepted and the round was reopened. The record stays in the file.', color: CHIP_RED, isOverride: true },
  { key: 'void', label: 'Cancelled', means: 'A record was cancelled with a written reason. Nothing was deleted.', color: CHIP_RED, isOverride: true },
  { key: 'delete', label: 'Deleted', means: 'A configuration row that had never been used was removed. Records are never deleted.', color: CHIP_RED, isOverride: true },
  { key: 'delete_blocked', label: 'Deletion refused', means: 'Somebody tried to delete something with recorded history and the module refused.', color: CHIP_BLUE },
  { key: 'assign', label: 'Assigned', means: 'A corrective action was given to a person with a due date.', color: CHIP_BLUE },
  { key: 'raise_ca', label: 'Corrective action raised', means: 'A failed check raised a follow-up action against itself.', color: CHIP_AMBER },
  { key: 'attach', label: 'Photograph attached', means: 'Evidence was added to an answer.', color: CHIP_NEUTRAL },
  { key: 'attachment_removed', label: 'Photograph removed', means: 'Evidence was removed from an answer that had not been filed yet.', color: CHIP_AMBER, isOverride: true },
  { key: 'retention_drop_image', label: 'Image aged out', means: 'The picture passed its retention window. The record, its size and its digest were kept.', color: CHIP_NEUTRAL },
  { key: 'retention_sweep', label: 'Retention sweep', means: 'A pass over the stored images, with what it dropped and what it kept.', color: CHIP_NEUTRAL },
] as const;

export function fssaiAuditActionMeta(key: string | null | undefined): FssaiAuditActionMeta {
  const k = String(key || '');
  const found = FSSAI_AUDIT_ACTIONS.find((a) => a.key === k);
  if (found) return found;
  /* The fallback is the whole safety net — see the header. The raw key is shown,
   * so an action a later wave invents is visible on the trail the day it is
   * written, without this file being edited. */
  return { key: k, label: k || '(no action recorded)', means: '', color: CHIP_NEUTRAL };
}

/** Which actions took something out of the live register — the §19 short list. */
export const FSSAI_AUDIT_OVERRIDE_ACTIONS: readonly string[] =
  FSSAI_AUDIT_ACTIONS.filter((a) => a.isOverride).map((a) => a.key);

/* ------------------------------------------------------------------ *
 * WHICH TABLE A LINE IS ABOUT
 * ------------------------------------------------------------------ */

export interface FssaiAuditEntityMeta {
  table: string;
  one: string;
  many: string;
  /** the screen to open, or '' when the row is configuration with no register */
  path: string;
  /** a record (§19 applies) rather than configuration */
  isRecord: boolean;
}

/**
 * The thirteen record tables come straight from FSSAI_RECORD_TABLES so the two
 * lists cannot disagree, plus the configuration and evidence tables the trail
 * also carries. A table that appears in the data and in neither list still
 * renders — fssaiAuditEntityMeta falls back to the raw name.
 */
const CONFIG_ENTITIES: readonly FssaiAuditEntityMeta[] = [
  { table: 'fssai_templates', one: 'checklist', many: 'Checklists', path: '/fssai/settings/checklists', isRecord: false },
  { table: 'fssai_sections', one: 'checklist section', many: 'Checklist sections', path: '/fssai/settings/checklists', isRecord: false },
  { table: 'fssai_questions', one: 'checklist question', many: 'Checklist questions', path: '/fssai/settings/checklists', isRecord: false },
  { table: 'fssai_assignments', one: 'schedule', many: 'Schedules', path: '/fssai/settings/checklists', isRecord: false },
  { table: 'fssai_responses', one: 'answer', many: 'Answers', path: '', isRecord: false },
  { table: 'fssai_evidence', one: 'photograph', many: 'Photographs', path: '', isRecord: false },
  { table: 'fssai_attachments', one: 'attachment', many: 'Attachments', path: '', isRecord: false },
  { table: 'fssai_approvals', one: 'verification', many: 'Verifications', path: '/fssai/verification', isRecord: false },
  { table: 'fssai_equipment', one: 'unit or area', many: 'Equipment and areas', path: '/fssai/settings/equipment', isRecord: false },
  { table: 'fssai_temp_standards', one: 'safe range', many: 'Safe ranges', path: '/fssai/settings/equipment', isRecord: false },
  { table: 'fssai_item_shelf_life', one: 'shelf life', many: 'Shelf lives', path: '/fssai/fifo', isRecord: false },
  { table: 'fssai_pest_devices', one: 'pest device', many: 'Pest devices', path: '/fssai/pest-control', isRecord: false },
  { table: 'fssai_seed_log', one: 'seeded pack', many: 'Seeded packs', path: '/fssai/settings', isRecord: false },
  { table: 'fssai_retention_runs', one: 'retention sweep', many: 'Retention sweeps', path: '/fssai/audit-log', isRecord: false },
] as const;

export const FSSAI_AUDIT_ENTITIES: readonly FssaiAuditEntityMeta[] = [
  ...FSSAI_RECORD_TABLES.map((t) => ({
    table: t.table, one: t.one, many: t.many, path: t.path, isRecord: true,
  })),
  ...CONFIG_ENTITIES,
];

export function fssaiAuditEntityMeta(table: string | null | undefined): FssaiAuditEntityMeta {
  const t = String(table || '');
  const found = FSSAI_AUDIT_ENTITIES.find((e) => e.table === t);
  if (found) return found;
  return { table: t, one: t || 'row', many: t || 'Rows', path: '', isRecord: false };
}

/* ------------------------------------------------------------------ *
 * ORIGINAL vs CHANGED — owner §19(b)
 * ------------------------------------------------------------------ */

export interface FssaiAuditChange {
  field: string;
  before: string;
  after: string;
  /** the field is only on one side: added, or removed */
  oneSided: boolean;
}

function inWords(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v === '' ? '(blank)' : v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

/** Parse one side of an audit row. '' and unparseable both mean "nothing here". */
export function fssaiAuditJson(text: unknown): any {
  const s = String(text ?? '');
  if (!s.trim()) return null;
  try { return JSON.parse(s); } catch { return { '(unreadable)': s.slice(0, 400) }; }
}

/**
 * The field-by-field difference between the two frozen JSON blobs.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it does not hide a field whose value is the
 * same on both sides when that field was named explicitly. Several routes restate
 * an unchanged column in `after` precisely to PROVE it did not move — the
 * retention sweep restates mime, size_bytes and digest_sha256 for exactly that
 * reason — so an "unchanged" line is evidence, not noise. They are returned with
 * before === after and the screen can group them under "unchanged, and restated
 * to prove it".
 *
 * A one-sided row (a create has no before; a delete has no after) is marked
 * rather than rendered as a change from nothing, because "status: — → void" and
 * "status: ok → void" are different statements.
 */
export function fssaiAuditDiff(beforeJson: unknown, afterJson: unknown): FssaiAuditChange[] {
  const b = fssaiAuditJson(beforeJson);
  const a = fssaiAuditJson(afterJson);
  const bObj = b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  const aObj = a && typeof a === 'object' && !Array.isArray(a) ? (a as Record<string, unknown>) : null;

  if (!bObj && !aObj) {
    const out: FssaiAuditChange[] = [];
    if (b !== null) out.push({ field: 'value', before: inWords(b), after: '—', oneSided: true });
    if (a !== null) out.push({ field: 'value', before: '—', after: inWords(a), oneSided: true });
    return out;
  }

  const fields = Array.from(new Set([...Object.keys(bObj || {}), ...Object.keys(aObj || {})]));
  return fields.map((f) => {
    const hasB = !!bObj && f in bObj;
    const hasA = !!aObj && f in aObj;
    return {
      field: f,
      before: hasB ? inWords(bObj![f]) : '—',
      after: hasA ? inWords(aObj![f]) : '—',
      oneSided: !hasB || !hasA,
    };
  });
}

/** A one-line summary of a trail row, used by the list and by the CSV. */
export function fssaiAuditLine(row: {
  action?: string | null; entity_table?: string | null; field?: string | null;
}): string {
  const action = fssaiAuditActionMeta(row.action).label;
  const entity = fssaiAuditEntityMeta(row.entity_table).one;
  const field = String(row.field || '');
  return field ? `${action} — ${entity} (${field})` : `${action} — ${entity}`;
}
