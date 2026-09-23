'use client';

/**
 * BILL HANDOVER — SHARED SCREEN PIECES (Accounts side)
 * ====================================================
 *
 * The parts /bill-submissions/accounts and /bill-submissions/history both use:
 * the server's shapes, the IST renderers, the status chip, the cutoff notice,
 * the "Accounts role does not exist yet" banner, the dashboard tiles and the
 * record drawer with its audit trail.
 *
 * WHY A SHARED FILE AND NOT TWO COPIES. The owner's whole purpose is
 * "prevent situations where there is confusion about whether a vendor bill was
 * actually handed over". Two screens that render the same status with two
 * different words, or two different waiting clocks, ARE that confusion. One
 * component each, used twice.
 *
 * ── EVERY TIMESTAMP IS UTC ON THE WIRE AND IST ON THE SCREEN ───────────────
 * Every stamp in bill_handovers is written by SQLite `datetime('now')`, which is
 * UTC with no zone marker ("2026-09-17 19:30:00"). `new Date(...)` on such a
 * string parses it as the BROWSER's local zone, which is wrong everywhere. So
 * nothing here ever calls `new Date(raw)` directly: dates go through
 * src/lib/format-date.ts (fmtIST / fmtISTDate), and the one place that needs a
 * Date object for arithmetic — the waiting clock — uses parseDbUtc() below,
 * which mirrors that module's private parseDb(). The discriminating case:
 * "2026-09-17 19:30:00" is 18 Sept in IST, not 17 Sept.
 *
 * ── THE STATUS WORDS ARE THE OWNER'S, AND THEY COME FROM THE SERVER ────────
 * BH_STATUS_LABEL / BH_STATUS_SHORT live in src/lib/bill-handover-schema.ts and
 * ride on GET /api/bill-submissions/summary as `labels`. Screens prefer that
 * copy. The constants below are a byte-identical fallback for the moment before
 * the summary lands (and for the list route, which does not ship labels) — if
 * you change one, change the server's copy in the same edit or the two screens
 * start paraphrasing the three states apart.
 */

import { useEffect, useState } from 'react';
import { fmtIST, fmtISTDate } from '@/lib/format-date';
import {
  AlertTriangle, Ban, BadgeCheck, CheckCircle2, Clock, Download, FileText,
  Hourglass, Info, Loader2, Paperclip, ShieldAlert, X,
} from 'lucide-react';

/* ════════════════════════════════════════════════════════════════════════════
   THE SERVER'S SHAPES, VERBATIM
   (src/lib/bill-handover.ts — BillHandoverRow, BillHandoverEvent, CutoffState,
    AccountsRoleState, BillHandoverSummary)
   ════════════════════════════════════════════════════════════════════════════ */

export type BhStatus = 'pending_submission' | 'submitted' | 'received' | 'void';

export interface HandoverRow {
  id: string;
  source: string;
  grn_id: string | null;
  grn_number: string;
  invoice_id: string;
  bill_no: string;
  vendor_id: string;
  vendor_name: string;
  bill_date: string;
  received_date: string;
  bill_value: number;
  outlet_id: string | null;
  status: BhStatus;
  created_by_id: string;
  created_by_name: string;
  created_by_email: string;
  created_at: string;
  submitted_by_id: string;
  submitted_by_name: string;
  submitted_by_email: string;
  submitted_at: string | null;
  confirmed_by_id: string;
  confirmed_by_name: string;
  confirmed_by_email: string;
  confirmed_at: string | null;
  voided_by_id: string;
  voided_by_name: string;
  voided_at: string | null;
  void_reason: string;
  note: string;
  cutoff_date: string;
  updated_at: string;
  attachment_count?: number;
}

export interface TrailEvent {
  id: string;
  handover_id: string;
  action: string;
  from_status: string;
  to_status: string;
  actor_id: string;
  actor_name: string;
  actor_email: string;
  actor_role: string;
  note: string;
  at: string;
}

export interface CutoffState {
  date: string | null;
  committed_at: string | null;
  ready: boolean;
  notice: string;
}

export interface AccountsRoleState {
  exists: boolean;
  is_active: boolean;
  stored_name: string;
  all_role_names: string[];
}

export interface CanFlags {
  record?: boolean;
  confirm?: boolean;
  confirm_this?: boolean;
  confirm_blocked_reason?: string | null;
  void_confirmed?: boolean;
}

export interface SummaryPayload {
  cutoff: CutoffState;
  counts: Record<BhStatus, number>;
  values: Record<BhStatus, number>;
  not_yet_recorded: number;
  oldest_pending_date: string | null;
  oldest_submitted_date: string | null;
  labels?: { long: Record<BhStatus, string>; short: Record<BhStatus, string> };
  accounts_role: AccountsRoleState;
  can: CanFlags;
}

export interface ListPayload {
  rows: HandoverRow[];
  total: number;
  page: number;
  pageSize: number;
  cutoff: CutoffState;
  accounts_role: AccountsRoleState;
  can: CanFlags;
}

export interface DetailPayload {
  handover: HandoverRow;
  trail: TrailEvent[];
  cutoff: CutoffState;
  can: CanFlags;
}

export interface AttachmentMeta {
  id: string;
  handover_id: string;
  filename: string;
  mime: string;
  size_bytes: number;
  uploaded_by_id: string;
  uploaded_by_name: string;
  uploaded_at: string;
}

/** The exact role name the owner must type in Settings → Roles. Mirrors
 *  ACCOUNTS_ROLE_NAME in src/lib/bill-handover.ts. */
export const ACCOUNTS_ROLE_NAME = 'Accounts';

/** The page labels registered in src/lib/page-catalog.ts, quoted to the owner in
 *  the missing-role banner so what he reads here matches the checkbox he has to
 *  find. Change these and the catalog together. */
export const ACCOUNTS_PAGE_LABEL = 'Bill Handover — Accounts';
export const HISTORY_PAGE_LABEL = 'Bill Handover — History';

/** Fallback copies of the server's status words. See the header note. */
export const BH_LABEL_LONG: Record<BhStatus, string> = {
  pending_submission: 'Pending Submission',
  submitted: 'Submitted - Awaiting Accounts Confirmation',
  received: 'Received by Accounts',
  void: 'Voided',
};
export const BH_LABEL_SHORT: Record<BhStatus, string> = {
  pending_submission: 'Pending Submission',
  submitted: 'Submitted to Accounts',
  received: 'Received by Accounts',
  void: 'Voided',
};

/* ════════════════════════════════════════════════════════════════════════════
   THE WAITING CLOCK
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * "Make a bill that has been waiting a long time for confirmation visible
 * rather than buried."
 *
 * PURELY A DISPLAY RULE. Crossing either threshold changes a colour and moves a
 * count into a banner. It NEVER changes a status, and there is deliberately no
 * "auto-confirm after N days" anywhere in this feature — a machine-set
 * confirmation would be a lie in exactly the place the owner asked for the
 * truth. The only thing that reaches "Received by Accounts" is a person
 * clicking.
 */
export const WAIT_ATTENTION_DAYS = 2;
export const WAIT_OVERDUE_DAYS = 5;

/** Mirrors the private parseDb() in src/lib/format-date.ts: a SQLite
 *  `datetime('now')` string is UTC and must be told so before it is parsed. */
export function parseDbUtc(value: unknown): Date | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  const s = String(value).trim();
  if (!s) return null;
  let iso = s;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(:\d{2})?)$/);
  if (m) iso = `${m[1]}T${m[2]}Z`;
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) iso = s + 'Z';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

export type WaitTone = 'none' | 'fresh' | 'attention' | 'overdue';

export interface Waited {
  /** Whole days waited, floored. */
  days: number;
  hours: number;
  tone: WaitTone;
  /** "Waiting 3 days", "Waiting 5 hrs", "Waiting 20 min". */
  label: string;
}

/** How long this bill has been waiting for Accounts, measured from the STORE
 *  SUBMISSION stamp — the moment the paper left the store's hands. Not from the
 *  received date: a bill received on Monday and handed over on Thursday has been
 *  waiting on Accounts since Thursday, and blaming Accounts for the store's
 *  three days would be the wrong accusation from the screen built to end them. */
export function waitedSince(submittedAt: unknown, now = Date.now()): Waited {
  const d = parseDbUtc(submittedAt);
  if (!d) return { days: 0, hours: 0, tone: 'none', label: '' };
  const ms = Math.max(0, now - d.getTime());
  const hours = ms / 3_600_000;
  const days = Math.floor(hours / 24);
  const tone: WaitTone =
    days >= WAIT_OVERDUE_DAYS ? 'overdue' : days >= WAIT_ATTENTION_DAYS ? 'attention' : 'fresh';
  let label: string;
  if (hours < 1) label = `Waiting ${Math.max(1, Math.floor(ms / 60_000))} min`;
  else if (hours < 24) label = `Waiting ${Math.floor(hours)} hr${Math.floor(hours) === 1 ? '' : 's'}`;
  else label = `Waiting ${days} day${days === 1 ? '' : 's'}`;
  return { days, hours, tone, label };
}

/* ════════════════════════════════════════════════════════════════════════════
   SMALL FORMATTERS
   ════════════════════════════════════════════════════════════════════════════ */

export function money(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '₹0.00';
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** The house download shape (src/app/store-dashboard/page.tsx:132-138). */
export function downloadCsv(filename: string, lines: string[]): void {
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function bytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

/** What to call this bill in one line. bill_no is the VENDOR's own number and is
 *  NOT unique (measured: 9 of 354 keys ambiguous under vendor+bill_no), so the
 *  GRN number rides alongside it wherever there is room — that IS the key. */
export function billTitle(r: HandoverRow): string {
  if (r.bill_no) return `Bill ${r.bill_no}`;
  if (r.grn_number) return r.grn_number;
  if (r.invoice_id) return r.invoice_id;
  return 'Bill (no number)';
}

/* ════════════════════════════════════════════════════════════════════════════
   FETCH HELPERS
   ════════════════════════════════════════════════════════════════════════════ */

export interface FetchProblem {
  status: number;
  error: string;
  accounts_role?: AccountsRoleState;
}

/**
 * A GET that never throws and never invents a message.
 *
 * A non-JSON body is reported as one — the single catch the HR documents vault
 * is missing (hr/documents/page.tsx:268-274 swallows a proxy's HTML 413 into a
 * generic "Could not upload"), which is how a request killed by nginx before it
 * ever reached the app reads on screen as an application bug.
 */
export async function getJson<T>(url: string): Promise<{ ok: true; data: T } | { ok: false; problem: FetchProblem }> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
  } catch {
    return { ok: false, problem: { status: 0, error: 'Network error — could not reach the server.' } };
  }
  let body: unknown = null;
  let parsed = true;
  try {
    body = await res.json();
  } catch {
    parsed = false;
  }
  if (!res.ok) {
    const j = (body ?? {}) as { error?: string; accounts_role?: AccountsRoleState };
    return {
      ok: false,
      problem: {
        status: res.status,
        error: parsed
          ? j.error || `HTTP ${res.status}`
          : `The server answered ${res.status} without a message — the request may have been refused by the proxy before it reached the app.`,
        accounts_role: j.accounts_role,
      },
    };
  }
  if (!parsed) {
    return { ok: false, problem: { status: res.status, error: 'The server sent something that was not JSON.' } };
  }
  return { ok: true, data: body as T };
}

/**
 * Read EVERY page of the register for a query, not just the first.
 *
 * Two screens need the whole set rather than one page: the Accounts queue sorts
 * oldest-first (a sort over page 1 alone would put the second-oldest bill on
 * page 2 and call the wrong one "longest waiting"), and the CSV export must be
 * the filter the user is looking at, not its first 50 rows.
 *
 * pageSize=200 is the route's own ceiling (route.ts:88). The page cap is a
 * guard, not a limit anyone is expected to hit — `capped` is returned so the
 * screen can say so out loud rather than quietly truncating.
 */
export async function getAllPages(
  baseUrl: string,
  maxPages = 10,
): Promise<{ ok: true; rows: HandoverRow[]; head: ListPayload; capped: boolean } | { ok: false; problem: FetchProblem }> {
  const rows: HandoverRow[] = [];
  let head: ListPayload | null = null;
  let page = 1;
  let capped = false;
  for (;;) {
    const sep = baseUrl.includes('?') ? '&' : '?';
    const r = await getJson<ListPayload>(`${baseUrl}${sep}page=${page}&pageSize=200`);
    if (!r.ok) return { ok: false, problem: r.problem };
    if (!head) head = r.data;
    rows.push(...(r.data.rows || []));
    if (rows.length >= (r.data.total ?? rows.length) || (r.data.rows || []).length === 0) break;
    page += 1;
    if (page > maxPages) {
      capped = true;
      break;
    }
  }
  return { ok: true, rows, head: head as ListPayload, capped };
}

/* ════════════════════════════════════════════════════════════════════════════
   CHROME
   ════════════════════════════════════════════════════════════════════════════ */

const STATUS_STYLE: Record<BhStatus, { bg: string; border: string; text: string; Icon: typeof Clock }> = {
  pending_submission: { bg: 'bg-[#FFF8F0]', border: 'border-[#E8D5C4]', text: 'text-[#8B7355]', Icon: Clock },
  submitted: { bg: 'bg-[#FFF1E3]', border: 'border-[#D4B896]', text: 'text-[#8a3506]', Icon: Hourglass },
  received: { bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-800', Icon: BadgeCheck },
  void: { bg: 'bg-[#F3EEE7]', border: 'border-[#E0D0BE]', text: 'text-[#B8A590]', Icon: Ban },
};

export function StatusChip({
  status,
  labels,
  long = false,
}: {
  status: BhStatus;
  labels?: SummaryPayload['labels'];
  long?: boolean;
}) {
  const st = STATUS_STYLE[status] ?? STATUS_STYLE.pending_submission;
  const table = long ? labels?.long ?? BH_LABEL_LONG : labels?.short ?? BH_LABEL_SHORT;
  const { Icon } = st;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${st.bg} ${st.border} ${st.text}`}
    >
      <Icon className="w-3 h-3 shrink-0" />
      {table[status] ?? status}
    </span>
  );
}

export function WaitChip({ w }: { w: Waited }) {
  if (!w.label) return null;
  const tone =
    w.tone === 'overdue'
      ? 'bg-red-50 border-red-200 text-red-700'
      : w.tone === 'attention'
        ? 'bg-amber-50 border-amber-200 text-amber-800'
        : 'bg-[#FFF8F0] border-[#E8D5C4] text-[#8B7355]';
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${tone}`}>
      <Clock className="w-3 h-3 shrink-0" />
      {w.label}
    </span>
  );
}

/** The register's start date, in the owner's terms. `notice` is the SERVER's
 *  sentence and is rendered verbatim — the screens must not re-word where the
 *  register begins, because that sentence is the answer to "why is this page
 *  empty on day one". */
export function CutoffNotice({ cutoff }: { cutoff: CutoffState | null | undefined }) {
  if (!cutoff) return null;
  const bad = !cutoff.ready;
  return (
    <div
      className={`rounded-lg border px-3 py-2 text-[11px] leading-relaxed flex items-start gap-2 ${
        bad ? 'bg-amber-50 border-amber-300 text-amber-900' : 'bg-[#FFF8F0] border-[#E8D5C4] text-[#6B5744]'
      }`}
    >
      {bad ? <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" /> : <Info className="w-3.5 h-3.5 mt-px shrink-0" />}
      <span>
        {cutoff.notice}
        {cutoff.ready && cutoff.committed_at && (
          <span className="block text-[10px] text-[#B8A590] mt-0.5">
            Start date recorded {fmtIST(cutoff.committed_at)} and never re-computed.
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * "IF THE ACCOUNTS ROLE DOES NOT EXIST YET, SAY SO ON SCREEN IN PLAIN WORDS."
 *
 * THE ORDER MATTERS AND IT IS WHY THIS TEXT LIVES HERE AND NOWHERE ELSE.
 * Settings → Roles builds its checkbox grid from PAGE_CATALOG at build time. If
 * the owner creates the role BEFORE these pages are deployed he cannot see a
 * "Bill Handover" checkbox, saves with nothing ticked, and the roles route's
 * cleanPages([]) returns null — which the schema reads as ALL PAGES (109 of 166
 * at staff tier). Putting the instruction only on a page he can reach after the
 * catalog is live makes the safe order the only order he can physically follow.
 *
 * `state` is DIAGNOSIS. The gate is the route's own check on the session's
 * resolved role name; nothing on this screen decides anything.
 */
export function AccountsRoleBanner({
  state,
  viewerCanConfirm,
}: {
  state: AccountsRoleState | null | undefined;
  viewerCanConfirm: boolean;
}) {
  if (!state) return null;

  // The role exists, is live, and is spelled exactly right. Nothing to say.
  if (state.exists && state.is_active && state.stored_name === ACCOUNTS_ROLE_NAME) return null;

  const roleList = state.all_role_names.length ? state.all_role_names.join(', ') : '(none)';

  if (!state.exists) {
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-3 text-[12px] leading-relaxed text-amber-900">
        <div className="flex items-start gap-2">
          <ShieldAlert className="w-4 h-4 mt-px shrink-0" />
          <div className="space-y-2">
            <p className="font-semibold">
              No “{ACCOUNTS_ROLE_NAME}” role exists yet — only Administrators can confirm bills right now.
            </p>
            <p>
              To let your accounts team confirm receipts, go to <b>Settings → Roles → New Role</b> and create a role
              named exactly{' '}
              <code className="px-1 py-0.5 rounded bg-white border border-amber-300 font-mono">{ACCOUNTS_ROLE_NAME}</code>{' '}
              — one word, tier <b>Staff</b>. On the page list, tick <b>{ACCOUNTS_PAGE_LABEL}</b> and{' '}
              <b>{HISTORY_PAGE_LABEL}</b>. Then assign that role to your accounts staff in <b>Settings → Users</b>.
            </p>
            <p className="text-[11px]">
              Two things worth knowing before you do it. Pick <b>Staff</b>, not Manager: a Manager-tier role counts as
              management everywhere else in the app and would reach the sales and HR pages as well. And tick at least
              one page — a role saved with nothing ticked is stored as “no restrictions”, which grants every page
              rather than none.
            </p>
            <p className="text-[11px] text-amber-800">Roles that exist today: {roleList}</p>
            {viewerCanConfirm && (
              <p className="text-[11px] text-amber-800">
                You can confirm bills in the meantime because you are an Administrator. The feature is not blocked —
                but every confirmation will be stamped with your name until the role exists.
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (state.stored_name !== ACCOUNTS_ROLE_NAME) {
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-3 text-[12px] leading-relaxed text-amber-900">
        <div className="flex items-start gap-2">
          <Info className="w-4 h-4 mt-px shrink-0" />
          <div>
            <p className="font-semibold">
              Your role is stored as “{state.stored_name}”, not “{ACCOUNTS_ROLE_NAME}”.
            </p>
            <p className="mt-1">
              That still works — the match ignores case and stray spaces — but renaming it to exactly{' '}
              <b>{ACCOUNTS_ROLE_NAME}</b> in <b>Settings → Roles</b> keeps it obvious to whoever reads this next.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Exists, spelled right, but deactivated.
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-3 text-[12px] leading-relaxed text-amber-900">
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 mt-px shrink-0" />
        <div>
          <p className="font-semibold">
            The “{ACCOUNTS_ROLE_NAME}” role is deactivated — and its holders can still confirm bills.
          </p>
          <p className="mt-1">
            Deactivating a role does not revoke it here. That is how every role in this app behaves: a deactivated role
            keeps governing its holders, because the alternative drops them to “no restrictions”, which is wider still.
            To actually take the Accounts side away from someone, remove the role from that user in{' '}
            <b>Settings → Users</b>.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ── the dashboard ───────────────────────────────────────────────────────── */

export interface TileSpec {
  status: BhStatus;
  hint: string;
}

const TILES: TileSpec[] = [
  { status: 'pending_submission', hint: 'Recorded by the store, not yet handed over' },
  { status: 'submitted', hint: 'Handed to Accounts, awaiting their confirmation' },
  { status: 'received', hint: 'Accounts confirmed the bill arrived' },
];

/**
 * Pending Submission / Submitted to Accounts / Received by Accounts.
 *
 * WHY THE DAY-ONE BACKLOG CANNOT APPEAR HERE. Every figure is a GROUP BY over
 * bill_handovers bounded by the recorded cutoff; nothing reads `purchases`, and
 * the owner's 2,121 identity-less purchase rows are not handover rows. The one
 * figure derived from elsewhere is `not_yet_recorded` (goods receipts on/after
 * the cutoff with no handover record) and it is shown as its OWN number below
 * the three, never added into Pending.
 */
export function DashboardTiles({
  summary,
  active,
  onPick,
}: {
  summary: SummaryPayload | null;
  active?: BhStatus | 'all' | 'open' | null;
  onPick?: (s: BhStatus) => void;
}) {
  const counts = summary?.counts;
  const values = summary?.values;
  const labels = summary?.labels;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      {TILES.map((t) => {
        const n = counts?.[t.status] ?? 0;
        const v = values?.[t.status] ?? 0;
        const st = STATUS_STYLE[t.status];
        const { Icon } = st;
        const isActive = active === t.status;
        const body = (
          <>
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[#6B5744]">
              <Icon className={`w-3.5 h-3.5 ${st.text}`} />
              {(labels?.short ?? BH_LABEL_SHORT)[t.status]}
            </div>
            <div className="text-2xl font-bold text-[#2D1B0E] mt-1 tabular-nums">{n}</div>
            <div className="text-[11px] text-[#8B7355] tabular-nums">{money(v)}</div>
            <div className="text-[10px] text-[#B8A590] mt-1 leading-snug">{t.hint}</div>
          </>
        );
        const cls = `text-left rounded-lg border px-3 py-2.5 transition ${
          isActive ? 'border-[#af4408] bg-[#FFF1E3] ring-1 ring-[#af4408]' : 'border-[#E8D5C4] bg-white'
        }`;
        return onPick ? (
          <button
            key={t.status}
            type="button"
            onClick={() => onPick(t.status)}
            className={`${cls} hover:border-[#C0A98F]`}
          >
            {body}
          </button>
        ) : (
          <div key={t.status} className={cls}>
            {body}
          </div>
        );
      })}
    </div>
  );
}

/** The leak detector, shown apart from the three states on purpose. */
export function UnrecordedNote({ summary }: { summary: SummaryPayload | null }) {
  const n = summary?.not_yet_recorded ?? 0;
  if (!n) return null;
  return (
    <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] px-3 py-2 text-[11px] text-[#6B5744] flex items-start gap-2">
      <FileText className="w-3.5 h-3.5 mt-px shrink-0 text-[#8B7355]" />
      <span>
        <b>{n}</b> goods receipt{n === 1 ? ' has' : 's have'} no bill record at all — the store has not answered the
        quality-check prompt for {n === 1 ? 'it' : 'them'} yet. This is counted separately and is deliberately{' '}
        <b>not</b> part of Pending Submission; the store screen offers each one a “record this bill” action.
      </span>
    </div>
  );
}

/* ── the record drawer ───────────────────────────────────────────────────── */

const ACTION_WORD: Record<string, string> = {
  created: 'Recorded by the store',
  submitted: 'Submitted to Accounts',
  confirmed: 'Confirmed received by Accounts',
  voided: 'Voided',
  attachment_added: 'Bill scan attached',
  attachment_removed: 'Bill scan removed',
};

/**
 * One bill's whole handover history — the audit trail the owner asked for, in
 * the order it happened, with the actor's name and role on every line. Nothing
 * is ever deleted from it, and a voided record keeps every stamp it had.
 */
export function RecordDrawer({
  id,
  onClose,
  onChanged,
  labels,
}: {
  id: string;
  onClose: () => void;
  onChanged?: () => void;
  labels?: SummaryPayload['labels'];
}) {
  const [data, setData] = useState<DetailPayload | null>(null);
  const [files, setFiles] = useState<AttachmentMeta[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** Bumped by the reload button to re-run the fetch below. */
  const [nonce, setNonce] = useState(0);

  /**
   * The fetch lives INSIDE the effect, in an async closure, and every setState
   * happens after an `await` and behind an `alive` check.
   *
   * Not an extracted `load()` the effect calls: a setState reachable
   * synchronously from an effect body cascades renders, which is what
   * react-hooks/set-state-in-effect refuses — and `alive` also stops a slow
   * response for the row the reader just closed from landing on the row they
   * opened next.
   */
  useEffect(() => {
    let alive = true;
    void (async () => {
      const r = await getJson<DetailPayload>(`/api/bill-submissions/${encodeURIComponent(id)}`);
      if (!alive) return;
      if (!r.ok) {
        setErr(r.problem.error);
        setData(null);
        setLoading(false);
        return;
      }
      setErr(null);
      setData(r.data);
      const f = await getJson<{ files: AttachmentMeta[] }>(
        `/api/bill-submissions/${encodeURIComponent(id)}/attachment?list=1`,
      );
      if (!alive) return;
      setFiles(f.ok ? f.data.files || [] : []);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [id, nonce]);

  // Escape closes. A drawer that traps a reader on a touch device is worse than
  // no drawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const r = data?.handover;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div
        className="w-full max-w-lg h-full overflow-y-auto bg-[#FFFCF8] border-l border-[#E8D5C4] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-[#FFFCF8] border-b border-[#E8D5C4] px-4 py-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-[#2D1B0E] truncate">{r ? billTitle(r) : 'Bill record'}</h2>
            <p className="text-[11px] text-[#8B7355] truncate">{r?.vendor_name || '—'}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded hover:bg-[#FFF1E3] text-[#8B7355] shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {loading && (
            <div className="flex items-center gap-2 text-[12px] text-[#8B7355]">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading the handover history…
            </div>
          )}
          {err && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-800">{err}</div>
          )}

          {r && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <StatusChip status={r.status} labels={labels} long />
                {r.status === 'submitted' && <WaitChip w={waitedSince(r.submitted_at)} />}
              </div>

              <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-[12px]">
                <Field label="Bill Number" value={r.bill_no || '— none on the paper —'} />
                <Field label="Vendor" value={r.vendor_name || '—'} />
                <Field label="Bill Value" value={money(r.bill_value)} />
                <Field label="Bill Date (printed)" value={r.bill_date ? fmtISTDate(r.bill_date) : '—'} />
                <Field label="Received" value={fmtISTDate(r.received_date)} />
                <Field label="Goods Receipt" value={r.grn_number || (r.source === 'manual' ? 'Manual entry' : '—')} />
                {r.invoice_id ? <Field label="Our invoice id" value={r.invoice_id} /> : null}
                <Field label="Register starts" value={r.cutoff_date || '—'} />
              </dl>

              <div className="rounded-lg border border-[#E8D5C4] bg-white divide-y divide-[#F3EEE7]">
                <Stamp
                  title="Store Submission"
                  who={r.submitted_by_name || r.submitted_by_email}
                  when={r.submitted_at}
                  missing="Not handed over yet"
                />
                <Stamp
                  title="Accounts Confirmation"
                  who={r.confirmed_by_name || r.confirmed_by_email}
                  when={r.confirmed_at}
                  missing="Not confirmed yet"
                />
              </div>

              {r.status === 'void' && (
                <div className="rounded-lg border border-[#E0D0BE] bg-[#F3EEE7] px-3 py-2 text-[12px] text-[#6B5744]">
                  <p className="font-semibold text-[#8B7355]">Voided — kept as a record, not deleted</p>
                  <p className="mt-1">{r.void_reason || 'No reason recorded.'}</p>
                  <p className="text-[11px] text-[#B8A590] mt-1">
                    {r.voided_by_name || '—'} · {fmtIST(r.voided_at)}
                  </p>
                </div>
              )}

              {r.note ? (
                <div className="rounded-lg border border-[#E8D5C4] bg-white px-3 py-2 text-[12px] text-[#6B5744]">
                  <span className="text-[10px] uppercase tracking-wide text-[#B8A590] block">Note</span>
                  {r.note}
                </div>
              ) : null}

              <div>
                <h3 className="text-[11px] font-bold uppercase tracking-wide text-[#8B7355] mb-1.5 flex items-center gap-1">
                  <Paperclip className="w-3 h-3" /> Bill scan
                </h3>
                {files.length === 0 ? (
                  <p className="text-[11px] text-[#B8A590]">
                    No scan attached. The attachment is optional — the bill number, vendor and the two timestamps are
                    the evidence; a photo only corroborates them.
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {files.map((f) => (
                      <li key={f.id} className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="truncate text-[#6B5744]">{f.filename}</span>
                        <a
                          href={`/api/bill-submissions/${encodeURIComponent(id)}/attachment?file_id=${encodeURIComponent(f.id)}`}
                          className="inline-flex items-center gap-1 text-[#af4408] hover:underline shrink-0"
                        >
                          <Download className="w-3 h-3" /> {bytes(f.size_bytes)}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <h3 className="text-[11px] font-bold uppercase tracking-wide text-[#8B7355] mb-1.5">
                  Handover history
                </h3>
                <ol className="space-y-2">
                  {(data?.trail ?? []).map((e) => (
                    <li key={e.id} className="relative pl-4 text-[12px]">
                      <span className="absolute left-0 top-1.5 w-1.5 h-1.5 rounded-full bg-[#C0A98F]" />
                      <span className="font-semibold text-[#2D1B0E]">{ACTION_WORD[e.action] ?? e.action}</span>
                      <span className="block text-[11px] text-[#6B5744]">
                        {e.actor_name || e.actor_email || 'Unknown'}
                        {e.actor_role ? ` · ${e.actor_role}` : ''}
                      </span>
                      <span className="block text-[10px] text-[#B8A590]">{fmtIST(e.at)}</span>
                      {e.note ? <span className="block text-[11px] text-[#8B7355] mt-0.5">{e.note}</span> : null}
                    </li>
                  ))}
                  {(data?.trail ?? []).length === 0 && (
                    <li className="text-[11px] text-[#B8A590]">No history rows.</li>
                  )}
                </ol>
              </div>

              {onChanged ? (
                <button
                  type="button"
                  onClick={() => {
                    setLoading(true);
                    setNonce((n) => n + 1);
                    onChanged();
                  }}
                  className="text-[11px] text-[#af4408] hover:underline"
                >
                  Reload this record
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-[#B8A590]">{label}</dt>
      <dd className="text-[#2D1B0E] font-medium break-words">{value}</dd>
    </div>
  );
}

function Stamp({
  title,
  who,
  when,
  missing,
}: {
  title: string;
  who: string;
  when: string | null;
  missing: string;
}) {
  return (
    <div className="px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-[#B8A590]">{title}</div>
      {when ? (
        <>
          <div className="text-[12px] font-semibold text-[#2D1B0E]">{fmtIST(when)}</div>
          <div className="text-[11px] text-[#6B5744]">{who || '—'}</div>
        </>
      ) : (
        <div className="text-[12px] text-[#B8A590] italic">{missing}</div>
      )}
    </div>
  );
}

/** Shared "you cannot see this" panel. The API is the real boundary; this just
 *  renders its sentence instead of a blank screen. */
export function DeniedPanel({ message }: { message: string }) {
  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="rounded-lg border border-[#E8D5C4] bg-white px-4 py-4 text-[13px] text-[#6B5744] flex items-start gap-2">
        <ShieldAlert className="w-4 h-4 mt-px shrink-0 text-[#af4408]" />
        <div>
          <p className="font-semibold text-[#2D1B0E]">This page is not open to your account.</p>
          <p className="mt-1">{message}</p>
        </div>
      </div>
    </div>
  );
}

/** The one scope boundary v1 has, said out loud rather than implied. */
export function LiquorScopeNote() {
  return (
    <p className="text-[10px] text-[#B8A590] leading-relaxed">
      This register covers vendor bills that come through goods receipts. Liquor / TGBCL indents are inwarded on their
      own rail and do <b>not</b> appear here, so this is not a complete list of every bill the business receives.
    </p>
  );
}

export { CheckCircle2 };
