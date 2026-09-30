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
 *   D  BOTH SIDES OF A RATE COUNT THE SAME POPULATION - "Share of negatives"
 *      adds to 100%, and the menu-item KPI keeps the VENUE "items sold"
 *      denominator.
 *   E  THE RETURN / REMAKE RATE IS VENUE OVER VENUE - the regression this suite
 *      was written for. Hand-computed per dish, asserted identical across every
 *      filter state, and asserted at the printed cell in all three places the
 *      module prints it. Plus the structural half: the row carries no
 *      per-person quantity field for a future edit to divide by `sold`.
 *   F  THE MIXED ROW SAYS SO - under a person filter the two venue columns are
 *      marked and the mark is defined, on the sheet and in the payload the
 *      screen reads; unfiltered there is no mark, because there is no second
 *      scope in the row.
 *   G  HAND-COMPUTED TOTALS - the fixture's own arithmetic, so a change that
 *      keeps every invariance while breaking the numbers still fails.
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
const RANGE = `range=custom&from=${fixture.DAY}&to=${fixture.DAY}`;

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
  section(`World ${which} - D. a rate's two sides count the same population`);
  for (const [tag, qs] of FILTER_STATES) {
    const p = payload(ro, qs);
    const t = report(p, 'negative').tables.find((x) => x.name === 'Most common problems');
    const shares = t.rows.map((r) => parseFloat(String(r[2])));
    const sum = shares.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
    truthy(`${tag}: "Share of negatives" adds to 100% (got ${sum.toFixed(1)}%, ${t.rows.length} rows)`,
      t.rows.length === 0 || Math.abs(sum - 100) < 0.5);
    const mi = report(p, 'menu-item');
    eq(`${tag}: menu-item KPI keeps the VENUE "items sold" denominator`,
      mi.kpis[0].sub, `of ${all.records.items_sold} items sold`);
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

  /* ── G. HAND-COMPUTED TOTALS ────────────────────────────────────────────── */
  section(`World ${which} - G. the fixture's own arithmetic`);
  const s = all.summary;
  eq('eligible tables', s.eligible_tables, fixture.TABLES);
  eq('plates sold', s.plates_sold, fixture.PLATES_SOLD);
  eq('distinct items sold', all.records.items_sold, fixture.DISHES.length);
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
