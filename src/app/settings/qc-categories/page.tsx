'use client';

/**
 * Settings → QUALITY CHECK CATEGORIES (ADMIN only).
 *
 * WHICH deliveries are held for a kitchen/bar check is DATA the owner edits,
 * not a list in code. A GRN line whose material sits in a category mapped to
 * Kitchen / Bar / Both is recorded with NO stock movement until that department
 * signs it off; a category mapped to "No check" inwards exactly as it always
 * did. This page is the whole control surface for that decision.
 *
 *   GET /api/grn/qc/categories → every live category + count + checker +
 *                                assigned flag, and the alert settings
 *   PUT /api/grn/qc/categories → { updates:[{category,checker}], escalation_hours,
 *                                  wa_enabled, wa_recipients }
 *
 * ── WHY A MAP AND NOT A TIDY-UP ────────────────────────────────────────────
 * The category names in this database are inconsistent — veg (117 materials),
 * vegetables (2) and english-vegetables (2) are three spellings of one thing.
 * The owner chose the map over renaming 952 materials, so the map has to carry
 * every spelling. The server keys each row on the catNorm normalisation
 * (lower-case, strip space/hyphen/underscore), so "frozen-cheese", "Frozen
 * Cheese" and "frozen_cheese" are ONE row and a second spelling can never
 * silently mean "No check".
 *
 * ── UNASSIGNED IS AMBER, NEVER RED, AND IT IS AT THE TOP ───────────────────
 * A category with no row in the map defaults to "No check". That default is the
 * safe direction — silently BLOCKING an unmapped category would stop a delivery
 * nobody meant to stop, at the bay, with a vendor waiting. The risk it creates
 * (a perishable category added later and never mapped) is answered by making
 * the gap LOUD, not by guessing. Hence: unassigned rows are listed first, under
 * their own heading, with the material count they govern.
 *
 * Amber and not red because unassigned is a legitimate resting state for
 * grocery, packaging and stationery, and red makes a hurried admin pick a
 * plausible-looking value just to clear the colour — the exact failure the
 * station-department map documents. Choosing "No check" EXPLICITLY is a real
 * decision and clears the row from the callout, which is how a new category is
 * prevented from hiding.
 *
 * ── THE UNASSIGNED COUNT IS SPLIT, AND IT MUST STAY SPLIT ──────────────────
 * 118 bar materials (plus 9 more liquor categories) are store-mapped to the
 * TGBCL ledger, and centralFlowBlock() refuses them on every receiving route —
 * so a checker set on them could never fire. Reporting them inside one
 * "unassigned" number would send an admin hunting a problem that does not
 * exist. The server answers `central_reachable` per row for exactly this, and
 * this page renders the two groups apart.
 *
 * ── THE PAGE READS `can_edit` FROM THIS ENDPOINT, NOT /api/auth/me ─────────
 * One fetch, no race, and the gate on screen cannot disagree with the gate on
 * the write — the settings/station-departments precedent. Both verbs here are
 * requireRole('admin') server-side; this page is adminOnly in the catalog too,
 * so a non-admin gets the lock panel and the grid is never built.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import Toggle from '@/components/Toggle';
import {
  ShieldCheck, ChefHat, Wine, Loader2, RefreshCw, AlertTriangle, CheckCircle2,
  Info, Lock, Save, Search, XCircle, Clock, MessageSquare, Package,
} from 'lucide-react';

type Checker = 'none' | 'kitchen' | 'bar' | 'both';

interface CategoryRow {
  category: string;
  category_key: string;
  checker: Checker;
  /** Has a row in the map at all. false ⇒ reads as 'none' but nobody decided it. */
  assigned: boolean;
  material_count: number;
  /** false ⇒ store-mapped (TGBCL); a checker here could never fire. */
  central_reachable: boolean;
  updated_by: string;
  updated_at: string;
}

interface Payload {
  rows: CategoryRow[];
  checkers: Checker[];
  can_edit: boolean;
  escalation_hours: number;
  unassigned_total: number;
  unassigned_central: number;
  unassigned_central_materials: number;
  unassigned_store_only: number;
  wa_key: string;
  wa_enabled: boolean;
  wa_recipients: string[];
  /** Is the gate actually armed? qcSchemaHealth() in src/lib/grn-qc.ts. */
  schema_health?: {
    ok: boolean; armed: boolean; message: string;
    missing_header_columns: string[]; missing_line_columns: string[];
    map_table_missing: boolean; mapped_categories: number;
  };
  error?: string;
}

/** The PUT answer. Everything optional — this is a parsed HTTP body and the
 *  refusal paths carry only `error`. */
interface SaveResponse {
  success?: boolean;
  updated?: number;
  escalation_hours?: number;
  wa_enabled?: boolean;
  wa_master_switch?: boolean;
  wa_recipients?: string[];
  invalid?: string[];
  error?: string;
}

const CHECKER_OPTIONS: Array<{ value: Checker; label: string }> = [
  { value: 'none',    label: 'No check' },
  { value: 'kitchen', label: 'Kitchen' },
  { value: 'bar',     label: 'Bar' },
  { value: 'both',    label: 'Kitchen or Bar' },
];

const nf = (n: number) => Number(n || 0).toLocaleString('en-IN');

/** Hyphen-split Title Case — the same rendering /inventory uses for a category,
 *  so "english-vegetables" reads the same on both screens. */
const categoryLabel = (c: string) =>
  String(c || '')
    .split('-')
    .map(w => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join('-');

function istWhen(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso.includes('T') || iso.includes('Z') ? iso : iso.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

function CheckerBadge({ checker }: { checker: Checker }) {
  if (checker === 'none') {
    return <span className="inline-flex items-center gap-1 text-[10px] text-[#8B7355]">No check</span>;
  }
  const Icon = checker === 'bar' ? Wine : ChefHat;
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold
                     bg-emerald-50 text-emerald-700 border border-emerald-200">
      <Icon className="w-3 h-3" />{checker === 'both' ? 'Kitchen or Bar' : checker === 'bar' ? 'Bar' : 'Kitchen'}
    </span>
  );
}

export default function QcCategoriesPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savingAlerts, setSavingAlerts] = useState(false);
  const [search, setSearch] = useState('');
  const [showStoreOnly, setShowStoreOnly] = useState(false);

  /** Staged edits, keyed by category_key. Batched into ONE PUT — the settings/
   *  categories precedent. A per-click save on 29 rows is 29 chances for half
   *  the map to be written. */
  const [pending, setPending] = useState<Record<string, Checker>>({});

  /* alert settings, staged locally */
  const [hours, setHours] = useState('');
  const [waOn, setWaOn] = useState(false);
  const [waTo, setWaTo] = useState('');

  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((ok: boolean, msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ ok, msg });
    toastTimer.current = setTimeout(() => setToast(null), ok ? 4000 : 10000);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true); else setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/grn/qc/categories', { cache: 'no-store' });
      if (res.status === 401 || res.status === 403) { setForbidden(true); return; }
      const j = (await res.json().catch(() => ({}))) as Payload;
      if (!res.ok) { setLoadError(j?.error || `HTTP ${res.status}`); return; }
      // Fail closed on a body that parsed but carries no grid — an empty page
      // would read as "no categories exist", which is a much calmer statement
      // than "the map did not load".
      if (!Array.isArray(j?.rows)) { setLoadError('The category map came back empty — reload, or check the server log.'); return; }
      setData(j);
      setPending({});
      setHours(String(j.escalation_hours ?? ''));
      setWaOn(!!j.wa_enabled);
      setWaTo((j.wa_recipients || []).join(', '));
      if (!j.can_edit) setForbidden(true);
    } catch {
      setLoadError('Network error — could not load the category map.');
    } finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const effective = useCallback(
    (r: CategoryRow): Checker => pending[r.category_key] ?? r.checker,
    [pending],
  );

  /**
   * Is this row staged for a write?
   *
   * An UNASSIGNED row staged as 'none' counts as a change even though the value
   * did not move — that is the whole point of "assigning No check": it records
   * that somebody decided, and it is what clears the row out of the unassigned
   * callout. Treating it as a no-op would leave the admin unable to acknowledge
   * a category at all.
   */
  const isDirty = useCallback((r: CategoryRow): boolean => {
    const p = pending[r.category_key];
    if (p === undefined) return false;
    return p !== r.checker || !r.assigned;
  }, [pending]);

  /** Memoised so the derived groups below keep a stable identity between
   *  keystrokes in the search box. */
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const dirtyRows = useMemo(() => rows.filter(isDirty), [rows, isDirty]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r => r.category.toLowerCase().includes(q));
  }, [rows, search]);

  /* THE THREE GROUPS, in the order an admin needs them:
     1. unassigned AND reachable  — the only ones that are genuinely a gap
     2. everything else reachable — the working map
     3. store-only (TGBCL)        — cannot be gated at all, folded away  */
  const unassignedCentral = filtered.filter(r => !r.assigned && r.central_reachable);
  const assignedCentral   = filtered.filter(r => r.assigned && r.central_reachable);
  const storeOnly         = filtered.filter(r => !r.central_reachable);

  const gatedMaterials = rows
    .filter(r => effective(r) !== 'none' && r.central_reachable)
    .reduce((s, r) => s + r.material_count, 0);
  const gatedCategories = rows.filter(r => effective(r) !== 'none' && r.central_reachable).length;

  const saveMap = useCallback(async () => {
    if (dirtyRows.length === 0 || saving) return;
    setSaving(true);
    try {
      const res = await api('/api/grn/qc/categories', {
        method: 'PUT',
        body: { updates: dirtyRows.map(r => ({ category: r.category, checker: effective(r) })) },
      });
      const j = (await res.json().catch(() => ({}))) as SaveResponse;
      if (!res.ok) { flash(false, j?.error || `Could not save (HTTP ${res.status}).`); return; }
      flash(true, `${nf(Number(j.updated ?? dirtyRows.length))} categor${(j.updated ?? dirtyRows.length) === 1 ? 'y' : 'ies'} saved. It applies to the very next delivery recorded.`);
      // Re-read rather than patch in place: material counts, the assigned flags
      // and the two unassigned totals are all server-derived, and a screen that
      // keeps reporting the gap the admin just closed is a screen nobody trusts.
      load(true);
    } catch {
      flash(false, 'Network error — nothing was saved.');
    } finally { setSaving(false); }
  }, [dirtyRows, saving, effective, flash, load]);

  const saveAlerts = useCallback(async () => {
    if (savingAlerts) return;
    const n = Number(hours);
    if (!Number.isFinite(n) || n < 1 || n > 168) {
      flash(false, 'Escalation hours must be between 1 and 168 (one week). It is how long a delivery may sit unchecked before the head chef is pinged.');
      return;
    }
    setSavingAlerts(true);
    try {
      const res = await api('/api/grn/qc/categories', {
        method: 'PUT',
        body: {
          escalation_hours: Math.round(n),
          wa_enabled: waOn,
          wa_recipients: waTo.split(',').map(s => s.trim()).filter(Boolean),
        },
      });
      const j = (await res.json().catch(() => ({}))) as SaveResponse;
      if (!res.ok) { flash(false, j?.error || `Could not save (HTTP ${res.status}).`); return; }
      // Stated back rather than assumed: with the master WhatsApp switch off,
      // turning this on changes nothing, and an admin who is not told that will
      // believe the pings are live.
      if (waOn && j.wa_master_switch === false) {
        flash(false, 'Saved — but WhatsApp is switched off for the whole app, so no message will be sent. Turn on notifications in Settings → WhatsApp first.');
      } else {
        flash(true, 'Alert settings saved.');
      }
      load(true);
    } catch {
      flash(false, 'Network error — nothing was saved.');
    } finally { setSavingAlerts(false); }
  }, [savingAlerts, hours, waOn, waTo, flash, load]);

  if (forbidden) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] flex items-center justify-center p-6">
        <div className="max-w-sm text-center text-[#6B5744]">
          <Lock className="w-10 h-10 mx-auto mb-3 text-[#af4408]" />
          <h1 className="text-lg font-bold text-[#2D1B0E]">Admins only</h1>
          <p className="text-sm mt-1">
            This map decides which deliveries are held at the bay until the kitchen signs, so it is
            restricted to admin accounts.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-4xl mx-auto px-3 sm:px-6 py-5 space-y-4">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">Settings</p>
            <h1 className="text-2xl sm:text-3xl font-bold mt-0.5 flex items-center gap-2.5">
              <ShieldCheck className="w-7 h-7 text-[#af4408] shrink-0" />
              <span className="min-w-0">Quality Check Categories</span>
            </h1>
            <p className="text-sm text-[#8B7355] mt-1">
              A delivery containing a material from a <b>checked</b> category is recorded but does{' '}
              <b>not enter stock</b> until kitchen or bar signs it off on{' '}
              <Link href="/grn/qc" className="underline text-[#af4408]">Pending Quality Checks</Link>. Everything
              else inwards exactly as it does today.
            </p>
          </div>
          <button
            onClick={() => load(true)}
            className="shrink-0 self-start sm:self-auto flex items-center gap-2 px-3 py-2.5 bg-white border border-[#E0D0BE]
                       hover:bg-[#FFF1E3] text-[#6B5744] rounded-xl text-sm font-medium shadow-sm"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />Refresh
          </button>
        </div>

        {loadError && (
          <div className="flex items-start gap-2 p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /><span>{loadError}</span>
          </div>
        )}

        {/* Counts */}
        {data && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            {[
              { label: 'Categories', value: nf(rows.length), cls: 'text-[#2D1B0E]' },
              { label: 'Checked', value: nf(gatedCategories), cls: gatedCategories > 0 ? 'text-emerald-700' : 'text-[#2D1B0E]' },
              { label: 'Materials governed', value: nf(gatedMaterials), cls: 'text-[#2D1B0E]' },
              { label: 'Not yet decided', value: nf(data.unassigned_central), cls: data.unassigned_central > 0 ? 'text-amber-700' : 'text-emerald-700' },
            ].map(c => (
              <div key={c.label} className="bg-white border border-[#E8D5C4] rounded-2xl px-3 py-2.5 shadow-sm">
                <p className="text-[10px] text-[#8B7355] leading-tight">{c.label}</p>
                <p className={`text-xl font-bold mt-0.5 ${c.cls}`}>{c.value}</p>
              </div>
            ))}
          </div>
        )}

        {/* ── THE GATE IS NOT ARMED ────────────────────────────────────────
            RED, unlike everything else on this page, and above the unassigned
            callout. The gate fails OPEN on a schema fault (grn-qc.ts,
            getCategoryCheckerMap swallows a missing table and an empty map reads
            'none' for every category) and db.ts only console.errors a failed
            boot migration — so a half-applied deploy silently switches the whole
            feature off: every delivery inwards instantly, the queue reads 0 and
            the bell reads 0, all of which look exactly like a quiet morning.
            This screen is the only place an admin can act on it, so it says so
            in words rather than leaving it to be inferred from every category
            reading "unassigned". Failing open is still the right direction —
            blocking deliveries at the bay over a schema fault is worse — but
            silence about it is not. */}
        {data?.schema_health && !data.schema_health.ok && (
          <div className="flex items-start gap-2 p-4 bg-red-50 border border-red-300 rounded-xl text-sm text-red-900">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <b>The quality-check gate is NOT ARMED — nothing is being held.</b>
              <p className="mt-1">{data.schema_health.message}</p>
              {(data.schema_health.missing_header_columns.length > 0 || data.schema_health.missing_line_columns.length > 0) && (
                <p className="mt-1 font-mono text-[11px] break-words">
                  missing: {[...data.schema_health.missing_header_columns, ...data.schema_health.missing_line_columns].join(', ')}
                </p>
              )}
              <p className="mt-1">
                Nothing below can fix this — it is a database migration that did not apply. Restart the server and check
                the log for <span className="font-mono">GRN QC schema failed</span>.
              </p>
            </div>
          </div>
        )}

        {/* THE CALLOUT. Amber, never red — see the header. */}
        {data && data.unassigned_central > 0 && (
          <div className="flex items-start gap-2 p-4 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-900">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <b>
                {nf(data.unassigned_central)} categor{data.unassigned_central === 1 ? 'y has' : 'ies have'} never been
                decided — {nf(data.unassigned_central_materials)} material{data.unassigned_central_materials === 1 ? '' : 's'}.
              </b>
              <p className="mt-1 text-amber-800">
                They currently inward with <b>no check</b>, which is the safe default but nobody chose it. Set each one
                below — picking <b>No check</b> is a real answer and clears it from this list, so a category added next
                month cannot hide here unnoticed.
              </p>
              {data.unassigned_store_only > 0 && (
                <p className="mt-1 text-amber-800">
                  A further {nf(data.unassigned_store_only)} liquor categor{data.unassigned_store_only === 1 ? 'y is' : 'ies are'}{' '}
                  <b>not counted above</b>: they are store-mapped to the TGBCL ledger and can never reach a central
                  goods receipt, so a checker on them could never fire.
                </p>
              )}
            </div>
          </div>
        )}

        {/* Search + save */}
        <div className="flex flex-wrap items-center gap-2 bg-white border border-[#E8D5C4] rounded-2xl p-3 sticky top-0 z-10 shadow-sm">
          <div className="relative flex-1 min-w-[180px]">
            <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-[#8B7355]" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search categories…"
              className="w-full pl-8 pr-2 py-2 border border-[#E8D5C4] rounded-xl text-sm bg-[#FFF8F0]"
            />
          </div>
          <button
            onClick={saveMap}
            disabled={dirtyRows.length === 0 || saving}
            className="px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-xl text-sm font-semibold
                       flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Save{dirtyRows.length > 0 ? ` (${dirtyRows.length})` : ''}
          </button>
        </div>

        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map(i => <div key={i} className="bg-white border border-[#E8D5C4] rounded-2xl h-14 animate-pulse" />)}
          </div>
        ) : rows.length === 0 ? (
          <div className="bg-white border border-[#E8D5C4] rounded-2xl py-14 text-center text-[#8B7355]">
            <Info className="w-9 h-9 mx-auto mb-3 text-[#C9B49C]" />
            <p className="font-medium text-[#2D1B0E]">No categories found</p>
            <p className="text-xs mt-1">Raw materials carry the category list; add materials and they appear here.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {unassignedCentral.length > 0 && (
              <Group
                title="Not yet decided"
                tone="amber"
                note="These inward with no check because nothing has been set. Choose one — including No check."
                rows={unassignedCentral}
                effective={effective}
                isDirty={isDirty}
                onPick={(k, v) => setPending(p => ({ ...p, [k]: v }))}
              />
            )}

            {assignedCentral.length > 0 && (
              <Group
                title="Decided"
                tone="plain"
                note="Kitchen or Bar means that department must sign before the goods enter stock. Kitchen or Bar means EITHER may sign — not that two signatures are needed."
                rows={assignedCentral}
                effective={effective}
                isDirty={isDirty}
                onPick={(k, v) => setPending(p => ({ ...p, [k]: v }))}
              />
            )}

            {storeOnly.length > 0 && (
              <div className="bg-white border border-[#E8D5C4] rounded-2xl overflow-hidden">
                <button
                  onClick={() => setShowStoreOnly(v => !v)}
                  className="w-full flex items-center justify-between gap-2 px-3.5 py-3 text-left hover:bg-[#FFF1E3]"
                >
                  <span className="min-w-0">
                    <span className="text-sm font-bold flex items-center gap-1.5"><Wine className="w-4 h-4 text-[#8B7355]" />
                      Liquor / store-ledger categories ({nf(storeOnly.length)})
                    </span>
                    <span className="block text-[11px] text-[#8B7355] mt-0.5">
                      Store-mapped to the TGBCL ledger. These can never reach a central goods receipt, so a checker set
                      here would never fire. Shown for completeness.
                    </span>
                  </span>
                  <span className="text-xs text-[#af4408] font-medium shrink-0">{showStoreOnly ? 'Hide' : 'Show'}</span>
                </button>
                {showStoreOnly && (
                  <div className="border-t border-[#E8D5C4]">
                    {storeOnly.map(r => (
                      <div key={r.category_key} className="flex items-center justify-between gap-3 px-3.5 py-2.5 border-b border-[#E8D5C4]/50 last:border-b-0">
                        <div className="min-w-0">
                          <p className="text-sm text-[#6B5744] truncate">{categoryLabel(r.category)}</p>
                          <p className="text-[10px] text-[#8B7355]">{nf(r.material_count)} material{r.material_count === 1 ? '' : 's'}</p>
                        </div>
                        <span className="text-[10px] text-[#8B7355] shrink-0">Not gateable</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {filtered.length === 0 && (
              <p className="text-sm text-[#8B7355] text-center py-8">
                No category matches “{search.trim()}”.
              </p>
            )}
          </div>
        )}

        {/* ── Alerts: how long before it escalates, and the (dark) WhatsApp rail ── */}
        {data && (
          <div className="bg-white border border-[#E8D5C4] rounded-2xl p-3.5 shadow-sm space-y-3">
            <p className="text-[10px] uppercase tracking-wider text-[#8B7355] font-semibold flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" />When a delivery waits too long
            </p>

            <div className="flex flex-wrap items-end gap-3">
              <label className="min-w-[150px]">
                <span className="block text-[11px] text-[#6B5744] mb-1">Escalate after (hours)</span>
                <input
                  type="number"
                  min={1}
                  max={168}
                  step={1}
                  value={hours}
                  onChange={e => setHours(e.target.value)}
                  className="w-full px-3 py-2 border border-[#E8D5C4] rounded-xl bg-[#FFF8F0] text-sm"
                />
              </label>
              <p className="text-[11px] text-[#8B7355] flex-1 min-w-[200px] leading-snug">
                Past this, the receipt is flagged <b>overdue</b> on the queue and the head chefs and admins are pinged
                once. 1 to 168 hours.
              </p>
            </div>

            <div className="border-t border-[#E8D5C4]/60 pt-3 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium flex items-center gap-1.5">
                    <MessageSquare className="w-4 h-4 text-[#8B7355]" />WhatsApp the head chef too
                  </p>
                  <p className="text-[11px] text-[#8B7355] mt-0.5 leading-snug">
                    Off by default. The in-app bell and this queue are the channels that work today; this rail needs an
                    approved template and the app-wide WhatsApp switch in{' '}
                    <Link href="/settings/integrations/whatsapp" className="underline">Settings → WhatsApp</Link> before
                    anything is delivered. Setting key: <code className="text-[10px]">{data.wa_key}</code>.
                  </p>
                </div>
                <Toggle checked={waOn} onChange={setWaOn} label="WhatsApp alerts for pending quality checks" />
              </div>
              <label className="block">
                <span className="block text-[11px] text-[#6B5744] mb-1">Send to (mobile numbers, comma separated — up to 10)</span>
                <input
                  value={waTo}
                  onChange={e => setWaTo(e.target.value)}
                  placeholder="98XXXXXXXX, 99XXXXXXXX"
                  className="w-full px-3 py-2 border border-[#E8D5C4] rounded-xl bg-[#FFF8F0] text-sm"
                />
              </label>
              <p className="text-[10px] text-[#8B7355] leading-snug">
                Numbers are typed here because no user account in this app carries a phone number — there is nothing to
                resolve a head chef to. This is the same recipient list every other WhatsApp event uses.
              </p>
            </div>

            <button
              onClick={saveAlerts}
              disabled={savingAlerts}
              className="px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-xl text-sm font-semibold
                         flex items-center gap-1.5 disabled:opacity-40"
            >
              {savingAlerts ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save alert settings
            </button>
          </div>
        )}

        <p className="text-[11px] text-[#8B7355] leading-snug">
          Changing a category here affects deliveries recorded <b>from now on</b>. A receipt already waiting keeps the
          checker it was held with, and one already inwarded is not revisited.
        </p>
      </div>

      {toast && (
        <div className="fixed inset-x-0 bottom-6 z-50 flex justify-center px-3 pointer-events-none">
          <div className={`pointer-events-auto max-w-lg w-full rounded-xl border px-3.5 py-3 shadow-lg text-sm flex items-start gap-2 ${
            toast.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-red-50 border-red-200 text-red-700'
          }`}>
            {toast.ok ? <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" /> : <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />}
            <p className="min-w-0 flex-1">{toast.msg}</p>
            <button onClick={() => setToast(null)} className="shrink-0 opacity-60 hover:opacity-100">
              <XCircle className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One block of category rows.
 *
 * ROWS, not a table: each carries a name, a count, a badge and a four-way
 * dropdown, and a table of that on a phone means a sideways scroll to reach the
 * control. Rows keep the server's order (most materials first), and are NOT
 * re-sorted as they are edited — a row that jumps groups the moment it is set is
 * how an admin edits the wrong category next. The heading counts move on save.
 */
function Group({ title, note, tone, rows, effective, isDirty, onPick }: {
  title: string;
  note: string;
  tone: 'amber' | 'plain';
  rows: CategoryRow[];
  effective: (r: CategoryRow) => Checker;
  isDirty: (r: CategoryRow) => boolean;
  onPick: (categoryKey: string, checker: Checker) => void;
}) {
  return (
    <div className={`rounded-2xl border overflow-hidden ${tone === 'amber' ? 'border-amber-200 bg-amber-50/40' : 'border-[#E8D5C4] bg-white'}`}>
      <div className={`px-3.5 py-2.5 ${tone === 'amber' ? 'bg-amber-50' : 'bg-[#FFF1E3]'}`}>
        <p className={`text-sm font-bold flex items-center gap-1.5 ${tone === 'amber' ? 'text-amber-900' : 'text-[#2D1B0E]'}`}>
          {tone === 'amber' ? <AlertTriangle className="w-4 h-4" /> : <Package className="w-4 h-4 text-[#8B7355]" />}
          {title} ({rows.length})
        </p>
        <p className={`text-[11px] mt-0.5 leading-snug ${tone === 'amber' ? 'text-amber-800' : 'text-[#8B7355]'}`}>{note}</p>
      </div>
      <div className="bg-white">
        {rows.map(r => {
          const val = effective(r);
          const dirty = isDirty(r);
          return (
            <div
              key={r.category_key}
              className={`flex flex-wrap items-center gap-2 px-3.5 py-2.5 border-b border-[#E8D5C4]/50 last:border-b-0 ${
                dirty ? 'bg-[#FFF1E3]' : ''
              }`}
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate flex items-center gap-1.5">
                  {categoryLabel(r.category)}
                  {dirty && <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#af4408] text-white font-semibold">unsaved</span>}
                </p>
                <p className="text-[10px] text-[#8B7355] flex items-center gap-1.5 flex-wrap">
                  <span>{nf(r.material_count)} material{r.material_count === 1 ? '' : 's'}</span>
                  {!dirty && r.assigned && <CheckerBadge checker={r.checker} />}
                  {r.assigned && r.updated_by && (
                    <span className="text-[#B8A590]">set by {r.updated_by}{r.updated_at ? ` · ${istWhen(r.updated_at)}` : ''}</span>
                  )}
                </p>
              </div>
              <select
                value={val}
                onChange={e => onPick(r.category_key, e.target.value as Checker)}
                className={`px-2.5 py-2 border rounded-xl text-sm bg-[#FFF8F0] min-w-[136px] ${
                  dirty ? 'border-[#af4408]' : 'border-[#E8D5C4]'
                }`}
              >
                {CHECKER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          );
        })}
      </div>
    </div>
  );
}
