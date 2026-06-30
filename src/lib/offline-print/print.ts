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
  floor?: string; backup_target?: string; kind?: 'food' | 'bar'; is_master?: number;
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
function resolveKotStation(stations: PrintStation[], stationName: string): PrintStation | null {
  const kots = stations.filter((s) => s.role === 'kot' && s.is_active);
  if (kots.length === 0) return null;
  const exact = kots.find((s) => norm(s.station) === norm(stationName) || norm(s.name) === norm(stationName));
  return exact || kots[0];
}

function resolveBillStation(stations: PrintStation[]): PrintStation | null {
  return stations.find((s) => s.role === 'bill' && s.is_active) || null;
}

function targetOf(s: PrintStation): PrinterTarget {
  return { transport: s.transport, target: s.target, width: (s.paper_width === 32 ? 32 : 48) as 32 | 48 };
}

// ── KOT (from a fired_kot returned by the order fire action) ──────────────────
export interface FiredKot {
  id: string; station: string; kot_number?: number;
  order_number?: number | string; order_type?: string; table_number?: string | null;
  items: Array<{ name: string; quantity: number; notes?: string }>;
}

export async function printFiredKots(firedKots: FiredKot[]): Promise<void> {
  if (!firedKots?.length) return;
  ensureDrainLoop();
  const stations = await getStations();
  const time = new Date().toISOString();
  // Items accumulated per kind (food/bar) for the MASTER/expediter copy.
  const byKind: Record<string, Array<{ qty: number; name: string; notes?: string }>> = {};

  for (const k of firedKots) {
    const st = resolveKotStation(stations, k.station);
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
    // For the expediter ticket: tag each item with its station so the kitchen
    // counter can cross-check what each sub-station should send out.
    const kind = st.kind === 'bar' ? 'bar' : 'food';
    const label = (k.station || st.name || '').toUpperCase();
    (byKind[kind] ||= []).push(...(k.items || []).map((it) => ({
      qty: it.quantity, name: label ? `[${label}] ${it.name}` : it.name, notes: it.notes || undefined,
    })));
  }

  // MASTER / expediter: one consolidated ticket of all fired items of a kind,
  // printed at every printer flagged is_master for that kind (e.g. the Main
  // Kitchen counter printer). Stable id per fire → never double-prints.
  const masters = stations.filter((s) => s.role === 'kot' && s.is_active && Number(s.is_master) === 1);
  const fireKey = firedKots.map((k) => k.id).filter(Boolean).sort()[0] || String(Date.now());
  const k0 = firedKots[0];
  for (const m of masters) {
    const kind = m.kind === 'bar' ? 'bar' : 'food';
    const items = byKind[kind];
    if (!items || !items.length) continue;
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
  const st = resolveBillStation(stations);
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
