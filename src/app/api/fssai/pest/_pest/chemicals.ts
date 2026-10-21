/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * WHAT THE CONTRACTOR APPLIED — fssai_pest_services.chemicals_json (#78
 * "Pest-control chemicals/records maintained").
 *
 * Until now the API accepted chemicals_json, no screen wrote it and nothing
 * printed it, so the one list on a pest visit an inspector reads first was
 * always empty. This file is the single reading of that column, for the route,
 * the screen's print view and the audit file (readPestChemicalsApplied).
 *
 * ── THREE STATES, NOT TWO — THE SAME TRAP AS '' vs 'no' ─────────────────────
 * '[]' is what every visit filed before this existed carries, so an empty list
 * cannot mean "nothing was used": it means NOBODY RECORDED IT. A visit where the
 * technician only inspected is a different, deliberate statement, stored as one
 * marker object:
 *     [{ "none_applied": true, "note": "Inspection only — nothing applied" }]
 * readPestChemicals() turns the column into one of
 *     'listed'        one row per product
 *     'none_applied'  somebody said, in words, that nothing was applied
 *     'not_recorded'  '[]' or unreadable — never shown as "none"
 *
 * ── THE ROW ─────────────────────────────────────────────────────────────────
 * The keys the column already declared (db.ts: name, batch, dilution, qty, uom,
 * licence_no) are kept with their meaning — licence_no is the product's CIB&RC
 * registration number, the licence a pesticide carries — and five are added
 * because an inspector asks for them: active_ingredient, expiry, method,
 * target_pest, area. Unknown keys are dropped, every value is trimmed and
 * capped, and a row with content but no product name is refused by name.
 *
 * ── A COMPLETED VISIT IS A RECORD ───────────────────────────────────────────
 * Once stated (listed or none), the chemicals of a completed visit are not
 * edited: the remedy is void-and-refile, like every other field on it. The one
 * thing allowed afterwards is to FILL a list nobody recorded — the job sheet
 * often arrives days after the visit — and that is its own audited action
 * ('record_chemicals') that refuses once a list is there.
 */
import { isISODate } from '@/lib/fssai';

/* PURE ON PURPOSE: the screen's chemicals editor imports the field list and
 * readPestChemicals from here, so this file must not reach the database —
 * fssai-server (and its `str`) would drag better-sqlite3 into the browser
 * bundle. The same trim-or-blank rule, locally. */
function str(v: unknown, dflt = ''): string {
  if (v === undefined || v === null) return dflt;
  return String(v).trim();
}

export interface PestChemical {
  name: string;
  active_ingredient: string;
  /** CIB&RC registration number of the product (the column's original key). */
  licence_no: string;
  batch: string;
  /** YYYY-MM-DD, or '' */
  expiry: string;
  dilution: string;
  qty: string;
  uom: string;
  method: string;
  target_pest: string;
  area: string;
}

export const PEST_CHEMICAL_FIELDS: readonly { key: keyof PestChemical; label: string; max: number }[] = [
  { key: 'name', label: 'Product (trade name)', max: 120 },
  { key: 'active_ingredient', label: 'Active ingredient', max: 160 },
  { key: 'licence_no', label: 'CIB&RC registration no.', max: 80 },
  { key: 'batch', label: 'Batch', max: 60 },
  { key: 'expiry', label: 'Expiry', max: 10 },
  { key: 'dilution', label: 'Dilution', max: 60 },
  { key: 'qty', label: 'Quantity used', max: 40 },
  { key: 'uom', label: 'Unit', max: 20 },
  { key: 'method', label: 'Method', max: 60 },
  { key: 'target_pest', label: 'Target pest', max: 80 },
  { key: 'area', label: 'Where applied', max: 200 },
] as const;

/** How a product goes down — a suggestion list for the screen, not enforced. */
export const PEST_CHEMICAL_METHODS: readonly string[] = [
  'Spray', 'Gel', 'Bait', 'Fogging', 'Dusting', 'Glue board', 'Trap', 'Fumigation',
] as const;

export const PEST_CHEMICALS_MAX_ROWS = 30;

export type PestChemicalsState = 'listed' | 'none_applied' | 'not_recorded';

export interface PestChemicalsRead {
  state: PestChemicalsState;
  rows: PestChemical[];
  /** The words given with "nothing was applied". */
  none_note: string;
}

function blankChemical(): PestChemical {
  return {
    name: '', active_ingredient: '', licence_no: '', batch: '', expiry: '', dilution: '',
    qty: '', uom: '', method: '', target_pest: '', area: '',
  };
}

function cleanRow(o: any): PestChemical {
  const out = blankChemical();
  for (const f of PEST_CHEMICAL_FIELDS) {
    const v = o?.[f.key];
    out[f.key] = (v === null || v === undefined ? '' : String(v)).trim().slice(0, f.max);
  }
  if (out.expiry && !isISODate(out.expiry)) out.expiry = '';
  return out;
}

/** The column as a reader needs it. Never throws, never invents a "none". */
export function readPestChemicals(text: unknown): PestChemicalsRead {
  let arr: unknown;
  try { arr = JSON.parse(String(text ?? '[]') || '[]'); } catch { arr = []; }
  if (!Array.isArray(arr)) return { state: 'not_recorded', rows: [], none_note: '' };
  const objs = arr.filter((x) => x && typeof x === 'object' && !Array.isArray(x)) as any[];
  const marker = objs.find((x) => x.none_applied === true);
  if (marker) return { state: 'none_applied', rows: [], none_note: str(marker.note) };
  const rows = objs.map(cleanRow).filter((r) => PEST_CHEMICAL_FIELDS.some((f) => r[f.key] !== ''));
  return rows.length ? { state: 'listed', rows, none_note: '' } : { state: 'not_recorded', rows: [], none_note: '' };
}

/**
 * What a request said about chemicals, made safe to store — or the refusal.
 *
 * `chemicals` is an array of rows; `none` (true) with `noneNote` says nothing was
 * applied. Both at once is refused (a list and "nothing" cannot both be true).
 * Neither → 'not_recorded' and json '[]', which the caller may store and the
 * screen then flags. `visitDate` lets the warnings say a product was past its
 * expiry ON THE DAY — a warning, never a refusal: the record must say what was
 * used even when what was used was wrong.
 */
export function normalisePestChemicals(
  input: { chemicals?: unknown; none?: unknown; noneNote?: unknown; visitDate?: string },
): { ok: true; json: string; read: PestChemicalsRead; warnings: string[] } | { ok: false; error: string } {
  let arr: unknown = input.chemicals;
  if (typeof arr === 'string') {
    const s = arr.trim();
    if (!s) arr = [];
    else {
      try { arr = JSON.parse(s); } catch { return { ok: false, error: 'The list of chemicals could not be read. Reload the screen and enter it again.' }; }
    }
  }
  if (arr === undefined || arr === null) arr = [];
  if (!Array.isArray(arr)) return { ok: false, error: 'The list of chemicals could not be read. Reload the screen and enter it again.' };

  const rows: PestChemical[] = [];
  for (let i = 0; i < arr.length; i++) {
    const o = arr[i];
    if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
    const r = cleanRow(o);
    const hasAny = PEST_CHEMICAL_FIELDS.some((f) => r[f.key] !== '');
    if (!hasAny) continue;                       // a blank line on the form
    if (r.name.length < 2) {
      return { ok: false, error: `Line ${i + 1} of the chemicals has no product name. Write the name on the container, or clear the line.` };
    }
    if (str((o as any).expiry) && !r.expiry) {
      return { ok: false, error: `Line ${i + 1} (${r.name}): "${str((o as any).expiry)}" is not a date. Use the date picker for the expiry.` };
    }
    rows.push(r);
  }
  if (rows.length > PEST_CHEMICALS_MAX_ROWS) {
    return { ok: false, error: `That is ${rows.length} products on one visit; the most one visit can list is ${PEST_CHEMICALS_MAX_ROWS}.` };
  }

  const none = input.none === true || input.none === 1 || input.none === '1' || String(input.none).toLowerCase() === 'true';
  if (none && rows.length) {
    return { ok: false, error: 'The visit cannot both list chemicals and say none were applied. Clear one of them.' };
  }
  if (none) {
    const note = str(input.noneNote).trim().slice(0, 400);
    if (note.length < 4) {
      return { ok: false, error: 'Say in words why nothing was applied — "inspection only", "monitoring visit" — so the file does not read as a list somebody forgot.' };
    }
    const json = JSON.stringify([{ none_applied: true, note }]);
    return { ok: true, json, read: { state: 'none_applied', rows: [], none_note: note }, warnings: [] };
  }

  const warnings: string[] = [];
  const day = str(input.visitDate);
  for (const r of rows) {
    if (r.expiry && isISODate(day) && r.expiry < day) {
      warnings.push(`${r.name} was past its expiry (${r.expiry}) on the day of the visit. It is recorded as used — raise it with the agency.`);
    }
    if (!r.licence_no) warnings.push(`${r.name} has no CIB&RC registration number. An inspector will ask for it — it is printed on the container.`);
  }
  if (!rows.length) return { ok: true, json: '[]', read: { state: 'not_recorded', rows: [], none_note: '' }, warnings };
  return { ok: true, json: JSON.stringify(rows), read: { state: 'listed', rows, none_note: '' }, warnings };
}

/** Did the request say ANYTHING about chemicals? (So 'complete' keeps what a
 *  planned visit already carried when the body is silent.) */
export function requestMentionsChemicals(body: any): boolean {
  return body?.chemicals !== undefined || body?.chemicals_none !== undefined;
}
