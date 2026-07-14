'use client';

/**
 * Hygiene Audits (/tasks/hygiene) — daily area-by-area hygiene inspection.
 *
 * Four areas (Restaurant / Washrooms / Kitchen / Bar), each with a fixed item
 * checklist. Per item: Pass / Fail / N/A toggle, optional photo URL, and a
 * corrective-action note. Recording a FAIL auto-creates a Hygiene task
 * (source='hygiene') on the server. A live score gauge per area + an overall
 * daily hygiene score update as you toggle; date picker for back-filling /
 * reviewing past days; recent history + CSV export.
 *
 * Score = pass / (pass + fail) × 100 (N/A excluded). Client gate mirrors the
 * server: admin / manager / head chef / store manager. Warm theme, mobile-first.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle, ArrowLeft, CheckCircle2, Download, Loader2,
  RefreshCw, Save, SprayCan, X,
} from 'lucide-react';
import { api } from '@/lib/api';
import { HYGIENE_AREAS, type HygieneAudit } from '@/lib/tasks';
import ImageUpload from '@/app/tasks/_components/ImageUpload';
import UserPicker from '@/app/tasks/_components/UserPicker';

/* ── area → item checklists ───────────────────────────────────────────── */

const AREA_ITEMS: Record<string, string[]> = {
  Restaurant: [
    'Floor Cleanliness', 'Tables & Chairs', 'Dining Area', 'Entrance & Reception',
    'Signage & Menus', 'Waiting Area', 'Air Freshness',
  ],
  Washrooms: [
    'Toilets & Urinals', 'Wash Basins', 'Hand Soap & Sanitizer', 'Tissue & Hand Towels',
    'Floor Dryness', 'Odour & Freshener', 'Mirrors & Fittings',
  ],
  Kitchen: [
    'Work Surfaces', 'Floor & Drains', 'Equipment Cleanliness', 'Storage Areas',
    'Waste Bins', 'Hand Wash Station', 'Chiller & Freezer Hygiene', 'Pest Control',
  ],
  Bar: [
    'Counter Surfaces', 'Glassware Cleanliness', 'Ice Well', 'Bottle & Stock Storage',
    'Sink & Drains', 'Bar Floor', 'Waste Disposal',
  ],
};

type Result = 'pass' | 'fail' | 'na' | '';
interface ItemState { result: Result; image_url: string; corrective_action: string; assignee_email: string; assignee_name: string }
type FormState = Record<string, ItemState>; // key = `${area}|||${item}`

const blankItem = (): ItemState => ({ result: '', image_url: '', corrective_action: '', assignee_email: '', assignee_name: '' });

/**
 * The hygiene POST has no assignee field — a corrective task is created for every
 * fail and only @mentions in corrective_action fan out notifications. To honour a
 * UserPicker assignee we splice the chosen user's `@email` into corrective_action
 * so the existing server-side parseMentions notifies them. Idempotent.
 */
const withAssigneeMention = (corrective: string, email: string): string => {
  const c = (corrective || '').trim();
  const e = (email || '').trim();
  if (!e) return c;
  if (c.toLowerCase().includes('@' + e.toLowerCase())) return c;
  return (c ? c + ' ' : '') + '@' + e;
};

const keyOf = (area: string, item: string) => `${area}|||${item}`;

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ── score helpers ────────────────────────────────────────────────────── */

interface Score { pass: number; fail: number; na: number; scored: number; score: number }

function scoreFor(form: FormState, area?: string): Score {
  let pass = 0, fail = 0, na = 0;
  for (const [k, v] of Object.entries(form)) {
    if (area && !k.startsWith(area + '|||')) continue;
    if (v.result === 'pass') pass++;
    else if (v.result === 'fail') fail++;
    else if (v.result === 'na') na++;
  }
  const scored = pass + fail;
  return { pass, fail, na, scored, score: scored > 0 ? Math.round((pass / scored) * 1000) / 10 : 0 };
}

function scoreColor(score: number, scored: number): string {
  if (scored === 0) return 'text-[#8B7355]';
  if (score >= 90) return 'text-green-600';
  if (score >= 75) return 'text-amber-600';
  if (score >= 50) return 'text-orange-600';
  return 'text-red-600';
}
function barColor(score: number, scored: number): string {
  if (scored === 0) return 'bg-[#E8D5C4]';
  if (score >= 90) return 'bg-green-500';
  if (score >= 75) return 'bg-amber-500';
  if (score >= 50) return 'bg-orange-500';
  return 'bg-red-500';
}

const csvCell = (x: any) => {
  const s = String(x ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

/* ── gauge ────────────────────────────────────────────────────────────── */

function Gauge({ label, s }: { label: string; s: Score }) {
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-xs font-semibold text-[#2D1B0E] truncate">{label}</div>
        <div className={`text-lg font-bold tabular-nums ${scoreColor(s.score, s.scored)}`}>
          {s.scored === 0 ? '—' : `${s.score}%`}
        </div>
      </div>
      <div className="mt-1.5 h-2 rounded-full bg-[#F0E4D6] overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${barColor(s.score, s.scored)}`}
          style={{ width: `${s.scored === 0 ? 0 : s.score}%` }}
        />
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-[#8B7355]">
        <span className="text-green-600 font-medium">{s.pass} pass</span>
        <span className="text-red-600 font-medium">{s.fail} fail</span>
        <span>{s.na} n/a</span>
      </div>
    </div>
  );
}

/* ── page ─────────────────────────────────────────────────────────────── */

export default function HygieneAuditsPage() {
  const router = useRouter();
  const [me, setMe] = useState<any>(undefined); // undefined = loading, null = signed out

  const [date, setDate] = useState(todayISO());
  const [form, setForm] = useState<FormState>({});
  const [saved, setSaved] = useState<HygieneAudit[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingArea, setSavingArea] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const allowed = !!me && (me.role === 'admin' || me.role === 'manager' || me.is_head_chef || me.is_store_manager);

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.json())
      .then(d => setMe(d?.user ?? null))
      .catch(() => setMe(null));
  }, []);

  const load = useCallback((d: string) => {
    setLoading(true);
    setError(null);
    fetch(`/api/tasks/hygiene?date=${encodeURIComponent(d)}`)
      .then(r => r.json())
      .then(j => {
        if (j.error) { setError(j.error); return; }
        const rows: HygieneAudit[] = j.rows || [];
        setSaved(rows);
        // Seed the form from saved rows so it reflects what's on record.
        const next: FormState = {};
        for (const r of rows) {
          next[keyOf(r.area, r.item)] = {
            ...blankItem(),
            result: (r.result as Result) || '',
            image_url: r.image_url || '',
            corrective_action: r.corrective_action || '',
          };
        }
        setForm(next);
      })
      .catch(e => setError(e?.message || 'Failed to load hygiene audits'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!allowed) return;
    load(date);
  }, [allowed, date, load]);

  const setItem = (area: string, item: string, patch: Partial<ItemState>) => {
    setForm(f => {
      const k = keyOf(area, item);
      const prev = f[k] || blankItem();
      return { ...f, [k]: { ...prev, ...patch } };
    });
  };

  const saveArea = async (area: string) => {
    if (savingArea) return;
    // Collect items in this area that have a result chosen.
    const audits = AREA_ITEMS[area]
      .map(item => ({ item, st: form[keyOf(area, item)] }))
      .filter(x => x.st && x.st.result)
      .map(x => ({
        area,
        item: x.item,
        result: x.st!.result,
        image_url: x.st!.image_url,
        // On a fail, weave the picked assignee into the corrective note as an
        // @mention so the existing POST notifies them (POST has no assignee field).
        corrective_action: x.st!.result === 'fail'
          ? withAssigneeMention(x.st!.corrective_action, x.st!.assignee_email)
          : x.st!.corrective_action,
      }));
    if (audits.length === 0) { setError(`Mark at least one ${area} item before saving.`); return; }
    setSavingArea(area);
    setError(null);
    try {
      const r = await api('/api/tasks/hygiene', { method: 'POST', body: { date, audits } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setNotice(
        `${area}: ${j.saved} item${j.saved === 1 ? '' : 's'} saved` +
        (j.created_tasks ? ` · ${j.created_tasks} corrective task${j.created_tasks === 1 ? '' : 's'} created` : ''),
      );
      load(date);
    } catch (e: any) {
      setError(e?.message || 'Failed to save');
    } finally {
      setSavingArea(null);
    }
  };

  const exportCsv = () => {
    const header = ['Date', 'Area', 'Item', 'Result', 'Corrective Action', 'Image URL', 'Auditor', 'Task Created'];
    const lines = [header.join(',')];
    for (const r of saved) {
      lines.push([
        r.date, r.area, r.item, r.result, r.corrective_action, r.image_url, r.auditor,
        r.created_task_id ? 'yes' : '',
      ].map(csvCell).join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hygiene-audit-${date}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const overall = useMemo(() => scoreFor(form), [form]);
  const areaScores = useMemo(
    () => Object.fromEntries(HYGIENE_AREAS.map(a => [a, scoreFor(form, a)])),
    [form],
  );

  /* ── gates ── */
  if (me === undefined) {
    return (
      <div className="p-8 text-center text-sm text-[#8B7355]">
        <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…
      </div>
    );
  }
  if (!allowed) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <button
          onClick={() => router.back()}
          className="inline-flex items-center gap-1 text-sm text-[#6B5744] hover:text-[#2D1B0E] transition-colors mb-3"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
          🔒 Hygiene audits are for admins, managers, head chefs and store managers.
          Ask an admin for access.
        </div>
      </div>
    );
  }

  const RESULT_BTNS: { key: Result; label: string; on: string; off: string }[] = [
    { key: 'pass', label: 'Pass', on: 'bg-green-600 text-white border-green-600', off: 'bg-white text-green-700 border-green-200 hover:border-green-400' },
    { key: 'fail', label: 'Fail', on: 'bg-red-600 text-white border-red-600', off: 'bg-white text-red-700 border-red-200 hover:border-red-400' },
    { key: 'na', label: 'N/A', on: 'bg-gray-500 text-white border-gray-500', off: 'bg-white text-gray-600 border-gray-200 hover:border-gray-400' },
  ];

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-6xl mx-auto pb-16">
      {/* Header */}
      <div>
        <button
          onClick={() => router.back()}
          className="inline-flex items-center gap-1 text-sm text-[#6B5744] hover:text-[#2D1B0E] transition-colors mb-2"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#af4408] text-white flex items-center justify-center shrink-0">
            <SprayCan size={20} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl sm:text-2xl font-bold text-[#2D1B0E]">Hygiene Audits</h1>
            <p className="text-xs text-[#8B7355]">
              Daily area inspections — Pass / Fail / N/A with photos, corrective actions & auto-tasks
            </p>
          </div>
          <button
            onClick={() => load(date)}
            disabled={loading}
            className="inline-flex items-center gap-1.5 bg-white border border-[#E8D5C4] hover:border-[#af4408] text-[#2D1B0E] text-sm rounded-lg px-3 py-2 disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          <button
            onClick={exportCsv}
            disabled={saved.length === 0}
            className="inline-flex items-center gap-1.5 bg-white border border-[#E8D5C4] hover:border-[#af4408] text-[#2D1B0E] text-sm rounded-lg px-3 py-2 disabled:opacity-50"
          >
            <Download size={14} /> CSV
          </button>
        </div>
      </div>

      {/* Date + notices */}
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm text-[#6B5744] flex items-center gap-2">
          Audit date
          <input
            type="date"
            value={date}
            max={todayISO()}
            onChange={e => setDate(e.target.value || todayISO())}
            className="border border-[#E8D5C4] rounded-lg px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:border-[#af4408]"
          />
        </label>
      </div>

      {notice && (
        <div className="flex items-center justify-between gap-2 bg-green-50 border border-green-200 text-green-800 text-sm rounded-lg px-3 py-2">
          <span className="flex items-center gap-2"><CheckCircle2 size={15} className="shrink-0" /> {notice}</span>
          <button onClick={() => setNotice(null)} className="text-green-700 hover:text-green-900"><X size={14} /></button>
        </div>
      )}
      {error && (
        <div className="flex items-center justify-between gap-2 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2">
          <span className="flex items-center gap-2"><AlertCircle size={15} className="shrink-0" /> {error}</span>
          <button onClick={() => setError(null)} className="text-red-700 hover:text-red-900"><X size={14} /></button>
        </div>
      )}

      {/* Score gauges */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        <div className="bg-[#FFF3E6] border border-[#F2C79B] rounded-xl p-3 col-span-2 sm:col-span-1">
          <div className="text-xs font-semibold text-[#8a3606] truncate">Daily Score</div>
          <div className={`text-2xl font-bold tabular-nums ${scoreColor(overall.score, overall.scored)}`}>
            {overall.scored === 0 ? '—' : `${overall.score}%`}
          </div>
          <div className="mt-1 h-2 rounded-full bg-white/70 overflow-hidden">
            <div className={`h-full rounded-full ${barColor(overall.score, overall.scored)}`}
              style={{ width: `${overall.scored === 0 ? 0 : overall.score}%` }} />
          </div>
          <div className="mt-1.5 text-[10px] text-[#8a3606]">
            {overall.pass} pass · {overall.fail} fail · {overall.na} n/a
          </div>
        </div>
        {HYGIENE_AREAS.map(area => (
          <Gauge key={area} label={area} s={areaScores[area]} />
        ))}
      </div>

      {loading && (
        <div className="p-8 text-center text-sm text-[#8B7355]">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading audits…
        </div>
      )}

      {/* Area sections */}
      {!loading && HYGIENE_AREAS.map(area => {
        const s = areaScores[area];
        return (
          <div key={area} className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-3 sm:px-4 py-2.5 bg-[#FFF8F0] border-b border-[#E8D5C4]">
              <div className="flex items-center gap-2 min-w-0">
                <h2 className="text-sm font-bold text-[#2D1B0E] truncate">{area}</h2>
                <span className={`text-xs font-semibold tabular-nums ${scoreColor(s.score, s.scored)}`}>
                  {s.scored === 0 ? 'not started' : `${s.score}%`}
                </span>
              </div>
              <button
                onClick={() => saveArea(area)}
                disabled={savingArea === area}
                className="inline-flex items-center gap-1.5 bg-[#af4408] hover:bg-[#8a3606] text-white text-xs sm:text-sm rounded-lg px-3 py-1.5 disabled:opacity-50 shrink-0"
              >
                {savingArea === area ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save {area}
              </button>
            </div>
            <div className="divide-y divide-[#F0E4D6]">
              {AREA_ITEMS[area].map(item => {
                const st = form[keyOf(area, item)] || blankItem();
                return (
                  <div key={item} className="px-3 sm:px-4 py-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-sm text-[#2D1B0E] font-medium min-w-0 flex-1">{item}</div>
                      <div className="flex gap-1 shrink-0">
                        {RESULT_BTNS.map(b => (
                          <button
                            key={b.key}
                            onClick={() => setItem(area, item, { result: st.result === b.key ? '' : b.key })}
                            className={`text-xs font-semibold rounded-lg px-2.5 py-1 border transition-colors ${st.result === b.key ? b.on : b.off}`}
                          >
                            {b.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    {/* Photo + corrective action — corrective required-ish on fail */}
                    {(st.result === 'fail' || st.image_url || st.corrective_action) && (
                      <div className="mt-2 space-y-2">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 items-start">
                          <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-2">
                            <span className="block text-[10px] font-semibold uppercase tracking-wide text-[#8B7355] mb-1.5">Photo (optional)</span>
                            <ImageUpload
                              value={st.image_url ? [st.image_url] : []}
                              onChange={list => setItem(area, item, { image_url: list[0] || '' })}
                              label="Add photo"
                              thumbSize={48}
                            />
                          </div>
                          <input
                            type="text"
                            placeholder={st.result === 'fail' ? 'Corrective action (auto-creates a task) — @mention to notify' : 'Note (optional)'}
                            value={st.corrective_action}
                            onChange={e => setItem(area, item, { corrective_action: e.target.value })}
                            className={`w-full border rounded-lg px-2.5 py-1.5 text-xs bg-white focus:outline-none focus:border-[#af4408] ${st.result === 'fail' ? 'border-red-200' : 'border-[#E8D5C4]'}`}
                          />
                        </div>
                        {st.result === 'fail' && (
                          <div>
                            <label className="block text-[10px] font-semibold uppercase tracking-wide text-[#8B7355] mb-1">
                              Assign corrective task to (notified via @mention)
                            </label>
                            <div className="max-w-xs">
                              <UserPicker
                                value={st.assignee_email}
                                onPick={u => setItem(area, item, { assignee_email: u.email, assignee_name: u.name })}
                                allowClear
                                onClear={() => setItem(area, item, { assignee_email: '', assignee_name: '' })}
                                placeholder="Assign to… (optional)"
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Recent record for the day (history) */}
      {!loading && saved.length > 0 && (
        <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
          <div className="px-3 sm:px-4 py-2.5 bg-[#FFF8F0] border-b border-[#E8D5C4]">
            <h2 className="text-sm font-bold text-[#2D1B0E]">Recorded on {date}</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[560px]">
              <thead>
                <tr className="text-left text-xs text-[#8B7355] uppercase tracking-wide">
                  <th className="px-4 py-2 font-semibold">Area</th>
                  <th className="px-4 py-2 font-semibold">Item</th>
                  <th className="px-4 py-2 font-semibold">Result</th>
                  <th className="px-4 py-2 font-semibold">Corrective Action</th>
                  <th className="px-4 py-2 font-semibold">Auditor</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F0E4D6]">
                {saved.map(r => (
                  <tr key={r.id} className="hover:bg-[#FFF8F0]">
                    <td className="px-4 py-2 text-[#6B5744]">{r.area}</td>
                    <td className="px-4 py-2 text-[#2D1B0E]">{r.item}</td>
                    <td className="px-4 py-2">
                      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full border ${
                        r.result === 'pass' ? 'bg-green-50 text-green-700 border-green-200'
                          : r.result === 'fail' ? 'bg-red-50 text-red-700 border-red-200'
                          : 'bg-gray-100 text-gray-600 border-gray-200'
                      }`}>
                        {r.result === 'na' ? 'N/A' : r.result}
                      </span>
                      {r.created_task_id && (
                        <span className="ml-1.5 text-[10px] text-[#af4408] font-medium">task created</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-[#6B5744] max-w-[220px] truncate">{r.corrective_action || '—'}</td>
                    <td className="px-4 py-2 text-[#8B7355]">{r.auditor || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!loading && saved.length === 0 && (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 text-center text-sm text-[#8B7355]">
          No audits recorded for {date} yet — mark items above and hit Save.
        </div>
      )}
    </div>
  );
}
