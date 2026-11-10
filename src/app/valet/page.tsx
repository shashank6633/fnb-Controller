'use client';

/**
 * VALET HEAD DASHBOARD (/valet) — the live operational board (spec §6).
 * Desktop: lanes side by side. Tablet/phone: the same lanes stacked, or the
 * list view. Every action opens the car drawer, which calls the same command
 * table as every other screen — the board has no private write path.
 *
 * Nothing here hard-deletes: "Void" is an audited state with a reason.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Bell, CheckCircle2, Clock, LayoutGrid, List, Search, Users, Siren } from 'lucide-react';
import {
  PageHead, OutletPicker, Gate, Panel, Btn, inputCls, ErrorNote, InfoNote, Modal, LiveBadge, StateChip,
  useValetContext, useLive, useCmd, useNow, useAsk, countdown, ago, hhmm,
} from './ui';
import { HandoverModal, IssuedModal, PhotoStrip } from './modals';

interface Eta { low_min: number | null; high_min: number | null; basis: string; position: number | null; ahead: number | null; note: string }
interface Card {
  id: string; version: number; state: string; lane: string; tag_code: string; ticket_no: string; plate: string; make: string; model: string; colour: string;
  zone_name: string; spot: string; key_location: string; key_desc: string; checked_in_at: string; checked_in_by_name: string;
  parked_at: string | null; parked_by_name: string; fetched_by_name: string; ready_at: string | null; dwell_deadline_at: string | null;
  holding_at: string | null; guest_inside_at: string | null; handed_over_at: string | null; handed_over_by_name: string;
  guest_name?: string; mobile_masked?: string; has_photo_exception: boolean; duplicate_plate_note: string; checkin_source: string; is_test: boolean;
  pickup: null | { id: string; version: number; state: string; source: string; requested_at: string; target_at: string; queued_at: string | null;
    priority: number; priority_reason: string; assigned_user_id: string | null; assigned_name: string; handoff_open: boolean; handoff_from_name: string;
    guest_outside_at: string | null; change_request: string; change_open: boolean; started_at: string | null; eta: Eta; scheduled: boolean };
  flags: string[];
  dining: null | { order_id: string; order_number: number | null; table_number: string; status: string; merged: boolean };
}
/** "Table 12 · bill #345", read live — after a table transfer it shows the new table. */
function diningText(dn: Card['dining']) {
  if (!dn) return '';
  if (dn.merged) return `Bill #${dn.order_number ?? '?'} merged — re-link`;
  return `${dn.table_number ? `Table ${dn.table_number}` : 'Parcel'} · bill #${dn.order_number ?? '?'}${dn.status === 'open' ? '' : ` (${dn.status})`}`;
}
interface Team { user_id: string; name: string; status: string; hours: number; active_tasks: { id: string; tag_code: string; state: string }[]; moving: number; keys_held: number; parks_today: number; fetches_today: number; device_quiet: boolean; started_at: string | null }
interface Stat { n: number; avg: number | null; p90: number | null; max: number | null }
interface Board {
  outlet: { id: string; name: string; enabled: boolean }; business_date: string; server_time: string;
  counts: Record<string, number>;
  occupancy: Record<'parking' | 'gate' | 'holding', { capacity: number | null; occupied: number }>;
  metrics: { immediate_wait: Stat; scheduled_lateness: Stat; retrieval_estimate: { p50: number; p90: number; n: number; basis: string } };
  pending: { id: string; pairing_code: string; plate: string; make: string; colour: string; created_at: string; expires_at: string; guest_name: string }[];
  cards: Card[]; completed: Card[];
  exceptions: { kind: string; message: string; session_id?: string; tag_code?: string; since?: string | null; alert_id?: string; acknowledged_at?: string | null }[];
  alerts: { id: string; session_id: string | null; kind: string; message: string; created_at: string; acknowledged_at: string | null }[];
  incidents: { id: string; session_id: string | null; kind: string; description: string; reported_by_name: string; created_at: string; tag_code: string | null }[];
  team: Team[];
  zones: { id: string; name: string; kind: string }[];
  handover_note: null | { id: string; from_name: string; note: string; snapshot_json: string; created_at: string; acknowledged_name: string; acknowledged_at: string | null };
  config: { dwell_minutes: number };
}

const LANES: { key: string; label: string }[] = [
  { key: 'pending', label: 'Pending check-in' }, { key: 'parking', label: 'Parking' }, { key: 'parked', label: 'Parked' },
  { key: 'scheduled', label: 'Scheduled' }, { key: 'requested', label: 'Requested' }, { key: 'fetching', label: 'Assigned / Fetching' },
  { key: 'ready', label: 'Ready at gate' }, { key: 'holding', label: 'Holding' }, { key: 'completed', label: 'Completed' },
];
const FLAG_TEXT: Record<string, string> = {
  unclaimed_overdue: 'Waiting, nobody on it', scheduled_late: 'Booked time passed', long_fetch: 'Long fetch', outside_waiting: 'Guest outside waiting',
  change_request: 'Guest change request', handoff_open: 'Handoff not confirmed', uncertain: 'Attendant quiet', dwell_overrun: 'Gate overrun',
  dwell_expired: 'Gate time up', unparked_long: 'Not parked 15m+', missing_location: 'No zone', missing_key: 'Rack/hook missing', keys_with_absent: 'Keys with off-shift staff',
};

export default function HeadDashboard() {
  const { ctx, error: ctxError, outletId, setOutletId } = useValetContext();
  const live = useLive<Board>(outletId && ctx?.user.head ? `/api/valet/board?outlet=${encodeURIComponent(outletId)}` : null, outletId, 10_000);
  const b = live.data;
  const now = useNow(1000);
  const [view, setView] = useState<'board' | 'list'>('board');
  const [q, setQ] = useState('');
  const [laneFilter, setLaneFilter] = useState('');
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { try { const v = localStorage.getItem('fnb:valet:view'); if (v === 'list') setView('list'); } catch { /* ignore */ } }, []);
  const cmd = useCmd(outletId, live.reload);

  const all = useMemo(() => b ? [...b.cards, ...b.completed] : [], [b]);
  const match = useCallback((c: Card) => {
    if (laneFilter && c.lane !== laneFilter) return false;
    if (flaggedOnly && !c.flags.length) return false;
    if (!q.trim()) return true;
    const t = q.trim().toUpperCase();
    return [c.tag_code, c.ticket_no, c.plate, c.make, c.model, c.colour, c.pickup?.assigned_name || '', c.parked_by_name].some(x => (x || '').toUpperCase().includes(t));
  }, [q, laneFilter, flaggedOnly]);
  const shown = all.filter(match);

  return (
    <div className="pb-24">
      <PageHead ctx={ctx} title="Valet Head Dashboard"
        subtitle={b ? `${b.outlet.name} · service date ${b.business_date}${b.outlet.enabled ? '' : ' · VALET OFF'}` : ''}
        right={<>
          {ctx ? <OutletPicker ctx={ctx} outletId={outletId} onChange={setOutletId} /> : null}
          <LiveBadge status={live.status} updatedAt={live.updatedAt} onRefresh={live.reload} />
        </>} />
      <Gate ctx={ctx} ctxError={ctxError}>
        {!ctx?.user.head ? <div className="mt-4"><InfoNote>The Head Dashboard is for the Valet Head. Use the Attendant or Desk screen.</InfoNote></div> : (
          <div className="mt-3 space-y-3">
            {live.error ? <ErrorNote message={live.error.message} /> : null}
            <ErrorNote message={cmd.err} />
            {!b ? <p className="text-sm text-[#8B7355]">Loading…</p> : (
              <>
                <Counts b={b} />
                <Exceptions b={b} cmd={cmd} openCar={setOpen} now={now} />
                <Metrics b={b} />
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative">
                    <Search size={14} className="absolute left-2.5 top-3 text-[#8B7355]" aria-hidden />
                    <input aria-label="Search tag, plate, attendant" className={`${inputCls} pl-8 w-56`} value={q} onChange={e => setQ(e.target.value)} placeholder="Tag, plate, attendant" />
                  </div>
                  <select aria-label="Filter by lane" className={`${inputCls} w-auto`} value={laneFilter} onChange={e => setLaneFilter(e.target.value)}>
                    <option value="">All lanes</option>{LANES.map(l => <option key={l.key} value={l.key}>{l.label}</option>)}
                  </select>
                  <label className="text-sm flex items-center gap-1"><input type="checkbox" checked={flaggedOnly} onChange={e => setFlaggedOnly(e.target.checked)} />Problems only</label>
                  <div className="ml-auto flex gap-1">
                    {(['board', 'list'] as const).map(v => (
                      <button key={v} type="button" aria-pressed={view === v} onClick={() => { setView(v); try { localStorage.setItem('fnb:valet:view', v); } catch { /* ignore */ } }}
                        className={`rounded-lg border px-3 py-2 text-sm font-semibold ${view === v ? 'bg-[#2D1B0E] text-white' : 'bg-white border-[#E8D5C4]'}`}>
                        {v === 'board' ? <><LayoutGrid size={14} className="inline mr-1" aria-hidden />Board</> : <><List size={14} className="inline mr-1" aria-hidden />List</>}
                      </button>
                    ))}
                  </div>
                </div>
                {view === 'board' ? <BoardView b={b} cards={shown} laneFilter={laneFilter} q={q} now={now} onOpen={setOpen} /> : <ListView cards={shown} now={now} onOpen={setOpen} />}
                <TeamPanel b={b} cmd={cmd} now={now} />
              </>
            )}
          </div>
        )}
      </Gate>
      {open && b ? <CarDrawer id={open} b={b} outletId={outletId} onClose={() => setOpen(null)} reload={live.reload} isAdmin={!!ctx?.user.is_admin} /> : null}
    </div>
  );
}

function Tile({ label, value, tone = '', hint }: { label: string; value: React.ReactNode; tone?: string; hint?: string }) {
  return (
    <div className={`rounded-xl border px-3 py-2 ${tone || 'border-[#E8D5C4] bg-white'}`} title={hint}>
      <div className="text-[11px] font-semibold uppercase tracking-wide opacity-75 truncate">{label}</div>
      <div className="text-2xl font-extrabold leading-tight whitespace-nowrap">{value}</div>
    </div>
  );
}
const occ = (o: { capacity: number | null; occupied: number }) => o.capacity === null ? `${o.occupied} / ?` : `${o.occupied} / ${o.capacity}`;

function Counts({ b }: { b: Board }) {
  const c = b.counts;
  return (
    <div className="grid grid-cols-3 sm:grid-cols-4 xl:grid-cols-6 2xl:grid-cols-12 gap-2">
      <Tile label="Arrivals" value={c.arrivals} hint="Cars checked in this service date (void/test excluded)" />
      <Tile label="Guest codes" value={c.pending_checkin} hint="Guests who checked in on their phone and are waiting for an attendant to confirm their pairing code" />
      <Tile label="Parked" value={c.parked} />
      <Tile label="Scheduled" value={c.scheduled} />
      <Tile label="Unclaimed" value={c.unclaimed} tone={c.unclaimed ? 'border-amber-300 bg-amber-50' : ''} />
      <Tile label="Fetching" value={c.retrievals} />
      <Tile label="At gate" value={c.at_gate} />
      <Tile label="Overdue" value={c.overdue} tone={c.overdue ? 'border-red-300 bg-red-50 text-red-900' : ''} />
      <Tile label="Staff free" value={c.available_staff} tone={!c.available_staff && c.unclaimed ? 'border-red-300 bg-red-50 text-red-900' : ''} />
      <Tile label="Lot" value={occ(b.occupancy.parking)} hint="Cars in parking zones / capacity (? = not set)" />
      <Tile label="Gate" value={occ(b.occupancy.gate)} tone={b.occupancy.gate.capacity !== null && b.occupancy.gate.occupied >= b.occupancy.gate.capacity ? 'border-red-300 bg-red-50' : ''} />
      <Tile label="Holding" value={occ(b.occupancy.holding)} tone={b.occupancy.holding.capacity !== null && b.occupancy.holding.occupied >= b.occupancy.holding.capacity ? 'border-red-300 bg-red-50' : ''} />
    </div>
  );
}

function Metrics({ b }: { b: Board }) {
  const m = b.metrics;
  const f = (s: Stat) => s.n ? `avg ${s.avg} · p90 ${s.p90} · max ${s.max} min (n=${s.n})` : 'no data yet';
  return (
    <details className="rounded-xl border border-[#E8D5C4] bg-white p-3">
      <summary className="cursor-pointer text-sm font-bold text-[#2D1B0E]">
        <Clock size={14} className="inline mr-1" aria-hidden />Request → ready today: {m.immediate_wait.n ? `avg ${m.immediate_wait.avg} min · p90 ${m.immediate_wait.p90} min` : 'no data yet'}
      </summary>
      <div className="mt-2 text-sm text-[#6B5744] space-y-1">
        <p><b>Immediate requests</b> (Now / In 5 / In 10 when due at once) — wait = ready time − request time: {f(m.immediate_wait)}.</p>
        <p><b>Booked requests</b> — lateness = ready time − booked time (negative = early): {f(m.scheduled_lateness)}. Planned delay is never counted as waiting.</p>
        <p><b>Fetch time used for estimates:</b> median {Math.round(m.retrieval_estimate.p50)} min, p90 {Math.round(m.retrieval_estimate.p90)} min ({m.retrieval_estimate.basis === 'recent' ? `from ${m.retrieval_estimate.n} recent fetches` : 'configured — not enough real data yet'}).</p>
        <p className="text-[11px]">Counted: pickups that reached the gate this service date. Void and test cars excluded. p90 = 9 in 10 were at or under this.</p>
      </div>
    </details>
  );
}

function Exceptions({ b, cmd, openCar, now }: { b: Board; cmd: ReturnType<typeof useCmd>; openCar: (id: string) => void; now: number }) {
  const { ask, askEl } = useAsk();
  const total = b.exceptions.length + b.alerts.length + b.incidents.length;
  if (!total) return <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"><CheckCircle2 size={14} className="inline mr-1" aria-hidden />No exceptions right now.</div>;
  return (
    <section className="rounded-xl border-2 border-red-300 bg-red-50/60 p-3" aria-label="Exceptions">
      <h2 className="text-sm font-extrabold text-red-900 mb-2"><Siren size={15} className="inline mr-1" aria-hidden />Needs attention ({total})</h2>
      <ul className="space-y-1.5">
        {b.alerts.map(a => (
          <li key={a.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-white border border-red-200 px-2 py-1.5 text-sm">
            <Bell size={14} className="text-red-700" aria-hidden /><span className="font-semibold">{a.message}</span>
            <span className="text-xs text-[#8B7355]">{ago(a.created_at, now)} ago{a.acknowledged_at ? ' · seen' : ''}</span>
            <span className="ml-auto flex gap-1">
              {a.session_id ? <Btn kind="ghost" onClick={() => openCar(a.session_id!)}>Open</Btn> : null}
              {!a.acknowledged_at ? <Btn kind="ghost" onClick={() => void cmd.run('alert.ack', { alert_id: a.id })}>Seen</Btn> : null}
              {a.kind === 'help' ? <Btn kind="ghost" onClick={() => void cmd.run('alert.resolve', { alert_id: a.id })}>Done</Btn> : null}
            </span>
          </li>
        ))}
        {b.exceptions.map((e, i) => (
          <li key={`${e.kind}-${e.session_id || i}`} className="flex flex-wrap items-center gap-2 rounded-lg bg-white border border-red-200 px-2 py-1.5 text-sm">
            <AlertTriangle size={14} className="text-red-700" aria-hidden />
            {e.tag_code ? <b className="font-mono">{e.tag_code}</b> : null}<span>{e.message}</span>
            {e.since ? <span className="text-xs text-[#8B7355]">{ago(e.since, now)}</span> : null}
            <span className="ml-auto flex gap-1">
              {e.alert_id && !e.acknowledged_at ? <Btn kind="ghost" onClick={() => void cmd.run('alert.ack', { alert_id: e.alert_id })}>Seen</Btn> : e.acknowledged_at ? <span className="text-[11px] text-[#8B7355] self-center">seen</span> : null}
              {e.session_id ? <Btn kind="ghost" onClick={() => openCar(e.session_id!)}>Open</Btn> : null}
            </span>
          </li>
        ))}
        {b.incidents.map(i => (
          <li key={i.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-white border border-red-200 px-2 py-1.5 text-sm">
            <AlertTriangle size={14} className="text-amber-700" aria-hidden /><b>Incident · {i.kind.replace('_', ' ')}</b>{i.tag_code ? <span className="font-mono">{i.tag_code}</span> : null}
            <span className="text-[#6B5744] truncate max-w-[40ch]">{i.description}</span><span className="text-xs text-[#8B7355]">{i.reported_by_name}, {ago(i.created_at, now)} ago</span>
            <span className="ml-auto flex gap-1">
              {i.session_id ? <Btn kind="ghost" onClick={() => openCar(i.session_id!)}>Open</Btn> : null}
              <Btn kind="ghost" onClick={async () => {
                const res = await ask({ title: 'Resolve incident', label: 'How was it resolved?', min: 5, confirmText: 'Next' }); if (res === null) return;
                const hold = await ask({ title: 'Keep this car\'s record and photos past normal retention (incident hold)?', confirmText: 'Yes, keep (hold)' });
                void cmd.run('incident.resolve', { incident_id: i.id, resolution: res, retention_hold: hold !== null });
              }}>Resolve</Btn>
            </span>
          </li>
        ))}
      </ul>
      {askEl}
    </section>
  );
}

function MiniCard({ c, now, onOpen }: { c: Card; now: number; onOpen: (id: string) => void }) {
  const p = c.pickup;
  const dwell = c.state === 'READY_AT_GATE' ? countdown(c.dwell_deadline_at, now) : null;
  return (
    <button type="button" onClick={() => onOpen(c.id)}
      className={`w-full text-left rounded-xl border bg-white p-2.5 mb-2 hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-[#f5b48a] ${c.flags.length ? 'border-red-300' : 'border-[#E8D5C4]'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="text-xl font-extrabold leading-none">{c.tag_code || c.ticket_no || '—'}</div>
        <StateChip small state={p && ['ASSIGNED', 'IN_PROGRESS', 'QUEUED', 'SCHEDULED'].includes(p.state) ? p.state : c.state} />
      </div>
      <div className="text-xs font-semibold mt-1">{c.plate}</div>
      <div className="text-[11px] text-[#6B5744]">{[c.colour, c.make, c.model].filter(Boolean).join(' ')}</div>
      {c.zone_name ? <div className="text-[11px] text-[#6B5744]">Car: {c.zone_name}{c.spot ? ` · ${c.spot}` : ''}</div> : null}
      <div className="text-[11px] text-[#6B5744]">Keys: {c.key_desc}</div>
      {c.dining ? <div className={`text-[11px] ${c.dining.merged ? 'text-amber-800' : 'text-[#6B5744]'}`}>{diningText(c.dining)}</div> : null}
      {p ? (
        <div className="mt-1 text-[11px] space-y-0.5">
          {p.state === 'SCHEDULED' ? <div>Booked {hhmm(p.target_at)}</div> : <div>Asked {ago(p.requested_at, now)} ago{p.priority > 0 ? ` · priority ${p.priority}` : ''}</div>}
          {p.assigned_name ? <div>With <b>{p.assigned_name}</b>{p.handoff_open ? ' (handoff open)' : ''}</div> : null}
          {p.eta.low_min != null ? <div>ETA {p.eta.low_min}–{p.eta.high_min} min{p.eta.basis === 'override' ? ' (adjusted)' : ''}</div> : p.eta.note === 'no_staff' ? <div className="text-red-700">No staff free</div> : null}
          {p.guest_outside_at ? <div className="font-bold text-red-700">Guest outside {ago(p.guest_outside_at, now)}</div> : null}
        </div>
      ) : null}
      {dwell ? <div className={`mt-1 inline-block rounded px-1.5 text-[11px] font-bold ${dwell.over ? 'bg-red-600 text-white' : 'bg-emerald-100 text-emerald-900'}`}>Gate {dwell.text}</div> : null}
      {c.state === 'HANDED_OVER' ? <div className="text-[11px] text-[#6B5744]">Out {hhmm(c.handed_over_at)} by {c.handed_over_by_name}</div> : null}
      {c.flags.length ? <div className="mt-1 flex flex-wrap gap-1">{c.flags.map(f => <span key={f} className="rounded bg-red-100 px-1 text-[10px] font-semibold text-red-800">{FLAG_TEXT[f] || f}</span>)}</div> : null}
    </button>
  );
}

function BoardView({ b, cards, laneFilter, q, now, onOpen }: { b: Board; cards: Card[]; laneFilter: string; q: string; now: number; onOpen: (id: string) => void }) {
  const lanes = LANES.filter(l => !laneFilter || l.key === laneFilter);
  return (
    <div className="flex gap-2 overflow-x-auto pb-2 snap-x lg:snap-none flex-col sm:flex-row">
      {lanes.map(l => {
        const list = l.key === 'pending' ? [] : cards.filter(c => c.lane === l.key);
        const n = l.key === 'pending' ? b.pending.length : list.length;
        return (
          <section key={l.key} className="sm:w-60 sm:shrink-0 rounded-xl bg-[#FFF1E3] p-2 snap-start" aria-label={l.label}>
            <h3 className="mb-2 text-xs font-extrabold uppercase tracking-wide text-[#6B5744]">{l.label} <span className="font-normal">({n})</span></h3>
            {l.key === 'pending' ? (
              !q ? b.pending.map(pd => (
                <div key={pd.id} className="rounded-xl border border-[#E8D5C4] bg-white p-2.5 mb-2 text-xs">
                  <div className="font-mono text-lg font-extrabold">{pd.pairing_code}</div>
                  <div>{pd.plate} · {[pd.colour, pd.make].filter(Boolean).join(' ')}</div>
                  <div className="text-[#8B7355]">waiting {ago(pd.created_at, now)} · expires {hhmm(pd.expires_at)}</div>
                </div>
              )) : null
            ) : list.map(c => <MiniCard key={c.id} c={c} now={now} onOpen={onOpen} />)}
            {!n ? <p className="text-[11px] text-[#8B7355]">—</p> : null}
          </section>
        );
      })}
    </div>
  );
}

function ListView({ cards, now, onOpen }: { cards: Card[]; now: number; onOpen: (id: string) => void }) {
  if (!cards.length) return <InfoNote>No cars match.</InfoNote>;
  return (
    <div className="overflow-x-auto rounded-xl border border-[#E8D5C4] bg-white">
      <table className="w-full text-sm">
        <thead className="bg-[#FFF1E3] text-left text-xs text-[#6B5744]"><tr>
          <th className="px-2 py-2">Tag</th><th className="px-2">Car</th><th className="px-2">Status</th><th className="px-2">Location</th><th className="px-2">Keys</th>
          <th className="px-2">Attendant</th><th className="px-2">Timing</th><th className="px-2">Problems</th></tr></thead>
        <tbody>
          {cards.map(c => (
            <tr key={c.id} className="border-t border-[#F0E4D6] cursor-pointer hover:bg-[#FFFDF9]" onClick={() => onOpen(c.id)}>
              <td className="px-2 py-1.5 font-extrabold"><button type="button" className="underline-offset-2 hover:underline" onClick={() => onOpen(c.id)}>{c.tag_code || c.ticket_no}</button></td>
              <td className="px-2">{c.plate}<div className="text-[11px] text-[#8B7355]">{[c.colour, c.make, c.model].filter(Boolean).join(' ')}</div></td>
              <td className="px-2"><StateChip small state={c.pickup && ['ASSIGNED', 'IN_PROGRESS', 'QUEUED', 'SCHEDULED'].includes(c.pickup.state) ? c.pickup.state : c.state} /></td>
              <td className="px-2 text-xs">{c.zone_name}{c.spot ? ` · ${c.spot}` : ''}</td>
              <td className="px-2 text-xs">{c.key_desc}</td>
              <td className="px-2 text-xs">{c.pickup?.assigned_name || c.fetched_by_name || c.parked_by_name || '—'}</td>
              <td className="px-2 text-xs">{c.pickup ? (c.pickup.state === 'SCHEDULED' ? `booked ${hhmm(c.pickup.target_at)}` : `asked ${ago(c.pickup.requested_at, now)} ago`) : `in ${ago(c.checked_in_at, now)}`}</td>
              <td className="px-2 text-[11px] text-red-800">{c.flags.map(f => FLAG_TEXT[f] || f).join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TeamPanel({ b, cmd, now }: { b: Board; cmd: ReturnType<typeof useCmd>; now: number }) {
  const tone: Record<string, string> = { available: 'bg-emerald-50 text-emerald-800', busy: 'bg-amber-50 text-amber-800', break: 'bg-sky-50 text-sky-800', off: 'bg-stone-100 text-stone-600' };
  const hn = b.handover_note;
  const { ask, askEl } = useAsk();
  return (
    <Panel title={<><Users size={14} className="inline mr-1" aria-hidden />Team</>} right={
      <Btn kind="ghost" onClick={async () => { const note = await ask({ title: 'Shift handover', label: 'Note for the next Valet Head (cars, keys and open issues are added automatically)', min: 0, confirmText: 'Save handover' }); if (note !== null) void cmd.run('handover_note.create', { note }); }}>Write shift handover</Btn>
    }>
      {hn ? (
        <div className="mb-2 rounded-lg bg-[#FFF1E3] p-2 text-xs">
          <b>Last handover</b> by {hn.from_name} at {hhmm(hn.created_at)}: {hn.note || '(no note)'} · {(() => { try { const s = JSON.parse(hn.snapshot_json); return `${s.cars?.length ?? 0} cars, ${s.keys_with_people ?? 0} keys with people, ${s.open_incidents ?? 0} open incidents`; } catch { return ''; } })()}
          {hn.acknowledged_at ? <span> · acknowledged by {hn.acknowledged_name}</span> : <Btn kind="ghost" className="ml-2" onClick={() => void cmd.run('handover_note.ack', { note_id: hn.id })}>I take over</Btn>}
        </div>
      ) : null}
      {!b.team.length ? <p className="text-sm text-[#8B7355]">Nobody is assigned to this outlet yet (Valet Settings → Staff).</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-[#8B7355]"><tr><th className="py-1 pr-2">Name</th><th className="pr-2">Status</th><th className="pr-2">Hours</th><th className="pr-2">Working on</th><th className="pr-2">Keys</th><th className="pr-2">Parked / fetched today</th><th /></tr></thead>
            <tbody>
              {b.team.map(t => (
                <tr key={t.user_id} className="border-t border-[#F0E4D6]">
                  <td className="py-1.5 pr-2 font-semibold">{t.name}{t.device_quiet ? <span className="ml-1 text-[10px] font-bold text-red-700">(device quiet)</span> : null}</td>
                  <td className="pr-2"><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${tone[t.status]}`}>{t.status === 'off' ? 'off shift' : t.status === 'break' ? 'on break' : t.status}</span></td>
                  <td className="pr-2">{t.started_at ? `${t.hours}h` : '—'}</td>
                  <td className="pr-2 text-xs">{t.active_tasks.map(a => a.tag_code).join(', ') || (t.moving ? 'moving a car' : '—')}</td>
                  <td className="pr-2">{t.keys_held || '—'}</td>
                  <td className="pr-2">{t.parks_today} / {t.fetches_today}</td>
                  <td className="text-right">{t.status !== 'off' ? <button type="button" className="text-xs font-semibold text-[#af4408]" onClick={async () => { if (await ask({ title: `End ${t.name}'s shift? Their keys and cars must be handed over first.`, confirmText: 'End shift', danger: true }) !== null) void cmd.run('shift.end', { user_id: t.user_id, note: 'ended by Valet Head' }); }}>End shift</button> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-1 text-[11px] text-[#8B7355]">Updated {ago(b.server_time, now)} ago.</p>
      {askEl}
    </Panel>
  );
}

interface Detail { card: Card; events: { event_type: string; from_state: string; to_state: string; actor_name: string; reason: string; created_at: string }[];
  custody: { kind: string; from_desc: string; to_desc: string; actor_name: string; note: string; created_at: string }[];
  pickups: { id: string; state: string; source: string; requested_at: string; target_at: string; assigned_name: string; ready_at: string | null; cancel_reason: string }[];
  rfid: null | { observed_at: string; reader_name: string; zone_name: string | null; reads_10min: number; simulated: boolean } }

function CarDrawer({ id, b, outletId, onClose, reload, isAdmin }: { id: string; b: Board; outletId: string; onClose: () => void; reload: () => void; isAdmin: boolean }) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState('');
  const [sub, setSub] = useState<'' | 'handover' | 'pass' | 'claim'>('');
  const [reveal, setReveal] = useState<null | { guest_name: string; guest_mobile: string }>(null);
  const load = useCallback(async () => {
    const r = await fetch(`/api/valet/session?outlet=${encodeURIComponent(outletId)}&id=${encodeURIComponent(id)}`, { cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) setErr(j.error || 'Could not load the car.'); else { setD(j); setErr(''); }
  }, [id, outletId]);
  useEffect(() => { void load(); }, [load]);
  const cmd = useCmd(outletId, () => { void load(); reload(); });
  const c = d?.card;
  const p = c?.pickup;
  const onShift = b.team.filter(t => t.status === 'available' || t.status === 'busy');
  const { ask: askRaw, askEl } = useAsk();
  const nowMs = useNow(30_000);
  /** A recorded reason: at least 5 characters, enforced on screen. */
  const ask = (title: string) => askRaw({ title, label: 'Reason (recorded)', min: 5, confirmText: 'Continue' });
  void isAdmin;
  return (
    <Modal title={c ? `Tag ${c.tag_code || c.ticket_no}` : 'Car'} onClose={onClose} wide>
      <ErrorNote message={err || cmd.err} />
      {!c ? <p className="text-sm text-[#8B7355]">Loading…</p> : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <StateChip state={c.state} />{p ? <StateChip state={p.state} /> : null}
            <span className="text-sm font-semibold">{c.plate}</span><span className="text-sm text-[#6B5744]">{[c.colour, c.make, c.model].filter(Boolean).join(' ')}</span>
            {c.is_test ? <span className="rounded bg-stone-200 px-1.5 text-xs">test</span> : null}
          </div>
          <div className="grid sm:grid-cols-2 gap-2 text-sm">
            <div>Car: <b>{c.zone_name || '—'}{c.spot ? ` · ${c.spot}` : ''}</b></div><div>Keys: <b>{c.key_desc}</b></div>
            <div>Checked in {hhmm(c.checked_in_at)} by {c.checked_in_by_name} ({c.checkin_source === 'staff' ? 'staff' : 'guest phone'})</div>
            <div>Parked {c.parked_at ? `${hhmm(c.parked_at)} by ${c.parked_by_name}` : '—'}</div>
            {c.fetched_by_name ? <div>Fetched by {c.fetched_by_name}</div> : null}
            <div>Guest: {c.guest_name || '—'} {c.mobile_masked ? <span className="font-mono">{c.mobile_masked}</span> : null}
              {c.mobile_masked && !reveal ? <button type="button" className="ml-2 text-xs font-semibold text-[#af4408]" onClick={async () => {
                const why = await ask('Why do you need to contact the guest?'); if (why === null) return;
                const r = await cmd.run<{ guest_name: string; guest_mobile: string }>('contact.reveal', { session_id: c.id, reason: why }); if (r) setReveal(r);
              }}>Show number</button> : null}
              {reveal ? <a className="ml-2 font-mono font-bold text-[#af4408]" href={`tel:${reveal.guest_mobile}`}>{reveal.guest_mobile}</a> : null}
            </div>
            {!['HANDED_OVER', 'VOIDED'].includes(c.state) || c.dining ? (
              <div className="sm:col-span-2">Dining: <b className={c.dining?.merged ? 'text-amber-800' : ''}>{c.dining ? diningText(c.dining) : 'not linked'}</b>
                {!['HANDED_OVER', 'VOIDED'].includes(c.state) ? <>
                  <button type="button" className="ml-2 text-xs font-semibold text-[#af4408]" onClick={async () => {
                    const t = await askRaw({ title: 'Link to a table\'s open bill', label: 'Table number (the CURRENT open bill on that table is used)', min: 1, confirmText: 'Link' }); if (t === null) return;
                    void cmd.run('dining.link', { session_id: c.id, table: t });
                  }}>{c.dining ? 'Re-link' : 'Link to table'}</button>
                  {c.dining ? <button type="button" className="ml-2 text-xs font-semibold text-[#6B5744]" onClick={() => void cmd.run('dining.unlink', { session_id: c.id })}>Unlink</button> : null}
                </> : null}
              </div>
            ) : null}
            {c.duplicate_plate_note ? <div className="sm:col-span-2 text-amber-800">Duplicate plate note: {c.duplicate_plate_note}</div> : null}
            {c.has_photo_exception ? <div className="sm:col-span-2 text-amber-800">Photos skipped (reason recorded)</div> : null}
          </div>
          {p ? (
            <Panel title="Pickup">
              <div className="text-sm space-y-1">
                <div>{p.state === 'SCHEDULED' ? `Booked for ${hhmm(p.target_at)}` : `Requested ${hhmm(p.requested_at)} (${p.source})`}{p.priority ? ` · priority ${p.priority} — ${p.priority_reason}` : ''}</div>
                {p.assigned_name ? <div>Assigned to <b>{p.assigned_name}</b>{p.handoff_open ? ` — waiting for them to confirm the handoff from ${p.handoff_from_name}` : ''}</div> : null}
                {p.eta.low_min != null ? <div>Estimate {p.eta.low_min}–{p.eta.high_min} min ({p.eta.basis}){p.eta.position ? ` · ${p.eta.position} in line` : ''}</div> : p.eta.note ? <div>{p.eta.note.replace(/_/g, ' ')}</div> : null}
                {p.change_open ? <div className="rounded bg-amber-50 p-2 text-amber-900">Guest asked: {p.change_request.startsWith('reschedule') ? `change time to ${hhmm(p.change_request.slice(11))}` : 'cancel'}
                  <div className="mt-1 flex gap-2">
                    <Btn onClick={() => void cmd.run('change.ack', { pickup_id: p.id, version: p.version, accept: true, return_to: 'park' })}>Accept</Btn>
                    <Btn kind="ghost" onClick={() => void cmd.run('change.ack', { pickup_id: p.id, version: p.version, accept: false, note: 'car already on its way' })}>Decline</Btn>
                  </div></div> : null}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {['QUEUED', 'ASSIGNED', 'IN_PROGRESS'].includes(p.state) ? (
                  <select aria-label="Assign to" className={`${inputCls} w-auto`} value="" onChange={async e => {
                    const uid = e.target.value; if (!uid) return;
                    const reason = p.state === 'QUEUED' ? '' : await ask('Why reassign this car?');
                    if (reason === null) return;
                    void cmd.run('pickup.assign', { pickup_id: p.id, version: p.version, user_id: uid, reason });
                  }}>
                    <option value="">{p.state === 'QUEUED' ? 'Assign to…' : 'Reassign to…'}</option>
                    {onShift.filter(t => t.user_id !== p.assigned_user_id).map(t => <option key={t.user_id} value={t.user_id}>{t.name} ({t.status})</option>)}
                  </select>
                ) : null}
                {['SCHEDULED', 'QUEUED', 'ASSIGNED'].includes(p.state) ? <Btn kind="ghost" onClick={async () => {
                  const n = await askRaw({ title: 'Change priority', label: 'Priority (0 normal, 1–3 higher)', initial: String(Math.min(3, p.priority + 1)), min: 1, inputMode: 'numeric', confirmText: 'Next' }); if (n === null) return;
                  const why = await ask('Why change the priority?'); if (why === null) return;
                  void cmd.run('pickup.priority', { pickup_id: p.id, version: p.version, priority: Number(n), reason: why });
                }}>Priority</Btn> : null}
                {['QUEUED', 'ASSIGNED', 'IN_PROGRESS'].includes(p.state) ? <Btn kind="ghost" onClick={async () => {
                  const r = await askRaw({ title: 'Adjust the estimate', label: 'Minutes from now, e.g. 10-15 (leave blank to go back to automatic)', min: 0, confirmText: 'Next' }); if (r === null) return;
                  const why = await ask('Why adjust the estimate?'); if (why === null) return;
                  const m = r.match(/(\d+)\s*[-–]\s*(\d+)/);
                  void cmd.run('pickup.eta', m ? { pickup_id: p.id, version: p.version, low_min: Number(m[1]), high_min: Number(m[2]), reason: why } : { pickup_id: p.id, version: p.version, clear: true, reason: why });
                }}>Adjust ETA</Btn> : null}
                {['SCHEDULED', 'QUEUED', 'ASSIGNED', 'IN_PROGRESS', 'READY'].includes(p.state) ? <Btn kind="ghost" onClick={async () => {
                  const why = await ask('Cancel this pickup — why?'); if (why === null) return;
                  void cmd.run('pickup.cancel', { pickup_id: p.id, reason: why, return_to: 'park' });
                }}>Cancel pickup</Btn> : null}
                {p.state === 'ASSIGNED' ? <Btn kind="ghost" onClick={async () => { const why = await ask('Put back in the queue — why?'); if (why !== null) void cmd.run('pickup.unassign', { pickup_id: p.id, version: p.version, reason: why }); }}>Back to queue</Btn> : null}
              </div>
            </Panel>
          ) : ['PARKED', 'HOLDING_NEAR_GATE', 'CHECKED_IN', 'PARKING'].includes(c.state) ? (
            <Btn onClick={async () => { if (await askRaw({ title: 'Request this car now on the guest\'s behalf? Only do this if the guest asked.', confirmText: 'Yes — the guest asked' }) !== null) void cmd.run('pickup.request', { session_id: c.id, when: 'now', guest_confirmed: true, idempotency_key: `head:${c.id}:${Math.floor(Date.now() / 60000)}` }); }}>Request pickup for guest</Btn>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {c.state === 'READY_AT_GATE' ? <Btn kind="ok" onClick={() => setSub('handover')}>Verify handover / recovery</Btn> : null}
            {!['HANDED_OVER', 'VOIDED'].includes(c.state) ? <>
              <Btn kind="ghost" onClick={() => setSub('pass')}>Pass QR</Btn>
              <Btn kind="ghost" onClick={() => setSub('claim')}>Claim receipt</Btn>
              <select aria-label="Move keys" className={`${inputCls} w-auto`} value="" onChange={async e => {
                const v = e.target.value; if (!v) return;
                if (v === 'rack') { const rack = await askRaw({ title: 'Keys to the rack', label: 'Rack / hook, e.g. R1 / 7', min: 1, confirmText: 'Move keys' }); if (rack === null) return; const [r, h] = rack.split('/').map(s => s.trim()); void cmd.run('key.transfer', { session_id: c.id, version: c.version, to: 'rack', key_rack: r, key_hook: h || '' }); }
                else if (v === 'desk') void cmd.run('key.transfer', { session_id: c.id, version: c.version, to: 'desk' });
                else void cmd.run('key.transfer', { session_id: c.id, version: c.version, to: 'attendant', to_user_id: v });
              }}>
                <option value="">Move keys to…</option><option value="rack">Rack</option><option value="desk">Desk</option>
                {onShift.map(t => <option key={t.user_id} value={t.user_id}>{t.name}</option>)}
              </select>
              <Btn kind="ghost" onClick={async () => { const code = await askRaw({ title: 'Replace tag', label: 'New key tag number', min: 1, confirmText: 'Next' }); if (code === null) return; const why = await ask('Why replace the tag?'); if (why === null) return; void cmd.run('tag.replace', { session_id: c.id, new_code: code, old_status: 'disabled', reason: why }); }}>Replace tag</Btn>
              <Btn kind="ghost" onClick={async () => { const desc = await askRaw({ title: 'Record an incident', label: 'What happened? (recorded)', min: 5, confirmText: 'Record' }); if (desc === null) return; void cmd.run('incident.create', { session_id: c.id, kind: 'other', description: desc }); }}>Record incident</Btn>
              <Btn kind="danger" onClick={async () => { const why = await ask('Void this record — why? (test entry / duplicate). History is kept.'); if (why === null) return; void cmd.run('session.void', { session_id: c.id, version: c.version, reason: why, is_test: /test/i.test(why) }).then(() => onClose()); }}>Void record</Btn>
            </> : null}
          </div>
          {/* An observation, never a location fix or a state change (spec §10). */}
          {d?.rfid ? <p className="text-xs text-[#6B5744]">RFID{d.rfid.simulated ? ' (SIMULATED)' : ''}: keys seen near <b>{d.rfid.zone_name || d.rfid.reader_name}</b> {ago(d.rfid.observed_at, nowMs)} ago · {d.rfid.reads_10min} read{d.rfid.reads_10min === 1 ? '' : 's'} in 10 min — unconfirmed, check before acting.</p> : null}
          <div><div className="text-xs font-bold text-[#6B5744] mb-1">Condition photos</div><PhotoStrip outletId={outletId} sessionId={c.id} /></div>
          {d ? (
            <details className="rounded-lg border border-[#E8D5C4] p-2" open>
              <summary className="cursor-pointer text-sm font-bold">Timeline ({d.events.length}) · custody ({d.custody.length}) · attempts ({d.pickups.length})</summary>
              <ol className="mt-2 space-y-1 text-xs">
                {[...d.events.map(e => ({ at: e.created_at, text: `${e.event_type.replace(/[._]/g, ' ')}${e.to_state ? ` → ${e.to_state.toLowerCase().replace(/_/g, ' ')}` : ''} · ${e.actor_name}${e.reason ? ` — ${e.reason}` : ''}` })),
                  ...d.custody.map(k => ({ at: k.created_at, text: `${k.kind === 'key' ? 'keys' : 'car'}: ${k.from_desc} → ${k.to_desc} · ${k.actor_name}${k.note ? ` (${k.note})` : ''}` }))]
                  .sort((a, z) => a.at.localeCompare(z.at)).map((x, i) => <li key={i}><span className="font-mono text-[#8B7355]">{hhmm(x.at)}</span> {x.text}</li>)}
              </ol>
            </details>
          ) : null}
        </div>
      )}
      {sub === 'handover' && c ? <HandoverModal card={c} outletId={outletId} isHead onClose={() => setSub('')} onDone={() => { setSub(''); void load(); reload(); }} /> : null}
      {sub === 'pass' && c ? <IssuedModal outletId={outletId} sessionId={c.id} start="qr" onClose={() => setSub('')} /> : null}
      {sub === 'claim' && c ? <IssuedModal outletId={outletId} sessionId={c.id} start="claim" onClose={() => setSub('')} /> : null}
      {askEl}
    </Modal>
  );
}
