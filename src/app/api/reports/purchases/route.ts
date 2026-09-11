import { getDb } from '@/lib/db';
import { getCurrentUser, isManagement } from '@/lib/auth';
import {
  buildPurchaseReconciliation, buildBillIdentityCoverage,
} from '@/lib/purchase-reconciliation';
import {
  effectiveChargeSumsSql, chargeSourceCountsSql, grnLineJoinSql, withGrnCharges,
  chargeSums, PURCHASE_CHARGE_COLUMNS,
} from '@/lib/purchase-charges';
// The span of dates that actually have purchases, and the window that covers
// all of them. Shared with /api/reports/purchase-bill-summary so the two
// reports can never disagree about what "all time" means. See the block comment
// on getPurchaseDateSpan() for why the SQL is shaped the way it is.
import { getPurchaseDateSpan, resolveAllTimePurchaseRange } from '@/lib/purchase-bill-summary';

/**
 * Purchase Report API (management only). GET /api/reports/purchases?from=&to=&vendor=&category=
 *
 * Aggregates purchase SPEND (purchases.total_price = invoice amount) over a
 * YYYY-MM-DD date range, broken down by vendor, category, super-category, month,
 * payment mode, and item. Mirrors the Purchases page data set (LEFT JOIN
 * raw_materials, no outlet scoping) so the report totals reconcile with what
 * /purchases shows.
 *
 * Returns JSON only; the page builds CSV client-side from these aggregates.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 2026-09-10 — THIS REPORT WAS DROPPING BILLS AND UNDERSTATING TAX. Six rulings,
 * all live below. Do not revert any of them without reading the reason first;
 * three of the six currently drop nothing on this data set and will look like
 * dead code — they are the silent failure modes, not the dead ones.
 *
 *  1. LEFT JOIN, not JOIN (line ~60). A purchase row whose material_id matches
 *     no raw_materials row used to vanish from every figure on this page — no
 *     count, no rupee, no warning. It now appears under an explicit
 *     "(material not linked …)" label and is counted in
 *     reconciliation.defects.unlinked_material_rows. Measured on the live copy
 *     the day of the fix: 0 orphans, so this changes no number today. It is
 *     kept because the failure mode is SILENT — the day one appears, the old
 *     code loses the money without telling anyone. Every sibling report
 *     (purchase-log, issue-log, return-log, menu-recipe-gap) was already LEFT;
 *     this route was the only INNER JOIN in the reports layer.
 *
 *  2. FILTERS COMPARE TRIMMED (lines ~53-56). The vendor and category filters
 *     matched raw column text while the dropdowns that populate them are built
 *     from TRIM(...) — so a vendor stored as "HYPERPURE " could be offered in
 *     the picker and then match nothing, emptying the report. 0 rows carry
 *     stray whitespace today; the mismatch was real and is now impossible.
 *
 *  3. RECONCILIATION IS RETURNED, ALWAYS (line ~150). Rows and rupees shown vs
 *     rows and rupees in `purchases`, with every difference named. This is the
 *     part that makes a future regression visible ON THE PAGE. See
 *     src/lib/purchase-reconciliation.ts for why it is computed by an
 *     independent path and must stay that way.
 *
 *  4. BILL CHARGES ARE SELECTED (line ~75). The eight recorded-only charge
 *     columns already existed on `purchases` and were already surfaced by
 *     /api/reports/purchase-log; this route selected none of them, so the
 *     report's "spend" was goods value only. They are returned ALONGSIDE the
 *     existing totals as `charges` and `total_amount` — never folded into
 *     `total_spend`, because every existing figure on this page had to keep
 *     rendering byte-identically.
 *
 *     2026-09-11 — WHAT THE SUMMARY TAB CALLS THESE FIGURES. The owner asked for
 *     a subtotal and a grand total in plain words, so the two that were already
 *     being returned are now LABELLED as what they are. The JSON did not change:
 *       `bill_value`   → printed as SUBTOTAL    — the goods/ingredients as billed.
 *       `total_amount` → printed as GRAND TOTAL — Subtotal − discount + every
 *                        charge; what is payable to the vendor.
 *       `total_spend`  → printed as SPEND (booked cost) — UNCHANGED and still
 *                        goods-only. It is not the Subtotal and must never be
 *                        folded into, or replaced by, either of the other two:
 *                        stock valuation is built on it, and
 *                        scripts/purchase-charges-tests.js asserts
 *                        summary.bill_value − summary.total_spend is exactly the
 *                        discount netted into PO-receipt rates (₹1,620 today).
 *     This is a labelling change on the page. No SQL below moved.
 *
 *     2026-09-11, SAME DAY, SECOND PASS — TWO THINGS THE LABELLING EXPOSED, both
 *     fixed on the page and neither of them SQL:
 *
 *       a. THE SUMMARY CARD STRIP DID NOT ADD UP. It rendered Subtotal, Taxes,
 *          Cess, Transport, Round-off and Grand Total — no Discount card and no
 *          TCS card — so the five money cards left of the Grand Total summed to
 *          ₹69,36,465.60 against a Grand Total of ₹69,34,193.60, out by the
 *          ₹2,280 discount less the ₹8 TCS. Both were already on the wire and
 *          simply had no card. Eight cards now, in formula order, Discount
 *          rendered negative so the strip is a running sum.
 *       b. THE PURCHASE-LOG TAB'S BRIDGING SENTENCE WAS WRONG. It told the owner
 *          the log's Goods value / Total Amount were this tab's Subtotal / Grand
 *          Total — "the same arithmetic". Measured over the same window and the
 *          same 2,165 lines: the log's Goods value equals TOTAL_SPEND (₹1,620
 *          from the Subtotal) and its Total Amount is ₹5,402.20 BELOW the Grand
 *          Total, because the log sums the charge columns stored on each
 *          `purchases` row while this route reads a PO receipt's charges off the
 *          GRN line. Both tabs share one date range, so the owner flipped
 *          between two different answers to "what do we owe" having been assured
 *          they could not differ. The sentence now names the direction and the
 *          cause and prints no rupee figure, because the gap moves with the
 *          window and that component cannot see this route's totals.
 *
 *     ⚠ STILL OPEN, DELIBERATELY: the Purchase-log tab's own CSV headings are
 *     built in /api/reports/purchase-log, which belongs to another lane, so the
 *     screen and the file it downloads still use different words for one column.
 *     Closing that needs that route, not this one.
 *
 *  5. 2026-09-10 (second pass) — THE CHARGES ARE ON EVERY BREAKDOWN, NOT JUST
 *     THE SUMMARY. Ruling 4 put the eight sums on the period total only, so the
 *     owner could see "₹562.50 CGST this year" and had no way to ask WHICH
 *     vendor, WHICH month or WHICH item it came from. Every breakdown now
 *     carries the same eight sums, the same `total_amount`, and the row counts
 *     the tax-on-GRN rule needs. Three properties hold and are proved by
 *     scripts/purchase-charges-tests.js against the real database:
 *
 *       · Σ(breakdown rows) === summary, per charge, to the paisa, for EVERY
 *         breakdown. A blank cell contributes 0 and can only be blank when the
 *         stored figure is 0 (see chargeCell in src/lib/purchase-charges.ts),
 *         so a blank can never hide money.
 *       · `spend` / `count` on every row are UNCHANGED — same SQL, same order.
 *         The CSVs a user already has keep their columns in their old places
 *         because the new ones are APPENDED on the right, never inserted.
 *       · The eight sums and total_amount come from ONE shared SQL fragment
 *         (src/lib/purchase-charges.ts), the same expression the bill views
 *         and the purchase log use, so the three reports cannot drift.
 *
 *  6. 2026-09-10 (third pass) — THE CHARGES WERE READ OFF THE WRONG TABLE.
 *     Rulings 4 and 5 summed `purchases.cgst` and friends. On a PO-receive row
 *     those columns are the receive route's placeholder ZEROS: the bill's
 *     charges are stored on the GRN LINE. So the report printed ₹562.50 CGST
 *     for August 2026 when the bills carried ₹2,178.90 + the ₹562.50 on the
 *     ordinary rail, and the em-dash rule that was supposed to admit this fired
 *     only when 100% of a group's rows were mirrors — 0 of 4 months, 0 of 8
 *     categories, 0 of 5 super-categories, 0 of 1 payment modes. Four
 *     breakdowns printed a confident number roughly 4× short with no badge, no
 *     dash and no footnote.
 *
 *     Every charge is now read from where it is actually recorded, via the
 *     grn_line CTE in src/lib/purchase-charges.ts, and `bill_value` rides
 *     alongside so Total Amount stays footable. Consequences, all deliberate:
 *
 *       · TOTAL AMOUNT NOW EQUALS THE GRN INWARD REGISTER, per bill, to the
 *         paisa. Before: register ₹30,732.20 vs report ₹25,330.00 over the 29
 *         GRN-sourced bills, 28 of them individually wrong. The two screens
 *         quoted different tax for the same document.
 *       · SPEND AND COUNT ARE STILL UNTOUCHED on every row of every breakdown.
 *         Same SQL, same GROUP BY, same ORDER BY. Only the charge columns and
 *         the two new ones changed.
 *       · The disclosure fires on ANY GRN-sourced row, not only on an
 *         all-mirror group — that all-or-nothing predicate is what made the
 *         four breakdowns silent.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const isYmd = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

export async function GET(req: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!isManagement(me)) return Response.json({ error: 'Management only' }, { status: 403 });

    const url = new URL(req.url);

    /**
     * range=all — "show me every purchase", asked for by name.
     *
     * THE ORDERING PROBLEM, AND WHY IT IS SOLVED HERE AND NOT ON THE PAGE.
     * The page wants to open on the whole book, but it cannot know the first
     * purchase date until something has queried for it — and a round trip spent
     * learning the dates, followed by a second one fetching the report, would
     * double every first load. So the caller says WHICH WINDOW IT WANTS rather
     * than WHICH DATES, the server resolves it against the data, and the
     * resolved real dates come back in the `from`/`to` this response already
     * echoed. One request, one answer, and the dates the page then displays are
     * the dates the report was actually built from.
     *
     * An explicit parameter rather than "omit from/to": the 400 below is
     * deliberate, and a caller that simply drops a parameter must keep getting
     * it rather than silently receiving the entire history.
     */
    const wantAll = url.searchParams.get('range') === 'all';
    const allTime = wantAll ? resolveAllTimePurchaseRange() : null;
    const from = allTime ? allTime.from : url.searchParams.get('from');
    const to = allTime ? allTime.to : url.searchParams.get('to');
    if (!isYmd(from) || !isYmd(to)) {
      return Response.json({ error: 'from and to (YYYY-MM-DD) are required' }, { status: 400 });
    }
    if (from > to) return Response.json({ error: 'from must be on or before to' }, { status: 400 });
    /**
     * Returned on EVERY response, not only on range=all: when a hand-picked
     * window comes back empty, the page needs to be able to say which dates do
     * have purchases. Two index seeks — see getPurchaseDateSpan().
     */
    const data_range = allTime ? allTime.span : getPurchaseDateSpan();
    const vendor = (url.searchParams.get('vendor') || '').trim();
    const category = (url.searchParams.get('category') || '').trim();

    const db = getDb();

    // Shared WHERE + params for every aggregate (date range + optional filters).
    //
    // RULING 2 (2026-09-10): both optional filters compare TRIM'd on BOTH sides.
    // The dropdowns feeding them are built from TRIM(vendor) / TRIM(category)
    // below, so an untrimmed comparison here could offer the user a value that
    // then matches zero rows and empties the whole report with no explanation.
    const where: string[] = ['p.date >= ?', 'p.date <= ?'];
    const params: any[] = [from, to];
    if (vendor) { where.push('LOWER(TRIM(p.vendor)) = LOWER(TRIM(?))'); params.push(vendor); }
    if (category) { where.push('LOWER(TRIM(COALESCE(rm.category, \'\'))) = LOWER(TRIM(?))'); params.push(category); }
    const W = where.join(' AND ');

    // RULING 1 (2026-09-10): LEFT JOIN. An unlinked material must cost the row
    // its NAME, never its existence. See the header. If you change this line,
    // `reconciliation.unexplained` starts reporting the rows you lose.
    //
    // RULING 6 (2026-09-10): the grn_line LEFT JOIN rides in the SAME base, so
    // every aggregate on this page sees the charges on the same rows it counts.
    // It CANNOT fan out — grn_line is keyed 1:1 on purchase_id by construction
    // (see grnChargeCteSql) — which is what lets `spend` and `count` stay
    // byte-identical while the charge columns change underneath them.
    const base = `FROM purchases p
        LEFT JOIN raw_materials rm ON p.material_id = rm.id
        ${grnLineJoinSql('p', 'gl')}
       WHERE ${W}`;

    /**
     * RULING 4 (2026-09-10): the eight recorded-only bill charges, summed with
     * exactly the arithmetic src/lib/purchase-bill-summary.ts uses per line, so
     * this report's "total amount" and the bill views' cannot drift.
     * `total_spend` above deliberately stays goods-value-only.
     *
     * RULING 5: the expression is no longer written out here. It lives in
     * src/lib/purchase-charges.ts, is imported by this route, by the page that
     * renders it and by the CSV builder, and is the SAME text this report, the
     * bill summary and the purchase log all sum. Do not inline it again to
     * "avoid an import" — the four earlier copies of this arithmetic are the
     * reason a fifth would have gone unnoticed when one of them changed.
     *
     * RULING 6: the sums read the EFFECTIVE rail — the GRN line for a PO-receipt
     * mirror, the `purchases` column for everything else. Summing `p.cgst`
     * directly here is the bug this replaced; it is only ever the placeholder
     * zero on a receive row.
     *
     * The three source counts ride along on every aggregate so the renderer and
     * the CSV can say where a figure came from without a second query:
     * `po_receipt_rows`, `grn_sourced_rows` (drives the badge and the footnote)
     * and `unpaired_mirror_rows` (a mirror whose GRN line is gone — the one
     * case that still blanks a cell instead of printing ₹0).
     */
    const CHARGES = `
        ${effectiveChargeSumsSql('p', 'gl')},
        ${chargeSourceCountsSql('p', 'gl')}`;

    /**
     * Every statement below is wrapped in the grn_line CTE. It is prepared once
     * per statement and better-sqlite3 caches the plan; the CTE is a 31-row
     * pairing over an indexed column and does not change the shape of any
     * aggregate.
     */
    const q = (sql: string) => db.prepare(withGrnCharges(sql));

    const summary = q(`
      SELECT
        COUNT(*)                                        AS purchase_count,
        COALESCE(SUM(p.total_price), 0)                 AS total_spend,
        COUNT(DISTINCT p.vendor)                        AS vendor_count,
        COUNT(DISTINCT p.material_id)                   AS item_count,
        COUNT(DISTINCT p.date)                          AS day_count,
        COALESCE(SUM(CASE WHEN p.is_emergency = 1 THEN p.total_price ELSE 0 END), 0) AS emergency_spend,
        COALESCE(SUM(CASE WHEN p.is_emergency = 1 THEN 1 ELSE 0 END), 0)             AS emergency_count,
        ${CHARGES}
      ${base}
    `).get(...params) as any;

    // Every breakdown below selects `spend` and `count` EXACTLY as it always
    // did — same expression, same alias, same GROUP BY, same ORDER BY — and
    // then appends ${CHARGES}. That is what keeps the existing figures and the
    // existing CSV columns byte-identical while the new ones arrive beside them.
    const by_vendor = q(`
      SELECT COALESCE(NULLIF(TRIM(p.vendor), ''), '(no vendor)') AS vendor,
             COALESCE(SUM(p.total_price), 0) AS spend, COUNT(*) AS count,
             ${CHARGES}
      ${base} GROUP BY LOWER(TRIM(p.vendor)) ORDER BY spend DESC
    `).all(...params) as any[];

    // GROUP BY the COALESCE'd value, not the raw column. 2026-09-10: with the
    // LEFT JOIN above, an unlinked material yields rm.category = NULL, and SQL
    // groups NULL separately from '' — so the page printed TWO rows both
    // labelled "(uncategorised)" / "(none)" with different money in each. Caught
    // by looking at the rendered page, not by the type checker. The label and
    // the GROUP BY key must normalise identically or the bucket splits.
    const by_category = q(`
      SELECT COALESCE(NULLIF(TRIM(rm.category), ''), '(uncategorised)') AS category,
             COALESCE(SUM(p.total_price), 0) AS spend, COUNT(*) AS count,
             ${CHARGES}
      ${base} GROUP BY LOWER(TRIM(COALESCE(rm.category, ''))) ORDER BY spend DESC
    `).all(...params) as any[];

    const by_super_category = q(`
      SELECT COALESCE(NULLIF(TRIM(rm.super_category), ''), '(none)') AS super_category,
             COALESCE(SUM(p.total_price), 0) AS spend, COUNT(*) AS count,
             ${CHARGES}
      ${base} GROUP BY LOWER(TRIM(COALESCE(rm.super_category, ''))) ORDER BY spend DESC
    `).all(...params) as any[];

    const by_month = q(`
      SELECT substr(p.date, 1, 7) AS month,
             COALESCE(SUM(p.total_price), 0) AS spend, COUNT(*) AS count,
             ${CHARGES}
      ${base} GROUP BY substr(p.date, 1, 7) ORDER BY month ASC
    `).all(...params) as any[];

    const by_payment_mode = q(`
      SELECT COALESCE(NULLIF(TRIM(p.payment_mode), ''), '(unspecified)') AS payment_mode,
             COALESCE(SUM(p.total_price), 0) AS spend, COUNT(*) AS count,
             ${CHARGES}
      ${base} GROUP BY LOWER(TRIM(COALESCE(p.payment_mode, ''))) ORDER BY spend DESC
    `).all(...params) as any[];

    // Item-wise report — EVERY item purchased in the range (grouped by material),
    // with weighted avg purchase rate (₹/purchase-unit) and last-purchased date.
    //
    // material_name carries the LEFT-JOIN label (ruling 1). A row whose material
    // record is gone still reports its spend, under a name that says exactly what
    // is wrong and quotes the id to fix it by — never under a blank, and never
    // omitted. `unlinked` lets the page flag the row instead of the reader having
    // to notice the label.
    const by_item = q(`
      SELECT COALESCE(NULLIF(TRIM(rm.name), ''),
                      '(material not linked · id ' || COALESCE(p.material_id, '?') || ')') AS material_name,
             CASE WHEN rm.id IS NULL THEN 1 ELSE 0 END AS unlinked,
             COALESCE(NULLIF(TRIM(rm.category), ''), '(uncategorised)') AS category,
             rm.purchase_unit AS unit,
             COALESCE(SUM(p.quantity), 0)    AS qty,
             COALESCE(SUM(p.total_price), 0) AS spend,
             COUNT(*)                        AS count,
             CASE WHEN SUM(p.quantity) > 0 THEN SUM(p.total_price) / SUM(p.quantity) ELSE 0 END AS avg_rate,
             MAX(p.date)                     AS last_date,
             ${CHARGES}
      ${base} GROUP BY p.material_id ORDER BY spend DESC
    `).all(...params) as any[];

    /**
     * ROUND THE MONEY ONCE, HERE, ON EVERY ROW AND ON THE SUMMARY.
     *
     * SUM() over SQLite REALs returns things like 562.5000000000001, and the
     * screen would print ₹562.5 while the CSV carried the long tail — two
     * different-looking answers to the same question. Rounding at the boundary
     * means the JSON, the table, the footer and the file are the same figure.
     *
     * `spend`, `count`, `qty`, `avg_rate` and `last_date` are NOT touched: they
     * are the pre-existing figures and had to stay byte-identical.
     */
    const withCharges = <T extends Record<string, any>>(rows: T[]): T[] =>
      rows.map(r => ({
        ...r,
        ...chargeSums(r),
        // Counts, not money — coerced to plain integers so the page can compare
        // them without Number() at every call site.
        po_receipt_rows: Number(r.po_receipt_rows) || 0,
        grn_sourced_rows: Number(r.grn_sourced_rows) || 0,
        unpaired_mirror_rows: Number(r.unpaired_mirror_rows) || 0,
      }));

    /**
     * `count` is aliased onto the summary from `purchase_count` so the SAME
     * predicates that decide a breakdown row's badge and note (which key on
     * `count`) work on the period figure without a second, differently-named
     * code path. The two would otherwise disagree about the period.
     */
    const summaryOut = {
      ...summary,
      ...chargeSums(summary),
      count: Number(summary?.purchase_count) || 0,
      po_receipt_rows: Number(summary?.po_receipt_rows) || 0,
      grn_sourced_rows: Number(summary?.grn_sourced_rows) || 0,
      unpaired_mirror_rows: Number(summary?.unpaired_mirror_rows) || 0,
    };
    const vendorRows = withCharges(by_vendor);
    const categoryRows = withCharges(by_category);
    const superCategoryRows = withCharges(by_super_category);
    const monthRows = withCharges(by_month);
    const paymentRows = withCharges(by_payment_mode);
    const itemRows = withCharges(by_item);

    /**
     * THE FOOTER MUST FOOT — checked here, on the server, on every request,
     * against every breakdown, and SHIPPED so the page can say so out loud.
     *
     * Each breakdown is an independent GROUP BY; the summary is an independent
     * aggregate over the same WHERE. Nothing guarantees they agree except that
     * they are correct, so this compares them instead of assuming. Any
     * mismatch names the breakdown and the charge, in paise.
     */
    const charge_footing: { breakdown: string; charge: string; rows: number; summary: number }[] = [];
    // bill_value is checked too: it is the base Total Amount is built on, so a
    // breakdown that footed on the eight charges but not on the base would
    // still be printing an unfootable total.
    const FOOT_KEYS = [
      ...PURCHASE_CHARGE_COLUMNS.map(c => c.key),
      'bill_value' as const, 'total_amount' as const,
    ];
    for (const [name, rows] of [
      ['by_vendor', vendorRows], ['by_category', categoryRows],
      ['by_super_category', superCategoryRows], ['by_month', monthRows],
      ['by_payment_mode', paymentRows], ['by_item', itemRows],
    ] as const) {
      for (const k of FOOT_KEYS) {
        const sum = Math.round(rows.reduce((s, r) => s + (Number((r as any)[k]) || 0), 0) * 100);
        const tot = Math.round((Number((summaryOut as any)[k]) || 0) * 100);
        if (sum !== tot) charge_footing.push({ breakdown: name, charge: k, rows: sum / 100, summary: tot / 100 });
      }
    }

    // Filter dropdown options (all-time, so the pickers are stable across ranges).
    const vendors = (db.prepare(`
      SELECT DISTINCT TRIM(vendor) AS v FROM purchases WHERE TRIM(vendor) <> '' ORDER BY v COLLATE NOCASE
    `).all() as any[]).map(r => r.v);
    const categories = (db.prepare(`
      SELECT DISTINCT TRIM(category) AS c FROM raw_materials WHERE TRIM(category) <> '' ORDER BY c COLLATE NOCASE
    `).all() as any[]).map(r => r.c);

    /**
     * RULING 3 (2026-09-10): PROVE THE NUMBERS BEFORE RETURNING THEM.
     *
     * `shown` is the report's OWN summary — the same object the page renders —
     * so the reconciliation is checking the delivered figures, not a re-run.
     * The stage walk it compares against lives in a separate module and never
     * touches `base`; that separation is what gives the check teeth.
     */
    const reconciliation = buildPurchaseReconciliation(
      db,
      { from, to, vendor, category },
      { rows: Number(summary?.purchase_count) || 0, rupees: Number(summary?.total_spend) || 0 },
    );

    // How much of this range can still be told apart as separate vendor bills.
    // Vendor-scoped only: a category filter selects ITEMS, and half a bill's
    // lines is not a bill, so bill identity is not meaningful under it.
    const bill_identity = buildBillIdentityCoverage(db, { from, to, vendor });

    return Response.json({
      from, to, vendor, category,
      // The first and last dates purchases actually exist on. The page opens on
      // this window and, when a narrower one comes back empty, names it.
      data_range,
      summary: summaryOut,
      by_vendor: vendorRows,
      by_category: categoryRows,
      by_super_category: superCategoryRows,
      by_month: monthRows,
      by_payment_mode: paymentRows,
      by_item: itemRows,
      vendors, categories,
      reconciliation, bill_identity,
      // Empty = every breakdown foots to the summary on every charge. Non-empty
      // is a defect in THIS report and the page says so in red.
      charge_footing,
    });
  } catch (e: any) {
    console.error('[/api/reports/purchases]', e);
    return Response.json({ error: e?.message || 'Failed to build purchase report' }, { status: 500 });
  }
}
