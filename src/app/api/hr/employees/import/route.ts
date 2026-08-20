import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { canManageHr, isHrEmploymentType } from '@/lib/hr';
import { nextEmployeeCode } from '@/lib/hr-server';
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
 *       warnings: [{line?, message}], sample: first 10 normalised rows }
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
 *       codes: [{line, employee_code, full_name}] }
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

/**
 * Read the CSV text out of the request, whichever way the client sent it:
 * multipart `file`, a JSON `{ csv }` body, or a raw text/csv body.
 */
async function readCsvBody(req: Request): Promise<string> {
  const ct = req.headers.get('content-type') || '';
  if (ct.includes('multipart/form-data')) {
    const fd = await req.formData();
    const file = fd.get('file');
    if (!file || !(file instanceof Blob)) return '';
    return await file.text();
  }
  if (ct.includes('application/json')) {
    const body = await req.json().catch(() => ({}));
    return String((body as Record<string, unknown>)?.csv || '');
  }
  return await req.text();
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

    const commit = new URL(request.url).searchParams.get('commit') === '1';

    const csv = await readCsvBody(request);
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
      let department_id = '';
      let department_name = '';
      const deptRaw = cell('department');
      if (deptRaw) {
        const hit = deptByName.get(deptRaw) as { id: string; name: string } | undefined;
        if (!hit) {
          rowErrors.push(`Department "${deptRaw}" was not found - create it on the Departments page (/departments) first`);
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
          rowErrors.push(`Sub-department "${subRaw}" was not found - create it on the Departments page (/departments) first`);
        } else {
          sub_department_id = hit.id;
          sub_department_name = hit.name;
        }
      }
      let designation_id = '';
      let designation_name = '';
      const desigRaw = cell('designation');
      if (desigRaw) {
        const hit = desigByName.get(desigRaw) as { id: string; name: string } | undefined;
        if (!hit) {
          rowErrors.push(`Designation "${desigRaw}" was not found - create it on the HR Settings page (/hr/settings) first`);
        } else {
          designation_id = hit.id;
          designation_name = hit.name;
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

    if (!commit) {
      return Response.json({
        ok: true,
        total_rows: rows.length,
        valid: valid.length,
        errors,
        warnings,
        sample: valid.slice(0, 10),
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

    let imported = 0;
    // Rows a validation error excluded are reported as skipped; a rare
    // insert-time refusal (e.g. a code race) joins them without rolling the
    // rest of the batch back — one bad row never undoes everyone else.
    const skipped: RowIssue[] = errors.map(e => ({ line: e.line, message: e.message }));
    const codes: Array<{ line: number; employee_code: string; full_name: string }> = [];
    const batchId = generateId();

    const run = db.transaction(() => {
      for (const row of valid) {
        // Sequential mint INSIDE the txn: nextEmployeeCode reads
        // MAX(employee_code), so each insert advances the next mint.
        const employee_code = row.employee_code || nextEmployeeCode(db);
        try {
          insert.run(
            generateId(), employee_code, row.full_name, /* photo */ '',
            row.dob, row.gender, row.phone10, row.alt_phone10, row.email,
            row.current_address, row.permanent_address, row.emergency_name,
            row.emergency_relation, row.emergency_phone10, row.department_id,
            row.sub_department_id, row.designation_id, row.grade,
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
        after: { imported, skipped: skipped.length, total_rows: rows.length },
      });
    });
    run();

    return Response.json({ ok: true, imported, skipped, codes });
  } catch (e) {
    console.error('POST /api/hr/employees/import failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to import employees' }, { status: 500 });
  }
}
