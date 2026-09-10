#!/usr/bin/env node
/**
 * SCHEDULING, EVENT TRIGGERS AND RECIPIENTS — proof, against a copy of the
 * REAL database, with Meta fully stubbed.
 *
 * Run with:  node scripts/wa-report-schedule-tests.js      (also: npm test)
 *
 * SANDBOX CONTRACT (same intent as wa-attachment-tests / report-builder-tests):
 * the live fnb-controller.db, its -wal and its -shm are copied to a fresh
 * tmpdir, the process chdir()s there BEFORE src/lib/db.ts is required, and an
 * abort-hard guard checks the handle really is the copy. The -wal is copied
 * because the newest rows live there until a checkpoint — snapshotting without
 * it reports yesterday's database and calls it today's. (The sibling suites
 * VACUUM the staged files into a single snapshot; this one opens the staged
 * set directly, which SQLite recovers from the wal on open. Same isolation,
 * same freshness.) NOTHING here can touch the live database, and a guard fetch
 * makes an unstubbed network call an immediate failure.
 *
 * WHAT IT PROVES
 *   1  ONE SEND PER DAY. Two ticks, four SIMULTANEOUS ticks, a run killed
 *      mid-flight — exactly one message. The claim is a single atomic upsert
 *      against a partial unique index, so this is a property of the SCHEMA,
 *      not of the order the code happens to run in.
 *   2  a FAILED send does not burn the day; a quiet day does not either;
 *      a killed run unwedges after the stale window.
 *   3  per outlet: two outlets get one send EACH, and a re-tick sends nothing.
 *   4  events fire with the SAME figures the dashboard shows, once per thing.
 *   5  THE BUSINESS ACTION SURVIVES. The real POST /api/purchases,
 *      /api/dine-in/discount-requests/[id]/decide and
 *      /api/crm-calls/bookings/[id] handlers are invoked as Next invokes them,
 *      with the WhatsApp transport injected to FAIL and then to THROW. The
 *      purchase, the decision and the booking are all still written.
 *   6  Send Test reaches the tester and NOBODY else, and does not consume the
 *      day's scheduled send.
 *   7  the guest confirmation goes to the GUEST, refuses a 'pending' booking,
 *      and never copies management in.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const REPO = path.resolve(__dirname, '..');
const LIVE_DB = path.join(REPO, 'fnb-controller.db');
const SRC = path.join(REPO, 'src');

/* -- 0. SNAPSHOT (db + wal + shm) --------------------------------------- */

if (!fs.existsSync(LIVE_DB)) {
  console.error(`wa-report-schedule-tests: ${LIVE_DB} not found — nothing to snapshot.`);
  process.exit(2);
}
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fnb-sched-tests-')));
const SNAP = path.join(TMP, 'fnb-controller.db');
for (const suffix of ['', '-wal', '-shm']) {
  const from = LIVE_DB + suffix;
  if (fs.existsSync(from)) fs.copyFileSync(from, SNAP + suffix);
}
process.chdir(TMP);

/* -- 1. LOADER: TypeScript, '@/' paths, and a stubbed next/headers ------- */

const ts = require(path.join(REPO, 'node_modules', 'typescript'));
const Module = require('module');

/* The session the route handlers will see, set once a real admin row is picked
 * out of the snapshot. This is what makes the REAL handlers callable here. */
const NEXT_HEADERS_STUB = path.join(TMP, '__next_headers_stub.js');
fs.writeFileSync(NEXT_HEADERS_STUB, `
  module.exports = {
    cookies: async () => ({
      get: (n) => (n === 'fnb_session' && global.__SESSION_TOKEN__ ? { value: global.__SESSION_TOKEN__ } : undefined),
    }),
    headers: async () => new Map(),
  };
`);

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'next/headers') return NEXT_HEADERS_STUB;
  if (typeof request === 'string' && request.startsWith('@/')) {
    request = path.join(SRC, request.slice(2));
  }
  return origResolve.call(this, request, ...rest);
};

const compileTs = function (module, filename) {
  const out = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
      esModuleInterop: true, jsx: ts.JsxEmit.React,
    },
    fileName: filename,
  });
  module._compile(out.outputText, filename);
};
require.extensions['.ts'] = compileTs;
require.extensions['.tsx'] = compileTs;

const lib = (rel) => require(path.join(SRC, 'lib', rel));
const apiRoute = (rel) => require(path.join(SRC, 'app', 'api', rel));

const dbMod = lib('db.ts');
const db = dbMod.getDb();

(function assertSandboxed(handle) {
  const open = path.resolve(handle.name || '');
  if (path.resolve(LIVE_DB) === open || !open.startsWith(path.resolve(TMP))) {
    console.error(`\nFATAL: tests opened ${open}, which is not the snapshot in ${TMP}. Aborting.`);
    process.exit(3);
  }
})(db);

const JOBS = lib('wa-report-jobs.ts');
const EV = lib('wa-report-events.ts');
const RCP = lib('wa-report-recipients.ts');
const B = lib('wa-report-builders.ts');
const CS = lib('cost-spikes.ts');
const wa = lib('whatsapp.ts');

/* -- 2. HARNESS --------------------------------------------------------- */

let pass = 0, fail = 0;
const failures = [];
function ok(label) { pass++; console.log(`  ok  ${label}`); }
function bad(label, detail) {
  fail++; failures.push(label);
  console.log(`  XX  ${label}`);
  if (detail) console.log(`      ${detail}`);
}
function expect(actual, expected, label, detail) {
  if (actual === expected) ok(`${label} — ${JSON.stringify(actual)}`);
  else bad(label, detail || `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function expectTrue(cond, label, hint) { cond ? ok(label) : bad(label, hint); }
function section(n, title) { console.log(`\n[${n}] ${title}`); }
function show(label, value) { console.log(`      · ${label}: ${value}`); }

const one = (sql, ...p) => { try { return db.prepare(sql).get(...p); } catch { return undefined; } };
const all = (sql, ...p) => { try { return db.prepare(sql).all(...p); } catch { return []; } };
const set = (k, v) => db.prepare(
  'INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
).run(k, String(v));

/* Every unhandled rejection is a FAILURE here: the whole contract of the event
 * rail is that a detached alert can never take the process down. */
const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(String((e && e.message) || e)));

/* -- 3. THE META STUB --------------------------------------------------- */

const PNID = '111222333444555';
const WABA = '999888777666555';
const TPL = 'akan_daily_report';

wa.setWaConfig('wa_api_provider', 'meta_cloud');
wa.setWaConfig('wa_phone_number_id', PNID);
wa.setWaConfig('wa_business_account_id', WABA);
wa.setWaConfig('wa_access_token', 'EAAtest-access-token');
wa.setWaConfig('wa_notifications_enabled', '1');

let calls = [];
let mediaSeq = 0, wamidSeq = 0;
let sendMode = 'ok';          // ok | fail | throw
const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const stubFetch = async (url, init) => {
  const u = String(url);
  const rec = { url: u, method: (init && init.method) || 'GET', body: init && init.body };
  calls.push(rec);
  if (u.includes('/message_templates')) {
    rec.kind = 'lookup';
    return jsonRes({ data: [{ name: TPL, language: 'en', status: 'APPROVED', components: [
      { type: 'HEADER', format: 'DOCUMENT' }, { type: 'BODY', text: 'Report for {{1}}' },
    ] }] });
  }
  if (u.endsWith('/media')) {
    rec.kind = 'upload';
    return jsonRes({ id: `media.stub.${++mediaSeq}` });
  }
  if (u.endsWith('/messages')) {
    rec.kind = 'send';
    if (sendMode === 'throw') throw new Error('injected transport explosion');
    if (sendMode === 'fail') return jsonRes({ error: { message: 'injected send failure', code: 131047 } }, 400);
    return jsonRes({ messages: [{ id: `wamid.stub.${++wamidSeq}` }] });
  }
  rec.kind = 'unexpected';
  throw new Error(`stub: unexpected URL ${u}`);
};

function reset() { calls = []; sendMode = 'ok'; wa.clearWaTemplateShapeCache(); }
const sends = () => calls.filter((c) => c.kind === 'send');
const sentTo = () => sends().map((c) => JSON.parse(String(c.body)).to);

/* Nothing in this suite may reach the real network. The libraries take an
 * injected fetch; this catches anything that forgets to pass it. */
globalThis.fetch = async (url) => { throw new Error(`UNSTUBBED NETWORK CALL to ${url}`); };
const F = { fetchImpl: stubFetch };

/* -- 4. WHAT THE SNAPSHOT HOLDS ----------------------------------------- */

const IST = "'+330 minutes'";
const OUTLET = B.defaultOutletId(db);
const OUTLET2 = (one('SELECT id FROM outlets WHERE is_default = 0 LIMIT 1') || {}).id || '';

const SALES_DAY = (one(`
  SELECT date(settled_at, ${IST}) AS d, COUNT(*) n FROM orders
   WHERE status='settled' AND date(settled_at, ${IST}) IS NOT NULL
   GROUP BY d ORDER BY n DESC, d DESC LIMIT 1`) || {}).d;

/* How many IST days back SALES_DAY is from today — the offset_days that makes
 * a scheduled run report the busiest real trading day in the snapshot. Computed
 * from the IST calendar day on BOTH sides, because istDateBack() counts IST
 * days and a UTC-based subtraction lands a day out either side of 05:30 IST. */
const SALES_OFFSET = SALES_DAY
  ? Math.round((Date.parse(JOBS.istNow(Date.now()).date + 'T00:00:00Z') - Date.parse(SALES_DAY + 'T00:00:00Z')) / 86400000)
  : 1;

const admin = one("SELECT id, email, name FROM users WHERE role='admin' AND is_active=1 ORDER BY name LIMIT 1");
const confirmedBooking = one(`
  SELECT b.id, g.phone_e164 AS phone, g.name AS gname FROM ct_bookings b JOIN ct_guests g ON g.id = b.guest_id
   WHERE b.is_duplicate=0 AND TRIM(COALESCE(g.phone_e164,''))<>''
     AND lower(b.status) IN ('confirmed','booked','seated','completed')
   ORDER BY b.booking_date DESC LIMIT 1`);
const pendingBooking = one(`
  SELECT b.id FROM ct_bookings b JOIN ct_guests g ON g.id = b.guest_id
   WHERE b.is_duplicate=0 AND TRIM(COALESCE(g.phone_e164,''))<>'' AND lower(b.status)='pending'
   ORDER BY b.booking_date DESC LIMIT 1`);
const discountReq = one('SELECT id FROM discount_requests ORDER BY created_at DESC LIMIT 1');

/* A real admin session, so the ROUTE HANDLERS can be invoked as Next invokes
 * them. Written into the snapshot only. */
if (admin) {
  global.__SESSION_TOKEN__ = 'sched-test-session-token';
  db.prepare('DELETE FROM sessions WHERE token = ?').run(global.__SESSION_TOKEN__);
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(global.__SESSION_TOKEN__, admin.id, new Date(Date.now() + 86400000).toISOString());
}

/* Test numbers, outside any real range. */
const PH = (n) => `9190000008${String(n).padStart(2, '0')}`;

function configure(key, opts = {}) {
  set(`wa_report_${key}_enabled`, opts.enabled === false ? '0' : '1');
  set(`wa_report_${key}_recipients`, (opts.recipients || [PH(1)]).join(','));
  set(`wa_report_${key}_audience`, JSON.stringify(opts.audience || []));
  set(`wa_report_${key}_template`, opts.template === undefined ? TPL : opts.template);
  set(`wa_report_${key}_lang`, 'en');
  set(`wa_report_${key}_time`, opts.time || '00:00');
  set(`wa_report_${key}_offset_days`, String(opts.offset === undefined ? 1 : opts.offset));
  set(`wa_report_${key}_outlets`, JSON.stringify(opts.outlets || []));
}
const clearRuns = (key) => db.prepare('DELETE FROM wa_report_runs WHERE report_key = ?').run(key);
const clearLog = () => db.prepare("DELETE FROM whatsapp_events_log WHERE payload LIKE '%report_%'").run();
const runsOf = (key) => all('SELECT * FROM wa_report_runs WHERE report_key = ? ORDER BY id', key);

/* -- 5. TESTS ----------------------------------------------------------- */

(async () => {
  console.log(`wa-report-schedule-tests — snapshot at ${SNAP}`);
  console.log(`  outlet: ${OUTLET}${OUTLET2 ? ` · second outlet: ${OUTLET2}` : ''}`);
  console.log(`  busiest sales day: ${SALES_DAY} · admin: ${admin ? admin.name : 'none'}`);
  console.log(`  confirmed booking: ${confirmedBooking ? confirmedBooking.id : 'none'} · pending: ${pendingBooking ? pendingBooking.id : 'none'}`);

  /* ═════════ 1. THE SCHEMA IS THE IDEMPOTENCY ═════════ */
  section(1, 'the run ledger exists and its slot index is PARTIAL (scheduler runs only)');
  {
    const t = one("SELECT sql FROM sqlite_master WHERE type='table' AND name='wa_report_runs'");
    expectTrue(!!t, 'wa_report_runs was created by the boot migration');
    const idx = one("SELECT sql FROM sqlite_master WHERE type='index' AND name='ux_wa_report_runs_slot'");
    expectTrue(!!idx, 'the slot index exists');
    expectTrue(!!idx && /WHERE\s+trigger_source\s*=\s*'scheduler'/i.test(idx.sql),
      'and it is PARTIAL — a test or a manual run can never occupy the slot', idx && idx.sql);
    expectTrue(!!idx && /report_key.*outlet_id.*run_date/is.test(idx.sql),
      'keyed on report + outlet + day', idx && idx.sql);

    /* Prove the constraint directly: two scheduler rows for one slot is an error. */
    clearRuns('_probe');
    db.prepare("INSERT INTO wa_report_runs (report_key,outlet_id,run_date,trigger_source) VALUES ('_probe','O','2026-01-01','scheduler')").run();
    let threw = '';
    try {
      db.prepare("INSERT INTO wa_report_runs (report_key,outlet_id,run_date,trigger_source) VALUES ('_probe','O','2026-01-01','scheduler')").run();
    } catch (e) { threw = String(e.message); }
    expectTrue(/UNIQUE/i.test(threw), 'a second scheduler row for the same slot is refused by SQLite itself', threw);

    for (const t2 of ['test', 'manual', 'event', 'test']) {
      db.prepare('INSERT INTO wa_report_runs (report_key,outlet_id,run_date,trigger_source) VALUES (?,?,?,?)')
        .run('_probe', 'O', '2026-01-01', t2);
    }
    expect(all("SELECT id FROM wa_report_runs WHERE report_key='_probe'").length, 5,
      'while 4 ad-hoc rows sit happily beside the one scheduled row');
    clearRuns('_probe');
  }

  /* ═════════ 2. RECIPIENTS ═════════ */
  section(2, 'recipients resolve from REAL users, and the unreachable are named');
  {
    const users = all('SELECT id,name,role,is_head_chef,department_id FROM users WHERE is_active=1');
    const mgmtUsers = users.filter(u => u.role === 'admin' || u.role === 'manager' || u.is_head_chef === 1);
    const opts = RCP.audienceOptions(db);
    expect(opts.groups.find(g => g.token === 'mgmt').count, mgmtUsers.length,
      'the "management" group counts admins, managers and HODs');
    show('management', mgmtUsers.map(u => u.name).join(', '));

    /* Nobody has a number yet, so EVERY one of them is unreachable — named. */
    const cold = RCP.resolveRecipients(db, { audience: ['mgmt'], manual: [] });
    expect(cold.recipients.length, 0, 'with no numbers on file, nobody resolves');
    expect(cold.unreachable.length, mgmtUsers.length, 'and every one is listed as unreachable, by name');
    show('unreachable', cold.unreachable.map(u => u.name).join(' | '));

    db.prepare('UPDATE users SET wa_mobile = ? WHERE id = ?').run(PH(11), mgmtUsers[0].id);
    db.prepare('UPDATE users SET wa_mobile = ? WHERE id = ?').run(PH(12), mgmtUsers[1].id);
    const warm = RCP.resolveRecipients(db, { audience: ['mgmt'], manual: [] });
    expect(warm.recipients.length, 2, 'the two with numbers now resolve');
    expect(warm.unreachable.length, mgmtUsers.length - 2, 'and the rest are still shown as unreachable');
    expect(warm.recipients[0].source, 'wa_mobile', 'the number came from the login');
    show('resolved', warm.recipients.map(r => `${r.label} → ${r.number}`).join(' | '));

    const barDept = one("SELECT id,name FROM departments WHERE is_active=1 AND lower(name) LIKE '%bar%' LIMIT 1");
    if (barDept) {
      const heads = RCP.hodsOfDepartment(db, barDept.id);
      show(`HOD of ${barDept.name}`, heads.map(h => h.name).join(', ') || '(nobody senior in that department)');
      const juniors = all("SELECT id FROM users WHERE department_id=? AND is_active=1 AND role='staff' AND is_head_chef=0", barDept.id);
      expect(heads.filter(h => juniors.some(j => j.id === h.id)).length, 0,
        'a department HOD never resolves to a junior in that department — a stock variance is not for a commis');
    }

    const dup = RCP.resolveRecipients(db, {
      audience: ['mgmt', 'admin', `user:${mgmtUsers[0].id}`], manual: [PH(11), PH(99)],
    });
    expect(new Set(dup.numbers).size, dup.numbers.length, 'a person reachable through several groups is listed once');
    expectTrue(dup.numbers.includes(wa.normalizeWaNumber(PH(99))), 'and a manual number rides alongside');

    const junk = RCP.resolveRecipients(db, { audience: ['everyone', 'hod:no-such-dept'], manual: [] });
    expect(junk.recipients.length, 0, 'an unknown group resolves to nobody');
    expect(junk.emptyTokens.length, 2, 'and both bad tokens are reported back, never treated as "everyone"');
    show('empty tokens', junk.emptyTokens.join(', '));

    const many = Array.from({ length: RCP.MAX_REPORT_RECIPIENTS + 5 }, (_, i) => PH(20 + i));
    const capped = RCP.resolveRecipients(db, { audience: [], manual: many });
    expect(capped.recipients.length, RCP.MAX_REPORT_RECIPIENTS, 'the recipient list is capped');
    expect(capped.capped, true, 'and says so, rather than silently truncating');
  }

  /* ═════════ 3. TIME ═════════ */
  section(3, 'the send time is IST, and a bad one falls back rather than going silent');
  {
    expect(JOBS.parseHhMm('08:00'), 480, 'parseHhMm reads a time of day');
    expect(JOBS.parseHhMm('24:00'), null, 'and refuses one that does not exist');
    expect(JOBS.parseHhMm('8:5'), null, 'and refuses a malformed one');
    expect(JOBS.hhmm(480), '08:00', 'and round-trips');

    expect(JOBS.istNow(Date.parse('2026-09-09T19:00:00Z')).date, '2026-09-10',
      'the IST day rolls at 18:30 UTC, not at midnight UTC');
    expect(JOBS.istNow(Date.parse('2026-09-09T23:45:00Z')).minutes, 5 * 60 + 15, 'and the IST clock is +5:30');

    /* THE BUG THE IST SLOT EXISTS TO PREVENT. */
    const fiveAm = Date.parse('2026-09-09T23:30:00Z');   // 05:00 IST on the 10th
    const sixAm = Date.parse('2026-09-10T00:30:00Z');    // 06:00 IST on the 10th
    expect(new Date(fiveAm).toISOString().slice(0, 10) === new Date(sixAm).toISOString().slice(0, 10), false,
      'a 05:00 and a 06:00 IST send fall on DIFFERENT UTC days');
    expect(JOBS.istNow(fiveAm).date, JOBS.istNow(sixAm).date,
      'but on the SAME IST day — which is what the slot is keyed on');

    configure('daily_ops', { time: 'not a time' });
    expect(JOBS.reportConfig(db, 'daily_ops').time, JOBS.DEFAULT_REPORT_TIME,
      'an unreadable time falls back to the default, so a typo does not silence a report');
  }

  /* ═════════ 4. THE DOUBLE TICK ═════════ */
  section(4, 'TWO TICKS, ONE SEND — and four simultaneous ticks, still one send');
  if (!SALES_DAY) { bad('no settled sales day in the snapshot — cannot prove a real send'); }
  else {
    reset(); clearRuns('daily_ops'); clearLog();
    configure('daily_ops', { time: '00:00', recipients: [PH(1), PH(2)] });
    set('wa_report_daily_ops_offset_days', String(SALES_OFFSET));
    const nowMs = Date.now();

    const first = await JOBS.runWaReportJobs(db, { nowMs, fetchImpl: stubFetch });
    show('tick 1', JSON.stringify(first.daily_ops));
    const second = await JOBS.runWaReportJobs(db, { nowMs, fetchImpl: stubFetch });
    show('tick 2', JSON.stringify(second.daily_ops));

    expect(first.daily_ops.status, 'sent', 'the first tick sends');
    expect(second.daily_ops.status, 'already_sent_today', 'the second tick stands down');
    expect(sends().length, 2, 'exactly two messages left the building — one per recipient, not four');
    expect(new Set(sentTo()).size, 2, 'to the two configured numbers');
    expect(calls.filter(c => c.kind === 'upload').length, 1, 'and the PDF was uploaded ONCE, reused for both');

    const rows = runsOf('daily_ops');
    expect(rows.length, 1, 'ONE ledger row for the day, not two');
    expect(rows[0].status, 'sent', 'recorded as sent');
    expect(rows[0].sent_count, 2, 'with the number of recipients it reached');
    expect(rows[0].trigger_source, 'scheduler', 'stamped as a scheduler run');
    expectTrue(!!rows[0].file_id, 'and linked to the exact PDF file that went out');
    expect(JSON.parse(rows[0].recipients).length, 2, 'and the numbers it was sent to are recorded');
    show('ledger', `slot ${rows[0].run_date} · ${rows[0].status} · figures for ${rows[0].period} · file ${rows[0].file_id}`);

    /* FOUR AT ONCE — the restart-racing-the-cron case. */
    reset(); clearRuns('daily_ops'); clearLog();
    const race = await Promise.all([
      JOBS.runWaReportJobs(db, { nowMs, fetchImpl: stubFetch }),
      JOBS.runWaReportJobs(db, { nowMs, fetchImpl: stubFetch }),
      JOBS.runWaReportJobs(db, { nowMs, fetchImpl: stubFetch }),
      JOBS.runWaReportJobs(db, { nowMs, fetchImpl: stubFetch }),
    ]);
    expect(race.filter(r => r.daily_ops.status === 'sent').length, 1, 'of four simultaneous ticks, exactly ONE sent');
    expect(race.filter(r => r.daily_ops.status === 'already_sent_today').length, 3, 'and three stood down');
    expect(sends().length, 2, 'two messages in total — one per recipient, once');
    expect(runsOf('daily_ops').length, 1, 'and one ledger row');
  }

  /* ═════════ 5. NOT DUE ═════════ */
  section(5, 'a report does not go early');
  {
    reset(); clearRuns('daily_ops'); clearLog();
    const nowMs = Date.parse('2026-09-10T02:30:00Z');          // 08:00 IST
    configure('daily_ops', { time: '23:30' });
    const r = await JOBS.runWaReportJobs(db, { nowMs, fetchImpl: stubFetch });
    expect(r.daily_ops.status, 'not_due', 'before its time, the report is not due');
    expect(sends().length, 0, 'and nothing was sent');
    expect(runsOf('daily_ops').length, 0, 'and no slot was claimed — the 23:30 send is still to come');
    show('reason', r.daily_ops.detail);

    configure('daily_ops', { time: '07:00' });
    const r2 = await JOBS.runWaReportJobs(db, { nowMs, fetchImpl: stubFetch });
    expectTrue(r2.daily_ops.status !== 'not_due',
      'at 08:00 IST a 07:00 report IS due — it catches up after downtime rather than being skipped');
    show('catch-up', JSON.stringify(r2.daily_ops.status));
  }

  /* ═════════ 6. FAILURE DOES NOT BURN THE DAY ═════════ */
  section(6, 'a failed send is retried; a quiet day is retried; a killed run unwedges');
  if (SALES_DAY) {
    const offset = String(SALES_OFFSET);
    reset(); clearRuns('daily_ops'); clearLog();
    configure('daily_ops', { time: '00:00', recipients: [PH(1)] });
    set('wa_report_daily_ops_offset_days', offset);
    const nowMs = Date.now();

    sendMode = 'fail';
    const failed = await JOBS.runWaReportJobs(db, { nowMs, fetchImpl: stubFetch });
    expect(failed.daily_ops.status, 'refused', 'a send Meta rejects is reported as refused');
    expect(runsOf('daily_ops')[0].status, 'failed', 'and the ledger row says failed');
    show('detail', failed.daily_ops.detail);

    sendMode = 'ok';
    const retried = await JOBS.runWaReportJobs(db, { nowMs, fetchImpl: stubFetch });
    expect(retried.daily_ops.status, 'sent', 'the very next tick retries it — a failure never burns the day');
    expect(runsOf('daily_ops').length, 1, 'and it re-used the same slot row rather than making a second');
    expect(runsOf('daily_ops')[0].attempts, 2, 'with the attempt counted');

    /* A quiet day must not lock the report out either. */
    reset(); clearRuns('daily_ops'); clearLog();
    set('wa_report_daily_ops_offset_days', '9999');       // a day with certainly no trade
    const quiet = await JOBS.runWaReportJobs(db, { nowMs, fetchImpl: stubFetch });
    expect(quiet.daily_ops.status, 'nothing_to_report', 'a day with no trade sends nothing');
    expect(sends().length, 0, 'literally nothing — not a blank PDF, not a "no data" template');
    expect(runsOf('daily_ops')[0].status, 'nothing_to_report', 'and the ledger says why');
    show('reason', quiet.daily_ops.detail);

    set('wa_report_daily_ops_offset_days', offset);
    const later = await JOBS.runWaReportJobs(db, { nowMs, fetchImpl: stubFetch });
    expect(later.daily_ops.status, 'sent',
      'and when the figures arrive later the same day, the report still goes — a quiet 08:00 does not lock out an 11:00 count');

    /* A process killed mid-send leaves a 'running' row. It must unwedge. */
    clearRuns('daily_ops');
    const runDate = JOBS.istNow(nowMs).date;
    db.prepare(`INSERT INTO wa_report_runs (report_key,outlet_id,run_date,status,trigger_source,claimed_at)
                VALUES ('daily_ops',?,?,'running','scheduler',datetime('now'))`).run(String(OUTLET || ''), runDate);
    expect(JOBS.claimRun(db, { key: 'daily_ops', outletId: String(OUTLET || ''), runDate }), null,
      'a FRESH running claim is respected — a second tick will not steal a send in flight');
    db.prepare("UPDATE wa_report_runs SET claimed_at = datetime('now','-30 minutes') WHERE report_key='daily_ops'").run();
    expectTrue(JOBS.claimRun(db, { key: 'daily_ops', outletId: String(OUTLET || ''), runDate }) != null,
      'but a STALE one is re-claimable — a killed process does not wedge the report until midnight');
  }

  /* ═════════ 7. PER OUTLET ═════════ */
  section(7, 'once per day PER OUTLET');
  if (!OUTLET2 || !SALES_DAY) { show('skipped', 'this snapshot has only one outlet'); }
  else {
    reset(); clearRuns('daily_ops'); clearLog();
    configure('daily_ops', { time: '00:00', recipients: [PH(1)], outlets: [String(OUTLET), String(OUTLET2)] });
    set('wa_report_daily_ops_offset_days', String(SALES_OFFSET));
    const nowMs = Date.now();

    const r1 = await JOBS.runWaReportJobs(db, { nowMs, fetchImpl: stubFetch });
    show('two outlets', JSON.stringify(r1.daily_ops));
    const rows = runsOf('daily_ops');
    expect(rows.length, 2, 'one ledger row per outlet');
    expect(new Set(rows.map(r => r.outlet_id)).size, 2, 'and they are different outlets');
    show('rows', rows.map(r => `${r.outlet_id || 'default'}=${r.status}`).join(' | '));

    /* THE DEFECT THESE ASSERTIONS EXIST FOR. The "already sent today?" backstop
     * used to match on report_key ALONE, so outlet 1's successful send made
     * every other outlet look already-sent: branch two never got its own
     * report, and its ledger row said 'sent' about a send that never happened.
     *
     * On this snapshot all the real trade belongs to the default outlet, so the
     * honest verdict for branch two is "nothing to report" — and that is the
     * point: it reached its own BUILDER and formed its own answer, instead of
     * being waved off by the first outlet's send. */
    const byOutlet = Object.fromEntries(rows.map(r => [r.outlet_id, r.status]));
    expect(byOutlet[String(OUTLET)], 'sent', 'the outlet with trade sent');
    expectTrue(byOutlet[String(OUTLET2)] !== 'skipped',
      'and the second outlet was NOT waved off as already-sent — it got its own verdict',
      JSON.stringify(byOutlet));
    show('verdicts', Object.entries(byOutlet).map(([o, st]) => `${o.slice(0, 8)}=${st}`).join(' | '));
    expectTrue(rows.every(r => r.sent_count === 0 || r.status === 'sent'),
      'and no ledger row claims a delivery it did not make');

    /* The backstop itself, asked directly — this is the exact bug, pinned. */
    expect(JOBS.reportSentToday(db, 'daily_ops', String(OUTLET)), true,
      'the send log says the FIRST outlet has had its report today');
    expect(JOBS.reportSentToday(db, 'daily_ops', String(OUTLET2)), false,
      'and says the SECOND outlet has NOT — the question is asked per outlet');
    expect(JOBS.reportSentToday(db, 'daily_ops'), true,
      'asked without an outlet it still answers for the report as a whole (the single-outlet reading)');

    /* A delivery logged with NO outlet at all — a row written before the outlet
     * was stamped on the log — counts for EVERY outlet. Otherwise an install
     * upgraded halfway through a morning re-sends the report it sent an hour
     * earlier. */
    db.prepare("INSERT INTO whatsapp_events_log (kind, payload) VALUES ('send_attempt', ?)")
      .run(JSON.stringify({ event: 'report_attachment', report_key: 'crm_daily', to: '91900', ok: true }));
    expect(JOBS.reportSentToday(db, 'crm_daily', String(OUTLET2)), true,
      'an UNLABELLED delivery counts for every outlet — history is forgiven, never re-sent');
    db.prepare("DELETE FROM whatsapp_events_log WHERE payload LIKE '%crm_daily%'").run();

    const before = sends().length;
    const r2 = await JOBS.runWaReportJobs(db, { nowMs, fetchImpl: stubFetch });
    expect(sends().length, before, 'a second tick sends nothing more for either outlet');
    expect(runsOf('daily_ops').length, 2, 'and adds no ledger rows');
    show('second tick', JSON.stringify(r2.daily_ops.status));
    configure('daily_ops', { time: '00:00', recipients: [PH(1)] });
  }

  /* ═════════ 7b. ARMED FOR TOMORROW ═════════ */
  section('7b', 'switching a report on AFTER its send time arms it for tomorrow, not for one minute later');
  if (SALES_DAY) {
    reset(); clearRuns('daily_ops'); clearLog();
    configure('daily_ops', { time: '00:00', recipients: [PH(1)] });
    set('wa_report_daily_ops_offset_days', String(SALES_OFFSET));
    const nowMs = Date.now();
    const runDate = JOBS.istNow(nowMs).date;

    /* This is exactly what the config route does on a save that enables a
     * report whose time has already passed today. */
    JOBS.skipTodaysSlot(db, {
      key: 'daily_ops', outletId: String(OUTLET || ''), runDate,
      detail: 'Enabled at 16:00 IST, after today\'s 08:00 send time — first send is tomorrow.',
    });
    const rows = runsOf('daily_ops');
    expect(rows.length, 1, 'today\'s slot is taken by a "skipped" row');
    expect(rows[0].status, 'skipped', 'marked skipped, with the reason on it');
    show('reason', rows[0].detail);

    const tick = await JOBS.runWaReportJobs(db, { nowMs, fetchImpl: stubFetch });
    expect(tick.daily_ops.status, 'already_sent_today', 'and the very next tick does NOT fire it');
    expect(sends().length, 0, 'nothing was sent — the admin was still typing when they saved');
    expect(runsOf('daily_ops')[0].status, 'skipped', 'and the slot stays skipped rather than being re-claimed');

    /* Tomorrow is a different slot, so it fires then. */
    const tomorrow = nowMs + 86_400_000;
    const t2 = await JOBS.runWaReportJobs(db, { nowMs: tomorrow, fetchImpl: stubFetch });
    expectTrue(t2.daily_ops.status !== 'already_sent_today',
      `tomorrow is a different slot, so the report does fire then — ${t2.daily_ops.status}`);
  }

  /* ═════════ 8. SEND TEST ═════════ */
  section(8, 'a test reaches the tester and NOBODY else, and does not consume the day');
  if (!SALES_DAY) { bad('no sales day — cannot test-send a real report'); }
  else {
    reset(); clearRuns('daily_ops'); clearLog();
    configure('daily_ops', { time: '00:00', recipients: [PH(1), PH(2), PH(3)] });
    const TESTER = wa.normalizeWaNumber(PH(77));

    const t = await JOBS.runReportJob(db, 'daily_ops', {
      trigger: 'test', actor: 'test:owner@example.com',
      recipientsOverride: [TESTER], date: SALES_DAY, fetchImpl: stubFetch,
    });
    expect(t.status, 'sent', 'the test sends');
    expect(sends().length, 1, 'ONE message');
    expect(sentTo()[0], TESTER, 'to the tester');
    expect(sentTo().includes(wa.normalizeWaNumber(PH(1))), false, 'and to none of the three configured recipients');

    const rows = runsOf('daily_ops');
    expect(rows.length, 1, 'the test is recorded');
    expect(rows[0].trigger_source, 'test', 'as a TEST');
    expect(rows[0].actor, 'test:owner@example.com', 'naming who pressed it');

    /* And the real schedule still fires afterwards.
     *
     * THE SEND LOG IS DELIBERATELY LEFT ALONE HERE. It used to be cleared on
     * this line, which is what made this assertion worthless: the test's own
     * ok:true row was the thing that cancelled the day's real send, and wiping
     * it hid exactly the bug the assertion claims to disprove. Every row now
     * carries trigger_source, and reportSentToday() ignores 'test' rows — so
     * this passes with the evidence still in the table. */
    const logged = all(
      "SELECT payload FROM whatsapp_events_log WHERE kind='send_attempt' AND payload LIKE '%\"report_key\":\"daily_ops\"%' AND payload LIKE '%\"ok\":true%'",
    );
    expectTrue(logged.length > 0 && logged.every(r => /"trigger_source":"test"/.test(r.payload)),
      'the test send IS in the send log, stamped as a test', JSON.stringify(logged.map(r => r.payload.slice(0, 120))));
    expect(JOBS.reportSentToday(db, 'daily_ops', String(OUTLET || '')), false,
      'and the "already delivered today?" backstop does not count it');

    const real = await JOBS.runReportJob(db, 'daily_ops', { trigger: 'scheduler', date: SALES_DAY, fetchImpl: stubFetch });
    expect(real.status, 'sent', 'the real scheduled send still happens — a test never consumes the slot');
    expect(new Set(sentTo()).size, 4, 'and it reached the three real recipients as well as the tester');
    show('all recipients', Array.from(new Set(sentTo())).join(', '));

    /* …while a REAL send does still stand the schedule down. */
    expect(JOBS.reportSentToday(db, 'daily_ops', String(OUTLET || '')), true,
      'a real send DOES satisfy the backstop — the fix narrows it, it does not disable it');
  }

  /* ═════════ 9. A MANUAL RUN DOES NOT DOUBLE-SEND ═════════ */
  section(9, 'an admin "run now" is caught by the send log, so the schedule stands down');
  if (SALES_DAY) {
    reset(); clearRuns('daily_ops'); clearLog();
    configure('daily_ops', { time: '00:00', recipients: [PH(1)] });

    const manual = await JOBS.runReportJob(db, 'daily_ops', {
      trigger: 'manual', actor: 'owner@example.com', date: SALES_DAY, fetchImpl: stubFetch,
    });
    expect(manual.status, 'sent', 'the manual run sends');
    expect(runsOf('daily_ops')[0].trigger_source, 'manual', 'recorded as manual — it does not claim the slot');

    const before = sends().length;
    const tick = await JOBS.runWaReportJobs(db, { nowMs: Date.now(), fetchImpl: stubFetch });
    expect(tick.daily_ops.status, 'already_sent_today',
      'and the scheduled tick then stands down, because the send LOG says it already went');
    expect(sends().length, before, 'nothing was sent twice');
  }

  /* ═════════ 10. EVENT: PRICE HIKE ═════════ */
  section(10, 'the price-hike alert carries the dashboard’s own figures, once per bill');
  {
    reset(); clearRuns('price_hike'); clearLog();

    const spikes = CS.costSpikes(db, { thresholdPct: B.priceHikeThreshold(db), minPurchases: 2, limit: 50 });
    if (!spikes.spikes.length) { show('skipped', 'no material on this install is over its threshold'); }
    else {
      const top = spikes.spikes[0];
      show('top spike', `${top.name}: avg ${top.avg_price} → latest ${top.latest_price} (+${Number(top.pct_change).toFixed(2)}%) from ${top.latest_vendor}`);

      set('wa_report_price_hike_enabled', '0');
      const disabled = await EV.firePriceHikeAlert(db, { materialIds: [String(top.id)], sourceId: 'p1' }, F);
      expect(disabled.status, 'disabled', 'switched off, it says so and sends nothing');
      expect(sends().length, 0, 'nothing on the wire');

      configure('price_hike', { time: '00:00', recipients: [PH(5)] });
      const fired = await EV.firePriceHikeAlert(db, { materialIds: [String(top.id)], sourceId: 'purchase-abc' }, F);
      expect(fired.status, 'sent', 'switched on, the alert goes');
      expect(sends().length, 1, 'to the one configured recipient');

      /* The figures in the message are the dashboard's, not a second opinion. */
      const built = await B.buildPriceHikeAlert(db, { materialIds: [String(top.id)] });
      expect(built.vars.material, top.name, 'the material named is the one costSpikes named');
      expect(built.vars.pct, `${Number(top.pct_change).toFixed(2)}%`, 'the percentage is costSpikes’ own');
      show('message', built.text.split('\n')[0]);
      show('rate line', `${built.vars.old_rate} → ${built.vars.new_rate} · ${built.vars.vendor}`);

      const again = await EV.firePriceHikeAlert(db, { materialIds: [String(top.id)], sourceId: 'purchase-abc' }, F);
      expect(again.status, 'already_sent', 'a retried save of the SAME bill does not alert twice');
      expect(sends().length, 1, 'and nothing more was sent');

      const other = await EV.firePriceHikeAlert(db, { materialIds: [String(top.id)], sourceId: 'purchase-xyz' }, F);
      expect(other.status, 'sent', 'but a DIFFERENT bill for the same item does alert — it is a new purchase');
    }

    const none = await EV.firePriceHikeAlert(db, { materialIds: [], sourceId: 'empty' }, F);
    expect(none.status, 'nothing_to_report', 'a bill touching no material has nothing to say');
  }

  /* ═════════ 11. EVENT: DISCOUNT ═════════ */
  section(11, 'the discount alert carries the queue’s own impact figure');
  if (!discountReq) { show('skipped', 'no discount request in the snapshot'); }
  else {
    reset(); clearRuns('discount_alert'); clearLog();
    configure('discount_alert', { time: '00:00', recipients: [PH(6)] });
    const r = await EV.fireDiscountAlert(db, { requestId: discountReq.id }, F);
    expect(r.status, 'sent', 'the alert goes');
    expect(sends().length, 1, 'one message');
    const body = JSON.parse(String(sends()[0].body));
    expect(body.type, 'template', 'as a template — it delivers outside the 24h window');
    expectTrue(!(body.template.components || []).some(c => c.type === 'header'),
      'with NO document header — an alert about one bill is a sentence, not an attachment');
    const built = await B.buildDiscountAlert(db, { requestId: discountReq.id });
    show('message', built.text.split('\n')[0]);
    show('impact', String(built.vars.amount));
    const again = await EV.fireDiscountAlert(db, { requestId: discountReq.id }, F);
    expect(again.status, 'already_sent', 'and a second decision event for the same request does not re-alert');
  }

  /* ═════════ 12. EVENT: THE GUEST CONFIRMATION ═════════ */
  section(12, 'the reservation confirmation goes to the GUEST — never to management');
  if (!confirmedBooking) { show('skipped', 'no confirmed booking with a phone number'); }
  else {
    reset(); clearRuns('reservation_confirmation'); clearLog();
    /* Configured with a STAFF audience ON PURPOSE: the guest-facing alert must
     * ignore it entirely. */
    configure('reservation_confirmation', { time: '00:00', recipients: [PH(1), PH(2)], audience: ['mgmt'] });

    const r = await EV.fireReservationConfirmation(db, { bookingId: confirmedBooking.id }, F);
    expect(r.status, 'sent', 'the confirmation goes');
    expect(sends().length, 1, 'to exactly ONE number');
    expect(sentTo()[0], wa.normalizeWaNumber(confirmedBooking.phone), 'the guest’s own');
    expect(sentTo().includes(wa.normalizeWaNumber(PH(1))), false,
      'and management is NOT copied in, even though a staff audience is configured');

    expect(B.reportDef('reservation_confirmation').templateCategory, 'UTILITY',
      'the registry demands a UTILITY template — never MARKETING for a guest');
    expect(B.reportDef('reservation_confirmation').audience, 'guest', 'and marks it guest-facing');

    const built = await B.buildReservationConfirmation(db, { bookingId: confirmedBooking.id });
    show('to guest', built.text.split('\n')[0]);
    show('fields', `${built.vars.date} ${built.vars.time} · party ${built.vars.party_size} · ref ${built.vars.reference}`);
    expect(built.pdf, null, 'a guest gets a sentence, not an attachment');

    const again = await EV.fireReservationConfirmation(db, { bookingId: confirmedBooking.id }, F);
    expect(again.status, 'already_sent',
      'and toggling confirmed → pending → confirmed cannot send a second "your table is confirmed"');

    if (pendingBooking) {
      const p = await EV.fireReservationConfirmation(db, { bookingId: pendingBooking.id }, F);
      expect(p.status, 'nothing_to_report', 'a booking still at the DEFAULT "pending" is refused');
      show('refusal', p.detail);
      expect(sends().length, 1, 'and nothing was sent for it');
    }
  }

  /* ═════════ 13. THE BUSINESS ACTION SURVIVES ═════════ */
  section(13, 'INJECTED SEND FAILURE — the purchase, the decision and the booking all still complete');
  if (!admin) { bad('no admin user in the snapshot — cannot invoke the route handlers'); }
  else {
    /* --- 13a. A REAL POST /api/purchases, with WhatsApp broken --- */
    const mat = one(`
      SELECT rm.id, rm.name, rm.current_stock FROM raw_materials rm
       JOIN purchases p ON p.material_id = rm.id
       WHERE COALESCE(rm.is_active,1)=1
       GROUP BY rm.id HAVING COUNT(p.id) > 1 ORDER BY COUNT(p.id) DESC LIMIT 1`);
    if (!mat) { show('skipped', 'no purchased material to bill'); }
    else {
      const purchasesRoute = apiRoute('purchases/route.ts');
      configure('price_hike', { time: '00:00', recipients: [PH(5)] });
      show('material', `${mat.name} (stock ${mat.current_stock})`);

      for (const mode of ['fail', 'throw']) {
        reset(); clearRuns('price_hike'); clearLog();
        sendMode = mode;
        /* The route uses the app's real global fetch, so break THAT one — the
         * point of this test is a broken transport in the live path, not a
         * transport mocked out of the path. */
        const savedFetch = globalThis.fetch;
        globalThis.fetch = stubFetch;

        const before = one('SELECT COUNT(*) n FROM purchases').n;
        const stockBefore = Number(one('SELECT current_stock FROM raw_materials WHERE id = ?', mat.id).current_stock);

        const res = await purchasesRoute.POST(new Request('http://localhost/api/purchases', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            material_id: mat.id, vendor: 'ZZ Schedule Test Vendor', quantity: 3,
            unit_price: 99999, date: new Date().toISOString().slice(0, 10),
            notes: `wa-report-schedule-tests ${mode}`,
          }),
        }));
        const json = await res.json();

        /* Let the DETACHED alert actually run and fail. */
        await new Promise(r => setTimeout(r, 80));
        globalThis.fetch = savedFetch;

        expect(res.status, 201, `[transport ${mode}] the purchase is still CREATED (HTTP 201)`,
          JSON.stringify(json).slice(0, 300));
        expectTrue(!!json.purchase && !!json.purchase.id, `[transport ${mode}] and the row came back`);
        expect(one('SELECT COUNT(*) n FROM purchases').n, before + 1,
          `[transport ${mode}] the purchases table grew by exactly one`);
        const stored = one('SELECT * FROM purchases WHERE id = ?', json.purchase.id);
        expect(Number(stored.unit_price), 99999, `[transport ${mode}] at the rate that was billed`);
        expectTrue(Number(one('SELECT current_stock FROM raw_materials WHERE id = ?', mat.id).current_stock) > stockBefore,
          `[transport ${mode}] and stock moved — the business effect happened in full`);
        expect(unhandled.length, 0, `[transport ${mode}] and no unhandled rejection escaped the detached alert`,
          unhandled.join(' | '));

        /* A purchase LINE no longer alerts. It queues its BILL — one row,
         * whatever the transport is doing — and the flush is what sends. */
        const queued = runsOf('price_hike');
        expectTrue(queued.length === 1 && queued[0].status === 'pending',
          `[transport ${mode}] the line queued its BILL instead of alerting per line`,
          JSON.stringify(queued.map(r => `${r.status}:${r.period}`)));
        expect(sends().length, 0,
          `[transport ${mode}] and the purchase request itself put nothing on the wire`);

        /* Now flush, with the transport still broken. */
        const flushed = await EV.flushPriceHikeAlerts(db, { quietMs: 0, fetchImpl: stubFetch });
        const runs = runsOf('price_hike');
        if (runs.length) {
          expectTrue(['failed', 'refused', 'error', 'running', 'daily_cap_reached'].includes(runs[0].status),
            `[transport ${mode}] the ALERT is what failed, and it is recorded as such — ${runs[0].status}`);
        } else {
          ok(`[transport ${mode}] the alert had nothing over threshold to say, and said nothing`
            + ` (${flushed.map(f => f.status).join(',') || 'nothing due'})`);
        }
        expect(unhandled.length, 0, `[transport ${mode}] and the flush raised nothing either`, unhandled.join(' | '));
      }
      sendMode = 'ok';
    }

    /* --- 13b. A REAL discount decision, with WhatsApp throwing --- */
    const anyOrder = one("SELECT id, order_number, subtotal FROM orders ORDER BY created_at DESC LIMIT 1");
    if (!anyOrder) { show('skipped', 'no order to discount'); }
    else {
      db.prepare("UPDATE orders SET status='open' WHERE id = ?").run(anyOrder.id);
      const reqId = 'zz-sched-test-discount';
      db.prepare('DELETE FROM discount_requests WHERE id = ?').run(reqId);
      const cols = db.prepare('PRAGMA table_info(discount_requests)').all().map(c => c.name);
      const has = (c) => cols.includes(c);
      db.prepare(
        `INSERT INTO discount_requests (id, order_id, requested_pct, status, requested_by${has('kind') ? ', kind' : ''}${has('reason') ? ', reason' : ''}, created_at)
         VALUES (?, ?, 10, 'pending', ?${has('kind') ? ", 'discount'" : ''}${has('reason') ? ", 'schedule test'" : ''}, datetime('now'))`,
      ).run(reqId, anyOrder.id, admin.email);

      reset(); clearRuns('discount_alert'); clearLog();
      sendMode = 'throw';
      const savedFetch = globalThis.fetch;
      globalThis.fetch = stubFetch;
      configure('discount_alert', { time: '00:00', recipients: [PH(6)] });

      const decideRoute = apiRoute('dine-in/discount-requests/[id]/decide/route.ts');
      const res = await decideRoute.POST(
        new Request('http://localhost/x', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approve: true, note: 'schedule test' }),
        }),
        { params: Promise.resolve({ id: reqId }) },
      );
      const json = await res.json();
      await new Promise(r => setTimeout(r, 80));
      globalThis.fetch = savedFetch;
      sendMode = 'ok';

      expect(res.status, 200, 'the discount DECISION still succeeds while WhatsApp is throwing',
        JSON.stringify(json).slice(0, 300));
      expect(one('SELECT status FROM discount_requests WHERE id = ?', reqId).status, 'approved',
        'and the request is recorded as approved');
      expect(Number(one('SELECT discount_pct FROM orders WHERE id = ?', anyOrder.id).discount_pct), 10,
        'and the discount was applied to the bill');
      expect(unhandled.length, 0, 'no unhandled rejection escaped', unhandled.join(' | '));
    }

    /* --- 13c. A REAL booking confirmation, broken then working --- */
    if (!pendingBooking) { show('skipped', 'no pending booking to confirm'); }
    else {
      const bookingRoute = apiRoute('crm-calls/bookings/[id]/route.ts');
      const confirmVia = async (body) => {
        const savedFetch = globalThis.fetch;
        globalThis.fetch = stubFetch;
        const res = await bookingRoute.PUT(
          new Request('http://localhost/x', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          }),
          { params: Promise.resolve({ id: pendingBooking.id }) },
        );
        const json = await res.json();
        await new Promise(r => setTimeout(r, 120));
        globalThis.fetch = savedFetch;
        return { res, json };
      };

      reset(); clearRuns('reservation_confirmation'); clearLog();
      sendMode = 'throw';
      configure('reservation_confirmation', { time: '00:00' });
      const broken = await confirmVia({ status: 'confirmed' });
      sendMode = 'ok';

      expect(broken.res.status, 200, 'the BOOKING still confirms while WhatsApp is throwing');
      expect(one('SELECT status FROM ct_bookings WHERE id = ?', pendingBooking.id).status, 'confirmed',
        'and the status is written');
      expectTrue(!!broken.json.booking, 'and the route answered with the booking');
      expect(unhandled.length, 0, 'no unhandled rejection escaped', unhandled.join(' | '));

      /* …and with the transport WORKING, the same route reaches the guest. */
      reset(); clearRuns('reservation_confirmation'); clearLog();
      db.prepare("UPDATE ct_bookings SET status='pending' WHERE id = ?").run(pendingBooking.id);
      await confirmVia({ status: 'confirmed' });
      const guestPhone = (one(
        'SELECT g.phone_e164 p FROM ct_bookings b JOIN ct_guests g ON g.id=b.guest_id WHERE b.id=?',
        pendingBooking.id,
      ) || {}).p;
      expect(sends().length, 1, 'confirming a booking through the REAL route sends exactly one message');
      expect(sentTo()[0], wa.normalizeWaNumber(guestPhone), 'to the guest on that booking');

      const before = sends().length;
      await confirmVia({ notes: 'edited, still confirmed' });
      expect(sends().length, before, 'editing a confirmed booking does NOT message the guest again');
    }
  }

  /* ═════════ 14. NOTHING IS ON BY DEFAULT ═════════ */
  section(14, 'a fresh install sends nothing');
  {
    reset();
    for (const k of ['daily_ops', 'stock_differences', 'crm_daily', 'price_hike', 'discount_alert', 'reservation_confirmation']) {
      for (const f of ['enabled', 'recipients', 'audience', 'template', 'time', 'outlets', 'offset_days']) {
        db.prepare('DELETE FROM settings WHERE key = ?').run(`wa_report_${k}_${f}`);
      }
      clearRuns(k);
    }
    const out = await JOBS.runWaReportJobs(db, { fetchImpl: stubFetch });
    for (const k of Object.keys(out)) expect(out[k].status, 'disabled', `${k} is OFF out of the box`);
    expect(sends().length, 0, 'and nothing at all reaches Meta');
    expect(all('SELECT id FROM wa_report_runs').length, 0, 'and not one ledger row is written');

    set('wa_report_daily_ops_enabled', '1');
    const r1 = await JOBS.runReportJob(db, 'daily_ops', { fetchImpl: stubFetch });
    expect(r1.status, 'no_recipients', 'enabled with nobody to send to ⇒ refused');
    show('reason', r1.detail);
    set('wa_report_daily_ops_recipients', PH(1));
    const r2 = await JOBS.runReportJob(db, 'daily_ops', { fetchImpl: stubFetch });
    expect(r2.status, 'no_template', 'and with no approved template ⇒ still refused');
    expect(sends().length, 0, 'nothing was sent through any of that');
    expect(all('SELECT id FROM wa_report_runs').length, 0,
      'and still no ledger row — a misconfigured report never claims a slot');
  }

  /* ═════════ 16. THE THREAD BUBBLE IS NOT THE REPORT ═════════ */
  section(16, 'wa_messages.body — readable by EVERY signed-in member — carries no figures');
  if (SALES_DAY) {
    reset(); clearRuns('daily_ops'); clearLog();
    configure('daily_ops', { time: '00:00', recipients: [PH(31)] });
    const r = await JOBS.runReportJob(db, 'daily_ops', {
      trigger: 'manual', actor: 'owner@example.com', date: SALES_DAY, fetchImpl: stubFetch,
    });
    expect(r.status, 'sent', 'the report went out');

    const built = await B.buildDailyOpsReport(db, { date: SALES_DAY, outletId: OUTLET || null });
    const conv = one('SELECT id, last_message_preview FROM wa_conversations WHERE wa_id = ?', wa.normalizeWaNumber(PH(31)));
    const msg = one('SELECT body, msg_type, report_file_id FROM wa_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1', conv && conv.id);
    show('bubble', msg && msg.body);
    show('preview', conv && conv.last_message_preview);

    expectTrue(!!msg, 'the send is recorded in the thread (the webhook needs the row to ladder onto)');
    expectTrue(!!msg && !String(msg.body).includes(String(built.text).slice(0, 40)),
      'and the bubble is NOT the report text', msg && String(msg.body).slice(0, 120));
    expectTrue(!!msg && String(msg.body).includes('Daily ops report'),
      'it names the report instead', msg && msg.body);
    expectTrue(!!conv && !/[0-9][0-9,]*\.[0-9]{2}/.test(String(conv.last_message_preview)),
      'the conversation preview carries no rupee figure either', conv && conv.last_message_preview);
    expectTrue(!!msg && Number(msg.report_file_id) > 0,
      'the PDF is still linked — behind /api/crm-calls/reports/files/[id], which is isManagement-only');

    /* The figures ARE still in the report itself — this is redaction of the
     * thread bubble, not of the report. */
    expectTrue(/Net collected|Calls|Lines counted|Rs/i.test(String(built.text)),
      'the report the recipient receives still carries the figures');

    /* AND THE GUEST EXCEPTION IS REAL. A reservation confirmation is addressed
     * to the guest whose booking it is, and its bubble IS that person's own
     * message — recording it is what the inbox is for. Over-redacting here
     * would blank the one thread staff are supposed to be able to read. */
    if (confirmedBooking) {
      reset(); clearRuns('reservation_confirmation'); clearLog();
      configure('reservation_confirmation', {});
      const rc = await EV.fireReservationConfirmation(db, { bookingId: confirmedBooking.id }, F);
      if (rc.status === 'sent') {
        const gb = one(`
          SELECT m.body FROM wa_messages m
           WHERE m.sent_by = 'alert:reservation_confirmation' ORDER BY m.id DESC LIMIT 1`);
        show('guest bubble', gb && String(gb.body).replace(/\n/g, ' ').slice(0, 90));
        const gBuilt = await B.buildReservationConfirmation(db, { bookingId: confirmedBooking.id });
        expect(gb && String(gb.body), String(gBuilt.text),
          'the GUEST thread still records the guest’s own message, in full');
      } else {
        show('skipped', `reservation confirmation did not send (${rc.status})`);
      }
    }
  }

  /* ═════════ 17. ONE ALERT PER BILL, AND A DAILY CAP ═════════ */
  section(17, 'a price hike alerts once per BILL, not once per purchase line, and the day is capped');
  {
    reset(); clearRuns('price_hike'); clearLog();
    configure('price_hike', { recipients: [PH(41), PH(42), PH(43)] });

    /* TWO LINES, ONE BILL, THROUGH THE REAL ROUTE — the exact shape that used
     * to emit one alert per line. POST /api/purchases writes one line per
     * request, so this is two requests against one bill_no. */
    const bill = [];
    if (admin) {
      const purchasesRoute = apiRoute('purchases/route.ts');
      const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
      const cands = all(`
        SELECT p.material_id AS id FROM purchases p
         GROUP BY p.material_id HAVING COUNT(*) >= 1 AND AVG(p.unit_price) BETWEEN 1 AND 500
         ORDER BY COUNT(*) DESC LIMIT 40
      `);
      for (const c of cands) {
        if (bill.length >= 2) break;
        const res = await purchasesRoute.POST(new Request('http://localhost/api/purchases', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            material_id: c.id, vendor: 'ZZ Coalesce Test Vendor', quantity: 1, unit_price: 4999,
            date: today, bill_no: 'ZZ-COALESCE-1', notes: 'wa-report-schedule-tests one-bill',
          }),
        }));
        if (res.status === 201) {
          const j = await res.json();
          bill.push({ id: j.purchase.id, invoice_id: j.purchase.invoice_id });
        }
      }
      expect(sends().length, 0, 'neither purchase request put a message on the wire');
      expectTrue(bill.length < 2 || bill[0].invoice_id === bill[1].invoice_id,
        'both lines share ONE invoice_id — that is what makes them one bill',
        JSON.stringify(bill));
      /* The route queued each line; start the section from a known state so the
       * queue calls below are the ones under test. */
      clearRuns('price_hike');
    }
    if (bill.length < 2) { show('skipped', 'could not record a two-line bill on this install'); }
    else {
      const q1 = EV.queuePriceHikeForPurchase(db, { purchaseId: bill[0].id });
      const q2 = EV.queuePriceHikeForPurchase(db, { purchaseId: bill[1].id });
      expect(q1.status, 'queued', 'the first line of a bill queues the bill');
      expect(q2.status, 'queued', 'the second line joins the same wait');
      expect(q1.dedupe_key, q2.dedupe_key, 'both lines resolve to ONE bill key');
      show('bill key', q1.dedupe_key);
      const pending = all("SELECT * FROM wa_report_runs WHERE report_key='price_hike' AND status='pending'");
      expect(pending.length, 1, 'exactly ONE pending row for the whole bill');
      expect(sends().length, 0, 'and nothing has been sent yet — the bill may still be growing');

      /* Not due until it has been quiet. */
      const early = await EV.flushPriceHikeAlerts(db, { quietMs: 10 * 60_000, fetchImpl: stubFetch });
      expect(early.length, 0, 'a bill still being typed is not flushed');
      expect(sends().length, 0, 'nothing sent');

      const fired = await EV.flushPriceHikeAlerts(db, { quietMs: 0, fetchImpl: stubFetch });
      expect(fired.length, 1, 'once quiet, ONE alert for the bill');
      show('outcome', fired[0].status);
      if (fired[0].status === 'sent') {
        expect(sends().length, 3, 'one message per recipient — not one per line');
        const body = one("SELECT body FROM wa_messages WHERE sent_by = 'alert:price_hike' ORDER BY id DESC LIMIT 1");
        show('alert bubble', body && body.body);
        expectTrue(!!body && /Price hike alert/.test(String(body.body)) && !/₹|Rs/.test(String(body.body)),
          'and the alert bubble names the alert without quoting a rate', body && body.body);
      } else {
        expect(sends().length, 0, `nothing over the threshold on that bill (${fired[0].status})`);
      }
      expect(all("SELECT id FROM wa_report_runs WHERE report_key='price_hike' AND status='pending'").length, 0,
        'the pending row is cleared either way');

      /* The same bill again is refused rather than re-alerted. */
      const q3 = EV.queuePriceHikeForPurchase(db, { purchaseId: bill[0].id });
      expectTrue(q3.status === 'already_sent' || fired[0].status !== 'sent',
        'a further line on an already-alerted bill does not queue a second alert', q3.status);
    }

    /* THE CAP. Counted in messages, cannot be switched off. */
    expect(EV.alertDailyCap(db, 'price_hike'), EV.DEFAULT_ALERT_DAILY_CAP, 'unset ⇒ the default cap');
    set('wa_report_price_hike_daily_cap', '0');
    expect(EV.alertDailyCap(db, 'price_hike'), EV.DEFAULT_ALERT_DAILY_CAP, '0 is NOT unlimited — it reads as the default');
    set('wa_report_price_hike_daily_cap', '99999');
    expect(EV.alertDailyCap(db, 'price_hike'), EV.MAX_ALERT_DAILY_CAP, 'and it cannot be raised past the ceiling');

    reset(); clearRuns('price_hike'); clearLog();
    configure('price_hike', { recipients: [PH(41), PH(42), PH(43)] });
    set('wa_report_price_hike_daily_cap', '2');
    const spikes = CS.costSpikes(db, { thresholdPct: B.priceHikeThreshold(db), minPurchases: 2, limit: 50 });
    if (!spikes.spikes.length) { show('skipped', 'no spike on this install to alert on'); }
    else {
      const capped = await EV.firePriceHikeAlert(db,
        { materialIds: spikes.spikes.map(s => String(s.id)), sourceId: 'cap-probe' }, F);
      expect(capped.status, 'daily_cap_reached', '3 recipients against a cap of 2 ⇒ refused WHOLE');
      expect(sends().length, 0, 'and not one of the three was messaged');
      show('reason', capped.detail);
      expect(EV.alertMessagesSentToday(db, 'price_hike'), 0, 'nothing was billed');
    }
    db.prepare('DELETE FROM settings WHERE key = ?').run('wa_report_price_hike_daily_cap');

    /* OFF MEANS OFF, INCLUDING THE PAPERWORK. */
    if (bill.length) {
      set('wa_report_price_hike_enabled', '0');
      clearRuns('price_hike');
      const q = EV.queuePriceHikeForPurchase(db, { purchaseId: bill[0].id });
      expect(q.status, 'disabled', 'with the alert switched off, a purchase line queues nothing');
      expect(all("SELECT id FROM wa_report_runs WHERE report_key='price_hike'").length, 0,
        'and no ledger row is written for it either');
    }
  }

  /* ═════════ 18. THE COST MODEL ═════════ */
  section(18, 'the page can show what this costs, at the rate the broadcast rail bills against');
  {
    const COST = lib('wa-report-cost.ts');
    reset(); clearRuns('daily_ops');
    configure('daily_ops', { recipients: [PH(51), PH(52), PH(53), PH(54)] });
    const est = COST.estimateReportCosts(db);
    const line = est.lines.find(l => l.key === 'daily_ops');
    show('rate', `${est.rate}/message (${est.rate_source})`);
    show('daily_ops', `${line.per_day} msg/day · ${line.cost_per_day}/day · ${line.cost_per_month}/month — ${line.basis}`);

    expectTrue(est.rate > 0, 'a rupee rate is available');
    expect(line.recipients, 4, 'the cost line counts the RESOLVED recipients');
    expect(line.per_day, 4 * Math.max(1, line.outlets), 'messages a day = recipients × outlets');
    expect(line.cost_per_month, Math.round(line.per_day * est.rate * est.month_days * 100) / 100,
      'and the month is that, times the rate, times the month length');
    expectTrue(est.cost_per_month >= line.cost_per_month,
      'the headline includes it while it is switched on');

    const hike = est.lines.find(l => l.key === 'price_hike');
    expectTrue(!!hike && hike.ceiling === true, 'an event alert is costed at its ENFORCED cap, not at a guess');
    expect(hike.daily_cap, EV.alertDailyCap(db, 'price_hike'), 'and that cap is the one the rail enforces');

    /* Switching it off takes it out of the headline but not off the page. */
    set('wa_report_daily_ops_enabled', '0');
    const est2 = COST.estimateReportCosts(db);
    expectTrue(est2.cost_per_month < est.cost_per_month, 'switching a report off lowers the bill');
    expectTrue(!!est2.lines.find(l => l.key === 'daily_ops' && !l.enabled),
      'but its figure is still shown, so the cost is known BEFORE the switch is flipped');
    set('wa_report_daily_ops_enabled', '1');
  }

  /* ═════════ 15. THE TICKET SLOT ═════════ */
  section(15, 'the undefined ticket still refuses');
  {
    const r = await JOBS.runReportJob(db, 'ticket', { force: true, fetchImpl: stubFetch });
    expect(r.status, 'error', 'the ticket report refuses');
    expectTrue(/no ticket/i.test(String(r.detail)), 'with the reason, not a stack trace');
  }

  /* -- verdict ---------------------------------------------------------- */
  expect(unhandled.length, 0, 'no unhandled promise rejection in the whole run', unhandled.join(' | '));
  console.log(`\n${'-'.repeat(64)}`);
  console.log(`wa-report-schedule-tests: ${pass} passed, ${fail} failed  (sandbox: ${TMP})`);
  if (fail > 0) {
    console.log('FAILED:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  fs.rmSync(TMP, { recursive: true, force: true });
})().catch((e) => {
  console.error('\nwa-report-schedule-tests: harness crashed:', (e && e.stack) || e);
  process.exit(1);
});
