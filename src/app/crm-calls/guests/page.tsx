'use client';

/**
 * CRM — Call-to-Table · Guests list (master spec 5.4)
 *
 * Server-driven list over GET /api/crm-calls/guests:
 *   search (debounced 300ms) · filters (badge / tag / converted / last-call range)
 *   sortable columns (calls 30d, last call, bookings, last visit, conversion)
 *   pagination 25/page · Export CSV (same filters, ?format=csv)
 *   + New Guest modal (name + phone required; 409 → navigate to existing guest)
 * Row click → /crm-calls/guests/[id]. Desktop table + mobile cards.
 */

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { formatPhone } from '@/lib/ct/phone';
import { capMobile10 } from '@/lib/mobile-input';
import {
  Users,
  Plus,
  Search,
  Download,
  X,
  Loader2,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  ArrowUpDown,
  Phone,
  CalendarDays,
} from 'lucide-react';
import CollapsibleToolbar from '@/components/ct/CollapsibleToolbar';

const PAGE_SIZE = 25;

interface GuestMetrics {
  total_calls: number;
  calls_30d: number;
  missed_calls: number;
  last_call_at: string | null;
  total_bookings: number;
  completed_visits: number;
  no_shows: number;
  last_visit_at: string | null;
  conversion_rate: number; // ratio (bookings ÷ answered inbound)
  badge: string;
}

interface Guest {
  id: string;
  phone_e164: string;
  name: string;
  alt_phone: string;
  email: string;
  tags: string[];
  source: string;
  notes: string;
  dob: string;
  anniversary: string;
  created_at: string;
  updated_at: string;
  metrics: GuestMetrics;
  loyalty: { points: number; tier: 'Bronze' | 'Silver' | 'Gold'; visit_count: number; total_spend: number } | null;
  dining: { orders: number; visits: number; total_spent: number; qr_orders: number; last_seen: string | null };
  synthetic?: boolean;
}

/** Same canonicalisation the API uses — punctuation-insensitive badge slug. */
function badgeSlug(s: unknown): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

const BADGE_STYLES: Record<string, string> = {
  new_caller: 'bg-slate-100 text-slate-700 border-slate-300',
  enquired_not_converted: 'bg-amber-100 text-amber-800 border-amber-300',
  converted: 'bg-green-100 text-green-700 border-green-300',
  repeat_guest: 'bg-emerald-100 text-emerald-700 border-emerald-300',
  dine_in_guest: 'bg-[#F3E9DC] text-[#8B5E34] border-[#E8D5C4]',
  lapsed: 'bg-red-100 text-red-700 border-red-300',
};

const BADGE_SHORT: Record<string, string> = {
  new_caller: 'NEW CALLER',
  enquired_not_converted: 'ENQUIRED',
  converted: 'CONVERTED',
  repeat_guest: 'REPEAT',
  dine_in_guest: 'DINE-IN',
  lapsed: 'LAPSED',
};

const BADGE_OPTIONS: [string, string][] = [
  ['', 'All badges'],
  ['new_caller', 'New Caller'],
  ['enquired_not_converted', 'Enquired – Not Converted'],
  ['converted', 'Converted'],
  ['repeat_guest', 'Repeat Guest'],
  ['lapsed', 'Lapsed'],
];

const SORT_OPTIONS: [string, string][] = [
  ['last_call', 'Last call'],
  ['calls_30d', 'Recent calls (30d)'],
  ['total_calls', 'Total calls'],
  ['total_bookings', 'Bookings'],
  ['last_visit', 'Last visit'],
  ['conversion', 'Conversion'],
  ['points', 'Loyalty points'],
  ['spend', 'Dining spend'],
  ['dining_visits', 'Dining visits'],
  ['name', 'Name'],
];

function istDateTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

function istDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
}

function convPct(rate: number): string {
  return `${Math.round((Number(rate) || 0) * 100)}%`;
}

const TIER_CHIP: Record<string, string> = {
  Bronze: 'bg-amber-100 text-amber-800 border-amber-300',
  Silver: 'bg-slate-100 text-slate-700 border-slate-300',
  Gold: 'bg-yellow-100 text-yellow-800 border-yellow-300',
};

function TierChip({ tier }: { tier: 'Bronze' | 'Silver' | 'Gold' }) {
  const cls = TIER_CHIP[tier] || 'bg-slate-100 text-slate-700 border-slate-300';
  return (
    <span className={`inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded-full border whitespace-nowrap ${cls}`}>
      {tier}
    </span>
  );
}

export default function CtGuestsPage() {
  const router = useRouter();

  const [guests, setGuests] = useState<Guest[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);   // first load skeleton
  const [fetching, setFetching] = useState(false); // subtle refetch indicator
  const [error, setError] = useState<string | null>(null);

  // Search (debounced) + filters
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [badgeFilter, setBadgeFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [convertedFilter, setConvertedFilter] = useState(''); // '' | '1' | '0'
  const [lastCallFrom, setLastCallFrom] = useState('');
  const [lastCallTo, setLastCallTo] = useState('');

  // Sort + pagination
  const [sort, setSort] = useState('last_call');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);

  // Tag options accumulate from fetched pages (tags are freeform per guest)
  const [knownTags, setKnownTags] = useState<string[]>([]);

  const [newOpen, setNewOpen] = useState(false);

  // Debounce search 300ms
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Seed the Tag filter with the full tag vocabulary once on mount, so tags on
  // guests beyond the current 25-row page are still selectable. The API has no
  // distinct-tags endpoint, so we pull a broad unfiltered page and union its
  // tags; `tags=1` is sent so this also works if that mode is added later
  // (returning a top-level { tags: [] }). Per-page accumulation stays as a
  // harmless supplement.
  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch('/api/crm-calls/guests?tags=1&pageSize=200', { signal: ctrl.signal, cache: 'no-store' });
        if (!res.ok) return;
        let json: any = {};
        try { json = await res.json(); } catch { return; }
        const collected = new Set<string>();
        if (Array.isArray(json?.tags)) {
          for (const t of json.tags) { const v = String(t).trim(); if (v) collected.add(v); }
        }
        if (Array.isArray(json?.guests)) {
          for (const g of json.guests) {
            if (Array.isArray(g?.tags)) for (const t of g.tags) { const v = String(t).trim(); if (v) collected.add(v); }
          }
        }
        if (collected.size === 0) return;
        setKnownTags(prev => {
          const s = new Set(prev);
          for (const v of collected) s.add(v);
          return s.size === prev.length ? prev : Array.from(s).sort((a, b) => a.localeCompare(b));
        });
      } catch { /* best-effort; per-page accumulation still populates the filter */ }
    })();
    return () => ctrl.abort();
  }, []);

  // Filter/sort params shared by the list fetch and the CSV export
  const buildQuery = useCallback((): URLSearchParams => {
    const p = new URLSearchParams();
    if (search) p.set('search', search);
    if (badgeFilter) p.set('badge', badgeFilter);
    if (tagFilter) p.set('tag', tagFilter);
    if (convertedFilter) p.set('converted', convertedFilter);
    if (lastCallFrom) p.set('last_call_from', lastCallFrom);
    if (lastCallTo) p.set('last_call_to', lastCallTo);
    p.set('sort', sort);
    p.set('dir', dir);
    return p;
  }, [search, badgeFilter, tagFilter, convertedFilter, lastCallFrom, lastCallTo, sort, dir]);

  // Fetch list (server does filter/sort/paginate)
  useEffect(() => {
    const ctrl = new AbortController();
    let cancelled = false;
    (async () => {
      setFetching(true);
      setError(null);
      try {
        const p = buildQuery();
        p.set('page', String(page));
        p.set('pageSize', String(PAGE_SIZE));
        const res = await fetch(`/api/crm-calls/guests?${p.toString()}`, { signal: ctrl.signal, cache: 'no-store' });
        let json: any = {};
        try { json = await res.json(); } catch { /* non-JSON error body */ }
        if (cancelled) return;
        if (!res.ok) {
          setError(json?.error || `Failed to load guests (HTTP ${res.status})`);
          setGuests([]);
          setTotal(0);
          return;
        }
        const list: Guest[] = Array.isArray(json?.guests) ? json.guests : [];
        setGuests(list);
        setTotal(Number(json?.total) || 0);
        setKnownTags(prev => {
          const s = new Set(prev);
          for (const g of list) {
            if (Array.isArray(g.tags)) for (const t of g.tags) { const v = String(t).trim(); if (v) s.add(v); }
          }
          return s.size === prev.length ? prev : Array.from(s).sort((a, b) => a.localeCompare(b));
        });
      } catch (e: any) {
        if (!cancelled && e?.name !== 'AbortError') {
          setError('Network error — could not load guests');
        }
      } finally {
        if (!cancelled) { setFetching(false); setLoading(false); }
      }
    })();
    return () => { cancelled = true; ctrl.abort(); };
  }, [buildQuery, page]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  useEffect(() => { if (page > pageCount) setPage(pageCount); }, [page, pageCount]);

  const onSort = (key: string) => {
    if (sort === key) {
      setDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSort(key);
      setDir(key === 'name' ? 'asc' : 'desc');
    }
    setPage(1);
  };

  const exportCsv = () => {
    const p = buildQuery();
    p.set('format', 'csv');
    window.open(`/api/crm-calls/guests?${p.toString()}`, '_blank');
  };

  const hasFilters = !!(search || badgeFilter || tagFilter || convertedFilter || lastCallFrom || lastCallTo);
  // Secondary filters that live inside the mobile "Filters & options" dropdown
  // (search stays visible outside it, so it is excluded from the badge count).
  const filterCount = [badgeFilter, tagFilter, convertedFilter, lastCallFrom, lastCallTo].filter(Boolean).length;
  const clearFilters = () => {
    setSearchInput(''); setSearch('');
    setBadgeFilter(''); setTagFilter(''); setConvertedFilter('');
    setLastCallFrom(''); setLastCallTo('');
    setPage(1);
  };

  const openGuest = (id: string) => router.push(`/crm-calls/guests/${encodeURIComponent(id)}`);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] p-6 animate-pulse">
        <div className="max-w-[100rem] mx-auto space-y-6">
          <div className="h-9 w-64 bg-[#FFF1E3] rounded-lg" />
          <div className="h-12 bg-white border border-[#E8D5C4] rounded-xl" />
          <div className="bg-white border border-[#E8D5C4] rounded-2xl h-96" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-[100rem] mx-auto px-3 sm:px-6 py-5 sm:py-6 space-y-4 sm:space-y-5">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold text-[#6B5744] uppercase tracking-wider">CRM · Call to Table</p>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#2D1B0E] mt-0.5">Guests</h1>
          </div>
          <div className="flex gap-2">
            <button onClick={exportCsv}
                    className="flex items-center gap-2 px-3 sm:px-4 py-2.5 bg-white border border-[#E0D0BE] hover:border-[#af4408] hover:bg-[#FFF1E3] text-[#6B5744] rounded-xl text-sm font-medium shadow-sm transition-colors">
              <Download className="w-4 h-4" /><span className="hidden sm:inline">Export CSV</span><span className="sm:hidden">CSV</span>
            </button>
            <button onClick={() => setNewOpen(true)}
                    className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-xl text-sm font-semibold shadow-sm transition-colors">
              <Plus className="w-4 h-4" />New Guest
            </button>
          </div>
        </div>

        {/* Search + filters */}
        <div className="flex flex-col lg:flex-row gap-2.5">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8B7355]" />
            <input
              type="text"
              placeholder="Search by name, phone or email…"
              aria-label="Search guests by name, phone or email"
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              className="w-full pl-10 pr-9 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]/40 focus:border-[#af4408] shadow-sm"
            />
            {fetching && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8B7355] animate-spin" />}
          </div>
          <CollapsibleToolbar activeCount={filterCount}>
          <div className="flex flex-wrap items-center gap-2">
            <select value={badgeFilter} onChange={e => { setBadgeFilter(e.target.value); setPage(1); }}
                    className="px-3 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm shadow-sm"
                    aria-label="Filter by status badge">
              {BADGE_OPTIONS.map(([v, label]) => <option key={v || 'all'} value={v}>{label}</option>)}
            </select>
            <select value={tagFilter} onChange={e => { setTagFilter(e.target.value); setPage(1); }}
                    className="px-3 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm shadow-sm"
                    aria-label="Filter by tag">
              <option value="">All tags</option>
              {tagFilter && !knownTags.includes(tagFilter) && <option value={tagFilter}>{tagFilter}</option>}
              {knownTags.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <select value={convertedFilter} onChange={e => { setConvertedFilter(e.target.value); setPage(1); }}
                    className="px-3 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm shadow-sm"
                    aria-label="Filter by converted">
              <option value="">Converted: All</option>
              <option value="1">Converted: Yes</option>
              <option value="0">Converted: No</option>
            </select>
            <div className="flex items-center gap-1.5 bg-white border border-[#E0D0BE] rounded-xl px-2.5 py-1.5 shadow-sm">
              <CalendarDays className="w-4 h-4 text-[#8B7355] shrink-0" />
              <span className="text-[11px] text-[#8B7355] hidden sm:inline whitespace-nowrap">Last call</span>
              <input type="date" value={lastCallFrom} onChange={e => { setLastCallFrom(e.target.value); setPage(1); }}
                     className="bg-transparent text-xs sm:text-sm text-[#3D2614] focus:outline-none w-[7.5rem]" aria-label="Last call from" />
              <span className="text-[#C4B09A]">–</span>
              <input type="date" value={lastCallTo} onChange={e => { setLastCallTo(e.target.value); setPage(1); }}
                     className="bg-transparent text-xs sm:text-sm text-[#3D2614] focus:outline-none w-[7.5rem]" aria-label="Last call to" />
            </div>
            {hasFilters && (
              <button onClick={clearFilters} className="flex items-center gap-1 px-2.5 py-2 text-xs font-medium text-[#af4408] hover:bg-[#FFF1E3] rounded-lg transition-colors">
                <X className="w-3.5 h-3.5" />Clear
              </button>
            )}
          </div>

          {/* Mobile sort control (desktop sorts via column headers) */}
          <div className="md:hidden flex items-center gap-2 mt-2">
            <label className="text-xs text-[#8B7355] shrink-0">Sort by</label>
            <select value={sort} onChange={e => { const v = e.target.value; setSort(v); setDir(v === 'name' ? 'asc' : 'desc'); setPage(1); }}
                    className="flex-1 px-3 py-2 bg-white border border-[#E0D0BE] rounded-xl text-sm shadow-sm">
              {SORT_OPTIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
            <button onClick={() => { setDir(d => (d === 'asc' ? 'desc' : 'asc')); setPage(1); }}
                    className="px-3 py-2 bg-white border border-[#E0D0BE] rounded-xl text-sm text-[#6B5744] shadow-sm"
                    aria-label="Toggle sort direction">
              {dir === 'asc' ? '↑ Asc' : '↓ Desc'}
            </button>
          </div>
          </CollapsibleToolbar>
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-start gap-2 p-4 bg-red-50 border border-red-200 rounded-xl">
            <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}

        {/* List */}
        {!error && guests.length === 0 ? (
          <div className="bg-white border border-[#E8D5C4] rounded-2xl py-16 text-center text-[#8B7355]">
            <Users className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p>No guests found</p>
            <p className="text-xs mt-1">{hasFilters ? 'Try clearing the filters' : 'Guests appear here from calls, QR/dine-in orders and loyalty — or add one manually.'}</p>
          </div>
        ) : !error && (
          <>
            {/* Desktop table */}
            <div className="hidden md:block bg-white border border-[#E8D5C4] rounded-2xl shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-wide text-[#8B7355] border-b border-[#E8D5C4] bg-[#FFF8F0]">
                      <SortTh label="Guest" sortKey="name" sort={sort} dir={dir} onSort={onSort} className="text-left py-3 px-4" />
                      <th className="text-left py-3 px-3 font-semibold">Badge</th>
                      <th className="text-left py-3 px-3 font-semibold">Tags</th>
                      <SortTh label="Calls (30d)" sortKey="calls_30d" sort={sort} dir={dir} onSort={onSort} className="text-right py-3 px-3" align="right" />
                      <SortTh label="Last Call" sortKey="last_call" sort={sort} dir={dir} onSort={onSort} className="text-left py-3 px-3" />
                      <SortTh label="Bookings" sortKey="total_bookings" sort={sort} dir={dir} onSort={onSort} className="text-right py-3 px-3" align="right" />
                      <SortTh label="Last Visit" sortKey="last_visit" sort={sort} dir={dir} onSort={onSort} className="text-left py-3 px-3" />
                      <SortTh label="Conv %" sortKey="conversion" sort={sort} dir={dir} onSort={onSort} className="text-right py-3 px-3" align="right" />
                      <SortTh label="Loyalty" sortKey="points" sort={sort} dir={dir} onSort={onSort} className="text-right py-3 px-3" align="right" />
                      <SortTh label="Dining" sortKey="spend" sort={sort} dir={dir} onSort={onSort} className="text-right py-3 px-3" align="right" />
                    </tr>
                  </thead>
                  <tbody>
                    {guests.map(g => (
                      <tr key={g.id}
                          onClick={() => openGuest(g.id)}
                          onKeyDown={e => { if (e.key === 'Enter') openGuest(g.id); }}
                          tabIndex={0}
                          className="border-b border-[#F0E4D6] last:border-0 hover:bg-[#FFF8F0] cursor-pointer focus:outline-none focus:bg-[#FFF1E3]">
                        <td className="py-2.5 px-4">
                          <div className="flex items-center gap-3">
                            <GuestAvatar name={g.name} phone={g.phone_e164} />
                            <div className="min-w-0">
                              <p className="font-semibold text-[#2D1B0E] text-[13px] truncate max-w-[220px]">{g.name || 'Unknown guest'}</p>
                              <p className="text-[11px] text-[#6B5744] flex items-center gap-1">
                                <Phone className="w-3 h-3" />{formatPhone(g.phone_e164)}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="py-2.5 px-3"><BadgeChip badge={g.metrics.badge} /></td>
                        <td className="py-2.5 px-3"><TagChips tags={g.tags} /></td>
                        <td className="py-2.5 px-3 text-right">
                          <span className="font-semibold text-[#2D1B0E]">{g.metrics.calls_30d}</span>
                          <span className="text-[11px] text-[#6B5744]"> / {g.metrics.total_calls}</span>
                          {g.metrics.missed_calls > 0 && (
                            <p className="text-[11px] text-red-500">{g.metrics.missed_calls} missed</p>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-[13px] text-[#3D2614] whitespace-nowrap">
                          {istDateTime(g.metrics.last_call_at) || <span className="text-[#C4B09A]">—</span>}
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          <span className="font-semibold text-[#2D1B0E]">{g.metrics.total_bookings}</span>
                          {g.metrics.no_shows > 0 && (
                            <p className="text-[11px] text-amber-600">{g.metrics.no_shows} no-show{g.metrics.no_shows > 1 ? 's' : ''}</p>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-[13px] text-[#3D2614] whitespace-nowrap">
                          {istDate(g.metrics.last_visit_at) || <span className="text-[#C4B09A]">—</span>}
                        </td>
                        <td className="py-2.5 px-3 text-right font-medium text-[#2D1B0E]">{convPct(g.metrics.conversion_rate)}</td>
                        <td className="py-2.5 px-3 text-right whitespace-nowrap">
                          {g.loyalty ? (
                            <span className="inline-flex items-center justify-end gap-1.5">
                              <span className="font-semibold text-[#2D1B0E]">{Math.round(g.loyalty.points)} pts</span>
                              <TierChip tier={g.loyalty.tier} />
                            </span>
                          ) : <span className="text-[#C4B09A]">—</span>}
                        </td>
                        <td className="py-2.5 px-3 text-right whitespace-nowrap">
                          <span className="font-semibold text-[#2D1B0E]">₹{(g.dining?.total_spent || 0).toLocaleString('en-IN')}</span>
                          <p className="text-[11px] text-[#6B5744]">{g.dining?.visits || 0} visits · {g.dining?.orders || 0} orders</p>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Mobile cards */}
            <div className="md:hidden space-y-2.5">
              {guests.map(g => (
                <div key={g.id} onClick={() => openGuest(g.id)} role="button" tabIndex={0}
                     onKeyDown={e => { if (e.key === 'Enter') openGuest(g.id); }}
                     className="bg-white border border-[#E8D5C4] rounded-2xl p-3 shadow-sm active:bg-[#FFF8F0] cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#af4408]/30">
                  <div className="flex items-start gap-3">
                    <GuestAvatar name={g.name} phone={g.phone_e164} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-semibold text-[#2D1B0E] text-sm leading-snug truncate">{g.name || 'Unknown guest'}</p>
                          <p className="text-[11px] text-[#6B5744]">{formatPhone(g.phone_e164)}</p>
                        </div>
                        <BadgeChip badge={g.metrics.badge} />
                      </div>
                      {Array.isArray(g.tags) && g.tags.length > 0 && (
                        <div className="mt-1.5"><TagChips tags={g.tags} /></div>
                      )}
                      <div className="grid grid-cols-3 gap-2 mt-2 pt-2 border-t border-[#F0E4D6] text-center">
                        <div>
                          <p className="text-[10px] text-[#6B5744] uppercase tracking-wide">Calls 30d</p>
                          <p className="text-sm font-bold text-[#2D1B0E]">{g.metrics.calls_30d}</p>
                        </div>
                        <div>
                          <p className="text-[10px] text-[#6B5744] uppercase tracking-wide">Bookings</p>
                          <p className="text-sm font-bold text-[#2D1B0E]">{g.metrics.total_bookings}</p>
                        </div>
                        <div>
                          <p className="text-[10px] text-[#6B5744] uppercase tracking-wide">Conv</p>
                          <p className="text-sm font-bold text-[#2D1B0E]">{convPct(g.metrics.conversion_rate)}</p>
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-[#F0E4D6] text-[11px] text-[#6B5744]">
                        <span className="min-w-0 truncate">
                          Loyalty: {g.loyalty ? `${Math.round(g.loyalty.points)} pts · ${g.loyalty.tier}` : '—'}
                        </span>
                        <span className="min-w-0 truncate text-right shrink-0 max-w-[55%]">
                          Dining: {(g.dining?.orders || 0) === 0 && (g.dining?.total_spent || 0) === 0
                            ? '—'
                            : `₹${(g.dining?.total_spent || 0).toLocaleString('en-IN')} · ${g.dining?.visits || 0} visits`}
                        </span>
                      </div>
                      <div className="flex items-center justify-between mt-2 text-[11px] text-[#6B5744]">
                        <span>Last call: {istDateTime(g.metrics.last_call_at) || '—'}</span>
                        <span>Visit: {istDate(g.metrics.last_visit_at) || '—'}</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Pagination */}
            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-1">
              <p className="text-xs text-[#6B5744]">
                Showing {total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total} guests
              </p>
              <Pagination page={page} pageCount={pageCount} onPage={setPage} />
            </div>
          </>
        )}
      </div>

      {/* New Guest modal */}
      {newOpen && (
        <NewGuestModal
          onClose={() => setNewOpen(false)}
          onGoto={id => { setNewOpen(false); openGuest(id); }}
        />
      )}
    </div>
  );
}

/* ───────────────────────────── components ───────────────────────────── */

function BadgeChip({ badge }: { badge: string }) {
  const slug = badgeSlug(badge);
  const cls = BADGE_STYLES[slug] || 'bg-slate-100 text-slate-700 border-slate-300';
  const label = BADGE_SHORT[slug] || badge || '—';
  return (
    <span title={badge} className={`inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap ${cls}`}>
      {label}
    </span>
  );
}

function TagChips({ tags }: { tags: string[] }) {
  if (!Array.isArray(tags) || tags.length === 0) return <span className="text-[#C4B09A]">—</span>;
  const shown = tags.slice(0, 3);
  const extra = tags.length - shown.length;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {shown.map(t => (
        <span key={t} className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-[#FFF1E3] text-[#a8632b] border border-[#E8D5C4] whitespace-nowrap">
          {t}
        </span>
      ))}
      {extra > 0 && <span className="text-[10px] text-[#8B7355]" title={tags.slice(3).join(', ')}>+{extra}</span>}
    </span>
  );
}

function GuestAvatar({ name, phone }: { name: string; phone: string }) {
  const initials = (name || '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase()
    || (phone || '').replace(/\D/g, '').slice(-2)
    || '?';
  return (
    <div className="w-9 h-9 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 bg-[#F3E2D0] text-[#a8632b]">
      {initials}
    </div>
  );
}

function SortTh({ label, sortKey, sort, dir, onSort, className, align }: {
  label: string; sortKey: string; sort: string; dir: 'asc' | 'desc';
  onSort: (key: string) => void; className?: string; align?: 'right';
}) {
  const active = sort === sortKey;
  return (
    <th className={`font-semibold ${className || ''}`} aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      <button onClick={() => onSort(sortKey)}
              className={`inline-flex items-center gap-1 uppercase tracking-wide hover:text-[#af4408] transition-colors ${active ? 'text-[#af4408]' : ''} ${align === 'right' ? 'flex-row-reverse' : ''}`}>
        {label}
        {active
          ? (dir === 'asc' ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />)
          : <ArrowUpDown className="w-3 h-3 opacity-40" />}
      </button>
    </th>
  );
}

function Pagination({ page, pageCount, onPage }: { page: number; pageCount: number; onPage: (n: number) => void }) {
  if (pageCount <= 1) return null;
  const set = new Set<number>([1, 2, page - 1, page, page + 1, pageCount - 1, pageCount]);
  const nums = [...set].filter(n => n >= 1 && n <= pageCount).sort((a, b) => a - b);
  const items: (number | string)[] = [];
  nums.forEach((n, i) => { if (i > 0 && n - nums[i - 1] > 1) items.push(`gap${i}`); items.push(n); });
  return (
    <div className="flex items-center gap-1">
      <button disabled={page <= 1} onClick={() => onPage(page - 1)}
              className="h-9 w-9 flex items-center justify-center rounded-lg border border-[#E8D5C4] text-[#6B5744] disabled:opacity-40 hover:bg-[#FFF1E3]" aria-label="Previous page">
        <ChevronLeft className="w-4 h-4" />
      </button>
      {items.map(n => typeof n === 'string'
        ? <span key={n} className="px-1 text-[#8B7355]">…</span>
        : <button key={n} onClick={() => onPage(n)} aria-current={n === page ? 'page' : undefined}
                  className={`min-w-[36px] h-9 px-2 rounded-lg text-sm font-medium ${n === page ? 'bg-[#af4408] text-white' : 'border border-[#E8D5C4] text-[#6B5744] hover:bg-[#FFF1E3]'}`}>{n}</button>)}
      <button disabled={page >= pageCount} onClick={() => onPage(page + 1)}
              className="h-9 w-9 flex items-center justify-center rounded-lg border border-[#E8D5C4] text-[#6B5744] disabled:opacity-40 hover:bg-[#FFF1E3]" aria-label="Next page">
        <ChevronRight className="w-4 h-4" />
      </button>
    </div>
  );
}

function NewGuestModal({ onClose, onGoto }: { onClose: () => void; onGoto: (id: string) => void }) {
  const [form, setForm] = useState({ name: '', phone: '', email: '', tags: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Close on Escape (standard dismiss gesture for keyboard users)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const canSave = form.name.trim().length > 0 && form.phone.trim().length > 0;

  const submit = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await api('/api/crm-calls/guests', {
        method: 'POST',
        body: {
          name: form.name.trim(),
          phone: form.phone.trim(),
          email: form.email.trim(),
          tags: form.tags.split(',').map(t => t.trim()).filter(Boolean),
          notes: form.notes.trim(),
          source: 'manual',
        },
      });
      let json: any = {};
      try { json = await res.json(); } catch { /* non-JSON error body */ }
      if (res.status === 409) {
        // Duplicate phone → jump straight to the existing guest's profile
        if (json?.existing_guest_id) { onGoto(String(json.existing_guest_id)); return; }
        setErr(json?.error || 'A guest with this phone number already exists');
        return;
      }
      if (!res.ok) {
        setErr(json?.error || `Failed to create guest (HTTP ${res.status})`);
        return;
      }
      if (json?.guest?.id) onGoto(String(json.guest.id));
      else onClose();
    } catch {
      setErr('Network error — could not create guest');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
           role="dialog" aria-modal="true" aria-labelledby="newguest-title"
           className="relative w-full max-w-md bg-white border border-[#E8D5C4] rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8D5C4] shrink-0">
          <h2 id="newguest-title" className="text-lg font-semibold text-[#2D1B0E]">New Guest</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[#FFF1E3]" aria-label="Close"><X className="w-5 h-5" /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-[#6B5744] mb-1">Name *</label>
            <input type="text" value={form.name} autoFocus
                   onChange={e => setForm({ ...form, name: e.target.value })}
                   className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]/40" />
          </div>
          <div>
            <label className="block text-xs font-medium text-[#6B5744] mb-1">Phone *</label>
            <input type="tel" value={form.phone} placeholder="98765 43210"
                   inputMode="numeric"
                   onChange={e => setForm({ ...form, phone: capMobile10(e.target.value) })}
                   onKeyDown={e => { if (e.key === 'Enter') submit(); }}
                   className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]/40" />
            <p className="text-[10px] text-[#8B7355] mt-0.5">10-digit Indian numbers are saved as +91.</p>
          </div>
          <div>
            <label className="block text-xs font-medium text-[#6B5744] mb-1">Email</label>
            <input type="email" value={form.email}
                   onChange={e => setForm({ ...form, email: e.target.value })}
                   className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]/40" />
          </div>
          <div>
            <label className="block text-xs font-medium text-[#6B5744] mb-1">Tags <span className="text-[#8B7355] font-normal">(comma-separated, e.g. VIP, vegetarian)</span></label>
            <input type="text" value={form.tags}
                   onChange={e => setForm({ ...form, tags: e.target.value })}
                   className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]/40" />
          </div>
          <div>
            <label className="block text-xs font-medium text-[#6B5744] mb-1">Notes</label>
            <textarea rows={2} value={form.notes}
                      onChange={e => setForm({ ...form, notes: e.target.value })}
                      className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]/40" />
          </div>
          {err && (
            <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg">
              <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
              <p className="text-xs text-red-700">{err}</p>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-3 px-6 py-3 border-t border-[#E8D5C4] shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm text-[#6B5744] bg-[#FFF1E3] rounded-lg hover:bg-[#E8D5C4]">Cancel</button>
          <button onClick={submit} disabled={saving || !canSave}
                  className="flex items-center gap-2 px-5 py-2 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 text-white rounded-lg text-sm font-medium">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            {saving ? 'Saving…' : 'Create Guest'}
          </button>
        </div>
      </div>
    </div>
  );
}
