'use client';

/**
 * PRINT VIEW of the week — the owner works from a printed sheet, laid out like
 * his real AKAN SERVICE roster: GROUPS AS SECTIONS (the designations), people as
 * rows, seven day columns, and OFF and LEAVE visible on the page.
 *
 * OFFS COME FROM THE PLAN, NEVER FROM A TABLE. They are deliberately not
 * persisted (hr_rosters cannot express an off, and one stored there would be
 * counted as an absence by the attendance register), so a sheet printed without a
 * previewed or just-generated plan can only show the saved SHIFT rows. It says
 * that on screen instead of printing a sheet whose blank cells could be read as
 * "day off".
 *
 * Shown as an on-screen preview first, so the manager sees exactly what will come
 * out of the printer. The page behind it is print:hidden while this is open.
 */

import { Printer, X } from 'lucide-react';
import { WEEKDAY_SHORT } from './roster-plan';

export interface PrintCell {
  kind: 'shift' | 'off' | 'leave' | 'empty';
  /** Shift name, 'OFF', 'LEAVE' or ''. */
  label: string;
  /** '11:00–15:30', with ' +1d' for an overnight span. */
  time: string;
  /** The per-assignment WHY, so a printed sheet can still be questioned. */
  reason: string;
}

export interface PrintSection {
  id: string;
  name: string;
  people: Array<{ id: string; name: string; code: string }>;
}

interface Props {
  departmentLabel: string;
  weekStart: string;
  weekEnd: string;
  dates: string[];
  sections: PrintSection[];
  cell: (employeeId: string, date: string) => PrintCell;
  /** True when a matching plan is overlaid, i.e. OFF/LEAVE are trustworthy. */
  hasPlan: boolean;
  onClose: () => void;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

function dayMonth(date: string): string {
  return `${parseInt(date.slice(8, 10), 10)} ${MONTHS[parseInt(date.slice(5, 7), 10) - 1] || ''}`;
}

function weekdayIdx(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export default function RosterPrintSheet({
  departmentLabel,
  weekStart,
  weekEnd,
  dates,
  sections,
  cell,
  hasPlan,
  onClose,
}: Props) {
  const totalPeople = sections.reduce((n, s) => n + s.people.length, 0);

  return (
    <div className="fixed inset-0 z-[60] bg-white overflow-auto print:static print:overflow-visible print:z-auto">
      {/* Landscape, and no browser header/footer eating a day column. */}
      <style>{`@media print { @page { size: A4 landscape; margin: 10mm } }`}</style>

      {/* Screen-only toolbar. */}
      <div className="print:hidden sticky top-0 bg-[#FFF8F0] border-b border-[#E8D5C4] px-4 py-3 flex flex-wrap items-center gap-3">
        <span className="font-semibold text-[#2D1B0E]">Print preview</span>
        <span className="text-xs text-[#8B7355]">
          {totalPeople} people in {sections.length} group{sections.length === 1 ? '' : 's'}
        </span>
        <span className="flex-1" />
        <button onClick={() => window.print()}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#af4408] hover:bg-[#8a3506] text-white text-sm font-medium">
          <Printer className="w-4 h-4" /> Print
        </button>
        <button onClick={onClose}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[#E8D5C4] hover:bg-[#FFF1E3] text-sm text-[#6B5744]">
          <X className="w-4 h-4" /> Close
        </button>
      </div>

      {!hasPlan && (
        <div className="print:hidden mx-4 mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          No plan is loaded for this department and week, so this sheet shows the <strong>saved
          shift rows only</strong> — weekly offs are never stored and cannot be read back. Press
          Preview on the Generate card first if the sheet needs OFF marked.
        </div>
      )}

      <div className="p-4 text-black">
        {/* Masthead */}
        <div className="flex items-end justify-between border-b-2 border-black pb-2 mb-3">
          <div>
            <h1 className="text-xl font-bold uppercase tracking-wide">
              {departmentLabel || 'Roster'} — Weekly Roster
            </h1>
            <p className="text-xs">
              {dayMonth(weekStart)} to {dayMonth(weekEnd)} ({weekStart} – {weekEnd}) · IST
            </p>
          </div>
          <div className="text-xs text-right">
            <div>{totalPeople} staff</div>
            {!hasPlan && <div className="italic">shifts only — offs not shown</div>}
          </div>
        </div>

        {sections.length === 0 ? (
          <p className="text-sm">Nobody to print — no rosterable employee in this selection.</p>
        ) : (
          sections.map(section => (
            // break-inside-avoid keeps a group on one page where it fits, so a
            // section heading never prints alone at the foot of a page.
            <div key={section.id || '(none)'} className="mb-4 break-inside-avoid">
              <h2 className="text-sm font-bold uppercase bg-black text-white px-2 py-1">
                {section.name} <span className="font-normal">({section.people.length})</span>
              </h2>
              <table className="w-full border-collapse text-[11px]">
                <thead>
                  <tr>
                    <th className="border border-black px-1.5 py-1 text-left w-44">Name</th>
                    {dates.map(d => (
                      <th key={d} className="border border-black px-1 py-1 text-center">
                        <div>{WEEKDAY_SHORT[weekdayIdx(d)]}</div>
                        <div className="font-normal">{dayMonth(d)}</div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {section.people.map(p => (
                    <tr key={p.id}>
                      <td className="border border-black px-1.5 py-1 align-top">
                        <div className="font-medium leading-tight">{p.name}</div>
                        {p.code && <div className="text-[9px]">{p.code}</div>}
                      </td>
                      {dates.map(d => {
                        const c = cell(p.id, d);
                        return (
                          <td key={d} title={c.reason}
                              className={`border border-black px-1 py-1 text-center align-top ${
                                c.kind === 'off' ? 'bg-neutral-200 font-bold'
                                  : c.kind === 'leave' ? 'bg-neutral-100 italic'
                                  : ''
                              }`}>
                            <div className="leading-tight">{c.label || '—'}</div>
                            {c.time && <div className="text-[9px] leading-tight">{c.time}</div>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))
        )}

        <div className="mt-4 pt-2 border-t border-black text-[10px] leading-relaxed">
          <p>
            <strong>OFF</strong> = weekly off (one each, Mon–Thu only — it is a Pub and the weekend
            is busier). <strong>LEAVE</strong> = approved leave, which blanks the row and overrides
            everything. Times are IST; “+1d” marks a shift ending the next calendar morning, and the
            whole shift still belongs to the start day.
          </p>
          <p className="mt-1">
            Weekly offs are shown from the plan and are not stored anywhere — this printed sheet is
            the record of them.
          </p>
        </div>
      </div>
    </div>
  );
}
