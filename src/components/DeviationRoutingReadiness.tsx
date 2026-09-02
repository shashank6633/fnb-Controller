'use client';

import React, { useEffect, useState } from 'react';
import { AlertTriangle, BellRing, CheckCircle2, ChevronDown, ChevronRight, Loader2, UserX } from 'lucide-react';

/**
 * "IF A DEVIATION HAPPENED RIGHT NOW, WHO WOULD ACTUALLY BE TOLD?"
 *
 * When a goods receipt comes in different from the approved PO, the app raises
 * an off-PO deviation alert to every admin plus the HOD of the department that
 * owns the item's category. Whether that second half reaches ANYBODY depends
 * entirely on configuration spread across three screens, and until this panel
 * existed the only way to find out was to cause a deviation and read the
 * silence afterwards — a silence the person who was NOT told cannot see.
 *
 * ── ONE FIELD DECIDES THE COLOUR, AND THE ROUTER OWNS IT ───────────────────
 * Every word below comes from GET /api/departments/alert-readiness, which runs
 * departmentAlertReadiness(). That function feeds one hypothetical deviating
 * line per live item category into resolveDeviationAudience() — the SAME
 * function a real receipt calls — and reports, per department, `reach`:
 *
 *     'department'  the run addressed a DEPARTMENT-SCOPE copy to a named person
 *     'admin-only'  a head resolved, but they read the wider admin copy instead
 *     'none'        nobody in that department is told on this rail
 *     'unknown'     THE PROBE ITSELF FAILED (`probe_error` is set) — nothing is
 *                   proven in either direction. Rendered as a broken/red error
 *                   state, never as covered and never as "no heads yet": the
 *                   probe used to swallow its own failures into the empty
 *                   audience, and this panel then printed the no-HOD remedy
 *                   sentence for every department while the truth was that the
 *                   check itself had crashed.
 *
 * `reach` IS THE ONLY THING THIS FILE MAY COLOUR ON. It must never go back to
 * `heads.length > 0`, which is what it used to do: MEASURED, three one-click
 * configuration states (archive the department; empty its category list; give
 * it a category no item carries) each leave a head resolved and named while a
 * real alert on that department's own category writes ZERO department rows. The
 * old tick was green in all three, printing a real person's name and email
 * beside a promise nothing kept. Heads are still rendered — a head configured
 * behind a blocker is exactly what an admin needs to see — but they are drawn
 * from `reach`, never the other way round.
 *
 * This component computes NOTHING about who is reachable. In particular it does
 * not read `head_user_id` or `head_chef_user_id` off the department rows the
 * page already loaded: those two columns are EMPTY on every department in the
 * live database, so a panel built on them would have shown "no head anywhere"
 * while the alert quietly routed to a real person through the Head Chef flag.
 * The alert resolves the flag as (user column OR the assigned role's column),
 * exactly as getCurrentUser() does — so somebody carrying it only through the
 * "Head Chef" ROLE is a real recipient, and only the resolver knows that.
 *
 * ── THE GATE ───────────────────────────────────────────────────────────────
 * ADMIN ONLY, enforced server-side (403) and mirrored here by the caller, which
 * renders this panel only when `me.role === 'admin'`. That is the same gate the
 * Departments page already puts on New / Edit / Save and the same one every
 * mutating route in /api/departments uses. The payload names people and their
 * email addresses alongside precisely how each is unreachable, and every remedy
 * it prints lands on an admin-only screen.
 */

type HeadVia = 'Department head' | 'HOD' | 'Head Chef flag';

/** Mirrors DeptReach in @/lib/po-deviation-alert. */
type DeptReach = 'department' | 'admin-only' | 'none' | 'unknown';

interface ReadinessHead { user_id: string; email: string; name: string; via: HeadVia }
interface DeptReadiness {
  department_id: string;
  department_name: string;
  is_active: boolean;
  categories: string[];
  categories_with_items: number;
  heads: ReadinessHead[];
  gap: string;
  blockers: string[];
  reach: DeptReach;
  verdict: string;
}
interface InvisibleHeadChef {
  user_id: string; email: string; name: string; is_active: boolean; reason: string; also_admin: boolean;
}
interface Recipient { user_id: string; email: string; name: string }
interface AlertReadiness {
  admins: Recipient[];
  admin_gaps: string[];
  departments: DeptReadiness[];
  unclaimed_categories: Array<{ category: string; material_count: number; claimed_by_inactive: string[] }>;
  contested_categories: Array<{ category: string; departments: string[] }>;
  invisible_head_chefs: InvisibleHeadChef[];
  errors: string[];
  /** Set ONLY when the probe itself failed; every reach is then 'unknown'. */
  probe_error?: string;
}

const VIA_HINT: Record<HeadVia, string> = {
  'Department head': 'Departments → "Department head"',
  'HOD': 'Departments → "HOD (Head of Department)"',
  'Head Chef flag': 'Settings → Users → Head Chef (own flag or their role\'s)',
};

export default function DeviationRoutingReadiness() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<AlertReadiness | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  // Loaded on first expand rather than on mount: this runs the full resolver,
  // and the page's primary job is the department list.
  useEffect(() => {
    if (!open || data || loading) return;
    setLoading(true);
    setErr('');
    fetch('/api/departments/alert-readiness')
      .then(async r => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j?.error || `Failed (${r.status})`);
        setData(j.readiness as AlertReadiness);
      })
      .catch(e => setErr(e?.message || 'Could not load routing readiness'))
      .finally(() => setLoading(false));
  }, [open, data, loading]);

  // COUNTED ON `reach`, NEVER ON `heads`. An older version counted a department
  // as covered whenever a head resolved, which is how an archived department
  // with a perfectly good head was summarised as "All departments covered".
  const dark = data ? data.departments.filter(d => d.reach === 'none').length : 0;
  const adminOnly = data ? data.departments.filter(d => d.reach === 'admin-only').length : 0;
  const invisible = data ? data.invisible_head_chefs.length : 0;
  // A FAILED PROBE IS ITS OWN STATE, louder than any of the above. When the
  // check itself crashed, every reach is 'unknown' and none of the counts mean
  // anything — the answer is not "0 dark", it is "nobody knows".
  const unknown = data ? data.departments.filter(d => d.reach === 'unknown').length : 0;
  const probeFailed = !!data && (!!data.probe_error || unknown > 0);
  // "Covered" is only claimed when EVERY department proved a department-scope
  // copy and nothing else is outstanding — a failed probe marks every
  // department 'unknown' and sets probe_error, so a failure can never read as
  // good news.
  const allCovered = !!data && data.departments.length > 0
    && dark === 0 && adminOnly === 0 && invisible === 0 && unknown === 0
    && !probeFailed && data.errors.length === 0;

  return (
    <div className="mb-4 bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-[#FFF8F0]"
      >
        {open ? <ChevronDown className="w-4 h-4 text-[#8B7355]" /> : <ChevronRight className="w-4 h-4 text-[#8B7355]" />}
        <BellRing className="w-4 h-4 text-[#af4408]" />
        <span className="font-semibold text-sm text-[#2D1B0E]">Off-PO deviation alerts — who would be told</span>
        {data && (
          <span className="ml-auto flex items-center gap-1.5 text-[10px]">
            {probeFailed && (
              <span className="px-2 py-0.5 rounded bg-red-100 text-red-700 font-semibold">
                readiness check FAILED — answer unknown
              </span>
            )}
            {dark > 0 && (
              <span className="px-2 py-0.5 rounded bg-red-100 text-red-700 font-semibold">
                {dark} department{dark === 1 ? ' reaches' : 's reach'} nobody
              </span>
            )}
            {adminOnly > 0 && (
              <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-800 font-semibold">
                {adminOnly} reach{adminOnly === 1 ? 'es' : ''} only the admin copy
              </span>
            )}
            {invisible > 0 && (
              <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-800 font-semibold">
                {invisible} unreachable head chef{invisible === 1 ? '' : 's'}
              </span>
            )}
            {allCovered && (
              <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 font-semibold">All departments covered</span>
            )}
          </span>
        )}
      </button>

      {open && (
        <div className="border-t border-[#E8D5C4] px-3 py-3 text-xs">
          <p className="text-[11px] text-[#6B5744] mb-3 leading-relaxed">
            Every line below is the answer the <em>real</em> alert gave: one hypothetical deviation per item
            category is put through the same routing code a goods receipt runs, and what you see is who it
            addressed. A green tick therefore means a copy was actually addressed to that department — not
            merely that somebody is listed as its head, which can be true while nothing reaches them.
            A department&apos;s HOD is found from <em>three</em>{' '}
            places, in this order: the department&apos;s &quot;Department head&quot;, its &quot;HOD&quot;, then anyone carrying the Head Chef flag
            — from their own account <em>or from their assigned role</em> — whose department rolls up to it.
            <span className="text-[#8B7355]"> Admin only. Nothing here sends anything.</span>
          </p>

          {loading && (
            <div className="py-6 text-center text-[#8B7355]">
              <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Resolving…
            </div>
          )}
          {err && (
            <div className="px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-red-700">{err}</div>
          )}

          {data && !loading && (
            <div className="space-y-4">
              {/* ── THE PROBE ITSELF FAILED — nothing below is proven ── */}
              {probeFailed && (
                <div className="px-3 py-2.5 rounded-lg bg-red-50 border-2 border-red-300 text-red-800">
                  <div className="font-bold flex items-center gap-1.5">
                    <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
                    The readiness check itself failed — everything below is UNKNOWN, not proven.
                  </div>
                  <div className="mt-1 leading-relaxed">
                    The probe could not run the routing code to completion, so no department here is proven
                    covered <em>or</em> uncovered — and nothing on this panel means &quot;no heads are
                    configured&quot;. Fix the error, reload, and only then read the checklist.
                  </div>
                  {data.probe_error && (
                    <div className="mt-1.5 px-2 py-1.5 rounded bg-white border border-red-200 font-mono text-[11px] break-all">
                      {data.probe_error}
                    </div>
                  )}
                </div>
              )}

              {/* ── ADMINS: the copy that goes out whatever the routing does ── */}
              <section>
                <h3 className="font-semibold text-[#2D1B0E] mb-1">Every deviation, regardless of department</h3>
                {data.admins.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {data.admins.map(a => (
                      <span key={a.user_id || a.email}
                            className="px-2 py-1 rounded bg-emerald-50 border border-emerald-200 text-emerald-900">
                        {a.name} <span className="text-emerald-700/70">{a.email}</span>
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-red-700">
                    No active admin can be resolved — a deviation alert would reach nobody at all.
                  </div>
                )}
                {data.admin_gaps.map((g, i) => (
                  <div key={i} className="mt-1.5 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-900">
                    {g}
                  </div>
                ))}
              </section>

              {/* ── PER MAIN DEPARTMENT ── */}
              <section>
                <h3 className="font-semibold text-[#2D1B0E] mb-1.5">By department</h3>
                <div className="space-y-2">
                  {data.departments.length === 0 && (
                    <div className="text-[#8B7355] italic">No main departments exist, so no deviation can route to a HOD.</div>
                  )}
                  {data.departments.map(d => {
                    // THE COLOUR COMES FROM `reach` AND NOTHING ELSE. Green
                    // means the router addressed a department-scope copy on this
                    // very database; it is not inferred from a head existing.
                    const green = d.reach === 'department';
                    const amber = d.reach === 'admin-only';
                    // 'unknown' = the check crashed. Red like 'none' — it must
                    // never look calmer than a proven gap — but worded as a
                    // failure, because "nobody would be told" is a claim this
                    // run did not earn.
                    const unknownCard = d.reach === 'unknown';
                    const shell = green ? 'border-[#E8D5C4] bg-[#FFF8F0]'
                      : amber ? 'border-amber-200 bg-amber-50'
                      : unknownCard ? 'border-red-300 bg-red-50'
                      : 'border-red-200 bg-red-50';
                    return (
                      <div key={d.department_id} className={`rounded-lg border px-3 py-2 ${shell}`}>
                        <div className="flex items-center gap-2 flex-wrap">
                          {green
                            ? <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                            : <AlertTriangle className={`w-4 h-4 shrink-0 ${amber ? 'text-amber-600' : 'text-red-600'}`} />}
                          <span className="font-semibold text-[#2D1B0E]">{d.department_name}</span>
                          {!d.is_active && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#E8D5C4] text-[#6B5744]">Archived</span>
                          )}
                          <span className="text-[10px] text-[#8B7355]">
                            {d.categories.length} categor{d.categories.length === 1 ? 'y' : 'ies'}
                            {d.categories.length > 0 && d.categories_with_items < d.categories.length &&
                              ` · ${d.categories_with_items} with items`}
                          </span>
                        </div>

                        {/* The router's own sentence, on every card, whatever the
                            colour — so the screen and the alert body agree word
                            for word instead of only agreeing when things work. */}
                        <div className={`mt-1.5 ${green ? 'text-[#4A3728]' : amber ? 'text-amber-900' : 'text-red-800'}`}>
                          {!green && (
                            <span className="font-semibold">
                              {amber ? 'No department copy is written. '
                                : unknownCard ? 'UNKNOWN — the readiness check itself failed. '
                                : 'Nobody in this department would be told. '}
                            </span>
                          )}
                          {d.verdict}
                        </div>

                        {d.heads.length > 0 && (
                          <div className="mt-1.5">
                            {!green && (
                              <div className="text-[10px] uppercase tracking-wide text-[#8B7355] mb-1">
                                {amber
                                  ? 'Resolved head — reads the admin copy'
                                  : unknownCard
                                  ? 'Configured head — UNVERIFIED: the check failed before proving anything'
                                  : 'A head IS configured here, and it still changes nothing'}
                              </div>
                            )}
                            <div className="flex flex-wrap gap-1.5">
                              {d.heads.map(h => (
                                <span key={h.user_id}
                                      title={`Resolved from: ${VIA_HINT[h.via]}`}
                                      className={`px-2 py-1 rounded bg-white border ${green ? 'border-[#D4B896]' : 'border-[#E8D5C4] opacity-80'}`}>
                                  <span className="text-[#2D1B0E] font-medium">{h.name}</span>{' '}
                                  <span className="text-[#8B7355]">{h.email}</span>{' '}
                                  <span className="text-[10px] uppercase tracking-wide text-[#af4408]">via {h.via}</span>
                                </span>
                              ))}
                            </div>
                          </div>
                        )}

                        {d.blockers.map((b, i) => (
                          <div key={i} className="mt-1.5 px-2 py-1.5 rounded bg-amber-50 border border-amber-200 text-amber-900">
                            {b}
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </section>

              {/* ── THE GAP THE ALERT ITSELF CAN NEVER REPORT ── */}
              {data.invisible_head_chefs.length > 0 && (
                <section>
                  <h3 className="font-semibold text-[#2D1B0E] mb-1 flex items-center gap-1.5">
                    <UserX className="w-4 h-4 text-amber-700" />
                    Head chefs the alert cannot reach
                  </h3>
                  <p className="text-[11px] text-[#6B5744] mb-1.5">
                    These people carry the Head Chef flag, so they are HODs everywhere else in the app — but
                    deviation routing cannot place them in a department, so they are never told and no alert
                    can say so. This is the only screen that shows it.
                  </p>
                  <div className="space-y-1.5">
                    {data.invisible_head_chefs.map(u => (
                      <div key={u.user_id}
                           className="px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-900">
                        <span className="font-medium">{u.name}</span>{' '}
                        <span className="text-amber-800/70">{u.email || 'no email'}</span>
                        {!u.is_active && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-amber-200">deactivated</span>}
                        {u.also_admin && (
                          <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800">
                            also an admin
                          </span>
                        )}
                        <div className="mt-0.5">{u.reason}</div>
                        {u.also_admin && (
                          <div className="mt-0.5 text-amber-800/80">
                            They still receive the admin copy of every deviation, so nothing is missed today —
                            but the department wiring is wrong, and the next person put in this state without
                            admin rights would be silently dark.
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* ── CATEGORY-SIDE HOLES ── */}
              {data.unclaimed_categories.length > 0 && (
                <section>
                  <h3 className="font-semibold text-[#2D1B0E] mb-1">Item categories no department owns</h3>
                  <p className="text-[11px] text-[#6B5744] mb-1.5">
                    A deviation on one of these reaches the admins and no HOD, because no active department&apos;s
                    category list claims it.
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {data.unclaimed_categories.map(c => (
                      <span key={c.category}
                            className="px-2 py-1 rounded bg-amber-50 border border-amber-200 text-amber-900">
                        <span className="font-mono">{c.category || '(no category)'}</span>{' '}
                        <span className="text-amber-800/70">{c.material_count} item{c.material_count === 1 ? '' : 's'}</span>
                        {c.claimed_by_inactive.length > 0 && (
                          <span className="text-amber-800/70"> — claimed only by archived {c.claimed_by_inactive.join(' / ')}</span>
                        )}
                      </span>
                    ))}
                  </div>
                </section>
              )}

              {data.contested_categories.length > 0 && (
                <section>
                  <h3 className="font-semibold text-[#2D1B0E] mb-1">Categories two departments both claim</h3>
                  <p className="text-[11px] text-[#6B5744] mb-1.5">
                    Every claimant is told — picking one would leave the true owner in the dark — but the
                    overlap is a configuration mistake. Remove it from one list on Settings → Departments.
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {data.contested_categories.map(c => (
                      <span key={c.category}
                            className="px-2 py-1 rounded bg-amber-50 border border-amber-200 text-amber-900">
                        <span className="font-mono">{c.category}</span> — {c.departments.join(' and ')}
                      </span>
                    ))}
                  </div>
                </section>
              )}

              {data.errors.map((e, i) => (
                <div key={i} className="px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-red-700">
                  {e} — this list is incomplete.
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
