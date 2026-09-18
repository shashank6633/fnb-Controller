'use client';

/**
 * Butchering — carcass breakdown tracking.
 *
 * List of batches + New Batch wizard + Yield Report.
 * SOP reference: docs/SOP-mutton-carcass-yield.md
 *
 * Flow:
 *   1. Click "New Batch" → enter source carcass + gross weight → batch opens
 *   2. Add output lines (cuts + waste) with weights → see reconciliation live
 *   3. Click "Close Batch" → inventory transactions post (source debit, cuts credit)
 *   4. Yield report shows weekly avg yield % vs AKAN standard
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Scissors, Plus, Loader2, X, Save, AlertTriangle, CheckCircle2, BarChart3, Trash2,
} from 'lucide-react';
import MaterialTypeahead from '@/components/MaterialTypeahead';
import { api } from '@/lib/api';

const fmt = (v: number) => '₹' + Math.round(v || 0).toLocaleString('en-IN');
// Butchering weights are stored + shown in each material's RECIPE unit (source
// debit = source unit, cut credit = cut unit) — so labels come from data,
// never a hardcoded 'kg'. 'kg' is only the fallback when no unit is known yet.
const fmtWt = (v: number, unit?: string | null) => (v || 0).toFixed(3) + ' ' + (unit || 'kg');
const uNorm = (u?: string | null) => String(u || 'kg').toLowerCase().trim();
// Cheap metric map (g↔kg, ml↔l only). Yield % and the reconciliation strip
// divide/sum weights across DIFFERENT materials — meaningful only when units
// agree. This factor makes them agree where physically possible; anything else
// (pcs, btl…) is non-convertible and must be dashed/excluded, never guessed.
const METRIC: Record<string, { base: string; f: number }> = {
  g: { base: 'g', f: 1 }, kg: { base: 'g', f: 1000 },
  ml: { base: 'ml', f: 1 }, l: { base: 'ml', f: 1000 }, ltr: { base: 'ml', f: 1000 }, litre: { base: 'ml', f: 1000 },
};
// Factor converting 1 `from` unit into `to` units; null = not convertible.
const wtFactor = (from?: string | null, to?: string | null): number | null => {
  const f = uNorm(from), t = uNorm(to);
  if (f === t) return 1;
  const F = METRIC[f], T = METRIC[t];
  return F && T && F.base === T.base ? F.f / T.f : null;
};
const today = () => new Date().toISOString().slice(0, 10);

interface Material {
  id: string; name: string; sku?: string; unit?: string; average_price?: number; category?: string;
  /** Owner's manual tags (raw_materials.is_butchering_source / _output, set on
   *  Inventory → Raw Materials). They arrive free on /api/inventory because that
   *  route is `SELECT rm.*`. 0/1 from SQLite; read through Number() so a "1"
   *  string from a CSV round-trip counts too. Optional so an older payload (or a
   *  server that has not migrated yet) simply reads as untagged instead of
   *  crashing the picker. */
  is_butchering_source?: number | string | null;
  is_butchering_output?: number | string | null;
}
/** TRUE only for an explicit tag. Anything absent/null/0 is "not tagged", never "maybe". */
const isTagged = (v: unknown) => Number(v) === 1;
interface Batch {
  id: string; batch_id: string; source_material_id: string; source_material_name: string;
  source_material_unit?: string;
  gross_weight: number; invoice_weight?: number; cost_per_unit: number; total_cost: number;
  butcher: string; head_chef: string; status: 'open' | 'closed' | 'cancelled';
  cut_count: number; total_cut_weight: number; total_waste_weight: number;
  cut_units?: string | null;   // DISTINCT cut units, comma-joined (from list API)
  notes?: string; created_at: string; closed_at?: string;
}
type OutputLine = {
  output_type: 'cut' | 'waste';
  material_id: string;
  waste_category: string;
  weight: string;
  notes: string;
};
const WASTE_CATEGORIES = [
  { key: 'fat', label: 'Fat / suet' },
  { key: 'sinew', label: 'Sinew / silver-skin' },
  { key: 'discarded_bone', label: 'Discarded bone' },
  { key: 'spoilage', label: 'Spoilage / unfit' },
  { key: 'other', label: 'Other' },
];

export default function ButcheringPage() {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'batches' | 'yield'>('batches');
  const [showNew, setShowNew] = useState(false);
  const [openBatchId, setOpenBatchId] = useState<string | null>(null);

  const [pageError, setPageError] = useState<string | null>(null);

  const reload = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/butchering');
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setPageError(d.error || `Failed to load batches (HTTP ${r.status})`); setBatches([]); return; }
      setPageError(null);
      setBatches(Array.isArray(d.batches) ? d.batches : []);
    } catch (e: any) {
      setPageError(e?.message || 'Failed to load batches');
      setBatches([]);
    } finally {
      setLoading(false);
    }
  };
  // scope=all — Butchering needs to pick source carcasses + cut SKUs from
  // the full catalog, not the current user's dept-restricted view.
  const reloadMaterials = async () => {
    try {
      const r = await fetch('/api/inventory?scope=all');
      const d = await r.json().catch(() => ({}));
      const list = Array.isArray(d.materials) ? d.materials : Array.isArray(d) ? d : [];
      setMaterials(list);
    } catch { /* keep previous list */ }
  };
  useEffect(() => {
    reload();
    reloadMaterials();
  }, []);

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center gap-3 flex-wrap">
        <Scissors className="text-[#af4408]" size={24} />
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-[#2D1B0E]">Butchering</h1>
          <p className="text-xs text-[#8B7355]">
            Track whole-carcass breakdown into named cuts with cost allocation + yield monitoring.
            See <code className="bg-[#FFF1E3] px-1 rounded text-[10px]">docs/SOP-mutton-carcass-yield.md</code>.
          </p>
        </div>
        <button onClick={() => setShowNew(true)}
                className="inline-flex items-center gap-1.5 px-3 py-2 bg-[#af4408] hover:bg-[#933807] text-white rounded text-sm">
          <Plus size={14} /> New Batch
        </button>
      </div>

      <div className="flex gap-2 border-b border-[#E8D5C4]">
        <button onClick={() => setTab('batches')}
                className={`px-3 py-2 text-sm border-b-2 ${tab === 'batches' ? 'border-[#af4408] text-[#af4408] font-medium' : 'border-transparent text-[#6B5744]'}`}>
          Batches
        </button>
        <button onClick={() => setTab('yield')}
                className={`px-3 py-2 text-sm border-b-2 ${tab === 'yield' ? 'border-[#af4408] text-[#af4408] font-medium' : 'border-transparent text-[#6B5744]'}`}>
          <BarChart3 size={12} className="inline mr-1" /> Yield Report
        </button>
      </div>

      {pageError && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-xs flex items-center gap-2">
          <AlertTriangle size={14} className="shrink-0" /> {pageError}
          <button onClick={reload} className="ml-auto underline hover:no-underline">Retry</button>
        </div>
      )}

      {tab === 'batches' ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
          {loading ? (
            <div className="p-6 text-center text-sm text-[#8B7355]"><Loader2 className="animate-spin inline mr-1" size={14}/>Loading…</div>
          ) : batches.length === 0 ? (
            <div className="p-10 text-center text-sm text-[#8B7355]">
              No batches yet. Click <strong>New Batch</strong> after receiving a carcass.
            </div>
          ) : (
            <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[760px]">
              <thead className="bg-[#FFF1E3] text-[#6B5744]">
                <tr>
                  <th className="text-left  py-2 px-3 font-medium">Batch ID</th>
                  <th className="text-left  py-2 px-3 font-medium">Source</th>
                  <th className="text-right py-2 px-3 font-medium">Gross</th>
                  <th className="text-right py-2 px-3 font-medium">Cuts</th>
                  <th className="text-right py-2 px-3 font-medium">Waste %</th>
                  <th className="text-right py-2 px-3 font-medium">Total Cost</th>
                  <th className="text-left  py-2 px-3 font-medium">Butcher</th>
                  <th className="text-left  py-2 px-3 font-medium">Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {batches.map(b => {
                  const wastePct = b.gross_weight > 0 ? (b.total_waste_weight / b.gross_weight) * 100 : 0;
                  const wasteTone = wastePct > 12 ? 'text-red-700 font-semibold' : wastePct > 10 ? 'text-amber-700' : 'text-emerald-700';
                  return (
                    <tr key={b.id} className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF8F0] cursor-pointer"
                        onClick={() => setOpenBatchId(b.id)}>
                      <td className="py-1.5 px-3 font-mono text-[#af4408]">{b.batch_id}</td>
                      <td className="py-1.5 px-3 text-[#2D1B0E]">{b.source_material_name}</td>
                      <td className="py-1.5 px-3 text-right font-mono">{fmtWt(b.gross_weight, b.source_material_unit)}</td>
                      {/* total_cut_weight is a raw SUM across cut materials — only
                          truthful when they all share ONE unit (cut_units has no
                          comma); mixed/unknown units show the count alone. */}
                      <td className="py-1.5 px-3 text-right font-mono">
                        {b.cut_count}{b.cut_units && !b.cut_units.includes(',') ? ` (${fmtWt(b.total_cut_weight, b.cut_units)})` : ''}
                      </td>
                      <td className={`py-1.5 px-3 text-right font-mono ${wasteTone}`}>{wastePct.toFixed(1)}%</td>
                      <td className="py-1.5 px-3 text-right font-mono">{fmt(b.total_cost)}</td>
                      <td className="py-1.5 px-3 text-[#6B5744]">{b.butcher || '—'}</td>
                      <td className="py-1.5 px-3">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                          b.status === 'closed' ? 'bg-emerald-100 text-emerald-700' :
                          b.status === 'cancelled' ? 'bg-red-100 text-red-700' :
                          'bg-amber-100 text-amber-700'
                        }`}>{b.status}</span>
                      </td>
                      <td></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          )}
        </div>
      ) : (
        <YieldReportPanel />
      )}

      {showNew && (
        <NewBatchModal
          materials={materials}
          onSeeded={reloadMaterials}
          onClose={() => setShowNew(false)}
          onCreated={(id) => { setShowNew(false); setOpenBatchId(id); reload(); }}
          onSaved={() => reload()}
        />
      )}
      {openBatchId && (
        <BatchDetailModal
          batchId={openBatchId}
          materials={materials}
          onClose={() => { setOpenBatchId(null); reload(); }}
        />
      )}
    </div>
  );
}

/* ──────────────── New Batch Modal ──────────────── */

function NewBatchModal({ materials, onSeeded, onClose, onCreated, onSaved }: {
  materials: Material[];
  onSeeded: () => void;
  onClose: () => void;
  onCreated: (id: string) => void;
  /** Save-and-continue: refresh the list behind the modal without closing it. */
  onSaved: (id: string) => void;
}) {
  const [batchId, setBatchId] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [grossWeight, setGrossWeight] = useState('');
  const [invoiceWeight, setInvoiceWeight] = useState('');
  const [butcher, setButcher] = useState('');
  const [headChef, setHeadChef] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [seedResult, setSeedResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAllSources, setShowAllSources] = useState(false);   // last-resort escape hatch
  /** Set after a save-and-continue, so the form can say which batch it just wrote. */
  const [justSaved, setJustSaved] = useState<string | null>(null);

  /* ── WHICH ITEMS MAY BE A SOURCE CARCASS — two tiers, on purpose ─────────
     TIER 1 · the owner's own tag (raw_materials.is_butchering_source, ticked on
     Inventory → Raw Materials). This is the only trustworthy answer, because a
     tag can say pork, duck, turkey, quail or a house name — none of which any
     keyword list will ever guess.

     TIER 2 · the OLD guess, kept DELIBERATELY as a second tier. It is wrong in
     both directions: it offered CHICKEN SEASONING POWDER 500 GM and FISH SAUCE
     700 ML as carcasses to break down, and it could never offer pork. But on the
     day this ships NOTHING is tagged (both columns default 0), and silently
     emptying a dropdown that works today would be a worse bug than the one being
     fixed. So tier 2 stays, is LABELLED as a guess so it is obvious which rows
     still need confirming, and shrinks on its own as he tags items.

     The two tiers are rendered as separate <optgroup>s — that is what makes the
     tier visible on screen without inventing a new widget. */
  const isTaggedSource = (m: Material) => isTagged(m.is_butchering_source);
  const MEAT_CATS = ['meat', 'mutton', 'chicken', 'poultry', 'seafood', 'fish', 'prawn', 'lamb', 'goat', 'non-veg', 'nonveg', 'non veg'];
  const looksLikeMeat = (m: Material) => {
    const cat = String(m.category || '').toLowerCase().trim();
    if (MEAT_CATS.includes(cat)) return true;
    const hay = `${m.name || ''} ${m.sku || ''}`.toLowerCase();
    return /carcass|mutton|chicken|lamb|goat|poultry|seafood|prawn|\bmeat\b|\bfish\b/.test(hay);
  };
  const taggedSources  = useMemo(() => materials.filter(isTaggedSource), [materials]);
  const guessedSources = useMemo(() => materials.filter(m => !isTaggedSource(m) && looksLikeMeat(m)), [materials]);
  const otherSources   = useMemo(() => materials.filter(m => !isTaggedSource(m) && !looksLikeMeat(m)), [materials]);
  /**
   * THE PROMISE THE BANNER MAKES, KEPT.
   *
   * While nothing is marked, the name-guesses are all he has, so they are
   * offered and the banner explains why. The moment he marks even ONE carcass,
   * they stop being offered — which is exactly what that banner told him would
   * happen ("After that only those items appear here").
   *
   * Leaving them in was measured as the thing that makes a WORKING tag read as
   * a broken one: he marks three carcasses, reopens, and is still offered
   * CHICKEN SEASONING IMPPORTED and CRAB STICKS — while the sentence that
   * explained the guesses has disappeared, because it only shows at zero.
   *
   * They are never hidden, only un-offered: "Show every item in the store" puts
   * them back, one click away, which is also the escape hatch for the day he
   * buys a carcass he has not marked yet.
   */
  const visibleGuesses = (taggedSources.length === 0 || showAllSources) ? guessedSources : [];
  // Honest count: what is ACTUALLY listed right now, not "41 meat/carcass".
  const shownSourceCount = taggedSources.length + visibleGuesses.length + (showAllSources ? otherSources.length : 0);
  // Weight fields debit the SOURCE material's stock verbatim → label with ITS
  // recipe unit ('kg' only until a source is picked).
  const pickedSource = materials.find(m => m.id === sourceId) || null;
  const srcUnit = pickedSource?.unit || 'kg';
  // A source picked while "show all" was ON must not silently vanish when it is
  // switched off: a <select> whose value matches no <option> renders BLANK while
  // sourceId still posts. Keep it visible in its own group instead.
  const pickedSourceListed = !!pickedSource
    && (isTaggedSource(pickedSource) || looksLikeMeat(pickedSource) || showAllSources);
  const optLabel = (m: Material) => `${m.sku ? `[${m.sku}] ` : ''}${m.name}${m.unit ? ` (${m.unit})` : ''}`;

  // Detect if the standard mutton cuts are missing — if so, surface a 1-click seed button
  const hasMuttonCarcass = materials.some(m =>
    (m as any).sku === 'MEAT-MUT-CARCASS' || /mutton.*carcass/i.test(m.name || '')
  );
  const seedMuttonCuts = async () => {
    setSeeding(true); setError(null); setSeedResult(null);
    try {
      const r = await api('/api/butchering/seed-mutton-cuts', { method: 'POST', body: {} });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setSeedResult(j.summary || 'Done.');
      onSeeded();  // refresh the materials list in place — no manual page reload
    } finally { setSeeding(false); }
  };

  // Suggest a batch ID like MUT-20260520-VVV-01 when a source is picked
  const suggestId = () => {
    if (!sourceId) return;
    const mat = materials.find(m => m.id === sourceId);
    const prefix = (mat?.sku || mat?.name || 'BATCH').toUpperCase().split(/[\s-]/)[0].slice(0, 3);
    const date = today().replace(/-/g, '');
    setBatchId(`${prefix}-${date}-01`);
  };

  /**
   * ONE BATCH IS ONE SOURCE — the owner's ruling, 2026-09-18, after trying to
   * add a second item and finding it replaced the first.
   *
   * It is not a limitation of this form: `butchering_batches` carries ONE
   * source_material_id and ONE gross_weight, and every figure the module exists
   * to produce is computed against them. Yield is cut ÷ gross and cost is
   * prorated the same way, so pooling a mutton carcass with a bag of chicken
   * legs would make 4 kg of breast read as "27% of everything" instead of "80%
   * of the bird" — and the AKAN yield standards (leg 24-28%, shoulder 16-19%)
   * stop being comparable to anything.
   *
   * So the answer to "I broke down two things this morning" is TWO BATCHES, and
   * the job of this screen is to make that quick rather than to hide the rule:
   * `keepGoing` saves and immediately reopens with the date, butcher, head chef
   * and vendor carried forward, so the second batch costs one field.
   */
  const submit = async (keepGoing = false) => {
    if (!batchId.trim()) { setError('Batch ID required'); return; }
    if (!sourceId) { setError('Pick the source carcass material'); return; }
    if (!(Number(grossWeight) > 0)) { setError('Gross weight must be a number greater than 0'); return; }
    if (invoiceWeight && !(Number(invoiceWeight) >= 0)) { setError('Invoice weight must be a number ≥ 0'); return; }
    setSaving(true); setError(null);
    try {
      const r = await api('/api/butchering', {
        method: 'POST',
        body: {
          batch_id: batchId.trim(),
          source_material_id: sourceId,
          gross_weight: Number(grossWeight),
          invoice_weight: invoiceWeight ? Number(invoiceWeight) : null,
          butcher: butcher.trim(),
          head_chef: headChef.trim(),
          notes: notes.trim(),
        },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      if (!keepGoing) { onCreated(j.batch.id); return; }
      // SAVE AND START ANOTHER. The people-and-paperwork fields stay; the ones
      // that describe THIS carcass are cleared, because carrying a weight or a
      // batch id forward is how two batches end up claiming the same number.
      onSaved(j.batch.id);
      setSourceId(''); setGrossWeight(''); setInvoiceWeight(''); setBatchId('');
      setJustSaved(String(j.batch.batch_id || '').trim());
      setError(null);
    } finally { setSaving(false); }
  };

  return (
    <ModalShell title="New Carcass Batch" onClose={onClose}>
      {!hasMuttonCarcass && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-3 flex items-start gap-3">
          <AlertTriangle size={16} className="text-amber-700 shrink-0 mt-0.5" />
          <div className="flex-1 text-xs text-amber-900">
            <div className="font-semibold">Standard mutton cuts not in catalog</div>
            <div className="mt-0.5">
              Click below to one-time create: <strong>Mutton Carcass</strong> (source) + Leg, Shoulder, Chops, Ribs, Mince, Offal, Bones.
              Idempotent — won't duplicate existing SKUs.
            </div>
            {seedResult && <div className="mt-1 text-emerald-700">✓ {seedResult} They&apos;re in the dropdown now.</div>}
          </div>
          <button onClick={seedMuttonCuts} disabled={seeding}
                  className="text-xs px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded whitespace-nowrap disabled:opacity-50">
            {seeding ? <Loader2 size={11} className="inline animate-spin" /> : '+ Seed Mutton Cuts'}
          </button>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 text-sm">
        <Field label="Source carcass * — one per batch" className="col-span-2">
          {/* SAYING IT ON THE LABEL, because the owner tried to add a second item
              and watched it replace the first with nothing on screen admitting
              why. One batch is one source: yield is cut ÷ gross and cost is
              prorated the same way, so two different animals in one batch make
              every percentage an average of unlike things. The answer is the
              "Save & start another" button below, not a second slot here. */}
          <select value={sourceId} onChange={e => { setSourceId(e.target.value); if (!batchId) setTimeout(suggestId, 0); }}
                  className="w-full px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3]">
            <option value="">— pick a carcass / meat item —</option>
            {pickedSource && !pickedSourceListed && (
              <optgroup label="Currently selected">
                <option value={pickedSource.id}>{optLabel(pickedSource)}</option>
              </optgroup>
            )}
            {taggedSources.length > 0 && (
              <optgroup label={`Carcasses you have marked (${taggedSources.length})`}>
                {taggedSources.map(m => <option key={m.id} value={m.id}>{optLabel(m)}</option>)}
              </optgroup>
            )}
            {visibleGuesses.length > 0 && (
              <optgroup label={`Not marked yet — guessed from the name (${visibleGuesses.length})`}>
                {visibleGuesses.map(m => <option key={m.id} value={m.id}>{optLabel(m)}</option>)}
              </optgroup>
            )}
            {showAllSources && otherSources.length > 0 && (
              <optgroup label={`Everything else in the store (${otherSources.length})`}>
                {otherSources.map(m => <option key={m.id} value={m.id}>{optLabel(m)}</option>)}
              </optgroup>
            )}
          </select>
          <p className="mt-1 text-[10px] text-[#8B7355]">
            Breaking down more than one thing today? Record them as separate batches —
            use <strong>Save &amp; start another</strong> below and the date, butcher and head chef stay put.
            Each batch keeps its own honest yield.
          </p>
          <label className="flex items-center gap-1.5 mt-1 text-[11px] text-[#8B7355]">
            <input type="checkbox" checked={showAllSources} onChange={e => setShowAllSources(e.target.checked)} />
            Show every item in the store
            <span className="text-[#A08B72]">
              (listing {shownSourceCount} of {materials.length} — {taggedSources.length} marked
              {visibleGuesses.length > 0 ? `, ${visibleGuesses.length} guessed` : ''}
              {showAllSources ? `, ${otherSources.length} other` : ''})
            </span>
          </label>
          {/* Once he HAS marked some, say so plainly — otherwise the list simply
              gets shorter with nothing on screen admitting why, and a guess he
              used yesterday has silently vanished. */}
          {materials.length > 0 && taggedSources.length > 0 && guessedSources.length > 0 && !showAllSources && (
            <div className="mt-1 text-[10px] text-[#8B7355]">
              Showing only the {taggedSources.length} carcass{taggedSources.length === 1 ? '' : 'es'} you marked.
              {' '}{guessedSources.length} more were guessed from their names and are not shown — tick the box above to see them.
            </div>
          )}
          {/* Only when the catalog actually LOADED. reloadMaterials() swallows a
              fetch failure (`catch { keep previous list }`), so on a failed load
              materials is [] — and "nothing is marked, go and mark it" would then
              be a lie about a network problem. */}
          {materials.length > 0 && taggedSources.length === 0 && (
            <div className="mt-1.5 text-[11px] bg-[#FFF8F0] border border-[#E8D5C4] rounded p-2 text-[#6B5744] leading-relaxed">
              <strong className="text-[#2D1B0E]">No carcasses have been marked yet</strong>, so this list is
              only a guess from the item name. That means it can miss pork, duck or anything with a house name,
              and it can offer things that are not carcasses at all.
              <br />
              To fix it for good: open <strong>Inventory → Raw Materials</strong> and mark each whole carcass
              you actually buy — mutton carcass, whole chicken, and so on. After that only those items appear here.
            </div>
          )}
        </Field>
        <Field label="Batch ID *" hint="auto-suggested when source is picked">
          <div className="flex gap-2">
            <input value={batchId} onChange={e => setBatchId(e.target.value)}
                   placeholder="MUT-20260520-RAJBR-01"
                   className="flex-1 px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] font-mono text-xs" />
            <button type="button" onClick={suggestId}
                    className="text-xs text-[#af4408] hover:underline whitespace-nowrap">Suggest</button>
          </div>
        </Field>
        <Field label="Butcher">
          <input value={butcher} onChange={e => setButcher(e.target.value)}
                 className="w-full px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3]" />
        </Field>
        <Field label={`Gross dressed weight (${srcUnit}) *`}>
          <input type="number" step="any" min="0" value={grossWeight} onChange={e => setGrossWeight(e.target.value)}
                 placeholder="14.250"
                 className="w-full px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] text-right font-mono" />
        </Field>
        <Field label={`Invoice weight (${srcUnit})`} hint="for variance check vs vendor">
          <input type="number" step="any" min="0" value={invoiceWeight} onChange={e => setInvoiceWeight(e.target.value)}
                 className="w-full px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] text-right font-mono" />
        </Field>
        <Field label="Head Chef">
          <input value={headChef} onChange={e => setHeadChef(e.target.value)}
                 className="w-full px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3]" />
        </Field>
        <Field label="Notes" className="col-span-2">
          <input value={notes} onChange={e => setNotes(e.target.value)}
                 placeholder="Vendor delivery notes, animal quality observations…"
                 className="w-full px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3]" />
        </Field>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded p-2 text-xs mt-3">{error}</div>}

      {justSaved && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded p-2 text-xs mt-3">
          Saved <strong>{justSaved}</strong>. Pick the next item and its weight — the date, butcher,
          head chef and any notes are still here.
        </div>
      )}

      <ModalFooter onClose={onClose}>
        {/* ONE BATCH IS ONE SOURCE. Two buttons instead of one, because the
            common case after a delivery is several things to break down and the
            alternative — reopening this modal and retyping the butcher's name
            four times — is what makes a person want to pool them into one
            batch and lose every yield figure. */}
        <button onClick={() => submit(true)} disabled={saving}
                title="Save this one and stay here for the next item"
                className="inline-flex items-center gap-1.5 px-3 py-2 border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 rounded text-sm disabled:opacity-50">
          {saving ? <Loader2 className="animate-spin" size={14} /> : <Plus size={14} />}
          Save & start another
        </button>
        <button onClick={() => submit(false)} disabled={saving}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-[#af4408] hover:bg-[#933807] text-white rounded text-sm disabled:opacity-50">
          {saving ? <Loader2 className="animate-spin" size={14} /> : <Plus size={14} />}
          {saving ? 'Creating…' : 'Create Batch & Add Cuts'}
        </button>
      </ModalFooter>
    </ModalShell>
  );
}

/* ──────────────── Batch Detail (add outputs + close) ──────────────── */

function BatchDetailModal({ batchId, materials, onClose }: {
  batchId: string;
  materials: Material[];
  onClose: () => void;
}) {
  const [batch, setBatch] = useState<any>(null);
  const [outputs, setOutputs] = useState<OutputLine[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(false);
  // Editable batch details (open batches only) — saved with every Save Draft
  const [grossW, setGrossW] = useState('');
  const [invoiceW, setInvoiceW] = useState('');
  const [butcher, setButcher] = useState('');
  const [headChef, setHeadChef] = useState('');
  const [notes, setNotes] = useState('');
  const [showAllCuts, setShowAllCuts] = useState(false);

  /* ── WHICH ITEMS MAY BE A CUT ─────────────────────────────────────────────
     This picker used to be handed the WHOLE catalog with no filter at all, so it
     offered 00 FLOUR, 100 PIPERS (750ML), 300 Coupons and 350ML DISPOSABLE GLASS
     as cuts of a carcass. Now it is the owner's tag (is_butchering_output) and
     nothing else — there is no keyword tier here, because a cut has no reliable
     keyword (LEG, CHOPS, MINCE, SUPREME, KEEMA are all just words) and guessing
     is exactly what produced the mess.

     WHEN NOTHING IS TAGGED (today: 0 of 952 rows) the picker falls back to the
     whole catalog rather than showing an empty box, so a batch can still be
     recorded on day one — with a banner saying plainly why, and where to fix it.
     The moment one item is tagged, the list snaps to the tagged set.

     NOTE the tag says "this CAN come out of a carcass" — it never stops the item
     being bought from a vendor, and it is not what the yield report counts (that
     reads butchering_outputs rows). The banner says so, so he is not afraid to
     tick it on an item he also purchases. */
  const taggedCuts = useMemo(() => materials.filter(m => isTagged(m.is_butchering_output)), [materials]);
  // `materials.length > 0` guard: reloadMaterials() swallows a fetch failure, so a
  // failed load also yields 0 tagged. Without the guard the banner would blame the
  // owner for not tagging when the real problem is that nothing loaded.
  const noCutsTagged = materials.length > 0 && taggedCuts.length === 0;
  const cutPool = (showAllCuts || noCutsTagged) ? materials : taggedCuts;

  const load = async () => {
    setLoadError(null);
    try {
      const r = await fetch(`/api/butchering?id=${batchId}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.batch) { setLoadError(d.error || `Failed to load batch (HTTP ${r.status})`); return; }
      setBatch(d.batch);
      setGrossW(String(d.batch.gross_weight ?? ''));
      setInvoiceW(d.batch.invoice_weight != null ? String(d.batch.invoice_weight) : '');
      setButcher(d.batch.butcher || '');
      setHeadChef(d.batch.head_chef || '');
      setNotes(d.batch.notes || '');
      if (d.batch?.outputs?.length > 0) {
        setOutputs(d.batch.outputs.map((o: any) => ({
          output_type: o.output_type,
          material_id: o.material_id || '',
          waste_category: o.waste_category || 'other',
          weight: String(o.weight),
          notes: o.notes || '',
        })));
      } else {
        // Seed with one blank line for each
        setOutputs([{ output_type: 'cut', material_id: '', waste_category: '', weight: '', notes: '' }]);
      }
    } catch (e: any) {
      setLoadError(e?.message || 'Failed to load batch');
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [batchId]);

  const addLine = (type: 'cut' | 'waste') =>
    setOutputs(p => [...p, { output_type: type, material_id: '', waste_category: type === 'waste' ? 'fat' : '', weight: '', notes: '' }]);
  const removeLine = (i: number) => setOutputs(p => p.filter((_, idx) => idx !== i));
  const update = (i: number, patch: Partial<OutputLine>) =>
    setOutputs(p => p.map((o, idx) => idx === i ? { ...o, ...patch } : o));

  const srcUnit = batch?.source_material_unit || 'kg';
  // Cost-proration basis — MIRRORS the server: each cut normalized into the
  // source unit, non-convertible units falling back to the raw weight (??1).
  // Positive raw stays positive, so the "has cuts" gate is unaffected.
  const totalCut = useMemo(() => outputs.filter(o => o.output_type === 'cut').reduce((a, o) => {
    const u = materials.find(m => m.id === o.material_id)?.unit || srcUnit;
    return a + (Number(o.weight) || 0) * (wtFactor(u, srcUnit) ?? 1);
  }, 0), [outputs, materials, srcUnit]);
  // Normalized reconciliation: each line's weight converted into the SOURCE
  // unit (g↔kg, ml↔l) before summing — a 500 g cut of a kg carcass counts as
  // 0.5, not 500. Waste is recorded against the SOURCE material → source unit.
  // Non-convertible lines (e.g. pcs vs kg) are EXCLUDED from the strip + gap
  // math (adding pcs to kg is meaningless) and surfaced as an excluded count.
  const { totalCutN, totalWasteN, excluded } = useMemo(() => {
    let cut = 0, waste = 0, excluded = 0;
    for (const o of outputs) {
      const w = Number(o.weight) || 0;
      if (!(w > 0)) continue;
      const unit = o.output_type === 'waste' ? srcUnit
        : (materials.find(m => m.id === o.material_id)?.unit || srcUnit); // unpicked cut: assume source unit
      const k = wtFactor(unit, srcUnit);
      if (k == null) { excluded++; continue; }
      if (o.output_type === 'cut') cut += w * k; else waste += w * k;
    }
    return { totalCutN: cut, totalWasteN: waste, excluded };
  }, [outputs, materials, srcUnit]);
  // Live basis: the recon strip, per-line yields and costs all follow the
  // EDITED gross weight so what you see is exactly what saving produces.
  const gross = Number(grossW) > 0 ? Number(grossW) : 0;
  const liveTotalCost = (batch?.cost_per_unit || 0) * gross;
  const gap = gross - (totalCutN + totalWasteN);
  const gapPct = gross > 0 ? Math.abs(gap) / gross : 0;
  const wastePct = gross > 0 ? (totalWasteN / gross) * 100 : 0;
  const withinTolerance = gapPct <= 0.015;

  // Foolproofing: never silently drop a line. Weight without material (or a
  // negative weight) blocks the save with a clear message instead.
  const validate = (): string | null => {
    if (!(Number(grossW) > 0)) return 'Gross weight must be greater than 0.';
    if (invoiceW && !(Number(invoiceW) >= 0)) return 'Invoice weight must be a number ≥ 0.';
    for (const o of outputs) {
      const w = Number(o.weight);
      if (o.weight !== '' && !Number.isFinite(w)) return 'Weights must be numbers.';
      if (w < 0) return 'Weights cannot be negative.';
      if (o.output_type === 'cut' && w > 0 && !o.material_id) {
        return 'A cut line has a weight but no material — pick the cut material or remove the line.';
      }
    }
    return null;
  };

  const saveAndAction = async (action?: 'close') => {
    const v = validate();
    if (v) { setError(v); return; }
    setSaving(true); setError(null);
    try {
      const payload = {
        id: batchId,
        gross_weight: Number(grossW),
        invoice_weight: invoiceW === '' ? null : Number(invoiceW),
        butcher, head_chef: headChef, notes,
        outputs: outputs
          .filter(o => Number(o.weight) > 0)
          .map(o => ({
            output_type: o.output_type,
            material_id: o.output_type === 'cut' ? o.material_id : null,
            waste_category: o.output_type === 'waste' ? o.waste_category : null,
            weight: Number(o.weight),
            notes: o.notes,
          })),
        action,
      };
      const r = await api('/api/butchering', { method: 'PUT', body: payload });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      if (action) { onClose(); return; }
      // Draft saved: keep the outputs EXACTLY as typed (incl. still-empty
      // lines being drafted) — only refresh the batch header from the server.
      if (j.batch) setBatch((prev: any) => ({ ...prev, ...j.batch }));
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 2500);
    } finally { setSaving(false); }
  };

  const cancelBatch = async () => {
    if (!confirm(`Cancel batch ${batch?.batch_id}? It stays in the list as "cancelled" and posts nothing to inventory.`)) return;
    setSaving(true); setError(null);
    try {
      const r = await api('/api/butchering', { method: 'PUT', body: { id: batchId, action: 'cancel' } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      onClose();
    } finally { setSaving(false); }
  };

  if (loadError) {
    return (
      <ModalShell title="Batch" onClose={onClose}>
        <div className="bg-red-50 border border-red-200 text-red-700 rounded p-3 text-sm">{loadError}</div>
      </ModalShell>
    );
  }
  if (!batch) {
    return <ModalShell title="Loading…" onClose={onClose}><div className="p-6 text-center"><Loader2 className="animate-spin inline" /></div></ModalShell>;
  }

  const readOnly = batch.status !== 'open';

  return (
    <ModalShell title={`Batch ${batch.batch_id}`} subtitle={`${batch.source_material_name} · ${fmtWt(batch.gross_weight, batch.source_material_unit)} gross · ${fmt(batch.total_cost)}`}
                onClose={onClose}>
      {readOnly && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded p-2 text-xs mb-3">
          {batch.status === 'closed' ? '✓ This batch is closed — inventory transactions posted.' : '✗ This batch was cancelled.'}
        </div>
      )}

      {/* Batch details — editable while open; every Save Draft persists them
          and re-bases yields/costs on the corrected gross weight. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
        <Field label={`Gross weight (${srcUnit}) *`}>
          <input type="number" step="any" min="0" value={grossW} readOnly={readOnly}
                 onChange={e => setGrossW(e.target.value)}
                 className={`w-full px-2 py-1.5 border border-[#D4B896] rounded text-xs text-right font-mono ${readOnly ? 'bg-[#F7F0E8] text-[#8B7355]' : 'bg-[#FFF1E3]'}`} />
        </Field>
        <Field label={`Invoice weight (${srcUnit})`}>
          <input type="number" step="any" min="0" value={invoiceW} readOnly={readOnly}
                 onChange={e => setInvoiceW(e.target.value)}
                 className={`w-full px-2 py-1.5 border border-[#D4B896] rounded text-xs text-right font-mono ${readOnly ? 'bg-[#F7F0E8] text-[#8B7355]' : 'bg-[#FFF1E3]'}`} />
        </Field>
        <Field label="Butcher">
          <input value={butcher} readOnly={readOnly} onChange={e => setButcher(e.target.value)}
                 className={`w-full px-2 py-1.5 border border-[#D4B896] rounded text-xs ${readOnly ? 'bg-[#F7F0E8] text-[#8B7355]' : 'bg-[#FFF1E3]'}`} />
        </Field>
        <Field label="Head Chef">
          <input value={headChef} readOnly={readOnly} onChange={e => setHeadChef(e.target.value)}
                 className={`w-full px-2 py-1.5 border border-[#D4B896] rounded text-xs ${readOnly ? 'bg-[#F7F0E8] text-[#8B7355]' : 'bg-[#FFF1E3]'}`} />
        </Field>
        <Field label="Notes" className="col-span-2 sm:col-span-4">
          <input value={notes} readOnly={readOnly} onChange={e => setNotes(e.target.value)}
                 className={`w-full px-2 py-1.5 border border-[#D4B896] rounded text-xs ${readOnly ? 'bg-[#F7F0E8] text-[#8B7355]' : 'bg-[#FFF1E3]'}`} />
        </Field>
      </div>

      {/* Reconciliation strip — all figures normalized into the SOURCE unit */}
      <div className={`rounded-lg p-3 grid grid-cols-4 gap-3 text-xs border ${withinTolerance ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'}`}>
        <div><div className="text-[10px] uppercase text-[#8B7355]">Gross</div><div className="font-mono font-semibold">{fmtWt(gross, srcUnit)}</div></div>
        <div><div className="text-[10px] uppercase text-[#8B7355]">Total Cut</div><div className="font-mono font-semibold">{fmtWt(totalCutN, srcUnit)}</div></div>
        <div><div className="text-[10px] uppercase text-[#8B7355]">Total Waste</div><div className={`font-mono font-semibold ${wastePct > 12 ? 'text-red-700' : ''}`}>{fmtWt(totalWasteN, srcUnit)} ({wastePct.toFixed(1)}%)</div></div>
        <div><div className="text-[10px] uppercase text-[#8B7355]">Gap</div><div className={`font-mono font-semibold ${withinTolerance ? 'text-emerald-700' : 'text-amber-700'}`}>{fmtWt(gap, srcUnit)} ({(gapPct*100).toFixed(2)}%)</div></div>
        {excluded > 0 && (
          <div className="col-span-4 text-[10px] text-amber-800">
            {excluded} line{excluded > 1 ? 's' : ''} excluded (unit mismatch — cannot be converted to {srcUnit})
          </div>
        )}
      </div>

      {/* CUTS section */}
      <div className="mt-4">
        <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
          <h3 className="text-sm font-semibold text-[#2D1B0E]">
            Cuts
            {!readOnly && (
              <span className="ml-2 text-[11px] font-normal text-[#8B7355]">
                {materials.length === 0
                  ? '— item list still loading'
                  : noCutsTagged
                    ? `— nothing marked yet, listing all ${materials.length} items`
                    : `— ${taggedCuts.length} item${taggedCuts.length === 1 ? '' : 's'} can be a cut${showAllCuts ? `, listing all ${materials.length}` : ''}`}
              </span>
            )}
          </h3>
          {!readOnly && (
            <div className="flex items-center gap-3">
              {!noCutsTagged && (
                <label className="flex items-center gap-1.5 text-[11px] text-[#8B7355]">
                  <input type="checkbox" checked={showAllCuts} onChange={e => setShowAllCuts(e.target.checked)} />
                  Show every item
                </label>
              )}
              <button onClick={() => addLine('cut')} className="text-xs text-[#af4408] hover:underline"><Plus size={11} className="inline" /> Add cut</button>
            </div>
          )}
        </div>
        {!readOnly && noCutsTagged && (
          <div className="mb-2 text-[11px] bg-[#FFF8F0] border border-[#E8D5C4] rounded p-2 text-[#6B5744] leading-relaxed">
            <strong className="text-[#2D1B0E]">No cuts have been marked yet</strong>, so every item in the store
            is listed below — which is why things like disposable glasses and coupons turn up in the list.
            <br />
            Open <strong>Inventory → Raw Materials</strong> and mark the items you actually get out of a carcass
            — leg, shoulder, chops, ribs, mince, bones, breast, and so on. After that only those appear here.
            <br />
            <span className="text-[#8B7355]">
              Marking an item changes nothing about buying it: you can still purchase the same cut from a vendor,
              and the yield report still counts only what came out of a carcass batch.
            </span>
          </div>
        )}
        <div className="grid grid-cols-12 gap-2 text-[10px] uppercase tracking-wide text-[#8B7355] px-1">
          <div className="col-span-6">Material</div>
          <div className="col-span-2 text-right">Weight</div>
          <div className="col-span-1 text-right">Yield %</div>
          <div className="col-span-2 text-right">Cost</div>
        </div>
        <div className="space-y-1 mt-1">
          {outputs.map((o, i) => o.output_type !== 'cut' ? null : (
            /* materials = the FULL list, for resolving a line's name + unit — a
               closed batch renders read-only from it, so filtering THIS prop
               would blank historical cuts to "—" the moment a tag is removed.
               pickMaterials = the filtered list, used for the picker ONLY. */
            <CutLine key={i} idx={i} line={o} grossWeight={gross} sourceUnit={srcUnit} totalCost={liveTotalCost} materials={materials}
                     pickMaterials={cutPool}
                     totalCutWeight={totalCut} readOnly={readOnly} excludeIds={outputs.filter(x => x.output_type === 'cut' && x.material_id).map(x => x.material_id)}
                     onUpdate={(patch) => update(i, patch)} onRemove={() => removeLine(i)} />
          ))}
        </div>
      </div>

      {/* WASTE section */}
      <div className="mt-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-[#2D1B0E]">Waste</h3>
          {!readOnly && (
            <button onClick={() => addLine('waste')} className="text-xs text-[#af4408] hover:underline"><Plus size={11} className="inline" /> Add waste</button>
          )}
        </div>
        <div className="grid grid-cols-12 gap-2 text-[10px] uppercase tracking-wide text-[#8B7355] px-1">
          <div className="col-span-6">Category</div>
          <div className="col-span-2 text-right">Weight</div>
          <div className="col-span-3">Notes</div>
        </div>
        <div className="space-y-1 mt-1">
          {outputs.map((o, i) => o.output_type !== 'waste' ? null : (
            <WasteLine key={i} idx={i} line={o} sourceUnit={srcUnit} readOnly={readOnly}
                       onUpdate={(patch) => update(i, patch)} onRemove={() => removeLine(i)} />
          ))}
        </div>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded p-2 text-xs mt-3">{error}</div>}

      <ModalFooter onClose={onClose}>
        {!readOnly && (
          <>
            {savedTick && <span className="text-xs text-emerald-700 self-center mr-1">✓ Draft saved</span>}
            <button onClick={cancelBatch} disabled={saving}
                    className="px-4 py-2 text-sm border border-red-200 text-red-600 hover:bg-red-50 rounded">
              Cancel Batch
            </button>
            <button onClick={() => saveAndAction()} disabled={saving}
                    className="px-4 py-2 text-sm border border-[#D4B896] text-[#6B5744] hover:bg-[#FFF1E3] rounded">
              {saving ? <Loader2 className="animate-spin inline" size={14} /> : <Save size={14} className="inline mr-1" />} Save Draft
            </button>
            <button onClick={() => saveAndAction('close')} disabled={saving || !withinTolerance || totalCut === 0}
                    className="inline-flex items-center gap-1.5 px-4 py-2 bg-[#af4408] hover:bg-[#933807] text-white rounded text-sm disabled:opacity-50"
                    title={!withinTolerance ? 'Reconciliation gap too large to close' : totalCut === 0 ? 'Add at least one cut' : ''}>
              <CheckCircle2 size={14} /> Close & Post Inventory
            </button>
          </>
        )}
      </ModalFooter>
    </ModalShell>
  );
}

function CutLine({ idx, line, grossWeight, sourceUnit, totalCost, materials, pickMaterials, totalCutWeight, readOnly, excludeIds, onUpdate, onRemove }: {
  idx: number; line: OutputLine; grossWeight: number; sourceUnit: string; totalCost: number; materials: Material[];
  /** The list the PICKER may offer (tagged cuts). Never used to resolve an
   *  existing line's name/unit — `materials` stays the full catalog for that. */
  pickMaterials: Material[];
  totalCutWeight: number;
  readOnly: boolean; excludeIds: string[];
  onUpdate: (patch: Partial<OutputLine>) => void; onRemove: () => void;
}) {
  const weight = Number(line.weight) || 0;
  const mat = materials.find(m => m.id === line.material_id);
  const unit = mat?.unit || sourceUnit;   // unpicked line: assume source unit until chosen
  // The picker's array MUST contain whatever is already picked. MaterialTypeahead
  // finds its chip via materials.find(m => m.id === value) (component line 149) —
  // miss that and an already-chosen cut renders as an empty search box while
  // line.material_id is still set: reads as "my cut disappeared". So a line
  // drafted before the tag existed (or tagged and then untagged) keeps its chip.
  const pickList = useMemo(() => {
    if (!line.material_id || pickMaterials.some(m => m.id === line.material_id)) return pickMaterials;
    return mat ? [mat, ...pickMaterials] : pickMaterials;
  }, [pickMaterials, line.material_id, mat]);
  // Yield = cut ÷ gross — only meaningful once the cut weight is expressed in
  // the source's unit; non-convertible pairs (pcs vs kg) get a dash, not a lie.
  const k = wtFactor(unit, sourceUnit);
  const yieldPct = k != null && grossWeight > 0 ? (weight * k / grossWeight) * 100 : null;
  // Cost proration mirrors the server: NORMALIZED weights (non-convertible
  // units fall back to raw — same ??1 the server applies).
  const cost = totalCutWeight > 0 ? totalCost * ((weight * (k ?? 1)) / totalCutWeight) : 0;
  return (
    <div className="grid grid-cols-12 gap-2 items-start">
      <div className="col-span-6">
        {readOnly ? (
          <div className="px-2 py-1.5 text-xs font-medium">{mat?.name || '—'}</div>
        ) : (
          /* NO purchaseBasis here — deliberate, do not re-add in a blanket rollout.
             Butchering is recipe-basis end to end: the weight box beside this picker
             is labelled `unit` (mat.unit, line above), the POST sends that number raw,
             and the server credits it verbatim into current_stock (api/butchering
             route.ts:416), prorates cost off it (:290) and writes waste to wastages
             (:441) — all in RECIPE units. With purchaseBasis on, the dropdown read
             "on hand: 846 kg" and the chip read "(kg)" while the box next to it wanted
             grams: a 1000x trap on all 413 materials with a real pack conversion.
             Off, the dropdown prints m.unit and the box prints mat.unit — the SAME
             field, so they cannot disagree for any material, ever. */
          /* pickList, NOT materials: 18 other screens mount MaterialTypeahead
             (incl. liquor + party pages behind deploy gates), so the component
             itself is untouched — the FILTER is applied to what we hand it. */
          <MaterialTypeahead materials={pickList as any} value={line.material_id}
                             onPick={(id: string) => onUpdate({ material_id: id })}
                             excludeIds={excludeIds.filter(x => x !== line.material_id) as string[]} />
        )}
      </div>
      <div className="col-span-2 flex items-center gap-1">
        <input type="number" step="any" min="0" value={line.weight} readOnly={readOnly}
               onChange={e => onUpdate({ weight: e.target.value })}
               className="w-full min-w-0 px-2 py-1.5 border border-[#D4B896] rounded text-xs text-right font-mono" />
        <span className="text-[10px] text-[#8B7355] shrink-0">{unit}</span>
      </div>
      <div className="col-span-1 text-right text-xs font-mono py-2 text-[#6B5744]">
        {yieldPct == null
          ? <span title={`Yield not comparable: cut is in ${unit}, source in ${sourceUnit}`}>—</span>
          : `${yieldPct.toFixed(1)}%`}
      </div>
      <div className="col-span-2 text-right text-xs font-mono py-2 text-[#6B5744]">{fmt(cost)}</div>
      <div className="col-span-1 text-right">
        {!readOnly && (
          <button onClick={onRemove} className="text-red-600 hover:text-red-700"><Trash2 size={12} /></button>
        )}
      </div>
    </div>
  );
}

function WasteLine({ idx, line, sourceUnit, readOnly, onUpdate, onRemove }: {
  idx: number; line: OutputLine; sourceUnit: string; readOnly: boolean;
  onUpdate: (patch: Partial<OutputLine>) => void; onRemove: () => void;
}) {
  return (
    <div className="grid grid-cols-12 gap-2 items-start">
      <select value={line.waste_category} disabled={readOnly}
              onChange={e => onUpdate({ waste_category: e.target.value })}
              className="col-span-6 px-2 py-1.5 border border-[#D4B896] rounded text-xs">
        {WASTE_CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
      </select>
      {/* waste is written to wastages against the SOURCE material → source unit */}
      <div className="col-span-2 flex items-center gap-1">
        <input type="number" step="any" min="0" value={line.weight} readOnly={readOnly}
               onChange={e => onUpdate({ weight: e.target.value })}
               className="w-full min-w-0 px-2 py-1.5 border border-[#D4B896] rounded text-xs text-right font-mono" />
        <span className="text-[10px] text-[#8B7355] shrink-0">{sourceUnit}</span>
      </div>
      <input value={line.notes} readOnly={readOnly}
             onChange={e => onUpdate({ notes: e.target.value })}
             className="col-span-3 px-2 py-1.5 border border-[#D4B896] rounded text-xs" />
      <div className="col-span-1 text-right">
        {!readOnly && <button onClick={onRemove} className="text-red-600 hover:text-red-700"><Trash2 size={12} /></button>}
      </div>
    </div>
  );
}

/* ──────────────── Yield Report Panel ──────────────── */

function YieldReportPanel() {
  const [from, setFrom] = useState(() => new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10));
  const [to, setTo]     = useState(today());
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    setLoading(true); setErr(null);
    try {
      const r = await fetch(`/api/butchering/yield-report?from=${from}&to=${to}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !Array.isArray(d.sources)) {
        setErr(d.error || `Failed to load report (HTTP ${r.status})`);
        setData(null);
        return;
      }
      setData(d);
    } catch (e: any) {
      setErr(e?.message || 'Failed to load report');
      setData(null);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-[#E8D5C4] bg-amber-50/40 flex items-center gap-3">
        <BarChart3 size={16} className="text-amber-700" />
        <div className="flex-1 text-xs text-[#6B5744]">
          Avg yield % per cut vs. AKAN standard. Red = consistent shortfall (investigate butcher / vendor).
        </div>
        <input type="date" value={from} onChange={e => setFrom(e.target.value)}
               className="text-xs px-2 py-1 border border-[#D4B896] rounded" />
        <input type="date" value={to} onChange={e => setTo(e.target.value)}
               className="text-xs px-2 py-1 border border-[#D4B896] rounded" />
        <button onClick={load} className="text-xs px-3 py-1 bg-[#af4408] text-white rounded">Run</button>
      </div>

      {err ? (
        <div className="p-6 text-center text-sm text-red-700">{err}</div>
      ) : loading || !data ? (
        <div className="p-6 text-center text-sm text-[#8B7355]"><Loader2 className="animate-spin inline mr-1" size={14} />Loading…</div>
      ) : data.sources.length === 0 ? (
        <div className="p-6 text-center text-sm text-[#8B7355]">No closed batches in this period — only <strong>closed</strong> batches enter the yield report.</div>
      ) : (
        <div className="divide-y divide-[#E8D5C4]">
          {data.sources.map((src: any) => (
            <div key={src.source_material_id} className="p-4 space-y-2">
              <div className="flex items-baseline gap-3 flex-wrap">
                <h3 className="text-sm font-semibold text-[#2D1B0E]">{src.source_material_name}</h3>
                <span className="text-xs text-[#8B7355]">
                  {src.batch_count} batches · {fmtWt(src.total_gross_weight, src.source_material_unit)} gross · {fmt(src.total_cost)}
                </span>
                <span className={`text-xs ml-auto px-2 py-0.5 rounded ${src.waste.status === 'high' ? 'bg-red-100 text-red-700 font-semibold' : 'bg-emerald-100 text-emerald-700'}`}>
                  Waste: {src.waste.total_pct.toFixed(1)}% (target ≤ {src.waste.target_max_pct}%)
                </span>
              </div>
              <div className="overflow-x-auto">
              <table className="w-full text-xs min-w-[480px]">
                <thead className="text-[#8B7355]">
                  <tr>
                    <th className="text-left  py-1 font-medium">Cut</th>
                    <th className="text-right py-1 font-medium">Total Wt</th>
                    <th className="text-right py-1 font-medium">Avg Yield</th>
                    <th className="text-right py-1 font-medium">Std Range</th>
                    <th className="text-left  py-1 font-medium pl-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {src.cuts.map((c: any) => {
                    // yield_pct is stored NORMALIZED (source-unit basis) by the
                    // save route — display verbatim. The dash stays for
                    // non-convertible pairs, where no ratio is meaningful.
                    const yf = wtFactor(c.material_unit, src.source_material_unit);
                    return (
                    <tr key={c.material_id} className="border-t border-[#E8D5C4]/50">
                      <td className="py-1 text-[#2D1B0E]">{c.material_name}</td>
                      <td className="py-1 text-right font-mono">{fmtWt(c.total_weight, c.material_unit)}</td>
                      <td className="py-1 text-right font-mono">
                        {yf == null
                          ? <span title={`Yield not comparable: cut is in ${c.material_unit || '?'}, source in ${src.source_material_unit || 'kg'}`}>—</span>
                          : `${Number(c.avg_yield_pct || 0).toFixed(1)}%`}
                      </td>
                      <td className="py-1 text-right font-mono text-[#8B7355]">
                        {c.std_yield_min != null ? `${c.std_yield_min}–${c.std_yield_max}%` : '—'}
                      </td>
                      <td className="py-1 pl-3">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                          c.status === 'ok'   ? 'bg-emerald-100 text-emerald-700' :
                          c.status === 'low'  ? 'bg-red-100 text-red-700 font-semibold' :
                          c.status === 'high' ? 'bg-amber-100 text-amber-700' :
                                                'bg-gray-100 text-gray-600'
                        }`}>{c.status === 'unknown' ? 'no std' : c.status}</span>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ──────────────── Reusable bits ──────────────── */

function ModalShell({ title, subtitle, onClose, children }: {
  title: string; subtitle?: string; onClose: () => void; children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 backdrop-blur-sm p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white border border-[#E8D5C4] rounded-xl w-full max-w-4xl my-4 flex flex-col max-h-[calc(100vh-2rem)]" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8D5C4] shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-[#2D1B0E] flex items-center gap-2"><Scissors size={18} className="text-[#af4408]" />{title}</h2>
            {subtitle && <div className="text-xs text-[#8B7355] mt-0.5">{subtitle}</div>}
          </div>
          <button onClick={onClose} className="text-[#8B7355] hover:text-[#2D1B0E]"><X size={20} /></button>
        </div>
        <div className="px-6 py-4 overflow-y-auto flex-1">{children}</div>
      </div>
    </div>
  );
}
function ModalFooter({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="flex justify-end gap-2 px-6 py-3 border-t border-[#E8D5C4] shrink-0 -mx-6 -mb-4 mt-4 bg-white">
      <button onClick={onClose} className="px-4 py-2 text-sm text-[#6B5744] hover:bg-[#FFF1E3] rounded">Cancel</button>
      {children}
    </div>
  );
}
function Field({ label, hint, className, children }: { label: string; hint?: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={className}>
      <label className="block text-xs font-medium text-[#6B5744] mb-1">{label}</label>
      {children}
      {hint && <div className="text-[10px] text-[#8B7355] mt-0.5 italic">{hint}</div>}
    </div>
  );
}
