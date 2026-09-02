import type Database from 'better-sqlite3';
import { generateId } from './db';
import { sendWhatsAppTemplate } from './whatsapp';
import { mainDeptOf, type DeptRow } from './dept-hierarchy';

/* ══════════════════════════════════════════════════════════════════════════
 * ADDRESSING THE OFF-PO ALERT TO PEOPLE.
 *
 * ── THE DEFECT THIS CLOSES ─────────────────────────────────────────────────
 * Detection was never the problem. api/purchase-orders/[id]/receive already
 * classifies every line that came in differently from the approved PO (SHORT /
 * OVER / SHORT-ACCEPTED / RATE), values each one, and writes an audit_event and
 * a `notifications` row. What it does NOT do is address that row to anybody:
 *
 *     VALUES (?, ?, ?, 'inapp', 'admin', ?, ?)
 *                              ^^^^^^^
 * `'admin'` is a STRING LITERAL. It is not a user id, not an email, not a role
 * lookup, and nothing in the app ever resolved it into people. Measured on the
 * live database (2026-08-29): 17 rows, every one channel='inapp',
 * recipient='admin', and every one sent_at NULL — never sent, to nobody.
 *
 * This module turns that single unaddressed row into ONE ROW PER PERSON who
 * should have been told, and stamps sent_at when the row is actually there to be
 * read.
 *
 * ── WHAT IT DOES NOT TOUCH ─────────────────────────────────────────────────
 * DETECTION, THRESHOLDS AND WHAT COUNTS AS A DEVIATION ARE NOT MINE. The receive
 * route stays the single author of `deviationLines`; this module receives that
 * array and re-derives nothing from it except presentation. It also leaves the
 * ORIGINAL broadcast row exactly as it was — see "THE OTHER LANE" below.
 *
 * ── WHO IS TOLD (the owner's rule, verbatim) ───────────────────────────────
 * "raise an Alert to admin's and HOD's", and asked WHICH HODs: "only the
 * department the material belongs to".
 *
 *   · EVERY ACTIVE ADMIN, always. The effective tier is resolved the way
 *     getCurrentUser() resolves it — a named role's `base_role` wins over
 *     users.role — so an admin who holds the "Administrator" role row is found
 *     even though users.role still says 'manager'. qcNotifyRecipients() in
 *     grn-qc-notify.ts derives it the same way; an audience that disagreed with
 *     the session would alert a different set of people than the app calls
 *     admins.
 *   · THE HOD OF THE DEPARTMENT THE MATERIAL BELONGS TO, resolved
 *     material -> category -> the MAIN department whose `material_categories`
 *     whitelist contains that category -> that department's HEADS.
 *     This is the INVERSE of effectiveCategoriesForUser() in dept-hierarchy.ts
 *     (user -> main dept -> material_categories), read in the other direction.
 *     The same three rules are honoured and none are re-invented: only a MAIN
 *     department (parent_id IS NULL) carries categories, the column is a JSON
 *     array, and sub-departments inherit rather than own.
 *
 * ── "THE HOD" IS THREE FIELDS, NOT ONE. READ ALL THREE. ────────────────────
 * This alert originally read `departments.head_user_id` alone, and MEASURED on
 * the live database that column is empty on ALL 19 departments — so the HOD half
 * was dark 100% of the time while writing a sentence ("no head is set for
 * Kitchen") that reads like a configuration note. Three different screens all
 * legitimately mean "the HOD":
 *
 *   1. Departments -> "Department head (approves all requisitions…)"  head_user_id
 *   2. Departments -> "HOD (Head of Department)"                      head_chef_user_id
 *   3. Users/Roles -> the Head Chef flag or the Head Chef role        users.is_head_chef
 *
 * (3) is the app's own HOD gate everywhere else — page-catalog.ts, alert-audience.ts,
 * hr.ts, discount-requests.ts — and grn-qc-notify.ts, written for THE SAME problem
 * (tell the HOD a delivery landed), states it as a rule: head_user_id is
 * visibility-only, is_head_chef is what actually works. So all three are read, in
 * that order, and a person found by any of them is a head. (3) is attached to a
 * department the way userMainDept() attaches one — the user's own department_id
 * lifted to its MAIN department via mainDeptOf() — which is the inverse of the
 * same helper, not a second rule. A department may therefore have SEVERAL heads;
 * all of them are told.
 *
 * ── ONE PERSON, TWO DEPARTMENTS ────────────────────────────────────────────
 * A recipient carries a LIST of departments, not one. Deduping a head who runs
 * both Kitchen and Bar down to a single department dropped the other
 * department's lines on the floor — silently, chosen by PO line order — while the
 * receive response still reported that department as routed to them. Both
 * departments are legitimately theirs, so both sets of lines travel in their one
 * row and the tag reads "[Kitchen + Bar]".
 *
 * ── THE GAPS ARE STATED, NEVER SWALLOWED ───────────────────────────────────
 * A material whose category matches NO department, and a department with NO
 * active head, are BOTH normal states on this data — all 19 departments have an
 * empty head_user_id in the local snapshot. Neither may quietly drop the alert:
 * the admins still get it, and the unresolved half is written into the body in
 * as many words ("no head is set for Kitchen — nobody in that department was
 * told"). A silent drop here would rebuild the exact failure this work exists to
 * remove, one level further in.
 *
 * ── ONE ROW PER PERSON, ADMIN SCOPE WINS ───────────────────────────────────
 * A multi-line deviation can span departments, so there are two honest shapes:
 * one alert naming every department, or one per department carrying only its own
 * lines. BOTH, split by audience:
 *   · An ADMIN owns the whole vendor bill — the money is one bill and one net —
 *     so an admin gets ONE row carrying EVERY deviating line, with a footer
 *     saying which department each line was routed to and which could not be.
 *     Splitting the admin's copy per department would fragment one bill into N
 *     messages that each look like a smaller problem.
 *   · A HOD gets ONLY their own department's lines. The owner's answer was
 *     "only the department the material belongs to" and the Bar HOD has no
 *     business reading a fruit deviation, so bar lines and fruit lines never
 *     travel in the same body.
 * A person who is BOTH an admin and a department head is ONE recipient, not two:
 * the audience is deduped by user id and the admin (wider) scope wins, because
 * the admin copy already contains their department's lines. Two rows would be
 * the same news twice, and — since the row key is per person — the second would
 * have been silently swallowed by UNIQUE(party_unique_id, kind, channel) anyway.
 *
 * ── THE ROW SHAPE, AND WHY IT CANNOT REUSE THE BROADCAST KEY ───────────────
 * `notifications` carries UNIQUE (party_unique_id, kind, channel). The receive
 * route's broadcast row already occupies (`po:<poId>:grn:<grnId>`,
 * 'po_received_deviation', 'inapp'). Writing per-person rows under that same
 * tuple would not produce five rows — INSERT OR IGNORE would write the first and
 * SILENTLY DISCARD the rest, which is the same class of bug the route's own
 * comment records fixing when the key was still `po:<id>` and every vendor after
 * the first vanished. So a delivered copy is keyed:
 *
 *     kind             'po_received_deviation_user' | 'po_received_excess_user'
 *     party_unique_id  '<baseKey>:to:<userId>'      (baseKey from the caller)
 *     channel          'inapp'
 *     recipient        the user's EMAIL  <- what a bell filters a session by
 *     sent_at          set at insert
 *     delivery_meta    JSON { user_id, role, scope, department_id, ... }
 *
 * That tuple is unique per person per receipt, so the same receive replayed
 * writes nothing twice, and each person's row survives.
 *
 * RECIPIENT IS THE EMAIL, deliberately. It is the identity this codebase already
 * addresses people by — grn-qc-notify writes emails into this very column,
 * sendPushToUser takes an email, requisitions.drafted_by stores an email — and
 * users.email is UNIQUE, so `WHERE recipient = :email` is an exact match with no
 * LIKE and no substring collision. The user id travels in delivery_meta for a
 * reader that would rather filter on it.
 *
 * ── THE OTHER LANE (read this before changing the key) ─────────────────────
 * A separate lane is building the bell/inbox that READS these rows
 * (src/lib/po-deviation-alerts.ts — plural). It selects
 * `kind IN ('po_received_deviation','po_received_excess')` and then parses the
 * key with `^po:([^:]+):grn:([^:]+)(?::amend:(\d+))?$`, counting ONE alert per
 * matching row per GRN. The per-person kinds here are OUTSIDE that IN-list AND
 * the `:to:<userId>` suffix fails that regex — two independent reasons its badge
 * cannot double-count, so neither lane can inflate the other. The broadcast row
 * the route already writes is left byte-for-byte unchanged, which is what keeps
 * that badge working exactly as it does today.
 *
 * ── NEVER THROWS, NEVER BLOCKS ─────────────────────────────────────────────
 * Every export is fire-and-forget and swallows its own errors. The caller is
 * already past db.transaction() commit and already inside a try/catch that
 * swallows; this adds a second layer per stage so that a failure to resolve the
 * audience still lets the delivery run, and a failure to deliver still lets
 * WhatsApp log. A lost alert is bad; a rolled-back receipt is far worse.
 * ══════════════════════════════════════════════════════════════════════════ */

/** The two kinds a DELIVERED, ADDRESSED copy is written under. Exported so the
 *  bell lane can filter on the constant instead of retyping the strings. */
export const PO_DEVIATION_USER_KINDS = [
  'po_received_deviation_user',
  'po_received_excess_user',
] as const;

/** Arms the WhatsApp rail. NEVER seeded by db.ts — an absent key reads '' which
 *  is not '1', so the rail is off BY CONSTRUCTION and not by a default someone
 *  can flip by accident. Same discipline as WA_QC_EVENT_KEY. */
export const WA_PO_DEVIATION_EVENT_KEY = 'wa_notify_po_deviation';
/** The APPROVED template name + language. Meta permits only approved templates
 *  for business-initiated messages and no template exists for this alert, so the
 *  name is a SETTING with no default — this module must never invent one. */
export const WA_PO_DEVIATION_TEMPLATE_KEY = 'wa_po_deviation_template';
export const WA_PO_DEVIATION_TEMPLATE_LANG_KEY = 'wa_po_deviation_template_lang';
/** The slot inside the shared `wa_notify_recipients` JSON — READ ONLY, and only
 *  as a fallback. See WA_PO_DEVIATION_RECIPIENTS_KEY. */
export const WA_PO_DEVIATION_RECIPIENT_SLOT = 'po_deviation';
/**
 * THIS EVENT'S OWN RECIPIENT KEY, and why it does not live in the shared JSON.
 *
 * `setWaNotifyRecipients()` rebuilds the WHOLE `wa_notify_recipients` object from
 * `WA_NOTIFY_EVENTS` (src/lib/whatsapp.ts) and writes it back, so any save on
 * Settings -> WhatsApp -> Notifications for ANY unrelated event DELETES the slot
 * of an event that is not in that array. `po_deviation` is not in it — and adding
 * it is a change to another lane's file. That wipe is exactly the silent data
 * loss whatsapp.ts's own comment block records having already been burned by once
 * (it cost the QC rail its mobiles). A dedicated key cannot be rebuilt away by a
 * writer that does not know it exists, so the numbers are read from here first
 * and the shared slot is kept only as a fallback for anything already stored
 * there. Comma-separated or a JSON array; capped at 10 like every other event.
 */
export const WA_PO_DEVIATION_RECIPIENTS_KEY = 'wa_po_deviation_recipients';

/** One deviating line, exactly as the receive route built it. Structurally the
 *  route's own `deviationLines` element — mirrored, never re-derived. */
export interface DeviationAlertLine {
  material_name: string;
  material_id: string;
  /** PO line qty — PURCHASE units. */
  ordered: number;
  /** PURCHASE units. */
  received: number;
  /** PURCHASE units. */
  accepted: number;
  /** PURCHASE unit label, never the recipe unit. */
  unit_pu: string;
  ordered_rate: number;
  actual_rate: number;
  qty_short: boolean;
  qty_excess: boolean;
  rate_changed: boolean;
  acc_short: boolean;
  value_impact: number;
  reason: string;
}

export type AlertScope = 'admin' | 'department';

export interface DeviationRecipient {
  user_id: string;
  email: string;
  name: string;
  scope: AlertScope;
  /** EVERY main department this person heads that has lines on this receipt.
   *  Empty on an admin-scoped recipient. A list, not a single id: a person who
   *  heads two departments must read both departments' lines. */
  department_ids: string[];
  department_names: string[];
}

export interface DeptRouting {
  department_id: string;
  department_name: string;
  /** Every resolvable head of this department — head_user_id, the HOD selector,
   *  and the head chefs whose own department rolls up to it. Empty when none of
   *  the three resolves to an active user with an email. */
  heads: DeviationRecipient[];
  /** Why `heads` is empty — quoted into the body so the gap is never silent. */
  head_gap: string;
  lines: DeviationAlertLine[];
}

export interface DeviationAudience {
  admins: DeviationRecipient[];
  departments: DeptRouting[];
  /** Lines whose material category matched NO department whitelist. */
  unrouted: Array<{ material_name: string; category: string; line: DeviationAlertLine }>;
  /** Everyone who actually gets a row, deduped, admin scope winning. */
  recipients: DeviationRecipient[];
  /** Human-readable gaps, for the body and the caller's response. */
  gaps: string[];
}

const str = (v: unknown) => String(v ?? '');
const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
/** Trim + lowercase — the ONLY normalisation applied when matching a material's
 *  category against a department whitelist. Deliberately not fuzzy: a whitelist
 *  is an explicit admin choice and a near-match is a wrong match. */
const catKey = (v: unknown) => str(v).trim().toLowerCase();

/** Rupees with an explicit sign. A deviation figure without its sign is
 *  unreadable — "820" could be money gained or money lost. ZERO CARRIES NO SIGN:
 *  "+₹0" reads as a rise that did not happen. */
function money(n: number): string {
  const v = r2(n);
  const abs = Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  return v === 0 ? `₹${abs}` : `${v < 0 ? '-' : '+'}₹${abs}`;
}

/**
 * A quantity, printed to the precision the DETECTOR uses.
 *
 * The receive route flags a deviation at QTY_EPS = 1e-6, so anything printed at
 * a coarser precision can render a flagged, valued, stock-moving deviation as
 * "ordered 0.025 kg, received 0.025 kg / OVER by 0 kg" — the exact sentence the
 * owner asked for, saying nothing. 6dp matches the detector; trailing zeros are
 * dropped by Number(), so a whole 9 still prints "9".
 */
function qty(n: number): string {
  return String(Number((Number(n) || 0).toFixed(6)));
}

/** A per-unit rate. Grouped like money so it can be read beside it, and capped
 *  at 4dp so a computed rate does not arrive as ₹33.333333333333336. */
function rate(n: number): string {
  return `₹${(Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 4 })}`;
}

const setting = (db: Database.Database, key: string): string => {
  try {
    return str((db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as any)?.value);
  } catch { return ''; }
};

/* ────────────────────────────────────────────────────────────────────────────
 * COUNTS — THE FIGURES THAT CANNOT CANCEL
 * ──────────────────────────────────────────────────────────────────────────*/

export interface DeviationCountBreakdown {
  short: number; over: number; acc_short: number; rate: number; lines: number;
  /** Gross money that moved UP, and gross that moved DOWN. Split by the
   *  DIRECTION THE RUPEES WENT, not by axis: a short delivery at a doubled rate
   *  costs MORE, so bucketing its impact under "short" would file a cost rise as
   *  a saving. */
  above: number; below: number; net: number;
}

export function countDeviations(lines: DeviationAlertLine[]): DeviationCountBreakdown {
  const short = lines.filter(l => l.qty_short).length;
  const over = lines.filter(l => l.qty_excess).length;
  // Matches the receive route's own `acc_short && !qty_short` test, so a vendor
  // short is never ALSO counted as a short-accept and the totals stay honest.
  const acc_short = lines.filter(l => l.acc_short && !l.qty_short).length;
  const rate = lines.filter(l => l.rate_changed).length;
  let above = 0, below = 0;
  for (const l of lines) {
    const v = Number(l.value_impact) || 0;
    if (v > 0) above += v; else if (v < 0) below += v;
  }
  return { short, over, acc_short, rate, lines: lines.length, above: r2(above), below: r2(below), net: r2(above + below) };
}

/** "1 over, 1 short" — the phrase the owner's complaint hangs on. */
export function countsPhrase(c: DeviationCountBreakdown): string {
  const bits: string[] = [];
  if (c.over) bits.push(`${c.over} over`);
  if (c.short) bits.push(`${c.short} short`);
  if (c.acc_short) bits.push(`${c.acc_short} short-accepted`);
  if (c.rate) bits.push(`${c.rate} rate change${c.rate === 1 ? '' : 's'}`);
  return bits.join(', ');
}

/**
 * The money line. THE NET IS NEVER PRINTED ALONE — AND NEVER CLAIMS MORE THAN HAPPENED.
 *
 * This is the owner's actual complaint made structural: DRAGON FRUIT arrived
 * 9x over (+820) and THAI BIRD RED CHILLI never arrived at all (-820), and a
 * report that prints only the net says "0" about a bill with two serious
 * failures on it. The counts and the gross figures are built into the same string
 * as the net, so no caller can quote the net on its own.
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT DO ANY MORE:
 *  · It does not append "equal and opposite errors cancel here" to every alert.
 *    On the owner's own single-line dragon-fruit shape nothing cancels, and on
 *    today's data single-direction deviations are the common case — so the one
 *    clause the anti-net-hiding design rests on was false more often than true,
 *    and it told the reader to discount a net that was the whole correct story.
 *    The warning is now printed only when money actually moved BOTH ways, which
 *    is the only shape in which a net can hide anything.
 *  · It does not label these buckets with quantity words. They are bucketed by
 *    the DIRECTION THE RUPEES WENT (a short delivery at a doubled rate costs
 *    MORE), so calling them "over-billed / under-delivered" made a 12 kg receipt
 *    on a 10 kg order at a lower rate read "over-billed +₹0" — nothing
 *    over-billed, about two kilos nobody ordered. The quantity axes are the
 *    COUNTS, which lead the sentence; the money is described as money.
 */
export function impactPhrase(c: DeviationCountBreakdown): string {
  const counts = countsPhrase(c) || 'no quantity/rate axis flagged';
  const parts: string[] = [];
  if (c.above > 0) parts.push(`billed above PO ${money(c.above)}`);
  if (c.below < 0) parts.push(`billed below PO ${money(c.below)}`);
  if (!parts.length) return `${counts} · no value moved (net ₹0)`;
  const bothWays = c.above > 0 && c.below < 0;
  return `${counts} · ${parts.join(', ')}`
    + (bothWays
      ? ` (net ${money(c.net)} — READ THE PAIR, NOT THE NET: these moved in opposite`
        + ` directions and partly cancel each other out)`
      : '');
}

/* ────────────────────────────────────────────────────────────────────────────
 * WHO GETS TOLD
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * PROBE-ONLY SWITCH — passed by routingProbe() and by departmentAlertReadiness(),
 * NEVER by the real alert path.
 *
 * The resolvers below NEVER THROW on the alert path: a receipt already in the
 * books must still reach the admins even when the department side is broken, so
 * every internal failure is swallowed, logged, and stated as a gap. That is
 * deliberate crash-proofing and it stays exactly as it is — no caller that
 * omits this flag sees any change.
 *
 * The READINESS PROBE has the opposite contract. Its entire output is "what the
 * router just did on this database", and a swallowed exception makes that
 * output a LIE: an internal failure resolves to the empty audience, which the
 * readiness view can only read as "nobody is configured" — a calm, wrong,
 * actionable-looking answer ("Set 'Department head' on Settings ->
 * Departments") when the truth is "the probe itself failed and the answer is
 * UNKNOWN". MEASURED on a copy with the users table dropped: every department
 * read `reach: 'none'` with the full no-HOD remedy sentence and not one word
 * said anything had failed. So the probe passes `{ rethrow: true }` and the
 * same catch blocks that swallow for the alert path rethrow for it; the throw
 * surfaces as an explicit probe-failure state, never as advice.
 */
interface ResolveOpts {
  /** Rethrow internal failures instead of swallowing them. PROBE CALLERS ONLY. */
  rethrow?: boolean;
}

/**
 * Every ACTIVE admin, with the tier resolved the way the session resolves it.
 *
 * `roles.base_role` WINS over `users.role` when the user holds a named role —
 * the rule getCurrentUser() and proxy.ts both apply. Today no user has a
 * role_id, so this reads identically to `users.role = 'admin'`; the moment the
 * owner moves someone onto the "Administrator" role row it keeps working, and
 * an admin silently missing from an over-receipt alert is precisely the failure
 * being fixed.
 */
export function activeAdmins(db: Database.Database, opts?: ResolveOpts): { admins: DeviationRecipient[]; gaps: string[] } {
  const out: DeviationRecipient[] = [];
  const gaps: string[] = [];
  try {
    const rows = db.prepare(`
      SELECT u.id, u.email, u.name, u.role, u.role_id, r.base_role AS role_base
        FROM users u
        LEFT JOIN roles r ON r.id = u.role_id
       WHERE u.is_active = 1
    `).all() as any[];
    for (const row of rows) {
      const hasRole = !!row.role_id && !!row.role_base;
      const tier = (hasRole ? str(row.role_base) : str(row.role)) || 'staff';
      if (tier !== 'admin') continue;
      const email = str(row.email).trim();
      if (!email) {
        // An admin with no email cannot be addressed on this channel — but
        // dropping them without a word is the same silence this module exists to
        // remove, and a headless DEPARTMENT already gets a sentence. Say it.
        gaps.push(
          `${str(row.name) || `admin ${str(row.id)}`} is an active admin with no email address `
          + `— they could not be told; add an email on Settings -> Users`,
        );
        continue;
      }
      out.push({
        user_id: str(row.id),
        email,
        name: str(row.name) || email,
        scope: 'admin',
        department_ids: [], department_names: [],
      });
    }
  } catch (e) {
    if (opts?.rethrow) throw e; // probe mode: a failure here is a failed probe, not "no admins"
    console.error('[po-deviation-alert] admin lookup failed (non-fatal):', e);
  }
  return { admins: out, gaps };
}

/** A MAIN department (parent_id IS NULL) with its category whitelist parsed and
 *  both head columns kept. Inactive ones are LOADED — routing skips them, but a
 *  gap that said "that category is in no department's list" about a category
 *  that is plainly in Kitchen's list, when Kitchen is merely switched off,
 *  points the admin at the wrong screen. */
type MainDept = DeptRow & { cats: Set<string>; is_active: boolean; head_chef_user_id: string | null };

function mainDepartments(db: Database.Database, opts?: ResolveOpts): MainDept[] {
  const out: MainDept[] = [];
  try {
    // ORDER BY is not decoration: when two departments claim the same category
    // the first one wins, and "first" must not mean "whichever row SQLite
    // happened to store first", which a VACUUM or a schema change can reorder.
    const rows = db.prepare(`
      SELECT id, name, parent_id, head_user_id, head_chef_user_id, material_categories, is_active
        FROM departments
       WHERE parent_id IS NULL
       ORDER BY name COLLATE NOCASE, id
    `).all() as any[];
    for (const d of rows) {
      const cats = new Set<string>();
      try {
        const arr = JSON.parse(str(d.material_categories) || '[]');
        if (Array.isArray(arr)) for (const c of arr) { const k = catKey(c); if (k) cats.add(k); }
      } catch { /* a malformed whitelist routes nothing rather than throwing */ }
      out.push({
        id: str(d.id), name: str(d.name), parent_id: d.parent_id ?? null,
        head_user_id: d.head_user_id ?? null,
        head_chef_user_id: d.head_chef_user_id ?? null,
        material_categories: d.material_categories ?? null,
        is_active: d.is_active === null || d.is_active === undefined ? true : !!d.is_active,
        cats,
      });
    }
  } catch (e) {
    if (opts?.rethrow) throw e; // probe mode: a failure here is a failed probe, not "no departments"
    console.error('[po-deviation-alert] department lookup failed (non-fatal):', e);
  }
  return out;
}

/**
 * Every user the app would call a head chef, with the MAIN department their own
 * `department_id` rolls up to.
 *
 * The effective flag is derived the way getCurrentUser() derives it — the
 * per-user flag OR the named role's flag — so this can never disagree with the
 * gate the rest of the app uses for "is this person an HOD". The department is
 * attached through mainDeptOf(), the same lift userMainDept() performs; a head
 * chef with no department_id belongs to no department and is not a head of one.
 * Read ONCE per receipt and cached, not once per department.
 *
 * DEACTIVATED HEADS ARE READ TOO, into a SEPARATE map. They are never candidates
 * — a switched-off account cannot be told anything — but the difference between
 * "nobody holds this flag" and "the person who holds it is switched off" is the
 * difference between two remedies, and the admin is sent to the wrong screen if
 * the two collapse into one sentence. `head_user_id` already distinguishes them
 * ("… is deactivated"); reading only active rows here made the SAME fault
 * diagnose differently depending on which column happened to carry the person.
 */
interface HeadChefIndex {
  /** main department id -> ids of head chefs who can actually be told */
  active: Map<string, string[]>;
  /** main department id -> emails of head chefs who are switched off */
  inactive: Map<string, string[]>;
}
/**
 * "IS THIS PERSON A HEAD CHEF?" — ONE SQL FRAGMENT, NEVER TWO.
 *
 * The effective flag is the UNION of the per-user column and the assigned
 * role's column, exactly as getCurrentUser() derives it (auth.ts: `is_head_chef:
 * !!row.is_head_chef || (hasRole && !!row.role_head_chef)`). Anything that asks
 * the same question in its own words — a report, a readiness screen — will
 * eventually be edited on its own and start disagreeing with the alert that
 * actually fires. This codebase has already paid for that once: see the
 * "THE FIVE COPIES, and which one actually filters" note in
 * api/closing-stock/dept-sheet/route.ts, which records that the copies were NOT
 * byte-identical and that grepping the literal text missed the one that bit.
 *
 * Requires the query to alias `users` as u and `roles` as r.
 */
const HEAD_CHEF_FLAG_SQL =
  `(COALESCE(u.is_head_chef, 0) = 1 OR (u.role_id IS NOT NULL AND COALESCE(r.is_head_chef, 0) = 1))`;

function headChefsByMainDept(db: Database.Database, opts?: ResolveOpts): HeadChefIndex {
  const active = new Map<string, string[]>();
  const inactive = new Map<string, string[]>();
  try {
    const rows = db.prepare(`
      SELECT u.id, u.email, u.is_active, u.department_id, u.is_head_chef, u.role_id,
             r.is_head_chef AS role_head_chef
        FROM users u
        LEFT JOIN roles r ON r.id = u.role_id
       WHERE TRIM(COALESCE(u.department_id, '')) <> ''
         AND ${HEAD_CHEF_FLAG_SQL}
    `).all() as any[];
    for (const row of rows) {
      const main = mainDeptOf(db, str(row.department_id));
      if (!main) continue;
      const key = str(main.id);
      if (row.is_active) {
        const list = active.get(key) ?? [];
        list.push(str(row.id));
        active.set(key, list);
      } else {
        const list = inactive.get(key) ?? [];
        list.push(str(row.email) || str(row.id));
        inactive.set(key, list);
      }
    }
  } catch (e) {
    if (opts?.rethrow) throw e; // probe mode: a failure here is a failed probe, not "no head chefs"
    console.error('[po-deviation-alert] head-chef lookup failed (non-fatal):', e);
  }
  return { active, inactive };
}

/**
 * category key -> EVERY main department that claims it, in `mains` order.
 *
 * ONE BUILDER, shared by the alert path and the readiness view. A readiness
 * screen that built its own copy of this map would be free to drift into
 * telling the admin that a category is routed when the alert that actually
 * fires disagrees — which is the one thing a readiness screen must never do.
 * Extracted verbatim from resolveDeviationAudience(); same source array, same
 * catKey(), same insertion order, so the behaviour is unchanged.
 */
function claimantsByCategory(mains: MainDept[]): Map<string, MainDept[]> {
  const byCat = new Map<string, MainDept[]>();
  for (const d of mains) {
    for (const c of d.cats) {
      const list = byCat.get(c) ?? [];
      list.push(d);
      byCat.set(c, list);
    }
  }
  return byCat;
}

/**
 * EVERY head of a department, or none WITH the reason why.
 *
 * The three fields are read in the order the owner is most likely to have meant
 * them, and all three are honoured — see the module header for why reading only
 * `head_user_id` left this rail dark on every department in the live database.
 */
function headsOf(
  db: Database.Database,
  dept: MainDept,
  headChefs: HeadChefIndex,
  opts?: ResolveOpts,
): { heads: DeviationRecipient[]; gap: string } {
  const candidates: Array<{ id: string; via: string }> = [];
  const push = (id: unknown, via: string) => {
    const v = str(id).trim();
    if (v && !candidates.some(c => c.id === v)) candidates.push({ id: v, via });
  };
  push(dept.head_user_id, 'Department head');
  push(dept.head_chef_user_id, 'HOD');
  for (const id of headChefs.active.get(dept.id) ?? []) push(id, 'Head Chef');

  if (!candidates.length) {
    // THE FLAG IS SET; THE PERSON IS SWITCHED OFF. Telling an admin to "give
    // someone the Head Chef flag" when they already did sends them to a screen
    // that will look correct, and the real remedy — reactivate the account, or
    // hand the flag to someone else — never gets named.
    const off = headChefs.inactive.get(dept.id) ?? [];
    if (off.length) {
      return {
        heads: [],
        gap: `${dept.name}'s Head Chef (${off.join(', ')}) is deactivated `
          + `— nobody in ${dept.name} was told. Reactivate them on Settings -> Users, `
          + `or give someone else the Head Chef flag and a department under ${dept.name}`,
      };
    }
    return {
      heads: [],
      gap: `no HOD is resolvable for ${dept.name} — nobody in that department was told. `
        + `Set "Department head" or "HOD" on Settings -> Departments -> ${dept.name}, `
        + `or give someone the Head Chef flag and a department under ${dept.name}`,
    };
  }

  const heads: DeviationRecipient[] = [];
  const why: string[] = [];
  for (const c of candidates) {
    try {
      const u = db.prepare(`SELECT id, email, name, is_active FROM users WHERE id = ?`).get(c.id) as any;
      if (!u) { why.push(`${dept.name}'s ${c.via} no longer exists as a user`); continue; }
      if (!u.is_active) { why.push(`${dept.name}'s ${c.via} (${str(u.email)}) is deactivated`); continue; }
      if (!str(u.email).trim()) { why.push(`${dept.name}'s ${c.via} has no email address`); continue; }
      heads.push({
        user_id: str(u.id), email: str(u.email), name: str(u.name) || str(u.email),
        scope: 'department', department_ids: [dept.id], department_names: [dept.name],
      });
    } catch (e) {
      if (opts?.rethrow) throw e; // probe mode: a failed lookup is a failed probe, not "no head"
      console.error('[po-deviation-alert] head lookup failed (non-fatal):', e);
      why.push(`${dept.name}'s ${c.via} could not be looked up`);
    }
  }
  if (heads.length) return { heads, gap: '' };
  return { heads: [], gap: `${why.join('; ')} — nobody in ${dept.name} was told` };
}

/**
 * Resolve the whole audience for one receipt's deviating lines.
 *
 * NEVER THROWS on the alert path (opts omitted). On any failure it returns
 * whatever it managed to resolve; the admins are looked up first and
 * independently, so a department-side fault still leaves an audience rather
 * than none. With `opts.rethrow` — the READINESS PROBE, and nothing else —
 * internal failures are rethrown instead, because a probe whose failure
 * resolves to the empty audience reads as "nobody is configured", which is a
 * lie. See ResolveOpts.
 */
export function resolveDeviationAudience(
  db: Database.Database,
  lines: DeviationAlertLine[],
  opts?: ResolveOpts,
): DeviationAudience {
  const { admins, gaps: adminGaps } = activeAdmins(db, opts);
  const departments: DeptRouting[] = [];
  const unrouted: DeviationAudience['unrouted'] = [];
  const gaps: string[] = [...adminGaps];

  try {
    const mains = mainDepartments(db, opts);
    const headChefs = headChefsByMainDept(db, opts);
    // category -> EVERY department that claims it, in a deterministic order.
    //
    // AN OVERLAP ROUTES TO EVERY CLAIMANT, NOT TO THE FIRST ONE. This used to
    // take active[0] — the alphabetically first name — which has nothing to do
    // with which department owns the material: put "veg" on Bar's whitelist,
    // which the Departments UI permits and /api/departments does not validate,
    // and a DRAGON FRUIT deviation went to Bar while the Kitchen head, the
    // actual owner, was told NOTHING. Silence for the true owner is the worse
    // half of that trade; an extra copy for a department the admin has
    // explicitly declared owns the category is the cheaper one, and it is what
    // the whitelist says. The overlap is still stated as a gap, so the admin is
    // told to fix the configuration rather than left to live with it.
    // (Measured on the live data: 28 categories across 3 active mains, ZERO
    // collisions — so this changes nothing about any receipt that can happen
    // today, and only differs where the old code was provably wrong.)
    const byCat = claimantsByCategory(mains);

    // Material categories for exactly the deviating lines.
    const ids = [...new Set(lines.map(l => str(l.material_id)).filter(Boolean))];
    const catById = new Map<string, string>();
    if (ids.length) {
      const rows = db.prepare(
        `SELECT id, category FROM raw_materials WHERE id IN (${ids.map(() => '?').join(',')})`,
      ).all(...ids) as any[];
      for (const m of rows) catById.set(str(m.id), str(m.category));
    }

    const routing = new Map<string, DeptRouting>();
    const catNoted = new Set<string>();
    for (const line of lines) {
      const cat = catById.get(str(line.material_id)) ?? '';
      const key = catKey(cat);
      const claimants = byCat.get(key) ?? [];
      const active = claimants.filter(d => d.is_active);
      if (!active.length) {
        unrouted.push({ material_name: line.material_name, category: cat, line });
        // Say which of the two different holes this is. "In no department's
        // material list" about a category that IS in Kitchen's list, when
        // Kitchen is merely switched off, sends the admin to the wrong screen.
        if (!catNoted.has(key)) {
          catNoted.add(key);
          if (claimants.length) {
            gaps.push(
              `category "${cat || '(none)'}" belongs to ${claimants.map(d => d.name).join(' / ')}, `
              + `but that department is DEACTIVATED — no HOD could be told, so only the admins were`,
            );
          }
        }
        continue;
      }
      if (active.length > 1 && !catNoted.has(key)) {
        catNoted.add(key);
        gaps.push(
          `category "${cat}" is claimed by ${active.map(d => d.name).join(' and ')}; `
          + `every one of them was told, because picking one would have left the true owner in the dark `
          + `— remove it from one whitelist on Settings -> Departments`,
        );
      }
      for (const dept of active) {
        let r = routing.get(dept.id);
        if (!r) {
          const { heads, gap } = headsOf(db, dept, headChefs, opts);
          r = { department_id: dept.id, department_name: dept.name, heads, head_gap: gap, lines: [] };
          routing.set(dept.id, r);
        }
        r.lines.push(line);
      }
    }
    // BY NAME, NOT BY PO LINE ORDER. Everything load-bearing was already order-
    // invariant, but the department order leaked into the merged recipient's tag
    // ("[Kitchen + Bar]" vs "[Bar + Kitchen]"), into the admin footer and into
    // the order of the head gaps — so the same receipt read two ways depending
    // on which material the buyer happened to type first.
    departments.push(...[...routing.values()].sort(
      (a, b) => a.department_name.localeCompare(b.department_name) || a.department_id.localeCompare(b.department_id),
    ));

    for (const d of departments) if (!d.heads.length) gaps.push(d.head_gap);
    // ONE SENTENCE PER MATERIAL, not per LINE. The overlap and deactivated-
    // department gaps above are deduped by `catNoted`; this loop was not, so the
    // same material on two PO lines produced two literally identical sentences
    // in `gaps` and in the admin body. Two DIFFERENT unrouted materials still
    // produce two different sentences — the key carries the material.
    const unroutedNoted = new Set<string>();
    for (const u of unrouted) {
      const claimed = (byCat.get(catKey(u.category)) ?? []).length > 0;
      if (claimed) continue; // already explained as a deactivated department
      const uKey = `${str(u.material_name)}|${catKey(u.category)}`;
      if (unroutedNoted.has(uKey)) continue;
      unroutedNoted.add(uKey);
      gaps.push(
        `${u.material_name} is filed under category "${u.category || '(none)'}", which is in no department's material list `
        + `— no HOD could be identified, so only the admins were told`,
      );
    }
  } catch (e) {
    // PROBE MODE ONLY: swallowing here would hand the probe an empty audience
    // it cannot tell apart from "no departments are configured". The real alert
    // path never sets the flag and keeps the swallow below — crash-proofing for
    // a receipt that is already in the books.
    if (opts?.rethrow) throw e;
    console.error('[po-deviation-alert] audience resolution failed (non-fatal):', e);
    gaps.push('department routing could not be computed for this receipt — only the admins were told');
  }

  // ONE ROW PER PERSON. Admins are seeded first so that a head who is also an
  // admin keeps the WIDER admin copy (which already carries their lines) rather
  // than a department-scoped one.
  //
  // A HEAD OF TWO DEPARTMENTS IS STILL ONE PERSON, BUT NOT ONE DEPARTMENT.
  // The row key is per person, so they get one row — and their departments are
  // MERGED into it rather than the second one being dropped. Dropping it was
  // silent, chosen by whichever material happened to sit first on the purchase
  // order, and the receive response still named them as the Bar line's routing
  // target while their copy carried only Kitchen.
  const recipients: DeviationRecipient[] = [];
  const byUser = new Map<string, DeviationRecipient>();
  for (const a of admins) {
    const k = a.user_id || a.email.toLowerCase();
    if (byUser.has(k)) continue;
    byUser.set(k, a); recipients.push(a);
  }
  for (const d of departments) {
    for (const head of d.heads) {
      const k = head.user_id || head.email.toLowerCase();
      const existing = byUser.get(k);
      if (!existing) { byUser.set(k, head); recipients.push(head); continue; }
      // An admin copy already carries EVERY line, so it is a superset of any
      // department copy and nothing is merged into it.
      if (existing.scope === 'admin') continue;
      if (!existing.department_ids.includes(d.department_id)) {
        existing.department_ids.push(d.department_id);
        existing.department_names.push(d.department_name);
      }
    }
  }
  if (!admins.length) gaps.push('no active admin user could be resolved — this alert reached nobody at admin level');

  return { admins, departments, unrouted, recipients, gaps };
}

/* ────────────────────────────────────────────────────────────────────────────
 * READINESS — "IF A DEVIATION HAPPENED RIGHT NOW, WHO WOULD ACTUALLY HEAR?"
 *
 * Everything above answers that question ONE RECEIPT AT A TIME, after the money
 * has already moved, in an email nobody reads until something has gone wrong.
 * The gaps it writes ("no HOD is resolvable for Kitchen") are the truth, but
 * they arrive attached to a deviation that has already happened, addressed to
 * the admins — the very people who were told; the head who was NOT told, by
 * definition, receives nothing, including the notice that they receive nothing.
 *
 * This function asks the same question with no receipt in hand, so the answer
 * can be read on a screen BEFORE the first deviation instead of inferred from
 * the silence after it.
 *
 * IT ASKS THE ROUTER; IT DOES NOT MODEL THE ROUTER. routingProbe() below feeds
 * one hypothetical deviating line per live item category straight into
 * resolveDeviationAudience() — the SAME function a real receipt calls — and the
 * per-department verdict is read out of that run's own `departments` and
 * `recipients`. If this screen says "Bar is covered", it is because the code
 * that addresses the real alert addressed a department-scope copy to a named
 * person on this very database, seconds ago.
 *
 * ── WHY THAT, AND NOT "does the department have a head?" ───────────────────
 * The first version of this function answered with headsOf() alone and let the
 * view tick green on `heads.length > 0`. MEASURED: with Bar's head correctly
 * configured, THREE independent one-click configuration states —
 * `departments.is_active = 0` (the plain Archived checkbox in the Departments
 * edit modal), `material_categories = '[]'`, and a whitelist naming a category
 * no item carries — each left `heads` non-empty while a real
 * raiseDeviationAlert() on that department's own category wrote ZERO
 * department-scope notification rows. The screen printed a green tick and the
 * recipient's name and email; the recipient was told nothing. A safety
 * indicator that is confidently wrong is worse than no indicator, because the
 * admin stops looking. Heads are still shown — a head configured behind a
 * blocker is worth naming — but a head can no longer make anything green:
 * `reach` is decided by the router, and only the router.
 *
 * IT ALSO REPORTS THE ONE GAP THE ALERT PATH STRUCTURALLY CANNOT.
 * headChefsByMainDept() opens with `WHERE TRIM(COALESCE(u.department_id,'')) <> ''`.
 * Somebody holding the Head Chef flag with NO department is removed by that
 * WHERE clause before headsOf() ever sees them, so no gap sentence can be
 * attached to them — the alert can say "Kitchen has no head", but it can never
 * say "and by the way, the person who believes they ARE the head is wired to no
 * department and receives nothing anywhere." Measured on the 2026-08-28
 * snapshot, TWO active accounts are in exactly that state. Both happen to also
 * be admins, so they still get the admin copy today and the fault is invisible;
 * the first non-admin put in that state is silently dark forever. This is the
 * only place that fact can surface.
 * ──────────────────────────────────────────────────────────────────────────*/

/** How a resolved head was found. LABEL ONLY — the SET of heads comes from
 *  headsOf(); this just re-reads which column carried the id it returned, in
 *  the same precedence order headsOf() pushes candidates. It cannot add or
 *  remove a recipient, so it cannot make the view claim someone is reachable. */
export type HeadVia = 'Department head' | 'HOD' | 'Head Chef flag';

export interface ReadinessHead {
  user_id: string;
  email: string;
  name: string;
  via: HeadVia;
}

/**
 * WHAT THE ROUTER WOULD ACTUALLY DO FOR THIS DEPARTMENT — the single fact any
 * covered/uncovered indicator is allowed to key off.
 *
 *   'department'  a deviation on one of this department's OWN items addresses a
 *                 DEPARTMENT-SCOPE copy to a named person. Proven by running
 *                 resolveDeviationAudience() and finding that recipient row.
 *                 THE ONLY STATE THAT MAY RENDER AS COVERED.
 *   'admin-only'  routing does reach the department and does resolve a head,
 *                 but every head is also an admin, so the single row they get is
 *                 the WIDER admin copy (which carries every line, theirs
 *                 included) and no department-scope row is written. They ARE
 *                 told — saying "nobody would be told" here would be the same
 *                 confident lie pointing the other way — but the department rail
 *                 is not what tells them, and the next head who is not an admin
 *                 inherits whatever is really wired here.
 *   'none'        nobody in this department is told anything on this rail.
 *   'unknown'     THE PROBE ITSELF FAILED, so none of the above is proven —
 *                 in either direction. Must render as an ERROR, never as
 *                 covered, and never as a calm "no heads configured": the
 *                 remedy sentences the other states carry would send the admin
 *                 to a configuration screen for a fault that is not
 *                 configuration. Only ever set when AlertReadiness.probe_error
 *                 is set, and then on EVERY department.
 */
export type DeptReach = 'department' | 'admin-only' | 'none' | 'unknown';

export interface DeptReadiness {
  department_id: string;
  department_name: string;
  is_active: boolean;
  /** The whitelist as the admin wrote it — NOT normalised, so the screen shows
   *  the same spelling the Departments editor shows. */
  categories: string[];
  /** How many of those categories any live raw material is actually filed under.
   *  A whitelist of categories nothing is filed under routes nothing. */
  categories_with_items: number;
  /** The heads the ROUTER resolved for this department when it consults it, or
   *  — when it never consults this department at all — who WOULD have resolved
   *  had it got that far. ADVISORY IN THAT SECOND CASE, and it cannot change
   *  `reach`: a non-empty list here alongside `reach: 'none'` means exactly
   *  "somebody is configured and it still makes no difference". */
  heads: ReadinessHead[];
  /** When no head resolves, the EXACT sentence the real alert would print.
   *  Empty string when somebody resolves. */
  gap: string;
  /** Reasons a deviation would never reach this department even if a head IS
   *  resolved above — routing stops before the head is ever consulted. */
  blockers: string[];
  /** THE ANSWER. Read out of a real resolveDeviationAudience() run over one
   *  hypothetical deviating line per live item category (routingProbe), so it
   *  is what the alert path does, not what a second implementation of the rule
   *  predicts it does. The ONLY field an indicator may colour on. */
  reach: DeptReach;
  /** One sentence saying what that run decided, in the router's own words —
   *  including its own gap sentence when a head could not be resolved. Always
   *  populated, for every value of `reach`. */
  verdict: string;
}

export interface InvisibleHeadChef {
  user_id: string;
  email: string;
  name: string;
  is_active: boolean;
  /** Why the alert path cannot place this person in any department. */
  reason: string;
  /** TRUE when this person is ALSO an active admin, and so still receives the
   *  admin copy of every deviation. Saying "they are told nothing" about an
   *  admin would be false, and a screen that overstates one fault gets
   *  disbelieved about the ones it has right. It also explains why this has
   *  never been noticed: on the live database both unplaced head chefs are
   *  admins, so the hole is real but currently masked. */
  also_admin: boolean;
}

export interface AlertReadiness {
  /** Everyone who gets the admin copy of EVERY deviation, whatever routes. */
  admins: DeviationRecipient[];
  /** Admins the alert path had to drop, with the reason (e.g. no email). */
  admin_gaps: string[];
  departments: DeptReadiness[];
  /** Categories live materials are filed under that no ACTIVE main department
   *  claims. A deviation on one of these reaches the admins and NO head. */
  unclaimed_categories: Array<{
    category: string;
    material_count: number;
    /** Non-empty when the category IS claimed, but only by a deactivated
     *  department — a different fault with a different remedy. */
    claimed_by_inactive: string[];
  }>;
  /** Categories claimed by MORE THAN ONE active main department. Every claimant
   *  is told (see resolveDeviationAudience), which is deliberate, but the
   *  overlap is a configuration mistake worth naming. */
  contested_categories: Array<{ category: string; departments: string[] }>;
  /** People the app calls head chefs whom the ALERT PATH CANNOT SEE AT ALL. */
  invisible_head_chefs: InvisibleHeadChef[];
  /** Non-fatal failures while computing the above. Never thrown. */
  errors: string[];
  /** Set ONLY when the routing probe itself failed — the exception's own
   *  message. When present, every department's `reach` is 'unknown' and
   *  NOTHING in this payload proves coverage either way; the view must render
   *  a broken/red state, not a checklist. ABSENT (not empty) on a healthy run,
   *  so a healthy response is byte-identical to one from before this field
   *  existed. */
  probe_error?: string;
}

/**
 * ONE HYPOTHETICAL RECEIPT, PUT THROUGH THE REAL ROUTER.
 *
 * Builds one deviating line per DISTINCT live item category — the widest
 * receipt that could ever exist on this catalogue — and hands it to
 * resolveDeviationAudience(). Whatever that returns is, by construction, what a
 * real receipt touching any of those categories would return: same function,
 * same handle, same instant. So "would Bar be told?" stops being a prediction
 * and becomes a lookup in `audience.recipients`.
 *
 * READ-ONLY. resolveDeviationAudience() issues SELECTs and nothing else — no
 * INSERT, no UPDATE, no notifications row — which is what makes it safe to run
 * from a GET. Delivery lives in deliverInApp(), which this never calls.
 *
 * ONE LINE PER CATEGORY, NOT PER MATERIAL: routing keys on the material's
 * category, so a second material in the same category cannot change any
 * department's answer, and the catalogue has ~1,000 materials across 29
 * categories. MIN(id) rather than an arbitrary row so two runs a second apart
 * cannot disagree.
 *
 * NEVER THROWS — but it no longer trusts a return value alone, either.
 * resolveDeviationAudience() is called with `{ rethrow: true }` because on the
 * alert path it SWALLOWS its own exceptions and returns whatever it managed to
 * resolve — deliberate crash-proofing there, but fatal to a probe: an internal
 * failure came back as the empty audience, indistinguishable from "nobody is
 * configured", and the readiness view printed the no-HOD remedy sentence for
 * every department while the truth was that the probe itself had failed.
 * With the flag set, any internal failure lands in the catch below and is
 * returned as `error`. A null audience therefore means THE PROBE FAILED — the
 * answer is UNKNOWN, and every caller must render that as an error state:
 * never as covered, never as "no heads yet".
 */
function routingProbe(db: Database.Database): { audience: DeviationAudience | null; categories: number; error: string } {
  try {
    const rows = db.prepare(`
      SELECT MIN(id) AS id, MIN(name) AS name, category
        FROM raw_materials
       GROUP BY category
    `).all() as any[];
    const lines: DeviationAlertLine[] = [];
    for (const r of rows) {
      const id = str(r.id).trim();
      if (!id) continue;
      // The numbers are never read by the routing half — resolveDeviationAudience
      // looks at material_id alone — but they are filled in honestly rather than
      // left at zero so that anything which later inspects a probe line sees a
      // coherent over-receipt rather than a malformed one.
      lines.push({
        material_name: str(r.name) || id,
        material_id: id,
        ordered: 1, received: 2, accepted: 2, unit_pu: 'unit',
        ordered_rate: 0, actual_rate: 0,
        qty_short: false, qty_excess: true, rate_changed: false, acc_short: false,
        value_impact: 0, reason: 'routing readiness probe',
      });
    }
    return { audience: resolveDeviationAudience(db, lines, { rethrow: true }), categories: lines.length, error: '' };
  } catch (e) {
    console.error('[po-deviation-alert] readiness: routing probe failed:', e);
    return { audience: null, categories: 0, error: str((e as any)?.message || e) || 'unknown error' };
  }
}

/**
 * NEVER THROWS. Same contract as resolveDeviationAudience: a fault in one
 * section still leaves the rest readable, because a readiness screen that goes
 * blank on an edge case teaches the admin to stop trusting it. It FAILS CLOSED:
 * anything it could not prove is reported as uncovered, never as covered — and
 * when the PROBE ITSELF fails, as `reach: 'unknown'` with `probe_error` set,
 * never as a calm "no heads configured" whose remedy sentence would send the
 * admin to a configuration screen for a fault that is not configuration.
 */
export function departmentAlertReadiness(db: Database.Database): AlertReadiness {
  const { admins, gaps: adminGaps } = activeAdmins(db);
  const departments: DeptReadiness[] = [];
  const unclaimed: AlertReadiness['unclaimed_categories'] = [];
  const contested: AlertReadiness['contested_categories'] = [];
  const invisible: InvisibleHeadChef[] = [];
  const errors: string[] = [];

  let mains: MainDept[] = [];
  let headChefs: HeadChefIndex = { active: new Map(), inactive: new Map() };
  try {
    // rethrow: without it these two swallow internally and return empty — so
    // this catch could never fire and a dead departments table read as "no main
    // departments exist". A READINESS caller wants the failure named.
    mains = mainDepartments(db, { rethrow: true });
    headChefs = headChefsByMainDept(db, { rethrow: true });
  } catch (e) {
    console.error('[po-deviation-alert] readiness: department/head lookup failed:', e);
    errors.push('departments / the head-chef index could not be read — this list is incomplete');
  }

  // Which categories any LIVE material is actually filed under. A whitelist
  // entry nothing is filed under is not a routing target, and a category on a
  // material that no whitelist mentions is a hole.
  const liveCats = new Map<string, number>();
  try {
    const rows = db.prepare(
      `SELECT category, COUNT(*) AS n FROM raw_materials GROUP BY category`,
    ).all() as any[];
    for (const r of rows) {
      const k = catKey(r.category);
      liveCats.set(k, (liveCats.get(k) ?? 0) + (Number(r.n) || 0));
    }
  } catch (e) {
    console.error('[po-deviation-alert] readiness: material category scan failed:', e);
    errors.push('item categories could not be read — the unrouted-category list is incomplete');
  }

  const byCat = claimantsByCategory(mains);

  // ── THE ROUTER'S OWN ANSWER, NOT A MODEL OF IT ──────────────────────────
  // Everything below that decides covered / not covered reads out of THIS run.
  const { audience: probe, categories: probeCategories, error: probeError } = routingProbe(db);
  if (!probe) {
    errors.push(
      `THE ROUTING PROBE ITSELF FAILED (${probeError}) — whether anyone would be told is UNKNOWN. `
      + `Every department below is marked unknown: not proven covered, and NOT "no heads configured"`,
    );
  }
  /** department id -> the routing entry the real alert built for it. Absent =
   *  the router never consults this department, whatever its heads say. */
  const routedById = new Map<string, DeptRouting>();
  /** department id -> emails that received a DEPARTMENT-SCOPE copy. This is the
   *  literal set deliverInApp() writes a department row for. */
  const deptScoped = new Map<string, string[]>();
  if (probe) {
    for (const d of probe.departments) routedById.set(d.department_id, d);
    for (const r of probe.recipients) {
      if (r.scope !== 'department') continue;
      for (const id of r.department_ids) {
        const list = deptScoped.get(id) ?? [];
        list.push(r.email);
        deptScoped.set(id, list);
      }
    }
  }

  for (const dept of mains) {
    const routed = routedById.get(dept.id) ?? null;
    let heads: ReadinessHead[] = [];
    let gap = '';
    try {
      // A department the router CONSULTS contributes its own resolved heads,
      // verbatim — no second call, so no chance of a different answer. One it
      // never consults gets an advisory resolution, purely so the screen can say
      // "a head is configured and it still changes nothing"; `reach` is already
      // decided by then and this list cannot move it.
      const resolved = routed
        ? { heads: routed.heads, gap: routed.head_gap }
        : headsOf(db, dept, headChefs, { rethrow: true });
      gap = resolved.gap;
      heads = resolved.heads.map(h => {
        // Precedence MUST match the order headsOf() pushes candidates, or a
        // person who is both the department head and flagged would be
        // mislabelled. It is a label, not a decision.
        const via: HeadVia =
          str(dept.head_user_id).trim() === h.user_id ? 'Department head'
          : str(dept.head_chef_user_id).trim() === h.user_id ? 'HOD'
          : 'Head Chef flag';
        return { user_id: h.user_id, email: h.email, name: h.name, via };
      });
    } catch (e) {
      console.error('[po-deviation-alert] readiness: head resolution failed:', e);
      gap = `heads for ${dept.name} could not be resolved`;
    }

    // Categories as the admin wrote them, plus how many carry live items.
    let categories: string[] = [];
    try {
      const arr = JSON.parse(str(dept.material_categories) || '[]');
      if (Array.isArray(arr)) categories = arr.map(c => str(c)).filter(Boolean);
    } catch { categories = []; }
    // COUNTED OVER dept.cats — the NORMALISED keys the router matches on — not
    // over the raw strings. `"  "` is a truthy raw entry that catKey() drops, so
    // counting raw entries could report "1 with items" for a whitelist the
    // router treats as empty, and the blocker explaining a dark department would
    // never print.
    const withItems = [...dept.cats].filter(k => (liveCats.get(k) ?? 0) > 0).length;

    const blockers: string[] = [];
    if (!dept.is_active) {
      blockers.push(
        `This department is archived. Routing skips archived claimants, so no deviation reaches it `
        + `even though a head is set — reactivate it on Settings -> Departments.`,
      );
    }
    if (!dept.cats.size) {
      blockers.push(
        `No item categories are on this department's list, so no material can ever route here. `
        + `Add categories on Settings -> Departments -> ${dept.name}.`,
      );
    } else if (withItems === 0) {
      blockers.push(
        `None of this department's ${dept.cats.size} categories match any item in the catalogue, `
        + `so nothing routes here today. Check the spelling against the item list.`,
      );
    }

    // ── THE VERDICT, READ OUT OF THE PROBE ────────────────────────────────
    // Ordered so that the strongest claim needs the strongest evidence: green
    // requires an actual department-scope recipient row, and every path that is
    // not that ends up somewhere other than green.
    const scopedTo = deptScoped.get(dept.id) ?? [];
    let reach: DeptReach;
    let verdict: string;
    if (!probe) {
      // NOT 'none': 'none' is a PROVEN verdict with a remedy attached, and this
      // is the opposite of proven. The probe crashed; whether anyone would be
      // told is unknown in both directions, and the error is quoted so the
      // admin reads a failure, not advice.
      reach = 'unknown';
      verdict = `The readiness probe itself FAILED (${probeError}), so whether anyone in ${dept.name} `
        + `would be told is UNKNOWN — an error state, not "no heads configured". Nothing here is proven.`;
    } else if (scopedTo.length) {
      reach = 'department';
      verdict = `A deviation on one of ${dept.name}'s own items addresses a copy to ${scopedTo.join(', ')}.`;
    } else if (routed && routed.heads.length) {
      reach = 'admin-only';
      const who = routed.heads.map(h => h.email).join(', ');
      verdict = `Routing does reach ${dept.name} and resolves ${who} as its head — but they are also an `
        + `admin, so the one row they get is the wider ADMIN copy and no department copy is written. `
        + `They are told; the department rail is not what tells them.`;
    } else if (routed) {
      // The router got here and found nobody. Quote ITS sentence, so the screen
      // and the alert body say the same words.
      reach = 'none';
      verdict = routed.head_gap || `No head could be resolved for ${dept.name}, so nobody there would be told.`;
    } else if (!probeCategories) {
      reach = 'none';
      verdict = `No item exists in the catalogue, so no deviation can be raised against ${dept.name} yet.`;
    } else {
      reach = 'none';
      verdict = blockers[0]
        ?? `Routing never consults ${dept.name}: no live item's category is on its list.`;
    }

    departments.push({
      department_id: dept.id,
      department_name: dept.name,
      is_active: dept.is_active,
      categories,
      categories_with_items: withItems,
      heads,
      gap: heads.length ? '' : gap,
      blockers,
      reach,
      verdict,
    });
  }

  // Category-side holes, measured against LIVE materials rather than against
  // the whitelists — a whitelist gap nothing is filed under harms nobody.
  try {
    for (const [key, n] of liveCats) {
      const claimants = byCat.get(key) ?? [];
      const active = claimants.filter(d => d.is_active);
      if (active.length > 1) {
        contested.push({ category: key, departments: active.map(d => d.name) });
      }
      if (!active.length) {
        unclaimed.push({
          category: key,
          material_count: n,
          claimed_by_inactive: claimants.map(d => d.name),
        });
      }
    }
    unclaimed.sort((a, b) => b.material_count - a.material_count || a.category.localeCompare(b.category));
    contested.sort((a, b) => a.category.localeCompare(b.category));
  } catch (e) {
    console.error('[po-deviation-alert] readiness: category comparison failed:', e);
    errors.push('category routing could not be compared');
  }

  // THE PEOPLE THE ALERT PATH CANNOT SEE.
  //
  // Read with the SAME flag fragment headChefsByMainDept() uses, but WITHOUT
  // its department filter — that filter is exactly what makes these people
  // invisible, so reproducing it here would reproduce the blindness. Everyone
  // this query returns who DOES land in a main department is dropped below;
  // what is left is the set no gap sentence anywhere can mention.
  try {
    const rows = db.prepare(`
      SELECT u.id, u.email, u.name, u.is_active, u.department_id, u.is_head_chef, u.role_id,
             r.is_head_chef AS role_head_chef
        FROM users u
        LEFT JOIN roles r ON r.id = u.role_id
       WHERE ${HEAD_CHEF_FLAG_SQL}
       ORDER BY u.name COLLATE NOCASE, u.id
    `).all() as any[];
    const mainIds = new Set(mains.map(d => d.id));
    // Named from the data, never hardcoded: "move them under Kitchen, Bar or
    // Operations" becomes a wrong instruction the day a department is renamed.
    const mainNames = mains.filter(d => d.is_active).map(d => d.name);
    const underOne = mainNames.length
      ? `Move them under ${mainNames.join(' / ')} on Settings -> Users.`
      : 'No active main department exists to move them under.';
    const adminIds = new Set(admins.map(a => a.user_id));
    for (const row of rows) {
      const deptId = str(row.department_id).trim();
      let reason = '';
      if (!deptId) {
        reason = 'has the Head Chef flag but is in NO department, so deviation alerts can place them '
          + 'nowhere and they are told nothing as a HOD. Set their department on Settings -> Users.';
      } else {
        const main = mainDeptOf(db, deptId);
        if (!main) {
          reason = 'has the Head Chef flag, but the department on their account no longer exists, '
            + 'so deviation alerts can place them nowhere. Set their department on Settings -> Users.';
        } else if (!mainIds.has(str(main.id))) {
          reason = `has the Head Chef flag, but their department rolls up to "${str(main.name)}", `
            + 'which is not a main department — deviation routing only ever consults main departments. '
            + underOne;
        } else if (!row.is_active) {
          // headsOf() DOES name this case, but only for a department that has
          // no other candidate. Where a second head exists the deactivated one
          // is silently ignored, and the admin never learns the account they
          // think is covering the department is switched off.
          reason = `holds the Head Chef flag for ${str(main.name)}, but the account is deactivated `
            + '— they are never told. Reactivate them on Settings -> Users, or clear the flag.';
        } else {
          continue; // Genuinely reachable; already shown under their department.
        }
      }
      invisible.push({
        user_id: str(row.id),
        email: str(row.email),
        name: str(row.name) || str(row.email) || str(row.id),
        is_active: !!row.is_active,
        reason,
        also_admin: adminIds.has(str(row.id)),
      });
    }
  } catch (e) {
    console.error('[po-deviation-alert] readiness: head-chef sweep failed:', e);
    errors.push('the head-chef list could not be swept for unreachable people');
  }

  return {
    admins,
    admin_gaps: adminGaps,
    departments,
    unclaimed_categories: unclaimed,
    contested_categories: contested,
    invisible_head_chefs: invisible,
    errors,
    // Spread, not `probe_error: probe ? undefined : …`: the key must be ABSENT
    // on a healthy run so the serialised response stays byte-identical to the
    // shape from before this field existed.
    ...(probe ? {} : { probe_error: probeError }),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * WHAT THEY READ
 * ──────────────────────────────────────────────────────────────────────────*/

export interface AlertContext {
  poNumber: string;
  grnNumber: string;
  vendor: string;
  billNo: string;
  receivedBy: string;
  /** Optional provenance line — set by the GRN amendment rail so a correction
   *  made after receipt does not read like something the receiving desk saw. */
  note?: string;
}

/** One line, in the owner's own terms: what was ORDERED, what was RECEIVED, in
 *  PURCHASE units, and what it did to the money. */
function lineText(l: DeviationAlertLine): string {
  const u = l.unit_pu || 'unit';
  const axes: string[] = [];
  if (l.qty_excess) axes.push(`OVER by ${qty(l.received - l.ordered)} ${u}`);
  if (l.qty_short) axes.push(`SHORT by ${qty(l.ordered - l.received)} ${u}`);
  if (l.acc_short && !l.qty_short) axes.push(`SHORT-ACCEPTED ${qty(l.ordered - l.accepted)} ${u} (arrived, not accepted)`);
  if (l.rate_changed) axes.push(`RATE ${rate(l.ordered_rate)} -> ${rate(l.actual_rate)} per ${u}`);
  return `• ${l.material_name}: ordered ${qty(l.ordered)} ${u}, received ${qty(l.received)} ${u}`
    + (Math.abs(l.accepted - l.received) > 1e-9 ? ` (accepted ${qty(l.accepted)} ${u})` : '')
    + `\n    ${axes.join(' · ')}`
    + `\n    ordered at ${rate(l.ordered_rate)}/${u}, billed at ${rate(l.actual_rate)}/${u} — value impact ${money(l.value_impact)}`
    + `\n    reason given at the bay: ${l.reason || '(none recorded)'}`;
}

/** Title + body for one recipient. `scopeLines` is what THAT person may read:
 *  every line for an admin, only their department's for a HOD. */
export function composeAlert(
  ctx: AlertContext,
  scopeLines: DeviationAlertLine[],
  opts: { scope: AlertScope; departmentNames?: string[]; audience?: DeviationAudience },
): { title: string; body: string } {
  const c = countDeviations(scopeLines);
  const depts = (opts.departmentNames ?? []).filter(Boolean);
  const tag = opts.scope === 'department' && depts.length ? `[${depts.join(' + ')}] ` : '';

  // A single line names itself in the title — "ordered 1 pcs, received 9 pcs" is
  // the whole complaint and it fits. Several lines lead with the COUNTS, which
  // cannot cancel the way a net can.
  const one = scopeLines.length === 1 ? scopeLines[0] : null;
  const title = one
    ? `${tag}${ctx.poNumber}: ${one.material_name} ordered ${qty(one.ordered)} ${one.unit_pu || 'unit'}, `
      + `received ${qty(one.received)} ${one.unit_pu || 'unit'} (${countsPhrase(c) || 'off-PO'})`
    : `${tag}${ctx.poNumber}: ${scopeLines.length} lines received off-PO (${countsPhrase(c) || 'off-PO'})`;

  // THE PO NUMBER LEADS THE BODY, not only the title. A surface that renders the
  // body alone (a push payload, a WhatsApp forward, a pasted screenshot) would
  // otherwise carry the vendor's bill number and no way to find the order.
  const head =
    `PO: ${ctx.poNumber || '—'}`
    + `\nVendor: ${ctx.vendor || '—'}`
    + (ctx.billNo ? `\nVendor bill: ${ctx.billNo}` : '')
    + `\nGRN: ${ctx.grnNumber}`
    + `\nReceived by: ${ctx.receivedBy || 'system'}`
    + (ctx.note ? `\n${ctx.note}` : '')
    + `\n\n${impactPhrase(c)}\n`;

  const detail = scopeLines.map(lineText).join('\n');

  // The admin copy says where every line went, and where it could not go. The
  // HOD copy says neither — it is scoped to their own department by design and
  // must not leak another department's materials.
  //
  // HEADS ARE NAMED, NOT EMAILED. GET /api/notifications (another lane's file)
  // returns every notification body to any signed-in session with no recipient
  // filter, so a body that spelled out each HOD's address handed the whole
  // management roster to a captain. The name answers "who was told"; the address
  // adds nothing an admin cannot look up.
  let footer = '';
  if (opts.scope === 'admin' && opts.audience) {
    const routed = opts.audience.departments.map(d => {
      const who = d.heads.length ? d.heads.map(h => h.name).join(', ') : 'NOBODY';
      return `  · ${d.department_name} (${d.lines.length} line${d.lines.length === 1 ? '' : 's'}) -> ${who}`;
    });
    footer = `\n\nDepartment routing:\n${routed.length ? routed.join('\n') : '  · (none — no line matched a department)'}`;
    if (opts.audience.gaps.length) {
      footer += `\n\nNOT EVERYONE COULD BE REACHED:\n${opts.audience.gaps.map(g => `  · ${g}`).join('\n')}`;
    }
  } else if (opts.scope === 'department' && opts.audience && !opts.audience.admins.length) {
    // The one gap a HOD MUST see: if no admin was reached, they are the whole
    // audience, and a head who assumes the office already knows is the failure
    // this module exists to remove. Only this gap — the others belong to
    // departments that are not theirs.
    footer = `\n\nNOTE: no active admin user could be resolved, so this alert reached `
      + `nobody at admin level — you may be the only person who has seen it.`;
  }

  const body = `${head}\n${detail}${footer}\n\nReview on /grn or /purchase-orders.`;
  return { title, body };
}

/* ────────────────────────────────────────────────────────────────────────────
 * DELIVERY
 * ──────────────────────────────────────────────────────────────────────────*/

/** Same DDL the receive route and grn-qc-notify use, verbatim. The table is
 *  created lazily by whichever writer runs first; this rail must not depend on
 *  that having been the other one. */
function ensureNotificationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL,
      party_unique_id TEXT, fp_id TEXT, event_name TEXT, event_date TEXT,
      channel TEXT NOT NULL DEFAULT 'slack', recipient TEXT DEFAULT '',
      title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at TEXT, delivery_meta TEXT DEFAULT '',
      UNIQUE (party_unique_id, kind, channel)
    )
  `);
}

export interface DeliveredRow {
  recipient: string;
  user_id: string;
  scope: AlertScope;
  /** Every department whose lines this row carries. Empty for an admin copy. */
  department_names: string[];
  lines: number;
  /** false when UNIQUE already held a row for this person + receipt (a replay). */
  inserted: boolean;
}

export interface WaOutcome {
  attempted: boolean;
  sent: number;
  /** Every setting that has to be filled before this rail can ever send. */
  missing: string[];
  detail: string;
}

export interface DeviationDeliveryReport {
  audience: DeviationAudience;
  delivered: DeliveredRow[];
  whatsapp: WaOutcome;
  errors: string[];
}

export interface DeliverInput extends AlertContext {
  /** The receive route's own dedup key, e.g. `po:<poId>:grn:<grnId>` — or the
   *  amendment key from grn-reversal. Passed in rather than rebuilt so the
   *  addressed copies always hang off the SAME key as the broadcast row. */
  baseKey: string;
  lines: DeviationAlertLine[];
  /** True when the ONLY deviation is over-quantity — mirrors the route's
   *  `excessOnly`, so the addressed copies file under the same distinction
   *  /audit already uses. */
  excessOnly: boolean;
}

/**
 * WRITE ONE ROW PER PERSON, AND STAMP IT SENT.
 *
 * `sent_at` is set in the SAME statement that inserts the row, and that is the
 * honest stamp for this channel: an in-app notification IS delivered the moment
 * a row addressed to that user exists to be queried. The 17 historical rows have
 * sent_at NULL because nothing ever delivered them anywhere; leaving these NULL
 * too, and hoping a later sweep would fill them in, would be the same lie.
 *
 * NEVER THROWS. A failure on one recipient is recorded and the rest still go.
 */
export function deliverInApp(
  db: Database.Database,
  input: DeliverInput,
  audience: DeviationAudience,
): { delivered: DeliveredRow[]; errors: string[] } {
  const delivered: DeliveredRow[] = [];
  const errors: string[] = [];
  const kind = input.excessOnly ? 'po_received_excess_user' : 'po_received_deviation_user';
  try {
    ensureNotificationsTable(db);
  } catch (e) {
    errors.push(`notifications table unavailable: ${str((e as any)?.message || e)}`);
    return { delivered, errors };
  }

  const ins = db.prepare(`
    INSERT OR IGNORE INTO notifications
      (id, kind, party_unique_id, channel, recipient, title, body, sent_at, delivery_meta)
    VALUES (?, ?, ?, 'inapp', ?, ?, ?, datetime('now'), ?)
  `);

  for (const r of audience.recipients) {
    try {
      // An admin reads the WHOLE bill; a HOD reads the lines of EVERY department
      // they head — filtered back through input.lines so the order on the page
      // is the order on the purchase order, not the order the routing resolved.
      let scopeLines: DeviationAlertLine[];
      if (r.scope === 'admin') {
        scopeLines = input.lines;
      } else {
        const mine = new Set(r.department_ids);
        const keep = new Set<DeviationAlertLine>();
        for (const d of audience.departments) {
          if (!mine.has(d.department_id)) continue;
          for (const l of d.lines) keep.add(l);
        }
        scopeLines = input.lines.filter(l => keep.has(l));
      }
      // Defensive: a department recipient with no lines would be a routing bug,
      // and a body with no lines is worse than no message.
      if (!scopeLines.length) continue;
      const { title, body } = composeAlert(input, scopeLines, {
        scope: r.scope, departmentNames: r.department_names, audience,
      });
      const res = ins.run(
        generateId(), kind, `${input.baseKey}:to:${r.user_id}`, r.email, title, body,
        JSON.stringify({
          user_id: r.user_id, name: r.name, scope: r.scope,
          department_ids: r.department_ids, department_names: r.department_names,
          po_number: input.poNumber, grn_number: input.grnNumber, lines: scopeLines.length,
        }),
      );
      delivered.push({
        recipient: r.email, user_id: r.user_id, scope: r.scope,
        department_names: r.department_names, lines: scopeLines.length,
        inserted: res.changes > 0,
      });
    } catch (e) {
      errors.push(`delivery to ${r.email} failed: ${str((e as any)?.message || e)}`);
    }
  }
  return { delivered, errors };
}

/* ────────────────────────────────────────────────────────────────────────────
 * WHATSAPP — BUILT, WIRED, AND INERT
 * ──────────────────────────────────────────────────────────────────────────*/

/**
 * Admin-typed mobiles for this event. Capped at 10, like setWaNotifyRecipients.
 *
 * OWN KEY FIRST, shared JSON only as a fallback — see
 * WA_PO_DEVIATION_RECIPIENTS_KEY for why. Numbers stored in the shared
 * `wa_notify_recipients` slot still work, but they can be deleted by any
 * unrelated save on the WhatsApp Notifications tab; numbers in the dedicated key
 * cannot.
 */
export function waDeviationRecipients(db: Database.Database): string[] {
  const own = setting(db, WA_PO_DEVIATION_RECIPIENTS_KEY).trim();
  if (own) {
    let list: unknown[] = [];
    try {
      const parsed = JSON.parse(own);
      list = Array.isArray(parsed) ? parsed : String(parsed).split(',');
    } catch {
      list = own.split(',');
    }
    const out = list.map(m => str(m).trim()).filter(Boolean).slice(0, 10);
    if (out.length) return out;
  }
  try {
    const raw = JSON.parse(setting(db, 'wa_notify_recipients') || '{}');
    const v = raw?.[WA_PO_DEVIATION_RECIPIENT_SLOT];
    if (!Array.isArray(v)) return [];
    return v.map((m: unknown) => str(m).trim()).filter(Boolean).slice(0, 10);
  } catch { return []; }
}

/** Per-number and whole-rail ceilings on how long an ARMED WhatsApp rail may
 *  hold the receive response open. Each send's own ceiling is CLAMPED to the
 *  budget that is left, so ten numbers cannot add up to ten timeouts — the whole
 *  rail returns within WA_TOTAL_BUDGET_MS whatever Meta does. Both are
 *  unreachable today (the rail returns before the network); they exist so that
 *  arming it can never turn a committed receipt into an apparent failure. */
const WA_SEND_TIMEOUT_MS = 4000;
const WA_TOTAL_BUDGET_MS = 8000;

function logWa(db: Database.Database, payload: Record<string, unknown>): void {
  try {
    db.prepare(`INSERT INTO whatsapp_events_log (kind, payload) VALUES ('send_attempt', ?)`)
      .run(JSON.stringify(payload));
  } catch { /* logging must never break a caller */ }
}

/**
 * THE WHATSAPP RAIL. The owner asked for "Whatsapp too"; the configuration
 * cannot carry it yet, so the path is written, wired and provably inert.
 *
 * MEASURED on the live database (2026-08-29): wa_notifications_enabled = '1' and
 * wa_access_token IS set, but wa_phone_number_id is EMPTY, wa_business_account_id
 * is EMPTY, and wa_notify_recipients is `{}`. Meta Cloud also permits only
 * APPROVED TEMPLATES for a business-initiated message, and no template exists
 * for this alert.
 *
 * So this function COLLECTS EVERY MISSING SETTING BY NAME and returns without
 * touching the network. It does not send half a message, does not fall back to
 * free-form (a cold business-initiated ping outside Meta's 24h window is exactly
 * what free-form may not do), and NEVER invents a template name Meta has not
 * approved — the name is a setting with no default, and an unset name is itself
 * a reported gap.
 *
 * Every gap is logged once into whatsapp_events_log with reason 'not_sent' and
 * the list of keys, so "why did WhatsApp not fire" is answerable from data
 * instead of from this comment.
 */
export async function deliverWhatsApp(
  db: Database.Database,
  input: DeliverInput,
  _audience: DeviationAudience,
): Promise<WaOutcome> {
  const missing: string[] = [];
  try {
    if (setting(db, 'wa_notifications_enabled') !== '1') missing.push('wa_notifications_enabled (master switch is off)');
    if (setting(db, WA_PO_DEVIATION_EVENT_KEY) !== '1') missing.push(`${WA_PO_DEVIATION_EVENT_KEY} (this alert's own toggle is off)`);

    const provider = setting(db, 'wa_api_provider') || 'meta_cloud';
    if (provider === 'meta_cloud') {
      if (!setting(db, 'wa_phone_number_id').trim()) missing.push('wa_phone_number_id (empty — Meta Cloud cannot address a sender)');
      if (!setting(db, 'wa_access_token').trim()) missing.push('wa_access_token');
    } else if (provider === 'interakt') {
      if (!setting(db, 'wa_interakt_api_key').trim()) missing.push('wa_interakt_api_key');
    } else {
      missing.push(`wa_api_provider ("${provider}" cannot send — use meta_cloud or interakt)`);
    }

    const template = setting(db, WA_PO_DEVIATION_TEMPLATE_KEY).trim();
    if (!template) {
      missing.push(`${WA_PO_DEVIATION_TEMPLATE_KEY} (no Meta-APPROVED template is named for this alert; business-initiated messages may not be free-form)`);
    }
    const to = waDeviationRecipients(db);
    if (!to.length) missing.push(`${WA_PO_DEVIATION_RECIPIENTS_KEY} (no mobile numbers configured)`);

    if (missing.length) {
      const detail = `WhatsApp not sent — ${missing.length} setting(s) incomplete: ${missing.join('; ')}`;
      console.warn(`[po-deviation-alert] ${detail}`);
      logWa(db, {
        event: 'po_deviation', reason: 'not_sent', missing,
        po_number: input.poNumber, grn_number: input.grnNumber,
      });
      return { attempted: false, sent: 0, missing, detail };
    }

    // ── Live path. Unreachable on today's config; written so that filling the
    // settings in is the ONLY thing needed to arm it. Template parameters are
    // positional and their ORDER IS THE CONTRACT with whatever template the
    // owner gets approved, so it is stated here and nowhere else.
    const c = countDeviations(input.lines);
    // THE LINE THAT MATTERS, not the line that happens to be first. Seven
    // positional parameters cannot carry six materials, so the one named is the
    // one that moved the most money — and the parameter SAYS how many others
    // there are, so a reader can never take a named SHORT line as the whole
    // story while an over-receipt sits unmentioned behind it.
    const top = input.lines.reduce(
      (best, l) => (Math.abs(Number(l.value_impact) || 0) > Math.abs(Number(best.value_impact) || 0) ? l : best),
      input.lines[0],
    );
    const extra = input.lines.length - 1;
    const lang = setting(db, WA_PO_DEVIATION_TEMPLATE_LANG_KEY).trim() || 'en';
    const params = [
      input.poNumber,                                                        // {{1}} PO number
      input.vendor || '—',                                                   // {{2}} vendor
      top ? `${top.material_name}${extra ? ` (+${extra} more line${extra === 1 ? '' : 's'})` : ''}` : '—', // {{3}} material
      top ? `${qty(top.ordered)} ${top.unit_pu}` : '—',                      // {{4}} ORDERED
      top ? `${qty(top.received)} ${top.unit_pu}` : '—',                     // {{5}} RECEIVED
      countsPhrase(c) || 'off-PO',                                           // {{6}} counts, never a bare net
      `${money(c.above)} / ${money(c.below)}`,                               // {{7}} gross pair
    ];
    // A BOUNDED WAIT. sendWhatsAppTemplate calls fetch with no timeout and no
    // AbortSignal (whatsapp.ts, another lane's file), and this runs on the
    // receive request AFTER the money has committed — so a hung Meta socket
    // could hold the HTTP response open indefinitely and convince a receiver
    // that a receipt which fully succeeded had failed. The race unblocks this
    // caller; it cannot cancel the socket, which is whatsapp.ts's to fix.
    const budgetStarted = Date.now();
    let sent = 0;
    for (const num of to) {
      const left = WA_TOTAL_BUDGET_MS - (Date.now() - budgetStarted);
      if (left <= 0) {
        logWa(db, { event: 'po_deviation', to: num, ok: false, reason: 'skipped_budget_exhausted' });
        continue;
      }
      try {
        const res = await Promise.race([
          sendWhatsAppTemplate(num, template, lang, params),
          new Promise<{ ok: false; reason: string }>(resolve =>
            setTimeout(() => resolve({ ok: false, reason: 'timeout' }), Math.min(WA_SEND_TIMEOUT_MS, left))),
        ]);
        if (res.ok) sent++;
        logWa(db, { event: 'po_deviation', to: num, via: 'template', ok: res.ok, reason: (res as any).reason, detail: (res as any).detail });
      } catch (e) {
        logWa(db, { event: 'po_deviation', to: num, ok: false, reason: 'threw', detail: str((e as any)?.message || e) });
      }
    }
    return { attempted: true, sent, missing: [], detail: `WhatsApp attempted for ${to.length} number(s), ${sent} accepted` };
  } catch (e) {
    // A fault in the WhatsApp rail is never allowed to reach the caller.
    const detail = `WhatsApp rail failed (non-fatal): ${str((e as any)?.message || e)}`;
    console.error(`[po-deviation-alert] ${detail}`);
    return { attempted: false, sent: 0, missing, detail };
  }
}

/**
 * THE ONE ENTRY POINT the receive route calls.
 *
 * NEVER THROWS — the contract the caller depends on. It runs AFTER commit, and
 * a receipt that is already in the books must never be lost because nobody could
 * be found to tell about it. Each stage is independently guarded, so a broken
 * department table still lets the admins be told, and a failed in-app write
 * still lets WhatsApp report why it stayed dark.
 */
export async function raiseDeviationAlert(
  db: Database.Database,
  input: DeliverInput,
): Promise<DeviationDeliveryReport> {
  const empty: DeviationAudience = { admins: [], departments: [], unrouted: [], recipients: [], gaps: [] };
  let audience = empty;
  const errors: string[] = [];
  try {
    if (!input.lines || input.lines.length === 0) {
      return { audience: empty, delivered: [], whatsapp: { attempted: false, sent: 0, missing: [], detail: 'no deviating lines' }, errors };
    }
    try {
      audience = resolveDeviationAudience(db, input.lines);
    } catch (e) {
      errors.push(`audience resolution failed: ${str((e as any)?.message || e)}`);
      audience = empty;
    }

    let delivered: DeliveredRow[] = [];
    try {
      const r = deliverInApp(db, input, audience);
      delivered = r.delivered;
      errors.push(...r.errors);
    } catch (e) {
      errors.push(`in-app delivery failed: ${str((e as any)?.message || e)}`);
    }

    const whatsapp = await deliverWhatsApp(db, input, audience);
    return { audience, delivered, whatsapp, errors };
  } catch (e) {
    console.error('[po-deviation-alert] raiseDeviationAlert failed (non-fatal):', e);
    errors.push(str((e as any)?.message || e));
    return { audience, delivered: [], whatsapp: { attempted: false, sent: 0, missing: [], detail: 'not reached' }, errors };
  }
}
