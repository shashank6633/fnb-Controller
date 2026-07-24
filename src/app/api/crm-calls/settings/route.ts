/* eslint-disable @typescript-eslint/no-explicit-any */
import type Database from 'better-sqlite3';
import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import {
  ctSettings,
  setCtSetting,
  webhookToken,
  isTelecmiConfigured,
  CT_SETTING_DEFAULTS,
} from '@/lib/ct/settings';
import { distinctCallAgents } from '@/lib/ct/agents';

/**
 * CRM Call-to-Table — Settings (/api/crm-calls/settings). Admin-only.
 *
 * GET → all ct_settings (defaults merged) EXCEPT the raw webhook token, plus
 *       computed webhook URLs (RELATIVE paths — the client prepends
 *       window.location.origin for the copy button) and
 *       telecmi_configured (env creds present, never the creds themselves).
 * PUT → { key: value, ... } partial update. Allowlist = CT_SETTING_DEFAULTS
 *       keys + 'telecmi_base_url'. TeleCMI appid/secret live in env ONLY and
 *       are NEVER accepted here nor returned anywhere.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

// 'auto_analyze' is not part of CT_SETTING_DEFAULTS (that lib is shared/owned
// elsewhere) — it is an AI-call-scoring toggle ('0'|'1', default '0') surfaced
// only here.
const ALLOWED_KEYS: readonly string[] = [...Object.keys(CT_SETTING_DEFAULTS), 'telecmi_base_url', 'auto_analyze', 'analysis_retention'];

/** Keys that must never transit this route in either direction. */
const SECRET_KEYS: readonly string[] = [
  'telecmi_appid', 'telecmi_secret', 'appid', 'secret',
  'webhook_token', 'telecmi_webhook_secret',
];

const HM_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

function publicSettings(db: Database.Database): Record<string, string> {
  const s = ctSettings(db);
  for (const k of SECRET_KEYS) delete s[k];
  // auto_analyze lives outside CT_SETTING_DEFAULTS — always surface it in the
  // GET, normalized to '0'|'1' (default off).
  s.auto_analyze = s.auto_analyze === '1' ? '1' : '0';
  // analysis_retention: default 'permanent' (keep scorecards) unless explicitly
  // set to 'ephemeral' (view-on-click, nothing stored).
  s.analysis_retention = s.analysis_retention === 'ephemeral' ? 'ephemeral' : 'permanent';
  return s;
}

export async function GET() {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  const db = getDb();
  const token = webhookToken(db);
  // For the Agent Mapping editor: every raw agent id seen on a call (so the
  // admin can map the ones that actually appear) + the staff list to map them to.
  let staff: Array<{ email: string; name: string }> = [];
  try {
    staff = (db.prepare(
      `SELECT email, name FROM users WHERE is_active = 1 AND email IS NOT NULL ORDER BY name`,
    ).all() as Array<{ email: string; name: string }>).map(u => ({ email: u.email, name: u.name || u.email }));
  } catch { /* users table issue → empty picker, editor still usable via free text */ }
  return Response.json({
    settings: publicSettings(db),
    // Relative on purpose — client prepends its own origin (works across
    // localhost / testing / production without storing a hostname).
    webhook_live_url: `/api/telecmi/webhook/live/${token}`,
    webhook_cdr_url: `/api/telecmi/webhook/cdr/${token}`,
    telecmi_configured: isTelecmiConfigured(),
    agents_seen: distinctCallAgents(db),
    staff,
  });
}

/** Validate + normalize one settings value. Returns the string to store, or
 *  an error message. */
function validate(key: string, value: any): { ok: true; value: string } | { ok: false; error: string } {
  switch (key) {
    case 'sla_minutes': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 1440) {
        return { ok: false, error: 'sla_minutes must be a whole number of minutes between 1 and 1440' };
      }
      return { ok: true, value: String(n) };
    }
    case 'attribution_hours': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 720) {
        return { ok: false, error: 'attribution_hours must be a whole number between 1 and 720' };
      }
      return { ok: true, value: String(n) };
    }
    case 'business_open':
    case 'business_close': {
      const v = String(value ?? '').trim();
      if (!HM_RE.test(v)) return { ok: false, error: `${key} must be HH:mm (IST 24h), e.g. 12:00` };
      return { ok: true, value: v };
    }
    case 'auto_assign': {
      const v = String(value ?? '').trim();
      if (v !== 'off' && v !== 'round_robin') {
        return { ok: false, error: "auto_assign must be 'off' or 'round_robin'" };
      }
      return { ok: true, value: v };
    }
    case 'after_hours_whatsapp': {
      const v = value === true || value === 1 || value === '1' ? '1'
        : value === false || value === 0 || value === '0' ? '0' : null;
      if (v === null) return { ok: false, error: "after_hours_whatsapp must be '0' or '1'" };
      return { ok: true, value: v };
    }
    case 'auto_analyze': {
      const v = value === true || value === 1 || value === '1' ? '1'
        : value === false || value === 0 || value === '0' ? '0' : null;
      if (v === null) return { ok: false, error: "auto_analyze must be '0' or '1'" };
      return { ok: true, value: v };
    }
    case 'analysis_retention': {
      const v = String(value ?? '').trim();
      if (v !== 'permanent' && v !== 'ephemeral') {
        return { ok: false, error: "analysis_retention must be 'permanent' or 'ephemeral'" };
      }
      return { ok: true, value: v };
    }
    case 'after_hours_template': {
      const v = String(value ?? '');
      if (v.length > 1000) return { ok: false, error: 'after_hours_template must be 1000 characters or fewer' };
      return { ok: true, value: v };
    }
    case 'agent_map': {
      // Accept an object or a JSON string; store canonical JSON text.
      let obj: any = value;
      if (typeof value === 'string') {
        try { obj = JSON.parse(value || '{}'); } catch { return { ok: false, error: 'agent_map must be valid JSON' }; }
      }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        return { ok: false, error: 'agent_map must be a JSON object { telecmiAgentId: userEmail }' };
      }
      // Canonical storage: keys lowercased + trimmed so a mixed-case TeleCMI
      // agent id ("Gre.Ravi" vs "gre.ravi") can never split into two rows or
      // fail to resolve. Last non-empty value wins on a case-collision.
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj)) {
        const key = String(k).trim().toLowerCase().slice(0, 100);
        const val = String(v ?? '').trim().slice(0, 200);
        if (key && val) clean[key] = val;
      }
      return { ok: true, value: JSON.stringify(clean) };
    }
    case 'telecmi_base_url': {
      const v = String(value ?? '').trim();
      if (v && !/^https?:\/\/\S+$/.test(v)) {
        return { ok: false, error: 'telecmi_base_url must be an http(s) URL (or empty to reset)' };
      }
      if (v.length > 300) return { ok: false, error: 'telecmi_base_url too long' };
      return { ok: true, value: v };
    }
    case 'quick_send_links': {
      // JSON array of { label, url?, message? }. Keep rows with a label; a URL,
      // if present, must be http(s). A row is "sendable" in the Live feed when it
      // has a URL OR a message (so a band list can go out as plain text, and a
      // corporate menu as a PDF link). Blank rows (label only) are kept as a
      // "fill me in" placeholder but won't appear in the Send menu. Cap at 20.
      let arr: any = value;
      if (typeof value === 'string') { try { arr = JSON.parse(value); } catch { return { ok: false, error: 'quick_send_links must be a JSON array' }; } }
      if (!Array.isArray(arr)) return { ok: false, error: 'quick_send_links must be a JSON array of { label, url, message }' };
      const clean: { label: string; url: string; message: string }[] = [];
      for (const it of arr.slice(0, 20)) {
        const label = String(it?.label ?? '').trim().slice(0, 80);
        const url = String(it?.url ?? '').trim().slice(0, 500);
        const message = String(it?.message ?? '').trim().slice(0, 1000);
        if (!label) continue;
        if (url && !/^https?:\/\/\S+$/.test(url)) return { ok: false, error: `"${label}" link must start with http:// or https://` };
        clean.push({ label, url, message });
      }
      return { ok: true, value: JSON.stringify(clean) };
    }
    case 'whatson_panels': {
      // Which panels show on the GRE "What's On" board. Accept an object or a
      // JSON string; keep ONLY the 6 known boolean keys, coerce each to a real
      // bool, and store canonical JSON so the board can parse it deterministically.
      let obj: any = value;
      if (typeof value === 'string') {
        try { obj = JSON.parse(value || '{}'); } catch { return { ok: false, error: 'whatson_panels must be valid JSON' }; }
      }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        return { ok: false, error: 'whatson_panels must be a JSON object of { panel: boolean }' };
      }
      const PANEL_KEYS = ['entertainment', 'parties', 'reservations', 'specials', 'capacity', 'call_context'] as const;
      const clean: Record<string, boolean> = {};
      for (const k of PANEL_KEYS) {
        const v = obj[k];
        // Default a missing panel to ON; only an explicit falsey value hides it.
        clean[k] = v === undefined ? true : !(v === false || v === 0 || v === '0' || v === 'false');
      }
      return { ok: true, value: JSON.stringify(clean) };
    }
    case 'whatson_specials': {
      const v = String(value ?? '');
      if (v.length > 4000) return { ok: false, error: 'whatson_specials must be 4000 characters or fewer' };
      return { ok: true, value: v };
    }
    case 'whatson_capacity': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 100000) {
        return { ok: false, error: 'whatson_capacity must be a whole number between 0 and 100000 (0 = gauge hidden)' };
      }
      return { ok: true, value: String(n) };
    }
    case 'whatson_entertainment_mode': {
      const v = String(value ?? '').trim();
      if (v !== 'manual_only' && v !== 'dj_only' && v !== 'all_notes') {
        return { ok: false, error: 'whatson_entertainment_mode must be manual_only, dj_only, or all_notes' };
      }
      return { ok: true, value: v };
    }
    default:
      return { ok: false, error: `Unknown setting '${key}'` };
  }
}

const parseHmMin = (hm: string): number => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
};

export async function PUT(req: Request) {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return Response.json({ error: 'Body must be an object of { key: value } settings' }, { status: 400 });
  }

  // Hard-refuse secrets — they live in env only, never in ct_settings.
  for (const k of Object.keys(body)) {
    if (SECRET_KEYS.includes(k)) {
      return Response.json({
        error: `'${k}' cannot be set via this API. TeleCMI credentials are configured server-side via environment variables only.`,
      }, { status: 400 });
    }
  }

  const updates: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!ALLOWED_KEYS.includes(key)) continue; // ignore unknown, non-secret keys
    const res = validate(key, value);
    if (!res.ok) return Response.json({ error: res.error }, { status: 400 });
    updates[key] = res.value;
  }

  if (Object.keys(updates).length === 0) {
    return Response.json({
      error: `No valid settings provided. Editable keys: ${ALLOWED_KEYS.join(', ')}`,
    }, { status: 400 });
  }

  const db = getDb();

  // Cross-field check: business hours must not invert (SLA clock assumes
  // open < close within one IST day).
  const current = ctSettings(db);
  const effOpen = updates.business_open ?? current.business_open ?? CT_SETTING_DEFAULTS.business_open;
  const effClose = updates.business_close ?? current.business_close ?? CT_SETTING_DEFAULTS.business_close;
  if (parseHmMin(effOpen) >= parseHmMin(effClose)) {
    return Response.json({ error: 'business_open must be earlier than business_close (same IST day)' }, { status: 400 });
  }

  for (const [key, value] of Object.entries(updates)) setCtSetting(db, key, value);

  // Switching to 'ephemeral' means "keep nothing" — so PURGE any scorecards
  // stored while in 'permanent' mode. Otherwise old transcripts/scores would
  // linger in the DB and still render (chips + GET), breaking the contract.
  // No-op if already ephemeral (nothing is stored).
  let purged = 0;
  if (updates.analysis_retention === 'ephemeral') {
    try {
      purged = db.prepare(`
        UPDATE ct_calls SET
          analysis_json = '', analysis_score = NULL, analysis_outcome = '',
          analysis_summary = '', analysis_status = '', analysis_error = '',
          analyzed_at = NULL, analyzed_by = ''
        WHERE COALESCE(analysis_status, '') <> '' OR COALESCE(analysis_json, '') <> ''
      `).run().changes;
    } catch (e) { console.error('[ct settings] scorecard purge failed', e); }
  }

  return Response.json({
    success: true,
    updated: Object.keys(updates),
    ...(updates.analysis_retention === 'ephemeral' ? { scorecards_purged: purged } : {}),
    settings: publicSettings(db),
  });
}
