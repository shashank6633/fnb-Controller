/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { isManagement } from '@/lib/auth';
import { fssaiToday } from '@/lib/fssai';
import { requireFssaiUser, str } from '@/lib/fssai-server';
import { buildReportPdf, humanDate, type PdfColumn } from '@/lib/report-pdf';
import { businessName, dateWindow, departmentNames, fssaiTablesPresent, slug } from '../../_p9/lib';
import { fssaiReport, primeDeptNames, type FssaiReportCtx } from '../../_p9/reports';

/**
 * ONE FSSAI REPORT AS A PDF (/api/fssai/reports/pdf?report=<key>&…).
 *
 * ── WHY THIS IS A SEPARATE ROUTE AND WHY ITS PATH MATTERS ───────────────────
 * It returns bytes, not JSON, so it cannot share the reports handler. And its
 * path deliberately does NOT contain the segment `print`: proxy.ts:125 treats any
 * pathname containing '/print' as PUBLIC and decides that BEFORE routing, so a
 * compliance pack served from a /print path would be downloadable with no session
 * at all (RECON §7.5, and the measured bypass recorded in fssai-server.ts's CSRF
 * note). The gate is this route's own getCurrentUser + isManagement.
 *
 * Serving a PDF over HTTP is new work in this codebase — all four existing
 * buildReportPdf call sites attach the buffer to a WhatsApp message. The HTTP
 * precedents followed here are api/dine-in/orders/[id]/bill-pdf and
 * api/tables/qr/pdf: a Response carrying the Buffer with Content-Type
 * application/pdf and a filename.
 *
 * ── THE TRUNCATION PROBLEM, AND THE WORKAROUND THIS ROUTE IMPLEMENTS ────────
 * buildReportPdf truncates every cell to ONE LINE with an ellipsis and never
 * wraps — deliberately, because a wrapped cell makes row height depend on
 * content, which makes pagination depend on content, which is how a 200-row
 * table becomes a 40-page PDF. RECON §7.4 names the consequence for this module
 * by name: "Corrective-action free text will be cut on an inspector's sheet", and
 * recommends "a second Notes section below the table printing full text per
 * flagged row, rather than widening the column".
 *
 * That is exactly what happens below. Every cell long enough to have been cut is
 * reprinted in full underneath, keyed to its row, in the footnotes — which DO
 * wrap, because the renderer draws them without `lineBreak: false`. So an
 * observation, a reason for a void or a description of a fix is never lost from
 * the sheet somebody hands over; it moves below the table instead of
 * disappearing at an ellipsis.
 */
export const dynamic = 'force-dynamic';

/** A cell longer than this is assumed to have been cut by the one-line fit. */
const LONG_CELL_CHARS = 48;
/** How many full-text entries to reprint before saying there were more. */
const MAX_FULL_TEXT = 60;

export async function GET(request: Request) {
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me as any;
  if (!isManagement(me)) {
    return Response.json(
      { error: 'Food-safety reports are management only. Ask a manager or an administrator to download this.' },
      { status: 403 },
    );
  }

  const key = str(new URL(request.url).searchParams.get('report'));

  try {
    const db = getDb();
    const url = new URL(request.url);
    const today = fssaiToday();
    const present = fssaiTablesPresent(db);
    const deptMap = departmentNames(db);
    primeDeptNames(db, deptMap);

    const def = fssaiReport(key);
    if (!def) return Response.json({ error: 'There is no report by that name.' }, { status: 404 });

    const missing = def.requires.filter((t) => !present.has(t));
    if (missing.length) {
      return Response.json(
        {
          error:
            'That register has not been created in this copy of the database yet, so there is nothing to put in a PDF.',
          missing_tables: missing,
        },
        { status: 503 },
      );
    }

    const window = dateWindow(
      str(url.searchParams.get('from')),
      str(url.searchParams.get('to')),
      str(url.searchParams.get('mode')),
    );
    const departmentId = def.hasDepartment ? str(url.searchParams.get('department_id')) : '';
    const ctx: FssaiReportCtx = {
      db, today, window, departmentId,
      status: str(url.searchParams.get('status')) || 'all',
      q: str(url.searchParams.get('q')),
      /* A PDF is held in memory and handed to a person. 1,500 rows of 14 points
       * is already ~30 pages; beyond that the download is the problem, not the
       * answer, and the footnote says so rather than silently stopping. */
      limit: Math.min(Number(url.searchParams.get('limit')) || 1500, 1500),
    };

    const result = def.run(ctx);

    const columns: PdfColumn[] = def.columns.map((c) => ({
      label: c.label,
      width: Number(c.width) || 1,
      align: c.align === 'center' ? 'center' : c.align === 'right' ? 'right' : 'left',
    }));

    /* ── the full text of everything the table will have cut ─────────────── */
    const fullText: string[] = [];
    let cutCount = 0;
    outer: for (let i = 0; i < result.cells.length; i++) {
      const row = result.cells[i];
      for (let j = 0; j < row.length; j++) {
        const v = row[j] == null ? '' : String(row[j]);
        if (v.length <= LONG_CELL_CHARS) continue;
        cutCount++;
        if (fullText.length >= MAX_FULL_TEXT) continue;
        /* Key it to something a reader can find: the first column (usually a
         * date or a reference) plus the column's own name. */
        const label = String(row[0] ?? `Row ${i + 1}`);
        fullText.push(`${label} — ${def.columns[j].label}: ${v}`);
        if (fullText.length >= MAX_FULL_TEXT && cutCount > MAX_FULL_TEXT) break outer;
      }
    }

    const filters: string[] = [];
    if (departmentId) filters.push(`Department: ${deptMap.get(departmentId) || departmentId}`);
    if (ctx.status && ctx.status !== 'all') filters.push(`Status: ${ctx.status}`);
    if (ctx.q) filters.push(`Matching: ${ctx.q}`);

    const period = window.all
      ? 'All records — no date range applied'
      : window.from && window.to && window.from !== window.to
        ? `${humanDate(window.from)} to ${humanDate(window.to)}`
        : humanDate(window.from || window.to);

    const footnotes: string[] = [];
    if (result.note) footnotes.push(result.note);
    if (window.all) {
      footnotes.push(
        'No date range was applied: this is every record in the register. A date range is always a deliberate choice in this module, ' +
        'because a compliance report that silently shows an empty window is worse than one that shows too much.',
      );
    }
    if (result.truncated) {
      footnotes.push(
        `This sheet shows the first ${result.cells.length} rows in date order. There are more — narrow the dates or the department, ` +
        'or take the Excel or CSV download, which is not limited in the same way.',
      );
    }
    if (fullText.length) {
      footnotes.push(
        'FULL TEXT OF THE ENTRIES CUT SHORT ABOVE. A table cell in this PDF is one line and is cut with an ellipsis rather than ' +
        'wrapped, so nothing below is new information — it is the same text, in full.',
      );
      for (const line of fullText) footnotes.push(line);
      if (cutCount > fullText.length) {
        footnotes.push(`…and ${cutCount - fullText.length} more entries were cut short. The CSV and Excel downloads carry every one in full.`);
      }
    }
    footnotes.push(
      `Produced from the food-safety records held in this application on ${today}, by ${String(me.name || me.email || '')}. ` +
      'A voided record is shown with its status and the reason given; nothing in this module is deleted.',
    );

    const pdf = await buildReportPdf({
      title: `Food safety — ${def.label}`,
      businessName: businessName(db),
      period,
      subtitle: [def.blurb, filters.join(' · ')].filter(Boolean).join('  ·  '),
      kpis: (result.kpis || []).map((k) => ({ label: k.label, value: k.value, sub: k.sub })),
      tables: [
        {
          columns,
          rows: result.cells,
          emptyNote:
            'No records match. That is a statement about the filters above, not about the restaurant — widen the dates or clear the department.',
        },
      ],
      footnotes,
    });

    /* Buffer → BodyInit, the same way the app's one existing PDF-over-HTTP route
     * does it (api/dine-in/orders/[id]/bill-pdf:56). `new Uint8Array(buffer)`
     * COPIES the bytes rather than viewing Node's shared pool, which is what
     * makes the length header safe to send. */
    const bytes = new Uint8Array(pdf);

    return new Response(bytes, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="fssai-${slug(def.label)}-${today}.pdf"`,
        'Content-Length': String(bytes.byteLength),
        'Cache-Control': 'no-store',
      },
    });
  } catch (e: any) {
    console.error(`GET /api/fssai/reports/pdf (${key}) failed:`, e);
    return Response.json({ error: e?.message || 'Failed to build that PDF' }, { status: 500 });
  }
}
