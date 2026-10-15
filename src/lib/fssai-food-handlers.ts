/* eslint-disable @typescript-eslint/no-explicit-any */
import type Database from 'better-sqlite3';
import { generateId } from '@/lib/db';
import {
  addDaysISO, fssaiDocState, fssaiDocType, isISODate, daysBetweenISO,
  FSSAI_DOC_REMINDER_DAYS, FSSAI_DOC_TYPES,
  type FssaiStatusMeta,
} from '@/lib/fssai';
import { fssaiAudit } from '@/lib/fssai-server';
import { EXITED_STATUSES } from '@/lib/hr-attendance';

/**
 * THE FOOD-HANDLER REGISTER — Hyderabad audit lines #55 #56 #106 #107.
 *
 *   #55  Every food handler should have: Medical examination records available
 *   #56  Every food handler should have: Food-safety training records available
 *   #106 Audit file: Food-handler medical certificates
 *   #107 Audit file: Food-safety training records (and the FoSTaC supervisor)
 *
 * ── WHAT WAS WRONG, MEASURED ────────────────────────────────────────────────
 * A certificate could be filed only against an app LOGIN — the documents route
 * required person_email to be a users.email. A cook with no login could never be
 * covered, and every list of "who is covered" was built FROM the certificates on
 * file, so it could only ever name people who HAVE one. The person an inspector
 * is looking for — the handler with no medical — was the one row no screen could
 * print.
 *
 * ── THE SHAPE OF THE FIX ────────────────────────────────────────────────────
 * fssai_food_handlers (db.ts table 31) is the list of PEOPLE. Coverage is derived
 * on every read by joining their certificates to it, so "missing" is a row.
 *
 *   PERSON KEY (owner ruling Q18, 2026-10-14 — "email key until HR is populated"):
 *     1. employee_id → hr_employees.id, whenever HRMS knows the person;
 *     2. else person_email → users.email, when they have a login;
 *     3. else NEITHER — a name-only row is legal. The cook without a login is the
 *        case the register exists for.
 *
 *   CERTIFICATES stay in fssai_documents (medical_fitness, food_handler_training,
 *   fostac_certificate) and are filed against fssai_documents.handler_id. Rows
 *   filed before the register existed carry only person_email; coverage reads
 *   handler_id FIRST and falls back to the email (Q18) — never the other way
 *   round, so a certificate re-pointed at a handler cannot be claimed twice.
 *
 *   HRMS TRAINING COMPLETIONS count through fssai_training_links (table 32): one
 *   row per HRMS training saying what it counts as. The completion itself is
 *   joined LIVE from hr_training_assignments (status 'completed' +
 *   completed_date) through the handler's employee_id — HRMS stays the only place
 *   a completion is written. Nothing here writes an HR table.
 *
 *   EXPIRY STATE IS NEVER STORED. fssaiDocState() on every read, exactly as the
 *   documents cupboard does (a stored "valid" goes stale at midnight).
 *
 * ── WHAT THIS FILE NEVER DOES ───────────────────────────────────────────────
 * It never creates or edits a role, a department, a designation or an HR
 * employee. department_id and designation are READ from the owner's masters and
 * copied onto the register row. It never deletes: a person entered by mistake is
 * VOIDED (shared §19 writer, src/lib/fssai-void.ts); a person who leaves is
 * status 'left' + left_on — their certificates were valid while they worked here.
 */

/* ------------------------------------------------------------------ *
 * 1. VOCABULARY
 * ------------------------------------------------------------------ */

export const FSSAI_HANDLER_STATUSES: readonly FssaiStatusMeta[] = [
  { key: 'active', label: 'Working here', color: 'bg-green-100 text-green-700 border-green-200' },
  { key: 'left',   label: 'Left',         color: 'bg-slate-100 text-slate-600 border-slate-200' },
  { key: 'void',   label: 'Voided',       color: 'bg-gray-100 text-gray-600 border-gray-200' },
] as const;

export const FSSAI_HANDLER_SOURCES: readonly { key: string; label: string }[] = [
  { key: 'manual', label: 'Added by hand' },
  { key: 'hrms',   label: 'From HRMS' },
  { key: 'users',  label: 'From the staff logins' },
] as const;

/** The person-scope certificate types this register reads. */
export const FSSAI_HANDLER_DOC_TYPES = ['medical_fitness', 'food_handler_training', 'fostac_certificate'] as const;

/**
 * FSSAI's FoSTaC rule of thumb: at least one trained and certified Food Safety
 * Supervisor on the premises, and one for every 25 food handlers. Written as a
 * named constant so the number on the screen and the number judged agree.
 */
export const FSSAI_FOSTAC_HANDLERS_PER_SUPERVISOR = 25;

export type FssaiHandlerRequirementKey = 'medical' | 'training' | 'fostac';

/**
 * WHAT EACH PERSON MUST HAVE, and what satisfies it.
 *
 * `no_expiry_ok` — a certificate with no expiry date recorded. For a MEDICAL
 * certificate that is not in order: FSSAI's Schedule 4 asks for a medical
 * examination at least once a year, and with no date nobody can say whether this
 * one still counts — the screen says "add the expiry date". For TRAINING it is in
 * order: an in-house food-safety training record (or an HRMS training mapped with
 * no validity) need not expire. A FoSTaC certificate is dated (two years), so it
 * is treated like the medical.
 *
 * A FoSTaC certificate is ALSO food-safety training, so it satisfies "training"
 * for the person who holds it.
 */
export const FSSAI_HANDLER_REQUIREMENTS: readonly {
  key: FssaiHandlerRequirementKey;
  label: string;
  /** the authority's line(s) */
  lines: string;
  doc_types: readonly string[];
  no_expiry_ok: boolean;
  /** who needs it */
  applies: (h: { is_food_handler: number | boolean; is_fostac_supervisor: number | boolean }) => boolean;
}[] = [
  {
    key: 'medical', label: 'Medical fitness', lines: '#55 · #106',
    doc_types: ['medical_fitness'], no_expiry_ok: false,
    applies: (h) => Number(h.is_food_handler) === 1 || h.is_food_handler === true,
  },
  {
    key: 'training', label: 'Food-safety training', lines: '#56 · #107',
    doc_types: ['food_handler_training', 'fostac_certificate'], no_expiry_ok: true,
    applies: (h) => Number(h.is_food_handler) === 1 || h.is_food_handler === true,
  },
  {
    key: 'fostac', label: 'FoSTaC (supervisor)', lines: '#107',
    doc_types: ['fostac_certificate'], no_expiry_ok: false,
    applies: (h) => Number(h.is_fostac_supervisor) === 1 || h.is_fostac_supervisor === true,
  },
] as const;

/**
 * One requirement's verdict for one person. Ordered best → worst; the rank is the
 * index, which is how the best of several certificates is chosen.
 *
 *  valid       in force, with a copy (a scan, or the HRMS completion itself)
 *  expiring    in force, inside its renewal window
 *  no_expiry   on file with no expiry date (in order only where no_expiry_ok)
 *  no_copy     on file and in force, but no scan anyone can read
 *  not_yet     on file, but in force only from a valid_from date still to come
 *              (owner ruling 2026-10-15: a renewal filed early is NOT in force
 *              yet) — so the person is judged on what is in force today
 *  expired     the latest one has lapsed
 *  missing     nothing on file at all
 *  not_required  this person does not need it (not a food handler / not the supervisor)
 */
export type FssaiHandlerVerdict = 'valid' | 'expiring' | 'no_expiry' | 'no_copy' | 'not_yet' | 'expired' | 'missing' | 'not_required';

export const FSSAI_HANDLER_VERDICTS: readonly (FssaiStatusMeta & { key: FssaiHandlerVerdict })[] = [
  { key: 'valid',        label: 'Valid',            color: 'bg-green-100 text-green-700 border-green-200' },
  { key: 'expiring',     label: 'Expiring soon',    color: 'bg-amber-100 text-amber-800 border-amber-200' },
  { key: 'no_expiry',    label: 'No expiry date',   color: 'bg-yellow-50 text-yellow-800 border-yellow-200' },
  { key: 'no_copy',      label: 'No copy on file',  color: 'bg-orange-100 text-orange-700 border-orange-200' },
  { key: 'not_yet',      label: 'Not yet in force', color: 'bg-orange-100 text-orange-700 border-orange-200' },
  { key: 'expired',      label: 'EXPIRED',          color: 'bg-red-100 text-red-700 border-red-200' },
  { key: 'missing',      label: 'MISSING',          color: 'bg-red-100 text-red-700 border-red-200' },
  { key: 'not_required', label: 'Not required',     color: 'bg-gray-50 text-gray-400 border-gray-200' },
] as const;

const VERDICT_RANK: Record<FssaiHandlerVerdict, number> = {
  valid: 0, expiring: 1, no_expiry: 2, no_copy: 3, not_yet: 4, expired: 5, missing: 6, not_required: 7,
};

/**
 * NOT YET IN FORCE (owner ruling 2026-10-15): a paper is in force only from its
 * valid_from date — a renewal filed early does not stand until then. The day it
 * comes into force when that is still to come; '' when it is in force by its
 * start (or carries no valid_from). The one test for the food-handler record,
 * the audit file's paper judge and Inspection Mode (fssaiHandoverPaperJudge).
 */
export function fssaiPaperStartsOn(validFrom: unknown, today: string): string {
  const v = (validFrom === null || validFrom === undefined ? '' : String(validFrom)).trim();
  return isISODate(v) && isISODate(today) && v > today ? v : '';
}

/** "Not yet in force (from 2026-10-22)" — the State words of a paper not in force yet. */
export function fssaiNotYetWords(startsOn: string): string {
  return `Not yet in force (from ${startsOn})`;
}

export function fssaiHandlerVerdictMeta(v: string | null | undefined): FssaiStatusMeta {
  return FSSAI_HANDLER_VERDICTS.find((x) => x.key === v) || { key: String(v || ''), label: String(v || ''), color: 'bg-gray-100 text-gray-600 border-gray-200' };
}

/** Training links may count as these (person scope, and a training — not the medical). */
export const FSSAI_TRAINING_LINK_COUNTS_AS = ['food_handler_training', 'fostac_certificate'] as const;

/* ------------------------------------------------------------------ *
 * 2. SMALL HELPERS
 * ------------------------------------------------------------------ */

const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(name);
}

/** ISO date + n calendar months, the day clamped to the month's end. '' if unreadable. */
export function addMonthsISO(iso: string, months: number): string {
  if (!isISODate(iso) || !Number.isFinite(months)) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const total = (m - 1) + Math.trunc(months);
  const ny = y + Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const dt = new Date(Date.UTC(ny, nm, Math.min(d, last)));
  return dt.toISOString().slice(0, 10);
}

/** Bare 10 digits (PhoneField contract) or '' — or null when it cannot be one. */
export function normPhone10(v: unknown): string | null {
  const digits = s(v).replace(/\D+/g, '');
  if (!digits) return '';
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return null;
}

function isoOrBlank(v: unknown): string | null {
  const x = s(v).trim();
  if (!x) return '';
  return isISODate(x) ? x : null;
}

function bool01(v: unknown, dflt: 0 | 1): 0 | 1 {
  if (v === undefined || v === null || v === '') return dflt;
  if (v === true || v === 1 || v === '1' || v === 'true' || v === 'yes') return 1;
  return 0;
}

/** Does this database have HRMS employees? (Q18: the key moves to employee_id once it does.) */
export function fssaiHrPopulated(db: Database.Database): { populated: boolean; employees: number } {
  if (!tableExists(db, 'hr_employees')) return { populated: false, employees: 0 };
  const n = Number((db.prepare(`SELECT COUNT(*) AS n FROM hr_employees`).get() as any)?.n) || 0;
  return { populated: n > 0, employees: n };
}

/* ------------------------------------------------------------------ *
 * 3. READING THE REGISTER
 * ------------------------------------------------------------------ */

export interface FssaiHandlerEvidence {
  source: 'document' | 'hrms';
  /** fssai_documents.id, or hr_training_assignments.id */
  id: string;
  doc_type: string;
  type_label: string;
  title: string;
  reference_no: string;
  issued_on: string;
  expiry_date: string;
  state: 'no_expiry' | 'valid' | 'expiring' | 'expired';
  /**
   * The day it comes into force (its valid_from) when that is after today —
   * NOT in force yet (fssaiPaperStartsOn); '' when it is in force by its start.
   */
  starts_on: string;
  days_to_expiry: number | null;
  /** live, readable scans on the document (void and blanked ones excluded); HRMS = 1 */
  copies: number;
  /** how the certificate was matched to this person */
  matched_by: 'handler_id' | 'person_email' | 'employee_id';
}

export interface FssaiHandlerRequirementResult {
  key: FssaiHandlerRequirementKey;
  label: string;
  required: boolean;
  verdict: FssaiHandlerVerdict;
  verdict_label: string;
  verdict_color: string;
  /** required and good enough for an inspector */
  in_order: boolean;
  /** the certificate the verdict rests on — null when missing / not required */
  best: FssaiHandlerEvidence | null;
  /** everything on file for this requirement, best first */
  evidence: FssaiHandlerEvidence[];
  /** what to do, in words, when not in order */
  todo: string;
}

export interface FssaiFoodHandler {
  id: string;
  handler_no: string;
  full_name: string;
  employee_id: string;
  employee_code: string;
  person_email: string;
  phone10: string;
  designation: string;
  department_id: string;
  department_name: string;
  is_food_handler: boolean;
  is_fostac_supervisor: boolean;
  joined_on: string;
  left_on: string;
  source: string;
  note: string;
  status: string;
  status_label: string;
  status_color: string;
  voided_at: string;
  voided_by: string;
  void_reason: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  /** which key identifies the person: HRMS record, a login, or the name alone */
  key_kind: 'hrms' | 'login' | 'name_only';
  user_name: string;
  hr_status: string;
  hr_exit_date: string;
  /** HRMS says this person has left but the register still says active */
  hr_says_left: boolean;
}

export interface FssaiFoodHandlerWithCoverage extends FssaiFoodHandler {
  coverage: Record<FssaiHandlerRequirementKey, FssaiHandlerRequirementResult>;
  /** every requirement that applies is in order */
  in_order: boolean;
  /** one line per requirement that is not in order */
  problems: string[];
}

const HANDLER_SELECT = `
  SELECT h.*,
         dep.name AS department_name,
         (SELECT u.name FROM users u WHERE h.person_email <> '' AND lower(u.email) = lower(h.person_email) LIMIT 1) AS user_name
    FROM fssai_food_handlers h
    LEFT JOIN departments dep ON dep.id = h.department_id`;

export function shapeFssaiFoodHandler(row: any, hr?: { status: string; exit_date: string } | null): FssaiFoodHandler {
  const status = s(row.status) || 'active';
  const meta = FSSAI_HANDLER_STATUSES.find((x) => x.key === status) || FSSAI_HANDLER_STATUSES[0];
  const hrStatus = s(hr?.status);
  return {
    id: s(row.id),
    handler_no: s(row.handler_no),
    full_name: s(row.full_name),
    employee_id: s(row.employee_id),
    employee_code: s(row.employee_code),
    person_email: s(row.person_email),
    phone10: s(row.phone10),
    designation: s(row.designation),
    department_id: s(row.department_id),
    department_name: s(row.department_name),
    is_food_handler: Number(row.is_food_handler) === 1,
    is_fostac_supervisor: Number(row.is_fostac_supervisor) === 1,
    joined_on: s(row.joined_on),
    left_on: s(row.left_on),
    source: s(row.source) || 'manual',
    note: s(row.note),
    status,
    status_label: meta.label,
    status_color: meta.color,
    voided_at: s(row.voided_at),
    voided_by: s(row.voided_by),
    void_reason: s(row.void_reason),
    created_by: s(row.created_by),
    created_at: s(row.created_at),
    updated_at: s(row.updated_at),
    key_kind: s(row.employee_id) ? 'hrms' : s(row.person_email) ? 'login' : 'name_only',
    user_name: s(row.user_name),
    hr_status: hrStatus,
    hr_exit_date: s(hr?.exit_date),
    hr_says_left: status === 'active' && EXITED_STATUSES.has(hrStatus),
  };
}

/** HRMS status + exit date for a set of employee ids (read only). */
function readHrFacts(db: Database.Database, employeeIds: string[]): Map<string, { status: string; exit_date: string }> {
  const out = new Map<string, { status: string; exit_date: string }>();
  const ids = [...new Set(employeeIds.filter(Boolean))];
  if (!ids.length || !tableExists(db, 'hr_employees')) return out;
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const rows = db.prepare(
      `SELECT id, status, exit_date FROM hr_employees WHERE id IN (${chunk.map(() => '?').join(',')})`,
    ).all(...chunk) as any[];
    for (const r of rows) out.set(s(r.id), { status: s(r.status), exit_date: s(r.exit_date) });
  }
  return out;
}

/** One handler row (any status) shaped, or null. */
export function readFssaiFoodHandler(db: Database.Database, id: string): FssaiFoodHandler | null {
  if (!tableExists(db, 'fssai_food_handlers')) return null;
  const row = db.prepare(`${HANDLER_SELECT} WHERE h.id = ?`).get(s(id)) as any;
  if (!row) return null;
  const hr = readHrFacts(db, [s(row.employee_id)]).get(s(row.employee_id)) || null;
  return shapeFssaiFoodHandler(row, hr);
}

/* ------------------------------------------------------------------ *
 * 4. COVERAGE — the list that names who has NO valid certificate
 * ------------------------------------------------------------------ */

export interface FssaiHandlerCoverageOptions {
  /** IST date; defaults to the caller's fssaiToday() — passed so a report and its PDF agree */
  today: string;
  /** include people who have left (their certificates, for the record). Default false. */
  includeLeft?: boolean;
  /** restrict to these handler ids */
  ids?: string[];
}

export interface FssaiHandlerCoverage {
  /** false when the register table does not exist in this database yet */
  available: boolean;
  today: string;
  handlers: FssaiFoodHandlerWithCoverage[];
  totals: {
    /** people working here (status active) */
    active: number;
    /** active AND is_food_handler — the people #55/#56 are about */
    food_handlers: number;
    left: number;
    /** active people whose every applicable requirement is in order */
    in_order: number;
    not_in_order: number;
    by_requirement: Record<FssaiHandlerRequirementKey, Record<FssaiHandlerVerdict, number>>;
  };
  /** the premises' FoSTaC supervisors (#107) */
  fostac: {
    supervisors: number;
    /** supervisors whose FoSTaC certificate is in order */
    certified: number;
    /** 1 per 25 food handlers, never fewer than 1 */
    required: number;
    ok: boolean;
    handlers_per_supervisor: number;
    names: { id: string; full_name: string; verdict: FssaiHandlerVerdict }[];
    words: string;
  };
  /** active people NOT in order for each requirement, worst first — the inspector's list */
  not_in_order: Record<FssaiHandlerRequirementKey, { id: string; handler_no: string; full_name: string; verdict: FssaiHandlerVerdict; verdict_label: string; expiry_date: string }[]>;
  /** live person-scope certificates that match NO handler on the register — to be linked */
  unassigned_certificates: {
    id: string; doc_type: string; type_label: string; title: string; person_email: string;
    handler_id: string; expiry_date: string; state: string; why: string;
  }[];
  hr: { populated: boolean; employees: number; linked_handlers: number; links_active: number };
  /** the basis, in words, so a screen or a PDF can print how this was judged */
  basis: string;
}

function emptyCounts(): Record<FssaiHandlerVerdict, number> {
  return { valid: 0, expiring: 0, no_expiry: 0, no_copy: 0, not_yet: 0, expired: 0, missing: 0, not_required: 0 };
}

function evidenceVerdict(e: FssaiHandlerEvidence): FssaiHandlerVerdict {
  if (e.state === 'expired') return 'expired';
  // In force only from a day still to come: not in force today, whatever its expiry.
  if (e.starts_on) return 'not_yet';
  if (e.copies <= 0) return 'no_copy';
  if (e.state === 'expiring') return 'expiring';
  if (e.state === 'no_expiry') return 'no_expiry';
  return 'valid';
}

function judgeRequirement(
  req: (typeof FSSAI_HANDLER_REQUIREMENTS)[number],
  handler: FssaiFoodHandler,
  evidence: FssaiHandlerEvidence[],
): FssaiHandlerRequirementResult {
  const required = handler.status === 'active' && req.applies(handler as any);
  const mine = evidence.filter((e) => req.doc_types.includes(e.doc_type));
  // Best first: by verdict rank, then the later expiry (blank last), then the later issue.
  const ranked = mine
    .map((e) => ({ e, v: evidenceVerdict(e) }))
    .sort((a, b) =>
      VERDICT_RANK[a.v] - VERDICT_RANK[b.v]
      || (b.e.expiry_date || '0000').localeCompare(a.e.expiry_date || '0000')
      || (b.e.issued_on || '').localeCompare(a.e.issued_on || ''));
  let verdict: FssaiHandlerVerdict;
  if (!required) verdict = 'not_required';
  else if (!ranked.length) verdict = 'missing';
  else verdict = ranked[0].v;
  const best = required && ranked.length ? ranked[0].e : null;
  // A RENEWAL ALREADY FILED. The certificate in force today is inside its
  // renewal window, and the next one is on file, with a copy, and comes into
  // force by the day after it lapses: the person is judged on the one in force
  // (it is the best), but there is nothing left to renew, so it is not flagged
  // "Expiring soon". A renewal that leaves a gap is not this case.
  if (verdict === 'expiring' && best && isISODate(best.expiry_date)) {
    const dayAfter = addDaysISO(best.expiry_date, 1);
    const renewed = mine.some((e) => e.starts_on && e.starts_on <= dayAfter && e.copies > 0 && e.state !== 'expired' &&
      (e.state !== 'no_expiry' || req.no_expiry_ok));
    if (renewed) verdict = 'valid';
  }
  const inOrder = required && (verdict === 'valid' || verdict === 'expiring' || (verdict === 'no_expiry' && req.no_expiry_ok));
  const meta = fssaiHandlerVerdictMeta(verdict);
  const what = req.key === 'medical' ? 'medical fitness certificate'
    : req.key === 'training' ? 'food-safety training certificate (or a FoSTaC certificate)'
      : 'FoSTaC certificate';
  const todo = !required || inOrder ? (verdict === 'expiring' && best ? `Renew the ${what} before ${best.expiry_date}.` : '')
    : verdict === 'missing' ? `File a ${what} for ${handler.full_name}, with a scan.`
      : verdict === 'expired' ? `${handler.full_name}'s ${what} expired on ${best?.expiry_date}. File the new one.`
        : verdict === 'no_copy' ? `Attach a scan of ${handler.full_name}'s ${what} — without a copy it cannot be shown.`
          : verdict === 'no_expiry' ? `Add the expiry date to ${handler.full_name}'s ${what}.`
            : verdict === 'not_yet' && best ? `${handler.full_name}'s ${what} on file is in force only from ${best.starts_on}; until then none is in force. File the one in force today, if there is one.`
              : '';
  return {
    key: req.key,
    label: req.label,
    required,
    verdict,
    // "Not yet in force (from 2026-10-22)" — the date is the reason.
    verdict_label: verdict === 'not_yet' && best ? fssaiNotYetWords(best.starts_on) : meta.label,
    verdict_color: meta.color,
    in_order: inOrder,
    best,
    evidence: ranked.map((r) => r.e),
    todo,
  };
}

/**
 * THE COVERAGE OF EVERY PERSON ON THE REGISTER — EXPORTED FOR THE AUDIT FILE AND
 * INSPECTION MODE (a later lane renders it; this function is the one source).
 *
 * Read-only. Never throws for a missing table: `available: false` says so.
 * A person's certificate is matched by fssai_documents.handler_id first, then —
 * only for a row whose handler_id is '' — by person_email (Q18 fallback).
 * Superseded (is_active = 0) and voided documents never count. A scan counts as a
 * copy only if it is still readable and NOT voided.
 */
export function readFssaiFoodHandlerCoverage(db: Database.Database, opts: FssaiHandlerCoverageOptions): FssaiHandlerCoverage {
  const today = opts.today;
  const hrInfo = fssaiHrPopulated(db);
  const empty: FssaiHandlerCoverage = {
    available: false, today, handlers: [],
    totals: {
      active: 0, food_handlers: 0, left: 0, in_order: 0, not_in_order: 0,
      by_requirement: { medical: emptyCounts(), training: emptyCounts(), fostac: emptyCounts() },
    },
    fostac: { supervisors: 0, certified: 0, required: 1, ok: false, handlers_per_supervisor: FSSAI_FOSTAC_HANDLERS_PER_SUPERVISOR, names: [], words: '' },
    not_in_order: { medical: [], training: [], fostac: [] },
    unassigned_certificates: [],
    hr: { populated: hrInfo.populated, employees: hrInfo.employees, linked_handlers: 0, links_active: 0 },
    basis: '',
  };
  if (!tableExists(db, 'fssai_food_handlers') || !tableExists(db, 'fssai_documents')) return empty;

  const where: string[] = [`h.status <> 'void'`];
  const args: any[] = [];
  if (!opts.includeLeft) where.push(`h.status = 'active'`);
  if (opts.ids && opts.ids.length) {
    where.push(`h.id IN (${opts.ids.map(() => '?').join(',')})`);
    args.push(...opts.ids);
  }
  const rows = db.prepare(
    `${HANDLER_SELECT} WHERE ${where.join(' AND ')}
      ORDER BY CASE h.status WHEN 'active' THEN 0 ELSE 1 END, lower(h.full_name), h.handler_no`,
  ).all(...args) as any[];
  const hrFacts = readHrFacts(db, rows.map((r) => s(r.employee_id)));
  const handlers = rows.map((r) => shapeFssaiFoodHandler(r, hrFacts.get(s(r.employee_id)) || null));

  // The keys every ACTIVE-OR-LEFT, non-void handler answers to, for matching.
  const keyRows = db.prepare(
    `SELECT id, lower(person_email) AS em FROM fssai_food_handlers WHERE status <> 'void'`,
  ).all() as any[];
  const handlerIds = new Set(keyRows.map((r) => s(r.id)));
  const byEmail = new Map<string, string>();
  for (const r of keyRows) if (s(r.em)) byEmail.set(s(r.em), s(r.id));

  /* Certificates: live, current versions of the three person types. The copy
   * count excludes voided files and blanked images — a voided scan is kept as
   * evidence of the mistake, never as a copy of the certificate. */
  const hasAttStatus = !!db.prepare(`SELECT 1 FROM pragma_table_xinfo('fssai_attachments') WHERE name = 'status'`).get();
  const types = [...FSSAI_HANDLER_DOC_TYPES];
  const docs = db.prepare(
    `SELECT d.id, d.doc_type, d.title, d.reference_no, d.issued_on, d.valid_from, d.expiry_date, d.reminder_days,
            d.handler_id, lower(d.person_email) AS person_email,
            (SELECT COUNT(*) FROM fssai_attachments a
              WHERE a.entity_table = 'fssai_documents' AND a.entity_id = d.id AND a.data_uri <> ''
                ${hasAttStatus ? `AND a.status <> 'void'` : ''}) AS copies
       FROM fssai_documents d
      WHERE d.doc_type IN (${types.map(() => '?').join(',')})
        AND d.is_active = 1 AND d.voided_at = '' AND d.status <> 'void'`,
  ).all(...types) as any[];

  const evidenceBy = new Map<string, FssaiHandlerEvidence[]>();
  const push = (hid: string, e: FssaiHandlerEvidence) => {
    const l = evidenceBy.get(hid) || [];
    l.push(e);
    evidenceBy.set(hid, l);
  };
  const unassigned: FssaiHandlerCoverage['unassigned_certificates'] = [];
  for (const d of docs) {
    const reminder = Number.isFinite(Number(d.reminder_days)) ? Number(d.reminder_days) : FSSAI_DOC_REMINDER_DAYS;
    const state = fssaiDocState(s(d.expiry_date), today, reminder);
    const days = isISODate(s(d.expiry_date)) ? daysBetweenISO(today, s(d.expiry_date)) : null;
    let hid = '';
    let matched: FssaiHandlerEvidence['matched_by'] = 'handler_id';
    let why = '';
    if (s(d.handler_id)) {
      if (handlerIds.has(s(d.handler_id))) hid = s(d.handler_id);
      else why = 'Filed against a food handler who has since been voided from the register.';
    } else if (s(d.person_email) && byEmail.has(s(d.person_email))) {
      hid = byEmail.get(s(d.person_email))!;
      matched = 'person_email';
    } else {
      why = s(d.person_email)
        ? `Filed against the login ${s(d.person_email)}, who is not on the food-handler register.`
        : 'Filed against nobody.';
    }
    const ev: FssaiHandlerEvidence = {
      source: 'document', id: s(d.id), doc_type: s(d.doc_type),
      type_label: fssaiDocType(s(d.doc_type))?.label || s(d.doc_type),
      title: s(d.title), reference_no: s(d.reference_no), issued_on: s(d.issued_on),
      expiry_date: s(d.expiry_date), state, starts_on: fssaiPaperStartsOn(d.valid_from, today),
      days_to_expiry: days !== null && Number.isFinite(days) ? days : null,
      copies: Number(d.copies) || 0, matched_by: matched,
    };
    if (hid) push(hid, ev);
    else {
      unassigned.push({
        id: ev.id, doc_type: ev.doc_type, type_label: ev.type_label, title: ev.title,
        person_email: s(d.person_email), handler_id: s(d.handler_id), expiry_date: ev.expiry_date, state, why,
      });
    }
  }

  // HRMS completions, through the mapping. Read-only joins; absent tables = none.
  let linksActive = 0;
  if (tableExists(db, 'fssai_training_links') && tableExists(db, 'hr_training_assignments')) {
    linksActive = Number((db.prepare(`SELECT COUNT(*) AS n FROM fssai_training_links WHERE is_active = 1`).get() as any)?.n) || 0;
    const emp = handlers.filter((h) => h.employee_id);
    const empToHandler = new Map(emp.map((h) => [h.employee_id, h.id]));
    const empIds = [...empToHandler.keys()];
    for (let i = 0; i < empIds.length && linksActive > 0; i += 400) {
      const chunk = empIds.slice(i, i + 400);
      const comps = db.prepare(
        `SELECT a.id, a.employee_id, a.completed_date, l.counts_as, l.valid_months,
                COALESCE(NULLIF(l.training_name, ''), ${tableExists(db, 'hr_trainings') ? `(SELECT t.name FROM hr_trainings t WHERE t.id = a.training_id)` : `''`}, 'HRMS training') AS training_name
           FROM hr_training_assignments a
           JOIN fssai_training_links l ON l.hr_training_id = a.training_id AND l.is_active = 1
          WHERE a.status = 'completed' AND a.completed_date <> ''
            AND a.employee_id IN (${chunk.map(() => '?').join(',')})`,
      ).all(...chunk) as any[];
      for (const c of comps) {
        const hid = empToHandler.get(s(c.employee_id));
        if (!hid || !isISODate(s(c.completed_date))) continue;
        const months = c.valid_months === null || c.valid_months === undefined || c.valid_months === '' ? null : Number(c.valid_months);
        const expiry = months !== null && Number.isFinite(months) && months > 0 ? addMonthsISO(s(c.completed_date), months) : '';
        const state = fssaiDocState(expiry, today, FSSAI_DOC_REMINDER_DAYS);
        const days = expiry ? daysBetweenISO(today, expiry) : null;
        push(hid, {
          source: 'hrms', id: s(c.id), doc_type: s(c.counts_as),
          type_label: `${fssaiDocType(s(c.counts_as))?.label || s(c.counts_as)} (HRMS)`,
          title: s(c.training_name), reference_no: '', issued_on: s(c.completed_date),
          // A completion stands from the day it was completed (HRMS writes it after the fact).
          expiry_date: expiry, state, starts_on: '', days_to_expiry: days !== null && Number.isFinite(days) ? days : null,
          // The HRMS completion IS the record of the training; there is no scan to lose.
          copies: 1, matched_by: 'employee_id',
        });
      }
    }
  }

  const out: FssaiFoodHandlerWithCoverage[] = handlers.map((h) => {
    const ev = evidenceBy.get(h.id) || [];
    const coverage = {} as Record<FssaiHandlerRequirementKey, FssaiHandlerRequirementResult>;
    for (const req of FSSAI_HANDLER_REQUIREMENTS) coverage[req.key] = judgeRequirement(req, h, ev);
    const applicable = FSSAI_HANDLER_REQUIREMENTS.filter((r) => coverage[r.key].required);
    const problems = applicable.filter((r) => !coverage[r.key].in_order)
      .map((r) => `${r.label}: ${coverage[r.key].verdict_label}`);
    return { ...h, coverage, in_order: h.status === 'active' && problems.length === 0, problems };
  });

  const totals = empty.totals;
  totals.by_requirement = { medical: emptyCounts(), training: emptyCounts(), fostac: emptyCounts() };
  const notInOrder: FssaiHandlerCoverage['not_in_order'] = { medical: [], training: [], fostac: [] };
  for (const h of out) {
    if (h.status === 'left') { totals.left++; continue; }
    totals.active++;
    if (h.is_food_handler) totals.food_handlers++;
    if (h.in_order) totals.in_order++; else totals.not_in_order++;
    for (const req of FSSAI_HANDLER_REQUIREMENTS) {
      const c = h.coverage[req.key];
      totals.by_requirement[req.key][c.verdict]++;
      if (c.required && !c.in_order) {
        notInOrder[req.key].push({
          id: h.id, handler_no: h.handler_no, full_name: h.full_name,
          // A paper not in force yet carries its start date in verdict_label; its
          // expiry beside that would read as when it lapses, so it is left off.
          verdict: c.verdict, verdict_label: c.verdict_label, expiry_date: c.verdict === 'not_yet' ? '' : c.best?.expiry_date || '',
        });
      }
    }
  }
  for (const k of Object.keys(notInOrder) as FssaiHandlerRequirementKey[]) {
    notInOrder[k].sort((a, b) => VERDICT_RANK[b.verdict] - VERDICT_RANK[a.verdict] || a.full_name.localeCompare(b.full_name));
  }

  const sup = out.filter((h) => h.status === 'active' && h.is_fostac_supervisor);
  const certified = sup.filter((h) => h.coverage.fostac.in_order).length;
  const required = Math.max(1, Math.ceil(totals.food_handlers / FSSAI_FOSTAC_HANDLERS_PER_SUPERVISOR));
  const fostacOk = certified >= required;
  const fostacWords = !sup.length
    ? 'No FoSTaC supervisor is marked on the register. Mark the trained Food Safety Supervisor and file their FoSTaC certificate.'
    : fostacOk
      ? `${certified} certified FoSTaC supervisor${certified === 1 ? '' : 's'} for ${totals.food_handlers} food handler${totals.food_handlers === 1 ? '' : 's'} (at least ${required} needed).`
      : `${certified} of the ${sup.length} supervisor${sup.length === 1 ? '' : 's'} marked ${certified === 1 ? 'has' : 'have'} a FoSTaC certificate in order; ${required} ${required === 1 ? 'is' : 'are'} needed for ${totals.food_handlers} food handler${totals.food_handlers === 1 ? '' : 's'}.`;

  const linked = out.filter((h) => h.employee_id).length;
  return {
    available: true,
    today,
    handlers: out,
    totals,
    fostac: {
      supervisors: sup.length, certified, required, ok: fostacOk,
      handlers_per_supervisor: FSSAI_FOSTAC_HANDLERS_PER_SUPERVISOR,
      names: sup.map((h) => ({ id: h.id, full_name: h.full_name, verdict: h.coverage.fostac.verdict })),
      words: fostacWords,
    },
    not_in_order: notInOrder,
    unassigned_certificates: unassigned,
    hr: { populated: hrInfo.populated, employees: hrInfo.employees, linked_handlers: linked, links_active: linksActive },
    basis:
      'Every person on the food-handler register who works here is judged on their own. A food handler needs a medical fitness ' +
      'certificate and food-safety training (a FoSTaC certificate counts as training); the FoSTaC supervisor needs a FoSTaC ' +
      'certificate. The best current certificate decides: in force with a scan → Valid; inside its renewal window → Expiring; ' +
      'no scan → No copy; lapsed → EXPIRED; nothing on file → MISSING. A certificate is in force only from its valid-from date: ' +
      'one dated to start on a day still to come (a renewal filed early) is Not yet in force, and the person is judged on what is in force today. ' +
      'A medical or FoSTaC certificate with no expiry date is ' +
      'not in order (nobody can say it still counts); a training record with no expiry is. HRMS training completions count ' +
      'when an HRMS training is mapped on this screen. Voided and superseded certificates, and voided scans, never count. ' +
      `At least one certified FoSTaC supervisor is needed for every ${FSSAI_FOSTAC_HANDLERS_PER_SUPERVISOR} food handlers.`,
  };
}

/* ------------------------------------------------------------------ *
 * 5. WHOSE CERTIFICATE IS THIS — for Inspection Mode and the audit file
 * ------------------------------------------------------------------ */

export interface FssaiDocHolder {
  /** '' when the certificate is keyed on a login that is not on the register */
  handler_id: string;
  handler_no: string;
  name: string;
  person_email: string;
  /** "Ravi Kumar (FH-0003)" / "Ravi Kumar" / "ravi@x.com" / "" */
  label: string;
}

/**
 * EXPORTED FOR INSPECTION MODE / THE AUDIT FILE: who each person-scope document
 * belongs to, in words. handler_id first, then the login (handler with that
 * email, else the user's name, else the email). Documents of other scopes, or
 * with no person at all, are left out of the map.
 */
export function fssaiDocumentHolders(
  db: Database.Database,
  docs: { id: string; handler_id?: string | null; person_email?: string | null }[],
): Map<string, FssaiDocHolder> {
  const out = new Map<string, FssaiDocHolder>();
  const haveTable = tableExists(db, 'fssai_food_handlers');
  const byId = db.prepare(haveTable ? `SELECT id, handler_no, full_name, person_email FROM fssai_food_handlers WHERE id = ?` : `SELECT NULL WHERE 0`);
  const byEmail = db.prepare(haveTable
    ? `SELECT id, handler_no, full_name, person_email FROM fssai_food_handlers WHERE status <> 'void' AND lower(person_email) = ? LIMIT 1`
    : `SELECT NULL WHERE 0`);
  const userByEmail = db.prepare(`SELECT name FROM users WHERE lower(email) = ? LIMIT 1`);
  for (const d of docs) {
    const hid = s(d.handler_id);
    const em = s(d.person_email).toLowerCase();
    let h: any = null;
    if (hid && haveTable) h = byId.get(hid);
    if (!h && !hid && em && haveTable) h = byEmail.get(em);
    if (h) {
      const name = s(h.full_name);
      out.set(s(d.id), {
        handler_id: s(h.id), handler_no: s(h.handler_no), name, person_email: s(h.person_email),
        label: s(h.handler_no) ? `${name} (${s(h.handler_no)})` : name,
      });
    } else if (em) {
      const u = userByEmail.get(em) as any;
      const name = s(u?.name);
      out.set(s(d.id), { handler_id: '', handler_no: '', name, person_email: em, label: name || em });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 6. THE DOCUMENTS ROUTE'S PERSON SCOPE
 * ------------------------------------------------------------------ */

/**
 * Resolve WHO a person-scope certificate is filed against, for the documents
 * route. Returns the refusal in words, or the two columns to write.
 *
 *  · handler_id given → it must be a handler on the register that is not void.
 *    person_email is copied from the handler (may be '' — a cook with no login).
 *  · else person_email given → it must be a login (typo guard, as before); if a
 *    non-void handler has that email, handler_id is filled in so coverage reads
 *    the strong key. (Q18: the email remains the fallback for a login that is not
 *    on the register yet.)
 *  · neither → refused.
 */
export function resolveFssaiCertificateHolder(
  db: Database.Database,
  input: { handler_id: string; person_email: string },
): { error: string } | { handler_id: string; person_email: string } {
  const hid = s(input.handler_id).trim();
  const em = s(input.person_email).trim().toLowerCase();
  const haveTable = tableExists(db, 'fssai_food_handlers');
  if (hid) {
    if (!haveTable) return { error: 'The food-handler register has not been created in this database yet. Restart the application once.' };
    const h = db.prepare(`SELECT id, status, person_email, full_name FROM fssai_food_handlers WHERE id = ?`).get(hid) as any;
    if (!h) return { error: 'That person is not on the food-handler register.' };
    if (s(h.status) === 'void') return { error: `${s(h.full_name)} was voided from the register, so nothing more can be filed against them.` };
    if (em && s(h.person_email) && em !== s(h.person_email).toLowerCase()) {
      return { error: 'The person picked and the login given are two different people. Pick one.' };
    }
    return { handler_id: s(h.id), person_email: s(h.person_email).toLowerCase() };
  }
  if (!em) return { error: 'A certificate of this kind belongs to a person. Pick them from the food-handler register.' };
  const u = db.prepare(`SELECT email FROM users WHERE lower(email) = ?`).get(em);
  if (!u) {
    return { error: 'That is not somebody on the staff list. Pick the person from the food-handler register instead — they do not need a login.' };
  }
  let linked = '';
  if (haveTable) {
    const h = db.prepare(
      `SELECT id FROM fssai_food_handlers WHERE status <> 'void' AND lower(person_email) = ? LIMIT 1`,
    ).get(em) as any;
    linked = s(h?.id);
  }
  return { handler_id: linked, person_email: em };
}

/* ------------------------------------------------------------------ *
 * 7. WRITING THE REGISTER (synchronous — call inside the route's transaction)
 * ------------------------------------------------------------------ */

export interface FssaiHandlerActor { email?: string | null; name?: string | null }

type Refusal = { error: string; status: number; code?: string; existing_id?: string };

/** 'FH-0001', the next for this outlet. Call inside the transaction that inserts. */
export function nextFssaiHandlerNo(db: Database.Database, outletId: string): string {
  const r = db.prepare(
    `SELECT MAX(CAST(substr(handler_no, 4) AS INTEGER)) AS n
       FROM fssai_food_handlers WHERE outlet_id = ? AND handler_no LIKE 'FH-%'`,
  ).get(s(outletId)) as any;
  return `FH-${String((Number(r?.n) || 0) + 1).padStart(4, '0')}`;
}

interface HrEmployeeFacts {
  id: string; employee_code: string; full_name: string; phone10: string; department_id: string;
  designation: string; joining_date: string; status: string; exit_date: string; user_email: string;
}

function readHrEmployee(db: Database.Database, id: string): HrEmployeeFacts | null {
  if (!id || !tableExists(db, 'hr_employees')) return null;
  const desig = tableExists(db, 'hr_designations')
    ? `(SELECT d.name FROM hr_designations d WHERE d.id = e.designation_id)` : `''`;
  const r = db.prepare(
    `SELECT e.id, e.employee_code, e.full_name, e.phone10, e.department_id, e.joining_date, e.status, e.exit_date,
            ${desig} AS designation,
            (SELECT lower(u.email) FROM users u WHERE u.id = e.user_id) AS user_email
       FROM hr_employees e WHERE e.id = ?`,
  ).get(id) as any;
  if (!r) return null;
  return {
    id: s(r.id), employee_code: s(r.employee_code), full_name: s(r.full_name), phone10: s(r.phone10),
    department_id: s(r.department_id), designation: s(r.designation), joining_date: s(r.joining_date),
    status: s(r.status), exit_date: s(r.exit_date), user_email: s(r.user_email),
  };
}

/** The HR employee a login belongs to (hr_employees.user_id → users.id), or ''. */
function hrEmployeeForEmail(db: Database.Database, email: string): string {
  if (!email || !tableExists(db, 'hr_employees')) return '';
  const r = db.prepare(
    `SELECT e.id FROM hr_employees e JOIN users u ON u.id = e.user_id WHERE lower(u.email) = ? LIMIT 1`,
  ).get(email.toLowerCase()) as any;
  return s(r?.id);
}

function findByKey(db: Database.Database, outletId: string, col: 'employee_id' | 'person_email', value: string, exceptId = ''): any {
  if (!value) return null;
  const sql = col === 'employee_id'
    ? `SELECT id, status, full_name, handler_no FROM fssai_food_handlers WHERE outlet_id = ? AND employee_id = ? AND status <> 'void' AND id <> ? LIMIT 1`
    : `SELECT id, status, full_name, handler_no FROM fssai_food_handlers WHERE outlet_id = ? AND lower(person_email) = lower(?) AND status <> 'void' AND id <> ? LIMIT 1`;
  return db.prepare(sql).get(s(outletId), value, exceptId) || null;
}

function duplicateRefusal(existing: any, what: string): Refusal {
  const left = s(existing.status) === 'left';
  return {
    error: left
      ? `${s(existing.full_name)} (${s(existing.handler_no)}) is already on the register with this ${what}, marked as left. Use "Rejoined" on that row — the same person keeps the same record.`
      : `${s(existing.full_name)} (${s(existing.handler_no)}) is already on the register with this ${what}.`,
    status: 409,
    code: left ? 'left_row_exists' : 'already_on_register',
    existing_id: s(existing.id),
  };
}

export interface FssaiHandlerInput {
  full_name?: unknown;
  employee_id?: unknown;
  person_email?: unknown;
  phone10?: unknown;
  designation?: unknown;
  department_id?: unknown;
  is_food_handler?: unknown;
  is_fostac_supervisor?: unknown;
  joined_on?: unknown;
  note?: unknown;
}

/**
 * Validate a create or an update into the columns to write. `before` is the
 * existing row for an update (fields left undefined keep their value).
 */
function resolveHandlerFields(
  db: Database.Database,
  outletId: string,
  body: FssaiHandlerInput,
  before: any | null,
): Refusal | { cols: Record<string, any>; warnings: string[]; source: string } {
  const pick = (k: keyof FssaiHandlerInput) => (body[k] === undefined && before ? before[k] : body[k]);
  const warnings: string[] = [];

  // employee_id (HRMS) — read only; copies the HR facts it has.
  let employeeId = s(pick('employee_id')).trim();
  let emp: HrEmployeeFacts | null = null;
  if (employeeId) {
    emp = readHrEmployee(db, employeeId);
    if (!emp) return { error: 'That employee is not in HRMS.', status: 400 };
  }

  // person_email (login) — typo guard against users, as the documents route does.
  let personEmail = s(pick('person_email')).trim().toLowerCase();
  // On CREATE only, an HR record's own login is copied across. An update never
  // fills a key the manager did not touch — that would be a silent re-keying.
  if (!before && !personEmail && emp?.user_email && body.person_email === undefined) personEmail = emp.user_email;
  if (personEmail) {
    const u = db.prepare(`SELECT email FROM users WHERE lower(email) = ?`).get(personEmail);
    if (!u) return { error: 'That login is not on the staff list. Leave it blank — a food handler does not need a login.', status: 400 };
    if (emp && emp.user_email && emp.user_email !== personEmail) {
      return { error: 'HRMS links that employee to a different login. Pick the matching one, or leave the login blank.', status: 400 };
    }
    // Q18: once HR knows this login, the HR record is the stronger key (on create).
    if (!employeeId && !before) {
      const viaLogin = hrEmployeeForEmail(db, personEmail);
      if (viaLogin) { employeeId = viaLogin; emp = readHrEmployee(db, viaLogin); }
    }
  }

  const fullName = (s(pick('full_name')).trim() || emp?.full_name || '').replace(/\s+/g, ' ');
  if (fullName.length < 2) return { error: 'Write the person\'s name as it should appear on the register.', status: 400 };
  if (fullName.length > 120) return { error: 'That name is too long for the register (120 characters at most).', status: 400 };

  const phone = normPhone10(body.phone10 === undefined ? (before ? before.phone10 : emp?.phone10) : body.phone10);
  if (phone === null) return { error: 'A phone number is 10 digits (a +91 in front is fine).', status: 400 };

  const departmentId = s(body.department_id === undefined ? (before ? before.department_id : emp?.department_id) : body.department_id).trim();
  if (departmentId) {
    const d = db.prepare(`SELECT id FROM departments WHERE id = ?`).get(departmentId);
    if (!d) return { error: 'That department is not in the list.', status: 400 };
  }
  const designation = s(body.designation === undefined ? (before ? before.designation : emp?.designation) : body.designation).trim().slice(0, 120);

  const joinedOn = isoOrBlank(body.joined_on === undefined ? (before ? before.joined_on : emp?.joining_date) : body.joined_on);
  if (joinedOn === null) return { error: 'The joining date is not a date.', status: 400 };

  const isFH = bool01(pick('is_food_handler'), 1);
  const isSup = bool01(pick('is_fostac_supervisor'), 0);
  if (!isFH && !isSup) {
    return { error: 'This person neither handles food nor is the FoSTaC supervisor, so they do not belong on the food-handler register.', status: 400 };
  }

  // Keys must be free (the partial UNIQUE indexes are the backstop).
  const selfId = before ? s(before.id) : '';
  if (employeeId) {
    const dup = findByKey(db, outletId, 'employee_id', employeeId, selfId);
    if (dup) return duplicateRefusal(dup, 'HRMS record');
  }
  if (personEmail) {
    const dup = findByKey(db, outletId, 'person_email', personEmail, selfId);
    if (dup) return duplicateRefusal(dup, 'login');
  }

  // Warn, never refuse (the Q16 default): a second row with the same name and no key.
  const sameName = db.prepare(
    `SELECT handler_no FROM fssai_food_handlers WHERE status <> 'void' AND lower(full_name) = lower(?) AND id <> ? LIMIT 1`,
  ).get(fullName, selfId) as any;
  if (sameName) warnings.push(`${s(sameName.handler_no)} already has the name "${fullName}". If it is the same person, void this one rather than keep two rows.`);
  const hr = fssaiHrPopulated(db);
  if (hr.populated && !employeeId) {
    warnings.push(`HRMS has ${hr.employees} employee${hr.employees === 1 ? '' : 's'} and this person is not linked to one. Link them if they are on the payroll, so the register follows HR.`);
  }

  const cols: Record<string, any> = {
    full_name: fullName,
    employee_id: employeeId,
    employee_code: emp ? emp.employee_code : (employeeId && before ? s(before.employee_code) : ''),
    person_email: personEmail,
    phone10: phone,
    designation,
    department_id: departmentId,
    is_food_handler: isFH,
    is_fostac_supervisor: isSup,
    joined_on: joinedOn,
    note: s(pick('note')).slice(0, 2000),
  };
  return { cols, warnings, source: employeeId ? 'hrms' : 'manual' };
}

/** Put one person on the register. */
export function createFssaiFoodHandler(
  db: Database.Database,
  p: { body: FssaiHandlerInput; source?: 'manual' | 'hrms' | 'users'; actor: FssaiHandlerActor; outletId: string },
): Refusal | { handler: FssaiFoodHandler; warnings: string[] } {
  const r = resolveHandlerFields(db, p.outletId, p.body, null);
  if ('error' in r) return r;
  const id = generateId();
  const now = new Date().toISOString();
  const handlerNo = nextFssaiHandlerNo(db, p.outletId);
  const source = p.source || r.source;
  db.prepare(
    `INSERT INTO fssai_food_handlers
       (id, handler_no, employee_id, employee_code, person_email, full_name, phone10, designation,
        department_id, is_food_handler, is_fostac_supervisor, joined_on, left_on, source, note,
        status, created_by, outlet_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'',?,?,'active',?,?,?,?)`,
  ).run(
    id, handlerNo, r.cols.employee_id, r.cols.employee_code, r.cols.person_email, r.cols.full_name,
    r.cols.phone10, r.cols.designation, r.cols.department_id, r.cols.is_food_handler, r.cols.is_fostac_supervisor,
    r.cols.joined_on, source, r.cols.note, s(p.actor.email), s(p.outletId), now, now,
  );
  fssaiAudit(db, {
    entity_table: 'fssai_food_handlers', entity_id: id, action: 'create',
    after: { handler_no: handlerNo, source, ...r.cols },
    actor: p.actor, outlet_id: p.outletId,
  });
  return { handler: readFssaiFoodHandler(db, id)!, warnings: r.warnings };
}

const EDITABLE = ['full_name', 'employee_id', 'employee_code', 'person_email', 'phone10', 'designation',
  'department_id', 'is_food_handler', 'is_fostac_supervisor', 'joined_on', 'note'] as const;

/** Correct a person's details. A void row is closed; every change is audited field by field. */
export function updateFssaiFoodHandler(
  db: Database.Database,
  p: { id: string; body: FssaiHandlerInput; actor: FssaiHandlerActor; outletId: string },
): Refusal | { handler: FssaiFoodHandler; warnings: string[]; changed: string[] } {
  const before = db.prepare(`SELECT * FROM fssai_food_handlers WHERE id = ?`).get(s(p.id)) as any;
  if (!before) return { error: 'That person is not on the register.', status: 404 };
  if (s(before.status) === 'void') return { error: 'That row was voided. A voided record is never edited.', status: 409 };
  const r = resolveHandlerFields(db, s(before.outlet_id), p.body, before);
  if ('error' in r) return r;
  const changed = EDITABLE.filter((k) => s(before[k]) !== s(r.cols[k]));
  if (!changed.length) return { handler: readFssaiFoodHandler(db, p.id)!, warnings: r.warnings, changed: [] };
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE fssai_food_handlers SET ${changed.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
  ).run(...changed.map((k) => r.cols[k]), now, before.id);
  fssaiAudit(db, {
    entity_table: 'fssai_food_handlers', entity_id: s(before.id), action: 'update',
    field: changed.length === 1 ? changed[0] : '',
    before: Object.fromEntries(changed.map((k) => [k, before[k]])),
    after: Object.fromEntries(changed.map((k) => [k, r.cols[k]])),
    actor: p.actor, outlet_id: p.outletId,
  });
  return { handler: readFssaiFoodHandler(db, p.id)!, warnings: r.warnings, changed: [...changed] };
}

/** Mark a person as having left (their record and certificates stay). */
export function markFssaiHandlerLeft(
  db: Database.Database,
  p: { id: string; left_on: unknown; note?: unknown; actor: FssaiHandlerActor; outletId: string; today: string },
): Refusal | { handler: FssaiFoodHandler } {
  const before = db.prepare(`SELECT * FROM fssai_food_handlers WHERE id = ?`).get(s(p.id)) as any;
  if (!before) return { error: 'That person is not on the register.', status: 404 };
  if (s(before.status) !== 'active') {
    return { error: s(before.status) === 'left' ? 'That person is already marked as left.' : 'That row was voided.', status: 409 };
  }
  const leftOn = isoOrBlank(p.left_on) ?? null;
  const date = leftOn === '' ? p.today : leftOn;
  if (!date) return { error: 'The leaving date is not a date.', status: 400 };
  if (date > p.today) return { error: 'The leaving date is in the future. Mark it on the day they leave.', status: 400 };
  if (s(before.joined_on) && date < s(before.joined_on)) return { error: `The leaving date is before they joined (${s(before.joined_on)}).`, status: 400 };
  const now = new Date().toISOString();
  const res = db.prepare(
    `UPDATE fssai_food_handlers SET status = 'left', left_on = ?, updated_at = ? WHERE id = ? AND status = 'active'`,
  ).run(date, now, before.id);
  if (res.changes !== 1) return { error: 'That person was changed by somebody else a moment ago. Reload.', status: 409 };
  fssaiAudit(db, {
    entity_table: 'fssai_food_handlers', entity_id: s(before.id), action: 'left', field: 'status',
    before: { status: 'active', left_on: s(before.left_on) }, after: { status: 'left', left_on: date },
    reason: s(p.note).slice(0, 500), actor: p.actor, outlet_id: p.outletId,
  });
  return { handler: readFssaiFoodHandler(db, p.id)! };
}

/** A person who left and came back is the SAME row reactivated, never a second one. */
export function markFssaiHandlerRejoined(
  db: Database.Database,
  p: { id: string; joined_on: unknown; note?: unknown; actor: FssaiHandlerActor; outletId: string; today: string },
): Refusal | { handler: FssaiFoodHandler } {
  const before = db.prepare(`SELECT * FROM fssai_food_handlers WHERE id = ?`).get(s(p.id)) as any;
  if (!before) return { error: 'That person is not on the register.', status: 404 };
  if (s(before.status) !== 'left') {
    return { error: s(before.status) === 'active' ? 'That person is already working here.' : 'That row was voided.', status: 409 };
  }
  const j = isoOrBlank(p.joined_on);
  if (j === null) return { error: 'The rejoining date is not a date.', status: 400 };
  const joined = j || p.today;
  if (s(before.left_on) && joined < s(before.left_on)) return { error: `They left on ${s(before.left_on)}; the rejoining date cannot be before that.`, status: 400 };
  // A second login or HR record may have been put on the register meanwhile.
  if (s(before.employee_id)) {
    const dup = findByKey(db, s(before.outlet_id), 'employee_id', s(before.employee_id), s(before.id));
    if (dup && s(dup.status) === 'active') return duplicateRefusal(dup, 'HRMS record');
  }
  const now = new Date().toISOString();
  const res = db.prepare(
    `UPDATE fssai_food_handlers SET status = 'active', left_on = '', joined_on = ?, updated_at = ? WHERE id = ? AND status = 'left'`,
  ).run(joined, now, before.id);
  if (res.changes !== 1) return { error: 'That person was changed by somebody else a moment ago. Reload.', status: 409 };
  fssaiAudit(db, {
    entity_table: 'fssai_food_handlers', entity_id: s(before.id), action: 'rejoined', field: 'status',
    before: { status: 'left', left_on: s(before.left_on), joined_on: s(before.joined_on) },
    after: { status: 'active', left_on: '', joined_on: joined },
    reason: s(p.note).slice(0, 500), actor: p.actor, outlet_id: p.outletId,
  });
  return { handler: readFssaiFoodHandler(db, p.id)! };
}

/* ------------------------------------------------------------------ *
 * 8. IMPORT — from HRMS (the key) or from the logins (the Q18 fallback)
 * ------------------------------------------------------------------ */

export interface FssaiHandlerCandidate {
  source: 'hrms' | 'users';
  /** hr_employees.id or users.id */
  id: string;
  full_name: string;
  employee_code: string;
  email: string;
  designation: string;
  department_id: string;
  department_name: string;
  status: string;
  /** a register row (with only a login) this employee would be LINKED to, not duplicated */
  will_link_to: string;
  /** a 'left' register row: rejoin it instead */
  left_row: string;
}

/** People HRMS (or the logins) know who are not on the register yet. Read only. */
export function readFssaiHandlerCandidates(db: Database.Database, source: 'hrms' | 'users'): FssaiHandlerCandidate[] {
  if (!tableExists(db, 'fssai_food_handlers')) return [];
  if (source === 'hrms') {
    if (!tableExists(db, 'hr_employees')) return [];
    const desig = tableExists(db, 'hr_designations') ? `(SELECT d.name FROM hr_designations d WHERE d.id = e.designation_id)` : `''`;
    const rows = db.prepare(
      `SELECT e.id, e.full_name, e.employee_code, e.status, e.department_id,
              ${desig} AS designation, dep.name AS department_name,
              (SELECT lower(u.email) FROM users u WHERE u.id = e.user_id) AS email
         FROM hr_employees e LEFT JOIN departments dep ON dep.id = e.department_id
        ORDER BY lower(e.full_name)`,
    ).all() as any[];
    const out: FssaiHandlerCandidate[] = [];
    for (const r of rows) {
      if (EXITED_STATUSES.has(s(r.status))) continue;
      const onReg = db.prepare(`SELECT id, status FROM fssai_food_handlers WHERE employee_id = ? AND status <> 'void' LIMIT 1`).get(s(r.id)) as any;
      if (onReg && s(onReg.status) === 'active') continue;
      const linkTo = !onReg && s(r.email)
        ? db.prepare(`SELECT id FROM fssai_food_handlers WHERE employee_id = '' AND status <> 'void' AND lower(person_email) = ? LIMIT 1`).get(s(r.email)) as any
        : null;
      out.push({
        source: 'hrms', id: s(r.id), full_name: s(r.full_name), employee_code: s(r.employee_code), email: s(r.email),
        designation: s(r.designation), department_id: s(r.department_id), department_name: s(r.department_name),
        status: s(r.status), will_link_to: s(linkTo?.id), left_row: onReg && s(onReg.status) === 'left' ? s(onReg.id) : '',
      });
    }
    return out;
  }
  const rows = db.prepare(
    `SELECT u.id, u.name, lower(u.email) AS email, u.department_id, u.position, dep.name AS department_name
       FROM users u LEFT JOIN departments dep ON dep.id = u.department_id
      WHERE u.is_active = 1 ORDER BY lower(u.name), lower(u.email)`,
  ).all() as any[];
  const out: FssaiHandlerCandidate[] = [];
  for (const r of rows) {
    const onReg = db.prepare(`SELECT id, status FROM fssai_food_handlers WHERE lower(person_email) = ? AND status <> 'void' LIMIT 1`).get(s(r.email)) as any;
    if (onReg && s(onReg.status) === 'active') continue;
    out.push({
      source: 'users', id: s(r.id), full_name: s(r.name) || s(r.email).split('@')[0], employee_code: '', email: s(r.email),
      designation: s(r.position), department_id: s(r.department_id), department_name: s(r.department_name),
      status: 'active', will_link_to: '', left_row: onReg && s(onReg.status) === 'left' ? s(onReg.id) : '',
    });
  }
  return out;
}

/**
 * Put the chosen HRMS employees (or logins) on the register. An employee whose
 * login is already on the register is LINKED to that row (Q18 → HR key), never
 * duplicated. Someone on the register as 'left' is reported, not re-created.
 */
export function importFssaiFoodHandlers(
  db: Database.Database,
  p: { source: 'hrms' | 'users'; ids: string[]; is_food_handler?: unknown; actor: FssaiHandlerActor; outletId: string },
): { created: FssaiFoodHandler[]; linked: FssaiFoodHandler[]; skipped: { id: string; name: string; why: string }[]; warnings: string[] } {
  const created: FssaiFoodHandler[] = [];
  const warnings = new Set<string>();
  const linked: FssaiFoodHandler[] = [];
  const skipped: { id: string; name: string; why: string }[] = [];
  const isFH = bool01(p.is_food_handler, 1);
  for (const raw of [...new Set(p.ids.map((x) => s(x)).filter(Boolean))].slice(0, 500)) {
    if (p.source === 'hrms') {
      const emp = readHrEmployee(db, raw);
      if (!emp) { skipped.push({ id: raw, name: '', why: 'Not in HRMS.' }); continue; }
      if (EXITED_STATUSES.has(emp.status)) { skipped.push({ id: raw, name: emp.full_name, why: `HRMS says ${emp.status}.` }); continue; }
      const onReg = findByKey(db, p.outletId, 'employee_id', emp.id);
      if (onReg) {
        skipped.push({ id: raw, name: emp.full_name, why: s(onReg.status) === 'left' ? `On the register as left (${s(onReg.handler_no)}) — use Rejoined.` : `Already on the register (${s(onReg.handler_no)}).` });
        continue;
      }
      if (emp.user_email) {
        const byLogin = db.prepare(
          `SELECT * FROM fssai_food_handlers WHERE outlet_id = ? AND employee_id = '' AND status <> 'void' AND lower(person_email) = ? LIMIT 1`,
        ).get(s(p.outletId), emp.user_email) as any;
        if (byLogin) {
          const now = new Date().toISOString();
          db.prepare(
            `UPDATE fssai_food_handlers SET employee_id = ?, employee_code = ?, updated_at = ? WHERE id = ? AND employee_id = ''`,
          ).run(emp.id, emp.employee_code, now, byLogin.id);
          fssaiAudit(db, {
            entity_table: 'fssai_food_handlers', entity_id: s(byLogin.id), action: 'link_hr', field: 'employee_id',
            before: { employee_id: '', employee_code: s(byLogin.employee_code), person_email: s(byLogin.person_email) },
            after: { employee_id: emp.id, employee_code: emp.employee_code },
            reason: 'Linked to the HRMS record that has the same login (Q18: the HR record becomes the key).',
            actor: p.actor, outlet_id: p.outletId,
          });
          linked.push(readFssaiFoodHandler(db, s(byLogin.id))!);
          continue;
        }
      }
      const out = createFssaiFoodHandler(db, {
        body: { employee_id: emp.id, is_food_handler: isFH, is_fostac_supervisor: 0 },
        source: 'hrms', actor: p.actor, outletId: p.outletId,
      });
      if ('error' in out) skipped.push({ id: raw, name: emp.full_name, why: out.error });
      else { created.push(out.handler); out.warnings.forEach((w) => warnings.add(w)); }
    } else {
      const u = db.prepare(`SELECT id, name, lower(email) AS email, department_id, position FROM users WHERE id = ? AND is_active = 1`).get(raw) as any;
      if (!u) { skipped.push({ id: raw, name: '', why: 'Not an active login.' }); continue; }
      const onReg = findByKey(db, p.outletId, 'person_email', s(u.email));
      if (onReg) {
        skipped.push({ id: raw, name: s(u.name), why: s(onReg.status) === 'left' ? `On the register as left (${s(onReg.handler_no)}) — use Rejoined.` : `Already on the register (${s(onReg.handler_no)}).` });
        continue;
      }
      const dept = s(u.department_id) && db.prepare(`SELECT id FROM departments WHERE id = ?`).get(s(u.department_id)) ? s(u.department_id) : '';
      const out = createFssaiFoodHandler(db, {
        body: {
          full_name: s(u.name) || s(u.email).split('@')[0], person_email: s(u.email),
          department_id: dept, designation: s(u.position), is_food_handler: isFH, is_fostac_supervisor: 0,
        },
        source: 'users', actor: p.actor, outletId: p.outletId,
      });
      if ('error' in out) skipped.push({ id: raw, name: s(u.name), why: out.error });
      else { created.push(out.handler); out.warnings.forEach((w) => warnings.add(w)); }
    }
  }
  // Same-name warnings matter most here: a person typed by name earlier and now
  // imported from HRMS would otherwise sit on the register twice, silently.
  return { created, linked, skipped, warnings: [...warnings] };
}

/* ------------------------------------------------------------------ *
 * 9. WHICH HRMS TRAININGS COUNT (fssai_training_links)
 * ------------------------------------------------------------------ */

export interface FssaiTrainingLink {
  id: string; hr_training_id: string; training_name: string; hr_name: string; hr_active: boolean;
  counts_as: string; counts_as_label: string; valid_months: number | null; is_active: boolean;
  note: string; created_by: string; created_at: string; updated_at: string;
  /** completions on file in HRMS for this training, by anybody */
  completions: number;
}

export function readFssaiTrainingLinks(db: Database.Database): {
  links: FssaiTrainingLink[]; hr_trainings: { id: string; name: string; is_active: boolean; linked: boolean }[];
} {
  if (!tableExists(db, 'fssai_training_links')) return { links: [], hr_trainings: [] };
  const hasT = tableExists(db, 'hr_trainings');
  const hasA = tableExists(db, 'hr_training_assignments');
  const rows = db.prepare(
    `SELECT l.*,
            ${hasT ? `(SELECT t.name FROM hr_trainings t WHERE t.id = l.hr_training_id)` : `''`} AS hr_name,
            ${hasT ? `(SELECT t.is_active FROM hr_trainings t WHERE t.id = l.hr_training_id)` : `0`} AS hr_active,
            ${hasA ? `(SELECT COUNT(*) FROM hr_training_assignments a WHERE a.training_id = l.hr_training_id AND a.status = 'completed')` : `0`} AS completions
       FROM fssai_training_links l ORDER BY l.is_active DESC, lower(l.training_name)`,
  ).all() as any[];
  const links = rows.map((r) => ({
    id: s(r.id), hr_training_id: s(r.hr_training_id), training_name: s(r.training_name), hr_name: s(r.hr_name),
    hr_active: Number(r.hr_active) === 1, counts_as: s(r.counts_as),
    counts_as_label: fssaiDocType(s(r.counts_as))?.label || s(r.counts_as),
    valid_months: r.valid_months === null || r.valid_months === undefined ? null : Number(r.valid_months),
    is_active: Number(r.is_active) === 1, note: s(r.note), created_by: s(r.created_by),
    created_at: s(r.created_at), updated_at: s(r.updated_at), completions: Number(r.completions) || 0,
  }));
  const linkedIds = new Set(links.map((l) => l.hr_training_id));
  const trainings = hasT
    ? (db.prepare(`SELECT id, name, is_active FROM hr_trainings ORDER BY is_active DESC, lower(name)`).all() as any[])
      .map((t) => ({ id: s(t.id), name: s(t.name), is_active: Number(t.is_active) === 1, linked: linkedIds.has(s(t.id)) }))
    : [];
  return { links, hr_trainings: trainings };
}

function validateLink(body: { counts_as?: unknown; valid_months?: unknown }, before: any | null):
  { error: string; status: number } | { counts_as: string; valid_months: number | null } {
  const countsAs = s(body.counts_as === undefined && before ? before.counts_as : body.counts_as) || 'food_handler_training';
  if (!(FSSAI_TRAINING_LINK_COUNTS_AS as readonly string[]).includes(countsAs)
    || fssaiDocType(countsAs)?.scope !== 'person') {
    return { error: 'An HRMS training can count as food-handler training or as a FoSTaC certificate.', status: 400 };
  }
  const vmRaw = body.valid_months === undefined && before ? before.valid_months : body.valid_months;
  let vm: number | null = null;
  if (vmRaw !== null && vmRaw !== undefined && s(vmRaw).trim() !== '') {
    vm = Math.trunc(Number(vmRaw));
    if (!Number.isFinite(vm) || vm < 1 || vm > 120) return { error: 'Validity is a number of months between 1 and 120, or blank for no expiry.', status: 400 };
  }
  return { counts_as: countsAs, valid_months: vm };
}

/** Say that an HRMS training counts as food-safety training (or FoSTaC). */
export function linkFssaiTraining(
  db: Database.Database,
  p: { hr_training_id: unknown; counts_as?: unknown; valid_months?: unknown; note?: unknown; actor: FssaiHandlerActor; outletId: string },
): Refusal | { link: FssaiTrainingLink } {
  const tid = s(p.hr_training_id).trim();
  if (!tid) return { error: 'Which HRMS training?', status: 400 };
  if (!tableExists(db, 'hr_trainings')) return { error: 'HRMS trainings are not set up in this database.', status: 409 };
  const t = db.prepare(`SELECT id, name FROM hr_trainings WHERE id = ?`).get(tid) as any;
  if (!t) return { error: 'That training is not in HRMS.', status: 400 };
  const v = validateLink(p, null);
  if ('error' in v) return v;
  // uq_fssai_trlink_training is a FULL unique on (outlet_id, hr_training_id):
  // a retired link is reactivated by update_link, never inserted twice.
  const existing = db.prepare(`SELECT id, is_active FROM fssai_training_links WHERE outlet_id = ? AND hr_training_id = ?`).get(s(p.outletId), tid) as any;
  if (existing) {
    return {
      error: Number(existing.is_active) === 1 ? 'That training already counts.' : 'That training was mapped before and switched off. Switch it back on instead.',
      status: 409, code: 'link_exists', existing_id: s(existing.id),
    };
  }
  const id = generateId();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO fssai_training_links (id, hr_training_id, training_name, counts_as, valid_months, is_active, note, created_by, outlet_id, created_at, updated_at)
     VALUES (?,?,?,?,?,1,?,?,?,?,?)`,
  ).run(id, tid, s(t.name).slice(0, 200), v.counts_as, v.valid_months, s(p.note).slice(0, 1000), s(p.actor.email), s(p.outletId), now, now);
  fssaiAudit(db, {
    entity_table: 'fssai_training_links', entity_id: id, action: 'create',
    after: { hr_training_id: tid, training_name: s(t.name), counts_as: v.counts_as, valid_months: v.valid_months },
    actor: p.actor, outlet_id: p.outletId,
  });
  return { link: readFssaiTrainingLinks(db).links.find((l) => l.id === id)! };
}

/** Change what a mapped training counts as, its validity, or switch it off/on. Audited. */
export function updateFssaiTrainingLink(
  db: Database.Database,
  p: { id: unknown; counts_as?: unknown; valid_months?: unknown; is_active?: unknown; note?: unknown; reason?: unknown; actor: FssaiHandlerActor; outletId: string },
): Refusal | { link: FssaiTrainingLink } {
  const before = db.prepare(`SELECT * FROM fssai_training_links WHERE id = ?`).get(s(p.id)) as any;
  if (!before) return { error: 'That mapping is not there.', status: 404 };
  const v = validateLink(p, before);
  if ('error' in v) return v;
  const isActive = p.is_active === undefined ? Number(before.is_active) : bool01(p.is_active, 1);
  const note = p.note === undefined ? s(before.note) : s(p.note).slice(0, 1000);
  const after = { counts_as: v.counts_as, valid_months: v.valid_months, is_active: isActive, note };
  const prev = { counts_as: s(before.counts_as), valid_months: before.valid_months === null ? null : Number(before.valid_months), is_active: Number(before.is_active), note: s(before.note) };
  if (JSON.stringify(after) === JSON.stringify(prev)) return { link: readFssaiTrainingLinks(db).links.find((l) => l.id === s(before.id))! };
  // Switching a mapping off, or shortening its validity, changes who reads as
  // trained — the reason is kept with the change.
  const reason = s(p.reason).trim();
  const narrows = (prev.is_active === 1 && isActive === 0)
    || (v.valid_months !== null && (prev.valid_months === null || v.valid_months < prev.valid_months))
    || prev.counts_as !== v.counts_as;
  if (narrows && reason.length < 4) {
    return { error: 'This changes who counts as trained. Say in words why.', status: 400 };
  }
  db.prepare(
    `UPDATE fssai_training_links SET counts_as = ?, valid_months = ?, is_active = ?, note = ?, updated_at = ? WHERE id = ?`,
  ).run(v.counts_as, v.valid_months, isActive, note, new Date().toISOString(), before.id);
  fssaiAudit(db, {
    entity_table: 'fssai_training_links', entity_id: s(before.id), action: 'update',
    before: prev, after, reason, actor: p.actor, outlet_id: p.outletId,
  });
  return { link: readFssaiTrainingLinks(db).links.find((l) => l.id === s(before.id))! };
}

/** Every person-scope doc type key, for a picker. */
export const FSSAI_PERSON_DOC_TYPES = FSSAI_DOC_TYPES.filter((t) => t.scope === 'person');
