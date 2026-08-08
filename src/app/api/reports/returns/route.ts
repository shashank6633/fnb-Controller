import { getCurrentUser, isManagement } from '@/lib/auth';
import { RETURN_STATUSES } from '@/lib/returns';
import {
  getReturnLog,
  returnLogToCsv,
  returnLogFilename,
  resolveReturnLogRange,
  RETURN_LOG_COLUMNS,
  type ReturnLogSourceFilter,
  type ReturnLogDispositionFilter,
  type ReturnLogSourceTotal,
} from '@/lib/return-log';

/* ══════════════════════════════════════════════════════════════════════════
 * RETURN REPORT — GET /api/reports/returns  (management only)   [req 79]
 *
 * Every column requirement 79 asked for, for BOTH kinds of return in one
 * date-ordered list: Item Name, PO No., GRN No., Return Ticket Raised By, Date
 * & Time, Approved By, Reason, Status and Quantity — with Vendor Returns and
 * Internal Department Returns both present and each row saying, on its own
 * face, which it is.
 *
 * Modelled deliberately on /api/reports/issue-log — same gate, same strict date
 * handling, same one-call-serves-both-formats rule, same refusal to sum things
 * that are not the same thing. Read that route's header first; this one records
 * only what is DIFFERENT here.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TWO FACTS A READER OF THIS REPORT MUST HAVE BEFORE THEY READ A NUMBER
 * ─────────────────────────────────────────────────────────────────────────
 * 1. STOCK MOVES ONLY WHEN THE STORE ACCEPTS A LINE. Nothing about raising a
 *    ticket, and nothing about the Department Head approving it, moves a single
 *    gram. A ticket sitting at `hod_approved` means the goods are standing at
 *    the store counter and the books have not changed. On a live board the
 *    COMMON case is a row that moved nothing at all, which is why every row
 *    carries `stock_moved` / `stock_effect` and why the totals state how many
 *    of their lines actually moved. Reading the requested quantity as though it
 *    had already travelled is the misreading this report is shaped to prevent.
 *
 * 2. A VENDOR RETURN AND AN INTERNAL RETURN HAVE OPPOSITE EFFECTS ON CENTRAL
 *    STOCK. A vendor return sends goods BACK OUT OF THE BUILDING — central
 *    stock DECREASES and the money is a credit note the vendor owes. An
 *    internal department return brings goods from a department BACK INTO THE
 *    STORE — central stock INCREASES and the money is a valued memo; nobody
 *    paid anybody. (A third case hides inside the internal half: a line marked
 *    wastage or disposal takes the DEPARTMENT down and does NOT credit central,
 *    because unusable goods must never re-enter the sellable pool.)
 *
 * Which is why:
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THERE IS NO GRAND TOTAL, AND THERE MUST NOT BE. THIS IS THE DESIGN.
 * ─────────────────────────────────────────────────────────────────────────
 * purchase-log refuses a grand total because one delivery is written into three
 * tables. issue-log refuses one because its five stages are measured in
 * different units. This report refuses one for a harder reason still: its two
 * sources point in OPPOSITE DIRECTIONS on the same scalar. Adding 40 kg
 * returned to a vendor to 15 kg returned by the kitchen gives 55 kg of nothing
 * — central stock actually fell 40 and rose 15. The two also carry different
 * kinds of money: a claim on a vendor versus a memo valuation of goods that
 * never left the company.
 *
 * So `totals` is returned PER SOURCE, each with its own basis sentence, and
 * there is deliberately no `total_*` field anywhere in this payload and no
 * combined line anywhere in the CSV. If a future edit adds one number that
 * "covers all returns", re-read this block: that number is the bug, and it is
 * exactly the number that gets quoted.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS ROUTE DOES NOT DO
 * ─────────────────────────────────────────────────────────────────────────
 * It is READ-ONLY. There is no POST, no PUT, no repair action, no side effect.
 * It does not move stock, does not touch a ticket's status, and cannot cause a
 * return to be accepted — Store Accept lives on its own route, and this file
 * only reports what that route already did. It reads no setting and changes its
 * answer for nobody.
 *
 * GATE: management only (isManagement — Admin, any Manager, or a HOD), matching
 * /api/reports/issue-log, /api/reports/purchase-log and /api/reports/purchases.
 * Same reason: this joins vendor rates and rupee valuations onto material rows,
 * which is the commercially sensitive content those three are already gated on.
 * The operational surfaces the store and the departments use every day carry
 * their own narrower gates and are untouched, so nobody loses a screen they
 * work on today.
 * ══════════════════════════════════════════════════════════════════════════ */

// A returns report served from cache is a wrong returns report: the answer
// changes the moment a department raises a ticket, an HOD approves one, or the
// store accepts a line and stock actually moves.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The shape test is not enough on its own, and the gap is not theoretical: the
 * regex above happily accepts `2026-13-01` and `2026-02-30`, resolveReturnLogRange
 * then finds them unparseable and falls back, and the caller is handed the last
 * thirty days under the heading they asked for. That is the exact silent
 * substitution this route refuses everywhere else, so the date has to survive a
 * round trip through the calendar as well as the regex.
 *
 * Parsed as UTC deliberately: the input is an IST calendar date string and is
 * only ever compared to other date strings, so no zone conversion may happen to
 * it. A local-time parse would shift the boundary by a day on a non-IST server.
 */
function isRealYmd(v: string): boolean {
  if (!YMD.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * ?source= tokens accepted on the wire, each mapped to the ONE token
 * src/lib/return-log.ts recognises.
 *
 * WHY THIS IS A MAP AND WHY THE UNKNOWN TOKEN IS REJECTED RATHER THAN COERCED:
 * getReturnLog() falls back to 'all' on a token it does not recognise rather
 * than throwing (return-log.ts:698-700). So `?source=vendors` — the plural a
 * human types — would not error; it would quietly return BOTH sources under a
 * heading that says vendor returns only, and the two point in opposite
 * directions. A silent wrong answer is the one failure mode this whole report
 * exists to avoid, so the coercion is caught HERE, at the door, as a 400.
 */
const SOURCES: Record<string, ReturnLogSourceFilter> = {
  all: 'all',
  vendor: 'vendor',
  internal: 'internal',
};

/**
 * ?disposition= tokens — requirement 78's "separate reports" cut. Same story:
 * the lib coerces an unknown value to 'all' (return-log.ts:701-703), so asking
 * for `?disposition=waste` and being handed every reusable line back under a
 * "wastage" heading is a wrong write-off figure, not an empty one.
 */
const DISPOSITIONS: Record<string, ReturnLogDispositionFilter> = {
  all: 'all',
  reusable: 'reusable',
  wastage: 'wastage',
  disposal: 'disposal',
};

/**
 * ?status= is the TICKET's status, matched exactly by the lib. An unrecognised
 * value there is not coerced — it simply matches nothing and renders a page of
 * confident zeros, which is worse than a coercion because it looks like an
 * answer. Validated against the module's own vocabulary so the two cannot
 * drift: a status added to RETURN_STATUSES becomes filterable here for free.
 */
const STATUSES = new Set<string>(RETURN_STATUSES as readonly string[]);

/* ─────────────────────── CSV totals block ───────────────────────────────────
 * returnLogToCsv() serialises the basis banner, the header and the rows — it
 * owns RETURN_LOG_COLUMNS so the download and the screen cannot drift. Handed a
 * BARE ROW ARRAY it deliberately writes NO totals block (return-log.ts:1150-
 * 1167), which is exactly how it is called below: the block is assembled here,
 * out of that same exported column list, so there is ONE totals block in the
 * file and not two contradicting each other.
 */

/** RFC-4180 escaping. Item, vendor, department and reason text carry commas. */
const csvCell = (v: unknown): string => {
  const str = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};

const colIndex = (key: string) => RETURN_LOG_COLUMNS.findIndex(c => c.key === (key as any));

// Resolved from the exported list, never hard-coded. A column inserted in the
// lib silently shifts every one of these, and a total landing one cell left of
// its heading is a wrong number presented as a right one.
const LABEL_COL     = colIndex('source');
const REQ_QTY_COL   = colIndex('purchase_qty');
const ACC_QTY_COL   = colIndex('accepted_purchase_qty');
const QTY_UNIT_COL  = colIndex('purchase_unit');
const REQ_VALUE_COL = colIndex('requested_value');
const ACC_VALUE_COL = colIndex('accepted_value');
const BASIS_COL     = colIndex('value_basis');

/**
 * One full-width CSV row: the caption under the Source heading, and each figure
 * under the very heading it belongs to.
 *
 * The label goes in the SOURCE column, which happens to be column A here. That
 * is safe, and deliberate, for the reason issue-log's equivalent avoided column
 * A: there, column A was Date and a line of prose in it makes Excel abandon
 * date typing for the whole column. On this report Source is text and Date is
 * its own column further right, so the caption costs the reader nothing — and
 * Source is the honest home for it, because these are totals OF a source.
 *
 * Quantities are written into the PURCHASE-unit columns, matching
 * ReturnLogSourceTotal's stated basis and the owner rule that every Purchase
 * and Inventory surface leads with the purchase unit. All the figure columns
 * are marked numeric in the lib, so nothing here is a text-quoted number.
 */
function captionRow(
  label: string,
  fig?: {
    reqQty?: number | null;
    accQty?: number | null;
    unit?: string;
    reqValue?: number | null;
    accValue?: number | null;
    basis?: string;
  },
): string {
  const cells = RETURN_LOG_COLUMNS.map(() => '');
  if (LABEL_COL >= 0) cells[LABEL_COL] = label;
  if (fig) {
    const put = (col: number, v: number | null | undefined) => {
      if (col >= 0 && v !== null && v !== undefined) cells[col] = String(v);
    };
    put(REQ_QTY_COL, fig.reqQty);
    put(ACC_QTY_COL, fig.accQty);
    // The unit rides ONLY when there is a quantity to unit — a stray "kg" beside
    // a withheld figure reads as a quantity of zero kilograms.
    if (
      fig.unit && QTY_UNIT_COL >= 0
      && (fig.reqQty !== null && fig.reqQty !== undefined)
    ) cells[QTY_UNIT_COL] = fig.unit;
    put(REQ_VALUE_COL, fig.reqValue);
    put(ACC_VALUE_COL, fig.accValue);
    if (fig.basis && BASIS_COL >= 0) cells[BASIS_COL] = fig.basis;
  }
  return cells.map(csvCell).join(',');
}

/** `(12 lines)` / `(1 line)` — a caption reading "1 lines" invites a squint. */
const lineCount = (n: number) => `${n} ${n === 1 ? 'line' : 'lines'}`;

/**
 * A source's quantity total is non-null ONLY when a single item is filtered:
 * summing quantities across items adds grams to millilitres to bottles, which
 * the unit canon forbids and no reader could interpret. When it is withheld the
 * caption must SAY so — a blank Qty cell beside a populated line count
 * otherwise reads as "nothing came back".
 */
function qtyClause(t: ReturnLogSourceTotal): string {
  return t.requested_qty === null
    ? ' Quantity totals withheld: they are only meaningful with a single item selected.'
    : '';
}

/** The caption for one source. Its own basis sentence follows it, verbatim. */
function sourceCaption(t: ReturnLogSourceTotal): string {
  return (
    `TOTAL — ${t.source} (${lineCount(t.lines)} across ${t.tickets} `
    + `${t.tickets === 1 ? 'ticket' : 'tickets'}): `
    + `${t.moved_lines} of ${t.lines} lines actually MOVED STOCK — the Store Accept step is the `
    + `only one that moves any, so the rest moved nothing. `
    + `${t.wastage_lines} wastage / ${t.disposal_lines} disposal. `
    + `Money is a ${t.value_basis === 'credit_note' ? 'CREDIT NOTE claim on the vendor' : 'VALUED MEMO'}, `
    + `NOT a spend.${qtyClause(t)}`
  );
}

export async function GET(req: Request) {
  try {
    // Same gate, same wording, as /api/reports/issue-log.
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!isManagement(me)) return Response.json({ error: 'Management only' }, { status: 403 });

    const sp = new URL(req.url).searchParams;
    const rawFrom = sp.get('from');
    const rawTo = sp.get('to');

    // A malformed date is a 400, never a silent fall-back to the default
    // window. resolveReturnLogRange() forgives an unparseable value by design
    // (it serves pages that may pass nothing), so if this route did not check
    // first, `?from=2026-13-01` would answer a question about a month that does
    // not exist with the last thirty days — and a report gets read, signed off
    // and acted on for the wrong period.
    if (rawFrom !== null && !isRealYmd(rawFrom)) {
      return Response.json({ error: `Invalid 'from' date "${rawFrom}" — expected a real YYYY-MM-DD date.` }, { status: 400 });
    }
    if (rawTo !== null && !isRealYmd(rawTo)) {
      return Response.json({ error: `Invalid 'to' date "${rawTo}" — expected a real YYYY-MM-DD date.` }, { status: 400 });
    }
    // Rejected rather than silently swapped, for the same reason: a reversed
    // range is a typo, and answering it as though it were the range asked for
    // hides the typo behind a plausible page of rows.
    if (rawFrom !== null && rawTo !== null && rawFrom > rawTo) {
      return Response.json({ error: `'from' (${rawFrom}) must be on or before 'to' (${rawTo}).` }, { status: 400 });
    }

    // Default window: the last 30 days on the IST calendar, inclusive of today.
    // Resolved HERE through the lib's own exported resolver — the same one
    // purchase-log and issue-log use, so a reader cross-checking a return
    // against its receipt is looking at the same thirty days — and the RESOLVED
    // pair is what gets passed to getReturnLog, echoed in the JSON body and
    // stamped into the CSV filename. One window, provably, in all three places.
    const { from, to } = resolveReturnLogRange(rawFrom, rawTo);

    const rawSource = sp.get('source');
    if (rawSource !== null && !Object.hasOwn(SOURCES, rawSource)) {
      return Response.json(
        { error: `Invalid 'source' "${rawSource}" — expected one of ${Object.keys(SOURCES).join(', ')}.` },
        { status: 400 },
      );
    }
    const source: ReturnLogSourceFilter = rawSource === null ? 'all' : SOURCES[rawSource];

    const rawDisposition = sp.get('disposition');
    if (rawDisposition !== null && !Object.hasOwn(DISPOSITIONS, rawDisposition)) {
      return Response.json(
        { error: `Invalid 'disposition' "${rawDisposition}" — expected one of ${Object.keys(DISPOSITIONS).join(', ')}.` },
        { status: 400 },
      );
    }
    const disposition: ReturnLogDispositionFilter =
      rawDisposition === null ? 'all' : DISPOSITIONS[rawDisposition];

    // '' and the absent parameter both mean "every status"; anything else must
    // be a real one. An empty string is accepted because that is what a cleared
    // <select> posts, and refusing it would 400 the ordinary act of clearing a
    // filter.
    const rawStatus = sp.get('status');
    const status = (rawStatus || '').trim().toLowerCase();
    if (status && !STATUSES.has(status)) {
      return Response.json(
        { error: `Invalid 'status' "${rawStatus}" — expected one of ${[...STATUSES].join(', ')}.` },
        { status: 400 },
      );
    }

    const rawFormat = sp.get('format');
    if (rawFormat !== null && rawFormat !== 'json' && rawFormat !== 'csv') {
      return Response.json({ error: `Invalid 'format' "${rawFormat}" — expected json or csv.` }, { status: 400 });
    }

    const material_id = (sp.get('material_id') || '').trim();
    const department_id = (sp.get('department_id') || '').trim();
    const vendor = (sp.get('vendor') || '').trim();
    const ret_number = (sp.get('ret_number') || '').trim();

    // ONE call for both formats, with identical arguments. The CSV is a
    // rendering of this exact result — never a second, differently-filtered
    // query — which is the only way a download and the screen it was taken from
    // can be guaranteed to agree row for row and total for total.
    const result = getReturnLog({
      from, to, source, material_id, department_id, vendor, status, disposition, ret_number,
    });

    if (rawFormat === 'csv') {
      const t = result.totals;

      // The rows come from the lib (it owns RETURN_LOG_COLUMNS, so the download
      // and the screen cannot disagree about what a column means). Passing the
      // ROW ARRAY rather than the whole result suppresses the lib's own totals
      // block; this one is appended here, in the same column geometry.
      const lines: string[] = [returnLogToCsv(result.rows)];

      lines.push(captionRow(''));
      // ONE CAPTION PER SOURCE, NEVER A SUM OF THEM — the whole point of this
      // report. Each states its own direction on central stock in words,
      // because this file gets mailed on and opened cold in Excel by someone
      // who never saw the page or its labels. If a future edit adds a
      // "TOTAL — ALL RETURNS" row here, it will be adding stock that left the
      // building to stock that came back into it, and calling the difference a
      // quantity.
      lines.push(captionRow(
        'TOTALS PER SOURCE — these move central stock in OPPOSITE directions. DO NOT ADD THEM. '
        + 'There is deliberately no combined figure anywhere in this file.',
      ));
      for (const st of t.by_source) {
        lines.push(captionRow(sourceCaption(st), {
          reqQty: st.requested_qty,
          accQty: st.accepted_qty,
          unit: st.qty_unit,
          reqValue: st.requested_value,
          accValue: st.accepted_value,
          basis: st.value_basis,
        }));
        // The source's own basis sentence, verbatim and on its own line. It is
        // the sentence that says which way this source moves central stock, and
        // paraphrasing it is how the direction gets lost.
        lines.push(captionRow(`    ${st.basis}`));
      }

      lines.push(captionRow(''));
      // A source missing from sources_present returned nothing because the
      // FILTERS exclude it (source=vendor with a department, say), not because
      // no such return happened. Without this line an absent leg reads as a
      // clean sheet.
      lines.push(captionRow(
        `Sources these filters can answer at all: ${t.sources_present.join(' / ') || 'none'}. `
        + `A source absent from that list is missing because the filters exclude it, NOT because nothing happened.`,
      ));
      lines.push(captionRow(
        `Rows in this file: ${t.lines}. Period ${from} to ${to} (IST). Source filter: ${source}. `
        + `Disposition filter: ${disposition}.`
        + (status ? ` Ticket status: ${status}.` : '')
        + (department_id ? ` Department filter applied.` : '')
        + (material_id ? ` Item filter applied.` : '')
        + (vendor ? ` Vendor contains "${vendor}".` : '')
        + (ret_number ? ` Return number ${ret_number}.` : ''),
      ));
      // Verbatim, never paraphrased: it is the guard against the two misreadings
      // that matter — adding the sources together, and reading a pending ticket
      // as a movement — and it is why there is no grand total to print.
      lines.push(captionRow(t.basis));
      if (result.truncated) {
        lines.push(captionRow(
          `!! TRUNCATED — the row limit was reached, so the ROWS in this file are INCOMPLETE. The per-source totals `
          + `above are still correct: they are computed over the full filtered set, not by adding up the rows shown. `
          + `Narrow the date range or filter by item/department and download again.`,
        ));
      }

      // The BOM is added HERE, and only here, so it is emitted EXACTLY ONCE —
      // returnLogToCsv() documents that it deliberately returns a body without
      // one. Without a BOM, Excel on Windows decodes the file as ANSI and the
      // Rs figures, item names and vendor names come out as mojibake. Two BOMs
      // is worse than none: the second is no longer a byte-order mark but
      // ordinary data, so the first cell opens carrying a stray zero-width
      // character and stops matching on any lookup or header compare. If
      // returnLogToCsv is ever changed to emit its own, delete this one in the
      // same commit.
      const csv = '﻿' + lines.join('\r\n');

      return new Response(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${returnLogFilename(from, to)}"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    // Filters are echoed back so a saved or shared JSON response carries the
    // question it answers, not just the answer.
    return Response.json(
      {
        ...result,
        from, to, source, material_id, department_id, vendor, status, disposition, ret_number,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e: any) {
    console.error('[/api/reports/returns]', e);
    return Response.json({ error: e?.message || 'Failed to build return report' }, { status: 500 });
  }
}
