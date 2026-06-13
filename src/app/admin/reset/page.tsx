'use client';
import { useEffect, useState } from 'react';
import { Trash2, AlertTriangle, ShieldAlert, Loader2, CheckCircle2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';

interface SessionUser { id: string; email: string; name: string; role: 'admin' | 'manager'; }
interface Outlet { id: string; name: string; }

const SCOPES: Array<{ key: string; label: string; description: string }> = [
  { key: 'sales',            label: 'Sales',
    description: 'Every sales line + the matching recipe-deduction inventory transactions (sale + NC). The deducted quantities are credited back to current_stock so books reconcile. Recipes / menu items / materials stay intact.' },
  { key: 'purchases',        label: 'Purchases (inward entries)',
    description: 'Every legacy purchase row + their inventory transactions. Resets material price + stock to 0 and recipe costs to 0.' },
  { key: 'purchase_orders',  label: 'Purchase Orders',
    description: 'Every PO (draft / pending / approved / received) and its line items.' },
  { key: 'closing_stock',    label: 'Closing-stock counts',
    description: 'Physical stock counts and variance entries.' },
  { key: 'recipes',          label: 'Recipes (all) + sub-recipes + menu items',
    description: 'Wipes EVERY recipe, sub-recipe, recipe-ingredient link, menu-item, and direct-item-link. Sales/wastage history is kept but unlinked (recipe_id → NULL) so revenue numbers stay intact. Use when re-building the recipe book from scratch. Date range does not apply.' },
  { key: 'inventory_unused', label: 'Inventory items — unused only (safe cleanup)',
    description: 'Deletes only inventory / raw-material items that NOTHING references — no purchases, recipes, requisitions, POs, stock movements, GRNs, wastages or counts use them. Ideal for clearing junk from a bad import without touching anything live. Date range does not apply.' },
  { key: 'inventory_all',    label: 'Inventory items — ALL (full item-master wipe ⚠)',
    description: 'Deletes EVERY inventory item across all outlets. Because stock movements, recipe-ingredient links, vendor prices, closing-stock counts, requisition / PO / GRN lines, wastages and butchering records all depend on materials, those are cleared too. Recipes & sub-recipes survive but lose their ingredient lists (costs reset to 0). Vendors, users and outlets stay. Use only to rebuild the item master from scratch. Date range does not apply.' },
];

export default function ResetPage() {
  const router = useRouter();
  const [me, setMe] = useState<SessionUser | null>(null);
  const [outlet, setOutlet] = useState<Outlet | null>(null);
  const [loading, setLoading] = useState(true);
  const [scopes, setScopes] = useState<Set<string>>(new Set());
  const [confirmText, setConfirmText] = useState('');
  const [outletText, setOutletText] = useState('');
  // Optional date-range filter — when both blank, full wipe of selected scopes
  const [from, setFrom] = useState<string>('');
  const [to,   setTo]   = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetch('/api/auth/me').then(r => r.json()),
      fetch('/api/outlets').then(r => r.json()),
    ]).then(([meRes, oRes]) => {
      setMe(meRes.user);
      const cur = oRes.outlets?.find((o: any) => o.id === oRes.current_outlet_id) || null;
      setOutlet(cur);
    }).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="p-10 text-center text-[#8B7355] text-sm">Loading…</div>;
  if (!me)     return <div className="p-10 text-center text-red-700">Sign in required.</div>;
  if (me.role !== 'admin') {
    return <div className="max-w-2xl mx-auto p-8 text-center text-red-700 bg-red-50 border border-red-200 rounded-xl">Admin only.</div>;
  }

  const toggleScope = (k: string) => {
    setScopes(prev => {
      const n = new Set(prev);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });
  };
  const checkAll = () => setScopes(new Set(SCOPES.map(s => s.key)));
  const clearAll = () => setScopes(new Set());

  // Date-range presets — populate from/to with one click
  const setMonth = (offset: number) => {
    const d = new Date();
    d.setMonth(d.getMonth() + offset, 1);
    const start = d.toISOString().slice(0, 10);
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);
    setFrom(start); setTo(end);
  };
  const setLastNDays = (n: number) => {
    const today = new Date(); const start = new Date(); start.setDate(start.getDate() - n + 1);
    setFrom(start.toISOString().slice(0, 10));
    setTo(today.toISOString().slice(0, 10));
  };
  const clearRange = () => { setFrom(''); setTo(''); };

  const dateError = (from && !to) || (!from && to)
    ? 'Provide both From and To, or leave both blank for full reset'
    : (from && to && from > to ? '"From" must be on or before "To"' : '');

  // Inventory scopes wipe master data (not date-stamped) — a date range here is
  // a mistake the server would reject, so block it up-front with a clear message.
  const invSelected = scopes.has('inventory_unused') || scopes.has('inventory_all');
  const invDateConflict = invSelected && !!(from || to);

  const requirements = [
    { ok: scopes.size > 0,                      msg: 'Pick at least one data type to clear' },
    { ok: !dateError,                            msg: dateError || 'Date range valid' },
    { ok: !invDateConflict,                      msg: invDateConflict ? 'Inventory reset ignores dates — clear From/To' : 'Date range OK for selection' },
    { ok: confirmText === 'RESET',              msg: 'Type RESET in capital letters' },
    { ok: outletText === outlet?.name,          msg: `Type the outlet name exactly: ${outlet?.name || '?'}` },
  ];
  const canSubmit = requirements.every(r => r.ok);

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const body: any = { confirm: 'RESET', scopes: Array.from(scopes) };
      if (from && to) { body.from = from; body.to = to; }
      const r = await api('/api/admin/reset', { method: 'POST', body });
      // Defensive: server may crash without sending a JSON body. Fall back to text.
      const raw = await r.text();
      let j: any = {};
      try { j = raw ? JSON.parse(raw) : {}; } catch { j = { error: raw || `HTTP ${r.status} (no body)` }; }
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setResult(j);
      setScopes(new Set());
      setConfirmText('');
      setOutletText('');
    } finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-red-700 flex items-center gap-2">
            <ShieldAlert className="w-6 h-6" /> Reset Transactional Data
          </h1>
          <p className="text-[#6B5744] text-sm mt-1">
            Bulk-delete sales, purchases, POs or closing-stock counts for the current outlet so you can re-import a clean dataset.
            Recipes and inventory items can also be cleared with their own options below. Vendors, users and outlets always stay intact.
          </p>
        </div>

        {/* Outlet banner */}
        {outlet && (
          <div className="bg-[#FFF1E3] border border-[#D4B896] rounded-xl p-3 text-sm text-[#6B5744]">
            Currently working in outlet: <span className="font-semibold text-[#af4408]">{outlet.name}</span>.
            Only data tagged with this outlet will be deleted. Switch outlets from the top-right pill if you want to reset another.
          </div>
        )}

        {/* Scope picker */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
          <div className="px-4 py-3 border-b border-[#E8D5C4] bg-[#FFF1E3]/50 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[#2D1B0E]">1. Pick what to delete</h3>
            <div className="flex gap-2 text-[10px]">
              <button onClick={checkAll} className="text-[#af4408] hover:underline">All</button>
              <button onClick={clearAll} className="text-[#6B5744] hover:underline">None</button>
            </div>
          </div>
          <ul className="divide-y divide-[#E8D5C4]/50">
            {SCOPES.map(s => (
              <li key={s.key} className={`hover:bg-[#FFF1E3]/30 ${scopes.has(s.key) ? 'bg-red-50/40' : ''}`}>
                {/* Use a <label> so clicks anywhere on the row toggle the native checkbox exactly once.
                    Previously had both <li onClick> and <input onChange>, which double-fired and cancelled out. */}
                <label className="px-4 py-3 flex items-start gap-3 cursor-pointer">
                  <input type="checkbox" className="mt-1 accent-red-600"
                         checked={scopes.has(s.key)}
                         onChange={() => toggleScope(s.key)} />
                  <div>
                    <div className="text-sm font-semibold text-[#2D1B0E]">{s.label}</div>
                    <div className="text-xs text-[#6B5744]">{s.description}</div>
                  </div>
                </label>
              </li>
            ))}
          </ul>
        </div>

        {/* Date-range filter */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
          <div className="px-4 py-3 border-b border-[#E8D5C4] bg-[#FFF1E3]/50">
            <h3 className="text-sm font-semibold text-[#2D1B0E]">2. Date range <span className="text-[10px] font-normal text-[#8B7355]">(optional — leave blank for full reset)</span></h3>
          </div>
          <div className="p-4 space-y-3">
            <p className="text-xs text-[#6B5744]">
              Restrict the reset to rows whose date falls in this window. Useful for re-importing a single month's data after spotting an issue,
              without touching everything else. Both fields blank = full reset of selected scopes.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="text-xs text-[#6B5744] flex flex-col gap-1">
                From
                <input type="date" value={from} onChange={e => setFrom(e.target.value)}
                       className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm font-mono" />
              </label>
              <label className="text-xs text-[#6B5744] flex flex-col gap-1">
                To
                <input type="date" value={to} onChange={e => setTo(e.target.value)}
                       className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm font-mono" />
              </label>
            </div>
            <div className="flex flex-wrap gap-1 text-[10px]">
              <span className="text-[#8B7355] mr-1 self-center">Quick:</span>
              <button onClick={() => setMonth(0)}  className="px-2 py-0.5 rounded border border-[#E8D5C4] hover:bg-[#FFF1E3]">This month</button>
              <button onClick={() => setMonth(-1)} className="px-2 py-0.5 rounded border border-[#E8D5C4] hover:bg-[#FFF1E3]">Last month</button>
              <button onClick={() => setMonth(-2)} className="px-2 py-0.5 rounded border border-[#E8D5C4] hover:bg-[#FFF1E3]">2 months ago</button>
              <button onClick={() => setLastNDays(7)}  className="px-2 py-0.5 rounded border border-[#E8D5C4] hover:bg-[#FFF1E3]">Last 7 days</button>
              <button onClick={() => setLastNDays(30)} className="px-2 py-0.5 rounded border border-[#E8D5C4] hover:bg-[#FFF1E3]">Last 30 days</button>
              {(from || to) && (
                <button onClick={clearRange} className="px-2 py-0.5 rounded border border-[#D4B896] bg-[#FFF1E3] text-[#af4408] hover:underline">Clear range</button>
              )}
            </div>
            {dateError && (
              <div className="text-[11px] text-red-700">{dateError}</div>
            )}
            {from && to && !dateError && (
              <div className="text-[11px] text-[#6B5744]">
                Will only delete rows where <code className="px-1 bg-[#FFF1E3] rounded">date</code> ∈ <code className="px-1 bg-[#FFF1E3] rounded">[{from}, {to}]</code>.
              </div>
            )}
          </div>
        </div>

        {/* Confirmation */}
        <div className="bg-white border border-red-200 rounded-xl shadow overflow-hidden">
          <div className="px-4 py-3 border-b border-red-200 bg-red-50">
            <h3 className="text-sm font-semibold text-red-800 inline-flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> 3. Confirm
            </h3>
          </div>
          <div className="p-4 space-y-3 text-xs">
            <p className="text-[#6B5744]">
              This is destructive and cannot be undone. The audit trail (PO history, who approved what) goes with the data.
              Make sure you have an export / backup of the database file if you might need it.
            </p>
            <label className="block text-[#6B5744]">
              Type <code className="bg-red-50 text-red-700 px-1 font-bold rounded">RESET</code> to confirm
              <input value={confirmText} onChange={e => setConfirmText(e.target.value)}
                     placeholder="RESET"
                     className="w-full mt-1 px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] font-mono text-sm" />
            </label>
            <label className="block text-[#6B5744]">
              Type the outlet name <code className="bg-red-50 text-red-700 px-1 font-bold rounded">{outlet?.name}</code> to confirm
              <input value={outletText} onChange={e => setOutletText(e.target.value)}
                     placeholder={outlet?.name || ''}
                     className="w-full mt-1 px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] font-mono text-sm" />
            </label>
            <ul className="text-[10px] text-[#8B7355] space-y-0.5">
              {requirements.map((r, i) => (
                <li key={i} className={r.ok ? 'text-green-700' : 'text-[#8B7355]'}>{r.ok ? '✓' : '○'} {r.msg}</li>
              ))}
            </ul>
          </div>
          <div className="px-4 py-3 border-t border-red-200 bg-red-50 flex justify-end gap-2">
            <button onClick={() => router.back()} disabled={busy}
                    className="px-3 py-2 text-sm text-[#6B5744]">Cancel</button>
            <button onClick={submit} disabled={!canSubmit || busy}
                    className="px-3 py-2 text-sm bg-red-600 hover:bg-red-700 text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
              Delete selected data
            </button>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">
            <span className="font-semibold">Reset failed:</span> {error}
          </div>
        )}

        {result && (
          <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-sm text-green-900">
            <div className="font-semibold inline-flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" /> Reset complete
            </div>
            <ul className="mt-2 space-y-0.5 text-xs">
              {Object.entries(result.deleted || {}).map(([k, v]) => (
                <li key={k}>· <span className="font-mono">{String(v)}</span> rows from <span className="font-medium">{k}</span></li>
              ))}
            </ul>
            <p className="mt-3 text-xs">
              You can now upload fresh data from <a href="/inventory" className="underline text-[#af4408]">Inventory</a> ·{' '}
              <a href="/sales" className="underline text-[#af4408]">Sales</a> ·{' '}
              <a href="/purchases" className="underline text-[#af4408]">Purchases</a> ·{' '}
              <a href="/purchase-orders" className="underline text-[#af4408]">Purchase Orders</a>.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
