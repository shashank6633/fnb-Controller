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

// ── KOT (from a fired_kot returned by the order fire action) ──────────────────
export interface FiredKot {
  id: string; station: string; kot_number?: number;
  order_number?: number | string; order_type?: string; table_number?: string | null;
  zone?: string | null;   // the table's zone = its floor (drives floor-aware routing)
  items: Array<{ name: string; quantity: number; notes?: string; item_type?: string }>;
}

export async function printFiredKots(firedKots: FiredKot[]): Promise<void> {
  if (!firedKots?.length) return;
  ensureDrainLoop();
  const stations = await getStations();
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
      kotNumber: k.kot_number,
      table: k.table_number || undefined,
      orderType: k.order_type,
      orderRef: k.order_number != null ? String(k.order_number) : undefined,
      time,
      items: (k.items || []).map((it) => ({ qty: it.quantity, name: it.name, notes: it.notes || undefined })),
    };
    const copies = Math.max(1, Math.min(5, Number(st.copies) || 1));
    for (let c = 0; c < copies; c++) {
      await enqueue({
        id: copies > 1 ? `kot_${k.id}_c${c}` : `kot_${k.id}`,  // stable per KOT(+copy) → dedup
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
async function getShop(): Promise<{ name: string; gstin: string }> {
  if (shopCache) return shopCache;
  try {
    const r = await api('/api/settings');
    const s = r.ok ? await r.json() : {};
    const map = s.settings || s || {};
    shopCache = { name: map.business_name || 'Restaurant', gstin: map.gstin || '' };
  } catch { shopCache = { name: 'Restaurant', gstin: '' }; }
  return shopCache;
}

export async function printBill(order: BillOrder): Promise<{ ok: boolean; reason?: string }> {
  ensureDrainLoop();
  const stations = await getStations();
  const st = resolveBillStation(stations, order.zone);
  if (!st) return { ok: false, reason: 'No bill printer configured' };
  const shop = await getShop();
  const tax = Number(order.tax_total) > 0 ? [{ label: 'Tax', amount: Number(order.tax_total) }] : [];
  const doc = {
    type: 'bill' as const,
    shopName: shop.name, gstin: shop.gstin || undefined,
    billNo: order.order_number != null ? String(order.order_number) : undefined,
    table: order.table_number || undefined,
    server: order.server_name || undefined,
    date: new Date().toISOString(),
    items: (order.items || []).map((it) => ({ name: it.name, qty: it.quantity, price: it.unit_price, amount: it.line_total })),
    subtotal: Number(order.subtotal) || 0,
    discount: Number(order.discount) || 0,
    tax,
    total: Number(order.total) || 0,
    footer: order.payment_method ? `Paid by ${order.payment_method.toUpperCase()} — thank you!` : 'Thank you! Visit again.',
  };
  await enqueue({
    id: `bill_${order.id}`,                     // stable per order → never double-prints
    printer: targetOf(st), backup: st.backup_target || undefined, doc,
    meta: { stationId: st.id, stationName: st.name, docType: 'bill', source: 'bill', refId: order.id },
  });
  await drainOutbox();
  return { ok: true };
}
