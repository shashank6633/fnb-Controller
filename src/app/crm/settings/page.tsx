'use client';

/**
 * CRM Settings (ADMIN only) — four tabs:
 *   1. Knowledge Base — per-section JSON editor + AI Assist (preview → apply)
 *   2. AI Provider    — Gemini/Claude toggle, key management (masked), models, live test
 *   3. Analytics      — totals, staff leaderboard, recent activity
 *   4. Question Bank  — category/difficulty stats + top-up reseed
 *
 * Mobile-first: staff/admins use phones — pills wrap, tables scroll sideways.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, Settings, BookOpen, Bot, BarChart3, Database, Loader2, Save, Sparkles,
  CheckCircle2, AlertCircle, Trash2, Plus, RefreshCw, KeyRound, Zap, Users,
  MessageSquare, ListChecks, GraduationCap, Percent, Target,
} from 'lucide-react';
import { api } from '@/lib/api';
import TabScroller from '@/components/TabScroller';

const KB_SECTIONS: { key: string; label: string }[] = [
  { key: 'venue_info', label: 'Venue' },
  { key: 'policies', label: 'Policies' },
  { key: 'events', label: 'Events' },
  { key: 'menu_info', label: 'Menu' },
  { key: 'call_scripts', label: 'Call Scripts' },
  { key: 'custom_faqs', label: 'FAQs' },
];

type TabKey = 'kb' | 'llm' | 'analytics' | 'qbank';

const TABS: { key: TabKey; label: string; icon: any }[] = [
  { key: 'kb', label: 'Knowledge Base', icon: BookOpen },
  { key: 'llm', label: 'AI Provider', icon: Bot },
  { key: 'analytics', label: 'Analytics', icon: BarChart3 },
  { key: 'qbank', label: 'Question Bank', icon: Database },
];

export default function CrmSettingsPage() {
  const router = useRouter();
  const [me, setMe] = useState<any>(undefined); // undefined = loading, null = signed out
  const [tab, setTab] = useState<TabKey>('kb');

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.json())
      .then(d => setMe(d?.user ?? null))
      .catch(() => setMe(null));
  }, []);

  if (me === undefined) {
    return (
      <div className="p-8 text-center text-sm text-[#8B7355]">
        <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…
      </div>
    );
  }
  if (!me || me.role !== 'admin') {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
          🔒 Admin only. Ask an admin to manage CRM settings.
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-6xl mx-auto">
      <div>
        <button
          onClick={() => router.back()}
          className="inline-flex items-center gap-1 text-sm text-[#6B5744] hover:text-[#2D1B0E] transition-colors mb-2"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
          <Settings className="w-6 h-6 text-[#af4408]" /> CRM Settings
        </h1>
        <p className="text-xs text-[#6B5744] mt-0.5">
          Knowledge base, AI provider, staff analytics and the quiz question bank.
        </p>
      </div>

      {/* Tab pills */}
      <TabScroller className="gap-2">
        {TABS.map(t => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-3 py-1.5 rounded-lg text-sm flex items-center gap-1.5 border transition-colors ${
                active
                  ? 'bg-[#af4408] border-[#af4408] text-white'
                  : 'bg-white border-[#E8D5C4] text-[#6B5744] hover:bg-[#FFF1E3]'
              }`}
            >
              <Icon className="w-4 h-4" /> {t.label}
            </button>
          );
        })}
      </TabScroller>

      {tab === 'kb' && <KnowledgeTab />}
      {tab === 'llm' && <ProviderTab />}
      {tab === 'analytics' && <AnalyticsTab />}
      {tab === 'qbank' && <QuestionBankTab />}
    </div>
  );
}

/* ── shared bits ─────────────────────────────────────────────────────── */

function Flash({ text }: { text: string }) {
  return (
    <div className="bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-lg p-3 text-sm flex items-center gap-2">
      <CheckCircle2 className="w-4 h-4 flex-shrink-0" /> {text}
    </div>
  );
}
function ErrorBox({ text }: { text: string }) {
  return (
    <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm flex items-start gap-2">
      <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" /> <span className="break-words min-w-0">{text}</span>
    </div>
  );
}

/* ── 1. Knowledge Base tab ───────────────────────────────────────────── */

function KnowledgeTab() {
  const [section, setSection] = useState('venue_info');
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  // AI assist
  const [instruction, setInstruction] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [preview, setPreview] = useState<{ updated: any; summary: string } | null>(null);
  const [applying, setApplying] = useState(false);

  const load = useCallback((sec: string) => {
    setLoading(true); setError(null); setFlash(null); setPreview(null);
    fetch(`/api/crm/admin/knowledge/${sec}`)
      .then(r => r.json())
      .then(j => {
        if (j.error) { setError(j.error); return; }
        setText(JSON.stringify(j.content ?? {}, null, 2));
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(section); }, [section, load]);

  const save = async (contentOverride?: any) => {
    setSaving(true); setError(null); setFlash(null);
    try {
      let content: any = contentOverride;
      if (content === undefined) {
        try { content = JSON.parse(text); } catch (e: any) {
          setError(`Invalid JSON — fix before saving: ${e.message}`);
          return false;
        }
      }
      const r = await api(`/api/crm/admin/knowledge/${section}`, { method: 'PUT', body: { content } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return false; }
      setFlash(`Saved "${KB_SECTIONS.find(s => s.key === section)?.label || section}"`);
      return true;
    } finally { setSaving(false); }
  };

  const runAssist = async () => {
    if (!instruction.trim()) return;
    setAiBusy(true); setError(null); setFlash(null); setPreview(null);
    try {
      const r = await api('/api/crm/admin/kb-assist', {
        method: 'POST',
        body: { section, instruction: instruction.trim() },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(r.status === 429 ? `AI is rate-limited — wait ${j.wait_seconds || 30}s and try again` : (j.error || `HTTP ${r.status}`));
        return;
      }
      setPreview({ updated: j.updated, summary: j.summary || 'Changes ready' });
    } catch (e: any) {
      setError(e.message);
    } finally { setAiBusy(false); }
  };

  const applyPreview = async () => {
    if (!preview) return;
    setApplying(true);
    try {
      const ok = await save(preview.updated);
      if (ok) {
        setText(JSON.stringify(preview.updated, null, 2));
        setPreview(null);
        setInstruction('');
      }
    } finally { setApplying(false); }
  };

  return (
    <div className="space-y-3">
      {/* Section pills */}
      <div className="flex flex-wrap gap-2">
        {KB_SECTIONS.map(s => (
          <button
            key={s.key}
            onClick={() => setSection(s.key)}
            className={`px-3 py-1 rounded-full text-xs border ${
              section === s.key
                ? 'bg-[#2D1B0E] border-[#2D1B0E] text-white'
                : 'bg-white border-[#E8D5C4] text-[#6B5744] hover:bg-[#FFF1E3]'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {flash && <Flash text={flash} />}
      {error && <ErrorBox text={error} />}

      {/* JSON editor */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 sm:p-4 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-semibold text-[#2D1B0E]">
            {KB_SECTIONS.find(s => s.key === section)?.label} — raw JSON
          </div>
          <button
            onClick={() => save()}
            disabled={saving || loading}
            className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm flex items-center gap-1.5 disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
          </button>
        </div>
        {loading ? (
          <div className="py-10 text-center text-sm text-[#8B7355]">
            <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading section…
          </div>
        ) : (
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            spellCheck={false}
            rows={18}
            className="w-full font-mono text-xs bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3 text-[#2D1B0E] focus:outline-none focus:ring-1 focus:ring-[#af4408]"
          />
        )}
        <p className="text-[10px] text-[#8B7355]">
          Edits here update what the AI assistant, trainer and quizzes know. Invalid JSON is rejected on save.
        </p>
      </div>

      {/* AI assist */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 sm:p-4 space-y-2">
        <div className="text-sm font-semibold text-[#2D1B0E] flex items-center gap-1.5">
          <Sparkles className="w-4 h-4 text-[#af4408]" /> AI Assist
        </div>
        <p className="text-[10px] text-[#8B7355]">
          Describe the change in plain words (e.g. &quot;change Sunday brunch adult price to ₹1899&quot;) —
          the AI rewrites this section&apos;s JSON and shows a preview before anything is saved.
        </p>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            value={instruction}
            onChange={e => setInstruction(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') runAssist(); }}
            placeholder="What should change in this section?"
            className="flex-1 px-3 py-2 bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg text-sm"
          />
          <button
            onClick={runAssist}
            disabled={aiBusy || !instruction.trim()}
            className="px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm flex items-center justify-center gap-1.5 disabled:opacity-50"
          >
            {aiBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            {aiBusy ? 'Thinking…' : 'Preview with AI'}
          </button>
        </div>

        {preview && (
          <div className="border border-[#D4B896] rounded-lg overflow-hidden">
            <div className="px-3 py-2 bg-[#FFF1E3] text-xs text-[#6B5744] border-b border-[#E8D5C4]">
              <span className="font-semibold text-[#2D1B0E]">AI summary:</span> {preview.summary}
            </div>
            <pre className="max-h-64 overflow-auto text-[10px] font-mono bg-[#FFF8F0] p-3 text-[#2D1B0E]">
              {JSON.stringify(preview.updated, null, 2)}
            </pre>
            <div className="flex flex-wrap gap-2 p-2 bg-white border-t border-[#E8D5C4]">
              <button
                onClick={applyPreview}
                disabled={applying}
                className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm flex items-center gap-1.5 disabled:opacity-50"
              >
                {applying ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                Apply &amp; Save
              </button>
              <button
                onClick={() => setPreview(null)}
                disabled={applying}
                className="px-3 py-1.5 bg-white border border-[#E8D5C4] text-[#6B5744] rounded-lg text-sm disabled:opacity-50"
              >
                Discard
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── 2. AI Provider tab ──────────────────────────────────────────────── */

interface LlmStatus {
  provider: 'gemini' | 'claude';
  gemini_key_count: number;
  gemini_keys: { index: number; last4: string }[];
  claude_key_set: boolean;
  models: { gemini: string; claude: string };
}

function ProviderTab() {
  const [st, setSt] = useState<LlmStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const [newGeminiKey, setNewGeminiKey] = useState('');
  const [newClaudeKey, setNewClaudeKey] = useState('');
  const [geminiModel, setGeminiModel] = useState('');
  const [claudeModel, setClaudeModel] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true); setError(null);
    fetch('/api/crm/admin/llm')
      .then(r => r.json())
      .then(j => {
        if (j.error) { setError(j.error); return; }
        setSt(j);
        setGeminiModel(j.models?.gemini || '');
        setClaudeModel(j.models?.claude || '');
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const post = async (body: any, okMsg?: string) => {
    setBusy(true); setError(null); setFlash(null);
    try {
      const r = await api('/api/crm/admin/llm', { method: 'POST', body });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return null; }
      if (j.provider) {
        setSt(j);
        setGeminiModel(j.models?.gemini || '');
        setClaudeModel(j.models?.claude || '');
      }
      if (okMsg || j.message) setFlash(okMsg || j.message);
      return j;
    } catch (e: any) {
      setError(e.message);
      return null;
    } finally { setBusy(false); }
  };

  const runTest = async () => {
    setTesting(true); setError(null); setTestResult(null);
    try {
      const r = await api('/api/crm/admin/llm', { method: 'POST', body: { test: true } });
      const j = await r.json().catch(() => ({}));
      if (j.ok) setTestResult({ ok: true, text: j.reply || 'OK' });
      else setTestResult({ ok: false, text: j.error || `HTTP ${r.status}` });
    } catch (e: any) {
      setTestResult({ ok: false, text: e.message });
    } finally { setTesting(false); }
  };

  if (loading) {
    return (
      <div className="py-10 text-center text-sm text-[#8B7355]">
        <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading provider settings…
      </div>
    );
  }
  if (!st) return <ErrorBox text={error || 'Could not load provider settings'} />;

  return (
    <div className="space-y-3">
      {flash && <Flash text={flash} />}
      {error && <ErrorBox text={error} />}

      {/* Provider toggle */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 sm:p-4 space-y-3">
        <div className="text-sm font-semibold text-[#2D1B0E] flex items-center gap-1.5">
          <Bot className="w-4 h-4 text-[#af4408]" /> Active provider
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          {(['gemini', 'claude'] as const).map(p => (
            <label
              key={p}
              className={`flex-1 border rounded-lg p-3 cursor-pointer flex items-center gap-2 ${
                st.provider === p ? 'border-[#af4408] bg-[#FFF1E3]' : 'border-[#E8D5C4] bg-[#FFF8F0]'
              }`}
            >
              <input
                type="radio"
                name="provider"
                checked={st.provider === p}
                disabled={busy}
                onChange={() => post({ provider: p })}
                className="accent-[#af4408]"
              />
              <div>
                <div className="text-sm font-medium text-[#2D1B0E] capitalize">{p}</div>
                <div className="text-[10px] text-[#8B7355]">
                  {p === 'gemini'
                    ? `${st.gemini_key_count} key${st.gemini_key_count === 1 ? '' : 's'} · round-robin on rate limits`
                    : st.claude_key_set ? 'Anthropic key configured' : 'Needs an Anthropic key first'}
                </div>
              </div>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={runTest}
            disabled={testing || busy}
            className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm flex items-center gap-1.5 disabled:opacity-50"
          >
            {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          {testResult && (
            <span className={`text-xs px-2 py-1 rounded break-all ${testResult.ok ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
              {testResult.ok ? `Reply: ${testResult.text}` : `Failed: ${testResult.text}`}
            </span>
          )}
        </div>
      </div>

      {/* Gemini keys */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 sm:p-4 space-y-2">
        <div className="text-sm font-semibold text-[#2D1B0E] flex items-center gap-1.5">
          <KeyRound className="w-4 h-4 text-[#af4408]" /> Gemini API keys
        </div>
        {st.gemini_keys.length === 0 ? (
          <p className="text-xs text-[#8B7355]">No Gemini keys yet — add one below (starts with AIza…).</p>
        ) : (
          <ul className="space-y-1">
            {st.gemini_keys.map(k => (
              <li key={k.index} className="flex items-center justify-between gap-2 bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg px-3 py-1.5">
                <span className="font-mono text-xs text-[#2D1B0E]">Key {k.index + 1} · ••••••••{k.last4}</span>
                <button
                  onClick={() => post({ remove_gemini_key_index: k.index }, 'Gemini key removed')}
                  disabled={busy}
                  className="text-red-600 hover:text-red-800 disabled:opacity-50"
                  title="Remove key"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            value={newGeminiKey}
            onChange={e => setNewGeminiKey(e.target.value)}
            placeholder="AIza…"
            type="password"
            autoComplete="off"
            className="flex-1 px-3 py-2 bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg text-sm font-mono"
          />
          <button
            onClick={async () => {
              const j = await post({ add_gemini_key: newGeminiKey.trim() }, 'Gemini key added');
              if (j) setNewGeminiKey('');
            }}
            disabled={busy || !newGeminiKey.trim().startsWith('AIza')}
            className="px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm flex items-center justify-center gap-1.5 disabled:opacity-50"
          >
            <Plus className="w-4 h-4" /> Add key
          </button>
        </div>
      </div>

      {/* Claude key */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 sm:p-4 space-y-2">
        <div className="text-sm font-semibold text-[#2D1B0E] flex items-center gap-1.5">
          <KeyRound className="w-4 h-4 text-[#af4408]" /> Anthropic (Claude) API key
        </div>
        <p className="text-xs text-[#8B7355]">
          {st.claude_key_set ? 'A key is configured — paste a new one to replace it.' : 'No key yet (starts with sk-ant…).'}
        </p>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            value={newClaudeKey}
            onChange={e => setNewClaudeKey(e.target.value)}
            placeholder="sk-ant-…"
            type="password"
            autoComplete="off"
            className="flex-1 px-3 py-2 bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg text-sm font-mono"
          />
          <button
            onClick={async () => {
              const j = await post({ claude_key: newClaudeKey.trim() }, 'Anthropic key saved');
              if (j) setNewClaudeKey('');
            }}
            disabled={busy || !newClaudeKey.trim().startsWith('sk-ant')}
            className="px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm flex items-center justify-center gap-1.5 disabled:opacity-50"
          >
            <Save className="w-4 h-4" /> {st.claude_key_set ? 'Replace key' : 'Set key'}
          </button>
        </div>
      </div>

      {/* Models */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 sm:p-4 space-y-2">
        <div className="text-sm font-semibold text-[#2D1B0E]">Model overrides</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] uppercase tracking-wide text-[#8B7355]">Gemini model</label>
            <div className="flex gap-2 mt-0.5">
              <input
                value={geminiModel}
                onChange={e => setGeminiModel(e.target.value)}
                className="flex-1 min-w-0 px-3 py-2 bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg text-sm font-mono"
              />
              <button
                onClick={() => post({ gemini_model: geminiModel.trim() })}
                disabled={busy || !geminiModel.trim() || geminiModel.trim() === st.models.gemini}
                className="px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wide text-[#8B7355]">Claude model</label>
            <div className="flex gap-2 mt-0.5">
              <input
                value={claudeModel}
                onChange={e => setClaudeModel(e.target.value)}
                className="flex-1 min-w-0 px-3 py-2 bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg text-sm font-mono"
              />
              <button
                onClick={() => post({ claude_model: claudeModel.trim() })}
                disabled={busy || !claudeModel.trim() || claudeModel.trim() === st.models.claude}
                className="px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── 3. Analytics tab ────────────────────────────────────────────────── */

function AnalyticsTab() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/crm/admin/analytics')
      .then(r => r.json())
      .then(j => { if (j.error) setError(j.error); else setData(j); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="py-10 text-center text-sm text-[#8B7355]">
        <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Crunching numbers…
      </div>
    );
  }
  if (error) return <ErrorBox text={error} />;
  if (!data) return <ErrorBox text="No analytics data" />;

  const t = data.totals || {};
  const cards = [
    { label: 'Staff using CRM', value: t.active_users ?? 0, icon: Users },
    { label: 'Chat sessions', value: t.chat_sessions ?? 0, icon: MessageSquare },
    { label: 'Quizzes taken', value: t.quiz_sessions ?? 0, icon: ListChecks },
    { label: 'Training sessions', value: t.training_sessions ?? 0, icon: GraduationCap },
    { label: 'Avg quiz score', value: t.avg_quiz_pct != null ? `${t.avg_quiz_pct}%` : '—', icon: Percent },
    { label: 'Avg training score', value: t.avg_training_score != null ? `${t.avg_training_score}/10` : '—', icon: Target },
  ];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        {cards.map(c => {
          const Icon = c.icon;
          return (
            <div key={c.label} className="bg-white border border-[#E8D5C4] rounded-xl p-3">
              <div className="text-[10px] uppercase tracking-wide text-[#8B7355] flex items-center gap-1">
                <Icon className="w-3 h-3" /> {c.label}
              </div>
              <div className="text-xl font-bold font-mono text-[#2D1B0E] mt-0.5">{c.value}</div>
            </div>
          );
        })}
      </div>

      {/* Leaderboard */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        <div className="px-4 py-2 bg-[#FFF1E3] border-b border-[#E8D5C4] font-semibold text-sm text-[#2D1B0E]">
          Staff leaderboard
        </div>
        {(data.leaderboard || []).length === 0 ? (
          <div className="p-4 text-xs text-[#8B7355] italic">No CRM activity yet — the leaderboard fills up as staff take quizzes and training.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[560px]">
              <thead className="text-[#6B5744]">
                <tr>
                  <th className="text-left py-1.5 px-3 font-medium">#</th>
                  <th className="text-left py-1.5 px-3 font-medium">Staff</th>
                  <th className="text-right py-1.5 px-3 font-medium">Quizzes</th>
                  <th className="text-right py-1.5 px-3 font-medium">Quiz avg</th>
                  <th className="text-right py-1.5 px-3 font-medium">Trainings</th>
                  <th className="text-right py-1.5 px-3 font-medium">Training avg</th>
                </tr>
              </thead>
              <tbody>
                {data.leaderboard.map((u: any, i: number) => (
                  <tr key={u.user_id} className="border-t border-[#E8D5C4]/50">
                    <td className="py-1.5 px-3 font-mono text-[#8B7355]">{i + 1}</td>
                    <td className="py-1.5 px-3">
                      <div className="font-medium text-[#2D1B0E]">{u.name}</div>
                      <div className="text-[10px] text-[#8B7355]">{u.email}</div>
                    </td>
                    <td className="py-1.5 px-3 text-right font-mono">{u.quiz_count}</td>
                    <td className="py-1.5 px-3 text-right font-mono">
                      {u.quiz_avg_pct != null ? (
                        <span className={u.quiz_avg_pct >= 70 ? 'text-emerald-700' : u.quiz_avg_pct >= 50 ? 'text-amber-700' : 'text-red-600'}>
                          {u.quiz_avg_pct}%
                        </span>
                      ) : '—'}
                    </td>
                    <td className="py-1.5 px-3 text-right font-mono">{u.training_count}</td>
                    <td className="py-1.5 px-3 text-right font-mono">{u.training_avg != null ? `${u.training_avg}/10` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Recent activity */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        <div className="px-4 py-2 bg-[#FFF1E3] border-b border-[#E8D5C4] font-semibold text-sm text-[#2D1B0E]">
          Recent activity
        </div>
        {(data.recent || []).length === 0 ? (
          <div className="p-4 text-xs text-[#8B7355] italic">Nothing yet.</div>
        ) : (
          <ul>
            {data.recent.map((r: any, i: number) => (
              <li key={i} className="px-4 py-2 border-t border-[#E8D5C4]/50 first:border-t-0 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                  r.type === 'quiz' ? 'bg-blue-50 text-blue-800 border border-blue-200'
                  : r.type === 'training' ? 'bg-purple-50 text-purple-800 border border-purple-200'
                  : 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                }`}>
                  {r.type}
                </span>
                <span className="font-medium text-[#2D1B0E]">{r.user_name}</span>
                <span className="text-[#6B5744] break-words min-w-0">{r.label}</span>
                <span className="text-[10px] text-[#8B7355] ml-auto">{(r.created_at || '').replace('T', ' ').slice(0, 16)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/* ── 4. Question Bank tab ────────────────────────────────────────────── */

function QuestionBankTab() {
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [reseeding, setReseeding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true); setError(null);
    fetch('/api/crm/admin/question-bank')
      .then(r => r.json())
      .then(j => { if (j.error) setError(j.error); else setStats(j); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const reseed = async () => {
    setReseeding(true); setError(null); setFlash(null);
    try {
      const r = await api('/api/crm/admin/question-bank', { method: 'POST', body: { reseed: true } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setFlash(j.message || `Added ${j.added} questions`);
      refresh();
    } finally { setReseeding(false); }
  };

  if (loading) {
    return (
      <div className="py-10 text-center text-sm text-[#8B7355]">
        <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading question bank…
      </div>
    );
  }
  if (error && !stats) return <ErrorBox text={error} />;

  // Pivot category → difficulty counts
  const pivot: Record<string, { easy: number; medium: number; hard: number; total: number }> = {};
  for (const row of stats?.by_category || []) {
    const cat = row.category || '(uncategorised)';
    if (!pivot[cat]) pivot[cat] = { easy: 0, medium: 0, hard: 0, total: 0 };
    const d = (row.difficulty as 'easy' | 'medium' | 'hard') || 'medium';
    if (d === 'easy' || d === 'medium' || d === 'hard') pivot[cat][d] += row.count;
    pivot[cat].total += row.count;
  }
  const cats = Object.keys(pivot).sort();

  return (
    <div className="space-y-3">
      {flash && <Flash text={flash} />}
      {error && <ErrorBox text={error} />}

      <div className="flex flex-wrap items-center gap-2">
        <div className="bg-white border border-[#E8D5C4] rounded-xl px-4 py-2">
          <span className="text-[10px] uppercase tracking-wide text-[#8B7355]">Total questions</span>
          <span className="ml-2 text-lg font-bold font-mono text-[#2D1B0E]">{stats?.total ?? 0}</span>
          <span className="ml-2 text-[10px] text-[#8B7355]">({stats?.active ?? 0} active)</span>
        </div>
        <button
          onClick={reseed}
          disabled={reseeding}
          className="px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm flex items-center gap-1.5 disabled:opacity-50"
        >
          {reseeding ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          {reseeding ? 'Reseeding…' : 'Reseed from file'}
        </button>
        <p className="w-full sm:w-auto text-[10px] text-[#8B7355]">
          Reseed only ADDS questions missing from the bundled file — it never deletes or overwrites existing ones.
        </p>
      </div>

      <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        <div className="px-4 py-2 bg-[#FFF1E3] border-b border-[#E8D5C4] font-semibold text-sm text-[#2D1B0E]">
          Questions by category &amp; difficulty
        </div>
        {cats.length === 0 ? (
          <div className="p-4 text-xs text-[#8B7355] italic">Bank is empty — hit &quot;Reseed from file&quot; to load the bundled 1000+ questions.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[480px]">
              <thead className="text-[#6B5744]">
                <tr>
                  <th className="text-left py-1.5 px-3 font-medium">Category</th>
                  <th className="text-right py-1.5 px-3 font-medium">Easy</th>
                  <th className="text-right py-1.5 px-3 font-medium">Medium</th>
                  <th className="text-right py-1.5 px-3 font-medium">Hard</th>
                  <th className="text-right py-1.5 px-3 font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {cats.map(c => (
                  <tr key={c} className="border-t border-[#E8D5C4]/50">
                    <td className="py-1.5 px-3 font-medium text-[#2D1B0E]">{c}</td>
                    <td className="py-1.5 px-3 text-right font-mono">{pivot[c].easy || '—'}</td>
                    <td className="py-1.5 px-3 text-right font-mono">{pivot[c].medium || '—'}</td>
                    <td className="py-1.5 px-3 text-right font-mono">{pivot[c].hard || '—'}</td>
                    <td className="py-1.5 px-3 text-right font-mono font-bold">{pivot[c].total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
