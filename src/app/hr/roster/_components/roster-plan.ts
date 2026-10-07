/**
 * Client-side helpers for the roster GENERATOR's plan object.
 *
 * The shapes are imported as TYPES from src/lib/hr-roster-generate.ts — the one
 * definition — so a field renamed on the server breaks this file at compile time
 * instead of rendering blank cells. `import type` is erased by TypeScript, so
 * nothing from that server module (better-sqlite3, @/lib/db) reaches the bundle.
 */
import type { RosterPlan, RosterPlanRow } from '@/lib/hr-roster-generate';

export type { RosterPlan, RosterPlanRow };

/** 0=Sun .. 6=Sat, matching JS getDay / SQLite %w / every weekday column here. */
export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export const WEEKDAY_LONG = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const;

/**
 * The owner's HARD RULE: a weekly off lands Mon–Thu only, because "it is a Pub,
 * weekend is more busy". Measured in his own grid, Captains' offs ran Mon 5,
 * Tue 7, Wed 4, Thu 4 and Fri/Sat/Sun ZERO. This array is the DEFAULT the
 * what-if picker starts from, never a replacement for the saved setting — an
 * empty selection means "nobody chose", and the server reads the saved value
 * rather than ever treating empty as "any day".
 */
export const OWNER_OFF_WEEKDAYS = [1, 2, 3, 4] as const;

/** `${employee_id}|${date}` → the planned cell. */
export function planIndex(plan: RosterPlan | null): Map<string, RosterPlanRow> {
  const m = new Map<string, RosterPlanRow>();
  if (!plan) return m;
  for (const r of plan.rows) m.set(`${r.employee_id}|${r.date}`, r);
  return m;
}

/**
 * The plan may only be overlaid on the grid it was computed FOR.
 *
 * Without this check a plan previewed for Kitchen on last week keeps painting
 * OFF chips after the manager pages to another week or department — stale offs
 * that look exactly like real ones. Offs are not stored, so a mismatched overlay
 * is unfalsifiable by a reload; it has to be refused here.
 */
export function planMatches(
  plan: RosterPlan | null,
  departmentId: string,
  weekStart: string,
): boolean {
  return !!plan && plan.department_id === departmentId && plan.week_start === weekStart;
}

/** Groups (designations) in the plan's own stable order, for the print sections. */
export function planGroupOrder(plan: RosterPlan | null): Array<{ id: string; name: string }> {
  if (!plan) return [];
  return plan.groups.map((g) => ({ id: g.designation_id, name: g.designation_name }));
}

/** Where a refusal gets fixed. `code` is stable and safe to switch on; the
 *  message is already written for a human, so it is rendered verbatim. */
export type RefusalFix =
  | { kind: 'page'; href: string; label: string }
  | { kind: 'config'; tab: 'coverage' | 'map'; label: string }
  | { kind: 'none' };

export function refusalFix(code: string): RefusalFix {
  switch (code) {
    case 'no_employees':
    case 'employees_without_designation':
    case 'designation_not_found':
      return { kind: 'page', href: '/hr/employees', label: 'Open Employees' };
    case 'no_shifts':
    case 'no_active_shifts':
    case 'shift_inactive':
    case 'shift_map_dangling':
    case 'split_shift_reversed':
      return { kind: 'page', href: '/hr/shifts', label: 'Open Shifts' };
    case 'no_shift_map':
    case 'shift_map_missing':
    case 'coverage_role_unmapped':
      return { kind: 'config', tab: 'map', label: 'Open shift map' };
    case 'no_coverage':
    case 'coverage_floor_missing':
      return { kind: 'config', tab: 'coverage', label: 'Open coverage' };
    default:
      // department_required / department_not_found / week_start_invalid are fixed
      // by the pickers already on this page — and an unknown code must degrade to
      // "no button", never to a wrong one.
      return { kind: 'none' };
  }
}
