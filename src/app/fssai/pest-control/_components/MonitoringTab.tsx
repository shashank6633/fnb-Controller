'use client';

/**
 * TAB — THE MONITORING SHEET (#113): every bait station, glue board and insect
 * light trap, checked one by one, the way the authority's paper sheet asks for
 * it: date, station, activity yes/no, action, initials.
 *
 * ── WHO ─────────────────────────────────────────────────────────────────────
 * Filing a walk is open to EVERY signed-in user, like a sighting — the person
 * who walks the stations at closing is usually a steward. Voiding a line and
 * raising a corrective action are a manager's (the server says which with
 * can_void / can_raise, and the screen shows the reason instead of hiding).
 *
 * ── WHAT THE FORM WILL NOT DO, DELIBERATELY ──────────────────────────────────
 * There is no "mark all as no activity" button. Every station needs its own Yes
 * or No, because a sheet ticked in one tap is the sheet an inspector stops
 * believing. A station that was not looked at is left OFF the walk (untick it);
 * it is never filed as "no".
 *
 * Activity found at a station becomes a SIGHTING automatically (the server does
 * it, in the same transaction), so the existing close / corrective-action flow
 * on the Sightings tab covers it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, ClipboardCheck, Info, Loader2, Printer, RefreshCw, Wrench } from 'lucide-react';
import type { PestCheckRow, PestMonitoringSheet, PestStationCoverage } from '@/app/api/fssai/pest/_pest/monitoring';
import { apiJson } from '@/lib/api';
import { fmtIST, fmtISTDate } from '@/lib/format-date';
import { FSSAI_CHECK_RESULTS, FSSAI_PEST_EVIDENCE_KINDS, FSSAI_PEST_TYPES, fssaiToday } from '@/lib/fssai';
import {
  Badge, BTN_DANGER, BTN_PLAIN, BTN_PRIMARY, CARD, INPUT, LABEL, Modal, PrintOverlay, RaiseCaForm, REQ, Tile,
  askReason, errMsg,
} from './pest-ui';
import { MonitoringSheetPrint } from './PestPrints';

interface SheetResponse {
  sheet: PestMonitoringSheet; can_void: boolean; can_raise: boolean; me: string; today: string;
}
interface CoverageResponse { stations: PestStationCoverage[]; today: string }
interface RoundResponse { rows: PestCheckRow[]; can_void: boolean; can_raise: boolean; me: string }
interface VisitsResponse { services?: { id: string; service_no: string; vendor_name: string; business_date: string; status: string }[] }

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function istClockNow(): string {
  const t = new Date(Date.now() + 5.5 * 3600_000);
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
}

export default function MonitoringTab({ say }: { say: (m: string) => void }) {
  const today = fssaiToday();
  const [from, setFrom] = useState(addDays(today, -30));
  const [to, setTo] = useState(today);
  const [sheet, setSheet] = useState<PestMonitoringSheet | null>(null);
  const [canVoid, setCanVoid] = useState(false);
  const [canRaise, setCanRaise] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [walkOpen, setWalkOpen] = useState(false);
  const [roundId, setRoundId] = useState('');
  const [printOpen, setPrintOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const j = await apiJson<SheetResponse>(`/api/fssai/pest/checks?sheet=1&from=${from}&to=${to}`);
      setSheet(j.sheet); setCanVoid(!!j.can_void); setCanRaise(!!j.can_raise);
    } catch (e: unknown) { setErr(errMsg(e, 'Could not load the monitoring sheet')); }
    finally { setLoading(false); }
  }, [from, to]);
  useEffect(() => { load(); }, [load]);

  const t = sheet?.totals;
  return (
    <div className="space-y-4">
      <div className={`${CARD} p-4 flex flex-wrap items-center gap-3`}>
        <button onClick={() => setWalkOpen(true)} className={`${BTN_PRIMARY} !px-4 !py-3 text-base w-full sm:w-auto justify-center`}>
          <ClipboardCheck size={18} /> Check the stations
        </button>
        <p className="text-xs text-[#6B5744] min-w-0 flex-1">
          Walk the bait stations, glue boards and fly units and record each one: activity yes or no, the state of the
          station, what you did, your initials. Anyone can file a walk. Activity found becomes a sighting automatically.
        </p>
      </div>

      {t && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Tile n={t.stations_in_use} label="Stations in use" />
          <Tile n={t.stations_ok} label="Checked on time" tone="good" />
          <Tile n={t.stations_due} label="Due today" tone={t.stations_due ? 'warn' : 'plain'} />
          <Tile n={t.stations_overdue + t.stations_never} label="Overdue or never checked" tone={t.stations_overdue + t.stations_never ? 'bad' : 'plain'} />
        </div>
      )}

      <div className={`${CARD} p-3 flex flex-wrap items-end gap-3`}>
        <label>
          <span className={LABEL}>From</span>
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className={INPUT} />
        </label>
        <label>
          <span className={LABEL}>To</span>
          <input type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} className={INPUT} />
        </label>
        <button onClick={load} disabled={loading} className={BTN_PLAIN}>
          {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Refresh
        </button>
        <div className="flex-1" />
        <button onClick={() => setPrintOpen(true)} disabled={!sheet} className={BTN_PLAIN}>
          <Printer size={15} /> Print the monitoring sheet
        </button>
      </div>

      {err && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">{err}</div>}
      {sheet && sheet.problems.length > 0 && (
        <div className={`${sheet.verdict === 'present' ? 'bg-slate-50 border-slate-200 text-slate-800' : 'bg-amber-50 border-amber-200 text-amber-900'} border rounded-lg p-3 text-sm`}>
          <ul className="list-disc pl-5 space-y-0.5">{sheet.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
        </div>
      )}

      {/* Where each station stands — the coverage the audit file reads. */}
      {sheet && sheet.stations.length > 0 && (
        <div className={`${CARD} overflow-hidden`}>
          <p className="px-3 pt-3 text-sm font-semibold">Stations, as of {fmtISTDate(sheet.to)}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[#FFF1E3] text-[#6B5744]">
                <tr>
                  <th className="text-left font-semibold px-3 py-2">Station</th>
                  <th className="text-left font-semibold px-3 py-2">Where</th>
                  <th className="text-left font-semibold px-3 py-2">Checked</th>
                  <th className="text-left font-semibold px-3 py-2">Last check</th>
                  <th className="text-left font-semibold px-3 py-2">Next due</th>
                  <th className="text-left font-semibold px-3 py-2">State</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E8D5C4]">
                {sheet.stations.map((s) => (
                  <tr key={s.device_id}>
                    <td className="px-3 py-2 font-medium whitespace-nowrap">{s.code || '—'} <span className="text-[#8B7355] font-normal">{s.device_kind_label}</span></td>
                    <td className="px-3 py-2">{s.location_label}</td>
                    <td className="px-3 py-2 text-[#6B5744]">{s.check_frequency}{s.frequency_assumed ? ' (read as weekly)' : ''}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{s.last_check_date ? `${fmtISTDate(s.last_check_date)} ${s.last_check_time}` : '—'}{s.last_activity === 'yes' ? <span className="text-red-700"> · activity</span> : null}</td>
                    <td className={`px-3 py-2 whitespace-nowrap ${s.state === 'overdue' ? 'text-red-700 font-semibold' : 'text-[#6B5744]'}`}>{s.due_on ? fmtISTDate(s.due_on) : '—'}</td>
                    <td className="px-3 py-2"><Badge label={s.state_label} color={s.state_color} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className={`${CARD} overflow-hidden`}>
        <p className="px-3 pt-3 text-sm font-semibold">Walks in these dates</p>
        {loading ? (
          <div className="p-10 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" /> Loading…</div>
        ) : !sheet || sheet.rounds.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-sm font-semibold">No station was checked in these dates</p>
            <p className="text-xs text-[#8B7355] mt-1">
              An inspector asks for this sheet by name. If the stations are walked on paper, file each walk here the same day.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-[#E8D5C4]">
            {sheet.rounds.map((g) => (
              <button key={g.round_id} onClick={() => setRoundId(g.round_id)} className="w-full text-left px-3 py-3 hover:bg-[#FFF8F0]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-sm">{fmtISTDate(g.business_date)} {g.checked_at}</span>
                  <span className="text-xs text-[#6B5744]">{g.checked_name || g.checked_by}{g.checker_kind === 'contractor' ? ' (technician)' : ''}</span>
                  <span className="flex-1" />
                  <Badge label={`${g.stations} station${g.stations === 1 ? '' : 's'}`} color="bg-slate-100 text-slate-600 border-slate-200" />
                  {g.activity > 0 && <Badge label={`activity ${g.activity}`} color="bg-red-100 text-red-700 border-red-200" />}
                  {g.fails - g.activity > 0 && <Badge label={`not in order ${g.fails - g.activity}`} color="bg-amber-100 text-amber-800 border-amber-200" />}
                  {g.voided > 0 && <Badge label={`${g.voided} voided`} color="bg-gray-100 text-gray-600 border-gray-200" />}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {walkOpen && (
        <WalkForm
          onClose={() => setWalkOpen(false)}
          onSaved={(m) => { setWalkOpen(false); say(m); load(); }}
        />
      )}
      {roundId && (
        <RoundDetail
          roundId={roundId} canVoid={canVoid} canRaise={canRaise}
          onClose={() => setRoundId('')} onChanged={load} say={say}
        />
      )}
      {printOpen && sheet && (
        <PrintOverlay title="Pest-control monitoring sheet" onClose={() => setPrintOpen(false)} landscape>
          <MonitoringSheetPrint sheet={sheet} />
        </PrintOverlay>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════ *
 * FILING A WALK
 * ══════════════════════════════════════════════════════════════════════════ */

interface Line {
  include: boolean;
  activity: '' | 'yes' | 'no';
  activity_kind: string;
  evidence_kind: string;
  device_condition: string;
  action_taken: string;
  initials: string;
}

function WalkForm({ onClose, onSaved }: { onClose: () => void; onSaved: (m: string) => void }) {
  const today = fssaiToday();
  const [stations, setStations] = useState<PestStationCoverage[]>([]);
  const [lines, setLines] = useState<Record<string, Line>>({});
  const [visits, setVisits] = useState<{ id: string; label: string }[]>([]);
  const [date, setDate] = useState(today);
  const [clock, setClock] = useState(istClockNow());
  const [initials, setInitials] = useState('');
  const [checker, setChecker] = useState<'staff' | 'contractor'>('staff');
  const [serviceId, setServiceId] = useState('');
  const [backdateReason, setBackdateReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const j = await apiJson<CoverageResponse>('/api/fssai/pest/checks?coverage=1');
        setStations(j.stations || []);
        const init: Record<string, Line> = {};
        for (const s of j.stations || []) {
          init[s.device_id] = { include: true, activity: '', activity_kind: '', evidence_kind: 'device_catch', device_condition: '', action_taken: '', initials: '' };
        }
        setLines(init);
      } catch (e: unknown) { setErr(errMsg(e, 'Could not load the stations')); }
      finally { setLoading(false); }
      try {
        const v = await apiJson<VisitsResponse>(`/api/fssai/pest/services?from=${addDays(today, -1)}&to=${today}`);
        setVisits((v.services || []).filter((s) => s.status !== 'void').map((s) => ({ id: s.id, label: `${s.service_no} · ${s.vendor_name} · ${s.business_date}` })));
      } catch { /* linking a visit is optional */ }
    })();
  }, [today]);

  const set = (id: string, patch: Partial<Line>) => setLines((p) => ({ ...p, [id]: { ...p[id], ...patch } }));
  const included = stations.filter((s) => lines[s.device_id]?.include);
  const unanswered = included.filter((s) => !lines[s.device_id]?.activity);
  const backdated = date < today;

  // What the walk still needs, in words, so the Save button never just greys out.
  const blockers = useMemo(() => {
    const out: string[] = [];
    if (!included.length) out.push('Tick at least one station.');
    if (unanswered.length) out.push(`${unanswered.length} station${unanswered.length === 1 ? '' : 's'} still need Yes or No.`);
    for (const s of included) {
      const L = lines[s.device_id];
      if (!L) continue;
      if (L.activity === 'yes' && !L.activity_kind) out.push(`Station ${s.code}: what was found?`);
      if ((L.activity === 'yes' || L.device_condition === 'not_ok') && L.action_taken.trim().length < 4) out.push(`Station ${s.code}: what was done?`);
      if (!L.initials.trim() && !initials.trim()) out.push(`Station ${s.code}: initials.`);
    }
    if (backdated && backdateReason.trim().length < 4) out.push('Why is this walk being filed for yesterday?');
    return out;
  }, [included, unanswered.length, lines, initials, backdated, backdateReason]);

  async function save() {
    setBusy(true); setErr('');
    try {
      const j = await apiJson<{ rows: PestCheckRow[]; advice?: string }>('/api/fssai/pest/checks', {
        method: 'POST',
        body: {
          action: 'submit_round', business_date: date, checked_at: clock, initials,
          checker_kind: checker, service_id: checker === 'contractor' ? serviceId : '',
          backdate_reason: backdated ? backdateReason : '',
          checks: included.map((s) => {
            const L = lines[s.device_id];
            return {
              device_id: s.device_id, activity: L.activity, activity_kind: L.activity === 'yes' ? L.activity_kind : '',
              evidence_kind: L.activity === 'yes' ? L.evidence_kind : '', device_condition: L.device_condition,
              action_taken: L.action_taken, initials: L.initials,
            };
          }),
        },
      });
      onSaved(j.advice || `Walk filed — ${j.rows.length} station${j.rows.length === 1 ? '' : 's'}.`);
    } catch (e: unknown) { setErr(errMsg(e, 'Could not file the walk')); }
    finally { setBusy(false); }
  }

  return (
    <Modal
      title="Check the stations"
      onClose={onClose}
      wide
      footer={
        <>
          {blockers.length > 0 && <span className="text-xs text-[#8B7355] self-center mr-auto">{blockers[0]}{blockers.length > 1 ? ` (+${blockers.length - 1} more)` : ''}</span>}
          <button onClick={onClose} className={BTN_PLAIN}>Cancel</button>
          <button onClick={save} disabled={busy || loading || blockers.length > 0} className={BTN_PRIMARY}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} File the walk
          </button>
        </>
      }
    >
      {err && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">{err}</div>}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <label className="block">
          <span className={LABEL}>Date {REQ}</span>
          <input type="date" value={date} min={addDays(today, -1)} max={today} onChange={(e) => setDate(e.target.value)} className={INPUT} />
        </label>
        <label className="block">
          <span className={LABEL}>Time {REQ}</span>
          <input type="time" value={clock} onChange={(e) => setClock(e.target.value)} className={INPUT} />
        </label>
        <label className="block">
          <span className={LABEL}>Your initials {REQ}</span>
          <input value={initials} onChange={(e) => setInitials(e.target.value.slice(0, 12))} placeholder="SK" className={INPUT} />
        </label>
        <label className="block">
          <span className={LABEL}>Checked by</span>
          <select value={checker} onChange={(e) => setChecker(e.target.value === 'contractor' ? 'contractor' : 'staff')} className={INPUT}>
            <option value="staff">Our staff</option>
            <option value="contractor">Pest-control technician</option>
          </select>
        </label>
      </div>
      {checker === 'contractor' && (
        <label className="block">
          <span className={LABEL}>During which contractor visit (optional)</span>
          <select value={serviceId} onChange={(e) => setServiceId(e.target.value)} className={INPUT}>
            <option value="">Not linked to a visit</option>
            {visits.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
          </select>
        </label>
      )}
      {backdated && (
        <label className="block">
          <span className={LABEL}>Why is this filed for yesterday? {REQ}</span>
          <input value={backdateReason} onChange={(e) => setBackdateReason(e.target.value)} placeholder="Walked at closing, written up this morning" className={INPUT} />
        </label>
      )}

      {loading ? (
        <div className="p-6 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin mx-auto" /></div>
      ) : stations.length === 0 ? (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-900">
          No station is on the pest map yet. An administrator adds them under <strong>Monitoring points</strong>.
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-[11px] text-[#6B5744] flex flex-nowrap items-start gap-1.5">
            <Info size={13} className="mt-0.5 shrink-0" />
            <span>Every station needs its own Yes or No. A station you did not look at: untick it — it is left off the walk, never filed as &ldquo;no&rdquo;.</span>
          </p>
          {stations.map((s) => {
            const L = lines[s.device_id];
            if (!L) return null;
            return (
              <div key={s.device_id} className={`border rounded-lg p-3 ${L.include ? 'border-[#E8D5C4] bg-white' : 'border-dashed border-[#E8D5C4] bg-[#FFF8F0] opacity-70'}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex flex-nowrap items-center gap-2 min-w-0">
                    <input type="checkbox" checked={L.include} onChange={(e) => set(s.device_id, { include: e.target.checked })} className="w-4 h-4 accent-[#af4408]" />
                    <span className="font-semibold text-sm">{s.code || '—'}</span>
                    <span className="text-xs text-[#6B5744] truncate">{s.device_kind_label} · {s.location_label}</span>
                  </label>
                  <span className="flex-1" />
                  <Badge label={s.state_label} color={s.state_color} />
                </div>
                {L.include && (
                  <div className="mt-2 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-[#6B5744]">Activity?</span>
                      {(['no', 'yes'] as const).map((v) => (
                        <button
                          key={v}
                          type="button"
                          onClick={() => set(s.device_id, { activity: v })}
                          aria-pressed={L.activity === v}
                          className={`px-4 py-1.5 rounded-lg text-sm font-semibold border ${
                            L.activity === v
                              ? v === 'yes' ? 'bg-red-600 text-white border-red-600' : 'bg-green-600 text-white border-green-600'
                              : 'bg-white border-[#D4B896] text-[#6B5744]'
                          }`}
                        >
                          {v === 'yes' ? 'Yes' : 'No'}
                        </button>
                      ))}
                      <select
                        value={L.device_condition}
                        onChange={(e) => set(s.device_id, { device_condition: e.target.value })}
                        className="ml-auto bg-white border border-[#D4B896] rounded-lg px-2 py-1.5 text-sm"
                        aria-label="Condition of the station"
                      >
                        {FSSAI_CHECK_RESULTS.map((c) => <option key={c.key} value={c.key}>{c.key === '' ? 'Station condition…' : c.label}</option>)}
                      </select>
                    </div>
                    {L.activity === 'yes' && (
                      <div className="grid grid-cols-2 gap-2">
                        <select value={L.activity_kind} onChange={(e) => set(s.device_id, { activity_kind: e.target.value })} className={INPUT} aria-label="What was found">
                          <option value="">What was found? *</option>
                          {FSSAI_PEST_TYPES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                        </select>
                        <select value={L.evidence_kind} onChange={(e) => set(s.device_id, { evidence_kind: e.target.value })} className={INPUT} aria-label="Evidence">
                          {FSSAI_PEST_EVIDENCE_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
                        </select>
                      </div>
                    )}
                    <div className="grid grid-cols-[1fr_5.5rem] gap-2">
                      <input
                        value={L.action_taken}
                        onChange={(e) => set(s.device_id, { action_taken: e.target.value.slice(0, 2000) })}
                        placeholder={L.activity === 'yes' || L.device_condition === 'not_ok' ? 'What did you do? (required)' : 'Action taken (bait topped up, board changed…)'}
                        className={INPUT}
                      />
                      <input
                        value={L.initials}
                        onChange={(e) => set(s.device_id, { initials: e.target.value.slice(0, 12) })}
                        placeholder={initials || 'Init.'}
                        className={INPUT}
                        aria-label="Initials for this station"
                      />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

/* ══════════════════════════════════════════════════════════════════════════ *
 * ONE WALK — its lines, void a line, raise a corrective action
 * ══════════════════════════════════════════════════════════════════════════ */

function RoundDetail({
  roundId, canVoid, canRaise, onClose, onChanged, say,
}: {
  roundId: string; canVoid: boolean; canRaise: boolean;
  onClose: () => void; onChanged: () => void; say: (m: string) => void;
}) {
  const [rows, setRows] = useState<PestCheckRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [raiseFor, setRaiseFor] = useState<PestCheckRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const j = await apiJson<RoundResponse>(`/api/fssai/pest/checks?round_id=${encodeURIComponent(roundId)}`);
      setRows(j.rows || []);
    } catch (e: unknown) { setErr(errMsg(e, 'Could not load the walk')); }
    finally { setLoading(false); }
  }, [roundId]);
  useEffect(() => { load(); }, [load]);

  async function post(body: Record<string, unknown>, ok: string) {
    setBusy(true); setErr('');
    try {
      const j = await apiJson<{ note?: string }>('/api/fssai/pest/checks', { method: 'POST', body });
      say(j.note || ok); await load(); onChanged();
    } catch (e: unknown) { setErr(errMsg(e, 'That did not work')); }
    finally { setBusy(false); }
  }

  const head = rows[0];
  return (
    <Modal title={head ? `Walk of ${fmtISTDate(head.business_date)} ${head.checked_at}` : 'Walk'} onClose={onClose} wide>
      {loading ? (
        <div className="p-6 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin mx-auto" /></div>
      ) : (
        <>
          {err && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">{err}</div>}
          {head && (
            <p className="text-xs text-[#6B5744]">
              Filed by {head.checked_name || head.checked_by}{head.checker_kind === 'contractor' ? ' for the pest-control technician' : ''}
              {head.service_no ? ` · during visit ${head.service_no}` : ''} · {fmtIST(head.created_at)}
            </p>
          )}
          <div className="space-y-2">
            {rows.map((r) => (
              <div key={r.id} className={`border rounded-lg p-3 ${r.is_void ? 'border-gray-200 bg-gray-50' : r.is_fail ? 'border-red-200 bg-red-50/40' : 'border-[#E8D5C4]'}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`font-semibold text-sm ${r.is_void ? 'line-through text-gray-500' : ''}`}>{r.device_code}</span>
                  <span className="text-xs text-[#6B5744]">{r.device_kind_label} · {r.location_label}</span>
                  <span className="flex-1" />
                  <Badge
                    label={`Activity: ${r.activity_label}${r.activity === 'yes' && r.activity_kind_label ? ` — ${r.activity_kind_label}` : ''}`}
                    color={r.activity === 'yes' ? 'bg-red-100 text-red-700 border-red-200' : 'bg-green-100 text-green-700 border-green-200'}
                  />
                  <Badge label={r.device_condition ? r.device_condition_label : 'Condition not assessed'} color="bg-slate-100 text-slate-600 border-slate-200" />
                  {r.is_void && <Badge label="Voided" color="bg-gray-100 text-gray-600 border-gray-200" />}
                </div>
                <p className="text-sm mt-1">{r.action_taken || <span className="text-[#8B7355]">No action written.</span>} <span className="text-xs text-[#8B7355]">· initials {r.initials}</span></p>
                {r.sighting_id && <p className="text-[11px] text-[#6B5744] mt-0.5">Filed as a sighting — see the Sightings tab.</p>}
                {r.ca_number && <p className="text-[11px] text-blue-800 mt-0.5 flex flex-nowrap items-center gap-1"><Wrench size={11} /> Corrective action {r.ca_number} · {r.ca_status}</p>}
                {r.is_void && <p className="text-[11px] text-gray-700 mt-0.5">Voided: {r.void_reason} — {r.voided_by}, {fmtIST(r.voided_at)}. The line stays on the sheet.</p>}
                {!r.is_void && (canVoid || (canRaise && r.is_fail && !r.ca_id)) && (
                  <div className="flex flex-wrap gap-2 mt-2">
                    {canRaise && r.is_fail && !r.ca_id && (
                      <button disabled={busy} onClick={() => setRaiseFor(r)} className={BTN_PLAIN}><Wrench size={14} /> Raise a corrective action</button>
                    )}
                    {canVoid && (
                      <button
                        disabled={busy}
                        onClick={() => {
                          const reason = askReason('Voiding is for a line entered IN ERROR (wrong station, wrong day). It stays on the sheet, struck through.\n\nWhy is this line being voided?', say);
                          if (reason) post({ action: 'void', id: r.id, reason }, 'Line voided; it stays on the sheet with your reason.');
                        }}
                        className={BTN_DANGER}
                      >
                        <AlertTriangle size={14} /> Void this line
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          {raiseFor && (
            <RaiseCaForm
              busy={busy}
              defaultSeverity="high"
              defaultTitle={`Station ${raiseFor.device_code} — ${raiseFor.activity === 'yes' ? `${raiseFor.activity_kind_label} activity` : 'not in order'}`}
              note="The due date is set from the severity. The line on the sheet does not change — the fix hangs off it."
              onCancel={() => setRaiseFor(null)}
              onSubmit={async (p) => { const id = raiseFor.id; setRaiseFor(null); await post({ action: 'raise_ca', id, ...p }, 'Corrective action raised.'); }}
            />
          )}
        </>
      )}
    </Modal>
  );
}
