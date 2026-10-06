/* eslint-disable @typescript-eslint/no-explicit-any */
import type Database from 'better-sqlite3';
import { isManagement } from '@/lib/auth';
import { FSSAI_NO_MATCH } from '@/lib/fssai-server';

/**
 * P9's OWN server helpers — the dashboard, Inspection Mode and the reports.
 *
 * WHY THIS FILE AND NOT src/lib/fssai-server.ts. Eight record lanes are editing
 * this worktree at the same time and the shared server module is read by all of
 * them. A helper added there with a name a sibling lane also chose is the
 * rival-helper trap this project has already paid for once (two lanes each wrote
 * a sales-slice.ts, the signatures agreed and the behaviour did not). Nothing in
 * here is general enough to belong beside canVerifyFssai, so it lives inside the
 * three screens that use it. `_p9` is underscore-prefixed, so Next.js never
 * routes it.
 *
 * It is a PROJECTION LAYER: every function here reads. There is no INSERT,
 * UPDATE or DELETE in this file — P9 is "mostly reads, as planned"
 * (FSSAI-BUILD-STATE.md §4), and the two writes P9 does own (an inspection and
 * its findings) are in their own route where they can be audited in a
 * transaction.
 */

/* ══════════════════════════════════════════════════════════════════════════
 * 1. A TABLE THAT IS NOT THERE YET
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * DOES THIS TABLE EXIST IN THIS DATABASE?
 *
 * ⚠️ THIS IS NOT DEFENSIVE PADDING — IT IS THE MEASURED STATE OF THE FILE THIS
 * MODULE IS BEING BUILT AGAINST. Wave 1 declared nineteen new fssai_ tables in
 * initializeSchema() and deliberately did NOT open the worktree database
 * read-write, so they appear on the next COLD START. Measured on this worktree
 * today:
 *
 *   sqlite3 "file:fnb-controller.db?mode=ro" \
 *     "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'fssai%'"
 *   → 11 rows. fssai_inspections, fssai_documents, fssai_temperature_logs … absent.
 *
 * A dashboard that queries all thirty tables in one statement would therefore
 * throw "no such table" on the first one and show nothing at all — on the
 * landing screen of the module. And because initializeSchema SWALLOWS SCHEMA
 * ERRORS PER BLOCK (HARD RULE 7), a table can be missing on a real server too
 * without anything having said so. So every bucket asks first, and a bucket
 * whose table is not there reports itself as NOT AVAILABLE rather than as ZERO.
 *
 * Zero and "not recorded" are different statements, and on a food-safety
 * dashboard the difference is the whole point: "0 failed temperature readings"
 * next to an absent temperature register would read as a clean kitchen.
 */
export function fssaiTableExists(db: Database.Database, name: string): boolean {
  try {
    const r = db
      .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`)
      .get(name) as any;
    return !!r?.ok;
  } catch {
    return false;
  }
}

/** Every fssai_ table present right now, as a Set, for one round trip. */
export function fssaiTablesPresent(db: Database.Database): Set<string> {
  try {
    const rows = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'fssai_%'`)
      .all() as any[];
    return new Set(rows.map((r) => String(r.name)));
  } catch {
    return new Set<string>();
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. ONE BUCKET MUST NEVER KILL THE SCREEN
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * Why a figure is or is not on the screen.
 *   ok          — it was counted.
 *   unavailable — its register does not exist in this database yet.
 *   failed      — the query broke. Named, not silently swallowed into 0.
 *   restricted  — premises-wide, and this reader is not management (§7 Q10).
 * The one value that is NOT in this list is anything meaning "zero" — a zero is
 * a value, and it belongs in `value`.
 */
export type BucketState = 'ok' | 'unavailable' | 'failed' | 'restricted';

export interface Bucket<T> {
  /** The figure, or the fallback when it could not be read. */
  value: T;
  state: BucketState;
  /** Why, in words a manager can read. '' when state is 'ok'. */
  why: string;
}

/**
 * Run one dashboard figure inside its own guard.
 *
 * The pattern is the notifications inbox's (RECON §7.7): each bucket in its own
 * try/catch, because un-isolated code there kills every user's bell. Here it
 * kills the compliance dashboard. A bucket that fails says so on the tile and
 * the other eleven still render.
 *
 * `requires` names the tables the figure needs. A missing one is 'unavailable',
 * NOT 'failed' and NOT 0 — see fssaiTableExists.
 */
export function bucket<T>(
  db: Database.Database,
  label: string,
  requires: string[],
  fallback: T,
  fn: () => T,
  present?: Set<string>,
): Bucket<T> {
  const have = present ?? fssaiTablesPresent(db);
  const missing = requires.filter((t) => !have.has(t));
  if (missing.length) {
    return {
      value: fallback,
      state: 'unavailable',
      why:
        missing.length === 1
          ? 'This figure is not available yet — its register has not been created in this copy of the database.'
          : 'This figure is not available yet — the registers it counts have not been created in this copy of the database.',
    };
  }
  try {
    return { value: fn(), state: 'ok', why: '' };
  } catch (e: any) {
    console.error(`[fssai/p9] bucket "${label}" failed:`, e?.message);
    return { value: fallback, state: 'failed', why: 'This figure could not be read. The rest of the screen is unaffected.' };
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. WHO SEES WHOSE FIGURES  (owner §7 Q10)
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * THE DEPARTMENT FENCE, in one place.
 *
 * Owner §7 Q10's provisional default: "Staff see their own department;
 * cross-department and inspection packs are management." The dashboard is open
 * to everyone in the page catalog, so a porter opening /fssai must see the
 * kitchen's figures only if the kitchen is his.
 *
 * FSSAI_NO_MATCH, never '': a user with no department must see the records that
 * are HIS, not every record whose department column happens to be blank. That
 * is the same trap canSeeAllDeptStock documents — an empty set means "sees
 * nothing", not "no filter".
 *
 * Returns '' for management, which means NO CLAUSE — the caller must treat an
 * empty string as "no restriction" and not as a falsy bug.
 */
export function deptFence(me: any, alias: string, recorderColumn = 'recorded_by'): { sql: string; args: any[] } {
  if (isManagement(me)) return { sql: '', args: [] };
  const dept = String(me?.department_id || '') || FSSAI_NO_MATCH;
  const email = String(me?.email || '') || FSSAI_NO_MATCH;
  return {
    sql: `((${alias}.department_id <> '' AND ${alias}.department_id = ?) OR lower(IFNULL(${alias}.${recorderColumn},'')) = lower(?))`,
    args: [dept, email],
  };
}

/** Join the fragments that are non-empty with AND, and prefix WHERE when any. */
export function whereAll(parts: Array<{ sql: string; args: any[] } | null | undefined>): { sql: string; args: any[] } {
  const live = (parts.filter(Boolean) as Array<{ sql: string; args: any[] }>).filter((p) => p.sql.trim() !== '');
  if (!live.length) return { sql: '', args: [] };
  return {
    sql: ' WHERE ' + live.map((p) => `(${p.sql})`).join(' AND '),
    args: live.flatMap((p) => p.args),
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. A NUMBER THAT WAS NEVER RECORDED IS NOT ZERO
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * Format a nullable REAL for display. NULL → '', NEVER '0'.
 *
 * Every :R column in this module's schema carries the same instruction: NULL
 * means NOT RECORDED. A blank thermometer reading printed as "0 °C" on a report
 * an inspector reads is a fabricated observation, and it is the single easiest
 * way for this module to tell a lie. `decimals` is display only — nothing in a
 * report rounds before a comparison, because rounding 5.4 would pass a 0-5 rule
 * (the fssaiRangeCheck note).
 */
export function numOrBlank(v: unknown, decimals = 1): string {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  const dp = Number.isFinite(Number(decimals)) ? Math.max(0, Math.min(4, Number(decimals))) : 1;
  return n.toFixed(dp);
}

/** An INTEGER count. 0 is a real answer here, so 0 prints as 0. */
export function intOr(v: unknown, dflt = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : dflt;
}

/** A nullable INTEGER — days, minutes. NULL → ''. */
export function intOrBlank(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.trunc(n)) : '';
}

/* ══════════════════════════════════════════════════════════════════════════
 * 5. CSV — the BOM is not optional in this module
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * One CSV cell.
 *
 * Two things, both measured problems in this codebase rather than theory:
 *   · A leading = + - @ is prefixed with an apostrophe. Excel executes the rest
 *     as a formula otherwise, and a corrective action beginning "=" is not
 *     far-fetched in free text.
 *   · Quotes are doubled and anything containing a comma, quote, CR or LF is
 *     quoted.
 */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * A whole CSV body, BOM first.
 *
 * ⚠️ THE BOM MATTERS MORE HERE THAN ANYWHERE ELSE IN THE APP. Only 6 of the 66
 * files that emit CSV in this codebase write one, and without it Excel renders
 * `4 °C` as `4 Â°C`. Temperature readings are the bulk of what this module
 * exports, so every FSSAI download is BOM + charset=utf-8, and the rows are
 * joined with \r\n the way /api/hr/reports does it.
 */
export function csvBody(header: string[], rows: Array<Array<unknown>>): string {
  const lines = [header.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))];
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** A filename-safe slug for a download. */
export function slug(s: string): string {
  return String(s || 'report')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'report';
}

/* ══════════════════════════════════════════════════════════════════════════
 * 6. THE DATE WINDOW  —  and the trap the owner has already been burned by
 * ══════════════════════════════════════════════════════════════════════════ */

export interface DateWindow {
  /** true when the caller asked for EVERYTHING — the default. */
  all: boolean;
  from: string;
  to: string;
  /** The period in words, for a PDF header and the screen. */
  label: string;
}

/**
 * Resolve the requested window.
 *
 * ⚠️ THE DEFAULT IS ALL RECORDS, DELIBERATELY. RECON §7.2 records the incident
 * in the codebase's own comments: a first-of-month default showed "0 of 2,165
 * rows and ₹0 of ₹69.26 lakh… He read that as his books having been lost." The
 * rule written down after that is quoted in RECON for this module: "an
 * inspection-history view defaults to ALL records, and any date filter is a
 * visible, deliberate choice. A compliance report that silently shows an empty
 * window is the worst possible failure mode for this module."
 *
 * So `from`/`to` are honoured only when the caller sends them, and `mode=all`
 * (or neither date) means no date predicate at all. The label says which, so the
 * screen and the PDF can never imply a window that was not applied.
 */
export function dateWindow(fromRaw: string, toRaw: string, mode: string): DateWindow {
  const iso = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');
  const from = iso(fromRaw);
  const to = iso(toRaw);
  if (mode === 'all' || (!from && !to)) return { all: true, from: '', to: '', label: 'All records' };
  if (from && to) {
    // A reversed range is a typo, not an empty report. Swap it and say so.
    const [a, b] = from <= to ? [from, to] : [to, from];
    return { all: false, from: a, to: b, label: a === b ? a : `${a} to ${b}` };
  }
  if (from) return { all: false, from, to: '', label: `${from} onwards` };
  return { all: false, from: '', to, label: `up to ${to}` };
}

/** The window as a SQL fragment against one date column. '' when all records. */
export function dateClause(col: string, w: DateWindow): { sql: string; args: any[] } {
  if (w.all) return { sql: '', args: [] };
  const parts: string[] = [];
  const args: any[] = [];
  // A blank date column must never silently satisfy a range — it is excluded,
  // and the report's note says so.
  parts.push(`${col} <> ''`);
  if (w.from) { parts.push(`${col} >= ?`); args.push(w.from); }
  if (w.to) { parts.push(`${col} <= ?`); args.push(w.to); }
  return { sql: parts.join(' AND '), args };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 7. SMALL READS EVERY P9 SCREEN NEEDS
 * ══════════════════════════════════════════════════════════════════════════ */

/** id → department name. Match on ID, never on name: live names hold double spaces. */
export function departmentNames(db: Database.Database): Map<string, string> {
  const m = new Map<string, string>();
  try {
    const rows = db.prepare(`SELECT id, name FROM departments`).all() as any[];
    for (const r of rows) m.set(String(r.id), String(r.name || '').replace(/\s+/g, ' ').trim());
  } catch { /* a dashboard without department names still counts correctly */ }
  return m;
}

/** The business name for a PDF header, or '' — never a guess. */
export function businessName(db: Database.Database): string {
  try {
    const r = db.prepare(`SELECT value FROM settings WHERE key = 'business_name' LIMIT 1`).get() as any;
    const v = String(r?.value || '').trim();
    if (v) return v;
  } catch { /* fall through */ }
  try {
    const r = db.prepare(`SELECT name FROM outlets WHERE is_default = 1 LIMIT 1`).get() as any;
    return String(r?.name || '').trim();
  } catch {
    return '';
  }
}
