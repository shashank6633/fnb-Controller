'use client';

/**
 * Party P&L page — one-stop view of per-party profit & loss.
 *
 * Revenue   = Party Bookings sheet (col U) matched by party_unique_id
 * Food Cost = party requisition items × material avg price (by event)
 * Liquor Cost = party_consumption × material avg price (snapshotted)
 * Profit    = Revenue − (Food + Liquor)
 *
 * Bar manager records bottle counts the night of / morning after the event
 * via the "Record liquor" button on each row.
 */

import { useEffect, useState } from 'react';
import { Wine, Loader2, RefreshCw, AlertTriangle, Plus, X, Trash2 } from 'lucide-react';
import MaterialTypeahead from '@/components/MaterialTypeahead';
import { api } from '@/lib/api';
import { fmtQtyNum, packFactor, purchasePrice, type PackMeta } from '@/lib/pack-units';

const fmt = (v: number) => '₹' + Math.round(v || 0).toLocaleString('en-IN');
// Rates need paise: a sub-rupee ₹/recipe-unit rate rounds to "₹0" under fmt(),
// which is how a wrong basis hides. Used only for the rate-provenance hint.
const rate2 = (v: number) => '₹' + (Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

// Per-line unit switching for the consumption recorder. The material's base
// recipe unit (and its average_price) stay canonical; these helpers just let
// the bar manager enter/read in a friendlier unit (e.g. L instead of 17820 ml).
//
// ENTRY UNIT — RECIPE UNIT (2026-08-13). See unitOptions() below for the whole
// reasoning; the short version is that entry is in ml/g, a 750 ml bottle is
// typed as 750, and the bottle equivalent is rendered live under each line so a
// bottle-count typo is visible while it is being made.
//
// This SUPERSEDES the purchase-unit entry added on 2026-08-06. That earlier note
// used to live here describing bottle-count entry as current; it is kept only in
// unitOptions()'s history section now, so there is one place to read for what
// the entry unit is and why.
//
// THE BASES, so the next reader cannot get the multiplication wrong:
//   raw_materials.unit           RECIPE unit   (ml, g)  <- what we STORE
//   raw_materials.purchase_unit  PURCHASE unit (BTL, CASE, CAN, kg, L)
//   raw_materials.pack_size      RECIPE units per PURCHASE unit (750 ml / BTL)
//   raw_materials.average_price  RUPEES PER RECIPE UNIT  (₹/ml, ₹/g)
// toBaseQty ALWAYS returns RECIPE units, so every `toBaseQty(...) * average_price`
// downstream stays recipe-qty × ₹/recipe-unit. Nothing on the money side changes
// and no packFactor may ever be applied to average_price here — that would be
// wrong by pack_size (750×) in the other direction.
//
function unitOptions(base?: string, m?: PackMeta): string[] {
  // RECIPE UNIT ONLY — the owner's call, 2026-08-13: "In Party for Consumption
  // Keep the Recipe unit to enter, accordingly conversion and calculations will
  // be done."
  //
  // ── THIS REPLACES THE 2026-08-06 PURCHASE-UNIT-ONLY RULE. READ WHY BEFORE
  //    CHANGING IT BACK. ─────────────────────────────────────────────────────
  // On 06-08 this form offered BOTH units in a dropdown, someone picked ml and
  // typed 3 meaning three bottles of ABSOLUT, and the P&L took 3 ml — Rs 8.70
  // against the Rs 6,522 those bottles were worth. The response was to delete ml
  // and leave only the purchase unit.
  //
  // The owner has since asked for the opposite, and it is NOT a re-run of that
  // mistake: the hazard was having TWO selectable units and mis-picking between
  // them, not which one won. Exactly one unit is still offered — so there is
  // still nothing to mis-pick — and it is now the material's own recipe unit,
  // which is the basis every stored quantity and average_price is already in.
  // The trade is ergonomic: a bottle is typed as 750, not 1.
  //
  // What guards the new shape is the conversion hint rendered under the field
  // (the "= N BTL" line): a bottle count typed into an ml box shows an absurd
  // bottle equivalent immediately, at the moment of entry, instead of surfacing
  // weeks later as an unexplainable party cost.
  //
  // packFactor() carries the BOTH-HALVES guard (pack_size > 1 AND recipe unit
  // !== purchase unit), and it no longer decides the entry unit at all — the
  // recipe unit is the entry unit either way. PICKLED GINGER 1.5KG (kg/kg,
  // pack 1.5) and BUDWEISER 330ML (pcs/BTL, pack 1) already entered in their own
  // unit and are unaffected. toBaseQty() is then a no-op for these lines
  // (display === base), which is the point: nothing is scaled, so nothing can be
  // scaled wrongly.
  return [base || m?.unit || 'pcs'];
}

/** The unit a NEW line must be seeded with — always the single option
 *  unitOptions() will offer for that material.
 *
 *  These two MUST agree. When the line was seeded with the recipe unit while
 *  the select offered only the purchase unit, the browser rendered the first
 *  option (BTL) but state still held 'ml', so toBaseQty saw display === base,
 *  converted nothing, and booked 3 ml while the screen read 3 BTL. That is the
 *  original bug wearing the fix as a disguise. Seed from the same function the
 *  select renders and they cannot drift. */
function entryUnit(m?: PackMeta & { unit?: string }): string {
  return unitOptions(m?.unit, m)[0] || m?.unit || 'pcs';
}
// Convert a qty typed in `display` unit back to the material's `base` (RECIPE) unit.
// `m` is optional so the two metric ladders below behave bit-for-bit as before
// when it is absent.
function toBaseQty(qty: number, display?: string, base?: string, m?: PackMeta): number {
  const d = (display || '').toLowerCase(), b = (base || '').toLowerCase();
  if (!d || d === b) return qty;
  if (d === 'l'  && b === 'ml') return qty * 1000;
  if (d === 'ml' && b === 'l')  return qty / 1000;
  if (d === 'kg' && b === 'g')  return qty * 1000;
  if (d === 'g'  && b === 'kg') return qty / 1000;
  // PURCHASE unit -> RECIPE units. Only reached for a unit the metric ladder
  // above does not recognise (BTL / CASE / CAN / PKT), so ml<->L and g<->kg are
  // untouched. 3 BTL x 750 ml/BTL = 2250 ml, which then multiplies the
  // ₹/ml average_price — purchase count in, recipe qty out, bases matched.
  if (m) {
    const pf = packFactor(m);
    const pu = String(m.purchase_unit || '').toLowerCase().trim();
    if (pf > 1 && pu && d === pu) return qty * pf;
  }
  return qty;
}
// Friendly read-only display: 17820 ml → "17.82 L", 2500 g → "2.5 kg".
function prettyQty(qty: number, unit?: string): string {
  const u = (unit || '').toLowerCase();
  if (u === 'ml' && Math.abs(qty) >= 1000) return (qty / 1000).toLocaleString('en-IN', { maximumFractionDigits: 2 }) + ' L';
  if (u === 'g'  && Math.abs(qty) >= 1000) return (qty / 1000).toLocaleString('en-IN', { maximumFractionDigits: 2 }) + ' kg';
  return qty.toLocaleString('en-IN', { maximumFractionDigits: 2 }) + ' ' + (unit || '');
}

interface PnLRow {
  party_unique_id?: string;
  fp_id?: string;
  event_name: string;
  event_date: string;
  guest_name?: string;
  pax?: number;
  revenue: number;
  food_cost: number;
  food_items: number;
  liquor_cost: number;
  liquor_items: number;
  total_cost: number;
  profit: number;
  margin_pct: number;
  has_revenue: boolean;
  has_liquor_recorded: boolean;
}

export default function PartyPnLPage() {
  const [rows, setRows] = useState<PnLRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'past' | 'all'>('past');
  const [recordFor, setRecordFor] = useState<PnLRow | null>(null);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/party-events/pnl');
      const j = await r.json();
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setRows(j.pnl || []);
    } catch (e: any) {
      setError(e?.message || 'Failed');
    } finally {
      setLoading(false);
    }
  };

  const refresh = async () => {
    setRefreshing(true); setError(null);
    try {
      await api('/api/party-bookings', { method: 'POST' });
      await load();
    } catch (e: any) {
      setError(e?.message || 'Failed');
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const visible = rows
    .filter(r => r.event_date && (filter === 'all' || new Date(r.event_date) < todayStart))
    .sort((a, b) => b.event_date.localeCompare(a.event_date));



  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center gap-3 flex-wrap">
        <Wine className="text-[#af4408]" size={24} />
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-[#2D1B0E]">Party Liquor Consumption</h1>
          <p className="text-xs text-[#8B7355]">
            Record bottle / unit counts consumed after each party. Bar manager updates the night-of or next morning.
            Cost auto-pulls from each material&apos;s average purchase price.
          </p>
        </div>
      </div>

      <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-[#E8D5C4] bg-amber-50/40 flex items-center gap-3 flex-wrap">
          <Wine size={16} className="text-amber-700" />
          <div className="flex-1 min-w-0 text-[10px] text-[#8B7355]">
            Showing {filter === 'past' ? 'past' : 'all'} events from the AKAN Party Manager sheet.
            Refresh to re-pull the event list.
          </div>
          <select value={filter} onChange={e => setFilter(e.target.value as any)}
                  className="text-xs px-2 py-1 border border-[#D4B896] rounded bg-white">
            <option value="past">Past events</option>
            <option value="all">All events</option>
          </select>
          <button onClick={refresh} disabled={refreshing}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs text-amber-700 hover:bg-amber-100 rounded disabled:opacity-50">
            {refreshing ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
            Refresh
          </button>
        </div>

        {loading ? (
          <div className="p-6 text-center text-sm text-[#8B7355]">
            <Loader2 className="animate-spin inline mr-1" size={14} /> Loading events…
          </div>
        ) : error ? (
          <div className="p-4 bg-red-50 text-sm text-red-700"><AlertTriangle size={14} className="inline mr-1" />{error}</div>
        ) : visible.length === 0 ? (
          <div className="p-6 text-center text-sm text-[#8B7355]">No events to show. Past events appear here automatically.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-[#FFF1E3] text-[#6B5744]">
                <tr>
                  <th className="text-left  py-2 px-3 font-medium">Date</th>
                  <th className="text-left  py-2 px-3 font-medium">Event</th>
                  <th className="text-right py-2 px-3 font-medium">Pax</th>
                  <th className="text-left  py-2 px-3 font-medium">Liquor recorded</th>
                  <th className="text-right py-2 px-3 font-medium">Liquor cost</th>
                  <th className="text-right py-2 px-3 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r, i) => (
                  <tr key={(r.party_unique_id || r.fp_id || r.event_name) + i}
                      className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF8F0]">
                    <td className="py-1.5 px-3 font-mono whitespace-nowrap">{r.event_date}</td>
                    <td className="py-1.5 px-3">
                      <div className="font-medium text-[#2D1B0E]">{r.event_name}</div>
                      {r.fp_id && <div className="text-[9px] font-mono text-[#af4408]">{r.fp_id}</div>}
                    </td>
                    <td className="py-1.5 px-3 text-right font-mono">{r.pax || '—'}</td>
                    <td className="py-1.5 px-3">
                      {r.has_liquor_recorded
                        ? <button onClick={() => setRecordFor(r)} title="View / edit recorded items"
                                  className="inline-flex items-center gap-1 text-emerald-700 hover:underline">
                            ✓ {r.liquor_items} item{r.liquor_items === 1 ? '' : 's'} recorded
                          </button>
                        : <span className="text-amber-700 text-[10px]">not recorded yet</span>}
                    </td>
                    <td className="py-1.5 px-3 text-right font-mono whitespace-nowrap">
                      {r.has_liquor_recorded
                        ? <span className="font-semibold text-[#2D1B0E]">{fmt(r.liquor_cost)}</span>
                        : <span className="text-[#8B7355]">—</span>}
                    </td>
                    <td className="py-1.5 px-3 text-right">
                      <button onClick={() => setRecordFor(r)}
                              className="inline-flex items-center gap-1 text-xs text-white bg-[#af4408] hover:bg-[#933807] px-2.5 py-1 rounded whitespace-nowrap">
                        {r.has_liquor_recorded ? <><Wine size={11} /> View / Add</> : <><Plus size={11} /> Record liquor</>}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {recordFor && (
        <RecordConsumptionModal
          target={recordFor}
          onClose={() => setRecordFor(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}

interface ConsumptionEntry {
  id: string;
  material_id: string;
  material_name: string;
  material_unit: string;
  qty_consumed: number;
  cost_at_time: number;
  notes?: string;
  recorded_by?: string;
}

function RecordConsumptionModal({ target, onClose, onChanged }: {
  target: PnLRow;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [materials, setMaterials] = useState<any[]>([]);
  const [existing, setExisting] = useState<ConsumptionEntry[]>([]);
  const [loadingExisting, setLoadingExisting] = useState(true);
  const [lines, setLines] = useState<{ material_id: string; qty: string; notes: string; unit: string }[]>([
    { material_id: '', qty: '', notes: '', unit: '' },
  ]);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  // Fetch what's already recorded for THIS event so the user sees it before
  // adding more — prevents punching the same bottle twice.
  const existingQs = target.party_unique_id
    ? `party_unique_id=${encodeURIComponent(target.party_unique_id)}`
    : `event_name=${encodeURIComponent(target.event_name)}&event_date=${encodeURIComponent(target.event_date)}`;

  const loadExisting = () => {
    setLoadingExisting(true);
    fetch(`/api/party-consumption?${existingQs}`)
      .then(r => r.json())
      .then(d => setExisting(d.entries || []))
      .catch(() => {})
      .finally(() => setLoadingExisting(false));
  };

  useEffect(() => {
    fetch('/api/inventory').then(r => r.json()).then(d => setMaterials(d.materials || d || []));
    loadExisting();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addLine = () => setLines(p => [...p, { material_id: '', qty: '', notes: '', unit: '' }]);
  // A chosen material is now LOCKED (see the read-only chip in the row below),
  // so this X is the ONLY way to correct a wrong pick. On the last remaining
  // line there is nothing to fall back to — filtering it out would leave zero
  // rows, the same dead end src/app/purchases/page.tsx removeBillLine was
  // already fixed for (read it). Reset to one blank line instead of removing it.
  const removeLine = (i: number) => setLines(p => {
    if (p.length <= 1) return [{ material_id: '', qty: '', notes: '', unit: '' }];
    return p.filter((_, idx) => idx !== i);
  });
  const update = (i: number, patch: any) => setLines(p => p.map((it, idx) => idx === i ? { ...it, ...patch } : it));

  const totalCost = lines.reduce((acc, l) => {
    const m = materials.find(x => x.id === l.material_id);
    // baseQty is RECIPE units (ml/g); average_price is ₹ per RECIPE unit.
    // recipe x recipe — do NOT introduce a pack factor on the price side.
    const baseQty = toBaseQty(Number(l.qty) || 0, l.unit || m?.unit, m?.unit, m);
    return acc + baseQty * (m?.average_price || 0);
  }, 0);

  const existingTotal = existing.reduce((a, e) => a + (e.cost_at_time || 0), 0);
  const recordedMaterialIds = new Set(existing.map(e => e.material_id));

  const submit = async () => {
    const cleaned = lines.filter(l => l.material_id && Number(l.qty) > 0);
    if (cleaned.length === 0) { setError('Add at least one item with qty > 0'); return; }
    setSaving(true); setError(null); setOk(null);
    try {
      const r = await api('/api/party-consumption', {
        method: 'POST',
        body: {
          party_unique_id: target.party_unique_id,
          fp_id: target.fp_id,
          event_name: target.event_name,
          event_date: target.event_date,
          items: cleaned.map(l => {
            const m = materials.find(x => x.id === l.material_id);
            // Posts RECIPE units — the API stores qty_consumed in the material's
            // own unit and values it at ₹/recipe-unit. 3 BTL leaves here as 2250 ml.
            return { material_id: l.material_id, qty: toBaseQty(Number(l.qty), l.unit || m?.unit, m?.unit, m), notes: l.notes };
          }),
        },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setLines([{ material_id: '', qty: '', notes: '', unit: '' }]);
      setOk(`Recorded ${cleaned.length} item${cleaned.length === 1 ? '' : 's'} — see "Already recorded" above.`);
      loadExisting();
      onChanged();
    } finally { setSaving(false); }
  };

  const deleteEntry = async (id: string) => {
    if (typeof window !== 'undefined' && !window.confirm('Remove this recorded item? This updates the liquor cost on the P&L.')) return;
    setDeletingId(id); setError(null); setOk(null);
    try {
      const r = await api(`/api/party-consumption?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      loadExisting();
      onChanged();
    } finally { setDeletingId(null); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 backdrop-blur-sm p-4 overflow-y-auto"
         onClick={onClose}>
      <div className="bg-white border border-[#E8D5C4] rounded-xl w-full max-w-3xl my-4 flex flex-col max-h-[calc(100vh-2rem)]"
           onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8D5C4] shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-[#2D1B0E]">Party Liquor Consumption</h2>
            <div className="text-xs text-[#8B7355] mt-0.5">
              {target.event_name} · {target.event_date} {target.fp_id && <span className="font-mono text-[#af4408]">· {target.fp_id}</span>}
            </div>
          </div>
          <button onClick={onClose} className="text-[#8B7355] hover:text-[#2D1B0E]"><X size={20} /></button>
        </div>

        <div className="px-6 py-4 space-y-3 overflow-y-auto flex-1">
          {/* Already recorded — so you can see what's punched and avoid duplicates */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-xs font-semibold text-[#2D1B0E] uppercase tracking-wide">Already recorded</h3>
              {!loadingExisting && existing.length > 0 && (
                <span className="text-[11px] text-[#8B7355]">{existing.length} item{existing.length === 1 ? '' : 's'} · {fmt(existingTotal)}</span>
              )}
            </div>
            {loadingExisting ? (
              <div className="text-xs text-[#8B7355] py-2"><Loader2 size={12} className="inline animate-spin mr-1" /> Loading…</div>
            ) : existing.length === 0 ? (
              <div className="text-xs text-[#8B7355] bg-[#FFF8F0] border border-[#E8D5C4] rounded p-2">Nothing recorded for this event yet.</div>
            ) : (
              <div className="border border-[#E8D5C4] rounded-lg overflow-hidden">
                <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-[#FFF1E3] text-[#6B5744]">
                    <tr>
                      <th className="text-left py-1.5 px-2 font-medium">Item</th>
                      <th className="text-right py-1.5 px-2 font-medium">Qty</th>
                      <th className="text-right py-1.5 px-2 font-medium">Cost</th>
                      <th className="text-left py-1.5 px-2 font-medium">By</th>
                      <th className="py-1.5 px-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {existing.map(e => (
                      <tr key={e.id} className="border-t border-[#E8D5C4]/50">
                        <td className="py-1.5 px-2">
                          <div className="text-[#2D1B0E]">{e.material_name}</div>
                          {e.notes && <div className="text-[10px] text-[#8B7355]">{e.notes}</div>}
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono whitespace-nowrap">{prettyQty(e.qty_consumed, e.material_unit)}</td>
                        <td className="py-1.5 px-2 text-right font-mono">{fmt(e.cost_at_time)}</td>
                        <td className="py-1.5 px-2 text-[10px] text-[#8B7355] whitespace-nowrap">{(e.recorded_by || '').split('@')[0]}</td>
                        <td className="py-1.5 px-2 text-right">
                          <button type="button" onClick={() => deleteEntry(e.id)} disabled={deletingId === e.id}
                                  title="Remove this entry"
                                  className="text-red-600 hover:text-red-700 disabled:opacity-40">
                            {deletingId === e.id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </div>
            )}
          </div>

          <div className="border-t border-[#E8D5C4] pt-3">
            <h3 className="text-xs font-semibold text-[#2D1B0E] uppercase tracking-wide">Add items</h3>
          </div>

          <div className="text-xs text-[#6B5744] bg-amber-50 border border-amber-200 rounded p-2">
            Enter each material in its own recipe unit — <b>ml for spirits, g for solids</b>, so a 750 ml bottle
            is <b>750</b>, not 1. The bottle equivalent is shown under every line as you type. Cost auto-pulls from
            each material&apos;s average purchase price. Save to lock in liquor cost on the P&amp;L.
          </div>

          <div className="grid grid-cols-12 gap-2 text-[10px] font-medium text-[#8B7355] uppercase tracking-wide px-1">
            <div className="col-span-6">Material</div>
            <div className="col-span-2 text-right">Qty</div>
            <div className="col-span-1">Unit</div>
            <div className="col-span-2 text-right">Cost</div>
          </div>

          {lines.map((l, i) => {
            const m = materials.find(x => x.id === l.material_id);
            const opts = unitOptions(m?.unit, m);
            // Never trust a stored unit the select cannot show. A line saved
            // before purchase-unit-only entry (or one whose material was
            // swapped) can hold 'ml' while opts is ['BTL']; rendering that as
            // the first option while state says 'ml' is exactly how 3 bottles
            // became 3 ml. Fall back to the offered unit so what is displayed
            // is what toBaseQty converts.
            const stored = l.unit || m?.unit || '';
            const dispUnit = opts.some(o => o.toLowerCase() === stored.toLowerCase())
              ? stored
              : (opts[0] || stored);
            // recipe qty x ₹/recipe-unit. The pack factor lives inside toBaseQty
            // (quantity side) and must never be applied to average_price:
            // toBaseQty ALWAYS returns the material's RECIPE unit (3 BTL × 750 =
            // 2250 ml, see its body), and average_price is ₹/recipe-unit by canon.
            // rate-basis: recipe
            const cost = toBaseQty(Number(l.qty) || 0, dispUnit, m?.unit, m) * (m?.average_price || 0);
            return (
              <div key={i} className="grid grid-cols-12 gap-2 items-start">
                <div className="col-span-6">
                  {l.material_id ? (
                    // LOCKED once chosen — read-only text, no dropdown, no clear
                    // x. To swap it, delete the line (X button below) and add a
                    // new one. Same rule and styling as the requisition
                    // composer's locked chip (src/app/requisitions/page.tsx
                    // ~1538-1552) and the "Enter Full Bill" locked chip
                    // (src/app/purchases/page.tsx ~2927-2947), so a line's
                    // material can never quietly change after its qty was typed
                    // against it, and the lock behaves identically everywhere.
                    //
                    // Basis: dispUnit (computed above, same variable the Unit
                    // caption box one column to the right renders) — NOT
                    // purchase_unit. Every OTHER locked chip in the app matches
                    // purchase_unit because those screens enter quantities in
                    // purchase units; THIS screen enters in the material's
                    // RECIPE unit by owner decision (2026-08-13, see
                    // unitOptions() above), and dispUnit is that recipe unit.
                    // Printing purchase_unit here would read "(BTL)" next to a
                    // Qty box captioned "(ml)" — the exact mismatch this
                    // basis choice exists to avoid. purchaseBasis on the
                    // MaterialTypeahead below is unaffected by this: it only
                    // drives the stock column in the search results, and that
                    // component's own picked-state chip never renders here
                    // because a chosen material switches this slot to this div.
                    <div title="To change the material, delete this line and add a new one"
                         className="w-full text-left px-2 py-1 text-xs border border-[#E8D5C4] rounded bg-[#F5EDE3] text-[#2D1B0E] break-words leading-snug cursor-not-allowed">
                      {m?.sku && <span className="text-[#8B7355] font-mono">{m.sku} — </span>}
                      <span>{m?.name || '(material removed)'}</span>
                      {dispUnit && <span className="text-[#8B7355]"> ({dispUnit})</span>}
                    </div>
                  ) : (
                    <MaterialTypeahead
                      materials={materials as any}
                      value={l.material_id}
                      onPick={(id: string) => { const mat = materials.find(x => x.id === id); update(i, { material_id: id, unit: entryUnit(mat as any) }); }}
                      excludeIds={lines.map(x => x.material_id).filter((id, idx) => id && idx !== i) as string[]}
                      // purchaseBasis here only feeds the stock column in the
                      // search-results list while typing. Its picked-state chip
                      // does not matter — the instant a material is picked,
                      // material_id becomes truthy and this slot switches to
                      // the locked div above (recipe-unit basis) instead.
                      purchaseBasis
                    />
                  )}
                  {l.material_id && recordedMaterialIds.has(l.material_id) && (
                    <div className="text-[10px] text-amber-700 mt-0.5">⚠ Already recorded above — saving will add to it.</div>
                  )}
                </div>
                <input type="number" step="any" value={l.qty}
                       onChange={e => update(i, { qty: e.target.value })}
                       placeholder="Qty"
                       className="col-span-2 px-2 py-1.5 border border-[#D4B896] rounded text-xs text-right font-mono" />
                {opts.length > 1 ? (
                  <select value={dispUnit} onChange={e => update(i, { unit: e.target.value })}
                          disabled={!l.material_id}
                          className="col-span-1 text-xs border border-[#D4B896] rounded bg-white py-1.5 px-1 disabled:opacity-50"
                          title="The unit your quantity is typed in. Everything is stored in the material's recipe unit, so switching this rescales the qty (3 BTL = 2250 ml) and the cost with it.">
                    {opts.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                ) : (
                  // dispUnit, NOT m.unit — the caption must name the unit the
                  // quantity is actually costed in. Since 2026-08-13 those are
                  // the same thing here (entry is in the recipe unit), but the
                  // rule stands on its own: this line printed m.unit while the
                  // cost above converted from dispUnit, and when the two units
                  // differed it read "Qty 1 · ml · ₹3,350" for one whole bottle.
                  // Bind the caption to the value it describes and the class of
                  // bug cannot come back if the entry unit ever changes again.
                  <span className="col-span-1 text-xs text-[#8B7355] py-2"
                        title={`Quantity is entered and costed in ${dispUnit}${
                          m && packFactor(m) > 1 ? ` — ${packFactor(m)} ${dispUnit} = 1 ${m.purchase_unit}` : ''
                        }`}>
                    {dispUnit || m?.unit || ''}
                  </span>
                )}
                <div className="col-span-2 flex items-center justify-end gap-1">
                  <span className="text-xs font-mono text-[#6B5744]"
                        title={m?.average_price ? `₹${m.average_price}/${m.unit}` : ''}>
                    {fmt(cost)}
                  </span>
                  <button type="button" onClick={() => removeLine(i)}
                          title={lines.length > 1 ? 'Remove this line' : 'Clear this line (last line — the row stays, the material is cleared)'}
                          className="text-red-600 hover:text-red-700"><X size={12} /></button>
                </div>
                {/*
                  RATE PROVENANCE (display-only). Now that a bottle count is
                  enterable, the line value swings by pack_size, so the rate it
                  leans on has to be visible and traceable — closing-valuation.ts:
                  "a valuation nobody can trace is a valuation nobody trusts".
                  Both figures are ₹ per PURCHASE unit so they are comparable:
                    • avg cost   = purchasePrice(average_price, m) = tier 2 of the
                      sanctioned ladder (₹/recipe-unit × packFactor).
                    • last purchase = latest_price_purchase_unit, already served by
                      /api/inventory as total/qty of the newest purchases row =
                      tier 1, the authoritative basis.
                  When they disagree by orders of magnitude, this material's
                  average_price is mis-based and the line value is not to be
                  trusted — 12 packed materials with no purchase history are in
                  exactly that state (e.g. HENDRICKS GIN reads ₹5,641.83 per ml).
                  Shown, never silently "repaired": mis-based rows are data for
                  the ₹-audit to fix, not something to guess at per row.
                */}
                {m && packFactor(m) > 1 && (
                  <div className="col-span-12 -mt-1 text-[9px] text-[#B8A590]">
                    Rate {rate2(purchasePrice(m.average_price || 0, m))}/{m.purchase_unit} from avg cost
                    {Number(m.latest_price_purchase_unit) > 0
                      ? <> · last purchase {rate2(m.latest_price_purchase_unit)}/{m.purchase_unit}</>
                      : <> · no purchase history to cross-check</>}
                    {' '}· stored as ₹{m.average_price}/{m.unit}
                  </div>
                )}
                {/*
                  THE LIVE CONVERSION — the guard that replaces purchase-unit-only
                  entry (owner's call 2026-08-13: enter in the recipe unit).

                  Entry in millilitres means one bottle is typed as 750, so the
                  failure mode is someone typing a BOTTLE COUNT into an ml box: 3
                  meaning three bottles books 3 ml of ABSOLUT, Rs 8.70 against the
                  Rs 6,522 it should be. That is the 06-08 incident, and removing
                  the unit dropdown does not by itself prevent it.

                  What prevents it is showing the bottle equivalent of whatever
                  was just typed, next to the box, while the person is still
                  looking at it. "3 ml = 0.004 BTL" is self-evidently not three
                  bottles; the same error discovered in a month-end P&L is not
                  traceable to anything. Under a tenth of a purchase unit is
                  called out explicitly, because that is the shape a bottle-count
                  typo takes and it is the only case worth interrupting for.
                */}
                {m && packFactor(m) > 1 && Number(l.qty) > 0 && (() => {
                  const inPurchase = (Number(l.qty) || 0) / packFactor(m);
                  const looksLikeBottleCount = inPurchase < 0.1;
                  return (
                    <div className={`col-span-12 -mt-1 text-[9px] ${looksLikeBottleCount ? 'text-amber-700 font-medium' : 'text-[#B8A590]'}`}>
                      {fmtQtyNum(Number(l.qty))} {m.unit} = {fmtQtyNum(Math.round(inPurchase * 1000) / 1000)} {m.purchase_unit}
                      {looksLikeBottleCount && (
                        <> — that is under a tenth of a {m.purchase_unit}. Did you mean {fmtQtyNum(Number(l.qty) * packFactor(m))} {m.unit} ({fmtQtyNum(Number(l.qty))} {m.purchase_unit})?</>
                      )}
                    </div>
                  );
                })()}
                <input value={l.notes} onChange={e => update(i, { notes: e.target.value })}
                       placeholder="Line notes (optional)"
                       className="col-span-12 px-2 py-1 border border-[#E8D5C4] rounded text-[11px] text-[#6B5744] -mt-1" />
              </div>
            );
          })}

          <button type="button" onClick={addLine}
                  className="text-xs text-[#af4408] hover:underline inline-flex items-center gap-1">
            <Plus size={12} /> Add line
          </button>

          <div className="bg-[#FFF1E3] border border-[#D4B896] rounded-lg p-3 flex items-center justify-between">
            <div className="text-xs text-[#8B7355]">New items being added</div>
            <div className="text-lg font-bold text-[#2D1B0E]">{fmt(totalCost)}</div>
          </div>

          {ok && <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded p-2 text-xs">{ok}</div>}
          {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded p-2 text-xs">{error}</div>}
        </div>

        <div className="flex justify-end gap-2 px-6 py-3 border-t border-[#E8D5C4] shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm text-[#6B5744] hover:bg-[#FFF1E3] rounded">Close</button>
          <button onClick={submit} disabled={saving}
                  className="inline-flex items-center gap-1.5 px-4 py-2 bg-[#af4408] hover:bg-[#933807] text-white rounded text-sm disabled:opacity-50">
            {saving ? <Loader2 className="animate-spin" size={14} /> : <Plus size={14} />}
            {saving ? 'Saving…' : 'Save Consumption'}
          </button>
        </div>
      </div>
    </div>
  );
}
