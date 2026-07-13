'use client';

/**
 * Department Consumption — analytics view answering "which department used how much
 * of each material" using the imported / live requisition_items data.
 *
 * Sections:
 *   1. Filter bar (date range, department, category, material)
 *   2. Summary stat cards
 *   3. Department leaderboard (sorted by ₹ value)
 *   4. Top materials (org-wide, with distinct-dept count)
 *   5. Department × Material matrix table — drillable
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Building2, Package, ArrowUpRight, Loader2, Download, Filter, ChevronDown, ChevronRight, Warehouse,
} from 'lucide-react';
import TabScroller from '@/components/TabScroller';

const fmt  = (v: number) => '₹' + Math.round(v || 0).toLocaleString('en-IN');
const fmt2 = (v: number) => (v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const todayIso = () => new Date().toISOString().slice(0, 10);
const isoMinusDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };

interface Department { id: string; name: string; code?: string; }
interface Material   { id: string; name: string; sku?: string; unit: string; category: string; average_price: number; }

export default function DepartmentConsumptionPage() {
  const [from, setFrom] = useState(isoMinusDays(30));
  const [to, setTo]     = useState(todayIso());
  const [departmentId, setDepartmentId] = useState('');
  const [category, setCategory] = useState('');
  const [materialId, setMaterialId] = useState('');

  const [departments, setDepartments] = useState<Department[]>([]);
  const [materials, setMaterials]     = useState<Material[]>([]);
  const [data, setData] = useState<any>(null);
  const [register, setRegister] = useState<any>(null);
  const [view, setView] = useState<'summary' | 'register'>('summary');
  const [loading, setLoading] = useState(false);

  const [expandedDept, setExpandedDept] = useState<string | null>(null);

  const reload = async () => {
    setLoading(true);
    const qs = new URLSearchParams({ from, to });
    if (departmentId) qs.set('department_id', departmentId);
    if (category)     qs.set('category', category);
    if (materialId)   qs.set('material_id', materialId);
    if (view === 'register') qs.set('view', 'register');
    const j = await fetch(`/api/department-consumption?${qs}`).then(r => r.json());
    if (view === 'register') setRegister(j); else setData(j);
    setLoading(false);
  };
  useEffect(() => {
    Promise.all([
      fetch('/api/departments').then(r => r.json()),
      fetch('/api/inventory').then(r => r.json()).catch(() => ({ materials: [] })),
    ]).then(([d, m]) => {
      setDepartments((d.departments || []).filter((x: any) => x.is_active));
      setMaterials(m.materials || []);
    });
  }, []);
  useEffect(() => { reload(); }, [from, to, departmentId, category, materialId, view]);

  const categories = useMemo(() => Array.from(new Set(materials.map(m => m.category))).sort(), [materials]);

  const matrixForDept = (deptId: string) =>
    (data?.by_department_material || []).filter((row: any) => row.department_id === deptId);

  const csvCell = (x: any) => { const s = String(x ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const downloadCsv = (name: string, lines: string[]) => {
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  const exportCsv = () => {
    if (view === 'register') {
      if (!register?.rows?.length) return;
      const lines = [['date','department','material','category','unit','qty','value','requisitions'].join(',')];
      for (const r of register.rows) {
        lines.push([r.date, r.department_name, r.material_name, r.category || '', r.unit, r.qty, r.value, r.req_count].map(csvCell).join(','));
      }
      downloadCsv(`materials-register-${from}_to_${to}.csv`, lines);
      return;
    }
    if (!data?.by_department_material?.length) return;
    const lines = [['department','material','sku','category','unit','qty','avg_price','value'].join(',')];
    for (const r of data.by_department_material) {
      const avg = r.qty > 0 ? r.value / r.qty : 0;
      lines.push([r.department_name, r.material_name, r.material_sku || '', r.category || '', r.material_unit,
                  r.qty, avg.toFixed(2), r.value].map(csvCell).join(','));
    }
    downloadCsv(`dept-consumption-${from}_to_${to}.csv`, lines);
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
            <Building2 className="w-6 h-6 text-[#af4408]" /> Department Consumption
          </h1>
          <p className="text-xs text-[#6B5744] mt-0.5">
            How much each department drew from main store. Sourced from issued requisitions (transfers + workflow).
            <span className="block italic">Audit / analytics only — not part of recipe-cost calculations.</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a href="/department-materials"
             className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm flex items-center gap-2">
            <Warehouse className="w-4 h-4" /> Dept Materials (Party)
          </a>
          <div className="inline-flex rounded-lg border border-[#E8D5C4] overflow-hidden text-sm">
            <button onClick={() => setView('summary')}
                    className={`px-3 py-2 ${view === 'summary' ? 'bg-[#af4408] text-white' : 'bg-white text-[#6B5744] hover:bg-[#FFF1E3]'}`}>Summary</button>
            <button onClick={() => setView('register')}
                    className={`px-3 py-2 border-l border-[#E8D5C4] ${view === 'register' ? 'bg-[#af4408] text-white' : 'bg-white text-[#6B5744] hover:bg-[#FFF1E3]'}`}>Date register</button>
          </div>
          <button onClick={exportCsv} disabled={view === 'register' ? !register?.rows?.length : !data?.by_department_material?.length}
                  className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm flex items-center gap-2 disabled:opacity-50">
            <Download className="w-4 h-4" /> Export CSV
          </button>
        </div>
      </div>

      {/* Filter bar — one-row sideways scroller on phones (the Material select's
          intrinsic width can exceed the viewport); wraps as before on md+. */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 text-xs">
      <TabScroller className="gap-2 items-end">
        <div className="inline-flex items-center gap-1 text-[#6B5744]">
          <Filter className="w-3.5 h-3.5" /> Filter
        </div>
        <label className="flex flex-col text-[#6B5744]">
          From
          <input type="date" value={from} onChange={e => setFrom(e.target.value)}
                 className="px-2 py-1 border border-[#E8D5C4] rounded bg-[#FFF8F0]" />
        </label>
        <label className="flex flex-col text-[#6B5744]">
          To
          <input type="date" value={to} onChange={e => setTo(e.target.value)}
                 className="px-2 py-1 border border-[#E8D5C4] rounded bg-[#FFF8F0]" />
        </label>
        <label className="flex flex-col text-[#6B5744]">
          Department
          <select value={departmentId} onChange={e => setDepartmentId(e.target.value)}
                  className="px-2 py-1 border border-[#E8D5C4] rounded bg-[#FFF8F0] min-w-[180px]">
            <option value="">All</option>
            {departments.map(d => <option key={d.id} value={d.id}>{d.code ? `[${d.code}] ` : ''}{d.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col text-[#6B5744]">
          Category
          <select value={category} onChange={e => setCategory(e.target.value)}
                  className="px-2 py-1 border border-[#E8D5C4] rounded bg-[#FFF8F0] min-w-[150px]">
            <option value="">All</option>
            {categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="flex flex-col text-[#6B5744]">
          Material
          <select value={materialId} onChange={e => setMaterialId(e.target.value)}
                  className="px-2 py-1 border border-[#E8D5C4] rounded bg-[#FFF8F0] min-w-[200px]">
            <option value="">All</option>
            {materials.map(m => <option key={m.id} value={m.id}>{m.sku ? `${m.sku} — ` : ''}{m.name}</option>)}
          </select>
        </label>
        {(departmentId || category || materialId) && (
          <button onClick={() => { setDepartmentId(''); setCategory(''); setMaterialId(''); }}
                  className="px-2 py-1 text-[#af4408] hover:underline">Clear</button>
        )}
      </TabScroller>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-xs text-[#8B7355]">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      )}

      {view === 'summary' && data?.summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Total Value Issued" value={fmt(data.summary.total_value)} hint="Σ qty × avg price" />
          <Stat label="Total Qty Lines" value={data.summary.materials.toLocaleString('en-IN') + ' materials'}
                hint={`across ${data.summary.departments} dept(s)`} />
          <Stat label="Requisitions" value={data.summary.requisition_count.toLocaleString('en-IN')} />
          <Stat label="Date Range" value={`${data.range.from} → ${data.range.to}`} />
        </div>
      )}

      {/* Department leaderboard */}
      {view === 'summary' && data?.by_department?.length > 0 && (
        <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
          <div className="px-4 py-2 border-b border-[#E8D5C4] bg-[#FFF1E3]/50 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[#2D1B0E]">By Department</h3>
            <span className="text-[10px] text-[#8B7355]">Click row to drill into materials</span>
          </div>
          <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[640px]">
            <thead className="text-[#8B7355] bg-[#FFF8F0]">
              <tr>
                <th className="w-6"></th>
                <th className="text-left  py-1.5 px-3 font-medium">Department</th>
                <th className="text-right py-1.5 px-3 font-medium">Materials</th>
                <th className="text-right py-1.5 px-3 font-medium">Lines</th>
                <th className="text-right py-1.5 px-3 font-medium">Requisitions</th>
                <th className="text-right py-1.5 px-3 font-medium">Total Qty</th>
                <th className="text-right py-1.5 px-3 font-medium">Total Value ₹</th>
                <th className="w-16"></th>
              </tr>
            </thead>
            <tbody>
              {data.by_department.map((d: any) => {
                const isExp = expandedDept === d.department_id;
                const maxValue = data.by_department[0].total_value || 1;
                const pct = (d.total_value / maxValue) * 100;
                return (
                  <>
                    <tr key={d.department_id} className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3]/30 cursor-pointer"
                        onClick={() => setExpandedDept(isExp ? null : d.department_id)}>
                      <td className="py-2 px-2">{isExp ? <ChevronDown className="w-4 h-4 text-[#6B5744]" /> : <ChevronRight className="w-4 h-4 text-[#6B5744]" />}</td>
                      <td className="py-2 px-3 font-medium text-[#2D1B0E]">
                        {d.department_name}
                        {d.code && <span className="ml-1 text-[10px] font-mono text-[#8B7355]">[{d.code}]</span>}
                      </td>
                      <td className="py-2 px-3 text-right font-mono">{d.material_count}</td>
                      <td className="py-2 px-3 text-right font-mono">{d.line_count}</td>
                      <td className="py-2 px-3 text-right font-mono">{d.requisition_count}</td>
                      <td className="py-2 px-3 text-right font-mono">{fmt2(d.total_qty)}</td>
                      <td className="py-2 px-3 text-right font-mono font-semibold text-[#af4408]">{fmt(d.total_value)}</td>
                      <td className="py-2 px-3">
                        <div className="h-2 bg-[#FFF1E3] rounded">
                          <div className="h-2 bg-[#af4408] rounded" style={{ width: `${pct}%` }} />
                        </div>
                      </td>
                    </tr>
                    {isExp && (
                      <tr><td colSpan={8} className="bg-[#FFF8F0] px-4 py-2">
                        <DepartmentDrillDown rows={matrixForDept(d.department_id)} />
                      </td></tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {/* Top materials */}
      {view === 'summary' && data?.top_materials?.length > 0 && (
        <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
          <div className="px-4 py-2 border-b border-[#E8D5C4] bg-[#FFF1E3]/50 flex items-center gap-2">
            <Package className="w-4 h-4 text-[#af4408]" />
            <h3 className="text-sm font-semibold text-[#2D1B0E]">Top Materials Across All Departments</h3>
          </div>
          <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[600px]">
            <thead className="text-[#8B7355] bg-[#FFF8F0]">
              <tr>
                <th className="text-left  py-1.5 px-3 font-medium">SKU</th>
                <th className="text-left  py-1.5 px-3 font-medium">Material</th>
                <th className="text-left  py-1.5 px-3 font-medium">Category</th>
                <th className="text-right py-1.5 px-3 font-medium">Qty Issued</th>
                <th className="text-right py-1.5 px-3 font-medium">Avg ₹</th>
                <th className="text-right py-1.5 px-3 font-medium">Value ₹</th>
                <th className="text-right py-1.5 px-3 font-medium">Depts</th>
              </tr>
            </thead>
            <tbody>
              {data.top_materials.map((m: any) => (
                <tr key={m.material_id} className="border-t border-[#E8D5C4]/50">
                  <td className="py-1.5 px-3 font-mono text-[10px] text-[#8B7355]">{m.material_sku || '·'}</td>
                  <td className="py-1.5 px-3">{m.material_name}</td>
                  <td className="py-1.5 px-3 text-[#6B5744]">{m.category}</td>
                  <td className="py-1.5 px-3 text-right font-mono">{fmt2(m.total_qty)} <span className="text-[#8B7355]">{m.material_unit}</span></td>
                  <td className="py-1.5 px-3 text-right font-mono text-[#6B5744]">{fmt(m.average_price)}</td>
                  <td className="py-1.5 px-3 text-right font-mono font-semibold">{fmt(m.total_value)}</td>
                  <td className="py-1.5 px-3 text-right font-mono">{m.distinct_depts}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {view === 'summary' && !loading && data && (data.by_department?.length || 0) === 0 && (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center text-sm text-[#8B7355]">
          No requisition data in this range.
          <div className="text-xs mt-2">Import Recaho Transfer reports from <a href="/requisitions" className="text-[#af4408] underline">Requisitions</a> to populate this view.</div>
        </div>
      )}

      {/* ── DATE REGISTER: on which date which department took what items ── */}
      {view === 'register' && (
        <>
          {register?.totals && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="Total Value Issued" value={fmt(register.totals.total_value)} hint={`${register.totals.rows} date·dept·item rows`} />
              <Stat label="Days" value={String(register.totals.days)} hint={`${register.totals.departments} dept(s)`} />
              <Stat label="Distinct Materials" value={String(register.totals.materials)} />
              <Stat label="Date Range" value={`${register.range?.from} → ${register.range?.to}`} />
            </div>
          )}
          <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
            <div className="px-4 py-2 border-b border-[#E8D5C4] bg-[#FFF1E3]/50">
              <h3 className="text-sm font-semibold text-[#2D1B0E]">Issued Materials Register</h3>
              <p className="text-[10px] text-[#8B7355]">On which date each department drew which materials — by the actual store-issue date. Newest first.</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-[#8B7355] bg-[#FFF8F0]">
                  <tr>
                    <th className="text-left  py-1.5 px-3 font-medium">Date</th>
                    <th className="text-left  py-1.5 px-3 font-medium">Department</th>
                    <th className="text-left  py-1.5 px-3 font-medium">Material</th>
                    <th className="text-left  py-1.5 px-3 font-medium">Category</th>
                    <th className="text-right py-1.5 px-3 font-medium">Qty</th>
                    <th className="text-right py-1.5 px-3 font-medium">Value ₹</th>
                    <th className="text-right py-1.5 px-3 font-medium">Reqs</th>
                  </tr>
                </thead>
                <tbody>
                  {(register?.rows || []).map((r: any, i: number) => {
                    const newDate = i === 0 || register.rows[i - 1].date !== r.date;
                    return (
                      <tr key={i} className={`border-t border-[#E8D5C4]/50 ${newDate ? 'border-t-[#D4B896]' : ''}`}>
                        <td className="py-1.5 px-3 font-mono text-[#6B5744] whitespace-nowrap">{newDate ? r.date : ''}</td>
                        <td className="py-1.5 px-3 font-medium text-[#2D1B0E]">{r.department_name}</td>
                        <td className="py-1.5 px-3">{r.material_name}</td>
                        <td className="py-1.5 px-3 text-[#6B5744]">{r.category}</td>
                        <td className="py-1.5 px-3 text-right font-mono">{fmt2(r.qty)} <span className="text-[#8B7355]">{r.unit}</span></td>
                        <td className="py-1.5 px-3 text-right font-mono font-semibold text-[#af4408]">{fmt(r.value)}</td>
                        <td className="py-1.5 px-3 text-right font-mono text-[#6B5744]">{r.req_count}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          {!loading && register && (register.rows?.length || 0) === 0 && (
            <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center text-sm text-[#8B7355]">
              No materials were issued in this range. Once the store issues requisitions, each hand-over shows up here by date.
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-lg p-3">
      <div className="text-[10px] text-[#8B7355] uppercase tracking-wide">{label}</div>
      <div className="text-lg font-bold text-[#2D1B0E] mt-0.5">{value}</div>
      {hint && <div className="text-[10px] text-[#8B7355] mt-0.5">{hint}</div>}
    </div>
  );
}

function DepartmentDrillDown({ rows }: { rows: any[] }) {
  if (rows.length === 0) return <div className="text-xs text-[#8B7355] italic py-2">No materials.</div>;
  const total = rows.reduce((s, r) => s + r.value, 0);
  return (
    <table className="w-full text-xs">
      <thead className="text-[#8B7355]">
        <tr>
          <th className="text-left  py-1 px-2 font-medium">SKU</th>
          <th className="text-left  py-1 px-2 font-medium">Material</th>
          <th className="text-left  py-1 px-2 font-medium">Category</th>
          <th className="text-right py-1 px-2 font-medium">Qty</th>
          <th className="text-right py-1 px-2 font-medium">Value ₹</th>
          <th className="text-right py-1 px-2 font-medium">% of Dept</th>
        </tr>
      </thead>
      <tbody>
        {rows.slice(0, 50).map((r, i) => (
          <tr key={i} className="border-t border-[#E8D5C4]/50">
            <td className="py-1 px-2 font-mono text-[10px] text-[#8B7355]">{r.material_sku || '·'}</td>
            <td className="py-1 px-2">{r.material_name}</td>
            <td className="py-1 px-2 text-[#6B5744]">{r.category}</td>
            <td className="py-1 px-2 text-right font-mono">{fmt2(r.qty)} {r.material_unit}</td>
            <td className="py-1 px-2 text-right font-mono">{fmt(r.value)}</td>
            <td className="py-1 px-2 text-right font-mono text-[#6B5744]">
              {total > 0 ? ((r.value / total) * 100).toFixed(1) : '0.0'}%
            </td>
          </tr>
        ))}
        {rows.length > 50 && (
          <tr><td colSpan={6} className="text-[10px] text-[#8B7355] italic py-1 px-2">…and {rows.length - 50} more</td></tr>
        )}
      </tbody>
    </table>
  );
}
