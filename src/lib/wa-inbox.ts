/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * WhatsApp Inbox — ingest + window logic (pure DB/logic, no HTTP handlers).
 *
 * Turns raw whatsapp_events_log rows (kind='webhook', Meta Cloud entry[].
 * changes[].value shape) into wa_conversations / wa_messages / wa_media.
 *
 * CONTRACTS
 * ─────────
 * • whatsapp_events_log stays the untouched raw archive. The webhook POST's
 *   raw INSERT is the first, never-fail step; ingest wraps in its OWN try so
 *   a parse bug can never lose the payload. This module never mutates or
 *   deletes a log row.
 * • IDEMPOTENT: replaying any event twice changes nothing. Inbound messages
 *   and outbound stubs dedupe on the UNIQUE wamid; conversation bumps are
 *   MAX-updates; the outbound status ladder is MONOTONE (sent → delivered →
 *   read, failed terminal from sent/delivered) so a late 'delivered' can
 *   never overwrite 'read'.
 * • Media is fetched from the Graph media endpoint AT INGEST (Meta media URLs
 *   expire within minutes — fetching later fails), size-capped, and failures
 *   are recorded on the message (media_status='failed' + media_error), never
 *   thrown. A backlog replay retries failed media (converges, still
 *   idempotent once stored).
 * • The 24h customer-service window is COMPUTED from last_inbound_at at read
 *   time (windowState) — never stored, so it can never go stale. Server-side
 *   reply gating lives in assessReply() so the API route and the test
 *   harness exercise the SAME decision.
 * • Phone identity: phone_key = norm10(msisdn) — the exact guest-unify join
 *   key (≡ SQL KEY10) — falling back to the full digit string for numbers
 *   that don't yield a 10-digit key. That collapses +91/0/bare forms onto the
 *   same conversation AND onto the same guest-360 handle ('phone:<key>').
 * • Only the Meta Cloud provider delivers inbound webhooks. Interakt has no
 *   inbound capture and no free-form send — the APIs surface that as a
 *   provider notice instead of an inexplicably empty inbox.
 */
import { norm10 } from '@/lib/ct/guest-unify';
import { getWaConfigRaw, META_GRAPH_VERSION } from '@/lib/whatsapp';
// Broadcast-campaign side-effects (STOP-keyword consent, recipient status
// ladder). One-way import — wa-broadcast imports THIS module, never the
// reverse; the hooks module only touches wa-consent + campaign tables.
import { broadcastOnInbound, broadcastOnStatus } from '@/lib/wa-campaign-hooks';

export const WA_MEDIA_MAX_BYTES = 5 * 1024 * 1024; // 5 MB cap on stored inbound media
export const WA_WINDOW_MS = 24 * 60 * 60 * 1000;   // Meta 24h customer-service window
export const WA_TS_MAX_SKEW_MS = 5 * 60 * 1000;    // provider-timestamp plausibility clamp (future skew)

/* ═══════════════ time helpers (UTC, matches datetime('now')) ═══════════════ */

/** ms epoch → 'YYYY-MM-DD HH:MM:SS' UTC (the app-wide SQLite datetime format). */
export function utcString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Meta payload epoch-seconds (string|number) → UTC string; '' when unusable.
 * CLAMPED to now + WA_TS_MAX_SKEW_MS: the webhook is a public endpoint, and a
 * forged far-future timestamp would otherwise poison last_inbound_at forever
 * (bumpConversation is a MAX-update, so a poisoned value could never be
 * lowered) — holding the 24h reply window permanently open and pinning the
 * conversation to the top of the inbox. The clamp also neutralises
 * ms-epoch-instead-of-seconds payloads (they land ~50,000 years out). Past
 * timestamps pass through untouched (webhook retries/backlog replays keep
 * their true times).
 */
export function epochToUtc(ts: unknown, nowMs?: number): string {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  const now = nowMs ?? Date.now();
  return utcString(Math.min(n * 1000, now + WA_TS_MAX_SKEW_MS));
}

/** Parse an app-format UTC string back to ms; NaN when unusable. */
export function parseUtc(s: string | null | undefined): number {
  if (!s) return NaN;
  return Date.parse(String(s).replace(' ', 'T') + 'Z');
}

/* ═══════════════ 24h window ═══════════════ */

export interface WindowState {
  open: boolean;
  /** UTC 'YYYY-MM-DD HH:MM:SS' when the window closes/closed; null when the guest never messaged in. */
  expires_at: string | null;
  remaining_ms: number;
}

/** Computed (never stored) from the last INBOUND message timestamp. */
export function windowState(lastInboundAt: string | null | undefined, nowMs?: number): WindowState {
  const t = parseUtc(lastInboundAt);
  if (!Number.isFinite(t)) return { open: false, expires_at: null, remaining_ms: 0 };
  const now = nowMs ?? Date.now();
  const exp = t + WA_WINDOW_MS;
  return { open: now < exp, expires_at: utcString(exp), remaining_ms: Math.max(0, exp - now) };
}

export type ReplyGate =
  | { allowed: true }
  | { allowed: false; status: number; error: string; detail: string };

/**
 * SERVER-SIDE reply gate — the reply API's single source of truth (and the
 * test harness calls the same function with a fake clock).
 *   free-form text : Meta only, and ONLY while the 24h window is open.
 *   template       : any time, both providers (approved templates).
 */
export function assessReply(
  kind: 'text' | 'template',
  provider: string,
  lastInboundAt: string | null | undefined,
  nowMs?: number,
): ReplyGate {
  if (kind === 'template') return { allowed: true };
  if (provider === 'interakt') {
    return {
      allowed: false, status: 400, error: 'interakt_no_freeform',
      detail: 'Interakt sends approved templates only — free-form text is not supported by the provider API. Send an approved template instead.',
    };
  }
  const w = windowState(lastInboundAt, nowMs);
  if (!w.open) {
    return {
      allowed: false, status: 409, error: 'window_closed',
      detail: w.expires_at
        ? `The 24-hour customer service window closed at ${w.expires_at} UTC (last guest message ${lastInboundAt} UTC). Free-form text can no longer be delivered — send an approved template instead.`
        : 'This guest has never messaged in, so there is no open 24-hour customer service window. Send an approved template instead.',
    };
  }
  return { allowed: true };
}

/* ═══════════════ conversations ═══════════════ */

/** norm10 when derivable (the guest-unify join key), else the full digit string. */
export function phoneKeyFor(msisdn: string): string {
  const digits = String(msisdn || '').replace(/\D/g, '');
  return norm10(digits) || digits;
}

/** Find-or-create the one conversation for a msisdn. Latest push name / raw wa_id win. */
export function upsertConversation(db: any, msisdn: string, profileName?: string): { id: number; phone_key: string } | null {
  const digits = String(msisdn || '').replace(/\D/g, '');
  const key = phoneKeyFor(digits);
  if (!key) return null;
  const existing = db.prepare('SELECT id, phone_key, wa_id, profile_name FROM wa_conversations WHERE phone_key = ?').get(key) as any;
  if (existing) {
    const name = String(profileName || '').trim();
    if ((name && name !== existing.profile_name) || (digits && digits !== existing.wa_id)) {
      db.prepare('UPDATE wa_conversations SET profile_name = CASE WHEN @name <> \'\' THEN @name ELSE profile_name END, wa_id = CASE WHEN @waid <> \'\' THEN @waid ELSE wa_id END WHERE id = @id')
        .run({ name, waid: digits, id: existing.id });
    }
    return { id: Number(existing.id), phone_key: key };
  }
  const info = db.prepare('INSERT INTO wa_conversations (phone_key, wa_id, profile_name) VALUES (?, ?, ?)')
    .run(key, digits, String(profileName || '').trim());
  return { id: Number(info.lastInsertRowid), phone_key: key };
}

/** MAX-update bumps (idempotent on replay). SET expressions see OLD row values. */
function bumpConversation(db: any, convId: number, opts: {
  inboundAt?: string; outboundAt?: string; messageAt?: string; preview?: string; incrementUnread?: boolean;
}) {
  db.prepare(`
    UPDATE wa_conversations SET
      last_inbound_at  = CASE WHEN @inb <> '' AND (last_inbound_at  IS NULL OR last_inbound_at  < @inb) THEN @inb ELSE last_inbound_at  END,
      last_outbound_at = CASE WHEN @out <> '' AND (last_outbound_at IS NULL OR last_outbound_at < @out) THEN @out ELSE last_outbound_at END,
      last_message_preview = CASE WHEN @msg <> '' AND (last_message_at IS NULL OR last_message_at <= @msg) THEN @preview ELSE last_message_preview END,
      last_message_at  = CASE WHEN @msg <> '' AND (last_message_at  IS NULL OR last_message_at  < @msg) THEN @msg ELSE last_message_at  END,
      unread_count     = unread_count + @unread
    WHERE id = @id
  `).run({
    inb: opts.inboundAt || '', out: opts.outboundAt || '', msg: opts.messageAt || '',
    preview: opts.preview ?? '', unread: opts.incrementUnread ? 1 : 0, id: convId,
  });
}

/* ═══════════════ message content extraction (Meta value.messages[]) ═══════════════ */

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker', 'voice']);

function extractContent(m: any): { msgType: string; body: string; providerMediaId: string; replyTo: string } {
  const t = String(m?.type || '');
  const ctx = String(m?.context?.id || '');
  if (t === 'text') return { msgType: 'text', body: String(m?.text?.body ?? ''), providerMediaId: '', replyTo: ctx };
  if (MEDIA_TYPES.has(t)) {
    const part = m?.[t] || {};
    return { msgType: t, body: String(part.caption ?? part.filename ?? ''), providerMediaId: String(part.id || ''), replyTo: ctx };
  }
  if (t === 'reaction') return { msgType: 'reaction', body: String(m?.reaction?.emoji ?? ''), providerMediaId: '', replyTo: String(m?.reaction?.message_id || '') };
  if (t === 'location') {
    const l = m?.location || {};
    const bits = [l.name, l.address, (l.latitude != null && l.longitude != null) ? `${l.latitude},${l.longitude}` : ''].filter(Boolean);
    return { msgType: 'location', body: bits.join(' — '), providerMediaId: '', replyTo: ctx };
  }
  if (t === 'button') return { msgType: 'button', body: String(m?.button?.text ?? ''), providerMediaId: '', replyTo: ctx };
  if (t === 'interactive') {
    const r = m?.interactive?.button_reply || m?.interactive?.list_reply || {};
    return { msgType: 'interactive', body: String(r.title ?? ''), providerMediaId: '', replyTo: ctx };
  }
  if (t === 'contacts') {
    const names = (Array.isArray(m?.contacts) ? m.contacts : []).map((c: any) => c?.name?.formatted_name).filter(Boolean);
    return { msgType: 'contacts', body: names.join(', '), providerMediaId: '', replyTo: ctx };
  }
  return { msgType: t || 'unknown', body: '', providerMediaId: '', replyTo: ctx };
}

export function previewOf(msgType: string, body: string): string {
  const b = String(body || '').replace(/\s+/g, ' ').trim();
  if (b) return b.slice(0, 140);
  return msgType && msgType !== 'text' ? `[${msgType}]` : '';
}

/* ═══════════════ media (Graph fetch AT INGEST) ═══════════════ */

type FetchImpl = typeof fetch;

async function fetchAndStoreMedia(
  db: any, providerMediaId: string, fetchImpl?: FetchImpl,
): Promise<{ ok: true; id: number; mime: string } | { ok: false; error: string }> {
  const existing = db.prepare('SELECT id, mime FROM wa_media WHERE provider_media_id = ?').get(providerMediaId) as any;
  if (existing) return { ok: true, id: Number(existing.id), mime: String(existing.mime) };

  const raw = getWaConfigRaw();
  if (raw.wa_api_provider !== 'meta_cloud' || !raw.wa_access_token.trim()) {
    return { ok: false, error: 'not_configured' };
  }
  const f = fetchImpl ?? fetch;
  const auth = { Authorization: `Bearer ${raw.wa_access_token.trim()}` };
  try {
    // Step 1: media metadata → short-lived download URL.
    const metaRes = await f(`https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(providerMediaId)}`, {
      headers: auth, signal: AbortSignal.timeout(15000),
    });
    const meta: any = await metaRes.json().catch(() => ({}));
    if (!metaRes.ok || !meta?.url) {
      return { ok: false, error: meta?.error?.message || `media metadata HTTP ${metaRes.status}` };
    }
    const declared = Number(meta.file_size) || 0;
    if (declared > WA_MEDIA_MAX_BYTES) return { ok: false, error: `media too large (${declared} bytes > ${WA_MEDIA_MAX_BYTES} cap)` };
    // Step 2: the bytes (URL expires in minutes — this is why ingest-time).
    const binRes = await f(String(meta.url), { headers: auth, signal: AbortSignal.timeout(30000) });
    if (!binRes.ok) return { ok: false, error: `media download HTTP ${binRes.status}` };
    const buf = Buffer.from(await binRes.arrayBuffer());
    if (!buf.byteLength) return { ok: false, error: 'empty media response' };
    if (buf.byteLength > WA_MEDIA_MAX_BYTES) return { ok: false, error: `media too large (${buf.byteLength} bytes > ${WA_MEDIA_MAX_BYTES} cap)` };
    const mime = String(meta.mime_type || 'application/octet-stream');
    const info = db.prepare('INSERT INTO wa_media (provider_media_id, mime, size, data) VALUES (?, ?, ?, ?)')
      .run(providerMediaId, mime, buf.byteLength, buf);
    return { ok: true, id: Number(info.lastInsertRowid), mime };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'network error' };
  }
}

/* ═══════════════ status ladder (monotone) ═══════════════ */

/** failed ranks WITH read: it may supersede sent/delivered but never read (and read never un-fails). */
const STATUS_RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3, failed: 3 };

function statusErrorDetail(s: any): string {
  const e = Array.isArray(s?.errors) ? s.errors[0] : null;
  if (!e) return '';
  return [e.code, e.title, e.message, e?.error_data?.details].filter(Boolean).join(' — ').slice(0, 500);
}

/* ═══════════════ the processor ═══════════════ */

export interface IngestSummary {
  messages_ingested: number;
  messages_deduped: number;
  statuses_applied: number;
  statuses_noop: number;
  stubs_created: number;
  media_stored: number;
  media_failed: number;
  skipped: number;      // rows/entries that were not Meta message events
  errors: string[];
}

export function emptySummary(): IngestSummary {
  return { messages_ingested: 0, messages_deduped: 0, statuses_applied: 0, statuses_noop: 0, stubs_created: 0, media_stored: 0, media_failed: 0, skipped: 0, errors: [] };
}

export interface IngestOpts {
  fetchImpl?: FetchImpl;
  /** Retry the media fetch for existing messages stuck at media_status='failed' (backlog replays). */
  retryFailedMedia?: boolean;
}

/**
 * Ingest ONE whatsapp_events_log row into the inbox tables. Never throws for
 * malformed content — unknown shapes count as skipped, per-item failures land
 * in summary.errors. Safe to call any number of times for the same event.
 */
export async function processWebhookEvent(db: any, eventId: number, payload: string, opts?: IngestOpts): Promise<IngestSummary> {
  const sum = emptySummary();
  let root: any;
  try { root = JSON.parse(String(payload || '')); } catch { sum.skipped++; return sum; }
  if (!root || typeof root !== 'object') { sum.skipped++; return sum; }

  const entries = Array.isArray(root.entry) ? root.entry : [];
  if (!entries.length) { sum.skipped++; return sum; }

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value;
      const messages = Array.isArray(value?.messages) ? value.messages : [];
      const statuses = Array.isArray(value?.statuses) ? value.statuses : [];
      if (!messages.length && !statuses.length) { sum.skipped++; continue; }
      const contacts = Array.isArray(value?.contacts) ? value.contacts : [];

      for (const m of messages) {
        try { await ingestInbound(db, eventId, m, contacts, sum, opts); }
        catch (e: any) { sum.errors.push(`message ${String(m?.id || '?')}: ${e?.message || e}`); }
      }
      for (const s of statuses) {
        try { applyStatus(db, eventId, s, sum); }
        catch (e: any) { sum.errors.push(`status ${String(s?.id || '?')}: ${e?.message || e}`); }
      }
    }
  }
  return sum;
}

async function ingestInbound(db: any, eventId: number, m: any, contacts: any[], sum: IngestSummary, opts?: IngestOpts) {
  const wamid = String(m?.id || '').trim();
  const from = String(m?.from || '').replace(/\D/g, '');
  if (!wamid || !from) { sum.skipped++; return; }

  const { msgType, body, providerMediaId, replyTo } = extractContent(m);

  const existing = db.prepare('SELECT id, media_id, media_status FROM wa_messages WHERE wamid = ?').get(wamid) as any;
  if (existing) {
    sum.messages_deduped++;
    // Backlog replays double as media repair: a fetch that failed on first
    // ingest (token missing, network) is retried; once stored this is a no-op.
    if (opts?.retryFailedMedia && providerMediaId && !existing.media_id && existing.media_status === 'failed') {
      const res = await fetchAndStoreMedia(db, providerMediaId, opts?.fetchImpl);
      if (res.ok) {
        db.prepare("UPDATE wa_messages SET media_id = ?, media_status = 'stored', media_error = '' WHERE id = ?").run(res.id, existing.id);
        sum.media_stored++;
      } else {
        db.prepare("UPDATE wa_messages SET media_status = 'failed', media_error = ? WHERE id = ?").run(res.error, existing.id);
        sum.media_failed++;
      }
    }
    return;
  }

  const contact = contacts.find((c: any) => String(c?.wa_id || '').replace(/\D/g, '') === from) || contacts[0];
  const profileName = String(contact?.profile?.name || '').trim();
  const conv = upsertConversation(db, from, profileName);
  if (!conv) { sum.skipped++; return; }

  const ts = epochToUtc(m?.timestamp) || utcString(Date.now());

  let mediaId: number | null = null;
  let mediaStatus = '';
  let mediaError = '';
  if (providerMediaId) {
    const res = await fetchAndStoreMedia(db, providerMediaId, opts?.fetchImpl);
    if (res.ok) { mediaId = res.id; mediaStatus = 'stored'; sum.media_stored++; }
    else { mediaStatus = 'failed'; mediaError = res.error; sum.media_failed++; }
  }

  db.prepare(`
    INSERT INTO wa_messages (conversation_id, wamid, direction, msg_type, body, media_id, media_status, media_error,
                             status, status_at, reply_to_wamid, wa_timestamp, raw_event_id)
    VALUES (@conv, @wamid, 'in', @type, @body, @media_id, @media_status, @media_error,
            'received', @ts, @reply_to, @ts, @event)
  `).run({
    conv: conv.id, wamid, type: msgType, body,
    media_id: mediaId, media_status: mediaStatus, media_error: mediaError,
    ts, reply_to: replyTo, event: eventId,
  });
  sum.messages_ingested++;

  bumpConversation(db, conv.id, { inboundAt: ts, messageAt: ts, preview: previewOf(msgType, body), incrementUnread: true });

  // Campaign signals — STOP-keyword consent + 'replied' marking. AFTER the
  // wamid dedupe above, so a webhook retry / backlog replay fires this exactly
  // once per message (a replayed old STOP lands late-but-once). Best-effort:
  // a campaign-table fault must never break inbox ingest.
  try { broadcastOnInbound(db, conv.phone_key, msgType, body, ts); }
  catch (e: any) { sum.errors.push(`campaign-hook ${wamid}: ${e?.message || e}`); }
}

function applyStatus(db: any, eventId: number, s: any, sum: IngestSummary) {
  const wamid = String(s?.id || '').trim();
  const status = String(s?.status || '').trim().toLowerCase();
  if (!wamid || !(status in STATUS_RANK)) { sum.skipped++; return; }
  const ts = epochToUtc(s?.timestamp) || utcString(Date.now());
  const errDetail = status === 'failed' ? statusErrorDetail(s) : '';

  const row = db.prepare('SELECT id, conversation_id, status, direction FROM wa_messages WHERE wamid = ?').get(wamid) as any;
  // Statuses only ever describe OUTBOUND messages. Genuine Meta traffic never
  // emits a status for an inbound wamid, so a status naming one is a forged
  // POST to the public webhook — ignore it rather than let it rewrite the
  // inbound bubble's status or bump last_outbound_at.
  if (row && row.direction !== 'out') { sum.statuses_noop++; return; }
  if (!row) {
    // Outbound message we never recorded (sent through the notify rail, or
    // before the inbox existed). Materialise a stub so the thread shows it.
    const recipient = String(s?.recipient_id || '').replace(/\D/g, '');
    if (!recipient) { sum.skipped++; return; }
    const conv = upsertConversation(db, recipient);
    if (!conv) { sum.skipped++; return; }
    db.prepare(`
      INSERT INTO wa_messages (conversation_id, wamid, direction, msg_type, body, status, status_at, error_detail, wa_timestamp, raw_event_id)
      VALUES (@conv, @wamid, 'out', 'unknown', '', @status, @ts, @err, @ts, @event)
    `).run({ conv: conv.id, wamid, status, ts, err: errDetail, event: eventId });
    sum.stubs_created++;
    bumpConversation(db, conv.id, { outboundAt: ts, messageAt: ts, preview: '[outbound message]' });
    // A campaign send whose recordOutbound raced this status still gets its
    // recipient row updated — the join is the wamid, not the message row.
    try { broadcastOnStatus(db, wamid, status, ts, errDetail); }
    catch (e: any) { sum.errors.push(`campaign-hook status ${wamid}: ${e?.message || e}`); }
    return;
  }

  const cur = STATUS_RANK[String(row.status)] ?? 0;
  const next = STATUS_RANK[status];
  if (next > cur) {
    db.prepare('UPDATE wa_messages SET status = ?, status_at = ?, error_detail = CASE WHEN ? <> \'\' THEN ? ELSE error_detail END WHERE id = ?')
      .run(status, ts, errDetail, errDetail, row.id);
    sum.statuses_applied++;
    bumpConversation(db, row.conversation_id, { outboundAt: ts });
    // Mirror the applied status onto any campaign recipient carrying this
    // wamid (monotone there too; capped/opt-out classification lives in the
    // hook). Best-effort — never breaks status ingest.
    try { broadcastOnStatus(db, wamid, status, ts, errDetail); }
    catch (e: any) { sum.errors.push(`campaign-hook status ${wamid}: ${e?.message || e}`); }
  } else {
    sum.statuses_noop++; // late/duplicate status — the ladder only moves forward
  }
}

/* ═══════════════ backlog replay (explicit admin action — NEVER at boot) ═══════════════ */

export interface BacklogResult extends IngestSummary {
  scanned: number;
  from_event_id: number;
  last_event_id: number;
}

/**
 * Replay whatsapp_events_log kind='webhook' rows through the processor.
 * Default: rows past the stored cursor. full=true rescans from 0 (safe —
 * idempotent — and doubles as the media-repair pass via retryFailedMedia).
 */
export async function processBacklog(db: any, opts?: IngestOpts & { full?: boolean; limit?: number }): Promise<BacklogResult> {
  db.prepare('INSERT OR IGNORE INTO wa_ingest_state (id, last_event_id) VALUES (1, 0)').run();
  const state = db.prepare('SELECT last_event_id FROM wa_ingest_state WHERE id = 1').get() as any;
  const from = opts?.full ? 0 : Number(state?.last_event_id) || 0;
  const limit = Math.min(Math.max(Number(opts?.limit) || 5000, 1), 20000);

  const rows = db.prepare(
    "SELECT id, payload FROM whatsapp_events_log WHERE kind = 'webhook' AND id > ? ORDER BY id LIMIT ?",
  ).all(from, limit) as any[];

  const total: BacklogResult = { ...emptySummary(), scanned: rows.length, from_event_id: from, last_event_id: from };
  const ingestOpts: IngestOpts = { ...opts, retryFailedMedia: opts?.retryFailedMedia ?? true };

  for (const r of rows) {
    const one = await processWebhookEvent(db, Number(r.id), String(r.payload || ''), ingestOpts);
    total.messages_ingested += one.messages_ingested;
    total.messages_deduped += one.messages_deduped;
    total.statuses_applied += one.statuses_applied;
    total.statuses_noop += one.statuses_noop;
    total.stubs_created += one.stubs_created;
    total.media_stored += one.media_stored;
    total.media_failed += one.media_failed;
    total.skipped += one.skipped;
    if (one.errors.length) total.errors.push(...one.errors.slice(0, 5));
    total.last_event_id = Math.max(total.last_event_id, Number(r.id));
  }

  db.prepare('UPDATE wa_ingest_state SET last_event_id = ?, last_run_at = ?, last_run_summary = ? WHERE id = 1')
    .run(Math.max(total.last_event_id, Number(state?.last_event_id) || 0), utcString(Date.now()),
      JSON.stringify({ scanned: total.scanned, messages: total.messages_ingested, statuses: total.statuses_applied, media_failed: total.media_failed, errors: total.errors.length }));
  return total;
}

/* ═══════════════ outbound recording (reply API) ═══════════════ */

export function recordOutbound(db: any, args: {
  conversationId: number;
  wamid?: string | null;
  msgType?: string;
  body: string;
  status: 'sent' | 'failed';
  errorDetail?: string;
  sentBy?: string;
  /** wa_report_files.id when this message carried a report attachment. The
   *  thread then links the exact file the recipient received, so an internal
   *  report send is auditable from the conversation rather than only from a
   *  log line. Omitted → the column stays NULL, as on every other message. */
  reportFileId?: number | null;
}): any {
  const ts = utcString(Date.now());
  const wamid = String(args.wamid || '').trim() || null;
  // UPSERT on the wamid: if Meta's 'sent' status webhook lands before this
  // runs (it can — the status POST races the send API's response), applyStatus
  // has already materialised an outbound stub with this wamid. A plain INSERT
  // would then throw UNIQUE and the route would 500 a message the guest
  // actually received (and a staff retry would send a duplicate). On conflict
  // we fill in the stub's content but leave status/status_at alone — the
  // stub's status came from a real provider event and already ranks >= 'sent'
  // on the monotone ladder.
  const info = db.prepare(`
    INSERT INTO wa_messages (conversation_id, wamid, direction, msg_type, body, status, status_at, error_detail, wa_timestamp, sent_by, report_file_id)
    VALUES (@conv, @wamid, 'out', @type, @body, @status, @ts, @err, @ts, @by, @file)
    ON CONFLICT(wamid) WHERE wamid IS NOT NULL DO UPDATE SET
      msg_type     = excluded.msg_type,
      body         = excluded.body,
      sent_by      = excluded.sent_by,
      -- COALESCE, not a plain overwrite: a status webhook that raced this send
      -- created the stub with no file link, and a later upsert must never blank
      -- a link that is already there.
      report_file_id = COALESCE(excluded.report_file_id, wa_messages.report_file_id),
      error_detail = CASE WHEN excluded.error_detail <> '' THEN excluded.error_detail ELSE wa_messages.error_detail END
  `).run({
    conv: args.conversationId, wamid, type: args.msgType || 'text',
    body: String(args.body || ''), status: args.status, ts,
    err: String(args.errorDetail || ''), by: String(args.sentBy || ''),
    file: Number.isFinite(Number(args.reportFileId)) && Number(args.reportFileId) > 0 ? Number(args.reportFileId) : null,
  });
  if (args.status === 'sent') {
    bumpConversation(db, args.conversationId, { outboundAt: ts, messageAt: ts, preview: previewOf(args.msgType || 'text', args.body) });
  }
  return wamid
    ? db.prepare('SELECT * FROM wa_messages WHERE wamid = ?').get(wamid)
    : db.prepare('SELECT * FROM wa_messages WHERE id = ?').get(Number(info.lastInsertRowid));
}

/* ═══════════════ guest 360 join (list/thread enrichment) ═══════════════ */

export interface GuestRef {
  /** ct_guests.id when the caller CRM knows this phone, else the synthetic 'phone:<key>' handle /crm-calls/guests/[id] resolves. */
  guest_handle: string;
  guest_name: string;
}

/**
 * Resolve conversation phone_keys to guest handles + best-known names.
 * TS-side norm10 over ct_guests/crm_guests — the exact join loop the unified
 * guests list route uses (norm10(phone_e164) ≡ SQL KEY10).
 */
export function guestDirectoryFor(db: any, keys: string[]): Map<string, GuestRef> {
  const want = new Set(keys.filter(Boolean));
  const out = new Map<string, GuestRef>();
  if (!want.size) return out;
  try {
    const rows = db.prepare('SELECT id, name, phone_e164 FROM ct_guests').all() as any[];
    for (const r of rows) {
      const k = norm10(r.phone_e164);
      if (k && want.has(k) && !out.has(k)) out.set(k, { guest_handle: String(r.id), guest_name: String(r.name || '').trim() });
    }
  } catch { /* ct_guests may not exist on stripped DBs */ }
  try {
    const rows = db.prepare('SELECT name, mobile FROM crm_guests WHERE is_active = 1').all() as any[];
    for (const r of rows) {
      const k = norm10(r.mobile);
      if (!k || !want.has(k)) continue;
      const cur = out.get(k);
      if (!cur) out.set(k, { guest_handle: `phone:${k}`, guest_name: String(r.name || '').trim() });
      else if (!cur.guest_name) cur.guest_name = String(r.name || '').trim();
    }
  } catch { /* crm_guests optional */ }
  for (const k of want) {
    if (!out.has(k)) out.set(k, { guest_handle: `phone:${k}`, guest_name: '' });
  }
  return out;
}

/* ═══════════════ provider notice (why an inbox can be empty by design) ═══════════════ */

export function providerNotice(provider: string, configured: boolean): string {
  if (provider === 'interakt') {
    return 'Interakt provider: inbound message capture and free-form replies are not available — the inbox only receives messages on the Meta Cloud provider. Replies are approved-template only.';
  }
  if (provider !== 'meta_cloud') {
    return `Provider '${provider}' cannot receive or send inbox messages — switch to Meta Cloud in Settings → Integrations → WhatsApp.`;
  }
  if (!configured) {
    return 'WhatsApp is not fully configured (phone number ID / access token missing) — inbound capture may work via the webhook, but replies and media downloads will fail until an admin completes Settings → Integrations → WhatsApp.';
  }
  return '';
}
