#!/usr/bin/env node
/**
 * GUEST FEEDBACK - THE TWO SCOPES. PROOF.
 *
 *   node scripts/feedback-scope-tests.js      (also: npm run test:feedback-scope)
 *
 * WHY THIS FILE EXISTS. D11(a) made the GRE / Manager filter narrow the three
 * RECORD-level sections while every sentiment figure stays VENUE-wide, and it
 * proved that with a strict suite - which lived in a throwaway scratchpad script.
 * Its own report said so, and named the gap out loud: "nothing stops a future
 * edit from re-narrowing the rating split except tsc's brand, which covers the
 * function boundaries but not a fresh inline aggregate written inside
 * analytics()". That gap then fired. The Return / Remake Rate was written inline
 * over a row's own fields as `rate(m.returned_qty + m.remade_qty, m.sold)`, with
 * a numerator the filter narrowed and a denominator it never touched, so one dish
 * printed three different rates depending on whose name was picked - under a
 * sheet note that said both sides were the venue's. Nothing caught it because
 * there was no committed test to catch it with. This is that test.
 *
 * SANDBOX CONTRACT - the same one as scripts/reviews-tests.js and
 * scripts/run-tests.js, for the same reason: every assertion runs against a
 * VACUUM INTO snapshot of fnb-controller.db taken through a READONLY handle,
 * written into a fresh os.tmpdir() directory. assertSandboxed() re-reads each
 * handle's own filename and aborts if it is not inside that directory. This suite
 * DELETES every gf_* row in the database it opens; doing that against the owner's
 * live database would be silent and unrecoverable.
 *
 * IT EXERCISES THE SHIPPED CODE, NOT A RE-IMPLEMENTATION. Every figure comes out
 * of the real `analytics()` and the real `buildReport()` in
 * src/lib/feedback/reporting.ts, driven through the real `filtersFromQuery()` so
 * the filters are the ones a URL actually produces. The EXPECTED values were
 * computed by hand from scripts/feedback-scope-fixture.js first.
 *
 * TWO WORLDS, EVERY GATE RUN TWICE. World A records honestly, world B records
 * "everything good" on the same tables. Both are complete datasets, so every
 * invariance below is asserted against two independent sets of numbers.
 *
 * ⚠️ AND TWO FLOORS, WITH SOMEBODY ASSIGNED TO EACH - added because the fixture
 * had ONE floor and NOBODY assigned, so `area_assigned` was false for every
 * person and every floor-coverage cell printed the literal '-' in all ten runs.
 * Two of the four sabotages re-run against this suite were therefore INERT:
 * swapping the person sheet's "Coverage of their own floor" and the By person
 * sheet's "Their floor" onto the venue's eligible-tables denominator produced
 * BYTE-IDENTICAL output in all eight reports and all five filter states. A guard
 * cannot catch a number the fixture never prints. See FLOORS in the fixture.
 *
 * THE GATES
 *   A  VENUE INVARIANCE - under &gre=<name> and &manager=<name>, the rating
 *      split, all four negative tiles, coverage, the category ratings, both
 *      halves of the daily rows, the per-person table and every dropdown are
 *      IDENTICAL to unfiltered. meta.reconciles stays all-true.
 *   B  THE PERSON BLOCK IS SHAPED BY THE FAIRNESS RULING - PersonScope has
 *      exactly 21 keys and ZERO sentiment keys, under every filter.
 *   C  ALL EIGHT DOWNLOADS - every venue sheet's ROWS and COLUMNS byte-identical
 *      filtered vs unfiltered; the person sheet present in all eight; and both
 *      scope sentences written into the file.
 *   D  BOTH SIDES OF EVERY RATE AND EVERY value/sub PAIR - each side read out of
 *      the PRINTED string. "Share of negatives" cell by cell against the record
 *      denominator (and proof that the venue one would print differently), the
 *      menu-item tile's VALUE and SUB both venue and both hand-computed, and
 *      every other "N of M" tile checked against its own two printed numbers.
 *      ⚠️ THIS GATE ONCE ASSERTED ONE SIDE OF THE RATIO IT IS NAMED AFTER and so
 *      reported green while the menu-item tile printed 6/5/3/0 across the four
 *      filter states in this very file. See the comment above gate D.
 *   E  THE RETURN / REMAKE RATE IS VENUE OVER VENUE - the regression this suite
 *      was written for. Hand-computed per dish, asserted identical across every
 *      filter state, and asserted at the printed cell in all three places the
 *      module prints it. Plus the structural half: the row carries no
 *      per-person quantity field for a future edit to divide by `sold`. E5
 *      widens the printed-cell invariance from those three table cells to EVERY
 *      TILE OF ALL EIGHT REPORTS - label, value and sub - because the fourth
 *      site of this shape was a tile, not a cell, and the narrower sweep missed
 *      it. One tile is deliberately person-aware; it is named and asserted.
 *   F  THE MIXED ROW SAYS SO - under a person filter the two venue columns are
 *      marked and the mark is defined, on the sheet and in the payload the
 *      screen reads; unfiltered there is no mark, because there is no second
 *      scope in the row.
 *   I  NO HEADING TRUNCATES in the PDF, at report-pdf.ts's own metrics.
 *   J  THE WALK - the gate that is not a list. See "THE WALK" below. It
 *      ENUMERATES every printed string of all eight ReportDocs by the doc's own
 *      keys, and fails on a key it has not been taught, so a new printed field
 *      is covered the day it is added. Over that enumeration it asserts the two
 *      properties, once each, for every printed number in every block - tiles,
 *      table cells, footnotes, sheet notes, column headings, cover lines, the
 *      title block:
 *        A  FILTER INVARIANCE  - classified by the FILE'S OWN cover sentences,
 *           not by a list here: a sheet the cover did not say it narrowed must
 *           be character-identical in every filter state, and a prose block's
 *           own numbers may only move if the block names the person.
 *        B  INTERNAL AGREEMENT - a printed rate equals the rate of its own
 *           printed pair (inside one cell, inside one tile, and ACROSS the cells
 *           of one row); every percentage COLUMN is the rate of two numbers
 *           printed on its own sheet, by the same basis in every filter state;
 *           and an "N of those" claim neither exceeds the number it is 'of' nor,
 *           summed over every person, exceeds the queue it partitions; and the
 *           one quantity printed in three separate blocks - the business-day
 *           rollover - is the same number in all three and is the range's own.
 *   G  HAND-COMPUTED TOTALS - the fixture's own arithmetic, so a change that
 *      keeps every invariance while breaking the numbers still fails.
 *
 * MEASURED BREADTH, not claimed breadth. Eleven one-line reintroductions were
 * re-run against this file in an isolated `git archive` tree - the four the brief
 * named (the person sheet's own-floor coverage, the By person 'Their floor' cell,
 * menuTable's Neg %, the open-queue footnote) and seven nobody had named: the
 * Rating split Share over the record lane, the By day Coverage over the venue's
 * eligible tables, recoveryCell's rate over the wrong denominator, the "Of those,
 * raised by" row over `follow_ups_raised`, a brand-new printed ReportDoc field, a
 * hard-coded rollover in a footnote, and the 2d value/sub shape re-introduced on a
 * NEW tile. All eleven go RED. tsc is exit 0 for every one of them, which is the
 * point: the compiler cannot see any of this.
 *
 * WHAT GATE J CANNOT SEE, said out loud rather than left to be discovered:
 *   · `rangeForReport()`. The route FORCES the period for daily / weekly /
 *     monthly; this suite builds one payload over a custom range and asks it for
 *     all eight reports, so the three period-forced variants are walked with the
 *     custom range's numbers. Nothing here proves a "Monthly" file holds a month.
 *   · FILTERS OTHER THAN THE PERSON. Every invariance above varies `&gre=` /
 *     `&manager=` only. Floor, section, captain, group and item are SUPPOSED to
 *     move every number, so they have no invariance to assert - but neither is
 *     their internal agreement exercised.
 *   · `istStamp()`. The workbook's "Generated <time> IST" line is composed in
 *     `reports/route.ts`, not in the doc, so the walk never sees it. It is a
 *     clock, not a figure.
 *   · THE SCREEN'S OWN FIELDS. The walk reads the eight ReportDocs. Payload
 *     fields the dashboard prints and no report does are covered only by gate A's
 *     block-level equality, not number by number.
 *   · A CELL THE PDF TRUNCATES. Gate I measures HEADINGS. `fitPrint` rewrites
 *     only free-text name columns (Item / Person / Floor), so no number is
 *     re-spelled on the way to the page, but no assertion here proves that.
 *   · A WRONG CONSTANT PRINTED IN ONLY ONE BLOCK. J8 closes the one quantity this
 *     module repeats across blocks (the rollover, printed three times). A number
 *     hard-coded into a sentence that is the ONLY place it appears is identical in
 *     every filter state and in both worlds, so it has nothing here to disagree
 *     with. J3 proves prose numbers do not MOVE; it cannot prove they are right.
 *   · A COINCIDENCE IN ONE WORLD. J6 aggregates its basis search per world, so a
 *     break that some other pair of the sheet's own columns happens to reproduce
 *     in world B is only caught in world A. Measured: the By day Coverage swap
 *     fails in world A and passes in world B - the suite goes red, but on ONE
 *     assertion rather than two. Read a single-world J6 failure as real.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
/** Only to MEASURE text at the renderer's own font - no PDF is written. */
const PDFDocument = require('pdfkit');

const REPO = path.resolve(__dirname, '..');
const LIVE_DB = path.join(REPO, 'fnb-controller.db');
const SRC = path.join(REPO, 'src');

/* ── 0. SNAPSHOT ─────────────────────────────────────────────────────────── */

if (!fs.existsSync(LIVE_DB)) {
  console.error('feedback-scope-tests: ' + LIVE_DB + ' not found - nothing to snapshot.');
  process.exit(2);
}

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fnb-feedback-scope-')));
const SNAPS = { A: path.join(TMP, 'worldA.db'), B: path.join(TMP, 'worldB.db') };
{
  // Parameterised, so no filename is ever concatenated into SQL.
  const src = new Database(LIVE_DB, { readonly: true });
  for (const p of Object.values(SNAPS)) src.prepare('VACUUM INTO ?').run(p);
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

const R = require(path.join(SRC, 'lib', 'feedback', 'reporting.ts'));
/** Only for its published sentences - see PUBLISHED_SENTENCES. */
const Z = require(path.join(SRC, 'lib', 'feedback', 'zones.ts'));
const fixture = require(path.join(REPO, 'scripts', 'feedback-scope-fixture.js'));
const { SUBJECT, STEADY, SILENT, MGR } = fixture.PEOPLE;

/**
 * A POSITIVE check, not a negative one. This suite DELETEs every gf_* row in the
 * handle it is given, so "not the live database" is not a strong enough test: the
 * process has already chdir()'d into TMP, so an empty or relative `name` would
 * resolve INTO the sandbox and pass a prefix check while pointing anywhere. The
 * handle must be, exactly, one of the two snapshots this run created.
 */
const ALLOWED = new Set(Object.values(SNAPS).map((p) => path.resolve(p)));
function assertSandboxed(handle) {
  const open = typeof handle.name === 'string' && handle.name ? path.resolve(handle.name) : '';
  if (!ALLOWED.has(open)) {
    console.error(`\nFATAL: tests opened ${JSON.stringify(open)}, which is not one of this run's `
      + `snapshots (${[...ALLOWED].join(', ')}). Refusing to write. Aborting.`);
    process.exit(3);
  }
}

/* ── 2. HARNESS ──────────────────────────────────────────────────────────── */

let pass = 0;
let fail = 0;
const failures = [];
function ok(label) { pass++; console.log('  ok   ' + label); }
function bad(label, detail) {
  fail++; failures.push(label);
  console.log('  FAIL ' + label);
  if (detail !== undefined) console.log('       ' + detail);
}
function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) ok(label); else bad(label, 'expected ' + e + ', got ' + a);
}
function truthy(label, v, detail) { if (v) ok(label); else bad(label, detail); }
function section(t) { console.log('\n' + t); }

/* ── 3. THE RUNNER ───────────────────────────────────────────────────────── */

/** Midday the day after the fixture's night, so the range is closed. */
const NOW = Date.parse('2026-09-29T06:30:00Z');
/** BOTH business days, so the By day sheet has TWO rows to tell apart - see the
 *  two-day note in the fixture. A one-day range made every per-day figure equal
 *  to the venue's, which made a per-day-over-venue swap print nothing new. */
const RANGE = `range=custom&from=${fixture.DAY_ONE}&to=${fixture.DAY_TWO}`;

/** Drive the SHIPPED entry points through a real query string. */
function payload(db, qs) {
  const filters = R.filtersFromQuery(new URLSearchParams(RANGE + (qs || '')));
  return R.analytics(db, { outletId: '', filters, nowMs: NOW });
}
const report = (p, key) => R.buildReport(p, key);

/** The sheets that must never move when a name is picked. */
const VENUE_SHEETS = new Set(['By day', 'Rating split', 'Category ratings', 'By person']);

/** The cell as a READER sees it, per report and per table, for one dish. */
const RR_CELL_SITES = [
  { key: 'menu-item', table: 'Menu item analysis' },
  { key: 'negative', table: 'Menu item analysis' },
  { key: 'returned-remade', table: 'By item' },
];

/** The filter states every gate is run across. '' must stay first. */
const FILTER_STATES = [
  ['(no filter)', ''],
  [`&gre=${SUBJECT.name}`, `&gre=${encodeURIComponent(SUBJECT.name)}`],
  [`&gre=${STEADY.name}`, `&gre=${encodeURIComponent(STEADY.name)}`],
  [`&gre=${SILENT.name}`, `&gre=${encodeURIComponent(SILENT.name)}`],
  [`&manager=${MGR.name}`, `&manager=${encodeURIComponent(MGR.name)}`],
];

/* ════════════════════════════════════════════════════════════════════════════
   THE WALK - gate J's machinery
   ════════════════════════════════════════════════════════════════════════════
   WHY THERE IS A WALK AT ALL. The same defect - a RECORD-lane numerator printed
   over a VENUE-lane denominator - has now been found FOUR times, and each guard
   written for it was scoped to the shape just broken: gate D to RATES, gate E5
   to TILES. Both of those are HAND-WRITTEN LISTS of places, and the next site
   was never on the list. E5's own comment says tiles are "where every printed
   'N of M' lives"; that is false, measured on this fixture - four N-of-M pairs
   and eight rate-beside-its-own-pair cells live in TABLE CELLS, and a fifth
   deliberately person-aware number lives in a FOOTNOTE.

   So gate J does not list places. It ENUMERATES the ReportDoc by its own keys
   and fails on a key it does not consume - `unknownKeys` below. A field added to
   `ReportDoc`, `ReportTable`, a kpi or a column therefore fails this suite on
   the day it is added, until the walk is taught to read it. That is the only
   device in this file that gets WIDER on its own. */

/** Every own key each printed structure is allowed to have. The walk consumes
 *  ALL of these; anything else is reported by name rather than skipped. */
const DOC_KEYS = ['key', 'slug', 'title', 'subtitle', 'period', 'filters', 'kpis', 'tables', 'footnotes'];
const TABLE_KEYS = ['name', 'columns', 'rows', 'note', 'emptyNote'];
const KPI_KEYS = ['label', 'value', 'sub'];
const COLUMN_KEYS = ['label', 'width', 'align', 'fitPrint'];

/** Every number a reader can see in a string, in order, as written. */
const numsOf = (t) => String(t == null ? '' : t).match(/-?\d+(?:\.\d+)?/g) || [];

/**
 * THE SENTENCES THE MODULE PUBLISHES, so a note can be read for its OWN numbers.
 *
 * Every note and footnote in this module is a CONCATENATION: some inline words
 * plus one or more exported basis sentences. Several of those carry digits of
 * their own - `RECOVERY_IS_A_QUEUE` explains the queue with the literal "1/3",
 * `COUNTS_SCOPE_PERSON` quotes "Excellent 100%" - and those digits are examples,
 * not figures about the data. Comparing a note's raw digits across filter states
 * therefore compares the examples too, and says a note moved when only the
 * narration around it did.
 *
 * So the published sentences are STRIPPED BY IDENTITY first, and what is left is
 * the block's own printed numbers. Collected by RULE, not by list: every string
 * export of the two modules that is long enough to be a sentence. A new basis
 * constant is covered the day it is exported; a new INLINE sentence carrying a
 * number is not, and shows up as a block whose own numbers changed.
 */
const PUBLISHED_SENTENCES = [...Object.values(R), ...Object.values(Z)]
  .filter((v) => typeof v === 'string' && v.length >= 60)
  .sort((a, b) => b.length - a.length);

/** One prose block's OWN numbers - the published sentences taken out first. */
function ownNums(text) {
  let s = String(text == null ? '' : text);
  for (const sentence of PUBLISHED_SENTENCES) s = s.split(sentence).join(' ');
  return numsOf(s);
}

/**
 * The SLOT a prose block occupies, so two filter states can be compared block by
 * block instead of string by string. A filter line is keyed by the label it
 * prints before its colon (the two narration sentences have none, and carry no
 * number); everything else by its walk path, which already names the sheet.
 */
const proseSlot = (loc) => {
  if (!/^filters\[/.test(loc.path)) return loc.path;
  const m = /^([^:]{1,40}):/.exec(loc.text);
  return m ? `filters:${m[1]}` : 'filters:scope-narration';
};

/** "4 of 6", "4/6", "3 of 4 closed". A pair a reader reads as N out of M. */
const pairsOf = (t) => {
  const out = [];
  const re = /(\d+(?:\.\d+)?)(?:\s*\/\s*|\s+of\s+)(\d+(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(String(t == null ? '' : t)))) out.push([Number(m[1]), Number(m[2])]);
  return out;
};
/** "66.7%", "100%". */
const pctsOf = (t) => {
  const out = [];
  const re = /(\d+(?:\.\d+)?)\s*%/g;
  let m;
  while ((m = re.exec(String(t == null ? '' : t)))) out.push(m[1]);
  return out;
};

const isNumCell = (v) => /^-?\d+(?:\.\d+)?$/.test(String(v).replace(/,/g, '').trim());
const isPctCell = (v) => /^-?\d+(?:\.\d+)?%$/.test(String(v).trim());
/** `pctText(rate(n, d))` re-implemented on this side, so an expected string is
 *  never read back off the code under test. */
const pctCell = (n, d) => (!(d > 0) ? '-' : `${(Math.round((n / d) * 1000) / 10).toFixed(1)}%`);

/**
 * EVERY PRINTED STRING IN ONE DOC, with the block it lives in.
 *
 * `kind` is what the string IS, not where it sits:
 *   'figure' - the whole string is a printed number or a printed rate (a kpi
 *              value, a table cell). Invariance is strict on these.
 *   'pair'   - a short phrase carrying a printed number and the denominator it
 *              is "of" (a kpi sub).
 *   'prose'  - a sentence. Its numbers are checked for internal agreement and
 *              for shape-matched invariance; its WORDS are allowed to change,
 *              because the scope narration legitimately does.
 *
 * `unit` groups the strings a reader reads TOGETHER - one table row, one tile -
 * so "the rate must equal the rate of its own printed pair" can be asserted
 * across two cells of the same row, which is where S1 hides.
 */
function walkDoc(doc, unknownKeys) {
  const out = [];
  const add = (path, unit, kind, text) => out.push({ path, unit, kind, text: String(text == null ? '' : text) });

  for (const k of Object.keys(doc)) if (!DOC_KEYS.includes(k)) unknownKeys.push(`ReportDoc.${k}`);
  for (const k of ['key', 'slug', 'title', 'subtitle', 'period']) add(k, `doc:${k}`, 'prose', doc[k]);
  (doc.filters || []).forEach((l, i) => add(`filters[${i}]`, `filters[${i}]`, 'prose', l));
  (doc.footnotes || []).forEach((l, i) => add(`footnotes[${i}]`, `footnotes[${i}]`, 'prose', l));

  (doc.kpis || []).forEach((kp) => {
    for (const k of Object.keys(kp)) if (!KPI_KEYS.includes(k)) unknownKeys.push(`ReportDoc.kpis[].${k}`);
    const unit = `tile:${kp.label}`;
    add(`tile["${kp.label}"].label`, unit, 'prose', kp.label);
    add(`tile["${kp.label}"].value`, unit, 'figure', kp.value);
    add(`tile["${kp.label}"].sub`, unit, 'pair', kp.sub);
  });

  (doc.tables || []).forEach((t) => {
    for (const k of Object.keys(t)) if (!TABLE_KEYS.includes(k)) unknownKeys.push(`ReportDoc.tables[].${k}`);
    add(`sheet["${t.name}"].name`, `sheet:${t.name}:name`, 'prose', t.name);
    add(`sheet["${t.name}"].note`, `sheet:${t.name}:note`, 'prose', t.note);
    add(`sheet["${t.name}"].emptyNote`, `sheet:${t.name}:emptyNote`, 'prose', t.emptyNote);
    (t.columns || []).forEach((c, j) => {
      for (const k of Object.keys(c)) if (!COLUMN_KEYS.includes(k)) unknownKeys.push(`ReportDoc.tables[].columns[].${k}`);
      add(`sheet["${t.name}"].columns[${j}]`, `sheet:${t.name}:columns`, 'prose', c.label);
    });
    (t.rows || []).forEach((r, ri) => {
      const unit = `sheet:${t.name}:row[${String(r[0])}|${ri}]`;
      r.forEach((cell, ci) => {
        const col = (t.columns || [])[ci];
        add(`sheet["${t.name}"].row["${String(r[0])}"]["${col ? col.label : ci}"]`, unit, 'figure', cell);
      });
    });
  });
  return out;
}

/** The locations of one doc, by path - for a filtered-vs-unfiltered comparison
 *  that names the exact cell that moved. */
const byPath = (locs) => new Map(locs.map((l) => [l.path, l]));

/**
 * WHICH SHEETS MAY MOVE, READ OFF THE COVER RATHER THAN LISTED HERE.
 *
 * `filterLines()` prints two sentences into every file: what the filter NARROWED
 * (and to whom) and what it did NOT narrow. Those sentences name the sheets. So
 * the classification the invariance gate uses is the file's OWN PROMISE, parsed
 * back out of it - which means a sheet cannot be quietly reclassified without
 * the cover saying so, and the cover cannot promise something the sheets do not
 * do. That is the property the 2d defect broke: the cover said the Summary tiles
 * do not move, four rows above a Summary tile that had moved 6 -> 0.
 */
function coverScopes(doc) {
  const narrowed = doc.filters.find((l) => l.includes('NARROWED to')) || '';
  const venue = doc.filters.find((l) => l.includes('did NOT narrow')) || '';
  return {
    narrowed,
    venue,
    of(name) {
      if (narrowed.includes(name)) return 'narrowed';
      if (venue.includes(name)) return 'venue';
      return 'silent';
    },
  };
}

/**
 * THE SHEETS THE COVER DOES NOT CLASSIFY - named, with the reason, and each
 * one's behaviour asserted below instead of skipped.
 *
 * Both of these are real gaps in `filterLines()`' two sentences, found by the
 * walk: neither sheet is mentioned in either. They are NOT waved through - the
 * default for an unclassified sheet is the STRICTER one (must not move), and the
 * one that does move gets its own named assertion.
 */
const PERSON_ROW_SHEET = 'Open complaints now (all dates)';
const COVER_SILENT = new Map([
  ['By person', 'The cover names neither; this sheet never narrows (it is the sheet a manager '
    + 'compares on), so it is held to full byte-identity like a venue sheet.'],
  [PERSON_ROW_SHEET, 'The cover names neither; under a person filter this sheet gains exactly ONE '
    + 'row, "Of those, raised by <name>", whose count is asserted against the venue row above it '
    + 'by the containment rule in J5, and whose venue row must keep its number.'],
]);

/** The ONE tile whose SUB is deliberately person-aware (E5 names it too). */
const PERSON_AWARE_TILE = 'Follow-ups open now (all dates)';

/**
 * THE PERCENTAGE COLUMNS WHOSE NUMERATOR IS NOT ON THE SHEET - named, with the
 * reason, and NOT waved through: each still has to print the sentence that
 * explains it, and the register is checked for staleness (an entry that turns
 * out to be explainable everywhere fails, so it cannot rot into a blanket).
 *
 * Only one shape qualifies, and the module says so in its own words. `Returned`
 * and `Remade` are ROW COUNTS ("COUNTS ONLY", reporting.ts:2100) while
 * `return_remake_pct`'s numerator is a PLATE QUANTITY - so Mutton Biryani prints
 * Returned 1, Sold 12 and R/R % 16.7%, because the one feedback covered two
 * plates. `RETURN_REMAKE_BASIS` is the sentence that says it ("the numerator sums
 * gf_item_feedback.quantity, so one feedback on a line of three counts three"),
 * and it is asserted to be on every sheet that prints the column.
 */
const OFF_SHEET_RATE_BASIS = new Map([
  ['R/R %', 'numerator is a PLATE QUANTITY; Returned / Remade print feedback ROW COUNTS'],
  ['R/R %*', 'same column under a person filter, with the venue mark'],
]);

/**
 * PERCENTAGE COLUMNS EXPLAINED BY NUMBERS PRINTED ON THEIR OWN SHEET.
 *
 * For every percentage column of a table, every way the sheet's own numbers
 * could produce it: numerator = one numeric column or the sum of two;
 * denominator = one numeric column (PER ROW), or that column's total or maximum
 * (ONE denominator for the whole column - a SHARE). A basis qualifies only if it
 * reproduces the column for EVERY row.
 *
 * This is property B stated once for a whole class: "a printed rate must equal
 * the rate of its own printed numerator and denominator". S2 - swapping Neg %'s
 * denominator from the row's own `feedbacks` to the venue's `item_feedbacks` -
 * leaves the column explained by nothing the sheet prints, and fails here
 * without anybody having listed 'Neg %'.
 *
 * ⚠️ THE TWO KINDS ARE KEPT APART, and that distinction is load-bearing. Allowing
 * a whole-column denominator everywhere let a real swap through: putting the By
 * day sheet's Coverage over the VENUE's eligible tables printed 16.7% / 50.0%
 * where the days' own rows say 33.3% / 100.0%, and `Taken / total(Eligible)`
 * reproduced it exactly, because every eligible table appears on exactly one day.
 * So a column is allowed a single shared denominator only if it SAYS it is a
 * share - the reader's own cue, the word in the heading ("Share of negatives",
 * "Share"). Anything else is a per-row rate and must be explained per row.
 */
const isShareColumn = (label) => /^share\b/i.test(String(label).trim());

function rateBases(t) {
  const rows = t.rows || [];
  const cols = (t.columns || []).map((c) => String(c.label));
  if (!rows.length || !cols.length) return {};
  const val = (r, c) => Number(String(r[c]).replace(/,/g, ''));
  const numeric = cols.map((_, c) => c).filter((c) => rows.every((r) => isNumCell(r[c])));
  const pctCols = cols.map((_, c) => c).filter((c) => rows.every((r) => isPctCell(r[c]) || String(r[c]).trim() === '-')
    && rows.some((r) => isPctCell(r[c])));

  const nspecs = [];
  for (const i of numeric) nspecs.push({ tag: cols[i], get: (r) => val(r, i) });
  for (const i of numeric) for (const j of numeric) if (i < j) nspecs.push({ tag: `${cols[i]}+${cols[j]}`, get: (r) => val(r, i) + val(r, j) });
  const perRowD = numeric.map((k) => ({ tag: cols[k], get: (r) => val(r, k) }));
  const wholeD = [];
  for (const k of numeric) {
    const total = rows.reduce((a, r) => a + val(r, k), 0);
    const top = rows.reduce((a, r) => Math.max(a, val(r, k)), 0);
    wholeD.push({ tag: `total(${cols[k]})`, get: () => total });
    wholeD.push({ tag: `max(${cols[k]})`, get: () => top });
  }

  const out = {};
  for (const P of pctCols) {
    const explains = (ds) => nspecs.filter((ns) => rows.every((r) => pctCell(ns.get(r), ds.get(r)) === String(r[P]).trim()))
      .map((ns) => `${ns.tag} / ${ds.tag}`);
    out[cols[P]] = {
      perRow: perRowD.flatMap(explains),
      whole: wholeD.flatMap(explains),
      isShare: isShareColumn(cols[P]),
    };
  }
  return out;
}

function runWorld(which) {
  section(`════════ WORLD ${which} ════════`);
  const db = new Database(SNAPS[which]);
  assertSandboxed(db);
  fixture.build(db, which);
  db.close();

  const ro = new Database(SNAPS[which], { readonly: true });
  assertSandboxed(ro);

  const all = payload(ro, '');
  const personStates = FILTER_STATES.filter(([, qs]) => qs !== '');

  /* ── A. VENUE INVARIANCE ────────────────────────────────────────────────── */
  section(`World ${which} - A. VENUE INVARIANCE (nothing sentiment-shaped moves when a name is picked)`);
  eq(`unfiltered payload is the venue scope`, all.records.scope, 'venue');
  for (const [tag, qs] of personStates) {
    const f = payload(ro, qs);
    eq(`${tag}: summary IDENTICAL (rating split + all 4 negative tiles + coverage)`, f.summary, all.summary);
    eq(`${tag}: categories IDENTICAL`, f.categories, all.categories);
    eq(`${tag}: daily IDENTICAL (coverage half AND sentiment half)`, f.daily, all.daily);
    eq(`${tag}: gre_performance IDENTICAL (every person still listed)`, f.gre_performance, all.gre_performance);
    eq(`${tag}: options IDENTICAL (no dropdown emptied by picking a name)`, f.options, all.options);
    truthy(`${tag}: meta.reconciles all true`,
      f.meta.reconciles.rating_split && f.meta.reconciles.coverage_split && f.meta.reconciles.taken_subset,
      JSON.stringify(f.meta.reconciles));
    eq(`${tag}: records block names the scope`, [f.records.scope, f.records.person], ['person', tag.split('=')[1]]);
    truthy(`${tag}: meta.person_filter_active`, f.meta.person_filter_active === true);
  }

  /* ── B. THE PERSON BLOCK ────────────────────────────────────────────────── */
  section(`World ${which} - B. PersonScope carries work, never sentiment`);
  for (const [tag, qs] of personStates) {
    const f = payload(ro, qs);
    const keys = f.person ? Object.keys(f.person) : null;
    eq(`${tag}: PersonScope has 21 keys`, keys ? keys.length : null, 21);
    eq(`${tag}: PersonScope has ZERO sentiment keys`,
      (keys || []).filter((k) => /excellent|good|average|poor|rating|negative|unhappy|happy|sentiment/i.test(k)), []);
  }
  eq('no name picked: person block is null', all.person, null);

  /* ── C. ALL EIGHT DOWNLOADS ─────────────────────────────────────────────── */
  section(`World ${which} - C. all eight downloads`);
  eq('there are eight reports', R.REPORT_KEYS.length, 8);
  for (const [tag, qs] of personStates) {
    const f = payload(ro, qs);
    const person = f.records.person;
    const bads = [];
    for (const key of R.REPORT_KEYS) {
      const d = report(f, key);
      const dv = report(all, key);
      for (const t of d.tables) {
        if (!VENUE_SHEETS.has(t.name)) continue;
        const o = dv.tables.find((x) => x.name === t.name);
        if (!o) { bads.push(`${key}/${t.name} MISSING unfiltered`); continue; }
        if (JSON.stringify(t.rows) !== JSON.stringify(o.rows)) bads.push(`${key}/${t.name} ROWS moved`);
        if (JSON.stringify(t.columns) !== JSON.stringify(o.columns)) bads.push(`${key}/${t.name} COLUMNS moved`);
      }
      if (!d.tables.some((t) => t.name === `What ${person} did`)) bads.push(`${key} missing person sheet`);
      if (!d.filters.some((l) => l.includes('NARROWED to'))) bads.push(`${key} filter lines missing NARROWED`);
      if (!d.filters.some((l) => l.includes('did NOT narrow'))) bads.push(`${key} filter lines missing "did NOT narrow"`);
    }
    truthy(`${tag}: venue sheets byte-identical + person sheet present + scope stated, in all 8`,
      bads.length === 0, JSON.stringify(bads));
  }

  /* ── D. BOTH SIDES OF A RATE, SAME POPULATION ───────────────────────────── */
  /* 🐞 WHAT THIS GATE USED TO DO, AND WHY IT REPORTED GREEN ON A BROKEN TILE.
     It was headed "BOTH SIDES OF A RATE, SAME POPULATION" and then asserted
     exactly ONE side. Its whole menu-item check was:

         eq(`${tag}: menu-item KPI keeps the VENUE "items sold" denominator`,
            mi.kpis[0].sub, `of ${all.records.items_sold} items sold`);

     `sub` is the DENOMINATOR. The NUMERATOR - `kpis[0].value` - was computed
     inline off the RECORD lane (`p.menu_items.filter(m => m.feedbacks > 0)`),
     and nothing in this file ever looked at it. So the tile printed

         no filter  "6 of 6"   Probe "5 of 6"   Steady "3 of 6"   Silent "0 of 6"

     across the four filter states THIS SUITE ALREADY RAN, while this gate said
     ok. A gate that checks one side of a ratio it is named after is worse than
     no gate: it is the thing that let 2d ship. Every assertion below reads BOTH
     halves of the pair, out of the PRINTED strings, in every filter state. */
  section(`World ${which} - D. BOTH sides of every rate and every value/sub pair`);

  /** The printed numbers, parsed the way a reader reads them. The comma strip is
   *  deliberate: `n0` prints none today, but a thousands separator added later
   *  must not turn a real assertion into NaN-compared-to-NaN. */
  const num = (v) => Number(String(v).replace(/,/g, '').trim());
  /** `pctText(rate(n, d))` re-implemented from the fixture side, so the expected
   *  string is not read back off the code under test. */
  const pct = (n, d) => (!(d > 0) ? '-' : `${(Math.round((n / d) * 1000) / 10).toFixed(1)}%`);

  /** Every TILE that prints a count beside a denominator it is "of". `n` is the
   *  capture group holding the numerator when the sub carries both numbers;
   *  `valueIsRate` means the tile's own value is the rate of the sub's two
   *  numbers; `rateLabel` names a second tile on the same report that must agree
   *  with this pair. Both captures are read out of the PRINTED sub. */
  const PAIR_TILES = [
    { key: 'menu-item', label: 'Items with feedback', sub: /^of (\d+) items sold$/, of: 1 },
    { key: 'negative', label: 'Negative item feedbacks', sub: /^of (\d+) item feedbacks$/, of: 1, rateLabel: 'Negative rate' },
    { key: 'daily', label: 'Negative item feedbacks', sub: /^of (\d+) item feedbacks$/, of: 1 },
    { key: 'daily', label: 'Coverage', sub: /^(\d+) of (\d+) eligible tables covered$/, n: 1, of: 2, valueIsRate: true },
    { key: 'gre-performance', label: 'Venue coverage', sub: /^(\d+) of (\d+) eligible tables$/, n: 1, of: 2, valueIsRate: true },
  ];

  /* D1. HAND-COMPUTED, from the fixture, for the tile 2d was measured on. Six
         dishes are sold in both worlds (12 plates each, by construction).
         World A: every one of the six drew a comment from somebody - Mutton
         Biryani (v1 subject, v6 Steady), Butter Naan (v1), Gulab Jamun (v2, v8
         Mgr), Paneer Tikka (v3, v5 Steady), Filter Coffee (v4), Old Monk (v5).
         World B: the subject records nothing at item level, so only Steady's
         Paneer Tikka + Old Monk + Mutton Biryani and the Manager's Gulab Jamun
         remain - FOUR. Neither number is a property of any recorder, which is
         the point: it is the same in every filter state below. */
  const EXPECT_ITEMS_WITH_FEEDBACK = which === 'A' ? 6 : 4;

  // The ingredient is gone, the 2c way: a bare venue denominator sitting loose
  // in the payload is what the old inline `sub` paired a narrowed numerator
  // with. Asserted at runtime, because a field can be added back by anyone who
  // has not read the comment saying not to.
  eq('records carries no bare items_sold for a new inline sub to pair with',
    'items_sold' in all.records, false);
  // `|| {}` for the same reason the `String()`s in gate F exist: run against a
  // tree where the field does not exist yet (399e4cc), this must be a NAMED
  // failure, not a TypeError that aborts before gates E-G are reached.
  eq('records.items_with_feedback carries BOTH halves as one value',
    Object.keys(all.records.items_with_feedback || {}).sort(), ['count', 'of']);

  for (const [tag, qs] of FILTER_STATES) {
    const p = payload(ro, qs);

    /* D2. "Share of negatives" - BOTH SIDES, cell by cell, not just the sum.
           The sum alone passes if numerator and denominator are BOTH wrong by
           the same factor, so each cell is recomputed from the record lane. */
    const t = report(p, 'negative').tables.find((x) => x.name === 'Most common problems');
    eq(`${tag}: every "Count" cell is the RECORD lane's own count (the numerator)`,
      t.rows.map((r) => [String(r[0]), num(r[1])]),
      p.common_problems.map((x) => [x.label, x.count]));
    const wantShare = p.common_problems.map((x) => pct(x.count, p.records.negative_item_feedbacks));
    eq(`${tag}: every "Share of negatives" cell divides by the RECORD denominator`,
      t.rows.map((r) => String(r[2])), wantShare);
    // ...and the line above HAS TEETH: wherever the two denominators differ, the
    // venue one would print different cells, so a swap could not pass it.
    if (p.records.negative_item_feedbacks !== p.summary.negative_item_feedbacks && t.rows.length) {
      const venueShare = p.common_problems.map((x) => pct(x.count, p.summary.negative_item_feedbacks));
      truthy(`${tag}: the VENUE denominator would print different cells (this assertion has teeth)`,
        JSON.stringify(venueShare) !== JSON.stringify(wantShare),
        `record=${JSON.stringify(wantShare)} venue=${JSON.stringify(venueShare)}`);
    }
    const shares = t.rows.map((r) => parseFloat(String(r[2])));
    const sum = shares.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
    truthy(`${tag}: "Share of negatives" adds to 100% (got ${sum.toFixed(1)}%, ${t.rows.length} rows)`,
      t.rows.length === 0 || Math.abs(sum - 100) < 0.5);

    /* D3. THE MENU-ITEM TILE - VALUE AND SUB, numerator AND denominator. */
    const mi = report(p, 'menu-item');
    eq(`${tag}: menu-item tile prints BOTH halves venue-over-venue`,
      [mi.kpis[0].label, mi.kpis[0].value, mi.kpis[0].sub],
      ['Items with feedback', String(EXPECT_ITEMS_WITH_FEEDBACK), `of ${fixture.DISHES.length} items sold`]);
    eq(`${tag}: menu-item tile is identical to the unfiltered tile`,
      [mi.kpis[0].value, mi.kpis[0].sub],
      [report(all, 'menu-item').kpis[0].value, report(all, 'menu-item').kpis[0].sub]);

    /* D4. EVERY OTHER value/sub PAIR THE MODULE PRINTS, both halves, from the
           printed strings - so a pair whose two sides drift apart fails here
           even if nobody thinks to write a test for that particular tile. */
    for (const spec of PAIR_TILES) {
      const doc = report(p, spec.key);
      const k = doc.kpis.find((x) => x.label === spec.label);
      if (!k) { bad(`${tag}: ${spec.key} prints the "${spec.label}" tile`); continue; }
      const m = String(k.sub == null ? '' : k.sub).match(spec.sub);
      // A REWORDED sub must fail loudly, never silently skip the pair.
      if (!m) { bad(`${tag}: ${spec.key}/"${spec.label}" sub still has its two numbers`, String(k.sub)); continue; }
      const of = num(m[spec.of]);
      const n = spec.n ? num(m[spec.n]) : num(k.value);
      if (spec.valueIsRate) {
        eq(`${tag}: ${spec.key}/"${spec.label}" value is the rate of its OWN sub's two numbers`,
          String(k.value), pct(n, of));
      } else {
        truthy(`${tag}: ${spec.key}/"${spec.label}" numerator ${n} cannot exceed its own denominator ${of}`,
          n <= of, `${k.value} / ${k.sub}`);
      }
      if (spec.rateLabel) {
        const r2 = doc.kpis.find((x) => x.label === spec.rateLabel);
        eq(`${tag}: ${spec.key}/"${spec.rateLabel}" agrees with the PRINTED pair above it`,
          String(r2 && r2.value), pct(n, of));
      }
    }
  }

  /* ── E. THE RETURN / REMAKE RATE IS VENUE OVER VENUE ────────────────────── */
  section(`World ${which} - E. Return / Remake Rate is venue over venue (the regression)`);

  // E1. STRUCTURAL: the row must carry no per-person quantity to pair with `sold`.
  //     Asserted at runtime as well as at the type level, because a field can be
  //     added back without anyone reading the comment that says not to.
  {
    const rows = FILTER_STATES.flatMap(([, qs]) => payload(ro, qs).menu_items);
    const leaked = rows.filter((m) => 'returned_qty' in m || 'remade_qty' in m);
    eq('no menu-item row carries returned_qty / remade_qty', leaked.length, 0);
    truthy('every menu-item row carries return_remake_pct',
      rows.length > 0 && rows.every((m) => 'return_remake_pct' in m));
  }

  // E2. HAND-COMPUTED, from the fixture, PER WORLD - and worked out from the
  //     fixture file, not read back off the payload. Every dish sold 12 plates in
  //     both worlds; what differs is which plates went back, because in world B
  //     the subject recorded nothing at item level.
  //
  //     World A: Mutton Biryani 2 returned (subject), Butter Naan 2 remade
  //     (subject), Paneer Tikka 2 returned (STEADY), Old Monk 1 remade (Steady).
  //     World B: only Steady's two remain - Paneer Tikka 2 returned, Old Monk 1
  //     remade; the subject's Mutton Biryani and Butter Naan never happened.
  //
  //     Gulab Jamun is 0.0% in both: it was only ever REPLACED, and the rate
  //     counts returned + remade and nothing else.
  const EXPECT_RR = which === 'A'
    ? {
      'Mutton Biryani': 16.7, // 2/12
      'Butter Naan': 16.7,    // 2/12
      'Paneer Tikka': 16.7,   // 2/12, recorded by Steady Gre
      'Old Monk': 8.3,        // 1/12
      'Gulab Jamun': 0,       // replaced only
      'Filter Coffee': 0,
    }
    : {
      'Paneer Tikka': 16.7,   // 2/12, recorded by Steady Gre
      'Old Monk': 8.3,        // 1/12
      'Mutton Biryani': 0,    // only a positive feedback in world B
      'Butter Naan': 0,       // no feedback at all; seeded from plates sold
      'Gulab Jamun': 0,       // replaced only
      'Filter Coffee': 0,
    };
  eq('every dish sold exactly 12 plates (the hand-computed denominator)',
    [...new Set(all.menu_items.map((m) => m.sold))], [fixture.PLATES_PER_DISH]);
  for (const m of all.menu_items) {
    eq(`venue R/R % for ${m.menu_item} is the hand-computed ${EXPECT_RR[m.menu_item]}%`,
      m.return_remake_pct, EXPECT_RR[m.menu_item]);
  }

  // E3. THE INVARIANCE. Under ANY filter, a dish that appears must carry the
  //     venue's rate - both in the payload and in the printed cell of all three
  //     tables that print it. Before the fix, Paneer Tikka printed 16.7% / 0.0% /
  //     16.7% across these same three states.
  for (const [tag, qs] of FILTER_STATES) {
    const p = payload(ro, qs);
    const wrong = p.menu_items
      .filter((m) => m.return_remake_pct !== EXPECT_RR[m.menu_item])
      .map((m) => `${m.menu_item}=${m.return_remake_pct} want ${EXPECT_RR[m.menu_item]}`);
    truthy(`${tag}: payload return_remake_pct is the VENUE rate for every dish listed`,
      wrong.length === 0, JSON.stringify(wrong));

    for (const site of RR_CELL_SITES) {
      const doc = report(p, site.key);
      const t = doc.tables.find((x) => x.name === site.table);
      if (!t) { bad(`${tag}: ${site.key}/${site.table} table exists`); continue; }
      const iItem = t.columns.findIndex((c) => c.label === 'Item');
      const iRr = t.columns.findIndex((c) => c.label === 'R/R %' || c.label === 'R/R %*');
      if (iRr < 0) { bad(`${tag}: ${site.key}/${site.table} has an R/R % column`, JSON.stringify(t.columns.map((c) => c.label))); continue; }
      const off = t.rows
        .map((r) => [String(r[iItem]), String(r[iRr])])
        // An unexpected dish name fails loudly rather than throwing on undefined.
        .filter(([name, cell]) => cell !== (EXPECT_RR[name] == null ? '<unknown dish>' : `${EXPECT_RR[name].toFixed(1)}%`));
      truthy(`${tag}: printed R/R cell is the venue rate - ${site.key}/${site.table}`,
        off.length === 0, JSON.stringify(off));
    }
  }

  // E4. THE DISH THE DEFECT WAS MEASURED ON, called out by name so a future
  //     reader sees the exact number that was wrong.
  for (const [tag, qs] of FILTER_STATES) {
    const p = payload(ro, qs);
    const pt = p.menu_items.find((m) => m.menu_item === 'Paneer Tikka');
    if (!pt) { ok(`${tag}: Paneer Tikka not in this scope's rows (nothing to print)`); continue; }
    eq(`${tag}: Paneer Tikka prints 16.7% (2 venue plates back of 12 venue plates sold)`,
      [pt.sold, pt.return_remake_pct], [fixture.PLATES_PER_DISH, 16.7]);
  }

  /* E5. THE RESIDUAL 399e4cc COULD NOT CLOSE, WIDENED TO THE SHAPE THAT ESCAPED.
        Its own note: `rate()` takes plain numbers, so a brand-new inline rate
        mixing a record count with venue sold would still compile, and branding
        `sold` would not help because a branded number is assignable to number.
        Its answer was "assert the PRINTED cell is filter-invariant however
        computed" - and that was right, but E1-E4 above only ever look at a
        single rate CELL inside three named TABLES. The fourth site was not a
        cell: it was a TILE, a value/sub PAIR on the Summary block, and it walked
        straight past every assertion here.

        So the invariance is asserted over EVERY TILE OF ALL EIGHT REPORTS -
        label, value AND sub - which is where every "N of M" the module prints
        lives. A new tile pairing a narrowed numerator with a venue denominator
        fails here on the day it is written, whatever it is computed from and
        whether or not anyone adds it to PAIR_TILES above.

        This is also the assertion that makes the FILE STOP CONTRADICTING
        ITSELF. `reports/route.ts` writes `doc.filters` and then `doc.kpis` onto
        one 'Report' sheet, four rows apart: the cover promises "the Summary
        tiles ... do not move when a name is picked" and the tiles are four rows
        below it. That promise is now proved, on the same sheet that makes it.

        ONE tile is deliberately person-aware and it is NAMED, never skipped:
        "Follow-ups open now (all dates)" is the venue's live queue, so its VALUE
        must still not move while its SUB says out loud that the number is not
        this person's. Anything else that moves is a defect. */
  section(`World ${which} - E5. every printed TILE is filter-invariant (2d: the value/sub pair)`);
  {
    const PERSON_AWARE = 'Follow-ups open now (all dates)';
    const tilesOf = (doc) => doc.kpis.map((k) => [String(k.label), String(k.value), String(k.sub == null ? '' : k.sub)]);
    for (const [tag, qs] of personStates) {
      const p = payload(ro, qs);
      const moved = [];
      for (const key of R.REPORT_KEYS) {
        const f = tilesOf(report(p, key));
        const v = tilesOf(report(all, key));
        if (f.length !== v.length) { moved.push(`${key}: tile COUNT ${v.length} -> ${f.length}`); continue; }
        f.forEach(([label, value, sub], i) => {
          const [l0, v0, s0] = v[i];
          if (label !== l0) moved.push(`${key}/#${i}: label "${l0}" -> "${label}"`);
          if (value !== v0) moved.push(`${key}/"${label}": VALUE ${v0} -> ${value}`);
          if (sub !== s0 && label !== PERSON_AWARE) moved.push(`${key}/"${label}": SUB "${s0}" -> "${sub}"`);
        });
      }
      truthy(`${tag}: every tile on all 8 reports is filter-invariant - label, VALUE and SUB`,
        moved.length === 0, JSON.stringify(moved));

      // The one allowance, ASSERTED rather than skipped.
      const k = report(p, 'daily').kpis.find((x) => x.label === PERSON_AWARE);
      truthy(`${tag}: the one person-aware sub says the number is NOT this person's`,
        !!k && /NOT this person/.test(String(k.sub)), String(k && k.sub));
      eq(`${tag}: ...and that tile's VALUE is still the venue's`,
        String(k && k.value),
        String(report(all, 'daily').kpis.find((x) => x.label === PERSON_AWARE).value));

      // The promise the invariance above discharges, on the same sheet.
      for (const key of R.REPORT_KEYS) {
        const line = report(p, key).filters.find((l) => l.includes('did NOT narrow'));
        if (!String(line || '').includes('the Summary tiles')) {
          bad(`${tag}: ${key} cover claims the Summary tiles do not move`, String(line || '').slice(0, 120));
        }
      }
      ok(`${tag}: all 8 covers claim it, and the sweep above proves it`);
    }
  }

  /* ── F. THE MIXED ROW SAYS SO ───────────────────────────────────────────── */
  section(`World ${which} - F. the two venue columns inside a record row are marked and defined`);
  for (const site of RR_CELL_SITES) {
    const t0 = report(all, site.key).tables.find((x) => x.name === site.table);
    eq(`unfiltered ${site.key}/${site.table}: no mark (no second scope in the row)`,
      t0.columns.map((c) => c.label).filter((l) => l.includes('*')), []);
  }
  eq('unfiltered: meta.venue_columns_basis is empty', all.meta.venue_columns_basis, '');
  truthy('the venue basis sentence names the whole venue on both sides',
    /BOTH SIDES ARE THE WHOLE VENUE/.test(String(all.meta.return_remake_basis)),
    String(all.meta.return_remake_basis));

  for (const [tag, qs] of personStates) {
    const p = payload(ro, qs);
    // String() throughout: a missing field must produce a NAMED failure, not a
    // TypeError that stops the run before the later gates are reached.
    const basis = String(p.meta.venue_columns_basis);
    truthy(`${tag}: meta.venue_columns_basis defines the mark for the screen`,
      basis.includes('MARKED *') && /Sold\*/.test(basis), basis);
    for (const site of RR_CELL_SITES) {
      const t = report(p, site.key).tables.find((x) => x.name === site.table);
      const marked = t.columns.map((c) => c.label).filter((l) => l.includes('*'));
      eq(`${tag}: ${site.key}/${site.table} marks exactly Sold* and R/R %*`, marked, ['Sold*', 'R/R %*']);
      truthy(`${tag}: ${site.key}/${site.table} note defines the mark`,
        String(t.note || '').includes('MARKED * ARE THE VENUE'), String(t.note || '').slice(0, 120));
    }
    // and on the cover of every file, not just on the sheet
    for (const key of R.REPORT_KEYS) {
      const line = report(p, key).filters.find((l) => l.includes('NARROWED to'));
      if (!String(line || '').includes('Sold* and R/R %* are the VENUE')) {
        bad(`${tag}: ${key} cover names the two venue columns`, String(line || '').slice(0, 160));
      }
    }
    ok(`${tag}: all 8 covers name the two venue columns`);
  }

  /* ── I. THE MARK MUST NOT TRUNCATE IN THE PRINTED REPORT ────────────────── */
  // This module has shipped truncated HEADINGS twice: once making "Negative" and
  // "Negative %" both print as "Negativ…" - two different columns under the SAME
  // visible heading - and once making a GRE's 100% floor coverage print as "1…".
  // Adding a character to a heading is therefore not a cosmetic change, and the
  // `*` marks above added one to two MEASURED columns. Checked here against
  // report-pdf.ts's own numbers (A4 portrait, MARGIN 40, PAD 4, Helvetica-Bold 8,
  // widths normalised over the table's total), on every column of every table of
  // all eight reports - not just the two this change touched.
  section(`World ${which} - I. no heading truncates in the PDF (report-pdf.ts's own metrics)`);
  {
    const PDF_CONTENT_W = 595.28 - 40 * 2;
    const PDF_PAD = 4;
    const measure = new PDFDocument({ size: 'A4', margin: 40 });
    measure.font('Helvetica-Bold').fontSize(8);
    for (const [tag, qs] of FILTER_STATES) {
      const p = payload(ro, qs);
      const over = [];
      const collided = [];
      for (const key of R.REPORT_KEYS) {
        for (const t of report(p, key).tables) {
          const cols = (t.columns || []).filter(Boolean);
          if (!cols.length) continue;
          const total = cols.reduce((a, c) => a + (Number(c.width) || 1), 0);
          const drawn = [];
          cols.forEach((c) => {
            const usable = ((Number(c.width) || 1) / total) * PDF_CONTENT_W - PDF_PAD * 2;
            const ink = measure.widthOfString(String(c.label));
            if (ink > usable) over.push(`${key}/${t.name}/"${c.label}" ${ink.toFixed(1)}pt > ${usable.toFixed(1)}pt`);
            drawn.push(String(c.label));
          });
          if (new Set(drawn).size !== drawn.length) collided.push(`${key}/${t.name}: ${drawn.join(',')}`);
        }
      }
      truthy(`${tag}: every column heading fits its column`, over.length === 0, JSON.stringify(over));
      truthy(`${tag}: no two headings in one table print the same string`, collided.length === 0, JSON.stringify(collided));
    }
    measure.end();
  }

  /* ── J. THE WALK: EVERY PRINTED NUMBER, WHATEVER BLOCK IT LIVES IN ──────── */
  /* Gates D and E5 are LISTS. This one is an ENUMERATION - see "THE WALK"
     above. It reaches the tiles E5 reaches, and also the table cells, the
     footnotes, the sheet notes, the column headings, the cover lines and the
     title block, and it fails on a ReportDoc key it has not been taught. */
  section(`World ${which} - J. THE WALK - every printed number in all 8 reports, by block`);
  {
    const unknown = [];
    const walked = {};        // tag -> path -> loc
    for (const [tag, qs] of FILTER_STATES) {
      const p = payload(ro, qs);
      walked[tag] = {};
      for (const key of R.REPORT_KEYS) walked[tag][key] = walkDoc(report(p, key), unknown);
    }

    /* J0. THE WALK IS COMPLETE, OR IT SAYS WHAT IT MISSED. */
    eq('J0: the walk consumes every own key of every ReportDoc / sheet / tile / column',
      [...new Set(unknown)].sort(), []);
    const census = { figure: 0, pair: 0, prose: 0 };
    const kinds = new Set();
    for (const key of R.REPORT_KEYS) {
      for (const l of walked['(no filter)'][key]) { census[l.kind] += 1; kinds.add(l.kind); }
    }
    eq('J0: every kind of printed string is reached (figure, pair, prose)',
      [...kinds].sort(), ['figure', 'pair', 'prose']);
    truthy(`J0: the unfiltered walk reaches ${census.figure} figures, ${census.pair} pairs, `
      + `${census.prose} prose blocks across the 8 reports`,
      census.figure > 100 && census.pair > 20 && census.prose > 100,
      JSON.stringify(census));

    /* J1. THE COVER CLASSIFIES EVERY SHEET, or the gap is named.
           Property A needs to know which numbers are ALLOWED to narrow. That
           answer is taken from the file's own two sentences, not from a list in
           this suite - so the promise and the behaviour are checked against each
           other rather than both against a third thing that can drift. */
    for (const [tag, qs] of FILTER_STATES.filter(([, q]) => q !== '')) {
      const p = payload(ro, qs);
      const unclassified = [];
      for (const key of R.REPORT_KEYS) {
        const doc = report(p, key);
        const cover = coverScopes(doc);
        for (const t of doc.tables) {
          if (cover.of(t.name) === 'silent' && !COVER_SILENT.has(t.name)) unclassified.push(`${key}/${t.name}`);
        }
      }
      eq(`${tag}: every sheet is classified by the cover, or named in COVER_SILENT`, unclassified, []);
    }

    /* J2. FILTER INVARIANCE, LOCATION BY LOCATION, FOR EVERY BLOCK.
           A 'figure' or 'pair' on a sheet the cover does not say it narrowed -
           and every tile, whatever the cover says, because the cover says the
           tiles do not move - must be character-identical in every filter state.
           This is E5's assertion with the word TILE removed from it. */
    const v = walked['(no filter)'];
    for (const [tag, qs] of FILTER_STATES.filter(([, q]) => q !== '')) {
      const p = payload(ro, qs);
      const moved = [];
      for (const key of R.REPORT_KEYS) {
        const cover = coverScopes(report(p, key));
        const base = byPath(v[key]);
        const now = walked[tag][key];
        // A location that exists in one state and not the other, on a sheet the
        // cover did not say it narrowed, is itself a move.
        const seen = new Set();
        for (const l of now) {
          seen.add(l.path);
          if (l.kind === 'prose') continue;                    // J3 handles prose
          const sheet = /^sheet\["([^"]+)"\]/.exec(l.path);
          if (sheet && cover.of(sheet[1]) === 'narrowed') continue;
          if (sheet && sheet[1] === PERSON_ROW_SHEET) continue;                   // J7, by name
          if (l.path === `tile["${PERSON_AWARE_TILE}"].sub`) continue;            // the one allowance
          const was = base.get(l.path);
          if (!was) { moved.push(`${key}: ${l.path} APPEARED = ${JSON.stringify(l.text)}`); continue; }
          if (was.text !== l.text) moved.push(`${key}: ${l.path} ${JSON.stringify(was.text)} -> ${JSON.stringify(l.text)}`);
        }
        for (const l of v[key]) {
          if (l.kind === 'prose' || seen.has(l.path)) continue;
          const sheet = /^sheet\["([^"]+)"\]/.exec(l.path);
          if (sheet && cover.of(sheet[1]) === 'narrowed') continue;
          if (sheet && sheet[1] === PERSON_ROW_SHEET) continue;                   // J7, by name
          moved.push(`${key}: ${l.path} VANISHED (was ${JSON.stringify(l.text)})`);
        }
      }
      truthy(`${tag}: every printed figure outside the cover's NARROWED sheets is identical `
        + '- tiles AND table cells AND headings', moved.length === 0, JSON.stringify(moved.slice(0, 12)));
    }

    /* J3. PROSE CARRIES NUMBERS TOO - the footnote block is prose, and it is
           where the fifth instance of this defect class lived.
           Each prose SLOT (a named sheet's note, a footnote position, a cover
           label) is compared across filter states for its OWN numbers - the
           published basis sentences stripped out first, see `ownNums`. A slot
           that exists only under a filter, or whose own numbers move, must NAME
           the person; a venue number cannot appear in filtered-only prose
           without saying whose it is, and once it names the person J5 checks the
           claim it makes. */
    for (const [tag, qs] of FILTER_STATES.filter(([, q]) => q !== '')) {
      const p = payload(ro, qs);
      const person = p.records.person;
      const drifted = [];
      for (const key of R.REPORT_KEYS) {
        const was = new Map();
        for (const l of v[key]) if (l.kind === 'prose') was.set(proseSlot(l), l.text);
        for (const l of walked[tag][key]) {
          if (l.kind !== 'prose') continue;
          const slot = proseSlot(l);
          const before = was.has(slot) ? ownNums(was.get(slot)) : [];
          const after = ownNums(l.text);
          if (JSON.stringify(before) === JSON.stringify(after)) continue;
          if (person && l.text.includes(person)) continue;   // says whose number it is - J5 checks it
          drifted.push(`${key}: ${slot} own numbers ${JSON.stringify(before)} -> ${JSON.stringify(after)} `
            + `in ${JSON.stringify(l.text.slice(0, 120))}`);
        }
      }
      eq(`${tag}: no prose block's own numbers move without naming the person`, drifted, []);
    }

    /* J4. A PRINTED RATE EQUALS THE RATE OF ITS OWN PRINTED PAIR.
           Within one cell ("4/6 66.7%", "3/4 · 75.0%", "3 of 4 closed - 75.0%"),
           within one tile (value 66.7% over sub "8 of 12 eligible tables"), and
           ACROSS THE CELLS OF ONE ROW - which is the S1 shape: the Value column
           prints the percentage and the Basis column beside it prints "4 of 6".
           No place is named; every unit the walk produced is tried. */
    for (const [tag] of FILTER_STATES) {
      const disagree = [];
      for (const key of R.REPORT_KEYS) {
        const units = new Map();
        for (const l of walked[tag][key]) {
          if (!units.has(l.unit)) units.set(l.unit, []);
          units.get(l.unit).push(l);
        }
        for (const [unit, locs] of units) {
          // (a) inside one string - "4/6 66.7%", "3/4 · 75.0%", "3 of 4 closed - 75.0%"
          const selfChecked = new Set();
          for (const l of locs) {
            const prs = pairsOf(l.text);
            const pcs = pctsOf(l.text);
            if (prs.length !== 1 || pcs.length !== 1) continue;
            selfChecked.add(l.path);
            const want = pctCell(prs[0][0], prs[0][1]);
            if (`${pcs[0]}%` !== want) disagree.push(`${key}: ${l.path} prints ${JSON.stringify(l.text)} - ${prs[0][0]}/${prs[0][1]} is ${want}`);
          }
          // (b) ACROSS the strings a reader reads together - one table row, one
          //     tile. This is the S1 shape: the Value column prints "66.7%" and
          //     the Basis column beside it prints "4 of 6 eligible tables on
          //     their floor". A sentence UNDER the table is not read as part of
          //     the row, so notes are (a)-only.
          const joint = locs.filter((l) => !/\.(note|emptyNote)$/.test(l.path) && !selfChecked.has(l.path));
          const prs = joint.flatMap((l) => pairsOf(l.text));
          const pcs = joint.flatMap((l) => pctsOf(l.text));
          if (prs.length !== 1 || pcs.length !== 1) continue;
          const want = pctCell(prs[0][0], prs[0][1]);
          if (`${pcs[0]}%` !== want) {
            disagree.push(`${key}: ${unit} prints ${pcs[0]}% beside ${prs[0][0]} of ${prs[0][1]} (which is ${want}) `
              + `- ${JSON.stringify(joint.map((l) => l.text))}`);
          }
        }
      }
      eq(`${tag}: every printed rate equals the rate of its own printed pair`, disagree, []);
    }

    /* J5. "N OF THOSE" CANNOT EXCEED THE NUMBER IT IS 'OF'.
           The footnote block is the SECOND deliberately person-aware printed
           number in this module, and it is the one E5's tile sweep cannot see:
           `reports/route.ts` writes doc.filters, then doc.kpis, then the notes
           onto the same sheet, so the tile says "2" under ['Summary'] and four
           rows below ['Notes'] says "4 of those are theirs" - "4 of those 2".
           The rule is general: a sentence that QUOTES a printed label and then
           claims "N of those" is claiming N <= that label's printed number, and
           a row labelled "Of those, ..." claims the same against the row above
           it. Neither is listed; both are found by the walk. */
    for (const [tag, qs] of FILTER_STATES) {
      const p = payload(ro, qs);
      const over = [];
      /** claim text -> the reports on which the quoted label IS printed. A claim
       *  checkable nowhere is itself a failure: the footnote travels into all
       *  eight files while the tile it quotes is on three of them, so the rule
       *  must bite on those three and must not fall silent if it stops biting. */
      const checked = new Map();
      for (const key of R.REPORT_KEYS) {
        const doc = report(p, key);
        /** Every printed number a label can be looked up by, on this sheet. */
        const printed = new Map();
        for (const kp of doc.kpis) printed.set(String(kp.label), Number(String(kp.value).replace(/,/g, '')));
        for (const t of doc.tables) {
          for (const r of t.rows) if (isNumCell(r[1])) printed.set(String(r[0]), Number(String(r[1]).replace(/,/g, '')));
        }
        // (a) prose that quotes a label and then says "N of those"
        for (const text of [...doc.footnotes, ...doc.filters, ...doc.tables.flatMap((t) => [t.note, t.emptyNote])]) {
          const s = String(text || '');
          const claim = /(\d+(?:\.\d+)?)\s+of\s+those\b/.exec(s);
          if (!claim) continue;
          if (!checked.has(s)) checked.set(s, []);
          const quoted = [...s.matchAll(/"([^"]{4,60})"/g)].map((m) => m[1]).filter((q) => printed.has(q));
          for (const q of quoted) {
            checked.get(s).push(`${key}/"${q}"`);
            if (Number(claim[1]) > printed.get(q)) {
              over.push(`${key}: "${q}" prints ${printed.get(q)} but the note says ${claim[1]} of those `
                + `- ${JSON.stringify(s.slice(0, 160))}`);
            }
          }
        }
        // (b) a row that says "Of those, ..." about the row above it
        for (const t of doc.tables) {
          t.rows.forEach((r, i) => {
            if (!/^of those\b/i.test(String(r[0])) || i === 0) return;
            const mine = Number(String(r[1]).replace(/,/g, ''));
            const above = Number(String(t.rows[i - 1][1]).replace(/,/g, ''));
            if (Number.isFinite(mine) && Number.isFinite(above) && mine > above) {
              over.push(`${key}/${t.name}: "${r[0]}" = ${mine} exceeds the ${above} it is "of those" of`);
            }
          });
        }
      }
      eq(`${tag}: no "N of those" exceeds the number it is 'of' (tiles, notes, footnotes, rows)`, over, []);
      const uncheckable = [...checked.entries()].filter(([, where]) => where.length === 0)
        .map(([s]) => s.slice(0, 90));
      eq(`${tag}: every "N of those" claim is checkable against a printed label on at least one report`,
        uncheckable, []);
    }

    /* J5c. THE PARTITION - the assertion that does not depend on which person
            happens to have the bigger number.
            "N of those are theirs" claims a SHARE of a venue queue, and an open
            follow-up has exactly one raiser. So the same sentence, run over
            EVERY person in turn, cannot between them claim more of the queue than
            the queue holds. Swapping the footnote from `follow_ups_open` to
            `follow_ups_raised` makes the four claims add to more than the venue's
            open count in BOTH worlds, where person-by-person containment only
            catches the people who raised more than the whole room has open. */
    {
      const personStatesJ = FILTER_STATES.filter(([, q]) => q !== '');
      const overclaimed = [];
      for (const key of R.REPORT_KEYS) {
        const v0 = report(all, key);
        const venue = new Map();
        for (const kp of v0.kpis) venue.set(String(kp.label), Number(String(kp.value).replace(/,/g, '')));
        for (const t of v0.tables) {
          for (const r of t.rows) if (isNumCell(r[1])) venue.set(String(r[0]), Number(String(r[1]).replace(/,/g, '')));
        }
        const claimed = new Map();       // quoted venue label -> summed claim
        for (const [, qs] of personStatesJ) {
          const doc = report(payload(ro, qs), key);
          for (const text of [...doc.footnotes, ...doc.filters, ...doc.tables.flatMap((t) => [t.note, t.emptyNote])]) {
            const s = String(text || '');
            const claim = /(\d+(?:\.\d+)?)\s+of\s+those\b/.exec(s);
            if (!claim) continue;
            for (const q of [...s.matchAll(/"([^"]{4,60})"/g)].map((m) => m[1]).filter((x) => venue.has(x))) {
              claimed.set(q, (claimed.get(q) || 0) + Number(claim[1]));
            }
          }
          // ...and the same partition for the row form of the claim.
          for (const t of doc.tables) {
            t.rows.forEach((r, i) => {
              if (!/^of those\b/i.test(String(r[0])) || i === 0) return;
              const id = `${t.name} :: ${String(t.rows[i - 1][0])}`;
              if (!venue.has(id)) venue.set(id, Number(String(report(all, key).tables.find((x) => x.name === t.name).rows[i - 1][1]).replace(/,/g, '')));
              claimed.set(id, (claimed.get(id) || 0) + Number(String(r[1]).replace(/,/g, '')));
            });
          }
        }
        for (const [label, sum] of claimed) {
          if (sum > venue.get(label)) {
            overclaimed.push(`${key}: the ${personStatesJ.length} people together claim ${sum} of "${label}", `
              + `which prints ${venue.get(label)}`);
          }
        }
      }
      eq('J5c: the per-person claims about a venue queue add up to at most the queue', overclaimed, []);
    }

    /* J6. EVERY PERCENTAGE COLUMN IS EXPLAINED BY ITS OWN SHEET'S NUMBERS, AND
           BY THE SAME ONE IN EVERY FILTER STATE. See `rateBases()`. "Narrows on
           BOTH sides" is exactly this: a basis that explains the column
           unfiltered must still explain it when the numerator narrows, which it
           can only do if the denominator narrowed with it. */
    {
      const perColumn = new Map();   // "key/table/column" -> { states, common }
      const missingBasisSentence = [];
      for (const [tag, qs] of FILTER_STATES) {
        const p = payload(ro, qs);
        for (const key of R.REPORT_KEYS) {
          for (const t of report(p, key).tables) {
            const bases = rateBases(t);
            for (const [col, b] of Object.entries(bases)) {
              // A shared denominator is admissible only for a column that SAYS
              // it is a share; everything else must be the rate of its own row.
              const found = b.isShare ? [...b.perRow, ...b.whole] : b.perRow;
              const id = `${key}/${t.name}/${col}`;
              if (!perColumn.has(id)) perColumn.set(id, { col, states: [], common: null });
              const e = perColumn.get(id);
              e.states.push({ tag, found });
              e.common = e.common === null ? found.slice() : e.common.filter((x) => found.includes(x));
              // A column excused from the in-row rule must still carry, ON THE
              // SHEET, the sentence that explains where its numerator came from.
              if (OFF_SHEET_RATE_BASIS.has(col) && !String(t.note || '').includes(R.RETURN_REMAKE_BASIS)) {
                missingBasisSentence.push(`${id} (${tag})`);
              }
            }
          }
        }
      }
      const unexplained = [];
      const inconsistent = [];
      /** register key -> did it ever actually need excusing, anywhere in this
       *  world? A column that is explained on every sheet in every state does
       *  not, and the entry has to go, or the register rots into a blanket. */
      const registerEarnsIts = new Map([...OFF_SHEET_RATE_BASIS.keys()].map((k) => [k, false]));
      for (const [id, e] of perColumn) {
        const empty = e.states.filter((s) => s.found.length === 0).map((s) => s.tag);
        if (OFF_SHEET_RATE_BASIS.has(e.col)) {
          if (empty.length) registerEarnsIts.set(e.col, true);
          continue;
        }
        if (empty.length) { unexplained.push(`${id} explained by NOTHING the sheet prints in ${JSON.stringify(empty)}`); continue; }
        if (!e.common.length) {
          inconsistent.push(`${id} changes basis between filter states: `
            + JSON.stringify(e.states.map((s) => `${s.tag}=${s.found[0]}`)));
        }
      }
      truthy('J6: every percentage column of all 8 reports is the rate of two numbers printed on '
        + `its own sheet (${perColumn.size} columns walked, ${OFF_SHEET_RATE_BASIS.size} named exceptions)`,
        unexplained.length === 0, JSON.stringify(unexplained));
      eq('J6: and the SAME basis explains it in every filter state (both sides narrow together)',
        inconsistent, []);
      eq('J6: the OFF_SHEET_RATE_BASIS register is still needed (no stale entry)',
        [...registerEarnsIts].filter(([, earned]) => !earned).map(([k]) => k), []);
      eq('J6: every excused column prints RETURN_REMAKE_BASIS on its own sheet', missingBasisSentence, []);
      truthy('J6: the walk actually found percentage columns to explain', perColumn.size >= 8, String(perColumn.size));
    }

    /* J8. THE SAME QUANTITY, PRINTED IN TWO BLOCKS, MUST AGREE.
           J3 proves a prose number does not MOVE between filter states; it does
           NOT prove the number is right, because a hard-coded one is equally
           wrong in all five. The business-day rollover is the one quantity this
           module prints in three different blocks - the period line, the cover's
           "Business-day rollover:" line and the footnote that explains the
           convention - so those three are made to agree with each other and with
           the range the payload resolved. The reader's own cue does the finding:
           a clock token next to the word "rollover". The illustrative "01:30" in
           the same footnote is not next to it and is left alone.
           ⚠️ This closes ONE instance of a general class. A quantity printed in
           only one block still has nothing here to disagree with. */
    for (const [tag, qs] of FILTER_STATES) {
      const p = payload(ro, qs);
      const wrong = [];
      for (const key of R.REPORT_KEYS) {
        const seen = new Map();
        for (const l of walked[tag][key]) {
          for (const m of String(l.text).matchAll(/(\d{1,2}:\d{2})\s+rollover|rollover[:\s]+(\d{1,2}:\d{2})/gi)) {
            const clock = m[1] || m[2];
            if (!seen.has(clock)) seen.set(clock, []);
            seen.get(clock).push(l.path);
          }
        }
        if (!seen.size) { wrong.push(`${key}: prints no rollover at all`); continue; }
        if (seen.size > 1) wrong.push(`${key}: ${JSON.stringify([...seen].map(([c, w]) => `${c} at ${w.join(',')}`))}`);
        else if (![...seen.keys()].includes(String(p.range.cutoff))) {
          wrong.push(`${key}: prints ${[...seen.keys()][0]} but the range resolved ${p.range.cutoff}`);
        }
      }
      eq(`${tag}: the rollover printed in the period line, the cover and the footnote is one number`, wrong, []);
    }

    /* J7. THE SHEETS THE COVER DOES NOT CLASSIFY, ASSERTED RATHER THAN SKIPPED. */
    for (const [tag, qs] of FILTER_STATES.filter(([, q]) => q !== '')) {
      const p = payload(ro, qs);
      const bad = [];
      for (const key of R.REPORT_KEYS) {
        const doc = report(p, key);
        const t = doc.tables.find((x) => x.name === PERSON_ROW_SHEET);
        if (!t) continue;
        const t0 = report(all, key).tables.find((x) => x.name === PERSON_ROW_SHEET);
        if (t.rows.length !== t0.rows.length + 1) { bad.push(`${key}: ${t0.rows.length} -> ${t.rows.length} rows`); continue; }
        // The venue row keeps its NUMBER; its label gains "- THE WHOLE VENUE",
        // which is the whole point of the second row existing.
        if (String(t.rows[0][1]) !== String(t0.rows[0][1])) {
          bad.push(`${key}: the venue count moved ${t0.rows[0][1]} -> ${t.rows[0][1]}`);
        }
        if (!String(t.rows[0][0]).startsWith(String(t0.rows[0][0]))) bad.push(`${key}: the venue row was relabelled`);
        if (!/WHOLE VENUE/.test(String(t.rows[0][0]))) bad.push(`${key}: the venue row does not say it is the venue's`);
        if (!/^of those\b/i.test(String(t.rows[1][0]))) bad.push(`${key}: the added row does not say "Of those"`);
        if (!String(t.rows[1][0]).includes(p.records.person)) bad.push(`${key}: the added row does not name the person`);
      }
      eq(`${tag}: "${PERSON_ROW_SHEET}" gains exactly the one named person row`, bad, []);
    }
    for (const reason of COVER_SILENT.values()) truthy(`J7: COVER_SILENT states a reason (${reason.slice(0, 48)}...)`, reason.length > 40);
  }

  /* ── G. HAND-COMPUTED TOTALS ────────────────────────────────────────────── */
  section(`World ${which} - G. the fixture's own arithmetic`);
  const s = all.summary;
  eq('eligible tables', s.eligible_tables, fixture.TABLES);
  eq('plates sold', s.plates_sold, fixture.PLATES_SOLD);
  // `|| {}`: see gate D. A missing field must FAIL here, not throw here.
  const iwf = all.records.items_with_feedback || {};
  eq('distinct items sold', iwf.of, fixture.DISHES.length);
  eq('distinct items the VENUE commented on', iwf.count, which === 'A' ? 6 : 4);
  if (which === 'A') {
    // 8 visits: poor, average, average, good (subject) + poor, good, excellent
    // (Steady) + average (Manager).
    eq('A: rating split', [s.excellent, s.good, s.average, s.poor, s.unrated], [1, 2, 3, 2, 0]);
    eq('A: feedbacks recorded', s.feedbacks_recorded, 8);
    eq('A: eligible tables covered', s.eligible_tables_covered, 8);
    eq('A: item feedbacks', s.item_feedbacks, 9);
    eq('A: negative item feedbacks', s.negative_item_feedbacks, 7);
    eq('A: returned / remade / replaced / cancelled', [s.returned, s.remade, s.replaced, s.cancelled], [2, 2, 2, 1]);
    eq('A: happy / partial / unhappy after correction',
      [s.happy_after_replacement, s.partially_happy, s.still_unhappy], [2, 1, 2]);
  } else {
    // Same 8 visits, but the subject's four are "everything good" / excellent.
    eq('B: rating split', [s.excellent, s.good, s.average, s.poor, s.unrated], [5, 1, 1, 1, 0]);
    eq('B: feedbacks recorded', s.feedbacks_recorded, 8);
    // Only the control recorders write at item level in world B: Steady's two on
    // v5 and one on v6, plus the Manager's one on v8.
    eq('B: item feedbacks', s.item_feedbacks, 4);
    eq('B: negative item feedbacks', s.negative_item_feedbacks, 3);
    eq('B: returned / remade / replaced / cancelled', [s.returned, s.remade, s.replaced, s.cancelled], [1, 1, 1, 0]);
  }

  /* ── H. THE FAIRNESS RULING, ACROSS THE TWO WORLDS ──────────────────────── */
  // Asserted once, in world B, against world A's numbers - see the tail below.
  ro.close();
  return { all, subject: payload(new Database(SNAPS[which], { readonly: true }), `&gre=${encodeURIComponent(SUBJECT.name)}`) };
}

/* ── 4. RUN ──────────────────────────────────────────────────────────────── */

console.log('Guest Feedback - the two scopes. Snapshots in ' + TMP);

const A = runWorld('A');
const B = runWorld('B');

section('H. RECORDING HONESTLY COSTS HER NOTHING THE FILTER CAN SHOW');
// The two worlds are DIFFERENT data, so the venue's ratings differ - that is the
// point of world B. What must hold is that in EACH world the subject's own filter
// shows her the venue's ratings and not a version of them shaped by what she
// wrote, and that her person block is the same SHAPE in both.
eq('A: her filter shows the venue rating split, not hers',
  [A.subject.summary.excellent, A.subject.summary.poor], [A.all.summary.excellent, A.all.summary.poor]);
eq('B: her filter shows the venue rating split, not hers',
  [B.subject.summary.excellent, B.subject.summary.poor], [B.all.summary.excellent, B.all.summary.poor]);
truthy('recording honestly did not give her a worse rating split than recording nothing: '
  + `A poor=${A.all.summary.poor} vs B poor=${B.all.summary.poor} are VENUE figures under her name in both`,
  A.subject.summary.poor === A.all.summary.poor && B.subject.summary.poor === B.all.summary.poor);
eq('her person block has the same 21 keys in both worlds',
  Object.keys(A.subject.person || {}), Object.keys(B.subject.person || {}));
// And the dish rate does not depend on which world she is in for the plates that
// SHE did not touch: Paneer Tikka went back in both worlds, recorded by Steady.
eq('Paneer Tikka is 16.7% in BOTH worlds, under her name',
  [A.subject.menu_items.concat(A.all.menu_items).filter((m) => m.menu_item === 'Paneer Tikka').map((m) => m.return_remake_pct),
    B.all.menu_items.filter((m) => m.menu_item === 'Paneer Tikka').map((m) => m.return_remake_pct)],
  [[16.7, 16.7], [16.7]]);

/* ── 5. RESULT ───────────────────────────────────────────────────────────── */

console.log('');
console.log('─'.repeat(72));
console.log(`feedback-scope-tests: ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  - ' + f);
}
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp dir */ }
process.exit(fail ? 1 : 0);
