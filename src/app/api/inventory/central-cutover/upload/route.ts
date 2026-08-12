import { getDb } from '@/lib/db';
import { getOpenDraft, getBatch, stageLines, listLines, CutoverError } from '@/lib/central-cutover';
import { requireStager, denied, cutoverError } from '../_lib/guards';
import { parseCountUpload, readCsvBody, MAX_UPLOAD_ROWS } from '../_lib/count-sheet';

/**
 * UPLOAD A FILLED COUNT SHEET.
 *
 *   POST /api/inventory/central-cutover/upload
 *     multipart/form-data  file=<csv> [batch_id=...]
 *     application/json     { csv: "...", batch_id?: "..." }
 *     text/csv             the raw body (batch_id via ?batch_id=)
 *
 * Admin / store manager / management. Writes counts onto the DRAFT only —
 * stock does not move until an admin commits.
 *
 * FORGIVING ON SHAPE, STRICT ON MEANING. Column order, extra columns, renamed
 * columns, blank rows, CRLF and a BOM are all tolerated (see _lib/count-sheet).
 * Every value judgement stays in the engine: whether a cell is a number, is
 * negative, or names a knowable unit is answered once, in parseCountedQty and
 * resolveCountBasis, and never a second time here.
 *
 * A BLANK COUNT CELL MEANS NOT COUNTED. Those rows are dropped before staging
 * and returned as a COUNT (`skipped_no_count`), not as errors: on a partial
 * sheet most rows are blank, and passing them through would bury the handful of
 * real problems under hundreds of 'blank' rejections. A material with no line
 * is left completely untouched by the commit — a blank never becomes a zero.
 *
 * ROW NUMBERS ARE FILE LINE NUMBERS. stageLines reports the index within the
 * array it was given; that is remapped here to the line the operator sees in
 * Excel, because "row 214" pointing at a different line than their screen is
 * how a real problem gets dismissed as a glitch.
 *
 * WRONG-FILE GUARDS, both of which stage nothing:
 *   · no column matched a count alias  -> missing_count_column
 *   · every row was blank              -> nothing_counted
 * Without them, uploading last month's purchase register would report a serene
 * "0 rejected" and the operator would believe the store had been counted.
 *
 * ONE CSV LIMITATION WORTH SAYING OUT LOUD: an UNQUOTED grouped number
 * ("1,250") is two cells to any CSV reader, which shifts that row's columns.
 * Excel quotes such cells, so a file saved from the template is safe; a
 * hand-built one may not be. On THIS sheet the count column sits after the unit
 * column, so a shifted row used to read the '1' as the count and stage 1 where
 * the operator wrote 1,250 — right material, right unit, silently wrong
 * quantity, no rejection. It is now caught by SHAPE: any row with more cells
 * than the header has columns is refused whole and returned in `shifted`, which
 * is merged into `rejected` below so a caller that renders rejections cannot
 * miss it. (parseCountedQty still strips separators inside a single QUOTED
 * cell, so "1,250" written properly is read as 1250 and is not affected.)
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const access = await requireStager();
    if (denied(access)) return access.error;
    const db = getDb();
    const url = new URL(request.url);

    const { csv, batchId: bodyBatchId } = await readCsvBody(request);
    if (!csv.trim()) {
      return Response.json({ error: 'No CSV was received. Attach the filled count sheet.' }, { status: 400 });
    }

    const wanted = String(bodyBatchId || url.searchParams.get('batch_id') || '').trim();
    let batchId: string;
    if (wanted) {
      if (!getBatch(db, wanted)) throw new CutoverError('UNKNOWN_BATCH', 'No such cutover batch');
      batchId = wanted;
    } else {
      const draft = getOpenDraft(db);
      if (!draft) {
        throw new CutoverError('UNKNOWN_BATCH', 'No cutover draft is open — start one before uploading a count sheet.');
      }
      batchId = draft.id;
    }

    const parsed = parseCountUpload(csv);

    if (parsed.missing_count_column) {
      return Response.json({
        error: 'No count column found, so nothing was staged. The sheet needs a "counted_qty" column '
          + '(also accepted: count, counted, physical count, qty, quantity).',
        code: 'MISSING_COUNT_COLUMN',
        headers: parsed.headers,
      }, { status: 400 });
    }
    if (parsed.counted.length === 0) {
      // A file of nothing but shifted rows would otherwise land on the
      // wrong-file message and send the operator hunting for a file they
      // already have. Name the real problem.
      return Response.json({
        error: parsed.shifted.length > 0
          ? 'The file has ' + parsed.data_rows + ' row(s) and every counted one has more columns than the header, '
            + 'so nothing was staged. That is what an unquoted grouped number ("1,250") does to a CSV — it splits '
            + 'into two cells and pushes the rest of the row across. Remove the thousands separators (or save the '
            + 'file from Excel, which quotes them) and upload again.'
          : 'The file has ' + parsed.data_rows + ' row(s) and not one count was filled in, so nothing was staged. '
            + 'Check you uploaded the filled sheet and not the blank template.',
        code: parsed.shifted.length > 0 ? 'COLUMNS_SHIFTED' : 'NOTHING_COUNTED',
        columns: parsed.columns,
        data_rows: parsed.data_rows,
        skipped_no_count: parsed.skipped_no_count,
        shifted: parsed.shifted,
      }, { status: 400 });
    }

    const result = stageLines(db, batchId, parsed.counted.map((c) => c.input));

    // stageLines numbers rows 1..n over the array it was handed. Translate back
    // to the file line the operator can actually find.
    const lineOf = (row: number) => parsed.counted[row - 1]?.line ?? row;
    // Shifted rows never reached the engine, so they carry no array index —
    // their file line IS the row number. Merged into the SAME list every client
    // already renders, in file order, because a second parallel list is how a
    // silent misread stays silent on a screen nobody updated.
    const rejected = [
      ...result.rejected.map((r) => ({ ...r, row: lineOf(r.row), array_row: r.row })),
      ...parsed.shifted.map((s) => ({
        row: s.line,
        array_row: 0,
        material_id: '',
        name: s.item,
        reason: 'column_shift' as const,
        detail: 'this row has ' + s.cells + ' columns where the header has ' + s.expected
          + ', so every field after the extra one is read from the wrong column — the count cell read "'
          + s.read_as + '". Almost always an unquoted grouped number like 1,250. Nothing from this row was staged.',
      })),
    ].sort((a, b) => a.row - b.row);
    const storeBlocked = result.store_blocked.map((r) => ({ ...r, row: lineOf(r.row), array_row: r.row }));

    const warnings: string[] = [];
    if (parsed.truncated) {
      warnings.push('The file was longer than ' + MAX_UPLOAD_ROWS + ' rows; the rest was not read. '
        + 'The whole central store is about 825 materials, so this is almost certainly the wrong file.');
    }
    if (parsed.duplicates.length > 0) {
      warnings.push(parsed.duplicates.length + ' material(s) were counted on more than one line — the LAST count in '
        + 'the file was kept. Two counters counting one shelf is worth checking before you commit.');
    }
    if (parsed.unmapped_headers.length > 0) {
      warnings.push('Columns ignored (no matching field): ' + parsed.unmapped_headers.join(', ') + '.');
    }
    if (parsed.shifted.length > 0) {
      warnings.push(parsed.shifted.length + ' row(s) have more columns than the header and were NOT staged. That is '
        + 'what an unquoted grouped number ("1,250") does — it splits into two cells and shifts the rest of the row, '
        + 'so the count would have been read from the wrong column. Remove the thousands separators, or save the '
        + 'file from Excel, which quotes them.');
    }
    if (result.unchanged > 0) {
      warnings.push(result.unchanged + ' row(s) already held exactly the same count and were LEFT AS THEY WERE — '
        + 'including the time they were counted. Re-sending the same sheet is not a re-count, so it does not clear a '
        + '"moved since counted" refusal. Use Re-count on those lines if you have just been back to the shelf.');
    }
    if (rejected.length > 0) {
      warnings.push(rejected.length + ' row(s) could not be read and were NOT staged — those materials keep their '
        + 'current stock. Fix them in the file and upload again, or enter them by hand.');
    }
    if (storeBlocked.length > 0) {
      warnings.push(storeBlocked.length + ' row(s) are liquor (store-mapped) and were NOT staged — count those in '
        + 'Inventory -> Liquor Store -> Record Closing Stock, which is the only writer that keeps the store ledger '
        + 'in step.');
    }

    return Response.json({
      batch_id: batchId,
      columns: parsed.columns,
      data_rows: parsed.data_rows,
      counted_rows: parsed.counted.length,
      /** Named on the sheet but left blank = NOT COUNTED. Untouched by the commit. */
      skipped_no_count: parsed.skipped_no_count,
      /** Same number under the name /inventory/central-cutover reads. Its
       *  client-side fallback importer counts blank cells itself and calls the
       *  field skipped_blank; serving both keeps the count on screen honest
       *  whichever path ran, and dropping either would show the operator a
       *  serene "0 left blank" over a mostly-uncounted store. */
      skipped_blank: parsed.skipped_no_count,
      skipped_no_count_lines: parsed.skipped_no_count_lines,
      duplicates: parsed.duplicates,
      accepted: result.accepted,
      updated: result.updated,
      /** Same figure as already staged: the row was left exactly as it was. */
      unchanged: result.unchanged,
      /** Rows refused for shape. Also merged into `rejected` — served twice on
       *  purpose, because a client that renders only one of the two lists must
       *  still see them. */
      shifted: parsed.shifted,
      rejected,
      store_blocked: storeBlocked,
      staged_total: listLines(db, batchId).length,
      warnings,
      message: result.accepted + ' new count(s), ' + result.updated + ' updated, '
        + result.unchanged + ' unchanged, '
        + parsed.skipped_no_count + ' left blank (not counted), '
        + rejected.length + ' could not be read. Nothing is applied to stock until an admin commits this cutover.',
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return cutoverError('inventory/central-cutover/upload', e);
  }
}
