/**
 * CRM Admin — LLM provider settings (ADMIN only).
 *
 * GET  /api/crm/admin/llm
 *   → { provider, gemini_key_count, gemini_keys: [{index,last4}], claude_key_set,
 *       models: { gemini, claude } }
 *   Key VALUES are never returned — only counts + masked last-4 hints.
 *
 * POST /api/crm/admin/llm   (any one action per call)
 *   { test: true }                    → { ok, reply | error }   (live LLM ping)
 *   { provider: 'gemini'|'claude' }   → switch provider (claude blocked w/o key)
 *   { add_gemini_key: 'AIza...' }     → append key (validated prefix, no dupes)
 *   { remove_gemini_key_index: n }    → remove key at index n
 *   { claude_key: 'sk-ant-...' }      → set/replace the Anthropic key
 *   { gemini_model: '...' }           → override Gemini model id
 *   { claude_model: '...' }           → override Claude model id
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { requireRole } from '@/lib/auth';
import {
  callCrmLlm, CrmRateLimitError,
  getProvider, getGeminiKeys, getClaudeKey, getCrmSetting, setCrmSetting,
} from '@/lib/crm-llm';

export const dynamic = 'force-dynamic';

function status() {
  const keys = getGeminiKeys();
  return {
    provider: getProvider(),
    gemini_key_count: keys.length,
    gemini_keys: keys.map((k, index) => ({ index, last4: k.slice(-4) })),
    claude_key_set: !!getClaudeKey(),
    models: {
      gemini: getCrmSetting('crm_gemini_model', 'gemini-2.5-flash'),
      claude: getCrmSetting('crm_claude_model', 'claude-sonnet-5'),
    },
  };
}

export async function GET() {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });
  return Response.json(status());
}

export async function POST(req: Request) {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  let body: any;
  try { body = await req.json(); } catch {
    return Response.json({ error: 'Request body must be JSON' }, { status: 400 });
  }

  // ── live test ping ────────────────────────────────────────────────────
  if (body?.test === true) {
    try {
      const reply = await callCrmLlm({
        messages: [{ role: 'user', content: 'Reply OK' }],
        maxTokens: 512,
      });
      return Response.json({ ok: true, reply: reply.trim() });
    } catch (e: any) {
      if (e instanceof CrmRateLimitError) {
        return Response.json({ ok: false, error: e.message, wait_seconds: e.waitSeconds }, { status: 429 });
      }
      return Response.json({ ok: false, error: e instanceof Error ? e.message : 'Test failed' });
    }
  }

  // ── provider toggle ───────────────────────────────────────────────────
  if (body?.provider !== undefined) {
    const provider = String(body.provider).trim();
    if (provider !== 'gemini' && provider !== 'claude') {
      return Response.json({ error: 'provider must be "gemini" or "claude"' }, { status: 400 });
    }
    if (provider === 'claude' && !getClaudeKey()) {
      return Response.json({ error: 'Add an Anthropic API key before switching to Claude' }, { status: 400 });
    }
    if (provider === 'gemini' && getGeminiKeys().length === 0) {
      return Response.json({ error: 'Add a Gemini API key before switching to Gemini' }, { status: 400 });
    }
    setCrmSetting('crm_llm_provider', provider);
    return Response.json({ message: `Provider set to ${provider}`, ...status() });
  }

  // ── gemini keys ───────────────────────────────────────────────────────
  if (body?.add_gemini_key !== undefined) {
    const key = String(body.add_gemini_key).trim();
    if (!key.startsWith('AIza')) {
      return Response.json({ error: 'Invalid Gemini API key format (should start with AIza...)' }, { status: 400 });
    }
    const keys = getGeminiKeys();
    if (keys.includes(key)) {
      return Response.json({ error: 'Key already exists' }, { status: 409 });
    }
    keys.push(key);
    setCrmSetting('crm_gemini_keys', JSON.stringify(keys));
    return Response.json({ message: 'Gemini API key added', ...status() });
  }

  if (body?.remove_gemini_key_index !== undefined) {
    const idx = Number(body.remove_gemini_key_index);
    const keys = getGeminiKeys();
    if (!Number.isInteger(idx) || idx < 0 || idx >= keys.length) {
      return Response.json({ error: 'Invalid key index' }, { status: 400 });
    }
    if (keys.length === 1 && getProvider() === 'gemini') {
      return Response.json({ error: 'Cannot remove the last Gemini key while Gemini is the active provider' }, { status: 400 });
    }
    keys.splice(idx, 1);
    setCrmSetting('crm_gemini_keys', JSON.stringify(keys));
    return Response.json({ message: 'Gemini API key removed', ...status() });
  }

  // ── claude key ────────────────────────────────────────────────────────
  if (body?.claude_key !== undefined) {
    const key = String(body.claude_key).trim();
    if (!key.startsWith('sk-ant')) {
      return Response.json({ error: 'Invalid Anthropic API key format (should start with sk-ant...)' }, { status: 400 });
    }
    setCrmSetting('crm_claude_key', key);
    return Response.json({ message: 'Anthropic API key saved', ...status() });
  }

  // ── model overrides ───────────────────────────────────────────────────
  if (body?.gemini_model !== undefined) {
    const model = String(body.gemini_model).trim();
    if (!model) return Response.json({ error: 'gemini_model cannot be empty' }, { status: 400 });
    setCrmSetting('crm_gemini_model', model);
    return Response.json({ message: `Gemini model set to ${model}`, ...status() });
  }
  if (body?.claude_model !== undefined) {
    const model = String(body.claude_model).trim();
    if (!model) return Response.json({ error: 'claude_model cannot be empty' }, { status: 400 });
    setCrmSetting('crm_claude_model', model);
    return Response.json({ message: `Claude model set to ${model}`, ...status() });
  }

  return Response.json({ error: 'No recognized action in request body' }, { status: 400 });
}
