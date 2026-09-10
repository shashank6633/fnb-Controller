#!/usr/bin/env node
/**
 * GOOGLE REVIEWS ENGINE — PROOF.
 *
 *   node scripts/reviews-tests.js        (also: npm run test:reviews)
 *
 * SANDBOX CONTRACT — copied verbatim from scripts/run-tests.js and
 * scripts/broadcast-tests.js, for the same reason: every test runs against a
 * VACUUM INTO snapshot of fnb-controller.db taken through a READONLY handle,
 * written into a fresh os.tmpdir() directory, and the process chdir()s there
 * BEFORE requiring src/lib/db.ts (db.ts resolves DB_PATH from process.cwd()).
 * assertSandboxed() re-reads the handle's own filename and aborts the run if it
 * is not inside the temp dir. This suite writes hundreds of review rows; doing
 * that against the owner's live database would be silent and unrecoverable.
 *
 * IT EXERCISES THE SHIPPED CODE, NOT A RE-IMPLEMENTATION. Every assertion calls
 * the real functions in src/lib/reviews/. The EXPECTED values were computed by
 * hand from scripts/reviews-fixture.js first — that is the whole point, because
 * an analysis engine can be perfectly self-consistent and still wrong.
 *
 * THE GATES
 *   A  HAND-COMPUTED MONTH — 12 reviews, every figure worked out on paper:
 *      count, average, distribution, low/long counts, reply rate, reply speed
 *      (median / mean / p90 / within-24h), MAJOR list and per-reason counts.
 *   B  IST BUCKETING — 02:00 IST lands on the right day; 01:30 IST on 1 April
 *      lands in April, not in March where the UTC string would put it. Week
 *      keys match SQLite %W.
 *   C  IDEMPOTENCE — re-import the same export: inserted 0, updated 0, and a
 *      full column-by-column snapshot of every row is unchanged.
 *   D  AN EDIT UPDATES, IT DOES NOT DUPLICATE — same reviewId, new text, newer
 *      updateTime: one row, new content, same total. Also proved for a review
 *      with no Google id at all.
 *   E  A STALE EXPORT CANNOT UNDO A NEWER ONE, and a re-import missing a reply
 *      never blanks the stored reply.
 *   F  ANONYMOUS REVIEWS — two identical anonymous rows stay two rows, and stay
 *      two on re-import.
 *   G  BAD ROWS ARE REFUSED AND COUNTED, and the raw payload survives anyway.
 *   H  TOLERANT CSV — different column names, quoted commas, an embedded
 *      newline, a doubled quote, DD/MM dates.
 *   I  CROSS-SOURCE DEDUPE — the same review arriving by CSV and by JSON is one
 *      row, which is the property that lets the API be added later without
 *      double-counting the Takeout history.
 *   J  RAW-FIRST + REPLAY — the payload is archived before parsing, and
 *      replaying it through the current parser is a no-op.
 *   K  BULK REALISM — 422 reviews across 14 months: the bad month is found by
 *      the period alerts, and the below-norm rule fires on it.
 *   L  THEMES ARE HONEST — keyword output is labelled keyword, never sentiment;
 *      rating-only reviews are excluded from the denominator.
 *   M  AI IS OFF BY DEFAULT — the batch analyser is a no-op with no provider call.
 *   N  THE OWNER IS NEVER BLOCKED — manual sources are ready with no credential;
 *      the API source returns his to-do list instead of an error.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const REPO = path.resolve(__dirname, '..');
const LIVE_DB = path.join(REPO, 'fnb-controller.db');
const SRC = path.join(REPO, 'src');

/* ── 0. SNAPSHOT ─────────────────────────────────────────────────────────── */

if (!fs.existsSync(LIVE_DB)) {
  console.error('reviews-tests: ' + LIVE_DB + ' not found — nothing to snapshot.');
  process.exit(2);
}

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fnb-reviews-tests-')));
const SNAP = path.join(TMP, 'fnb-controller.db');
{
  const src = new Database(LIVE_DB, { readonly: true });
  const vacuumInto = "VACUUM INTO '" + SNAP.replace(/'/g, "''") + "'";
  src.exec(vacuumInto);
  src.close();
}
process.chdir(TMP);

/* ── 1. TYPESCRIPT LOADER (same hook as the other suites) ────────────────── */

const ts = require(path.join(REPO, 'node_modules', 'typescript'));
const Module = require('module');

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (typeof request === 'string' && request.startsWith('@/')) {
    request = path.join(SRC, request.slice(2));
  }
  return origResolve.call(this, request, ...rest);
};

require.extensions['.ts'] = function (module, filename) {
  const out = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filename,
  });
  module._compile(out.outputText, filename);
};

const lib = (rel) => require(path.join(SRC, 'lib', rel));

const dbMod = lib('db.ts');
const db = dbMod.getDb();

function assertSandboxed(handle) {
  const open = path.resolve(handle.name || '');
  if (path.resolve(LIVE_DB) === open || !open.startsWith(path.resolve(TMP))) {
    console.error('\nFATAL: tests opened ' + open + ', which is not the snapshot in ' + TMP + '. Aborting.');
    process.exit(3);
  }
}
assertSandboxed(db);

const { ingestDocuments, analysisRows, listReviews, replayRawDocuments, listRuns } = lib('reviews/ingest.ts');
const analysis = lib('reviews/analysis.ts');
const themes = lib('reviews/themes.ts');
const time = lib('reviews/time.ts');
const parse = lib('reviews/parse.ts');
const ai = lib('reviews/ai.ts');
const sources = lib('reviews/sources.ts');
const { buildFixture } = require(path.join(REPO, 'scripts', 'reviews-fixture.js'));

const FIX = buildFixture();

/* ── 2. HARNESS ──────────────────────────────────────────────────────────── */

let pass = 0, fail = 0;
const failures = [];
function ok(label) { pass++; console.log('  ok   ' + label); }
function bad(label, detail) {
  fail++; failures.push(label);
  console.log('  FAIL ' + label);
  if (detail !== undefined) console.log('       ' + detail);
}
function eq(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else bad(label, 'expected ' + e + ', got ' + a);
}
function truthy(label, v, detail) { if (v) ok(label); else bad(label, detail); }
function section(t) { console.log('\n' + t); }

const doc = (payload, label, kind) => ([{ kind: kind || 'json', payload: payload, label: label || 'fixture' }]);

/* ══════════════════════════════════════════════════════════════════════════
 * A. THE HAND-COMPUTED MONTH
 *
 * 12 reviews land in March 2026 IST, one in April. Worked out on paper from
 * scripts/reviews-fixture.js BEFORE any of this ran:
 *
 *   ratings, in order: 5 4 1 2 5 3 5 4 1 5 2 4   sum 41, n 12  -> average 3.42
 *   distribution: one star 2, two 2, three 1, four 3, five 4   (2+2+1+3+4 = 12)
 *   low (1-2 stars) 4      long (>= 400 chars) 2   (H03 450, H07 500)
 *
 *   REPLIES — and the distinction this fixture exists to force. FIVE reviews
 *   carry a reply (H01 H04 H08 H09 H12), so replied = 5 of 12 -> 0.4167 and
 *   unreplied = 7. But H08's reply has NO timestamp, so only FOUR can be timed:
 *      H12 6h, H04 12h, H01 24h, H09 72h
 *      median (12+24)/2 = 18   mean 114/4 = 28.5   p90 nearest-rank = 72
 *      within 24h = 3          within 72h = 4
 *   "answered" and "answered fast" therefore have DIFFERENT denominators (5 and
 *   4), which is exactly the trap a Takeout export sets: it can carry the reply
 *   text without the reply time, and averaging speed over `replied` would
 *   quietly flatter every reply-time figure on the page.
 *   Unanswered past the 48h grace at the fixed clock: all 7.
 *
 *   MAJOR (score >= 3, below-norm disabled here and tested separately in K):
 *      H03  1 star 4 + unanswered 2 + long 1 = 7   MAJOR
 *      H04  2 stars 3                              MAJOR
 *      H06  three star 1 + unanswered 2 = 3        MAJOR
 *      H09  1 star 4                               MAJOR
 *      H11  2 stars 3 + unanswered 2 = 5           MAJOR
 *      H07  unanswered_positive 1 + long 1 = 2     not major (an opportunity)
 *      H01 H02 H05 H08 H10 H12                     not major
 *   -> 5 major; reasons: low_rating 4, three_star 1, unanswered 3,
 *      unanswered_positive 1, long_detailed 2
 * ══════════════════════════════════════════════════════════════════════════ */

section('A. Hand-computed month (March 2026)');

const HAND_LOC = 'hand';
const r1 = ingestDocuments(db, doc(FIX.handMonthJson, 'hand-month.json'), {
  source: 'takeout_json', locationKey: HAND_LOC, actor: 'test', now: FIX.HAND_NOW,
});

eq('all 13 hand rows parsed and inserted', [r1.rows_seen, r1.inserted, r1.errors], [13, 13, 0]);

const handRows = analysisRows(db, { locationKey: HAND_LOC });
eq('13 rows readable back', handRows.length, 13);

const handSeries = analysis.computePeriodSeries(handRows, { period: 'monthly', now: FIX.HAND_NOW });
const march = handSeries.buckets.find(b => b.key === '2026-03');
const april = handSeries.buckets.find(b => b.key === '2026-04');

truthy('a March and an April monthly bucket exist', march && april,
  'got ' + handSeries.buckets.map(b => b.key).join(', '));
eq('March count = 12 (hand)', march.count, 12);
eq('March average = 3.42 (41/12, hand)', march.average, 3.42);
eq('March distribution (hand)', march.distribution, { 1: 2, 2: 2, 3: 1, 4: 3, 5: 4 });
eq('March low (1-2 star) count = 4 (hand)', march.low_count, 4);
eq('March long (>=400 chars) count = 2 (hand)', march.long_count, 2);
eq('March replied = 5, reply rate 0.4167 (hand)', [march.replied, march.reply_rate], [5, 0.4167]);
eq('April count = 1 (the 01:30 IST review)', april.count, 1);

const marchRows = handRows.filter(r => analysis.dayKeyOf(r).startsWith('2026-03'));
eq('12 rows fall in the March IST calendar month', marchRows.length, 12);

const marchSummary = analysis.computeSummary(marchRows, { now: FIX.HAND_NOW });
eq('March summary average = 3.42', marchSummary.average, 3.42);
eq('March reply: replied 5 / unreplied 7 (hand)', [marchSummary.reply.replied, marchSummary.reply.unreplied], [5, 7]);
eq('only 4 of the 5 replies can be TIMED — one carries no reply timestamp',
  [marchSummary.reply.timed, marchSummary.reply.replied], [4, 5]);
eq('March reply median 18h, mean 28.5h, p90 72h (hand)',
  [marchSummary.reply.median_hours, marchSummary.reply.mean_hours, marchSummary.reply.p90_hours],
  [18, 28.5, 72]);
eq('March replies within 24h = 3, within 72h = 4 (hand)',
  [marchSummary.reply.within_24h, marchSummary.reply.within_72h], [3, 4]);
eq('all 7 unanswered March reviews are past the 48h grace', marchSummary.reply.overdue, 7);

const majors = analysis.computeMajorReviews(marchRows, {
  now: FIX.HAND_NOW, thresholds: { normMinSample: 9999 },
});
eq('5 MAJOR reviews in March (hand)', majors.major_count, 5);
eq('the MAJOR ids are H03 H04 H06 H09 H11 (hand)',
  majors.major.map(m => handRows.find(h => h.id === m.id)).map(h => h.text.slice(0, 12)).sort(),
  ['Average, exp', 'Service was ', 'Too loud', 'Very disappo', 'We came in f'].sort());
eq('MAJOR reason counts (hand)',
  [majors.counts.low_rating, majors.counts.three_star, majors.counts.unanswered,
   majors.counts.unanswered_positive, majors.counts.long_detailed],
  [4, 1, 3, 1, 2]);

const byText = (t) => majors.reviews.find(m => (handRows.find(h => h.id === m.id).text || '').startsWith(t));
eq('the 1-star long unanswered review scores 7', byText('We came in for a Saturday').score, 7);
truthy('the 5-star long unanswered review is NOT major but IS flagged as an opportunity',
  !byText('Easily one of the best').is_major && byText('Easily one of the best').reasons.includes('unanswered_positive'));
truthy('the definition is returned in words for the page to print',
  Array.isArray(majors.definition) && majors.definition.length >= 6);

const handTrend = analysis.computeTrend(handSeries);
eq('trend current/previous are April/March', [handTrend.current.key, handTrend.previous.key], ['2026-04', '2026-03']);
eq('trend count delta -11, pct -0.9167 (hand)', [handTrend.count_delta, handTrend.count_pct], [-11, -0.9167]);
eq('trend average delta +1.58, direction up (hand)', [handTrend.avg_delta, handTrend.direction], [1.58, 'up']);

/* ══════════════════════════════════════════════════════════════════════════
 * B. IST BUCKETING
 * ══════════════════════════════════════════════════════════════════════════ */

section('B. IST bucketing');

const h11 = handRows.find(r => r.text === 'Too loud');
eq('the 02:00 IST review is stored as 2026-03-27T20:30:00Z (UTC)', h11.posted_at, '2026-03-27T20:30:00Z');
eq('and buckets to 2026-03-28 — the IST day, not the UTC one', analysis.dayKeyOf(h11), '2026-03-28');

const h13 = handRows.find(r => !r.text);
eq('the 01:30 IST review is stored as 2026-03-31T20:00:00Z (UTC)', h13.posted_at, '2026-03-31T20:00:00Z');
eq('and buckets to April in IST, not March', analysis.dayKeyOf(h13), '2026-04-01');

eq('1 Jan 2026 is week 00 (it precedes the first Monday)',
  time.istWeekKey(Date.parse('2026-01-01T06:00:00Z')), '2026-W00');
eq('5 Mar 2026 is week 09 (hand, matches SQLite %W)',
  time.istWeekKey(Date.parse('2026-03-05T06:00:00Z')), '2026-W09');

const denseGap = analysis.computePeriodSeries(
  [{ id: 'a', rating: 5, text: '', posted_at: '2026-01-05T06:00:00Z', reply_text: '', replied_at: '' },
   { id: 'b', rating: 5, text: '', posted_at: '2026-04-05T06:00:00Z', reply_text: '', replied_at: '' }],
  { period: 'monthly' });
eq('empty months appear as zero-count buckets, never vanish',
  denseGap.buckets.map(b => b.key + ':' + b.count),
  ['2026-01:1', '2026-02:0', '2026-03:0', '2026-04:1']);

/* ══════════════════════════════════════════════════════════════════════════
 * C. IDEMPOTENCE — the gate the whole design exists for
 * ══════════════════════════════════════════════════════════════════════════ */

section('C. Re-importing the same export changes nothing');

function snapshot(locationKey) {
  return db.prepare(
    'SELECT identity_key, identity_basis, external_id, author_name, author_is_anonymous,' +
    '       rating, text, text_len, language, posted_at, posted_precision,' +
    '       source_updated_at, reply_text, replied_at, content_hash, first_seen_at, source' +
    '  FROM gr_reviews WHERE location_key = ? ORDER BY identity_key'
  ).all(locationKey);
}

const before = snapshot(HAND_LOC);
const r2 = ingestDocuments(db, doc(FIX.handMonthJson, 'hand-month.json (again)'), {
  source: 'takeout_json', locationKey: HAND_LOC, actor: 'test', now: FIX.HAND_NOW,
});
const after = snapshot(HAND_LOC);

eq('second import: 0 inserted, 0 updated, 13 unchanged',
  [r2.inserted, r2.updated, r2.unchanged], [0, 0, 13]);
eq('row count did not move', after.length, 13);
eq('every stored column is byte-identical after the re-import',
  JSON.stringify(after) === JSON.stringify(before), true);

/* ══════════════════════════════════════════════════════════════════════════
 * D. AN AUTHOR EDIT UPDATES; IT DOES NOT DUPLICATE
 * ══════════════════════════════════════════════════════════════════════════ */

section('D. An edited review updates in place');

const edited = JSON.parse(FIX.handMonthJson);
const target = edited.reviews.find(r => r.reviewId === 'H06');
target.comment = 'Average, expected better — but the manager called and sorted it out.';
target.updateTime = '2026-04-10T09:00:00Z';

const r3 = ingestDocuments(db, doc(JSON.stringify(edited), 'hand-month.json (H06 edited)'), {
  source: 'takeout_json', locationKey: HAND_LOC, actor: 'test', now: FIX.HAND_NOW,
});
eq('the edit is 1 update, 0 inserts', [r3.inserted, r3.updated], [0, 1]);
eq('still 13 rows — the edit did not create a second review',
  analysisRows(db, { locationKey: HAND_LOC }).length, 13);
const h06 = listReviews(db, { locationKey: HAND_LOC }).find(r => r.external_id === 'H06');
truthy('the row now carries the edited text', /sorted it out/.test(h06.text), h06.text);
eq('and keeps its original first_seen_at',
  h06.first_seen_at, before.find(b => b.external_id === 'H06').first_seen_at);

const noIdLoc = 'noid';
const base = { reviews: [{ reviewer: { displayName: 'Sita R' }, starRating: 'TWO',
  createTime: '2026-03-10T14:00:00Z', updateTime: '2026-03-10T14:00:00Z', comment: 'Not great' }] };
ingestDocuments(db, doc(JSON.stringify(base), 'noid-1'), { source: 'csv', locationKey: noIdLoc, now: FIX.HAND_NOW });
const edit2 = JSON.parse(JSON.stringify(base));
edit2.reviews[0].comment = 'Not great, though the second visit was much better';
edit2.reviews[0].updateTime = '2026-03-20T14:00:00Z';
const r4 = ingestDocuments(db, doc(JSON.stringify(edit2), 'noid-2'), { source: 'csv', locationKey: noIdLoc, now: FIX.HAND_NOW });
eq('an edit to a review with NO Google id also updates rather than duplicating',
  [r4.inserted, r4.updated, analysisRows(db, { locationKey: noIdLoc }).length], [0, 1, 1]);
eq('that row is keyed on author+createTime, and says so',
  listReviews(db, { locationKey: noIdLoc })[0].identity_basis, 'composite_author_time');

/* ══════════════════════════════════════════════════════════════════════════
 * E. AN OLD EXPORT CANNOT UNDO A NEWER ONE
 * ══════════════════════════════════════════════════════════════════════════ */

section('E. Stale imports and never-blank');

const r5 = ingestDocuments(db, doc(FIX.handMonthJson, 'hand-month.json (stale, pre-edit)'), {
  source: 'takeout_json', locationKey: HAND_LOC, actor: 'test', now: FIX.HAND_NOW,
});
truthy('re-uploading the older export is refused for the edited row', r5.skipped_stale >= 1,
  'skipped_stale = ' + r5.skipped_stale);
truthy('the edited text survives the stale re-upload',
  /sorted it out/.test(listReviews(db, { locationKey: HAND_LOC }).find(r => r.external_id === 'H06').text));

const stripped = JSON.parse(FIX.handMonthJson);
for (const rv of stripped.reviews) { delete rv.reviewReply; delete rv.updateTime; }
ingestDocuments(db, doc(JSON.stringify(stripped), 'export with no reply column'), {
  source: 'csv', locationKey: HAND_LOC, actor: 'test', now: FIX.HAND_NOW,
});
const h01 = listReviews(db, { locationKey: HAND_LOC }).find(r => r.external_id === 'H01');
eq('a re-import missing the reply column does NOT blank the stored reply',
  h01.reply_text, 'Thank you Ramesh!');

/* ══════════════════════════════════════════════════════════════════════════
 * F, G, H, I
 * ══════════════════════════════════════════════════════════════════════════ */

section('F. Anonymous reviewers');

const EDGE_LOC = 'edge';
const r6 = ingestDocuments(db, doc(FIX.edgeGoodJson, 'edge-good.json'), {
  source: 'takeout_json', locationKey: EDGE_LOC, actor: 'test', now: FIX.HAND_NOW,
});
eq('4 edge rows accepted', [r6.rows_seen, r6.inserted, r6.errors], [4, 4, 0]);
const edgeRows = listReviews(db, { locationKey: EDGE_LOC });
const anon = edgeRows.filter(r => r.author_is_anonymous === 1);
eq('two identical anonymous reviews stay TWO rows', anon.length, 2);
eq('they are flagged as weakly identified so the page can be honest', r6.weak_identity, 2);
eq('and they are keyed on the anonymous basis',
  Array.from(new Set(anon.map(r => r.identity_basis))), ['composite_anon']);

const r7 = ingestDocuments(db, doc(FIX.edgeGoodJson, 'edge-good.json (again)'), {
  source: 'takeout_json', locationKey: EDGE_LOC, actor: 'test', now: FIX.HAND_NOW,
});
eq('re-importing them is still a no-op: STILL two, not four',
  [r7.inserted, listReviews(db, { locationKey: EDGE_LOC }).filter(r => r.author_is_anonymous === 1).length],
  [0, 2]);

const gopal = edgeRows.find(r => r.external_id === 'E04');
eq('a reply stamped before its review keeps the reply and drops the impossible time',
  [gopal.reply_text, gopal.replied_at], ['Thanks', '']);

section('G. Bad rows are refused, counted, and never invented around');

const BAD_LOC = 'bad';
const r8 = ingestDocuments(db, doc(FIX.edgeBadJson, 'edge-bad.json'), {
  source: 'takeout_json', locationKey: BAD_LOC, actor: 'test', now: FIX.HAND_NOW,
});
eq('all 5 unusable rows are refused, none stored', [r8.inserted, r8.errors, r8.rows_seen], [0, 5, 0]);
eq('nothing landed in the table', analysisRows(db, { locationKey: BAD_LOC }).length, 0);
truthy('the relative-date refusal explains itself',
  r8.parse_errors.some(e => /relative timestamps come from scraped exports/.test(e.reason)),
  JSON.stringify(r8.parse_errors.map(e => e.reason)));
truthy('a fractional 4.3 is refused as an average, not stored as a 4',
  r8.parse_errors.some(e => /unusable rating/.test(e.reason) && /4\.3/.test(e.reason)));
const badRaw = db.prepare('SELECT COUNT(*) n FROM gr_ingest_raw WHERE run_id = ?').get(r8.run_id);
eq('the raw payload was archived even though every row failed to parse', badRaw.n, 1);

section('H. Tolerant CSV');

const CSV_LOC = 'csv';
const r9 = ingestDocuments(db, [{ kind: 'csv', payload: FIX.edgeCsv, label: 'manager-sheet.csv' }], {
  source: 'csv', locationKey: CSV_LOC, actor: 'test', dateOrder: 'dmy', now: FIX.HAND_NOW,
});
eq('4 CSV rows parsed (the blank line is skipped)', [r9.rows_seen, r9.inserted, r9.errors], [4, 4, 0]);
const csvRows = listReviews(db, { locationKey: CSV_LOC });
const c02 = csvRows.find(r => r.external_id === 'C02');
truthy('an embedded newline inside a quoted review survives', /Line one\nLine two/.test(c02.text), JSON.stringify(c02.text));
truthy('a doubled quote is unescaped to one', /"kebabs"/.test(c02.text), JSON.stringify(c02.text));
const c01 = csvRows.find(r => r.external_id === 'C01');
eq('a quoted comma does not split the field', c01.text, 'Great food, great service');
eq('02/03/2026 read as 2 March in dmy order', analysis.dayKeyOf(c01), '2026-03-02');
truthy('the ambiguous dates were counted, not silently trusted', r9.ambiguous_dates >= 2,
  'ambiguous_dates = ' + r9.ambiguous_dates);
eq('"A Google user" in a CSV is detected as anonymous',
  csvRows.find(r => r.external_id === 'C03').author_is_anonymous, 1);
truthy('the column mapping is reported back for the owner to check',
  r9.column_map['Reviewer Name'] === 'author_name' && r9.column_map['Owner Reply'] === 'reply_text',
  JSON.stringify(r9.column_map));

eq('13/04/2026 is unambiguous and reads as 13 April whatever the hint says',
  parse.parseTimestamp('13/04/2026', { dateOrder: 'mdy', now: FIX.HAND_NOW }).iso,
  '2026-04-12T18:30:00Z');

section('I. The same review by two different sources is one row');

const crossCsv = [
  'reviewId,reviewer,starRating,comment,createTime',
  'H05,Vikram,5,Superb,2026-03-09T06:30:00Z',
].join('\n');
const r10 = ingestDocuments(db, [{ kind: 'csv', payload: crossCsv, label: 'same-review.csv' }], {
  source: 'csv', locationKey: HAND_LOC, actor: 'test', now: FIX.HAND_NOW,
});
eq('a review already imported from Takeout is not inserted again by CSV',
  [r10.inserted, analysisRows(db, { locationKey: HAND_LOC }).length], [0, 13]);

/* ══════════════════════════════════════════════════════════════════════════
 * J. RAW-FIRST AND REPLAY
 * ══════════════════════════════════════════════════════════════════════════ */

section('J. Raw-first archive and parser replay');

const raw1 = db.prepare('SELECT * FROM gr_ingest_raw WHERE run_id = ?').get(r1.run_id);
truthy('the whole uploaded document is stored verbatim',
  raw1 && raw1.payload === FIX.handMonthJson, 'payload does not match the upload byte for byte');
eq('with its own sha256 and byte length recorded',
  [raw1.payload_sha256.length, raw1.byte_len > 1000], [64, true]);
eq('every stored review points back at the document it came from',
  db.prepare("SELECT COUNT(*) n FROM gr_reviews WHERE location_key = ? AND raw_id = ''").get(HAND_LOC).n, 0);
eq('and carries its own source item for tracing',
  JSON.parse(listReviews(db, { locationKey: HAND_LOC }).find(r => r.external_id === 'H01').raw_item).reviewId, 'H01');

const beforeReplay = snapshot(HAND_LOC);
const replay = replayRawDocuments(db, { runIds: [r1.run_id], actor: 'test', now: FIX.HAND_NOW });
eq('replaying an archived document through the current parser inserts nothing new', replay.inserted, 0);
eq('and changes no stored column',
  JSON.stringify(snapshot(HAND_LOC)) === JSON.stringify(beforeReplay), true);

truthy('every run is recorded with its counters', listRuns(db, 50).length >= 8);
const runRow = listRuns(db, 50).find(r => r.id === r1.run_id);
eq('the first run closed as done with its counts intact',
  [runRow.status, runRow.rows_seen, runRow.inserted], ['done', 13, 13]);

const REC_LOC = 'recon';
const rec = ingestDocuments(db, doc(FIX.handMonthJson, 'partial export'), {
  source: 'takeout_json', locationKey: REC_LOC, actor: 'test', now: FIX.HAND_NOW, expectedTotal: 20,
});
eq('a short export is reported as a delta against the live listing, not silently trusted',
  [rec.reconciliation.stored_total, rec.reconciliation.expected_total, rec.reconciliation.delta],
  [13, 20, -7]);

/* ══════════════════════════════════════════════════════════════════════════
 * K. BULK — 422 reviews across 14 months
 * ══════════════════════════════════════════════════════════════════════════ */

section('K. Bulk fixture: 422 reviews across 14 months');

const BULK_LOC = 'bulk';
const BULK_NOW = Date.parse('2026-05-15T00:00:00Z');
const rb = ingestDocuments(db, doc(FIX.bulkJson, 'bulk.json'), {
  source: 'takeout_json', locationKey: BULK_LOC, actor: 'test', now: BULK_NOW,
});
eq('every bulk row parsed', [rb.rows_seen, rb.inserted, rb.errors], [422, 422, 0]);

const rbAgain = ingestDocuments(db, doc(FIX.bulkJson, 'bulk.json (again)'), {
  source: 'takeout_json', locationKey: BULK_LOC, actor: 'test', now: BULK_NOW,
});
eq('re-importing 422 rows writes nothing', [rbAgain.inserted, rbAgain.updated, rbAgain.unchanged], [0, 0, 422]);

const bulkRows = analysisRows(db, { locationKey: BULK_LOC });
const full = analysis.analyzeReviews(bulkRows, { now: BULK_NOW });

eq('summary total matches the row count', full.summary.total, 422);
eq('the distribution sums to the total',
  Object.values(full.summary.distribution).reduce((a, b) => a + b, 0), 422);
truthy('the monthly series is dense across the whole span',
  full.series.monthly.buckets.length >= 14,
  full.series.monthly.buckets.length + ' buckets');

const nov = full.series.monthly.buckets.find(b => b.key === '2025-11');
const oct = full.series.monthly.buckets.find(b => b.key === '2025-10');
truthy('November 2025 really is the bad month in the fixture',
  nov.average < oct.average - 0.7, 'oct ' + oct.average + ' vs nov ' + nov.average);
truthy('the monthly period alert finds it',
  full.alerts.some(a => a.key === '2025-11' && a.kind === 'rating_drop'),
  JSON.stringify(full.alerts.map(a => a.key + '/' + a.kind)));

const bulkMajor = analysis.computeMajorReviews(bulkRows, { now: BULK_NOW });
const belowNorm = bulkMajor.reviews.filter(m => m.reasons.includes('below_norm'));
truthy('the below-norm rule fires (a TRAILING baseline, not a global mean)',
  belowNorm.length > 0, 'below_norm count = ' + belowNorm.length);
truthy('a below-norm review carries the baseline it was judged against',
  belowNorm.length === 0 || typeof belowNorm[0].baseline === 'number');
const novMajor = bulkMajor.major.filter(m => m.posted_at >= '2025-10-31' && m.posted_at < '2025-12-01');
truthy('November produces a pile of MAJOR reviews',
  novMajor.length >= 10, novMajor.length + ' major in Nov');

const spikes = analysis.computePeriodAlerts(full.series.daily);
truthy('the 14 Feb burst weekend shows up as a daily volume spike',
  spikes.some(a => a.kind === 'volume_spike' && a.key === '2026-02-14'),
  JSON.stringify(spikes.filter(a => a.kind === 'volume_spike').map(a => a.key).slice(0, 10)));

truthy('the reconstruction caveat travels with the figures',
  full.caveats.some(c => /survivors only/.test(c)));

const t0 = Date.now();
for (let i = 0; i < 10; i++) analysis.analyzeReviews(bulkRows, { now: BULK_NOW });
const perMs = (Date.now() - t0) / 10;
truthy('a full recompute over 422 reviews takes ' + perMs.toFixed(1) + 'ms (budget 150ms)', perMs < 150);

/* ══════════════════════════════════════════════════════════════════════════
 * L. THEMES ARE HONEST
 * ══════════════════════════════════════════════════════════════════════════ */

section('L. Keyword themes — labelled as keyword matching, never as sentiment');

const themeReport = themes.computeThemes(bulkRows);
eq('the method is declared as keyword', themeReport.method, 'keyword');
truthy('the disclaimer says plainly that this is not sentiment analysis',
  /not sentiment analysis/i.test(themeReport.disclaimer));
truthy('no theme label anywhere claims positive or negative',
  !themeReport.themes.some(t => /positive|negative|sentiment/i.test(t.key + t.label)));
truthy('the denominator is reviews WITH TEXT, not all reviews',
  themeReport.text_reviews < 422 && themeReport.text_reviews > 0,
  'text_reviews = ' + themeReport.text_reviews + ' of 422');
truthy('every theme mention count is at most the number of text reviews',
  themeReport.themes.every(t => t.count <= themeReport.text_reviews));
truthy('service and wait-time themes are both found in the fixture',
  themeReport.themes.some(t => t.key === 'service') && themeReport.themes.some(t => t.key === 'wait_time'),
  JSON.stringify(themeReport.themes.map(t => t.key)));
truthy('each theme reports the guests own average star rating alongside its count',
  themeReport.themes.every(t => t.average_rating === null || (t.average_rating >= 1 && t.average_rating <= 5)));

const waitTheme = themeReport.themes.find(t => t.key === 'wait_time');
truthy('the words that actually fired are shown, so an over-matching rule is visible',
  waitTheme.top_terms.length > 0, JSON.stringify(waitTheme.top_terms));

const compiled = themes.compileThemes();
eq('a theme is counted once per review however often the word appears',
  themes.matchThemes('food food food food food', compiled).filter(t => t.key === 'food_quality').length, 1);
eq('word boundaries hold: "bar" does not fire on "barely"',
  themes.matchThemes('we barely made it', compiled).some(t => t.key === 'drinks_bar'), false);
eq('a rating-only review mentions no theme', themes.matchThemes('', compiled).length, 0);

/* ══════════════════════════════════════════════════════════════════════════
 * M + N
 * ══════════════════════════════════════════════════════════════════════════ */

section('M. The AI pass is off until an admin turns it on');

eq('the flag reads OFF when the settings key is absent', ai.isReviewAiOn(db), false);

ai.analyzePendingReviews({ db: db, limit: 5, locationKey: BULK_LOC }).then(async (res) => {
  eq('with the flag off the batch analyser attempts nothing',
    [res.attempted, res.done, res.errors], [0, 0, 0]);

  const aiReport = ai.aiThemeReport(db, { locationKey: BULK_LOC });
  eq('the AI report declares its method', aiReport.method, 'ai');
  truthy('and its disclaimer says it is a reading, not a measurement',
    /a reading, not a measurement/.test(aiReport.disclaimer));
  eq('nothing has been analysed', aiReport.analyzed, 0);
  truthy('but the page can see how many are waiting', aiReport.pending > 0);

  truthy('a fenced or prose-wrapped model answer is still recovered',
    ai.parseAiResult('here you go: {"sentiment":"negative","confidence":0.8,"themes":["slow service"],"summary":"s","action":"a"}').sentiment === 'negative');
  eq('garbage from the model returns null rather than a fabricated reading',
    ai.parseAiResult('I cannot do that'), null);

  section('N. The owner is never blocked by Google');

  const readiness = sources.sourceReadiness(db);
  const manual = readiness.filter(s => s.kind === 'manual');
  eq('all three manual sources are ready with no credential at all',
    manual.length === 3 && manual.every(s => s.ready === true && s.prerequisites.length === 0), true);
  const gbp = readiness.find(s => s.key === 'gbp_api');
  eq('the API source reports itself unconfigured', gbp.ready, false);
  truthy('and hands back the owners own to-do list instead of an error',
    gbp.prerequisites.length >= 8, gbp.prerequisites.length + ' prerequisites');
  truthy('with its unverified assumptions declared',
    gbp.unproven.some(u => /No Google endpoint has been called/.test(u)));
  truthy('and points at the Takeout path meanwhile', /Takeout/.test(gbp.reason));

  await connectorGates();
  pageGates();
  integrityGates();

  finish();
}).catch((e) => {
  bad('the AI/readiness block threw', e && e.stack ? e.stack : String(e));
  finish();
});

/* ══════════════════════════════════════════════════════════════════════════
 * THE AUTOMATIC CONNECTOR — gates O to U.
 *
 * The owner's instruction was explicit: "it should automatically retrieve the
 * reviews data ... how can we import every time?" So the connector is the
 * product and the importer is the fallback, and these gates test the connector
 * the way it will actually fail.
 *
 * WHAT CANNOT BE TESTED HERE, STATED PLAINLY: no Google endpoint is called and
 * no credential is exercised anywhere in this suite. `fetch` is replaced with a
 * scripted double that returns bodies shaped like Google's documented
 * responses. So these gates prove OUR logic — pagination, the 401 retry, the
 * token cache, health transitions, idempotency — and prove nothing whatsoever
 * about whether Google's real responses match the documentation. The first live
 * pull remains the only test of that, and the connector says so on screen.
 * ══════════════════════════════════════════════════════════════════════════ */
async function connectorGates() {
  const oauth = lib('reviews/oauth.ts');
  const connection = lib('reviews/connection.ts');
  const gbp = lib('reviews/sources-gbp.ts');
  const flow = lib('reviews/connect-flow.ts');
  const refresh = lib('reviews/refresh.ts');
  const schema = lib('reviews/schema.ts');

  const T0 = Date.parse('2026-05-01T10:00:00Z');
  const LOC = 'conn';

  /* ── O. The consent URL ───────────────────────────────────────────────── */
  section('O. The consent URL carries the two parameters everything depends on');

  const authUrl = oauth.buildAuthUrl({
    clientId: 'cid.apps.googleusercontent.com',
    redirectUri: 'https://fnb.example.com/api/crm-calls/reviews/connect/callback',
    state: 'st',
  });
  const au = new URL(authUrl);

  // Without access_type=offline Google returns NO refresh token and the
  // connection dies about an hour later. This is the single most expensive
  // one-word mistake available in this file.
  eq('access_type=offline, or there is no refresh token at all',
    au.searchParams.get('access_type'), 'offline');
  // Without prompt=consent a RE-connect returns an access token and no refresh
  // token, producing a connection that looks fine and cannot survive an hour.
  eq('prompt=consent, so reconnecting actually re-issues a refresh token',
    au.searchParams.get('prompt'), 'consent');
  truthy('the business.manage scope is requested',
    /business\.manage/.test(au.searchParams.get('scope') || ''));
  eq('the redirect URI is passed through verbatim',
    au.searchParams.get('redirect_uri'),
    'https://fnb.example.com/api/crm-calls/reviews/connect/callback');
  eq('the state rides along', au.searchParams.get('state'), 'st');
  eq('it points at Google account consent', au.origin + au.pathname,
    'https://accounts.google.com/o/oauth2/v2/auth');

  let threw = false;
  try { oauth.buildAuthUrl({ clientId: '', redirectUri: 'x', state: 's' }); } catch { threw = true; }
  eq('building a consent URL with no client id is refused', threw, true);

  /* ── P. State: signed, expiring, single-use ───────────────────────────── */
  section('P. The OAuth state is signed, expiring and single-use');

  const SECRET = 'unit-test-secret-unit-test-secret';
  const signed = oauth.signState({ nonce: 'n1', iat: T0 }, SECRET);

  eq('a state we signed verifies', oauth.verifyState(signed, SECRET, T0).ok, true);
  eq('and carries its nonce back',
    oauth.verifyState(signed, SECRET, T0).payload.nonce, 'n1');
  eq('a state signed with a different secret is refused',
    oauth.verifyState(signed, 'other-secret-other-secret-other', T0).reason, 'bad_signature');
  eq('a tampered payload is refused',
    oauth.verifyState('eyJub25jZSI6ImV2aWwifQ.' + signed.split('.')[1], SECRET, T0).reason,
    'bad_signature');
  eq('a state with no signature at all is refused',
    oauth.verifyState('justsometext', SECRET, T0).reason, 'malformed');
  eq('a state older than 15 minutes is refused',
    oauth.verifyState(signed, SECRET, T0 + 16 * 60_000).reason, 'expired');
  eq('and one from the future is refused too',
    oauth.verifyState(signed, SECRET, T0 - 20 * 60_000).reason, 'expired');
  eq('an empty secret cannot verify anything',
    oauth.verifyState(signed, '', T0).ok, false);

  connection.createOauthState(db, { nonce: 'nonce-1', redirectUri: 'https://x/cb', actor: 'admin', now: T0 });
  eq('a fresh nonce is consumed once', connection.consumeOauthState(db, 'nonce-1', T0).ok, true);
  eq('the SAME nonce cannot be consumed twice — a replayed callback is refused',
    connection.consumeOauthState(db, 'nonce-1', T0).reason, 'used');
  eq('an unknown nonce is refused', connection.consumeOauthState(db, 'never-existed', T0).reason, 'unknown');
  connection.createOauthState(db, { nonce: 'nonce-2', redirectUri: 'https://x/cb', actor: 'a', now: T0 });
  eq('an expired attempt is refused',
    connection.consumeOauthState(db, 'nonce-2', T0 + 20 * 60_000).reason, 'expired');
  eq('the redirect URI is replayed from the state row, not recomputed',
    connection.consumeOauthState(db,
      (connection.createOauthState(db, { nonce: 'n3', redirectUri: 'https://pinned/cb', actor: 'a', now: T0 }), 'n3'),
      T0).redirectUri,
    'https://pinned/cb');

  /* ── Q. Health never lies ─────────────────────────────────────────────── */
  section('Q. Connection health never reports healthy when data is not arriving');

  const HOUR = 3_600_000;
  const base = {
    location_key: LOC, status: 'connected', google_email: 'owner@akan.example',
    account_name: 'accounts/1', account_label: 'AKAN', location_name: 'accounts/1/locations/2',
    location_label: 'AKAN Jubilee Hills', location_address: '', scope: '',
    connected_at: '', connected_by: '', token_expires_at: '',
    last_attempt_at: '', last_success_at: new Date(T0 - HOUR).toISOString(),
    last_error: '', last_error_at: '', consecutive_failures: 0,
    auto_enabled: 1, interval_minutes: 360, last_auto_run_at: '', lock_until: '', updated_at: '',
  };
  // A DRIVER TICK IS EVIDENCE, AND THE DEFAULT HELPER SUPPLIES IT.
  // connectionHealth() will not call a connection healthy without proof that
  // something is actually calling the scheduler entry point, so every case that
  // is ABOUT some other state passes a fresh tick; the driver's own cases below
  // pass their own.
  const TICK = new Date(T0 - 5 * 60_000).toISOString();
  const h = (patch, hasApp, tick) =>
    connection.connectionHealth(Object.assign({}, base, patch),
      { now: T0, hasApp: hasApp !== false, driverTickAt: tick === undefined ? TICK : tick });

  eq('no OAuth client configured -> no_app', h({}, false).state, 'no_app');
  eq('no account connected -> not_connected', h({ status: 'disconnected' }).state, 'not_connected');
  eq('a refused refresh token -> needs_reconnect', h({ status: 'needs_reconnect' }).state, 'needs_reconnect');
  eq('and that is an ERROR, not a note', h({ status: 'needs_reconnect' }).severity, 'error');
  eq('connected but no listing chosen -> no_location', h({ location_name: '' }).state, 'no_location');
  eq('connected with the schedule off -> paused', h({ auto_enabled: 0 }).state, 'paused');
  eq('one failed attempt -> failing', h({ consecutive_failures: 1 }).state, 'failing');
  eq('three in a row is an error, not a warning', h({ consecutive_failures: 3 }).severity, 'error');
  eq('a long silence -> stale', h({ last_success_at: new Date(T0 - 40 * HOUR).toISOString() }).state, 'stale');
  eq('connected, scheduled, recently fetched -> healthy', h({}).state, 'healthy');
  eq('and only that state claims data is arriving automatically', h({}).automatic, true);

  /* ── THE SCHEDULE IS ARMED, BUT NOTHING IS RUNNING IT ───────────────────
   * The failure that shipped: `auto_enabled` recorded that somebody switched
   * the schedule on, and the page read that as "reviews are arriving". No
   * scheduler hook existed and the cron endpoint was proxy-blocked, so the
   * badge was green and "NEXT FETCH: in about 5 hours" was a promise nothing
   * could keep. A flag is intent; only a heartbeat is evidence. */
  const noDriver = h({}, true, '');
  eq('armed with NO scheduler ever seen -> no_driver', noDriver.state, 'no_driver');
  eq('and it does NOT claim to be automatic', noDriver.automatic, false);
  eq('and it makes no promise about a next fetch', noDriver.next_due_at, '');
  eq('driver_alive says so in one field', noDriver.driver_alive, false);
  truthy('the headline names the real cause, not the symptom',
    /NOTHING IS RUNNING IT|nothing has run it/.test(noDriver.headline), noDriver.headline);
  truthy('and the action says who has to fix it and how',
    /scheduler|cron/.test(noDriver.action), noDriver.action);

  const driverDied = h({}, true, new Date(T0 - 14 * HOUR).toISOString());
  eq('a scheduler that stopped ticking is also no_driver', driverDied.state, 'no_driver');
  eq('with the last tick reported rather than hidden', driverDied.driver_last_tick_at,
    new Date(T0 - 14 * HOUR).toISOString());

  eq('a tick inside two intervals keeps the connection healthy',
    h({}, true, new Date(T0 - 10 * 60_000).toISOString()).state, 'healthy');
  eq('the driver window is two intervals, floored at 30 min',
    connection.driverStaleAfterMs({ interval_minutes: 5 }), 30 * 60_000);
  eq('and capped at six hours however leisurely the schedule',
    connection.driverStaleAfterMs({ interval_minutes: 10080 }), 6 * 3_600_000);
  eq('a 6-hourly schedule allows a 12-hour silence from the driver',
    connection.driverStaleAfterMs({ interval_minutes: 360 }), 6 * 3_600_000);

  // A caller with no evidence must not be given the benefit of the doubt.
  eq('omitting driverTickAt entirely is treated as no driver',
    connection.connectionHealth(Object.assign({}, base), { now: T0 }).state, 'no_driver');

  // The heartbeat round-trips through the settings table.
  eq('no driver has ever ticked on a fresh database', connection.autoDriverTickAt(db), '');
  connection.recordAutoDriverTick(db, T0);
  truthy('recording a tick makes it readable back',
    connection.autoDriverTickAt(db).startsWith(new Date(T0).toISOString().slice(0, 16)),
    connection.autoDriverTickAt(db));

  // THE LAW OF THIS MODULE. Every not-working state must be honest about it.
  const notWorking = [
    h({}, false), h({ status: 'disconnected' }), h({ status: 'needs_reconnect' }),
    h({ location_name: '' }), h({ auto_enabled: 0 }), h({ consecutive_failures: 1 }),
    h({ last_success_at: new Date(T0 - 40 * HOUR).toISOString() }),
    h({ last_success_at: '' }),
    noDriver, driverDied,
  ];
  eq('NO broken state ever reports healthy',
    notWorking.every(x => x.state !== 'healthy'), true);
  eq('and none of them claims to be automatic',
    notWorking.every(x => x.automatic === false), true);
  truthy('every unhealthy state tells the owner what to do about it',
    notWorking.every(x => typeof x.action === 'string' && x.action.length > 10));
  truthy('a paused connection says out loud that nothing arrives on its own',
    /only arrive when someone presses|switched off/.test(h({ auto_enabled: 0 }).headline));
  truthy('the not-connected message refuses the Maps-URL idea explicitly',
    /MANAGES the listing/.test(h({ status: 'disconnected' }).action) &&
    /Maps link cannot work/.test(h({ status: 'disconnected' }).action));

  // A failing connection reports the failure (which has a cure) rather than the
  // staleness it also has (which is only a symptom).
  eq('failing outranks stale when a connection is both',
    h({ consecutive_failures: 2, last_success_at: new Date(T0 - 90 * HOUR).toISOString() }).state,
    'failing');

  eq('staleness for a 6-hourly schedule is three cycles',
    connection.staleAfterHours({ auto_enabled: 1, interval_minutes: 360 }), 18);
  eq('a leisurely schedule is still stale after two days',
    connection.staleAfterHours({ auto_enabled: 1, interval_minutes: 10080 }), 48);
  eq('with no schedule at all, a week is the threshold',
    connection.staleAfterHours({ auto_enabled: 0, interval_minutes: 360 }), 168);

  /* ── R. Due-ness and the lock ─────────────────────────────────────────── */
  section('R. A scheduled pull runs when it is due, once, and never twice at a time');

  const due = (patch, now) => connection.isRefreshDue(Object.assign({}, base, patch), now || T0);
  eq('the schedule switched off is never due', due({ auto_enabled: 0 }), false);
  eq('a disconnected account is never due', due({ status: 'disconnected' }), false);
  eq('no listing chosen is never due', due({ location_name: '' }), false);
  eq('nothing ever run is due now', due({}), true);
  eq('an interval that has not elapsed is not due',
    due({ last_auto_run_at: new Date(T0 - 60 * 60_000).toISOString() }), false);
  eq('an elapsed interval is due',
    due({ last_auto_run_at: new Date(T0 - 7 * HOUR).toISOString() }), true);
  // Measuring from success would retry a broken credential on every tick,
  // turning one dead token into hundreds of token requests a day.
  eq('due-ness is measured from the last ATTEMPT, not the last success',
    due({ last_success_at: new Date(T0 - 90 * HOUR).toISOString(),
          last_attempt_at: new Date(T0 - 5 * 60_000).toISOString() }), false);

  connection.saveConnection(db, LOC, { lock_until: '' });
  eq('the lock can be taken', connection.claimRefreshLock(db, LOC, T0), true);
  eq('and a second caller is turned away', connection.claimRefreshLock(db, LOC, T0), false);
  connection.releaseRefreshLock(db, LOC);
  eq('releasing it lets the next run through', connection.claimRefreshLock(db, LOC, T0), true);
  eq('a stale lock expires rather than wedging the schedule forever',
    connection.claimRefreshLock(db, LOC, T0 + 20 * 60_000), true);
  connection.releaseRefreshLock(db, LOC);

  /* ── S. Discovery ─────────────────────────────────────────────────────── */
  section('S. Discovery gives the owner a list to pick from, with the names joined right');

  const accs = gbp.parseAccountsResponse(JSON.stringify({
    accounts: [{ name: 'accounts/111', accountName: 'AKAN Restaurants', type: 'LOCATION_GROUP' }],
  }));
  eq('an account is read', accs.accounts.length, 1);
  eq('with its human label', accs.accounts[0].label, 'AKAN Restaurants');

  // Business Information v1 returns `locations/{id}` WITHOUT the account
  // prefix, while the v4 reviews endpoint needs the full path. Getting this
  // wrong is a 404 at fetch time that reads like a permissions problem.
  const locs = gbp.parseLocationsResponse(JSON.stringify({
    locations: [
      { name: 'locations/222', title: 'AKAN Jubilee Hills',
        storefrontAddress: { addressLines: ['Road No 36'], locality: 'Hyderabad', postalCode: '500033' } },
      { name: 'accounts/111/locations/333', title: 'AKAN Gachibowli' },
    ],
  }), 'accounts/111');
  eq('a bare location name is joined onto its account', locs.locations[0].name, 'accounts/111/locations/222');
  eq('an already-qualified name is left alone', locs.locations[1].name, 'accounts/111/locations/333');
  eq('the address is assembled for the picker',
    locs.locations[0].address, 'Road No 36, Hyderabad, 500033');
  eq('every discovered name is a valid pull target',
    locs.locations.every(l => gbp.isValidParent(l.name)), true);
  eq('garbage from Google yields nothing rather than throwing',
    gbp.parseLocationsResponse('<html>502</html>', 'accounts/1').locations.length, 0);

  let selThrew = '';
  try { flow.selectLocation(db, { locationKey: LOC, name: 'https://maps.google.com/?cid=123' }); }
  catch (e) { selThrew = String(e.message); }
  truthy('a pasted Maps URL is refused as a listing, with a sentence',
    /accounts\/\{accountId\}/.test(selThrew), selThrew);

  /* ── T. The pull ──────────────────────────────────────────────────────── */
  section('T. The pull paginates, survives a mid-pull token expiry, and stores once');

  const realFetch = global.fetch;
  let tokenCalls = 0;
  const calls = [];

  // A scripted stand-in for Google. Shapes come from the published reference;
  // no real endpoint is involved, which is the whole caveat on this section.
  function mockGoogle(script) {
    global.fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        tokenCalls++;
        return { ok: true, status: 200, json: async () => ({
          access_token: 'access-' + tokenCalls, expires_in: 3600, scope: 'business.manage',
        }), text: async () => '' };
      }
      return script(url, init);
    };
  }

  schema.setReviewSetting(db, 'reviews_gbp_client_id', 'cid');
  schema.setReviewSetting(db, 'reviews_gbp_client_secret', 'csecret');
  schema.setReviewSetting(db, 'reviews_gbp_refresh_token', 'rtoken');
  schema.setReviewSetting(db, 'reviews_gbp_access_token', '');
  connection.saveConnection(db, LOC, {
    status: 'connected', google_email: 'owner@akan.example',
    location_name: 'accounts/111/locations/222', location_label: 'AKAN Jubilee Hills',
    token_expires_at: '', consecutive_failures: 0, last_error: '', auto_enabled: 0,
  });

  const page = (ids, next) => JSON.stringify({
    reviews: ids.map(id => ({
      reviewId: id,
      reviewer: { displayName: 'Guest ' + id },
      starRating: 'FIVE',
      comment: 'Lovely evening at the restaurant, the biryani was excellent and service quick.',
      createTime: '2026-04-1' + (ids.indexOf(id) + 1) + 'T12:00:00Z',
      updateTime: '2026-04-1' + (ids.indexOf(id) + 1) + 'T12:00:00Z',
    })),
    averageRating: 4.5,
    totalReviewCount: ids.length,
    nextPageToken: next || undefined,
  });

  // (i) three pages, walked by nextPageToken
  mockGoogle((url) => {
    const u = new URL(url);
    const pt = u.searchParams.get('pageToken') || '';
    if (pt === '') return { ok: true, status: 200, text: async () => page(['A1', 'A2'], 'p2') };
    if (pt === 'p2') return { ok: true, status: 200, text: async () => page(['A3'], 'p3') };
    return { ok: true, status: 200, text: async () => page(['A4'], '') };
  });

  const cfg = gbp.gbpConfig(db, LOC);
  eq('the pull target comes from the chosen listing, not a pasted setting',
    cfg.parent, 'accounts/111/locations/222');

  const docs1 = await gbp.gbpCollect(cfg, { db, locationKey: LOC });
  eq('every page is fetched until the token runs out', docs1.length, 3);
  truthy('pageSize is Google\'s documented maximum of 50',
    calls.some(u => /pageSize=50/.test(u)));
  eq('one token exchange served the whole pull, not one per page', tokenCalls, 1);

  const ing1 = ingestDocuments(db, docs1, { source: 'gbp_api', locationKey: LOC, actor: 'test' });
  eq('all four reviews across three pages are stored', ing1.inserted, 4);
  eq('and each page was archived raw before being parsed', ing1.raw_ids.length, 3);

  // (ii) the same pull again changes nothing — the idempotency guarantee, now
  // proved on the API path and not only on the importer.
  const ing2 = ingestDocuments(db, await gbp.gbpCollect(cfg, { db, locationKey: LOC }),
    { source: 'gbp_api', locationKey: LOC, actor: 'test' });
  eq('re-running the pull inserts nothing', ing2.inserted, 0);
  eq('and updates nothing', ing2.updated, 0);
  eq('it just re-sees what it had', ing2.unchanged, 4);

  // (iii) the SAME review arriving by Takeout de-duplicates against the API row.
  // This is the property that lets a backfill and the connector coexist.
  const takeoutSame = JSON.stringify([{
    reviewId: 'A1', reviewer: { displayName: 'Guest A1' }, starRating: 'FIVE',
    comment: 'Lovely evening at the restaurant, the biryani was excellent and service quick.',
    createTime: '2026-04-11T12:00:00Z', updateTime: '2026-04-11T12:00:00Z',
  }]);
  const ing3 = ingestDocuments(db, doc(takeoutSame, 'backfill.json'),
    { source: 'takeout_json', locationKey: LOC, actor: 'test' });
  eq('a Takeout backfill of a review the API already has inserts nothing', ing3.inserted, 0);
  eq('the listing still holds exactly four reviews',
    listReviews(db, { locationKey: LOC }).length, 4);

  // (iv) an author edit updates in place rather than duplicating.
  mockGoogle(() => ({ ok: true, status: 200, text: async () => JSON.stringify({
    reviews: [{
      reviewId: 'A1', reviewer: { displayName: 'Guest A1' }, starRating: 'TWO',
      comment: 'Coming back to edit this: the second visit was much worse, we waited an hour.',
      createTime: '2026-04-11T12:00:00Z', updateTime: '2026-04-20T09:00:00Z',
      reviewReply: { comment: 'We are sorry.', updateTime: '2026-04-20T15:00:00Z' },
    }],
  }) }));
  const ing4 = ingestDocuments(db, await gbp.gbpCollect(cfg, { db, locationKey: LOC }),
    { source: 'gbp_api', locationKey: LOC, actor: 'test' });
  eq('an edited review updates rather than duplicating', ing4.updated, 1);
  eq('the listing still holds four reviews, not five',
    listReviews(db, { locationKey: LOC }).length, 4);
  const edited = listReviews(db, { locationKey: LOC }).find(r => r.external_id === 'A1');
  eq('the new rating replaced the old one', edited.rating, 2);
  truthy('and the owner reply came across', /sorry/.test(edited.reply_text));

  // (v) a 401 between pages is an expired access token, not a dead connection.
  tokenCalls = 0;
  let served401 = false;
  mockGoogle((url) => {
    const pt = new URL(url).searchParams.get('pageToken') || '';
    if (pt === '' ) return { ok: true, status: 200, text: async () => page(['B1'], 'p2') };
    if (!served401) {
      served401 = true;
      return { ok: false, status: 401, text: async () => JSON.stringify({ error: { message: 'Invalid Credentials' } }) };
    }
    return { ok: true, status: 200, text: async () => page(['B2'], '') };
  });
  const docs401 = await gbp.gbpCollect(cfg, { db, locationKey: LOC });
  eq('a 401 mid-pull is retried once with a fresh token, not surfaced as failure', docs401.length, 2);
  truthy('and that retry did exchange a new token', tokenCalls >= 1);

  // (vi) a server that repeats its pageToken must not spin against the quota.
  mockGoogle(() => ({ ok: true, status: 200, text: async () => page(['C1'], 'same-forever') }));
  const spin = await gbp.gbpCollect(cfg, { db, locationKey: LOC, maxPages: 50 });
  truthy('a repeated pageToken stops the walk instead of looping 50 times',
    spin.length <= 2, spin.length + ' pages fetched');

  /* ── U. Failure is loud, success clears it ────────────────────────────── */
  section('U. Nothing fails silently');

  mockGoogle(() => ({ ok: true, status: 200, text: async () => page(['D1'], '') }));
  await refresh.runReviewRefresh({ db, locationKey: LOC, actor: 'test' });
  let conn = connection.getConnection(db, LOC);
  truthy('a successful pull records when it happened', !!conn.last_success_at);
  eq('and clears the failure streak', conn.consecutive_failures, 0);
  eq('and reports connected', conn.status, 'connected');

  mockGoogle(() => ({ ok: false, status: 500, text: async () => 'upstream exploded' }));
  let refreshThrew = false;
  try { await refresh.runReviewRefresh({ db, locationKey: LOC, actor: 'test' }); }
  catch { refreshThrew = true; }
  eq('a failed manual refresh throws, because a person is waiting for the answer', refreshThrew, true);
  conn = connection.getConnection(db, LOC);
  eq('the failure is counted', conn.consecutive_failures, 1);
  truthy('and the reason is kept for the page to show', /500|exploded/.test(conn.last_error));
  eq('health now reports it as failing',
    connection.connectionHealth(conn, { hasApp: true }).state, 'failing');

  // The worst failure available to this feature: Google refuses the refresh
  // token, so nothing will EVER arrive again until a human reconnects.
  global.fetch = async (input) => {
    if (String(input).startsWith('https://oauth2.googleapis.com/token')) {
      return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }), text: async () => '' };
    }
    return { ok: true, status: 200, text: async () => page([], '') };
  };
  schema.setReviewSetting(db, 'reviews_gbp_access_token', '');
  connection.saveConnection(db, LOC, { token_expires_at: '' });
  let reconnectThrew = false;
  try { await refresh.runReviewRefresh({ db, locationKey: LOC, actor: 'test' }); }
  catch (e) { reconnectThrew = e && e.name === 'ReconnectRequiredError'; }
  eq('a refused refresh token raises the terminal error', reconnectThrew, true);
  conn = connection.getConnection(db, LOC);
  eq('the connection is marked needs_reconnect, not merely failing', conn.status, 'needs_reconnect');
  eq('health shouts about it', connection.connectionHealth(conn, { hasApp: true }).state, 'needs_reconnect');
  eq('at error severity', connection.connectionHealth(conn, { hasApp: true }).severity, 'error');
  eq('the dead access token is thrown away rather than retried',
    schema.reviewSetting(db, 'reviews_gbp_access_token', ''), '');
  truthy('and the message names the 7-day Testing trap, which is the usual cause',
    /7 days|Testing/.test(conn.last_error), conn.last_error);

  // The scheduled wrapper must survive all of that, because a scheduler tick
  // runs other jobs and one exception takes the whole tick down.
  connection.saveConnection(db, LOC, { auto_enabled: 1, last_auto_run_at: '', lock_until: '' });
  const autoRes = await refresh.runReviewAutoRefresh({ db, locationKey: LOC });
  truthy('the scheduled wrapper never throws, whatever Google does',
    autoRes && typeof autoRes.outcome === 'string', JSON.stringify(autoRes));
  eq('it reports the connection needs a human', autoRes.outcome, 'not_configured');

  connection.saveConnection(db, LOC, { auto_enabled: 0 });
  eq('and it does nothing at all when the schedule is off',
    (await refresh.runReviewAutoRefresh({ db, locationKey: LOC })).outcome, 'not_due');

  // Disconnecting is not a request to delete a year of guest feedback.
  const beforeDisconnect = listReviews(db, { locationKey: LOC }).length;
  connection.disconnect(db, LOC);
  eq('disconnecting clears the credentials',
    schema.reviewSetting(db, 'reviews_gbp_refresh_token', ''), '');
  eq('and forgets the listing', connection.getConnection(db, LOC).location_name, '');
  eq('but KEEPS every review already imported',
    listReviews(db, { locationKey: LOC }).length, beforeDisconnect);
  truthy('there were reviews to keep', beforeDisconnect >= 4);

  global.fetch = realFetch;
}

/* ══════════════════════════════════════════════════════════════════════════
 * THE SCREEN'S OWN DECISIONS — gates V to X.
 *
 * Everything above proves the ENGINE. These prove the two decisions the PAGE
 * makes on the way to the pixels, which were previously untested because they
 * lived inside a React component:
 *
 *   V  a zero is described correctly, and a missing average never becomes 0.0
 *   W  a broken connection is loud, and a paused one is not
 *   X  the small formatters, including an overdue schedule counting up
 *
 * These are pure. No database, no clock, no DOM — src/lib/reviews/view.ts is
 * imported directly and called, which is the same code path the page renders
 * from (PeriodTile and ConnectionPanel both delegate to it rather than
 * re-deciding). If someone "simplifies" the component by inlining the logic
 * again, these gates keep passing while the page regresses — so the component
 * carries a comment saying not to, and this is the note that explains why it
 * matters.
 * ══════════════════════════════════════════════════════════════════════════ */

function pageGates() {
  const view = lib('reviews/view.ts');
  const conn = lib('reviews/connection.ts');

  /* ── V. A ZERO IS TWO DIFFERENT FACTS ─────────────────────────────────── */

  section('V. The page cannot confuse "no reviews" with "not imported"');

  const tile = (over) => view.periodTileView(Object.assign({
    count: 0, average: null, import_covers: true, prev_import_covers: true,
    prev_count: 0, prev_average: null, label: 'This week',
  }, over));

  const quiet = tile({ count: 0, import_covers: true });
  eq('an imported, genuinely empty period reads as "No reviews"', quiet.state, 'no_reviews');
  eq('and says so in words', quiet.countText, 'No reviews');
  eq('with NO rating value for a star widget to draw', quiet.ratingValue, null);
  truthy('and explains that the emptiness is real', /genuinely empty/.test(quiet.note), quiet.note);

  const gap = tile({ count: 0, import_covers: false });
  eq('the SAME zero, never imported, reads as "Not imported"', gap.state, 'not_imported');
  eq('and refuses the words "no reviews"', /no reviews/i.test(gap.countText), false);
  eq('still with no rating', gap.ratingValue, null);
  truthy('and names it a gap in the data', /gap in the data/.test(gap.note), gap.note);
  truthy('the two states are distinguishable, which is the whole point',
    quiet.state !== gap.state && quiet.countText !== gap.countText);

  /* THE 0.0-STARS TRAP, four ways. */

  eq('a null average never becomes a number', tile({ count: 4, average: null }).ratingValue, null);
  eq('and says "no rating" rather than printing one', tile({ count: 4, average: null }).ratingText, 'no rating');
  eq('an average of exactly 0 is NOT drawn as a rating', tile({ count: 4, average: 0 }).ratingValue, null);
  eq('nor is a sub-1 average, which no 1..5 rating set can produce',
    tile({ count: 4, average: 0.4 }).ratingValue, null);
  truthy('and an out-of-range average is called a data fault, not a bad month',
    /data fault/.test(tile({ count: 4, average: 0 }).note), tile({ count: 4, average: 0 }).note);
  eq('a NaN average is withheld too', tile({ count: 4, average: NaN }).ratingValue, null);

  const real = tile({ count: 12, average: 3.4166666666666665, prev_count: 8, prev_average: 4.1 });
  eq('a real average passes through untouched, to the last bit',
    real.ratingValue, 3.4166666666666665);
  eq('with the count described in words', real.countText, '12 reviews');
  eq('one review is singular', tile({ count: 1, average: 5 }).countText, '1 review');
  eq('a genuine 1.0 average IS a rating and is drawn', tile({ count: 2, average: 1 }).ratingValue, 1);
  eq('a genuine 5.0 average is drawn', tile({ count: 2, average: 5 }).ratingValue, 5);

  /* THE COMPARISON MUST NOT MEASURE OUR OWN IMPORT HISTORY. */

  eq('a delta is shown when both periods were imported', real.showDelta, true);
  const noPrev = tile({ count: 5, average: 4, prev_count: 0, prev_import_covers: false });
  eq('but NOT when the previous period was never imported', noPrev.showDelta, false);
  truthy('and it says why, rather than showing a silent dash',
    /measuring the import, not the reviews/.test(noPrev.deltaNote), noPrev.deltaNote);
  eq('an empty period offers no comparison either', quiet.showDelta, false);

  /* ── W. A BROKEN CONNECTION IS LOUD; A PAUSED ONE IS NOT ───────────────── */

  section('W. The connection banner is loud for breakage only');

  const REC = (over) => Object.assign({
    location_key: '', status: 'connected', google_email: 'owner@example.com',
    account_name: 'accounts/1', account_label: 'AKAN', location_name: 'accounts/1/locations/2',
    location_label: 'AKAN Hyderabad', location_address: '', scope: '',
    connected_at: '2026-09-01T00:00:00Z', connected_by: 'owner',
    token_expires_at: '', last_attempt_at: '', last_success_at: '', last_error: '',
    last_error_at: '', consecutive_failures: 0, auto_enabled: 1, interval_minutes: 360,
    last_auto_run_at: '', lock_until: '', updated_at: '',
  }, over);

  const NOW = Date.parse('2026-09-10T12:00:00Z');
  // A live scheduler by default — these cases are about the BANNER, not about
  // the driver, and without a heartbeat every one of them would be 'no_driver'.
  const DRIVER_TICK = '2026-09-10T11:55:00Z';
  const banner = (over, hasApp, tick) => view.connectionBanner(
    conn.connectionHealth(REC(over), {
      now: NOW, hasApp: hasApp !== false,
      driverTickAt: tick === undefined ? DRIVER_TICK : tick,
    }),
  );

  // Healthy: no banner at all.
  const healthy = banner({ last_success_at: '2026-09-10T10:00:00Z' });
  eq('a healthy connection raises no banner', healthy.show, false);
  eq('and is not loud', healthy.loud, false);
  eq('and does not warn that the data is behind', healthy.dataMayBeBehind, false);
  eq('offering no call to action', healthy.cta, '');

  // The two states the owner must never miss.
  const refused = banner({ status: 'needs_reconnect', last_error: 'invalid_grant' });
  eq('a refused token is LOUD', refused.loud, true);
  eq('with the reconnect action', refused.cta, 'reconnect');
  eq('labelled for a human', refused.ctaLabel, 'Reconnect Google Business Profile');
  truthy('and the sentence comes from the engine verbatim',
    /stopped accepting this connection/.test(refused.headline), refused.headline);

  const failingHard = banner({ consecutive_failures: 3, last_error: 'HTTP 500' });
  eq('three consecutive failures are LOUD', failingHard.loud, true);
  eq('and point at Refresh now', failingHard.cta, 'refresh');

  // …and the states that are NOT breakage, which must stay quiet.
  const failingOnce = banner({ consecutive_failures: 1, last_error: 'HTTP 500' });
  eq('a single failure is a warning, not a red band', failingOnce.loud, false);
  eq('but it still shows', failingOnce.show, true);
  eq('and still offers a retry', failingOnce.cta, 'refresh');

  const paused = banner({ auto_enabled: 0, last_success_at: '2026-09-10T10:00:00Z' });
  eq('a paused schedule is NOT loud — it is a decision, not a breakage', paused.loud, false);
  eq('but it is shown', paused.show, true);
  eq('and offers to arm the schedule', paused.cta, 'enable_schedule');
  eq('and warns that nothing is arriving on its own', paused.dataMayBeBehind, true);

  // THE STATE THIS WHOLE MODULE EXISTS TO PREVENT: armed, credentialed, and
  // silently fetching nothing. It must never look automatic.
  const stale = banner({ auto_enabled: 1, interval_minutes: 360, last_success_at: '2026-09-08T12:00:00Z' });
  eq('an armed connection that has fetched nothing for 48h reads as stale', stale.show, true);
  eq('and reports the data as possibly behind', stale.dataMayBeBehind, true);

  // …AND THE STATE THAT SHIPPED: armed, credentialed, freshly fetched by hand,
  // and no scheduler in existence. A green badge over that is the module's own
  // headline promise made up.
  const undriven = banner({ last_success_at: '2026-09-10T10:00:00Z' }, true, '');
  eq('an armed connection with no scheduler raises a banner', undriven.show, true);
  eq('it is a warning, not a red band — nothing is broken, it was never wired', undriven.loud, false);
  eq('and it warns that the data may be behind', undriven.dataMayBeBehind, true);
  eq('offering the one action a manager actually has', undriven.cta, 'refresh');
  eq('offering the manual pull', stale.cta, 'refresh');

  const neverFetched = banner({ auto_enabled: 1, last_success_at: '' });
  eq('armed but never successfully fetched is also not automatic', neverFetched.dataMayBeBehind, true);
  eq('and asks for the first pull', neverFetched.cta, 'refresh');

  // The two setup states.
  eq('no OAuth app yet points at setup', banner({}, false).cta, 'setup');
  eq('and is not loud, because nothing is broken', banner({}, false).loud, false);
  const fresh = banner({ status: 'disconnected', google_email: '', location_name: '' });
  eq('a configured app with nobody signed in asks to connect', fresh.cta, 'connect');
  eq('with the label the page shows on its main button',
    fresh.ctaLabel, 'Connect Google Business Profile');
  truthy('and the engine tells the owner a Maps link cannot work',
    /Maps link cannot work/.test(fresh.action), fresh.action);
  eq('connected with no listing chosen asks for the listing',
    banner({ location_name: '' }).cta, 'choose_location');

  // Every state is covered, and none of them falls through to a blank banner.
  const STATES = ['no_app', 'not_connected', 'needs_reconnect', 'no_location', 'paused', 'failing', 'stale', 'healthy'];
  const seen = {
    no_app: banner({}, false), not_connected: fresh, needs_reconnect: refused,
    no_location: banner({ location_name: '' }), paused: paused, failing: failingOnce,
    stale: stale, healthy: healthy,
  };
  truthy('all eight health states produce a banner with a headline',
    STATES.every(s => seen[s] && typeof seen[s].headline === 'string' && seen[s].headline.length > 0),
    STATES.filter(s => !seen[s] || !seen[s].headline).join(', '));
  truthy('and every state except healthy names something to do',
    STATES.filter(s => s !== 'healthy').every(s => seen[s].cta !== ''),
    STATES.filter(s => s !== 'healthy' && seen[s].cta === '').join(', '));

  /* ── X. THE SMALL FORMATTERS ───────────────────────────────────────────── */

  section('X. Times are readable, and an overdue schedule counts up');

  const T0 = Date.parse('2026-09-10T12:00:00Z');
  eq('a future fetch is "in about N hours"',
    view.nextFetchText('2026-09-10T15:00:00Z', T0), 'in about 3 hours');
  eq('a near one is in minutes', view.nextFetchText('2026-09-10T12:20:00Z', T0), 'in 20 minutes');
  // A cron that stopped is one of the two ways this feature dies quietly, so
  // an overdue schedule must SAY overdue rather than round to "due now".
  eq('a missed one says overdue, not "due now"',
    view.nextFetchText('2026-09-10T09:00:00Z', T0), 'overdue by 3 hours');
  eq('slightly overdue is still overdue',
    view.nextFetchText('2026-09-10T11:50:00Z', T0), 'overdue by 10 minutes');
  eq('nothing scheduled says so', view.nextFetchText('', T0), 'not scheduled');
  eq('and junk does not throw', view.nextFetchText('not-a-date', T0), 'not scheduled');

  eq('never fetched is "never"', view.agoText(null), 'never');
  eq('minutes read as minutes', view.agoText(0.5), '30 minutes ago');
  eq('hours read as hours', view.agoText(6), '6 hours ago');
  eq('and two days read as days', view.agoText(50), '2 days ago');

  eq('an interval is named in hours where it divides', view.intervalText(360), 'every 6 hours');
  eq('and in minutes where it does not', view.intervalText(30), 'every 30 minutes');
  eq('one hour is singular', view.intervalText(60), 'every 1 hour');
  eq('and zero is off', view.intervalText(0), 'off');

  eq('an ISO instant renders in IST, not UTC',
    view.fmtIst('2026-09-10T18:45:00Z', false), '11 Sept 2026');
  eq('and a missing one is a dash, never "Invalid Date"', view.fmtIst('', true), '—');
  eq('as is junk', view.fmtIst('nonsense', true), '—');
}

function finish() {
  console.log('\n' + '-'.repeat(70));
  console.log(pass + ' passed, ' + fail + ' failed');
  if (fail) {
    console.log('\nFAILED:');
    for (const f of failures) console.log('  - ' + f);
  }
  console.log('snapshot: ' + TMP);
  process.exit(fail ? 1 : 0);
}

/* ══════════════════════════════════════════════════════════════════════════
 * INTEGRITY — gates Y to AF.
 *
 * Nine defects were found by adversarial review AFTER the suite above was
 * green, which is exactly what makes them worth pinning: every one of them was
 * a case where the code produced a confident, plausible, WRONG number, and no
 * existing gate was pointed at it. Each section below names the failure it
 * prevents rather than the function it calls.
 * ══════════════════════════════════════════════════════════════════════════ */
function integrityGates() {
  const view = lib('reviews/view.ts');
  const DAY = 86_400_000;

  /* ── Y. ONE OLD DATE MUST NOT COST THE OWNER TODAY ───────────────────────
   * denseBuckets() enforced its scan cap by BREAKING OUT of the walk after
   * MAX_SCAN_DAYS days, which discards the NEWEST days — the opposite of what
   * both caps are documented to do. One review dated 15/03/2004 (a plausible
   * DD/MM typo for 2024, which parseTimestamp accepts) pushed the range past
   * 8000 days and the daily series then ENDED IN FEBRUARY: Today, This week and
   * This month all read zero while the all-time total still said 31 reviews. */
  section('Y. A dense series is trimmed at the OLD end, never the new one');

  const NOW_Y = Date.parse('2026-09-10T09:00:00Z');
  const wideDaily = time.denseBuckets(Date.parse('2004-03-15T19:00:00Z'), NOW_Y, 'daily');
  eq('a range longer than the scan cap is reported as truncated', wideDaily.truncated, true);
  eq('and it still ENDS today', wideDaily.buckets[wideDaily.buckets.length - 1].key,
    time.istDayKey(NOW_Y));
  eq('having given up the oldest end instead',
    wideDaily.buckets[0].key > '2004-03-15', true);
  eq('the emitted count respects the bucket cap', wideDaily.buckets.length, time.MAX_BUCKETS);

  const wideMonthly = time.denseBuckets(Date.parse('2004-03-15T19:00:00Z'), NOW_Y, 'monthly');
  eq('the monthly series ends on this month too',
    wideMonthly.buckets[wideMonthly.buckets.length - 1].key, time.istMonthKey(NOW_Y));

  // The whole failure, end to end, exactly as the route assembles it.
  const rowsY = [{ id: 'typo', rating: 5, text: 'great', posted_at: '2004-03-15T13:30:00Z', reply_text: '', replied_at: '' }];
  for (let i = 1; i <= 30; i++) {
    rowsY.push({ id: 'r' + i, rating: i % 5 === 0 ? 1 : 4, text: 'recent',
      posted_at: time.toIsoUtc(NOW_Y - i * 8 * 3_600_000), reply_text: '', replied_at: '' });
  }
  const aY = analysis.analyzeReviews(rowsY, {
    now: NOW_Y, from: time.toIsoUtc(Math.min(Date.parse('2004-03-15T13:30:00Z'), NOW_Y - 40 * DAY)),
    to: time.toIsoUtc(NOW_Y),
  });
  const cleanY = analysis.analyzeReviews(rowsY.slice(1), {
    now: NOW_Y, from: time.toIsoUtc(NOW_Y - 40 * DAY), to: time.toIsoUtc(NOW_Y),
  });
  eq('ONE parser-legal 2004 date no longer zeroes the daily headline',
    [aY.trend.daily.current.key, aY.trend.daily.current.count],
    [cleanY.trend.daily.current.key, cleanY.trend.daily.current.count]);
  eq('nor the weekly headline',
    [aY.trend.weekly.current.key, aY.trend.weekly.current.count],
    [cleanY.trend.weekly.current.key, cleanY.trend.weekly.current.count]);
  eq('nor the monthly headline',
    [aY.trend.monthly.current.key, aY.trend.monthly.current.count],
    [cleanY.trend.monthly.current.key, cleanY.trend.monthly.current.count]);
  eq('and the 30 recent reviews are all inside the window',
    aY.series.daily.buckets.reduce((n, b) => n + b.count, 0), 30);

  /* ── Z. THE CURRENT PERIOD IS NOT OVER, AND THE TILE MUST SAY SO ─────────
   * A venue with a perfectly flat 1 review/day read as collapsing every day of
   * every month: "volume -22 vs last month" on the 10th, because ten days were
   * being compared with thirty-one. Nothing said the period was still running. */
  section('Z. A part-period is labelled, and never compared as a whole one');

  const running = view.periodProgress({ period: 'monthly', start_date: '2026-09-01', end_date: '2026-09-10' });
  eq('a month ending on the 10th is still running', running.partial, true);
  eq('and says how far in it is', running.text, '10 days of 30');
  const finished = view.periodProgress({ period: 'monthly', start_date: '2026-08-01', end_date: '2026-08-31' });
  eq('a month that reached its own last day is complete', finished.partial, false);
  eq('February is 28 days, not 30',
    view.periodProgress({ period: 'monthly', start_date: '2026-02-01', end_date: '2026-02-10' }).total_days, 28);
  eq('the %W week-00 stub is 4 days in 2026, not 7',
    view.periodProgress({ period: 'weekly', start_date: '2026-01-01', end_date: '2026-01-02' }).total_days, 4);
  eq('a whole week is complete', view.periodProgress({ period: 'weekly', start_date: '2026-08-31', end_date: '2026-09-06' }).partial, false);
  eq('today is partial when the clock says the day is not over',
    view.periodProgress({ period: 'daily', start_date: '2026-09-10', end_date: '2026-09-10' },
      { todayKey: '2026-09-10' }).partial, true);
  eq('yesterday is not', view.periodProgress({ period: 'daily', start_date: '2026-09-09', end_date: '2026-09-09' },
    { todayKey: '2026-09-10' }).partial, false);
  eq('and with no dates at all nothing is guessed',
    view.periodProgress({ period: 'monthly' }).partial, false);

  const partTile = view.periodTileView({
    label: 'This month', period: 'monthly', start_date: '2026-09-01', end_date: '2026-09-10',
    count: 9, average: 4, import_covers: true, prev_import_covers: true,
    prev_count: 31, prev_average: 4, count_delta: -22, avg_delta: 0,
  });
  eq('the heading gains "so far"', partTile.headingText, 'This month so far');
  eq('and the count says so too', partTile.countText, '9 reviews so far');
  eq('the raw volume delta is NOT printed', partTile.showDelta, false);
  truthy('the sentence states both counts without calling the difference a change',
    /Only 10 days of 30 have happened/.test(partTile.deltaNote) && /9 so far against 31/.test(partTile.deltaNote)
    && !/-22/.test(partTile.deltaNote), partTile.deltaNote);

  // The daily tile has no "N of M" to report — it is simply not over — and the
  // wording has to hold up there too rather than reading "today, still running
  // in the day".
  const todayTile = view.periodTileView({
    label: 'Today', period: 'daily', start_date: '2026-09-10', end_date: '2026-09-10',
    count: 3, average: 4.2, import_covers: true, prev_import_covers: true,
    prev_count: 8, prev_average: 4, count_delta: -5, avg_delta: 0.2,
  }, { todayKey: '2026-09-10' });
  eq('today is labelled as running', todayTile.headingText, 'Today so far');
  eq('with no day-count to print', todayTile.progressText, '');
  truthy('and a sentence that reads as English',
    /^The day is not over, so the count cannot be compared with a whole day yet: 3 so far against 8/
      .test(todayTile.deltaNote), todayTile.deltaNote);
  truthy('rating movement still reported at daily resolution',
    /rating is up 0.20 stars on yesterday/.test(todayTile.deltaNote), todayTile.deltaNote);
  truthy('and the rating comparison, which IS valid mid-period, survives',
    /rating is unchanged on last month/.test(partTile.deltaNote), partTile.deltaNote);

  const wholeTile = view.periodTileView({
    label: 'This month', period: 'monthly', start_date: '2026-08-01', end_date: '2026-08-31',
    count: 31, average: 4.2, import_covers: true, prev_import_covers: true,
    prev_count: 30, prev_average: 4, count_delta: 1, avg_delta: 0.2,
  });
  eq('a finished period keeps its plain heading', wholeTile.headingText, 'This month');
  eq('and gets the ordinary delta back', wholeTile.showDelta, true);

  /* ── AA. A STRAY QUOTE MUST NOT SILENTLY DISCARD THE FILE ────────────────
   * `"He said "great" and left` — an odd number of quotes, which is what a
   * reviewer who typed a " produces — made the reader swallow the rest of the
   * file into one cell. A 500-row export stored 2 rows and the run closed
   * green: "Rows read 2 · Added 2 · Refused 1". */
  section('AA. An unbalanced quote fails the file instead of importing 0.4% of it');

  const bigCsv = (bad) => {
    const lines = ['reviewId,reviewer,starRating,comment,createTime'];
    for (let i = 0; i < 500; i++) {
      const d = new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      lines.push('u' + i + ',Guest' + i + ',' + (1 + (i % 5)) + ',' + (i === 2 ? bad : '"Review ' + i + '"') + ',' + d);
    }
    return lines.join('\n') + '\n';
  };

  const scanBad = parse.parseCsvWithDiagnostics(bigCsv('"He said "great" and left'));
  eq('the scanner reports that it ended inside a quote', scanBad.unterminated_quote, true);
  eq('a clean file reports no such thing',
    parse.parseCsvWithDiagnostics(bigCsv('"Review 2"')).unterminated_quote, false);

  const LOC_AA = 'aa-quote';
  const rAA = ingestDocuments(db, [{ kind: 'csv', payload: bigCsv('"He said "great" and left'), label: 'export.csv' }],
    { source: 'csv_manual', locationKey: LOC_AA, actor: 'test' });
  eq('NOTHING from a derailed file is stored', listReviews(db, { locationKey: LOC_AA }).length, 0);
  eq('rather than the readable prefix', rAA.rows_seen, 0);
  eq('the document is counted as unreadable', rAA.fatal_documents, 1);
  eq('and the RUN FAILS — a partial import must never close green',
    listRuns(db, 50).find(r => r.id === rAA.run_id).status, 'error');
  truthy('the reason points at the row a human has to fix',
    /unbalanced quotation mark/.test(rAA.parse_errors[0].reason) && /Row 3/.test(rAA.parse_errors[0].reason),
    rAA.parse_errors[0].reason);

  const LOC_AA2 = 'aa-open';
  const rAA2 = ingestDocuments(db, [{ kind: 'csv', payload: bigCsv('"never closed'), label: 'export.csv' }],
    { source: 'csv_manual', locationKey: LOC_AA2, actor: 'test' });
  eq('a quote that simply never closes behaves identically',
    [rAA2.rows_seen, rAA2.fatal_documents, listReviews(db, { locationKey: LOC_AA2 }).length], [0, 1, 0]);

  const LOC_AA3 = 'aa-fine';
  const rAA3 = ingestDocuments(db, [{ kind: 'csv', payload: bigCsv('He said "great" and left'), label: 'export.csv' }],
    { source: 'csv_manual', locationKey: LOC_AA3, actor: 'test' });
  eq('a BALANCED inner quote is still imported in full — the guard is not a blanket ban',
    [rAA3.rows_seen, rAA3.inserted, rAA3.fatal_documents], [500, 500, 0]);

  // A row with MORE cells than the header is shifted data, not a readable row.
  const LOC_AA4 = 'aa-shift';
  const rAA4 = ingestDocuments(db, [{ kind: 'csv', label: 'shift.csv', payload:
    'reviewId,reviewer,starRating,comment,createTime\n' +
    'a1,Asha,5,fine,2026-05-01T10:00:00Z\n' +
    'a2,Bala,4,too,many,commas,2026-05-02T10:00:00Z\n' }],
    { source: 'csv_manual', locationKey: LOC_AA4, actor: 'test' });
  eq('a shifted row is refused, not read into the wrong fields',
    [rAA4.inserted, rAA4.overlong_rows, rAA4.errors], [1, 1, 1]);
  truthy('and the reason says what was wrong with it',
    /values but the header has/.test(rAA4.parse_errors[0].reason), rAA4.parse_errors[0].reason);

  const LOC_AA5 = 'aa-short';
  const rAA5 = ingestDocuments(db, [{ kind: 'csv', label: 'short.csv', payload:
    'reviewId,reviewer,starRating,comment,createTime\n' +
    'b1,Asha,5,fine,2026-05-01T10:00:00Z\n' +
    'b2,Bala,4,2026-05-02T10:00:00Z\n' }],
    { source: 'csv_manual', locationKey: LOC_AA5, actor: 'test' });
  eq('a SHORT row is still read — sloppy exports are not corrupt ones — but counted',
    rAA5.short_rows, 1);

  /* ── AB. REPLAY IS THE PAYOFF OF RAW-FIRST, AND IT MUST BE A NO-OP ───────
   * replayRawDocuments() merged every archived document for a (source,
   * location) into one run and numbered anonymous rows across the whole run, so
   * a review present in both the May and the June export was seen as two
   * distinct reviews. Three reviews became five, then ten, then twenty. It also
   * archived its own input, doubling the write-once store on every pass. */
  section('AB. Replaying an overlapping archive changes nothing, however often');

  const LOC_AB = 'ab-replay';
  const may = 'starRating,comment,createTime\n' +
    '5,"Lovely place",2026-05-01T10:00:00Z\n' +
    '2,"Long wait",2026-05-04T10:00:00Z\n';
  const june = may + '4,"Good biryani",2026-06-02T10:00:00Z\n';
  const impAB = (payload, label) => ingestDocuments(db, [{ kind: 'csv', payload, label }],
    { source: 'csv_manual', locationKey: LOC_AB, actor: 'test' });

  impAB(may, 'may.csv');
  const junRes = impAB(june, 'june.csv');
  eq('the June export adds only what is new', [junRes.inserted, junRes.unchanged], [1, 2]);
  eq('three anonymous reviews are held', listReviews(db, { locationKey: LOC_AB }).length, 3);

  const rawBefore = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(LENGTH(payload)),0) b FROM gr_ingest_raw WHERE location_key = ?').get(LOC_AB);
  for (let i = 1; i <= 4; i++) {
    const rep = replayRawDocuments(db, { actor: 'test' });
    eq('replay #' + i + ' inserts nothing', rep.inserted, 0);
    eq('and the row count holds at three', listReviews(db, { locationKey: LOC_AB }).length, 3);
  }
  const rawAfter = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(LENGTH(payload)),0) b FROM gr_ingest_raw WHERE location_key = ?').get(LOC_AB);
  eq('four replays add NOTHING to the write-once archive',
    [rawAfter.n, rawAfter.b], [rawBefore.n, rawBefore.b]);
  eq('and no label grows a replay: prefix',
    db.prepare("SELECT COUNT(*) n FROM gr_ingest_raw WHERE label LIKE 'replay:%'").get().n, 0);
  eq('the average the page would read is the truth, not a compounded one',
    db.prepare('SELECT ROUND(AVG(rating),3) a FROM gr_reviews WHERE location_key = ?').get(LOC_AB).a, 3.667);

  // The ordinal still separates two genuinely distinct identical rows INSIDE
  // one document, which is the case it exists for.
  const LOC_AB2 = 'ab-twins';
  const twins = 'starRating,comment,createTime\n' +
    '5,"",2026-05-01T10:00:00Z\n' +
    '5,"",2026-05-01T10:00:00Z\n';
  const rAB2 = ingestDocuments(db, [{ kind: 'csv', payload: twins, label: 'twins.csv' }],
    { source: 'csv_manual', locationKey: LOC_AB2, actor: 'test' });
  eq('two identical anonymous rows in ONE document stay two reviews', rAB2.inserted, 2);
  replayRawDocuments(db, { actor: 'test' });
  eq('and replaying them does not make four', listReviews(db, { locationKey: LOC_AB2 }).length, 2);

  /* ── AC. AN EXCEL EXPORT IS NOT UTF-8 ────────────────────────────────────
   * `await file.text()` is UTF-8-only and substitutes U+FFFD silently, so a
   * CP1252 CSV stored `Priy<FFFD> Reddy`, ARCHIVED it mangled (so replay could
   * never repair it), and — because the author name is part of the identity key
   * — made a corrected re-import duplicate the reviews instead of fixing them. */
  section('AC. Upload bytes are decoded by sniffing, not assumed to be UTF-8');

  const body = 'reviewer,starRating,comment,createTime\n' +
    '"Priy\u00e1 Reddy",5,"Caf\u00e9 was tr\u00e8s bon",2026-05-01T10:00:00Z\n' +
    '"Jos\u00e9",4,"Cr\u00e8me br\u00fbl\u00e9e",2026-05-02T10:00:00Z\n';

  const asUtf8 = parse.decodeUpload(new Uint8Array(Buffer.from(body, 'utf8')));
  eq('a UTF-8 file is read as UTF-8', [asUtf8.encoding, asUtf8.fell_back], ['utf-8', false]);
  eq('losing nothing', asUtf8.text, body);

  const as1252 = parse.decodeUpload(new Uint8Array(Buffer.from(body, 'latin1')));
  eq('an Excel CP1252 file is recognised and read', as1252.encoding, 'windows-1252');
  eq('with the accents intact, not replaced', as1252.replacement_chars, 0);
  eq('and the text identical to the UTF-8 version', as1252.text, body);
  eq('the fallback is declared rather than hidden', as1252.fell_back, true);

  const withBom = parse.decodeUpload(new Uint8Array(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'utf8')])));
  eq('a UTF-8 BOM is stripped', [withBom.encoding, withBom.text], ['utf-8-bom', body]);
  const utf16 = parse.decodeUpload(new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, 'utf16le')])));
  eq('and Excel\'s "Unicode Text" (UTF-16LE + BOM) is read too', [utf16.encoding, utf16.text], ['utf-16le', body]);

  // Devanagari must NOT be downgraded to CP1252 by the sniffer.
  const telugu = 'reviewer,starRating,comment,createTime\n"\u0c05\u0c28\u0c3f\u0c32\u0c4d",5,"\u0c2c\u0c3e\u0c17\u0c41\u0c02\u0c26\u0c3f",2026-05-01T10:00:00Z\n';
  const teluguDecoded = parse.decodeUpload(new Uint8Array(Buffer.from(telugu, 'utf8')));
  eq('an Indian-language export stays UTF-8', [teluguDecoded.encoding, teluguDecoded.text], ['utf-8', telugu]);

  // The correctly decoded file imports ONCE, not twice.
  const LOC_AC = 'ac-encoding';
  const impAC = (payload, label) => ingestDocuments(db, [{ kind: 'csv', payload, label }],
    { source: 'csv_manual', locationKey: LOC_AC, actor: 'test' });
  impAC(as1252.text, 'excel.csv');
  const again = impAC(asUtf8.text, 'reexport-utf8.csv');
  eq('the same reviews from a CP1252 file and a UTF-8 file are ONE set of rows',
    [again.inserted, listReviews(db, { locationKey: LOC_AC }).length], [0, 2]);
  eq('with the author name spelt properly',
    listReviews(db, { locationKey: LOC_AC }).some(r => r.author_name === 'Priy\u00e1 Reddy'), true);

  // And the backstop: an already-mangled payload is COUNTED, not accepted quietly.
  const mangled = parse.parseDocument('reviewer,starRating,comment,createTime\n"Priy\ufffd Reddy",5,"x",2026-05-01T10:00:00Z\n',
    { source: 'csv_manual', defaultLocationKey: 'x' });
  eq('a payload that arrives already mangled is counted, not ignored', mangled.replacement_chars, 1);

  /* ── AD. THE LISTING THE PERSON CHOSE IS THE LISTING THE ROWS LAND IN ────
   * FIELD_SYNONYMS.location_key claims `branch`, and the cell used to beat the
   * import target. A manager's sheet with a `Branch` column sent every row to a
   * location_key the page never queries, while the panel reported "2 added". */
  section('AD. A branch column in the file cannot redirect rows off the page');

  const sheet = 'Branch,Reviewer,Rating,Comment,Date\n' +
    'AKAN Jubilee Hills,Asha,5,"Lovely",01/05/2026\n' +
    'AKAN Jubilee Hills,Bala,2,"Slow",02/05/2026\n';
  const rAD = ingestDocuments(db, [{ kind: 'csv', payload: sheet, label: 'manager-sheet.csv' }],
    { source: 'csv_manual', locationKey: '', actor: 'test' });
  eq('the rows land under the listing that was chosen',
    db.prepare("SELECT COUNT(*) n FROM gr_reviews WHERE location_key = '' AND source = 'csv_manual'").get().n >= 2, true);
  eq('none of them under the name inside the file',
    db.prepare("SELECT COUNT(*) n FROM gr_reviews WHERE location_key = 'AKAN Jubilee Hills'").get().n, 0);
  eq('and the disagreement is REPORTED rather than acted on silently',
    [rAD.location_overridden, rAD.location_values], [2, ['AKAN Jubilee Hills']]);
  eq('a file whose branch matches the target reports no disagreement',
    ingestDocuments(db, [{ kind: 'csv', label: 's2.csv', payload:
      'Branch,Reviewer,Rating,Comment,Date\nAKAN Main,Cara,5,"Nice",03/05/2026\n' }],
      { source: 'csv_manual', locationKey: 'AKAN Main', actor: 'test' }).location_overridden, 0);

  /* ── AE. COVERAGE IS A FACT ABOUT THE DATA, NOT ABOUT THE CLOCK ──────────
   * import_covers was keyed on the ingest RUN's finished_at. Import an
   * out-of-date export today and every empty period since read "No reviews —
   * nothing posted in this period" with no warning anywhere, because the run
   * was one minute old. */
  section('AE. An out-of-date file cannot make an empty month look like a quiet one');

  const cvApi = view.importCoverage({
    last_success_at: '2026-09-10T09:00:00Z', last_success_source: 'gbp_api',
    newest_review_at: '2026-08-11T10:00:00Z',
  });
  eq('an API pull really did ask Google, so the fetch time IS the coverage',
    [cvApi.end_at, cvApi.basis], ['2026-09-10T09:00:00Z', 'fetched_from_google']);

  const cvFile = view.importCoverage({
    last_success_at: '2026-09-10T09:00:00Z', last_success_source: 'takeout_json',
    newest_review_at: '2026-08-11T10:00:00Z',
  });
  eq('a FILE only proves what is in it, so coverage stops at its newest review',
    [cvFile.end_at, cvFile.basis], ['2026-08-11T10:00:00Z', 'newest_review_in_file']);
  truthy('and the note explains the verdict in the owner\'s words',
    /only proves what is in it/.test(cvFile.note), cvFile.note);

  eq('a file that held nothing proves nothing',
    view.importCoverage({ last_success_at: '2026-09-10T09:00:00Z', last_success_source: 'csv_manual', newest_review_at: null }).basis,
    'file_held_nothing');
  eq('and never importing is its own basis',
    view.importCoverage({ last_success_at: null, last_success_source: null, newest_review_at: null }).basis,
    'never_imported');

  // The tile the coverage feeds. September, fed by a file that stops on 11 Aug.
  const septStart = Date.parse('2026-09-01T00:00:00Z') - 330 * 60_000;
  const covers = Date.parse(cvFile.end_at) >= septStart;
  eq('so September is NOT covered by that file', covers, false);
  const septTile = view.periodTileView({
    label: 'This month', period: 'monthly', start_date: '2026-09-01', end_date: '2026-09-10',
    count: 0, average: null, import_covers: covers, prev_import_covers: true,
    prev_count: 40, prev_average: 4.1,
  });
  eq('and the tile reads "Not imported", not "No reviews"', septTile.countText, 'Not imported');
  eq('with the gap state, so the page paints it amber', septTile.state, 'not_imported');
  const septApi = view.periodTileView({
    label: 'This month', period: 'monthly', start_date: '2026-09-01', end_date: '2026-09-10',
    count: 0, average: null, import_covers: Date.parse(cvApi.end_at) >= septStart,
    prev_import_covers: true, prev_count: 40, prev_average: 4.1,
  });
  eq('while the same empty month, fetched from Google, IS a real quiet month',
    septApi.state, 'no_reviews');
}
