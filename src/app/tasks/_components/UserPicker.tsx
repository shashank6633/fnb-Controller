'use client';

/**
 * UserPicker — a PORTALED combobox for choosing task assignees / @-mention
 * targets from the active-user directory (/api/tasks/users).
 *
 * WHY PORTALED: like Combobox.tsx, the dropdown is rendered to <body> with
 * position:fixed so it is NEVER clipped by an ancestor's overflow — the exact
 * clipping bug that hid pickers inside the task modal / scroll panes. The
 * click-outside handler checks BOTH the anchor and the portal drop refs.
 *
 * Two usable forms (one component, switched by `multiple`):
 *   • Single-select — value = the chosen user's email; onPick(user) fires once.
 *   • Multi-select  — chips of selected emails; onChange(emails, users) fires
 *                     on every add/remove.
 *
 * The user list is fetched ONCE per page load and shared across all instances
 * (module-level cache) so ten pickers on a page make one request.
 *
 * Also exports resolveMention(token, users) for @mention autocomplete: given a
 * raw mention token (no leading '@') it returns the best-matching TaskUser.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, X, Search } from 'lucide-react';

export interface TaskUser {
  id: string;
  name: string;
  email: string;
  position: string;
  department_id: string | null;
}

/* ------------------------------------------------------------------ *
 * Shared directory fetch (one request per page, cached module-wide)
 * ------------------------------------------------------------------ */

let _cache: TaskUser[] | null = null;
let _inflight: Promise<TaskUser[]> | null = null;

/** Fetch the active-user directory once and memoize. Never throws — on error
 *  it resolves to [] so pickers degrade to an empty (typed-only) state. */
export async function fetchTaskUsers(force = false): Promise<TaskUser[]> {
  if (!force && _cache) return _cache;
  if (!force && _inflight) return _inflight;
  _inflight = (async () => {
    try {
      const res = await fetch('/api/tasks/users', { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      _cache = Array.isArray(data?.users) ? (data.users as TaskUser[]) : [];
      return _cache;
    } catch (e) {
      console.error('fetchTaskUsers failed:', e);
      _cache = _cache || [];
      return _cache;
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

/** React hook: returns the shared directory (empty until loaded) + loading flag. */
export function useTaskUsers(): { users: TaskUser[]; loading: boolean } {
  const [users, setUsers] = useState<TaskUser[]>(_cache || []);
  const [loading, setLoading] = useState<boolean>(!_cache);
  useEffect(() => {
    let alive = true;
    if (_cache) { setUsers(_cache); setLoading(false); return; }
    fetchTaskUsers().then((u) => { if (alive) { setUsers(u); setLoading(false); } });
    return () => { alive = false; };
  }, []);
  return { users, loading };
}

/* ------------------------------------------------------------------ *
 * @mention resolution
 * ------------------------------------------------------------------ */

/**
 * Resolve an @-mention token (WITHOUT the leading '@', as returned by
 * parseMentions) to the best-matching user. Priority:
 *   1. exact email (case-insensitive)
 *   2. exact name (case-insensitive)
 *   3. email local-part exact (before the '@')
 *   4. unambiguous name/email prefix (only one match)
 * Returns null if there's no confident match.
 */
export function resolveMention(token: string, users: TaskUser[]): TaskUser | null {
  const t = (token || '').trim().toLowerCase();
  if (!t || !users?.length) return null;

  const byEmail = users.find((u) => u.email.toLowerCase() === t);
  if (byEmail) return byEmail;

  const byName = users.find((u) => u.name.toLowerCase() === t);
  if (byName) return byName;

  const byLocal = users.find((u) => u.email.toLowerCase().split('@')[0] === t);
  if (byLocal) return byLocal;

  const prefix = users.filter(
    (u) => u.name.toLowerCase().startsWith(t) || u.email.toLowerCase().startsWith(t),
  );
  return prefix.length === 1 ? prefix[0] : null;
}

/* ------------------------------------------------------------------ *
 * UserPicker component
 * ------------------------------------------------------------------ */

interface BaseProps {
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  /** Restrict the list to a specific department_id (null = all). */
  departmentId?: string | null;
  /** Autofocus the input on mount. */
  autoFocus?: boolean;
}

interface SingleProps extends BaseProps {
  multiple?: false;
  /** Selected user's email (controlled). */
  value?: string;
  /** Fires when a user is chosen. */
  onPick: (user: TaskUser) => void;
  /** Show a clear (×) affordance in single mode. */
  allowClear?: boolean;
  /** Fires when cleared (only if allowClear). */
  onClear?: () => void;
}

interface MultiProps extends BaseProps {
  multiple: true;
  /** Selected emails (controlled). */
  values?: string[];
  /** Fires on every add/remove with the full selection. */
  onChange: (emails: string[], users: TaskUser[]) => void;
}

export type UserPickerProps = SingleProps | MultiProps;

const INPUT_CLS =
  'w-full pr-6 px-2 py-1.5 border border-[#E8D5C4] rounded bg-[#FFF8F0] text-sm text-[#2D1B0E] placeholder-[#8B7355] focus:outline-none focus:border-[#af4408] disabled:opacity-60';

function label(u: TaskUser): string {
  return u.name || u.email || u.id;
}

export default function UserPicker(props: UserPickerProps) {
  const { placeholder, className, disabled, departmentId, autoFocus } = props;
  const isMulti = props.multiple === true;

  const { users, loading } = useTaskUsers();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const [active, setActive] = useState(0); // keyboard highlight index

  // Selected emails, normalized.
  const selectedEmails = useMemo(() => {
    if (isMulti) return ((props as MultiProps).values || []).map((e) => e.toLowerCase());
    const v = (props as SingleProps).value;
    return v ? [v.toLowerCase()] : [];
  }, [isMulti, props]);

  const selectedUsers = useMemo(
    () => selectedEmails.map((e) => users.find((u) => u.email.toLowerCase() === e)).filter(Boolean) as TaskUser[],
    [selectedEmails, users],
  );

  const scoped = useMemo(
    () => (departmentId ? users.filter((u) => u.department_id === departmentId) : users),
    [users, departmentId],
  );

  const results = useMemo(() => {
    const raw = query.trim().toLowerCase();
    let list = scoped;
    if (isMulti) {
      const sel = new Set(selectedEmails);
      list = list.filter((u) => !sel.has(u.email.toLowerCase()));
    }
    if (!raw) return list;
    return list.filter(
      (u) =>
        u.name.toLowerCase().includes(raw) ||
        u.email.toLowerCase().includes(raw) ||
        (u.position || '').toLowerCase().includes(raw),
    );
  }, [scoped, query, isMulti, selectedEmails]);

  const computePos = () => {
    const el = wrapRef.current;
    if (!el || typeof window === 'undefined') return;
    const r = el.getBoundingClientRect();
    const width = Math.max(r.width, 240);
    const left = Math.min(r.left, window.innerWidth - width - 8);
    setPos({ top: r.bottom + 4, left: Math.max(8, left), width });
  };

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    computePos();
    const onMove = () => computePos();
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!wrapRef.current?.contains(t) && !dropRef.current?.contains(t)) {
        setOpen(false); setQuery('');
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  useEffect(() => { setActive(0); }, [query, open]);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const pick = (u: TaskUser) => {
    if (isMulti) {
      const cur = (props as MultiProps).values || [];
      if (cur.some((e) => e.toLowerCase() === u.email.toLowerCase())) return;
      const nextEmails = [...cur, u.email];
      const nextUsers = nextEmails
        .map((e) => users.find((x) => x.email.toLowerCase() === e.toLowerCase()))
        .filter(Boolean) as TaskUser[];
      (props as MultiProps).onChange(nextEmails, nextUsers);
      setQuery('');
      inputRef.current?.focus();
    } else {
      (props as SingleProps).onPick(u);
      setQuery('');
      setOpen(false);
    }
  };

  const removeEmail = (email: string) => {
    if (!isMulti) return;
    const cur = (props as MultiProps).values || [];
    const nextEmails = cur.filter((e) => e.toLowerCase() !== email.toLowerCase());
    const nextUsers = nextEmails
      .map((e) => users.find((x) => x.email.toLowerCase() === e.toLowerCase()))
      .filter(Boolean) as TaskUser[];
    (props as MultiProps).onChange(nextEmails, nextUsers);
  };

  const clearSingle = () => {
    const p = props as SingleProps;
    if (p.onClear) p.onClear();
    setQuery('');
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { setOpen(false); setQuery(''); return; }
    if (e.key === 'Backspace' && isMulti && !query && selectedUsers.length) {
      removeEmail(selectedUsers[selectedUsers.length - 1].email);
      return;
    }
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) { setOpen(true); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (results[active]) pick(results[active]); }
  };

  // Display value for the single-select input when not actively typing.
  const singleDisplay = !isMulti && !open ? (selectedUsers[0] ? label(selectedUsers[0]) : '') : query;

  return (
    <div ref={wrapRef} className={className || 'relative'}>
      {/* Multi-select chips */}
      {isMulti && selectedUsers.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1">
          {selectedUsers.map((u) => (
            <span
              key={u.id}
              className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full bg-[#FFF1E3] border border-[#E8D5C4] text-[12px] text-[#2D1B0E]"
            >
              {label(u)}
              {!disabled && (
                <button
                  type="button"
                  onClick={() => removeEmail(u.email)}
                  className="rounded-full hover:bg-[#E8D5C4] p-0.5 text-[#8B7355]"
                  aria-label={`Remove ${label(u)}`}
                >
                  <X size={11} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      <div className="relative">
        <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-[#8B7355] pointer-events-none" />
        <input
          ref={inputRef}
          type="text"
          disabled={disabled}
          value={singleDisplay}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => { if (!disabled) { setOpen(true); if (!isMulti) setQuery(''); } }}
          onKeyDown={onKeyDown}
          placeholder={
            placeholder ||
            (loading ? 'Loading users…' : isMulti ? 'Add people…' : 'Assign to…')
          }
          className={`${INPUT_CLS} pl-7`}
        />
        {/* Trailing affordance: clear (single) or chevron */}
        {!isMulti && (props as SingleProps).allowClear && selectedUsers[0] && !disabled ? (
          <button
            type="button"
            onClick={clearSingle}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[#8B7355] hover:text-[#af4408]"
            aria-label="Clear"
          >
            <X size={14} />
          </button>
        ) : (
          <ChevronDown size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-[#8B7355] pointer-events-none" />
        )}
      </div>

      {open && pos && !disabled && typeof document !== 'undefined' && createPortal(
        <div
          ref={dropRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width }}
          className="z-[100] max-w-[calc(100vw-1rem)]"
        >
          {results.length > 0 ? (
            <ul className="max-h-[50vh] overflow-y-auto overscroll-contain bg-white border border-[#D4B896] rounded shadow-lg text-sm">
              <li className="sticky top-0 bg-[#FFF8F0] border-b border-[#E8D5C4] px-2 py-1 text-[10px] text-[#8B7355]">
                {results.length} {results.length === 1 ? 'person' : 'people'}
                {query.trim() ? ' matched' : ''}
              </li>
              {results.map((u, i) => (
                <li
                  key={u.id}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => { e.preventDefault(); pick(u); }}
                  className={`px-2 py-1.5 cursor-pointer text-[#2D1B0E] break-words leading-snug ${
                    i === active ? 'bg-[#FFF1E3]' : 'hover:bg-[#FFF8F0]'
                  }`}
                >
                  <div className="font-medium">{u.name || u.email}</div>
                  <div className="text-[11px] text-[#8B7355]">
                    {u.email}
                    {u.position ? <span> · {u.position}</span> : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="bg-white border border-[#D4B896] rounded shadow-lg p-2 text-[11px] text-[#8B7355]">
              {loading
                ? 'Loading users…'
                : users.length === 0
                  ? 'No users found — refresh if this stays empty.'
                  : `No match for "${query}".`}
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
