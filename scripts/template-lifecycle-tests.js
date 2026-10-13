#!/usr/bin/env node
/**
 * TEMPLATE LIFECYCLE PROOF — author → submit → approve → gate, META I/O MOCKED.
 *
 * Run with:  node scripts/template-lifecycle-tests.js     (also: npm test)
 *
 * Sandbox contract copied from scripts/broadcast-tests.js: every test runs
 * against a VACUUM INTO snapshot of fnb-controller.db in a fresh os.tmpdir()
 * dir, process.chdir()ed into BEFORE requiring src/lib/db.ts, with an
 * abort-hard sandbox guard. The REAL shipped code runs — the boot migration,
 * validateTemplateDraft, submitTemplate, syncTemplateStatuses, drainBroadcasts,
 * startBroadcast — with ONLY the Graph transport replaced by a recorder.
 *
 * NOTHING here talks to Meta. Every response is a fixture, so a rejected
 * template, a paused template and a template Meta has never heard of are all
 * reproducible on demand — which is the only way to test them at all.
 *
 * WHAT IT PROVES (the build gates):
 *   1  the migration is ADDITIVE: all three existing consumer queries return
 *      byte-identical rows across it, and every pre-existing row is unmanaged
 *   2  validation refuses each malformed shape with its OWN specific message
 *   3  submit → pending, and the mocked status list moves it → approved
 *   4  a rejected template surfaces Meta's reason VERBATIM
 *   5  a Meta refusal at submit time surfaces the Graph error VERBATIM
 *   6  sync adopts an approved-at-Meta template missing locally
 *   7  sync marks a locally-submitted template Meta has never heard of
 *   8  sync reports a status that moved BACKWARDS (approved → paused)
 *   9  an approved-then-paused template is refused AT SEND TIME: the drain
 *      halts the campaign with an honest reason instead of failing each send
 *  10  start is refused server-side for a non-approved template
 *  11  the gate is permissive before the first sync, strict after it
 *  12  a template a live campaign uses cannot be deleted
 *  13  the webhook status update applies (bonus path), polling still backstops
 *  14  a pre-existing free-form template still drains and sends normally
 *  15  the five audited blockers, each held shut by its own regression:
 *      a parameter count that does not match the template's placeholders is
 *      refused at create, start, resume AND every drain pass; a (name,
 *      language) conflict can no longer leave a stale 'approved' behind; an
 *      'en' vs 'en_US' spelling reconciles instead of blocking an approved
 *      template; Meta's credential error never reaches meta_last_error with
 *      the token in it; and the sendability lookup is by the name a campaign
 *      is actually created with, which is the rule the wizard must mirror
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const REPO = path.resolve(__dirname, '..');
const LIVE_DB = path.join(REPO, 'fnb-controller.db');
const SRC = path.join(REPO, 'src');

/* ── 0. SNAPSHOT (identical discipline to broadcast-tests.js) ───────────── */

if (!fs.existsSync(LIVE_DB)) {
  console.error(`template-lifecycle-tests: ${LIVE_DB} not found — nothing to snapshot.`);
  process.exit(2);
}

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fnb-template-tests-')));
const SNAP = path.join(TMP, 'fnb-controller.db');
// A SECOND, untouched copy. Nothing ever runs migrations against it, so it is
// the "before" side of the additive-migration proof.
const PRISTINE = path.join(TMP, 'pristine.db');
{
  const src = new Database(LIVE_DB, { readonly: true });
  const vacuumInto = (target) => src.prepare(`VACUUM INTO '${target.replace(/'/g, "''")}'`).run();
  vacuumInto(SNAP);
  vacuumInto(PRISTINE);
  src.close();
}

/* ── 1. CONSUMER QUERIES, captured BEFORE any migration runs ────────────── */

// The exact SQL the raw-SQL consumers use today. If the migration is truly
// additive these must return identical rows after it.
const Q_BROADCAST_PICKER = `
  SELECT id, name, category, language, body, provider_template_name, provider_language,
         param_order, send_as_template
  FROM whatsapp_templates WHERE is_active = 1
  ORDER BY CASE WHEN category = 'marketing' THEN 0 ELSE 1 END, name
`;
const Q_INBOX_PICKER = `
  SELECT name, category, language, body, provider_template_name, provider_language,
         param_order, send_as_template
  FROM whatsapp_templates
  WHERE is_active = 1 AND send_as_template = 1 AND COALESCE(provider_template_name,'') <> ''
  ORDER BY category, name
`;
const Q_WINBACK_PICKER = `
  SELECT name, category, language, body, provider_template_name, provider_language,
         param_order, send_as_template
  FROM whatsapp_templates WHERE is_active = 1
`;

const before = {};
{
  const p = new Database(PRISTINE, { readonly: true });
  before.broadcast = p.prepare(Q_BROADCAST_PICKER).all();
  before.inbox = p.prepare(Q_INBOX_PICKER).all();
  before.winback = p.prepare(Q_WINBACK_PICKER).all();
  before.count = p.prepare(`SELECT COUNT(*) AS n FROM whatsapp_templates`).get().n;
  p.close();
}

process.chdir(TMP);

/* ── 2. TYPESCRIPT LOADER (same hook as broadcast-tests.js) ─────────────── */

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

/* ── NOTHING IN THIS SUITE MAY REACH THE NETWORK ────────────────────────────
 *
 * Every Meta call here is an injected fetchImpl and every send is an injected
 * sender, but "we passed a mock everywhere" is an intention, not a fact. This
 * makes it a fact: the global fetch throws. Any path that forgot the injected
 * transport fails the run loudly instead of quietly submitting a template for
 * real review or billing the venue for a real WhatsApp message.
 *
 * INSTALLED BEFORE THE FIRST require OF ANY APP MODULE — db.ts included, and
 * before getDb() runs the boot migrations. It used to sit further down, after
 * db.ts had been loaded and booted, while claiming in this very comment to be
 * first; the window was provably empty (db.ts mentions fetch only in comments)
 * but a guarantee with a hole in it is not the guarantee it says it is. Now the
 * order matches the promise: a module that captures `fetch` at import time, from
 * anywhere in the graph, captures this one. */
globalThis.fetch = (...a) => {
  throw new Error(`BLOCKED: a real network call was attempted — ${String(a[0])}. Every transport in this suite must be injected.`);
};

const lib = (rel) => require(path.join(SRC, 'lib', rel));

const dbMod = lib('db.ts');
const { generateId } = dbMod;
const db = dbMod.getDb();      // boots the migrations (adds the lifecycle columns)

function assertSandboxed(handle) {
  const open = path.resolve(handle.name || '');
  if (path.resolve(LIVE_DB) === open || !open.startsWith(path.resolve(TMP))) {
    console.error(`\nFATAL: tests opened ${open}, which is not the snapshot in ${TMP}. Aborting.`);
    process.exit(3);
  }
}
assertSandboxed(db);

const tpl = lib('wa-template-authoring.ts');
const bc = lib('wa-broadcast.ts');
const ctSettings = lib('ct/settings.ts');

/**
 * THE OPTIONS EVERY REFRESH IS GIVEN HERE.
 *
 * `impact` is the REAL measurement (wa-broadcast.measureSendability) — the same
 * function the production route passes, built out of the same gates the start door
 * asks. It is a required option precisely so a caller cannot forget it and get a
 * refresh that reports "nothing stopped" because it never looked.
 *
 * `allowStops` is on for most of this suite because the fixtures deliberately
 * stop things; the guard that refuses a refresh which would stop EVERYTHING is
 * proved on its own, with the flag off, in section 19.
 */
const SYNC_OPTS = (extra = {}) => ({
  fetchImpl: mockFetch, impact: bc.measureSendability, allowStops: true, ...extra,
});

/* ── ROUTE HANDLERS ARE EXERCISED DIRECTLY, WITH AUTH STUBBED ───────────────
 *
 * Several of the defects this suite pins live in the ROUTE, not in the library:
 * the legacy param_order PUT, the refusal to re-point an approved template, the
 * app-secret writer, the webhook's 401-before-archive. Reasoning about a route by
 * reading it is exactly how they shipped, so they are called here as functions —
 * real Request in, real Response out, against the snapshot.
 *
 * `requireRole` is replaced (via the module cache, before any route is loaded)
 * because this suite has no session. That is a deliberate limit and it is stated:
 * this proves what the handlers DO once past the gate, not that the gate is there.
 * The gate itself is one line at the top of each handler and is read, not run. */
const ADMIN_STUB = { id: 'u-test-admin', name: 'Owner', email: 'owner@test', role: 'admin', tier: 'admin' };
(function stubAuth() {
  const Module = require('module');
  const file = path.join(SRC, 'lib', 'auth.ts');
  const m = new Module(file, null);
  m.filename = file; m.loaded = true;
  m.exports = {
    requireRole: async () => ({ ok: true, user: ADMIN_STUB }),
    requireAuth: async () => ({ ok: true, user: ADMIN_STUB }),
    getCurrentUser: async () => ADMIN_STUB,
    isManagement: () => true,
  };
  require.cache[file] = m;
  const sched = path.join(SRC, 'lib', 'scheduler.ts');
  const sm = new Module(sched, null);
  sm.filename = sched; sm.loaded = true; sm.exports = { startSchedulerOnce: () => {} };
  require.cache[sched] = sm;
})();

/* ── 3. HARNESS ─────────────────────────────────────────────────────────── */

let pass = 0, fail = 0;
const failures = [];
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function bad(label, detail) {
  fail++; failures.push(label);
  console.log(`  ✗ ${label}`);
  if (detail) console.log(`      ${detail}`);
}
function expect(actual, expected, label) {
  if (actual === expected) ok(`${label} — ${JSON.stringify(actual)}`);
  else bad(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function expectTrue(cond, label, hint) { cond ? ok(label) : bad(label, hint); }
function section(n, title) { console.log(`\n[${n}] ${title}`); }

/** Assert an error list contains a message matching `re`, and show it. */
function expectError(errors, re, label) {
  const hit = (errors || []).find(e => re.test(e));
  if (hit) ok(`${label} — "${hit.slice(0, 100)}"`);
  else bad(label, `no message matched ${re}; got: ${JSON.stringify(errors)}`);
}

/* ── 4. MOCK GRAPH TRANSPORT ────────────────────────────────────────────── */

const graphCalls = [];
/** Build a fetch-shaped response. */
const res = (okFlag, status, body) => ({ ok: okFlag, status, json: async () => body });

/** Queue of responders: each entry handles one call, in order. */
let responders = [];
const mockFetch = async (url, init) => {
  graphCalls.push({
    url,
    method: (init && init.method) || 'GET',
    body: init && init.body ? JSON.parse(init.body) : undefined,
  });
  const r = responders.shift();
  if (!r) throw new Error(`mockFetch: no responder queued for ${(init && init.method) || 'GET'} ${url}`);
  return r(url, init);
};
const queue = (...fns) => { responders = fns.slice(); };
/** A fetch mock that only ever answers Meta's template-list read, with whatever
 *  `routeList` currently holds. Used where the point of the test is not the list. */
const mockFetchListOnly = async (url, init) => {
  const method = String((init && init.method) || 'GET').toUpperCase();
  if (method !== 'GET') throw new Error(`BLOCKED: only the list read is allowed here — saw ${method} ${url}`);
  return res(true, 200, { data: [] });
};

const listResponse = (templates) => res(true, 200, { data: templates });
let metaIdSeq = 55000;
const metaTemplate = (o) => ({
  id: o.id || String(++metaIdSeq),
  name: o.name,
  status: o.status,
  language: o.language || 'en',
  category: o.category || 'MARKETING',
  components: o.components || [{ type: 'BODY', text: 'Hi {{1}}, come back to {{2}} soon!' }],
  ...(o.rejected_reason ? { rejected_reason: o.rejected_reason } : {}),
});

/* ── 5. FIXTURES ────────────────────────────────────────────────────────── */

const setSetting = db.prepare(
  `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);

const PH = (n) => `+9190000001${String(n).padStart(2, '0')}`;
const insGuest = db.prepare(`INSERT INTO ct_guests (id, phone_e164, name) VALUES (?, ?, ?)`);
for (let i = 1; i <= 12; i++) insGuest.run(generateId(), PH(i), `Tpl Guest ${i}`);

const set = (k, v) => ctSettings.setCtSetting(db, k, String(v));
set('broadcast_enabled', '1');
set('broadcast_msgs_per_min', '50');
set('broadcast_cooldown_days', '0');
set('broadcast_daily_cap', '0');
set('broadcast_cost_per_msg', '0.80');
set(bc.DRAIN_WATERMARK_KEY, '');

const sentCalls = [];
const mockSender = async (to, template, lang, params) => {
  sentCalls.push({ to, template, lang, params });
  return { ok: true, provider: 'mock', message_id: `wamid.mock.${sentCalls.length}` };
};

const rowByName = (name) => db.prepare(`SELECT * FROM whatsapp_templates WHERE name = ?`).get(name);
const insertDraft = (o) => {
  const id = generateId();
  db.prepare(`
    INSERT INTO whatsapp_templates
      (id, name, category, language, body, is_active, meta_category, meta_status, var_spec, meta_components)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
  `).run(id, o.name, o.category || 'marketing', o.language || 'en', o.body,
         o.meta_category || 'MARKETING', o.meta_status || 'draft',
         JSON.stringify(o.var_spec || []), o.meta_components || '');
  return id;
};

const GOOD_BODY = 'Hi {{1}}, we miss you at {{2}}. Come see our new menu this week!';
const GOOD_VARS = [
  { index: 1, name: 'name', example: 'Priya' },
  { index: 2, name: 'venue', example: 'AKAN' },
];

(async () => {

  /* ═══════════════════════════════════════════════════════════════════════ */
  section(1, 'MIGRATION IS ADDITIVE — existing rows and consumers unchanged');

  const after = {
    broadcast: db.prepare(Q_BROADCAST_PICKER).all(),
    inbox: db.prepare(Q_INBOX_PICKER).all(),
    winback: db.prepare(Q_WINBACK_PICKER).all(),
  };
  const sameRows = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  expectTrue(sameRows(before.broadcast, after.broadcast),
    `broadcast picker: ${before.broadcast.length} rows byte-identical across the migration`,
    `before=${JSON.stringify(before.broadcast).slice(0, 300)}\n      after=${JSON.stringify(after.broadcast).slice(0, 300)}`);
  expectTrue(sameRows(before.inbox, after.inbox),
    `inbox out-of-window picker: ${before.inbox.length} rows byte-identical across the migration`);
  expectTrue(sameRows(before.winback, after.winback),
    `win-back picker: ${before.winback.length} rows byte-identical across the migration`);

  const unmanaged = db.prepare(
    `SELECT COUNT(*) AS n FROM whatsapp_templates WHERE COALESCE(meta_status,'') = ''`).get().n;
  expect(unmanaged, before.count, `all ${before.count} pre-existing rows are UNMANAGED (meta_status = '')`);

  const notifyRow = db.prepare(
    `SELECT * FROM whatsapp_templates WHERE name = 'requisition_approved' AND is_active = 1`).get();
  expectTrue(!!notifyRow && notifyRow.body.includes('{{req_number}}'),
    "notifyEvent's by-name lookup still resolves, with its {{named}} body intact");
  expect(tpl.isManagedStatus(notifyRow.meta_status), false,
    'and that row is not in the Meta lifecycle');

  /* ═══════════════════════════════════════════════════════════════════════ */
  section(2, 'VALIDATION refuses each malformed shape with a SPECIFIC message');

  const base = { name: 'good_name', language: 'en', meta_category: 'MARKETING', body: GOOD_BODY, var_spec: GOOD_VARS };
  expectTrue(tpl.validateTemplateDraft(base).ok, 'a well-formed draft validates clean');

  expectError(tpl.validateTemplateDraft({ ...base, name: 'Bad Name!' }).errors,
    /lowercase letters, digits and underscores/, 'name shape refused');
  expectError(tpl.validateTemplateDraft({ ...base, meta_category: 'PROMOTIONAL' }).errors,
    /Category must be one of MARKETING, UTILITY, AUTHENTICATION/, 'bad category refused');
  expectError(tpl.validateTemplateDraft({ ...base, meta_category: '' }).errors,
    /Category is required/, 'missing category refused');
  expectError(tpl.validateTemplateDraft({ ...base, language: 'english' }).errors,
    /Meta language code like 'en' or 'en_US'/, 'bad language refused');
  expectError(tpl.validateTemplateDraft({ ...base, body: '' }).errors,
    /needs a BODY component/, 'missing BODY refused');

  expectError(tpl.validateTemplateDraft({
    ...base, body: 'Hi {{1}}, welcome to {{3}} today!',
    var_spec: [{ index: 1, name: 'name', example: 'P' }, { index: 3, name: 'venue', example: 'A' }],
  }).errors, /no gaps.*missing \{\{2\}\}/, 'gap in variable numbering refused, naming the gap');

  expectError(tpl.validateTemplateDraft({
    ...base, body: 'Hi {{2}}, come to {{3}} soon!',
    var_spec: [{ index: 2, name: 'name', example: 'P' }, { index: 3, name: 'venue', example: 'A' }],
  }).errors, /must start at \{\{1\}\}/, 'numbering not starting at 1 refused');

  expectError(tpl.validateTemplateDraft({
    ...base, body: '{{1}}, we miss you at AKAN.',
    var_spec: [{ index: 1, name: 'name', example: 'P' }],
  }).errors, /may not START with a variable/, 'body starting with a variable refused');

  expectError(tpl.validateTemplateDraft({
    ...base, body: 'We miss you at {{1}}',
    var_spec: [{ index: 1, name: 'venue', example: 'A' }],
  }).errors, /may not END with a variable/, 'body ending with a variable refused');

  expectError(tpl.validateTemplateDraft({
    ...base, body: 'Hi {{1}} {{2}}, see you soon!',
    var_spec: [{ index: 1, name: 'name', example: 'P' }, { index: 2, name: 'venue', example: 'A' }],
  }).errors, /may not sit next to each other/, 'adjacent variables refused');

  expectError(tpl.validateTemplateDraft({
    ...base, var_spec: [{ index: 1, name: 'name', example: 'Priya' }, { index: 2, name: 'venue', example: '' }],
  }).errors, /\{\{2\}\} has none/, 'missing example refused, naming the variable');

  expectError(tpl.validateTemplateDraft({
    ...base, var_spec: [{ index: 1, name: 'name', example: 'Priya' }, { index: 2, name: 'venue', example: 'A\nB' }],
  }).errors, /\{\{2\}\} contains a line break/, 'example with a newline refused');

  expectError(tpl.validateTemplateDraft({ ...base, body: 'Hi {{name}}, come to AKAN soon!' }).errors,
    /must be POSITIONAL/, 'named placeholders refused for a Meta submission');

  expectError(tpl.validateTemplateDraft({ ...base, body: 'x'.repeat(1100) + ' end.' }).errors,
    /Body is \d+ characters; Meta allows at most 1024/, 'over-long body refused with the real count');

  expectError(tpl.validateTemplateDraft({ ...base, footer: 'Sent by {{1}}' }).errors,
    /FOOTER may not contain variables/, 'variables in the footer refused');

  expectError(tpl.validateTemplateDraft({ ...base, header: 'A'.repeat(70) }).errors,
    /Header is 70 characters; Meta allows at most 60/, 'over-long header refused');

  const many = tpl.validateTemplateDraft({
    name: 'Bad Name', language: 'english', meta_category: 'NOPE',
    body: '{{1}} {{2}}', var_spec: [],
  });
  expectTrue(many.errors.length >= 6,
    `all problems reported together (${many.errors.length} messages), not one per Meta round-trip`);

  /* ═══════════════════════════════════════════════════════════════════════ */
  section(3, 'SUBMIT — blocked until the WABA is configured, then goes to Meta');

  const winbackId = insertDraft({ name: 'winback_offer_v1', body: GOOD_BODY, var_spec: GOOD_VARS });

  let r = await tpl.submitTemplate(db, winbackId, { fetchImpl: mockFetch });
  expect(r.ok, false, 'submit refused while the WABA id is unset');
  expectTrue(/WhatsApp Business Account ID/.test(r.error || ''),
    `and says WHICH credential is missing — "${(r.error || '').slice(0, 70)}…"`);
  expectTrue(/Configured" badge does NOT cover/.test(r.error || ''),
    'and warns the "Configured" badge does not cover the WABA id');

  setSetting.run('wa_api_provider', 'meta_cloud');
  setSetting.run('wa_business_account_id', '1234567890');
  setSetting.run('wa_access_token', 'EAAtest-token');
  setSetting.run('wa_phone_number_id', '9876543210');

  queue(() => res(true, 200, { id: '55501', status: 'PENDING', category: 'MARKETING' }));
  r = await tpl.submitTemplate(db, winbackId, { fetchImpl: mockFetch });
  expect(r.ok, true, 'submit succeeds once creds are set');
  expect(r.status, 'pending', 'status is PENDING straight after submission');

  const submitCall = graphCalls[graphCalls.length - 1];
  expect(submitCall.method, 'POST', 'submission is a POST');
  expectTrue(submitCall.url.includes('/1234567890/message_templates'),
    `posted to the WABA's message_templates edge — ${submitCall.url}`);
  expectTrue(submitCall.url.includes('/v23.0/'),
    'used the SHARED Graph version from lib/whatsapp.ts, not a private copy');
  expect(submitCall.body.category, 'MARKETING', "category sent in Meta's vocabulary");
  expect(submitCall.body.language, 'en', 'language sent');

  const bodyComp = submitCall.body.components.find(c => c.type === 'BODY');
  expectTrue(!!bodyComp, 'a BODY component was sent');
  expectTrue(Array.isArray(bodyComp.example.body_text) && Array.isArray(bodyComp.example.body_text[0]),
    'examples sent as an ARRAY OF ARRAYS (body_text[0] = the example set)');
  expect(JSON.stringify(bodyComp.example.body_text[0]), JSON.stringify(['Priya', 'AKAN']),
    'example values sent in variable order');

  let row = rowByName('winback_offer_v1');
  expect(row.meta_status, 'pending', 'row recorded as pending');
  expect(row.meta_template_id, '55501', "Meta's template id stored (needed for the edit path)");
  expect(row.param_order, JSON.stringify(['name', 'venue']),
    'param_order DERIVED from var_spec — the broadcast wizard can map it');
  expect(row.provider_template_name, 'winback_offer_v1', 'provider identity written');

  let s = tpl.templateSendability(db, 'winback_offer_v1', 'en');
  // RULING 2026-09-15: what WhatsApp says about its own review is information.
  expect(s.ok, true, 'a template still under review is not refused by this app');
  expectTrue(/not finished reviewing/.test(String(s.advisory || '')),
    `it is said instead — "${String(s.advisory || '').slice(0, 70)}…"`);

  /* ═══════════════════════════════════════════════════════════════════════ */
  section(4, 'STATUS SYNC — pending → approved via the mocked list');

  queue(() => listResponse([
    metaTemplate({ id: '55501', name: 'winback_offer_v1', status: 'APPROVED', language: 'en' }),
  ]));
  let sync = await tpl.syncTemplateStatuses(db, SYNC_OPTS());
  expect(sync.ok, true, 'sync succeeded');
  expect(sync.updated.length, 1, 'one status moved');
  expect(`${sync.updated[0].from}→${sync.updated[0].to}`, 'pending→approved', 'pending → approved recorded');

  const listCall = graphCalls[graphCalls.length - 1];
  expectTrue(listCall.url.includes('rejected_reason'),
    'the list request asks for rejected_reason (the existing dropdown route never did)');
  expectTrue(listCall.url.includes('fields=id,'),
    'and asks for id (needed to edit a template later)');

  expect(rowByName('winback_offer_v1').meta_status, 'approved', 'row is approved');
  s = tpl.templateSendability(db, 'winback_offer_v1', 'en');
  expect(s.ok, true, 'gate now allows it');
  expect(s.verified, true, 'and the answer is VERIFIED against Meta');

  // A LOCALE-QUALIFIED SPELLING IS NOT A DIFFERENT LANGUAGE. 'en_US' and 'en'
  // are one approval that Meta happens to qualify; refusing that pair blocked
  // an APPROVED template permanently (and the refusal contradicted the very
  // sync response that had just listed it as APPROVED). It is allowed — and the
  // gate hands back the spelling the SEND must use, because Meta's identity is
  // the exact (name, language) pair.
  s = tpl.templateSendability(db, 'winback_offer_v1', 'en_US');
  expect(s.ok, true, "'en_US' against an 'en' approval is the SAME template, not a refusal");
  expect(s.language, 'en', "and the gate returns Meta's own spelling for the send to use");

  // A genuinely different language still is one.
  s = tpl.templateSendability(db, 'winback_offer_v1', 'te');
  expect(s.ok, false, 'a DIFFERENT language (te vs en) is still refused');
  expectTrue(/approved at Meta in en/.test(s.reason),
    `naming the approved language — "${s.reason.slice(0, 80)}…"`);

  /* ── AND ON EVERY STATUS WHATSAPP HAS SPOKEN ABOUT, NOT ONLY 'approved' ──
   *
   * This comparison used to live inside the approved branch, and before the
   * 2026-09-15 ruling that was harmless BY ACCIDENT: every other managed status
   * returned ok:false anyway. The ruling turned four of them into advisories and
   * the cover went with them.
   *
   *   MEASURED. The same campaign — template held in `en`, campaign built in
   *   `te` — is refused on an approved row and ARMS AND DRAINS on pending,
   *   paused, rejected and disabled: 10 messages each, `te` on the wire. Where
   *   WhatsApp does hold a `te` translation the whole list is DELIVERED in the
   *   wrong language, charged for, and cooldown-locked, while every preview the
   *   operator read was built from the English wording. It is the one refusal in
   *   that function that exists to stop a SUCCESSFUL wrong send. */
  const langFacts = (st, lang = 'en') => ({
    present: true, meta_status: st, meta_category: 'MARKETING', meta_rejected_reason: '', language: lang,
  });
  const LANG_WATERMARK = '2026-09-16 10:00:00';
  for (const st of ['approved', 'pending', 'rejected', 'paused', 'disabled']) {
    const ls = tpl.sendabilityFrom('lang_probe', langFacts(st), LANG_WATERMARK, 'te');
    expect(ls.ok, false, `status "${st}": a 'te' campaign on an 'en' template is refused`);
    expect(ls.language, 'en', `status "${st}": and the answer carries the language a send must use`);
    expect(tpl.sendabilityFrom('lang_probe', langFacts(st), LANG_WATERMARK, 'en').ok, true,
      `status "${st}": the RIGHT language still sends — this is a language gate, not a status gate`);
    expect(tpl.sendabilityFrom('lang_probe', langFacts(st, 'en_US'), LANG_WATERMARK, 'en').ok, true,
      `status "${st}": and en vs en_US is still one approval, not a mismatch`);
  }
  /* THE TWO IT MUST NOT FIRE ON, because for both of them the language on the
   * row is THIS APP'S word rather than WhatsApp's — which is what keeps this
   * refusal incapable of stripping an estate: it needs WhatsApp's answer to
   * AFFIRMATIVELY hold the template in some language. */
  expect(tpl.sendabilityFrom('lang_probe', langFacts('unknown_at_meta'), LANG_WATERMARK, 'te').ok, true,
    'a name WhatsApp\'s list does not contain is NOT refused on language');
  expectTrue(/not been sent to WhatsApp/.test(
    tpl.sendabilityFrom('lang_probe', langFacts('draft'), LANG_WATERMARK, 'te').reason),
    'and a draft still refuses with the sentence that tells the owner what to do');

  /* ═══════════════════════════════════════════════════════════════════════ */
  section(5, "REJECTION surfaces Meta's reason VERBATIM");

  const rejId = insertDraft({ name: 'promo_blast_v1', body: GOOD_BODY, var_spec: GOOD_VARS });
  queue(() => res(true, 200, { id: '55502', status: 'PENDING', category: 'MARKETING' }));
  await tpl.submitTemplate(db, rejId, { fetchImpl: mockFetch });

  const VERBATIM = 'INVALID_FORMAT: The message template contains formatting that is not allowed.';
  queue(() => listResponse([
    metaTemplate({ id: '55501', name: 'winback_offer_v1', status: 'APPROVED' }),
    metaTemplate({ id: '55502', name: 'promo_blast_v1', status: 'REJECTED', rejected_reason: VERBATIM }),
  ]));
  await tpl.syncTemplateStatuses(db, SYNC_OPTS());

  row = rowByName('promo_blast_v1');
  expect(row.meta_status, 'rejected', 'rejected status recorded');
  expect(row.meta_rejected_reason, VERBATIM, "Meta's reason stored VERBATIM, character for character");
  s = tpl.templateSendability(db, 'promo_blast_v1', 'en');
  // The POINT of this section is that Meta's words survive the journey intact.
  // They now arrive as a warning rather than as a refusal; they still arrive.
  expect(s.ok, true, 'a turned-down template is not refused by this app');
  expectTrue(String(s.advisory || '').includes(VERBATIM),
    "and the warning carries Meta's verbatim reason through to the operator, character for character");

  /* ═══════════════════════════════════════════════════════════════════════ */
  section(6, 'A META REFUSAL AT SUBMIT TIME surfaces the Graph error VERBATIM');

  const dupId = insertDraft({ name: 'already_taken_v1', body: GOOD_BODY, var_spec: GOOD_VARS });
  const GRAPH_ERR = 'Template name already exists in the same language.';
  queue(() => res(false, 400, {
    error: { message: GRAPH_ERR, type: 'OAuthException', code: 100, error_subcode: 2388024 },
  }));
  r = await tpl.submitTemplate(db, dupId, { fetchImpl: mockFetch });
  expect(r.ok, false, 'a Graph refusal fails the submit');
  expectTrue((r.error || '').includes(GRAPH_ERR),
    `Meta's message reaches the caller unchanged — "${r.error}"`);
  expectTrue((r.error || '').includes('2388024'),
    'including the error_subcode, which is what distinguishes similar refusals');
  row = rowByName('already_taken_v1');
  expectTrue((row.meta_last_error || '').includes(GRAPH_ERR),
    'and is stored on the row so the admin can read it later');
  expect(row.meta_status, 'draft', 'the row stays a draft so it can be fixed and resubmitted');

  /* ═══════════════════════════════════════════════════════════════════════ */
  section(7, 'SYNC: adopt, mark-missing, and report a BACKWARDS move');

  queue(() => listResponse([
    metaTemplate({ id: '55501', name: 'winback_offer_v1', status: 'APPROVED' }),
    metaTemplate({ id: '55502', name: 'promo_blast_v1', status: 'REJECTED', rejected_reason: VERBATIM }),
    metaTemplate({
      id: '55510', name: 'birthday_wish_v2', status: 'APPROVED', category: 'UTILITY',
      components: [{ type: 'BODY', text: 'Happy birthday {{1}}, from all of us!' }],
    }),
  ]));
  sync = await tpl.syncTemplateStatuses(db, SYNC_OPTS());
  expect(sync.adopted.length, 1, 'one template adopted from Meta');
  expect(sync.adopted[0].name, 'birthday_wish_v2', 'the one this app had never recorded');

  const adopted = rowByName('birthday_wish_v2');
  expect(adopted.meta_status, 'approved', 'adopted as approved');
  expect(adopted.send_as_template, 1, 'adopted row is send_as_template=1…');
  expect(adopted.provider_template_name, 'birthday_wish_v2',
    '…with provider_template_name set — so the EXISTING inbox picker can see it');
  expectTrue(adopted.body.includes('Happy birthday'), "body recovered from Meta's components");
  expectTrue(db.prepare(Q_INBOX_PICKER).all().some(t => t.name === 'birthday_wish_v2'),
    'and it really does appear in the existing inbox picker query');

  const ghostId = insertDraft({ name: 'ghost_template_v1', body: GOOD_BODY, var_spec: GOOD_VARS });
  queue(() => res(true, 200, { id: '55599', status: 'PENDING', category: 'MARKETING' }));
  await tpl.submitTemplate(db, ghostId, { fetchImpl: mockFetch });

  const PAUSE_REASON = 'PAUSED due to low quality rating.';
  queue(() => listResponse([
    metaTemplate({ id: '55501', name: 'winback_offer_v1', status: 'PAUSED', rejected_reason: PAUSE_REASON }),
    metaTemplate({ id: '55502', name: 'promo_blast_v1', status: 'REJECTED', rejected_reason: VERBATIM }),
    metaTemplate({ id: '55502', name: 'promo_blast_v1', status: 'REJECTED', rejected_reason: VERBATIM }),
    metaTemplate({ id: '55510', name: 'birthday_wish_v2', status: 'APPROVED', category: 'UTILITY' }),
  ]));
  sync = await tpl.syncTemplateStatuses(db, SYNC_OPTS());

  expect(sync.missing_at_meta.length, 1, 'the ghost template is reported missing at Meta');
  expect(sync.missing_at_meta[0].name, 'ghost_template_v1', 'by name');
  expect(rowByName('ghost_template_v1').meta_status, 'unknown_at_meta', 'and marked unknown_at_meta');

  expect(sync.regressed.length, 1, 'one status moved BACKWARDS');
  expect(`${sync.regressed[0].from}→${sync.regressed[0].to}`, 'approved→paused', 'approved → paused reported');
  expect(rowByName('winback_offer_v1').meta_status, 'paused', 'and recorded on the row');

  const stillUnmanaged = db.prepare(
    `SELECT COUNT(*) AS n FROM whatsapp_templates WHERE COALESCE(meta_status,'') = ''`).get().n;
  expect(stillUnmanaged, before.count,
    `all ${before.count} pre-existing free-form rows survived every sync untouched`);

  // Meta's identity is (name, language) and permits the same name in several
  // languages; our table is UNIQUE(name). The second one must be REPORTED, not
  // inserted — an unguarded INSERT would violate the constraint and roll the
  // WHOLE sync back, losing every other template's status with it.
  const beforeConflict = db.prepare(`SELECT COUNT(*) AS n FROM whatsapp_templates`).get().n;
  queue(() => listResponse([
    metaTemplate({ id: '55501', name: 'winback_offer_v1', status: 'APPROVED' }),
    metaTemplate({ id: '55502', name: 'promo_blast_v1', status: 'REJECTED', rejected_reason: VERBATIM }),
    metaTemplate({ id: '55510', name: 'birthday_wish_v2', status: 'APPROVED', category: 'UTILITY' }),
    metaTemplate({ id: '55520', name: 'festival_greeting', status: 'APPROVED', language: 'en' }),
    metaTemplate({ id: '55521', name: 'festival_greeting', status: 'APPROVED', language: 'te' }),
  ]));
  sync = await tpl.syncTemplateStatuses(db, SYNC_OPTS());
  expect(sync.ok, true, 'a same-name-two-languages list does NOT blow up the sync');
  expect(sync.adopted.length, 1, 'the first language is adopted');
  expect(sync.name_conflicts.length, 1, 'the second is reported as a name conflict, not inserted');
  expect(sync.name_conflicts[0].meta_language, 'te', 'naming the language that could not be stored');
  expect(rowByName('winback_offer_v1').meta_status, 'approved',
    'and every other template in the same list still reconciled — no rollback');
  expect(db.prepare(`SELECT COUNT(*) AS n FROM whatsapp_templates`).get().n, beforeConflict + 1,
    'exactly one row added, not two and not zero');

  /* ═══════════════════════════════════════════════════════════════════════ */
  section(8, 'SEND-TIME — approved, then PUT ON HOLD mid-flight');

  /* ── THIS SECTION WAS REWRITTEN FOR THE OWNER'S RULING, 2026-09-15 ────────
   *
   * It used to assert that a template WhatsApp had put ON HOLD was REFUSED by
   * this app's own gate, so the drain stopped the campaign without attempting a
   * single further message. That was the old premise: WhatsApp's answer about a
   * template's state was treated as permission to send, and the app refused
   * whatever that answer did not bless.
   *
   * That premise was measured against this venue's real data and abandoned. An
   * answer read off the wrong WhatsApp Business Account reports EVERY template a
   * venue owns as missing, or turned down, or on hold — and refusing on it takes
   * away everything the venue can send, from one button press, with no way back.
   * So every one of those answers is now INFORMATION: it is shown to the owner
   * and it never refuses (see sendabilityFrom() in wa-template-authoring.ts).
   *
   * THE WHOLE RULING RESTS ON THIS BEING RECOVERABLE, so this section now proves
   * exactly that, which is a stronger claim than the one it replaced:
   *
   *   • the app does NOT refuse an on-hold template — it warns (A1);
   *   • WhatsApp refuses it instead, for every recipient, identically;
   *   • NOTHING is delivered, so nothing is charged and no guest's 7-day
   *     cooldown is burned (the cooldown and the cost line are both keyed on
   *     sent_at, which only a real send writes);
   *   • the campaign STOPS ITSELF after CONSECUTIVE_FAIL_HALT attempts — the
   *     queue is not burnt through;
   *   • and the rest of the audience is still waiting when it is fixed.
   *
   * WHAT IT COSTS, stated rather than hidden: the recipients attempted during
   * those failures end as 'failed' and are NOT re-queued on resume. The bound is
   * the breaker threshold per resume, and it is asserted below so a future change
   * to that threshold shows up here as a number, not as a surprise. */

  queue(() => listResponse([
    metaTemplate({ id: '55501', name: 'winback_offer_v1', status: 'APPROVED' }),
    metaTemplate({ id: '55502', name: 'promo_blast_v1', status: 'REJECTED', rejected_reason: VERBATIM }),
    metaTemplate({ id: '55510', name: 'birthday_wish_v2', status: 'APPROVED', category: 'UTILITY' }),
  ]));
  await tpl.syncTemplateStatuses(db, SYNC_OPTS());
  expect(rowByName('winback_offer_v1').meta_status, 'approved', 'template approved again');

  // The audience must be able to OUTLAST the breaker, or "it stops itself" is
  // untestable: a queue shorter than the threshold empties before it can fire.
  const HOLD_AUDIENCE = bc.CONSECUTIVE_FAIL_HALT + 4;   // 2 sent, 5 failed, ≥1 left
  const camp = bc.createBroadcast(db, {
    name: 'Put-on-hold mid-flight test',
    templateName: 'winback_offer_v1',
    language: 'en',
    paramOrder: ['name', 'venue'],
    previewBody: GOOD_BODY,
    audience: { kind: 'phones', phones: Array.from({ length: HOLD_AUDIENCE }, (_, i) => PH(i + 1)) },
    createdBy: 'test',
  });
  expect(camp.queued, HOLD_AUDIENCE, `campaign queued ${HOLD_AUDIENCE} recipients`);
  expect(bc.startBroadcast(db, camp.campaign.id).ok, true,
    'start allowed while the template is APPROVED');

  set('broadcast_msgs_per_min', '2');
  set(bc.DRAIN_WATERMARK_KEY, String(Date.now() - 60_000));
  let d = await bc.drainBroadcasts(db, { sender: mockSender, nowMs: Date.now(), venue: 'AKAN' });
  expect(d.sent, 2, 'first pass sent 2');
  expect(d.campaigns_halted.length, 0, 'nothing halted while the template was fine');

  queue(() => listResponse([
    metaTemplate({ id: '55501', name: 'winback_offer_v1', status: 'PAUSED', rejected_reason: PAUSE_REASON }),
    metaTemplate({ id: '55502', name: 'promo_blast_v1', status: 'REJECTED', rejected_reason: VERBATIM }),
    metaTemplate({ id: '55510', name: 'birthday_wish_v2', status: 'APPROVED', category: 'UTILITY' }),
  ]));
  await tpl.syncTemplateStatuses(db, SYNC_OPTS());

  /* A1 — the app tells the owner, and does not decide for him. */
  const onHold = bc.campaignSendability(db, bc.getCampaign(db, camp.campaign.id));
  expect(onHold.ok, true, 'the app does NOT refuse a template WhatsApp has on hold');
  expectTrue(/on hold/i.test(String(onHold.advisory || '')),
    `it says so instead — "${String(onHold.advisory || '').slice(0, 90)}…"`);
  expectTrue(/quality/i.test(String(onHold.advisory || '')),
    "carrying WhatsApp's own words, so the owner knows why");
  expectTrue(!/rail|blank|param|lifecycle|watermark|adopted|estate|sendability/i.test(String(onHold.advisory || '')),
    'in language a person who runs a restaurant reads once', String(onHold.advisory || ''));

  /* …and WhatsApp refuses it, exactly as it really does for a paused template. */
  let holdAttempts = 0;
  // The REAL failure shape sendWhatsAppTemplate returns — { reason, detail } —
  // so the detail this asserts is the one the shipped transport really hands over
  // (whatsapp.ts: `detail: j?.error?.message`). A mock with a prettier shape would
  // prove the drain reads a field production never sends.
  const refusedByMeta = async () => {
    holdAttempts++;
    return { ok: false, reason: 'send_failed', detail: '(#132015) Template is paused due to quality issues' };
  };
  const sentBefore = sentCalls.length;
  set('broadcast_msgs_per_min', '50');
  set(bc.DRAIN_WATERMARK_KEY, String(Date.now() - 60_000));
  d = await bc.drainBroadcasts(db, { sender: refusedByMeta, nowMs: Date.now(), venue: 'AKAN' });

  expect(sentCalls.length, sentBefore, 'not one further message was DELIVERED');
  expect(d.sent, 0, 'the drain reports nothing sent');
  expect(holdAttempts, bc.CONSECUTIVE_FAIL_HALT,
    'WhatsApp refused exactly the breaker threshold of attempts, then the drain stopped');
  expect(d.campaigns_halted.length, 1, 'the campaign stopped ITSELF');
  expectTrue(/in a row failed/i.test(d.campaigns_halted[0].reason),
    `because the same failure kept repeating — "${d.campaigns_halted[0].reason.slice(0, 90)}…"`);
  expectTrue(/paused due to quality/i.test(d.campaigns_halted[0].reason),
    "quoting WhatsApp's own error, so the operator is not guessing");

  const live = bc.getCampaign(db, camp.campaign.id);
  expect(live.state, 'paused', "campaign state is 'paused' — a state every existing consumer handles");
  expectTrue(/Halted automatically/.test(live.halt_reason),
    `halt_reason records this was NOT a human pause — "${live.halt_reason.slice(0, 60)}…"`);

  /* NOTHING WAS CHARGED AND NO COOLDOWN WAS BURNED. This is the sentence the
   * whole ruling leans on, so it is measured at the column both of those read. */
  const holdCounts = bc.recipientCounts(db, camp.campaign.id);
  expect(holdCounts.sent_total, 2, 'only the 2 that really went out count as sent');
  expect(
    db.prepare(`SELECT COUNT(*) AS n FROM wa_campaign_recipients
                WHERE campaign_id = ? AND COALESCE(sent_at,'') <> ''`).get(camp.campaign.id).n,
    2, 'and sent_at — which the cost line and the 7-day cooldown both read — grew by nothing');
  expect(holdCounts.failed, bc.CONSECUTIVE_FAIL_HALT,
    'the refused attempts are recorded as failures, capped by the breaker');
  expect(holdCounts.queued, HOLD_AUDIENCE - 2 - bc.CONSECUTIVE_FAIL_HALT,
    'and the rest of the audience is still QUEUED, not burnt through');

  /* Resume is no longer refused on WhatsApp's answer either — the owner decides.
   * It is still the wrong thing to do while the hold stands, and the breaker is
   * what makes that safe rather than a gate that could strip the whole estate. */
  queue(() => listResponse([
    metaTemplate({ id: '55501', name: 'winback_offer_v1', status: 'APPROVED' }),
    metaTemplate({ id: '55502', name: 'promo_blast_v1', status: 'REJECTED', rejected_reason: VERBATIM }),
    metaTemplate({ id: '55510', name: 'birthday_wish_v2', status: 'APPROVED', category: 'UTILITY' }),
  ]));
  await tpl.syncTemplateStatuses(db, SYNC_OPTS());
  expect(bc.resumeBroadcast(db, camp.campaign.id).ok, true, 'resume allowed once WhatsApp approves it again');
  expect(bc.getCampaign(db, camp.campaign.id).halt_reason, '', 'and halt_reason is cleared');

  set('broadcast_msgs_per_min', '50');
  set(bc.DRAIN_WATERMARK_KEY, String(Date.now() - 60_000));
  d = await bc.drainBroadcasts(db, { sender: mockSender, nowMs: Date.now(), venue: 'AKAN' });
  expect(d.sent, HOLD_AUDIENCE - 2 - bc.CONSECUTIVE_FAIL_HALT,
    'everyone still waiting was delivered once it was fixed');
  /* THE STATED COST, pinned so it cannot change silently: the recipients WhatsApp
   * refused during the hold are not retried by a resume. */
  expect(bc.recipientCounts(db, camp.campaign.id).failed, bc.CONSECUTIVE_FAIL_HALT,
    'the refused ones are NOT re-queued by resume — that is the measured price of warning rather than refusing');

  /* ═══════════════════════════════════════════════════════════════════════ */
  section(9, 'START — what WhatsApp SAYS warns; what this app cannot SEND refuses');

  /* REWRITTEN FOR THE RULING (2026-09-15). This used to assert that a campaign on
   * a template WhatsApp had TURNED DOWN could not start. "Turned down" is one of
   * the answers a list read off the wrong Business Account gives about every
   * template a venue owns, so it warns now instead. The half that still refuses —
   * a template this rail physically cannot send — is asserted immediately after,
   * because getting THAT backwards burns the audience instead of merely failing. */

  const badCamp = bc.createBroadcast(db, {
    name: 'Rejected-template campaign',
    templateName: 'promo_blast_v1',
    language: 'en',
    paramOrder: ['name', 'venue'],
    previewBody: GOOD_BODY,
    audience: { kind: 'phones', phones: [PH(5), PH(6)] },
    createdBy: 'test',
  });
  const badSend = bc.campaignSendability(db, bc.getCampaign(db, badCamp.campaign.id));
  expect(badSend.ok, true, 'a campaign on a TURNED-DOWN template is no longer refused');
  expectTrue(String(badSend.advisory || '').includes(VERBATIM),
    "Meta's verbatim rejection reason travels — as a warning the owner reads, not as a refusal");
  expectTrue(/nothing is charged/i.test(String(badSend.advisory || '')),
    'and it says what happens if he sends it anyway');

  // Started on a SECOND campaign so `badCamp` stays a draft for section 11,
  // which counts live users of this template.
  const badCamp2 = bc.createBroadcast(db, {
    name: 'Rejected-template campaign (start probe)',
    templateName: 'promo_blast_v1',
    language: 'en',
    paramOrder: ['name', 'venue'],
    previewBody: GOOD_BODY,
    audience: { kind: 'phones', phones: [PH(7)] },
    createdBy: 'test',
  });
  expect(bc.startBroadcast(db, badCamp2.campaign.id).ok, true,
    'and Start lets him send it — the decision is his, not the list read');
  bc.cancelBroadcast(db, badCamp2.campaign.id);   // nothing in this suite sends on it

  /* THE OTHER HALF OF THE LINE — a heading this rail has no file for — still
   * refuses, and is proved where it already lived: the picture-heading campaign
   * in the silent-loss section further down, which asserts start is refused with
   * `header_unfillable`. It is NOT duplicated here. */

  /* ═══════════════════════════════════════════════════════════════════════ */
  section(10, 'A CHECK NEVER TAKES A MESSAGE AWAY — it only adds what it learned');

  /* THIS SECTION IS THE RULING ITSELF (2026-09-15).
   *
   * It used to read: "after a sync, an unknown name is REFUSED — because the list
   * is now ground truth". That single sentence is what turned all 11 of this
   * venue's templates into refusals the first time anyone pressed the button, and
   * nothing in the app put them back. The list is not ground truth; it is one
   * read of one remote system, one way, and it is wrong in exactly the way that
   * costs everything. So it informs now. */

  expect(tpl.templateSendability(db, 'birthday_wish_v2', 'en').ok, true,
    'a known approved template passes');

  const unknown = tpl.templateSendability(db, 'never_heard_of_this', 'en');
  expect(unknown.ok, true, 'after a check, a name the list did not carry is STILL allowed');
  expect(unknown.verified, true, 'the check is recorded as having happened');
  expect(unknown.reason, '', 'and it produces no refusal at all');
  expectTrue(/did not find a message called/.test(String(unknown.advisory || '')),
    `it produces a warning instead — "${String(unknown.advisory || '').slice(0, 80)}…"`);
  expectTrue(/approved after the check|different WhatsApp Business Account/.test(String(unknown.advisory || '')),
    'which names the two innocent explanations, so a wrong account is diagnosable');

  const realWatermark = tpl.lastSyncAt(db);
  setSetting.run(tpl.SYNC_WATERMARK_KEY, '');
  const preSync = tpl.templateSendability(db, 'never_heard_of_this', 'en');
  expect(preSync.ok, true, 'BEFORE any check, an unknown name is allowed (shipped behaviour preserved)');
  expect(preSync.verified, false, 'but flagged unverified so the caller can warn honestly');
  expectTrue(/Nobody has checked yet what WhatsApp says about/.test(tpl.unverifiedWarning('never_heard_of_this')),
    'and the warning says the status is unknown, not that it is fine');
  /* IT MUST NOT PREDICT A FAILURE IT CANNOT KNOW. This line is attached to EVERY
   * campaign this venue creates today, and it used to end "every message in this
   * campaign will fail" — a prediction about a list nobody has read, in front of
   * the one button the 2026-09-15 ruling exists to make safe to press. */
  expectTrue(!/will fail|has never been synced/i.test(tpl.unverifiedWarning('never_heard_of_this')),
    'without predicting a failure it cannot know, and without the word "synced"',
    tpl.unverifiedWarning('never_heard_of_this'));
  expectTrue(/nothing is charged/.test(tpl.unverifiedWarning('never_heard_of_this')),
    'and it says what being wrong actually costs');

  /* THE ONE THING A CHECK MUST NOT CHANGE: the answer either side of it. Before
   * the ruling these two disagreed, and that disagreement WAS the defect. */
  expect(tpl.templateSendability(db, 'promo_blast_v1', 'en').ok, true,
    'a locally-known TURNED-DOWN template is allowed with no check recorded…');
  setSetting.run(tpl.SYNC_WATERMARK_KEY, realWatermark);
  expect(tpl.templateSendability(db, 'promo_blast_v1', 'en').ok, true,
    '…and allowed with one recorded — pressing the button changes nothing about what can go out');

  /* THE ONE STATUS THAT STILL REFUSES, and it is not WhatsApp's answer: this
   * app's own record that the owner wrote a message here and never sent it for
   * approval. No check can create it (applyRefresh skips drafts), so keeping it
   * cannot be used to strip anything. */
  const stillDraftId = generateId();
  db.prepare(`
    INSERT INTO whatsapp_templates (id, name, category, language, body, is_active, meta_status, var_spec, param_order)
    VALUES (?, 'never_submitted_v1', 'marketing', 'en', 'Hi {{name}}', 1, 'draft', '[]', '[]')
  `).run(stillDraftId);
  const neverSent = tpl.templateSendability(db, 'never_submitted_v1', 'en');
  expect(neverSent.ok, false, 'a message never sent for approval STILL refuses');
  expectTrue(/has not been sent to WhatsApp for approval yet/.test(neverSent.reason),
    'saying exactly that, with the one click that fixes it', neverSent.reason.slice(0, 110));
  db.prepare(`DELETE FROM whatsapp_templates WHERE id = ?`).run(stillDraftId);

  /* ═══════════════════════════════════════════════════════════════════════ */
  section(11, 'DELETE is refused while a live campaign uses the template');

  const users = tpl.campaignsUsingTemplate(db, 'promo_blast_v1');
  expect(users.length, 1, 'the draft campaign counts as a live user of its template');
  expect(users[0].state, 'draft', 'a draft is NOT finished, so it blocks deletion');

  bc.cancelBroadcast(db, badCamp.campaign.id);
  expect(tpl.campaignsUsingTemplate(db, 'promo_blast_v1').length, 0,
    'once cancelled it no longer blocks deletion');
  expect(tpl.campaignsUsingTemplate(db, 'winback_offer_v1').length, 0,
    'and a finished campaign never blocked it');

  /* ═══════════════════════════════════════════════════════════════════════ */
  section(12, 'WEBHOOK status update (bonus path) — polling stays the backstop');

  const hook = (name, event, reason) => ({
    entry: [{ changes: [{ field: 'message_template_status_update', value: {
      message_template_id: '55510', message_template_name: name,
      message_template_language: 'en', event, ...(reason ? { reason } : {}),
    } }] }],
  });

  /* ── WHO IS ALLOWED TO MOVE A STATUS (2026-09-16) ──
   *
   * The webhook address is public — Meta carries no session — so with no app
   * secret configured NOTHING that arrives there can be attributed to Meta.
   *
   *   MEASURED, end to end through the real route handlers: one unauthenticated
   *   POST naming this venue's 11 templates with event "DRAFT" took them from
   *   11/11 sendable to 0/11, and the sync's undo does not cover a forgery. That
   *   is the total-estate loss the advisory ruling was made to end, re-entering
   *   through the one door with no session, no CSRF token and no signature.
   *
   * So a WRITE requires a request this app could actually check. The inbox is
   * untouched by this and still accepts unsigned posts (refusing them would stop
   * this venue's live guest messages); polling re-learns every status anyway, so
   * the cost is latency, which is what the module was designed around. */
  const unsignedHook = tpl.applyTemplateStatusWebhook(db, hook('birthday_wish_v2', 'PAUSED', 'Low quality'));
  expect(unsignedHook.applied, 0, 'with no app secret, an unverifiable webhook writes NOTHING');
  expect(unsignedHook.untrusted, 1, 'and says how many events it refused to believe');
  expect(rowByName('birthday_wish_v2').meta_status, 'approved',
    'the row is exactly as the last poll left it');

  /* AND THE STATUS ITSELF IS AN ALLOWLIST, so even a verified request cannot
   * write a word Meta does not use. 'draft' is THIS APP'S record of the owner's
   * own unfinished action and the one status sendabilityFrom still refuses
   * outright — the exact value the forgery used. */
  const forgedDraft = tpl.applyTemplateStatusWebhook(db, hook('birthday_wish_v2', 'DRAFT'), { trusted: true });
  expect(forgedDraft.applied, 0, 'even a VERIFIED webhook cannot write "draft"');
  expect(forgedDraft.rejected.length, 1, 'it is reported as refused, not silently dropped');
  expect(rowByName('birthday_wish_v2').meta_status, 'approved', 'and the row does not move');
  expect(tpl.templateSendability(db, 'birthday_wish_v2', 'en').ok, true,
    'so the estate cannot be stripped through this door');
  expect(tpl.applyTemplateStatusWebhook(db, hook('birthday_wish_v2', 'UNKNOWN_AT_META'), { trusted: true }).applied, 0,
    'nor "unknown_at_meta", which is this app\'s conclusion about a whole list');
  expect(tpl.applyTemplateStatusWebhook(db, hook('birthday_wish_v2', 'WHATEVER_I_LIKE'), { trusted: true }).applied, 0,
    'nor any word at all — mapMetaStatus keeps an unrecognised value verbatim, so the guard is here');

  /* TEXT FROM OUTSIDE IS NOT QUOTED TO THE OWNER AS "WhatsApp's own words".
   *   MEASURED: one POST wrote a phishing sentence into meta_rejected_reason and
   *   it was rendered verbatim on the template screen and in the campaign-create
   *   warnings. Meta's reason is a single token (SCAM, INCORRECT_CATEGORY…). */
  const phish = tpl.applyTemplateStatusWebhook(
    db, hook('birthday_wish_v2', 'REJECTED', 'Your WhatsApp account will be closed. Call +91 90000 00000.'),
    { trusted: true },
  );
  expect(phish.applied, 1, 'the status itself still lands');
  expect(rowByName('birthday_wish_v2').meta_rejected_reason, '',
    'but a SENTENCE is dropped rather than repeated in this app\'s voice');
  expectTrue(!/90000 00000/.test(String(tpl.templateSendability(db, 'birthday_wish_v2', 'en').advisory || '')),
    'so nothing an attacker typed reaches the owner');
  expect(
    tpl.applyTemplateStatusWebhook(db, { entry: [{ changes: [{ field: 'message_template_status_update', value: {
      message_template_name: 'birthday_wish_v2', message_template_id: 'attacker-9999', event: 'PAUSED', reason: 'SCAM',
    } }] }] }, { trusted: true }).applied, 1, 'a one-word reason IS kept — it is what Meta sends');
  expect(rowByName('birthday_wish_v2').meta_rejected_reason, 'SCAM', 'verbatim');
  expect(rowByName('birthday_wish_v2').meta_template_id, '55510',
    'and a non-numeric template id is refused — that value addresses "Edit at Meta"');

  let w = tpl.applyTemplateStatusWebhook(db, hook('birthday_wish_v2', 'PAUSED', 'Low quality'), { trusted: true });
  expect(w.applied, 1, 'a status webhook for a known template applies');
  expect(rowByName('birthday_wish_v2').meta_status, 'paused', 'and moves the row to paused');
  /* The webhook's value is TIMELINESS, and that is what this asserts. What
   * WhatsApp says is shown, not enforced (the ruling above), so the proof is that
   * the warning appears at once rather than waiting for the next poll. */
  const hooked = tpl.templateSendability(db, 'birthday_wish_v2', 'en');
  expect(hooked.ok, true, 'the gate does not refuse it — WhatsApp said it, this app did not decide it');
  expectTrue(/on hold/i.test(String(hooked.advisory || '')),
    'but the owner is told immediately, without waiting for the next poll',
    String(hooked.advisory || '').slice(0, 100));

  w = tpl.applyTemplateStatusWebhook(db, hook('requisition_approved', 'APPROVED'), { trusted: true });
  expect(w.applied, 0, 'a webhook naming an UNMANAGED local template changes nothing');
  expect(rowByName('requisition_approved').meta_status, '',
    'the pre-existing free-form row is untouched — a webhook cannot conscript it');

  expect(tpl.applyTemplateStatusWebhook(db, { entry: [{ changes: [{ field: 'messages', value: {} }] }] }, { trusted: true }).applied, 0,
    'an unrelated webhook field is ignored without error');
  expect(tpl.applyTemplateStatusWebhook(db, 'not json at all', { trusted: true }).applied, 0,
    'unparseable input is ignored without throwing');

  queue(() => listResponse([
    metaTemplate({ id: '55502', name: 'promo_blast_v1', status: 'REJECTED', rejected_reason: VERBATIM }),
    metaTemplate({ id: '55510', name: 'birthday_wish_v2', status: 'APPROVED', category: 'UTILITY' }),
    metaTemplate({ id: '55501', name: 'winback_offer_v1', status: 'APPROVED' }),
  ]));
  await tpl.syncTemplateStatuses(db, SYNC_OPTS());
  expect(rowByName('birthday_wish_v2').meta_status, 'approved',
    'a later poll reconciles the row regardless of what the webhook said');

  /* ═══════════════════════════════════════════════════════════════════════ */
  section(13, 'REGRESSION — an untouched free-form template still sends');

  /**
   * THE FIXTURE IS THE VENUE'S REAL ESTATE, NOT A BARE NAME.
   *
   * This section's promise is that a template that predates the lifecycle keeps
   * working. Every such row in this venue is a ROW in whatsapp_templates with
   * meta_status = '' and a body written in the NAMED dialect
   * ('Hi {{name}}, … {{venue}}' — see requisition_approved, ct_winback,
   * ct_birthday). It used to be tested with a template NAME and no row at all,
   * which is a different thing entirely: with no row there is no wording, and a
   * campaign whose wording nobody here holds is refused on purpose (the
   * "holds no copy of the wording" gate) because the message it would really
   * send cannot be shown to anybody before the money is spent.
   *
   * So the promise is tested on the shape the venue actually has, and the
   * refusal for a bare name is pinned separately below — removing either would
   * fail this suite.
   */
  setSetting.run(tpl.SYNC_WATERMARK_KEY, '');

  // NOT insertDraft(): that helper defaults meta_status to 'draft', and 'draft'
  // is a LIFECYCLE state (never submitted) which the gate rightly refuses. The
  // shape being tested is meta_status = '' — outside the lifecycle altogether.
  db.prepare(`
    INSERT INTO whatsapp_templates
      (id, name, category, language, body, is_active, meta_category, meta_status, var_spec, meta_components)
    VALUES (?, 'legacy_promo_name', 'marketing', 'en', ?, 1, '', '', '[]', '')
  `).run(generateId(), 'Hi {{name}}, see you at {{venue}} soon!');
  expect(rowByName('legacy_promo_name').meta_status, '',
    'the fixture is a pre-existing free-form row, exactly like this venue\'s own 11');

  const legacyCamp = bc.createBroadcast(db, {
    name: 'Legacy free-form campaign',
    templateName: 'legacy_promo_name',
    language: 'en',
    paramOrder: ['name', 'venue'],
    previewBody: 'Hi {{name}}, see you at {{venue}} soon!',
    audience: { kind: 'phones', phones: [PH(7), PH(8)] },
    createdBy: 'test',
  });
  expectTrue(!!legacyCamp.campaign, 'a legacy campaign is created',
    legacyCamp.error ? `${legacyCamp.error}: ${legacyCamp.detail || ''}` : '');
  const legacyStart = bc.startBroadcast(db, legacyCamp.campaign.id);
  expectTrue(legacyStart.ok === true,
    'a legacy campaign still starts when nothing has ever been synced',
    legacyStart.detail || legacyStart.error || '');

  const beforeLegacy = sentCalls.length;
  set(bc.DRAIN_WATERMARK_KEY, String(Date.now() - 60_000));
  await bc.drainBroadcasts(db, { sender: mockSender, nowMs: Date.now(), venue: 'AKAN' });
  expect(sentCalls.length - beforeLegacy, 2, 'and still delivers to both recipients');
  expect(bc.getCampaign(db, legacyCamp.campaign.id).state, 'done', 'finishing normally');

  /* AND THE BARE NAME IS STILL REFUSED — the gate this fixture used to trip.
   * A campaign on a name nothing here holds a wording for cannot be shown to
   * the owner before it is paid for, so it fails closed. */
  const bareCamp = bc.createBroadcast(db, {
    name: 'Wording nobody here holds',
    templateName: 'name_only_at_meta',
    language: 'en',
    paramOrder: ['name'],
    previewBody: 'Hi {{1}}, see you soon!',
    audience: { kind: 'phones', phones: [PH(9)] },
    createdBy: 'test',
  });
  const bareStart = bareCamp.campaign ? bc.startBroadcast(db, bareCamp.campaign.id) : { ok: false, detail: bareCamp.detail };
  expect(bareStart.ok, false,
    'a campaign on a name this app holds no wording for is still refused');
  expectTrue(String(bareStart.detail || '').includes('holds no copy of the wording'),
    'and the refusal says the wording is not held here, not something vaguer',
    String(bareStart.detail || '').slice(0, 160));
  if (bareCamp.campaign) {
    expect(bc.getCampaign(db, bareCamp.campaign.id).state, 'draft',
      'it stays a draft — nothing armed, nothing charged');
  }

  setSetting.run(tpl.SYNC_WATERMARK_KEY, realWatermark);

  /* ═══════════════════════════════════════════════════════════════════════ */
  section(14, 'EDIT AT META — the corrected category rides along, but only when Meta allows it');

  /**
   * "Wrong category" is the most common rejection Meta issues (a promotional
   * body filed as UTILITY). The fix an admin makes is to change the category
   * and resubmit — and a resubmit of a REJECTED template must go through the
   * EDIT endpoint, because the rejected template still occupies its name on the
   * WABA and creating it again is refused as a duplicate.
   *
   * So: an edit of a REJECTED row must CARRY the corrected category, or the
   * most likely fix in the product is impossible. An edit of anything else must
   * NOT carry it — Meta refuses to recategorise an approved template, and
   * sending it would break an otherwise-fine wording edit.
   */
  const rejectedId = insertDraft({
    name: 'recat_after_rejection',
    body: GOOD_BODY,
    var_spec: GOOD_VARS,
    meta_category: 'MARKETING',      // the admin's correction, saved locally
    meta_status: 'rejected',
  });
  db.prepare(`UPDATE whatsapp_templates SET meta_template_id = ?, provider_language = 'en' WHERE id = ?`)
    .run('55777', rejectedId);

  queue(() => res(true, 200, { success: true }));
  r = await tpl.editTemplateAtMeta(db, rejectedId, { fetchImpl: mockFetch });
  expect(r.ok, true, 'editing a rejected template succeeds');
  let editCall = graphCalls[graphCalls.length - 1];
  expect(editCall.method, 'POST', 'an edit is a POST to the template id');
  expectTrue(editCall.url.includes('/v23.0/55777'),
    `posted to the template id, not the WABA edge — ${editCall.url}`);
  expect(editCall.body.category, 'MARKETING',
    'the CORRECTED CATEGORY is sent — without it the commonest rejection cannot be fixed');
  expectTrue(Array.isArray(editCall.body.components) && editCall.body.components.length > 0,
    'components are sent alongside it');
  expect(rowByName('recat_after_rejection').meta_status, 'pending',
    'and an accepted edit puts the template back into review');

  // The same call on an APPROVED row must withhold the category.
  const approvedId = insertDraft({
    name: 'reword_while_approved',
    body: GOOD_BODY,
    var_spec: GOOD_VARS,
    meta_category: 'MARKETING',
    meta_status: 'approved',
  });
  db.prepare(`UPDATE whatsapp_templates SET meta_template_id = ?, provider_language = 'en' WHERE id = ?`)
    .run('55778', approvedId);

  queue(() => res(true, 200, { success: true }));
  r = await tpl.editTemplateAtMeta(db, approvedId, { fetchImpl: mockFetch });
  expect(r.ok, true, 'rewording an approved template succeeds');
  editCall = graphCalls[graphCalls.length - 1];
  expect(editCall.body.category, undefined,
    'category is WITHHELD for an approved template — Meta refuses to recategorise one');
  expectTrue(Array.isArray(editCall.body.components),
    'the wording still goes, so the edit is not a no-op');

  /* ═══════════════════════════════════════════════════════════════════════ */
  section(15, 'BLOCKER REGRESSIONS — the five ways this module burned a queue');

  set('broadcast_msgs_per_min', '50');

  // ── 15a. PARAMETER COUNT (audit: an under-mapped campaign was created with
  //         HTTP 201 and the drain then truncated the list silently) ──
  const gapId = insertDraft({
    name: 'reg_paramgap', body: GOOD_BODY, var_spec: GOOD_VARS,
    meta_category: 'MARKETING', meta_status: 'approved',
  });
  db.prepare(`UPDATE whatsapp_templates SET meta_template_id='55801', provider_language='en', provider_template_name='reg_paramgap' WHERE id = ?`).run(gapId);

  expect(tpl.templateSendability(db, 'reg_paramgap', 'en').ok, true,
    'the template itself is genuinely approved — approval is NOT the gate under test');
  let pm = tpl.paramMappingCheck(db, 'reg_paramgap', ['name'], { fillable: bc.BROADCAST_VARS });
  expect(pm.ok, false, 'one parameter for a two-placeholder template is refused');
  expect(pm.expected, 2, 'the refusal knows how many Meta will demand');
  expectTrue(/every message in this campaign would be turned down — not just some/.test(pm.reason),
    'and says the whole queue would fail, not part of it');
  /* PLAIN RESTAURANT ENGLISH, asserted so the jargon cannot come back: this is
   * the live refusal reason for 7 of the venue's 11 templates. */
  expectTrue(!/parameter|placeholder|POSITION|components/i.test(pm.reason),
    'and it says it without "parameters", "placeholders", "POSITION" or "components"',
    pm.reason.slice(0, 160));
  expect(tpl.paramMappingCheck(db, 'reg_paramgap', ['name', 'venue', 'phone'], {}).ok, false,
    'over-mapping is refused too — Meta matches by count');
  expect(tpl.paramMappingCheck(db, 'reg_paramgap', ['name', 'venue'], {}).ok, true,
    'an exact match passes');

  // A THREE-variable template mapped with a variable this rail cannot fill:
  // paramOrderOf() drops 'date', so the drain would send 2 for 3 placeholders.
  const threeId = insertDraft({
    name: 'reg_threevar', body: 'Hi {{1}}, your table at {{2}} is booked for {{3}}.',
    var_spec: [
      { index: 1, name: 'name', example: 'Priya' },
      { index: 2, name: 'venue', example: 'AKAN' },
      { index: 3, name: 'date', example: '12 Aug' },
    ],
    meta_category: 'MARKETING', meta_status: 'approved',
  });
  db.prepare(`UPDATE whatsapp_templates SET meta_template_id='55806', provider_language='en', provider_template_name='reg_threevar' WHERE id = ?`).run(threeId);
  expect(tpl.templateSendability(db, 'reg_threevar', 'en').ok, true,
    'it too is genuinely approved');

  const gapCamp = bc.createBroadcast(db, {
    name: 'Regression — truncated params', templateName: 'reg_threevar', language: 'en',
    // 'date' is silently dropped by paramOrderOf() at send time: 3 stored → 2 sent
    paramOrder: ['name', 'venue', 'date'],
    previewBody: GOOD_BODY, audience: { kind: 'phones', phones: [PH(5), PH(6)] }, createdBy: 'test',
  });
  expect(bc.paramOrderOf(gapCamp.campaign).length, 2,
    'the drain would really send 2 parameters for a 3-placeholder template');
  expect(bc.droppedParamsOf(gapCamp.campaign).join(','), 'date',
    'and the dropped variable is known by name');
  const gapStart = bc.startBroadcast(db, gapCamp.campaign.id);
  expect(gapStart.error, 'param_mismatch', 'start refuses the mismatch');
  expectTrue(/"date"/.test(String(gapStart.detail || '')),
    'naming the variable a broadcast cannot fill');

  // force it 'sending' the way a campaign created before this gate would be
  db.prepare(`UPDATE wa_campaigns SET state='sending', started_at=datetime('now') WHERE id = ?`)
    .run(gapCamp.campaign.id);
  let sentBase = sentCalls.length;
  set(bc.DRAIN_WATERMARK_KEY, String(Date.now() - 60_000));
  d = await bc.drainBroadcasts(db, { sender: mockSender, nowMs: Date.now(), venue: 'AKAN' });
  expect(sentCalls.length, sentBase, 'the drain sent NOTHING for it — the queue is not burnt');
  expectTrue(d.campaigns_halted.some(h => h.id === gapCamp.campaign.id),
    'the campaign was halted instead');
  expect(bc.getCampaign(db, gapCamp.campaign.id).state, 'paused', "and parked as 'paused'");
  expect(bc.resumeBroadcast(db, gapCamp.campaign.id).error, 'param_mismatch',
    'resume refuses while the mismatch stands');

  // ── 15b. A REAL (name, language) CONFLICT must not leave a stale 'approved'
  //         (audit: the row was marked seen, skipped, and kept approved forever) ──
  const driftId = insertDraft({
    name: 'reg_lang_drift', body: GOOD_BODY, var_spec: GOOD_VARS,
    meta_category: 'MARKETING', meta_status: 'approved',
  });
  db.prepare(`UPDATE whatsapp_templates SET meta_template_id='55802', provider_language='en', provider_template_name='reg_lang_drift' WHERE id = ?`).run(driftId);

  queue(() => listResponse([
    metaTemplate({ id: '55803', name: 'reg_lang_drift', status: 'APPROVED', language: 'de' }),
  ]));
  const sync1 = await tpl.syncTemplateStatuses(db, SYNC_OPTS());
  expect(rowByName('reg_lang_drift').meta_status, 'unknown_at_meta',
    "a name Meta has ONLY in another language cannot keep 'approved'");
  expectTrue(sync1.name_conflicts.some(c => c.name === 'reg_lang_drift' && c.meta_language === 'de'),
    'the conflict is still reported honestly');
  expectTrue(sync1.regressed.some(c => c.name === 'reg_lang_drift' && c.from === 'approved'),
    'and the backwards move is flagged as a regression');
  // The ROW moving off 'approved' is the fix this case exists for, and it still
  // happens. What the gate then does with that status is the ruling's business:
  // "Meta's list did not carry it" warns, it does not refuse.
  const drift = tpl.templateSendability(db, 'reg_lang_drift', 'en');
  expect(drift.ok, true, 'the gate warns rather than refusing — that is the ruling, not this bug');
  expectTrue(/was not on the list/.test(String(drift.advisory || '')),
    `and the warning says what happened — "${String(drift.advisory || '').slice(0, 80)}…"`);

  // ── 15c. 'en' vs 'en_US' is a SPELLING, not a different template
  //         (audit: an APPROVED template was blocked forever and the campaign
  //         auto-paused, with a reason the same sync response contradicted) ──
  const usId = insertDraft({
    name: 'reg_en_us', body: GOOD_BODY, var_spec: GOOD_VARS,
    meta_category: 'MARKETING', meta_status: '',      // pre-existing free-form row
  });
  db.prepare(`UPDATE whatsapp_templates SET provider_language='en', provider_template_name='reg_en_us', send_as_template=1 WHERE id = ?`).run(usId);

  queue(() => listResponse([
    metaTemplate({ id: '55804', name: 'reg_en_us', status: 'APPROVED', language: 'en_US' }),
  ]));
  const sync2 = await tpl.syncTemplateStatuses(db, SYNC_OPTS());
  expect(sync2.name_conflicts.filter(c => c.name === 'reg_en_us').length, 0,
    'a locale-qualified spelling raises NO name conflict');
  expect(rowByName('reg_en_us').meta_status, 'approved', 'the row reconciles to APPROVED');
  expect(rowByName('reg_en_us').provider_language, 'en_US',
    "and learns Meta's exact spelling, which is the identity a send needs");
  const usSend = tpl.templateSendability(db, 'reg_en_us', 'en');
  expect(usSend.ok, true, "a campaign carrying 'en' is still sendable");
  expect(usSend.language, 'en_US', 'and is told to send it as en_US');
  expect(tpl.templateSendability(db, 'reg_en_us', 'de').ok, false,
    "while a genuinely different language ('de') is still refused");

  const usCamp = bc.createBroadcast(db, {
    name: 'Regression — en vs en_US', templateName: 'reg_en_us', language: 'en',
    paramOrder: ['name', 'venue'], previewBody: GOOD_BODY,
    audience: { kind: 'phones', phones: [PH(7), PH(8)] }, createdBy: 'test',
  });
  expect(bc.startBroadcast(db, usCamp.campaign.id).ok, true, 'it starts');
  sentBase = sentCalls.length;
  set(bc.DRAIN_WATERMARK_KEY, String(Date.now() - 60_000));
  d = await bc.drainBroadcasts(db, { sender: mockSender, nowMs: Date.now(), venue: 'AKAN' });
  expectTrue(!d.campaigns_halted.some(h => h.id === usCamp.campaign.id),
    'the drain does NOT halt it (audit: auto-paused with a false reason)');
  expectTrue(sentCalls.length > sentBase, 'messages actually went out');
  expect(sentCalls[sentCalls.length - 1].lang, 'en_US',
    "and every send used Meta's spelling of the language");

  // ── 15d. NO CREDENTIAL IN DURABLE STATE. Meta's commonest credential error
  //         quotes the token back; it was being stored and re-served. ──
  const SECRET = 'EAAtestsecrettoken1234567890';
  setSetting.run('wa_api_provider', 'meta_cloud');
  setSetting.run('wa_business_account_id', '999888777');
  setSetting.run('wa_access_token', SECRET);
  const leakId = insertDraft({
    name: 'reg_leak_probe', body: GOOD_BODY, var_spec: GOOD_VARS, meta_category: 'MARKETING',
  });
  queue(() => res(false, 401, {
    error: { message: `Malformed access token ${SECRET}`, type: 'OAuthException', code: 190 },
  }));
  r = await tpl.submitTemplate(db, leakId, { fetchImpl: mockFetch });
  expect(r.ok, false, 'Meta refused the submission');
  expectTrue(!String(r.error).includes(SECRET), 'the returned error carries NO access token');
  expectTrue(String(r.error).includes(tpl.REDACTED),
    `the redaction is visible — "${String(r.error).slice(0, 60)}"`);
  expectTrue(/Malformed access token/.test(String(r.error)),
    "Meta's own words survive: only the credential is replaced");
  expectTrue(!String(rowByName('reg_leak_probe').meta_last_error).includes(SECRET),
    'and nothing was written to meta_last_error that a backup could carry away');
  expectTrue(!tpl.redactSecrets('Bearer EAAZZrotatedtoken998877').includes('EAAZZrotatedtoken998877'),
    'a token ROTATED since the failure is still caught, by shape');
  expect(tpl.redactSecrets('(#132000) parameter count mismatch'), '(#132000) parameter count mismatch',
    'an ordinary Meta error is passed through verbatim');

  // ── 15e. ONE RESOLUTION RULE. The server judges `WHERE name = ?`, so the row
  //         that decides is the one whose OWN name equals what was posted. The
  //         wizard's picker now posts a row's own `name` and offers only rows
  //         that are self-named, which keeps client and server looking at the
  //         same row; these assertions pin the SERVER half of that rule, which
  //         still has to hold for a campaign created by any other route. ──
  const mirrorId = insertDraft({
    name: 'reg_ready_v2', body: GOOD_BODY, var_spec: GOOD_VARS,
    meta_category: 'UTILITY', meta_status: 'approved',
  });
  db.prepare(`UPDATE whatsapp_templates SET meta_template_id='55805', provider_language='en', provider_template_name='reg_ready_v2' WHERE id = ?`).run(mirrorId);
  const localId = insertDraft({
    name: 'reg_order_ready', body: GOOD_BODY, var_spec: GOOD_VARS,
    meta_category: '', meta_status: '',
  });
  db.prepare(`UPDATE whatsapp_templates SET provider_template_name='reg_ready_v2', provider_language='en', send_as_template=1 WHERE id = ?`).run(localId);

  expect(tpl.templateSendability(db, 'reg_ready_v2', 'en').ok, true,
    'the PROVIDER name — what the wizard actually posts — is sendable');
  expect(tpl.templateSendability(db, 'reg_order_ready', 'en').ok, false,
    'the local row name is not, and the picker must judge the posted name, not this one');

  // ── 15f. CATEGORY IS PART OF PERMISSION. Meta approves a template INTO a
  //         category and refuses a MARKETING send from a UTILITY or
  //         AUTHENTICATION one — for EVERY recipient, identically. Before this,
  //         nothing anywhere read meta_category: a broadcast on an approved
  //         UTILITY template was created 201-clean, "template_verified":true,
  //         and armed. These pin the gate AND its evidence discipline. ──
  const utilId = insertDraft({
    name: 'reg_utility_ack', body: GOOD_BODY, var_spec: GOOD_VARS,
    meta_category: 'UTILITY', meta_status: 'approved',
  });
  db.prepare(`UPDATE whatsapp_templates SET provider_language='en', provider_template_name='reg_utility_ack' WHERE id = ?`).run(utilId);
  const mktId = insertDraft({
    name: 'reg_marketing_offer', body: GOOD_BODY, var_spec: GOOD_VARS,
    meta_category: 'MARKETING', meta_status: 'approved',
  });
  db.prepare(`UPDATE whatsapp_templates SET provider_language='en', provider_template_name='reg_marketing_offer' WHERE id = ?`).run(mktId);
  const blankCatId = insertDraft({
    name: 'reg_cat_unknown', body: GOOD_BODY, var_spec: GOOD_VARS,
    meta_category: '', meta_status: 'approved',
  });
  // insertDraft defaults a blank meta_category to 'MARKETING', so the "never
  // recorded" case has to be written explicitly — the fixture, not the code.
  db.prepare(`UPDATE whatsapp_templates SET provider_language='en', provider_template_name='reg_cat_unknown', meta_category='' WHERE id = ?`).run(blankCatId);

  /* CATEGORY IS WHATSAPP'S ANSWER ABOUT STATE, so it warns (ruling 2026-09-15).
   * A list read off the wrong Business Account reports the wrong category for
   * every template a venue owns at once, which strips the estate exactly as the
   * absence case did; being wrong the other way costs one refused send, no
   * delivery, no charge and no guest's cooldown. The warning must still say all
   * of that, which is what this now asserts. */
  const utilAsMarketing = tpl.templateSendability(db, 'reg_utility_ack', 'en', { requireCategory: 'MARKETING' });
  expect(utilAsMarketing.ok, true,
    'an approved service-message template is not refused for an offer — it is flagged');
  expect(utilAsMarketing.category, 'UTILITY',
    'and the warning carries the category it actually has');
  expectTrue(/utility/i.test(String(utilAsMarketing.advisory || '')) && /every(one| guest)/i.test(String(utilAsMarketing.advisory || '')),
    'the warning names the category and says the whole list could be turned down',
    String(utilAsMarketing.advisory || '').slice(0, 160));
  expectTrue(/nothing is charged/i.test(String(utilAsMarketing.advisory || '')),
    'and says what it costs if he sends it anyway — which is what makes warning safe');
  expect(utilAsMarketing.status, 'approved',
    'status is still reported honestly — it IS approved, just not for this');

  expect(tpl.templateSendability(db, 'reg_utility_ack', 'en').ok, true,
    'WITHOUT requireCategory nothing changes — every other caller is untouched');

  const mkt = tpl.templateSendability(db, 'reg_marketing_offer', 'en', { requireCategory: 'MARKETING' });
  expect(mkt.ok, true, 'an approved MARKETING template passes the same gate');
  expect(mkt.categoryVerified, true, 'and its category rests on real evidence');

  const unknownCat = tpl.templateSendability(db, 'reg_cat_unknown', 'en', { requireCategory: 'MARKETING' });
  expect(unknownCat.ok, true,
    'an approved template whose category was never recorded is ALLOWED — refusing on no evidence would break every pre-lifecycle venue');
  expect(unknownCat.categoryVerified, false,
    'but it is flagged unverified so the caller warns instead of implying it was checked');
  expectTrue(tpl.categoryUnverifiedWarning('reg_cat_unknown', 'MARKETING').includes('never been recorded'),
    'and there is an honest warning to show for exactly that gap');

  // The send rail asks it the same way at create, start, resume and every drain
  // pass — `bc` is already loaded at the top of this file.
  expect(bc.BROADCAST_CATEGORY, 'MARKETING',
    'the broadcast rail declares what it is, once, for all four gates');
  const utilCamp = bc.campaignSendability(db, { template_name: 'reg_utility_ack', language: 'en' });
  expect(utilCamp.ok, true, 'campaignSendability flags the service-message template rather than refusing it');
  expectTrue(!!String(utilCamp.advisory || '').trim(), 'and carries the warning through to the campaign');
  const mktCamp = bc.campaignSendability(db, { template_name: 'reg_marketing_offer', language: 'en' });
  expect(mktCamp.ok, true, 'and passes the MARKETING one');
  expect(String(mktCamp.advisory || ''), '', 'with nothing to warn about');

  /* ═══════════════════════════════════════════════════════════════════════ */
  section(16, 'WEBHOOK AUTHENTICITY — only Meta can post to the public webhook');

  /**
   * The webhook URL has to be reachable without a login, so the signature Meta
   * puts on every request is the only thing separating Meta from a stranger with
   * the address. Before this existed, anyone could POST invented guest messages,
   * invented delivery receipts and invented template status changes straight into
   * the venue's records.
   *
   * THE REAL ROUTE RUNS HERE — not a re-implementation of it. Everything asserted
   * below is what a request to /api/whatsapp/webhook actually does.
   */
  const crypto = require('crypto');
  const webhookRoute = require(path.join(SRC, 'app', 'api', 'whatsapp', 'webhook', 'route.ts'));
  const logCount = () => db.prepare(`SELECT COUNT(*) AS n FROM whatsapp_events_log`).get().n;
  const post = (body, headers) => webhookRoute.POST(
    new Request('http://localhost/api/whatsapp/webhook', { method: 'POST', body, headers }),
  );
  const APP_SECRET = 'app-secret-for-the-test-only';
  const sign = (body, secret = APP_SECRET) =>
    'sha256=' + crypto.createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex');

  const HOOK_BODY = JSON.stringify({
    entry: [{ changes: [{ field: 'message_template_status_update', value: { message_template_name: 'sig_probe', event: 'PAUSED' } }] }],
  });

  /* — with NO app secret: accepted exactly as before — */
  db.prepare(`DELETE FROM settings WHERE key = ?`).run(tpl.APP_SECRET_SETTING_KEY);
  for (const k of tpl.APP_SECRET_ENV_KEYS) delete process.env[k];

  let noSecret = tpl.verifyWebhookSignature(HOOK_BODY, null, '');
  expect(noSecret.ok, true, 'with no app secret configured, a webhook is still accepted');
  expect(noSecret.enforced, false, 'and the answer says the check has no teeth yet');
  expect(noSecret.state, 'not_configured', 'naming the state exactly');
  expect(tpl.webhookSecurityState(db).signature_enforced, false,
    'the settings screen is told signature checking is OFF');
  expectTrue(!tpl.webhookSecurityState(db).detail.includes(APP_SECRET),
    'and that report never contains a secret value');

  let n = logCount();
  let r16 = await post(HOOK_BODY);
  expect(r16.status, 200, 'the live route accepts it (this venue has no secret yet — WhatsApp keeps working)');
  expect(logCount() - n, 1, 'and archives it, exactly as today');

  /* — with an app secret: unsigned, malformed and mis-signed are all refused — */
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(tpl.APP_SECRET_SETTING_KEY, APP_SECRET);
  expect(tpl.webhookAppSecret(db), APP_SECRET, 'the secret is picked up from settings');
  expect(tpl.webhookSecurityState(db).signature_enforced, true,
    'and the settings screen is told signature checking is ON');

  n = logCount();
  r16 = await post(HOOK_BODY);
  expect(r16.status, 401, 'an UNSIGNED post is refused');
  expect(logCount() - n, 0, 'and nothing about it is recorded — not even in the replayable event log');

  r16 = await post(HOOK_BODY, { 'X-Hub-Signature-256': 'sha256=not-hex' });
  expect(r16.status, 401, 'a malformed signature is refused');
  r16 = await post(HOOK_BODY, { 'X-Hub-Signature-256': sign(HOOK_BODY, 'the-wrong-secret') });
  expect(r16.status, 401, 'a signature made with the wrong secret is refused');
  r16 = await post(HOOK_BODY, { 'X-Hub-Signature-256': sign(HOOK_BODY).toUpperCase().replace('SHA256', 'sha256') });
  expect(r16.status, 200, 'an upper-case hex digest is accepted — Meta\'s casing is not our business');

  n = logCount();
  r16 = await post(HOOK_BODY, { 'X-Hub-Signature-256': sign(HOOK_BODY) });
  expect(r16.status, 200, 'a correctly signed post is accepted');
  expect(logCount() - n, 1, 'and archived');

  /* — THE RAW-BYTES TRAP. The digest is over the bytes as they arrived; a body
   *   that has been through JSON.parse → JSON.stringify is a different byte
   *   string and must NOT verify against the original signature. If this passes,
   *   the check is being done after a re-serialise and is worthless. — */
  const SPACED = '{ "entry" : [ ] }';
  expect(tpl.verifyWebhookSignature(SPACED, sign(SPACED), APP_SECRET).state, 'verified',
    'the signature verifies against the bytes as sent');
  expect(tpl.verifyWebhookSignature(JSON.stringify(JSON.parse(SPACED)), sign(SPACED), APP_SECRET).state, 'bad_signature',
    'and does NOT verify against a re-serialised copy — proof the digest is taken before any parse');

  /* — a body Meta signed but someone edited in flight — */
  const TAMPERED = HOOK_BODY.replace('PAUSED', 'APPROVED');
  expect(tpl.verifyWebhookSignature(TAMPERED, sign(HOOK_BODY), APP_SECRET).ok, false,
    'a signed body edited in flight no longer verifies');

  /* — an empty body cannot be waved through — */
  expect(tpl.verifyWebhookSignature('', null, APP_SECRET).ok, false,
    'an empty unsigned body is refused too');

  /* — the GET handshake is a DIFFERENT credential and must still work — */
  setSetting.run('wa_webhook_verify_token', 'verify-me');
  const g = await webhookRoute.GET(new Request('http://localhost/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=chal-123'));
  expect(g.status, 200, 'the GET verify handshake still succeeds with the app secret set');
  expect(await g.text(), 'chal-123', 'echoing the challenge, not JSON');
  const gBad = await webhookRoute.GET(new Request('http://localhost/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=chal-123'));
  expect(gBad.status, 403, 'and a wrong verify token is still refused');

  /* — the environment wins over the settings row, so a server-level secret
   *   cannot be downgraded from inside the app — */
  process.env[tpl.APP_SECRET_ENV_KEYS[0]] = 'env-level-secret';
  expect(tpl.webhookAppSecret(db), 'env-level-secret', 'the environment takes precedence');
  expect(tpl.webhookSecurityState(db).source, 'environment', 'and the screen says where it came from');
  delete process.env[tpl.APP_SECRET_ENV_KEYS[0]];

  // Leave the venue's real state behind: no app secret row.
  db.prepare(`DELETE FROM settings WHERE key = ?`).run(tpl.APP_SECRET_SETTING_KEY);

  /* ═══════════════════════════════════════════════════════════════════════ */
  section(17, 'BEFORE YOU REFRESH — what a status check would do, named, in advance');

  /**
   * THE WHOLE RULING, MEASURED — the section this change lives or dies on.
   *
   * WHAT THIS USED TO ASSERT. Every template in this venue can be used today for
   * ONE reason: WhatsApp's list has never been pulled, so the gate had no grounds
   * to refuse a name it had never heard of. The first check removed that reason
   * for every row at once, and this section asserted the consequence as correct:
   * paused stops, pending stops, absent stops, a service-message one stops for
   * campaigns. Four of five templates lost to one button press, and nothing in
   * the app put them back.
   *
   * WHAT IT ASSERTS NOW (owner's ruling, 2026-09-15). None of those four is a
   * fact about the message; each is one read of one remote list, and a read off
   * the wrong Business Account produces all four for every template a venue owns.
   * So the check INFORMS: after it, every one of the five can still send, each
   * carrying what WhatsApp said about it.
   *
   * AND THE LINE IS DRAWN, not erased. `est_media` is approved, marketing, and
   * carries a picture heading this screen has no picture for — WhatsApp refuses
   * that for every guest identically, whatever any list says. It is the ONE row
   * here a check may legitimately take away, and the before-you-check card must
   * name it and only it. Getting that backwards in either direction is the whole
   * risk: name everything and the estate is strippable again; name nothing and a
   * template that cannot send ships silently.
   */
  const estate = [
    ['est_keeps',   'Hi {{name}}, your table at {{venue}} is ready.'],
    ['est_paused',  'Hi {{name}}, we miss you at {{venue}}.'],
    ['est_pending', 'Hi {{name}}, something new at {{venue}} this week.'],
    ['est_utility', 'Sorry we missed your call to {{venue}}. Reply here.'],
    ['est_absent',  'Hi {{name}}, a small thank-you from {{venue}}.'],
    ['est_media',   'Hi {{name}}, a small thank-you from {{venue}}.'],
  ];
  for (const [nm, body] of estate) {
    db.prepare(`
      INSERT INTO whatsapp_templates
        (id, name, category, language, body, is_active, meta_category, meta_status, var_spec, meta_components,
         provider_template_name, provider_language, param_order, send_as_template)
      VALUES (?, ?, 'marketing', 'en', ?, 1, '', '', '[]', '', '', 'en', '[]', 0)
    `).run(generateId(), nm, body);
  }

  // The state the owner is actually in: never checked.
  setSetting.run(tpl.SYNC_WATERMARK_KEY, '');
  for (const [nm] of estate) {
    expect(tpl.templateSendability(db, nm, 'en', { requireCategory: 'MARKETING' }).ok, true,
      `${nm} can send a campaign TODAY (nothing has ever been checked)`);
  }

  /** Meta's answer: five of the six, in five different shapes; est_absent nowhere. */
  const metaAnswer = () => listResponse([
    metaTemplate({ id: '56001', name: 'est_keeps',   status: 'APPROVED', category: 'MARKETING' }),
    metaTemplate({ id: '56002', name: 'est_paused',  status: 'PAUSED',   category: 'MARKETING' }),
    metaTemplate({ id: '56003', name: 'est_pending', status: 'PENDING',  category: 'MARKETING' }),
    metaTemplate({ id: '56004', name: 'est_utility', status: 'APPROVED', category: 'UTILITY' }),
    // APPROVED, MARKETING — and unsendable from this screen for a reason no list
    // read can talk it out of: a picture heading, and a broadcast has no picture.
    metaTemplate({
      id: '56006', name: 'est_media', status: 'APPROVED', category: 'MARKETING',
      components: [
        { type: 'HEADER', format: 'IMAGE' },
        { type: 'BODY', text: 'Hi {{1}}, a small thank-you from {{2}}.' },
      ],
    }),
    metaTemplate({ id: '56005', name: 'est_brand_new', status: 'APPROVED', category: 'MARKETING' }),
  ]);

  const rowsBefore = db.prepare(`SELECT id, name, meta_status, meta_category FROM whatsapp_templates ORDER BY name`).all();
  queue(metaAnswer);
  const pre = await tpl.syncPreflight(db, SYNC_OPTS());
  expect(pre.ok, true, 'the dry run reads Meta and answers');
  expect(pre.first_check, true, 'and knows this is the first check');

  /* IT WRITES NOTHING — not a status, not an adoption, not the watermark. */
  expect(tpl.lastSyncAt(db), '', 'the dry run did NOT stamp the last-checked time');
  expectTrue(
    JSON.stringify(db.prepare(`SELECT id, name, meta_status, meta_category FROM whatsapp_templates ORDER BY name`).all())
      === JSON.stringify(rowsBefore),
    `and all ${rowsBefore.length} template rows are byte-identical afterwards`);
  expect(db.prepare(`SELECT COUNT(*) AS n FROM whatsapp_templates WHERE name = 'est_brand_new'`).get().n, 0,
    'the template Meta has and this app does not was NOT adopted by the dry run');

  const verdictOf = (nm) => (pre.rows.find(x => x.name === nm) || {}).verdict;
  expect(verdictOf('est_keeps'), 'keeps_working', 'approved + marketing at Meta: unaffected');
  expect(verdictOf('est_paused'), 'keeps_working', 'on hold at Meta: still sends — the owner is told, not stopped');
  expect(verdictOf('est_pending'), 'keeps_working', 'still under review at Meta: still sends');
  expect(verdictOf('est_utility'), 'keeps_working', 'approved as a service message: still sends');
  expect(verdictOf('est_absent'), 'keeps_working', "not on Meta's list at all: still sends");
  /* THE ONE REAL LOSS, and it is not an opinion about paperwork. */
  expect(verdictOf('est_media'), 'stops_campaigns',
    'a picture heading this screen cannot fill: THIS is what a check can take away');

  const atRiskNames = pre.at_risk.map(x => x.name);
  expect(JSON.stringify(atRiskNames), JSON.stringify(['est_media']),
    'and it is the ONLY thing named at risk — nothing is stripped on a status');
  expectTrue(pre.at_risk.every(x => String(x.note || '').trim().length > 20),
    'the at-risk row carries the gate\'s own reason, not a bare label');
  expectTrue(/no file to attach|picture|image/i.test(String((pre.at_risk[0] || {}).note || '')),
    'which names the heading', String((pre.at_risk[0] || {}).note || '').slice(0, 120));

  /* META SILENCE IS NO LONGER A LOSS. Absence from the list is exactly the answer
   * a wrong Business Account gives about every template a venue owns, so it is
   * reported and not acted on. This assertion is the inverse of the one it
   * replaced, and that inversion IS the fix. */
  const absent = pre.rows.find(x => x.name === 'est_absent');
  expect(absent.at_meta, false, 'est_absent is not at Meta');
  expect(absent.any_now, true, 'it can send now…');
  expect(absent.any_after, true, '…and still after — a list that omits it does not take it away');

  expectTrue(pre.new_at_meta.some(x => x.name === 'est_brand_new'),
    'and the check also says which of Meta\'s templates would be added');

  /* THE VENUE'S OWN LIVE TEMPLATES — the 11 real rows this snapshot carries, none
   * of which is in Meta's answer above. Before the ruling EVERY ONE of them was
   * named at risk by this very check. That was the measurement that ended the
   * old design, so it is pinned here in its fixed form. */
  const ownNames = ['ct_winback', 'ct_birthday', 'ct_enquiry_followup', 'requisition_approved']
    .filter(nm => db.prepare(`SELECT 1 FROM whatsapp_templates WHERE name = ? AND is_active = 1`).get(nm));
  expectTrue(ownNames.length > 0, `this venue's own templates are present to check (${ownNames.length})`);
  expectTrue(ownNames.every(nm => !atRiskNames.includes(nm)),
    "not one of the venue's own live templates is at risk, though Meta's list contains none of them",
    `at_risk = ${JSON.stringify(atRiskNames)}`);
  expectTrue(ownNames.every(nm => (pre.rows.find(x => x.name === nm) || {}).any_after === true),
    'every one of them can still send after the check');

  /* ── NOW THE REAL REFRESH: does the report name the same things? ── */
  queue(metaAnswer);
  const syncRes = await tpl.syncTemplateStatuses(db, SYNC_OPTS());
  expect(syncRes.ok, true, 'the real refresh runs');
  expectTrue(!!tpl.lastSyncAt(db), 'and NOW the last-checked time is stamped');

  const stoppedNames = syncRes.stopped.map(x => x.name);
  expect(JSON.stringify(stoppedNames), JSON.stringify(['est_media']),
    'the refresh report names the one template that actually stopped, and nothing else');
  expectTrue(!['est_paused', 'est_pending', 'est_utility', 'est_absent', 'est_keeps'].some(x => stoppedNames.includes(x)),
    'no template was stopped by what WhatsApp SAID about it');
  /* THE CARD AND THE REPORT MUST AGREE — the card promised this exact list. */
  expect(JSON.stringify(stoppedNames), JSON.stringify(atRiskNames),
    'and it is exactly what the before-you-check card predicted, name for name');

  /* A SWITCHED-OFF TEMPLATE IS NOT A LOSS. Nothing sends from an inactive row
   * (every picker filters is_active = 1), so claiming it stopped would be false.
   * The before-you-refresh check looks at the same set, so the two agree. */
  db.prepare(`UPDATE whatsapp_templates SET is_active = 0 WHERE name = 'est_absent'`).run();
  setSetting.run(tpl.SYNC_WATERMARK_KEY, '');
  queue(metaAnswer);
  const preOff = await tpl.syncPreflight(db, SYNC_OPTS());
  expectTrue(!preOff.at_risk.some(x => x.name === 'est_absent'),
    'a switched-off template is not named at risk');
  queue(metaAnswer);
  const syncOff = await tpl.syncTemplateStatuses(db, SYNC_OPTS());
  expectTrue(!syncOff.stopped.some(x => x.name === 'est_absent'),
    'and the refresh report does not claim it stopped either — the two lists agree');
  db.prepare(`UPDATE whatsapp_templates SET is_active = 1 WHERE name = 'est_absent'`).run();
  expect((syncRes.stopped.find(x => x.name === 'est_media') || {}).scope, 'campaigns',
    'the picture-heading one is reported as campaigns-only — replies and alerts never send a heading');

  /* AND THE GATE AGREES WITH BOTH, which is the only thing that matters. */
  for (const nm of ['est_paused', 'est_pending', 'est_absent', 'est_utility', 'est_keeps']) {
    const v = tpl.templateSendability(db, nm, 'en', { requireCategory: 'MARKETING' });
    expect(v.ok, true, `${nm} can still send after the check, exactly as predicted`);
  }
  for (const nm of ['est_paused', 'est_pending', 'est_absent', 'est_utility']) {
    expectTrue(!!String(tpl.templateSendability(db, nm, 'en', { requireCategory: 'MARKETING' }).advisory || '').trim(),
      `${nm} carries a warning saying what WhatsApp answered about it`);
  }
  expect(String(tpl.templateSendability(db, 'est_keeps', 'en', { requireCategory: 'MARKETING' }).advisory || ''), '',
    'and the one WhatsApp is happy with carries no warning at all');

  /* THE STRUCTURAL LOSS IS REAL AT THE START DOOR, not just in a report. */
  expect(bc.templateHeaderFill(db, 'est_media').ok, false,
    'est_media really is refused — by the heading gate, not by a status');
  expect(tpl.templateSendability(db, 'est_media', 'en', { requireCategory: 'MARKETING' }).ok, true,
    'and its APPROVAL is fine, which is what makes that refusal structural');

  /* ═══════════════════════════════════════════════════════════════════════ */
  section(18, 'VARIABLE ORDER — a spec written out of order reads by its index');

  /**
   * var_spec is a LIST whose entries carry their own `index`. Read in array
   * order, a spec written [{index:2,venue},{index:1,name}] describes the swap of
   * itself — and the swap is the one fault in this rail that costs money without
   * failing: WhatsApp fills blanks by position, accepts whatever arrives, and
   * charges for every message. Every reader of this column must sort by index.
   */
  const swapSpecId = insertDraft({
    name: 'order_probe',
    body: GOOD_BODY,
    var_spec: [{ index: 2, name: 'venue', example: 'AKAN' }, { index: 1, name: 'name', example: 'Priya' }],
    meta_status: 'approved',
  });
  db.prepare(`UPDATE whatsapp_templates SET provider_language = 'en' WHERE id = ?`).run(swapSpecId);

  const ph = tpl.templatePlaceholders(db, 'order_probe');
  expect(ph.source, 'var_spec', 'the authored spec is the evidence');
  expect(ph.count, 2, 'two blanks');
  expect(JSON.stringify(ph.names), JSON.stringify(['name', 'venue']),
    'and the names come back BY INDEX — the array order said venue, name');
  expect(tpl.paramOrderFromVarSpec(tpl.parseVarSpec(db.prepare(`SELECT var_spec FROM whatsapp_templates WHERE id = ?`).get(swapSpecId).var_spec)),
    JSON.stringify(['name', 'venue']),
    'the stored variable list agrees, because it always sorted');
  expect(JSON.stringify(tpl.buildMetaComponents(tpl.draftFromRow(db.prepare(`SELECT * FROM whatsapp_templates WHERE id = ?`).get(swapSpecId))).find(c => c.type === 'BODY').example.body_text[0]),
    JSON.stringify(['Priya', 'AKAN']),
    'and so do the examples Meta is shown');

  /* THE SENDING SIDE — the rail that decides what goes in each blank. */
  const meanings = bc.blankMeanings(db, 'order_probe', 2);
  expect(JSON.stringify(meanings.map(m => m.name)), JSON.stringify(['name', 'venue']),
    'the broadcast rail reads the same spec by index too');
  expect(JSON.stringify(meanings.map(m => m.evidence)), JSON.stringify(['var_spec', 'var_spec']),
    'and says the authored spec is what it used');
  const blanks = bc.broadcastBlanks(db, 'order_probe');
  expect(blanks.count, 2, 'broadcastBlanks counts two');
  expect(JSON.stringify(blanks.names), JSON.stringify(['name', 'venue']),
    'and names them by index, not by array order');

  /* A SPEC WHOSE INDICES ARE NOT A CLEAN 1..n NOW CLAIMS NOTHING.
   *
   * It used to fall back to ARRAY order, and array order inverts against
   * paramOrderFromVarSpec(), which sorts by index unconditionally: on
   * [{index:9,venue},{index:7,name}] the stored variable list came out
   * ["name","venue"] while these readers said ["venue","name"], so the HONEST
   * mapping was hard-refused and the SWAP was accepted and delivered (measured on
   * a row written straight into the table). Nothing shipped can write such a row —
   * the create route refuses it, the sync writes '[]', the submit route writes no
   * spec — so going silent costs nothing today and removes the one shape where two
   * readers of one column contradict each other. The COUNT is order-independent
   * and still known; only the names go quiet, and an unnamed blank is one the real
   * sentence gets read for. */
  const oddId = insertDraft({
    name: 'order_probe_odd',
    body: GOOD_BODY,
    var_spec: [{ index: 7, name: 'venue', example: 'AKAN' }, { index: 9, name: 'name', example: 'Priya' }],
    meta_status: 'approved',
  });
  db.prepare(`UPDATE whatsapp_templates SET provider_language = 'en' WHERE id = ?`).run(oddId);
  const odd = tpl.templatePlaceholders(db, 'order_probe_odd');
  expect(JSON.stringify(odd.names), JSON.stringify([]),
    'a spec whose indices say nothing trustworthy names nothing — it no longer guesses at array order');
  expect(odd.count, 2, 'but the count still stands, because a count has no order');
  const oddMeanings = bc.blankMeanings(db, 'order_probe_odd', 2);
  expectTrue(oddMeanings.every(m => m.evidence !== 'var_spec'),
    'and the broadcast rail does not read that spec either',
    JSON.stringify(oddMeanings.map(m => m.evidence)));
  /* THE TWO READERS AGREE AGAIN, which is the property that was broken: whatever
   * they say, they say the same thing, so the honest mapping can never be the
   * refused one. */
  db.prepare(`UPDATE whatsapp_templates SET param_order = ? WHERE id = ?`)
    .run(JSON.stringify(['name', 'venue']), oddId);   // what paramOrderFromVarSpec derives from that spec
  const oddVerdict = bc.mappingVerdict(db, 'order_probe_odd', ['name', 'venue']);
  expect(oddVerdict.hard.length, 0,
    'the mapping derived from the stored list is not hard-refused by a spec that disagrees with it');
  expectTrue(oddVerdict.needsAck,
    'it is read once instead, which is the rule for a blank nothing reliable names',
    JSON.stringify(oddVerdict.meanings.map(m => `${m.evidence}/proves=${m.proves}`)));
  /* AND THE OTHER DIRECTION: the swap is not silently accepted either. */
  const oddSwap = bc.mappingVerdict(db, 'order_probe_odd', ['venue', 'name']);
  expectTrue(oddSwap.needsAck, 'and so is the reverse mapping — neither order is taken on trust');

  /* — the mapping gate reads the corrected order, so its refusal names the right
   *   variable — */
  const mapCheck = tpl.paramMappingCheck(db, 'order_probe', ['name']);
  expect(mapCheck.ok, false, 'one parameter for a two-blank template is refused');
  expectTrue(mapCheck.reason.indexOf('"name"') < mapCheck.reason.indexOf('"venue"'),
    'and the refusal lists the variables in the order the guest would read them',
    mapCheck.reason);


  /* ═══════════════════════════════════════════════════════════════════════ */
  section(19, 'THE SELF-CONFIRMING MAPPING — a campaign cannot vouch for itself');

  /**
   * THE HOLE, MEASURED, THEN CLOSED.
   *
   * An adopted row (Meta's numbered body, no var_spec) names no blank, so the gate
   * asks for the real sentence to be read once — which is right, and was already
   * working. What broke it was the fourth evidence tier: the STORED VARIABLE LIST.
   * A campaign's mapping IS that list (the wizard seeds the slots from it), so
   * "the mapping agrees with the stored order" is the same record twice. It used to
   * count as PROOF, and one legacy PUT carrying nothing but `param_order` therefore
   * silenced the reading:
   *
   *   needsAck true → FALSE, unproven [1,2] → [], and the swapped campaign reached
   *   the transport with every guest reading "Hi Akan, we would love to see you at
   *   Rahul Verma again soon." The honest mapping was refused in its place.
   *
   * Everything below runs through the REAL routes, and the transport is a recorder.
   */
  const R_TEMPLATES = require(path.join(SRC, 'app/api/whatsapp/templates/route.ts'));
  const R_BCAST = require(path.join(SRC, 'app/api/crm-calls/broadcasts/route.ts'));
  const R_ACTION = require(path.join(SRC, 'app/api/crm-calls/broadcasts/[id]/action/route.ts'));

  const jreq = (url, body, method = 'POST') => new Request(url, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const jres = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });

  set('broadcast_enabled', '1');
  set('broadcast_cooldown_days', '0');
  set('broadcast_daily_cap', '0');
  set('broadcast_msgs_per_min', '60');

  /* An adopted row, exactly as the refresh writes one: Meta's numbered body in
   * both wordings, var_spec '[]', param_order '[]'. */
  const ADOPTED = 'ack_adopted_probe';
  db.prepare(`
    INSERT INTO whatsapp_templates
      (id, name, category, language, body, is_active, provider_template_name, provider_language,
       param_order, send_as_template, meta_template_id, meta_status, meta_category, meta_components, var_spec)
    VALUES (?, ?, 'marketing', 'en', ?, 1, ?, 'en', '[]', 1, 'meta-adopted', 'approved', 'MARKETING', ?, '[]')
  `).run(generateId(), ADOPTED, 'Hi {{1}}, we would love to see you at {{2}} again soon.', ADOPTED,
         JSON.stringify([{ type: 'BODY', text: 'Hi {{1}}, we would love to see you at {{2}} again soon.' }]));

  const v0 = bc.mappingVerdict(db, ADOPTED, ['name', 'venue']);
  expectTrue(v0.needsAck, 'an adopted row asks for the real sentence to be read');
  expect(JSON.stringify(v0.unproven), JSON.stringify([1, 2]), 'both blanks are unproven');

  /* THE LEGACY PUT: no meta_category, no body, no var_spec — just param_order.
   * It is now a MEANING CHANGE like any other, and on a Meta-answered row it is
   * held for confirmation: writing a variable list onto an approved template is a
   * claim about what Meta's blanks mean that Meta never made. Recording one where
   * nothing was recorded counts — "nothing" is not agreement. */
  const adoptedRow = rowByName(ADOPTED);
  const legacyPut = await jres(await R_TEMPLATES.PUT(
    jreq('http://t/api/whatsapp/templates', { id: adoptedRow.id, param_order: 'venue,name' }, 'PUT')));
  expect(legacyPut.status, 409, 'even the bare legacy param_order PUT is held for confirmation on an approved row');
  expect(String(rowByName(ADOPTED).param_order), '[]', 'and nothing was written');

  /* A PUT THAT CHANGES NOTHING ABOUT MEANING IS UNTOUCHED — the switch this
   * screen uses most (Active on/off) must not start asking questions. */
  const toggleOff = await jres(await R_TEMPLATES.PUT(
    jreq('http://t/api/whatsapp/templates', { id: adoptedRow.id, is_active: 0 }, 'PUT')));
  expect(toggleOff.status, 200, 'switching a template off still just works');
  await jres(await R_TEMPLATES.PUT(jreq('http://t/api/whatsapp/templates', { id: adoptedRow.id, is_active: 1 }, 'PUT')));

  /* CONFIRMED, the list is written — and the swap is STILL not believed. */
  const legacyOk = await jres(await R_TEMPLATES.PUT(jreq('http://t/api/whatsapp/templates',
    { id: adoptedRow.id, param_order: 'venue,name', confirm_meaning_change: true }, 'PUT')));
  expect(legacyOk.status, 200, 'confirmed, the legacy PUT goes through');
  expect(String(rowByName(ADOPTED).param_order), JSON.stringify(['venue', 'name']),
    'and it really did write the swapped list');

  const v1 = bc.mappingVerdict(db, ADOPTED, ['venue', 'name']);
  expectTrue(v1.needsAck,
    'THE SWAP STILL ASKS: agreement with the stored list no longer proves a blank',
    JSON.stringify(v1.meanings.map(m => `${m.evidence}/proves=${m.proves}`)));
  expect(v1.meanings[0].evidence, 'stored_order', 'the list is still consulted…');
  expect(v1.meanings[0].proves, false, '…it just cannot settle the question on its own');
  expect(v1.meanings[0].refusable, false, 'and it still never hard-refuses, exactly as before');

  /* AND THE WHOLE WAY TO THE WIRE: create is refused without a reading. */
  const swapCreate = await jres(await R_BCAST.POST(jreq('http://t/api/crm-calls/broadcasts', {
    name: 'Swap via stored order', template_name: ADOPTED, param_order: ['venue', 'name'],
    audience: { kind: 'phones', phones: [PH(1), PH(2)] }, language: 'en',
  })));
  expect(swapCreate.status, 409, 'the swapped campaign is refused at create, with no reading behind it');
  expectTrue(/read|confirm|word for word|really/i.test(JSON.stringify(swapCreate.body)),
    'and the refusal asks for the real message to be read',
    JSON.stringify(swapCreate.body).slice(0, 200));

  /* THE HONEST MAPPING IS NOT PUNISHED EITHER — it is asked the same question,
   * which is the point: neither order is taken on trust. */
  const honestCreate = await jres(await R_BCAST.POST(jreq('http://t/api/crm-calls/broadcasts', {
    name: 'Honest via stored order', template_name: ADOPTED, param_order: ['name', 'venue'],
    audience: { kind: 'phones', phones: [PH(1), PH(2)] }, language: 'en',
  })));
  expect(honestCreate.status, 409, 'and so is the honest one — the reading is about the sentence, not about who is asking');

  /* ═══════════════════════════════════════════════════════════════════════ */
  section(20, 'A SAVE MAY NOT RE-POINT AN APPROVED MESSAGE IN SILENCE');

  /**
   * MEASURED BEFORE THIS GATE: one PUT with the same body and the two variable
   * names swapped returned 200 with the response keys ["ok","template"], left
   * meta_status 'approved' and meta_template_id untouched, rewrote the examples
   * stored as "what Meta returned" from ["Priya","AKAN"] to ["AKAN","Priya"], and
   * the campaign that went out read "Hi Akan, we would love to see you at Rahul
   * Verma again soon." Meta was never told. The honest draft built before the flip
   * was then refused, quoting the CORRECT sentence as the fault.
   */
  const FLIP = 'meaning_flip_probe';
  const flipCreate = await jres(await R_TEMPLATES.POST(jreq('http://t/api/whatsapp/templates', {
    name: FLIP, category: 'marketing', language: 'en', meta_category: 'MARKETING',
    body: 'Hi {{1}}, we would love to see you at {{2}} again soon.',
    var_spec: [{ index: 1, name: 'name', example: 'Priya' }, { index: 2, name: 'venue', example: 'AKAN' }],
  })));
  expect(flipCreate.status, 200, 'a two-variable template is authored through the real route');
  const flipRow0 = rowByName(FLIP);
  db.prepare(`UPDATE whatsapp_templates SET meta_status='approved', meta_template_id='meta-flip' WHERE id = ?`).run(flipRow0.id);
  const compsBefore = String(rowByName(FLIP).meta_components);

  const flipTry = await jres(await R_TEMPLATES.PUT(jreq('http://t/api/whatsapp/templates', {
    id: flipRow0.id, name: FLIP, language: 'en', meta_category: 'MARKETING',
    body: 'Hi {{1}}, we would love to see you at {{2}} again soon.',
    var_spec: [{ index: 1, name: 'venue', example: 'AKAN' }, { index: 2, name: 'name', example: 'Priya' }],
  }, 'PUT')));
  expect(flipTry.status, 409, 'the silent re-point is REFUSED');
  expectTrue(!!flipTry.body.needs_confirmation, 'and it says it is waiting for a decision, not reporting a bug');
  expect(JSON.stringify(flipTry.body.meaning_change),
    JSON.stringify({ from: ['name', 'venue'], to: ['venue', 'name'] }),
    'naming both orders so the change is legible');
  expectTrue(/approved/i.test(String(flipTry.body.error)) && /Meta/.test(String(flipTry.body.error)),
    'and explaining that Meta keeps the old wording',
    String(flipTry.body.error).slice(0, 160));
  expect(String(rowByName(FLIP).var_spec), String(flipRow0.var_spec), 'NOTHING was written');
  expect(String(rowByName(FLIP).meta_components), compsBefore, 'and Meta\'s own components are untouched');

  /* A CONFIRMED change goes through — and says what it did. */
  const flipOk = await jres(await R_TEMPLATES.PUT(jreq('http://t/api/whatsapp/templates', {
    id: flipRow0.id, name: FLIP, language: 'en', meta_category: 'MARKETING',
    body: 'Hi {{1}}, we would love to see you at {{2}} again soon.',
    var_spec: [{ index: 1, name: 'venue', example: 'AKAN' }, { index: 2, name: 'name', example: 'Priya' }],
    confirm_meaning_change: true,
  }, 'PUT')));
  expect(flipOk.status, 200, 'confirmed, it is allowed — this is a decision, not a prohibition');
  expectTrue(/not been told|not told|Meta has not/i.test(String(flipOk.body.warning || '')),
    'and the answer says out loud that Meta has not been told',
    String(flipOk.body.warning || '').slice(0, 200));
  expect(String(rowByName(FLIP).param_order), JSON.stringify(['venue', 'name']), 'the new order is stored');

  /* META'S COMPONENTS SURVIVE A CONFIRMED EDIT TOO. They are Meta's record of what
   * Meta approved; rebuilding them locally asserted an approval Meta never gave,
   * and three gates read them as evidence. */
  expect(String(rowByName(FLIP).meta_components), compsBefore,
    'Meta\'s components are STILL what Meta returned — a local edit cannot forge them');

  /* AND EVERY READING THAT ANSWERED FOR THE OLD SENTENCE IS VOID.
   *
   * This is the half a confirmation alone would not fix: a campaign built and
   * confirmed against "Hi [name] … at [venue]" would otherwise keep its tick and
   * start sending the re-pointed sentence, because its mapping still matches the
   * record it was checked against. Proved end to end, through the real routes. */
  const FLIP2 = 'meaning_flip_probe_2';
  await jres(await R_TEMPLATES.POST(jreq('http://t/api/whatsapp/templates', {
    name: FLIP2, category: 'marketing', language: 'en', meta_category: 'MARKETING',
    body: 'Hi {{1}}, we would love to see you at {{2}} again soon.',
    var_spec: [{ index: 1, name: 'name', example: 'Priya' }, { index: 2, name: 'venue', example: 'AKAN' }],
  })));
  const flip2Row = rowByName(FLIP2);
  db.prepare(`UPDATE whatsapp_templates SET meta_status='approved', meta_template_id='meta-flip2',
              provider_template_name=?, provider_language='en' WHERE id = ?`).run(FLIP2, flip2Row.id);

  const honest = await jres(await R_BCAST.POST(jreq('http://t/api/crm-calls/broadcasts', {
    name: 'Honest before the flip', template_name: FLIP2, param_order: ['name', 'venue'],
    audience: { kind: 'phones', phones: [PH(5), PH(6)] }, language: 'en',
  })));
  expect(honest.status, 201, 'a campaign is built on the template as it stands');
  const honestId = String(honest.body?.campaign?.id || '');
  expectTrue(!!honestId, 'and it has an id');
  expectTrue(bc.startBroadcast(db, honestId).ok, 'it can be started, because its mapping matches the record');
  db.prepare(`UPDATE wa_campaigns SET state = 'draft' WHERE id = ?`).run(honestId);

  const flip2 = await jres(await R_TEMPLATES.PUT(jreq('http://t/api/whatsapp/templates', {
    id: flip2Row.id, name: FLIP2, language: 'en', meta_category: 'MARKETING',
    body: 'Hi {{1}}, we would love to see you at {{2}} again soon.',
    var_spec: [{ index: 1, name: 'venue', example: 'AKAN' }, { index: 2, name: 'name', example: 'Priya' }],
    confirm_meaning_change: true,
  }, 'PUT')));
  expect(flip2.status, 200, 'the meaning is re-pointed, with the confirmation');
  expectTrue(/reading/i.test(String(flip2.body.warning || '')),
    'and the answer says the confirmed readings were cleared',
    String(flip2.body.warning || '').slice(0, 200));

  const afterFlip = bc.startBroadcast(db, honestId);
  expect(afterFlip.ok, false, 'the campaign built on the OLD meaning can no longer be started');
  expect(afterFlip.error, 'param_mismatch', 'it is the mapping gate that stops it');
  expectTrue(/read|confirm/i.test(String(afterFlip.detail || '')),
    'and it asks for the real message to be read again',
    String(afterFlip.detail || '').slice(0, 200));

  /* LOSING A CLAIM IS NOT A CHANGE TO CONFIRM. A blank that stops being named is a
   * blank the gate then asks about — stricter, not looser — and an ordinary save on
   * an adopted row (whose editor has no names to offer) must not demand a decision
   * for writing down what was already unknown. */
  const lose = await jres(await R_TEMPLATES.PUT(
    jreq('http://t/api/whatsapp/templates', { id: rowByName(ADOPTED).id, param_order: '' }, 'PUT')));
  expect(lose.status, 200, 'dropping the variable list on an approved row needs no confirmation');
  expect(String(rowByName(ADOPTED).param_order), '', 'and it really was dropped');
  expectTrue(bc.mappingVerdict(db, ADOPTED, ['name', 'venue']).needsAck,
    'the blanks are simply unproven again, which is the safe direction');

  /* A LOCAL DRAFT IS UNTOUCHED BY ANY OF THIS — there is no approval to contradict. */
  const DRAFTY = 'meaning_draft_probe';
  const draftCreate = await jres(await R_TEMPLATES.POST(jreq('http://t/api/whatsapp/templates', {
    name: DRAFTY, category: 'marketing', language: 'en', meta_category: 'MARKETING',
    body: 'Hi {{1}}, we would love to see you at {{2}} again soon.',
    var_spec: [{ index: 1, name: 'name', example: 'Priya' }, { index: 2, name: 'venue', example: 'AKAN' }],
  })));
  expect(draftCreate.status, 200, 'a draft is authored');
  const draftFlip = await jres(await R_TEMPLATES.PUT(jreq('http://t/api/whatsapp/templates', {
    id: rowByName(DRAFTY).id, name: DRAFTY, language: 'en', meta_category: 'MARKETING',
    body: 'Hi {{1}}, we would love to see you at {{2}} again soon.',
    var_spec: [{ index: 1, name: 'venue', example: 'AKAN' }, { index: 2, name: 'name', example: 'Priya' }],
  }, 'PUT')));
  expect(draftFlip.status, 200, 'and re-ordering a DRAFT needs no confirmation — nothing is approved yet');
  expectTrue(String(rowByName(DRAFTY).meta_components).includes('AKAN'),
    'a draft\'s staged components are still rebuilt from the form, which is what /submit sends');

  /* ═══════════════════════════════════════════════════════════════════════ */
  section(21, 'THE REFRESH REPORTS EVERY GATE, NOT ONLY APPROVAL');

  /**
   * MEASURED BEFORE THIS FIX. A campaign on a template Meta then answered
   * APPROVED / MARKETING — with an IMAGE header — was reported "keeps_working ·
   * Meta has this one approved as a marketing template, so nothing changes", the
   * refresh's `stopped` list named nobody, and Start afterwards returned
   * header_unfillable, a refusal no operator action on the campaign can clear.
   * Three of four probes were silent losses like that. The card and the report now
   * ask every gate a campaign passes through, by MEASURING the refresh rather than
   * projecting it.
   */
  const MEDIA = 'gate_media_probe';
  const SHAPE = 'gate_shape_probe';
  for (const nm of [MEDIA, SHAPE]) {
    db.prepare(`
      INSERT INTO whatsapp_templates
        (id, name, category, language, body, is_active, meta_category, meta_status, var_spec, meta_components,
         provider_template_name, provider_language, param_order, send_as_template)
      VALUES (?, ?, 'marketing', 'en', ?, 1, '', '', '[]', '', '', 'en', ?, 0)
    `).run(generateId(), nm, 'Hi {{name}}, a note from {{venue}}.', JSON.stringify(['name', 'venue']));
  }
  setSetting.run(tpl.SYNC_WATERMARK_KEY, '');

  expectTrue(tpl.templateSendability(db, MEDIA, 'en', { requireCategory: 'MARKETING' }).ok,
    'both can send a campaign today (nothing has ever been checked)');
  expectTrue(bc.templateHeaderFill(db, MEDIA).ok, 'and no heading is known about either');

  /** Meta holds both APPROVED and MARKETING — the GOOD case, where the old report
   *  was silent: one with a picture heading, one with three blanks to our two. */
  const gateAnswer = () => listResponse([
    metaTemplate({
      id: '57001', name: MEDIA, status: 'APPROVED', category: 'MARKETING',
      components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Hi {{1}}, a note from {{2}}.' }],
    }),
    metaTemplate({
      id: '57002', name: SHAPE, status: 'APPROVED', category: 'MARKETING',
      components: [{ type: 'BODY', text: 'Hi {{1}}, a note from {{2}} about {{3}}.' }],
    }),
  ]);

  queue(gateAnswer);
  const gatePre = await tpl.syncPreflight(db, SYNC_OPTS());
  expect(gatePre.ok, true, 'the before-you-refresh check runs');
  const gateVerdict = (nm) => (gatePre.rows.find(x => x.name === nm) || {}).verdict;
  expect(gateVerdict(MEDIA), 'stops_campaigns',
    'the picture-heading template is named as stopping campaigns, though Meta holds it APPROVED and MARKETING');
  expect(gateVerdict(SHAPE), 'stops_campaigns',
    'and so is the one whose blanks no longer match what this app maps');
  const gateNote = (nm) => String((gatePre.rows.find(x => x.name === nm) || {}).note || '');
  expectTrue(/heading/i.test(gateNote(MEDIA)), 'with the heading named as the reason', gateNote(MEDIA));
  expectTrue(/variable|blank|position/i.test(gateNote(SHAPE)), 'and the blank count as the other', gateNote(SHAPE));
  expectTrue(gatePre.at_risk.some(x => x.name === MEDIA) && gatePre.at_risk.some(x => x.name === SHAPE),
    'both are in the at-risk list the screen leads with');
  expect(gatePre.measured, true, 'and the check says it really measured');

  /* THE DRY RUN WROTE NOTHING — the whole refresh ran inside a transaction that
   * was rolled back, so this is the strongest form of the claim. */
  expect(tpl.lastSyncAt(db), '', 'the dry run did not stamp the last-checked time');
  expect(String(rowByName(MEDIA).meta_status), '', 'nor any status');
  expect(String(rowByName(MEDIA).meta_components), '', 'nor Meta\'s components');

  queue(gateAnswer);
  const gateSync = await tpl.syncTemplateStatuses(db, SYNC_OPTS());
  expect(gateSync.ok, true, 'the real refresh runs');
  expect(gateSync.applied, true, 'and it applied');
  const gateStopped = gateSync.stopped.map(x => x.name);
  expectTrue(gateStopped.includes(MEDIA) && gateStopped.includes(SHAPE),
    'the report names BOTH — the card and the report agree by construction',
    JSON.stringify(gateStopped));
  expect((gateSync.stopped.find(x => x.name === MEDIA) || {}).scope, 'campaigns',
    'the picture heading costs campaigns only');

  /* AND THE START DOOR AGREES WITH THE REPORT, which is the only thing that
   * matters: the report is now made of the start door's own answers. */
  const mediaCamp = bc.createBroadcast(db, {
    name: 'Media probe', templateName: MEDIA, language: 'en', paramOrder: ['name', 'venue'],
    previewBody: 'Hi {{1}}, a note from {{2}}.',
    audience: bc.parseAudience({ kind: 'phones', phones: [PH(3)] }), createdBy: 'test-admin',
  });
  const mediaStart = bc.startBroadcast(db, mediaCamp.campaign.id);
  expect(mediaStart.ok, false, 'a campaign on the picture-heading template cannot start');
  expect(mediaStart.error, 'header_unfillable', 'for exactly the reason the report gave');

  /* ═══════════════════════════════════════════════════════════════════════ */
  section(22, 'A REFRESH THAT WOULD STOP EVERYTHING, AND THE WAY BACK');

  /**
   * THE ESTATE REQUIREMENT. Every template here sends today for one reason: Meta's
   * list has never been pulled. The first refresh takes that reason away from all
   * of them at once, and nothing in the app could put it back: the watermark had a
   * writer and no eraser, the generic settings door refuses `wa_` keys, and the
   * WhatsApp config route writes only its own whitelist. So one press was final,
   * recoverable only by hand-editing the production database.
   *
   * Two things answer that here. A refresh whose answer would stop EVERY message
   * this venue can send is rolled back and reported instead of applied, because an
   * empty or foreign answer from Meta (wrong WABA id, wrong token, a half-failed
   * list) looks exactly like "they are all gone" and the cost of believing it is
   * the whole estate. And whatever does land can be put back exactly as it was.
   */
  const wipeDb = () => db.prepare(`SELECT name, meta_status, meta_category, meta_components, meta_template_id,
                                          meta_rejected_reason, provider_template_name, provider_language
                                   FROM whatsapp_templates ORDER BY name`).all();

  // A fresh, isolated estate: switch every other row off so this section's
  // "everything" is its own three templates.
  const restoreActive = db.prepare(`SELECT id FROM whatsapp_templates WHERE is_active = 1`).all().map(r => r.id);
  db.prepare(`UPDATE whatsapp_templates SET is_active = 0`).run();
  const estate2 = ['wipe_a', 'wipe_b', 'wipe_c'];
  for (const nm of estate2) {
    db.prepare(`
      INSERT INTO whatsapp_templates
        (id, name, category, language, body, is_active, meta_category, meta_status, var_spec, meta_components,
         provider_template_name, provider_language, param_order, send_as_template)
      VALUES (?, ?, 'marketing', 'en', ?, 1, '', '', '[]', '', '', 'en', '[]', 0)
    `).run(generateId(), nm, `Hi {{name}}, a word from {{venue}} (${nm}).`);
  }
  setSetting.run(tpl.SYNC_WATERMARK_KEY, '');
  for (const nm of estate2) {
    expectTrue(tpl.templateSendability(db, nm, 'en', { requireCategory: 'MARKETING' }).ok,
      `${nm} can send today`);
  }
  const digest = (v) => require('crypto').createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
  const beforeWipe = digest(wipeDb());

  /* META ANSWERS WITH NOTHING — the accident case. */
  queue(() => listResponse([]));
  const wipe = await tpl.syncTemplateStatuses(db, { fetchImpl: mockFetch, impact: bc.measureSendability });
  expect(wipe.ok, false, 'a refresh that would stop everything is REFUSED');
  expect(wipe.applied, false, 'and it applied nothing');
  expectTrue(!!wipe.needs_confirmation, 'it asks for a confirmation instead');
  /* WHAT IT MAY NO LONGER CLAIM (ruling 2026-09-15). An empty answer stops
   * nothing — an unrecognised name is a warning now — so `stopped` is EMPTY here
   * and the message must not say otherwise. It used to read "this app currently
   * sends 0: " followed by "would stop every WhatsApp message this venue can
   * send": a count of nothing, a list of nobody, and an outcome that cannot
   * happen. Announcing a consequence that will not occur is the same defect the
   * ruling exists to end, pointed the other way. */
  expect(wipe.stopped.length, 0, 'and names nothing as stopped, because nothing would stop');
  expectTrue(/Business Account|token/i.test(String(wipe.error)),
    'while pointing at the likeliest real cause first', String(wipe.error).slice(0, 160));
  expectTrue(estate2.every(nm => String(wipe.error).includes(nm)),
    'it counts what this venue CAN send, by name — not the empty stopped list',
    String(wipe.error).slice(0, 220));
  expectTrue(/would stop/i.test(String(wipe.error)) === false || /none of them would stop/i.test(String(wipe.error)),
    'and never claims those messages would stop', String(wipe.error).slice(0, 220));
  expectTrue(!/\bsends 0\b|\b0:\s*\./.test(String(wipe.error)),
    'no "currently sends 0:" — the count is real', String(wipe.error).slice(0, 220));
  expect(tpl.lastSyncAt(db), '', 'the watermark was NOT stamped — the rollback is total');
  expect(digest(wipeDb()), beforeWipe, 'and every template row is byte-identical');
  for (const nm of estate2) {
    expectTrue(tpl.templateSendability(db, nm, 'en', { requireCategory: 'MARKETING' }).ok,
      `${nm} still sends, because nothing happened`);
  }

  /* CONFIRMED, IT LANDS — this is a decision the owner is allowed to take. */
  queue(() => listResponse([]));
  const wipe2 = await tpl.syncTemplateStatuses(db, SYNC_OPTS());
  expect(wipe2.ok, true, 'confirmed, the same refresh is applied');
  expect(wipe2.applied, true, 'and this time it landed');
  expectTrue(!!tpl.lastSyncAt(db), 'the watermark is stamped');
  expect(wipe2.stopped.length, 0, 'and the report still names nobody as stopped');
  for (const nm of estate2) {
    expectTrue(tpl.templateSendability(db, nm, 'en', { requireCategory: 'MARKETING' }).ok,
      `${nm} can STILL send after the empty answer was saved — the confirmation took nothing away`);
  }
  expectTrue(estate2.every(nm =>
    /did not find a message called/.test(String(tpl.templateSendability(db, nm, 'en').advisory || ''))),
    'each one now carries a warning saying the list did not contain it');
  expectTrue(!!wipe2.undo_available, 'a way back is offered anyway — the warnings can be cleared');

  /* THE WAY BACK. */
  const undo = tpl.undoLastSync(db);
  expect(undo.ok, true, 'the refresh can be put back');
  expect(tpl.lastSyncAt(db), '', 'the watermark is back to never-checked — exactly the state before');
  expect(digest(wipeDb()), beforeWipe, 'every column of every row is byte-identical to before the refresh');
  for (const nm of estate2) {
    expectTrue(tpl.templateSendability(db, nm, 'en', { requireCategory: 'MARKETING' }).ok,
      `${nm} sends again after the undo`);
  }
  const undoAgain = tpl.undoLastSync(db);
  expect(undoAgain.ok, false, 'and the undo is used up — it cannot be applied twice');
  expect(tpl.syncUndoAvailable(db).available, false, 'the screen is told there is nothing left to undo');

  /* AN ADOPTION IS TAKEN BACK TOO — unless a campaign now depends on it. */
  queue(() => listResponse([
    metaTemplate({ id: '58001', name: 'wipe_a', status: 'APPROVED', category: 'MARKETING' }),
    metaTemplate({ id: '58002', name: 'wipe_new', status: 'APPROVED', category: 'MARKETING' }),
  ]));
  const adoptSync = await tpl.syncTemplateStatuses(db, SYNC_OPTS());
  expect(adoptSync.ok, true, 'a refresh that adopts a new template runs');
  expectTrue(!!rowByName('wipe_new'), 'and the new template is here');
  const undo2 = tpl.undoLastSync(db);
  expect(undo2.ok, true, 'it can be put back as well');
  expect(rowByName('wipe_new'), undefined, 'and the adopted row is gone again');

  queue(() => listResponse([metaTemplate({ id: '58003', name: 'wipe_keep', status: 'APPROVED', category: 'MARKETING' })]));
  await tpl.syncTemplateStatuses(db, SYNC_OPTS());
  expectTrue(!!rowByName('wipe_keep'), 'a second adoption');
  bc.createBroadcast(db, {
    name: 'Depends on the adopted one', templateName: 'wipe_keep', language: 'en',
    paramOrder: [], previewBody: 'Hi there.',
    audience: bc.parseAudience({ kind: 'phones', phones: [PH(4)] }), createdBy: 'test-admin',
  });
  const undo3 = tpl.undoLastSync(db);
  expect(undo3.ok, true, 'the undo still runs');
  expectTrue(!!rowByName('wipe_keep'), 'but it KEEPS a template a campaign now depends on');
  expect(undo3.kept.length, 1, 'and says so');
  expectTrue(/campaign/i.test(String(undo3.kept[0].why)), 'naming why', String(undo3.kept[0].why).slice(0, 120));

  /* ── AN UNDO PUTS BACK THE REFRESH, NOT THE CLOCK ──
   *
   * The restore used to write the snapshot over EVERY row unconditionally, which
   * is only correct while the refresh is the last thing that touched them.
   *
   *   MEASURED. A refresh recorded a template as approved; WhatsApp then pushed
   *   DISABLED/SCAM by webhook and the broadcast picker showed it; the undo wiped
   *   the status, the reason and the checked-at time, said nothing about having
   *   done so, and no path in the app could re-apply it. Under the advisory
   *   design that deletes the WARNING — the only thing the redesign relies on —
   *   for a template WhatsApp has killed. */
  queue(() => listResponse([
    metaTemplate({ id: '58004', name: 'wipe_a', status: 'APPROVED', category: 'MARKETING' }),
    metaTemplate({ id: '58005', name: 'wipe_b', status: 'APPROVED', category: 'MARKETING' }),
  ]));
  await tpl.syncTemplateStatuses(db, SYNC_OPTS());
  expect(rowByName('wipe_a').meta_status, 'approved', 'a refresh records two templates as approved');
  expect(rowByName('wipe_b').meta_status, 'approved', 'both of them');
  const afterRefresh = rowByName('wipe_a').meta_status_checked_at;
  tpl.applyTemplateStatusWebhook(db, {
    entry: [{ changes: [{ field: 'message_template_status_update', value: {
      event: 'DISABLED', message_template_name: 'wipe_a', reason: 'SCAM',
    } }] }],
  }, { trusted: true });
  expect(rowByName('wipe_a').meta_status, 'disabled', 'WhatsApp then disables one of them by webhook');
  /* NOTE: both writes land in the SAME SECOND here, and utcString() stores whole
   * seconds — so a timestamp rule could not tell them apart. The undo compares
   * the row against what the refresh actually LEFT on it, which has no
   * resolution to lose. */
  expect(rowByName('wipe_a').meta_status_checked_at, afterRefresh,
    'in the same second, so the stamp alone cannot separate the two writes');
  const undo4 = tpl.undoLastSync(db);
  expect(undo4.ok, true, 'the undo runs');
  expect(rowByName('wipe_a').meta_status, 'disabled',
    'and the NEWER WhatsApp status survives it');
  expect(rowByName('wipe_a').meta_rejected_reason, 'SCAM', 'with its reason');
  expect(undo4.skipped.map(s => s.name).join(','), 'wipe_a', 'the undo names what it left alone');
  expectTrue(!/approved/.test(String(rowByName('wipe_b').meta_status)),
    'while every untouched row really was put back');

  db.prepare(`DELETE FROM wa_campaigns WHERE template_name = 'wipe_keep'`).run();
  db.prepare(`UPDATE whatsapp_templates SET is_active = 0 WHERE name IN ('wipe_a','wipe_b','wipe_c','wipe_keep')`).run();
  for (const id of restoreActive) db.prepare(`UPDATE whatsapp_templates SET is_active = 1 WHERE id = ?`).run(id);

  /* ═══════════════════════════════════════════════════════════════════════ */
  section(23, 'WEBHOOK AUTHENTICITY — armed from inside the app, and honest about itself');

  /**
   * THE CHECK WAS CORRECT AND DORMANT. The app secret could only come from a
   * server environment variable; none was set, no route could write one, and
   * nothing in the product could turn the check on. Measured on the deployed
   * shape: an unsigned forged event returned 200, was archived, and a fabricated
   * guest message landed in the inbox. A control nobody can switch on is not a
   * control.
   */
  const R_SECRET = require(path.join(SRC, 'app/api/whatsapp/templates/sync/webhook-secret/route.ts'));
  const R_HOOK = require(path.join(SRC, 'app/api/whatsapp/webhook/route.ts'));
  const R_SYNCROUTE = require(path.join(SRC, 'app/api/whatsapp/templates/sync/route.ts'));

  for (const k of tpl.APP_SECRET_ENV_KEYS) delete process.env[k];
  db.prepare(`DELETE FROM settings WHERE key = ?`).run(tpl.APP_SECRET_SETTING_KEY);
  tpl.resetWebhookTelemetry(db);

  const state0 = tpl.webhookSecurityState(db);
  expect(state0.signature_enforced, false, 'with no secret anywhere, nothing is checked');
  expect(state0.can_set_here, true, 'and the screen is told a secret can be typed in here');

  const tooShort = await jres(await R_SECRET.POST(jreq('http://t/x', { secret: 'abc' })));
  expect(tooShort.status, 400, 'a value too short to be a Meta app secret is refused');
  const spaced = await jres(await R_SECRET.POST(jreq('http://t/x', { secret: 'abcdef 0123456789abcdef' })));
  expect(spaced.status, 400, 'and so is one that was pasted with something around it');

  const REAL_SECRET = '0123456789abcdef0123456789abcdef';
  const armed = await jres(await R_SECRET.POST(jreq('http://t/x', { secret: REAL_SECRET })));
  expect(armed.status, 200, 'the app secret can be armed from inside the product');
  expect(armed.body.webhook_security.signature_enforced, true, 'and checking is on straight away');
  expectTrue(!JSON.stringify(armed.body).includes(REAL_SECRET), 'the reply never contains the secret');
  expect(tpl.webhookAppSecret(db) === REAL_SECRET, true, 'it is what the verifier will use');

  /* IT IS MASKED ON THE WAY OUT. The key matches the credential pattern both the
   * settings endpoint and the admin SQL console redact with. */
  const { SECRET_KEY_RE } = require(path.join(SRC, 'lib/secret-keys.ts'));
  expectTrue(SECRET_KEY_RE.test(tpl.APP_SECRET_SETTING_KEY),
    'and the settings key is redacted by shape, so neither settings door can read it back');

  const signReal = (body) => 'sha256=' + require('crypto').createHmac('sha256', REAL_SECRET).update(body).digest('hex');
  const hookReq = (body, sig) => new Request('http://t/api/whatsapp/webhook', {
    method: 'POST',
    headers: sig ? { 'content-type': 'application/json', 'x-hub-signature-256': sig } : { 'content-type': 'application/json' },
    body,
  });
  const hookLogCount = () => db.prepare(`SELECT COUNT(*) AS n FROM whatsapp_events_log`).get().n;
  const hookMsgCount = () => db.prepare(`SELECT COUNT(*) AS n FROM wa_messages`).get().n;

  const FORGED = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: {
      metadata: { display_phone_number: '15550001111', phone_number_id: 'pnid' },
      contacts: [{ wa_id: '919000000199', profile: { name: 'Forged Guest' } }],
      messages: [{ from: '919000000199', id: 'wamid.FORGERY_PROBE', timestamp: '1700000000', type: 'text', text: { body: 'let me in' } }],
    } }] }],
  });

  let l0 = hookLogCount(), m0 = hookMsgCount();
  const unsigned = await R_HOOK.POST(hookReq(FORGED, null));
  expect(unsigned.status, 401, 'an unsigned forgery is refused');
  expect(hookLogCount(), l0, 'and not even archived — a stored forgery is a replayable one');
  expect(hookMsgCount(), m0, 'nothing reaches the inbox');

  const wrong = await R_HOOK.POST(hookReq(FORGED, 'sha256=' + 'f'.repeat(64)));
  expect(wrong.status, 401, 'a wrongly signed one is refused too');
  expect(hookLogCount(), l0, 'with nothing recorded');

  const genuine = await R_HOOK.POST(hookReq(FORGED, signReal(FORGED)));
  expect(genuine.status, 200, 'a correctly signed event is accepted');
  expect(hookLogCount(), l0 + 1, 'and archived');
  expectTrue(hookMsgCount() > m0, 'and ingested');

  /* THE TYPO PROBLEM: a refusal writes nothing by design, so a wrong secret is a
   * SILENT outage behind a green banner. The state now reports what has actually
   * verified. */
  const armedState = tpl.webhookSecurityState(db);
  expect(armedState.signature_enforced, true, 'checking is on');
  expectTrue(!!armedState.last_verified_at, 'and the screen can say when a real event last verified');
  expect(armedState.warn, false, 'so it reads as reassurance only once something really passed');

  tpl.resetWebhookTelemetry(db);
  const neverVerified = tpl.webhookSecurityState(db);
  expect(neverVerified.signature_enforced, true, 'a freshly armed secret is enforcing…');
  expect(neverVerified.warn, true, '…and is shown as a WARNING until one real event passes it');
  expectTrue(/nothing has passed/i.test(neverVerified.headline),
    'the headline says exactly that', neverVerified.headline);

  /* ARMING A NEW SECRET FORGETS THE OLD ONE'S SUCCESS. */
  await R_HOOK.POST(hookReq(FORGED, signReal(FORGED)));
  expectTrue(!!tpl.webhookSecurityState(db).last_verified_at, 'a verification is recorded again');
  const rearm = await jres(await R_SECRET.POST(jreq('http://t/x', { secret: 'fedcba9876543210fedcba9876543210' })));
  expect(rearm.status, 200, 'a replacement secret is saved');
  expect(tpl.webhookSecurityState(db).last_verified_at, '',
    'and the old secret\'s success is forgotten — no stale green tick for a secret that has verified nothing');
  await jres(await R_SECRET.POST(jreq('http://t/x', { secret: REAL_SECRET })));

  /* CANNOT TELL ≠ NOT CONFIGURED. One failed settings read used to disarm the
   * whole check and accept an unsigned forgery (measured). */
  expect(tpl.verifyWebhookSignature(FORGED, null, '', { unreadable: true }).ok, false,
    'an unreadable secret lookup REFUSES rather than accepting');
  expect(tpl.verifyWebhookSignature(FORGED, null, '', { unreadable: true }).state, 'secret_unreadable',
    'and says which state it is in');
  expect(tpl.verifyWebhookSignature(FORGED, signReal(FORGED), REAL_SECRET, { unreadable: true }).ok, false,
    'even a correctly signed request is refused while the check cannot be established');
  const blindProxy = new Proxy(db, {
    get(t, k) {
      if (k === 'prepare') {
        return (sql) => {
          if (/FROM settings WHERE key/.test(String(sql))) throw new Error('SQLITE_BUSY: database is locked');
          return t.prepare(sql);
        };
      }
      const v = t[k];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  const blind = tpl.webhookAppSecretLookup(blindProxy);
  expect(blind.unreadable, true, 'a settings read that throws is reported as "cannot tell"');
  expect(blind.secret, '', 'with no secret');
  expectTrue(tpl.webhookSecurityState(blindProxy).warn, 'and the screen warns about it');

  /* THE ENVIRONMENT STILL WINS, so a browser cannot override a server-set secret. */
  process.env.WA_APP_SECRET = 'env-secret-0123456789abcdef';
  expect(tpl.webhookAppSecret(db) === 'env-secret-0123456789abcdef', true, 'the environment takes precedence');
  expect(tpl.webhookSecurityState(db).can_set_here, false, 'and the screen stops offering the field');
  delete process.env.WA_APP_SECRET;

  /* A BODY NOBODY HAS AUTHENTICATED IS NOT READ WITHOUT A LIMIT. */
  const huge = new Request('http://t/api/whatsapp/webhook', {
    method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(50 * 1024 * 1024) },
    body: FORGED,
  });
  expect((await R_HOOK.POST(huge)).status, 413, 'an oversized unauthenticated body is refused before it is read');

  /* THE VERIFY HANDSHAKE IS UNBROKEN, and now constant-time. */
  setSetting.run('wa_webhook_verify_token', 'handshake-token');
  const okGet = await R_HOOK.GET(new Request('http://t/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=handshake-token&hub.challenge=CHAL-42'));
  expect(okGet.status, 200, 'the verify handshake still answers');
  expect(await okGet.text(), 'CHAL-42', 'echoing the challenge verbatim');
  expect((await R_HOOK.GET(new Request('http://t/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x'))).status,
    403, 'a wrong token is still refused');
  expect((await R_HOOK.GET(new Request('http://t/api/whatsapp/webhook?hub.verify_token=handshake-token&hub.challenge=x'))).status,
    403, 'and so is a request with no mode');

  /* THE STATE IS VISIBLE WHERE THE WEBHOOK IS SET UP. */
  const syncGet = await jres(await R_SYNCROUTE.GET());
  expect(syncGet.status, 200, 'the admin diagnostics read answers');
  expectTrue(!!syncGet.body.webhook_security, 'carrying the webhook security state');
  expectTrue(!JSON.stringify(syncGet.body).includes(REAL_SECRET), 'and never the secret itself');
  expectTrue(syncGet.body.undo !== undefined, 'and whether the last refresh can still be put back');

  db.prepare(`DELETE FROM settings WHERE key = ?`).run(tpl.APP_SECRET_SETTING_KEY);


  /* ═══════════════════════════════════════════════════════════════════════ */
  section(24, 'THE ROUTE ITSELF — the confirmation, the undo, and a measurement that fails');

  /**
   * The library is proved above; this is the HTTP door, because a defect that
   * lives in the route is a defect that ships. Everything here goes through the
   * exported POST/GET handlers.
   *
   * THE TRANSPORT: the route does not take an injected fetchImpl (it is the
   * production caller), so globalThis.fetch is swapped for a STUB for the length
   * of this section and restored in a finally. The stub refuses any method other
   * than GET and any URL that is not Meta's template-list read, counts every call,
   * and returns a fixture — so an outward action could not be made even by a code
   * path this section did not anticipate. The thrower is back before the section
   * ends, and the count is printed.
   */
  const realThrower = globalThis.fetch;
  let routeCalls = 0, routeBadCalls = 0;
  let routeList = [];
  try {
    globalThis.fetch = async (url, init) => {
      routeCalls++;
      const method = String((init && init.method) || 'GET').toUpperCase();
      if (method !== 'GET' || !/message_templates/.test(String(url))) {
        routeBadCalls++;
        throw new Error(`BLOCKED: this section allows only the template-list read — saw ${method} ${url}`);
      }
      return { ok: true, status: 200, json: async () => ({ data: routeList }) };
    };

    /* An isolated estate again: three rows, nothing else active. */
    const keepActive = db.prepare(`SELECT id FROM whatsapp_templates WHERE is_active = 1`).all().map(r => r.id);
    db.prepare(`UPDATE whatsapp_templates SET is_active = 0`).run();
    const routeNames = ['route_a', 'route_b', 'route_c'];
    for (const nm of routeNames) {
      db.prepare(`
        INSERT INTO whatsapp_templates
          (id, name, category, language, body, is_active, meta_category, meta_status, var_spec, meta_components,
           provider_template_name, provider_language, param_order, send_as_template)
        VALUES (?, ?, 'marketing', 'en', ?, 1, '', '', '[]', '', '', 'en', '[]', 0)
      `).run(generateId(), nm, `Hi {{name}}, a word from {{venue}} (${nm}).`);
    }
    setSetting.run(tpl.SYNC_WATERMARK_KEY, '');
    const routeRows = () => db.prepare(`SELECT name, meta_status, meta_category FROM whatsapp_templates ORDER BY name`).all();
    const routeBefore = digest(routeRows());

    /* ── THE DRY RUN, over HTTP ── */
    routeList = [];
    const prevRes = await jres(await R_SYNCROUTE.POST(jreq('http://t/api/whatsapp/templates/sync?preview=1', {})));
    expect(prevRes.status, 200, 'POST ?preview=1 answers');
    expect(prevRes.body.preview, true, 'and says it is a preview');
    expect(prevRes.body.total_loss, true, 'it reports that the refresh will stop and ask');
    expect(prevRes.body.total_loss_reason, 'empty_list',
      'and says WHY — an empty answer, not messages that stop (the screen must word these differently)');
    expect((prevRes.body.at_risk || []).length, 0,
      'so nothing is named at risk, because nothing is at risk');
    expect(digest(routeRows()), routeBefore, 'and it wrote nothing');
    expect(tpl.lastSyncAt(db), '', 'not even the last-checked time');

    /* ── THE REFRESH, UNCONFIRMED, over HTTP ── */
    const refuse = await jres(await R_SYNCROUTE.POST(jreq('http://t/api/whatsapp/templates/sync', {})));
    expect(refuse.status, 409, 'the unconfirmed refresh is refused with a 409, not a 500');
    expect(refuse.body.applied, false, 'it says nothing was applied');
    expect(refuse.body.needs_confirmation, true, 'and that it is waiting for a decision');
    expect((refuse.body.stopped || []).length, 0, 'and claims nothing would have stopped, because nothing would');
    expectTrue(/Business Account|token/i.test(String(refuse.body.error || '')),
      'pointing at the likeliest real cause instead',
      String(refuse.body.error || '').slice(0, 160));
    expect(digest(routeRows()), routeBefore, 'and the rows are untouched');

    /* ── CONFIRMED, over HTTP ── */
    const applied = await jres(await R_SYNCROUTE.POST(jreq('http://t/api/whatsapp/templates/sync', { confirm_stops: true })));
    expect(applied.status, 200, 'with confirm_stops it lands');
    expect(applied.body.applied, true, 'and says so');
    expect((applied.body.stopped || []).length, 0, 'the report names nobody as stopped');
    expectTrue(routeNames.every(nm =>
      tpl.templateSendability(db, nm, 'en', { requireCategory: 'MARKETING' }).ok),
      'and every one of them can still send — saving the answer took nothing away');
    expectTrue((applied.body.notes || []).some(n => /put it back/i.test(n)),
      'the notes still point at the way back, so the warnings can be cleared',
      JSON.stringify(applied.body.notes || []).slice(0, 200));
    expect(applied.body.undo_available, true, 'and the way back is offered in the payload');

    /* ── GET says the undo is available ── */
    const getRes = await jres(await R_SYNCROUTE.GET());
    expect(getRes.body.undo.available, true, 'the admin read also says an undo is available');

    /* ── UNDO, over HTTP ── */
    const undoRes = await jres(await R_SYNCROUTE.POST(jreq('http://t/api/whatsapp/templates/sync?undo=1', {})));
    expect(undoRes.status, 200, 'POST ?undo=1 puts it back');
    expect(digest(routeRows()), routeBefore, 'and every row is byte-identical to before the refresh');
    expect(tpl.lastSyncAt(db), '', 'with the watermark back to never-checked');
    expectTrue(/never checked|state this app was in/i.test(String(undoRes.body.note || '')),
      'and it says plainly what state the app is now in',
      String(undoRes.body.note || '').slice(0, 200));
    const undoTwice = await jres(await R_SYNCROUTE.POST(jreq('http://t/api/whatsapp/templates/sync?undo=1', {})));
    expect(undoTwice.status, 409, 'a second undo is refused, not silently ignored');

    /* ── A MEASUREMENT THAT FAILS MUST NOT READ AS "NOTHING STOPPED" ──
     * The probe is what tells the operator what a refresh took away. If it throws,
     * `stopped` is empty for want of an answer, not because the answer was "none",
     * and saying "nothing changed" there would be a false clean bill of health. */
    routeList = [];
    const broken = await tpl.syncTemplateStatuses(db, {
      fetchImpl: mockFetchListOnly, impact: () => { throw new Error('probe exploded'); }, allowStops: true,
    });
    expect(broken.ok, true, 'the refresh still reconciles when the measurement explodes');
    expect(broken.applied, true, 'and still applies — the reconciliation is the backstop the gate rests on');
    expect(broken.measured, false, 'but it reports that nothing was measured');
    expect(broken.stopped.length, 0, 'so the empty list means "not measured", not "nothing stopped"');
    tpl.undoLastSync(db);

    /* ── AND WITHOUT allowStops IT MUST STOP AND ASK ──
     *
     * The assertion above runs with allowStops:true, which bypasses the
     * everything-would-stop guard entirely — so for a long time it proved a
     * failure mode that could not happen while never exercising the guard under
     * a degraded measurement. That is how this survived four rounds:
     *
     *   MEASURED. An empty measurement was read as "this venue has nothing to
     *   lose", so BOTH confirmation gates vanished on the one input that means
     *   the guard cannot do its job, and a refresh that is correctly refused as
     *   a total loss landed silently instead. */
    routeList = [];
    const unmeasured = await tpl.syncTemplateStatuses(db, {
      fetchImpl: mockFetchListOnly, impact: () => { throw new Error('probe exploded'); },
    });
    expect(unmeasured.ok, false, 'a refresh whose measurement failed STOPS and asks');
    expect(unmeasured.applied, false, 'nothing is written until the owner says go on');
    expect(unmeasured.needs_confirmation, true, 'and it is a question, never a dead end');
    expectTrue(/could not work out what saving/i.test(String(unmeasured.error || '')),
      'saying plainly that it could not tell, rather than "nothing would stop"',
      String(unmeasured.error || '').slice(0, 160));

    /* THE PROBE THAT SHIPS DOES NOT THROW — IT ANSWERS EMPTY. measureSendability
     * catches its own database errors, so `probeFailed` was unreachable from
     * production: one lost lock race on a single SELECT reported measured=TRUE,
     * stopped=0 and applied the refresh. An empty answer from a database that
     * plainly has templates is now a failed measurement, not an all-clear. */
    routeList = [];
    const silentlyBlind = await tpl.syncTemplateStatuses(db, {
      fetchImpl: mockFetchListOnly, impact: () => ({ templates: [], campaigns: [] }),
    });
    expect(silentlyBlind.measured, false,
      'a probe that returns NOTHING while the venue has templates is a failed measurement');
    expect(silentlyBlind.applied, false, 'so that refresh stops and asks too');
    const saidSo = await tpl.syncTemplateStatuses(db, {
      fetchImpl: mockFetchListOnly, impact: () => ({ templates: [], campaigns: [], failed: true }),
    });
    expect(saidSo.measured, false, 'and a probe that SAYS it failed is believed');

    db.prepare(`UPDATE whatsapp_templates SET is_active = 0 WHERE name IN ('route_a','route_b','route_c')`).run();
    for (const id of keepActive) db.prepare(`UPDATE whatsapp_templates SET is_active = 1 WHERE id = ?`).run(id);
  } finally {
    globalThis.fetch = realThrower;
  }
  expect(routeBadCalls, 0, 'the stub was never asked for anything but the template-list read');
  expectTrue(routeCalls > 0, `and the route really did go through it (${routeCalls} call(s))`);
  expect(globalThis.fetch === realThrower, true, 'the network thrower is back in place');

  /* ═══════════════════════════════════════════════════════════════════════ */
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`template-lifecycle-tests: ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log(`  • ${f}`);
  }
  console.log(`snapshot: ${SNAP}`);
  assertSandboxed(db);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\nFATAL:', e);
  process.exit(1);
});
