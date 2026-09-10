/* eslint-disable @typescript-eslint/no-explicit-any */
import type Database from 'better-sqlite3';
import { normalizeWaNumber } from '@/lib/whatsapp';

/**
 * WHO GETS A REPORT — audience tokens resolved to actual WhatsApp numbers.
 *
 * ── THE PROBLEM THIS SOLVES ───────────────────────────────────────────────
 * A recipient list of typed digits rots. The Bar HOD changes, the number is
 * still in the settings row, and last month's HOD keeps getting the stock
 * variance for a department they no longer run — while the new one gets
 * nothing and nobody notices, because a WhatsApp send that reaches the wrong
 * person looks exactly like one that reached the right person.
 *
 * So a report is addressed to a ROLE — "management", "the HOD of Akan Bar",
 * "Ganesh" — and the numbers are resolved from the users table at SEND TIME,
 * every time. Change who runs the bar and the next morning's report follows.
 *
 * ── THE TOKENS ────────────────────────────────────────────────────────────
 *   mgmt              every admin, manager-tier user, and HOD (isManagement)
 *   admin             admins only
 *   hod:<deptId>      whoever heads that department (see hodsOfDepartment)
 *   user:<userId>     one named person
 * Anything else is IGNORED, not guessed at — an unknown token resolving to
 * "everyone" is how a stock report ends up on a WhatsApp group.
 *
 * Manual numbers stay supported and stay SEPARATE (settings key
 * wa_report_<key>_recipients, unchanged from the runner's first cut, so
 * existing configuration keeps working). They are for the accountant who has
 * no login — not for staff, who should be addressed by name.
 *
 * ── A NUMBER COMES FROM ONE OF TWO PLACES, IN THIS ORDER ──────────────────
 *   1. users.wa_mobile      typed deliberately FOR WhatsApp, on the reports
 *                           config page.
 *   2. hr_employees.phone10 the HR record for the same login, where HRMS is
 *                           in use.
 * (1) wins because an HR record's phone can be a landline, a shared number, or
 * a number with no WhatsApp on it; (2) exists so an install that has already
 * done the HR data entry does not have to do it twice.
 *
 * ── UNREACHABLE IS AN ANSWER, AND IT IS SHOWN ─────────────────────────────
 * A picked person with no number on file does NOT silently vanish from the
 * list. resolveRecipients returns them under `unreachable`, the config page
 * prints them in amber next to the ones that will actually receive, and the
 * run ledger records the numbers that were really attempted. The failure mode
 * this prevents: an admin ticks "management", sees a tidy green tick, saves,
 * and three of the five people they had in mind never get a report because
 * nobody ever put a number against their login.
 *
 * PURE READS. Nothing here writes, sends, or reaches the network.
 */

/** Hard ceiling on one report's audience. */
export const MAX_REPORT_RECIPIENTS = 20;

export interface ResolvedRecipient {
  /** Normalised, ready for the send rail. */
  number: string;
  /** Human label for the preview: 'Latesh — Akan Bar HOD'. */
  label: string;
  /** Which token put them on the list. */
  via: string;
  /** 'wa_mobile' | 'hr_phone' | 'manual' */
  source: string;
  /** users.id, or '' for a manual number. */
  userId: string;
}

export interface UnreachableRecipient {
  userId: string;
  name: string;
  via: string;
  reason: string;
}

export interface ResolvedAudience {
  recipients: ResolvedRecipient[];
  unreachable: UnreachableRecipient[];
  /** Just the numbers, deduped, in preview order — what the send rail is given. */
  numbers: string[];
  /** Tokens that matched nothing at all. Surfaced, never swallowed. */
  emptyTokens: string[];
  /** True when MAX_REPORT_RECIPIENTS trimmed the list. */
  capped: boolean;
}

interface UserRow {
  id: string; name: string; email: string; role: string;
  is_head_chef: number; department_id: string | null;
  wa_mobile?: string; role_base?: string | null; role_name?: string | null;
}

const S = (v: unknown) => String(v ?? '').trim();

/**
 * Every active login with its EFFECTIVE tier.
 *
 * The tier is `roles.base_role` when a named role is assigned, else
 * `users.role` — the same precedence getCurrentUser() applies (auth.ts). Doing
 * it any other way would let a person the app treats as a manager be invisible
 * to "management" here, or the reverse: a report addressed to management that
 * skips the one manager whose tier comes from their role.
 */
function activeUsers(db: Database.Database): UserRow[] {
  try {
    return db.prepare(`
      SELECT u.id, u.name, u.email, u.role, u.is_head_chef, u.department_id,
             COALESCE(u.wa_mobile, '') AS wa_mobile,
             r.base_role AS role_base, r.name AS role_name
        FROM users u
        LEFT JOIN roles r ON r.id = u.role_id
       WHERE u.is_active = 1
       ORDER BY u.name COLLATE NOCASE
    `).all() as UserRow[];
  } catch {
    // Older schema without wa_mobile / roles — still answer, with what exists.
    try {
      return db.prepare(
        'SELECT id, name, email, role, is_head_chef, department_id FROM users WHERE is_active = 1 ORDER BY name COLLATE NOCASE',
      ).all() as UserRow[];
    } catch { return []; }
  }
}

function tierOf(u: UserRow): string {
  return S(u.role_base) || S(u.role) || 'staff';
}

/** admin | manager tier | HOD — the same reading isManagement() uses. */
function isMgmt(u: UserRow): boolean {
  const t = tierOf(u);
  return t === 'admin' || t === 'manager' || Number(u.is_head_chef) === 1;
}

/**
 * Who heads a department, most specific first:
 *   1. departments.head_user_id / head_chef_user_id when set — an explicit
 *      appointment beats any inference.
 *   2. otherwise, the department's own management-tier members. Both columns
 *      are NULL on every row of this install, so without (2) "HOD of Akan Bar"
 *      would resolve to nobody on the very data it exists for.
 *
 * Note the deliberate limit of (2): it is who the app ALREADY treats as senior
 * in that department (manager tier or the HOD flag), never every member of it.
 * A department's stock variance must not land on a commis chef's phone.
 */
export function hodsOfDepartment(db: Database.Database, deptId: string, users?: UserRow[]): UserRow[] {
  const all = users || activeUsers(db);
  const byId = new Map(all.map(u => [S(u.id), u]));
  const out: UserRow[] = [];
  const push = (u: UserRow | undefined) => {
    if (u && !out.some(x => x.id === u.id)) out.push(u);
  };
  try {
    const d = db.prepare(
      'SELECT head_user_id, head_chef_user_id FROM departments WHERE id = ?',
    ).get(deptId) as any;
    push(byId.get(S(d?.head_user_id)));
    push(byId.get(S(d?.head_chef_user_id)));
  } catch { /* departments may not carry those columns on an old schema */ }
  if (!out.length) {
    for (const u of all) {
      if (S(u.department_id) !== S(deptId)) continue;
      if (isMgmt(u)) push(u);
    }
  }
  return out;
}

/** The number we would actually message this person on, and where it came from. */
export function numberForUser(db: Database.Database, u: UserRow): { number: string; source: string } {
  const own = normalizeWaNumber(S(u.wa_mobile));
  if (own) return { number: own, source: 'wa_mobile' };
  try {
    const hr = db.prepare(`
      SELECT phone10 FROM hr_employees
       WHERE user_id = ? AND TRIM(COALESCE(phone10,'')) <> ''
       ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, updated_at DESC
       LIMIT 1
    `).get(S(u.id)) as any;
    const n = normalizeWaNumber(S(hr?.phone10));
    if (n) return { number: n, source: 'hr_phone' };
  } catch { /* no HRMS on this install */ }
  return { number: '', source: '' };
}

/**
 * The number for one login, by id. This is what "send the test to whoever
 * pressed the button" resolves through — the tester's own number, never a
 * number supplied on the request, so a test send cannot be aimed at a third
 * party by anyone who can craft a POST.
 */
export function numberForUserId(db: Database.Database, userId: string): { number: string; source: string; name: string } {
  try {
    const u = db.prepare(`
      SELECT u.id, u.name, u.email, u.role, u.is_head_chef, u.department_id,
             COALESCE(u.wa_mobile, '') AS wa_mobile
        FROM users u WHERE u.id = ?
    `).get(S(userId)) as UserRow | undefined;
    if (!u) return { number: '', source: '', name: '' };
    const { number, source } = numberForUser(db, u);
    return { number, source, name: S(u.name) || S(u.email) };
  } catch { return { number: '', source: '', name: '' }; }
}

function deptName(db: Database.Database, id: string): string {
  try {
    const r = db.prepare('SELECT name FROM departments WHERE id = ?').get(id) as any;
    return S(r?.name);
  } catch { return ''; }
}

/**
 * Resolve an audience spec + manual numbers to the list that will be messaged.
 *
 * Order is preview order and send order: audience tokens in the order the admin
 * chose them, then manual numbers. Deduped by NORMALISED number, so the same
 * person reached through 'mgmt' and again through 'hod:bar' — or typed by hand
 * as 98765 43210 while also being a login — is messaged exactly once. The
 * `via` kept is the FIRST reason they qualified, which is the one that will
 * still be true if the second is removed.
 */
export function resolveRecipients(
  db: Database.Database,
  spec: { audience?: unknown; manual?: unknown },
): ResolvedAudience {
  const tokens = Array.isArray(spec.audience) ? spec.audience.map(S).filter(Boolean) : [];
  const manual = Array.isArray(spec.manual)
    ? spec.manual.map(S).filter(Boolean)
    : S(spec.manual).split(',').map(s => s.trim()).filter(Boolean);

  const users = activeUsers(db);
  const byId = new Map(users.map(u => [S(u.id), u]));

  const recipients: ResolvedRecipient[] = [];
  const unreachable: UnreachableRecipient[] = [];
  const emptyTokens: string[] = [];
  const seenNumbers = new Set<string>();
  const seenUnreachable = new Set<string>();

  const addUser = (u: UserRow, via: string, labelSuffix = '') => {
    const { number, source } = numberForUser(db, u);
    const name = S(u.name) || S(u.email) || u.id;
    const label = labelSuffix ? `${name} — ${labelSuffix}` : name;
    if (!number) {
      const k = `${u.id}|${via}`;
      if (!seenUnreachable.has(k) && !unreachable.some(x => x.userId === u.id)) {
        seenUnreachable.add(k);
        unreachable.push({
          userId: S(u.id), name: label, via,
          reason: 'No WhatsApp number on file for this login.',
        });
      }
      return;
    }
    if (seenNumbers.has(number)) return;
    seenNumbers.add(number);
    recipients.push({ number, label, via, source, userId: S(u.id) });
  };

  for (const token of tokens) {
    const before = recipients.length + unreachable.length;

    if (token === 'mgmt') {
      for (const u of users) if (isMgmt(u)) addUser(u, 'mgmt', roleLabel(u));
    } else if (token === 'admin') {
      for (const u of users) if (tierOf(u) === 'admin') addUser(u, 'admin', 'Admin');
    } else if (token.startsWith('hod:')) {
      const deptId = token.slice(4);
      const dn = deptName(db, deptId) || 'department';
      for (const u of hodsOfDepartment(db, deptId, users)) addUser(u, token, `${dn} HOD`);
    } else if (token.startsWith('user:')) {
      const u = byId.get(token.slice(5));
      if (u) addUser(u, token, roleLabel(u));
    } else {
      // NOT treated as a number, and NOT treated as "everyone". An unknown
      // token is a configuration mistake, and it is reported as one.
      emptyTokens.push(token);
      continue;
    }

    if (recipients.length + unreachable.length === before) emptyTokens.push(token);
  }

  for (const raw of manual) {
    const number = normalizeWaNumber(raw);
    if (!number || seenNumbers.has(number)) continue;
    seenNumbers.add(number);
    recipients.push({ number, label: raw, via: 'manual', source: 'manual', userId: '' });
  }

  const capped = recipients.length > MAX_REPORT_RECIPIENTS;
  const kept = capped ? recipients.slice(0, MAX_REPORT_RECIPIENTS) : recipients;

  return {
    recipients: kept,
    unreachable,
    numbers: kept.map(r => r.number),
    emptyTokens,
    capped,
  };
}

function roleLabel(u: UserRow): string {
  const parts = [S(u.role_name) || tierOf(u)];
  if (Number(u.is_head_chef) === 1 && !/hod|head/i.test(parts[0])) parts.push('HOD');
  return parts.filter(Boolean).join(' · ');
}

/** The pickable audience, for the config page's chooser. Read-only. */
export function audienceOptions(db: Database.Database): {
  groups: Array<{ token: string; label: string; count: number }>;
  users: Array<{ token: string; label: string; number: string; source: string; role: string }>;
} {
  const users = activeUsers(db);
  const groups: Array<{ token: string; label: string; count: number }> = [
    { token: 'mgmt', label: 'All management (admins, managers, HODs)', count: users.filter(isMgmt).length },
    { token: 'admin', label: 'Admins only', count: users.filter(u => tierOf(u) === 'admin').length },
  ];
  try {
    const depts = db.prepare(
      'SELECT id, name FROM departments WHERE is_active = 1 ORDER BY name COLLATE NOCASE',
    ).all() as any[];
    for (const d of depts) {
      const heads = hodsOfDepartment(db, S(d.id), users);
      // A department with nobody senior in it is still LISTED, with count 0, so
      // an admin can see that picking it would send to nobody — rather than it
      // quietly not being on the menu and them assuming it is covered.
      groups.push({ token: `hod:${S(d.id)}`, label: `HOD — ${S(d.name)}`, count: heads.length });
    }
  } catch { /* no departments table */ }

  return {
    groups,
    users: users.map(u => {
      const { number, source } = numberForUser(db, u);
      return {
        token: `user:${S(u.id)}`,
        label: S(u.name) || S(u.email) || S(u.id),
        number, source, role: roleLabel(u),
      };
    }),
  };
}
