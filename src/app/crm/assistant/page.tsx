'use client';

/**
 * AKAN CRM — AI Assistant (ChatGPT-style chat for front desk staff).
 *
 * Left rail (drawer on mobile): Quick Topics, Call Scripts, Recent Chats.
 * Main: message stream + typing indicator + input, language select, New Chat.
 *
 * Call-recording analysis: the paperclip beside Send uploads an audio file to
 * /api/crm/chat/analyze-recording. Structured results ({kind:'call_analysis'}
 * JSON) render as a full-width CallAnalysisCard scorecard; legacy markdown
 * analyses keep the old text bubble + Score chip.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle, ArrowLeft, Bot, Briefcase, Building2, Cake, Car, Clock, FileText, Loader2,
  MapPin, MessageSquare, Music, PanelLeft, Paperclip, Phone, Plus, Send, Shirt,
  Sparkles, Ticket, UserRound, UtensilsCrossed, Wine, X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from '@/lib/api';
import CallAnalysisCard, { type CallAnalysisData } from './CallAnalysisCard';

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
  score?: number | null; // call-analysis quality score (client-side only)
}

interface CallScript {
  id: string;
  title: string;
  scenario?: string;
  opening?: string;
  key_questions?: string[];
  key_info_to_share?: string[];
  closing?: string;
  upsell_tips?: string[];
}

/* ── quick topics (ported from akan-crm templates/index.html) ─────────── */

const QUICK_TOPICS: { category: string; topics: { icon: LucideIcon; label: string; q: string }[] }[] = [
  {
    category: 'General',
    topics: [
      { icon: Clock, label: 'Timings', q: 'What are the timings of Akan?' },
      { icon: MapPin, label: 'Location', q: 'What is the location and how to reach Akan?' },
      { icon: Phone, label: 'Contact & Reservations', q: 'What are the contact details and how to make a reservation?' },
      { icon: Car, label: 'Parking', q: 'Is there parking available?' },
    ],
  },
  {
    category: 'Spaces & Seating',
    topics: [
      { icon: Building2, label: 'All Floors', q: 'Tell me about all the floors and seating capacity' },
      { icon: Music, label: '1st Floor - Pub', q: 'Tell me about the 1st floor pub area' },
      { icon: Building2, label: '2nd Floor', q: 'Tell me about the 2nd floor' },
      { icon: Sparkles, label: '3rd Floor - Outdoor', q: 'Tell me about the 3rd floor with cable bridge view' },
    ],
  },
  {
    category: 'Policies',
    topics: [
      { icon: Ticket, label: 'Entry & Cover Charges', q: 'What is the entry fee and cover charge policy?' },
      { icon: UserRound, label: 'Age Policy', q: 'What is the age policy for all floors?' },
      { icon: Shirt, label: 'Dress Code', q: 'What is the dress code?' },
    ],
  },
  {
    category: 'Events & Entertainment',
    topics: [
      { icon: Music, label: 'Weekend Live Bands', q: 'What live events happen on weekends?' },
      { icon: UtensilsCrossed, label: 'Sunday Brunch', q: 'Tell me about Sunday brunch buffet and pricing' },
      { icon: Sparkles, label: 'Sunday Workshops', q: 'What workshops are available on Sundays?' },
    ],
  },
  {
    category: 'Corporate & Parties',
    topics: [
      { icon: Briefcase, label: 'Corporate Events', q: 'Tell me about corporate event options and packages' },
      { icon: Cake, label: 'Birthday Parties', q: 'How can someone host a birthday party at Akan?' },
    ],
  },
  {
    category: 'Food & Drinks',
    topics: [
      { icon: UtensilsCrossed, label: 'Menu & Cuisine', q: 'Tell me about the menu and cuisine options' },
      { icon: Wine, label: 'Bar & Drinks', q: 'What drinks and bar options are available?' },
    ],
  },
];

const EMPTY_STATE_CHIPS: { label: string; q: string }[] = [
  { label: 'Timings', q: 'What are the timings?' },
  { label: 'Sunday Brunch', q: 'Tell me about Sunday brunch' },
  { label: 'Weekend Events', q: 'What events happen on weekends?' },
  { label: 'Reservations', q: 'How to book a table?' },
];

/* ── structured call-analysis detection ───────────────────────────────── */

/**
 * Assistant messages that store the structured scorecard are JSON strings
 * tagged {kind:'call_analysis'} (both live responses and saved sessions).
 * Anything else — normal chat replies, legacy markdown analyses — returns
 * null and takes the plain-text bubble path.
 */
function tryParseCallAnalysis(content: string): CallAnalysisData | null {
  const text = (content || '').trim();
  if (!text.startsWith('{')) return null;
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object' && obj.kind === 'call_analysis' && obj.dimensions) {
      return obj as CallAnalysisData;
    }
  } catch { /* not JSON — plain text message */ }
  return null;
}

/* ── text rendering: line breaks + **bold** (no innerHTML) ────────────── */

function boldParts(line: string, keyPrefix: string): React.ReactNode[] {
  const parts = line.split(/\*\*(.+?)\*\*/g);
  return parts.map((p, i) =>
    i % 2 === 1
      ? <strong key={`${keyPrefix}-${i}`} className="font-semibold">{p}</strong>
      : <span key={`${keyPrefix}-${i}`}>{p}</span>
  );
}

function FormattedText({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <>
      {lines.map((line, i) => (
        <span key={i}>
          {i > 0 && <br />}
          {boldParts(line, `l${i}`)}
        </span>
      ))}
    </>
  );
}

function shortDate(iso: string): string {
  try {
    const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  } catch { return ''; }
}

/* ── left rail (top-level component so focus/scroll state survives) ───── */

function Rail({
  sessions, sessionsLoading, sessionsError, activeSessionId,
  scripts, scriptsLoading,
  onTopic, onScript, onSession, onNewChat,
}: {
  sessions: ChatSession[];
  sessionsLoading: boolean;
  sessionsError: string | null;
  activeSessionId: string | null;
  scripts: CallScript[];
  scriptsLoading: boolean;
  onTopic: (q: string) => void;
  onScript: (s: CallScript) => void;
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
          <Plus size={16} /> New Chat
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-5">
        {/* Quick Topics */}
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-[#8B7355] mb-2">Quick Topics</div>
          <div className="space-y-3">
            {QUICK_TOPICS.map(group => (
              <div key={group.category}>
                <div className="text-xs font-medium text-[#6B5744] mb-1">{group.category}</div>
                <div className="space-y-0.5">
                  {group.topics.map(t => {
                    const Icon = t.icon;
                    return (
                      <button
                        key={t.label}
                        onClick={() => onTopic(t.q)}
                        className="w-full flex items-center gap-2 text-left text-sm text-[#2D1B0E] hover:bg-[#FFF8F0] rounded-lg px-2 py-1.5"
                      >
                        <Icon size={14} className="text-[#af4408] shrink-0" />
                        <span className="truncate">{t.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Call Scripts */}
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-[#8B7355] mb-2">Call Scripts</div>
          {scriptsLoading ? (
            <div className="flex items-center gap-2 text-sm text-[#8B7355] px-2 py-1.5">
              <Loader2 size={14} className="animate-spin" /> Loading…
            </div>
          ) : scripts.length === 0 ? (
            <div className="text-sm text-[#8B7355] px-2 py-1.5">No call scripts in the knowledge base yet.</div>
          ) : (
            <div className="space-y-0.5">
              {scripts.map(s => (
                <button
                  key={s.id}
                  onClick={() => onScript(s)}
                  className="w-full flex items-center gap-2 text-left text-sm text-[#2D1B0E] hover:bg-[#FFF8F0] rounded-lg px-2 py-1.5"
                >
                  <FileText size={14} className="text-[#af4408] shrink-0" />
                  <span className="truncate">{s.title}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Recent Chats */}
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-[#8B7355] mb-2">Recent Chats</div>
          {sessionsLoading ? (
            <div className="flex items-center gap-2 text-sm text-[#8B7355] px-2 py-1.5">
              <Loader2 size={14} className="animate-spin" /> Loading…
            </div>
          ) : sessionsError ? (
            <div className="text-sm text-red-700 px-2 py-1.5">{sessionsError}</div>
          ) : sessions.length === 0 ? (
            <div className="text-sm text-[#8B7355] px-2 py-1.5">No chats yet — ask your first question.</div>
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
                  <span className="truncate flex-1">{s.title || 'Untitled chat'}</span>
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

export default function CrmAssistantPage() {
  const router = useRouter();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState<string | null>(null);

  const [scripts, setScripts] = useState<CallScript[]>([]);
  const [scriptsLoading, setScriptsLoading] = useState(true);

  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);

  const [input, setInput] = useState('');
  const [language, setLanguage] = useState<'english' | 'telugu' | 'hindi'>('english');
  const [sending, setSending] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState<number | null>(null);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeScript, setActiveScript] = useState<CallScript | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /* load sessions + scripts */
  const loadSessions = useCallback(() => {
    fetch('/api/crm/chat/sessions')
      .then(r => r.json())
      .then(j => {
        if (j.error) { setSessionsError(j.error); return; }
        setSessionsError(null);
        setSessions(j.sessions || []);
      })
      .catch(e => setSessionsError(e?.message || 'Failed to load chats'))
      .finally(() => setSessionsLoading(false));
  }, []);

  useEffect(() => {
    loadSessions();
    fetch('/api/crm/chat/scripts')
      .then(r => r.json())
      .then(j => setScripts(Array.isArray(j.scripts) ? j.scripts : []))
      .catch(() => setScripts([]))
      .finally(() => setScriptsLoading(false));
  }, [loadSessions]);

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
  }, [messages, sending, analyzing]);

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
    fetch(`/api/crm/chat/sessions/${id}/messages`)
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
    const message = text.trim();
    if (!message || sending || analyzing) return;
    setError(null);
    setCooldown(null);
    setDrawerOpen(false);
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: message }]);
    setSending(true);
    try {
      const r = await api('/api/crm/chat/message', {
        method: 'POST',
        body: { session_id: activeSessionId, message, language },
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 429) {
        const wait = Number(j.wait_seconds) || 30;
        setCooldown(wait);
        return;
      }
      if (!r.ok) {
        setError(j.error || `HTTP ${r.status}`);
        return;
      }
      const isFirstMessage = !activeSessionId;
      if (isFirstMessage && j.session_id) setActiveSessionId(j.session_id);
      setMessages(prev => [...prev, {
        role: 'assistant', content: j.content || '', response_time_ms: j.response_time_ms,
      }]);
      // Refresh Recent Chats (new session title / updated_at ordering).
      loadSessions();
    } catch (e: any) {
      setError(e?.message || 'Failed to send message');
    } finally {
      setSending(false);
    }
  };

  /* upload a call recording → AI transcript + score + coaching */
  const analyzeRecording = async (file: File) => {
    if (sending || analyzing) return;
    setError(null);
    setCooldown(null);
    setDrawerOpen(false);
    if (file.size > 14 * 1024 * 1024) {
      setError('Recording too large (max 14MB) — trim or compress it');
      return;
    }
    setMessages(prev => [...prev, { role: 'user', content: `Uploaded recording: ${file.name}` }]);
    setAnalyzing(true);
    try {
      const fd = new FormData();
      fd.append('audio', file);
      fd.append('language', language);
      const r = await api('/api/crm/chat/analyze-recording', { method: 'POST', body: fd });
      const j = await r.json().catch(() => ({}));
      if (r.status === 429) {
        const wait = Number(j.wait_seconds) || 30;
        setCooldown(wait);
        return;
      }
      if (!r.ok) {
        setError(j.error || `HTTP ${r.status}`);
        return;
      }
      // The analysis lives in a fresh session — switch to it.
      if (j.session_id) setActiveSessionId(j.session_id);
      setMessages(prev => [...prev, {
        role: 'assistant', content: j.content || '',
        response_time_ms: j.response_time_ms, score: j.score ?? null,
      }]);
      loadSessions();
    } catch (e: any) {
      setError(e?.message || 'Failed to analyze recording');
    } finally {
      setAnalyzing(false);
    }
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (file) analyzeRecording(file);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  };

  const useScriptInChat = (s: CallScript) => {
    setActiveScript(null);
    send(`A customer is calling about: ${s.scenario || s.title}. Help me handle this call with the best response.`);
  };

  const showEmptyState = !messagesLoading && messages.length === 0;

  return (
    <div className="flex gap-4 h-[calc(100dvh-6.5rem)] lg:h-[calc(100vh-4.5rem)] min-h-[420px]">
      {/* Left rail — desktop */}
      <aside className="hidden lg:block w-72 shrink-0 bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        <Rail
          sessions={sessions} sessionsLoading={sessionsLoading} sessionsError={sessionsError}
          activeSessionId={activeSessionId}
          scripts={scripts} scriptsLoading={scriptsLoading}
          onTopic={send} onScript={setActiveScript} onSession={loadSession} onNewChat={newChat}
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
            aria-label="Open topics and chats"
          >
            <PanelLeft size={18} />
          </button>
          <div className="w-8 h-8 rounded-full bg-[#af4408] text-white flex items-center justify-center shrink-0">
            <Bot size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-sm font-semibold text-[#2D1B0E] truncate">Akan Assistant</h1>
            <p className="text-[11px] text-[#8B7355] truncate hidden sm:block">
              Answers for calls, WhatsApp & walk-in queries
            </p>
          </div>
          <select
            value={language}
            onChange={e => setLanguage(e.target.value as typeof language)}
            className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg px-2 py-1.5 text-xs sm:text-sm text-[#2D1B0E]"
            aria-label="Response language"
          >
            <option value="english">English</option>
            <option value="telugu">Telugu</option>
            <option value="hindi">Hindi</option>
          </select>
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
              <Loader2 size={22} className="animate-spin mr-2" /> Loading chat…
            </div>
          ) : showEmptyState ? (
            <div className="h-full flex flex-col items-center justify-center text-center px-4">
              <div className="w-14 h-14 rounded-full bg-[#FFF8F0] border border-[#E8D5C4] flex items-center justify-center mb-3">
                <Bot size={26} className="text-[#af4408]" />
              </div>
              <h2 className="text-base font-semibold text-[#2D1B0E]">Ask me anything about Akan</h2>
              <p className="text-sm text-[#6B5744] mt-1 max-w-sm">
                Timings, floors, menu, events, packages, policies — I&apos;ll draft the reply you can read out on a call or paste into WhatsApp.
              </p>
              <div className="flex flex-wrap justify-center gap-2 mt-4">
                {EMPTY_STATE_CHIPS.map(c => (
                  <button
                    key={c.label}
                    onClick={() => send(c.q)}
                    className="text-sm bg-[#FFF8F0] border border-[#E8D5C4] text-[#2D1B0E] rounded-full px-3 py-1.5 hover:border-[#af4408] hover:text-[#af4408]"
                  >
                    {c.label}
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
                        <FormattedText text={m.content} />
                      </div>
                    </div>
                  );
                }
                // Structured call-analysis → full-width scorecard card.
                const analysis = tryParseCallAnalysis(m.content);
                if (analysis) {
                  return (
                    <div key={m.id || `m${i}`} className="w-full">
                      <CallAnalysisCard data={analysis} />
                      {m.response_time_ms != null && (
                        <div className="text-[10px] text-[#8B7355] mt-1 ml-1">
                          {(Number(m.response_time_ms) / 1000).toFixed(1)}s
                        </div>
                      )}
                    </div>
                  );
                }
                // Plain chat replies + legacy markdown analyses (old Score chip).
                return (
                  <div key={m.id || `m${i}`} className="flex justify-start">
                    <div className="max-w-[90%]">
                      <div className="bg-white border border-[#E8D5C4] text-sm text-[#2D1B0E] rounded-2xl rounded-bl-sm px-4 py-2.5 break-words">
                        <FormattedText text={m.content} />
                      </div>
                      {(m.score != null || m.response_time_ms != null) && (
                        <div className="flex items-center gap-2 mt-1 ml-1">
                          {m.score != null && (
                            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#af4408] bg-[#FFF8F0] border border-[#E8D5C4] rounded-full px-2 py-0.5">
                              <Sparkles size={11} /> Score: {m.score}/10
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
              {(sending || analyzing) && (
                <div className="flex justify-start">
                  <div className="bg-white border border-[#E8D5C4] rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-[#af4408]/60 animate-bounce" />
                    <span className="w-2 h-2 rounded-full bg-[#af4408]/60 animate-bounce [animation-delay:150ms]" />
                    <span className="w-2 h-2 rounded-full bg-[#af4408]/60 animate-bounce [animation-delay:300ms]" />
                    {analyzing && (
                      <span className="ml-1.5 text-sm text-[#8B7355]">Analyzing call recording…</span>
                    )}
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
              placeholder="Type a customer question… (Enter to send)"
              className="flex-1 bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg px-3 py-2.5 text-sm text-[#2D1B0E] placeholder:text-[#8B7355] resize-none focus:outline-none focus:border-[#af4408] max-h-32"
              disabled={sending || analyzing}
            />
            <input
              ref={fileRef}
              type="file"
              accept="audio/*,.m4a,.aac,.flac,.webm,.mp4"
              onChange={onFileChange}
              className="hidden"
              aria-hidden="true"
              tabIndex={-1}
            />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={sending || analyzing}
              className="shrink-0 bg-[#FFF8F0] border border-[#E8D5C4] hover:border-[#af4408] hover:text-[#af4408] disabled:opacity-50 disabled:cursor-not-allowed text-[#6B5744] rounded-lg p-2.5"
              aria-label="Upload call recording for analysis"
              title="Upload call recording for AI analysis (max 14MB)"
            >
              {analyzing ? <Loader2 size={18} className="animate-spin" /> : <Paperclip size={18} />}
            </button>
            <button
              onClick={() => send(input)}
              disabled={sending || analyzing || !input.trim()}
              className="shrink-0 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg p-2.5"
              aria-label="Send message"
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
              <span className="text-sm font-semibold text-[#2D1B0E]">Akan Assistant</span>
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
                scripts={scripts} scriptsLoading={scriptsLoading}
                onTopic={send} onScript={s => { setDrawerOpen(false); setActiveScript(s); }}
                onSession={loadSession} onNewChat={newChat}
              />
            </div>
          </aside>
        </div>
      )}

      {/* Call script slide-over */}
      {activeScript && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/40" onClick={() => setActiveScript(null)} />
          <aside className="absolute right-0 top-0 bottom-0 w-full sm:w-[420px] bg-white shadow-xl flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-[#E8D5C4]">
              <h2 className="text-sm font-semibold text-[#2D1B0E] flex items-center gap-2 min-w-0">
                <FileText size={16} className="text-[#af4408] shrink-0" />
                <span className="truncate">{activeScript.title}</span>
              </h2>
              <button
                onClick={() => setActiveScript(null)}
                className="p-1.5 rounded-lg text-[#6B5744] hover:bg-[#FFF8F0]"
                aria-label="Close script"
              >
                <X size={18} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {activeScript.scenario && (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-[#8B7355] mb-1">Scenario</h3>
                  <p className="text-sm text-[#2D1B0E]">{activeScript.scenario}</p>
                </div>
              )}
              {activeScript.opening && (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-[#8B7355] mb-1">Opening Line</h3>
                  <p className="text-sm text-[#2D1B0E] bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg px-3 py-2">
                    &ldquo;{activeScript.opening}&rdquo;
                  </p>
                </div>
              )}
              {!!activeScript.key_questions?.length && (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-[#8B7355] mb-1">Key Questions to Ask</h3>
                  <ul className="space-y-1.5">
                    {activeScript.key_questions.map((q, i) => (
                      <li key={i} className="text-sm text-[#2D1B0E] flex gap-2">
                        <span className="text-[#af4408] shrink-0">•</span>{q}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {!!activeScript.key_info_to_share?.length && (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-[#8B7355] mb-1">Key Info to Share</h3>
                  <ul className="space-y-1.5">
                    {activeScript.key_info_to_share.map((info, i) => (
                      <li key={i} className="text-sm text-[#2D1B0E] flex gap-2">
                        <span className="text-[#af4408] shrink-0">•</span>{info}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {activeScript.closing && (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-[#8B7355] mb-1">Closing Line</h3>
                  <p className="text-sm text-[#2D1B0E] bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg px-3 py-2">
                    &ldquo;{activeScript.closing}&rdquo;
                  </p>
                </div>
              )}
              {!!activeScript.upsell_tips?.length && (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-[#8B7355] mb-1">Upsell Tips</h3>
                  <ul className="space-y-1.5">
                    {activeScript.upsell_tips.map((tip, i) => (
                      <li key={i} className="text-sm text-[#2D1B0E] flex gap-2">
                        <Sparkles size={14} className="text-[#af4408] shrink-0 mt-0.5" />{tip}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <div className="border-t border-[#E8D5C4] p-3">
              <button
                onClick={() => useScriptInChat(activeScript)}
                disabled={sending}
                className="w-full flex items-center justify-center gap-2 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 text-white text-sm font-medium rounded-lg px-3 py-2.5"
              >
                <MessageSquare size={16} /> Use in Chat
              </button>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
