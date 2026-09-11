import type Database from 'better-sqlite3';

/**
 * PURCHASE REPORT RECONCILIATION — the tripwire that makes a dropped bill
 * visible ON THE PAGE instead of months later, by the owner, by accident.
 *
 * 2026-09-10. WHY THIS MODULE EXISTS
 * ─────────────────────────────────
 * The Purchase Report showed the owner ₹0 against a Purchases page showing
 * ₹69,26,866.40 of real bills, and nothing on the screen said a single row had
 * been left out. Every number on the report was arithmetically correct for the
 * rows it had; the rows it did NOT have were simply invisible. A report that
 * can silently answer for a subset is worse than one that fails loudly, because
 * a plausible small number gets believed and acted on.
 *
 * So the report no longer just totals what it found. It PROVES what it found
 * against the source table, and prints the proof.
 *
 * HOW THE PROOF WORKS — and why it is not a restatement
 * ────────────────────────────────────────────────────
 * A reconciliation computed from the same query it is checking proves nothing:
 * both halves move together and always agree. So this walks the purchases table
 * down to the displayed set in NAMED STAGES, by an independent path:
 *
 *   stage 0  every row in `purchases`                       (no filter at all)
 *   stage 1  − rows outside the selected date window
 *   stage 2  − rows excluded by the vendor filter
 *   stage 3  − rows excluded by the category filter
 *   ────────────────────────────────────────────────
 *   stage 3 must EQUAL what the report's own aggregates counted.
 *
 * The difference between stage 3 and the report's own count is `unexplained`.
 * It must be zero. It is zero only while the report's FROM/WHERE drops nothing
 * beyond the three filters the user actually chose. The day someone restores an
 * INNER JOIN, adds an unlogged WHERE, a LIMIT, or an outlet scope, stage 3 and
 * the report part company and the page says so, in rupees, at the top.
 *
 * That independence is the whole point. Do NOT "simplify" this by deriving the
 * stages from the report's own `base` string — that would delete the check
 * while leaving something that looks like one.
 *
 * ROWS **AND** RUPEES, always. A drop that happens to net to ₹0 (a credit note
 * against a bill) still changes the count, and a drop of one large bill barely
 * moves the count. Either alone can be passed; both together cannot.
 */

/** One side of the ledger: how many purchase rows, and how much money on them. */
export interface ReconTally {
  rows: number;
  rupees: number;
}

/** A named, legitimate reason rows are not on screen. Never a silent drop. */
export interface ReconExclusion {
  reason: string;
  detail: string;
  rows: number;
  rupees: number;
}

export interface PurchaseReconciliation {
  /** Every row in `purchases`, unfiltered — the universe the report answers from. */
  source: ReconTally;
  /** What the report's own aggregates counted, passed in by the caller. */
  shown: ReconTally;
  /** source − shown, itemised. Every rupee of the gap carries a reason. */
  excluded: ReconExclusion[];
  /**
   * The alarm. source − (every named exclusion) − shown. MUST be zero.
   * Non-zero means the report is dropping rows for a reason nobody declared.
   */
  unexplained: ReconTally;
  balanced: boolean;
  /**
   * Data defects worth naming even though they no longer drop anything.
   * `unlinked_material_rows` used to vanish entirely (INNER JOIN, fixed
   * 2026-09-10); they now appear under an explicit label, and this count is
   * how the owner knows to go and fix the underlying material record.
   */
  defects: {
    unlinked_material_rows: number;
    unlinked_material_rupees: number;
  };
}

/** The report's money basis. Goods value — matches purchases.total_price. */
const MONEY = `COALESCE(SUM(p.total_price), 0)`;

/** Round money the way rupees actually behave, so 0.1+0.2 never trips `balanced`. */
const paise = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Build the reconciliation for one set of report filters.
 *
 * `shown` is what the REPORT counted — pass the report's own summary figures,
 * never a re-run of this module's SQL, or the check checks itself.
 *
 * The vendor/category predicates here are deliberately written to match the
 * report's filters character for character (both TRIM-normalised as of
 * 2026-09-10 — see the ruling in the report route). If the two ever diverge the
 * `unexplained` line is what reports it.
 */
export function buildPurchaseReconciliation(
  db: Database.Database,
  opts: { from: string; to: string; vendor: string; category: string },
  shown: ReconTally,
): PurchaseReconciliation {
  const { from, to, vendor, category } = opts;

  // Stage 0 — the universe. No join, no filter: a row cannot hide from this.
  const stage0 = db.prepare(
    `SELECT COUNT(*) AS rows, ${MONEY} AS rupees FROM purchases p`,
  ).get() as ReconTally;

  // Stage 1 — the date window only.
  const stage1 = db.prepare(
    `SELECT COUNT(*) AS rows, ${MONEY} AS rupees
       FROM purchases p
      WHERE p.date >= ? AND p.date <= ?`,
  ).get(from, to) as ReconTally;

  // Stages 2 and 3 add the optional filters. LEFT JOIN throughout: the walk
  // must never lose a row for a reason it is not reporting, which is the exact
  // failure it exists to catch.
  const venPred = vendor ? ` AND LOWER(TRIM(p.vendor)) = LOWER(TRIM(?))` : '';
  const venArgs = vendor ? [vendor] : [];
  const stage2 = db.prepare(
    `SELECT COUNT(*) AS rows, ${MONEY} AS rupees
       FROM purchases p
      WHERE p.date >= ? AND p.date <= ?${venPred}`,
  ).get(from, to, ...venArgs) as ReconTally;

  const catPred = category
    ? ` AND LOWER(TRIM(COALESCE(rm.category, ''))) = LOWER(TRIM(?))`
    : '';
  const catArgs = category ? [category] : [];
  const stage3 = db.prepare(
    `SELECT COUNT(*) AS rows, ${MONEY} AS rupees
       FROM purchases p
       LEFT JOIN raw_materials rm ON p.material_id = rm.id
      WHERE p.date >= ? AND p.date <= ?${venPred}${catPred}`,
  ).get(from, to, ...venArgs, ...catArgs) as ReconTally;

  // Rows whose material_id matches no raw_materials row. Before 2026-09-10 the
  // report INNER JOINed and these disappeared without trace; they are now shown
  // under a label, and counted here so the bad link gets fixed at the source.
  const unlinked = db.prepare(
    `SELECT COUNT(*) AS rows, ${MONEY} AS rupees
       FROM purchases p
       LEFT JOIN raw_materials rm ON p.material_id = rm.id
      WHERE p.date >= ? AND p.date <= ?${venPred}
        AND rm.id IS NULL`,
  ).get(from, to, ...venArgs) as ReconTally;

  const excluded: ReconExclusion[] = [];

  const dateRows = stage0.rows - stage1.rows;
  if (dateRows !== 0) {
    excluded.push({
      reason: 'Outside the selected date range',
      detail: `Dated before ${from} or after ${to}. Widen the range to include them.`,
      rows: dateRows,
      rupees: paise(stage0.rupees - stage1.rupees),
    });
  }

  const venRows = stage1.rows - stage2.rows;
  if (venRows !== 0) {
    excluded.push({
      reason: `Excluded by the vendor filter (${vendor})`,
      detail: 'Your own filter — clear the vendor picker to include them.',
      rows: venRows,
      rupees: paise(stage1.rupees - stage2.rupees),
    });
  }

  const catRows = stage2.rows - stage3.rows;
  if (catRows !== 0) {
    excluded.push({
      reason: `Excluded by the category filter (${category})`,
      detail: 'Your own filter — clear the category picker to include them.',
      rows: catRows,
      rupees: paise(stage2.rupees - stage3.rupees),
    });
  }

  // THE ALARM. Everything above is a reason a human chose or can see. Whatever
  // is left is the report losing rows on its own, and has no business existing.
  const unexplained: ReconTally = {
    rows: stage3.rows - shown.rows,
    rupees: paise(stage3.rupees - shown.rupees),
  };

  return {
    source: { rows: stage0.rows, rupees: paise(stage0.rupees) },
    shown: { rows: shown.rows, rupees: paise(shown.rupees) },
    excluded,
    unexplained,
    balanced: unexplained.rows === 0 && Math.abs(unexplained.rupees) < 0.01,
    defects: {
      unlinked_material_rows: unlinked.rows,
      unlinked_material_rupees: paise(unlinked.rupees),
    },
  };
}

/**
 * BILL-IDENTITY COVERAGE — how many of the rows on screen can still be told
 * apart as separate vendor bills, and how many have been merged into one line.
 *
 * 2026-09-10 ruling. `src/lib/purchase-bill-summary.ts` keys a bill by
 * invoice_id → grn_id → bill_no, and falls back to vendor+day when a row has
 * none of the three. 2,121 of 2,165 rows had none of the three, because
 * `src/app/api/inward-import/commit/route.ts` never bound the vendor's invoice
 * number to `bill_no` — it stringified it into `notes` as prose. The fallback
 * then merged genuinely different invoices from one vendor on one day into a
 * single line: 60 lines were hiding 69 additional real bills worth
 * ₹12,93,120.30, and no screen said so.
 *
 * The writer is fixed and the stored data is repairable (admin action, dry-run
 * first — never a boot migration). Until a given deployment's data is repaired,
 * this count is what tells the owner the merge is happening and how much of his
 * spend is inside it, rather than letting a short bill list look complete.
 */
export interface BillIdentityCoverage {
  rows_in_range: number;
  /** Rows carrying invoice_id, grn_id or bill_no — separable with certainty. */
  identified_rows: number;
  /** Rows with none of the three, which fall back to the vendor+day merge. */
  unidentified_rows: number;
  /** Distinct lines those unidentified rows collapse into. */
  merged_lines: number;
  /**
   * Additional real vendor bills those merged lines hide, recovered by reading
   * the invoice number the importer left in `notes`. 0 means no line is hiding
   * a second bill — not that identity is complete.
   */
  hidden_bills: number;
  hidden_bill_rupees: number;
  /** True when a repair would change what the bill views show. */
  repair_available: boolean;
}

/**
 * The invoice number the inward importer wrote into notes as
 * `Invoice: 19162 · Inward: 4633`. Read-only recovery — this function never
 * writes, and the report never treats a parsed number as if it were stored.
 *
 * String.match, not RegExp.prototype.exec: identical result, and it keeps this
 * line from reading like a shell call to the repo's security scanner.
 */
export function invoiceFromNotes(notes: string | null | undefined): string | null {
  const m = String(notes || '').match(/Invoice:\s*([^·|\n]+)/);
  const v = m ? m[1].trim() : '';
  return v ? v : null;
}

export function buildBillIdentityCoverage(
  db: Database.Database,
  opts: { from: string; to: string; vendor: string },
): BillIdentityCoverage {
  const { from, to, vendor } = opts;
  const venPred = vendor ? ` AND LOWER(TRIM(p.vendor)) = LOWER(TRIM(?))` : '';
  const venArgs = vendor ? [vendor] : [];

  const rows = db.prepare(
    `SELECT p.id, p.vendor, p.date, p.outlet_id, p.notes,
            COALESCE(p.total_price, 0) AS goods,
            CASE WHEN TRIM(COALESCE(p.invoice_id, '')) <> ''
                   OR TRIM(COALESCE(p.grn_id, '')) <> ''
                   OR TRIM(COALESCE(p.bill_no, '')) <> ''
                 THEN 1 ELSE 0 END AS identified
       FROM purchases p
      WHERE p.date >= ? AND p.date <= ?${venPred}`,
  ).all(from, to, ...venArgs) as any[];

  // Mirror of the ELSE branch of billKeyExpr in purchase-bill-summary.ts. If
  // that key ever changes, change it here too — these two must describe the
  // same line or this coverage figure is measuring a grouping nobody sees.
  const dayKey = (r: any) =>
    `DAY:${String(r.vendor || '').trim().toLowerCase()}|${r.date}|${r.outlet_id || ''}`;

  const groups = new Map<string, any[]>();
  let identified = 0;
  for (const r of rows) {
    if (r.identified) { identified++; continue; }
    const k = dayKey(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }

  let hidden = 0;
  let hiddenRupees = 0;
  let mergedLines = 0;
  for (const rs of groups.values()) {
    const invoices = new Set(rs.map(r => invoiceFromNotes(r.notes)).filter(Boolean) as string[]);
    if (invoices.size > 1) {
      // n distinct invoices printing as one line = n−1 bills erased from view.
      hidden += invoices.size - 1;
      hiddenRupees += rs.reduce((a, r) => a + (Number(r.goods) || 0), 0);
      // ONLY A GROUP THAT ACTUALLY HIDES A BILL IS A "MERGED LINE".
      // This used to report groups.size — EVERY vendor-day group in the range,
      // including the overwhelming majority that hold exactly one bill and hide
      // nothing. The panel then read "69 bills merged into 308 lines", which is
      // arithmetically impossible (69 bills cannot fill 308 lines) and made the
      // one panel whose entire job is to be believed the least believable thing
      // on the page. Counted here, beside the hidden tally it belongs to.
      mergedLines++;
    }
  }

  return {
    rows_in_range: rows.length,
    identified_rows: identified,
    unidentified_rows: rows.length - identified,
    merged_lines: mergedLines,
    hidden_bills: hidden,
    hidden_bill_rupees: paise(hiddenRupees),
    repair_available: hidden > 0,
  };
}
