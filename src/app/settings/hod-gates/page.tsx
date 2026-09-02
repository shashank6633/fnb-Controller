'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import Toggle from '@/components/Toggle';
import { PAGE_CATALOG } from '@/lib/page-catalog';
import { Loader2, ShieldAlert, Info, Lock, AlertTriangle } from 'lucide-react';

/**
 * Settings → HOD-Only Gates (owner pick 9B, commissioned 2026-09-02).
 *
 * The owner's words: "In Settings Create me HOD only option Toggle on or Off
 * options Where are the Pages or Roles Access is hard fixed to HOD only where
 * in some places if i want to remove i can as a admin."
 *
 * One toggle per page whose page-catalog entry is CODED hodOnly. ON (default)
 * = the coded hard gate stands: only HODs (is_head_chef) and admins can open
 * the page, whatever their page_access map says. OFF = the gate is removed and
 * the page follows the normal page_access grant — exactly what the manual
 * page-catalog edit did for Kitchen Production on 2026-08-31, but from this
 * screen and reversible.
 *
 * mgmtOnly and adminOnly pages are listed read-only for context. Toggling
 * those is deliberately NOT built (out of scope by the owner's commission).
 *
 * THE TRUTH BOX BELOW IS THE POINT. A catalog flag gates the PAGE, never its
 * APIs — 2026-08-31 proved it on Kitchen Production: every
 * /api/kitchen-production/* handler checked identity but not authority, so the
 * hodOnly flag only hid the screen while the data paths stood open. The same
 * split cuts the other way here: five of the six hodOnly pages carry their own
 * HOD/admin checks inside the page and in their APIs, so switching a toggle
 * OFF opens navigation but those deeper locks still refuse a non-HOD. Each row
 * states exactly what remains, verified in the code the day this shipped.
 *
 * Server truth: GET/PUT /api/settings/hod-only (admin-only, validates that
 * only coded hodOnly paths are written, stores only gate-OFF entries). Every
 * reader fails CLOSED — a corrupt stored value makes the coded flags stand.
 */

type Me = { role?: string; is_head_chef?: boolean } | null | undefined;

/**
 * What ELSE gates each hodOnly page, verified in-repo 2026-09-02. If you add a
 * hodOnly page to the catalog, add its row here — an unlisted page shows a
 * neutral "check its page + APIs" note rather than a wrong promise.
 */
const DEEPER_LOCKS: Record<string, { residual: string; opens: boolean }> = {
  '/menu-engineering': {
    opens: false,
    residual:
      'The page ALSO checks HOD/admin inside itself (it will still show its own lock to others), and /api/menu-engineering refuses non-HOD with 403. Turning this off only removes the catalog-level block.',
  },
  '/kitchen-production/reports': {
    opens: true,
    residual:
      'The page has no check of its own, so it opens fully for anyone granted it — but /api/kitchen-production/reports still answers 403 "Head chef or admin only", so a non-HOD sees the page with no data. Widening the API is a separate decision.',
  },
  '/crm/analyst': {
    opens: false,
    residual:
      'The page ALSO checks HOD/admin inside itself, and /api/crm/analyst refuses non-HOD with 403. Turning this off only removes the catalog-level block.',
  },
  '/crm/digest': {
    opens: false,
    residual:
      'The page ALSO checks HOD/admin inside itself, and /api/crm/digest refuses non-HOD with 403. Turning this off only removes the catalog-level block.',
  },
  '/crm/quiz-links': {
    opens: false,
    residual:
      'The page ALSO checks HOD/admin inside itself, and /api/crm/quiz-links refuses non-HOD with 403. Turning this off only removes the catalog-level block.',
  },
  '/crm/settings': {
    opens: false,
    residual:
      'The page checks ADMIN-only inside itself (stricter than HOD), and its /api/crm/admin/* routes are admin-gated. This toggle cannot open it to anyone below admin.',
  },
};

export default function HodGatesPage() {
  const [me, setMe] = useState<Me>(undefined);
  const [overrides, setOverrides] = useState<Record<string, false>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/auth/me').then(r => r.json()).then(d => setMe(d?.user || null)).catch(() => setMe(null));
  }, []);

  const isAdmin = !!me && me.role === 'admin';

  useEffect(() => {
    if (!isAdmin) return;
    (async () => {
      try {
        const r = await fetch('/api/settings/hod-only', { credentials: 'same-origin' });
        if (!r.ok) throw new Error((await r.json())?.error || 'Failed to load');
        const d = await r.json();
        setOverrides(d?.overrides && typeof d.overrides === 'object' ? d.overrides : {});
      } catch (e: any) {
        setError(e?.message || 'Failed to load the current gate state');
      } finally {
        setLoading(false);
      }
    })();
  }, [isAdmin]);

  // Rows straight from the catalog — the same single source the proxy enforces.
  const { hodRows, mgmtRows, adminRows } = useMemo(() => {
    const hod: { path: string; label: string; section: string }[] = [];
    const mgmt: { path: string; label: string; section: string }[] = [];
    const adm: { path: string; label: string; section: string }[] = [];
    for (const s of PAGE_CATALOG) {
      for (const p of s.pages) {
        if (p.hodOnly) hod.push({ path: p.path, label: p.label, section: s.label });
        else if (p.adminOnly) adm.push({ path: p.path, label: p.label, section: s.label });
        else if (p.mgmtOnly) mgmt.push({ path: p.path, label: p.label, section: s.label });
      }
    }
    return { hodRows: hod, mgmtRows: mgmt, adminRows: adm };
  }, []);

  const setGate = async (path: string, enabled: boolean) => {
    setSaving(path);
    setError(null);
    // Optimistic flip; server response is authoritative and re-applied below.
    setOverrides(prev => {
      const next = { ...prev };
      if (enabled) delete next[path]; else next[path] = false;
      return next;
    });
    try {
      const r = await api('/api/settings/hod-only', { method: 'PUT', body: { path, enabled } });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || 'Save failed');
      setOverrides(d?.overrides && typeof d.overrides === 'object' ? d.overrides : {});
    } catch (e: any) {
      setError(e?.message || 'Save failed');
      // Re-sync from the server so the switch never lies about stored state.
      try {
        const r2 = await fetch('/api/settings/hod-only', { credentials: 'same-origin' });
        if (r2.ok) {
          const d2 = await r2.json();
          setOverrides(d2?.overrides && typeof d2.overrides === 'object' ? d2.overrides : {});
        }
      } catch { /* keep whatever we have; the coded flags stand server-side */ }
    } finally {
      setSaving(null);
    }
  };

  if (me === undefined) {
    return (
      <div className="p-8 text-center text-sm text-[#8B7355]">
        <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…
      </div>
    );
  }
  if (!isAdmin) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
          🔒 Admin only. HOD-only gate toggles decide who can open restricted pages.
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-4xl mx-auto">
      <div>
        <h1 className="text-xl font-semibold text-[#2D1B0E] flex items-center gap-2">
          <ShieldAlert className="w-5 h-5 text-[#af4408]" /> HOD-Only Gates
        </h1>
        <p className="text-sm text-[#6B5744] mt-1">
          Each toggle is one page whose access is hard-fixed to HODs (department heads) and admins
          in the page catalog. Switch a gate <b>off</b>{' '}and that page follows the normal
          Page&nbsp;Access grants instead — the same change made by hand for Kitchen Production on
          31&nbsp;Aug&nbsp;2026, now reversible from here.
        </p>
      </div>

      {/* The truth the owner learned the hard way. */}
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900 flex gap-3">
        <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
        <div>
          <b>These toggles gate the PAGE, not its APIs.</b>{' '}When Kitchen Production&apos;s HOD-only flag
          was removed (31 Aug 2026) it came out that the flag had only ever hidden the screen — the
          module&apos;s APIs never checked authority, so the data paths were open all along. The same
          split applies here in reverse: most pages below <i>also</i> enforce HOD/admin inside the page
          and in their APIs, and this screen does not touch those. Each row says exactly what a
          switched-off gate still leaves locked.
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">{error}</div>
      )}

      {/* HOD-only pages — the toggles */}
      <div className="bg-white border border-[#E8DFD3] rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-[#E8DFD3] bg-[#FBF7F0]">
          <div className="font-medium text-[#2D1B0E]">HOD-only pages</div>
          <div className="text-xs text-[#8B7355] mt-0.5">
            On = hard gate active (HODs &amp; admins only, as coded). Off = follows Page Access grants.
          </div>
        </div>
        {loading ? (
          <div className="p-6 text-center text-sm text-[#8B7355]">
            <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading gate state…
          </div>
        ) : (
          <ul className="divide-y divide-[#F0E9DE]">
            {hodRows.map(row => {
              const off = overrides[row.path] === false;
              const lock = DEEPER_LOCKS[row.path];
              return (
                <li key={row.path} className="px-4 py-3 flex items-start gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-[#2D1B0E]">
                      {row.label}
                      <span className="ml-2 text-xs font-normal text-[#8B7355]">{row.section} · {row.path}</span>
                    </div>
                    <div className={`text-xs mt-1 ${off ? 'text-[#af4408]' : 'text-[#8B7355]'}`}>
                      {off
                        ? 'Gate OFF — this page now follows the normal Page Access grants.'
                        : 'Gate ON — HODs and admins only, whatever Page Access says.'}
                    </div>
                    <div className="text-xs text-[#6B5744] mt-1 flex gap-1.5">
                      <Info className="w-3.5 h-3.5 shrink-0 mt-[1px]" />
                      <span>
                        {lock
                          ? lock.residual
                          : 'Unverified page — check its page.tsx and APIs for their own HOD checks before relying on this toggle alone.'}
                      </span>
                    </div>
                  </div>
                  <div className="pt-1">
                    {saving === row.path
                      ? <Loader2 className="w-5 h-5 animate-spin text-[#8B7355]" />
                      : <Toggle checked={!off} onChange={(next) => setGate(row.path, next)} label={`HOD gate for ${row.label}`} />}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Context: the tiers this screen deliberately does NOT touch */}
      <div className="grid sm:grid-cols-2 gap-4">
        <div className="bg-white border border-[#E8DFD3] rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-[#E8DFD3] bg-[#FBF7F0]">
            <div className="font-medium text-[#2D1B0E] flex items-center gap-1.5">
              <Lock className="w-4 h-4 text-[#8B7355]" /> Management-only pages
            </div>
            <div className="text-xs text-[#8B7355] mt-0.5">
              Admin, Managers and HODs. Read-only here — not toggleable.
            </div>
          </div>
          <ul className="divide-y divide-[#F0E9DE]">
            {mgmtRows.map(r => (
              <li key={r.path} className="px-4 py-2 text-xs text-[#6B5744]">
                <span className="text-[#2D1B0E]">{r.label}</span>
                <span className="ml-1.5 text-[#8B7355]">{r.path}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="bg-white border border-[#E8DFD3] rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-[#E8DFD3] bg-[#FBF7F0]">
            <div className="font-medium text-[#2D1B0E] flex items-center gap-1.5">
              <Lock className="w-4 h-4 text-[#8B7355]" /> Admin-only pages
            </div>
            <div className="text-xs text-[#8B7355] mt-0.5">
              Admins only, even with an explicit grant. Read-only here — not toggleable.
            </div>
          </div>
          <ul className="divide-y divide-[#F0E9DE]">
            {adminRows.map(r => (
              <li key={r.path} className="px-4 py-2 text-xs text-[#6B5744]">
                <span className="text-[#2D1B0E]">{r.label}</span>
                <span className="ml-1.5 text-[#8B7355]">{r.path}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <p className="text-xs text-[#8B7355]">
        Changes apply to page navigation within ~2 seconds (the access check caches briefly). A user&apos;s
        sidebar picks the change up on their next page load. If the stored state is ever unreadable,
        every gate falls back to <b>on</b>{' '}— the coded flag stands.
      </p>
    </div>
  );
}
