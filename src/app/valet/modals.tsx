'use client';

/**
 * VALET dialogs shared by the Attendant screen and the Head Dashboard (App
 * Router page files may export only their page, so shared UI lives here).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Printer, QrCode, ScanLine } from 'lucide-react';
import BatchTagScanner from '@/components/BatchTagScanner';
import { Btn, Field, inputCls, ErrorNote, InfoNote, Modal, QrImage, useCmd, hhmm } from './ui';

export interface HandoverCard { id: string; version: number; tag_code: string }

export function IssuedModal({ outletId, sessionId, onClose, start }: { outletId: string; sessionId: string; onClose: () => void; start?: 'qr' | 'claim' }) {
  const cmd = useCmd(outletId);
  const [link, setLink] = useState<string>('');
  const [claim, setClaim] = useState<null | Record<string, string>>(null);
  const { run } = cmd;
  const showQr = useCallback(async () => { const r = await run<{ path: string }>('pass.link', { session_id: sessionId }); if (r?.path) setLink(`${window.location.origin}${r.path}`); }, [run, sessionId]);
  const doClaim = useCallback(async () => { const r = await run<Record<string, string>>('claim.issue', { session_id: sessionId }); if (r) setClaim(r); }, [run, sessionId]);
  // One-shot: issuing a pass link or a claim code has a side effect (the old
  // one is revoked), so it must run once per opening, never on a re-render.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (start === 'qr') void showQr();
    if (start === 'claim') void doClaim();
  }, [start, showQr, doClaim]);
  return (
    <Modal title="Give the guest their pass" onClose={onClose}>
      <ErrorNote message={cmd.err} />
      {!link && !claim ? (
        <div className="space-y-2">
          <p className="text-sm text-[#6B5744]">Checked in. How will the guest get their car back?</p>
          <Btn big className="w-full" onClick={() => void showQr()}><QrCode size={18} className="inline mr-1.5" aria-hidden />Guest scans a QR on my phone</Btn>
          <Btn big kind="ghost" className="w-full" onClick={() => void doClaim()}><Printer size={18} className="inline mr-1.5" aria-hidden />No phone — print a claim receipt</Btn>
          <Btn kind="ghost" className="w-full" onClick={onClose}>Skip for now</Btn>
        </div>
      ) : null}
      {link ? (
        <div className="text-center space-y-2">
          <div className="flex justify-center"><QrImage text={link} size={260} label="Guest pass activation QR — show to the guest" /></div>
          <p className="text-sm text-[#6B5744]">Ask the guest to scan this with their phone camera. It works once and expires in 15 minutes.</p>
          <Btn className="w-full" onClick={onClose}>Done</Btn>
        </div>
      ) : null}
      {claim ? (
        <div>
          <div id="valet-claim-receipt" className="mx-auto w-[280px] rounded-lg border border-dashed border-[#2D1B0E] p-3 text-center text-[#2D1B0E] bg-white">
            <div className="text-sm font-bold">{claim.venue_name}</div>
            <div className="text-[11px]">Valet claim receipt</div>
            <div className="mt-2 text-xs">Tag</div>
            <div className="text-4xl font-extrabold">{claim.tag_code || claim.ticket_no}</div>
            <div className="mt-2 text-xs">Claim code — keep this private</div>
            <div className="text-2xl font-mono font-bold tracking-widest">{claim.code}</div>
            <div className="mt-2 text-[11px]">Car ending {claim.plate_tail} · in {hhmm(claim.checked_in_at)}</div>
            <div className="text-[11px]">Show this at {claim.gate} to collect your car.</div>
          </div>
          <p className="mt-2 text-[11px] text-[#8B7355] text-center">Printing a new receipt cancels the old one. The code is shown only now.</p>
          <div className="mt-2 flex gap-2">
            <Btn className="flex-1" onClick={() => {
              const el = document.getElementById('valet-claim-receipt');
              const w = window.open('', 'valet-receipt', 'width=360,height=520');
              if (el && w) {
                // DOM copy, never document.write: the receipt node is cloned as
                // nodes, so no string is ever parsed as markup.
                const d = w.document;
                d.title = 'Claim receipt';
                const st = d.createElement('style');
                st.textContent = 'body{font-family:sans-serif;margin:0;padding:8px;text-align:center}@page{size:80mm auto;margin:4mm}';
                d.head.appendChild(st);
                d.body.appendChild(d.importNode(el, true));
                w.focus(); w.print();
              } else window.print();
            }}><Printer size={15} className="inline mr-1" aria-hidden />Print</Btn>
            <Btn kind="ghost" className="flex-1" onClick={onClose}>Done</Btn>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

const RECOVERY = [
  ['known_guest_vouched_by_manager', 'Known guest — manager vouched'], ['bill_or_reservation_match', 'Bill / reservation matched'],
  ['vehicle_documents_shown', 'Vehicle papers shown'], ['ownership_questions_answered', 'Answered ownership questions'], ['other_documented', 'Other (write below)'],
] as const;

export function HandoverModal({ card, outletId, isHead, onClose, onDone }: { card: HandoverCard; outletId: string; isHead: boolean; onClose: () => void; onDone: () => void }) {
  const [tag, setTag] = useState('');
  const [method, setMethod] = useState<'guest_code' | 'claim_code' | 'head_recovery'>('guest_code');
  const [code, setCode] = useState('');
  const [reason, setReason] = useState('');
  const [rm, setRm] = useState('');
  const [scan, setScan] = useState(false);
  const cmd = useCmd(outletId);
  const locked = /Valet Head must complete/i.test(cmd.err);
  const go = async () => {
    const r = await cmd.run('handover', { session_id: card.id, version: card.version, tag_code: tag, method, code, reason, recovery_method: rm });
    if (r) onDone();
  };
  const tabs = useMemo(() => ([['guest_code', 'Code on guest phone'], ['claim_code', 'Paper claim code'], ...(isHead ? [['head_recovery', 'Head recovery']] : [])] as [string, string][]), [isHead]);
  return (
    <Modal title={`Hand over tag ${card.tag_code}`} onClose={onClose}>
      <ErrorNote message={cmd.err} />
      {locked && !isHead ? <InfoNote>Call the Valet Head — only they can finish this handover now.</InfoNote> : null}
      <div className="space-y-3">
        <div className="flex gap-2 items-end">
          <Field label="Tag on the keys in your hand"><input className={`${inputCls} text-xl font-bold`} value={tag} onChange={e => setTag(e.target.value)} autoFocus autoCapitalize="characters" /></Field>
          <Btn kind="ghost" onClick={() => setScan(true)}><ScanLine size={16} aria-hidden /><span className="sr-only">Scan tag</span></Btn>
        </div>
        <div className="flex flex-wrap gap-2">
          {tabs.map(([k, l]) => <button key={k} type="button" onClick={() => setMethod(k as typeof method)} aria-pressed={method === k}
            className={`min-h-[44px] rounded-xl border px-3 text-sm font-bold ${method === k ? 'bg-[#2D1B0E] text-white' : 'bg-white border-[#E8D5C4]'}`}>{l}</button>)}
        </div>
        {method === 'guest_code' ? <Field label="6-digit code on the guest's pass"><input className={`${inputCls} text-2xl tracking-[.3em] font-bold`} inputMode="numeric" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} /></Field> : null}
        {method === 'claim_code' ? <Field label="Code printed on the claim receipt"><input className={`${inputCls} text-xl font-mono tracking-widest`} maxLength={9} value={code} onChange={e => setCode(e.target.value.toUpperCase())} /></Field> : null}
        {method === 'head_recovery' ? (
          <>
            <Field label="How was the guest verified?"><select className={inputCls} value={rm} onChange={e => setRm(e.target.value)}>
              <option value="">Choose…</option>{RECOVERY.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <Field label="What happened (recorded)"><textarea className={inputCls} rows={3} value={reason} onChange={e => setReason(e.target.value)} maxLength={300} /></Field>
            <p className="text-[11px] text-[#8B7355]">Do not photograph ID cards. Write what you checked.</p>
          </>
        ) : null}
        <Btn big kind="ok" className="w-full" onClick={() => void go()} disabled={cmd.busy || !tag.trim()}>Hand over the car</Btn>
      </div>
      {scan ? <BatchTagScanner onClose={() => setScan(false)} onRead={(t) => { setTag(t.trim()); setScan(false); return null; }} /> : null}
    </Modal>
  );
}

