'use client';

/**
 * Admin → Page Access · Impact Preview — READ-ONLY. CHANGES NOTHING.
 *
 * Reads GET /api/admin/page-access-impact and answers one question at a glance:
 * if we close the prefix-match leak in canAccessPage(), WHO LOSES WHAT?
 *
 * WHY THIS PAGE EXISTS
 * A grant is matched by URL prefix today, and many catalog parents are also the
 * prefix of their sibling pages (/tasks is the Task Dashboard *and* the prefix
 * of the 14 other Task Management pages). So ticking a parent silently hands
 * over the whole module. Closing that hole TIGHTENS access — anyone configured
 * while the leak was live may have been given a parent instead of the pages
 * actually intended, and flipping it cold would strip pages from staff
 * mid-service. The owner tops up the missing grants FIRST, using this list, and
 * only then do we switch.
 *
 * NOTHING IS ENFORCED FROM HERE. canAccessPage() is unchanged and still the sole
 * authority; the strict matcher this compares against is called by the report
 * API and nowhere else. Opening this page cannot change anybody's access.
 *
 * Admin-only: catalog entry is adminOnly, and the API re-checks with
 * requireRole('admin') — this client guard is courtesy, not the lock.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Shield, AlertTriangle, Loader2, ChevronDown, ChevronRight,
  Users as UsersIcon, Copy, Check, RefreshCw, Search, X, Info,
} from 'lucide-react';

interface LostPage { path: string; label: string; section: string; via: string | null }
interface Diff {
  effective_map_source: 'user' | 'role' | 'none';
  full_access: boolean;
  full_access_reason: string | null;
  granted: number;
  now: number;
  strict: number;
  lost: LostPage[];
}
interface RoleRow extends Diff {
  id: string; name: string; base_role: string;
  is_active: boolean; is_head_chef: boolean; active_users_assigned: number;
}
interface UserRow extends Diff {
  id: string; name: string; email: string; effective_role: string;
  is_head_chef: boolean; role_id: string | null; role_name: string | null;
  role_is_active: boolean | null;
}
interface ParentRow {
  path: string; label: string; section: string; carries: number;
  children: { path: string; label: string; section: string }[];
}
interface Resp {
  generated_at: string;
  enforced: boolean;
  note: string;
  catalog_total: number;
  parents: ParentRow[];
  parents_total_grants: number;
  users: UserRow[];
  roles: RoleRow[];
  totals: {
    users_scanned: number; users_full_access: number; users_affected: number; user_pages_lost: number;
    roles_scanned: number; roles_full_access: number; roles_affected: number; role_pages_lost: number;
  };
}

const TIER_LABEL: Record<string, string> = { admin: 'Admin', manager: 'Manager', staff: 'Staff' };

/** Lost pages grouped by catalog section. The API emits `lost` in catalog order,
 *  so grouping in encounter order keeps the section order the owner is used to. */
function groupBySection(lost: LostPage[]): { section: string; pages: LostPage[] }[] {
  const out: { section: string; pages: LostPage[] }[] = [];
  for (const p of lost) {
    const key = p.section || 'Uncategorised';
    const last = out[out.length - 1];
    if (last && last.section === key) last.pages.push(p);
    else {
      const existing = out.find(g => g.section === key);
      if (existing) existing.pages.push(p);
      else out.push({ section: key, pages: [p] });
    }
  }
  return out;
}

function Pill({ tone, children, title }: { tone: 'amber' | 'red' | 'emerald' | 'slate' | 'blue'; children: React.ReactNode; title?: string }) {
  const tones = {
    amber:   'bg-amber-100 text-amber-800 border-amber-200',
    red:     'bg-red-100 text-red-700 border-red-200',
    emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    slate:   'bg-[#F3E2D0] text-[#6B5744] border-[#E8D5C4]',
    blue:    'bg-blue-50 text-blue-700 border-blue-200',
  } as const;
  return (
    <span title={title} className={`text-[9px] px-1.5 py-0.5 rounded-full border font-semibold whitespace-nowrap ${tones[tone]}`}>
      {children}
    </span>
  );
}

/** Copy the lost paths so the owner can paste them into a top-up list. */
function CopyPaths({ paths }: { paths: string[] }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={async e => {
        e.stopPropagation();
        try { await navigator.clipboard.writeText(paths.join('\n')); setDone(true); setTimeout(() => setDone(false), 1800); } catch { /* clipboard blocked — no fallback needed, paths are on screen */ }
      }}
      title="Copy the lost page paths to the clipboard"
      className="text-[10px] text-[#af4408] hover:underline inline-flex items-center gap-1"
    >
      {done ? <><Check size={11} /> Copied</> : <><Copy size={11} /> Copy paths</>}
    </button>
  );
}

/** One expandable subject card — used for both roles and users. */
function SubjectCard({
  title, subtitle, badges, diff, followers, defaultOpen,
}: {
  title: string;
  subtitle: string;
  badges: React.ReactNode;
  diff: Diff;
  followers?: string[];
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const groups = useMemo(() => groupBySection(diff.lost), [diff.lost]);
  const lost = diff.lost.length;

  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
      <div
        role="button" tabIndex={0} aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(o => !o); } }}
        className="px-4 py-3 flex items-center gap-3 flex-wrap cursor-pointer hover:bg-[#FFF8F0]"
      >
        {open ? <ChevronDown size={15} className="text-[#6B5744] shrink-0" /> : <ChevronRight size={15} className="text-[#6B5744] shrink-0" />}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-[#2D1B0E] flex items-center gap-2 flex-wrap">
            <span className="truncate">{title}</span>
            {badges}
          </div>
          <div className="text-[10px] text-[#8B7355] truncate">{subtitle}</div>
        </div>
        <div className="text-[10px] text-[#8B7355] whitespace-nowrap text-right">
          <div><b className="text-[#2D1B0E]">{diff.granted}</b> ticked</div>
          <div>{diff.now} reachable → {diff.strict}</div>
        </div>
        <div className={`text-center px-2.5 py-1 rounded-lg border ${lost > 0 ? 'bg-red-50 border-red-200' : 'bg-emerald-50 border-emerald-200'}`}>
          <div className={`text-base font-bold leading-none ${lost > 0 ? 'text-red-700' : 'text-emerald-700'}`}>{lost}</div>
          <div className={`text-[9px] ${lost > 0 ? 'text-red-700' : 'text-emerald-700'}`}>lose</div>
        </div>
      </div>

      {open && (
        <div className="border-t border-[#E8D5C4] bg-[#FFF8F0]">
          {followers && followers.length > 0 && (
            <div className="px-4 py-2 text-[10px] text-[#6B5744] border-b border-[#E8D5C4]/60 flex items-start gap-1.5">
              <UsersIcon size={12} className="mt-0.5 shrink-0 text-[#8B7355]" />
              <span>
                <b>Affects {followers.length} active user{followers.length === 1 ? '' : 's'} following this role:</b>{' '}
                {followers.join(', ')}
              </span>
            </div>
          )}
          {lost === 0 ? (
            <div className="px-4 py-3 text-[11px] text-emerald-800">
              Loses nothing — every page reachable today is explicitly ticked. No top-up needed.
            </div>
          ) : (
            <div className="px-4 py-3 space-y-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <p className="text-[11px] text-[#6B5744]">
                  These <b>{lost}</b> page{lost === 1 ? '' : 's'} are reachable today <i>only</i> through a parent grant.
                  Tick them explicitly before the fix ships, or they disappear.
                </p>
                <CopyPaths paths={diff.lost.map(p => p.path)} />
              </div>
              {groups.map(g => (
                <div key={g.section}>
                  <div className="text-[10px] font-semibold text-[#8B7355] uppercase tracking-wide mb-1">{g.section}</div>
                  <div className="grid gap-1 sm:grid-cols-2">
                    {g.pages.map(p => (
                      <div key={p.path} className="bg-white border border-[#E8D5C4] rounded px-2 py-1.5 min-w-0">
                        <div className="text-[11px] text-[#2D1B0E] truncate">{p.label}</div>
                        <div className="text-[9px] font-mono text-[#8B7355] truncate">{p.path}</div>
                        <div className="text-[9px] text-[#a8632b] truncate">
                          carried today by <span className="font-mono">{p.via ?? '—'}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function PageAccessImpactPage() {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [showMechanism, setShowMechanism] = useState(false);

  // Fetch first, THEN touch state — nothing here runs synchronously inside the
  // effect body, so the initial load never triggers a cascading render.
  // `loading` already starts true, so only the Refresh button has to set it.
  const fetchReport = async () => {
    try {
      const r = await fetch('/api/admin/page-access-impact');
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setData(j as Resp);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void fetchReport(); }, []);
  const refresh = () => { setLoading(true); setError(''); void fetchReport(); };

  const q = query.trim().toLowerCase();
  const matches = (name: string, extra: string, lost: LostPage[]) =>
    !q || name.toLowerCase().includes(q) || extra.toLowerCase().includes(q)
      || lost.some(p => p.label.toLowerCase().includes(q) || p.path.toLowerCase().includes(q));

  const byLost = <T extends Diff & { name: string }>(a: T, b: T) =>
    b.lost.length - a.lost.length || a.name.localeCompare(b.name);

  const roles = useMemo(() => data?.roles ?? [], [data]);
  const users = useMemo(() => data?.users ?? [], [data]);

  // Users who follow a role (no personal override) — named inside the role card,
  // because that is the row the owner edits to fix the whole group at once.
  const followersByRole = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const u of users) {
      if (!u.role_id || u.effective_map_source === 'user') continue;
      const list = m.get(u.role_id) ?? [];
      list.push(u.name || u.email);
      m.set(u.role_id, list);
    }
    return m;
  }, [users]);

  const rolesAffected   = roles.filter(r => !r.full_access && r.lost.length > 0).sort(byLost);
  const rolesUnchanged  = roles.filter(r => !r.full_access && r.lost.length === 0);
  const rolesFull       = roles.filter(r => r.full_access);
  // Per-USER section = personal overrides, PLUS any role-follower whose losses
  // their role's card does not already describe.
  //
  // "Follows a role ⇒ covered by the role's card" is NOT safe, and assuming it
  // silently hid real losses. Tier does come from the role, but is_head_chef is
  // the UNION of the user's own flag and the role's (see getCurrentUser in
  // lib/auth.ts). An HOD following a non-HOD role therefore reaches hodOnly and
  // mgmtOnly pages the role itself cannot — so they lose pages the role loses
  // nothing of, and if the role's own loss is zero its card is not even
  // rendered. Their extra pages appeared NOWHERE on this screen, which is the
  // one failure a pre-tightening report must not have: top up nothing, ship the
  // fix, an HOD loses six reports mid-service.
  //
  // So compare the actual sets. A follower is only "covered" when every page
  // they lose is already listed on their role's card.
  const roleLostPaths = new Map(roles.map(r => [r.id, new Set(r.lost.map(p => p.path))]));
  const coveredByRole = (u: UserRow) => {
    const rl = u.role_id ? roleLostPaths.get(u.role_id) : undefined;
    return !!rl && u.lost.every(p => rl.has(p.path));
  };
  const overrideUsers   = users.filter(u => u.effective_map_source === 'user');
  const roleFollowers   = users.filter(u => u.effective_map_source !== 'user' && !u.full_access && u.lost.length > 0);
  const roleFollowersCovered = roleFollowers.filter(coveredByRole);
  const roleFollowersExtra   = roleFollowers.filter(u => !coveredByRole(u));
  const usersAffected   = [...overrideUsers.filter(u => !u.full_access && u.lost.length > 0), ...roleFollowersExtra].sort(byLost);
  const usersUnchanged  = overrideUsers.filter(u => !u.full_access && u.lost.length === 0);
  const usersFull       = users.filter(u => u.full_access);
  const roleFollowersAffected = roleFollowersCovered;

  const tierBadge = (tier: string, isHod: boolean) => (
    <>
      <Pill tone="slate">{TIER_LABEL[tier] || tier}</Pill>
      {isHod && <Pill tone="blue" title="Head of department — HOD-only pages are open to them">HOD</Pill>}
    </>
  );

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center gap-3 flex-wrap">
        <Shield className="text-[#af4408]" size={24} />
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-semibold text-[#2D1B0E]">Page Access — Impact Preview</h1>
          <p className="text-xs text-[#8B7355]">
            What each role and each user would <b>lose</b> if we stop letting a parent page carry its siblings.
            Read-only: this page changes nothing and grants nothing.
          </p>
        </div>
        <button onClick={refresh} disabled={loading}
                className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded border border-[#E8D5C4] bg-white text-[#6B5744] hover:bg-[#FFF8F0] disabled:opacity-50">
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Refresh
        </button>
      </div>

      {/* The one thing nobody may misread. */}
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900 flex items-start gap-2">
        <AlertTriangle size={15} className="shrink-0 mt-0.5" />
        <div>
          <b>Nothing has changed yet — this is a preview.</b> Access is still enforced exactly as it is today, and
          nobody has lost a page. The list below is a simulation of what <i>would</i> happen if the tightening ships.
          Use it to tick the grants that should have been there all along, on{' '}
          <a href="/settings/roles" className="underline">Settings → Roles</a> and{' '}
          <a href="/settings/page-access" className="underline">Settings → Page Access</a>. The fix ships only after
          you say the top-ups are done.
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded p-2 text-xs flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError('')}><X size={12} /></button>
        </div>
      )}

      {loading ? (
        <div className="p-10 text-center text-sm text-[#8B7355]"><Loader2 className="animate-spin inline mr-1" size={14} />Loading…</div>
      ) : !data ? null : (
        <>
          {/* ── The mechanism, in the owner's own numbers ─────────────────── */}
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 space-y-2">
            <div className="text-sm font-semibold text-[#2D1B0E] flex items-center gap-2">
              <Info size={15} className="text-[#af4408]" /> Why anyone loses anything
            </div>
            <p className="text-xs text-[#6B5744] leading-relaxed">
              A grant is matched by <b>URL prefix</b> today. That is deliberate for detail routes — someone granted{' '}
              <span className="font-mono text-[11px]">/vendors</span> must still be able to open{' '}
              <span className="font-mono text-[11px]">/vendors/123</span>. But{' '}
              <b>{data.parents.length} pages in the catalog are also the prefix of other, separate pages</b>, and those{' '}
              <b>{data.parents_total_grants} pages</b> are handed over for free. Ticking{' '}
              {data.parents[0] && (
                <>
                  <span className="font-mono text-[11px]">{data.parents[0].path}</span> alone, for example, also grants{' '}
                  <b>{data.parents[0].carries} more pages</b>
                </>
              )}
              . Every page-access check in the app — sidebar and server-side route enforcement alike — goes through
              that same rule, so this is real reach, not just a sidebar that shows too much.
              The catalog holds {data.catalog_total} pages in total.
            </p>
            <button onClick={() => setShowMechanism(s => !s)} className="text-[11px] text-[#af4408] hover:underline inline-flex items-center gap-1">
              {showMechanism ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              {showMechanism ? 'Hide' : 'Show'} the {data.parents.length} parent pages and what each one carries
            </button>
            {showMechanism && (
              <div className="grid gap-2 md:grid-cols-2 pt-1">
                {data.parents.map(p => (
                  <div key={p.path} className="border border-[#E8D5C4] rounded-lg p-2.5 bg-[#FFF8F0]">
                    <div className="text-[11px] font-semibold text-[#2D1B0E] flex items-center gap-2 flex-wrap">
                      {p.label} <span className="font-mono text-[9px] text-[#8B7355]">{p.path}</span>
                      <Pill tone="amber">+{p.carries}</Pill>
                    </div>
                    <div className="text-[10px] text-[#6B5744] mt-1 leading-snug">
                      {p.children.map(c => c.label).join(' · ')}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Headline counts ───────────────────────────────────────────── */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { n: data.totals.roles_affected, of: data.totals.roles_scanned, label: 'roles lose pages', sub: `${data.totals.role_pages_lost} page-grants across them` },
              { n: data.totals.users_affected, of: data.totals.users_scanned, label: 'active users lose pages', sub: `${data.totals.user_pages_lost} page-grants across them` },
              { n: data.totals.roles_full_access, of: data.totals.roles_scanned, label: 'roles unrestricted', sub: 'full access by design — unaffected' },
              { n: data.totals.users_full_access, of: data.totals.users_scanned, label: 'users unrestricted', sub: 'full access by design — unaffected' },
            ].map(c => (
              <div key={c.label} className="bg-white border border-[#E8D5C4] rounded-xl p-3">
                <div className="text-2xl font-bold text-[#2D1B0E] leading-none">
                  {c.n}<span className="text-sm font-normal text-[#8B7355]"> / {c.of}</span>
                </div>
                <div className="text-[11px] text-[#2D1B0E] mt-1">{c.label}</div>
                <div className="text-[10px] text-[#8B7355]">{c.sub}</div>
              </div>
            ))}
          </div>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8B7355]" size={16} />
            <input value={query} onChange={e => setQuery(e.target.value)}
                   placeholder="Filter by role, employee, or a page they would lose…"
                   className="w-full pl-10 pr-3 py-2.5 bg-white border border-[#E8D5C4] rounded-lg text-sm focus:outline-none focus:border-[#af4408]" />
          </div>

          {/* ── ROLES ─────────────────────────────────────────────────────── */}
          <section className="space-y-2">
            <div className="flex items-baseline gap-2 flex-wrap">
              <h2 className="text-sm font-semibold text-[#2D1B0E]">Roles — fix these first</h2>
              <span className="text-[11px] text-[#8B7355]">
                Most staff inherit their pages from a role, so topping up the role fixes everyone on it at once.
                Sorted by most affected.
              </span>
            </div>

            {rolesAffected.filter(r => matches(r.name, r.base_role, r.lost)).map(r => (
              <SubjectCard
                key={r.id}
                title={r.name}
                subtitle={`${r.active_users_assigned} active user${r.active_users_assigned === 1 ? '' : 's'} assigned · reaches ${r.now} of ${data.catalog_total} pages today`}
                badges={<>
                  {tierBadge(r.base_role, r.is_head_chef)}
                  {!r.is_active && <Pill tone="amber" title="Deactivated roles still govern the users assigned to them — they are deliberately not filtered out">Deactivated (still governs)</Pill>}
                </>}
                diff={r}
                followers={followersByRole.get(r.id)}
                defaultOpen={rolesAffected.length <= 3}
              />
            ))}
            {rolesAffected.length === 0 && (
              <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 text-center text-sm text-emerald-800">
                No role loses a page. Every role&apos;s reach today is exactly what is ticked on it.
              </div>
            )}

            {rolesUnchanged.length > 0 && (
              <details className="bg-white border border-[#E8D5C4] rounded-xl">
                <summary className="px-4 py-2.5 text-xs text-[#6B5744] cursor-pointer select-none">
                  <b>{rolesUnchanged.length} restricted role{rolesUnchanged.length === 1 ? '' : 's'} lose nothing</b>
                  {' '}— everything they reach is explicitly ticked
                </summary>
                <div className="px-4 pb-3 text-[11px] text-[#6B5744]">
                  {rolesUnchanged.map(r => `${r.name} (${r.granted} pages)`).join(' · ')}
                </div>
              </details>
            )}

            {rolesFull.length > 0 && (
              <details className="bg-white border border-[#E8D5C4] rounded-xl">
                <summary className="px-4 py-2.5 text-xs text-[#6B5744] cursor-pointer select-none">
                  <b>{rolesFull.length} unrestricted role{rolesFull.length === 1 ? '' : 's'}</b>
                  {' '}— full access by design, so the fix cannot take anything from them
                </summary>
                <div className="px-4 pb-3 space-y-1">
                  <p className="text-[11px] text-[#8B7355]">
                    A role with no page map (or an empty one) grants every page on purpose — that is the
                    backward-compat / “follow role” default, not a mistake this fix touches. Listed here so nobody is
                    silently missing from the report.
                  </p>
                  {rolesFull.map(r => (
                    <div key={r.id} className="text-[11px] text-[#6B5744]">
                      <b className="text-[#2D1B0E]">{r.name}</b> ({TIER_LABEL[r.base_role] || r.base_role}
                      {r.is_active ? '' : ', deactivated'}) — {r.full_access_reason}
                    </div>
                  ))}
                </div>
              </details>
            )}
          </section>

          {/* ── USERS ─────────────────────────────────────────────────────── */}
          <section className="space-y-2">
            <div className="flex items-baseline gap-2 flex-wrap">
              <h2 className="text-sm font-semibold text-[#2D1B0E]">Users needing their own top-up</h2>
              <span className="text-[11px] text-[#8B7355]">
                Fixing a role will <b>not</b> reach these people — top them up one by one on
                Settings → Page Access. Either their personal map beats the role, or they are an
                HOD on a non-HOD role and so lose pages the role itself never had.
              </span>
            </div>

            {usersAffected.filter(u => matches(u.name || u.email, `${u.email} ${u.role_name ?? ''}`, u.lost)).map(u => (
              <SubjectCard
                key={u.id}
                title={u.name || u.email}
                subtitle={`${u.email}${u.role_name ? ` · role: ${u.role_name}${u.role_is_active === false ? ' (deactivated)' : ''}` : ' · no role'} · reaches ${u.now} of ${data.catalog_total} pages today`}
                badges={<>
                  {tierBadge(u.effective_role, u.is_head_chef)}
                  {u.effective_map_source === 'user'
                    ? <Pill tone="amber" title="Their own page map wins over their role's — editing the role changes nothing for them">Personal override</Pill>
                    : <Pill tone="blue" title="They follow this role's page map, but their HOD flag opens pages the role cannot reach — so they lose more than the role's card lists">Loses more than their role</Pill>}
                </>}
                diff={u}
                defaultOpen={usersAffected.length <= 3}
              />
            ))}
            {usersAffected.length === 0 && (
              <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 text-center text-sm text-emerald-800">
                No user needs a top-up of their own — every affected person is covered by their role above.
              </div>
            )}

            {roleFollowersAffected.length > 0 && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-[11px] text-blue-900 flex items-start gap-2">
                <UsersIcon size={14} className="shrink-0 mt-0.5" />
                <span>
                  A further <b>{roleFollowersAffected.length} active user{roleFollowersAffected.length === 1 ? '' : 's'}</b> would
                  lose pages, but they follow a role and are <b>already counted in the role section above</b> — each is
                  named inside their role&apos;s card. Fix the role and they are all fixed.
                </span>
              </div>
            )}

            {usersUnchanged.length > 0 && (
              <details className="bg-white border border-[#E8D5C4] rounded-xl">
                <summary className="px-4 py-2.5 text-xs text-[#6B5744] cursor-pointer select-none">
                  <b>{usersUnchanged.length} override user{usersUnchanged.length === 1 ? '' : 's'} lose nothing</b>
                  {' '}— everything they reach is explicitly ticked
                </summary>
                <div className="px-4 pb-3 text-[11px] text-[#6B5744]">
                  {usersUnchanged.map(u => `${u.name || u.email} (${u.granted} pages)`).join(' · ')}
                </div>
              </details>
            )}

            {usersFull.length > 0 && (
              <details className="bg-white border border-[#E8D5C4] rounded-xl">
                <summary className="px-4 py-2.5 text-xs text-[#6B5744] cursor-pointer select-none">
                  <b>{usersFull.length} unrestricted user{usersFull.length === 1 ? '' : 's'}</b>
                  {' '}— full access by design, so the fix cannot take anything from them
                </summary>
                <div className="px-4 pb-3 space-y-1">
                  <p className="text-[11px] text-[#8B7355]">
                    Admins, and anyone whose effective page map is blank or empty, already reach everything their tier
                    allows. The fix only narrows a <i>list</i> of granted pages, and these subjects have no such list —
                    so they lose nothing. They are listed rather than dropped so no name is silently missing.
                  </p>
                  {usersFull.map(u => (
                    <div key={u.id} className="text-[11px] text-[#6B5744]">
                      <b className="text-[#2D1B0E]">{u.name || u.email}</b> ({TIER_LABEL[u.effective_role] || u.effective_role}
                      {u.role_name ? `, role: ${u.role_name}` : ', no role'}) — {u.full_access_reason}
                    </div>
                  ))}
                </div>
              </details>
            )}
          </section>

          <p className="text-[10px] text-[#8B7355] pt-1">
            Generated {new Date(data.generated_at).toLocaleString()} · enforcement: {String(data.enforced)} · {data.note}
          </p>
        </>
      )}
    </div>
  );
}
