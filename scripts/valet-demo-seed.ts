/**
 * VALET — fictional demo data for local testing and training.
 *
 *   npx tsx scripts/valet-demo-seed.ts <dir holding a COPY of fnb-controller.db>
 *
 * HARNESS COPY ONLY (same guard as the test suites): it creates demo ROLES and
 * USERS, which are production configuration — this must never run against the
 * live database. Every name, plate and phone number below is invented.
 *
 * Writes <dir>/demo-sessions.json (session tokens for the demo staff, so a local
 * browser can be signed in without any password). Keep that file local.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
export {};
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dir = path.resolve(String(process.argv[2] || ''));
const WT = path.resolve(__dirname, '..');
if (!dir || !fs.existsSync(path.join(dir, 'fnb-controller.db'))) {
  console.error('usage: npx tsx scripts/valet-demo-seed.ts <dir holding a COPY of fnb-controller.db>');
  process.exit(2);
}
if (!dir.split(path.sep).includes('harness') || dir === WT) {
  console.error(`refusing: ${dir} is not a harness copy.`);
  process.exit(2);
}
process.chdir(dir);

(async () => {
  const { getDb } = require(path.join(WT, 'src/lib/db.ts'));
  const core = require(path.join(WT, 'src/lib/valet/core.ts'));
  const adm = require(path.join(WT, 'src/lib/valet/ops-admin.ts'));
  const arr = require(path.join(WT, 'src/lib/valet/ops-arrival.ts'));
  const pk = require(path.join(WT, 'src/lib/valet/ops-pickup.ts'));
  const db = getDb();
  const id = () => crypto.randomUUID();
  const outlet = (db.prepare('SELECT id FROM outlets WHERE is_default = 1').get() as { id: string }).id;
  const ADMIN = { kind: 'staff', id: 'demo-admin', name: 'Owner (demo)', isAdmin: true, head: true, attendant: true, host: true };

  adm.setOutletEnabled(db, outlet, ADMIN, true);
  adm.saveConfig(db, outlet, ADMIN, { venue_name: '', pickup_gate_label: 'Main porch', help_phone: '+91 40 0000 0000', dwell_minutes: 3, default_retrieval_minutes: 7 });
  let ov = core.loadOutletValet(db, outlet);
  const existing = db.prepare('SELECT COUNT(*) AS n FROM valet_zones WHERE outlet_id = ?').get(outlet) as { n: number };
  const zone: Record<string, string> = {};
  if (!existing.n) {
    for (const [name, kind, cap, mins] of [['Basement P1', 'parking', 60, 8], ['Open lot', 'parking', 40, 5], ['Main porch', 'gate', 3, null], ['Holding bay', 'holding', 4, null]] as const) {
      zone[name] = adm.zoneSave(db, ov, ADMIN, { name, kind, capacity: cap, retrieval_minutes: mins }).zone_id;
    }
    adm.tagsAdd(db, ov, ADMIN, { from: 1, to: 60 });
  }
  const mkRole = (name: string, pages: string[], caps: [number, number, number]) => {
    const rid = id();
    db.prepare(`INSERT INTO roles (id, name, base_role, page_access, is_system, is_active, sort_order, description) VALUES (?,?, 'staff', ?, 0, 1, 90, 'Valet demo role — local harness only')`)
      .run(rid, `${name} ${rid.slice(0, 4)}`, JSON.stringify(pages));
    db.prepare('UPDATE roles SET valet_head = ?, valet_attendant = ?, valet_host = ? WHERE id = ?').run(caps[0], caps[1], caps[2], rid);
    return rid;
  };
  const rHead = mkRole('Valet Head (demo)', ['/valet', '/valet/attendant', '/valet/desk', '/valet/settings'], [1, 0, 0]);
  const rAtt = mkRole('Valet Attendant (demo)', ['/valet/attendant'], [0, 1, 0]);
  const rDesk = mkRole('Valet Desk (demo)', ['/valet/desk', '/cashier'], [0, 0, 1]);
  const sessions: Record<string, { user_id: string; token: string; name: string }> = {};
  const mkUser = (key: string, name: string, role: string) => {
    const uid = id();
    db.prepare(`INSERT INTO users (id, email, password_hash, name, role, role_id, is_active) VALUES (?,?, '!', ?, 'staff', ?, 1)`)
      .run(uid, `${key}.${uid.slice(0, 6)}@valet-demo.invalid`, name, role);
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)').run(token, uid, new Date(Date.now() + 3 * 86_400_000).toISOString());
    db.prepare('INSERT OR IGNORE INTO valet_staff_outlets (user_id, outlet_id, created_at, created_by) VALUES (?,?,?,?)').run(uid, outlet, new Date().toISOString(), 'demo-seed');
    sessions[key] = { user_id: uid, token, name };
  };
  mkUser('head', 'Meera Rao (demo head)', rHead);
  mkUser('ravi', 'Ravi Kumar (demo attendant)', rAtt);
  mkUser('imran', 'Imran Shaikh (demo attendant)', rAtt);
  mkUser('desk', 'Lata Menon (demo desk)', rDesk);
  const actor = (k: string, head = false) => ({ kind: 'staff', id: sessions[k].user_id, name: sessions[k].name, isAdmin: false, head, attendant: true, host: head });
  ov = core.loadOutletValet(db, outlet);
  for (const k of ['head', 'ravi', 'imran']) adm.shiftStart(db, ov, actor(k, k === 'head'));
  const zones = db.prepare(`SELECT id, name, kind FROM valet_zones WHERE outlet_id = ?`).all(outlet) as { id: string; name: string; kind: string }[];
  const lot = zones.filter(z => z.kind === 'parking');
  // Fictional guests and cars (invented plates).
  const cars = [
    ['TS 09 ZZ 1001', 'Maruti', 'Swift', 'Red', 'Anil (demo)'], ['TS 07 ZZ 2042', 'Hyundai', 'Creta', 'White', 'Priya (demo)'],
    ['AP 28 ZZ 3310', 'Toyota', 'Innova', 'Silver', 'Kiran (demo)'], ['TS 08 ZZ 4477', 'Kia', 'Seltos', 'Blue', ''],
    ['KA 01 ZZ 5150', 'Honda', 'City', 'Grey', 'Sana (demo)'], ['TS 10 ZZ 6262', 'Tata', 'Nexon', 'Green', ''],
  ];
  const ids: string[] = [];
  cars.forEach(([plate, make, model, colour, name], i) => {
    const tag = String(i + 1).padStart(2, '0');
    const who = i % 2 ? 'imran' : 'ravi';
    const sid = arr.checkinCreate(db, ov, actor(who), { plate, make, model, colour, guest_name: name, guest_mobile: name ? `+9190000000${i}${i}` : '', tag_code: tag, is_test: true }).session_id;
    if (i < 5) {
      const s = db.prepare('SELECT version FROM valet_vehicle_sessions WHERE id = ?').get(sid) as { version: number };
      arr.parkConfirm(db, ov, actor(who), sid, s.version, { zone_id: lot[i % lot.length].id, spot: `Bay ${10 + i}`, key_location: 'rack', key_rack: 'R1', key_hook: String(i + 1) });
    }
    ids.push(sid);
  });
  // One guest has asked for their car; one has booked a time later tonight.
  pk.requestPickup(db, ov, core.SYSTEM, { session_id: ids[1], when: 'now' }, 'guest');
  pk.requestPickup(db, ov, core.SYSTEM, { session_id: ids[2], when: 'in10' }, 'guest');
  fs.writeFileSync(path.join(dir, 'demo-sessions.json'), JSON.stringify({ outlet_id: outlet, entry_token: core.loadOutletValet(db, outlet).entry_token, sessions }, null, 2));
  console.log(`seeded demo valet data at outlet ${outlet}: ${cars.length} fictional cars, 4 demo staff (tokens in demo-sessions.json)`);
  process.exit(0);
})().catch(e => { console.error('CRASHED:', e); process.exit(3); });
