'use client';

/**
 * AI Analyst — "Ask your data" chat for admins & HODs.
 *
 * Natural-language questions about inventory / sales / costs, answered with
 * REAL numbers from the live DB (deterministic data-pack views + LLM — see
 * /api/crm/analyst). UI mirrors the CRM AI Assistant page (warm theme,
 * mobile-first, left rail with recent chats as a drawer on mobile).
 *
 * Client gate: admin or HOD (is_head_chef) — the answers contain financial
 * data. The API enforces the same gate server-side.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle, ArrowLeft, BarChart3, Loader2, MessageSquare, PanelLeft, Plus,
  Send, X,
} from 'lucide-react';
import { api } from '@/lib/api';

/* ── types ────────────────────────────────────────────────────────────── */

interface ChatSession {
  id: string;
  title: string;
  updated_at: string;
}

interface ChatMessage {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  response_time_ms?: number | null;
  views_used?: string[]; // live responses only (not persisted per-message)
}

/* ── suggested questions ──────────────────────────────────────────────── */

const SUGGESTED_QUESTIONS: string[] = [
  'Which ingredients should I reorder today?',
  "What's driving my food costs up this week?",
  'Which menu items have the highest margins?',
  'Where are my biggest stock variances?',
  "What's selling best this week?",
  'Show me slow-moving stock',
];

const VIEW_LABELS: Record<string, string> = {
  stockAlerts: 'stock',
  reorderSuggestions: 'reorder',
  salesSummary: 'sales',
  foodCost: 'food cost',
  varianceReport: 'variance',
  menuMargins: 'margins',
  purchaseTrends: 'purchases',
  wastageSummary: 'wastage',
  slowMovers: 'slow movers',
};

/* ── markdown-lite rendering (bold + line breaks + simple pipe tables) ── */

function boldParts(line: string, keyPrefix: string): React.ReactNode[] {
  const parts = line.split(/\*\*(.+?)\*\*/g);
  return parts.map((p, i) =>
    i % 2 === 1
      ? <strong key={`${keyPrefix}-${i}`} className="font-semibold">{p}</strong>
      : <span key={`${keyPrefix}-${i}`}>{p}</span>
  );
}

function isTableSeparator(line: string): boolean {
  // e.g. |---|:--:|---| (dashes/colons only between pipes)
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-');
}

function splitCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map(c => c.trim());
}

function MarkdownLite({ text }: { text: string }) {
  const lines = text.split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];
    // Pipe table: ≥2 consecutive lines containing '|' with cells.
    if (line.trim().startsWith('|') && i + 1 < lines.length && lines[i + 1].trim().startsWith('|')) {
      const tbl: string[][] = [];
      let hasHeader = false;
      let j = i;
      while (j < lines.length && lines[j].trim().startsWith('|')) {
        if (isTableSeparator(lines[j])) { if (tbl.length === 1) hasHeader = true; }
        else tbl.push(splitCells(lines[j]));
        j++;
      }
      blocks.push(
        <div key={`t${key++}`} className="overflow-x-auto my-1.5">
          <table className="text-xs border-collapse">
            <tbody>
              {tbl.map((cells, ri) => (
                <tr key={ri} className={hasHeader && ri === 0 ? 'bg-[#FFF8F0] font-semibold' : ''}>
                  {cells.map((c, ci) => (
                    <td key={ci} className="border border-[#E8D5C4] px-2 py-1 whitespace-nowrap">
                      {boldParts(c, `t${key}-${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      i = j;
      continue;
    }
    // Heading → bold line; everything else renders as-is (bullets preserved).
    const h = line.match(/^\s*#{1,6}\s+(.*)$/);
    blocks.push(
      <span key={`l${key++}`} className={h ? 'font-semibold' : undefined}>
        {i > 0 && <br />}
        {boldParts(h ? h[1] : line, `l${key}`)}
      </span>
    );
    i++;
  }
  return <>{blocks}</>;
}

function shortDate(iso: string): string {
  try {
    const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  } catch { return ''; }
}

/* ── left rail (top-level so state survives re-renders) ───────────────── */

function Rail({
  sessions, sessionsLoading, sessionsError, activeSessionId,
  onQuestion, onSession, onNewChat,
}: {
  sessions: ChatSession[];
  sessionsLoading: boolean;
  sessionsError: string | null;
  activeSessionId: string | null;
  onQuestion: (q: string) => void;
  onSession: (id: string) => void;
  onNewChat: () => void;
}) {
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="p-3 border-b border-[#E8D5C4]">
        <button
          onClick={onNewChat}
          className="w-full flex items-center justify-center gap-2 bg-[#af4408] hover:bg-[#8a3506] text-white text-sm font-medium rounded-lg px-3 py-2"
        >
          <Plus size={16} /> New Analysis
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-5">
        {/* Suggested questions */}
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-[#8B7355] mb-2">Ask About</div>
          <div className="space-y-0.5">
            {SUGGESTED_QUESTIONS.map(q => (
              <button
                key={q}
                onClick={() => onQuestion(q)}
                className="w-full flex items-center gap-2 text-left text-sm text-[#2D1B0E] hover:bg-[#FFF8F0] rounded-lg px-2 py-1.5"
              >
                <BarChart3 size={14} className="text-[#af4408] shrink-0" />
                <span className="truncate">{q}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Recent analyst chats */}
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-[#8B7355] mb-2">Recent Analyses</div>
          {sessionsLoading ? (
            <div className="flex items-center gap-2 text-sm text-[#8B7355] px-2 py-1.5">
              <Loader2 size={14} className="animate-spin" /> Loading…
            </div>
          ) : sessionsError ? (
            <div className="text-sm text-red-700 px-2 py-1.5">{sessionsError}</div>
          ) : sessions.length === 0 ? (
            <div className="text-sm text-[#8B7355] px-2 py-1.5">No analyses yet — ask your first question.</div>
          ) : (
            <div className="space-y-0.5">
              {sessions.map(s => (
                <button
                  key={s.id}
                  onClick={() => onSession(s.id)}
                  className={`w-full flex items-center gap-2 text-left text-sm rounded-lg px-2 py-1.5 ${
                    s.id === activeSessionId
                      ? 'bg-[#FFF8F0] text-[#af4408] font-medium'
                      : 'text-[#2D1B0E] hover:bg-[#FFF8F0]'
                  }`}
                >
                  <MessageSquare size={14} className="shrink-0 text-[#8B7355]" />
                  <span className="truncate flex-1">{s.title || 'Untitled analysis'}</span>
                  <span className="text-[10px] text-[#8B7355] shrink-0">{shortDate(s.updated_at)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── page ─────────────────────────────────────────────────────────────── */

export default function CrmAnalystPage() {
  const router = useRouter();
  const [me, setMe] = useState<any>(undefined); // undefined = loading, null = signed out

  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState<string | null>(null);

  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);

  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState<number | null>(null);

  const [drawerOpen, setDrawerOpen] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const allowed = !!me && (me.role === 'admin' || me.is_head_chef);

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.json())
      .then(d => setMe(d?.user ?? null))
      .catch(() => setMe(null));
  }, []);

  const loadSessions = useCallback(() => {
    fetch('/api/crm/analyst/sessions')
      .then(r => r.json())
      .then(j => {
        if (j.error) { setSessionsError(j.error); return; }
        setSessionsError(null);
        setSessions(j.sessions || []);
      })
      .catch(e => setSessionsError(e?.message || 'Failed to load analyses'))
      .finally(() => setSessionsLoading(false));
  }, []);

  useEffect(() => {
    if (allowed) loadSessions();
  }, [allowed, loadSessions]);

  /* 429 cooldown countdown */
  useEffect(() => {
    if (cooldown == null || cooldown <= 0) return;
    const t = setInterval(() => {
      setCooldown(c => {
        if (c == null || c <= 1) { clearInterval(t); return null; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  /* auto-scroll to the newest message */
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, sending]);

  const newChat = () => {
    setActiveSessionId(null);
    setMessages([]);
    setError(null);
    setCooldown(null);
    setDrawerOpen(false);
    inputRef.current?.focus();
  };

  const loadSession = (id: string) => {
    setActiveSessionId(id);
    setMessages([]);
    setError(null);
    setCooldown(null);
    setDrawerOpen(false);
    setMessagesLoading(true);
    fetch(`/api/crm/analyst/sessions/${id}/messages`)
      .then(r => r.json())
      .then(j => {
        if (j.error) { setError(j.error); return; }
        setMessages((j.messages || []).map((m: any) => ({
          id: m.id, role: m.role, content: m.content, response_time_ms: m.response_time_ms,
        })));
      })
      .catch(e => setError(e?.message || 'Failed to load messages'))
      .finally(() => setMessagesLoading(false));
  };

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || sending) return;
    setError(null);
    setCooldown(null);
    setDrawerOpen(false);
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: question }]);
    setSending(true);
    try {
      const r = await api('/api/crm/analyst', {
        method: 'POST',
        body: { session_id: activeSessionId, question },
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 429) {
        setCooldown(Number(j.wait_seconds) || 30);
        return;
      }
      if (!r.ok) {
        setError(j.error || `HTTP ${r.status}`);
        return;
      }
      if (!activeSessionId && j.session_id) setActiveSessionId(j.session_id);
      setMessages(prev => [...prev, {
        role: 'assistant', content: j.content || '',
        response_time_ms: j.response_time_ms,
        views_used: Array.isArray(j.views_used) ? j.views_used : undefined,
      }]);
      loadSessions();
    } catch (e: any) {
      setError(e?.message || 'Failed to send question');
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  };

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
          🔒 Admins and department heads only. The AI Analyst answers with financial data
          (costs, revenue, margins) — ask an admin for access.
        </div>
      </div>
    );
  }

  const showEmptyState = !messagesLoading && messages.length === 0;

  return (
    <div className="flex gap-4 h-[calc(100dvh-6.5rem)] lg:h-[calc(100vh-4.5rem)] min-h-[420px]">
      {/* Left rail — desktop */}
      <aside className="hidden lg:block w-72 shrink-0 bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        <Rail
          sessions={sessions} sessionsLoading={sessionsLoading} sessionsError={sessionsError}
          activeSessionId={activeSessionId}
          onQuestion={send} onSession={loadSession} onNewChat={newChat}
        />
      </aside>

      {/* Main chat column */}
      <section className="flex-1 min-w-0 flex flex-col bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 sm:px-4 py-2.5 border-b border-[#E8D5C4]">
          <button
            onClick={() => router.back()}
            className="inline-flex items-center gap-1 shrink-0 text-sm text-[#6B5744] hover:text-[#2D1B0E] transition-colors"
            aria-label="Go back"
          >
            <ArrowLeft className="w-4 h-4" />
            <span className="hidden sm:inline">Back</span>
          </button>
          <button
            onClick={() => setDrawerOpen(true)}
            className="lg:hidden p-1.5 rounded-lg text-[#6B5744] hover:bg-[#FFF8F0]"
            aria-label="Open suggestions and past analyses"
          >
            <PanelLeft size={18} />
          </button>
          <div className="w-8 h-8 rounded-full bg-[#af4408] text-white flex items-center justify-center shrink-0">
            <BarChart3 size={17} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-sm font-semibold text-[#2D1B0E] truncate">AI Analyst — Ask your data</h1>
            <p className="text-[11px] text-[#8B7355] truncate hidden sm:block">
              Live answers from your inventory, sales & cost records
            </p>
          </div>
          <button
            onClick={newChat}
            className="hidden sm:flex items-center gap-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white text-sm rounded-lg px-3 py-1.5"
          >
            <Plus size={15} /> New
          </button>
        </div>

        {/* Message stream */}
        <div className="flex-1 overflow-y-auto px-3 sm:px-5 py-4 space-y-3 bg-[#FFFDFA]">
          {messagesLoading ? (
            <div className="h-full flex items-center justify-center text-[#8B7355]">
              <Loader2 size={22} className="animate-spin mr-2" /> Loading analysis…
            </div>
          ) : showEmptyState ? (
            <div className="h-full flex flex-col items-center justify-center text-center px-4">
              <div className="w-14 h-14 rounded-full bg-[#FFF8F0] border border-[#E8D5C4] flex items-center justify-center mb-3">
                <BarChart3 size={26} className="text-[#af4408]" />
              </div>
              <h2 className="text-base font-semibold text-[#2D1B0E]">Ask anything about your numbers</h2>
              <p className="text-sm text-[#6B5744] mt-1 max-w-sm">
                Reorders, food cost, margins, variances, wastage, dead stock — answers come
                straight from your live data, in ₹.
              </p>
              <div className="flex flex-wrap justify-center gap-2 mt-4 max-w-lg">
                {SUGGESTED_QUESTIONS.map(q => (
                  <button
                    key={q}
                    onClick={() => send(q)}
                    className="text-sm bg-[#FFF8F0] border border-[#E8D5C4] text-[#2D1B0E] rounded-full px-3 py-1.5 hover:border-[#af4408] hover:text-[#af4408]"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              {messages.map((m, i) => {
                if (m.role === 'user') {
                  return (
                    <div key={m.id || `m${i}`} className="flex justify-end">
                      <div className="max-w-[85%] bg-[#af4408] text-white text-sm rounded-2xl rounded-br-sm px-4 py-2.5 break-words">
                        <MarkdownLite text={m.content} />
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={m.id || `m${i}`} className="flex justify-start">
                    <div className="max-w-[92%] min-w-0">
                      <div className="bg-white border border-[#E8D5C4] text-sm text-[#2D1B0E] rounded-2xl rounded-bl-sm px-4 py-2.5 break-words">
                        <MarkdownLite text={m.content} />
                      </div>
                      {(!!m.views_used?.length || m.response_time_ms != null) && (
                        <div className="flex items-center flex-wrap gap-1.5 mt-1 ml-1">
                          {!!m.views_used?.length && (
                            <span className="inline-flex items-center text-[10px] text-[#8B7355] bg-[#FFF8F0] border border-[#E8D5C4] rounded-full px-2 py-0.5">
                              {m.views_used.map(v => VIEW_LABELS[v] || v).join(' · ')}
                            </span>
                          )}
                          {m.response_time_ms != null && (
                            <span className="text-[10px] text-[#8B7355]">
                              {(Number(m.response_time_ms) / 1000).toFixed(1)}s
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              {sending && (
                <div className="flex justify-start">
                  <div className="bg-white border border-[#E8D5C4] rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-[#af4408]/60 animate-bounce" />
                    <span className="w-2 h-2 rounded-full bg-[#af4408]/60 animate-bounce [animation-delay:150ms]" />
                    <span className="w-2 h-2 rounded-full bg-[#af4408]/60 animate-bounce [animation-delay:300ms]" />
                    <span className="ml-1.5 text-sm text-[#8B7355]">Crunching your numbers…</span>
                  </div>
                </div>
              )}
            </>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Error / cooldown banners */}
        {cooldown != null && (
          <div className="mx-3 sm:mx-5 mb-2 flex items-center gap-2 bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-lg px-3 py-2">
            <AlertCircle size={15} className="shrink-0" />
            AI is cooling down, retry in {cooldown}s
          </div>
        )}
        {error && (
          <div className="mx-3 sm:mx-5 mb-2 flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2">
            <AlertCircle size={15} className="shrink-0" />
            <span className="flex-1 break-words">{error}</span>
            <button onClick={() => setError(null)} className="shrink-0 p-0.5 hover:opacity-70" aria-label="Dismiss error">
              <X size={14} />
            </button>
          </div>
        )}

        {/* Input */}
        <div className="border-t border-[#E8D5C4] p-2.5 sm:p-3">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder="Ask about stock, sales, costs, margins… (Enter to send)"
              className="flex-1 bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg px-3 py-2.5 text-sm text-[#2D1B0E] placeholder:text-[#8B7355] resize-none focus:outline-none focus:border-[#af4408] max-h-32"
              disabled={sending}
            />
            <button
              onClick={() => send(input)}
              disabled={sending || !input.trim()}
              className="shrink-0 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg p-2.5"
              aria-label="Send question"
            >
              {sending ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
            </button>
          </div>
        </div>
      </section>

      {/* Mobile drawer for the left rail */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setDrawerOpen(false)} />
          <aside className="absolute left-0 top-0 bottom-0 w-[85%] max-w-xs bg-white shadow-xl flex flex-col">
            <div className="flex items-center justify-between px-3 py-2.5 border-b border-[#E8D5C4]">
              <span className="text-sm font-semibold text-[#2D1B0E]">AI Analyst</span>
              <button
                onClick={() => setDrawerOpen(false)}
                className="p-1.5 rounded-lg text-[#6B5744] hover:bg-[#FFF8F0]"
                aria-label="Close panel"
              >
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 min-h-0">
              <Rail
                sessions={sessions} sessionsLoading={sessionsLoading} sessionsError={sessionsError}
                activeSessionId={activeSessionId}
                onQuestion={send} onSession={loadSession} onNewChat={newChat}
              />
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
