'use client';

/**
 * FSSAI Compliance — the Compliance Dashboard (/fssai). Owner §1.
 *
 * ── WHAT CHANGED HERE, AND WHY THE OLD SCREEN WAS RIGHT UNTIL NOW ───────────
 * Until P9 this page deliberately showed NO figures, and said so: "This
 * dashboard shows no counts because there is nothing to count yet — not because
 * it cannot count." That was true and it was the correct thing to print. P9 is
 * the phase that makes it count, so the sentence has gone — but the JUDGEMENT
 * behind it has not. It is now a measurement rather than a paragraph: the screen
 * asks the server what exists and says "nothing has been recorded yet" only when
 * that is a fact (`corpus.records === 0`), and shows figures the moment one
 * record exists.
 *
 * ── THE THREE THINGS A TILE MAY SAY, AND WHY THERE ARE THREE ────────────────
 * Every figure arrives as { value, state, why }. A tile renders:
 *   · state 'ok'          → the number.
 *   · state 'unavailable' → "Not available yet", NEVER 0. Its register does not
 *     exist in this database. Measured in this worktree: 11 of 30 fssai_ tables
 *     exist, because Wave 1 declared the other 19 and they arrive on the next
 *     cold start. "0 temperature breaches" printed above an absent temperature
 *     register is the single most dangerous sentence this module could render.
 *   · state 'restricted'  → "Management only". A premises-wide figure, withheld
 *     from a staff-tier phone rather than shown as a zero (owner §7 Q10).
 * A tile that fails says so on itself and the other eleven still render.
 *
 * Style is the house skeleton (docs/fssai/RECON.md §1.3): hex literals, no dark
 * mode, cards on phones and tables from md up. The module map at the bottom is
 * unchanged — it is the one part of this screen that was always right.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, ArrowRight, BarChart3, CalendarClock, ClipboardCheck, FileText, Hourglass,
  Loader2, Lock, PackageCheck, RefreshCw, ShieldCheck, Thermometer, Wrench,
} from 'lucide-react';
import {
  FSSAI_MODULES, fssaiAccessLabel, fssaiPhase, type FssaiGroup, type FssaiModule,
} from './_components/modules';

/* ── the server's shapes ─────────────────────────────────────────────────── */

type BucketState = 'ok' | 'unavailable' | 'failed' | 'restricted';
interface Bucket<T> { value: T; state: BucketState; why: string }

interface DueRow {
  assignment_id: string; template_id: string; template_name: string; template_code: string;
  target_label: string; shift: string; department_name: string; next_due_date: string;
  filed: boolean; open_run_id: string; overdue: boolean;
}
interface CaRow {
  id: string; ca_number: string; title: string; severity: string; status: string;
  due_date: string; owner_email: string; department_name: string; overdue: boolean;
}
interface DocRow { id: string; title: string; reference_no: string; expiry_date: string; state: string; owner_email: string }
interface TempRow {
  id: string; business_date: string; reading_at: string; where_label: string; reading: string;
  min_used: number | null; max_used: number | null; fail_reason: string; action_taken: string;
}
interface FailRow { run_id: string; business_date: string; prompt: string; answer: string; department_name: string; by: string }

interface Dash {
  today: string;
  window_days: number;
  window_from: string;
  scope: 'restaurant' | 'department';
  scope_note: string;
  due: Bucket<{ due: number; overdue: number; recorded: number; outstanding: number; rows: DueRow[] }>;
  open_rounds: Bucket<{ mine: number; all: number }>;
  awaiting_verification: Bucket<{ n: number; failed: number }>;
  failures: Bucket<{ rounds_today: number; rounds_window: number; answers_window: number; rows: FailRow[] }>;
  corrective_actions: Bucket<{ open: number; overdue: number; awaiting_check: number; mine: number; rows: CaRow[] }>;
  documents: Bucket<{ expired: number; expiring: number; total: number; rows: DocRow[] }>;
  temperature: Bucket<{ readings_today: number; breaches_today: number; breaches_window: number; unjudged_window: number; rows: TempRow[] }>;
  receiving: Bucket<{ checked_today: number; failed_window: number; rejected_window: number; licence_lapsed: number }>;
  expiry: Bucket<{ expired_open: number; near_open: number; discarded_window: number }>;
  oil: Bucket<{ checks_window: number; over_limit_window: number; changed_window: number }>;
  water: Bucket<{ tests_window: number; failed_window: number; next_due_overdue: number }>;
  pest: Bucket<{ visits_window: number; missed: number; next_due_overdue: number; sightings_open: number }>;
  inspections: Bucket<{ visits_year: number; open_points: number; overdue_points: number; reply_due: number; last: any }>;
  corpus: Bucket<{ records: number; templates: number; published: number; assignments: number }>;
  registers_missing: string[];
}

const BANDS: Array<{ key: FssaiGroup; title: string; sub: string }> = [
  { key: 'checks', title: 'The checks themselves', sub: 'What staff stand in front of and record, mostly on a phone.' },
  { key: 'records', title: 'Follow-up and the file', sub: 'What happens after a check fails, and the paperwork an inspector asks for.' },
  { key: 'setup', title: 'Reports and your standards', sub: 'What you read, what you hand over, and the settings everything else obeys.' },
];

export default function FssaiDashboardPage() {
  const [d, setD] = useState<Dash | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      // A plain fetch is correct for a GET: isStateChanging() never checks them.
      const res = await fetch('/api/fssai/dashboard', { credentials: 'same-origin' });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
      setD(j as Dash);
    } catch (e: any) {
      setErr(e?.message || 'Could not load the figures');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const nothingYet = !!d && d.corpus.state === 'ok' && d.corpus.value.records === 0;

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">

        {/* Header */}
        <div className="flex flex-wrap items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#af4408] text-white flex items-center justify-center shrink-0">
            <ShieldCheck size={20} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">FSSAI Compliance</p>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408]">Compliance Dashboard</h1>
            <p className="text-sm text-[#6B5744] mt-1">
              Every food-safety check the restaurant runs, in one place — who owes what today, what failed,
              and what an inspector would ask to see.
            </p>
          </div>
          <button
            onClick={load} disabled={loading}
            className="inline-flex items-center gap-1.5 text-sm border border-[#E8D5C4] bg-white rounded-lg px-3 py-2 hover:bg-[#FFF1E3] disabled:opacity-50"
          >
            {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Refresh
          </button>
        </div>

        {/* The way in. Full width, 56px, above everything else — it is what a
            member of staff opens this screen for. */}
        <a
          href="/fssai/checklists/run"
          className="w-full min-h-[56px] inline-flex items-center justify-center gap-2 text-base font-semibold rounded-xl px-4 bg-[#af4408] hover:bg-[#8a3606] text-white"
        >
          <ShieldCheck size={18} /> Run a check
        </a>

        {err && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">
            {err}
          </div>
        )}

        {loading && !d && (
          <div className="bg-white rounded-xl border border-[#E8D5C4] p-10 text-center text-sm text-[#8B7355]">
            <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" /> Counting&hellip;
          </div>
        )}

        {d && (
          <>
            {/* Who this reader is seeing. Said out loud, because a departmental
                figure that looks like a restaurant figure is worse than no figure. */}
            <p className="text-xs text-[#8B7355]">
              {d.scope_note} Figures marked &ldquo;recently&rdquo; cover {d.window_days} days, {d.window_from} to {d.today}.
            </p>

            {nothingYet ? (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 sm:p-5">
                <div className="flex items-start gap-3">
                  <Hourglass className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="font-bold text-amber-900">No checks have been recorded here yet</p>
                    <p className="text-sm text-amber-900 mt-1">
                      Every figure below counts real records, and there are none so far. This screen is not
                      waiting on anything — write a checklist in Settings, then fill one in from &ldquo;Run a
                      check&rdquo; above, and the counts appear.
                      {d.corpus.value.published === 0
                        ? ' There is no published checklist yet, so that is the first step.'
                        : ` ${d.corpus.value.published} checklist${d.corpus.value.published === 1 ? ' is' : 's are'} published and ready to run.`}
                    </p>
                  </div>
                </div>
              </div>
            ) : null}

            {/* ── TODAY ──────────────────────────────────────────────────── */}
            <section className="space-y-3">
              <h2 className="text-lg font-semibold">Today</h2>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <Tile
                  icon={CalendarClock} label="Checks due today"
                  bucket={d.due} value={(v) => String(v.due)}
                  sub={(v) => (v.due === 0 ? 'Nothing scheduled for today' : `${v.recorded} filed, ${v.outstanding} outstanding`)}
                  alert={(v) => v.overdue > 0}
                  alertWord={(v) => `${v.overdue} overdue`}
                  href="/fssai/checklists/run"
                />
                <Tile
                  icon={ClipboardCheck} label="Rounds left open"
                  bucket={d.open_rounds} value={(v) => String(v.all)}
                  sub={(v) => (v.mine ? `${v.mine} of them yours` : 'None of them yours')}
                  href="/fssai/checklists/run"
                />
                <Tile
                  icon={ShieldCheck} label="Waiting to be verified"
                  bucket={d.awaiting_verification} value={(v) => String(v.n)}
                  sub={(v) => (v.failed ? `${v.failed} of them failed` : 'None of them failed')}
                  alert={(v) => v.failed > 0}
                  href="/fssai/verification"
                />
                <Tile
                  icon={AlertTriangle} label="Failed today"
                  bucket={d.failures} value={(v) => String(v.rounds_today)}
                  sub={(v) => `${v.rounds_window} rounds and ${v.answers_window} answers failed recently`}
                  alert={(v) => v.rounds_today > 0}
                />
              </div>
            </section>

            {/* ── WHAT NEEDS SOMEBODY ────────────────────────────────────── */}
            <section className="space-y-3">
              <h2 className="text-lg font-semibold">What needs somebody</h2>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <Tile
                  icon={Wrench} label="Corrective actions open"
                  bucket={d.corrective_actions} value={(v) => String(v.open)}
                  sub={(v) => (v.mine ? `${v.mine} assigned to you` : v.awaiting_check ? `${v.awaiting_check} waiting to be checked` : 'None assigned to you')}
                  alert={(v) => v.overdue > 0}
                  alertWord={(v) => `${v.overdue} past the deadline`}
                  href="/fssai/corrective-actions"
                />
                <Tile
                  icon={FileText} label="Certificates to renew"
                  bucket={d.documents} value={(v) => String(v.expired + v.expiring)}
                  sub={(v) => `${v.total} on file`}
                  alert={(v) => v.expired > 0}
                  alertWord={(v) => `${v.expired} already lapsed`}
                  href="/fssai/documents"
                />
                <Tile
                  icon={Thermometer} label="Temperature breaches"
                  bucket={d.temperature} value={(v) => String(v.breaches_window)}
                  sub={(v) => (v.unjudged_window ? `${v.unjudged_window} readings had no range set` : `${v.readings_today} readings taken today`)}
                  alert={(v) => v.breaches_window > 0}
                  href="/fssai/temperature"
                />
                <Tile
                  icon={BarChart3} label="Inspection points open"
                  bucket={d.inspections} value={(v) => String(v.open_points)}
                  sub={(v) => (v.visits_year ? `${v.visits_year} visit${v.visits_year === 1 ? '' : 's'} this year` : 'No visits recorded this year')}
                  alert={(v) => v.overdue_points > 0}
                  alertWord={(v) => `${v.overdue_points} past the deadline`}
                  href="/fssai/inspections"
                />
              </div>
            </section>

            {/* ── THE REGISTERS ──────────────────────────────────────────── */}
            <section className="space-y-3">
              <h2 className="text-lg font-semibold">
                The registers, over the last {d.window_days} days
              </h2>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <Tile
                  icon={PackageCheck} label="Deliveries checked today"
                  bucket={d.receiving} value={(v) => String(v.checked_today)}
                  sub={(v) => `${v.failed_window} with a failed line recently`}
                  alert={(v) => v.licence_lapsed > 0}
                  alertWord={(v) => `${v.licence_lapsed} supplier licence lapsed`}
                  href="/fssai/receiving"
                />
                <Tile
                  icon={CalendarClock} label="Past their date, unresolved"
                  bucket={d.expiry} value={(v) => String(v.expired_open)}
                  sub={(v) => `${v.near_open} close to their date`}
                  alert={(v) => v.expired_open > 0}
                  href="/fssai/fifo"
                />
                <Tile
                  icon={Thermometer} label="Oil over the limit"
                  bucket={d.oil} value={(v) => String(v.over_limit_window)}
                  sub={(v) => `${v.checks_window} checks, oil changed ${v.changed_window} time${v.changed_window === 1 ? '' : 's'}`}
                  alert={(v) => v.over_limit_window > 0}
                  href="/fssai/oil-quality"
                />
                <Tile
                  icon={AlertTriangle} label="Pest sightings open"
                  bucket={d.pest} value={(v) => String(v.sightings_open)}
                  sub={(v) => (v.missed ? `${v.missed} contracted visit${v.missed === 1 ? '' : 's'} missed` : `${v.visits_window} visit${v.visits_window === 1 ? '' : 's'} recently`)}
                  alert={(v) => v.sightings_open > 0 || v.missed > 0}
                  href="/fssai/pest-control"
                />
              </div>
              {d.water.state !== 'ok' || d.water.value.next_due_overdue > 0 || d.water.value.failed_window > 0 ? (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  <Tile
                    icon={ClipboardCheck} label="Water tests overdue"
                    bucket={d.water} value={(v) => String(v.next_due_overdue)}
                    sub={(v) => `${v.tests_window} tests recently, ${v.failed_window} failed`}
                    alert={(v) => v.next_due_overdue > 0 || v.failed_window > 0}
                    href="/fssai/water-ice"
                  />
                </div>
              ) : null}
              {d.registers_missing.length > 0 && (
                <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg p-3 text-xs text-[#6B5744]">
                  <p className="font-semibold text-[#2D1B0E]">
                    {d.registers_missing.length} register{d.registers_missing.length === 1 ? '' : 's'} could not be counted
                  </p>
                  <p className="mt-1">
                    Their tables are not in this copy of the database yet, so those tiles say &ldquo;not available&rdquo;
                    rather than nought — a zero there would read as checks that were done and passed. Restarting the
                    application once creates them.
                  </p>
                </div>
              )}
            </section>

            {/* ── THE LISTS ──────────────────────────────────────────────── */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {/* due today */}
              <Panel title="Still to do today" href="/fssai/checklists/run" hrefLabel="Run a check">
                {d.due.state !== 'ok' ? (
                  <Muted>{d.due.why || 'Not available.'}</Muted>
                ) : d.due.value.rows.length === 0 ? (
                  <Muted>{d.due.value.due === 0 ? 'Nothing is scheduled for today.' : 'Everything scheduled for today has been filed.'}</Muted>
                ) : (
                  <ul className="divide-y divide-[#E8D5C4]">
                    {d.due.value.rows.map((r) => (
                      <li key={r.assignment_id} className="py-2.5 flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold truncate">{r.template_name}</p>
                          <p className="text-xs text-[#8B7355]">
                            {[r.shift, r.target_label, r.department_name].filter(Boolean).join(' · ') || 'Whole restaurant'}
                          </p>
                        </div>
                        {/* Overdue is red TEXT on the date, not a badge — the house
                            treatment (tasks/page.tsx:396). */}
                        <span className={`text-xs shrink-0 ${r.overdue ? 'text-red-700 font-semibold' : 'text-[#6B5744]'}`}>
                          {r.next_due_date ? (r.overdue ? `due ${r.next_due_date}` : r.next_due_date) : 'due today'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>

              {/* corrective actions */}
              <Panel title="Corrective actions" href="/fssai/corrective-actions" hrefLabel="All actions">
                {d.corrective_actions.state !== 'ok' ? (
                  <Muted>{d.corrective_actions.why || 'Not available.'}</Muted>
                ) : d.corrective_actions.value.rows.length === 0 ? (
                  <Muted>Nothing open. An action is raised automatically when a flagged check fails.</Muted>
                ) : (
                  <ul className="divide-y divide-[#E8D5C4]">
                    {d.corrective_actions.value.rows.map((r) => (
                      <li key={r.id} className="py-2.5">
                        <div className="flex items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold">{r.title}</p>
                            <p className="text-xs text-[#8B7355]">
                              {[r.ca_number, r.owner_email || 'nobody assigned', r.department_name].filter(Boolean).join(' · ')}
                            </p>
                          </div>
                          <span className={`text-xs shrink-0 ${r.overdue ? 'text-red-700 font-semibold' : 'text-[#6B5744]'}`}>
                            {r.due_date || 'no deadline'}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>

              {/* failures */}
              <Panel title="What failed recently" href="/fssai/reports" hrefLabel="Reports">
                {d.failures.state !== 'ok' ? (
                  <Muted>{d.failures.why || 'Not available.'}</Muted>
                ) : d.failures.value.rows.length === 0 ? (
                  <Muted>No answer has failed in the last {d.window_days} days.</Muted>
                ) : (
                  <ul className="divide-y divide-[#E8D5C4]">
                    {d.failures.value.rows.map((r, i) => (
                      <li key={`${r.run_id}-${i}`} className="py-2.5">
                        <p className="text-sm">{r.prompt}</p>
                        <p className="text-xs text-[#8B7355] mt-0.5">
                          {/* An answer that was never given says so. It is never shown as a number. */}
                          {r.answer || 'No answer recorded'} · {r.business_date}
                          {r.by ? ` · ${r.by}` : ''}{r.department_name ? ` · ${r.department_name}` : ''}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>

              {/* temperature breaches */}
              <Panel title="Temperature breaches" href="/fssai/temperature" hrefLabel="The register">
                {d.temperature.state !== 'ok' ? (
                  <Muted>{d.temperature.why || 'Not available.'}</Muted>
                ) : d.temperature.value.rows.length === 0 ? (
                  <Muted>
                    No reading has been out of range in the last {d.window_days} days.
                    {d.temperature.value.unjudged_window > 0
                      ? ` ${d.temperature.value.unjudged_window} reading${d.temperature.value.unjudged_window === 1 ? '' : 's'} had no range set, so nothing judged ${d.temperature.value.unjudged_window === 1 ? 'it' : 'them'}.`
                      : ''}
                  </Muted>
                ) : (
                  <ul className="divide-y divide-[#E8D5C4]">
                    {d.temperature.value.rows.map((r) => (
                      <li key={r.id} className="py-2.5">
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-sm font-semibold min-w-0 truncate">{r.where_label}</p>
                          <span className="text-sm font-bold text-red-700 shrink-0">{r.reading || '—'}</span>
                        </div>
                        <p className="text-xs text-[#8B7355] mt-0.5">
                          {r.business_date}{r.reading_at ? ` ${r.reading_at}` : ''}
                          {r.min_used !== null || r.max_used !== null
                            ? ` · should have been ${[r.min_used !== null ? `≥ ${r.min_used}` : '', r.max_used !== null ? `≤ ${r.max_used}` : ''].filter(Boolean).join(' and ')}`
                            : ''}
                        </p>
                        {r.action_taken && <p className="text-xs text-[#3D2614] mt-1">{r.action_taken}</p>}
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>

              {/* documents */}
              {d.documents.state === 'ok' && d.documents.value.rows.length > 0 && (
                <Panel title="Certificates to renew" href="/fssai/documents" hrefLabel="The cupboard">
                  <ul className="divide-y divide-[#E8D5C4]">
                    {d.documents.value.rows.map((r) => (
                      <li key={r.id} className="py-2.5 flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold truncate">{r.title}</p>
                          <p className="text-xs text-[#8B7355]">
                            {[r.reference_no, r.owner_email].filter(Boolean).join(' · ')}
                          </p>
                        </div>
                        <span className={`text-xs shrink-0 ${r.state === 'expired' ? 'text-red-700 font-semibold' : 'text-amber-800 font-semibold'}`}>
                          {r.state === 'expired' ? `lapsed ${r.expiry_date}` : `to ${r.expiry_date}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Panel>
              )}
            </div>
          </>
        )}

        {/* ── the module map. Unchanged. ─────────────────────────────────── */}
        {BANDS.map((band) => {
          const rows = FSSAI_MODULES.filter((m) => m.group === band.key);
          return (
            <section key={band.key} className="space-y-3">
              <div>
                <h2 className="text-lg font-semibold text-[#2D1B0E]">{band.title}</h2>
                <p className="text-xs text-[#8B7355] mt-0.5">{band.sub}</p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 sm:gap-4">
                {rows.map((m) => <ModuleTile key={m.href} mod={m} />)}
              </div>
            </section>
          );
        })}

        <div className="flex items-start gap-2 text-xs text-[#8B7355] pt-1">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <p>
            Every figure on this screen counts real records. A reading nobody took is shown blank and never as
            nought, a register that is not there says so rather than showing a zero, and nowhere in this module is
            there a made-up reading, a sample record or a placeholder row that could be mistaken for evidence.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ── a figure, with the three things it may say instead of a number ───────── */

function Tile<T>({
  icon: Icon, label, bucket, value, sub, alert, alertWord, href,
}: {
  icon: typeof ShieldCheck;
  label: string;
  bucket: Bucket<T>;
  value: (v: T) => string;
  sub?: (v: T) => string;
  alert?: (v: T) => boolean;
  alertWord?: (v: T) => string;
  href?: string;
}) {
  const unavailable = bucket.state !== 'ok';
  const isAlert = !unavailable && !!alert && alert(bucket.value);
  const body = (
    <>
      <div className="flex items-start gap-2">
        <div className={`p-1.5 rounded-lg shrink-0 ${isAlert ? 'bg-red-100' : 'bg-[#af4408]/10'}`}>
          <Icon className={`w-4 h-4 ${isAlert ? 'text-red-700' : 'text-[#af4408]'}`} />
        </div>
        <p className="text-xs font-semibold text-[#6B5744] leading-snug min-w-0">{label}</p>
      </div>
      {unavailable ? (
        <>
          <p className="text-sm font-semibold text-[#8B7355] mt-2">
            {bucket.state === 'restricted' ? 'Management only' : bucket.state === 'failed' ? 'Could not be read' : 'Not available yet'}
          </p>
          <p className="text-[11px] text-[#8B7355] mt-0.5">{bucket.why}</p>
        </>
      ) : (
        <>
          <p className={`text-2xl font-bold mt-1 ${isAlert ? 'text-red-700' : 'text-[#2D1B0E]'}`}>
            {value(bucket.value)}
          </p>
          {isAlert && alertWord && (
            <p className="text-[11px] font-semibold text-red-700">{alertWord(bucket.value)}</p>
          )}
          {sub && <p className="text-[11px] text-[#8B7355] mt-0.5">{sub(bucket.value)}</p>}
        </>
      )}
    </>
  );
  const cls = `bg-white border rounded-xl p-3 flex flex-col ${isAlert ? 'border-red-200' : 'border-[#E8D5C4]'}`;
  return href && !unavailable
    ? <a href={href} className={`${cls} hover:border-[#af4408] transition-colors`}>{body}</a>
    : <div className={cls}>{body}</div>;
}

function Panel({ title, href, hrefLabel, children }: { title: string; href?: string; hrefLabel?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-[#E8D5C4] overflow-hidden">
      <div className="px-4 py-3 border-b border-[#E8D5C4] flex items-center justify-between gap-2">
        <h3 className="font-semibold text-sm">{title}</h3>
        {href && (
          <a href={href} className="text-xs font-semibold text-[#af4408] hover:underline shrink-0">
            {hrefLabel || 'Open'}
          </a>
        )}
      </div>
      <div className="px-4 py-2">{children}</div>
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-[#8B7355] py-4">{children}</p>;
}

/* ── the module tile (unchanged) ─────────────────────────────────────────── */

function ModuleTile({ mod }: { mod: FssaiModule }) {
  const Icon = mod.icon;
  const phase = fssaiPhase(mod.phase);
  const accessLabel = fssaiAccessLabel(mod.access);
  return (
    <a
      href={mod.href}
      className="group bg-white border border-[#E8D5C4] rounded-xl p-4 flex flex-col gap-2 hover:border-[#af4408] transition-colors"
    >
      <div className="flex items-start gap-2.5">
        <div className="p-1.5 rounded-lg bg-[#af4408]/10 shrink-0">
          <Icon className="w-4 h-4 text-[#af4408]" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[#2D1B0E] leading-snug">{mod.label}</p>
          <p className="text-xs text-[#6B5744] mt-1">{mod.blurb}</p>
        </div>
        <ArrowRight className="w-4 h-4 text-[#C4B09A] group-hover:text-[#af4408] shrink-0" />
      </div>
      <div className="flex flex-wrap items-center gap-1.5 mt-auto pt-1">
        <span
          className={`inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-full border ${
            mod.built
              ? 'bg-emerald-100 text-emerald-700 border-emerald-200'
              : 'bg-[#FFF1E3] text-[#8B7355] border-[#E8D5C4]'
          }`}
        >
          {mod.built ? 'Working now' : phase.when}
        </span>
        {accessLabel && (
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border bg-purple-100 text-purple-700 border-purple-200">
            <Lock className="w-3 h-3" /> {accessLabel}
          </span>
        )}
      </div>
    </a>
  );
}
