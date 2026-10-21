'use client';

/**
 * COLD ROOM CLIMATE CONTROL — the board (P4, owner §5).
 *
 * ── WHAT THIS SCREEN IS FOR, IN ONE SENTENCE ────────────────────────────────
 * The question an inspector asks is not "what did the fridge read" — it is "which
 * fridge did nobody read". So this board leads with the units that have NOT been
 * read today, by name, and only then shows the ones that were. A board that showed
 * only the readings taken would hide exactly the gap it exists to surface.
 *
 * ── THE SECOND HALF OF THE COLD-ROOM FILE ───────────────────────────────────
 * A temperature log says what a unit READ. The lower half of this screen says what
 * was DONE to it — defrosted, deep-cleaned, broke down, was mended, taken out of
 * use, put back, and the one an inspector always asks for: the THERMOMETER CHECKED
 * AGAINST A KNOWN REFERENCE. Those are the entries that answer "was the unit seen
 * to" the moment a reading is out of range.
 *
 * ── THREE THINGS THIS SCREEN WILL NOT DO ────────────────────────────────────
 *  1. It will not paint an unranged unit green. No range means the reading was
 *     recorded and NOT judged, and the card says so in amber.
 *  2. It will not show a voided reading as the latest reading. A number a manager
 *     has struck out is not the state of the fridge.
 *  3. It will not re-grade a record. An out-of-tolerance probe entered here does
 *     not change the verdict on any reading taken with it — the entry sits in the
 *     file beside them, which is the honest answer and is what the screen says.
 *
 * API: GET /api/fssai/temperature?due=1 · GET /api/fssai/equipment
 *      GET/POST /api/fssai/equipment-events
 * Every mutation goes through apiJson() so the fnb_csrf header is sent.
 *
 * Styling is the house skeleton (RECON §1.3-1.6). ⚠️ globals.css force-wraps any
 * `.flex.gap-2|3|4`, so rows that must keep an icon beside their text carry
 * `flex-nowrap`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, Ban, CalendarClock, Check, Info, Loader2,
  Lock, Plus, RefreshCw, Snowflake, Thermometer, Wrench, X,
} from 'lucide-react';
import { apiJson } from '@/lib/api';
import ImageUpload from '@/app/tasks/_components/ImageUpload';
import {
  FSSAI_EQUIPMENT_EVENT_KINDS, FSSAI_TEMP_UOMS, fssaiToday, isISODate,
} from '@/lib/fssai';

interface DueUnit {
  id: string; name: string; kind: string; kind_label: string;
  location_label: string; check_frequency: string;
  min_temp: number | null; max_temp: number | null; temp_uom: string;
  has_range: boolean; readings_today: number; fails_today: number;
}

interface Latest {
  id: string; business_date: string; reading_at: string;
  value_num: number | null; display: string; uom: string;
  is_fail: 0 | 1; is_judged: 0 | 1; fail_reason: string;
  recorded_name: string; recorded_by: string; status: string;
}

interface Event {
  id: string;
  equipment_id: string;
  equipment_label: string;
  event_kind: string;
  event_kind_label: string;
  business_date: string;
  event_at: string;
  detail: string;
  performed_by: string;
  vendor_name: string;
  reference_no: string;
  downtime_minutes: number | null;
  value_before: number | null;
  reference_value: number | null;
  value_after: number | null;
  deviation: number | null;
  display_deviation: string;
  uom: string;
  is_fail: 0 | 1;
  next_due_date: string;
  is_overdue: boolean;
  status: string;
  voided_by: string;
  void_reason: string;
  created_by: string;
  photo_count: number;
}

interface DueEvent {
  id: string; equipment_id: string; equipment_label: string;
  event_kind: string; event_kind_label: string;
  next_due_date: string; last_done: string; days_late: number; is_overdue: boolean;
}

const inputCls =
  'w-full bg-white border border-[#D4B896] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]';
const labelCls = 'block text-xs font-semibold text-[#6B5744] mb-1';

function rangeWords(min: number | null, max: number | null, uom: string): string {
  const u = uom === 'C' || uom === 'F' ? `°${uom}` : uom;
  if (min !== null && max !== null) return `${min} to ${max} ${u}`;
  if (max !== null) return `at or below ${max} ${u}`;
  if (min !== null) return `at or above ${min} ${u}`;
  return 'no range set';
}

export default function FssaiColdRoomsPage() {
  const [date, setDate] = useState(fssaiToday());
  const [units, setUnits] = useState<DueUnit[]>([]);
  const [latest, setLatest] = useState<Record<string, Latest>>({});
  const [events, setEvents] = useState<Event[]>([]);
  const [due, setDue] = useState<DueEvent[]>([]);
  const [tolerance, setTolerance] = useState(1);
  const [isMgmt, setIsMgmt] = useState(false);
  const [me, setMe] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [form, setForm] = useState<any | null>(null);
  const [voiding, setVoiding] = useState<Event | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [viewing, setViewing] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(t);
  }, [toast]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const [d, eq, ev, dd] = await Promise.all([
        apiJson<any>(`/api/fssai/temperature?due=1&date=${encodeURIComponent(date)}`),
        apiJson<any>('/api/fssai/equipment'),
        apiJson<any>('/api/fssai/equipment-events'),
        apiJson<any>('/api/fssai/equipment-events?due=1'),
      ]);
      setUnits(d.units || []);
      setLatest(eq.latest || {});
      setEvents(ev.events || []);
      setDue(dd.due || []);
      setTolerance(Number(ev.calibration_tolerance) || 1);
      setIsMgmt(!!ev.is_management);
      setMe(ev.me || '');
      setSignedOut(false);
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Could not load the cold-room board';
      if (/sign in|401/i.test(m)) setSignedOut(true);
      else setErr(m);
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => { void load(); }, [load]);

  const notRead = useMemo(() => units.filter((u) => !u.readings_today), [units]);
  const withoutRange = useMemo(() => units.filter((u) => !u.has_range), [units]);
  const overdue = useMemo(() => due.filter((d) => d.is_overdue), [due]);

  async function post(body: any) {
    setBusy(true);
    try {
      const j = await apiJson<any>('/api/fssai/equipment-events', { method: 'POST', body });
      setToast(j.note_to_staff || j.note || 'Saved.');
      await load();
      return j;
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'That did not save.');
      return null;
    } finally {
      setBusy(false);
    }
  }

  if (signedOut) {
    return (
      <Shell>
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 text-center">
          <Lock className="w-6 h-6 mx-auto mb-2 text-[#8B7355]" />
          <p className="text-sm text-[#3D2614]">Please sign in to see the cold-room board.</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex flex-wrap items-center gap-2">
        <input type="date" className={`${inputCls} w-auto`} value={date} onChange={(e) => setDate(e.target.value)} max={fssaiToday()} />
        {date !== fssaiToday() && (
          <button onClick={() => setDate(fssaiToday())} className="px-3 py-2 rounded-lg border border-[#E8D5C4] bg-white text-sm text-[#6B5744] hover:border-[#af4408]">Today</button>
        )}
        <a href="/fssai/temperature" className="inline-flex flex-nowrap items-center gap-1.5 px-3 py-2 rounded-lg bg-[#af4408] text-white text-sm font-semibold">
          <Thermometer size={15} /> Record a temperature
        </a>
        <button onClick={() => void load()} title="Reload" className="ml-auto w-11 h-11 rounded-lg border border-[#E8D5C4] bg-white hover:border-[#af4408] flex items-center justify-center">
          <RefreshCw size={16} className={loading ? 'animate-spin text-[#af4408]' : 'text-[#6B5744]'} />
        </button>
      </div>

      {err && <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-800">{err}</div>}

      {loading ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center">
          <Loader2 className="w-6 h-6 mx-auto animate-spin text-[#af4408]" />
        </div>
      ) : units.length === 0 ? (
        <div className="bg-white border-2 border-[#af4408] rounded-xl p-4">
          <div className="flex flex-nowrap items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-[#af4408] shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-[#2D1B0E]">No cold unit is on the register yet.</p>
              <p className="text-sm text-[#6B5744] mt-1">
                Your cold units exist in this app only as words typed on kitchen production labels.
                Until they are registered with their safe ranges, a reading taken on one is recorded and
                marked as not judged — and this board has nothing to show as read or unread.
              </p>
              <a href="/fssai/settings/equipment" className="inline-flex flex-nowrap items-center gap-1.5 mt-2 text-sm font-semibold text-[#af4408] hover:underline">
                <Snowflake size={15} /> Register the units
              </a>
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* ── THE GAP FIRST. This is the question an inspector asks. ──────── */}
          <div className={`rounded-xl border p-3 sm:p-4 ${notRead.length ? 'bg-[#FFF8E7] border-[#E8C35C]' : 'bg-green-50 border-green-200'}`}>
            <div className="flex flex-nowrap items-start gap-2.5">
              {notRead.length
                ? <AlertTriangle size={17} className="text-[#8a6d1f] shrink-0 mt-0.5" />
                : <Check size={17} className="text-green-700 shrink-0 mt-0.5" />}
              <div className="min-w-0">
                <p className="text-[13px] text-[#3D2614] leading-relaxed">
                  {notRead.length ? (
                    <>
                      <strong>
                        {notRead.length} of {units.length} unit{units.length === 1 ? '' : 's'} had no reading
                        on {date}
                      </strong>
                      {' — '}{notRead.map((u) => u.name).join(', ')}.
                    </>
                  ) : (
                    <><strong>Every unit was read on {date}.</strong> {units.length} unit{units.length === 1 ? '' : 's'}, all with a reading against them.</>
                  )}
                </p>
                {withoutRange.length > 0 && (
                  <p className="text-xs text-[#6B5744] mt-1.5">
                    {withoutRange.length} of them {withoutRange.length === 1 ? 'has' : 'have'} no safe range,
                    so {withoutRange.length === 1 ? 'its' : 'their'} readings are recorded and left unjudged —
                    never counted as a pass.{' '}
                    <a href="/fssai/settings/equipment" className="font-semibold text-[#af4408] hover:underline">Set the ranges</a>
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* ── the units ──────────────────────────────────────────────────── */}
          <div className="grid gap-2 sm:grid-cols-2">
            {units.map((u) => {
              const l = latest[u.id];
              const readToday = u.readings_today > 0;
              const tone = !readToday ? 'border-[#E8C35C] bg-[#FFFCF4]'
                : u.fails_today ? 'border-red-200 bg-red-50/40'
                  : !u.has_range ? 'border-amber-200 bg-amber-50/30'
                    : 'border-[#E8D5C4] bg-white';
              return (
                <div key={u.id} className={`rounded-xl border p-3 ${tone}`}>
                  <div className="flex flex-nowrap items-start gap-3">
                    <div className="w-9 h-9 rounded-lg bg-[#FFF1E3] border border-[#E8D5C4] flex items-center justify-center shrink-0">
                      <Snowflake size={17} className="text-[#af4408]" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <p className="text-sm font-semibold text-[#2D1B0E] truncate">{u.name}</p>
                        <span className="px-1.5 py-0.5 rounded text-[11px] bg-[#FFF1E3] border border-[#E8D5C4] text-[#6B5744]">{u.kind_label}</span>
                      </div>
                      <p className="text-xs text-[#8B7355] mt-0.5">
                        {u.has_range ? rangeWords(u.min_temp, u.max_temp, u.temp_uom) : 'No range set'}
                        {u.location_label ? ` · ${u.location_label}` : ''}
                      </p>
                      {readToday ? (
                        <p className="text-sm mt-1.5">
                          <strong className={u.fails_today ? 'text-red-700' : u.has_range ? 'text-green-700' : 'text-amber-700'}>
                            {u.readings_today} reading{u.readings_today === 1 ? '' : 's'}
                          </strong>
                          {u.fails_today ? <span className="text-red-700"> · {u.fails_today} out of range</span> : ''}
                          {!u.has_range ? <span className="text-amber-700"> · not judged</span> : ''}
                        </p>
                      ) : (
                        <p className="text-sm mt-1.5 font-semibold text-[#8a6d1f]">Not read on {date}</p>
                      )}
                      {l && (
                        <p className="text-xs text-[#6B5744] mt-1">
                          Last: {l.display || '—'} °{l.uom} on {l.business_date}
                          {l.reading_at ? ` at ${l.reading_at}` : ''}
                          {l.recorded_name ? ` · ${l.recorded_name}` : ''}
                          {!l.is_judged && ' · not judged'}
                        </p>
                      )}
                    </div>
                    <button
                      onClick={() => setForm({ equipment_id: u.id, equipment_label: u.name, event_kind: 'defrost', business_date: fssaiToday(), uom: u.temp_uom || 'C' })}
                      title="Record something done to this unit"
                      className="shrink-0 w-9 h-9 rounded-lg border border-[#E8D5C4] bg-white hover:border-[#af4408] flex items-center justify-center"
                    >
                      <Wrench size={15} className="text-[#6B5744]" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* ── what is overdue on the units ───────────────────────────────── */}
          {due.length > 0 && (
            <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
              <div className="flex flex-nowrap items-center gap-2 mb-2">
                <CalendarClock size={16} className="text-[#af4408] shrink-0" />
                <h2 className="text-sm font-bold text-[#2D1B0E]">
                  Coming up on the units
                  {overdue.length > 0 && <span className="text-red-700"> · {overdue.length} overdue</span>}
                </h2>
              </div>
              <div className="space-y-1.5">
                {due.map((d) => (
                  <div key={d.id} className={`rounded-lg border p-2 text-[13px] ${d.is_overdue ? 'border-red-200 bg-red-50' : 'border-[#E8D5C4] bg-[#FFF8F0]'}`}>
                    <span className="font-semibold text-[#2D1B0E]">{d.equipment_label}</span>
                    {' · '}{d.event_kind_label}
                    {' · '}
                    <span className={d.is_overdue ? 'text-red-700 font-semibold' : 'text-[#6B5744]'}>
                      {d.is_overdue
                        ? `was due ${d.next_due_date}${Number.isFinite(d.days_late) ? ` — ${d.days_late} day${d.days_late === 1 ? '' : 's'} late` : ''}`
                        : `due ${d.next_due_date}`}
                    </span>
                    {d.last_done && <span className="text-[#8B7355]"> · last done {d.last_done}</span>}
                  </div>
                ))}
              </div>
              {/* The de-duplication explained, because a reader will wonder why an
               * older service with its own due date is not also listed. */}
              <p className="text-[11px] text-[#8B7355] mt-2">
                Only the latest entry per unit and per kind is listed — a unit serviced twice carries two
                due dates, and only the later one is a real obligation.
              </p>
            </div>
          )}

          {/* ── what has been done to the units ────────────────────────────── */}
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
            <div className="flex flex-nowrap items-center gap-2 mb-2">
              <Wrench size={16} className="text-[#af4408] shrink-0" />
              <h2 className="text-sm font-bold text-[#2D1B0E]">What has been done to the units</h2>
              <button
                onClick={() => setForm({ event_kind: 'defrost', business_date: fssaiToday(), uom: 'C' })}
                className="ml-auto inline-flex flex-nowrap items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[#af4408] bg-white text-[#af4408] text-xs font-semibold"
              >
                <Plus size={13} /> Record one
              </button>
            </div>
            {events.length === 0 ? (
              <p className="text-sm text-[#6B5744] py-4 text-center">
                Nothing recorded yet. A defrost, a breakdown, a repair and the thermometer being checked
                against ice are the entries an inspector asks for the moment a reading is out of range.
              </p>
            ) : (
              <div className="space-y-1.5">
                {events.map((ev) => (
                  <div key={ev.id} className={`rounded-lg border p-2.5 ${
                    ev.status === 'void' ? 'border-gray-200 bg-gray-50 opacity-60'
                      : ev.is_fail ? 'border-red-200 bg-red-50/40' : 'border-[#E8D5C4] bg-[#FFF8F0]'
                  }`}>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[13px] font-semibold text-[#2D1B0E]">{ev.equipment_label}</span>
                      <span className="px-1.5 py-0.5 rounded text-[11px] bg-white border border-[#E8D5C4] text-[#6B5744]">{ev.event_kind_label}</span>
                      {ev.status === 'void' && <span className="px-1.5 py-0.5 rounded text-[11px] bg-gray-100 border border-gray-200 text-gray-600">Voided</span>}
                      {ev.status !== 'void' && ev.is_fail === 1 && <span className="px-1.5 py-0.5 rounded text-[11px] bg-red-100 border border-red-200 text-red-700">Fault</span>}
                      {ev.is_overdue && <span className="px-1.5 py-0.5 rounded text-[11px] bg-red-100 border border-red-200 text-red-700">Next one overdue</span>}
                      <span className="ml-auto text-[11px] text-[#8B7355]">{ev.business_date}{ev.event_at ? ` ${ev.event_at}` : ''}</span>
                    </div>
                    <p className="text-[13px] text-[#3D2614] mt-1">{ev.detail}</p>
                    {ev.event_kind === 'calibration' && ev.deviation !== null && (
                      <p className="text-xs text-[#6B5744] mt-1">
                        Read {ev.value_before} °{ev.uom} against {ev.reference_value} °{ev.uom} — {ev.display_deviation} °{ev.uom} out
                        {ev.value_after !== null ? `, ${ev.value_after} °${ev.uom} after adjusting` : ''}.
                      </p>
                    )}
                    <p className="text-[11px] text-[#8B7355] mt-1">
                      {[ev.performed_by, ev.vendor_name, ev.reference_no,
                        ev.downtime_minutes !== null ? `${ev.downtime_minutes} min down` : '',
                        ev.next_due_date ? `next due ${ev.next_due_date}` : '',
                        ev.photo_count ? `${ev.photo_count} attachment${ev.photo_count === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')}
                    </p>
                    {ev.status === 'void' && <p className="text-[11px] text-gray-600 mt-1">Voided by {ev.voided_by}: {ev.void_reason}</p>}
                    {ev.status !== 'void' && isMgmt && String(ev.created_by || '').toLowerCase() !== me.toLowerCase() && (
                      <button onClick={() => { setVoiding(ev); setVoidReason(''); }} className="mt-1.5 inline-flex flex-nowrap items-center gap-1 text-[11px] text-red-700 hover:underline">
                        <Ban size={11} /> Void this entry
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* ══ RECORD AN EVENT ═════════════════════════════════════════════════ */}
      {form && (
        <Modal title="Record something done to a unit" onClose={() => setForm(null)}>
          <div className="space-y-3">
            <div>
              <label className={labelCls}>Which unit *</label>
              <select className={inputCls} value={form.equipment_id || ''} onChange={(e) => setForm({ ...form, equipment_id: e.target.value })}>
                <option value="">Choose a unit</option>
                {units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>What happened</label>
              <select className={inputCls} value={form.event_kind} onChange={(e) => setForm({ ...form, event_kind: e.target.value })}>
                {FSSAI_EQUIPMENT_EVENT_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
              </select>
              <p className="text-[11px] text-[#8B7355] mt-1">{FSSAI_EQUIPMENT_EVENT_KINDS.find((k) => k.key === form.event_kind)?.hint}</p>
            </div>
            <div>
              <label className={labelCls}>What was actually done *</label>
              <textarea rows={3} className={inputCls} value={form.detail || ''} onChange={(e) => setForm({ ...form, detail: e.target.value })}
                placeholder="Emptied it, defrosted for two hours, cleaned and dried, loaded again at 3 °C" />
              <p className="text-[11px] text-[#8B7355] mt-1">
                An entry that only says &ldquo;defrost&rdquo; tells an inspector nothing about whether the unit was
                emptied, cleaned or checked afterwards.
              </p>
            </div>

            {/* The calibration numbers, only on a calibration. */}
            {form.event_kind === 'calibration' && (
              <>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className={labelCls}>It read *</label>
                    <input type="number" step="0.1" inputMode="decimal" className={inputCls}
                      value={form.value_before ?? ''} onChange={(e) => setForm({ ...form, value_before: e.target.value === '' ? '' : Number(e.target.value) })} />
                  </div>
                  <div>
                    <label className={labelCls}>Should read *</label>
                    <input type="number" step="0.1" inputMode="decimal" className={inputCls}
                      value={form.reference_value ?? ''} onChange={(e) => setForm({ ...form, reference_value: e.target.value === '' ? '' : Number(e.target.value) })} />
                  </div>
                  <div>
                    <label className={labelCls}>After adjusting</label>
                    <input type="number" step="0.1" inputMode="decimal" className={inputCls}
                      value={form.value_after ?? ''} onChange={(e) => setForm({ ...form, value_after: e.target.value === '' ? '' : Number(e.target.value) })} />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className={labelCls}>Allowed to be out by</label>
                    <input type="number" step="0.1" inputMode="decimal" className={inputCls}
                      value={form.tolerance ?? tolerance} onChange={(e) => setForm({ ...form, tolerance: e.target.value === '' ? '' : Number(e.target.value) })} />
                  </div>
                  <div>
                    <label className={labelCls}>Unit</label>
                    <select className={inputCls} value={form.uom || 'C'} onChange={(e) => setForm({ ...form, uom: e.target.value })}>
                      {FSSAI_TEMP_UOMS.map((u) => <option key={u.key} value={u.key}>{u.label}</option>)}
                    </select>
                  </div>
                </div>
                <p className="text-[11px] text-[#8B7355]">
                  Ice is 0 °C; boiling water is 100 °C at sea level. If the thermometer is out by more
                  than this it is recorded as a fault — and because every temperature in the file was
                  taken with it, say what you did with the probe or enter what it read after adjusting.
                </p>
              </>
            )}

            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className={labelCls}>Date</label>
                <input type="date" className={inputCls} max={fssaiToday()} value={form.business_date || ''} onChange={(e) => setForm({ ...form, business_date: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>Time</label>
                <input type="time" className={inputCls} value={form.event_at || ''} onChange={(e) => setForm({ ...form, event_at: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>Minutes down</label>
                <input type="number" inputMode="numeric" className={inputCls} value={form.downtime_minutes ?? ''} onChange={(e) => setForm({ ...form, downtime_minutes: e.target.value === '' ? '' : Number(e.target.value) })} />
              </div>
            </div>
            {/* A repair comes with paper, and the paper arrives days later. The API
             * allows 90 days here (a reading allows one) and demands a reason past
             * the first day — so the form asks for it at the same moment. */}
            {isISODate(form.business_date || '') && form.business_date < fssaiToday() && (
              <div>
                <label className={labelCls}>Why is this being entered for an earlier day? *</label>
                <input className={inputCls} value={form.backdate_reason || ''} onChange={(e) => setForm({ ...form, backdate_reason: e.target.value })} placeholder="The engineer's job sheet arrived today" />
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={labelCls}>Done by</label>
                <input className={inputCls} value={form.performed_by || ''} onChange={(e) => setForm({ ...form, performed_by: e.target.value })} placeholder="Your name, or the engineer's" />
              </div>
              <div>
                <label className={labelCls}>Job sheet / certificate no.</label>
                <input className={inputCls} value={form.reference_no || ''} onChange={(e) => setForm({ ...form, reference_no: e.target.value })} />
              </div>
            </div>
            <div>
              <label className={labelCls}>When is the next one due</label>
              <input type="date" className={inputCls} value={form.next_due_date || ''} onChange={(e) => setForm({ ...form, next_due_date: e.target.value })} />
              <p className="text-[11px] text-[#8B7355] mt-1">Leave it empty if nothing is scheduled. A date before today&apos;s entry is refused — it would show as overdue the moment you saved it.</p>
            </div>
            <div>
              <label className={labelCls}>A photograph or the job sheet (optional)</label>
              <ImageUpload
                value={form.photo_data_uri ? [form.photo_data_uri] : []}
                onChange={(imgs: string[]) => setForm({ ...form, photo_data_uri: imgs[0] || '' })}
                max={1}
                label="Add a photo"
                thumbSize={64}
              />
            </div>

            <button
              disabled={busy || !form.equipment_id || !String(form.detail || '').trim()}
              onClick={async () => { const j = await post({ ...form, action: 'record' }); if (j) setForm(null); }}
              className="w-full py-3 rounded-lg bg-[#af4408] text-white text-sm font-semibold disabled:opacity-50 inline-flex flex-nowrap items-center justify-center gap-2"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />} Record it
            </button>
          </div>
        </Modal>
      )}

      {voiding && (
        <Modal title="Void this entry" onClose={() => setVoiding(null)}>
          <div className="space-y-3">
            <p className="text-sm text-[#3D2614]">
              Nothing is removed — the entry stays, struck out, with your name and your reason on it.
              {voiding.next_due_date && ' It carries a next-due date, so the due list will fall back to the entry before it. Check that the unit is not then quietly shown as up to date.'}
            </p>
            <div>
              <label className={labelCls}>Why *</label>
              <textarea rows={3} className={inputCls} value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder="Recorded against the wrong unit" />
            </div>
            <button
              disabled={busy || voidReason.trim().length < 4}
              onClick={async () => { const j = await post({ action: 'void', id: voiding.id, reason: voidReason.trim() }); if (j) setVoiding(null); }}
              className="w-full py-3 rounded-lg bg-[#af4408] text-white text-sm font-semibold disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Void it'}
            </button>
          </div>
        </Modal>
      )}

      {viewing && (
        <div className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-4" onClick={() => setViewing(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={viewing} alt="Attachment on the record" className="max-h-[90vh] max-w-full rounded-lg" />
        </div>
      )}

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[70] max-w-[92vw] sm:max-w-xl px-4 py-3 rounded-xl bg-[#2D1B0E] text-white text-sm shadow-xl">
          {toast}
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-4xl mx-auto px-3 sm:px-4 py-4 sm:py-6 space-y-3 sm:space-y-4">
        <a href="/fssai" className="inline-flex flex-nowrap items-center gap-1.5 text-sm text-[#6B5744] hover:text-[#af4408]">
          <ArrowLeft size={15} /> Food Safety
        </a>
        <div className="flex flex-nowrap items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#af4408] text-white flex items-center justify-center shrink-0">
            <Snowflake size={20} />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-bold text-[#af4408] leading-tight">Cold Room Climate Control</h1>
            <p className="text-xs sm:text-sm text-[#6B5744]">Which units were read, which were not, and what has been done to them</p>
          </div>
        </div>
        {/* The one sentence that keeps the frozen-verdict rule visible here too. */}
        <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl p-3">
          <div className="flex flex-nowrap items-start gap-2.5">
            <Info size={16} className="text-[#af4408] shrink-0 mt-0.5" />
            <p className="text-[13px] text-[#3D2614] leading-relaxed">
              A thermometer found out of tolerance does <strong>not</strong> change the verdict on any
              reading already taken with it. Each reading keeps the range that was actually applied to
              it; the calibration entry sits in the file beside them so a reader can see the probe was
              out when they were taken.
            </p>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div
        className="bg-white rounded-t-3xl sm:rounded-xl border border-[#E8D5C4] w-full sm:max-w-lg shadow-xl flex flex-col overflow-hidden max-h-[92vh] sm:max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-[#E8D5C4] flex flex-nowrap items-center justify-between gap-2 shrink-0">
          <h2 className="text-sm font-bold text-[#2D1B0E] truncate">{title}</h2>
          <button onClick={onClose} className="w-9 h-9 rounded-lg hover:bg-[#FFF1E3] flex items-center justify-center shrink-0">
            <X size={18} className="text-[#6B5744]" />
          </button>
        </div>
        <div className="p-4 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
