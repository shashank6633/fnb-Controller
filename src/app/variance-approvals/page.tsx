'use client';

/**
 * Variance Approvals (ADMIN only).
 *
 * A closing physical count that disagrees with the system lands here. The admin
 * asks the staff who counted, records the reason, and either APPROVES or REJECTS
 * (stock stays; the variance stands as an open loss to investigate). Route is
 * adminOnly in the page catalog and every API is admin-gated server-side.
 *
 * ── WHAT CHANGED, AND WHY THE OLD HEADLINE HAD TO GO ──────────────────────
 * This page used to say, at the top, "Nothing changes stock until you approve."
 * That is no longer true and it was never true for every row:
 *   · THE BAR (2026-08). An admin can set a rupee and/or quantity bar. A
 *     variance at or under it is APPLIED AT COUNT TIME and arrives here already
 *     approved, marked `auto_applied`, reviewed by the literal string
 *     "system:auto-apply" — not a person. Above the bar the stock is HELD: the
 *     count is recorded and visible, and the figure does not move until an admin
 *     approves it. Default is 0 = OFF on every axis, so an unconfigured system
 *     behaves exactly as before (everything is held).
 *   · DEPARTMENT COUNTS never obeyed that sentence. Saving a department count
 *     re-anchors that department's own balance immediately (dept-ledger
 *     latestCount), which is why varianceApprovalBlock refuses to approve them —
 *     approving would take the difference off twice. Those rows are here to be
 *     CLEARED, not posted; and clearing them does not put the balance back
 *     either, because it moved when the count was saved.
 *     AS OF 2026-08 NO NEW DEPARTMENT ROW ARRIVES HERE. recordCountVariance
 *     refuses to park one (outcome 'anchored'), precisely because this page
 *     could only ever lie about it. Every department row still on screen is a
 *     LEGACY row from before that change — bulk reject is what clears them.
 * The strip below now says both of those out loud. Do not restore the old line.
 *
 * APPROVE IS A DELTA, NEVER AN ABSOLUTE SET — and this page must not say
 * otherwise. approveVariance() posts the COUNT-TIME difference
 * (physical − system-as-counted) on top of whatever the rail holds at the moment
 * the admin clicks, so the balance lands on the counted figure PLUS anything
 * that moved in between. Worked example: system 5,000 g, counted 10,000 g at
 * 10:00; a 2,000 g issue at 12:00 takes live stock to 3,000; approving at 16:00
 * gives 8,000 g, not 10,000. That is deliberate — see the header comment in
 * lib/variance-approval.ts for why it is the only reading under which stock
 * moves exactly once — and it holds on all three rails (central, liquor ledger,
 * department ledger), because each posts the count-time difference to its own.
 *
 * TWO COUNTS ON ONE ITEM DOUBLE-APPLY — the queue must say so before the click.
 * Each pending row froze its OWN system figure, and the pending-unique index is
 * keyed per DATE, so two counts on two dates are two independent rows that both
 * froze the SAME baseline. Owner's measured case (Testing Curd 2, g/kg pack
 * 1000, live −997 g): 07-08 counted 997 → delta +1,994; 08-08 counted 11,000 →
 * delta +11,997. Approving 08-08 lands 11,000 g = 11 kg, the shelf. Approving
 * 07-08 on top lands 12,994 g — the −997 baseline corrected a second time, and
 * it overstates, i.e. it inflates in the direction that HIDES a shortage.
 * So the server refuses any count that a newer pending/approved one supersedes
 * (findSupersedingCount / varianceApprovalBlock), and this page renders that
 * refusal THREE ways: a queue-level banner from `stacked`, a "Superseded" pill
 * and amber notice per row, and a disabled Approve whose label names the reason.
 * Reject stays live on those rows — rejecting is exactly how a stale count is
 * meant to leave the queue, and it moves no stock.
 *
 * THE PROJECTION IS COMPUTED FROM LIVE STOCK WHERE THE SERVER CAN SUPPLY IT.
 * `live_stock` arrives per row on its OWN rail (central → raw_materials.current_stock,
 * liquor → its store-ledger on-hand, department → null, because a dept balance
 * has no set-based source and guessing one would be wrong on that whole rail).
 * Where it is non-null the tile shows live + (physical − system), which is where
 * approval actually lands; where it is null the old count-time figure and its
 * caveat stay. A stale projection is what made the owner trust a number that had
 * already been overtaken — do not print one that cannot be computed.
 *
 * ── A MONTHLY JOB, NOT A DAILY ONE ────────────────────────────────────────
 * Closing stock is uploaded WEEKLY and reviewed ONCE A MONTH. So the queue is
 * addressable by PERIOD and by UPLOAD, and clearable in BULK — 1,472 rows is
 * not 1,472 clicks. Two API surfaces feed that:
 *   GET  /api/variance-approvals?status=…&outlet=…&limit=…
 *          → the rows, `total`/`truncated`, `pending_count`, `stacked`
 *   GET  /api/variance-approvals/bulk?batches=1        → the uploads + ₹ pending
 *   GET  /api/variance-approvals/bulk?from=&to=&batch_id=&source=&outlet=
 *          → PREVIEW: how many PENDING rows that exact filter selects
 *   POST /api/variance-approvals/bulk {action:'reject', reason, ids|filter, expect_count}
 *
 * WHY THE LIST IS FILTERED IN THE BROWSER AND THE COUNT IS NOT. The list
 * endpoint does not yet take from/to/batch_id/source (that pass-through is a
 * companion change in a file this page does not own), so the rows on screen are
 * narrowed here. That is fine for READING and would be a lie for DECIDING, so
 * every number the bulk confirmation quotes comes from the server's own preview
 * of the identical filter, and the POST carries the `expect_count` it reported.
 * Where the row list is a truncated slice, the ₹ figures derived from it are
 * printed with a "≥" and say so. Never quote a client-side count in a dialog
 * that is about to change 1,472 rows.
 *
 * ── APPROVE AND REJECT MUST NOT LOOK ALIKE ────────────────────────────────
 * Approve WRITES TO STOCK. Reject discards the count and leaves every rail
 * untouched. They are given different weight, different colour, different icon
 * and different verbs: Approve is the solid brand-orange primary and says "write
 * to stock"; Reject is a light neutral outline and says "discard · stock
 * unchanged". Red is NOT used for Reject — it sits one hue from #af4408 and the
 * two read as the same button at a glance, which is the exact confusion that
 * would write 793 false "we have zero" counts into the books.
 * THERE IS NO BULK APPROVE, here or in the API (the function is not imported
 * into that route at all). The bulk bar says so, so nobody goes looking.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import {
  ScrollText, ShieldCheck, Loader2, RefreshCw, CheckCircle2, XCircle,
  AlertTriangle, Info, Lock, PackageX, PackagePlus, Store, Boxes, Layers,
  CalendarDays, Filter, Trash2, ClipboardList, SlidersHorizontal, Save, X,
  ChevronDown, ChevronRight, ListChecks, Zap,
} from 'lucide-react';
import { packFactor, toPurchaseQty, type PackMeta } from '@/lib/pack-units';
import { todayIST } from '@/lib/format-date';

interface Approval {
  id: string; source: 'central' | 'liquor'; material_id: string; material_name: string; material_sku: string;
  store_id: string; store_name: string; department_id: string; department_name: string;
  date: string; system_stock: number; physical_stock: number; variance: number; variance_value: number;
  unit: string; counted_by: string; count_note: string;
  status: string; reviewed_by: string; reviewed_at: string; review_reason: string; created_at: string;
  /**
   * Server-side refusal reason for Approve, verbatim — the SAME sentence the
   * approve API answers with, so the queue can never offer a click the server
   * rejects. Two families now reach it: a department count that has no honest
   * ledger to correct, and a count SUPERSEDED by a newer one. Rendered as-is; do
   * not re-word it here or the page and the API start telling different stories.
   */
  approve_blocked?: string | null;
  /**
   * The newest count competing with this row, or null when this row IS newest.
   * Non-null ⇒ `approve_blocked` is already the supersede sentence; these two
   * exist so the page can say WHICH count wins without parsing that sentence.
   */
  superseded_by_date?: string | null;
  superseded_by_status?: 'pending' | 'approved' | null;
  /**
   * Live on-hand for THIS ROW'S rail, in the same recipe-unit basis as
   * system_stock / physical_stock beside it. null on department rows — an
   * honest gap, not a zero: never coerce it with `|| 0`, that would render a
   * confident "projected 0" on every department count.
   */
  live_stock?: number | null;
  /**
   * 1 ⇒ the BAR applied this row at count time; NO HUMAN DECIDED IT. Read this
   * before rendering `reviewed_by` as a person — on these rows it is the literal
   * string "system:auto-apply". The admin's own "Adjust system stock" tick is
   * NOT auto (a person chose), so it stays 0.
   */
  auto_applied?: number;
  /** The submit this count arrived in. '' = saved before batches existed. */
  batch_id?: string;
  batch_label?: string;
}

/** One material carrying more than one pending count — GET → `stacked`. */
interface StackedItem {
  material_id: string;
  material_name: string;
  pending_count: number;
  latest_date: string;
}

/** One upload, as the monthly review picks it — GET /bulk?batches=1. */
interface CountBatch {
  batch_id: string;
  batch_label: string;
  first_date: string;
  last_date: string;
  uploaded_at: string;
  pending: number;
  approved: number;
  rejected: number;
  /** Sum of |variance_value| over the PENDING rows of this upload. */
  pending_value: number;
}

/** The server's preview of a filter — the ONLY count a bulk dialog may quote. */
interface BulkPreview {
  matched: number;
  expect_count: number;
  filter: { from: string | null; to: string | null; batch_id: string | null; source: string | null; outlet: string };
  sample: Approval[];
}

/**
 * GET /api/closing-stock/variance-bar — TWO axes, both auto-apply.
 *
 * There used to be two more, `alert_value` and `alert_pct`, and a client twin of
 * the server's isBigVariance() that read them to paint a per-row "Large — look
 * now" pill. Both keys and both functions are DELETED. Measured against the
 * owner's own incident sheet a ₹5,000 / 25% alert fired on 390 of 451 rows
 * (86%), because "counted zero against a small book stock" is 100% by
 * arithmetic and a restaurant runs out of herbs every week — no threshold
 * survives that distribution. The replacement is the upload digest rendered
 * below: one per count, always, with no bar deciding whether it speaks.
 * DO NOT RE-ADD A CLIENT-SIDE ROW CLASSIFIER HERE.
 */
interface BarPayload {
  bar: { bar_value: number; bar_qty: number };
  limits: { bar_value: number; bar_qty: number };
  auto_apply_enabled: boolean;
  /**
   * The FIXED guards, served by the API rather than written here as literals, so
   * a number copied into a .tsx cannot drift from the rule the server actually
   * enforces. Optional so an older server (or a failed read) simply omits the
   * paragraph that quotes them rather than throwing.
   */
  guards?: {
    auto_apply_max_value: number;
    auto_apply_batch_value: number;
    auto_apply_batch_rows: number;
  };
}

/**
 * One Action-Inbox bucket, from GET /api/notifications/inbox. Declared here to
 * READ the digest items the bell already carries; the shape is the server's
 * (route.ts:38) and is duplicated the same way in NotificationBell and
 * CaptainAlertsProvider.
 */
interface InboxItem { key: string; label: string; count: number; href: string }
/**
 * The inbox key prefix the digest bucket pushes: `closing_digest:<count key>`,
 * where the count key is `date|outlet|rail` — one item per COUNT, not per save.
 */
const DIGEST_KEY = 'closing_digest:';

/** How many stacked items the banner names before it rolls up the rest. */
const STACKED_SHOWN = 8;
/** 3 dp — the rounding approveVariance applies to the delta it posts. */
const r3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;
/** Float slack. Below this, live and the frozen system figure are the same number. */
const EPS = 1e-6;
/** The literal reviewer the bar writes. Not a person — see `auto_applied`. */
const AUTO_REVIEWER = 'system:auto-apply';
/**
 * Rows asked for in one read — the SAME 500 this page has always requested.
 * Deliberately not raised to the API's 1,000 ceiling: listVarianceApprovals runs
 * varianceApprovalBlock() per row, and on department rows that means a deptOnHand
 * window each, so doubling the read doubles that work on a queue of 1,472. There
 * is no offset either, so a bigger number is not a page — it only moves where the
 * cut falls. What reaches the rows past it is the FILTER (narrow to one upload or
 * one month) and the bulk action, which the server resolves over the whole queue
 * and not over this slice.
 */
const PAGE_LIMIT = 500;

const inr = (v: number) => '₹' + Math.abs(Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const inr0 = (v: number) => '₹' + Math.abs(Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const qty = (v: number) => Number(Number(v || 0).toFixed(3)).toLocaleString('en-IN');
const num = (v: number) => (Number(v) || 0).toLocaleString('en-IN');
/**
 * The two pack fields listVarianceApprovals() joins on but `Approval` above has
 * never declared. Optional on purpose: a cached pre-conversion payload can
 * arrive without them, and packFactor() already degrades to 1 (no conversion)
 * when they are missing — which is the honest reading, not a silent divide.
 */
type ApprovalWire = Approval & { material_purchase_unit?: string; material_pack_size?: number };
/** Pack meta for the purchase-unit display layer, read in ONE place. */
const metaOf = (r: Approval): PackMeta => ({
  unit: r.unit,
  purchase_unit: (r as ApprovalWire).material_purchase_unit,
  pack_size: (r as ApprovalWire).material_pack_size,
});
/** Purchase unit to print beside a converted quantity (falls back to recipe). */
const puOf = (r: Approval): string => (r as ApprovalWire).material_purchase_unit || r.unit;
function istWhen(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso.includes('Z') || iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return iso || '—';
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
}

/**
 * Calendar month bounds around an IST date-only string, built from UTC parts.
 * `new Date('2026-08-01')` read with LOCAL getters lands on 31 Jul for anyone
 * west of Greenwich, which would quietly shift a monthly review by a day.
 */
const pad2 = (n: number) => String(n).padStart(2, '0');
function monthBounds(iso: string, monthsBack: number): { from: string; to: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return { from: '', to: '' };
  const start = new Date(Date.UTC(+m[1], +m[2] - 1 - monthsBack, 1));
  const end = new Date(Date.UTC(+m[1], +m[2] - monthsBack, 0));
  const f = (d: Date) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  return { from: f(start), to: f(end) };
}
const monthLabel = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return iso;
  return new Date(Date.UTC(+m[1], +m[2] - 1, 1))
    .toLocaleDateString('en-IN', { timeZone: 'UTC', month: 'long', year: 'numeric' });
};

/* ── THE COUNT DIGEST ───────────────────────────────────────────────────────
 * The bell item `closing_digest:<date|outlet|rail>` lands on THIS page, and the
 * bell is a 288px dropdown that renders a label and a count pill and nothing
 * else — so a long digest sentence is a wall of text there and a readable block
 * here. This is where it is meant to be read.
 *
 * EVERY FIGURE IS THE SERVER'S OWN TEXT, UNPARSED AND UNFORMATTED.
 * countDigestLabel() (lib/variance-approval.ts) builds the sentence beside the
 * numbers it describes, precisely so the bell and the page cannot drift; the
 * previous occupant of this spot was a client-side twin of a server rule, and
 * re-deriving anything here would repeat that mistake. So this function does
 * ONE thing: it cuts the sentence at separators the server itself emitted, to
 * lay the same words out on their own lines. No number is read, rounded,
 * re-formatted or recomputed — ₹ grouping, the − sign and the PURCHASE units
 * are all as the server wrote them.
 *
 * THE SEPARATORS ARE SAFE BECAUSE THE SERVER MAKES THEM SAFE. Material names,
 * units and store names are typed by people and could carry a '·' or a ';';
 * safeText() in countDigestLabel() strips those from every piece of free text
 * before it enters the sentence. This comment used to claim instead that names
 * "could not plausibly" carry a separator, which was simply false — a store
 * named "BAR · FLOOR 2" split the upload's own identity in half on screen.
 *
 * IT FAILS BACK TO THE WHOLE SENTENCE. Any marker it cannot find simply leaves
 * that section empty and the remainder rendered verbatim, so a re-worded label
 * degrades to one paragraph — never to a missing figure.
 */
const D_LARGEST = ' Largest: ';
const D_UNVALUED = ' Not valued: ';
const D_BASIS = ' Valued at last purchase';
interface DigestParts {
  /** "Closing count <date> — N counted, M differed" */
  head: string;
  /** "total variance −₹6,024", "2 held for approval …", one per line. */
  lines: string[];
  /** The three biggest, each already named with quantity and value. */
  largest: string[];
  /** Real differences carrying no rupee figure, named with their quantity. */
  unvalued: string[];
  /** Which rung each valued line came off, and why the queue's tile differs. */
  basis: string;
}
function splitDigest(label: string): DigestParts {
  let s = String(label || '').trim();
  // Cut from the TAIL forwards, so each marker is searched in a string that no
  // longer contains the sections after it.
  let basis = '';
  const b = s.lastIndexOf(D_BASIS);
  if (b >= 0) { basis = s.slice(b).trim(); s = s.slice(0, b).trim(); }
  let unvalued: string[] = [];
  const u = s.indexOf(D_UNVALUED);
  if (u >= 0) {
    unvalued = s.slice(u + D_UNVALUED.length)
      .replace(/\s*—\s*listed by quantity[^.]*\.?\s*$/, '')
      .replace(/\.\s*$/, '')
      .split('; ').filter(Boolean);
    s = s.slice(0, u).trim();
  }
  let largest: string[] = [];
  const l = s.indexOf(D_LARGEST);
  if (l >= 0) {
    largest = s.slice(l + D_LARGEST.length).replace(/\.\s*$/, '').split('; ').filter(Boolean);
    s = s.slice(0, l).trim();
  }
  // The head and the totals were joined with ' · ' by the server, and every
  // piece of free text inside them went through safeText() first.
  const parts = s.replace(/\.\s*$/, '').split(' · ').map(p => p.trim()).filter(Boolean);
  return { head: parts[0] || s, lines: parts.slice(1), largest, unvalued, basis };
}

export default function VarianceApprovalsPage() {
  const [tab, setTab] = useState<'pending' | 'approved' | 'rejected'>('pending');
  const [rows, setRows] = useState<Approval[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [pendingElsewhere, setPendingElsewhere] = useState(0);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  // Queue-level, NOT derived from `rows`. The list carries a LIMIT while
  // stackedPendingCounts() sweeps every pending row, so deriving this client-side
  // would go quiet on exactly the overflow the limit hides — and that overflow is
  // the OLDEST pending counts, i.e. the ones most likely to be superseded.
  const [stacked, setStacked] = useState<StackedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 4000); };

  /* ── The monthly review: period + upload + rail ─────────────────────────── */
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  /** null = every upload. '' is a REAL selector: rows saved before batches. */
  const [batchId, setBatchId] = useState<string | null>(null);
  const [source, setSource] = useState<'' | 'central' | 'liquor'>('');
  const [allOutlets, setAllOutlets] = useState(false);
  const [batches, setBatches] = useState<CountBatch[]>([]);
  const [preview, setPreview] = useState<BulkPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewErr, setPreviewErr] = useState<string | null>(null);

  /* ── Bulk reject ───────────────────────────────────────────────────────── */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkMode, setBulkMode] = useState<'ids' | 'filter' | null>(null);
  const [bulkReason, setBulkReason] = useState('');
  const [bulkTyped, setBulkTyped] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkErr, setBulkErr] = useState<string | null>(null);

  /* ── The bar ───────────────────────────────────────────────────────────── */
  const [bar, setBar] = useState<BarPayload | null>(null);
  const [barOpen, setBarOpen] = useState(false);
  const [barDraft, setBarDraft] = useState({ bar_value: '', bar_qty: '' });
  const [barBusy, setBarBusy] = useState(false);
  const [barMsg, setBarMsg] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);

  /* ── The count digests ─────────────────────────────────────────────────────
   * Read from the SAME bucket the bell reads — GET /api/notifications/inbox,
   * items keyed `closing_digest:<date|outlet|rail>` — so the sentence on this
   * page and the sentence in the bell are one string from one build, not two
   * renderings of the same idea. Newest first, ONE per count (not per save) and
   * window-bounded by recentCountDigests(); this page re-orders nothing. */
  const [digests, setDigests] = useState<InboxItem[]>([]);
  const [digestsMore, setDigestsMore] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setLoadError(null);
    try {
      const r = await fetch(`/api/variance-approvals?status=${tab}&limit=${PAGE_LIMIT}${allOutlets ? '&outlet=all' : ''}`);
      if (r.status === 401 || r.status === 403) { setForbidden(true); setRows([]); setStacked([]); return; }
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || 'Failed to load');
      setRows(j.approvals || []);
      // With ?outlet=all the badge must be the all-outlets number, not "here" —
      // adding the two together would double-count, since "all" contains "here".
      setPendingCount((allOutlets ? j.pending_count_all_outlets : j.pending_count) || 0);
      setPendingElsewhere(Number(j.pending_count_other_outlets) || 0);
      setTotal(Number(j.total) || 0);
      setTruncated(!!j.truncated);
      // Array.isArray, not `|| []`: an older cached/proxied payload that predates
      // this field must clear the banner, not leave the previous tab's warning
      // sitting over a queue it no longer describes.
      setStacked(Array.isArray(j.stacked) ? j.stacked : []);
      setSelected(new Set());
    } catch (e) { setLoadError((e as Error).message); }
    finally { setLoading(false); }
  }, [tab, allOutlets]);

  useEffect(() => { load(); }, [load]);

  /** The uploads, for the "which sheet" picker and the authoritative ₹ pending. */
  const loadBatches = useCallback(async () => {
    try {
      const r = await fetch(`/api/variance-approvals/bulk?batches=1${allOutlets ? '&outlet=all' : ''}`);
      if (!r.ok) return;                       // a batch list is a convenience, never a gate
      const j = await r.json();
      setBatches(Array.isArray(j.batches) ? j.batches : []);
    } catch { /* leave the previous list; the queue itself still loads */ }
  }, [allOutlets]);
  useEffect(() => { loadBatches(); }, [loadBatches]);

  const loadBar = useCallback(async () => {
    try {
      const r = await fetch('/api/closing-stock/variance-bar');
      if (!r.ok) return;
      const j = (await r.json()) as BarPayload;
      setBar(j);
      setBarDraft({
        bar_value: String(j.bar.bar_value || 0),
        bar_qty: String(j.bar.bar_qty || 0),
      });
    } catch { /* the bar panel simply does not render */ }
  }, []);
  useEffect(() => { loadBar(); }, [loadBar]);

  /**
   * The upload digests, straight off the notification bucket.
   *
   * A CONVENIENCE, NEVER A GATE — same rule as loadBatches above. A failed read
   * leaves the card off the page; it cannot block the queue, and nothing here
   * decides anything. The bucket is admin-gated server-side and this page is
   * adminOnly, so a non-admin never reaches either.
   *
   * SCOPE: the inbox takes no outlet parameter — it reports for the signed-in
   * outlet, exactly as the variance bucket beside it does. The "All outlets"
   * tick above widens the QUEUE and not this card, so the card says so when the
   * tick is on rather than letting the two silently describe different places.
   */
  const loadDigests = useCallback(async () => {
    try {
      const r = await fetch('/api/notifications/inbox');
      if (!r.ok) return;
      const j = await r.json();
      const items: InboxItem[] = Array.isArray(j?.items) ? j.items : [];
      setDigests(items.filter(it => typeof it?.key === 'string' && it.key.startsWith(DIGEST_KEY) && !!it.label));
    } catch { /* the digest card simply does not render */ }
  }, []);
  useEffect(() => { loadDigests(); }, [loadDigests]);

  const filterActive = !!(from || to || batchId != null || source);

  /**
   * THE SERVER'S OWN COUNT for the current filter. Only meaningful for PENDING
   * rows — the bulk endpoint filters `status='pending'` by construction, which
   * is also the only status bulk reject can touch. Re-run whenever any part of
   * the filter moves, so the confirmation can never quote a stale number; the
   * POST additionally carries `expect_count` and 409s if the set changed.
   */
  const loadPreview = useCallback(async () => {
    setPreviewErr(null);
    setPreviewBusy(true);
    try {
      const p = new URLSearchParams();
      if (from) p.set('from', from);
      if (to) p.set('to', to);
      if (batchId != null) p.set('batch_id', batchId);
      if (source) p.set('source', source);
      if (allOutlets) p.set('outlet', 'all');
      const r = await fetch(`/api/variance-approvals/bulk?${p.toString()}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setPreview(j as BulkPreview);
    } catch (e) { setPreview(null); setPreviewErr((e as Error).message); }
    finally { setPreviewBusy(false); }
  }, [from, to, batchId, source, allOutlets]);
  useEffect(() => { loadPreview(); }, [loadPreview]);

  /* ── The rows this filter shows ────────────────────────────────────────────
   * Narrowed HERE because the list endpoint does not take these filters yet.
   * Reading only — every figure a bulk dialog quotes comes from `preview`. */
  const visible = useMemo(() => rows.filter(r => {
    if (from && r.date < from) return false;
    if (to && r.date > to) return false;
    if (batchId != null && (r.batch_id || '') !== batchId) return false;
    if (source && r.source !== source) return false;
    return true;
  }), [rows, from, to, batchId, source]);

  /** ₹ at stake across the rows ON SCREEN. `truncated` ⇒ print it as a floor. */
  const visibleValue = useMemo(
    () => visible.reduce((s, r) => s + Math.abs(Number(r.variance_value) || 0), 0),
    [visible],
  );
  /**
   * ₹ still undecided across the WHOLE queue, summed from the batch index —
   * authoritative, because listCountBatches groups every row (including the
   * unbatched ones) rather than the limited slice this page holds.
   */
  const queuePendingValue = useMemo(
    () => batches.reduce((s, b) => s + (Number(b.pending_value) || 0), 0),
    [batches],
  );
  const selectableIds = useMemo(
    () => visible.filter(r => r.status === 'pending').map(r => r.id),
    [visible],
  );

  /* A TICK MUST NOT SURVIVE THE FILTER THAT MADE IT VISIBLE. Selecting 40 rows
     of last month's upload and then switching to this month's would otherwise
     leave those 40 ticked and off-screen: the dialog would say "40 counts" while
     the ₹ figure beside it — summed over what IS on screen — described none of
     them, and the POST would reject rows nobody was looking at. Prune to what
     the current filter shows, every time it changes. */
  useEffect(() => {
    setSelected(prev => {
      if (prev.size === 0) return prev;
      const live = new Set(selectableIds);
      let dropped = false;
      const next = new Set<string>();
      for (const id of prev) { if (live.has(id)) next.add(id); else dropped = true; }
      return dropped ? next : prev;
    });
  }, [selectableIds]);
  const selectedRows = useMemo(
    () => visible.filter(r => selected.has(r.id)),
    [visible, selected],
  );
  const selectedValue = selectedRows.reduce((s, r) => s + Math.abs(Number(r.variance_value) || 0), 0);
  const allSelected = selectableIds.length > 0 && selectableIds.every(id => selected.has(id));

  const toggleAll = () => {
    setSelected(prev => {
      if (allSelected) {
        const n = new Set(prev);
        for (const id of selectableIds) n.delete(id);
        return n;
      }
      const n = new Set(prev);
      for (const id of selectableIds) n.add(id);
      return n;
    });
  };
  const toggleOne = (id: string) => setSelected(prev => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const clearFilter = () => { setFrom(''); setTo(''); setBatchId(null); setSource(''); };
  const setMonth = (monthsBack: number) => {
    const b = monthBounds(todayIST(), monthsBack);
    setFrom(b.from); setTo(b.to);
  };

  const decide = async (row: Approval, action: 'approve' | 'reject') => {
    // The server refuses some approvals outright — a department count with no
    // honest ledger to correct, and a count superseded by a newer one. Both
    // arrive pre-resolved as `approve_blocked`, so mirror it here and the click
    // never leaves the page. Reject is NEVER gated: it moves no stock, and it is
    // how a superseded count is supposed to leave the queue.
    if (action === 'approve' && row.approve_blocked) { flash(row.approve_blocked); return; }
    const reason = (reasons[row.id] || '').trim();
    if (reason.length < 2) { flash('Enter a reason first — ask the staff what caused it.'); return; }
    setBusy(row.id);
    try {
      const res = await api(`/api/variance-approvals/${row.id}/${action}`, { method: 'POST', body: { reason } });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || 'Failed');
      // NO RESULTING FIGURE IN THIS TOAST. It used to read "stock set to
      // <physical>", which is the absolute-set claim the approval does not make
      // (see the delta note at the top of this file). The approve route replies
      // { ok, applied } and nothing more, so the balance the item actually
      // landed on is not knowable here — naming the counted figure again would
      // just repeat the old promise. Say what was applied instead.
      flash(action === 'approve'
        ? `Approved — ${row.material_name}: counted difference written to stock`
        : `Rejected — ${row.material_name}: count discarded, stock unchanged`);
      setReasons(p => { const n = { ...p }; delete n[row.id]; return n; });
      await load();
      await loadBatches();
      await loadPreview();
    } catch (e) { flash((e as Error).message); }
    finally { setBusy(null); }
  };

  /* ── BULK REJECT ───────────────────────────────────────────────────────────
   * REJECT DISCARDS THE COUNT AND LEAVES STOCK EXACTLY AS IT IS. The endpoint
   * runs one statement — an UPDATE of variance_approvals.status — and never
   * imports approveVariance at all, so nothing here can move a gram on any rail.
   * Two selections, and they are deliberately different shapes:
   *   'ids'    → the rows ticked on screen. The caller named every one, so the
   *              API needs no expect_count.
   *   'filter' → everything the CURRENT filter matches, server-resolved. That is
   *              the 1,472-row button, so it carries the previewed count back as
   *              `expect_count` (409 if the queue moved) AND asks the admin to
   *              type that number before the button arms. */
  const pendingShown = selectableIds.length;
  const pendingShownValue = visible
    .filter(r => r.status === 'pending')
    .reduce((s, r) => s + Math.abs(Number(r.variance_value) || 0), 0);
  /**
   * TRUE WHEN THE ROWS ON SCREEN ARE FEWER THAN THE ROWS THE FILTER SELECTS —
   * which is the only condition under which a ₹ figure derived from them may be
   * printed, and then only as a floor ("at least ₹X"). Two independent causes:
   * the list endpoint's LIMIT, and the server counting rows this page never
   * received. `preview.matched` is the server's own count for the identical
   * filter, so comparing against it catches both.
   */
  const shownIsPartial = truncated
    || (tab === 'pending' && !!preview && preview.matched > pendingShown);

  const bulkCount = bulkMode === 'ids' ? selected.size : (preview?.matched ?? 0);
  const bulkValueKnown = bulkMode === 'ids' ? selectedValue : pendingShownValue;
  /** The ₹ is summed over fewer rows than the action touches — say "at least". */
  const bulkValueIsFloor = bulkMode === 'filter' && shownIsPartial;

  const openBulk = (mode: 'ids' | 'filter') => {
    setBulkMode(mode); setBulkReason(''); setBulkTyped(''); setBulkErr(null);
  };
  const closeBulk = () => { if (!bulkBusy) setBulkMode(null); };

  const runBulkReject = async () => {
    if (!bulkMode) return;
    const reason = bulkReason.trim();
    if (reason.length < 2) { setBulkErr('Write why these counts are being discarded — it is recorded on every row.'); return; }
    if (bulkMode === 'filter') {
      if (!preview) { setBulkErr('Re-check the filter first.'); return; }
      if (Number(bulkTyped.replace(/[^\d]/g, '')) !== preview.expect_count) {
        setBulkErr(`Type ${num(preview.expect_count)} to confirm you mean all of them.`);
        return;
      }
    }
    setBulkBusy(true); setBulkErr(null);
    try {
      const body = bulkMode === 'ids'
        ? { action: 'reject', reason, ids: Array.from(selected) }
        // The filter is echoed back by the preview and handed on UNCHANGED, so
        // "you are about to reject N" and "N were rejected" cannot describe two
        // different row sets.
        : { action: 'reject', reason, filter: preview!.filter, expect_count: preview!.expect_count };
      const res = await api('/api/variance-approvals/bulk', { method: 'POST', body });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
      setBulkMode(null);
      setSelected(new Set());
      flash(
        `${num(j.rejected || 0)} count${j.rejected === 1 ? '' : 's'} rejected — discarded, stock unchanged`
        + (j.skipped ? ` · ${num(j.skipped)} already decided and left alone` : ''),
      );
      await load();
      await loadBatches();
      await loadPreview();
    } catch (e) { setBulkErr((e as Error).message); }
    finally { setBulkBusy(false); }
  };

  /* ── The bar ───────────────────────────────────────────────────────────── */
  const saveBar = async () => {
    setBarBusy(true); setBarMsg(null);
    try {
      const res = await api('/api/closing-stock/variance-bar', {
        method: 'PUT',
        body: {
          bar_value: barDraft.bar_value.trim(),
          bar_qty: barDraft.bar_qty.trim(),
        },
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
      setBar(j as BarPayload);
      // Re-seed from the EFFECTIVE bar the server answers with, so a value it
      // clamped is shown as clamped rather than echoed back as typed.
      setBarDraft({
        bar_value: String(j.bar.bar_value || 0),
        bar_qty: String(j.bar.bar_qty || 0),
      });
      setBarMsg({ tone: 'ok', text: 'Saved. This applies to counts saved from now on — nothing already decided or waiting here has moved.' });
    } catch (e) { setBarMsg({ tone: 'warn', text: (e as Error).message }); }
    finally { setBarBusy(false); }
  };

  if (forbidden) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] flex items-center justify-center p-6">
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 max-w-md text-center">
          <Lock className="w-10 h-10 text-[#af4408] mx-auto mb-3" />
          <h1 className="text-lg font-semibold text-[#2D1B0E] mb-1">Admins only</h1>
          <p className="text-sm text-[#8B7355]">Variance approvals decide whether stock changes, so only admins can review them.</p>
        </div>
      </div>
    );
  }

  const fieldCls = 'px-2.5 py-1.5 border border-[#E8D5C4] rounded-lg text-sm bg-white text-[#2D1B0E] focus:outline-none focus:border-[#af4408]';

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-3">
              <ScrollText className="w-7 h-7" /> Variance Approvals
            </h1>
            <p className="text-[#8B7355] text-sm mt-1">
              Counts are uploaded weekly; this queue is a monthly job. Filter to a period or an upload, then decide.
            </p>
          </div>
          <div className="flex items-center gap-2 self-start">
            <label className="inline-flex items-center gap-1.5 text-[12px] text-[#6B5744] px-2.5 py-2 border border-[#E8D5C4] rounded-lg bg-white cursor-pointer">
              <input type="checkbox" className="accent-[#af4408]" checked={allOutlets} onChange={e => setAllOutlets(e.target.checked)} />
              All outlets
            </label>
            <button onClick={() => { load(); loadBatches(); loadPreview(); loadBar(); loadDigests(); }} disabled={loading}
                    className="inline-flex items-center gap-2 px-3 py-2 border border-[#E8D5C4] rounded-lg text-sm text-[#6B5744] hover:bg-white disabled:opacity-50">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Refresh
            </button>
          </div>
        </div>

        {/* WHAT THE TWO BUTTONS DO — rewritten. The old strip opened with
            "Nothing changes stock until you approve", which the bar and the
            department rail both falsify (see the file header). Approve's
            consequence is named first because it is the one that writes. */}
        <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl p-3 text-[12px] text-[#6B5744] flex gap-2">
          <ShieldCheck className="w-4 h-4 text-[#af4408] shrink-0 mt-0.5" />
          <span>
            <b>Approve WRITES TO STOCK</b> — the counted difference is applied to live stock and the loss is written off with your reason.
            It lands on the counted number only if nothing has moved since the count.
            <b className="ml-2">Reject DISCARDS the count and changes nothing</b> — no stock on any rail moves, and the shortage stands as an open loss to chase.
            Staff never see the system number, so the count is blind.
            {/* "per item" ALONE WOULD BE FALSE AND EXPENSIVE. The supersede key
                is (source, material, store, department) — Curd counted in the
                kitchen and Curd counted centrally are two rails with two
                independent baselines, and BOTH are legitimately approvable.
                stackedPendingCounts deliberately refuses to conflate them; this
                strip must not put the conflation back in prose, or an admin
                rejects a good count and leaves a real shortage un-booked. */}
            <b className="ml-2">Only the newest count per item, per store or department, can be approved</b> — an older one for the same place would apply the same correction twice, so reject it. The same item counted in two different places is two separate counts, and both can be approved.
            {bar?.auto_apply_enabled && (
              <>
                <b className="ml-2">A bar is set</b> — a difference at or under it was already applied when the count was saved and arrives here marked <i>applied automatically</i>. Everything above the bar is <b>held</b>: recorded, visible, and not in the books until you approve it.
              </>
            )}
            <b className="ml-2">Department counts are here only to be cleared.</b> Saving one already re-anchored that department&apos;s own balance, so approving it would take the difference off twice — the server refuses them. <b>Rejecting does not put the balance back</b> either; it only closes the row. New department counts no longer land here at all — to correct one, count it again.
          </span>
        </div>

        {/* ── THE MONTH AT A GLANCE ─────────────────────────────────────────
            A row count alone does not tell an admin whether this is worth an
            hour: the decision is about money. ₹ pending is summed from the
            batch index (every row, including the unbatched ones), not from the
            limited slice this page holds, so it is the whole queue. */}
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
            <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">Waiting for you</div>
            <div className="text-2xl font-bold text-[#af4408]">{num(pendingCount)}</div>
            <div className="text-[11px] text-[#8B7355]">count{pendingCount === 1 ? '' : 's'} pending{allOutlets ? ' · all outlets' : ''}</div>
          </div>
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
            <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">Value at stake</div>
            <div className="text-2xl font-bold text-[#2D1B0E]">{inr0(queuePendingValue)}</div>
            <div className="text-[11px] text-[#8B7355]">undecided, whole queue</div>
          </div>
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
            <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">Uploads</div>
            <div className="text-2xl font-bold text-[#2D1B0E]">{num(batches.filter(b => b.pending > 0).length)}</div>
            <div className="text-[11px] text-[#8B7355]">with something still pending</div>
          </div>
          {/* A FOURTH TILE USED TO SIT HERE: "Do not wait for month end", a count
              of rows a per-row threshold called large. It is gone with the
              threshold — see the note on BarPayload. The digest below replaces
              it, and replaces it with something a tile could never be: a
              statement about ONE COUNT, including the rows that never reach
              this queue at all. */}
        </div>

        {/* ── THE COUNT DIGEST ──────────────────────────────────────────────
            WHERE THE BELL ITEM LANDS. `closing_digest:<date|outlet|rail>` links
            here with count 1, and this is the block it was pointing at: the bell
            can only render a label and a pill inside a 288px dropdown, so the
            sentence is legible here and a wall of text there.

            ONE PER COUNT, AND IT ALWAYS FIRES — no threshold decides whether
            the admin hears anything, only what is named inside. Counts are
            weekly, this queue is monthly, so the digest is how a week's count
            gets seen without waiting for month end. One per COUNT and not per
            save: /eod posts one material per keypad entry, and keying the item
            on the save turned one evening into eight bell rows.

            EVERY WORD AND EVERY FIGURE IS THE SERVER'S. splitDigest() only lays
            the sentence out on the separators the server itself wrote; nothing
            here parses a number, and nothing re-formats one. That is deliberate:
            the thing this block replaced was a client-side twin of a server
            rule, and the two disagreed. */}
        {digests.length > 0 && (
          <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-[#E8D5C4] bg-[#FFF8F0]">
              <span className="inline-flex items-center gap-2 font-semibold text-[#2D1B0E] text-sm">
                <ClipboardList className="w-4 h-4 text-[#af4408]" />
                {digests.length === 1 ? 'The last closing count' : 'Closing counts this week'}
              </span>
              <span className="text-[11px] text-[#8B7355]">
                every count, whether or not anything looked unusual
              </span>
            </div>
            <div className="divide-y divide-[#F0E4D6]">
              {(digestsMore ? digests : digests.slice(0, 1)).map(d => {
                const p = splitDigest(d.label);
                return (
                  <div key={d.key} className="p-4 space-y-2.5">
                    <div className="text-[13px] font-semibold text-[#2D1B0E] leading-snug">{p.head}</div>
                    {p.lines.length > 0 && (
                      <ul className="grid sm:grid-cols-2 gap-x-4 gap-y-1">
                        {p.lines.map((ln, i) => (
                          <li key={i} className="text-[12px] text-[#6B5744] leading-snug flex gap-1.5">
                            <span className="text-[#D4B896] shrink-0">•</span>
                            <span>{ln}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {p.largest.length > 0 && (
                      <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg p-2.5">
                        <div className="text-[10px] uppercase tracking-wide text-[#8B7355] mb-1">Largest differences</div>
                        <ol className="space-y-0.5">
                          {p.largest.map((ln, i) => (
                            <li key={i} className="text-[12px] text-[#2D1B0E] leading-snug flex gap-1.5">
                              <span className="text-[#B0987F] shrink-0 font-mono text-[11px]">{i + 1}.</span>
                              <span>{ln}</span>
                            </li>
                          ))}
                        </ol>
                      </div>
                    )}
                    {/* DIFFERENCES WITH NO TRUSTWORTHY RUPEE FIGURE, NAMED.
                        Two kinds, and the server says which: a material with no
                        rate at all (193 of 952 have none), and one whose stored
                        rate is above anything this business has ever paid per
                        that purchase unit — the mixed-basis fault, which used to
                        put a 6-gram cocoa difference at the top of the list at
                        ₹5,079. Both are left OUT of the totals and shown here by
                        quantity instead of being guessed at. */}
                    {p.unvalued.length > 0 && (
                      <div className="border border-dashed border-[#E8D5C4] rounded-lg p-2.5">
                        <div className="text-[10px] uppercase tracking-wide text-[#8B7355] mb-1">
                          Real differences, not valued
                        </div>
                        <ul className="space-y-0.5">
                          {p.unvalued.map((ln, i) => (
                            <li key={i} className="text-[12px] text-[#6B5744] leading-snug flex gap-1.5">
                              <span className="text-[#D4B896] shrink-0">•</span>
                              <span>{ln}</span>
                            </li>
                          ))}
                        </ul>
                        <div className="text-[11px] text-[#8B7355] leading-snug mt-1">
                          Listed by quantity, which cannot be compared between materials.
                        </div>
                      </div>
                    )}
                    {/* THE TWO FIGURES ARE ON DIFFERENT BASES AND THE PAGE SAYS
                        SO. The digest values through the closing-valuation
                        ladder (last paid price where there is one, average cost
                        otherwise — the sentence counts which); "Value at stake"
                        above sums variance_value, which is variance × average
                        cost. Both are intentional, and two unexplained rupee
                        totals on one screen is the next bug report. */}
                    {p.basis && <div className="text-[11px] text-[#8B7355] leading-snug">{p.basis}</div>}
                    {allOutlets && (
                      <div className="text-[11px] text-[#8B7355] leading-snug flex gap-1.5">
                        <Info className="w-3.5 h-3.5 text-[#af4408] shrink-0 mt-px" />
                        <span>
                          The queue below is showing <b>all outlets</b>; this count summary is for the outlet you are
                          signed in to, the same as the bell.
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {digests.length > 1 && (
              <button onClick={() => setDigestsMore(o => !o)}
                      className="w-full flex items-center justify-center gap-1.5 px-4 py-2 text-[12px] text-[#6B5744] border-t border-[#F0E4D6] hover:bg-[#FFF8F0]">
                {digestsMore
                  ? <><ChevronDown className="w-3.5 h-3.5" /> Show only the latest count</>
                  : <><ChevronRight className="w-3.5 h-3.5" /> {num(digests.length - 1)} earlier count{digests.length - 1 === 1 ? '' : 's'} in the last week</>}
              </button>
            )}
          </div>
        )}

        {/* ── THE BAR (admin settings, on the page it governs) ──────────────
            It lives here rather than on a new /settings route on purpose: the
            person reading this queue is the person who decides how much of it
            should have been here at all, and a new route would need an entry in
            BOTH page-catalog.ts and Sidebar.tsx (catalog-only = gated but
            invisible — the drift that hid 8 pages once already). This page is
            already adminOnly in both, and the PUT is admin-only server-side. */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
          <button onClick={() => setBarOpen(o => !o)}
                  className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-[#FFF8F0]">
            <span className="inline-flex items-center gap-2 font-semibold text-[#2D1B0E] text-sm">
              <SlidersHorizontal className="w-4 h-4 text-[#af4408]" />
              {/* This panel used to introduce TWO settings — the auto-apply bar
                  and a "tell me today" alert. The alert and both its keys are
                  gone, so the heading names what is actually left; a heading
                  about "how big a difference is worth your attention" over a
                  panel that only decides what applies itself would be the same
                  drift the alert died of. */}
              How small a difference may apply itself without you
            </span>
            <span className="flex items-center gap-2 text-[11px] text-[#8B7355]">
              {bar ? (
                <span className={`px-1.5 py-0.5 rounded border ${bar.auto_apply_enabled ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-[#FFF1E3] border-[#E8D5C4]'}`}>
                  {bar.auto_apply_enabled ? 'bar on' : 'bar off — everything is held'}
                </span>
              ) : <span>loading…</span>}
              {barOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </span>
          </button>

          {/* AN UNREADABLE BAR IS NOT AN UNSET BAR. If the read failed, the
              panel must not render two empty boxes that look like "everything
              is off" — saving those would write a real 0 to both keys. */}
          {barOpen && !bar && (
            <div className="border-t border-[#E8D5C4] p-4 text-[12px] text-[#6B5744] flex items-center justify-between gap-3">
              <span>The current limits could not be read, so they are not shown — nothing here has changed.</span>
              <button onClick={loadBar} className="px-2.5 py-1.5 border border-[#E8D5C4] rounded-lg text-[#6B5744] hover:bg-[#FFF1E3]">
                Try again
              </button>
            </div>
          )}

          {barOpen && bar && (
            <div className="border-t border-[#E8D5C4] p-4 space-y-4">
              {/* ── AUTO-APPLY ─────────────────────────────────────────── */}
              <div>
                <div className="text-[13px] font-semibold text-[#2D1B0E] flex items-center gap-2">
                  <Zap className="w-4 h-4 text-[#af4408]" /> Small differences: apply them, don&apos;t ask
                </div>
                <p className="text-[12px] text-[#6B5744] mt-1 leading-relaxed">
                  A difference <b>at or under</b> the bar is applied to stock the moment the count is saved and simply
                  appears on the reports — nobody is troubled by a ₹12 flour difference. Anything <b>above</b> it is
                  <b> held</b>: the count is recorded and visible, and the stock figure does not move until you approve
                  it here. Set a box to <b>0</b> to switch that axis off. With both at 0 nothing is applied
                  automatically — every difference waits for you, exactly as before.
                </p>
                <p className="text-[12px] text-[#6B5744] mt-1 leading-relaxed">
                  If you fill in <b>both</b> boxes, a difference has to be small on <b>both</b> counts to apply itself.
                  That pairing is not decoration: a material with no purchase price values every difference at ₹0, so a
                  rupee bar on its own would wave through any quantity of it.
                </p>
                {/* THE TWO GUARDS THAT ARE NOT TUNABLE. The admin has to be told
                    what will happen anyway, or a held row under a bar they set
                    reads as the bar being broken — and the qty axis genuinely
                    had no rupee opinion until the ceiling existed (a 100-unit
                    bar auto-applied ₹1.27 lakh on one bottle line). Figures come
                    from the API's `guards`, never from literals here. */}
                {bar.guards && (
                  <p className="text-[12px] text-[#6B5744] mt-1 leading-relaxed">
                    <b>Two limits you cannot raise.</b> Nothing worth more than{' '}
                    <b>{inr0(bar.guards.auto_apply_max_value)}</b> ever applies itself, whichever box you fill in —
                    a quantity bar has no rupee opinion of its own, so without this &quot;100 bottles&quot; could mean
                    lakhs on one line. And one upload may apply at most{' '}
                    <b>{inr0(bar.guards.auto_apply_batch_value)}</b> or{' '}
                    <b>{num(bar.guards.auto_apply_batch_rows)} lines</b> on its own; past that the rest of that upload
                    is held for you. Nothing already applied is undone — the sheet just stops applying itself and waits.
                  </p>
                )}
                <div className="grid sm:grid-cols-2 gap-3 mt-3">
                  <label className="block">
                    <span className="text-[11px] font-medium text-[#6B5744]">Rupee bar — ₹ per item</span>
                    <input type="number" min="0" step="1" value={barDraft.bar_value}
                           onChange={e => setBarDraft(d => ({ ...d, bar_value: e.target.value }))}
                           className={`${fieldCls} w-full mt-1 font-mono text-right`} />
                    <span className="block text-[10px] text-[#8B7355] mt-0.5">
                      0 = off · most ₹{num(bar.limits.bar_value)} (the ceiling on what may move with no admin in the loop)
                    </span>
                  </label>
                  <label className="block">
                    <span className="text-[11px] font-medium text-[#6B5744]">Quantity bar — in purchase units</span>
                    <input type="number" min="0" step="0.01" value={barDraft.bar_qty}
                           onChange={e => setBarDraft(d => ({ ...d, bar_qty: e.target.value }))}
                           className={`${fieldCls} w-full mt-1 font-mono text-right`} />
                    <span className="block text-[10px] text-[#8B7355] mt-0.5">
                      0 = off · most {num(bar.limits.bar_qty)} · &quot;2&quot; means 2 bottles / 2 kg — the unit you buy in, never ml or g
                    </span>
                    <span className="block text-[10px] text-[#8B7355] mt-0.5">
                      A safe first setting is <b>₹500</b> and <b>2</b>: on your catalogue a typical item costs ₹140 a
                      unit, so that covers an ordinary one- or two-unit miscount and holds everything else.
                    </span>
                  </label>
                </div>
              </div>

              {/* ── THERE IS NOTHING ELSE TO SET, AND THAT IS THE CHANGE ──────
                  A second section sat here: "Big differences: tell me today",
                  two boxes (₹ per item, % of that item's own stock) writing
                  closing_variance_alert_value / _alert_pct, feeding a per-row
                  "Large — look now" pill and a bell count.
                  BOTH KEYS AND BOTH BOXES ARE DELETED. At ₹5,000 / 25% the rule
                  fired on 390 of 451 rows of the owner's own incident sheet
                  (86%); on the 208 genuine rows with the mistaken zeros removed
                  it still fired on 147, and even ₹50,000 / 100% fired on 33. The
                  cause is not a mis-tuned number — a shelf counted empty is
                  100% of the book BY DEFINITION and herbs, garnishes and
                  perishables run out every week, so the share axis is noise by
                  construction and no rupee bar fits a per-line distribution
                  running ₹432 at p25 to ₹1.31 lakh at max.
                  What replaced it needs no setting at all: ONE digest per
                  upload, unconditional, rendered at the top of this page and
                  pushed once to the bell. Nothing tunes it and nothing mutes it,
                  which is the point — a threshold decided WHETHER he heard
                  anything, and this only decides what is named inside.
                  DO NOT RE-ADD A THRESHOLD HERE. */}

              {/* THE SENTENCE THE OWNER ASKED FOR, VERBATIM IN SUBSTANCE.
                  varianceBar() is read once per save, for the count being
                  saved, and nothing sweeps existing rows — so this is a
                  statement about the code, not a promise about intent. */}
              <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg p-2.5 text-[11px] text-[#6B5744] flex gap-2">
                <Info className="w-3.5 h-3.5 text-[#af4408] shrink-0 mt-0.5" />
                <span>
                  <b>Changing these numbers never moves stock.</b> They are read only when a count is saved, for that
                  count. Nothing already applied is undone, nothing waiting in this queue is applied, and no past row is
                  re-decided — raising the bar tomorrow leaves every held count exactly where it is.
                  Department counts are not affected either way: saving one already re-anchors that department&apos;s balance.
                </span>
              </div>

              {barMsg && (
                <div className={`rounded-lg p-2.5 text-[12px] border ${barMsg.tone === 'ok' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-red-50 border-red-200 text-red-700'}`}>
                  {barMsg.text}
                </div>
              )}
              <div className="flex justify-end">
                <button onClick={saveBar} disabled={barBusy}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-semibold bg-[#af4408] hover:bg-[#8a3506] text-white disabled:opacity-50">
                  {barBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save these limits
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Tabs */}
        <div className="flex gap-2">
          {(['pending', 'approved', 'rejected'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
                    className={`px-3.5 py-2 rounded-lg text-sm font-medium border transition-colors ${
                      tab === t ? 'bg-[#af4408] border-[#af4408] text-white' : 'bg-white border-[#E8D5C4] text-[#6B5744] hover:bg-[#FFF1E3]'}`}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
              {t === 'pending' && pendingCount > 0 && (
                <span className={`ml-2 px-1.5 py-0.5 rounded-full text-[11px] font-bold ${tab === t ? 'bg-white/25' : 'bg-red-100 text-red-700'}`}>{pendingCount}</span>
              )}
            </button>
          ))}
        </div>

        {/* ── PERIOD · UPLOAD · RAIL ────────────────────────────────────────
            The three axes a monthly review actually uses. Everything here
            narrows the list on screen; the bulk action beside it is resolved by
            the server against the same filter. */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wide text-[#8B7355] flex items-center gap-1">
                <CalendarDays className="w-3 h-3" /> Count date from
              </span>
              <input type="date" value={from} onChange={e => setFrom(e.target.value)} className={fieldCls} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wide text-[#8B7355]">to</span>
              <input type="date" value={to} onChange={e => setTo(e.target.value)} className={fieldCls} />
            </label>
            <div className="flex gap-1.5">
              <button onClick={() => setMonth(1)} className="px-2.5 py-1.5 text-[12px] border border-[#E8D5C4] rounded-lg text-[#6B5744] hover:bg-[#FFF1E3]">
                {monthLabel(monthBounds(todayIST(), 1).from)}
              </button>
              <button onClick={() => setMonth(0)} className="px-2.5 py-1.5 text-[12px] border border-[#E8D5C4] rounded-lg text-[#6B5744] hover:bg-[#FFF1E3]">
                This month
              </button>
            </div>
            <label className="flex flex-col gap-1 min-w-[16rem] flex-1">
              <span className="text-[10px] uppercase tracking-wide text-[#8B7355]">Upload</span>
              <select
                value={batchId == null ? '__any__' : batchId}
                onChange={e => setBatchId(e.target.value === '__any__' ? null : e.target.value)}
                className={fieldCls}>
                <option value="__any__">Every upload</option>
                {batches.map(b => (
                  <option key={b.batch_id || '__unbatched__'} value={b.batch_id}>
                    {(b.batch_label || (b.batch_id ? 'Upload' : 'Saved before uploads were tracked'))}
                    {' · '}{b.first_date === b.last_date ? b.first_date : `${b.first_date} → ${b.last_date}`}
                    {' · '}{b.pending} pending
                    {b.pending > 0 ? ` · ${inr0(b.pending_value)}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wide text-[#8B7355]">Rail</span>
              <select value={source} onChange={e => setSource(e.target.value as '' | 'central' | 'liquor')} className={fieldCls}>
                <option value="">Central + liquor</option>
                <option value="central">Central store / departments</option>
                <option value="liquor">Liquor stores</option>
              </select>
            </label>
            {filterActive && (
              <button onClick={clearFilter} className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[12px] border border-[#E8D5C4] rounded-lg text-[#6B5744] hover:bg-[#FFF1E3]">
                <X className="w-3.5 h-3.5" /> Clear filter
              </button>
            )}
          </div>

          {/* What this filter selects, in rows AND rupees. The row count on the
              left is the SERVER's (pending only); the ₹ is summed from the rows
              on screen and is printed as a floor when they are a slice. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-[#6B5744] border-t border-[#F0E4D6] pt-2.5">
            <span className="inline-flex items-center gap-1.5 font-medium">
              <Filter className="w-3.5 h-3.5 text-[#af4408]" />
              {filterActive ? 'This selection' : 'Whole queue'}
            </span>
            {/* THREE DIFFERENT NUMBERS, NEVER BLURRED INTO ONE:
                `visible.length` is what is on screen after the client-side
                filter, `rows.length` is what the server actually sent, `total`
                is what exists. Printing "N of total" while a filter is active
                would silently compare a filtered slice against an unfiltered
                whole and read as data loss. */}
            <span>
              Showing <b>{num(visible.length)}</b> {tab} row{visible.length === 1 ? '' : 's'}
              {truncated && <> · read {num(rows.length)} of {num(total)}</>}
            </span>
            {tab === 'pending' && (
              previewBusy
                ? <span className="inline-flex items-center gap-1 text-[#8B7355]"><Loader2 className="w-3 h-3 animate-spin" /> counting…</span>
                : preview
                  ? <span><b>{num(preview.matched)}</b> pending on the server for this filter</span>
                  : previewErr
                    ? <span className="text-red-700">Could not count this selection: {previewErr}</span>
                    : null
            )}
            <span>
              {shownIsPartial ? 'at least ' : ''}<b>{inr(visibleValue)}</b> at stake in the rows shown
            </span>
          </div>

          {/* ── BULK BAR. One verb only. ──────────────────────────────────── */}
          {tab === 'pending' && (
            <div className="flex flex-wrap items-center gap-2 border-t border-[#F0E4D6] pt-2.5">
              <button onClick={toggleAll} disabled={selectableIds.length === 0}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] border border-[#E8D5C4] rounded-lg text-[#6B5744] hover:bg-[#FFF1E3] disabled:opacity-40">
                <ListChecks className="w-3.5 h-3.5" />
                {allSelected ? 'Clear selection' : `Select the ${num(selectableIds.length)} shown`}
              </button>
              {selected.size > 0 && (
                <span className="text-[12px] text-[#6B5744]">
                  <b>{num(selected.size)}</b> selected · {inr(selectedValue)}
                </span>
              )}
              <div className="flex-1" />
              <button onClick={() => openBulk('ids')} disabled={selected.size === 0}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium border border-[#D4B896] text-[#6B5744] bg-white hover:bg-[#FFF1E3] disabled:opacity-40">
                <Trash2 className="w-3.5 h-3.5" /> Reject selected
              </button>
              <button onClick={() => openBulk('filter')} disabled={!preview || preview.matched === 0}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold bg-[#6B5744] hover:bg-[#54432f] text-white disabled:opacity-40">
                <Trash2 className="w-3.5 h-3.5" />
                Reject all {preview ? num(preview.matched) : '—'} {filterActive ? 'in this selection' : 'pending'}
              </button>
            </div>
          )}

          {tab === 'pending' && (
            <p className="text-[11px] text-[#8B7355] leading-relaxed">
              Rejecting discards the counts and <b>changes no stock on any rail</b> — the rows move to the Rejected tab
              and stay readable. <b>There is no bulk approve, and there will not be one</b>: approving writes to stock,
              and doing that to a whole sheet at once could book &quot;we have zero&quot; against hundreds of items in one
              click. Approve one count at a time, below.
            </p>
          )}
        </div>

        {pendingElsewhere > 0 && !allOutlets && (
          <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg p-2.5 text-[12px] text-[#6B5744] flex gap-2">
            <Info className="w-4 h-4 text-[#af4408] shrink-0 mt-0.5" />
            <span>
              {num(pendingElsewhere)} pending count{pendingElsewhere === 1 ? '' : 's'} {pendingElsewhere === 1 ? 'is' : 'are'} stamped
              with another outlet and are not in this list. Tick <b>All outlets</b> above to include them.
            </span>
          </div>
        )}

        {loadError && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" /> {loadError}
          </div>
        )}

        {/* STACKED COUNTS — the queue-level headline of the double-apply.
            Working 963 pending rows top-to-bottom is the natural thing to do and
            is exactly what breaks: an item holding two counts corrects the same
            frozen baseline twice, and it overstates, which hides a shortage.
            Every one of those rows is individually refused below, but a refusal
            you only meet on the row you happen to open is not a warning — this
            names the items up front so the admin can go straight to them.
            Server-ordered newest date first; NOT re-sorted here.
            `stacked` is empty on the approved/rejected tabs (nothing is pending
            there to stack), so no tab check is needed — but it is hidden while
            loading, because the array in state still describes the previous
            read. It is also queue-wide while the list below carries a LIMIT and
            a client-side filter, so the copy never promises that every named
            item is visible in it. */}
        {!loading && stacked.length > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3.5 text-[12px] text-amber-900">
            <div className="flex gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <div className="font-semibold text-[13px]">
                  {stacked.length} item{stacked.length === 1 ? ' has' : 's have'} more than one pending count.
                </div>
                <p className="mt-0.5 leading-relaxed">
                  Each count froze its own system figure, so approving two of them applies the same correction
                  twice — and it overstates, which hides a shortage. <b>Approve the newest count for each item
                  and reject the older ones.</b>
                </p>
                <ul className="mt-2 space-y-0.5">
                  {stacked.slice(0, STACKED_SHOWN).map(s => (
                    <li key={s.material_id} className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-medium">{s.material_name || s.material_id}</span>
                      <span className="text-amber-800">
                        {s.pending_count} counts · newest {s.latest_date}
                      </span>
                    </li>
                  ))}
                </ul>
                {stacked.length > STACKED_SHOWN && (
                  <div className="mt-1 text-amber-800">
                    +{stacked.length - STACKED_SHOWN} more item{stacked.length - STACKED_SHOWN === 1 ? '' : 's'} with
                    stacked counts.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-[#8B7355] text-sm py-10 justify-center">
            <Loader2 className="w-5 h-5 animate-spin" /> Loading…
          </div>
        ) : visible.length === 0 ? (
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-10 text-center text-[#8B7355]">
            <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto mb-3" />
            <p className="font-medium text-[#2D1B0E]">
              {filterActive ? `Nothing ${tab} in this selection.` : `Nothing ${tab}.`}
            </p>
            {/* AN EMPTY LIST IS NOT A CLEAN BILL OF HEALTH when the read was cut
                short: the filter narrows the slice this page received, it does
                not fetch further back. The server's own count for the identical
                filter is the honest answer, and the bulk action below still
                reaches every one of those rows. */}
            {filterActive && tab === 'pending' && preview && preview.matched > 0 ? (
              <p className="text-sm mt-1">
                The server counts <b>{num(preview.matched)}</b> pending {preview.matched === 1 ? 'count' : 'counts'} for
                this selection, but they fall outside the newest {num(PAGE_LIMIT)} rows this page could read, so none
                are listed. <b>Reject all {num(preview.matched)}</b> above still covers every one of them.
              </p>
            ) : filterActive ? (
              <p className="text-sm mt-1">Widen the period or pick another upload.</p>
            ) : null}
            {!filterActive && tab === 'pending' && <p className="text-sm mt-1">Every count reconciles with the system — no variances to review.</p>}
          </div>
        ) : (
          <div className="space-y-3">
            {visible.map(row => {
              const shortage = row.variance < 0;
              const decided = row.status !== 'pending';
              const auto = Number(row.auto_applied) === 1;
              const meta = metaOf(row);
              const pu = puOf(row);
              /** Recipe qty → the purchase-unit string this page prints. */
              const pq = (v: number) => `${qty(toPurchaseQty(v, meta))} ${pu}`;
              // Each figure is quoted more than once below, so derive it once —
              // the readings cannot then drift between tile and caveat.
              const countedTxt = pq(row.physical_stock);
              const systemTxt = pq(row.system_stock);

              // SUPERSEDED. Non-null ⇒ approve_blocked already carries the
              // server's refusal sentence; these two only name which count wins.
              // Shown on PENDING rows only: a decided row has no click left to
              // warn about, and marking a settled row "Superseded" is noise.
              const supDate = !decided ? (row.superseded_by_date || null) : null;
              const supStatus = row.superseded_by_status || null;

              // LIVE-BASED PROJECTION — where approval actually lands.
              // `live_stock` is null on department rows, and null is an answer:
              // typeof-checked rather than `|| 0`, because a coerced zero would
              // print a confident "projected 0" on every department count.
              // ADDED IN RECIPE UNITS, CONVERTED ONCE (pack-units rule: never sum
              // rounded purchase-basis derivatives), and r3 to match the delta
              // approveVariance actually posts.
              const live = typeof row.live_stock === 'number' && Number.isFinite(row.live_stock)
                ? row.live_stock : null;
              const delta = r3(row.physical_stock - row.system_stock);
              const projected = live === null ? null : r3(live + delta);
              // PENDING ONLY. On the approved tab "if approved" is already
              // answered, and live + delta would there read as applying the same
              // correction a SECOND time — the exact figure this fix exists to
              // stop showing. Decided rows keep the count-time tile untouched.
              const useLive = !decided && projected !== null;
              const moved = live !== null && Math.abs(live - row.system_stock) > EPS;
              return (
                /* ONE AMBER MEANING PER ROW. The card used to take an amber ring
                   when a per-row threshold called it "large" — the same palette
                   the Superseded pill uses for a DEAD row, so an urgent card and
                   a stale one were indistinguishable at a glance. The threshold
                   is gone; amber on this page now means exactly one thing, and
                   it is the supersede warning. */
                <div key={row.id} className="bg-white border border-[#E8D5C4] rounded-xl p-4 shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex gap-2.5">
                      {/* Selection is PENDING-only, because reject is the only
                          bulk verb and it only moves pending rows. */}
                      {!decided && (
                        <input type="checkbox" className="accent-[#af4408] mt-1 w-4 h-4 shrink-0"
                               checked={selected.has(row.id)} onChange={() => toggleOne(row.id)}
                               aria-label={`Select ${row.material_name}`} />
                      )}
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-[#2D1B0E]">{row.material_name}</span>
                          {row.material_sku && <span className="text-[11px] text-[#B0987F]">#{row.material_sku}</span>}
                          <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border bg-[#FFF8F0] border-[#E8D5C4] text-[#6B5744]">
                            {row.source === 'liquor' ? <Store className="w-3 h-3" /> : <Boxes className="w-3 h-3" />}
                            {row.source === 'liquor' ? (row.store_name || 'Store') : (row.department_name || 'Store / Overall')}
                          </span>
                          {/* Scannable mark of the refusal. 963 pending rows are
                              read by scrolling, not by opening each card, so the
                              verdict has to be visible in the row header too. */}
                          {supDate && (
                            <span className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded border bg-amber-50 border-amber-200 text-amber-900">
                              <Layers className="w-3 h-3" /> Superseded
                            </span>
                          )}
                          {/* A "Large — look now" PILL USED TO SIT HERE and is
                              deliberately not replaced. It named no axis, no
                              figure and no action, it shared this exact amber
                              with the Superseded pill beside it, and it fired on
                              86% of the owner's own sheet. What it was reaching
                              for — "which of these actually matter" — is
                              answered by the digest at the top of the page,
                              which names the three biggest with their quantity
                              and value instead of colouring hundreds of rows. */}
                          {/* AUTO-APPLIED. `reviewed_by` on these rows is the
                              literal string "system:auto-apply", so the pill has
                              to be read before the by-line below is believed. */}
                          {auto && (
                            <span className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded border bg-emerald-50 border-emerald-200 text-emerald-800">
                              <Zap className="w-3 h-3" /> Applied automatically
                            </span>
                          )}
                        </div>
                        <div className="text-[12px] text-[#8B7355] mt-0.5">
                          Count date {row.date} · counted by {row.counted_by || '—'}
                          {row.batch_label && <> · {row.batch_label}</>}
                          {row.count_note && <> · note: <span className="italic">{row.count_note}</span></>}
                        </div>
                      </div>
                    </div>
                    <div className={`text-right shrink-0 ${shortage ? 'text-red-700' : 'text-emerald-700'}`}>
                      <div className="inline-flex items-center gap-1 font-semibold">
                        {shortage ? <PackageX className="w-4 h-4" /> : <PackagePlus className="w-4 h-4" />}
                        {shortage ? 'Shortage' : 'Surplus'} {inr(row.variance_value)}
                      </div>
                      <div className="text-[12px]">{row.variance > 0 ? '+' : '−'}{qty(toPurchaseQty(Math.abs(row.variance), meta))} {pu}</div>
                    </div>
                  </div>

                  {/* System vs physical (admin sees the system number here — the review is where it belongs) */}
                  <div className="grid grid-cols-3 gap-2 mt-3 text-center">
                    <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg py-2">
                      <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">System</div>
                      <div className="font-semibold" title={packFactor(meta) > 1 ? `= ${qty(row.system_stock)} ${row.unit}` : undefined}>{qty(toPurchaseQty(row.system_stock, meta))} <span className="text-[11px] font-normal text-[#8B7355]">{pu}</span></div>
                    </div>
                    <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg py-2">
                      <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">Counted</div>
                      <div className="font-semibold">{qty(toPurchaseQty(row.physical_stock, meta))} <span className="text-[11px] font-normal text-[#8B7355]">{pu}</span></div>
                      {/* BLANK vs ZERO, on the review side too. A stored row is
                          by definition a count; a 0 in it means the shelf was
                          counted and found empty, never "nobody looked". Say so
                          — this queue is where a mass-zeroed sheet is judged. */}
                      {row.physical_stock === 0 && (
                        <div className="text-[9px] text-[#B8A590] leading-tight">counted, found empty</div>
                      )}
                    </div>
                    <div className={`rounded-lg py-2 border ${shortage ? 'bg-red-50 border-red-200' : 'bg-emerald-50 border-emerald-200'}`}>
                      {/* PROJECTION, NOT A PROMISE. This tile read "If approved
                          → <physical>", which is the absolute set approval does
                          not do. It then read the counted figure with an
                          unconditional "only if nothing moved since" caveat,
                          because no live balance reached the page.
                          IT NOW DOES, PER RAIL (`live_stock`), so where the
                          server can supply one this prints the real landing
                          figure — live + (physical − system) — and the caveat
                          below turns into the actual arithmetic. Department rows
                          still arrive null and keep the count-time figure and
                          the old caveat: a dept balance has no set-based source,
                          and rm.current_stock is the CENTRAL pool, so borrowing
                          it here would look authoritative and be wrong on that
                          whole rail. Print nothing you cannot compute. */}
                      {/* A BLOCKED ROW GETS NO FORECAST. The tile is what a
                          scanner reads, and on a superseded row it was printing
                          a confident "If approved → 12.994 kg" in the same
                          styling an approvable row uses — for an approval the
                          server refuses outright. The number was arithmetically
                          right and the framing was a lie, which is the exact
                          defect this whole change exists to remove. Say the
                          state instead; the amber block below explains it. */}
                      {decided ? (
                        <>
                          <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">
                            {row.status === 'approved' ? 'Written to stock' : 'Discarded'}
                          </div>
                          <div className="font-semibold text-[#8B7355]">
                            {row.status === 'approved' ? `${delta > 0 ? '+' : '−'}${pq(Math.abs(delta))}` : '—'}
                          </div>
                          <div className="text-[9px] text-[#B8A590] leading-tight">
                            {row.status === 'approved' ? 'counted difference applied' : 'stock never moved'}
                          </div>
                        </>
                      ) : row.approve_blocked ? (
                        <>
                          <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">Not approvable</div>
                          <div className="font-semibold text-[#8B7355]">—</div>
                          <div className="text-[9px] text-[#B8A590] leading-tight">reject this one</div>
                        </>
                      ) : (
                        <>
                          <div className="text-[10px] uppercase tracking-wide text-[#8B7355]">If approved · projected</div>
                          <div className="font-semibold">→ {qty(toPurchaseQty(useLive ? projected! : row.physical_stock, meta))} <span className="text-[11px] font-normal text-[#8B7355]">{pu}</span></div>
                          <div className="text-[9px] text-[#B8A590] leading-tight">
                            {useLive
                              ? (moved ? `from live ${pq(live!)}` : 'live stock unchanged since the count')
                              : 'only if nothing moved since'}
                          </div>
                        </>
                      )}
                    </div>
                  </div>

                  {/* THE CAVEAT USED TO BE UNCONDITIONAL — it no longer has to be.
                      It said "it lands on the counted figure plus anything that
                      moved since, go and look" because the list API sent no live
                      balance and a guessed one would have put back exactly the
                      confident-but-wrong number this card was fixed to stop
                      showing. `live_stock` now arrives PER RAIL (central →
                      raw_materials.current_stock, liquor → its store-ledger
                      on-hand), so for those two rails the page states the
                      arithmetic instead of asking the admin to go and do it.
                      DEPARTMENT ROWS STILL GET THE OLD WORDING, unchanged, and
                      that stays right: live_stock is null there because a dept
                      balance comes from deptOnHand()'s per-row window with no
                      set-based form, and its landing figure is
                      counted + movements-since, which this page cannot compute.
                      Do not "finish" it with rm.current_stock — that is the
                      CENTRAL pool and would be wrong on every department row.
                      SHOWN ONLY WHERE APPROVE IS LIVE. A decided row has no
                      click left to inform, and a blocked row cannot be approved
                      at all — there, the amber refusal below is the whole
                      message and stacking a second notice above it would bury
                      the one that matters, so a superseded row carries its live
                      figure inside that amber block instead. */}
                  {!decided && !row.approve_blocked && (
                    <div className="mt-3 bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg p-2.5 text-[11px] leading-relaxed text-[#6B5744] flex gap-2">
                      <Info className="w-3.5 h-3.5 text-[#af4408] shrink-0 mt-0.5" />
                      {live === null ? (
                        <span>
                          Approving applies the counted <b>difference</b> to the balance as it stands when you click —
                          it does not force the balance to {countedTxt}. It lands on {countedTxt} plus anything that has
                          moved since the count on {row.date}, so if this item was issued, received or transferred after
                          that date the result differs by exactly that much. Worth a look at its movement since {row.date}
                          before you approve.
                        </span>
                      ) : moved ? (
                        <span>
                          <b>Stock has moved since the count on {row.date}.</b> Live now reads {pq(live)}, not the{' '}
                          {systemTxt} this count froze. Approving applies the counted <b>difference</b> of{' '}
                          {delta > 0 ? '+' : '−'}{pq(Math.abs(delta))} to live, landing on <b>{pq(projected!)}</b> — not
                          on the counted {countedTxt}. Check what moved before you approve.
                        </span>
                      ) : (
                        <span>
                          Nothing has moved since the count on {row.date} — live stock still reads {systemTxt}, so
                          approving lands on the counted {countedTxt}. It applies the counted <b>difference</b>, not an
                          absolute, so if something moves before you click the result shifts by exactly that much.
                        </span>
                      )}
                    </div>
                  )}

                  {decided ? (
                    <div className="mt-3 text-[12px] border-t border-[#F0E4D6] pt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className={`inline-flex items-center gap-1 font-medium ${row.status === 'approved' ? 'text-emerald-700' : 'text-[#6B5744]'}`}>
                        {row.status === 'approved' ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                        {row.status === 'approved' ? 'Approved · written to stock' : 'Rejected · stock unchanged'}
                      </span>
                      {/* NOT A NAME ON AN AUTO ROW. reviewed_by is literally
                          "system:auto-apply" there; printing "by system:auto-apply"
                          reads as a user account that does not exist. */}
                      <span className="text-[#8B7355]">
                        {auto || row.reviewed_by === AUTO_REVIEWER
                          ? <>applied by the bar, no one reviewed it · {istWhen(row.reviewed_at)}</>
                          : <>by {row.reviewed_by || '—'} · {istWhen(row.reviewed_at)}</>}
                      </span>
                      {row.review_reason && <span className="text-[#6B5744]">Reason: <span className="italic">{row.review_reason}</span></span>}
                    </div>
                  ) : (
                    <div className="mt-3 border-t border-[#F0E4D6] pt-3 space-y-2">
                      {/* THE REFUSAL, IN THE PAGE'S EXISTING AMBER LANGUAGE — the
                          department block already looked like this and is
                          untouched. A superseded row adds two things around the
                          SAME server sentence and never rewrites it: a heading
                          naming the count that wins, and (where the rail can
                          supply a live balance) the figure approving anyway
                          would actually produce. That figure is the owner's case
                          made visible — Testing Curd 2 lands on 12.994 kg when
                          11 kg is on the shelf. */}
                      {row.approve_blocked && (
                        <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5 text-[12px] text-amber-900 flex gap-2">
                          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                          <span>
                            {supDate && (
                              <b className="block mb-0.5">
                                Superseded — {supStatus === 'approved'
                                  ? `the newer count dated ${supDate} was already approved.`
                                  : `a newer count dated ${supDate} is still pending.`}
                              </b>
                            )}
                            {row.approve_blocked}
                            {/* Compare the RENDERED STRINGS, not the raw numbers.
                                EPS = 1e-6 is a recipe-unit threshold while pq()
                                prints 3 dp of the PURCHASE unit (÷ pack_size, so
                                ÷1000 for g→kg). A 0.4 g gap cleared 1e-6 and then
                                printed "would land this item on 11 kg against a
                                counted 11 kg" — a sentence arguing with itself.
                                Gating on the strings makes that unreachable by
                                construction, whatever the pack size. */}
                            {supDate && projected !== null && pq(projected) !== countedTxt && (
                              <span className="block mt-1">
                                Approving it anyway would land this item on <b>{pq(projected)}</b> against a counted{' '}
                                {countedTxt}.
                              </span>
                            )}
                          </span>
                        </div>
                      )}
                      <input
                        value={reasons[row.id] || ''}
                        onChange={e => setReasons(p => ({ ...p, [row.id]: e.target.value }))}
                        placeholder="Reason (ask the staff who counted — e.g. spillage, breakage, miscount, theft…)"
                        className="w-full px-3 py-2 border border-[#E8D5C4] rounded-lg text-sm bg-[#FFF8F0] focus:outline-none focus:border-[#af4408]"
                      />
                      {/* TWO BUTTONS THAT MUST NOT LOOK ALIKE.
                          Approve WRITES TO STOCK: solid brand orange, semibold,
                          and its label says so. Reject changes nothing: a light
                          neutral outline. Red is deliberately NOT used on Reject
                          — it sits one hue from #af4408, so the pair read as the
                          same button in a hurry, and the harmless action wearing
                          the danger colour taught the wrong instinct besides.
                          DOM order is unchanged from the version before this, so
                          the buttons never swap under a hand already moving. */}
                      <div className="flex flex-wrap gap-2 justify-end">
                        <button onClick={() => decide(row, 'reject')} disabled={busy === row.id}
                                className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm border bg-white disabled:opacity-50 ${
                                  supDate
                                    ? 'font-semibold border-[#6B5744] text-[#4A3B2C] hover:bg-[#F5EDE2]'
                                    : 'font-medium border-[#D4B896] text-[#6B5744] hover:bg-[#FFF1E3]'}`}>
                          {busy === row.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
                          Reject — discard, stock unchanged
                        </button>
                        <button onClick={() => decide(row, 'approve')} disabled={busy === row.id || !!row.approve_blocked}
                                title={row.approve_blocked || undefined}
                                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-semibold bg-[#af4408] hover:bg-[#8a3506] text-white disabled:opacity-50 disabled:cursor-not-allowed">
                          {busy === row.id ? <Loader2 className="w-4 h-4 animate-spin" /> : row.approve_blocked ? <Lock className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
                          {/* NOT "set stock to counted" — approval posts the
                              count-time difference, it does not set an absolute.
                              `disabled` above is the real gate (and decide()
                              re-checks it); this label only has to say WHICH
                              refusal, and there are now two. Keyed off supDate
                              rather than sniffing the message text, so a reworded
                              server sentence cannot mislabel the button. */}
                          {supDate
                            ? 'Approve blocked (superseded count)'
                            : row.approve_blocked
                              ? 'Approve blocked (department count)'
                              : 'Approve → write to stock'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {truncated && (
              <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg p-3 text-[12px] text-[#6B5744] flex gap-2">
                <Info className="w-4 h-4 text-[#af4408] shrink-0 mt-0.5" />
                {/* THE PERIOD/UPLOAD FILTER NARROWS THIS SLICE, IT DOES NOT
                    RE-QUERY (the list endpoint does not take those filters yet),
                    so a filter cannot reach a row the read limit already cut.
                    Say that plainly — a "Nothing in this selection" over a
                    truncated read would otherwise read as "nothing exists". */}
                <span>
                  The server read the newest {num(rows.length)} of {num(total)} {tab} rows; the rest are older counts
                  past the read limit.
                  {filterActive
                    ? ' The period and upload filters narrow what was read — they do not fetch further back, so older rows matching them are not on this page.'
                    : ' Narrow the period or pick one upload to work through them in groups.'}
                  {' '}The bulk action above is resolved by the server and <b>does</b> cover every row it matches,
                  read or not.
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ══ BULK REJECT CONFIRMATION ═══════════════════════════════════════
          It has to state, in plain words, what happens and what does not — the
          whole risk here is an admin believing this is the other button. */}
      {bulkMode && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={closeBulk}>
          <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-lg shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between">
              <h2 className="font-bold text-[#2D1B0E] flex items-center gap-2">
                <Trash2 className="w-5 h-5 text-[#6B5744]" /> Reject {num(bulkCount)} count{bulkCount === 1 ? '' : 's'}
              </h2>
              <button onClick={closeBulk} disabled={bulkBusy} className="text-[#8B7355] hover:text-[#2D1B0E] disabled:opacity-50">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-3 text-sm text-[#2D1B0E]">
              <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg p-3 space-y-1.5 text-[13px] leading-relaxed">
                <p>
                  <b>{num(bulkCount)} count{bulkCount === 1 ? '' : 's'}</b> worth{' '}
                  <b>{bulkValueIsFloor ? 'at least ' : ''}{inr(bulkValueKnown)}</b> of difference will be{' '}
                  <b>discarded</b>.
                </p>
                <p>
                  <b>No stock changes.</b> Not one gram, on any rail — not central stock, not a liquor store ledger, not
                  a department balance. Nothing is written to your books.
                </p>
                {/* "Nothing moves" is true of REJECT and false as a description
                    of where a department row leaves things: that balance moved
                    when the count was saved, and this button does not reverse
                    it. Say it here, next to the reassurance, or the reassurance
                    is the thing that misleads. */}
                <p className="text-[#6B5744]">
                  It does not <b>undo</b> anything either. A department count already moved that department&apos;s own
                  balance when it was saved — rejecting closes the row, it does not put the figure back. Re-count to
                  correct one.
                </p>
                <p>
                  The counts stay readable on the <b>Rejected</b> tab with your reason on every row. The differences
                  stand as open losses to chase.
                </p>
                <p className="text-[#6B5744]">
                  This is <b>not</b> the Approve button. Approving is what writes a count into stock, and it is done one
                  row at a time.
                </p>
              </div>

              {bulkMode === 'filter' && preview && (
                <div className="text-[12px] text-[#6B5744]">
                  Selection:{' '}
                  {preview.filter.from || preview.filter.to
                    ? <>count dates {preview.filter.from || 'the beginning'} → {preview.filter.to || 'today'}</>
                    : <>every count date</>}
                  {preview.filter.batch_id != null && (
                    <> · upload <b>{batches.find(b => b.batch_id === preview.filter.batch_id)?.batch_label
                      || (preview.filter.batch_id ? preview.filter.batch_id : 'saved before uploads were tracked')}</b></>
                  )}
                  {preview.filter.source && <> · {preview.filter.source === 'liquor' ? 'liquor stores' : 'central store / departments'} only</>}
                  {preview.filter.outlet === 'all' && <> · all outlets</>}
                </div>
              )}

              <label className="block">
                <span className="text-[12px] font-medium text-[#6B5744]">Why are these being discarded? (recorded on every row)</span>
                <input value={bulkReason} onChange={e => setBulkReason(e.target.value)} autoFocus
                       placeholder="e.g. blank cells came through as 0 — sheet re-uploaded"
                       className="w-full mt-1 px-3 py-2 border border-[#E8D5C4] rounded-lg text-sm bg-[#FFF8F0] focus:outline-none focus:border-[#af4408]" />
              </label>

              {/* THE TYPED NUMBER, FILTER MODE ONLY. An id list was ticked row by
                  row; a filter can be thousands of rows nobody has looked at. */}
              {bulkMode === 'filter' && (
                <label className="block">
                  <span className="text-[12px] font-medium text-[#6B5744]">
                    Type <b className="font-mono">{num(bulkCount)}</b> to confirm you mean all of them
                  </span>
                  <input value={bulkTyped} onChange={e => setBulkTyped(e.target.value)} inputMode="numeric"
                         className="w-full mt-1 px-3 py-2 border border-[#E8D5C4] rounded-lg text-sm bg-[#FFF8F0] font-mono focus:outline-none focus:border-[#af4408]" />
                </label>
              )}

              {bulkErr && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-2.5 text-[12px] text-red-700 flex gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {bulkErr}
                </div>
              )}
            </div>

            <div className="px-5 py-4 border-t border-[#E8D5C4] flex flex-wrap justify-end gap-2">
              <button onClick={closeBulk} disabled={bulkBusy}
                      className="px-4 py-2 text-sm text-[#6B5744] bg-[#FFF1E3] rounded-lg hover:bg-[#E8D5C4] disabled:opacity-50">
                Cancel
              </button>
              <button onClick={runBulkReject} disabled={bulkBusy || bulkCount === 0}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-[#6B5744] hover:bg-[#54432f] text-white disabled:opacity-50">
                {bulkBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                Reject {num(bulkCount)} — stock unchanged
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 bg-[#2D1B0E] text-white text-sm px-4 py-2.5 rounded-lg shadow-lg max-w-[92vw] text-center">
          {toast}
        </div>
      )}
    </div>
  );
}
