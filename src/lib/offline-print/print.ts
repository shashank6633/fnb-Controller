/**
 * High-level print helpers used by the POS pages. They build the ESC/POS doc
 * payloads, resolve which configured printer to use, and hand off to the
 * IndexedDB outbox (which prints immediately and retries on failure).
 *
 * Nothing here throws into the caller's flow — printing must never block firing
 * an order or settling a bill.
 */
import { api } from '@/lib/api';
import { computeBill } from '@/lib/bill-calc';
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

// ── KOT print design (Settings → Print Design) ───────────────────────────────
// The KOT layout is an ORDERED list of line-elements, each independently
// enabled and sized. The bridge renders enabled lines top-to-bottom at their
// size; the Settings page edits this list (drag to reorder, per-line A/A+/A++).
// Fewer lines + smaller sizes = less paper.
export type KotLineKey =
  | 'table' | 'outlet' | 'floor' | 'kotNo' | 'copyLabel' | 'foodLiquor'
  | 'captain' | 'puncher' | 'dateTime' | 'headerNote'
  | 'items' | 'totalItems' | 'footerNote';
export type KotLineSize = 'normal' | 'large' | 'xlarge';
export interface KotLine { key: KotLineKey; enabled: boolean; size: KotLineSize; }

export const KOT_LINE_LABELS: Record<KotLineKey, string> = {
  table: 'Table number', outlet: 'Outlet name', floor: 'Floor',
  kotNo: 'KOT number + station', copyLabel: 'Original / Duplicate',
  foodLiquor: 'Food / Liquor band', captain: 'Captain',
  puncher: 'Punched by (only if another captain punches)', dateTime: 'Date & time',
  headerNote: 'Header note', items: 'Items', totalItems: 'Total items', footerNote: 'Footer note',
};

export const DEFAULT_KOT_LINES: KotLine[] = [
  { key: 'table',      enabled: true,  size: 'xlarge' },
  { key: 'outlet',     enabled: true,  size: 'large' },
  { key: 'floor',      enabled: true,  size: 'normal' },
  { key: 'kotNo',      enabled: true,  size: 'normal' },
  { key: 'copyLabel',  enabled: true,  size: 'large' },
  { key: 'foodLiquor', enabled: true,  size: 'large' },
  { key: 'captain',    enabled: true,  size: 'normal' },
  { key: 'puncher',    enabled: true,  size: 'normal' },
  { key: 'dateTime',   enabled: true,  size: 'normal' },
  { key: 'headerNote', enabled: false, size: 'normal' },
  { key: 'items',      enabled: true,  size: 'normal' },
  { key: 'totalItems', enabled: true,  size: 'normal' },
  { key: 'footerNote', enabled: false, size: 'normal' },
];

export interface KotDesign {
  lines: KotLine[];
  outletName: string;
  headerNote: string;
  footerNote: string;
}
export const DEFAULT_KOT_DESIGN: KotDesign = {
  lines: DEFAULT_KOT_LINES, outletName: '', headerNote: '', footerNote: '',
};

const VALID_KOT_KEYS = new Set<string>(DEFAULT_KOT_LINES.map((l) => l.key));

// Map a LEGACY flat design (showOutlet/showFloor/… + fontScale, from before the
// lines[] model) onto the line list so an older saved config keeps the user's
// hidden lines and big-item choice instead of silently resetting to defaults.
function legacyLines(src: any): KotLine[] {
  const flag: Partial<Record<KotLineKey, string>> = {
    outlet: 'showOutlet', floor: 'showFloor', table: 'showTable', kotNo: 'showKotNo',
    copyLabel: 'showCopyLabel', captain: 'showCaptain', puncher: 'showCaptain', dateTime: 'showDateTime',
  };
  const itemSize: KotLineSize = src.fontScale === 'large' ? 'large' : 'normal';
  return DEFAULT_KOT_LINES.map((def) => {
    const f = flag[def.key];
    const enabled = f && typeof src[f] === 'boolean' ? src[f]
      : def.key === 'headerNote' ? !!src.headerNote
      : def.key === 'footerNote' ? !!src.footerNote
      : def.enabled;
    return { key: def.key, enabled, size: def.key === 'items' ? itemSize : def.size };
  });
}

/**
 * Merge a saved (possibly older/partial/hostile) design over the defaults,
 * GUARANTEEING a complete, valid lines[]: every known key present exactly once,
 * kept in saved order, unknown keys dropped, missing keys (e.g. a newly-added
 * `foodLiquor`) appended. Inherited Object.prototype names ('constructor',
 * '__proto__', …) can't slip through — membership is a Set, not a bracket
 * lookup. Used by both the Settings page and the printer so the preview and the
 * real ticket can never disagree.
 */
export function normalizeKotDesign(raw: any): KotDesign {
  const src = raw && typeof raw === 'object' ? raw : {};
  const d: KotDesign = {
    lines: DEFAULT_KOT_LINES,
    outletName: typeof src.outletName === 'string' ? src.outletName : '',
    headerNote: typeof src.headerNote === 'string' ? src.headerNote : '',
    footerNote: typeof src.footerNote === 'string' ? src.footerNote : '',
  };
  // Legacy flat design (no lines[]) → map the old show* booleans onto lines.
  if (!Array.isArray(src.lines) && (src.showOutlet !== undefined || src.showTable !== undefined || src.fontScale !== undefined)) {
    d.lines = legacyLines(src);
    return d;
  }
  const ordered: KotLine[] = [];
  const seen = new Set<string>();
  for (const l of Array.isArray(src.lines) ? src.lines : []) {
    const key = l && typeof l.key === 'string' ? l.key : '';
    if (!key || seen.has(key) || !VALID_KOT_KEYS.has(key)) continue;
    const def = DEFAULT_KOT_LINES.find((x) => x.key === key);
    if (!def) continue;
    ordered.push({
      key: key as KotLineKey,
      enabled: typeof l.enabled === 'boolean' ? l.enabled : def.enabled,
      size: (['normal', 'large', 'xlarge'].includes(l.size) ? l.size : def.size) as KotLineSize,
    });
    seen.add(key);
  }
  for (const def of DEFAULT_KOT_LINES) if (!seen.has(def.key)) ordered.push({ ...def });
  d.lines = ordered;
  return d;
}

let designCache: { at: number; d: KotDesign } | null = null;
export async function getKotDesign(force = false): Promise<KotDesign> {
  if (!force && designCache && Date.now() - designCache.at < 30000) return designCache.d;
  try {
    const r = await api('/api/settings?key=kot_design');
    const v = r.ok ? (await r.json()).value : null;
    const d = v ? normalizeKotDesign(JSON.parse(v)) : DEFAULT_KOT_DESIGN;
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
    // FOOD vs LIQUOR band for this KOT: any non-food line (liquors/beverages)
    // → LIQUOR; all-food → FOOD; no item_type at all → fall back to the
    // resolved station's kind (also used by the master per-item split; note the
    // floor/kind routing in resolveKotPrinter treats all-NULL as food).
    const types = (k.items || []).map((it) => it.item_type).filter(Boolean) as string[];
    const kotKind = types.length === 0
      ? (st.kind === 'bar' ? 'bar' : 'food')
      : (types.some((t) => t !== 'foods') ? 'bar' : 'food');
    const doc = {
      type: 'kot' as const,
      station: k.station || st.name,
      lines: design.lines,                                 // ordered, per-line enable + size
      outletName: design.outletName || shop.name,
      floor: k.zone || undefined,
      table: k.table_number || undefined,
      kotNumber: k.kot_number,
      copyLabel: copyLabel(k.reprint_count),
      foodLiquor: kotKind === 'bar' ? 'LIQUOR' : 'FOOD',
      captain: k.captain || undefined,
      firedBy: k.fired_by || undefined,                    // bridge shows "Punched by" only if it differs
      orderType: k.order_type,
      orderRef: k.order_number != null ? String(k.order_number) : undefined,
      time,
      headerNote: design.headerNote || undefined,
      footerNote: design.footerNote || undefined,
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
      foodLiquor: kind === 'bar' ? 'LIQUOR' : 'FOOD',
      orderType: k0?.order_type,
      orderRef: k0?.order_number != null ? String(k0.order_number) : undefined,
      time,
      items,                          // no `lines` → bridge uses its default order
      note: 'EXPEDITER - CROSS-CHECK',   // ASCII '-' (line() encodes ascii; an em-dash prints as a stray byte)
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
  table_id?: string | null;              // present => DINE-IN, absent => PARCEL
  covers?: number | null;                // guest count
  guest_name?: string | null; guest_mobile?: string | null;
  service_charge_reason?: string | null; // non-empty => cashier removed the service charge
  discount_pct?: number | null;          // % discount (drives computeBill)
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

/** Drop the in-memory design caches so the very NEXT print re-fetches — called
 *  right after a save so a new layout applies immediately, not up to 30s later. */
export function invalidateDesignCache(): void { designCache = null; billDesignCache = null; }

// ── Bill print design — same ordered lines[] model as the KOT: drag to reorder,
// per-line A/A+/A++ size, show/hide. Content fields (header text, tax %) live
// alongside; the bridge renders enabled lines in order at their size.
export type BillLineKey =
  | 'brand' | 'company' | 'address' | 'contact' | 'email' | 'fssai' | 'gstin'
  | 'orderType' | 'floorTable' | 'guestName' | 'mobile' | 'dateTime' | 'captain'
  | 'guestsOrder' | 'items' | 'subTotal' | 'serviceCharge' | 'cgst' | 'sgst'
  | 'discount' | 'total' | 'grandTotal' | 'payment' | 'footer' | 'printedBy' | 'printedOn';
export interface BillLine { key: BillLineKey; enabled: boolean; size: KotLineSize; }

export const BILL_LINE_LABELS: Record<BillLineKey, string> = {
  brand: 'Brand name', company: 'Company name', address: 'Address', contact: 'Contact no',
  email: 'Email', fssai: 'FSSAI no', gstin: 'GST no', orderType: 'Dine-in / Parcel',
  floorTable: 'Floor : Table', guestName: 'Guest name', mobile: 'Mobile', dateTime: 'Date & time',
  captain: 'Captain name', guestsOrder: 'Guests + Order no', items: 'Items table',
  subTotal: 'Sub Total', serviceCharge: 'Service charges', cgst: 'CGST', sgst: 'SGST',
  discount: 'Discount', total: 'Total', grandTotal: 'Grand Total', payment: 'Payment (paid / balance)',
  footer: 'Footer note', printedBy: 'Printed by', printedOn: 'Printed on',
};

export const DEFAULT_BILL_LINES: BillLine[] = [
  { key: 'brand', enabled: true, size: 'xlarge' },
  { key: 'company', enabled: true, size: 'normal' },
  { key: 'address', enabled: true, size: 'normal' },
  { key: 'contact', enabled: true, size: 'normal' },
  { key: 'email', enabled: true, size: 'normal' },
  { key: 'fssai', enabled: true, size: 'normal' },
  { key: 'gstin', enabled: true, size: 'normal' },
  { key: 'orderType', enabled: true, size: 'large' },
  { key: 'floorTable', enabled: true, size: 'normal' },
  { key: 'guestName', enabled: true, size: 'normal' },
  { key: 'mobile', enabled: true, size: 'normal' },
  { key: 'dateTime', enabled: true, size: 'normal' },
  { key: 'captain', enabled: true, size: 'normal' },
  { key: 'guestsOrder', enabled: true, size: 'normal' },
  { key: 'items', enabled: true, size: 'normal' },
  { key: 'subTotal', enabled: true, size: 'normal' },
  { key: 'serviceCharge', enabled: true, size: 'normal' },
  { key: 'cgst', enabled: true, size: 'normal' },
  { key: 'sgst', enabled: true, size: 'normal' },
  { key: 'discount', enabled: true, size: 'normal' },
  { key: 'total', enabled: true, size: 'large' },
  { key: 'grandTotal', enabled: true, size: 'large' },
  { key: 'payment', enabled: true, size: 'normal' },
  { key: 'footer', enabled: false, size: 'normal' },
  { key: 'printedBy', enabled: true, size: 'normal' },
  { key: 'printedOn', enabled: true, size: 'normal' },
];

export interface BillDesign {
  lines: BillLine[];
  brandName: string; companyName: string; address: string; contact: string; email: string; fssai: string;
  showGstin: boolean; showServer: boolean;
  serviceChargeOn: boolean; serviceChargePct: number; cgstPct: number; sgstPct: number;
  headerNote: string; footerNote: string;
}
export const DEFAULT_BILL_DESIGN: BillDesign = {
  lines: DEFAULT_BILL_LINES,
  brandName: '', companyName: '', address: '', contact: '', email: '', fssai: '',
  showGstin: true, showServer: true,
  serviceChargeOn: false, serviceChargePct: 0, cgstPct: 2.5, sgstPct: 2.5,
  headerNote: '', footerNote: '',
};

const VALID_BILL_KEYS = new Set<string>(DEFAULT_BILL_LINES.map((l) => l.key));
/** Merge a saved bill design over defaults, guaranteeing a complete valid lines[]
 *  (prototype-safe; unknown keys dropped; new keys appended). */
export function normalizeBillDesign(raw: any): BillDesign {
  const src = raw && typeof raw === 'object' ? raw : {};
  const d: BillDesign = { ...DEFAULT_BILL_DESIGN, ...src, lines: DEFAULT_BILL_LINES };
  const ordered: BillLine[] = [];
  const seen = new Set<string>();
  for (const l of Array.isArray(src.lines) ? src.lines : []) {
    const key = l && typeof l.key === 'string' ? l.key : '';
    if (!key || seen.has(key) || !VALID_BILL_KEYS.has(key)) continue;
    const def = DEFAULT_BILL_LINES.find((x) => x.key === key);
    if (!def) continue;
    ordered.push({ key: key as BillLineKey, enabled: typeof l.enabled === 'boolean' ? l.enabled : def.enabled, size: (['normal', 'large', 'xlarge'].includes(l.size) ? l.size : def.size) as KotLineSize });
    seen.add(key);
  }
  for (const def of DEFAULT_BILL_LINES) if (!seen.has(def.key)) ordered.push({ ...def });
  d.lines = ordered;
  return d;
}

let billDesignCache: { at: number; d: BillDesign } | null = null;
async function getBillDesign(): Promise<BillDesign> {
  if (billDesignCache && Date.now() - billDesignCache.at < 30000) return billDesignCache.d;
  try {
    const r = await api('/api/settings?key=bill_design');
    const v = r.ok ? (await r.json()).value : null;
    const d = v ? normalizeBillDesign(JSON.parse(v)) : DEFAULT_BILL_DESIGN;
    billDesignCache = { at: Date.now(), d };
    return d;
  } catch { return billDesignCache?.d || DEFAULT_BILL_DESIGN; }
}

export async function printBill(order: BillOrder, printedBy?: string): Promise<{ ok: boolean; reason?: string }> {
  ensureDrainLoop();
  const stations = await getStations();
  const st = resolveBillStation(stations, order.zone);
  if (!st) return { ok: false, reason: 'No bill printer configured' };
  const shop = await getShop();
  const design = await getBillDesign();
  // Single source of truth for the money breakdown (same helper the settle route
  // uses to store the authoritative total) → printed bill can never disagree.
  const subtotal = Number(order.subtotal) || 0;
  const b = computeBill(
    {
      subtotal,
      // order.tax_total is the per-item GST (food 5% / liquor 0%) computed at
      // add/settle time — pass it so the printed bill matches the charged total.
      itemTax: Number(order.tax_total) || 0,
      serviceRemoved: !!(order.service_charge_reason && String(order.service_charge_reason).trim()),
      discount_pct: order.discount_pct == null ? undefined : Number(order.discount_pct),
      discount: Number(order.discount) || 0,
    },
    {
      serviceChargePct: Number(design.serviceChargePct) || 0,
      serviceChargeOn: design.serviceChargeOn !== false,
      cgstPct: Number(design.cgstPct) || 0,
      sgstPct: Number(design.sgstPct) || 0,
    },
  );
  const doc = {
    type: 'bill' as const,
    lines: design.lines,                                    // ordered, per-line enable + size
    brandName: design.brandName || shop.name,
    companyName: design.companyName || undefined,
    address: design.address || undefined,
    contact: design.contact || undefined,
    email: design.email || undefined,
    fssai: design.fssai || undefined,
    gstin: design.showGstin ? (shop.gstin || undefined) : undefined,
    orderType: order.table_id ? 'DINE-IN' : 'PARCEL',
    floor: order.zone || undefined,
    table: order.table_number || undefined,
    guestName: order.guest_name || undefined,
    guestMobile: order.guest_mobile || undefined,
    captainName: order.server_name || undefined,
    orderNo: order.order_number != null ? String(order.order_number) : undefined,
    guests: Number(order.covers) || 0,
    items: (order.items || []).map((it) => ({ name: it.name, qty: it.quantity, rate: it.unit_price, amount: it.line_total })),
    subtotal: b.subtotal,
    serviceCharge: b.serviceCharge,
    cgstPct: Number(design.cgstPct) || 0,
    cgst: b.cgst,
    sgstPct: Number(design.sgstPct) || 0,
    sgst: b.sgst,
    discount: b.discount,
    discountPct: order.discount_pct == null ? 0 : Number(order.discount_pct) || 0,
    total: b.total,
    grandTotal: Math.round(b.total),                        // final payable, rounded
    // Payment line — only once settled (payment_method set). Full payment => balance 0.
    paymentMethod: order.payment_method || undefined,
    amountPaid: order.payment_method ? Math.round(b.total) : undefined,
    balance: order.payment_method ? 0 : undefined,
    footer: design.footerNote || undefined,
    printedBy: printedBy || order.server_name || undefined,
    date: new Date().toISOString(),
  };
  await enqueue({
    id: `bill_${order.id}`,                     // stable per order → never double-prints
    printer: targetOf(st), backup: st.backup_target || undefined, doc,
    meta: { stationId: st.id, stationName: st.name, docType: 'bill', source: 'bill', refId: order.id },
  });
  await drainOutbox();
  return { ok: true };
}
