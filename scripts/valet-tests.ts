/**
 * VALET PARKING — increment 1 proof (docs/valet/DESIGN.md, spec §13).
 *
 *   npx tsx scripts/valet-tests.ts <dir holding a COPY of fnb-controller.db>
 *
 * HARNESS COPY ONLY (same guard as brewery-dept-tests.ts): the directory must
 * sit under a `harness/` directory and must not be this worktree; the script
 * chdirs there before db.ts loads, so every handler opens the copy.
 *
 * Time is INJECTED (every engine call takes `now`), so dwell timers, scheduled
 * releases, expiry and business dates across midnight are tested exactly.
 *
 *   A schema + constraints     B access (catalog, auth, proxy, command table, outlets)
 *   C check-in + tags + plates D parking + photo policy + custody
 *   E pickups: idempotency, scheduling, release      F queue fairness + priority
 *   G Take next car + limits   H SIMULTANEOUS claims in separate processes
 *   I gate: ready, dwell, capacity, holding, no-show, guest returned
 *   J cancel/reschedule after claim → staff acknowledgement, car never released
 *   K reassignment + handoff acknowledgement          L verified handover + replay + lockout + recovery
 *   M guest layer: pairing, activation, grants, CSRF, enumeration, tag reuse
 *   N business date + service hours across midnight   O shifts + custody on shift end
 *   P void + desk lookup masking + ETA honesty
 */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
export {};   // a module, not a global script: its top-level names must not collide with sibling test scripts
const Module = require('module');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const dir = path.resolve(String(process.argv[2] || ''));
const WT = path.resolve(__dirname, '..');
if (!dir || !fs.existsSync(path.join(dir, 'fnb-controller.db'))) {
  console.error('usage: npx tsx scripts/valet-tests.ts <dir holding a COPY of fnb-controller.db>');
  process.exit(2);
}
if (!dir.split(path.sep).includes('harness') || path.resolve(dir) === WT) {
  console.error(`refusing: ${dir} is not a harness copy (it must sit under a harness/ directory, never the worktree).`);
  process.exit(2);
}
const STUB = path.join(dir, 'next-headers-stub.cjs');
fs.writeFileSync(STUB, `
function jar() { const t = globalThis.__TOKEN, v = globalThis.__VP; const all = [];
  if (t) all.push({ name: 'fnb_session', value: t }); if (v) all.push({ name: 'fnb_vp', value: v });
  return { get: (n) => all.find(c => c.name === n), getAll: () => all, has: (n) => all.some(c => c.name === n), set() {}, delete() {} }; }
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

let pass = 0;
const fails: string[] = [];
let section = '';
const ok = (cond: unknown, label: string) => { if (cond) pass++; else { fails.push(`${section} ${label}`); console.log(`  FAIL [${section}] ${label}`); } };
const eq = (a: unknown, b: unknown, label: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${label} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const S = (name: string) => { section = name; console.log(`== ${name}`); };

(async () => {
  const { getDb } = require(path.join(WT, 'src/lib/db.ts'));
  const auth = require(path.join(WT, 'src/lib/auth.ts'));
  const catalog = require(path.join(WT, 'src/lib/page-catalog.ts'));
  const core = require(path.join(WT, 'src/lib/valet/core.ts'));
  const cfgm = require(path.join(WT, 'src/lib/valet/config.ts'));
  const queue = require(path.join(WT, 'src/lib/valet/queue.ts'));
  const arr = require(path.join(WT, 'src/lib/valet/ops-arrival.ts'));
  const pk = require(path.join(WT, 'src/lib/valet/ops-pickup.ts'));
  const adm = require(path.join(WT, 'src/lib/valet/ops-admin.ts'));
  const cmds = require(path.join(WT, 'src/lib/valet/commands.ts'));
  const board = require(path.join(WT, 'src/lib/valet/board.ts'));
  const guest = require(path.join(WT, 'src/lib/valet/guest.ts'));
  const creds = require(path.join(WT, 'src/lib/valet/credentials.ts'));
  const { ValetError } = core;
  const db = getDb();

  // NO NETWORK in this suite. The database is a copy of PRODUCTION and carries
  // live WhatsApp credentials; any accidental real send must fail loudly here,
  // and the credentials are replaced with fake ones on this copy as well.
  (globalThis as any).fetch = async () => { throw new Error('network disabled in valet tests'); };
  for (const [k, v] of [['wa_api_provider', 'meta_cloud'], ['wa_phone_number_id', 'TEST-ONLY'], ['wa_access_token', 'TEST-ONLY'], ['wa_interakt_api_key', '']]) {
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(k, v);
  }
  delete process.env.VALET_ALLOW_DEV_SEND;

  const uid = (p = 'zzvt') => `${p}-${Math.random().toString(36).slice(2, 10)}`;
  // 20:00 IST on 9 Nov 2026 — inside the default 11:00–01:00 service hours.
  const T0 = new Date('2026-11-09T14:30:00.000Z');
  const at = (min: number) => new Date(T0.getTime() + min * 60_000);
  const caught = (fn: () => unknown): { status: number; code: string; message: string; extra?: any } | null => {
    try { fn(); return null; } catch (e: any) {
      if (e instanceof ValetError) return { status: e.status, code: e.code, message: e.message, extra: e.extra };
      throw e;
    }
  };

  // ── fixtures (copy only) ────────────────────────────────────────────────
  const OA = (db.prepare(`SELECT id FROM outlets WHERE is_default = 1`).get() as any).id;
  let OB = (db.prepare(`SELECT id FROM outlets WHERE id <> ? AND is_active = 1 LIMIT 1`).get(OA) as any)?.id;
  if (!OB) { OB = uid('zzout'); db.prepare(`INSERT INTO outlets (id, name, is_default) VALUES (?, ?, 0)`).run(OB, 'ZZ Branch'); }
  const mkRole = (name: string, base: string, pages: string[] | null, caps: Record<string, number>, active = 1) => {
    const id = uid('zzrole');
    db.prepare(`INSERT INTO roles (id, name, base_role, page_access, is_system, is_active, sort_order, description) VALUES (?,?,?,?,0,?,99,'valet test')`)
      .run(id, `${name} ${id.slice(-4)}`, base, pages ? JSON.stringify(pages) : null, active);
    db.prepare(`UPDATE roles SET valet_head = ?, valet_attendant = ?, valet_host = ? WHERE id = ?`).run(caps.head || 0, caps.att || 0, caps.host || 0, id);
    return id;
  };
  const R_HEAD = mkRole('ZZ Valet Head', 'staff', ['/valet', '/valet/attendant', '/valet/desk', '/valet/settings'], { head: 1 });
  const R_ATT = mkRole('ZZ Valet Attendant', 'staff', ['/valet/attendant'], { att: 1 });
  const R_HOST = mkRole('ZZ Valet Host', 'staff', ['/valet/desk', '/cashier'], { host: 1 });
  const R_DEAD = mkRole('ZZ Old Valet Head', 'staff', ['/valet'], { head: 1 }, 0);
  const users: Record<string, { id: string; token: string; name: string }> = {};
  const mkUser = (key: string, roleId: string | null, role = 'staff') => {
    const id = uid('zzusr');
    db.prepare(`INSERT INTO users (id, email, password_hash, name, role, role_id, is_active) VALUES (?,?,?,?,?,?,1)`)
      .run(id, `${id}@valet.test`, 'x', `ZZ ${key}`, role, roleId);
    const token = uid('zztok') + uid('x') + uid('y');
    db.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)`).run(token, id, new Date(Date.now() + 86_400_000).toISOString());
    users[key] = { id, token, name: `ZZ ${key}` };
  };
  mkUser('admin', null, 'admin'); mkUser('head', R_HEAD); mkUser('head2', R_HEAD);
  for (const k of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']) mkUser(k, R_ATT);
  mkUser('host', R_HOST); mkUser('plain', null); mkUser('dead', R_DEAD);
  const me = async (key: string) => { (globalThis as any).__TOKEN = users[key].token; return auth.getCurrentUser(); };
  const U: Record<string, any> = {};
  for (const k of Object.keys(users)) U[k] = await me(k);
  const A = (k: string) => core.staffActor(U[k]);
  const run = (k: string, body: Record<string, unknown>, now: Date) => {
    try { return { ok: true, ...cmds.runCommand(db, U[k], body, now) }; }
    catch (e: any) { if (e instanceof ValetError) return { ok: false, status: e.status, code: e.code, message: e.message, extra: e.extra }; throw e; }
  };

  // Enable outlet A with zones; B stays OFF.
  run('admin', { cmd: 'settings.enable', outlet_id: OA, enabled: true }, T0);
  run('admin', { cmd: 'settings.config', outlet_id: OA, config: { dwell_minutes: 3, default_retrieval_minutes: 8 } }, T0);
  const zone = (name: string, kind: string, capacity: number | null) => (run('head', { cmd: 'zone.save', outlet_id: OA, name, kind, capacity }, T0) as any).zone_id;
  for (const k of ['head', 'head2', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'host']) run('admin', { cmd: 'staff.assign', outlet_id: OA, user_id: users[k].id, assigned: true }, T0);
  const ZP = zone('ZZ Basement', 'parking', 80);
  const ZG = zone('ZZ Front gate', 'gate', 2);
  const ZH = zone('ZZ Holding bay', 'holding', 1);
  const ov = () => core.loadOutletValet(db, OA);
  const onShift = (k: string, now = T0) => adm.shiftStart(db, ov(), A(k), now);
  let plateN = 100;
  const checkin = (k: string, tag: string, now: Date, extra: Record<string, unknown> = {}) =>
    arr.checkinCreate(db, ov(), A(k), { plate: `TS09ZZ${plateN++}`, make: 'Hondai', colour: 'Grey', tag_code: tag, guest_mobile: '+91 98765 43210', guest_name: 'Asha Test', ...extra }, now).session_id;
  const sess = (id: string) => db.prepare('SELECT * FROM valet_vehicle_sessions WHERE id = ?').get(id);
  const pick = (id: string) => db.prepare('SELECT * FROM valet_pickups WHERE id = ?').get(id);
  const park = (k: string, id: string, now: Date, extra: Record<string, unknown> = {}) =>
    arr.parkConfirm(db, ov(), A(k), id, sess(id).version, { zone_id: ZP, spot: 'B2-14', key_location: 'rack', key_rack: 'R1', key_hook: '7', ...extra }, now);

  // ═══════════════════════════════════════════════════════════════════════
  S('A schema');
  {
    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'valet_%'`).all() as any[]).map(r => r.name);
    for (const t of ['valet_outlet_config', 'valet_zones', 'valet_staff_outlets', 'valet_shifts', 'valet_tags', 'valet_checkin_requests',
      'valet_vehicle_sessions', 'valet_pickups', 'valet_events', 'valet_custody', 'valet_guest_devices', 'valet_pass_grants',
      'valet_activation_links', 'valet_handover_codes', 'valet_claim_codes', 'valet_rate_limits', 'valet_incidents', 'valet_alerts', 'valet_handover_notes']) {
      ok(names.includes(t), `table ${t}`);
    }
    const cols = (db.prepare('PRAGMA table_info(roles)').all() as any[]);
    for (const c of ['valet_head', 'valet_attendant', 'valet_host']) {
      const col = cols.find(x => x.name === c);
      ok(col && String(col.dflt_value) === '0', `roles.${c} DEFAULT 0`);
    }
    // No production role was granted anything by the migration.
    const granted = (db.prepare(`SELECT COUNT(*) AS n FROM roles WHERE description <> 'valet test' AND (valet_head + valet_attendant + valet_host) > 0`).get() as any).n;
    eq(granted, 0, 'no existing role gained a valet capability');
    // Storage-level guarantee: two active sessions on one tag cannot exist.
    const t = uid('zztag');
    db.prepare(`INSERT INTO valet_tags (id, outlet_id, code, code_norm, status) VALUES (?,?,?,?, 'in_use')`).run(t, OA, 'ZZX1', 'ZZX1');
    const ins = () => db.prepare(`INSERT INTO valet_vehicle_sessions (id, outlet_id, business_date, state, tag_id, checked_in_at, updated_at)
                                  VALUES (?,?,?, 'PARKED', ?, ?, ?)`).run(uid('zzs'), OA, '2026-11-09', t, T0.toISOString(), T0.toISOString());
    ins();
    let threw = false; try { ins(); } catch { threw = true; }
    ok(threw, 'uq_valet_active_tag blocks a second active session on a tag');
  }

  // ═══════════════════════════════════════════════════════════════════════
  S('B access');
  {
    eq([U.head.valet_head, U.head.valet_attendant, U.head.valet_host], [true, false, false], 'head caps resolved from role');
    eq([U.a1.valet_attendant, U.host.valet_host], [true, true], 'attendant + host caps');
    eq([U.plain.valet_head, U.plain.valet_attendant, U.plain.valet_host], [false, false, false], 'role-less user: none');
    eq(U.dead.valet_head, false, 'deactivated role: capability revoked');
    // Catalog gates.
    ok(catalog.canAccessPage('/valet', U.admin), 'admin opens /valet');
    ok(!catalog.canAccessPage('/valet', U.plain), 'null-map legacy staff does NOT open /valet (tier gate before null-map grant)');
    ok(!catalog.canAccessPage('/valet/attendant', U.plain), '…nor /valet/attendant');
    ok(catalog.canAccessPage('/valet', U.head) && catalog.canAccessPage('/valet/attendant', U.head) && catalog.canAccessPage('/valet/desk', U.head), 'head opens all three');
    ok(!catalog.canAccessPage('/valet', U.a1) && catalog.canAccessPage('/valet/attendant', U.a1), 'attendant: attendant page only');
    ok(!catalog.canAccessPage('/valet/settings', U.a1), 'attendant cannot open settings');
    ok(catalog.canAccessPage('/valet/desk', U.host) && !catalog.canAccessPage('/valet/attendant', U.host), 'host: desk only');
    eq(catalog.firstAllowedPath(U.a1), '/valet/attendant', 'firstAllowedPath lands an attendant on their page (no loop)');
    ok(!catalog.canAccessPage('/valet', { ...U.head, valet_head: 1 }), 'truthy non-boolean never grants');
    // requireStaff.
    eq(caught(() => core.requireStaff(db, U.plain, OA, 'attendant'))?.code, 'no_capability', 'no capability → 403');
    eq(caught(() => core.requireStaff(db, U.a1, OB, 'attendant'))?.code, 'not_assigned', 'other outlet → 403 not_assigned');
    eq(caught(() => core.requireStaff(db, U.admin, OB, 'attendant'))?.code, 'valet_off', 'admin on a switched-off outlet → 409');
    eq(caught(() => core.requireStaff(db, null, OA, 'attendant'))?.code, 'sign_in', 'no user → 401');
    eq(caught(() => core.requireStaff(db, U.head, OA, 'admin'))?.code, 'admin_only', 'head cannot do admin settings');
    // Command table.
    eq((run('host', { cmd: 'take_next', outlet_id: OA }, T0) as any).code, 'no_capability', 'host cannot Take next car');
    eq((run('a1', { cmd: 'session.void', outlet_id: OA, session_id: 'x' }, T0) as any).code, 'no_capability', 'attendant cannot void');
    eq((run('a1', { cmd: 'nope', outlet_id: OA }, T0) as any).code, 'unknown_command', 'unknown command refused');
    eq((run('a1', { cmd: 'shift.start', outlet_id: OB }, T0) as any).code, 'not_assigned', 'attendant cannot start a shift at an unassigned outlet');
    // Proxy: public exact paths, staff pages gated, staff API CSRF-protected.
    const { proxy } = require(path.join(WT, 'src/proxy.ts'));
    const { NextRequest } = require('next/server');
    const req = (p: string, init: any = {}) => new NextRequest(new URL(p, 'http://localhost:3900'), init);
    const r1 = proxy(req('/valet-pass'));
    ok(!r1.headers.get('location'), '/valet-pass is public (no login redirect)');
    const r2 = proxy(req('/valet'));
    ok(String(r2.headers.get('location') || '').includes('/login'), '/valet without a session → login');
    const r3 = proxy(req('/api/valet-guest/act', { method: 'POST' }));
    ok(r3.status !== 401 && r3.status !== 403, 'guest act passes the proxy (self-authenticates)');
    const r4 = proxy(req('/api/valet-guest/../valet/board'));
    ok(r4.status === 401 || String(r4.headers.get('location') || '').includes('login'), 'dot-segment spelling is not public');
    const r5 = proxy(req('/api/valet-guest%2F..%2Fvalet%2Fcommand', { method: 'POST' }));
    eq(r5.status, 401, 'encoded-slash spelling of a staff route is not public');
    const r6 = proxy(req('/api/valet/command', { method: 'POST', headers: { cookie: `fnb_session=${users.head.token}; fnb_csrf=abc` } }));
    eq(r6.status, 403, 'staff command without the CSRF header → 403');
    const r7 = proxy(req('/api/valet/command', { method: 'POST', headers: { cookie: `fnb_session=${users.head.token}; fnb_csrf=abc`, 'x-csrf-token': 'abc' } }));
    ok(r7.status !== 403 && r7.status !== 401, 'staff command with CSRF passes the proxy');
    const r8 = proxy(req('/valet/attendant', { headers: { cookie: `fnb_session=${users.a1.token}` } }));
    ok(!r8.headers.get('location'), 'attendant session opens /valet/attendant at the proxy');
    const r9 = proxy(req('/valet', { headers: { cookie: `fnb_session=${users.a1.token}` } }));
    ok(String(r9.headers.get('location') || '').includes('/valet/attendant'), 'attendant bounced from /valet to their own page');
    const r10 = proxy(req('/valet', { headers: { cookie: `fnb_session=${users.plain.token}` } }));
    ok(String(r10.headers.get('location') || '').includes('forbidden'), 'legacy staff bounced from /valet');
  }

  // ═══════════════════════════════════════════════════════════════════════
  S('C check-in');
  let S1 = '', S2 = '', S3 = '';
  {
    eq(caught(() => checkin('a1', '001', T0))?.code, 'not_on_shift', 'check-in refused off shift');
    for (const k of ['a1', 'a2', 'a3', 'head']) onShift(k);
    eq(caught(() => arr.checkinCreate(db, ov(), A('a1'), { tag_code: '001' }, T0))?.code, 'missing_fields', 'plate required by default');
    S1 = checkin('a1', '001', T0);
    eq(sess(S1).state, 'CHECKED_IN', 'session CHECKED_IN');
    eq((db.prepare(`SELECT status FROM valet_tags WHERE outlet_id = ? AND code_norm = ?`).get(OA, cfgm.normTagCode('001')) as any).status, 'in_use', 'tag auto-registered and in use');
    eq(caught(() => checkin('a2', '001', at(1)))?.code, 'tag_in_use', 'second car on the same tag refused');
    const dup = caught(() => arr.checkinCreate(db, ov(), A('a2'), { plate: sess(S1).plate, tag_code: '002' }, at(1)));
    eq(dup?.code, 'duplicate_plate', 'duplicate active plate needs staff resolution');
    ok(dup?.extra?.duplicates?.length === 1, 'the other car is named');
    S2 = arr.checkinCreate(db, ov(), A('a2'), { plate: sess(S1).plate, tag_code: '002', duplicate_plate_note: 'Two cars same plate, checked papers' }, at(1)).session_id;
    ok(sess(S2).duplicate_plate_note.length > 5, 'resolution note stored');
    db.prepare(`INSERT INTO valet_tags (id, outlet_id, code, code_norm, status) VALUES (?,?,?,?, 'lost')`).run(uid('zzt'), OA, '099', cfgm.normTagCode('099'));
    eq(caught(() => checkin('a1', '099', at(1)))?.code, 'tag_unavailable', 'lost tag refused');
    eq(caught(() => checkin('a1', '99', at(1)))?.code, 'tag_unavailable', 'lost tag refused when typed without the leading zero');
    eq(caught(() => checkin('a2', '1', at(1)))?.code, 'tag_in_use', 'tag "001" in use is the same tag as "1"');
    eq([cfgm.normTagCode('02'), cfgm.normTagCode('2'), cfgm.normTagCode('A-02'), cfgm.normTagCode('000')], ['2', '2', 'A02', '0'], 'numeric tags ignore leading zeros; lettered tags do not');
    eq((db.prepare(`SELECT COUNT(*) AS n FROM valet_custody WHERE session_id = ? AND kind = 'key'`).get(S1) as any).n, 1, 'key custody logged at check-in');
    S3 = checkin('a3', '003', at(2));
  }

  // ═══════════════════════════════════════════════════════════════════════
  S('D parking');
  {
    eq(caught(() => park('a1', S1, at(3), { zone_id: ZG }))?.code, 'zone_kind', 'gate is not a parking zone');
    eq(caught(() => park('a1', S1, at(3), { key_location: '' }))?.code, 'key_location_required', 'key location required');
    eq(caught(() => park('a1', S1, at(3), { key_rack: '', key_hook: '' }))?.code, 'key_rack_required', 'rack needs rack/hook');
    park('a1', S1, at(3));
    const s1 = sess(S1);
    eq([s1.state, s1.key_location, s1.key_rack, s1.key_custodian_id], ['PARKED', 'rack', 'R1', null], 'parked; keys on the rack, nobody holds them');
    eq((db.prepare(`SELECT COUNT(*) AS n FROM valet_custody WHERE session_id = ?`).get(S1) as any).n, 3, 'vehicle move + key move logged separately');
    // Photo policy.
    run('admin', { cmd: 'settings.config', outlet_id: OA, config: { dwell_minutes: 3, default_retrieval_minutes: 8, photos: { min: 2, allow_exception: true } } }, at(3));
    eq(caught(() => park('a2', S2, at(3)))?.code, 'photo_exception_required', 'min photos without an exception refused');
    park('a2', S2, at(3), { photo_exception: 'Rush at the curb, guest in a hurry' });
    ok(sess(S2).photo_exception.length > 5 && sess(S2).photo_exception_by === users.a2.id, 'exception recorded with who');
    run('admin', { cmd: 'settings.config', outlet_id: OA, config: { dwell_minutes: 3, default_retrieval_minutes: 8 } }, at(3));
    arr.parkStart(db, ov(), A('a3'), S3, sess(S3).version, at(3));
    eq(sess(S3).state, 'PARKING', 'PARKING state while driving');
    eq(caught(() => park('a1', S3, at(4)))?.code, 'not_yours', 'another attendant cannot confirm someone else\'s parking');
    park('a3', S3, at(4), { key_location: 'attendant' });
    eq(sess(S3).key_custodian_id, users.a3.id, 'keys kept by the attendant are in their custody');
    eq(caught(() => arr.parkConfirm(db, ov(), A('a1'), S1, 1, { zone_id: ZP, key_location: 'rack', key_rack: 'R1' }, at(4)))?.code, 'stale', 'stale version → 409');
  }

  // ═══════════════════════════════════════════════════════════════════════
  S('E pickups');
  let P1: any, P2: any;
  {
    const r = pk.requestPickup(db, ov(), core.SYSTEM, { session_id: S1, when: 'now', idempotency_key: 'k1' }, 'guest', at(5));
    P1 = r.pickup;
    eq(P1.state, 'QUEUED', 'request now → QUEUED');
    eq(P1.queued_at, at(5).toISOString(), 'queued_at = requested_at');
    const again = pk.requestPickup(db, ov(), core.SYSTEM, { session_id: S1, when: 'now', idempotency_key: 'k1' }, 'guest', at(5.1));
    eq([again.pickup.id, again.existing], [P1.id, true], 'same idempotency key → same request');
    const tap2 = pk.requestPickup(db, ov(), core.SYSTEM, { session_id: S1, when: 'in10', idempotency_key: 'k2' }, 'guest', at(5.2));
    eq([tap2.pickup.id, tap2.existing], [P1.id, true], 'second request while one is active → the active one');
    // Scheduled: in 10 min with an 8-min lead → released 2 min from now.
    P2 = pk.requestPickup(db, ov(), core.SYSTEM, { session_id: S2, when: 'in10' }, 'guest', at(5)).pickup;
    eq(P2.state, 'SCHEDULED', 'in 10 → SCHEDULED');
    eq(P2.release_at, at(7).toISOString(), 'release_at = target − lead (8 min)');
    eq(queue.promoteDue(db, OA, at(6.9)), 0, 'not released early');
    eq(queue.promoteDue(db, OA, at(7)), 1, 'released at release time');
    eq([pick(P2.id).state, pick(P2.id).queued_at], ['QUEUED', at(7).toISOString()], 'queued_at = its due time, not booking time');
    eq(queue.promoteDue(db, OA, at(8)), 0, 'release is idempotent');
    // Bad choices.
    eq(caught(() => pk.resolveTarget(ov(), 'at', at(12).toISOString(), at(5)))?.code, 'too_soon', 'later < 10 min refused');
    eq(caught(() => pk.resolveTarget(ov(), 'at', at(60 * 7).toISOString(), at(5)))?.code, 'too_late', 'beyond later window refused');
    eq(caught(() => pk.resolveTarget(ov(), 'sometime', null, at(5)))?.code, 'bad_option', 'unknown option refused');
  }

  // ═══════════════════════════════════════════════════════════════════════
  S('F queue fairness');
  {
    // Fresh outlet-scoped scenario with its own cars so order is unambiguous.
    const ids: string[] = [];
    for (const [i, k] of ['a1', 'a2', 'a3', 'a1'].entries()) { const id = checkin(k, `F${i}`, at(10)); park(k, id, at(10)); ids.push(id); }
    // P2/P1 above are older; cancel them to isolate this scenario.
    pk.cancelPickup(db, ov(), core.SYSTEM, P1.id, 'test isolation', at(10));
    pk.cancelPickup(db, ov(), core.SYSTEM, P2.id, 'test isolation', at(10));
    const fA = pk.requestPickup(db, ov(), core.SYSTEM, { session_id: ids[0], when: 'now' }, 'guest', at(20)).pickup;            // due 20
    const fB = pk.requestPickup(db, ov(), core.SYSTEM, { session_id: ids[1], when: 'at', at: at(50).toISOString() }, 'guest', at(20)).pickup; // due 42
    const fC = pk.requestPickup(db, ov(), core.SYSTEM, { session_id: ids[2], when: 'now' }, 'guest', at(25)).pickup;            // due 25
    const fD = pk.requestPickup(db, ov(), core.SYSTEM, { session_id: ids[3], when: 'at', at: at(220).toISOString() }, 'guest', at(21)).pickup; // far future
    queue.promoteDue(db, OA, at(45));
    const order = queue.eligibleQueue(db, OA).map((p: any) => p.id);
    eq(order.slice(0, 3), [fA.id, fC.id, fB.id], 'FIFO by due time: A(20) C(25) B(42)');
    ok(!order.includes(fD.id), 'far-future booking is not in the queue and blocks nobody');
    eq(caught(() => pk.setPriority(db, ov(), A('head'), fB.id, pick(fB.id).version, 2, '', at(45)))?.code, 'reason_required', 'priority without reason refused');
    eq(caught(() => pk.setPriority(db, ov(), A('a1'), fB.id, pick(fB.id).version, 2, 'VIP guest', at(45)))?.code, 'head_only', 'attendant cannot change priority');
    pk.setPriority(db, ov(), A('head'), fB.id, pick(fB.id).version, 2, 'Elderly guest waiting outside', at(45));
    eq(queue.eligibleQueue(db, OA)[0].id, fB.id, 'head-approved priority moves B first');
    eq((db.prepare(`SELECT reason FROM valet_events WHERE pickup_id = ? AND event_type = 'pickup.priority'`).get(fB.id) as any).reason, 'Elderly guest waiting outside', 'priority reason audited');
    // Clean up this scenario so later sections start from an empty queue.
    for (const p of [fA, fB, fC, fD]) pk.cancelPickup(db, ov(), core.SYSTEM, p.id, 'cleanup', at(46));
  }

  // ═══════════════════════════════════════════════════════════════════════
  S('G take next');
  let G1 = '', G2 = '';
  {
    G1 = checkin('a1', 'G1', at(60)); park('a1', G1, at(61));
    G2 = checkin('a2', 'G2', at(60)); park('a2', G2, at(61));
    const unparked = checkin('a3', 'G3', at(60));       // still CHECKED_IN
    const pU = pk.requestPickup(db, ov(), core.SYSTEM, { session_id: unparked, when: 'now' }, 'guest', at(61.5)).pickup;
    const p1 = pk.requestPickup(db, ov(), core.SYSTEM, { session_id: G1, when: 'now' }, 'guest', at(62)).pickup;
    const p2 = pk.requestPickup(db, ov(), core.SYSTEM, { session_id: G2, when: 'now' }, 'guest', at(63)).pickup;
    eq(caught(() => pk.takeNext(db, ov(), A('a4'), at(64)))?.code, 'not_on_shift', 'not on shift → refused');
    onShift('a4', at(64));
    adm.shiftBreak(db, ov(), A('a4'), true, at(64));
    eq(caught(() => pk.takeNext(db, ov(), A('a4'), at(64)))?.code, 'on_break', 'on break → refused');
    adm.shiftBreak(db, ov(), A('a4'), false, at(65));
    const t1 = pk.takeNext(db, ov(), A('a4'), at(65));
    eq(t1.pickup_id, p1.id, 'skips the car still being parked; takes the first parked car');
    eq(pick(pU.id).state, 'QUEUED', 'unparked car keeps its place');
    eq(caught(() => pk.takeNext(db, ov(), A('a4'), at(65)))?.code, 'busy', 'one active task per attendant (default)');
    const t2 = pk.takeNext(db, ov(), A('a1'), at(65));
    eq(t2.pickup_id, p2.id, 'next attendant gets the next car');
    eq(pk.takeNext(db, ov(), A('a2'), at(65)).pickup_id, null, 'nothing claimable left → none');
    // Release own claim keeps FIFO place.
    pk.unassignPickup(db, ov(), A('a1'), p2.id, pick(p2.id).version, '', at(66));
    eq([pick(p2.id).state, pick(p2.id).queued_at], ['QUEUED', p2.queued_at], 'released to queue with its original place');
    eq(caught(() => pk.unassignPickup(db, ov(), A('a2'), p1.id, pick(p1.id).version, 'x', at(66)))?.code, 'not_yours', 'cannot release someone else\'s car');
    pk.cancelPickup(db, ov(), core.SYSTEM, pU.id, 'cleanup', at(66));
    pk.cancelPickup(db, ov(), core.SYSTEM, p2.id, 'cleanup', at(66));   // a4 keeps p1 for section I
  }

  // ═══════════════════════════════════════════════════════════════════════
  S('H simultaneous claims (separate processes)');
  {
    const cars: string[] = [];
    for (let i = 0; i < 2; i++) { const id = checkin('head', `H${i}`, at(70)); park('head', id, at(70)); cars.push(id); }
    const now = new Date();
    for (const id of cars) pk.requestPickup(db, ov(), core.SYSTEM, { session_id: id, when: 'now' }, 'guest', now);
    for (const k of ['a5', 'a6', 'head2']) onShift(k, now);
    const racers = ['a2', 'a3', 'a5', 'a6', 'head2'].filter(k => core.activeTaskCount(db, users[k].id) === 0);
    const child = path.join(dir, 'valet-claim-child.cjs');
    fs.writeFileSync(child, `
const Database = require(${JSON.stringify(path.join(WT, 'node_modules/better-sqlite3'))});
const db = new Database(${JSON.stringify(path.join(dir, 'fnb-controller.db'))});
db.pragma('journal_mode = WAL'); db.pragma('busy_timeout = 5000');
const core = require(${JSON.stringify(path.join(WT, 'src/lib/valet/core.ts'))});
const pk = require(${JSON.stringify(path.join(WT, 'src/lib/valet/ops-pickup.ts'))});
const [uid, name, outlet, startAt] = process.argv.slice(2);
const ov = core.loadOutletValet(db, outlet);
const actor = { kind: 'staff', id: uid, name, isAdmin: false, head: false, attendant: true, host: false };
while (Date.now() < Number(startAt)) {}
try { const r = pk.takeNext(db, ov, actor, new Date()); console.log(JSON.stringify({ ok: true, pickup_id: r.pickup_id })); }
catch (e) { console.log(JSON.stringify({ ok: false, code: e.code || String(e.message) })); }
`);
    const startAt = Date.now() + 12000;   // generous: children boot under the same loader on a busy Mac
    const results: any[] = await Promise.all(racers.map(k => new Promise(res => {
      const p = spawn(process.execPath, [...process.execArgv, child, users[k].id, users[k].name, OA, String(startAt)], { cwd: WT });
      let out = '';
      p.stdout.on('data', (d: Buffer) => { out += d; });
      p.stderr.on('data', (d: Buffer) => { out += d; });
      p.on('close', () => { try { res(JSON.parse(out.trim().split('\n').pop() || '{}')); } catch { res({ ok: false, code: 'parse', out }); } });
    })));
    const claimed = results.filter(r => r.ok && r.pickup_id).map(r => r.pickup_id);
    console.log(`  racers=${racers.length} results=${JSON.stringify(results.map(r => r.pickup_id ?? r.code))}`);
    eq(claimed.length, 2, `exactly 2 of ${racers.length} concurrent attendants got a car`);
    eq(new Set(claimed).size, 2, 'no car went to two attendants');
    const assigned = db.prepare(`SELECT COUNT(*) AS n FROM valet_events WHERE event_type = 'pickup.claimed' AND pickup_id IN (SELECT id FROM valet_pickups WHERE session_id IN (?, ?))`).get(cars[0], cars[1]) as any;
    eq(assigned.n, 2, 'exactly two claim events on the timeline');
    // Leave these two claimed; reassign them away later is not needed — cancel via head.
    for (const id of cars) {
      const p = core.activePickup(db, id);
      if (p) { pk.cancelPickup(db, ov(), A('head'), p.id, 'cleanup', new Date()); const f = core.activePickup(db, id); if (f) pk.ackChange(db, ov(), A('head'), f.id, f.version, { accept: true }, new Date()); }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  S('I gate, dwell, holding, no-show');
  let I1 = '';
  {
    // a4 holds p1 (G1) from section G.
    const p1 = core.activePickup(db, G1);
    eq(caught(() => pk.startFetch(db, ov(), A('a1'), p1.id, p1.version, at(80)))?.code, 'not_yours', 'only the assignee starts');
    pk.startFetch(db, ov(), A('a4'), p1.id, p1.version, at(80));
    eq([sess(G1).state, pick(p1.id).state, sess(G1).key_custodian_id], ['RETRIEVING', 'IN_PROGRESS', users.a4.id], 'fetching; keys with the fetcher');
    pk.markReady(db, ov(), A('a4'), p1.id, pick(p1.id).version, { gate_zone_id: ZG }, at(86));
    eq([sess(G1).state, sess(G1).dwell_deadline_at], ['READY_AT_GATE', at(89).toISOString()], 'ready; dwell = 3 min default');
    // Fill the gate (capacity 2) and test the full-gate exception.
    I1 = checkin('a1', 'I1', at(80)); park('a1', I1, at(80));
    const I2 = checkin('a1', 'I2', at(80)); park('a1', I2, at(80));
    const q1 = pk.requestPickup(db, ov(), core.SYSTEM, { session_id: I1, when: 'now' }, 'guest', at(81)).pickup;
    const q2 = pk.requestPickup(db, ov(), core.SYSTEM, { session_id: I2, when: 'now' }, 'guest', at(81)).pickup;
    pk.takeNext(db, ov(), A('a1'), at(82)); pk.startFetch(db, ov(), A('a1'), q1.id, pick(q1.id).version, at(82));
    pk.markReady(db, ov(), A('a1'), q1.id, pick(q1.id).version, { gate_zone_id: ZG }, at(87));
    pk.takeNext(db, ov(), A('a1'), at(87)); pk.startFetch(db, ov(), A('a1'), q2.id, pick(q2.id).version, at(87));
    const full = caught(() => pk.markReady(db, ov(), A('a1'), q2.id, pick(q2.id).version, { gate_zone_id: ZG }, at(90)));
    eq(full?.code, 'gate_full', 'third car at a 2-space gate refused');
    pk.markReady(db, ov(), A('a1'), q2.id, pick(q2.id).version, { gate_zone_id: ZG, override_reason: 'Guest standing at the gate already' }, at(90));
    ok(String((db.prepare(`SELECT reason FROM valet_events WHERE pickup_id = ? AND event_type = 'vehicle.ready'`).get(q2.id) as any).reason).includes('Guest standing'), 'over-capacity reason recorded');
    // Board shows dwell expiry + gate full.
    const b = board.headBoard(db, ov(), at(93));
    const c = b.cards.find((x: any) => x.id === G1);
    ok(c.flags.includes('dwell_expired') && c.flags.includes('dwell_overrun'), 'expired dwell flagged on the board');
    ok(b.exceptions.some((e: any) => e.kind === 'gate_full'), 'gate-full exception shown');
    // No-show branch: guest went inside → move to holding.
    pk.guestWentInside(db, ov(), A('a4'), G1, at(93));
    ok(!!sess(G1).guest_inside_at, 'guest went back inside recorded');
    pk.relocateStart(db, ov(), A('a4'), G1, sess(G1).version, 'guest_inside', at(93));
    eq(sess(G1).state, 'RELOCATING', 'relocating (move not yet complete)');
    eq(pick(p1.id).state, 'READY', 'pickup not closed by starting the move');
    eq(caught(() => pk.holdConfirm(db, ov(), A('a4'), G1, sess(G1).version, { zone_id: ZP }, at(94)))?.code, 'zone_required', 'holding needs a holding zone');
    pk.holdConfirm(db, ov(), A('a4'), G1, sess(G1).version, { zone_id: ZH, spot: 'H1', key_location: 'desk' }, at(95));
    eq([sess(G1).state, pick(p1.id).state], ['HOLDING_NEAR_GATE', 'NO_SHOW'], 'held near gate; pickup closed as no-show');
    // Holding capacity 1: the next car needs an exception.
    pk.relocateStart(db, ov(), A('a1'), I1, sess(I1).version, 'dwell_expired', at(95));
    eq(caught(() => pk.holdConfirm(db, ov(), A('a1'), I1, sess(I1).version, { zone_id: ZH }, at(96)))?.code, 'holding_full', 'full holding refused');
    arr.parkConfirm(db, ov(), A('a1'), I1, sess(I1).version, { zone_id: ZP, spot: 'back to lot', key_location: 'rack', key_rack: 'R2' }, at(96));
    eq(sess(I1).state, 'PARKED', 'safe alternative: park back in the lot');
    // Guest returns for the held car → a NEW pickup attempt, history kept.
    const back = pk.guestReturned(db, ov(), A('a4'), G1, at(100));
    eq(back.pickup.state, 'QUEUED', 'guest returned → new pickup queued');
    eq((db.prepare(`SELECT COUNT(*) AS n FROM valet_pickups WHERE session_id = ?`).get(G1) as any).n, 2, 'both attempts kept');
    const t = pk.takeNext(db, ov(), A('a4'), at(100));
    eq(t.pickup_id, back.pickup.id, 'held car can be fetched again');
    pk.startFetch(db, ov(), A('a4'), back.pickup.id, pick(back.pickup.id).version, at(100));
    eq(sess(G1).state, 'RETRIEVING', 'HOLDING → RETRIEVING');
  }

  // ═══════════════════════════════════════════════════════════════════════
  S('J change requests after claim');
  {
    const id = checkin('a2', 'J1', at(110)); park('a2', id, at(110));
    const p = pk.requestPickup(db, ov(), core.SYSTEM, { session_id: id, when: 'now' }, 'guest', at(111)).pickup;
    pk.takeNext(db, ov(), A('a2'), at(112));
    pk.startFetch(db, ov(), A('a2'), p.id, pick(p.id).version, at(112));
    const r = pk.cancelPickup(db, ov(), core.guestActor('dev'), p.id, 'guest cancel', at(113));
    eq([r.pending_ack, pick(p.id).state, sess(id).state], [true, 'IN_PROGRESS', 'RETRIEVING'], 'claimed work is NOT cancelled by the guest');
    ok(db.prepare(`SELECT 1 FROM valet_alerts WHERE dedupe_key = ? AND resolved_at IS NULL`).get(`change:${p.id}`), 'staff alerted');
    pk.cancelPickup(db, ov(), core.guestActor('dev'), p.id, 'guest cancel again', at(113.5));
    eq((db.prepare(`SELECT COUNT(*) AS n FROM valet_alerts WHERE dedupe_key = ?`).get(`change:${p.id}`) as any).n, 1, 'repeat taps do not pile up alerts');
    pk.ackChange(db, ov(), A('a2'), p.id, pick(p.id).version, { accept: true }, at(114));
    eq([pick(p.id).state, sess(id).state], ['CANCELLED', 'PARKING'], 'accepted: pickup cancelled, car goes back to PARKING (still held)');
    ok(['CHECKED_IN', 'PARKING', 'PARKED'].includes(sess(id).state) && !sess(id).handed_over_at, 'session never closed by a cancellation');
    park('a2', id, at(118));
    // Reschedule before claim is immediate; after claim it is a request.
    const p2 = pk.requestPickup(db, ov(), core.SYSTEM, { session_id: id, when: 'now' }, 'guest', at(120)).pickup;
    pk.reschedulePickup(db, ov(), core.SYSTEM, p2.id, 'at', at(150).toISOString(), at(121));
    eq(pick(p2.id).state, 'SCHEDULED', 'reschedule before claim applies at once');
    queue.promoteDue(db, OA, at(145));
    pk.takeNext(db, ov(), A('a2'), at(145));
    pk.reschedulePickup(db, ov(), core.SYSTEM, p2.id, 'at', at(170).toISOString(), at(146));
    eq([pick(p2.id).state, pick(p2.id).change_request.startsWith('reschedule:')], ['ASSIGNED', true], 'after claim: change request');
    const ack = pk.ackChange(db, ov(), A('head'), p2.id, pick(p2.id).version, { accept: true }, at(147));
    ok(ack.new_pickup_id && pick(ack.new_pickup_id).state === 'SCHEDULED', 'accepted reschedule books a new attempt');
    eq(sess(id).state, 'PARKED', 'car was not moving: stays parked');
    pk.cancelPickup(db, ov(), core.SYSTEM, ack.new_pickup_id, 'cleanup', at(148));
  }

  // ═══════════════════════════════════════════════════════════════════════
  S('K reassignment + handoff');
  {
    const id = checkin('a3', 'K1', at(200)); park('a3', id, at(200), { key_location: 'attendant' });
    const p = pk.requestPickup(db, ov(), core.SYSTEM, { session_id: id, when: 'now' }, 'guest', at(201)).pickup;
    pk.takeNext(db, ov(), A('a3'), at(202));
    eq(caught(() => pk.assignPickup(db, ov(), A('head'), p.id, pick(p.id).version, users.a5.id, '', at(203)))?.code, 'reason_required', 'reassignment needs a reason');
    const a5busy = core.activeTaskCount(db, users.a5.id);
    if (a5busy) { /* a5 may hold a car from section H; free it */ }
    pk.assignPickup(db, ov(), A('head'), p.id, pick(p.id).version, users.a5.id, 'a3 needed at the curb', at(203));
    const pr = pick(p.id);
    eq([pr.assigned_user_id, pr.handoff_from_id, pr.handoff_ack_at], [users.a5.id, users.a3.id, null], 'reassigned with an open handoff');
    eq(sess(id).key_custodian_id, users.a3.id, 'custody stays with a3 until acknowledged');
    eq(caught(() => pk.startFetch(db, ov(), A('a5'), p.id, pr.version, at(204)))?.code, 'handoff_open', 'cannot start before acknowledging');
    eq(caught(() => pk.ackHandoff(db, ov(), A('a3'), p.id, at(204)))?.code, 'not_yours', 'old attendant cannot acknowledge for the new one');
    pk.ackHandoff(db, ov(), A('a5'), p.id, at(204));
    eq(sess(id).key_custodian_id, users.a5.id, 'custody moved on acknowledgement');
    ok(db.prepare(`SELECT 1 FROM valet_custody WHERE session_id = ? AND note = 'handoff acknowledged'`).get(id), 'custody row written');
    pk.startFetch(db, ov(), A('a5'), p.id, pick(p.id).version, at(205));
    eq(pick(p.id).state, 'IN_PROGRESS', 'new attendant fetching');
    // Board: an attendant whose device went quiet is flagged uncertain, nothing re-dispatched.
    // Set a5's last heartbeat explicitly: section H races on the REAL clock and
    // may stamp a5's shift with today's wall time, which made this check pass
    // or fail depending on the hour the suite ran.
    db.prepare('UPDATE valet_shifts SET last_seen_at = ? WHERE user_id = ? AND ended_at IS NULL').run(cfgm.nowIso(at(205)), users.a5.id);
    const b = board.headBoard(db, ov(), at(240));
    const card = b.cards.find((x: any) => x.id === id);
    ok(card.flags.includes('uncertain'), 'quiet device holding a moving car → uncertain');
    eq(pick(p.id).assigned_user_id, users.a5.id, 'still assigned (no automatic second dispatch)');
    pk.markReady(db, ov(), A('a5'), p.id, pick(p.id).version, { gate_zone_id: ZG, override_reason: 'test gate overflow' }, at(241));
  }

  // ═══════════════════════════════════════════════════════════════════════
  S('L verified handover');
  {
    // G1 is RETRIEVING by a4 from section I → bring to gate.
    const p = core.activePickup(db, G1);
    pk.markReady(db, ov(), A('a4'), p.id, p.version, { gate_zone_id: ZG, override_reason: 'test gate overflow' }, at(250));
    const grantDev = 'dev-' + uid();
    db.prepare(`INSERT INTO valet_guest_devices (id, token_hash, created_at) VALUES (?,?,?)`).run(grantDev, creds.sha256(uid()), at(250).toISOString());
    db.prepare(`INSERT INTO valet_pass_grants (id, device_id, session_id, created_at) VALUES (?,?,?,?)`).run(uid(), grantDev, G1, at(250).toISOString());
    const code = pk.issueHandoverCode(db, G1, at(250));
    const tag = sess(G1).tag_code;
    let e = caught(() => pk.handover(db, ov(), A('a4'), G1, { tag_code: 'WRONG', method: 'guest_code', code: code.code }, at(250.2)));
    eq(e?.code, 'tag_mismatch', 'wrong tag refused');
    e = caught(() => pk.handover(db, ov(), A('a4'), G1, { tag_code: tag, method: 'guest_code', code: '000000' === code.code ? '111111' : '000000' }, at(250.3)));
    eq(e?.code, 'code_wrong', 'wrong code refused');
    eq(sess(G1).verify_failures, 2, 'failures counted');
    // Rotation: a new code supersedes; the old stays valid only inside the grace.
    const code2 = pk.issueHandoverCode(db, G1, at(250.4));
    e = caught(() => pk.handover(db, ov(), A('a4'), G1, { tag_code: tag, method: 'guest_code', code: code.code }, at(251)));
    eq(e?.code, 'code_wrong', 'rotated-out code refused after the grace');
    pk.handover(db, ov(), A('a4'), G1, { tag_code: tag, method: 'guest_code', code: code2.code }, at(250.6));
    const s = sess(G1);
    eq([s.state, s.handover_method, s.key_location], ['HANDED_OVER', 'guest_code', 'guest'], 'handed over by guest code');
    eq(pick(p.id).state, 'COMPLETED', 'pickup completed in the same transaction');
    eq((db.prepare(`SELECT status FROM valet_tags WHERE id = ?`).get(s.tag_id) as any).status, 'available', 'tag freed');
    eq((db.prepare(`SELECT COUNT(*) AS n FROM valet_pass_grants WHERE session_id = ? AND revoked_at IS NULL`).get(G1) as any).n, 0, 'pass grants revoked');
    ok(!!(db.prepare(`SELECT consumed_at FROM valet_handover_codes WHERE session_id = ? AND consumed_at IS NOT NULL`).get(G1)), 'code consumed');
    eq(caught(() => pk.handover(db, ov(), A('a4'), G1, { tag_code: tag, method: 'guest_code', code: code2.code }, at(250.7)))?.code, 'bad_state', 'replay on a closed car refused');
    eq(guest.guestState(db, { id: grantDev, lang: '' }, at(251)).passes.length, 0, 'old pass shows nothing after handover');
    // Claim code path (phone-less guest) + reissue revokes.
    const pl = checkin('a1', 'L2', at(260)); park('a1', pl, at(260));
    const c1 = arr.issueClaimCode(db, ov(), A('a1'), pl, at(260));
    const c2 = arr.issueClaimCode(db, ov(), A('a1'), pl, at(261));
    ok(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(c2.code), 'claim code shape XXXX-XXXX');
    const pp = pk.requestPickup(db, ov(), A('host'), { session_id: pl, when: 'now' }, 'host', at(262)).pickup;
    pk.takeNext(db, ov(), A('a1'), at(262)); pk.startFetch(db, ov(), A('a1'), pp.id, pick(pp.id).version, at(262));
    pk.markReady(db, ov(), A('a1'), pp.id, pick(pp.id).version, { gate_zone_id: ZG, override_reason: 'test gate overflow' }, at(266));
    eq(caught(() => pk.handover(db, ov(), A('a1'), pl, { tag_code: 'L2', method: 'claim_code', code: c1.code }, at(267)))?.code, 'code_wrong', 'superseded claim receipt refused');
    pk.handover(db, ov(), A('a1'), pl, { tag_code: 'l-2', method: 'claim_code', code: c2.code.toLowerCase().replace('-', ' ') }, at(267));
    eq(sess(pl).state, 'HANDED_OVER', 'claim code accepted (case/spacing tolerant), tag typed loosely');
    // Lockout + head recovery.
    const lk = checkin('a2', 'L3', at(270)); park('a2', lk, at(270));
    const lp = pk.requestPickup(db, ov(), core.SYSTEM, { session_id: lk, when: 'now' }, 'guest', at(270)).pickup;
    pk.takeNext(db, ov(), A('a2'), at(271)); pk.startFetch(db, ov(), A('a2'), lp.id, pick(lp.id).version, at(271));
    pk.markReady(db, ov(), A('a2'), lp.id, pick(lp.id).version, { gate_zone_id: ZG, override_reason: 'test gate overflow' }, at(275));
    let last: any = null;
    for (let i = 0; i < 5; i++) last = caught(() => pk.handover(db, ov(), A('a2'), lk, { tag_code: 'L3', method: 'guest_code', code: '12345' + i }, at(276)));
    eq([last?.status, last?.code], [423, 'locked'], '5th failure locks the car');
    eq(caught(() => pk.handover(db, ov(), A('a2'), lk, { tag_code: 'L3', method: 'guest_code', code: pk.issueHandoverCode(db, lk, at(277)).code }, at(277)))?.code, 'locked', 'even a right code is refused once locked');
    eq(caught(() => pk.handover(db, ov(), A('a2'), lk, { tag_code: 'L3', method: 'head_recovery', reason: 'Lost phone, verified', recovery_method: 'vehicle_documents_shown' }, at(278)))?.code, 'head_only', 'attendant cannot run recovery');
    eq(caught(() => pk.handover(db, ov(), A('head'), lk, { tag_code: 'L3', method: 'head_recovery', reason: 'short', recovery_method: 'vehicle_documents_shown' }, at(278)))?.code, 'reason_required', 'recovery needs a real reason');
    eq(caught(() => pk.handover(db, ov(), A('head'), lk, { tag_code: 'L3', method: 'head_recovery', reason: 'Guest phone battery died; RC book matched plate', recovery_method: 'government_id_photo' }, at(278)))?.code, 'method_required', 'ID-photo is not an accepted method');
    pk.handover(db, ov(), A('head'), lk, { tag_code: 'L3', method: 'head_recovery', reason: 'Guest phone battery died; RC book matched plate', recovery_method: 'vehicle_documents_shown' }, at(278));
    ok(sess(lk).handover_note.includes('vehicle_documents_shown'), 'recovery method + reason recorded');
  }

  // ═══════════════════════════════════════════════════════════════════════
  S('M guest layer');
  {
    const { entry_token } = adm.rotateEntryToken(db, OA, A('admin'), at(300));
    eq(guest.guestEntry(db, entry_token).ok, true, 'entry token resolves the venue');
    eq(guest.guestEntry(db, 'abc').ok, false, 'short/unknown token → nothing');
    eq(caught(() => guest.guestAct(db, null, { cmd: 'pickup', session_id: 'x' }, '1.1.1.1', false, at(300)))?.code, 'no_pass', 'no device → refused');
    const r = guest.guestAct(db, null, { cmd: 'checkin', e: entry_token, plate: 'KA01ZZ4321', make: 'Hondai', colour: 'Blue' }, '1.1.1.2', false, at(300));
    ok(/^\d{6}$/.test(r.body.pairing_code) && /HttpOnly/.test(r.setCookie) && /SameSite=Lax/.test(r.setCookie), 'pending check-in + 6-digit code + httpOnly cookie');
    const token = String(r.setCookie).split(';')[0].split('=')[1];
    const dev = guest.deviceFromCookie(db, token);
    ok(dev, 'cookie resolves a device');
    const r2 = guest.guestAct(db, dev, { cmd: 'checkin', e: entry_token, plate: 'KA01ZZ4321' }, '1.1.1.2', false, at(301));
    eq(r2.body.pairing_code, r.body.pairing_code, 'retry returns the same pairing code');
    eq(guest.guestState(db, dev, at(301)).passes.length, 0, 'no pass until staff confirm');
    const found = arr.findPendingByCode(db, ov(), r.body.pairing_code, at(302));
    ok(found.plate === 'KA01ZZ4321' && found.guest_mobile === undefined, 'staff see the car details, not the mobile');
    eq(caught(() => arr.findPendingByCode(db, ov(), '12', at(302)))?.code, 'bad_code', 'malformed code refused');
    const sid = arr.checkinCreate(db, ov(), A('a1'), { request_id: found.id, tag_code: 'M1' }, at(303)).session_id;
    const st = guest.guestState(db, dev, at(304));
    eq(st.passes.length, 1, 'paired device now sees its pass');
    eq(st.passes[0].plate_masked, '•••• 4321', 'guest pass shows a masked plate');
    ok(!JSON.stringify(st).includes('KA01ZZ4321'), 'full plate never sent to the guest');
    // Guest acts.
    const pr = guest.guestAct(db, dev, { cmd: 'pickup', session_id: sid, when: 'in5', idempotency_key: 'g1' }, '1.1.1.2', false, at(305));
    const pr2 = guest.guestAct(db, dev, { cmd: 'pickup', session_id: sid, when: 'in5', idempotency_key: 'g1' }, '1.1.1.2', false, at(305.1));
    eq(pr2.body.pickup_id, pr.body.pickup_id, 'guest retry returns the same request');
    eq(caught(() => guest.guestAct(db, dev, { cmd: 'code', session_id: sid }, '1.1.1.2', false, at(305)))?.code, 'not_yet', 'no handover code before the car is claimed');
    guest.guestAct(db, dev, { cmd: 'outside', session_id: sid }, '1.1.1.2', false, at(306));
    ok(pick(pr.body.pickup_id).guest_outside_at, 'I\'m outside recorded');
    guest.guestAct(db, dev, { cmd: 'help', session_id: sid }, '1.1.1.2', false, at(306));
    guest.guestAct(db, dev, { cmd: 'help', session_id: sid }, '1.1.1.2', false, at(306.1));
    eq((db.prepare(`SELECT COUNT(*) AS n FROM valet_alerts WHERE dedupe_key = ?`).get(`help:${sid}`) as any).n, 1, 'help de-duplicated');
    // Another device cannot touch this car — same answer as a missing one.
    const other = guest.guestAct(db, null, { cmd: 'checkin', e: entry_token, plate: 'KA01ZZ9999' }, '1.1.1.3', false, at(307));
    const dev2 = guest.deviceFromCookie(db, String(other.setCookie).split(';')[0].split('=')[1]);
    const x1 = caught(() => guest.guestAct(db, dev2, { cmd: 'pickup', session_id: sid, when: 'now' }, '1.1.1.3', false, at(307)));
    const x2 = caught(() => guest.guestAct(db, dev2, { cmd: 'pickup', session_id: 'no-such-id', when: 'now' }, '1.1.1.3', false, at(307)));
    eq([x1?.code, x1?.message], [x2?.code, x2?.message], 'other car and missing car look identical (no enumeration)');
    // Activation link: single use.
    const s2 = checkin('a1', 'M2', at(310));
    const link = arr.issueActivationLink(db, ov(), A('a1'), s2, at(310));
    const a = String(link.path).split('a=')[1];
    const act1 = guest.guestAct(db, null, { cmd: 'activate', a }, '1.1.1.4', false, at(311));
    ok(act1.body.session_id === s2 && act1.setCookie, 'activation binds a new browser');
    eq(caught(() => guest.guestAct(db, null, { cmd: 'activate', a }, '1.1.1.5', false, at(311.5)))?.code, 'link_used', 'link cannot be used twice');
    const link2 = arr.issueActivationLink(db, ov(), A('a1'), s2, at(312));
    eq(caught(() => guest.guestAct(db, null, { cmd: 'activate', a: String(link2.path).split('a=')[1] }, '1.1.1.6', false, at(330)))?.code, 'link_used', 'expired link refused');
    // Tag reuse: a new car on a recycled tag is never visible to the old pass.
    const devOld = guest.deviceFromCookie(db, String(act1.setCookie).split(';')[0].split('=')[1]);
    pk.voidSession(db, ov(), A('head'), s2, sess(s2).version, 'test record for tag reuse', true, at(331));
    const s3 = checkin('a1', 'M2', at(332));
    ok(sess(s3).tag_code === 'M2', 'tag M2 reused on a new car');
    eq(guest.guestState(db, devOld, at(333)).passes.length, 0, 'old pass does not show the new car on the reused tag');
    // CSRF guard.
    const mk = (h: Record<string, string>) => new Request('http://localhost:3900/api/valet-guest/act', { method: 'POST', headers: h });
    eq(caught(() => guest.guardGuestWrite(mk({ host: 'localhost:3900' })))?.code, 'csrf', 'missing custom header → refused');
    eq(caught(() => guest.guardGuestWrite(mk({ host: 'localhost:3900', 'x-valet-guest': '1', origin: 'https://evil.example' })))?.code, 'csrf', 'cross-origin → refused');
    eq(caught(() => guest.guardGuestWrite(mk({ host: 'localhost:3900', 'x-valet-guest': '1', 'sec-fetch-site': 'cross-site' })))?.code, 'csrf', 'cross-site fetch → refused');
    ok(caught(() => guest.guardGuestWrite(mk({ host: 'localhost:3900', 'x-valet-guest': '1', origin: 'http://localhost:3900' }))) === null, 'same-origin passes');
    // Expiry of abandoned pending check-ins.
    const pend = guest.guestAct(db, null, { cmd: 'checkin', e: entry_token, plate: 'KA01ZZ0001' }, '1.1.1.7', false, at(400));
    arr.expirePending(db, at(400 + 16));
    eq(caught(() => arr.findPendingByCode(db, ov(), pend.body.pairing_code, at(416)))?.code, 'code_not_found', 'abandoned check-in expired');
    // Rate limit: guest check-ins per IP.
    let limited = false;
    for (let i = 0; i < 12 && !limited; i++) {
      const c = caught(() => guest.guestAct(db, null, { cmd: 'checkin', e: entry_token, plate: `KA01RL${i}` }, '9.9.9.9', false, at(500)));
      if (c?.code === 'slow_down') limited = true;
    }
    ok(limited, 'guest check-in is rate-limited per IP');
  }

  // ═══════════════════════════════════════════════════════════════════════
  S('N business date + service hours');
  {
    const cfg = cfgm.parseConfig({});
    eq(cfgm.businessDate(new Date('2026-11-09T19:10:00Z'), { business_day_starts: '00:00' }), '2026-11-10', '00:40 IST is calendar day 10th (midnight day start)…');
    eq(cfgm.businessDate(new Date('2026-11-09T19:10:00Z'), { business_day_starts: '05:00' }), '2026-11-09', '…belongs to the night of the 9th (day starts 05:00)');
    eq(cfgm.businessDate(new Date('2026-11-10T00:00:00Z'), cfg), '2026-11-10', '05:30 IST is a new business day');
    ok(cfgm.withinServiceHours(new Date('2026-11-09T19:00:00Z'), cfg), '00:30 IST inside 11:00–01:00');
    ok(!cfgm.withinServiceHours(new Date('2026-11-09T20:40:00Z'), cfg), '02:10 IST outside');
    eq(cfgm.nextClose(new Date('2026-11-09T14:30:00Z'), cfg).toISOString(), '2026-11-09T19:30:00.000Z', 'next close after 20:00 IST is 01:00 IST');
    const late = new Date('2026-11-09T18:45:00Z');   // 00:15 IST
    eq(caught(() => pk.resolveTarget(ov(), 'at', new Date('2026-11-09T19:40:00Z').toISOString(), late))?.code, 'outside_hours', 'booking past closing refused');
    ok(caught(() => pk.resolveTarget(ov(), 'at', new Date('2026-11-09T19:15:00Z').toISOString(), late)) === null, 'booking 00:45 IST before a 01:00 close accepted');
    // The guest pass may only OFFER times the server accepts (found in the browser at 04:00 IST).
    for (const [when, label] of [[at(0), '20:00 IST'], [late, '00:15 IST']] as const) {
      const slots: string[] = guest.laterSlots(ov(), when);
      ok(slots.length > 0 && slots.every(x => caught(() => pk.resolveTarget(ov(), 'at', x, when)) === null), `every later slot offered at ${label} is accepted (${slots.length} slots)`);
    }
    ok(!guest.laterSlots(ov(), late).includes('2026-11-09T19:30:00.000Z'), 'the closing minute (01:00) itself is not offered');
    eq(guest.laterSlots(ov(), new Date('2026-11-09T22:00:00Z')), [], 'after closing (03:30 IST) no later times are offered');
    const sid = checkin('a1', 'N1', new Date('2026-11-09T19:10:00Z'));
    eq(sess(sid).business_date, '2026-11-09', 'a car checked in at 00:40 IST carries the previous business date');
    eq(cfgm.parseConfig({ dwell_minutes: 7 }).dwell_minutes, 3, 'dwell outside 2/3/5/10 falls back to 3');
    eq(cfgm.parseConfig('{garbage').escalation.unclaimed_min, 5, 'garbled config → defaults (5-min escalation)');
  }

  // ═══════════════════════════════════════════════════════════════════════
  S('O shifts + custody');
  {
    // a3 holds keys for K1? K1 custody moved to a5. Give a3 a car with keys.
    const id = checkin('a3', 'O1', at(600));
    park('a3', id, at(601), { key_location: 'attendant' });
    const e = caught(() => adm.shiftEnd(db, ov(), A('a3'), null, '', at(602)));
    eq(e?.code, 'custody_outstanding', 'cannot end shift holding keys');
    ok(String(e?.message).includes('O1'), 'refusal names the tag');
    arr.keyTransfer(db, ov(), A('a3'), id, sess(id).version, { to: 'rack', key_rack: 'R9' }, at(603));
    // a3 may also still hold other keys from earlier sections; clear any.
    for (const k of adm.outstandingCustody(db, users.a3.id).keys) arr.keyTransfer(db, ov(), A('head'), k.id, sess(k.id).version, { to: 'desk' }, at(603));
    adm.shiftEnd(db, ov(), A('a3'), null, 'end of night', at(604));
    ok(!core.openShift(db, users.a3.id), 'shift ended after keys transferred');
    eq(caught(() => adm.shiftEnd(db, ov(), A('a2'), users.a1.id, '', at(604)))?.code, 'head_only', 'attendant cannot end another person\'s shift');
    const team = board.teamPanel(db, ov(), at(605));
    ok(team.find((t: any) => t.user_id === users.a3.id)?.status === 'off', 'team panel shows a3 off shift');
    ok(team.some((t: any) => t.status === 'available' || t.status === 'busy'), 'team panel shows on-shift staff');
    // Head-to-head handover note.
    const n = adm.handoverNoteCreate(db, ov(), A('head'), 'Two VIP cars in holding', at(606));
    eq(caught(() => adm.handoverNoteAck(db, ov(), A('head'), n.note_id, at(607)))?.code, 'self_ack', 'outgoing head cannot acknowledge own note');
    adm.handoverNoteAck(db, ov(), A('head2'), n.note_id, at(607));
    ok(db.prepare(`SELECT acknowledged_at FROM valet_handover_notes WHERE id = ?`).get(n.note_id).acknowledged_at, 'incoming head acknowledged');
  }

  // ═══════════════════════════════════════════════════════════════════════
  S('P void, desk, ETA honesty, cross-outlet reads');
  {
    const id = checkin('head', 'P1', at(700));
    eq(caught(() => pk.voidSession(db, ov(), A('a1'), id, sess(id).version, 'duplicate entry', false, at(701)))?.code, 'head_only', 'attendant cannot void');
    pk.voidSession(db, ov(), A('head'), id, sess(id).version, 'Duplicate of tag P1 entry', false, at(701));
    eq(sess(id).state, 'VOIDED', 'voided');
    ok((db.prepare(`SELECT COUNT(*) AS n FROM valet_events WHERE session_id = ?`).get(id) as any).n >= 2, 'history kept after void');
    eq((db.prepare(`SELECT status FROM valet_tags WHERE outlet_id = ? AND code_norm = 'P1'`).get(OA) as any).status, 'available', 'void frees the tag');
    // Desk lookup: masked plate, no contact, needs a query.
    const d1 = checkin('head', 'P2', at(702));
    eq(board.deskLookup(db, ov(), '', at(703)).length, 0, 'empty query lists nothing');
    const hit = board.deskLookup(db, ov(), 'p2', at(703));
    ok(hit.length === 1 && hit[0].plate.startsWith('••••') && hit[0].guest_name === undefined && hit[0].mobile_masked === undefined, 'desk sees masked plate, no contact');
    const hb = board.headBoard(db, ov(), at(703));
    const hc = hb.cards.find((c: any) => c.id === d1);
    ok(hc.mobile_masked === '•••••3210' && !JSON.stringify(hb).includes('98765 43210'), 'head board masks the mobile');
    const rv = adm.revealContact(db, ov(), A('head'), d1, 'Guest left keys fob in car', at(704));
    eq(rv.guest_mobile, '+919876543210', 'controlled reveal returns the number');
    ok(db.prepare(`SELECT 1 FROM valet_events WHERE session_id = ? AND event_type = 'contact.revealed'`).get(d1), 'reveal audited');
    ok(!JSON.stringify(db.prepare(`SELECT data_json, reason FROM valet_events WHERE session_id = ?`).all(d1)).includes('9876543210'), 'number never written to the timeline');
    // Cross-outlet: outlet B cannot read A's car.
    const ovB = { ...ov(), outlet_id: OB };
    eq(caught(() => core.getSession(db, d1, OB))?.code, 'not_found', 'other outlet sees "not found"');
    eq(board.sessionDetail(db, ovB, d1, 'head', at(705)), null, 'detail read scoped by outlet');
    // ETA honesty: nobody on shift → no number.
    for (const t of db.prepare(`SELECT user_id FROM valet_shifts WHERE outlet_id = ? AND ended_at IS NULL`).all(OA) as any[]) {
      db.prepare(`UPDATE valet_shifts SET status = 'break' WHERE user_id = ? AND ended_at IS NULL`).run(t.user_id);
    }
    park('head', d1, at(705));
    const ep = pk.requestPickup(db, ov(), core.SYSTEM, { session_id: d1, when: 'now' }, 'guest', at(706)).pickup;
    const eta = queue.etaFor(db, pick(ep.id), sess(d1).zone_id, 'PARKED', ov().cfg, at(706));
    eq([eta.low_min, eta.note], [null, 'no_staff'], 'no staff on shift → no fabricated ETA');
    db.prepare(`UPDATE valet_shifts SET status = 'on' WHERE outlet_id = ? AND ended_at IS NULL`).run(OA);
    const eta2 = queue.etaFor(db, pick(ep.id), sess(d1).zone_id, 'PARKED', ov().cfg, at(706));
    ok(Number.isInteger(eta2.low_min) && Number.isInteger(eta2.high_min) && eta2.high_min > eta2.low_min, 'ETA is a whole-minute range');
    ok(['recent', 'configured'].includes(eta2.basis), 'ETA carries its basis');
    const m = board.requestToReady(db, ov(), '2026-11-09');
    ok(m.immediate_wait.n >= 3 && m.immediate_wait.p90 !== null && m.immediate_wait.max >= m.immediate_wait.p90, `request-to-ready metrics with a denominator (n=${m.immediate_wait.n})`);
    eq(board.requestToReady(db, ov(), '2026-11-10').immediate_wait.n, 0, 'another business date has its own denominator');
  }

  // ═══════════════════════════════════════════════════════════════════════
  S('Q escalations');
  {
    const esc = require(path.join(WT, 'src/lib/valet/escalations.ts'));
    // Outlet B: enable it for this section; nobody on shift there.
    run('admin', { cmd: 'settings.enable', outlet_id: OB, enabled: true }, at(800));
    const ovB = () => core.loadOutletValet(db, OB);
    const zB = (run('admin', { cmd: 'zone.save', outlet_id: OB, name: 'ZZ B lot', kind: 'parking', capacity: 10 }, at(800)) as any).zone_id;
    const sB = arr.checkinCreate(db, ovB(), A('admin'), { plate: 'TS09QQ0001', tag_code: 'Q1' }, at(800)).session_id;
    arr.parkConfirm(db, ovB(), A('admin'), sB, sess(sB).version, { zone_id: zB, key_location: 'desk' }, at(800));
    const qp = pk.requestPickup(db, ovB(), core.SYSTEM, { session_id: sB, when: 'now' }, 'guest', at(801)).pickup;
    let r = esc.runEscalations(db, ovB(), at(803));
    eq(r.raised, 1, 'no staff on shift → escalated at once');
    r = esc.runEscalations(db, ovB(), at(807));
    eq(r.raised, 1, 'unclaimed past 5 min → escalated');
    r = esc.runEscalations(db, ovB(), at(808));
    eq(r.raised, 0, 'repeat pass raises nothing (deduped)');
    eq((db.prepare(`SELECT COUNT(*) AS n FROM valet_alerts WHERE outlet_id = ? AND resolved_at IS NULL AND dedupe_key LIKE 'esc:%'`).get(OB) as any).n, 2, 'two open escalations');
    pk.cancelPickup(db, ovB(), core.SYSTEM, qp.id, 'guest left', at(809));
    r = esc.runEscalations(db, ovB(), at(810));
    eq(r.resolved, 2, 'both auto-resolved once the request is gone');
  }

  // ═══════════════════════════════════════════════════════════════════════
  S('R notifications');
  {
    const nt = require(path.join(WT, 'src/lib/valet/notify.ts'));
    const sid = checkin('a1', 'R1', at(900)); park('a1', sid, at(900));
    eq(nt.enqueue(db, { outlet_id: OA, session_id: sid, kind: 'ready', dedupe: 'x1', params: [] }, at(900)), false, 'no verified identity → nothing queued (a typed number is not enough)');
    const link = nt.startLink(db, ov(), sid, at(901));
    ok(/^[0-9A-Z]{6}$/.test(link.code), 'link code issued');
    eq(nt.startLink(db, ov(), sid, at(902)).code, link.code, 'asking again returns the same code');
    const payload = (from: string, text: string, id: string) => JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id, from, text: { body: text } }] } }] }] });
    eq(nt.ingestWhatsApp(db, payload('919000000001', 'VALET ZZZZZZ', 'm0'), at(903), { simulated: true }), ['link: unknown or expired code'], 'wrong code links nothing');
    eq(nt.ingestWhatsApp(db, payload('919000000001', `valet ${link.code.toLowerCase()}`, 'm1'), at(903), { simulated: true }), ['linked'], 'guest message with the code verifies the number');
    eq(nt.ingestWhatsApp(db, payload('919000000001', `VALET ${link.code}`, 'm1'), at(903), { simulated: true }), [], 'same provider message id again → ignored (dedupe)');
    const ident = db.prepare(`SELECT phone, verified_how, consent_at FROM valet_msg_identities WHERE session_id = ?`).get(sid) as any;
    ok(ident.phone === '+919000000001' && ident.verified_how === 'inbound_message' && ident.consent_at, 'identity verified with consent recorded');
    eq(nt.linkState(db, sid), { linked: true, opted_out: false }, 'pass shows linked');
    // Simulator: real sending off for the outlet → 'simulated', never 'sent', and the transport is never called.
    let calls = 0;
    const fake = async () => { calls++; return { ok: true, provider: 'meta_cloud', message_id: `wamid.${calls}` }; };
    let d = await nt.deliverDue(db, at(904), fake);
    ok(d.simulated >= 1 && calls === 0, 'outlet sending OFF → simulated; nothing sent');
    ok(String((db.prepare(`SELECT last_error FROM valet_notifications WHERE session_id = ? AND kind = 'linked'`).get(sid) as any).last_error).startsWith('SIMULATED'), 'labelled SIMULATED — nothing was sent');
    // Switch real sending on + name templates: still simulated off-production.
    const cfgOn = { ...ov().cfg, notifications: { whatsapp: true, whatsapp_number: '+910000000000', templates: { linked: { name: 'valet_linked', lang: 'en' }, ready: { name: 'valet_ready', lang: 'en' }, holding: { name: 'valet_holding', lang: 'en' }, eta_changed: { name: 'valet_eta', lang: 'en' }, closing_prompt: { name: 'valet_closing', lang: 'en' } } } };
    run('admin', { cmd: 'settings.config', outlet_id: OA, config: cfgOn }, at(905));
    ok(nt.simulationReason(ov(), 'ready').includes('not the live server'), 'non-production process refuses real sends');
    process.env.VALET_ALLOW_DEV_SEND = '1';
    eq(nt.simulationReason(ov(), 'ready'), '', 'with the developer switch + config + template → would send');
    // Ready message: queued by the state hook, sent through the (fake) transport.
    const pr = pk.requestPickup(db, ov(), core.SYSTEM, { session_id: sid, when: 'now' }, 'guest', at(906)).pickup;
    pk.assignPickup(db, ov(), A('head'), pr.id, pick(pr.id).version, users.a1.id, '', at(906));   // this exact car (older requests are still queued)
    pk.startFetch(db, ov(), A('a1'), pr.id, pick(pr.id).version, at(906));
    pk.markReady(db, ov(), A('a1'), pr.id, pick(pr.id).version, { gate_zone_id: ZG, override_reason: 'test gate overflow' }, at(910));
    eq(nt.queueStateMessages(db, ov(), at(910)) >= 1, true, 'ready message queued');
    eq(nt.queueStateMessages(db, ov(), at(910.2)), 0, 'not queued twice');
    d = await nt.deliverDue(db, at(910.5), fake);
    const rm = db.prepare(`SELECT status, provider_message_id, delivered_at FROM valet_notifications WHERE session_id = ? AND kind = 'ready'`).get(sid) as any;
    eq([rm.status, rm.delivered_at], ['sent', null], 'accepted by provider = "sent", NOT delivered');
    const st = (id: string, status: string, ts: number) => JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id, status, timestamp: String(Math.floor(ts / 1000)) }] } }] }] });
    nt.ingestWhatsApp(db, st(rm.provider_message_id, 'delivered', at(911).getTime()), at(911));
    eq((db.prepare(`SELECT status FROM valet_notifications WHERE provider_message_id = ?`).get(rm.provider_message_id) as any).status, 'delivered', 'delivered only from the provider webhook');
    nt.ingestWhatsApp(db, st(rm.provider_message_id, 'sent', at(911.5).getTime()), at(911.5));
    eq((db.prepare(`SELECT status FROM valet_notifications WHERE provider_message_id = ?`).get(rm.provider_message_id) as any).status, 'delivered', 'a late "sent" never moves it backwards');
    eq(nt.ingestWhatsApp(db, st(rm.provider_message_id, 'read', at(-20000).getTime()), at(912)).length, 0, 'stale (replayed) status ignored');
    // Failure ladder: 3 attempts with backoff, then failed + on the board.
    const sid2 = checkin('a2', 'R2', at(920)); park('a2', sid2, at(920));
    const l2 = nt.startLink(db, ov(), sid2, at(920));
    nt.ingestWhatsApp(db, payload('919000000002', `VALET ${l2.code}`, 'm2'), at(920), { simulated: true });
    const bad = async () => ({ ok: false, reason: 'send_failed', detail: 'HTTP 500' });
    await nt.deliverDue(db, at(921), bad);
    let row = db.prepare(`SELECT status, attempts, next_attempt_at FROM valet_notifications WHERE session_id = ? AND kind = 'linked'`).get(sid2) as any;
    eq([row.status, row.attempts], ['queued', 1], 'first failure → retry queued');
    await nt.deliverDue(db, at(921.5), bad);
    eq((db.prepare(`SELECT attempts FROM valet_notifications WHERE session_id = ? AND kind = 'linked'`).get(sid2) as any).attempts, 1, 'not retried before its backoff');
    await nt.deliverDue(db, at(923), bad); await nt.deliverDue(db, at(940), bad);
    row = db.prepare(`SELECT status, attempts FROM valet_notifications WHERE session_id = ? AND kind = 'linked'`).get(sid2) as any;
    eq([row.status, row.attempts], ['failed', 3], 'bounded: failed after 3 attempts');
    ok(board.headBoard(db, ov(), at(941)).exceptions.some((e: any) => e.kind === 'notify_failed'), 'failed message shown on the board');
    // Obsolete messages stop: car handed over before delivery.
    const c2 = pk.issueHandoverCode(db, sid, at(912));
    nt.enqueue(db, { outlet_id: OA, session_id: sid, kind: 'ready', dedupe: 'ready-again', params: [] }, at(912));
    pk.handover(db, ov(), A('a1'), sid, { tag_code: 'R1', method: 'guest_code', code: c2.code }, at(912.2));
    d = await nt.deliverDue(db, at(912.5), fake);
    ok(d.cancelled >= 1, 'queued message for a handed-over car is cancelled, not sent');
    // Replies: NOW with one car → request; STOP → opt-out + cancel.
    const before = calls;
    eq(nt.ingestWhatsApp(db, payload('919000000002', 'now', 'm3'), at(950)), ['pickup requested'], 'NOW from the verified number requests that car');
    ok(core.activePickup(db, sid2), 'pickup exists');
    eq(nt.ingestWhatsApp(db, payload('919000000002', 'NOW', 'm4'), at(950.5)), ['pickup already active'], 'repeat NOW → same request');
    eq(nt.ingestWhatsApp(db, payload('919000000099', 'NOW', 'm5'), at(951)), ['inbound from unknown number — ignored'], 'unknown number cannot request a car');
    // Two cars on one number → never guess.
    const sid3 = checkin('a2', 'R3', at(952)); park('a2', sid3, at(952));
    const l3 = nt.startLink(db, ov(), sid3, at(952));
    nt.ingestWhatsApp(db, payload('919000000002', `VALET ${l3.code}`, 'm6'), at(952), { simulated: true });
    eq(nt.ingestWhatsApp(db, payload('919000000002', 'NOW', 'm7'), at(953)), ['pickup request ambiguous — staff alerted'], 'two cars → staff alerted, nothing requested');
    eq(core.activePickup(db, sid3), null, 'second car NOT requested by guesswork');
    eq(nt.ingestWhatsApp(db, payload('919000000002', 'STOP', 'm8'), at(954)), ['opt-out (2)'], 'STOP opts the number out');
    eq(nt.enqueue(db, { outlet_id: OA, session_id: sid3, kind: 'ready', dedupe: 'after-stop', params: [] }, at(955)), false, 'nothing queued after opt-out');
    ok(calls === before, 'replies never call the transport');
    delete process.env.VALET_ALLOW_DEV_SEND;
    // The real webhook route acts ONLY on a signed, enforced request.
    const hook = require(path.join(WT, 'src/app/api/whatsapp/webhook/route.ts'));
    const sid4 = checkin('a1', 'R4', at(960)); park('a1', sid4, at(960));
    const l4 = nt.startLink(db, ov(), sid4, new Date());
    const body4 = payload('919000000004', `VALET ${l4.code}`, `m-${uid()}`);
    db.prepare(`DELETE FROM settings WHERE key = 'wa_app_secret'`).run();
    for (const k of ['WA_APP_SECRET', 'META_APP_SECRET', 'WHATSAPP_APP_SECRET']) delete process.env[k];
    await hook.POST(new Request('http://localhost/api/whatsapp/webhook', { method: 'POST', body: body4 }));
    eq((db.prepare(`SELECT verified_at FROM valet_msg_identities WHERE session_id = ?`).get(sid4) as any).verified_at, null, 'unsigned webhook (no app secret) → valet ignores it');
    const crypto = require('crypto');
    db.prepare(`INSERT INTO settings (key, value) VALUES ('wa_app_secret', 'zz-test-secret') ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
    const bad4 = await hook.POST(new Request('http://localhost/api/whatsapp/webhook', { method: 'POST', body: body4, headers: { 'x-hub-signature-256': 'sha256=' + 'a'.repeat(64) } }));
    eq(bad4.status, 401, 'wrong signature refused');
    const sig = 'sha256=' + crypto.createHmac('sha256', 'zz-test-secret').update(Buffer.from(body4)).digest('hex');
    const good = await hook.POST(new Request('http://localhost/api/whatsapp/webhook', { method: 'POST', body: body4, headers: { 'x-hub-signature-256': sig } }));
    eq(good.status, 200, 'signed webhook accepted');
    ok((db.prepare(`SELECT verified_at FROM valet_msg_identities WHERE session_id = ?`).get(sid4) as any).verified_at, 'signed webhook links the pass');
    db.prepare(`DELETE FROM settings WHERE key = 'wa_app_secret'`).run();
  }

  // ═══════════════════════════════════════════════════════════════════════
  S('S retention');
  {
    const ret = require(path.join(WT, 'src/lib/valet/retention.ts'));
    const old = new Date('2025-09-01T12:00:00Z'), now = new Date('2026-11-09T00:30:00Z');   // 06:00 IST
    const mk = (tag: string) => {
      const id = arr.checkinCreate(db, ov(), A('admin'), { plate: `TS09RT${tag}`, tag_code: tag, guest_name: 'Old Guest', guest_mobile: '+919800000000' }, old).session_id;
      db.prepare(`INSERT INTO valet_media (id, outlet_id, session_id, mime, size_bytes, sha256, data, captured_at) VALUES (?,?,?, 'image/jpeg', 3, 'x', X'FFD8FF', ?)`).run(uid('zzm'), OA, id, old.toISOString());
      pk.voidSession(db, ov(), A('head'), id, sess(id).version, 'old test record for retention', true, old);
      return id;
    };
    const plain = mk('RT1'), heldId = mk('RT2');
    adm.incidentCreate(db, ov(), A('head'), { session_id: heldId, kind: 'damage', description: 'Scratch dispute pending' }, old);
    const inc = db.prepare(`SELECT id FROM valet_incidents WHERE session_id = ?`).get(heldId) as any;
    adm.incidentResolve(db, ov(), A('head'), { incident_id: inc.id, resolution: 'Insurance claim open', retention_hold: true }, old);
    const ordersBefore = (db.prepare('SELECT COUNT(*) AS n FROM orders').get() as any).n;
    const r = ret.runRetention(db, ov(), now);
    ok(r.ran && r.sessions >= 1 && r.photos >= 1 && r.held >= 1, `retention ran (${JSON.stringify(r)})`);
    const p1 = sess(plain);
    ok(p1.plate === '' && p1.guest_name === '' && p1.guest_mobile === '' && p1.redacted_at, 'old car: plate + guest details removed');
    eq((db.prepare(`SELECT data IS NULL AS gone, deleted_reason FROM valet_media WHERE session_id = ?`).get(plain) as any), { gone: 1, deleted_reason: 'retention' }, 'old photo bytes removed, record kept');
    ok(sess(heldId).guest_mobile === '+919800000000' && !sess(heldId).redacted_at, 'incident hold: kept intact');
    eq((db.prepare(`SELECT COUNT(*) AS n FROM valet_events WHERE session_id = ?`).get(plain) as any).n >= 2, true, 'operational audit kept');
    eq((db.prepare('SELECT COUNT(*) AS n FROM orders').get() as any).n, ordersBefore, 'shared FNB records untouched');
    eq(ret.runRetention(db, ov(), now).ran, false, 'once per outlet per day');
    ok(sess(checkin('a1', 'RT3', now)).plate !== '', 'a current car is never touched');
  }

  // ═══════════════════════════════════════════════════════════════════════
  S('T closing rush');
  {
    const nt = require(path.join(WT, 'src/lib/valet/notify.ts'));
    const cl = require(path.join(WT, 'src/lib/valet/closing.ts'));
    run('admin', { cmd: 'settings.config', outlet_id: OA, config: { ...ov().cfg, closing_rush: { enabled: true, lead_minutes: 40, batch_size: 2 }, notifications: { ...ov().cfg.notifications, whatsapp: false } } }, at(1000));
    const close = new Date('2026-11-09T19:30:00Z');   // 01:00 IST
    const before = new Date(close.getTime() - 30 * 60_000), early = new Date(close.getTime() - 60 * 60_000);
    const ids: string[] = [];
    for (const t of ['CR1', 'CR2', 'CR3']) {
      const id = checkin('head', t, early); park('head', id, early); ids.push(id);
      const l = nt.startLink(db, ov(), id, early);
      nt.ingestWhatsApp(db, JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: `cr-${t}`, from: `9190000001${ids.length}`, text: { body: `VALET ${l.code}` } }] } }] }] }), early, { simulated: true });
    }
    eq(cl.runClosingRush(db, ov(), early).window, false, 'outside the 40-minute window → nothing');
    const first = cl.runClosingRush(db, ov(), before);
    ok(first.window && first.prompted >= 1 && first.prompted <= 2, `batch size respected (${first.prompted} of 3)`);
    const second = cl.runClosingRush(db, ov(), new Date(before.getTime() + 60_000));
    eq((db.prepare(`SELECT COUNT(*) AS n FROM valet_notifications WHERE kind = 'closing_prompt' AND outlet_id = ?`).get(OA) as any).n, first.prompted + second.prompted, 'every prompt counted is one row');
    eq((db.prepare(`SELECT COUNT(*) AS n FROM (SELECT session_id FROM valet_notifications WHERE kind = 'closing_prompt' GROUP BY session_id HAVING COUNT(*) > 1)`).get() as any).n, 0, 'no guest asked twice');
    eq(ids.map(id => core.activePickup(db, id)).filter(Boolean).length, 0, 'a prompt never creates a pickup by itself');
  }

  // ═══════════════════════════════════════════════════════════════════════
  S('U photos');
  {
    const md = require(path.join(WT, 'src/lib/valet/media.ts'));
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(50, 1)]);
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    const sid = checkin('a1', 'U1', at(1100));
    eq(md.sniffImage(jpeg), 'image/jpeg', 'JPEG recognised by its bytes');
    eq(md.sniffImage(png), 'image/png', 'PNG recognised');
    eq(caught(() => md.storePhoto(db, ov(), A('a1'), { session_id: sid, data: html }, at(1100)))?.code, 'not_image', 'HTML disguised as a photo refused');
    eq(caught(() => md.storePhoto(db, ov(), A('a1'), { session_id: sid, data: Buffer.alloc(md.PHOTO_MAX_BYTES + 1, 0xff) }, at(1100)))?.code, 'too_large', 'over 2 MB refused');
    // Photo policy: with min 1 photo, one photo satisfies it (no exception needed).
    run('admin', { cmd: 'settings.config', outlet_id: OA, config: { ...ov().cfg, photos: { min: 1, max: 6, allow_exception: true } } }, at(1100));
    eq(caught(() => park('a1', sid, at(1100)))?.code, 'photo_exception_required', 'no photo yet → exception required');
    const r1 = md.storePhoto(db, ov(), A('a1'), { session_id: sid, position: 'damage', annotation: 'dent rear left', data: jpeg }, at(1101));
    eq(r1.count, 1, 'first photo stored');
    park('a1', sid, at(1102));
    eq(sess(sid).state, 'PARKED', 'policy met by the photo — parked without an exception');
    run('admin', { cmd: 'settings.config', outlet_id: OA, config: { ...ov().cfg, photos: { min: 0, max: 6, allow_exception: true } } }, at(1102));
    for (let i = 0; i < 5; i++) md.storePhoto(db, ov(), A('a1'), { session_id: sid, data: png }, at(1103));
    eq(caught(() => md.storePhoto(db, ov(), A('a1'), { session_id: sid, data: jpeg }, at(1104)))?.code, 'limit', 'a 7th photo refused');
    const row = db.prepare(`SELECT captured_by, position, annotation FROM valet_media WHERE id = ?`).get(r1.media_id) as any;
    eq([row.captured_by, row.position, row.annotation], [users.a1.id, 'damage', 'dent rear left'], 'who + position + note recorded');
    eq(md.readPhoto(db, OB, r1.media_id), null, 'another outlet cannot read it');
    // The route: attendant gets the bytes with no-store; the desk (host) cannot.
    const mr = require(path.join(WT, 'src/app/api/valet/media/route.ts'));
    (globalThis as any).__TOKEN = users.a1.token;
    const ok1 = await mr.GET(new Request(`http://localhost/api/valet/media?outlet=${OA}&id=${r1.media_id}`));
    ok(ok1.status === 200 && ok1.headers.get('content-type') === 'image/jpeg' && /no-store/.test(ok1.headers.get('cache-control') || ''), 'attendant reads the photo privately (no-store)');
    (globalThis as any).__TOKEN = users.host.token;
    const no = await mr.GET(new Request(`http://localhost/api/valet/media?outlet=${OA}&id=${r1.media_id}`));
    eq(no.status, 403, 'desk/host cannot open photos');
    (globalThis as any).__TOKEN = undefined;
    const anon = await mr.GET(new Request(`http://localhost/api/valet/media?outlet=${OA}&id=${r1.media_id}`));
    eq(anon.status, 401, 'signed-out request refused');
    const sid2 = checkin('a1', 'U2', at(1105));
    pk.voidSession(db, ov(), A('head'), sid2, sess(sid2).version, 'test record for photos', true, at(1105));
    eq(caught(() => md.storePhoto(db, ov(), A('a1'), { session_id: sid2, data: jpeg }, at(1106)))?.code, 'closed', 'no photos on a closed car');
  }

  // ═══════════════════════════════════════════════════════════════════════
  S('V reports');
  {
    const rp = require(path.join(WT, 'src/lib/valet/reports.ts'));
    // A fresh outlet so every figure can be worked out by hand.
    const OC = uid('zzoutc');
    db.prepare(`INSERT INTO outlets (id, name, is_default) VALUES (?, ?, 0)`).run(OC, `ZZ Report Outlet ${OC.slice(-4)}`);
    run('admin', { cmd: 'settings.enable', outlet_id: OC, enabled: true }, at(0));
    const ovC = () => core.loadOutletValet(db, OC);
    const zc = (run('admin', { cmd: 'zone.save', outlet_id: OC, name: 'C lot', kind: 'parking', capacity: 20, retrieval_minutes: 6 }, at(0)) as any).zone_id;
    mkUser('rc1', R_ATT); U.rc1 = await me('rc1');
    run('admin', { cmd: 'staff.assign', outlet_id: OC, user_id: users.rc1.id, assigned: true }, at(0));
    const D = (hm: string) => new Date(`2026-12-01T${hm}:00.000Z`);   // 2026-12-01 evening IST
    adm.shiftStart(db, ovC(), A('rc1'), D('13:00'));
    const car = (tag: string, test = false) => {
      const id = arr.checkinCreate(db, ovC(), A('rc1'), { plate: `TS09RP${tag}`, tag_code: tag, is_test: test }, D('14:00')).session_id;
      arr.parkConfirm(db, ovC(), A('rc1'), id, sess(id).version, { zone_id: zc, key_location: 'desk' }, D('14:01'));
      return id;
    };
    const cycle = (id: string, req: string, claim: string, start: string, ready: string, out: string, when = 'now', atIso?: string) => {
      const p = pk.requestPickup(db, ovC(), core.SYSTEM, { session_id: id, when, at: atIso }, 'guest', D(req)).pickup;
      queue.promoteDue(db, OC, D(claim));
      pk.assignPickup(db, ovC(), A('admin'), p.id, pick(p.id).version, users.rc1.id, '', D(claim));
      pk.startFetch(db, ovC(), A('rc1'), p.id, pick(p.id).version, D(start));
      pk.markReady(db, ovC(), A('rc1'), p.id, pick(p.id).version, {}, D(ready));
      const c = pk.issueHandoverCode(db, id, D(out));
      pk.handover(db, ovC(), A('rc1'), id, { tag_code: sess(id).tag_code, method: 'guest_code', code: c.code }, D(out));
    };
    cycle(car('C1'), '14:10', '14:11', '14:12', '14:20', '14:22');          // immediate: request→ready 10
    cycle(car('C2'), '14:30', '14:32', '14:33', '14:36', '14:40');          // immediate: 6
    cycle(car('C3'), '14:05', '15:24', '15:25', '15:28', '15:31', 'at', D('15:30').toISOString());   // booked 15:30, ready 15:28 → -2
    cycle(car('C4', true), '14:10', '14:11', '14:12', '14:59', '15:00');    // TEST car: must not count
    const r = rp.valetReport(db, { outletIds: [OC], from: '2026-12-01', to: '2026-12-01' });
    eq(r.totals.arrivals, 3, 'arrivals exclude the test car');
    eq([r.totals.immediate_requests, r.totals.scheduled_requests], [2, 1], 'immediate and booked counted apart');
    eq(r.times.request_to_ready, { n: 2, avg: 8, p90: 10, max: 10 }, 'request→ready (immediate only) = avg 8, p90 10, max 10 — worked by hand');
    eq(r.times.scheduled_lateness, { n: 1, avg: -2, p90: -2, max: -2 }, 'booked car ready 2 min early = -2');
    eq(r.times.retrieval_time, { n: 3, avg: 4.7, p90: 8, max: 8 }, 'fetch times 8, 3, 3 → avg 4.7 (14/3), p90 8, max 8 — worked by hand');
    eq(r.totals.handed_over, 3, 'handovers');
    eq(r.totals.peak_hour?.hour, 19, 'peak hour 19:00 IST (14:00 UTC check-ins)');
    ok(r.attendants.some((a: any) => a.name === users.rc1.name && a.parks === 3 && a.fetches === 3), 'per-attendant parks/fetches');
    // Shift-hours filter: 20:00–23:00 IST excludes 19:30 check-ins.
    eq(rp.valetReport(db, { outletIds: [OC], from: '2026-12-01', to: '2026-12-01', shiftFrom: '20:00', shiftTo: '23:00' }).totals.arrivals, 0, 'shift-hours filter applied');
    // CSV safety.
    eq(rp.csvCell('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`, 'formula neutralised in CSV');
    eq(rp.csvCell('-2'), `"'-2"`, 'a leading minus is neutralised too (documented)');
    ok(rp.reportCsv(r).includes('request_to_ready'), 'CSV carries the measures');
    // Route scoping: a head of outlet A cannot pull outlet C; 'all' = only own outlets.
    const rr = require(path.join(WT, 'src/app/api/valet/reports/route.ts'));
    (globalThis as any).__TOKEN = users.head.token;
    const denied = await rr.GET(new Request(`http://localhost/api/valet/reports?outlet=${OC}&from=2026-12-01&to=2026-12-01`));
    eq(denied.status, 403, 'head not assigned to outlet C → refused');
    const allRes = await (await rr.GET(new Request(`http://localhost/api/valet/reports?outlet=all&from=2026-12-01&to=2026-12-01`))).json();
    eq(allRes.totals.arrivals, 0, '"all" for this head covers only their outlets (none of C\'s cars)');
    (globalThis as any).__TOKEN = users.a1.token;
    eq((await rr.GET(new Request(`http://localhost/api/valet/reports?outlet=${OA}&from=2026-12-01&to=2026-12-01`))).status, 403, 'an attendant cannot open reports');
    (globalThis as any).__TOKEN = users.admin.token;
    const csvRes = await rr.GET(new Request(`http://localhost/api/valet/reports?outlet=${OC}&from=2026-12-01&to=2026-12-01&format=csv`));
    ok(csvRes.status === 200 && /text\/csv/.test(csvRes.headers.get('content-type') || ''), 'admin downloads CSV');
    (globalThis as any).__TOKEN = undefined;
  }

  // ═══════════════════════════════════════════════════════════════════════
  S('W paper tickets');
  {
    const pp = require(path.join(WT, 'src/lib/valet/ops-paper.ts'));
    const { entry_token } = adm.rotateEntryToken(db, OA, A('admin'), at(1200));
    const g1 = guest.guestAct(db, null, { cmd: 'checkin', e: entry_token, plate: 'KA01PP0001' }, '5.5.5.1', false, at(1200));
    const dev1 = guest.deviceFromCookie(db, String(g1.setCookie).split(';')[0].split('=')[1]);
    eq(caught(() => guest.guestAct(db, dev1, { cmd: 'paper', e: entry_token, ticket_no: 'P120' }, '5.5.5.1', false, at(1200)))?.code, 'paper_off', 'paper entry refused while paper mode is off');
    run('admin', { cmd: 'settings.config', outlet_id: OA, config: { ...ov().cfg, paper: { enabled: true } } }, at(1200));
    eq((run('head', { cmd: 'ticket_book.add', outlet_id: OA, prefix: 'P', first_no: 100, last_no: 150 }, at(1200)) as any).ok, true, 'ticket book registered');
    eq((run('head', { cmd: 'ticket_book.add', outlet_id: OA, prefix: 'P', first_no: 140, last_no: 160 }, at(1200)) as any).code, 'overlap', 'overlapping book refused');
    eq(caught(() => arr.checkinCreate(db, ov(), A('a1'), { plate: 'KA01PP0002', ticket_no: 'P999' }, at(1201)))?.code, 'ticket_unknown', 'ticket outside every book refused');
    const held = arr.checkinCreate(db, ov(), A('a1'), { plate: 'KA01PP0003', ticket_no: 'p-0120' }, at(1201)).session_id;
    eq(sess(held).ticket_no, 'P120', 'ticket canonicalised (p-0120 → P120)');
    eq(caught(() => arr.checkinCreate(db, ov(), A('a2'), { plate: 'KA01PP0004', ticket_no: 'P120' }, at(1202)))?.code, 'ticket_in_use', 'one active car per ticket');
    // Curbside done → guest's typed ticket is only a CLAIM; the pass needs the stub checked.
    const c1 = guest.guestAct(db, dev1, { cmd: 'paper', e: entry_token, ticket_no: 'P120', plate: 'KA01PP0003' }, '5.5.5.1', false, at(1203));
    eq(c1.body.kind, 'paper_claim', 'held ticket → a pending claim');
    eq(guest.guestState(db, dev1, at(1203)).passes.length, 0, 'a ticket number alone grants NOTHING');
    const g2 = guest.guestAct(db, null, { cmd: 'checkin', e: entry_token, plate: 'KA01PP0009' }, '5.5.5.2', false, at(1203));
    const dev2 = guest.deviceFromCookie(db, String(g2.setCookie).split(';')[0].split('=')[1]);
    eq(caught(() => guest.guestAct(db, dev2, { cmd: 'paper', e: entry_token, ticket_no: 'P120' }, '5.5.5.2', false, at(1203.5)))?.code, 'ticket_pending', 'a second phone cannot pile onto the same ticket');
    const found = arr.findPendingByCode(db, ov(), c1.body.pairing_code, at(1204));
    ok(found.source === 'paper_claim' && found.claim_tag !== undefined, 'staff see it is a paper claim');
    eq(caught(() => arr.checkinCreate(db, ov(), A('a1'), { request_id: found.id, tag_code: 'W9' }, at(1204)))?.code, 'use_claim', 'a claim cannot become a second check-in');
    eq((run('host', { cmd: 'paper.claim_confirm', outlet_id: OA, request_id: found.id }, at(1204)) as any).code, 'stub_required', 'stub must be ticked as checked');
    eq((run('host', { cmd: 'paper.claim_confirm', outlet_id: OA, request_id: found.id, stub_checked: true }, at(1205)) as any).session_id, held, 'desk confirms the stub');
    eq(guest.guestState(db, dev1, at(1206)).passes.map((p: any) => p.session_id), [held], 'only now the guest has the pass');
    // Curbside skipped → pending VERIFICATION; staff check in from it with the stub's ticket.
    const v1 = guest.guestAct(db, dev2, { cmd: 'paper', e: entry_token, ticket_no: 'P130', plate: 'KA01PP0010' }, '5.5.5.2', false, at(1207));
    eq(v1.body.kind, 'paper', 'unregistered ticket → verification request only');
    const f2 = arr.findPendingByCode(db, ov(), v1.body.pairing_code, at(1207));
    eq((run('host', { cmd: 'paper.claim_confirm', outlet_id: OA, request_id: f2.id, stub_checked: true }, at(1207)) as any).code, 'not_claim', 'verification is a check-in, not a claim');
    const newS = arr.checkinCreate(db, ov(), A('a2'), { request_id: f2.id, tag_code: 'W10' }, at(1208)).session_id;
    eq([sess(newS).ticket_no, sess(newS).checkin_source], ['P130', 'paper'], 'checked in under the stub\'s ticket');
    eq(guest.guestState(db, dev2, at(1209)).passes.length, 1, 'guest gets the pass after staff confirmed the car + stub');
    run('admin', { cmd: 'settings.config', outlet_id: OA, config: { ...ov().cfg, paper: { enabled: false } } }, at(1210));
  }

  S('X dining links');
  {
    const dn = require(path.join(WT, 'src/lib/valet/ops-dining.ts'));
    const mkTable = (outlet: string, no: string) => { const id = uid('zztbl'); db.prepare(`INSERT INTO restaurant_tables (id, outlet_id, table_number) VALUES (?,?,?)`).run(id, outlet, no); return id; };
    const mkOrder = (outlet: string | null, tableId: string | null, status = 'open', n = Math.floor(Math.random() * 900000) + 100000) => {
      const id = uid('zzord');
      db.prepare(`INSERT INTO orders (id, outlet_id, order_number, table_id, status, created_at) VALUES (?,?,?,?,?, datetime('now'))`).run(id, outlet, n, tableId, status);
      return id;
    };
    const T7 = mkTable(OA, 'X7'), T9 = mkTable(OA, 'X9'), T10 = mkTable(OA, 'X 10'), TAMB = mkTable(OA, 'X11');
    const TB7 = mkTable(OB, 'X7');
    const oldBill = mkOrder(OA, T7, 'settled');           // the previous guests on table X7
    const bill7 = mkOrder(OA, T7);                        // the current guests on X7
    const billB = mkOrder(OB, TB7);                       // same table number, other outlet
    const bill10 = mkOrder(OA, T10);
    mkOrder(OA, TAMB); mkOrder(OA, TAMB);                 // two open bills on one table (seen in the real data)
    const orphan = mkOrder(null, null);                   // a bill with no outlet recorded
    const car = arr.checkinCreate(db, ov(), A('a1'), { plate: 'KA01DN0001', tag_code: 'X71' }, at(1300)).session_id;
    const card = () => board.sessionDetail(db, ov(), car, 'head', at(1300)).card;

    eq((run('plain', { cmd: 'dining.link', outlet_id: OA, session_id: car, table: 'X7' }, at(1301)) as any).ok, false, 'a user with no valet capability cannot link');
    const l1 = run('host', { cmd: 'dining.link', outlet_id: OA, session_id: car, table: 'x7' }, at(1301)) as any;
    eq([l1.ok, (sess(car) as any).order_id], [true, bill7], 'by table → the CURRENT open bill, never the settled one before it, never outlet B\'s X7');
    eq(card().dining.table_number, 'X7', 'board card shows the table');
    // Table transfer: the POS keeps the order id and moves orders.table_id.
    db.prepare('UPDATE orders SET table_id = ? WHERE id = ?').run(T9, bill7);
    eq([card().dining.order_id, card().dining.table_number], [bill7, 'X9'], 'after a table transfer the link follows the guests (live table)');
    eq(board.deskLookup(db, ov(), 'X9', at(1302)).map((c: any) => c.id), [car], 'desk finds the car by its NEW table');
    eq(board.deskLookup(db, ov(), 'X7', at(1302)).length, 0, 'the old table no longer finds it');
    eq((run('host', { cmd: 'dining.link', outlet_id: OA, session_id: car, table: 'X7' }, at(1303)) as any).code, 'no_open_order', 'X7 now has only the settled bill → nothing to link (outlet B\'s X7 is never used)');
    eq((run('host', { cmd: 'dining.link', outlet_id: OA, session_id: car, order_id: oldBill }, at(1303)) as any).code, 'order_closed', 'a settled bill cannot be linked');
    eq((run('host', { cmd: 'dining.link', outlet_id: OA, session_id: car, order_id: billB }, at(1303)) as any).code, 'no_order', 'another outlet\'s bill is refused');
    eq((run('host', { cmd: 'dining.link', outlet_id: OA, session_id: car, order_id: orphan }, at(1303)) as any).code, 'no_order', 'a bill with no outlet is refused (fail closed)');
    eq((run('host', { cmd: 'dining.link', outlet_id: OA, session_id: car, table: 'X11' }, at(1303)) as any).code, 'ambiguous_table', 'two open bills on one table → refused, never a guess');
    const l2 = run('a2', { cmd: 'dining.link', outlet_id: OA, tag_code: 'x71', table: 'x10' }, at(1304)) as any;
    eq([l2.ok, (sess(car) as any).order_id], [true, bill10], 'attendant re-links by TAG; table match ignores case and spaces ("x10" = "X 10")');
    eq(dn.carsForOrder(db, OA, bill10).map((c: any) => c.id), [car], 'the bill lists its car');
    eq(dn.carsForOrder(db, OA, bill7).length, 0, 're-linking moved it off the old bill');
    db.prepare(`UPDATE orders SET status = 'merged' WHERE id = ?`).run(bill10);
    eq(card().dining.merged, true, 'a merged bill is flagged "merged — re-link" (documented limitation)');
    db.prepare(`UPDATE orders SET status = 'open' WHERE id = ?`).run(bill10);
    eq((sess(car) as any).state !== 'RETRIEVING' && !db.prepare(`SELECT 1 FROM valet_pickups WHERE session_id = ?`).get(car), true, 'linking never requests the car');

    // The cashier chip's route: silent for everyone who does not use valet here.
    const dr = require(path.join(WT, 'src/app/api/valet/dining/route.ts'));
    const get = async (key: string | null, order: string) => {
      (globalThis as any).__TOKEN = key ? users[key].token : undefined;
      const r = await dr.GET(new Request(`http://localhost/api/valet/dining?order=${encodeURIComponent(order)}`));
      return { status: r.status, body: await r.json() };
    };
    const asPlain = await get('plain', bill10);
    eq([asPlain.status, asPlain.body], [200, { show: false }], 'plain cashier → {show:false}, no error, nothing about the bill');
    const asHost = await get('host', bill10);
    eq([asHost.status, asHost.body.show, asHost.body.can_request, asHost.body.cars.map((c: any) => c.id)], [200, true, true, [car]], 'desk/host sees the car and may request');
    ok(!/guest_mobile|guest_name|mobile/.test(JSON.stringify(asHost.body.cars)), 'no guest contact in the chip payload');
    const asAtt = await get('a1', bill10);
    eq([asAtt.body.show, asAtt.body.can_request], [true, false], 'attendant sees it but gets no request button (pickup.request is a host action)');
    eq((await get('host', billB)).body, { show: false }, 'host not assigned to outlet B → {show:false}');
    eq((await get('host', 'no-such-order')).body, { show: false }, 'unknown bill → {show:false}');
    eq((await get(null, bill10)).status, 401, 'signed out → 401');
    (globalThis as any).__TOKEN = undefined;
    // The request itself still needs the guest's confirmation.
    eq((run('host', { cmd: 'pickup.request', outlet_id: OA, session_id: car, when: 'now' }, at(1305)) as any).code, 'confirm_required', 'cashier request needs the guest-asked tick');
    const rq = run('host', { cmd: 'pickup.request', outlet_id: OA, session_id: car, when: 'now', guest_confirmed: true, idempotency_key: `cashier:${car}:1` }, at(1305)) as any;
    eq(rq.ok, true, 'with the tick, the cashier can request the car');
    eq(dn.carsForOrder(db, OA, bill10)[0].pickup_state, rq.state, 'chip then shows it as requested');
    run('host', { cmd: 'dining.unlink', outlet_id: OA, session_id: car }, at(1306));
    eq([(sess(car) as any).order_id, (sess(car) as any).table_id], [null, null], 'unlink clears the link');
  }

  console.log(`\nVALET TESTS: ${pass} passed, ${fails.length} failed`);
  if (fails.length) { console.log(fails.map(f => ' - ' + f).join('\n')); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error('CRASHED:', e); process.exit(3); });
