'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import {
  Printer, Loader2, Check, ChefHat, Receipt, ArrowLeft,
  GripVertical, ChevronUp, ChevronDown, AlertTriangle,
} from 'lucide-react';
import {
  DEFAULT_KOT_DESIGN, normalizeKotDesign, invalidateDesignCache, KOT_LINE_LABELS,
  type KotDesign, type KotLine, type KotLineSize,
} from '@/lib/offline-print/print';
import { computeBill, round2 } from '@/lib/bill-calc';

const DEFAULT_BILL = {
  brandName: '', companyName: '', address: '', contact: '', email: '', fssai: '',
  showGstin: true, showServer: true,
  serviceChargeOn: false, serviceChargePct: 5,
  cgstPct: 2.5, sgstPct: 2.5,
  headerNote: '', footerNote: 'Thank you! Visit again.',
};
type BillDesign = typeof DEFAULT_BILL;

// Coerce a loaded/partial bill_design into a complete, correctly-typed BillDesign.
function normalizeBillDesign(raw: any): BillDesign {
  const r = raw && typeof raw === 'object' ? raw : {};
  const str = (v: any, d: string) => (typeof v === 'string' ? v : d);
  const bool = (v: any, d: boolean) => (typeof v === 'boolean' ? v : d);
  const num = (v: any, d: number) => (v === '' || v == null || isNaN(Number(v)) ? d : Number(v));
  return {
    brandName: str(r.brandName ?? r.shopName, DEFAULT_BILL.brandName),  // migrate legacy shopName
    companyName: str(r.companyName, DEFAULT_BILL.companyName),
    address: str(r.address, DEFAULT_BILL.address),
    contact: str(r.contact, DEFAULT_BILL.contact),
    email: str(r.email, DEFAULT_BILL.email),
    fssai: str(r.fssai, DEFAULT_BILL.fssai),
    showGstin: bool(r.showGstin, DEFAULT_BILL.showGstin),
    showServer: bool(r.showServer, DEFAULT_BILL.showServer),
    serviceChargeOn: bool(r.serviceChargeOn, DEFAULT_BILL.serviceChargeOn),
    serviceChargePct: num(r.serviceChargePct, DEFAULT_BILL.serviceChargePct),
    cgstPct: num(r.cgstPct, DEFAULT_BILL.cgstPct),
    sgstPct: num(r.sgstPct, DEFAULT_BILL.sgstPct),
    headerNote: str(r.headerNote, DEFAULT_BILL.headerNote),
    footerNote: str(r.footerNote, DEFAULT_BILL.footerNote),
  };
}

const SAMPLE_KOT = {
  table: '7', floor: 'Rooftop', kotNumber: 12, station: 'TANDOOR', copyLabel: 'ORIGINAL', foodLiquor: 'FOOD',
  captain: 'Ramesh', firedBy: 'Suresh', orderRef: '45',
  items: [{ name: 'Paneer Tikka', qty: 2, notes: 'Less spicy' }, { name: 'Butter Naan', qty: 1 }],
};
const SAMPLE_BILL = {
  orderType: 'DINE-IN', floor: 'Rooftop', table: '7', guests: 4, server: 'Ramesh', printedBy: 'Cashier Anil',
  guestName: 'Ramesh', guestMobile: '99988 87776', captainName: 'Suresh', orderNo: '45', paymentMethod: 'cash',
  items: [
    { name: 'Paneer Tikka', qty: 2, rate: 260, amount: 520 },
    { name: 'Butter Naan', qty: 1, rate: 60, amount: 60 },
  ],
};

function nowStamp() {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
}
function twoCol(left: string, right: string, cols = 48) {   // 80mm = 48 cols (matches the bridge)
  const pad = Math.max(1, cols - left.length - right.length);
  return left + ' '.repeat(pad) + right;
}

// ── Live preview (monospace, mirrors the bridge buildKot section-by-section) ──
function Ticket({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-white text-black font-mono text-[11px] leading-[1.45] rounded-lg shadow-inner border border-[#E8D5C4] p-3 w-[300px] mx-auto whitespace-pre overflow-x-auto">
      {children}
    </div>
  );
}
// Per-line size → CSS size, approximating the bridge's true 1x / 2x / 3x
// ESC-POS magnification (base 11px) so the on-screen footprint reflects paper use.
const SIZE_CLASS: Record<KotLineSize, string> = { normal: '', large: 'text-[20px]', xlarge: 'text-[29px]' };
// Item columns mirror the bridge's floor(48 / multiplier) on 80mm paper.
const ITEM_COLS: Record<KotLineSize, number> = { normal: 48, large: 24, xlarge: 16 };

const C = ({ children, b, cls = '' }: { children: React.ReactNode; b?: boolean; cls?: string }) =>
  <div className={`text-center ${b ? 'font-bold' : ''} ${cls}`}>{children}</div>;
const L = ({ children, b, cls = '' }: { children: React.ReactNode; b?: boolean; cls?: string }) =>
  <div className={`${b ? 'font-bold' : ''} ${cls}`}>{children}</div>;
const Rule = () => <div>{'-'.repeat(48)}</div>;

function KotPreview({ d, businessName }: { d: KotDesign; businessName: string }) {
  const s = SAMPLE_KOT;
  const cap = s.captain.trim(), fb = s.firedBy.trim();
  const renderLine = (ln: KotLine) => {
    const z = SIZE_CLASS[ln.size];
    switch (ln.key) {
      case 'table': return <C b cls={z}>{s.table ? `TABLE ${s.table}` : 'ORDER'}</C>;
      case 'outlet': return <C b cls={z}>{(d.outletName || businessName || 'RESTAURANT').toUpperCase()}</C>;
      case 'floor': return <C cls={z}>Floor: {s.floor}</C>;
      case 'kotNo': return <C b cls={z}>KOT #{s.kotNumber} - {s.station}</C>;
      case 'copyLabel': return <C b cls={z}>{s.copyLabel}</C>;
      case 'foodLiquor': return <C b cls={z}>*** {s.foodLiquor} ***</C>;
      case 'captain': return cap ? <L cls={z}>Captain: {cap}</L> : null;
      case 'puncher': return (fb && fb.toLowerCase() !== cap.toLowerCase()) ? <L cls={z}>Punched by: {fb}</L> : null;
      case 'dateTime': return <L cls={z}>{twoCol(nowStamp(), `#${s.orderRef}`)}</L>;
      case 'headerNote': return d.headerNote ? <L cls={z}>* {d.headerNote} *</L> : null;
      case 'items': return (
        <div>
          <Rule />
          {s.items.map((it, i) => (
            <div key={i}>
              <L b cls={z}>{twoCol(it.name, `x${it.qty}`, ITEM_COLS[ln.size])}</L>
              {it.notes && <L>{'    - ' + it.notes}</L>}
            </div>
          ))}
          <Rule />
        </div>
      );
      case 'totalItems': return <L cls={z}>Total items: {s.items.reduce((a, it) => a + it.qty, 0)}</L>;
      case 'footerNote': return d.footerNote ? <><L>{' '}</L><C cls={z}>{d.footerNote}</C></> : null;  // blank line above, like the bridge
      default: return null;
    }
  };
  return <Ticket>{d.lines.filter((l) => l.enabled).map((ln) => <div key={ln.key}>{renderLine(ln)}</div>)}</Ticket>;
}

// Bill money — mirrors the bridge's money(): 'Rs ' prefix, 2 decimals, grouped.
function billMoney(n: number): string {
  return 'Rs ' + round2(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
// Right-align a value into a fixed-width column (padded left with spaces).
function rcol(v: string, w: number): string {
  const s = String(v);
  return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}
// Item row: name on the left (truncated), then Qty/Rate/Amt in fixed right columns,
// mirroring the bridge's 4-column bill table on 80mm (48 col) paper.
const QTY_W = 4, RATE_W = 9, AMT_W = 10;                 // right-side column widths
const NAME_W = 48 - QTY_W - RATE_W - AMT_W;              // remaining left width
function itemRow(name: string, qty: string, rate: string, amt: string): string {
  const nm = name.length > NAME_W ? name.slice(0, NAME_W) : name.padEnd(NAME_W);
  return nm + rcol(qty, QTY_W) + rcol(rate, RATE_W) + rcol(amt, AMT_W);
}

function BillPreview({ d, businessName, gstin }: { d: BillDesign; businessName: string; gstin: string }) {
  const s = SAMPLE_BILL;
  const subtotal = round2(s.items.reduce((a, it) => a + it.amount, 0));
  const b = computeBill(
    { subtotal, serviceRemoved: false, discount_pct: 0, discount: 0 },
    { serviceChargeOn: d.serviceChargeOn, serviceChargePct: d.serviceChargePct, cgstPct: d.cgstPct, sgstPct: d.sgstPct },
  );
  return (
    <Ticket>
      {/* Header block */}
      <C b cls="text-[15px]">{(d.brandName || businessName || 'RESTAURANT').toUpperCase()}</C>
      {d.companyName && <C>{d.companyName}</C>}
      {d.address && <C>{d.address}</C>}
      {d.contact && <C>Contact no: {d.contact}</C>}
      {d.email && <C>Email: {d.email}</C>}
      {d.fssai && <C>FSSAI no: {d.fssai}</C>}
      {d.showGstin && gstin && <C>GST no: {gstin}</C>}
      <Rule />
      <C b>{s.orderType}</C>
      <L>{s.floor} : {s.table}</L>
      <Rule />
      <L>Guest Name: {s.guestName}</L>
      <L>Mobile: {s.guestMobile}</L>
      <L>Date &amp; Time: {nowStamp()}</L>
      <L>Captain Name: {s.captainName}</L>
      <Rule />
      <L>{twoCol(`Number of Guests: ${s.guests}`, `Order no: ${s.orderNo}`)}</L>
      <Rule />
      {/* Item table: Item Name | Qty | Rate | Amt */}
      <L>{itemRow('Item Name', 'Qty', 'Rate', 'Amt')}</L>
      <Rule />
      {s.items.map((it, i) => (
        <L key={i}>{itemRow(it.name, String(it.qty), round2(it.rate).toFixed(2), round2(it.amount).toFixed(2))}</L>
      ))}
      <Rule />
      {/* Totals */}
      <L>{twoCol('Sub Total', billMoney(b.subtotal))}</L>
      {b.serviceCharge > 0 && <L>{twoCol('Service Charges', billMoney(b.serviceCharge))}</L>}
      {b.cgst > 0 && <L>{twoCol(`CGST@${d.cgstPct}%`, billMoney(b.cgst))}</L>}
      {b.sgst > 0 && <L>{twoCol(`SGST@${d.sgstPct}%`, billMoney(b.sgst))}</L>}
      {b.discount > 0 && <L>{twoCol('Discount', '-' + billMoney(b.discount))}</L>}
      <L b cls="text-[15px]">{twoCol('TOTAL', 'Rs.' + round2(b.total).toFixed(2), 24)}</L>
      <L b>{twoCol('Grand Total', 'Rs.' + Math.round(b.total))}</L>
      <L>{twoCol(`Paid by ${s.paymentMethod.toUpperCase()}`, billMoney(Math.round(b.total)))}</L>
      <L>{twoCol('Balance', billMoney(0))}</L>
      <Rule />
      {/* Footer */}
      {d.footerNote && <C>{d.footerNote}</C>}
      <L>Printed by {s.printedBy}</L>
      <L>Printed on: {nowStamp()}</L>
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
const Num = ({ label, value, set, suffix }: { label: string; value: number; set: (v: number) => void; suffix?: string }) => (
  <label className="block py-2">
    <span className="text-xs font-semibold text-[#8B7355]">{label}</span>
    <div className="flex items-center gap-2 mt-1">
      <input type="number" inputMode="decimal" min={0} step="0.5" value={Number.isFinite(value) ? value : 0}
        onChange={(e) => set(e.target.value === '' ? 0 : Number(e.target.value))}
        className="w-full border border-[#D4B896] rounded-lg px-3 py-2 text-sm" />
      {suffix && <span className="text-sm text-[#8B7355] shrink-0">{suffix}</span>}
    </div>
  </label>
);

export default function PrintDesign() {
  const router = useRouter();
  const [tab, setTab] = useState<'kot' | 'bill'>('kot');
  const [kot, setKot] = useState<KotDesign>(DEFAULT_KOT_DESIGN);
  const [bill, setBill] = useState<BillDesign>(DEFAULT_BILL);
  const [businessName, setBusinessName] = useState('');
  const [gstin, setGstin] = useState('');
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [dragI, setDragI] = useState<number | null>(null);
  const [overI, setOverI] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const all = (await (await api('/api/settings')).json()).settings || [];
      const get = (k: string) => all.find((s: any) => s.key === k)?.value;
      setBusinessName(get('business_name') || '');
      setGstin(get('gstin') || '');
      const kd = get('kot_design'); if (kd) try { setKot(normalizeKotDesign(JSON.parse(kd))); } catch {}
      const bd = get('bill_design'); if (bd) try { setBill(normalizeBillDesign(JSON.parse(bd))); } catch {}
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function save() {
    setSaving(true); setError('');
    try {
      const r1 = await api('/api/settings', { method: 'PUT', body: { key: 'kot_design', value: JSON.stringify(kot) } });
      const r2 = await api('/api/settings', { method: 'PUT', body: { key: 'bill_design', value: JSON.stringify(bill) } });
      if (!r1.ok || !r2.ok) { setError('Could not save — please try again.'); return; }
      invalidateDesignCache();   // so the very next print uses the new design, not a ≤30s cached one
      setSaved(true); setTimeout(() => setSaved(false), 2500);
    } catch { setError('Could not save — please try again.'); }
    finally { setSaving(false); }
  }

  // KOT line-list helpers (drag to reorder + up/down buttons + per-line size/enable)
  const moveLine = (from: number, to: number) => {
    if (to < 0 || to >= kot.lines.length) return;
    const a = [...kot.lines]; const [x] = a.splice(from, 1); a.splice(to, 0, x);
    setKot({ ...kot, lines: a });
  };
  const setLine = (i: number, patch: Partial<KotLine>) =>
    setKot({ ...kot, lines: kot.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });

  if (loading) return <div className="py-16 text-center text-[#8B7355]"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></div>;

  return (
    <div className="max-w-4xl">
      <button onClick={() => router.back()} className="inline-flex items-center gap-1 text-sm text-[#8B7355] hover:text-[#af4408] mb-3">
        <ArrowLeft className="w-4 h-4" /> Back
      </button>
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
      <p className="text-sm text-[#8B7355] mb-2">Design how the Food KOT and the Bill print. The preview updates live. After saving, the counter PC must run the latest <b>Print Bridge (v2.1.0+)</b> — re-download it from the <b>KOT &amp; Bill Printers</b> page and restart it — for the new KOT layout to print.</p>
      {error && (
        <div className="flex items-center gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

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
              <p className="text-xs text-[#8B7355] mb-2">
                Reorder with the <b>↑ / ↓ arrows</b> (or drag the handle on desktop). <b>A / A+ / A++</b> sets each
                line's size; toggle to show/hide. Fewer lines &amp; smaller sizes use less paper.
              </p>
              <div className="mb-3">
                {kot.lines.map((ln, i) => (
                  <div key={ln.key} draggable
                    onDragStart={() => setDragI(i)}
                    onDragOver={(e) => { e.preventDefault(); setOverI(i); }}
                    onDrop={(e) => { e.preventDefault(); if (dragI != null && dragI !== i) moveLine(dragI, i); setDragI(null); setOverI(null); }}
                    onDragEnd={() => { setDragI(null); setOverI(null); }}
                    className={`flex items-center gap-2 py-1.5 px-2 rounded-lg border mb-1 bg-white cursor-grab active:cursor-grabbing transition-colors
                      ${overI === i ? 'border-[#af4408] bg-[#af4408]/10' : 'border-[#F0E4D6]'} ${dragI === i ? 'opacity-40' : ''} ${!ln.enabled ? 'opacity-60' : ''}`}>
                    <GripVertical className="w-4 h-4 text-[#C9B89F] shrink-0" />
                    <span className="text-sm text-[#2D1B0E] flex-1 truncate">{KOT_LINE_LABELS[ln.key]}</span>
                    <div className="flex flex-col -my-1 shrink-0">
                      <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => moveLine(i, i - 1)} className="text-[#8B7355] disabled:opacity-25 leading-none"><ChevronUp className="w-3.5 h-3.5" /></button>
                      <button type="button" aria-label="Move down" disabled={i === kot.lines.length - 1} onClick={() => moveLine(i, i + 1)} className="text-[#8B7355] disabled:opacity-25 leading-none"><ChevronDown className="w-3.5 h-3.5" /></button>
                    </div>
                    <select value={ln.size} onChange={(e) => setLine(i, { size: e.target.value as KotLineSize })}
                      className="border border-[#D4B896] rounded-lg px-1.5 py-1 text-xs shrink-0" aria-label="Line size">
                      <option value="normal">A</option>
                      <option value="large">A+</option>
                      <option value="xlarge">A++</option>
                    </select>
                    <button type="button" onClick={() => setLine(i, { enabled: !ln.enabled })} aria-label="Show or hide line"
                      className={`w-9 h-5 rounded-full relative shrink-0 transition-colors ${ln.enabled ? 'bg-[#af4408]' : 'bg-[#D4B896]'}`}>
                      <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all ${ln.enabled ? 'left-[18px]' : 'left-0.5'}`} />
                    </button>
                  </div>
                ))}
              </div>
              <Text label="Outlet name (blank = business name)" value={kot.outletName} set={(v) => setKot({ ...kot, outletName: v })} placeholder={businessName || 'Restaurant'} />
              <Text label="Header note (optional — enable the “Header note” line above)" value={kot.headerNote} set={(v) => setKot({ ...kot, headerNote: v })} placeholder="e.g. RUSH" />
              <Text label="Footer note (optional — enable the “Footer note” line above)" value={kot.footerNote} set={(v) => setKot({ ...kot, footerNote: v })} />
            </>
          ) : (
            <>
              <p className="text-xs font-semibold text-[#8B7355] uppercase tracking-wide mb-1 mt-1">Header block</p>
              <Text label="Brand name (blank = business name)" value={bill.brandName} set={(v) => setBill({ ...bill, brandName: v })} placeholder={businessName || 'Restaurant'} />
              <Text label="Company name" value={bill.companyName} set={(v) => setBill({ ...bill, companyName: v })} placeholder="e.g. AKAN Foods Pvt Ltd" />
              <Text label="Address" value={bill.address} set={(v) => setBill({ ...bill, address: v })} placeholder="Street, City" />
              <Text label="Contact no." value={bill.contact} set={(v) => setBill({ ...bill, contact: v })} placeholder="+91 98765 43210" />
              <Text label="Email" value={bill.email} set={(v) => setBill({ ...bill, email: v })} placeholder="hello@example.com" />
              <Text label="FSSAI no." value={bill.fssai} set={(v) => setBill({ ...bill, fssai: v })} placeholder="12345678901234" />
              <Toggle label="Show GST no." on={bill.showGstin} set={(v) => setBill({ ...bill, showGstin: v })} />
              <Toggle label="Show server name" on={bill.showServer} set={(v) => setBill({ ...bill, showServer: v })} />

              <p className="text-xs font-semibold text-[#8B7355] uppercase tracking-wide mb-1 mt-3">Charges &amp; tax</p>
              <Toggle label="Apply service charge" on={bill.serviceChargeOn} set={(v) => setBill({ ...bill, serviceChargeOn: v })} />
              <Num label="Service charge %" value={bill.serviceChargePct} set={(v) => setBill({ ...bill, serviceChargePct: v })} suffix="%" />
              <Num label="CGST %" value={bill.cgstPct} set={(v) => setBill({ ...bill, cgstPct: v })} suffix="%" />
              <Num label="SGST %" value={bill.sgstPct} set={(v) => setBill({ ...bill, sgstPct: v })} suffix="%" />

              <p className="text-xs font-semibold text-[#8B7355] uppercase tracking-wide mb-1 mt-3">Notes</p>
              <Text label="Header note (optional)" value={bill.headerNote} set={(v) => setBill({ ...bill, headerNote: v })} />
              <Text label="Footer note" value={bill.footerNote} set={(v) => setBill({ ...bill, footerNote: v })} />
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
