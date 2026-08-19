import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { canAdminHr } from '@/lib/hr';
import { reportServerError } from '@/lib/error-alerts';
import { todayIST } from '@/lib/format-date';
import {
  getSmartOfficeConfig,
  type SmartOfficeConfig,
  soAddDevice,
  soDeleteDevice,
  soFetchLiveUsers,
  soGetDeviceCommands,
  soUploadUser,
  soDeleteUser,
  soSetUserExpiration,
  soBlockUser,
  soPhotoUpload,
  syncSmartOfficePunches,
} from '@/lib/smartoffice';
import type Database from 'better-sqlite3';

/**
 * SmartOffice biometric connector admin (/api/hr/biometric/smartoffice) —
 * HRMS Phase 8, device FINALIZED: SmartOffice v1.0.1 ("Biometrics and HRMS
 * Solution"). Contract: docs/HRMS_DECISIONS.md §8.1/§8.5; the connector
 * itself lives in src/lib/smartoffice.ts — this route is only the admin door
 * to it.
 *
 * TOPOLOGY — before debugging "could not reach": SmartOffice is a web app +
 * DB running ON THE VENUE LAN; punches land in ITS database and we integrate
 * over its HTTP API. The production app lives on AWS, so server-side calls
 * from here only work when the venue exposes SmartOffice to the app
 * (port-forward / VPN / public IP). That exposure is DATA — the settings
 * keys below — never hardcoded. The CSV import
 * (/api/hr/biometric/import) remains the guaranteed offline path.
 *
 * Settings keys (shared settings KV; the hr_ prefix is owned by
 * /api/hr/settings routing, and hr_smartoffice_api_key contains 'api_key'
 * so SECRET_KEY_RE auto-masks it on every admin surface):
 *   · hr_smartoffice_base_url   e.g. http://203.0.113.7:8080
 *   · hr_smartoffice_api_key    the SmartOffice APIKey (never echoed back)
 *   · hr_smartoffice_serials    comma-separated device serial numbers
 *   · hr_smartoffice_last_sync  'YYYY-MM-DD' cursor of the last fully-synced
 *                               IST day (advanced by the sync itself)
 *
 * GET → { configured, base_url, serials, last_sync, api_key_set }
 *   api_key_set is a BOOLEAN — the key value itself is never returned.
 *
 * POST { action, ... } — one action per request:
 *   · save_config { base_url, api_key?, serials } — base_url must be http(s)
 *     ('' clears it); api_key is written ONLY when provided non-empty, so
 *     saving the other fields never wipes a stored key. Audited with the key
 *     MASKED ('set'/'unset').
 *   · test — soFetchLiveUsers against the first serial (or GetDeviceCommands
 *     for today when no serials are stored) → { ok, message, users? }.
 *   · sync { from?, to? } — defaults from = last_sync ∥ today−7 (IST),
 *     to = today; feeds punches through syncSmartOfficePunches (which funnels
 *     into recordAttendanceEvent — THE only punch write path) and returns the
 *     full report. Re-running a range is safe (engine debounce = idempotent).
 *   · push_user { employee_id, with_photo? } — UploadUser with the mapped
 *     biometric id; with_photo also sends PhotoUploadInBiometric when the
 *     employee has a stored photo (raw base64 — the data: prefix is stripped
 *     by the lib).
 *   · delete_user / block_user / unblock_user { employee_id } — resolve the
 *     active hr_biometric_map row, call the wrapper. NOTE the vendor's
 *     inverted BlockUser encoding (0 blocks, 1 unblocks) is owned by
 *     soBlockUser — callers pass a plain boolean; do not "fix" the lib.
 *   · set_expiration { employee_id, date } — 'YYYY-MM-DD'; serial '0'
 *     (= all devices, vendor convention) unless the mapping pins one device.
 *   · add_device { name, serial } / delete_device { serial }.
 *
 * Every action returns the DEVICE'S OWN message so the admin sees exactly
 * what SmartOffice said. Every command is audited with actor me.email.
 *
 * Gates (§2.1 — the proxy does NOT protect API routes): canAdminHr on EVERY
 * verb, GET included. Errors return GENERIC messages only. Client mutations
 * must go through api()/apiJson (CSRF on '/api/hr').
 */
export const dynamic = 'force-dynamic';

/** Trimmed string from any body value ('' for null/undefined). */
function s(v: unknown): string {
  return String(v ?? '').trim();
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** iso 'YYYY-MM-DD' minus n days (pure calendar math, no zone shift). */
function isoMinusDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** 400 when the base URL / API key are missing; null when callable. */
function notConfigured(cfg: SmartOfficeConfig): Response | null {
  if (cfg.baseUrl && cfg.apiKey) return null;
  return Response.json(
    { error: 'SmartOffice is not configured — save the base URL and API key first' },
    { status: 400 },
  );
}

interface EmpRow {
  id: string;
  full_name: string;
  employee_code: string;
  status: string;
  photo: string;
  home_outlet_id: string;
}
interface MapRow {
  biometric_employee_id: string;
  device_id: string;
}

/**
 * Resolve an employee + their active biometric mapping, with NAMED 400s.
 * When an employee has several active mappings the '' any-device wildcard
 * wins (it is the canonical identity across devices); otherwise the pinned
 * one is used and commands target that device only.
 */
function resolveTarget(
  db: Database.Database,
  employeeId: string,
): { error: Response } | { emp: EmpRow; mapping: MapRow } {
  if (!employeeId) {
    return { error: Response.json({ error: 'Employee is required' }, { status: 400 }) };
  }
  const emp = db
    .prepare(
      `SELECT id, full_name, employee_code, status, photo, home_outlet_id
       FROM hr_employees WHERE id = ?`,
    )
    .get(employeeId) as EmpRow | undefined;
  if (!emp) {
    return { error: Response.json({ error: 'Selected employee was not found' }, { status: 400 }) };
  }
  const mapping = db
    .prepare(
      `SELECT biometric_employee_id, device_id FROM hr_biometric_map
       WHERE employee_id = ? AND is_active = 1
       ORDER BY (device_id = '') DESC, created_at
       LIMIT 1`,
    )
    .get(employeeId) as MapRow | undefined;
  if (!mapping) {
    return {
      error: Response.json(
        { error: 'No active biometric mapping for this employee — map a biometric id first' },
        { status: 400 },
      ),
    };
  }
  return { emp, mapping };
}

/** Device serials a user-command targets: the pinned device wins, else all
 *  configured serials (the mapping's '' wildcard = "any device"). */
function targetSerials(mapping: MapRow, cfg: SmartOfficeConfig): string[] {
  return mapping.device_id ? [mapping.device_id] : cfg.serials;
}

/** The GET status shape (also returned after save_config). NEVER the key. */
function statusShape(cfg: SmartOfficeConfig) {
  return {
    configured: cfg.baseUrl !== '' && cfg.apiKey !== '',
    base_url: cfg.baseUrl,
    serials: cfg.serials,
    last_sync: cfg.lastSync,
    api_key_set: cfg.apiKey !== '',
  };
}

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) {
    return Response.json({ error: 'Admin access required' }, { status: 403 });
  }
  try {
    return Response.json(statusShape(getSmartOfficeConfig(getDb())));
  } catch (e) {
    console.error('GET /api/hr/biometric/smartoffice failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'Failed to load SmartOffice status' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  if (!canAdminHr(me)) {
    return Response.json({ error: 'Admin access required' }, { status: 403 });
  }

  let body: Record<string, unknown> = {};
  try { body = await request.json(); } catch { /* handled by the action switch */ }
  const action = s(body?.action);

  try {
    const db = getDb();
    const cfg = getSmartOfficeConfig(db);

    /* ---------------- save_config ---------------- */
    if (action === 'save_config') {
      const base_url = s(body?.base_url).replace(/\/+$/, '');
      if (base_url && !/^https?:\/\//i.test(base_url)) {
        return Response.json(
          { error: 'Base URL must start with http:// or https://' },
          { status: 400 },
        );
      }
      const api_key = s(body?.api_key);
      const serialsInput = Array.isArray(body?.serials)
        ? (body.serials as unknown[]).map((x) => String(x ?? '').trim()).filter(Boolean).join(',')
        : s(body?.serials);
      const serials = serialsInput.split(',').map((t) => t.trim()).filter(Boolean).join(',');

      const upsert = db.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      );
      const write = db.transaction(() => {
        upsert.run('hr_smartoffice_base_url', base_url);
        upsert.run('hr_smartoffice_serials', serials);
        // The key is written ONLY when provided non-empty — saving the other
        // fields must never wipe a stored key (the form never echoes it back).
        if (api_key) upsert.run('hr_smartoffice_api_key', api_key);

        // Audit with the key MASKED — 'set'/'unset' only, never the value.
        logAuditEvent(db, {
          event_type: 'hr.biometric.config',
          entity_type: 'hr_smartoffice_config',
          entity_id: 'smartoffice',
          actor_email: me.email,
          before: {
            base_url: cfg.baseUrl,
            serials: cfg.serials.join(','),
            api_key: cfg.apiKey ? 'set' : 'unset',
          },
          after: {
            base_url,
            serials,
            api_key: (api_key || cfg.apiKey) ? 'set' : 'unset',
          },
        });
      });
      write();

      return Response.json({
        ok: true,
        message: 'SmartOffice configuration saved',
        ...statusShape(getSmartOfficeConfig(db)),
      });
    }

    /* ---------------- test ---------------- */
    if (action === 'test') {
      const bad = notConfigured(cfg);
      if (bad) return bad;
      if (cfg.serials.length > 0) {
        const serial = cfg.serials[0];
        const r = await soFetchLiveUsers(cfg, serial);
        return Response.json({
          ok: r.ok,
          message: r.ok
            ? (r.message && r.message !== 'OK'
                ? r.message
                : `Connected — device ${serial} reports ${r.users.length} enrolled user(s)`)
            : r.message,
          users: r.ok ? r.users : undefined,
        });
      }
      // No serials stored yet — a commands read for today still proves the
      // base URL + API key work.
      const today = todayIST();
      const r = await soGetDeviceCommands(cfg, today, today);
      return Response.json({
        ok: r.ok,
        message: r.ok
          ? (r.message && r.message !== 'OK'
              ? r.message
              : 'Connected — SmartOffice answered (no device serials saved yet)')
          : r.message,
      });
    }

    /* ---------------- sync ---------------- */
    if (action === 'sync') {
      const today = todayIST();
      const to = s(body?.to) || today;
      const from = s(body?.from) || cfg.lastSync || isoMinusDays(today, 7);
      if (!ISO_DATE_RE.test(from) || !ISO_DATE_RE.test(to)) {
        return Response.json({ error: 'Sync dates must be YYYY-MM-DD' }, { status: 400 });
      }
      if (from > to) {
        return Response.json(
          { error: 'From date must be on or before the to date' },
          { status: 400 },
        );
      }

      const report = await syncSmartOfficePunches(db, { from, to });

      if (report.ok) {
        logAuditEvent(db, {
          event_type: 'hr.biometric.sync',
          entity_type: 'hr_smartoffice_sync',
          entity_id: generateId(),
          actor_email: me.email,
          after: {
            from,
            to,
            fetched: report.fetched,
            recorded: report.recorded,
            ignored_duplicates: report.ignored_duplicates,
            refused: report.refused.length,
            unmatched: report.unmatched.length,
          },
        });
      }

      return Response.json({ ...report, from, to });
    }

    /* ---------------- push_user ---------------- */
    if (action === 'push_user') {
      const bad = notConfigured(cfg);
      if (bad) return bad;
      const target = resolveTarget(db, s(body?.employee_id));
      if ('error' in target) return target.error;
      const { emp, mapping } = target;

      const serials = targetSerials(mapping, cfg);
      if (serials.length === 0) {
        return Response.json(
          { error: 'No device serials configured — save serial numbers first' },
          { status: 400 },
        );
      }

      const r = await soUploadUser(cfg, {
        employeeName: emp.full_name,
        employeeCode: mapping.biometric_employee_id,
        cardNumber: '',
        serialNumbers: serials,
      });

      // Optional face photo — one PhotoUploadInBiometric per target device.
      // soPhotoUpload strips any data: URI prefix (Base64String is RAW base64).
      const with_photo = body?.with_photo === true || body?.with_photo === 1 || body?.with_photo === '1';
      let photo: { ok: boolean; message: string } | undefined;
      if (with_photo && emp.photo) {
        const messages: string[] = [];
        let allOk = true;
        for (const serial of serials) {
          const pr = await soPhotoUpload(cfg, {
            serialNumber: serial,
            employeeName: emp.full_name,
            employeeCode: mapping.biometric_employee_id,
            base64: emp.photo,
          });
          if (!pr.ok) allOk = false;
          messages.push(`${serial}: ${pr.message}`);
        }
        photo = { ok: allOk, message: messages.join(' | ') };
      } else if (with_photo) {
        photo = { ok: false, message: 'Employee has no stored photo — nothing to upload' };
      }

      logAuditEvent(db, {
        event_type: 'hr.biometric.push_user',
        entity_type: 'hr_employee',
        entity_id: emp.id,
        actor_email: me.email,
        outlet_id: emp.home_outlet_id || null,
        after: {
          biometric_employee_id: mapping.biometric_employee_id,
          serials,
          ok: r.ok,
          message: r.message,
          with_photo,
          photo_ok: photo?.ok,
        },
      });

      return Response.json({ ok: r.ok, message: r.message, photo });
    }

    /* ---------------- delete_user ---------------- */
    if (action === 'delete_user') {
      const bad = notConfigured(cfg);
      if (bad) return bad;
      const target = resolveTarget(db, s(body?.employee_id));
      if ('error' in target) return target.error;
      const { emp, mapping } = target;

      const serials = targetSerials(mapping, cfg);
      if (serials.length === 0) {
        return Response.json(
          { error: 'No device serials configured — save serial numbers first' },
          { status: 400 },
        );
      }

      const r = await soDeleteUser(cfg, mapping.biometric_employee_id, serials);
      logAuditEvent(db, {
        event_type: 'hr.biometric.delete_user',
        entity_type: 'hr_employee',
        entity_id: emp.id,
        actor_email: me.email,
        outlet_id: emp.home_outlet_id || null,
        after: {
          biometric_employee_id: mapping.biometric_employee_id,
          serials,
          ok: r.ok,
          message: r.message,
        },
      });
      return Response.json({ ok: r.ok, message: r.message });
    }

    /* ---------------- block_user / unblock_user ---------------- */
    if (action === 'block_user' || action === 'unblock_user') {
      const bad = notConfigured(cfg);
      if (bad) return bad;
      const target = resolveTarget(db, s(body?.employee_id));
      if ('error' in target) return target.error;
      const { emp, mapping } = target;

      const block = action === 'block_user';
      // Serial '0' = all devices unless the mapping pins one. The vendor's
      // inverted 0-blocks/1-unblocks wire encoding is owned by soBlockUser
      // (see the verbatim PDF quote there) — this caller passes a boolean.
      const serial = mapping.device_id || '0';
      const r = await soBlockUser(cfg, mapping.biometric_employee_id, serial, block);

      logAuditEvent(db, {
        event_type: block ? 'hr.biometric.block' : 'hr.biometric.unblock',
        entity_type: 'hr_employee',
        entity_id: emp.id,
        actor_email: me.email,
        outlet_id: emp.home_outlet_id || null,
        after: {
          biometric_employee_id: mapping.biometric_employee_id,
          serial,
          block,
          ok: r.ok,
          message: r.message,
        },
      });
      return Response.json({ ok: r.ok, message: r.message });
    }

    /* ---------------- set_expiration ---------------- */
    if (action === 'set_expiration') {
      const bad = notConfigured(cfg);
      if (bad) return bad;
      const date = s(body?.date);
      if (!ISO_DATE_RE.test(date)) {
        return Response.json({ error: 'Expiration date must be YYYY-MM-DD' }, { status: 400 });
      }
      const target = resolveTarget(db, s(body?.employee_id));
      if ('error' in target) return target.error;
      const { emp, mapping } = target;

      // Serial '0' targets ALL devices (vendor convention) unless pinned.
      const serial = mapping.device_id || '0';
      const r = await soSetUserExpiration(cfg, serial, mapping.biometric_employee_id, date);

      logAuditEvent(db, {
        event_type: 'hr.biometric.expire',
        entity_type: 'hr_employee',
        entity_id: emp.id,
        actor_email: me.email,
        outlet_id: emp.home_outlet_id || null,
        after: {
          biometric_employee_id: mapping.biometric_employee_id,
          serial,
          date,
          ok: r.ok,
          message: r.message,
        },
      });
      return Response.json({ ok: r.ok, message: r.message });
    }

    /* ---------------- add_device / delete_device ---------------- */
    if (action === 'add_device') {
      const bad = notConfigured(cfg);
      if (bad) return bad;
      const name = s(body?.name);
      const serial = s(body?.serial);
      if (!name || !serial) {
        return Response.json(
          { error: 'Device name and serial number are required' },
          { status: 400 },
        );
      }
      const r = await soAddDevice(cfg, name, serial);
      logAuditEvent(db, {
        event_type: 'hr.biometric.device_add',
        entity_type: 'hr_smartoffice_device',
        entity_id: serial,
        actor_email: me.email,
        after: { name, serial, ok: r.ok, message: r.message },
      });
      return Response.json({ ok: r.ok, message: r.message });
    }

    if (action === 'delete_device') {
      const bad = notConfigured(cfg);
      if (bad) return bad;
      const serial = s(body?.serial);
      if (!serial) {
        return Response.json({ error: 'Device serial number is required' }, { status: 400 });
      }
      const r = await soDeleteDevice(cfg, serial);
      logAuditEvent(db, {
        event_type: 'hr.biometric.device_delete',
        entity_type: 'hr_smartoffice_device',
        entity_id: serial,
        actor_email: me.email,
        after: { serial, ok: r.ok, message: r.message },
      });
      return Response.json({ ok: r.ok, message: r.message });
    }

    return Response.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e) {
    console.error('POST /api/hr/biometric/smartoffice failed:', e);
    reportServerError(e, { url: request.url });
    return Response.json({ error: 'SmartOffice request failed' }, { status: 500 });
  }
}
