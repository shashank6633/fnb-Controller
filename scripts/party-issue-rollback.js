#!/usr/bin/env node
/**
 * THE BOUNDED REVERSE OF THE party_consumption → party_issue RENAME.
 *
 *   node scripts/party-issue-rollback.js <path-to.db>            # DRY RUN, writes nothing
 *   node scripts/party-issue-rollback.js <path-to.db> --apply    # performs the reverse
 *
 * ────────────────────────────────────────────────────────────────────────────
 * RUN THIS ONLY WHEN ROLLING THE CODE BACK PAST 2026-09-17.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * On 2026-09-17 the party requisition's store→department hand-over was renamed
 * inventory_transactions.type 'party_consumption' → 'party_issue', and a boot
 * migration in src/lib/db.ts reclassified the history (1,592 rows in
 * production). The release is safe forward and safe on a restored older backup,
 * because every predicate in the new code matches BOTH names permanently.
 *
 * It has exactly ONE unsafe direction: rolling the CODE back while leaving the
 * DATABASE migrated. The old build's idempotency guard matches only
 * 'party_consumption', so every already-fulfilled party requisition reads as
 * never-transferred:
 *
 *   · the store rail (applyPartyFulfillment) deducts central a SECOND time;
 *   · the PO-receive cascade (fulfilRequisitionFromPo) does the same, independently;
 *   · the PO void finds ZERO rows to credit back, so it un-fulfils the
 *     requisition while LEAVING the deduction standing — and the next
 *     re-receive then deducts again.
 *
 * PREFERRED FIX: roll the DATABASE back alongside the code (restore the backup
 * taken before the deploy). Use this script when that is not possible — when
 * real trading has happened since the deploy and the newer data must be kept.
 *
 * WHY IT IS BOUNDED, AND WHY A BARE REVERSE IS WRONG
 * ──────────────────────────────────────────────────
 * 'party_issue' is NOT a name this rename invented. The Party Items rail
 * (src/app/api/parties/items) has written 'party_issue' natively since long
 * before, against a party_items id — those rows were NEVER 'party_consumption'
 * and renaming them backwards would invent history and, worse, hide them from
 * the very reports that read the modern name. So the reverse is bounded by
 *
 *     reference_id IN (SELECT id FROM requisitions)
 *
 * which is precisely the set the migration moved. This script prints the
 * conserved (untouched) count so the boundary is visible, not assumed.
 *
 * THE TRIGGER STAYS. trg_party_transfer_no_double_deduct blocks inserting a
 * party row for a reference that already carries one under the OTHER name — it
 * is the backstop that makes an un-reversed rollback fail loud instead of
 * silently double-deducting. After a clean reverse it can never fire (only one
 * name is left on any requisition), so leave it in place; it is also harmless
 * to an older build, which knows nothing about it.
 */
'use strict';

const path = require('path');
const fs = require('fs');

function die(msg) { console.error(`\n  ERROR: ${msg}\n`); process.exit(1); }

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dbArg = args.find(a => !a.startsWith('--'));

if (!dbArg) {
  die('usage: node scripts/party-issue-rollback.js <path-to.db> [--apply]\n' +
      '         (no default path on purpose — name the database you mean)');
}
const dbPath = path.resolve(dbArg);
if (!fs.existsSync(dbPath)) die(`no such database: ${dbPath}`);

let Database;
try {
  Database = require('better-sqlite3');
} catch {
  die('better-sqlite3 is not installed here — run this from the app directory');
}

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const q = (sql, ...p) => db.prepare(sql).get(...p);

const before = {
  legacy: q(`SELECT COUNT(*) c FROM inventory_transactions WHERE type = 'party_consumption'`).c,
  modern: q(`SELECT COUNT(*) c FROM inventory_transactions WHERE type = 'party_issue'`).c,
  inScope: q(`SELECT COUNT(*) c FROM inventory_transactions
              WHERE type = 'party_issue'
                AND reference_id IN (SELECT id FROM requisitions)`).c,
  nativeRail: q(`SELECT COUNT(*) c FROM inventory_transactions
                 WHERE type = 'party_issue'
                   AND (reference_id IS NULL
                        OR reference_id NOT IN (SELECT id FROM requisitions))`).c,
  total: q(`SELECT COUNT(*) c FROM inventory_transactions`).c,
};

console.log(`\n  database : ${dbPath}`);
console.log(`  mode     : ${apply ? 'APPLY (writes)' : 'DRY RUN (writes nothing)'}\n`);
console.log('  BEFORE');
console.log(`    inventory_transactions rows, total ........ ${before.total}`);
console.log(`    type='party_consumption' (legacy name) .... ${before.legacy}`);
console.log(`    type='party_issue' ....................... ${before.modern}`);
console.log(`      · on a requisition  → IN SCOPE ......... ${before.inScope}`);
console.log(`      · Party Items rail  → CONSERVED ........ ${before.nativeRail}`);

if (before.inScope === 0) {
  console.log('\n  Nothing to reverse: no party_issue row references a requisition.');
  console.log('  (Either the migration never ran here, or the reverse has already been applied.)\n');
  db.close();
  process.exit(0);
}

if (!apply) {
  console.log(`\n  DRY RUN — would rename ${before.inScope} row(s) back to 'party_consumption'`);
  console.log(`            and leave ${before.nativeRail} Party Items row(s) untouched.`);
  console.log('  Re-run with --apply to perform it.\n');
  db.close();
  process.exit(0);
}

const changed = db.transaction(() => db.prepare(`
  UPDATE inventory_transactions
     SET type = 'party_consumption'
   WHERE type = 'party_issue'
     AND reference_id IN (SELECT id FROM requisitions)
`).run().changes).immediate();

const after = {
  legacy: q(`SELECT COUNT(*) c FROM inventory_transactions WHERE type = 'party_consumption'`).c,
  modern: q(`SELECT COUNT(*) c FROM inventory_transactions WHERE type = 'party_issue'`).c,
  total: q(`SELECT COUNT(*) c FROM inventory_transactions`).c,
};

console.log('\n  AFTER');
console.log(`    rows renamed ............................. ${changed}`);
console.log(`    type='party_consumption' ................. ${after.legacy}`);
console.log(`    type='party_issue' (Party Items rail) .... ${after.modern}`);
console.log(`    inventory_transactions rows, total ....... ${after.total}`);

const ok =
  changed === before.inScope &&
  after.legacy === before.legacy + before.inScope &&
  after.modern === before.nativeRail &&
  after.total === before.total;

console.log(`\n  CONSERVATION CHECK: ${ok ? 'PASS — nothing created, nothing destroyed' : 'FAIL — investigate before proceeding'}`);
console.log('\n  NEXT: the boot migration in src/lib/db.ts is convergent and flagless, so');
console.log('        booting the NEW code again re-applies the rename automatically.');
console.log('        Deploy the OLD build before any further restart.\n');

db.close();
process.exit(ok ? 0 : 1);
