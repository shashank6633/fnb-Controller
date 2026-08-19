'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * HR — Biometric & Import (Phase 2 + Phase 8 connector, adminOnly).
 *
 * Contract: docs/HRMS_DECISIONS.md §8.1/§8.5. Three cards:
 *   1. Device identity mapping (hr_biometric_map) — SmartOffice punches (and
 *      any CSV export) resolve through this table into hr_employees rows: the
 *      biometric id here must equal the device's EmployeeCode. Add via modal
 *      (POST /api/hr/biometric), soft deactivate via DELETE. The API offers no
 *      reactivate verb, so the UI is a one-way Deactivate — re-adding mints a
 *      fresh mapping row. Active rows additionally carry SmartOffice device
 *      commands (push / block / unblock / expiry) once the connector is
 *      configured.
 *   2. SmartOffice connector (device FINALIZED: SmartOffice v1.0.1,
 *      "Biometrics and HRMS Solution").
 *      TOPOLOGY: SmartOffice is a web app + DB on the VENUE LAN; this app runs
 *      on AWS. The server-side pull only works when the venue exposes
 *      SmartOffice to the app (port-forward / VPN / public IP) — that exposure
 *      is DATA (settings keys hr_smartoffice_base_url / _api_key / _serials /
 *      _last_sync), never hardcoded. When the link is down, the CSV import
 *      below stays the guaranteed offline path — same engine, same rules.
 *      Client contract with /api/hr/biometric/smartoffice (canAdminHr):
 *        GET  → { configured, base_url, serials[], last_sync, api_key_set }
 *               (the API key itself is NEVER echoed — SECRET_KEY_RE masks it)
 *        POST { action: 'save_config', base_url, api_key, serials }
 *               (blank api_key = keep the stored key, house secret rule)
 *        POST { action: 'test' } → { ok, message, users? } (verbatim reply)
 *        POST { action: 'sync', from, to } → syncSmartOfficePunches() report
 *        POST { action: 'push_user', employee_id, with_photo }
 *               → { ok, message, photo?: { ok, message } }
 *        POST { action: 'block_user' | 'unblock_user', employee_id }
 *        POST { action: 'set_expiration', employee_id, date }
 *      User commands are addressed by employee_id — the route resolves the
 *      employee's active mapping itself ('' any-device wildcard wins).
 *      Responses are parsed tolerantly (soft key aliases) and the device's
 *      reply is surfaced VERBATIM — never rewritten into fake success copy.
 *   3. CSV punch import — the guaranteed offline path (owner ruling: go-live
 *      is biometric-gated). Preview (?commit=0) is mandatory before Import
 *      (?commit=1); unmatched rows are surfaced with line numbers, never
 *      silently dropped. Editing the CSV after a preview disarms the Import
 *      button until the next preview.
 *
 * All endpoints gate on canAdminHr server-side — this page just renders the
 * 401/403 honestly. Structure copied from src/app/hr/employees/page.tsx.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Fingerprint, Plus, X, Loader2, Save, Upload, FileText, AlertTriangle,
  CheckCircle2, Ban, RefreshCw, Info, Eye, Cable, Wifi, Send, Lock, Unlock,
  CalendarClock,
} from 'lucide-react';
import { api, apiJson } from '@/lib/api';
import { todayIST } from '@/lib/format-date';
import Combobox, { type ComboOption } from '@/components/Combobox';

/** A hr_biometric_map row joined to its employee (GET /api/hr/biometric). */
interface MappingRow {
  id: string;
  employee_id: string;
  biometric_employee_id: string;
  device_id: string;
  is_active: number;
  /** joined display fields — tolerate either key from the API */
  employee_code?: string | null;
  full_name?: string | null;
  employee_name?: string | null;
}

interface EmployeeRow { id: string; employee_code: string; full_name: string; has_photo?: number }

interface AddForm { employee_id: string; biometric_employee_id: string; device_id: string }
const emptyAdd = (): AddForm => ({ employee_id: '', biometric_employee_id: '', device_id: '' });

/** One echoed CSV row (matched sample or unmatched) — keys tolerated loosely. */
type CsvEchoRow = Record<string, any>;

interface PreviewResult {
  total: number;
  matched: number;
  unmatched: number;
  sampleRows: CsvEchoRow[];
  unmatchedRows: CsvEchoRow[];
}

interface CommitResult {
  recorded: number;
  ignored: number;
  unmatched: number;
  unmatchedRows: CsvEchoRow[];
}

/** Count from a number, numeric string, or array length; null when absent. */
function toCount(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (Array.isArray(v)) return v.length;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** Tolerant readers for the import API's echoed rows. */
function rowLine(r: CsvEchoRow): string {
  const n = toCount(r?.line) ?? toCount(r?.line_no) ?? toCount(r?.row) ?? null;
  return n === null ? '—' : String(n);
}
function rowBioId(r: CsvEchoRow): string {
  return String(r?.biometric_employee_id ?? r?.bio_id ?? '') || '—';
}
function rowTimestamp(r: CsvEchoRow): string {
  return String(r?.timestamp ?? r?.at ?? '') || '—';
}
function rowDevice(r: CsvEchoRow): string {
  return String(r?.device_id ?? '') || '—';
}
function rowEmployee(r: CsvEchoRow): string {
  return String(r?.employee_name ?? r?.full_name ?? '') || '—';
}
function rowReason(r: CsvEchoRow): string {
  return String(r?.reason ?? r?.error ?? '') || 'No active mapping for this biometric id';
}

/** Normalise the preview response without assuming exact key names. */
function normalizePreview(json: any): PreviewResult {
  const unmatchedRows: CsvEchoRow[] = Array.isArray(json?.unmatched_rows)
    ? json.unmatched_rows
    : Array.isArray(json?.unmatched) ? json.unmatched : [];
  const sampleRows: CsvEchoRow[] = Array.isArray(json?.sample)
    ? json.sample
    : Array.isArray(json?.matched_rows) ? json.matched_rows
    : Array.isArray(json?.rows) ? json.rows : [];
  const matched = toCount(json?.matched) ?? toCount(json?.matched_count) ?? sampleRows.length;
  const unmatched = toCount(json?.unmatched) ?? toCount(json?.unmatched_count) ?? unmatchedRows.length;
  const total = toCount(json?.total) ?? toCount(json?.total_rows) ?? matched + unmatched;
  return { total, matched, unmatched, sampleRows: sampleRows.slice(0, 10), unmatchedRows };
}

/** Normalise the commit response without assuming exact key names. */
function normalizeCommit(json: any): CommitResult {
  const unmatchedRows: CsvEchoRow[] = Array.isArray(json?.unmatched_rows)
    ? json.unmatched_rows
    : Array.isArray(json?.unmatched) ? json.unmatched : [];
  const recorded = toCount(json?.recorded) ?? toCount(json?.recorded_count) ?? toCount(json?.imported) ?? 0;
  const ignored = toCount(json?.ignored) ?? toCount(json?.ignored_count) ?? toCount(json?.duplicates) ?? 0;
  const unmatched = toCount(json?.unmatched) ?? toCount(json?.unmatched_count) ?? unmatchedRows.length;
  return { recorded, ignored, unmatched, unmatchedRows };
}

/** Beyond this the server-side body buffer becomes the risk — refuse client-side. */
const MAX_CSV_CHARS = 2_000_000;

/* ── SmartOffice connector (card 2) — types + tolerant normalizers ──────── */

/** GET /api/hr/biometric/smartoffice — config PRESENCE (key never echoed). */
interface SoConfigView {
  base_url: string;
  api_key_set: boolean;
  /** Comma-joined for the input, whatever shape the API sent. */
  serials: string;
  /** 'YYYY-MM-DD' of the last fully-synced IST day, '' when never synced. */
  last_sync: string;
  /** Base URL + API key both stored — the minimum for any device call. */
  configured: boolean;
}

interface SoTestResult { ok: boolean; message: string; enrolled: number | null }

interface SoSyncReport {
  ok: boolean;
  message: string;
  fetched: number;
  recorded: number;
  ignored: number;
  refused: { code: string; reason: string }[];
  unmatched: { code: string; punches: number }[];
}

function normalizeSoConfig(json: any): SoConfigView {
  const src = json && typeof json === 'object' && json.config && typeof json.config === 'object'
    ? json.config
    : json ?? {};
  const base_url = String(src?.base_url ?? src?.baseUrl ?? '');
  const api_key_set = !!(src?.api_key_set ?? src?.apiKeySet);
  const serialsRaw = src?.serials;
  const serials = Array.isArray(serialsRaw) ? serialsRaw.join(', ') : String(serialsRaw ?? '');
  const last_sync = String(src?.last_sync ?? src?.lastSync ?? '');
  const configured = typeof src?.configured === 'boolean'
    ? src.configured
    : base_url !== '' && api_key_set;
  return { base_url, api_key_set, serials, last_sync, configured };
}

/** Enrolled-user count from any of the plausible test-reply shapes. */
function soEnrolledCount(json: any): number | null {
  const direct = toCount(json?.enrolled_users) ?? toCount(json?.enrolled)
    ?? toCount(json?.user_count) ?? toCount(json?.users);
  if (direct !== null) return direct;
  if (Array.isArray(json?.devices)) {
    let sum = 0;
    let any = false;
    for (const d of json.devices) {
      const n = toCount(d?.enrolled_users) ?? toCount(d?.enrolled)
        ?? toCount(d?.users) ?? toCount(d?.count);
      if (n !== null) { sum += n; any = true; }
    }
    return any ? sum : null;
  }
  return null;
}

/** Normalise the sync report (syncSmartOfficePunches shape, aliases tolerated). */
function normalizeSoSync(json: any): SoSyncReport {
  const refusedRaw: any[] = Array.isArray(json?.refused) ? json.refused : [];
  const unmatchedRaw: any[] = Array.isArray(json?.unmatched) ? json.unmatched : [];
  return {
    ok: json?.ok !== false,
    message: String(json?.message ?? ''),
    fetched: toCount(json?.fetched) ?? 0,
    recorded: toCount(json?.recorded) ?? 0,
    ignored: toCount(json?.ignored_duplicates) ?? toCount(json?.ignored) ?? 0,
    refused: refusedRaw.map(r => ({
      code: String(r?.code ?? r?.employeeCode ?? '') || '—',
      reason: String(r?.reason ?? r?.error ?? '') || 'Refused by the attendance engine',
    })),
    unmatched: unmatchedRaw.map(u => ({
      code: String(u?.employeeCode ?? u?.code ?? '') || '—',
      punches: toCount(u?.punches) ?? toCount(u?.count) ?? 0,
    })),
  };
}

export default function HrBiometricPage() {
  // ── Card 1: mappings ────────────────────────────────────────────────────
  const [mappings, setMappings] = useState<MappingRow[]>([]);
  const [loadingMap, setLoadingMap] = useState(true);
  const [mapError, setMapError] = useState<string | null>(null);
  const [deactivatingId, setDeactivatingId] = useState<string | null>(null);

  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState<AddForm>(emptyAdd());
  const [addError, setAddError] = useState<string | null>(null);
  const [savingAdd, setSavingAdd] = useState(false);

  // ── Card 2: CSV import ──────────────────────────────────────────────────
  const [csvText, setCsvText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  /** The exact text the current preview was computed from — edits disarm Import. */
  const [previewedCsv, setPreviewedCsv] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<CommitResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Card 2: SmartOffice connector ───────────────────────────────────────
  const [soCfg, setSoCfg] = useState<SoConfigView | null>(null);
  const [soCfgError, setSoCfgError] = useState<string | null>(null);
  const [soBaseUrl, setSoBaseUrl] = useState('');
  const [soApiKey, setSoApiKey] = useState('');
  const [soSerials, setSoSerials] = useState('');
  /** Inputs seed from the stored config exactly once — edits then own them. */
  const soSeededRef = useRef(false);
  const [savingSo, setSavingSo] = useState(false);
  const [soSaveMsg, setSoSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testingSo, setTestingSo] = useState(false);
  const [soTest, setSoTest] = useState<SoTestResult | null>(null);
  const [syncFrom, setSyncFrom] = useState('');
  const [syncTo, setSyncTo] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncReport, setSyncReport] = useState<SoSyncReport | null>(null);

  // Per-mapping device commands (`${mappingId}:${verb}` busy key).
  const [soBusy, setSoBusy] = useState<string | null>(null);
  const [deviceMsgs, setDeviceMsgs] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [pushPhoto, setPushPhoto] = useState<Record<string, boolean>>({});
  const [expiryFor, setExpiryFor] = useState<MappingRow | null>(null);
  const [expiryDate, setExpiryDate] = useState('');
  const [expiryError, setExpiryError] = useState<string | null>(null);
  const [savingExpiry, setSavingExpiry] = useState(false);

  const fetchMappings = useCallback(async () => {
    setMapError(null);
    try {
      const res = await fetch('/api/hr/biometric');
      if (!res.ok) {
        setMapError(res.status === 401 || res.status === 403
          ? 'You need admin access for biometric setup.'
          : "Couldn't load device mappings");
        return;
      }
      const json = await res.json();
      setMappings(Array.isArray(json?.mappings) ? json.mappings : []);
    } catch {
      setMapError("Couldn't load device mappings");
    } finally {
      setLoadingMap(false);
    }
  }, []);

  useEffect(() => { fetchMappings(); }, [fetchMappings]);

  // Employee picker data for the add modal (bare fetch is fine for GETs).
  useEffect(() => {
    fetch('/api/hr/employees?pageSize=100')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(j => setEmployees(Array.isArray(j?.rows) ? j.rows : []))
      .catch(() => {});
  }, []);

  const employeeOptions = useMemo<ComboOption[]>(
    () => employees.map(e => ({ value: e.id, label: e.full_name, hint: e.employee_code })),
    [employees],
  );
  const employeeById = useMemo(() => new Map(employees.map(e => [e.id, e])), [employees]);

  const displayName = (m: MappingRow) => m.full_name || m.employee_name || '—';

  // ── Card 1 actions ──────────────────────────────────────────────────────
  const openAdd = () => { setAddForm(emptyAdd()); setAddError(null); setShowAdd(true); };

  const saveMapping = async () => {
    if (!addForm.employee_id) { setAddError('Pick an employee.'); return; }
    if (!addForm.biometric_employee_id.trim()) {
      setAddError('Enter the id the device knows this person by.');
      return;
    }
    setSavingAdd(true);
    setAddError(null);
    try {
      await apiJson('/api/hr/biometric', {
        method: 'POST',
        body: {
          employee_id: addForm.employee_id,
          biometric_employee_id: addForm.biometric_employee_id.trim(),
          device_id: addForm.device_id.trim(),
        },
      });
      setShowAdd(false);
      fetchMappings();
    } catch (e: any) {
      setAddError(e?.message || 'Could not save the mapping');
    } finally {
      setSavingAdd(false);
    }
  };

  const deactivateMapping = async (m: MappingRow) => {
    const who = displayName(m) === '—' ? m.biometric_employee_id : displayName(m);
    if (!window.confirm(`Deactivate this mapping for ${who}? Device punches with id "${m.biometric_employee_id}" will stop resolving until it is re-added.`)) {
      return;
    }
    setDeactivatingId(m.id);
    setMapError(null);
    try {
      await apiJson('/api/hr/biometric', { method: 'DELETE', body: { id: m.id } });
      fetchMappings();
    } catch (e: any) {
      setMapError(e?.message || 'Could not deactivate the mapping');
    } finally {
      setDeactivatingId(null);
    }
  };

  // ── Card 2 (SmartOffice) actions ────────────────────────────────────────
  const SO_API = '/api/hr/biometric/smartoffice';

  const fetchSoConfig = useCallback(async () => {
    setSoCfgError(null);
    try {
      const res = await fetch(SO_API);
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setSoCfgError(res.status === 401 || res.status === 403
          ? 'You need admin access for the SmartOffice connector.'
          : "Couldn't load the SmartOffice settings");
        return;
      }
      const cfg = normalizeSoConfig(json);
      setSoCfg(cfg);
      if (!soSeededRef.current) {
        soSeededRef.current = true;
        setSoBaseUrl(cfg.base_url);
        setSoSerials(cfg.serials);
        // Sync range default: re-cover from the cursor (re-runs are idempotent
        // — the engine debounces already-recorded punches into ignored dupes).
        const today = todayIST();
        setSyncFrom(cfg.last_sync || today);
        setSyncTo(today);
      }
    } catch {
      setSoCfgError("Couldn't load the SmartOffice settings");
    }
  }, []);

  useEffect(() => { fetchSoConfig(); }, [fetchSoConfig]);

  const saveSoConfig = async () => {
    setSavingSo(true);
    setSoSaveMsg(null);
    try {
      const res = await api(SO_API, {
        method: 'POST',
        body: {
          action: 'save_config',
          base_url: soBaseUrl.trim(),
          // Blank = keep the stored key (house secret rule — never echoed back).
          api_key: soApiKey.trim(),
          serials: soSerials.trim(),
        },
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setSoSaveMsg({
          ok: false,
          text: json?.error
            || (res.status === 401 || res.status === 403
              ? 'You need admin access to change the connector settings.'
              : 'Could not save the connection settings'),
        });
        return;
      }
      setSoApiKey('');
      setSoTest(null); // stored config changed — the old test verdict is stale
      setSoSaveMsg({ ok: true, text: 'Connection settings saved.' });
      await fetchSoConfig();
    } catch {
      setSoSaveMsg({ ok: false, text: 'Could not reach the server — nothing was saved.' });
    } finally {
      setSavingSo(false);
    }
  };

  const testSoConnection = async () => {
    setTestingSo(true);
    setSoTest(null);
    try {
      const res = await api(SO_API, { method: 'POST', body: { action: 'test' } });
      const json = await res.json().catch(() => null);
      const message = String(json?.message ?? json?.error ?? '')
        || (res.ok ? 'OK' : `HTTP ${res.status}`);
      setSoTest({
        ok: res.ok && json?.ok !== false,
        message,
        enrolled: res.ok ? soEnrolledCount(json) : null,
      });
    } catch {
      setSoTest({ ok: false, message: 'Could not reach this app’s server.', enrolled: null });
    } finally {
      setTestingSo(false);
    }
  };

  const runSoSync = async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(syncFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(syncTo)) {
      setSyncError('Pick both dates (from and to).');
      return;
    }
    if (syncFrom > syncTo) {
      setSyncError('The from date must be on or before the to date.');
      return;
    }
    setSyncing(true);
    setSyncError(null);
    setSyncReport(null);
    try {
      const res = await api(SO_API, {
        method: 'POST',
        body: { action: 'sync', from: syncFrom, to: syncTo },
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setSyncError(
          json?.error || json?.message
            || (res.status === 401 || res.status === 403
              ? 'You need admin access to sync punches.'
              : 'Sync failed — nothing was recorded.'),
        );
        return;
      }
      setSyncReport(normalizeSoSync(json));
      fetchSoConfig(); // the last-sync cursor advanced on a successful fetch
    } catch {
      setSyncError('Could not reach this app’s server — nothing was recorded.');
    } finally {
      setSyncing(false);
    }
  };

  /** One device command for a mapping row; the device's reply lands VERBATIM
   *  under the row (green/red). Never rewritten into fake success copy.
   *  Commands are addressed by employee_id — the route resolves the active
   *  mapping itself (the '' any-device wildcard wins over a pinned device). */
  const runDeviceCommand = async (
    m: MappingRow,
    verb: 'push_user' | 'block_user' | 'unblock_user',
    extra: Record<string, unknown> = {},
  ) => {
    if (verb === 'block_user') {
      const who = displayName(m) === '—' ? m.biometric_employee_id : displayName(m);
      if (!window.confirm(`Block ${who} on the device(s)? They cannot punch until unblocked.`)) return;
    }
    setSoBusy(`${m.id}:${verb}`);
    try {
      const res = await api(SO_API, {
        method: 'POST',
        body: { action: verb, employee_id: m.employee_id, ...extra },
      });
      const json = await res.json().catch(() => null);
      let text = String(json?.message ?? json?.error ?? '')
        || (res.ok ? 'Command sent.' : `HTTP ${res.status}`);
      let ok = res.ok && json?.ok !== false;
      // push_user carries an optional photo sub-result — report it honestly.
      const photo = json?.photo;
      if (photo && typeof photo === 'object') {
        text += ` — photo: ${String(photo.message ?? '') || (photo.ok ? 'sent' : 'failed')}`;
        if (photo.ok === false) ok = false;
      }
      setDeviceMsgs(prev => ({ ...prev, [m.id]: { ok, text } }));
    } catch {
      setDeviceMsgs(prev => ({
        ...prev,
        [m.id]: { ok: false, text: 'Could not reach this app’s server.' },
      }));
    } finally {
      setSoBusy(null);
    }
  };

  const openExpiry = (m: MappingRow) => {
    setExpiryFor(m);
    setExpiryDate('');
    setExpiryError(null);
  };

  const saveExpiry = async () => {
    if (!expiryFor) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) {
      setExpiryError('Pick the expiry date.');
      return;
    }
    setSavingExpiry(true);
    setExpiryError(null);
    try {
      const res = await api(SO_API, {
        method: 'POST',
        body: { action: 'set_expiration', employee_id: expiryFor.employee_id, date: expiryDate },
      });
      const json = await res.json().catch(() => null);
      const text = String(json?.message ?? json?.error ?? '')
        || (res.ok ? 'Command sent.' : `HTTP ${res.status}`);
      if (!res.ok) {
        setExpiryError(text);
        return;
      }
      setDeviceMsgs(prev => ({
        ...prev,
        [expiryFor.id]: { ok: json?.ok !== false, text },
      }));
      setExpiryFor(null);
    } catch {
      setExpiryError('Could not reach this app’s server.');
    } finally {
      setSavingExpiry(false);
    }
  };

  /** "Map…" shortcut from the sync report — prefills the add-mapping modal. */
  const openAddForCode = (code: string) => {
    setAddForm({ ...emptyAdd(), biometric_employee_id: code });
    setAddError(null);
    setShowAdd(true);
  };

  // ── Card 3 actions ──────────────────────────────────────────────────────
  const resetImportState = () => {
    setPreview(null);
    setPreviewedCsv(null);
    setImportResult(null);
    setCsvError(null);
  };

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!f) return;
    try {
      const text = await f.text();
      if (text.length > MAX_CSV_CHARS) {
        setCsvError('That file is too large for one import — split the device export and import it in parts.');
        return;
      }
      resetImportState();
      setCsvText(text);
      setFileName(f.name);
    } catch {
      setCsvError('Could not read that file — try pasting the CSV text instead.');
    }
  };

  const onCsvTyped = (v: string) => {
    setCsvText(v);
    setFileName(null);
    // Any edit invalidates the previous preview's Import arm + old results.
    setImportResult(null);
    setCsvError(null);
  };

  const clearCsv = () => {
    setCsvText('');
    setFileName(null);
    resetImportState();
  };

  const runPreview = async () => {
    if (!csvText.trim()) {
      setCsvError('Choose a file or paste the CSV text first.');
      return;
    }
    if (csvText.length > MAX_CSV_CHARS) {
      setCsvError('That CSV is too large for one import — split it and import in parts.');
      return;
    }
    setPreviewing(true);
    setCsvError(null);
    setImportResult(null);
    try {
      const res = await api('/api/hr/biometric/import?commit=0', {
        method: 'POST',
        headers: { 'Content-Type': 'text/csv' },
        body: csvText,
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setPreview(null);
        setPreviewedCsv(null);
        setCsvError(
          json?.error
            || (res.status === 401 || res.status === 403
              ? 'You need admin access to import punches.'
              : 'Preview failed — nothing was imported.'),
        );
        return;
      }
      setPreview(normalizePreview(json));
      setPreviewedCsv(csvText);
    } catch {
      setPreview(null);
      setPreviewedCsv(null);
      setCsvError('Could not reach the server — nothing was imported.');
    } finally {
      setPreviewing(false);
    }
  };

  const runImport = async () => {
    if (!preview || preview.matched <= 0 || previewedCsv !== csvText) return;
    setImporting(true);
    setCsvError(null);
    try {
      const res = await api('/api/hr/biometric/import?commit=1', {
        method: 'POST',
        headers: { 'Content-Type': 'text/csv' },
        body: csvText,
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setCsvError(
          json?.error
            || (res.status === 401 || res.status === 403
              ? 'You need admin access to import punches.'
              : 'Import failed — check the attendance register before retrying, some rows may have been recorded.'),
        );
        return;
      }
      setImportResult(normalizeCommit(json));
      // Disarm: importing the same text twice would only mint ignored dupes,
      // but there is no reason to leave the trigger loaded.
      setPreview(null);
      setPreviewedCsv(null);
    } catch {
      setCsvError('Could not reach the server — check the attendance register before retrying, some rows may have been recorded.');
    } finally {
      setImporting(false);
    }
  };

  const previewStale = !!preview && previewedCsv !== csvText;
  const canImport = !!preview && preview.matched > 0 && !previewStale && !importing && !previewing;

  const inputCls = 'w-full px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm';

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">

        {/* Header */}
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-2">
            <Fingerprint className="w-6 h-6" /> Biometric &amp; Import
          </h1>
          <p className="text-[#8B7355] text-sm mt-1">
            Device identity mapping, the SmartOffice connector, and the CSV punch import — all three
            feed the same attendance engine under the same rules.
          </p>
        </div>

        {/* ── Card 1: device identity mapping ─────────────────────────────── */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow">
          <div className="px-4 py-3 border-b border-[#E8D5C4] flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-bold text-[#2D1B0E]">Device identity mapping</h2>
              <p className="text-xs text-[#8B7355] mt-0.5">
                SmartOffice punches (and CSV imports) resolve through this table — the biometric id
                must equal the device&apos;s EmployeeCode.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => { setLoadingMap(true); fetchMappings(); }}
                      title="Refresh"
                      className="p-2 border border-[#E8D5C4] bg-white hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg">
                <RefreshCw className="w-4 h-4" />
              </button>
              <button onClick={openAdd}
                      className="inline-flex items-center gap-2 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium">
                <Plus className="w-4 h-4" /> Add Mapping
              </button>
            </div>
          </div>

          {mapError && (
            <div className="mx-4 mt-3 rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm flex items-center justify-between gap-3">
              <span>{mapError}</span>
              <button onClick={() => { setLoadingMap(true); fetchMappings(); }}
                      className="shrink-0 px-3 py-1.5 border border-red-200 rounded-lg text-xs font-medium hover:bg-red-100">
                Retry
              </button>
            </div>
          )}

          {loadingMap ? (
            <div className="p-6 flex items-center justify-center gap-2 text-[#8B7355] text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading...
            </div>
          ) : mappings.length === 0 ? (
            <div className="p-6 text-center text-[#8B7355] text-sm">
              No device mappings yet — add each employee&apos;s id from the biometric device (or its
              export file) so punches can resolve to a person.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                  <tr>
                    <th className="text-left py-2 px-3 font-medium">Employee</th>
                    <th className="text-left py-2 px-3 font-medium">Biometric ID</th>
                    <th className="text-left py-2 px-3 font-medium">Device</th>
                    <th className="text-left py-2 px-3 font-medium">Active</th>
                    <th className="text-right py-2 px-3 font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {mappings.map(m => {
                    const busyOf = (verb: string) => soBusy === `${m.id}:${verb}`;
                    const anyBusy = soBusy !== null && soBusy.startsWith(`${m.id}:`);
                    const hasPhoto = (employeeById.get(m.employee_id)?.has_photo ?? 0) === 1;
                    const msg = deviceMsgs[m.id];
                    const deviceBtnCls = 'inline-flex items-center gap-1 px-2.5 py-1.5 border border-[#E8D5C4] bg-white hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-xs font-medium disabled:opacity-40';
                    return (
                      <Fragment key={m.id}>
                        <tr className={`border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3] ${m.is_active ? '' : 'opacity-60'}`}>
                          <td className="py-2 px-3">
                            <div className="font-bold">{displayName(m)}</div>
                            {m.employee_code && (
                              <div className="text-[10px] font-mono text-[#8B7355]">{m.employee_code}</div>
                            )}
                          </td>
                          <td className="py-2 px-3 font-mono text-xs whitespace-nowrap">{m.biometric_employee_id}</td>
                          <td className="py-2 px-3 text-xs">
                            {m.device_id || <span className="text-[#8B7355]">Any device</span>}
                          </td>
                          <td className="py-2 px-3">
                            {m.is_active ? (
                              <span className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border bg-green-100 text-green-700 border-green-200">
                                Active
                              </span>
                            ) : (
                              <span className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border bg-gray-100 text-gray-600 border-gray-200">
                                Inactive
                              </span>
                            )}
                          </td>
                          <td className="py-2 px-3">
                            <div className="flex flex-wrap items-center justify-end gap-1.5">
                              {/* SmartOffice device commands — active rows, connector configured */}
                              {!!m.is_active && soCfg?.configured && (
                                <>
                                  {hasPhoto && (
                                    <label className="inline-flex items-center gap-1 text-[11px] text-[#6B5744] select-none cursor-pointer whitespace-nowrap"
                                           title="Also push the employee's profile photo to the device (face)">
                                      <input type="checkbox"
                                             checked={!!pushPhoto[m.id]}
                                             onChange={e => setPushPhoto(p => ({ ...p, [m.id]: e.target.checked }))}
                                             className="accent-[#af4408]" />
                                      with photo
                                    </label>
                                  )}
                                  <button onClick={() => runDeviceCommand(m, 'push_user', { with_photo: hasPhoto && !!pushPhoto[m.id] })}
                                          disabled={anyBusy}
                                          title="Send this employee to the device(s) so they can be enrolled"
                                          className={deviceBtnCls}>
                                    {busyOf('push_user')
                                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                      : <Send className="w-3.5 h-3.5" />}
                                    Push to device
                                  </button>
                                  <button onClick={() => runDeviceCommand(m, 'block_user')}
                                          disabled={anyBusy}
                                          title="Block this user on the device(s) — they cannot punch until unblocked"
                                          className={deviceBtnCls}>
                                    {busyOf('block_user')
                                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                      : <Lock className="w-3.5 h-3.5" />}
                                    Block
                                  </button>
                                  <button onClick={() => runDeviceCommand(m, 'unblock_user')}
                                          disabled={anyBusy}
                                          title="Unblock this user on the device(s)"
                                          className={deviceBtnCls}>
                                    {busyOf('unblock_user')
                                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                      : <Unlock className="w-3.5 h-3.5" />}
                                    Unblock
                                  </button>
                                  <button onClick={() => openExpiry(m)}
                                          disabled={anyBusy}
                                          title="Set the date this user's device access expires"
                                          className={deviceBtnCls}>
                                    <CalendarClock className="w-3.5 h-3.5" />
                                    Set expiry
                                  </button>
                                </>
                              )}
                              {!!m.is_active && (
                                <button onClick={() => deactivateMapping(m)}
                                        disabled={deactivatingId === m.id}
                                        className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-[#E8D5C4] bg-white hover:bg-red-50 hover:border-red-200 hover:text-red-700 text-[#6B5744] rounded-lg text-xs font-medium disabled:opacity-40">
                                  {deactivatingId === m.id
                                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    : <Ban className="w-3.5 h-3.5" />}
                                  Deactivate
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                        {/* Device reply — VERBATIM, per row */}
                        {msg && (
                          <tr className={m.is_active ? '' : 'opacity-60'}>
                            <td colSpan={5} className="px-3 pb-2">
                              <div className={`rounded-lg border px-3 py-1.5 text-xs flex items-start justify-between gap-2 ${
                                msg.ok
                                  ? 'bg-green-50 border-green-200 text-green-800'
                                  : 'bg-red-50 border-red-200 text-red-700'
                              }`}>
                                <span>Device reply: &ldquo;{msg.text}&rdquo;</span>
                                <button onClick={() => setDeviceMsgs(prev => {
                                          const next = { ...prev };
                                          delete next[m.id];
                                          return next;
                                        })}
                                        aria-label="Dismiss"
                                        className="shrink-0 opacity-70 hover:opacity-100">
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ── Card 2: SmartOffice connector ───────────────────────────────── */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow">
          <div className="px-4 py-3 border-b border-[#E8D5C4]">
            <h2 className="font-bold text-[#2D1B0E] flex items-center gap-2">
              <Cable className="w-4 h-4 text-[#af4408]" /> SmartOffice connector
            </h2>
            <p className="text-xs text-[#8B7355] mt-0.5">
              SmartOffice v1.0.1 (&quot;Biometrics and HRMS Solution&quot;) — pulls punches straight
              from the venue&apos;s SmartOffice server into the same attendance engine.
            </p>
          </div>

          <div className="p-4 space-y-4">
            {soCfgError && (
              <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm flex items-center justify-between gap-3">
                <span>{soCfgError}</span>
                <button onClick={fetchSoConfig}
                        className="shrink-0 px-3 py-1.5 border border-red-200 rounded-lg text-xs font-medium hover:bg-red-100">
                  Retry
                </button>
              </div>
            )}

            {/* Config row */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="text-xs text-[#6B5744] font-medium">SmartOffice base URL</label>
                <input value={soBaseUrl}
                       onChange={e => setSoBaseUrl(e.target.value)}
                       placeholder="http://192.168.x.x:89"
                       autoComplete="off"
                       className={`${inputCls} font-mono`} />
                <p className="text-[11px] text-[#8B7355] mt-1">
                  As reachable from THIS app&apos;s server — usually the venue&apos;s port-forward or
                  VPN address, not the LAN one.
                </p>
              </div>
              <div>
                <label className="text-xs text-[#6B5744] font-medium">API key</label>
                <input type="password"
                       value={soApiKey}
                       onChange={e => setSoApiKey(e.target.value)}
                       placeholder={soCfg?.api_key_set ? '•••• (stored)' : 'Paste the SmartOffice APIKey'}
                       autoComplete="new-password"
                       className={`${inputCls} font-mono`} />
                <p className="text-[11px] text-[#8B7355] mt-1">
                  {soCfg?.api_key_set
                    ? 'A key is stored — leave blank to keep it.'
                    : 'From the SmartOffice web app’s API settings.'}
                </p>
              </div>
              <div>
                <label className="text-xs text-[#6B5744] font-medium">Device serial numbers</label>
                <input value={soSerials}
                       onChange={e => setSoSerials(e.target.value)}
                       placeholder="e.g. ABC1234567, DEF8901234"
                       autoComplete="off"
                       className={`${inputCls} font-mono`} />
                <p className="text-[11px] text-[#8B7355] mt-1">
                  Comma-separated — used when pushing users and photos to devices.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {/* Guard: until the stored config has loaded, the inputs are unseeded —
                  saving then would silently blank the stored values. */}
              <button onClick={saveSoConfig} disabled={savingSo || testingSo || syncing || !soCfg}
                      title={soCfg ? undefined : 'Waiting for the stored settings to load'}
                      className="inline-flex items-center gap-2 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium disabled:opacity-40">
                {savingSo ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                Save
              </button>
              <button onClick={testSoConnection}
                      disabled={testingSo || savingSo || syncing || !soCfg?.configured}
                      title={soCfg?.configured ? undefined : 'Save the base URL and API key first'}
                      className="inline-flex items-center gap-2 px-3 py-2 border border-[#af4408] text-[#af4408] hover:bg-[#FFF1E3] rounded-lg text-sm font-medium disabled:opacity-40">
                {testingSo ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wifi className="w-4 h-4" />}
                Test connection
              </button>
              {soSaveMsg && (
                <span className={`text-xs font-medium ${soSaveMsg.ok ? 'text-green-700' : 'text-red-700'}`}>
                  {soSaveMsg.text}
                </span>
              )}
            </div>

            {/* Test verdict — the device's reply VERBATIM */}
            {soTest && (
              <div className={`rounded-xl border px-4 py-3 text-sm flex items-start gap-2 ${
                soTest.ok
                  ? 'border-green-200 bg-green-50 text-green-800'
                  : 'border-red-200 bg-red-50 text-red-700'
              }`}>
                {soTest.ok
                  ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
                  : <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />}
                <div>
                  <div>SmartOffice replied: &ldquo;{soTest.message}&rdquo;</div>
                  {soTest.enrolled !== null && (
                    <div className="text-xs mt-0.5">
                      {soTest.enrolled} user{soTest.enrolled === 1 ? '' : 's'} enrolled on the device{soCfg && soCfg.serials.includes(',') ? 's' : ''}.
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Sync row */}
            <div className="border-t border-[#E8D5C4] pt-4 space-y-3">
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label className="text-xs text-[#6B5744] font-medium">From (IST day)</label>
                  <input type="date" value={syncFrom}
                         onChange={e => { setSyncFrom(e.target.value); setSyncError(null); }}
                         className={inputCls} />
                </div>
                <div>
                  <label className="text-xs text-[#6B5744] font-medium">To (IST day)</label>
                  <input type="date" value={syncTo}
                         onChange={e => { setSyncTo(e.target.value); setSyncError(null); }}
                         className={inputCls} />
                </div>
                <button onClick={runSoSync}
                        disabled={syncing || savingSo || testingSo || !soCfg?.configured}
                        title={soCfg?.configured ? undefined : 'Save the base URL and API key first'}
                        className="inline-flex items-center gap-2 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium disabled:opacity-40">
                  {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                  Sync punches
                </button>
                <span className="text-[11px] text-[#8B7355] pb-2">
                  {soCfg?.last_sync
                    ? <>Last fully-synced day: <span className="font-mono">{soCfg.last_sync}</span></>
                    : 'Never synced yet.'}
                </span>
              </div>

              <p className="text-[11px] text-[#8B7355]">
                The venue&apos;s SmartOffice server must be reachable from this app (port-forward or
                VPN). If it is not, use the CSV import below — same engine, same rules.
              </p>

              {syncError && (
                <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>{syncError}</span>
                </div>
              )}

              {/* Sync report — honest, every bucket named */}
              {syncReport && (
                <div className="space-y-3">
                  {!syncReport.ok && (
                    <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                      <span>{syncReport.message || 'The fetch from SmartOffice failed — nothing was recorded.'}</span>
                    </div>
                  )}

                  {syncReport.ok && (
                    <>
                      <div className="flex flex-wrap gap-2">
                        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border bg-[#FFF1E3] text-[#6B5744] border-[#E8D5C4]">
                          {syncReport.fetched} fetched
                        </span>
                        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border bg-green-100 text-green-700 border-green-200">
                          <CheckCircle2 className="w-3.5 h-3.5" /> {syncReport.recorded} recorded
                        </span>
                        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border bg-amber-100 text-amber-800 border-amber-200">
                          {syncReport.ignored} ignored duplicate{syncReport.ignored === 1 ? '' : 's'}
                        </span>
                        <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border ${
                          syncReport.refused.length > 0
                            ? 'bg-red-100 text-red-700 border-red-200'
                            : 'bg-gray-100 text-gray-600 border-gray-200'
                        }`}>
                          {syncReport.refused.length} refused
                        </span>
                        <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border ${
                          syncReport.unmatched.length > 0
                            ? 'bg-red-100 text-red-700 border-red-200'
                            : 'bg-gray-100 text-gray-600 border-gray-200'
                        }`}>
                          {syncReport.unmatched.length} unmatched id{syncReport.unmatched.length === 1 ? '' : 's'}
                        </span>
                      </div>

                      {syncReport.refused.length > 0 && (
                        <div className="rounded-xl border border-red-200 overflow-hidden">
                          <div className="bg-red-50 text-red-700 px-3 py-2 text-xs font-semibold">
                            Refused punches — the engine rejected these (e.g. suspended staff cannot
                            punch until HR releases the suspension). They were NOT recorded.
                          </div>
                          <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                              <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                                <tr>
                                  <th className="text-left py-2 px-3 font-medium">Device employee code</th>
                                  <th className="text-left py-2 px-3 font-medium">Why</th>
                                </tr>
                              </thead>
                              <tbody>
                                {syncReport.refused.map((r, i) => (
                                  <tr key={i} className="border-t border-[#E8D5C4]/50">
                                    <td className="py-1.5 px-3 text-xs font-mono">{r.code}</td>
                                    <td className="py-1.5 px-3 text-xs text-red-700">{r.reason}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}

                      {syncReport.unmatched.length > 0 && (
                        <div className="rounded-xl border border-red-200 overflow-hidden">
                          <div className="bg-red-50 text-red-700 px-3 py-2 text-xs font-semibold">
                            Unmatched device ids — no active mapping, so their punches were NOT
                            recorded. Map them, then sync the range again (safe: already-recorded
                            punches just count as ignored duplicates).
                          </div>
                          <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                              <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                                <tr>
                                  <th className="text-left py-2 px-3 font-medium">Device employee code</th>
                                  <th className="text-left py-2 px-3 font-medium">Punches</th>
                                  <th className="text-right py-2 px-3 font-medium"></th>
                                </tr>
                              </thead>
                              <tbody>
                                {syncReport.unmatched.map((u, i) => (
                                  <tr key={i} className="border-t border-[#E8D5C4]/50">
                                    <td className="py-1.5 px-3 text-xs font-mono">{u.code}</td>
                                    <td className="py-1.5 px-3 text-xs">{u.punches}</td>
                                    <td className="py-1.5 px-3 text-right">
                                      <button onClick={() => openAddForCode(u.code)}
                                              className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-[#af4408] text-[#af4408] hover:bg-[#FFF1E3] rounded-lg text-xs font-medium">
                                        <Plus className="w-3.5 h-3.5" /> Map…
                                      </button>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Card 3: CSV punch import ────────────────────────────────────── */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow">
          <div className="px-4 py-3 border-b border-[#E8D5C4]">
            <h2 className="font-bold text-[#2D1B0E] flex items-center gap-2">
              <Upload className="w-4 h-4 text-[#af4408]" /> CSV punch import
            </h2>
            <p className="text-xs text-[#8B7355] mt-0.5">
              The guaranteed offline path — works with any device&apos;s export, even when the
              SmartOffice link is down. Preview first — nothing is written until you press Import.
            </p>
          </div>

          <div className="p-4 space-y-4">
            {/* Expected format — prominent, this is the go-live path */}
            <div className="rounded-xl border border-[#E8D5C4] bg-[#FFF1E3] px-4 py-3 text-sm">
              <div className="flex items-start gap-2">
                <Info className="w-4 h-4 text-[#af4408] mt-0.5 shrink-0" />
                <div className="space-y-1">
                  <div>
                    Columns: <code className="font-mono text-xs bg-white border border-[#E8D5C4] rounded px-1 py-0.5">biometric_employee_id, timestamp, device_id</code>{' '}
                    (device_id optional).
                  </div>
                  <div>
                    Timestamps are <span className="font-semibold">IST</span> —{' '}
                    <code className="font-mono text-xs bg-white border border-[#E8D5C4] rounded px-1 py-0.5">YYYY-MM-DD HH:MM</code>{' '}
                    or{' '}
                    <code className="font-mono text-xs bg-white border border-[#E8D5C4] rounded px-1 py-0.5">DD-MM-YYYY HH:MM</code>.
                  </div>
                  <div className="text-xs text-[#8B7355]">
                    Ids resolve through the mapping table above. Unmatched rows are reported back —
                    never silently dropped. Punches repeated within the debounce window are kept but
                    marked ignored. Business day follows the attendance cutoff, so punches before it
                    land on the previous day.
                  </div>
                </div>
              </div>
            </div>

            {/* Inputs: file OR pasted text */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-xs text-[#6B5744] font-medium">Device export file</label>
                <input ref={fileInputRef} type="file" accept=".csv,.txt,text/csv,text/plain"
                       onChange={onPickFile} className="hidden" />
                <button onClick={() => fileInputRef.current?.click()}
                        className="w-full flex flex-col items-center justify-center gap-2 px-4 py-6 border-2 border-dashed border-[#E8D5C4] hover:border-[#af4408] hover:bg-[#FFF1E3] rounded-xl text-sm text-[#6B5744]">
                  <FileText className="w-6 h-6 text-[#8B7355]" />
                  {fileName
                    ? <span className="font-medium text-[#2D1B0E]">{fileName}</span>
                    : <span>Choose a CSV file…</span>}
                  <span className="text-[11px] text-[#8B7355]">Loads into the text box for review</span>
                </button>
              </div>
              <div className="space-y-2">
                <label className="text-xs text-[#6B5744] font-medium">…or paste the CSV text</label>
                <textarea
                  value={csvText}
                  onChange={e => onCsvTyped(e.target.value)}
                  rows={7}
                  spellCheck={false}
                  placeholder={'biometric_employee_id,timestamp,device_id\n101,2026-08-19 09:32,GATE1\n101,2026-08-19 15:04,GATE1'}
                  className="w-full px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-xs font-mono"
                />
              </div>
            </div>

            {/* Actions */}
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={runPreview} disabled={previewing || importing || !csvText.trim()}
                      className="inline-flex items-center gap-2 px-3 py-2 border border-[#af4408] text-[#af4408] hover:bg-[#FFF1E3] rounded-lg text-sm font-medium disabled:opacity-40">
                {previewing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />}
                Preview
              </button>
              <button onClick={runImport} disabled={!canImport}
                      title={!preview ? 'Run a preview first' : preview.matched <= 0 ? 'Nothing matched — fix the mappings or the CSV' : previewStale ? 'The CSV changed — preview again' : undefined}
                      className="inline-flex items-center gap-2 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium disabled:opacity-40">
                {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                Import
              </button>
              {csvText && (
                <button onClick={clearCsv} disabled={previewing || importing}
                        className="inline-flex items-center gap-1 px-3 py-2 text-sm text-[#6B5744] hover:text-[#2D1B0E] disabled:opacity-40">
                  <X className="w-4 h-4" /> Clear
                </button>
              )}
              <span className="text-[11px] text-[#8B7355]">
                Import writes real attendance punches (source &quot;import&quot;).
              </span>
            </div>

            {/* Error state — first-class, not an afterthought */}
            {csvError && (
              <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{csvError}</span>
              </div>
            )}

            {/* Stale-preview warning */}
            {previewStale && !csvError && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 text-amber-800 px-4 py-3 text-sm flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>The CSV changed since the last preview — run Preview again before importing.</span>
              </div>
            )}

            {/* Preview result */}
            {preview && !previewStale && (
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border bg-[#FFF1E3] text-[#6B5744] border-[#E8D5C4]">
                    {preview.total} row{preview.total === 1 ? '' : 's'}
                  </span>
                  <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border bg-green-100 text-green-700 border-green-200">
                    <CheckCircle2 className="w-3.5 h-3.5" /> {preview.matched} matched
                  </span>
                  <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border ${
                    preview.unmatched > 0
                      ? 'bg-red-100 text-red-700 border-red-200'
                      : 'bg-gray-100 text-gray-600 border-gray-200'
                  }`}>
                    <AlertTriangle className="w-3.5 h-3.5" /> {preview.unmatched} unmatched
                  </span>
                </div>

                {preview.matched <= 0 && (
                  <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm">
                    Nothing matched — no punches can be imported. Check that the biometric ids in the
                    CSV exist in the mapping table above and that the columns follow the stated format.
                  </div>
                )}

                {preview.unmatchedRows.length > 0 && (
                  <div className="rounded-xl border border-red-200 overflow-hidden">
                    <div className="bg-red-50 text-red-700 px-3 py-2 text-xs font-semibold">
                      Unmatched rows — these will NOT be imported. Add their ids to the mapping table,
                      then preview again.
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                          <tr>
                            <th className="text-left py-2 px-3 font-medium">Line</th>
                            <th className="text-left py-2 px-3 font-medium">Biometric ID</th>
                            <th className="text-left py-2 px-3 font-medium">Timestamp (IST)</th>
                            <th className="text-left py-2 px-3 font-medium">Device</th>
                            <th className="text-left py-2 px-3 font-medium">Why</th>
                          </tr>
                        </thead>
                        <tbody>
                          {preview.unmatchedRows.map((r, i) => (
                            <tr key={i} className="border-t border-[#E8D5C4]/50">
                              <td className="py-1.5 px-3 text-xs font-mono">{rowLine(r)}</td>
                              <td className="py-1.5 px-3 text-xs font-mono">{rowBioId(r)}</td>
                              <td className="py-1.5 px-3 text-xs font-mono whitespace-nowrap">{rowTimestamp(r)}</td>
                              <td className="py-1.5 px-3 text-xs">{rowDevice(r)}</td>
                              <td className="py-1.5 px-3 text-xs text-red-700">{rowReason(r)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {preview.sampleRows.length > 0 && (
                  <div className="rounded-xl border border-[#E8D5C4] overflow-hidden">
                    <div className="bg-[#FFF1E3] text-[#6B5744] px-3 py-2 text-xs font-semibold">
                      Sample — first {preview.sampleRows.length} matched row{preview.sampleRows.length === 1 ? '' : 's'}
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                          <tr>
                            <th className="text-left py-2 px-3 font-medium">Line</th>
                            <th className="text-left py-2 px-3 font-medium">Biometric ID</th>
                            <th className="text-left py-2 px-3 font-medium">Employee</th>
                            <th className="text-left py-2 px-3 font-medium">Timestamp (IST)</th>
                            <th className="text-left py-2 px-3 font-medium">Device</th>
                          </tr>
                        </thead>
                        <tbody>
                          {preview.sampleRows.map((r, i) => (
                            <tr key={i} className="border-t border-[#E8D5C4]/50">
                              <td className="py-1.5 px-3 text-xs font-mono">{rowLine(r)}</td>
                              <td className="py-1.5 px-3 text-xs font-mono">{rowBioId(r)}</td>
                              <td className="py-1.5 px-3 text-xs">{rowEmployee(r)}</td>
                              <td className="py-1.5 px-3 text-xs font-mono whitespace-nowrap">{rowTimestamp(r)}</td>
                              <td className="py-1.5 px-3 text-xs">{rowDevice(r)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Import result */}
            {importResult && (
              <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm space-y-2">
                <div className="flex items-center gap-2 font-semibold text-green-800">
                  <CheckCircle2 className="w-4 h-4" /> Import finished
                </div>
                <div className="flex flex-wrap gap-2">
                  <span className="inline-flex px-3 py-1.5 rounded-full text-xs font-medium border bg-green-100 text-green-700 border-green-200">
                    {importResult.recorded} punch{importResult.recorded === 1 ? '' : 'es'} recorded
                  </span>
                  <span className="inline-flex px-3 py-1.5 rounded-full text-xs font-medium border bg-amber-100 text-amber-800 border-amber-200">
                    {importResult.ignored} ignored duplicate{importResult.ignored === 1 ? '' : 's'}
                  </span>
                  <span className={`inline-flex px-3 py-1.5 rounded-full text-xs font-medium border ${
                    importResult.unmatched > 0
                      ? 'bg-red-100 text-red-700 border-red-200'
                      : 'bg-gray-100 text-gray-600 border-gray-200'
                  }`}>
                    {importResult.unmatched} unmatched (not imported)
                  </span>
                </div>
                {importResult.unmatchedRows.length > 0 && (
                  <div className="rounded-lg border border-red-200 bg-white overflow-hidden">
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                          <tr>
                            <th className="text-left py-2 px-3 font-medium">Line</th>
                            <th className="text-left py-2 px-3 font-medium">Biometric ID</th>
                            <th className="text-left py-2 px-3 font-medium">Timestamp (IST)</th>
                            <th className="text-left py-2 px-3 font-medium">Why</th>
                          </tr>
                        </thead>
                        <tbody>
                          {importResult.unmatchedRows.map((r, i) => (
                            <tr key={i} className="border-t border-[#E8D5C4]/50">
                              <td className="py-1.5 px-3 text-xs font-mono">{rowLine(r)}</td>
                              <td className="py-1.5 px-3 text-xs font-mono">{rowBioId(r)}</td>
                              <td className="py-1.5 px-3 text-xs font-mono whitespace-nowrap">{rowTimestamp(r)}</td>
                              <td className="py-1.5 px-3 text-xs text-red-700">{rowReason(r)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
                <div className="text-xs text-green-800">
                  Recorded punches are on the attendance register now — day summaries recompute as
                  each punch lands.
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Add-mapping modal — house safe-modal shell */}
        {showAdd && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
            <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
                 className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-md shadow-xl flex flex-col overflow-hidden">
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <h2 className="font-bold text-[#2D1B0E]">Add Device Mapping</h2>
                <button onClick={() => { if (!savingAdd) setShowAdd(false); }} className="text-[#8B7355]">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
                {addError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">
                    {addError}
                  </div>
                )}

                <div>
                  <label className="text-xs text-[#6B5744]">Employee *</label>
                  <Combobox
                    options={employeeOptions}
                    value={addForm.employee_id ? (employeeById.get(addForm.employee_id)?.full_name || '') : ''}
                    onChange={(v) => setAddForm(f => ({ ...f, employee_id: v }))}
                    placeholder="Pick employee"
                  />
                </div>
                <div>
                  <label className="text-xs text-[#6B5744]">Biometric employee id *</label>
                  <input value={addForm.biometric_employee_id}
                         onChange={e => setAddForm(f => ({ ...f, biometric_employee_id: e.target.value }))}
                         placeholder="e.g. 101"
                         className={`${inputCls} font-mono`} />
                  <p className="text-[11px] text-[#8B7355] mt-1">
                    The id the device (or its export file) knows this person by.
                  </p>
                </div>
                <div>
                  <label className="text-xs text-[#6B5744]">Device id</label>
                  <input value={addForm.device_id}
                         onChange={e => setAddForm(f => ({ ...f, device_id: e.target.value }))}
                         placeholder="Leave blank for any device"
                         className={inputCls} />
                  <p className="text-[11px] text-[#8B7355] mt-1">
                    Optional — only needed once more than one device is punching.
                  </p>
                </div>
              </div>

              <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
                <button onClick={() => setShowAdd(false)} disabled={savingAdd}
                        className="px-3 py-2 text-sm text-[#6B5744] disabled:opacity-50">
                  Cancel
                </button>
                <button onClick={saveMapping} disabled={savingAdd}
                        className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
                  {savingAdd ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Set-expiry modal — house safe-modal shell */}
        {expiryFor && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
            <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
                 className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-sm shadow-xl flex flex-col overflow-hidden">
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <h2 className="font-bold text-[#2D1B0E]">Set device expiry</h2>
                <button onClick={() => { if (!savingExpiry) setExpiryFor(null); }} className="text-[#8B7355]">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
                {expiryError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">
                    {expiryError}
                  </div>
                )}

                <div className="text-sm">
                  <span className="font-bold">
                    {displayName(expiryFor) === '—' ? 'Device id' : displayName(expiryFor)}
                  </span>{' '}
                  <span className="font-mono text-xs text-[#8B7355]">
                    ({expiryFor.biometric_employee_id})
                  </span>
                </div>

                <div>
                  <label className="text-xs text-[#6B5744]">Expiry date *</label>
                  <input type="date" value={expiryDate}
                         onChange={e => { setExpiryDate(e.target.value); setExpiryError(null); }}
                         className={inputCls} />
                  <p className="text-[11px] text-[#8B7355] mt-1">
                    The user&apos;s access on the biometric device(s) ends on this date. Applies
                    across the configured devices.
                  </p>
                </div>
              </div>

              <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
                <button onClick={() => setExpiryFor(null)} disabled={savingExpiry}
                        className="px-3 py-2 text-sm text-[#6B5744] disabled:opacity-50">
                  Cancel
                </button>
                <button onClick={saveExpiry} disabled={savingExpiry}
                        className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
                  {savingExpiry ? <Loader2 className="w-4 h-4 animate-spin" /> : <CalendarClock className="w-4 h-4" />} Set expiry
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
