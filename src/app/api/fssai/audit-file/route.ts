/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { isManagement } from '@/lib/auth';
import { fssaiToday } from '@/lib/fssai';
import { requireFssaiUser } from '@/lib/fssai-server';
import { fssaiJobsAuditSummary } from '@/lib/fssai-jobs';
import { businessName } from '../_p9/lib';
import { auditFileHoldsWords, buildAuditFile } from './lib';

/**
 * THE ONE AUDIT FILE, AS JSON (/api/fssai/audit-file?days=7|30|90).
 *
 * The authority's 20 "Records You Should Keep Ready in One Audit File", each
 * PRESENT, EXPIRING or MISSING, worked out by buildAuditFile() in ./lib — the
 * same function the PDF draws, so the screen and the paper cannot disagree.
 *
 * MANAGEMENT ONLY, the same gate as Inspection Mode, Documents and Reports:
 * page-catalog marks /fssai/audit-file mgmtOnly, and this route refuses anybody
 * isManagement() does not admit, because the catalog is visibility and never
 * security (canAccessPage fails open four ways). This page is the manager's own
 * readiness list — it names every gap in plain words — so it is never the
 * screen handed to an inspector; the handover PDF is (see ./pdf/route.ts).
 *
 * READ-ONLY. GET only; nothing here writes.
 */
export const dynamic = 'force-dynamic';

/** Rows per table on the screen. The PDF asks for far more. */
const SCREEN_ROWS = 8;

export async function GET(request: Request) {
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me as any;
  if (!isManagement(me)) {
    return Response.json(
      { error: 'The audit file is management only. Ask a manager or an administrator to open it.' },
      { status: 403 },
    );
  }

  try {
    const db = getDb();
    const url = new URL(request.url);
    const today = fssaiToday();
    const file = buildAuditFile(db, today, { days: Number(url.searchParams.get('days')) || undefined, rowLimit: SCREEN_ROWS });
    // What the unattended jobs did over the same dates (missed-check bell and
    // WhatsApp, abandoned cooling batches, the photo rule) — management
    // reading for this page only; it never goes into a PDF. Read-only and
    // never throws (fssai-jobs.ts); guarded anyway so it cannot cost the page.
    let jobs: ReturnType<typeof fssaiJobsAuditSummary> | null = null;
    try { jobs = fssaiJobsAuditSummary(db, { since: file.since, until: file.today }); } catch { jobs = null; }
    return Response.json({
      ...file,
      business_name: businessName(db),
      /** What the handover PDF will hold: every record with something on file — the same N of 20 it prints about itself. */
      pdf: {
        includes: file.handover.held,
        leaves_out: file.handover.left_out,
        holds_words: auditFileHoldsWords(file),
      },
      jobs,
      generated_at: new Date().toISOString(),
    });
  } catch (e: any) {
    console.error('GET /api/fssai/audit-file failed:', e);
    return Response.json({ error: e?.message || 'Could not assemble the audit file' }, { status: 500 });
  }
}
