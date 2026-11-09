'use client';

/**
 * VALET SETTINGS (/valet/settings) — per-outlet switch, rules, zones, key tags,
 * staff, and the guest check-in QR. Valet Head edits zones and tags; the
 * owner/admin alone switches valet on, changes rules and assigns staff (the API
 * enforces this — the read-only sections below are a courtesy, not the gate).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { Printer, RotateCcw, Save } from 'lucide-react';
import {
  PageHead, OutletPicker, Gate, Panel, Btn, Field, inputCls, ErrorNote, InfoNote, QrImage,
  useValetContext, valetCmd, useAsk, type AskOptions,
} from '../ui';

// The config is edited as loose JSON and normalised by the server (parseConfig).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cfg = Record<string, any>;
interface SettingsData {
  outlet: { id: string; name: string }; enabled: boolean; config: Cfg; entry_token: string; entry_path: string;
  zones: { id: string; name: string; kind: string; capacity: number | null; retrieval_minutes: number | null; sort_order: number; is_active: number }[];
  tags: { id: string; code: string; kind: string; status: string; notes: string; on_car: string | null }[];
  staff: null | { id: string; name: string; email: string; role_name: string | null; valet_head: number; valet_attendant: number; valet_host: number; assigned: number }[];
  can_admin: boolean;
}

export default function ValetSettingsPage() {
  const { ctx, error: ctxError, outletId, setOutletId } = useValetContext();
  const [data, setData] = useState<SettingsData | null>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const load = useCallback(async () => {
    if (!outletId) return;
    const r = await fetch(`/api/valet/settings?outlet=${encodeURIComponent(outletId)}`, { cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setErr(j.error || 'Could not load settings.'); return; }
    setData(j); setErr('');
  }, [outletId]);
  useEffect(() => { void load(); }, [load]);
  const { ask, askEl } = useAsk();
  const run = async (cmd: string, body: Record<string, unknown> = {}, ok = 'Saved.') => {
    setErr(''); setMsg('');
    try { await valetCmd(outletId, cmd, body); setMsg(ok); await load(); return true; }
    catch (e) { setErr((e as Error).message); return false; }
  };

  return (
    <div className="pb-24 max-w-5xl">
      <PageHead ctx={ctx} title="Valet Settings" subtitle={data ? `${data.outlet.name} · valet ${data.enabled ? 'ON' : 'OFF'}` : 'Per-outlet valet setup'}
        right={ctx ? <OutletPicker ctx={ctx} outletId={outletId} onChange={setOutletId} /> : null} />
      <Gate ctx={ctx} ctxError={ctxError}>
        <div className="mt-3 space-y-3">
          <ErrorNote message={err} />
          {msg ? <InfoNote>{msg}</InfoNote> : null}
          {!data ? <p className="text-sm text-[#8B7355]">Loading…</p> : (
            <>
              <OutletSwitch data={data} run={run} ask={ask} />
              <EntryQr data={data} run={run} ask={ask} />
              <Zones data={data} run={run} />
              <Tags data={data} run={run} ask={ask} />
              {data.can_admin ? <Rules data={data} run={run} /> : <InfoNote>Valet rules (hours, timers, required fields) are set by the owner/admin.</InfoNote>}
              {data.can_admin && data.staff ? <Staff data={data} run={run} /> : null}
              <Messages outletId={outletId} canAdmin={data.can_admin} />
            </>
          )}
        </div>
      </Gate>
      {askEl}
    </div>
  );
}

type Run = (cmd: string, body?: Record<string, unknown>, ok?: string) => Promise<boolean>;
type Ask = (o: AskOptions) => Promise<string | null>;

function OutletSwitch({ data, run, ask }: { data: SettingsData; run: Run; ask: Ask }) {
  return (
    <Panel title="Valet at this outlet">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm text-[#6B5744]">
          {data.enabled ? 'Valet is ON. Staff can check cars in and guests can use their pass.' : 'Valet is OFF. Nobody can check a car in here until it is switched on.'}
        </p>
        {data.can_admin ? (
          <Btn kind={data.enabled ? 'ghost' : 'ok'} onClick={async () => {
            if (data.enabled && await ask({ title: 'Switch valet OFF for this outlet? Cars already checked in stay on the board, but no new check-ins or guest requests will be accepted.', confirmText: 'Switch OFF', danger: true }) === null) return;
            void run('settings.enable', { enabled: !data.enabled }, data.enabled ? 'Valet switched off.' : 'Valet switched on.');
          }}>{data.enabled ? 'Switch OFF' : 'Switch ON'}</Btn>
        ) : <span className="text-xs text-[#8B7355]">Only the owner/admin can switch this.</span>}
      </div>
    </Panel>
  );
}

function EntryQr({ data, run, ask }: { data: SettingsData; run: Run; ask: Ask }) {
  const [origin, setOrigin] = useState('');
  useEffect(() => { setOrigin(window.location.origin); }, []);
  if (!data.entry_path) {
    return <Panel title="Guest check-in QR"><InfoNote>Save the rules or switch valet on once to create this outlet&apos;s check-in QR.</InfoNote></Panel>;
  }
  const url = `${origin}${data.entry_path}`;
  return (
    <Panel title="Guest check-in QR (venue standee / NFC card)">
      <div className="flex gap-4 flex-wrap items-start print:block" id="valet-entry-qr">
        <QrImage text={url} size={200} label="Guest valet check-in QR code" />
        <div className="min-w-0 flex-1 text-sm text-[#6B5744] space-y-2">
          <p>Guests scan this (or tap an NFC card written with the same link) to start check-in on their own phone. It opens the check-in page only — it never shows any car or guest.</p>
          <p className="break-all font-mono text-xs bg-[#FFF1E3] rounded p-2">{url}</p>
          <div className="flex gap-2 flex-wrap print:hidden">
            <Btn kind="ghost" onClick={() => window.print()}><Printer size={14} className="inline mr-1" aria-hidden />Print</Btn>
            {data.can_admin ? (
              <Btn kind="ghost" onClick={async () => {
                if (await ask({ title: 'Make a NEW check-in link? Every printed QR and NFC card for this outlet stops working until replaced.', confirmText: 'Make new link', danger: true }) === null) return;
                void run('settings.entry_rotate', {}, 'New check-in link created. Replace the printed QR / NFC cards.');
              }}><RotateCcw size={14} className="inline mr-1" aria-hidden />New link</Btn>
            ) : null}
          </div>
        </div>
      </div>
    </Panel>
  );
}

function Zones({ data, run }: { data: SettingsData; run: Run }) {
  const [draft, setDraft] = useState({ id: '', name: '', kind: 'parking', capacity: '', retrieval_minutes: '', is_active: true });
  const edit = (z: SettingsData['zones'][number]) => setDraft({ id: z.id, name: z.name, kind: z.kind, capacity: z.capacity == null ? '' : String(z.capacity),
    retrieval_minutes: z.retrieval_minutes == null ? '' : String(z.retrieval_minutes), is_active: !!z.is_active });
  const save = async () => {
    if (await run('zone.save', { ...draft, id: draft.id || undefined }, 'Zone saved.')) setDraft({ id: '', name: '', kind: 'parking', capacity: '', retrieval_minutes: '', is_active: true });
  };
  const KIND = { parking: 'Parking zone', gate: 'Pickup gate', holding: 'Holding near gate' } as Record<string, string>;
  return (
    <Panel title="Zones — parking, pickup gate, holding">
      <p className="text-xs text-[#8B7355] mb-2">Capacity drives the gate/holding warnings. Leave it blank if you don&apos;t know it — the board then says &ldquo;unknown&rdquo; instead of guessing. &ldquo;Minutes to fetch&rdquo; is only used until there is enough real data.</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-[#8B7355]"><th className="py-1 pr-2">Name</th><th className="pr-2">Type</th><th className="pr-2">Capacity</th><th className="pr-2">Minutes to fetch</th><th className="pr-2">Status</th><th /></tr></thead>
          <tbody>
            {data.zones.map(z => (
              <tr key={z.id} className="border-t border-[#F0E4D6]">
                <td className="py-1.5 pr-2 font-semibold">{z.name}</td><td className="pr-2">{KIND[z.kind] || z.kind}</td>
                <td className="pr-2">{z.capacity ?? 'unknown'}</td><td className="pr-2">{z.retrieval_minutes ?? '—'}</td>
                <td className="pr-2">{z.is_active ? 'Active' : 'Off'}</td>
                <td className="text-right"><button type="button" className="text-[#af4408] font-semibold text-xs" onClick={() => edit(z)}>Edit</button></td>
              </tr>
            ))}
            {!data.zones.length ? <tr><td colSpan={6} className="py-2 text-[#8B7355]">No zones yet. Add at least one parking zone and one pickup gate.</td></tr> : null}
          </tbody>
        </table>
      </div>
      <div className="mt-3 grid grid-cols-2 sm:grid-cols-6 gap-2 items-end">
        <div className="col-span-2"><Field label={draft.id ? 'Edit zone name' : 'New zone name'}><input className={inputCls} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} maxLength={40} /></Field></div>
        <Field label="Type"><select className={inputCls} value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value })}>
          <option value="parking">Parking zone</option><option value="gate">Pickup gate</option><option value="holding">Holding near gate</option></select></Field>
        <Field label="Capacity"><input className={inputCls} inputMode="numeric" value={draft.capacity} onChange={e => setDraft({ ...draft, capacity: e.target.value.replace(/\D/g, '') })} placeholder="unknown" /></Field>
        <Field label="Minutes to fetch"><input className={inputCls} inputMode="numeric" value={draft.retrieval_minutes} onChange={e => setDraft({ ...draft, retrieval_minutes: e.target.value.replace(/\D/g, '') })} placeholder="default" /></Field>
        <div className="flex gap-2">
          {draft.id ? <label className="text-xs flex items-center gap-1"><input type="checkbox" checked={draft.is_active} onChange={e => setDraft({ ...draft, is_active: e.target.checked })} />Active</label> : null}
          <Btn onClick={() => void save()} disabled={!draft.name.trim()}>{draft.id ? 'Save' : 'Add'}</Btn>
        </div>
      </div>
    </Panel>
  );
}

function Tags({ data, run, ask }: { data: SettingsData; run: Run; ask: Ask }) {
  const [from, setFrom] = useState('1');
  const [to, setTo] = useState('50');
  const [prefix, setPrefix] = useState('');
  const [filter, setFilter] = useState('');
  const counts = useMemo(() => data.tags.reduce((m, t) => { m[t.status] = (m[t.status] || 0) + 1; return m; }, {} as Record<string, number>), [data.tags]);
  const shown = data.tags.filter(t => !filter || t.code.toLowerCase().includes(filter.toLowerCase()) || t.status === filter);
  return (
    <Panel title={`Key tags (${data.tags.length})`} right={<span className="text-xs text-[#8B7355]">{Object.entries(counts).map(([k, v]) => `${v} ${k.replace('_', ' ')}`).join(' · ')}</span>}>
      <p className="text-xs text-[#8B7355] mb-2">A tag number is a label, not a password — the guest&apos;s pass or claim code is what proves who they are. An unknown tag typed at check-in is registered automatically.</p>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 items-end">
        <Field label="Prefix (optional)"><input className={inputCls} value={prefix} onChange={e => setPrefix(e.target.value.toUpperCase().slice(0, 4))} placeholder="e.g. A" /></Field>
        <Field label="From"><input className={inputCls} inputMode="numeric" value={from} onChange={e => setFrom(e.target.value.replace(/\D/g, ''))} /></Field>
        <Field label="To"><input className={inputCls} inputMode="numeric" value={to} onChange={e => setTo(e.target.value.replace(/\D/g, ''))} /></Field>
        <Btn onClick={() => void run('tags.add', { from: Number(from), to: Number(to), prefix }, 'Tags added (existing numbers skipped).')}>Add range</Btn>
        <Field label="Find"><input className={inputCls} value={filter} onChange={e => setFilter(e.target.value)} placeholder="number or status" /></Field>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5 max-h-64 overflow-y-auto">
        {shown.slice(0, 400).map(t => (
          <span key={t.id} className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs ${t.status === 'in_use' ? 'border-sky-200 bg-sky-50' : t.status === 'available' ? 'border-[#E8D5C4] bg-white' : 'border-stone-300 bg-stone-100 text-stone-500'}`}>
            <b>{t.code}</b>
            <span className="text-[10px]">{t.status === 'in_use' ? `on car (${(t.on_car || '').toLowerCase().replace(/_/g, ' ')})` : t.status}</span>
            {t.status !== 'in_use' ? (
              <select aria-label={`Change status of tag ${t.code}`} className="ml-1 rounded border border-[#E8D5C4] text-[10px]" value=""
                onChange={async e => { const v = e.target.value; if (!v) return; const reason = v === 'available' ? 'back in service' : await ask({ title: `Tag ${t.code} → ${v}`, label: 'Why? (recorded)', min: 3, confirmText: 'Save' }); if (reason === null) return; void run('tag.status', { tag_id: t.id, status: v, reason }, `Tag ${t.code} → ${v}.`); }}>
                <option value="">…</option>
                {['available', 'disabled', 'lost', 'retired'].filter(s => s !== t.status).map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            ) : null}
          </span>
        ))}
      </div>
    </Panel>
  );
}

function Rules({ data, run }: { data: SettingsData; run: Run }) {
  const [c, setC] = useState<Cfg>(data.config);
  useEffect(() => { setC(data.config); }, [data.config]);
  const set = (path: string, v: unknown) => setC(prev => {
    const next = structuredClone(prev);
    const keys = path.split('.');
    let o = next; for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
    o[keys[keys.length - 1]] = v;
    return next;
  });
  const num = (path: string, v: string) => set(path, v === '' ? '' : Number(v.replace(/\D/g, '')));
  const box = (path: string, label: string, val: boolean) => (
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!val} onChange={e => set(path, e.target.checked)} />{label}</label>
  );
  return (
    <Panel title="Rules (owner/admin)" right={<Btn onClick={() => void run('settings.config', { config: c }, 'Rules saved.')}><Save size={14} className="inline mr-1" aria-hidden />Save rules</Btn>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <h3 className="text-xs font-bold uppercase tracking-wide text-[#8B7355]">Guest pass</h3>
          <Field label="Name on the guest pass" hint="Blank = the outlet name"><input className={inputCls} value={c.venue_name} onChange={e => set('venue_name', e.target.value)} maxLength={80} /></Field>
          <Field label="Pickup point name"><input className={inputCls} value={c.pickup_gate_label} onChange={e => set('pickup_gate_label', e.target.value)} maxLength={80} /></Field>
          <Field label="Venue phone shown for help"><input className={inputCls} value={c.help_phone} onChange={e => set('help_phone', e.target.value)} inputMode="tel" /></Field>
          <Field label="Default language"><select className={inputCls} value={c.language} onChange={e => set('language', e.target.value)}><option value="en">English</option><option value="hi">हिंदी (Hindi)</option></select></Field>
          <h3 className="text-xs font-bold uppercase tracking-wide text-[#8B7355] pt-2">Required at check-in</h3>
          <div className="grid grid-cols-2 gap-1">
            {box('required.plate', 'Number plate', c.required?.plate)}{box('required.make', 'Make', c.required?.make)}
            {box('required.model', 'Model', c.required?.model)}{box('required.colour', 'Colour', c.required?.colour)}
            {box('required.guest_name', 'Guest name', c.required?.guest_name)}{box('required.guest_mobile', 'Guest mobile', c.required?.guest_mobile)}
          </div>
          <h3 className="text-xs font-bold uppercase tracking-wide text-[#8B7355] pt-2">Condition photos</h3>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Minimum photos (0–6)"><input className={inputCls} inputMode="numeric" value={c.photos?.min} onChange={e => num('photos.min', e.target.value)} /></Field>
            <div className="pt-6">{box('photos.allow_exception', 'Allow skipping with a reason', c.photos?.allow_exception)}</div>
          </div>
        </div>
        <div className="space-y-2">
          <h3 className="text-xs font-bold uppercase tracking-wide text-[#8B7355]">Hours and timers</h3>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Opens"><input type="time" className={inputCls} value={c.hours?.open} onChange={e => set('hours.open', e.target.value)} /></Field>
            <Field label="Closes"><input type="time" className={inputCls} value={c.hours?.close} onChange={e => set('hours.close', e.target.value)} /></Field>
            <Field label="Business day starts" hint="cars after midnight count for the night before"><input type="time" className={inputCls} value={c.business_day_starts} onChange={e => set('business_day_starts', e.target.value)} /></Field>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Gate wait (min)"><select className={inputCls} value={c.dwell_minutes} onChange={e => set('dwell_minutes', Number(e.target.value))}>{[2, 3, 5, 10].map(n => <option key={n} value={n}>{n}</option>)}</select></Field>
            <Field label="Minutes to fetch (default)"><input className={inputCls} inputMode="numeric" value={c.default_retrieval_minutes} onChange={e => num('default_retrieval_minutes', e.target.value)} /></Field>
            <Field label="Cars per attendant"><input className={inputCls} inputMode="numeric" value={c.max_tasks_per_attendant} onChange={e => num('max_tasks_per_attendant', e.target.value)} /></Field>
          </div>
          <h3 className="text-xs font-bold uppercase tracking-wide text-[#8B7355] pt-2">Pickup options</h3>
          <div className="grid grid-cols-2 gap-1">
            {box('pickup.now', 'Request now', c.pickup?.now)}{box('pickup.in5', 'In 5 minutes', c.pickup?.in5)}
            {box('pickup.in10', 'In 10 minutes', c.pickup?.in10)}{box('pickup.later', 'A later time', c.pickup?.later)}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Later: up to (minutes ahead)"><input className={inputCls} inputMode="numeric" value={c.pickup?.later_max_minutes} onChange={e => num('pickup.later_max_minutes', e.target.value)} /></Field>
            <Field label="Later: step (minutes)"><input className={inputCls} inputMode="numeric" value={c.pickup?.later_step_minutes} onChange={e => num('pickup.later_step_minutes', e.target.value)} /></Field>
          </div>
          <h3 className="text-xs font-bold uppercase tracking-wide text-[#8B7355] pt-2">Escalate after (minutes)</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Field label="Unclaimed"><input className={inputCls} inputMode="numeric" value={c.escalation?.unclaimed_min} onChange={e => num('escalation.unclaimed_min', e.target.value)} /></Field>
            <Field label="Fetching"><input className={inputCls} inputMode="numeric" value={c.escalation?.fetching_min} onChange={e => num('escalation.fetching_min', e.target.value)} /></Field>
            <Field label="Guest outside"><input className={inputCls} inputMode="numeric" value={c.escalation?.outside_wait_min} onChange={e => num('escalation.outside_wait_min', e.target.value)} /></Field>
            <Field label="Gate overrun"><input className={inputCls} inputMode="numeric" value={c.escalation?.dwell_overrun_min} onChange={e => num('escalation.dwell_overrun_min', e.target.value)} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Guest check-in code valid (min)"><input className={inputCls} inputMode="numeric" value={c.pending_checkin_minutes} onChange={e => num('pending_checkin_minutes', e.target.value)} /></Field>
            <Field label="Quiet device warning (min)"><input className={inputCls} inputMode="numeric" value={c.stale_device_minutes} onChange={e => num('stale_device_minutes', e.target.value)} /></Field>
          </div>
          <Field label="Keep valet-only guest details (months, max 12)" hint="After this, plate, guest name/number and photos are removed by the daily cleanup (cars with an incident hold are kept). A setting, not automatic legal compliance."><input className={inputCls} inputMode="numeric" value={c.retention_months} onChange={e => num('retention_months', e.target.value)} /></Field>
          <h3 className="text-xs font-bold uppercase tracking-wide text-[#8B7355] pt-2">Closing time</h3>
          {box('closing_rush.enabled', 'Before closing, ask WhatsApp-linked guests when they want their car', c.closing_rush?.enabled)}
          <div className="grid grid-cols-2 gap-2">
            <Field label="Start asking (minutes before close, 30–45)"><input className={inputCls} inputMode="numeric" value={c.closing_rush?.lead_minutes} onChange={e => num('closing_rush.lead_minutes', e.target.value)} /></Field>
            <Field label="Guests asked per batch"><input className={inputCls} inputMode="numeric" value={c.closing_rush?.batch_size} onChange={e => num('closing_rush.batch_size', e.target.value)} /></Field>
          </div>
        </div>
      </div>
      <div className="mt-4 border-t border-[#F0E4D6] pt-3 space-y-2">
        <h3 className="text-xs font-bold uppercase tracking-wide text-[#8B7355]">Guest WhatsApp messages</h3>
        <p className="text-xs text-[#8B7355]">Guests choose WhatsApp updates on their own pass and send a short code from their phone — that is what proves the number and records their consent. Messages use your approved WhatsApp templates (names only here; secrets stay in Settings → Integrations → WhatsApp). Until real sending is switched on, every message goes to the simulator below and nothing is sent.</p>
        {box('notifications.whatsapp', 'Send REAL WhatsApp messages from this outlet', c.notifications?.whatsapp)}
        <Field label="Venue WhatsApp number guests message (with country code)"><input className={inputCls} value={c.notifications?.whatsapp_number} onChange={e => set('notifications.whatsapp_number', e.target.value)} inputMode="tel" placeholder="+91…" /></Field>
        <div className="grid sm:grid-cols-2 gap-2">
          {(['linked', 'ready', 'holding', 'eta_changed', 'closing_prompt'] as const).map(k => (
            <Field key={k} label={`Template for “${({ linked: 'pass linked', ready: 'car ready at gate', holding: 'car moved to holding', eta_changed: 'new estimate', closing_prompt: 'closing-time question' } as Record<string, string>)[k]}”`}>
              <div className="flex gap-1">
                <input className={inputCls} value={c.notifications?.templates?.[k]?.name || ''} onChange={e => set(`notifications.templates.${k}.name`, e.target.value)} placeholder="approved template name" />
                <input className={`${inputCls} w-20`} value={c.notifications?.templates?.[k]?.lang || 'en'} onChange={e => set(`notifications.templates.${k}.lang`, e.target.value)} aria-label="language code" />
              </div>
            </Field>
          ))}
        </div>
      </div>
    </Panel>
  );
}

function Staff({ data, run }: { data: SettingsData; run: Run }) {
  const staff = data.staff || [];
  return (
    <Panel title="Staff for this outlet (owner/admin)">
      <p className="text-xs text-[#8B7355] mb-2">People appear here once their role carries a Valet tick (Settings → Roles). Tick them to let them work valet at <b>{data.outlet.name}</b>. Unticked people cannot see or touch this outlet&apos;s cars.</p>
      {!staff.length ? <InfoNote>No role has a Valet tick yet. Open Settings → Roles, tick &ldquo;Valet Head&rdquo; / &ldquo;Valet Attendant&rdquo; / &ldquo;Valet Desk&rdquo; on the right roles, and tick the Valet pages.</InfoNote> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-[#8B7355]"><th className="py-1 pr-2">Person</th><th className="pr-2">Role</th><th className="pr-2">Valet access</th><th>Works here</th></tr></thead>
            <tbody>
              {staff.map(s => (
                <tr key={s.id} className="border-t border-[#F0E4D6]">
                  <td className="py-1.5 pr-2"><b>{s.name}</b><div className="text-[11px] text-[#8B7355]">{s.email}</div></td>
                  <td className="pr-2">{s.role_name || '—'}</td>
                  <td className="pr-2 text-xs">{[s.valet_head ? 'Head' : '', s.valet_attendant ? 'Attendant' : '', s.valet_host ? 'Desk' : ''].filter(Boolean).join(', ') || <span className="text-amber-700">role has no valet tick</span>}</td>
                  <td><input type="checkbox" aria-label={`${s.name} works valet here`} checked={!!s.assigned}
                    onChange={e => void run('staff.assign', { user_id: s.id, assigned: e.target.checked }, e.target.checked ? `${s.name} can now work valet here.` : `${s.name} removed from this outlet.`)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

interface MsgRow { id: string; kind: string; status: string; attempts: number; last_error: string; created_at: string; sent_at: string | null; delivered_at: string | null; template_name: string; tag_code: string | null }

function Messages({ outletId, canAdmin }: { outletId: string; canAdmin: boolean }) {
  const [d, setD] = useState<null | { mode: string; reason: string; rows: MsgRow[] }>(null);
  const [phone, setPhone] = useState('');
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const load = useCallback(async () => {
    const r = await fetch(`/api/valet/messages?outlet=${encodeURIComponent(outletId)}`, { cache: 'no-store' });
    if (r.ok) setD(await r.json());
  }, [outletId]);
  useEffect(() => { void load(); }, [load]);
  const sim = async (body: Record<string, unknown>) => {
    setNote('');
    const r = await api('/api/valet/simulator', { method: 'POST', body: { outlet_id: outletId, ...body } });
    const j = await r.json().catch(() => ({}));
    setNote(r.ok ? (j.did ? `Simulated: ${j.did.join(', ') || 'no effect'}` : 'Worker pass done.') : (j.error || 'Failed'));
    await load();
  };
  if (!d) return null;
  return (
    <Panel title="Guest messages" right={<Btn kind="ghost" onClick={() => void load()}>Refresh</Btn>}>
      <div className={`mb-2 rounded-lg px-3 py-2 text-sm font-semibold ${d.mode === 'live' ? 'bg-emerald-50 text-emerald-900' : 'bg-amber-50 text-amber-900'}`}>
        {d.mode === 'live' ? 'LIVE — messages are sent through WhatsApp.' : `SIMULATOR — nothing is sent. ${d.reason}`}
      </div>
      {canAdmin && d.mode !== 'live' ? (
        <div className="mb-3 grid sm:grid-cols-4 gap-2 items-end rounded-lg border border-dashed border-amber-300 p-2">
          <Field label="Simulate a guest's message — from (test number)"><input className={inputCls} value={phone} onChange={e => setPhone(e.target.value)} placeholder="91900000000" /></Field>
          <Field label="Text (e.g. VALET ABC123, NOW, STOP)"><input className={inputCls} value={text} onChange={e => setText(e.target.value)} /></Field>
          <Btn onClick={() => void sim({ action: 'inbound', phone, text })} disabled={!phone || !text}>Simulate message</Btn>
          <Btn kind="ghost" onClick={() => void sim({ action: 'tick' })}>Run valet worker now</Btn>
        </div>
      ) : null}
      {note ? <InfoNote>{note}</InfoNote> : null}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-[#8B7355]"><tr><th className="py-1 pr-2">When</th><th className="pr-2">Tag</th><th className="pr-2">Message</th><th className="pr-2">Status</th><th>Detail</th></tr></thead>
          <tbody>
            {d.rows.map(r => (
              <tr key={r.id} className="border-t border-[#F0E4D6] align-top">
                <td className="py-1 pr-2 whitespace-nowrap text-xs">{new Date(r.created_at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}</td>
                <td className="pr-2">{r.tag_code || '—'}</td>
                <td className="pr-2">{r.kind.replace('_', ' ')}</td>
                <td className="pr-2"><span className={`rounded px-1.5 text-xs font-semibold ${r.status === 'failed' ? 'bg-red-100 text-red-800' : r.status === 'simulated' ? 'bg-amber-100 text-amber-900' : r.status === 'delivered' || r.status === 'read' ? 'bg-emerald-100 text-emerald-900' : 'bg-stone-100'}`}>{r.status}</span></td>
                <td className="text-xs text-[#6B5744]">{r.last_error || (r.template_name ? `template ${r.template_name}` : '')}</td>
              </tr>
            ))}
            {!d.rows.length ? <tr><td colSpan={5} className="py-2 text-[#8B7355]">No guest messages yet. Messages are only queued for guests who linked WhatsApp on their pass.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
