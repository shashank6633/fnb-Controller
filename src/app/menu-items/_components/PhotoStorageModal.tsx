'use client';

/**
 * PHOTO STORAGE — the admin's view of the dish-photo blob table, and the only
 * place in the app that can delete one.
 *
 * Deleting a photo cannot be undone: `menu_item_images` rows carry the bytes
 * themselves, and once a row is gone the guest menu shows a broken tile until
 * somebody re-uploads the picture. So nothing here happens implicitly. The
 * modal opens on a DRY RUN, shows the numbers, shows a THUMBNAIL OF EVERY PHOTO
 * IT PROPOSES TO DELETE — the cheapest possible way for a human to catch a
 * mistake the code cannot — and then asks twice.
 *
 * What the three numbers mean is the whole point of the screen:
 *   · IN USE          something in the database still points at it. Never
 *                     offered for deletion, whichever way the URL is spelled.
 *   · RECENTLY ADDED  unreferenced, but younger than the grace window. A photo
 *                     uploaded into a form that has not been saved yet looks
 *                     exactly like an orphan; the window is what protects it.
 *   · UNUSED          unreferenced AND past the window — the only rows that a
 *                     sweep can touch, listed individually below.
 *
 * The list is sent back to the server on confirm, so the sweep deletes exactly
 * the rows that were on screen; anything attached to an item in the meantime is
 * re-checked server-side and skipped.
 */

import { useCallback, useEffect, useState } from 'react';
import { HardDrive, Loader2, Trash2, X, AlertTriangle, CheckCircle } from 'lucide-react';
import { api } from '@/lib/api';

interface OrphanRow {
  id: string;
  size: number;
  created_at: string;
  created_by: string;
  item_id: string | null;
  age_days: number;
}
interface Report {
  grace_days: number;
  total: { count: number; bytes: number };
  in_use: { count: number; bytes: number };
  recent: { count: number; bytes: number };
  reclaimable: { count: number; bytes: number; rows: OrphanRow[] };
  scan: { columns_scanned: number; found_in: Record<string, number>; errors: string[] };
  safe_to_sweep: boolean;
}

/** Never round a real row down to "0 KB" — a size of zero reads as a bug. */
const mb = (b: number) => {
  const n = Math.max(0, Math.round(b) || 0);
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
};

export default function PhotoStorageModal({ onClose, onToast }: {
  onClose: () => void;
  onToast: (msg: string, error?: boolean) => void;
}) {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [armed, setArmed] = useState(false);   // second click arms the delete

  const load = useCallback(async () => {
    setLoading(true); setError(null); setArmed(false);
    try {
      const res = await api('/api/menu-items/image/orphans');
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setReport(j as Report);
      setSelected(new Set((j as Report).reclaimable.rows.map(r => r.id)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read photo storage.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const toggle = (id: string) => {
    setArmed(false);
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const sweep = async () => {
    if (!report || !selected.size) return;
    setBusy(true); setError(null);
    try {
      const res = await api('/api/menu-items/image/orphans', {
        method: 'POST',
        body: { confirm: true, ids: [...selected] },
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      const kept = (j.skipped || []).filter((s: { reason: string }) => s.reason === 'in_use').length;
      onToast(
        `Deleted ${j.deleted?.length || 0} photo${j.deleted?.length === 1 ? '' : 's'} · ${mb(j.bytes || 0)} reclaimed` +
        (kept ? ` · ${kept} kept — an item started using ${kept === 1 ? 'it' : 'them'} while this was open` : ''),
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sweep failed.');
    } finally {
      setBusy(false);
      setArmed(false);
    }
  };

  const selectedBytes = report
    ? report.reclaimable.rows.filter(r => selected.has(r.id)).reduce((s, r) => s + r.size, 0)
    : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
           className="relative w-full max-w-2xl bg-white border border-[#E8D5C4] rounded-2xl shadow-2xl flex flex-col overflow-hidden">

        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8D5C4] shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-[#af4408]/10"><HardDrive className="w-5 h-5 text-[#af4408]" /></div>
            <div>
              <h2 className="text-lg font-semibold text-[#2D1B0E]">Dish photo storage</h2>
              <p className="text-xs text-[#8B7355]">
                {report
                  ? `${report.total.count} photo${report.total.count === 1 ? '' : 's'} · ${mb(report.total.bytes)} inside the database backup`
                  : 'Reading…'}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[#FFF1E3]" aria-label="Close"><X className="w-5 h-5" /></button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
          {loading && (
            <p className="py-10 text-center text-sm text-[#8B7355]">
              <Loader2 className="w-5 h-5 animate-spin inline mr-2" />Checking every table for photos still in use…
            </p>
          )}

          {error && (
            <p className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />{error}
            </p>
          )}

          {report && !loading && (
            <>
              <div className="grid grid-cols-3 border border-[#E8D5C4] rounded-xl overflow-hidden">
                <Cell label="In use" count={report.in_use.count} bytes={report.in_use.bytes} tone="text-green-700" />
                <Cell label={`Added in ${report.grace_days} days`} count={report.recent.count} bytes={report.recent.bytes} tone="text-[#6B5744]" />
                <Cell label="Unused" count={report.reclaimable.count} bytes={report.reclaimable.bytes} tone="text-amber-600" last />
              </div>

              <p className="text-[11px] leading-relaxed text-[#8B7355] bg-[#FFF8F0] border border-[#F0E4D6] rounded-lg px-3 py-2">
                “In use” was decided by searching <strong>{report.scan.columns_scanned} text columns</strong> across the
                whole database, not just the menu. A photo counts as in use however its address is written —
                a full <code>http://…</code> link, a <code>?v=2</code> suffix, or stray spaces all point at the same
                picture. Photos added in the last {report.grace_days} days are never deleted, because a photo uploaded
                into a form nobody has saved yet has nothing pointing at it either.
              </p>

              {report.scan.errors.length > 0 && (
                <p className="flex items-start gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
                  Some tables could not be read, so nothing can be deleted safely right now:{' '}
                  {report.scan.errors.slice(0, 3).join('; ')}
                </p>
              )}

              {report.reclaimable.count === 0 ? (
                <p className="flex items-center gap-2 justify-center py-8 text-sm text-[#8B7355]">
                  <CheckCircle className="w-4 h-4 text-green-600" />
                  Nothing to clean up — every stored photo is either in use or too new to touch.
                </p>
              ) : (
                <>
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-[#6B5744] uppercase tracking-wide">
                      Unused for over {report.grace_days} days
                      {report.reclaimable.count > report.reclaimable.rows.length &&
                        ` — showing ${report.reclaimable.rows.length} of ${report.reclaimable.count}`}
                    </p>
                    <button
                      onClick={() => { setArmed(false); setSelected(selected.size ? new Set() : new Set(report.reclaimable.rows.map(r => r.id))); }}
                      className="text-[11px] text-[#af4408] hover:underline">
                      {selected.size ? 'Select none' : 'Select all'}
                    </button>
                  </div>

                  <div className="divide-y divide-[#F0E4D6] border border-[#E8D5C4] rounded-xl overflow-hidden">
                    {report.reclaimable.rows.map(r => (
                      <label key={r.id} className="flex items-center gap-3 px-3 py-2 bg-white hover:bg-[#FFFBF5] cursor-pointer">
                        <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)}
                               className="w-4 h-4 accent-[#af4408] shrink-0" />
                        {/* Look before you delete. The blob is served publicly by
                            id, so this is the actual picture that would go. */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={`/api/customer/menu-image/${r.id}`} alt="" width={40} height={40}
                             className="w-10 h-10 rounded-lg object-cover border border-[#E8D5C4] bg-[#FFF8F0] shrink-0" />
                        <div className="min-w-0 flex-1">
                          <p className="text-xs text-[#2D1B0E] truncate">
                            {mb(r.size)} · {r.age_days} day{r.age_days === 1 ? '' : 's'} old
                            {r.created_by ? ` · ${r.created_by}` : ''}
                          </p>
                          <p className="text-[10px] text-[#8B7355] truncate font-mono">{r.id}</p>
                        </div>
                      </label>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {report && !loading && report.reclaimable.count > 0 && (
          <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-[#E8D5C4] shrink-0 bg-[#FFFBF5]">
            <p className="text-[11px] text-[#8B7355] min-w-0">
              {armed
                ? <span className="text-red-700 font-medium">This permanently deletes the bytes. There is no undo.</span>
                : `${selected.size} selected · ${mb(selectedBytes)} would be reclaimed`}
            </p>
            <button
              onClick={() => { if (!armed) setArmed(true); else void sweep(); }}
              disabled={busy || !selected.size || !report.safe_to_sweep}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium text-white shrink-0 disabled:opacity-50 disabled:cursor-not-allowed ${
                armed ? 'bg-red-600 hover:bg-red-700' : 'bg-[#af4408] hover:bg-[#8a3506]'}`}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
              {armed ? `Yes, delete ${selected.size}` : `Delete ${selected.size} unused photo${selected.size === 1 ? '' : 's'}`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Cell({ label, count, bytes, tone, last }: {
  label: string; count: number; bytes: number; tone: string; last?: boolean;
}) {
  return (
    <div className={`px-3 py-3 text-center ${last ? '' : 'border-r border-[#F0E4D6]'}`}>
      <p className="text-[10px] text-[#8B7355] uppercase tracking-wide truncate">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${tone}`}>{count}</p>
      <p className="text-[10px] text-[#8B7355]">{mb(bytes)}</p>
    </div>
  );
}
