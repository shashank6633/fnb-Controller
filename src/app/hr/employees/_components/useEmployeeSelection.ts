'use client';

/**
 * Cross-page row selection for the employee master list.
 *
 * WHY A HOOK AND NOT useState IN THE PAGE. The list is server-paginated at 25
 * rows a page while 129 employees need classifying, so per-page checkboxes
 * alone would mean six page visits and six separate assignments — the kind of
 * job that never gets finished. The selection therefore has to outlive the page
 * the rows were ticked on, and "select everyone matching this filter" has to be
 * able to reach rows that were never rendered.
 *
 * SELECT-ALL-MATCHING IS A LOOP, NOT ONE BIG REQUEST. GET /api/hr/employees
 * clamps pageSize to 100 (`Math.min(100, …)`) and does NOT say it clamped — ask
 * for 500 and you silently get 100 and a wrong-but-plausible selection. So the
 * ids are collected page by page at exactly the cap, and the loop stops on the
 * ROW COUNT, never on `total` alone: an insert landing mid-collection must not
 * leave this spinning.
 *
 * It replaces the selection rather than merging into it. A manager who presses
 * "select all 128 matching" is stating the set, and a leftover tick from an
 * earlier filter silently riding along would be in the set that gets written.
 */

import { useCallback, useRef, useState } from 'react';

/** The list GET's own pageSize cap. Asking for more is silently clamped, so
 *  this is also the collection loop's stride. */
export const SELECT_ALL_PAGE_SIZE = 100;

/**
 * Hard stop for the collection loop (4,000 employees at the stride above).
 * A runaway here would be a wedged browser tab, not a server problem — and the
 * real headcount is 129, so hitting this means the filter is wrong, which the
 * caller is told rather than left to guess.
 */
const MAX_SELECT_ALL_PAGES = 40;

export interface EmployeeSelection {
  /** The chosen employee ids — may include rows no longer on screen. */
  selected: ReadonlySet<string>;
  count: number;
  /** Tick/untick one row. */
  toggle: (id: string, on: boolean) => void;
  /** Tick/untick a whole page's worth at once (the header checkbox). */
  setMany: (ids: string[], on: boolean) => void;
  clear: () => void;
  /** Collect every id matching the CURRENT filter, across pages. */
  selectAllMatching: () => Promise<void>;
  collecting: boolean;
  /** 1-based page being fetched and the pages expected, for an honest spinner. */
  progress: { page: number; of: number } | null;
  /** Collection failure, already phrased for a human. Null when nothing is wrong. */
  error: string | null;
}

/**
 * @param buildQuery the page's own query builder — the SAME filters the visible
 *   list was fetched with, so "all matching" means what the manager is looking
 *   at. It takes the page size because the stride here is not the list's.
 */
export function useEmployeeSelection(
  buildQuery: (page: number, pageSize: number) => string,
): EmployeeSelection {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collecting, setCollecting] = useState(false);
  const [progress, setProgress] = useState<{ page: number; of: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Race guard (the convention this page already uses for its list fetch): a
  // superseded collection must never install its ids over a newer one.
  const runSeq = useRef(0);

  const toggle = useCallback((id: string, on: boolean) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  }, []);

  const setMany = useCallback((ids: string[], on: boolean) => {
    setSelected(prev => {
      const next = new Set(prev);
      for (const id of ids) { if (on) next.add(id); else next.delete(id); }
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    // Abandon any in-flight collection too, or its ids would land on the
    // selection a moment after the manager emptied it.
    runSeq.current++;
    setSelected(new Set());
    setCollecting(false);
    setProgress(null);
    setError(null);
  }, []);

  const selectAllMatching = useCallback(async () => {
    const run = ++runSeq.current;
    setCollecting(true);
    setError(null);
    const acc = new Set<string>();
    try {
      let page = 1;
      let expected = 1;
      for (;;) {
        if (page > MAX_SELECT_ALL_PAGES) {
          setError(
            `Stopped after ${acc.size} employees — that is more than this bar is meant for. `
            + 'Narrow the filter and select again.',
          );
          break;
        }
        setProgress({ page, of: expected });
        const res = await fetch(`/api/hr/employees?${buildQuery(page, SELECT_ALL_PAGE_SIZE)}`);
        if (run !== runSeq.current) return; // superseded — leave the newer run alone
        if (!res.ok) {
          setError(
            res.status === 401 || res.status === 403
              ? 'You need management access to list employees.'
              : "Couldn't collect the matching employees — nothing was selected.",
          );
          return;
        }
        const json = await res.json();
        if (run !== runSeq.current) return;
        const rows: unknown[] = Array.isArray(json?.rows) ? json.rows : [];
        for (const r of rows) {
          const id = String((r as { id?: unknown } | null)?.id ?? '').trim();
          if (id) acc.add(id);
        }
        const total = Number(json?.total) || 0;
        expected = Math.max(1, Math.ceil(total / SELECT_ALL_PAGE_SIZE));
        // A short page is the end of the list. Checking that FIRST is what makes
        // a concurrent insert (which raises `total` under us) harmless.
        if (rows.length < SELECT_ALL_PAGE_SIZE || acc.size >= total) break;
        page++;
      }
      setSelected(new Set(acc));
    } catch {
      setError('Could not reach the server — nothing was selected.');
    } finally {
      if (run === runSeq.current) { setCollecting(false); setProgress(null); }
    }
  }, [buildQuery]);

  return {
    selected,
    count: selected.size,
    toggle,
    setMany,
    clear,
    selectAllMatching,
    collecting,
    progress,
    error,
  };
}
