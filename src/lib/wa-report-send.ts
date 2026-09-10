/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * WhatsApp REPORT ATTACHMENTS — store a generated report, upload it to Meta,
 * send it as a template's document header, and record the send in the thread.
 *
 * WHY THIS MODULE EXISTS SEPARATELY
 * ─────────────────────────────────
 * wa-inbox.ts already imports whatsapp.ts (for the Graph version + raw config),
 * so whatsapp.ts must never import wa-inbox.ts back. Anything that both SENDS
 * and RECORDS therefore has to be a third module — the shape wa-broadcast.ts
 * already uses. whatsapp.ts stays the transport; this file is the workflow.
 *
 * THE ORDER IS THE CONTRACT (and is what the tests pin)
 * ─────────────────────────────────────────────────────
 *   1. OUR limits           size + MIME, before any network and before any
 *                           write. An oversize file is refused with OUR
 *                           message, not an opaque provider error.
 *   2. store                the bytes land in wa_report_files first, so a
 *                           report that cannot be WhatsApp'd is still a
 *                           deliverable — downloadable from the authed route.
 *   3. verify the template  Meta is asked whether this template's header is
 *                           actually a DOCUMENT. A template with a TEXT header
 *                           is refused HERE — before the upload, and long
 *                           before a message exists to be wrong.
 *   4. upload               one upload per file, reused across recipients and
 *                           across the media id's TTL.
 *   5. send + record        per recipient: send, then write the bubble into
 *                           wa_messages — successes AND failures. A send that
 *                           does not appear in the thread is a send nobody can
 *                           audit, and the status webhook needs the row to
 *                           ladder delivered → read onto.
 *
 * A FAILURE AT ANY OF 1–4 SENDS NOTHING. That is the point of the ordering:
 * the expensive, irreversible step (a message in someone's chat) is last.
 */
import {
  uploadWaMedia,
  getWaTemplateShape,
  sendWhatsAppTemplate,
  getWaConfigRaw,
  isWaConfigured,
  logWaSendAttempt,
  normalizeWaNumber,
  WA_UPLOAD_MAX_BYTES,
  WA_UPLOAD_MIME_ALLOW,
  type WaSendResult,
} from '@/lib/whatsapp';
import { upsertConversation, recordOutbound, utcString, parseUtc } from '@/lib/wa-inbox';
import { createHash } from 'crypto';

/**
 * How long a Meta media id is trusted before the file is re-uploaded.
 *
 * Meta expires media ids; the exact window is commonly quoted as ~30 days but
 * is NOT something this codebase has proven, so this is deliberately far
 * shorter than any quoted figure. The cost of being wrong in this direction is
 * one extra upload of a file we already hold; the cost of being wrong the other
 * way is a report that silently fails to deliver.
 */
export const WA_MEDIA_ID_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Meta error codes that mean "that media id is no longer usable" rather than
 * "this send is doomed". Treated as a hint, not gospel — the text match below
 * catches the same class when the code is one we have not seen.
 */
const MEDIA_ERROR_CODES = new Set([100, 131052, 131053]);
const MEDIA_ERROR_TEXT = /\b(media|attachment|handle|file)\b/i;

export interface ReportFileInput {
  /** Which report this is — 'stock_variance_daily', 'price_hike_weekly', … */
  reportKey: string;
  /** The day or range it covers, for the audit trail: '2026-09-09'. */
  period: string;
  /** The filename the WhatsApp recipient sees. */
  filename: string;
  mime: string;
  data: Uint8Array | Buffer;
  createdBy?: string;
}

export interface ReportSendArgs extends ReportFileInput {
  /** An APPROVED Meta template whose HEADER format is DOCUMENT. */
  templateName: string;
  language?: string;
  /** POSITIONAL body params: [0] → {{1}}. Whitespace is collapsed, as elsewhere. */
  bodyParams?: (string | number)[];
  recipients: string[];
  /** Audit stamp on the thread bubble, e.g. 'report:stock_variance_daily'. */
  sentBy?: string;
  /**
   * The report's human name, for the thread caption ('Daily ops report').
   * Never a figure — see the caption rule below.
   */
  reportLabel?: string;
  /**
   * CONFIDENTIAL BY DEFAULT — and this default is the gate, not a hint.
   *
   * ╔══════════════════════════════════════════════════════════════════════╗
   * ║ WHAT GOES IN wa_messages.body IS READABLE BY EVERY SIGNED-IN MEMBER. ║
   * ╚══════════════════════════════════════════════════════════════════════╝
   * GET /api/crm-calls/inbox and /api/crm-calls/inbox/[id] are open to any
   * member by owner policy (guest history is not management-only), and both
   * return the bubble text — the list route even copies its first 140
   * characters into wa_conversations.last_message_preview. So a report whose
   * TEXT was recorded there would hand every waiter the day's net collected,
   * discount, tax, payment mix and month-to-date — the very figures
   * /api/crm-calls/reports/files/[id] refuses them with a 403, one table over.
   *
   * Therefore: while `confidential` is not explicitly false, the bubble is a
   * CAPTION built here from the report's name, its period and the filename —
   * never `threadBody`, whatever the caller passed. The figures live in the
   * PDF, behind the isManagement download route, and nowhere else.
   *
   * Only a GUEST-facing message (a reservation confirmation, addressed to the
   * guest whose booking it is) may set this false: there the bubble IS that
   * person's own message, and recording it is what the inbox is for.
   */
  confidential?: boolean;
  /** Guest-facing bubble text. IGNORED unless `confidential` is false. */
  threadBody?: string;
  /**
   * What kind of run this is: 'scheduler' | 'manual' | 'test' | 'event'.
   *
   * Stamped on every send-attempt log row, because "was this report delivered
   * today?" and "did somebody press Send Test?" are different questions asked
   * of the same table. Without it a TEST send satisfied the scheduler's
   * already-delivered backstop, and that day's real report — to the configured
   * audience — was cancelled by the button that promised to reach the tester
   * and nobody else. See reportSentToday() in wa-report-jobs.ts.
   */
  trigger?: string;
  /**
   * Which outlet this report is FOR. Recorded on every send-attempt log row so
   * the scheduler's "did this already go out today?" backstop can be asked per
   * outlet.
   *
   * It is not decoration. Without it that backstop matches on report_key alone,
   * and on a two-outlet install the first outlet's successful send makes the
   * second outlet look already-sent — so branch two never receives its own
   * report, and its ledger row claims it did. Optional, and '' on a
   * single-outlet install, where the question cannot arise.
   */
  outletId?: string;
}

export interface ReportSendResult {
  ok: boolean;
  /** How far the run got — the tests assert on this. */
  stage: 'refused' | 'stored' | 'verified' | 'uploaded' | 'sent';
  file_id: number | null;
  media_id: string;
  /** Set when the run stopped before any message was sent. */
  refused: { reason: string; detail: string } | null;
  sent: Array<{ to: string; wamid: string | null; message_id: number | null }>;
  failed: Array<{ to: string; detail: string }>;
  uploads: number;
}

/* ═══════════════ the private file store ═══════════════ */

function sha256Of(bytes: Uint8Array | Buffer): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

/**
 * Persist a generated report. Returns the wa_report_files.id, which is the
 * handle the authed download route and the thread bubble both use.
 *
 * Same-bytes reuse: a report regenerated with identical content for the same
 * key+period+filename reuses its row (and therefore any still-fresh media id)
 * instead of growing a second copy of the same BLOB in every backup. The
 * FILENAME is part of that key on purpose — it is what the recipient sees on
 * the document bubble and what the download route serves, so identical bytes
 * under a different name are a different deliverable, not a duplicate.
 */
export function storeReportFile(db: any, f: ReportFileInput): number {
  const bytes = Buffer.from(f.data as any);
  const sha = sha256Of(bytes);
  const reportKey = String(f.reportKey || '').trim();
  const period = String(f.period || '').trim();
  const filename = String(f.filename || '').trim() || 'report.pdf';

  const existing = db.prepare(
    'SELECT id FROM wa_report_files WHERE sha256 = ? AND report_key = ? AND period = ? AND filename = ? ORDER BY id DESC LIMIT 1',
  ).get(sha, reportKey, period, filename) as { id: number } | undefined;
  if (existing) return Number(existing.id);

  const info = db.prepare(`
    INSERT INTO wa_report_files (report_key, period, filename, mime, size, sha256, data, created_by)
    VALUES (@key, @period, @filename, @mime, @size, @sha, @data, @by)
  `).run({
    key: reportKey, period, filename,
    mime: String(f.mime || 'application/pdf').trim().toLowerCase(),
    size: bytes.byteLength, sha, data: bytes,
    by: String(f.createdBy || ''),
  });
  return Number(info.lastInsertRowid);
}

export function getReportFile(db: any, id: number): {
  id: number; report_key: string; period: string; filename: string;
  mime: string; size: number; data: Buffer;
} | undefined {
  return db.prepare(
    'SELECT id, report_key, period, filename, mime, size, data FROM wa_report_files WHERE id = ?',
  ).get(Number(id)) as any;
}

/**
 * THE THREAD BUBBLE FOR A CONFIDENTIAL REPORT — a caption, never the report.
 *
 * Names what was sent, when it was for, and which file it was. Carries no
 * figure of any kind, because every signed-in member can read it (see
 * `confidential` above). Exported so the plain-template alert path in
 * wa-report-events.ts writes exactly the same line for the same reason.
 */
export function reportThreadCaption(a: { reportKey?: string; label?: string; period?: string; filename?: string }): string {
  const label = String(a.label || '').trim();
  const period = String(a.period || '').trim();
  const filename = String(a.filename || '').trim();
  const key = String(a.reportKey || '').trim();
  // No label means a caller outside the report rails (the attachment tests
  // among them) that never had figures to leak in the first place: keep the
  // filename it has always shown rather than inventing a name for it.
  if (!label) return filename || key || 'report';
  // The period is a DAY for a report and an ENTITY ID for an event alert. A day
  // reads usefully in a chat list; a uuid is noise, so it is left off rather
  // than printed at somebody.
  const dayish = /^\d{4}-\d{2}-\d{2}$/.test(period) || (!!period && period.length <= 12);
  return [label, dayish ? period : ''].filter(Boolean).join(' — ') + (filename ? ` · ${filename}` : '');
}

/** A stored media id we are still willing to reuse, or '' when it must be re-uploaded. */
function freshMediaId(row: { provider_media_id?: string; provider_uploaded_at?: string } | undefined, nowMs: number): string {
  const id = String(row?.provider_media_id || '').trim();
  if (!id) return '';
  const at = parseUtc(row?.provider_uploaded_at);
  if (!Number.isFinite(at)) return '';
  return nowMs - at < WA_MEDIA_ID_TTL_MS ? id : '';
}

/* ═══════════════ the send ═══════════════ */

/**
 * Generate-and-send is the caller's job; this takes the finished bytes.
 * NEVER throws — every outcome comes back on the result, and every attempt
 * lands in whatsapp_events_log through the shared logWaSendAttempt door.
 */
export async function sendReportAttachment(
  db: any,
  args: ReportSendArgs,
  opts?: { fetchImpl?: typeof fetch; nowMs?: number },
): Promise<ReportSendResult> {
  const now = opts?.nowMs ?? Date.now();
  const out: ReportSendResult = {
    ok: false, stage: 'refused', file_id: null, media_id: '',
    refused: null, sent: [], failed: [], uploads: 0,
  };
  const reportKey = String(args.reportKey || '').trim();
  const filename = String(args.filename || '').trim() || 'report.pdf';
  const mime = String(args.mime || 'application/pdf').trim().toLowerCase();
  const language = String(args.language || 'en').trim() || 'en';
  const templateName = String(args.templateName || '').trim();

  // 'scheduler' when the caller says nothing: an unlabelled row must never look
  // like a test to the scheduler's already-delivered backstop, because a test
  // is the one kind of row that does NOT count as the day's delivery.
  const trigger = String(args.trigger || 'scheduler').trim() || 'scheduler';

  const refuse = (reason: string, detail: string): ReportSendResult => {
    out.refused = { reason, detail };
    logWaSendAttempt({
      event: 'report_attachment', report_key: reportKey, file: filename,
      template: templateName, ok: false, reason, detail, stage: out.stage,
      trigger_source: trigger,
    });
    return out;
  };

  try {
    // ── 1. OUR limits, before anything else ───────────────────────────────
    const bytes = args.data ? Buffer.from(args.data as any) : Buffer.alloc(0);
    if (!bytes.byteLength) return refuse('empty', 'Nothing to attach — the generated report is empty.');
    if (bytes.byteLength > WA_UPLOAD_MAX_BYTES) {
      const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
      return refuse('too_large',
        `${filename} is ${mb(bytes.byteLength)} — over the ${mb(WA_UPLOAD_MAX_BYTES)} WhatsApp attachment limit. Narrow the report's date range, or download it from the app instead.`);
    }
    if (!WA_UPLOAD_MIME_ALLOW[mime]) {
      return refuse('unsupported_type',
        `${mime || 'unknown type'} cannot be sent as a WhatsApp attachment. Allowed: ${Object.keys(WA_UPLOAD_MIME_ALLOW).join(', ')}.`);
    }
    if (!templateName) return refuse('no_template', 'No template name given for the attachment send.');

    // Dedupe + normalise recipients up front so one number listed twice cannot
    // deliver the same report twice.
    const recipients: string[] = [];
    const seen = new Set<string>();
    for (const r of Array.isArray(args.recipients) ? args.recipients : []) {
      const n = normalizeWaNumber(String(r || ''));
      if (!n || seen.has(n)) continue;
      seen.add(n); recipients.push(n);
    }
    if (!recipients.length) return refuse('no_recipient', 'No WhatsApp recipients configured for this report.');

    if (!isWaConfigured()) {
      return refuse('not_configured', 'WhatsApp is not configured — complete Settings → Integrations → WhatsApp.');
    }
    if (getWaConfigRaw().wa_api_provider !== 'meta_cloud') {
      return refuse('not_configured', 'Attachments are only supported on the Meta Cloud provider.');
    }

    // ── 2. STORE — the report exists in its own right, send or no send ────
    out.file_id = storeReportFile(db, {
      reportKey, period: args.period, filename, mime, data: bytes, createdBy: args.createdBy,
    });
    out.stage = 'stored';

    // ── 3. VERIFY THE TEMPLATE — refuse before uploading, never after ─────
    const shape = await getWaTemplateShape(templateName, language, { fetchImpl: opts?.fetchImpl });
    if (!shape.ok) return refuse(shape.reason, shape.detail);
    if (shape.status && shape.status.toUpperCase() !== 'APPROVED') {
      return refuse('template_not_approved',
        `Template "${templateName}" is ${shape.status} at Meta, not APPROVED — it cannot be sent.`);
    }
    const wantKind = WA_UPLOAD_MIME_ALLOW[mime];            // 'document' | 'image'
    const wantFormat = wantKind === 'document' ? 'DOCUMENT' : 'IMAGE';
    if (shape.headerFormat !== wantFormat) {
      const has = shape.headerFormat === 'NONE' ? 'no header at all' : `a ${shape.headerFormat} header`;
      return refuse('header_format_mismatch',
        `Template "${templateName}" has ${has}, so it cannot carry ${filename}. A template must be CREATED at Meta with a ${wantFormat} header — the format cannot be added to an approved template from here. Nothing was sent.`);
    }
    out.stage = 'verified';

    // ── 4. UPLOAD — once per file, reused while the id is fresh ───────────
    const row = db.prepare('SELECT provider_media_id, provider_uploaded_at FROM wa_report_files WHERE id = ?')
      .get(out.file_id) as any;
    let mediaId = freshMediaId(row, now);
    let mediaIdWasReused = !!mediaId;

    if (!mediaId) {
      const up = await uploadWaMedia({ data: bytes, filename, mime }, { fetchImpl: opts?.fetchImpl });
      out.uploads++;
      if (!up.ok) {
        try {
          db.prepare("UPDATE wa_report_files SET provider_error = ? WHERE id = ?").run(String(up.detail).slice(0, 500), out.file_id);
        } catch { /* the refusal is what matters */ }
        // NOTHING IS SENT. A failed upload must never fall through to a send
        // with a stale or empty media id — that is how a recipient gets a
        // template with a broken attachment slot.
        return refuse(up.reason, up.detail);
      }
      mediaId = up.media_id;
      mediaIdWasReused = false;
      db.prepare("UPDATE wa_report_files SET provider_media_id = ?, provider_uploaded_at = ?, provider_error = '' WHERE id = ?")
        .run(mediaId, utcString(now), out.file_id);
    }
    out.media_id = mediaId;
    out.stage = 'uploaded';

    // ── 5. SEND + RECORD, per recipient ──────────────────────────────────
    const bodyParams = (Array.isArray(args.bodyParams) ? args.bodyParams : [])
      // Meta rejects positional params containing newlines/tabs/long space
      // runs — the same hygiene notifyEvent applies.
      .map(v => String(v).replace(/\s+/g, ' ').trim());
    // THE BUBBLE. A confidential report records a caption and nothing else —
    // the figures are in the attachment, behind the management-only download
    // route. `threadBody` is honoured ONLY for an explicitly guest-facing
    // message, whose bubble is that guest's own message.
    const caption = reportThreadCaption({
      reportKey, label: args.reportLabel, period: String(args.period || ''), filename,
    });
    const threadBody = args.confidential === false
      ? (String(args.threadBody || '').trim() || caption)
      : caption;
    const sentBy = String(args.sentBy || (reportKey ? `report:${reportKey}` : 'report'));

    const sendOne = (to: string, id: string): Promise<WaSendResult> =>
      sendWhatsAppTemplate(to, templateName, language, bodyParams, {
        headerMedia: { kind: wantKind, media_id: id, filename },
        fetchImpl: opts?.fetchImpl,
      });

    for (const to of recipients) {
      let res: WaSendResult = await sendOne(to, mediaId);

      // Expired/invalid media id: only worth retrying when we REUSED a cached
      // id, and only when Meta actually answered. A network error is never
      // retried — Meta may have accepted the message whose response we lost,
      // and a retry would put the report in the chat twice.
      if (!res.ok && mediaIdWasReused && isExpiredMediaFailure(res)) {
        const re = await uploadWaMedia({ data: bytes, filename, mime }, { fetchImpl: opts?.fetchImpl });
        out.uploads++;
        if (re.ok) {
          mediaId = re.media_id;
          mediaIdWasReused = false;             // one retry, for the whole run
          out.media_id = mediaId;
          db.prepare("UPDATE wa_report_files SET provider_media_id = ?, provider_uploaded_at = ?, provider_error = '' WHERE id = ?")
            .run(mediaId, utcString(Date.now()), out.file_id);
          res = await sendOne(to, mediaId);
        }
      }

      const detail = res.ok ? '' : String((res as any).detail || (res as any).reason || 'send failed').slice(0, 500);
      const wamid = res.ok ? (String(res.message_id || '').trim() || null) : null;

      // RECORD — successes and failures alike. Best-effort: a thread-write
      // fault must never turn a delivered report into a crash, but it is
      // logged, because an unrecorded send is an unauditable one.
      let messageId: number | null = null;
      try {
        const conv = upsertConversation(db, to);
        if (conv) {
          const rec = recordOutbound(db, {
            conversationId: conv.id,
            wamid,
            msgType: wantKind,                  // 'document' | 'image'
            body: threadBody,
            status: res.ok ? 'sent' : 'failed',
            errorDetail: detail,
            sentBy,
            reportFileId: out.file_id,
          });
          messageId = rec?.id != null ? Number(rec.id) : null;
        }
      } catch (e: any) {
        logWaSendAttempt({
          event: 'report_attachment', report_key: reportKey, to, ok: false,
          reason: 'thread_record_failed', detail: e?.message || 'unexpected error',
        });
      }

      logWaSendAttempt({
        event: 'report_attachment', report_key: reportKey, outlet_id: String(args.outletId || ''),
        trigger_source: trigger,
        to, file: filename, file_id: out.file_id, media_id: mediaId, template: templateName, ...res,
      });

      if (res.ok) out.sent.push({ to, wamid, message_id: messageId });
      else out.failed.push({ to, detail });
    }

    out.stage = 'sent';
    out.ok = out.sent.length > 0;
    return out;
  } catch (e: any) {
    // Belt and braces: the daily report job must never take a cron run down.
    return refuse('unexpected_error', e?.message || 'Unexpected error sending the report attachment');
  }
}

/** Did Meta reject this send because the media id is gone, rather than because
 *  the send itself is doomed? Requires a real HTTP answer — never a timeout. */
function isExpiredMediaFailure(res: WaSendResult): boolean {
  if (res.ok) return false;
  const r = res as { detail?: string; error_code?: number; http_status?: number };
  if (!r.http_status) return false;                      // network error → never retry
  if (r.error_code && MEDIA_ERROR_CODES.has(r.error_code)) return true;
  return MEDIA_ERROR_TEXT.test(String(r.detail || ''));
}
