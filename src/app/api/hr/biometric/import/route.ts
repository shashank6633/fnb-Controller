import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { canAdminHr } from '@/lib/hr';
import {
  recordAttendanceEvent,
  BLOCKED_STATUSES,
  SUSPENDED_PUNCH_MESSAGE,
} from '@/lib/hr-attendance';
import { reportServerError } from '@/lib/error-alerts';

/**
 * HR Biometric CSV import (/api/hr/biometric/import) — Phase 2 biometric
 * readiness. Contract: docs/HRMS_DECISIONS.md §8.1/§8.5 — the CSV-import
 * provider works with ANY device's export from day one; the vendor-specific
 * connector is the only piece that waits for the finalized device. Every
 * accepted punch goes through the SAME recordAttendanceEvent() chokepoint as
 * GPS/manual entry, so business-day stamping, debounce and single-gate
 * pairing all apply identically (§8.2).
 *
 * POST ?commit=0 (default — PREVIEW, no writes)
 *   Body: multipart/form-data `file`, JSON { csv }, or a raw text/csv body.
 *   Columns (header names forgiving, lower/underscore-normalised):
 *     biometric_employee_id  (aliases: biometric_id, bio_id, emp_id,
 *                             employee_id, user_id)
 *     timestamp              (aliases: datetime, date_time, punch_time, time,
 *                             at) — IST WALL TIME, 'YYYY-MM-DD HH:MM' or
 *                             'DD-MM-YYYY HH:MM' (also '/', 'T', optional
 *                             seconds, optional AM/PM)
 *     device_id              (alias: device) — optional
 *   → { commit: false, total, matched, unmatched, sample }
 *     matched   = count of rows that resolved to an employee with a valid
 *                 timestamp; sample = the first 10 of them, parsed.
 *     unmatched = EVERY row that will not be recorded, each with its 1-based
 *                 file line number and a reason — rows are never silently
 *                 dropped (no-mapping, bad timestamp, ambiguous device,
 *                 exited employee all land here).
 *
 * POST ?commit=1
 *   Same body. Records the matched rows via recordAttendanceEvent
 *   (source='import', created_by = the uploading admin) inside ONE
 *   db.transaction(). Each row is individually guarded: a row the engine
 *   refuses (e.g. status changed between preview and commit) is counted in
 *   `unmatched` with its reason and the REST of the batch still lands — one
 *   bad row can never roll back everyone else's punches. Rows are recorded in
 *   CHRONOLOGICAL order (the file may be unsorted; the single-gate
 *   alternation engine depends on punch order). Duplicate punches inside the
 *   debounce window are INSERTED with ignored=1 by the engine (append-only)
 *   and counted here.
 *   → { commit: true, matched, recorded, ignored_duplicates, unmatched }
 *
 * TIMEZONE: device exports carry IST wall time; storage is UTC
 * ('YYYY-MM-DD HH:MM:SS', the datetime('now') shape). Conversion is
 * IST − 330 minutes (IST = UTC+5:30, the src/lib/format-date.ts convention);
 * recordAttendanceEvent then stamps the IST business date (after
 * hr_day_cutoff) at write time.
 *
 * Guards: Content-Length pre-check + byte-length backstop at ~2MB (the
 * App Router buffers bodies with no default limit), and a row cap — the DB is
 * synchronous better-sqlite3 on the shared POS box, so an unbounded commit
 * loop would stall live billing.
 *
 * Gate: canAdminHr (§2.1 — the proxy does NOT protect API routes). Errors
 * return GENERIC messages only.
 */
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 2_000_000; // ~2MB, per contract
const MAX_ROWS = 25_000;          // keeps the synchronous commit loop bounded
const IST_OFFSET_MIN = 330;       // IST = UTC + 5:30

/* ------------------------------------------------------------------ *
 * Small local CSV parser (shape copied from
 * src/app/api/direct-items/_lib/csv.ts — deliberately NOT imported: that
 * _lib belongs to the Direct Items module and may evolve with it).
 * ------------------------------------------------------------------ */

type CsvRow = Record<string, string>;

interface ParsedCsv {
  headers: string[];
  rows: Array<{ /** 1-based line number in the FILE (header = 1). */ line: number; cells: CsvRow }>;
}

/** Header text → canonical key: BOM-stripped, lower-cased, spaces/dashes → underscore. */
function headerKey(h: string): string {
  return h.replace(/^﻿/, '').trim().toLowerCase().replace(/[\s-]+/g, '_');
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
      const cells: CsvRow = {};
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
 * Forgiving IST timestamp parsing → UTC storage string
 * ------------------------------------------------------------------ */

const pad2 = (n: number): string => String(n).padStart(2, '0');

const TS_RE =
  /^(\d{1,4})([-/])(\d{1,2})\2(\d{1,4})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AaPp])\.?[Mm]?\.?)?$/;

/**
 * Parse an IST wall-time string into the UTC storage shape
 * 'YYYY-MM-DD HH:MM:SS' (subtract 330 minutes — IST = UTC+5:30).
 *
 * Accepted date parts: 'YYYY-MM-DD' or 'DD-MM-YYYY' ('/' works too — the year
 * is whichever end has 4 digits; 2-digit years are REJECTED rather than
 * guessed at, this is attendance data). Time: 'HH:MM', optional ':SS',
 * optional AM/PM, ' ' or 'T' separator. Returns null when unparseable or the
 * calendar disagrees (Feb 31 etc.).
 */
function istToUtcString(raw: string): string | null {
  const m = TS_RE.exec(String(raw ?? '').trim());
  if (!m) return null;

  const a = m[1];
  const b = m[3];
  const c = m[4];
  let y: number, mo: number, d: number;
  if (a.length === 4) {
    // YYYY-MM-DD
    y = parseInt(a, 10); mo = parseInt(b, 10); d = parseInt(c, 10);
  } else if (c.length === 4) {
    // DD-MM-YYYY
    y = parseInt(c, 10); mo = parseInt(b, 10); d = parseInt(a, 10);
  } else {
    return null; // 2-digit year — refuse to guess the century
  }

  let hh = parseInt(m[5], 10);
  const mi = parseInt(m[6], 10);
  const ss = m[7] ? parseInt(m[7], 10) : 0;
  const ampm = (m[8] || '').toLowerCase();
  if (ampm) {
    if (hh < 1 || hh > 12) return null;
    if (ampm === 'p' && hh !== 12) hh += 12;
    if (ampm === 'a' && hh === 12) hh = 0;
  }
  if (y < 2000 || y > 2100) return null; // a mistyped year must not file punches into 0226
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (hh < 0 || hh > 23 || mi < 0 || mi > 59 || ss < 0 || ss > 59) return null;

  // Round-trip through Date.UTC to reject impossible dates (Feb 31 rolls over).
  const istMs = Date.UTC(y, mo - 1, d, hh, mi, ss);
  const chk = new Date(istMs);
  if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d) {
    return null;
  }

  // The IST → UTC conversion the whole route exists for.
  const utc = new Date(istMs - IST_OFFSET_MIN * 60_000);
  return (
    `${utc.getUTCFullYear()}-${pad2(utc.getUTCMonth() + 1)}-${pad2(utc.getUTCDate())} ` +
    `${pad2(utc.getUTCHours())}:${pad2(utc.getUTCMinutes())}:${pad2(utc.getUTCSeconds())}`
  );
}

/* ------------------------------------------------------------------ *
 * Header aliases — device exports name these columns every which way
 * ------------------------------------------------------------------ */

const BIO_ID_KEYS = ['biometric_employee_id', 'biometric_id', 'bio_id', 'emp_id', 'employee_id', 'user_id'];
const TS_KEYS = ['timestamp', 'datetime', 'date_time', 'punch_time', 'time', 'at'];
const DEVICE_KEYS = ['device_id', 'device'];

function pickKey(headers: string[], candidates: string[]): string | null {
  for (const k of candidates) if (headers.includes(k)) return k;
  return null;
}

/* ------------------------------------------------------------------ *
 * Row classification
 * ------------------------------------------------------------------ */

// Blocked hr_employees.status values come from the ENGINE's exported
// BLOCKED_STATUSES (exited + suspended) — never re-declared here, so the
// pre-filter can't drift from the recordAttendanceEvent guard. Blocked rows
// land in `unmatched` with their reason instead of throwing mid-commit.

interface UnmatchedRow {
  line: number;
  biometric_employee_id: string;
  device_id: string;
  timestamp: string;
  reason: string;
}

interface MatchedRow {
  line: number;
  biometric_employee_id: string;
  device_id: string;
  timestamp: string;   // as it appeared in the file (IST)
  at_utc: string;      // storage shape, after the −330 min conversion
  atMs: number;        // for chronological sorting
  employee_id: string;
  employee_code: string;
  employee_name: string;
}

interface MappingRow {
  employee_id: string;
  biometric_employee_id: string;
  device_id: string;
  full_name: string | null;
  employee_code: string | null;
  status: string | null;
}

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) {
    return Response.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    // Reject oversized bodies BEFORE buffering them into memory (the App
    // Router has no default body-size limit). Content-Length is the cheap
    // pre-check; the byte-length guard below backstops chunked requests.
    const declaredLen = Number(request.headers.get('content-length') || 0);
    if (declaredLen > MAX_BODY_BYTES) {
      return Response.json(
        { error: 'File too large — keep imports under 2MB (split the export by month)' },
        { status: 413 },
      );
    }

    const commit = new URL(request.url).searchParams.get('commit') === '1';

    const csv = await readCsvBody(request);
    if (!csv.trim()) {
      return Response.json({ error: 'No CSV content received' }, { status: 400 });
    }
    if (Buffer.byteLength(csv, 'utf8') > MAX_BODY_BYTES) {
      return Response.json(
        { error: 'File too large — keep imports under 2MB (split the export by month)' },
        { status: 413 },
      );
    }

    const { headers, rows } = parseCsv(csv);
    if (rows.length === 0) {
      return Response.json({ error: 'The file has no data rows' }, { status: 400 });
    }
    if (rows.length > MAX_ROWS) {
      return Response.json(
        { error: `Too many rows (max ${MAX_ROWS.toLocaleString('en-IN')} per import) — split the file` },
        { status: 400 },
      );
    }

    const bioKey = pickKey(headers, BIO_ID_KEYS);
    const tsKey = pickKey(headers, TS_KEYS);
    const deviceKey = pickKey(headers, DEVICE_KEYS);
    if (!bioKey || !tsKey) {
      return Response.json(
        {
          error:
            'Missing required columns — the file needs a biometric_employee_id column and a timestamp column (IST, "YYYY-MM-DD HH:MM" or "DD-MM-YYYY HH:MM")',
        },
        { status: 400 },
      );
    }

    const db = getDb();

    // Active mappings, joined to their employee. LEFT JOIN: a dangling
    // employee_id must surface as an unmatched reason, not vanish.
    const mappingRows = db
      .prepare(
        `SELECT m.employee_id, m.biometric_employee_id, m.device_id,
                e.full_name, e.employee_code, e.status
         FROM hr_biometric_map m
         LEFT JOIN hr_employees e ON e.id = m.employee_id
         WHERE m.is_active = 1`,
      )
      .all() as MappingRow[];

    // Exact (bio id, device) lookup + all mappings per bio id for fallbacks.
    const exact = new Map<string, MappingRow>();
    const byBio = new Map<string, MappingRow[]>();
    for (const m of mappingRows) {
      exact.set(`${m.biometric_employee_id}\u0000${m.device_id}`, m);
      const list = byBio.get(m.biometric_employee_id) ?? [];
      list.push(m);
      byBio.set(m.biometric_employee_id, list);
    }

    /**
     * Resolve a CSV row to its mapping, forgivingly:
     *  1. exact (bio id, device) match;
     *  2. the '' wildcard mapping ("any device");
     *  3. if every active mapping for that bio id points at ONE employee,
     *     use it (identity is unambiguous even though the device differs);
     *  4. otherwise ambiguous/unknown → unmatched with a reason.
     */
    const resolveMapping = (bio: string, device: string): { m?: MappingRow; reason?: string } => {
      const hit = exact.get(`${bio}\u0000${device}`) ?? exact.get(`${bio}\u0000`);
      if (hit) return { m: hit };
      const all = byBio.get(bio) ?? [];
      if (all.length === 0) return { reason: 'No active mapping for this biometric id' };
      const employees = new Set(all.map((m) => m.employee_id));
      if (employees.size === 1) return { m: all[0] };
      return { reason: 'Ambiguous: this biometric id maps to different employees on different devices' };
    };

    const matched: MatchedRow[] = [];
    const unmatched: UnmatchedRow[] = [];

    for (const row of rows) {
      const bio = row.cells[bioKey] ?? '';
      const ts = row.cells[tsKey] ?? '';
      const device = deviceKey ? row.cells[deviceKey] ?? '' : '';
      const fail = (reason: string) =>
        unmatched.push({ line: row.line, biometric_employee_id: bio, device_id: device, timestamp: ts, reason });

      if (!bio) { fail('Missing biometric_employee_id'); continue; }

      const atUtc = istToUtcString(ts);
      if (!atUtc) {
        fail('Unrecognised timestamp — expected IST "YYYY-MM-DD HH:MM" or "DD-MM-YYYY HH:MM"');
        continue;
      }

      const { m, reason } = resolveMapping(bio, device);
      if (!m) { fail(reason || 'No active mapping for this biometric id'); continue; }
      if (!m.full_name && !m.employee_code) { fail('Mapped employee no longer exists'); continue; }
      const empStatus = String(m.status ?? '').trim();
      if (BLOCKED_STATUSES.has(empStatus)) {
        fail(
          empStatus === 'suspended'
            ? SUSPENDED_PUNCH_MESSAGE
            : 'Employee has exited — attendance cannot be recorded',
        );
        continue;
      }

      matched.push({
        line: row.line,
        biometric_employee_id: bio,
        device_id: device,
        timestamp: ts,
        at_utc: atUtc,
        atMs: new Date(atUtc.replace(' ', 'T') + 'Z').getTime(),
        employee_id: m.employee_id,
        employee_code: m.employee_code ?? '',
        employee_name: m.full_name ?? '',
      });
    }

    // CHRONOLOGICAL order (stable sort keeps file order on ties): the
    // single-gate alternation engine infers IN/OUT from the punch sequence, so
    // an unsorted export recorded as-is would pair the day backwards.
    matched.sort((a, b) => a.atMs - b.atMs);

    if (!commit) {
      return Response.json({
        commit: false,
        total: rows.length,
        matched: matched.length,
        unmatched,
        sample: matched.slice(0, 10).map(({ atMs: _atMs, ...rest }) => rest),
      });
    }

    // ── COMMIT: every insert in ONE transaction, but each ROW is guarded —
    // one refused row (engine guard, race with a status change) joins
    // `unmatched` with its reason instead of rolling the whole batch back.
    // recordAttendanceEvent is synchronous (better-sqlite3) and every await
    // above has resolved.
    let recorded = 0;
    let ignoredDuplicates = 0;
    const batchId = generateId();

    // Only the engine's documented caller-safe messages may reach the wire as
    // a row reason (same rule as /api/hr/attendance); anything else stays a
    // generic per-row refusal so e.message can't leak schema detail.
    const rowRefusalReason = (e: unknown): string => {
      const msg = e instanceof Error ? e.message : '';
      const callerSafe = new Set([
        'Employee is required',
        'Employee not found',
        'Employee has exited — attendance cannot be recorded',
        SUSPENDED_PUNCH_MESSAGE,
        'Invalid attendance source',
        'Invalid punch timestamp',
        'Invalid event type',
      ]);
      return callerSafe.has(msg) ? msg : 'Could not record this punch — row skipped';
    };

    const run = db.transaction(() => {
      for (const row of matched) {
        try {
          const { event } = recordAttendanceEvent(db, {
            employee_id: row.employee_id,
            source: 'import',
            at: row.at_utc,
            // No event_type: the device export carries no direction — the
            // engine's single-gate alternation assigns IN/OUT (§8.2.3).
            device_info: row.device_id ? `csv-import device:${row.device_id}` : 'csv-import',
            reason: '',
            created_by: me.email, // the uploading admin is the human actor
          });
          if (event.ignored) ignoredDuplicates++;
          else recorded++;
        } catch (rowErr) {
          console.error('biometric import: row refused', row.line, rowErr);
          unmatched.push({
            line: row.line,
            biometric_employee_id: row.biometric_employee_id,
            device_id: row.device_id,
            timestamp: row.timestamp,
            reason: rowRefusalReason(rowErr),
          });
        }
      }

      // ONE batch-level audit row — per-punch rows are NOT audited (the
      // append-only event table is its own log, per contract §4).
      logAuditEvent(db, {
        event_type: 'hr.attendance.import',
        entity_type: 'hr_biometric_import',
        entity_id: batchId,
        actor_email: me.email,
        after: {
          rows: rows.length,
          recorded,
          ignored_duplicates: ignoredDuplicates,
          unmatched: unmatched.length,
        },
      });
    });
    run();

    return Response.json({
      commit: true,
      matched: matched.length,
      recorded,
      ignored_duplicates: ignoredDuplicates,
      unmatched,
    });
  } catch (e) {
    console.error('POST /api/hr/biometric/import failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to import attendance punches' }, { status: 500 });
  }
}
