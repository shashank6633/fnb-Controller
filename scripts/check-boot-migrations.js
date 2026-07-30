#!/usr/bin/env node
/**
 * BOOT-MIGRATION LOCK — admin decisions must survive a deploy.
 *
 *   node scripts/check-boot-migrations.js     # exits 1 on any violation
 *   npm run check:boot
 *
 * WHY THIS EXISTS
 * ───────────────
 * The migration block in src/lib/db.ts runs on EVERY getDb() cold start, and a
 * deploy restarts the process — so "runs on boot" means "runs on every deploy".
 *
 * That is fine for a schema change (ALTER TABLE ... IF NOT EXISTS) and fine for
 * filling a NULL. It is NOT fine for anything a human has decided. A WHERE
 * clause cannot tell "this role has never been granted the page" from "an admin
 * deliberately revoked it", so a recompute-on-boot silently reverts the admin
 * on the next deploy.
 *
 * That is exactly what happened. Two nav-continuity grants re-added
 * /dine-in/reservations and /crm-calls/guests to every role holding the sibling
 * page, every boot. Reproduced on the live Floor Manager role: revoke the page,
 * restart once, and it is back. From the owner's chair this read as "user roles
 * and page access get disturbed on every deployment".
 *
 * WHAT IT FLAGS
 * ─────────────
 * A write (UPDATE / INSERT OR REPLACE / DELETE) inside the db.ts migration
 * block that targets ADMIN-OWNED state, without a one-shot settings-flag guard
 * in its enclosing try block.
 *
 * HOW TO CLEAR A HIT (in order of preference)
 * ───────────────────────────────────────────
 *  1. MAKE IT ONE-SHOT — the right answer nearly always. Follow the pattern
 *     already used by phase1_master_backfill_v1 and friends:
 *
 *       const done = db.prepare("SELECT value FROM settings WHERE key='my_thing_v1'").get();
 *       if (!done) {
 *         ...the write...
 *         db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('my_thing_v1','1')").run();
 *       }
 *
 *  2. NARROW IT TO A TRUE NULL-FILL. A write whose WHERE only ever touches
 *     IS NULL / = '' is self-limiting and cannot overwrite a decision — an
 *     admin who sets a value takes the row out of scope permanently. Those are
 *     recognised automatically and not flagged.
 *
 *  3. DECLARE IT — only when the write genuinely must re-run every boot:
 *       // boot-migration-lock: <reason>
 *     on the statement or within the 6 lines above it.
 */
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'src', 'lib', 'db.ts');

/**
 * State a human sets and the machine must never recompute. Keyed by the column
 * or table that carries the decision, not by the statement shape.
 */
const ADMIN_OWNED = [
  { re: /\bpage_access\b/,                    what: 'page access (roles/users)' },
  { re: /\bUPDATE\s+roles\b/i,                what: 'roles' },
  { re: /\bUPDATE\s+users\b/i,                what: 'users' },
  { re: /\brole_id\b/,                        what: 'user role assignment' },
  { re: /\bbase_role\b/,                      what: 'role tier' },
  { re: /\bvisible_department_ids\b/,         what: 'department visibility' },
  { re: /\bcan_approve_requisitions\b/,       what: 'approval rights' },
  { re: /\bis_head_chef\b|\bis_store_manager\b/, what: 'role flags' },
  { re: /\bdirect_reviewed\b/,                what: 'human review flag' },
  { re: /\bmaterial_categories\b/,            what: 'department category access' },
  { re: /\bstation\b/,                        what: 'station assignment' },
  { re: /\bDELETE\s+FROM\s+(roles|users)\b/i, what: 'roles/users deletion' },
];

/**
 * Statement OPENERS only. The SET and the WHERE routinely land on later lines —
 * these writes are template literals spanning five or six of them — so matching
 * "UPDATE ... SET" on a single line silently sees nothing. The first draft of
 * this script did exactly that and passed the very bug it was written to catch.
 * Match the opener, then judge the whole statement window.
 */
const WRITE_RE = /\b(UPDATE\s+[a-z_$\{\}]+|INSERT\s+OR\s+REPLACE\s+INTO|DELETE\s+FROM)\b/i;
/** A settings-flag read is what makes a block one-shot. */
const GUARD_RE = /SELECT\s+value\s+FROM\s+settings\s+WHERE\s+key\s*=/i;
/** Self-limiting: only ever fills an empty cell, so a set value is out of scope forever. */
const NULLFILL_RE = /WHERE[\s\S]{0,240}?(IS\s+NULL|=\s*''|=\s*0\b)/i;
const ESCAPE_RE = /boot-migration-lock:/;
/** Writing a migration flag is bookkeeping, never an admin decision. */
const FLAG_WRITE_RE = /INSERT\s+OR\s+REPLACE\s+INTO\s+settings[\s\S]{0,120}?(_v\d|migration_|_backfill|_seeded|fingerprint)/i;

const src = fs.readFileSync(DB_FILE, 'utf8');
const lines = src.split('\n');

/** Enclosing try{...} block for a line, so a guard anywhere in the same migration counts. */
function enclosingBlock(idx) {
  let start = idx;
  for (let i = idx; i >= 0 && idx - i < 400; i--) {
    if (/^\s*try\s*\{/.test(lines[i])) { start = i; break; }
  }
  let depth = 0, end = idx;
  for (let i = start; i < lines.length && i - start < 500; i++) {
    depth += (lines[i].match(/\{/g) || []).length;
    depth -= (lines[i].match(/\}/g) || []).length;
    if (i > start && depth <= 0) { end = i; break; }
  }
  return lines.slice(start, end + 1).join('\n');
}

const violations = [];
const declared = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (/^\s*(\*|\/\/)/.test(line)) continue;      // comment
  if (!WRITE_RE.test(line)) continue;
  if (FLAG_WRITE_RE.test(line)) continue;

  // A statement spans lines: normalise a window so SET/WHERE on later lines are
  // seen as part of the same statement.
  const stmt = lines.slice(i, Math.min(i + 12, lines.length)).join('\n');
  const flat = stmt.replace(/\s+/g, ' ');
  const hit = ADMIN_OWNED.find(a => a.re.test(flat.slice(0, 500)));
  if (!hit) continue;

  const context = lines.slice(Math.max(0, i - 6), i + 1).join('\n');
  if (ESCAPE_RE.test(context) || ESCAPE_RE.test(stmt)) {
    declared.push({ line: i + 1, what: hit.what, code: line.trim().slice(0, 110) });
    continue;
  }
  const block = enclosingBlock(i);
  if (GUARD_RE.test(block)) continue;            // one-shot
  if (NULLFILL_RE.test(flat)) continue;          // self-limiting null-fill

  violations.push({ line: i + 1, what: hit.what, code: line.trim().slice(0, 110) });
}

console.log('\nBoot-migration lock — admin decisions must survive a deploy');
console.log(`scanned src/lib/db.ts (${lines.length} lines)\n`);

if (declared.length) {
  console.log(`Declared exceptions (${declared.length}) — re-run every boot by design:`);
  for (const d of declared) console.log(`  · db.ts:${d.line}  [${d.what}]\n      ${d.code}`);
  console.log('');
}

if (!violations.length) {
  console.log('✓ CLEAN — every boot-time write to admin-owned state is one-shot.\n');
  process.exit(0);
}

console.log(`✗ ${violations.length} violation(s) — these silently revert the admin on the next deploy:\n`);
for (const v of violations) console.log(`  db.ts:${v.line}  [${v.what}]\n      ${v.code}\n`);
console.log(`Make it one-shot with a settings flag (see phase1_master_backfill_v1), narrow it to a
true NULL-fill, or declare it with "// boot-migration-lock: <reason>".\n`);
process.exit(1);
