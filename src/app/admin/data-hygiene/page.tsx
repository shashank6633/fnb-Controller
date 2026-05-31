'use client';

/**
 * Master Data Hygiene — admin-only.
 * Lists every gap in raw_materials / recipes / menu_items / vendors that
 * downstream reports silently rely on. Coverage score at the top tells the
 * admin what % of materials are "clean" (no blocker issues).
 */

import { useEffect, useMemo, useState } from 'react';
import { ShieldAlert, AlertTriangle, AlertCircle, Info, ChevronRight, RefreshCw, Loader2 } from 'lucide-react';

interface Issue {
  category: string;
  severity: 'blocker' | 'warning' | 'info';
  entity_type: 'material' | 'recipe' | 'menu_item' | 'vendor';
  entity_id: string;
  entity_name: string;
  message: string;
  fix_hint: string;
  fix_url: string;
}
interface Resp {
  summary: {
    total_issues: number;
    by_severity: { blocker: number; warning: number; info: number };
    by_category: Record<string, number>;
    total_materials: number;
    clean_materials: number;
    coverage_score: number;
  };
  issues: Issue[];
}

const SEVERITY_TONE: Record<string, string> = {
  blocker: 'bg-red-100 text-red-800 border-red-200',
  warning: 'bg-amber-100 text-amber-800 border-amber-200',
  info:    'bg-blue-50 text-blue-700 border-blue-200',
};
const SEVERITY_ICON = {
  blocker: AlertCircle,
  warning: AlertTriangle,
  info:    Info,
};

export default function DataHygienePage() {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sevFilter, setSevFilter] = useState<'all' | 'blocker' | 'warning' | 'info'>('blocker');
  const [catFilter, setCatFilter] = useState('');
  const [search, setSearch] = useState('');

  const reload = () => {
    setLoading(true); setError('');
    fetch('/api/data-hygiene')
      .then(async r => r.ok ? r.json() : Promise.reject(await r.text()))
      .then(setData)
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(reload, []);

  const filtered = useMemo(() => {
    if (!data) return [];
    let list = data.issues;
    if (sevFilter !== 'all') list = list.filter(i => i.severity === sevFilter);
    if (catFilter)           list = list.filter(i => i.category === catFilter);
    if (search.trim()) {
      const s = search.toLowerCase();
      list = list.filter(i => i.entity_name.toLowerCase().includes(s) || i.message.toLowerCase().includes(s));
    }
    return list;
  }, [data, sevFilter, catFilter, search]);

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center gap-3">
        <ShieldAlert className="text-[#af4408]" size={26} />
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-[#2D1B0E]">Master Data Hygiene</h1>
          <p className="text-xs text-[#8B7355]">
            Every variance, cost, and EOD report relies on these masters being clean. Fix the blockers first.
          </p>
        </div>
        <button onClick={reload} disabled={loading}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#FFF1E3] hover:bg-[#F5EDE2] text-[#2D1B0E] rounded text-sm">
          {loading ? <Loader2 className="animate-spin" size={14} /> : <RefreshCw size={14} />} Rescan
        </button>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded p-3 text-sm">{error}</div>}

      {data && (
        <>
          {/* Coverage score */}
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-5 flex items-center gap-5 flex-wrap">
            <div className="relative w-24 h-24 shrink-0">
              <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
                <circle cx="18" cy="18" r="15.9" fill="none" stroke="#FFF1E3" strokeWidth="3" />
                <circle cx="18" cy="18" r="15.9" fill="none"
                        stroke={data.summary.coverage_score >= 90 ? '#059669' : data.summary.coverage_score >= 70 ? '#d97706' : '#dc2626'}
                        strokeWidth="3" strokeDasharray="100 100"
                        strokeDashoffset={100 - data.summary.coverage_score} pathLength={100} />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-xl font-bold text-[#2D1B0E]">{data.summary.coverage_score}%</span>
                <span className="text-[9px] uppercase tracking-wide text-[#8B7355]">coverage</span>
              </div>
            </div>
            <div className="flex-1 min-w-[200px]">
              <div className="text-sm text-[#6B5744]">
                <strong className="text-[#2D1B0E]">{data.summary.clean_materials}</strong> of{' '}
                <strong className="text-[#2D1B0E]">{data.summary.total_materials}</strong> materials have zero blocker issues.
              </div>
              <div className="text-xs text-[#8B7355] mt-1">
                Aim for 95%+ before trusting variance / receipe-cost numbers downstream.
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="px-3 py-2 rounded bg-red-50 border border-red-200 text-center">
                <div className="text-[10px] text-red-700 uppercase tracking-wide">Blocker</div>
                <div className="text-xl font-bold text-red-800">{data.summary.by_severity.blocker}</div>
              </div>
              <div className="px-3 py-2 rounded bg-amber-50 border border-amber-200 text-center">
                <div className="text-[10px] text-amber-700 uppercase tracking-wide">Warning</div>
                <div className="text-xl font-bold text-amber-800">{data.summary.by_severity.warning}</div>
              </div>
              <div className="px-3 py-2 rounded bg-blue-50 border border-blue-200 text-center">
                <div className="text-[10px] text-blue-700 uppercase tracking-wide">Info</div>
                <div className="text-xl font-bold text-blue-800">{data.summary.by_severity.info}</div>
              </div>
            </div>
          </div>

          {/* Category breakdown */}
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-4">
            <div className="text-xs font-semibold text-[#2D1B0E] mb-2">Issue categories — click to filter</div>
            <div className="flex flex-wrap gap-1.5">
              <button onClick={() => setCatFilter('')}
                      className={`text-[11px] px-2 py-1 rounded ${!catFilter ? 'bg-[#af4408] text-white' : 'bg-[#FFF1E3] text-[#6B5744] hover:bg-[#F5EDE2]'}`}>
                All ({data.summary.total_issues})
              </button>
              {Object.entries(data.summary.by_category)
                .sort((a, b) => b[1] - a[1])
                .map(([cat, n]) => (
                  <button key={cat} onClick={() => setCatFilter(cat)}
                          className={`text-[11px] px-2 py-1 rounded ${catFilter === cat ? 'bg-[#af4408] text-white' : 'bg-[#FFF1E3] text-[#6B5744] hover:bg-[#F5EDE2]'}`}>
                    {cat} ({n})
                  </button>
                ))}
            </div>
          </div>

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex gap-1 bg-white border border-[#E8D5C4] rounded p-0.5">
              {(['all', 'blocker', 'warning', 'info'] as const).map(s => (
                <button key={s} onClick={() => setSevFilter(s)}
                        className={`text-xs px-2.5 py-1 rounded ${sevFilter === s ? 'bg-[#af4408] text-white' : 'text-[#6B5744] hover:bg-[#FFF1E3]'}`}>
                  {s[0].toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>
            <input value={search} onChange={e => setSearch(e.target.value)}
                   placeholder="Search by item name or message…"
                   className="flex-1 min-w-[200px] px-3 py-1.5 border border-[#D4B896] rounded text-sm bg-white" />
            <div className="text-xs text-[#8B7355]">{filtered.length} of {data.summary.total_issues}</div>
          </div>

          {/* Issues list */}
          <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
            {filtered.length === 0 ? (
              <div className="p-10 text-center text-sm text-emerald-700">
                ✓ No issues match your filters.
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead className="bg-[#FFF1E3] text-[#6B5744]">
                  <tr>
                    <th className="text-left py-2 px-3 font-medium w-16">Severity</th>
                    <th className="text-left py-2 px-3 font-medium">Category</th>
                    <th className="text-left py-2 px-3 font-medium">Entity</th>
                    <th className="text-left py-2 px-3 font-medium">Issue</th>
                    <th className="text-left py-2 px-3 font-medium w-24">Fix</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(0, 500).map((i, idx) => {
                    const Icon = SEVERITY_ICON[i.severity];
                    return (
                      <tr key={idx} className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF8F0]/50 align-top">
                        <td className="py-2 px-3">
                          <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border ${SEVERITY_TONE[i.severity]}`}>
                            <Icon size={11} /> {i.severity}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-[#6B5744]">{i.category}</td>
                        <td className="py-2 px-3">
                          <div className="font-medium text-[#2D1B0E]">{i.entity_name}</div>
                          <div className="text-[9px] text-[#8B7355] uppercase tracking-wide">{i.entity_type}</div>
                        </td>
                        <td className="py-2 px-3">
                          <div className="text-[#2D1B0E]">{i.message}</div>
                          <div className="text-[10px] text-[#8B7355] mt-0.5 italic">→ {i.fix_hint}</div>
                        </td>
                        <td className="py-2 px-3">
                          <a href={i.fix_url} target="_blank"
                             className="inline-flex items-center gap-0.5 text-[#af4408] hover:underline">
                            Fix <ChevronRight size={12} />
                          </a>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {filtered.length > 500 && (
              <div className="px-3 py-2 bg-[#FFF8F0] text-[10px] text-[#8B7355] text-center">
                Showing first 500 of {filtered.length}. Apply more filters to narrow.
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
