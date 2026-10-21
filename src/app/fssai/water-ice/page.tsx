'use client';

/**
 * WATER & ICE CHECKS — owner §13.
 *
 * ── ONE FILE, TWO SHAPES ────────────────────────────────────────────────────
 * An inspector asks one question — "show me your water records" — so the daily
 * readings and the laboratory certificates live in one list and one table. The
 * screen shows them as two tabs because they are filled in differently, not
 * because they are two files.
 *
 * ── THE TWO KINDS OF VERDICT, AND WHY THEY DIFFER ───────────────────────────
 *   · A READING here is judged against a range: the owner's standard if one is
 *     set, otherwise a range typed by whoever took the reading, otherwise nothing
 *     is judged and the record says so. Chlorine and pH are different rules about
 *     the same tap, so each kind looks for its own standard.
 *   · A LAB REPORT is not ours to judge. The laboratory printed a verdict and that
 *     is what is recorded. The one thing the app adds is a warning when the
 *     overall line says pass while a parameter row says fail — so nobody has to
 *     read the PDF to spot it.
 *
 * ── WHAT IS DERIVED LIVE, AND WHAT IS FROZEN ────────────────────────────────
 * The verdict is frozen at the moment of writing: tightening a standard next
 * month must not retrospectively fail a tap that passed. Whether the next test is
 * DUE is the opposite — derived on every read, because a stored "due" goes stale
 * at midnight and a water file rendering "up to date" the day after it lapsed is
 * the worst row this screen could print.
 *
 * Styling is the house skeleton as /fssai/corrective-actions uses it.
 * ⚠️ globals.css force-wraps any `.flex.gap-2|3|4`, so rows that must keep an
 * icon beside their text carry `flex-nowrap`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, CalendarClock, Check, Droplets, FlaskConical,
  HelpCircle, Info, Loader2, Lock, Plus, RefreshCw, Search, ShieldCheck,
  Trash2, X,
} from 'lucide-react';
import { apiJson } from '@/lib/api';
import { fmtIST, fmtISTDate } from '@/lib/format-date';
import ImageUpload, { ImageThumb } from '@/app/tasks/_components/ImageUpload';
import {
  FSSAI_WATER_TEST_KINDS, fssaiRecordStatusMeta, fssaiToday, fssaiWaterTestKind,
} from '@/lib/fssai';

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

interface Attachment {
  id: string; kind: string; filename: string; mime: string;
  size_bytes: number; caption: string; image_dropped_at: string;
}

interface LabParameter { name: string; value: string; uom: string; limit: string; result: string }

interface WaterTest {
  id: string;
  business_date: string;
  tested_at: string;
  test_kind: string;
  test_kind_label: string;
  is_lab: boolean;
  source_point: string;
  equipment_id: string;
  equipment_label: string;
  department_name: string;
  value_num: number | null;
  uom: string;
  decimals: number;
  value_display: string;
  min_used: number | null;
  max_used: number | null;
  standard_id: string;
  standard_code: string;
  standard_label: string;
  lab_name: string;
  lab_licence_no: string;
  report_no: string;
  sample_date: string;
  report_date: string;
  parameters: LabParameter[];
  result: string;
  is_fail: boolean;
  is_judged: boolean;
  fail_reason: string;
  action_taken: string;
  next_due_date: string;
  days_to_due: number | null;
  is_overdue: boolean;
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
  documents?: Attachment[];
}

interface StandardView {
  id: string; code: string; label: string;
  min_value: number | null; max_value: number | null; uom: string; authority: string;
}

interface WaterResponse {
  tests: WaterTest[];
  counts: { live: number; failed: number; unjudged: number; lab_reports: number; due: number; void: number };
  equipment: { id: string; name: string; kind: string; location_label: string; department_id: string }[];
  standards: { test_kind: string; code_looked_for: string; standard: StandardView | null }[];
  /* The server's own list of which kinds owe a reading. Read, never restated —
   * a second copy here would drift the moment a kind is added. */
  vocab: { number_kinds: string[] };
  unjudged_notice: string;
  can_record: boolean;
  is_management: boolean;
  me: string;
  truncated: boolean;
}

/** What a corrective action looks like when one is raised alongside a record. */
interface RaisedAction {
  id: string; ca_number: string; title: string; severity: string; due_date: string;
}

interface WaterRecordResult {
  ok: boolean;
  test: WaterTest;
  verdict: { is_judged: boolean; is_fail: boolean; why: string; min_used: number | null; max_used: number | null; limit_source: string };
  corrective_action: RaisedAction | null;
  corrective_action_warning?: string;
  unjudged_notice?: string;
}

const INPUT =
  'w-full bg-white border border-[#D4B896] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]';

/** The kinds that are readings taken here, and the kinds that are certificates. */
const READING_KINDS = FSSAI_WATER_TEST_KINDS.filter((k) => !k.is_lab);
const LAB_KINDS = FSSAI_WATER_TEST_KINDS.filter((k) => k.is_lab);

const TABS = [
  { key: 'readings', label: 'Daily checks' },
  { key: 'lab', label: 'Lab reports' },
] as const;

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-6xl mx-auto px-3 sm:px-4 py-4 sm:py-6 space-y-3 sm:space-y-4">
        <div className="flex flex-nowrap items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#af4408] text-white flex items-center justify-center shrink-0">
            <Droplets size={20} />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-bold text-[#af4408] leading-tight">Water &amp; Ice Checks</h1>
            <p className="text-xs sm:text-sm text-[#6B5744]">
              The daily checks, the filter changes, and the laboratory certificates
            </p>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Three states, never two. "Not judged" is its own answer — see the oil screen. */
function Verdict({ t }: { t: WaterTest }) {
  if (!t.is_judged) {
    return (
      <span className="text-[11px] px-1.5 py-0.5 rounded border bg-gray-100 text-gray-600 border-gray-200">
        Not judged
      </span>
    );
  }
  return t.is_fail ? (
    <span className="text-[11px] px-1.5 py-0.5 rounded border bg-red-100 text-red-700 border-red-200">
      Failed
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

export default function FssaiWaterIcePage() {
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('readings');
  const [data, setData] = useState<WaterResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [status, setStatus] = useState<'live' | 'fail' | 'due' | 'void' | 'all'>('live');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [open, setOpen] = useState<WaterTest | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const p = new URLSearchParams({ lab: tab === 'lab' ? '1' : '0' });
      if (status === 'fail') p.set('fail', '1');
      else if (status === 'due') p.set('due', '1');
      else p.set('status', status === 'all' ? 'all' : status);
      if (q.trim()) p.set('q', q.trim());
      if (from) p.set('from', from);
      if (to) p.set('to', to);
      setData(await apiJson<WaterResponse>(`/api/fssai/water?${p}`));
      setSignedOut(false);
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Could not load the water records';
      if (/sign in|401/i.test(m)) setSignedOut(true); else setErr(m);
    } finally { setLoading(false); }
  }, [tab, status, q, from, to]);

  useEffect(() => { void load(); }, [load]);

  if (signedOut) {
    return (
      <Shell>
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 text-center">
          <Lock className="w-6 h-6 mx-auto mb-2 text-[#8B7355]" />
          <p className="text-sm text-[#3D2614]">Please sign in to see the water records.</p>
        </div>
      </Shell>
    );
  }

  const noStandards = !!data && data.standards.every((s) => !s.standard);

  return (
    <Shell>
      <div className="flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => { setTab(t.key); setStatus('live'); }}
            className={`text-sm px-3 py-2 rounded-lg border font-medium min-h-[44px] ${
              tab === t.key
                ? 'bg-[#af4408] border-[#af4408] text-white'
                : 'bg-white border-[#E8D5C4] text-[#6B5744] hover:border-[#af4408]'
            }`}
          >
            {t.label}
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
            <Plus size={16} /> {tab === 'lab' ? 'Add a lab report' : 'Record a check'}
          </button>
        )}
      </div>

      {/* ── where the limits come from ─────────────────────────────────────── */}
      {tab === 'readings' && data && (
        <div className={`border rounded-xl p-3 sm:p-4 ${noStandards ? 'bg-amber-50 border-amber-200' : 'bg-[#FFF1E3] border-[#E8D5C4]'}`}>
          <div className="flex flex-nowrap items-start gap-2.5">
            {noStandards
              ? <HelpCircle size={16} className="text-amber-800 shrink-0 mt-0.5" />
              : <Info size={16} className="text-[#af4408] shrink-0 mt-0.5" />}
            <div className="min-w-0">
              {noStandards ? (
                <p className="text-[13px] text-amber-900 leading-relaxed">
                  {data.unjudged_notice || 'No limits have been set for water readings yet, so readings are kept but nothing is judged pass or fail.'}{' '}
                  Until then you can type the safe range on each check — it is recorded with the
                  reading, so the file always says what the water was judged against.
                </p>
              ) : (
                <div className="text-[13px] text-[#3D2614] leading-relaxed">
                  <p>Readings are judged against the limits set for each kind of test:</p>
                  <ul className="mt-1 space-y-0.5">
                    {data.standards.filter((s) => s.standard).map((s) => (
                      <li key={s.test_kind} className="text-xs text-[#6B5744]">
                        <strong className="text-[#2D1B0E]">{fssaiWaterTestKind(s.test_kind)?.label || s.test_kind}</strong>
                        {' — '}
                        {s.standard!.min_value !== null && `no less than ${s.standard!.min_value}`}
                        {s.standard!.min_value !== null && s.standard!.max_value !== null && ', '}
                        {s.standard!.max_value !== null && `no more than ${s.standard!.max_value}`}
                        {s.standard!.uom ? ` ${s.standard!.uom}` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {tab === 'lab' && (
        <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl p-3 sm:p-4">
          <div className="flex flex-nowrap items-start gap-2.5">
            <FlaskConical size={16} className="text-[#af4408] shrink-0 mt-0.5" />
            <p className="text-[13px] text-[#3D2614] leading-relaxed">
              <strong>The laboratory&apos;s verdict is the verdict.</strong> This screen records what
              the certificate printed — it does not re-judge the numbers, because contradicting a
              signed certificate is the last thing a compliance file should do. It will tell you if
              the overall line says pass while one of the parameters says otherwise.
            </p>
          </div>
        </div>
      )}

      {data && data.counts.due > 0 && status !== 'due' && (
        <button
          onClick={() => setStatus('due')}
          className="w-full text-left bg-amber-50 border border-amber-200 rounded-xl p-3 hover:border-amber-400"
        >
          <div className="flex flex-nowrap items-start gap-2.5">
            <CalendarClock size={16} className="text-amber-800 shrink-0 mt-0.5" />
            <p className="text-[13px] text-amber-900">
              <strong>
                {data.counts.due} record{data.counts.due === 1 ? ' is' : 's are'} at or past the date
                the next test was due.
              </strong>{' '}
              Tap to see just those.
            </p>
          </div>
        </button>
      )}

      {data && data.counts.failed > 0 && status !== 'fail' && (
        <button
          onClick={() => setStatus('fail')}
          className="w-full text-left bg-red-50 border border-red-200 rounded-xl p-3 hover:border-red-400"
        >
          <div className="flex flex-nowrap items-start gap-2.5">
            <AlertTriangle size={16} className="text-red-700 shrink-0 mt-0.5" />
            <p className="text-[13px] text-red-900">
              <strong>{data.counts.failed} water record{data.counts.failed === 1 ? '' : 's'} failed.</strong>{' '}
              Tap to see just those.
            </p>
          </div>
        </button>
      )}

      <div className="flex flex-wrap gap-1.5">
        {([
          { key: 'live', label: 'All', n: data?.counts.live },
          { key: 'fail', label: 'Failed', n: data?.counts.failed },
          { key: 'due', label: 'Due', n: data?.counts.due },
          { key: 'void', label: 'Voided', n: data?.counts.void },
        ] as const).map((t) => (
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
            {typeof t.n === 'number' && (
              <span className={`ml-1.5 text-xs ${status === t.key ? 'text-white/80' : 'text-[#8B7355]'}`}>{t.n}</span>
            )}
          </button>
        ))}
      </div>

      <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 grid grid-cols-1 sm:grid-cols-4 gap-2">
        <div className="sm:col-span-2 relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8B7355]" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={tab === 'lab' ? 'Laboratory, report number, licence' : 'Tap, tank, ice machine, who took it'}
            className={`${INPUT} pl-9`}
          />
        </div>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={INPUT} aria-label="From" />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={INPUT} aria-label="To" />
      </div>

      {err && <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-800">{err}</div>}

      {loading && !data ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center">
          <Loader2 className="w-6 h-6 mx-auto animate-spin text-[#af4408]" />
        </div>
      ) : (data?.tests.length ?? 0) === 0 ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 text-center">
          <ShieldCheck className="w-6 h-6 mx-auto mb-2 text-[#8B7355]" />
          <p className="text-sm text-[#3D2614]">
            {q || from || to || status !== 'live'
              ? 'Nothing here matches what you asked for.'
              : tab === 'lab'
                ? 'No laboratory report has been filed yet.'
                : 'No water or ice check has been recorded yet.'}
          </p>
          <p className="text-xs text-[#6B5744] mt-1">
            {tab === 'lab'
              ? 'A potability certificate is the paper most often asked for. An empty list means none is on the file.'
              : 'An empty list means nothing was recorded — not that the water was fine.'}
          </p>
        </div>
      ) : (
        <>
          <div className="md:hidden space-y-2">
            {data!.tests.map((t) => (
              <button
                key={t.id}
                onClick={() => setOpen(t)}
                className="w-full text-left bg-white border border-[#E8D5C4] rounded-xl p-3 hover:border-[#af4408]"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <Verdict t={t} />
                  {t.is_overdue && (
                    <span className="text-[11px] px-1.5 py-0.5 rounded border bg-amber-100 text-amber-900 border-amber-200">Due</span>
                  )}
                  {t.status === 'void' && (
                    <span className={`text-[11px] px-1.5 py-0.5 rounded border ${fssaiRecordStatusMeta('void').color}`}>Voided</span>
                  )}
                  {t.ca_number && (
                    <span className="text-[11px] px-1.5 py-0.5 rounded border bg-amber-50 text-amber-900 border-amber-200">{t.ca_number}</span>
                  )}
                </div>
                <p className="text-sm font-semibold mt-1.5">{t.test_kind_label}</p>
                <p className="text-xs text-[#6B5744] mt-0.5">
                  {fmtISTDate(t.business_date)} · {t.source_point || t.equipment_label || 'no source recorded'}
                </p>
                <p className="text-xs mt-1">
                  {t.is_lab
                    ? <>{t.lab_name || 'Laboratory'}{t.result ? ` — ${t.result}` : ''}</>
                    : (t.value_num !== null
                      ? <><strong>{t.value_display}</strong>{t.uom ? ` ${t.uom}` : ''}</>
                      : <span className="text-[#8B7355]">no reading</span>)}
                </p>
                {t.fail_reason && <p className="text-xs text-red-800 mt-1">{t.fail_reason}</p>}
              </button>
            ))}
          </div>

          <div className="hidden md:block bg-white border border-[#E8D5C4] rounded-xl overflow-x-auto">
            <table className="w-full text-sm min-w-[46rem]">
              <thead className="bg-[#FFF1E3] text-[#6B5744]">
                <tr>
                  <th className="text-left font-semibold px-4 py-2">Verdict</th>
                  <th className="text-left font-semibold px-4 py-2">What</th>
                  <th className="text-left font-semibold px-4 py-2">Where</th>
                  <th className="text-left font-semibold px-4 py-2">When</th>
                  <th className="text-left font-semibold px-4 py-2">{tab === 'lab' ? 'Report' : 'Reading'}</th>
                  <th className="text-left font-semibold px-4 py-2">Next due</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E8D5C4]">
                {data!.tests.map((t) => (
                  <tr key={t.id} onClick={() => setOpen(t)} className={`cursor-pointer hover:bg-[#FFF8F0] ${t.status === 'void' ? 'opacity-60' : ''}`}>
                    <td className="px-4 py-2 align-top">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Verdict t={t} />
                        {t.ca_number && (
                          <span className="text-[11px] px-1.5 py-0.5 rounded border bg-amber-50 text-amber-900 border-amber-200">{t.ca_number}</span>
                        )}
                      </div>
                      {t.fail_reason && <span className="block text-xs text-red-800 mt-1 max-w-[18rem]">{t.fail_reason}</span>}
                    </td>
                    <td className="px-4 py-2 align-top text-xs">{t.test_kind_label}</td>
                    <td className="px-4 py-2 align-top text-xs">
                      {t.source_point || t.equipment_label || <span className="text-[#8B7355]">not recorded</span>}
                    </td>
                    <td className="px-4 py-2 align-top text-xs">
                      {fmtISTDate(t.business_date)}
                      {t.tested_at && <span className="block text-[#8B7355]">{t.tested_at}</span>}
                    </td>
                    <td className="px-4 py-2 align-top text-xs">
                      {t.is_lab ? (
                        <>
                          {t.lab_name || '—'}
                          {t.report_no && <span className="block text-[#8B7355]">{t.report_no}</span>}
                          {t.result && <span className="block text-[#8B7355]">printed: {t.result}</span>}
                        </>
                      ) : (
                        <>
                          {t.value_num !== null ? <>{t.value_display}{t.uom ? ` ${t.uom}` : ''}</> : <span className="text-[#8B7355]">no reading</span>}
                          {(t.min_used !== null || t.max_used !== null) && (
                            <span className="block text-[#8B7355]">
                              {t.min_used !== null ? `min ${t.min_used}` : ''}
                              {t.min_used !== null && t.max_used !== null ? ' · ' : ''}
                              {t.max_used !== null ? `max ${t.max_used}` : ''}
                            </span>
                          )}
                        </>
                      )}
                    </td>
                    <td className={`px-4 py-2 align-top text-xs ${t.is_overdue ? 'text-amber-900 font-semibold' : 'text-[#6B5744]'}`}>
                      {t.next_due_date ? fmtISTDate(t.next_due_date) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {data?.truncated && (
        <p className="text-xs text-[#8B7355]">Only the most recent records are shown. Narrow the dates to see further back.</p>
      )}

      {showNew && data && (
        <NewRecordModal
          lab={tab === 'lab'}
          equipment={data.equipment}
          standards={data.standards}
          numberKinds={data.vocab?.number_kinds || []}
          onClose={() => setShowNew(false)}
          onSaved={(m) => { setShowNew(false); setToast(m); void load(); }}
        />
      )}

      {open && (
        <TestModal
          test={open}
          isManagement={!!data?.is_management}
          me={data?.me || ''}
          onClose={() => setOpen(null)}
          onChanged={(m) => { setOpen(null); setToast(m); void load(); }}
        />
      )}

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] bg-[#2D1B0E] text-white text-sm px-4 py-2.5 rounded-xl shadow-lg max-w-[90vw]">
          {toast}
        </div>
      )}
    </Shell>
  );
}

/* ------------------------------------------------------------------ *
 * RECORD
 * ------------------------------------------------------------------ */

function NewRecordModal({
  lab, equipment, standards, numberKinds, onClose, onSaved,
}: {
  lab: boolean;
  equipment: { id: string; name: string; location_label: string }[];
  standards: { test_kind: string; standard: StandardView | null }[];
  numberKinds: string[];
  onClose: () => void;
  onSaved: (m: string) => void;
}) {
  const [testKind, setTestKind] = useState(lab ? LAB_KINDS[0]?.key || 'lab_report' : 'chlorine');
  const [businessDate, setBusinessDate] = useState(fssaiToday());
  const [testedAt, setTestedAt] = useState('');
  const [equipmentId, setEquipmentId] = useState('');
  const [sourcePoint, setSourcePoint] = useState('');
  const [valueNum, setValueNum] = useState('');
  const [uom, setUom] = useState('');
  const [minValue, setMinValue] = useState('');
  const [maxValue, setMaxValue] = useState('');
  const [labName, setLabName] = useState('');
  const [labLicence, setLabLicence] = useState('');
  const [reportNo, setReportNo] = useState('');
  const [sampleDate, setSampleDate] = useState('');
  const [reportDate, setReportDate] = useState('');
  const [result, setResult] = useState('');
  const [params, setParams] = useState<LabParameter[]>([{ name: '', value: '', uom: '', limit: '', result: '' }]);
  const [nextDue, setNextDue] = useState('');
  const [actionTaken, setActionTaken] = useState('');
  const [note, setNote] = useState('');
  const [docs, setDocs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const standard = useMemo(
    () => standards.find((s) => s.test_kind === testKind)?.standard || null,
    [standards, testKind],
  );
  const needsNumber = numberKinds.includes(testKind);

  useEffect(() => {
    if (standard && !uom) setUom(standard.uom);
  }, [standard, uom]);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const j = await apiJson<WaterRecordResult>('/api/fssai/water', {
        method: 'POST',
        body: {
          action: 'record',
          test_kind: testKind,
          business_date: businessDate,
          tested_at: testedAt,
          equipment_id: equipmentId,
          source_point: sourcePoint,
          value_num: valueNum,
          uom,
          min_value: minValue,
          max_value: maxValue,
          lab_name: labName,
          lab_licence_no: labLicence,
          report_no: reportNo,
          sample_date: sampleDate,
          report_date: reportDate,
          result,
          parameters: params.filter((p) => p.name.trim()),
          next_due_date: nextDue,
          action_taken: actionTaken,
          note,
          documents: docs.map((d) => ({ data_uri: d, kind: lab ? 'certificate' : 'photo' })),
        },
      });
      onSaved(
        j?.corrective_action
          ? `Recorded. It failed, and corrective action ${j.corrective_action.ca_number} was raised.`
          : (j?.verdict?.is_judged ? 'Recorded, and it was in order.' : 'Recorded. Nothing was judged — no limit is set yet.'),
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save the record');
    } finally { setBusy(false); }
  };

  return (
    <ModalFrame title={lab ? 'Add a laboratory report' : 'Record a water or ice check'} onClose={onClose}>
      <div className="space-y-3">
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 space-y-2">
          <Field label="What kind of record">
            <select value={testKind} onChange={(e) => setTestKind(e.target.value)} className={INPUT}>
              {(lab ? LAB_KINDS : READING_KINDS).map((k) => (
                <option key={k.key} value={k.key}>{k.label}</option>
              ))}
            </select>
            <p className="text-xs text-[#6B5744] mt-1">{fssaiWaterTestKind(testKind)?.hint}</p>
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <Field label="Date">
              <input type="date" value={businessDate} onChange={(e) => setBusinessDate(e.target.value)} className={INPUT} />
            </Field>
            <Field label="Time (optional)">
              <input value={testedAt} onChange={(e) => setTestedAt(e.target.value)} placeholder="HH:MM" inputMode="numeric" className={INPUT} />
            </Field>
          </div>

          <Field label="Where the sample came from">
            {equipment.length > 0 && (
              <select value={equipmentId} onChange={(e) => setEquipmentId(e.target.value)} className={`${INPUT} mb-2`}>
                <option value="">Not in the register — I will type it</option>
                {equipment.map((e2) => (
                  <option key={e2.id} value={e2.id}>{e2.name}{e2.location_label ? ` — ${e2.location_label}` : ''}</option>
                ))}
              </select>
            )}
            {!equipmentId && (
              <input
                value={sourcePoint}
                onChange={(e) => setSourcePoint(e.target.value)}
                placeholder="Kitchen tap, RO outlet, overhead tank, ice machine…"
                className={INPUT}
              />
            )}
            <p className="text-xs text-[#6B5744] mt-1">
              &ldquo;The water was fine&rdquo; says nothing if nobody knows which tap. This is the
              one thing a water record cannot be without.
            </p>
          </Field>
        </div>

        {!lab && (
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <Field label={needsNumber ? 'The reading' : 'Reading (if there is one)'}>
                <input
                  value={valueNum}
                  onChange={(e) => setValueNum(e.target.value.replace(/[^\d.-]/g, ''))}
                  inputMode="decimal"
                  placeholder={needsNumber ? 'required' : 'optional'}
                  className={INPUT}
                />
              </Field>
              <Field label="In what unit">
                <input value={uom} onChange={(e) => setUom(e.target.value)} placeholder="ppm, pH…" className={INPUT} />
              </Field>
            </div>

            {standard ? (
              <p className="text-xs text-[#6B5744]">
                Judged against <strong className="text-[#2D1B0E]">{standard.label || standard.code}</strong>
                {standard.min_value !== null && <> — no less than {standard.min_value}</>}
                {standard.min_value !== null && standard.max_value !== null && ','}
                {standard.max_value !== null && <> no more than {standard.max_value}</>}
                {standard.uom ? ` ${standard.uom}` : ''}. That limit is frozen onto the record.
              </p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Safe minimum (optional)">
                    <input value={minValue} onChange={(e) => setMinValue(e.target.value.replace(/[^\d.-]/g, ''))} inputMode="decimal" className={INPUT} />
                  </Field>
                  <Field label="Safe maximum (optional)">
                    <input value={maxValue} onChange={(e) => setMaxValue(e.target.value.replace(/[^\d.-]/g, ''))} inputMode="decimal" className={INPUT} />
                  </Field>
                </div>
                <p className="text-xs text-[#6B5744]">
                  No limit is set for this test yet. Whatever you put here is recorded with the
                  reading, so the file says what it was judged against. Leave both blank and the
                  reading is kept but not judged.
                </p>
              </>
            )}
          </div>
        )}

        {lab && (
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 space-y-2">
            <Field label="Which laboratory">
              <input value={labName} onChange={(e) => setLabName(e.target.value)} className={INPUT} />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Its licence or NABL reference">
                <input value={labLicence} onChange={(e) => setLabLicence(e.target.value)} className={INPUT} />
              </Field>
              <Field label="Report number">
                <input value={reportNo} onChange={(e) => setReportNo(e.target.value)} className={INPUT} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Sample taken on">
                <input type="date" value={sampleDate} onChange={(e) => setSampleDate(e.target.value)} className={INPUT} />
              </Field>
              <Field label="Report dated">
                <input type="date" value={reportDate} onChange={(e) => setReportDate(e.target.value)} className={INPUT} />
              </Field>
            </div>
            <Field label="What the certificate says overall">
              <div className="grid grid-cols-3 gap-1.5">
                {[{ k: '', l: 'It does not say' }, { k: 'pass', l: 'Pass' }, { k: 'fail', l: 'Fail' }].map((r) => (
                  <button
                    key={r.k || 'blank'}
                    type="button"
                    onClick={() => setResult(r.k)}
                    className={`min-h-[44px] text-sm px-2 rounded-lg border font-medium ${
                      result === r.k ? 'bg-[#af4408] border-[#af4408] text-white' : 'bg-white border-[#E8D5C4] text-[#6B5744]'
                    }`}
                  >
                    {r.l}
                  </button>
                ))}
              </div>
              <p className="text-xs text-[#6B5744] mt-1">
                Record what is printed. The app does not re-judge a signed certificate.
              </p>
            </Field>

            <div>
              <p className="text-xs text-[#6B5744] mb-1">The parameters, as printed</p>
              <div className="space-y-1.5">
                {params.map((p, i) => (
                  <div key={i} className="grid grid-cols-12 gap-1.5">
                    <input
                      value={p.name}
                      onChange={(e) => setParams((ps) => ps.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                      placeholder="Parameter"
                      className={`${INPUT} col-span-4`}
                    />
                    <input
                      value={p.value}
                      onChange={(e) => setParams((ps) => ps.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                      placeholder="Value"
                      className={`${INPUT} col-span-2`}
                    />
                    <input
                      value={p.uom}
                      onChange={(e) => setParams((ps) => ps.map((x, j) => (j === i ? { ...x, uom: e.target.value } : x)))}
                      placeholder="Unit"
                      className={`${INPUT} col-span-2`}
                    />
                    <input
                      value={p.limit}
                      onChange={(e) => setParams((ps) => ps.map((x, j) => (j === i ? { ...x, limit: e.target.value } : x)))}
                      placeholder="Limit"
                      className={`${INPUT} col-span-2`}
                    />
                    <input
                      value={p.result}
                      onChange={(e) => setParams((ps) => ps.map((x, j) => (j === i ? { ...x, result: e.target.value } : x)))}
                      placeholder="Result"
                      className={`${INPUT} col-span-2`}
                    />
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setParams((ps) => [...ps, { name: '', value: '', uom: '', limit: '', result: '' }])}
                className="mt-1.5 min-h-[40px] px-3 rounded-lg border border-[#E8D5C4] bg-white text-xs"
              >
                Add another parameter
              </button>
              <p className="text-xs text-[#6B5744] mt-1">
                {/* Deliberately free text: a lab writes "Absent", "&lt; 0.1",
                  * "Within limit". Forcing those into numbers would change what the
                  * certificate says. */}
                Type values exactly as printed — &ldquo;Absent&rdquo;, &ldquo;&lt; 0.1&rdquo; and
                &ldquo;Within limit&rdquo; are all kept as they are. Anything marked fail, exceeds
                limit or present will be flagged.
              </p>
            </div>
          </div>
        )}

        <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 space-y-2">
          <Field label="Next one due">
            <input type="date" value={nextDue} onChange={(e) => setNextDue(e.target.value)} className={INPUT} />
            <p className="text-xs text-[#6B5744] mt-1">
              Whether it is due is worked out fresh every time this screen opens, so it can never say
              &ldquo;up to date&rdquo; the day after it lapsed.
            </p>
          </Field>
          <Field label="What was done">
            <input value={actionTaken} onChange={(e) => setActionTaken(e.target.value)} placeholder="Filter replaced, tank cleaned, …" className={INPUT} />
          </Field>
          <Field label="Note">
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className={INPUT} />
          </Field>
          <Field label={lab ? 'Photograph of the certificate' : 'Photographs'}>
            <ImageUpload multiple max={4} value={docs} onChange={setDocs} label={lab ? 'Add the certificate' : 'Add a photo'} />
          </Field>
        </div>

        {err && <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-800">{err}</div>}

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => void submit()}
            disabled={busy || (!equipmentId && !sourcePoint.trim()) || (lab && !labName.trim())}
            className="flex-1 min-h-[48px] rounded-xl bg-[#af4408] text-white font-semibold disabled:opacity-50 flex flex-nowrap items-center justify-center gap-2"
          >
            {busy ? <Loader2 size={18} className="animate-spin" /> : <Check size={18} />}
            Save the record
          </button>
          <button onClick={onClose} className="min-h-[48px] px-4 rounded-xl border border-[#E8D5C4] bg-white text-sm">Cancel</button>
        </div>
      </div>
    </ModalFrame>
  );
}

/* ------------------------------------------------------------------ *
 * ONE RECORD
 * ------------------------------------------------------------------ */

function TestModal({
  test, isManagement, me, onClose, onChanged,
}: {
  test: WaterTest;
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
      await apiJson('/api/fssai/water', { method: 'POST', body: { action: 'void', id: test.id, reason } });
      onChanged('Voided. The record stays in the file with your reason on it.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not void that');
    } finally { setBusy(false); }
  };

  return (
    <ModalFrame title={test.test_kind_label} onClose={onClose}>
      <div className="space-y-3">
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <Verdict t={test} />
            {test.is_overdue && (
              <span className="text-[11px] px-1.5 py-0.5 rounded border bg-amber-100 text-amber-900 border-amber-200">Due</span>
            )}
            {test.status === 'void' && (
              <span className={`text-[11px] px-1.5 py-0.5 rounded border ${fssaiRecordStatusMeta('void').color}`}>Voided</span>
            )}
            {test.ca_number && (
              <span className="text-[11px] px-1.5 py-0.5 rounded border bg-amber-50 text-amber-900 border-amber-200">
                {test.ca_number} · {test.ca_status}
              </span>
            )}
          </div>
          <p className="text-base font-semibold mt-1.5">{test.test_kind_label}</p>
          <p className="text-xs text-[#6B5744] mt-0.5">
            {test.source_point || test.equipment_label || 'no source recorded'} · {fmtISTDate(test.business_date)}
            {test.tested_at ? ` at ${test.tested_at}` : ''}
            {test.department_name ? ` · ${test.department_name}` : ''}
          </p>
          <p className="text-xs text-[#6B5744] mt-0.5">
            Recorded by {test.recorded_name || test.recorded_by || 'unknown'} · {fmtIST(test.created_at)}
          </p>
          {test.fail_reason && <p className="text-sm text-red-800 mt-2">{test.fail_reason}</p>}
          {!test.is_judged && (
            <p className="text-xs text-[#6B5744] mt-2">
              Nothing on this record was judged pass or fail — there was no limit to judge it against.
              The reading is on the file exactly as it was taken.
            </p>
          )}
        </div>

        {!test.is_lab && (
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
            <p className="text-xs font-semibold text-[#6B5744] mb-1.5">The reading</p>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <div>
                <dt className="text-[#6B5744]">Measured</dt>
                <dd>
                  {test.value_num === null
                    ? <span className="text-[#8B7355]">not measured</span>
                    : <>{test.value_display}{test.uom ? ` ${test.uom}` : ''}</>}
                </dd>
              </div>
              <div>
                <dt className="text-[#6B5744]">Range applied</dt>
                <dd>
                  {test.min_used === null && test.max_used === null
                    ? <span className="text-[#8B7355]">none</span>
                    : <>
                      {test.min_used !== null ? `min ${test.min_used}` : ''}
                      {test.min_used !== null && test.max_used !== null ? ' · ' : ''}
                      {test.max_used !== null ? `max ${test.max_used}` : ''}
                    </>}
                  {(test.min_used !== null || test.max_used !== null) && (
                    <span className="block text-[#8B7355]">
                      {test.standard_id
                        ? `from ${test.standard_label || test.standard_code}`
                        : 'typed in at the time of the test'}
                    </span>
                  )}
                </dd>
              </div>
            </dl>
          </div>
        )}

        {test.is_lab && (
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
            <p className="text-xs font-semibold text-[#6B5744] mb-1.5">The certificate</p>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <div><dt className="text-[#6B5744]">Laboratory</dt><dd>{test.lab_name || '—'}</dd></div>
              <div><dt className="text-[#6B5744]">Licence / NABL</dt><dd>{test.lab_licence_no || <span className="text-amber-800">none recorded</span>}</dd></div>
              <div><dt className="text-[#6B5744]">Report number</dt><dd>{test.report_no || '—'}</dd></div>
              <div><dt className="text-[#6B5744]">Printed result</dt><dd>{test.result || <span className="text-[#8B7355]">it does not say</span>}</dd></div>
              <div><dt className="text-[#6B5744]">Sample taken</dt><dd>{test.sample_date ? fmtISTDate(test.sample_date) : '—'}</dd></div>
              <div><dt className="text-[#6B5744]">Report dated</dt><dd>{test.report_date ? fmtISTDate(test.report_date) : '—'}</dd></div>
            </dl>

            {test.parameters.length > 0 && (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-xs min-w-[24rem]">
                  <thead className="text-[#6B5744]">
                    <tr>
                      <th className="text-left font-semibold py-1">Parameter</th>
                      <th className="text-left font-semibold py-1">Value</th>
                      <th className="text-left font-semibold py-1">Limit</th>
                      <th className="text-left font-semibold py-1">Result</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E8D5C4]">
                    {test.parameters.map((p, i) => {
                      const bad = ['fail', 'exceeds limit', 'present'].includes(p.result);
                      return (
                        <tr key={`${p.name}-${i}`} className={bad ? 'text-red-800' : ''}>
                          <td className="py-1">{p.name}</td>
                          <td className="py-1">{p.value}{p.uom ? ` ${p.uom}` : ''}</td>
                          <td className="py-1">{p.limit || '—'}</td>
                          <td className="py-1">{p.result || '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <div>
              <dt className="text-[#6B5744]">Next due</dt>
              <dd className={test.is_overdue ? 'text-amber-900 font-semibold' : ''}>
                {test.next_due_date
                  ? <>{fmtISTDate(test.next_due_date)}{test.days_to_due !== null && <span className="block text-[#8B7355]">{test.days_to_due < 0 ? `${Math.abs(test.days_to_due)} days overdue` : `in ${test.days_to_due} days`}</span>}</>
                  : <span className="text-[#8B7355]">not set</span>}
              </dd>
            </div>
            <div><dt className="text-[#6B5744]">What was done</dt><dd>{test.action_taken || '—'}</dd></div>
          </dl>
          {test.note && <p className="text-xs text-[#3D2614] mt-2 whitespace-pre-wrap">{test.note}</p>}
        </div>

        {(test.documents?.length ?? 0) > 0 && (
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
            <p className="text-xs font-semibold text-[#6B5744] mb-2">Attached</p>
            <div className="flex flex-wrap gap-2">
              {test.documents!.map((p) => (
                p.image_dropped_at ? (
                  <div key={p.id} className="w-14 h-14 rounded-lg border border-[#E8D5C4] bg-[#FFF1E3] flex items-center justify-center">
                    <span className="text-[10px] text-[#8B7355] px-1">aged out</span>
                  </div>
                ) : (
                  <ImageThumb key={p.id} src={`/api/fssai/water/photo?id=${encodeURIComponent(p.id)}`} size={56} />
                )
              ))}
            </div>
          </div>
        )}

        {test.void_reason && (
          <div className="bg-gray-50 border border-gray-200 rounded-xl p-3">
            <p className="text-xs font-semibold text-gray-700">Voided</p>
            <p className="text-sm text-gray-700 mt-0.5">{test.void_reason}</p>
            <p className="text-xs text-gray-500 mt-0.5">{test.voided_by} · {fmtIST(test.voided_at)}</p>
          </div>
        )}

        {err && <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-800">{err}</div>}

        {voiding ? (
          <div className="bg-white border border-red-300 rounded-xl p-3 space-y-2">
            <p className="text-xs text-[#3D2614]">
              A voided record stays in the file for ever with your reason on it. Nothing is deleted,
              and voiding one does not change any corrective action already raised from it.
            </p>
            <Field label="Why is this being voided">
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Wrong source point, duplicate of another report, …" className={INPUT} />
            </Field>
            <button
              onClick={() => void doVoid()}
              disabled={busy || reason.trim().length < 4}
              className="w-full min-h-[48px] rounded-xl bg-red-700 text-white font-semibold disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Void this record'}
            </button>
          </div>
        ) : test.status !== 'void' && isManagement ? (
          <button
            onClick={() => setVoiding(true)}
            className="min-h-[48px] px-3 rounded-xl border border-red-300 bg-white text-red-700 text-sm font-medium flex flex-nowrap items-center gap-1.5"
          >
            <Trash2 size={15} /> Void this record
          </button>
        ) : test.status !== 'void' ? (
          <p className="text-xs text-[#6B5744]">
            Only a manager, head of department or administrator can void a compliance record.
          </p>
        ) : null}

        {me && test.recorded_by.toLowerCase() === me.toLowerCase() && isManagement && test.status !== 'void' && (
          <p className="text-xs text-amber-800">
            You recorded this yourself. A void is meant to be somebody else&apos;s decision.
          </p>
        )}
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
