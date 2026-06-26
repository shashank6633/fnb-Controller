#!/usr/bin/env node
/**
 * Headless realtime test for the KDS SSE layer. Proves that firing an order
 * pushes a `kot.new` event to the matching station's stream within ~500ms, and
 * does NOT leak to a different station's stream.
 *
 * Run (dev server must be up):
 *   node scripts/kds-sse-test.mjs [base-url]   # default http://localhost:3000
 *
 * Requires a priced menu item on the 'tandoor' station (the script picks one).
 */
const BASE = process.argv[2] || 'http://localhost:3000';
const FIRE_STATION = 'tandoor';
const OTHER_STATION = 'bar';

let cookie = '';
function setCookieFrom(res) {
  const sc = res.headers.getSetCookie?.() || [];
  for (const c of sc) cookie += (cookie ? '; ' : '') + c.split(';')[0];
}
function csrf() { return (cookie.match(/fnb_csrf=([^;]+)/) || [])[1] || ''; }
const H = () => ({ Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf()) });

// Open an SSE stream and collect parsed `data:` events into `out`.
async function openStream(station, out) {
  const res = await fetch(`${BASE}/api/dine-in/kds/stream?station=${station}`, { headers: { Cookie: cookie } });
  if (!res.ok) throw new Error(`stream ${station} HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = frame.split('\n').find((l) => l.startsWith('data:'));
        if (data) out.push(JSON.parse(data.slice(5).trim()));
      }
    }
  })().catch(() => {});
  return reader;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 1) Login
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@local', password: 'admin123' }),
  });
  setCookieFrom(login);
  if (!login.ok) throw new Error('login failed');

  // 2) Find a priced item on the fire station
  const menu = await (await fetch(`${BASE}/api/menu-items`, { headers: { Cookie: cookie } })).json();
  const item = (menu.items || []).find((m) => m.station === FIRE_STATION && m.selling_price > 0 && m.is_active);
  if (!item) throw new Error(`no priced ${FIRE_STATION} item — price one first`);

  // 3) Open both streams
  const tandoorEvents = [], barEvents = [];
  const r1 = await openStream(FIRE_STATION, tandoorEvents);
  const r2 = await openStream(OTHER_STATION, barEvents);
  await sleep(300); // let connections establish

  // 4) Open an order, add the item, fire it
  const tbl = await (await fetch(`${BASE}/api/dine-in/tables`, { method: 'POST', headers: H(), body: JSON.stringify({ table_number: 'SSE-' + Date.now() % 1000, zone: 'Test' }) })).json();
  const ord = await (await fetch(`${BASE}/api/dine-in/orders`, { method: 'POST', headers: H(), body: JSON.stringify({ table_id: tbl.id }) })).json();
  await fetch(`${BASE}/api/dine-in/orders/${ord.id}`, { method: 'PATCH', headers: H(), body: JSON.stringify({ action: 'add_item', menu_item_id: item.id }) });
  const t0 = Date.now();
  await fetch(`${BASE}/api/dine-in/orders/${ord.id}`, { method: 'PATCH', headers: H(), body: JSON.stringify({ action: 'fire' }) });

  // 5) Wait for the event
  for (let i = 0; i < 20 && tandoorEvents.length === 0; i++) await sleep(50);
  const latency = Date.now() - t0;
  await sleep(200); // give the (wrong) bar stream a chance to (not) receive it

  const gotTandoor = tandoorEvents.find((e) => e.type === 'kot.new' && e.station === FIRE_STATION);
  const leaked = barEvents.find((e) => e.type === 'kot.new');

  console.log(`tandoor stream events: ${tandoorEvents.length} | bar stream events: ${barEvents.length}`);
  console.log(`latency: ~${latency}ms`);
  console.log(gotTandoor ? `PASS: tandoor received kot.new (#${gotTandoor.kot?.kot_number}, ${gotTandoor.kot?.items?.length} item)` : 'FAIL: tandoor stream got no kot.new');
  console.log(!leaked ? 'PASS: bar stream correctly received nothing' : 'FAIL: event leaked to bar stream');

  r1.cancel(); r2.cancel();
  process.exit(gotTandoor && !leaked ? 0 : 1);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(2); });
