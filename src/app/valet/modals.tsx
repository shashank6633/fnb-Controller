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

export function IssuedModal({ outletId, sessionId, onClose, start, paired }: { outletId: string; sessionId: string; onClose: () => void; start?: 'qr' | 'claim'; paired?: boolean }) {
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
          {paired ? <InfoNote>Checked in. The guest&apos;s phone already shows their pass — nothing more to do. A claim receipt is only needed if their phone may die.</InfoNote>
            : <p className="text-sm text-[#6B5744]">Checked in. How will the guest get their car back?</p>}
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
      {scan ? <BatchTagScanner onClose={() => setScan(false)} title="Scan the key tag in your hand" placeholder="Tag number" hint="Scan or type the tag on the keys you are handing over."
        onRead={(t) => { setTag(t.trim()); setScan(false); return null; }} /> : null}
    </Modal>
  );
}


// ── Condition photos ───────────────────────────────────────────────────────

const POSITIONS: [string, string][] = [['front', 'Front'], ['rear', 'Rear'], ['left', 'Left side'], ['right', 'Right side'], ['interior', 'Inside'], ['damage', 'Damage close-up'], ['other', 'Other']];

/** Shrink on the phone before upload (max 1600 px, JPEG): faster on weak
 *  networks and well under the server's 2 MB cap. */
async function shrink(file: File): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise<Blob>((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('encode'))), 'image/jpeg', 0.82));
  } catch { return file; }   // older browsers: send as-is (the server still checks size + type)
}

function csrf(): string {
  const m = document.cookie.split('; ').find(c => c.startsWith('fnb_csrf='));
  return m ? decodeURIComponent(m.split('=')[1]) : '';
}

interface Photo { id: string; position: string; annotation: string; captured_by_name: string; captured_at: string; deleted: number }

export function PhotoStrip({ outletId, sessionId, reloadKey = 0 }: { outletId: string; sessionId: string; reloadKey?: number }) {
  const [list, setList] = useState<Photo[] | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`/api/valet/media?outlet=${encodeURIComponent(outletId)}&session=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
      .then(r => r.json()).then(j => { if (alive) setList(j.photos || []); }).catch(() => { if (alive) setList([]); });
    return () => { alive = false; };
  }, [outletId, sessionId, reloadKey]);
  if (!list) return <p className="text-xs text-[#8B7355]">Loading photos…</p>;
  if (!list.length) return <p className="text-xs text-[#8B7355]">No condition photos.</p>;
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {list.map(p => (
        <figure key={p.id} className="shrink-0 w-28">
          {p.deleted ? <div className="h-20 w-28 rounded bg-stone-200 text-[10px] flex items-center justify-center">removed (retention)</div> : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/api/valet/media?outlet=${encodeURIComponent(outletId)}&id=${encodeURIComponent(p.id)}`} alt={`${p.position} photo`} className="h-20 w-28 rounded object-cover border border-[#E8D5C4]" />
          )}
          <figcaption className="text-[10px] leading-tight mt-0.5"><b>{p.position}</b>{p.annotation ? ` — ${p.annotation}` : ''}<br />{p.captured_by_name}, {hhmm(p.captured_at)}</figcaption>
        </figure>
      ))}
    </div>
  );
}

export function PhotoModal({ outletId, sessionId, tag, onClose }: { outletId: string; sessionId: string; tag: string; onClose: () => void }) {
  const [position, setPosition] = useState('front');
  const [note, setNote] = useState('');
  const [pending, setPending] = useState<Blob | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [err, setErr] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const upload = useCallback((blob: Blob) => {
    setErr(''); setProgress(0); setPending(blob);
    const fd = new FormData();
    fd.append('outlet_id', outletId); fd.append('session_id', sessionId); fd.append('position', position); fd.append('annotation', note);
    fd.append('file', blob, 'photo.jpg');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/valet/media');
    xhr.setRequestHeader('X-CSRF-Token', csrf());
    xhr.upload.onprogress = e => { if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      setProgress(null);
      let j: { error?: string } = {};
      try { j = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) { setPending(null); setNote(''); setReloadKey(k => k + 1); }
      else setErr(j.error || `Upload failed (${xhr.status}).`);
    };
    xhr.onerror = () => { setProgress(null); setErr('No connection — the photo is kept here. Tap Retry.'); };
    xhr.send(fd);
  }, [outletId, sessionId, position, note]);
  return (
    <Modal title={`Condition photos — tag ${tag}`} onClose={onClose} wide>
      <div className="space-y-3">
        <PhotoStrip outletId={outletId} sessionId={sessionId} reloadKey={reloadKey} />
        <div className="flex flex-wrap gap-2">
          {POSITIONS.map(([k, l]) => (
            <button key={k} type="button" onClick={() => setPosition(k)} aria-pressed={position === k}
              className={`min-h-[44px] rounded-xl border px-3 text-sm font-bold ${position === k ? 'bg-[#2D1B0E] text-white' : 'bg-white border-[#E8D5C4]'}`}>{l}</button>
          ))}
        </div>
        <Field label="Existing damage / note (optional)"><input className={inputCls} value={note} onChange={e => setNote(e.target.value)} maxLength={300} placeholder="e.g. dent on rear bumper" /></Field>
        <ErrorNote message={err} />
        {progress !== null ? (
          <div className="h-3 w-full rounded bg-[#F0E4D6]" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-3 rounded bg-[#af4408]" style={{ width: `${progress}%` }} />
          </div>
        ) : null}
        <div className="flex gap-2 flex-wrap">
          <label className="inline-flex min-h-[52px] cursor-pointer items-center rounded-xl bg-[#af4408] px-4 font-bold text-white">
            Take / choose photo
            <input type="file" accept="image/*" capture="environment" className="sr-only"
              onChange={async e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload(await shrink(f)); }} />
          </label>
          {pending && err ? <Btn big kind="ghost" onClick={() => upload(pending)}>Retry</Btn> : null}
          <Btn big kind="ghost" onClick={onClose}>Done</Btn>
        </div>
        <p className="text-[11px] text-[#8B7355]">Up to 6 photos per car. Photos are private to the valet team and removed after the outlet&apos;s retention period.</p>
      </div>
    </Modal>
  );
}

// ── Paper ticket claim: staff look at the guest's physical stub ─────────────

export function PaperClaimConfirm({ outletId, request, onDone }: {
  outletId: string; request: Record<string, string>; onDone: (ok: boolean) => void;
}) {
  const [checked, setChecked] = useState(false);
  const cmd = useCmd(outletId);
  return (
    <div className="space-y-2">
      <InfoNote>
        Paper ticket <b>{request.ticket_no}</b> — this car is already parked{request.claim_tag ? <> (tag <b>{request.claim_tag}</b>)</> : null}.
        A ticket number can be guessed: <b>look at the guest&apos;s paper stub</b> before giving them the pass.
      </InfoNote>
      <ErrorNote message={cmd.err} />
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={checked} onChange={e => setChecked(e.target.checked)} />
        I have checked the guest&apos;s paper stub and it shows ticket {request.ticket_no}.</label>
      <Btn big kind="ok" className="w-full" disabled={!checked || cmd.busy} onClick={async () => {
        const r = await cmd.run('paper.claim_confirm', { request_id: request.id, stub_checked: true });
        onDone(!!r);
      }}>Stub matches — give the guest their pass</Btn>
    </div>
  );
}
