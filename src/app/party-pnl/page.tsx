'use client';

/**
 * Party P&L page — one-stop view of per-party profit & loss.
 *
 * Revenue   = Party Bookings sheet (col U) matched by party_unique_id, once per
 *             booking — on the latest not-cancelled F&P carrying the id (owner
 *             rulings 43 + 51). Not
 *             shown on this page (the consumption modal shows no revenue either);
 *             /parties is where it is read.
 * Food Cost = party requisition items × material avg price (by event)
 * Liquor Cost = liquor lines of the party's Bar requisition (read-only here)
 *             + party_consumption × material avg price (snapshotted), including
 *               rows with no party id that ONLY this party matches by name;
 *               a row that matches two or more parties counts on none until the
 *               owner assigns it to one that has an AKAN id (owner ruling
 *               2026-10-14). A row carrying an
 *               AKAN id that is on two or more F&P rows counts only on the F&P
 *               it was recorded from (else the one on its date, else on none
 *               until assigned) — never on every row with the id. A row whose
 *               id the F&P it was recorded from no longer carries counts on
 *               none (ruling 52).
 * Profit    = Revenue − (Food + Liquor)
 *
 * Bar manager records bottle counts the night of / morning after the event
 * via the "Record liquor" button on each row.
 */

import { useEffect, useState } from 'react';
import { Wine, Loader2, RefreshCw, AlertTriangle, Plus, X, Trash2, Lock } from 'lucide-react';
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

/** The two sources behind liquor_items, or null when the API predates the split
 *  (then the caller falls back to the merged count rather than printing "0 · 0"). */
function liquorSplit(r: PnLRow): { req: number; rec: number } | null {
  const req = r.liquor_requisition_items;
  const rec = r.liquor_consumption_items;
  if (typeof req !== 'number' || typeof rec !== 'number') return null;
  return { req, rec };
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
  // liquor_items is the SUM of these two sources. Optional so an older cached
  // response (or a payload from before the split shipped) degrades to the merged
  // count instead of rendering "0 · 0" over a non-zero cost.
  liquor_consumption_items?: number;   // recorded on this screen
  liquor_requisition_items?: number;   // already costed from the Bar requisition
  // Rows recorded with NO party id (owner ruling 2026-10-14). matched_by_name is
  // the part of liquor_consumption_items that rests on the name alone (this party
  // was the only match that evening); unassigned rows name this party AND another
  // (or carry an id on several F&Ps, or one changed after recording — ruling 52)
  // and are counted on neither; only a candidate with an AKAN id can take one.
  liquor_matched_by_name_items?: number;
  liquor_unassigned_items?: number;
  /** Requisitions with NO party id raised under a name this party shares with
   *  another that evening — costed on NEITHER (owner ruling 34) — plus those
   *  with an id on several F&Ps that nothing picks (43) or an id this F&P no
   *  longer carries (52). A count only. */
  requisitions_unassigned?: number;
  total_cost: number;
  profit: number;
  margin_pct: number;
  has_revenue: boolean;
  has_liquor_recorded: boolean;
}

/** A party_consumption row charged to NO party: recorded without a party id
 *  under a name that matches two or more parties that evening
 *  ('several_parties') or none ('no_party'); or recorded WITH an id that is on
 *  two or more F&P rows when neither the F&P it was recorded from nor its date
 *  picks one ('id_on_several_parties'), or with an id NO F&P on the party list
 *  carries ('id_not_listed' — read-only, nothing to assign it to; ruling 43), or
 *  with an id the F&P it was recorded from no longer carries
 *  ('id_changed_after_recording' — ruling 52; candidates = that F&P and the rows
 *  carrying the id). */
interface UnassignedLiquor {
  id: string;
  event_name: string;
  event_date: string;
  reason: 'several_parties' | 'no_party' | 'id_on_several_parties' | 'id_changed_after_recording' | 'id_not_listed';
  /** The entry's own party id (null for one recorded without an id). */
  party_unique_id?: string | null;
  material_name: string | null;
  material_unit: string | null;
  qty_consumed: number | null;
  cost_at_time: number;
  recorded_by: string | null;
  /** The F&P the entry was recorded from — the owner's clue to whose bottle it is. */
  recorded_fp_id?: string | null;
  candidates: { party_unique_id: string | null; fp_id: string | null; event_name: string; event_date: string }[];
}

/** A COSTED party requisition on no party's P&L (owner ruling 34): it has no
 *  party id and two or more parties that evening carry its name, or it carries
 *  an id no listed party has, or an id two or more listed rows share when
 *  neither the F&P it was raised from nor its date picks one (ruling 43).
 *  Read-only. Costs only for the financial audience. */
interface UnassignedRequisition {
  req_id: string;
  req_number: string;
  event_name: string;
  event_date: string;
  party_unique_id: string | null;
  fp_id: string | null;
  /** + 'id_changed_after_recording' (ruling 52: the F&P it was raised from no
   *  longer carries its id) and 'no_party' (no id, no party that evening has
   *  its name; ruling 43). */
  reason: 'several_parties' | 'id_not_listed' | 'id_on_several_parties' | 'id_changed_after_recording' | 'no_party';
  food_items: number;
  liquor_items: number;
  food_cost?: number;
  liquor_cost?: number;
  candidates: { party_unique_id: string | null; fp_id: string | null; event_name: string; event_date: string }[];
}

export default function PartyPnLPage() {
  const [rows, setRows] = useState<PnLRow[]>([]);
  const [unassigned, setUnassigned] = useState<UnassignedLiquor[]>([]);
  const [unassignedReqs, setUnassignedReqs] = useState<UnassignedRequisition[]>([]);
  const [canAssign, setCanAssign] = useState(false);
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
      setUnassigned(j.unassigned_liquor || []);
      setUnassignedReqs(j.unassigned_requisitions || []);
      setCanAssign(j.can_assign === true);
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
                      {/* SPLIT BY SOURCE, not a merged count. A party whose liquor
                          came entirely from a bar requisition used to read
                          "✓ 1 item recorded" and open a modal saying nothing was
                          recorded — a green tick pointing at the wrong place, which
                          invites re-typing a bottle that is already costed. Each
                          source now names itself, and the tick appears only for what
                          was actually recorded on this screen. */}
                      {r.has_liquor_recorded
                        ? <button onClick={() => setRecordFor(r)}
                                  title="Open the liquor breakdown for this event. Requisition lines are already costed on the P&L and are read-only."
                                  className="inline-flex flex-wrap items-center gap-x-1 text-left hover:underline">
                            {liquorSplit(r)
                              ? <>
                                  <span className={liquorSplit(r)!.req > 0 ? 'text-[#af4408]' : 'text-[#8B7355]'}>
                                    {/* "requisitions" names the SOURCE and never
                                        agrees with the count: the owner specified
                                        "1 from requisitions · 0 recorded here"
                                        verbatim, and "recorded here" opposite it
                                        does not inflect either. */}
                                    {liquorSplit(r)!.req} from requisitions
                                  </span>
                                  <span className="text-[#C4B5A5]">·</span>
                                  <span className={liquorSplit(r)!.rec > 0 ? 'text-emerald-700' : 'text-[#8B7355]'}>
                                    {liquorSplit(r)!.rec === 0 ? '0' : `✓ ${liquorSplit(r)!.rec}`} recorded here
                                  </span>
                                  {/* Part of "recorded here" that rests on the NAME
                                      alone: recorded without a party id, and this
                                      was the only party that evening it matched. */}
                                  {(r.liquor_matched_by_name_items || 0) > 0 && (
                                    <span className="text-[10px] text-[#8B7355]"
                                          title="Recorded without a party id; this is the only party that evening whose name matches, so it is counted here.">
                                      ({r.liquor_matched_by_name_items} matched by name)
                                    </span>
                                  )}
                                </>
                              : <span className="text-emerald-700">✓ {r.liquor_items} item{r.liquor_items === 1 ? '' : 's'} recorded</span>}
                          </button>
                        // has_liquor_recorded is false only when NO liquor is
                        // counted on this row. "not recorded yet" is true only when
                        // nothing that names this row waits on no party either: a
                        // bottle recorded (maybe on this very screen) but counted
                        // on no party, or a requisition costed on no party, makes
                        // it false — the badges below say "N recorded, counted on
                        // no party" — so the cell then says what IS true: none of
                        // it is counted here.
                        : ((r.liquor_unassigned_items || 0) > 0 || (r.requisitions_unassigned || 0) > 0)
                          ? <span className="text-amber-700 text-[10px]">no liquor counted</span>
                          : <span className="text-amber-700 text-[10px]">not recorded yet</span>}
                      {/* Recorded under a name this party shares with another party
                          that evening (or with an id on several F&Ps, or whose id
                          changed after recording — ruling 52): counted on NEITHER.
                          Only an entry with a candidate that has an AKAN id can be
                          assigned, so the badge does not promise an assignment.
                          Said here so nobody reads the empty cell as "nothing was
                          recorded" and types the bottle in again. */}
                      {(r.liquor_unassigned_items || 0) > 0 && (
                        <button onClick={() => setRecordFor(r)}
                                className="block text-[10px] text-red-700 hover:underline text-left"
                                title="Recorded under a name that matches more than one party that evening, or with a party id that is on more than one F&P when nothing picks one, or with a party id the F&P it was recorded from no longer carries (the id changed after recording) — not counted on any P&L. The owner can assign it only to a matching party that has an AKAN id; otherwise it stays uncounted until the party sheet changes.">
                          {r.liquor_unassigned_items} recorded, counted on no party
                        </button>
                      )}
                      {/* A requisition raised under a name this party shares with
                          another that evening, carrying no party id — or carrying
                          an id this row shares with another F&P when neither the
                          F&P it was raised from nor its date picks one — or raised
                          from this F&P when it no longer carries the requisition's
                          id (ruling 52; then this F&P may be its only candidate, so
                          the badge does not say "shared"): costed on NEITHER (owner
                          rulings 34, 43, 52). Said
                          here so the gap is not read as missing liquor. */}
                      {(r.requisitions_unassigned || 0) > 0 && (
                        <button onClick={() => setRecordFor(r)}
                                className="block text-[10px] text-red-700 hover:underline text-left"
                                title="A requisition with no party id raised under a name that matches more than one party that evening, or with a party id that is on more than one F&P when neither the F&P it was raised from nor its date picks one, or with a party id the F&P it was raised from no longer carries (the id changed after recording) — costed on none of them.">
                          {r.requisitions_unassigned} requisition{r.requisitions_unassigned === 1 ? '' : 's'} costed on no party
                        </button>
                      )}
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

      {!loading && unassigned.length > 0 && (
        <UnassignedLiquorPanel items={unassigned} canAssign={canAssign} onChanged={load} />
      )}

      {!loading && unassignedReqs.length > 0 && (
        <UnassignedRequisitionsPanel items={unassignedReqs} />
      )}

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

/**
 * LIQUOR CHARGED TO NO PARTY — for the owner to assign (ruling 2026-10-14).
 * A bottle recorded without a party id is counted only when exactly ONE party
 * that evening matches the name it was recorded under. These matched two or
 * more (or none), so every P&L above leaves them out; the list is what keeps
 * them from silently disappearing. Assigning sets the row's party id and F&P
 * (admin only, and only to a party the name and date actually match); its
 * quantity and snapshotted cost stay exactly as recorded, and it then counts on
 * that F&P row alone (owner ruling 34: a party without an id never counts an
 * entry carrying an id, and when one AKAN id is on two F&P rows an entry counts
 * only on the F&P it belongs to). The button sends the clicked row's fp_id, so
 * the second F&P of a booking can be chosen. Entries already carrying an id
 * that is on several F&P rows, with nothing to pick one, are listed here too,
 * and so are entries whose id no listed F&P carries ('id_not_listed') and
 * entries whose id the F&P they were recorded from no longer carries (ruling
 * 52). A party without an id cannot be chosen until the sheet gives it one, so
 * an entry whose candidates all lack an id — or that has none — cannot be
 * assigned at all; the intro says so instead of promising an assignment.
 * "recorded from" names the F&P whose screen the entry was typed on.
 */
function UnassignedLiquorPanel({ items, canAssign, onChanged }: {
  items: UnassignedLiquor[];
  canAssign: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const total = items.reduce((a, x) => a + (x.cost_at_time || 0), 0);

  // fp_id names WHICH F&P row was clicked: one AKAN id can sit on two F&P rows
  // (two functions of one booking), and the entry must count on the one chosen.
  const assign = async (id: string, partyUniqueId: string, fpId: string | null, label: string) => {
    if (typeof window !== 'undefined' && !window.confirm(`Assign this entry to ${label}? It will then count on that party's P&L.`)) return;
    setBusy(id); setErr(null);
    try {
      const r = await api('/api/party-consumption', {
        method: 'PATCH',
        body: { id, party_unique_id: partyUniqueId, ...(fpId ? { fp_id: fpId } : {}) },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j.error || `HTTP ${r.status}`); return; }
      onChanged();
    } finally { setBusy(null); }
  };

  return (
    <div className="bg-white border border-red-200 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-red-200 bg-red-50/60">
        <div className="text-sm font-semibold text-red-800 flex items-center gap-1.5">
          <AlertTriangle size={14} /> Liquor counted on no party — {items.length} entr{items.length === 1 ? 'y' : 'ies'} · {fmt(total)}
        </div>
        <div className="text-[11px] text-red-700 mt-0.5">
          Recorded without a party id under a name that matches more than one party that evening (or none) — or
          recorded with a party id that is on more than one F&amp;P, when neither the F&amp;P it was recorded from nor its
          date picks one — or with a party id no F&amp;P on the list carries — or with a party id the F&amp;P it was
          recorded from no longer carries (the id changed after recording). None of the P&amp;Ls above includes these.{' '}
          {canAssign ? 'You can assign' : 'The owner can assign'} an entry only to one of its matching parties that has
          an AKAN id; an entry with no such party cannot be assigned and stays uncounted until the party sheet changes.
        </div>
      </div>
      {err && <div className="px-4 py-2 text-xs bg-red-50 text-red-700 border-b border-red-200">{err}</div>}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-[#FFF1E3] text-[#6B5744]">
            <tr>
              <th className="text-left  py-1.5 px-3 font-medium">Date</th>
              <th className="text-left  py-1.5 px-3 font-medium">Recorded under</th>
              <th className="text-left  py-1.5 px-3 font-medium">Item</th>
              <th className="text-right py-1.5 px-3 font-medium">Cost</th>
              <th className="text-left  py-1.5 px-3 font-medium">Matching parties</th>
            </tr>
          </thead>
          <tbody>
            {items.map(x => (
              <tr key={x.id} className="border-t border-[#E8D5C4]/50 align-top">
                <td className="py-1.5 px-3 font-mono whitespace-nowrap">{x.event_date}</td>
                <td className="py-1.5 px-3 text-[#2D1B0E]">
                  {x.event_name}
                  {x.reason === 'id_on_several_parties' && x.party_unique_id && (
                    <div className="text-[10px] text-[#8B7355]">carries id {x.party_unique_id} — on more than one F&amp;P</div>
                  )}
                  {x.reason === 'id_not_listed' && x.party_unique_id && (
                    <div className="text-[10px] text-[#8B7355]">carries id {x.party_unique_id} — not on the party list</div>
                  )}
                  {x.reason === 'id_changed_after_recording' && (
                    <div className="text-[10px] text-[#8B7355]">carries id {x.party_unique_id} — id changed after recording: {x.recorded_fp_id || 'the F&P it was recorded from'} no longer carries it</div>
                  )}
                  {x.recorded_by && <div className="text-[10px] text-[#8B7355]">by {String(x.recorded_by).split('@')[0]}</div>}
                  {x.recorded_fp_id && (
                    <div className="text-[10px] text-[#8B7355]"
                         title="The party screen this entry was recorded from. Two parties can share a name that evening; this is whose screen it was typed on.">
                      recorded from <span className="font-mono text-[#af4408]">{x.recorded_fp_id}</span>
                    </div>
                  )}
                </td>
                <td className="py-1.5 px-3">
                  {x.material_name || '(material removed)'}
                  {x.qty_consumed != null && <div className="text-[10px] text-[#8B7355] font-mono">{prettyQty(x.qty_consumed, x.material_unit || '')}</div>}
                </td>
                <td className="py-1.5 px-3 text-right font-mono">{fmt(x.cost_at_time)}</td>
                <td className="py-1.5 px-3">
                  {x.reason === 'id_not_listed'
                    ? <span className="text-[10px] text-[#8B7355]">No F&amp;P on the party list carries this id — nothing to assign it to.</span>
                    : x.reason === 'no_party' || x.candidates.length === 0
                    ? <span className="text-[10px] text-[#8B7355]">No party on this date carries this name.</span>
                    : <div className="flex flex-col gap-1">
                        {x.candidates.map((c, ci) => (
                          <div key={ci} className="flex items-center gap-2 flex-wrap">
                            <span className="text-[#2D1B0E]">{c.event_name || '—'}</span>
                            {c.fp_id && <span className="text-[9px] font-mono text-[#af4408]">{c.fp_id}</span>}
                            {canAssign && (c.party_unique_id
                              ? <button type="button" disabled={busy === x.id}
                                        onClick={() => assign(x.id, c.party_unique_id!, c.fp_id,
                                          (c.event_name || c.party_unique_id!) + (c.fp_id ? ` (${c.fp_id})` : ''))}
                                        className="px-2 py-0.5 rounded text-[10px] bg-[#af4408] hover:bg-[#933807] text-white disabled:opacity-50">
                                  {busy === x.id ? 'Assigning…' : 'Assign here'}
                                </button>
                              : <span className="text-[10px] text-[#8B7355]">no AKAN id yet — cannot be assigned</span>)}
                          </div>
                        ))}
                      </div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * REQUISITIONS COSTED ON NO PARTY — owner ruling 34 (2026-10-14). A requisition
 * is costed only on the party whose AKAN id it carries; one with no id only when
 * exactly ONE party that evening carries the name it was raised under. These
 * matched two or more or none, or carry an id no listed party has, or carry an
 * id the F&P they were raised from no longer carries (ruling 52), so no P&L
 * above includes them — production costed each on every matching party. Read-only:
 * a requisition's party is set when it is raised (Raise Req), not here.
 */
function UnassignedRequisitionsPanel({ items }: { items: UnassignedRequisition[] }) {
  const showCost = items.some(x => typeof x.food_cost === 'number' || typeof x.liquor_cost === 'number');
  const total = items.reduce((a, x) => a + (x.food_cost || 0) + (x.liquor_cost || 0), 0);
  return (
    <div className="bg-white border border-red-200 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-red-200 bg-red-50/60">
        <div className="text-sm font-semibold text-red-800 flex items-center gap-1.5">
          <AlertTriangle size={14} /> Requisitions costed on no party — {items.length} requisition{items.length === 1 ? '' : 's'}
          {showCost && <> · {fmt(total)}</>}
        </div>
        <div className="text-[11px] text-red-700 mt-0.5">
          A requisition counts only on the party whose AKAN id it carries; without an id, only when exactly one party
          that evening has the name it was raised under. When its id is on more than one F&amp;P, only on the F&amp;P it
          was raised from — else on the one dated on its date. These match more than one party or none, or carry an id
          no listed party has, or carry an id the F&amp;P they were raised from no longer carries (the id changed after
          recording) — so none of the P&amp;Ls above includes them.
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-[#FFF1E3] text-[#6B5744]">
            <tr>
              <th className="text-left  py-1.5 px-3 font-medium">Date</th>
              <th className="text-left  py-1.5 px-3 font-medium">Requisition</th>
              <th className="text-left  py-1.5 px-3 font-medium">Raised under</th>
              <th className="text-right py-1.5 px-3 font-medium">Lines</th>
              {showCost && <th className="text-right py-1.5 px-3 font-medium">Cost</th>}
              <th className="text-left  py-1.5 px-3 font-medium">Matching parties</th>
            </tr>
          </thead>
          <tbody>
            {items.map(x => (
              <tr key={x.req_id} className="border-t border-[#E8D5C4]/50 align-top">
                <td className="py-1.5 px-3 font-mono whitespace-nowrap">{x.event_date}</td>
                <td className="py-1.5 px-3 font-mono whitespace-nowrap">
                  {x.req_number || '—'}
                  {x.fp_id && <div className="text-[9px] text-[#af4408]">{x.fp_id}</div>}
                </td>
                <td className="py-1.5 px-3 text-[#2D1B0E]">
                  {x.event_name}
                  {x.reason === 'id_not_listed' && x.party_unique_id && (
                    <div className="text-[10px] text-[#8B7355]">carries id {x.party_unique_id} — not on the party list</div>
                  )}
                  {x.reason === 'id_on_several_parties' && x.party_unique_id && (
                    <div className="text-[10px] text-[#8B7355]">carries id {x.party_unique_id} — on more than one F&amp;P; neither the F&amp;P it was raised from nor its date picks one</div>
                  )}
                  {x.reason === 'id_changed_after_recording' && (
                    <div className="text-[10px] text-[#8B7355]">carries id {x.party_unique_id} — id changed after recording: {x.fp_id || 'the F&P it was raised from'} no longer carries it</div>
                  )}
                </td>
                <td className="py-1.5 px-3 text-right font-mono whitespace-nowrap">
                  {x.food_items} food · {x.liquor_items} liquor
                </td>
                {showCost && (
                  <td className="py-1.5 px-3 text-right font-mono whitespace-nowrap">
                    {fmt((x.food_cost || 0) + (x.liquor_cost || 0))}
                  </td>
                )}
                <td className="py-1.5 px-3">
                  {x.reason === 'no_party' && x.candidates.length === 0 && (
                    <span className="text-[10px] text-[#8B7355]">No party on this date carries this name.</span>
                  )}
                  <div className="flex flex-col gap-0.5">
                    {x.candidates.map((c, ci) => (
                      <div key={ci} className="flex items-center gap-2 flex-wrap">
                        <span className="text-[#2D1B0E]">{c.event_name || '—'}</span>
                        {c.fp_id && <span className="text-[9px] font-mono text-[#af4408]">{c.fp_id}</span>}
                      </div>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
  /** Recorded WITHOUT a party id and counted here because this is the only
   *  party that evening its name matches (owner ruling 2026-10-14). */
  matched_by_name?: boolean;
}

/** Recorded without a party id under a name that matches this party AND another
 *  that evening ('several_parties'), or recorded with an id this row shares with
 *  another F&P when neither the F&P it was recorded from nor its date picks one
 *  ('id_on_several_parties'), or recorded with an id the F&P it was recorded
 *  from no longer carries ('id_changed_after_recording', ruling 52) — counted on
 *  NEITHER; assignable only to a candidate that has an AKAN id. Never summed. */
interface UnassignedEntry extends ConsumptionEntry {
  event_name: string;
  /** + 'id_changed_after_recording' (ruling 52). */
  reason?: 'several_parties' | 'id_on_several_parties' | 'id_changed_after_recording';
  party_unique_id?: string | null;
  candidates: { party_unique_id: string | null; fp_id?: string | null; event_name: string; event_date: string }[];
}

/** A requisition costed on NEITHER party (owner ruling 34): no party id and
 *  raised under a name this party shares with another that evening, or carrying
 *  an id this row shares with another F&P when neither the F&P it was raised
 *  from nor its date picks one (ruling 43). Never summed. */
interface UnassignedReqHere {
  req_id: string;
  req_number: string;
  event_name: string;
  /** + 'id_changed_after_recording' (ruling 52). */
  reason?: 'several_parties' | 'id_on_several_parties' | 'id_changed_after_recording';
  party_unique_id?: string | null;
  candidates: { party_unique_id: string | null; fp_id?: string | null; event_name: string; event_date: string }[];
}

/** "Ravi Kumar (FP-103)" — the display name alone cannot tell two parties of one
 *  name apart, which is exactly when these lists appear. */
function candidateLabel(c: { fp_id?: string | null; event_name: string }): string {
  return (c.event_name || '—') + (c.fp_id ? ` (${c.fp_id})` : '');
}

/** A liquor line from the party's BAR REQUISITION — already costed into the P&L
 *  by /api/party-events/pnl. Shown read-only; there is nothing here to edit and
 *  re-entering one of these on the form counts the same bottle twice. */
interface ReqLiquorItem {
  id: string;
  material_id: string;
  material_name: string;
  material_unit: string;
  material_purchase_unit?: string;
  issued_unit: string;
  qty_issued: number;
  qty_issued_recipe: number;
  /** qty_issued_recipe in the PURCHASE unit — what the row leads with. */
  qty_issued_purchase?: number;
  /** Blank/unrecognised line unit on a packed material: costed at ×1. */
  needs_unit_review?: boolean;
  cost: number;
  req_number: string;
  req_status: string;
  issued_at?: string | null;
  issued_by?: string | null;
}

/** A material the POST refused because the bar requisition already covers it. */
interface DuplicateWarning {
  material_id: string;
  material_name: string;
  req_number: string;
  qty_issued: number;
  issued_unit: string;
  cost: number;
}

function RecordConsumptionModal({ target, onClose, onChanged }: {
  target: PnLRow;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [materials, setMaterials] = useState<any[]>([]);
  const [existing, setExisting] = useState<ConsumptionEntry[]>([]);
  const [reqItems, setReqItems] = useState<ReqLiquorItem[]>([]);
  const [unassignedHere, setUnassignedHere] = useState<UnassignedEntry[]>([]);
  const [unassignedReqsHere, setUnassignedReqsHere] = useState<UnassignedReqHere[]>([]);
  const [dupes, setDupes] = useState<DuplicateWarning[] | null>(null);
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
  // EVERY row also sends its fp_id. A party WITHOUT an id needs it because its
  // display name is not unique (two such parties, or one with an id, can share it
  // that evening); a party WITH an id needs it because one AKAN id can sit on two
  // F&P rows, each costed on its own requisitions. Without it the server took the
  // FIRST party of that name / id — showing this modal another row's requisition
  // lines and orphan share. fp_id names the row that was clicked.
  const existingQs = (target.party_unique_id
    ? `party_unique_id=${encodeURIComponent(target.party_unique_id)}`
    : `event_name=${encodeURIComponent(target.event_name)}&event_date=${encodeURIComponent(target.event_date)}`)
      + (target.fp_id ? `&fp_id=${encodeURIComponent(target.fp_id)}` : '');

  const loadExisting = () => {
    setLoadingExisting(true);
    fetch(`/api/party-consumption?${existingQs}`)
      .then(r => r.json())
      .then(d => {
        setExisting(d.entries || []);
        // The other half of this event's liquor cost. Read-only by construction:
        // nothing in this modal can edit or delete a requisition line.
        setReqItems(d.requisition_items || []);
        // Charged to nobody (shared name, no party id) — shown, never summed.
        setUnassignedHere(d.unassigned_entries || []);
        setUnassignedReqsHere(d.unassigned_requisitions || []);
      })
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
  const reqTotal      = reqItems.reduce((a, e) => a + (e.cost || 0), 0);
  const recordedMaterialIds = new Set(existing.map(e => e.material_id));
  // Materials already costed from the bar requisition. Typing one of these on the
  // form is how the same bottle gets counted twice — the line flags it, and the
  // API refuses it once (409) before anything is written.
  const reqMaterialIds = new Map(reqItems.map(e => [e.material_id, e]));

  const submit = async (confirmDuplicates = false) => {
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
          // Only ever true after the user has been shown the requisition line the
          // material is already costed on and has chosen to record it anyway.
          confirm_duplicates: confirmDuplicates,
          items: cleaned.map(l => {
            const m = materials.find(x => x.id === l.material_id);
            // Posts RECIPE units — the API stores qty_consumed in the material's
            // own unit and values it at ₹/recipe-unit. 3 BTL leaves here as 2250 ml.
            return { material_id: l.material_id, qty: toBaseQty(Number(l.qty), l.unit || m?.unit, m?.unit, m), notes: l.notes };
          }),
        },
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 409 && j.needs_confirmation) {
        // NOT an error the user should have to decode: show which bottle is
        // already costed, on which requisition, and make recording it anyway an
        // explicit second click.
        setDupes(j.duplicates || []);
        setError(null);
        return;
      }
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setDupes(null);
      setLines([{ material_id: '', qty: '', notes: '', unit: '' }]);
      setOk(`Recorded ${cleaned.length} item${cleaned.length === 1 ? '' : 's'} — see "Recorded on this screen" above.`);
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
          {/* ── ALREADY COSTED FROM THE BAR REQUISITION — READ-ONLY ──────────────
              These lines are the OTHER half of this event's liquor cost. They used
              to be invisible here, so a party whose liquor came entirely from a
              requisition opened an empty modal under a badge saying an item was
              recorded — and the natural response to an empty modal is to type the
              bottle in, which charges the party twice. Nothing in this block is
              editable or deletable: the store issued it, the P&L already counted
              it, and there is nothing to re-enter. */}
          {!loadingExisting && reqItems.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <h3 className="text-xs font-semibold text-[#2D1B0E] uppercase tracking-wide flex items-center gap-1">
                  <Lock size={11} className="text-[#af4408]" /> Already costed from the Bar requisition
                </h3>
                <span className="text-[11px] text-[#8B7355]">{reqItems.length} item{reqItems.length === 1 ? '' : 's'} · {fmt(reqTotal)}</span>
              </div>
              <div className="border border-[#D4B896] rounded-lg overflow-hidden bg-[#F5EDE3]">
                <div className="px-2 py-1.5 text-[10px] text-[#6B5744] border-b border-[#D4B896]">
                  Issued by the store on this party&apos;s bar requisition and <b>already included in the liquor cost</b> on the P&amp;L.
                  Read-only — re-entering any of these below would count the same bottle twice.
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-[#EDDFD0] text-[#6B5744]">
                      <tr>
                        <th className="text-left  py-1.5 px-2 font-medium">Item</th>
                        <th className="text-right py-1.5 px-2 font-medium">Issued</th>
                        <th className="text-right py-1.5 px-2 font-medium">Cost</th>
                        <th className="text-left  py-1.5 px-2 font-medium">Requisition</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reqItems.map(e => (
                        <tr key={e.id} className="border-t border-[#D4B896]/60">
                          <td className="py-1.5 px-2 text-[#2D1B0E]">
                            {e.material_name}
                            {e.needs_unit_review && (
                              <div className="text-[10px] text-amber-700"
                                   title="The requisition line has a blank or unrecognised unit on a packed material, so the store moved no stock for it and its cost is taken at ×1.">
                                ⚠ unit unclear on the requisition — costed at ×1
                              </div>
                            )}
                          </td>
                          {/* LEADS WITH THE PURCHASE UNIT (owner rule), with the
                              figure as issued and the recipe quantity it was costed
                              on in the tooltip. Display only — the cost beside it
                              is recipe qty × ₹/recipe-unit, computed server-side. */}
                          <td className="py-1.5 px-2 text-right font-mono whitespace-nowrap"
                              title={`Issued ${fmtQtyNum(e.qty_issued)} ${e.issued_unit} = ${prettyQty(e.qty_issued_recipe, e.material_unit)} costed at ₹/${e.material_unit}`}>
                            {typeof e.qty_issued_purchase === 'number' && e.material_purchase_unit
                              ? <>{fmtQtyNum(e.qty_issued_purchase)} {e.material_purchase_unit}</>
                              : <>{fmtQtyNum(e.qty_issued)} {e.issued_unit}</>}
                          </td>
                          <td className="py-1.5 px-2 text-right font-mono">{fmt(e.cost)}</td>
                          <td className="py-1.5 px-2 text-[10px] text-[#8B7355] whitespace-nowrap">
                            {e.req_number || '—'}{e.issued_by ? ` · ${String(e.issued_by).split('@')[0]}` : ''}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* Recorded here — what was punched on THIS screen, so duplicates are visible */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-xs font-semibold text-[#2D1B0E] uppercase tracking-wide">Recorded on this screen</h3>
              {!loadingExisting && existing.length > 0 && (
                <span className="text-[11px] text-[#8B7355]">{existing.length} item{existing.length === 1 ? '' : 's'} · {fmt(existingTotal)}</span>
              )}
            </div>
            {loadingExisting ? (
              <div className="text-xs text-[#8B7355] py-2"><Loader2 size={12} className="inline animate-spin mr-1" /> Loading…</div>
            ) : existing.length === 0 ? (
              <div className="text-xs text-[#8B7355] bg-[#FFF8F0] border border-[#E8D5C4] rounded p-2">
                {/* `existing` is only what is COUNTED on this row. An entry in
                    the "Not counted on this P&L" list below may have been typed on
                    this very screen, and a requisition in the "Not costed" note
                    was raised for a party of this name — so "nothing recorded"
                    is said only when neither list has anything; otherwise the
                    text says what is true: none of it is counted here. */}
                {reqItems.length > 0
                  ? (unassignedHere.length > 0 || unassignedReqsHere.length > 0)
                    ? <>Nothing recorded on this screen is counted on this P&amp;L. The liquor costed for this event is the
                        Bar requisition above; the entries listed below are counted on no party. Add an item here only if it
                        was drawn from the bar <b>on top of</b> what the store issued and is not listed below.</>
                    : <>Nothing recorded on this screen — this event&apos;s liquor is already costed from the Bar requisition above.
                        Add an item here only if it was drawn from the bar <b>on top of</b> what the store issued.</>
                  : (unassignedHere.length > 0 || unassignedReqsHere.length > 0)
                    ? 'No liquor is counted on this P&L for this event — the entries listed below are counted on no party.'
                    : 'Nothing recorded for this event yet.'}
              </div>
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
                          {e.matched_by_name && (
                            <div className="text-[10px] text-[#af4408]"
                                 title="Recorded without a party id. This is the only party that evening whose name matches, so it is counted here.">
                              matched by name
                            </div>
                          )}
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

          {/* COUNTED ON NO PARTY. Recorded without a party id under a name this
              party shares with another party that evening, so — by the owner's
              ruling of 2026-10-14 — it is on NEITHER P&L (likewise an id on
              several F&Ps with nothing to pick one, or an id changed after
              recording — ruling 52). Only a candidate with an AKAN id can take
              it, so the note does not promise an assignment. Listed so nobody
              re-types it; deliberately outside the
              reconciliation sum below, which is exactly what the P&L charges. */}
          {!loadingExisting && unassignedHere.length > 0 && (
            <div className="border border-red-200 rounded-lg overflow-hidden">
              <div className="px-2 py-1.5 text-[10px] text-red-800 bg-red-50 border-b border-red-200">
                <b>Not counted on this P&amp;L.</b> Recorded without a party id under a name that
                matches more than one party on {target.event_date}, or with a party id that is on more than one F&amp;P
                when nothing picks one, or with a party id the F&amp;P it was recorded from no longer carries (id changed
                after recording) — so it is counted on none of the parties it matches. Do not record it again. The owner
                can assign it only to one of those parties that has an AKAN id; if none has one, it stays uncounted until
                the party sheet changes.
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <tbody>
                    {unassignedHere.map(e => (
                      <tr key={e.id} className="border-t border-red-100 first:border-t-0">
                        <td className="py-1.5 px-2">
                          <div className="text-[#2D1B0E]">{e.material_name}</div>
                          <div className="text-[10px] text-[#8B7355]">
                            under &ldquo;{e.event_name}&rdquo;
                            {e.reason === 'id_on_several_parties' && e.party_unique_id && <> (id {e.party_unique_id})</>}
                            {e.reason === 'id_changed_after_recording' && <> (id {e.party_unique_id} — id changed after recording)</>}
                            {' '}· matches {e.candidates.map(candidateLabel).join(', ')}
                          </div>
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono whitespace-nowrap">{prettyQty(e.qty_consumed, e.material_unit)}</td>
                        <td className="py-1.5 px-2 text-right font-mono text-[#8B7355] line-through" title="Not included in this party's liquor cost">{fmt(e.cost_at_time)}</td>
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

          {/* REQUISITIONS COSTED ON NO PARTY (owner rulings 34, 43, 52). Raised
              with no party id under a name this party shares with another that
              evening, or carrying an id on several F&Ps that nothing picks, or an
              id the F&P it was raised from no longer carries — so no P&L carries
              them. Listed — never summed — so this modal shows what the row's
              badge counts, and nobody reads the gap as missing. */}
          {!loadingExisting && unassignedReqsHere.length > 0 && (
            <div className="border border-red-200 rounded-lg px-2 py-1.5 text-[10px] text-red-800 bg-red-50">
              <b>Not costed on this P&amp;L:</b>{' '}
              {unassignedReqsHere.map((q, qi) => (
                <span key={q.req_id}>
                  {qi > 0 && '; '}
                  <span className="font-mono">{q.req_number || q.req_id}</span> under &ldquo;{q.event_name}&rdquo;
                  {q.reason === 'id_on_several_parties' && q.party_unique_id && <> (id {q.party_unique_id})</>}
                  {q.reason === 'id_changed_after_recording' && <> (id {q.party_unique_id} — id changed after recording)</>}
                  {' '}matches {q.candidates.map(candidateLabel).join(', ')}
                </span>
              ))}
              . A requisition without a party id is costed only when exactly one party that evening has its name;
              one whose id is on more than one F&amp;P, on the F&amp;P it was raised from — else only when exactly one of them is on its date;
              one raised from an F&amp;P on the list that now carries a different id or none, on none.
            </div>
          )}

          {/* RECONCILIATION. The two blocks above are the whole liquor cost this
              event carries on the P&L, so their sum must equal the figure printed
              on the list. Showing the arithmetic is what proves the modal is no
              longer hiding a source — and what tells someone the number they are
              looking for is already here, before they reach for the form below. */}
          {!loadingExisting && (reqItems.length > 0 || existing.length > 0) && (
            <div className="text-[11px] bg-[#FFF8F0] border border-[#E8D5C4] rounded p-2 flex items-center justify-between gap-2 flex-wrap">
              <span className="text-[#6B5744]">
                Liquor cost on the P&amp;L for this event
                <span className="text-[#8B7355]">
                  {' '}= {fmt(reqTotal)} requisition + {fmt(existingTotal)} recorded here
                </span>
              </span>
              <span className="font-mono font-semibold text-[#2D1B0E]">{fmt(reqTotal + existingTotal)}</span>
            </div>
          )}

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
                    // ~1538-1552) and the vendor-bill composer's locked chip
                    // (the ad-hoc GRN modal in src/app/grn/page.tsx), so a line's
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
                  {/* The one that actually double-counts money: this material is
                      already costed from the bar requisition, so saving it here
                      charges the party for the same bottle twice. The API refuses
                      it once and asks for confirmation; this is the warning before
                      that happens. */}
                  {l.material_id && reqMaterialIds.has(l.material_id) && (
                    <div className="text-[10px] text-red-700 mt-0.5">
                      ⚠ Already costed from Bar requisition {reqMaterialIds.get(l.material_id)!.req_number || '(this party)'} —
                      saving this counts the same item twice. Only add it if it was drawn on top of what was issued.
                    </div>
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

          {/* THE DOUBLE-COUNT STOP. Nothing was written: the API refused with 409
              and named the requisition line the material is already costed on.
              Recording it anyway stays possible — a party can genuinely drink more
              than was issued — but it now takes a deliberate second click. */}
          {dupes && dupes.length > 0 && (
            <div className="bg-red-50 border border-red-300 rounded p-3 text-xs space-y-2">
              <div className="font-semibold text-red-800 flex items-center gap-1">
                <AlertTriangle size={13} /> Nothing was saved — this would count the same item twice
              </div>
              <ul className="space-y-1">
                {dupes.map(d => (
                  <li key={d.material_id} className="text-red-700">
                    <b>{d.material_name}</b> is already costed at {fmt(d.cost)} from Bar requisition{' '}
                    <span className="font-mono">{d.req_number || '(this party)'}</span>
                    {d.qty_issued ? ` (${fmtQtyNum(d.qty_issued)} ${d.issued_unit} issued)` : ''}.
                  </li>
                ))}
              </ul>
              <div className="text-[11px] text-red-700">
                It is already in the liquor cost on the P&amp;L. Record it here only if this is <b>extra</b> stock
                drawn from the bar on top of what the store issued.
              </div>
              <div className="flex flex-wrap gap-2 pt-0.5">
                <button type="button" onClick={() => { setDupes(null); }}
                        className="px-3 py-1.5 rounded text-xs bg-white border border-red-300 text-red-800 hover:bg-red-100">
                  Cancel — it is already counted
                </button>
                <button type="button" onClick={() => submit(true)} disabled={saving}
                        className="px-3 py-1.5 rounded text-xs bg-red-700 hover:bg-red-800 text-white disabled:opacity-50">
                  {saving ? 'Saving…' : 'Record anyway — this is extra stock'}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-6 py-3 border-t border-[#E8D5C4] shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm text-[#6B5744] hover:bg-[#FFF1E3] rounded">Close</button>
          {/* () => submit() — NOT onClick={submit}. Passing the click handler
              directly would hand React's MouseEvent in as confirmDuplicates and
              post a truthy confirm on the very first click, skipping the gate. */}
          <button onClick={() => submit()} disabled={saving}
                  className="inline-flex items-center gap-1.5 px-4 py-2 bg-[#af4408] hover:bg-[#933807] text-white rounded text-sm disabled:opacity-50">
            {saving ? <Loader2 className="animate-spin" size={14} /> : <Plus size={14} />}
            {saving ? 'Saving…' : 'Save Consumption'}
          </button>
        </div>
      </div>
    </div>
  );
}
