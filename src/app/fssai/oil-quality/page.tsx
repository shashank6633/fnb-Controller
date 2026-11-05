'use client';

/**
 * OIL QUALITY CHECKS — owner §12.
 *
 * ── THE TWO HALVES ─────────────────────────────────────────────────────────
 *   · CHECKS — each fryer judged by meter, strip or by look and smell, with what
 *     was then done to the oil.
 *   · COLLECTIONS — where the used oil WENT. Who collected it, under what
 *     registration, how much, and the receipt. That is the record an inspector
 *     asks for and it is the reason this half exists at all.
 *
 * ── THE NUMBER THAT IS NOT IN THE SOFTWARE ──────────────────────────────────
 * The 25% TPM limit is not hard-coded anywhere. Every reading is judged against
 * the standard the owner set, and the limit actually used is frozen onto the
 * record. When no standard exists yet, the screen says so in the server's own
 * words and offers the person doing the check a box to type the limit their meter
 * or SOP uses — which is honest, auditable, and still not a number baked into the
 * app. A reading with no limit at all is recorded and NOT judged, and the record
 * says which of the three it was.
 *
 * ── AND THE COLUMN THIS SCREEN WILL NEVER HAVE ──────────────────────────────
 * There is no money on the collections half. A collector's receipt often carries
 * a value, and the moment this screen held one it would be a second place the
 * business records income, outside the ledgers that own that number.
 *
 * Styling is the house skeleton as /fssai/corrective-actions uses it.
 * ⚠️ globals.css force-wraps any `.flex.gap-2|3|4`, so rows that must keep an
 * icon beside their text carry `flex-nowrap`.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, Beaker, Check, HelpCircle, Info, Loader2, Lock,
  Plus, RefreshCw, Search, ShieldCheck, Trash2, Truck, X,
} from 'lucide-react';
import { apiJson } from '@/lib/api';
import { fmtIST, fmtISTDate } from '@/lib/format-date';
import ImageUpload, { ImageThumb } from '@/app/tasks/_components/ImageUpload';
import UserPicker from '@/app/tasks/_components/UserPicker';
import {
  FSSAI_CHECK_RESULTS, FSSAI_OIL_ACTIONS, FSSAI_OIL_METHODS, FSSAI_SHIFTS,
  fssaiRecordStatusMeta, fssaiToday,
} from '@/lib/fssai';

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

interface Photo {
  id: string; kind: string; filename: string; mime: string;
  size_bytes: number; caption: string; image_dropped_at: string;
}

interface SensoryView { key: string; label: string; result: string; result_label: string; is_fail: boolean }

interface OilCheck {
  id: string;
  business_date: string;
  checked_at: string;
  shift: string;
  equipment_id: string;
  equipment_label: string;
  department_name: string;
  oil_type: string;
  material_name: string;
  method: string;
  method_label: string;
  tpm_pct: number | null;
  ffa_pct: number | null;
  temp_c: number | null;
  colour_grade: string;
  sensory: SensoryView[];
  max_tpm_used: number | null;
  standard_id: string;
  standard_code: string;
  standard_label: string;
  is_fail: boolean;
  is_judged: boolean;
  fail_reason: string;
  tpm_display: string;
  action_taken: string;
  action_label: string;
  oil_changed: boolean;
  qty_discarded: number | null;
  qty_added: number | null;
  qty_uom: string;
  hours_in_use: number | null;
  disposal_id: string;
  disposal_date: string;
  disposal_receipt: string;
  ca_id: string;
  ca_number: string;
  ca_status: string;
  note: string;
  status: string;
  status_label: string;
  recorded_by: string;
  recorded_name: string;
  created_at: string;
  voided_at: string;
  voided_by: string;
  void_reason: string;
  photos?: Photo[];
}

interface Fryer { id: string; name: string; code: string; location_label: string; department_id: string }

interface StandardView { id: string; code: string; label: string; min_value: number | null; max_value: number | null; uom: string; authority: string }

interface OilResponse {
  checks: OilCheck[];
  counts: { live: number; failed: number; unjudged: number; void: number };
  fryers: Fryer[];
  standard: StandardView | null;
  unjudged_notice: string;
  suggested_limit_tpm_pct: number;
  sensory: { key: string; label: string; hint: string }[];
  can_record: boolean;
  is_management: boolean;
  me: string;
  truncated: boolean;
}

interface Disposal {
  id: string;
  business_date: string;
  collected_at: string;
  vendor_id: string;
  vendor_name: string;
  collector_name: string;
  agency_reg_no: string;
  vehicle_no: string;
  quantity: number | null;
  uom: string;
  receipt_no: string;
  handed_over_by: string;
  note: string;
  status: string;
  status_label: string;
  created_by: string;
  created_at: string;
  linked_checks: number;
  linked_discarded_qty: number | null;
  quantity_matches_checks: boolean | null;
  voided_at: string;
  voided_by: string;
  void_reason: string;
  documents?: Photo[];
}

/** What a corrective action looks like when one is raised alongside a record. */
interface RaisedAction {
  id: string; ca_number: string; title: string; severity: string; due_date: string;
}

interface CheckResult {
  ok: boolean;
  check: OilCheck;
  verdict: { is_judged: boolean; is_fail: boolean; why: string; limit_used: number | null; limit_source: string };
  corrective_action: RaisedAction | null;
  corrective_action_warning?: string;
  unjudged_notice?: string;
}

interface CollectionResult {
  ok: boolean;
  disposal: Disposal;
  linked: string[];
  refused_links: string[];
  warning?: string;
}

interface DisposalResponse {
  disposals: Disposal[];
  uncollected: { checks: number; quantity: number; note: string };
  vendors: { id: string; name: string }[];
  can_record: boolean;
  is_management: boolean;
  me: string;
  truncated: boolean;
}

const INPUT =
  'w-full bg-white border border-[#D4B896] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]';

const TABS = [
  { key: 'checks', label: 'Oil checks' },
  { key: 'collections', label: 'Used-oil collections' },
] as const;

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-6xl mx-auto px-3 sm:px-4 py-4 sm:py-6 space-y-3 sm:space-y-4">
        <div className="flex flex-nowrap items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#af4408] text-white flex items-center justify-center shrink-0">
            <Beaker size={20} />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-bold text-[#af4408] leading-tight">Oil Quality Checks</h1>
            <p className="text-xs sm:text-sm text-[#6B5744]">
              Fryer oil judged, changed, and accounted for when it leaves
            </p>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

/** A reading that may genuinely be "not measured". NEVER prints 0 for a null. */
function Reading({ v, suffix }: { v: number | null; suffix?: string }) {
  if (v === null || v === undefined) return <span className="text-[#8B7355]">not measured</span>;
  return <>{v}{suffix || ''}</>;
}

/**
 * The verdict, in one chip, with THREE states and not two. "Not judged" is its
 * own answer: a fryer nobody has a limit for is not a passing fryer, and painting
 * it green would be the single most misleading thing this screen could do.
 */
function Verdict({ c }: { c: OilCheck }) {
  if (!c.is_judged) {
    return (
      <span className="text-[11px] px-1.5 py-0.5 rounded border bg-gray-100 text-gray-600 border-gray-200">
        Not judged
      </span>
    );
  }
  return c.is_fail ? (
    <span className="text-[11px] px-1.5 py-0.5 rounded border bg-red-100 text-red-700 border-red-200">
      Not fit for use
    </span>
  ) : (
    <span className="text-[11px] px-1.5 py-0.5 rounded border bg-green-100 text-green-700 border-green-200">
      In order
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

export default function FssaiOilQualityPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('checks');
  const [toast, setToast] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const onAuthError = useCallback((message: string) => {
    if (/sign in|401/i.test(message)) { setSignedOut(true); return true; }
    return false;
  }, []);

  if (signedOut) {
    return (
      <Shell>
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 text-center">
          <Lock className="w-6 h-6 mx-auto mb-2 text-[#8B7355]" />
          <p className="text-sm text-[#3D2614]">Please sign in to see the oil records.</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`text-sm px-3 py-2 rounded-lg border font-medium min-h-[44px] ${
              tab === t.key
                ? 'bg-[#af4408] border-[#af4408] text-white'
                : 'bg-white border-[#E8D5C4] text-[#6B5744] hover:border-[#af4408]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'checks' && <ChecksTab onAuthError={onAuthError} onToast={setToast} />}
      {tab === 'collections' && <CollectionsTab onAuthError={onAuthError} onToast={setToast} />}

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] bg-[#2D1B0E] text-white text-sm px-4 py-2.5 rounded-xl shadow-lg max-w-[90vw]">
          {toast}
        </div>
      )}
    </Shell>
  );
}

/* ------------------------------------------------------------------ *
 * OIL CHECKS
 * ------------------------------------------------------------------ */

function ChecksTab({
  onAuthError, onToast,
}: { onAuthError: (m: string) => boolean; onToast: (m: string) => void }) {
  const [data, setData] = useState<OilResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<'live' | 'fail' | 'unjudged' | 'void' | 'all'>('live');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [open, setOpen] = useState<OilCheck | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const p = new URLSearchParams();
      if (filter === 'fail') { p.set('fail', '1'); }
      else if (filter === 'unjudged') { p.set('unjudged', '1'); }
      else { p.set('status', filter === 'all' ? 'all' : filter); }
      if (q.trim()) p.set('q', q.trim());
      if (from) p.set('from', from);
      if (to) p.set('to', to);
      setData(await apiJson<OilResponse>(`/api/fssai/oil?${p}`));
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Could not load the oil checks';
      if (!onAuthError(m)) setErr(m);
    } finally { setLoading(false); }
  }, [filter, q, from, to, onAuthError]);

  useEffect(() => { void load(); }, [load]);

  return (
    <>
      {/* ── where the limit comes from, said before anything else ─────────── */}
      {data && (
        <div className={`border rounded-xl p-3 sm:p-4 ${data.standard ? 'bg-[#FFF1E3] border-[#E8D5C4]' : 'bg-amber-50 border-amber-200'}`}>
          <div className="flex flex-nowrap items-start gap-2.5">
            {data.standard
              ? <Info size={16} className="text-[#af4408] shrink-0 mt-0.5" />
              : <HelpCircle size={16} className="text-amber-800 shrink-0 mt-0.5" />}
            <div className="min-w-0">
              {data.standard ? (
                <p className="text-[13px] text-[#3D2614] leading-relaxed">
                  Readings are judged against <strong>{data.standard.label || data.standard.code}</strong>
                  {data.standard.max_value !== null && <> — no more than <strong>{data.standard.max_value}{data.standard.uom === 'pct' ? '%' : ` ${data.standard.uom}`}</strong></>}
                  {data.standard.authority ? ` (${data.standard.authority})` : ''}. The limit used is
                  frozen onto each record, so changing the standard later never re-judges a check
                  that has already been filed.
                </p>
              ) : (
                <p className="text-[13px] text-amber-900 leading-relaxed">
                  {data.unjudged_notice} Until then you can type the limit your meter or your own
                  procedure uses on each check — it is recorded with the reading, so the file always
                  says what the oil was judged against. The FSSAI figure is{' '}
                  <strong>{data.suggested_limit_tpm_pct}%</strong>.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {data && data.counts.failed > 0 && filter !== 'fail' && (
        <button
          onClick={() => setFilter('fail')}
          className="w-full text-left bg-red-50 border border-red-200 rounded-xl p-3 hover:border-red-400"
        >
          <div className="flex flex-nowrap items-start gap-2.5">
            <AlertTriangle size={16} className="text-red-700 shrink-0 mt-0.5" />
            <p className="text-[13px] text-red-900">
              <strong>
                {data.counts.failed} check{data.counts.failed === 1 ? '' : 's'} recorded oil that was not fit for use.
              </strong>{' '}
              Tap to see just those.
            </p>
          </div>
        </button>
      )}

      <div className="flex flex-wrap gap-1.5">
        {([
          { key: 'live', label: 'All checks', n: data?.counts.live },
          { key: 'fail', label: 'Failed', n: data?.counts.failed },
          { key: 'unjudged', label: 'Not judged', n: data?.counts.unjudged },
          { key: 'void', label: 'Voided', n: data?.counts.void },
        ] as const).map((t) => (
          <button
            key={t.key}
            onClick={() => setFilter(t.key)}
            className={`text-sm px-3 py-2 rounded-lg border font-medium min-h-[44px] ${
              filter === t.key
                ? 'bg-[#af4408] border-[#af4408] text-white'
                : 'bg-white border-[#E8D5C4] text-[#6B5744] hover:border-[#af4408]'
            }`}
          >
            {t.label}
            {typeof t.n === 'number' && (
              <span className={`ml-1.5 text-xs ${filter === t.key ? 'text-white/80' : 'text-[#8B7355]'}`}>{t.n}</span>
            )}
          </button>
        ))}
        <button
          onClick={() => void load()}
          aria-label="Reload"
          className="w-11 h-11 rounded-lg border border-[#E8D5C4] bg-white hover:border-[#af4408] flex items-center justify-center"
        >
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
        {data?.can_record && (
          <button
            onClick={() => setShowNew(true)}
            className="ml-auto min-h-[44px] px-3 rounded-lg bg-[#af4408] text-white text-sm font-medium flex flex-nowrap items-center gap-1.5"
          >
            <Plus size={16} /> Record a check
          </button>
        )}
      </div>

      <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 grid grid-cols-1 sm:grid-cols-4 gap-2">
        <div className="sm:col-span-2 relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8B7355]" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Fryer, oil, who checked it" className={`${INPUT} pl-9`} />
        </div>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={INPUT} aria-label="From" />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={INPUT} aria-label="To" />
      </div>

      {err && <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-800">{err}</div>}

      {loading && !data ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center">
          <Loader2 className="w-6 h-6 mx-auto animate-spin text-[#af4408]" />
        </div>
      ) : (data?.checks.length ?? 0) === 0 ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 text-center">
          <ShieldCheck className="w-6 h-6 mx-auto mb-2 text-[#8B7355]" />
          <p className="text-sm text-[#3D2614]">
            {q || from || to || filter !== 'live'
              ? 'Nothing here matches what you asked for.'
              : 'No oil check has been recorded yet.'}
          </p>
          <p className="text-xs text-[#6B5744] mt-1">
            An empty list means nothing was recorded — not that every fryer was fine.
          </p>
        </div>
      ) : (
        <>
          <div className="md:hidden space-y-2">
            {data!.checks.map((c) => (
              <button
                key={c.id}
                onClick={() => setOpen(c)}
                className="w-full text-left bg-white border border-[#E8D5C4] rounded-xl p-3 hover:border-[#af4408]"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <Verdict c={c} />
                  {c.status === 'void' && (
                    <span className={`text-[11px] px-1.5 py-0.5 rounded border ${fssaiRecordStatusMeta('void').color}`}>Voided</span>
                  )}
                  {c.ca_number && (
                    <span className="text-[11px] px-1.5 py-0.5 rounded border bg-amber-50 text-amber-900 border-amber-200">{c.ca_number}</span>
                  )}
                </div>
                <p className="text-sm font-semibold mt-1.5">{c.equipment_label}</p>
                <p className="text-xs text-[#6B5744] mt-0.5">
                  {fmtISTDate(c.business_date)}{c.shift ? ` · ${c.shift}` : ''} · {c.method_label}
                </p>
                <p className="text-xs mt-1">
                  {c.tpm_pct !== null
                    ? <>TPM <strong>{c.tpm_display}%</strong>{c.max_tpm_used !== null ? ` against ${c.max_tpm_used}%` : ''}</>
                    : <span className="text-[#8B7355]">No meter reading</span>}
                </p>
                {c.fail_reason && <p className="text-xs text-red-800 mt-1">{c.fail_reason}</p>}
              </button>
            ))}
          </div>

          <div className="hidden md:block bg-white border border-[#E8D5C4] rounded-xl overflow-x-auto">
            <table className="w-full text-sm min-w-[46rem]">
              <thead className="bg-[#FFF1E3] text-[#6B5744]">
                <tr>
                  <th className="text-left font-semibold px-4 py-2">Verdict</th>
                  <th className="text-left font-semibold px-4 py-2">Fryer</th>
                  <th className="text-left font-semibold px-4 py-2">When</th>
                  <th className="text-left font-semibold px-4 py-2">How judged</th>
                  <th className="text-left font-semibold px-4 py-2">Reading</th>
                  <th className="text-left font-semibold px-4 py-2">What was done</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E8D5C4]">
                {data!.checks.map((c) => (
                  <tr key={c.id} onClick={() => setOpen(c)} className={`cursor-pointer hover:bg-[#FFF8F0] ${c.status === 'void' ? 'opacity-60' : ''}`}>
                    <td className="px-4 py-2 align-top">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Verdict c={c} />
                        {c.ca_number && (
                          <span className="text-[11px] px-1.5 py-0.5 rounded border bg-amber-50 text-amber-900 border-amber-200">{c.ca_number}</span>
                        )}
                      </div>
                      {c.fail_reason && <span className="block text-xs text-red-800 mt-1 max-w-[16rem]">{c.fail_reason}</span>}
                    </td>
                    <td className="px-4 py-2 align-top">
                      <span className="text-[#2D1B0E]">{c.equipment_label}</span>
                      {c.oil_type && <span className="block text-xs text-[#8B7355]">{c.oil_type}</span>}
                    </td>
                    <td className="px-4 py-2 align-top text-xs">
                      {fmtISTDate(c.business_date)}
                      {(c.checked_at || c.shift) && (
                        <span className="block text-[#8B7355]">{[c.checked_at, c.shift].filter(Boolean).join(' · ')}</span>
                      )}
                    </td>
                    <td className="px-4 py-2 align-top text-xs">{c.method_label}</td>
                    <td className="px-4 py-2 align-top text-xs">
                      {c.tpm_pct !== null ? <>{c.tpm_display}% TPM</> : <span className="text-[#8B7355]">no reading</span>}
                      {c.max_tpm_used !== null && <span className="block text-[#8B7355]">limit {c.max_tpm_used}%</span>}
                    </td>
                    <td className="px-4 py-2 align-top text-xs">
                      {c.action_taken ? c.action_label : <span className="text-[#8B7355]">left in use</span>}
                      {c.qty_discarded !== null && (
                        <span className="block text-[#8B7355]">{c.qty_discarded} {c.qty_uom} out</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {data?.truncated && (
        <p className="text-xs text-[#8B7355]">Only the most recent checks are shown. Narrow the dates to see further back.</p>
      )}

      {showNew && data && (
        <NewCheckModal
          fryers={data.fryers}
          standard={data.standard}
          suggestedLimit={data.suggested_limit_tpm_pct}
          sensory={data.sensory}
          onClose={() => setShowNew(false)}
          onSaved={(m) => { setShowNew(false); onToast(m); void load(); }}
        />
      )}

      {open && (
        <CheckModal
          check={open}
          isManagement={!!data?.is_management}
          me={data?.me || ''}
          onClose={() => setOpen(null)}
          onChanged={(m) => { setOpen(null); onToast(m); void load(); }}
        />
      )}
    </>
  );
}

function NewCheckModal({
  fryers, standard, suggestedLimit, sensory, onClose, onSaved,
}: {
  fryers: Fryer[];
  standard: StandardView | null;
  suggestedLimit: number;
  sensory: { key: string; label: string; hint: string }[];
  onClose: () => void;
  onSaved: (m: string) => void;
}) {
  const [businessDate, setBusinessDate] = useState(fssaiToday());
  const [checkedAt, setCheckedAt] = useState('');
  const [shift, setShift] = useState('');
  const [equipmentId, setEquipmentId] = useState('');
  const [typedFryer, setTypedFryer] = useState('');
  const [oilType, setOilType] = useState('');
  const [method, setMethod] = useState('');
  const [tpm, setTpm] = useState('');
  const [limit, setLimit] = useState('');
  const [ffa, setFfa] = useState('');
  const [tempC, setTempC] = useState('');
  const [colour, setColour] = useState('');
  const [ticks, setTicks] = useState<Record<string, string>>({});
  const [actionTaken, setActionTaken] = useState('');
  const [qtyDiscarded, setQtyDiscarded] = useState('');
  const [qtyAdded, setQtyAdded] = useState('');
  const [hours, setHours] = useState('');
  const [note, setNote] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const j = await apiJson<CheckResult>('/api/fssai/oil', {
        method: 'POST',
        body: {
          action: 'record',
          business_date: businessDate,
          checked_at: checkedAt,
          shift,
          equipment_id: equipmentId,
          equipment_label: equipmentId ? '' : typedFryer,
          oil_type: oilType,
          method,
          tpm_pct: tpm,
          limit_tpm_pct: limit,
          ffa_pct: ffa,
          temp_c: tempC,
          colour_grade: colour,
          chk_smell: ticks.chk_smell || '',
          chk_foaming: ticks.chk_foaming || '',
          chk_smoking: ticks.chk_smoking || '',
          action_taken: actionTaken,
          qty_discarded: qtyDiscarded,
          qty_added: qtyAdded,
          hours_in_use: hours,
          note,
          photos: photos.map((p) => ({ data_uri: p, kind: 'photo' })),
        },
      });
      onSaved(
        j?.corrective_action
          ? `Recorded. The oil failed, and corrective action ${j.corrective_action.ca_number} was raised.`
          : (j?.verdict?.is_judged ? 'Recorded, and the oil was in order.' : 'Recorded. Nothing was judged — no limit is set yet.'),
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save the check');
    } finally { setBusy(false); }
  };

  return (
    <ModalFrame title="Record an oil check" onClose={onClose}>
      <div className="space-y-3">
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 space-y-2">
          <Field label="Which fryer">
            {fryers.length > 0 ? (
              <select value={equipmentId} onChange={(e) => setEquipmentId(e.target.value)} className={INPUT}>
                <option value="">Not in the register — I will type it</option>
                {fryers.map((f) => (
                  <option key={f.id} value={f.id}>{f.name}{f.location_label ? ` — ${f.location_label}` : ''}</option>
                ))}
              </select>
            ) : (
              <p className="text-xs text-[#6B5744]">
                {/* The honest reason the dropdown is missing, rather than an empty
                  * select that reads as a broken screen. */}
                No fryer is in the equipment register yet, so type which one this was. Once the
                fryers are registered they will appear here.
              </p>
            )}
            {!equipmentId && (
              <input
                value={typedFryer}
                onChange={(e) => setTypedFryer(e.target.value)}
                placeholder="Fryer 1, main range left, …"
                className={`${INPUT} ${fryers.length > 0 ? 'mt-2' : ''}`}
              />
            )}
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <Field label="Date">
              <input type="date" value={businessDate} onChange={(e) => setBusinessDate(e.target.value)} className={INPUT} />
            </Field>
            <Field label="Time (optional)">
              <input value={checkedAt} onChange={(e) => setCheckedAt(e.target.value)} placeholder="HH:MM" inputMode="numeric" className={INPUT} />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Field label="Shift">
              <select value={shift} onChange={(e) => setShift(e.target.value)} className={INPUT}>
                {FSSAI_SHIFTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </Field>
            <Field label="Which oil">
              <input value={oilType} onChange={(e) => setOilType(e.target.value)} placeholder="Sunflower, palmolein…" className={INPUT} />
            </Field>
          </div>
        </div>

        <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 space-y-2">
          <Field label="How was it judged">
            <div className="grid grid-cols-1 gap-1.5">
              {FSSAI_OIL_METHODS.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => setMethod(m.key)}
                  className={`min-h-[44px] text-left text-sm px-3 rounded-lg border ${
                    method === m.key ? 'bg-[#af4408] border-[#af4408] text-white' : 'bg-white border-[#E8D5C4] text-[#6B5744]'
                  }`}
                >
                  <span className="font-medium">{m.label}</span>
                  <span className={`block text-xs ${method === m.key ? 'text-white/80' : 'text-[#8B7355]'}`}>{m.hint}</span>
                </button>
              ))}
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <Field label="TPM reading (%)">
              <input value={tpm} onChange={(e) => setTpm(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" placeholder="blank = not measured" className={INPUT} />
            </Field>
            <Field label={standard ? 'Limit (set in Settings)' : 'Limit to judge against (%)'}>
              {standard ? (
                <p className={`${INPUT} bg-[#FFF1E3] text-[#6B5744]`}>
                  {standard.max_value === null ? 'no maximum set' : `${standard.max_value}%`}
                </p>
              ) : (
                <input
                  value={limit}
                  onChange={(e) => setLimit(e.target.value.replace(/[^\d.]/g, ''))}
                  inputMode="decimal"
                  placeholder={`e.g. ${suggestedLimit}`}
                  className={INPUT}
                />
              )}
            </Field>
          </div>
          {!standard && (
            <p className="text-xs text-[#6B5744]">
              Whatever you type here is recorded with the reading, so the file always says what the
              oil was judged against. Leave it blank and the reading is kept but not judged.
            </p>
          )}

          <div className="grid grid-cols-3 gap-2">
            <Field label="FFA (%)">
              <input value={ffa} onChange={(e) => setFfa(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" className={INPUT} />
            </Field>
            <Field label="Oil temp (°C)">
              <input value={tempC} onChange={(e) => setTempC(e.target.value.replace(/[^\d.-]/g, ''))} inputMode="decimal" className={INPUT} />
            </Field>
            <Field label="Colour band">
              <input value={colour} onChange={(e) => setColour(e.target.value)} className={INPUT} />
            </Field>
          </div>

          {/* ── the three-way tick-boxes ─────────────────────────────────── */}
          <div className="space-y-2">
            {sensory.map((s) => (
              <div key={s.key}>
                <p className="text-xs text-[#6B5744]">{s.label} <span className="text-[#8B7355]">— {s.hint}</span></p>
                <div className="grid grid-cols-4 gap-1.5 mt-1">
                  {FSSAI_CHECK_RESULTS.map((r) => (
                    <button
                      key={r.key || 'blank'}
                      type="button"
                      onClick={() => setTicks((t) => ({ ...t, [s.key]: r.key }))}
                      className={`min-h-[44px] text-xs px-1 rounded-lg border font-medium ${
                        (ticks[s.key] || '') === r.key
                          ? 'bg-[#af4408] border-[#af4408] text-white'
                          : 'bg-white border-[#E8D5C4] text-[#6B5744]'
                      }`}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <p className="text-xs text-[#6B5744]">
              <strong>Not checked</strong> is not a pass. It means nobody looked, and the record says
              so — which is the honest answer and is what makes a real check worth something.
            </p>
          </div>
        </div>

        <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 space-y-2">
          <Field label="What was done to the oil">
            <select value={actionTaken} onChange={(e) => setActionTaken(e.target.value)} className={INPUT}>
              {FSSAI_OIL_ACTIONS.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
            </select>
          </Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Taken out (L)">
              <input value={qtyDiscarded} onChange={(e) => setQtyDiscarded(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" className={INPUT} />
            </Field>
            <Field label="Added (L)">
              <input value={qtyAdded} onChange={(e) => setQtyAdded(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" className={INPUT} />
            </Field>
            <Field label="Hours in use">
              <input value={hours} onChange={(e) => setHours(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" className={INPUT} />
            </Field>
          </div>
          <Field label="Note">
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className={INPUT} />
          </Field>
          <Field label="Photographs">
            <ImageUpload multiple max={4} value={photos} onChange={setPhotos} label="Add a photo" />
          </Field>
        </div>

        {err && <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-800">{err}</div>}

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => void submit()}
            disabled={busy || !method || (!equipmentId && !typedFryer.trim())}
            className="flex-1 min-h-[48px] rounded-xl bg-[#af4408] text-white font-semibold disabled:opacity-50 flex flex-nowrap items-center justify-center gap-2"
          >
            {busy ? <Loader2 size={18} className="animate-spin" /> : <Check size={18} />}
            Record the check
          </button>
          <button onClick={onClose} className="min-h-[48px] px-4 rounded-xl border border-[#E8D5C4] bg-white text-sm">Cancel</button>
        </div>
      </div>
    </ModalFrame>
  );
}

function CheckModal({
  check, isManagement, me, onClose, onChanged,
}: {
  check: OilCheck;
  isManagement: boolean;
  me: string;
  onClose: () => void;
  onChanged: (m: string) => void;
}) {
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const doVoid = async () => {
    setBusy(true); setErr(null);
    try {
      await apiJson('/api/fssai/oil', { method: 'POST', body: { action: 'void', id: check.id, reason } });
      onChanged('Voided. The check stays in the file with your reason on it.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not void that');
    } finally { setBusy(false); }
  };

  return (
    <ModalFrame title={check.equipment_label || 'Oil check'} onClose={onClose}>
      <div className="space-y-3">
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <Verdict c={check} />
            {check.status === 'void' && (
              <span className={`text-[11px] px-1.5 py-0.5 rounded border ${fssaiRecordStatusMeta('void').color}`}>Voided</span>
            )}
            {check.ca_number && (
              <span className="text-[11px] px-1.5 py-0.5 rounded border bg-amber-50 text-amber-900 border-amber-200">
                {check.ca_number} · {check.ca_status}
              </span>
            )}
          </div>
          <p className="text-base font-semibold mt-1.5">{check.equipment_label}</p>
          <p className="text-xs text-[#6B5744] mt-0.5">
            {fmtISTDate(check.business_date)}
            {check.checked_at ? ` at ${check.checked_at}` : ''}
            {check.shift ? ` · ${check.shift}` : ''}
            {check.department_name ? ` · ${check.department_name}` : ''}
          </p>
          <p className="text-xs text-[#6B5744] mt-0.5">
            Recorded by {check.recorded_name || check.recorded_by || 'unknown'} · {fmtIST(check.created_at)}
          </p>
          {check.fail_reason && <p className="text-sm text-red-800 mt-2">{check.fail_reason}</p>}
          {!check.is_judged && (
            <p className="text-xs text-[#6B5744] mt-2">
              {/* The third state, said in words on the record itself. */}
              Nothing on this check was judged pass or fail: there was no limit to judge the reading
              against and none of the look-and-smell boxes was answered. The reading is on the file
              exactly as it was taken.
            </p>
          )}
        </div>

        <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
          <p className="text-xs font-semibold text-[#6B5744] mb-1.5">The reading</p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <div><dt className="text-[#6B5744]">How it was judged</dt><dd>{check.method_label}</dd></div>
            <div><dt className="text-[#6B5744]">TPM</dt><dd><Reading v={check.tpm_pct} suffix="%" /></dd></div>
            <div>
              <dt className="text-[#6B5744]">Limit applied</dt>
              <dd>
                <Reading v={check.max_tpm_used} suffix="%" />
                {check.max_tpm_used !== null && (
                  <span className="block text-[#8B7355]">
                    {check.standard_id
                      ? `from ${check.standard_label || check.standard_code}`
                      : 'typed in at the time of the check'}
                  </span>
                )}
              </dd>
            </div>
            <div><dt className="text-[#6B5744]">FFA</dt><dd><Reading v={check.ffa_pct} suffix="%" /></dd></div>
            <div><dt className="text-[#6B5744]">Oil temperature</dt><dd><Reading v={check.temp_c} suffix=" °C" /></dd></div>
            <div><dt className="text-[#6B5744]">Hours in use</dt><dd><Reading v={check.hours_in_use} /></dd></div>
          </dl>
          {check.colour_grade && <p className="text-xs text-[#6B5744] mt-1">Colour band: {check.colour_grade}</p>}

          <div className="mt-2 flex flex-wrap gap-1.5">
            {check.sensory.map((s) => (
              <span
                key={s.key}
                className={`text-[11px] px-1.5 py-0.5 rounded border ${
                  s.is_fail
                    ? 'bg-red-100 text-red-700 border-red-200'
                    : s.result === 'ok'
                      ? 'bg-green-100 text-green-700 border-green-200'
                      : 'bg-gray-100 text-gray-500 border-gray-200'
                }`}
              >
                {s.label}: {s.result_label || 'Not checked'}
              </span>
            ))}
          </div>
        </div>

        <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
          <p className="text-xs font-semibold text-[#6B5744] mb-1">What was done</p>
          <p className="text-sm">{check.action_taken ? check.action_label : 'Nothing — the oil was left in use.'}</p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs mt-1.5">
            <div><dt className="text-[#6B5744]">Taken out</dt><dd><Reading v={check.qty_discarded} suffix={` ${check.qty_uom}`} /></dd></div>
            <div><dt className="text-[#6B5744]">Added</dt><dd><Reading v={check.qty_added} suffix={` ${check.qty_uom}`} /></dd></div>
          </dl>
          {check.disposal_id ? (
            <p className="text-xs text-[#6B5744] mt-1.5">
              Attached to the collection of {fmtISTDate(check.disposal_date)}
              {check.disposal_receipt ? ` (receipt ${check.disposal_receipt})` : ''}.
            </p>
          ) : check.qty_discarded !== null && check.qty_discarded > 0 ? (
            <p className="text-xs text-amber-800 mt-1.5">
              This oil is not yet attached to a collection, so the file does not say where it went.
            </p>
          ) : null}
          {check.note && <p className="text-xs text-[#3D2614] mt-2 whitespace-pre-wrap">{check.note}</p>}
        </div>

        {(check.photos?.length ?? 0) > 0 && (
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
            <p className="text-xs font-semibold text-[#6B5744] mb-2">Photographs</p>
            <div className="flex flex-wrap gap-2">
              {check.photos!.map((p) => (
                p.image_dropped_at ? (
                  <div key={p.id} className="w-14 h-14 rounded-lg border border-[#E8D5C4] bg-[#FFF1E3] flex items-center justify-center">
                    <span className="text-[10px] text-[#8B7355] px-1">aged out</span>
                  </div>
                ) : (
                  <ImageThumb key={p.id} src={`/api/fssai/oil/photo?of=check&id=${encodeURIComponent(p.id)}`} size={56} />
                )
              ))}
            </div>
          </div>
        )}

        {check.void_reason && (
          <div className="bg-gray-50 border border-gray-200 rounded-xl p-3">
            <p className="text-xs font-semibold text-gray-700">Voided</p>
            <p className="text-sm text-gray-700 mt-0.5">{check.void_reason}</p>
            <p className="text-xs text-gray-500 mt-0.5">{check.voided_by} · {fmtIST(check.voided_at)}</p>
          </div>
        )}

        {err && <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-800">{err}</div>}

        {voiding ? (
          <div className="bg-white border border-red-300 rounded-xl p-3 space-y-2">
            <p className="text-xs text-[#3D2614]">
              A voided check stays in the file for ever with your reason on it. A reading is never
              deleted, and voiding one does not change any corrective action already raised from it.
            </p>
            <Field label="Why is this being voided">
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Recorded against the wrong fryer, duplicate, …" className={INPUT} />
            </Field>
            <button
              onClick={() => void doVoid()}
              disabled={busy || reason.trim().length < 4}
              className="w-full min-h-[48px] rounded-xl bg-red-700 text-white font-semibold disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Void this check'}
            </button>
          </div>
        ) : check.status !== 'void' && isManagement ? (
          <button
            onClick={() => setVoiding(true)}
            className="min-h-[48px] px-3 rounded-xl border border-red-300 bg-white text-red-700 text-sm font-medium flex flex-nowrap items-center gap-1.5"
          >
            <Trash2 size={15} /> Void this check
          </button>
        ) : check.status !== 'void' ? (
          <p className="text-xs text-[#6B5744]">
            Only a manager, head of department or administrator can void a compliance record.
          </p>
        ) : null}

        {me && check.recorded_by.toLowerCase() === me.toLowerCase() && isManagement && check.status !== 'void' && (
          <p className="text-xs text-amber-800">
            You recorded this check yourself. A void is meant to be somebody else&apos;s decision.
          </p>
        )}
      </div>
    </ModalFrame>
  );
}

/* ------------------------------------------------------------------ *
 * USED-OIL COLLECTIONS
 * ------------------------------------------------------------------ */

function CollectionsTab({
  onAuthError, onToast,
}: { onAuthError: (m: string) => boolean; onToast: (m: string) => void }) {
  const [data, setData] = useState<DisposalResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('live');
  const [showNew, setShowNew] = useState(false);
  const [open, setOpen] = useState<Disposal | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const p = new URLSearchParams({ status });
      if (q.trim()) p.set('q', q.trim());
      setData(await apiJson<DisposalResponse>(`/api/fssai/oil/disposals?${p}`));
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Could not load the collections';
      if (!onAuthError(m)) setErr(m);
    } finally { setLoading(false); }
  }, [q, status, onAuthError]);

  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl p-3 sm:p-4">
        <div className="flex flex-nowrap items-start gap-2.5">
          <Truck size={16} className="text-[#af4408] shrink-0 mt-0.5" />
          <p className="text-[13px] text-[#3D2614] leading-relaxed">
            <strong>Where the used oil went.</strong> Who collected it, under what registration, how
            much, and the receipt — that is what gets asked for. There is deliberately no money on
            this screen: a value here would make it a second place the business records income,
            outside the ledgers that own that number.
          </p>
        </div>
      </div>

      {data && data.uncollected.checks > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
          <div className="flex flex-nowrap items-start gap-2.5">
            <AlertTriangle size={16} className="text-amber-800 shrink-0 mt-0.5" />
            <p className="text-[13px] text-amber-900">
              <strong>
                {data.uncollected.checks} oil check{data.uncollected.checks === 1 ? '' : 's'} recorded
                oil taken out ({data.uncollected.quantity} L in total) with no collection against
                {data.uncollected.checks === 1 ? ' it' : ' them'}.
              </strong>{' '}
              {data.uncollected.note} Attach them when you record the next collection.
            </p>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {[
          { key: 'live', label: 'Collections' },
          { key: 'void', label: 'Voided' },
          { key: 'all', label: 'All' },
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => setStatus(t.key)}
            className={`text-sm px-3 py-2 rounded-lg border font-medium min-h-[44px] ${
              status === t.key
                ? 'bg-[#af4408] border-[#af4408] text-white'
                : 'bg-white border-[#E8D5C4] text-[#6B5744] hover:border-[#af4408]'
            }`}
          >
            {t.label}
          </button>
        ))}
        {data?.can_record && (
          <button
            onClick={() => setShowNew(true)}
            className="ml-auto min-h-[44px] px-3 rounded-lg bg-[#af4408] text-white text-sm font-medium flex flex-nowrap items-center gap-1.5"
          >
            <Plus size={16} /> Record a collection
          </button>
        )}
      </div>

      <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8B7355]" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Collector, registration, receipt, vehicle" className={`${INPUT} pl-9`} />
        </div>
      </div>

      {err && <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-800">{err}</div>}

      {loading && !data ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center">
          <Loader2 className="w-6 h-6 mx-auto animate-spin text-[#af4408]" />
        </div>
      ) : (data?.disposals.length ?? 0) === 0 ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 text-center">
          <Truck className="w-6 h-6 mx-auto mb-2 text-[#8B7355]" />
          <p className="text-sm text-[#3D2614]">No used-oil collection has been recorded yet.</p>
          <p className="text-xs text-[#6B5744] mt-1">
            If oil is being changed and nothing is recorded here, the file cannot say where it went.
          </p>
        </div>
      ) : (
        <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-x-auto">
          <table className="w-full text-sm min-w-[42rem]">
            <thead className="bg-[#FFF1E3] text-[#6B5744]">
              <tr>
                <th className="text-left font-semibold px-4 py-2">Date</th>
                <th className="text-left font-semibold px-4 py-2">Collector</th>
                <th className="text-left font-semibold px-4 py-2">Registration</th>
                <th className="text-left font-semibold px-4 py-2">Quantity</th>
                <th className="text-left font-semibold px-4 py-2">Receipt</th>
                <th className="text-left font-semibold px-4 py-2">Checks attached</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E8D5C4]">
              {data!.disposals.map((d) => (
                <tr key={d.id} onClick={() => setOpen(d)} className={`cursor-pointer hover:bg-[#FFF8F0] ${d.status === 'void' ? 'opacity-60' : ''}`}>
                  <td className="px-4 py-2 align-top text-xs">
                    {fmtISTDate(d.business_date)}
                    {d.collected_at && <span className="block text-[#8B7355]">{d.collected_at}</span>}
                  </td>
                  <td className="px-4 py-2 align-top">
                    <span className="text-[#2D1B0E]">{d.vendor_name || d.collector_name}</span>
                    {d.vehicle_no && <span className="block text-xs text-[#8B7355]">{d.vehicle_no}</span>}
                  </td>
                  <td className="px-4 py-2 align-top text-xs">
                    {d.agency_reg_no || <span className="text-amber-800">none recorded</span>}
                  </td>
                  <td className="px-4 py-2 align-top text-xs">
                    <Reading v={d.quantity} suffix={` ${d.uom}`} />
                    {d.quantity_matches_checks === false && (
                      <span className="block text-amber-800">
                        checks say {d.linked_discarded_qty} {d.uom}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 align-top text-xs">{d.receipt_no || '—'}</td>
                  <td className="px-4 py-2 align-top text-xs">{d.linked_checks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showNew && data && (
        <NewCollectionModal
          vendors={data.vendors}
          onClose={() => setShowNew(false)}
          onSaved={(m) => { setShowNew(false); onToast(m); void load(); }}
        />
      )}

      {open && (
        <CollectionModal
          disposal={open}
          isManagement={!!data?.is_management}
          onClose={() => setOpen(null)}
          onChanged={(m) => { setOpen(null); onToast(m); void load(); }}
        />
      )}
    </>
  );
}

function NewCollectionModal({
  vendors, onClose, onSaved,
}: { vendors: { id: string; name: string }[]; onClose: () => void; onSaved: (m: string) => void }) {
  const [businessDate, setBusinessDate] = useState(fssaiToday());
  const [collectedAt, setCollectedAt] = useState('');
  const [vendorId, setVendorId] = useState('');
  const [collectorName, setCollectorName] = useState('');
  const [regNo, setRegNo] = useState('');
  const [vehicle, setVehicle] = useState('');
  const [quantity, setQuantity] = useState('');
  const [uom, setUom] = useState('L');
  const [receipt, setReceipt] = useState('');
  const [handedOver, setHandedOver] = useState('');
  const [note, setNote] = useState('');
  const [docs, setDocs] = useState<string[]>([]);
  const [uncollected, setUncollected] = useState<{ id: string; business_date: string; equipment_label: string; qty_discarded: number | null; qty_uom: string }[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    /* The checks whose oil has nowhere to go yet, offered for attaching. One
     * collection covers several fryers over several days — which is exactly why
     * the collection is its own record and not a column on the check. */
    apiJson<OilResponse>('/api/fssai/oil?status=live')
      .then((j) => setUncollected(
        (j.checks || [])
          .filter((c) => !c.disposal_id && c.qty_discarded !== null && c.qty_discarded > 0)
          .map((c) => ({
            id: c.id, business_date: c.business_date, equipment_label: c.equipment_label,
            qty_discarded: c.qty_discarded, qty_uom: c.qty_uom,
          })),
      ))
      .catch(() => setUncollected([]));
  }, []);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const j = await apiJson<CollectionResult>('/api/fssai/oil/disposals', {
        method: 'POST',
        body: {
          action: 'record',
          business_date: businessDate,
          collected_at: collectedAt,
          vendor_id: vendorId,
          collector_name: vendorId ? '' : collectorName,
          agency_reg_no: regNo,
          vehicle_no: vehicle,
          quantity,
          uom,
          receipt_no: receipt,
          handed_over_by: handedOver,
          note,
          check_ids: picked,
          documents: docs.map((d) => ({ data_uri: d, kind: 'document' })),
        },
      });
      onSaved(j?.warning ? `Recorded. ${j.warning}` : 'Collection recorded.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save the collection');
    } finally { setBusy(false); }
  };

  return (
    <ModalFrame title="Record a used-oil collection" onClose={onClose}>
      <div className="space-y-3">
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Date">
              <input type="date" value={businessDate} onChange={(e) => setBusinessDate(e.target.value)} className={INPUT} />
            </Field>
            <Field label="Time (optional)">
              <input value={collectedAt} onChange={(e) => setCollectedAt(e.target.value)} placeholder="HH:MM" inputMode="numeric" className={INPUT} />
            </Field>
          </div>

          <Field label="Who collected it">
            <select value={vendorId} onChange={(e) => setVendorId(e.target.value)} className={INPUT}>
              <option value="">Not one of our vendors — I will type the name</option>
              {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
            {!vendorId && (
              <input value={collectorName} onChange={(e) => setCollectorName(e.target.value)} placeholder="Collector or agency name" className={`${INPUT} mt-2`} />
            )}
          </Field>

          <Field label="His registration number">
            <input value={regNo} onChange={(e) => setRegNo(e.target.value)} placeholder="The agency's RUCO / collector registration" className={INPUT} />
            <p className="text-xs text-[#6B5744] mt-1">
              This is the thing an inspector asks about. If he genuinely has none, say so in the note
              below — a blank box answers nothing, a sentence does.
            </p>
          </Field>

          <div className="grid grid-cols-3 gap-2">
            <Field label="Quantity">
              <input value={quantity} onChange={(e) => setQuantity(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" className={INPUT} />
            </Field>
            <Field label="Unit">
              <input value={uom} onChange={(e) => setUom(e.target.value)} className={INPUT} />
            </Field>
            <Field label="Vehicle">
              <input value={vehicle} onChange={(e) => setVehicle(e.target.value)} className={INPUT} />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Field label="Receipt number">
              <input value={receipt} onChange={(e) => setReceipt(e.target.value)} className={INPUT} />
            </Field>
            <Field label="Handed over by">
              <UserPicker
                value={handedOver}
                onPick={(u) => setHandedOver(u.email)}
                allowClear
                onClear={() => setHandedOver('')}
                placeholder="Defaults to you"
              />
            </Field>
          </div>

          <Field label="Note">
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className={INPUT} />
          </Field>

          <Field label="Photograph of the receipt">
            <ImageUpload multiple max={4} value={docs} onChange={setDocs} label="Add the receipt" />
          </Field>
        </div>

        {uncollected.length > 0 && (
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
            <p className="text-xs font-semibold text-[#6B5744] mb-1.5">
              Which oil did this collection take away?
            </p>
            <div className="space-y-1.5 max-h-56 overflow-y-auto">
              {uncollected.map((c) => (
                <label key={c.id} className="flex flex-nowrap items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={picked.includes(c.id)}
                    onChange={(e) => setPicked((p) => (e.target.checked ? [...p, c.id] : p.filter((x) => x !== c.id)))}
                    className="mt-1 w-4 h-4 shrink-0 accent-[#af4408]"
                  />
                  <span className="text-xs text-[#3D2614]">
                    {fmtISTDate(c.business_date)} · {c.equipment_label} · {c.qty_discarded} {c.qty_uom}
                  </span>
                </label>
              ))}
            </div>
            <p className="text-xs text-[#6B5744] mt-1.5">
              One collection usually covers several fryers over several days. Attaching them is what
              lets the file answer &ldquo;where did that oil go&rdquo; for each one.
            </p>
          </div>
        )}

        {err && <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-800">{err}</div>}

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => void submit()}
            disabled={busy || (!vendorId && !collectorName.trim())}
            className="flex-1 min-h-[48px] rounded-xl bg-[#af4408] text-white font-semibold disabled:opacity-50 flex flex-nowrap items-center justify-center gap-2"
          >
            {busy ? <Loader2 size={18} className="animate-spin" /> : <Check size={18} />}
            Record the collection
          </button>
          <button onClick={onClose} className="min-h-[48px] px-4 rounded-xl border border-[#E8D5C4] bg-white text-sm">Cancel</button>
        </div>
      </div>
    </ModalFrame>
  );
}

function CollectionModal({
  disposal, isManagement, onClose, onChanged,
}: { disposal: Disposal; isManagement: boolean; onClose: () => void; onChanged: (m: string) => void }) {
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const doVoid = async () => {
    setBusy(true); setErr(null);
    try {
      await apiJson('/api/fssai/oil/disposals', { method: 'POST', body: { action: 'void', id: disposal.id, reason } });
      onChanged('Voided. The oil checks it covered now read as discarded but not yet collected.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not void that');
    } finally { setBusy(false); }
  };

  return (
    <ModalFrame title={disposal.vendor_name || disposal.collector_name || 'Collection'} onClose={onClose}>
      <div className="space-y-3">
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
          <p className="text-base font-semibold">{disposal.vendor_name || disposal.collector_name}</p>
          <p className="text-xs text-[#6B5744] mt-0.5">
            {fmtISTDate(disposal.business_date)}{disposal.collected_at ? ` at ${disposal.collected_at}` : ''}
          </p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 mt-2 text-xs">
            <div>
              <dt className="text-[#6B5744]">Registration</dt>
              <dd>{disposal.agency_reg_no || <span className="text-amber-800">none recorded</span>}</dd>
            </div>
            <div><dt className="text-[#6B5744]">Vehicle</dt><dd>{disposal.vehicle_no || '—'}</dd></div>
            <div><dt className="text-[#6B5744]">Quantity</dt><dd><Reading v={disposal.quantity} suffix={` ${disposal.uom}`} /></dd></div>
            <div><dt className="text-[#6B5744]">Receipt</dt><dd>{disposal.receipt_no || '—'}</dd></div>
            <div><dt className="text-[#6B5744]">Handed over by</dt><dd>{disposal.handed_over_by || '—'}</dd></div>
            <div><dt className="text-[#6B5744]">Checks attached</dt><dd>{disposal.linked_checks}</dd></div>
          </dl>
          {disposal.quantity_matches_checks === false && (
            <p className="text-xs text-amber-800 mt-2">
              {/* Both numbers are shown rather than one presented as the truth —
                * oil is drained over days and measured by eye, so they genuinely
                * differ, and hiding that would be the dishonest choice. */}
              The receipt says {disposal.quantity} {disposal.uom}; the oil checks attached add up to{' '}
              {disposal.linked_discarded_qty} {disposal.uom}. Both are on the record.
            </p>
          )}
          {disposal.note && <p className="text-xs text-[#3D2614] mt-2 whitespace-pre-wrap">{disposal.note}</p>}
        </div>

        {(disposal.documents?.length ?? 0) > 0 && (
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
            <p className="text-xs font-semibold text-[#6B5744] mb-2">The receipt</p>
            <div className="flex flex-wrap gap-2">
              {disposal.documents!.map((p) => (
                p.image_dropped_at ? (
                  <div key={p.id} className="w-14 h-14 rounded-lg border border-[#E8D5C4] bg-[#FFF1E3] flex items-center justify-center">
                    <span className="text-[10px] text-[#8B7355] px-1">aged out</span>
                  </div>
                ) : (
                  <ImageThumb key={p.id} src={`/api/fssai/oil/photo?of=collection&id=${encodeURIComponent(p.id)}`} size={56} />
                )
              ))}
            </div>
          </div>
        )}

        {disposal.void_reason && (
          <div className="bg-gray-50 border border-gray-200 rounded-xl p-3">
            <p className="text-xs font-semibold text-gray-700">Voided</p>
            <p className="text-sm text-gray-700 mt-0.5">{disposal.void_reason}</p>
            <p className="text-xs text-gray-500 mt-0.5">{disposal.voided_by} · {fmtIST(disposal.voided_at)}</p>
          </div>
        )}

        {err && <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-800">{err}</div>}

        {voiding ? (
          <div className="bg-white border border-red-300 rounded-xl p-3 space-y-2">
            <p className="text-xs text-[#3D2614]">
              Voiding the collection says the collection did not happen that way. It says nothing
              about the oil, which really was drained — so the checks it covered go back to
              &ldquo;discarded, not yet collected&rdquo; rather than being voided with it.
            </p>
            <Field label="Why is this being voided">
              <input value={reason} onChange={(e) => setReason(e.target.value)} className={INPUT} />
            </Field>
            <button
              onClick={() => void doVoid()}
              disabled={busy || reason.trim().length < 4}
              className="w-full min-h-[48px] rounded-xl bg-red-700 text-white font-semibold disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Void this collection'}
            </button>
          </div>
        ) : disposal.status !== 'void' && isManagement ? (
          <button
            onClick={() => setVoiding(true)}
            className="min-h-[48px] px-3 rounded-xl border border-red-300 bg-white text-red-700 text-sm font-medium flex flex-nowrap items-center gap-1.5"
          >
            <Trash2 size={15} /> Void this collection
          </button>
        ) : null}
      </div>
    </ModalFrame>
  );
}

/* ------------------------------------------------------------------ *
 * Shared small pieces
 * ------------------------------------------------------------------ */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-[#6B5744] mb-1">{label}</label>
      {children}
    </div>
  );
}

function ModalFrame({
  title, onClose, children,
}: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div
        className="bg-[#FFF8F0] w-full sm:max-w-2xl sm:rounded-2xl rounded-t-2xl max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-[#FFF8F0] border-b border-[#E8D5C4] px-3 py-2.5 flex flex-nowrap items-center gap-2 z-10">
          <button
            onClick={onClose}
            aria-label="Back"
            className="sm:hidden w-10 h-10 rounded-lg border border-[#E8D5C4] bg-white flex items-center justify-center shrink-0"
          >
            <ArrowLeft size={16} />
          </button>
          <p className="font-semibold text-[#2D1B0E] truncate">{title}</p>
          <button
            onClick={onClose}
            aria-label="Close"
            className="ml-auto w-10 h-10 rounded-lg border border-[#E8D5C4] bg-white flex items-center justify-center shrink-0"
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-3 sm:p-4">{children}</div>
      </div>
    </div>
  );
}
