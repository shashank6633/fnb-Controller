/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser, isManagement, requireRole } from '@/lib/auth';
import {
  broadcastSettings, setBroadcastSetting, BROADCAST_SETTING_KEYS, BROADCAST_FLAG,
} from '@/lib/wa-broadcast';
import { stopKeywords, setStopKeywords, DEFAULT_STOP_KEYWORDS } from '@/lib/wa-consent';

/**
 * /api/crm-calls/broadcasts/settings — the engine's knobs.
 *
 * FEATURE-OWNED (win-back's winback_enabled pattern), deliberately NOT added
 * to CT_SETTING_DEFAULTS: that map feeds ALLOWED_KEYS + validate() in
 * /api/crm-calls/settings, and a key there without a validate() case breaks
 * every CRM-settings save (see the trap notes in ct/settings.ts). This route
 * validates and writes its own keys.
 *
 * GET  → management (the campaign screen shows effective values).
 * PUT  → ADMIN ONLY (these knobs decide who gets messaged and how fast).
 *        Body: any subset of
 *          enabled            '1' | '0'   master send flag (absent → OFF)
 *          msgs_per_min       1–240
 *          cooldown_days      0–365       0 disables the cross-campaign cooldown
 *          daily_cap          -1–100000   <= 0 disables the daily cap
 *          cost_per_msg       0–100       ₹/message for estimates (Meta
 *                                         marketing conversation rate)
 *          confirm_threshold  0–100000    starting a campaign with MORE than
 *                                         this many eligible recipients makes
 *                                         the UI demand a TYPED confirmation
 *                                         (0 → always typed)
 *          stop_keywords      string[]    STOP-class keywords (whole-message
 *                                         match; empty array restores defaults)
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  if (!isManagement(me)) return Response.json({ error: 'Management access required' }, { status: 403 });

  const db = getDb();
  return Response.json({
    settings: broadcastSettings(db),
    stop_keywords: stopKeywords(db),
    stop_keywords_default: DEFAULT_STOP_KEYWORDS,
    flag_key: BROADCAST_FLAG,
  });
}

export async function PUT(req: Request) {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  if (!body || typeof body !== 'object') return Response.json({ error: 'Body must be an object' }, { status: 400 });

  const db = getDb();
  const applied: Record<string, unknown> = {};

  if (body.enabled !== undefined) {
    const v = body.enabled === true || body.enabled === '1' || body.enabled === 1 ? '1' : '0';
    setBroadcastSetting(db, BROADCAST_SETTING_KEYS.enabled, v);
    applied.enabled = v === '1';
  }
  const numeric: Array<[key: keyof typeof BROADCAST_SETTING_KEYS, min: number, max: number, integer: boolean]> = [
    ['msgs_per_min', 1, 240, true],
    ['cooldown_days', 0, 365, true],
    ['daily_cap', -1, 100000, true],
    ['cost_per_msg', 0, 100, false],
    ['confirm_threshold', 0, 100000, true],
  ];
  for (const [key, min, max, integer] of numeric) {
    if (body[key] === undefined) continue;
    const n = Number(body[key]);
    if (!Number.isFinite(n) || n < min || n > max) {
      return Response.json({ error: `${key} must be a number between ${min} and ${max}` }, { status: 400 });
    }
    const v = integer ? String(Math.round(n)) : String(n);
    setBroadcastSetting(db, BROADCAST_SETTING_KEYS[key], v);
    applied[key] = integer ? Math.round(n) : n;
  }

  if (body.stop_keywords !== undefined) {
    if (!Array.isArray(body.stop_keywords)) {
      return Response.json({ error: 'stop_keywords must be an array of strings' }, { status: 400 });
    }
    const list = body.stop_keywords.map((k: unknown) => String(k).trim()).filter(Boolean).slice(0, 100);
    // Empty list = restore defaults (an empty keyword list would silently
    // disable the STOP seam, which is not a state an admin should reach by
    // clearing a textbox).
    setStopKeywords(db, list.length ? list : DEFAULT_STOP_KEYWORDS);
    applied.stop_keywords = list.length ? list : DEFAULT_STOP_KEYWORDS;
  }

  if (!Object.keys(applied).length) {
    return Response.json({ error: 'Nothing to update' }, { status: 400 });
  }

  return Response.json({
    success: true,
    applied,
    settings: broadcastSettings(db),
    stop_keywords: stopKeywords(db),
  });
}
