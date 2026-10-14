'use client';

/**
 * Inspection Mode (/fssai/inspection-mode) — owner §16. Management only.
 *
 * ── THE RULE THAT SHAPED THIS SCREEN, FROM FSSAI-BUILD-STATE.md §7 Q11 ──────
 *     "RULE FOR P9: nothing on Inspection Mode may describe what the restaurant
 *      lacks."
 * Every other screen in this module opens by stating a gap. Those sentences are
 * true and they are written FOR THE OWNER — and this is the one screen that is
 * literally handed to a visiting officer, where the same words read over a
 * shoulder sound like an admission.
 *
 * So the screen has TWO STATES, and the split is the whole design:
 *
 *   1. BEFORE YOU HAND IT OVER — the manager's own readiness list. Every sentence
 *      about something missing lives here: which sections will appear, which will
 *      not and why, and anything that will show badly. The officer never sees it.
 *   2. THE HANDOVER — read-only, real records only, neutral words. A section with
 *      nothing in it says "No records for these dates", which is a statement about
 *      the dates. A section whose register does not exist is simply NOT THERE, and
 *      step 1 is where the manager was told so.
 *
 * ── READ-ONLY, AND IT MEANS IT ──────────────────────────────────────────────
 * There is no editable control anywhere in the handover state. The only write on
 * this screen is noting the handover itself (§16: "note who opened it and when"),
 * and it happens in step 1, before the tablet changes hands.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, CheckCircle2, Download, Eye, FileText, FolderCheck, Loader2, RefreshCw, ShieldCheck, X,
} from 'lucide-react';
import { apiJson } from '@/lib/api';
import {
  fssaiCaStatusMeta, fssaiDocStateMeta, fssaiRunStatusMeta,
} from '@/lib/fssai';

interface Section {
  key: string; title: string; lead: string; available: boolean;
  summary: Array<{ label: string; value: string }>;
  rows: any[]; prepare_note: string;
}
interface Pack {
  today: string; days: number; since: string; business_name: string;
  opened_by: { email: string; name: string };
  sections: Section[];
  prepare: {
    ready: string[];
    not_in_handover: Array<{ key: string; title: string; why: string }>;
    warnings: Array<{ key: string; title: string; note: string }>;
  };
  recent_handovers: Array<{ id: string; at: string; by: string; note: string; inspector_name: string; authority: string; inspection_id: string }>;
  open_inspections: Array<{ id: string; inspection_no: string; business_date: string; authority: string; inspector_name: string; status: string }>;
}

const FIELD = 'mt-1 w-full bg-white border border-[#D4B896] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]';

export default function FssaiInspectionModePage() {
  const [pack, setPack] = useState<Pack | null>(null);
  const [days, setDays] = useState(7);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [err, setErr] = useState('');
  const [handover, setHandover] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const j = await apiJson<Pack>(`/api/fssai/inspection-mode?days=${days}`);
      setPack(j);
    } catch (e: any) {
      const m = String(e?.message || '');
      if (m.includes('management only')) setForbidden(true);
      else setErr(m || 'Could not assemble the file');
    } finally { setLoading(false); }
  }, [days]);
  useEffect(() => { load(); }, [load]);

  if (forbidden) {
    return (
      <Shell>
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
          🔒 This page is restricted to management. Ask an administrator for access.
        </div>
      </Shell>
    );
  }

  const live = (pack?.sections || []).filter((s) => s.available);

  /* ══ THE HANDOVER ══════════════════════════════════════════════════════════
   * Read-only. Neutral. Nothing here describes what is missing — the manager was
   * told in the step before this one. */
  if (handover && pack) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-5">
          <div className="flex flex-wrap items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#af4408] text-white flex items-center justify-center shrink-0">
              <ShieldCheck size={20} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">Food safety file</p>
              <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408]">{pack.business_name || 'Food safety file'}</h1>
              <p className="text-sm text-[#6B5744] mt-0.5">
                Records for {pack.since} to {pack.today}. This screen is read-only.
              </p>
            </div>
            {/* Straight to the file: the audit-file PDF states what is on file
                and nothing about gaps, so it is safe on this screen (§7 Q11). */}
            <a
              href={`/api/fssai/audit-file/pdf?days=${days <= 7 ? 7 : days <= 30 ? 30 : 90}`}
              target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-semibold bg-[#af4408] hover:bg-[#8a3606] text-white rounded-lg px-4 py-2 min-h-[44px]"
            >
              <Download size={16} /> The audit file (PDF)
            </a>
            <button
              onClick={() => setHandover(false)}
              className="inline-flex items-center gap-1.5 text-sm border border-[#E8D5C4] bg-white rounded-lg px-3 py-2 hover:bg-[#FFF1E3]"
            >
              <ArrowLeft size={15} /> Leave this view
            </button>
          </div>

          {/* The contents, so somebody holding it can get to a section in a tap. */}
          <div className="bg-white rounded-xl border border-[#E8D5C4] p-4">
            <p className="text-xs font-bold uppercase tracking-wider text-[#8B7355]">In this file</p>
            <div className="flex flex-wrap gap-2 mt-2">
              {live.map((s) => (
                <a
                  key={s.key} href={`#sec-${s.key}`}
                  className="text-sm font-semibold border border-[#E8D5C4] bg-[#FFF1E3] rounded-lg px-3 py-2 min-h-[44px] inline-flex items-center hover:border-[#af4408]"
                >
                  {s.title}
                </a>
              ))}
            </div>
          </div>

          {live.map((s) => (
            <section key={s.key} id={`sec-${s.key}`} className="bg-white rounded-xl border border-[#E8D5C4] overflow-hidden">
              <div className="px-4 py-3 border-b border-[#E8D5C4]">
                <h2 className="font-bold">{s.title}</h2>
                <p className="text-xs text-[#6B5744] mt-0.5">{s.lead}</p>
              </div>
              {s.summary.length > 0 && (
                <div className="px-4 py-3 border-b border-[#E8D5C4] grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {s.summary.map((x, i) => (
                    <div key={i}>
                      <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">{x.label}</p>
                      <p className="text-lg font-bold mt-0.5">{x.value || '—'}</p>
                    </div>
                  ))}
                </div>
              )}
              <div className="px-4 py-3">
                {s.rows.length === 0 ? (
                  /* NEUTRAL, and about the DATES — never about the premises. */
                  <p className="text-sm text-[#8B7355]">No records for these dates.</p>
                ) : (
                  <SectionRows sectionKey={s.key} rows={s.rows} today={pack.today} />
                )}
              </div>
            </section>
          ))}

          <p className="text-xs text-[#8B7355]">
            Every entry above is a record kept in this application, with the person who recorded it and the time they
            did. A voided record is shown with the reason it was voided. Nothing on this screen can be changed while it
            is open.
          </p>
        </div>
      </div>
    );
  }

  /* ══ BEFORE YOU HAND IT OVER ═══════════════════════════════════════════════ */
  return (
    <Shell>
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-[#af4408] text-white flex items-center justify-center shrink-0">
          <Eye size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408]">Inspection Mode</h1>
          <p className="text-xs text-[#8B7355]">
            One read-only screen to hand an inspector, with the whole food-safety file behind it.
          </p>
        </div>
        <button
          onClick={load} disabled={loading}
          className="inline-flex items-center gap-1.5 text-sm border border-[#E8D5C4] bg-white rounded-lg px-3 py-2 hover:bg-[#FFF1E3] disabled:opacity-50"
        >
          {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Refresh
        </button>
      </div>

      {err && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">{err}</div>}
      {loading && !pack && (
        <div className="bg-white rounded-xl border border-[#E8D5C4] p-10 text-center text-sm text-[#8B7355]">
          <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" /> Assembling the file&hellip;
        </div>
      )}

      {pack && (
        <>
          {/* The authority's own list of what an audit file must hold — check it
              before the inspector does. It names gaps, so it lives here, in the
              manager's half, never on the handover view. */}
          <div className="bg-white border-2 border-[#af4408] rounded-xl p-4 sm:p-5 flex flex-wrap items-center gap-3">
            <FolderCheck className="w-8 h-8 text-[#af4408] shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-bold">The audit file — all 20 records the Hyderabad authority asks for</p>
              <p className="text-sm text-[#3D2614] mt-0.5">
                Each one marked present, expiring or missing, with one PDF of the whole file to print or hand over.
              </p>
            </div>
            <a
              href="/fssai/audit-file"
              className="inline-flex items-center gap-1.5 text-sm font-semibold bg-[#af4408] hover:bg-[#8a3606] text-white rounded-lg px-4 py-2 min-h-[44px]"
            >
              <FolderCheck size={16} /> Open the audit file
            </a>
          </div>

          {/* This panel is the whole reason the screen has two states. It is for
              the manager, before the tablet changes hands, and the officer never
              sees a word of it. */}
          <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl p-4 sm:p-5 space-y-3">
            <div className="flex items-start gap-2">
              <ShieldCheck className="w-5 h-5 text-[#af4408] shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="font-bold">Before you hand it over</p>
                <p className="text-sm text-[#3D2614] mt-0.5">
                  This page is for you, not for the inspector. It says exactly what the handover screen will show and
                  what it will not — so nothing on the screen in somebody else&apos;s hands has to explain a gap.
                </p>
              </div>
            </div>

            <label className="block max-w-xs">
              <span className="text-xs text-[#6B5744]">How much history to show</span>
              <select value={days} onChange={(e) => setDays(Number(e.target.value))} className={FIELD}>
                <option value={1}>Today only</option>
                <option value={7}>The last 7 days</option>
                <option value={14}>The last 14 days</option>
                <option value={30}>The last 30 days</option>
                <option value={90}>The last 90 days</option>
              </select>
            </label>

            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-[#8B7355]">
                Will be shown ({live.length})
              </p>
              <ul className="mt-2 space-y-1.5">
                {live.map((s) => (
                  <li key={s.key} className="flex items-start gap-2 text-sm">
                    <CheckCircle2 className="w-4 h-4 text-green-700 shrink-0 mt-0.5" />
                    <span className="min-w-0">
                      <span className="font-semibold">{s.title}</span>
                      <span className="text-[#6B5744]">
                        {' '}— {s.rows.length === 0 ? 'no records for these dates' : `${s.rows.length} entr${s.rows.length === 1 ? 'y' : 'ies'}`}
                        {s.summary.length ? ` · ${s.summary.map((x) => `${x.label}: ${x.value || '—'}`).join(' · ')}` : ''}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            {pack.prepare.warnings.length > 0 && (
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-[#8B7355]">Worth knowing before you hand it over</p>
                <ul className="mt-2 space-y-1.5">
                  {pack.prepare.warnings.map((w) => (
                    <li key={w.key} className="flex items-start gap-2 text-sm">
                      <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                      <span className="min-w-0"><span className="font-semibold">{w.title}</span> — {w.note}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {pack.prepare.not_in_handover.length > 0 && (
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-[#8B7355]">
                  Will NOT appear ({pack.prepare.not_in_handover.length})
                </p>
                <ul className="mt-2 space-y-1.5">
                  {pack.prepare.not_in_handover.map((n) => (
                    <li key={n.key} className="flex items-start gap-2 text-sm">
                      <X className="w-4 h-4 text-[#8B7355] shrink-0 mt-0.5" />
                      <span className="min-w-0">
                        <span className="font-semibold">{n.title}</span>
                        <span className="text-[#6B5744]"> — {n.why}</span>
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-[#8B7355] mt-2">
                  A section that is left out shows nothing at all rather than an empty table. An empty table would read
                  as checks that were not done.
                </p>
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-1">
              <button
                onClick={() => setNoteOpen(true)}
                className="inline-flex items-center gap-1.5 text-sm border border-[#E8D5C4] bg-white rounded-lg px-3 py-2 hover:bg-[#FFF1E3]"
              >
                <FileText size={15} /> Note who it is for
              </button>
              <button
                onClick={() => { setHandover(true); window.scrollTo({ top: 0 }); }}
                className="inline-flex items-center gap-1.5 text-sm font-semibold bg-[#af4408] hover:bg-[#8a3606] text-white rounded-lg px-4 py-2 min-h-[44px]"
              >
                <Eye size={16} /> Open the handover view
              </button>
            </div>
          </div>

          {pack.recent_handovers.length > 0 && (
            <div className="bg-white rounded-xl border border-[#E8D5C4] overflow-hidden">
              <div className="px-4 py-3 border-b border-[#E8D5C4]">
                <h2 className="font-semibold text-sm">Previous handovers</h2>
                <p className="text-xs text-[#8B7355] mt-0.5">Who was shown the file, and when.</p>
              </div>
              <ul className="divide-y divide-[#E8D5C4]">
                {pack.recent_handovers.map((h) => (
                  <li key={h.id} className="px-4 py-2.5 text-sm">
                    <p className="font-semibold">
                      {[h.inspector_name, h.authority].filter(Boolean).join(' — ') || '(not named)'}
                    </p>
                    <p className="text-xs text-[#8B7355]">
                      shown by {h.by} · {h.at}{h.inspection_id ? ' · attached to a recorded visit' : ''}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {noteOpen && pack && (
        <NoteHandoverModal
          openInspections={pack.open_inspections}
          onClose={() => setNoteOpen(false)}
          onSaved={(msg) => { setNoteOpen(false); setToast(msg); setTimeout(() => setToast(''), 4000); load(); }}
        />
      )}
      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[120] bg-[#2D1B0E] text-white text-sm px-4 py-2.5 rounded-lg shadow-lg max-w-[90vw]">
          {toast}
        </div>
      )}
    </Shell>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
 * one section's rows
 * ══════════════════════════════════════════════════════════════════════════ */

function SectionRows({ sectionKey, rows, today }: { sectionKey: string; rows: any[]; today: string }) {
  if (sectionKey === 'documents') {
    return (
      <ul className="divide-y divide-[#E8D5C4] -my-1">
        {rows.map((r) => (
          <li key={r.id} className="py-2.5 flex flex-wrap items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{r.title}</p>
              <p className="text-xs text-[#6B5744]">
                {[r.type_label, r.reference_no, r.issuer].filter(Boolean).join(' · ')}
              </p>
            </div>
            <div className="text-right shrink-0">
              <Badge meta={fssaiDocStateMeta(r.state)} />
              <p className="text-xs text-[#8B7355] mt-0.5">{r.expiry_date || 'does not expire'}</p>
            </div>
          </li>
        ))}
      </ul>
    );
  }

  if (sectionKey === 'checks') {
    return (
      <ul className="divide-y divide-[#E8D5C4] -my-1">
        {rows.map((r) => (
          <li key={r.id} className="py-2.5">
            <div className="flex flex-wrap items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{r.checklist || '(checklist)'}</p>
                <p className="text-xs text-[#6B5744]">
                  {[r.business_date, r.shift, r.target_label, `${r.answered} answered`].filter(Boolean).join(' · ')}
                </p>
                <p className="text-xs text-[#8B7355] mt-0.5">
                  recorded by {r.by || '—'}
                  {r.signed_by ? ` · signed by ${r.signed_by}${r.signed_at ? ` at ${String(r.signed_at).replace('T', ' ').slice(0, 16)}` : ''}` : ''}
                </p>
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                <Badge meta={fssaiRunStatusMeta(r.status)} />
                {r.outcome === 'fail' && (
                  <span className="text-xs font-semibold text-red-700">
                    {r.fail_count} failed
                  </span>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    );
  }

  if (sectionKey === 'temperature') {
    return (
      <div className="overflow-x-auto -mx-1">
        <table className="w-full text-sm">
          <thead className="text-[#6B5744]">
            <tr>
              <Th>Date</Th><Th>Time</Th><Th>Where</Th><Th>What</Th><Th right>Reading</Th><Th>Range applied</Th><Th>By</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#E8D5C4]">
            {rows.map((r) => (
              <tr key={r.id} className={r.is_fail ? 'bg-red-50' : ''}>
                <Td>{r.business_date}</Td>
                <Td>{r.reading_at}</Td>
                <Td>{r.where_label}{r.item_label ? ` · ${r.item_label}` : ''}</Td>
                <Td>{r.kind}</Td>
                {/* A reading nobody took is blank. It is never a nought. */}
                <Td right><span className={r.is_fail ? 'font-bold text-red-700' : ''}>{r.reading ? `${r.reading} ${r.uom}` : '—'}</span></Td>
                <Td>{rangeText(r.min_used, r.max_used) || (r.is_judged ? '—' : 'none set')}</Td>
                <Td>{r.by}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (sectionKey === 'receiving') {
    return (
      <div className="overflow-x-auto -mx-1">
        <table className="w-full text-sm">
          <thead className="text-[#6B5744]">
            <tr>
              <Th>Date</Th><Th>Supplier</Th><Th>Licence</Th><Th right>Vehicle °C</Th><Th right>Lines</Th>
              <Th right>Rejected</Th><Th>By</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#E8D5C4]">
            {rows.map((r) => {
              const lapsed = !!r.supplier_licence_expiry && r.supplier_licence_expiry < today;
              return (
                <tr key={r.id}>
                  <Td>{r.business_date}</Td>
                  <Td><span className="font-semibold">{r.vendor_name}</span>{r.grn_number ? <span className="text-[#8B7355]"> · {r.grn_number}</span> : null}</Td>
                  <Td>
                    {r.supplier_licence_no || '—'}
                    {r.supplier_licence_expiry && (
                      <span className={lapsed ? 'text-red-700 font-semibold' : 'text-[#8B7355]'}> (to {r.supplier_licence_expiry})</span>
                    )}
                  </Td>
                  <Td right>{r.vehicle_temp_c || '—'}</Td>
                  <Td right>{r.line_count}</Td>
                  <Td right><span className={r.rejected_count > 0 ? 'font-semibold text-red-700' : ''}>{r.rejected_count || '—'}</span></Td>
                  <Td>{r.by}</Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  if (sectionKey === 'pest') {
    return (
      <ul className="divide-y divide-[#E8D5C4] -my-1">
        {rows.map((r) => (
          <li key={r.id} className="py-2.5">
            <div className="flex flex-wrap items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{r.vendor_name}{r.service_no ? ` · ${r.service_no}` : ''}</p>
                <p className="text-xs text-[#6B5744]">
                  {[r.business_date, r.technician_name, r.service_kind, r.agency_licence_no && `licence ${r.agency_licence_no}`]
                    .filter(Boolean).join(' · ')}
                </p>
                {r.areas_covered && <p className="text-xs text-[#8B7355] mt-0.5">Areas: {r.areas_covered}</p>}
                {r.findings && <p className="text-sm mt-1">{r.findings}</p>}
                {r.recommendations && <p className="text-xs text-[#3D2614] mt-0.5">Recommended: {r.recommendations}</p>}
              </div>
              <div className="text-right shrink-0">
                {r.next_due_date && <p className="text-xs text-[#8B7355]">next due {r.next_due_date}</p>}
                {r.staff_witness && <p className="text-xs text-[#8B7355]">witnessed by {r.staff_witness}</p>}
              </div>
            </div>
          </li>
        ))}
      </ul>
    );
  }

  if (sectionKey === 'water') {
    return (
      <div className="overflow-x-auto -mx-1">
        <table className="w-full text-sm">
          <thead className="text-[#6B5744]">
            <tr><Th>Date</Th><Th>Test</Th><Th>Point</Th><Th right>Reading</Th><Th>Result</Th><Th>Laboratory</Th><Th>Next due</Th></tr>
          </thead>
          <tbody className="divide-y divide-[#E8D5C4]">
            {rows.map((r) => (
              <tr key={r.id} className={r.is_fail ? 'bg-red-50' : ''}>
                <Td>{r.business_date}</Td>
                <Td>{r.test_kind}</Td>
                <Td>{r.source_point}</Td>
                <Td right>{r.reading ? `${r.reading} ${r.uom}` : '—'}</Td>
                <Td>{r.result || (r.is_judged ? (r.is_fail ? 'Failed' : 'In range') : '—')}</Td>
                <Td>{[r.lab_name, r.report_no].filter(Boolean).join(' · ') || '—'}</Td>
                <Td>{r.next_due_date || '—'}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (sectionKey === 'corrective') {
    return (
      <ul className="divide-y divide-[#E8D5C4] -my-1">
        {rows.map((r) => (
          <li key={r.id} className="py-2.5">
            <div className="flex flex-wrap items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{r.title}</p>
                <p className="text-xs text-[#6B5744]">
                  {[r.ca_number, r.owner_email, r.due_date && `due ${r.due_date}`].filter(Boolean).join(' · ')}
                </p>
                {r.action_taken && <p className="text-sm mt-1">{r.action_taken}</p>}
                {r.verified_by && (
                  <p className="text-xs text-green-800 mt-0.5">
                    Checked by {r.verified_by}{r.verified_at ? ` on ${String(r.verified_at).slice(0, 10)}` : ''}
                    {r.verify_note ? ` — ${r.verify_note}` : ''}
                  </p>
                )}
              </div>
              <div className="text-right shrink-0">
                <Badge meta={fssaiCaStatusMeta(r.status)} />
                {r.overdue && <p className="text-xs font-semibold text-red-700 mt-0.5">past the deadline</p>}
              </div>
            </div>
          </li>
        ))}
      </ul>
    );
  }

  if (sectionKey === 'inspections') {
    return (
      <div className="overflow-x-auto -mx-1">
        <table className="w-full text-sm">
          <thead className="text-[#6B5744]">
            <tr><Th>Date</Th><Th>Ref</Th><Th>Authority</Th><Th>Inspector</Th><Th right>Score</Th><Th>Grade</Th><Th right>Points open</Th></tr>
          </thead>
          <tbody className="divide-y divide-[#E8D5C4]">
            {rows.map((r) => (
              <tr key={r.id}>
                <Td>{r.business_date}</Td>
                <Td>{r.inspection_no}</Td>
                <Td>{r.authority || '—'}</Td>
                <Td>{r.inspector_name || '—'}</Td>
                {/* Their number as given; blank means none was given. */}
                <Td right>{r.score === null ? '—' : r.score_max === null ? String(r.score) : `${r.score} / ${r.score_max}`}</Td>
                <Td>{r.grade || '—'}</Td>
                <Td right><span className={r.open_count > 0 ? 'font-semibold text-red-700' : ''}>{r.open_count}/{r.finding_count}</span></Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // A section shape nobody taught this screen still prints its rows rather than
  // vanishing — the statusMeta fallback habit.
  return (
    <ul className="divide-y divide-[#E8D5C4] -my-1">
      {rows.map((r, i) => (
        <li key={r.id || i} className="py-2 text-xs text-[#3D2614] break-words">
          {Object.entries(r).filter(([k]) => k !== 'id').map(([k, v]) => `${k}: ${String(v ?? '')}`).join(' · ')}
        </li>
      ))}
    </ul>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
 * note the handover
 * ══════════════════════════════════════════════════════════════════════════ */

function NoteHandoverModal({
  openInspections, onClose, onSaved,
}: {
  openInspections: Pack['open_inspections'];
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [inspectorName, setInspectorName] = useState('');
  const [authority, setAuthority] = useState('');
  const [note, setNote] = useState('');
  const [inspectionId, setInspectionId] = useState('');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function save() {
    setSaving(true); setErr('');
    try {
      const j = await apiJson<any>('/api/fssai/inspection-mode', {
        method: 'POST',
        body: { inspector_name: inspectorName, authority, note, inspection_id: inspectionId },
      });
      onSaved(j?.message || 'Handover noted.');
    } catch (e: any) { setErr(e?.message || 'Could not note it'); }
    finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-[110] bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        role="dialog" aria-modal="true" aria-label="Note who the file is being shown to"
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-lg shadow-xl flex flex-col overflow-hidden max-h-[90vh]"
      >
        <div className="px-4 py-3 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
          <h2 className="font-bold">Note who the file is being shown to</h2>
          <button onClick={onClose} aria-label="Close" className="w-9 h-9 rounded-lg hover:bg-[#FFF1E3] flex items-center justify-center">
            <X size={16} />
          </button>
        </div>
        <div className="p-4 space-y-4 overflow-y-auto">
          {err && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">{err}</div>}
          <p className="text-sm text-[#6B5744]">
            This records the handover and nothing else. It changes no record in the file.
          </p>
          <label className="block">
            <span className="text-xs text-[#6B5744]">Inspector&apos;s name</span>
            <input value={inspectorName} onChange={(e) => setInspectorName(e.target.value)} className={FIELD} />
          </label>
          <label className="block">
            <span className="text-xs text-[#6B5744]">Authority</span>
            <input value={authority} onChange={(e) => setAuthority(e.target.value)} className={FIELD} placeholder="FSSAI Hyderabad" />
          </label>
          <p className="text-[11px] text-[#8B7355] -mt-2">One of the two is required.</p>
          {openInspections.length > 0 && (
            <label className="block">
              <span className="text-xs text-[#6B5744]">Attach it to a recorded visit</span>
              <select value={inspectionId} onChange={(e) => setInspectionId(e.target.value)} className={FIELD}>
                <option value="">Do not attach it</option>
                {openInspections.map((i) => (
                  <option key={i.id} value={i.id}>
                    {[i.inspection_no, i.business_date, i.authority || i.inspector_name].filter(Boolean).join(' · ')}
                  </option>
                ))}
              </select>
              <span className="block text-[11px] text-[#8B7355] mt-1">
                Attaching it puts the handover in that visit&apos;s own trail as well.
              </span>
            </label>
          )}
          <label className="block">
            <span className="text-xs text-[#6B5744]">Anything to note</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} className={FIELD} />
          </label>
        </div>
        <div className="px-4 py-3 border-t border-[#E8D5C4] flex justify-end gap-2 shrink-0">
          <button onClick={onClose} className="text-sm px-3 py-2 rounded-lg border border-[#E8D5C4]">Cancel</button>
          <button
            onClick={save} disabled={saving}
            className="text-sm px-3 py-2 rounded-lg bg-[#af4408] hover:bg-[#8a3606] text-white font-semibold disabled:opacity-50"
          >
            {saving ? <Loader2 size={15} className="animate-spin inline" /> : 'Note it'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── small pieces ────────────────────────────────────────────────────────── */

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">{children}</div>
    </div>
  );
}
function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th className={`font-semibold px-2 py-1.5 whitespace-nowrap ${right ? 'text-right' : 'text-left'}`}>{children}</th>;
}
function Td({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <td className={`px-2 py-1.5 ${right ? 'text-right' : 'text-left'}`}>{children}</td>;
}
function Badge({ meta }: { meta: { label: string; color: string } }) {
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full border ${meta.color}`}>
      {meta.label}
    </span>
  );
}
function rangeText(min: number | null, max: number | null): string {
  const parts: string[] = [];
  if (min !== null && min !== undefined) parts.push(`≥ ${min}`);
  if (max !== null && max !== undefined) parts.push(`≤ ${max}`);
  return parts.join(' and ');
}
