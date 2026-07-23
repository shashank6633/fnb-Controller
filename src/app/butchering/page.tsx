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
const fmtKg = (v: number) => (v || 0).toFixed(3) + ' kg';
const today = () => new Date().toISOString().slice(0, 10);

interface Material { id: string; name: string; sku?: string; unit?: string; average_price?: number; category?: string }
interface Batch {
  id: string; batch_id: string; source_material_id: string; source_material_name: string;
  gross_weight: number; invoice_weight?: number; cost_per_unit: number; total_cost: number;
  butcher: string; head_chef: string; status: 'open' | 'closed' | 'cancelled';
  cut_count: number; total_cut_weight: number; total_waste_weight: number;
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
                      <td className="py-1.5 px-3 text-right font-mono">{fmtKg(b.gross_weight)}</td>
                      <td className="py-1.5 px-3 text-right font-mono">{b.cut_count} ({fmtKg(b.total_cut_weight)})</td>
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

function NewBatchModal({ materials, onSeeded, onClose, onCreated }: {
  materials: Material[];
  onSeeded: () => void;
  onClose: () => void;
  onCreated: (id: string) => void;
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
  const [showAllSources, setShowAllSources] = useState(false);   // escape hatch for a mis-categorised carcass

  // A butchering source is a whole protein/carcass — not the whole 1000-item
  // catalog. Match meat/protein categories OR a protein keyword in name/SKU.
  // The "Show all materials" checkbox is the fallback if a carcass isn't tagged.
  const MEAT_CATS = ['meat', 'mutton', 'chicken', 'poultry', 'seafood', 'fish', 'prawn', 'lamb', 'goat', 'non-veg', 'nonveg', 'non veg'];
  const isCarcassSource = (m: Material) => {
    const cat = String((m as any).category || '').toLowerCase().trim();
    if (MEAT_CATS.includes(cat)) return true;
    const hay = `${m.name || ''} ${m.sku || ''}`.toLowerCase();
    return /carcass|mutton|chicken|lamb|goat|poultry|seafood|prawn|\bmeat\b|\bfish\b/.test(hay);
  };
  const sourceMaterials = showAllSources ? materials : materials.filter(isCarcassSource);

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

  const submit = async () => {
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
      onCreated(j.batch.id);
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
        <Field label="Source carcass *" className="col-span-2">
          <select value={sourceId} onChange={e => { setSourceId(e.target.value); if (!batchId) setTimeout(suggestId, 0); }}
                  className="w-full px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3]">
            <option value="">— pick a carcass / meat item —</option>
            {sourceMaterials.map(m => (
              <option key={m.id} value={m.id}>
                {m.sku ? `[${m.sku}] ` : ''}{m.name} {m.unit ? `(${m.unit})` : ''}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 mt-1 text-[11px] text-[#8B7355]">
            <input type="checkbox" checked={showAllSources} onChange={e => setShowAllSources(e.target.checked)} />
            Show all materials {showAllSources ? '' : `(showing ${sourceMaterials.length} meat/carcass of ${materials.length})`}
          </label>
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
        <Field label="Gross dressed weight (kg) *">
          <input type="number" step="any" min="0" value={grossWeight} onChange={e => setGrossWeight(e.target.value)}
                 placeholder="14.250"
                 className="w-full px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] text-right font-mono" />
        </Field>
        <Field label="Invoice weight (kg)" hint="for variance check vs vendor">
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

      <ModalFooter onClose={onClose}>
        <button onClick={submit} disabled={saving}
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

  const totalCut = useMemo(() => outputs.filter(o => o.output_type === 'cut').reduce((a, o) => a + (Number(o.weight) || 0), 0), [outputs]);
  const totalWaste = useMemo(() => outputs.filter(o => o.output_type === 'waste').reduce((a, o) => a + (Number(o.weight) || 0), 0), [outputs]);
  const totalOut = totalCut + totalWaste;
  // Live basis: the recon strip, per-line yields and costs all follow the
  // EDITED gross weight so what you see is exactly what saving produces.
  const gross = Number(grossW) > 0 ? Number(grossW) : 0;
  const liveTotalCost = (batch?.cost_per_unit || 0) * gross;
  const gap = gross - totalOut;
  const gapPct = gross > 0 ? Math.abs(gap) / gross : 0;
  const wastePct = gross > 0 ? (totalWaste / gross) * 100 : 0;
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
    <ModalShell title={`Batch ${batch.batch_id}`} subtitle={`${batch.source_material_name} · ${fmtKg(batch.gross_weight)} gross · ${fmt(batch.total_cost)}`}
                onClose={onClose}>
      {readOnly && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded p-2 text-xs mb-3">
          {batch.status === 'closed' ? '✓ This batch is closed — inventory transactions posted.' : '✗ This batch was cancelled.'}
        </div>
      )}

      {/* Batch details — editable while open; every Save Draft persists them
          and re-bases yields/costs on the corrected gross weight. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
        <Field label="Gross weight (kg) *">
          <input type="number" step="any" min="0" value={grossW} readOnly={readOnly}
                 onChange={e => setGrossW(e.target.value)}
                 className={`w-full px-2 py-1.5 border border-[#D4B896] rounded text-xs text-right font-mono ${readOnly ? 'bg-[#F7F0E8] text-[#8B7355]' : 'bg-[#FFF1E3]'}`} />
        </Field>
        <Field label="Invoice weight (kg)">
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

      {/* Reconciliation strip */}
      <div className={`rounded-lg p-3 grid grid-cols-4 gap-3 text-xs border ${withinTolerance ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'}`}>
        <div><div className="text-[10px] uppercase text-[#8B7355]">Gross</div><div className="font-mono font-semibold">{fmtKg(gross)}</div></div>
        <div><div className="text-[10px] uppercase text-[#8B7355]">Total Cut</div><div className="font-mono font-semibold">{fmtKg(totalCut)}</div></div>
        <div><div className="text-[10px] uppercase text-[#8B7355]">Total Waste</div><div className={`font-mono font-semibold ${wastePct > 12 ? 'text-red-700' : ''}`}>{fmtKg(totalWaste)} ({wastePct.toFixed(1)}%)</div></div>
        <div><div className="text-[10px] uppercase text-[#8B7355]">Gap</div><div className={`font-mono font-semibold ${withinTolerance ? 'text-emerald-700' : 'text-amber-700'}`}>{fmtKg(gap)} ({(gapPct*100).toFixed(2)}%)</div></div>
      </div>

      {/* CUTS section */}
      <div className="mt-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-[#2D1B0E]">Cuts</h3>
          {!readOnly && (
            <button onClick={() => addLine('cut')} className="text-xs text-[#af4408] hover:underline"><Plus size={11} className="inline" /> Add cut</button>
          )}
        </div>
        <div className="grid grid-cols-12 gap-2 text-[10px] uppercase tracking-wide text-[#8B7355] px-1">
          <div className="col-span-6">Material</div>
          <div className="col-span-2 text-right">Weight (kg)</div>
          <div className="col-span-1 text-right">Yield %</div>
          <div className="col-span-2 text-right">Cost</div>
        </div>
        <div className="space-y-1 mt-1">
          {outputs.map((o, i) => o.output_type !== 'cut' ? null : (
            <CutLine key={i} idx={i} line={o} grossWeight={gross} totalCost={liveTotalCost} materials={materials}
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
          <div className="col-span-2 text-right">Weight (kg)</div>
          <div className="col-span-3">Notes</div>
        </div>
        <div className="space-y-1 mt-1">
          {outputs.map((o, i) => o.output_type !== 'waste' ? null : (
            <WasteLine key={i} idx={i} line={o} readOnly={readOnly}
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

function CutLine({ idx, line, grossWeight, totalCost, materials, totalCutWeight, readOnly, excludeIds, onUpdate, onRemove }: {
  idx: number; line: OutputLine; grossWeight: number; totalCost: number; materials: Material[]; totalCutWeight: number;
  readOnly: boolean; excludeIds: string[];
  onUpdate: (patch: Partial<OutputLine>) => void; onRemove: () => void;
}) {
  const weight = Number(line.weight) || 0;
  const yieldPct = grossWeight > 0 ? (weight / grossWeight) * 100 : 0;
  const cost = totalCutWeight > 0 ? totalCost * (weight / totalCutWeight) : 0;
  return (
    <div className="grid grid-cols-12 gap-2 items-start">
      <div className="col-span-6">
        {readOnly ? (
          <div className="px-2 py-1.5 text-xs font-medium">{materials.find(m => m.id === line.material_id)?.name || '—'}</div>
        ) : (
          <MaterialTypeahead materials={materials as any} value={line.material_id}
                             onPick={(id: string) => onUpdate({ material_id: id })}
                             excludeIds={excludeIds.filter(x => x !== line.material_id) as string[]} />
        )}
      </div>
      <input type="number" step="any" min="0" value={line.weight} readOnly={readOnly}
             onChange={e => onUpdate({ weight: e.target.value })}
             className="col-span-2 px-2 py-1.5 border border-[#D4B896] rounded text-xs text-right font-mono" />
      <div className="col-span-1 text-right text-xs font-mono py-2 text-[#6B5744]">{yieldPct.toFixed(1)}%</div>
      <div className="col-span-2 text-right text-xs font-mono py-2 text-[#6B5744]">{fmt(cost)}</div>
      <div className="col-span-1 text-right">
        {!readOnly && (
          <button onClick={onRemove} className="text-red-600 hover:text-red-700"><Trash2 size={12} /></button>
        )}
      </div>
    </div>
  );
}

function WasteLine({ idx, line, readOnly, onUpdate, onRemove }: {
  idx: number; line: OutputLine; readOnly: boolean;
  onUpdate: (patch: Partial<OutputLine>) => void; onRemove: () => void;
}) {
  return (
    <div className="grid grid-cols-12 gap-2 items-start">
      <select value={line.waste_category} disabled={readOnly}
              onChange={e => onUpdate({ waste_category: e.target.value })}
              className="col-span-6 px-2 py-1.5 border border-[#D4B896] rounded text-xs">
        {WASTE_CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
      </select>
      <input type="number" step="any" min="0" value={line.weight} readOnly={readOnly}
             onChange={e => onUpdate({ weight: e.target.value })}
             className="col-span-2 px-2 py-1.5 border border-[#D4B896] rounded text-xs text-right font-mono" />
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
                  {src.batch_count} batches · {fmtKg(src.total_gross_weight)} gross · {fmt(src.total_cost)}
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
                  {src.cuts.map((c: any) => (
                    <tr key={c.material_id} className="border-t border-[#E8D5C4]/50">
                      <td className="py-1 text-[#2D1B0E]">{c.material_name}</td>
                      <td className="py-1 text-right font-mono">{fmtKg(c.total_weight)}</td>
                      <td className="py-1 text-right font-mono">{c.avg_yield_pct.toFixed(1)}%</td>
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
                  ))}
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
