'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import UISwitch from '@/components/Toggle';
import {
  Printer, Loader2, Check, ChefHat, Receipt, ArrowLeft,
  GripVertical, ChevronUp, ChevronDown, AlertTriangle, Tag, Scissors,
} from 'lucide-react';
import {
  DEFAULT_KOT_DESIGN, normalizeKotDesign, invalidateDesignCache, KOT_LINE_LABELS,
  DEFAULT_BILL_DESIGN, normalizeBillDesign, BILL_LINE_LABELS,
  type KotDesign, type KotLine, type KotLineSize,
  type BillDesign, type BillLine,
} from '@/lib/offline-print/print';
import { computeBill, round2 } from '@/lib/bill-calc';
// Sticker KOT (per-item label) — same Rugtek 80mm KOT printer, sticker roll.
import {
  buildKotStickerESCPOS,
  DEFAULT_STICKER_DESIGN, normalizeStickerDesign, STICKER_LINE_LABELS,
  type StickerDesign, type StickerLine, type StickerLineSize,
} from '@/lib/offline-print/kot-sticker';
import { buildKotStickerRasterB64 } from '@/lib/offline-print/sticker-raster';
import { bridgePrint, bridgeSupportsRawB64 } from '@/lib/offline-print/bridge-client';

// Per-item sticker-KOT config (settings key `kot_item_labels`). enabled +
// granularity are set in KOT & Bill Printers; here we only surface codeType +
// a live preview + a test print. Always persist the FULL object so we never
// clobber the on/off toggle or per-plate/per-line choice made elsewhere.
type StickerCfg = { enabled: boolean; granularity: 'per_unit' | 'per_line'; codeType: 'qr' | 'barcode' };
const DEFAULT_STICKER: StickerCfg = { enabled: false, granularity: 'per_unit', codeType: 'qr' };

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
    <div className="bg-white text-black font-mono text-[10px] leading-[1.5] rounded-lg shadow-inner border border-[#E8D5C4] px-2.5 py-3 w-[340px] mx-auto whitespace-pre overflow-x-auto">
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

// Per-line size → CSS size for the bill (subtler steps than the KOT, since the
// bill body is column-based). Mirrors the KOT's SIZE_CLASS approach.
const BILL_SIZE_CLASS: Record<KotLineSize, string> = { normal: '', large: 'text-[15px]', xlarge: 'text-[19px]' };

// Money rows print DOUBLE-HEIGHT ONLY (the bridge uses sizeCmdH), so they grow
// tall but keep the full 48-col width and never run off the paper. Represent
// that faithfully in the preview with a vertical scale (never a width change).
const BILL_MONEY_STYLE: Record<KotLineSize, { scale?: string; lh: string }> = {
  normal: { lh: '' },
  large: { scale: 'scaleY(1.7)', lh: 'leading-[1.9]' },
  xlarge: { scale: 'scaleY(2.4)', lh: 'leading-[2.6]' },
};
const MoneyL = ({ children, b, size }: { children: React.ReactNode; b?: boolean; size: KotLineSize }) => {
  const st = BILL_MONEY_STYLE[size];
  return (
    <div className={`${b ? 'font-bold' : ''} ${st.lh}`}>
      <span className="inline-block origin-center" style={st.scale ? { transform: st.scale } : undefined}>{children}</span>
    </div>
  );
};

function BillPreview({ d, businessName, gstin }: { d: BillDesign; businessName: string; gstin: string }) {
  const s = SAMPLE_BILL;
  const subtotal = round2(s.items.reduce((a, it) => a + it.amount, 0));
  const b = computeBill(
    { subtotal, serviceRemoved: false, discount_pct: 0, discount: 0 },
    { serviceChargeOn: d.serviceChargeOn, serviceChargePct: d.serviceChargePct, cgstPct: d.cgstPct, sgstPct: d.sgstPct },
  );
  const renderLine = (ln: BillLine) => {
    const z = BILL_SIZE_CLASS[ln.size];
    switch (ln.key) {
      case 'brand': return <C b cls={z || 'text-[15px]'}>{(d.brandName || businessName || 'RESTAURANT').toUpperCase()}</C>;
      case 'company': return d.companyName ? <C cls={z}>{d.companyName}</C> : null;
      case 'address': return d.address ? <C cls={z}>{d.address}</C> : null;
      case 'contact': return d.contact ? <C cls={z}>Contact no: {d.contact}</C> : null;
      case 'email': return d.email ? <C cls={z}>Email: {d.email}</C> : null;
      case 'fssai': return d.fssai ? <C cls={z}>FSSAI no: {d.fssai}</C> : null;
      case 'gstin': return (d.showGstin && gstin) ? <C cls={z}>GST no: {gstin}</C> : null;
      case 'orderType': return <><Rule /><C b cls={z}>{s.orderType}</C></>;
      case 'floorTable': return (s.floor || s.table) ? <L cls={z}>{s.floor}{s.floor && s.table ? ' : ' : ''}{s.table}</L> : null;
      case 'guestName': return s.guestName ? <L cls={z}>Guest Name: {s.guestName}</L> : null;
      case 'mobile': return s.guestMobile ? <L cls={z}>Mobile: {s.guestMobile}</L> : null;
      case 'dateTime': return <L cls={z}>Date &amp; Time: {nowStamp()}</L>;
      case 'captain': return s.captainName ? <L cls={z}>Captain Name: {s.captainName}</L> : null;
      case 'guestsOrder': return <><Rule /><L cls={z}>{twoCol(`Number of Guests: ${s.guests}`, `Order no: ${s.orderNo}`)}</L></>;
      case 'items': return (
        <>
          <Rule />
          <L b cls={z}>{itemRow('Item Name', 'Qty', 'Rate', 'Amt')}</L>
          <Rule />
          {s.items.map((it, i) => (
            <L key={i} cls={z}>{itemRow(it.name, String(it.qty), round2(it.rate).toFixed(2), round2(it.amount).toFixed(2))}</L>
          ))}
        </>
      );
      case 'subTotal': return <><Rule /><MoneyL size={ln.size}>{twoCol('Sub Total', billMoney(b.subtotal))}</MoneyL></>;
      case 'serviceCharge': return b.serviceCharge > 0 ? <MoneyL size={ln.size}>{twoCol('Service Charges', billMoney(b.serviceCharge))}</MoneyL> : null;
      case 'cgst': return b.cgst > 0 ? <MoneyL size={ln.size}>{twoCol(`CGST@${d.cgstPct}%`, billMoney(b.cgst))}</MoneyL> : null;
      case 'sgst': return b.sgst > 0 ? <MoneyL size={ln.size}>{twoCol(`SGST@${d.sgstPct}%`, billMoney(b.sgst))}</MoneyL> : null;
      case 'discount': return b.discount > 0 ? <MoneyL size={ln.size}>{twoCol('Discount', '-' + billMoney(b.discount))}</MoneyL> : null;
      case 'total': return <MoneyL b size={ln.size === 'normal' ? 'large' : ln.size}>{twoCol('TOTAL', billMoney(b.total))}</MoneyL>;
      case 'grandTotal': return <MoneyL b size={ln.size}>{twoCol('Grand Total', billMoney(Math.round(b.total)))}</MoneyL>;
      case 'payment': return (
        <>
          <MoneyL size={ln.size}>{twoCol(`Paid by ${s.paymentMethod.toUpperCase()}`, billMoney(Math.round(b.total)))}</MoneyL>
          <MoneyL size={ln.size}>{twoCol('Balance', billMoney(0))}</MoneyL>
        </>
      );
      case 'footer': return d.footerNote ? <C cls={z}>{d.footerNote}</C> : null;
      case 'printedBy': return <L cls={z}>Printed by {s.printedBy}</L>;
      case 'printedOn': return <L cls={z}>Printed on: {nowStamp()}</L>;
      default: return null;
    }
  };
  return <Ticket>{d.lines.filter((l) => l.enabled).map((ln) => <div key={ln.key}>{renderLine(ln)}</div>)}</Ticket>;
}

// ── Sticker KOT preview (one per-item label on the same 80mm thermal frame) ───
// A tiny mock QR: 3 corner finder squares + a scatter of data modules. Not a
// real QR (the printer renders the true one) — just faithful to the printed look.
function QrGlyph({ scale = 1 }: { scale?: number }) {
  const finders: Array<[number, number]> = [[0, 0], [52, 0], [0, 52]];
  const modules: Array<[number, number]> = [
    [28, 4], [36, 4], [28, 12], [44, 12], [28, 28], [36, 20], [44, 28],
    [36, 36], [28, 44], [44, 44], [52, 28], [60, 36], [52, 44], [60, 60],
    [28, 60], [36, 52], [44, 60], [52, 52], [20, 28], [12, 36], [4, 44],
  ];
  return (
    <svg width={72 * scale} height={72 * scale} viewBox="0 0 72 72" className="shrink-0" aria-hidden>
      <rect x="0" y="0" width="72" height="72" fill="white" />
      {finders.map(([x, y], i) => (
        <g key={i}>
          <rect x={x} y={y} width="20" height="20" fill="black" />
          <rect x={x + 4} y={y + 4} width="12" height="12" fill="white" />
          <rect x={x + 7} y={y + 7} width="6" height="6" fill="black" />
        </g>
      ))}
      {modules.map(([x, y], i) => <rect key={'m' + i} x={x} y={y} width="6" height="6" fill="black" />)}
    </svg>
  );
}
// A mock 1D barcode: ~24 black bars of varying widths with thin white gaps.
function BarcodeGlyph({ scale = 1 }: { scale?: number }) {
  const widths = [3, 1, 2, 4, 1, 2, 1, 3, 2, 1, 4, 2, 1, 3, 1, 2, 3, 1, 2, 1, 4, 2, 1, 3];
  let x = 1;
  const bars = widths.map((w, i) => {
    const rect = <rect key={i} x={x} y={0} width={w} height="40" fill="black" />;
    x += w + 2; // 2px white gap between bars
    return rect;
  });
  return <svg width={x * scale} height={40 * scale} viewBox={`0 0 ${x} 40`} className="shrink-0" aria-hidden>{bars}</svg>;
}

// Per-line size → CSS font-size (text lines) and glyph scale (the QR/barcode),
// approximating the sticker's 1x / 2x / 3x ESC-POS magnification on paper.
const STICKER_SIZE_PX: Record<StickerLineSize, number> = { normal: 13, large: 19, xlarge: 26 };
const STICKER_CODE_SCALE: Record<StickerLineSize, number> = { normal: 1, large: 1.35, xlarge: 1.7 };

// Preview mirrors the printed sticker: iterates the design's lines (enabled only,
// in order) so drag/resize/hide on the left reflect here immediately.
function StickerPreview({ design, codeType }: { design: StickerDesign; codeType: 'qr' | 'barcode' }) {
  const renderText = (ln: StickerLine) => {
    const fontSize = STICKER_SIZE_PX[ln.size];
    switch (ln.key) {
      case 'name': return <div className="font-bold leading-tight" style={{ fontSize }}>Paneer Tikka</div>;
      case 'tableKot': return <div style={{ fontSize }}>Table 7 | KOT #12</div>;
      case 'timeCaptain': return <div style={{ fontSize }}>07:45 PM | Capt: Ramesh</div>;
      case 'notes': return <div style={{ fontSize }}>* Less spicy</div>;   // sample has notes
      default: return null;
    }
  };

  const codeLine = design.lines.find((l) => l.key === 'code');
  const textLines = design.lines.filter((l) => l.enabled && l.key !== 'code');

  // QR mode → the QR sits BESIDE the details (details left, QR right column).
  if (codeType === 'qr' && codeLine?.enabled) {
    const sc = STICKER_CODE_SCALE[codeLine.size];
    return (
      <Ticket>
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            {textLines.map((ln) => <div key={ln.key} className="mt-1 first:mt-0">{renderText(ln)}</div>)}
          </div>
          {/* '#code' caption below the QR — the print carries it too */}
          <div className="shrink-0 text-center">
            <QrGlyph scale={sc} />
            <div className="text-[10px] mt-0.5">#7QF3K9</div>
          </div>
        </div>
      </Ticket>
    );
  }

  // Barcode (or QR hidden) → everything stacks top-to-bottom; barcode full-width.
  const renderLine = (ln: StickerLine) => {
    if (ln.key === 'code') {
      if (codeType !== 'barcode') return null;
      const sc = STICKER_CODE_SCALE[ln.size];
      return (
        <div>
          <div className="text-[11px] mb-1">#7QF3K9</div>
          <BarcodeGlyph scale={sc} />
        </div>
      );
    }
    return renderText(ln);
  };
  return (
    <Ticket>
      {design.lines.filter((l) => l.enabled).map((ln) => (
        <div key={ln.key} className="mt-1 first:mt-0">{renderLine(ln)}</div>
      ))}
    </Ticket>
  );
}

// ── Small form controls ──────────────────────────────────────────────────────
const Toggle = ({ label, on, set }: { label: string; on: boolean; set: (v: boolean) => void }) => (
  <label className="flex items-center justify-between gap-3 py-2 border-b border-[#F0E4D6] cursor-pointer">
    <span className="text-sm text-[#2D1B0E]">{label}</span>
    <UISwitch checked={on} onChange={set} size="sm" label={label} />
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
  const [tab, setTab] = useState<'kot' | 'bill' | 'sticker'>('kot');
  const [kot, setKot] = useState<KotDesign>(DEFAULT_KOT_DESIGN);
  const [bill, setBill] = useState<BillDesign>(DEFAULT_BILL_DESIGN);
  const [sticker, setSticker] = useState<StickerCfg>(DEFAULT_STICKER);
  const [stickerDesign, setStickerDesign] = useState<StickerDesign>(DEFAULT_STICKER_DESIGN);
  const [stkDragI, setStkDragI] = useState<number | null>(null);
  const [stkOverI, setStkOverI] = useState<number | null>(null);
  const [testing, setTesting] = useState(false);
  const [testStatus, setTestStatus] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [gstin, setGstin] = useState('');
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [dragI, setDragI] = useState<number | null>(null);
  const [overI, setOverI] = useState<number | null>(null);
  const [billDragI, setBillDragI] = useState<number | null>(null);
  const [billOverI, setBillOverI] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const all = (await (await api('/api/settings')).json()).settings || [];
      const get = (k: string) => all.find((s: any) => s.key === k)?.value;
      setBusinessName(get('business_name') || '');
      setGstin(get('gstin') || '');
      const kd = get('kot_design'); if (kd) try { setKot(normalizeKotDesign(JSON.parse(kd))); } catch {}
      const bd = get('bill_design'); if (bd) try { setBill(normalizeBillDesign(JSON.parse(bd))); } catch {}
      const sk = get('kot_item_labels');
      if (sk) try {
        const p = JSON.parse(sk) || {};
        setSticker({
          enabled: !!p.enabled,
          granularity: p.granularity === 'per_line' ? 'per_line' : 'per_unit',
          codeType: p.codeType === 'barcode' ? 'barcode' : 'qr',
        });
      } catch {}
      const sd = get('sticker_design'); if (sd) try { setStickerDesign(normalizeStickerDesign(JSON.parse(sd))); } catch {}
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function save() {
    setSaving(true); setError('');
    try {
      const r1 = await api('/api/settings', { method: 'PUT', body: { key: 'kot_design', value: JSON.stringify(kot) } });
      const r2 = await api('/api/settings', { method: 'PUT', body: { key: 'bill_design', value: JSON.stringify(bill) } });
      const r3 = await api('/api/settings', { method: 'PUT', body: { key: 'sticker_design', value: JSON.stringify(stickerDesign) } });
      if (!r1.ok || !r2.ok || !r3.ok) { setError('Could not save — please try again.'); return; }
      invalidateDesignCache();   // so the very next print uses the new design, not a ≤30s cached one
      setSaved(true); setTimeout(() => setSaved(false), 2500);
    } catch { setError('Could not save — please try again.'); }
    finally { setSaving(false); }
  }

  // Persist the sticker config — optimistic, and ALWAYS write the FULL object
  // (enabled + granularity preserved) so we never clobber the on/off toggle or
  // per-plate/per-line choice made in KOT & Bill Printers.
  async function persistSticker(next: StickerCfg) {
    setSticker(next);
    try {
      await api('/api/settings', { method: 'PUT', body: { key: 'kot_item_labels', value: JSON.stringify(next) } });
    } catch { /* optimistic — the next open re-reads the saved value */ }
  }

  // Fire ONE test sticker to the first active KOT station via the local bridge.
  async function printTestSticker() {
    setTesting(true); setTestStatus('');
    try {
      const j = await (await api('/api/dine-in/offline-print/stations')).json();
      const stations: any[] = j.stations || [];
      const st = stations.find((s) => s.role === 'kot' && s.is_active);
      if (!st) { setTestStatus('No KOT printer configured (set one up in KOT & Bill Printers)'); return; }
      const input = {
        itemName: 'Paneer Tikka',
        tableLabel: '7',
        kotNumber: 12,
        timeLabel: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true }),
        captain: 'Ramesh',
        code: 'TEST99',
        notes: 'Less spicy',
        codeType: sticker.codeType,
        design: stickerDesign,
      };
      // Same gate as print.ts: bridge v2.6+ takes raster bytes (label-style, QR
      // beside the details); older bridges get the legacy text layout (QR below).
      // Raster width matches the station's paper (58mm heads are 384 dots).
      const rasterOk = await bridgeSupportsRawB64();
      const doc = rasterOk
        ? { type: 'raw' as const, payload_b64: await buildKotStickerRasterB64(input, { widthDots: Number(st.paper_width) === 32 ? 384 : 576 }) }
        : { type: 'raw' as const, payload: buildKotStickerESCPOS(input) };
      const res = await bridgePrint({ printer: { transport: st.transport, target: st.target }, doc });
      // The update hint only applies in QR mode — in barcode mode the legacy and
      // raster layouts are positionally identical (text full width, strip below).
      if (res.ok) setTestStatus(rasterOk || sticker.codeType === 'barcode'
        ? `Test sticker sent to ${st.name} ✓`
        : `Test sticker sent to ${st.name} ✓ — Printed with the compatible layout (QR below) — update the print bridge to v2.6 for the label-style QR-beside layout.`);
      else setTestStatus('Printer/bridge not reachable — open /print/agent on the counter PC');
    } catch {
      setTestStatus('Printer/bridge not reachable — open /print/agent on the counter PC');
    } finally {
      setTesting(false);
    }
  }

  // KOT line-list helpers (drag to reorder + up/down buttons + per-line size/enable)
  const moveLine = (from: number, to: number) => {
    if (to < 0 || to >= kot.lines.length) return;
    const a = [...kot.lines]; const [x] = a.splice(from, 1); a.splice(to, 0, x);
    setKot({ ...kot, lines: a });
  };
  const setLine = (i: number, patch: Partial<KotLine>) =>
    setKot({ ...kot, lines: kot.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });

  // Bill line-list helpers (same drag/reorder + per-line size/enable as the KOT)
  const moveBillLine = (from: number, to: number) => {
    if (to < 0 || to >= bill.lines.length) return;
    const a = [...bill.lines]; const [x] = a.splice(from, 1); a.splice(to, 0, x);
    setBill({ ...bill, lines: a });
  };
  const setBillLine = (i: number, patch: Partial<BillLine>) =>
    setBill({ ...bill, lines: bill.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });

  // Sticker line-list helpers (drag/reorder + per-line size/enable) — same as KOT.
  const moveStickerLine = (from: number, to: number) => {
    if (to < 0 || to >= stickerDesign.lines.length) return;
    const a = [...stickerDesign.lines]; const [x] = a.splice(from, 1); a.splice(to, 0, x);
    setStickerDesign({ ...stickerDesign, lines: a });
  };
  const setStickerLine = (i: number, patch: Partial<StickerLine>) =>
    setStickerDesign({ ...stickerDesign, lines: stickerDesign.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });

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
      <p className="text-sm text-[#8B7355] mb-2">Design how the Food KOT and the Bill print. The preview updates live. After saving, the counter PC must run the latest <b>Print Bridge (v2.2.1+)</b> — re-download it from the <b>KOT &amp; Bill Printers</b> page and restart it — for the new KOT layout to print.</p>
      {error && (
        <div className="flex items-center gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      <div className="flex gap-1 mb-4 bg-[#FFF1E3] rounded-xl p-1 w-fit">
        {([['kot', 'Food KOT', ChefHat], ['bill', 'Bill', Receipt], ['sticker', 'Sticker KOT', Tag]] as const).map(([k, label, Icon]) => (
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
                    <UISwitch checked={ln.enabled} onChange={(v) => setLine(i, { enabled: v })} size="sm" label={`Show or hide ${KOT_LINE_LABELS[ln.key] ?? ln.key}`} />
                  </div>
                ))}
              </div>
              <Text label="Outlet name (blank = business name)" value={kot.outletName} set={(v) => setKot({ ...kot, outletName: v })} placeholder={businessName || 'Restaurant'} />
              <Text label="Header note (optional — enable the “Header note” line above)" value={kot.headerNote} set={(v) => setKot({ ...kot, headerNote: v })} placeholder="e.g. RUSH" />
              <Text label="Footer note (optional — enable the “Footer note” line above)" value={kot.footerNote} set={(v) => setKot({ ...kot, footerNote: v })} />

              {/* ── Paper saver (bridge v2.6+) ─────────────────────────────── */}
              <div className="mt-4 border border-[#E8D5C4] rounded-xl p-3 bg-[#FFFDF9]">
                <div className="flex items-center gap-2 mb-1">
                  <Scissors className="w-4 h-4 text-[#af4408]" />
                  <span className="text-sm font-semibold text-[#2D1B0E]">Paper saver</span>
                  <span className="text-[10px] text-[#8B7355] border border-[#E8D5C4] rounded-full px-2 py-0.5">bridge v2.6+</span>
                </div>
                <Toggle label="Compact cut — printer feeds the exact minimum before cutting"
                  on={kot.paperSaver.compactCut}
                  set={(v) => setKot({ ...kot, paperSaver: { ...kot.paperSaver, compactCut: v } })} />
                <label className="flex items-center justify-between gap-3 py-2">
                  <span className="text-sm text-[#2D1B0E]">Top pull-back (experimental) — reverse-feed before printing so the first line starts near the paper edge</span>
                  <select value={kot.paperSaver.pullBackLines}
                    onChange={(e) => setKot({ ...kot, paperSaver: { ...kot.paperSaver, pullBackLines: Number(e.target.value) } })}
                    className="border border-[#D4B896] rounded-lg px-2 py-1.5 text-sm bg-white shrink-0">
                    <option value={0}>Off</option>
                    <option value={1}>1 line</option>
                    <option value={2}>2 lines</option>
                    <option value={3}>3 lines</option>
                    <option value={4}>4 lines</option>
                  </select>
                </label>
                <p className="text-[11px] text-[#8B7355] mt-1">
                  Some printers ignore the pull-back — after saving, use <b>Print KOT test</b>: if the top margin
                  shrinks, keep it; if the first line clips, reduce by one. Requires print bridge v2.6+ on the counter PC.
                </p>
              </div>
            </>
          ) : tab === 'bill' ? (
            <>
              <p className="text-xs text-[#8B7355] mb-2">
                Reorder with the <b>↑ / ↓ arrows</b> (or drag the handle on desktop). <b>A / A+ / A++</b> sets each
                line's size; toggle to show/hide. Fewer lines &amp; smaller sizes use less paper.
              </p>
              <div className="mb-3">
                {bill.lines.map((ln, i) => (
                  <div key={ln.key} draggable
                    onDragStart={() => setBillDragI(i)}
                    onDragOver={(e) => { e.preventDefault(); setBillOverI(i); }}
                    onDrop={(e) => { e.preventDefault(); if (billDragI != null && billDragI !== i) moveBillLine(billDragI, i); setBillDragI(null); setBillOverI(null); }}
                    onDragEnd={() => { setBillDragI(null); setBillOverI(null); }}
                    className={`flex items-center gap-2 py-1.5 px-2 rounded-lg border mb-1 bg-white cursor-grab active:cursor-grabbing transition-colors
                      ${billOverI === i ? 'border-[#af4408] bg-[#af4408]/10' : 'border-[#F0E4D6]'} ${billDragI === i ? 'opacity-40' : ''} ${!ln.enabled ? 'opacity-60' : ''}`}>
                    <GripVertical className="w-4 h-4 text-[#C9B89F] shrink-0" />
                    <span className="text-sm text-[#2D1B0E] flex-1 truncate">{BILL_LINE_LABELS[ln.key]}</span>
                    <div className="flex flex-col -my-1 shrink-0">
                      <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => moveBillLine(i, i - 1)} className="text-[#8B7355] disabled:opacity-25 leading-none"><ChevronUp className="w-3.5 h-3.5" /></button>
                      <button type="button" aria-label="Move down" disabled={i === bill.lines.length - 1} onClick={() => moveBillLine(i, i + 1)} className="text-[#8B7355] disabled:opacity-25 leading-none"><ChevronDown className="w-3.5 h-3.5" /></button>
                    </div>
                    <select value={ln.size} onChange={(e) => setBillLine(i, { size: e.target.value as KotLineSize })}
                      className="border border-[#D4B896] rounded-lg px-1.5 py-1 text-xs shrink-0" aria-label="Line size">
                      <option value="normal">A</option>
                      <option value="large">A+</option>
                      <option value="xlarge">A++</option>
                    </select>
                    <UISwitch checked={ln.enabled} onChange={(v) => setBillLine(i, { enabled: v })} size="sm" label={`Show or hide ${BILL_LINE_LABELS[ln.key] ?? ln.key}`} />
                  </div>
                ))}
              </div>
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
          ) : (
            <>
              <p className="text-sm font-semibold text-[#2D1B0E] mb-1">Sticker KOT</p>
              <p className="text-xs text-[#8B7355] mb-4">
                This is how each item&apos;s sticker prints on your KOT printer. Turn stickers on/off and pick
                per-plate vs per-line in <b>KOT &amp; Bill Printers</b>.
              </p>

              <p className="text-xs font-semibold text-[#8B7355] uppercase tracking-wide mb-1">Fields — reorder, resize &amp; show/hide</p>
              <p className="text-[11px] text-[#8B7355] mb-2">Drag or use ↑/↓. A / A+ / A++ sets each line&apos;s letter size. Bigger sizes use more sticker.</p>
              <div className="mb-4">
                {stickerDesign.lines.map((ln, i) => (
                  <div key={ln.key}
                    draggable
                    onDragStart={() => setStkDragI(i)}
                    onDragOver={(e) => { e.preventDefault(); setStkOverI(i); }}
                    onDrop={() => { if (stkDragI !== null) moveStickerLine(stkDragI, i); setStkDragI(null); setStkOverI(null); }}
                    onDragEnd={() => { setStkDragI(null); setStkOverI(null); }}
                    className={`flex items-center gap-2 py-2 border-b border-[#F0E4D6] ${stkOverI === i ? 'bg-[#FFF1E3]' : ''}`}>
                    <GripVertical className="w-4 h-4 text-[#C4B09A] cursor-grab shrink-0" />
                    <span className="text-sm text-[#2D1B0E] flex-1 truncate">{STICKER_LINE_LABELS[ln.key]}</span>
                    <div className="flex flex-col -my-1 shrink-0">
                      <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => moveStickerLine(i, i - 1)} className="text-[#8B7355] disabled:opacity-25 leading-none"><ChevronUp className="w-3.5 h-3.5" /></button>
                      <button type="button" aria-label="Move down" disabled={i === stickerDesign.lines.length - 1} onClick={() => moveStickerLine(i, i + 1)} className="text-[#8B7355] disabled:opacity-25 leading-none"><ChevronDown className="w-3.5 h-3.5" /></button>
                    </div>
                    <select value={ln.size} onChange={(e) => setStickerLine(i, { size: e.target.value as StickerLineSize })}
                      className="border border-[#D4B896] rounded-lg px-1.5 py-1 text-xs shrink-0" aria-label="Line size">
                      <option value="normal">A</option>
                      <option value="large">A+</option>
                      <option value="xlarge">A++</option>
                    </select>
                    <UISwitch checked={ln.enabled} onChange={(v) => setStickerLine(i, { enabled: v })} size="sm" label={`Show or hide ${STICKER_LINE_LABELS[ln.key]}`} />
                  </div>
                ))}
              </div>

              <p className="text-xs font-semibold text-[#8B7355] uppercase tracking-wide mb-1">Scannable code</p>
              <div className="flex gap-1 bg-[#FFF1E3] rounded-xl p-1 mb-4">
                {([['qr', 'QR code'], ['barcode', 'Barcode']] as const).map(([val, label]) => (
                  <button key={val} type="button" onClick={() => persistSticker({ ...sticker, codeType: val })}
                    className={`flex-1 px-3 py-2 rounded-lg text-sm font-semibold transition-colors ${sticker.codeType === val ? 'bg-[#af4408] text-white' : 'bg-[#FFF1E3] text-[#6B5744]'}`}>
                    {label}{val === 'qr' ? ' (recommended)' : ''}
                  </button>
                ))}
              </div>

              <button type="button" onClick={printTestSticker} disabled={testing}
                className="w-full flex items-center justify-center gap-2 bg-[#af4408] text-white px-4 py-2.5 rounded-lg text-sm font-semibold disabled:opacity-50">
                {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" />}
                Print test sticker
              </button>
              {testStatus && <p className="text-xs text-[#8B7355] mt-2 text-center">{testStatus}</p>}
            </>
          )}
        </div>

        {/* Live preview */}
        <div>
          <p className="text-xs font-semibold text-[#8B7355] uppercase tracking-wide mb-2 text-center">Live preview (80mm)</p>
          {tab === 'kot' ? <KotPreview d={kot} businessName={businessName} />
            : tab === 'bill' ? <BillPreview d={bill} businessName={businessName} gstin={gstin} />
            : <StickerPreview design={stickerDesign} codeType={sticker.codeType} />}
        </div>
      </div>
    </div>
  );
}
