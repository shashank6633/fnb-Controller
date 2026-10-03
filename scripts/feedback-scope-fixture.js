#!/usr/bin/env node
/**
 * THE TWO-WORLDS FIXTURE for scripts/feedback-scope-tests.js.
 *
 * Same convention as scripts/reviews-fixture.js: the data lives beside the suite
 * that asserts on it, so the expected numbers in the suite can be worked out by
 * hand from this file and not from the code under test.
 *
 * ONE NIGHT, TWO WORLDS. Identical tables, orders, order lines, recorders and
 * visit COUNT. The only difference is what the subject GRE wrote down:
 *
 *   world 'A'  she records what the guests actually said - poor ratings,
 *              returns, a remake, a cancellation, one unhappy revisit.
 *   world 'B'  she taps "everything good" on the SAME four tables and records
 *              nothing at item level.
 *
 * That pair is the owner's fairness ruling made testable: a GRE who records
 * honestly must not end up with worse-looking numbers than one who records
 * nothing, and picking her name must not change any rating the guests gave.
 *
 * WRITES INTO A SNAPSHOT, NEVER THE LIVE DB. `build()` takes an open handle and
 * the caller is responsible for it being a VACUUM INTO copy in a temp dir; the
 * suite asserts that before calling in (see assertSandboxed there).
 *
 * It DELETES every gf_* row first, deliberately: the fixture has to be the whole
 * truth of the night, or a venue-invariance assertion would be measuring the
 * owner's real data as well as this one.
 *
 * Every statement here is PREPARED - no SQL is assembled from a value.
 */

'use strict';

/**
 * TWO BUSINESS DAYS, because ONE made a second family of printed numbers
 * unreachable. With every order and every visit on a single day, the By day
 * sheet had exactly ONE row, and that row's `Eligible` was the VENUE's eligible
 * count - so swapping the day's Coverage onto the venue denominator (the same
 * record-over-venue defect, one sheet along) was BYTE-IDENTICAL output. Measured.
 *
 * Tables 7-12 and the two control visits on them now sit on the previous business
 * day, which splits the room 6/6 and the visits 6/2:
 *
 *   DAY_ONE (27th)  tables 7-12 eligible, visits 7 + 8 taken   ->  2 of 6  33.3%
 *   DAY_TWO (28th)  tables 1-6  eligible, visits 1-6 taken     ->  6 of 6 100.0%
 *   both together                                              ->  8 of 12 66.7%
 *
 * The venue totals are unchanged by construction - the same 12 tables, the same
 * 12 orders, the same 72 plates, the same 8 visits, the same recorders - so every
 * hand-computed total in the suite still holds; only the DAY the row lands on
 * differs, and now there are two rows to tell apart.
 */
const DAY_ONE = '2026-09-27';
const DAY_TWO = '2026-09-28';
/** The LAST business day in the fixture - what a single-day caller would use. */
const DAY = DAY_TWO;
/** Tables 1-6 (and their visits) on the later day, 7-12 on the earlier one. */
const dayOf = (n) => (n <= 6 ? DAY_TWO : DAY_ONE);
/** Stamps are UTC, as the module stores; 14:00-18:00 UTC is 19:30-23:30 IST, so
 *  every row lands on its own business day under the 04:00 rollover. */
const TS = (day, h, m) => `${day} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;

const SUBJECT = { id: 'fs-u-probe', name: 'Probe Gre', role: 'GRE' };
const STEADY = { id: 'fs-u-steady', name: 'Steady Gre', role: 'GRE' };
/** Holds the GRE role and records NOTHING - the 'assigned' row, and the name the
 *  dropdown has to offer even though no visit mentions her. */
const SILENT = { id: 'fs-u-silent', name: 'Silent Gre', role: 'GRE' };
const MGR = { id: 'fs-u-mgr', name: 'Probe Mgr', role: 'Manager' };

const PEOPLE = { SUBJECT, STEADY, SILENT, MGR };

/** Six dishes, rotating over 12 orders x 3 lines x 2 plates = 72 plates, which
 *  works out at EXACTLY 12 plates of each dish. That flat denominator is what
 *  makes the Return / Remake Rate hand-computable: 2 plates back out of 12 is
 *  16.7% for that dish, whoever recorded it. */
const DISHES = ['Paneer Tikka', 'Mutton Biryani', 'Gulab Jamun', 'Butter Naan', 'Old Monk', 'Filter Coffee'];

const TABLES = 12;
const PLATES_PER_LINE = 2;
const LINES_PER_ORDER = 3;

/**
 * TWO FLOORS, AND SOMEBODY ASSIGNED TO EACH - because ONE FLOOR AND NOBODY
 * ASSIGNED made a whole family of printed numbers unreachable.
 *
 * `users.preferred_zones` has ZERO populated rows in the real database (zones.ts
 * says so in its own header), and this fixture populated none either. So
 * `area_assigned` was false for every person in both worlds, and every cell that
 * depends on it printed the SAME literal in every state:
 *
 *   'By person' / 'Their floor'                 ->  '-'
 *   'By person' / 'Off-floor'                   ->  '-'
 *   "What <name> did" / Coverage of their floor ->  '-'
 *
 * Measured: swapping that coverage percentage's denominator to the VENUE's
 * eligible tables - the exact record-over-venue defect this suite exists for -
 * produced BYTE-IDENTICAL output in all eight reports and all five filter
 * states, in both worlds. No guard can catch a number the fixture never prints.
 *
 * So the room now has two floors of six eligible tables each, and two of the
 * four people hold an assignment. That makes the floor denominator (6) DIFFERENT
 * from the venue denominator (12), which is what gives the swap something to
 * change, and it exercises the off-floor counter as well:
 *
 *   Probe Gre   assigned Ground   visits T1-T4  ->  4 of 6 = 66.7%, off-floor 0
 *   Steady Gre  assigned Terrace  visits T5,T6 (Ground) + T7 (Terrace)
 *                                             ->  1 of 6 = 16.7%, off-floor 2
 *   Probe Mgr / Silent Gre  no assignment      ->  '-' , the row that proves the
 *                                                 owner's "floor is a DEFAULT"
 *                                                 ruling still prints a dash.
 */
const FLOORS = ['Ground', 'Terrace'];
/** Tables 1-6 Ground, 7-12 Terrace. Six eligible tables on each floor. */
const floorOf = (n) => (n <= TABLES / 2 ? FLOORS[0] : FLOORS[1]);
/** `users.preferred_zones`, by user id. Nobody else is assigned. */
const AREA_ZONES = { 'fs-u-probe': ['Ground'], 'fs-u-steady': ['Terrace'] };

/**
 * CREATE THE THREE `gf_` TABLES IF THE SNAPSHOT HAS NOT GOT THEM — and it very
 * often has not.
 *
 * MEASURED, 2026-10-03, on the production checkout's own `fnb-controller.db`:
 *
 *     sqlite3 "file:fnb-controller.db?mode=ro" \
 *       "SELECT name FROM sqlite_master WHERE name LIKE 'gf_%';"   →  (nothing)
 *
 * Not "0 rows" — ABSENT. The DDL runs only inside `initializeSchema()` at app
 * boot (`src/lib/db.ts`), and this database had not been booted since the
 * feedback schema shipped. So this fixture, which only DELETEs and INSERTs, died
 * on `SqliteError: no such table: gf_follow_ups` at its first statement and took
 * the whole 526-assertion suite down with it before assertion 1 — on a machine
 * where the standing rule forbids booting a dev server to fix it.
 *
 * The DDL is NOT copied here. `createGuestFeedbackSchema()` in `src/lib/db.ts`
 * is the same function `initializeSchema()` calls, over the same
 * `GF_SCHEMA_SQL` string, so a column added to the shipped schema reaches this
 * fixture automatically and the two can never drift. Every statement in it is
 * `CREATE … IF NOT EXISTS`, so calling it on a database that already has the
 * tables does nothing.
 *
 * The `require` is LAZY and inside the function, so a caller that only wants
 * this module's constants (`DAY`, `DISHES`, `PEOPLE`) does not pay for loading
 * `db.ts`, and so the TypeScript `require.extensions` hook the suites install is
 * guaranteed to be in place by the time it runs.
 */
function ensureGfSchema(db) {
  const path = require('path');
  let mod;
  try {
    mod = require(path.join(__dirname, '..', 'src', 'lib', 'db.ts'));
  } catch (e) {
    throw new Error(
      'feedback-scope-fixture: could not load src/lib/db.ts to create the gf_ tables. '
      + 'The caller must install the TypeScript require hook (see the loader section of '
      + `scripts/feedback-scope-tests.js) before calling build(). Cause: ${e && e.message}`,
    );
  }
  if (typeof mod.createGuestFeedbackSchema !== 'function') {
    throw new Error(
      'feedback-scope-fixture: src/lib/db.ts no longer exports createGuestFeedbackSchema(). '
      + 'The gf_ DDL must stay reachable without booting a server, or this fixture is back to '
      + 'assuming tables that may not exist.',
    );
  }
  mod.createGuestFeedbackSchema(db);
}

/**
 * Seed one world into an open better-sqlite3 handle.
 * @param {import('better-sqlite3').Database} db  a snapshot, opened read-write
 * @param {'A'|'B'} which
 */
function build(db, which) {
  if (which !== 'A' && which !== 'B') throw new Error(`build(): world must be 'A' or 'B', got ${which}`);

  ensureGfSchema(db);

  for (const t of ['gf_follow_ups', 'gf_item_feedback', 'gf_visits']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }

  /* ── roles + users, so grePerformance() can seed the silent role holder ──── */
  const roleId = 'fs-role-gre';
  const mgrRoleId = 'fs-role-mgr';
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  const roleCols = cols('roles');
  const userCols = cols('users');
  const ins = (tbl, have, obj) => {
    const keys = Object.keys(obj).filter((k) => have.includes(k));
    db.prepare(`INSERT OR REPLACE INTO ${tbl} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
      .run(keys.map((k) => obj[k]));
  };
  ins('roles', roleCols, { id: roleId, name: 'GRE', tier: 'staff', is_active: 1, page_access: '[]' });
  ins('roles', roleCols, { id: mgrRoleId, name: 'Manager', tier: 'manager', is_active: 1, page_access: '[]' });
  // The assignment is the POINT (see FLOORS above), so a schema that cannot hold
  // it must stop the run rather than quietly seed everyone unassigned again.
  if (!userCols.includes('preferred_zones')) {
    throw new Error('feedback-scope-fixture: users.preferred_zones is missing - the floor-coverage '
      + 'cells would all print "-" and the area assertions would be vacuous.');
  }
  for (const p of [SUBJECT, STEADY, SILENT]) {
    ins('users', userCols, {
      id: p.id, name: p.name, email: `${p.id}@x.test`, password_hash: 'x',
      role: 'staff', role_id: roleId, is_active: 1,
      preferred_zones: AREA_ZONES[p.id] ? JSON.stringify(AREA_ZONES[p.id]) : null,
      preferred_table_ids: null,
    });
  }
  ins('users', userCols, {
    id: MGR.id, name: MGR.name, email: `${MGR.id}@x.test`, password_hash: 'x',
    role: 'manager', role_id: mgrRoleId, is_active: 1,
    preferred_zones: AREA_ZONES[MGR.id] ? JSON.stringify(AREA_ZONES[MGR.id]) : null,
    preferred_table_ids: null,
  });

  /* ── 12 tables, 12 dine-in orders, all eligible via bill_requested_at ───── */
  const tIns = db.prepare(
    'INSERT OR REPLACE INTO restaurant_tables (id,outlet_id,table_number,zone,section,seats,is_active) VALUES (?,?,?,?,?,4,1)',
  );
  const oIns = db.prepare(
    `INSERT OR REPLACE INTO orders (id,outlet_id,order_number,table_id,status,order_type,covers,
                                    server_name,created_at,bill_requested_at,total)
     VALUES (?,?,?,?,'settled','dine-in',?,?,?,?,1000)`,
  );
  const oiIns = db.prepare(
    `INSERT OR REPLACE INTO order_items (id,order_id,name,station,quantity,unit_price,line_total,status,created_at)
     VALUES (?,?,?,?,?,?,?,'served',?)`,
  );
  for (let i = 1; i <= TABLES; i++) {
    tIns.run(`fs-t-${i}`, '', `T${i}`, floorOf(i), 'A');
    oIns.run(`fs-o-${i}`, '', 9000 + i, `fs-t-${i}`, 4, 'Captain One', TS(dayOf(i), 14, i), TS(dayOf(i), 15, i));
    for (let j = 0; j < LINES_PER_ORDER; j++) {
      oiIns.run(`fs-oi-${i}-${j}`, `fs-o-${i}`, DISHES[(i + j) % DISHES.length], 'kitchen',
        PLATES_PER_LINE, 200, 200 * PLATES_PER_LINE, TS(dayOf(i), 14, i));
    }
  }

  /* ── the three module tables ────────────────────────────────────────────── */
  const vIns = db.prepare(
    `INSERT INTO gf_visits
       (id,outlet_id,order_id,table_id,table_number,floor,covers,captain_name,items_ordered,
        gre_user_id,gre_email,gre_name,gre_role,everything_good,overall_rating,
        cat_food,cat_drinks,cat_service,cat_ambience,comment,status,has_negative,created_at)
     VALUES (@id,'',@order_id,@table_id,@table_number,@floor,4,'Captain One',3,
             @uid,@email,@name,@role,@eg,@rating,@cf,@cd,@cs,@ca,@comment,@status,@neg,@ts)`,
  );
  const iIns = db.prepare(
    `INSERT INTO gf_item_feedback
       (id,visit_id,order_id,order_item_id,menu_item_id,item_name,station,item_group,quantity,
        rating,issue,comment,action_taken,is_negative,created_at)
     VALUES (@id,@visit_id,@order_id,@oiid,'',@item_name,'kitchen',@group,@qty,
             @rating,@issue,@comment,@action,@neg,@ts)`,
  );
  const fIns = db.prepare(
    `INSERT INTO gf_follow_ups
       (id,visit_id,item_feedback_id,order_id,table_id,item_name,action_taken,status,
        revisit_rating,happiness,revisit_comment,revisited_at,closed_at,created_at)
     VALUES (@id,@visit_id,@ifid,@order_id,@table_id,@item_name,@action,@status,
             @rr,@happiness,@rc,@rev,@closed,@ts)`,
  );

  const visit = (n, p, o) => {
    vIns.run({
      id: `fs-v-${n}`, order_id: `fs-o-${n}`, table_id: `fs-t-${n}`, table_number: `T${n}`,
      floor: floorOf(n),
      uid: p.id, email: `${p.id}@x.test`, name: p.name, role: p.role,
      eg: o.eg ? 1 : 0, rating: o.rating || '', cf: o.cf || '', cd: o.cd || '',
      cs: o.cs || '', ca: o.ca || '', comment: o.comment || '',
      status: o.status || 'taken', neg: o.neg ? 1 : 0, ts: TS(dayOf(n), 16, n),
    });
    return { visitId: `fs-v-${n}`, orderId: `fs-o-${n}`, tableId: `fs-t-${n}`, n };
  };
  const item = (v, k, o) => {
    const id = `fs-if-${v.n}-${k}`;
    iIns.run({
      id, visit_id: v.visitId, order_id: v.orderId, oiid: `fs-oi-${v.n}-${k}`, item_name: o.name,
      group: o.group || 'food', qty: o.qty == null ? 1 : o.qty, rating: o.rating || '',
      issue: o.issue || '', comment: o.comment || '', action: o.action || 'none',
      neg: o.neg ? 1 : 0, ts: TS(dayOf(v.n), 16, v.n),
    });
    return id;
  };
  const fu = (v, ifid, k, o) => fIns.run({
    id: `fs-fu-${v.n}-${k}`, visit_id: v.visitId, ifid, order_id: v.orderId, table_id: v.tableId,
    item_name: o.name, action: o.action || '', status: o.status || 'open',
    rr: o.rr || '', happiness: o.happiness || '', rc: o.rc || '',
    rev: o.rev || '', closed: o.closed || '', ts: TS(dayOf(v.n), 17, v.n),
  });

  /* ── THE SUBJECT: the only thing that differs between the two worlds ────── */
  if (which === 'A') {
    const v1 = visit(1, SUBJECT, { rating: 'poor', cf: 'poor', cs: 'average', ca: 'good', neg: 1, status: 'follow_up', comment: 'Biryani cold, naan burnt' });
    const a1 = item(v1, 1, { name: 'Mutton Biryani', issue: 'cold', action: 'returned', neg: 1, rating: 'poor', qty: 2, comment: 'served cold' });
    const a2 = item(v1, 2, { name: 'Butter Naan', issue: 'overcooked', action: 'remade', neg: 1, rating: 'poor', qty: 2, comment: 'burnt edges' });
    fu(v1, a1, 1, { name: 'Mutton Biryani', action: 'returned', status: 'closed', happiness: 'happy', rr: 'good', closed: TS(dayOf(1), 18, 1), rev: TS(dayOf(1), 18, 1), rc: 'happy with the fresh one' });
    fu(v1, a2, 2, { name: 'Butter Naan', action: 'remade', status: 'open' });

    const v2 = visit(2, SUBJECT, { rating: 'average', cs: 'poor', cf: 'average', neg: 1, status: 'issue', comment: 'slow service' });
    const b1 = item(v2, 1, { name: 'Gulab Jamun', issue: 'delay', action: 'replaced_same', neg: 1, rating: 'average', qty: 1 });
    fu(v2, b1, 1, { name: 'Gulab Jamun', action: 'replaced_same', status: 'closed', happiness: 'unhappy', rr: 'still_poor', closed: TS(dayOf(2), 18, 2), rev: TS(dayOf(2), 18, 2), rc: 'still not right' });

    const v3 = visit(3, SUBJECT, { rating: 'average', cf: 'average', neg: 1, status: 'issue' });
    const c1 = item(v3, 1, { name: 'Paneer Tikka', issue: 'too_salty', action: 'cancelled', neg: 1, rating: 'poor', qty: 1, comment: 'far too salty' });
    fu(v3, c1, 1, { name: 'Paneer Tikka', action: 'cancelled', status: 'closed', happiness: 'partial', rr: 'average', closed: TS(dayOf(3), 18, 3), rev: TS(dayOf(3), 18, 3) });

    const v4 = visit(4, SUBJECT, { rating: 'good', cf: 'good', cs: 'good' });
    item(v4, 1, { name: 'Filter Coffee', rating: 'good', group: 'drinks', qty: 1, comment: 'lovely' });
  } else {
    for (const n of [1, 2, 3, 4]) {
      visit(n, SUBJECT, {
        eg: true, rating: 'excellent', cf: 'excellent', cd: 'excellent',
        cs: 'excellent', ca: 'excellent', status: 'taken',
      });
    }
  }

  /* ── THE CONTROL RECORDERS: byte-identical in both worlds ───────────────── */
  // Steady Gre returns 2 plates of Paneer Tikka. The SUBJECT only CANCELLED one,
  // so under &gre=<subject> that dish's return numerator is 0 of HER records -
  // which is exactly the mixed-population bug gate E watches for.
  const v5 = visit(5, STEADY, { rating: 'poor', cf: 'poor', neg: 1, status: 'follow_up', comment: 'two dishes wrong' });
  const s1 = item(v5, 1, { name: 'Paneer Tikka', issue: 'cold', action: 'returned', neg: 1, rating: 'poor', qty: 2, comment: 'cold' });
  const s2 = item(v5, 2, { name: 'Old Monk', issue: 'other', action: 'remade', neg: 1, rating: 'poor', qty: 1, group: 'drinks' });
  fu(v5, s1, 1, { name: 'Paneer Tikka', action: 'returned', status: 'open' });
  fu(v5, s2, 2, { name: 'Old Monk', action: 'remade', status: 'closed', happiness: 'unhappy', closed: TS(dayOf(5), 18, 5), rev: TS(dayOf(5), 18, 5) });

  const v6 = visit(6, STEADY, { rating: 'good', cf: 'good', cs: 'excellent' });
  item(v6, 1, { name: 'Mutton Biryani', rating: 'good', qty: 2, comment: 'very good' });

  visit(7, STEADY, { eg: true, rating: 'excellent', cf: 'excellent', cs: 'excellent' });

  const v8 = visit(8, MGR, { rating: 'average', cs: 'average', neg: 1, status: 'issue' });
  const m1 = item(v8, 1, { name: 'Gulab Jamun', issue: 'presentation', action: 'replaced_other', neg: 1, rating: 'average', qty: 1 });
  fu(v8, m1, 1, { name: 'Gulab Jamun', action: 'replaced_other', status: 'closed', happiness: 'happy', closed: TS(dayOf(8), 18, 8), rev: TS(dayOf(8), 18, 8) });
}

module.exports = {
  build,
  /** Exported so a suite that seeds its own rows (rather than calling `build()`)
   *  can still get the three tables created from the shipped DDL. */
  ensureGfSchema,
  DAY,
  DAY_ONE,
  DAY_TWO,
  DISHES,
  PEOPLE,
  TABLES,
  FLOORS,
  AREA_ZONES,
  /** Eligible tables on EACH floor - half the venue, which is what makes a
   *  floor denominator distinguishable from the venue's. */
  TABLES_PER_FLOOR: TABLES / 2,
  /** 12 orders x 3 lines x 2 plates. */
  PLATES_SOLD: TABLES * LINES_PER_ORDER * PLATES_PER_LINE,
  /** 72 plates over 6 rotating dishes - 12 of each, by construction. */
  PLATES_PER_DISH: (TABLES * LINES_PER_ORDER * PLATES_PER_LINE) / DISHES.length,
};
