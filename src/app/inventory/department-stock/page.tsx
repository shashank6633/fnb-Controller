'use client';

/**
 * Department Stock — computed per-department balance (no table behind it):
 *   Est. on hand = last closing count + store issues since that count.
 *
 * Kitchen/bar usage between counts only reflects after the NEXT closing count,
 * so this is an estimate, clearly footnoted as such. Materials never counted
 * show only "received in the last 30 days" with a "not counted yet" chip —
 * never presented as a true balance.
 *
 * DISPLAY convention (app-wide): quantities in PURCHASE units = recipe ÷ pack
 * (same as StaffCatalogPicker stockInPU).
 */

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Boxes, Loader2, Search, Warehouse } from 'lucide-react';
import TabScroller from '@/components/TabScroller';

interface Row {
  material_id: string; name: string; category: string; unit: string;
  purchase_unit: string; pack_size: number; average_price: number;
  last_count: number | null; last_count_date: string | null;
  issued_since: number; on_hand_est: number; never_counted: boolean;
  last_issue_at: string | null; est_value: number;
}
interface Summary { items: number; est_value: number; never_counted_count: number; }
interface Department { id: string; name: string; code?: string; parent_id?: string | null; area?: string; is_active?: number; }

const inr = (v: number) => '₹' + Math.round(v || 0).toLocaleString('en-IN');
/** Recipe-units per purchase unit — same convention as StaffCatalogPicker. */
const packFactor = (r: Row) =>
  (r.purchase_unit && r.purchase_unit !== r.unit && (Number(r.pack_size) || 1) > 1) ? Number(r.pack_size) : 1;
const inPU = (r: Row, recipeQty: number) => {
  const v = recipeQty / packFactor(r);
  return v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
};
const puLabel = (r: Row) => r.purchase_unit || r.unit || '';

export default function DepartmentStockPage() {
  const [me, setMe] = useState<any>(null);
  useEffect(() => {
    fetch('/api/auth/me').then(r => r.json()).then(d => setMe(d?.user || null)).catch(() => {});
  }, []);
  // Same predicate as the closing-stock page canSeeAllDepts / the API's
  // canSeeAllDeptStock — privileged viewers get the department picker.
  const canSeeAllDepts = !!me && (me.role === 'admin' || me.role === 'manager' || !!me.is_head_chef || !!me.is_store_manager);
  const ownDeptId: string | null = me?.department_id || null;
  const visibleDeptIds = useMemo<string[]>(() => {
    if (!me?.visible_department_ids) return [];
    try {
      const a = JSON.parse(me.visible_department_ids);
      return Array.isArray(a) ? a.map(String).filter(Boolean) : [];
    } catch { return []; }
  }, [me]);
  const hasDeptChoice = canSeeAllDepts || visibleDeptIds.length > 0;

  const [departments, setDepartments] = useState<Department[]>([]);
  const [selectedDept, setSelectedDept] = useState<string>('');
  useEffect(() => {
    if (!me) return;
    fetch('/api/departments').then(r => r.json()).then(d => {
      setDepartments((d?.departments || []).filter((x: any) => x.is_active));
    }).catch(() => {});
  }, [me]);
  const pickableDepts = useMemo(() => {
    if (canSeeAllDepts) return departments;
    const allow = new Set<string>([...visibleDeptIds, ...(ownDeptId ? [ownDeptId] : [])]);
    return departments.filter(d => allow.has(d.id));
  }, [departments, canSeeAllDepts, visibleDeptIds, ownDeptId]);
  // Default: own department, else the first pickable one. Sub-depts keep their
  // parent grouping in the picker labels (mains show a "(main)" suffix since a
  // main-dept view rolls up all its sub-departments).
  useEffect(() => {
    if (selectedDept || pickableDepts.length === 0) return;
    setSelectedDept(ownDeptId && pickableDepts.some(d => d.id === ownDeptId) ? ownDeptId : pickableDepts[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickableDepts, ownDeptId]);
  const activeDeptId = hasDeptChoice ? selectedDept : (ownDeptId || '');
  const byId = useMemo(() => new Map(departments.map(d => [d.id, d])), [departments]);
  const deptLabel = (d: Department) => {
    if (!d.parent_id) return `${d.name} (main — incl. sub-depts)`;
    const parent = byId.get(d.parent_id);
    return parent ? `${d.name} · ${parent.name}` : d.name;
  };
  const ownDeptName = departments.find(d => d.id === ownDeptId)?.name || 'your department';

  const [rows, setRows] = useState<Row[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [deptName, setDeptName] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!activeDeptId) { setLoading(false); return; }
    setLoading(true); setError(null);
    fetch(`/api/department-stock?department_id=${encodeURIComponent(activeDeptId)}`)
      .then(async r => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        setRows(j.rows || []);
        setSummary(j.summary || null);
        setDeptName(j.department?.name || '');
      })
      .catch(e => { setRows([]); setSummary(null); setError(e.message); })
      .finally(() => setLoading(false));
  }, [activeDeptId]);

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.category) set.add(r.category);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [rows]);
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => {
      if (category && r.category !== category) return false;
      if (q && !r.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, search, category]);

  const neverChip = (
    <span className="inline-block px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[9px] font-semibold uppercase">
      not counted yet
    </span>
  );

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-4">
      <div className="flex items-center gap-3">
        <Warehouse className="w-7 h-7 text-[#af4408]" />
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-[#2D1B0E]">Department Stock</h1>
          <p className="text-xs text-[#6B5744]">
            Estimated on-hand per department — last closing count + store issues since.
          </p>
        </div>
      </div>

      {/* Department scope — picker for privileged users; pinned banner for staff. */}
      {me && (hasDeptChoice ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl px-4 py-3 flex items-center gap-3 flex-wrap">
          <span className="text-xs font-medium text-[#6B5744]">Department</span>
          <select value={selectedDept} onChange={e => setSelectedDept(e.target.value)}
                  className="px-2 py-1.5 border border-[#D4B896] rounded text-sm bg-white max-w-full">
            {pickableDepts.map(d => (
              <option key={d.id} value={d.id}>{deptLabel(d)}</option>
            ))}
          </select>
        </div>
      ) : (
        <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 text-xs text-amber-800">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>Showing stock for <strong>{ownDeptName}</strong> — your department.</span>
        </div>
      ))}

      {/* Summary cards */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div className="min-w-0 bg-white border border-[#E8D5C4] rounded-xl p-3 sm:p-4">
            <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">Items</div>
            <div className="text-xl sm:text-2xl font-semibold text-[#2D1B0E] mt-1 tabular-nums truncate">{summary.items}</div>
          </div>
          <div className="min-w-0 bg-white border border-amber-200 rounded-xl p-3 sm:p-4">
            <div className="text-[10px] uppercase tracking-wide text-amber-700">Not counted</div>
            <div className="text-xl sm:text-2xl font-semibold text-amber-800 mt-1 tabular-nums truncate">{summary.never_counted_count}</div>
          </div>
          <div className="min-w-0 col-span-2 sm:col-span-1 bg-white border border-[#E8D5C4] rounded-xl p-3 sm:p-4">
            <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">Est. value</div>
            <div className="text-lg sm:text-2xl font-semibold text-[#2D1B0E] mt-1 tabular-nums truncate">{inr(summary.est_value)}</div>
            {summary.never_counted_count > 0 && (
              <div className="text-[9px] text-amber-700 mt-0.5 leading-tight">
                incl. est. for {summary.never_counted_count} not-yet-counted item{summary.never_counted_count === 1 ? '' : 's'}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Search + category chips */}
      <div className="space-y-2">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8B7355]" />
          <input value={search} onChange={e => setSearch(e.target.value)}
                 placeholder="Search items…"
                 className="w-full pl-8 pr-3 py-2 border border-[#E8D5C4] rounded-lg bg-white text-sm" />
        </div>
        {categories.length > 0 && (
          <TabScroller className="gap-1 text-xs">
            {['', ...categories].map(c => (
              <button key={c || '__all__'} onClick={() => setCategory(c)}
                      className={`px-2.5 py-1 rounded whitespace-nowrap ${category === c
                        ? 'bg-[#af4408] text-white'
                        : 'bg-white border border-[#E8D5C4] text-[#6B5744] hover:border-[#af4408]'}`}>
                {c || 'All'}
              </button>
            ))}
          </TabScroller>
        )}
      </div>

      {error && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">{error}</div>
      )}

      {loading ? (
        <div className="p-8 text-center text-[#8B7355]">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…
        </div>
      ) : !error && rows.length === 0 ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center text-sm text-[#8B7355]">
          <Boxes className="w-8 h-8 mx-auto mb-2 opacity-50" />
          No items issued to or counted for this department yet — items appear once the store issues your requisitions or you record a closing count.
        </div>
      ) : !error && (
        <>
          {/* Mobile: cards */}
          <div className="md:hidden space-y-2">
            {visible.map(r => (
              <div key={r.material_id} className="bg-white border border-[#E8D5C4] rounded-lg p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[13px] font-bold text-[#2D1B0E] break-words">{r.name}</div>
                    <div className="text-[10px] text-[#8B7355]">{r.category || '—'}</div>
                  </div>
                  <div className="shrink-0 text-right">
                    {r.never_counted ? (
                      <>
                        <div className="text-sm font-bold text-amber-800">
                          Recd 30d: {inPU(r, r.on_hand_est)} {puLabel(r)}
                        </div>
                        {neverChip}
                      </>
                    ) : (
                      <div className="text-sm font-bold text-[#2D1B0E]">
                        {inPU(r, r.on_hand_est)} {puLabel(r)}
                      </div>
                    )}
                    <div className="text-[10px] text-[#6B5744]">{inr(r.est_value)}</div>
                  </div>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[10px] text-[#6B5744]">
                  <span>
                    Last counted: {r.never_counted
                      ? <span className="text-amber-700 font-semibold">Never</span>
                      : `${inPU(r, r.last_count || 0)} ${puLabel(r)} on ${r.last_count_date}`}
                  </span>
                  {!r.never_counted && (
                    <span>Received since: {inPU(r, r.issued_since)} {puLabel(r)}</span>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Desktop: table */}
          <div className="hidden md:block bg-white border border-[#E8D5C4] rounded-xl overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-[#8B7355] bg-[#FFF8F0]">
                <tr>
                  <th className="text-left  py-2 px-3 font-medium">Item</th>
                  <th className="text-left  py-2 px-3 font-medium">Category</th>
                  <th className="text-right py-2 px-3 font-medium">Last counted</th>
                  <th className="text-right py-2 px-3 font-medium">Received since</th>
                  <th className="text-right py-2 px-3 font-medium">Est. on hand</th>
                  <th className="text-right py-2 px-3 font-medium">Est. value</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(r => (
                  <tr key={r.material_id} className="border-t border-[#E8D5C4]/50">
                    <td className="py-1.5 px-3 font-medium text-[#2D1B0E]">{r.name}</td>
                    <td className="py-1.5 px-3 text-[10px] text-[#6B5744]">{r.category || '—'}</td>
                    <td className="py-1.5 px-3 text-right font-mono text-xs">
                      {r.never_counted ? (
                        <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[9px] font-semibold uppercase">Never</span>
                      ) : (
                        <>
                          {inPU(r, r.last_count || 0)} {puLabel(r)}
                          <span className="text-[#8B7355]"> · {r.last_count_date}</span>
                        </>
                      )}
                    </td>
                    <td className="py-1.5 px-3 text-right font-mono text-xs">
                      {r.never_counted ? (
                        <span className="text-[#B8A088]">—</span>
                      ) : (
                        <>{inPU(r, r.issued_since)} {puLabel(r)}</>
                      )}
                    </td>
                    <td className="py-1.5 px-3 text-right font-mono">
                      {r.never_counted ? (
                        <span className="text-amber-800">
                          Recd 30d: {inPU(r, r.on_hand_est)} {puLabel(r)} {neverChip}
                        </span>
                      ) : (
                        <span className="font-bold text-[#2D1B0E]">{inPU(r, r.on_hand_est)} {puLabel(r)}</span>
                      )}
                    </td>
                    <td className="py-1.5 px-3 text-right font-mono text-xs">{inr(r.est_value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {visible.length === 0 && rows.length > 0 && (
            <div className="text-center text-xs text-[#8B7355] py-4">
              No items match{search ? ` “${search}”` : ''}{category ? ` in ${category}` : ''}.
            </div>
          )}
        </>
      )}

      <p className="text-[10px] text-[#8B7355] leading-relaxed">
        Estimate = last closing count + store issues since. Kitchen/bar usage between counts
        reflects only after the next closing count. Party-event stock is tracked separately.
      </p>
    </div>
  );
}
