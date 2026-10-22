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
 *
 * NOT NEEDED TO ROLL BACK TO 6cd5615. That build already reads both names, so
 * rolling the over-issue-clamp release back to it needs no data change at all.
 *
 * THE CLAMP ADVISORY (read-only, printed in both modes). Since the over-issue
 * clamp, the party rail moves NOTHING for a Liquor Store (store-mapped) or
 * unclear-unit line and records the refusal in audit_events
 * ('requisition.party_transfer.declined' / 'requisition.party_consumption.short')
 * instead of a transfer row. A requisition on which EVERY line was refused
 * therefore carries no party row under either name — and any build from before
 * the clamp reads "no party row" as "never transferred", so re-fulfilling one
 * there would debit central for bottles central never held. This script cannot
 * fix that (there is no row to rename); it counts and lists those requisitions
 * so whoever rolls back knows not to re-fulfil them.
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

// THE CLAMP ADVISORY — read-only; see the header. Wrapped so a database from
// before audit_events existed still runs the reverse.
try {
  const declinedOnly = db.prepare(`
    SELECT r.id, COALESCE(r.req_number, '') AS req_number,
           COALESCE(r.event_name, '') AS event_name, COALESCE(r.event_date, '') AS event_date
      FROM requisitions r
     WHERE r.purpose = 'party'
       AND EXISTS (SELECT 1 FROM audit_events ae
                    WHERE ae.entity_id = r.id
                      AND ae.event_type IN ('requisition.party_transfer.declined',
                                            'requisition.party_consumption.short'))
       AND NOT EXISTS (SELECT 1 FROM inventory_transactions it
                        WHERE it.reference_id = r.id
                          AND it.type IN ('party_issue', 'party_consumption'))
     ORDER BY r.event_date, r.req_number
  `).all();
  console.log(`    party reqs with NO transfer row (clamp refused every line) ... ${declinedOnly.length}`);
  for (const r of declinedOnly.slice(0, 50)) {
    console.log(`      · ${r.req_number || r.id}  ${r.event_date}  ${r.event_name}`);
  }
  if (declinedOnly.length > 50) console.log(`      … and ${declinedOnly.length - 50} more`);
  if (declinedOnly.length > 0) {
    console.log('      ADVISORY: a build from before the over-issue clamp reads these as never');
    console.log('      transferred. Do NOT re-fulfil them on such a build — it would debit central');
    console.log('      for Liquor Store / unclear-unit lines central never held. Nothing to rename.');
  }
} catch (e) {
  console.log(`    (clamp advisory skipped: ${e && e.message ? e.message : e})`);
}

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
