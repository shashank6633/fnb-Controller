/**
 * STALE LINE UNIT — owner ruling 128, "Block it + stop new ones" — THE PROOF.
 *
 *   npx tsx scripts/unit-guard-tests.ts <dir holding a COPY of fnb-controller.db> [--base-tree <tree>|HEAD]
 *
 * RUNS ON A HARNESS COPY ONLY: <dir> must sit under a `harness/` directory and
 * must not be this worktree. The script chdirs there BEFORE db.ts loads, so
 * getDb() and every real route handler below open the copy and nothing else.
 * It SEEDS that copy (users, sessions, materials, a vendor and requisitions
 * whose ids all start "ug-"). The copy's purchases.invoice_number is dropped
 * first when present (production lacks it — schema-drift rule).
 *
 * WHAT A STALE LINE IS: issue-stock.ts lineFactor(line unit, material).needsReview
 * — a packed material (pack factor > 1) and a line unit that is blank or is
 * neither the material's purchase unit nor its recipe unit (a 'PKT' line on
 * YELLOW CHEDDAR, now g / bought in kg ×1000).
 *
 * SECTIONS
 *   Z  BASELINE — normal lines only, run identically on the base tree and on the
 *      patched tree: real-data reports before any seeding (sha256), then a
 *      seeded scenario through the REAL handlers — store-issue (partial, defer,
 *      batch, undo, reject, unreject, complete, undo on fulfilled, over-issue
 *      with a note), store-process (plain and with the vendor-PO tick),
 *      POST / PUT / submit / line-edit — each recorded as HTTP code + response +
 *      every row written + stock deltas, then the reports for those items.
 *      With --base-tree the base's record is compared with this run's, label by
 *      label: every normal-line result must be identical.
 *   S  STORE DESK WRITER (store-issue): an issue on a stale line alone is refused
 *      400 'unit_review' with the owner's sentence and NOTHING written (blank-unit
 *      form too). A stale entry BESIDE normal ones (a mixed gesture, an old
 *      desk's Issue All) passes under either of two designs, each checked
 *      strictly: REFUSE WHOLE (the plan: 400, nothing written) or HELD (200, the
 *      stale line named with the sentence and nothing written for it, every
 *      other line written exactly as on a twin requisition without it); the run
 *      says which design the tree uses. Defer / reject / unreject are still
 *      accepted and move nothing; the new desk's Issue All (stale lines left
 *      out) issues the rest exactly as a twin; Reject then closes the
 *      requisition. A party requisition: the stale line refused, the rest
 *      transferred, the stale material never moves.
 *   M  MANAGEMENT DESK WRITER (store-process): a figure, or a Buy without the
 *      tick, on a stale line beside a normal one — the same two designs, checked
 *      the same way (never a PO, never a write on the stale line); the
 *      vendor-PO tick while one is owed → 409 'unit_review_open' and an
 *      all-stale submit → 400 'unit_review', nothing written; the modal's own
 *      POST (stale line at 0) processes the rest exactly as a twin, the stale
 *      line left exactly as found (no row, no stock).
 *   F  FORMS: POST / PUT refuse a stale unit (nothing saved, no requisition
 *      number used, the edited requisition exactly as it was) and accept the
 *      item's current units; PUT never carries a stale or blank stored unit
 *      forward; SUBMIT refuses a draft holding a stale line; the chef's
 *      line-edit refuses an approved figure on a stale line and keeps Reject.
 *   R  REPORTS: REQ-1669 reproduced (2,640 recorded on a PKT line, nothing
 *      moved) — the Issue Log prints no "ISSUE (pre-ledger)" row for it, and
 *      Department Consumption (rail 1 + register) and the Issued Items Log are
 *      byte-identical to before the hand-over (also after a store-reject). The
 *      skeptic's window case (phantom → item re-set so PKT is valid → undo →
 *      a real 3 PKT issue) counts exactly the real 3 PKT everywhere.
 *   On the BASE tree the S/M/F/R fixtures run too, asserting the OLD behaviour
 *   ("BEFORE" checks: the issue closes the line silently, the pre-ledger row and
 *   the phantom ₹ are there) — proof that these tests tell the two apart.
 *
 * --base-tree <tree>  A source tree of production (a5cd696) with node_modules.
 * --base-tree HEAD    Extract this worktree's HEAD (git archive) into <dir>,
 *                     with node_modules linked. In both cases the script makes
 *                     two fresh copies of <dir>/fnb-controller.db, runs itself
 *                     on the first under the base tree (--baseline-only), then
 *                     runs the full contract on the second and compares Z.
 * Internal: --baseline-only (base mode), --emit <file> (write the record),
 *           --baseline-file <file> (compare Z against an earlier base record).
 *
 * Exits 1 when any check fails (every check is counted; failures are listed).
 */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const Module = require('module');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const nodeCrypto = require('crypto');

delete process.env.ENABLE_SCHEDULER;

const ARGV: string[] = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--emit', '--baseline-file', '--base-tree']);
const flagOn = (name: string) => ARGV.includes(name);
const optOf = (name: string): string | undefined => { const i = ARGV.indexOf(name); return i >= 0 ? ARGV[i + 1] : undefined; };
const POSITIONAL = ARGV.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.has(ARGV[i - 1])));
const MODE: 'base' | 'patched' = flagOn('--baseline-only') ? 'base' : 'patched';
const SCRIPT = path.resolve(__filename);
const WT = process.env.UG_TREE ? path.resolve(process.env.UG_TREE) : path.resolve(__dirname, '..');
const SELF_WT = path.resolve(__dirname, '..');

let dir = path.resolve(String(POSITIONAL[0] || ''));
if (!POSITIONAL[0] || !fs.existsSync(path.join(dir, 'fnb-controller.db'))) {
  console.error('usage: npx tsx scripts/unit-guard-tests.ts <dir holding a COPY of fnb-controller.db> [--base-tree <tree>|HEAD]');
  process.exit(2);
}
const refuseDir = (d: string) => {
  if (!d.split(path.sep).includes('harness') || d === SELF_WT || d.startsWith(SELF_WT + path.sep) || d === WT || d.startsWith(WT + path.sep)) {
    console.error(`refusing: ${d} is not a harness copy (it must sit under a harness/ directory, never a source tree).`);
    process.exit(2);
  }
};
refuseDir(dir);

/** Drop purchases.invoice_number on a COPY when present (production lacks it). */
function prepCopy(dbFile: string) {
  const Better = require(path.join(WT, 'node_modules', 'better-sqlite3'));
  const h = new Better(dbFile);
  try {
    const cols = (h.prepare(`SELECT name FROM pragma_table_info('purchases')`).all() as any[]).map(c => c.name);
    if (cols.includes('invoice_number')) {
      h.exec('ALTER TABLE purchases DROP COLUMN invoice_number');
      console.log(`  (dropped purchases.invoice_number on ${dbFile} — production has no such column)`);
    }
  } finally { h.close(); }
}

/* ── --base-tree: two copies, the base run first (child process) ───────────── */
let BASE_OBS: Record<string, any> | null = null;
let BASE_SUMMARY: any = null;
if (optOf('--baseline-file')) {
  const f = JSON.parse(fs.readFileSync(path.resolve(String(optOf('--baseline-file'))), 'utf8'));
  BASE_OBS = f.observations || null; BASE_SUMMARY = f.summary || null;
}
if (MODE === 'patched' && optOf('--base-tree')) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + process.pid;
  let B = String(optOf('--base-tree'));
  if (B === 'HEAD') {
    B = path.join(dir, `ug-base-tree-${stamp}`);
    fs.mkdirSync(B);
    const tarFile = path.join(dir, `ug-base-tree-${stamp}.tar`);
    cp.execFileSync('git', ['-C', SELF_WT, 'archive', '--format=tar', '-o', tarFile, 'HEAD'], { stdio: 'inherit' });
    cp.execFileSync('tar', ['-x', '-f', tarFile, '-C', B], { stdio: 'inherit' });
    fs.symlinkSync(path.join(SELF_WT, 'node_modules'), path.join(B, 'node_modules'));
    const head = cp.execFileSync('git', ['-C', SELF_WT, 'rev-parse', '--short', 'HEAD']).toString().trim();
    console.log(`base tree: ${B} (git archive of HEAD ${head})`);
  }
  B = path.resolve(B);
  if (!fs.existsSync(path.join(B, 'src/app/api/requisitions/[id]/store-issue/route.ts'))) {
    console.error(`refusing: ${B} is not a source tree of this app.`); process.exit(2);
  }
  const baseDir = path.join(dir, `ug-base-${stamp}`);
  const patDir = path.join(dir, `ug-patched-${stamp}`);
  for (const d of [baseDir, patDir]) {
    fs.mkdirSync(d);
    cp.execFileSync('sqlite3', [path.join(dir, 'fnb-controller.db'), `.backup '${path.join(d, 'fnb-controller.db')}'`]);
    prepCopy(path.join(d, 'fnb-controller.db'));
  }
  const emit = path.join(baseDir, 'unit-guard-base-observations.json');
  console.log(`\n══ BASE RUN (tree ${B}) on ${baseDir} ══`);
  const env = { ...process.env, UG_TREE: B, NEXT_TELEMETRY_DISABLED: '1' };
  delete (env as any).ENABLE_SCHEDULER;
  const run = cp.spawnSync('npx', ['tsx', SCRIPT, baseDir, '--baseline-only', '--emit', emit], { cwd: B, env, stdio: 'inherit' });
  if (!fs.existsSync(emit)) { console.error(`the base run wrote no record (exit ${run.status}).`); process.exit(2); }
  const f = JSON.parse(fs.readFileSync(emit, 'utf8'));
  BASE_OBS = f.observations; BASE_SUMMARY = f.summary;
  console.log(`\n══ PATCHED RUN (tree ${WT}) on ${patDir} ══`);
  dir = patDir;
} else {
  prepCopy(path.join(dir, 'fnb-controller.db'));
}

/* ── next/headers stub, then chdir BEFORE the app's db module loads ────────── */
const STUB = path.join(dir, 'next-headers-stub.cjs');
fs.writeFileSync(STUB, `
function jar() { const t = globalThis.__TOKEN; return {
  get: (n) => (n === 'fnb_session' && t ? { name: n, value: t } : undefined),
  getAll: () => (t ? [{ name: 'fnb_session', value: t }] : []), has: (n) => n === 'fnb_session' && !!t, set() {}, delete() {} }; }
exports.cookies = async () => jar();
exports.headers = async () => new Headers({ 'x-forwarded-for': '127.0.0.1' });
exports.draftMode = async () => ({ isEnabled: false });
`);
const prevResolve = Module._resolveFilename;
Module._resolveFilename = function (req: string, ...rest: unknown[]) {
  if (req === 'next/headers') return STUB;
  return prevResolve.call(this, req, ...rest);
};
process.chdir(dir);

/* ── checks ────────────────────────────────────────────────────────────────── */
let pass = 0;
const fails: string[] = [];
const notes: string[] = [];
const short = (v: unknown) => { const s = JSON.stringify(v); return s && s.length > 600 ? s.slice(0, 600) + '…' : s; };
function ok(cond: unknown, what: string, detail?: unknown) {
  if (cond) { pass++; return; }
  const line = `${what}${detail !== undefined ? ` — ${short(detail)}` : ''}`;
  fails.push(line);
  console.log(`  FAIL ${line}`);
}
const eq = (a: unknown, b: unknown, what: string) => ok(JSON.stringify(a) === JSON.stringify(b), what, { got: a, want: b });
const has = (text: unknown, frag: string, what: string) => ok(String(text ?? '').includes(frag), what, { text, want: frag });
const near = (a: unknown, b: number, eps = 1e-6) => Math.abs((Number(a) || 0) - b) <= eps;
const note = (s: string) => { notes.push(s); console.log(`  NOTE ${s}`); };

/* ── normalisation for cross-tree comparison ───────────────────────────────── */
const TS_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/g;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX32_RE = /\b[0-9a-f]{32}\b/g;
let TODAYS: string[] = [];
function norm(v: any): any {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 1e9) / 1e9 : String(v);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t.startsWith('[') || t.startsWith('{')) { try { return { __json: norm(JSON.parse(t)) }; } catch { /* plain text */ } }
    const s = v.replace(TS_RE, '<ts>').replace(UUID_RE, '<id>').replace(HEX32_RE, '<id>');
    return TODAYS.includes(s) ? '<today>' : s;
  }
  if (Array.isArray(v)) return v.map(norm);
  if (typeof v === 'object') {
    const o: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) o[k] = norm(v[k]);
    return o;
  }
  return String(v);
}
function firstDiff(a: any, b: any, p = '$'): string | null {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    const keys = Array.isArray(a) ? Array.from({ length: Math.max(a.length, b.length) }, (_, i) => String(i))
      : [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const k of keys) { const d = firstDiff((a as any)[k], (b as any)[k], `${p}.${k}`); if (d) return d; }
  }
  return `${p}: patched ${short(a)} / base ${short(b)}`;
}
const sha = (s: string) => nodeCrypto.createHash('sha256').update(s).digest('hex');
/** norm(), then every array of objects sorted by its JSON: a report's row SET, not its order — rows written
 *  in the same second tie on their timestamp, and the tie's order differs from run to run. */
function canonSet(v: any): any {
  const walk = (x: any): any => {
    if (Array.isArray(x)) {
      const a = x.map(walk);
      return a.every(e => e && typeof e === 'object') ? a.sort((p, q) => (JSON.stringify(p) < JSON.stringify(q) ? -1 : 1)) : a;
    }
    if (x && typeof x === 'object') { const o: Record<string, any> = {}; for (const k of Object.keys(x)) o[k] = walk(x[k]); return o; }
    return x;
  };
  return walk(norm(v));
}

const OBS: Record<string, any> = {};
/** A baseline observation: recorded, and (patched run with a base record) compared. */
function obs(label: string, value: any) {
  const v = norm(value);
  OBS[label] = v;
  if (MODE === 'patched' && BASE_OBS) {
    if (!(label in BASE_OBS)) { ok(false, `BASELINE ${label}: the base run did not record it`); return; }
    const d = firstDiff(v, BASE_OBS[label]);
    ok(d === null, `BASELINE identical to production: ${label}`, d ?? undefined);
  }
}

(async () => {
  const R = (rel: string) => require(path.join(WT, rel));
  const { getDb } = R('src/lib/db.ts');
  const IS = R('src/lib/issue-stock.ts');
  const { todayIST } = R('src/lib/format-date.ts');
  const routes = {
    storeIssue: R('src/app/api/requisitions/[id]/store-issue/route.ts'),
    storeProcess: R('src/app/api/requisitions/[id]/store-process/route.ts'),
    reqs: R('src/app/api/requisitions/route.ts'),
    submit: R('src/app/api/requisitions/[id]/submit/route.ts'),
    lineEdit: R('src/app/api/requisitions/[id]/items/[itemId]/route.ts'),
    issueLog: R('src/app/api/reports/issue-log/route.ts'),
    deptCons: R('src/app/api/department-consumption/route.ts'),
    issuedLog: R('src/app/api/store-issued-log/route.ts'),
    reqRecon: fs.existsSync(path.join(WT, 'src/app/api/reports/requested-vs-received/route.ts'))
      ? R('src/app/api/reports/requested-vs-received/route.ts') : null,
  };
  // The owner's words and the client predicate exist only on the patched tree.
  const SL = MODE === 'patched' ? R('src/lib/stale-line-unit.ts') : null;
  const db = getDb();
  if (path.resolve(db.name) !== path.join(dir, 'fnb-controller.db')) {
    console.error(`refusing: getDb() opened ${db.name}, not the copy.`); process.exit(2);
  }
  const TODAY = todayIST();
  TODAYS = [TODAY, new Date().toISOString().slice(0, 10)];
  console.log(`unit-guard (${MODE}) — tree ${WT}\n  copy ${dir}`);

  const one = (sql: string, ...a: unknown[]) => db.prepare(sql).get(...a) as any;
  const all = (sql: string, ...a: unknown[]) => db.prepare(sql).all(...a) as any[];
  const as = (u: { tok: string } | null) => { (globalThis as any).__TOKEN = u ? u.tok : null; };
  const call = async (mod: any, method: string, url: string, body?: unknown, params?: Record<string, string>) => {
    const init: any = { method, headers: { 'content-type': 'application/json' } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res: Response = await mod[method](new Request(`http://t${url}`, init), params ? { params: Promise.resolve(params) } : undefined);
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* csv / text */ }
    return { status: res.status, body: json ?? text, text };
  };
  const issue = (rid: string, lines: any[], extra: Record<string, unknown> = {}) =>
    call(routes.storeIssue, 'POST', `/api/requisitions/${rid}/store-issue`, { lines, ...extra }, { id: rid });
  const processReq = (rid: string, body: any) =>
    call(routes.storeProcess, 'POST', `/api/requisitions/${rid}/store-process`, body, { id: rid });
  const postReq = (body: any) => call(routes.reqs, 'POST', '/api/requisitions', body);
  const putReq = (body: any) => call(routes.reqs, 'PUT', '/api/requisitions', body);
  const submit = (rid: string, body: any = {}) => call(routes.submit, 'POST', `/api/requisitions/${rid}/submit`, body, { id: rid });
  const editLine = (rid: string, itemId: string, body: any) =>
    call(routes.lineEdit, 'PUT', `/api/requisitions/${rid}/items/${itemId}`, body, { id: rid, itemId });

  const WIDE = 'from=2020-01-01&to=2099-12-31';
  const issueLog = async (q: string) => { as(ADMIN); return call(routes.issueLog, 'GET', `/api/reports/issue-log?${q}`); };
  const deptCons = async (q: string) => { as(ADMIN); return call(routes.deptCons, 'GET', `/api/department-consumption?${q}`); };
  const issuedLog = async (q: string) => { as(STORE); return call(routes.issuedLog, 'GET', `/api/store-issued-log?${q}`); };

  /* ══════════ Z0 — REAL DATA, before any seeding ══════════ */
  console.log('Z0 real data before seeding (reports)');
  const nurRows = Number(one(`SELECT COUNT(*) AS n FROM requisition_issue_ledger WHERE COALESCE(needs_unit_review,0) = 1`).n) || 0;
  note(`this copy holds ${nurRows} ledger row(s) flagged needs_unit_review before seeding (0 → every report must be byte-identical to production)`);
  // Users first (sessions are not report data), so the gated reports can be read.
  const mkUser = (key: string, role: string, f: { hod?: number; store?: number; dept?: string | null } = {}) => {
    const id = `ug-u-${key}`;
    const email = `${key}@ug.test`;
    db.prepare(`INSERT INTO users (id, email, password_hash, name, role, is_active, is_head_chef, is_store_manager, can_approve_requisitions, page_access, department_id)
                VALUES (?, ?, 'x', ?, ?, 1, ?, ?, 0, NULL, ?)`).run(id, email, `UG ${key}`, role, f.hod || 0, f.store || 0, f.dept ?? null);
    const tok = `ug-tok-${key}`;
    db.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, '2099-01-01 00:00:00')`).run(tok, id);
    return { id, email, tok };
  };
  const D = (one(`SELECT id, name FROM departments WHERE LOWER(TRIM(name)) = 'continental' ORDER BY id LIMIT 1`)
    || one(`SELECT id, name FROM departments ORDER BY name, id LIMIT 1`)) as { id: string; name: string };
  if (!D) { console.error('the copy has no department'); process.exit(2); }
  const ADMIN = mkUser('admin', 'admin');
  const STORE = mkUser('store', 'manager', { store: 1 });
  const HOD = mkUser('hod', 'staff', { hod: 1, dept: D.id });
  {
    const realMonth = '2026-01-01', realEnd = '2026-12-31';
    const il = await issueLog(`from=${realMonth}&to=${realEnd}`);
    const ilCsv = await issueLog(`from=${realMonth}&to=${realEnd}&format=csv`);
    const dc = await deptCons(`from=${realMonth}&to=${realEnd}`);
    const dcr = await deptCons(`from=${realMonth}&to=${realEnd}&view=register`);
    const sil = await issuedLog(`from=${realMonth}&to=${realEnd}`);
    const digest = (r: any) => ({ status: r.status, sha: sha(r.text), bytes: r.text.length });
    obs('Z0 issue-log json 2026 (real data)', { ...digest(il), rows: il.body?.rows?.length ?? null, totals: il.body?.totals ?? null });
    obs('Z0 issue-log csv 2026 (real data)', digest(ilCsv));
    obs('Z0 department-consumption 2026 (real data)', { ...digest(dc), summary: dc.body?.summary ?? null });
    obs('Z0 department-consumption register 2026 (real data)', { ...digest(dcr), totals: dcr.body?.totals ?? null });
    obs('Z0 store-issued-log 2026 (real data)', { ...digest(sil), totals: sil.body?.totals ?? null });
    if (routes.reqRecon) {
      as(ADMIN);
      const rr = await call(routes.reqRecon, 'GET', `/api/reports/requested-vs-received?from=2026-10-01&to=2026-10-31&dept=all`);
      obs('Z0 requested-vs-received Oct 2026 (real data)', digest(rr));
    }
    ok(il.status === 200 && dc.status === 200 && dcr.status === 200 && sil.status === 200, 'Z0: the four reports answer 200 on the real data',
      [il.status, dc.status, dcr.status, sil.status]);
  }

  /* ══════════ fixtures (ids start "ug-"; identical on every tree) ══════════ */
  const CAT = 'zz-ug-test';
  const mat = (key: string, name: string, unit: string, pu: string, pack: number, stock: number, avg: number) => {
    const id = `ug-m-${key}`;
    db.prepare(`INSERT INTO raw_materials (id, name, category, unit, purchase_unit, pack_size, average_price, current_stock, sku, is_active)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(id, name, CAT, unit, pu, pack, avg, stock, `UG-${key.toUpperCase()}`);
    return { id, name, unit, purchase_unit: pu, pack_size: pack };
  };
  const CHED = mat('ched', 'UG YELLOW CHEDDAR BLOCK', 'g', 'kg', 1000, 100000, 0.5);
  const CHED2 = mat('ched2', 'UG CHEDDAR REQ1669', 'g', 'kg', 1000, 2640, 0.5);
  const BUTTER = mat('butter', 'UG SALTED BUTTER', 'g', 'kg', 1000, 40000, 0.6);
  const OIL = mat('oil', 'UG OLIVE OIL', 'ml', 'L', 1000, 60000, 0.4);
  const ONION = mat('onion', 'UG ONION', 'kg', 'kg', 1, 200, 30);
  const EGGS = mat('eggs', 'UG EGGS', 'pcs', 'pcs', 30, 1000, 6);
  const SALT = mat('salt', 'UG SALT', 'g', 'kg', 1000, 50000, 0.02);
  const SALT2 = mat('salt2', 'UG ROCK SALT', 'g', 'kg', 1000, 50000, 0.02);
  const CREAM = mat('cream', 'UG FRESH CREAM', 'ml', 'L', 1000, 30000, 0.3);
  db.prepare(`INSERT INTO vendors (id, name, is_active) VALUES ('ug-v-1', 'UG Vendor', 1)`).run();
  for (const m of [ONION, CHED]) {
    db.prepare(`INSERT INTO vendor_materials (vendor_id, material_id, notes, created_by) VALUES ('ug-v-1', ?, 'ug test', 'ug-test')`).run(m.id);
  }
  const stockOf = (m: { id: string }) => Number(one(`SELECT current_stock FROM raw_materials WHERE id = ?`, m.id).current_stock) || 0;
  type L = { key: string; m: { id: string }; q: number; unit: string; rej?: number; srej?: number; approved?: number };
  const mkReq = (key: string, status: string, lines: L[], o: { purpose?: string; event?: string; fp?: string; drafted?: string } = {}) => {
    const rid = `ug-r-${key}`;
    const number = `UG-REQ-${key.toUpperCase()}`;
    db.prepare(`INSERT INTO requisitions (id, req_number, department_id, date, status, purpose, event_name, event_date, fp_id, drafted_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(rid, number, D.id, TODAY, status, o.purpose || 'internal', o.event || '', o.event ? TODAY : null, o.fp || null, o.drafted || ADMIN.email);
    const ids: Record<string, string> = {};
    for (const l of lines) {
      const lid = `ug-ri-${key}-${l.key}`;
      db.prepare(`INSERT INTO requisition_items (id, req_id, material_id, quantity_requested, unit, department_id, is_rejected, store_rejected, chef_approved_qty)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(lid, rid, l.m.id, l.q, l.unit, D.id, l.rej || 0, l.srej || 0, l.approved ?? null);
      ids[l.key] = lid;
    }
    return { rid, number, ids };
  };
  const line = (lid: string) => one(`SELECT * FROM requisition_items WHERE id = ?`, lid);
  const reqRow = (rid: string) => one(`SELECT * FROM requisitions WHERE id = ?`, rid);
  const ledgerOf = (lid: string) => all(`SELECT * FROM requisition_issue_ledger WHERE req_item_id = ? ORDER BY rowid`, lid);
  const TABLES = ['requisitions', 'requisition_items', 'requisition_issue_ledger', 'inventory_transactions',
    'department_material_transactions', 'audit_events', 'purchase_orders', 'purchase_order_items'];
  /** Every table a hand-over or a save can touch: row count + last rowid, and every ug- material's stock. */
  const world = () => {
    const o: Record<string, any> = {};
    for (const t of TABLES) o[t] = one(`SELECT COUNT(*) AS n, COALESCE(MAX(rowid), 0) AS m FROM ${t}`);
    o.stock = all(`SELECT id, current_stock FROM raw_materials WHERE id LIKE 'ug-m-%' ORDER BY id`);
    return o;
  };
  // Lines in material order: a PUT re-inserts them under fresh random ids, so id order differs run to run.
  const reqState = (rid: string) => ({ r: reqRow(rid), items: all(`SELECT * FROM requisition_items WHERE req_id = ? ORDER BY material_id, id`, rid) });
  const since = (t: string, w0: any, cols = '*', order = 'rowid') => all(`SELECT ${cols} FROM ${t} WHERE rowid > ? ORDER BY ${order}`, w0[t].m);
  const stockDelta = (w0: any) => {
    const now = new Map(all(`SELECT id, current_stock FROM raw_materials WHERE id LIKE 'ug-m-%'`).map((x: any) => [x.id, Number(x.current_stock) || 0]));
    const out: Record<string, number> = {};
    for (const s of w0.stock) { const d = (now.get(s.id) || 0) - (Number(s.current_stock) || 0); if (Math.abs(d) > 1e-12) out[s.id] = Math.round(d * 1e9) / 1e9; }
    return out;
  };
  /** Everything a gesture wrote, for a cross-tree record. */
  const effects = (w0: any, reqIds: string[]) => ({
    stock: stockDelta(w0),
    reqs: reqIds.map(reqState),
    new_requisitions: since('requisitions', w0),
    new_ledger: since('requisition_issue_ledger', w0),
    new_inventory: since('inventory_transactions', w0),
    new_dept: since('department_material_transactions', w0),
    new_audit: since('audit_events', w0, 'event_type, entity_type, entity_id, actor_email, before_json, after_json, note'),
    new_po: since('purchase_orders', w0),
    new_po_items: since('purchase_order_items', w0),
  });
  /** The part of a gesture's writes that two requisitions must share line for line (ids and the req left out). */
  const lineEffects = (w0: any) => ({
    stock: stockDelta(w0),
    ledger: since('requisition_issue_ledger', w0, `material_id, department_id, reason, before_line_qty, after_line_qty, delta_line_qty, line_unit,
      pack_factor, delta_recipe_qty, recorded_recipe_qty, stock_applied, skip_reason, needs_unit_review, store_mapped, effective_line_qty`, 'material_id, rowid'),
    inventory: since('inventory_transactions', w0, 'material_id, type, quantity', 'material_id, rowid'),
    dept: since('department_material_transactions', w0, 'material_id, department_id, type, quantity', 'material_id, rowid'),
  });
  const gesture = async (label: string, reqIds: string[], fn: () => Promise<{ status: number; body: any }>) => {
    const w0 = world();
    const res = await fn();
    obs(label, { status: res.status, body: res.body, ...effects(w0, reqIds) });
    return res;
  };
  /** NOTHING written: every table's count and last rowid, every ug- stock, and the requisitions named, unchanged. */
  const nothingWritten = async (what: string, reqIds: string[], fn: () => Promise<{ status: number; body: any }>) => {
    const w0 = world(); const r0 = reqIds.map(reqState);
    const res = await fn();
    eq(world(), w0, `${what}: nothing written (no row in any table, no stock moved)`);
    eq(reqIds.map(reqState), r0, `${what}: the requisition and its lines exactly as they were`);
    return res;
  };
  /** Nothing was written FOR this stale line since w0: the line as it was, no ledger / audit row for it,
   *  no movement, department row or stock change for its material. */
  const staleUntouched = (what: string, lid: string, mm: { id: string }, w0: any, l0: any) => {
    eq(line(lid), l0, `${what}: the stale line exactly as it was (no figure, no history, not closed)`);
    eq(all(`SELECT id FROM requisition_issue_ledger WHERE req_item_id = ? AND rowid > ?`, lid, w0.requisition_issue_ledger.m).length
      + all(`SELECT id FROM audit_events WHERE entity_id = ? AND rowid > ?`, lid, w0.audit_events.m).length, 0,
    `${what}: no ledger or audit row for the stale line`);
    eq(all(`SELECT id FROM inventory_transactions WHERE material_id = ? AND rowid > ?`, mm.id, w0.inventory_transactions.m).length
      + all(`SELECT id FROM department_material_transactions WHERE material_id = ? AND rowid > ?`, mm.id, w0.department_material_transactions.m).length, 0,
    `${what}: no movement or department row for its item`);
    ok(near(stockOf(mm), Number(w0.stock.find((x: any) => x.id === mm.id)?.current_stock) || 0), `${what}: its item's stock unchanged`);
  };
  const designs = new Set<string>();
  /**
   * A gesture carrying a stale entry BESIDE normal ones. Two designs keep the owner's pick:
   *   REFUSE WHOLE (the plan): 400 'unit_review', the sentence, nothing written at all;
   *   HELD (a short line's stance: "issue the 5, hold the 1"): 200, the stale line named with the
   *   sentence and nothing written for it, every other entry written EXACTLY as the same gesture
   *   without the stale entry writes on a twin requisition.
   * Either is checked strictly; which one the tree uses is reported.
   */
  const mixedGesture = async (what: string, reqId: string, stale: Array<{ lid: string; m: { id: string; name: string } }>,
    run: () => Promise<{ status: number; body: any }>, twin: () => Promise<{ status: number; body: any }>, wantCode = 'unit_review') => {
    const w0 = world(); const r0 = reqState(reqId); const l0 = stale.map(x => line(x.lid));
    const r = await run();
    if (r.status !== 200) {
      designs.add(`${what}: REFUSE WHOLE (${r.status})`);
      eq([r.status, r.body?.code], [400, wantCode], `${what}: refused 400 ${wantCode}`);
      eq(world(), w0, `${what}: nothing written (no row in any table, no stock moved)`);
      eq(reqState(reqId), r0, `${what}: the requisition and its lines exactly as they were`);
      for (const x of stale) has(r.body?.error, `${x.m.name}: ${SL.STALE_UNIT_WORDS}`, `${what}: the owner's sentence names ${x.m.name}`);
      return r;
    }
    designs.add(`${what}: HELD (200, the rest written)`);
    const eff = lineEffects(w0);
    stale.forEach((x, i) => staleUntouched(`${what} [${x.m.name}]`, x.lid, x.m, w0, l0[i]));
    for (const x of stale) has(JSON.stringify(r.body), `${x.m.name}: ${SL.STALE_UNIT_WORDS}`, `${what}: the 200 names ${x.m.name} with the owner's sentence`);
    ok(reqRow(reqId).status !== 'fulfilled', `${what}: the requisition is not closed while the stale line is owed`, reqRow(reqId).status);
    const w1 = world();
    const rt = await twin();
    ok(rt.status === 200, `${what}: twin gesture answers 200`, rt.body);
    eq(norm(eff), norm(lineEffects(w1)), `${what}: every other line written exactly as the same gesture without the stale entry (twin): stock, ledger, movements, department credits`);
    return r;
  };
  const outstanding = (lid: string) => {
    const l = line(lid);
    return Math.max(0, ((l.chef_approved_qty != null ? Number(l.chef_approved_qty) : Number(l.quantity_requested)) || 0) - (Number(l.quantity_issued) || 0));
  };
  /** Exactly what store-issue wrote for an issue on a stale line before this fix (the REQ-1669 hand-over). */
  const phantomIssue = (lid: string, qty: number) => db.transaction(() => {
    const cur = line(lid);
    const before = Number(cur.quantity_issued) || 0;
    const after = before + qty;
    let hist: any[] = [];
    try { hist = JSON.parse(cur.issue_history || '[]'); } catch { hist = []; }
    const at = new Date().toISOString();
    hist.push({ qty, at, by: STORE.email, note: '' });
    db.prepare(`UPDATE requisition_items SET quantity_issued = ?, issued_at = ?, issued_by = ?, issue_history = ? WHERE id = ?`)
      .run(after, at, STORE.email, JSON.stringify(hist), lid);
    return IS.applyIssueDelta(db, { reqItemId: lid, beforeLineQty: before, afterLineQty: after, reason: 'issue', actor: STORE.email });
  })();

  /* ══════════ Z — BASELINE: normal lines through the real handlers ══════════ */
  console.log('Z  baseline scenario (normal lines only)');
  {
    as(STORE);
    const ZA = mkReq('za', 'mgmt_approved', [
      { key: 'ched', m: CHED, q: 2, unit: 'kg' }, { key: 'oil', m: OIL, q: 500, unit: 'ml' },
      { key: 'onion', m: ONION, q: 3, unit: 'kg' }, { key: 'eggs', m: EGGS, q: 12, unit: 'pcs' },
      { key: 'butter', m: BUTTER, q: 1, unit: ' KG ' }, { key: 'salt', m: SALT, q: 1500, unit: 'g' },
    ]);
    const z = ZA.ids;
    await gesture('Z1 store-issue: partial issue (CHED 1 of 2 kg)', [ZA.rid], () => issue(ZA.rid, [{ id: z.ched, action: 'issue', quantity: 1 }]));
    await gesture('Z1 store-issue: defer (ONION)', [ZA.rid], () => issue(ZA.rid, [{ id: z.onion, action: 'defer', defer_until: '2031-01-01T10:00', reason: 'cold room' }]));
    await gesture('Z1 store-issue: batch (rest of CHED, OIL ml, EGGS, BUTTER " KG ", SALT g)', [ZA.rid], () => issue(ZA.rid, [
      { id: z.ched, action: 'issue', quantity: 1 }, { id: z.oil, action: 'issue', quantity: 500 },
      { id: z.eggs, action: 'issue', quantity: 12 }, { id: z.butter, action: 'issue', quantity: 1 }, { id: z.salt, action: 'issue', quantity: 1500 },
    ]));
    await gesture('Z1 store-issue: undo (EGGS)', [ZA.rid], () => issue(ZA.rid, [{ id: z.eggs, action: 'undo' }]));
    await gesture('Z1 store-issue: reject (EGGS)', [ZA.rid], () => issue(ZA.rid, [{ id: z.eggs, action: 'reject', reason: 'not needed' }]));
    await gesture('Z1 store-issue: unreject (EGGS)', [ZA.rid], () => issue(ZA.rid, [{ id: z.eggs, action: 'unreject' }]));
    await gesture('Z1 store-issue: issue a deferred line in full (ONION)', [ZA.rid], () => issue(ZA.rid, [{ id: z.onion, action: 'issue', quantity: 3 }]));
    await gesture('Z1 store-issue: last line → fulfilled (EGGS)', [ZA.rid], () => issue(ZA.rid, [{ id: z.eggs, action: 'issue', quantity: 12 }]));
    await gesture('Z1 store-issue: undo on a fulfilled requisition (SALT)', [ZA.rid], () => issue(ZA.rid, [{ id: z.salt, action: 'undo' }]));
    await gesture('Z1 store-issue: over-issue with a note (SALT 2000 of 1500 g)', [ZA.rid], () =>
      issue(ZA.rid, [{ id: z.salt, action: 'issue', quantity: 2000, note: 'party ran over' }]));

    const ZB = mkReq('zb', 'mgmt_approved', [
      { key: 'ched', m: CHED, q: 750, unit: 'g' }, { key: 'oil', m: OIL, q: 1, unit: 'L' }, { key: 'onion', m: ONION, q: 2, unit: 'kg' },
    ]);
    await gesture('Z2 store-process: issue to department (CHED g, OIL L, ONION part)', [ZB.rid], () => processReq(ZB.rid, {
      lines: [{ id: ZB.ids.ched, quantity_issued: 750, quantity_to_purchase: 0 }, { id: ZB.ids.oil, quantity_issued: 1, quantity_to_purchase: 0 },
        { id: ZB.ids.onion, quantity_issued: 1, quantity_to_purchase: 0 }],
    }));
    const ZC = mkReq('zc', 'mgmt_approved', [{ key: 'onion', m: ONION, q: 4, unit: 'kg' }, { key: 'ched', m: CHED, q: 1, unit: 'kg' }]);
    await gesture('Z2 store-process: issue + "Also raise a vendor PO" (ONION buy 3)', [ZC.rid], () => processReq(ZC.rid, {
      auto_create_po: true,
      lines: [{ id: ZC.ids.onion, quantity_issued: 1, quantity_to_purchase: 3, vendor: 'UG Vendor', vendor_id: 'ug-v-1', unit_price: 30 },
        { id: ZC.ids.ched, quantity_issued: 1, quantity_to_purchase: 0 }],
    }));
    // The tick with no Buy quantity writes no PO (fix round 1, mx-mgmt-r1): on a requisition with no
    // stale line it must answer exactly as production, posted lines or none. Nothing is issued here,
    // so no stock moves and the later sections start from the same shelves.
    const ZD = mkReq('zd', 'mgmt_approved', [{ key: 'onion', m: ONION, q: 2, unit: 'kg' }, { key: 'ched', m: CHED, q: 1, unit: 'kg' }]);
    await gesture('Z2 store-process: "Also raise a vendor PO" with no Buy quantity, every line at 0', [ZD.rid], () => processReq(ZD.rid, {
      auto_create_po: true,
      lines: [{ id: ZD.ids.onion, quantity_issued: 0, quantity_to_purchase: 0 }, { id: ZD.ids.ched, quantity_issued: 0, quantity_to_purchase: 0 }],
    }));
    const ZE = mkReq('ze', 'mgmt_approved', [{ key: 'onion', m: ONION, q: 1, unit: 'kg' }]);
    await gesture('Z2 store-process: "Also raise a vendor PO" with no lines posted', [ZE.rid], () => processReq(ZE.rid, {
      auto_create_po: true, lines: [],
    }));

    as(ADMIN);
    const posted = await gesture('Z3 POST /api/requisitions (kg, blank → L, tray on an unpacked item, PCS)', [], () => postReq({
      department_id: D.id, date: TODAY, notes: 'ug baseline',
      items: [{ material_id: CHED.id, quantity_requested: 2, unit: 'kg', department_id: D.id },
        { material_id: OIL.id, quantity_requested: 1, unit: '', department_id: D.id },
        { material_id: ONION.id, quantity_requested: 1, unit: 'tray', department_id: D.id },
        { material_id: EGGS.id, quantity_requested: 6, unit: 'PCS', department_id: D.id }],
    }));
    const zdId = String(posted.body?.requisition?.id || '');
    ok(posted.status === 201 && zdId, 'Z3: a normal requisition is saved (201)', posted.body);
    if (zdId) {
      await gesture('Z4 PUT /api/requisitions (g on a kg item, no unit → prior L, kg)', [zdId], () => putReq({
        id: zdId, items: [{ material_id: CHED.id, quantity_requested: 1500, unit: 'g' }, { material_id: OIL.id, quantity_requested: 2 },
          { material_id: ONION.id, quantity_requested: 2, unit: 'kg' }],
      }));
      await gesture('Z5 submit a normal draft', [zdId], () => submit(zdId, { force_outside_window: true }));
      const byMat = (m: { id: string }) => String(one(`SELECT id FROM requisition_items WHERE req_id = ? AND material_id = ?`, zdId, m.id)?.id || '');
      await gesture('Z6 line edit: approved figure (CHED)', [zdId], () => editLine(zdId, byMat(CHED), { chef_approved_qty: 1000 }));
      await gesture('Z6 line edit: reject (ONION)', [zdId], () => editLine(zdId, byMat(ONION), { is_rejected: true }));
      await gesture('Z6 line edit: chef note (OIL)', [zdId], () => editLine(zdId, byMat(OIL), { chef_note: 'ug note' }));
    }

    console.log('Z  baseline reports for the seeded items');
    for (const m of [CHED, OIL, ONION, EGGS, BUTTER, SALT]) {
      const il = await issueLog(`${WIDE}&material_id=${m.id}`);
      obs(`Z7 issue-log ${m.id}`, canonSet({ status: il.status, rows: il.body?.rows, totals: il.body?.totals }));
      const dc = await deptCons(`${WIDE}&material_id=${m.id}`);
      obs(`Z7 department-consumption ${m.id}`, canonSet({ status: dc.status, body: dc.body }));
      const dcr = await deptCons(`${WIDE}&material_id=${m.id}&view=register`);
      obs(`Z7 department-consumption register ${m.id}`, canonSet({ status: dcr.status, body: dcr.body }));
      const sil = await issuedLog(`${WIDE}&material_id=${m.id}`);
      obs(`Z7 store-issued-log ${m.id}`, canonSet({ status: sil.status, body: sil.body }));
    }
  }

  /* ══════════ S — the Store desk writer (store-issue) ══════════ */
  console.log('S  store-issue on stale lines');
  const S1 = mkReq('s1', 'mgmt_approved', [
    { key: 'pkt', m: CHED, q: 2, unit: 'PKT' }, { key: 'blank', m: BUTTER, q: 1, unit: '' },
    { key: 'onion', m: ONION, q: 1, unit: 'kg' }, { key: 'oil', m: OIL, q: 1, unit: 'L' },
    { key: 'chefrej', m: SALT, q: 3, unit: 'PKT', rej: 1 },
  ]);
  const s = S1.ids;
  ok(IS.lineFactor('PKT', CHED).needsReview && IS.lineFactor('', BUTTER).needsReview, 'fixture: the PKT and blank lines are stale by lineFactor');
  ok(!IS.lineFactor('kg', ONION).needsReview && !IS.lineFactor('L', OIL).needsReview && !IS.lineFactor(' KG ', BUTTER).needsReview
    && !IS.lineFactor('g', CHED).needsReview && !IS.lineFactor('tray', ONION).needsReview, 'fixture: kg / L / " KG " / g / tray (unpacked) lines are not stale');
  if (MODE === 'base') {
    // BEFORE (production): the issue CLOSES the stale line, moves nothing, says nothing.
    as(STORE);
    const c0 = stockOf(CHED);
    const r = await issue(S1.rid, [{ id: s.pkt, action: 'issue', quantity: 2 }]);
    ok(r.status === 200 && near(line(s.pkt).quantity_issued, 2), 'BEFORE (production): an issue on a PKT line answers 200 and records 2', { r: r.body, l: line(s.pkt) });
    ok(near(stockOf(CHED), c0), 'BEFORE (production): no central stock moved for it');
    const lr = ledgerOf(s.pkt);
    ok(lr.length === 1 && Number(lr[0].needs_unit_review) === 1 && lr[0].skip_reason === 'unit_review' && near(lr[0].delta_recipe_qty, 0),
      'BEFORE (production): its ledger row is needs_unit_review / unit_review / 0 moved', lr);
    ok(IS.lineIssueComplete({ ...line(s.pkt), line_unit: line(s.pkt).unit, unit: CHED.unit, purchase_unit: CHED.purchase_unit, pack_size: CHED.pack_size }),
      'BEFORE (production): the line now counts as complete');
  } else {
    const facts = (lu: string, m: any) => SL.staleUnitFacts(lu, m);
    as(STORE);
    // (a) the PKT line
    let r = await nothingWritten('S1a issue on the PKT line', [S1.rid], () => issue(S1.rid, [{ id: s.pkt, action: 'issue', quantity: 2 }]));
    eq([r.status, r.body?.code], [400, 'unit_review'], 'S1a: refused 400 unit_review');
    if (r.body && 'applied' in r.body) eq(r.body.applied, 0, 'S1a: applied 0');
    has(r.body?.error, `${CHED.name}: ${SL.STALE_UNIT_WORDS}`, "S1a: the owner's sentence, naming the item");
    has(r.body?.error, facts('PKT', CHED), 'S1a: the facts — "The line says PKT; this item is bought in kg and used in g."');
    has(r.body?.error, 'Nothing was issued', 'S1a: says nothing was issued');
    ok((r.body?.blocked || []).some((b: any) => (b.req_item_id || b.line_id) === s.pkt && b.code === 'unit_review'), 'S1a: blocked names the line', r.body?.blocked);
    if (!String(r.body?.error || '').includes('Reload the page')) note('S1a: the store-issue refusal does not end with "Reload the page." (skeptic must_change 4c — a desk opened before the deploy alerts without refreshing)');
    // (b) the blank-unit line
    r = await nothingWritten('S1b issue on the blank-unit line', [S1.rid], () => issue(S1.rid, [{ id: s.blank, action: 'issue', quantity: 1 }]));
    eq([r.status, r.body?.code], [400, 'unit_review'], 'S1b: refused 400 unit_review');
    has(r.body?.error, facts('', BUTTER), 'S1b: "The line has no unit; this item is bought in kg and used in g."');
    // (c) a mixed gesture (ONION + the PKT line), on its own requisition, against a twin without the PKT line
    {
      const S3 = mkReq('s3', 'mgmt_approved', [{ key: 'pkt', m: CHED, q: 2, unit: 'PKT' }, { key: 'onion', m: ONION, q: 1, unit: 'kg' }]);
      const T3 = mkReq('t3', 'mgmt_approved', [{ key: 'onion', m: ONION, q: 1, unit: 'kg' }]);
      await mixedGesture('S1c mixed gesture (ONION + PKT)', S3.rid, [{ lid: S3.ids.pkt, m: CHED }],
        () => issue(S3.rid, [{ id: S3.ids.onion, action: 'issue', quantity: 1 }, { id: S3.ids.pkt, action: 'issue', quantity: 2 }]),
        () => issue(T3.rid, [{ id: T3.ids.onion, action: 'issue', quantity: 1 }]));
    }
    // (d) an OLD desk's Issue All (every open line, stale ones included) — a tab opened before the deploy
    {
      const S4 = mkReq('s4', 'mgmt_approved', [{ key: 'pkt', m: CHED, q: 2, unit: 'PKT' }, { key: 'blank', m: BUTTER, q: 1, unit: '' },
        { key: 'onion', m: ONION, q: 1, unit: 'kg' }, { key: 'oil', m: OIL, q: 1, unit: 'L' }]);
      const T4 = mkReq('t4', 'mgmt_approved', [{ key: 'onion', m: ONION, q: 1, unit: 'kg' }, { key: 'oil', m: OIL, q: 1, unit: 'L' }]);
      await mixedGesture('S1d old-desk Issue All (stale lines included)', S4.rid, [{ lid: S4.ids.pkt, m: CHED }, { lid: S4.ids.blank, m: BUTTER }],
        () => issue(S4.rid, ['pkt', 'blank', 'onion', 'oil'].map(k => ({ id: S4.ids[k], action: 'issue', quantity: outstanding(S4.ids[k]) }))),
        () => issue(T4.rid, ['onion', 'oil'].map(k => ({ id: T4.ids[k], action: 'issue', quantity: 1 }))));
      // whichever design: the stale lines stay owed, and a second press can never close them
      r = await issue(S4.rid, ['pkt', 'blank'].map(k => ({ id: S4.ids[k], action: 'issue', quantity: outstanding(S4.ids[k]) })));
      eq([r.status, r.body?.code], [400, 'unit_review'], 'S1d: pressing again with only the stale lines left → 400 unit_review');
      ok(near(line(S4.ids.pkt).quantity_issued, 0) && near(line(S4.ids.blank).quantity_issued, 0), 'S1d: the stale lines are never closed');
    }
    // (e) a chef-rejected stale line is not this check's business (the write loop skips it, as before)
    r = await issue(S1.rid, [{ id: s.chefrej, action: 'issue', quantity: 3 }]);
    ok(r.body?.code !== 'unit_review' && near(line(s.chefrej).quantity_issued, 0) && ledgerOf(s.chefrej).length === 0,
      'S1e: a chef-rejected stale line is not refused as unit_review and nothing is written for it', { s: r.status, b: r.body });
    // (f) defer on a stale line: accepted as today, moves nothing
    let w0 = world();
    r = await issue(S1.rid, [{ id: s.pkt, action: 'defer', defer_until: '2031-02-01T10:00', reason: 'ask Continental' }]);
    ok(r.status === 200 && !!line(s.pkt).deferred_until && ledgerOf(s.pkt).length === 0 && JSON.stringify(stockDelta(w0)) === '{}',
      'S1f: defer on a stale line still accepted (200), no ledger row, no stock', { s: r.status, b: r.body });
    // (g) the new desk's Issue All: stale lines left out → the rest issued exactly as on a twin without them
    w0 = world();
    r = await issue(S1.rid, ['onion', 'oil'].map(k => ({ id: s[k], action: 'issue', quantity: outstanding(s[k]) })));
    const effS = lineEffects(w0);
    ok(r.status === 200 && reqRow(S1.rid).status === 'store_processed', 'S1g: Issue All without the stale lines → 200, requisition stays open (stale lines owed)', { s: r.status, b: r.body, st: reqRow(S1.rid).status });
    ok(near(line(s.onion).quantity_issued, 1) && near(line(s.oil).quantity_issued, 1), 'S1g: ONION and OIL issued');
    ok(near(line(s.pkt).quantity_issued, 0) && near(line(s.blank).quantity_issued, 0) && ledgerOf(s.pkt).length === 0 && ledgerOf(s.blank).length === 0,
      'S1g: the stale lines untouched');
    const T1 = mkReq('t1', 'mgmt_approved', [{ key: 'onion', m: ONION, q: 1, unit: 'kg' }, { key: 'oil', m: OIL, q: 1, unit: 'L' }]);
    w0 = world();
    const rt = await issue(T1.rid, ['onion', 'oil'].map(k => ({ id: T1.ids[k], action: 'issue', quantity: 1 })));
    const effT = lineEffects(w0);
    ok(rt.status === 200 && reqRow(T1.rid).status === 'fulfilled', 'S1g twin: the same lines on a requisition with no stale line → 200 fulfilled', rt.body);
    eq(norm(effS), norm(effT), 'S1g: ONION/OIL stock moves, ledger rows, movements and department credits identical to the twin');
    eq(norm({ ...r.body, status: null }), norm({ ...rt.body, status: null }), 'S1g: the 200 body has the same shape as the twin (status aside)');
    // (h) reject the stale lines → the requisition closes
    w0 = world();
    r = await issue(S1.rid, [{ id: s.pkt, action: 'reject', reason: "Unit doesn't match this item — raise it again in kg" }]);
    ok(r.status === 200 && Number(line(s.pkt).store_rejected) === 1 && near(line(s.pkt).quantity_issued, 0) && ledgerOf(s.pkt).length === 0,
      'S1h: Reject on the stale PKT line accepted, nothing issued, no ledger row', { s: r.status, b: r.body });
    r = await issue(S1.rid, [{ id: s.blank, action: 'reject', reason: 'unit' }]);
    ok(r.status === 200 && reqRow(S1.rid).status === 'fulfilled', 'S1h: rejecting the last stale line closes the requisition (fulfilled)', { s: r.status, st: reqRow(S1.rid).status });
    ok(near(stockOf(CHED) - (w0.stock.find((x: any) => x.id === CHED.id)?.current_stock || 0), 0)
      && near(stockOf(BUTTER) - (w0.stock.find((x: any) => x.id === BUTTER.id)?.current_stock || 0), 0), 'S1h: no CHEDDAR / BUTTER stock moved');
    // (i) unreject on the fulfilled requisition still accepted; the line is then refused again at issue
    r = await issue(S1.rid, [{ id: s.blank, action: 'unreject' }]);
    ok(r.status === 200 && Number(line(s.blank).store_rejected) === 0, 'S1i: Un-reject still accepted by the route (200)', r.body);
    r = await nothingWritten('S1i issue after un-reject', [S1.rid], () => issue(S1.rid, [{ id: s.blank, action: 'issue', quantity: 1 }]));
    eq([r.status, r.body?.code], [400, 'unit_review'], 'S1i: …and the issue is refused again');
    await issue(S1.rid, [{ id: s.blank, action: 'reject', reason: 'unit' }]);

    // PARTY: the stale line refused, the rest transferred, the stale material never moves.
    console.log('S  party requisition');
    const P1 = mkReq('p1', 'mgmt_approved', [{ key: 'cream', m: CREAM, q: 2, unit: 'PKT' }, { key: 'onion', m: ONION, q: 2, unit: 'kg' }],
      { purpose: 'party', event: 'UG Party', fp: 'FP-UG-1' });
    const cr0 = stockOf(CREAM); const on0 = stockOf(ONION);
    r = await nothingWritten('S2a party: issue on the stale line', [P1.rid], () => issue(P1.rid, [{ id: P1.ids.cream, action: 'issue', quantity: 2 }]));
    eq([r.status, r.body?.code], [400, 'unit_review'], 'S2a: refused 400 unit_review on a party requisition too');
    r = await issue(P1.rid, [{ id: P1.ids.onion, action: 'issue', quantity: 2 }]);
    ok(r.status === 200, 'S2b: the ONION line issues (200)', r.body);
    r = await issue(P1.rid, [{ id: P1.ids.cream, action: 'reject', reason: 'unit' }]);
    ok(r.status === 200 && reqRow(P1.rid).status === 'fulfilled', 'S2c: Reject the stale line → party requisition fulfilled', { s: r.status, b: r.body, st: reqRow(P1.rid).status });
    ok(near(stockOf(CREAM), cr0), 'S2c: the stale CREAM never moved');
    ok(near(stockOf(ONION), on0 - 2), 'S2c: the party transfer moved the 2 kg ONION', { now: stockOf(ONION), before: on0 });
    eq(all(`SELECT type FROM inventory_transactions WHERE reference_id = ? AND material_id = ?`, P1.rid, CREAM.id).length
      + all(`SELECT type FROM department_material_transactions WHERE material_id = ? AND (reference_id = ? OR req_item_id = ?)`, CREAM.id, P1.rid, P1.ids.cream).length,
    0, 'S2c: no movement or department row for the stale CREAM');
  }

  /* ══════════ M — the management desk writer (store-process) ══════════ */
  console.log('M  store-process on stale lines');
  const M1 = mkReq('m1', 'mgmt_approved', [
    { key: 'pkt', m: CHED, q: 2, unit: 'PKT' }, { key: 'onion', m: ONION, q: 2, unit: 'kg' },
    { key: 'oil', m: OIL, q: 300, unit: 'ml' }, { key: 'eggs', m: EGGS, q: 6, unit: 'pcs' },
  ]);
  const m = M1.ids;
  as(STORE);
  if (MODE === 'base') {
    const c0 = stockOf(CHED);
    const r = await processReq(M1.rid, { lines: [{ id: m.pkt, quantity_issued: 2 }, { id: m.onion, quantity_issued: 2 }, { id: m.oil, quantity_issued: 300 }, { id: m.eggs, quantity_issued: 6 }] });
    ok(r.status === 200 && near(line(m.pkt).quantity_issued, 2) && near(stockOf(CHED), c0), 'BEFORE (production): store-process records 2 on the PKT line and moves nothing', { r: r.body });
    ok(Array.isArray(r.body?.issue_unit_review) && r.body.issue_unit_review.includes(CHED.name), 'BEFORE (production): …and only reports it as issue_unit_review', r.body);
    const M5 = mkReq('m5', 'mgmt_approved', [{ key: 'pkt', m: CHED, q: 1, unit: 'PKT' }]);
    const r5 = await processReq(M5.rid, { auto_create_po: true, lines: [{ id: M5.ids.pkt, quantity_issued: 0, quantity_to_purchase: 0 }] });
    ok(r5.status === 200 && reqRow(M5.rid).status === 'store_processed',
      'BEFORE (production): the vendor-PO tick with no Buy quantity flips an all-stale requisition to store_processed (200), nothing issued', { s: r5.status, b: r5.body });
  } else {
    // (a) a figure on the stale line beside a normal one — its own requisition, against a twin
    {
      const MA = mkReq('ma', 'mgmt_approved', [{ key: 'pkt', m: CHED, q: 2, unit: 'PKT' }, { key: 'onion', m: ONION, q: 2, unit: 'kg' }]);
      const TA = mkReq('ta', 'mgmt_approved', [{ key: 'onion', m: ONION, q: 2, unit: 'kg' }]);
      const r = await mixedGesture('M1a store-process: a figure on the stale line + ONION', MA.rid, [{ lid: MA.ids.pkt, m: CHED }],
        () => processReq(MA.rid, { lines: [{ id: MA.ids.pkt, quantity_issued: 2, quantity_to_purchase: 0 }, { id: MA.ids.onion, quantity_issued: 2, quantity_to_purchase: 0 }] }),
        () => processReq(TA.rid, { lines: [{ id: TA.ids.onion, quantity_issued: 2, quantity_to_purchase: 0 }] }));
      if (r.status === 400) {
        ok(Array.isArray(r.body?.req_item_ids) && r.body.req_item_ids.includes(MA.ids.pkt), 'M1a: req_item_ids names the stale line', r.body);
        has(r.body?.error, `Nothing was issued and ${MA.number} is unchanged.`, 'M1a: "Nothing was issued and <REQ> is unchanged."');
      } else {
        ok((r.body?.unit_review_lines || []).some((x: any) => x.req_item_id === MA.ids.pkt), 'M1a (held): unit_review_lines names the stale line', r.body);
        ok(!('issue_unit_review' in (r.body || {})), 'M1a (held): no issue_unit_review — no hand-over was recorded on the stale line', r.body);
        eq(reqRow(MA.rid).status, 'store_processed', 'M1a (held): the requisition stays store_processed while the stale line is owed');
      }
    }
    // (b) a Buy qty on the stale line (no tick)
    let r: { status: number; body: any };
    // Without the tick no Buy qty is ever ordered (po_not_requested, as on every line), so either design
    // keeps the pick: refuse whole, or hold the stale line and process the rest — never a PO, never a write on it.
    {
      const MB = mkReq('mb', 'mgmt_approved', [{ key: 'pkt', m: CHED, q: 2, unit: 'PKT' }, { key: 'onion', m: ONION, q: 2, unit: 'kg' }]);
      const TB = mkReq('tb', 'mgmt_approved', [{ key: 'onion', m: ONION, q: 2, unit: 'kg' }]);
      const po0 = world();
      r = await mixedGesture('M1b store-process: a Buy qty on the stale line (no tick) + ONION', MB.rid, [{ lid: MB.ids.pkt, m: CHED }],
        () => processReq(MB.rid, { lines: [{ id: MB.ids.pkt, quantity_issued: 0, quantity_to_purchase: 3 }, { id: MB.ids.onion, quantity_issued: 2, quantity_to_purchase: 0 }] }),
        () => processReq(TB.rid, { lines: [{ id: TB.ids.onion, quantity_issued: 2, quantity_to_purchase: 0 }] }));
      eq([world().purchase_orders, world().purchase_order_items], [po0.purchase_orders, po0.purchase_order_items], 'M1b: no purchase order written');
      if (r.status === 200) {
        ok((r.body?.po_skipped_lines || []).some((x: any) => x.req_item_id === MB.ids.pkt && x.code === 'po_not_requested'),
          'M1b (held): the stale line\'s Buy qty is reported as not ordered (po_not_requested), never dropped silently', r.body?.po_skipped_lines);
      }
    }
    // (c) the vendor-PO tick while the stale line is owed
    {
      const MC = mkReq('mc', 'mgmt_approved', [{ key: 'pkt', m: CHED, q: 2, unit: 'PKT' }, { key: 'onion', m: ONION, q: 4, unit: 'kg' }]);
      r = await nothingWritten('M1c the vendor-PO tick while the stale line is owed', [MC.rid], () => processReq(MC.rid, {
        auto_create_po: true,
        lines: [{ id: MC.ids.onion, quantity_issued: 1, quantity_to_purchase: 3, vendor: 'UG Vendor', vendor_id: 'ug-v-1', unit_price: 30 }],
      }));
      eq([r.status, r.body?.code], [409, 'unit_review_open'], 'M1c: refused 409 unit_review_open (no PO, nothing issued)');
      ok(Array.isArray(r.body?.req_item_ids) && r.body.req_item_ids.includes(MC.ids.pkt), 'M1c: req_item_ids names the stale line', r.body);
      has(r.body?.error, CHED.name, 'M1c: the refusal names the stale item');
    }
    // (d) the modal's own POST: stale line at 0 (or absent), the rest as typed
    let w0 = world();
    const lm0 = line(m.pkt);
    r = await processReq(M1.rid, { lines: [{ id: m.pkt, quantity_issued: 0, quantity_to_purchase: 0 }, { id: m.onion, quantity_issued: 2, quantity_to_purchase: 0 },
      { id: m.oil, quantity_issued: 300, quantity_to_purchase: 0 }, { id: m.eggs, quantity_issued: 6, quantity_to_purchase: 0 }] });
    const effM = lineEffects(w0);
    ok(r.status === 200 && reqRow(M1.rid).status === 'store_processed', 'M1d: the rest processed (200), the requisition stays store_processed while the stale line is owed', { s: r.status, b: r.body, st: reqRow(M1.rid).status });
    ok(!('issue_unit_review' in (r.body || {})), 'M1d: no issue_unit_review — no hand-over was recorded on the stale line', r.body);
    staleUntouched('M1d', m.pkt, CHED, w0, lm0);
    const M2 = mkReq('m2', 'mgmt_approved', [{ key: 'onion', m: ONION, q: 2, unit: 'kg' }, { key: 'oil', m: OIL, q: 300, unit: 'ml' }, { key: 'eggs', m: EGGS, q: 6, unit: 'pcs' }]);
    w0 = world();
    const r2 = await processReq(M2.rid, { lines: [{ id: M2.ids.onion, quantity_issued: 2, quantity_to_purchase: 0 },
      { id: M2.ids.oil, quantity_issued: 300, quantity_to_purchase: 0 }, { id: M2.ids.eggs, quantity_issued: 6, quantity_to_purchase: 0 }] });
    const effM2 = lineEffects(w0);
    ok(r2.status === 200 && reqRow(M2.rid).status === 'fulfilled', 'M1d twin: the same lines without a stale line → 200 fulfilled', r2.body);
    eq(norm(effM), norm(effM2), 'M1d: the normal lines’ stock moves, ledger rows, movements and department credits identical to the twin');
    // (e) the Store desk then rejects it → closed
    r = await issue(M1.rid, [{ id: m.pkt, action: 'reject', reason: 'unit' }]);
    ok(r.status === 200 && reqRow(M1.rid).status === 'fulfilled', 'M1e: Reject on the Store desk closes it', { s: r.status, st: reqRow(M1.rid).status });
    // (f) every store line stale (skeptic must_change 6): an empty process must not flip the requisition to
    // store_processed and announce an issue that never happened
    const M4 = mkReq('m4', 'mgmt_approved', [{ key: 'pkt', m: CHED, q: 1, unit: 'PKT' }]);
    r = await nothingWritten('M1f store-process with every line stale, nothing posted', [M4.rid], () => processReq(M4.rid, { lines: [] }));
    eq([r.status, r.body?.code], [400, 'unit_review'], 'M1f: refused 400 unit_review (no empty "processed")');
    has(r.body?.error, `${CHED.name}: ${SL.STALE_UNIT_WORDS}`, "M1f: the owner's sentence");
    // (g) the same with the vendor-PO tick and no Buy quantity (fix round 1, mx-mgmt-r1): no PO is written,
    // so the submit changes nothing and is refused like the unticked one — the tick is not a way round it.
    const M5 = mkReq('m5', 'mgmt_approved', [{ key: 'pkt', m: CHED, q: 1, unit: 'PKT' }]);
    r = await nothingWritten('M1g the tick, no Buy, every line stale (stale line at 0)', [M5.rid], () => processReq(M5.rid, {
      auto_create_po: true, lines: [{ id: M5.ids.pkt, quantity_issued: 0, quantity_to_purchase: 0 }] }));
    eq([r.status, r.body?.code], [400, 'unit_review'], 'M1g: refused 400 unit_review (the tick does not flip it to store_processed)');
    has(r.body?.error, `${CHED.name}: ${SL.STALE_UNIT_WORDS}`, "M1g: the owner's sentence");
    const M6 = mkReq('m6', 'mgmt_approved', [{ key: 'pkt', m: CHED, q: 1, unit: 'PKT' }]);
    r = await nothingWritten('M1h the tick, no lines posted, every line stale', [M6.rid], () => processReq(M6.rid, { auto_create_po: true, lines: [] }));
    eq([r.status, r.body?.code], [400, 'unit_review'], 'M1h: refused 400 unit_review');
    const M7 = mkReq('m7', 'mgmt_approved', [{ key: 'pkt', m: CHED, q: 1, unit: 'PKT' }, { key: 'onion', m: ONION, q: 2, unit: 'kg' }]);
    r = await nothingWritten('M1i the tick, no Buy, a stale line + a normal line left at 0', [M7.rid], () => processReq(M7.rid, {
      auto_create_po: true, lines: [{ id: M7.ids.onion, quantity_issued: 0, quantity_to_purchase: 0 }] }));
    eq([r.status, r.body?.code], [400, 'unit_review'], 'M1i: refused 400 unit_review (nothing changes, nothing ordered)');
  }

  /* ══════════ F — forms: POST / PUT / submit / line edit ══════════ */
  console.log('F  POST / PUT / submit / line edit');
  as(ADMIN);
  const countReqs = () => one(`SELECT COUNT(*) AS n FROM requisitions`).n;
  if (MODE === 'base') {
    const r = await postReq({ department_id: D.id, date: TODAY, items: [{ material_id: CHED.id, quantity_requested: 2, unit: 'PKT', department_id: D.id }] });
    ok(r.status === 201, 'BEFORE (production): POST saves a PKT line on YELLOW CHEDDAR (201)', r.body);
    const F8 = mkReq('f8', 'draft', [{ key: 'pkt', m: CHED, q: 2, unit: 'PKT' }]);
    const sr = await submit(F8.rid, { force_outside_window: true });
    ok(sr.status === 200, 'BEFORE (production): a draft holding a PKT line submits (200)', sr.body);
  } else {
    const staleHead = (mm: { name: string }) => `${mm.name}: ${SL.STALE_UNIT_SHORT}`;
    // F1 POST a stale unit
    const n0 = countReqs();
    let r = await nothingWritten('F1 POST a PKT line', [], () => postReq({ department_id: D.id, date: TODAY,
      items: [{ material_id: CHED.id, quantity_requested: 2, unit: 'PKT', department_id: D.id }] }));
    eq([r.status, r.body?.code], [400, 'unit_review'], 'F1: POST refused 400 unit_review');
    has(r.body?.error, staleHead(CHED), 'F1: names the item and says its unit does not match');
    has(r.body?.error, 'Nothing was saved.', 'F1: "Nothing was saved."');
    ok(Array.isArray(r.body?.lines) && r.body.lines.some((x: any) => x.material_id === CHED.id), 'F1: lines names the material', r.body);
    eq(countReqs(), n0, 'F1: no requisition row (no number used)');
    // F2 mixed → whole refused
    r = await nothingWritten('F2 POST mixed (ONION kg + CHED PKT)', [], () => postReq({ department_id: D.id, date: TODAY, items: [
      { material_id: ONION.id, quantity_requested: 1, unit: 'kg', department_id: D.id },
      { material_id: CHED.id, quantity_requested: 2, unit: 'PKT', department_id: D.id }] }));
    eq([r.status, r.body?.code], [400, 'unit_review'], 'F2: a save with one stale line is refused whole');
    // F3 current units accepted, stored exactly as sent, no conversion
    r = await postReq({ department_id: D.id, date: TODAY, items: [
      { material_id: CHED.id, quantity_requested: 2, unit: 'kg', department_id: D.id },
      { material_id: BUTTER.id, quantity_requested: 500, unit: 'g', department_id: D.id },
      { material_id: ONION.id, quantity_requested: 1, unit: 'tray', department_id: D.id },
      { material_id: OIL.id, quantity_requested: 1.5, unit: ' L ', department_id: D.id },
      { material_id: SALT.id, quantity_requested: 3, unit: '', department_id: D.id }] });
    const f3 = String(r.body?.requisition?.id || '');
    ok(r.status === 201 && f3, 'F3: current units (kg, g, tray on an unpacked item, " L ", blank → purchase unit) saved 201', r.body);
    const byId = (a: any[], b: any[]) => (String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0);
    const unitsOf = (rid: string) => all(`SELECT material_id, quantity_requested, unit FROM requisition_items WHERE req_id = ?`, rid)
      .map((x: any) => [x.material_id, x.quantity_requested, x.unit]).sort(byId);
    if (f3) {
      eq(unitsOf(f3), [[BUTTER.id, 500, 'g'], [CHED.id, 2, 'kg'], [OIL.id, 1.5, 'L'], [ONION.id, 1, 'tray'], [SALT.id, 3, 'kg']].sort(byId),
        'F3: each line stored in the unit sent (blank → the purchase unit), quantities untouched');
    }
    // F4 PUT a draft whose line was saved in PKT
    const F4 = mkReq('f4', 'draft', [{ key: 'pkt', m: CHED, q: 2, unit: 'PKT' }, { key: 'onion', m: ONION, q: 1, unit: 'kg' }]);
    r = await nothingWritten('F4a PUT resending PKT', [F4.rid], () => putReq({ id: F4.rid, items: [
      { material_id: CHED.id, quantity_requested: 2, unit: 'PKT' }, { material_id: ONION.id, quantity_requested: 1, unit: 'kg' }] }));
    eq([r.status, r.body?.code], [400, 'unit_review'], 'F4a: PUT resending the stale unit refused 400 unit_review');
    has(r.body?.error, staleHead(CHED), 'F4a: names the item');
    has(r.body?.error, 'Nothing was saved.', 'F4a: "Nothing was saved."');
    r = await nothingWritten('F4b PUT with no unit (the stored PKT would carry forward)', [F4.rid], () => putReq({ id: F4.rid, items: [
      { material_id: CHED.id, quantity_requested: 2 }, { material_id: ONION.id, quantity_requested: 1 }] }));
    eq([r.status, r.body?.code], [400, 'unit_review'], 'F4b: the stored stale unit is never carried into the new line');
    r = await putReq({ id: F4.rid, items: [{ material_id: CHED.id, quantity_requested: 2, unit: 'kg' }, { material_id: ONION.id, quantity_requested: 1 }] });
    ok(r.status === 200, 'F4c: PUT with the current unit (kg) saved 200', r.body);
    eq(unitsOf(F4.rid), [[CHED.id, 2, 'kg'], [ONION.id, 1, 'kg']].sort(byId), 'F4c: the line is 2 kg as typed — nothing converted');
    // F5 a blank stored unit on a packed item is not silently re-stamped
    const F5 = mkReq('f5', 'draft', [{ key: 'blank', m: BUTTER, q: 1, unit: '' }]);
    r = await nothingWritten('F5a PUT with no unit over a blank-unit packed line', [F5.rid], () => putReq({ id: F5.rid, items: [{ material_id: BUTTER.id, quantity_requested: 1 }] }));
    eq([r.status, r.body?.code], [400, 'unit_review'], 'F5a: a blank stored unit is not silently re-stamped as kg (×1000 change of meaning) — refused');
    r = await putReq({ id: F5.rid, items: [{ material_id: BUTTER.id, quantity_requested: 1, unit: 'kg' }] });
    ok(r.status === 200 && line(`ug-ri-f5-blank`) == null && one(`SELECT unit FROM requisition_items WHERE req_id = ?`, F5.rid)?.unit === 'kg', 'F5b: with the unit typed (kg) it saves', r.body);
    // F6 PUT on a submitted requisition (Party Approvals' edit, an HOD)
    const F6 = mkReq('f6', 'submitted', [{ key: 'pkt', m: CHED, q: 2, unit: 'PKT' }]);
    as(HOD);
    r = await nothingWritten('F6 HOD PUT on a submitted requisition resending PKT', [F6.rid], () => putReq({ id: F6.rid, items: [{ material_id: CHED.id, quantity_requested: 2, unit: 'PKT' }] }));
    eq([r.status, r.body?.code], [400, 'unit_review'], 'F6: refused for an HOD edit too');
    if (/Reload the page/.test(String(r.body?.error || ''))) ok(false, 'F6: the PUT refusal must not say "Reload the page" (a reload brings the same line back — skeptic must_change 4b)', r.body?.error);
    as(ADMIN);
    // F7 SUBMIT
    const F7 = mkReq('f7', 'draft', [{ key: 'pkt', m: CHED, q: 2, unit: 'PKT' }, { key: 'onion', m: ONION, q: 1, unit: 'kg' }]);
    r = await nothingWritten('F7a submit a draft holding a PKT line', [F7.rid], () => submit(F7.rid, { force_outside_window: true }));
    eq([r.status, r.body?.code], [400, 'unit_review'], 'F7a: submit refused 400 unit_review');
    has(r.body?.error, staleHead(CHED), 'F7a: names the item');
    has(r.body?.error, 'Nothing was submitted.', 'F7a: "Nothing was submitted."');
    eq(reqRow(F7.rid).status, 'draft', 'F7a: still a draft');
    const F7b = mkReq('f7b', 'draft', [{ key: 'blank', m: BUTTER, q: 1, unit: '' }]);
    r = await nothingWritten('F7b submit a draft holding a blank-unit packed line', [F7b.rid], () => submit(F7b.rid, { force_outside_window: true }));
    eq([r.status, r.body?.code], [400, 'unit_review'], 'F7b: a blank-unit packed line is refused too');
    if (/not \./.test(String(r.body?.error || ''))) ok(false, 'F7b: the sentence must not read "not ." for a blank unit (skeptic must_change 4a)', r.body?.error);
    const F7c = mkReq('f7c', 'draft', [{ key: 'kg', m: CHED, q: 2, unit: 'kg' }]);
    r = await submit(F7c.rid, { force_outside_window: true });
    ok(r.status === 200 && reqRow(F7c.rid).status === 'submitted', 'F7c: a normal draft submits (200)', r.body);
    // F8 the chef's line edit
    const F8 = mkReq('f8', 'submitted', [{ key: 'pkt', m: CHED, q: 2, unit: 'PKT' }, { key: 'onion', m: ONION, q: 1, unit: 'kg' }]);
    as(HOD);
    r = await nothingWritten('F8a line edit: an approved figure on the stale line', [F8.rid], () => editLine(F8.rid, F8.ids.pkt, { chef_approved_qty: 2 }));
    eq([r.status, r.body?.code], [400, 'unit_review'], 'F8a: refused 400 unit_review');
    has(r.body?.error, `${CHED.name}: ${SL.STALE_UNIT_WORDS}`, "F8a: the owner's sentence");
    r = await editLine(F8.rid, F8.ids.pkt, { chef_note: 'raise again in kg' });
    ok(r.status === 200 && line(F8.ids.pkt).chef_note === 'raise again in kg', 'F8b: a note on the stale line still saves', r.body);
    r = await editLine(F8.rid, F8.ids.pkt, { is_rejected: true });
    ok(r.status === 200 && Number(line(F8.ids.pkt).is_rejected) === 1, 'F8c: the chef can still reject the stale line', r.body);
    r = await editLine(F8.rid, F8.ids.onion, { chef_approved_qty: 0.5 });
    ok(r.status === 200 && near(line(F8.ids.onion).chef_approved_qty, 0.5), 'F8d: an approved figure on a normal line saves as before', r.body);
    eq(line(F8.ids.pkt).unit, 'PKT', 'F8: the line edit never rewrites the unit');
    as(ADMIN);
  }

  /* ══════════ R — reports ══════════ */
  console.log('R  reports');
  const snapReports = async (mm: { id: string }) => ({
    il: await issueLog(`${WIDE}&material_id=${mm.id}`),
    dc: await deptCons(`${WIDE}&material_id=${mm.id}`),
    dcr: await deptCons(`${WIDE}&material_id=${mm.id}&view=register`),
    sil: await issuedLog(`${WIDE}&material_id=${mm.id}`),
  });
  const rowsFor = (il: any, lid: string, stage: string) => (il.body?.rows || []).filter((x: any) => x.req_item_id === lid && x.stage === stage);
  {
    // R1 — REQ-1669 reproduced: 2,640 recorded on a PKT line, nothing moved.
    const PH = mkReq('ph', 'store_processed', [{ key: 'pkt', m: CHED2, q: 3000, unit: 'PKT' }]);
    const lid = PH.ids.pkt;
    const pre = await snapReports(CHED2);
    const res = phantomIssue(lid, 2640);
    db.prepare(`UPDATE requisitions SET status = 'fulfilled' WHERE id = ?`).run(PH.rid);
    const lr = ledgerOf(lid);
    ok(res?.needsUnitReview === true && lr.length === 1 && Number(lr[0].needs_unit_review) === 1 && lr[0].skip_reason === 'unit_review'
      && near(lr[0].recorded_recipe_qty, 0) && near(stockOf(CHED2), 2640), 'R1 fixture: the hand-over is recorded with needs_unit_review, 0 moved, the shelf still 2,640 g', { res, lr });
    const post = await snapReports(CHED2);
    const preLedger = rowsFor(post.il, lid, 'ISSUE_PRELEDGER');
    const issueRows = rowsFor(post.il, lid, 'ISSUE');
    ok(issueRows.length === 1 && near(issueRows[0].qty, 0) && issueRows[0].skip_reason === 'unit_review', 'R1: the Issue Log keeps its ISSUE row (0 g, unit_review)', issueRows);
    if (MODE === 'base') {
      ok(preLedger.length === 1 && near(preLedger[0].qty, 2640), 'BEFORE (production): the Issue Log prints a false ISSUE (pre-ledger) row of 2,640', preLedger);
      ok(near(post.dc.body?.summary?.total_value, 1320), 'BEFORE (production): Department Consumption charges 2,640 g × ₹0.5 = ₹1,320 that never moved', post.dc.body?.summary);
      ok((post.dcr.body?.rows || []).length === 1, 'BEFORE (production): the register lists the hand-over', post.dcr.body?.totals);
      ok((post.sil.body?.events || []).length === 1, 'BEFORE (production): the Issued Items Log lists the hand-over', post.sil.body?.totals);
    } else {
      eq(preLedger.length, 0, 'R1: NO "ISSUE (pre-ledger)" row for the no-stock hand-over');
      eq(canonSet(post.dc.body), canonSet(pre.dc.body), 'R1: Department Consumption (summary, by department, by item, top, trend) identical to before the hand-over');
      eq(canonSet(post.dcr.body), canonSet(pre.dcr.body), 'R1: the Department Consumption register identical to before the hand-over');
      eq(canonSet(post.sil.body), canonSet(pre.sil.body), 'R1: the Issued Items Log identical to before the hand-over');
      // …and after the owner's store-reject of that line
      as(STORE);
      const rj = await issue(PH.rid, [{ id: lid, action: 'reject', reason: 'unit' }]);
      ok(rj.status === 200 && Number(line(lid).store_rejected) === 1 && near(line(lid).quantity_issued, 2640), 'R1: store-reject keeps the recorded 2,640 (as today)', rj.body);
      const post2 = await snapReports(CHED2);
      eq(rowsFor(post2.il, lid, 'ISSUE_PRELEDGER').length, 0, 'R1 after reject: still no pre-ledger row');
      eq(canonSet(post2.dc.body), canonSet(pre.dc.body), 'R1 after reject: Department Consumption still identical');
      eq(canonSet(post2.dcr.body), canonSet(pre.dcr.body), 'R1 after reject: register still identical');
      eq(canonSet(post2.sil.body), canonSet(pre.sil.body), 'R1 after reject: Issued Items Log still identical');
    }
  }
  {
    // R2 — the skeptic's window case: phantom 2,640 PKT → the item re-set so PKT is its purchase unit →
    // undo (writes no ledger row) → a real 3 PKT issue moves 3,000 g. Every report counts exactly the real 3 PKT.
    const W = mkReq('w', 'store_processed', [{ key: 'pkt', m: SALT2, q: 3, unit: 'PKT' }]);
    const lid = W.ids.pkt;
    const pre = await snapReports(SALT2);
    phantomIssue(lid, 2640);
    db.prepare(`UPDATE requisitions SET status = 'fulfilled' WHERE id = ?`).run(W.rid);
    db.prepare(`UPDATE raw_materials SET purchase_unit = 'PKT' WHERE id = ?`).run(SALT2.id);   // the old banner's advice, on the copy
    as(STORE);
    const s0 = stockOf(SALT2);
    const nLedger = ledgerOf(lid).length;
    let r = await issue(W.rid, [{ id: lid, action: 'undo' }]);
    ok(r.status === 200 && near(line(lid).quantity_issued, 0) && near(stockOf(SALT2), s0), 'R2: the undo is accepted and moves nothing', r.body);
    ok(ledgerOf(lid).length === nLedger, 'R2: the undo writes no ledger row (zero delta — the skeptic’s case)', ledgerOf(lid));
    r = await issue(W.rid, [{ id: lid, action: 'issue', quantity: 3 }]);
    ok(r.status === 200 && near(stockOf(SALT2), s0 - 3000), 'R2: a real 3 PKT issue moves 3,000 g', { b: r.body, stock: stockOf(SALT2), s0 });
    const post = await snapReports(SALT2);
    const preTotal = Number(pre.dc.body?.summary?.total_value) || 0;
    ok(near(Number(post.dc.body?.summary?.total_value) - preTotal, 60) && near(Number(post.dc.body?.summary?.total_qty) - (Number(pre.dc.body?.summary?.total_qty) || 0), 3000),
      'R2: Department Consumption counts exactly the real 3 PKT (3,000 g, ₹60), not 0 and not 2,643', post.dc.body?.summary);
    ok((post.dcr.body?.rows || []).length === 1 && near(post.dcr.body?.totals?.total_value, 60), 'R2: the register lists one hand-over worth ₹60', post.dcr.body);
    const ev = (post.sil.body?.events || []).filter((e: any) => e.item_id === lid);
    ok(ev.length === 1 && near(ev[0].qty_purchase, 3), 'R2: the Issued Items Log lists exactly the real 3 PKT', ev);
    ok(rowsFor(post.il, lid, 'ISSUE').some((x: any) => near(x.qty, 3000) && x.stock_moved === true), 'R2: the Issue Log has the real 3,000 g ISSUE row', rowsFor(post.il, lid, 'ISSUE'));
    eq(rowsFor(post.il, lid, 'ISSUE_PRELEDGER').length, 0, 'R2: no pre-ledger row for the line');
  }

  /* ══════════ summary ══════════ */
  if (MODE === 'patched' && BASE_SUMMARY) {
    // The comparison only means "identical to PRODUCTION" when the base tree really behaves as production:
    // its BEFORE checks (the silent close, the false pre-ledger row, the phantom ₹) must all have passed.
    ok(BASE_SUMMARY.fail === 0 && BASE_SUMMARY.pass > 0, 'the base tree behaves as production (every BEFORE check passed there)', BASE_SUMMARY.fails);
  }
  if (designs.size) { console.log('mixed gestures (stale entry beside normal ones) — design found on this tree:'); for (const d of designs) console.log(' - ' + d); }
  const summary = { mode: MODE, tree: WT, copy: dir, pass, fail: fails.length, fails, notes, designs: [...designs] };
  const emit = optOf('--emit') || path.join(dir, `unit-guard-${MODE}-observations.json`);
  fs.writeFileSync(emit, JSON.stringify({ summary, observations: OBS }, null, 1));
  console.log(`\nunit-guard (${MODE}): ${pass} checks passed, ${fails.length} failed — record ${emit}`);
  if (MODE === 'patched' && BASE_OBS) {
    console.log(`  baseline compared against the base run: ${Object.keys(OBS).length} observations`);
    if (BASE_SUMMARY) console.log(`  base run: ${BASE_SUMMARY.pass} passed, ${BASE_SUMMARY.fail} failed${BASE_SUMMARY.fail ? ' — ' + BASE_SUMMARY.fails.join(' | ') : ''}`);
  } else if (MODE === 'patched') {
    console.log('  (no --base-tree / --baseline-file: the Z observations were recorded, not compared with production)');
  }
  if (notes.length) { console.log('notes:'); for (const n of notes) console.log(' - ' + n); }
  if (fails.length) { for (const f of fails) console.log(' - ' + f); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

// A module, not a global script: keeps the names above out of the other test
// scripts' scope under `tsc -p .` (same as routed-requisition-tests.ts).
export {};
