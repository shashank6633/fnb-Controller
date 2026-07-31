'use client';

/**
 * CRM — Topic Alerts (/crm-calls/topics)
 *
 * Standing keyword rules over the call text we already hold (transcript +
 * Claude/Gemini analysis + the GRE's disposition note). Three stacked panels:
 *
 *   1. Recording switch — the master ct_settings flag `topic_tracking`. OFF by
 *      default; admin-only to change. While it is off, a scan can preview but
 *      records nothing, and the page says so plainly instead of pretending.
 *   2. Rules — CRUD (management), each with severity + Active + Notify, plus a
 *      one-click "Load example rules" that seeds 4 INACTIVE starters.
 *   3. Review — recent hits grouped by rule, each with the call, the guest and
 *      the excerpt that tripped it, and an Acknowledge action.
 *
 * The scan panel always shows COVERAGE (how many scanned calls carry any text
 * at all), because on a venue with no transcripts "0 hits" means "nothing to
 * read", not "nothing happened".
 *
 * Style mirrors the sibling CRM pages: cream board, white cards, #af4408
 * accent, lucide icons, api() for writes, plain fetch for reads.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { formatPhone } from '@/lib/ct/phone';
import Toggle from '@/components/Toggle';
import {
  Radar, RefreshCw, Plus, Pencil, Trash2, Check, CheckCheck, X, Loader2,
  AlertTriangle, Info, Flame, Search, Sparkles, PhoneCall, User, Eye, Save,
  ShieldOff, FileSearch,
} from 'lucide-react';

// ─── Types (mirror src/lib/ct/topics.ts) ────────────────────────────────────

type Severity = 'info' | 'attention' | 'urgent';

interface Rule {
  id: string;
  name: string;
  keywords: string[];
  severity: Severity;
  is_active: number;
  notify: number;
  created_by: string;
  created_at: string;
  hits?: number;
  open_hits?: number;
}

interface Hit {
  id: string;
  rule_id: string;
  call_id: string;
  guest_id: string | null;
  matched_term: string;
  excerpt: string;
  acknowledged: number;
  created_at: string;
  rule_name: string;
  severity: Severity;
  notify: number;
  guest_name: string | null;
  guest_phone: string | null;
  call_started_at: string | null;
  call_direction: string | null;
  call_status: string | null;
  call_agent: string | null;
  call_duration_sec: number | null;
}

interface HitGroup { rule: Rule; hits: Hit[] }

interface ScanRuleResult {
  rule_id: string; name: string; severity: Severity; is_active: number; notify: number;
  hits: number; calls: number; inserted: number; already_recorded: number;
  sample_call_id: string; sample_term: string; sample_excerpt: string;
}

interface ScanResult {
  enabled: boolean; dry_run: boolean; persisted: boolean; blocked_reason: string;
  from: string; to: string; rules_used: number;
  coverage: {
    calls: number; with_transcript: number; with_summary: number; with_outcome: number;
    with_note: number; with_any_text: number; transcript_lines: number; ratio: number;
  };
  total_hits: number; inserted: number; already_recorded: number;
  per_rule: ScanRuleResult[];
}

// ─── Presentation helpers ───────────────────────────────────────────────────

const SEVERITY_META: Record<Severity, { label: string; chip: string; Icon: typeof Info }> = {
  info:      { label: 'Info',      chip: 'bg-blue-50 text-blue-700 border-blue-200',   Icon: Info },
  attention: { label: 'Attention', chip: 'bg-amber-50 text-amber-700 border-amber-200', Icon: AlertTriangle },
  urgent:    { label: 'Urgent',    chip: 'bg-red-50 text-red-700 border-red-200',       Icon: Flame },
};

function istYmd(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/** Message from an unknown thrown value (no `any` in catch blocks). */
function errMsg(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

function prettyWhen(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

function SeverityChip({ severity }: { severity: Severity }) {
  const m = SEVERITY_META[severity] || SEVERITY_META.info;
  const { Icon } = m;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-semibold ${m.chip}`}>
      <Icon className="w-3 h-3" /> {m.label}
    </span>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function TopicAlertsPage() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [groups, setGroups] = useState<HitGroup[]>([]);
  const [tracking, setTracking] = useState(false);
  const [alertCount, setAlertCount] = useState(0);
  const [canManage, setCanManage] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; error?: boolean } | null>(null);

  // Scan panel
  const [from, setFrom] = useState(() => istYmd(new Date(Date.now() - 30 * 86400000)));
  const [to, setTo] = useState(() => istYmd(new Date()));
  const [includeInactive, setIncludeInactive] = useState(true);
  const [scan, setScan] = useState<ScanResult | null>(null);

  // Review filter
  const [openOnly, setOpenOnly] = useState(true);
  const [search, setSearch] = useState('');

  // Rule editor
  const [editing, setEditing] = useState<string | null>(null);   // rule id or 'new'
  const [form, setForm] = useState<{ name: string; keywords: string; severity: Severity; notify: boolean }>(
    { name: '', keywords: '', severity: 'info', notify: false },
  );

  const showToast = useCallback((msg: string, error = false) => {
    setToast({ msg, error });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const loadRules = useCallback(async () => {
    const res = await fetch('/api/crm-calls/topics/rules');
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const j = await res.json();
    setRules(j.rules || []);
    setTracking(j.topic_tracking === '1');
    setAlertCount(j.alert_count || 0);
    setCanManage(!!j.can_manage);
    setIsAdmin(!!j.is_admin);
  }, []);

  const loadHits = useCallback(async (onlyOpen: boolean) => {
    const qs = onlyOpen ? '?acknowledged=0' : '';
    const res = await fetch(`/api/crm-calls/topics/hits${qs}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const j = await res.json();
    setGroups(j.groups || []);
    setAlertCount(j.alert_count || 0);
  }, []);

  // Takes the filter explicitly (rather than closing over `openOnly`) so the
  // callback stays referentially stable — the mount effect below can then
  // depend on it honestly instead of silencing the lint rule.
  const reload = useCallback(async (onlyOpen: boolean) => {
    try {
      await Promise.all([loadRules(), loadHits(onlyOpen)]);
    } catch (e) {
      showToast(errMsg(e, 'Could not load topic alerts'), true);
    } finally {
      setLoading(false);
    }
  }, [loadRules, loadHits, showToast]);

  useEffect(() => { reload(true); }, [reload]);

  // ── Actions ───────────────────────────────────────────────────────────────

  async function toggleTracking(next: boolean) {
    setBusy('tracking');
    try {
      const res = await api('/api/crm-calls/topics/settings', {
        method: 'PUT', body: { topic_tracking: next ? '1' : '0' },
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'Could not change the setting');
      setTracking(j.topic_tracking === '1');
      showToast(next ? 'Topic alerts will now be recorded on scan.' : 'Recording off. Existing hits are kept.');
    } catch (e) {
      showToast(errMsg(e, 'Failed'), true);
    } finally { setBusy(null); }
  }

  async function runScan(dryRun: boolean) {
    setBusy(dryRun ? 'preview' : 'scan');
    try {
      const res = await api('/api/crm-calls/topics/scan', {
        method: 'POST',
        body: { from, to, dry_run: dryRun, include_inactive: dryRun && includeInactive },
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'Scan failed');
      setScan(j as ScanResult);
      if (!dryRun) {
        await reload(openOnly);
        showToast(j.persisted
          ? `Recorded ${j.inserted} new hit${j.inserted === 1 ? '' : 's'} (${j.already_recorded} already known).`
          : j.blocked_reason || 'Nothing recorded.', !j.persisted);
      } else {
        showToast(`Preview only — nothing written. ${j.total_hits} match${j.total_hits === 1 ? '' : 'es'} found.`);
      }
    } catch (e) {
      showToast(errMsg(e, 'Scan failed'), true);
    } finally { setBusy(null); }
  }

  async function seedRules() {
    setBusy('seed');
    try {
      const res = await api('/api/crm-calls/topics/seed', { method: 'POST' });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'Could not load examples');
      await reload(openOnly);
      showToast(j.created.length
        ? `Added ${j.created.length} example rule${j.created.length === 1 ? '' : 's'} — all inactive.`
        : 'All example rules are already present.');
    } catch (e) {
      showToast(errMsg(e, 'Failed'), true);
    } finally { setBusy(null); }
  }

  async function patchRule(id: string, patch: Record<string, unknown>) {
    setBusy(`rule:${id}`);
    try {
      const res = await api(`/api/crm-calls/topics/rules/${id}`, { method: 'PUT', body: patch });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'Update failed');
      await loadRules();
    } catch (e) {
      showToast(errMsg(e, 'Update failed'), true);
    } finally { setBusy(null); }
  }

  async function deleteRule(r: Rule) {
    const n = r.hits ?? 0;
    if (!confirm(`Delete "${r.name}"?${n ? `\n\n${n} recorded hit${n === 1 ? '' : 's'} will be deleted with it.` : ''}`)) return;
    setBusy(`rule:${r.id}`);
    try {
      const res = await api(`/api/crm-calls/topics/rules/${r.id}`, { method: 'DELETE' });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'Delete failed');
      await reload(openOnly);
      showToast(`Deleted "${r.name}"${j.hits_deleted ? ` and ${j.hits_deleted} hit(s)` : ''}.`);
    } catch (e) {
      showToast(errMsg(e, 'Delete failed'), true);
    } finally { setBusy(null); }
  }

  function startNew() {
    setEditing('new');
    setForm({ name: '', keywords: '', severity: 'info', notify: false });
  }
  function startEdit(r: Rule) {
    setEditing(r.id);
    setForm({ name: r.name, keywords: r.keywords.join(', '), severity: r.severity, notify: !!r.notify });
  }

  async function saveForm() {
    const name = form.name.trim();
    const keywords = form.keywords.split(/[,\n;]/).map(s => s.trim()).filter(Boolean);
    if (!name) return showToast('Give the rule a name.', true);
    if (!keywords.length) return showToast('Add at least one keyword.', true);
    setBusy('save');
    try {
      const isNew = editing === 'new';
      const res = await api(
        isNew ? '/api/crm-calls/topics/rules' : `/api/crm-calls/topics/rules/${editing}`,
        {
          method: isNew ? 'POST' : 'PUT',
          body: { name, keywords, severity: form.severity, notify: form.notify ? 1 : 0 },
        },
      );
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'Save failed');
      setEditing(null);
      await loadRules();
      showToast(isNew ? 'Rule created — inactive until you switch it on.' : 'Rule saved.');
    } catch (e) {
      showToast(errMsg(e, 'Save failed'), true);
    } finally { setBusy(null); }
  }

  async function ackHits(ids: string[], acknowledged: boolean) {
    if (!ids.length) return;
    setBusy(`ack:${ids[0]}`);
    try {
      const res = await api('/api/crm-calls/topics/hits', {
        method: 'PATCH', body: { ids, acknowledged: acknowledged ? 1 : 0 },
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'Could not update');
      await loadHits(openOnly);
      await loadRules();
    } catch (e) {
      showToast(errMsg(e, 'Could not update'), true);
    } finally { setBusy(null); }
  }

  // ── Derived ───────────────────────────────────────────────────────────────

  const visibleGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    return groups
      .map(g => ({
        ...g,
        hits: q
          ? g.hits.filter(h =>
              h.excerpt.toLowerCase().includes(q) ||
              h.matched_term.includes(q) ||
              (h.guest_name || '').toLowerCase().includes(q) ||
              (h.guest_phone || '').includes(q))
          : g.hits,
      }))
      .filter(g => g.hits.length > 0);
  }, [groups, search]);

  const totalShown = visibleGroups.reduce((s, g) => s + g.hits.length, 0);
  const activeRules = rules.filter(r => r.is_active).length;
  const missingExamples = rules.length === 0;

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] p-6 animate-pulse">
        <div className="max-w-[100rem] mx-auto space-y-6">
          <div className="h-9 w-64 bg-[#FFF1E3] rounded-lg" />
          <div className="h-24 bg-[#FFF1E3] rounded-2xl" />
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
            <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">CRM · Call to Table</p>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#2D1B0E] mt-0.5 flex items-center gap-3">
              <Radar className="w-6 h-6 text-[#af4408]" /> Topic Alerts
            </h1>
            <p className="text-[13px] text-[#6B5744] mt-1 max-w-2xl">
              Standing keyword rules over call transcripts and analysis we already hold. No AI call, no per-call cost —
              a rule only ever raises an in-app flag for someone to read.
            </p>
          </div>
          <button
            onClick={() => reload(openOnly)}
            className="self-start sm:self-auto flex items-center gap-2 px-3 sm:px-4 py-2.5 bg-white border border-[#E0D0BE] hover:bg-[#FFF1E3] text-[#6B5744] rounded-xl text-sm font-medium shadow-sm transition-colors"
          >
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        </div>

        {/* 1 — Recording switch */}
        <div className={`rounded-2xl border p-4 sm:p-5 ${tracking ? 'bg-white border-[#E8D5C4]' : 'bg-[#FFF1E3] border-[#F0D9C0]'}`}>
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
            <div className="flex items-center gap-3 flex-1 min-w-0">
              {tracking
                ? <Radar className="w-5 h-5 text-[#af4408] shrink-0" />
                : <ShieldOff className="w-5 h-5 text-[#8B7355] shrink-0" />}
              <div className="min-w-0">
                <p className="font-semibold text-[14px]">
                  Recording {tracking ? 'ON' : 'OFF'}
                  <span className="ml-2 font-normal text-[#8B7355]">
                    · {activeRules} active rule{activeRules === 1 ? '' : 's'} · {alertCount} open alert{alertCount === 1 ? '' : 's'}
                  </span>
                </p>
                <p className="text-[12px] text-[#6B5744] mt-0.5">
                  {tracking
                    ? 'A scan records hits for active rules. Preview still writes nothing.'
                    : 'Off is the default. Scans can preview, but nothing is written and nothing alerts anyone.'}
                </p>
              </div>
            </div>
            {isAdmin ? (
              <Toggle checked={tracking} onChange={toggleTracking} disabled={busy === 'tracking'} label="Record topic alerts" />
            ) : (
              <span className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider shrink-0">Admin only</span>
            )}
          </div>
        </div>

        {/* 2 — Scan */}
        {canManage && (
          <div className="bg-white border border-[#E8D5C4] rounded-2xl p-4 sm:p-5 space-y-4">
            <div className="flex items-center gap-2">
              <FileSearch className="w-4 h-4 text-[#af4408]" />
              <h2 className="font-bold text-[15px]">Scan a date range</h2>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-[12px] font-semibold text-[#6B5744]">
                From
                <input type="date" value={from} onChange={e => setFrom(e.target.value)}
                  className="block mt-1 h-10 px-3 rounded-xl border border-[#E0D0BE] bg-white text-[13px] font-normal text-[#2D1B0E]" />
              </label>
              <label className="text-[12px] font-semibold text-[#6B5744]">
                To
                <input type="date" value={to} onChange={e => setTo(e.target.value)}
                  className="block mt-1 h-10 px-3 rounded-xl border border-[#E0D0BE] bg-white text-[13px] font-normal text-[#2D1B0E]" />
              </label>
              <label className="flex items-center gap-2 h-10 text-[12px] text-[#6B5744]">
                <input type="checkbox" checked={includeInactive} onChange={e => setIncludeInactive(e.target.checked)}
                  className="w-4 h-4 accent-[#af4408]" />
                Preview inactive rules too
              </label>
              <div className="flex gap-2 ml-auto">
                <button onClick={() => runScan(true)} disabled={!!busy}
                  className="flex items-center gap-2 px-4 h-10 rounded-xl border border-[#E0D0BE] bg-white hover:bg-[#FFF1E3] text-[#6B5744] text-sm font-medium disabled:opacity-50">
                  {busy === 'preview' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />}
                  Preview (writes nothing)
                </button>
                <button onClick={() => runScan(false)} disabled={!!busy || !tracking}
                  title={tracking ? '' : 'Turn Recording on first'}
                  className="flex items-center gap-2 px-4 h-10 rounded-xl bg-[#af4408] hover:bg-[#903905] text-white text-sm font-semibold disabled:opacity-40">
                  {busy === 'scan' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Radar className="w-4 h-4" />}
                  Scan &amp; record
                </button>
              </div>
            </div>

            {scan && (
              <div className="border-t border-[#F0E4D4] pt-4 space-y-3">
                <div className="flex flex-wrap items-center gap-2 text-[12px]">
                  <span className={`px-2 py-0.5 rounded-full border font-semibold ${scan.dry_run
                    ? 'bg-[#F5EFE7] text-[#6B5744] border-[#E0D0BE]'
                    : scan.persisted ? 'bg-green-50 text-green-700 border-green-200' : 'bg-red-50 text-red-700 border-red-200'}`}>
                    {scan.dry_run ? 'Preview — nothing written' : scan.persisted ? `Recorded ${scan.inserted} new` : 'Nothing recorded'}
                  </span>
                  <span className="text-[#6B5744]">{scan.from} → {scan.to}</span>
                  <span className="text-[#6B5744]">· {scan.rules_used} rule{scan.rules_used === 1 ? '' : 's'} run</span>
                  <span className="text-[#6B5744]">· {scan.total_hits} match{scan.total_hits === 1 ? '' : 'es'}</span>
                  {scan.already_recorded > 0 && (
                    <span className="text-[#8B7355]">· {scan.already_recorded} already recorded</span>
                  )}
                </div>

                {scan.blocked_reason && (
                  <p className="text-[12px] text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2">
                    {scan.blocked_reason}
                  </p>
                )}

                {/* Coverage — the honest denominator */}
                <div className="rounded-xl bg-[#FFF8F0] border border-[#F0E4D4] px-3 py-2.5 text-[12px] text-[#6B5744]">
                  <span className="font-semibold text-[#2D1B0E]">Coverage: </span>
                  {scan.coverage.with_any_text} of {scan.coverage.calls} calls in this range carry any readable text
                  {' '}({Math.round(scan.coverage.ratio * 100)}%).
                  {' '}Transcripts {scan.coverage.with_transcript}, AI summaries {scan.coverage.with_summary},
                  {' '}outcomes {scan.coverage.with_outcome}, agent notes {scan.coverage.with_note}.
                  {scan.coverage.with_any_text < scan.coverage.calls && (
                    <span className="block mt-1 text-[#8B7355]">
                      The remaining {scan.coverage.calls - scan.coverage.with_any_text} call
                      {scan.coverage.calls - scan.coverage.with_any_text === 1 ? ' has' : 's have'} nothing to read —
                      no rule can ever match them. Analyse a call (CRM · Call Log → Enhance) to give the scanner a transcript.
                    </span>
                  )}
                </div>

                {scan.per_rule.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-[12px] min-w-[640px]">
                      <thead>
                        <tr className="text-left text-[#8B7355] border-b border-[#F0E4D4]">
                          <th className="py-2 pr-3 font-semibold">Rule</th>
                          <th className="py-2 pr-3 font-semibold">Matches</th>
                          <th className="py-2 pr-3 font-semibold">Calls</th>
                          <th className="py-2 pr-3 font-semibold">Example excerpt</th>
                        </tr>
                      </thead>
                      <tbody>
                        {scan.per_rule.map(r => (
                          <tr key={r.rule_id} className="border-b border-[#F8F1E8] last:border-0 align-top">
                            <td className="py-2 pr-3">
                              <div className="flex items-center gap-2">
                                <span className="font-semibold text-[#2D1B0E]">{r.name}</span>
                                {!r.is_active && <span className="text-[10px] uppercase tracking-wide text-[#8B7355]">inactive</span>}
                              </div>
                            </td>
                            <td className="py-2 pr-3 tabular-nums">{r.hits}</td>
                            <td className="py-2 pr-3 tabular-nums">{r.calls}</td>
                            <td className="py-2 pr-3 text-[#6B5744]">{r.sample_excerpt || <span className="text-[#B9A88F]">—</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* 3 — Rules */}
        <div className="bg-white border border-[#E8D5C4] rounded-2xl p-4 sm:p-5 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-bold text-[15px] flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-[#af4408]" /> Rules
            </h2>
            <span className="text-[12px] text-[#8B7355]">{rules.length} total · {activeRules} active</span>
            {canManage && (
              <div className="flex gap-2 ml-auto">
                <button onClick={seedRules} disabled={!!busy}
                  className="flex items-center gap-2 px-3 h-9 rounded-xl border border-[#E0D0BE] bg-white hover:bg-[#FFF1E3] text-[#6B5744] text-[13px] font-medium disabled:opacity-50">
                  {busy === 'seed' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                  Load example rules
                </button>
                <button onClick={startNew} disabled={!!busy}
                  className="flex items-center gap-2 px-3 h-9 rounded-xl bg-[#af4408] hover:bg-[#903905] text-white text-[13px] font-semibold disabled:opacity-50">
                  <Plus className="w-4 h-4" /> New rule
                </button>
              </div>
            )}
          </div>

          {missingExamples && (
            <p className="text-[13px] text-[#6B5744] bg-[#FFF8F0] border border-[#F0E4D4] rounded-xl px-3 py-3">
              No rules yet. <b>Load example rules</b> adds four starters a restaurant usually wants —
              birthday/anniversary, complaint, large-group enquiry and dietary request — all <b>inactive</b>,
              so nothing starts alerting until you switch one on.
            </p>
          )}

          {/* Editor */}
          {canManage && editing && (
            <div className="rounded-xl border border-[#F0D9C0] bg-[#FFF8F0] p-4 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto] gap-3">
                <label className="text-[12px] font-semibold text-[#6B5744]">
                  Rule name
                  <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
                    placeholder="e.g. Kids menu enquiry" maxLength={80}
                    className="block w-full mt-1 h-10 px-3 rounded-xl border border-[#E0D0BE] bg-white text-[13px] font-normal" />
                </label>
                <label className="text-[12px] font-semibold text-[#6B5744]">
                  Severity
                  <select value={form.severity} onChange={e => setForm({ ...form, severity: e.target.value as Severity })}
                    className="block mt-1 h-10 px-3 rounded-xl border border-[#E0D0BE] bg-white text-[13px] font-normal">
                    <option value="info">Info</option>
                    <option value="attention">Attention</option>
                    <option value="urgent">Urgent</option>
                  </select>
                </label>
                <label className="text-[12px] font-semibold text-[#6B5744] flex flex-col">
                  Flag for review
                  <span className="mt-2 flex items-center gap-2">
                    <Toggle size="sm" checked={form.notify} onChange={v => setForm({ ...form, notify: v })} label="Flag for review" />
                    <span className="font-normal text-[#8B7355] text-[11px]">in-app only</span>
                  </span>
                </label>
              </div>
              <label className="block text-[12px] font-semibold text-[#6B5744]">
                Keywords <span className="font-normal text-[#8B7355]">— comma or newline separated. Whole words only: “book” will not match “bookkeeping”, and plurals need their own entry.</span>
                <textarea value={form.keywords} onChange={e => setForm({ ...form, keywords: e.target.value })}
                  rows={3} placeholder="birthday, bday, anniversary, cake"
                  className="block w-full mt-1 px-3 py-2 rounded-xl border border-[#E0D0BE] bg-white text-[13px] font-normal" />
              </label>
              <div className="flex gap-2">
                <button onClick={saveForm} disabled={busy === 'save'}
                  className="flex items-center gap-2 px-4 h-10 rounded-xl bg-[#af4408] hover:bg-[#903905] text-white text-sm font-semibold disabled:opacity-50">
                  {busy === 'save' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
                </button>
                <button onClick={() => setEditing(null)}
                  className="flex items-center gap-2 px-4 h-10 rounded-xl border border-[#E0D0BE] bg-white hover:bg-[#FFF1E3] text-[#6B5744] text-sm font-medium">
                  <X className="w-4 h-4" /> Cancel
                </button>
              </div>
            </div>
          )}

          {/* Rule cards */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {rules.map(r => (
              <div key={r.id}
                className={`rounded-xl border p-3.5 ${r.is_active ? 'border-[#E8D5C4] bg-white' : 'border-[#F0E4D4] bg-[#FFFCF8]'}`}>
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-[14px] truncate">{r.name}</span>
                      <SeverityChip severity={r.severity} />
                      {!!r.notify && (
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-[#af4408] bg-[#FFF1E3] border border-[#F0D9C0] rounded-full px-2 py-0.5">
                          Flagged
                        </span>
                      )}
                      {!r.is_active && (
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-[#8B7355]">Inactive</span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1 mt-2">
                      {r.keywords.slice(0, 12).map(k => (
                        <span key={k} className="text-[11px] px-1.5 py-0.5 rounded-md bg-[#F5EFE7] text-[#6B5744] border border-[#EADFD2]">{k}</span>
                      ))}
                      {r.keywords.length > 12 && (
                        <span className="text-[11px] text-[#8B7355]">+{r.keywords.length - 12} more</span>
                      )}
                    </div>
                    <p className="text-[11px] text-[#8B7355] mt-2">
                      {(r.hits ?? 0)} hit{(r.hits ?? 0) === 1 ? '' : 's'} recorded
                      {(r.open_hits ?? 0) > 0 && <span className="text-[#af4408] font-semibold"> · {r.open_hits} open</span>}
                    </p>
                  </div>
                  {canManage && (
                    <div className="flex flex-col items-end gap-2 shrink-0">
                      <Toggle size="sm" checked={!!r.is_active} disabled={busy === `rule:${r.id}`}
                        onChange={v => patchRule(r.id, { is_active: v ? 1 : 0 })} label={`Activate ${r.name}`} />
                      <div className="flex gap-1">
                        <button onClick={() => startEdit(r)} title="Edit"
                          className="p-1.5 rounded-lg border border-[#E0D0BE] bg-white hover:bg-[#FFF1E3] text-[#6B5744]">
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => deleteRule(r)} title="Delete"
                          className="p-1.5 rounded-lg border border-[#E0D0BE] bg-white hover:bg-red-50 hover:text-red-600 hover:border-red-200 text-[#6B5744]">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 4 — Review */}
        <div className="bg-white border border-[#E8D5C4] rounded-2xl p-4 sm:p-5 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-bold text-[15px] flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-[#af4408]" /> Recent hits
            </h2>
            <span className="text-[12px] text-[#8B7355]">{totalShown} shown</span>
            <div className="flex items-center gap-2 ml-auto">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8B7355]" />
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search excerpt / guest"
                  className="h-9 pl-9 pr-3 rounded-xl border border-[#E0D0BE] bg-white text-[13px] w-56" />
              </div>
              <button
                onClick={() => { const next = !openOnly; setOpenOnly(next); loadHits(next); }}
                className={`h-9 px-3 rounded-xl border text-[13px] font-medium ${openOnly
                  ? 'bg-[#af4408] text-white border-[#903905]'
                  : 'bg-white text-[#6B5744] border-[#E0D0BE] hover:bg-[#FFF1E3]'}`}>
                {openOnly ? 'Open only' : 'All hits'}
              </button>
            </div>
          </div>

          {visibleGroups.length === 0 ? (
            <div className="text-center py-10 text-[#8B7355]">
              <Radar className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <p className="text-[14px] font-medium">No hits {openOnly ? 'open' : 'recorded'}.</p>
              <p className="text-[12px] mt-1 max-w-md mx-auto">
                {tracking
                  ? 'Run a scan above, or check the coverage line — a call with no transcript and no note is invisible to every rule.'
                  : 'Recording is off, so nothing is being recorded. Preview a scan to see what would match.'}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {visibleGroups.map(g => {
                const openIds = g.hits.filter(h => !h.acknowledged).map(h => h.id);
                return (
                  <div key={g.rule.id} className="rounded-xl border border-[#F0E4D4] overflow-hidden">
                    <div className="flex flex-wrap items-center gap-2 px-3.5 py-2.5 bg-[#FFF8F0] border-b border-[#F0E4D4]">
                      <span className="font-semibold text-[14px]">{g.rule.name}</span>
                      <SeverityChip severity={g.rule.severity} />
                      <span className="text-[12px] text-[#8B7355]">{g.hits.length} hit{g.hits.length === 1 ? '' : 's'}</span>
                      {openIds.length > 0 && (
                        <button onClick={() => ackHits(openIds, true)} disabled={!!busy}
                          className="ml-auto flex items-center gap-1.5 px-2.5 h-8 rounded-lg border border-[#E0D0BE] bg-white hover:bg-[#FFF1E3] text-[#6B5744] text-[12px] font-medium disabled:opacity-50">
                          <CheckCheck className="w-3.5 h-3.5" /> Acknowledge all ({openIds.length})
                        </button>
                      )}
                    </div>
                    <ul className="divide-y divide-[#F8F1E8]">
                      {g.hits.map(h => (
                        <li key={h.id} className={`px-3.5 py-3 ${h.acknowledged ? 'opacity-60' : ''}`}>
                          <div className="flex flex-col sm:flex-row sm:items-start gap-3">
                            <div className="min-w-0 flex-1">
                              <p className="text-[13px] text-[#2D1B0E] leading-relaxed">
                                <span className="font-mono text-[11px] bg-[#FFF1E3] text-[#af4408] border border-[#F0D9C0] rounded px-1.5 py-0.5 mr-2">
                                  {h.matched_term}
                                </span>
                                {h.excerpt}
                              </p>
                              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-[11px] text-[#8B7355]">
                                <span className="inline-flex items-center gap-1">
                                  <User className="w-3 h-3" />
                                  {h.guest_id ? (
                                    <Link href={`/crm-calls/guests?id=${h.guest_id}`} className="text-[#af4408] hover:underline font-medium">
                                      {h.guest_name || 'Unnamed guest'}
                                    </Link>
                                  ) : (
                                    <span>Unknown caller</span>
                                  )}
                                  {h.guest_phone && <span>· {formatPhone(h.guest_phone)}</span>}
                                </span>
                                <span className="inline-flex items-center gap-1">
                                  <PhoneCall className="w-3 h-3" />
                                  <Link href={`/crm-calls/log?call=${h.call_id}`} className="text-[#af4408] hover:underline">
                                    {prettyWhen(h.call_started_at)}
                                  </Link>
                                  {h.call_direction && <span>· {h.call_direction}</span>}
                                  {h.call_agent && <span>· {h.call_agent}</span>}
                                </span>
                                <span>flagged {prettyWhen(h.created_at)}</span>
                              </div>
                            </div>
                            <button onClick={() => ackHits([h.id], !h.acknowledged)} disabled={!!busy}
                              className={`shrink-0 flex items-center gap-1.5 px-2.5 h-8 rounded-lg border text-[12px] font-medium disabled:opacity-50 ${h.acknowledged
                                ? 'border-[#E0D0BE] bg-white text-[#8B7355] hover:bg-[#FFF1E3]'
                                : 'border-green-200 bg-green-50 text-green-700 hover:bg-green-100'}`}>
                              <Check className="w-3.5 h-3.5" /> {h.acknowledged ? 'Undo' : 'Acknowledge'}
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* How matching works — stated on the page, not buried in code */}
        <div className="text-[11px] text-[#8B7355] bg-[#FFF8F0] border border-[#F0E4D4] rounded-2xl px-4 py-3 leading-relaxed">
          <b className="text-[#6B5744]">How matching works.</b> Keywords match whole words, case-insensitively, across the
          call transcript, the AI summary/outcome and the agent&apos;s disposition note. “book” matches “book a table”
          but not “bookkeeping” or “booking”. There is no stemming, no typo tolerance and no negation awareness —
          “no complaints at all” will trip a complaint rule, which is why every hit shows its excerpt and can be
          acknowledged in one click. Re-scanning a range never duplicates a hit.
        </div>
      </div>

      {toast && (
        <div className={`fixed bottom-5 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl shadow-lg text-sm font-medium ${
          toast.error ? 'bg-red-600 text-white' : 'bg-[#2D1B0E] text-white'}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
