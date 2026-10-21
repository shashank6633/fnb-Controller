'use client';

/**
 * The pieces of the Waste Handover Log screen (./page.tsx), kept apart from the
 * page so each one can be rendered on its own with fixture data — the page file
 * itself may only export its default component.
 *
 * Styling is the house skeleton the other FSSAI register screens use
 * (/fssai/oil-quality). ⚠️ globals.css force-wraps any `.flex.gap-2|3|4`, so rows
 * that must keep an icon beside their text carry `flex-nowrap`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, Ban, CalendarX, Check, ChevronDown, ChevronUp, History,
  Loader2, Printer, Recycle, Trash2, Truck, X,
} from 'lucide-react';
import { apiJson } from '@/lib/api';
import { fmtIST, fmtISTDate } from '@/lib/format-date';
import ImageUpload, { ImageThumb } from '@/app/tasks/_components/ImageUpload';
import {
  WASTE_COLLECTOR_KINDS, WASTE_QTY_UOMS, WASTE_PRINT_BLANK_ROW_CHOICES,
} from '@/app/api/fssai/_waste/vocab';

/* ------------------------------------------------------------------ *
 * Shapes (what /api/fssai/waste returns)
 * ------------------------------------------------------------------ */

export interface WastePhotoView {
  id: string; kind: string; filename: string; mime: string; size_bytes: number; caption: string;
  created_by: string; created_at: string; status: string; voided_at: string; voided_by: string;
  void_reason: string; image_dropped_at: string; has_image: boolean;
}

export interface Handover {
  id: string;
  handover_no: string;
  business_date: string;
  handed_at: string;
  wet_qty: number | null;
  dry_qty: number | null;
  other_qty: number | null;
  other_kind: string;
  qty_uom: string;
  wet_text: string;
  dry_text: string;
  other_text: string;
  collector_kind: string;
  collector_kind_label: string;
  collector_name: string;
  vendor_id: string;
  vendor_name: string;
  agency_reg_no: string;
  receipt_no: string;
  vehicle_no: string;
  lacks_proof: boolean;
  received_by_name: string;
  handed_over_name: string;
  department_id: string;
  department_name: string;
  document_id: string;
  document_title: string;
  document_reference: string;
  document_voided: boolean;
  note: string;
  status: string;
  status_label: string;
  recorded_by: string;
  recorded_name: string;
  created_at: string;
  voided_at: string;
  voided_by: string;
  void_reason: string;
  photos: WastePhotoView[];
}

export interface RecentCollector {
  collector_kind: string; collector_kind_label: string; collector_name: string; vendor_id: string;
  agency_reg_no: string; vehicle_no: string; qty_uom: string; received_by_name: string; document_id: string;
}

export interface RegisterResponse {
  from: string;
  to: string;
  today: string;
  status: string;
  handovers: Handover[];
  truncated: boolean;
  totals: { uom: string; handovers: number; wet: number | null; dry: number | null; other: number | null }[];
  gaps: { first_ever: string; days: number; days_with: number; without: string[]; before_log: number; today_pending: boolean };
  last: { handover_no: string; business_date: string; handed_at: string; collector: string } | null;
  verdict: { status: 'present' | 'expiring' | 'missing'; age: number | null; problems: string[]; lapses_on: string };
  cadence: { fresh: number; stale: number; words: string };
  recent_collectors: RecentCollector[];
  recent_handlers: string[];
  vendors: { id: string; name: string }[];
  departments: { id: string; name: string }[];
  agreements: { id: string; title: string; reference_no: string; expiry_date: string }[];
  can_record: boolean;
  is_management: boolean;
  can_void: boolean;
  me: { email: string; name: string };
  max_photos: number;
  photos_per_request: number;
}

interface DetailResponse {
  handover: Handover;
  trail: { action: string; field: string; reason: string; actor_email: string; actor_name: string; at: string }[];
  can_void: boolean;
  void_refusal: string;
  can_attach: boolean;
  can_void_photos: boolean;
  max_photos: number;
  photos_per_request: number;
}

export const INPUT =
  'w-full bg-white border border-[#D4B896] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]';
const QTY_INPUT =
  'w-full bg-white border border-[#D4B896] rounded-lg px-3 py-2.5 text-lg font-semibold text-right focus:outline-none focus:ring-2 focus:ring-[#af4408]';

/** Now in IST as HH:MM — the same clock the business date is kept in. */
export function istClock(): string {
  try {
    return new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    return '';
  }
}

export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Only digits and one dot — a quantity field never holds anything else. */
export function qtyOnly(v: string): string {
  const s = v.replace(/[^\d.]/g, '');
  const i = s.indexOf('.');
  return i < 0 ? s : s.slice(0, i + 1) + s.slice(i + 1).replace(/\./g, '');
}

const isVoided = (h: { status: string; voided_at: string }) => h.status === 'void' || !!h.voided_at;

/** "Ramky Enviro · Authorised agency · reg R-77" — the kind is left out when it IS the name (GHMC). */
export function collectorLine(h: Handover): string {
  const name = h.vendor_name || h.collector_name;
  const parts = [name];
  if (h.collector_kind_label && h.collector_kind_label.toLowerCase() !== name.toLowerCase()) parts.push(h.collector_kind_label);
  if (h.agency_reg_no) parts.push(`reg ${h.agency_reg_no}`);
  else if (h.collector_kind === 'agency') parts.push(`reg not recorded${h.note ? ` — ${h.note}` : ''}`);
  return parts.join(' · ');
}

/* ------------------------------------------------------------------ *
 * Frame
 * ------------------------------------------------------------------ */

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-6xl mx-auto px-3 sm:px-4 py-4 sm:py-6 space-y-3 sm:space-y-4">
        <div className="flex flex-nowrap items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#af4408] text-white flex items-center justify-center shrink-0">
            <Recycle size={20} />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-bold text-[#af4408] leading-tight">Waste Handover Log</h1>
            <p className="text-xs sm:text-sm text-[#6B5744]">
              Every load that leaves by the back door — what, how much, who took it
            </p>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <label className="block text-xs text-[#6B5744] mb-1">{label}</label>
      {children}
    </div>
  );
}

function ModalFrame({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="print:hidden fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div
        className="bg-[#FFF8F0] w-full sm:max-w-2xl sm:rounded-2xl rounded-t-2xl max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-[#FFF8F0] border-b border-[#E8D5C4] px-3 py-2.5 flex flex-nowrap items-center gap-2 z-10">
          <button onClick={onClose} aria-label="Back" className="sm:hidden w-10 h-10 rounded-lg border border-[#E8D5C4] bg-white flex items-center justify-center shrink-0">
            <ArrowLeft size={16} />
          </button>
          <p className="font-semibold text-[#2D1B0E] truncate">{title}</p>
          <button onClick={onClose} aria-label="Close" className="ml-auto w-10 h-10 rounded-lg border border-[#E8D5C4] bg-white flex items-center justify-center shrink-0">
            <X size={16} />
          </button>
        </div>
        <div className="p-3 sm:p-4">{children}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Is the log being kept?
 * ------------------------------------------------------------------ */

export function VerdictBanner({ data }: { data: RegisterResponse }) {
  const v = data.verdict;
  if (v.status === 'present' && data.last) {
    return (
      <div className="bg-green-50 border border-green-200 rounded-xl p-3">
        <div className="flex flex-nowrap items-start gap-2.5">
          <Check size={16} className="text-green-700 shrink-0 mt-0.5" />
          <p className="text-[13px] text-green-900">
            Last handover <strong>{data.last.handover_no}</strong> on {fmtISTDate(data.last.business_date)}
            {data.last.handed_at ? ` at ${data.last.handed_at}` : ''} to {data.last.collector}.
          </p>
        </div>
      </div>
    );
  }
  const tone = v.status === 'expiring' ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-red-50 border-red-200 text-red-900';
  return (
    <div className={`border rounded-xl p-3 ${tone}`}>
      <div className="flex flex-nowrap items-start gap-2.5">
        <AlertTriangle size={16} className="shrink-0 mt-0.5" />
        <p className="text-[13px]">
          {v.problems.join(' ') || 'No waste handover has been recorded.'}{' '}
          The audit file asks for a record of every handover — waste is expected to leave {data.cadence.words}.
        </p>
      </div>
    </div>
  );
}

export function TotalsAndGaps({ data }: { data: RegisterResponse }) {
  const [showGaps, setShowGaps] = useState(false);
  const g = data.gaps;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
        <p className="text-xs font-semibold text-[#6B5744] mb-1">Handed over, {fmtISTDate(data.from)} – {fmtISTDate(data.to)}</p>
        {data.totals.length === 0 ? (
          <p className="text-sm text-[#8B7355]">Nothing in these dates.</p>
        ) : data.totals.map((t) => (
          <p key={t.uom} className="text-sm">
            <span className="font-semibold">{t.handovers}</span> handover{t.handovers === 1 ? '' : 's'} in {t.uom}:{' '}
            wet {t.wet ?? '—'} · dry {t.dry ?? '—'} · other {t.other ?? '—'}
          </p>
        ))}
      </div>
      <div className={`border rounded-xl p-3 ${g.without.length ? 'bg-amber-50 border-amber-200' : 'bg-white border-[#E8D5C4]'}`}>
        <button onClick={() => setShowGaps((s) => !s)} className="w-full flex flex-nowrap items-center gap-2 text-left">
          <CalendarX size={16} className={g.without.length ? 'text-amber-800 shrink-0' : 'text-[#8B7355] shrink-0'} />
          <span className="text-sm">
            <strong>{g.without.length}</strong> finished day{g.without.length === 1 ? '' : 's'} with no handover
            {g.before_log > 0 && <span className="text-xs text-[#6B5744]"> · {g.before_log} before the log began</span>}
            {g.today_pending && <span className="text-xs text-[#6B5744]"> · nothing yet today</span>}
          </span>
          {g.without.length > 0 && (showGaps ? <ChevronUp size={16} className="ml-auto shrink-0" /> : <ChevronDown size={16} className="ml-auto shrink-0" />)}
        </button>
        {showGaps && g.without.length > 0 && (
          <p className="text-xs text-amber-900 mt-2 leading-relaxed">{g.without.map((d) => fmtISTDate(d)).join(' · ')}</p>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The register on screen
 * ------------------------------------------------------------------ */

export function RegisterTable({
  handovers, truncated, emptyText, onOpen,
}: { handovers: Handover[]; truncated: boolean; emptyText: string; onOpen: (id: string) => void }) {
  if (!handovers.length) {
    return (
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 text-center">
        <Truck className="w-6 h-6 mx-auto mb-2 text-[#8B7355]" />
        <p className="text-sm text-[#3D2614]">{emptyText}</p>
      </div>
    );
  }
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-x-auto">
      <table className="w-full text-sm min-w-[48rem]">
        <thead className="bg-[#FFF1E3] text-[#6B5744]">
          <tr>
            <th className="text-left font-semibold px-3 py-2">Date</th>
            <th className="text-right font-semibold px-3 py-2">Wet</th>
            <th className="text-right font-semibold px-3 py-2">Dry</th>
            <th className="text-left font-semibold px-3 py-2">Other</th>
            <th className="text-left font-semibold px-3 py-2">Collector</th>
            <th className="text-left font-semibold px-3 py-2">Vehicle · receipt</th>
            <th className="text-left font-semibold px-3 py-2">Handed over by</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#E8D5C4]">
          {handovers.map((h) => {
            const v = isVoided(h);
            const livePhotos = h.photos.filter((p) => p.status !== 'void' && !p.voided_at).length;
            return (
              <tr key={h.id} onClick={() => onOpen(h.id)} className={`cursor-pointer hover:bg-[#FFF8F0] ${v ? 'opacity-60' : ''}`}>
                <td className="px-3 py-2 align-top text-xs whitespace-nowrap">
                  <span className={v ? 'line-through' : ''}>{fmtISTDate(h.business_date)}</span>
                  {h.handed_at && <span className="block text-[#8B7355]">{h.handed_at}</span>}
                  <span className="block text-[10px] text-[#8B7355]">{h.handover_no}</span>
                  {v && <span className="inline-block mt-0.5 text-[10px] px-1 rounded bg-gray-200 text-gray-700">VOID</span>}
                </td>
                <td className="px-3 py-2 align-top text-right">{h.wet_text || <span className="text-[#C9B8A6]">—</span>}</td>
                <td className="px-3 py-2 align-top text-right">{h.dry_text || <span className="text-[#C9B8A6]">—</span>}</td>
                <td className="px-3 py-2 align-top text-xs">
                  {h.other_text ? <>{h.other_text}<span className="block text-[#8B7355]">{h.other_kind}</span></> : <span className="text-[#C9B8A6]">—</span>}
                </td>
                <td className="px-3 py-2 align-top text-xs">
                  <span className="text-[#2D1B0E] text-sm">{h.vendor_name || h.collector_name}</span>
                  {collectorLine(h) !== (h.vendor_name || h.collector_name) && (
                    <span className="block text-[#8B7355]">{collectorLine(h).split(' · ').slice(1).join(' · ')}</span>
                  )}
                </td>
                <td className="px-3 py-2 align-top text-xs">
                  {h.vehicle_no && <span className="block">{h.vehicle_no}</span>}
                  {h.receipt_no && <span className="block">Rcpt {h.receipt_no}</span>}
                  {h.lacks_proof && <span className="block text-amber-800">neither — see note</span>}
                  {livePhotos > 0 && <span className="block text-[#8B7355]">{livePhotos} photo{livePhotos === 1 ? '' : 's'}</span>}
                </td>
                <td className="px-3 py-2 align-top text-xs">{h.handed_over_name}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {truncated && (
        <p className="text-xs text-amber-800 px-3 py-2 border-t border-[#E8D5C4]">
          Only the newest entries are shown. Narrow the dates to see the rest.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The back-door form
 * ------------------------------------------------------------------ */

export function RecordCard({ data, onSaved }: { data: RegisterResponse; onSaved: (m: string) => void }) {
  const last = data.recent_collectors[0];
  const [businessDate, setBusinessDate] = useState(data.today);
  const [handedAt, setHandedAt] = useState(istClock());
  const [kind, setKind] = useState(last?.collector_kind || 'ghmc');
  const [collectorName, setCollectorName] = useState(last?.collector_name || '');
  const [vendorId, setVendorId] = useState(last?.vendor_id || '');
  const [regNo, setRegNo] = useState(last?.agency_reg_no || '');
  const [vehicle, setVehicle] = useState(last?.vehicle_no || '');
  const [uom, setUom] = useState(last?.qty_uom || 'kg');
  const [wet, setWet] = useState('');
  const [dry, setDry] = useState('');
  const [other, setOther] = useState('');
  const [otherKind, setOtherKind] = useState('');
  const [receipt, setReceipt] = useState('');
  const [handedOver, setHandedOver] = useState(data.me.name || data.me.email);
  const [receivedBy, setReceivedBy] = useState(last?.received_by_name || '');
  const [departmentId, setDepartmentId] = useState('');
  const [documentId, setDocumentId] = useState(last?.document_id || '');
  const [note, setNote] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const pick = (c: RecentCollector) => {
    setKind(c.collector_kind); setCollectorName(c.collector_name); setVendorId(c.vendor_id);
    setRegNo(c.agency_reg_no); setVehicle(c.vehicle_no); setUom(c.qty_uom || 'kg');
    setReceivedBy(c.received_by_name); setDocumentId(c.document_id);
  };

  const nothing = !wet && !dry && !other;

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const j = await apiJson<{ handover: Handover; warning?: string }>('/api/fssai/waste', {
        method: 'POST',
        body: {
          action: 'record',
          business_date: businessDate,
          handed_at: handedAt,
          wet_qty: wet, dry_qty: dry, other_qty: other, other_kind: otherKind,
          qty_uom: uom,
          collector_kind: kind,
          collector_name: vendorId ? '' : collectorName,
          vendor_id: kind === 'agency' ? vendorId : '',
          agency_reg_no: kind === 'agency' ? regNo : '',
          receipt_no: receipt,
          vehicle_no: vehicle,
          received_by_name: receivedBy,
          handed_over_name: handedOver,
          department_id: departmentId,
          document_id: documentId,
          note,
          photos: photos.map((d) => ({ data_uri: d, kind: 'photo' })),
        },
      });
      /* The collector, vehicle and unit STAY — tomorrow's load is usually the
       * same truck. Only what was on this one is cleared. */
      setWet(''); setDry(''); setOther(''); setOtherKind(''); setReceipt(''); setNote(''); setPhotos([]);
      setHandedAt(istClock());
      onSaved(`${j.handover.handover_no} saved.${j.warning ? ` ${j.warning}` : ''}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save the handover');
    } finally { setBusy(false); }
  };

  return (
    <div className="bg-white border-2 border-[#af4408]/40 rounded-xl p-3 sm:p-4 space-y-3">
      <p className="text-sm font-semibold text-[#af4408]">Record a handover</p>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Date">
          <input type="date" value={businessDate} max={data.today} onChange={(e) => setBusinessDate(e.target.value)} className={INPUT} />
        </Field>
        <Field label="Time">
          <input type="time" value={handedAt} onChange={(e) => setHandedAt(e.target.value)} className={INPUT} />
        </Field>
      </div>

      {data.recent_collectors.length > 0 && (
        <div>
          <p className="text-xs text-[#6B5744] mb-1">Same as before</p>
          <div className="flex flex-wrap gap-1.5">
            {data.recent_collectors.map((c, i) => (
              <button
                key={`${c.collector_kind}-${c.collector_name}-${i}`}
                onClick={() => pick(c)}
                className="text-xs px-2.5 py-2 rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] hover:border-[#af4408] min-h-[40px]"
              >
                {c.collector_name}{c.vehicle_no ? ` · ${c.vehicle_no}` : ''}
              </button>
            ))}
          </div>
        </div>
      )}

      <Field label="Who collected it">
        <div className="grid grid-cols-3 gap-1.5">
          {WASTE_COLLECTOR_KINDS.map((k) => (
            <button
              key={k.key}
              onClick={() => { setKind(k.key); if (k.key !== 'agency') setVendorId(''); }}
              title={k.hint}
              className={`text-sm px-2 py-2.5 rounded-lg border font-medium min-h-[44px] ${
                kind === k.key ? 'bg-[#af4408] border-[#af4408] text-white' : 'bg-white border-[#E8D5C4] text-[#6B5744]'
              }`}
            >
              {k.label}
            </button>
          ))}
        </div>
      </Field>

      {kind === 'agency' && data.vendors.length > 0 && (
        <Field label="Agency (if it is one of our vendors)">
          <select value={vendorId} onChange={(e) => setVendorId(e.target.value)} className={INPUT}>
            <option value="">Not in the vendor list — I will type the name</option>
            {data.vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </Field>
      )}
      {!vendorId && (
        <Field label={kind === 'ghmc' ? 'Name (optional — GHMC if blank)' : 'Name of the agency or person'}>
          <input value={collectorName} onChange={(e) => setCollectorName(e.target.value)} placeholder={kind === 'ghmc' ? 'GHMC' : 'Collector or agency name'} className={INPUT} />
        </Field>
      )}
      {kind === 'agency' && (
        <Field label="Agency registration number">
          <input value={regNo} onChange={(e) => setRegNo(e.target.value)} placeholder="As printed on its authorisation" className={INPUT} />
        </Field>
      )}

      <div>
        <div className="flex flex-nowrap items-center gap-2 mb-1">
          <p className="text-xs text-[#6B5744]">How much went</p>
          <div className="ml-auto flex flex-nowrap gap-1">
            {WASTE_QTY_UOMS.map((u) => (
              <button
                key={u.key}
                onClick={() => setUom(u.key)}
                className={`text-xs px-2.5 py-1.5 rounded-md border min-h-[36px] ${uom === u.key ? 'bg-[#2D1B0E] border-[#2D1B0E] text-white' : 'bg-white border-[#E8D5C4] text-[#6B5744]'}`}
              >
                {u.label}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Field label={`Wet (${uom})`}>
            <input value={wet} onChange={(e) => setWet(qtyOnly(e.target.value))} inputMode="decimal" placeholder="—" className={QTY_INPUT} />
          </Field>
          <Field label={`Dry (${uom})`}>
            <input value={dry} onChange={(e) => setDry(qtyOnly(e.target.value))} inputMode="decimal" placeholder="—" className={QTY_INPUT} />
          </Field>
          <Field label={`Other (${uom})`}>
            <input value={other} onChange={(e) => setOther(qtyOnly(e.target.value))} inputMode="decimal" placeholder="—" className={QTY_INPUT} />
          </Field>
        </div>
        {(other || otherKind) && (
          <div className="mt-2">
            <Field label="What was the other waste">
              <input value={otherKind} onChange={(e) => setOtherKind(e.target.value)} placeholder="Glass, cartons, e-waste, sanitary…" className={INPUT} />
            </Field>
          </div>
        )}
        <p className="text-[11px] text-[#8B7355] mt-1">Leave a stream blank if none of it went. Blank is never counted as zero.</p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Vehicle number">
          <input value={vehicle} onChange={(e) => setVehicle(e.target.value.toUpperCase())} placeholder="TS 09 UB 1234" className={INPUT} />
        </Field>
        <Field label="Receipt number">
          <input value={receipt} onChange={(e) => setReceipt(e.target.value)} placeholder="From the collector's slip" className={INPUT} />
        </Field>
      </div>

      <Field label="Handed over by">
        <input value={handedOver} onChange={(e) => setHandedOver(e.target.value)} className={INPUT} />
        {data.recent_handlers.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {data.recent_handlers.filter((n) => n !== handedOver).slice(0, 6).map((n) => (
              <button key={n} onClick={() => setHandedOver(n)} className="text-[11px] px-2 py-1 rounded-md border border-[#E8D5C4] bg-[#FFF8F0] min-h-[32px]">{n}</button>
            ))}
          </div>
        )}
      </Field>

      <button onClick={() => setMore((m) => !m)} className="text-xs text-[#af4408] font-medium flex flex-nowrap items-center gap-1 min-h-[36px]">
        {more ? <ChevronUp size={14} /> : <ChevronDown size={14} />} Photo, note and more
      </button>
      {more && (
        <div className="space-y-2 border-t border-[#E8D5C4] pt-2">
          <Field label={`Photograph of the receipt or the bins (up to ${data.photos_per_request} now, more later)`}>
            <ImageUpload multiple max={data.photos_per_request} value={photos} onChange={setPhotos} label="Add a photo" />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <Field label="Received by (the collector's person)">
              <input value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} className={INPUT} />
            </Field>
            <Field label="From department (blank = whole restaurant)">
              <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className={INPUT}>
                <option value="">Whole restaurant</option>
                {data.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </Field>
          </div>
          {data.agreements.length > 0 && (
            <Field label="Collector's agreement on file (optional)">
              <select value={documentId} onChange={(e) => setDocumentId(e.target.value)} className={INPUT}>
                <option value="">None</option>
                {data.agreements.map((a) => (
                  <option key={a.id} value={a.id}>{a.title}{a.reference_no ? ` · ${a.reference_no}` : ''}{a.expiry_date ? ` · until ${a.expiry_date}` : ''}</option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Note">
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Anything unusual. Required if there is no receipt and no vehicle number." className={INPUT} />
          </Field>
        </div>
      )}

      {err && <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-800">{err}</div>}

      <button
        onClick={() => void submit()}
        disabled={busy || nothing}
        className="w-full min-h-[52px] rounded-xl bg-[#af4408] text-white font-semibold disabled:opacity-50 flex flex-nowrap items-center justify-center gap-2"
      >
        {busy ? <Loader2 size={18} className="animate-spin" /> : <Check size={18} />}
        Save handover
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * One handover
 * ------------------------------------------------------------------ */

export function HandoverModal({
  id, onClose, onChanged, onClosedAfterChange,
}: {
  id: string;
  onClose: () => void;
  onChanged: (m: string) => void;
  onClosedAfterChange: (m: string) => void;
}) {
  const [d, setD] = useState<DetailResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const [adding, setAdding] = useState<string[]>([]);
  const [photoVoid, setPhotoVoid] = useState<string | null>(null);
  const [photoReason, setPhotoReason] = useState('');

  const load = useCallback(async () => {
    try {
      setD(await apiJson<DetailResponse>(`/api/fssai/waste?id=${encodeURIComponent(id)}`));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load the handover');
    }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const h = d?.handover;
  const isVoid = !!h && isVoided(h);
  const activePhotos = useMemo(() => (h?.photos || []).filter((p) => p.status !== 'void' && !p.voided_at).length, [h]);

  const doVoid = async () => {
    setBusy(true); setErr(null);
    try {
      await apiJson('/api/fssai/void', { method: 'POST', body: { entity_table: 'fssai_waste_handovers', id, reason } });
      onClosedAfterChange('Voided. The handover stays on the register, marked void with your reason.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not void that');
    } finally { setBusy(false); }
  };

  const doAttach = async () => {
    setBusy(true); setErr(null);
    try {
      await apiJson('/api/fssai/waste', { method: 'POST', body: { action: 'attach', id, photos: adding.map((x) => ({ data_uri: x, kind: 'photo' })) } });
      setAdding([]);
      await load();
      onChanged('Photograph added.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not add the photograph');
    } finally { setBusy(false); }
  };

  const doVoidPhoto = async () => {
    if (!photoVoid) return;
    setBusy(true); setErr(null);
    try {
      await apiJson('/api/fssai/waste', { method: 'POST', body: { action: 'void_photo', id, attachment_id: photoVoid, reason: photoReason } });
      setPhotoVoid(null); setPhotoReason('');
      await load();
      onChanged('Photograph voided. It stays on the handover, marked void.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not void the photograph');
    } finally { setBusy(false); }
  };

  return (
    <ModalFrame title={h ? `${h.handover_no} · ${fmtISTDate(h.business_date)}` : 'Waste handover'} onClose={onClose}>
      {!d || !h ? (
        err ? <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-800">{err}</div>
          : <div className="p-8 text-center"><Loader2 className="w-6 h-6 mx-auto animate-spin text-[#af4408]" /></div>
      ) : (
        <div className="space-y-3">
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
            <p className="text-base font-semibold">{h.vendor_name || h.collector_name} <span className="text-xs font-normal text-[#6B5744]">· {h.collector_kind_label}</span></p>
            <p className="text-xs text-[#6B5744] mt-0.5">
              {fmtISTDate(h.business_date)}{h.handed_at ? ` at ${h.handed_at}` : ''} · filed by {h.recorded_name || h.recorded_by} {fmtIST(h.created_at)}
            </p>
            <dl className="grid grid-cols-3 gap-x-4 gap-y-1 mt-2 text-sm">
              <div><dt className="text-xs text-[#6B5744]">Wet</dt><dd>{h.wet_text || '—'}</dd></div>
              <div><dt className="text-xs text-[#6B5744]">Dry</dt><dd>{h.dry_text || '—'}</dd></div>
              <div><dt className="text-xs text-[#6B5744]">Other</dt><dd>{h.other_text ? `${h.other_text} (${h.other_kind})` : '—'}</dd></div>
            </dl>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 mt-2 text-xs">
              <div><dt className="text-[#6B5744]">Vehicle</dt><dd>{h.vehicle_no || '—'}</dd></div>
              <div><dt className="text-[#6B5744]">Receipt</dt><dd>{h.receipt_no || '—'}</dd></div>
              {h.collector_kind === 'agency' && (
                <div><dt className="text-[#6B5744]">Registration</dt><dd>{h.agency_reg_no || <span className="text-amber-800">none recorded</span>}</dd></div>
              )}
              <div><dt className="text-[#6B5744]">Handed over by</dt><dd>{h.handed_over_name || '—'}</dd></div>
              <div><dt className="text-[#6B5744]">Received by</dt><dd>{h.received_by_name || '—'}</dd></div>
              <div><dt className="text-[#6B5744]">Department</dt><dd>{h.department_name || 'Whole restaurant'}</dd></div>
              {h.document_id && (
                <div className="col-span-2">
                  <dt className="text-[#6B5744]">Agreement on file</dt>
                  <dd>{h.document_title}{h.document_reference ? ` · ${h.document_reference}` : ''}{h.document_voided ? ' (since voided)' : ''}</dd>
                </div>
              )}
            </dl>
            {h.lacks_proof && <p className="text-xs text-amber-800 mt-2">No receipt or vehicle number — the note is the record.</p>}
            {h.note && <p className="text-xs text-[#3D2614] mt-2 whitespace-pre-wrap">{h.note}</p>}
          </div>

          {(h.photos.length > 0 || d.can_attach) && (
            <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 space-y-2">
              <p className="text-xs font-semibold text-[#6B5744]">Photographs</p>
              {h.photos.length > 0 && (
                <div className="flex flex-wrap gap-3">
                  {h.photos.map((p) => {
                    const pv = p.status === 'void' || !!p.voided_at;
                    return (
                      <div key={p.id} className="w-24">
                        <div className={pv ? 'opacity-50' : ''}>
                          {p.has_image && !p.image_dropped_at ? (
                            <ImageThumb src={`/api/fssai/waste/photo?id=${encodeURIComponent(p.id)}`} size={72} />
                          ) : (
                            <div className="w-[72px] h-[72px] rounded-lg border border-[#E8D5C4] bg-[#FFF1E3] flex items-center justify-center text-[10px] text-[#8B7355] px-1 text-center">not stored</div>
                          )}
                        </div>
                        {pv ? (
                          <p className="text-[10px] text-gray-600 mt-0.5 leading-tight"><Ban size={10} className="inline" /> VOID: {p.void_reason}</p>
                        ) : d.can_void_photos && !isVoid ? (
                          <button onClick={() => { setPhotoVoid(p.id); setPhotoReason(''); }} className="text-[10px] text-red-700 underline mt-0.5 min-h-[28px]">Void photo</button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
              {photoVoid && (
                <div className="border border-red-300 rounded-lg p-2 space-y-1.5">
                  <Field label="Why is this photograph being voided (it is kept, marked void)">
                    <input value={photoReason} onChange={(e) => setPhotoReason(e.target.value)} className={INPUT} />
                  </Field>
                  <div className="flex flex-nowrap gap-2">
                    <button onClick={() => void doVoidPhoto()} disabled={busy || photoReason.trim().length < 4} className="flex-1 min-h-[44px] rounded-lg bg-red-700 text-white text-sm font-semibold disabled:opacity-50">Void the photograph</button>
                    <button onClick={() => setPhotoVoid(null)} className="min-h-[44px] px-3 rounded-lg border border-[#E8D5C4] bg-white text-sm">Cancel</button>
                  </div>
                </div>
              )}
              {d.can_attach && activePhotos < d.max_photos && (
                <div className="space-y-1.5">
                  <ImageUpload
                    multiple
                    max={Math.min(d.photos_per_request, d.max_photos - activePhotos)}
                    value={adding}
                    onChange={setAdding}
                    label="Add a photo"
                  />
                  {adding.length > 0 && (
                    <button onClick={() => void doAttach()} disabled={busy} className="min-h-[44px] px-3 rounded-lg bg-[#af4408] text-white text-sm font-semibold disabled:opacity-50">
                      {busy ? 'Saving…' : `Add ${adding.length} photograph${adding.length === 1 ? '' : 's'}`}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {isVoid && (
            <div className="bg-gray-50 border border-gray-200 rounded-xl p-3">
              <p className="text-xs font-semibold text-gray-700">Voided</p>
              <p className="text-sm text-gray-700 mt-0.5">{h.void_reason}</p>
              <p className="text-xs text-gray-500 mt-0.5">{h.voided_by} · {fmtIST(h.voided_at)}</p>
            </div>
          )}

          {d.trail.length > 0 && (
            <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
              <p className="text-xs font-semibold text-[#6B5744] mb-1.5 flex flex-nowrap items-center gap-1"><History size={13} /> What has happened to this record</p>
              <ul className="space-y-1">
                {d.trail.map((t, i) => (
                  <li key={i} className="text-xs text-[#3D2614]">
                    <span className="text-[#8B7355]">{fmtIST(t.at)}</span> · {t.action}{t.field ? ` (${t.field})` : ''} · {t.actor_name || t.actor_email}
                    {t.reason && <span className="block text-[#6B5744] pl-2">{t.reason}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {err && <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-800">{err}</div>}

          {!isVoid && d.can_void && (voiding ? (
            <div className="bg-white border border-red-300 rounded-xl p-3 space-y-2">
              <p className="text-xs text-[#3D2614]">
                Voiding says this handover did not happen as written. It stays on the register, marked void,
                with your reason — it is never deleted. File the correct one afresh.
              </p>
              <Field label="Why is this being voided">
                <input value={reason} onChange={(e) => setReason(e.target.value)} className={INPUT} />
              </Field>
              <button
                onClick={() => void doVoid()}
                disabled={busy || reason.trim().length < 4}
                className="w-full min-h-[48px] rounded-xl bg-red-700 text-white font-semibold disabled:opacity-50"
              >
                {busy ? 'Saving…' : 'Void this handover'}
              </button>
            </div>
          ) : (
            <button
              onClick={() => setVoiding(true)}
              className="min-h-[48px] px-3 rounded-xl border border-red-300 bg-white text-red-700 text-sm font-medium flex flex-nowrap items-center gap-1.5"
            >
              <Trash2 size={15} /> Void this handover
            </button>
          ))}
          {!isVoid && !d.can_void && /yourself/.test(d.void_refusal || '') && (
            <p className="text-xs text-[#6B5744]">{d.void_refusal}</p>
          )}
        </div>
      )}
    </ModalFrame>
  );
}

/* ------------------------------------------------------------------ *
 * The printed register
 * ------------------------------------------------------------------ */

/** The paper register itself — pure, so it can be rendered and checked on its own. */
export function PrintRegister({
  rows, withVoid, blank, from, to, printedBy, printedAt,
}: { rows: Handover[]; withVoid: boolean; blank: number; from: string; to: string; printedBy: string; printedAt: string }) {
  const shown = rows.filter((h) => withVoid || !isVoided(h));
  const cell = 'border border-black px-1.5 py-1 align-top';
  return (
    <div className="p-4 text-black">
      <div className="flex items-end justify-between border-b-2 border-black pb-2 mb-3">
        <div>
          <h1 className="text-xl font-bold uppercase tracking-wide">Waste Disposal Record — Waste Handover Log</h1>
          <p className="text-xs">{from} to {to} · times in IST · quantities as the collector&rsquo;s slip states them</p>
        </div>
        <div className="text-xs text-right">
          <div>Printed {printedAt}</div>
          <div>by {printedBy}</div>
        </div>
      </div>
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr>
            <th className={`${cell} text-left w-[9%]`}>Date / time</th>
            <th className={`${cell} text-left w-[8%]`}>No.</th>
            <th className={`${cell} text-right w-[6%]`}>Wet</th>
            <th className={`${cell} text-right w-[6%]`}>Dry</th>
            <th className={`${cell} text-left w-[10%]`}>Other</th>
            <th className={`${cell} text-left w-[16%]`}>Collector (GHMC / agency, reg. no.)</th>
            <th className={`${cell} text-left w-[12%]`}>Vehicle · receipt</th>
            <th className={`${cell} text-left w-[11%]`}>Handed over by</th>
            <th className={`${cell} text-left w-[10%]`}>Received by</th>
            <th className={`${cell} text-left w-[12%]`}>Signature</th>
          </tr>
        </thead>
        <tbody>
          {shown.length === 0 && blank === 0 && (
            <tr><td className={cell} colSpan={10}>No handover is recorded in these dates.</td></tr>
          )}
          {shown.map((h) => {
            const v = isVoided(h);
            const strike = v ? 'line-through' : '';
            return (
              <tr key={h.id} className="break-inside-avoid" data-void={v ? '1' : '0'}>
                <td className={cell}><span className={strike}>{h.business_date}{h.handed_at ? ` ${h.handed_at}` : ''}</span></td>
                <td className={cell}><span className={strike}>{h.handover_no}</span></td>
                <td className={`${cell} text-right`}><span className={strike}>{h.wet_text}</span></td>
                <td className={`${cell} text-right`}><span className={strike}>{h.dry_text}</span></td>
                <td className={cell}><span className={strike}>{h.other_text ? `${h.other_text} (${h.other_kind})` : ''}</span></td>
                <td className={cell}>
                  <span className={strike}>{collectorLine(h)}</span>
                </td>
                <td className={cell}>
                  <span className={strike}>{[h.vehicle_no, h.receipt_no ? `Rcpt ${h.receipt_no}` : ''].filter(Boolean).join(' · ') || (h.note ? `Note: ${h.note}` : '')}</span>
                </td>
                <td className={cell}><span className={strike}>{h.handed_over_name}</span></td>
                <td className={cell}><span className={strike}>{h.received_by_name}</span></td>
                <td className={cell}>
                  {v ? <span className="text-[10px] font-semibold">VOID — {h.void_reason} ({h.voided_by})</span> : ''}
                </td>
              </tr>
            );
          })}
          {Array.from({ length: blank }).map((_, i) => (
            <tr key={`blank-${i}`} data-blank="1">
              {Array.from({ length: 10 }).map((__, j) => <td key={j} className={`${cell} h-7`}>&nbsp;</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[10px] mt-2">
        A blank Wet / Dry / Other cell means none of that stream went on that handover. Voided lines stay on the
        register with the reason they were voided; nothing is deleted.
      </p>
    </div>
  );
}

/** The preview + print overlay. Loads EVERY status for the chosen dates, oldest first. */
export function PrintSheet({ data, onClose }: { data: RegisterResponse; onClose: () => void }) {
  const [withVoid, setWithVoid] = useState(true);
  const [blank, setBlank] = useState<number>(0);
  const [rows, setRows] = useState<Handover[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const p = new URLSearchParams({ from: data.from, to: data.to, status: 'all' });
    apiJson<RegisterResponse>(`/api/fssai/waste?${p}`)
      .then((j) => setRows([...j.handovers].reverse()))
      .catch((e) => setErr(e instanceof Error ? e.message : 'Could not load the register'));
  }, [data.from, data.to]);

  return (
    <div id="fssai-waste-print" className="fixed inset-0 z-[60] bg-white overflow-auto print:static print:overflow-visible print:z-auto">
      <style>{`@media print {
        @page { size: A4 landscape; margin: 10mm }
        body * { visibility: hidden !important; }
        #fssai-waste-print, #fssai-waste-print * { visibility: visible !important; }
        #fssai-waste-print { position: absolute !important; inset: 0 auto auto 0 !important; width: 100% !important; }
      }`}</style>

      <div className="print:hidden sticky top-0 bg-[#FFF8F0] border-b border-[#E8D5C4] px-4 py-3 flex flex-wrap items-center gap-3">
        <span className="font-semibold text-[#2D1B0E]">Print preview</span>
        <label className="text-xs text-[#6B5744] flex flex-nowrap items-center gap-1.5">
          <input type="checkbox" checked={withVoid} onChange={(e) => setWithVoid(e.target.checked)} className="accent-[#af4408]" />
          Show voided lines (struck through, with the reason)
        </label>
        <label className="text-xs text-[#6B5744] flex flex-nowrap items-center gap-1.5">
          Blank lines
          <select value={blank} onChange={(e) => setBlank(Number(e.target.value))} className="border border-[#D4B896] rounded px-1.5 py-1 text-xs">
            {WASTE_PRINT_BLANK_ROW_CHOICES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <span className="flex-1" />
        <button onClick={() => window.print()} disabled={!rows} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#af4408] hover:bg-[#8a3506] text-white text-sm font-medium disabled:opacity-50">
          <Printer className="w-4 h-4" /> Print
        </button>
        <button onClick={onClose} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[#E8D5C4] hover:bg-[#FFF1E3] text-sm text-[#6B5744]">
          <X className="w-4 h-4" /> Close
        </button>
      </div>

      {err && <p className="p-4 text-sm text-red-700">{err}</p>}
      {!rows && !err && <p className="p-4 text-sm">Loading…</p>}
      {rows && (
        <PrintRegister
          rows={rows} withVoid={withVoid} blank={blank} from={data.from} to={data.to}
          printedBy={data.me.name || data.me.email} printedAt={fmtIST(new Date().toISOString())}
        />
      )}
    </div>
  );
}
