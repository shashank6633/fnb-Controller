'use client';

/**
 * RECEIVING / RECEIVABLES QUALITY CHECK — the delivery at the door (P4, owner §2).
 *
 * ── THIS IS NOT A SECOND GOODS-RECEIPT SCREEN ───────────────────────────────
 * The GRN screen records WHAT ARRIVED and already has a hold that keeps a delivery
 * as awaiting quality check until the kitchen or the store signs. This screen
 * records WHETHER IT WAS FIT, line by line — and it READS the goods receipt to do
 * it, so nobody types a delivery twice. Accepting or rejecting a line here changes
 * no quantity anywhere: NOTHING IN FSSAI MOVES STOCK (HARD RULE 5), and the screen
 * says so rather than leaving a checker to discover it.
 *
 * ── THE MEASUREMENT THAT SHAPED THE FORM ────────────────────────────────────
 * The goods-receipt screen carries six quality tick-boxes as integers, and on the
 * live data all 29 deliveries have all six reading 0 — which cannot tell "checked
 * and wrong" from "nobody ticked it". Every checkpoint here has FOUR states:
 * not checked · in order · not in order · not applicable. Only "not in order" is a
 * failure, and "not checked" is never a pass — it blocks the filing instead, and
 * the refusal names exactly which checks on which lines it is waiting for.
 *
 * ── THE LIFECYCLE, AND THE ONE IRREVERSIBLE STEP ────────────────────────────
 *   draft → submitted → verified          void (a manager, with a written reason)
 * A draft can be changed freely. The moment it is FILED the verdict is frozen and
 * nothing can edit it — no quantity, no tick-box, no reason. That is the point of a
 * register, and the screen says it before the button is pressed, not after.
 *
 * API: GET /api/fssai/receiving[?id=|?open_grns=1|?prefill=1&grn_id=|?photo_id=]
 *      POST { action: create | save_header | save_line | remove_line | submit
 *                     | verify | void | attach }
 * Every mutation goes through apiJson() so the fnb_csrf header is sent.
 *
 * Styling is the house skeleton (RECON §1.3-1.6). ⚠️ globals.css force-wraps any
 * `.flex.gap-2|3|4`, so rows that must keep an icon beside their text carry
 * `flex-nowrap`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft, Ban, BadgeCheck, Camera, Check, FileText, Info,
  Loader2, Lock, PackageCheck, Plus, RefreshCw, Search, Trash2, Truck, X,
} from 'lucide-react';
import { apiJson } from '@/lib/api';
import ImageUpload from '@/app/tasks/_components/ImageUpload';
import {
  FSSAI_RECEIVING_CHECKPOINTS, FSSAI_CHECK_RESULTS, FSSAI_RECEIVING_DECISIONS,
  FSSAI_REJECT_REASONS, FSSAI_SHIFTS, fssaiToday,
} from '@/lib/fssai';

interface Check {
  id: string; check_no: string; business_date: string; received_at: string; shift: string;
  grn_id: string; grn_number: string; grn_voided_since: boolean;
  vendor_id: string; vendor_name: string;
  supplier_licence_no: string; supplier_licence_expiry: string;
  supplier_licence_state: 'valid' | 'expired' | 'unknown';
  invoice_number: string; department_name: string; store_name: string;
  vehicle_no: string; vehicle_type: string; vehicle_type_label: string;
  chk_vehicle_clean: string; chk_handler_hygiene: string; chk_documents: string;
  vehicle_temp_c: number | null; display_vehicle_temp: string;
  status: string; status_label: string; is_editable: boolean; outcome: string;
  line_count: number; fail_count: number; rejected_count: number;
  remarks: string; checked_by: string; checked_name: string;
  verified_by: string; verify_note: string;
  voided_by: string; void_reason: string; photo_count: number;
}

interface Line {
  id: string; check_id: string; material_id: string; material_name: string;
  material_name_now: string; material_missing_now: boolean;
  brand: string; lot_no: string;
  qty_received: number | null; qty_accepted: number | null; qty_rejected: number | null;
  uom: string; pack_size: number | null; recipe_uom: string; qty_accepted_recipe: number | null;
  mfg_date: string; expiry_date: string; expiry_state: string; expiry_state_label: string;
  temp_c: number | null; display_temp: string;
  temp_min_used: number | null; temp_max_used: number | null;
  checkpoints: { key: string; column: string; label: string; hint: string; cold_only: boolean; value: string; value_label: string; is_fail: boolean; answered: boolean }[];
  decision: string; decision_label: string; decision_implied: string;
  reject_reason: string; reject_reason_label: string; reject_note: string;
  is_fail: 0 | 1; ca_number: string; ca_status: string; note: string; photo_count: number;
}

const inputCls =
  'w-full bg-white border border-[#D4B896] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]';
const labelCls = 'block text-xs font-semibold text-[#6B5744] mb-1';

export default function FssaiReceivingPage() {
  const [checks, setChecks] = useState<Check[]>([]);
  const [counts, setCounts] = useState({ total: 0, drafts: 0, submitted: 0, verified: 0, voided: 0, failed: 0 });
  const [openGrns, setOpenGrns] = useState<any[]>([]);
  const [isMgmt, setIsMgmt] = useState(false);
  const [me, setMe] = useState('');
  const [earliest, setEarliest] = useState('');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [onlyFails, setOnlyFails] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  /* the open record */
  const [detail, setDetail] = useState<{ check: Check; lines: Line[]; preview: any; photos: any[]; vocab: any; no_stock_movement: string } | null>(null);
  const [lineForm, setLineForm] = useState<any | null>(null);
  const [starting, setStarting] = useState<any | null>(null);
  const [voiding, setVoiding] = useState<Check | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [viewing, setViewing] = useState<string | null>(null);
  const [gaps, setGaps] = useState<any[] | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 9000);
    return () => clearTimeout(t);
  }, [toast]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const p = new URLSearchParams();
      if (from) p.set('from', from);
      if (to) p.set('to', to);
      if (onlyFails) p.set('fails', '1');
      if (q.trim()) p.set('q', q.trim());
      const [j, g] = await Promise.all([
        apiJson<any>(`/api/fssai/receiving?${p}`),
        apiJson<any>('/api/fssai/receiving?open_grns=1'),
      ]);
      setChecks(j.checks || []);
      setCounts(j.counts || counts);
      setIsMgmt(!!j.is_management);
      setMe(j.me || '');
      setEarliest(j.earliest_backdate || '');
      setOpenGrns(g.grns || []);
      setSignedOut(false);
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Could not load the delivery inspections';
      if (/sign in|401/i.test(m)) setSignedOut(true);
      else setErr(m);
      setChecks([]);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, onlyFails, q]);

  useEffect(() => { void load(); }, [load]);

  async function openOne(id: string) {
    try {
      const j = await apiJson<any>(`/api/fssai/receiving?id=${encodeURIComponent(id)}`);
      setDetail(j);
      setGaps(null);
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'Could not open that inspection');
    }
  }

  async function post(body: any) {
    setBusy(true);
    try {
      const j = await apiJson<any>('/api/fssai/receiving', { method: 'POST', body });
      setToast(j.note_to_staff || j.note || j.record_unchanged || j.warning || 'Saved.');
      return j;
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'That did not save.');
      return null;
    } finally {
      setBusy(false);
    }
  }

  /** Start from a goods receipt: pull its own lines so nothing is typed twice. */
  async function startFromGrn(grnId: string) {
    setBusy(true);
    try {
      const pre = await apiJson<any>(`/api/fssai/receiving?prefill=1&grn_id=${encodeURIComponent(grnId)}`);
      if (pre.existing) {
        /* Already inspected: offered as a link rather than a dead end, and never as
         * a second record — two inspections of one delivery is how a file stops
         * making sense. */
        setToast(`Delivery ${pre.grn.grn_number} has already been inspected (${pre.existing.check_no || 'draft'}). Opening that record.`);
        await openOne(pre.existing.id);
        return;
      }
      setStarting({
        grn_id: grnId,
        grn: pre.grn,
        lines: pre.lines || [],
        business_date: fssaiToday(),
        shift: '',
        vendor_id: pre.grn.vendor_id,
        vendor_name: pre.grn.vendor_name,
        invoice_number: pre.grn.invoice_number,
        received_at: pre.grn.time || '',
        note: pre.note,
      });
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'Could not read that delivery');
    } finally {
      setBusy(false);
    }
  }

  if (signedOut) {
    return (
      <Shell>
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 text-center">
          <Lock className="w-6 h-6 mx-auto mb-2 text-[#8B7355]" />
          <p className="text-sm text-[#3D2614]">Please sign in to inspect deliveries.</p>
        </div>
      </Shell>
    );
  }

  /* ══ THE OPEN RECORD ═══════════════════════════════════════════════════════ */
  if (detail) {
    const c = detail.check;
    const canEdit = c.is_editable && (String(c.checked_by).toLowerCase() === me.toLowerCase() || isMgmt);
    const previewFails = detail.preview?.fail_count ?? 0;
    const incomplete = detail.preview?.incomplete || [];
    return (
      <Shell>
        <button onClick={() => { setDetail(null); void load(); }} className="inline-flex flex-nowrap items-center gap-1.5 text-sm text-[#6B5744] hover:text-[#af4408]">
          <ArrowLeft size={15} /> All inspections
        </button>

        <div className={`rounded-xl border p-3 sm:p-4 ${
          c.status === 'void' ? 'bg-gray-50 border-gray-200'
            : c.outcome === 'fail' ? 'bg-red-50 border-red-200'
              : c.status === 'draft' ? 'bg-amber-50 border-amber-200' : 'bg-green-50 border-green-200'
        }`}>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-bold text-[#2D1B0E]">{c.check_no || 'Draft inspection'}</h2>
            <span className="px-2 py-0.5 rounded text-[11px] bg-white border border-[#E8D5C4] text-[#6B5744]">{c.status_label}</span>
            {c.outcome === 'fail' && <span className="px-2 py-0.5 rounded text-[11px] bg-red-100 border border-red-200 text-red-700">Failed</span>}
            {c.outcome === 'pass' && <span className="px-2 py-0.5 rounded text-[11px] bg-green-100 border border-green-200 text-green-700">All in order</span>}
          </div>
          <p className="text-sm text-[#3D2614] mt-1">
            {c.vendor_name} · {c.business_date}{c.received_at ? ` at ${c.received_at}` : ''}
            {c.grn_number ? ` · goods receipt ${c.grn_number}` : ''}
            {c.invoice_number ? ` · bill ${c.invoice_number}` : ''}
          </p>
          <p className="text-xs text-[#6B5744] mt-1">
            Inspected by {c.checked_name || c.checked_by}
            {c.verified_by ? ` · checked off by ${c.verified_by}` : ''}
            {c.status !== 'draft' ? ` · ${c.line_count} line${c.line_count === 1 ? '' : 's'}, ${c.fail_count} failed, ${c.rejected_count} sent back` : ''}
          </p>
          {c.status === 'void' && <p className="text-xs text-gray-700 mt-1">Voided by {c.voided_by}: {c.void_reason}</p>}
        </div>

        {c.grn_voided_since && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-[13px] text-amber-900">
            The goods receipt this inspection was taken against has since been voided. The inspection
            stays in the file as it was written — it records what was found at the door, which happened
            whatever became of the paperwork afterwards.
          </div>
        )}

        {c.supplier_licence_state === 'expired' && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-[13px] text-red-800">
            <strong>The supplier&apos;s licence expired on {c.supplier_licence_expiry}.</strong> Accepting goods
            from a supplier whose licence has lapsed is the finding an inspector writes up first — make
            sure the remarks say what was done about it.
          </div>
        )}

        <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl p-3">
          <div className="flex flex-nowrap items-start gap-2.5">
            <Info size={16} className="text-[#af4408] shrink-0 mt-0.5" />
            <p className="text-[13px] text-[#3D2614] leading-relaxed">{detail.no_stock_movement}</p>
          </div>
        </div>

        {/* ── the van and the driver ───────────────────────────────────────── */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 space-y-3">
          <div className="flex flex-nowrap items-center gap-2">
            <Truck size={16} className="text-[#af4408] shrink-0" />
            <h3 className="text-sm font-bold text-[#2D1B0E]">The van and the person who brought it</h3>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <div>
              <label className={labelCls}>Vehicle number</label>
              <input disabled={!canEdit} className={inputCls} defaultValue={c.vehicle_no}
                onBlur={(e) => canEdit && e.target.value !== c.vehicle_no && void post({ action: 'save_header', id: c.id, vehicle_no: e.target.value }).then(() => openOne(c.id))} />
            </div>
            <div>
              <label className={labelCls}>Kind of vehicle</label>
              <select disabled={!canEdit} className={inputCls} value={c.vehicle_type}
                onChange={(e) => canEdit && void post({ action: 'save_header', id: c.id, vehicle_type: e.target.value }).then(() => openOne(c.id))}>
                {(detail.vocab?.vehicle_types || []).map((t: any) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Temperature inside (°C)</label>
              <input disabled={!canEdit} type="number" step="0.1" inputMode="decimal" className={inputCls}
                defaultValue={c.vehicle_temp_c ?? ''}
                onBlur={(e) => canEdit && void post({ action: 'save_header', id: c.id, vehicle_temp_c: e.target.value }).then(() => openOne(c.id))} />
            </div>
          </div>
          <div className="space-y-2">
            {(detail.vocab?.vehicle_checkpoints || []).map((cp: any) => (
              <TickRow
                key={cp.key}
                label={cp.label}
                hint={cp.hint}
                value={String((c as any)[cp.column] || '')}
                disabled={!canEdit}
                onPick={(v) => void post({ action: 'save_header', id: c.id, [cp.column]: v }).then(() => openOne(c.id))}
              />
            ))}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <label className={labelCls}>Supplier&apos;s own FSSAI number</label>
              <input disabled={!canEdit} className={inputCls} defaultValue={c.supplier_licence_no}
                onBlur={(e) => canEdit && e.target.value !== c.supplier_licence_no && void post({ action: 'save_header', id: c.id, supplier_licence_no: e.target.value }).then(() => openOne(c.id))} />
            </div>
            <div>
              <label className={labelCls}>…and when it expires</label>
              <input disabled={!canEdit} type="date" className={inputCls} defaultValue={c.supplier_licence_expiry}
                onBlur={(e) => canEdit && e.target.value !== c.supplier_licence_expiry && void post({ action: 'save_header', id: c.id, supplier_licence_expiry: e.target.value }).then(() => openOne(c.id))} />
            </div>
          </div>
          <div>
            <label className={labelCls}>Remarks on the whole delivery</label>
            <textarea disabled={!canEdit} rows={2} className={inputCls} defaultValue={c.remarks}
              onBlur={(e) => canEdit && e.target.value !== c.remarks && void post({ action: 'save_header', id: c.id, remarks: e.target.value }).then(() => openOne(c.id))} />
          </div>
        </div>

        {/* ── the lines ────────────────────────────────────────────────────── */}
        <div className="flex flex-nowrap items-center gap-2">
          <h3 className="text-sm font-bold text-[#2D1B0E]">What arrived</h3>
          {canEdit && (
            <button onClick={() => setLineForm({ check_id: c.id })} className="ml-auto inline-flex flex-nowrap items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[#af4408] bg-white text-[#af4408] text-xs font-semibold">
              <Plus size={13} /> Add a line
            </button>
          )}
        </div>

        {detail.lines.length === 0 ? (
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 text-center text-sm text-[#6B5744]">
            Nothing on this inspection yet.
          </div>
        ) : (
          <div className="space-y-2">
            {detail.lines.map((l) => {
              const wouldFail = detail.preview?.would_fail?.find((w: any) => w.line_id === l.id);
              const failed = c.status === 'draft' ? !!wouldFail?.fail : l.is_fail === 1;
              return (
                <div key={l.id} className={`bg-white border rounded-xl p-3 ${failed ? 'border-red-200' : 'border-[#E8D5C4]'}`}>
                  <div className="flex flex-nowrap items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <p className="text-sm font-semibold text-[#2D1B0E]">{l.material_name}</p>
                        {l.brand && <span className="text-xs text-[#8B7355]">{l.brand}</span>}
                        {l.lot_no && <span className="px-1.5 py-0.5 rounded text-[11px] bg-gray-50 border border-gray-200 text-gray-600 font-mono">lot {l.lot_no}</span>}
                        {failed && <span className="px-1.5 py-0.5 rounded text-[11px] bg-red-100 border border-red-200 text-red-700">Failed</span>}
                        {l.decision && <span className="px-1.5 py-0.5 rounded text-[11px] bg-[#FFF1E3] border border-[#E8D5C4] text-[#6B5744]">{l.decision_label}</span>}
                        {l.expiry_date && l.expiry_state !== 'ok' && l.expiry_state !== 'none' && (
                          <span className="px-1.5 py-0.5 rounded text-[11px] bg-amber-100 border border-amber-200 text-amber-800">{l.expiry_state_label}</span>
                        )}
                        {l.ca_number && <span className="px-1.5 py-0.5 rounded text-[11px] bg-[#FFF1E3] border border-[#E8D5C4] text-[#af4408] font-mono">{l.ca_number}</span>}
                      </div>
                      {/* PURCHASE UNIT LEADS, recipe unit second (the owner's rule). */}
                      <p className="text-xs text-[#6B5744] mt-1">
                        {l.qty_received ?? '—'} {l.uom} arrived
                        {l.qty_accepted !== null && ` · ${l.qty_accepted} accepted`}
                        {l.qty_rejected !== null && l.qty_rejected > 0 && <span className="text-red-700"> · {l.qty_rejected} sent back</span>}
                        {l.qty_accepted_recipe !== null && l.recipe_uom && (
                          <span className="text-[#8B7355]"> ({l.qty_accepted_recipe} {l.recipe_uom})</span>
                        )}
                      </p>
                      <p className="text-xs text-[#8B7355] mt-0.5">
                        {[
                          l.temp_c !== null ? `${l.display_temp} °C${l.temp_min_used !== null || l.temp_max_used !== null ? ` (rule ${l.temp_min_used ?? ''}${l.temp_min_used !== null && l.temp_max_used !== null ? '–' : ''}${l.temp_max_used ?? ''} °C)` : ' — no range applied'}` : '',
                          l.expiry_date ? `expires ${l.expiry_date}` : '',
                          l.reject_reason_label,
                          l.photo_count ? `${l.photo_count} photo${l.photo_count === 1 ? '' : 's'}` : '',
                        ].filter(Boolean).join(' · ') || '—'}
                      </p>
                      {/* The four-state tick-boxes, read-only once filed. */}
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {l.checkpoints.map((cp) => (
                          <span key={cp.key} className={`px-1.5 py-0.5 rounded text-[10px] border ${
                            cp.is_fail ? 'bg-red-50 border-red-200 text-red-700'
                              : cp.value === 'ok' ? 'bg-green-50 border-green-200 text-green-700'
                                : cp.value === 'na' ? 'bg-slate-50 border-slate-200 text-slate-600'
                                  : 'bg-gray-50 border-gray-200 text-gray-500'
                          }`} title={`${cp.label}: ${cp.value_label}`}>
                            {cp.label}
                          </span>
                        ))}
                      </div>
                      {wouldFail?.why?.length > 0 && c.status === 'draft' && (
                        <p className="text-xs text-red-700 mt-1">{wouldFail.why.join(' · ')}</p>
                      )}
                      {l.material_missing_now && (
                        <p className="text-[11px] text-amber-800 mt-1">
                          This item is no longer in the item list. The inspection keeps its name, so the
                          record still says what was checked.
                        </p>
                      )}
                    </div>
                    {canEdit && (
                      <div className="flex flex-col gap-1.5 shrink-0">
                        <button onClick={() => setLineForm({ ...l, check_id: c.id, line_id: l.id })} className="px-2.5 py-1.5 rounded-lg border border-[#E8D5C4] bg-white text-xs font-semibold text-[#6B5744] hover:border-[#af4408]">Check it</button>
                        <button onClick={async () => { await post({ action: 'remove_line', check_id: c.id, line_id: l.id }); await openOne(c.id); }} className="px-2.5 py-1.5 rounded-lg border border-[#E8D5C4] bg-white text-xs text-[#8B7355] hover:border-red-300 inline-flex flex-nowrap items-center justify-center gap-1">
                          <Trash2 size={12} /> Remove
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── filing it ────────────────────────────────────────────────────── */}
        {c.status === 'draft' && (
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 space-y-2">
            <p className="text-[13px] text-[#3D2614]">
              <strong>Filing this freezes it.</strong> After that no quantity, tick-box or reason on it can
              be changed — if something is wrong, a manager voids it with a reason and a fresh one is
              taken, and the file shows both.
              {previewFails > 0 && ` As it stands, ${previewFails} line${previewFails === 1 ? '' : 's'} will be recorded as failed, and a follow-up job will be raised for each.`}
            </p>
            {incomplete.length > 0 && (
              <p className="text-[13px] text-amber-800">
                {incomplete.length} line{incomplete.length === 1 ? ' still has' : 's still have'} checks
                nobody has answered. An unanswered check is not a pass — answer it, or mark it
                &ldquo;not applicable&rdquo; where it genuinely does not apply.
              </p>
            )}
            {gaps && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 space-y-2">
                <p className="text-[13px] text-amber-900">
                  These checks are unanswered. You can go back and answer them, or file the inspection
                  anyway — it will be recorded that it was filed with them blank.
                </p>
                <ul className="text-xs text-amber-900 list-disc pl-5">
                  {gaps.map((g: any, i: number) => <li key={i}>{g.name}: {g.missing.join(', ')}</li>)}
                </ul>
                <button
                  disabled={busy}
                  onClick={async () => { const j = await post({ action: 'submit', id: c.id, allow_partial: true }); if (j) { setGaps(null); await openOne(c.id); } }}
                  className="px-3 py-2 rounded-lg border border-amber-400 bg-white text-amber-900 text-xs font-semibold"
                >
                  File it anyway, with those blank
                </button>
              </div>
            )}
            <button
              disabled={busy || detail.lines.length === 0}
              onClick={async () => {
                setBusy(true);
                try {
                  const j = await apiJson<any>('/api/fssai/receiving', { method: 'POST', body: { action: 'submit', id: c.id } });
                  setToast(j.note_to_staff || 'Filed.');
                  setGaps(null);
                  await openOne(c.id);
                } catch (e) {
                  const m = e instanceof Error ? e.message : 'Could not file it';
                  setToast(m);
                  /* The server names the gaps; re-ask it so the list on screen is the
                   * server's and not a guess. */
                  if (/not been answered/i.test(m)) {
                    try {
                      const re = await apiJson<any>(`/api/fssai/receiving?id=${encodeURIComponent(c.id)}`);
                      setGaps(re.preview?.incomplete || []);
                    } catch { /* the toast already said it */ }
                  }
                } finally { setBusy(false); }
              }}
              className="w-full py-3 rounded-lg bg-[#af4408] text-white text-sm font-semibold disabled:opacity-50 inline-flex flex-nowrap items-center justify-center gap-2"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />} File this inspection
            </button>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {c.status === 'submitted' && isMgmt && String(c.checked_by).toLowerCase() !== me.toLowerCase() && (
            <button disabled={busy} onClick={async () => { await post({ action: 'verify', id: c.id }); await openOne(c.id); }}
              className="flex-1 min-w-[150px] py-2.5 rounded-lg bg-green-700 text-white text-sm font-semibold disabled:opacity-50 inline-flex flex-nowrap items-center justify-center gap-2">
              <BadgeCheck size={16} /> Check it off
            </button>
          )}
          {c.status !== 'void' && isMgmt && (
            <button onClick={() => { setVoiding(c); setVoidReason(''); }}
              className="flex-1 min-w-[150px] py-2.5 rounded-lg border border-red-300 bg-white text-red-700 text-sm font-semibold inline-flex flex-nowrap items-center justify-center gap-2">
              <Ban size={16} /> Void it
            </button>
          )}
        </div>
        {c.status === 'submitted' && isMgmt && String(c.checked_by).toLowerCase() === me.toLowerCase() && (
          <p className="text-xs text-[#8B7355]">
            You inspected this delivery, so somebody else has to check it off.
          </p>
        )}

        {/* photographs on the inspection itself */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 space-y-2">
          <div className="flex flex-nowrap items-center gap-2">
            <Camera size={16} className="text-[#af4408] shrink-0" />
            <h3 className="text-sm font-bold text-[#2D1B0E]">Photographs of the delivery</h3>
          </div>
          {detail.photos.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {detail.photos.map((p: any) => (
                <button key={p.id} onClick={async () => {
                  try { const j = await apiJson<any>(`/api/fssai/receiving?photo_id=${encodeURIComponent(p.id)}`); setViewing(j.data_uri || ''); }
                  catch (e) { setToast(e instanceof Error ? e.message : 'Could not open that photograph'); }
                }} className="w-20 h-20 rounded-lg border border-[#E8D5C4] bg-[#FFF1E3] flex items-center justify-center hover:border-[#af4408]">
                  <Camera size={20} className="text-[#af4408]" />
                </button>
              ))}
            </div>
          )}
          {c.status !== 'void' && (String(c.checked_by).toLowerCase() === me.toLowerCase() || isMgmt) && (
            <>
              <ImageUpload
                value={[]}
                onAdd={async (uri: string) => { await post({ action: 'attach', check_id: c.id, data_uri: uri, kind: 'photo' }); await openOne(c.id); }}
                label="Add a photo"
                thumbSize={64}
              />
              <p className="text-[11px] text-[#8B7355]">
                Take a photograph of anything you reject. It is the proof when the supplier argues about
                it later. Attach it to the LINE it is about where you can — four per line, twenty-four on
                the whole inspection.
              </p>
            </>
          )}
        </div>

        {lineForm && (
          <LineModal
            line={lineForm}
            vocab={detail.vocab}
            busy={busy}
            onClose={() => setLineForm(null)}
            onSave={async (body) => {
              const j = await post({ ...body, action: 'save_line', check_id: c.id, line_id: lineForm.line_id });
              if (j) { setLineForm(null); await openOne(c.id); }
            }}
            onPhoto={lineForm.line_id ? async (uri) => { await post({ action: 'attach', check_id: c.id, line_id: lineForm.line_id, data_uri: uri, kind: 'photo' }); await openOne(c.id); } : undefined}
          />
        )}

        {voiding && <VoidModal check={voiding} busy={busy} reason={voidReason} setReason={setVoidReason}
          onClose={() => setVoiding(null)}
          onVoid={async () => { const j = await post({ action: 'void', id: voiding.id, reason: voidReason.trim() }); if (j) { setVoiding(null); await openOne(voiding.id); } }} />}

        {viewing && (
          <div className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-4" onClick={() => setViewing(null)}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={viewing} alt="Photograph on the record" className="max-h-[90vh] max-w-full rounded-lg" />
          </div>
        )}
        {toast && <Toast>{toast}</Toast>}
      </Shell>
    );
  }

  /* ══ THE LIST ══════════════════════════════════════════════════════════════ */
  return (
    <Shell>
      <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl p-3 sm:p-4">
        <div className="flex flex-nowrap items-start gap-2.5">
          <Info size={16} className="text-[#af4408] shrink-0 mt-0.5" />
          <p className="text-[13px] text-[#3D2614] leading-relaxed">
            <strong>This does not replace the goods receipt — it reads it.</strong> Pick a delivery below
            and its lines come across ready to inspect, so nothing is typed twice. Accepting or rejecting
            a line records what you found; it changes no quantity on the delivery or in stock.
          </p>
        </div>
      </div>

      {/* ── deliveries with no inspection: the real work queue ─────────────── */}
      {openGrns.length > 0 && (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
          <div className="flex flex-nowrap items-center gap-2 mb-2">
            <PackageCheck size={16} className="text-[#af4408] shrink-0" />
            <h2 className="text-sm font-bold text-[#2D1B0E]">
              {openGrns.length} deliver{openGrns.length === 1 ? 'y has' : 'ies have'} no inspection yet
            </h2>
          </div>
          <div className="space-y-1.5">
            {openGrns.slice(0, 12).map((g) => (
              <button key={g.id} disabled={busy} onClick={() => void startFromGrn(g.id)}
                className="w-full text-left rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-2.5 hover:border-[#af4408] disabled:opacity-50">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[13px] font-semibold text-[#2D1B0E]">{g.grn_number || '(no number)'}</span>
                  <span className="text-[13px] text-[#6B5744]">{g.vendor_name}</span>
                  <span className="ml-auto text-[11px] text-[#8B7355]">{g.date}{g.time ? ` ${g.time}` : ''} · {g.line_count} line{g.line_count === 1 ? '' : 's'}</span>
                </div>
              </button>
            ))}
            {openGrns.length > 12 && <p className="text-xs text-[#8B7355]">…and {openGrns.length - 12} more in the last fortnight.</p>}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {([['Inspections', counts.total, 'text-[#2D1B0E]'],
          ['Failed', counts.failed, 'text-red-700'],
          ['Drafts', counts.drafts, 'text-amber-700'],
          ['Checked off', counts.verified, 'text-green-700']] as const).map(([label, n, cls]) => (
            <div key={label} className="bg-white border border-[#E8D5C4] rounded-xl p-3">
              <p className="text-[11px] text-[#8B7355]">{label}</p>
              <p className={`text-xl font-bold ${cls}`}>{n}</p>
            </div>
          ))}
      </div>

      <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 space-y-2">
        <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8B7355]" />
            <input className={`${inputCls} pl-9`} placeholder="Number, supplier, bill, vehicle…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <input type="date" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} />
          <input type="date" className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex flex-nowrap items-center gap-2 text-xs text-[#6B5744]">
            <input type="checkbox" checked={onlyFails} onChange={(e) => setOnlyFails(e.target.checked)} /> Failed only
          </label>
          <button onClick={() => void load()} title="Reload" className="ml-auto w-11 h-11 rounded-lg border border-[#E8D5C4] bg-white hover:border-[#af4408] flex items-center justify-center">
            <RefreshCw size={16} className={loading ? 'animate-spin text-[#af4408]' : 'text-[#6B5744]'} />
          </button>
        </div>
      </div>

      {err && <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-800">{err}</div>}

      {loading ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center">
          <Loader2 className="w-6 h-6 mx-auto animate-spin text-[#af4408]" />
        </div>
      ) : checks.length === 0 ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center">
          <FileText className="w-6 h-6 mx-auto mb-2 text-[#8B7355]" />
          <p className="text-sm text-[#3D2614]">No inspection matches that.</p>
          {openGrns.length > 0 && <p className="text-xs text-[#6B5744] mt-1">Start one from a delivery above.</p>}
        </div>
      ) : (
        <div className="space-y-2">
          {checks.map((c) => (
            <button key={c.id} onClick={() => void openOne(c.id)}
              className={`w-full text-left bg-white border rounded-xl p-3 hover:border-[#af4408] ${
                c.status === 'void' ? 'border-gray-200 opacity-60' : c.outcome === 'fail' ? 'border-red-200' : 'border-[#E8D5C4]'
              }`}>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-semibold text-[#2D1B0E]">{c.check_no || 'Draft'}</span>
                <span className="text-sm text-[#3D2614]">{c.vendor_name}</span>
                <span className="px-1.5 py-0.5 rounded text-[11px] bg-[#FFF1E3] border border-[#E8D5C4] text-[#6B5744]">{c.status_label}</span>
                {c.outcome === 'fail' && <span className="px-1.5 py-0.5 rounded text-[11px] bg-red-100 border border-red-200 text-red-700">{c.fail_count} failed</span>}
                {c.supplier_licence_state === 'expired' && <span className="px-1.5 py-0.5 rounded text-[11px] bg-red-100 border border-red-200 text-red-700">Licence lapsed</span>}
                <span className="ml-auto text-[11px] text-[#8B7355]">{c.business_date}{c.received_at ? ` ${c.received_at}` : ''}</span>
              </div>
              <p className="text-xs text-[#8B7355] mt-1">
                {[c.grn_number ? `GRN ${c.grn_number}` : '', c.invoice_number ? `bill ${c.invoice_number}` : '',
                  `${c.line_count} line${c.line_count === 1 ? '' : 's'}`,
                  c.rejected_count ? `${c.rejected_count} sent back` : '',
                  c.checked_name || c.checked_by,
                  c.photo_count ? `${c.photo_count} photo${c.photo_count === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')}
              </p>
            </button>
          ))}
        </div>
      )}

      {/* ══ START A NEW INSPECTION ══════════════════════════════════════════ */}
      {starting && (
        <Modal title={`Inspect ${starting.grn?.grn_number || 'this delivery'}`} onClose={() => setStarting(null)}>
          <div className="space-y-3">
            <p className="text-[13px] text-[#3D2614]">{starting.note}</p>
            <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-2.5 text-[13px]">
              <p><strong>{starting.vendor_name}</strong></p>
              <p className="text-xs text-[#6B5744] mt-0.5">
                {starting.lines.length} line{starting.lines.length === 1 ? '' : 's'}
                {starting.invoice_number ? ` · bill ${starting.invoice_number}` : ''}
              </p>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className={labelCls}>Date</label>
                <input type="date" className={inputCls} min={earliest || undefined} max={fssaiToday()}
                  value={starting.business_date} onChange={(e) => setStarting({ ...starting, business_date: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>Arrived at</label>
                <input type="time" className={inputCls} value={starting.received_at || ''} onChange={(e) => setStarting({ ...starting, received_at: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>Shift</label>
                <select className={inputCls} value={starting.shift} onChange={(e) => setStarting({ ...starting, shift: e.target.value })}>
                  {FSSAI_SHIFTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
              </div>
            </div>
            {starting.business_date < fssaiToday() && (
              <div>
                <label className={labelCls}>Why is this for an earlier day? *</label>
                <input className={inputCls} value={starting.backdate_reason || ''} onChange={(e) => setStarting({ ...starting, backdate_reason: e.target.value })} />
              </div>
            )}
            <button
              disabled={busy}
              onClick={async () => {
                const j = await post({ action: 'create', ...starting, grn: undefined });
                if (j) { setStarting(null); await openOne(j.check.id); }
              }}
              className="w-full py-3 rounded-lg bg-[#af4408] text-white text-sm font-semibold disabled:opacity-50 inline-flex flex-nowrap items-center justify-center gap-2"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />} Start the inspection
            </button>
            <p className="text-[11px] text-[#8B7355]">
              The inspection number is given when you file it, not now — so one abandoned at the door does
              not leave a gap in the series.
            </p>
          </div>
        </Modal>
      )}

      {toast && <Toast>{toast}</Toast>}
    </Shell>
  );
}

/* ------------------------------------------------------------------ *
 * The four-state tick-box, which is the whole point of this screen
 * ------------------------------------------------------------------ */
function TickRow({ label, hint, value, disabled, onPick }: {
  label: string; hint?: string; value: string; disabled?: boolean; onPick: (v: string) => void;
}) {
  return (
    <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-2">
      <p className="text-[13px] font-semibold text-[#2D1B0E]">{label}</p>
      {hint && <p className="text-[11px] text-[#8B7355] mb-1.5">{hint}</p>}
      <div className="flex flex-wrap gap-1.5">
        {FSSAI_CHECK_RESULTS.map((r) => (
          <button
            key={r.key || 'blank'}
            disabled={disabled}
            onClick={() => onPick(r.key)}
            className={`px-2.5 py-1.5 rounded-lg border text-xs font-semibold disabled:opacity-50 ${
              value === r.key
                ? r.key === 'not_ok' ? 'bg-red-600 border-red-600 text-white'
                  : r.key === 'ok' ? 'bg-green-700 border-green-700 text-white'
                    : r.key === 'na' ? 'bg-slate-600 border-slate-600 text-white'
                      : 'bg-gray-500 border-gray-500 text-white'
                : 'bg-white border-[#E8D5C4] text-[#6B5744] hover:border-[#af4408]'
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * One line, checked
 * ------------------------------------------------------------------ */
function LineModal({ line, vocab, busy, onClose, onSave, onPhoto }: {
  line: any; vocab: any; busy: boolean;
  onClose: () => void;
  onSave: (body: any) => void | Promise<void>;
  onPhoto?: (uri: string) => void | Promise<void>;
}) {
  const [f, setF] = useState<any>(() => {
    const base: any = {
      material_name: line.material_name || '', brand: line.brand || '', lot_no: line.lot_no || '',
      qty_received: line.qty_received ?? '', qty_accepted: line.qty_accepted ?? '', qty_rejected: line.qty_rejected ?? '',
      uom: line.uom || '', mfg_date: line.mfg_date || '', expiry_date: line.expiry_date || '',
      temp_c: line.temp_c ?? '', decision: line.decision || '',
      reject_reason: line.reject_reason || '', reject_note: line.reject_note || '', note: line.note || '',
    };
    for (const cp of FSSAI_RECEIVING_CHECKPOINTS) {
      base[cp.column] = (line.checkpoints?.find((c: any) => c.column === cp.column)?.value) ?? line[cp.column] ?? '';
    }
    return base;
  });

  /* The decision the quantities imply, offered and never forced: a line may be
   * rejected outright on quality with nothing sent back yet. */
  const implied = useMemo(() => {
    const r = Number(f.qty_received); const a = Number(f.qty_accepted);
    if (!Number.isFinite(r) || r <= 0 || !Number.isFinite(a)) return '';
    if (a <= 0) return 'rejected';
    if (a >= r) return 'accepted';
    return 'partially_accepted';
  }, [f.qty_received, f.qty_accepted]);

  const sendingBack = useMemo(
    () => Number(f.qty_rejected) > 0 || f.decision === 'rejected' || f.decision === 'partially_accepted',
    [f.qty_rejected, f.decision],
  );

  return (
    <Modal title={line.line_id ? `Check ${line.material_name}` : 'Add a line'} onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className={labelCls}>What it is *</label>
          <input className={inputCls} value={f.material_name} onChange={(e) => setF({ ...f, material_name: e.target.value })} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelCls}>Brand</label>
            <input className={inputCls} value={f.brand} onChange={(e) => setF({ ...f, brand: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>Batch / lot number</label>
            <input className={inputCls} value={f.lot_no} onChange={(e) => setF({ ...f, lot_no: e.target.value })} />
            <p className="text-[11px] text-[#8B7355] mt-1">Lot traceability starts here.</p>
          </div>
        </div>

        {/* PURCHASE UNIT LEADS — the owner's rule across 293 sites. */}
        <div className="grid grid-cols-4 gap-2">
          <div>
            <label className={labelCls}>Arrived</label>
            <input type="number" step="0.001" inputMode="decimal" className={inputCls} value={f.qty_received} onChange={(e) => setF({ ...f, qty_received: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>Accepted</label>
            <input type="number" step="0.001" inputMode="decimal" className={inputCls} value={f.qty_accepted} onChange={(e) => setF({ ...f, qty_accepted: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>Sent back</label>
            <input type="number" step="0.001" inputMode="decimal" className={inputCls} value={f.qty_rejected} onChange={(e) => setF({ ...f, qty_rejected: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>Unit</label>
            <input className={inputCls} value={f.uom} onChange={(e) => setF({ ...f, uom: e.target.value })} placeholder="kg" />
          </div>
        </div>
        <p className="text-[11px] text-[#8B7355]">
          Quantities are in the unit you buy in. Leave &ldquo;sent back&rdquo; empty and it is worked out from the
          other two — but a short delivery and a rejection are different things, so fill it in yourself
          when they are.
        </p>

        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className={labelCls}>Made on</label>
            <input type="date" className={inputCls} value={f.mfg_date} onChange={(e) => setF({ ...f, mfg_date: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>Expires</label>
            <input type="date" className={inputCls} value={f.expiry_date} onChange={(e) => setF({ ...f, expiry_date: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>Probed (°C)</label>
            <input type="number" step="0.1" inputMode="decimal" className={inputCls} value={f.temp_c} onChange={(e) => setF({ ...f, temp_c: e.target.value })} />
          </div>
        </div>
        {line.temp_min_used !== null && line.temp_min_used !== undefined && (
          <p className="text-[11px] text-[#8B7355]">
            This line was judged against {line.temp_min_used ?? ''}
            {line.temp_min_used !== null && line.temp_max_used !== null ? '–' : ''}{line.temp_max_used ?? ''} °C, and
            keeps that range whatever the rules say later.
          </p>
        )}

        <div className="space-y-2">
          {FSSAI_RECEIVING_CHECKPOINTS.map((cp) => (
            <TickRow
              key={cp.key}
              label={cp.label + (cp.cold_only ? ' (chilled and frozen only)' : '')}
              hint={cp.hint}
              value={f[cp.column] || ''}
              onPick={(v) => setF({ ...f, [cp.column]: v })}
            />
          ))}
        </div>

        <div>
          <label className={labelCls}>What was decided</label>
          <select className={inputCls} value={f.decision} onChange={(e) => setF({ ...f, decision: e.target.value })}>
            {FSSAI_RECEIVING_DECISIONS.map((d) => <option key={d.key || 'blank'} value={d.key}>{d.label}</option>)}
          </select>
          {implied && implied !== f.decision && (
            <p className="text-[11px] text-[#8B7355] mt-1">
              The quantities say &ldquo;{FSSAI_RECEIVING_DECISIONS.find((d) => d.key === implied)?.label}&rdquo;. Leave this
              blank and that is what will be recorded.
            </p>
          )}
        </div>

        {sendingBack && (
          <>
            <div>
              <label className={labelCls}>Why it was sent back *</label>
              <select className={inputCls} value={f.reject_reason} onChange={(e) => setF({ ...f, reject_reason: e.target.value })}>
                <option value="">Pick a reason</option>
                {FSSAI_REJECT_REASONS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
              </select>
              <p className="text-[11px] text-[#8B7355] mt-1">
                A coded reason, so a report can one day say what you reject this supplier for. Free text
                cannot be grouped.
              </p>
            </div>
            <div>
              <label className={labelCls}>
                In your own words{f.reject_reason === 'other' ? ' *' : ''}
              </label>
              <textarea rows={2} className={inputCls} value={f.reject_note} onChange={(e) => setF({ ...f, reject_note: e.target.value })} />
            </div>
          </>
        )}

        <div>
          <label className={labelCls}>Note</label>
          <input className={inputCls} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </div>

        {onPhoto && (
          <div>
            <label className={labelCls}>A photograph of this line</label>
            <ImageUpload value={[]} onAdd={(u: string) => void onPhoto(u)} label="Add a photo" thumbSize={64} />
          </div>
        )}

        <button
          disabled={busy || !String(f.material_name || '').trim()}
          onClick={() => void onSave(f)}
          className="w-full py-3 rounded-lg bg-[#af4408] text-white text-sm font-semibold disabled:opacity-50 inline-flex flex-nowrap items-center justify-center gap-2"
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />} Save this line
        </button>
      </div>
    </Modal>
  );
}

function VoidModal({ check, busy, reason, setReason, onClose, onVoid }: {
  check: Check; busy: boolean; reason: string; setReason: (s: string) => void;
  onClose: () => void; onVoid: () => void | Promise<void>;
}) {
  return (
    <Modal title={`Void ${check.check_no || 'this draft'}`} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-[#3D2614]">
          Nothing is removed. The inspection and every line on it stay in the file, struck out, with your
          name and your reason on them — a void says it was <em>entered wrongly</em>, not that the goods
          were fine.
          {check.fail_count > 0 && ' Any follow-up jobs its failed lines raised stay open; cancel those separately if they should not have been raised.'}
        </p>
        <div>
          <label className={labelCls}>Why *</label>
          <textarea rows={3} className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Entered against the wrong delivery" />
        </div>
        <button disabled={busy || reason.trim().length < 4} onClick={() => void onVoid()}
          className="w-full py-3 rounded-lg bg-[#af4408] text-white text-sm font-semibold disabled:opacity-50">
          {busy ? 'Saving…' : 'Void it'}
        </button>
      </div>
    </Modal>
  );
}

function Toast({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[70] max-w-[92vw] sm:max-w-xl px-4 py-3 rounded-xl bg-[#2D1B0E] text-white text-sm shadow-xl">
      {children}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-4xl mx-auto px-3 sm:px-4 py-4 sm:py-6 space-y-3 sm:space-y-4">
        <a href="/fssai" className="inline-flex flex-nowrap items-center gap-1.5 text-sm text-[#6B5744] hover:text-[#af4408]">
          <ArrowLeft size={15} /> Food Safety
        </a>
        <div className="flex flex-nowrap items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#af4408] text-white flex items-center justify-center shrink-0">
            <PackageCheck size={20} />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-bold text-[#af4408] leading-tight">Receiving Quality Check</h1>
            <p className="text-xs sm:text-sm text-[#6B5744]">What arrived, and whether it was fit — line by line</p>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div
        className="bg-white rounded-t-3xl sm:rounded-xl border border-[#E8D5C4] w-full sm:max-w-xl shadow-xl flex flex-col overflow-hidden max-h-[92vh] sm:max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-[#E8D5C4] flex flex-nowrap items-center justify-between gap-2 shrink-0">
          <h2 className="text-sm font-bold text-[#2D1B0E] truncate">{title}</h2>
          <button onClick={onClose} className="w-9 h-9 rounded-lg hover:bg-[#FFF1E3] flex items-center justify-center shrink-0">
            <X size={18} className="text-[#6B5744]" />
          </button>
        </div>
        <div className="p-4 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
