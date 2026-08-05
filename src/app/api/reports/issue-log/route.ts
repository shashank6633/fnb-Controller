import { getCurrentUser, isManagement } from '@/lib/auth';
import { todayIST } from '@/lib/format-date';
import {
  getIssueLog,
  issueLogToCsv,
  issueLogFilename,
  ISSUE_LOG_COLUMNS,
  type IssueLogStageFilter,
  type IssueLogStageTotal,
} from '@/lib/issue-log';

/* ══════════════════════════════════════════════════════════════════════════
 * END-TO-END TRACEABILITY LOG — GET /api/reports/issue-log  (management only)
 *
 * Follows a material through every document it touches, in one date-ordered
 * list: what we RECEIVED, what a department REQUISITIONED, what the store
 * ISSUED against that requisition (in full or in part), and what was later
 * CONSUMED. This is the report the owner asked for in these words: "I need
 * proper log from purchase to department requestitions, issueings, partial and
 * normal everything."
 *
 * Modelled deliberately on /api/reports/purchase-log — same gate, same date
 * handling, same refusal to sum things that are not the same thing. Read that
 * route's header first; this one only records what is DIFFERENT here.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THERE IS NO GRAND TOTAL. THIS IS THE WHOLE DESIGN, NOT A TODO.
 * ─────────────────────────────────────────────────────────────────────────
 * purchase-log has to refuse a grand total because one delivery is written
 * into three tables and adding them roughly doubles the spend. This report is
 * worse exposed, because its five stages are not even measured in the same
 * thing:
 *
 *   RECEIPT           purchases / GRN     PURCHASE units   and rupees spent
 *   REQUISITION       requisition_items   the LINE's unit  no money at all
 *   ISSUE             the issue ledger    RECIPE units     a valued MEMO only
 *   ISSUE (pre-ledger) derived remainder  the LINE's unit  no money at all
 *   CONSUMPTION       inventory_txns      RECIPE units     no money at all
 *
 * Add any two of those and the result is wrong in BOTH its unit and its
 * meaning: 3 cases of oil + 4,500 ml of oil + 4,500 ml of oil is not 9,003 of
 * anything, and the same oil is being counted at three different moments of
 * its life. So `totals` is returned PER STAGE, never summed, there is
 * deliberately no `total_*` field anywhere in this payload, and the CSV writes
 * each stage total as its own captioned row that says in words what basis it
 * is on. If you are ever tempted to add one number that "covers everything",
 * re-read this block: that number is the bug. A missing figure is recoverable;
 * a confident wrong one is what gets quoted.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY "ISSUE (pre-ledger)" ROWS EXIST, AND WHY THEY CANNOT DOUBLE-COUNT
 * ─────────────────────────────────────────────────────────────────────────
 * Until the issue ledger started recording every hand-over, the ONLY trace of
 * an issue was requisition_items.quantity_issued being bumped and a JSON blob
 * appended to issue_history in the same row. 14,148 lines carry
 * quantity_issued > 0 and issue_history is the literal empty array on 14,144
 * of them — which is why /api/store-issued-log, which unrolls that JSON, shows
 * nothing for them. A traceability log that is blank on its first day is of no
 * use to an owner with 14k historical issues.
 *
 * So for each requisition line the log derives ONE row for the part that
 * predates the ledger:
 *
 *   legacy_line_qty = quantity_issued − SUM(recorded_recipe_qty / pack_factor)
 *
 * reversed through EACH ledger row's OWN stored pack_factor (a Unit Audit
 * rebase changes a material's factor later, so today's factor would give the
 * wrong remainder). Ledger rows plus the remainder therefore re-add to
 * quantity_issued EXACTLY, for every line, forever — it is a partition, not an
 * overlap. A line issued 5 before the ledger and 2 after shows 5 pre-ledger and
 * 2 recorded; never 7 twice, and never just 2.
 *
 * These rows carry no actor and no issue time, because those facts do not
 * exist and this report will not invent them. NOTHING IS WRITTEN TO THE
 * DATABASE to produce them — the remainder is a SELECT. Do not "fix" it by
 * backfilling ledger rows for history; the no-backfill rule on this repo is
 * absolute, and the moment history has ledger rows the partition above breaks.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * FULL vs PART, and the "issue id" doubt
 * ─────────────────────────────────────────────────────────────────────────
 * Every ISSUE row names the requisition LINE (req_item_id), not just the
 * requisition header, so the owner's 7kg-requested / 5kg-issued case reads as
 * one traceable line with what is still open beside it. FULL/PART is decided
 * against effective_line_qty as STAMPED on the ledger row at issue time — a
 * chef editing the approved quantity next week must not retro-rewrite what the
 * store handed over this morning.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS ROUTE DOES NOT DO
 * ─────────────────────────────────────────────────────────────────────────
 * It is READ-ONLY. There is no POST, no PUT, no repair action and no
 * side-effect of any kind: it does not touch current_stock, it does not read or
 * write settings.requisition_deduct_at_issue, and it does not care which way
 * that flag is set. An ISSUE row appears in this log whether or not the issue
 * moved central stock; the row states which it was, and why, on its own face
 * (`stock_moved` / `skip_reason`). That separation — ALWAYS RECORD, deduct only
 * when the flag says so — is the point of the ledger, and a future engineer
 * "simplifying" this report to only show rows that moved stock would delete
 * most of the log. Do not.
 *
 * GATE: management only (isManagement), matching /api/reports/purchases and
 * /api/reports/purchase-log — this joins purchase money and vendor rates onto
 * material rows, which is the same commercially sensitive content those two are
 * already gated on. The store team's own /api/store-issued-log is untouched and
 * keeps its canProcessAsStore gate, so nobody loses a surface they use today.
 * ══════════════════════════════════════════════════════════════════════════ */

// A traceability report served from cache is a wrong traceability report: the
// log changes every time a bill is keyed in, a requisition is raised, or the
// store hands anything over.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * ?stage= tokens accepted on the wire, each mapped to the ONE token
 * src/lib/issue-log.ts recognises.
 *
 * `issue` and the pre-ledger token are SEPARATE deliberately. Both are
 * hand-overs, but one is a recorded ledger row with an actor and a time and the
 * other is an arithmetic remainder with neither. Folding them into one filter
 * value would let a reader ask for "issues" and be handed rows that look
 * sourced but are derived.
 *
 * WHY THIS IS A MAP AND NOT A LIST, AND WHY YOU MUST NOT "SIMPLIFY" IT:
 * the lib's IssueLogStageFilter spells the pre-ledger token `pre_ledger`, while
 * /reports/issue-log sends `preledger`. Both are accepted here and both resolve
 * to `pre_ledger`, because getIssueLog() falls back to 'all' on a token it does
 * not recognise rather than throwing — so an unmapped spelling would not error,
 * it would quietly return EVERY stage under a heading that says "pre-ledger
 * issues only". A silent wrong answer is the one failure mode this whole report
 * exists to avoid. If the page and the lib are ever brought onto one spelling,
 * keep the other key here anyway: bookmarked and mailed report URLs outlive it.
 */
const STAGES: Record<string, IssueLogStageFilter> = {
  all: 'all',
  receipt: 'receipt',
  requisition: 'requisition',
  issue: 'issue',
  pre_ledger: 'pre_ledger',
  preledger: 'pre_ledger',
  consumption: 'consumption',
};

/** Calendar arithmetic on an IST date string. Never touches the server's zone. */
function shiftIstDays(ymd: string, days: number): string {
  // Parsed as UTC midnight deliberately: the input is already an IST calendar
  // date from todayIST(), so plain day arithmetic on it is exact. Building a
  // local Date here would shift the window by a day on a non-IST server.
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ─────────────────────── CSV totals block ───────────────────────────────────
 * issueLogToCsv() serialises the basis banner, the header and the rows — it
 * owns ISSUE_LOG_COLUMNS so the download and the screen cannot drift. It does
 * NOT write totals, because totals are a property of the whole filtered set
 * rather than of any row. That block is assembled here, out of the same
 * exported column list, so the caption cells stay aligned to the columns they
 * are captioning.
 */

/** RFC-4180 escaping. Item, vendor and department names here carry commas. */
const csvCell = (v: unknown): string => {
  const str = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};

const colIndex = (key: string) => ISSUE_LOG_COLUMNS.findIndex(c => c.key === (key as any));

// Resolved from the exported list, never hard-coded. A column inserted in the
// lib silently shifts every one of these, and a totals figure landing one cell
// left of its heading is a wrong number presented as a right one.
const LABEL_COL = colIndex('stage');
const QTY_COL   = colIndex('qty');
const BASIS_COL = colIndex('unit_basis');
const VALUE_COL = colIndex('value');

/**
 * One full-width CSV row: the caption under the Stage heading, and the figures
 * under the very headings they belong to.
 *
 * The label goes in the Stage column and NOT in column A. Column A is Date, and
 * a line of prose in a date column makes Excel abandon date typing for the
 * whole column — the totals block would cost the reader their date sort. Stage
 * is also the honest home for it: these are totals OF a stage.
 *
 * Values are written into `qty` and `value`, both of which the lib marks
 * numeric, so its leading-`=+-@` formula guard does not apply and a negative
 * figure is not quoted into text.
 */
function captionRow(label: string, fig?: { qty?: number | null; basis?: string; value?: number | null }): string {
  const cells = ISSUE_LOG_COLUMNS.map(() => '');
  if (LABEL_COL >= 0) cells[LABEL_COL] = label;
  if (fig) {
    if (fig.qty !== null && fig.qty !== undefined && QTY_COL >= 0) cells[QTY_COL] = String(fig.qty);
    if (fig.qty !== null && fig.qty !== undefined && fig.basis && BASIS_COL >= 0) cells[BASIS_COL] = fig.basis;
    if (fig.value !== null && fig.value !== undefined && VALUE_COL >= 0) cells[VALUE_COL] = String(fig.value);
  }
  return cells.map(csvCell).join(',');
}

/** `(12 lines)` / `(1 line)` — a totals caption reading "1 lines" invites a squint. */
const lineCount = (n: number) => `${n} ${n === 1 ? 'line' : 'lines'}`;

/**
 * A stage's quantity total is non-null ONLY when a single item is filtered:
 * summing quantities across items adds grams to millilitres to cases, which the
 * unit canon forbids and which no reader could interpret. When it is withheld
 * the caption must SAY so — a blank Qty cell beside a populated line count
 * otherwise reads as "zero moved".
 */
function qtyClause(t: IssueLogStageTotal): string {
  return t.qty === null
    ? ' Quantity total withheld: it is only meaningful with a single item selected.'
    : '';
}

export async function GET(req: Request) {
  try {
    // Same gate, same wording, as /api/reports/purchase-log.
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!isManagement(me)) return Response.json({ error: 'Management only' }, { status: 403 });

    const sp = new URL(req.url).searchParams;
    const rawFrom = sp.get('from');
    const rawTo = sp.get('to');

    // A malformed date is a 400, never a silent fall-back to the default
    // window: quietly returning a different period than the one asked for is
    // how a report gets read, signed off, and acted on for the wrong month.
    if (rawFrom !== null && !YMD.test(rawFrom)) {
      return Response.json({ error: `Invalid 'from' date "${rawFrom}" — expected YYYY-MM-DD.` }, { status: 400 });
    }
    if (rawTo !== null && !YMD.test(rawTo)) {
      return Response.json({ error: `Invalid 'to' date "${rawTo}" — expected YYYY-MM-DD.` }, { status: 400 });
    }

    // Default window: the last 30 days on the IST calendar, inclusive of today.
    // Resolved HERE, not inside getIssueLog, so the window echoed back in the
    // JSON body and the window stamped into the CSV filename are provably the
    // same one the rows were built from.
    const to = rawTo ?? todayIST();
    const from = rawFrom ?? shiftIstDays(to, -29);
    if (from > to) {
      return Response.json({ error: `'from' (${from}) must be on or before 'to' (${to}).` }, { status: 400 });
    }

    // Rejected, not coerced. getIssueLog() falls back to 'all' on an unknown
    // token, so accepting a typo here would answer a narrow question with the
    // whole log and label it with the narrow question.
    const rawStage = sp.get('stage');
    if (rawStage !== null && !Object.hasOwn(STAGES, rawStage)) {
      return Response.json(
        { error: `Invalid 'stage' "${rawStage}" — expected one of ${Object.keys(STAGES).join(', ')}.` },
        { status: 400 },
      );
    }
    const stage: IssueLogStageFilter = rawStage === null ? 'all' : STAGES[rawStage];

    const rawFormat = sp.get('format');
    if (rawFormat !== null && rawFormat !== 'json' && rawFormat !== 'csv') {
      return Response.json({ error: `Invalid 'format' "${rawFormat}" — expected json or csv.` }, { status: 400 });
    }

    const department_id = (sp.get('department_id') || '').trim();
    const material_id = (sp.get('material_id') || '').trim();
    const vendor = (sp.get('vendor') || '').trim();
    const req_number = (sp.get('req_number') || '').trim();

    // ONE call for both formats, with identical arguments. The CSV is a
    // rendering of this exact result — it is never re-queried with a wider or
    // narrower filter, which is the only way a download and the screen it was
    // taken from can be guaranteed to agree row for row and total for total.
    const result = getIssueLog({ from, to, department_id, material_id, vendor, req_number, stage });

    if (rawFormat === 'csv') {
      const t = result.totals;

      // The rows come from the lib (it owns ISSUE_LOG_COLUMNS, so the download
      // and the screen cannot disagree about what a column means). The totals
      // block is appended here, in the same column geometry.
      const lines: string[] = [issueLogToCsv(result.rows)];

      // ONE CAPTION PER STAGE, NEVER A SUM OF THEM — the whole point of this
      // report. Each caption states its own basis in words, because this file
      // gets mailed on and opened cold in Excel by someone who never saw the
      // page and its labels. If a future edit adds a "TOTAL — ALL STAGES" row
      // here, it will be adding purchase units to grams and a spend to a memo
      // valuation, and the owner will quote the result.
      lines.push(captionRow(''));
      lines.push(captionRow(
        `TOTAL — RECEIPT (${lineCount(t.receipt.lines)}): goods IN. Quantities are PURCHASE units; `
        + `Value is rupees actually SPENT — this is the books figure.${qtyClause(t.receipt)}`,
        { qty: t.receipt.qty, basis: t.receipt.unit_basis, value: t.receipt.value },
      ));
      lines.push(captionRow(
        `TOTAL — REQUISITION (${lineCount(t.requisition.lines)}): what departments ASKED FOR, each line in its `
        + `OWN unit. A request is not a movement and carries no money, so there is no value here.${qtyClause(t.requisition)}`,
        { qty: t.requisition.qty, basis: t.requisition.unit_basis, value: t.requisition.value },
      ));
      lines.push(captionRow(
        `TOTAL — ISSUE (${lineCount(t.issue.lines)}, of which ${t.issue.stock_moved_lines ?? 0} also debited central stock): `
        + `goods HANDED OVER by the store, in RECIPE units. The Value is a VALUED MEMO at average price, NOT a spend — `
        + `the money was already booked at RECEIPT, so DO NOT ADD this to the RECEIPT total.${qtyClause(t.issue)}`,
        { qty: t.issue.qty, basis: t.issue.unit_basis, value: t.issue.value },
      ));
      lines.push(captionRow(
        `TOTAL — ISSUE (pre-ledger) (${lineCount(t.pre_ledger.lines)}): hand-overs made before the issue ledger existed, `
        + `reconstructed from the requisition line as quantity issued minus what the ledger accounts for, in the LINE unit. `
        + `Together with the ISSUE rows above every hand-over is counted EXACTLY ONCE — the two partition, they do not `
        + `overlap.${qtyClause(t.pre_ledger)}`,
        { qty: t.pre_ledger.qty, basis: t.pre_ledger.unit_basis, value: t.pre_ledger.value },
      ));
      lines.push(captionRow(
        `TOTAL — CONSUMPTION (${lineCount(t.consumption.lines)}): goods USED UP, in RECIPE units. A SEPARATE event from `
        + `the issues above, usually days later — DO NOT ADD it to any issue figure.${qtyClause(t.consumption)}`,
        { qty: t.consumption.qty, basis: t.consumption.unit_basis, value: t.consumption.value },
      ));

      lines.push(captionRow(''));
      // A stage missing from stages_present returned nothing because the FILTERS
      // exclude it (stage=receipt with a department, say), not because nothing
      // happened. Without this line an empty leg reads as a clean shelf.
      lines.push(captionRow(
        `Stages these filters can answer at all: ${t.stages_present.join(' / ') || 'none'}. `
        + `A stage absent from that list is missing because the filters exclude it, NOT because nothing happened.`,
      ));
      lines.push(captionRow(
        `Rows in this file: ${t.lines}. Period ${from} to ${to} (IST). Stage filter: ${stage}.`
        + (department_id ? ` Department filter applied.` : '')
        + (material_id ? ` Item filter applied.` : '')
        + (vendor ? ` Vendor contains "${vendor}".` : '')
        + (req_number ? ` Requisition contains "${req_number}".` : ''),
      ));
      // Verbatim, never paraphrased: it is the guard against the one misreading
      // that matters, and it is why there is no grand total to print.
      lines.push(captionRow(t.basis));
      if (result.truncated) {
        lines.push(captionRow(
          `!! TRUNCATED — the row limit was reached, so the ROWS in this file are INCOMPLETE. The stage totals above are `
          + `still correct: they are computed by the database over the full filtered set, not by adding up the rows shown. `
          + `Narrow the date range or filter by item/department and download again.`,
        ));
      }

      // The BOM is added HERE, and only here, so it is emitted EXACTLY ONCE —
      // issueLogToCsv() documents that it deliberately returns a body without
      // one. Without a BOM, Excel on Windows decodes the file as ANSI and Indian
      // item, vendor and department names come out as mojibake. Two BOMs is
      // worse than none: the second is no longer a byte-order mark but ordinary
      // data, so the first cell opens carrying a stray zero-width character and
      // stops matching on any lookup or header compare. If issueLogToCsv is ever
      // changed to emit its own, delete this one in the same commit.
      const csv = '﻿' + lines.join('\r\n');

      return new Response(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${issueLogFilename(from, to)}"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    // Filters are echoed back so a saved/shared JSON response carries the
    // question it answers, not just the answer.
    return Response.json(
      { ...result, from, to, department_id, material_id, vendor, req_number, stage },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e: any) {
    console.error('[/api/reports/issue-log]', e);
    return Response.json({ error: e?.message || 'Failed to build issue log' }, { status: 500 });
  }
}
