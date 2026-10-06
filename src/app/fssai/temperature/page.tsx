'use client';

/**
 * TEMPERATURE LOGS — the running record of every temperature taken, and who took
 * it (P4, owner §4 and §5).
 *
 * ── THE ONE THING THIS SCREEN MUST GET RIGHT ────────────────────────────────
 * An UNJUDGED reading is NOT a pass. When no safe range applies, the reading is
 * recorded, `is_judged` is 0, and this screen paints it AMBER and says "not
 * judged" — never green. That matters more here than anywhere else in the module,
 * because until the owner has set his ranges EVERY reading is unjudged, and a
 * register that painted them all green would be the most dangerous thing this
 * software could print.
 *
 * ── WHAT THE FORM SHOWS BEFORE THE NUMBER IS TYPED ──────────────────────────
 * The range that will be applied, and where it came from — the unit's own numbers,
 * or a named rule, or nothing. `GET ?preview=1` resolves it server-side with the
 * same resolver the write path uses, so the screen cannot promise one rule and the
 * record freeze another.
 *
 * ── WHAT A FAILURE DEMANDS ──────────────────────────────────────────────────
 * What was DONE about it, in words, before the reading will file. The follow-up job
 * is raised automatically (owner §4) — but a record that says "the cold room was at
 * 11 °C" and nothing else is the entry an inspector opens first, and "we noticed"
 * is not a corrective action.
 *
 * ── WHAT THIS SCREEN CANNOT DO ──────────────────────────────────────────────
 * Edit a reading. There is no edit button and there is no edit route: a reading
 * entered wrongly is VOIDED by a manager with a written reason and a fresh one is
 * taken, so the file shows both. That is stated on the screen rather than merely
 * implemented, because somebody will eventually try.
 *
 * API: GET /api/fssai/temperature[?…], ?preview=1, ?id=, ?photo_id=
 *      POST { action: 'record' | 'void' | 'verify' | 'attach' }
 * Every mutation goes through apiJson() so the fnb_csrf header is sent.
 *
 * Styling is the house skeleton (RECON §1.3-1.6). ⚠️ globals.css force-wraps any
 * `.flex.gap-2|3|4`, so rows that must keep an icon beside their text carry
 * `flex-nowrap`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, Ban, BadgeCheck, Camera, Check,
  Info, Loader2, Lock, Plus, RefreshCw, Search, Snowflake, Thermometer, X,
} from 'lucide-react';
import { apiJson } from '@/lib/api';
import ImageUpload from '@/app/tasks/_components/ImageUpload';
import {
  FSSAI_TEMP_LOG_KINDS, FSSAI_SHIFTS, FSSAI_TEMP_UOMS,
  fssaiRecordStatusMeta, fssaiToday,
} from '@/lib/fssai';

interface Reading {
  id: string;
  business_date: string;
  reading_at: string;
  shift: string;
  log_kind: string;
  log_kind_label: string;
  source_kind: string;
  source_label: string;
  equipment_id: string;
  equipment_label: string;
  equipment_renamed_since: boolean;
  equipment_name_now: string;
  area_label: string;
  item_label: string;
  material_name: string;
  department_name: string;
  value_num: number | null;
  display_value: string;
  uom: string;
  min_used: number | null;
  max_used: number | null;
  range_label: string;
  standard_label: string;
  elapsed_minutes: number | null;
  max_minutes_used: number | null;
  is_fail: 0 | 1;
  is_judged: 0 | 1;
  fail_reason: string;
  action_taken: string;
  ca_id: string;
  ca_number: string;
  ca_status: string;
  note: string;
  status: string;
  status_label: string;
  recorded_by: string;
  recorded_name: string;
  verified_by: string;
  void_reason: string;
  voided_by: string;
  photo_count: number;
}

interface Unit {
  id: string; name: string; kind: string; kind_label: string;
  location_label: string; has_range: boolean;
  min_temp: number | null; max_temp: number | null; temp_uom: string;
}

const inputCls =
  'w-full bg-white border border-[#D4B896] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]';
const labelCls = 'block text-xs font-semibold text-[#6B5744] mb-1';

export default function FssaiTemperaturePage() {
  const [rows, setRows] = useState<Reading[]>([]);
  const [counts, setCounts] = useState({ total: 0, fails: 0, unjudged: 0, verified: 0, voided: 0 });
  const [units, setUnits] = useState<Unit[]>([]);
  const [isMgmt, setIsMgmt] = useState(false);
  const [me, setMe] = useState('');
  const [today, setToday] = useState(fssaiToday());
  const [earliest, setEarliest] = useState('');

  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [kind, setKind] = useState('');
  const [onlyFails, setOnlyFails] = useState(false);
  const [onlyUnjudged, setOnlyUnjudged] = useState(false);
  const [q, setQ] = useState('');

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [open, setOpen] = useState<Reading | null>(null);
  const [photos, setPhotos] = useState<any[]>([]);
  const [viewing, setViewing] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<Reading | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [form, setForm] = useState<any | null>(null);
  const [preview, setPreview] = useState<any | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(t);
  }, [toast]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const p = new URLSearchParams();
      if (from) p.set('from', from);
      if (to) p.set('to', to);
      if (kind) p.set('log_kind', kind);
      if (onlyFails) p.set('fails', '1');
      if (onlyUnjudged) p.set('unjudged', '1');
      if (q.trim()) p.set('q', q.trim());
      const [j, u] = await Promise.all([
        apiJson<any>(`/api/fssai/temperature?${p}`),
        apiJson<any>('/api/fssai/equipment?with_latest=0'),
      ]);
      setRows(j.readings || []);
      setCounts(j.counts || counts);
      setIsMgmt(!!j.is_management);
      setMe(j.me || '');
      setToday(j.today || fssaiToday());
      setEarliest(j.earliest_backdate || '');
      setUnits((u.units || []).filter((x: any) => x.is_active));
      setSignedOut(false);
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Could not load the temperature log';
      if (/sign in|401/i.test(m)) setSignedOut(true);
      else setErr(m);
      setRows([]);
    } finally {
      setLoading(false);
    }
    // `counts` is read only as the fallback shape; depending on it would reload forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, kind, onlyFails, onlyUnjudged, q]);

  useEffect(() => { void load(); }, [load]);

  /* THE RANGE, RESOLVED BY THE SERVER, BEFORE THE NUMBER IS TYPED.
   * Deliberately not computed on the client from `units`: the resolver also walks
   * the standards table, and two implementations of "which rule applies" is exactly
   * the drift this module is built to avoid. */
  const refreshPreview = useCallback(async (f: any) => {
    if (!f) { setPreview(null); return; }
    try {
      const p = new URLSearchParams({ preview: '1', log_kind: f.log_kind || 'equipment' });
      if (f.equipment_id) p.set('equipment_id', f.equipment_id);
      if (f.uom) p.set('uom', f.uom);
      setPreview(await apiJson<any>(`/api/fssai/temperature?${p}`));
    } catch { setPreview(null); }
  }, []);

  useEffect(() => { void refreshPreview(form); }, [form?.log_kind, form?.equipment_id, form?.uom, refreshPreview]);

  const unjudgedShare = useMemo(
    () => (rows.length ? Math.round((rows.filter((r) => !r.is_judged && r.status !== 'void').length / rows.length) * 100) : 0),
    [rows],
  );

  async function openOne(r: Reading) {
    setOpen(r);
    setPhotos([]);
    try {
      const j = await apiJson<any>(`/api/fssai/temperature?id=${encodeURIComponent(r.id)}`);
      setOpen(j.reading);
      setPhotos(j.photos || []);
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'Could not open that reading');
    }
  }

  async function post(body: any, okFromKey = 'note_to_staff') {
    setBusy(true);
    try {
      const j = await apiJson<any>('/api/fssai/temperature', { method: 'POST', body });
      setToast(j[okFromKey] || j.note || j.record_unchanged || 'Saved.');
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
          <p className="text-sm text-[#3D2614]">Please sign in to record and read temperatures.</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      {/* ── the law of this screen ────────────────────────────────────────── */}
      <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl p-3 sm:p-4">
        <div className="flex flex-nowrap items-start gap-2.5">
          <Info size={16} className="text-[#af4408] shrink-0 mt-0.5" />
          <p className="text-[13px] text-[#3D2614] leading-relaxed">
            <strong>A reading cannot be edited once it is filed.</strong> If one was entered wrongly a
            manager voids it with a reason and a fresh one is taken — the file then shows both. And a
            reading with no safe range to judge it is marked <em>not judged</em>: it is recorded, and it
            is never counted as a pass.
          </p>
        </div>
      </div>

      {!loading && units.length === 0 && (
        <div className="bg-white border-2 border-[#af4408] rounded-xl p-4">
          <div className="flex flex-nowrap items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-[#af4408] shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-[#2D1B0E]">No cold unit is registered yet.</p>
              <p className="text-sm text-[#6B5744] mt-1">
                You can still record a reading against a place or a dish by name. But until the units
                are on the register with their ranges, nothing can judge a cold-room reading — it will
                be recorded and marked as not judged.
              </p>
              <a href="/fssai/settings/equipment" className="inline-flex flex-nowrap items-center gap-1.5 mt-2 text-sm font-semibold text-[#af4408] hover:underline">
                <Snowflake size={15} /> Set the units up
              </a>
            </div>
          </div>
        </div>
      )}

      {/* ── the figures, with the one that matters most said in words ─────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {([['Readings', counts.total, 'text-[#2D1B0E]'],
          ['Out of range', counts.fails, 'text-red-700'],
          ['Not judged', counts.unjudged, 'text-amber-700'],
          ['Checked off', counts.verified, 'text-green-700']] as const).map(([label, n, cls]) => (
            <div key={label} className="bg-white border border-[#E8D5C4] rounded-xl p-3">
              <p className="text-[11px] text-[#8B7355]">{label}</p>
              <p className={`text-xl font-bold ${cls}`}>{n}</p>
            </div>
          ))}
      </div>
      {counts.unjudged > 0 && (
        <p className="text-xs text-amber-800">
          {counts.unjudged} of {counts.total} readings in this range had no rule to judge them
          {unjudgedShare ? ` (${unjudgedShare}% of what is on screen)` : ''}. Those are recorded, not
          passed — set the ranges and the ones taken afterwards will be judged.
        </p>
      )}

      {/* ── record, and the filters ───────────────────────────────────────── */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setForm({ log_kind: 'equipment', uom: 'C', business_date: today, shift: '' })}
          className="inline-flex flex-nowrap items-center gap-2 px-3 py-2 rounded-lg bg-[#af4408] text-white text-sm font-semibold"
        >
          <Plus size={16} /> Record a temperature
        </button>
        <button
          onClick={() => void load()}
          title="Reload"
          className="ml-auto w-11 h-11 rounded-lg border border-[#E8D5C4] bg-white hover:border-[#af4408] flex items-center justify-center"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin text-[#af4408]' : 'text-[#6B5744]'} />
        </button>
      </div>

      <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 space-y-2">
        <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8B7355]" />
            <input className={`${inputCls} pl-9`} placeholder="Unit, dish, place, person…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <input type="date" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} />
          <input type="date" className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select className={`${inputCls} w-auto`} value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Every kind</option>
            {FSSAI_TEMP_LOG_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
          <label className="inline-flex flex-nowrap items-center gap-2 text-xs text-[#6B5744]">
            <input type="checkbox" checked={onlyFails} onChange={(e) => setOnlyFails(e.target.checked)} /> Out of range only
          </label>
          <label className="inline-flex flex-nowrap items-center gap-2 text-xs text-[#6B5744]">
            <input type="checkbox" checked={onlyUnjudged} onChange={(e) => setOnlyUnjudged(e.target.checked)} /> Not judged only
          </label>
        </div>
      </div>

      {err && <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-800">{err}</div>}

      {loading ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center">
          <Loader2 className="w-6 h-6 mx-auto animate-spin text-[#af4408]" />
        </div>
      ) : rows.length === 0 ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center">
          <Thermometer className="w-6 h-6 mx-auto mb-2 text-[#8B7355]" />
          <p className="text-sm text-[#3D2614]">No reading matches that.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => <ReadingCard key={r.id} r={r} onOpen={() => void openOne(r)} />)}
        </div>
      )}

      {/* ══ RECORD ══════════════════════════════════════════════════════════ */}
      {form && (
        <Modal title="Record a temperature" onClose={() => { setForm(null); setPreview(null); }}>
          <div className="space-y-3">
            <div>
              <label className={labelCls}>What kind of reading</label>
              <select className={inputCls} value={form.log_kind} onChange={(e) => setForm({ ...form, log_kind: e.target.value })}>
                {FSSAI_TEMP_LOG_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
              </select>
              <p className="text-[11px] text-[#8B7355] mt-1">
                {FSSAI_TEMP_LOG_KINDS.find((k) => k.key === form.log_kind)?.hint}
              </p>
            </div>

            <div>
              <label className={labelCls}>Which unit</label>
              <select className={inputCls} value={form.equipment_id || ''} onChange={(e) => setForm({ ...form, equipment_id: e.target.value })}>
                <option value="">Not a registered unit</option>
                {units.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} — {u.has_range ? `${u.min_temp ?? ''}${u.min_temp !== null && u.max_temp !== null ? ' to ' : ''}${u.max_temp ?? ''} °${u.temp_uom}` : 'no range set'}
                  </option>
                ))}
              </select>
            </div>

            {!form.equipment_id && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Place</label>
                  <input className={inputCls} value={form.area_label || ''} onChange={(e) => setForm({ ...form, area_label: e.target.value })} placeholder="Dry store" />
                </div>
                <div>
                  <label className={labelCls}>Or the dish / item</label>
                  <input className={inputCls} value={form.item_label || ''} onChange={(e) => setForm({ ...form, item_label: e.target.value })} placeholder="Chicken curry" />
                </div>
              </div>
            )}

            {/* ── THE RANGE, BEFORE THE NUMBER. The whole point of ?preview=1. ── */}
            {preview && (
              <div className={`rounded-lg border p-2.5 text-[12px] leading-relaxed ${
                preview.range?.source === 'none'
                  ? 'bg-amber-50 border-amber-200 text-amber-900'
                  : 'bg-green-50 border-green-200 text-green-800'
              }`}>
                <strong>{preview.range_label === 'no range set' ? 'No range set' : `Will be judged against ${preview.range_label}`}</strong>
                {' — '}{preview.note}
              </div>
            )}

            <div className="grid grid-cols-3 gap-2">
              <div className="col-span-2">
                <label className={labelCls}>The reading *</label>
                <input
                  type="number" step="0.1" inputMode="decimal" autoFocus
                  className={`${inputCls} text-lg font-semibold`}
                  value={form.value_num ?? ''}
                  onChange={(e) => setForm({ ...form, value_num: e.target.value === '' ? '' : Number(e.target.value) })}
                />
              </div>
              <div>
                <label className={labelCls}>Unit</label>
                <select className={inputCls} value={form.uom} onChange={(e) => setForm({ ...form, uom: e.target.value })}>
                  {FSSAI_TEMP_UOMS.map((u) => <option key={u.key} value={u.key}>{u.label}</option>)}
                </select>
              </div>
            </div>

            {/* The clock half, only on the two kinds whose rule is a rate. */}
            {!!FSSAI_TEMP_LOG_KINDS.find((k) => k.key === form.log_kind)?.window_minutes && (
              <div>
                <label className={labelCls}>Minutes since it started coming down / going up</label>
                <input type="number" inputMode="numeric" className={inputCls}
                  value={form.elapsed_minutes ?? ''}
                  onChange={(e) => setForm({ ...form, elapsed_minutes: e.target.value === '' ? '' : Number(e.target.value) })} />
                <p className="text-[11px] text-[#8B7355] mt-1">
                  {preview?.range?.max_minutes
                    ? `The rule allows ${preview.range.max_minutes} minutes to reach the target. Past that, a reading that has not got there yet fails.`
                    : 'No time limit is set for this kind, so only the temperature is judged.'}
                </p>
              </div>
            )}

            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className={labelCls}>Date</label>
                <input type="date" className={inputCls} min={earliest || undefined} max={today}
                  value={form.business_date} onChange={(e) => setForm({ ...form, business_date: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>Time read</label>
                <input type="time" className={inputCls} value={form.reading_at || ''} onChange={(e) => setForm({ ...form, reading_at: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>Shift</label>
                <select className={inputCls} value={form.shift} onChange={(e) => setForm({ ...form, shift: e.target.value })}>
                  {FSSAI_SHIFTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
              </div>
            </div>
            {form.business_date && form.business_date < today && (
              <div>
                <label className={labelCls}>Why is this for an earlier day? *</label>
                <input className={inputCls} value={form.backdate_reason || ''} onChange={(e) => setForm({ ...form, backdate_reason: e.target.value })} placeholder="The sheet was filled in on paper and typed up this morning" />
              </div>
            )}

            <div>
              <label className={labelCls}>
                What you did about it
                {/* Required by the API when the reading fails, and the form says so
                 * before the refusal does. */}
                {preview && form.value_num !== '' && form.value_num !== undefined && outOfPreviewRange(form, preview) && <span className="text-red-700"> * — this reading is out of range</span>}
              </label>
              <textarea rows={2} className={inputCls} value={form.action_taken || ''} onChange={(e) => setForm({ ...form, action_taken: e.target.value })}
                placeholder="Moved the stock to Cold Room 2 and called the engineer" />
            </div>
            <div>
              <label className={labelCls}>Note (optional)</label>
              <input className={inputCls} value={form.note || ''} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </div>

            <div>
              <label className={labelCls}>A photograph of the display (optional)</label>
              {/* The Task module's own uploader: it shrinks a 12 MP photograph to
               * ~165 KB before it ever reaches the network, which is what keeps this
               * under production's 1 MB nginx limit (HARD RULE 14). */}
              <ImageUpload
                value={form.photo_data_uri ? [form.photo_data_uri] : []}
                onChange={(imgs: string[]) => setForm({ ...form, photo_data_uri: imgs[0] || '' })}
                max={1}
                label="Take a photo"
                thumbSize={64}
              />
            </div>

            <button
              disabled={busy || form.value_num === '' || form.value_num === undefined}
              onClick={async () => {
                const j = await post({ ...form, action: 'record' });
                if (j) { setForm(null); setPreview(null); }
              }}
              className="w-full py-3 rounded-lg bg-[#af4408] text-white text-sm font-semibold disabled:opacity-50 inline-flex flex-nowrap items-center justify-center gap-2"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />} File this reading
            </button>
          </div>
        </Modal>
      )}

      {/* ══ ONE READING ═════════════════════════════════════════════════════ */}
      {open && (
        <Modal title={`${open.log_kind_label} — ${open.equipment_label || open.area_label || open.item_label || 'reading'}`} onClose={() => { setOpen(null); setPhotos([]); }}>
          <div className="space-y-3">
            <div className={`rounded-lg border p-3 ${
              open.status === 'void' ? 'bg-gray-50 border-gray-200'
                : open.is_fail ? 'bg-red-50 border-red-200'
                  : open.is_judged ? 'bg-green-50 border-green-200' : 'bg-amber-50 border-amber-200'
            }`}>
              <p className="text-2xl font-bold text-[#2D1B0E]">
                {open.display_value || '—'} <span className="text-base">°{open.uom}</span>
              </p>
              <p className="text-[13px] mt-1 text-[#3D2614]">
                {open.status === 'void'
                  ? `Voided by ${open.voided_by}: ${open.void_reason}`
                  : open.is_fail
                    ? open.fail_reason
                    : open.is_judged
                      ? `Within ${open.range_label}.`
                      : 'No safe range applied to this, so nothing judged it. It is recorded and NOT counted as a pass.'}
              </p>
              {open.standard_label && <p className="text-xs text-[#6B5744] mt-1">Rule applied: {open.standard_label}</p>}
              {open.elapsed_minutes !== null && (
                <p className="text-xs text-[#6B5744] mt-1">
                  {open.elapsed_minutes} minutes elapsed{open.max_minutes_used !== null ? ` · the rule allows ${open.max_minutes_used}` : ''}
                </p>
              )}
            </div>

            <dl className="text-[13px] space-y-1">
              <Row k="Taken" v={`${open.business_date}${open.reading_at ? ` at ${open.reading_at}` : ''}${open.shift ? ` · ${FSSAI_SHIFTS.find((s) => s.key === open.shift)?.label}` : ''}`} />
              <Row k="By" v={`${open.recorded_name || open.recorded_by}${open.verified_by ? ` · checked by ${open.verified_by}` : ''}`} />
              <Row k="How it got here" v={open.source_label} />
              {open.department_name && <Row k="Department" v={open.department_name} />}
              {open.item_label && <Row k="Item" v={open.item_label} />}
              {open.material_name && <Row k="From the item list" v={open.material_name} />}
              {open.action_taken && <Row k="Done at the time" v={open.action_taken} />}
              {open.note && <Row k="Note" v={open.note} />}
              <Row k="Status" v={fssaiRecordStatusMeta(open.status).label} />
            </dl>

            {open.equipment_renamed_since && (
              <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2">
                This unit is now called &ldquo;{open.equipment_name_now}&rdquo;. The reading keeps the name it
                was taken under, so the record does not change when a unit is renamed.
              </p>
            )}

            {open.ca_number && (
              <a href="/fssai/corrective-actions" className="block rounded-lg border border-[#E8D5C4] bg-[#FFF1E3] p-2.5 text-[13px] text-[#3D2614] hover:border-[#af4408]">
                Follow-up job <strong>{open.ca_number}</strong> was raised from this reading
                {open.ca_status ? ` — now "${open.ca_status.replace(/_/g, ' ')}"` : ''}.
              </a>
            )}

            {photos.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {photos.map((p) => (
                  <button key={p.id} onClick={async () => {
                    try { const j = await apiJson<any>(`/api/fssai/temperature?photo_id=${encodeURIComponent(p.id)}`); setViewing(j.data_uri || ''); }
                    catch (e) { setToast(e instanceof Error ? e.message : 'Could not open that photograph'); }
                  }} className="w-20 h-20 rounded-lg border border-[#E8D5C4] bg-[#FFF1E3] flex items-center justify-center hover:border-[#af4408]">
                    <Camera size={20} className="text-[#af4408]" />
                  </button>
                ))}
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-1">
              {open.status === 'submitted' && isMgmt && String(open.recorded_by || '').toLowerCase() !== me.toLowerCase() && (
                <button disabled={busy} onClick={async () => { const j = await post({ action: 'verify', id: open.id }, 'record_unchanged'); if (j) setOpen(null); }}
                  className="flex-1 min-w-[140px] py-2.5 rounded-lg bg-green-700 text-white text-sm font-semibold disabled:opacity-50 inline-flex flex-nowrap items-center justify-center gap-2">
                  <BadgeCheck size={16} /> Check it off
                </button>
              )}
              {open.status !== 'void' && isMgmt && (
                <button onClick={() => { setVoiding(open); setVoidReason(''); setOpen(null); }}
                  className="flex-1 min-w-[140px] py-2.5 rounded-lg border border-red-300 bg-white text-red-700 text-sm font-semibold inline-flex flex-nowrap items-center justify-center gap-2">
                  <Ban size={16} /> Void it
                </button>
              )}
            </div>
            {open.status === 'submitted' && isMgmt && String(open.recorded_by || '').toLowerCase() === me.toLowerCase() && (
              <p className="text-xs text-[#8B7355]">
                You took this reading, so somebody else has to check it off. That is the whole point of a
                second pair of eyes.
              </p>
            )}
          </div>
        </Modal>
      )}

      {viewing && (
        <div className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-4" onClick={() => setViewing(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={viewing} alt="Photograph on the record" className="max-h-[90vh] max-w-full rounded-lg" />
        </div>
      )}

      {/* ══ VOID ════════════════════════════════════════════════════════════ */}
      {voiding && (
        <Modal title="Void this reading" onClose={() => setVoiding(null)}>
          <div className="space-y-3">
            <p className="text-sm text-[#3D2614]">
              Nothing is removed. The reading stays in the file, struck out, with your name and your
              reason on it — a void says it was <em>entered wrongly</em>, not that the unit was fine.
              {voiding.ca_number && ` The follow-up job ${voiding.ca_number} stays open; cancel that separately if it should not have been raised.`}
            </p>
            <div>
              <label className={labelCls}>Why *</label>
              <textarea rows={3} className={inputCls} value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder="Entered against the wrong fridge" />
            </div>
            <button
              disabled={busy || voidReason.trim().length < 4}
              onClick={async () => { const j = await post({ action: 'void', id: voiding.id, reason: voidReason.trim() }, 'note'); if (j) setVoiding(null); }}
              className="w-full py-3 rounded-lg bg-[#af4408] text-white text-sm font-semibold disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Void it'}
            </button>
          </div>
        </Modal>
      )}

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[70] max-w-[92vw] sm:max-w-xl px-4 py-3 rounded-xl bg-[#2D1B0E] text-white text-sm shadow-xl">
          {toast}
        </div>
      )}
    </Shell>
  );
}

/**
 * Would this reading be out of the previewed range?
 *
 * CLIENT-SIDE AND FOR THE LABEL ONLY — it decides whether to mark "what you did
 * about it" as required BEFORE the server refuses. The verdict that is stored is
 * always the server's: this is a courtesy, never the gate, and it is unrounded for
 * the same reason the server is (5.4 on a 0–5 rule is a failure).
 */
function outOfPreviewRange(form: any, preview: any): boolean {
  const v = Number(form?.value_num);
  if (!Number.isFinite(v) || !preview?.range) return false;
  const { min, max } = preview.range;
  if (min !== null && min !== undefined && v < Number(min)) return true;
  if (max !== null && max !== undefined && v > Number(max)) return true;
  return false;
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex flex-nowrap gap-2">
      <dt className="text-[#8B7355] shrink-0 w-[8.5rem]">{k}</dt>
      <dd className="text-[#2D1B0E] min-w-0">{v}</dd>
    </div>
  );
}

function ReadingCard({ r, onOpen }: { r: Reading; onOpen: () => void }) {
  const voided = r.status === 'void';
  return (
    <button
      onClick={onOpen}
      className={`w-full text-left bg-white border rounded-xl p-3 hover:border-[#af4408] focus:outline-none focus:border-[#af4408] ${
        voided ? 'border-gray-200 opacity-60' : r.is_fail ? 'border-red-200' : 'border-[#E8D5C4]'
      }`}
    >
      <div className="flex flex-nowrap items-start gap-3">
        <div className={`w-11 shrink-0 text-center ${voided ? 'line-through text-gray-500' : r.is_fail ? 'text-red-700' : r.is_judged ? 'text-green-700' : 'text-amber-700'}`}>
          <p className="text-base font-bold leading-tight">{r.display_value || '—'}</p>
          <p className="text-[10px]">°{r.uom}</p>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-sm font-semibold text-[#2D1B0E] truncate">
              {r.equipment_label || r.area_label || r.item_label || r.material_name || '—'}
            </p>
            <span className="px-1.5 py-0.5 rounded text-[11px] bg-[#FFF1E3] border border-[#E8D5C4] text-[#6B5744]">{r.log_kind_label}</span>
            {voided && <span className="px-1.5 py-0.5 rounded text-[11px] bg-gray-100 border border-gray-200 text-gray-600">Voided</span>}
            {!voided && r.is_fail && <span className="px-1.5 py-0.5 rounded text-[11px] bg-red-100 border border-red-200 text-red-700">Out of range</span>}
            {!voided && !r.is_judged && <span className="px-1.5 py-0.5 rounded text-[11px] bg-amber-100 border border-amber-200 text-amber-800">Not judged</span>}
            {r.status === 'verified' && <span className="px-1.5 py-0.5 rounded text-[11px] bg-green-100 border border-green-200 text-green-700">Checked</span>}
            {r.ca_number && <span className="px-1.5 py-0.5 rounded text-[11px] bg-[#FFF1E3] border border-[#E8D5C4] text-[#af4408] font-mono">{r.ca_number}</span>}
          </div>
          <p className="text-xs text-[#8B7355] mt-0.5">
            {r.business_date}{r.reading_at ? ` · ${r.reading_at}` : ''} · {r.recorded_name || r.recorded_by}
            {r.is_judged ? ` · ${r.range_label}` : ''}
            {r.photo_count ? ` · ${r.photo_count} photo${r.photo_count === 1 ? '' : 's'}` : ''}
          </p>
          {!voided && r.is_fail && r.fail_reason && <p className="text-xs text-red-700 mt-1">{r.fail_reason}</p>}
        </div>
      </div>
    </button>
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
            <Thermometer size={20} />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-bold text-[#af4408] leading-tight">Temperature Logs</h1>
            <p className="text-xs sm:text-sm text-[#6B5744]">Every temperature taken, and who took it</p>
          </div>
          <a href="/fssai/cold-rooms" className="ml-auto hidden sm:inline-flex flex-nowrap items-center gap-1.5 px-3 py-2 rounded-lg border border-[#E8D5C4] bg-white text-sm text-[#6B5744] hover:border-[#af4408]">
            <Snowflake size={15} /> Cold rooms
          </a>
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
