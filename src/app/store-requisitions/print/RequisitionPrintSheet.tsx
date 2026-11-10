'use client';

/**
 * REQUISITION ISSUE SLIP — A4 / Save as PDF (owner ruling #126).
 *
 * One slip per requisition, each on its own page. Rendered by BOTH print routes:
 *   /store-requisitions/print?ids=…  — the Store desk's per-card Print and its
 *                                      "Print all" for the tab in view
 *   /requisitions/print?ids=…        — the Print button in the Requisitions
 *                                      detail panel (staff, HODs, managers)
 * Each route sits under its screen's path, so canAccessPage's prefix rule opens
 * it to exactly the people who can open that screen — no catalog row, no role
 * change.
 *
 * WHO SEES WHAT — the owner's "Anyone who can see it": every figure comes from
 * GET /api/requisitions?id=, the same read both screens use, which applies
 * requisitionVisibility server-side. A requisition the viewer cannot open there
 * answers 404 here too and is reported as not printed — never shown.
 *
 * NO MONEY: like the Store desk, the slip carries no ₹ (the issue log with
 * rates is a management page). NO EMAILS: the "who" columns store emails, so
 * names come from /api/requisitions/print-people.
 *
 * UNITS: quantities LEAD with the PURCHASE unit (owner rule 2026-07-27).
 * Requisition quantities are stored in the LINE's own `unit` (option B), so
 * each figure is resolved through slipUnits — the Store desk's lineUnits, line
 * for line — and the line's done/owed test is desk-rule.ts deskLineComplete,
 * THE RULE both desks run. Paper and screen cannot disagree about a balance.
 */

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Printer } from 'lucide-react';
import { packFactor } from '@/lib/pack-units';
import { deskLineComplete } from '@/lib/desk-rule';
import { fmtIST, fmtISTDate } from '@/lib/format-date';
import { isDeliveredDirect, deliveredDirectDept } from '@/components/MergePoModal';

import { MAX_PRINT_IDS } from '@/lib/requisition-print';

interface SlipLine {
  id: string;
  material_name: string;
  material_sku?: string | null;
  material_category?: string | null;
  material_unit?: string | null;
  material_purchase_unit?: string | null;
  material_pack_size?: number | null;
  unit?: string | null;
  quantity_requested: number | null;
  chef_approved_qty: number | null;
  quantity_issued: number | null;
  is_rejected?: number | boolean | null;
  chef_note?: string | null;
  store_rejected?: number | boolean | null;
  store_reject_reason?: string | null;
  deferred_until?: string | null;
  defer_reason?: string | null;
  shelf_emptied_qty?: number | null;
  issue_history?: string | null;
  notes?: string | null;
  item_department_name?: string | null;
  routed?: { sentence?: string } | null;
  delivered_direct?: unknown;
  delivered_direct_dept_name?: string | null;
  delivered_direct_closed_by?: 'system' | 'store' | null;
  delivered_direct_partial?: { qty_purchase: number; still_issuable_purchase: number } | null;
}

interface SlipReq {
  id: string;
  req_number: string;
  date: string;
  status: string;
  purpose?: string | null;
  department_name: string;
  notes?: string | null;
  event_name?: string | null;
  event_date?: string | null;
  guest_count?: number | null;
  drafted_by?: string | null;
  submitted_at?: string | null;
  chef_approved_at?: string | null;
  chef_approved_by?: string | null;
  chef_note?: string | null;
  mgmt_approved_at?: string | null;
  mgmt_approved_by?: string | null;
  rejected_at?: string | null;
  rejected_by?: string | null;
  rejected_reason?: string | null;
  store_processed_at?: string | null;
  store_processed_by?: string | null;
  cancelled_at?: string | null;
  items: SlipLine[];
}

const fmtNum = (v: number) => (v || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
/** fmtCapPU — the Store desk's crumb printer: a figure under one printed step
 *  (0.001) is shown at the precision that carries it, never as "0". */
const fmtCapPU = (v: number, pf = 1) => {
  const n = Number(v) || 0;
  if (!(n > 0 && n < 0.001)) return fmtNum(n);
  const dp = Math.min(20, 6 + Math.max(0, Math.ceil(Math.log10(pf > 1 ? pf : 1))));
  return n.toLocaleString('en-IN', { maximumFractionDigits: dp });
};

/**
 * The Store desk's lineUnits (store-requisitions/page.tsx), the read half only.
 * A line stored in the purchase unit (unit === purchase unit on a packed
 * material) is already purchase units; a blank or recipe unit is recipe units
 * and divides by the pack. Kept in step with that function by hand — it is a
 * page-local helper there and a page file cannot export it.
 */
function slipUnits(line: SlipLine) {
  const recipeUnit = line.material_unit || line.unit || '';
  const pf = packFactor({
    unit: recipeUnit,
    purchase_unit: line.material_purchase_unit,
    pack_size: line.material_pack_size,
  });
  const pu = line.material_purchase_unit || recipeUnit;
  const lu = String(line.unit || '').toLowerCase().trim();
  const isPU = pf > 1 && lu !== '' && lu === String(pu).toLowerCase().trim();
  return { pf, pu, recipeUnit, isPU };
}

/** A line quantity in the purchase unit — fmtHandOverPU on the Store desk. */
function fmtPU(U: ReturnType<typeof slipUnits>, q: number | null | undefined): string {
  const v = Number(q) || 0;
  const exact = U.isPU ? v : v / U.pf;
  if (exact > 0 && exact < 0.001) return fmtCapPU(exact, U.pf);
  return fmtNum(Math.round(exact * 1000) / 1000);
}

/** The Store desk's effectiveQty: an HOD-rejected line owes nothing. */
function effectiveQty(line: SlipLine): number {
  if (line.is_rejected) return 0;
  if (line.chef_approved_qty != null) return Number(line.chef_approved_qty);
  return Number(line.quantity_requested) || 0;
}

/** The Store desk's owedQty, exactly: effective − issued, or 0 once THE RULE
 *  says the line is done. It does not look at a store rejection — that is what
 *  the desk reads as the quantity a rejection CANCELLED (deliveryState). */
function deskOwed(line: SlipLine): number {
  const issued = Number(line.quantity_issued) || 0;
  const eff = effectiveQty(line);
  if (deskLineComplete(issued, eff, line)) return 0;
  return Math.max(0, eff - issued);
}

/** The Balance column: what the department is still owed. A store-rejected
 *  line owes nothing (the desk's partition skips it), however much was cut. */
function owedQty(line: SlipLine): number {
  if (line.is_rejected || line.store_rejected) return 0;
  return deskOwed(line);
}

const anyIssued = (r: SlipReq) => r.items.some(l => (Number(l.quantity_issued) || 0) > 0);

/** Has the HOD (or the old Mgmt gate) approved this requisition? Before that,
 *  no approved quantity exists and the slip must not print one. */
function isApproved(r: SlipReq): boolean {
  return !!r.chef_approved_at
    || ['chef_approved', 'mgmt_approved', 'store_processed', 'fulfilled'].includes(r.status);
}

/** A party requisition the HOD approved that still waits for Management —
 *  only when the Mgmt gate is ON (Settings → Integrations,
 *  require_mgmt_approval); the store cannot issue it yet. Internal ones never
 *  had a Mgmt step (api/requisitions inbox=store). */
const awaitingMgmt = (r: SlipReq, requireMgmt: boolean) =>
  requireMgmt && r.purpose === 'party' && r.status === 'chef_approved';

/** The requisition's state in words that are true whatever the Mgmt gate
 *  setting is (what happened, not whose desk it sits on). */
function statusWords(r: SlipReq, requireMgmt: boolean): string {
  switch (r.status) {
    case 'draft':           return 'Draft — not sent';
    case 'submitted':       return 'Waiting for HOD approval';
    case 'chef_approved':   return awaitingMgmt(r, requireMgmt) ? 'HOD approved — waiting for Management' : 'HOD approved';
    case 'mgmt_approved':   return 'Management approved';
    case 'chef_rejected':   return 'Rejected by HOD';
    // store-issue flips a requisition to store_processed on ANY gesture — a
    // defer alone, or an undo of everything — so the word follows the lines.
    case 'store_processed': return anyIssued(r) ? 'Partly issued' : 'With Store — nothing issued yet';
    case 'cancelled':       return 'Cancelled';
    case 'fulfilled': {
      // The Store desk's deliveryState, line for line: 'fulfilled' is a
      // workflow state, not a delivery claim. Only what the STORE cancelled by
      // rejecting counts (an HOD cut is the department's own decision and the
      // desk deliberately does not call it "short"); the word then says
      // whether anything at all reached the department.
      let cut = 0;
      for (const l of r.items) if (l.store_rejected) cut += deskOwed(l);
      if (cut <= 0) return 'Fulfilled';
      return anyIssued(r) ? 'Closed short' : 'Closed';
    }
    default: return r.status;
  }
}

/** A watermark for a slip that must not pass for a store issue document. */
function watermarkOf(r: SlipReq, requireMgmt: boolean): string | null {
  if (r.status === 'draft' || r.status === 'submitted') return 'NOT APPROVED';
  if (awaitingMgmt(r, requireMgmt)) return 'AWAITING MANAGEMENT';
  if (r.status === 'chef_rejected') return 'REJECTED';
  if (r.status === 'cancelled') return 'CANCELLED';
  return null;
}

function lineRemarks(r: SlipReq, l: SlipLine): string[] {
  const out: string[] = [];
  if (l.is_rejected) out.push(`Rejected by HOD${l.chef_note ? `: ${l.chef_note}` : ''}`);
  else if (l.chef_note) out.push(`HOD note: ${l.chef_note}`);
  const direct = isDeliveredDirect(l as any);
  const dept = direct ? deliveredDirectDept(l as any) : '';
  const reason = l.store_reject_reason ? ` — ${l.store_reject_reason}` : '';
  // A delivered-direct line the store (or the system) closed is NOT a
  // rejection — the Store desk words it exactly so (ruling #68).
  if (l.store_rejected && direct) {
    out.push(`${l.delivered_direct_closed_by === 'system' ? 'Closed automatically' : 'Closed by store'}`
      + ` — delivered direct${dept ? ` to ${dept}` : ''}, not issued from central${reason}`);
  } else if (l.store_rejected) {
    out.push(`Rejected by store${reason}`);
  } else if (direct) {
    out.push(`Delivered direct${dept ? ` to ${dept}` : ''} — do not issue`);
  }
  // Ruling #73: part of the line came direct from the vendor; the store may
  // still issue only the rest (purchase units, from the server's own figure).
  const part = l.delivered_direct_partial;
  if (part && !l.store_rejected) {
    const U = slipUnits(l);
    out.push(`Part delivered direct: ${fmtNum(Number(part.qty_purchase) || 0)} ${U.pu}`
      + ` — the store may issue up to ${fmtNum(Number(part.still_issuable_purchase) || 0)} ${U.pu} more`);
  }
  // A store promise stands only while the line is still owed on a live
  // requisition — a cancelled one owes nothing, whatever the line still says.
  if (String(l.deferred_until || '').trim() && owedQty(l) > 0 && r.status !== 'cancelled') {
    out.push(`Promised for ${fmtIST(l.deferred_until)}${l.defer_reason ? ` — ${l.defer_reason}` : ''}`);
  }
  if (l.routed?.sentence) out.push(l.routed.sentence);
  if (l.notes) out.push(`Note: ${l.notes}`);
  // An HOD-changed quantity is already visible as two different figures in
  // the Requested and HOD-approved columns; only an approved slip says so.
  if (isApproved(r) && !l.is_rejected && l.chef_approved_qty != null
      && Number(l.chef_approved_qty) !== Number(l.quantity_requested)) {
    out.push('HOD changed the quantity');
  }
  return out;
}

type Names = Record<string, string>;
/** A stored "who" (an email) as a printable name. An email nobody matches
 *  prints nothing — paper carries no email addresses. */
function nameOf(names: Names, who: string | null | undefined): string {
  const s = String(who || '').trim();
  if (!s) return '';
  if (names[s]) return names[s];
  // An unmatched email, or a machine stamp such as 'system:delivered-direct'
  // (po-link-lifecycle.ts), is not a person's name — print nothing.
  return s.includes('@') || s.includes(':') || /^system\b/i.test(s) ? '' : s;
}

const ms = (v: unknown) => {
  const s = String(v || '').trim();
  if (!s) return NaN;
  // SQLite 'YYYY-MM-DD HH:MM:SS' is UTC, like the ISO stamps in issue_history.
  return Date.parse(/^\d{4}-\d{2}-\d{2} \d/.test(s) ? `${s.replace(' ', 'T')}Z` : s);
};

/**
 * Who handed goods over on this requisition, by name, and a time that says
 * exactly what it is.
 *  - store-issue (the Store desk) writes issue_history {qty, at, by} per line.
 *  - store-process ("Issue to Department" on /requisitions) writes NO history;
 *    the requisition keeps only the FIRST processor and time
 *    (store_processed_by/at = COALESCE).
 * So the history names are always listed; store_processed_by joins them when a
 * line holds goods its history does not account for. The time is "Last
 * hand-over" only when the history accounts for every issued line, "Store
 * processed" when there is no history at all, and left off when the two mix.
 */
function issuersOf(r: SlipReq, names: Names): { who: string[]; when: string } {
  const who: string[] = [];
  let lastMs = NaN;
  let uncovered = false;
  let anyHistory = false;
  for (const l of r.items) {
    let h: any[] = [];
    try { h = JSON.parse(l.issue_history || '[]'); } catch { h = []; }
    if (!Array.isArray(h)) h = [];
    let covered = false;
    for (const e of h) {
      if (!(Number(e?.qty) > 0)) continue;
      covered = true; anyHistory = true;
      const n = nameOf(names, e?.by);
      if (n && !who.includes(n)) who.push(n);
      const t = ms(e?.at);
      if (Number.isFinite(t) && !(t <= lastMs)) lastMs = t;
    }
    // A ROUTED line's quantity_issued is written by the department transfer
    // that sent it (ruling #45) — never by the store — so it must not pull a
    // store person's name into this box.
    if ((Number(l.quantity_issued) || 0) > 0 && !covered && !l.routed) uncovered = true;
  }
  if (uncovered) {
    const n = nameOf(names, r.store_processed_by);
    if (n && !who.includes(n)) who.push(n);
  }
  let when = '';
  if (!uncovered && Number.isFinite(lastMs)) when = `Last hand-over: ${fmtIST(new Date(lastMs).toISOString())}`;
  else if (uncovered && !anyHistory && r.store_processed_at) when = `Store processed: ${fmtIST(r.store_processed_at)}`;
  return { who, when };
}

function SignBox({ title, name, when, note }: { title: string; name?: string; when?: string; note?: string }) {
  return (
    <div className="border border-[#1a1a1a] rounded p-2 flex flex-col min-h-[92px]">
      <div className="text-[10px] font-bold uppercase tracking-wide">{title}</div>
      <div className="text-[11px] mt-1">Name: {name ? <b>{name}</b> : <span className="inline-block w-[70%] border-b border-dotted border-[#888]">&nbsp;</span>}</div>
      {when && <div className="text-[10px] text-[#444]">{when}</div>}
      {note && <div className="text-[10px] text-[#444] italic">{note}</div>}
      <div className="mt-auto pt-4 text-[10px] text-[#444]">Signature: <span className="inline-block w-[62%] border-b border-[#1a1a1a]">&nbsp;</span></div>
    </div>
  );
}

function Slip({ r, names, biz, viewer, printedAt, index, total, contextLine, requireMgmt }: {
  r: SlipReq; names: Names; biz: string; viewer: string; printedAt: string;
  index: number; total: number; contextLine: string; requireMgmt: boolean;
}) {
  const approved = isApproved(r);
  // A cancelled requisition owes nothing: its slip prints no Balance.
  const showBalance = approved && r.status !== 'cancelled';
  const mark = watermarkOf(r, requireMgmt);
  // Category-wise, like the Store desk's hand-over view — the order a
  // storekeeper walks the shelves in.
  const groups = useMemo(() => {
    const m = new Map<string, SlipLine[]>();
    for (const l of r.items) {
      const c = String(l.material_category || '').trim() || 'Other';
      if (!m.has(c)) m.set(c, []);
      m.get(c)!.push(l);
    }
    return [...m.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([cat, lines]) => [cat, [...lines].sort((a, b) => String(a.material_name).localeCompare(String(b.material_name)))] as const);
  }, [r.items]);
  // A party requisition can carry a department per line ("Multiple
  // departments"); the column appears only when a line names another one.
  const showDept = r.items.some(l => {
    const d = String(l.item_department_name || '').trim();
    return d !== '' && d !== String(r.department_name || '').trim();
  });
  const issued = issuersOf(r, names);
  const raisedBy = nameOf(names, r.drafted_by);
  const hodBy = nameOf(names, r.chef_approved_by);
  const mgmtBy = nameOf(names, r.mgmt_approved_by);
  let n = 0;

  return (
    <section className="slip relative bg-white">
      {mark && <div className="slip-watermark" aria-hidden="true"><span>{mark}</span></div>}
      <div className="flex items-start justify-between gap-4 border-b-2 border-[#1a1a1a] pb-2 mb-3">
        <div>
          {biz && <div className="text-[13px] font-bold">{biz}</div>}
          <div className="text-[16px] font-extrabold tracking-wide">REQUISITION — STORE ISSUE SLIP</div>
          <div className="text-[11px] text-[#444]">
            {r.purpose === 'party' ? 'Party requisition' : 'Internal requisition'}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="font-mono text-[16px] font-bold whitespace-nowrap">{r.req_number}</div>
          {total > 1 && <div className="text-[10px] text-[#444]">Slip {index + 1} of {total}</div>}
          {contextLine && <div className="text-[10px] text-[#444]">{contextLine}</div>}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-[11px] mb-3">
        <div><span className="text-[#555]">Department:</span> <b>{r.department_name}</b></div>
        <div><span className="text-[#555]">Date:</span> <b>{fmtISTDate(r.date)}</b></div>
        <div><span className="text-[#555]">Status:</span> <b>{statusWords(r, requireMgmt)}</b></div>
        <div><span className="text-[#555]">Lines:</span> <b>{r.items.length}</b></div>
        {r.purpose === 'party' && r.event_name && (
          <div className="col-span-2"><span className="text-[#555]">Event:</span> <b>{r.event_name}</b></div>
        )}
        {r.purpose === 'party' && r.event_date && (
          <div><span className="text-[#555]">Event date:</span> <b>{fmtISTDate(r.event_date)}</b></div>
        )}
        {r.purpose === 'party' && Number(r.guest_count) > 0 && (
          <div><span className="text-[#555]">Guests:</span> <b>{r.guest_count}</b></div>
        )}
      </div>
      {r.notes && <div className="text-[11px] mb-2"><span className="text-[#555]">Notes:</span> {r.notes}</div>}
      {r.status === 'chef_rejected' && r.rejected_reason && (
        <div className="text-[11px] mb-2"><span className="text-[#555]">Rejected:</span> {r.rejected_reason}</div>
      )}

      {/* On a phone screen the table slides sideways; say so, or HOD approved /
          Issued / Balance sit off-screen unseen. Paper always has every column. */}
      <div className="no-print sm:hidden text-[10px] text-[#8B7355] mb-1">
        Slide the table sideways to see HOD approved, Issued and Balance. The printout shows every column.
      </div>
      <div className="slip-table-wrap">
        <table className="w-full text-[11px] border-collapse">
          <thead>
            <tr className="border-y border-[#1a1a1a] text-left">
              <th className="py-1 pr-1 w-6">#</th>
              <th className="py-1 pr-2">Item</th>
              {showDept && <th className="py-1 pr-2">Dept</th>}
              <th className="py-1 pr-2">Unit</th>
              <th className="py-1 pr-2 text-right">Requested</th>
              <th className="py-1 pr-2 text-right">HOD approved</th>
              <th className="py-1 pr-2 text-right">Issued</th>
              <th className="py-1 pr-2 text-right">Balance</th>
              <th className="py-1 pr-2 text-center w-10">Given ✓</th>
              <th className="py-1">Remarks</th>
            </tr>
          </thead>
          <tbody>
            {groups.map(([cat, lines]) => (
              <Fragment key={cat}>
                <tr className="cat-row">
                  <td colSpan={showDept ? 10 : 9} className="pt-2 pb-0.5 text-[10px] font-bold uppercase tracking-wide text-[#333]">{cat}</td>
                </tr>
                {lines.map(l => {
                  n += 1;
                  const U = slipUnits(l);
                  const remarks = lineRemarks(r, l);
                  return (
                    <tr key={l.id} className="border-b border-[#ccc] align-top">
                      <td className="py-1 pr-1">{n}</td>
                      <td className="py-1 pr-2">
                        <div className="font-medium">{l.material_name}</div>
                        {l.material_sku && <div className="text-[9px] text-[#666] font-mono">{l.material_sku}</div>}
                      </td>
                      {showDept && <td className="py-1 pr-2">{l.item_department_name || r.department_name}</td>}
                      <td className="py-1 pr-2 whitespace-nowrap">
                        {U.pu}
                        {U.pf > 1 && <div className="text-[9px] text-[#666]">1 {U.pu} = {fmtNum(U.pf)} {U.recipeUnit}</div>}
                      </td>
                      <td className="py-1 pr-2 text-right font-mono">{fmtPU(U, l.quantity_requested)}</td>
                      <td className="py-1 pr-2 text-right font-mono">
                        {!approved ? '—' : l.is_rejected ? 'Rejected' : fmtPU(U, effectiveQty(l))}
                      </td>
                      <td className="py-1 pr-2 text-right font-mono">{fmtPU(U, l.quantity_issued)}</td>
                      <td className="py-1 pr-2 text-right font-mono font-bold">
                        {!showBalance ? '—' : fmtPU(U, owedQty(l))}
                      </td>
                      <td className="py-1 pr-2 text-center"><span className="inline-block w-4 h-4 border border-[#1a1a1a]" /></td>
                      <td className="py-1 text-[10px]">{remarks.join(' · ')}</td>
                    </tr>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <div className="text-[9px] text-[#555] mt-1">
        Quantities are in the purchase unit shown. Balance = HOD-approved quantity still to be given.
      </div>

      <div className="sign-grid grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4">
        <SignBox title="Raised by" name={raisedBy}
                 when={r.submitted_at ? `Sent: ${fmtIST(r.submitted_at)}` : undefined} />
        <SignBox title="Approved by (HOD)" name={hodBy}
                 when={r.chef_approved_at ? `Approved: ${fmtIST(r.chef_approved_at)}` : undefined}
                 note={mgmtBy ? `Management: ${mgmtBy}` : undefined} />
        <SignBox title="Issued by (Store)" name={issued.who.join(', ')} when={issued.when || undefined} />
        <SignBox title="Received by (Department)" />
      </div>

      <div className="mt-3 pt-1 border-t border-[#ccc] text-[9px] text-[#555] flex justify-between gap-2">
        <span>Printed{viewer ? ` by ${viewer}` : ''} on {printedAt}</span>
        <span>{r.req_number}</span>
      </div>
    </section>
  );
}

/**
 * The page body of both print routes. `ids` are requisition ids in the order
 * the screen showed them; `context` is a short line for each slip ("Pending
 * Issue · Kitchen") when printed from the Store desk's Print all.
 */
export default function RequisitionPrintSheet({ ids, context }: { ids: string[]; context?: string }) {
  const wanted = useMemo(() => [...new Set(ids.map(s => s.trim()).filter(Boolean))], [ids]);
  const capped = wanted.slice(0, MAX_PRINT_IDS);
  const idsKey = capped.join(',');
  const [reqs, setReqs] = useState<SlipReq[] | null>(null);
  const [missing, setMissing] = useState(0);   // 404: deleted, or not the viewer's to see
  const [failed, setFailed] = useState(0);     // any other failure: worth a reload
  const [progress, setProgress] = useState(0);
  const [names, setNames] = useState<Names>({});
  const [viewer, setViewer] = useState('');
  const [biz, setBiz] = useState('');
  const [requireMgmt, setRequireMgmt] = useState(false);
  const [error, setError] = useState('');
  const printed = useRef(false);
  const printedAt = useMemo(() => fmtIST(new Date().toISOString()), []);
  // Free text from the URL; React escapes it, and a short cap keeps a crafted
  // link from stamping a paragraph on every slip.
  const ctx = String(context || '').slice(0, 80);

  useEffect(() => {
    let cancelled = false;
    if (!idsKey) { setReqs([]); return; }
    (async () => {
      try {
        const list = idsKey.split(',');
        const [bizRes, gateRes, peopleStatus] = await Promise.all([
          fetch('/api/settings?key=business_name').then(r => (r.ok ? r.json() : null)).catch(() => null),
          fetch('/api/settings?key=require_mgmt_approval').then(r => (r.ok ? r.json() : null)).catch(() => null),
          fetch(`/api/requisitions/print-people?ids=${encodeURIComponent(idsKey)}`)
            .then(async r => ({ status: r.status, body: r.ok ? await r.json() : null }))
            .catch(() => ({ status: 0, body: null })),
        ]);
        if (cancelled) return;
        // /api/requisitions?id= answers 404 (not 401) to a session that has
        // expired or been switched off — its visibility filter becomes 0=1 —
        // so the honest "sign in again" comes from this route's 401.
        if (peopleStatus.status === 401) { setError('Sign in required — please sign in again and reopen this print.'); return; }
        if (bizRes?.value) setBiz(String(bizRes.value));
        setRequireMgmt(gateRes?.value === '1');
        const peopleRes = peopleStatus.body;
        if (peopleRes?.names) setNames(peopleRes.names);
        if (peopleRes?.viewer_name) setViewer(String(peopleRes.viewer_name));
        const out: Array<SlipReq | null> = [];
        let notFound = 0, broke = 0;
        // Six at a time — the Store desk itself fetches every detail at once;
        // a long Print all should not hammer the server harder than that.
        for (let i = 0; i < list.length; i += 6) {
          const part = await Promise.all(list.slice(i, i + 6).map(async id => {
            try {
              const res = await fetch(`/api/requisitions?id=${encodeURIComponent(id)}`);
              if (res.status === 404) { notFound++; return null; }
              if (!res.ok) { broke++; return null; }
              const d = await res.json();
              if (!d?.requisition) { broke++; return null; }
              return d.requisition as SlipReq;
            } catch { broke++; return null; }
          }));
          if (cancelled) return;
          out.push(...part);
          setProgress(out.length);
        }
        setMissing(notFound);
        setFailed(broke);
        setReqs(out.filter((x): x is SlipReq => !!x));
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Could not load the requisitions.');
      }
    })();
    return () => { cancelled = true; };
  }, [idsKey]);

  const notPrinted = missing + failed + (wanted.length - capped.length);

  // Auto-print once everything is on the page, like the GRN and PO prints —
  // but NOT when something was left out: the person reads why first and
  // presses Print. The ref keeps React's dev double-effect from opening two
  // dialogs.
  useEffect(() => {
    if (!reqs || reqs.length === 0 || notPrinted > 0 || printed.current) return;
    printed.current = true;
    const t = setTimeout(() => window.print(), 600);
    return () => clearTimeout(t);
  }, [reqs, notPrinted]);

  if (error) return <div className="p-10 text-center text-sm text-red-700">{error}</div>;
  if (wanted.length === 0) {
    return <div className="p-10 text-center text-sm text-[#8B7355]">Nothing to print — no requisition was chosen.</div>;
  }
  if (!reqs) {
    return (
      <div className="p-10 text-center text-sm text-[#8B7355]">
        <Loader2 className="animate-spin inline mr-1" size={14} />
        Loading requisitions… {progress} of {capped.length}
      </div>
    );
  }

  return (
    <div className="bg-white text-[#1a1a1a] mx-auto max-w-[900px] p-4 sm:p-8 print:p-0 leading-snug">
      <style>{`
        @media print {
          @page { size: A4; margin: 12mm; }
          html, body { background: #fff !important; }
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .no-print { display: none !important; }
          aside, nav { display: none !important; }
          .slip { break-after: page; page-break-after: always; }
          .slip:last-of-type { break-after: auto; page-break-after: auto; }
          .slip-table-wrap { overflow: visible !important; }
          .sign-grid { grid-template-columns: repeat(4, minmax(0, 1fr)) !important; }
          thead { display: table-header-group; }
          tr, .sign-grid { break-inside: avoid; page-break-inside: avoid; }
          .cat-row { break-after: avoid; page-break-after: avoid; }
        }
        @media screen {
          .slip { box-shadow: 0 0 0 1px #E8D5C4, 0 4px 24px rgba(0,0,0,.05); padding: 16px; margin-bottom: 24px; }
          .slip-table-wrap { overflow-x: auto; }
          .slip-table-wrap table { min-width: 720px; }
        }
        /* Anchored near the TOP of the slip, not its middle: a slip longer
           than one A4 page would otherwise carry its stamp across the page
           break, or onto page two only. */
        .slip-watermark {
          position: absolute; inset: 0; display: flex; align-items: flex-start; justify-content: center;
          padding-top: 150px; pointer-events: none; z-index: 5;
        }
        .slip-watermark span {
          transform: rotate(-24deg);
          font-size: 64px; font-weight: 800; letter-spacing: .14em; text-align: center;
          color: rgba(190, 30, 30, .15); border: 7px solid rgba(190, 30, 30, .15);
          padding: .08em .18em; border-radius: 12px;
          -webkit-print-color-adjust: exact; print-color-adjust: exact;
        }
      `}</style>

      <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-[#8B7355]">
          {reqs.length} slip{reqs.length === 1 ? '' : 's'} ready, one per page.{' '}
          {notPrinted > 0 || reqs.length === 0
            ? <>Read the note below, then press <b>Print</b> — choose your printer or <b>Save as PDF</b>.</>
            : <>Printing starts shortly — choose your printer or <b>Save as PDF</b>. Use Ctrl/Cmd-P if it doesn&apos;t.</>}
        </div>
        <button onClick={() => window.print()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#af4408] text-white rounded text-xs">
          <Printer size={14} /> Print
        </button>
      </div>
      {notPrinted > 0 && (
        <div className="no-print mb-4 px-3 py-2 rounded border border-amber-300 bg-amber-50 text-xs text-amber-900">
          {notPrinted} of the {wanted.length} requisition{wanted.length === 1 ? '' : 's'} asked for {notPrinted === 1 ? 'is' : 'are'} not in this print:
          {missing > 0 && <> {missing} could not be opened (deleted, or not one you can see).</>}
          {failed > 0 && <> {failed} could not be loaded — reload this page to try again.</>}
          {wanted.length > capped.length && <> Only the first {MAX_PRINT_IDS} are printed at once.</>}
        </div>
      )}
      {/* …and on the paper itself, so a short stack never passes for the whole list. */}
      {notPrinted > 0 && reqs.length > 0 && (
        <div className="hidden print:block mb-2 text-[10px]">
          Note: {notPrinted} of the {wanted.length} requisitions asked for {notPrinted === 1 ? 'is' : 'are'} not in this print.
        </div>
      )}
      {reqs.length === 0 ? (
        <div className="p-10 text-center text-sm text-[#8B7355]">Nothing to print.</div>
      ) : reqs.map((r, i) => (
        <Slip key={r.id} r={r} names={names} biz={biz} viewer={viewer} printedAt={printedAt}
              index={i} total={reqs.length} contextLine={ctx} requireMgmt={requireMgmt} />
      ))}
    </div>
  );
}
