'use client';

/**
 * HR — Employee Assets (Phase 6, mgmtOnly via page-catalog; the APIs are the
 * boundary).
 *
 * Contract: docs/HRMS_DECISIONS.md. hr_asset_history is an APPEND-ONLY
 * movement ledger — every action here goes through PATCH /api/hr/assets so
 * the transition and its ledger row land in one server-side transaction;
 * nothing on this page (or the API) deletes or rewrites a movement. Status
 * chips render the hr.ts vocabulary; kinds render as plain labels.
 *
 * Actions are contextual to the physical flow (issue from store, return /
 * damaged / lost while issued, repaired back to store) with an employee
 * Combobox on issue and a REQUIRED note on every action — the ledger is only
 * as good as its notes. The History drawer shows the full per-asset
 * timeline, newest first.
 *
 * Structure copied from the canonical HR list page
 * (src/app/hr/employees/page.tsx): race-guarded fetches, house filter card,
 * house safe-modal shell, portaled Combobox for dropdowns in modals.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Package,
  Plus,
  Search,
  X,
  Loader2,
  Save,
  ChevronLeft,
  ChevronRight,
  History,
} from 'lucide-react';
import { apiJson } from '@/lib/api';
import { fmtIST, fmtISTShort } from '@/lib/format-date';
import Combobox, { type ComboOption } from '@/components/Combobox';
import TabScroller from '@/components/TabScroller';
import {
  HR_ASSET_STATUSES,
  HR_ASSET_KINDS,
  assetStatusMeta,
  assetKindMeta,
  type HrAsset,
  type HrAssetHistory,
} from '@/lib/hr';

const PAGE_SIZE = 25;

/* ------------------------------------------------------------------ *
 * Row shapes + local action vocab
 * ------------------------------------------------------------------ */

/** GET /api/hr/assets list row: a.* LEFT JOINed to the holder's names —
 *  a dangling employee_id degrades to blank, never drops the asset. */
interface AssetRow extends HrAsset {
  holder_name: string | null;
  holder_code: string | null;
}

/** GET /api/hr/assets?id= history row (ledger + the mover's names). */
interface HistRow extends HrAssetHistory {
  employee_name: string | null;
  employee_code: string | null;
}

/** The slice of GET /api/hr/employees rows the issue picker needs. */
interface EmpRow {
  id: string;
  employee_code: string;
  full_name: string;
}

/** PATCH actions the API accepts (mirrors the route's TRANSITIONS map). */
type AssetAction = 'issue' | 'return' | 'damaged' | 'lost' | 'repaired';

const ACTION_META: Record<AssetAction, { label: string; title: string; hint: string }> = {
  issue: { label: 'Issue', title: 'Issue asset', hint: 'Hands the asset to an employee.' },
  return: { label: 'Return', title: 'Return asset', hint: 'Takes the asset back into store from its holder.' },
  damaged: { label: 'Damaged', title: 'Mark damaged', hint: 'Records damage — the holder stays accountable.' },
  lost: { label: 'Lost', title: 'Mark lost', hint: 'Records the loss — the holder stays accountable.' },
  repaired: { label: 'Repaired', title: 'Mark repaired', hint: 'Puts the asset back in store, ready to issue.' },
};

/** Which actions make physical sense from each status (the API re-guards). */
function actionsFor(status: string): AssetAction[] {
  switch (status) {
    case 'issued': return ['return', 'damaged', 'lost'];
    case 'damaged': return ['repaired', 'lost'];
    case 'lost': return ['repaired'];
    default: return ['issue']; // in_store, returned, anything unknown
  }
}

/** Ledger action → badge classes (history actions, not asset statuses). */
const HISTORY_COLORS: Record<string, string> = {
  issued: 'bg-blue-100 text-blue-700 border-blue-200',
  returned: 'bg-teal-100 text-teal-700 border-teal-200',
  damaged: 'bg-orange-100 text-orange-700 border-orange-200',
  lost: 'bg-rose-100 text-rose-700 border-rose-200',
  repaired: 'bg-green-100 text-green-700 border-green-200',
};

/** Humanize a ledger action key ('issued' → 'Issued'). */
function historyLabel(action: string): string {
  return action ? action.charAt(0).toUpperCase() + action.slice(1) : '—';
}

/** Map thrown fetch errors to venue-friendly copy (server messages are generic). */
function niceErr(e: unknown, fallback: string): string {
  const msg = e instanceof Error ? e.message : '';
  if (/403|forbidden/i.test(msg)) return 'You do not have permission for this action.';
  if (/401|unauthor/i.test(msg)) return 'Your session has expired — sign in again.';
  return msg && !/^HTTP \d+$/.test(msg) ? msg : fallback;
}

const inputCls = 'w-full px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm';

export default function HrAssetsPage() {
  /* ── List state ─────────────────────────────────────────────────────── */
  const [rows, setRows] = useState<AssetRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);   // first paint only
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* ── Filters ────────────────────────────────────────────────────────── */
  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');           // debounced searchInput
  const [statusFilter, setStatusFilter] = useState('');
  const [kindFilter, setKindFilter] = useState('');

  // Race guard: a stale response must never overwrite a newer one.
  const fetchSeq = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setQ(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => { setPage(1); }, [q, statusFilter, kindFilter]);

  const fetchAssets = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setFetching(true);
    setError(null);
    try {
      const sp = new URLSearchParams();
      if (q) sp.set('q', q);
      if (statusFilter) sp.set('status', statusFilter);
      if (kindFilter) sp.set('kind', kindFilter);
      sp.set('page', String(page));
      sp.set('pageSize', String(PAGE_SIZE));
      const res = await fetch(`/api/hr/assets?${sp.toString()}`);
      if (seq !== fetchSeq.current) return;
      if (!res.ok) {
        setError(res.status === 401 || res.status === 403
          ? 'You need management access to view the asset register.'
          : "Couldn't load assets");
        return;
      }
      const json = await res.json();
      if (seq !== fetchSeq.current) return;
      setRows(Array.isArray(json?.rows) ? json.rows : []);
      setTotal(Number(json?.total) || 0);
    } catch {
      if (seq === fetchSeq.current) setError("Couldn't load assets");
    } finally {
      if (seq === fetchSeq.current) { setFetching(false); setLoading(false); }
    }
  }, [q, statusFilter, kindFilter, page]);

  useEffect(() => { fetchAssets(); }, [fetchAssets]);

  /* ── Employee picker data (issue modal) ─────────────────────────────── */
  const [employees, setEmployees] = useState<EmpRow[]>([]);
  useEffect(() => {
    fetch('/api/hr/employees?pageSize=100')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(j => setEmployees(Array.isArray(j?.rows) ? j.rows : []))
      .catch(() => {});
  }, []);
  const empById = useMemo(() => new Map(employees.map(e => [e.id, e])), [employees]);
  const empOptions = useMemo<ComboOption[]>(
    () => employees.map(e => ({ value: e.id, label: e.full_name, hint: e.employee_code })),
    [employees],
  );

  const kindFilterOptions = useMemo<ComboOption[]>(
    () => [{ value: '', label: 'All kinds' }, ...HR_ASSET_KINDS.map(k => ({ value: k.key, label: k.label }))],
    [],
  );

  /* ── Create modal ───────────────────────────────────────────────────── */
  const [showCreate, setShowCreate] = useState(false);
  const [cName, setCName] = useState('');
  const [cKind, setCKind] = useState('');
  const [cTag, setCTag] = useState('');
  const [cNote, setCNote] = useState('');
  const [cSaving, setCSaving] = useState(false);
  const [cError, setCError] = useState<string | null>(null);

  const openCreate = () => {
    setCName(''); setCKind(''); setCTag(''); setCNote('');
    setCError(null);
    setShowCreate(true);
  };

  const saveCreate = async () => {
    if (!cName.trim()) { setCError('Asset name is required.'); return; }
    setCSaving(true);
    setCError(null);
    try {
      await apiJson('/api/hr/assets', {
        method: 'POST',
        body: { name: cName.trim(), kind: cKind, tag: cTag.trim(), note: cNote.trim() },
      });
      setShowCreate(false);
      fetchAssets();
    } catch (e) {
      setCError(niceErr(e, "Couldn't create the asset"));
    } finally {
      setCSaving(false);
    }
  };

  /* ── Action modal (issue / return / damaged / lost / repaired) ──────── */
  const [actionAsset, setActionAsset] = useState<AssetRow | null>(null);
  const [actionType, setActionType] = useState<AssetAction | null>(null);
  const [actEmp, setActEmp] = useState('');
  const [actNote, setActNote] = useState('');
  const [actSaving, setActSaving] = useState(false);
  const [actError, setActError] = useState<string | null>(null);

  const openAction = (asset: AssetRow, action: AssetAction) => {
    setActionAsset(asset);
    setActionType(action);
    setActEmp('');
    setActNote('');
    setActError(null);
  };
  const closeAction = () => { setActionAsset(null); setActionType(null); };

  const saveAction = async () => {
    if (!actionAsset || !actionType) return;
    if (actionType === 'issue' && !actEmp) {
      setActError('Pick the employee receiving this asset.');
      return;
    }
    if (!actNote.trim()) {
      setActError('A note is required — it becomes the ledger entry.');
      return;
    }
    setActSaving(true);
    setActError(null);
    try {
      await apiJson('/api/hr/assets', {
        method: 'PATCH',
        body: {
          id: actionAsset.id,
          action: actionType,
          ...(actEmp ? { employee_id: actEmp } : {}),
          note: actNote.trim(),
        },
      });
      const affectedId = actionAsset.id;
      closeAction();
      fetchAssets();
      if (drawerId === affectedId) openHistory(affectedId);
    } catch (e) {
      setActError(niceErr(e, "Couldn't update the asset"));
    } finally {
      setActSaving(false);
    }
  };

  /* ── History drawer ─────────────────────────────────────────────────── */
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [drawerAsset, setDrawerAsset] = useState<AssetRow | null>(null);
  const [drawerHistory, setDrawerHistory] = useState<HistRow[]>([]);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [drawerError, setDrawerError] = useState<string | null>(null);

  const openHistory = useCallback(async (id: string) => {
    setDrawerId(id);
    setDrawerLoading(true);
    setDrawerError(null);
    try {
      const res = await fetch(`/api/hr/assets?id=${encodeURIComponent(id)}`);
      if (!res.ok) {
        setDrawerError("Couldn't load the asset history");
        return;
      }
      const j = await res.json();
      setDrawerAsset(j?.asset ?? null);
      setDrawerHistory(Array.isArray(j?.history) ? j.history : []);
    } catch {
      setDrawerError("Couldn't load the asset history");
    } finally {
      setDrawerLoading(false);
    }
  }, []);

  const closeDrawer = () => {
    setDrawerId(null);
    setDrawerAsset(null);
    setDrawerHistory([]);
    setDrawerError(null);
  };

  /* ── Pagination derived ─────────────────────────────────────────────── */
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const fromN = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const toN = Math.min(page * PAGE_SIZE, total);

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">

        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-2">
              <Package className="w-6 h-6" /> Employee Assets
            </h1>
            <p className="text-[#8B7355] text-sm mt-1">
              Asset register{loading ? '' : ` — ${total} asset${total === 1 ? '' : 's'}`}. Uniforms, devices, keys —
              every movement lands in the append-only ledger.
            </p>
          </div>
          <button onClick={openCreate}
                  className="inline-flex items-center gap-2 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium">
            <Plus className="w-4 h-4" /> Add Asset
          </button>
        </div>

        {/* Filters */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-3 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 flex-1 min-w-[200px]">
              <Search className="w-4 h-4 text-[#8B7355]" />
              <input value={searchInput} onChange={e => setSearchInput(e.target.value)}
                     placeholder="Name or tag…"
                     className="flex-1 px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
            </div>
            <div className="w-full sm:w-56">
              <Combobox
                options={kindFilterOptions}
                value={kindFilter ? assetKindMeta(kindFilter).label : ''}
                onChange={v => setKindFilter(v)}
                placeholder="All kinds"
              />
            </div>
          </div>
          <TabScroller className="gap-2">
            <button onClick={() => setStatusFilter('')}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium border ${
                      statusFilter === ''
                        ? 'bg-[#af4408] text-white border-[#af4408]'
                        : 'bg-white text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3]'
                    }`}>
              All
            </button>
            {HR_ASSET_STATUSES.map(s => (
              <button key={s.key} onClick={() => setStatusFilter(prev => (prev === s.key ? '' : s.key))}
                      className={`px-3 py-1.5 rounded-full text-xs font-medium border ${
                        statusFilter === s.key
                          ? 'bg-[#af4408] text-white border-[#af4408]'
                          : 'bg-white text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3]'
                      }`}>
                {s.label}
              </button>
            ))}
          </TabScroller>
        </div>

        {/* Error banner */}
        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm flex items-center justify-between gap-3">
            <span>{error}</span>
            <button onClick={() => fetchAssets()}
                    className="shrink-0 px-3 py-1.5 border border-red-200 rounded-lg text-xs font-medium hover:bg-red-100">
              Retry
            </button>
          </div>
        )}

        {/* Table */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
          {loading ? (
            <div className="p-6 flex items-center justify-center gap-2 text-[#8B7355] text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading...
            </div>
          ) : rows.length === 0 ? (
            <div className="p-6 text-center text-[#8B7355] text-sm">
              {q || statusFilter || kindFilter ? 'No assets match these filters.' : 'No assets yet — add the first one.'}
            </div>
          ) : (
            <>
              <div className={`overflow-x-auto ${fetching ? 'opacity-60' : ''}`}>
                <table className="w-full text-sm">
                  <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                    <tr>
                      <th className="text-left py-2 px-3 font-medium">Asset</th>
                      <th className="text-left py-2 px-3 font-medium">Kind</th>
                      <th className="text-left py-2 px-3 font-medium">Status</th>
                      <th className="text-left py-2 px-3 font-medium">Holder</th>
                      <th className="text-left py-2 px-3 font-medium">Updated</th>
                      <th className="text-left py-2 px-3 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => {
                      const sm = assetStatusMeta(r.status);
                      return (
                        <tr key={r.id} className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3]">
                          <td className="py-2 px-3">
                            <div className="font-bold">{r.name}</div>
                            {r.tag && <div className="text-[10px] font-mono text-[#8B7355]">{r.tag}</div>}
                          </td>
                          <td className="py-2 px-3 text-xs">
                            {r.kind ? assetKindMeta(r.kind).label : <span className="text-[#8B7355]">—</span>}
                          </td>
                          <td className="py-2 px-3">
                            <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border ${sm.color}`}>
                              {sm.label}
                            </span>
                          </td>
                          <td className="py-2 px-3 text-xs">
                            {r.employee_id ? (
                              <>
                                {r.holder_name || <span className="text-[#8B7355]">(unknown employee)</span>}
                                {r.holder_code && (
                                  <div className="text-[10px] font-mono text-[#8B7355]">{r.holder_code}</div>
                                )}
                              </>
                            ) : (
                              <span className="text-[#8B7355]">—</span>
                            )}
                          </td>
                          <td className="py-2 px-3 text-xs whitespace-nowrap">{fmtISTShort(r.updated_at)}</td>
                          <td className="py-2 px-3">
                            <div className="flex flex-wrap items-center gap-1.5">
                              {actionsFor(r.status).map(a => (
                                <button key={a} onClick={() => openAction(r, a)} title={ACTION_META[a].title}
                                        className={`px-2 py-1 rounded-lg text-[11px] font-medium border ${
                                          a === 'issue'
                                            ? 'text-[#af4408] border-[#af4408]/40 hover:bg-[#FFF1E3]'
                                            : 'text-[#6B5744] border-[#E8D5C4] hover:bg-[#FFF1E3]'
                                        }`}>
                                  {ACTION_META[a].label}
                                </button>
                              ))}
                              <button onClick={() => openHistory(r.id)} title="Movement history"
                                      className="p-1.5 border border-[#E8D5C4] rounded-lg text-[#6B5744] hover:bg-[#FFF1E3]">
                                <History className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="px-3 py-2 border-t border-[#E8D5C4] flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-[#8B7355]">Showing {fromN}–{toN} of {total}</span>
                <div className="flex items-center gap-2">
                  <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1 || fetching}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-[#E8D5C4] bg-white hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-xs font-medium disabled:opacity-40">
                    <ChevronLeft className="w-3.5 h-3.5" /> Prev
                  </button>
                  <span className="text-xs text-[#6B5744]">Page {page} of {pageCount}</span>
                  <button onClick={() => setPage(p => Math.min(pageCount, p + 1))} disabled={page >= pageCount || fetching}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-[#E8D5C4] bg-white hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-xs font-medium disabled:opacity-40">
                    Next <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Create modal — house safe-modal shell */}
        {showCreate && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
            <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
                 className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-md shadow-xl flex flex-col overflow-hidden">
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <h2 className="font-bold text-[#2D1B0E]">Add Asset</h2>
                <button onClick={() => { if (!cSaving) setShowCreate(false); }} className="text-[#8B7355]">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
                {cError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">
                    {cError}
                  </div>
                )}
                <div>
                  <label className="text-xs text-[#6B5744]">Name *</label>
                  <input value={cName} onChange={e => setCName(e.target.value)}
                         placeholder="e.g. Chef coat (L)" className={inputCls} autoFocus />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-[#6B5744]">Kind</label>
                    <select value={cKind} onChange={e => setCKind(e.target.value)} className={inputCls}>
                      <option value="">—</option>
                      {HR_ASSET_KINDS.map(k => (
                        <option key={k.key} value={k.key}>{k.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-[#6B5744]">Tag / serial</label>
                    <input value={cTag} onChange={e => setCTag(e.target.value)}
                           placeholder="e.g. AST-0042" className={inputCls} />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-[#6B5744]">Note</label>
                  <textarea value={cNote} onChange={e => setCNote(e.target.value)} rows={2}
                            placeholder="Condition, purchase detail… (optional)" className={inputCls} />
                </div>
                <p className="text-[11px] text-[#8B7355]">
                  New assets start in store, unissued — issue is a separate action so it always lands in the ledger.
                </p>
              </div>
              <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
                <button onClick={() => setShowCreate(false)} disabled={cSaving}
                        className="px-3 py-2 text-sm text-[#6B5744] disabled:opacity-50">
                  Cancel
                </button>
                <button onClick={saveCreate} disabled={cSaving}
                        className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
                  {cSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Action modal — house safe-modal shell */}
        {actionAsset && actionType && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
            <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
                 className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-md shadow-xl flex flex-col overflow-hidden">
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <h2 className="font-bold text-[#2D1B0E]">{ACTION_META[actionType].title}</h2>
                <button onClick={() => { if (!actSaving) closeAction(); }} className="text-[#8B7355]">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
                {actError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">
                    {actError}
                  </div>
                )}
                <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] px-3 py-2 text-sm">
                  <div className="font-bold">{actionAsset.name}</div>
                  <div className="text-xs text-[#8B7355]">
                    {actionAsset.kind ? assetKindMeta(actionAsset.kind).label : 'No kind'}
                    {actionAsset.tag ? ` · ${actionAsset.tag}` : ''}
                    {actionAsset.employee_id && actionAsset.holder_name
                      ? ` · with ${actionAsset.holder_name}`
                      : ''}
                  </div>
                </div>
                <p className="text-xs text-[#8B7355]">{ACTION_META[actionType].hint}</p>
                {actionType === 'issue' && (
                  <div>
                    <label className="text-xs text-[#6B5744]">Issue to *</label>
                    <Combobox
                      options={empOptions}
                      value={actEmp ? (empById.get(actEmp)?.full_name || '') : ''}
                      onChange={v => setActEmp(v)}
                      placeholder="Pick employee"
                    />
                  </div>
                )}
                <div>
                  <label className="text-xs text-[#6B5744]">Note *</label>
                  <textarea value={actNote} onChange={e => setActNote(e.target.value)} rows={2}
                            placeholder="Why / condition — this becomes the ledger entry"
                            className={inputCls} />
                </div>
              </div>
              <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
                <button onClick={closeAction} disabled={actSaving}
                        className="px-3 py-2 text-sm text-[#6B5744] disabled:opacity-50">
                  Cancel
                </button>
                <button onClick={saveAction} disabled={actSaving}
                        className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
                  {actSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} {ACTION_META[actionType].label}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* History drawer — right-hand overlay panel */}
        {drawerId && (
          <div className="fixed inset-0 z-50 bg-black/40 flex justify-end" onClick={closeDrawer}>
            <div className="bg-white w-full max-w-md h-full shadow-xl border-l border-[#E8D5C4] flex flex-col"
                 onClick={e => e.stopPropagation()}>
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <h2 className="font-bold text-[#2D1B0E] flex items-center gap-2">
                  <History className="w-4 h-4 text-[#af4408]" /> Asset History
                </h2>
                <button onClick={closeDrawer} className="text-[#8B7355]">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
                {drawerLoading ? (
                  <div className="p-4 flex items-center justify-center gap-2 text-[#8B7355] text-sm">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading...
                  </div>
                ) : drawerError ? (
                  <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm flex items-center justify-between gap-3">
                    <span>{drawerError}</span>
                    <button onClick={() => openHistory(drawerId)}
                            className="shrink-0 px-3 py-1.5 border border-red-200 rounded-lg text-xs font-medium hover:bg-red-100">
                      Retry
                    </button>
                  </div>
                ) : (
                  <>
                    {drawerAsset && (
                      <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] px-3 py-2.5 space-y-1">
                        <div className="font-bold text-[#2D1B0E]">{drawerAsset.name}</div>
                        <div className="text-xs text-[#8B7355]">
                          {drawerAsset.kind ? assetKindMeta(drawerAsset.kind).label : 'No kind'}
                          {drawerAsset.tag ? ` · ${drawerAsset.tag}` : ''}
                        </div>
                        <div className="flex flex-wrap items-center gap-2 pt-1">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border ${assetStatusMeta(drawerAsset.status).color}`}>
                            {assetStatusMeta(drawerAsset.status).label}
                          </span>
                          {drawerAsset.employee_id && (
                            <span className="text-xs text-[#6B5744]">
                              with {drawerAsset.holder_name || '(unknown employee)'}
                              {drawerAsset.holder_code ? ` (${drawerAsset.holder_code})` : ''}
                            </span>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="text-xs font-semibold text-[#8B7355] uppercase tracking-wide">
                      Movements — newest first
                    </div>
                    {drawerHistory.length === 0 ? (
                      <div className="text-sm text-[#8B7355]">No movements recorded yet.</div>
                    ) : (
                      <ul className="space-y-3">
                        {drawerHistory.map(h => (
                          <li key={h.id} className="flex gap-3">
                            <div className="pt-1.5 shrink-0">
                              <div className="w-2 h-2 rounded-full bg-[#af4408]" />
                            </div>
                            <div className="min-w-0 flex-1 border-b border-[#E8D5C4]/60 pb-3">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border ${
                                  HISTORY_COLORS[h.action] || 'bg-slate-100 text-slate-600 border-slate-200'
                                }`}>
                                  {historyLabel(h.action)}
                                </span>
                                {h.employee_id && (
                                  <span className="text-xs text-[#2D1B0E] font-medium">
                                    {h.employee_name || '(unknown employee)'}
                                    {h.employee_code ? (
                                      <span className="text-[#8B7355] font-normal"> ({h.employee_code})</span>
                                    ) : null}
                                  </span>
                                )}
                              </div>
                              {h.note && <div className="text-xs text-[#6B5744] mt-1">{h.note}</div>}
                              <div className="text-[10px] text-[#8B7355] mt-1">
                                {fmtIST(h.at)}{h.acted_by ? ` · by ${h.acted_by}` : ''}
                              </div>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
