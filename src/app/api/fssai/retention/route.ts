/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { isManagement } from '@/lib/auth';
import { requireFssaiUser, requireFssaiAdmin, fssaiCsrfGuard, fssaiAppAudit, str } from '@/lib/fssai-server';
import { FSSAI_PHOTO_RETENTION_MONTHS } from '@/lib/fssai';
import {
  sweepFssaiPhotoRetention, fssaiPhotoRetentionStatus, listFssaiRetentionRuns,
} from '@/lib/fssai-retention';

/**
 * PHOTO RETENTION (/api/fssai/retention) — the other half of §19.
 *
 *   GET                              where the photographs stand, and every sweep so far
 *   POST { action: 'preview' }       what WOULD be dropped. Writes nothing at all.
 *   POST { action: 'sweep' }         drop the images that have aged out
 *
 * ── WHY THIS IS A §19 ROUTE AND NOT A HOUSEKEEPING ONE ──────────────────────
 * A retention sweep is the one process in this module that removes information
 * from a compliance file. The owner ruled the window (12 months, in-row, drop the
 * IMAGE and keep the record, its size and its digest — §7 Q13, 2026-09-25), and
 * W1 added `fssai_retention_runs` for one reason: a job that deletes evidence has
 * to be able to prove what it deleted. So every real pass writes its own row and
 * every dropped image writes an audit line, and both are readable on
 * /fssai/audit-log beside the voids.
 *
 * ── NOTHING HERE IS SCHEDULED, AND THE PAYLOAD SAYS SO ──────────────────────
 * `armed: false` comes back on every GET. This branch has no scheduler —
 * instrumentation.ts register() is an empty stub, measured — so the sweep runs
 * when an administrator asks it to and at no other time. A screen must not imply
 * otherwise: a reader who believes a sweep is running believes the database has a
 * ceiling, and it does not.
 *
 * ── THE WINDOW CANNOT BE SHORTENED BY A REQUEST ─────────────────────────────
 * `months` is honoured on a PREVIEW, which writes nothing and is how an admin
 * asks "what would a six-month window cost me". A real sweep ALWAYS uses the
 * ruled window and ignores the field. A POST that could narrow the window would
 * be a one-request way to destroy a year of food-safety photographs, and no
 * screen needs that. Changing the window is a code change with the owner's word
 * on it, which is the right amount of friction.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  if (!isManagement(g.me)) {
    return Response.json(
      { error: 'Photo retention is a management view.' },
      { status: 403 },
    );
  }

  try {
    const db = getDb();
    return Response.json({
      status: fssaiPhotoRetentionStatus(db),
      runs: listFssaiRetentionRuns(db, 20),
      ruled_months: FSSAI_PHOTO_RETENTION_MONTHS,
      /* Only an admin sees the buttons. Returned as a fact rather than inferred
       * on the screen, so the screen and the route agree about who may sweep. */
      can_sweep: g.me.role === 'admin',
    });
  } catch (e: any) {
    console.error('GET /api/fssai/retention failed:', e);
    return Response.json({ error: e?.message || 'Could not read the retention state.' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const csrf = fssaiCsrfGuard(request);
  if (csrf) return csrf;

  /* ADMIN ONLY — not management. Dropping images is the most destructive thing
   * this module can do, and canAuthorFssai is already the module's "only the
   * administrator configures" gate (owner §20). */
  const g = await requireFssaiAdmin();
  if ('resp' in g) return g.resp;
  const me = g.me;

  try {
    let body: any = {};
    try { body = await request.json(); } catch { body = {}; }
    const action = str(body?.action);

    if (action !== 'preview' && action !== 'sweep') {
      return Response.json(
        { error: 'Send action: "preview" to see what would go, or "sweep" to drop the aged-out images.' },
        { status: 400 },
      );
    }

    const db = getDb();

    if (action === 'preview') {
      const asked = Number(body?.months);
      const months = Number.isFinite(asked) && asked >= 1 && asked <= 120
        ? Math.floor(asked)
        : FSSAI_PHOTO_RETENTION_MONTHS;
      const report = sweepFssaiPhotoRetention(db, { months, dryRun: true });
      return Response.json({
        ok: true,
        preview: true,
        /* The row list can be long and each entry is small (no data_uri in it) —
         * capped anyway so a screen cannot be handed 50,000 lines. */
        report: { ...report, rows: report.rows.slice(0, 200), rows_shown: Math.min(200, report.rows.length) },
        months_used: months,
        ruled_months: FSSAI_PHOTO_RETENTION_MONTHS,
        message: report.candidates === 0
          ? 'Nothing has aged out. Nothing was changed — a preview never writes.'
          : `${report.candidates} image${report.candidates === 1 ? '' : 's'} would be dropped, freeing ${report.bytes_freed_label}. Nothing was changed.`,
      });
    }

    const report = sweepFssaiPhotoRetention(db, {
      months: FSSAI_PHOTO_RETENTION_MONTHS,   // see the header: never from the request
      actor: { email: me.email, name: me.name },
    });

    fssaiAppAudit(db, {
      event_type: 'fssai.retention.sweep',
      entity_type: 'fssai_retention_runs',
      entity_id: report.retention_run_id,
      actor_email: me.email,
      after: {
        dropped: report.dropped,
        evidence_dropped: report.evidence_dropped,
        attachments_dropped: report.attachments_dropped,
        bytes_freed: report.bytes_freed,
        cutoff: report.cutoff,
      },
      note: report.stores_skipped ? `Could not walk: ${report.stores_skipped}` : '',
    });

    return Response.json({
      ok: true,
      preview: false,
      report: { ...report, rows: [], rows_shown: 0 },
      status: fssaiPhotoRetentionStatus(db),
      runs: listFssaiRetentionRuns(db, 20),
      message: report.dropped === 0
        ? 'Nothing had aged out. The sweep ran and is recorded, so the file can show it ran.'
        : `${report.dropped} image${report.dropped === 1 ? '' : 's'} dropped (${report.evidence_dropped} from checklist rounds, ${report.attachments_dropped} from the registers), freeing ${report.bytes_freed_label}. Every record, size and digest was kept.`,
    });
  } catch (e: any) {
    console.error('POST /api/fssai/retention failed:', e);
    return Response.json(
      { error: e?.message || 'The retention sweep could not be completed.' },
      { status: 500 },
    );
  }
}
