import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { canAdminHr, canManageHr, isHrEmploymentType } from '@/lib/hr';
import { nextEmployeeCode } from '@/lib/hr-server';
import { mainDeptOf } from '@/lib/dept-hierarchy';
import { reportServerError } from '@/lib/error-alerts';

/**
 * HR Bulk Employee CSV import (/api/hr/employees/import).
 * Contract: docs/HRMS_DECISIONS.md §1 (D1: employees ≠ logins) + §2 (every
 * /api/hr handler is its own security boundary). Validation MATCHES the
 * single-employee POST /api/hr/employees: same normPhone, same employment-type
 * vocab gate, same referenced-row rule (a non-empty reference must resolve),
 * same server-side EMP-#### minting inside the transaction.
 *
 * POST ?commit=0 (default — PREVIEW, no writes)
 *   Body: multipart/form-data `file`, JSON { csv }, or a raw text/csv body.
 *   Header row REQUIRED; header names are matched case/space/underscore-
 *   insensitively. Only full_name is required. Recognised columns:
 *     full_name*, employee_code (blank = auto EMP-####), phone, alt_phone,
 *     email, gender (male/female/other), dob, joining_date (YYYY-MM-DD or
 *     DD-MM-YYYY), department, sub_department, designation (matched BY NAME,
 *     case-insensitive), grade, employment_type (blank = permanent),
 *     employee_category, cost_centre, work_location, probation_months,
 *     notice_period_days, emergency_name, emergency_relation,
 *     emergency_phone, current_address, permanent_address, notes.
 *   Row ERRORS exclude the row from commit (each reported with its 1-based
 *   FILE line number); WARNINGS import anyway (shared phones, unknown
 *   columns). Rows are never silently dropped.
 *   → { ok, total_rows, valid, errors: [{line, message}],
 *       warnings: [{line?, message}], sample: first 10 normalised rows,
 *       unknown_designations: [{name, rows: [line], department_id,
 *                               department_name}] }
 *       department_id/department_name say WHERE each new designation would
 *       land: the MAIN department resolved from the first row that named it
 *       ('' / 'any department' when that row carried no department).
 *
 * POST ?commit=1
 *   Same body, parsed and validated ONCE (the commit inserts exactly the rows
 *   the preview called valid). ONE db.transaction; blank employee_codes are
 *   minted sequentially via nextEmployeeCode(db) INSIDE the txn (hr-server
 *   contract — the mint must not race a concurrent create); created_by =
 *   the uploading manager, status 'active', home_outlet_id = the caller's
 *   current outlet (resolved BEFORE the txn — getCurrentOutletId is async and
 *   an await inside db.transaction silently breaks better-sqlite3 atomicity).
 *   Valid rows import even when other rows errored — forgiving, per the house
 *   liquor-CSV precedent. ONE hr.employee.import audit event, not per row.
 *   → { ok, imported, skipped: [{line, message}],
 *       codes: [{line, employee_code, full_name}],
 *       created_designations: [{id, name}] }
 *
 * MISSING MASTERS — deliberately asymmetric (owner ruling 2026-08-17, after a
 * bulk upload dead-ended on the designation "Commis I"):
 *   • DESIGNATIONS may be created on the fly, but only on an explicit human
 *     confirmation — `create_designations=1` (query param, JSON body flag or
 *     multipart field). Never silent. They are HR-local: a wrong one is
 *     cosmetic and deactivatable. Without the flag an unknown designation is
 *     the same hard row error as before (only the copy changed), so a plain
 *     preview/commit behaves exactly as it did. A created designation is
 *     ATTACHED to the MAIN department of the FIRST row that named it (the
 *     row's sub_department wins over its department, and a sub-department
 *     resolves to its main via departments.parent_id) so the designation
 *     immediately behaves like one an admin had pinned on HR Settings: offered
 *     first to employees of that main department and its sub-departments. A
 *     first row with no department mints a GENERIC designation (department_id
 *     ''), which stays pickable everywhere.
 *   • DEPARTMENTS are NOT auto-creatable and keep the hard error. The
 *     department tree is shared with requisitions, closing stock, variance and
 *     dept-stock — a typo there pollutes load-bearing operational data.
 *   Whenever the flag is set the CALLER must additionally satisfy canAdminHr:
 *   POST /api/hr/designations is admin-only, so a manager may import (the
 *   import itself stays canManageHr) but may not mint masters. The gate runs
 *   BEFORE any write, and on preview too — a manager must never be shown a
 *   preview that promises rows the commit would refuse.
 *
 * Guards: Content-Length pre-check + byte-length backstop at 1MB, row cap
 * 2000 — the DB is synchronous better-sqlite3 on the shared POS box.
 * Gate: canManageHr (§2.1 — the proxy does NOT protect API routes). Errors
 * return GENERIC messages only: e.message can leak schema/PII for HR data.
 */
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 1_000_000; // 1MB, per contract
const MAX_ROWS = 2_000;           // keeps the synchronous commit loop bounded

/* ------------------------------------------------------------------ *
 * Small local CSV parser (shape copied from
 * src/app/api/direct-items/_lib/csv.ts — deliberately NOT imported: that
 * _lib belongs to the Direct Items module and may evolve with it).
 * ------------------------------------------------------------------ */

type CsvCells = Record<string, string>;

interface ParsedCsv {
  headers: string[];
  rows: Array<{ /** 1-based line number in the FILE (header = 1). */ line: number; cells: CsvCells }>;
}

/**
 * Canonical column keys, matched case/space/underscore-insensitively: the
 * bare key (lower-cased, every space/dash/underscore stripped) → the column
 * name the contract documents. A few natural spellings are folded in so
 * "Alt Phone 10" or "Cost Center" round-trip without a warning.
 */
const CANONICAL_BY_BARE: Record<string, string> = {
  fullname: 'full_name',
  employeecode: 'employee_code',
  phone: 'phone',
  phone10: 'phone',
  altphone: 'alt_phone',
  altphone10: 'alt_phone',
  email: 'email',
  gender: 'gender',
  dob: 'dob',
  dateofbirth: 'dob',
  joiningdate: 'joining_date',
  dateofjoining: 'joining_date',
  department: 'department',
  subdepartment: 'sub_department',
  designation: 'designation',
  grade: 'grade',
  employmenttype: 'employment_type',
  employeecategory: 'employee_category',
  costcentre: 'cost_centre',
  costcenter: 'cost_centre',
  worklocation: 'work_location',
  probationmonths: 'probation_months',
  noticeperioddays: 'notice_period_days',
  emergencyname: 'emergency_name',
  emergencyrelation: 'emergency_relation',
  emergencyphone: 'emergency_phone',
  emergencyphone10: 'emergency_phone',
  currentaddress: 'current_address',
  permanentaddress: 'permanent_address',
  notes: 'notes',
};

const KNOWN_COLUMNS = new Set(Object.values(CANONICAL_BY_BARE));

/** Header text → canonical key: BOM-stripped, lower-cased, spaces/dashes →
 *  underscore, then resolved case/space/underscore-insensitively against the
 *  recognised column names (unknown headers keep their normalised spelling so
 *  the warning can name them). */
function headerKey(h: string): string {
  const base = h.replace(/^﻿/, '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const bare = base.replace(/_/g, '');
  return CANONICAL_BY_BARE[bare] ?? base;
}

/**
 * Small CSV reader: quoted fields, escaped quotes, CRLF, and a BOM. Keeps the
 * source line number for every row so an error can point the user at the line
 * they see in Excel rather than at an index they have to count out.
 */
function parseCsv(text: string): ParsedCsv {
  const records: { line: number; cells: string[] }[] = [];
  let cur: string[] = [];
  let field = '';
  let inQuote = false;
  let line = 1;
  let recStart = 1;
  const pushField = () => { cur.push(field); field = ''; };
  const pushRecord = () => { records.push({ line: recStart, cells: cur }); cur = []; recStart = line; };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuote = false;
      } else {
        if (c === '\n') line++;
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuote = true; continue; }
    if (c === ',') { pushField(); continue; }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      line++;
      if (field !== '' || cur.length > 0) { pushField(); pushRecord(); }
      else recStart = line;
      continue;
    }
    field += c;
  }
  if (field !== '' || cur.length > 0) { pushField(); pushRecord(); }

  if (records.length === 0) return { headers: [], rows: [] };
  const headers = records[0].cells.map(headerKey);
  const rows = records.slice(1)
    .filter(r => r.cells.some(c => c.trim() !== ''))
    .map(r => {
      const cells: CsvCells = {};
      headers.forEach((h, i) => { if (h) cells[h] = (r.cells[i] ?? '').trim(); });
      return { line: r.line, cells };
    });
  return { headers, rows };
}

/** Checkbox-shaped flag: '1' / 'true' / 'yes' / 'on' (and a JSON boolean
 *  true, which stringifies to 'true'). Anything else is OFF — a
 *  master-creating confirmation must never be inferred from noise. */
function truthyFlag(v: unknown): boolean {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/**
 * Read the CSV text out of the request, whichever way the client sent it:
 * multipart `file`, a JSON `{ csv }` body, or a raw text/csv body. The
 * `create_designations` confirmation rides the SAME single body read (a
 * Request body can only be consumed once) — the query param is OR-ed in by
 * the caller.
 */
async function readCsvBody(req: Request): Promise<{ csv: string; createDesignations: boolean }> {
  const ct = req.headers.get('content-type') || '';
  if (ct.includes('multipart/form-data')) {
    const fd = await req.formData();
    const createDesignations = truthyFlag(fd.get('create_designations'));
    const file = fd.get('file');
    if (!file || !(file instanceof Blob)) return { csv: '', createDesignations };
    return { csv: await file.text(), createDesignations };
  }
  if (ct.includes('application/json')) {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      csv: String(body?.csv || ''),
      createDesignations: truthyFlag(body?.create_designations),
    };
  }
  return { csv: await req.text(), createDesignations: false };
}

/* ------------------------------------------------------------------ *
 * Cell normalisers (matching POST /api/hr/employees)
 * ------------------------------------------------------------------ */

/** PhoneField contract (mirrors src/lib/mobile-input.ts and the employees
 *  route): a value starting with '+' is a non-India E.164 number stored
 *  VERBATIM; only bare digits / '91'-prefixed digits are normalised to the
 *  last 10 ('' stays ''). */
function normPhone(v: unknown): string {
  const raw = String(v ?? '').trim();
  if (raw.startsWith('+')) return raw;
  return raw.replace(/\D/g, '').slice(-10);
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

const DATE_RE = /^(\d{1,4})([-/])(\d{1,2})\2(\d{1,4})$/;

/**
 * Parse a date cell → 'YYYY-MM-DD' or null. Accepts 'YYYY-MM-DD' and
 * 'DD-MM-YYYY' ('/' works too — the year is whichever end has 4 digits;
 * 2-digit years are REJECTED rather than guessed at). The Date.UTC
 * round-trip rejects impossible dates (Feb 31 rolls over).
 */
function parseDateCell(raw: string): string | null {
  const m = DATE_RE.exec(raw);
  if (!m) return null;
  const a = m[1];
  const b = m[3];
  const c = m[4];
  let y: number, mo: number, d: number;
  if (a.length === 4) { y = parseInt(a, 10); mo = parseInt(b, 10); d = parseInt(c, 10); }
  else if (c.length === 4) { y = parseInt(c, 10); mo = parseInt(b, 10); d = parseInt(a, 10); }
  else return null; // 2-digit year — refuse to guess the century
  if (y < 1900 || y > 2100) return null; // DOBs reach back decades; typos must not
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const chk = new Date(Date.UTC(y, mo - 1, d));
  if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d) {
    return null;
  }
  return `${y}-${pad2(mo)}-${pad2(d)}`;
}

/* ------------------------------------------------------------------ *
 * Row shapes
 * ------------------------------------------------------------------ */

interface RowIssue { line: number; message: string }
interface Warning { line?: number; message: string }

/** One designation name typed in the file that no hr_designations row matches.
 *  `name` is the EXACT first spelling seen (deduped case-insensitively);
 *  `rows` are the 1-based FILE line numbers that asked for it.
 *  `department_id` / `department_name` are the MAIN department the designation
 *  would be attached to if it is created — resolved from the FIRST row that
 *  named it ('' / 'any department' when that row had no department, i.e. a
 *  GENERIC designation that stays pickable for every employee). */
interface UnknownDesignation {
  name: string;
  rows: number[];
  department_id: string;
  department_name: string;
}

/** One fully-normalised, insert-ready row (the SAME object feeds both the
 *  preview sample and the commit — parse once per request). */
interface ValidRow {
  line: number;
  employee_code: string; // '' = mint EMP-#### inside the commit txn
  full_name: string;
  phone10: string;
  alt_phone10: string;
  email: string;
  gender: string;
  dob: string;
  joining_date: string;
  department_id: string;
  department_name: string;
  sub_department_id: string;
  sub_department_name: string;
  designation_id: string;
  designation_name: string;
  /** Non-empty ONLY when create_designations was confirmed and this row's
   *  designation does not exist yet: designation_id is resolved from the row
   *  minted inside the commit transaction. '' on every other row. */
  pending_designation_name: string;
  grade: string;
  employment_type: string;
  employee_category: string;
  cost_centre: string;
  work_location: string;
  probation_months: number;
  notice_period_days: number;
  emergency_name: string;
  emergency_relation: string;
  emergency_phone10: string;
  current_address: string;
  permanent_address: string;
  notes: string;
}

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canManageHr(me)) {
    return Response.json({ error: 'Management access required' }, { status: 403 });
  }

  try {
    // Reject oversized bodies BEFORE buffering them into memory (the App
    // Router has no default body-size limit). Content-Length is the cheap
    // pre-check; the byte-length guard below backstops chunked requests.
    const declaredLen = Number(request.headers.get('content-length') || 0);
    if (declaredLen > MAX_BODY_BYTES) {
      return Response.json(
        { error: 'File too large - keep employee imports under 1MB (split the file)' },
        { status: 400 },
      );
    }

    const qs = new URL(request.url).searchParams;
    const commit = qs.get('commit') === '1';

    const { csv, createDesignations: bodyCreateDesignations } = await readCsvBody(request);
    // The confirmation may arrive as ?create_designations=1 or as a body flag.
    const createDesignations =
      truthyFlag(qs.get('create_designations')) || bodyCreateDesignations;

    // Re-gate BEFORE anything else runs: creating masters is admin-only
    // (POST /api/hr/designations is canAdminHr) even though the import itself
    // is canManageHr. Checked on preview too, so a manager is never shown a
    // preview whose commit would 403.
    if (createDesignations && !canAdminHr(me)) {
      return Response.json(
        { error: 'Only an admin can add new designations. Ask an admin, or remove those rows.' },
        { status: 403 },
      );
    }

    if (!csv.trim()) {
      return Response.json({ error: 'No CSV content received' }, { status: 400 });
    }
    if (Buffer.byteLength(csv, 'utf8') > MAX_BODY_BYTES) {
      return Response.json(
        { error: 'File too large - keep employee imports under 1MB (split the file)' },
        { status: 400 },
      );
    }

    const { headers, rows } = parseCsv(csv);
    if (!headers.includes('full_name')) {
      return Response.json(
        {
          error:
            'Missing header row - the first line must name the columns, and a full_name column is required (only full_name is mandatory)',
        },
        { status: 400 },
      );
    }
    if (rows.length === 0) {
      return Response.json({ error: 'The file has no data rows' }, { status: 400 });
    }
    if (rows.length > MAX_ROWS) {
      return Response.json(
        { error: `Too many rows (max ${MAX_ROWS.toLocaleString('en-IN')} per import) - split the file` },
        { status: 400 },
      );
    }

    const errors: RowIssue[] = [];
    const warnings: Warning[] = [];

    // Unknown columns are a warning, never fatal — the row data under them is
    // simply ignored.
    const unknown = [...new Set(headers.filter(h => h && !KNOWN_COLUMNS.has(h)))];
    if (unknown.length > 0) {
      warnings.push({
        message: `Unknown column${unknown.length > 1 ? 's' : ''} ignored: ${unknown.join(', ')}`,
      });
    }

    const db = getDb();

    // Name-matching + duplicate lookups, prepared ONCE outside the row loop.
    const deptByName = db.prepare(
      `SELECT id, name FROM departments WHERE TRIM(name) = ? COLLATE NOCASE LIMIT 1`,
    );
    const desigByName = db.prepare(
      `SELECT id, name FROM hr_designations WHERE TRIM(name) = ? COLLATE NOCASE LIMIT 1`,
    );
    const codeInDb = db.prepare(
      `SELECT id FROM hr_employees WHERE employee_code = ? COLLATE NOCASE LIMIT 1`,
    );
    const namePhoneInDb = db.prepare(
      `SELECT id FROM hr_employees WHERE TRIM(full_name) = ? COLLATE NOCASE AND phone10 = ? LIMIT 1`,
    );
    const phoneOwner = db.prepare(
      `SELECT full_name FROM hr_employees WHERE phone10 = ? AND phone10 != '' LIMIT 1`,
    );

    const seenCodes = new Set<string>(); // in-file employee_code dedupe (case-insensitive)
    const valid: ValidRow[] = [];
    // Designation names typed in the file that no hr_designations row matches,
    // keyed lower-case so "Commis I" and "commis i" are ONE entry (the first
    // spelling seen wins — it is what the confirmation prompt shows).
    const unknownDesignations = new Map<string, UnknownDesignation>();

    for (const row of rows) {
      const cells = row.cells;
      const rowErrors: string[] = [];
      const cell = (k: string): string => (cells[k] ?? '').trim();

      // full_name — the only required column.
      const full_name = cell('full_name');
      if (!full_name) rowErrors.push('Missing full_name');

      // employee_code: blank = auto-mint at commit; a provided code must be
      // new to the DB and unique within the file.
      const employee_code = cell('employee_code');
      if (employee_code) {
        const codeKey = employee_code.toUpperCase();
        if (seenCodes.has(codeKey)) {
          rowErrors.push(`Employee code "${employee_code}" appears more than once in the file`);
        } else if (codeInDb.get(employee_code)) {
          rowErrors.push(`Employee code "${employee_code}" already exists`);
        } else {
          seenCodes.add(codeKey);
        }
      }

      // Dates — accept YYYY-MM-DD and DD-MM-YYYY, normalise to YYYY-MM-DD.
      let dob = '';
      const dobRaw = cell('dob');
      if (dobRaw) {
        const parsed = parseDateCell(dobRaw);
        if (parsed === null) rowErrors.push(`Invalid dob "${dobRaw}" - use YYYY-MM-DD or DD-MM-YYYY`);
        else dob = parsed;
      }
      let joining_date = '';
      const joinRaw = cell('joining_date');
      if (joinRaw) {
        const parsed = parseDateCell(joinRaw);
        if (parsed === null) rowErrors.push(`Invalid joining_date "${joinRaw}" - use YYYY-MM-DD or DD-MM-YYYY`);
        else joining_date = parsed;
      }

      // gender — forgiving case; an unrecognised value is a warning, not an
      // error (the single-employee form stores '' the same way).
      let gender = cell('gender').toLowerCase();
      if (gender === 'm') gender = 'male';
      if (gender === 'f') gender = 'female';
      if (gender && !['male', 'female', 'other'].includes(gender)) {
        warnings.push({
          line: row.line,
          message: `Unrecognised gender "${cell('gender')}" left blank (use male/female/other)`,
        });
        gender = '';
      }

      // employment_type — the SAME vocab gate as POST /api/hr/employees.
      const etRaw = cell('employment_type');
      const employment_type = etRaw
        ? etRaw.toLowerCase().replace(/[\s-]+/g, '_')
        : 'permanent';
      if (!isHrEmploymentType(employment_type)) {
        rowErrors.push(
          `Invalid employment_type "${etRaw}" - use permanent, contract, temporary, part_time, intern or consultant`,
        );
      }

      // department / sub_department / designation — matched BY NAME.
      // DEPARTMENTS are never auto-created: the department tree is shared with
      // requisitions, closing stock, variance and dept-stock, so a typo here
      // pollutes load-bearing operational data. Hard error, always.
      let department_id = '';
      let department_name = '';
      const deptRaw = cell('department');
      if (deptRaw) {
        const hit = deptByName.get(deptRaw) as { id: string; name: string } | undefined;
        if (!hit) {
          rowErrors.push(`Department "${deptRaw}" was not found - create it on the Departments page (/departments) first. Departments are shared with store operations, so they are never created automatically.`);
        } else {
          department_id = hit.id;
          department_name = hit.name;
        }
      }
      let sub_department_id = '';
      let sub_department_name = '';
      const subRaw = cell('sub_department');
      if (subRaw) {
        const hit = deptByName.get(subRaw) as { id: string; name: string } | undefined;
        if (!hit) {
          rowErrors.push(`Sub-department "${subRaw}" was not found - create it on the Departments page (/departments) first. Departments are shared with store operations, so they are never created automatically.`);
        } else {
          sub_department_id = hit.id;
          sub_department_name = hit.name;
        }
      }
      // DESIGNATIONS are HR-local, so an unknown one is an OFFER, not a
      // dead end — but only ever on an explicit confirmation.
      let designation_id = '';
      let designation_name = '';
      let pending_designation_name = '';
      const desigRaw = cell('designation');
      if (desigRaw) {
        const hit = desigByName.get(desigRaw) as { id: string; name: string } | undefined;
        if (hit) {
          designation_id = hit.id;
          designation_name = hit.name;
        } else {
          // Collect it whatever else is wrong with the row — the prompt lists
          // every name the file asked for.
          const key = desigRaw.toLowerCase();
          const seen = unknownDesignations.get(key);
          if (seen) seen.rows.push(row.line);
          else {
            // WHERE it lands: the MAIN department of THIS (the first) row —
            // sub_department wins over department, and a sub-department walks
            // up to its main via parent_id (mainDeptOf). A row with no
            // department (or one whose department name did not resolve, which
            // is already a row error) mints a GENERIC designation: department
            // '' stays pickable for every employee.
            const rowDeptId = sub_department_id || department_id;
            const main = rowDeptId ? mainDeptOf(db, rowDeptId) : null;
            unknownDesignations.set(key, {
              name: desigRaw,
              rows: [row.line],
              department_id: main ? main.id : '',
              department_name: main ? main.name : 'any department',
            });
          }

          if (createDesignations) {
            // Confirmed by an admin: the row imports, and its designation is
            // minted inside the commit transaction (first spelling wins).
            pending_designation_name = seen ? seen.name : desigRaw;
            designation_name = pending_designation_name;
          } else {
            rowErrors.push(`Designation "${desigRaw}" does not exist yet — tick "create missing designations" below to add it, or create it on HR Settings first.`);
          }
        }
      }

      // Integer columns — Number.isFinite-guarded; garbage is a warning + 0.
      const intCell = (key: string): number => {
        const raw = cell(key);
        if (!raw) return 0;
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) {
          warnings.push({ line: row.line, message: `Invalid ${key} "${raw}" treated as 0` });
          return 0;
        }
        return Math.trunc(n);
      };
      const probation_months = intCell('probation_months');
      const notice_period_days = intCell('notice_period_days');

      // Phones — same normPhone rule as the employees route.
      const phone10 = normPhone(cell('phone'));
      const alt_phone10 = normPhone(cell('alt_phone'));
      const emergency_phone10 = normPhone(cell('emergency_phone'));

      // Double-import guard: the full_name+phone PAIR already in the DB is an
      // error; a shared phone on a DIFFERENT name is only a warning.
      if (full_name) {
        if (namePhoneInDb.get(full_name, phone10)) {
          rowErrors.push(`"${full_name}" already exists - row skipped to prevent double-import`);
        } else if (phone10) {
          const owner = phoneOwner.get(phone10) as { full_name: string } | undefined;
          if (owner) {
            warnings.push({
              line: row.line,
              message: `Phone ${phone10} is already on "${owner.full_name}" - shared phones are allowed, importing anyway`,
            });
          }
        }
      }

      if (rowErrors.length > 0) {
        for (const message of rowErrors) errors.push({ line: row.line, message });
        continue;
      }

      valid.push({
        line: row.line,
        employee_code,
        full_name,
        phone10,
        alt_phone10,
        email: cell('email'),
        gender,
        dob,
        joining_date,
        department_id,
        department_name,
        sub_department_id,
        sub_department_name,
        designation_id,
        designation_name,
        pending_designation_name,
        grade: cell('grade'),
        employment_type,
        employee_category: cell('employee_category'),
        cost_centre: cell('cost_centre'),
        work_location: cell('work_location'),
        probation_months,
        notice_period_days,
        emergency_name: cell('emergency_name'),
        emergency_relation: cell('emergency_relation'),
        emergency_phone10,
        current_address: cell('current_address'),
        permanent_address: cell('permanent_address'),
        notes: cell('notes'),
      });
    }

    // Stable order: the line the name first appeared on.
    const unknown_designations: UnknownDesignation[] = [...unknownDesignations.values()]
      .sort((a, b) => a.rows[0] - b.rows[0]);

    if (!commit) {
      return Response.json({
        ok: true,
        total_rows: rows.length,
        valid: valid.length,
        errors,
        warnings,
        sample: valid.slice(0, 10),
        unknown_designations,
      });
    }

    // ── COMMIT ──────────────────────────────────────────────────────────
    // The caller's outlet stamps every imported row. getCurrentOutletId is
    // async — resolve it BEFORE db.transaction(); an await inside the
    // callback silently breaks better-sqlite3 atomicity.
    const home_outlet_id = (await getCurrentOutletId()) || '';

    const insert = db.prepare(
      `INSERT INTO hr_employees (
         id, employee_code, full_name, photo, dob, gender, phone10, alt_phone10,
         email, current_address, permanent_address, emergency_name,
         emergency_relation, emergency_phone10, department_id, sub_department_id,
         designation_id, grade, reporting_manager_id, employment_type,
         employee_category, cost_centre, work_location, home_outlet_id,
         joining_date, probation_months, confirmation_date, notice_period_days,
         status, exit_date, user_id, notes, created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    // Confirmed-only designation mint (same shape as POST /api/hr/designations:
    // name as typed and trimmed, is_active 1, no grade). department_id is the
    // MAIN department resolved from the first row that named the designation —
    // '' when that row had none, which is the GENERIC "any department" case.
    const desigInsert = db.prepare(
      `INSERT INTO hr_designations (id, name, department_id, grade, is_active)
       VALUES (?, ?, ?, '', 1)`,
    );
    const created_designations: Array<{
      id: string;
      name: string;
      department_id: string;
      department_name: string;
    }> = [];
    const designationIdByKey = new Map<string, string>(); // lower name → id

    let imported = 0;
    // Rows a validation error excluded are reported as skipped; a rare
    // insert-time refusal (e.g. a code race) joins them without rolling the
    // rest of the batch back — one bad row never undoes everyone else.
    const skipped: RowIssue[] = errors.map(e => ({ line: e.line, message: e.message }));
    const codes: Array<{ line: number; employee_code: string; full_name: string }> = [];
    const batchId = generateId();

    const run = db.transaction(() => {
      // Masters first, in the SAME transaction as the employee inserts — a
      // rolled-back import must not leave orphan designations behind. EVERY
      // name the preview listed is created, including one whose only row also
      // failed on something else: the confirmation showed that list, and a
      // designation is deactivatable if it turns out to be a typo.
      if (createDesignations) {
        for (const [key, info] of unknownDesignations) {
          // Re-check by NOCASE name: the designation may have been created on
          // HR Settings between the preview and this commit. Never duplicate.
          const again = desigByName.get(info.name) as { id: string; name: string } | undefined;
          if (again) { designationIdByKey.set(key, again.id); continue; }
          const desigId = generateId();
          try {
            desigInsert.run(desigId, info.name, info.department_id);
            designationIdByKey.set(key, desigId);
            created_designations.push({
              id: desigId,
              name: info.name,
              department_id: info.department_id,
              department_name: info.department_name,
            });
          } catch (desigErr) {
            // A UNIQUE(name COLLATE NOCASE) refusal rolls back this statement
            // only; re-read rather than losing the whole batch.
            console.error('employee import: designation create refused', info.name, desigErr);
            const raced = desigByName.get(info.name) as { id: string } | undefined;
            if (!raced) throw desigErr;
            designationIdByKey.set(key, raced.id);
          }
        }

        // ONE audit event for the whole confirmed batch, beside (not instead
        // of) the hr.employee.import event below.
        if (created_designations.length > 0) {
          logAuditEvent(db, {
            event_type: 'hr.designation.import_create',
            entity_type: 'hr_designation',
            entity_id: batchId,
            actor_email: me.email,
            outlet_id: home_outlet_id || null,
            after: {
              created: created_designations,
              names: created_designations.map(d => d.name),
              import_batch: batchId,
            },
            note: 'Created from the employee CSV import (confirmed by the uploader)',
          });
        }
      }

      for (const row of valid) {
        // Sequential mint INSIDE the txn: nextEmployeeCode reads
        // MAX(employee_code), so each insert advances the next mint.
        const employee_code = row.employee_code || nextEmployeeCode(db);
        // A pending row takes the id of the designation just minted above.
        const designation_id = row.pending_designation_name
          ? (designationIdByKey.get(row.pending_designation_name.toLowerCase()) ?? '')
          : row.designation_id;
        try {
          insert.run(
            generateId(), employee_code, row.full_name, /* photo */ '',
            row.dob, row.gender, row.phone10, row.alt_phone10, row.email,
            row.current_address, row.permanent_address, row.emergency_name,
            row.emergency_relation, row.emergency_phone10, row.department_id,
            row.sub_department_id, designation_id, row.grade,
            /* reporting_manager_id */ '', row.employment_type,
            row.employee_category, row.cost_centre, row.work_location,
            home_outlet_id, row.joining_date, row.probation_months,
            /* confirmation_date */ '', row.notice_period_days,
            /* status */ 'active', /* exit_date */ '', /* user_id */ null,
            row.notes, me.email,
          );
          imported++;
          codes.push({ line: row.line, employee_code, full_name: row.full_name });
        } catch (rowErr) {
          console.error('employee import: row refused', row.line, rowErr);
          skipped.push({ line: row.line, message: 'Could not import this row - it was skipped' });
        }
      }

      // ONE batch-level audit event — per-row events would swamp audit_events.
      logAuditEvent(db, {
        event_type: 'hr.employee.import',
        entity_type: 'hr_employee_import',
        entity_id: batchId,
        actor_email: me.email,
        outlet_id: home_outlet_id || null,
        after: {
          imported,
          skipped: skipped.length,
          total_rows: rows.length,
          created_designations: created_designations.length,
        },
      });
    });
    run();

    return Response.json({ ok: true, imported, skipped, codes, created_designations });
  } catch (e) {
    console.error('POST /api/hr/employees/import failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to import employees' }, { status: 500 });
  }
}
