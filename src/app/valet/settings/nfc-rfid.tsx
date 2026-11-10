'use client';

/**
 * VALET SETTINGS — NFC cards / key-tag stickers, and optional RFID readers
 * (docs/valet/DESIGN.md §6b). The Valet Head manages key-tag links and EPCs;
 * reader registration, tokens and the simulator are the owner/admin's (the
 * API enforces both — hiding buttons here is a courtesy, not the gate).
 */
import { useMemo, useState } from 'react';
import { Copy, Download, Nfc } from 'lucide-react';
import { Panel, Btn, Field, inputCls, ErrorNote, InfoNote, Modal, valetCmd, type AskOptions } from '../ui';
import { useOrigin, useWebNfc, writeUrl } from '../nfc';

export interface NfcRfidData {
  outlet: { id: string; name: string }; config: Record<string, unknown> & { paper?: { enabled?: boolean }; rfid?: { mode?: string } };
  entry_path: string; can_admin: boolean;
  zones: { id: string; name: string; kind: string; is_active: number }[];
  tags: { id: string; code: string; status: string; on_car: string | null; nfc_ref: string | null; nfc_issued_at: string | null; rfid_epc: string | null }[];
  handoff_cards: { user_id: string; name: string; ref: string | null; created_at: string | null; path: string | null }[];
  rfid: {
    readers: { id: string; name: string; zone_name: string | null; enabled: number; health: string; last_seen_at: string | null; events_accepted: number; events_rejected: number }[];
    reads: { received_at: string; observed_at: string; source: string; event_id: string; epc: string; antenna: string; status: string; reader_name: string; tag_code: string | null }[];
  };
}
type Run = (cmd: string, body?: Record<string, unknown>, ok?: string) => Promise<boolean>;
type Ask = (o: AskOptions) => Promise<string | null>;

const keyPath = (ref: string) => `/valet/attendant?nfc=${encodeURIComponent(ref)}`;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const HEALTH: Record<string, string> = { ok: 'Heard recently', quiet: 'Quiet — not heard for 5+ min', never: 'Never heard from', disabled: 'Disabled' };
const VERDICT: Record<string, string> = {
  accepted: 'accepted (observation)', duplicate: 'duplicate — ignored', stale: 'too old — refused', future: 'clock ahead — refused',
  replay: 'repeat of an earlier read — refused', unknown_tag: 'EPC not on any tag', invalid: 'malformed',
};

function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return <button type="button" className="inline-flex items-center gap-1 text-xs font-semibold text-[#af4408]" onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}>
    <Copy size={12} aria-hidden />{done ? 'Copied' : 'Copy'}</button>;
}

function WriteBtn({ url, can, onMsg }: { url: string; can: boolean; onMsg: (m: { kind: 'info' | 'error'; text: string }) => void }) {
  if (!can) return null;
  return <button type="button" className="inline-flex items-center gap-1 text-xs font-semibold text-[#af4408]" onClick={async () => {
    onMsg({ kind: 'info', text: 'Hold the sticker or card against the back of this phone…' });
    try { await writeUrl(url); onMsg({ kind: 'info', text: 'Written. Tap it with another phone to check it opens the right page.' }); }
    catch (e) { onMsg({ kind: 'error', text: (e as Error).message }); }
  }}><Nfc size={12} aria-hidden />Write to NFC</button>;
}

export function NfcPanel({ data, run, ask }: { data: NfcRfidData; run: Run; ask: Ask }) {
  const origin = useOrigin();
  const can = useWebNfc();
  const [tagId, setTagId] = useState('');
  const [msg, setMsg] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const tag = data.tags.find(t => t.id === tagId) || null;
  const linked = useMemo(() => data.tags.filter(t => t.nfc_ref), [data.tags]);
  const venue = data.entry_path ? `${origin}${data.entry_path}` : '';
  const csv = () => {
    const rows = [['tag', 'status', 'link_issued', 'url'], ...linked.map(t => [t.code, t.status, t.nfc_issued_at || '', `${origin}${keyPath(t.nfc_ref!)}`])];
    const text = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    a.download = `valet-key-tag-nfc-links-${data.outlet.name.replace(/\W+/g, '-')}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
  };
  return (
    <Panel title="NFC cards and key-tag stickers">
      <p className="text-xs text-[#8B7355] mb-2">
        An NFC card or sticker only holds a web link — nothing private. A phone opens it with an ordinary tap (iPhone and Android, no app).
        Key-tag stickers open only for signed-in valet staff of this outlet; anyone else sees the sign-in page. A car is still released only with the guest&apos;s code.
      </p>
      {msg?.kind === 'error' ? <ErrorNote message={msg.text} /> : msg ? <InfoNote>{msg.text}</InfoNote> : null}
      {!can ? <p className="text-xs text-[#8B7355] mb-2">This browser cannot write NFC (only Chrome on Android can). To write a card or sticker: open an NFC app (e.g. NXP TagWriter or NFC Tools) on any phone, add a <b>URL / link</b> record with the link below, write it, then lock the tag so it cannot be overwritten.</p> : null}
      <div className="space-y-1 text-sm mb-3">
        {venue ? <div><b>Venue check-in card / standee:</b> <span className="font-mono text-xs break-all">{venue}</span> <CopyBtn text={venue} /> <WriteBtn url={venue} can={can} onMsg={setMsg} /></div> : <div className="text-[#8B7355]">Switch valet on to get the venue check-in link.</div>}
        {venue && data.config.paper?.enabled ? <div><b>Table / bill-folder card (paper tickets):</b> <span className="font-mono text-xs break-all">{venue}&amp;paper=1</span> <CopyBtn text={`${venue}&paper=1`} /> <WriteBtn url={`${venue}&paper=1`} can={can} onMsg={setMsg} /></div> : null}
        <p className="text-xs text-[#8B7355]">Changing the venue link (&quot;New link&quot; in the QR panel above) makes every old card and QR stop working — rewrite them.</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-3 items-end">
        <Field label="Key tag">
          <select className={inputCls} value={tagId} onChange={e => { setTagId(e.target.value); setMsg(null); }}>
            <option value="">Choose a tag…</option>
            {data.tags.filter(t => t.status !== 'retired').map(t => <option key={t.id} value={t.id}>{t.code}{t.nfc_ref ? ' · NFC ✓' : ''}{t.rfid_epc ? ' · RFID ✓' : ''}{t.status !== 'available' && t.status !== 'in_use' ? ` (${t.status})` : ''}</option>)}
          </select>
        </Field>
        {tag ? (
          <div className="sm:col-span-2 flex flex-wrap items-center gap-2 text-sm">
            {tag.nfc_ref ? <>
              <span>Link given {when(tag.nfc_issued_at)}</span>
              <CopyBtn text={`${origin}${keyPath(tag.nfc_ref)}`} />
              <WriteBtn url={`${origin}${keyPath(tag.nfc_ref)}`} can={can} onMsg={setMsg} />
              <Btn kind="ghost" onClick={async () => { if (await ask({ title: `Give tag ${tag.code} a new link? The old sticker stops working — write the new link to a sticker.`, confirmText: 'New link' }) !== null) void run('tag.nfc_issue', { tag_id: tag.id }, `Tag ${tag.code} has a new link.`); }}>New link</Btn>
              <Btn kind="ghost" onClick={async () => { if (await ask({ title: `Remove tag ${tag.code}'s NFC link? Its sticker stops working.`, confirmText: 'Remove', danger: true }) !== null) void run('tag.nfc_clear', { tag_id: tag.id }, 'Link removed.'); }}>Remove link</Btn>
            </> : <Btn onClick={() => void run('tag.nfc_issue', { tag_id: tag.id }, `Tag ${tag.code} now has an NFC link — copy or write it.`)}>Give NFC link</Btn>}
          </div>
        ) : null}
      </div>
      {/* Keyed by tag + saved value, so switching tags starts from that tag's EPC. */}
      {tag ? <EpcForm key={`${tag.id}:${tag.rfid_epc || ''}`} tag={tag} run={run} /> : null}
      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs text-[#8B7355]">{linked.length} key tag{linked.length === 1 ? '' : 's'} with an NFC link</span>
        {linked.length ? <Btn kind="ghost" onClick={csv}><Download size={14} className="inline mr-1" aria-hidden />All links (CSV)</Btn> : null}
      </div>
      {/* Tap-to-pair cards (DESIGN.md §6c): one card per attendant. A guest taps
          it, both phones show the same number, the attendant confirms. */}
      <h3 className="mt-5 text-sm font-bold">Attendant tap cards</h3>
      <p className="text-xs text-[#8B7355] mb-2">
        Give each attendant one NFC card. After checking a car in, they hold the card out; the guest taps it with their phone, both phones show the
        same number, and the attendant presses <b>Give pass</b>. The card holds only a public link — a tap alone never gives a pass. Write it once,
        then lock it. Staff appear here once ticked under Staff for this outlet.
      </p>
      {data.handoff_cards.length ? (
        <div className="overflow-x-auto"><table className="w-full text-sm"><tbody>
          {data.handoff_cards.map(h => (
            <tr key={h.user_id} className="border-t border-[#F0E4D6]">
              <td className="py-1.5 pr-2 font-semibold">{h.name}</td>
              <td className="pr-2 text-xs text-[#8B7355]">{h.ref ? `Card link given ${when(h.created_at)}` : 'No card yet'}</td>
              <td className="text-right whitespace-nowrap space-x-2">
                {h.path ? <>
                  <CopyBtn text={`${origin}${h.path}`} />
                  <WriteBtn url={`${origin}${h.path}`} can={can} onMsg={setMsg} />
                  <button type="button" className="text-xs font-semibold text-[#af4408]" onClick={async () => { if (await ask({ title: `Give ${h.name} a new card link? Their old card stops working — write the new link to a card.`, confirmText: 'New link' }) !== null) void run('handoff.card_issue', { user_id: h.user_id }, `${h.name} has a new card link.`); }}>New link</button>
                  <button type="button" className="text-xs font-semibold text-[#6B5744]" onClick={async () => { if (await ask({ title: `Remove ${h.name}'s card link? Their card stops working.`, confirmText: 'Remove', danger: true }) !== null) void run('handoff.card_clear', { user_id: h.user_id }, 'Card link removed.'); }}>Remove</button>
                </> : <button type="button" className="text-xs font-semibold text-[#af4408]" onClick={() => void run('handoff.card_issue', { user_id: h.user_id }, `${h.name} now has a card link — copy or write it.`)}>Give card link</button>}
              </td>
            </tr>
          ))}
        </tbody></table></div>
      ) : <p className="text-xs text-[#8B7355]">No valet attendants are ticked for this outlet yet.</p>}
    </Panel>
  );
}

function EpcForm({ tag, run }: { tag: NfcRfidData['tags'][number]; run: Run }) {
  const [epc, setEpc] = useState(tag.rfid_epc || '');
  return (
    <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={e => { e.preventDefault(); void run('tag.rfid_epc', { tag_id: tag.id, epc }, epc ? 'RFID EPC saved.' : 'RFID EPC cleared.'); }}>
      <div className="w-72"><Field label={`RFID EPC on tag ${tag.code} (optional hardware)`}><input className={`${inputCls} font-mono`} value={epc} onChange={e => setEpc(e.target.value.toUpperCase())} placeholder="e.g. E2801160600002A1B2C3D4E5" maxLength={70} /></Field></div>
      <Btn type="submit" kind="ghost">Save EPC</Btn>
    </form>
  );
}

export function RfidPanel({ data, run, onChanged }: { data: NfcRfidData; run: Run; onChanged: () => void }) {
  const mode = String(data.config.rfid?.mode || 'off');
  const [name, setName] = useState('');
  const [zone, setZone] = useState('');
  const [token, setToken] = useState<null | { name: string; token: string }>(null);
  const origin = useOrigin();
  const [sim, setSim] = useState({ reader_id: '', tag_code: '', antenna: '1', age_seconds: '0', event_id: '' });
  const [simOut, setSimOut] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [err, setErr] = useState('');
  const showToken = async (cmd: string, body: Record<string, unknown>, label: string) => {
    setErr('');
    try { const r = await valetCmd<{ token: string }>(data.outlet.id, cmd, body); setToken({ name: label, token: r.token }); onChanged(); }
    catch (e) { setErr((e as Error).message); }
  };
  const simulate = async () => {
    setSimOut(null);
    try {
      const r = await valetCmd<{ results: { status: string }[] }>(data.outlet.id, 'rfid.simulate', { ...sim, age_seconds: Number(sim.age_seconds) || 0 });
      const st = r.results[0]?.status || '?';
      setSimOut({ kind: st === 'accepted' ? 'info' : 'error', text: `SIMULATED read: ${VERDICT[st] || st}.` });
      onChanged();
    } catch (e) { setSimOut({ kind: 'error', text: (e as Error).message }); }
  };
  return (
    <Panel title="RFID readers (optional hardware)">
      <p className="text-xs text-[#8B7355] mb-2">
        Long-range RFID readers can report when a key tag is seen (for example at the key cabinet). A read is only a hint for staff — it never moves a car,
        never releases a car and never proves who owns it. Ordinary phones cannot read these tags.
        Mode now: <b>{mode === 'live' ? 'LIVE readers' : mode === 'simulator' ? 'SIMULATOR (pretend reads)' : 'OFF'}</b> — the owner changes it in Rules.
      </p>
      <ErrorNote message={err} />
      <table className="w-full text-sm mb-2"><thead><tr className="text-left text-xs text-[#8B7355]"><th>Reader</th><th>Watches</th><th>Health</th><th>Last heard</th><th>Reads ok / refused</th><th /></tr></thead><tbody>
        {data.rfid.readers.map(r => (
          <tr key={r.id} className="border-t border-[#F0E4D6]">
            <td className="py-1 font-semibold">{r.name}</td><td>{r.zone_name || '—'}</td>
            <td className={r.health === 'ok' ? 'text-emerald-700' : r.health === 'quiet' ? 'text-red-700' : 'text-[#8B7355]'}>{HEALTH[r.health] || r.health}</td>
            <td>{when(r.last_seen_at)}</td><td>{r.events_accepted} / {r.events_rejected}</td>
            <td className="text-right whitespace-nowrap">{data.can_admin ? <>
              <button type="button" className="text-xs font-semibold text-[#af4408] mr-2" onClick={() => void showToken('rfid.reader_rotate', { reader_id: r.id }, r.name)}>New token</button>
              <button type="button" className="text-xs font-semibold text-[#6B5744]" onClick={() => void run('rfid.reader_enable', { reader_id: r.id, enabled: !r.enabled }, r.enabled ? 'Reader disabled.' : 'Reader enabled.')}>{r.enabled ? 'Disable' : 'Enable'}</button>
            </> : null}</td>
          </tr>
        ))}
        {!data.rfid.readers.length ? <tr><td colSpan={6} className="py-1 text-[#8B7355]">No readers registered.</td></tr> : null}
      </tbody></table>
      {data.can_admin ? (
        <form className="grid gap-2 sm:grid-cols-3 items-end mb-3" onSubmit={e => { e.preventDefault(); if (name.trim()) void showToken('rfid.reader_register', { name: name.trim(), zone_id: zone || undefined }, name.trim()).then(() => { setName(''); setZone(''); }); }}>
          <Field label="New reader name"><input className={inputCls} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Key cabinet" maxLength={60} /></Field>
          <Field label="Zone it watches (optional)"><select className={inputCls} value={zone} onChange={e => setZone(e.target.value)}><option value="">—</option>{data.zones.filter(z => z.is_active).map(z => <option key={z.id} value={z.id}>{z.name}</option>)}</select></Field>
          <Btn type="submit" disabled={!name.trim()}>Register reader</Btn>
        </form>
      ) : null}
      {data.can_admin && mode === 'simulator' ? (
        <div className="rounded-lg border border-dashed border-amber-300 bg-amber-50/60 p-2 mb-3">
          <div className="text-xs font-bold text-amber-900 mb-1">SIMULATOR — pretend reads, no hardware. Goes through the same checks as a real reader.</div>
          <div className="grid gap-2 sm:grid-cols-5 items-end">
            <Field label="Reader"><select className={inputCls} value={sim.reader_id} onChange={e => setSim({ ...sim, reader_id: e.target.value })}><option value="">Choose…</option>{data.rfid.readers.filter(r => r.enabled).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
            <Field label="Key tag"><input className={inputCls} value={sim.tag_code} onChange={e => setSim({ ...sim, tag_code: e.target.value })} placeholder="e.g. 07" /></Field>
            <Field label="Seconds ago" hint="> 120 = too old"><input className={inputCls} inputMode="numeric" value={sim.age_seconds} onChange={e => setSim({ ...sim, age_seconds: e.target.value.replace(/\D/g, '') })} /></Field>
            <Field label="Event id (optional)" hint="Reuse one = repeat"><input className={inputCls} value={sim.event_id} onChange={e => setSim({ ...sim, event_id: e.target.value })} /></Field>
            <Btn onClick={() => void simulate()} disabled={!sim.reader_id || !sim.tag_code.trim()}>Simulate read</Btn>
          </div>
          {simOut ? (simOut.kind === 'error' ? <ErrorNote message={simOut.text} /> : <InfoNote>{simOut.text}</InfoNote>) : null}
        </div>
      ) : null}
      {data.rfid.reads.length ? (
        <details><summary className="cursor-pointer text-sm font-semibold">Recent reads ({data.rfid.reads.length})</summary>
          <table className="w-full text-xs mt-1"><thead><tr className="text-left text-[#8B7355]"><th>Received</th><th>Reader</th><th>Tag / EPC</th><th>Verdict</th><th>Source</th></tr></thead><tbody>
            {data.rfid.reads.map((r, i) => <tr key={i} className="border-t border-[#F0E4D6]"><td className="py-0.5">{when(r.received_at)}</td><td>{r.reader_name}</td><td className="font-mono">{r.tag_code || r.epc}</td><td>{VERDICT[r.status] || r.status}</td><td>{r.source === 'simulator' ? 'SIMULATED' : 'reader'}</td></tr>)}
          </tbody></table>
        </details>
      ) : null}
      {token ? (
        <Modal title={`Reader token — ${token.name}`} onClose={() => setToken(null)}>
          <p className="text-sm mb-2">Enter this token in the reader&apos;s (or its middleware&apos;s) settings <b>now</b>. It is shown only once; if it is lost, make a new one.</p>
          <div className="font-mono text-sm break-all rounded bg-[#FFF8F0] p-2 border border-[#E8D5C4]">{token.token}</div>
          <div className="mt-1"><CopyBtn text={token.token} /></div>
          <p className="text-xs text-[#8B7355] mt-3">The reader sends HTTPS POST to <span className="font-mono break-all">{origin}/api/valet-rfid/ingest</span> with the header <span className="font-mono">Authorization: Bearer &lt;token&gt;</span> and a body like <span className="font-mono">{'{"events":[{"event_id":"r1-000123","epc":"E280…","antenna":"1","observed_at":"2026-11-10T20:15:04Z"}]}'}</span>. Reads are accepted only while RFID mode is Live. Details: docs/valet/HARDWARE.md.</p>
        </Modal>
      ) : null}
    </Panel>
  );
}
