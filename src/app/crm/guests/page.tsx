'use client';

/**
 * Guests & Loyalty (/crm/guests) — guest database + points.
 *
 * Directory of guests keyed by 10-digit mobile: search, add, edit, deactivate
 * (no hard delete), per-guest visit history, and a manual "Record Visit" form
 * that accrues loyalty points (same POST the POS settle hook will call in a
 * later pass). Tier badges (Bronze <500 / Silver <1500 / Gold ≥1500 pts) come
 * computed from the API. Upcoming-birthdays strip (next 30 days) up top.
 *
 * Client gate: admin, manager tier, or HOD (is_head_chef) — the API enforces
 * the same gate server-side. Mobile-first: cards under md, table md+. Warm theme.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { Fragment, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle, ArrowLeft, Cake, CheckCircle2, ChevronDown, ChevronUp,
  Gift, Loader2, Pencil, Phone, Plus, RefreshCw, Search, UserPlus, Users, X,
} from 'lucide-react';
import { api } from '@/lib/api';

/* ── types (mirror /api/crm/guests) ───────────────────────────────────── */

interface Guest {
  id: string;
  name: string;
  mobile: string;
  birthday: string;
  notes: string;
  first_visit_at: string;
  last_visit_at: string | null;
  visit_count: number;
  total_spend: number;
  points: number;
  is_active: number;
  created_at: string;
  tier: 'Bronze' | 'Silver' | 'Gold';
}

interface Visit {
  id: string;
  order_id: string;
  bill_amount: number;
  points_earned: number;
  visited_at: string;
  source: string;
}

/* ── helpers ──────────────────────────────────────────────────────────── */

const inr = (n: number) =>
  '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

const fmtDate = (s: string | null | undefined) => {
  if (!s) return '—';
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

const TIER_CLS: Record<Guest['tier'], string> = {
  Bronze: 'bg-orange-50 text-orange-800 border-orange-200',
  Silver: 'bg-gray-100 text-gray-700 border-gray-300',
  Gold:   'bg-yellow-50 text-yellow-800 border-yellow-300',
};

function TierBadge({ tier }: { tier: Guest['tier'] }) {
  return (
    <span className={`inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full border ${TIER_CLS[tier]}`}>
      {tier}
    </span>
  );
}

/** Days until next birthday occurrence (0 = today) from 'YYYY-MM-DD' or 'MM-DD'; null if unparseable. */
function daysToBirthday(birthday: string): number | null {
  const m = String(birthday || '').trim().match(/^(?:\d{4}-)?(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const month = parseInt(m[1], 10), day = parseInt(m[2], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let next = new Date(today.getFullYear(), month - 1, day);
  if (next < today) next = new Date(today.getFullYear() + 1, month - 1, day);
  return Math.round((next.getTime() - today.getTime()) / 86400000);
}

/* ── page ─────────────────────────────────────────────────────────────── */

const EMPTY_FORM = { mobile: '', name: '', birthday: '', notes: '' };

export default function CrmGuestsPage() {
  const router = useRouter();
  const [me, setMe] = useState<any>(undefined);   // undefined = loading, null = signed out

  const [rows, setRows] = useState<Guest[]>([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Add-guest modal
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  // Expanded guest detail
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ guest: Guest; visits: Visit[] } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [editForm, setEditForm] = useState({ name: '', birthday: '', notes: '' });
  const [visitForm, setVisitForm] = useState({ bill_amount: '', order_id: '' });
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const allowed = !!me && (me.role === 'admin' || me.role === 'manager' || me.is_head_chef);

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.json())
      .then(d => setMe(d?.user ?? null))
      .catch(() => setMe(null));
  }, []);

  const load = useCallback((query: string) => {
    setLoading(true);
    setError(null);
    fetch(`/api/crm/guests?q=${encodeURIComponent(query)}`)
      .then(r => r.json())
      .then(j => {
        if (j.error) { setError(j.error); setRows([]); return; }
        setRows(j.rows || []);
      })
      .catch(e => { setError(e?.message || 'Failed to load guests'); setRows([]); })
      .finally(() => setLoading(false));
  }, []);

  // Search with a light debounce.
  useEffect(() => {
    if (!allowed) return;
    const t = setTimeout(() => load(q), 250);
    return () => clearTimeout(t);
  }, [allowed, q, load]);

  /* ── detail open/load ── */

  const openGuest = (id: string) => {
    if (openId === id) { setOpenId(null); setDetail(null); return; }
    setOpenId(id);
    setDetail(null);
    setDetailError(null);
    setVisitForm({ bill_amount: '', order_id: '' });
    setDetailLoading(true);
    fetch(`/api/crm/guests/${id}`)
      .then(r => r.json())
      .then(j => {
        if (j.error) { setDetailError(j.error); return; }
        setDetail(j);
        setEditForm({
          name: j.guest?.name || '',
          birthday: j.guest?.birthday || '',
          notes: j.guest?.notes || '',
        });
      })
      .catch(e => setDetailError(e?.message || 'Failed to load guest'))
      .finally(() => setDetailLoading(false));
  };

  const refreshDetail = (id: string) => {
    fetch(`/api/crm/guests/${id}`)
      .then(r => r.json())
      .then(j => { if (!j.error) setDetail(j); })
      .catch(() => {});
    load(q);
  };

  /* ── actions ── */

  const addGuest = async () => {
    if (saving) return;
    setSaving(true);
    setModalError(null);
    try {
      const r = await api('/api/crm/guests', { method: 'POST', body: addForm });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setModalError(j.error || `HTTP ${r.status}`); return; }
      setShowAdd(false);
      setAddForm({ ...EMPTY_FORM });
      setNotice(j.created ? 'Guest added' : 'Guest updated (mobile already existed)');
      load(q);
    } catch (e: any) {
      setModalError(e?.message || 'Failed to save guest');
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async (guest: Guest) => {
    if (detailBusy) return;
    setDetailBusy(true);
    setDetailError(null);
    try {
      const r = await api(`/api/crm/guests/${guest.id}`, { method: 'PUT', body: editForm });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setDetailError(j.error || `HTTP ${r.status}`); return; }
      setNotice('Guest details saved');
      refreshDetail(guest.id);
    } catch (e: any) {
      setDetailError(e?.message || 'Failed to save');
    } finally {
      setDetailBusy(false);
    }
  };

  const toggleActive = async (guest: Guest) => {
    if (detailBusy) return;
    setDetailBusy(true);
    setDetailError(null);
    try {
      const r = await api(`/api/crm/guests/${guest.id}`, {
        method: 'PUT',
        body: { is_active: guest.is_active ? 0 : 1 },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setDetailError(j.error || `HTTP ${r.status}`); return; }
      setNotice(guest.is_active ? 'Guest deactivated' : 'Guest reactivated');
      refreshDetail(guest.id);
    } catch (e: any) {
      setDetailError(e?.message || 'Failed to update');
    } finally {
      setDetailBusy(false);
    }
  };

  const recordVisit = async (guest: Guest) => {
    const bill = parseFloat(visitForm.bill_amount);
    if (detailBusy || !Number.isFinite(bill) || bill < 0) return;
    setDetailBusy(true);
    setDetailError(null);
    try {
      const r = await api('/api/crm/guests/visit', {
        method: 'POST',
        body: {
          mobile: guest.mobile,
          bill_amount: bill,
          order_id: visitForm.order_id || undefined,
          source: 'manual',
        },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setDetailError(j.error || `HTTP ${r.status}`); return; }
      setVisitForm({ bill_amount: '', order_id: '' });
      setNotice(`Visit recorded — ${guest.name || guest.mobile} now has ${Math.round(j.guest?.points || 0)} pts`);
      refreshDetail(guest.id);
    } catch (e: any) {
      setDetailError(e?.message || 'Failed to record visit');
    } finally {
      setDetailBusy(false);
    }
  };

  /* ── derived: upcoming birthdays (next 30 days) ── */
  const upcomingBirthdays = rows
    .map(g => ({ g, days: daysToBirthday(g.birthday) }))
    .filter((x): x is { g: Guest; days: number } => x.days != null && x.days <= 30 && !!x.g.is_active)
    .sort((a, b) => a.days - b.days);

  /* ── gates ── */
  if (me === undefined) {
    return (
      <div className="p-8 text-center text-sm text-[#8B7355]">
        <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…
      </div>
    );
  }
  if (!allowed) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <button
          onClick={() => router.back()}
          className="inline-flex items-center gap-1 text-sm text-[#6B5744] hover:text-[#2D1B0E] transition-colors mb-3"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
          🔒 Admins, managers and department heads only. The guest database holds
          customer contact details — ask an admin for access.
        </div>
      </div>
    );
  }

  /* ── detail panel (shared by cards + table) ── */
  const detailPanel = (guest: Guest) => (
    <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3 sm:p-4 space-y-4">
      {detailLoading && (
        <div className="text-sm text-[#8B7355]"><Loader2 className="w-4 h-4 animate-spin inline mr-1" /> Loading guest…</div>
      )}
      {detailError && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg px-2.5 py-1.5">
          <AlertCircle size={13} className="shrink-0" /> {detailError}
        </div>
      )}
      {detail && detail.guest.id === guest.id && (
        <>
          {/* Points + status summary */}
          <div className="flex flex-wrap items-center gap-2 text-xs text-[#6B5744]">
            <Gift size={14} className="text-[#af4408]" />
            <span className="font-semibold text-[#2D1B0E]">{detail.guest.points.toFixed(1)} points</span>
            <TierBadge tier={detail.guest.tier} />
            <span>· first visit {fmtDate(detail.guest.first_visit_at)}</span>
            {!detail.guest.is_active && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200">inactive</span>
            )}
          </div>

          {/* Record visit */}
          <div className="space-y-1.5">
            <div className="text-xs font-semibold text-[#2D1B0E] uppercase tracking-wide">Record Visit</div>
            <div className="flex flex-wrap gap-2">
              <input
                type="number" min="0" inputMode="decimal" placeholder="Bill amount ₹"
                value={visitForm.bill_amount}
                onChange={e => setVisitForm(f => ({ ...f, bill_amount: e.target.value }))}
                className="w-32 border border-[#E8D5C4] rounded-lg px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:border-[#af4408]"
              />
              <input
                type="text" placeholder="Order # (optional)"
                value={visitForm.order_id}
                onChange={e => setVisitForm(f => ({ ...f, order_id: e.target.value }))}
                className="w-36 border border-[#E8D5C4] rounded-lg px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:border-[#af4408]"
              />
              <button
                onClick={() => recordVisit(detail.guest)}
                disabled={detailBusy || !(parseFloat(visitForm.bill_amount) >= 0) || visitForm.bill_amount === ''}
                className="inline-flex items-center gap-1.5 bg-[#af4408] hover:bg-[#8a3606] text-white text-sm rounded-lg px-3 py-1.5 disabled:opacity-50"
              >
                {detailBusy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Record
              </button>
            </div>
          </div>

          {/* Edit profile */}
          <div className="space-y-1.5">
            <div className="text-xs font-semibold text-[#2D1B0E] uppercase tracking-wide">Details</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input
                type="text" placeholder="Name" value={editForm.name}
                onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                className="border border-[#E8D5C4] rounded-lg px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:border-[#af4408]"
              />
              <input
                type="text" placeholder="Birthday (YYYY-MM-DD or MM-DD)" value={editForm.birthday}
                onChange={e => setEditForm(f => ({ ...f, birthday: e.target.value }))}
                className="border border-[#E8D5C4] rounded-lg px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:border-[#af4408]"
              />
              <textarea
                placeholder="Notes (preferences, allergies, VIP…)" value={editForm.notes} rows={2}
                onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))}
                className="sm:col-span-2 border border-[#E8D5C4] rounded-lg px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:border-[#af4408]"
              />
            </div>
            <div className="flex flex-wrap gap-2 pt-0.5">
              <button
                onClick={() => saveEdit(detail.guest)}
                disabled={detailBusy}
                className="inline-flex items-center gap-1.5 bg-white border border-[#E8D5C4] hover:border-[#af4408] text-[#2D1B0E] text-sm rounded-lg px-3 py-1.5 disabled:opacity-50"
              >
                <Pencil size={13} /> Save details
              </button>
              <button
                onClick={() => toggleActive(detail.guest)}
                disabled={detailBusy}
                className={`inline-flex items-center gap-1.5 text-sm rounded-lg px-3 py-1.5 border disabled:opacity-50 ${
                  detail.guest.is_active
                    ? 'bg-white border-red-200 text-red-700 hover:border-red-400'
                    : 'bg-white border-green-200 text-green-700 hover:border-green-400'
                }`}
              >
                {detail.guest.is_active ? <X size={13} /> : <CheckCircle2 size={13} />}
                {detail.guest.is_active ? 'Deactivate' : 'Reactivate'}
              </button>
            </div>
          </div>

          {/* Visit history */}
          <div className="space-y-1.5">
            <div className="text-xs font-semibold text-[#2D1B0E] uppercase tracking-wide">
              Visit History <span className="font-normal text-[#8B7355]">(last {detail.visits.length})</span>
            </div>
            {detail.visits.length === 0 ? (
              <div className="text-xs text-[#8B7355]">No visits recorded yet.</div>
            ) : (
              <div className="divide-y divide-[#F0E4D6] border border-[#E8D5C4] rounded-lg bg-white overflow-hidden">
                {detail.visits.map(v => (
                  <div key={v.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-1.5 text-xs">
                    <span className="text-[#2D1B0E] font-medium w-24">{fmtDate(v.visited_at)}</span>
                    <span className="text-[#2D1B0E]">{inr(v.bill_amount)}</span>
                    <span className="text-[#af4408]">+{v.points_earned.toFixed(1)} pts</span>
                    <span className="text-[#8B7355]">{v.source}</span>
                    {v.order_id && <span className="text-[#8B7355] truncate">#{v.order_id}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-6xl mx-auto pb-16">
      {/* Header */}
      <div>
        <button
          onClick={() => router.back()}
          className="inline-flex items-center gap-1 text-sm text-[#6B5744] hover:text-[#2D1B0E] transition-colors mb-2"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-[#af4408] text-white flex items-center justify-center shrink-0">
            <Users size={20} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl sm:text-2xl font-bold text-[#2D1B0E]">Guests & Loyalty</h1>
            <p className="text-xs text-[#8B7355]">
              Guest database with visits, spend & loyalty points — Bronze / Silver / Gold
            </p>
          </div>
          <button
            onClick={() => load(q)}
            disabled={loading}
            className="inline-flex items-center gap-1.5 bg-white border border-[#E8D5C4] hover:border-[#af4408] text-[#2D1B0E] text-sm rounded-lg px-3 py-2 disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          <button
            onClick={() => { setShowAdd(true); setModalError(null); }}
            className="inline-flex items-center gap-1.5 bg-[#af4408] hover:bg-[#8a3606] text-white text-sm rounded-lg px-3 py-2"
          >
            <UserPlus size={14} /> Add Guest
          </button>
        </div>
      </div>

      {/* Notice / error banners */}
      {notice && (
        <div className="flex items-center justify-between gap-2 bg-green-50 border border-green-200 text-green-800 text-sm rounded-lg px-3 py-2">
          <span className="flex items-center gap-2"><CheckCircle2 size={15} className="shrink-0" /> {notice}</span>
          <button onClick={() => setNotice(null)} className="text-green-700 hover:text-green-900"><X size={14} /></button>
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2">
          <AlertCircle size={15} className="shrink-0" /> {error}
        </div>
      )}

      {/* Upcoming birthdays (next 30 days) */}
      {upcomingBirthdays.length > 0 && (
        <div className="bg-[#FFF3E6] border border-[#F2C79B] rounded-lg p-3">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-[#8a3606] uppercase tracking-wide mb-1.5">
            <Cake size={14} /> Birthdays — next 30 days
          </div>
          <div className="flex flex-wrap gap-1.5">
            {upcomingBirthdays.map(({ g, days }) => (
              <button
                key={g.id}
                onClick={() => openGuest(g.id)}
                className="inline-flex items-center gap-1.5 bg-white border border-[#F2C79B] hover:border-[#af4408] rounded-full px-2.5 py-1 text-xs text-[#2D1B0E]"
              >
                <span className="font-medium">{g.name || g.mobile}</span>
                <span className="text-[#af4408] font-semibold">
                  {days === 0 ? 'today 🎂' : days === 1 ? 'tomorrow' : `in ${days}d`}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Search */}
      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8B7355]" />
        <input
          type="text"
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search by name or mobile…"
          className="w-full border border-[#E8D5C4] rounded-lg pl-9 pr-3 py-2 text-sm bg-white focus:outline-none focus:border-[#af4408]"
        />
      </div>

      {/* Loading / empty */}
      {loading && rows.length === 0 && (
        <div className="p-8 text-center text-sm text-[#8B7355]">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading guests…
        </div>
      )}
      {!loading && rows.length === 0 && !error && (
        <div className="bg-white border border-[#E8D5C4] rounded-lg p-8 text-center text-sm text-[#8B7355]">
          {q ? <>No guests match “{q}”.</> : <>No guests yet — tap <span className="font-semibold">Add Guest</span> or record a visit to start building your database.</>}
        </div>
      )}

      {/* Cards (mobile) */}
      {rows.length > 0 && (
        <div className="md:hidden space-y-2">
          {rows.map(g => (
            <div key={g.id} className={`bg-white border rounded-lg ${openId === g.id ? 'border-[#af4408]' : 'border-[#E8D5C4]'} ${!g.is_active ? 'opacity-60' : ''}`}>
              <button onClick={() => openGuest(g.id)} className="w-full text-left p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-sm text-[#2D1B0E] truncate">
                      {g.name || <span className="text-[#8B7355] font-normal italic">No name</span>}
                    </div>
                    <div className="flex items-center gap-1 text-xs text-[#6B5744]">
                      <Phone size={11} /> {g.mobile}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <TierBadge tier={g.tier} />
                    {openId === g.id ? <ChevronUp size={15} className="text-[#8B7355]" /> : <ChevronDown size={15} className="text-[#8B7355]" />}
                  </div>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-2 text-xs text-[#6B5744]">
                  <span>{g.visit_count} visit{g.visit_count === 1 ? '' : 's'}</span>
                  <span>{inr(g.total_spend)} spent</span>
                  <span className="text-[#af4408] font-semibold">{g.points.toFixed(0)} pts</span>
                  <span>last: {fmtDate(g.last_visit_at)}</span>
                </div>
              </button>
              {openId === g.id && <div className="px-3 pb-3">{detailPanel(g)}</div>}
            </div>
          ))}
        </div>
      )}

      {/* Table (md+) */}
      {rows.length > 0 && (
        <div className="hidden md:block bg-white border border-[#E8D5C4] rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[#FFF8F0] text-left text-xs text-[#8B7355] uppercase tracking-wide">
                <th className="px-4 py-2.5 font-semibold">Guest</th>
                <th className="px-4 py-2.5 font-semibold">Mobile</th>
                <th className="px-4 py-2.5 font-semibold text-right">Visits</th>
                <th className="px-4 py-2.5 font-semibold text-right">Total Spend</th>
                <th className="px-4 py-2.5 font-semibold text-right">Points</th>
                <th className="px-4 py-2.5 font-semibold">Tier</th>
                <th className="px-4 py-2.5 font-semibold">Last Visit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F0E4D6]">
              {rows.map(g => (
                <Fragment key={g.id}>
                  <tr
                    onClick={() => openGuest(g.id)}
                    className={`cursor-pointer hover:bg-[#FFF8F0] ${openId === g.id ? 'bg-[#FFF8F0]' : ''} ${!g.is_active ? 'opacity-60' : ''}`}
                  >
                    <td className="px-4 py-2.5 font-medium text-[#2D1B0E]">
                      {g.name || <span className="text-[#8B7355] font-normal italic">No name</span>}
                      {!g.is_active && <span className="ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200">inactive</span>}
                    </td>
                    <td className="px-4 py-2.5 text-[#6B5744]">{g.mobile}</td>
                    <td className="px-4 py-2.5 text-right text-[#2D1B0E]">{g.visit_count}</td>
                    <td className="px-4 py-2.5 text-right text-[#2D1B0E]">{inr(g.total_spend)}</td>
                    <td className="px-4 py-2.5 text-right font-semibold text-[#af4408]">{g.points.toFixed(0)}</td>
                    <td className="px-4 py-2.5"><TierBadge tier={g.tier} /></td>
                    <td className="px-4 py-2.5 text-[#6B5744]">{fmtDate(g.last_visit_at)}</td>
                  </tr>
                  {openId === g.id && (
                    <tr>
                      <td colSpan={7} className="px-4 py-3 bg-[#FFFDF9]">{detailPanel(g)}</td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add Guest modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setShowAdd(false)}>
          <div
            className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl p-4 sm:p-5 space-y-3"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-[#2D1B0E] flex items-center gap-2">
                <UserPlus size={18} className="text-[#af4408]" /> Add Guest
              </h2>
              <button onClick={() => setShowAdd(false)} className="text-[#8B7355] hover:text-[#2D1B0E]"><X size={18} /></button>
            </div>
            {modalError && (
              <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg px-2.5 py-1.5">
                <AlertCircle size={13} className="shrink-0" /> {modalError}
              </div>
            )}
            <div className="space-y-2">
              <input
                type="tel" inputMode="numeric" placeholder="Mobile (10 digits) *" value={addForm.mobile}
                onChange={e => setAddForm(f => ({ ...f, mobile: e.target.value }))}
                className="w-full border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#af4408]"
              />
              <input
                type="text" placeholder="Name" value={addForm.name}
                onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))}
                className="w-full border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#af4408]"
              />
              <input
                type="text" placeholder="Birthday (YYYY-MM-DD or MM-DD)" value={addForm.birthday}
                onChange={e => setAddForm(f => ({ ...f, birthday: e.target.value }))}
                className="w-full border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#af4408]"
              />
              <textarea
                placeholder="Notes" rows={2} value={addForm.notes}
                onChange={e => setAddForm(f => ({ ...f, notes: e.target.value }))}
                className="w-full border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#af4408]"
              />
            </div>
            <button
              onClick={addGuest}
              disabled={saving || addForm.mobile.replace(/\D/g, '').length < 10}
              className="w-full inline-flex items-center justify-center gap-1.5 bg-[#af4408] hover:bg-[#8a3606] text-white text-sm font-semibold rounded-lg px-3 py-2.5 disabled:opacity-50"
            >
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} Save Guest
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
