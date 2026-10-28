'use client';

/**
 * MANAGE AREAS — admin panel on Settings → Departments (owner ruling #82).
 *
 * Add an area, rename it, switch it off, delete it while no department uses
 * it. Every action goes to /api/departments/areas, which re-checks admin and
 * refuses a delete while any department (archived ones included) still uses
 * the area — the disabled Delete button here is a mirror of that, not the gate.
 */

import React, { useState } from 'react';
import { Layers, Plus, Pencil, Trash2, Save, X, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import Toggle from '@/components/Toggle';

export interface AreaDeptRef { id: string; name: string; is_active: boolean }
export interface AreaRow {
  key: string;
  label: string;
  active: boolean;
  sort: number;
  department_count: number;
  archived_department_count: number;
  departments: AreaDeptRef[];
}
export interface AreasPayload {
  areas: AreaRow[];
  unlisted: { key: string; department_count: number; archived_department_count: number; departments: AreaDeptRef[] }[];
  source: 'default' | 'saved' | 'unreadable';
  ignored_entries: number;
  can_manage: boolean;
}

/** What /api/departments/areas answers on a write — success OR refusal: the
 *  up-to-date list, plus the server's own before/after of the area it touched
 *  (or an error, and `conflict` when this screen was out of date). */
type AreaSnap = { key: string; label: string; active: boolean };
type AreasReply = Partial<AreasPayload> & {
  error?: string;
  conflict?: 'renamed' | 'gone';
  changed?: boolean;
  before?: AreaSnap;
  area?: AreaSnap;
};

const deptWord = (n: number) => `${n} department${n === 1 ? '' : 's'}`;
/** " Its 2 departments keep it." — '' when no department uses the area. */
const keepNote = (n: number) =>
  n === 0 ? '' : n === 1 ? ' Its 1 department keeps it.' : ` Its ${n} departments keep it.`;
/** How many departments use `key` in the reply's (up-to-date) list. */
const usersIn = (j: AreasReply, key: string | undefined) =>
  j.areas?.find(a => a.key === key)?.department_count ?? 0;

function UsedBy({ count, archived, departments }: { count: number; archived: number; departments: AreaDeptRef[] }) {
  if (count === 0) return <span className="text-[#8B7355] italic">No department</span>;
  return (
    <div>
      <div className="text-[#2D1B0E] font-medium">
        {deptWord(count)}{archived > 0 && <span className="text-[#8B7355] font-normal"> ({archived} archived)</span>}
      </div>
      <div className="text-[10px] text-[#8B7355] leading-snug">
        {departments.map(d => d.name + (d.is_active ? '' : ' (archived)')).join(', ')}
      </div>
    </div>
  );
}

export default function ManageAreasPanel({ data, onChanged, onClose }: {
  data: AreasPayload | null;
  onChanged: (next: AreasPayload) => void;
  onClose: () => void;
}) {
  const [newLabel, setNewLabel] = useState('');
  // `opened` = the name on screen when Rename was clicked — sent as expected_label so a
  // colleague's rename made while this box is open is refused (409), not overwritten.
  const [renaming, setRenaming] = useState<{ key: string; label: string; opened: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // Every message below is built from the SERVER's reply (its before/after and
  // its up-to-date list), never from this screen's copy — with two admins at
  // once, this screen's copy can be out of date. A refusal also carries the
  // up-to-date list, which replaces the stale one so the admin sees what is
  // really there now.
  const call = async (busyKey: string, url: string, init: { method: string; body?: unknown }, done: (j: AreasReply) => string) => {
    setBusy(busyKey); setError(''); setNotice('');
    try {
      const r = await api(url, init);
      const j: AreasReply = await r.json().catch(() => ({}));
      if (Array.isArray(j?.areas)) onChanged(j as AreasPayload);
      if (!r.ok) {
        if (j?.conflict) setRenaming(null);
        setError(j?.error || 'That did not work. Nothing was changed.');
        return false;
      }
      setNotice(done(j));
      return true;
    } catch (e) {
      setError((e as Error)?.message || 'Could not reach the server. Nothing was changed.');
      return false;
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    const label = newLabel.trim();
    if (!label) { setError('Type a name for the new area.'); return; }
    const ok = await call('__add__', '/api/departments/areas', { method: 'POST', body: { label } },
      (j) => `Added "${j?.area?.label || label}". It can now be picked for a department.`);
    if (ok) setNewLabel('');
  };

  const rename = async () => {
    if (!renaming) return;
    const label = renaming.label.trim();
    const shown = renaming.opened;
    const ok = await call(renaming.key, '/api/departments/areas',
      { method: 'PUT', body: { key: renaming.key, label, expected_label: shown } },
      (j) => (j?.changed === false
        ? `Nothing changed — it is already called "${j?.area?.label ?? label}".`
        : `Renamed "${j?.before?.label ?? shown}" to "${j?.area?.label ?? label}".${keepNote(usersIn(j, j?.area?.key ?? renaming.key))}`));
    if (ok) setRenaming(null);
  };

  const setActive = (a: AreaRow, next: boolean) =>
    call(a.key, '/api/departments/areas', { method: 'PUT', body: { key: a.key, active: next, expected_label: a.label } },
      (j) => {
        const name = j?.area?.label ?? a.label;
        const on = j?.area?.active ?? next;
        if (j?.changed === false) return `"${name}" is already switched ${on ? 'on' : 'off'}. Nothing changed.`;
        return on
          ? `"${name}" is switched on and can be picked for a department again.`
          : `"${name}" is switched off.${keepNote(usersIn(j, j?.area?.key))} It can't be picked for another department.`;
      });

  const remove = (a: AreaRow) => {
    // The server re-counts inside the delete and refuses (naming them) if any
    // department has been given this area since the list was loaded.
    if (!confirm(`Delete the area "${a.label}"? This can't be undone.`)) return;
    call(a.key, `/api/departments/areas?key=${encodeURIComponent(a.key)}&expected_label=${encodeURIComponent(a.label)}`,
      { method: 'DELETE' },
      (j) => `Deleted "${j?.area?.label ?? a.label}".`);
  };

  return (
    <div className="mb-4 bg-white border border-[#E8D5C4] rounded-xl">
      <div className="px-4 py-3 border-b border-[#E8D5C4] flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <Layers className="w-5 h-5 text-[#af4408] mt-0.5 shrink-0" />
          <div>
            <h2 className="font-bold text-[#2D1B0E]">Manage Areas</h2>
            <p className="text-xs text-[#6B5744] max-w-2xl">
              Each department can belong to one area, and Closing Stock totals each day’s counts by area.
              Renaming an area changes its name everywhere; the departments in it stay in it.
              An area that departments still use can only be switched off, not deleted.
            </p>
          </div>
        </div>
        <button onClick={onClose} aria-label="Close Manage Areas" className="p-2 -m-2 text-[#8B7355] hover:text-[#2D1B0E]">
          <X className="w-5 h-5" />
        </button>
      </div>

      {data?.source === 'unreadable' && (
        <div className="mx-4 mt-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
          The saved list of areas could not be read, so the five starting areas are shown. Your next change here saves a fresh list.
        </div>
      )}
      {!!data && data.ignored_entries > 0 && (
        <div className="mx-4 mt-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
          {data.ignored_entries} saved {data.ignored_entries === 1 ? 'entry' : 'entries'} in the list could not be read and {data.ignored_entries === 1 ? 'is' : 'are'} not shown.
        </div>
      )}
      {error && (
        <div className="mx-4 mt-3 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">{error}</div>
      )}
      {notice && !error && (
        <div className="mx-4 mt-3 px-3 py-2 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-800">{notice}</div>
      )}

      {!data ? (
        <div className="p-6 text-center text-sm text-[#8B7355]"><Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading areas…</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm mt-2">
            <thead className="text-xs text-[#8B7355] bg-[#FFF8F0]">
              <tr>
                <th className="text-left py-2 px-4 font-medium">Area</th>
                <th className="text-left py-2 px-3 font-medium">Used by</th>
                <th className="text-left py-2 px-3 font-medium">On / off</th>
                <th className="py-2 px-4"></th>
              </tr>
            </thead>
            <tbody>
              {data.areas.length === 0 && (
                <tr><td colSpan={4} className="py-4 px-4 text-center text-xs text-[#8B7355]">No areas yet. Add one below.</td></tr>
              )}
              {data.areas.map(a => {
                const isRenaming = renaming?.key === a.key;
                const rowBusy = busy === a.key;
                return (
                  <tr key={a.key} className={`border-t border-[#E8D5C4]/60 align-top ${a.active ? '' : 'bg-[#FDFBF8]'}`}>
                    <td className="py-2 px-4">
                      {isRenaming ? (
                        <div className="flex items-center gap-1.5">
                          <input autoFocus value={renaming.label} maxLength={40}
                                 onFocus={e => e.currentTarget.select()}
                                 onChange={e => { const v = e.target.value; setRenaming(r => (r ? { ...r, label: v } : r)); }}
                                 onKeyDown={e => { if (e.key === 'Enter') rename(); if (e.key === 'Escape') setRenaming(null); }}
                                 aria-label={`New name for ${a.label}`}
                                 className="px-2 py-1 border border-[#D4B896] rounded-lg bg-[#FFF8F0] text-sm w-48" />
                          <button onClick={rename} disabled={rowBusy} aria-label="Save the new name"
                                  className="p-1.5 rounded bg-[#af4408] text-white hover:bg-[#8a3506] disabled:opacity-50">
                            {rowBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                          </button>
                          <button onClick={() => setRenaming(null)} aria-label="Cancel rename" className="p-1.5 text-[#8B7355] hover:text-[#2D1B0E]">
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <div className="font-medium text-[#2D1B0E]">
                          {a.label}
                          {!a.active && <span className="ml-1.5 text-[10px] font-normal px-1.5 py-0.5 rounded bg-[#E8D5C4] text-[#6B5744]">Switched off</span>}
                        </div>
                      )}
                    </td>
                    <td className="py-2 px-3 text-xs">
                      <UsedBy count={a.department_count} archived={a.archived_department_count} departments={a.departments} />
                    </td>
                    <td className="py-2 px-3">
                      <div className="flex items-start gap-1.5">
                        <Toggle size="sm" className="!min-h-0 after:absolute after:content-[''] after:-inset-2"
                                checked={a.active} disabled={rowBusy}
                                onChange={next => setActive(a, next)}
                                label={a.active ? `Switch off ${a.label}` : `Switch on ${a.label}`} />
                        <span className="text-[10px] leading-snug text-[#8B7355] max-w-[200px]">
                          {a.active
                            ? 'On — can be picked for a department.'
                            : a.department_count > 0
                              ? `Off — ${a.department_count === 1 ? 'its department keeps' : 'its departments keep'} it, but it can’t be picked for another department.`
                              : 'Off — can’t be picked for a department.'}
                        </span>
                      </div>
                    </td>
                    <td className="py-2 px-4">
                      <div className="flex items-center justify-end gap-3">
                        {!isRenaming && (
                          <button onClick={() => { setError(''); setNotice(''); setRenaming({ key: a.key, label: a.label, opened: a.label }); }}
                                  disabled={rowBusy}
                                  className="text-xs text-[#6B5744] hover:text-[#af4408] flex items-center gap-1">
                            <Pencil className="w-3.5 h-3.5" /> Rename
                          </button>
                        )}
                        <button onClick={() => remove(a)}
                                disabled={rowBusy || a.department_count > 0}
                                title={a.department_count > 0
                                  ? `${deptWord(a.department_count)} still ${a.department_count === 1 ? 'uses' : 'use'} this area, so it can't be deleted. Switch it off instead, or move ${a.department_count === 1 ? 'that department' : 'them'} to another area first.`
                                  : 'Delete this area — no department uses it.'}
                                className="text-xs flex items-center gap-1 text-red-700 hover:text-red-800 disabled:text-[#C9B8A6] disabled:cursor-not-allowed">
                          <Trash2 className="w-3.5 h-3.5" /> Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {data.unlisted.map(u => (
                <tr key={`unlisted-${u.key}`} className="border-t border-[#E8D5C4]/60 align-top bg-amber-50/40">
                  <td className="py-2 px-4">
                    <div className="font-medium text-[#2D1B0E]">{u.key}</div>
                    <div className="text-[10px] text-amber-800">Not one of the areas in this list — screens show it exactly as written here.</div>
                  </td>
                  <td className="py-2 px-3 text-xs">
                    <UsedBy count={u.department_count} archived={u.archived_department_count} departments={u.departments} />
                  </td>
                  <td colSpan={2} className="py-2 px-4 text-[10px] text-[#8B7355]">
                    {u.department_count === 1
                      ? 'That department keeps it. To tidy up, edit it and pick an area from the list.'
                      : 'Those departments keep it. To tidy up, edit each one and pick an area from the list.'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="px-4 py-3 border-t border-[#E8D5C4] flex flex-wrap items-center gap-2">
        <input value={newLabel} maxLength={40}
               onChange={e => setNewLabel(e.target.value)}
               onKeyDown={e => { if (e.key === 'Enter') add(); }}
               placeholder="New area name, e.g. Banquets"
               aria-label="New area name"
               className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm w-64 max-w-full" />
        <button onClick={add} disabled={busy === '__add__' || !data}
                className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm flex items-center gap-1.5 disabled:opacity-50">
          {busy === '__add__' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Add area
        </button>
      </div>
    </div>
  );
}
