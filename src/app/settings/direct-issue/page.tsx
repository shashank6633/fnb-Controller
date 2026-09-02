'use client';

/**
 * Settings → DIRECT ISSUE ROUTING (ADMIN only).
 *
 * The owner's rule, verbatim: "DAIRY / ENGLISH VEGETABLES / FRUITS / GAS &
 * CHARCOAL / MEAT / POULTRY / SEAFOOD / VEGETABLES … are the items supplied by
 * the vendor and transferred directly to the Main Kitchen … Central Store
 * Dont Take to Store it." This page is the whole control surface for that
 * decision: WHICH categories and/or WHICH individual items go straight from
 * the vendor's truck to a department's stock, bypassing the central shelf.
 *
 *   GET /api/settings/direct-issue → rules + category list + department picker
 *   PUT /api/settings/direct-issue → { set: […], remove: [rule_id, …] }
 *
 * WHAT A RULE CHANGES — AND THE ONE THING IT CHANGES. On receipt (PO receive,
 * ad-hoc GRN, cash purchase, bulk import), a flagged material's ACCEPTED
 * quantity posts to the chosen DEPARTMENT's stock ledger instead of central
 * stock. The GRN document, the vendor bill row, PINV, taxes, charges and the
 * average-price recompute are byte-identical to a central receipt. The store's
 * own 3-tick quality checklist stays on the receive form, and a category held
 * for kitchen/bar QC still holds — the sign-off releases the goods INTO the
 * department instead of onto the shelf.
 *
 * ITEM RULES BEAT CATEGORY RULES — the owner asked for "some items OR
 * category-wise", so one stubborn material can be pinned to the Bar while the
 * rest of its shelf goes to the kitchen (or stays central: there is no
 * "route to central" item rule because absence already means central; to keep
 * one item OUT of a routed category, just don't add the category — flag its
 * items individually instead).
 *
 * RULES AFFECT FUTURE RECEIPTS ONLY. Stock already sitting in central when a
 * rule is added STAYS in central until issued through a requisition as normal.
 * Un-flagging never moves stock either — it only changes where the NEXT
 * delivery books. Every receipt is stamped with its own destination at write
 * time, so history stays true however this page changes later.
 *
 * ── THE PICKER, AND WHY THE OWNER'S EIGHT ARE PINNED BUT NOT PRE-ENABLED ────
 * The eight categories the owner named are surfaced at the top ("suggested"),
 * including GAS & CHARCOAL which may not exist as a material category yet —
 * the rule can be saved before the first such material is created. Nothing is
 * pre-enabled: which goods bypass the shelf is his decision, made here, not a
 * seed. Store/TGBCL categories are absent from this list because those
 * deliveries live on the store's own ledger and never reach a central receipt
 * — a rule on them would be dead config that looks live (the server refuses
 * it too).
 *
 * ── DESTINATIONS ARE REAL DEPARTMENT ROWS, NOT HARDCODED NAMES ──────────────
 * The dropdown lists the app's own departments (sub-departments under their
 * main). Recipe consumption at KOT-complete debits SUB-departments via the
 * station map, so routing to the sub-department that actually cooks keeps one
 * ledger per room. A deactivated department cannot be picked for a NEW rule,
 * but an existing rule pointing at one keeps routing (its ledger still
 * computes) and is flagged amber here rather than silently dropped.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import MaterialTypeahead, { type MaterialLite } from '@/components/MaterialTypeahead';
import {
  Truck, Loader2, RefreshCw, AlertTriangle, Lock, Save, Search, Star,
  ArrowRight, Package, X, Plus, Building2,
} from 'lucide-react';

interface Rule {
  id: string;
  rule_type: 'category' | 'material';
  category_key: string;
  category_label: string;
  material_id: string;
  department_id: string;
  department_name: string | null;
  department_active: number | null;
  material_name: string | null;
  material_sku: string | null;
  material_category: string | null;
  created_by: string;
  updated_at: string;
}

interface CategoryRow {
  category: string;
  category_key: string;
  material_count: number;
  central_reachable: boolean;
  focus: boolean;
}

interface Dept {
  id: string;
  name: string;
  is_active: number;
  parent_id: string | null;
  parent_name: string | null;
}

interface Payload {
  flags?: { materials: Record<string, string>; categories: Record<string, string> };
  can_edit?: boolean;
  rules?: Rule[];
  categories?: CategoryRow[];
  departments?: Dept[];
  error?: string;
}

const nf = (n: number) => Number(n || 0).toLocaleString('en-IN');

/** Same fold as diCatKey (src/lib/direct-issue.ts) / catNorm — display only. */
const catKey = (s: string) => String(s || '').toLowerCase().trim().replace(/[ \-_]/g, '');

/** Hyphen-split Title Case — same rendering /inventory and qc-categories use. */
const categoryLabel = (c: string) =>
  String(c || '')
    .split('-')
    .map(w => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join('-');

export default function DirectIssuePage() {
  const [data, setData] = useState<Payload | null>(null);
  const [materials, setMaterials] = useState<MaterialLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');

  /** Staged category edits, keyed by category_key. '' = central (remove the
   *  rule if one exists). Batched into ONE PUT — the qc-categories precedent:
   *  a per-click save on 20 rows is 20 chances for half the routing to land. */
  const [pendingCats, setPendingCats] = useState<Record<string, string>>({});
  /** Staged department changes on EXISTING item rules, keyed by rule id. */
  const [pendingItemDept, setPendingItemDept] = useState<Record<string, string>>({});
  /** Existing item rules staged for removal. */
  const [pendingRemove, setPendingRemove] = useState<Set<string>>(new Set());
  /** Brand-new item rules staged locally until Save. */
  const [newItems, setNewItems] = useState<Array<{ material_id: string; name: string; sku: string; category: string; department_id: string }>>([]);
  /** The add-item pickers. */
  const [addMat, setAddMat] = useState('');
  const [addDept, setAddDept] = useState('');

  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((ok: boolean, msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ ok, msg });
    toastTimer.current = setTimeout(() => setToast(null), ok ? 5000 : 10000);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true); else setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/settings/direct-issue', { cache: 'no-store' });
      if (res.status === 401 || res.status === 403) { setForbidden(true); return; }
      const j = (await res.json().catch(() => ({}))) as Payload;
      if (!res.ok) { setLoadError(j?.error || `HTTP ${res.status}`); return; }
      // A non-admin gets flags only (no rules array) — that is the lock panel,
      // not an empty config.
      if (!j.can_edit) { setForbidden(true); return; }
      setData(j);
      setPendingCats({});
      setPendingItemDept({});
      setPendingRemove(new Set());
      setNewItems([]);
    } catch {
      setLoadError('Network error — could not load the routing rules.');
    } finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    // The item-rule picker's haystack. scope=all: this is a store-side admin
    // screen and the dept-category whitelist must not hide anything from it.
    fetch('/api/inventory?scope=all')
      .then(r => (r.ok ? r.json() : null))
      .then(d => setMaterials((d?.materials || []) as MaterialLite[]))
      .catch(() => setMaterials([]));
  }, []);

  const rules = useMemo(() => data?.rules ?? [], [data]);
  const catRules = useMemo(() => {
    const m = new Map<string, Rule>();
    for (const r of rules) if (r.rule_type === 'category' && r.category_key) m.set(r.category_key, r);
    return m;
  }, [rules]);
  const itemRules = useMemo(() => rules.filter(r => r.rule_type === 'material'), [rules]);
  const itemRuleMatIds = useMemo(() => new Set(itemRules.map(r => String(r.material_id))), [itemRules]);

  /** Active departments only, mains first, each sub labelled under its main —
   *  the server refuses a deactivated destination for a new/changed rule. */
  const activeDepts = useMemo(
    () => (data?.departments ?? []).filter(d => Number(d.is_active)),
    [data],
  );
  const deptLabel = useCallback((d: Dept) => (d.parent_name ? `${d.name} — ${d.parent_name}` : d.name), []);
  const deptNameById = useCallback((id: string) => {
    const d = (data?.departments ?? []).find(x => x.id === id);
    return d ? d.name : id;
  }, [data]);

  /** Central-reachable categories only. Store/TGBCL shelves never reach a
   *  central receipt, so a rule on them can never fire — the server refuses
   *  them and this page does not offer them. */
  const categories = useMemo(
    () => (data?.categories ?? []).filter(c => c.central_reachable),
    [data],
  );
  const storeOnlyCount = useMemo(
    () => (data?.categories ?? []).filter(c => !c.central_reachable).length,
    [data],
  );

  /** What the select shows for a category row: staged value, else the saved
   *  rule's department, else '' = central. */
  const catValue = useCallback((key: string): string => {
    if (key in pendingCats) return pendingCats[key];
    return catRules.get(key)?.department_id || '';
  }, [pendingCats, catRules]);

  const catDirty = useCallback((key: string): boolean => {
    if (!(key in pendingCats)) return false;
    return pendingCats[key] !== (catRules.get(key)?.department_id || '');
  }, [pendingCats, catRules]);

  const itemValue = useCallback((r: Rule): string => pendingItemDept[r.id] ?? r.department_id, [pendingItemDept]);

  const dirtyCount = useMemo(() => {
    let n = 0;
    for (const key of Object.keys(pendingCats)) if (catDirty(key)) n++;
    for (const [id, dep] of Object.entries(pendingItemDept)) {
      if (pendingRemove.has(id)) continue;
      const r = itemRules.find(x => x.id === id);
      if (r && dep !== r.department_id) n++;
    }
    n += pendingRemove.size + newItems.length;
    return n;
  }, [pendingCats, catDirty, pendingItemDept, pendingRemove, itemRules, newItems]);

  const filteredCats = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = q
      ? categories.filter(c =>
          c.category.toLowerCase().includes(q) || c.category_key.includes(q.replace(/[\s\-_]/g, '')))
      : categories;
    // Owner's suggested set first (his motivating list), then routed, then the
    // rest — inside each band, alphabetical.
    return [...base].sort((a, b) => {
      const ra = catValue(a.category_key) ? 0 : 1;
      const rb = catValue(b.category_key) ? 0 : 1;
      const fa = a.focus ? 0 : 1;
      const fb = b.focus ? 0 : 1;
      if (fa !== fb) return fa - fb;
      if (ra !== rb) return ra - rb;
      return a.category.localeCompare(b.category);
    });
  }, [categories, search, catValue]);

  const addItemRule = useCallback(() => {
    if (!addMat || !addDept) return;
    const m = materials.find(x => String(x.id) === addMat);
    if (!m) return;
    setNewItems(list => [...list, {
      material_id: String(m.id), name: m.name, sku: String(m.sku || ''),
      category: String(m.category || ''), department_id: addDept,
    }]);
    setAddMat('');
  }, [addMat, addDept, materials]);

  const save = useCallback(async () => {
    if (dirtyCount === 0 || saving) return;
    const set: any[] = [];
    const remove: string[] = [];
    for (const [key, dep] of Object.entries(pendingCats)) {
      if (!catDirty(key)) continue;
      const existing = catRules.get(key);
      if (!dep) {
        if (existing) remove.push(existing.id);
        continue;
      }
      const row = categories.find(c => c.category_key === key);
      set.push({ rule_type: 'category', category: row?.category || existing?.category_label || key, department_id: dep });
    }
    for (const id of pendingRemove) remove.push(id);
    for (const [id, dep] of Object.entries(pendingItemDept)) {
      if (pendingRemove.has(id)) continue;
      const r = itemRules.find(x => x.id === id);
      if (r && dep !== r.department_id) set.push({ rule_type: 'material', material_id: r.material_id, department_id: dep });
    }
    for (const n of newItems) set.push({ rule_type: 'material', material_id: n.material_id, department_id: n.department_id });

    setSaving(true);
    try {
      const res = await api('/api/settings/direct-issue', { method: 'PUT', body: { set, remove } });
      const j = await res.json().catch(() => ({} as any));
      if (!res.ok) { flash(false, j?.error || `Could not save (HTTP ${res.status}).`); return; }
      flash(true, `${nf(dirtyCount)} routing change${dirtyCount === 1 ? '' : 's'} saved. Applies to the very next delivery recorded — stock already in central stays there until issued normally.`);
      load(true);
    } catch {
      flash(false, 'Network error — nothing was saved.');
    } finally { setSaving(false); }
  }, [dirtyCount, saving, pendingCats, catDirty, catRules, categories, pendingRemove, pendingItemDept, itemRules, newItems, flash, load]);

  if (forbidden) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] flex items-center justify-center p-6">
        <div className="max-w-sm text-center text-[#6B5744]">
          <Lock className="w-10 h-10 mx-auto mb-3 text-[#af4408]" />
          <h1 className="text-lg font-bold text-[#2D1B0E]">Admins only</h1>
          <p className="text-sm mt-1">
            This map decides which vendor deliveries bypass the central store entirely, so it is
            restricted to admin accounts.
          </p>
        </div>
      </div>
    );
  }

  const routedCats = categories.filter(c => catValue(c.category_key));
  const liveItemRules = itemRules.filter(r => !pendingRemove.has(r.id));

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-4xl mx-auto px-3 sm:px-6 py-5 space-y-4">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">Settings</p>
            <h1 className="text-2xl sm:text-3xl font-bold mt-0.5 flex items-center gap-2.5">
              <Truck className="w-7 h-7 text-[#af4408] shrink-0" />
              <span className="min-w-0">Direct Issue Routing</span>
            </h1>
            <p className="text-sm text-[#8B7355] mt-1">
              A delivery of a routed category or item goes <b>straight from the vendor to the
              department&apos;s stock</b> — the central store records the bill, the GRN and its quality
              checklist exactly as today, but never shelves the goods. Item rules beat category rules.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={() => load(true)} disabled={refreshing}
                    className="p-2 rounded-lg border border-[#E8D5C4] bg-white hover:bg-[#FFF3E6] disabled:opacity-50"
                    title="Reload">
              <RefreshCw className={`w-4 h-4 text-[#8B7355] ${refreshing ? 'animate-spin' : ''}`} />
            </button>
            <button onClick={save} disabled={dirtyCount === 0 || saving}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#af4408] text-white text-sm font-semibold
                               hover:bg-[#8a3606] disabled:opacity-40 disabled:cursor-not-allowed">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save{dirtyCount > 0 ? ` (${nf(dirtyCount)})` : ''}
            </button>
          </div>
        </div>

        {/* The time rule, stated where the decision is made. */}
        <div className="rounded-xl border border-[#E8D5C4] bg-white p-3 text-[12px] text-[#6B5744] flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <div>
            <b>Rules apply to future deliveries only.</b> Stock already in the central store when you
            add a rule stays there until issued through a requisition as normal — nothing is moved
            retroactively, in either direction. Quality-check holds keep working: a held delivery of a
            routed material is released <i>into the department</i> when the kitchen or bar signs it off.
          </div>
        </div>

        {toast && (
          <div className={`rounded-xl border p-3 text-sm ${toast.ok
            ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
            : 'border-red-200 bg-red-50 text-red-800'}`}>
            {toast.msg}
          </div>
        )}
        {loadError && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            {loadError}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-16 text-[#8B7355]">
            <Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading routing rules…
          </div>
        ) : data && (
          <>
            {/* ── CATEGORY RULES ─────────────────────────────────────────── */}
            <div className="rounded-xl border border-[#E8D5C4] bg-white overflow-hidden">
              <div className="px-4 py-3 border-b border-[#E8D5C4] flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <h2 className="font-bold text-[15px] flex items-center gap-2">
                    <Building2 className="w-4 h-4 text-[#af4408]" />
                    Category-wise routing
                    {routedCats.length > 0 && (
                      <span className="text-[11px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5">
                        {nf(routedCats.length)} routed
                      </span>
                    )}
                  </h2>
                  <p className="text-[11px] text-[#8B7355] mt-0.5">
                    Every material of the category, unless an item rule below pins it elsewhere.
                    <Star className="w-3 h-3 inline mx-1 text-amber-500 fill-amber-400" />
                    marks the categories the owner asked for — none are enabled until you pick a
                    destination and save.
                  </p>
                </div>
                <div className="relative shrink-0">
                  <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[#B8A590]" />
                  <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Find a category…"
                         className="pl-7 pr-2 py-1.5 border border-[#E8D5C4] rounded-lg text-xs bg-[#FFF8F0] w-full sm:w-52" />
                </div>
              </div>
              <div className="divide-y divide-[#E8D5C4]/60">
                {filteredCats.length === 0 && (
                  <p className="px-4 py-6 text-sm text-[#8B7355]">No category matches.</p>
                )}
                {filteredCats.map(c => {
                  const val = catValue(c.category_key);
                  const dirty = catDirty(c.category_key);
                  const saved = catRules.get(c.category_key);
                  const savedDeptGone = !!saved && !saved.department_name;
                  const savedDeptInactive = !!saved && !!saved.department_name && !Number(saved.department_active);
                  return (
                    <div key={c.category_key}
                         className={`px-4 py-2.5 flex flex-col sm:flex-row sm:items-center gap-2 ${dirty ? 'bg-amber-50/50' : ''}`}>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium flex items-center gap-1.5">
                          {c.focus && <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-400 shrink-0" />}
                          <span className="truncate">{categoryLabel(c.category)}</span>
                        </p>
                        <p className="text-[10px] text-[#B8A590]">
                          {c.material_count > 0
                            ? `${nf(c.material_count)} material${c.material_count === 1 ? '' : 's'}`
                            : 'no materials carry this category yet — the rule waits for the first one'}
                          {savedDeptGone && (
                            <span className="text-amber-700 font-semibold"> · saved destination was deleted — rule is inert; pick a new one or clear it</span>
                          )}
                          {savedDeptInactive && !dirty && (
                            <span className="text-amber-700 font-semibold"> · destination “{saved!.department_name}” is deactivated — still routing there; its ledger still counts</span>
                          )}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {val && <ArrowRight className="w-3.5 h-3.5 text-[#af4408]" />}
                        <select value={val}
                                onChange={e => setPendingCats(p => ({ ...p, [c.category_key]: e.target.value }))}
                                className={`px-2 py-1.5 border rounded-lg text-xs bg-white min-w-[190px] ${
                                  val ? 'border-[#af4408]/50 font-semibold text-[#af4408]' : 'border-[#E8D5C4] text-[#6B5744]'}`}>
                          <option value="">Central store (normal)</option>
                          {activeDepts.map(d => (
                            <option key={d.id} value={d.id}>{deptLabel(d)}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  );
                })}
              </div>
              {storeOnlyCount > 0 && (
                <p className="px-4 py-2 text-[10px] text-[#B8A590] border-t border-[#E8D5C4]/60">
                  {nf(storeOnlyCount)} store/TGBCL categor{storeOnlyCount === 1 ? 'y is' : 'ies are'} not listed —
                  those deliveries live on the store&apos;s own ledger and never reach a central receipt.
                </p>
              )}
            </div>

            {/* ── ITEM RULES ─────────────────────────────────────────────── */}
            <div className="rounded-xl border border-[#E8D5C4] bg-white overflow-hidden">
              <div className="px-4 py-3 border-b border-[#E8D5C4]">
                <h2 className="font-bold text-[15px] flex items-center gap-2">
                  <Package className="w-4 h-4 text-[#af4408]" />
                  Item-wise routing
                  {liveItemRules.length + newItems.length > 0 && (
                    <span className="text-[11px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5">
                      {nf(liveItemRules.length + newItems.length)} item{liveItemRules.length + newItems.length === 1 ? '' : 's'}
                    </span>
                  )}
                </h2>
                <p className="text-[11px] text-[#8B7355] mt-0.5">
                  Pins ONE material to a destination and beats its category&apos;s rule. Use it for the odd
                  item of a routed shelf that goes to the Bar instead — or for single items whose whole
                  category should stay central.
                </p>
              </div>

              {/* add row */}
              <div className="px-4 py-3 border-b border-[#E8D5C4]/60 bg-[#FFF8F0]/60 flex flex-col sm:flex-row gap-2 sm:items-center">
                <div className="flex-1 min-w-0">
                  <MaterialTypeahead
                    materials={materials}
                    value={addMat}
                    onPick={id => setAddMat(id)}
                    excludeIds={[...itemRuleMatIds, ...newItems.map(n => n.material_id)]}
                    placeholder="Type an item name, SKU or category…"
                  />
                </div>
                <select value={addDept} onChange={e => setAddDept(e.target.value)}
                        className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg text-xs bg-white min-w-[190px]">
                  <option value="">Destination…</option>
                  {activeDepts.map(d => <option key={d.id} value={d.id}>{deptLabel(d)}</option>)}
                </select>
                <button onClick={addItemRule} disabled={!addMat || !addDept}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-[#af4408]/40 text-[#af4408] text-xs font-semibold
                                   hover:bg-[#FFF3E6] disabled:opacity-40 disabled:cursor-not-allowed shrink-0">
                  <Plus className="w-3.5 h-3.5" /> Add
                </button>
              </div>

              <div className="divide-y divide-[#E8D5C4]/60">
                {liveItemRules.length === 0 && newItems.length === 0 && (
                  <p className="px-4 py-5 text-sm text-[#8B7355]">
                    No item rules yet. Category rules above cover whole shelves; add an item here only
                    when one material must go somewhere different.
                  </p>
                )}
                {liveItemRules.map(r => {
                  const val = itemValue(r);
                  const dirty = val !== r.department_id;
                  const deptGone = !r.department_name;
                  const deptInactive = !!r.department_name && !Number(r.department_active);
                  return (
                    <div key={r.id} className={`px-4 py-2.5 flex flex-col sm:flex-row sm:items-center gap-2 ${dirty ? 'bg-amber-50/50' : ''}`}>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{r.material_name || r.material_id}</p>
                        <p className="text-[10px] text-[#B8A590]">
                          {r.material_sku ? `${r.material_sku} · ` : ''}{categoryLabel(String(r.material_category || ''))}
                          {catRules.get(catKey(String(r.material_category || ''))) && (
                            <span className="text-[#8B7355]"> · overrides the category rule</span>
                          )}
                          {deptGone && (
                            <span className="text-amber-700 font-semibold"> · saved destination was deleted — rule is inert; pick a new one or remove it</span>
                          )}
                          {deptInactive && !dirty && (
                            <span className="text-amber-700 font-semibold"> · destination “{r.department_name}” is deactivated — still routing there</span>
                          )}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <ArrowRight className="w-3.5 h-3.5 text-[#af4408]" />
                        <select value={val}
                                onChange={e => setPendingItemDept(p => ({ ...p, [r.id]: e.target.value }))}
                                className="px-2 py-1.5 border border-[#af4408]/50 rounded-lg text-xs bg-white min-w-[190px] font-semibold text-[#af4408]">
                          {/* the saved destination stays pickable even if deactivated/deleted — it is the current value */}
                          {!activeDepts.some(d => d.id === r.department_id) && (
                            <option value={r.department_id}>{r.department_name || '(deleted department)'}</option>
                          )}
                          {activeDepts.map(d => <option key={d.id} value={d.id}>{deptLabel(d)}</option>)}
                        </select>
                        <button onClick={() => setPendingRemove(s => new Set(s).add(r.id))}
                                title="Remove this rule — the item books to central again from the next delivery"
                                className="p-1.5 rounded-lg border border-[#E8D5C4] text-[#8B7355] hover:text-red-700 hover:border-red-200 hover:bg-red-50">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
                {newItems.map((n, i) => (
                  <div key={`new-${n.material_id}`} className="px-4 py-2.5 flex flex-col sm:flex-row sm:items-center gap-2 bg-amber-50/50">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{n.name} <span className="text-[10px] text-amber-700 font-semibold">(not saved yet)</span></p>
                      <p className="text-[10px] text-[#B8A590]">{n.sku ? `${n.sku} · ` : ''}{categoryLabel(n.category)}</p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <ArrowRight className="w-3.5 h-3.5 text-[#af4408]" />
                      <select value={n.department_id}
                              onChange={e => setNewItems(list => list.map((x, j) => j === i ? { ...x, department_id: e.target.value } : x))}
                              className="px-2 py-1.5 border border-[#af4408]/50 rounded-lg text-xs bg-white min-w-[190px] font-semibold text-[#af4408]">
                        {activeDepts.map(d => <option key={d.id} value={d.id}>{deptLabel(d)}</option>)}
                      </select>
                      <button onClick={() => setNewItems(list => list.filter((_, j) => j !== i))}
                              className="p-1.5 rounded-lg border border-[#E8D5C4] text-[#8B7355] hover:text-red-700 hover:border-red-200 hover:bg-red-50">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
                {pendingRemove.size > 0 && (
                  <p className="px-4 py-2 text-[11px] text-amber-800 bg-amber-50/60">
                    {nf(pendingRemove.size)} rule{pendingRemove.size === 1 ? '' : 's'} will be removed on Save —
                    the item books to central again from the next delivery.{' '}
                    <button className="underline font-semibold" onClick={() => setPendingRemove(new Set())}>Undo</button>
                  </p>
                )}
              </div>
            </div>

            {/* What the receiver will see. */}
            <p className="text-[11px] text-[#8B7355] px-1">
              On the receiving screens, routed lines carry a{' '}
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full border border-[#af4408]/40 bg-[#FFF3E6] text-[#af4408] text-[9px] font-semibold">
                <Truck className="w-2.5 h-2.5" /> → {routedCats.length > 0 ? deptNameById(catValue(routedCats[0].category_key)) : 'Main Kitchen'}
              </span>{' '}
              badge so the storeman knows the goods do not go to the shelf.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
