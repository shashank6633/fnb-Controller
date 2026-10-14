'use client';

/**
 * PEST CONTROL LOGS (owner §7) — four registers on one screen: sightings, the
 * station-by-station monitoring sheet (#113), contractor visits with what they
 * applied (#78), and the pest map.
 *
 * ── THE TWO DIFFERENT RIGHTS ON ONE SCREEN, WHICH IS THE WHOLE DESIGN ───────
 * The shell this replaces promised it in words and the API enforces it:
 *   · REPORTING A SIGHTING IS OPEN TO EVERYONE. A porter who sees droppings
 *     behind the dry store at eleven at night files it from where he is standing.
 *     That immediacy is the only reason the register is ever true, so "Report a
 *     sighting" is the first thing on the screen, on every tab, at thumb height
 *     on a phone, and it needs four taps.
 *   · RECORDING THE CONTRACTOR'S VISIT IS A MANAGER'S JOB — the agency licence
 *     number and the chemical list on that row are what an inspector reads first.
 *   · THE PEST MAP IS CONFIGURATION, so it is the administrator's (owner §20).
 *   · WALKING THE STATIONS IS OPEN TO EVERYONE, like a sighting — the steward who
 *     walks them at closing files the sheet (_components/MonitoringTab.tsx).
 *   · A WRONG FILE IS VOIDED, NEVER REMOVED: it stays on the record, marked VOID
 *     with its reason (decision in src/app/api/fssai/pest/_pest/files.ts).
 * Each tab therefore shows what the SERVER said this person may do
 * (`can_record` / `can_close` / `can_configure`), and a button a person cannot
 * press is replaced by the reason rather than hidden — a hidden button reads as
 * a broken screen.
 *
 * ── WHAT IT DELIBERATELY DOES NOT CLAIM ─────────────────────────────────────
 * It does not own the schedule. Pest Control already exists as a maintenance
 * schedule in the Task Manager and §7 Q2 is unruled, so this screen links to it
 * and says so, rather than quietly becoming a second scheduler nobody updates.
 * `next_due_date` is this register's forward note, nothing more.
 *
 * ── HOUSE IDIOM (RECON §1.3-1.6) ────────────────────────────────────────────
 * #FFF8F0 page, #af4408 heading with an icon tile, white cards bordered
 * #E8D5C4, cards under md and a table from md up, per-page toast, native
 * <input type="date">. ⚠️ globals.css:279-283 force-wraps any `.flex.gap-2|3|4`,
 * so a row that must keep its icon beside its text carries `flex-nowrap`; and a
 * modal overlay MUST use a `bg-black/NN` class or globals.css:295 will not lock
 * the page scroll behind it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, Bug, CalendarClock, Camera, Check, ClipboardCheck, Info, Loader2,
  MapPin, Plus, Printer, RefreshCw, Search, ShieldAlert, Truck, Wrench, X,
} from 'lucide-react';
import { apiJson } from '@/lib/api';
import { fmtIST, fmtISTDate } from '@/lib/format-date';
import ImageUpload, { ImageThumb } from '@/app/tasks/_components/ImageUpload';
import {
  FSSAI_PEST_TYPES, FSSAI_PEST_EVIDENCE_KINDS, FSSAI_PEST_SEVERITIES,
  FSSAI_PEST_SERVICE_KINDS, FSSAI_PEST_SERVICE_STATUSES, FSSAI_PEST_DEVICE_KINDS,
  fssaiToday,
} from '@/lib/fssai';
import type { PestChemicalsVisit } from '@/app/api/fssai/pest/_pest/monitoring';
import {
  errMsg, INPUT, BTN_PRIMARY, BTN_PLAIN, BTN_DANGER, CARD, LABEL, REQ,
  Badge, Modal, Files, Tile, Field, Para, RaiseCaForm, PrintOverlay, askReason, type FileRow,
} from './_components/pest-ui';
import { ChemicalsEditor, ChemicalsTable, chemBody, emptyChemValue, type ChemRow, type ChemValue } from './_components/Chemicals';
import { ChemicalsRegisterPrint, VisitRecordPrint } from './_components/PestPrints';
import MonitoringTab from './_components/MonitoringTab';

/* ── shapes the API returns ────────────────────────────────────────────────── */

interface CaLink {
  id: string; ca_number: string; status: string; due_date: string;
  owner_email: string; severity: string;
}
interface Service {
  id: string; service_no: string; vendor_id: string; vendor_name: string;
  vendor_name_at_record: string; vendor_renamed_since: boolean;
  agency_licence_no: string; technician_name: string;
  service_kind: string; service_kind_label: string; business_date: string;
  started_at: string; finished_at: string; areas_covered: string;
  chemicals: ChemRow[]; chemicals_state: string; chemicals_none_note: string; can_record_chemicals: boolean;
  findings: string; recommendations: string;
  report_no: string; document_id: string; document_title: string;
  contract_doc_id: string; contract_doc_title: string;
  next_due_date: string; staff_witness: string;
  status: string; status_label: string; status_color: string; missed_reason: string;
  ca_id: string; ca: CaLink | null; note: string;
  voided_at: string; voided_by: string; void_reason: string;
  created_by: string; created_at: string; updated_at: string;
  is_editable: boolean; files: FileRow[]; active_file_count: number; file_limit: number;
}
interface Sighting {
  id: string; business_date: string; sighted_at: string;
  pest_type: string; pest_type_label: string;
  evidence_kind: string; evidence_kind_label: string;
  count_seen: number | null;
  severity: string; severity_label: string; severity_color: string;
  location_label: string; department_id: string; department_name: string;
  device_id: string; device: { id: string; code: string; kind: string; location_label: string } | null;
  service_id: string; service: { id: string; service_no: string; business_date: string; status: string } | null;
  description: string; immediate_action: string;
  ca_id: string; ca: CaLink | null;
  status: string; status_label: string; status_color: string;
  reported_by: string; reported_name: string; closed_at: string; closed_by: string;
  voided_at: string; void_reason: string; created_at: string;
  is_open: boolean; files: FileRow[]; active_file_count: number; file_limit: number;
}
interface Device {
  id: string; code: string; device_kind: string; device_kind_label: string;
  location_label: string; department_id: string; department_name: string;
  store_id: string; store_name: string; installed_on: string;
  vendor_id: string; vendor_name: string; check_frequency: string;
  last_checked_at: string; notes: string; is_active: boolean; sort_order: number;
  sighting_count: number; last_sighting_date: string;
  /** Where the station stands on the monitoring sheet; null for a retired one. */
  sheet: { state: string; state_label: string; state_color: string; last_check_date: string; last_check_time: string; due_on: string } | null;
}

/* ── what each call returns ────────────────────────────────────────────────── */

interface SightingCounts { open: number; closed: number; infestation: number; last_30_days: number; void: number; all: number }
interface ServiceCounts { planned: number; completed: number; missed: number; cancelled: number; void: number; due: number; all: number }
/** A sighting as the VISIT detail lists it — a summary, not the whole row. */
interface LinkedSighting {
  id: string; business_date: string; sighted_at: string; pest_type: string;
  evidence_kind: string; severity: string; location_label: string;
  description: string; status: string; reported_by: string; reported_name: string; voided_at: string;
}
interface SightingListResponse {
  sightings: Sighting[]; counts: SightingCounts; can_close: boolean; me: string; truncated: boolean;
}
interface SightingOneResponse { sighting: Sighting; can_amend: boolean; can_void: boolean; can_void_files?: boolean }
interface SightingSaveResponse { sighting?: Sighting; advice?: string }
interface ServiceListResponse {
  services: Service[]; counts: ServiceCounts; can_record: boolean; can_void: boolean;
}
interface ServiceOneResponse { service: Service; sightings: LinkedSighting[]; can_void_files?: boolean; me?: string }
interface ServiceSaveResponse { service?: Service; advice?: string; warnings?: string[] }
interface DeviceListResponse { devices: Device[]; counts: { active: number; retired: number; all: number }; can_configure: boolean }
interface ChemRegister {
  from: string; to: string; visits: PestChemicalsVisit[];
  totals: { visits: number; listed: number; none_applied: number; not_recorded: number; products: number };
  problems: string[];
}
interface VendorsResponse { vendors?: { id: string; name: string }[]; rows?: { id: string; name: string }[] }

/* ══════════════════════════════════════════════════════════════════════════ *
 * THE PAGE
 * ══════════════════════════════════════════════════════════════════════════ */

type Tab = 'sightings' | 'checks' | 'visits' | 'map';

export default function FssaiPestControlPage() {
  const [tab, setTab] = useState<Tab>('sightings');
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const say = useCallback((m: string) => {
    setToast(m);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 5200);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">

        <div className="flex flex-wrap items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#af4408] text-white flex items-center justify-center shrink-0">
            <Bug size={20} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408]">Pest Control Logs</h1>
            <p className="text-xs text-[#8B7355]">
              What your own staff saw, the station-by-station monitoring sheet, what the contractor did and applied, and
              where the monitoring points are.
            </p>
          </div>
        </div>

        {/* The tab strip. Sightings first and selected first: it is the one every
            member of staff needs and the one that is used most often. */}
        <div className="flex flex-wrap gap-2">
          {([
            { key: 'sightings', label: 'Sightings', icon: ShieldAlert },
            { key: 'checks', label: 'Station checks', icon: ClipboardCheck },
            { key: 'visits', label: 'Contractor visits', icon: Truck },
            { key: 'map', label: 'Monitoring points', icon: MapPin },
          ] as { key: Tab; label: string; icon: typeof Bug }[]).map((t) => {
            const on = tab === t.key;
            const Icon = t.icon;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                aria-current={on ? 'page' : undefined}
                className={`inline-flex flex-nowrap items-center gap-1.5 text-sm font-semibold rounded-lg px-3 py-2 border ${
                  on ? 'bg-[#af4408] text-white border-[#af4408]' : 'bg-white text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3]'
                }`}
              >
                <Icon size={15} /> {t.label}
              </button>
            );
          })}
        </div>

        {tab === 'sightings' && <SightingsTab say={say} />}
        {tab === 'checks' && <MonitoringTab say={say} />}
        {tab === 'visits' && <VisitsTab say={say} />}
        {tab === 'map' && <MapTab say={say} />}

        {/* The one thing this screen must not imply it owns. */}
        <div className={`${CARD} p-4 text-xs text-[#6B5744] space-y-1`}>
          <p className="flex flex-nowrap items-start gap-2">
            <Info size={14} className="mt-0.5 shrink-0 text-[#af4408]" />
            <span>
              <strong>This register does not run the schedule.</strong> Pest Control already exists as a recurring job in{' '}
              <a href="/tasks/maintenance" className="text-[#af4408] underline">Maintenance</a>, and whether the two
              become one screen is the owner&apos;s decision, not ours. &ldquo;Next visit due&rdquo; below is this
              register&apos;s own forward note — nothing here creates or changes a maintenance job.
            </span>
          </p>
          <p className="flex flex-nowrap items-start gap-2">
            <CalendarClock size={14} className="mt-0.5 shrink-0 text-[#af4408]" />
            <span>
              Nothing wakes the system up to tell you a visit is due. The overdue count below is computed when you open
              this screen; a reminder that reaches a phone on its own is a later phase.
            </span>
          </p>
        </div>
      </div>

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[120] max-w-[92vw] bg-[#2D1B0E] text-white text-sm px-4 py-2.5 rounded-lg shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════ *
 * TAB 1 — SIGHTINGS. Open to everyone. The reason the register is credible.
 * ══════════════════════════════════════════════════════════════════════════ */

function SightingsTab({ say }: { say: (m: string) => void }) {
  const [rows, setRows] = useState<Sighting[]>([]);
  const [counts, setCounts] = useState<SightingCounts>({ open: 0, closed: 0, infestation: 0, last_30_days: 0, void: 0, all: 0 });
  const [canClose, setCanClose] = useState(false);
  const [me, setMe] = useState('');
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [err, setErr] = useState('');
  const [truncated, setTruncated] = useState(false);

  const [onlyOpen, setOnlyOpen] = useState(true);
  const [q, setQ] = useState('');
  const [pestType, setPestType] = useState('');

  const [newOpen, setNewOpen] = useState(false);
  const [detail, setDetail] = useState<Sighting | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const sp = new URLSearchParams();
      if (onlyOpen) sp.set('open', '1');
      if (q.trim()) sp.set('q', q.trim());
      if (pestType) sp.set('pest_type', pestType);
      const j = await apiJson<SightingListResponse>(`/api/fssai/pest/sightings?${sp.toString()}`);
      setRows(j.sightings || []);
      setCounts(j.counts || counts);
      setCanClose(!!j.can_close);
      setMe(String(j.me || ''));
      setTruncated(!!j.truncated);
    } catch (e: unknown) {
      if (errMsg(e, '').includes('Sign in')) setForbidden(true);
      else setErr(errMsg(e, 'Could not load the sightings'));
    } finally { setLoading(false); }
    // `counts` is read only as a fallback shape; re-running on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onlyOpen, q, pestType]);

  useEffect(() => { load(); }, [load]);

  if (forbidden) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
        🔒 Sign in to report or read a sighting.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* THE PRIMARY ACTION, FIRST, BIG, AND ON EVERY PHONE. A porter has one job
          on this screen and this is it. */}
      <div className={`${CARD} p-4 flex flex-wrap items-center gap-3`}>
        <button onClick={() => setNewOpen(true)} className={`${BTN_PRIMARY} !px-4 !py-3 text-base w-full sm:w-auto justify-center`}>
          <Plus size={18} /> Report a sighting
        </button>
        <p className="text-xs text-[#6B5744] min-w-0 flex-1">
          Anyone can file one, from anywhere, at any hour — droppings and gnaw marks count as much as a live pest.
          A photograph is worth more than a paragraph.
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Tile n={counts.open} label="Still open" tone={counts.open > 0 ? 'warn' : 'plain'} />
        <Tile n={counts.infestation} label="Marked infestation" tone={counts.infestation > 0 ? 'bad' : 'plain'} />
        <Tile n={counts.last_30_days} label="Last 30 days" />
        <Tile n={counts.closed} label="Closed" tone="good" />
      </div>

      <div className={`${CARD} p-3 flex flex-wrap items-end gap-3`}>
        <label className="min-w-0 flex-1">
          <span className={LABEL}>Search</span>
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8B7355]" />
            <input
              value={q} onChange={(e) => setQ(e.target.value)} placeholder="place, description, who reported it"
              className={`${INPUT} !pl-8`}
            />
          </div>
        </label>
        <label>
          <span className={LABEL}>What was seen</span>
          <select value={pestType} onChange={(e) => setPestType(e.target.value)} className={INPUT}>
            <option value="">Anything</option>
            {FSSAI_PEST_TYPES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </label>
        <label className="inline-flex flex-nowrap items-center gap-2 text-sm pb-2">
          <input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} className="w-4 h-4 accent-[#af4408]" />
          Only still open
        </label>
        <button onClick={load} disabled={loading} className={BTN_PLAIN}>
          {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Refresh
        </button>
      </div>

      {err && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">{err}</div>}
      {truncated && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900">
          Showing the most recent 300. Narrow the search to see older ones.
        </div>
      )}

      <div className={`${CARD} overflow-hidden`}>
        {loading ? (
          <div className="p-10 text-center text-sm text-[#8B7355]">
            <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" /> Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm font-semibold">Nothing reported{onlyOpen ? ' and still open' : ''}</p>
            <p className="text-xs text-[#8B7355] mt-1">
              An empty sightings log is read as &ldquo;nobody was watching&rdquo;, not as &ldquo;no pests&rdquo;. It is
              worth filing the small things.
            </p>
          </div>
        ) : (
          <>
            <div className="md:hidden divide-y divide-[#E8D5C4]">
              {rows.map((r) => (
                <button key={r.id} onClick={() => setDetail(r)} className="w-full text-left p-4 hover:bg-[#FFF8F0]">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="font-semibold text-sm min-w-0">{r.pest_type_label}{r.evidence_kind ? ` — ${r.evidence_kind_label}` : ''}</p>
                    <Badge label={r.severity_label} color={r.severity_color} />
                  </div>
                  <p className="text-xs text-[#6B5744] mt-1">{r.location_label}{r.device ? ` · station ${r.device.code}` : ''}</p>
                  <p className="text-[11px] text-[#8B7355] mt-1">
                    {fmtISTDate(r.business_date)} · {r.reported_name || r.reported_by}
                    {r.count_seen !== null ? ` · ${r.count_seen} seen` : ''}
                  </p>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    <Badge label={r.status_label} color={r.status_color} />
                    {r.ca && <Badge label={`Action ${r.ca.ca_number}`} color="bg-blue-100 text-blue-700 border-blue-200" />}
                    {r.active_file_count > 0 && <Badge label={`${r.active_file_count} photo`} color="bg-slate-100 text-slate-600 border-slate-200" />}
                  </div>
                </button>
              ))}
            </div>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-[#FFF1E3] text-[#6B5744]">
                  <tr>
                    <th className="text-left font-semibold px-3 py-2">Date</th>
                    <th className="text-left font-semibold px-3 py-2">What was seen</th>
                    <th className="text-left font-semibold px-3 py-2">Where</th>
                    <th className="text-left font-semibold px-3 py-2">Severity</th>
                    <th className="text-left font-semibold px-3 py-2">Reported by</th>
                    <th className="text-left font-semibold px-3 py-2">State</th>
                    <th className="text-right font-semibold px-3 py-2">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E8D5C4]">
                  {rows.map((r) => (
                    <tr key={r.id} className="hover:bg-[#FFF8F0] cursor-pointer" onClick={() => setDetail(r)}>
                      <td className="px-3 py-2 whitespace-nowrap">{fmtISTDate(r.business_date)}</td>
                      <td className="px-3 py-2">
                        {r.pest_type_label}
                        {r.evidence_kind && <span className="text-[#8B7355]"> — {r.evidence_kind_label}</span>}
                        {r.count_seen !== null && <span className="text-[#8B7355]"> ({r.count_seen})</span>}
                      </td>
                      <td className="px-3 py-2">{r.location_label}{r.device ? <span className="text-[#8B7355]"> · {r.device.code}</span> : null}</td>
                      <td className="px-3 py-2"><Badge label={r.severity_label} color={r.severity_color} /></td>
                      <td className="px-3 py-2 text-[#6B5744]">{r.reported_name || r.reported_by}</td>
                      <td className="px-3 py-2"><Badge label={r.status_label} color={r.status_color} /></td>
                      <td className="px-3 py-2 text-right">
                        {r.ca ? <span className="text-xs text-[#af4408]">{r.ca.ca_number}</span> : <span className="text-xs text-[#8B7355]">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {newOpen && (
        <NewSightingModal
          onClose={() => setNewOpen(false)}
          onSaved={(msg) => { setNewOpen(false); say(msg); load(); }}
          say={say}
        />
      )}
      {detail && (
        <SightingDetail
          id={detail.id}
          me={me}
          canClose={canClose}
          onClose={() => setDetail(null)}
          onChanged={() => load()}
          say={say}
        />
      )}
    </div>
  );
}

function NewSightingModal({
  onClose, onSaved, say,
}: { onClose: () => void; onSaved: (m: string) => void; say: (m: string) => void }) {
  const [pestType, setPestType] = useState('');
  const [evidenceKind, setEvidenceKind] = useState('');
  const [severity, setSeverity] = useState('low');
  const [location, setLocation] = useState('');
  const [countSeen, setCountSeen] = useState('');
  const [businessDate, setBusinessDate] = useState(fssaiToday());
  const [deviceId, setDeviceId] = useState('');
  const [description, setDescription] = useState('');
  const [immediate, setImmediate] = useState('');
  const [devices, setDevices] = useState<Device[]>([]);
  const [photo, setPhoto] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    // Reading the pest map is open to everyone precisely so this list can exist
    // on a porter's phone. A failure here must NOT block the form — the station
    // is optional and the sighting is not.
    (async () => {
      try {
        const j = await apiJson<DeviceListResponse>('/api/fssai/pest/devices?active=1');
        setDevices(j.devices || []);
      } catch { /* the station dropdown is optional; never block the report */ }
    })();
  }, []);

  async function save() {
    setBusy(true); setErr('');
    try {
      const j = await apiJson<SightingSaveResponse>('/api/fssai/pest/sightings', {
        method: 'POST',
        body: {
          action: 'create', pest_type: pestType, evidence_kind: evidenceKind, severity,
          location_label: location, count_seen: countSeen === '' ? null : countSeen,
          business_date: businessDate, device_id: deviceId,
          description, immediate_action: immediate,
        },
      });
      const id = String(j?.sighting?.id || '');
      // The photograph is a SECOND request, always, because the server takes one
      // image per call (the 400 KB ceiling exists because production's nginx limit
      // is 1 MB). A failed photo must never lose the sighting, so it is reported
      // separately and the row stands either way.
      if (id && photo) {
        try {
          await apiJson('/api/fssai/pest/sightings', {
            method: 'POST',
            body: { action: 'attach', id, data_uri: photo, kind: 'photo' },
          });
        } catch (e: unknown) {
          onSaved('Sighting filed. The photograph did not attach — open the sighting and try again.');
          say(errMsg(e, 'The photograph did not attach.'));
          return;
        }
      }
      onSaved(j.advice || 'Sighting filed.');
    } catch (e: unknown) {
      setErr(errMsg(e, 'Could not file the sighting'));
    } finally { setBusy(false); }
  }

  return (
    <Modal
      title="Report a sighting"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className={BTN_PLAIN}>Cancel</button>
          <button onClick={save} disabled={busy || !pestType || location.trim().length < 2} className={BTN_PRIMARY}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} File it
          </button>
        </>
      }
    >
      {err && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">{err}</div>}

      <div>
        <span className={LABEL}>What did you see? {REQ}</span>
        {/* Big tap targets and no typing — RECON §6.2/§6.3. This is filled in
            standing up, in a store room, on a phone. */}
        <div className="mt-1 grid grid-cols-2 sm:grid-cols-3 gap-2">
          {FSSAI_PEST_TYPES.map((p) => (
            <button
              key={p.key} type="button" onClick={() => setPestType(p.key)}
              className={`text-sm rounded-lg border px-3 py-2.5 text-left ${
                pestType === p.key ? 'bg-[#af4408] text-white border-[#af4408] font-semibold' : 'bg-white border-[#E8D5C4] hover:bg-[#FFF1E3]'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <span className={LABEL}>What exactly was there?</span>
        <div className="mt-1 grid grid-cols-2 sm:grid-cols-3 gap-2">
          {FSSAI_PEST_EVIDENCE_KINDS.map((k) => (
            <button
              key={k.key} type="button"
              onClick={() => setEvidenceKind(evidenceKind === k.key ? '' : k.key)}
              className={`text-sm rounded-lg border px-3 py-2.5 text-left ${
                evidenceKind === k.key ? 'bg-[#2D1B0E] text-white border-[#2D1B0E] font-semibold' : 'bg-white border-[#E8D5C4] hover:bg-[#FFF1E3]'
              }`}
            >
              {k.label}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-[#8B7355] mt-1">
          Droppings and gnaw marks are what staff actually find, and they count as evidence.
        </p>
      </div>

      <label className="block">
        <span className={LABEL}>Where was it? {REQ}</span>
        <input
          value={location} onChange={(e) => setLocation(e.target.value)}
          placeholder="Behind the dry store racking"
          className={INPUT}
        />
      </label>

      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block">
          <span className={LABEL}>How serious</span>
          <div className="mt-1 flex flex-nowrap gap-2">
            {FSSAI_PEST_SEVERITIES.map((s) => (
              <button
                key={s.key} type="button" onClick={() => setSeverity(s.key)}
                className={`flex-1 text-sm rounded-lg border px-2 py-2.5 ${
                  severity === s.key ? 'bg-[#af4408] text-white border-[#af4408] font-semibold' : 'bg-white border-[#E8D5C4]'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </label>
        <label className="block">
          <span className={LABEL}>How many, if you counted</span>
          <input
            type="number" min={0} inputMode="numeric" value={countSeen}
            onChange={(e) => setCountSeen(e.target.value)} placeholder="leave blank if you did not count"
            className={INPUT}
          />
          <span className="text-[11px] text-[#8B7355]">
            Blank means nobody counted. It is not the same as none, and the register keeps the difference.
          </span>
        </label>
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block">
          <span className={LABEL}>Date</span>
          <input type="date" max={fssaiToday()} value={businessDate} onChange={(e) => setBusinessDate(e.target.value)} className={INPUT} />
        </label>
        <label className="block">
          <span className={LABEL}>Found in a station?</span>
          <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} className={INPUT}>
            <option value="">Not in a station</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>{d.code ? `${d.code} — ` : ''}{d.location_label}</option>
            ))}
          </select>
        </label>
      </div>

      <label className="block">
        <span className={LABEL}>Anything else worth saying</span>
        <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} className={INPUT} />
      </label>

      <label className="block">
        <span className={LABEL}>What you did about it there and then</span>
        <textarea
          rows={2} value={immediate} onChange={(e) => setImmediate(e.target.value)}
          placeholder="Cleaned the area and moved the sacks off the floor"
          className={INPUT}
        />
      </label>

      <div>
        <span className={LABEL}>Photograph</span>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {photo ? <ImageThumb src={photo} size={64} onRemove={() => setPhoto('')} /> : null}
          {!photo && <ImageUpload value={[]} onAdd={(u) => setPhoto(u)} label="Take a photo" thumbSize={64} />}
        </div>
        <p className="text-[11px] text-[#8B7355] mt-1 flex flex-nowrap items-start gap-1">
          <Camera size={12} className="mt-0.5 shrink-0" />
          <span>Shrunk on this phone before it is sent. One picture is worth more here than any amount of description.</span>
        </p>
      </div>
    </Modal>
  );
}

function SightingDetail({
  id, me, canClose, onClose, onChanged, say,
}: {
  id: string; me: string; canClose: boolean;
  onClose: () => void; onChanged: () => void; say: (m: string) => void;
}) {
  const [row, setRow] = useState<Sighting | null>(null);
  const [canAmend, setCanAmend] = useState(false);
  const [canVoid, setCanVoid] = useState(false);
  const [canVoidFiles, setCanVoidFiles] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [raise, setRaise] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const j = await apiJson<SightingOneResponse>(`/api/fssai/pest/sightings?id=${encodeURIComponent(id)}`);
      setRow(j.sighting); setCanAmend(!!j.can_amend); setCanVoid(!!j.can_void); setCanVoidFiles(!!j.can_void_files);
    } catch (e: unknown) { setErr(errMsg(e, 'Could not load the sighting')); }
    finally { setLoading(false); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function post(body: Record<string, unknown>, ok: string) {
    setBusy(true); setErr('');
    try {
      await apiJson('/api/fssai/pest/sightings', { method: 'POST', body: { ...body, id } });
      say(ok); await load(); onChanged();
    } catch (e: unknown) { setErr(errMsg(e, 'That did not work')); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={row ? `${row.pest_type_label} — ${row.location_label}` : 'Sighting'} onClose={onClose} wide>
      {loading ? (
        <div className="p-6 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin mx-auto" /></div>
      ) : !row ? (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">{err || 'Not found'}</div>
      ) : (
        <>
          {err && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">{err}</div>}

          <div className="flex flex-wrap gap-1.5">
            <Badge label={row.status_label} color={row.status_color} />
            <Badge label={row.severity_label} color={row.severity_color} />
            {row.evidence_kind && <Badge label={row.evidence_kind_label} color="bg-slate-100 text-slate-600 border-slate-200" />}
            {row.device && <Badge label={`Station ${row.device.code}`} color="bg-slate-100 text-slate-600 border-slate-200" />}
          </div>

          {row.voided_at && (
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm">
              <p className="font-semibold">This sighting was voided.</p>
              <p className="text-xs text-[#6B5744] mt-0.5">
                {row.void_reason} — {fmtIST(row.voided_at)}. The row stays, because a compliance record is never deleted.
              </p>
            </div>
          )}

          <dl className="grid sm:grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <Field k="Date" v={fmtISTDate(row.business_date)} />
            <Field k="Seen at" v={row.sighted_at ? fmtIST(row.sighted_at) : 'not recorded'} />
            <Field k="Reported by" v={row.reported_name || row.reported_by} />
            <Field k="How many" v={row.count_seen === null ? 'not counted' : String(row.count_seen)} />
            <Field k="Department" v={row.department_name || '—'} />
            <Field k="Closed" v={row.closed_at ? `${fmtIST(row.closed_at)} by ${row.closed_by}` : 'still open'} />
          </dl>

          {row.description && <Para k="What was reported" v={row.description} />}
          {row.immediate_action && <Para k="Done at the time" v={row.immediate_action} />}

          {row.ca && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm">
              <p className="font-semibold flex flex-nowrap items-center gap-1.5">
                <Wrench size={14} /> Corrective action {row.ca.ca_number}
              </p>
              <p className="text-xs text-blue-900 mt-0.5">
                {row.ca.status} · due {row.ca.due_date || '—'} · {row.ca.owner_email || 'nobody assigned'}
              </p>
              <a href="/fssai/corrective-actions" className="text-xs underline text-blue-800 mt-1 inline-block">
                Open Corrective Actions
              </a>
            </div>
          )}

          <div>
            <p className={`${LABEL} mb-1`}>Photographs</p>
            <Files
              files={row.files} limit={row.file_limit} canAdd={canAmend} canVoid={canVoidFiles && !row.voided_at} busy={busy}
              onAdd={(uri) => post({ action: 'attach', data_uri: uri, kind: 'photo' }, 'Photograph attached.')}
              onVoid={(fid) => {
                const reason = askReason('Voiding a photograph does NOT remove it: it stays on this sighting, marked VOID, with your reason.\n\nWhy is this photograph being voided?', say);
                if (reason) post({ action: 'void_file', attachment_id: fid, reason }, 'Photograph voided — it stays on the record, marked, with your reason.');
              }}
            />
          </div>

          <div className="flex flex-wrap gap-2 pt-2 border-t border-[#E8D5C4]">
            {canClose && !row.voided_at && !row.closed_at && (
              <button
                disabled={busy}
                onClick={() => {
                  const note = window.prompt('Closing this sighting. What finally dealt with it?') || '';
                  post({ action: 'close', note }, 'Sighting closed.');
                }}
                className={BTN_PLAIN}
              >
                <Check size={15} /> Close it
              </button>
            )}
            {canClose && !row.voided_at && row.closed_at && (
              <button
                disabled={busy}
                onClick={() => {
                  const reason = window.prompt('Why is this being reopened?') || '';
                  if (reason.trim().length < 4) { say('A reason of at least four characters is needed.'); return; }
                  post({ action: 'reopen', reason }, 'Sighting reopened.');
                }}
                className={BTN_PLAIN}
              >
                <RefreshCw size={15} /> Reopen
              </button>
            )}
            {canClose && !row.voided_at && !row.ca_id && (
              <button disabled={busy} onClick={() => setRaise(true)} className={BTN_PRIMARY}>
                <Wrench size={15} /> Raise a corrective action
              </button>
            )}
            {canVoid && !row.voided_at && (
              <button
                disabled={busy}
                onClick={() => {
                  const reason = window.prompt(
                    'Voiding is for a sighting entered IN ERROR, not for one that has been dealt with — use "Close it" for that.\n\nWhy is this being voided?',
                  ) || '';
                  if (reason.trim().length < 4) { say('A reason of at least four characters is needed.'); return; }
                  post({ action: 'void', reason }, 'Sighting voided; the row stays with its reason.');
                }}
                className="inline-flex flex-nowrap items-center gap-1.5 text-sm border border-red-200 text-red-700 bg-white rounded-lg px-3 py-2 hover:bg-red-50 disabled:opacity-50"
              >
                <AlertTriangle size={15} /> Void it
              </button>
            )}
            {row.reported_by.toLowerCase() === me.toLowerCase() && !canVoid && (
              <p className="text-xs text-[#8B7355] self-center">
                You reported this, so somebody else closes or cancels it.
              </p>
            )}
          </div>

          {raise && (
            <RaiseCaForm
              busy={busy}
              defaultSeverity={row.severity === 'high' ? 'urgent' : 'high'}
              defaultTitle={`${row.pest_type_label} — ${row.location_label}`}
              onCancel={() => setRaise(false)}
              onSubmit={async (p) => { setRaise(false); await post({ action: 'raise_ca', ...p }, 'Corrective action raised.'); }}
            />
          )}
        </>
      )}
    </Modal>
  );
}

/* ══════════════════════════════════════════════════════════════════════════ *
 * TAB 2 — CONTRACTOR VISITS. Management. 'Missed' is the row that matters.
 * ══════════════════════════════════════════════════════════════════════════ */

function VisitsTab({ say }: { say: (m: string) => void }) {
  const [rows, setRows] = useState<Service[]>([]);
  const [counts, setCounts] = useState<ServiceCounts>({ planned: 0, completed: 0, missed: 0, cancelled: 0, void: 0, due: 0, all: 0 });
  const [canRecord, setCanRecord] = useState(false);
  const [canVoid, setCanVoid] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const [detailId, setDetailId] = useState('');
  const [regFrom, setRegFrom] = useState(() => {
    const [y, m, d] = fssaiToday().split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d - 92)).toISOString().slice(0, 10);
  });
  const [register, setRegister] = useState<ChemRegister | null>(null);
  const [regBusy, setRegBusy] = useState(false);

  async function openRegister() {
    setRegBusy(true);
    try {
      const j = await apiJson<ChemRegister>(`/api/fssai/pest/checks?chemicals=1&from=${regFrom}&to=${fssaiToday()}`);
      setRegister(j);
    } catch (e: unknown) { say(errMsg(e, 'Could not load the chemicals register')); }
    finally { setRegBusy(false); }
  }

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const sp = new URLSearchParams();
      if (status) sp.set('status', status);
      if (q.trim()) sp.set('q', q.trim());
      const j = await apiJson<ServiceListResponse>(`/api/fssai/pest/services?${sp.toString()}`);
      setRows(j.services || []);
      setCounts(j.counts || counts);
      setCanRecord(!!j.can_record); setCanVoid(!!j.can_void);
    } catch (e: unknown) { setErr(errMsg(e, 'Could not load the visits')); }
    finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, q]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      {counts.due > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-900 flex flex-nowrap items-start gap-2">
          <CalendarClock size={15} className="mt-0.5 shrink-0" />
          <span>
            <strong>{counts.due}</strong> visit{counts.due === 1 ? '' : 's'} recorded a next-due date that has now
            passed. A contract visit that did not happen is the commonest pest-control finding there is — record it as
            missed, with the reason, rather than leaving it planned.
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Tile n={counts.planned} label="Planned" />
        <Tile n={counts.completed} label="Completed" tone="good" />
        <Tile n={counts.missed} label="Missed" tone={counts.missed > 0 ? 'bad' : 'plain'} />
        <Tile n={counts.due} label="Next visit overdue" tone={counts.due > 0 ? 'warn' : 'plain'} />
      </div>

      <div className={`${CARD} p-3 flex flex-wrap items-end gap-3`}>
        <label className="min-w-0 flex-1">
          <span className={LABEL}>Search</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="agency, technician, area, findings" className={INPUT} />
        </label>
        <label>
          <span className={LABEL}>State</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={INPUT}>
            <option value="">All</option>
            {FSSAI_PEST_SERVICE_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            <option value="void">Voided</option>
          </select>
        </label>
        <button onClick={load} disabled={loading} className={BTN_PLAIN}>
          {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Refresh
        </button>
        {canRecord ? (
          <button onClick={() => setNewOpen(true)} className={BTN_PRIMARY}><Plus size={15} /> Record a visit</button>
        ) : (
          <p className="text-xs text-[#8B7355] pb-2">
            Recording a contractor&apos;s visit is a manager&apos;s job. You can still report a sighting.
          </p>
        )}
      </div>

      {/* #78 — what was applied, visit by visit, on paper. */}
      <div className={`${CARD} p-3 flex flex-wrap items-end gap-3`}>
        <p className="text-xs text-[#6B5744] min-w-0 flex-1">
          <strong>Chemicals register</strong> — every completed visit with the products applied, their CIB&amp;RC
          registration, batch, dilution and where they went down. A visit that does not say is printed as NOT RECORDED.
        </p>
        <label>
          <span className={LABEL}>From</span>
          <input type="date" value={regFrom} max={fssaiToday()} onChange={(e) => setRegFrom(e.target.value)} className={INPUT} />
        </label>
        <button onClick={openRegister} disabled={regBusy} className={BTN_PLAIN}>
          {regBusy ? <Loader2 size={15} className="animate-spin" /> : <Printer size={15} />} Print the chemicals register
        </button>
      </div>

      {err && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">{err}</div>}

      <div className={`${CARD} overflow-hidden`}>
        {loading ? (
          <div className="p-10 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" /> Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm font-semibold">No visits recorded yet</p>
            <p className="text-xs text-[#8B7355] mt-1">
              Record the contract visits as they happen, and the missed ones as they are missed. Both belong in the file.
            </p>
          </div>
        ) : (
          <>
            <div className="md:hidden divide-y divide-[#E8D5C4]">
              {rows.map((r) => (
                <button key={r.id} onClick={() => setDetailId(r.id)} className="w-full text-left p-4 hover:bg-[#FFF8F0]">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="font-semibold text-sm min-w-0">{r.vendor_name || '(agency not named)'}</p>
                    <Badge label={r.status_label} color={r.status_color} />
                  </div>
                  <p className="text-xs text-[#6B5744] mt-1">{r.service_no} · {r.service_kind_label}</p>
                  <p className="text-[11px] text-[#8B7355] mt-1">
                    {fmtISTDate(r.business_date)}{r.next_due_date ? ` · next due ${fmtISTDate(r.next_due_date)}` : ''}
                  </p>
                  {r.status === 'missed' && r.missed_reason && (
                    <p className="text-[11px] text-red-700 mt-1">Missed: {r.missed_reason}</p>
                  )}
                </button>
              ))}
            </div>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-[#FFF1E3] text-[#6B5744]">
                  <tr>
                    <th className="text-left font-semibold px-3 py-2">Visit</th>
                    <th className="text-left font-semibold px-3 py-2">Date</th>
                    <th className="text-left font-semibold px-3 py-2">Agency</th>
                    <th className="text-left font-semibold px-3 py-2">Kind</th>
                    <th className="text-left font-semibold px-3 py-2">State</th>
                    <th className="text-left font-semibold px-3 py-2">Next due</th>
                    <th className="text-right font-semibold px-3 py-2">Files</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E8D5C4]">
                  {rows.map((r) => {
                    const overdue = !!r.next_due_date && r.next_due_date <= fssaiToday() && !r.voided_at;
                    return (
                      <tr key={r.id} className="hover:bg-[#FFF8F0] cursor-pointer" onClick={() => setDetailId(r.id)}>
                        <td className="px-3 py-2 whitespace-nowrap font-medium">{r.service_no}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{fmtISTDate(r.business_date)}</td>
                        <td className="px-3 py-2">{r.vendor_name || <span className="text-[#8B7355]">not named</span>}</td>
                        <td className="px-3 py-2 text-[#6B5744]">{r.service_kind_label}</td>
                        <td className="px-3 py-2"><Badge label={r.status_label} color={r.status_color} /></td>
                        {/* Overdue is RED TEXT on the date cell, never a new badge
                            colour — the house treatment (RECON §1.5). */}
                        <td className={`px-3 py-2 whitespace-nowrap ${overdue ? 'text-red-700 font-semibold' : 'text-[#6B5744]'}`}>
                          {r.next_due_date ? fmtISTDate(r.next_due_date) : '—'}
                        </td>
                        <td className="px-3 py-2 text-right text-[#6B5744]">{r.files.length || '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {newOpen && (
        <NewVisitModal onClose={() => setNewOpen(false)} onSaved={(m) => { setNewOpen(false); say(m); load(); }} />
      )}
      {detailId && (
        <VisitDetail
          id={detailId} canRecord={canRecord} canVoid={canVoid}
          onClose={() => setDetailId('')} onChanged={load} say={say}
        />
      )}
      {register && (
        <PrintOverlay title="Pest-control chemicals register" onClose={() => setRegister(null)} landscape>
          <ChemicalsRegisterPrint data={register} />
        </PrintOverlay>
      )}
    </div>
  );
}

function NewVisitModal({ onClose, onSaved }: { onClose: () => void; onSaved: (m: string) => void }) {
  const [vendors, setVendors] = useState<{ id: string; name: string }[]>([]);
  const [vendorId, setVendorId] = useState('');
  const [vendorName, setVendorName] = useState('');
  const [licence, setLicence] = useState('');
  const [technician, setTechnician] = useState('');
  const [kind, setKind] = useState('scheduled');
  const [businessDate, setBusinessDate] = useState(fssaiToday());
  const [status, setStatus] = useState('completed');
  const [areas, setAreas] = useState('');
  const [findings, setFindings] = useState('');
  const [recommendations, setRecommendations] = useState('');
  const [reportNo, setReportNo] = useState('');
  const [nextDue, setNextDue] = useState('');
  const [missedReason, setMissedReason] = useState('');
  const [chem, setChem] = useState<ChemValue>(emptyChemValue());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      try {
        // vendors is the EXISTING supplier master. FSSAI reads it and never
        // writes it (owner §21 — a new vendor master is a critical defect).
        const j = await apiJson<VendorsResponse>('/api/vendors');
        const list = j.vendors || j.rows || [];
        setVendors(list.map((v) => ({ id: String(v.id), name: String(v.name || '') })).filter((v) => v.name));
      } catch { /* a typed agency name still works; the server accepts either */ }
    })();
  }, []);

  async function save() {
    setBusy(true); setErr('');
    try {
      const j = await apiJson<ServiceSaveResponse>('/api/fssai/pest/services', {
        method: 'POST',
        body: {
          action: 'create', vendor_id: vendorId, vendor_name: vendorId ? '' : vendorName,
          agency_licence_no: licence, technician_name: technician, service_kind: kind,
          business_date: businessDate, status, areas_covered: areas,
          findings, recommendations, report_no: reportNo,
          next_due_date: nextDue, missed_reason: missedReason,
          // What was applied belongs to a visit that HAPPENED; the server refuses
          // it on any other status, so it is only sent for a completed one.
          ...(status === 'completed' ? chemBody(chem) : {}),
        },
      });
      const warn = (j.warnings || []).length ? ` Note: ${(j.warnings || []).join(' ')}` : '';
      onSaved(`Visit ${String(j.service?.service_no || '')} recorded.${j.advice ? ` ${j.advice}` : ''}${warn}`);
    } catch (e: unknown) { setErr(errMsg(e, 'Could not record the visit')); }
    finally { setBusy(false); }
  }

  const future = businessDate > fssaiToday();

  return (
    <Modal
      title="Record a pest control visit"
      onClose={onClose}
      wide
      footer={
        <>
          <button onClick={onClose} className={BTN_PLAIN}>Cancel</button>
          <button
            onClick={save}
            disabled={busy || (!vendorId && vendorName.trim().length < 2) || (status === 'missed' && missedReason.trim().length < 4)}
            className={BTN_PRIMARY}
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Save
          </button>
        </>
      }
    >
      {err && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">{err}</div>}

      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block">
          <span className={LABEL}>Agency {REQ}</span>
          <select value={vendorId} onChange={(e) => setVendorId(e.target.value)} className={INPUT}>
            <option value="">Not in the supplier list — type the name</option>
            {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
          {!vendorId && (
            <input
              value={vendorName} onChange={(e) => setVendorName(e.target.value)}
              placeholder="Agency name" className={INPUT}
            />
          )}
        </label>
        <label className="block">
          <span className={LABEL}>Agency licence number</span>
          <input value={licence} onChange={(e) => setLicence(e.target.value)} className={INPUT} />
          <span className="text-[11px] text-[#8B7355]">An inspector asks for this before anything else.</span>
        </label>
      </div>

      <div className="grid sm:grid-cols-3 gap-3">
        <label className="block">
          <span className={LABEL}>Date {REQ}</span>
          <input type="date" value={businessDate} onChange={(e) => setBusinessDate(e.target.value)} className={INPUT} />
        </label>
        <label className="block">
          <span className={LABEL}>Kind of visit</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)} className={INPUT}>
            {FSSAI_PEST_SERVICE_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
        </label>
        <label className="block">
          <span className={LABEL}>What happened</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={INPUT}>
            {FSSAI_PEST_SERVICE_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </label>
      </div>

      {future && status !== 'planned' && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900">
          {businessDate} has not happened yet, so this can only be saved as <strong>Planned</strong>.
        </div>
      )}

      {status === 'missed' && (
        <label className="block">
          <span className={LABEL}>Why did it not happen? {REQ}</span>
          <textarea
            rows={2} value={missedReason} onChange={(e) => setMissedReason(e.target.value)}
            placeholder="Technician did not arrive; agency rescheduled to the 14th"
            className={INPUT}
          />
          <span className="text-[11px] text-[#8B7355]">
            This sentence is the one an inspector actually reads. Four characters minimum, and a real reason is worth more.
          </span>
        </label>
      )}

      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block">
          <span className={LABEL}>Technician</span>
          <input value={technician} onChange={(e) => setTechnician(e.target.value)} className={INPUT} />
        </label>
        <label className="block">
          <span className={LABEL}>Report number</span>
          <input value={reportNo} onChange={(e) => setReportNo(e.target.value)} className={INPUT} />
        </label>
      </div>

      <label className="block">
        <span className={LABEL}>Areas covered</span>
        <textarea rows={2} value={areas} onChange={(e) => setAreas(e.target.value)} placeholder="Kitchen, dry store, bar back, bin area" className={INPUT} />
      </label>
      <label className="block">
        <span className={LABEL}>What they found</span>
        <textarea rows={2} value={findings} onChange={(e) => setFindings(e.target.value)} className={INPUT} />
      </label>
      <label className="block">
        <span className={LABEL}>What they recommended</span>
        <textarea rows={2} value={recommendations} onChange={(e) => setRecommendations(e.target.value)} className={INPUT} />
      </label>
      <label className="block">
        <span className={LABEL}>Next visit due</span>
        <input type="date" value={nextDue} onChange={(e) => setNextDue(e.target.value)} className={INPUT} />
        <span className="text-[11px] text-[#8B7355]">
          This register&apos;s own forward note. It does not create a job in Maintenance and nothing will chase it for you yet.
        </span>
      </label>

      {status === 'completed' && (
        <div className="border-t border-[#E8D5C4] pt-3">
          <p className="text-sm font-semibold mb-2">What was applied</p>
          <ChemicalsEditor value={chem} onChange={setChem} />
        </div>
      )}

      <p className="text-[11px] text-[#6B5744]">
        The job sheet itself is attached after saving — one file at a time, so a large scan can never lose the record.
      </p>
    </Modal>
  );
}

function VisitDetail({
  id, canRecord, canVoid, onClose, onChanged, say,
}: {
  id: string; canRecord: boolean; canVoid: boolean;
  onClose: () => void; onChanged: () => void; say: (m: string) => void;
}) {
  const [row, setRow] = useState<Service | null>(null);
  const [sightings, setSightings] = useState<LinkedSighting[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [raise, setRaise] = useState(false);
  const [canVoidFiles, setCanVoidFiles] = useState(false);
  /** 'complete' = the visit happened (with what was applied); 'chem' = fill a list nobody recorded. */
  const [form, setForm] = useState<'' | 'complete' | 'chem'>('');
  const [printOpen, setPrintOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const j = await apiJson<ServiceOneResponse>(`/api/fssai/pest/services?id=${encodeURIComponent(id)}`);
      setRow(j.service); setSightings(j.sightings || []); setCanVoidFiles(!!j.can_void_files);
    } catch (e: unknown) { setErr(errMsg(e, 'Could not load the visit')); }
    finally { setLoading(false); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function post(body: Record<string, unknown>, ok: string): Promise<boolean> {
    setBusy(true); setErr('');
    try {
      const j = await apiJson<ServiceSaveResponse>('/api/fssai/pest/services', { method: 'POST', body: { ...body, id } });
      const warn = (j.warnings || []).length ? ` Note: ${(j.warnings || []).join(' ')}` : '';
      say(`${j.advice || ok}${warn}`); await load(); onChanged();
      return true;
    } catch (e: unknown) { setErr(errMsg(e, 'That did not work')); return false; }
    finally { setBusy(false); }
  }

  return (
    <Modal title={row ? `${row.service_no} — ${row.vendor_name || 'agency not named'}` : 'Visit'} onClose={onClose} wide>
      {loading ? (
        <div className="p-6 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin mx-auto" /></div>
      ) : !row ? (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">{err || 'Not found'}</div>
      ) : (
        <>
          {err && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">{err}</div>}

          <div className="flex flex-wrap gap-1.5">
            <Badge label={row.status_label} color={row.status_color} />
            <Badge label={row.service_kind_label} color="bg-slate-100 text-slate-600 border-slate-200" />
            {row.vendor_renamed_since && (
              <Badge label={`recorded as "${row.vendor_name_at_record}"`} color="bg-amber-100 text-amber-800 border-amber-200" />
            )}
          </div>

          {row.voided_at && (
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm">
              <p className="font-semibold">This visit record was voided.</p>
              <p className="text-xs text-[#6B5744] mt-0.5">{row.void_reason} — {fmtIST(row.voided_at)}</p>
            </div>
          )}
          {row.status === 'missed' && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-900">
              <p className="font-semibold">This contract visit did not happen.</p>
              <p className="text-xs mt-0.5">{row.missed_reason}</p>
            </div>
          )}
          {row.status === 'cancelled' && row.missed_reason && (
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm">
              <p className="font-semibold">Called off.</p>
              <p className="text-xs text-[#6B5744] mt-0.5">{row.missed_reason}</p>
            </div>
          )}

          <dl className="grid sm:grid-cols-2 gap-x-4 gap-y-2">
            <Field k="Date" v={fmtISTDate(row.business_date)} />
            <Field k="Next visit due" v={row.next_due_date ? fmtISTDate(row.next_due_date) : 'not noted'} />
            <Field k="Agency licence" v={row.agency_licence_no || 'not recorded'} />
            <Field k="Technician" v={row.technician_name || 'not recorded'} />
            <Field k="Report number" v={row.report_no || '—'} />
            <Field k="Accompanied by" v={row.staff_witness || 'not recorded'} />
            <Field k="Recorded by" v={row.created_by} />
            <Field k="Recorded at" v={fmtIST(row.created_at)} />
          </dl>

          {row.areas_covered && <Para k="Areas covered" v={row.areas_covered} />}
          {row.findings && <Para k="What they found" v={row.findings} />}
          {row.recommendations && <Para k="What they recommended" v={row.recommendations} />}

          {/* #78 — what was applied. Shown on EVERY completed visit, including
              the ones that do not say: "not recorded" in red is the gap an
              inspector would find, so it is never hidden. */}
          {row.status === 'completed' && (
            <div>
              <p className={`${LABEL} mb-1`}>What was applied</p>
              <ChemicalsTable state={row.chemicals_state} rows={row.chemicals} noneNote={row.chemicals_none_note} />
              {row.can_record_chemicals && canRecord && form !== 'chem' && (
                <button disabled={busy} onClick={() => setForm('chem')} className={`${BTN_PRIMARY} mt-2`}>
                  <Plus size={15} /> Fill in what was applied, from the job sheet
                </button>
              )}
              {row.can_record_chemicals && !canRecord && (
                <p className="text-[11px] text-[#8B7355] mt-1">A manager fills this in from the technician&apos;s job sheet.</p>
              )}
            </div>
          )}
          {form === 'chem' && (
            <ChemicalsForm
              busy={busy}
              title="What was applied on this visit"
              note="Once saved, this list is part of the record. To correct it later, the visit is voided with a reason and filed again."
              onCancel={() => setForm('')}
              onSubmit={async (v) => { if (await post({ action: 'record_chemicals', ...chemBody(v) }, 'Chemicals recorded.')) setForm(''); }}
            />
          )}

          {(row.document_title || row.contract_doc_title) && (
            <div className="text-xs text-[#6B5744]">
              {row.document_title && <p>Job sheet on file: {row.document_title}</p>}
              {row.contract_doc_title && <p>Contract on file: {row.contract_doc_title}</p>}
            </div>
          )}

          {sightings.length > 0 && (
            <div>
              <p className={`${LABEL} mb-1`}>Sightings this visit dealt with</p>
              <ul className="text-sm space-y-1">
                {sightings.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center gap-2">
                    <span className="text-[#8B7355] text-xs">{fmtISTDate(s.business_date)}</span>
                    <span>{s.pest_type} — {s.location_label}</span>
                    {s.voided_at ? <span className="text-xs text-[#8B7355]">(voided)</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {row.ca && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm">
              <p className="font-semibold flex flex-nowrap items-center gap-1.5"><Wrench size={14} /> Corrective action {row.ca.ca_number}</p>
              <p className="text-xs text-blue-900 mt-0.5">{row.ca.status} · due {row.ca.due_date || '—'} · {row.ca.owner_email || 'nobody assigned'}</p>
            </div>
          )}

          <div>
            <p className={`${LABEL} mb-1`}>The contractor&apos;s report</p>
            <Files
              files={row.files} limit={row.file_limit} canAdd={canRecord && !row.voided_at} canVoid={canVoidFiles && !row.voided_at} busy={busy}
              onAdd={(uri) => post({ action: 'attach', data_uri: uri, kind: 'report' }, 'File attached.')}
              onVoid={(fid) => {
                const reason = askReason('Voiding a file does NOT remove it: it stays on this visit, marked VOID, with your reason. Attach the right one beside it.\n\nWhy is this file being voided?', say);
                if (reason) post({ action: 'void_file', attachment_id: fid, reason }, 'File voided — it stays on the record, marked, with your reason.');
              }}
            />
          </div>

          {canRecord && !row.voided_at && (
            <div className="flex flex-wrap gap-2 pt-2 border-t border-[#E8D5C4]">
              {row.status === 'planned' && (
                <>
                  <button disabled={busy} onClick={() => setForm('complete')} className={BTN_PRIMARY}>
                    <Check size={15} /> It happened
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => {
                      const reason = window.prompt('Why did the visit not happen?') || '';
                      if (reason.trim().length < 4) { say('A reason of at least four characters is needed.'); return; }
                      post({ action: 'miss', missed_reason: reason }, 'Recorded as missed.');
                    }}
                    className={BTN_DANGER}
                  >
                    <AlertTriangle size={15} /> It did not happen
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => {
                      const reason = window.prompt('Called off. Why? ("cancelled" with no reason reads exactly like a missed visit somebody tidied away)') || '';
                      if (reason.trim().length < 4) { say('A reason of at least four characters is needed.'); return; }
                      post({ action: 'cancel', reason }, 'Recorded as called off.');
                    }}
                    className={BTN_PLAIN}
                  >
                    <X size={15} /> Called off
                  </button>
                </>
              )}
              {!row.ca_id && (row.status === 'missed' || row.status === 'completed') && (
                <button disabled={busy} onClick={() => setRaise(true)} className={BTN_PLAIN}>
                  <Wrench size={15} /> Raise a corrective action
                </button>
              )}
              {canVoid && (
                <button
                  disabled={busy}
                  onClick={() => {
                    const reason = window.prompt(
                      'Voiding is for a record entered IN ERROR. A visit that did not happen should be recorded as MISSED, not voided.\n\nWhy is this being voided?',
                    ) || '';
                    if (reason.trim().length < 4) { say('A reason of at least four characters is needed.'); return; }
                    post({ action: 'void', reason }, 'Visit voided; the row stays with its reason.');
                  }}
                  className="inline-flex flex-nowrap items-center gap-1.5 text-sm border border-red-200 text-red-700 bg-white rounded-lg px-3 py-2 hover:bg-red-50 disabled:opacity-50"
                >
                  <AlertTriangle size={15} /> Void it
                </button>
              )}
            </div>
          )}

          {form === 'complete' && (
            <CompleteVisitForm
              busy={busy}
              row={row}
              onCancel={() => setForm('')}
              onSubmit={async (body) => { if (await post({ action: 'complete', ...body }, 'Recorded as completed.')) setForm(''); }}
            />
          )}

          {raise && (
            <RaiseCaForm
              busy={busy}
              defaultSeverity={row.status === 'missed' ? 'high' : 'medium'}
              defaultTitle={`Pest control visit ${row.service_no} — ${row.status === 'missed' ? 'missed' : 'follow-up'}`}
              onCancel={() => setRaise(false)}
              onSubmit={async (p) => { setRaise(false); await post({ action: 'raise_ca', ...p }, 'Corrective action raised.'); }}
            />
          )}

          <div className="pt-2 border-t border-[#E8D5C4]">
            <button onClick={() => setPrintOpen(true)} className={BTN_PLAIN}><Printer size={15} /> Print this visit</button>
          </div>
          {printOpen && (
            <PrintOverlay title={`Pest-control visit ${row.service_no}`} onClose={() => setPrintOpen(false)}>
              <VisitRecordPrint v={row} />
            </PrintOverlay>
          )}
        </>
      )}
    </Modal>
  );
}

/** "It happened" — the visit's outcome AND what was applied, in one form. */
function CompleteVisitForm({
  busy, row, onCancel, onSubmit,
}: {
  busy: boolean; row: Service; onCancel: () => void;
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  const [businessDate, setBusinessDate] = useState(row.business_date > fssaiToday() ? fssaiToday() : row.business_date);
  const [technician, setTechnician] = useState(row.technician_name);
  const [licence, setLicence] = useState(row.agency_licence_no);
  const [reportNo, setReportNo] = useState(row.report_no);
  const [areas, setAreas] = useState(row.areas_covered);
  const [findings, setFindings] = useState(row.findings);
  const [recommendations, setRecommendations] = useState(row.recommendations);
  const [nextDue, setNextDue] = useState(row.next_due_date);
  const [witness, setWitness] = useState(row.staff_witness);
  const [chem, setChem] = useState<ChemValue>(emptyChemValue());
  return (
    <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg p-3 space-y-3">
      <p className="text-sm font-semibold">The visit happened</p>
      <div className="grid sm:grid-cols-3 gap-3">
        <label className="block">
          <span className={LABEL}>Date it happened {REQ}</span>
          <input type="date" value={businessDate} max={fssaiToday()} onChange={(e) => setBusinessDate(e.target.value)} className={INPUT} />
        </label>
        <label className="block">
          <span className={LABEL}>Technician</span>
          <input value={technician} onChange={(e) => setTechnician(e.target.value)} className={INPUT} />
        </label>
        <label className="block">
          <span className={LABEL}>Agency licence number</span>
          <input value={licence} onChange={(e) => setLicence(e.target.value)} className={INPUT} />
        </label>
      </div>
      <div className="grid sm:grid-cols-3 gap-3">
        <label className="block">
          <span className={LABEL}>Report number</span>
          <input value={reportNo} onChange={(e) => setReportNo(e.target.value)} className={INPUT} />
        </label>
        <label className="block">
          <span className={LABEL}>Accompanied by (our staff)</span>
          <input value={witness} onChange={(e) => setWitness(e.target.value)} className={INPUT} />
        </label>
        <label className="block">
          <span className={LABEL}>Next visit due</span>
          <input type="date" value={nextDue} min={businessDate} onChange={(e) => setNextDue(e.target.value)} className={INPUT} />
        </label>
      </div>
      <label className="block">
        <span className={LABEL}>Areas covered</span>
        <textarea rows={2} value={areas} onChange={(e) => setAreas(e.target.value)} className={INPUT} />
      </label>
      <label className="block">
        <span className={LABEL}>What they found</span>
        <textarea rows={2} value={findings} onChange={(e) => setFindings(e.target.value)} className={INPUT} />
      </label>
      <label className="block">
        <span className={LABEL}>What they recommended</span>
        <textarea rows={2} value={recommendations} onChange={(e) => setRecommendations(e.target.value)} className={INPUT} />
      </label>
      <div className="border-t border-[#E8D5C4] pt-3">
        <p className="text-sm font-semibold mb-2">What was applied</p>
        <ChemicalsEditor value={chem} onChange={setChem} />
      </div>
      <p className="text-[11px] text-[#6B5744]">
        Once it is marked completed the visit is a record. Leave the chemicals blank only if the job sheet has not
        arrived — the visit then shows NOT RECORDED in red until a manager fills it in.
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <button onClick={onCancel} className={BTN_PLAIN}>Cancel</button>
        <button
          disabled={busy || !businessDate}
          onClick={() => onSubmit({
            business_date: businessDate, technician_name: technician, agency_licence_no: licence, report_no: reportNo,
            areas_covered: areas, findings, recommendations, next_due_date: nextDue, staff_witness: witness,
            ...chemBody(chem),
          })}
          className={BTN_PRIMARY}
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Mark it completed
        </button>
      </div>
    </div>
  );
}

/** Fill a chemicals list nobody recorded — once. */
function ChemicalsForm({
  busy, title, note, onCancel, onSubmit,
}: { busy: boolean; title: string; note: string; onCancel: () => void; onSubmit: (v: ChemValue) => void }) {
  const [chem, setChem] = useState<ChemValue>(emptyChemValue());
  const ready = chem.none ? chem.noneNote.trim().length >= 4 : chem.rows.some((r) => r.name.trim().length >= 2);
  return (
    <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg p-3 space-y-3">
      <p className="text-sm font-semibold">{title}</p>
      <ChemicalsEditor value={chem} onChange={setChem} />
      <p className="text-[11px] text-[#6B5744]">{note}</p>
      <div className="flex flex-wrap justify-end gap-2">
        <button onClick={onCancel} className={BTN_PLAIN}>Cancel</button>
        <button disabled={busy || !ready} onClick={() => onSubmit(chem)} className={BTN_PRIMARY}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Save what was applied
        </button>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════ *
 * TAB 3 — THE PEST MAP. A register, not a check log. Admin writes.
 * ══════════════════════════════════════════════════════════════════════════ */

function MapTab({ say }: { say: (m: string) => void }) {
  const [rows, setRows] = useState<Device[]>([]);
  const [counts, setCounts] = useState({ active: 0, retired: 0, all: 0 });
  const [canConfigure, setCanConfigure] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [showRetired, setShowRetired] = useState(false);
  const [edit, setEdit] = useState<Device | null>(null);
  const [newOpen, setNewOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const j = await apiJson<DeviceListResponse>(`/api/fssai/pest/devices${showRetired ? '' : '?active=1'}`);
      setRows(j.devices || []); setCounts(j.counts || counts); setCanConfigure(!!j.can_configure);
    } catch (e: unknown) { setErr(errMsg(e, 'Could not load the pest map')); }
    finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showRetired]);
  useEffect(() => { load(); }, [load]);

  async function post(body: Record<string, unknown>, ok: string) {
    try {
      await apiJson('/api/fssai/pest/devices', { method: 'POST', body });
      say(ok); load();
    } catch (e: unknown) { say(errMsg(e, 'That did not work')); }
  }

  return (
    <div className="space-y-4">
      <div className={`${CARD} p-4 text-xs text-[#6B5744] flex flex-nowrap items-start gap-2`}>
        <Info size={14} className="mt-0.5 shrink-0 text-[#af4408]" />
        <span>
          This is the <strong>register of places</strong> — where each bait station, glue board and fly unit is, and how
          often it must be checked. The checks themselves are filed on the <strong>Station checks</strong> tab, one line
          per station, and the column below says where each station stands on that sheet.
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Tile n={counts.active} label="In use" />
        <Tile n={counts.retired} label="Retired" />
        <Tile n={counts.all} label="On the map, ever" />
      </div>

      <div className={`${CARD} p-3 flex flex-wrap items-center gap-3`}>
        <label className="inline-flex flex-nowrap items-center gap-2 text-sm">
          <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} className="w-4 h-4 accent-[#af4408]" />
          Show retired stations
        </label>
        <button onClick={load} disabled={loading} className={BTN_PLAIN}>
          {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Refresh
        </button>
        <div className="flex-1" />
        {canConfigure ? (
          <button onClick={() => setNewOpen(true)} className={BTN_PRIMARY}><Plus size={15} /> Add a station</button>
        ) : (
          <p className="text-xs text-[#8B7355]">
            The pest map is set up by an administrator. Renumbering a station would renumber the station every past
            sighting was filed against.
          </p>
        )}
      </div>

      {err && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">{err}</div>}

      <div className={`${CARD} overflow-hidden`}>
        {loading ? (
          <div className="p-10 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" /> Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm font-semibold">No monitoring points on the map yet</p>
            <p className="text-xs text-[#8B7355] mt-1">
              Add the bait stations, glue boards and insect light traps as they are numbered on the wall. A sighting can
              then be filed against the station it was found in.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[#FFF1E3] text-[#6B5744]">
                <tr>
                  <th className="text-left font-semibold px-3 py-2">Station</th>
                  <th className="text-left font-semibold px-3 py-2">Kind</th>
                  <th className="text-left font-semibold px-3 py-2">Where</th>
                  <th className="text-left font-semibold px-3 py-2">Monitoring sheet</th>
                  <th className="text-left font-semibold px-3 py-2">Sightings</th>
                  <th className="text-left font-semibold px-3 py-2">Last found something</th>
                  <th className="text-right font-semibold px-3 py-2">{canConfigure ? '' : 'State'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E8D5C4]">
                {rows.map((d) => (
                  <tr key={d.id} className={`hover:bg-[#FFF8F0] ${d.is_active ? '' : 'opacity-60'}`}>
                    <td className="px-3 py-2 font-medium whitespace-nowrap">{d.code || '—'}</td>
                    <td className="px-3 py-2 text-[#6B5744]">{d.device_kind_label}</td>
                    <td className="px-3 py-2">{d.location_label}{d.department_name ? <span className="text-[#8B7355]"> · {d.department_name}</span> : null}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {d.sheet ? (
                        <span className="inline-flex flex-nowrap items-center gap-1.5">
                          <Badge label={d.sheet.state_label} color={d.sheet.state_color} />
                          <span className="text-[11px] text-[#8B7355]">
                            {d.sheet.last_check_date ? `last ${fmtISTDate(d.sheet.last_check_date)}` : ''}{d.sheet.due_on ? ` · due ${fmtISTDate(d.sheet.due_on)}` : ''}
                          </span>
                        </span>
                      ) : <span className="text-[#8B7355]">—</span>}
                    </td>
                    <td className="px-3 py-2">{d.sighting_count || '—'}</td>
                    <td className="px-3 py-2 text-[#6B5744] whitespace-nowrap">{d.last_sighting_date ? fmtISTDate(d.last_sighting_date) : '—'}</td>
                    <td className="px-3 py-2 text-right">
                      {canConfigure ? (
                        <span className="inline-flex flex-nowrap gap-2">
                          <button onClick={() => setEdit(d)} className="text-xs text-[#af4408] underline">Edit</button>
                          {d.is_active ? (
                            <button
                              onClick={() => {
                                const reason = window.prompt('Why is this station being taken off the map? The round that covers it will stop asking about it.') || '';
                                if (reason.trim().length < 4) { say('A reason of at least four characters is needed.'); return; }
                                post({ action: 'set_active', id: d.id, is_active: 0, reason }, 'Station retired; the row and its sightings stay.');
                              }}
                              className="text-xs text-red-700 underline"
                            >
                              Retire
                            </button>
                          ) : (
                            <button
                              onClick={() => post({ action: 'set_active', id: d.id, is_active: 1 }, 'Station back on the map.')}
                              className="text-xs text-green-700 underline"
                            >
                              Bring back
                            </button>
                          )}
                        </span>
                      ) : (
                        <Badge
                          label={d.is_active ? 'In use' : 'Retired'}
                          color={d.is_active ? 'bg-green-100 text-green-700 border-green-200' : 'bg-gray-100 text-gray-600 border-gray-200'}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {(newOpen || edit) && (
        <DeviceModal
          device={edit}
          onClose={() => { setNewOpen(false); setEdit(null); }}
          onSaved={(m) => { setNewOpen(false); setEdit(null); say(m); load(); }}
        />
      )}
    </div>
  );
}

function DeviceModal({
  device, onClose, onSaved,
}: { device: Device | null; onClose: () => void; onSaved: (m: string) => void }) {
  const [code, setCode] = useState(device?.code || '');
  const [kind, setKind] = useState(device?.device_kind || 'bait_station');
  const [location, setLocation] = useState(device?.location_label || '');
  const [frequency, setFrequency] = useState(device?.check_frequency || 'weekly');
  const [installedOn, setInstalledOn] = useState(device?.installed_on || '');
  const [notes, setNotes] = useState(device?.notes || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function save() {
    setBusy(true); setErr('');
    try {
      await apiJson('/api/fssai/pest/devices', {
        method: 'POST',
        body: {
          action: device ? 'update' : 'create', id: device?.id,
          code, device_kind: kind, location_label: location,
          check_frequency: frequency, installed_on: installedOn, notes,
        },
      });
      onSaved(device ? 'Station updated.' : 'Station added to the map.');
    } catch (e: unknown) { setErr(errMsg(e, 'Could not save the station')); }
    finally { setBusy(false); }
  }

  return (
    <Modal
      title={device ? `Station ${device.code || ''}` : 'Add a monitoring point'}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className={BTN_PLAIN}>Cancel</button>
          <button onClick={save} disabled={busy || location.trim().length < 2} className={BTN_PRIMARY}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Save
          </button>
        </>
      }
    >
      {err && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">{err}</div>}
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block">
          <span className={LABEL}>Number painted on it</span>
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="7" className={INPUT} />
          <span className="text-[11px] text-[#8B7355]">Must be unique — a sighting is filed against it.</span>
        </label>
        <label className="block">
          <span className={LABEL}>Kind</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)} className={INPUT}>
            {FSSAI_PEST_DEVICE_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
        </label>
      </div>
      <label className="block">
        <span className={LABEL}>Where is it? {REQ}</span>
        <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Dry store, behind the racking" className={INPUT} />
      </label>
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block">
          <span className={LABEL}>How often it should be checked</span>
          <select value={frequency} onChange={(e) => setFrequency(e.target.value)} className={INPUT}>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="fortnightly">Fortnightly</option>
            <option value="monthly">Monthly</option>
          </select>
          <span className="text-[11px] text-[#8B7355]">The monitoring sheet calls the station overdue when a check is missed by this much.</span>
        </label>
        <label className="block">
          <span className={LABEL}>Installed on</span>
          <input type="date" value={installedOn} onChange={(e) => setInstalledOn(e.target.value)} className={INPUT} />
        </label>
      </div>
      <label className="block">
        <span className={LABEL}>Notes</span>
        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className={INPUT} />
      </label>
    </Modal>
  );
}
