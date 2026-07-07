'use client';

/**
 * Kitchen Production — analytics dashboard.
 *
 * A read-only overview of the production floor: headline KPI cards, a prominent
 * colour-coded EXPIRY panel (today / tomorrow / 3-day / 7-day / expired) whose
 * tiles deep-link into the batch list pre-filtered to that bucket, and an
 * "expiring soon" table of the next ~10 batches to lapse.
 *
 * Data: GET /api/kitchen-production/dashboard → { widgets, expiring_soon }.
 * See that route for exact widget semantics (IST calendar buckets, rolling
 * windows, waste %, FIFO heuristic, low-stock).
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ChefHat, Loader2, RefreshCw, LayoutGrid, BarChart3, Package, Printer,
  Boxes, Layers, Utensils, Trash2, GitCompare, AlertTriangle, Clock,
  CheckCircle2, ScanLine, ArrowRight,
} from 'lucide-react';
import { fmtIST } from '@/lib/format-date';

// ─── Types ──────────────────────────────────────────────────────────────
interface Widgets {
  expiring_today: number;
  expiring_tomorrow: number;
  expiring_3d: number;
  expiring_7d: number;
  expired: number;
  today_production: number;
  labels_printed_today: number;
  active_batches: number;
  total_batches: number;
  today_consumption_qty: number;
  waste_pct: number;
  fifo_compliance_pct: number;
  low_stock_alerts: number;
}
interface ExpiringSoon {
  batch_number: string;
  item_name: string;
  expiry: string;
  expiry_status: 'green' | 'yellow' | 'red';
}

const fmtNum = (v: number) =>
  (Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });

// ─── Page ───────────────────────────────────────────────────────────────
export default function KitchenProductionDashboardPage() {
  const [widgets, setWidgets] = useState<Widgets | null>(null);
  const [soon, setSoon] = useState<ExpiringSoon[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    fetch('/api/kitchen-production/dashboard', { credentials: 'same-origin' })
      .then(async r => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        return j;
      })
      .then(j => {
        if (cancelled) return;
        setWidgets(j.widgets || null);
        setSoon(Array.isArray(j.expiring_soon) ? j.expiring_soon : []);
      })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
            <LayoutGrid className="w-6 h-6 text-[#af4408]" /> Production Dashboard
          </h1>
          <p className="text-xs text-[#6B5744] mt-0.5 max-w-2xl">
            Live snapshot of the kitchen-production floor — today's output, consumption,
            waste, FIFO discipline and, above all, what's about to <b>expire</b>.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/kitchen-production"
                className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm flex items-center gap-2">
            <ChefHat className="w-4 h-4" /> <span className="hidden sm:inline">Batches</span>
          </Link>
          <Link href="/kitchen-production/reports"
                className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm flex items-center gap-2">
            <BarChart3 className="w-4 h-4" /> <span className="hidden sm:inline">Reports</span>
          </Link>
          <button onClick={() => setRefreshKey(k => k + 1)}
                  className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm flex items-center gap-2">
            <RefreshCw className="w-4 h-4" /> <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
      </div>

      {error && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{error}</div>}

      {loading ? (
        <div className="p-10 text-center text-sm text-[#8B7355]">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading dashboard…
        </div>
      ) : widgets ? (
        <>
          {/* Expiry panel — the headline. */}
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="w-4 h-4 text-[#af4408]" />
              <h2 className="text-sm font-semibold text-[#2D1B0E]">Expiry watch</h2>
              <span className="text-[11px] text-[#8B7355]">— tap a tile to see those batches</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              <ExpiryTile bucket="expired"  label="Expired"        value={widgets.expired}           tone="red" />
              <ExpiryTile bucket="today"    label="Expiring Today" value={widgets.expiring_today}     tone="orange" />
              <ExpiryTile bucket="tomorrow" label="Tomorrow"       value={widgets.expiring_tomorrow}  tone="amber" />
              <ExpiryTile bucket="3d"       label="Within 3 Days"  value={widgets.expiring_3d}        tone="yellow" />
              <ExpiryTile bucket="7d"       label="Within 7 Days"  value={widgets.expiring_7d}        tone="emerald" />
            </div>
          </div>

          {/* KPI cards. */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            <StatCard icon={ChefHat}   label="Today's Production"   value={fmtNum(widgets.today_production)}       sub="batches logged today" />
            <StatCard icon={Printer}   label="Labels Printed Today" value={fmtNum(widgets.labels_printed_today)}   sub="print + reprint jobs" />
            <StatCard icon={Layers}    label="Active Batches"       value={fmtNum(widgets.active_batches)}         sub="currently on hand" />
            <StatCard icon={Boxes}     label="Total Production"     value={fmtNum(widgets.total_batches)}          sub="all-time batches" />
            <StatCard icon={Utensils}  label="Today's Consumption"  value={fmtNum(widgets.today_consumption_qty)}  sub="qty consumed today" />
            <StatCard icon={Trash2}    label="Waste %"              value={`${fmtNum(widgets.waste_pct)}%`}        sub="trailing 30 days"
                      accent={widgets.waste_pct >= 10 ? 'red' : widgets.waste_pct >= 5 ? 'amber' : 'emerald'} />
            <StatCard icon={GitCompare} label="FIFO Compliance"     value={`${fmtNum(widgets.fifo_compliance_pct)}%`} sub="oldest-first discipline"
                      accent={widgets.fifo_compliance_pct >= 90 ? 'emerald' : widgets.fifo_compliance_pct >= 70 ? 'amber' : 'red'} />
            <StatCard icon={AlertTriangle} label="Low Stock Alerts" value={fmtNum(widgets.low_stock_alerts)}      sub="items at/below reorder"
                      accent={widgets.low_stock_alerts > 0 ? 'red' : 'emerald'} />
          </div>

          {/* Expiring soon table. */}
          <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-[#E8D5C4] flex items-center justify-between">
              <div className="text-sm font-semibold text-[#2D1B0E] flex items-center gap-2">
                <Clock className="w-4 h-4 text-[#af4408]" /> Expiring soon
              </div>
              <Link href="/kitchen-production?expiry=7d"
                    className="text-xs text-[#af4408] hover:underline flex items-center gap-1">
                View all <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>
            {soon.length === 0 ? (
              <div className="p-8 text-center text-sm text-[#8B7355]">
                <CheckCircle2 className="w-7 h-7 mx-auto mb-2 text-emerald-400" />
                Nothing lapsing imminently — all active batches have runway.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-[#FFF8F0] text-left text-[11px] uppercase tracking-wide text-[#8B7355]">
                      <th className="px-4 py-2 font-medium">Batch #</th>
                      <th className="px-4 py-2 font-medium">Item</th>
                      <th className="px-4 py-2 font-medium">Expires</th>
                      <th className="px-4 py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E8D5C4]/60">
                    {soon.map((b, i) => (
                      <tr key={`${b.batch_number}-${i}`} className="hover:bg-[#FFF1E3]/40">
                        <td className="px-4 py-2 font-mono text-[#2D1B0E]">{b.batch_number}</td>
                        <td className="px-4 py-2 text-[#2D1B0E]">{b.item_name}</td>
                        <td className="px-4 py-2 text-[#6B5744]">{fmtIST(b.expiry)}</td>
                        <td className="px-4 py-2"><ExpiryBadge status={b.expiry_status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Quick links */}
          <div className="flex flex-wrap gap-2">
            <Link href="/kitchen-production/scan"
                  className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm flex items-center gap-2">
              <ScanLine className="w-4 h-4 text-[#af4408]" /> Scan a batch
            </Link>
            <Link href="/kitchen-production"
                  className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm flex items-center gap-2">
              <Package className="w-4 h-4 text-[#af4408]" /> All batches
            </Link>
          </div>
        </>
      ) : null}
    </div>
  );
}

// ─── Expiry tile ────────────────────────────────────────────────────────
const EXPIRY_TONE: Record<string, { card: string; num: string; label: string }> = {
  red:     { card: 'border-red-300 bg-red-50 hover:bg-red-100',           num: 'text-red-700',     label: 'text-red-800' },
  orange:  { card: 'border-orange-300 bg-orange-50 hover:bg-orange-100',  num: 'text-orange-700',  label: 'text-orange-800' },
  amber:   { card: 'border-amber-300 bg-amber-50 hover:bg-amber-100',     num: 'text-amber-700',   label: 'text-amber-800' },
  yellow:  { card: 'border-yellow-300 bg-yellow-50 hover:bg-yellow-100',  num: 'text-yellow-700',  label: 'text-yellow-800' },
  emerald: { card: 'border-emerald-300 bg-emerald-50 hover:bg-emerald-100', num: 'text-emerald-700', label: 'text-emerald-800' },
};

function ExpiryTile({ bucket, label, value, tone }: {
  bucket: string; label: string; value: number; tone: keyof typeof EXPIRY_TONE;
}) {
  const t = EXPIRY_TONE[tone];
  return (
    <Link href={`/kitchen-production?expiry=${bucket}`}
          className={`block border-2 rounded-xl p-3 text-center transition-colors ${t.card}`}>
      <div className={`text-3xl font-bold leading-none ${t.num}`}>{value}</div>
      <div className={`text-[11px] font-semibold mt-1.5 ${t.label}`}>{label}</div>
    </Link>
  );
}

// ─── Stat card ──────────────────────────────────────────────────────────
const ACCENT: Record<string, string> = {
  red: 'text-red-700',
  amber: 'text-amber-700',
  emerald: 'text-emerald-700',
};

function StatCard({ icon: Icon, label, value, sub, accent }: {
  icon: any; label: string; value: string; sub?: string; accent?: 'red' | 'amber' | 'emerald';
}) {
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-[#8B7355]">
        <Icon className="w-4 h-4 text-[#af4408]" /> {label}
      </div>
      <div className={`text-2xl font-bold ${accent ? ACCENT[accent] : 'text-[#2D1B0E]'}`}>{value}</div>
      {sub && <div className="text-[11px] text-[#8B7355]">{sub}</div>}
    </div>
  );
}

// ─── Expiry badge ───────────────────────────────────────────────────────
function ExpiryBadge({ status }: { status: 'green' | 'yellow' | 'red' }) {
  const map = {
    green:  { cls: 'bg-emerald-100 text-emerald-800 border-emerald-300', icon: CheckCircle2, label: 'Fresh' },
    yellow: { cls: 'bg-amber-100 text-amber-800 border-amber-300',       icon: Clock,        label: 'Near expiry' },
    red:    { cls: 'bg-red-100 text-red-700 border-red-300',             icon: AlertTriangle, label: 'Expired' },
  } as const;
  const m = map[status] || map.green;
  const Icon = m.icon;
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium inline-flex items-center gap-1 ${m.cls}`}>
      <Icon className="w-3 h-3" /> {m.label}
    </span>
  );
}
