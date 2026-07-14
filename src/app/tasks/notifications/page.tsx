'use client';

/**
 * Task Notifications (/tasks/notifications) — the personal task feed.
 *
 * Shows the signed-in user's notifications: assignments, @mentions, approval
 * outcomes (approved / reopened), and overdue reminders. Filter all / unread,
 * mark one or all read, and click through to the linked page.
 *
 * Client gate: any signed-in user (everyone has a feed). Warm theme, mobile-first.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle, ArrowLeft, AtSign, Bell, CheckCheck, CheckCircle2, ClipboardList,
  Loader2, RefreshCw, RotateCcw, X,
} from 'lucide-react';
import { api } from '@/lib/api';
import type { TaskNotification } from '@/lib/tasks';

const fmtWhen = (s: string | null | undefined) => {
  if (!s) return '—';
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return s;
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

function KindIcon({ kind }: { kind: string }) {
  const cls = 'w-4 h-4';
  if (kind === 'mention') return <AtSign className={`${cls} text-purple-600`} />;
  if (kind === 'approved') return <CheckCircle2 className={`${cls} text-green-600`} />;
  if (kind === 'reopened') return <RotateCcw className={`${cls} text-orange-600`} />;
  if (kind === 'assigned' || kind === 'assignment') return <ClipboardList className={`${cls} text-blue-600`} />;
  if (kind === 'overdue') return <AlertCircle className={`${cls} text-red-600`} />;
  return <Bell className={`${cls} text-[#af4408]`} />;
}

export default function TaskNotificationsPage() {
  const router = useRouter();
  const [me, setMe] = useState<any>(undefined); // undefined = loading, null = signed out

  const [rows, setRows] = useState<TaskNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.json())
      .then(d => setMe(d?.user ?? null))
      .catch(() => setMe(null));
  }, []);

  const load = useCallback((f: 'all' | 'unread') => {
    setLoading(true);
    setError(null);
    fetch(`/api/tasks/notifications?filter=${f}`)
      .then(r => r.json())
      .then(j => {
        if (j.error) { setError(j.error); setRows([]); return; }
        setRows(j.rows || []);
        setUnread(j.unread || 0);
      })
      .catch(e => { setError(e?.message || 'Failed to load notifications'); setRows([]); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!me) return;
    load(filter);
  }, [me, filter, load]);

  const markRead = async (ids?: string[]) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const body = ids && ids.length ? { ids } : { mark_all: true };
      const r = await api('/api/tasks/notifications', { method: 'POST', body });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setUnread(j.unread ?? 0);
      if (ids && ids.length) {
        setRows(rs => (filter === 'unread'
          ? rs.filter(n => !ids.includes(n.id))
          : rs.map(n => (ids.includes(n.id) ? { ...n, is_read: 1 } : n))));
      } else {
        setRows(rs => (filter === 'unread' ? [] : rs.map(n => ({ ...n, is_read: 1 }))));
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to update');
    } finally {
      setBusy(false);
    }
  };

  const openNotification = (n: TaskNotification) => {
    if (!n.is_read) markRead([n.id]);
    if (n.href) router.push(n.href);
  };

  /* ── gates ── */
  if (me === undefined) {
    return (
      <div className="p-8 text-center text-sm text-[#8B7355]">
        <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…
      </div>
    );
  }
  if (me === null) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <button
          onClick={() => router.back()}
          className="inline-flex items-center gap-1 text-sm text-[#6B5744] hover:text-[#2D1B0E] transition-colors mb-3"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
          🔒 Please sign in to view your notifications.
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-4xl mx-auto pb-16">
      {/* Header */}
      <div>
        <button
          onClick={() => router.back()}
          className="inline-flex items-center gap-1 text-sm text-[#6B5744] hover:text-[#2D1B0E] transition-colors mb-2"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-[#af4408] text-white flex items-center justify-center shrink-0 relative">
            <Bell size={20} />
            {unread > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[10px] font-bold flex items-center justify-center">
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl sm:text-2xl font-bold text-[#2D1B0E]">Notifications</h1>
            <p className="text-xs text-[#8B7355]">
              Assignments, @mentions, approvals & overdue reminders — {unread} unread
            </p>
          </div>
          <button
            onClick={() => load(filter)}
            disabled={loading}
            className="inline-flex items-center gap-1.5 bg-white border border-[#E8D5C4] hover:border-[#af4408] text-[#2D1B0E] text-sm rounded-lg px-3 py-2 disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          <button
            onClick={() => markRead()}
            disabled={busy || unread === 0}
            className="inline-flex items-center gap-1.5 bg-[#af4408] hover:bg-[#8a3606] text-white text-sm rounded-lg px-3 py-2 disabled:opacity-50"
          >
            <CheckCheck size={14} /> Mark all read
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2">
          <AlertCircle size={15} className="shrink-0" /> {error}
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex gap-2">
        {(['all', 'unread'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`text-sm rounded-lg px-3 py-1.5 border ${
              filter === f
                ? 'bg-[#FFF1E3] border-[#af4408] text-[#8a3606] font-semibold'
                : 'bg-white border-[#E8D5C4] text-[#6B5744] hover:border-[#af4408]'
            }`}
          >
            {f === 'all' ? 'All' : `Unread${unread > 0 ? ` (${unread})` : ''}`}
          </button>
        ))}
      </div>

      {/* Loading / empty */}
      {loading && rows.length === 0 && (
        <div className="p-8 text-center text-sm text-[#8B7355]">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading notifications…
        </div>
      )}
      {!loading && rows.length === 0 && !error && (
        <div className="bg-white border border-[#E8D5C4] rounded-lg p-8 text-center text-sm text-[#8B7355]">
          {filter === 'unread' ? 'No unread notifications — you are all caught up.' : 'No notifications yet.'}
        </div>
      )}

      {/* Feed */}
      {rows.length > 0 && (
        <div className="space-y-2">
          {rows.map(n => (
            <div
              key={n.id}
              onClick={() => openNotification(n)}
              className={`flex items-start gap-3 border rounded-xl p-3 cursor-pointer transition-colors ${
                n.is_read
                  ? 'bg-white border-[#E8D5C4] hover:border-[#af4408]'
                  : 'bg-[#FFF8F0] border-[#F2C79B] hover:border-[#af4408]'
              }`}
            >
              <div className="mt-0.5 shrink-0"><KindIcon kind={n.kind} /></div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className={`text-sm truncate ${n.is_read ? 'text-[#2D1B0E]' : 'font-semibold text-[#2D1B0E]'}`}>
                    {n.title}
                  </span>
                  {!n.is_read && <span className="w-2 h-2 rounded-full bg-[#af4408] shrink-0" />}
                </div>
                {n.body && <div className="text-xs text-[#6B5744] mt-0.5 line-clamp-2">{n.body}</div>}
                <div className="text-[11px] text-[#8B7355] mt-0.5">{fmtWhen(n.created_at)}</div>
              </div>
              {!n.is_read && (
                <button
                  onClick={e => { e.stopPropagation(); markRead([n.id]); }}
                  disabled={busy}
                  className="shrink-0 text-[#8B7355] hover:text-[#af4408] disabled:opacity-50"
                  title="Mark read"
                >
                  <CheckCircle2 size={16} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
