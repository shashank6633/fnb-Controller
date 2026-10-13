'use client';

/**
 * Inspection Reports (/fssai/inspections) — owner §16, §18. Management only.
 *
 * ── WHAT THIS SCREEN IS FOR ─────────────────────────────────────────────────
 * An inspection that ACTUALLY HAPPENED, and the points somebody else raised
 * against clauses we did not write. The score and the grade are theirs, recorded
 * as printed, and a score nobody gave is left blank rather than typed as nought.
 *
 * ── THE THREE REFUSALS THIS SCREEN SURFACES, RATHER THAN HIDES ──────────────
 * The API refuses to close a visit while a point is open, refuses to close a
 * point with no answer, and refuses a void from the person who recorded it. All
 * three are the SERVER's rules — this screen does not reimplement any of them, it
 * shows the refusal in the words the server used. That is deliberate: a button
 * disabled on the client is a courtesy, and a refusal from the route is the rule.
 *
 * ── A POINT CAN RAISE ITS FIX ───────────────────────────────────────────────
 * "Raise a corrective action" on a live point (or the box on the add form)
 * asks the route to raise ONE action in the shared corrective-action spine,
 * carrying the point with it. The route refuses a second one, a settled point
 * and a closed or voided visit; this screen only hides the button where the
 * route would refuse. The action is then worked in /fssai/corrective-actions.
 *
 * ── NO DATE DEFAULT ────────────────────────────────────────────────────────
 * The history opens on EVERY visit. RECON §7.2 records what a silent window once
 * did to this owner's trust in a report; on an inspection history it would read as
 * visits having disappeared. A date range here is always something somebody chose.
 *
 * Style: the house skeleton (RECON §1.3) — hex literals, cards on a phone and the
 * table from md up, the vendors.tsx modal shell with its bg-black/40 overlay so
 * globals.css:295 locks the page behind it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, CheckCircle2, ClipboardList, Loader2, Plus, RefreshCw, Trash2, Wrench, X,
} from 'lucide-react';
import { apiJson } from '@/lib/api';
import {
  FSSAI_CA_SEVERITIES, FSSAI_FINDING_SEVERITIES, FSSAI_INSPECTION_KINDS, FSSAI_INSPECTION_STATUSES,
  fssaiCaSeverityMeta, fssaiCaStatusMeta,
  fssaiFindingSeverityMeta, fssaiFindingStatusMeta, fssaiInspectionStatusMeta,
} from '@/lib/fssai';

/**
 * The inspector's grading → the corrective-action severity it starts at. The
 * SAME table as FINDING_TO_CA_SEVERITY in /api/fssai/inspections; the screen only
 * uses it to pre-select the drop-down and to say what will happen — the server
 * decides, and repeats the mapping itself when no severity is sent.
 */
const FINDING_TO_CA_SEVERITY: Record<string, string> = {
  critical: 'urgent', major: 'high', minor: 'medium', observation: 'low',
};

interface Inspection {
  id: string; inspection_no: string; inspection_kind: string; authority: string; inspector_name: string;
  inspector_id_no: string; business_date: string; started_at: string; finished_at: string; scope: string;
  department_id: string; department_name: string; score: number | null; score_max: number | null;
  grade: string; outcome: string; report_no: string; observations: string; our_response: string;
  finding_count: number; open_count: number; reply_due_date: string; reply_overdue: boolean;
  status: string; closed_at: string; closed_by: string; accompanied_by: string;
  voided_at: string; voided_by: string; void_reason: string; created_by: string; is_editable: boolean;
}
interface Finding {
  id: string; inspection_id: string; finding_no: string; clause_ref: string; category: string;
  severity: string; observation: string; department_id: string; department_name: string;
  location_label: string; due_date: string; ca_id: string; response: string; status: string;
  closed_at: string; closed_by: string; sort_order: number; overdue: boolean; severity_rank: number;
}
interface CaRow {
  id: string; ca_number: string; title: string; status: string; severity: string;
  owner_email: string; due_date: string; action_taken: string; verified_by: string; verified_at: string;
}
/** What add_finding / raise_ca answer with — corrective_action is null when none was asked for. */
interface RaiseResponse {
  corrective_action: { id: string; ca_number: string; severity: string; due_date: string } | null;
}

const FIELD = 'mt-1 w-full bg-white border border-[#D4B896] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]';

export default function FssaiInspectionsPage() {
  const [rows, setRows] = useState<Inspection[]>([]);
  const [departments, setDepartments] = useState<Array<{ id: string; name: string }>>([]);
  const [totals, setTotals] = useState({ visits: 0, with_open_points: 0, voided: 0 });
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [unavailable, setUnavailable] = useState('');
  const [err, setErr] = useState('');
  const [toast, setToast] = useState('');

  /* Filters. `dates` starts EMPTY and that is the whole point — see the header. */
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState('all');
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');

  const [openId, setOpenId] = useState('');
  const [newOpen, setNewOpen] = useState(false);

  const say = useCallback((m: string) => { setToast(m); setTimeout(() => setToast(''), 3200); }, []);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    const p = new URLSearchParams();
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (status && status !== 'all') p.set('status', status);
    if (kind) p.set('kind', kind);
    if (q.trim()) p.set('q', q.trim());
    try {
      const j = await apiJson<any>(`/api/fssai/inspections${p.toString() ? `?${p}` : ''}`);
      setRows(j.inspections || []);
      setDepartments(j.departments || []);
      setTotals(j.totals || { visits: 0, with_open_points: 0, voided: 0 });
      setUnavailable('');
    } catch (e: any) {
      const m = String(e?.message || '');
      if (m.includes('management only')) setForbidden(true);
      else if (m.includes('not been created')) setUnavailable(m);
      else setErr(m || 'Could not load the inspections');
    } finally { setLoading(false); }
  }, [from, to, status, kind, q]);

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

  if (openId) {
    return <Detail id={openId} onBack={() => { setOpenId(''); load(); }} say={say} departments={departments} />;
  }

  return (
    <Shell>
      <Header
        title="Inspection Reports"
        sub="Every inspection and audit that happened — what was observed, the deadline on each point, and how it was closed."
        right={
          <>
            <button
              onClick={load} disabled={loading}
              className="inline-flex items-center gap-1.5 text-sm border border-[#E8D5C4] bg-white rounded-lg px-3 py-2 hover:bg-[#FFF1E3] disabled:opacity-50"
            >
              {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Refresh
            </button>
            <button
              onClick={() => setNewOpen(true)}
              className="inline-flex items-center gap-1.5 text-sm font-semibold bg-[#af4408] hover:bg-[#8a3606] text-white rounded-lg px-3 py-2"
            >
              <Plus size={15} /> Record a visit
            </button>
          </>
        }
      />

      {unavailable && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">{unavailable}</div>
      )}
      {err && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">{err}</div>}

      {/* Figures across every visit on file, not just the filtered page. */}
      {!unavailable && (
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Visits on file" value={String(totals.visits)} />
          <Stat label="With points still open" value={String(totals.with_open_points)} alert={totals.with_open_points > 0} />
          <Stat label="Voided" value={String(totals.voided)} />
        </div>
      )}

      {/* Filters. The date boxes are empty on purpose. */}
      <div className="bg-white rounded-xl border border-[#E8D5C4] p-3 sm:p-4 space-y-3">
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <label className="block">
            <span className="text-xs text-[#6B5744]">From</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={FIELD} />
          </label>
          <label className="block">
            <span className="text-xs text-[#6B5744]">To</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={FIELD} />
          </label>
          <label className="block">
            <span className="text-xs text-[#6B5744]">State</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className={FIELD}>
              <option value="all">Everything, including voided</option>
              <option value="active">Everything except voided</option>
              {FSSAI_INSPECTION_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-[#6B5744]">Kind</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)} className={FIELD}>
              <option value="">Any kind</option>
              {FSSAI_INSPECTION_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-[#6B5744]">Search</span>
            <input
              value={q} onChange={(e) => setQ(e.target.value)} placeholder="authority, inspector, reference"
              className={FIELD}
            />
          </label>
        </div>
        <p className="text-xs text-[#8B7355]">
          {from || to
            ? `Showing visits ${from ? `from ${from}` : ''}${from && to ? ' ' : ''}${to ? `up to ${to}` : ''}. Clear both dates to see every visit again.`
            : 'Showing EVERY visit on file. A date range here is always something you chose — this screen never narrows itself.'}
        </p>
      </div>

      {/* The list */}
      <div className="bg-white rounded-xl border border-[#E8D5C4] overflow-hidden">
        {loading ? (
          <div className="p-10 text-center text-sm text-[#8B7355]">
            <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" /> Loading&hellip;
          </div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm font-semibold text-[#2D1B0E]">
              {from || to || kind || q ? 'No visit matches those filters' : 'No inspection has been recorded yet'}
            </p>
            <p className="text-xs text-[#8B7355] mt-1">
              {from || to || kind || q
                ? 'That is a statement about the filters above, not about the restaurant. Clear them to see everything.'
                : 'Record a visit as it happens, or afterwards from the notice — the points and their deadlines go on it.'}
            </p>
          </div>
        ) : (
          <>
            <div className="md:hidden divide-y divide-[#E8D5C4]">
              {rows.map((r) => (
                <button key={r.id} onClick={() => setOpenId(r.id)} className="w-full text-left p-4 hover:bg-[#FFF8F0]">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-semibold text-sm min-w-0">{r.authority || r.inspector_name || '(not named)'}</p>
                    <Badge meta={fssaiInspectionStatusMeta(r.status)} />
                  </div>
                  <p className="text-xs text-[#8B7355] mt-1">
                    {[r.business_date, r.inspection_no, kindLabel(r.inspection_kind)].filter(Boolean).join(' · ')}
                  </p>
                  <p className="text-xs mt-1">
                    {scoreText(r)}
                    {r.finding_count > 0 && (
                      <span className={r.open_count > 0 ? 'text-red-700 font-semibold' : 'text-[#6B5744]'}>
                        {scoreText(r) ? ' · ' : ''}{r.open_count} of {r.finding_count} point{r.finding_count === 1 ? '' : 's'} open
                      </span>
                    )}
                  </p>
                </button>
              ))}
            </div>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-[#FFF1E3] text-[#6B5744]">
                  <tr>
                    <th className="text-left font-semibold px-3 py-2">Date</th>
                    <th className="text-left font-semibold px-3 py-2">Ref</th>
                    <th className="text-left font-semibold px-3 py-2">Authority / inspector</th>
                    <th className="text-left font-semibold px-3 py-2">Kind</th>
                    <th className="text-right font-semibold px-3 py-2">Score</th>
                    <th className="text-left font-semibold px-3 py-2">Grade</th>
                    <th className="text-right font-semibold px-3 py-2">Points</th>
                    <th className="text-left font-semibold px-3 py-2">Reply due</th>
                    <th className="text-left font-semibold px-3 py-2">State</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E8D5C4]">
                  {rows.map((r) => (
                    <tr key={r.id} onClick={() => setOpenId(r.id)} className="hover:bg-[#FFF8F0] cursor-pointer">
                      <td className="px-3 py-2 whitespace-nowrap">{r.business_date}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-[#6B5744]">{r.inspection_no}</td>
                      <td className="px-3 py-2">
                        <span className="font-semibold">{r.authority || '—'}</span>
                        {r.inspector_name && <span className="text-[#6B5744]"> · {r.inspector_name}</span>}
                      </td>
                      <td className="px-3 py-2 text-[#6B5744]">{kindLabel(r.inspection_kind)}</td>
                      {/* A blank score is blank. It is never a nought. */}
                      <td className="px-3 py-2 text-right whitespace-nowrap">{scoreText(r) || '—'}</td>
                      <td className="px-3 py-2">{r.grade || '—'}</td>
                      <td className={`px-3 py-2 text-right whitespace-nowrap ${r.open_count > 0 ? 'text-red-700 font-semibold' : 'text-[#6B5744]'}`}>
                        {r.finding_count === 0 ? '—' : `${r.open_count}/${r.finding_count}`}
                      </td>
                      {/* Overdue is red text on the date — the house treatment. */}
                      <td className={`px-3 py-2 whitespace-nowrap ${r.reply_overdue ? 'text-red-700 font-semibold' : 'text-[#6B5744]'}`}>
                        {r.reply_due_date || '—'}
                      </td>
                      <td className="px-3 py-2"><Badge meta={fssaiInspectionStatusMeta(r.status)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {newOpen && (
        <NewVisitModal
          departments={departments}
          onClose={() => setNewOpen(false)}
          onSaved={(id) => { setNewOpen(false); say('Visit recorded.'); setOpenId(id); }}
        />
      )}
      {toast && <Toast>{toast}</Toast>}
    </Shell>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
 * ONE VISIT
 * ══════════════════════════════════════════════════════════════════════════ */

function Detail({
  id, onBack, say, departments,
}: { id: string; onBack: () => void; say: (m: string) => void; departments: Array<{ id: string; name: string }> }) {
  const [insp, setInsp] = useState<Inspection | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [actions, setActions] = useState<CaRow[]>([]);
  const [trail, setTrail] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [closing, setClosing] = useState<Finding | null>(null);
  const [raising, setRaising] = useState<Finding | null>(null);
  const [voidOpen, setVoidOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const j = await apiJson<any>(`/api/fssai/inspections?id=${encodeURIComponent(id)}`);
      setInsp(j.inspection); setFindings(j.findings || []);
      setActions(j.corrective_actions || []); setTrail(j.trail || []);
    } catch (e: any) { setErr(e?.message || 'Could not load that visit'); }
    finally { setLoading(false); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const act = useCallback(async (body: any, okMsg: string) => {
    setBusy(body.action); setErr('');
    try {
      await apiJson('/api/fssai/inspections', { method: 'POST', body });
      say(okMsg);
      await load();
      return true;
    } catch (e: any) {
      /* THE SERVER'S OWN WORDS. Not a generic failure, and not a client-side
       * guess at why — the route is the rule and it explains itself. */
      setErr(e?.message || 'That did not work');
      return false;
    } finally { setBusy(''); }
  }, [say, load]);

  const open = useMemo(() => findings.filter((f) => f.status !== 'closed' && f.status !== 'not_accepted'), [findings]);
  const caById = useMemo(() => new Map(actions.map((a) => [a.id, a])), [actions]);

  return (
    <Shell>
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-sm text-[#af4408] font-semibold hover:underline">
        <ArrowLeft size={15} /> All inspections
      </button>

      {err && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">{err}</div>}
      {loading && !insp && (
        <div className="bg-white rounded-xl border border-[#E8D5C4] p-10 text-center text-sm text-[#8B7355]">
          <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" /> Loading&hellip;
        </div>
      )}

      {insp && (
        <>
          <div className="bg-white rounded-xl border border-[#E8D5C4] p-4 sm:p-5 space-y-3">
            <div className="flex flex-wrap items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-[#af4408] text-white flex items-center justify-center shrink-0">
                <ClipboardList size={20} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">
                  {kindLabel(insp.inspection_kind)} · {insp.inspection_no}
                </p>
                <h1 className="text-xl sm:text-2xl font-bold text-[#af4408]">
                  {insp.authority || insp.inspector_name || 'Inspection'}
                </h1>
                <p className="text-sm text-[#6B5744] mt-0.5">
                  {[insp.business_date, insp.inspector_name, insp.inspector_id_no && `ID ${insp.inspector_id_no}`,
                    insp.department_name, insp.scope].filter(Boolean).join(' · ')}
                </p>
              </div>
              <Badge meta={fssaiInspectionStatusMeta(insp.status)} />
            </div>

            {insp.status === 'void' && (
              <div className="bg-gray-100 border border-gray-200 rounded-lg p-3 text-sm">
                <p className="font-semibold">This record was voided, not deleted.</p>
                <p className="text-[#6B5744] mt-0.5">
                  {insp.voided_by} on {String(insp.voided_at).slice(0, 10)} — &ldquo;{insp.void_reason}&rdquo;
                </p>
              </div>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="Score they gave" value={scoreText(insp) || 'None given'} />
              <Stat label="Grade" value={insp.grade || '—'} />
              <Stat label="Points raised" value={String(insp.finding_count)} />
              <Stat label="Still open" value={String(insp.open_count)} alert={insp.open_count > 0} />
            </div>

            {insp.reply_due_date && (
              <p className={`text-sm ${insp.reply_overdue ? 'text-red-700 font-semibold' : 'text-[#6B5744]'}`}>
                Reply due {insp.reply_due_date}{insp.reply_overdue ? ' — past the deadline' : ''}
              </p>
            )}

            {insp.observations && (
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-[#8B7355]">What they observed</p>
                <p className="text-sm mt-1 whitespace-pre-wrap">{insp.observations}</p>
              </div>
            )}
            {insp.our_response && (
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-[#8B7355]">What we told them</p>
                <p className="text-sm mt-1 whitespace-pre-wrap">{insp.our_response}</p>
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-1">
              {insp.is_editable && (
                <button
                  onClick={() => setAddOpen(true)}
                  className="inline-flex items-center gap-1.5 text-sm font-semibold bg-[#af4408] hover:bg-[#8a3606] text-white rounded-lg px-3 py-2"
                >
                  <Plus size={15} /> Add a point
                </button>
              )}
              {insp.is_editable && insp.status !== 'planned' && (
                <button
                  onClick={() => {
                    const note = window.prompt('Anything to record about closing this visit? (optional)') ?? '';
                    act({ action: 'close', id: insp.id, note }, 'Visit closed.');
                  }}
                  disabled={busy === 'close'}
                  className="inline-flex items-center gap-1.5 text-sm border border-[#E8D5C4] bg-white rounded-lg px-3 py-2 hover:bg-[#FFF1E3] disabled:opacity-50"
                >
                  <CheckCircle2 size={15} /> Close the visit
                </button>
              )}
              {insp.status === 'closed' && (
                <button
                  onClick={() => {
                    const reason = window.prompt('Why is this visit being reopened? This goes in the file.') ?? '';
                    if (reason.trim()) act({ action: 'reopen', id: insp.id, reason }, 'Visit reopened.');
                  }}
                  disabled={busy === 'reopen'}
                  className="inline-flex items-center gap-1.5 text-sm border border-[#E8D5C4] bg-white rounded-lg px-3 py-2 hover:bg-[#FFF1E3] disabled:opacity-50"
                >
                  <RefreshCw size={15} /> Reopen
                </button>
              )}
              {insp.status !== 'void' && (
                <button
                  onClick={() => setVoidOpen(true)}
                  className="inline-flex items-center gap-1.5 text-sm border border-red-200 text-red-700 bg-white rounded-lg px-3 py-2 hover:bg-red-50"
                >
                  <Trash2 size={15} /> Void this record
                </button>
              )}
            </div>
            {insp.status !== 'closed' && insp.status !== 'void' && open.length > 0 && (
              <p className="text-xs text-[#8B7355]">
                The visit cannot be closed while {open.length} point{open.length === 1 ? ' is' : 's are'} open. Close each
                one with what was done, or mark it as not accepted.
              </p>
            )}
          </div>

          {/* The points */}
          <div className="bg-white rounded-xl border border-[#E8D5C4] overflow-hidden">
            <div className="px-4 py-3 border-b border-[#E8D5C4]">
              <h2 className="font-semibold text-sm">The points they raised</h2>
              <p className="text-xs text-[#8B7355] mt-0.5">
                Worst first. The fix itself lives once, as a corrective action — this is what the authority said and
                what we answered.
              </p>
            </div>
            {findings.length === 0 ? (
              <p className="p-8 text-center text-sm text-[#8B7355]">
                No point has been recorded against this visit.
              </p>
            ) : (
              <ul className="divide-y divide-[#E8D5C4]">
                {findings.map((f) => {
                  const ca = f.ca_id ? caById.get(f.ca_id) : undefined;
                  return (
                    <li key={f.id} className="p-4 space-y-2">
                      <div className="flex flex-wrap items-start gap-2">
                        <span className="text-xs font-bold text-[#8B7355] shrink-0 mt-0.5">#{f.finding_no || f.sort_order}</span>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm whitespace-pre-wrap">{f.observation}</p>
                          <p className="text-xs text-[#8B7355] mt-1">
                            {[f.clause_ref && `clause ${f.clause_ref}`, f.location_label, f.department_name, f.category]
                              .filter(Boolean).join(' · ') || 'no clause cited'}
                          </p>
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          <Badge meta={fssaiFindingSeverityMeta(f.severity)} />
                          <Badge meta={fssaiFindingStatusMeta(f.status)} />
                        </div>
                      </div>
                      {f.due_date && (
                        <p className={`text-xs ${f.overdue ? 'text-red-700 font-semibold' : 'text-[#6B5744]'}`}>
                          due {f.due_date}{f.overdue ? ' — past the deadline' : ''}
                        </p>
                      )}
                      {f.response && (
                        <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg p-3">
                          <p className="text-[11px] font-bold uppercase tracking-wider text-[#8B7355]">What we did</p>
                          <p className="text-sm mt-0.5 whitespace-pre-wrap">{f.response}</p>
                          {f.closed_at && (
                            <p className="text-[11px] text-[#8B7355] mt-1">
                              closed {String(f.closed_at).slice(0, 10)} by {f.closed_by}
                            </p>
                          )}
                        </div>
                      )}
                      {ca && (
                        <a href="/fssai/corrective-actions" className="block bg-white border border-[#E8D5C4] rounded-lg p-3 hover:border-[#af4408]">
                          <p className="text-[11px] font-bold uppercase tracking-wider text-[#8B7355]">
                            Corrective action {ca.ca_number}
                          </p>
                          <p className="text-sm font-semibold mt-0.5">{ca.title}</p>
                          <p className="text-xs text-[#6B5744] mt-0.5">
                            {[
                              fssaiCaStatusMeta(ca.status).label,
                              fssaiCaSeverityMeta(ca.severity).label,
                              ca.owner_email || 'nobody assigned yet',
                              ca.due_date && `due ${ca.due_date}`,
                            ].filter(Boolean).join(' · ')}
                          </p>
                        </a>
                      )}
                      {insp.status !== 'void' && (
                        <div className="flex flex-wrap gap-2">
                          {f.status !== 'closed' && f.status !== 'not_accepted' ? (
                            <>
                              <button
                                onClick={() => setClosing(f)}
                                className="text-xs font-semibold border border-[#E8D5C4] bg-white rounded-lg px-2.5 py-1.5 hover:bg-[#FFF1E3]"
                              >
                                Close this point
                              </button>
                              {/* Only a live point with no fix yet. The server
                                * holds the same rule and says so if it is
                                * broken; hiding the button is the courtesy. */}
                              {!f.ca_id && insp.status !== 'closed' && (
                                <button
                                  onClick={() => setRaising(f)}
                                  className="inline-flex items-center gap-1 text-xs font-semibold border border-[#af4408] text-[#af4408] bg-white rounded-lg px-2.5 py-1.5 hover:bg-[#FFF1E3]"
                                >
                                  <Wrench size={13} /> Raise a corrective action
                                </button>
                              )}
                            </>
                          ) : (
                            <button
                              onClick={() => {
                                const reason = window.prompt('Why is this point being reopened?') ?? '';
                                if (reason.trim()) act({ action: 'reopen_finding', id: f.id, reason }, 'Point reopened.');
                              }}
                              className="text-xs font-semibold border border-[#E8D5C4] bg-white rounded-lg px-2.5 py-1.5 hover:bg-[#FFF1E3]"
                            >
                              Reopen
                            </button>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* The change-and-void trail (§19) */}
          {trail.length > 0 && (
            <div className="bg-white rounded-xl border border-[#E8D5C4] overflow-hidden">
              <div className="px-4 py-3 border-b border-[#E8D5C4]">
                <h2 className="font-semibold text-sm">What changed on this record</h2>
              </div>
              <ul className="divide-y divide-[#E8D5C4]">
                {trail.map((t, i) => (
                  <li key={i} className="px-4 py-2 text-xs">
                    <span className="font-semibold">{t.action}</span>
                    {t.field ? <span className="text-[#8B7355]"> · {t.field}</span> : null}
                    <span className="text-[#8B7355]"> · {t.actor_name || t.actor_email} · {t.created_at}</span>
                    {t.reason ? <p className="text-[#3D2614] mt-0.5">{t.reason}</p> : null}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {addOpen && (
            <AddFindingModal
              inspectionId={insp.id}
              departments={departments}
              defaultDepartmentId={insp.department_id}
              onClose={() => setAddOpen(false)}
              onSaved={(msg) => { setAddOpen(false); say(msg); load(); }}
            />
          )}
          {raising && (
            <RaiseCaModal
              finding={raising}
              onClose={() => setRaising(null)}
              onSaved={(caNumber) => { setRaising(null); say(`Corrective action ${caNumber} raised.`); load(); }}
            />
          )}
          {closing && (
            <CloseFindingModal
              finding={closing}
              onClose={() => setClosing(null)}
              onSaved={() => { setClosing(null); say('Point closed.'); load(); }}
            />
          )}
          {voidOpen && (
            <VoidModal
              inspection={insp}
              onClose={() => setVoidOpen(false)}
              onSaved={() => { setVoidOpen(false); say('Record voided.'); load(); }}
            />
          )}
        </>
      )}
    </Shell>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
 * MODALS
 * ══════════════════════════════════════════════════════════════════════════ */

function NewVisitModal({
  departments, onClose, onSaved,
}: { departments: Array<{ id: string; name: string }>; onClose: () => void; onSaved: (id: string) => void }) {
  const [f, setF] = useState<any>({
    inspection_kind: 'fssai_officer', authority: '', inspector_name: '', inspector_id_no: '',
    business_date: new Date().toISOString().slice(0, 10), scope: '', department_id: '',
    score: '', score_max: '', grade: '', outcome: '', report_no: '', reply_due_date: '', observations: '',
  });
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (k: string) => (e: any) => setF((p: any) => ({ ...p, [k]: e.target.value }));

  async function save() {
    setSaving(true); setErr('');
    try {
      const j = await apiJson<any>('/api/fssai/inspections', { method: 'POST', body: { action: 'create', ...f } });
      onSaved(j.inspection.id);
    } catch (e: any) { setErr(e?.message || 'Could not save'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="Record an inspection" onClose={onClose} onSave={save} saving={saving} err={err} saveLabel="Record the visit">
      <Field label="Who inspected" hint="The authority, the inspector's name, or both. One of them is required.">
        <select value={f.inspection_kind} onChange={set('inspection_kind')} className={FIELD}>
          {FSSAI_INSPECTION_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
        </select>
      </Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Authority"><input value={f.authority} onChange={set('authority')} className={FIELD} placeholder="FSSAI Hyderabad" /></Field>
        <Field label="Inspector"><input value={f.inspector_name} onChange={set('inspector_name')} className={FIELD} /></Field>
        <Field label="Inspector ID"><input value={f.inspector_id_no} onChange={set('inspector_id_no')} className={FIELD} /></Field>
        <Field label="Date of the visit" required><input type="date" value={f.business_date} onChange={set('business_date')} className={FIELD} /></Field>
      </div>
      <Field label="What they looked at"><input value={f.scope} onChange={set('scope')} className={FIELD} placeholder="Kitchen, store and bar" /></Field>
      <Field label="Department">
        <select value={f.department_id} onChange={set('department_id')} className={FIELD}>
          <option value="">The whole premises</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </Field>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Field label="Score" hint="Leave blank if none was given."><input type="number" step="any" value={f.score} onChange={set('score')} className={FIELD} /></Field>
        <Field label="Out of"><input type="number" step="any" value={f.score_max} onChange={set('score_max')} className={FIELD} /></Field>
        <Field label="Grade"><input value={f.grade} onChange={set('grade')} className={FIELD} placeholder="A / B" /></Field>
        <Field label="Outcome">
          <select value={f.outcome} onChange={set('outcome')} className={FIELD}>
            <option value="">Not stated</option>
            <option value="pass">Pass</option>
            <option value="conditional">Conditional</option>
            <option value="fail">Fail</option>
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Their report number"><input value={f.report_no} onChange={set('report_no')} className={FIELD} /></Field>
        <Field label="Reply due by"><input type="date" value={f.reply_due_date} onChange={set('reply_due_date')} className={FIELD} /></Field>
      </div>
      <Field label="What they observed" hint="The summary from the notice. Individual points go on the visit afterwards.">
        <textarea value={f.observations} onChange={set('observations')} rows={4} className={FIELD} />
      </Field>
      <p className="text-xs text-[#8B7355]">
        A score nobody gave is left blank, not recorded as nought. The grade and the score are theirs, as printed.
      </p>
    </Modal>
  );
}

function AddFindingModal({
  inspectionId, departments, defaultDepartmentId, onClose, onSaved,
}: {
  inspectionId: string; departments: Array<{ id: string; name: string }>;
  defaultDepartmentId: string; onClose: () => void; onSaved: (msg: string) => void;
}) {
  const [f, setF] = useState<any>({
    finding_no: '', clause_ref: '', category: '', severity: 'major', observation: '',
    department_id: defaultDepartmentId || '', location_label: '', due_date: '',
  });
  /* null = follow the severity (ticked for critical and major, the two an
   * authority comes back to check); true/false = the person chose. Either way
   * the box is on screen and nothing is raised without it ticked. */
  const [raiseChoice, setRaiseChoice] = useState<boolean | null>(null);
  const raiseCa = raiseChoice ?? (f.severity === 'critical' || f.severity === 'major');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (k: string) => (e: any) => setF((p: any) => ({ ...p, [k]: e.target.value }));

  async function save() {
    setSaving(true); setErr('');
    try {
      const j = await apiJson<RaiseResponse>('/api/fssai/inspections', {
        method: 'POST',
        body: { action: 'add_finding', inspection_id: inspectionId, ...f, raise_ca: raiseCa },
      });
      onSaved(j?.corrective_action?.ca_number
        ? `Point added — corrective action ${j.corrective_action.ca_number} raised.`
        : 'Point added.');
    } catch (e: any) { setErr(e?.message || 'Could not save'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="Add a point" onClose={onClose} onSave={save} saving={saving} err={err} saveLabel="Add the point">
      <Field label="What was observed" required hint="In their words where you have them. This is what gets asked about at the next visit.">
        <textarea value={f.observation} onChange={set('observation')} rows={4} className={FIELD} />
      </Field>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Field label="No."><input value={f.finding_no} onChange={set('finding_no')} className={FIELD} placeholder="auto" /></Field>
        <Field label="Clause"><input value={f.clause_ref} onChange={set('clause_ref')} className={FIELD} placeholder="Sch 4 Part II" /></Field>
        <Field label="Severity">
          <select value={f.severity} onChange={set('severity')} className={FIELD}>
            {FSSAI_FINDING_SEVERITIES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </Field>
        <Field label="Fix by"><input type="date" value={f.due_date} onChange={set('due_date')} className={FIELD} /></Field>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Field label="Where"><input value={f.location_label} onChange={set('location_label')} className={FIELD} placeholder="Cold room 2" /></Field>
        <Field label="Category"><input value={f.category} onChange={set('category')} className={FIELD} placeholder="Storage" /></Field>
        <Field label="Department">
          <select value={f.department_id} onChange={set('department_id')} className={FIELD}>
            <option value="">The whole premises</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
      </div>
      <label className="flex items-start gap-2 text-sm bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg p-3">
        <input type="checkbox" checked={raiseCa} onChange={(e) => setRaiseChoice(e.target.checked)} className="mt-0.5" />
        <span>
          <span className="font-semibold">Raise a corrective action for this point now.</span>
          <span className="text-[#6B5744]">
            {' '}It goes into Corrective actions as{' '}
            <b>{fssaiCaSeverityMeta(FINDING_TO_CA_SEVERITY[f.severity] || 'medium').label}</b>, due{' '}
            {f.due_date ? `on ${f.due_date} (the date above)` : 'by the house default for that severity'}, carrying
            this observation, where it was found and who inspected.
          </span>
        </span>
      </label>
      <p className="text-xs text-[#8B7355]">
        The fix itself is recorded once, as a corrective action. This screen holds what was observed and what we
        answered — it does not keep a second copy of the work.
      </p>
    </Modal>
  );
}

function RaiseCaModal({
  finding, onClose, onSaved,
}: { finding: Finding; onClose: () => void; onSaved: (caNumber: string) => void }) {
  const [severity, setSeverity] = useState(FINDING_TO_CA_SEVERITY[finding.severity] || 'medium');
  const [dueDate, setDueDate] = useState('');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true); setErr('');
    try {
      const j = await apiJson<RaiseResponse>('/api/fssai/inspections', {
        method: 'POST',
        body: { action: 'raise_ca', id: finding.id, ca_severity: severity, ca_due_date: dueDate },
      });
      onSaved(String(j?.corrective_action?.ca_number || ''));
    } catch (e: unknown) { setErr(e instanceof Error && e.message ? e.message : 'Could not raise it'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="Raise a corrective action" onClose={onClose} onSave={save} saving={saving} err={err} saveLabel="Raise it">
      <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg p-3">
        <p className="text-[11px] font-bold uppercase tracking-wider text-[#8B7355]">
          Point #{finding.finding_no || finding.sort_order} · {fssaiFindingSeverityMeta(finding.severity).label}
          {finding.clause_ref ? ` · clause ${finding.clause_ref}` : ''}
        </p>
        <p className="text-sm mt-0.5 whitespace-pre-wrap">{finding.observation}</p>
        {(finding.location_label || finding.department_name) && (
          <p className="text-xs text-[#8B7355] mt-1">{[finding.location_label, finding.department_name].filter(Boolean).join(' · ')}</p>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="How urgent" hint="Starts from how they graded the point. A manager can change it later.">
          <select value={severity} onChange={(e) => setSeverity(e.target.value)} className={FIELD}>
            {FSSAI_CA_SEVERITIES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </Field>
        <Field
          label="Fix by"
          hint={finding.due_date
            ? `Leave blank to use their deadline, ${finding.due_date}.`
            : 'Leave blank to use the house default for that severity.'}
        >
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={FIELD} />
        </Field>
      </div>
      <p className="text-xs text-[#8B7355]">
        The action carries this observation, the clause, where it was found and who inspected, so whoever fixes it does
        not need this screen. It is assigned, worked and checked in Corrective actions, like every other fix. One point
        raises one action.
      </p>
    </Modal>
  );
}

function CloseFindingModal({ finding, onClose, onSaved }: { finding: Finding; onClose: () => void; onSaved: () => void }) {
  const [response, setResponse] = useState('');
  const [notAccepted, setNotAccepted] = useState(false);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true); setErr('');
    try {
      await apiJson('/api/fssai/inspections', {
        method: 'POST',
        body: { action: 'close_finding', id: finding.id, response, not_accepted: notAccepted ? '1' : '' },
      });
      onSaved();
    } catch (e: any) { setErr(e?.message || 'Could not save'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="Close this point" onClose={onClose} onSave={save} saving={saving} err={err} saveLabel="Close the point">
      <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg p-3">
        <p className="text-[11px] font-bold uppercase tracking-wider text-[#8B7355]">What was observed</p>
        <p className="text-sm mt-0.5">{finding.observation}</p>
      </div>
      <Field label="What was done about it" required hint="A point closed with no answer is the first thing asked about at the next visit.">
        <textarea value={response} onChange={(e) => setResponse(e.target.value)} rows={4} className={FIELD} />
      </Field>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={notAccepted} onChange={(e) => setNotAccepted(e.target.checked)} className="mt-0.5" />
        <span>
          <span className="font-semibold">We did not accept this point.</span>
          <span className="text-[#6B5744]"> Record it as not accepted rather than closed, with our answer above.</span>
        </span>
      </label>
    </Modal>
  );
}

function VoidModal({ inspection, onClose, onSaved }: { inspection: Inspection; onClose: () => void; onSaved: () => void }) {
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true); setErr('');
    try {
      await apiJson('/api/fssai/inspections', { method: 'POST', body: { action: 'void', id: inspection.id, reason } });
      onSaved();
    } catch (e: any) { setErr(e?.message || 'Could not void it'); }
    finally { setSaving(false); }
  }

  /* An irreversible action gets the written explainer, not a window.confirm —
   * the variance-approvals pattern (RECON §1.4). */
  return (
    <Modal title="Void this inspection record" onClose={onClose} onSave={save} saving={saving} err={err} saveLabel="Void the record" danger>
      <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-900 space-y-1">
        <p className="font-semibold">Nothing is deleted. The record stays in the file, marked as voided.</p>
        <p>
          Voiding is for a record entered by mistake — the wrong date, a duplicate, the wrong authority. It is not a
          way to remove a finding somebody raised.
        </p>
        <p>
          Two rules the server enforces: only a manager, head of department or administrator may void, and never the
          person who recorded it. If that is you, somebody else has to do this.
        </p>
      </div>
      <Field label="Why is it being voided" required hint="At least a few words. This is printed beside the record for ever.">
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} className={FIELD} />
      </Field>
    </Modal>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
 * small shared pieces
 * ══════════════════════════════════════════════════════════════════════════ */

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">{children}</div>
    </div>
  );
}

function Header({ title, sub, right }: { title: string; sub: string; right?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="w-10 h-10 rounded-xl bg-[#af4408] text-white flex items-center justify-center shrink-0">
        <ClipboardList size={20} />
      </div>
      <div className="min-w-0 flex-1">
        <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408]">{title}</h1>
        <p className="text-xs text-[#8B7355]">{sub}</p>
      </div>
      {right}
    </div>
  );
}

function Stat({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <div className={`bg-white border rounded-xl p-3 ${alert ? 'border-red-200' : 'border-[#E8D5C4]'}`}>
      <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">{label}</p>
      <p className={`text-xl font-bold mt-0.5 ${alert ? 'text-red-700' : 'text-[#2D1B0E]'}`}>{value}</p>
    </div>
  );
}

function Badge({ meta }: { meta: { label: string; color: string } }) {
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full border ${meta.color}`}>
      {meta.label}
    </span>
  );
}

function Field({ label, children, hint, required }: { label: string; children: React.ReactNode; hint?: string; required?: boolean }) {
  return (
    <label className="block">
      <span className="text-xs text-[#6B5744]">
        {label}{required && <span className="text-[#af4408]"> *</span>}
      </span>
      {children}
      {hint && <span className="block text-[11px] text-[#8B7355] mt-1">{hint}</span>}
    </label>
  );
}

function Modal({
  title, children, onClose, onSave, saving, err, saveLabel, danger,
}: {
  title: string; children: React.ReactNode; onClose: () => void; onSave: () => void;
  saving: boolean; err: string; saveLabel: string; danger?: boolean;
}) {
  /* The bg-black/40 class is load-bearing: globals.css:295 keys the scroll lock
   * off it, so without it the page scrolls behind the modal. role="dialog" +
   * aria-modal + Escape are FSSAI's own small accessibility addition (RECON §1.6)
   * — cheap, invisible, and no app-wide redesign. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[110] bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        role="dialog" aria-modal="true" aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-2xl shadow-xl flex flex-col overflow-hidden max-h-[90vh]"
      >
        <div className="px-4 py-3 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
          <h2 className="font-bold">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="w-9 h-9 rounded-lg hover:bg-[#FFF1E3] flex items-center justify-center">
            <X size={16} />
          </button>
        </div>
        <div className="p-4 space-y-4 overflow-y-auto">
          {err && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800 flex items-start gap-2">
              <AlertTriangle size={15} className="shrink-0 mt-0.5" /><span>{err}</span>
            </div>
          )}
          {children}
        </div>
        <div className="px-4 py-3 border-t border-[#E8D5C4] flex justify-end gap-2 shrink-0">
          <button onClick={onClose} className="text-sm px-3 py-2 rounded-lg border border-[#E8D5C4]">Cancel</button>
          <button
            onClick={onSave} disabled={saving}
            className={`text-sm px-3 py-2 rounded-lg text-white font-semibold disabled:opacity-50 ${danger ? 'bg-red-700 hover:bg-red-800' : 'bg-[#af4408] hover:bg-[#8a3606]'}`}
          >
            {saving ? <Loader2 size={15} className="animate-spin inline" /> : saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function Toast({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[120] bg-[#2D1B0E] text-white text-sm px-4 py-2.5 rounded-lg shadow-lg">
      {children}
    </div>
  );
}

function kindLabel(k: string): string {
  return FSSAI_INSPECTION_KINDS.find((x) => x.key === k)?.label || k;
}

/** Their number, as given. A blank score is '' — NEVER '0'. */
function scoreText(r: { score: number | null; score_max: number | null }): string {
  if (r.score === null || r.score === undefined) return '';
  const s = String(r.score);
  return r.score_max === null || r.score_max === undefined ? s : `${s} / ${r.score_max}`;
}
