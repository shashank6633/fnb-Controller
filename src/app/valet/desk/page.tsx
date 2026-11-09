'use client';

/**
 * VALET DESK (/valet/desk) — host, cashier or floor manager. Find a guest's car
 * by the tag on their receipt, a paper ticket number or the last digits of the
 * plate; see where it is; request it ON THE GUEST'S BEHALF only after ticking
 * that the guest asked. No valet administration here, no guest phone numbers,
 * and the plate is masked (the guest confirms their own car).
 */
import { useState } from 'react';
import { Search, Car } from 'lucide-react';
import {
  PageHead, OutletPicker, Gate, Panel, Btn, Field, inputCls, ErrorNote, InfoNote, StateChip,
  useValetContext, useCmd, hhmm,
} from '../ui';
import { PaperClaimConfirm } from '../modals';

interface Hit {
  id: string; state: string; tag_code: string; ticket_no: string; plate: string; make: string; model: string; colour: string;
  pickup: null | { id: string; state: string; target_at: string; scheduled: boolean; eta: { low_min: number | null; high_min: number | null; note: string; ahead: number | null } };
}

export default function DeskPage() {
  const { ctx, error: ctxError, outletId, setOutletId } = useValetContext();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [err, setErr] = useState('');
  const [confirmFor, setConfirmFor] = useState<string>('');
  const [guestAsked, setGuestAsked] = useState(false);
  const [when, setWhen] = useState('now');
  const [done, setDone] = useState('');
  const search = async () => {
    setErr(''); setDone('');
    const r = await fetch(`/api/valet/desk?outlet=${encodeURIComponent(outletId)}&q=${encodeURIComponent(q)}`, { cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setErr(j.error || 'Search failed.'); return; }
    setHits(j.results);
  };
  const cmd = useCmd(outletId, () => { void search(); });
  return (
    <div className="pb-24 max-w-3xl">
      <PageHead ctx={ctx} title="Valet Desk" subtitle="Find a guest's car and request it for them"
        right={ctx ? <OutletPicker ctx={ctx} outletId={outletId} onChange={setOutletId} /> : null} />
      <Gate ctx={ctx} ctxError={ctxError}>
        <div className="mt-3 space-y-3">
          <Panel>
            <form className="flex gap-2 items-end" onSubmit={e => { e.preventDefault(); void search(); }}>
              <div className="flex-1"><Field label="Tag number, ticket number, or last 4 of the plate">
                <input className={`${inputCls} text-lg`} value={q} onChange={e => setQ(e.target.value)} autoFocus autoCapitalize="characters" />
              </Field></div>
              <Btn type="submit" big disabled={!q.trim()}><Search size={18} aria-hidden /><span className="sr-only">Search</span></Btn>
            </form>
          </Panel>
          <PaperDesk outletId={outletId} />
          <ErrorNote message={err || cmd.err} />
          {done ? <InfoNote>{done}</InfoNote> : null}
          {hits && !hits.length ? <InfoNote>No car found. Check the number on the guest&apos;s receipt, or ask the valet desk.</InfoNote> : null}
          {hits?.map(h => (
            <Panel key={h.id}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-3xl font-extrabold">{h.tag_code || h.ticket_no}</div>
                  <div className="text-sm text-[#6B5744]">{[h.colour, h.make, h.model].filter(Boolean).join(' ')} · {h.plate}</div>
                </div>
                <StateChip state={h.pickup && ['ASSIGNED', 'IN_PROGRESS', 'QUEUED', 'SCHEDULED'].includes(h.pickup.state) ? h.pickup.state : h.state} />
              </div>
              {h.pickup ? (
                <p className="mt-2 text-sm">
                  {h.pickup.state === 'SCHEDULED' ? `Booked for ${hhmm(h.pickup.target_at)} (target).`
                    : h.pickup.eta?.note === 'no_staff' ? 'Requested — waiting for an attendant to start.'
                    : h.pickup.eta?.low_min != null ? `Requested — ready in about ${h.pickup.eta.low_min}–${h.pickup.eta.high_min} min.` : 'Requested.'}
                </p>
              ) : h.state === 'READY_AT_GATE' ? <p className="mt-2 text-sm font-semibold text-emerald-800">The car is at the gate now.</p> : null}
              {!h.pickup && ['PARKED', 'HOLDING_NEAR_GATE', 'CHECKED_IN', 'PARKING'].includes(h.state) ? (
                confirmFor === h.id ? (
                  <div className="mt-3 space-y-2 rounded-lg bg-[#FFF1E3] p-3">
                    <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={guestAsked} onChange={e => setGuestAsked(e.target.checked)} />
                      The guest is here and asked for this car (they confirmed it is theirs).</label>
                    <Field label="When"><select className={inputCls} value={when} onChange={e => setWhen(e.target.value)}>
                      <option value="now">Now</option><option value="in5">In 5 minutes</option><option value="in10">In 10 minutes</option></select></Field>
                    <div className="flex gap-2">
                      <Btn kind="ok" disabled={!guestAsked || cmd.busy} onClick={async () => {
                        const r = await cmd.run('pickup.request', { session_id: h.id, when, guest_confirmed: true, idempotency_key: `desk:${h.id}:${Math.floor(Date.now() / 60000)}` });
                        if (r) { setDone(`Requested tag ${h.tag_code || h.ticket_no}. The valet team can see it now.`); setConfirmFor(''); setGuestAsked(false); }
                      }}><Car size={15} className="inline mr-1" aria-hidden />Request the car</Btn>
                      <Btn kind="ghost" onClick={() => { setConfirmFor(''); setGuestAsked(false); }}>Cancel</Btn>
                    </div>
                  </div>
                ) : <Btn className="mt-3" onClick={() => { setConfirmFor(h.id); setGuestAsked(false); setWhen('now'); }}>Request for guest…</Btn>
              ) : null}
            </Panel>
          ))}
        </div>
      </Gate>
    </div>
  );
}

/** Paper ticket at the desk: the guest shows a 6-digit code from their phone
 *  plus their paper stub; the host checks the stub and gives the pass. */
function PaperDesk({ outletId }: { outletId: string }) {
  const [code, setCode] = useState('');
  const [req, setReq] = useState<Record<string, string> | null>(null);
  const [msg, setMsg] = useState('');
  const cmd = useCmd(outletId);
  return (
    <Panel title="Paper ticket guest at the desk">
      {req ? (
        req.source === 'paper_claim'
          ? <PaperClaimConfirm outletId={outletId} request={req} onDone={ok => { if (ok) { setMsg(`Pass given for ticket ${req.ticket_no}.`); setReq(null); setCode(''); } }} />
          : <div className="space-y-2"><InfoNote>Ticket {req.ticket_no || '—'}: this car has not been checked in yet. Ask a valet attendant to check it in with the guest&apos;s code.</InfoNote><Btn kind="ghost" onClick={() => setReq(null)}>Back</Btn></div>
      ) : (
        <form className="flex gap-2 items-end" onSubmit={async e => { e.preventDefault(); setMsg(''); const r = await cmd.run<{ request: Record<string, string> }>('checkin.find', { code }); if (r?.request) setReq(r.request); }}>
          <div className="flex-1"><Field label="Code on the guest's phone (6 digits)"><input className={`${inputCls} text-xl tracking-[.3em] font-bold`} inputMode="numeric" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} /></Field></div>
          <Btn type="submit" disabled={code.length !== 6 || cmd.busy}>Find</Btn>
        </form>
      )}
      <ErrorNote message={cmd.err} />
      {msg ? <InfoNote>{msg}</InfoNote> : null}
    </Panel>
  );
}
