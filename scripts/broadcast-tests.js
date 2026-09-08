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
