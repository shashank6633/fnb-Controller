'use client';

/**
 * CRM — Call-to-Table · WhatsApp Inbox (/crm-calls/whatsapp)
 *
 * Two-pane master-detail over the wa_conversations/wa_messages inbox core:
 *   LEFT  — conversation list (GET /api/crm-calls/inbox): guest-360 name (CRM
 *           name first, WhatsApp push name, then the raw number), preview,
 *           time, unread badge, 24h-window dot. Client-side search covers the
 *           CRM display name too (the server q only knows push-name/number).
 *   RIGHT — the thread (GET /api/crm-calls/inbox/[id] — marks read): bubbles
 *           in/out, delivery ticks from the status ladder, media through the
 *           AUTHED /api/crm-calls/inbox/media/[id] route, template messages
 *           labelled. Composer: free text while the 24h window is open
 *           ("free reply until HH:MM"); when it lapses (live countdown) the
 *           approved-template picker takes over, stating why. The SERVER
 *           re-checks regardless (assessReply) — this UI is a convenience,
 *           never the boundary.
 *
 * Refresh: 10s polling (the captain/cashier house cadence — the inbox core
 * publishes no SSE events, so there is nothing to subscribe to).
 *
 * Unknown guests get the "Save to CRM" affordance the guests 360 already owns:
 * a link to /crm-calls/guests/phone:<key>, where the synthetic-guest banner
 * hosts the actual save button. Gate: any signed-in member (owner policy —
 * customer data is open to all members; bulk sends keep their mgmt gates).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCheck,
  Download,
  FileText,
  Loader2,
  Megaphone,
  MessageCircle,
  Search,
  Send,
  User,
  X,
} from 'lucide-react';

const POLL_MS = 10000; // house cadence (captain board / cashier list)
const LIST_LIMIT = 200;

/* ───────────────────────────── types (API shapes) ───────────────────────────── */

interface WindowInfo { open: boolean; expires_at: string | null; remaining_ms: number }
interface ProviderInfo { provider: string; configured: boolean; notice: string }

interface Conv {
  id: number;
  phone_key: string;
  wa_id: string;
  profile_name: string;
  display_name: string;
  guest_handle: string;
  unread_count: number;
  last_message_preview: string;
  last_message_at: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  window: WindowInfo;
}

interface Msg {
  id: number;
  wamid: string | null;
  direction: 'in' | 'out';
  msg_type: string;
  body: string;
  media_id: number | null;
  media_url: string | null;
  media_status: string;
  media_error: string;
  status: string;
  status_at: string | null;
  error_detail: string;
  reply_to_wamid: string;
  wa_timestamp: string | null;
  sent_by: string;
  created_at: string;
}

interface Tpl {
  id: string;
  name: string;
  category: string;
  language: string;
  body: string;
  provider_template_name: string;
  provider_language: string;
  param_order: string; // JSON array of placeholder names
}

interface ThreadConv {
  id: number;
  phone_key: string;
  wa_id: string;
  profile_name: string;
  display_name: string;
  guest_handle: string;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  last_message_at: string | null;
}

/** Standing marketing-consent row for the guest (null = default, messageable). */
interface MarketingConsent {
  status: 'opted_out' | 'opted_in';
  source: string;
  detail: string;
  changed_at: string;
}

/* Typed (partial) response shapes — every field is optional because an error
 * body may carry none of them. */
interface ListResp { conversations?: Conv[]; total?: number; unread_total?: number; provider?: ProviderInfo; error?: string }
interface ThreadResp { conversation?: ThreadConv; messages?: Msg[]; window?: WindowInfo; templates?: Tpl[]; provider?: ProviderInfo; marketing_consent?: MarketingConsent | null; error?: string }
interface ReplyResp { ok?: boolean; message?: Msg; window?: WindowInfo; error?: string; detail?: string }

/* ───────────────────────────── time helpers (UTC strings → IST) ───────────────────────────── */

/** Server timestamps are UTC 'YYYY-MM-DD HH:MM:SS' (sqlite / utcString). */
function parseUtc(s: string | null | undefined): Date | null {
  if (!s) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? s.replace(' ', 'T') + 'Z' : s;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

function istTime(s: string | null | undefined): string {
  const d = parseUtc(s);
  if (!d) return '';
  return d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true });
}

function istDayKey(s: string | null | undefined): string {
  const d = parseUtc(s);
  if (!d) return '';
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD in IST
}

function istDayLabel(s: string | null | undefined): string {
  const d = parseUtc(s);
  if (!d) return '';
  const key = istDayKey(s);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const yest = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  if (key === today) return 'Today';
  if (key === yest) return 'Yesterday';
  return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
}

/** List-row time: today → HH:MM, yesterday → 'Yesterday', else DD Mon. */
function listTime(s: string | null | undefined): string {
  const d = parseUtc(s);
  if (!d) return '';
  const label = istDayLabel(s);
  if (label === 'Today') return istTime(s);
  if (label === 'Yesterday') return 'Yesterday';
  return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' });
}

function fmtPhoneKey(key: string): string {
  const digits = String(key || '').replace(/\D/g, '');
  if (digits.length === 10) return `${digits.slice(0, 5)} ${digits.slice(5)}`;
  return key;
}

/* ───────────────────────────── small components ───────────────────────────── */

function Avatar({ name, phone }: { name: string; phone: string }) {
  const initials = (name || '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase()
    || (phone || '').replace(/\D/g, '').slice(-2) || '?';
  return (
    <div className="w-10 h-10 rounded-full flex items-center justify-center text-[12px] font-bold shrink-0 bg-[#F3E2D0] text-[#a8632b]">
      {initials}
    </div>
  );
}

/** Outbound delivery ticks from the status ladder (sent→delivered→read; failed). */
function Ticks({ status, errorDetail }: { status: string; errorDetail: string }) {
  if (status === 'failed') {
    return (
      <span className="inline-flex items-center gap-0.5 text-red-600" title={errorDetail || 'Send failed'}>
        <AlertCircle className="w-3.5 h-3.5" />
        <span className="text-[10px] font-medium">failed</span>
      </span>
    );
  }
  if (status === 'read') return <CheckCheck className="w-3.5 h-3.5 text-sky-600" aria-label="Read" />;
  if (status === 'delivered') return <CheckCheck className="w-3.5 h-3.5 text-[#8B7355]" aria-label="Delivered" />;
  if (status === 'sent') return <Check className="w-3.5 h-3.5 text-[#8B7355]" aria-label="Sent" />;
  return null;
}

function WindowDot({ w }: { w: WindowInfo }) {
  return (
    <span
      title={w.open
        ? `24h window open — free replies until ${istTime(w.expires_at)} IST`
        : 'Window closed — approved templates only'}
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${w.open ? 'bg-green-500' : 'bg-[#C4B09A]'}`}
    />
  );
}

/** Media block — rendered through the AUTHED media route only. */
function MediaBlock({ m }: { m: Msg }) {
  if (m.media_status === 'failed') {
    return (
      <div className="flex items-start gap-2 p-2 bg-black/5 rounded-lg text-[11px] text-[#6B5744]" title={m.media_error}>
        <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" />
        <span>Media could not be stored{m.media_error ? ` — ${m.media_error}` : ''}. An admin can replay the backlog to retry.</span>
      </div>
    );
  }
  if (!m.media_url) return null;
  if (m.msg_type === 'image' || m.msg_type === 'sticker') {
    return (
      <a href={m.media_url} target="_blank" rel="noopener noreferrer" className="block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={m.media_url} alt={m.body || 'WhatsApp image'} className="max-w-full max-h-64 rounded-lg border border-black/10" loading="lazy" />
      </a>
    );
  }
  if (m.msg_type === 'video') {
    return <video src={m.media_url} controls className="max-w-full max-h-64 rounded-lg border border-black/10" preload="metadata" />;
  }
  if (m.msg_type === 'audio' || m.msg_type === 'voice') {
    return <audio src={m.media_url} controls className="max-w-full" preload="metadata" />;
  }
  return (
    <a href={m.media_url} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-black/5 hover:bg-black/10 rounded-lg text-xs font-medium text-[#3D2614]">
      <Download className="w-3.5 h-3.5" />{m.body || 'Document'}
    </a>
  );
}

/* ───────────────────────────── page ───────────────────────────── */

export default function WhatsAppInboxPage() {
  const [convs, setConvs] = useState<Conv[]>([]);
  const [total, setTotal] = useState(0);
  const [unreadTotal, setUnreadTotal] = useState(0);
  const [provider, setProvider] = useState<ProviderInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [thread, setThread] = useState<{ conversation: ThreadConv; messages: Msg[]; window: WindowInfo; templates: Tpl[]; marketing_consent: MarketingConsent | null } | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);

  // Window countdown: remaining_ms anchored at fetch time, ticked locally so
  // the composer flips to templates the minute the window actually lapses.
  const windowAnchor = useRef<{ at: number; w: WindowInfo } | null>(null);
  const [nowTick, setNowTick] = useState(Date.now());

  const selectedRef = useRef<number | null>(null);
  selectedRef.current = selectedId;

  // Debounce search 300ms (house pattern)
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim().toLowerCase()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // 30s tick drives the "free reply until…" countdown
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  const loadList = useCallback(async () => {
    try {
      const res = await fetch(`/api/crm-calls/inbox?limit=${LIST_LIMIT}`, { cache: 'no-store' });
      let json: ListResp = {};
      try { json = await res.json(); } catch { /* non-JSON error body */ }
      if (!res.ok) { setListError(json.error || `Failed to load inbox (HTTP ${res.status})`); return; }
      setConvs(Array.isArray(json.conversations) ? json.conversations : []);
      setTotal(Number(json.total) || 0);
      setUnreadTotal(Number(json.unread_total) || 0);
      if (json.provider) setProvider(json.provider);
      setListError(null);
    } catch {
      setListError('Network error — could not load the inbox');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadThread = useCallback(async (convId: number, opts?: { silent?: boolean }) => {
    if (!opts?.silent) { setThreadLoading(true); setThreadError(null); }
    try {
      const res = await fetch(`/api/crm-calls/inbox/${convId}`, { cache: 'no-store' });
      let json: ThreadResp = {};
      try { json = await res.json(); } catch { /* non-JSON error body */ }
      if (selectedRef.current !== convId) return; // user moved on mid-flight
      if (!res.ok || !json.conversation || !json.window) {
        setThreadError(json.error || `Failed to load thread (HTTP ${res.status})`);
        return;
      }
      setThread({
        conversation: json.conversation,
        messages: Array.isArray(json.messages) ? json.messages : [],
        window: json.window,
        templates: Array.isArray(json.templates) ? json.templates : [],
        marketing_consent: json.marketing_consent ?? null,
      });
      windowAnchor.current = { at: Date.now(), w: json.window };
      setThreadError(null);
      // Opening a thread marks it read server-side — mirror in the list.
      setConvs(prev => prev.map(c => (c.id === convId ? { ...c, unread_count: 0 } : c)));
    } catch {
      if (selectedRef.current === convId && !opts?.silent) setThreadError('Network error — could not load the thread');
    } finally {
      if (!opts?.silent) setThreadLoading(false);
    }
  }, []);

  // List: load + 10s poll
  useEffect(() => {
    loadList();
    const t = setInterval(loadList, POLL_MS);
    return () => clearInterval(t);
  }, [loadList]);

  // Thread: load on select + 10s poll while open
  useEffect(() => {
    if (!selectedId) { setThread(null); return; }
    loadThread(selectedId);
    const t = setInterval(() => loadThread(selectedId, { silent: true }), POLL_MS);
    return () => clearInterval(t);
  }, [selectedId, loadThread]);

  // Live window state — anchored server value minus elapsed local time.
  const liveWindow: WindowInfo | null = useMemo(() => {
    const a = windowAnchor.current;
    if (!thread) return null;
    if (!a) return thread.window;
    const remaining = Math.max(0, a.w.remaining_ms - (nowTick - a.at));
    return { open: a.w.open && remaining > 0, expires_at: a.w.expires_at, remaining_ms: remaining };
  }, [thread, nowTick]);

  // Client-side filter — covers the CRM display name the server q can't see.
  const filtered = useMemo(() => {
    if (!search) return convs;
    const digits = search.replace(/\D/g, '');
    return convs.filter(c =>
      c.display_name.toLowerCase().includes(search)
      || c.profile_name.toLowerCase().includes(search)
      || (digits.length > 0 && (c.phone_key.includes(digits) || c.wa_id.includes(digits))));
  }, [convs, search]);

  const appendMessage = useCallback((m: Msg) => {
    setThread(prev => (prev ? { ...prev, messages: [...prev.messages.filter(x => x.id !== m.id), m] } : prev));
  }, []);

  if (loading) {
    return (
      <div className="min-h-[60vh] bg-[#FFF8F0] p-6 animate-pulse rounded-2xl">
        <div className="max-w-[100rem] mx-auto space-y-6">
          <div className="h-9 w-64 bg-[#FFF1E3] rounded-lg" />
          <div className="bg-white border border-[#E8D5C4] rounded-2xl h-[28rem]" />
        </div>
      </div>
    );
  }

  return (
    <div className="text-[#2D1B0E]">
      <div className="max-w-[100rem] mx-auto space-y-3">
        {/* Header */}
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold text-[#6B5744] uppercase tracking-wider">CRM · Call to Table</p>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#2D1B0E] mt-0.5 flex items-center gap-2.5">
              WhatsApp Inbox
              {unreadTotal > 0 && (
                <span className="text-[11px] font-bold bg-[#af4408] text-white rounded-full px-2 py-0.5">
                  {unreadTotal} unread
                </span>
              )}
            </h1>
          </div>
          <p className="text-xs text-[#8B7355] hidden sm:block">{total} conversation{total === 1 ? '' : 's'}</p>
        </div>

        {/* Provider notice — e.g. Interakt active (inbound needs the Meta webhook), or unconfigured */}
        {provider?.notice && (
          <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-xl">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-800">{provider.notice}</p>
          </div>
        )}

        {listError && (
          <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-xl">
            <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
            <p className="text-xs text-red-700">{listError}</p>
          </div>
        )}

        {/* Two-pane shell */}
        <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm overflow-hidden flex h-[calc(100dvh-14.5rem)] min-h-[24rem] sm:h-[calc(100dvh-13.5rem)]">
          {/* LEFT — conversations (hidden on mobile while a thread is open) */}
          <div className={`${selectedId ? 'hidden md:flex' : 'flex'} w-full md:w-[21rem] lg:w-[24rem] shrink-0 flex-col border-r border-[#F0E4D6]`}>
            <div className="p-2.5 border-b border-[#F0E4D6]">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8B7355]" />
                <input
                  type="text"
                  placeholder="Search by name or number…"
                  aria-label="Search conversations by name or number"
                  value={searchInput}
                  onChange={e => setSearchInput(e.target.value)}
                  className="w-full pl-9 pr-8 py-2 bg-[#FFF8F0] border border-[#E0D0BE] rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]/40 focus:border-[#af4408]"
                />
                {searchInput && (
                  <button onClick={() => setSearchInput('')} aria-label="Clear search"
                          className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-[#FFF1E3]">
                    <X className="w-3.5 h-3.5 text-[#8B7355]" />
                  </button>
                )}
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              {filtered.length === 0 ? (
                <div className="py-14 px-6 text-center text-[#8B7355]">
                  <MessageCircle className="w-9 h-9 mx-auto mb-3 opacity-40" />
                  <p className="text-sm">{search ? 'No conversations match' : 'No conversations yet'}</p>
                  {!search && (
                    <p className="text-xs mt-1.5">
                      Guest messages arrive here once the Meta webhook is connected. An admin can replay the
                      stored webhook backlog from Settings if history is missing.
                    </p>
                  )}
                </div>
              ) : filtered.map(c => {
                const unknown = c.guest_handle.startsWith('phone:');
                return (
                  <div key={c.id}
                       role="button" tabIndex={0}
                       onClick={() => setSelectedId(c.id)}
                       onKeyDown={e => { if (e.key === 'Enter') setSelectedId(c.id); }}
                       className={`w-full text-left px-3 py-2.5 flex items-start gap-2.5 border-b border-[#F7EEE3] cursor-pointer transition-colors focus:outline-none focus:bg-[#FFF1E3] ${selectedId === c.id ? 'bg-[#FFF1E3]' : 'hover:bg-[#FFF8F0]'}`}>
                    <Avatar name={unknown ? '' : c.display_name} phone={c.phone_key} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5 min-w-0">
                          <WindowDot w={c.window} />
                          <span className="font-semibold text-[13px] text-[#2D1B0E] truncate">
                            {unknown ? fmtPhoneKey(c.phone_key) : c.display_name}
                          </span>
                        </span>
                        <span className="text-[10px] text-[#8B7355] whitespace-nowrap shrink-0">{listTime(c.last_message_at)}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2 mt-0.5">
                        <p className="text-[11px] text-[#6B5744] truncate">{c.last_message_preview || '—'}</p>
                        {c.unread_count > 0 && (
                          <span className="text-[10px] font-bold bg-[#af4408] text-white rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center shrink-0">
                            {c.unread_count}
                          </span>
                        )}
                      </div>
                      {unknown && (
                        <Link href={`/crm-calls/guests/${encodeURIComponent(c.guest_handle)}`}
                              onClick={e => e.stopPropagation()}
                              className="inline-flex items-center gap-1 mt-1 text-[10px] font-semibold text-[#af4408] hover:underline">
                          <User className="w-3 h-3" />Save to CRM
                        </Link>
                      )}
                    </div>
                  </div>
                );
              })}
              {total > LIST_LIMIT && (
                <p className="p-3 text-[10px] text-[#8B7355] text-center">Showing the {LIST_LIMIT} most recent conversations.</p>
              )}
            </div>
          </div>

          {/* RIGHT — thread */}
          <div className={`${selectedId ? 'flex' : 'hidden md:flex'} flex-1 min-w-0 flex-col bg-[#FFFDF9]`}>
            {!selectedId ? (
              <div className="flex-1 flex flex-col items-center justify-center text-[#8B7355] p-8">
                <MessageCircle className="w-12 h-12 opacity-30 mb-3" />
                <p className="text-sm font-medium">Select a conversation</p>
                <p className="text-xs mt-1">Guest WhatsApp messages and replies appear here.</p>
              </div>
            ) : threadLoading && !thread ? (
              <div className="flex-1 flex items-center justify-center">
                <Loader2 className="w-6 h-6 text-[#af4408] animate-spin" />
              </div>
            ) : threadError && !thread ? (
              <div className="flex-1 flex items-center justify-center p-6">
                <div className="flex items-start gap-2 p-4 bg-red-50 border border-red-200 rounded-xl max-w-md">
                  <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />
                  <p className="text-sm text-red-700">{threadError}</p>
                </div>
              </div>
            ) : thread ? (
              <ThreadPane
                thread={thread}
                window={liveWindow || thread.window}
                provider={provider}
                onBack={() => setSelectedId(null)}
                onSent={m => { appendMessage(m); loadThread(thread.conversation.id, { silent: true }); loadList(); }}
                onWindowRefresh={w => { windowAnchor.current = { at: Date.now(), w }; setNowTick(Date.now()); }}
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────────── thread pane ───────────────────────────── */

function ThreadPane({ thread, window: win, provider, onBack, onSent, onWindowRefresh }: {
  thread: { conversation: ThreadConv; messages: Msg[]; window: WindowInfo; templates: Tpl[]; marketing_consent: MarketingConsent | null };
  window: WindowInfo;
  provider: ProviderInfo | null;
  onBack: () => void;
  onSent: (m: Msg) => void;
  onWindowRefresh: (w: WindowInfo) => void;
}) {
  const conv = thread.conversation;
  const unknown = conv.guest_handle.startsWith('phone:');
  const interakt = provider?.provider === 'interakt';
  const freeFormAllowed = win.open && !interakt;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickBottom = useRef(true);
  const lastMsgId = thread.messages.length ? thread.messages[thread.messages.length - 1].id : 0;

  // Autoscroll on new messages — only while the user is already near the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickBottom.current) el.scrollTop = el.scrollHeight;
  }, [lastMsgId, conv.id]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  return (
    <>
      {/* Thread header */}
      <div className="flex items-center gap-2.5 px-3 py-2.5 border-b border-[#F0E4D6] bg-white">
        <button onClick={onBack} className="md:hidden p-1.5 -ml-1 rounded-lg hover:bg-[#FFF1E3]" aria-label="Back to conversations">
          <ArrowLeft className="w-5 h-5 text-[#6B5744]" />
        </button>
        <Avatar name={unknown ? '' : conv.display_name} phone={conv.phone_key} />
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm text-[#2D1B0E] truncate">
            {unknown ? fmtPhoneKey(conv.phone_key) : conv.display_name}
          </p>
          <p className="text-[11px] text-[#6B5744] flex items-center gap-1.5 flex-wrap">
            <span>{fmtPhoneKey(conv.phone_key)}</span>
            <span className="inline-flex items-center gap-1">
              <WindowDot w={win} />
              {win.open
                ? <span className="text-green-700">window open until {istTime(win.expires_at)}</span>
                : <span>window closed</span>}
            </span>
            {thread.marketing_consent?.status === 'opted_out' && (
              <span
                className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-red-700 bg-red-50 border border-red-200 rounded-full px-2 py-px"
                title={`Opted out of marketing (${thread.marketing_consent.source}${thread.marketing_consent.detail ? `: ${thread.marketing_consent.detail}` : ''}) — broadcasts skip this guest automatically. Service replies here are unaffected.`}
              >
                <AlertTriangle className="w-2.5 h-2.5" /> Opted out of marketing
              </span>
            )}
          </p>
        </div>
        <Link href={`/crm-calls/guests/${encodeURIComponent(conv.guest_handle)}`}
              className={`shrink-0 text-[11px] font-semibold px-2.5 py-1.5 rounded-lg border transition-colors ${unknown
                ? 'text-[#af4408] border-[#af4408]/40 hover:bg-[#FFF1E3]'
                : 'text-[#6B5744] border-[#E0D0BE] hover:bg-[#FFF1E3]'}`}>
          {unknown ? 'Save to CRM' : 'Guest 360'}
        </Link>
      </div>

      {/* Messages */}
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-1.5">
        {thread.messages.length === 0 && (
          <p className="text-center text-xs text-[#8B7355] py-10">No messages in this conversation yet.</p>
        )}
        {thread.messages.map((m, i) => {
          const prev = thread.messages[i - 1];
          const t = m.wa_timestamp || m.created_at;
          const prevT = prev ? (prev.wa_timestamp || prev.created_at) : null;
          const newDay = !prev || istDayKey(t) !== istDayKey(prevT);
          const out = m.direction === 'out';
          const isTemplate = m.msg_type === 'template';
          // Broadcast-campaign sends are recorded with sent_by 'campaign:<id>'
          // — label them so a GRE reading the thread knows this was bulk
          // marketing, not a colleague's reply.
          const isCampaign = out && m.sent_by.startsWith('campaign:');
          return (
            <div key={m.id}>
              {newDay && (
                <div className="flex justify-center py-2">
                  <span className="text-[10px] font-semibold text-[#8B7355] bg-[#FFF1E3] border border-[#F0E4D6] rounded-full px-3 py-0.5">
                    {istDayLabel(t)}
                  </span>
                </div>
              )}
              <div className={`flex ${out ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] sm:max-w-[70%] rounded-2xl px-3 py-2 border shadow-sm ${out
                  ? 'bg-[#FFE8D2] border-[#F3D5B8] rounded-br-md'
                  : 'bg-white border-[#EFE3D4] rounded-bl-md'}`}>
                  {isCampaign ? (
                    <span
                      className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-[#7c3aed] bg-[#F3EEFB] border border-[#E0D4F5] rounded-full px-1.5 py-px mb-1"
                      title={`Sent by broadcast ${m.sent_by.slice('campaign:'.length)} — see CRM › Broadcasts for the campaign report`}
                    >
                      <Megaphone className="w-2.5 h-2.5" />Campaign broadcast
                    </span>
                  ) : isTemplate && (
                    <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-[#a8632b] bg-[#F3E9DC] border border-[#E8D5C4] rounded-full px-1.5 py-px mb-1">
                      <FileText className="w-2.5 h-2.5" />Template
                    </span>
                  )}
                  {m.msg_type === 'reaction' ? (
                    <p className="text-2xl leading-tight">{m.body || '👍'}</p>
                  ) : (
                    <>
                      {(m.media_id != null || m.media_status === 'failed') && <div className="mb-1"><MediaBlock m={m} /></div>}
                      {m.body && (
                        <p className="text-[13px] text-[#2D1B0E] whitespace-pre-wrap break-words">{m.body}</p>
                      )}
                      {!m.body && m.media_id == null && m.media_status !== 'failed' && (
                        <p className="text-[12px] italic text-[#8B7355]">[{m.msg_type}]</p>
                      )}
                    </>
                  )}
                  <div className={`flex items-center gap-1 mt-0.5 ${out ? 'justify-end' : ''}`}>
                    <span className="text-[10px] text-[#8B7355]">{istTime(t)}</span>
                    {out && <Ticks status={m.status} errorDetail={m.error_detail} />}
                  </div>
                  {out && m.status === 'failed' && m.error_detail && (
                    <p className="text-[10px] text-red-600 mt-0.5 break-words">{m.error_detail}</p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Composer */}
      <Composer
        convId={conv.id}
        window={win}
        interakt={interakt}
        freeFormAllowed={freeFormAllowed}
        templates={thread.templates}
        configured={provider ? provider.configured : true}
        onSent={onSent}
        onWindowRefresh={onWindowRefresh}
      />
    </>
  );
}

/* ───────────────────────────── composer ───────────────────────────── */

function Composer({ convId, window: win, interakt, freeFormAllowed, templates, configured, onSent, onWindowRefresh }: {
  convId: number;
  window: WindowInfo;
  interakt: boolean;
  freeFormAllowed: boolean;
  templates: Tpl[];
  configured: boolean;
  onSent: (m: Msg) => void;
  onWindowRefresh: (w: WindowInfo) => void;
}) {
  const [mode, setMode] = useState<'text' | 'template'>(freeFormAllowed ? 'text' : 'template');
  const [text, setText] = useState('');
  const [tplId, setTplId] = useState('');
  const [tplParams, setTplParams] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // When the window lapses (or opens) the composer follows — but never while
  // the GRE is mid-send.
  useEffect(() => {
    if (!sending) setMode(freeFormAllowed ? 'text' : 'template');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freeFormAllowed, convId]);

  useEffect(() => { setText(''); setTplId(''); setTplParams([]); setSendError(null); }, [convId]);

  const tpl = useMemo(() => templates.find(t => String(t.id) === tplId) || null, [templates, tplId]);
  const paramNames: string[] = useMemo(() => {
    if (!tpl) return [];
    try { const a = JSON.parse(tpl.param_order || '[]'); return Array.isArray(a) ? a.map(String) : []; }
    catch { return []; }
  }, [tpl]);

  const preview = useMemo(() => {
    if (!tpl) return '';
    let body = tpl.body || '';
    paramNames.forEach((name, i) => {
      const v = tplParams[i] || `{{${name}}}`;
      body = body.split(`{{${name}}}`).join(v);
    });
    return body;
  }, [tpl, paramNames, tplParams]);

  const send = async () => {
    if (sending) return;
    const payload = mode === 'template'
      ? { template_id: tplId, params: paramNames.map((_, i) => tplParams[i] || '') }
      : { text: text.trim() };
    if (mode === 'text' && !text.trim()) return;
    if (mode === 'template' && !tplId) { setSendError('Pick a template to send.'); return; }
    setSending(true);
    setSendError(null);
    try {
      const res = await api(`/api/crm-calls/inbox/${convId}/reply`, { method: 'POST', body: payload });
      let json: ReplyResp = {};
      try { json = await res.json(); } catch { /* non-JSON error body */ }
      if (json?.window) onWindowRefresh(json.window);
      if (res.ok && json?.ok) {
        if (json.message) onSent(json.message);
        if (mode === 'text') setText('');
        else { setTplId(''); setTplParams([]); }
        return;
      }
      // Failed send still lands in the thread (status='failed') — show it.
      if (json?.message) onSent(json.message);
      setSendError(json?.detail || json?.error || `Send failed (HTTP ${res.status})`);
    } catch {
      setSendError('Network error — the reply was not sent.');
    } finally {
      setSending(false);
    }
  };

  const whyTemplatesOnly = interakt
    ? 'Interakt sends approved templates only — its API has no free-form message path.'
    : win.expires_at
      ? `The 24-hour service window closed at ${istTime(win.expires_at)} IST — WhatsApp only delivers approved templates now. It reopens when the guest messages again.`
      : 'This guest has never messaged in, so there is no open 24-hour window — only approved templates can be delivered.';

  return (
    <div className="border-t border-[#F0E4D6] bg-white p-2.5 space-y-2">
      {!configured && (
        <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
          WhatsApp is not configured — an admin must complete Settings → Integrations → WhatsApp before replies can be sent.
        </p>
      )}

      {freeFormAllowed ? (
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-green-700">
            Free reply until <span className="font-semibold">{istTime(win.expires_at)}</span> IST (24h window)
          </p>
          <button onClick={() => setMode(m => (m === 'text' ? 'template' : 'text'))}
                  className="text-[11px] font-medium text-[#af4408] hover:underline">
            {mode === 'text' ? 'Send a template instead' : 'Back to free reply'}
          </button>
        </div>
      ) : (
        <p className="text-[11px] text-[#6B5744] bg-[#FFF8F0] border border-[#F0E4D6] rounded-lg px-2.5 py-1.5">
          {whyTemplatesOnly}
        </p>
      )}

      {sendError && (
        <div className="flex items-start gap-2 p-2 bg-red-50 border border-red-200 rounded-lg">
          <AlertCircle className="w-3.5 h-3.5 text-red-500 shrink-0 mt-0.5" />
          <p className="text-[11px] text-red-700">{sendError}</p>
        </div>
      )}

      {mode === 'text' && freeFormAllowed ? (
        <div className="flex items-end gap-2">
          <textarea
            rows={1}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Type a reply… (Enter to send, Shift+Enter for a new line)"
            aria-label="Reply message"
            className="flex-1 min-w-0 resize-none px-3 py-2.5 bg-[#FFF8F0] border border-[#E0D0BE] rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]/40 focus:border-[#af4408] max-h-32"
          />
          <button onClick={send} disabled={sending || !text.trim()}
                  aria-label="Send reply"
                  className="shrink-0 w-10 h-10 flex items-center justify-center bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 text-white rounded-xl transition-colors">
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {templates.length === 0 ? (
            <p className="text-[11px] text-[#8B7355]">
              No approved templates are mapped yet — an admin can mark templates “send as template” with a
              provider template name under WhatsApp settings.
            </p>
          ) : (
            <>
              <select value={tplId} onChange={e => { setTplId(e.target.value); setTplParams([]); setSendError(null); }}
                      aria-label="Approved template"
                      className="w-full px-3 py-2 bg-[#FFF8F0] border border-[#E0D0BE] rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]/40">
                <option value="">Choose an approved template…</option>
                {templates.map(t => (
                  <option key={t.id} value={t.id}>{t.name}{t.category ? ` · ${t.category}` : ''} ({t.provider_template_name})</option>
                ))}
              </select>
              {tpl && paramNames.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {paramNames.map((name, i) => (
                    <input key={name + i} type="text" value={tplParams[i] || ''}
                           onChange={e => setTplParams(prev => { const n = [...prev]; n[i] = e.target.value; return n; })}
                           placeholder={name}
                           aria-label={`Template parameter ${name}`}
                           className="px-3 py-2 bg-[#FFF8F0] border border-[#E0D0BE] rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]/40" />
                  ))}
                </div>
              )}
              {tpl && (
                <p className="text-[11px] text-[#6B5744] bg-[#FFF8F0] border border-[#F0E4D6] rounded-lg px-2.5 py-1.5 whitespace-pre-wrap">
                  {preview || `The approved ${tpl.provider_template_name} template on the provider decides the wording.`}
                </p>
              )}
              <div className="flex justify-end">
                <button onClick={send} disabled={sending || !tplId}
                        className="flex items-center gap-2 px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 text-white rounded-xl text-sm font-semibold transition-colors">
                  {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  Send template
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
