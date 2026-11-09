'use client';

/**
 * VALET chip for an existing bill screen (/cashier). SELF-CONTAINED and
 * SILENT BY DEFAULT: it renders NOTHING unless valet is on at the bill's outlet
 * AND the signed-in person holds a valet desk/attendant/head capability and is
 * assigned there (GET /api/valet/dining answers 403/404 otherwise). So adding
 * it changes nothing for anyone who does not use valet.
 *
 * It never moves a car on its own: printing or settling the bill does not
 * request anything. A car is requested only when the cashier ticks that the
 * guest asked for it (spec §9).
 */
import { useCallback, useEffect, useState } from 'react';
import { CarFront } from 'lucide-react';
import { api } from '@/lib/api';

interface Car { id: string; tag_code: string; ticket_no: string; state: string; pickup_state: string | null; make: string; model: string; colour: string }

const STATE: Record<string, string> = {
  CHECKED_IN: 'being parked', PARKING: 'being parked', PARKED: 'parked', RETRIEVING: 'on its way', READY_AT_GATE: 'at the gate',
  RELOCATING: 'moving near the gate', HOLDING_NEAR_GATE: 'waiting near the gate',
};

export default function ValetOrderChip({ orderId }: { orderId: string }) {
  const [d, setD] = useState<null | { outlet_id: string; cars: Car[]; can_request: boolean; open: boolean }>(null);
  const [tag, setTag] = useState('');
  const [confirmFor, setConfirmFor] = useState('');
  const [asked, setAsked] = useState(false);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/valet/dining?order=${encodeURIComponent(orderId)}`, { cache: 'no-store' });
      const j = r.ok ? await r.json() : null;
      if (!j?.show) { setD(null); return; }
      setD({ outlet_id: j.outlet_id, cars: j.cars || [], can_request: j.can_request === true, open: j.order?.status === 'open' });
    } catch { setD(null); }
  }, [orderId]);
  useEffect(() => { setMsg(''); setConfirmFor(''); void load(); }, [load]);
  // Nothing linked and the bill is closed: nothing useful to say.
  if (!d || (!d.open && d.cars.length === 0)) return null;
  const cmd = async (body: Record<string, unknown>, ok: string) => {
    setBusy(true); setMsg('');
    try {
      const r = await api('/api/valet/command', { method: 'POST', body: { outlet_id: d.outlet_id, ...body } });
      const j = await r.json().catch(() => ({}));
      setMsg(r.ok ? ok : (j.error || 'Could not do that.'));
      await load();
    } finally { setBusy(false); }
  };
  return (
    <div className="mx-4 mt-3 rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] px-3 py-2 text-sm" aria-label="Valet">
      <div className="flex items-center gap-1.5 font-semibold text-[#6B5744]"><CarFront className="w-4 h-4" /> Valet</div>
      {d.cars.map(c => (
        <div key={c.id} className="mt-1.5 flex flex-wrap items-center gap-2">
          <span>Tag <b>{c.tag_code || c.ticket_no}</b> · {[c.colour, c.make, c.model].filter(Boolean).join(' ')} · {c.pickup_state ? 'requested' : STATE[c.state] || c.state.toLowerCase()}</span>
          {d.can_request && !c.pickup_state && ['PARKED', 'HOLDING_NEAR_GATE', 'CHECKED_IN', 'PARKING'].includes(c.state) ? (
            confirmFor === c.id ? (
              <span className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={asked} onChange={e => setAsked(e.target.checked)} />Guest asked for the car</label>
                <button type="button" disabled={!asked || busy} className="rounded-lg bg-[#af4408] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
                  onClick={() => void cmd({ cmd: 'pickup.request', session_id: c.id, when: 'now', guest_confirmed: true, idempotency_key: `cashier:${c.id}:${Math.floor(Date.now() / 60000)}` }, `Car ${c.tag_code} requested.`)}>Request now</button>
                <button type="button" className="text-xs text-[#6B5744] underline" onClick={() => setConfirmFor('')}>Cancel</button>
              </span>
            ) : <button type="button" className="rounded-lg border border-[#af4408]/40 px-2 py-1 text-xs font-semibold text-[#af4408]" onClick={() => { setConfirmFor(c.id); setAsked(false); }}>Request car…</button>
          ) : null}
        </div>
      ))}
      {d.open && <form className="mt-1.5 flex items-center gap-2" onSubmit={e => { e.preventDefault(); if (tag.trim()) void cmd({ cmd: 'dining.link', order_id: orderId, tag_code: tag.trim() }, `Tag ${tag.trim()} linked to this bill.`).then(() => setTag('')); }}>
        <input value={tag} onChange={e => setTag(e.target.value)} placeholder="Valet tag no." aria-label="Valet tag number to link" className="w-28 rounded border border-[#E8D5C4] bg-white px-2 py-1 text-xs" />
        <button type="submit" disabled={!tag.trim() || busy} className="rounded border border-[#E8D5C4] bg-white px-2 py-1 text-xs font-semibold disabled:opacity-40">Link car to bill</button>
      </form>}
      {msg ? <p className="mt-1 text-xs text-[#6B5744]" role="status">{msg}</p> : null}
    </div>
  );
}
