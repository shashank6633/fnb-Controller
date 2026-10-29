'use client';

/**
 * MANAGE PARENTS — admin panel on Inventory → Categories (owner ruling #87).
 *
 * Add a parent category, rename it (every item and placeholder sub-category
 * under it follows), switch it off, delete it while nothing uses it. Every
 * action goes to /api/categories/parents, which re-checks admin and refuses a
 * delete while any item (switched-off items included) or placeholder still
 * uses the parent — the disabled Delete button here is a mirror of that, not
 * the gate.
 */

import React, { useState } from 'react';
import { FolderTree, Plus, Pencil, Trash2, Save, X, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { canonNameInput } from '@/lib/name-canon';
import Toggle from '@/components/Toggle';

interface Use {
  item_count: number;
  inactive_item_count: number;
  placeholder_count: number;
  /** Of placeholder_count, how many have a name no item uses yet. */
  placeholders_without_items: number;
  placeholder_subcategories: string[];
  subcategory_count: number;
  subcategories: string[];
  spellings: string[];
}
export interface ParentRow extends Use {
  label: string; active: boolean; sort: number;
  /** The server's reason Delete is refused, with the steps that free it; null when unused. */
  delete_blocked: string | null;
}
export interface UnlistedRow extends Use { label: string }
export interface ParentsPayload {
  parents: ParentRow[];
  unlisted: UnlistedRow[];
  source: 'default' | 'saved' | 'unreadable';
  ignored_entries: number;
  can_manage: boolean;
}

type Snap = { label: string; active: boolean };
type Counts = { items_updated: number; placeholders_updated: number; spellings: string[] };
type Reply = Partial<ParentsPayload> & {
  error?: string;
  conflict?: 'renamed' | 'gone' | 'listed';
  changed?: boolean;
  before?: Snap;
  parent?: Snap;
  counts?: Counts;
  items_already_carrying_it?: number;
  from?: string;
  to?: string;
  joined_listed_parent?: boolean;
};

const itemWord = (n: number) => `${n} item${n === 1 ? '' : 's'}`;
const subWord = (n: number) => `${n} sub-categor${n === 1 ? 'y' : 'ies'}`;
const phWord = (n: number) => `${n} placeholder sub-categor${n === 1 ? 'y' : 'ies'}`;
const keepNote = (n: number) =>
  n === 0 ? '' : n === 1 ? ' Its 1 item keeps it.' : ` Its ${n} items keep it.`;
const usersIn = (j: Reply, label: string | undefined) =>
  j.parents?.find(p => p.label === label)?.item_count ?? 0;
const movedNote = (c: Counts | undefined) =>
  !c ? '' : ` ${itemWord(c.items_updated)} and ${phWord(c.placeholders_updated)} now carry the new name.`;

function UsedBy({ u }: { u: Use }) {
  return (
    <div className="text-xs">
      <div className="text-[#2D1B0E] font-medium">
        {u.item_count === 0 ? <span className="text-[#8B7355] italic font-normal">No items</span> : itemWord(u.item_count)}
        {u.inactive_item_count > 0 && <span className="text-[#8B7355] font-normal"> ({u.inactive_item_count} switched off)</span>}
      </div>
      {u.placeholder_count > 0 && (
        // "(no items yet)" only while it is true: a placeholder whose name items
        // now use is still counted here but listed under the items' parent.
        <div className="text-[10px] text-[#8B7355]" title={u.placeholder_subcategories.join(', ')}>
          {phWord(u.placeholder_count)}
          {u.placeholders_without_items === u.placeholder_count ? ' (no items yet)' : `: ${u.placeholder_subcategories.join(', ')}`}
        </div>
      )}
    </div>
  );
}

function Subs({ u }: { u: Use }) {
  if (u.subcategory_count === 0) return <span className="text-xs text-[#8B7355] italic">None</span>;
  const shown = u.subcategories.slice(0, 8).join(', ') + (u.subcategories.length > 8 ? ` and ${u.subcategories.length - 8} more` : '');
  return (
    <div className="text-xs">
      <div className="text-[#2D1B0E] font-medium">{subWord(u.subcategory_count)}</div>
      <div className="text-[10px] text-[#8B7355] leading-snug">{shown}</div>
    </div>
  );
}

export default function ManageParentsPanel({ data, onChanged, onClose }: {
  data: ParentsPayload | null;
  onChanged: (next: ParentsPayload) => void;
  onClose: () => void;
}) {
  const [newLabel, setNewLabel] = useState('');
  // `opened` = the name on screen when Rename was clicked — sent as expected_label so a
  // colleague's rename made while this box is open is refused (409), not overwritten.
  const [renaming, setRenaming] = useState<{ kind: 'listed' | 'unlisted'; opened: string; label: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // Every message is built from the SERVER's reply (its before/after, counts
  // and up-to-date list), never from this screen's copy, which can be out of
  // date with two admins at once. A refusal also carries the up-to-date list.
  const call = async (busyKey: string, url: string, init: { method: string; body?: unknown }, done: (j: Reply) => string) => {
    setBusy(busyKey); setError(''); setNotice('');
    try {
      const r = await api(url, init);
      const j: Reply = await r.json().catch(() => ({}));
      if (Array.isArray(j?.parents)) onChanged(j as ParentsPayload);
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

  const add = async (labelIn?: string) => {
    const label = (labelIn ?? newLabel).trim();
    if (!label) { setError('Type a name for the new parent.'); return; }
    const ok = await call(labelIn ? `u:${labelIn}` : '__add__', '/api/categories/parents', { method: 'POST', body: { label } },
      (j) => {
        const name = j?.parent?.label || label;
        const already = j?.items_already_carrying_it ?? 0;
        return `Added "${name}". It can now be picked as a parent.`
          + (already ? ` ${itemWord(already)} already ${already === 1 ? 'carries' : 'carry'} this name and now count under it.` : '');
      });
    if (ok && !labelIn) setNewLabel('');
  };

  const renameListed = async () => {
    if (!renaming || renaming.kind !== 'listed') return;
    const label = renaming.label.trim();
    const shown = renaming.opened;
    const ok = await call(`l:${shown}`, '/api/categories/parents',
      { method: 'PUT', body: { expected_label: shown, label } },
      (j) => (j?.changed === false
        ? `Nothing changed — it is already called "${j?.parent?.label ?? label}".`
        : `Renamed "${j?.before?.label ?? shown}" to "${j?.parent?.label ?? label}".${movedNote(j?.counts)}`));
    if (ok) setRenaming(null);
  };

  const renameUnlisted = async (u: UnlistedRow) => {
    if (!renaming || renaming.kind !== 'unlisted') return;
    const label = renaming.label.trim();
    if (!label) { setError('Type the new name. Nothing was changed.'); return; }
    const target = data?.parents.find(p => canonNameInput(p.label).toLowerCase() === canonNameInput(label).toLowerCase());
    // A switched-off target is refused by the server with its own message.
    if (target && target.active && !confirm(`"${target.label}" is already a parent in the list. Move the ${itemWord(u.item_count)}`
      + `${u.placeholder_count ? ` and ${phWord(u.placeholder_count)}` : ''} carrying "${u.label}" under "${target.label}"? `
      + 'They would then be one group, and this can’t be split apart again by renaming.')) return;
    const ok = await call(`u:${u.label}`, '/api/categories/parents',
      { method: 'PUT', body: { unlisted: u.label, label } },
      (j) => (j?.changed === false
        ? 'Nothing changed.'
        : `Renamed "${j?.from ?? u.label}" to "${j?.to ?? label}" on ${itemWord(j?.counts?.items_updated ?? 0)} and ${phWord(j?.counts?.placeholders_updated ?? 0)}.`
          + (j?.joined_listed_parent ? ` They now sit under the parent "${j?.to}".` : ` "${j?.to ?? label}" is not in the list either — use Add to list to add it.`)));
    if (ok) setRenaming(null);
  };

  const setActive = (p: ParentRow, next: boolean) =>
    call(`l:${p.label}`, '/api/categories/parents', { method: 'PUT', body: { expected_label: p.label, active: next } },
      (j) => {
        const name = j?.parent?.label ?? p.label;
        const on = j?.parent?.active ?? next;
        if (j?.changed === false) return `"${name}" is already switched ${on ? 'on' : 'off'}. Nothing changed.`;
        return on
          ? `"${name}" is switched on and can be picked as a parent again.`
          : `"${name}" is switched off.${keepNote(usersIn(j, name))} It is no longer offered as a choice for new sub-categories or items.`;
      });

  const remove = (p: ParentRow) => {
    // The server re-counts inside the delete and refuses (naming them) if any
    // item or sub-category has been put under this parent since the list loaded.
    if (!confirm(`Delete the parent "${p.label}"? This can't be undone.`)) return;
    call(`l:${p.label}`, `/api/categories/parents?expected_label=${encodeURIComponent(p.label)}`,
      { method: 'DELETE' },
      (j) => `Deleted "${j?.parent?.label ?? p.label}".`);
  };

  const inUse = (u: Use) => u.item_count + u.placeholder_count;
  const activeParents = (data?.parents || []).filter(p => p.active);

  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl">
      <div className="px-4 py-3 border-b border-[#E8D5C4] flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <FolderTree className="w-5 h-5 text-[#af4408] mt-0.5 shrink-0" />
          <div>
            <h2 className="font-bold text-[#2D1B0E]">Manage Parents</h2>
            <p className="text-xs text-[#6B5744] max-w-2xl">
              Parent categories group the sub-categories (for example Bar holds Beers and Whisky). Renaming a parent
              renames it on every item and sub-category under it. A switched-off parent stays on the items that have it,
              but is no longer offered as a choice. A parent that items or sub-categories still use can only be switched
              off, not deleted.
            </p>
          </div>
        </div>
        <button onClick={onClose} aria-label="Close Manage Parents" className="p-2 -m-2 text-[#8B7355] hover:text-[#2D1B0E]">
          <X className="w-5 h-5" />
        </button>
      </div>

      {data?.source === 'unreadable' && (
        <div className="mx-4 mt-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
          The saved list of parents could not be read, so the 16 starting parents are shown. Your next change here saves a fresh list.
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
        <div className="p-6 text-center text-sm text-[#8B7355]"><Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading parents…</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm mt-2">
            <thead className="text-xs text-[#8B7355] bg-[#FFF8F0]">
              <tr>
                <th className="text-left py-2 px-4 font-medium">Parent</th>
                <th className="text-left py-2 px-3 font-medium">Sub-categories</th>
                <th className="text-left py-2 px-3 font-medium">Items</th>
                <th className="text-left py-2 px-3 font-medium">On / off</th>
                <th className="py-2 px-4"></th>
              </tr>
            </thead>
            <tbody>
              {data.parents.length === 0 && (
                <tr><td colSpan={5} className="py-4 px-4 text-center text-xs text-[#8B7355]">No parents yet. Add one below.</td></tr>
              )}
              {data.parents.map(p => {
                const isRenaming = renaming?.kind === 'listed' && renaming.opened === p.label;
                const rowBusy = busy === `l:${p.label}`;
                const others = p.spellings.filter(s => s !== p.label);
                return (
                  <tr key={`l-${p.label}`} className={`border-t border-[#E8D5C4]/60 align-top ${p.active ? '' : 'bg-[#FDFBF8]'}`}>
                    <td className="py-2 px-4">
                      {isRenaming ? (
                        <div className="flex items-center gap-1.5">
                          <input autoFocus value={renaming.label} maxLength={40}
                                 onFocus={e => e.currentTarget.select()}
                                 onChange={e => { const v = e.target.value; setRenaming(r => (r ? { ...r, label: v } : r)); }}
                                 onKeyDown={e => { if (e.key === 'Enter') renameListed(); if (e.key === 'Escape') setRenaming(null); }}
                                 aria-label={`New name for ${p.label}`}
                                 className="px-2 py-1 border border-[#D4B896] rounded-lg bg-[#FFF8F0] text-sm w-44" />
                          <button onClick={renameListed} disabled={rowBusy} aria-label="Save the new name"
                                  className="p-1.5 rounded bg-[#af4408] text-white hover:bg-[#8a3506] disabled:opacity-50">
                            {rowBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                          </button>
                          <button onClick={() => setRenaming(null)} aria-label="Cancel rename" className="p-1.5 text-[#8B7355] hover:text-[#2D1B0E]">
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <div className="font-medium text-[#2D1B0E]">
                          {p.label}
                          {!p.active && <span className="ml-1.5 text-[10px] font-normal px-1.5 py-0.5 rounded bg-[#E8D5C4] text-[#6B5744]">Switched off</span>}
                        </div>
                      )}
                      {others.length > 0 && (
                        <div className="text-[10px] text-[#8B7355]">Also saved as {others.map(s => `"${s}"`).join(', ')} on some items or sub-categories; they count here.</div>
                      )}
                    </td>
                    <td className="py-2 px-3"><Subs u={p} /></td>
                    <td className="py-2 px-3"><UsedBy u={p} /></td>
                    <td className="py-2 px-3">
                      <div className="flex items-start gap-1.5">
                        <Toggle size="sm" className="!min-h-0 after:absolute after:content-[''] after:-inset-2"
                                checked={p.active} disabled={rowBusy}
                                onChange={next => setActive(p, next)}
                                label={p.active ? `Switch off ${p.label}` : `Switch on ${p.label}`} />
                        <span className="text-[10px] leading-snug text-[#8B7355] max-w-[190px]">
                          {p.active
                            ? 'On — can be picked as a parent.'
                            : p.item_count > 0
                              ? `Off — ${p.item_count === 1 ? 'its item keeps' : 'its items keep'} it, but it isn’t offered as a new choice.`
                              : 'Off — not offered as a choice.'}
                        </span>
                      </div>
                    </td>
                    <td className="py-2 px-4">
                      <div className="flex items-center justify-end gap-3">
                        {!isRenaming && (
                          <button onClick={() => { setError(''); setNotice(''); setRenaming({ kind: 'listed', opened: p.label, label: p.label }); }}
                                  disabled={rowBusy}
                                  className="text-xs text-[#6B5744] hover:text-[#af4408] flex items-center gap-1">
                            <Pencil className="w-3.5 h-3.5" /> Rename
                          </button>
                        )}
                        <button onClick={() => remove(p)}
                                disabled={rowBusy || inUse(p) > 0}
                                title={inUse(p) > 0
                                  ? (p.delete_blocked
                                    || `Still used by ${[p.item_count ? itemWord(p.item_count) : '', p.placeholder_count ? phWord(p.placeholder_count) : ''].filter(Boolean).join(' and ')}, so it can't be deleted.${p.active ? ' Switch it off instead.' : ''}`)
                                  : 'Delete this parent — nothing uses it.'}
                                className="text-xs flex items-center gap-1 text-red-700 hover:text-red-800 disabled:text-[#C9B8A6] disabled:cursor-not-allowed">
                          <Trash2 className="w-3.5 h-3.5" /> Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {data.unlisted.map(u => {
                const isRenaming = renaming?.kind === 'unlisted' && renaming.opened === u.label;
                const rowBusy = busy === `u:${u.label}`;
                return (
                  <tr key={`u-${u.label}`} className="border-t border-[#E8D5C4]/60 align-top bg-amber-50/40">
                    <td className="py-2 px-4">
                      {isRenaming ? (
                        <div className="flex items-center gap-1.5">
                          <input autoFocus value={renaming.label} maxLength={40} list="manage-parents-active"
                                 onFocus={e => e.currentTarget.select()}
                                 onChange={e => { const v = e.target.value; setRenaming(r => (r ? { ...r, label: v } : r)); }}
                                 onKeyDown={e => { if (e.key === 'Enter') renameUnlisted(u); if (e.key === 'Escape') setRenaming(null); }}
                                 aria-label={`New name for ${u.label}`}
                                 className="px-2 py-1 border border-[#D4B896] rounded-lg bg-[#FFF8F0] text-sm w-44" />
                          <button onClick={() => renameUnlisted(u)} disabled={rowBusy} aria-label="Save the new name"
                                  className="p-1.5 rounded bg-[#af4408] text-white hover:bg-[#8a3506] disabled:opacity-50">
                            {rowBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                          </button>
                          <button onClick={() => setRenaming(null)} aria-label="Cancel rename" className="p-1.5 text-[#8B7355] hover:text-[#2D1B0E]">
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <div className="font-medium text-[#2D1B0E]">{u.label}</div>
                      )}
                      <div className="text-[10px] text-amber-800">
                        In use, not in the list — screens show it exactly as saved.
                        {u.spellings.length > 1 && <> Saved as {u.spellings.map(s => `"${s}"`).join(', ')}.</>}
                      </div>
                    </td>
                    <td className="py-2 px-3"><Subs u={u} /></td>
                    <td className="py-2 px-3"><UsedBy u={u} /></td>
                    <td className="py-2 px-3 text-[10px] text-[#8B7355] max-w-[190px]">
                      Not offered as a choice until it is added to the list.
                    </td>
                    <td className="py-2 px-4">
                      <div className="flex items-center justify-end gap-3">
                        <button onClick={() => add(u.label)} disabled={rowBusy}
                                title={`Add "${u.label}" to the list. Its items keep it and count under it.`}
                                className="text-xs text-[#6B5744] hover:text-[#af4408] flex items-center gap-1 disabled:opacity-50">
                          <Plus className="w-3.5 h-3.5" /> Add to list
                        </button>
                        {!isRenaming && (
                          <button onClick={() => { setError(''); setNotice(''); setRenaming({ kind: 'unlisted', opened: u.label, label: u.label }); }}
                                  disabled={rowBusy}
                                  title="Rename it on its items — type a parent from the list to move them under that parent."
                                  className="text-xs text-[#6B5744] hover:text-[#af4408] flex items-center gap-1">
                            <Pencil className="w-3.5 h-3.5" /> Rename
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <datalist id="manage-parents-active">
            {activeParents.map(p => <option key={p.label} value={p.label} />)}
          </datalist>
        </div>
      )}

      <div className="px-4 py-3 border-t border-[#E8D5C4] flex flex-wrap items-center gap-2">
        <input value={newLabel} maxLength={40}
               onChange={e => setNewLabel(e.target.value)}
               onKeyDown={e => { if (e.key === 'Enter') add(); }}
               placeholder="New parent name, e.g. Brewery"
               aria-label="New parent name"
               className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm w-64 max-w-full" />
        <button onClick={() => add()} disabled={busy === '__add__' || !data}
                className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm flex items-center gap-1.5 disabled:opacity-50">
          {busy === '__add__' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Add parent
        </button>
      </div>
    </div>
  );
}
