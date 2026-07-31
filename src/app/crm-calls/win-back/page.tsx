'use client';

/**
 * CRM — Win-back (/crm-calls/win-back). Management only.
 *
 * Two tabs over one idea: who has stopped coming, and what did asking them
 * back actually earn.
 *
 *   SEGMENT   — the lapsed-guest list for a 30 / 60 / 90 / 120-day bucket
 *               (default from ct_settings.lapsed_days). Sortable by spend and
 *               visits, per-row select, and a running count of exactly who a
 *               campaign would reach.
 *   CAMPAIGNS — every campaign with its send state and its attribution:
 *               how many of the people we messaged actually came back, and
 *               what they spent when they did.
 *
 * SENDING IS ALWAYS A DELIBERATE ACT. Creating a campaign only writes a draft.
 * The Send button opens a confirmation showing the exact recipient count and
 * the rendered message, and the POST carries an expected-count the server
 * re-checks. Nothing here sends on mount, on interval, or on tab change.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { formatPhone } from '@/lib/ct/phone';
import Toggle from '@/components/Toggle';
import {
  HeartHandshake, Send, Users, AlertCircle, Loader2, RefreshCw, Download,
  CheckCircle, XCircle, IndianRupee, CalendarClock, ArrowUpDown, ChevronLeft,
  Megaphone, ShieldAlert, Info, Trash2, MessageSquare, TrendingUp,
} from 'lucide-react';

// ── Types (mirror the API responses) ────────────────────────────────────────

interface WinbackGuest {
  guest_id: string;
  synthetic: boolean;
  key10: string;
  phone_e164: string;
  name: string;
  last_visit_at: string | null;
  last_visit_source: 'booking' | 'dining' | 'loyalty' | '';
  days_since: number | null;
  band: string;
  visits: number;
  visits_bookings: number;
  visits_loyalty: number;
  visits_dining: number;
  total_spend: number;
  last_items: string[];
  contactable: boolean;
  tags: string[];
}

interface TemplateRow {
  name: string;
  category: string;
  language: string;
  body: string;
  provider_template_name: string;
  provider_language: string;
  param_order: string;
  send_as_template: number;
}

interface SegmentResponse {
  bucket_days: number;
  cutoff_date: string;
  today: string;
  include_never: boolean;
  counts: {
    total_guests: number; active: number; never: number;
    b30: number; b60: number; b90: number; b120: number;
    in_bucket: number; unreachable: number;
  };
  guests: WinbackGuest[];
  buckets: number[];
  flag: { key: string; enabled: boolean };
  default_days: number;
  wa: { configured: boolean; provider: string; notifications_enabled: boolean };
  templates: TemplateRow[];
  can_configure: boolean;
}

interface CampaignMeta {
  bucket_days: number; include_never: boolean; cutoff_date: string;
  provider_template: string; language: string; param_order: string[];
  preview_body: string; attribution_days: number;
  skipped_no_phone: number; deduped: number; selected_count: number;
}

interface Counts { pending: number; sending: number; sent: number; failed: number; skipped: number; total: number }
interface Attribution { returned: number; return_value: number; returned_without_value: number; return_rate: number }

interface CampaignSummary {
  id: string; name: string; segment: string; template: string;
  status: string; created_by: string; created_at: string; sent_at: string | null;
  meta: CampaignMeta; counts: Counts; attribution: Attribution;
}

interface TargetRow {
  id: string; campaign_id: string; guest_id: string | null; phone_e164: string; name: string;
  send_status: string; send_error: string; sent_at: string | null;
  returned_at: string | null; return_value: number | null; created_at: string;
}

interface CampaignDetail {
  campaign: CampaignSummary;
  meta: CampaignMeta;
  counts: Counts;
  attribution: Attribution;
  targets: TargetRow[];
  sample_preview: string;
  flag: { key: string; enabled: boolean };
  wa: { configured: boolean; provider: string };
}

type SortKey = 'days' | 'spend' | 'visits' | 'name' | 'last_visit';

const money = (n: number) => `₹${Math.round(n || 0).toLocaleString('en-IN')}`;
const dateLabel = (s: string | null) => {
  if (!s) return '—';
  const d = new Date(s.length === 10 ? `${s}T00:00:00Z` : s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
};

const SOURCE_LABEL: Record<string, string> = {
  booking: 'seated booking',
  dining: 'settled bill',
  loyalty: 'loyalty visit',
  '': 'no visit on record',
};

const BAND_STYLE: Record<string, string> = {
  '30-59': 'bg-[#FFF1E3] text-[#8a5a1f] border-[#F0D9BE]',
  '60-89': 'bg-[#FDECD8] text-[#8a4408] border-[#EFC79A]',
  '90-119': 'bg-[#FBE0C8] text-[#7a3a06] border-[#E8B47F]',
  '120+': 'bg-[#F6D2B4] text-[#6b2f04] border-[#DDA26A]',
  never: 'bg-[#EFEAE4] text-[#6B5744] border-[#DED3C6]',
  active: 'bg-emerald-50 text-emerald-700 border-emerald-200',
};

const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-[#EFEAE4] text-[#6B5744] border-[#DED3C6]',
  sending: 'bg-amber-50 text-amber-800 border-amber-200',
  sent: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  failed: 'bg-red-50 text-red-700 border-red-200',
};

export default function WinBackPage() {
  const [tab, setTab] = useState<'segment' | 'campaigns'>('segment');
  const [seg, setSeg] = useState<SegmentResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [days, setDays] = useState<number | null>(null);
  const [includeNever, setIncludeNever] = useState(false);
  const [sort, setSort] = useState<SortKey>('days');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [detail, setDetail] = useState<CampaignDetail | null>(null);
  const [showBuilder, setShowBuilder] = useState(false);
  const [confirmSend, setConfirmSend] = useState<{ count: number; preview: string } | null>(null);

  // ── Load ──────────────────────────────────────────────────────────────────

  const loadSegment = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    setError('');
    try {
      const qs = new URLSearchParams({ sort, dir, limit: '2000' });
      if (days != null) qs.set('days', String(days));
      if (includeNever) qs.set('include_never', '1');
      const res = await api(`/api/crm-calls/winback?${qs}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setSeg(j);
      if (days == null) setDays(j.bucket_days);
    } catch (e: any) {
      setError(e?.message || 'Could not load the win-back segment');
    } finally {
      setLoading(false);
    }
  }, [days, includeNever, sort, dir]);

  const loadCampaigns = useCallback(async () => {
    try {
      const res = await api('/api/crm-calls/campaigns');
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setCampaigns(j.campaigns || []);
    } catch (e: any) {
      setError(e?.message || 'Could not load campaigns');
    }
  }, []);

  useEffect(() => { loadSegment(); }, [loadSegment]);
  useEffect(() => { if (tab === 'campaigns') loadCampaigns(); }, [tab, loadCampaigns]);

  // Selection resets whenever the underlying list changes — a checkbox must
  // never carry over onto a different guest.
  useEffect(() => { setSelected(new Set()); }, [days, includeNever]);

  const guests = useMemo(() => seg?.guests ?? [], [seg]);
  const selectable = useMemo(() => guests.filter(g => g.contactable), [guests]);
  const chosen = useMemo(
    () => (selected.size ? selectable.filter(g => selected.has(g.guest_id)) : selectable),
    [selectable, selected],
  );

  const toggleSort = (k: SortKey) => {
    if (sort === k) setDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSort(k); setDir(k === 'name' ? 'asc' : 'desc'); }
  };

  const setFlag = async (next: boolean) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const res = await api('/api/crm-calls/winback', { method: 'PUT', body: { winback_enabled: next ? '1' : '0' } });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setSeg(s => (s ? { ...s, flag: j.flag } : s));
      setNotice(next ? 'Win-back sending is now ENABLED. Campaigns can message guests.' : 'Win-back sending is OFF. No campaign can message anyone.');
    } catch (e: any) { setError(e?.message || 'Could not change the setting'); }
    finally { setBusy(false); }
  };

  const openCampaign = async (id: string) => {
    setBusy(true); setError('');
    try {
      const res = await api(`/api/crm-calls/campaigns/${id}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setDetail(j);
    } catch (e: any) { setError(e?.message || 'Could not open the campaign'); }
    finally { setBusy(false); }
  };

  const doSend = async (expect: number) => {
    if (!detail) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const res = await api(`/api/crm-calls/campaigns/${detail.campaign.id}/send`, {
        method: 'POST',
        body: { confirm: true, expect_count: expect },
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setNotice(`Sent ${j.sent}, failed ${j.failed}${j.remaining ? `, ${j.remaining} still queued` : ''}${j.unconfirmed ? `, ${j.unconfirmed} unconfirmed` : ''}.`);
      setConfirmSend(null);
      await openCampaign(detail.campaign.id);
      await loadCampaigns();
    } catch (e: any) { setError(e?.message || 'Send failed'); setConfirmSend(null); }
    finally { setBusy(false); }
  };

  const deleteDraft = async (id: string) => {
    if (!confirm('Discard this draft campaign? It has not messaged anyone.')) return;
    setBusy(true); setError('');
    try {
      const res = await api(`/api/crm-calls/campaigns/${id}`, { method: 'DELETE' });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setDetail(null);
      await loadCampaigns();
      setNotice('Draft discarded.');
    } catch (e: any) { setError(e?.message || 'Could not discard the draft'); }
    finally { setBusy(false); }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading && !seg) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] p-6 animate-pulse">
        <div className="max-w-[100rem] mx-auto space-y-6">
          <div className="h-9 w-64 bg-[#FFF1E3] rounded-lg" />
          <div className="h-24 bg-white border border-[#E8D5C4] rounded-2xl" />
          <div className="bg-white border border-[#E8D5C4] rounded-2xl h-96" />
        </div>
      </div>
    );
  }

  const flagOn = !!seg?.flag.enabled;
  const waOk = !!seg?.wa.configured;

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-[100rem] mx-auto px-3 sm:px-6 py-5 sm:py-6 space-y-4 sm:space-y-5">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold text-[#6B5744] uppercase tracking-wider">CRM · Call to Table</p>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#2D1B0E] mt-0.5 flex items-center gap-2">
              <HeartHandshake className="w-7 h-7 text-[#af4408]" /> Win-back
            </h1>
            <p className="text-sm text-[#6B5744] mt-1">
              Guests who have stopped coming — and what asking them back actually earned.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => (tab === 'segment' ? loadSegment({ silent: true }) : loadCampaigns())}
              disabled={busy}
              className="flex items-center gap-2 px-3 py-2.5 bg-white border border-[#E0D0BE] hover:border-[#af4408] hover:bg-[#FFF1E3] text-[#6B5744] rounded-xl text-sm font-medium shadow-sm transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} /> Refresh
            </button>
            {tab === 'segment' && (
              <a
                href={`/api/crm-calls/winback?format=csv&days=${days ?? 60}${includeNever ? '&include_never=1' : ''}&sort=${sort}&dir=${dir}`}
                className="flex items-center gap-2 px-3 py-2.5 bg-white border border-[#E0D0BE] hover:border-[#af4408] hover:bg-[#FFF1E3] text-[#6B5744] rounded-xl text-sm font-medium shadow-sm transition-colors"
              >
                <Download className="w-4 h-4" /><span className="hidden sm:inline">Export CSV</span>
              </a>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 bg-white border border-[#E8D5C4] rounded-xl p-1 w-fit shadow-sm">
          {(['segment', 'campaigns'] as const).map(t => (
            <button
              key={t}
              onClick={() => { setTab(t); setDetail(null); }}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
                tab === t ? 'bg-[#af4408] text-white' : 'text-[#6B5744] hover:bg-[#FFF1E3]'
              }`}
            >
              {t === 'segment' ? 'Lapsed segment' : 'Campaigns'}
            </button>
          ))}
        </div>

        {/* Safety banner — always visible, states the truth about sending */}
        <div className={`rounded-2xl border p-4 ${flagOn ? 'bg-amber-50 border-amber-200' : 'bg-white border-[#E8D5C4]'}`}>
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
            <div className="flex items-start gap-2.5">
              {flagOn ? <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" /> : <Info className="w-5 h-5 text-[#8B7355] shrink-0 mt-0.5" />}
              <div className="text-sm">
                <p className="font-semibold text-[#2D1B0E]">
                  {flagOn ? 'Win-back sending is ENABLED' : 'Win-back sending is OFF'}
                </p>
                <p className="text-[#6B5744] mt-0.5">
                  {flagOn
                    ? 'Campaigns can message guests — but only when someone presses Send and confirms the recipient count.'
                    : 'You can build and review lists and drafts. No campaign can message anyone until an admin turns this on.'}
                  {' '}WhatsApp provider:{' '}
                  <span className={waOk ? 'text-emerald-700 font-medium' : 'text-red-700 font-medium'}>
                    {waOk ? `configured (${seg?.wa.provider})` : 'not configured'}
                  </span>.
                </p>
              </div>
            </div>
            {seg?.can_configure ? (
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs text-[#6B5744]">{flagOn ? 'On' : 'Off'}</span>
                <Toggle checked={flagOn} onChange={setFlag} disabled={busy} label="Enable win-back sending" />
              </div>
            ) : (
              <span className="text-xs text-[#8B7355] shrink-0">Only an admin can change this</span>
            )}
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 p-4 bg-red-50 border border-red-200 rounded-xl">
            <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}
        {notice && (
          <div className="flex items-start gap-2 p-4 bg-emerald-50 border border-emerald-200 rounded-xl">
            <CheckCircle className="w-5 h-5 text-emerald-600 shrink-0" />
            <p className="text-sm text-emerald-800">{notice}</p>
            <button onClick={() => setNotice('')} className="ml-auto text-emerald-700 text-xs underline">dismiss</button>
          </div>
        )}

        {/* ─── SEGMENT TAB ─────────────────────────────────────────────── */}
        {tab === 'segment' && seg && (
          <>
            {/* Bucket selector */}
            <div className="bg-white border border-[#E8D5C4] rounded-2xl p-4 shadow-sm space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-[#6B5744] uppercase tracking-wider mr-1">Not seen in</span>
                {seg.buckets.map(b => (
                  <button
                    key={b}
                    onClick={() => setDays(b)}
                    className={`px-3.5 py-2 rounded-xl text-sm font-semibold border transition-colors ${
                      days === b
                        ? 'bg-[#af4408] text-white border-[#8a3506]'
                        : 'bg-white text-[#6B5744] border-[#E0D0BE] hover:border-[#af4408] hover:bg-[#FFF1E3]'
                    }`}
                  >
                    {b}+ days
                    <span className={`ml-1.5 text-xs ${days === b ? 'text-white/80' : 'text-[#8B7355]'}`}>
                      {b === 30 ? seg.counts.b30 : b === 60 ? seg.counts.b60 : b === 90 ? seg.counts.b90 : seg.counts.b120}
                    </span>
                  </button>
                ))}
                {seg.default_days === days && (
                  <span className="text-[11px] text-[#8B7355] px-2 py-1 bg-[#FFF1E3] rounded-lg border border-[#F0D9BE]">venue default</span>
                )}
                <div className="flex items-center gap-2 ml-auto">
                  <Toggle checked={includeNever} onChange={setIncludeNever} size="sm" label="Include never-visited guests" />
                  <span className="text-xs text-[#6B5744]">
                    Include never-visited <span className="text-[#8B7355]">({seg.counts.never})</span>
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Stat label="In this segment" value={String(seg.counts.in_bucket)} accent />
                <Stat label="Reachable on WhatsApp" value={String(seg.counts.in_bucket - seg.counts.unreachable)} />
                <Stat label="Guests we know" value={String(seg.counts.total_guests)} />
                <Stat label="Still active (<30d)" value={String(seg.counts.active)} />
              </div>

              <p className="text-xs text-[#8B7355]">
                Last visit before <strong className="text-[#6B5744]">{dateLabel(seg.cutoff_date)}</strong> (today {dateLabel(seg.today)}, IST).
                A visit is proved by a seated/completed booking, a settled bill carrying the guest&apos;s number, or a loyalty-desk visit —
                whichever is most recent.
              </p>
            </div>

            {/* Action bar */}
            <div className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between bg-white border border-[#E8D5C4] rounded-2xl p-3.5 shadow-sm">
              <div className="text-sm text-[#6B5744]">
                <strong className="text-[#2D1B0E]">{chosen.length}</strong> guest{chosen.length === 1 ? '' : 's'} would be messaged
                {selected.size > 0 ? ' (your selection)' : ' (everyone reachable in this bucket)'}
                {seg.counts.unreachable > 0 && (
                  <span className="text-[#8B7355]"> · {seg.counts.unreachable} skipped, no usable number</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {selected.size > 0 && (
                  <button onClick={() => setSelected(new Set())} className="px-3 py-2 text-xs font-medium text-[#af4408] hover:bg-[#FFF1E3] rounded-lg">
                    Clear selection
                  </button>
                )}
                <button
                  onClick={() => setShowBuilder(true)}
                  disabled={chosen.length === 0}
                  className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl text-sm font-semibold shadow-sm transition-colors"
                >
                  <Megaphone className="w-4 h-4" /> Create campaign
                </button>
              </div>
            </div>

            {/* Table */}
            {guests.length === 0 ? (
              <div className="bg-white border border-[#E8D5C4] rounded-2xl py-16 text-center">
                <Users className="w-10 h-10 text-[#D8C3A8] mx-auto mb-3" />
                <p className="text-[#6B5744] font-medium">Nobody has been away {days} days or more.</p>
                <p className="text-sm text-[#8B7355] mt-1">
                  Try a shorter window{!includeNever && seg.counts.never > 0 ? `, or include the ${seg.counts.never} guest(s) with no visit on record` : ''}.
                </p>
              </div>
            ) : (
              <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-[#FFF1E3] border-b border-[#E8D5C4]">
                      <tr className="text-left text-[11px] uppercase tracking-wider text-[#6B5744]">
                        <th className="px-3 py-3 w-10">
                          <input
                            type="checkbox"
                            aria-label="Select all reachable guests"
                            checked={selected.size > 0 && selected.size === selectable.length}
                            onChange={e => setSelected(e.target.checked ? new Set(selectable.map(g => g.guest_id)) : new Set())}
                            className="accent-[#af4408]"
                          />
                        </th>
                        <th className="px-3 py-3">
                          <SortBtn label="Guest" active={sort === 'name'} dir={dir} onClick={() => toggleSort('name')} />
                        </th>
                        <th className="px-3 py-3">
                          <SortBtn label="Last visit" active={sort === 'last_visit'} dir={dir} onClick={() => toggleSort('last_visit')} />
                        </th>
                        <th className="px-3 py-3">
                          <SortBtn label="Away" active={sort === 'days'} dir={dir} onClick={() => toggleSort('days')} />
                        </th>
                        <th className="px-3 py-3 text-right">
                          <SortBtn label="Visits" active={sort === 'visits'} dir={dir} onClick={() => toggleSort('visits')} right />
                        </th>
                        <th className="px-3 py-3 text-right">
                          <SortBtn label="Spend" active={sort === 'spend'} dir={dir} onClick={() => toggleSort('spend')} right />
                        </th>
                        <th className="px-3 py-3">Last ordered</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#F0E4D6]">
                      {guests.map(g => (
                        <tr key={g.guest_id} className={`hover:bg-[#FFFBF6] ${!g.contactable ? 'opacity-60' : ''}`}>
                          <td className="px-3 py-3">
                            <input
                              type="checkbox"
                              aria-label={`Select ${g.name || g.phone_e164}`}
                              disabled={!g.contactable}
                              checked={selected.has(g.guest_id)}
                              onChange={e => setSelected(prev => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(g.guest_id); else next.delete(g.guest_id);
                                return next;
                              })}
                              className="accent-[#af4408] disabled:opacity-40"
                            />
                          </td>
                          <td className="px-3 py-3">
                            <div className="font-medium text-[#2D1B0E]">
                              {g.synthetic || !g.guest_id
                                ? (g.name || 'Unnamed guest')
                                : <Link href={`/crm-calls/guests/${g.guest_id}`} className="hover:text-[#af4408] hover:underline">{g.name || 'Unnamed guest'}</Link>}
                            </div>
                            <div className="text-xs text-[#8B7355] flex items-center gap-1.5">
                              {formatPhone(g.phone_e164) || '—'}
                              {!g.contactable && <span className="text-red-600 font-medium">no usable number</span>}
                            </div>
                          </td>
                          <td className="px-3 py-3">
                            <div className="text-[#3D2614]">{dateLabel(g.last_visit_at)}</div>
                            <div className="text-[11px] text-[#8B7355]">{SOURCE_LABEL[g.last_visit_source]}</div>
                          </td>
                          <td className="px-3 py-3">
                            <span className={`inline-block px-2 py-0.5 rounded-lg border text-xs font-semibold ${BAND_STYLE[g.band] || BAND_STYLE.never}`}>
                              {g.days_since == null ? 'never' : `${g.days_since}d`}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-right tabular-nums text-[#3D2614]">{g.visits || '—'}</td>
                          <td className="px-3 py-3 text-right tabular-nums text-[#3D2614]">{g.total_spend ? money(g.total_spend) : '—'}</td>
                          <td className="px-3 py-3 text-xs text-[#6B5744] max-w-[18rem]">
                            {g.last_items.length ? g.last_items.join(', ') : <span className="text-[#B7A48C]">—</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}

        {/* ─── CAMPAIGNS TAB ───────────────────────────────────────────── */}
        {tab === 'campaigns' && !detail && (
          <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm overflow-hidden">
            {campaigns.length === 0 ? (
              <div className="py-16 text-center">
                <Megaphone className="w-10 h-10 text-[#D8C3A8] mx-auto mb-3" />
                <p className="text-[#6B5744] font-medium">No campaigns yet.</p>
                <p className="text-sm text-[#8B7355] mt-1">Build a list on the Lapsed segment tab, then create a campaign from it.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-[#FFF1E3] border-b border-[#E8D5C4]">
                    <tr className="text-left text-[11px] uppercase tracking-wider text-[#6B5744]">
                      <th className="px-3 py-3">Campaign</th>
                      <th className="px-3 py-3">Status</th>
                      <th className="px-3 py-3 text-right">Targets</th>
                      <th className="px-3 py-3 text-right">Sent</th>
                      <th className="px-3 py-3 text-right">Came back</th>
                      <th className="px-3 py-3 text-right">Attributed</th>
                      <th className="px-3 py-3" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#F0E4D6]">
                    {campaigns.map(c => (
                      <tr key={c.id} className="hover:bg-[#FFFBF6] cursor-pointer" onClick={() => openCampaign(c.id)}>
                        <td className="px-3 py-3">
                          <div className="font-medium text-[#2D1B0E]">{c.name}</div>
                          <div className="text-xs text-[#8B7355]">
                            {c.meta.bucket_days}+ day bucket · template <code className="text-[#6B5744]">{c.template || '—'}</code> · {dateLabel(c.created_at)}
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <span className={`inline-block px-2 py-0.5 rounded-lg border text-xs font-semibold ${STATUS_STYLE[c.status] || STATUS_STYLE.draft}`}>
                            {c.status}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">{c.counts.total}</td>
                        <td className="px-3 py-3 text-right tabular-nums">
                          {c.counts.sent}
                          {c.counts.failed > 0 && <span className="text-red-600 text-xs"> · {c.counts.failed} failed</span>}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">
                          {c.attribution.returned}
                          {c.counts.sent > 0 && <span className="text-xs text-[#8B7355]"> ({c.attribution.return_rate}%)</span>}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">
                          {c.attribution.return_value ? money(c.attribution.return_value) : '—'}
                        </td>
                        <td className="px-3 py-3 text-right text-[#af4408] text-xs font-medium">Open →</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ─── CAMPAIGN DETAIL ─────────────────────────────────────────── */}
        {tab === 'campaigns' && detail && (
          <CampaignDetailView
            detail={detail}
            busy={busy}
            onBack={() => setDetail(null)}
            onDelete={() => deleteDraft(detail.campaign.id)}
            onRequestSend={(count, preview) => setConfirmSend({ count, preview })}
            onRefresh={() => openCampaign(detail.campaign.id)}
          />
        )}
      </div>

      {/* Campaign builder */}
      {showBuilder && seg && (
        <CampaignBuilder
          seg={seg}
          chosen={chosen}
          selectedIds={selected.size ? Array.from(selected) : null}
          days={days ?? seg.bucket_days}
          includeNever={includeNever}
          onClose={() => setShowBuilder(false)}
          onCreated={async (id) => {
            setShowBuilder(false);
            setNotice('Draft campaign created. Nothing has been sent yet.');
            setTab('campaigns');
            await loadCampaigns();
            await openCampaign(id);
          }}
        />
      )}

      {/* Send confirmation — the last gate before a guest's phone buzzes */}
      {confirmSend && detail && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
          <div className="bg-white rounded-2xl border border-[#E8D5C4] shadow-xl max-w-lg w-full p-5 space-y-4">
            <h3 className="text-lg font-bold text-[#2D1B0E] flex items-center gap-2">
              <Send className="w-5 h-5 text-[#af4408]" /> Send to {confirmSend.count} guest{confirmSend.count === 1 ? '' : 's'}?
            </h3>
            <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-xl p-3">
              <p className="text-[11px] uppercase tracking-wider text-[#8B7355] mb-1.5">Message as the first recipient sees it</p>
              <p className="text-sm text-[#2D1B0E] whitespace-pre-wrap">
                {confirmSend.preview || <span className="text-[#8B7355] italic">No local copy of this template body — the approved template on {detail.wa.provider} decides the wording. Params sent: {detail.meta.param_order.join(', ') || 'none'}.</span>}
              </p>
            </div>
            <ul className="text-xs text-[#6B5744] space-y-1">
              <li>· Template <code className="text-[#2D1B0E]">{detail.campaign.template}</code> ({detail.meta.language}) — must already be APPROVED on {detail.wa.provider}.</li>
              <li>· Anyone already messaged in this campaign is skipped automatically.</li>
              <li>· This is marketing: only send to guests who have opted in.</li>
            </ul>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmSend(null)} className="px-4 py-2.5 text-sm font-medium text-[#6B5744] hover:bg-[#FFF1E3] rounded-xl">Cancel</button>
              <button
                onClick={() => doSend(confirmSend.count)}
                disabled={busy}
                className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 text-white rounded-xl text-sm font-semibold"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                Yes, send now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Small pieces ────────────────────────────────────────────────────────────

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-xl border p-3 ${accent ? 'bg-[#FFF1E3] border-[#F0D9BE]' : 'bg-[#FFFBF6] border-[#EFE1D0]'}`}>
      <p className="text-[11px] uppercase tracking-wider text-[#8B7355]">{label}</p>
      <p className={`text-xl font-bold tabular-nums ${accent ? 'text-[#af4408]' : 'text-[#2D1B0E]'}`}>{value}</p>
    </div>
  );
}

function SortBtn({ label, active, dir, onClick, right }: {
  label: string; active: boolean; dir: 'asc' | 'desc'; onClick: () => void; right?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1 uppercase tracking-wider ${right ? 'flex-row-reverse' : ''} ${active ? 'text-[#af4408]' : 'hover:text-[#af4408]'}`}
    >
      {label}
      <ArrowUpDown className={`w-3 h-3 ${active ? 'opacity-100' : 'opacity-40'}`} />
      {active && <span className="sr-only">{dir === 'asc' ? 'ascending' : 'descending'}</span>}
    </button>
  );
}

// ── Campaign builder modal ──────────────────────────────────────────────────

function CampaignBuilder({
  seg, chosen, selectedIds, days, includeNever, onClose, onCreated,
}: {
  seg: SegmentResponse;
  chosen: WinbackGuest[];
  selectedIds: string[] | null;
  days: number;
  includeNever: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState(`Win-back ${days}+ days · ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}`);
  const [templateName, setTemplateName] = useState('');
  const [language, setLanguage] = useState('en');
  const [paramOrder, setParamOrder] = useState('name');
  const [previewBody, setPreviewBody] = useState('');
  const [attributionDays, setAttributionDays] = useState(30);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  // Picking a stored template fills in everything the venue already recorded.
  const applyTemplate = (n: string) => {
    const t = seg.templates.find(x => x.name === n);
    if (!t) return;
    setTemplateName(t.provider_template_name || t.name);
    setLanguage(t.provider_language || t.language || 'en');
    setPreviewBody(t.body || '');
    try {
      const order = JSON.parse(t.param_order || '[]');
      if (Array.isArray(order) && order.length) setParamOrder(order.join(', '));
    } catch { /* keep current */ }
  };

  const order = paramOrder.split(',').map(s => s.trim()).filter(Boolean);
  const first = chosen[0];
  const vars: Record<string, string> = {
    name: first?.name || 'there',
    days: String(days),
    venue: '',
    phone: first?.phone_e164 || '',
  };
  const preview = useMemo(() => {
    let body = previewBody;
    if (!body) return '';
    order.forEach((k, i) => { body = body.split(`{{${i + 1}}}`).join(vars[k] ?? ''); });
    for (const [k, v] of Object.entries(vars)) body = body.split(`{{${k}}}`).join(v);
    return body;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewBody, paramOrder, first?.name, first?.phone_e164, days]);

  const submit = async () => {
    setSaving(true); setErr('');
    try {
      const res = await api('/api/crm-calls/campaigns', {
        method: 'POST',
        body: {
          name,
          days,
          include_never: includeNever,
          guest_ids: selectedIds,
          provider_template: templateName.trim(),
          language,
          param_order: order,
          preview_body: previewBody,
          attribution_days: attributionDays,
        },
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      onCreated(j.campaign.id);
    } catch (e: any) { setErr(e?.message || 'Could not create the campaign'); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-start sm:items-center justify-center p-4 overflow-y-auto" role="dialog" aria-modal="true">
      <div className="bg-white rounded-2xl border border-[#E8D5C4] shadow-xl max-w-2xl w-full p-5 space-y-4 my-8">
        <div>
          <h3 className="text-lg font-bold text-[#2D1B0E] flex items-center gap-2">
            <Megaphone className="w-5 h-5 text-[#af4408]" /> Create win-back campaign
          </h3>
          <p className="text-sm text-[#6B5744] mt-1">
            This creates a <strong>draft</strong> for <strong>{chosen.length}</strong> guest{chosen.length === 1 ? '' : 's'}. Nothing is sent until you press Send on the campaign.
          </p>
        </div>

        <div className="rounded-xl bg-[#FFF1E3] border border-[#F0D9BE] p-3 text-xs text-[#6B5744] space-y-1">
          <p className="font-semibold text-[#8a4408]">Before this can deliver</p>
          <p>· A win-back message is <strong>marketing</strong>. Meta only delivers it from a template your venue has submitted and had <strong>approved</strong> in the MARKETING category.</p>
          <p>· The guest must have opted in to marketing on WhatsApp. This screen does not — and cannot — create that consent.</p>
          <p>· Put the exact approved template name below. Getting it wrong means the provider rejects the send; it never silently becomes a plain text message.</p>
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs font-semibold text-[#6B5744] uppercase tracking-wider">Campaign name</span>
            <input value={name} onChange={e => setName(e.target.value)}
                   className="mt-1 w-full px-3 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]/40" />
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-[#6B5744] uppercase tracking-wider">Start from a saved template</span>
            <select onChange={e => applyTemplate(e.target.value)} defaultValue=""
                    className="mt-1 w-full px-3 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm">
              <option value="">— none —</option>
              {seg.templates.map(t => <option key={t.name} value={t.name}>{t.name} ({t.category})</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-[#6B5744] uppercase tracking-wider">Approved template name *</span>
            <input value={templateName} onChange={e => setTemplateName(e.target.value)} placeholder="akan_winback_offer"
                   className="mt-1 w-full px-3 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#af4408]/40" />
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-[#6B5744] uppercase tracking-wider">Language code</span>
            <input value={language} onChange={e => setLanguage(e.target.value)} placeholder="en"
                   className="mt-1 w-full px-3 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm" />
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-[#6B5744] uppercase tracking-wider">Body params, in order</span>
            <input value={paramOrder} onChange={e => setParamOrder(e.target.value)} placeholder="name, days"
                   className="mt-1 w-full px-3 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm" />
            <span className="text-[11px] text-[#8B7355]">Available: name, days, venue, phone → fills {'{{1}}'}, {'{{2}}'}, …</span>
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-[#6B5744] uppercase tracking-wider">Attribution window (days)</span>
            <input type="number" min={1} max={365} value={attributionDays}
                   onChange={e => setAttributionDays(Math.max(1, Math.min(365, Number(e.target.value) || 30)))}
                   className="mt-1 w-full px-3 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm" />
            <span className="text-[11px] text-[#8B7355]">A return after this many days is not credited to the campaign.</span>
          </label>
        </div>

        <label className="block">
          <span className="text-xs font-semibold text-[#6B5744] uppercase tracking-wider">Local copy of the approved body (preview only)</span>
          <textarea value={previewBody} onChange={e => setPreviewBody(e.target.value)} rows={3}
                    placeholder="Hi {{1}}, it has been a while! Come back to us this week — your table is waiting."
                    className="mt-1 w-full px-3 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm" />
        </label>

        {preview && (
          <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-xl p-3">
            <p className="text-[11px] uppercase tracking-wider text-[#8B7355] mb-1.5 flex items-center gap-1.5">
              <MessageSquare className="w-3.5 h-3.5" /> Preview for {first?.name || 'the first recipient'}
            </p>
            <p className="text-sm text-[#2D1B0E] whitespace-pre-wrap">{preview}</p>
          </div>
        )}

        {err && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl p-3">{err}</p>}

        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2.5 text-sm font-medium text-[#6B5744] hover:bg-[#FFF1E3] rounded-xl">Cancel</button>
          <button onClick={submit} disabled={saving || !templateName.trim() || !name.trim()}
                  className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-40 text-white rounded-xl text-sm font-semibold">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
            Create draft ({chosen.length})
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Campaign detail ─────────────────────────────────────────────────────────

function CampaignDetailView({
  detail, busy, onBack, onDelete, onRequestSend, onRefresh,
}: {
  detail: CampaignDetail;
  busy: boolean;
  onBack: () => void;
  onDelete: () => void;
  onRequestSend: (count: number, preview: string) => void;
  onRefresh: () => void;
}) {
  const { campaign, meta, counts, attribution, targets } = detail;
  const queued = counts.pending;
  const canSend = detail.flag.enabled && detail.wa.configured && queued > 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="flex items-center gap-1 text-sm text-[#af4408] hover:underline">
          <ChevronLeft className="w-4 h-4" /> All campaigns
        </button>
      </div>

      <div className="bg-white border border-[#E8D5C4] rounded-2xl p-4 shadow-sm space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold text-[#2D1B0E]">{campaign.name}</h2>
            <p className="text-sm text-[#6B5744] mt-0.5">
              {meta.bucket_days}+ day bucket{meta.include_never ? ' (incl. never-visited)' : ''} ·
              template <code className="text-[#2D1B0E]">{campaign.template}</code> ({meta.language}) ·
              created by {campaign.created_by || 'unknown'}
            </p>
            <p className="text-xs text-[#8B7355] mt-0.5">
              Attribution window {meta.attribution_days} days
              {meta.skipped_no_phone > 0 && ` · ${meta.skipped_no_phone} guest(s) skipped at build: no usable number`}
              {meta.deduped > 0 && ` · ${meta.deduped} duplicate number(s) collapsed`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onRefresh} disabled={busy}
                    className="flex items-center gap-2 px-3 py-2.5 bg-white border border-[#E0D0BE] hover:border-[#af4408] text-[#6B5744] rounded-xl text-sm font-medium disabled:opacity-50">
              <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} /> Refresh results
            </button>
            {counts.sent === 0 && counts.failed === 0 && counts.sending === 0 && (
              <button onClick={onDelete} disabled={busy}
                      className="flex items-center gap-2 px-3 py-2.5 bg-white border border-[#E0D0BE] hover:border-red-400 hover:text-red-700 text-[#6B5744] rounded-xl text-sm font-medium disabled:opacity-50">
                <Trash2 className="w-4 h-4" /> Discard
              </button>
            )}
            <button
              onClick={() => onRequestSend(Math.min(queued, 200), detail.sample_preview)}
              disabled={!canSend || busy}
              title={
                !detail.flag.enabled ? 'Win-back sending is switched off'
                  : !detail.wa.configured ? 'WhatsApp is not configured'
                  : queued === 0 ? 'Everyone in this campaign has already been messaged' : ''
              }
              className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl text-sm font-semibold shadow-sm"
            >
              <Send className="w-4 h-4" />
              {queued > 0 ? `Send to ${Math.min(queued, 200)}` : 'Nothing queued'}
            </button>
          </div>
        </div>

        {!detail.flag.enabled && queued > 0 && (
          <p className="text-xs text-[#8a4408] bg-[#FFF1E3] border border-[#F0D9BE] rounded-xl p-3">
            Sending is switched off, so the Send button is disabled. This draft is safe to keep — turning the flag on does not send anything by itself.
          </p>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <Stat label="Targets" value={String(counts.total)} />
          <Stat label="Sent" value={String(counts.sent)} />
          <Stat label="Failed / queued" value={`${counts.failed} / ${counts.pending}`} />
          <Stat label="Came back" value={`${attribution.returned}${counts.sent ? ` (${attribution.return_rate}%)` : ''}`} accent />
          <Stat label="Attributed revenue" value={attribution.return_value ? money(attribution.return_value) : '—'} accent />
        </div>

        {counts.sending > 0 && (
          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            {counts.sending} message(s) were claimed but never confirmed (the provider call was interrupted). They are deliberately NOT retried
            automatically — a retry could double-message the guest. Check the provider log before doing anything with them.
          </p>
        )}

        {attribution.returned_without_value > 0 && (
          <p className="text-xs text-[#6B5744] bg-[#FFFBF6] border border-[#EFE1D0] rounded-xl p-3 flex items-start gap-2">
            <TrendingUp className="w-4 h-4 shrink-0 mt-0.5 text-[#8B7355]" />
            {attribution.returned_without_value} guest(s) are proven to have come back but carry no bill we can link — their visit was recorded as a
            seated booking with no order tied to their number. The revenue figure above is therefore a floor, not the full picture.
          </p>
        )}
      </div>

      <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-[#FFF1E3] border-b border-[#E8D5C4]">
              <tr className="text-left text-[11px] uppercase tracking-wider text-[#6B5744]">
                <th className="px-3 py-3">Guest</th>
                <th className="px-3 py-3">Send</th>
                <th className="px-3 py-3">Sent at</th>
                <th className="px-3 py-3">Came back</th>
                <th className="px-3 py-3 text-right">Value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F0E4D6]">
              {targets.map(t => (
                <tr key={t.id} className="hover:bg-[#FFFBF6]">
                  <td className="px-3 py-2.5">
                    <div className="font-medium text-[#2D1B0E]">{t.name || 'Unnamed guest'}</div>
                    <div className="text-xs text-[#8B7355]">{formatPhone(t.phone_e164)}</div>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`inline-flex items-center gap-1 text-xs font-medium ${
                      t.send_status === 'sent' ? 'text-emerald-700'
                        : t.send_status === 'failed' ? 'text-red-700'
                        : t.send_status === 'sending' ? 'text-amber-700' : 'text-[#8B7355]'
                    }`}>
                      {t.send_status === 'sent' ? <CheckCircle className="w-3.5 h-3.5" />
                        : t.send_status === 'failed' ? <XCircle className="w-3.5 h-3.5" />
                        : <CalendarClock className="w-3.5 h-3.5" />}
                      {t.send_status}
                    </span>
                    {t.send_error && <div className="text-[11px] text-red-600 max-w-[20rem] truncate" title={t.send_error}>{t.send_error}</div>}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-[#6B5744]">{t.sent_at ? dateLabel(t.sent_at) : '—'}</td>
                  <td className="px-3 py-2.5 text-xs">
                    {t.returned_at
                      ? <span className="text-emerald-700 font-medium">{dateLabel(t.returned_at)}</span>
                      : <span className="text-[#8B7355]">not yet</span>}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-[#3D2614]">
                    {t.returned_at
                      ? (t.return_value != null ? money(t.return_value) : <span className="text-xs text-[#8B7355]">no bill linked</span>)
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-white border border-[#E8D5C4] rounded-2xl p-4 text-xs text-[#6B5744] space-y-1.5">
        <p className="font-semibold text-[#2D1B0E] flex items-center gap-1.5"><IndianRupee className="w-3.5 h-3.5" /> How &quot;came back&quot; is decided</p>
        <p>A return is proved by, in order: a <strong>settled order</strong> carrying the guest&apos;s number (the only source with money on it), a
        <strong> loyalty-desk visit</strong>, or a <strong>seated/completed booking</strong> (presence, no bill). The earliest proof inside the
        attribution window wins.</p>
        <p>Limits worth saying out loud: a walk-in who never gives a phone number is invisible here; this is last-touch, not causal — a guest who
        was coming anyway still counts; and a phone shared by a family credits the whole table to one person.</p>
      </div>
    </div>
  );
}
