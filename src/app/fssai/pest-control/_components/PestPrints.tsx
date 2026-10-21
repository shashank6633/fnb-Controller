'use client';

/**
 * THE PAPER — what an inspector is handed from Pest Control Logs.
 *
 *   MonitoringSheetPrint   #113 the station-by-station sheet for a period
 *   ChemicalsRegisterPrint #78  what was applied, visit by visit
 *   VisitRecordPrint            one contractor visit, chemicals included
 *
 * VOIDED LINES ARE PRINTED, struck through, with who voided them, when and why:
 * evidence is voided, never deleted, and a printout that silently dropped them
 * would be a different record from the one in the database. A line nobody
 * recorded (activity '', chemicals 'not recorded') prints as NOT RECORDED in
 * words, never as a blank an eye reads as "no".
 *
 * Types are imported with `import type` from the server modules, which erases
 * them at compile — nothing from the database layer reaches the browser.
 */

import type { PestCheckRow, PestMonitoringSheet, PestChemicalsVisit } from '@/app/api/fssai/pest/_pest/monitoring';
import { fmtIST } from '@/lib/format-date';
import { ChemicalsTable, type ChemRow } from './Chemicals';
import { PT, PTH } from './pest-ui';

function Head({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="mb-3 border-b-2 border-black pb-2">
      <p className="text-[18px] font-bold uppercase tracking-wide">{title}</p>
      <p className="text-[11px]">{sub}</p>
      <p className="text-[10px] text-gray-700">Printed {fmtIST(new Date().toISOString())} from FNB Controller · FSSAI · Pest Control Logs</p>
    </div>
  );
}

function Signatures({ left, right }: { left: string; right: string }) {
  return (
    <div className="grid grid-cols-2 gap-8 mt-8 text-[11px]">
      <div><div className="border-b border-black h-8" /><p>{left} — name, signature, date</p></div>
      <div><div className="border-b border-black h-8" /><p>{right} — name, signature, date</p></div>
    </div>
  );
}

function voidNote(r: { is_void: boolean; void_reason: string; voided_by: string; voided_at: string }) {
  return r.is_void ? `VOID — ${r.void_reason} (${r.voided_by}, ${fmtIST(r.voided_at)})` : '';
}

/* ── #113 ─────────────────────────────────────────────────────────────────── */

export function MonitoringSheetPrint({ sheet }: { sheet: PestMonitoringSheet }) {
  const rows: PestCheckRow[] = sheet.rows;
  return (
    <div>
      <Head title="Pest-control monitoring sheet" sub={`Station-by-station checks, ${sheet.from} to ${sheet.to}`} />
      <p className="mb-2 text-[11px]">
        {sheet.totals.lines} station check{sheet.totals.lines === 1 ? '' : 's'} on {sheet.totals.rounds} walk{sheet.totals.rounds === 1 ? '' : 's'} ·
        activity found {sheet.totals.activity} · station not in order {sheet.totals.not_in_order}
        {sheet.totals.void_lines ? ` · ${sheet.totals.void_lines} line${sheet.totals.void_lines === 1 ? '' : 's'} voided (printed, struck through)` : ''}
      </p>
      {rows.length === 0 ? (
        <p className="font-semibold my-4">NO STATION WAS CHECKED IN THESE DATES.</p>
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className={PTH}>Date</th>
              <th className={PTH}>Time</th>
              <th className={PTH}>Station</th>
              <th className={PTH}>Type</th>
              <th className={PTH}>Location</th>
              <th className={PTH}>Activity</th>
              <th className={PTH}>What was found</th>
              <th className={PTH}>Station condition</th>
              <th className={PTH}>Action taken</th>
              <th className={PTH}>Initials</th>
              <th className={PTH}>Recorded by</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              // The strike goes on each cell's TEXT, not on the row: a
              // line-through on the <tr> would strike the void reason too, and
              // the reason is the one thing on a voided line that must read clean.
              const x = (v: React.ReactNode) => <span className={r.is_void ? 'line-through text-gray-500' : ''}>{v}</span>;
              return (
                <tr key={r.id}>
                  <td className={`${PT} whitespace-nowrap`}>{x(r.business_date)}</td>
                  <td className={PT}>{x(r.checked_at || '—')}</td>
                  <td className={`${PT} whitespace-nowrap`}>{x(r.device_code || '—')}</td>
                  <td className={PT}>{x(r.device_kind_label)}</td>
                  <td className={PT}>{x(r.location_label)}</td>
                  <td className={`${PT} font-semibold`}>{x(r.activity === '' ? 'NOT RECORDED' : r.activity_label.toUpperCase())}</td>
                  <td className={PT}>{x(r.activity === 'yes' ? r.activity_kind_label : '')}</td>
                  <td className={PT}>{x(r.device_condition ? r.device_condition_label : 'not assessed')}</td>
                  <td className={PT}>
                    {x(<>{r.action_taken}{r.ca_number ? ` · CA ${r.ca_number}` : ''}</>)}
                    {r.is_void ? <span className="block font-semibold">{voidNote(r)}</span> : null}
                  </td>
                  <td className={PT}>{x(r.initials)}</td>
                  <td className={PT}>{x(<>{r.checked_name || r.checked_by}{r.checker_kind === 'contractor' ? ' (technician)' : ''}</>)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <p className="mt-5 mb-1 font-bold text-[13px]">Stations on the map and where each stands on {sheet.to}</p>
      {sheet.stations.length === 0 ? (
        <p className="font-semibold">NO MONITORING POINT IS ON THE PEST MAP.</p>
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className={PTH}>Station</th>
              <th className={PTH}>Type</th>
              <th className={PTH}>Location</th>
              <th className={PTH}>To be checked</th>
              <th className={PTH}>Last checked</th>
              <th className={PTH}>Next due</th>
              <th className={PTH}>State</th>
            </tr>
          </thead>
          <tbody>
            {sheet.stations.map((s) => (
              <tr key={s.device_id}>
                <td className={PT}>{s.code || '—'}</td>
                <td className={PT}>{s.device_kind_label}</td>
                <td className={PT}>{s.location_label}</td>
                <td className={PT}>{s.check_frequency}{s.frequency_assumed ? ' (read as weekly)' : ''}</td>
                <td className={PT}>{s.last_check_date ? `${s.last_check_date} ${s.last_check_time}` : 'never'}</td>
                <td className={PT}>{s.due_on || '—'}</td>
                <td className={`${PT} font-semibold`}>{s.state_label.toUpperCase()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {sheet.problems.length > 0 && (
        <ul className="mt-3 list-disc pl-5 text-[11px]">
          {sheet.problems.map((p, i) => <li key={i}>{p}</li>)}
        </ul>
      )}
      <p className="mt-3 text-[10px] text-gray-700">
        Activity found at a station is also filed as a pest sighting, which carries its own closure. &ldquo;Not assessed&rdquo;
        means the station&apos;s condition was not recorded on that line; it is never read as &ldquo;in order&rdquo;.
      </p>
      <Signatures left="Checked by" right="Verified by (manager)" />
    </div>
  );
}

/* ── #78 ──────────────────────────────────────────────────────────────────── */

export function ChemicalsRegisterPrint({
  data,
}: {
  data: { from: string; to: string; visits: PestChemicalsVisit[]; totals: { visits: number; listed: number; none_applied: number; not_recorded: number; products: number }; problems: string[] };
}) {
  return (
    <div>
      <Head title="Pest-control chemicals register" sub={`What the contractor applied, visit by visit, ${data.from} to ${data.to}`} />
      <p className="mb-3 text-[11px]">
        {data.totals.visits} completed visit{data.totals.visits === 1 ? '' : 's'} · {data.totals.products} product line{data.totals.products === 1 ? '' : 's'} ·
        nothing applied on {data.totals.none_applied} · NOT RECORDED on {data.totals.not_recorded}
      </p>
      {data.visits.length === 0 && <p className="font-semibold">NO COMPLETED PEST-CONTROL VISIT IN THESE DATES.</p>}
      {data.visits.map((v) => (
        <div key={v.id} className="mb-4" style={{ pageBreakInside: 'avoid' }}>
          <p className="font-bold text-[12px]">
            {v.business_date} · {v.service_no} · {v.vendor_name || 'agency not named'}
            {v.agency_licence_no ? ` · agency licence ${v.agency_licence_no}` : ''}
            {v.technician_name ? ` · technician ${v.technician_name}` : ''}
            {v.report_no ? ` · report ${v.report_no}` : ''}
          </p>
          {v.areas_covered && <p className="text-[11px]">Areas covered: {v.areas_covered}</p>}
          <ChemicalsTable state={v.state} rows={v.chemicals as ChemRow[]} noneNote={v.none_note} visitDate={v.business_date} print />
        </div>
      ))}
      {data.problems.length > 0 && (
        <ul className="mt-3 list-disc pl-5 text-[11px]">{data.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
      )}
      <Signatures left="Recorded by" right="Verified by (manager)" />
    </div>
  );
}

/* ── one visit ────────────────────────────────────────────────────────────── */

export interface VisitForPrint {
  service_no: string; vendor_name: string; agency_licence_no: string; technician_name: string;
  service_kind_label: string; business_date: string; started_at: string; finished_at: string;
  areas_covered: string; findings: string; recommendations: string; report_no: string;
  next_due_date: string; staff_witness: string; status_label: string; missed_reason: string;
  chemicals: ChemRow[]; chemicals_state: string; chemicals_none_note: string;
  voided_at: string; voided_by: string; void_reason: string; created_by: string; created_at: string;
  ca: { ca_number: string; status: string; due_date: string; owner_email: string } | null;
  files: { id: string; filename: string; kind_label: string; created_at: string; created_by: string; is_void?: boolean; void_reason?: string; voided_by?: string }[];
}

export function VisitRecordPrint({ v }: { v: VisitForPrint }) {
  const row = (k: string, val: string) => (
    <tr><th className={`${PTH} w-48`}>{k}</th><td className={PT}>{val || '—'}</td></tr>
  );
  return (
    <div>
      <Head title={`Pest-control visit ${v.service_no}`} sub={`${v.business_date} · ${v.vendor_name || 'agency not named'} · ${v.status_label}`} />
      {v.voided_at && (
        <p className="font-bold border-2 border-black p-2 mb-3">
          THIS VISIT RECORD WAS VOIDED — {v.void_reason} ({v.voided_by}, {fmtIST(v.voided_at)}). It is kept on file.
        </p>
      )}
      <table className="w-full border-collapse mb-3">
        <tbody>
          {row('Agency', v.vendor_name)}
          {row('Agency licence no.', v.agency_licence_no)}
          {row('Technician', v.technician_name)}
          {row('Kind of visit', v.service_kind_label)}
          {row('Date', v.business_date)}
          {row('Report no.', v.report_no)}
          {row('Areas covered', v.areas_covered)}
          {row('Findings', v.findings)}
          {row('Recommendations', v.recommendations)}
          {v.missed_reason ? row('Why it did not happen', v.missed_reason) : null}
          {row('Accompanied by', v.staff_witness)}
          {row('Next visit due', v.next_due_date)}
          {v.ca ? row('Corrective action', `${v.ca.ca_number} · ${v.ca.status} · due ${v.ca.due_date} · ${v.ca.owner_email}`) : null}
          {row('Recorded by', `${v.created_by}, ${fmtIST(v.created_at)}`)}
        </tbody>
      </table>
      <p className="font-bold text-[13px] mb-1">What was applied</p>
      <ChemicalsTable state={v.chemicals_state} rows={v.chemicals} noneNote={v.chemicals_none_note} visitDate={v.business_date} print />
      <p className="font-bold text-[13px] mt-4 mb-1">Files on this record</p>
      {v.files.length === 0 ? <p>None attached.</p> : (
        <table className="w-full border-collapse">
          <thead><tr><th className={PTH}>File</th><th className={PTH}>Kind</th><th className={PTH}>Attached</th><th className={PTH}>State</th></tr></thead>
          <tbody>
            {v.files.map((f) => (
              <tr key={f.id} className={f.is_void ? 'text-gray-600' : ''}>
                <td className={PT}>{f.filename || '(photograph)'}</td>
                <td className={PT}>{f.kind_label}</td>
                <td className={PT}>{f.created_by}, {fmtIST(f.created_at)}</td>
                <td className={PT}>{f.is_void ? `VOID — ${f.void_reason} (${f.voided_by})` : 'on file'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Signatures left="Agency technician" right="Accompanied by (our staff)" />
    </div>
  );
}
