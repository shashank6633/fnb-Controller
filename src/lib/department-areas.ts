import type Database from 'better-sqlite3';
import { canonNameInput } from './name-canon';

/* ════════════════════════════════════════════════════════════════════════════
 * DEPARTMENT AREAS — the owner's list (ruling #82, 2026-10-28)
 * ════════════════════════════════════════════════════════════════════════════
 * Every department belongs to at most one coarse AREA (departments.area), which
 * Closing Stock rolls up by. The choices used to be two hard-coded copies
 * (AREA_OPTIONS on /departments, AREA_LABELS on /closing-stock — and they
 * already disagreed: "Service / Operations" vs "Service / Ops"). They now live
 * in ONE settings row, managed by an admin under Settings → Departments →
 * Manage Areas, and every screen reads its names from here.
 *
 * ── KEY vs LABEL ──────────────────────────────────────────────────────────
 * departments.area stores a STABLE KEY ('kitchen'); the screen shows its LABEL
 * ('Kitchen'). Renaming an area changes only the label, so no department row
 * is ever rewritten — departments' areas are the owner's. A new area's key is
 * a slug of the first name it was given, unique against every key in the list
 * AND every key a department already carries.
 *
 * ── NO BOOT WRITE ─────────────────────────────────────────────────────────
 * When the row is absent the five defaults below are returned as-is; nothing
 * is written until an admin changes something (scripts/check-boot-migrations.js
 * stays clean, and a fresh database needs no migration).
 *
 * ── SWITCHED OFF vs DELETED ───────────────────────────────────────────────
 * Switched off: still in the list, still named on every screen; a department
 * that has it keeps it, but it cannot be given to another department.
 * Deleted: gone from the list — allowed only while NO department (archived
 * ones included: reactivating is one tick) carries the key.
 * ═══════════════════════════════════════════════════════════════════════════ */

export const DEPARTMENT_AREAS_KEY = 'department_areas';

/** Closing Stock's own bucket for counts with no department / no area. Not an
 *  area: it can never be created, renamed or assigned. */
export const STORE_BUCKET_KEY = '__store__';
export const STORE_BUCKET_LABEL = 'Store / Overall';

export const AREA_LABEL_MAX = 40;

export interface DepartmentArea {
  key: string;
  label: string;
  active: boolean;
  sort: number;
}

/** The five areas that existed before the list became editable. */
export const DEFAULT_DEPARTMENT_AREAS: readonly DepartmentArea[] = Object.freeze([
  { key: 'kitchen', label: 'Kitchen', active: true, sort: 10 },
  { key: 'bar', label: 'Bar', active: true, sort: 20 },
  { key: 'store', label: 'Store', active: true, sort: 30 },
  { key: 'service', label: 'Service / Operations', active: true, sort: 40 },
  { key: 'other', label: 'Other', active: true, sort: 50 },
]);

export interface AreaList {
  areas: DepartmentArea[];
  /** 'default' = no saved row (the five defaults); 'saved' = the admin's list;
   *  'unreadable' = a saved row that is not a list — the defaults are shown
   *  until an admin saves again. */
  source: 'default' | 'saved' | 'unreadable';
  /** Saved entries that could not be read (bad key / empty name / duplicate). */
  ignored: number;
  raw: string | null;
}

const KEY_RE = /^[a-z0-9][a-z0-9_]{0,39}$/;

const defaults = (): DepartmentArea[] => DEFAULT_DEPARTMENT_AREAS.map((a) => ({ ...a }));

const bySort = (a: DepartmentArea, b: DepartmentArea) =>
  a.sort - b.sort || a.label.localeCompare(b.label);

/** A label as stored and compared: canonical (no invisible characters, single
 *  spaces, trimmed). '' when nothing visible is left. */
export function cleanAreaLabel(v: unknown): string {
  return canonNameInput(v);
}

/**
 * The list, read-only. Never writes — a missing row means "the defaults".
 */
export function readDepartmentAreas(db: Database.Database): AreaList {
  let raw: string | null = null;
  try {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(DEPARTMENT_AREAS_KEY) as
      { value?: string } | undefined;
    raw = r?.value ?? null;
  } catch {
    raw = null;
  }
  if (raw == null) return { areas: defaults(), source: 'default', ignored: 0, raw: null };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
  if (!Array.isArray(parsed)) return { areas: defaults(), source: 'unreadable', ignored: 0, raw };
  const out: DepartmentArea[] = [];
  const seen = new Set<string>();
  let ignored = 0;
  parsed.forEach((raw: unknown, i: number) => {
    const e = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const key = typeof e.key === 'string' ? e.key : '';
    const label = cleanAreaLabel(e.label).slice(0, AREA_LABEL_MAX);
    if (!KEY_RE.test(key) || key === STORE_BUCKET_KEY || !label || seen.has(key)) { ignored++; return; }
    seen.add(key);
    const sort = Number(e.sort);
    out.push({
      key,
      label,
      active: !(e.active === false || e.active === 0 || e.active === '0' || e.active === 'false'),
      sort: Number.isFinite(sort) ? sort : (i + 1) * 10,
    });
  });
  out.sort(bySort);
  return { areas: out, source: 'saved', ignored, raw };
}

/** Writes the whole list. Callers run it inside their own transaction. */
export function saveDepartmentAreas(db: Database.Database, areas: DepartmentArea[]): void {
  const clean = [...areas].sort(bySort).map((a) => ({
    key: a.key, label: a.label, active: !!a.active, sort: a.sort,
  }));
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(DEPARTMENT_AREAS_KEY, JSON.stringify(clean));
}

/** key → label for every area in the list (switched-off ones included —
 *  a department that keeps one must still be named properly). */
export function areaLabelMap(areas: DepartmentArea[]): Map<string, string> {
  return new Map(areas.map((a) => [a.key, a.label]));
}

/** The name to show for a stored area key: its label, the Closing Stock
 *  bucket's name for '__store__', '' for none, and the key itself when the
 *  list has no entry for it (never a blank, never a guess). */
export function areaLabelFor(map: Map<string, string>, key: string | null | undefined): string {
  const k = String(key ?? '').trim();
  if (!k) return '';
  if (k === STORE_BUCKET_KEY) return STORE_BUCKET_LABEL;
  return map.get(k) ?? k;
}

/**
 * A key for a new area: a slug of its name, unique against `taken` (every key
 * in the list plus every key a department carries). Names with no usable
 * letters (e.g. only symbols) fall back to "area".
 */
export function newAreaKey(label: string, taken: Set<string>): string {
  const base = (label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)
    .replace(/_+$/g, '')) || 'area';
  const safe = KEY_RE.test(base) ? base : 'area';
  if (!taken.has(safe) && safe !== STORE_BUCKET_KEY) return safe;
  for (let n = 2; n < 10000; n++) {
    const k = `${safe}_${n}`;
    if (!taken.has(k)) return k;
  }
  return `area_${Date.now().toString(36)}`;
}

/** Every distinct non-blank area key carried by a department (archived too). */
export function departmentAreaKeysInUse(db: Database.Database): Set<string> {
  const rows = db.prepare(`
    SELECT DISTINCT TRIM(COALESCE(area, '')) AS area
      FROM departments
     WHERE TRIM(COALESCE(area, '')) <> ''
  `).all() as Array<{ area: string }>;
  return new Set(rows.map((r) => r.area));
}

/**
 * Validate the area a department create / edit asks for.
 *   ''                      → unassigned, always allowed
 *   the department's own    → allowed as-is (it may keep a switched-off area,
 *                             or a value from before the list existed)
 *   a switched-ON key       → allowed
 *   a switched-OFF key      → refused (switch it on first)
 *   anything else           → refused (not in the list)
 * Keys match exactly; a key typed in different case is accepted as the key.
 */
export function checkDepartmentArea(
  areas: DepartmentArea[],
  requested: unknown,
  current: string | null | undefined,
): { ok: true; value: string } | { ok: false; error: string } {
  if (requested !== null && typeof requested === 'object') {
    return { ok: false, error: 'Area must be one of the areas in Manage Areas, or blank for none. Nothing was saved.' };
  }
  const v = String(requested ?? '').trim();
  if (!v) return { ok: true, value: '' };
  const curRaw = String(current ?? '');
  const cur = curRaw.trim();
  // Keeping what it has: the stored value goes back exactly as it was.
  if (cur && v === cur) return { ok: true, value: curRaw };
  const hit = areas.find((a) => a.key === v) || areas.find((a) => a.key === v.toLowerCase());
  if (!hit) {
    return {
      ok: false,
      error: `"${v}" is not one of the areas in Manage Areas. Pick an area from the list, or leave it unassigned. Nothing was saved.`,
    };
  }
  if (cur && hit.key === cur) return { ok: true, value: curRaw };
  if (!hit.active) {
    return {
      ok: false,
      error: `The area "${hit.label}" is switched off, so it can't be given to a department. Switch it on in Manage Areas first, or pick another area. Nothing was saved.`,
    };
  }
  return { ok: true, value: hit.key };
}
