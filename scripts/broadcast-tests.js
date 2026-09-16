#!/usr/bin/env node
/**
 * BROADCAST ENGINE PROOF — consent rails + queued campaign drain, transport MOCKED.
 *
 * Run with:  node scripts/broadcast-tests.js     (also: npm test)
 *
 * Sandbox contract is copied from scripts/run-tests.js verbatim: every test
 * runs against a VACUUM INTO snapshot of fnb-controller.db (readonly source
 * handle) in a fresh os.tmpdir() dir, process.chdir()ed into BEFORE requiring
 * src/lib/db.ts, with an abort-hard sandbox guard. The REAL shipped code runs
 * — processWebhookEvent for ingest/status, drainBroadcasts for the queue —
 * with only the provider transport replaced by an injected recorder.
 *
 * WHAT IT PROVES (the build gates):
 *   1  STOP via the real webhook path opts the guest out; lookalikes don't
 *   2  preview counts exclusions honestly (opted-out / cooldown / dup / no-phone)
 *   3  throttle: per-drain budget follows msgs_per_min × elapsed, observed
 *   4  a STOP arriving AFTER the audience was queued still excludes at send
 *   5  cross-campaign cooldown: a guest in two campaigns gets ONE message
 *      (and the win-back rail counts as a prior marketing send too)
 *   6  pause stops within one message; restart (fresh DB handle) resumes with
 *      no double-send; crashed 'sending' claims are NEVER auto-retried
 *   7  real status webhooks move recipients sent→delivered→read (monotone),
 *      131049 counts as CAPPED not failed, 131050 revokes consent
 *   8  an inbound reply marks the recipient 'replied'
 *   9  the daily cap stops the drain mid-campaign
 *  10  master flag OFF = the drain sends nothing
 *  11  cost rate + estimate are captured at start time
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

/* ── NOTHING IN THIS SUITE MAY REACH THE NETWORK ────────────────────────────
 *
 * Every send here goes through an injected recorder, but "we passed a mock
 * everywhere" is an intention, not a fact. This makes it a fact: the global
 * fetch throws, so any path that forgot the injected transport fails the run
 * loudly instead of quietly billing the venue for a real WhatsApp message and
 * burning a guest's cooldown. Installed before any of the lane's modules load. */
globalThis.fetch = (...a) => {
  throw new Error(`BLOCKED: a real network call was attempted — ${String(a[0])}. Every transport in this suite must be injected.`);
};

const REPO = path.resolve(__dirname, '..');
const LIVE_DB = path.join(REPO, 'fnb-controller.db');
const SRC = path.join(REPO, 'src');

/* ── 0. SNAPSHOT (identical discipline to run-tests.js) ─────────────────── */

if (!fs.existsSync(LIVE_DB)) {
  console.error(`broadcast-tests: ${LIVE_DB} not found — nothing to snapshot.`);
  process.exit(2);
}

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fnb-broadcast-tests-')));
const SNAP = path.join(TMP, 'fnb-controller.db');
{
  const src = new Database(LIVE_DB, { readonly: true });
  src.exec(`VACUUM INTO '${SNAP.replace(/'/g, "''")}'`);
  src.close();
}

process.chdir(TMP);

/* ── 1. TYPESCRIPT LOADER (same hook as run-tests.js) ───────────────────── */

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

const lib = (rel) => require(path.join(SRC, 'lib', rel));

const dbMod = lib('db.ts');
const { generateId } = dbMod;
const db = dbMod.getDb();      // boots the migrations (creates the new tables)

function assertSandboxed(handle) {
  const open = path.resolve(handle.name || '');
  if (path.resolve(LIVE_DB) === open || !open.startsWith(path.resolve(TMP))) {
    console.error(`\nFATAL: tests opened ${open}, which is not the snapshot in ${TMP}. Aborting.`);
    process.exit(3);
  }
}
assertSandboxed(db);

const consent = lib('wa-consent.ts');
const bc = lib('wa-broadcast.ts');
const inbox = lib('wa-inbox.ts');
const ctSettings = lib('ct/settings.ts');

/* ── 2. HARNESS ─────────────────────────────────────────────────────────── */

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

/* ── 3. FIXTURES ────────────────────────────────────────────────────────── */

// Distinct fake numbers — deliberately outside any real guest range in the DB.
const PH = (n) => `+9190000000${String(n).padStart(2, '0')}`;
const KEY = (n) => `90000000${String(n).padStart(2, '0')}`;
const WA = (n) => `9190000000${String(n).padStart(2, '0')}`;   // Meta 'from'/'recipient_id' form

const insGuest = db.prepare(`INSERT INTO ct_guests (id, phone_e164, name) VALUES (?, ?, ?)`);
for (let i = 1; i <= 30; i++) insGuest.run(generateId(), PH(i), `Test Guest ${i}`);

/* THE FIXTURE REFLECTS A SYNCED INSTALL, DELIBERATELY.
 *
 * Every campaign below is built on 'test_broadcast'. That name existed in no
 * table, which was fine only while the venue had never synced: with no sync
 * watermark, templateSendability() allows an unknown name on the grounds that
 * it has no evidence either way. The moment anyone clicks "Refresh templates"
 * a watermark is written, Meta's list becomes ground truth, and every unknown
 * name is refused as "not at Meta" — so this required build gate would have
 * gone red on the first real sync, in a suite that is supposed to be measuring
 * the queue, not the lifecycle.
 *
 * So the fixture seeds the template as an APPROVED MARKETING row with a
 * one-blank body matching the ['name'] mapping the campaigns use, AND writes
 * the sync watermark. The suite now runs the shape a live install actually has
 * after a refresh, and section 14 proves the watermark no longer breaks it.
 *
 * THE LOCAL WORDING IS THE NAMED ONE, and that is the shape a RECONCILED row
 * really has: a refresh never overwrites the `body` column (it writes statuses,
 * categories and Meta's components), so a row that existed before the refresh
 * keeps the named copy this app was authored with, while meta_components carries
 * Meta's numbered answer for the same sentence. Both wordings describe one
 * message, so the local names line up with Meta's numbers and vouch for the
 * mapping — no reading is asked for, and this suite measures the queue.
 *
 * It used to be seeded with a NUMBERED local body, which is the ADOPTED shape
 * (a row a refresh created out of nothing). In that shape no record names any
 * blank, and the one thing that appeared to — the stored variable list — is the
 * campaign's own mapping read back, so agreement with it proves nothing. That
 * self-confirmation was a live hole (see section 16), and closing it means the
 * adopted shape now asks for the real sentence to be read once. Keeping this
 * fixture on the numbered body would have been measuring the ack gate by
 * accident in twelve places instead of measuring it on purpose in one.
 */
const SYNC_KEY = 'wa_templates_last_sync_at';
db.prepare(`
  INSERT INTO whatsapp_templates
    (id, name, category, language, body, is_active, created_at, updated_at,
     provider_template_name, provider_language, param_order, send_as_template,
     meta_status, meta_category, meta_components, var_spec)
  VALUES (?, 'test_broadcast', 'marketing', 'en', 'Hi {{name}}, we miss you!', 1,
          datetime('now'), datetime('now'), '', 'en', '["name"]', 1,
          'approved', 'MARKETING', ?, '[]')
`).run(generateId(), JSON.stringify([{ type: 'BODY', text: 'Hi {{1}}, we miss you!' }]));
const setSyncWatermark = (v) => db.prepare(`
  INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`).run(SYNC_KEY, v);
setSyncWatermark('2026-09-10 08:00:00');

const set = (k, v) => ctSettings.setCtSetting(db, k, String(v));
set('broadcast_enabled', '1');
set('broadcast_msgs_per_min', '3');
set('broadcast_cooldown_days', '7');
set('broadcast_daily_cap', '500');
set('broadcast_cost_per_msg', '0.80');
set(bc.DRAIN_WATERMARK_KEY, '');

// Mock transport — records every provider call; injectable per drain.
let wamidSeq = 0;
const sentCalls = [];
let onSend = null;      // optional per-test side effect (e.g. pause mid-flight)
const mockSender = async (to, template, lang, params) => {
  const call = { to, template, lang, params, at: Date.now(), n: sentCalls.length + 1 };
  sentCalls.push(call);
  if (onSend) await onSend(call);
  wamidSeq++;
  return { ok: true, provider: 'mock', message_id: `wamid.mock.${wamidSeq}` };
};

// Real webhook path helper — archives the raw payload then ingests, exactly
// like POST /api/whatsapp/webhook does.
async function webhook(payload) {
  const json = JSON.stringify(payload);
  const info = db.prepare(`INSERT INTO whatsapp_events_log (kind, payload) VALUES ('webhook', ?)`).run(json);
  return inbox.processWebhookEvent(db, Number(info.lastInsertRowid), json);
}
const inboundText = (n, body, type = 'text') => ({
  entry: [{ changes: [{ value: {
    messaging_product: 'whatsapp',
    contacts: [{ wa_id: WA(n), profile: { name: `Test Guest ${n}` } }],
    messages: [{
      id: `wamid.in.${++wamidSeq}`, from: WA(n), timestamp: String(Math.floor(Date.now() / 1000)),
      type,
      ...(type === 'text' ? { text: { body } } : { button: { text: body, payload: body } }),
    }],
  } }] }],
});
const statusEvent = (wamid, status, n, errors) => ({
  entry: [{ changes: [{ value: {
    messaging_product: 'whatsapp',
    statuses: [{
      id: wamid, status, timestamp: String(Math.floor(Date.now() / 1000)),
      recipient_id: WA(n), ...(errors ? { errors } : {}),
    }],
  } }] }],
});

const recipRows = (campId) => db.prepare(
  `SELECT * FROM wa_campaign_recipients WHERE campaign_id = ? ORDER BY queued_at, id`,
).all(campId);
const recipFor = (campId, n) => db.prepare(
  `SELECT * FROM wa_campaign_recipients WHERE campaign_id = ? AND phone_key = ?`,
).get(campId, KEY(n));

(async () => {
  const T0 = Date.now();

  /* ─────────────────────────────────────────────────────────────────────── */
  section(1, 'STOP via the REAL webhook ingest path');

  let sum = await webhook(inboundText(1, 'STOP'));
  expect(sum.messages_ingested, 1, 'inbound STOP ingested into the thread');
  expectTrue(consent.isOptedOut(db, KEY(1)), 'guest 1 opted out by STOP');
  expect(consent.consentFor(db, KEY(1)).source, 'stop_keyword', 'consent source recorded');

  await webhook(inboundText(2, 'please stop by at 8'));
  expectTrue(!consent.isOptedOut(db, KEY(2)), 'lookalike sentence does NOT opt out');

  await webhook(inboundText(8, 'వద్దు'));
  expectTrue(consent.isOptedOut(db, KEY(8)), 'Telugu STOP keyword opts out');

  await webhook(inboundText(9, 'Stop', 'button'));
  expectTrue(consent.isOptedOut(db, KEY(9)), 'quick-reply button STOP opts out');

  // A second STOP message (new wamid) appends to the audit log again.
  const before = db.prepare(`SELECT COUNT(*) AS n FROM wa_consent_log WHERE phone_key = ?`).get(KEY(1)).n;
  const again = await webhook(inboundText(1, 'STOP'));
  expectTrue(again.messages_ingested === 1, 'second STOP message still ingests');
  const after = db.prepare(`SELECT COUNT(*) AS n FROM wa_consent_log WHERE phone_key = ?`).get(KEY(1)).n;
  expect(after, before + 1, 'consent log appends once per STOP message');

  consent.setConsent(db, { phoneKey: KEY(9), status: 'opted_in', source: 'manual', changedBy: 'test-admin' });
  expectTrue(!consent.isOptedOut(db, KEY(9)), 'manual opt-in overrides an earlier STOP');

  /* ─────────────────────────────────────────────────────────────────────── */
  section(2, 'Audience preview counts exclusions honestly');

  const defA = { kind: 'phones', phones: [PH(1), PH(2), PH(3), PH(4), PH(5), '9000000002', PH(6), 'not-a-phone'] };
  const prevA = bc.previewAudience(db, bc.parseAudience(defA), T0);
  expect(prevA.queued, 6, 'queued = deduped, dialable list');
  expect(prevA.excluded.deduped, 1, 'duplicate phone collapsed');
  expect(prevA.excluded.no_phone, 1, 'unusable phone counted');
  expect(prevA.excluded.opted_out, 1, 'opted-out guest excluded in preview');
  expect(prevA.eligible_now, 5, 'eligible now');
  expect(prevA.cost.estimate, 4, 'cost estimate = eligible × ₹0.80');

  const created = bc.createBroadcast(db, {
    name: 'Test A', templateName: 'test_broadcast', language: 'en',
    paramOrder: ['name'], previewBody: 'Hi {{1}}, we miss you!',
    audience: bc.parseAudience(defA), createdBy: 'test-admin',
  });
  const campA = created.campaign.id;
  expect(created.queued, 6, 'create queues ALL dialable guests (consent gates at send)');

  /* ─────────────────────────────────────────────────────────────────────── */
  section(3, 'Throttle: budget = msgs_per_min × elapsed, observed per drain');

  let startRes = bc.startBroadcast(db, campA, { nowMs: T0 });
  expectTrue(startRes.ok, 'campaign A started');
  expect(startRes.campaign.state, 'sending', 'state = sending');

  let d1 = await bc.drainBroadcasts(db, { nowMs: T0, sender: mockSender, venue: 'Test Venue' });
  expect(d1.budget, 3, 'first drain budget = 1 min × 3/min');
  expect(d1.sent, 3, 'drain 1 sent exactly 3');

  const d2 = await bc.drainBroadcasts(db, { nowMs: T0 + 30_000, sender: mockSender });
  expect(d2.budget, 1, 'drain at +30s: budget floor(3 × 0.5) = 1');
  expect(d2.sent, 1, 'drain 2 sent exactly 1');

  const d3 = await bc.drainBroadcasts(db, { nowMs: T0 + 30_000, sender: mockSender });
  expect(d3.reason, 'no_budget', 'immediate re-drain has no budget (watermark held)');

  const d4 = await bc.drainBroadcasts(db, { nowMs: T0 + 90_000, sender: mockSender });
  expect(d4.sent, 1, 'drain 4 sends the last eligible guest');
  expectTrue(d4.campaigns_finished.includes(campA), 'campaign A finished');
  expect(bc.getCampaign(db, campA).state, 'done', 'campaign A state = done');

  const countsA = bc.recipientCounts(db, campA);
  expect(countsA.sent, 5, '5 messages actually sent');
  expect(countsA.skipped_optout, 1, 'opted-out guest skipped AT SEND TIME');
  expectTrue(!sentCalls.some(c => c.to === PH(1)), 'transport never called for the opted-out guest');
  expectTrue(recipRows(campA).filter(r => r.state === 'sent').every(r => r.wamid), 'every sent row stores its wamid');
  const threadOut = db.prepare(`
    SELECT COUNT(*) AS n FROM wa_messages WHERE direction = 'out' AND sent_by = ?
  `).get(`campaign:${campA}`).n;
  expect(threadOut, 5, 'each send recorded into the inbox thread');
  const echoedBody = db.prepare(`
    SELECT body FROM wa_messages WHERE direction = 'out' AND sent_by = ? LIMIT 1
  `).get(`campaign:${campA}`).body;
  expectTrue(/^Hi Test Guest \d+, we miss you!$/.test(echoedBody), `thread echo renders params ("${echoedBody}")`);

  /* ─────────────────────────────────────────────────────────────────────── */
  section(4, 'STOP arriving AFTER the audience was queued still wins');

  const createdB = bc.createBroadcast(db, {
    name: 'Test B', templateName: 'test_broadcast', paramOrder: ['name'],
    audience: bc.parseAudience({ kind: 'phones', phones: [PH(10), PH(11)] }), createdBy: 'test-admin',
  });
  const campB = createdB.campaign.id;
  const prevB = bc.previewAudience(db, bc.parseAudience({ kind: 'phones', phones: [PH(10), PH(11)] }), T0);
  expect(prevB.eligible_now, 2, 'both guests eligible at preview time');
  bc.startBroadcast(db, campB);
  // …then guest 10 texts STOP before the queue reaches them.
  await webhook(inboundText(10, 'unsubscribe'));
  const dB = await bc.drainBroadcasts(db, { nowMs: T0 + 300_000, sender: mockSender });
  expect(dB.skipped_optout, 1, 'late STOP skipped at send time');
  expect(recipFor(campB, 10).state, 'skipped_optout', 'recipient row says why');
  expect(recipFor(campB, 11).state, 'sent', 'the other guest still got the message');
  expectTrue(!sentCalls.some(c => c.to === PH(10)), 'transport never called for the late-STOP guest');

  /* ─────────────────────────────────────────────────────────────────────── */
  section(5, 'Cross-campaign cooldown — one marketing message per guest per window');

  // Win-back rail counts too: pretend guest 13 got a win-back send an hour ago.
  db.prepare(`
    INSERT INTO ct_campaign_targets (id, campaign_id, guest_id, phone_e164, name, send_status, sent_at)
    VALUES (?, 'winback-test', NULL, ?, 'Guest 13', 'sent', ?)
  `).run(generateId(), PH(13), new Date(T0 - 3600_000).toISOString());

  const createdC = bc.createBroadcast(db, {
    name: 'Test C', templateName: 'test_broadcast', paramOrder: ['name'],
    audience: bc.parseAudience({ kind: 'phones', phones: [PH(2), PH(12), PH(13)] }), createdBy: 'test-admin',
  });
  const campC = createdC.campaign.id;
  bc.startBroadcast(db, campC);
  const dC = await bc.drainBroadcasts(db, { nowMs: T0 + 600_000, sender: mockSender });
  expect(dC.skipped_cooldown, 2, 'both prior-rail guests skipped for cooldown');
  expect(recipFor(campC, 2).state, 'skipped_cooldown', 'guest 2 (sent in campaign A) skipped');
  expect(recipFor(campC, 13).state, 'skipped_cooldown', 'guest 13 (win-back rail) skipped');
  expect(recipFor(campC, 12).state, 'sent', 'fresh guest 12 sent');
  expect(sentCalls.filter(c => c.to === PH(2)).length, 1, 'guest 2 got exactly ONE message across campaigns');

  /* ─────────────────────────────────────────────────────────────────────── */
  section(6, 'Pause within one message · restart resumes · crashed claims never retried');

  set('broadcast_msgs_per_min', '100');
  const createdD = bc.createBroadcast(db, {
    name: 'Test D', templateName: 'test_broadcast', paramOrder: ['name'],
    audience: bc.parseAudience({ kind: 'phones', phones: [PH(14), PH(15), PH(16), PH(17), PH(18)] }),
    createdBy: 'test-admin',
  });
  const campD = createdD.campaign.id;
  bc.startBroadcast(db, campD);

  let dSends = 0;
  onSend = async () => { dSends++; if (dSends === 2) bc.pauseBroadcast(db, campD); };
  const dD1 = await bc.drainBroadcasts(db, { nowMs: T0 + 900_000, sender: mockSender });
  onSend = null;
  expect(dD1.sent, 2, 'pause mid-flight stopped after the in-flight message');
  expect(bc.getCampaign(db, campD).state, 'paused', 'campaign paused');
  expect(bc.recipientCounts(db, campD).queued, 3, '3 still queued');

  // Simulate a crash: one queued row was claimed but never finished.
  const crashRow = db.prepare(
    `SELECT id, phone_key FROM wa_campaign_recipients WHERE campaign_id = ? AND state = 'queued' LIMIT 1`,
  ).get(campD);
  db.prepare(`UPDATE wa_campaign_recipients SET state = 'sending' WHERE id = ?`).run(crashRow.id);

  // "Restart": a completely fresh DB handle — all engine state must be in the DB.
  const db2 = new Database(SNAP);
  assertSandboxed(db2);
  bc.resumeBroadcast(db2, campD);
  const dD2 = await bc.drainBroadcasts(db2, { nowMs: T0 + 960_000, sender: mockSender });
  expect(dD2.sent, 2, 'restart drained the remaining queued rows');
  expect(bc.getCampaign(db2, campD).state, 'sending', 'campaign NOT done while a claim is unconfirmed');
  const crashAfter = db2.prepare(`SELECT state, wamid FROM wa_campaign_recipients WHERE id = ?`).get(crashRow.id);
  expect(crashAfter.state, 'sending', "crashed 'sending' claim never auto-retried");
  expectTrue(crashAfter.wamid == null, 'crashed claim was never sent');

  const perPhone = db2.prepare(`
    SELECT phone_key, COUNT(*) AS n FROM wa_campaign_recipients
    WHERE campaign_id = ? AND sent_at IS NOT NULL GROUP BY phone_key HAVING n > 1
  `).all(campD);
  expect(perPhone.length, 0, 'nobody double-sent across pause/restart (sent_at proof)');
  const wamids = db2.prepare(`SELECT wamid FROM wa_campaign_recipients WHERE campaign_id = ? AND wamid IS NOT NULL`).all(campD);
  expect(new Set(wamids.map(w => w.wamid)).size, wamids.length, 'wamids unique (no double provider call)');

  // Operator resolution of the unconfirmed row: requeue explicitly, drain, done.
  db2.prepare(`UPDATE wa_campaign_recipients SET state = 'queued' WHERE id = ?`).run(crashRow.id);
  const dD3 = await bc.drainBroadcasts(db2, { nowMs: T0 + 1_020_000, sender: mockSender });
  expect(dD3.sent, 1, 'explicitly requeued row sent');
  expect(bc.getCampaign(db2, campD).state, 'done', 'campaign D done after resolution');
  db2.close();

  /* ─────────────────────────────────────────────────────────────────────── */
  section(7, 'Real status webhooks drive the recipient ladder');

  const r2 = recipFor(campA, 2);
  await webhook(statusEvent(r2.wamid, 'delivered', 2));
  expect(recipFor(campA, 2).state, 'delivered', 'delivered status applied');
  await webhook(statusEvent(r2.wamid, 'read', 2));
  expect(recipFor(campA, 2).state, 'read', 'read status applied');
  await webhook(statusEvent(r2.wamid, 'delivered', 2));
  expect(recipFor(campA, 2).state, 'read', 'late delivered cannot downgrade read (monotone)');
  const msg2 = db.prepare(`SELECT status FROM wa_messages WHERE wamid = ?`).get(r2.wamid);
  expect(msg2.status, 'read', 'thread message ladder moved too');

  const r3 = recipFor(campA, 3);
  await webhook(statusEvent(r3.wamid, 'failed', 3, [{
    code: 131049, title: 'Message undeliverable',
    message: 'This message was not delivered to maintain healthy ecosystem engagement.',
  }]));
  expect(recipFor(campA, 3).state, 'capped', '131049 counts as CAPPED, not failed');

  const r4 = recipFor(campA, 4);
  await webhook(statusEvent(r4.wamid, 'failed', 4, [{
    code: 131050, title: 'Marketing opt-out',
    message: 'User preferences to stop receiving marketing messages.',
  }]));
  expect(recipFor(campA, 4).state, 'failed', '131050 lands as failed');
  expectTrue(consent.isOptedOut(db, KEY(4)), '131050 revokes marketing consent');
  expect(consent.consentFor(db, KEY(4)).source, 'meta_131050', 'consent source = meta_131050');

  /* ─────────────────────────────────────────────────────────────────────── */
  section(8, 'An inbound reply marks the recipient replied');

  await webhook(inboundText(5, 'Great, book me a table for Friday'));
  expect(recipFor(campA, 5).state, 'replied', 'reply upgraded the recipient');
  expectTrue(!consent.isOptedOut(db, KEY(5)), 'a normal reply does not touch consent');

  /* ─────────────────────────────────────────────────────────────────────── */
  section(9, 'Daily cap stops the drain');

  const sentToday = bc.sentTodayCount(db, T0 + 1_100_000);
  set('broadcast_daily_cap', String(sentToday + 2));
  const createdE = bc.createBroadcast(db, {
    name: 'Test E', templateName: 'test_broadcast', paramOrder: ['name'],
    audience: bc.parseAudience({ kind: 'phones', phones: [PH(20), PH(21), PH(22), PH(23)] }),
    createdBy: 'test-admin',
  });
  const campE = createdE.campaign.id;
  bc.startBroadcast(db, campE);
  const dE = await bc.drainBroadcasts(db, { nowMs: T0 + 1_200_000, sender: mockSender });
  expect(dE.sent, 2, 'cap allowed exactly 2 more sends today');
  expectTrue(dE.cap_hit, 'drain reports the cap');
  expect(bc.recipientCounts(db, campE).queued, 2, 'rest stay queued for tomorrow');
  const dE2 = await bc.drainBroadcasts(db, { nowMs: T0 + 1_300_000, sender: mockSender });
  expect(dE2.reason, 'daily_cap', 'next drain refuses on the cap');
  set('broadcast_daily_cap', '500');

  /* ─────────────────────────────────────────────────────────────────────── */
  section(10, 'Master flag OFF = nothing moves');

  set('broadcast_enabled', '0');
  const dOff = await bc.drainBroadcasts(db, { nowMs: T0 + 1_400_000, sender: mockSender });
  expect(dOff.reason, 'disabled', 'drain refuses while the flag is off');
  set('broadcast_enabled', '1');
  const dOn = await bc.drainBroadcasts(db, { nowMs: T0 + 1_500_000, sender: mockSender });
  expectTrue(dOn.ran, 'drain runs again once re-enabled');
  expect(bc.getCampaign(db, campE).state, 'done', 'campaign E finishes after cap reset');

  /* ─────────────────────────────────────────────────────────────────────── */
  section(11, 'Cost rate + estimate captured at start time');

  set('broadcast_cost_per_msg', '0.75');
  const createdF = bc.createBroadcast(db, {
    name: 'Test F', templateName: 'test_broadcast', paramOrder: ['name'],
    audience: bc.parseAudience({ kind: 'phones', phones: [PH(25), PH(26), PH(27)] }),
    createdBy: 'test-admin',
  });
  bc.startBroadcast(db, createdF.campaign.id);
  const campF = bc.getCampaign(db, createdF.campaign.id);
  expect(campF.cost_rate, 0.75, 'rate captured at start');
  expect(campF.cost_estimate, 2.25, 'estimate = 3 × ₹0.75');
  bc.cancelBroadcast(db, campF.id);
  expect(bc.getCampaign(db, campF.id).state, 'cancelled', 'cancel works');
  expect(bc.recipientCounts(db, campF.id).cancelled, 3, 'queued rows cancelled with it');

  /* ─────────────────────────────────────────────────────────────────────── */
  section(13, 'The HEADER gate — a heading this rail cannot fill halts the queue');

  // The drain calls the sender with BODY parameters only, so a template Meta
  // approved with a media heading (or with a {{n}} in a text heading) is
  // refused for EVERY recipient. Before this gate, such a campaign was created
  // with no warning at all and burnt its audience one message at a time.
  const putTpl = (name, comps) => db.prepare(`
    INSERT INTO whatsapp_templates
      (id, name, category, language, body, is_active, created_at, updated_at,
       provider_template_name, provider_language, param_order, send_as_template,
       meta_status, meta_category, meta_components, var_spec)
    VALUES (?, ?, 'marketing', 'en', 'Hi {{name}}, come back to us.', 1, datetime('now'), datetime('now'),
            '', 'en', '["name"]', 1, 'approved', 'MARKETING', ?, '[]')
  `).run(generateId(), name, JSON.stringify(comps));

  /* The local wording is NAMED and Meta's components are NUMBERED — one sentence,
   * two dialects, which is what a reconciled row looks like (a refresh never
   * rewrites the `body` column). It matters here because this section is about
   * HEADINGS: leave the local copy numbered and nothing names any blank, the
   * mapping is read once before it can start, and every assertion below would be
   * measuring the reading gate instead of the heading gate. */
  const BODY_ONLY = { type: 'BODY', text: 'Hi {{1}}, come back to us.' };
  putTpl('hdr_media', [{ type: 'HEADER', format: 'IMAGE' }, BODY_ONLY]);
  putTpl('hdr_blank', [{ type: 'HEADER', format: 'TEXT', text: 'A gift for {{1}}' }, BODY_ONLY]);
  putTpl('hdr_fixed', [{ type: 'HEADER', format: 'TEXT', text: 'We miss you' }, BODY_ONLY]);
  putTpl('hdr_none', [BODY_ONLY]);

  expectTrue(!bc.templateHeaderFill(db, 'hdr_media').ok, 'IMAGE heading refused');
  expect(bc.templateHeaderFill(db, 'hdr_media').format, 'IMAGE', 'the refusal names the format');
  expectTrue(!bc.templateHeaderFill(db, 'hdr_blank').ok, 'a {{n}} in the heading refused');
  expectTrue(bc.templateHeaderFill(db, 'hdr_fixed').ok, 'a FIXED text heading is fine');
  expectTrue(bc.templateHeaderFill(db, 'hdr_none').ok, 'no heading at all is fine');
  // EVIDENCE DISCIPLINE: a row whose components were never recorded proves
  // nothing about its heading, so it is not refused — same rule the approval
  // and category gates follow.
  expectTrue(bc.templateHeaderFill(db, 'no_such_template_anywhere').ok,
    'an unknown template is NOT refused on no evidence');
  expectTrue(!bc.templateHeaderFill(db, 'hdr_media').known === false,
    'a refusal is marked as resting on real evidence');

  // …and it halts a campaign that is ALREADY sending, before a single message.
  set('broadcast_enabled', '1');
  set('broadcast_msgs_per_min', '60');
  set('broadcast_cooldown_days', '0');
  set('broadcast_daily_cap', '0');
  const hdrCamp = bc.createBroadcast(db, {
    name: 'Header probe', templateName: 'hdr_fixed', language: 'en',
    paramOrder: ['name'], previewBody: 'Hi {{1}}, come back to us.',
    audience: bc.parseAudience({ kind: 'all_guests' }), createdBy: 'test-admin',
  }).campaign.id;
  // The drain budget is measured from a GLOBAL watermark the earlier sections
  // have already advanced — reset it so this section's clock is its own.
  const HT = Date.now() + 3_600_000;
  set(bc.DRAIN_WATERMARK_KEY, String(HT));
  expectTrue(bc.startBroadcast(db, hdrCamp, { nowMs: HT }).ok, 'campaign on a fixed heading starts');
  // Meta EDITS happen after a campaign is built — the heading gains a blank.
  db.prepare(`UPDATE whatsapp_templates SET meta_components = ? WHERE name = 'hdr_fixed'`)
    .run(JSON.stringify([{ type: 'HEADER', format: 'TEXT', text: 'A gift for {{1}}' }, BODY_ONLY]));
  const queuedBefore = bc.recipientCounts(db, hdrCamp).queued;
  const hdrDrain = await bc.drainBroadcasts(db, { nowMs: HT + 60_000, sender: mockSender });
  expect(hdrDrain.sent, 0, 'not one message was attempted after the heading changed');
  expect(bc.getCampaign(db, hdrCamp).state, 'paused', 'the drain halted it into paused');
  expect(bc.recipientCounts(db, hdrCamp).queued, queuedBefore, 'the whole queue is intact');
  expectTrue(/blank in its heading/.test(bc.getCampaign(db, hdrCamp).halt_reason || ''),
    'halt_reason says what is actually wrong');
  const hdrResume = bc.resumeBroadcast(db, hdrCamp);
  expectTrue(!hdrResume.ok && hdrResume.error === 'header_unfillable',
    'Resume refuses while the heading is still unfillable');
  bc.cancelBroadcast(db, hdrCamp);

  // A campaign can never even be STARTED on a media-heading template.
  const mediaCamp = bc.createBroadcast(db, {
    name: 'Media probe', templateName: 'hdr_media', language: 'en',
    paramOrder: ['name'], previewBody: 'Hi {{1}}, come back to us.',
    audience: bc.parseAudience({ kind: 'all_guests' }), createdBy: 'test-admin',
  }).campaign.id;
  const mediaStart = bc.startBroadcast(db, mediaCamp, { nowMs: HT });
  expectTrue(!mediaStart.ok && mediaStart.error === 'header_unfillable', 'Start refuses a media heading');
  expect(bc.getCampaign(db, mediaCamp).state, 'draft', 'it stays a draft — nothing was armed');
  bc.cancelBroadcast(db, mediaCamp);

  /* ─────────────────────────────────────────────────────────────────────── */
  section(12, 'UI-phase additive knobs: birthday/tier audiences + confirm threshold');

  // birthdayMonthOf — the format tolerance the audience filter rests on.
  expect(bc.birthdayMonthOf('1992-03-15'), 3, 'ISO YYYY-MM-DD → month');
  expect(bc.birthdayMonthOf('14/03'), 3, 'DD/MM (day first) → month');
  expect(bc.birthdayMonthOf('--03-14'), 3, 'vCard --MM-DD → month');
  expect(bc.birthdayMonthOf('march'), 0, 'unreadable birthday → 0 (never matches)');

  // parseAudience — new kinds validate, garbage refuses.
  expect(bc.parseAudience({ kind: 'birthday_month', month: 3 }).month, 3, 'birthday_month parses');
  expect(bc.parseAudience({ kind: 'birthday_month', month: 13 }), null, 'month 13 refused');
  expect(bc.parseAudience({ kind: 'tier', tier: 'gold' }).tier, 'Gold', 'tier parses case-insensitively');
  expect(bc.parseAudience({ kind: 'tier', tier: 'Platinum' }), null, 'unknown tier refused');

  // resolveAudience birthday_month — membership, not counts (the live snapshot
  // may legitimately contain real March birthdays).
  db.prepare(`INSERT INTO ct_guests (id, phone_e164, name, dob) VALUES (?, ?, ?, ?)`)
    .run(generateId(), PH(31), 'March CT Guest', '1992-03-15');
  db.prepare(`INSERT INTO ct_guests (id, phone_e164, name, dob) VALUES (?, ?, ?, ?)`)
    .run(generateId(), PH(32), 'November CT Guest', '1990-11-02');
  db.prepare(`INSERT INTO crm_guests (id, mobile, name, birthday, points, visit_count) VALUES (?, ?, ?, ?, 0, 1)`)
    .run(generateId(), PH(33), 'March Loyalty Guest', '14/03');
  const bday = bc.resolveAudience(db, bc.parseAudience({ kind: 'birthday_month', month: 3 }));
  const bdayKeys = new Set(bday.guests.map((g) => g.phone_key));
  expectTrue(bdayKeys.has(KEY(31)), 'March ct_guest (dob) is in the March audience');
  expectTrue(bdayKeys.has(KEY(33)), 'March loyalty guest (birthday) is in the March audience');
  expectTrue(!bdayKeys.has(KEY(32)), 'November guest is NOT in the March audience');

  // resolveAudience tier — Gold ≥1500 points (tierForPoints ladder).
  db.prepare(`INSERT INTO crm_guests (id, mobile, name, points, visit_count) VALUES (?, ?, ?, 2000, 5)`)
    .run(generateId(), PH(34), 'Gold Guest');
  db.prepare(`INSERT INTO crm_guests (id, mobile, name, points, visit_count) VALUES (?, ?, ?, 100, 2)`)
    .run(generateId(), PH(35), 'Bronze Guest');
  const gold = bc.resolveAudience(db, bc.parseAudience({ kind: 'tier', tier: 'Gold' }));
  const goldKeys = new Set(gold.guests.map((g) => g.phone_key));
  expectTrue(goldKeys.has(KEY(34)), '2000-point guest is in the Gold audience');
  expectTrue(!goldKeys.has(KEY(35)), '100-point guest is NOT in the Gold audience');

  // Documented defaults must apply when keys are ABSENT (ctSetting returns ''
  // for a missing key, and Number('') === 0 — an unset daily cap must be 500,
  // never a silent "uncapped"). Delete the fixture rows to prove it.
  db.prepare(`DELETE FROM ct_settings WHERE key IN (
    'broadcast_msgs_per_min', 'broadcast_cooldown_days', 'broadcast_daily_cap',
    'broadcast_cost_per_msg', 'broadcast_confirm_threshold'
  )`).run();
  const dflts = bc.broadcastSettings(db);
  expect(dflts.msgs_per_min, 20, 'absent msgs_per_min → default 20');
  expect(dflts.cooldown_days, 7, 'absent cooldown_days → default 7');
  expect(dflts.daily_cap, 500, 'absent daily_cap → default 500');
  expect(dflts.cost_per_msg, 0.8, 'absent cost_per_msg → default ₹0.80');
  expect(dflts.confirm_threshold, 50, 'absent confirm_threshold → default 50');

  // confirm_threshold knob — set + clamp.
  set('broadcast_confirm_threshold', '10');
  expect(bc.broadcastSettings(db).confirm_threshold, 10, 'confirm_threshold follows the setting');
  set('broadcast_confirm_threshold', '-5');
  expect(bc.broadcastSettings(db).confirm_threshold, 0, 'confirm_threshold clamps at 0');

  /* ─────────────────────────────────────────────────────────────────────── */
  section(14, 'A synced install: the watermark, the blank census, and the breaker');

  const auth = lib('wa-template-authoring.ts');

  // (a) THE FIXTURE IS A SYNCED INSTALL, and everything above just ran on it.
  expectTrue(!!auth.lastSyncAt(db), 'the suite runs WITH a sync watermark set');
  const seeded = auth.templateSendability(db, 'test_broadcast', 'en', { requireCategory: 'MARKETING' });
  expectTrue(seeded.ok && seeded.verified, 'the seeded template is approved MARKETING on real evidence');

  // (b) CLICKING "REFRESH TEMPLATES" AGAIN must not turn this gate red. A sync
  //     only rewrites the watermark; a template that was approved stays
  //     approved, and a campaign on it still starts and still drains.
  setSyncWatermark('2026-09-11 09:30:00');
  expect(auth.lastSyncAt(db), '2026-09-11 09:30:00', 'a later refresh moves the watermark');
  const afterRefresh = auth.templateSendability(db, 'test_broadcast', 'en', { requireCategory: 'MARKETING' });
  expectTrue(afterRefresh.ok, 'the template is STILL sendable after the refresh');

  set('broadcast_enabled', '1');
  set('broadcast_msgs_per_min', '60');
  set('broadcast_cooldown_days', '0');
  set('broadcast_daily_cap', '0');
  const RT = Date.now() + 10_800_000;
  set(bc.DRAIN_WATERMARK_KEY, String(RT));
  const refreshCamp = bc.createBroadcast(db, {
    name: 'After refresh', templateName: 'test_broadcast', language: 'en',
    paramOrder: ['name'], previewBody: 'Hi {{1}}, we miss you!',
    audience: bc.parseAudience({ kind: 'phones', phones: [PH(20), PH(21)] }), createdBy: 'test-admin',
  }).campaign.id;
  expectTrue(bc.startBroadcast(db, refreshCamp, { nowMs: RT }).ok, 'a campaign still STARTS after a refresh');
  const rd = await bc.drainBroadcasts(db, { nowMs: RT + 60_000, sender: mockSender });
  expect(rd.sent, 2, 'and still drains after a refresh');
  expect(rd.campaigns_halted.length, 0, 'nothing halted');

  // (c) THE BLANK CENSUS — the owner's real shape: an UNMANAGED row whose
  //     wording marks its blanks BY NAME, with a stored param_order that agrees.
  //     This is exactly ct_winback on his install, and a campaign on it used to
  //     leave with ZERO parameters where the win-back rail sends two.
  db.prepare(`
    INSERT INTO whatsapp_templates
      (id, name, category, language, body, is_active, created_at, updated_at,
       provider_template_name, provider_language, param_order, send_as_template,
       meta_status, meta_category, meta_components, var_spec)
    VALUES (?, 'unmanaged_named', 'marketing', 'en',
            'Hi {{name}}, it has been a while since your last visit to {{venue}}.', 1,
            datetime('now'), datetime('now'), '', 'en', '["name","venue"]', 1, '', '', '', '')
  `).run(generateId());

  const census = bc.bodyBlanks('Hi {{name}}, welcome to {{venue}} — {{1}}');
  expect(census.named.length, 2, 'bodyBlanks counts NAMED blanks');
  expect(census.positional, 1, 'and positional ones');
  expect(census.count, 3, 'and totals both dialects');

  const need = bc.broadcastBlanks(db, 'unmanaged_named');
  expectTrue(need.known, 'two agreeing records make the blank count KNOWN');
  expect(need.count, 2, 'the unmanaged named-blank template needs 2');
  expect(JSON.stringify(need.names), '["name","venue"]', 'named in the order the other rails send');

  expectTrue(!bc.paramCheckFor(db, 'unmanaged_named', []).ok,
    'a ZERO-parameter campaign on it is REFUSED (it would send bare)');
  expectTrue(!bc.paramCheckFor(db, 'unmanaged_named', ['name']).ok,
    'a SHORT one-parameter campaign is refused too');
  expectTrue(bc.paramCheckFor(db, 'unmanaged_named', ['name', 'venue']).ok,
    'the two parameters the wording needs are accepted');

  const bareCamp = bc.createBroadcast(db, {
    name: 'Bare probe', templateName: 'unmanaged_named', language: 'en',
    paramOrder: [], previewBody: 'Hi {{name}}, ...',
    audience: bc.parseAudience({ kind: 'phones', phones: [PH(22), PH(23)] }), createdBy: 'test-admin',
  }).campaign.id;

  // THE OWNER'S ACTUAL SHAPE is an install that has NEVER synced, where the
  // approval gate has no grounds to refuse an unmanaged row and therefore lets
  // it through — which is exactly why the parameter gate has to catch it. With
  // a watermark in place the approval gate refuses first (proved below), so the
  // watermark is lifted for this probe to reach the gate under test.
  const keepSync = auth.lastSyncAt(db);
  setSyncWatermark('');
  const bareStart = bc.startBroadcast(db, bareCamp, { nowMs: RT });
  expectTrue(!bareStart.ok && bareStart.error === 'param_mismatch',
    `Start refuses the bare campaign on the blank count (error=${bareStart.error})`);
  expect(bc.getCampaign(db, bareCamp).state, 'draft', 'it stays a draft — nothing was armed');
  const mappedProbe = bc.createBroadcast(db, {
    name: 'Mapped probe', templateName: 'unmanaged_named', language: 'en',
    paramOrder: ['name', 'venue'], previewBody: 'Hi {{name}}, ...',
    audience: bc.parseAudience({ kind: 'phones', phones: [PH(24), PH(25)] }), createdBy: 'test-admin',
  }).campaign.id;
  expectTrue(bc.startBroadcast(db, mappedProbe, { nowMs: RT }).ok,
    'the SAME template with both blanks mapped starts normally');
  /* AND IT IS PUT AWAY AGAIN. It has proved its one point; leaving it 'sending'
   * leaves a second live campaign in the drain for every test below, whose sends
   * land on the same transport counter. That used to be invisible because the
   * approval gate silently HALTED this campaign on the next drain pass (an
   * unmanaged row, once the list had been checked) — the very refusal the
   * 2026-09-15 ruling removed. With it gone the campaign correctly keeps going,
   * so the cleanup has to be explicit rather than a side effect of a bug. */
  bc.cancelBroadcast(db, mappedProbe);

  /* Back to the synced shape. The approval gate USED to be the one that spoke
   * here — "we have checked the list and do not recognise this row" — and that
   * is the branch the owner's 2026-09-15 ruling removed: it is what turned all 11
   * of this venue's templates into refusals from one button press. Checking the
   * list now changes NOTHING about what may be sent.
   *
   * What still refuses this campaign is what refused it a moment ago and has
   * nothing to do with any list: it maps no blanks at all, and the wording needs
   * two. That refusal is about what would go on the wire, so it survives — and
   * the assertion below is the sharp end of the whole change, because it proves
   * the answer is the SAME either side of a sync. */
  setSyncWatermark(keepSync);
  const bareSynced = bc.startBroadcast(db, bareCamp, { nowMs: RT });
  expectTrue(!bareSynced.ok && bareSynced.error === 'param_mismatch',
    `once synced, the blank count still refuses it and the list read does not (error=${bareSynced.error})`);
  expect(bc.getCampaign(db, bareCamp).state, 'draft', 'and it is still a draft — a check armed nothing');
  bc.cancelBroadcast(db, bareCamp);

  // …and where the two records DISAGREE, the honest answer is "cannot tell".
  db.prepare(`
    INSERT INTO whatsapp_templates
      (id, name, category, language, body, is_active, created_at, updated_at,
       provider_template_name, provider_language, param_order, send_as_template,
       meta_status, meta_category, meta_components, var_spec)
    VALUES (?, 'unmanaged_disagree', 'marketing', 'en', 'Order #{{order}} — {{pct}}% {{decision}}.',
            1, datetime('now'), datetime('now'), '', 'en', '', 1, '', '', '', '')
  `).run(generateId());
  const dis = bc.broadcastBlanks(db, 'unmanaged_disagree');
  expectTrue(!dis.known, 'disagreeing records do NOT produce a count');
  expectTrue(/disagree/.test(bc.paramCheckFor(db, 'unmanaged_disagree', []).reason),
    'and the refusal SAYS the app cannot know, rather than sending bare');

  // (d) THE CIRCUIT BREAKER AT A THROTTLED VENUE. The counter lives in the
  //     queue, not in a per-pass local, so the threshold is reachable at ANY
  //     configured rate — including one well below it.
  set('broadcast_msgs_per_min', '4');
  const brkCamp = bc.createBroadcast(db, {
    name: 'Breaker at 4/min', templateName: 'test_broadcast', language: 'en',
    paramOrder: ['name'], previewBody: 'Hi {{1}}, we miss you!',
    audience: bc.parseAudience({
      kind: 'phones',
      phones: [PH(20), PH(21), PH(22), PH(23), PH(24), PH(25), PH(26), PH(27), PH(28), PH(29)],
    }),
    createdBy: 'test-admin',
  }).campaign.id;
  expectTrue(bc.startBroadcast(db, brkCamp, { nowMs: RT }).ok, 'the throttled campaign starts');
  let brkAttempts = 0;
  const deadTransport = async () => {
    brkAttempts++;
    return { ok: false, reason: 'send_failed', detail: 'transport unreachable' };
  };
  let bt = RT + 120_000, brkPasses = 0;
  set(bc.DRAIN_WATERMARK_KEY, String(bt));
  while (brkPasses < 20 && bc.getCampaign(db, brkCamp).state === 'sending') {
    bt += 60_000; brkPasses++;
    await bc.drainBroadcasts(db, { nowMs: bt, sender: deadTransport });
  }
  expect(brkAttempts, 5, 'at 4 msgs/min the breaker STOPS the queue after 5 sends');
  /* Measured on the campaign itself as well as on the shared transport counter,
   * so this cannot silently start counting some OTHER live campaign's sends. */
  expect(bc.recipientCounts(db, brkCamp).failed, 5,
    'and the five attempts are all this campaign, recorded on its own queue');
  expect(bc.getCampaign(db, brkCamp).state, 'paused', 'the campaign is halted, not run to the end');
  expectTrue(bc.recipientCounts(db, brkCamp).queued >= 5, 'the rest of the audience is untouched');
  expectTrue(/in a row failed/.test(bc.getCampaign(db, brkCamp).halt_reason || ''),
    'halt_reason says what actually happened');
  expect(bc.trailingFailStreak(db, brkCamp), 5, 'the streak is readable from the queue itself');

  // A human Resume forgives the streak — one unreachable number afterwards must
  // not re-halt a campaign whose fault the operator has just fixed.
  const brkResume = bc.resumeBroadcast(db, brkCamp, { nowMs: bt });
  expectTrue(brkResume.ok, 'Resume is accepted once the transport is back');
  expect(bc.trailingFailStreak(db, brkCamp), 0, 'and the breaker starts counting again from zero');
  bc.cancelBroadcast(db, brkCamp);

  /* ─────────────────────────────────────────────────────────────────────── */
  section(15, 'A MANAGED template whose Meta body uses NAMED blanks');

  /* WHY THIS SECTION EXISTS. templatePlaceholders() counts a wording with
   * maxPlaceholderIndex(), which sees {{1}} and nothing else. syncTemplateStatuses
   * copies Meta's components in verbatim and writes no var_spec — so the first
   * time anyone clicks "Refresh templates", a template whose approved body reads
   * 'Hi {{name}}, we miss you at {{venue}}!' reported known/0 blanks. The wizard
   * then offered nothing to map and the campaign went out BARE, refused by Meta
   * for every recipient after the cost was confirmed. */
  const seedTpl = (name, opts) => {
    db.prepare(`
      INSERT INTO whatsapp_templates
        (id, name, category, language, body, is_active, created_at, updated_at,
         provider_template_name, provider_language, param_order, send_as_template,
         meta_status, meta_category, meta_components, var_spec)
      VALUES (?, ?, 'marketing', 'en', ?, 1, datetime('now'), datetime('now'),
              '', 'en', ?, 1, ?, ?, ?, ?)
    `).run(generateId(), name, opts.body || '', JSON.stringify(opts.params || []),
      opts.metaStatus || '', opts.metaCategory || '',
      opts.components ? JSON.stringify(opts.components) : '', JSON.stringify(opts.varSpec || []));
  };

  seedTpl('synced_named_body', {
    body: 'Hi {{name}}, we miss you at {{venue}}!',
    params: ['name', 'venue'], metaStatus: 'approved', metaCategory: 'MARKETING',
    components: [{ type: 'BODY', text: 'Hi {{name}}, we miss you at {{venue}}!' }],
  });
  const lifecycleSays = auth.templatePlaceholders(db, 'synced_named_body');
  expectTrue(lifecycleSays.known && lifecycleSays.count === 0,
    'the lifecycle itself still counts only {{n}} (Phase B, unchanged)');
  const namedSynced = bc.broadcastBlanks(db, 'synced_named_body');
  expect(namedSynced.count, 2, 'but this rail counts the SAME wording in both dialects');
  expect(JSON.stringify(namedSynced.names), '["name","venue"]', 'and knows what each blank is for');
  expectTrue(!bc.paramCheckFor(db, 'synced_named_body', []).ok,
    'so a ZERO-parameter campaign on a synced named-body template is refused');
  expectTrue(bc.paramCheckFor(db, 'synced_named_body', ['name', 'venue']).ok,
    'and the two blanks it really has are accepted');

  // A POSITIONAL Meta body is untouched — the correction only ever goes upwards.
  seedTpl('synced_positional_body', {
    body: 'Hi {{1}}, we miss you at {{2}}!', params: ['name', 'venue'],
    metaStatus: 'approved', metaCategory: 'MARKETING',
    components: [{ type: 'BODY', text: 'Hi {{1}}, we miss you at {{2}}!' }],
  });
  expect(bc.broadcastBlanks(db, 'synced_positional_body').count, 2,
    'a positional Meta body still counts 2, exactly as before');

  // An authored var_spec decides for itself, and an UNNAMED row in it is not
  // "unfillable" — it is no evidence, and its neighbours keep their positions.
  seedTpl('authored_half_named', {
    body: 'Hi {{1}}, {{2}} misses you.', params: ['name', 'venue'],
    metaStatus: 'approved', metaCategory: 'MARKETING',
    components: [{ type: 'BODY', text: 'Hi {{1}}, {{2}} misses you.' }],
    varSpec: [{ index: 1, name: '', example: 'Asha' }, { index: 2, name: 'venue', example: 'AKAN' }],
  });
  const halfNamed = bc.broadcastBlanks(db, 'authored_half_named');
  expect(JSON.stringify(halfNamed.names), '["","venue"]',
    'var_spec names stay POSITION-ALIGNED (they used to be filter(Boolean)-ed)');
  expectTrue(bc.paramCheckFor(db, 'authored_half_named', ['name', 'venue']).ok,
    'an unnamed authored blank is not refused — it is no evidence, not a fault');

  /* ─────────────────────────────────────────────────────────────────────── */
  section(16, 'Blanks a broadcast cannot fill (the right COUNT, the wrong words)');

  /* THE FAILURE WITH NO BACKSTOP. A broadcast holds three facts: the guest's
   * name, the venue's name, the guest's phone number. ct_slow_night's wording
   * is 'Hi {{name}}, we have tables free at {{venue}} on {{day}}.' — three
   * blanks, so the count gate passed, and the wizard's by-position guess put
   * the VENUE in {{day}}. Meta accepts a correct parameter count, so every
   * message was delivered, the breaker never fired, the cost was charged, and
   * every guest read "tables free at AKAN on AKAN" and entered a 7-day
   * cooldown. Nothing in the app refused it and nothing on screen said a
   * broadcast can fill only three things. */
  expect(bc.blankVar('venue_name'), 'venue', 'venue is tested before name — "venue_name" is a venue');
  expect(bc.blankVar('guest_name'), 'name', 'a guest name is a name');
  expect(bc.blankVar('phone'), 'phone', 'a phone is a phone');
  expect(bc.blankVar('day'), null, '"day" is nothing this rail can fill');
  expect(bc.blankVar('open_time'), null, 'nor is an opening time');
  expect(bc.blankVar('req_number'), null, 'and "number" alone is NOT a phone number');
  expect(bc.blankVar(''), null, 'an unnamed blank is no evidence either way');
  expect(bc.unfillableBlanks(['name', '', 'day']).length, 1, 'only NAMED unfillable blanks count');
  expect(bc.unfillableBlanks(['name', '', 'day'])[0].position, 3, 'and they are reported by POSITION');

  seedTpl('slow_night_shape', {
    body: 'Hi {{name}}, we have tables free at {{venue}} on {{day}}. Reply to reserve yours.',
    params: ['name', 'venue', 'day'],
  });
  const slowBlanks = bc.broadcastBlanks(db, 'slow_night_shape');
  expect(slowBlanks.count, 3, 'the wording and the stored list agree on three blanks');
  const slowCheck = bc.paramCheckFor(db, 'slow_night_shape', ['name', 'venue', 'venue']);
  expectTrue(!slowCheck.ok, 'the RIGHT number of parameters is still refused…');
  expectTrue(/cannot fill/.test(slowCheck.reason) && /day/.test(slowCheck.reason),
    '…and the refusal names the blank ("day") in words an owner can act on');
  expectTrue(!bc.paramCheckFor(db, 'slow_night_shape', ['name', 'venue', 'phone']).ok,
    'no re-mapping of the dropdowns gets past it — the BLANK is the problem');

  const slowCamp = bc.createBroadcast(db, {
    name: 'Slow night', templateName: 'slow_night_shape', language: 'en',
    paramOrder: ['name', 'venue', 'venue'], previewBody: 'Hi {{name}}, …',
    audience: bc.parseAudience({ kind: 'phones', phones: [PH(30), PH(31), PH(32)] }),
    createdBy: 'test-admin',
  }).campaign.id;
  // The owner's install has never synced, so the approval gate has no grounds
  // to refuse an unmanaged row and this is the gate that has to catch it. The
  // watermark is lifted for the probe exactly as in section 14(c).
  const keepSync2 = auth.lastSyncAt(db);
  setSyncWatermark('');
  const slowStart = bc.startBroadcast(db, slowCamp, { nowMs: RT });
  expectTrue(!slowStart.ok && slowStart.error === 'param_mismatch',
    `a campaign already in the table cannot be STARTED either (error=${slowStart.error})`);
  expect(bc.getCampaign(db, slowCamp).state, 'draft', 'it stays a draft — no cost, nothing armed');
  setSyncWatermark(keepSync2);
  bc.cancelBroadcast(db, slowCamp);

  // Fillable names of every shape still pass — the gate refuses meanings this
  // rail cannot honour, not named blanks as such.
  seedTpl('fillable_named', {
    body: 'Hi {{guest_name}}, {{restaurant}} has a table. Call {{mobile}}.',
    params: ['name', 'venue', 'phone'],
  });
  expectTrue(bc.paramCheckFor(db, 'fillable_named', ['name', 'venue', 'phone']).ok,
    'guest_name / restaurant / mobile are all fillable and still accepted');

  // And where the count cannot be established at all, the NAMES still can be:
  // this is the direct-API path, which no screen has to be trusted for.
  seedTpl('unknown_count_unfillable', { body: 'Daily digest {{date}} — {{content}}.', params: [] });
  const unkChk = bc.paramCheckFor(db, 'unknown_count_unfillable', ['name', 'venue']);
  expectTrue(!unkChk.ok && /cannot fill/.test(unkChk.reason),
    'an unprovable count whose WORDING asks for {{date}} is refused on the names alone');
  seedTpl('unknown_count_fillable', { body: 'Hi {{name}}, {{venue}} misses you, {{name}}.', params: [] });
  expectTrue(bc.paramCheckFor(db, 'unknown_count_fillable', ['name', 'venue']).ok,
    'an unprovable count with FILLABLE names is still allowed — unchanged');

  /* ── AND AFTER A SYNC, where Meta answers in NUMBERED blanks ────────────
   *
   * The refusal above rests on the blank NAMES, and Meta hands a template's
   * body back as 'Hi {{1}}, we have tables free at {{2}} on {{3}}'. So the one
   * action the operator is told to take — "Refresh templates" — used to erase
   * exactly the evidence the gate depends on: the count stayed right, the names
   * became empty, nothing was unfillable any more, and ct_slow_night went out
   * to the whole audience saying "tables free at AKAN on AKAN", accepted and
   * charged by Meta with the breaker silent. The wording and the variable list
   * saved here are this app's own position-aligned records of what each blank
   * means, and they are read at the lifecycle's own count. */
  seedTpl('slow_night_synced', {
    body: 'Hi {{name}}, we have tables free at {{venue}} on {{day}}. Reply to reserve yours.',
    params: ['name', 'venue', 'day'],
    metaStatus: 'approved', metaCategory: 'MARKETING',
    components: [{ type: 'BODY', text: 'Hi {{1}}, we have tables free at {{2}} on {{3}}. Reply to reserve yours.' }],
  });
  const syncedSlow = bc.broadcastBlanks(db, 'slow_night_synced');
  expect(syncedSlow.count, 3, 'Meta settles the COUNT for a synced positional body');
  expect(syncedSlow.source, 'lifecycle', 'and it is the lifecycle that settled it');
  expect(JSON.stringify(syncedSlow.names), '["name","venue","day"]',
    'while the MEANING of each position comes from the records saved here');
  expectTrue(syncedSlow.names_local, 'and the answer says so, so a refusal can name where to fix it');
  const syncedSlowChk = bc.paramCheckFor(db, 'slow_night_synced', ['name', 'venue', 'venue']);
  expectTrue(!syncedSlowChk.ok && /day/.test(syncedSlowChk.reason),
    'so the RIGHT count is still refused after a sync — "day" is still unfillable');
  expectTrue(/Settings → Integrations → WhatsApp → Templates/.test(syncedSlowChk.reason),
    'and the refusal says where that name comes from, since Meta did not supply it');

  // Fillable names survive the same round trip — this closes a hole, it does
  // not narrow what already works.
  seedTpl('winback_synced', {
    body: 'Hi {{name}}, it has been a while since your last visit to {{venue}}.',
    params: ['name', 'venue'],
    metaStatus: 'approved', metaCategory: 'MARKETING',
    components: [{ type: 'BODY', text: 'Hi {{1}}, it has been a while since your last visit to {{2}}.' }],
  });
  expectTrue(bc.paramCheckFor(db, 'winback_synced', ['name', 'venue']).ok,
    'a synced positional win-back still maps its two blanks and is accepted');

  // A record of a DIFFERENT length describes a different shape of the template,
  // so it is aligned with nothing and is not slid onto the wrong blank.
  seedTpl('synced_records_dont_fit', {
    body: 'Hi {{name}}, {{venue}} misses you on {{day}}.', params: ['name', 'venue', 'day'],
    metaStatus: 'approved', metaCategory: 'MARKETING',
    components: [{ type: 'BODY', text: 'Hi {{1}}, {{2}} misses you.' }],
  });
  const misfit = bc.broadcastBlanks(db, 'synced_records_dont_fit');
  expect(misfit.count, 2, 'Meta still decides how many blanks there are');
  expect(JSON.stringify(misfit.names), '["",""]',
    'a 3-long local record is not read onto a 2-blank template');
  expectTrue(bc.paramCheckFor(db, 'synced_records_dont_fit', ['name', 'venue']).ok,
    'and nothing is refused on evidence that does not line up');

  // An ADOPTED row holds neither record (sync writes Meta's body and no
  // param_order), so nothing is claimed about its blanks — unchanged.
  seedTpl('adopted_from_meta', {
    body: 'Hi {{1}}, {{2}} has news for you.', params: [],
    metaStatus: 'approved', metaCategory: 'MARKETING',
    components: [{ type: 'BODY', text: 'Hi {{1}}, {{2}} has news for you.' }],
  });
  const adopted = bc.broadcastBlanks(db, 'adopted_from_meta');
  expect(adopted.count, 2, 'an adopted row still counts its blanks');
  expectTrue(!adopted.names_local && bc.paramCheckFor(db, 'adopted_from_meta', ['name', 'venue']).ok,
    'and nothing is claimed about what they mean — no evidence, no refusal');

  /* ── THE STORED VARIABLE LIST CANNOT VOUCH FOR THE CAMPAIGN THAT COPIED IT ──
   *
   * The fourth evidence tier is this app's own variable list for the template. A
   * campaign's mapping IS that list — the wizard seeds the slots from it — so
   * "they agree" is one record compared with itself. It used to count as PROOF,
   * and that made it possible to silence the reading by writing the swap into the
   * list: MEASURED on an adopted row, needsAck went true → false and the swapped
   * campaign reached the transport with every guest reading "Hi Akan, we would
   * love to see you at Rahul Verma again soon."
   *
   * It still ARGUES (a mapping that contradicts the app's own list is worth a
   * question) and it still never hard-refuses. It just no longer settles anything.
   */
  seedTpl('self_vouching', {
    body: 'Hi {{1}}, {{2}} has news for you.', params: ['venue', 'name'],
    metaStatus: 'approved', metaCategory: 'MARKETING',
    components: [{ type: 'BODY', text: 'Hi {{1}}, {{2}} has news for you.' }],
  });
  const selfM = bc.blankMeanings(db, 'self_vouching', 2);
  expect(selfM[0].evidence, 'stored_order', 'the stored list is still consulted');
  expect(selfM[0].refusable, false, 'it still never refuses on its own');
  expect(selfM[0].proves, false, 'and it no longer settles the blank either');
  const selfV = bc.mappingVerdict(db, 'self_vouching', ['venue', 'name']);
  expectTrue(selfV.needsAck, 'so a campaign that merely copies that list is still read once');
  expect(selfV.hard.length, 0, 'and it is asked, not refused — the tier is evidence, not a verdict');
  /* THE CLIENT MIRROR ALWAYS COUNTED IT THIS WAY (crm-calls/broadcasts/page.tsx
   * treats every non-authoritative agreement as unproven), so the screen used to
   * ask for a reading the server then decided was unnecessary. Now both ask. */
  expectTrue(bc.mappingVerdict(db, 'self_vouching', ['name', 'venue']).needsAck,
    'and so is the opposite order — neither is taken on trust');

  /* ── TWO LOCAL RECORDS THAT DISAGREE SETTLE NOTHING AND REFUSE NOTHING ──
   *
   * The tiers are ranked, so the strongest record that names a blank answered for
   * it with FULL authority even where a weaker record of the same row said
   * something different. That is a door:
   *
   *   MEASURED on ct_winback exactly as production holds it (a free-form row,
   *   stored list ["name","venue"], named blanks in the saved wording). ONE admin
   *   PUT rewrote the saved wording with the two names exchanged — same sentence,
   *   nothing else touched, no confirmation asked, because the editor's
   *   meaning-change guard read var_spec and the stored list and never the
   *   wording. The gate then INVERTED: the swapped mapping became proven
   *   (needsAck false) and the honest one was HARD-refused in its place; the
   *   swapped campaign was created with nobody asked to read anything and reached
   *   'sending'.
   *
   * The count-level version of this has always been handled (two records that
   * disagree about HOW MANY blanks refuse outright). This is the same rule at
   * NAME level, and deliberately softer: a contradiction is not evidence of a
   * swap, it is the absence of evidence either way. So the blank keeps its name,
   * loses its authority, and the real sentence is read once — both mappings
   * treated alike, neither refused, neither waved through. */
  seedTpl('two_records', {
    body: 'Hi {{name}}, welcome to {{venue}}.', params: ['name', 'venue'],
  });
  let twoM = bc.blankMeanings(db, 'two_records', 2);
  expect(twoM[0].evidence, 'saved_wording', 'while the records agree, the saved wording answers');
  expect(twoM[0].proves, true, 'and it settles the blank');
  expect(!!twoM[0].contradicted, false, 'nothing is contradicted');
  expectTrue(!bc.mappingVerdict(db, 'two_records', ['name', 'venue']).needsAck,
    'so the honest mapping sails, exactly as it does today');
  expect(bc.mappingVerdict(db, 'two_records', ['venue', 'name']).hard.length, 2,
    'and the swap is hard-refused, exactly as it is today');

  // The attack: ONE edit of the saved wording, names exchanged, same sentence.
  db.prepare(`UPDATE whatsapp_templates SET body = ? WHERE name = 'two_records'`)
    .run('Hi {{venue}}, welcome to {{name}}.');
  twoM = bc.blankMeanings(db, 'two_records', 2);
  expect(twoM[0].proves, false, 'with the two records disagreeing, nothing is settled');
  expect(twoM[0].refusable, false, 'and nothing is refused outright either');
  expect(!!twoM[0].contradicted, true, 'the blank is marked contradicted');
  expect(twoM[0].name, 'venue', 'while the strongest record still gets to say what it thinks');
  const honestV = bc.mappingVerdict(db, 'two_records', ['name', 'venue']);
  const swapV = bc.mappingVerdict(db, 'two_records', ['venue', 'name']);
  expect(honestV.hard.length, 0, 'the HONEST mapping is no longer hard-refused');
  expectTrue(honestV.needsAck, 'it is asked to be read');
  expect(swapV.hard.length, 0, 'the swapped one is not hard-refused either');
  expectTrue(swapV.needsAck, 'and it is asked to be read too — neither is taken on trust');
  /* AND THE REFUSAL SAYS THE REAL REASON. Meta may have answered nothing at all
   * about this row, so describing it as "the wording WhatsApp returned is not the
   * wording saved here" would be telling the owner something false. */
  const conflictAck = bc.mappingAckCheck(db, 'two_records', ['venue', 'name'], '', {});
  expectTrue(/two records/.test(String(conflictAck.reason || '')),
    'and the reading it asks for names two local records disagreeing, not Meta drift',
    String(conflictAck.reason || '').slice(0, 180));
  expectTrue(!/wording WhatsApp returned/.test(String(conflictAck.reason || '')),
    'never blaming a WhatsApp answer that does not exist');
  /* The other direction is a DISAGREEMENT rather than an unproven blank, and its
   * own sentence already names both records — so it stays as it is. */
  expectTrue(/own record of this template calls blank/.test(
    String(bc.mappingAckCheck(db, 'two_records', ['name', 'venue'], '', {}).reason || '')),
    'and a mapping that contradicts the record is still told which record it contradicts');

  /* ── verdict ──────────────────────────────────────────────────────────── */
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`broadcast-tests: ${pass} passed, ${fail} failed  (sandbox: ${TMP})`);
  if (fail > 0) {
    console.log('FAILED:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  fs.rmSync(TMP, { recursive: true, force: true });
})().catch((e) => {
  console.error('\nbroadcast-tests: harness crashed:', (e && e.stack) || e);
  process.exit(1);
});
