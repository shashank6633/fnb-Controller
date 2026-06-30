/**
 * High-level print helpers used by the POS pages. They build the ESC/POS doc
 * payloads, resolve which configured printer to use, and hand off to the
 * IndexedDB outbox (which prints immediately and retries on failure).
 *
 * Nothing here throws into the caller's flow — printing must never block firing
 * an order or settling a bill.
 */
import { api } from '@/lib/api';
import { enqueue, drainOutbox, ensureDrainLoop } from './outbox';
import type { PrinterTarget } from './bridge-client';

export interface PrintStation {
  id: string; name: string; role: 'bill' | 'kot'; station: string;
  transport: 'ip' | 'usb'; target: string; paper_width: number; copies: number; is_active: number;
  floor?: string; backup_target?: string; kind?: 'food' | 'bar'; is_master?: number; mirror_to_master?: number;
}

let stationCache: { at: number; rows: PrintStation[] } | null = null;

/** Configured print stations (cached briefly so firing is snappy). */
export async function getStations(force = false): Promise<PrintStation[]> {
  if (!force && stationCache && Date.now() - stationCache.at < 30000) return stationCache.rows;
  try {
    const r = await api('/api/dine-in/offline-print/stations');
    const rows: PrintStation[] = r.ok ? (await r.json()).stations || [] : [];
    stationCache = { at: Date.now(), rows };
    return rows;
  } catch {
    return stationCache?.rows || [];
  }
}

function norm(s: string) { return String(s || '').toLowerCase().trim(); }

/** Pick the printer for a KOT station (exact station match → any KOT printer). */
/**
 * Pick the printer for a fired KOT, FLOOR-AWARE (the table's zone = its floor):
 *  1. a printer mapped to this station on the SAME floor,
 *  2. a printer mapped to this station with no floor (global),
 *  3. any printer mapped to this station,
 *  4. no station printer → route by floor + kind: DRINKS (mocktail/cocktail/
 *     liquor) go to that floor's BAR; food to that floor's kitchen printer,
 *  5. the first KOT printer (last resort).
 * So drinks from a Floor-2 table land on the Floor-2 Bar without needing a
 * separate printer per drink station.
 */
function resolveKotPrinter(stations: PrintStation[], k: FiredKot): PrintStation | null {
  const kots = stations.filter((s) => s.role === 'kot' && s.is_active && Number(s.is_master) !== 1);
  if (kots.length === 0) return null;
  const fl = norm(k.zone || '');
  const matchStation = (s: PrintStation) => norm(s.station) === norm(k.station) || norm(s.name) === norm(k.station);
  let m = (fl ? kots.find((s) => matchStation(s) && norm(s.floor || '') === fl) : null)
       || kots.find((s) => matchStation(s) && !norm(s.floor || ''))
       || kots.find(matchStation);
  if (m) return m;
  const isDrink = (k.items || []).some((it) => it.item_type && it.item_type !== 'foods');
  const pool = kots.filter((s) => (s.kind === 'bar') === isDrink);
  m = (fl ? pool.find((s) => norm(s.floor || '') === fl) : null) || pool.find((s) => !norm(s.floor || '')) || pool[0];
  return m || kots[0];
}

/**
 * Pick the bill printer, FLOOR-AWARE (the table's zone = its floor):
 *  1. a bill printer on the SAME floor,
 *  2. a bill printer with no floor (a central/global counter),
 *  3. the first active bill printer (last resort).
 * So a Floor-2 table's bill prints on the Floor-2 cashier when one exists, and
 * still falls back to a single central counter otherwise.
 */
function resolveBillStation(stations: PrintStation[], floor?: string | null): PrintStation | null {
  const bills = stations.filter((s) => s.role === 'bill' && s.is_active);
  if (bills.length === 0) return null;
  const fl = norm(floor || '');
  return (fl ? bills.find((s) => norm(s.floor || '') === fl) : null)
      || bills.find((s) => !norm(s.floor || ''))
      || bills[0];
}

function targetOf(s: PrintStation): PrinterTarget {
  return { transport: s.transport, target: s.target, width: (s.paper_width === 32 ? 32 : 48) as 32 | 48 };
}

// ── KOT print design (Settings → Print Design). null fetch → sensible defaults. ─
export interface KotDesign {
  showOutlet: boolean; outletName: string; showFloor: boolean; showTable: boolean;
  showKotNo: boolean; showCopyLabel: boolean; showCaptain: boolean; showDateTime: boolean;
  headerNote: string; footerNote: string; fontScale: 'normal' | 'large';
}
export const DEFAULT_KOT_DESIGN: KotDesign = {
  showOutlet: true, outletName: '', showFloor: true, showTable: true,
  showKotNo: true, showCopyLabel: true, showCaptain: true, showDateTime: true,
  headerNote: '', footerNote: '', fontScale: 'normal',
};
let designCache: { at: number; d: KotDesign } | null = null;
export async function getKotDesign(force = false): Promise<KotDesign> {
  if (!force && designCache && Date.now() - designCache.at < 30000) return designCache.d;
  try {
    const r = await api('/api/settings?key=kot_design');
    const v = r.ok ? (await r.json()).value : null;
    const d = v ? { ...DEFAULT_KOT_DESIGN, ...JSON.parse(v) } : DEFAULT_KOT_DESIGN;
    designCache = { at: Date.now(), d };
    return d;
  } catch { return designCache?.d || DEFAULT_KOT_DESIGN; }
}

/** ORIGINAL / DUPLICATE / DUPLICATE N from a reprint count (0 = original). */
export function copyLabel(reprintCount?: number): string {
  const n = Number(reprintCount) || 0;
  return n <= 0 ? 'ORIGINAL' : n === 1 ? 'DUPLICATE' : `DUPLICATE ${n}`;
}

// ── KOT (from a fired_kot returned by the order fire action) ──────────────────
export interface FiredKot {
  id: string; station: string; kot_number?: number;
  order_number?: number | string; order_type?: string; table_number?: string | null;
  zone?: string | null;   // the table's zone = its floor (drives floor-aware routing)
  captain?: string | null;        // 1st captain — who opened the table
  fired_by?: string | null;       // captain who punched this KOT
  reprint_count?: number;         // 0 = ORIGINAL, ≥1 = DUPLICATE N
  items: Array<{ name: string; quantity: number; notes?: string; item_type?: string }>;
}

export async function printFiredKots(firedKots: FiredKot[]): Promise<void> {
  if (!firedKots?.length) return;
  ensureDrainLoop();
  const stations = await getStations();
  const design = await getKotDesign();
  const shop = await getShop();
  const time = new Date().toISOString();
  // Items accumulated per kind (food/bar) for the MASTER/expediter copy; each
  // carries its station's floor so a floor-scoped master takes only its floor.
  const byKind: Record<string, Array<{ qty: number; name: string; notes?: string; floor: string }>> = {};

  for (const k of firedKots) {
    const st = resolveKotPrinter(stations, k);
    if (!st) continue; // no KOT printer configured — skip silently
    const doc = {
      type: 'kot' as const,
      station: k.station || st.name,
      outletName: design.showOutlet ? (design.outletName || shop.name) : undefined,
      floor: design.showFloor ? (k.zone || undefined) : undefined,
      table: design.showTable ? (k.table_number || undefined) : undefined,
      kotNumber: design.showKotNo ? k.kot_number : undefined,
      copyLabel: design.showCopyLabel ? copyLabel(k.reprint_count) : undefined,
      captain: design.showCaptain ? (k.captain || undefined) : undefined,
      firedBy: design.showCaptain ? (k.fired_by || undefined) : undefined,
      orderType: k.order_type,
      orderRef: k.order_number != null ? String(k.order_number) : undefined,
      time: design.showDateTime ? time : undefined,
      headerNote: design.headerNote || undefined,
      footerNote: design.footerNote || undefined,
      fontScale: design.fontScale,
      items: (k.items || []).map((it) => ({ qty: it.quantity, name: it.name, notes: it.notes || undefined })),
    };
    const copies = Math.max(1, Math.min(5, Number(st.copies) || 1));
    // Reprints get a distinct id (…_r1, _r2) so the outbox actually prints them
    // again; the original (reprint_count 0) keeps its stable id → never doubles.
    const rc = Number(k.reprint_count) || 0;
    const baseId = rc > 0 ? `kot_${k.id}_r${rc}` : `kot_${k.id}`;
    for (let c = 0; c < copies; c++) {
      await enqueue({
        id: copies > 1 ? `${baseId}_c${c}` : baseId,  // stable per KOT(+reprint+copy) → dedup
        printer: targetOf(st), backup: st.backup_target || undefined, doc,
        meta: { stationId: st.id, stationName: st.name, docType: 'kot', source: 'fire', refId: k.id },
      });
    }
    // Expediter copy — ONLY if this station is configured to mirror to the Main
    // printer ("Send duplicate KOT to Main Kitchen"). Stations on other floors /
    // separate kitchens (e.g. Pizza, Tandoor) can be excluded per-station.
    const mirrors = st.mirror_to_master === undefined ? true : Number(st.mirror_to_master) !== 0;
    if (mirrors) {
      // Tag each item with its station for cross-checking. Classify food/bar by
      // the MENU item_type (foods → food; liquors/beverages → bar) so the Main
      // Kitchen stays strictly food even if a station's Group is mis-set; fall
      // back to the station printer's kind if unknown.
      const stationKind = st.kind === 'bar' ? 'bar' : 'food';
      const label = (k.station || st.name || '').toUpperCase();
      // Master floor scoping follows the TABLE's floor (where the order is),
      // falling back to the resolved printer's floor.
      const stFloor = String(k.zone || st.floor || '').trim().toLowerCase();
      for (const it of (k.items || [])) {
        const kind = it.item_type ? (it.item_type === 'foods' ? 'food' : 'bar') : stationKind;
        (byKind[kind] ||= []).push({ qty: it.quantity, name: label ? `[${label}] ${it.name}` : it.name, notes: it.notes || undefined, floor: stFloor });
      }
    }
  }

  // MASTER / expediter: one consolidated ticket of all fired items of a kind,
  // printed at every printer flagged is_master for that kind (e.g. the Main
  // Kitchen counter printer). Stable id per fire → never double-prints.
  const masters = stations.filter((s) => s.role === 'kot' && s.is_active && Number(s.is_master) === 1);
  const fireKey = firedKots.map((k) => k.id).filter(Boolean).sort()[0] || String(Date.now());
  const k0 = firedKots[0];
  for (const m of masters) {
    const kind = m.kind === 'bar' ? 'bar' : 'food';
    const mFloor = String(m.floor || '').trim().toLowerCase();
    // A master with a floor set takes only that floor's stations; a master with
    // no floor is global (all floors of its kind).
    const pool = byKind[kind] || [];
    const items = (mFloor ? pool.filter((x) => x.floor === mFloor) : pool).map(({ floor, ...rest }) => rest);
    if (!items.length) continue;
    const doc = {
      type: 'kot' as const,
      station: m.name || (kind === 'bar' ? 'MAIN BAR' : 'MAIN KITCHEN'),
      kotNumber: k0?.kot_number,
      table: k0?.table_number || undefined,
      orderType: k0?.order_type,
      orderRef: k0?.order_number != null ? String(k0.order_number) : undefined,
      time,
      items,
      note: 'EXPEDITER — CROSS-CHECK',
    };
    await enqueue({
      id: `master_${m.id}_${fireKey}`,
      printer: targetOf(m), backup: m.backup_target || undefined, doc,
      meta: { stationId: m.id, stationName: m.name, docType: 'kot', source: 'fire', refId: fireKey },
    });
  }

  await drainOutbox();
}

// ── Bill (from the loaded order at settle time) ───────────────────────────────
export interface BillOrder {
  id: string; order_number?: number | string; table_number?: string | null; order_type?: string;
  zone?: string | null;   // the table's zone = its floor (drives floor-aware bill routing)
  server_name?: string; subtotal: number; tax_total: number; discount: number; total: number;
  payment_method?: string;
  items: Array<{ name: string; quantity: number; unit_price: number; line_total: number }>;
}

let shopCache: { name: string; gstin: string } | null = null;
/** Read settings (which is an ARRAY of {key,value}) → business_name + gstin. */
async function getShop(): Promise<{ name: string; gstin: string }> {
  if (shopCache) return shopCache;
  try {
    const r = await api('/api/settings');
    const arr: any[] = r.ok ? ((await r.json()).settings || []) : [];
    const get = (k: string) => arr.find((x) => x.key === k)?.value;
    shopCache = { name: get('business_name') || 'Restaurant', gstin: get('gstin') || '' };
  } catch { shopCache = { name: 'Restaurant', gstin: '' }; }
  return shopCache;
}

let billDesignCache: { at: number; d: any } | null = null;
async function getBillDesign(): Promise<any> {
  const DEF = { shopName: '', showGstin: true, showServer: true, headerNote: '', footerNote: '', fontScale: 'normal' };
  if (billDesignCache && Date.now() - billDesignCache.at < 30000) return billDesignCache.d;
  try {
    const r = await api('/api/settings?key=bill_design');
    const v = r.ok ? (await r.json()).value : null;
    const d = v ? { ...DEF, ...JSON.parse(v) } : DEF;
    billDesignCache = { at: Date.now(), d };
    return d;
  } catch { return billDesignCache?.d || DEF; }
}

export async function printBill(order: BillOrder): Promise<{ ok: boolean; reason?: string }> {
  ensureDrainLoop();
  const stations = await getStations();
  const st = resolveBillStation(stations, order.zone);
  if (!st) return { ok: false, reason: 'No bill printer configured' };
  const shop = await getShop();
  const design = await getBillDesign();
  const tax = Number(order.tax_total) > 0 ? [{ label: 'Tax', amount: Number(order.tax_total) }] : [];
  const doc = {
    type: 'bill' as const,
    shopName: design.shopName || shop.name,
    gstin: design.showGstin ? (shop.gstin || undefined) : undefined,
    headerNote: design.headerNote || undefined,
    billNo: order.order_number != null ? String(order.order_number) : undefined,
    table: order.table_number || undefined,
    server: design.showServer ? (order.server_name || undefined) : undefined,
    date: new Date().toISOString(),
    fontScale: design.fontScale,
    items: (order.items || []).map((it) => ({ name: it.name, qty: it.quantity, price: it.unit_price, amount: it.line_total })),
    subtotal: Number(order.subtotal) || 0,
    discount: Number(order.discount) || 0,
    tax,
    total: Number(order.total) || 0,
    footer: design.footerNote || (order.payment_method ? `Paid by ${order.payment_method.toUpperCase()} — thank you!` : 'Thank you! Visit again.'),
  };
  await enqueue({
    id: `bill_${order.id}`,                     // stable per order → never double-prints
    printer: targetOf(st), backup: st.backup_target || undefined, doc,
    meta: { stationId: st.id, stationName: st.name, docType: 'bill', source: 'bill', refId: order.id },
  });
  await drainOutbox();
  return { ok: true };
}
