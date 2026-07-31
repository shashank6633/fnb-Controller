/**
 * Win-back engine — proof run against a COPY of the production database.
 *
 * Run it from a scratch directory holding a copy of fnb-controller.db, so
 * getDb() (which resolves cwd/fnb-controller.db) never touches the real file:
 *
 *   cd /tmp/wb && npx tsx /path/to/repo/scripts/winback-proof.ts
 *
 * Every provider call is stubbed at globalThis.fetch — nothing leaves the
 * machine and no real number is ever messaged.
 */
import path from 'path';
import { getDb } from '../src/lib/db';
import { setCtSetting, ctSetting } from '../src/lib/ct/settings';
import {
  winbackSegment, createCampaign, sendCampaign, attributeCampaign,
  campaignReport, countByStatus, defaultLapsedDays, winbackEnabled,
  previewMessage, parseCampaignMeta, targetVars, WINBACK_FLAG,
} from '../src/lib/ct/winback';

const cwdDb = path.join(process.cwd(), 'fnb-controller.db');
if (!cwdDb.includes('scratchpad') && !cwdDb.includes('/tmp/')) {
  console.error(`REFUSING TO RUN: this would open ${cwdDb}. cd into a scratch copy first.`);
  process.exit(1);
}
console.log(`DB under test: ${cwdDb}\n`);

async function main() {
  const db = getDb();
  const line = (s = '') => console.log(s);
  const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 62 - s.length))}`); };

  // ── 1. Segment: bucket distribution over the real 27 ct_guests ─────────────
  h('1. SEGMENT — bucket distribution');
  line(`ct_settings.lapsed_days = ${ctSetting(db, 'lapsed_days')} → default bucket ${defaultLapsedDays(db)}`);

  for (const b of [30, 60, 90, 120]) {
    const s = winbackSegment(db, { days: b, includeNever: false });
    line(`  ${String(b).padStart(3)}+ days → in_bucket ${String(s.counts.in_bucket).padStart(3)}   (cutoff ${s.cutoff_date})`);
  }
  const base = winbackSegment(db, { days: 30, includeNever: true });
  line(`  universe: ${base.counts.total_guests} guests · active(<30d) ${base.counts.active} · never-visited ${base.counts.never}`);
  line(`  cumulative: >=30 ${base.counts.b30} · >=60 ${base.counts.b60} · >=90 ${base.counts.b90} · >=120 ${base.counts.b120}`);

  const seg30 = winbackSegment(db, { days: 30, includeNever: false, sort: 'days', dir: 'desc' });
  line();
  line('  30+ day bucket, longest-gone first:');
  for (const g of seg30.guests) {
    line(`    ${g.name.padEnd(18)} ${g.phone_e164}  last ${g.last_visit_at} (${g.last_visit_source})  ${g.days_since}d  visits ${g.visits}  spend ₹${g.total_spend}  band ${g.band}  contactable ${g.contactable}`);
  }

  // ── 1b. Last-ordered items + spend, when an order carries a phone ──────────
  h('1b. SEGMENT — last-ordered items (needs orders.guest_mobile)');
  const withPhone = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE COALESCE(guest_mobile,'') <> ''`).get() as any;
  line(`  orders carrying a guest_mobile in the live data: ${withPhone.n} of ${(db.prepare('SELECT COUNT(*) AS n FROM orders').get() as any).n}`);
  const outletId = (db.prepare(`SELECT id FROM outlets WHERE is_default = 1 LIMIT 1`).get() as any)?.id || '';
  const dinerPhone = '+919848010822';   // Arjun Nair, 41 days away
  db.prepare(`INSERT INTO orders (id, outlet_id, order_number, status, total, guest_name, guest_mobile, created_at, settled_at)
              VALUES ('proof-old-order', ?, 'PROOF-OLD', 'settled', 3150, 'Arjun Nair', ?, '2026-05-01T14:00:00.000Z', '2026-05-01T15:00:00.000Z')`)
    .run(outletId, dinerPhone);
  for (const [i, nm] of ['Hyderabadi Dum Biryani', 'Paneer Tikka', 'Old Monk 60ml'].entries()) {
    db.prepare(`INSERT INTO order_items (id, order_id, name, quantity, unit_price, line_total, status)
                VALUES (?, 'proof-old-order', ?, 1, 0, 0, 'served')`).run(`proof-oi-${i}`, nm);
  }
  const segItems = winbackSegment(db, { days: 30, includeNever: false, outletId });
  for (const g of segItems.guests.filter(x => x.phone_e164 === dinerPhone)) {
    line(`  ${g.name}: last visit ${g.last_visit_at} (${g.last_visit_source}) · spend ₹${g.total_spend} · last ordered → ${g.last_items.join(', ') || '(none)'}`);
  }
  db.prepare(`DELETE FROM order_items WHERE order_id = 'proof-old-order'`).run();
  db.prepare(`DELETE FROM orders WHERE id = 'proof-old-order'`).run();
  line('  (test order removed again — the rest of this run uses the untouched data)');

  // ── 2. Campaign creation from the segment ──────────────────────────────────
  h('2. CAMPAIGN — create a draft from the 30+ bucket');
  const created = createCampaign(db, {
    name: 'PROOF · Win-back 30+ days',
    createdBy: 'proof-script',
    guests: seg30.guests.map(g => ({ guest_id: g.guest_id, phone_e164: g.phone_e164, name: g.name })),
    meta: {
      bucket_days: 30, include_never: false, cutoff_date: seg30.cutoff_date, created_from: 'winback',
      provider_template: 'akan_winback_offer', language: 'en', param_order: ['name', 'days'],
      preview_body: 'Hi {{1}}, it has been {{2}}+ days since we last saw you at AKAN. Your table is waiting — reply BOOK and we will hold one.',
      attribution_days: 30,
    },
  });
  const cid = created.campaign.id;
  const meta = parseCampaignMeta(created.campaign.segment);
  line(`  campaign ${cid}`);
  line(`  status=${created.campaign.status}  targets=${created.targets}  skipped_no_phone=${created.skipped_no_phone}  deduped=${created.deduped}`);
  line(`  target rows:`);
  for (const t of db.prepare(`SELECT * FROM ct_campaign_targets WHERE campaign_id = ? ORDER BY name`).all(cid) as any[]) {
    line(`    ${t.name.padEnd(18)} ${t.phone_e164}  guest_id=${t.guest_id ? t.guest_id.slice(0, 8) : 'null'}  status=${t.send_status}  sent_at=${t.sent_at}  returned_at=${t.returned_at}  return_value=${t.return_value}`);
  }
  const firstTarget = db.prepare(`SELECT * FROM ct_campaign_targets WHERE campaign_id = ? ORDER BY name LIMIT 1`).get(cid) as any;
  line(`  rendered preview for ${firstTarget.name}:`);
  line(`    "${previewMessage(meta, targetVars(firstTarget, meta, 'AKAN'))}"`);

  // ── 3. Flag OFF is a hard no-op ────────────────────────────────────────────
  h('3. SAFETY — flag OFF is a no-op (this is the whole safety property)');
  setCtSetting(db, WINBACK_FLAG, '0');
  // Give the provider real-looking (fake) credentials so the ONLY thing standing
  // between this campaign and a send is the flag.
  for (const [k, v] of [['wa_api_provider', 'meta_cloud'], ['wa_phone_number_id', 'PROOF_PNID'], ['wa_access_token', 'PROOF_TOKEN']]) {
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(k, v);
  }
  let fetchCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    fetchCalls++;
    const body = JSON.parse(String(init?.body || '{}'));
    line(`      [stub] POST ${String(url).replace(/https:\/\/graph\.facebook\.com/, 'graph…')} to=${body.to} template=${body.template?.name} params=${JSON.stringify(body.template?.components?.[0]?.parameters?.map((p: any) => p.text) ?? [])}`);
    return new Response(JSON.stringify({ messages: [{ id: `wamid.PROOF${fetchCalls}` }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;

  line(`  winbackEnabled = ${winbackEnabled(db)}   (wa configured with fake creds: yes)`);
  const offRes = await sendCampaign(db, cid, {});
  line(`  sendCampaign → ok=${offRes.ok} refused=${offRes.refused} attempted=${offRes.attempted} sent=${offRes.sent}`);
  line(`  provider calls made: ${fetchCalls}  (must be 0)`);
  const afterOff = countByStatus(db, cid);
  line(`  target statuses unchanged: ${JSON.stringify(afterOff)}`);

  // ── 4. Flag ON → send (provider stubbed) ───────────────────────────────────
  h('4. SEND — flag ON, provider stubbed, explicit call only');
  setCtSetting(db, WINBACK_FLAG, '1');
  line(`  winbackEnabled = ${winbackEnabled(db)}`);
  const sendRes = await sendCampaign(db, cid, { venue: 'AKAN' });
  line(`  sendCampaign → ok=${sendRes.ok} attempted=${sendRes.attempted} sent=${sendRes.sent} failed=${sendRes.failed} remaining=${sendRes.remaining} status=${sendRes.status}`);
  line(`  provider calls made: ${fetchCalls}`);

  // ── 5. Re-send is a no-op — UNIQUE + status make a double-send impossible ──
  h('5. RESUMABILITY — pressing Send again messages nobody twice');
  const before = fetchCalls;
  const again = await sendCampaign(db, cid, { venue: 'AKAN' });
  line(`  sendCampaign (2nd press) → refused=${again.refused} attempted=${again.attempted} sent=${again.sent}`);
  line(`  extra provider calls: ${fetchCalls - before}  (must be 0)`);

  // Duplicate insert attempt into the same campaign (the index doing its job).
  const dupTarget = db.prepare(`SELECT * FROM ct_campaign_targets WHERE campaign_id = ? LIMIT 1`).get(cid) as any;
  const dup = db.prepare(`INSERT OR IGNORE INTO ct_campaign_targets (id, campaign_id, guest_id, phone_e164, name, send_status) VALUES (?,?,?,?,?, 'pending')`)
    .run('dup-proof', cid, dupTarget.guest_id, dupTarget.phone_e164, dupTarget.name);
  line(`  re-inserting ${dupTarget.phone_e164} into the same campaign → rows inserted: ${dup.changes}  (UNIQUE(campaign_id, phone_e164) held)`);

  // ── 6. Partial failure resumes without re-messaging ────────────────────────
  h('6. PARTIAL FAILURE — one bad batch, then resume');
  const camp2 = createCampaign(db, {
    name: 'PROOF · partial failure',
    createdBy: 'proof-script',
    guests: seg30.guests.map(g => ({ guest_id: g.guest_id, phone_e164: g.phone_e164, name: g.name })),
    meta: { ...meta, provider_template: 'akan_winback_offer' },
  });
  let callNo = 0;
  globalThis.fetch = (async () => {
    callNo++;
    if (callNo <= 2) return new Response(JSON.stringify({ messages: [{ id: `wamid.OK${callNo}` }] }), { status: 200 });
    return new Response(JSON.stringify({ error: { message: 'stubbed provider outage' } }), { status: 500 });
  }) as any;
  const p1 = await sendCampaign(db, camp2.campaign.id, { venue: 'AKAN' });
  line(`  first run → sent=${p1.sent} failed=${p1.failed} status=${p1.status}`);
  line(`  statuses: ${JSON.stringify(countByStatus(db, camp2.campaign.id))}`);
  globalThis.fetch = (async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.RECOVERED' }] }), { status: 200 })) as any;
  const p2 = await sendCampaign(db, camp2.campaign.id, { venue: 'AKAN' });
  line(`  resume (no retry_failed) → attempted=${p2.attempted} sent=${p2.sent} refused=${p2.refused}   ← already-sent guests untouched`);
  const p3 = await sendCampaign(db, camp2.campaign.id, { venue: 'AKAN', retryFailed: true });
  line(`  resume (retry_failed)    → attempted=${p3.attempted} sent=${p3.sent} failed=${p3.failed}`);
  line(`  final statuses: ${JSON.stringify(countByStatus(db, camp2.campaign.id))}`);

  // ── 7. Attribution ─────────────────────────────────────────────────────────
  h('7. ATTRIBUTION — a guest comes back after the send');
  const target = db.prepare(`SELECT * FROM ct_campaign_targets WHERE campaign_id = ? AND send_status = 'sent' ORDER BY name LIMIT 1`).get(cid) as any;
  line(`  walking: ${target.name} ${target.phone_e164} (sent_at ${target.sent_at})`);

  let a0 = attributeCampaign(db, cid);
  line(`  before any return  → newly_attributed=${a0.newly_attributed} total_returned=${a0.total_returned} value=₹${a0.total_return_value}`);

  // (a) booking proof — presence, no bill
  const bookingId = 'proof-booking-1';
  const todayIst = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  db.prepare(`INSERT INTO ct_bookings (id, guest_id, booking_date, status, party_size, created_by, channel)
              VALUES (?, ?, ?, 'completed', 2, 'proof', 'call')`).run(bookingId, target.guest_id, todayIst);
  let a1 = attributeCampaign(db, cid);
  let row = db.prepare(`SELECT * FROM ct_campaign_targets WHERE id = ?`).get(target.id) as any;
  line(`  after a seated booking on ${todayIst}:`);
  line(`    newly_attributed=${a1.newly_attributed}  returned_at=${row.returned_at}  return_value=${row.return_value}  (null = came back, no bill we can link)`);
  line(`    campaign: returned=${a1.total_returned} value=₹${a1.total_return_value} without_value=${a1.returned_without_value}`);

  // (b) money proof — a settled order carrying the guest's phone
  const target2 = db.prepare(`SELECT * FROM ct_campaign_targets WHERE campaign_id = ? AND send_status = 'sent' AND returned_at IS NULL ORDER BY name LIMIT 1`).get(cid) as any;
  if (target2) {
    const outlet = (db.prepare(`SELECT id FROM outlets WHERE is_default = 1 LIMIT 1`).get() as any)?.id || '';
    db.prepare(`INSERT INTO orders (id, outlet_id, order_number, status, total, guest_name, guest_mobile, created_at, settled_at)
                VALUES (?, ?, ?, 'settled', 4820, ?, ?, ?, ?)`)
      .run('proof-order-1', outlet, 'PROOF-1', target2.name, target2.phone_e164, new Date().toISOString(), new Date().toISOString());
    const a2 = attributeCampaign(db, cid);
    const row2 = db.prepare(`SELECT * FROM ct_campaign_targets WHERE id = ?`).get(target2.id) as any;
    line(`  after a ₹4,820 settled bill for ${target2.name}:`);
    line(`    returned_at=${row2.returned_at}  return_value=${row2.return_value}`);
    line(`    campaign: returned=${a2.total_returned} value=₹${a2.total_return_value} without_value=${a2.returned_without_value}`);
  }

  // (c) idempotence
  const a3 = attributeCampaign(db, cid);
  line(`  re-running attribution → newly_attributed=${a3.newly_attributed} (must be 0), returned still ${a3.total_returned}`);

  const rep = campaignReport(db, cid)!;
  line();
  line(`  REPORT "${rep.campaign.name}": status=${rep.campaign.status} sent=${rep.counts.sent}/${rep.counts.total} · came back ${rep.attribution.returned} (${rep.attribution.return_rate}%) · attributed ₹${rep.attribution.return_value} · ${rep.attribution.returned_without_value} unvalued`);

  // ── 8. No-phone guests are skipped, not stored with an empty number ────────
  h('8. UNREACHABLE GUESTS are dropped at build time');
  const bogus = createCampaign(db, {
    name: 'PROOF · unreachable',
    createdBy: 'proof-script',
    guests: [
      { guest_id: 'x1', phone_e164: '123', name: 'Too short' },
      { guest_id: 'x2', phone_e164: '', name: 'No number' },
      { guest_id: 'x3', phone_e164: '+919848010822', name: 'Fine' },
      { guest_id: 'x4', phone_e164: '9848010822', name: 'Same person, written differently' },
    ],
    meta: { ...meta },
  });
  line(`  4 guests in → targets=${bogus.targets} skipped_no_phone=${bogus.skipped_no_phone} deduped=${bogus.deduped}`);
  for (const t of db.prepare(`SELECT phone_e164, name FROM ct_campaign_targets WHERE campaign_id = ?`).all(bogus.campaign.id) as any[]) {
    line(`    kept: ${t.phone_e164} (${t.name})`);
  }

  globalThis.fetch = realFetch;
  h('DONE — real DB untouched; every provider call was stubbed');

}

main().catch(e => { console.error(e); process.exit(1); });
