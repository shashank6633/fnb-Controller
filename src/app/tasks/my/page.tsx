'use client';

/**
 * My Tasks (/tasks/my) — CORE TASKS slice.
 *
 * The signed-in user's personal task list, tabbed:
 *   Assigned · Mentioned · Due Today · Upcoming · Overdue · Completed
 * "me" = my session email (matches tasks.assignee_email or any task_assignees
 * row; Mentioned matches task_mentions by email).
 *
 * Per-task actions drive PATCH /api/tasks/:id status transitions with an
 * optional note: Start → in_progress, Pause → on_hold, Resume → in_progress,
 * Complete → waiting_verification (submit for a manager's approval, feeding the
 * Approvals queue). Each card expands to a comment thread where the user can
 * post an update and attach evidence (an image/file URL) via
 * POST /api/tasks/:id/comments.
 *
 * Any signed-in user can use the page (it only shows their own tasks). Mobile
 * cards throughout; warm theme.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle, ArrowLeft, CalendarClock, CheckCircle2, ChevronDown, ChevronUp,
  ClipboardList, Download, Loader2, Pause, Play, Search, Send, RefreshCw, Wrench, X,
} from 'lucide-react';
import { api } from '@/lib/api';
import { priorityMeta, statusMeta } from '@/lib/tasks';
import RequestModal from '../_components/RequestModal';

type TabKey = 'assigned' | 'mentioned' | 'today' | 'upcoming' | 'overdue' | 'completed' | 'requests';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'assigned', label: 'Assigned' },
  { key: 'mentioned', label: 'Mentioned' },
  { key: 'today', label: 'Due Today' },
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'completed', label: 'Completed' },
  { key: 'requests', label: 'My Requests' },
];

const ACTIVE_STATES = 'draft,assigned,accepted,in_progress,reopened,on_hold';
const DONE_STATES = 'waiting_verification,completed,approved';

const fmtDate = (s: string | null | undefined) => {
  if (!s) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};
const fmtDateTime = (s: string | null | undefined) => {
  if (!s) return '';
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return s!;
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
};
const todayISO = () => new Date().toISOString().slice(0, 10);

/** Actions offered for a given status. */
function actionsFor(status: string): { label: string; to: string; icon: 'play' | 'pause' | 'check' }[] {
  switch (status) {
    case 'draft':
    case 'assigned':
    case 'accepted':
    case 'reopened':
      return [{ label: 'Start', to: 'in_progress', icon: 'play' }];
    case 'in_progress':
      return [
        { label: 'Pause', to: 'on_hold', icon: 'pause' },
        { label: 'Complete', to: 'waiting_verification', icon: 'check' },
      ];
    case 'on_hold':
      return [{ label: 'Resume', to: 'in_progress', icon: 'play' }];
    default:
      return [];
  }
}

export default function MyTasksPage() {
  const router = useRouter();
  const [me, setMe] = useState<any>(undefined);
  const [tab, setTab] = useState<TabKey>('assigned');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showRequest, setShowRequest] = useState(false);

  // Expanded card detail (comments + evidence form).
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<any | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [commentBody, setCommentBody] = useState('');
  const [evidenceUrl, setEvidenceUrl] = useState('');
  const [commentBusy, setCommentBusy] = useState(false);

  const myEmail = me?.email || '';

  useEffect(() => {
    fetch('/api/auth/me').then((r) => r.json()).then((d) => setMe(d?.user ?? null)).catch(() => setMe(null));
  }, []);

  const load = useCallback(() => {
    if (!myEmail) return;
    setLoading(true);
    setError(null);

    // "My Requests" is a distinct feed: the repair/maintenance requests THIS
    // user raised (any status), served by the self-service intake slice keyed
    // off the session — not the shared /api/tasks assignee/mention query.
    if (tab === 'requests') {
      fetch('/api/tasks/request')
        .then((r) => r.json())
        .then((j) => {
          if (j.error) { setError(j.error); setRows([]); return; }
          setRows(j.rows || []);
        })
        .catch((e) => { setError(e?.message || 'Failed to load requests'); setRows([]); })
        .finally(() => setLoading(false));
      return;
    }

    const p = new URLSearchParams();
    p.set('pageSize', '200');
    if (tab === 'mentioned') {
      p.set('mentioned', myEmail);
    } else {
      p.set('assignee', myEmail);
      if (tab === 'assigned') p.set('status', ACTIVE_STATES);
      else if (tab === 'completed') p.set('status', DONE_STATES);
      else if (tab === 'today') p.set('due', 'today');
      else if (tab === 'upcoming') p.set('due', 'upcoming');
      else if (tab === 'overdue') p.set('due', 'overdue');
    }
    fetch(`/api/tasks?${p.toString()}`)
      .then((r) => r.json())
      .then((j) => {
        if (j.error) { setError(j.error); setRows([]); return; }
        setRows(j.rows || []);
      })
      .catch((e) => { setError(e?.message || 'Failed to load tasks'); setRows([]); })
      .finally(() => setLoading(false));
  }, [myEmail, tab]);

  useEffect(() => { if (myEmail) load(); }, [myEmail, tab, load]);

  const doAction = async (task: any, to: string) => {
    if (busyId) return;
    setBusyId(task.id);
    setError(null);
    try {
      const res = await api(`/api/tasks/${task.id}`, { method: 'PATCH', body: { status: to } });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(j.error || `HTTP ${res.status}`); return; }
      setNotice(`Task moved to ${statusMeta(to).label}`);
      load();
      if (openId === task.id) openDetail(task.id, true);
    } catch (e: any) {
      setError(e?.message || 'Failed to update task');
    } finally {
      setBusyId(null);
    }
  };

  const openDetail = (id: string, force = false) => {
    if (openId === id && !force) { setOpenId(null); setDetail(null); return; }
    setOpenId(id);
    if (!force) { setDetail(null); setCommentBody(''); setEvidenceUrl(''); }
    setDetailLoading(true);
    fetch(`/api/tasks/${id}`)
      .then((r) => r.json())
      .then((j) => { if (!j.error) setDetail(j); })
      .catch(() => {})
      .finally(() => setDetailLoading(false));
  };

  const postComment = async (taskId: string) => {
    const body = commentBody.trim();
    const url = evidenceUrl.trim();
    if (commentBusy || (!body && !url)) return;
    setCommentBusy(true);
    setError(null);
    try {
      const payload: any = { body };
      if (url) payload.attachments = [{ kind: /\.(png|jpe?g|gif|webp)$/i.test(url) ? 'image' : 'file', url, filename: url.split('/').pop() || '' }];
      const res = await api(`/api/tasks/${taskId}/comments`, { method: 'POST', body: payload });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(j.error || `HTTP ${res.status}`); return; }
      setCommentBody('');
      setEvidenceUrl('');
      setNotice('Comment added');
      openDetail(taskId, true);
    } catch (e: any) {
      setError(e?.message || 'Failed to add comment');
    } finally {
      setCommentBusy(false);
    }
  };

  /* ── gates ── */
  if (me === undefined) {
    return <div className="p-8 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…</div>;
  }
  if (me === null) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <button onClick={() => router.back()} className="inline-flex items-center gap-1 text-sm text-[#6B5744] hover:text-[#2D1B0E] mb-3">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">🔒 Please sign in to see your tasks.</div>
      </div>
    );
  }

  const ActionIcon = ({ icon }: { icon: 'play' | 'pause' | 'check' }) =>
    icon === 'play' ? <Play size={13} /> : icon === 'pause' ? <Pause size={13} /> : <CheckCircle2 size={13} />;

  /* ── client-side title/text search over the loaded rows ── */
  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? rows.filter((t) =>
        [t.title, t.description, t.category, t.department, t.status, t.priority]
          .some((v) => String(v ?? '').toLowerCase().includes(needle)))
    : rows;

  /* ── CSV export of the current (filtered) view ── */
  const exportCsv = () => {
    const csvCell = (x: any) => {
      const s = String(x ?? '');
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const headers = ['Title', 'Category', 'Department', 'Priority', 'Status', 'Assignee', 'Due Date', 'Due Time', 'Created'];
    const lines = [headers.join(',')];
    filtered.forEach((t) => {
      lines.push([
        t.title, t.category, t.department, t.priority, statusMeta(t.status).label,
        t.assignee_name || t.assignee_email, t.due_date, t.due_time, t.created_at,
      ].map(csvCell).join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `my-tasks-${tab}-${todayISO()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-4xl mx-auto pb-16">
      {/* Header */}
      <div>
        <button onClick={() => router.back()} className="inline-flex items-center gap-1 text-sm text-[#6B5744] hover:text-[#2D1B0E] mb-2">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-[#af4408] text-white flex items-center justify-center shrink-0">
            <ClipboardList size={20} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl sm:text-2xl font-bold text-[#2D1B0E]">My Tasks</h1>
            <p className="text-xs text-[#8B7355]">Your assigned work — start, pause, complete & log evidence</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* Open to EVERYONE — self-service repair/maintenance intake, not the
                manager-only full task create. */}
            <button
              onClick={() => setShowRequest(true)}
              className="inline-flex items-center gap-1.5 bg-[#af4408] hover:bg-[#8a3606] text-white text-sm rounded-lg px-3 py-2"
            >
              <Wrench size={14} /> Raise a Request
            </button>
            <button onClick={load} disabled={loading} className="inline-flex items-center gap-1.5 bg-white border border-[#E8D5C4] hover:border-[#af4408] text-[#2D1B0E] text-sm rounded-lg px-3 py-2 disabled:opacity-50">
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> <span className="hidden sm:inline">Refresh</span>
            </button>
          </div>
        </div>
      </div>

      {/* Search + export */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8B7355] pointer-events-none" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search my tasks by title, category…"
            aria-label="Search my tasks"
            className="w-full border border-[#E8D5C4] rounded-lg pl-8 pr-3 py-2 text-sm bg-white focus:outline-none focus:border-[#af4408]"
          />
        </div>
        <button
          onClick={exportCsv}
          disabled={filtered.length === 0}
          className="inline-flex items-center gap-1.5 bg-white border border-[#E8D5C4] hover:border-[#af4408] text-[#2D1B0E] text-sm rounded-lg px-3 py-2 disabled:opacity-50"
        >
          <Download size={14} /> Export CSV
        </button>
      </div>

      {/* Banners */}
      {notice && (
        <div className="flex items-center justify-between gap-2 bg-green-50 border border-green-200 text-green-800 text-sm rounded-lg px-3 py-2">
          <span className="flex items-center gap-2"><CheckCircle2 size={15} className="shrink-0" /> {notice}</span>
          <button onClick={() => setNotice(null)} className="text-green-700 hover:text-green-900"><X size={14} /></button>
        </div>
      )}
      {error && (
        <div className="flex items-center justify-between gap-2 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2">
          <span className="flex items-center gap-2"><AlertCircle size={15} className="shrink-0" /> {error}</span>
          <button onClick={() => setError(null)} className="text-red-700 hover:text-red-900"><X size={14} /></button>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => { setTab(t.key); setOpenId(null); setDetail(null); }}
            className={`shrink-0 text-sm rounded-full px-3.5 py-1.5 border transition-colors ${
              tab === t.key
                ? 'bg-[#af4408] border-[#af4408] text-white'
                : 'bg-white border-[#E8D5C4] text-[#6B5744] hover:border-[#af4408]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Loading / empty */}
      {loading && rows.length === 0 && (
        <div className="p-8 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…</div>
      )}
      {!loading && filtered.length === 0 && !error && (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center text-sm text-[#8B7355]">
          {tab === 'requests'
            ? (needle
                ? `No requests match "${q.trim()}".`
                : 'You haven’t raised any requests yet. Tap "Raise a Request" to report a repair or maintenance issue.')
            : (needle
                ? `No ${TABS.find((t) => t.key === tab)?.label.toLowerCase()} tasks match "${q.trim()}".`
                : `Nothing here — you have no ${TABS.find((t) => t.key === tab)?.label.toLowerCase()} tasks.`)}
        </div>
      )}

      {/* Cards */}
      <div className="space-y-2">
        {filtered.map((t) => {
          const pm = priorityMeta(t.priority);
          const sm = statusMeta(t.status);
          // On the "My Requests" feed the viewer is the requester, not the
          // assignee, so start/pause/complete controls don't apply.
          const actions = tab === 'requests' ? [] : actionsFor(t.status);
          const overdue = t.due_date && t.due_date < todayISO() && !['completed', 'approved', 'cancelled'].includes(t.status);
          const isOpen = openId === t.id;
          return (
            <div key={t.id} className={`bg-white border rounded-xl ${isOpen ? 'border-[#af4408]' : 'border-[#E8D5C4]'}`}>
              <div className="p-3">
                <div className="flex items-start justify-between gap-2">
                  <button onClick={() => openDetail(t.id)} className="min-w-0 text-left flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-semibold text-sm text-[#2D1B0E]">{t.title}</span>
                      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full border ${pm.color}`}>{pm.label}</span>
                      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full border ${sm.color}`}>{sm.label}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 text-xs text-[#6B5744]">
                      {t.department && <span>{t.department}</span>}
                      {t.category && <span className="text-[#8B7355]">{t.category}</span>}
                      {t.due_date && (
                        <span className={`inline-flex items-center gap-1 ${overdue ? 'text-red-600 font-semibold' : ''}`}>
                          <CalendarClock size={11} /> {fmtDate(t.due_date)}{t.due_time ? ` ${t.due_time}` : ''}
                        </span>
                      )}
                    </div>
                  </button>
                  <button onClick={() => openDetail(t.id)} className="shrink-0 text-[#8B7355]">
                    {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  </button>
                </div>

                {/* Quick actions */}
                {actions.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-2">
                    {actions.map((a) => (
                      <button
                        key={a.to}
                        onClick={() => doAction(t, a.to)}
                        disabled={busyId === t.id}
                        className={`inline-flex items-center gap-1.5 text-sm rounded-lg px-3 py-1.5 disabled:opacity-50 ${
                          a.icon === 'check'
                            ? 'bg-[#af4408] hover:bg-[#8a3606] text-white'
                            : 'bg-white border border-[#E8D5C4] hover:border-[#af4408] text-[#2D1B0E]'
                        }`}
                      >
                        {busyId === t.id ? <Loader2 size={13} className="animate-spin" /> : <ActionIcon icon={a.icon} />}
                        {a.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Detail: comments + evidence */}
              {isOpen && (
                <div className="border-t border-[#E8D5C4] bg-[#FFF8F0] p-3 space-y-3">
                  {t.description && <p className="text-xs text-[#6B5744] whitespace-pre-wrap">{t.description}</p>}

                  {detailLoading && !detail && (
                    <div className="text-xs text-[#8B7355]"><Loader2 className="w-4 h-4 animate-spin inline mr-1" /> Loading…</div>
                  )}

                  {/* Checklist */}
                  {detail?.task?.checklist_json && detail.task.checklist_json !== '[]' && (() => {
                    let items: any[] = [];
                    try { items = JSON.parse(detail.task.checklist_json); } catch { /* ignore */ }
                    if (!items.length) return null;
                    return (
                      <div>
                        <div className="text-xs font-semibold text-[#2D1B0E] uppercase tracking-wide mb-1">Checklist</div>
                        <ul className="space-y-1">
                          {items.map((c: any, i: number) => (
                            <li key={i} className="flex items-center gap-2 text-xs text-[#2D1B0E]">
                              <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center ${c.done ? 'bg-[#af4408] border-[#af4408]' : 'border-[#E8D5C4]'}`}>
                                {c.done && <CheckCircle2 size={10} className="text-white" />}
                              </span>
                              <span className={c.done ? 'line-through text-[#8B7355]' : ''}>{c.label}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })()}

                  {/* Comment thread */}
                  <div>
                    <div className="text-xs font-semibold text-[#2D1B0E] uppercase tracking-wide mb-1">Updates</div>
                    {detail?.comments?.length ? (
                      <div className="space-y-1.5">
                        {detail.comments.map((c: any) => {
                          const atts = (detail.attachments || []).filter((a: any) => a.comment_id === c.id);
                          return (
                            <div key={c.id} className="bg-white border border-[#E8D5C4] rounded-lg px-2.5 py-1.5">
                              <div className="flex items-center justify-between gap-2 text-[11px] text-[#8B7355]">
                                <span className="font-medium text-[#2D1B0E]">{c.author_name || c.author_email}</span>
                                <span>{fmtDateTime(c.created_at)}</span>
                              </div>
                              {c.body && <p className="text-xs text-[#2D1B0E] whitespace-pre-wrap mt-0.5">{c.body}</p>}
                              {atts.map((a: any) => (
                                <a key={a.id} href={a.url} target="_blank" rel="noreferrer" className="text-xs text-[#af4408] hover:underline break-all">
                                  📎 {a.filename || a.url}
                                </a>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="text-xs text-[#8B7355]">No updates yet.</div>
                    )}
                  </div>

                  {/* Add update + evidence */}
                  <div className="space-y-2">
                    <textarea
                      rows={2} value={commentBody} onChange={(e) => setCommentBody(e.target.value)}
                      placeholder="Add an update… @mention a teammate"
                      className="w-full border border-[#E8D5C4] rounded-lg px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:border-[#af4408]"
                    />
                    <input
                      type="url" value={evidenceUrl} onChange={(e) => setEvidenceUrl(e.target.value)}
                      placeholder="Evidence link (image/file URL) — optional"
                      className="w-full border border-[#E8D5C4] rounded-lg px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:border-[#af4408]"
                    />
                    <button
                      onClick={() => postComment(t.id)}
                      disabled={commentBusy || (!commentBody.trim() && !evidenceUrl.trim())}
                      className="inline-flex items-center gap-1.5 bg-[#af4408] hover:bg-[#8a3606] text-white text-sm rounded-lg px-3 py-1.5 disabled:opacity-50"
                    >
                      {commentBusy ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />} Post
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Self-service repair/maintenance intake — open to every signed-in user. */}
      {showRequest && (
        <RequestModal
          onClose={() => setShowRequest(false)}
          onSubmitted={(msg) => {
            setShowRequest(false);
            setNotice(msg);
            // Surface the new request immediately: jump to (and reload) the feed.
            if (tab === 'requests') load();
            else { setOpenId(null); setDetail(null); setTab('requests'); }
          }}
        />
      )}
    </div>
  );
}
