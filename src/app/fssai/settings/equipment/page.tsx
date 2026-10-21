'use client';

/**
 * EQUIPMENT & COLD UNITS — the register every temperature verdict is judged
 * against, and the safe ranges themselves (P4).
 *
 * ── WHY THIS SCREEN COMES FIRST IN P4 ───────────────────────────────────────
 * Until a unit is on this list and has a range, a reading taken on it is recorded
 * and marked NOT JUDGED. That is the honest behaviour and it is deliberate — but
 * it also means an empty register makes the whole temperature module look broken.
 * So this screen leads with the gap: how many active units have no range, in
 * words, at the top, with the button that fixes it.
 *
 * ── THE FOUR NAMES THAT ALREADY EXIST ───────────────────────────────────────
 * There is no equipment master anywhere in this application. The only cold units
 * that exist are free text typed onto kitchen production labels
 * (`production_batches.storage_location`): Cold Room 1, Cold Room 2, Cold Room 3,
 * walkin chiller 1. The API offers those exact names and creates NONE of them by
 * itself — a seed that ran on boot or on first read would resurrect a unit an
 * admin had retired, which is the trap db.ts's own HRMS block states in its own
 * words. The admin presses the button, and the press is audited.
 *
 * ── WHAT THIS SCREEN PROMISES AND WHAT IT MUST NOT DO ───────────────────────
 * Changing a range here NEVER re-grades a record. Every reading freezes the range
 * that was actually applied to it, so tightening a standard next month cannot
 * retrospectively fail a fridge that passed. The screen says so out loud after
 * every range change, with the number of records it did not touch — because an
 * admin who has just tightened a number will reasonably wonder, and a count is a
 * better answer than a promise.
 *
 * ── ADMIN ONLY, AND WHY ─────────────────────────────────────────────────────
 * A wrong safe range re-grades how every future reading is judged, quietly. The
 * page catalog marks this path adminOnly, but the catalog is VISIBILITY and never
 * security (`canAccessPage` fails open four ways and `page_access` is NULL on 8 of
 * 9 live users) — so `/api/fssai/equipment` and `/api/fssai/temp-standards` each
 * gate themselves with `requireFssaiAdmin`, and this screen simply renders what
 * they allow.
 *
 * Styling is the house skeleton (RECON §1.3-1.6) verbatim: the #FFF8F0 page, the
 * #af4408 heading with an icon tile, white cards bordered #E8D5C4, native
 * selects and inputs, a per-page toast, a bg-black/40 overlay, and a modal
 * anchored to the BOTTOM of a phone where the thumb already is.
 * ⚠️ globals.css force-wraps any `.flex.gap-2|3|4`, so rows that must keep an icon
 * beside their text carry `flex-nowrap`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, Check, Info, Loader2, Lock, Plus, RefreshCw,
  Ruler, ShieldCheck, Snowflake, Thermometer, Undo2, X,
} from 'lucide-react';
import { apiJson } from '@/lib/api';
import {
  FSSAI_EQUIPMENT_KINDS, FSSAI_TEMP_UOMS, FSSAI_FREQUENCIES,
  fssaiDisplayReading,
} from '@/lib/fssai';

/* ------------------------------------------------------------------ *
 * Shapes — every field below is returned by the two P4 routes
 * ------------------------------------------------------------------ */

interface Unit {
  id: string;
  code: string;
  name: string;
  kind: string;
  kind_label: string;
  location_label: string;
  department_id: string;
  department_name: string;
  store_id: string;
  store_name: string;
  /** null = no range set. NEVER render this as 0 — 0 °C is a freezing reading. */
  min_temp: number | null;
  max_temp: number | null;
  temp_uom: string;
  has_range: boolean;
  check_frequency: string;
  is_active: 0 | 1;
  sort_order: number;
  notes: string;
}

interface Latest {
  id: string;
  business_date: string;
  reading_at: string;
  value_num: number | null;
  display: string;
  uom: string;
  is_fail: 0 | 1;
  is_judged: 0 | 1;
  fail_reason: string;
  recorded_name: string;
  recorded_by: string;
}

interface Standard {
  id: string;
  code: string;
  label: string;
  applies_to: string;
  applies_to_label: string;
  equipment_kind: string;
  equipment_kind_label: string;
  material_id: string;
  material_name: string;
  min_value: number | null;
  max_value: number | null;
  target_value: number | null;
  judges_anything: boolean;
  uom: string;
  decimals: number;
  max_minutes: number | null;
  authority: string;
  notes: string;
  is_active: 0 | 1;
}

interface Suggestion { label: string; batches: number }

const inputCls =
  'w-full bg-white border border-[#D4B896] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]';
const labelCls = 'block text-xs font-semibold text-[#6B5744] mb-1';

/** "0 to 5 °C" / "at or below −18 °C" / "no range set". The one phrasing. */
function rangeWords(min: number | null, max: number | null, uom: string): string {
  const u = uom === 'C' || uom === 'F' ? `°${uom}` : uom;
  if (min !== null && max !== null) return `${min} to ${max} ${u}`;
  if (max !== null) return `at or below ${max} ${u}`;
  if (min !== null) return `at or above ${min} ${u}`;
  return 'no range set';
}

export default function FssaiEquipmentSettingsPage() {
  const [tab, setTab] = useState<'units' | 'ranges'>('units');
  const [units, setUnits] = useState<Unit[]>([]);
  const [latest, setLatest] = useState<Record<string, Latest>>({});
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [standards, setStandards] = useState<Standard[]>([]);
  const [suggested, setSuggested] = useState<any[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [showRetired, setShowRetired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [editUnit, setEditUnit] = useState<Partial<Unit> | null>(null);
  const [editStd, setEditStd] = useState<Partial<Standard> | null>(null);
  const [retiring, setRetiring] = useState<{ kind: 'unit' | 'std'; id: string; name: string } | null>(null);
  const [retireReason, setRetireReason] = useState('');

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(t);
  }, [toast]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const [u, s] = await Promise.all([
        apiJson<any>(`/api/fssai/equipment?include_inactive=${showRetired ? 1 : 0}`),
        apiJson<any>(`/api/fssai/temp-standards?include_inactive=${showRetired ? 1 : 0}`),
      ]);
      setUnits(u.units || []);
      setLatest(u.latest || {});
      setSuggestions(u.suggestions || []);
      setCanEdit(!!u.can_edit);
      setStandards(s.standards || []);
      setSuggested(s.suggested || []);
      setSignedOut(false);
      setForbidden(false);
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Could not load the register';
      /* Told apart on purpose: "you are not an administrator" and "your session
       * ended" need different answers, and an empty screen under a red banner
       * answers neither. Copied from the sibling FSSAI screens so they cannot
       * drift. */
      if (/sign in|401/i.test(m)) setSignedOut(true);
      else if (/403|administrator|not allowed|only an admin/i.test(m)) setForbidden(true);
      else setErr(m);
    } finally {
      setLoading(false);
    }
  }, [showRetired]);

  useEffect(() => { void load(); }, [load]);

  const activeWithoutRange = useMemo(
    () => units.filter((u) => u.is_active && !u.has_range),
    [units],
  );

  async function post(url: string, body: any, okMsg?: string) {
    setBusy(true);
    try {
      const j = await apiJson<any>(url, { method: 'POST', body });
      setToast(okMsg || j.note || j.note_to_staff || 'Saved.');
      await load();
      return j;
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'That did not save.');
      return null;
    } finally {
      setBusy(false);
    }
  }

  /* ── the gates, as their own screens ───────────────────────────────────── */
  if (signedOut) {
    return (
      <Shell>
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 text-center">
          <Lock className="w-6 h-6 mx-auto mb-2 text-[#8B7355]" />
          <p className="text-sm text-[#3D2614]">Please sign in to set up the equipment register.</p>
        </div>
      </Shell>
    );
  }
  if (forbidden) {
    return (
      <Shell>
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-6">
          <div className="flex flex-nowrap items-start gap-3">
            <ShieldCheck className="w-5 h-5 text-[#af4408] shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-[#2D1B0E]">Only an administrator can change the safe ranges.</p>
              <p className="text-sm text-[#6B5744] mt-1">
                A wrong range here changes how every reading taken from now on is judged, and it does
                it quietly — so this screen is the administrator&apos;s. You can still see the units and
                their ranges on the cold-room board and when you record a reading.
              </p>
              <a href="/fssai/cold-rooms" className="inline-flex items-center gap-1.5 mt-3 text-sm font-semibold text-[#af4408] hover:underline">
                <Snowflake size={15} /> Cold room board
              </a>
            </div>
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      {/* ── the law of this screen, said once, at the top ─────────────────── */}
      <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl p-3 sm:p-4">
        <div className="flex flex-nowrap items-start gap-2.5">
          <Info size={16} className="text-[#af4408] shrink-0 mt-0.5" />
          <p className="text-[13px] text-[#3D2614] leading-relaxed">
            <strong>Your numbers, never ours.</strong> A range set on one unit beats the general rule
            for its kind, so a single awkward chiller can have its own numbers without changing
            anything else. Changing a range here never re-grades a reading already in the file — each
            one keeps the range that was actually applied to it.
          </p>
        </div>
      </div>

      {/* ── the gap that holds the whole module back, when there is one ───── */}
      {!loading && units.filter((u) => u.is_active).length === 0 && (
        <div className="bg-white border-2 border-[#af4408] rounded-xl p-4">
          <div className="flex flex-nowrap items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-[#af4408] shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-[#2D1B0E]">No unit is registered yet.</p>
              <p className="text-sm text-[#6B5744] mt-1">
                Until a cold room is on this list, a temperature taken on it has nothing to be judged
                against: it is recorded and marked <em>not judged</em>, and it is never counted as a
                pass.
                {suggestions.length > 0 && (
                  <> These {suggestions.length} names are already used on your kitchen production
                    labels, so registering them under the same names lines the existing batches up
                    instead of starting a fresh list.</>
                )}
              </p>
              {suggestions.length > 0 && canEdit && (
                <div className="mt-3 space-y-2">
                  <div className="flex flex-wrap gap-1.5">
                    {suggestions.map((s) => (
                      <span key={s.label} className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-[#FFF1E3] border border-[#E8D5C4] text-xs text-[#3D2614]">
                        {s.label}
                        <span className="text-[#8B7355]">· {s.batches} batch{s.batches === 1 ? '' : 'es'}</span>
                      </span>
                    ))}
                  </div>
                  <button
                    disabled={busy}
                    onClick={() => void post('/api/fssai/equipment', { action: 'create', names: suggestions.map((s) => s.label), kind: 'cold_room' })}
                    className="inline-flex flex-nowrap items-center gap-2 px-3 py-2 rounded-lg bg-[#af4408] text-white text-sm font-semibold disabled:opacity-50"
                  >
                    {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
                    Register these {suggestions.length} as cold rooms
                  </button>
                  <p className="text-xs text-[#8B7355]">
                    They will be created with no range — set each one&apos;s numbers afterwards, because a
                    walk-in and a dessert chiller are not the same thing.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {!loading && activeWithoutRange.length > 0 && (
        <div className="bg-[#FFF8E7] border border-[#E8C35C] rounded-xl p-3">
          <div className="flex flex-nowrap items-start gap-2.5">
            <Ruler size={16} className="text-[#8a6d1f] shrink-0 mt-0.5" />
            <p className="text-[13px] text-[#3D2614] leading-relaxed">
              <strong>
                {activeWithoutRange.length} unit{activeWithoutRange.length === 1 ? ' has' : 's have'} no
                safe range.
              </strong>{' '}
              A reading taken on {activeWithoutRange.length === 1 ? 'it' : 'them'} is recorded and marked
              as not judged — it is not counted as a pass, and it will not raise a follow-up job if the
              unit is warm. {activeWithoutRange.slice(0, 4).map((u) => u.name).join(', ')}
              {activeWithoutRange.length > 4 ? `, and ${activeWithoutRange.length - 4} more` : ''}.
            </p>
          </div>
        </div>
      )}

      {/* ── tabs ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        {([['units', 'Units', units.filter((u) => showRetired || u.is_active).length],
          ['ranges', 'Safe ranges', standards.filter((s) => showRetired || s.is_active).length]] as const).map(([k, label, n]) => (
            <button
              key={k}
              onClick={() => setTab(k as 'units' | 'ranges')}
              className={`px-3 py-2 rounded-lg border text-sm font-semibold flex-nowrap ${
                tab === k ? 'bg-[#af4408] border-[#af4408] text-white' : 'bg-white border-[#E8D5C4] text-[#6B5744] hover:border-[#af4408]'
              }`}
            >
              {label} <span className="opacity-70">({n})</span>
            </button>
          ))}
        <label className="ml-auto inline-flex flex-nowrap items-center gap-2 text-xs text-[#6B5744]">
          <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} />
          Show retired
        </label>
        <button
          onClick={() => void load()}
          title="Reload"
          className="w-11 h-11 rounded-lg border border-[#E8D5C4] bg-white hover:border-[#af4408] flex items-center justify-center"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin text-[#af4408]' : 'text-[#6B5744]'} />
        </button>
      </div>

      {err && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-800">{err}</div>
      )}

      {loading ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center">
          <Loader2 className="w-6 h-6 mx-auto animate-spin text-[#af4408]" />
        </div>
      ) : tab === 'units' ? (
        <>
          {canEdit && (
            <button
              onClick={() => setEditUnit({ kind: 'cold_room', temp_uom: 'C', check_frequency: 'daily' })}
              className="inline-flex flex-nowrap items-center gap-2 px-3 py-2 rounded-lg bg-[#af4408] text-white text-sm font-semibold"
            >
              <Plus size={15} /> Add a unit
            </button>
          )}
          {units.filter((u) => showRetired || u.is_active).length === 0 ? (
            <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center text-sm text-[#6B5744]">
              Nothing on the register yet.
            </div>
          ) : (
            <div className="space-y-2">
              {units.filter((u) => showRetired || u.is_active).map((u) => (
                <div key={u.id} className={`bg-white border rounded-xl p-3 ${u.is_active ? 'border-[#E8D5C4]' : 'border-gray-200 opacity-70'}`}>
                  <div className="flex flex-nowrap items-start gap-3">
                    <div className="w-9 h-9 rounded-lg bg-[#FFF1E3] border border-[#E8D5C4] flex items-center justify-center shrink-0">
                      <Snowflake size={17} className="text-[#af4408]" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold text-[#2D1B0E]">{u.name}</p>
                        <span className="px-1.5 py-0.5 rounded text-[11px] bg-[#FFF1E3] border border-[#E8D5C4] text-[#6B5744]">{u.kind_label}</span>
                        {!u.is_active && <span className="px-1.5 py-0.5 rounded text-[11px] bg-gray-100 border border-gray-200 text-gray-600">Retired</span>}
                        {u.has_range ? (
                          <span className="px-1.5 py-0.5 rounded text-[11px] bg-green-50 border border-green-200 text-green-700">
                            {rangeWords(u.min_temp, u.max_temp, u.temp_uom)}
                          </span>
                        ) : (
                          <span className="px-1.5 py-0.5 rounded text-[11px] bg-amber-50 border border-amber-200 text-amber-800">
                            No range — readings are not judged
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-[#8B7355] mt-0.5">
                        {[u.location_label, u.department_name, u.store_name, u.code].filter(Boolean).join(' · ') || '—'}
                      </p>
                      {latest[u.id] ? (
                        <p className="text-xs mt-1 text-[#6B5744]">
                          Last read{' '}
                          <strong className={latest[u.id].is_fail ? 'text-red-700' : latest[u.id].is_judged ? 'text-green-700' : 'text-amber-700'}>
                            {latest[u.id].display || '—'} °{latest[u.id].uom}
                          </strong>{' '}
                          on {latest[u.id].business_date}
                          {latest[u.id].reading_at ? ` at ${latest[u.id].reading_at}` : ''}
                          {latest[u.id].recorded_name ? ` by ${latest[u.id].recorded_name}` : ''}
                          {!latest[u.id].is_judged && ' — not judged'}
                        </p>
                      ) : (
                        <p className="text-xs mt-1 text-[#8B7355]">No reading has ever been taken on this unit.</p>
                      )}
                    </div>
                    {canEdit && (
                      <div className="flex flex-col gap-1.5 shrink-0">
                        <button onClick={() => setEditUnit(u)} className="px-2.5 py-1.5 rounded-lg border border-[#E8D5C4] bg-white text-xs font-semibold text-[#6B5744] hover:border-[#af4408]">
                          Edit
                        </button>
                        {u.is_active ? (
                          <button onClick={() => { setRetiring({ kind: 'unit', id: u.id, name: u.name }); setRetireReason(''); }} className="px-2.5 py-1.5 rounded-lg border border-[#E8D5C4] bg-white text-xs text-[#8B7355] hover:border-red-300">
                            Retire
                          </button>
                        ) : (
                          <button disabled={busy} onClick={() => void post('/api/fssai/equipment', { action: 'restore', id: u.id })} className="px-2.5 py-1.5 rounded-lg border border-[#E8D5C4] bg-white text-xs text-[#6B5744] hover:border-[#af4408] inline-flex flex-nowrap items-center gap-1">
                            <Undo2 size={12} /> Use again
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {canEdit && (
              <button
                onClick={() => setEditStd({ applies_to: 'equipment', uom: 'C', decimals: 1 })}
                className="inline-flex flex-nowrap items-center gap-2 px-3 py-2 rounded-lg bg-[#af4408] text-white text-sm font-semibold"
              >
                <Plus size={15} /> Add a rule
              </button>
            )}
            {canEdit && suggested.length > 0 && (
              <button
                disabled={busy}
                onClick={() => void post('/api/fssai/temp-standards', { action: 'create_suggested', codes: suggested.map((s: any) => s.code) })}
                className="inline-flex flex-nowrap items-center gap-2 px-3 py-2 rounded-lg border border-[#af4408] bg-white text-[#af4408] text-sm font-semibold disabled:opacity-50"
              >
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Thermometer size={15} />}
                Start from the {suggested.length} usual rules
              </button>
            )}
          </div>
          {canEdit && suggested.length > 0 && (
            <p className="text-xs text-[#8B7355]">
              Those are starting points, not the law — check every number against your own equipment
              and your licence conditions, and change what does not fit. Nothing is created until you
              press the button.
            </p>
          )}

          {standards.filter((s) => showRetired || s.is_active).length === 0 ? (
            <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center text-sm text-[#6B5744]">
              No rule has been set yet, so every reading is recorded and left unjudged.
            </div>
          ) : (
            <div className="space-y-2">
              {standards.filter((s) => showRetired || s.is_active).map((s) => (
                <div key={s.id} className={`bg-white border rounded-xl p-3 ${s.is_active ? 'border-[#E8D5C4]' : 'border-gray-200 opacity-70'}`}>
                  <div className="flex flex-nowrap items-start gap-3">
                    <div className="w-9 h-9 rounded-lg bg-[#FFF1E3] border border-[#E8D5C4] flex items-center justify-center shrink-0">
                      <Thermometer size={17} className="text-[#af4408]" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold text-[#2D1B0E]">{s.label}</p>
                        {s.code && <span className="px-1.5 py-0.5 rounded text-[11px] bg-gray-50 border border-gray-200 text-gray-600 font-mono">{s.code}</span>}
                        {!s.is_active && <span className="px-1.5 py-0.5 rounded text-[11px] bg-gray-100 border border-gray-200 text-gray-600">Retired</span>}
                        {!s.judges_anything && (
                          <span className="px-1.5 py-0.5 rounded text-[11px] bg-red-50 border border-red-200 text-red-700">
                            Judges nothing
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-[#3D2614] mt-0.5">
                        <strong>{rangeWords(s.min_value, s.max_value, s.uom)}</strong>
                        {s.target_value !== null && ` · aim for ${fssaiDisplayReading(s.target_value, s.decimals)}`}
                        {s.max_minutes !== null && ` · within ${s.max_minutes} minutes`}
                      </p>
                      <p className="text-xs text-[#8B7355] mt-0.5">
                        Applies to {s.applies_to_label}
                        {s.equipment_kind_label ? ` · ${s.equipment_kind_label} only` : ''}
                        {s.material_name ? ` · ${s.material_name} only` : ''}
                      </p>
                      {s.authority && <p className="text-xs text-[#8B7355] mt-1 italic">{s.authority}</p>}
                    </div>
                    {canEdit && (
                      <div className="flex flex-col gap-1.5 shrink-0">
                        <button onClick={() => setEditStd(s)} className="px-2.5 py-1.5 rounded-lg border border-[#E8D5C4] bg-white text-xs font-semibold text-[#6B5744] hover:border-[#af4408]">Edit</button>
                        {s.is_active ? (
                          <button onClick={() => { setRetiring({ kind: 'std', id: s.id, name: s.label }); setRetireReason(''); }} className="px-2.5 py-1.5 rounded-lg border border-[#E8D5C4] bg-white text-xs text-[#8B7355] hover:border-red-300">Retire</button>
                        ) : (
                          <button disabled={busy} onClick={() => void post('/api/fssai/temp-standards', { action: 'restore', id: s.id })} className="px-2.5 py-1.5 rounded-lg border border-[#E8D5C4] bg-white text-xs text-[#6B5744] hover:border-[#af4408] inline-flex flex-nowrap items-center gap-1"><Undo2 size={12} /> Use again</button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ══ the unit form ═══════════════════════════════════════════════════ */}
      {editUnit && (
        <Modal title={editUnit.id ? `Edit ${editUnit.name}` : 'Add a unit'} onClose={() => setEditUnit(null)}>
          <div className="space-y-3">
            <div>
              <label className={labelCls}>Name *</label>
              <input className={inputCls} value={editUnit.name || ''} onChange={(e) => setEditUnit({ ...editUnit, name: e.target.value })} placeholder="Cold Room 1" />
              <p className="text-[11px] text-[#8B7355] mt-1">This is what will appear on every reading taken on it, for ever — including after the unit is retired.</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>What kind</label>
                <select className={inputCls} value={editUnit.kind || 'cold_room'} onChange={(e) => setEditUnit({ ...editUnit, kind: e.target.value })}>
                  {FSSAI_EQUIPMENT_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>Read how often</label>
                <select className={inputCls} value={editUnit.check_frequency || 'daily'} onChange={(e) => setEditUnit({ ...editUnit, check_frequency: e.target.value })}>
                  {FSSAI_FREQUENCIES.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className={labelCls}>Minimum</label>
                <input type="number" step="0.1" inputMode="decimal" className={inputCls}
                  value={editUnit.min_temp === null || editUnit.min_temp === undefined ? '' : editUnit.min_temp}
                  onChange={(e) => setEditUnit({ ...editUnit, min_temp: e.target.value === '' ? null : Number(e.target.value) })} />
              </div>
              <div>
                <label className={labelCls}>Maximum</label>
                <input type="number" step="0.1" inputMode="decimal" className={inputCls}
                  value={editUnit.max_temp === null || editUnit.max_temp === undefined ? '' : editUnit.max_temp}
                  onChange={(e) => setEditUnit({ ...editUnit, max_temp: e.target.value === '' ? null : Number(e.target.value) })} />
              </div>
              <div>
                <label className={labelCls}>Unit</label>
                <select className={inputCls} value={editUnit.temp_uom || 'C'} onChange={(e) => setEditUnit({ ...editUnit, temp_uom: e.target.value })}>
                  {FSSAI_TEMP_UOMS.map((u) => <option key={u.key} value={u.key}>{u.label}</option>)}
                </select>
              </div>
            </div>
            {/* The one explanation an admin needs about a half-filled range. */}
            <p className="text-[11px] text-[#8B7355]">
              Leave either one empty if only one side matters: a freezer with a maximum of −18 and no
              minimum is normal, and one bound is still a rule. Leave BOTH empty and readings on this
              unit are recorded but never judged.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Where it is</label>
                <input className={inputCls} value={editUnit.location_label || ''} onChange={(e) => setEditUnit({ ...editUnit, location_label: e.target.value })} placeholder="Back of house" />
              </div>
              <div>
                <label className={labelCls}>Your own code</label>
                <input className={inputCls} value={editUnit.code || ''} onChange={(e) => setEditUnit({ ...editUnit, code: e.target.value })} placeholder="CR1" />
              </div>
            </div>
            <div>
              <label className={labelCls}>Notes</label>
              <textarea rows={2} className={inputCls} value={editUnit.notes || ''} onChange={(e) => setEditUnit({ ...editUnit, notes: e.target.value })} />
            </div>
            <button
              disabled={busy || !String(editUnit.name || '').trim()}
              onClick={async () => {
                const j = await post('/api/fssai/equipment', { ...editUnit, action: editUnit.id ? 'update' : 'create' });
                if (j) setEditUnit(null);
              }}
              className="w-full py-3 rounded-lg bg-[#af4408] text-white text-sm font-semibold disabled:opacity-50 inline-flex flex-nowrap items-center justify-center gap-2"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
              {editUnit.id ? 'Save' : 'Register this unit'}
            </button>
          </div>
        </Modal>
      )}

      {/* ══ the rule form ═══════════════════════════════════════════════════ */}
      {editStd && (
        <Modal title={editStd.id ? `Edit ${editStd.label}` : 'Add a safe range'} onClose={() => setEditStd(null)}>
          <div className="space-y-3">
            <div>
              <label className={labelCls}>Name *</label>
              <input className={inputCls} value={editStd.label || ''} onChange={(e) => setEditStd({ ...editStd, label: e.target.value })} placeholder="Chiller and cold room" />
              <p className="text-[11px] text-[#8B7355] mt-1">A record judged by this rule will name it, so write it the way you would say it.</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Applies to</label>
                <select className={inputCls} value={editStd.applies_to || 'equipment'} onChange={(e) => setEditStd({ ...editStd, applies_to: e.target.value })}>
                  {['equipment', 'food', 'delivery', 'hot_holding', 'cooking', 'cooling', 'reheating', 'thawing', 'probe_calibration', 'oil', 'water'].map((k) => (
                    <option key={k} value={k}>{k.replace(/_/g, ' ')}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelCls}>Only this kind of unit</label>
                <select className={inputCls} value={editStd.equipment_kind || ''} onChange={(e) => setEditStd({ ...editStd, equipment_kind: e.target.value })}>
                  <option value="">Any unit</option>
                  {FSSAI_EQUIPMENT_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-4 gap-2">
              <div>
                <label className={labelCls}>Minimum</label>
                <input type="number" step="0.1" inputMode="decimal" className={inputCls}
                  value={editStd.min_value === null || editStd.min_value === undefined ? '' : editStd.min_value}
                  onChange={(e) => setEditStd({ ...editStd, min_value: e.target.value === '' ? null : Number(e.target.value) })} />
              </div>
              <div>
                <label className={labelCls}>Maximum</label>
                <input type="number" step="0.1" inputMode="decimal" className={inputCls}
                  value={editStd.max_value === null || editStd.max_value === undefined ? '' : editStd.max_value}
                  onChange={(e) => setEditStd({ ...editStd, max_value: e.target.value === '' ? null : Number(e.target.value) })} />
              </div>
              <div>
                <label className={labelCls}>Aim for</label>
                <input type="number" step="0.1" inputMode="decimal" className={inputCls}
                  value={editStd.target_value === null || editStd.target_value === undefined ? '' : editStd.target_value}
                  onChange={(e) => setEditStd({ ...editStd, target_value: e.target.value === '' ? null : Number(e.target.value) })} />
              </div>
              <div>
                <label className={labelCls}>Unit</label>
                <select className={inputCls} value={editStd.uom || 'C'} onChange={(e) => setEditStd({ ...editStd, uom: e.target.value })}>
                  {[...FSSAI_TEMP_UOMS.map((u) => ({ key: u.key, label: u.label })), { key: 'pct', label: '%' }, { key: 'ppm', label: 'ppm' }, { key: 'pH', label: 'pH' }].map((u) => (
                    <option key={u.key} value={u.key}>{u.label}</option>
                  ))}
                </select>
              </div>
            </div>
            {/* The minutes field only appears where the FSSAI rule really is a rate. */}
            {(editStd.applies_to === 'cooling' || editStd.applies_to === 'reheating') && (
              <div>
                <label className={labelCls}>…within this many minutes</label>
                <input type="number" inputMode="numeric" className={inputCls}
                  value={editStd.max_minutes === null || editStd.max_minutes === undefined ? '' : editStd.max_minutes}
                  onChange={(e) => setEditStd({ ...editStd, max_minutes: e.target.value === '' ? null : Number(e.target.value) })} />
                <p className="text-[11px] text-[#8B7355] mt-1">
                  Cooling and reheating are judged on a rate, not a level: reaching the temperature
                  within the time. A reading still short of the target when the time is up fails; one
                  that has already got there does not.
                </p>
              </div>
            )}
            <div>
              <label className={labelCls}>Where the number comes from</label>
              <input className={inputCls} value={editStd.authority || ''} onChange={(e) => setEditStd({ ...editStd, authority: e.target.value })} placeholder="Our licence condition / FSSAI guidance / the manufacturer" />
              <p className="text-[11px] text-[#8B7355] mt-1">An inspector&apos;s first question about a range is whose number it is.</p>
            </div>
            <div>
              <label className={labelCls}>Your own code (optional)</label>
              <input className={inputCls} value={editStd.code || ''} onChange={(e) => setEditStd({ ...editStd, code: e.target.value })} placeholder="TEMP-CHILLER" />
            </div>
            <button
              disabled={busy || !String(editStd.label || '').trim()}
              onClick={async () => {
                const j = await post('/api/fssai/temp-standards', { ...editStd, action: editStd.id ? 'update' : 'create' });
                if (j) setEditStd(null);
              }}
              className="w-full py-3 rounded-lg bg-[#af4408] text-white text-sm font-semibold disabled:opacity-50 inline-flex flex-nowrap items-center justify-center gap-2"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
              {editStd.id ? 'Save' : 'Create this rule'}
            </button>
          </div>
        </Modal>
      )}

      {/* ══ retiring — a reason is required, and the screen says why ═════════ */}
      {retiring && (
        <Modal title={`Retire ${retiring.name}`} onClose={() => setRetiring(null)}>
          <div className="space-y-3">
            <p className="text-sm text-[#3D2614]">
              {retiring.kind === 'unit'
                ? 'It will stop appearing on the temperature round, and every reading ever taken on it will still name it. Nothing is deleted.'
                : 'Readings taken after this goes will be recorded and marked as not judged unless another rule covers them. Readings already judged by it still name it.'}
            </p>
            <div>
              <label className={labelCls}>Why *</label>
              <textarea rows={3} className={inputCls} value={retireReason} onChange={(e) => setRetireReason(e.target.value)} placeholder="Sold / replaced / no longer used" />
              <p className="text-[11px] text-[#8B7355] mt-1">Whoever notices the gap will want to know. Four characters at least.</p>
            </div>
            <button
              disabled={busy || retireReason.trim().length < 4}
              onClick={async () => {
                const url = retiring.kind === 'unit' ? '/api/fssai/equipment' : '/api/fssai/temp-standards';
                const j = await post(url, { action: 'retire', id: retiring.id, reason: retireReason.trim() });
                if (j) setRetiring(null);
              }}
              className="w-full py-3 rounded-lg bg-[#af4408] text-white text-sm font-semibold disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Retire it'}
            </button>
          </div>
        </Modal>
      )}

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-[92vw] sm:max-w-xl px-4 py-3 rounded-xl bg-[#2D1B0E] text-white text-sm shadow-xl">
          {toast}
        </div>
      )}
    </Shell>
  );
}

/* ------------------------------------------------------------------ *
 * The page shell — the house heading (RECON §1.3)
 * ------------------------------------------------------------------ */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-4xl mx-auto px-3 sm:px-4 py-4 sm:py-6 space-y-3 sm:space-y-4">
        <a href="/fssai/settings" className="inline-flex flex-nowrap items-center gap-1.5 text-sm text-[#6B5744] hover:text-[#af4408]">
          <ArrowLeft size={15} /> Settings
        </a>
        <div className="flex flex-nowrap items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#af4408] text-white flex items-center justify-center shrink-0">
            <Snowflake size={20} />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-bold text-[#af4408] leading-tight">Equipment &amp; Cold Units</h1>
            <p className="text-xs sm:text-sm text-[#6B5744]">The units, and the safe ranges every reading is judged against</p>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

/* A modal anchored to the BOTTOM of a phone, where the thumb already is. */
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
