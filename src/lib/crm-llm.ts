/**
 * AKAN CRM — LLM provider layer (port of the Flask app's gemini_service /
 * claude_service plumbing).
 *
 * - Provider toggle (gemini | claude) + API keys live in the shared `settings`
 *   table (NOT loose JSON files like the Flask app) so they survive deploys and
 *   are editable from the CRM Settings page.
 * - Gemini: multi-key round-robin with per-key cooldown on 429 (the Flask
 *   KeyRotator), plus model fallbacks. Raw fetch — no SDK dependency.
 * - Claude: Anthropic Messages API via raw fetch. Temperature is deliberately
 *   NOT forwarded (mirrors the Flask port note: newer Claude models reject
 *   non-default sampling combos); thinking disabled for latency.
 * - All feature code calls callCrmLlm() and never cares which provider is live.
 *
 * Rotation/cooldown state is per-process (module scope) — correct for the
 * single-pm2-process prod topology.
 */
import { getDb } from '@/lib/db';

export type CrmMessage = { role: 'user' | 'assistant'; content: string };

export class CrmRateLimitError extends Error {
  waitSeconds: number;
  constructor(message: string, waitSeconds = 30) {
    super(message);
    this.name = 'CrmRateLimitError';
    this.waitSeconds = waitSeconds;
  }
}

/* ── settings helpers ─────────────────────────────────────────────────── */

export function getCrmSetting(key: string, fallback = ''): string {
  try {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as any;
    return row?.value ?? fallback;
  } catch { return fallback; }
}

export function setCrmSetting(key: string, value: string): void {
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

export function getProvider(): 'gemini' | 'claude' {
  const v = getCrmSetting('crm_llm_provider', process.env.CRM_LLM_PROVIDER || 'gemini');
  return v === 'claude' ? 'claude' : 'gemini';
}

export function getGeminiKeys(): string[] {
  // settings value is a JSON array; env fallback is comma-separated.
  try {
    const raw = getCrmSetting('crm_gemini_keys', '');
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) return arr.filter(Boolean);
    }
  } catch { /* fall through to env */ }
  const env = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
  return env.split(',').map(s => s.trim()).filter(Boolean);
}

export function getClaudeKey(): string {
  return getCrmSetting('crm_claude_key', process.env.ANTHROPIC_API_KEY || '');
}

const GEMINI_MODELS = () => [
  getCrmSetting('crm_gemini_model', 'gemini-2.5-flash'),
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
];
const CLAUDE_MODEL = () => getCrmSetting('crm_claude_model', 'claude-sonnet-5');

/* ── Gemini key rotation (per-process) ────────────────────────────────── */

const keyCooldownUntil = new Map<string, number>(); // key → epoch-ms until usable
let rrIndex = 0;

function nextUsableKey(keys: string[]): string | null {
  const now = Date.now();
  for (let i = 0; i < keys.length; i++) {
    const k = keys[(rrIndex + i) % keys.length];
    if ((keyCooldownUntil.get(k) || 0) <= now) {
      rrIndex = (rrIndex + i + 1) % keys.length;
      return k;
    }
  }
  return null;
}

/* ── provider calls ───────────────────────────────────────────────────── */

async function callGemini(messages: CrmMessage[], system: string, maxTokens: number, temperature: number): Promise<string> {
  const keys = getGeminiKeys();
  if (!keys.length) throw new Error('No Gemini API key configured. Add one in CRM Settings.');
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  let lastErr: any = null;
  for (const model of GEMINI_MODELS()) {
    // Try every usable key for this model before falling back to the next model.
    for (let attempt = 0; attempt < keys.length; attempt++) {
      const key = nextUsableKey(keys);
      if (!key) break; // all keys cooling — try next model won't help; bail below
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents,
              ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
              generationConfig: { maxOutputTokens: maxTokens, temperature },
            }),
          },
        );
        if (res.status === 429) {
          keyCooldownUntil.set(key, Date.now() + 30_000); // mirror Flask 30s cooldown
          lastErr = new CrmRateLimitError('Gemini rate limit', 30);
          continue;
        }
        const j = await res.json();
        if (!res.ok) {
          const msg = j?.error?.message || `Gemini HTTP ${res.status}`;
          // RESOURCE_EXHAUSTED sometimes arrives as 400/403 text — treat like 429.
          if (/RESOURCE_EXHAUSTED|quota/i.test(msg)) {
            keyCooldownUntil.set(key, Date.now() + 30_000);
            lastErr = new CrmRateLimitError(msg, 30);
            continue;
          }
          lastErr = new Error(msg);
          break; // model-level problem (bad model id etc.) → try next model
        }
        const cand = j?.candidates?.[0];
        const text = cand?.content?.parts?.map((p: any) => p.text || '').join('') || '';
        if (text) return text;
        // 2.5-flash spends output tokens on internal thinking; a too-small
        // maxTokens yields finishReason=MAX_TOKENS with NO text parts. That is
        // a CALLER problem, not a key problem — do NOT rotate keys/models on it
        // (retrying burns quota and turns into misleading 429s).
        if (cand?.finishReason === 'MAX_TOKENS') {
          throw new Error('Gemini hit maxTokens before emitting text — increase maxTokens for this call');
        }
        lastErr = new Error(`Gemini returned an empty response (finishReason: ${cand?.finishReason || 'none'})`);
      } catch (e: any) {
        lastErr = e;
      }
    }
  }
  if (lastErr instanceof CrmRateLimitError) throw lastErr;
  throw lastErr || new Error('Gemini call failed');
}

async function callClaude(messages: CrmMessage[], system: string, maxTokens: number): Promise<string> {
  const key = getClaudeKey();
  if (!key) throw new Error('No Claude API key configured. Add one in CRM Settings.');
  // Anthropic requires the first message to be from the user.
  const msgs = messages.length && messages[0].role !== 'user'
    ? [{ role: 'user' as const, content: '(conversation continues)' }, ...messages]
    : messages;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL(),
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: msgs.map(m => ({ role: m.role, content: m.content })),
    }),
  });
  if (res.status === 429) {
    const j = await res.json().catch(() => ({}));
    throw new CrmRateLimitError(j?.error?.message || 'Claude rate limit', 30);
  }
  const j = await res.json();
  if (!res.ok) throw new Error(j?.error?.message || `Claude HTTP ${res.status}`);
  return (j?.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('') || '';
}

/** Provider-agnostic dispatch — every CRM feature goes through this. */
export async function callCrmLlm(opts: {
  messages: CrmMessage[];
  system?: string;
  maxTokens?: number;
  temperature?: number;
}): Promise<string> {
  const { messages, system = '', maxTokens = 8192, temperature = 0.7 } = opts;
  if (getProvider() === 'claude') return callClaude(messages, system, maxTokens);
  return callGemini(messages, system, maxTokens, temperature);
}

/* ── knowledge base (DB-backed; seeded from the Flask app's JSON files) ── */

export const KB_SECTIONS = ['venue_info', 'policies', 'events', 'menu_info', 'call_scripts', 'custom_faqs'] as const;
export type KbSection = typeof KB_SECTIONS[number];

export function getKnowledgeSection(section: string): any {
  const row = getDb().prepare('SELECT content FROM crm_knowledge WHERE section = ?').get(section) as any;
  if (!row) return null;
  try { return JSON.parse(row.content); } catch { return null; }
}

export function getKnowledge(): Record<string, any> {
  const out: Record<string, any> = {};
  for (const s of KB_SECTIONS) {
    const v = getKnowledgeSection(s);
    if (v != null) out[s] = v;
  }
  return out;
}

export function saveKnowledgeSection(section: string, content: any, updatedBy = ''): void {
  const body = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  JSON.parse(body); // validate — throws on bad JSON
  getDb().prepare(`
    INSERT INTO crm_knowledge (section, content, updated_at, updated_by)
    VALUES (?, ?, datetime('now'), ?)
    ON CONFLICT(section) DO UPDATE SET content = excluded.content,
      updated_at = excluded.updated_at, updated_by = excluded.updated_by
  `).run(section, body, updatedBy);
}
