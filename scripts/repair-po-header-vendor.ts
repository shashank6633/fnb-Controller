/**
 * REPAIR: purchase_orders.vendor / vendor_id on POs that can no longer be
 * re-derived through the app.
 *
 * ── WHY THIS SCRIPT EXISTS ─────────────────────────────────────────────────
 * e30b705 fixed the DERIVATION (it counts a vendor by identity, not by the
 * literal (name, id) pair, so two spellings of one supplier stopped reading as
 * "Mixed (2 vendors)"). That fix is WRITE-TIME ONLY. The header is re-derived in
 * exactly two places — POST /api/purchase-orders and its PUT — and the PUT
 * refuses anything that is not a draft ("Only drafts can be edited"). The read
 * path hands back the stored column verbatim (`SELECT po.*`), and
 * /purchase-orders/[id]/edit-approved deliberately does NOT re-derive.
 *
 * So a PO that was already approved or received against when the old rule
 * mislabelled it is FROZEN: nothing in the app will ever correct it. This is the
 * only way to repair one.
 *
 * ── IT DOES NOT RE-IMPLEMENT THE RULE ──────────────────────────────────────
 * It calls headerVendorFromLines() from src/lib/vendor-mapping.ts — the exact
 * function deriveHeaderVendor() calls — over the same line set, selected with
 * the same WHERE and the same ORDER BY. A hand-written SQL repair would be a
 * second copy of the identity rule and free to drift from it, which is how the
 * (name, id) bug shipped in the first place.
 *
 * ── IT IS NOT A MIGRATION ──────────────────────────────────────────────────
 * Nothing here runs at boot. It is a manual command, DRY RUN BY DEFAULT: it
 * writes nothing at all unless you pass --apply.
 *
 *   # 1. See what is wrong, change nothing:
 *   npx tsx scripts/repair-po-header-vendor.ts
 *
 *   # 2. Look at one PO in detail (still read-only):
 *   npx tsx scripts/repair-po-header-vendor.ts --po PO-2026-0079
 *
 *   # 3. Repair just that one:
 *   npx tsx scripts/repair-po-header-vendor.ts --po PO-2026-0079 --apply
 *
 *   # 4. Repair every disagreeing PO:
 *   npx tsx scripts/repair-po-header-vendor.ts --apply
 *
 * --db <path> points at a database other than ./fnb-controller.db. TAKE A
 * BACKUP FIRST (npm run backup) — this rewrites rows in place.
 */
import Database from 'better-sqlite3';
import path from 'path';
import { headerVendorFromLines } from '../src/lib/vendor-mapping';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const APPLY = process.argv.includes('--apply');
const ONLY_PO = arg('--po');
const DB_PATH = arg('--db') || path.join(process.cwd(), 'fnb-controller.db');

const db = new Database(DB_PATH);

// The SAME line selection deriveHeaderVendor() uses — same WHERE, same ORDER BY.
const linesOf = db.prepare(`
  SELECT vendor, vendor_id
  FROM purchase_order_items
  WHERE po_id = ? AND vendor IS NOT NULL AND TRIM(vendor) != ''
  ORDER BY rowid
`);

const pos = (ONLY_PO
  ? db.prepare('SELECT id, po_number, status, vendor, vendor_id FROM purchase_orders WHERE po_number = ?').all(ONLY_PO)
  : db.prepare('SELECT id, po_number, status, vendor, vendor_id FROM purchase_orders ORDER BY po_number').all()
) as any[];

if (!pos.length) {
  console.log(ONLY_PO ? `No PO named ${ONLY_PO} in ${DB_PATH}` : `No purchase orders in ${DB_PATH}`);
  process.exit(0);
}

const upd = db.prepare('UPDATE purchase_orders SET vendor = ?, vendor_id = ? WHERE id = ?');
let wrong = 0;
let fixed = 0;

for (const po of pos) {
  const lines = linesOf.all(po.id) as any[];
  const hdr = headerVendorFromLines(db as any, lines);

  // 'none' means no line carries a vendor at all. deriveHeaderVendor() returns
  // early and writes nothing in that case, so neither do we — otherwise this
  // script would blank headers the app deliberately leaves alone.
  if (hdr.kind === 'none') continue;

  const storedVendor = po.vendor === null || po.vendor === undefined ? '' : String(po.vendor);
  const storedId = po.vendor_id === null || po.vendor_id === undefined ? '' : String(po.vendor_id);
  const wantVendor = hdr.vendor === null ? '' : String(hdr.vendor);
  const wantId = hdr.vendor_id === null ? '' : String(hdr.vendor_id);
  if (storedVendor === wantVendor && storedId === wantId) continue;

  wrong++;
  console.log(`\n${po.po_number}  [${po.status}]  ${lines.length} line(s), ${hdr.count} vendor identit${hdr.count === 1 ? 'y' : 'ies'}`);
  console.log(`   stored : vendor=${JSON.stringify(po.vendor)} vendor_id=${JSON.stringify(po.vendor_id)}`);
  console.log(`   derived: vendor=${JSON.stringify(hdr.vendor)} vendor_id=${JSON.stringify(hdr.vendor_id)}`);
  if (hdr.unresolved.length) {
    console.log(`   NOTE: line vendor(s) not in the Vendor master — ${hdr.unresolved.join(', ')}`);
  }
  // The distinct line spellings are the whole diagnosis: LENGTH exposes the
  // trailing NBSP / double space that looks identical on screen.
  for (const [k, n] of countBy(lines)) console.log(`     line vendor ${k} x${n}`);

  if (APPLY) {
    upd.run(hdr.vendor, hdr.vendor_id, po.id);
    fixed++;
  }
}

function countBy(lines: any[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) {
    const k = `${JSON.stringify(String(l.vendor ?? ''))} (len ${String(l.vendor ?? '').length}, id=${JSON.stringify(String(l.vendor_id ?? ''))})`;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

console.log(
  `\n${pos.length} PO(s) examined · ${wrong} disagree with the current rule · `
  + (APPLY ? `${fixed} REWRITTEN.` : '0 written (dry run — pass --apply to repair).'),
);
if (wrong && !APPLY) console.log('Re-run with --apply to write the "derived" values above.');
