/**
 * HRMS — SmartOffice biometric connector (Phase 8, device FINALIZED).
 *
 * SERVER ONLY. Imports the db module and the attendance engine — never import
 * from 'use client' components. Contract: docs/HRMS_DECISIONS.md §8.1/§8.5.
 *
 * THE DEVICE: SmartOffice v1.0.1 ("Biometrics and HRMS Solution") — a web app
 * + database that runs ON THE VENUE LAN; punches land in ITS database and we
 * integrate over its HTTP API (vendor PDF, v1.0.1, authoritative).
 *
 * TOPOLOGY — READ BEFORE DEBUGGING "Failed to fetch"/ECONNREFUSED:
 * SmartOffice lives on the venue LAN; the production app lives on AWS.
 * Server-side calls from here only work when the venue exposes SmartOffice to
 * the app (port-forward / VPN / public IP). That exposure is DATA — the
 * settings keys below — never hardcoded. The CSV import provider remains the
 * guaranteed offline path when the link is down.
 *
 * THE API SHAPE (every quirk here is from the vendor PDF):
 *  · every parameter rides the QUERY STRING (even on POST endpoints);
 *  · auth is APIKey in the query;
 *  · responses are often BARE JSON strings ("Device Added Successfully."),
 *    sometimes {status:false,message:"Invalid API Key."}, sometimes
 *    {status,message,records,result}. soFetch parses tolerantly: try JSON,
 *    treat a bare string as the message, treat status===false or a message
 *    matching /not correct|Invalid API Key|not exist/i as failure;
 *  · GetDeviceLogs timestamps are DEVICE-LOCAL IST WALL TIME — the engine
 *    stores UTC, so every LogDate goes through istToUtc() (−330 min);
 *  · PhotoUploadInBiometric accepts a JSON body (used here — a base64 image
 *    in a query string would blow URL limits); Base64String is RAW base64,
 *    no data: prefix.
 *
 * Settings keys (shared settings KV — benign scalars per §2.7; hr_ prefix is
 * owned by /api/hr/settings routing, and hr_smartoffice_api_key contains
 * 'api_key' so SECRET_KEY_RE auto-masks it on every admin surface):
 *  · hr_smartoffice_base_url   e.g. http://203.0.113.7:8080 (venue-exposed)
 *  · hr_smartoffice_api_key    the SmartOffice APIKey
 *  · hr_smartoffice_serials    comma-separated device serial numbers
 *  · hr_smartoffice_last_sync  cursor: 'YYYY-MM-DD' of the last fully-synced
 *    IST day (advanced only after a successful fetch)
 *
 * All punches funnel through recordAttendanceEvent() — THE only punch write
 * path (hr-attendance.ts). This module never inserts into
 * hr_attendance_events directly.
 */

import type Database from 'better-sqlite3';
import { recordAttendanceEvent } from './hr-attendance';

/* ------------------------------------------------------------------ *
 * Config (settings KV readers — never throw, '' defaults)
 * ------------------------------------------------------------------ */

export interface SmartOfficeConfig {
  /** Normalised: trimmed, trailing slashes stripped. '' = not configured. */
  baseUrl: string;
  apiKey: string;
  /** Parsed from hr_smartoffice_serials (comma-separated, trimmed, non-empty). */
  serials: string[];
  /** 'YYYY-MM-DD' of the last fully-synced IST day, '' when never synced. */
  lastSync: string;
}

/** One settings value or '' — a config read must never take a caller down. */
function readSetting(db: Database.Database, key: string): string {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return String(row?.value ?? '').trim();
  } catch {
    return '';
  }
}

/** SmartOffice connection config from the settings KV. Never throws. */
export function getSmartOfficeConfig(db: Database.Database): SmartOfficeConfig {
  return {
    baseUrl: readSetting(db, 'hr_smartoffice_base_url').replace(/\/+$/, ''),
    apiKey: readSetting(db, 'hr_smartoffice_api_key'),
    serials: readSetting(db, 'hr_smartoffice_serials')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    lastSync: readSetting(db, 'hr_smartoffice_last_sync'),
  };
}

/** True when both the base URL and API key are set — the minimum for any call. */
export function isSmartOfficeConfigured(db: Database.Database): boolean {
  const cfg = getSmartOfficeConfig(db);
  return cfg.baseUrl !== '' && cfg.apiKey !== '';
}

/* ------------------------------------------------------------------ *
 * soFetch — the one tolerant HTTP door to SmartOffice
 * ------------------------------------------------------------------ */

export interface SoResult<T = unknown> {
  ok: boolean;
  /** Human-readable outcome — the vendor's message when it sent one. */
  message: string;
  /** The parsed response body (array / object / string), when parseable. */
  data?: T;
}

/** Vendor failure phrasings observed in the v1.0.1 PDF's sample responses. */
const SO_FAILURE_RE = /not correct|Invalid API Key|not exist/i;

const SO_TIMEOUT_MS = 15_000;

/** Pull the human message out of any of the vendor's response shapes. */
function soMessageOf(parsed: unknown): string {
  if (typeof parsed === 'string') return parsed.trim();
  if (parsed && typeof parsed === 'object') {
    const msg = (parsed as { message?: unknown }).message;
    if (typeof msg === 'string') return msg.trim();
  }
  return '';
}

/**
 * Call one SmartOffice endpoint. Builds the query string (URLSearchParams —
 * every param rides the query, even on POST), 15s AbortController timeout,
 * parses tolerantly per the header notes. NEVER throws on HTTP, network or
 * parse problems — a refused connection comes back as ok:false with a message
 * naming the base URL, because the usual cause is topology (SmartOffice is on
 * the venue LAN and the AWS app can only reach it through the venue's
 * port-forward / VPN / public IP; see the file header).
 */
export async function soFetch(
  cfg: SmartOfficeConfig,
  path: string,
  params: Record<string, string>,
  opts: { method?: 'GET' | 'POST'; jsonBody?: Record<string, unknown> } = {},
): Promise<SoResult> {
  if (!cfg.baseUrl || !cfg.apiKey) {
    return { ok: false, message: 'SmartOffice is not configured (base URL / API key missing)' };
  }

  const qs = new URLSearchParams({ APIKey: cfg.apiKey, ...params });
  const url = `${cfg.baseUrl}/${path.replace(/^\/+/, '')}?${qs.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SO_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      signal: controller.signal,
      ...(opts.jsonBody !== undefined
        ? {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(opts.jsonBody),
          }
        : {}),
    });
  } catch (e: unknown) {
    const aborted = (e as { name?: string })?.name === 'AbortError';
    return {
      ok: false,
      message: aborted
        ? `SmartOffice at ${cfg.baseUrl} did not answer within ${SO_TIMEOUT_MS / 1000}s — the device server may be unreachable from this app (it lives on the venue LAN; check the port-forward/VPN)`
        : `Could not reach SmartOffice at ${cfg.baseUrl} — it runs on the venue LAN and must be exposed to this app (port-forward / VPN / public IP); the CSV import remains the offline path`,
    };
  } finally {
    clearTimeout(timer);
  }

  let text = '';
  try {
    text = await res.text();
  } catch {
    return { ok: false, message: `SmartOffice at ${cfg.baseUrl} sent an unreadable response` };
  }

  // Tolerant parse: try JSON; a non-JSON body is treated as a bare message.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text.trim();
  }

  const message = soMessageOf(parsed) || (res.ok ? 'OK' : '');

  if (!res.ok) {
    return {
      ok: false,
      message: message || `SmartOffice at ${cfg.baseUrl} returned HTTP ${res.status}`,
      data: parsed,
    };
  }
  const statusFalse =
    !!parsed && typeof parsed === 'object' && (parsed as { status?: unknown }).status === false;
  if (statusFalse || SO_FAILURE_RE.test(message)) {
    return { ok: false, message: message || 'SmartOffice reported a failure', data: parsed };
  }
  return { ok: true, message, data: parsed };
}

/* ------------------------------------------------------------------ *
 * Typed endpoint wrappers (thin — soFetch owns all the tolerance)
 * ------------------------------------------------------------------ */

/** POST AddBiometric — register a device with the SmartOffice server. */
export function soAddDevice(
  cfg: SmartOfficeConfig,
  deviceName: string,
  serialNumber: string,
): Promise<SoResult> {
  return soFetch(
    cfg,
    'api/v2/WebAPI/AddBiometric',
    { DeviceName: deviceName, SerialNumber: serialNumber },
    { method: 'POST' },
  );
}

/** GET DeleteBiometric — remove a device from the SmartOffice server. */
export function soDeleteDevice(cfg: SmartOfficeConfig, serialNumber: string): Promise<SoResult> {
  return soFetch(cfg, 'api/v2/WebAPI/DeleteBiometric', { SerialNumber: serialNumber });
}

/** One punch as SmartOffice reports it, normalised for the sync pass. */
export interface SoPunchRow {
  /** The id the DEVICE knows — resolves via hr_biometric_map. */
  employeeCode: string;
  /** DEVICE-LOCAL IST wall time 'YYYY-MM-DD HH:MM:SS' — NOT UTC. */
  logDateIst: string;
  serialNumber: string;
  /** '' when the device did not report a direction (pairing alternates). */
  direction: '' | 'in' | 'out';
}

/**
 * GET GetDeviceLogs — every punch across all registered devices for the date
 * range (FromDate/ToDate 'YYYY-MM-DD', inclusive, device-local IST days).
 * Rows are normalised; anything without an EmployeeCode or LogDate is
 * dropped from `rows` (there is nothing to file it under).
 */
export async function soGetDeviceLogs(
  cfg: SmartOfficeConfig,
  from: string,
  to: string,
): Promise<SoResult & { rows: SoPunchRow[] }> {
  const res = await soFetch(cfg, 'api/v2/WebAPI/GetDeviceLogs', { FromDate: from, ToDate: to });
  const rows: SoPunchRow[] = [];
  if (res.ok && Array.isArray(res.data)) {
    for (const raw of res.data as Record<string, unknown>[]) {
      const employeeCode = String(raw?.EmployeeCode ?? '').trim();
      const logDateIst = String(raw?.LogDate ?? '').trim();
      if (!employeeCode || !logDateIst) continue;
      const dirRaw = String(raw?.PunchDirection ?? '').trim().toLowerCase();
      rows.push({
        employeeCode,
        logDateIst,
        serialNumber: String(raw?.SerialNumber ?? '').trim(),
        direction: dirRaw === 'in' ? 'in' : dirRaw === 'out' ? 'out' : '',
      });
    }
  }
  return { ...res, rows };
}

/** POST UploadUser — push one user to device(s). SerialNumbers is comma-joined. */
export function soUploadUser(
  cfg: SmartOfficeConfig,
  input: { employeeName: string; employeeCode: string; cardNumber?: string; serialNumbers: string[] },
): Promise<SoResult> {
  return soFetch(
    cfg,
    'api/v2/WebAPI/UploadUser',
    {
      EmployeeName: input.employeeName,
      EmployeeCode: input.employeeCode,
      CardNumber: input.cardNumber ?? '',
      SerialNumbers: input.serialNumbers.join(','),
    },
    { method: 'POST' },
  );
}

/** POST DeleteUser — remove one user from device(s). */
export function soDeleteUser(
  cfg: SmartOfficeConfig,
  employeeCode: string,
  serialNumbers: string[],
): Promise<SoResult> {
  return soFetch(
    cfg,
    'api/v2/WebAPI/DeleteUser',
    { EmployeeCode: employeeCode, SerialNumbers: serialNumbers.join(',') },
    { method: 'POST' },
  );
}

/** One enrolled user as a device reports it. */
export interface SoLiveUser {
  employeeCode: string;
  fpCount: number;
  privilege: string;
}

/** GET FetchLiveUsersFromBiometric — who is enrolled on ONE device right now. */
export async function soFetchLiveUsers(
  cfg: SmartOfficeConfig,
  serialNumber: string,
): Promise<SoResult & { users: SoLiveUser[] }> {
  const res = await soFetch(cfg, 'api/v2/WebAPI/FetchLiveUsersFromBiometric', {
    SerialNumber: serialNumber,
  });
  const users: SoLiveUser[] = [];
  if (res.ok && Array.isArray(res.data)) {
    for (const raw of res.data as Record<string, unknown>[]) {
      const employeeCode = String(raw?.EmployeeCode ?? '').trim();
      if (!employeeCode) continue;
      users.push({
        employeeCode,
        fpCount: Number(raw?.FPCount ?? 0) || 0,
        privilege: String(raw?.Privilege ?? '').trim(),
      });
    }
  }
  return { ...res, users };
}

/**
 * GET SetUserExpiration — expire a user's device access on a date
 * ('yyyy-MM-dd'). SerialNumber '0' targets ALL devices (vendor convention).
 */
export function soSetUserExpiration(
  cfg: SmartOfficeConfig,
  serialNumber: string,
  employeeCode: string,
  expirationDate: string,
): Promise<SoResult> {
  return soFetch(cfg, 'api/v2/WebAPI/SetUserExpiration', {
    SerialNumber: serialNumber,
    EmployeeCode: employeeCode,
    ExpirationDate: expirationDate,
  });
}

/** One queued/executed device command as the server reports it. */
export interface SoDeviceCommand {
  title: string;
  deviceCode: string;
  serialNumber: string;
  creationDate: string;
  executionDate: string;
  status: string;
  response: string;
}

/** GET GetDeviceCommands — the command queue/history for a date range. */
export async function soGetDeviceCommands(
  cfg: SmartOfficeConfig,
  from: string,
  to: string,
): Promise<SoResult & { commands: SoDeviceCommand[] }> {
  const res = await soFetch(cfg, 'api/v2/WebAPI/GetDeviceCommands', {
    FromDate: from,
    ToDate: to,
  });
  const commands: SoDeviceCommand[] = [];
  const records =
    res.ok && res.data && typeof res.data === 'object'
      ? (res.data as { records?: unknown }).records
      : undefined;
  if (Array.isArray(records)) {
    for (const raw of records as Record<string, unknown>[]) {
      commands.push({
        title: String(raw?.Title ?? '').trim(),
        deviceCode: String(raw?.DeviceCode ?? '').trim(),
        serialNumber: String(raw?.SerialNumber ?? '').trim(),
        creationDate: String(raw?.CreationDate ?? '').trim(),
        executionDate: String(raw?.ExecutionDate ?? '').trim(),
        status: String(raw?.Status ?? '').trim(),
        response: String(raw?.Response ?? '').trim(),
      });
    }
  }
  return { ...res, commands };
}

/**
 * POST PhotoUploadInBiometric — push a face photo to a device. Sent as a JSON
 * body (the PDF allows body OR query; a base64 image in a query string would
 * blow URL limits). Base64String must be RAW base64 — a data: URI prefix
 * (e.g. from the ImageUpload component) is stripped here.
 */
export function soPhotoUpload(
  cfg: SmartOfficeConfig,
  input: { serialNumber: string; employeeName: string; employeeCode: string; base64: string },
): Promise<SoResult> {
  const base64 = input.base64.replace(/^data:[^,]*,/, '');
  return soFetch(
    cfg,
    'api/v2/WebAPI/PhotoUploadInBiometric',
    {},
    {
      method: 'POST',
      jsonBody: {
        APIKey: cfg.apiKey,
        SerialNumber: input.serialNumber,
        EmployeeName: input.employeeName,
        EmployeeCode: input.employeeCode,
        Base64String: base64,
      },
    },
  );
}

/**
 * GET BlockUserinBiometric — block or unblock a user on a device.
 *
 * *** DO NOT "FIX" THE 0/1 ENCODING. Vendor PDF v1.0.1, verbatim:
 * "BlockUser (int): 0 - to block the user, 1 - to unblock the user."
 * Yes, it is inverted from what you expect: 0 BLOCKS, 1 UNBLOCKS.
 * Flipping it would block every staff member you meant to unblock and
 * lock the whole venue out of the gate. ***
 */
export function soBlockUser(
  cfg: SmartOfficeConfig,
  employeeCode: string,
  serialNumber: string,
  block: boolean,
): Promise<SoResult> {
  return soFetch(cfg, 'api/v2/WebAPI/BlockUserinBiometric', {
    EmployeeCode: employeeCode,
    SerialNumber: serialNumber,
    BlockUser: String(block ? 0 : 1), // 0 = block, 1 = unblock — per the doc quote above
  });
}

/* ------------------------------------------------------------------ *
 * IST → UTC
 * ------------------------------------------------------------------ */

/**
 * SmartOffice LogDate is DEVICE-LOCAL IST WALL TIME ('YYYY-MM-DD HH:MM[:SS]').
 * The attendance engine stores UTC ('YYYY-MM-DD HH:MM:SS', no Z — the
 * datetime('now') shape), so subtract 330 minutes. Throws on an unparseable
 * input — a punch that cannot be dated must not be filed under a guessed time
 * (the sync pass catches per row and reports it as refused).
 */
export function istToUtc(logDateIst: string): string {
  const s = String(logDateIst ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) throw new Error('Invalid SmartOffice punch time');
  const ms =
    Date.UTC(
      parseInt(m[1], 10),
      parseInt(m[2], 10) - 1,
      parseInt(m[3], 10),
      parseInt(m[4], 10),
      parseInt(m[5], 10),
      m[6] ? parseInt(m[6], 10) : 0,
    ) -
    330 * 60_000; // IST = UTC + 5:30 ⇒ UTC = IST − 330 min
  if (!Number.isFinite(ms)) throw new Error('Invalid SmartOffice punch time');
  const d = new Date(ms);
  const pad2 = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
  );
}

/* ------------------------------------------------------------------ *
 * syncSmartOfficePunches — pull a date range into the attendance engine
 * ------------------------------------------------------------------ */

export interface SmartOfficeSyncResult {
  /** False only when the FETCH failed (config/network/API key) — per-row
   *  refusals do not fail the sync. */
  ok: boolean;
  /** The fetch failure message when ok=false; '' on success. */
  message: string;
  /** Punch rows SmartOffice returned for the range. */
  fetched: number;
  /** Rows written as live events (recomputed into day summaries). */
  recorded: number;
  /** Rows the engine debounced (inserted append-only with ignored=1). */
  ignored_duplicates: number;
  /** Rows the engine refused (suspended/exited employee, unparseable time). */
  refused: { code: string; reason: string }[];
  /** Device EmployeeCodes with no active hr_biometric_map row — reported,
   *  never silently dropped. */
  unmatched: { employeeCode: string; punches: number }[];
}

/**
 * Pull SmartOffice punches for [from, to] (inclusive 'YYYY-MM-DD' IST days)
 * and feed them through recordAttendanceEvent().
 *
 * Shape: ALL awaits happen first (the soGetDeviceLogs fetch), then ONE
 * SYNCHRONOUS db.transaction() wraps the whole batch — better-sqlite3 is
 * synchronous and an await inside the callback would silently break
 * atomicity (the house rule).
 *
 * Per row: resolve hr_biometric_map (is_active=1, biometric_employee_id =
 * EmployeeCode, device_id = SerialNumber or the '' any-device wildcard; an
 * exact device match wins over the wildcard) → recordAttendanceEvent with
 * source 'biometric'. The engine throws for suspended/exited employees —
 * caught PER ROW and counted as refused with the reason; the batch is never
 * aborted. Debounced duplicates come back as ignored events and are counted.
 * Unmatched EmployeeCodes are tallied with their punch counts.
 *
 * RE-RUNNING A RANGE IS SAFE: the engine is append-only and its debounce
 * marks any punch within the window of an already-recorded one as ignored,
 * so a re-import of the same day records nothing new and merely bumps
 * ignored_duplicates — idempotent enough for a cursor-driven cron AND a
 * manual "sync again" button.
 *
 * hr_smartoffice_last_sync is advanced to `to` ONLY when the fetch
 * succeeded — a network failure leaves the cursor where it was so the next
 * run re-covers the gap.
 */
export async function syncSmartOfficePunches(
  db: Database.Database,
  range: { from: string; to: string },
): Promise<SmartOfficeSyncResult> {
  const empty: SmartOfficeSyncResult = {
    ok: false,
    message: '',
    fetched: 0,
    recorded: 0,
    ignored_duplicates: 0,
    refused: [],
    unmatched: [],
  };

  const from = String(range?.from ?? '').trim();
  const to = String(range?.to ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return { ...empty, message: 'Sync range must be YYYY-MM-DD dates' };
  }

  const cfg = getSmartOfficeConfig(db);
  if (!cfg.baseUrl || !cfg.apiKey) {
    return { ...empty, message: 'SmartOffice is not configured (base URL / API key missing)' };
  }

  // ── ALL awaits happen here, before the transaction.
  const fetched = await soGetDeviceLogs(cfg, from, to);
  if (!fetched.ok) return { ...empty, message: fetched.message };

  // Chronological order is LOAD-BEARING: the engine's single-gate pairing
  // alternates IN/OUT by arrival order and debounces against the latest
  // punch — device logs are not guaranteed sorted, so sort by IST wall time
  // (string compare is chronological for 'YYYY-MM-DD HH:MM:SS').
  const rows = [...fetched.rows].sort((a, b) =>
    a.logDateIst < b.logDateIst ? -1 : a.logDateIst > b.logDateIst ? 1 : 0,
  );

  // Exact device mapping beats the '' any-device wildcard.
  const mapStmt = db.prepare(
    `SELECT employee_id FROM hr_biometric_map
     WHERE is_active = 1 AND biometric_employee_id = ?
       AND (device_id = ? OR device_id = '')
     ORDER BY (device_id != '') DESC
     LIMIT 1`,
  );

  const result: SmartOfficeSyncResult = {
    ...empty,
    ok: true,
    fetched: rows.length,
    refused: [],
    unmatched: [],
  };
  const unmatchedCounts = new Map<string, number>();

  // ── ONE synchronous transaction wraps the whole batch + the cursor bump.
  const run = db.transaction(() => {
    for (const row of rows) {
      const mapped = mapStmt.get(row.employeeCode, row.serialNumber) as
        | { employee_id: string }
        | undefined;
      if (!mapped) {
        unmatchedCounts.set(row.employeeCode, (unmatchedCounts.get(row.employeeCode) ?? 0) + 1);
        continue;
      }
      try {
        const { event } = recordAttendanceEvent(db, {
          employee_id: mapped.employee_id,
          source: 'biometric',
          at: istToUtc(row.logDateIst),
          event_type:
            row.direction === 'in'
              ? 'check_in'
              : row.direction === 'out'
                ? 'check_out'
                : undefined, // no direction from the device ⇒ engine alternation (§8.2.3)
          device_info: row.serialNumber,
          created_by: '', // machine source — actor emails are for humans
        });
        if (event.ignored) result.ignored_duplicates++;
        else result.recorded++;
      } catch (e: unknown) {
        // Engine refusals (suspended/exited, bad timestamp) are per-row
        // outcomes, never batch aborts.
        result.refused.push({
          code: row.employeeCode,
          reason: e instanceof Error ? e.message : 'Punch was refused',
        });
      }
    }

    // Cursor: the fetch succeeded (we are here), so [from, to] is covered.
    db.prepare(
      `INSERT INTO settings (key, value) VALUES ('hr_smartoffice_last_sync', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(to);
  });
  run();

  result.unmatched = [...unmatchedCounts.entries()]
    .map(([employeeCode, punches]) => ({ employeeCode, punches }))
    .sort((a, b) => b.punches - a.punches);
  return result;
}
