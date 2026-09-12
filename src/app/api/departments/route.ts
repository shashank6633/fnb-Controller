import {
  getDb, generateId,
  DEPT_RECIPE_DEDUCTION_KEY, DEPT_RECIPE_DEDUCTION_SEED_KEY, DEPT_RECIPE_DEDUCTION_AUTO_KEY,
  DEPT_RECIPE_DEDUCTION_COLUMN, DEPT_RECIPE_DEDUCTION_AUTO,
  departmentsHaveRecipeDeductionColumn, canStoreRecipeDeductionFlag,
  departmentRecipeDeductionSidecar, departmentRecipeDeductionMap,
  departmentRecipeDeductionModes,
  departmentRecipeDeductionSettings, departmentsReachableFromStations,
} from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { canonNameInput } from '@/lib/name-canon';

/* ════════════════════════════════════════════════════════════════════════════
 * RECIPE DEDUCTION PER DEPARTMENT — the seed and the only writer
 * ════════════════════════════════════════════════════════════════════════════
 * The contract, the three values (1 / 0 / 2 = follow the till) and which rail
 * wins are documented once, in src/lib/db.ts above deductInventoryForSale. This
 * file owns the two things that must NEVER run on the consumption path: the
 * one-time seed, and the write.
 *
 * ── KNOWN GAP, OUTSIDE THIS LANE'S FOOTPRINT ────────────────────────────────
 * The sidecar key 'department_recipe_deduction_v1' is NOT registered in
 * KEY_POLICY in src/app/api/settings/route.ts, so the generic PUT /api/settings
 * — whose floor is admin OR MANAGER — will write it, while the PATCH below is
 * admin-only. Reading the COLUMN as authoritative (db.ts) makes that write inert
 * on every database the migration has reached, which is every normal
 * deployment. It does NOT help a database where the ALTER silently failed and
 * the sidecar is the only rail. The complete fix is one row in that table:
 *     ['department_recipe_deduction_v1',      { owner: '/api/departments' }],
 *     ['department_recipe_deduction_auto_v1', { owner: '/api/departments' }],
 * which makes the generic endpoint refuse the keys outright, for everyone.
 * settings/route.ts belongs to another lane; reported, not edited.
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 0/1 from a JSON body, undefined when the key is absent — and undefined for
 * anything else, which the handler turns into a 400.
 *
 * IT USED TO COERCE EVERYTHING ELSE TO 0. "yes", "ON", {} and [] all switched a
 * kitchen's deduction OFF and were answered 200 success. The only client sends a
 * real boolean, so nothing legitimate is refused by being strict — but a repair
 * script or a hand-rolled curl now hears "I did not understand that" instead of
 * silently stopping a kitchen from deducting.
 */
function deductFlag(v: unknown): 0 | 1 | undefined {
  if (v === true || v === 1 || v === '1' || v === 'true') return 1;
  if (v === false || v === 0 || v === '0' || v === 'false') return 0;
  return undefined;
}

/**
 * WRITE THE DECISION — to EVERY rail this database has, so the two can never
 * disagree and the OFF-wins merge in db.ts stays exact.
 *
 * Runs inside the caller's transaction. The sidecar is pruned against the live
 * departments table on every write (no is_active filter: DELETE here is a SOFT
 * delete, and pruning on inactive would silently reset a deactivated
 * department's decision to the enabled default when it came back).
 */
function writeRecipeDeductionFlag(
  db: ReturnType<typeof getDb>, values: Record<string, 0 | 1 | 2>,
): void {
  const hasCol = departmentsHaveRecipeDeductionColumn(db);
  if (hasCol) {
    const upd = db.prepare(`UPDATE departments SET ${DEPT_RECIPE_DEDUCTION_COLUMN} = ? WHERE id = ?`);
    for (const [id, v] of Object.entries(values)) upd.run(v, String(id));
  }
  try {
    const map = departmentRecipeDeductionSidecar(db);
    for (const [id, v] of Object.entries(values)) map[String(id)] = v;
    const live = new Set(
      (db.prepare('SELECT id FROM departments').all() as Array<{ id: string }>).map((r) => String(r.id)));
    const keep: Record<string, 0 | 1 | 2> = {};
    for (const [k, v] of Object.entries(map)) if (live.has(k)) keep[k] = v;
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(DEPT_RECIPE_DEDUCTION_KEY, JSON.stringify(keep));
  } catch (e) {
    // Only reachable when there is no settings table at all. The column has
    // already taken the value in that case AND the column is what every reader
    // consults, so the decision is in force and the sidecar is only the record
    // that would be handed over if the column were ever rebuilt. If NEITHER rail
    // exists the handler refused the request before getting here
    // (canStoreRecipeDeductionFlag), so a throw here on a column-less database
    // is a genuine failure to store and must reach the caller as one.
    console.error('[departments] recipe-deduction sidecar write failed', e);
    if (!hasCol) throw e;
  }
}

/**
 * THE ONE-TIME SEED — and it must be a NO-OP on the day it ships.
 *
 * It marks every department NOBODY HAS DECIDED ABOUT as "follow the till"
 * (DEPT_RECIPE_DEDUCTION_AUTO): deduct while a station routes there, record
 * through goods movement while none does. It writes no hard 0 and no hard 1, so
 * there is nothing for a later change of mind about stations to contradict.
 *
 * WHY THAT IS A NO-OP, provably: applyDeduct only ever asks about a department
 * resolveStationDepartment handed back, and that resolver reads
 * station_departments and nothing else — so a department it asks about is one
 * the till feeds, and "follow the till" answers DEDUCT, which is what this app
 * did before the switch existed. A department the till does not feed is
 * unreachable from every sale, so what is stored against it cannot change a
 * single deduction; it only changes what the screen SAYS about it.
 *
 * ── WHAT THIS REPLACED, AND WHY ─────────────────────────────────────────────
 * The first cut wrote a hard 1 for reachable departments and a hard 0 for the
 * rest, once, guarded — freezing the station map as it stood at the first signed-
 * in page load. MEASURED on a snapshot of the live database by driving the real
 * consumption path: seed today's map, then re-point the stations at the "Akan …"
 * departments (the mapping the hand-over brief documents as production) and
 * department debits go 24 → 0. Every kitchen silently stops deducting, on a
 * decision the owner never made, and the variance report suppresses the very
 * rows that would have shown it. The same shape, one department at a time, made
 * mapping a NEW station a silent two-step: the mapping worked and nothing
 * deducted, because the seed had written 0 against that department yesterday.
 *
 * ── WHAT IS STILL STICKY ────────────────────────────────────────────────────
 * An explicit 1 or 0 — a human moving the switch on /departments — is NEVER
 * re-derived by anything here. That half of the original guard was right.
 *
 * NOTHING IS SEEDED WHILE THE STATION MAP IS EMPTY. On a fresh install or a
 * schema-only restore, station_departments can hold no usable row at the moment
 * of the first signed-in GET; seeding then would describe every department as
 * "goods movement only" on the strength of a map that has not been filled in
 * yet. The flag is not written either, so the seed simply asks again next time.
 * (Under the old hard-0 seed this case was far worse than cosmetic: on a fresh
 * database it switched every department OFF permanently, and mapping a station
 * afterwards did not bring it back.)
 *
 * GUARDED BY ITS OWN FLAG KEY so it runs at most once. Same idiom as
 * station_dept_seed_v1 / price_basis_repair_v1, flag written inside the same
 * transaction as the data. Fail-soft: a seed that cannot run leaves every
 * department on the enabled default, which is precisely today's behaviour.
 */
function ensureRecipeDeductionSeed(db: ReturnType<typeof getDb>): void {
  try {
    if (!canStoreRecipeDeductionFlag(db)) return;
    const done = db.prepare('SELECT value FROM settings WHERE key = ?')
      .get(DEPT_RECIPE_DEDUCTION_AUTO_KEY) as { value?: string } | undefined;
    if (done) return;
    const all = (db.prepare('SELECT id FROM departments').all() as Array<{ id: string }>)
      .map((r) => String(r.id));
    if (all.length === 0) return;                 // nothing to decide about yet; ask again next time
    const reachable = departmentsReachableFromStations(db);
    if (reachable.size === 0) return;             // no usable station map yet; ask again next time
    // A database that ran the ORIGINAL hard-0/1 seed cannot tell that seed's
    // defaults from the owner's own edits by looking at a value alone — but it
    // can by comparing: right after that seed, every value equalled
    // (reachable ? 1 : 0), so anything that still does was never touched by a
    // human. On a database that never ran it, "never touched" is simply the
    // column default of 1. Either way an edited department keeps its decision.
    const legacy = !!(db.prepare('SELECT value FROM settings WHERE key = ?')
      .get(DEPT_RECIPE_DEDUCTION_SEED_KEY) as { value?: string } | undefined);
    const stored = departmentRecipeDeductionSettings(db);
    const untouched = (id: string): boolean =>
      Number(stored[id]) === (legacy ? (reachable.has(id) ? 1 : 0) : 1);
    const values: Record<string, 0 | 1 | 2> = {};
    for (const id of all) if (untouched(id)) values[id] = DEPT_RECIPE_DEDUCTION_AUTO as 0 | 1 | 2;
    const run = db.transaction(() => {
      if (Object.keys(values).length > 0) writeRecipeDeductionFlag(db, values);
      db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, '1')`)
        .run(DEPT_RECIPE_DEDUCTION_AUTO_KEY);
    });
    run();
    const followers = Object.keys(values).length;
    const deducting = all.filter((id) => reachable.has(id)).length;
    console.log(`[departments] ${DEPT_RECIPE_DEDUCTION_AUTO_KEY}: ${followers} department(s) now follow the `
      + `till (${deducting} of them are fed by a station today, so they deduct from recipes; the rest `
      + `record usage through goods movement until a station points at them). `
      + `${all.length - followers} department(s) keep a decision someone made by hand.`);
  } catch (e) {
    console.error(`${DEPT_RECIPE_DEDUCTION_AUTO_KEY} failed:`, e);
  }
}

/**
 * Which stations route to each department, for the screen — because "Bar" and
 * "Akan Bar" are two rows the owner cannot otherwise tell apart, and only one of
 * them is fed by the till. Active and paused are returned separately: a paused
 * mapping still counts as "this department is on the till" for the deduction
 * default (so un-pausing it does not need a second decision), but no sale
 * reaches it while it is paused, and the screen has to be able to say so.
 */
function stationsByDepartment(db: ReturnType<typeof getDb>): Map<string, { live: string[]; paused: string[] }> {
  const out = new Map<string, { live: string[]; paused: string[] }>();
  try {
    for (const r of db.prepare(`
      SELECT sd.station AS station, sd.department_id AS id, COALESCE(sd.is_active, 1) AS is_active
        FROM station_departments sd
        JOIN departments d ON d.id = sd.department_id
       WHERE sd.department_id IS NOT NULL AND TRIM(sd.department_id) <> ''
       ORDER BY sd.station
    `).all() as Array<{ station: string; id: string; is_active: number }>) {
      const k = String(r.id);
      if (!out.has(k)) out.set(k, { live: [], paused: [] });
      (Number(r.is_active) ? out.get(k)!.live : out.get(k)!.paused).push(String(r.station));
    }
  } catch (e) {
    console.error('[departments] station map unreadable', e);
  }
  return out;
}

// Disable any caching — the list changes immediately on import / edit and we want
// the browser to always see a fresh count.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Departments — Bar, Hot Kitchen, Cold Kitchen, Pastry, Bakery, etc.
 *
 * GET    /api/departments              → list (with member + open-req counts)
 * GET    /api/departments?id=X         → single
 * POST   /api/departments               admin-only
 *        body: { name, code?, description?, head_chef_user_id? }
 * PUT    /api/departments               admin-only
 *        409 when material_categories claims a category another MAIN department
 *        already owns (names the category and the owner; see the block below)
 * DELETE /api/departments?id=X          admin-only — soft-delete (is_active=0)
 */
export async function GET(request: Request) {
  try {
    // THIS GET HAD NO AUTHENTICATION OF ANY KIND while POST/PUT/DELETE below
    // are admin-only, and src/proxy.ts guards PAGES plus state-changing API
    // calls — its own comment says "GETs stay lenient; sensitive GETs
    // authenticate in-handler", and this one never did. It now does, for two
    // reasons: the department master is not public, and this handler runs the
    // one-time deduction seed below, which must not be triggerable by an
    // unauthenticated request. Every caller is a signed-in page doing a
    // same-origin fetch, so cookies ride along unchanged.
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    // Runs at most once in the life of this database (settings-flag guarded).
    ensureRecipeDeductionSeed(db);
    // The merged answer for every department — column and sidecar, OFF wins.
    // Merged in TypeScript onto BOTH shapes below: `SELECT d.*` picks the column
    // up on its own the day the migration lands, but a value that lives only in
    // the settings sidecar is not in `d.*` at all, and a single-department fetch
    // returning undefined would render as "off" — reading as a decision the
    // owner never made.
    const deductMap = departmentRecipeDeductionMap(db);
    // HOW each answer was reached, so the screen can say 'follows your station
    // mapping' instead of painting a derived value as the owner's own switch.
    // The gate never sees this — it branches on deductMap alone.
    const deductModes = departmentRecipeDeductionModes(db);
    const deductSupported = canStoreRecipeDeductionFlag(db);
    // Which stations feed which department — so the screen can stop making the
    // same promise on two rows only one of which the till can reach.
    const stationMap = stationsByDepartment(db);
    const stationsFor = (rowId: unknown) => {
      const s = stationMap.get(String(rowId)) || { live: [], paused: [] };
      return { mapped_stations: s.live, paused_stations: s.paused };
    };
    const id = new URL(request.url).searchParams.get('id');
    if (id) {
      const row = db.prepare(`
        SELECT d.*, u.name AS head_chef_name, u.email AS head_chef_email,
               hu.name AS head_user_name, hu.email AS head_user_email,
               p.name AS parent_name
        FROM departments d
        LEFT JOIN users u ON u.id = d.head_chef_user_id
        LEFT JOIN users hu ON hu.id = d.head_user_id
        LEFT JOIN departments p ON p.id = d.parent_id
        WHERE d.id = ?
      `).get(id);
      if (!row) return Response.json({ error: 'Not found' }, { status: 404 });
      return Response.json({
        department: {
          ...(row as Record<string, unknown>),
          [DEPT_RECIPE_DEDUCTION_COLUMN]: deductMap[String(id)] ?? 1,
          recipe_deduction_mode: deductModes[String(id)] ?? 'auto',
          ...stationsFor(id),
        },
        recipe_deduction_supported: deductSupported,
      });
    }
    const rows = db.prepare(`
      SELECT d.*,
             u.name  AS head_chef_name,
             u.email AS head_chef_email,
             hu.name  AS head_user_name,
             hu.email AS head_user_email,
             p.name  AS parent_name,
             (SELECT COUNT(*) FROM users WHERE department_id = d.id AND is_active = 1) AS member_count,
             (SELECT COUNT(*) FROM requisitions
               WHERE department_id = d.id
                 AND status NOT IN ('fulfilled', 'cancelled', 'chef_rejected')) AS open_requisition_count
      FROM departments d
      LEFT JOIN users u ON u.id = d.head_chef_user_id
      LEFT JOIN users hu ON hu.id = d.head_user_id
      LEFT JOIN departments p ON p.id = d.parent_id
      ORDER BY (d.parent_id IS NOT NULL), d.is_active DESC, d.name ASC
    `).all();
    console.log(`[/api/departments GET] returning ${(rows as any[]).length} departments`);
    return Response.json({
      departments: (rows as Array<Record<string, unknown>>).map((r) => ({
        ...r, [DEPT_RECIPE_DEDUCTION_COLUMN]: deductMap[String(r.id)] ?? 1,
        recipe_deduction_mode: deductModes[String(r.id)] ?? 'auto',
        ...stationsFor(r.id),
      })),
      recipe_deduction_supported: deductSupported,
    });
  } catch (e: any) {
    console.error('[/api/departments GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me || me.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });
    const db = getDb();
    const b = await request.json();
    if (!b.name || !String(b.name).trim()) {
      return Response.json({ error: 'name required' }, { status: 400 });
    }
    const id = generateId();
    db.prepare(`
      INSERT INTO departments (id, name, code, description, head_chef_user_id, head_user_id, parent_id, area, is_active, submission_windows, submission_grace_minutes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(id, String(b.name).trim(), b.code || '', b.description || '', b.head_chef_user_id || null,
            b.head_user_id || null, b.parent_id || null,
            String(b.area || '').trim(),
            String(b.submission_windows || '').trim(),
            b.submission_grace_minutes != null ? Number(b.submission_grace_minutes) : 30);
    const row = db.prepare('SELECT * FROM departments WHERE id = ?').get(id);
    return Response.json({ department: row }, { status: 201 });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me || me.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });
    const db = getDb();
    const b = await request.json();
    if (!b.id) return Response.json({ error: 'id required' }, { status: 400 });
    // RECIPE DEDUCTION IS DELIBERATELY NOT WRITABLE HERE — PATCH below is its
    // only writer. The edit modal sends `{ ...fetchedRow }`, so this body WILL
    // usually carry recipe_deduction_enabled; honouring it would let a form
    // opened before someone else flipped the switch quietly put it back on
    // save. Ignored, silently and on purpose.
    // material_categories: array of category names → JSON string. Empty array
    // or null clears the whitelist (= dept sees all materials).
    let matCatsJson: string | null | undefined;
    if (b.material_categories !== undefined) {
      if (Array.isArray(b.material_categories) && b.material_categories.length > 0) {
        /* ── A MATERIAL CATEGORY BELONGS TO EXACTLY ONE DEPARTMENT ──────────
         * Nothing refused an overlapping whitelist before, so two MAIN
         * departments could both claim "meat" (proven on a copy of the live
         * DB: Operations claiming Kitchen's "meat" saved 200) — and the PO
         * deviation router (src/lib/po-deviation-alert.ts) then cannot name a
         * single owner: it alerts EVERY claimant's heads and files a routing
         * gap for the admin on every such receipt. Refused at the ONLY door
         * that writes this column (this PUT; the POST above never binds it),
         * naming the clash and its owner so the fix is one screen away.
         *
         * The comparison key is the router's own fold (catKey =
         * trim().toLowerCase()) hardened with the invisible-character strip
         * (@/lib/name-canon) so a zero-width character cannot smuggle a
         * look-identical claim past this refusal. DEACTIVATED main departments
         * still count as owners — deactivation keeps the whitelist
         * (DELETE below is a soft-delete), reactivation is one tick, and this
         * check does not run on reactivation, so allowing the claim now would
         * plant a dormant collision. The 409 says so and names the remedy.
         * Checked against OTHER departments only (id <> b.id): re-saving a
         * department's own list is always legal. Measured on the live DB
         * 2026-09-02: zero collisions exist today, so nothing stored is
         * refused by this arriving.
         */
        const keyOf = (v: unknown) => canonNameInput(v).toLowerCase();
        const others = db.prepare(`
          SELECT id, name, is_active, material_categories
            FROM departments
           WHERE parent_id IS NULL AND id <> ?
        `).all(String(b.id)) as Array<{ id: string; name: string; is_active: number; material_categories: string | null }>;
        const ownerByCat = new Map<string, { id: string; name: string; is_active: number }>();
        for (const d of others) {
          try {
            const arr = JSON.parse(d.material_categories || '[]');
            if (Array.isArray(arr)) {
              for (const c of arr) {
                const k = keyOf(c);
                if (k && !ownerByCat.has(k)) ownerByCat.set(k, { id: d.id, name: d.name, is_active: d.is_active === null || d.is_active === undefined ? 1 : Number(d.is_active) });
              }
            }
          } catch { /* a malformed stored whitelist owns nothing — same reading as the router's */ }
        }
        for (const c of b.material_categories) {
          const k = keyOf(c);
          if (!k) continue;
          const owner = ownerByCat.get(k);
          if (owner) {
            const label = canonNameInput(c) || String(c);
            return Response.json({
              error: `Category "${label}" already belongs to ${owner.name}`
                + (owner.is_active ? '' : ' (a deactivated department — its whitelist still counts, because reactivating it is one tick)')
                + `. A material category can belong to exactly ONE department, or deviation alerts cannot name a single owner. `
                + `Nothing was saved. Remove "${label}" from ${owner.name}'s material list first, then add it here.`,
              conflict_category: label,
              conflict_department_id: owner.id,
              conflict_department: owner.name,
            }, { status: 409 });
          }
        }
        matCatsJson = JSON.stringify(b.material_categories);
      } else {
        matCatsJson = null;
      }
    }
    db.prepare(`
      UPDATE departments SET
        name              = COALESCE(?, name),
        code              = COALESCE(?, code),
        description       = COALESCE(?, description),
        area              = COALESCE(?, area),
        head_chef_user_id = ?,
        is_active         = COALESCE(?, is_active),
        submission_windows       = COALESCE(?, submission_windows),
        submission_grace_minutes = COALESCE(?, submission_grace_minutes),
        material_categories      = CASE WHEN ? = 1 THEN ? ELSE material_categories END,
        parent_id                = CASE WHEN ? = 1 THEN ? ELSE parent_id END,
        head_user_id             = CASE WHEN ? = 1 THEN ? ELSE head_user_id END,
        updated_at        = datetime('now')
      WHERE id = ?
    `).run(
      b.name ?? null, b.code ?? null, b.description ?? null,
      b.area ?? null,
      b.head_chef_user_id !== undefined ? b.head_chef_user_id : null,
      b.is_active != null ? (b.is_active ? 1 : 0) : null,
      b.submission_windows ?? null,
      b.submission_grace_minutes != null ? Number(b.submission_grace_minutes) : null,
      // CASE flag: 1 if caller explicitly sent material_categories, else 0 (keep old value)
      b.material_categories !== undefined ? 1 : 0,
      matCatsJson ?? null,
      // parent_id / head_user_id: CASE flag so they can be set OR cleared to NULL
      b.parent_id !== undefined ? 1 : 0,
      b.parent_id ?? null,
      b.head_user_id !== undefined ? 1 : 0,
      b.head_user_id ?? null,
      b.id,
    );
    const row = db.prepare('SELECT * FROM departments WHERE id = ?').get(b.id);
    return Response.json({ department: row });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

/**
 * PATCH /api/departments — the recipe-deduction switch, and NOTHING else.
 *   body: { id, recipe_deduction_enabled: boolean }
 *
 * Its own handler rather than a field on PUT, for a concrete reason: PUT binds
 * `head_chef_user_id = ?` bare, fed `b.head_chef_user_id !== undefined ? … :
 * null`, so a partial PUT that omits the HOD silently NULLs it. A one-field
 * toggle must not be able to wipe a department's approver. This touches exactly
 * one thing.
 *
 * AUTHORISATION IS CHECKED HERE, SERVER-SIDE, TWICE OVER. src/proxy.ts guards
 * PAGES, not APIs, and canAccessPage fails open in several ways, so the screen
 * being hidden is not a gate. Admin only — matching every other writer on this
 * route (POST/PUT/DELETE), which is stricter than isManagement() and is the
 * consistent floor for the department master.
 */
export async function PATCH(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me || me.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });
    const db = getDb();
    const b = await request.json();
    const id = String(b?.id || '').trim();
    if (!id) return Response.json({ error: 'id required' }, { status: 400 });
    const on = deductFlag(b?.recipe_deduction_enabled);
    if (on === undefined) {
      return Response.json({
        error: 'recipe_deduction_enabled must be true or false. Nothing was changed.',
      }, { status: 400 });
    }
    const dept = db.prepare('SELECT id, name FROM departments WHERE id = ?').get(id) as
      { id: string; name: string } | undefined;
    if (!dept) return Response.json({ error: 'Not found' }, { status: 404 });

    // ITS OWN CHECK, restated rather than inherited: the gate above is the
    // handler's, and a later edit that loosens it must not silently hand this
    // switch to a non-admin.
    if (me.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });

    // BOTH DIRECTIONS MATTER HERE, unlike the is_approximate precedent where
    // only turning the mark ON is refused. A switch-off this database cannot
    // store would leave the department deducting while the screen says it does
    // not — the exact silent gap this feature exists to close. So refuse
    // either way, in the owner's words.
    if (!canStoreRecipeDeductionFlag(db)) {
      return Response.json({
        error: 'This database cannot record which departments deduct from recipes, so the switch '
          + 'would show one thing and the kitchen would do another. Nothing was changed. Ask an '
          + 'admin to check the app’s settings table, then try again.',
      }, { status: 503 });
    }

    ensureRecipeDeductionSeed(db);
    // An explicit 1 or 0 — never DEPT_RECIPE_DEDUCTION_AUTO. Moving the switch IS
    // the decision, and from here on this department stops following the till.
    db.transaction(() => { writeRecipeDeductionFlag(db, { [id]: on }); })();

    // Reply with what was actually STORED, re-read from disk through the same
    // merge the consumption path uses — never with what the caller asked for.
    const stored = departmentRecipeDeductionMap(db)[id] ?? 1;
    return Response.json({
      success: true,
      department: { id, name: dept.name, [DEPT_RECIPE_DEDUCTION_COLUMN]: stored },
      recipe_deduction_supported: true,
    });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me || me.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });
    const db = getDb();
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return Response.json({ error: 'id required' }, { status: 400 });
    db.prepare(`UPDATE departments SET is_active = 0, updated_at = datetime('now') WHERE id = ?`).run(id);
    return Response.json({ success: true });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
