'use client';

/**
 * WASTE HANDOVER LOG — Hyderabad Food Safety audit checklist line #114,
 * "Records You Should Keep Ready in One Audit File: Waste disposal record".
 *
 * ── WHAT THE AUTHORITY ASKS, AND WHAT THIS SCREEN RECORDS ───────────────────
 * One line per handover: the date, wet / dry / other, how much, who collected it
 * (GHMC or an authorised agency), the receipt or vehicle number, and who handed
 * it over. A collector's agreement filed under Documents & Certificates says
 * somebody MAY take the waste; this log says it DID, every time.
 *
 * ── BUILT FOR THE BACK DOOR ─────────────────────────────────────────────────
 * The form is open at the top of the page, not behind a button. Date and time
 * are already filled; the collector is one tap ("same as before" chips from the
 * recent handovers); "handed over by" is already the person signed in. What is
 * left to type is the quantities and the receipt or vehicle number. After a save
 * the collector stays chosen, so tomorrow's entry is three numbers.
 *
 * ── PRINTABLE ───────────────────────────────────────────────────────────────
 * "Print the register" opens a sheet laid out like a paper register — date, wet,
 * dry, other, collector, vehicle / receipt, handed over by, received by, and an
 * empty signature column — with optional blank lines for a paper fallback when
 * the tablet is not at the door. Voided lines print struck through WITH their
 * reason: evidence is voided, never deleted, and a printed register that hid them
 * would be a different register from the one in the database.
 *
 * The pieces live in ./waste-ui.tsx so each can be rendered on its own; a page
 * file may only export its default component.
 */

import { useCallback, useEffect, useState } from 'react';
import { Info, Lock, Printer, Search } from 'lucide-react';
import { apiJson } from '@/lib/api';
import { fssaiToday } from '@/lib/fssai';
import {
  Field, HandoverModal, INPUT, PrintSheet, RecordCard, RegisterTable, Shell, TotalsAndGaps, VerdictBanner,
  addDays, type RegisterResponse,
} from './waste-ui';

export default function FssaiWastePage() {
  const today = fssaiToday();
  const [data, setData] = useState<RegisterResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [from, setFrom] = useState(addDays(today, -29));
  const [to, setTo] = useState(today);
  const [status, setStatus] = useState<'live' | 'void' | 'all'>('live');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const p = new URLSearchParams({ from, to, status });
      if (q.trim()) p.set('q', q.trim());
      setData(await apiJson<RegisterResponse>(`/api/fssai/waste?${p}`));
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Could not load the waste handovers';
      if (/sign in|401/i.test(m)) setSignedOut(true);
      else setErr(m);
    } finally { setLoading(false); }
  }, [from, to, status, q]);

  useEffect(() => { void load(); }, [load]);

  if (signedOut) {
    return (
      <Shell>
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 text-center">
          <Lock className="w-6 h-6 mx-auto mb-2 text-[#8B7355]" />
          <p className="text-sm text-[#3D2614]">Please sign in to see the waste handovers.</p>
        </div>
      </Shell>
    );
  }

  return (
    <>
      <div className={printing ? 'print:hidden' : ''}>
        <Shell>
          {data && <VerdictBanner data={data} />}

          {data?.can_record && <RecordCard data={data} onSaved={(m) => { setToast(m); void load(); }} />}

          <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 space-y-2">
            <div className="flex flex-wrap items-end gap-2">
              <Field label="From">
                <input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} className={INPUT} />
              </Field>
              <Field label="To">
                <input type="date" value={to} max={today} onChange={(e) => e.target.value && setTo(e.target.value)} className={INPUT} />
              </Field>
              <div className="flex flex-wrap gap-1.5">
                {([['live', 'Handovers'], ['void', 'Voided'], ['all', 'All']] as const).map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => setStatus(k)}
                    className={`text-sm px-3 py-2 rounded-lg border font-medium min-h-[44px] ${
                      status === k ? 'bg-[#af4408] border-[#af4408] text-white' : 'bg-white border-[#E8D5C4] text-[#6B5744] hover:border-[#af4408]'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setPrinting(true)}
                disabled={!data}
                className="ml-auto min-h-[44px] px-3 rounded-lg border border-[#af4408] text-[#af4408] bg-white text-sm font-medium flex flex-nowrap items-center gap-1.5 disabled:opacity-50"
              >
                <Printer size={16} /> Print the register
              </button>
            </div>
            <div className="relative">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8B7355]" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Number, collector, receipt, vehicle, who handed over" className={`${INPUT} pl-9`} />
            </div>
          </div>

          {data && <TotalsAndGaps data={data} />}

          {err && <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-800">{err}</div>}

          {loading && !data ? (
            <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center text-sm text-[#6B5744]">Loading…</div>
          ) : (
            <RegisterTable
              handovers={data?.handovers || []}
              truncated={!!data?.truncated}
              emptyText={status === 'void' ? 'No handover in these dates has been voided.' : 'No waste handover is recorded in these dates.'}
              onOpen={setOpen}
            />
          )}

          <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl p-3">
            <div className="flex flex-nowrap items-start gap-2.5">
              <Info size={16} className="text-[#af4408] shrink-0 mt-0.5" />
              <p className="text-xs text-[#3D2614] leading-relaxed">
                A blank stream means it did not go on that handover — it is never counted as zero. A line
                entered by mistake is voided by a manager with a reason and stays on the register, marked
                void. The collector&rsquo;s agreement itself belongs in Documents &amp; Certificates as
                &ldquo;Waste disposal record&rdquo;; this log is each time the waste actually left. There is no
                money on this screen and nothing here changes stock.
              </p>
            </div>
          </div>
        </Shell>
      </div>

      {open && (
        <HandoverModal
          id={open}
          onClose={() => setOpen(null)}
          onChanged={(m) => { setToast(m); void load(); }}
          onClosedAfterChange={(m) => { setOpen(null); setToast(m); void load(); }}
        />
      )}

      {printing && data && <PrintSheet data={data} onClose={() => setPrinting(false)} />}

      {toast && (
        <div className="print:hidden fixed bottom-4 left-1/2 -translate-x-1/2 z-[70] bg-[#2D1B0E] text-white text-sm px-4 py-2.5 rounded-xl shadow-lg max-w-[90vw]">
          {toast}
        </div>
      )}
    </>
  );
}
