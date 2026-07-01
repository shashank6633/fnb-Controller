/**
 * LAN offline-KOT sync — the counter Print Agent's bridge to surviving an
 * internet outage.
 *
 * TWO jobs, both driven from the Print Agent page while the CLOUD is reachable:
 *   1. CACHE WARMER  — snapshot everything the offline mini-POS needs (menu,
 *      tables, KOT design, outlet name, printer routing) and POST it to the
 *      bridge's /cache. When the internet later drops, a captain navigates the
 *      tablet to http://<counter-ip>:9920/offline and that page runs entirely
 *      off this cached snapshot — no cloud needed.
 *   2. REPLAY LOOP   — while offline, the bridge journals every FIRE it printed
 *      to kot-outbox.json. When the internet returns, this pulls those pending
 *      FIREs (GET /kot/pending), POSTs them to the cloud replay route
 *      (/api/dine-in/orders/replay — idempotent by client_ref), and on success
 *      tells the bridge to stamp them synced (POST /kot/mark-synced).
 *
 * Everything here is DEFENSIVE: every call swallows its own errors and returns a
 * benign value. Nothing thrown here may ever crash the Print Agent page, and a
 * replay is never double-marked (mark-synced only fires for FIREs the cloud
 * actually accepted).
 *
 * The bridge base URL is the SAME getBridgeUrl() the page already prints through
 * (e.g. http://localhost:9920). The cloud is reached with the app's `api()`
 * wrapper (same-origin, CSRF-aware) exactly like the rest of the POS.
 */
import { api } from '@/lib/api';
import { getBridgeUrl, type PrinterTarget } from './bridge-client';
import { getStations, getKotDesign, type PrintStation, type KotLine } from './print';

// ── CACHE shape (shared contract) ────────────────────────────────────────────
// Built here, written to the bridge, consumed by offline-pos.html + /kot.
export interface CacheTable { id: string; label: string; zone: string; }
export interface CacheMenuItem {
  id: string; name: string; station: string;
  item_type: 'foods' | 'liquors' | 'beverages';
  price: number; prep_minutes: number; category: string;
}
export interface CachePrinter { station: string; transport: 'ip' | 'usb' | 'file'; target: string; width: 48 | 32; }
export interface OfflineCache {
  updatedAt: string;
  outletName: string;
  // The cloud app's origin (e.g. https://fnb.akanhyd.com) — lets the offline
  // page's "Home" button return to the app even when opened from a bookmark
  // (an HTTPS->HTTP navigation strips the referrer, so we carry it explicitly).
  appUrl?: string;
  tables: CacheTable[];
  menu: CacheMenuItem[];
  kotDesign: { lines: KotLine[]; headerNote?: string; footerNote?: string };
  printers: CachePrinter[];
  defaultPrinter: { transport: 'ip' | 'usb' | 'file'; target: string; width: 48 | 32 };
}

// A FIRE journalled by the bridge, carried back for cloud replay. Kept loose —
// we only touch clientRef; everything else is forwarded to the replay route.
export interface PendingFire {
  clientRef: string;
  localNumber?: string;
  createdAt?: string;
  captainName?: string;
  table?: { id: string; label: string; zone: string };
  guest?: { name?: string; mobile?: string; covers?: number };
  items?: Array<Record<string, any>>;
  [k: string]: any;
}

function bridge(path: string): string { return `${getBridgeUrl()}${path}`; }

async function withTimeout<T>(p: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await p(ctrl.signal); }
  finally { clearTimeout(t); }
}

// ── Printer routing for the cache ────────────────────────────────────────────
// Same intent as print.ts resolveKotPrinter, but FLOOR-UNAWARE: the offline
// cache maps a menu station NAME → one physical printer (the offline page has no
// per-fire floor context to pick between floors). Precedence per station:
//   1. a KOT printer whose station/name matches this station,
//   2. else the first KOT printer of the matching KIND (bar for drinks / food),
//   3. else the first KOT printer.
function norm(s: string) { return String(s || '').toLowerCase().trim(); }

function targetOf(s: PrintStation): PrinterTarget {
  return { transport: s.transport, target: s.target, width: (s.paper_width === 32 ? 32 : 48) as 32 | 48 };
}

/**
 * Build printers[] (one entry per distinct menu station) + a defaultPrinter from
 * the configured print stations. `stationKinds` tells us, per station name,
 * whether that station serves drinks (from the menu's item_type) so a station
 * with no explicit printer still routes to the bar vs the kitchen.
 */
function buildPrinters(
  stations: PrintStation[],
  stationNames: string[],
  stationIsBar: Map<string, boolean>,
): { printers: CachePrinter[]; defaultPrinter: OfflineCache['defaultPrinter'] } {
  const kots = stations.filter((s) => s.role === 'kot' && s.is_active && Number(s.is_master) !== 1);
  const emptyDefault = { transport: 'ip' as const, target: '', width: 48 as const };
  if (kots.length === 0) return { printers: [], defaultPrinter: emptyDefault };

  const matchStation = (s: PrintStation, name: string) => norm(s.station) === norm(name) || norm(s.name) === norm(name);
  const firstFood = kots.find((s) => s.kind !== 'bar') || kots[0];
  const firstBar = kots.find((s) => s.kind === 'bar') || firstFood;

  const printers: CachePrinter[] = [];
  for (const name of stationNames) {
    if (!name) continue;
    const exact = kots.find((s) => matchStation(s, name));
    const isBar = stationIsBar.get(norm(name)) === true;
    const chosen = exact || (isBar ? firstBar : firstFood);
    if (!chosen) continue;
    const t = targetOf(chosen);
    printers.push({ station: name, transport: t.transport, target: t.target, width: t.width! });
  }
  // Default printer = the primary food KOT printer (what an unmapped station
  // falls back to on the bridge if it can't find a station entry).
  const d = targetOf(firstFood);
  return { printers, defaultPrinter: { transport: d.transport, target: d.target, width: d.width! } };
}

// ── CACHE builder ────────────────────────────────────────────────────────────
/**
 * Assemble the OfflineCache from the cloud. Cloud endpoints used:
 *   menu       → GET /api/menu-items            (items[]: id,name,station,item_type,selling_price,prep_minutes,category)
 *   tables     → GET /api/dine-in/tables        (items[]: id,table_number,zone)
 *   kotDesign  → getKotDesign() → GET /api/settings?key=kot_design  (lines,headerNote,footerNote)
 *   outletName → GET /api/settings              (settings[]: business_name)
 *   printers   → getStations() → GET /api/dine-in/offline-print/stations
 * Returns null if the essential data can't be fetched (so we don't overwrite a
 * good cache with an empty one during a transient blip).
 */
export async function buildCache(): Promise<OfflineCache | null> {
  try {
    const [menuRes, tablesRes, settingsRes, design, stations] = await Promise.all([
      api('/api/menu-items?active_only=true').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      api('/api/dine-in/tables?scope=all').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      api('/api/settings').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      getKotDesign().catch(() => null),
      getStations(true).catch(() => [] as PrintStation[]),
    ]);

    if (!menuRes || !tablesRes) return null; // essentials missing — keep the old cache

    const rawMenu: any[] = Array.isArray(menuRes.items) ? menuRes.items : [];
    const menu: CacheMenuItem[] = rawMenu.map((m) => ({
      id: String(m.id),
      name: String(m.name || ''),
      station: String(m.station || ''),
      item_type: (m.item_type === 'liquors' || m.item_type === 'beverages') ? m.item_type : 'foods',
      price: Number(m.selling_price) || 0,
      prep_minutes: Number(m.prep_minutes) || 0,
      category: String(m.category || ''),
    }));

    const rawTables: any[] = Array.isArray(tablesRes.items) ? tablesRes.items : [];
    const tables: CacheTable[] = rawTables.map((t) => ({
      id: String(t.id),
      label: String(t.table_number ?? t.label ?? ''),
      zone: String(t.zone || ''),
    }));

    const settingsArr: any[] = settingsRes && Array.isArray(settingsRes.settings) ? settingsRes.settings : [];
    const getSetting = (k: string) => settingsArr.find((x) => x.key === k)?.value;
    const outletName = String(
      getSetting('business_name') || (design && (design as any).outletName) || 'Restaurant',
    );

    // Per menu-station: does it serve drinks? (any non-food item on that station)
    const stationIsBar = new Map<string, boolean>();
    const stationNamesSet = new Set<string>();
    for (const m of menu) {
      if (!m.station) continue;
      stationNamesSet.add(m.station);
      const k = norm(m.station);
      if (m.item_type !== 'foods') stationIsBar.set(k, true);
      else if (!stationIsBar.has(k)) stationIsBar.set(k, false);
    }
    const { printers, defaultPrinter } = buildPrinters(stations || [], [...stationNamesSet], stationIsBar);

    const kotDesign = design
      ? { lines: design.lines, headerNote: design.headerNote || undefined, footerNote: design.footerNote || undefined }
      : { lines: [] as KotLine[] };

    return {
      updatedAt: new Date().toISOString(),
      outletName,
      appUrl: typeof window !== 'undefined' ? window.location.origin : undefined,
      tables,
      menu,
      kotDesign,
      printers,
      defaultPrinter,
    };
  } catch {
    return null;
  }
}

// ── Bridge calls (loop A: warm the cache) ────────────────────────────────────
/**
 * Build the CACHE and POST it to the bridge /cache. Returns true on {ok:true}.
 * Never throws.
 */
export async function pushCache(timeoutMs = 6000): Promise<boolean> {
  try {
    const cache = await buildCache();
    if (!cache) return false;
    return await withTimeout(async (signal) => {
      const r = await fetch(bridge('/cache'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cache),
        signal,
      });
      if (!r.ok) return false;
      const j = await r.json().catch(() => ({}));
      return !!j.ok;
    }, timeoutMs);
  } catch { return false; }
}

// ── Bridge + cloud calls (loop B: replay pending offline KOTs) ───────────────
/** GET the bridge's pending (unsynced) FIREs. Returns [] on any failure. */
export async function fetchPending(timeoutMs = 5000): Promise<PendingFire[]> {
  try {
    return await withTimeout(async (signal) => {
      const r = await fetch(bridge('/kot/pending'), { signal, cache: 'no-store' });
      if (!r.ok) return [];
      const j = await r.json().catch(() => ({}));
      return Array.isArray(j.jobs) ? (j.jobs as PendingFire[]) : [];
    }, timeoutMs);
  } catch { return []; }
}

/**
 * POST pending FIREs to the cloud replay route. The route is IDEMPOTENT by
 * client_ref, so re-sending a FIRE the cloud already has is safe (it returns
 * alreadyExisted:true). Returns the clientRefs the cloud confirmed (created OR
 * already-existing) — exactly the set safe to mark synced. Empty on failure.
 */
export async function replayPending(jobs: PendingFire[]): Promise<string[]> {
  if (!jobs.length) return [];
  try {
    const r = await api('/api/dine-in/orders/replay', { method: 'POST', body: { orders: jobs } });
    if (!r.ok) return [];
    const j = await r.json().catch(() => ({}));
    const results: any[] = Array.isArray(j.results) ? j.results : [];
    // Confirmed = anything the route acknowledged with a clientRef (new or dup).
    return results.map((x) => x?.clientRef).filter((x): x is string => typeof x === 'string' && x.length > 0);
  } catch { return []; }
}

/** Tell the bridge to stamp these clientRefs synced. Returns count marked. */
export async function markSynced(clientRefs: string[], timeoutMs = 5000): Promise<number> {
  if (!clientRefs.length) return 0;
  try {
    return await withTimeout(async (signal) => {
      const r = await fetch(bridge('/kot/mark-synced'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientRefs }),
        signal,
      });
      if (!r.ok) return 0;
      const j = await r.json().catch(() => ({}));
      return Number(j.marked) || 0;
    }, timeoutMs);
  } catch { return 0; }
}

/**
 * One replay pass: pull pending → replay to cloud → mark the confirmed ones
 * synced. Returns how many were synced this pass (0 when nothing pending or on
 * any failure). Never double-marks: only clientRefs the cloud confirmed are
 * passed to mark-synced.
 */
export async function replayOnce(): Promise<number> {
  const pending = await fetchPending();
  if (!pending.length) return 0;
  const confirmed = await replayPending(pending);
  if (!confirmed.length) return 0;
  return await markSynced(confirmed);
}
