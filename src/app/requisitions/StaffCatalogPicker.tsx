'use client';

/**
 * StaffCatalogPicker — mobile-first catalog-and-cart requisition flow for
 * plain department staff (Recaho-POS-style: category rail + item cards + cart).
 *
 * Replaces CreateRequisitionModal for staff (non-admin / non-HOD / non-store /
 * non-manager) for BOTH new requisitions and draft editing. Privileged roles
 * keep the classic form.
 *
 * Data conventions (see project F&B Unit Convention):
 *   - current_stock is in RECIPE units → shown here in PURCHASE units (÷ pack_size)
 *   - average_price is ₹/recipe-unit → line/cart totals = qty × packFactor × average_price
 *   - quantities entered here are in the line's requested unit: new adds use the
 *     PURCHASE unit (same as the classic staff form, where onPick sets
 *     unit = purchase_unit || unit); draft lines keep their existing unit.
 *   - POST body identical to CreateRequisitionModal:
 *       {date, department_id, notes, items:[{material_id, quantity_requested, unit, notes}]}
 *     Edit mode PUTs {id, date, department_id, notes, items} (mirrors the
 *     modal's isEditing branch). "Submit to HOD" then POSTs
 *     /api/requisitions/<id>/submit.
 *
 * PARTY MODE (optional `party` prop; absent ⇒ everything below is inert and the
 * internal flow is unchanged). /party-requisitions renders this same picker so
 * there is ONE cart, one pack-factor guard and one save path. It additionally
 * shows the event header and merges {purpose:'party', event_*, customer,
 * guest_count} + the sheet-sync keys into the very same POST/PUT.
 *   - Party lines are stamped with the PURCHASE unit, exactly like internal
 *     ones. The old party composer stamped the RECIPE unit and pre-multiplied
 *     qty by pack_size; every reader resolves a line's own `unit` column, so
 *     legacy rows keep working while new rows are uniform across both flows.
 *   - Mixed mode (a department per LINE) is party-only: the header selector
 *     picks the dept the NEXT item is added under, the cart groups by dept, and
 *     department_id is omitted from the body so the server derives it.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Loader2, Lock, Minus, Plus, Search, Send, ShoppingCart, X } from 'lucide-react';
import { api } from '@/lib/api';
import { packFactor, toPurchaseQty } from '@/lib/pack-units';

interface Material {
  id: string; name: string; sku?: string; unit: string;
  current_stock: number; average_price: number;
  last_purchase_price?: number; last_purchase_date?: string;
  reorder_level?: number;
  purchase_unit?: string; pack_size?: number;
  category?: string;
}
interface Department { id: string; name: string; code?: string; }
/** Minimal /api/department-stock row — what the "With dept" line needs. */
export interface DeptStockLite { on_hand_est: number; never_counted: boolean; }
/** The dept-stock map + the department it was computed for (so a stale map
 *  is never shown against a different department). */
export interface DeptStockProp { deptId: string; byId: Map<string, DeptStockLite>; }
/** Minimal shape of a draft requisition being edited (subset of page.tsx's
 *  Requisition — structurally compatible, so the page can pass it straight in). */
interface DraftItem {
  material_id: string; quantity_requested: number; unit?: string;
  material_name: string; material_unit: string;
  material_purchase_unit?: string; material_pack_size?: number;
  current_stock: number; average_price: number; last_purchase_price?: number;
  /** Per-line department — only read in party mixed mode. */
  department_id?: string | null;
}
interface EditDraft {
  id: string; req_number: string; date: string;
  department_id: string; notes: string;
  items?: DraftItem[];
}

/** Event-header fields a party requisition carries beside the catalog. Kept as
 *  strings because they are text inputs; save() coerces guest_count. */
export interface PartyEvent {
  event_name: string; event_date: string; guest_count: string;
  customer: string; event_notes: string;
}
/** Presence of this prop switches the picker into party mode. */
export interface PartyMode {
  /** Seed values for the event header — the page decides whether they come
   *  from the draft being resumed or from the FP / sheet prefill. */
  initial?: Partial<PartyEvent>;
  /** Header fields are read-only: the AKAN sheet is the source of truth.
   *  Admins get the documented override, applied here from `me`. */
  sheetLocked?: boolean;
  /** Merged verbatim into the POST/PUT body — the server re-asserts sheet truth
   *  for non-admins from these keys. */
  sheet?: { from_sheet?: boolean; party_unique_id?: string; fp_id?: string };
  /** Rendered above the event header (FP banner / menu checklist). */
  banner?: ReactNode;
  /** Cart pre-seed. quantity is in the material's RECIPE unit (what
   *  fp-estimator emits); the picker converts it to the purchase basis it
   *  carts in via the shared toPurchaseQty. */
  seed?: { material_id: string; quantity: number }[];
}

/** Recipe-units per 1 of the unit a LINE was requested in — ×pack only when
 *  that unit is the material's purchase unit (createTotal / reqPackFactor).
 *  Compares are normalised (lowercase/trim) like the shared packFactor. */
function lineFactor(m: Material, unit: string): number {
  const lu = String(unit || '').toLowerCase().trim();
  const pu = String(m.purchase_unit || '').toLowerCase().trim();
  const ru = String(m.unit || '').toLowerCase().trim();
  return (lu !== '' && pu !== '' && lu === pu && lu !== ru) ? packFactor(m) : 1;
}
/**
 * ₹ per PURCHASE unit.
 *
 * THE FIELD NAME IS A TRAP, so read this before touching it. `m.last_purchase_price`
 * here is NOT raw_materials.last_purchase_price — that column is stored in MIXED
 * bases and may never be valued from. Both pages that mount this picker fill
 * `materials` from GET /api/inventory, whose SELECT is
 *   `SELECT rm.*, COALESCE((SELECT unit_price FROM purchases WHERE material_id = rm.id
 *      ORDER BY date DESC, created_at DESC LIMIT 1), 0) as last_purchase_price`
 * (src/app/api/inventory/route.ts:39-40). The alias is projected AFTER `rm.*`, so it
 * overwrites the raw column in the row object better-sqlite3 hands back — verified on
 * a copy of the live db: CURD raw column 86 → resolved 80; MALA STRAWBERRY CRUSH 5 LTR
 * raw 0.13482 → resolved 674.10. What arrives here is purchases.unit_price, which is
 * ₹ per PURCHASE unit by canon. Draft-only "phantom" rows (matById below) inherit the
 * same field from GET /api/requisitions?id=, whose items SELECT aliases it over the
 * same `(SELECT unit_price FROM purchases … LIMIT 1)` (requisitions/route.ts:92).
 *
 * The two branches are exactly steps 1 and 2 of the sanctioned ladder in
 * src/lib/closing-valuation.ts (materialRate): latest purchases.unit_price, else
 * average_price (₹/recipe-unit) × packFactor. That library takes a db handle and
 * cannot run in this client component, so the ladder is mirrored — not re-invented:
 * the pack rule itself comes from the shared packFactor(), never hand-rolled here.
 */
function pricePerPU(m: Material): number {
  // rate-basis: purchase — an alias over purchases.unit_price (see above), ₹/purchase-unit
  const lastPaidPerPU = Number(m.last_purchase_price) || 0;
  // rate-basis: purchase — average_price is ₹/recipe-unit; × packFactor lifts it to ₹/PU
  return lastPaidPerPU > 0 ? lastPaidPerPU : (m.average_price || 0) * packFactor(m);
}
/** Ordering unit label. */
function pu(m: Material): string { return m.purchase_unit || m.unit || ''; }

const inr = (v: number, dp = 0) =>
  '₹' + (v || 0).toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });

export default function StaffCatalogPicker({ materials, me, departments, editDraft, deptStock, party, onClose, onCreated }: {
  materials: Material[];
  me: {
    role?: string; email?: string; department_id?: string | null;
    is_head_chef?: boolean; is_store_manager?: boolean;
  } | null;
  departments: Department[];
  /** When set, the picker edits this draft (PUT) instead of creating (POST). */
  editDraft?: EditDraft | null;
  /** Department-stock rows pre-fetched by the page for the requisition's
   *  department. The picker refetches itself if its dept differs (privileged
   *  users can switch departments in the header). */
  deptStock?: DeptStockProp | null;
  /** Present ⇒ party mode (see the party-mode note in the file header).
   *  Absent ⇒ the internal flow, entirely unchanged. */
  party?: PartyMode | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const isEditing = !!editDraft;
  const isParty = !!party;
  const today = new Date().toISOString().slice(0, 10);
  const date = editDraft?.date || today;
  // Same privilege condition as CreateRequisitionModal.canChangeDept —
  // admin / head chef / store manager / manager may raise for any department;
  // everyone else is locked to their home department (server enforces too).
  const canChangeDept = me?.role === 'admin'
    || !!me?.is_head_chef
    || !!me?.is_store_manager
    || me?.role === 'manager';
  // Edit mode keeps the draft's own department; privileged users default to
  // their home department (or the first active one) but can switch below.
  const [deptId, setDeptId] = useState(
    editDraft?.department_id || me?.department_id || (canChangeDept ? departments[0]?.id || '' : ''));
  // Safety net: if `me` resolves after mount, adopt the home department —
  // never overriding a choice already made (mirrors the old modal).
  useEffect(() => {
    if (isEditing) return;
    if (me?.department_id) setDeptId(cur => cur || me.department_id!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.department_id]);
  const dept = departments.find(d => d.id === deptId);

  // Department's OWN computed stock (/api/department-stock) — shown per item
  // instead of the central-store figure. Seeded from the page's pre-fetch;
  // refetched here only when the picker's dept differs from the pre-fetch's.
  const [ds, setDs] = useState<DeptStockProp>({ deptId: deptStock?.deptId || '', byId: deptStock?.byId || new Map() });
  useEffect(() => {
    if (!deptId) { setDs({ deptId: '', byId: new Map() }); return; }
    if (deptStock && deptStock.deptId === deptId) { setDs(deptStock); return; }
    let live = true;
    fetch(`/api/department-stock?department_id=${encodeURIComponent(deptId)}`)
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (!live) return;
        const byId = new Map<string, DeptStockLite>(
          ((j?.rows || []) as any[]).map(r => [r.material_id, { on_hand_est: r.on_hand_est, never_counted: !!r.never_counted }]));
        setDs({ deptId, byId });
      })
      .catch(() => { if (live) setDs({ deptId, byId: new Map() }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deptId, deptStock]);

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');
  /** material_id → qty, in the unit recorded in unitById. */
  const [cart, setCart] = useState<Record<string, number>>(() =>
    Object.fromEntries((editDraft?.items || [])
      .filter(it => it.material_id && it.quantity_requested > 0)
      .map(it => [it.material_id, it.quantity_requested])));
  /** material_id → unit the line is requested in. Draft lines keep their saved
   *  unit (may be the recipe unit on legacy rows); new adds use purchase unit. */
  const [unitById, setUnitById] = useState<Record<string, string>>(() =>
    Object.fromEntries((editDraft?.items || [])
      .filter(it => it.material_id)
      .map(it => [it.material_id, it.unit || it.material_unit])));
  const [cartOpen, setCartOpen] = useState(false);
  const [notes, setNotes] = useState(editDraft?.notes || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* ── Party mode ───────────────────────────────────────────────────────────
   * All of the following is inert when `party` is absent. */
  const [evName,     setEvName]     = useState(party?.initial?.event_name  || '');
  const [evDate,     setEvDate]     = useState(party?.initial?.event_date  || today);
  const [evGuests,   setEvGuests]   = useState(party?.initial?.guest_count || '');
  const [evCustomer, setEvCustomer] = useState(party?.initial?.customer    || '');
  const [evNotes,    setEvNotes]    = useState(party?.initial?.event_notes || '');
  // Sheet-locked fields are read-only; admin keeps the documented override.
  const evLocked = !!party?.sheetLocked && me?.role !== 'admin';
  // Collapsed once the event is fully identified — the sheet already filled it
  // in and the catalog needs the vertical space on a phone. Stays open when a
  // banner is present: the FP menu checklist is what you shop the catalog from.
  const [evOpen, setEvOpen] = useState(() =>
    !!party?.banner || !(party?.initial?.event_name && party?.initial?.event_date));

  /** Per-LINE department, stamped when the item is added. Only consulted in
   *  party mixed mode; seeded from the draft so resuming never flattens the
   *  per-line depts back onto one department. */
  const [deptById, setDeptById] = useState<Record<string, string>>(() =>
    Object.fromEntries((editDraft?.items || [])
      .filter(it => it.material_id && it.department_id)
      .map(it => [it.material_id, String(it.department_id)])));
  // A resumed draft whose lines span >1 department must reopen in mixed mode,
  // otherwise saving would re-stamp every line onto the header department.
  const [mixedMode, setMixedMode] = useState(() =>
    new Set((editDraft?.items || []).map(it => it.department_id).filter(Boolean)).size > 1);

  /** In-progress text for the party qty field, so clearing it mid-edit doesn't
   *  drop the line (setQty(0) removes it). Dropped on blur. */
  const [qtyText, setQtyText] = useState<Record<string, string>>({});

  // FP seed. Applied via an effect rather than in the cart initialiser because
  // the page may mount the picker before /api/inventory resolves, and the seed
  // needs each material's pack meta to convert recipe → purchase units.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || isEditing) return;
    const seed = party?.seed;
    if (!seed?.length || materials.length === 0) return;
    seeded.current = true;
    const byId = new Map(materials.map(m => [m.id, m]));
    const qtys: Record<string, number> = {};
    const units: Record<string, string> = {};
    for (const s of seed) {
      const m = byId.get(s.material_id);
      const q = m ? toPurchaseQty(Number(s.quantity) || 0, m) : 0;
      if (!m || q <= 0) continue;
      qtys[m.id] = q;
      units[m.id] = pu(m);
    }
    if (Object.keys(qtys).length === 0) return;
    setCart(prev => ({ ...qtys, ...prev }));
    setUnitById(prev => ({ ...units, ...prev }));
    // Stamp the header dept so seeded lines aren't orphaned if mixed mode is
    // switched on later; the per-line selector can still re-point them.
    const depts = Object.fromEntries(Object.keys(qtys).map(id => [id, deptId]));
    setDeptById(prev => ({ ...depts, ...prev }));
  }, [materials, party?.seed, isEditing, deptId]);

  // Phantom materials for draft lines whose material is no longer in the
  // staff's catalog (deleted / re-scoped) — keeps the line visible in the cart
  // labeled from the draft's own data.
  const matById = useMemo(() => {
    const map = new Map<string, Material>(materials.map(m => [m.id, m]));
    for (const it of editDraft?.items || []) {
      if (!it.material_id || map.has(it.material_id)) continue;
      map.set(it.material_id, {
        id: it.material_id,
        name: it.material_name || '(material removed)',
        unit: it.material_unit || '',
        purchase_unit: it.material_purchase_unit,
        pack_size: it.material_pack_size,
        current_stock: it.current_stock || 0,
        average_price: it.average_price || 0,
        last_purchase_price: it.last_purchase_price,
      });
    }
    return map;
  }, [materials, editDraft]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const m of materials) if (m.category) set.add(m.category);
    return ['All', ...Array.from(set).sort((a, b) => a.localeCompare(b))];
  }, [materials]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return materials.filter(m => {
      if (category !== 'All' && (m.category || '') !== category) return false;
      if (!q) return true;
      // Brand + category alongside name and SKU: "Search Bar should support
      // Brand Name, SKU, and Material Code". SKU is the material code here
      // (MAT-00885). brand is unpopulated on all 928 materials today, so it
      // matches nothing until it is filled in — wired, not yet useful.
      return m.name.toLowerCase().includes(q)
        || (m.sku || '').toLowerCase().includes(q)
        || ((m as any).brand || '').toLowerCase().includes(q)
        || ((m as any).category || '').toLowerCase().includes(q);
    });
  }, [materials, category, search]);

  const unitOf = (m: Material) => unitById[m.id] || pu(m);

  const cartLines = useMemo(() =>
    Object.entries(cart)
      .filter(([, qty]) => qty > 0)
      .map(([id, qty]) => ({ m: matById.get(id)!, qty }))
      .filter(l => !!l.m),
    [cart, matById]);

  const cartCount = cartLines.length;
  // Cart total = Σ qty × line pack-factor × avg ₹/recipe-unit (same as createTotal).
  const lineValue = (m: Material, qty: number) => qty * lineFactor(m, unitOf(m)) * (m.average_price || 0);
  const cartTotal = cartLines.reduce((s, l) => s + lineValue(l.m, l.qty), 0);

  /** Mixed mode renders the cart grouped by department with each group labelled;
   *  every other mode is a single unlabelled group. */
  const cartGroups = useMemo(() => {
    if (!(isParty && mixedMode)) return [{ id: '', name: '', lines: cartLines }];
    const byDept = new Map<string, typeof cartLines>();
    for (const l of cartLines) {
      const id = deptById[l.m.id] || '';
      if (!byDept.has(id)) byDept.set(id, []);
      byDept.get(id)!.push(l);
    }
    return Array.from(byDept, ([id, lines]) => ({
      id,
      name: departments.find(d => d.id === id)?.name || 'No department',
      lines,
    }));
  }, [cartLines, isParty, mixedMode, deptById, departments]);

  const setQty = (m: Material, qty: number) => {
    setCart(prev => {
      const n = { ...prev };
      if (qty <= 0) delete n[m.id]; else n[m.id] = qty;
      return n;
    });
    setUnitById(prev => {
      if (qty <= 0) { const n = { ...prev }; delete n[m.id]; return n; }
      return prev[m.id] ? prev : { ...prev, [m.id]: pu(m) };
    });
    // Party only: the header selector decides which dept a NEW line belongs to.
    if (!isParty) return;
    setDeptById(prev => {
      if (qty <= 0) { const n = { ...prev }; delete n[m.id]; return n; }
      return prev[m.id] ? prev : { ...prev, [m.id]: deptId };
    });
  };

  // Same POST/PUT + submit flow as CreateRequisitionModal.save().
  const save = async (submitAfter: boolean) => {
    // Party header first — same order and wording as the modal this replaces.
    if (isParty) {
      if (!evName.trim()) { setError('Event Host Name required'); return; }
      if (!evDate)        { setError('Event date required'); return; }
    }
    // Mixed mode has no header department: every line carries its own.
    if (!deptId && !(isParty && mixedMode)) {
      setError(canChangeDept
        ? 'Pick a department.'
        : 'Your user has no home department set. Ask an admin to assign one on /users.');
      return;
    }
    if (cartLines.length === 0) { setError('Add at least one item.'); return; }
    if (isParty) {
      // A line whose unit is no longer one of the material's registered units
      // (legacy row, or the material was re-configured since) would be costed
      // on the wrong basis. Same guard the party modal ran per line.
      for (const l of cartLines) {
        const u = unitOf(l.m).trim();
        const allowed = [pu(l.m), l.m.unit].map(s => String(s || '').trim()).filter(Boolean);
        if (allowed.length > 0 && u && !allowed.includes(u)) {
          setError(`${l.m.name}: unit "${u}" is not registered for this material. Allowed: ${allowed.join(', ')}.`);
          return;
        }
      }
      if (mixedMode) {
        const orphan = cartLines.find(l => !deptById[l.m.id]);
        if (orphan) { setError(`Pick a department for ${orphan.m.name}.`); return; }
      }
    }
    setSaving(true); setError(null);
    try {
      const items = cartLines.map(l => ({
        material_id: l.m.id,
        quantity_requested: l.qty,
        unit: unitOf(l.m),
        notes: '',
        // Party sends an explicit per-line dept so changing the header dept on a
        // draft edit re-stamps the lines — PUT otherwise falls back to the PRIOR
        // line's dept. Internal omits the key exactly as before.
        ...(isParty ? { department_id: mixedMode ? deptById[l.m.id] : deptId } : null),
      }));
      const base = isEditing
        ? { id: editDraft!.id, date, department_id: deptId, notes, items }
        : { date, department_id: deptId, notes, items };
      const body = isParty
        ? {
            ...base,
            purpose: 'party',
            event_name:  evName.trim(),
            event_date:  evDate,
            guest_count: Number(evGuests) || null,
            customer:    evCustomer.trim(),
            event_notes: evNotes.trim(),
            // undefined is dropped by JSON.stringify, so in mixed mode the
            // server derives the req-level dept from the first line.
            department_id: mixedMode ? undefined : deptId,
            from_sheet:      !!party!.sheet?.from_sheet,
            party_unique_id: party!.sheet?.party_unique_id,
            fp_id:           party!.sheet?.fp_id,
          }
        : base;
      const r = await api('/api/requisitions', { method: isEditing ? 'PUT' : 'POST', body });
      if (!r.ok) { setError((await r.json().catch(() => ({}))).error || 'Failed to save requisition'); return; }
      if (submitAfter) {
        const j = await r.json().catch(() => ({}));
        const targetId = isEditing ? editDraft!.id : j?.requisition?.id;
        if (targetId) {
          const s = await api(`/api/requisitions/${targetId}/submit`, { method: 'POST', body: {} });
          if (!s.ok) {
            const sj = await s.json().catch(() => ({}));
            alert('Saved as draft, but submit to HOD failed: ' + (sj.error || 'unknown') +
                  '\nYou can submit it from the requisition’s detail view.');
          }
        } else {
          alert('Saved as draft. Open it to submit to HOD.');
        }
      }
      onCreated(); onClose();
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-white flex flex-col overflow-hidden">
      {/* ── Header ─────────────────────────────────────────── */}
      <div className="shrink-0 px-3 pt-3 pb-2 border-b border-[#E8D5C4] bg-[#FFF8F0]">
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="min-w-0 flex-1">
            {/* Party keeps the dept selector while editing — the old party modal
                allowed re-pointing a draft at another department. */}
            {isEditing && !isParty ? (
              <div className="text-sm font-bold text-[#2D1B0E] truncate">
                {`Edit Draft ${editDraft!.req_number}`}
              </div>
            ) : canChangeDept ? (
              // Privileged users (admin / HOD / store manager / manager) may
              // raise for any department — same options as the old modal.
              <select value={deptId} onChange={e => setDeptId(e.target.value)}
                      className="w-full max-w-xs px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-white text-sm font-semibold text-[#2D1B0E]">
                <option value="">Select department…</option>
                {departments.map(d => (
                  <option key={d.id} value={d.id}>{d.code ? `[${d.code}] ` : ''}{d.name}</option>
                ))}
              </select>
            ) : (
              // Staff: locked read-only home-department display.
              <div className="text-sm font-bold text-[#2D1B0E] truncate">
                {dept ? `${dept.code ? `[${dept.code}] ` : ''}${dept.name}` : 'New Requisition'}
              </div>
            )}
            <div className="text-[11px] text-[#8B7355] mt-0.5">
              {isEditing && isParty ? `${editDraft!.req_number} · ` : ''}
              {isEditing && dept && !isParty ? `${dept.name} · ` : ''}{date}
            </div>
            {isParty && canChangeDept && (
              <label className="mt-1 flex items-center gap-1.5 text-[11px] text-[#6B5744] cursor-pointer">
                <input type="checkbox" checked={mixedMode} onChange={e => setMixedMode(e.target.checked)} />
                Multiple departments
                {mixedMode && (
                  <span className="text-[10px] text-[#8B7355] italic truncate">
                    — adding to {dept?.name || 'select above'}
                  </span>
                )}
              </label>
            )}
          </div>
          <button onClick={onClose} aria-label="Close" className="shrink-0 p-2 text-[#8B7355]">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="relative">
          <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8B7355]" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by Item Name"
            className="w-full pl-8 pr-3 py-2 border border-[#E8D5C4] rounded-lg bg-white text-sm"
          />
        </div>
      </div>

      {/* ── Party: event header (collapsible so the catalog keeps the phone
             screen once the event is identified) ─────────────── */}
      {isParty && (
        <div className="shrink-0 border-b border-[#E8D5C4] bg-white">
          <button onClick={() => setEvOpen(o => !o)} aria-expanded={evOpen}
                  className="w-full px-3 py-2 flex items-center justify-between gap-2 text-left">
            <div className="min-w-0">
              <div className="text-[10px] font-bold uppercase tracking-wide text-[#af4408] flex items-center gap-1">
                Event {evLocked && <Lock className="w-3 h-3" />}
              </div>
              <div className="text-xs text-[#2D1B0E] truncate">
                {evName || <span className="text-red-500">Event host name required</span>}
                {evDate ? ` · ${evDate}` : ''}
                {Number(evGuests) > 0 ? ` · ${evGuests} pax` : ''}
              </div>
            </div>
            <span className="shrink-0 text-[11px] font-semibold text-[#af4408]">{evOpen ? 'HIDE' : 'SHOW'}</span>
          </button>

          {evOpen && (
            <div className="px-3 pb-3 space-y-2 max-h-[45vh] overflow-y-auto">
              {party!.banner}
              {evLocked && (
                <div className="bg-blue-50/60 border border-blue-200 rounded-lg p-2 text-[11px] text-blue-900 flex items-start gap-2">
                  <Lock className="w-3 h-3 mt-0.5 shrink-0" />
                  <div>
                    <strong>Host name, date, guest count and company are locked</strong> — they come from the
                    AKAN Party Manager sheet. Edit the sheet row and click Refresh on Party Events.
                    (Admin can override.)
                  </div>
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                <label className="block text-[11px] text-[#6B5744]">
                  Event Host Name *
                  <input value={evName} onChange={e => setEvName(e.target.value)} readOnly={evLocked}
                         placeholder="e.g. Mr. Sharma"
                         className={`mt-0.5 w-full px-2 py-1.5 border rounded-lg text-sm ${evLocked ? 'border-blue-200 bg-blue-50/40 cursor-not-allowed' : 'border-[#E8D5C4] bg-[#FFF8F0]'}`} />
                </label>
                <label className="block text-[11px] text-[#6B5744]">
                  Event Date *
                  <input type="date" value={evDate} onChange={e => setEvDate(e.target.value)} readOnly={evLocked}
                         className={`mt-0.5 w-full px-2 py-1.5 border rounded-lg text-sm ${evLocked ? 'border-blue-200 bg-blue-50/40 cursor-not-allowed' : 'border-[#E8D5C4] bg-[#FFF8F0]'}`} />
                </label>
                <label className="block text-[11px] text-[#6B5744]">
                  Guest Count
                  <input type="number" min={0} value={evGuests} onChange={e => setEvGuests(e.target.value)}
                         readOnly={evLocked} placeholder="e.g. 80"
                         className={`mt-0.5 w-full px-2 py-1.5 border rounded-lg text-sm font-mono ${evLocked ? 'border-blue-200 bg-blue-50/40 cursor-not-allowed' : 'border-[#E8D5C4] bg-[#FFF8F0]'}`} />
                </label>
                <label className="block text-[11px] text-[#6B5744]">
                  Company Name
                  <input value={evCustomer} onChange={e => setEvCustomer(e.target.value)} readOnly={evLocked}
                         placeholder="e.g. IBM India Pvt Ltd"
                         className={`mt-0.5 w-full px-2 py-1.5 border rounded-lg text-sm ${evLocked ? 'border-blue-200 bg-blue-50/40 cursor-not-allowed' : 'border-[#E8D5C4] bg-[#FFF8F0]'}`} />
                </label>
              </div>
              <label className="block text-[11px] text-[#6B5744]">
                Event Notes
                <input value={evNotes} onChange={e => setEvNotes(e.target.value)}
                       placeholder="Menu, special requests…"
                       className="mt-0.5 w-full px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
              </label>
            </div>
          )}
        </div>
      )}

      {/* ── Body: category rail + item list ─────────────────── */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Left category rail */}
        <div className="w-28 shrink-0 overflow-y-auto bg-[#F5F5F5] border-r border-[#E8D5C4] p-1.5 space-y-1.5">
          {categories.map(c => (
            <button key={c} onClick={() => setCategory(c)}
                    className={`w-full px-2 py-2.5 rounded-lg text-[11px] font-semibold leading-tight text-center break-words ${
                      category === c
                        ? 'bg-blue-500 text-white shadow'
                        : 'bg-white text-[#2D1B0E] border border-[#E8D5C4]'
                    }`}>
              {c}
            </button>
          ))}
        </div>

        {/* Right item list */}
        <div className="flex-1 min-w-0 overflow-y-auto bg-[#FAFAFA] p-2 space-y-2 pb-4">
          {materials.length === 0 ? (
            <div className="p-8 text-center text-sm text-[#8B7355]">
              <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
              No materials available for your department yet.
            </div>
          ) : visible.length === 0 ? (
            <div className="p-8 text-center text-sm text-[#8B7355]">
              No items match{search ? ` “${search}”` : ''}{category !== 'All' ? ` in ${category}` : ''}.
            </div>
          ) : visible.map(m => {
            const qty = cart[m.id] || 0;
            // The DEPARTMENT's own computed balance (recipe units → purchase
            // units, same ÷ pack convention as the old central-store line).
            const dr = ds.byId.get(m.id);
            const inPUq = (v: number) => (v / packFactor(m)).toLocaleString('en-IN', { maximumFractionDigits: 1 });
            return (
              <div key={m.id} className="bg-white rounded-lg border border-[#E8D5C4] p-3 flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-bold text-[#2D1B0E] uppercase leading-snug break-words">{m.name}</div>
                  {dr && !dr.never_counted && dr.on_hand_est > 0 ? (
                    <div className="text-[11px] text-emerald-600 font-medium mt-0.5">
                      With dept : {inPUq(dr.on_hand_est)} / {pu(m)}
                    </div>
                  ) : (
                    <div className="text-[11px] text-red-500 font-medium mt-0.5">With dept : – / –</div>
                  )}
                  {dr?.never_counted && (
                    // Not counted yet — receipts over the last 30 days only,
                    // informational (NOT a balance).
                    <div className="text-[11px] text-sky-600 font-medium mt-0.5">
                      Recd 30d : {inPUq(dr.on_hand_est)} / {pu(m)}
                    </div>
                  )}
                  <div className="text-[11px] text-[#6B5744] mt-0.5">
                    {inr(pricePerPU(m), 2)} / {pu(m)}
                  </div>
                </div>
                {qty > 0 ? (
                  <div className="shrink-0 flex items-center gap-1 bg-blue-50 border border-blue-200 rounded-lg">
                    <button onClick={() => setQty(m, qty - 1)} aria-label={`Decrease ${m.name}`}
                            className="px-2.5 py-2 text-blue-700"><Minus className="w-4 h-4" /></button>
                    {/* TYPEABLE, not a read-only count. This is the control the owner
                        was looking at when he reported req 68: a +/- stepper cannot
                        express 0.2 kg, and the span it replaces could not be edited at
                        all. Mirrors the cart row below — same qtyText buffer, so a
                        half-typed "0." survives the keystroke instead of being parsed
                        to 0 and deleting the line. */}
                    <input type="number" step="any" min={0}
                           aria-label={`Quantity for ${m.name}`}
                           value={qtyText[m.id] ?? String(qty)}
                           onChange={e => {
                             const v = e.target.value;
                             setQtyText(p => ({ ...p, [m.id]: v }));
                             const n = Number(v);
                             if (v.trim() !== '' && Number.isFinite(n) && n > 0) setQty(m, n);
                           }}
                           onBlur={() => setQtyText(p => { const n = { ...p }; delete n[m.id]; return n; })}
                           className="w-16 text-center text-sm font-bold text-[#2D1B0E] tabular-nums bg-transparent border-0 focus:outline-none" />
                    <button onClick={() => setQty(m, qty + 1)} aria-label={`Increase ${m.name}`}
                            className="px-2.5 py-2 text-blue-700"><Plus className="w-4 h-4" /></button>
                  </div>
                ) : (
                  <button onClick={() => setQty(m, 1)}
                          className="shrink-0 bg-gray-200 hover:bg-gray-300 rounded font-bold px-4 py-2 text-sm text-[#2D1B0E]">
                    ADD
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Sticky bottom bar ────────────────────────────────── */}
      <div className="shrink-0 border-t border-[#E8D5C4] bg-white p-2 flex gap-2" style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}>
        <button onClick={onClose}
                className="shrink-0 px-4 py-3 bg-red-500 hover:bg-red-600 text-white rounded-lg text-sm font-bold">
          BACK
        </button>
        <button onClick={() => cartCount > 0 && setCartOpen(true)}
                disabled={cartCount === 0}
                className="flex-1 min-w-0 px-3 py-3 bg-blue-500 hover:bg-blue-600 disabled:opacity-50 text-white rounded-lg text-sm font-bold flex items-center justify-center gap-2">
          <ShoppingCart className="w-4 h-4 shrink-0" />
          <span className="truncate">CART {cartCount} ITEM{cartCount === 1 ? '' : 'S'} · TOTAL {inr(cartTotal)}</span>
        </button>
      </div>

      {/* ── Cart sheet (slide-up) ────────────────────────────── */}
      {cartOpen && (
        <div className="absolute inset-0 z-10 bg-black/40 flex flex-col justify-end" onClick={() => !saving && setCartOpen(false)}>
          <div className="bg-white rounded-t-2xl max-h-[85%] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="shrink-0 px-4 py-3 border-b border-[#E8D5C4] flex items-center justify-between">
              <div className="text-sm font-bold text-[#2D1B0E] flex items-center gap-2">
                <ShoppingCart className="w-4 h-4" /> Cart · {cartCount} item{cartCount === 1 ? '' : 's'}
              </div>
              <button onClick={() => !saving && setCartOpen(false)} aria-label="Close cart" className="p-1 text-[#8B7355]">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-2">
              {cartLines.length === 0 ? (
                <div className="py-6 text-center text-sm text-[#8B7355]">Cart is empty.</div>
              ) : cartGroups.map(g => (
                <div key={g.id || 'all'} className="space-y-2">
                  {isParty && mixedMode && (
                    <div className={`text-[10px] font-bold uppercase tracking-wide pt-1 ${g.id ? 'text-[#af4408]' : 'text-red-600'}`}>
                      {g.name}
                    </div>
                  )}
                  {g.lines.map(({ m, qty }) => (
                    <div key={m.id} className="flex items-center gap-2 border border-[#E8D5C4] rounded-lg p-2">
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-semibold text-[#2D1B0E] break-words">{m.name}</div>
                        <div className="text-[10px] text-[#8B7355]">
                          {qty} {unitOf(m)} · {inr(lineValue(m, qty))}
                        </div>
                        {isParty && mixedMode && (
                          // Mixed mode: the line's dept is editable here, so a
                          // line added under the wrong header dept (or seeded
                          // from an FP) can be re-pointed without re-adding it.
                          <select value={deptById[m.id] || ''} disabled={saving}
                                  aria-label={`Department for ${m.name}`}
                                  onChange={e => setDeptById(p => ({ ...p, [m.id]: e.target.value }))}
                                  className={`mt-1 w-full px-1.5 py-1 border rounded text-[10px] ${
                                    deptById[m.id] ? 'border-[#E8D5C4] bg-white' : 'border-amber-400 bg-amber-50 text-amber-800'
                                  }`}>
                            <option value="">— pick dept —</option>
                            {departments.map(d => (
                              <option key={d.id} value={d.id}>{d.code ? `[${d.code}] ` : ''}{d.name}</option>
                            ))}
                          </select>
                        )}
                      </div>
                      <div className="shrink-0 flex items-center gap-1 bg-blue-50 border border-blue-200 rounded-lg">
                        <button onClick={() => setQty(m, qty - 1)} disabled={saving} aria-label={`Decrease ${m.name}`}
                                className="px-2 py-1.5 text-blue-700"><Minus className="w-3.5 h-3.5" /></button>
                        {(
                          // TYPEABLE FOR EVERY REQUISITION, NOT JUST PARTIES.
                          // This input was originally added for parties alone —
                          // "fractional quantities (2.5 kg paneer) that whole-step
                          // buttons can't express" — and internal requisitions were
                          // left with a read-only span between +/- buttons. That is
                          // exactly the same problem: a kitchen asking for 200 g of
                          // lemon grass needs 0.2 kg, and a +1 stepper cannot say it.
                          // The owner reported it as "the system only allows whole
                          // numbers" (req 68). The column is REAL and the server does
                          // no rounding, so the ONLY thing that blocked a decimal was
                          // this control. Do NOT re-gate it on isParty.
                          <input type="number" step="any" min={0} disabled={saving}
                                 aria-label={`Quantity for ${m.name}`}
                                 value={qtyText[m.id] ?? String(qty)}
                                 onChange={e => {
                                   const v = e.target.value;
                                   setQtyText(p => ({ ...p, [m.id]: v }));
                                   const n = Number(v);
                                   if (v.trim() !== '' && Number.isFinite(n) && n > 0) setQty(m, n);
                                 }}
                                 onBlur={() => setQtyText(p => { const n = { ...p }; delete n[m.id]; return n; })}
                                 className="w-14 text-center text-xs font-bold tabular-nums bg-transparent border-0 focus:outline-none" />
                        )}
                        <button onClick={() => setQty(m, qty + 1)} disabled={saving} aria-label={`Increase ${m.name}`}
                                className="px-2 py-1.5 text-blue-700"><Plus className="w-3.5 h-3.5" /></button>
                      </div>
                    </div>
                  ))}
                </div>
              ))}

              <label className="block text-xs text-[#6B5744] pt-1">
                Notes / Justification (optional)
                <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} disabled={saving}
                          placeholder="Why is this needed?"
                          className="mt-1 w-full px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
              </label>

              {error && (
                <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">{error}</div>
              )}
            </div>

            <div className="shrink-0 px-4 py-3 border-t border-[#E8D5C4] space-y-2" style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
              <div className="flex items-center justify-between text-sm">
                <span className="font-semibold text-[#2D1B0E]">Requisition total</span>
                <span className="font-mono font-bold text-[#2D1B0E]">{inr(cartTotal)}</span>
              </div>
              <div className="flex gap-2">
                <button onClick={() => save(false)} disabled={saving || cartCount === 0}
                        className="flex-1 px-3 py-2.5 border border-[#af4408] text-[#af4408] hover:bg-[#FFF1E3] text-sm font-semibold rounded-lg disabled:opacity-50">
                  {saving ? 'Saving…' : (isEditing ? 'Save Changes' : 'Save Draft')}
                </button>
                <button onClick={() => save(true)} disabled={saving || cartCount === 0}
                        className="flex-1 px-3 py-2.5 bg-[#af4408] hover:bg-[#8a3506] text-white text-sm font-semibold rounded-lg disabled:opacity-50 inline-flex items-center justify-center gap-1.5">
                  <Send className="w-3.5 h-3.5" /> {saving ? 'Working…' : 'Submit to HOD'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
