'use client';

import { useEffect, useState, useCallback } from 'react';
import { api } from '@/lib/api';
import { Printer, Loader2, Check, ChefHat, Receipt } from 'lucide-react';

// Mirrors src/lib/offline-print/print.ts DEFAULT_KOT_DESIGN.
const DEFAULT_KOT = {
  showOutlet: true, outletName: '', showFloor: true, showTable: true,
  showKotNo: true, showCopyLabel: true, showCaptain: true, showDateTime: true,
  headerNote: '', footerNote: '', fontScale: 'normal' as 'normal' | 'large',
};
const DEFAULT_BILL = {
  shopName: '', showGstin: true, showServer: true, headerNote: '', footerNote: 'Thank you! Visit again.',
  fontScale: 'normal' as 'normal' | 'large',
};

type KotDesign = typeof DEFAULT_KOT;
type BillDesign = typeof DEFAULT_BILL;

const SAMPLE_KOT = {
  table: '7', floor: 'Rooftop', kotNumber: 12, station: 'TANDOOR', copyLabel: 'ORIGINAL',
  captain: 'Ramesh', firedBy: 'Suresh', orderRef: '45',
  items: [{ name: 'Paneer Tikka', qty: 2, notes: 'Less spicy' }, { name: 'Butter Naan', qty: 1 }],
};
const SAMPLE_BILL = {
  billNo: '45', table: '7', server: 'Ramesh',
  items: [{ name: 'Paneer Tikka', qty: 2, amount: 520 }, { name: 'Butter Naan', qty: 1, amount: 60 }],
  subtotal: 580, tax: 29, total: 609,
};

function nowStamp() {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
}
function twoCol(left: string, right: string, cols = 42) {
  const pad = Math.max(1, cols - left.length - right.length);
  return left + ' '.repeat(pad) + right;
}

// ── Live preview (monospace, mirrors the bridge layout) ──────────────────────
function Ticket({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-white text-black font-mono text-[11px] leading-[1.45] rounded-lg shadow-inner border border-[#E8D5C4] p-3 w-[300px] mx-auto whitespace-pre overflow-x-auto">
      {children}
    </div>
  );
}
const C = ({ children, b, big }: { children: React.ReactNode; b?: boolean; big?: boolean }) =>
  <div className={`text-center ${b ? 'font-bold' : ''} ${big ? 'text-[15px]' : ''}`}>{children}</div>;
const L = ({ children, b }: { children: React.ReactNode; b?: boolean }) => <div className={b ? 'font-bold' : ''}>{children}</div>;
const Rule = () => <div>{'-'.repeat(42)}</div>;

function KotPreview({ d, businessName }: { d: KotDesign; businessName: string }) {
  const big = d.fontScale === 'large';
  const s = SAMPLE_KOT;
  return (
    <Ticket>
      <C b big>{s.table ? `TABLE ${s.table}` : 'ORDER'}</C>
      {d.showOutlet && <C b>{(d.outletName || businessName || 'RESTAURANT').toUpperCase()}</C>}
      {d.showFloor && <C>Floor: {s.floor}</C>}
      {d.showKotNo && <C b>KOT #{s.kotNumber} - {s.station}</C>}
      {d.showCopyLabel && <C b big>{s.copyLabel}</C>}
      <Rule />
      {d.showCaptain && <L>Captain: {s.captain}</L>}
      {d.showCaptain && s.firedBy !== s.captain && <L>Punched by: {s.firedBy}</L>}
      {d.showDateTime && <L>{twoCol(nowStamp(), `#${s.orderRef}`)}</L>}
      {d.headerNote && <L>* {d.headerNote} *</L>}
      <Rule />
      {s.items.map((it, i) => (
        <div key={i}>
          <L b>{twoCol(it.name, `x${it.qty}`, big ? 21 : 42)}</L>
          {it.notes && <L>{'    - ' + it.notes}</L>}
        </div>
      ))}
      <Rule />
      <L>Total items: {s.items.reduce((a, it) => a + it.qty, 0)}</L>
      {d.footerNote && <C>{d.footerNote}</C>}
    </Ticket>
  );
}

function BillPreview({ d, businessName, gstin }: { d: BillDesign; businessName: string; gstin: string }) {
  const s = SAMPLE_BILL;
  return (
    <Ticket>
      <C b big>{(d.shopName || businessName || 'RESTAURANT').toUpperCase()}</C>
      {d.showGstin && gstin && <C>GSTIN: {gstin}</C>}
      {d.headerNote && <C>{d.headerNote}</C>}
      <Rule />
      <L>{twoCol(`Bill #${s.billNo}`, `Table ${s.table}`)}</L>
      <L>{twoCol(nowStamp(), d.showServer ? `Server: ${s.server}` : '')}</L>
      <Rule />
      {s.items.map((it, i) => <L key={i}>{twoCol(`${it.qty} x ${it.name}`, `Rs ${it.amount}.00`)}</L>)}
      <Rule />
      <L>{twoCol('Subtotal', `Rs ${s.subtotal}.00`)}</L>
      <L>{twoCol('Tax', `Rs ${s.tax}.00`)}</L>
      <L b>{twoCol('TOTAL', `Rs ${s.total}.00`)}</L>
      <Rule />
      {d.footerNote && <C>{d.footerNote}</C>}
    </Ticket>
  );
}

// ── Small form controls ──────────────────────────────────────────────────────
const Toggle = ({ label, on, set }: { label: string; on: boolean; set: (v: boolean) => void }) => (
  <label className="flex items-center justify-between gap-3 py-2 border-b border-[#F0E4D6] cursor-pointer">
    <span className="text-sm text-[#2D1B0E]">{label}</span>
    <button type="button" onClick={() => set(!on)} className={`w-10 h-6 rounded-full transition-colors relative ${on ? 'bg-[#af4408]' : 'bg-[#D4B896]'}`}>
      <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
    </button>
  </label>
);
const Text = ({ label, value, set, placeholder }: { label: string; value: string; set: (v: string) => void; placeholder?: string }) => (
  <label className="block py-2">
    <span className="text-xs font-semibold text-[#8B7355]">{label}</span>
    <input value={value} onChange={(e) => set(e.target.value)} placeholder={placeholder}
      className="w-full mt-1 border border-[#D4B896] rounded-lg px-3 py-2 text-sm" />
  </label>
);

export default function PrintDesign() {
  const [tab, setTab] = useState<'kot' | 'bill'>('kot');
  const [kot, setKot] = useState<KotDesign>(DEFAULT_KOT);
  const [bill, setBill] = useState<BillDesign>(DEFAULT_BILL);
  const [businessName, setBusinessName] = useState('');
  const [gstin, setGstin] = useState('');
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const all = (await (await api('/api/settings')).json()).settings || [];
      const get = (k: string) => all.find((s: any) => s.key === k)?.value;
      setBusinessName(get('business_name') || '');
      setGstin(get('gstin') || '');
      const kd = get('kot_design'); if (kd) try { setKot({ ...DEFAULT_KOT, ...JSON.parse(kd) }); } catch {}
      const bd = get('bill_design'); if (bd) try { setBill({ ...DEFAULT_BILL, ...JSON.parse(bd) }); } catch {}
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function save() {
    setSaving(true);
    try {
      await api('/api/settings', { method: 'POST', body: { key: 'kot_design', value: JSON.stringify(kot) } });
      await api('/api/settings', { method: 'POST', body: { key: 'bill_design', value: JSON.stringify(bill) } });
      setSaved(true); setTimeout(() => setSaved(false), 2500);
    } finally { setSaving(false); }
  }

  if (loading) return <div className="py-16 text-center text-[#8B7355]"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></div>;

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <Printer className="w-6 h-6 text-[#af4408]" />
          <h1 className="text-2xl font-bold text-[#2D1B0E]">Print Design</h1>
        </div>
        <button onClick={save} disabled={saving}
          className="flex items-center gap-2 bg-[#af4408] text-white px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-50">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <Check className="w-4 h-4" /> : null}
          {saved ? 'Saved' : 'Save design'}
        </button>
      </div>
      <p className="text-sm text-[#8B7355] mb-4">Design how the Food KOT and the Bill print. The preview updates live; Save applies it to the next print.</p>

      <div className="flex gap-1 mb-4 bg-[#FFF1E3] rounded-xl p-1 w-fit">
        {([['kot', 'Food KOT', ChefHat], ['bill', 'Bill', Receipt]] as const).map(([k, label, Icon]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold ${tab === k ? 'bg-[#af4408] text-white' : 'text-[#6B5744]'}`}>
            <Icon className="w-4 h-4" /> {label}
          </button>
        ))}
      </div>

      <div className="grid md:grid-cols-2 gap-6 items-start">
        {/* Options */}
        <div className="bg-white border border-[#E8D5C4] rounded-2xl p-4">
          {tab === 'kot' ? (
            <>
              <Toggle label="Show outlet name" on={kot.showOutlet} set={(v) => setKot({ ...kot, showOutlet: v })} />
              {kot.showOutlet && <Text label="Outlet name (blank = business name)" value={kot.outletName} set={(v) => setKot({ ...kot, outletName: v })} placeholder={businessName || 'Restaurant'} />}
              <Toggle label="Show floor" on={kot.showFloor} set={(v) => setKot({ ...kot, showFloor: v })} />
              <Toggle label="Show table number (top)" on={kot.showTable} set={(v) => setKot({ ...kot, showTable: v })} />
              <Toggle label="Show KOT number" on={kot.showKotNo} set={(v) => setKot({ ...kot, showKotNo: v })} />
              <Toggle label="Show ORIGINAL / DUPLICATE label" on={kot.showCopyLabel} set={(v) => setKot({ ...kot, showCopyLabel: v })} />
              <Toggle label="Show captain names" on={kot.showCaptain} set={(v) => setKot({ ...kot, showCaptain: v })} />
              <Toggle label="Show date & time" on={kot.showDateTime} set={(v) => setKot({ ...kot, showDateTime: v })} />
              <Text label="Header note (optional)" value={kot.headerNote} set={(v) => setKot({ ...kot, headerNote: v })} placeholder="e.g. RUSH" />
              <Text label="Footer note (optional)" value={kot.footerNote} set={(v) => setKot({ ...kot, footerNote: v })} />
              <label className="block py-2">
                <span className="text-xs font-semibold text-[#8B7355]">Item font size</span>
                <select value={kot.fontScale} onChange={(e) => setKot({ ...kot, fontScale: e.target.value as any })} className="w-full mt-1 border border-[#D4B896] rounded-lg px-3 py-2 text-sm">
                  <option value="normal">Normal</option>
                  <option value="large">Large (easier for the kitchen)</option>
                </select>
              </label>
            </>
          ) : (
            <>
              <Text label="Shop name (blank = business name)" value={bill.shopName} set={(v) => setBill({ ...bill, shopName: v })} placeholder={businessName || 'Restaurant'} />
              <Toggle label="Show GSTIN" on={bill.showGstin} set={(v) => setBill({ ...bill, showGstin: v })} />
              <Toggle label="Show server name" on={bill.showServer} set={(v) => setBill({ ...bill, showServer: v })} />
              <Text label="Header note (optional)" value={bill.headerNote} set={(v) => setBill({ ...bill, headerNote: v })} />
              <Text label="Footer note" value={bill.footerNote} set={(v) => setBill({ ...bill, footerNote: v })} />
              <label className="block py-2">
                <span className="text-xs font-semibold text-[#8B7355]">Font size</span>
                <select value={bill.fontScale} onChange={(e) => setBill({ ...bill, fontScale: e.target.value as any })} className="w-full mt-1 border border-[#D4B896] rounded-lg px-3 py-2 text-sm">
                  <option value="normal">Normal</option>
                  <option value="large">Large</option>
                </select>
              </label>
            </>
          )}
        </div>

        {/* Live preview */}
        <div>
          <p className="text-xs font-semibold text-[#8B7355] uppercase tracking-wide mb-2 text-center">Live preview (80mm)</p>
          {tab === 'kot' ? <KotPreview d={kot} businessName={businessName} /> : <BillPreview d={bill} businessName={businessName} gstin={gstin} />}
        </div>
      </div>
    </div>
  );
}
