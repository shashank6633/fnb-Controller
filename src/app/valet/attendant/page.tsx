'use client';

/**
 * VALET ATTENDANT (/valet/attendant) — mobile-first. Big targets, high
 * contrast, camera or typed input everywhere a tag/code is entered. Every
 * button is a server command; nothing here is "confirmed" until the server
 * says so (an offline tap shows the error, it is never queued as done).
 *
 * The check-in DRAFT is the one thing kept on the device: vehicle fields + tag
 * only (no guest name or mobile), for 30 minutes, removed on success.
 */
import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Car, ScanLine, AlertTriangle, LogIn, LogOut, Coffee, Printer, QrCode, Timer, Hand, Nfc } from 'lucide-react';
import { useWebNfc, readOnce, refFromUrl } from '../nfc';
import BatchTagScanner from '@/components/BatchTagScanner';
import { HandoverModal, IssuedModal, PhotoModal, PaperClaimConfirm } from '../modals';
import { ATT, STAFF_STATE_LABEL, type Lang } from '@/lib/valet/i18n';
import { normTagCode } from '@/lib/valet/config';
import {
  PageHead, OutletPicker, Gate, Panel, Btn, Field, inputCls, ErrorNote, InfoNote, Modal, LiveBadge, StateChip,
  useValetContext, useLive, useCmd, useNow, useAsk, countdown, ago, hhmm,
} from '../ui';

interface Card {
  id: string; version: number; state: string; tag_code: string; ticket_no: string; plate: string; make: string; model: string; colour: string;
  zone_name: string; spot: string; key_location: string; key_desc: string; key_custodian_id: string | null;
  checked_in_at: string; parked_at: string | null; ready_at: string | null; dwell_deadline_at: string | null; guest_inside_at: string | null;
  relocating_by: string | null; flags: string[];
  pickup: null | { id: string; version: number; state: string; assigned_user_id: string | null; assigned_name: string;
    handoff_open: boolean; handoff_from_name: string; change_open: boolean; change_request: string; guest_outside_at: string | null; target_at: string };
}
interface View {
  outlet: { id: string; name: string; enabled: boolean }; server_time: string;
  shift: { id: string; outlet_id: string; status: string; started_at: string } | null;
  my_tasks: Card[]; unparked: Card[]; at_gate: Card[]; holding: Card[]; parked: Card[];
  queue: { waiting: number; scheduled: number }; keys_with_me: { id: string; tag_code: string; state: string }[];
  zones: { id: string; name: string; kind: string; capacity: number | null }[];
  config: { dwell_minutes: number; max_tasks: number; photos_min: number; photo_exception: boolean; required: Record<string, boolean>; gate_label: string; paper?: boolean };
  handoff: { taps: { id: string; number: number; created_at: string; expires_at: string }[];
    cars: { id: string; tag_code: string; ticket_no: string; plate: string; make: string; model: string; colour: string; checked_in_at: string; passes: number }[] };
}

const DRAFT_TTL = 30 * 60_000;

/** A car in a view by its key tag (or paper ticket) number. */
function findInView(v: View | null | undefined, raw: string): Card | null {
  if (!v) return null;
  const t = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const all = [...v.my_tasks, ...v.unparked, ...v.at_gate, ...v.holding, ...v.parked];
  return all.find(c => normTagCode(c.tag_code) === normTagCode(t) || (c.ticket_no && c.ticket_no.toUpperCase() === t)) || null;
}

export default function AttendantPage() {
  const { ctx, error: ctxError, outletId, setOutletId } = useValetContext();
  const [lang, setLang] = useState<Lang>('en');
  useEffect(() => { try { if (localStorage.getItem('fnb:valet:lang') === 'hi') setLang('hi'); } catch { /* ignore */ } }, []);
  const L = (k: string) => ATT[lang][k] || ATT.en[k] || k;
  const SL = (s: string) => STAFF_STATE_LABEL[lang][s] || s;
  const live = useLive<View>(outletId ? `/api/valet/attendant?outlet=${encodeURIComponent(outletId)}` : null, outletId, 8000);
  const v = live.data;
  const cmd = useCmd(outletId, live.reload);
  const now = useNow(1000);
  const [modal, setModal] = useState<null | { kind: string; card?: Card; data?: { sid: string; paired?: boolean } }>(null);
  const { ask, askEl } = useAsk();
  const close = useCallback(() => setModal(null), []);
  const me = ctx?.user.id;

  const findByTag = (raw: string): Card | null => findInView(v, raw);

  // ── Key-tag NFC sticker (DESIGN.md §6b). Opened by the phone's own NFC tap as
  // /valet/attendant?nfc=<ref>, or read here with Web NFC (Android Chrome). The
  // server resolves the reference for staff of that tag's outlet only.
  const [nfcNote, setNfcNote] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [nfcBusy, setNfcBusy] = useState(false);
  const resolveNfcRef = useCallback(async (ref: string, serial = '') => {
    const r = await fetch(`/api/valet/nfc?ref=${encodeURIComponent(ref)}&serial=${encodeURIComponent(serial)}`, { cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setNfcNote({ kind: 'error', text: j.error || 'Could not read that key tag link.' }); return; }
    // The sticker may belong to another of this person's outlets: read that
    // outlet's cars directly rather than waiting for the live view to switch.
    const view: View | null = j.outlet_id === outletId && v ? v
      : await fetch(`/api/valet/attendant?outlet=${encodeURIComponent(j.outlet_id)}`, { cache: 'no-store' }).then(x => (x.ok ? x.json() : null)).catch(() => null);
    if (j.outlet_id !== outletId) setOutletId(j.outlet_id);
    const c = findInView(view, j.tag_code);
    setNfcNote(j.copy_warning ? { kind: 'error', text: `Tag ${j.tag_code}: this sticker is a different chip from the one first used — possible copy. The Valet Head has been told.` }
      : c ? null : { kind: 'info', text: `Tag ${j.tag_code}: no car on it right now.` });
    if (c) setModal({ kind: 'car', card: c });
  }, [outletId, setOutletId, v]);
  useEffect(() => {
    // Arrival from a sticker. The reference is dropped from the address bar at
    // once, so this runs a single time even though resolveNfcRef can change.
    const ref = new URLSearchParams(window.location.search).get('nfc');
    if (!ref) return;
    window.history.replaceState(null, '', window.location.pathname);
    // Started from a promise callback: nothing is set synchronously in the effect.
    void Promise.resolve().then(() => resolveNfcRef(ref));
  }, [resolveNfcRef]);
  const tapNfc = async () => {
    setNfcBusy(true); setNfcNote({ kind: 'info', text: 'Hold the key tag against the back of the phone…' });
    // No `finally`: the React Compiler skips any component that has one.
    let read: { url: string; serial: string } | null = null;
    try { read = await readOnce(); } catch (e) { setNfcNote({ kind: 'error', text: (e as Error).message }); }
    const ref = read ? refFromUrl(read.url) : '';
    if (read && !ref) setNfcNote({ kind: 'error', text: 'That NFC tag is not a valet key tag.' });
    if (read && ref) await resolveNfcRef(ref, read.serial);
    setNfcBusy(false);
  };
  const canNfc = useWebNfc();

  const onShift = !!v?.shift && v.shift.outlet_id === outletId;
  const onBreak = onShift && v?.shift?.status === 'break';

  return (
    <div className="pb-28 max-w-3xl">
      <PageHead ctx={ctx} title="Valet Attendant"
        subtitle={v ? `${v.outlet.name} · ${onShift ? (onBreak ? L('on_break') : L('on_shift')) : L('off_shift')}` : ''}
        right={<>
          {ctx ? <OutletPicker ctx={ctx} outletId={outletId} onChange={setOutletId} /> : null}
          <LiveBadge status={live.status} updatedAt={live.updatedAt} onRefresh={live.reload} />
          <button type="button" className="rounded-full border border-[#E8D5C4] bg-white px-3 py-1.5 text-xs font-semibold"
            onClick={() => { const n = lang === 'hi' ? 'en' : 'hi'; setLang(n); try { localStorage.setItem('fnb:valet:lang', n); } catch { /* ignore */ } }}>{L('lang')}</button>
        </>} />
      <Gate ctx={ctx} ctxError={ctxError}>
        <div className="mt-3 space-y-3">
          {live.error ? <ErrorNote message={live.error.message} /> : null}
          <ErrorNote message={cmd.err} />
          {nfcNote?.kind === 'error' ? <ErrorNote message={nfcNote.text} /> : nfcNote ? <InfoNote>{nfcNote.text}</InfoNote> : null}
          {v?.handoff?.taps.length ? <TapPanel v={v} cmd={cmd} L={L} /> : null}
          {v && !v.outlet.enabled ? <InfoNote>Valet is switched off for this outlet.</InfoNote> : null}
          {!v ? <p className="text-sm text-[#8B7355]">Loading…</p> : (
            <>
              {/* Shift */}
              <Panel>
                <div className="flex items-center gap-2 flex-wrap">
                  {!onShift ? (
                    <Btn big className="flex-1" onClick={() => void cmd.run('shift.start')} disabled={cmd.busy}><LogIn size={18} className="inline mr-2" aria-hidden />{L('start_shift')}</Btn>
                  ) : (
                    <>
                      <span className="text-sm text-[#6B5744] flex-1">{L('on_shift')} · {ago(v.shift!.started_at, now)}</span>
                      <Btn kind="ghost" onClick={() => void cmd.run('shift.break', { on: !onBreak })} disabled={cmd.busy}><Coffee size={15} className="inline mr-1" aria-hidden />{onBreak ? L('end_break') : L('take_break')}</Btn>
                      <Btn kind="ghost" onClick={async () => { if (await ask({ title: `${L('end_shift')}?`, confirmText: L('end_shift'), danger: true }) !== null) void cmd.run('shift.end'); }} disabled={cmd.busy}><LogOut size={15} className="inline mr-1" aria-hidden />{L('end_shift')}</Btn>
                    </>
                  )}
                </div>
              </Panel>

              {/* Primary actions */}
              <div className="grid grid-cols-2 gap-2">
                <Btn big onClick={() => setModal({ kind: 'checkin' })} disabled={!onShift || !v.outlet.enabled}><KeyRound size={18} className="inline mr-1.5" aria-hidden />{L('new_checkin')}</Btn>
                <Btn big kind="ok" onClick={async () => {
                  const r = await cmd.run<{ pickup_id: string | null }>('take_next');
                  if (r && !r.pickup_id) cmd.setErr(L('nothing'));
                }} disabled={!onShift || onBreak || cmd.busy}>
                  <Car size={18} className="inline mr-1.5" aria-hidden />{L('take_next')}{v.queue.waiting ? ` (${v.queue.waiting})` : ''}
                </Btn>
                <Btn big kind="ghost" onClick={() => setModal({ kind: 'scan' })}><ScanLine size={18} className="inline mr-1.5" aria-hidden />{L('scan_tag')}</Btn>
                <Btn big kind="ghost" onClick={() => setModal({ kind: 'problem' })}><AlertTriangle size={18} className="inline mr-1.5" aria-hidden />{L('report')}</Btn>
                {canNfc ? <Btn big kind="ghost" className="col-span-2" onClick={() => void tapNfc()} disabled={nfcBusy}><Nfc size={18} className="inline mr-1.5" aria-hidden />{L('tap_nfc')}</Btn> : null}
              </div>

              {/* My task */}
              <Panel title={L('my_task')}>
                {!v.my_tasks.length ? <p className="text-sm text-[#8B7355]">—</p> : v.my_tasks.map(c => (
                  <TaskCard key={c.id} c={c} L={L} SL={SL} now={now} me={me}>
                    {c.pickup?.change_open ? (
                      <div className="rounded-lg bg-amber-50 border border-amber-200 p-2 text-sm text-amber-900">
                        {L('change_req')} ({c.pickup.change_request.startsWith('reschedule') ? `→ ${hhmm(c.pickup.change_request.slice(11))}` : 'cancel'})
                        <div className="mt-2 flex gap-2 flex-wrap">
                          <Btn onClick={() => void cmd.run('change.ack', { pickup_id: c.pickup!.id, version: c.pickup!.version, accept: true })}>{L('accept_change')}</Btn>
                          <Btn kind="ghost" onClick={() => void cmd.run('change.ack', { pickup_id: c.pickup!.id, version: c.pickup!.version, accept: false, note: 'already moving' })}>{L('keep_going')}</Btn>
                        </div>
                      </div>
                    ) : null}
                    {c.pickup?.state === 'ASSIGNED' && c.pickup.handoff_open ? (
                      <Btn big className="w-full" onClick={() => void cmd.run('handoff.ack', { pickup_id: c.pickup!.id })}><Hand size={18} className="inline mr-1.5" aria-hidden />{L('confirm_handoff')} ({c.pickup.handoff_from_name})</Btn>
                    ) : c.pickup?.state === 'ASSIGNED' ? (
                      <div className="grid grid-cols-2 gap-2">
                        <Btn big onClick={() => void cmd.run('fetch.start', { pickup_id: c.pickup!.id, version: c.pickup!.version })}>{L('start_fetch')}</Btn>
                        <Btn big kind="ghost" onClick={() => void cmd.run('pickup.unassign', { pickup_id: c.pickup!.id, version: c.pickup!.version })}>{L('give_back')}</Btn>
                      </div>
                    ) : c.pickup?.state === 'IN_PROGRESS' ? (
                      <Btn big kind="ok" className="w-full" onClick={() => setModal({ kind: 'ready', card: c })}>{L('mark_ready')}</Btn>
                    ) : c.state === 'PARKING' ? (
                      <Btn big className="w-full" onClick={() => setModal({ kind: 'park', card: c })}>{L('set_spot')}</Btn>
                    ) : c.state === 'RELOCATING' ? (
                      <Btn big className="w-full" onClick={() => setModal({ kind: 'hold', card: c })}>{L('confirm_holding')}</Btn>
                    ) : null}
                  </TaskCard>
                ))}
              </Panel>

              {v.at_gate.length ? (
                <Panel title={`${L('at_gate')} (${v.at_gate.length})`}>
                  {v.at_gate.map(c => {
                    const cd = countdown(c.dwell_deadline_at, now);
                    return (
                      <TaskCard key={c.id} c={c} L={L} SL={SL} now={now} me={me}
                        extra={c.state === 'READY_AT_GATE' ? <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold ${cd.over ? 'bg-red-600 text-white' : 'bg-emerald-100 text-emerald-900'}`}><Timer size={12} aria-hidden />{cd.text}{cd.over ? ' over' : ''}</span> : null}>
                        {c.state === 'READY_AT_GATE' ? (
                          <>
                            <Btn big kind="ok" className="w-full" onClick={() => setModal({ kind: 'handover', card: c })}>{L('verify_handover')}</Btn>
                            <div className="grid grid-cols-2 gap-2 mt-2">
                              <Btn kind="ghost" onClick={() => void cmd.run('guest.inside', { session_id: c.id })} disabled={!!c.guest_inside_at}>{L('went_inside')}</Btn>
                              <Btn kind={cd.over ? 'danger' : 'ghost'} onClick={() => void cmd.run('relocate.start', { session_id: c.id, version: c.version, reason: c.guest_inside_at ? 'guest_inside' : cd.over ? 'dwell_expired' : 'other' })}>{L('move_holding')}</Btn>
                            </div>
                          </>
                        ) : c.relocating_by === me ? (
                          <Btn big className="w-full" onClick={() => setModal({ kind: 'hold', card: c })}>{L('confirm_holding')}</Btn>
                        ) : null}
                      </TaskCard>
                    );
                  })}
                </Panel>
              ) : null}

              {v.unparked.length ? (
                <Panel title={`${L('unparked')} (${v.unparked.length})`}>
                  {v.unparked.map(c => (
                    <TaskCard key={c.id} c={c} L={L} SL={SL} now={now} me={me}>
                      <div className="grid grid-cols-2 gap-2">
                        <Btn onClick={() => setModal({ kind: 'park', card: c })}>{L('set_spot')}</Btn>
                        <Btn kind="ghost" onClick={() => void cmd.run('park.start', { session_id: c.id, version: c.version })} disabled={c.state !== 'CHECKED_IN'}>{L('start_parking')}</Btn>
                        <Btn kind="ghost" onClick={() => setModal({ kind: 'pass', card: c })}><QrCode size={15} className="inline mr-1" aria-hidden />{L('show_pass')}</Btn>
                        <Btn kind="ghost" onClick={() => setModal({ kind: 'claim', card: c })}><Printer size={15} className="inline mr-1" aria-hidden />{L('print_claim')}</Btn>
                        <Btn kind="ghost" className="col-span-2" onClick={() => setModal({ kind: 'photos', card: c })}>{L('photos')}</Btn>
                      </div>
                    </TaskCard>
                  ))}
                </Panel>
              ) : null}

              {v.holding.length ? (
                <Panel title={`${L('holding')} (${v.holding.length})`}>
                  {v.holding.map(c => (
                    <TaskCard key={c.id} c={c} L={L} SL={SL} now={now} me={me}>
                      {!c.pickup ? <Btn className="w-full" onClick={() => void cmd.run('guest.returned', { session_id: c.id })}>{L('guest_returned')}</Btn> : null}
                    </TaskCard>
                  ))}
                </Panel>
              ) : null}

              {v.keys_with_me.length ? (
                <Panel title={`${L('keys_with_me')} (${v.keys_with_me.length})`}>
                  <p className="text-sm">{v.keys_with_me.map(k => k.tag_code || '—').join(', ')}</p>
                </Panel>
              ) : null}
            </>
          )}
        </div>
      </Gate>

      {askEl}
      {modal?.kind === 'checkin' && v ? <CheckinModal v={v} outletId={outletId} userId={me || ''} onClose={close} onDone={(sid, paired) => { live.reload(); setModal({ kind: 'issued', data: { sid, paired } }); }} /> : null}
      {modal?.kind === 'issued' && modal.data ? <IssuedModal outletId={outletId} sessionId={modal.data.sid} paired={!!modal.data.paired} onClose={close} /> : null}
      {modal?.kind === 'pass' && modal.card ? <IssuedModal outletId={outletId} sessionId={modal.card.id} onClose={close} start="qr" /> : null}
      {modal?.kind === 'claim' && modal.card ? <IssuedModal outletId={outletId} sessionId={modal.card.id} onClose={close} start="claim" /> : null}
      {modal?.kind === 'park' && modal.card && v ? <ParkModal v={v} card={modal.card} outletId={outletId} mode="park" onClose={close} onDone={() => { close(); live.reload(); }} /> : null}
      {modal?.kind === 'hold' && modal.card && v ? <ParkModal v={v} card={modal.card} outletId={outletId} mode="hold" onClose={close} onDone={() => { close(); live.reload(); }} /> : null}
      {modal?.kind === 'ready' && modal.card && v ? <ReadyModal v={v} card={modal.card} outletId={outletId} onClose={close} onDone={() => { close(); live.reload(); }} /> : null}
      {modal?.kind === 'handover' && modal.card ? <HandoverModal card={modal.card} outletId={outletId} isHead={!!ctx?.user.head} onClose={close} onDone={() => { close(); live.reload(); }} /> : null}
      {modal?.kind === 'photos' && modal.card ? <PhotoModal outletId={outletId} sessionId={modal.card.id} tag={modal.card.tag_code} onClose={close} /> : null}
      {modal?.kind === 'problem' && v ? <ProblemModal v={v} outletId={outletId} onClose={close} /> : null}
      {modal?.kind === 'scan' ? (
        // The scanner calls onClose after a successful read too — close only the
        // scanner, never the car dialog the read just opened.
        <BatchTagScanner onClose={() => setModal(m => (m?.kind === 'scan' ? null : m))} title="Find a car by its key tag" placeholder="Tag number, e.g. 14"
          hint="Scan the QR/barcode on the key tag, or type the number and press Enter." onRead={(text) => {
          const c = findByTag(text);
          if (!c) return 'No car here with that tag.';
          setModal({ kind: 'car', card: c });
          return null;
        }} />
      ) : null}
      {modal?.kind === 'car' && modal.card ? (
        <Modal title={`Tag ${modal.card.tag_code}`} onClose={close}>
          <TaskCard c={modal.card} L={L} SL={SL} now={now} me={me} />
          <div className="grid grid-cols-2 gap-2 mt-2">
            <Btn kind="ghost" onClick={() => setModal({ kind: 'pass', card: modal.card })}>{L('show_pass')}</Btn>
            <Btn kind="ghost" onClick={() => setModal({ kind: 'claim', card: modal.card })}>{L('print_claim')}</Btn>
            <Btn kind="ghost" className="col-span-2" onClick={() => setModal({ kind: 'photos', card: modal.card })}>{L('photos')}</Btn>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

/**
 * A guest tapped this attendant's card (DESIGN.md §6c). Their phone shows a
 * number; the attendant checks it matches, picks the car (newest check-in
 * first) and gives the pass. Nothing is granted without this tap.
 */
function TapPanel({ v, cmd, L }: { v: View; cmd: ReturnType<typeof useCmd>; L: (k: string) => string }) {
  const cars = v.handoff.cars;
  const [pick, setPick] = useState<Record<string, string>>({});
  return (
    <div className="space-y-2">
      {v.handoff.taps.map(t => {
        const chosen = pick[t.id] || cars[0]?.id || '';
        return (
          <Panel key={t.id} className="border-[#af4408] ring-2 ring-[#f5b48a]">
            <div className="flex items-center justify-between gap-3">
              <div><div className="font-bold">{L('tap_title')}</div><div className="text-xs text-[#8B7355]">{L('tap_check')}</div></div>
              <div className="text-5xl font-extrabold tabular-nums" aria-label={`${L('tap_check')} ${t.number}`}>{t.number}</div>
            </div>
            {cars.length ? (
              <div className="mt-2 space-y-1">
                <div className="text-xs font-semibold text-[#6B5744]">{L('which_car')}</div>
                {cars.map(c => (
                  <label key={c.id} className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm ${chosen === c.id ? 'border-[#af4408] bg-[#FFF1E3]' : 'border-[#E8D5C4] bg-white'}`}>
                    <input type="radio" name={`tap-${t.id}`} checked={chosen === c.id} onChange={() => setPick(p => ({ ...p, [t.id]: c.id }))} />
                    <span className="font-extrabold">{c.tag_code || c.ticket_no}</span>
                    <span className="min-w-0 truncate">{c.plate} · {[c.colour, c.make, c.model].filter(Boolean).join(' ')}</span>
                    {c.passes ? <span className="ml-auto shrink-0 text-[11px] text-[#8B7355]">{L('has_pass')}</span> : null}
                  </label>
                ))}
              </div>
            ) : <InfoNote>{L('tap_no_car')}</InfoNote>}
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Btn big kind="ok" disabled={!chosen || cmd.busy} onClick={() => void cmd.run('handoff.confirm', { tap_id: t.id, session_id: chosen })}>{L('give_pass')} {t.number}</Btn>
              <Btn big kind="ghost" disabled={cmd.busy} onClick={() => void cmd.run('handoff.reject', { tap_id: t.id })}>{L('not_them')}</Btn>
            </div>
          </Panel>
        );
      })}
    </div>
  );
}

function TaskCard({ c, children, extra, L, SL, now, me }: { c: Card; children?: React.ReactNode; extra?: React.ReactNode; L: (k: string) => string; SL: (s: string) => string; now: number; me?: string }) {
  void L;
  return (
    <div className="rounded-xl border border-[#E8D5C4] bg-[#FFFDF9] p-3 mb-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-3xl font-extrabold tracking-wide text-[#2D1B0E] leading-none">{c.tag_code || c.ticket_no || '—'}</div>
          <div className="text-sm font-semibold mt-1">{c.plate}</div>
          <div className="text-xs text-[#6B5744]">{[c.colour, c.make, c.model].filter(Boolean).join(' ')}</div>
        </div>
        <div className="text-right space-y-1">
          <StateChip state={c.pickup && ['ASSIGNED', 'IN_PROGRESS'].includes(c.pickup.state) ? c.pickup.state : c.state} />
          <div className="sr-only">{SL(c.state)}</div>
          {extra}
          {c.pickup?.guest_outside_at ? <div className="text-[11px] font-bold text-red-700">Guest outside · {ago(c.pickup.guest_outside_at, now)}</div> : null}
        </div>
      </div>
      <div className="mt-2 text-xs text-[#6B5744] space-y-0.5">
        {c.zone_name ? <div>Car: <b>{c.zone_name}{c.spot ? ` · ${c.spot}` : ''}</b></div> : null}
        <div>Keys: <b>{c.key_custodian_id && c.key_custodian_id === me ? 'with you' : c.key_desc}</b></div>
      </div>
      {children ? <div className="mt-2">{children}</div> : null}
    </div>
  );
}

function CheckinModal({ v, outletId, userId, onClose, onDone }: { v: View; outletId: string; userId: string; onClose: () => void; onDone: (sid: string, paired: boolean) => void }) {
  const draftKey = `fnb:valet:draft:${userId}`;
  const [mode, setMode] = useState<'code' | 'manual'>('manual');
  const [f, setF] = useState({ plate: '', make: '', model: '', colour: '', guest_name: '', guest_mobile: '', tag_code: '', ticket_no: '', notes: '', duplicate_plate_note: '' });
  const [pairing, setPairing] = useState('');
  const [pending, setPending] = useState<null | Record<string, string>>(null);
  const [dup, setDup] = useState(false);
  const [scan, setScan] = useState(false);
  const cmd = useCmd(outletId);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(draftKey);
      if (raw) { const d = JSON.parse(raw); if (Date.now() - d.savedAt < DRAFT_TTL) setF(x => ({ ...x, ...d.data })); else localStorage.removeItem(draftKey); }
    } catch { /* ignore */ }
  }, [draftKey]);
  useEffect(() => {
    // Draft holds vehicle fields + tag only — never the guest's name or number.
    try { localStorage.setItem(draftKey, JSON.stringify({ savedAt: Date.now(), data: { plate: f.plate, make: f.make, model: f.model, colour: f.colour, tag_code: f.tag_code, ticket_no: f.ticket_no } })); } catch { /* ignore */ }
  }, [draftKey, f.plate, f.make, f.model, f.colour, f.tag_code, f.ticket_no]);
  const req = v.config.required;
  // Paper outlets: the car may carry a paper ticket, a key tag, or both — the
  // server needs at least one and checks the ticket against the registered books.
  const paper = v.config.paper === true;
  const submit = async () => {
    const body: Record<string, unknown> = { ...f };
    if (pending) body.request_id = pending.id;
    const r = await cmd.run<{ session_id: string; paired?: boolean }>('checkin.create', body);
    if (r?.session_id) { try { localStorage.removeItem(draftKey); } catch { /* ignore */ } onDone(r.session_id, !!r.paired); }
  };
  useEffect(() => { if (/already on an active car/.test(cmd.err)) setDup(true); }, [cmd.err]);
  const findCode = async () => {
    const r = await cmd.run<{ request: Record<string, string> }>('checkin.find', { code: pairing });
    if (r?.request) { setPending(r.request); setF(x => ({ ...x, plate: r.request.plate || x.plate, make: r.request.make || x.make, model: r.request.model || x.model, colour: r.request.colour || x.colour })); }
  };
  const inp = (k: keyof typeof f, label: string, required?: boolean, extra: Record<string, unknown> = {}) => (
    <Field label={`${label}${required ? ' *' : ''}`}><input className={inputCls} value={f[k]} onChange={e => setF({ ...f, [k]: e.target.value })} {...extra} /></Field>
  );
  return (
    <Modal title="New check-in" onClose={onClose} wide>
      <div className="flex gap-2 mb-3">
        <Btn kind={mode === 'manual' ? 'primary' : 'ghost'} onClick={() => { setMode('manual'); setPending(null); }}>Staff check-in</Btn>
        <Btn kind={mode === 'code' ? 'primary' : 'ghost'} onClick={() => setMode('code')}>Guest has a code</Btn>
      </div>
      <ErrorNote message={cmd.err} />
      {mode === 'code' && !pending ? (
        // A form, so the phone keyboard's "Go" / Enter finds the guest too.
        <form className="space-y-2" onSubmit={e => { e.preventDefault(); if (pairing.length === 6 && !cmd.busy) void findCode(); }}>
          <Field label="Guest's 6-digit pairing code"><input className={`${inputCls} text-2xl tracking-[.3em] font-bold`} inputMode="numeric" enterKeyHint="go" maxLength={6} value={pairing} onChange={e => setPairing(e.target.value.replace(/\D/g, ''))} autoFocus /></Field>
          <Btn type="submit" big className="w-full" disabled={pairing.length !== 6 || cmd.busy}>Find guest</Btn>
        </form>
      ) : pending?.source === 'paper_claim' ? (
        <PaperClaimConfirm outletId={outletId} request={pending} onDone={ok => { if (ok) onClose(); }} />
      ) : (
        <div className="space-y-2">
          {pending ? <InfoNote>{pending.source === 'paper'
            ? <>Paper ticket <b>{pending.ticket_no}</b> — check the guest&apos;s stub shows this number and the car matches, then check in.</>
            : <>Guest check-in found (phone). Check the car matches, then put a key tag on the keys.</>}{pending.has_mobile ? ' Guest left a mobile number.' : ''}</InfoNote> : null}
          <div className="grid grid-cols-2 gap-2">
            <div className="col-span-2 flex gap-2 items-end">
              <div className="flex-1">{inp('tag_code', paper ? 'Key tag number (or use the paper ticket)' : 'Key tag number', !paper, { inputMode: 'text', autoCapitalize: 'characters', className: `${inputCls} text-xl font-bold` })}</div>
              <Btn kind="ghost" onClick={() => setScan(true)}><ScanLine size={16} aria-hidden /><span className="sr-only">Scan tag</span></Btn>
            </div>
            {paper && pending?.source !== 'paper' ? <div className="col-span-2">{inp('ticket_no', 'Paper ticket number (from the ticket book)', false, { autoCapitalize: 'characters', maxLength: 12 })}</div> : null}
            {inp('plate', 'Number plate', req.plate, { autoCapitalize: 'characters', maxLength: 16 })}
            {inp('colour', 'Colour', req.colour)}
            {inp('make', 'Make', req.make)}
            {inp('model', 'Model', req.model)}
            {!pending ? inp('guest_name', 'Guest name', req.guest_name) : null}
            {!pending ? inp('guest_mobile', 'Guest mobile', req.guest_mobile, { inputMode: 'tel' }) : null}
            <div className="col-span-2">{inp('notes', 'Notes (existing damage, valuables…)')}</div>
            {dup ? <div className="col-span-2">{inp('duplicate_plate_note', 'This plate is already on an active car — why is this a second check-in?', true)}</div> : null}
          </div>
          <Btn big className="w-full" onClick={() => void submit()} disabled={cmd.busy}>Check in</Btn>
          <p className="text-[11px] text-[#8B7355]">The car and tag details (not the guest&apos;s name or number) are kept on this phone for 30 minutes in case the screen closes.</p>
        </div>
      )}
      {scan ? <BatchTagScanner onClose={() => setScan(false)} title="Scan the key tag" placeholder="Tag number" hint="Scan or type the tag you are putting on the keys."
        onRead={(t) => { setF(x => ({ ...x, tag_code: t.trim().slice(0, 12) })); setScan(false); return null; }} /> : null}
    </Modal>
  );
}

function ParkModal({ v, card, outletId, mode, onClose, onDone }: { v: View; card: Card; outletId: string; mode: 'park' | 'hold'; onClose: () => void; onDone: () => void }) {
  const zones = v.zones.filter(z => z.kind === (mode === 'park' ? 'parking' : 'holding'));
  const lot = v.zones.filter(z => z.kind === 'parking');
  const [zone, setZone] = useState(zones[0]?.id || '');
  const [spot, setSpot] = useState('');
  const [keyLoc, setKeyLoc] = useState<'rack' | 'attendant' | 'desk'>('rack');
  const [rack, setRack] = useState('');
  const [hook, setHook] = useState('');
  const [exc, setExc] = useState('');
  const [override, setOverride] = useState('');
  const [backToLot, setBackToLot] = useState(false);
  const cmd = useCmd(outletId);
  const usingLot = mode === 'park' || backToLot;
  const list = usingLot ? lot : zones;
  const needsPhotoReason = mode === 'park' && v.config.photos_min > 0;
  const save = async () => {
    const body = { session_id: card.id, version: card.version, zone_id: zone, spot, key_location: keyLoc, key_rack: rack, key_hook: hook, photo_exception: exc, override_reason: override };
    const r = await cmd.run(usingLot ? 'park.confirm' : 'hold.confirm', body);
    if (r) onDone();
  };
  return (
    <Modal title={`${mode === 'park' ? 'Set parking spot' : 'Confirm holding spot'} — tag ${card.tag_code}`} onClose={onClose}>
      <ErrorNote message={cmd.err} />
      <div className="space-y-3">
        {mode === 'hold' ? (
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={backToLot} onChange={e => { setBackToLot(e.target.checked); setZone((e.target.checked ? lot : zones)[0]?.id || ''); }} />Holding is full — park back in the main lot instead</label>
        ) : null}
        <div>
          <div className="text-xs font-semibold text-[#6B5744] mb-1">Zone</div>
          <div className="flex flex-wrap gap-2">
            {list.map(z => (
              <button key={z.id} type="button" onClick={() => setZone(z.id)} aria-pressed={zone === z.id}
                className={`min-h-[48px] rounded-xl border px-4 font-bold ${zone === z.id ? 'bg-[#af4408] text-white border-[#af4408]' : 'bg-white border-[#E8D5C4]'}`}>{z.name}</button>
            ))}
            {!list.length ? <InfoNote>No {usingLot ? 'parking' : 'holding'} zone is set up. Ask the Valet Head (Valet Settings → Zones).</InfoNote> : null}
          </div>
        </div>
        <Field label="Spot / landmark"><input className={inputCls} value={spot} onChange={e => setSpot(e.target.value)} placeholder="e.g. B2-14, near the pillar" maxLength={40} /></Field>
        <div>
          <div className="text-xs font-semibold text-[#6B5744] mb-1">Keys are…</div>
          <div className="grid grid-cols-3 gap-2">
            {([['rack', 'On the rack'], ['attendant', 'With me'], ['desk', 'At the desk']] as const).map(([k, l]) => (
              <button key={k} type="button" onClick={() => setKeyLoc(k)} aria-pressed={keyLoc === k}
                className={`min-h-[48px] rounded-xl border font-bold text-sm ${keyLoc === k ? 'bg-[#2D1B0E] text-white border-[#2D1B0E]' : 'bg-white border-[#E8D5C4]'}`}>{l}</button>
            ))}
          </div>
        </div>
        {keyLoc === 'rack' ? (
          <div className="grid grid-cols-2 gap-2">
            <Field label="Rack"><input className={inputCls} value={rack} onChange={e => setRack(e.target.value)} maxLength={20} /></Field>
            <Field label="Hook"><input className={inputCls} value={hook} onChange={e => setHook(e.target.value)} maxLength={20} /></Field>
          </div>
        ) : null}
        {needsPhotoReason ? <Field label={`Photos skipped — why? (outlet asks for ${v.config.photos_min})`}><input className={inputCls} value={exc} onChange={e => setExc(e.target.value)} maxLength={200} /></Field> : null}
        {mode === 'hold' && !backToLot ? <Field label="If holding is full: why must it stay near the gate? (optional)"><input className={inputCls} value={override} onChange={e => setOverride(e.target.value)} maxLength={200} /></Field> : null}
        <Btn big className="w-full" onClick={() => void save()} disabled={!zone || cmd.busy}>Save</Btn>
      </div>
    </Modal>
  );
}

function ReadyModal({ v, card, outletId, onClose, onDone }: { v: View; card: Card; outletId: string; onClose: () => void; onDone: () => void }) {
  const gates = v.zones.filter(z => z.kind === 'gate');
  const [gate, setGate] = useState(gates[0]?.id || '');
  const [override, setOverride] = useState('');
  const cmd = useCmd(outletId);
  const full = /gate is full/i.test(cmd.err);
  const go = async () => { const r = await cmd.run('fetch.ready', { pickup_id: card.pickup!.id, version: card.pickup!.version, gate_zone_id: gate, override_reason: override }); if (r) onDone(); };
  return (
    <Modal title={`Car ${card.tag_code} at the gate`} onClose={onClose}>
      <ErrorNote message={cmd.err} />
      {gates.length > 1 ? (
        <div className="flex flex-wrap gap-2 mb-2">
          {gates.map(g => <button key={g.id} type="button" onClick={() => setGate(g.id)} aria-pressed={gate === g.id}
            className={`min-h-[48px] rounded-xl border px-4 font-bold ${gate === g.id ? 'bg-[#af4408] text-white' : 'bg-white border-[#E8D5C4]'}`}>{g.name}</button>)}
        </div>
      ) : <p className="text-sm text-[#6B5744] mb-2">{gates[0]?.name || v.config.gate_label}</p>}
      {full ? <Field label="Why must this car wait at a full gate?"><input className={inputCls} value={override} onChange={e => setOverride(e.target.value)} maxLength={200} /></Field> : null}
      <Btn big kind="ok" className="w-full mt-2" onClick={() => void go()} disabled={cmd.busy || (full && override.trim().length < 5)}>Mark ready</Btn>
      <p className="mt-2 text-[11px] text-[#8B7355]">The guest gets {v.config.dwell_minutes} minutes at the gate before you are asked to move the car to holding.</p>
    </Modal>
  );
}

function ProblemModal({ v, outletId, onClose }: { v: View; outletId: string; onClose: () => void }) {
  const [kind, setKind] = useState('damage');
  const [desc, setDesc] = useState('');
  const [tag, setTag] = useState('');
  const [done, setDone] = useState(false);
  const cmd = useCmd(outletId);
  const all = [...v.my_tasks, ...v.unparked, ...v.at_gate, ...v.holding, ...v.parked];
  const car = tag.trim() ? all.find(c => normTagCode(c.tag_code) === normTagCode(tag)) : undefined;
  return (
    <Modal title="Report a problem" onClose={onClose}>
      <ErrorNote message={cmd.err} />
      {done ? <><InfoNote>Reported. The Valet Head can see it now.</InfoNote><Btn className="w-full mt-2" onClick={onClose}>Close</Btn></> : (
        <div className="space-y-2">
          <Field label="What kind?"><select className={inputCls} value={kind} onChange={e => setKind(e.target.value)}>
            <option value="damage">Damage</option><option value="lost_key">Lost key</option><option value="complaint">Guest complaint</option>
            <option value="dispute">Disputed claim</option><option value="delay">Delay</option><option value="other">Other</option></select></Field>
          <Field label="Tag (optional)" hint={tag && !car ? 'No car with that tag here — it will be reported without a car.' : car ? `Car: ${car.plate}` : undefined}><input className={inputCls} value={tag} onChange={e => setTag(e.target.value)} /></Field>
          <Field label="What happened?"><textarea className={inputCls} rows={4} value={desc} onChange={e => setDesc(e.target.value)} maxLength={1000} /></Field>
          <Btn big className="w-full" disabled={cmd.busy || desc.trim().length < 5} onClick={async () => {
            const r = await cmd.run('incident.create', { kind, description: desc, session_id: car?.id });
            if (r) setDone(true);
          }}>Report</Btn>
        </div>
      )}
    </Modal>
  );
}
