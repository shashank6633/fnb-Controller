#!/usr/bin/env node
/**
 * WHATSAPP ATTACHMENT PROOF — document sends, with Meta STUBBED end to end.
 *
 * Run with:  node scripts/wa-attachment-tests.js     (also: npm test)
 *
 * Sandbox contract copied verbatim from scripts/broadcast-tests.js: every test
 * runs against a VACUUM INTO snapshot of fnb-controller.db (readonly source
 * handle) in a fresh os.tmpdir() dir, process.chdir()ed into BEFORE requiring
 * src/lib/db.ts, with an abort-hard sandbox guard. The REAL shipped code runs —
 * sendReportAttachment, sendWhatsAppTemplate, uploadWaMedia, recordOutbound,
 * processWebhookEvent — with ONLY the network replaced by a recording stub.
 * No test in this file ever reaches graph.facebook.com.
 *
 * WHAT IT PROVES (the build gates):
 *   1  a document send does lookup -> upload -> send, IN THAT ORDER, and the
 *      upload is a real multipart body with the fields Meta requires
 *   2  a failed upload sends NOTHING
 *   3  an oversize file is refused with OUR message, before any network call
 *      and before anything is written to the DB
 *   4  a template whose header is not DOCUMENT is refused BEFORE the upload
 *   5  a text-only template send is BYTE-IDENTICAL to today — request line,
 *      headers, body, and the result object's own shape
 *   6  the send lands in wa_messages, in the recipient's thread, and a real
 *      status webhook ladders it sent -> delivered -> read
 *   7  a failed send is recorded too (an unrecorded send is unauditable)
 *   8  an expired media id is re-uploaded and retried ONCE; a network error is
 *      never retried, so a report can't land in a chat twice
 *   9  a fresh media id is reused across runs; a stale one is re-uploaded
 *  10  Interakt refuses an attachment cleanly instead of guessing a payload
 *  11  the report file store + its authed download route stay private
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const REPO = path.resolve(__dirname, '..');
const LIVE_DB = path.join(REPO, 'fnb-controller.db');
const SRC = path.join(REPO, 'src');

/* -- 0. SNAPSHOT -------------------------------------------------------- */

if (!fs.existsSync(LIVE_DB)) {
  console.error(`wa-attachment-tests: ${LIVE_DB} not found — nothing to snapshot.`);
  process.exit(2);
}

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fnb-wa-attach-tests-')));
const SNAP = path.join(TMP, 'fnb-controller.db');
{
  const src = new Database(LIVE_DB, { readonly: true });
  src.exec(`VACUUM INTO '${SNAP.replace(/'/g, "''")}'`);
  src.close();
}

process.chdir(TMP);

/* -- 1. TYPESCRIPT LOADER ----------------------------------------------- */

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
const db = dbMod.getDb();      // boots the migrations (creates wa_report_files)

function assertSandboxed(handle) {
  const open = path.resolve(handle.name || '');
  if (path.resolve(LIVE_DB) === open || !open.startsWith(path.resolve(TMP))) {
    console.error(`\nFATAL: tests opened ${open}, which is not the snapshot in ${TMP}. Aborting.`);
    process.exit(3);
  }
}
assertSandboxed(db);

const wa = lib('whatsapp.ts');
const inbox = lib('wa-inbox.ts');
const rs = lib('wa-report-send.ts');

/* -- 2. HARNESS --------------------------------------------------------- */

let pass = 0, fail = 0;
const failures = [];
function ok(label) { pass++; console.log(`  ok  ${label}`); }
function bad(label, detail) {
  fail++; failures.push(label);
  console.log(`  XX  ${label}`);
  if (detail) console.log(`      ${detail}`);
}
function expect(actual, expected, label) {
  if (actual === expected) ok(`${label} — ${JSON.stringify(actual)}`);
  else bad(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function expectTrue(cond, label, hint) { cond ? ok(label) : bad(label, hint); }
function section(n, title) { console.log(`\n[${n}] ${title}`); }

/* -- 3. FIXTURES -------------------------------------------------------- */

const PNID = '111222333444555';
const WABA = '999888777666555';
const TOKEN = 'EAAtest-access-token';
const TPL = 'akan_daily_report';
const LANG = 'en';

wa.setWaConfig('wa_api_provider', 'meta_cloud');
wa.setWaConfig('wa_phone_number_id', PNID);
wa.setWaConfig('wa_business_account_id', WABA);
wa.setWaConfig('wa_access_token', TOKEN);
wa.setWaConfig('wa_notifications_enabled', '1');

// Distinct fake numbers, outside any real guest range.
const PH = (n) => `9190000009${String(n).padStart(2, '0')}`;

const PDF = Buffer.from('%PDF-1.4\n' + 'stock variance report bytes '.repeat(40) + '\n%%EOF\n');
const FILENAME = 'stock-variance-2026-09-09.pdf';

/* -- 4. THE STUB — every fetch this suite makes is recorded, none escapes - */

let calls = [];                        // every request, in order
let mediaSeq = 0, wamidSeq = 0;
// Per-test overrides: return a Response to take over, or undefined to fall through.
let onLookup = null, onUpload = null, onSend = null;

function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const stubFetch = async (url, init) => {
  const u = String(url);
  const rec = { url: u, method: (init && init.method) || 'GET', headers: (init && init.headers) || {}, body: init && init.body };
  calls.push(rec);

  if (u.includes('/message_templates')) {
    rec.kind = 'lookup';
    if (onLookup) { const r = onLookup(rec); if (r) return r; }
    return jsonRes({ data: [{ name: TPL, language: LANG, status: 'APPROVED', components: [
      { type: 'HEADER', format: 'DOCUMENT' },
      { type: 'BODY', text: 'Report for {{1}}' },
    ] }] });
  }
  if (u.endsWith('/media')) {
    rec.kind = 'upload';
    if (onUpload) { const r = onUpload(rec); if (r) return r; }
    return jsonRes({ id: `media.stub.${++mediaSeq}` });
  }
  if (u.endsWith('/messages')) {
    rec.kind = 'send';
    if (onSend) { const r = onSend(rec); if (r) return r; }
    return jsonRes({ messages: [{ id: `wamid.stub.${++wamidSeq}` }] });
  }
  rec.kind = 'unexpected';
  throw new Error(`stub: unexpected URL ${u}`);
};

function reset() {
  calls = [];
  onLookup = onUpload = onSend = null;
  wa.clearWaTemplateShapeCache();
}
const kinds = () => calls.map((c) => c.kind);
const bodyOf = (c) => JSON.parse(String(c.body));

// A guard: nothing in this suite may ever reach the real network.
globalThis.fetch = async (url) => { throw new Error(`UNSTUBBED NETWORK CALL to ${url}`); };

/* -- 5. TESTS ----------------------------------------------------------- */

(async () => {

  section(1, 'A document send: lookup -> upload -> send, in that order');
  reset();
  {
    const res = await rs.sendReportAttachment(db, {
      reportKey: 'stock_variance_daily', period: '2026-09-09',
      filename: FILENAME, mime: 'application/pdf', data: PDF,
      templateName: TPL, language: LANG, bodyParams: ['09 Sep 2026'],
      recipients: [PH(1)], createdBy: 'u_test',
    }, { fetchImpl: stubFetch });

    expect(res.ok, true, 'the run reports success');
    expect(res.stage, 'sent', 'it reached the send stage');
    expect(kinds().join(' -> '), 'lookup -> upload -> send', 'ORDER: verify, then upload, then send');
    expect(res.sent.length, 1, 'one recipient was sent to');
    expect(res.uploads, 1, 'exactly one upload for one file');

    // -- the multipart shape --
    const up = calls.find((c) => c.kind === 'upload');
    expect(up.url, `https://graph.facebook.com/${wa.META_GRAPH_VERSION}/${PNID}/media`, 'upload hits {phone-number-id}/media on the shared Graph version');
    expect(up.method, 'POST', 'upload is a POST');
    expect(up.headers.Authorization, `Bearer ${TOKEN}`, 'upload carries the Bearer token');
    expectTrue(!('Content-Type' in up.headers) && !('content-type' in up.headers),
      'upload sets NO Content-Type header (fetch must supply the multipart boundary)',
      `headers were ${JSON.stringify(Object.keys(up.headers))}`);
    expectTrue(up.body instanceof FormData, 'upload body is real multipart FormData', `got ${up.body && up.body.constructor && up.body.constructor.name}`);
    expect(up.body.get('messaging_product'), 'whatsapp', 'multipart field messaging_product');
    expect(up.body.get('type'), 'application/pdf', 'multipart field type');
    const filePart = up.body.get('file');
    expect(filePart.name, FILENAME, 'multipart file part carries the filename');
    expect(filePart.size, PDF.byteLength, 'multipart file part carries every byte');
    expect(filePart.type, 'application/pdf', 'multipart file part carries the MIME type');

    // -- the send payload --
    const send = bodyOf(calls.find((c) => c.kind === 'send'));
    expect(send.type, 'template', 'the message is a template send');
    const header = send.template.components.find((c) => c.type === 'header');
    expect(JSON.stringify(header), JSON.stringify({
      type: 'header',
      parameters: [{ type: 'document', document: { id: 'media.stub.1', filename: FILENAME } }],
    }), 'header component is ONE document parameter carrying the uploaded id + the filename the recipient sees');
    const body = send.template.components.find((c) => c.type === 'body');
    expect(JSON.stringify(body.parameters), JSON.stringify([{ type: 'text', text: '09 Sep 2026' }]), 'body params still ride as positional text');
  }

  section(2, 'A failed upload never sends');
  reset();
  {
    onUpload = () => jsonRes({ error: { message: 'Upload rejected', code: 131053 } }, 500);
    const res = await rs.sendReportAttachment(db, {
      reportKey: 'stock_variance_daily', period: '2026-09-10',
      filename: 'v2.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4 v2'),
      templateName: TPL, language: LANG, recipients: [PH(2)],
    }, { fetchImpl: stubFetch });

    expect(res.ok, false, 'the run reports failure');
    expect(res.stage, 'verified', 'it stopped at the verified stage — never reached "uploaded"');
    expect(res.refused && res.refused.reason, 'upload_failed', 'refusal names the upload');
    expect(kinds().filter((k) => k === 'send').length, 0, 'ZERO messages were sent');
    expect(res.sent.length + res.failed.length, 0, 'no recipient was touched');
    const stray = db.prepare("SELECT COUNT(*) n FROM wa_messages WHERE body = 'v2.pdf'").get().n;
    expect(stray, 0, 'no half-built message was recorded in any thread');
    const stored = db.prepare("SELECT provider_error FROM wa_report_files WHERE filename = 'v2.pdf'").get();
    expectTrue(!!stored && /Upload rejected/.test(stored.provider_error),
      'the report is still stored and downloadable, with the upload error recorded on it');
  }

  section(3, 'Oversize refused with OUR message, before any network or write');
  reset();
  {
    const big = Buffer.alloc(wa.WA_UPLOAD_MAX_BYTES + 1, 0x41);
    const before = db.prepare('SELECT COUNT(*) n FROM wa_report_files').get().n;
    const res = await rs.sendReportAttachment(db, {
      reportKey: 'giant', period: '2026-09-09',
      filename: 'giant.pdf', mime: 'application/pdf', data: big,
      templateName: TPL, language: LANG, recipients: [PH(3)],
    }, { fetchImpl: stubFetch });

    expect(res.ok, false, 'the run reports failure');
    expect(res.refused && res.refused.reason, 'too_large', 'refusal reason is ours, not a provider code');
    expectTrue(/10\.0 MB WhatsApp attachment limit/.test(res.refused.detail),
      'the message names OUR limit in plain units', res.refused.detail);
    expectTrue(/giant\.pdf is 10\.0 MB/.test(res.refused.detail),
      'the message names the file and its actual size', res.refused.detail);
    expect(calls.length, 0, 'NOT ONE network call was made');
    expect(db.prepare('SELECT COUNT(*) n FROM wa_report_files').get().n, before,
      'nothing was written to the DB — an oversize blob never lands in a backup');

    // The transport helper refuses on its own too, with no config read.
    const up = await wa.uploadWaMedia({ data: big, filename: 'giant.pdf', mime: 'application/pdf' }, { fetchImpl: stubFetch });
    expect(up.ok, false, 'uploadWaMedia refuses oversize by itself');
    expect(up.reason, 'too_large', 'uploadWaMedia reason');
    const badType = await wa.uploadWaMedia({ data: PDF, filename: 'x.zip', mime: 'application/zip' }, { fetchImpl: stubFetch });
    expect(badType.reason, 'unsupported_type', 'an unlisted MIME type is refused, not forwarded to Meta');
  }

  section(4, 'A template with no document header is refused BEFORE the upload');
  reset();
  {
    onLookup = () => jsonRes({ data: [{ name: TPL, language: LANG, status: 'APPROVED', components: [
      { type: 'HEADER', format: 'TEXT', text: 'Daily report' }, { type: 'BODY', text: 'x' },
    ] }] });
    const res = await rs.sendReportAttachment(db, {
      reportKey: 'texthdr', period: '2026-09-09',
      filename: 'texthdr.pdf', mime: 'application/pdf', data: PDF,
      templateName: TPL, language: LANG, recipients: [PH(4)],
    }, { fetchImpl: stubFetch });

    expect(res.ok, false, 'the run reports failure');
    expect(res.stage, 'stored', 'it stopped at "stored" — before verified, before uploaded');
    expect(res.refused && res.refused.reason, 'header_format_mismatch', 'refusal names the header format');
    expectTrue(/has a TEXT header/.test(res.refused.detail) && /Nothing was sent/.test(res.refused.detail),
      'the message says what the template actually has, and that nothing was sent', res.refused.detail);
    expect(kinds().join(','), 'lookup', 'ONLY the lookup happened — no upload, no send');

    // A template that does not exist, and one not yet approved.
    reset();
    onLookup = () => jsonRes({ data: [] });
    const missing = await rs.sendReportAttachment(db, {
      reportKey: 'missing', period: 'p', filename: 'a.pdf', mime: 'application/pdf', data: PDF,
      templateName: 'no_such_template', recipients: [PH(4)],
    }, { fetchImpl: stubFetch });
    expect(missing.refused.reason, 'not_found', 'an unknown template name is refused');
    expect(kinds().filter((k) => k !== 'lookup').length, 0, 'and nothing was uploaded or sent');

    reset();
    onLookup = () => jsonRes({ data: [{ name: TPL, language: LANG, status: 'PENDING', components: [{ type: 'HEADER', format: 'DOCUMENT' }] }] });
    const pending = await rs.sendReportAttachment(db, {
      reportKey: 'pending', period: 'p', filename: 'a.pdf', mime: 'application/pdf', data: PDF,
      templateName: TPL, recipients: [PH(4)],
    }, { fetchImpl: stubFetch });
    expect(pending.refused.reason, 'template_not_approved', 'a PENDING template is refused');

    // Meta's ?name= filter is a PREFIX match — the exact name must win.
    reset();
    onLookup = () => jsonRes({ data: [
      { name: TPL + '_v2', language: LANG, status: 'APPROVED', components: [{ type: 'HEADER', format: 'DOCUMENT' }] },
    ] });
    const prefix = await rs.sendReportAttachment(db, {
      reportKey: 'prefix', period: 'p', filename: 'a.pdf', mime: 'application/pdf', data: PDF,
      templateName: TPL, recipients: [PH(4)],
    }, { fetchImpl: stubFetch });
    expect(prefix.refused.reason, 'not_found',
      "a prefix-match lookalike ('akan_daily_report_v2') is NOT accepted as the template");

    // Without the WABA id the header format cannot be verified at all.
    reset();
    wa.setWaConfig('wa_business_account_id', '');
    const noWaba = await rs.sendReportAttachment(db, {
      reportKey: 'nowaba', period: 'p', filename: 'a.pdf', mime: 'application/pdf', data: PDF,
      templateName: TPL, recipients: [PH(4)],
    }, { fetchImpl: stubFetch });
    expect(noWaba.refused.reason, 'not_configured', 'no WABA id -> refuse rather than send unverified');
    expect(calls.length, 0, 'and no call is made at all');
    wa.setWaConfig('wa_business_account_id', WABA);
  }

  section(5, 'A text-only template send is BYTE-IDENTICAL to today');
  reset();
  {
    // globalThis.fetch — NOT an injected stub — so this exercises the exact
    // default path every existing caller uses.
    const captured = [];
    globalThis.fetch = async (url, init) => { captured.push({ url, init }); return jsonRes({ messages: [{ id: 'wamid.plain.1' }] }); };

    const res = await wa.sendWhatsAppTemplate('9876543210', 'req_approved', 'en_US', ['REQ-1', 'Kitchen'], { headerParams: ['AKAN'] });

    const GOLDEN_URL = `https://graph.facebook.com/${wa.META_GRAPH_VERSION}/${PNID}/messages`;
    // Written out by hand from the pre-change code path, NOT generated from it.
    const GOLDEN_BODY = '{"messaging_product":"whatsapp","recipient_type":"individual","to":"919876543210","type":"template",'
      + '"template":{"name":"req_approved","language":{"code":"en_US"},"components":['
      + '{"type":"header","parameters":[{"type":"text","text":"AKAN"}]},'
      + '{"type":"body","parameters":[{"type":"text","text":"REQ-1"},{"type":"text","text":"Kitchen"}]}]}}';

    expect(captured.length, 1, 'one request was made');
    expect(String(captured[0].url), GOLDEN_URL, 'request URL unchanged');
    expect(captured[0].init.method, 'POST', 'method unchanged');
    expect(JSON.stringify(captured[0].init.headers), JSON.stringify({
      'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json',
    }), 'headers unchanged, in the same order');
    expect(captured[0].init.body, GOLDEN_BODY, 'REQUEST BODY byte-identical to the hand-written golden');
    expectTrue(!('signal' in captured[0].init), 'no timeout signal was added to the existing path');
    expect(JSON.stringify(res), JSON.stringify({ ok: true, provider: 'meta_cloud', message_id: 'wamid.plain.1' }),
      'success result object unchanged');

    // The OTP button path, likewise untouched.
    captured.length = 0;
    await wa.sendWhatsAppTemplate('9876543210', 'akan_otp', 'en', ['123456'], { otpButtonCode: '123456' });
    expect(captured[0].init.body,
      '{"messaging_product":"whatsapp","recipient_type":"individual","to":"919876543210","type":"template",'
      + '"template":{"name":"akan_otp","language":{"code":"en"},"components":['
      + '{"type":"body","parameters":[{"type":"text","text":"123456"}]},'
      + '{"type":"button","sub_type":"url","index":"0","parameters":[{"type":"text","text":"123456"}]}]}}',
      'OTP template request body byte-identical');

    // A FAILED text send must keep its exact two-key failure object, so no
    // whatsapp_events_log payload changes shape.
    captured.length = 0;
    globalThis.fetch = async () => jsonRes({ error: { message: 'Template does not exist', code: 132001 } }, 400);
    const failed = await wa.sendWhatsAppTemplate('9876543210', 'nope', 'en', ['x']);
    expect(JSON.stringify(Object.keys(failed)), JSON.stringify(['ok', 'reason', 'detail']),
      'failure result on the text path carries NO extra diagnostic keys');
    expect(failed.detail, 'Template does not exist', 'failure detail unchanged');

    // The media path is where the diagnostics ride, so a retry can be decided.
    const mediaFail = await wa.sendWhatsAppTemplate('9876543210', 'nope', 'en', ['x'], {
      headerMedia: { kind: 'document', media_id: 'm1', filename: 'a.pdf' },
    });
    expect(mediaFail.error_code, 132001, "the media path DOES surface Meta's error code");
    expect(mediaFail.http_status, 400, 'and the HTTP status');

    // headerParams + headerMedia together is a Meta 400 — refuse locally.
    const both = await wa.sendWhatsAppTemplate('9876543210', TPL, 'en', ['x'], {
      headerParams: ['AKAN'], headerMedia: { kind: 'document', media_id: 'm1' },
    });
    expect(both.ok, false, 'a header carrying BOTH text params and media is refused');
    expectTrue(/never both/.test(both.detail), 'and says why', both.detail);

    globalThis.fetch = async (url) => { throw new Error(`UNSTUBBED NETWORK CALL to ${url}`); };
  }

  section(6, 'The send is recorded in wa_messages, and the webhook ladders it');
  reset();
  {
    const to = PH(6);
    const res = await rs.sendReportAttachment(db, {
      reportKey: 'stock_variance_daily', period: '2026-09-11',
      filename: 'variance-11.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4 eleven'),
      templateName: TPL, language: LANG, bodyParams: ['11 Sep 2026'],
      recipients: [to], sentBy: 'report:stock_variance_daily',
    }, { fetchImpl: stubFetch });
    expect(res.ok, true, 'the send succeeded');

    const wamid = res.sent[0].wamid;
    const row = db.prepare('SELECT * FROM wa_messages WHERE wamid = ?').get(wamid);
    expectTrue(!!row, 'a wa_messages row exists for the send');
    expect(row.direction, 'out', 'recorded as outbound');
    expect(row.msg_type, 'document', 'recorded as a document');
    expect(row.body, 'variance-11.pdf', 'the bubble names the file');
    expect(row.status, 'sent', 'status starts at sent');
    expect(row.sent_by, 'report:stock_variance_daily', 'the bubble is stamped with the report that sent it');
    expect(Number(row.report_file_id), res.file_id, 'the bubble links the exact file the recipient received');

    const conv = db.prepare('SELECT * FROM wa_conversations WHERE id = ?').get(row.conversation_id);
    expect(conv.phone_key, to.slice(-10), "it landed in THAT recipient's thread (guest-unify key)");
    expect(conv.last_message_preview, 'variance-11.pdf', 'the thread preview shows the report');
    expectTrue(!!conv.last_outbound_at, "the conversation's last_outbound_at was bumped");

    // Now the real webhook path — the delivery ladder must move on this row.
    const statusEvent = (status) => ({ entry: [{ changes: [{ value: {
      messaging_product: 'whatsapp',
      statuses: [{ id: wamid, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: to }],
    } }] }] });
    for (const s of ['delivered', 'read']) {
      const json = JSON.stringify(statusEvent(s));
      const info = db.prepare("INSERT INTO whatsapp_events_log (kind, payload) VALUES ('webhook', ?)").run(json);
      await inbox.processWebhookEvent(db, Number(info.lastInsertRowid), json);
    }
    expect(db.prepare('SELECT status FROM wa_messages WHERE wamid = ?').get(wamid).status, 'read',
      'a real status webhook laddered the attachment sent -> delivered -> read');
    expect(Number(db.prepare('SELECT report_file_id FROM wa_messages WHERE wamid = ?').get(wamid).report_file_id),
      res.file_id, 'and the file link survived the status updates');

    // The attempt is in the shared audit log too.
    const logged = db.prepare(
      `SELECT COUNT(*) n FROM whatsapp_events_log WHERE kind='send_attempt' AND payload LIKE '%report_attachment%' AND payload LIKE ?`,
    ).get(`%${wamid}%`).n;
    expectTrue(logged > 0, 'the attempt is in whatsapp_events_log through the shared send-attempt door');
  }

  section(7, 'A failed send is recorded too');
  reset();
  {
    const to = PH(7);
    onSend = () => jsonRes({ error: { message: 'Recipient has not opted in', code: 131047 } }, 400);
    const res = await rs.sendReportAttachment(db, {
      reportKey: 'stock_variance_daily', period: '2026-09-12',
      filename: 'variance-12.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4 twelve'),
      templateName: TPL, language: LANG, recipients: [to],
    }, { fetchImpl: stubFetch });

    expect(res.ok, false, 'the run reports failure');
    expect(res.failed.length, 1, 'the recipient is on the failed list');
    const conv = db.prepare('SELECT id FROM wa_conversations WHERE phone_key = ?').get(to.slice(-10));
    const row = db.prepare('SELECT * FROM wa_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1').get(conv.id);
    expect(row.status, 'failed', 'the failed send IS in the thread, marked failed');
    expect(row.body, 'variance-12.pdf', 'naming the report that did not arrive');
    expect(row.error_detail, 'Recipient has not opted in', 'with the provider reason attached');
    expect(Number(row.report_file_id), res.file_id, 'and still linked to the file, so it can be resent');
  }

  section(8, 'An expired media id is retried once; a network error never is');
  reset();
  {
    const to = PH(8);
    const args = {
      reportKey: 'expiring', period: '2026-09-13',
      filename: 'expiring.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4 expiring'),
      templateName: TPL, language: LANG, recipients: [to],
    };
    // Run 1 — stores a media id.
    await rs.sendReportAttachment(db, args, { fetchImpl: stubFetch });
    const stored = db.prepare('SELECT id, provider_media_id FROM wa_report_files WHERE filename = ?').get('expiring.pdf');
    expectTrue(!!stored.provider_media_id, 'run 1 cached a media id on the file');

    // Run 2 — Meta rejects the REUSED id once, then accepts after re-upload.
    reset();
    let sends = 0;
    onSend = () => (++sends === 1
      ? jsonRes({ error: { message: 'Media handle no longer valid', code: 131053 } }, 400)
      : undefined);
    const res2 = await rs.sendReportAttachment(db, args, { fetchImpl: stubFetch });
    expect(res2.ok, true, 'the retry delivered the report');
    expect(kinds().join(' -> '), 'lookup -> send -> upload -> send',
      'the reused id was tried, rejected, re-uploaded, and sent ONCE more');
    expect(res2.uploads, 1, 'exactly one re-upload');
    expect(res2.sent.length, 1, 'the recipient got exactly ONE message');

    // Run 3 — a NETWORK error must never be retried: Meta may have accepted a
    // message whose response we lost, and a retry would double-send.
    reset();
    let attempts = 0;
    onSend = () => { attempts++; throw new Error('socket hang up'); };
    const res3 = await rs.sendReportAttachment(db, args, { fetchImpl: stubFetch });
    expect(res3.ok, false, 'the run reports failure');
    expect(attempts, 1, 'exactly ONE send attempt — a network error is never retried');
    expect(res3.uploads, 0, 'and no speculative re-upload happened');
  }

  section(9, 'A fresh media id is reused; a stale one is re-uploaded');
  reset();
  {
    const args = {
      reportKey: 'reuse', period: '2026-09-14',
      filename: 'reuse.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4 reuse'),
      templateName: TPL, language: LANG, recipients: [PH(91), PH(92), PH(91)],
    };
    const r1 = await rs.sendReportAttachment(db, args, { fetchImpl: stubFetch });
    expect(r1.sent.length, 2, 'a number listed twice is sent to ONCE');
    expect(r1.uploads, 1, 'two recipients, one upload');

    reset();
    const r2 = await rs.sendReportAttachment(db, args, { fetchImpl: stubFetch });
    expect(r2.uploads, 0, 'a second run inside the TTL reuses the stored media id');
    expect(kinds().filter((k) => k === 'upload').length, 0, 'no upload call was made');

    reset();
    const stale = Date.now() + rs.WA_MEDIA_ID_TTL_MS + 60000;
    const r3 = await rs.sendReportAttachment(db, args, { fetchImpl: stubFetch, nowMs: stale });
    expect(r3.uploads, 1, 'once the id is past its TTL the file is re-uploaded');
  }

  section(10, 'Interakt refuses an attachment cleanly');
  reset();
  {
    wa.setWaConfig('wa_api_provider', 'interakt');
    wa.setWaConfig('wa_interakt_api_key', 'interakt-key');
    const direct = await wa.sendWhatsAppTemplate(PH(10), TPL, 'en', ['x'], {
      headerMedia: { kind: 'document', media_id: 'm1', filename: 'a.pdf' },
    });
    expect(direct.ok, false, 'the transport refuses');
    expectTrue(/only supported on the Meta Cloud provider/.test(direct.detail),
      'and names the fix rather than guessing an Interakt payload', direct.detail);
    expect(calls.length, 0, 'no Interakt request was attempted');

    const res = await rs.sendReportAttachment(db, {
      reportKey: 'interakt', period: 'p', filename: 'a.pdf', mime: 'application/pdf', data: PDF,
      templateName: TPL, recipients: [PH(10)],
    }, { fetchImpl: stubFetch });
    expect(res.refused && res.refused.reason, 'not_configured', 'the workflow refuses before storing anything');
    wa.setWaConfig('wa_api_provider', 'meta_cloud');
  }

  section(11, 'The report store and its download route stay private');
  reset();
  {
    const id = rs.storeReportFile(db, {
      reportKey: 'priv', period: '2026-09-09', filename: 'priv.pdf',
      mime: 'application/pdf', data: PDF, createdBy: 'u_test',
    });
    const got = rs.getReportFile(db, id);
    expect(Buffer.from(got.data).toString('utf8'), PDF.toString('utf8'), 'the stored bytes come back intact');
    const again = rs.storeReportFile(db, {
      reportKey: 'priv', period: '2026-09-09', filename: 'priv.pdf', mime: 'application/pdf', data: PDF,
    });
    expect(again, id, 'identical bytes for the same report+period reuse the row (one BLOB, not two)');

    const routePath = path.join(SRC, 'app', 'api', 'crm-calls', 'reports', 'files', '[id]', 'route.ts');
    const route = fs.readFileSync(routePath, 'utf8');
    expectTrue(/getCurrentUser/.test(route), 'the download route self-checks the session');
    expectTrue(/isManagement\(me\)/.test(route), 'and gates on isManagement — admin/manager/HOD only');
    expectTrue(/Content-Disposition.*attachment/.test(route), 'it always downloads, never renders inline on the app origin');
    expectTrue(/private, no-store/.test(route), 'and forbids caching a P&L on disk');
    // src/proxy.ts makes ANY path containing '/print' public. This route's path
    // must never trip that.
    expectTrue(!routePath.includes('/print'), 'the route path cannot trip the isPublic() /print carve-out');
    const proxy = fs.readFileSync(path.join(SRC, 'proxy.ts'), 'utf8');
    expectTrue(!/reports\/files/.test(proxy), 'and nothing in proxy.ts makes the report files public');
  }

  /* -- verdict ---------------------------------------------------------- */
  console.log(`\n${'-'.repeat(60)}`);
  console.log(`wa-attachment-tests: ${pass} passed, ${fail} failed  (sandbox: ${TMP})`);
  if (fail > 0) {
    console.log('FAILED:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  fs.rmSync(TMP, { recursive: true, force: true });
})().catch((e) => {
  console.error('\nwa-attachment-tests: harness crashed:', (e && e.stack) || e);
  process.exit(1);
});
