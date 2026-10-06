/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentOutletId, isManagement } from '@/lib/auth';
import { addDaysISO, fssaiDocState, fssaiDocType, fssaiToday, fssaiTempLogKindLabel } from '@/lib/fssai';
import { requireFssaiUser, fssaiCsrfGuard, fssaiAuditBestEffort, fssaiAppAudit, str } from '@/lib/fssai-server';
import { businessName, fssaiTablesPresent, intOr, numOrBlank } from '../_p9/lib';

/**
 * INSPECTION MODE (/api/fssai/inspection-mode) — owner §16.
 *
 * ── THE ONE RULE THAT OUTRANKS EVERYTHING ELSE ON THIS SCREEN ───────────────
 * FSSAI-BUILD-STATE.md §7 Q11, written down before this was built:
 *     "RULE FOR P9: nothing on Inspection Mode may describe what the restaurant
 *      lacks."
 * This is the one screen literally handed to a visiting officer, and every other
 * screen in the module opens by stating a gap — true sentences, written for the
 * owner, that read over a shoulder as an admission. So this route splits what it
 * knows in two, and the split IS the design:
 *
 *   · `sections` — THE HANDOVER. Real records only. A section with nothing in it
 *     says so in neutral words about THE PERIOD ("No records for these dates"),
 *     never about the premises and never about the software.
 *   · `prepare`  — MANAGEMENT'S OWN READINESS LIST, read before the tablet
 *     changes hands. This is where "that register does not exist in this copy of
 *     the database" belongs, with the technical reason, because the person
 *     reading it can act on it and nobody else is looking.
 *
 * The screen shows `prepare` first and `sections` once the manager chooses to
 * hand over. An inspector therefore never reads a sentence about a gap, and the
 * manager is never surprised by one.
 *
 * ── READ-ONLY, AND THE ONE THING IT WRITES ──────────────────────────────────
 * GET returns records and nothing else: there is no UPDATE or DELETE in this
 * file. POST does exactly one thing — it NOTES THE HANDOVER (owner §16: "Note
 * who opened it and when, so you know what was shown and on which visit"). It
 * changes no compliance record. It is a POST and not a side effect of the GET
 * deliberately: a GET that writes would log a handover every time somebody
 * refreshed the page, and the log would stop meaning anything.
 *
 * WHERE THE HANDOVER IS RECORDED, and why it is not a new entity_table.
 * fssai_audit_log's entity_table is enumerated by FSSAI_RECORD_TABLES, which is
 * also the allowlist a void route validates against; inventing
 * 'fssai_inspection_mode' there would put a row in the compliance trail naming a
 * table that does not exist, and the audit screen would render it as an unknown
 * record. So:
 *   · always → the app-wide trail (audit_events, entity_type
 *     'fssai_inspection_mode'), which is exactly what logAuditEvent is for and
 *     needs no new table;
 *   · and when the handover is linked to an inspection that was recorded, a
 *     compliance row too, entity_table 'fssai_inspections', action 'handover' —
 *     an existing table, an existing id, in the allowlist.
 *
 * MANAGEMENT ONLY (page-catalog mgmtOnly). A manager must be able to open it
 * during a visit, so it is not admin-only; an outsider must never be handed an
 * editable screen, so it is not open to everyone.
 */
export const dynamic = 'force-dynamic';

/** How much recent history the handover shows by default. */
const DEFAULT_DAYS = 7;
const RECENT_ROWS = 25;

function mgmtOnly(me: any): Response | null {
  if (!isManagement(me)) {
    return Response.json(
      { error: 'Inspection Mode is management only. Ask a manager or an administrator to open it.' },
      { status: 403 },
    );
  }
  return null;
}

/**
 * One handover section.
 *
 * `available` is for `prepare` only. The handover view renders a section with
 * `available: false` the same way it renders one with no rows — it shows nothing
 * and says nothing — because the alternative is a sentence about the software on
 * the screen an officer is reading.
 */
interface Section {
  key: string;
  title: string;
  /** What this section is, in one line an inspector can read. */
  lead: string;
  available: boolean;
  /** Only populated when available. */
  summary: Array<{ label: string; value: string }>;
  rows: any[];
  /** Management-only explanation of why it is not available. '' otherwise. */
  prepare_note: string;
}

export async function GET(request: Request) {
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me as any;
  const deny = mgmtOnly(me);
  if (deny) return deny;

  try {
    const db = getDb();
    const url = new URL(request.url);
    const today = fssaiToday();
    const present = fssaiTablesPresent(db);

    const days = (() => {
      const n = Number(url.searchParams.get('days'));
      return Number.isFinite(n) && n >= 1 && n <= 90 ? Math.trunc(n) : DEFAULT_DAYS;
    })();
    const since = addDaysISO(today, -(days - 1));

    const sections: Section[] = [];
    const notAvailable = (key: string, title: string, lead: string, why: string): Section => ({
      key, title, lead, available: false, summary: [], rows: [], prepare_note: why,
    });
    const NOT_IN_DB =
      'This register has not been created in this copy of the database yet. Restart the application once and it will be there. ' +
      'Until then this section is left out of the handover entirely rather than shown empty — an empty section would say the ' +
      'checks were not done.';

    /* ══ 1. THE LICENCE AND THE CERTIFICATES ═══════════════════════════════ */
    if (!present.has('fssai_documents')) {
      sections.push(notAvailable('documents', 'Licence and certificates', 'The licences, certificates and reports held on file.', NOT_IN_DB));
    } else {
      try {
        const rows = db.prepare(
          `SELECT id, doc_code, doc_type, title, reference_no, issuer, issued_on, valid_from,
                  expiry_date, reminder_days, person_email, vendor_id
             FROM fssai_documents
            WHERE status <> 'void' AND is_active = 1
            ORDER BY (CASE WHEN expiry_date = '' THEN 1 ELSE 0 END) ASC, expiry_date ASC`,
        ).all() as any[];
        let valid = 0; let expiring = 0; let expired = 0;
        const shaped = rows.map((r) => {
          const state = fssaiDocState(r.expiry_date, today, intOr(r.reminder_days, 30));
          if (state === 'expired') expired++; else if (state === 'expiring') expiring++; else valid++;
          return {
            id: String(r.id),
            type_label: fssaiDocType(r.doc_type)?.label || String(r.doc_type || ''),
            title: String(r.title || ''),
            reference_no: String(r.reference_no || ''),
            issuer: String(r.issuer || ''),
            issued_on: String(r.issued_on || ''),
            expiry_date: String(r.expiry_date || ''),
            state,
          };
        });
        sections.push({
          key: 'documents',
          title: 'Licence and certificates',
          lead: 'The licences, certificates and reports held on file, with the validity worked out against today.',
          available: true,
          summary: [
            { label: 'On file', value: String(rows.length) },
            { label: 'Valid', value: String(valid) },
            { label: 'Within renewal window', value: String(expiring) },
            { label: 'Past their date', value: String(expired) },
          ],
          rows: shaped,
          prepare_note: expired
            ? `${expired} document${expired === 1 ? '' : 's'} on file ${expired === 1 ? 'is' : 'are'} past its date and will show as such on the handover.`
            : '',
        });
      } catch (e: any) {
        console.error('[fssai/inspection-mode] documents failed:', e?.message);
        sections.push(notAvailable('documents', 'Licence and certificates', 'The licences, certificates and reports held on file.', 'This section could not be read.'));
      }
    }

    /* ══ 2. THE CHECKS THEMSELVES ══════════════════════════════════════════ */
    try {
      const totals = db.prepare(
        `SELECT COUNT(*) AS n,
                SUM(CASE WHEN status IN ('submitted','verified') THEN 1 ELSE 0 END) AS filed,
                SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END) AS verified,
                SUM(CASE WHEN outcome = 'fail' AND status <> 'void' THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN signed_by <> '' THEN 1 ELSE 0 END) AS signed
           FROM fssai_runs WHERE business_date >= ? AND business_date <= ?`,
      ).get(since, today) as any;
      const rows = db.prepare(
        `SELECT r.id, r.business_date, r.shift, r.target_label, r.status, r.outcome,
                r.answered_count, r.total_count, r.fail_count, r.recorded_name, r.recorded_by,
                r.signed_by, r.signed_at,
                t.name AS live_name,
                json_extract(s.after_json, '$.template.name') AS recorded_name_frozen
           FROM fssai_runs r
           LEFT JOIN fssai_templates t ON t.id = r.template_id
           LEFT JOIN fssai_audit_log s
                  ON s.entity_table = 'fssai_runs' AND s.entity_id = r.id AND s.action = 'snapshot'
          WHERE r.business_date >= ? AND r.business_date <= ? AND r.status <> 'void'
          ORDER BY r.business_date DESC, r.started_at DESC LIMIT ?`,
      ).all(since, today, RECENT_ROWS) as any[];
      sections.push({
        key: 'checks',
        title: 'Food-safety checks',
        lead: `Every round of every checklist filed from ${since} to ${today}.`,
        available: true,
        summary: [
          { label: 'Rounds', value: String(intOr(totals?.n)) },
          { label: 'Filed', value: String(intOr(totals?.filed)) },
          { label: 'Verified by a second person', value: String(intOr(totals?.verified)) },
          { label: 'Signed', value: String(intOr(totals?.signed)) },
          { label: 'Failed', value: String(intOr(totals?.failed)) },
        ],
        rows: rows.map((r) => ({
          id: String(r.id),
          business_date: String(r.business_date || ''),
          checklist: String(r.recorded_name_frozen || r.live_name || ''),
          shift: String(r.shift || ''),
          target_label: String(r.target_label || ''),
          status: String(r.status || ''),
          outcome: String(r.outcome || ''),
          answered: `${intOr(r.answered_count)}/${intOr(r.total_count)}`,
          fail_count: intOr(r.fail_count),
          by: String(r.recorded_name || r.recorded_by || ''),
          signed_by: String(r.signed_by || ''),
          signed_at: String(r.signed_at || ''),
        })),
        prepare_note: '',
      });
    } catch (e: any) {
      console.error('[fssai/inspection-mode] checks failed:', e?.message);
      sections.push(notAvailable('checks', 'Food-safety checks', 'Every round of every checklist filed in this period.', 'This section could not be read.'));
    }

    /* ══ 3. TEMPERATURE ════════════════════════════════════════════════════ */
    if (!present.has('fssai_temperature_logs')) {
      sections.push(notAvailable('temperature', 'Temperature records', 'Temperatures taken across the period, against the range in force at the time.', NOT_IN_DB));
    } else {
      try {
        const totals = db.prepare(
          `SELECT COUNT(*) AS n,
                  SUM(CASE WHEN is_fail = 1 THEN 1 ELSE 0 END) AS fails,
                  SUM(CASE WHEN is_judged = 0 THEN 1 ELSE 0 END) AS unjudged
             FROM fssai_temperature_logs
            WHERE status <> 'void' AND business_date >= ? AND business_date <= ?`,
        ).get(since, today) as any;
        const rows = db.prepare(
          `SELECT id, business_date, reading_at, log_kind, equipment_label, area_label, item_label,
                  value_num, uom, decimals, min_used, max_used, is_fail, is_judged, action_taken,
                  recorded_name, recorded_by
             FROM fssai_temperature_logs
            WHERE status <> 'void' AND business_date >= ? AND business_date <= ?
            ORDER BY business_date DESC, reading_at DESC LIMIT ?`,
        ).all(since, today, RECENT_ROWS) as any[];
        sections.push({
          key: 'temperature',
          title: 'Temperature records',
          lead: `Temperatures taken from ${since} to ${today}, each judged against the range in force at the time it was taken.`,
          available: true,
          summary: [
            { label: 'Readings', value: String(intOr(totals?.n)) },
            { label: 'Out of range', value: String(intOr(totals?.fails)) },
          ],
          rows: rows.map((r) => ({
            id: String(r.id),
            business_date: String(r.business_date || ''),
            reading_at: String(r.reading_at || ''),
            kind: fssaiTempLogKindLabel(r.log_kind),
            where_label: String(r.equipment_label || r.area_label || ''),
            item_label: String(r.item_label || ''),
            // NULL is blank. A reading nobody took must never print as 0 °C.
            reading: numOrBlank(r.value_num, intOr(r.decimals, 1)),
            uom: String(r.uom || ''),
            min_used: r.min_used === null || r.min_used === undefined ? null : Number(r.min_used),
            max_used: r.max_used === null || r.max_used === undefined ? null : Number(r.max_used),
            is_fail: intOr(r.is_fail),
            is_judged: intOr(r.is_judged, 1),
            action_taken: String(r.action_taken || ''),
            by: String(r.recorded_name || r.recorded_by || ''),
          })),
          prepare_note: intOr(totals?.unjudged)
            ? `${intOr(totals?.unjudged)} reading${intOr(totals?.unjudged) === 1 ? '' : 's'} in this period had no range configured, so ${intOr(totals?.unjudged) === 1 ? 'it was' : 'they were'} recorded without being judged.`
            : '',
        });
      } catch (e: any) {
        console.error('[fssai/inspection-mode] temperature failed:', e?.message);
        sections.push(notAvailable('temperature', 'Temperature records', 'Temperatures taken across the period.', 'This section could not be read.'));
      }
    }

    /* ══ 4. DELIVERIES ═════════════════════════════════════════════════════ */
    if (!present.has('fssai_receiving_checks')) {
      sections.push(notAvailable('receiving', 'Deliveries checked at the door', 'Deliveries inspected on arrival.', NOT_IN_DB));
    } else {
      try {
        const totals = db.prepare(
          `SELECT COUNT(*) AS n, SUM(CASE WHEN fail_count > 0 THEN 1 ELSE 0 END) AS failed,
                  SUM(rejected_count) AS rejected
             FROM fssai_receiving_checks
            WHERE status <> 'void' AND business_date >= ? AND business_date <= ?`,
        ).get(since, today) as any;
        const rows = db.prepare(
          `SELECT id, business_date, check_no, vendor_name, grn_number, supplier_licence_no,
                  supplier_licence_expiry, vehicle_no, vehicle_temp_c, line_count, fail_count,
                  rejected_count, outcome, checked_name, checked_by
             FROM fssai_receiving_checks
            WHERE status <> 'void' AND business_date >= ? AND business_date <= ?
            ORDER BY business_date DESC, received_at DESC LIMIT ?`,
        ).all(since, today, RECENT_ROWS) as any[];
        sections.push({
          key: 'receiving',
          title: 'Deliveries checked at the door',
          lead: `Deliveries inspected on arrival from ${since} to ${today}, with the supplier's licence as recorded.`,
          available: true,
          summary: [
            { label: 'Deliveries checked', value: String(intOr(totals?.n)) },
            { label: 'With a failed line', value: String(intOr(totals?.failed)) },
            { label: 'Items rejected', value: String(intOr(totals?.rejected)) },
          ],
          rows: rows.map((r) => ({
            id: String(r.id),
            business_date: String(r.business_date || ''),
            check_no: String(r.check_no || ''),
            vendor_name: String(r.vendor_name || ''),
            grn_number: String(r.grn_number || ''),
            supplier_licence_no: String(r.supplier_licence_no || ''),
            supplier_licence_expiry: String(r.supplier_licence_expiry || ''),
            vehicle_no: String(r.vehicle_no || ''),
            vehicle_temp_c: numOrBlank(r.vehicle_temp_c, 1),
            line_count: intOr(r.line_count),
            fail_count: intOr(r.fail_count),
            rejected_count: intOr(r.rejected_count),
            outcome: String(r.outcome || ''),
            by: String(r.checked_name || r.checked_by || ''),
          })),
          prepare_note: '',
        });
      } catch (e: any) {
        console.error('[fssai/inspection-mode] receiving failed:', e?.message);
        sections.push(notAvailable('receiving', 'Deliveries checked at the door', 'Deliveries inspected on arrival.', 'This section could not be read.'));
      }
    }

    /* ══ 5. PEST CONTROL ═══════════════════════════════════════════════════ */
    if (!present.has('fssai_pest_services')) {
      sections.push(notAvailable('pest', 'Pest control', 'Contracted visits and what the technician found.', NOT_IN_DB));
    } else {
      try {
        const rows = db.prepare(
          `SELECT id, service_no, business_date, vendor_name, agency_licence_no, technician_name,
                  service_kind, areas_covered, findings, recommendations, next_due_date, status, staff_witness
             FROM fssai_pest_services
            WHERE status <> 'void'
            ORDER BY business_date DESC LIMIT 12`,
        ).all() as any[];
        const sightings = present.has('fssai_pest_sightings')
          ? (db.prepare(
              `SELECT COUNT(*) AS n, SUM(CASE WHEN closed_at = '' THEN 1 ELSE 0 END) AS open
                 FROM fssai_pest_sightings WHERE status <> 'void' AND business_date >= ?`,
            ).get(since) as any)
          : { n: 0, open: 0 };
        const next = rows.find((r) => String(r.next_due_date || ''));
        sections.push({
          key: 'pest',
          title: 'Pest control',
          lead: 'The contracted visits, what the technician treated and found, and when the next visit is due.',
          available: true,
          summary: [
            { label: 'Visits on file', value: String(rows.length) },
            { label: 'Next visit due', value: String(next?.next_due_date || '') },
            { label: 'Sightings reported in this period', value: String(intOr(sightings?.n)) },
          ],
          rows: rows.map((r) => ({
            id: String(r.id),
            service_no: String(r.service_no || ''),
            business_date: String(r.business_date || ''),
            vendor_name: String(r.vendor_name || ''),
            agency_licence_no: String(r.agency_licence_no || ''),
            technician_name: String(r.technician_name || ''),
            service_kind: String(r.service_kind || ''),
            areas_covered: String(r.areas_covered || ''),
            findings: String(r.findings || ''),
            recommendations: String(r.recommendations || ''),
            next_due_date: String(r.next_due_date || ''),
            status: String(r.status || ''),
            staff_witness: String(r.staff_witness || ''),
          })),
          prepare_note: intOr(sightings?.open)
            ? `${intOr(sightings?.open)} pest sighting${intOr(sightings?.open) === 1 ? '' : 's'} reported in this period ${intOr(sightings?.open) === 1 ? 'is' : 'are'} still open.`
            : '',
        });
      } catch (e: any) {
        console.error('[fssai/inspection-mode] pest failed:', e?.message);
        sections.push(notAvailable('pest', 'Pest control', 'Contracted visits and what the technician found.', 'This section could not be read.'));
      }
    }

    /* ══ 6. WATER AND ICE ══════════════════════════════════════════════════ */
    if (!present.has('fssai_water_tests')) {
      sections.push(notAvailable('water', 'Water and ice', 'Water and ice checks, and the laboratory reports held.', NOT_IN_DB));
    } else {
      try {
        const rows = db.prepare(
          `SELECT id, business_date, test_kind, source_point, value_num, uom, decimals, result,
                  lab_name, report_no, report_date, next_due_date, is_fail, is_judged
             FROM fssai_water_tests
            WHERE status <> 'void'
            ORDER BY business_date DESC LIMIT ?`,
        ).all(RECENT_ROWS) as any[];
        sections.push({
          key: 'water',
          title: 'Water and ice',
          lead: 'The water and ice checks on file, and the laboratory reports behind them.',
          available: true,
          summary: [
            { label: 'Tests on file', value: String(rows.length) },
            { label: 'Laboratory reports', value: String(rows.filter((r) => String(r.report_no || '')).length) },
          ],
          rows: rows.map((r) => ({
            id: String(r.id),
            business_date: String(r.business_date || ''),
            test_kind: String(r.test_kind || ''),
            source_point: String(r.source_point || ''),
            reading: numOrBlank(r.value_num, intOr(r.decimals, 2)),
            uom: String(r.uom || ''),
            result: String(r.result || ''),
            lab_name: String(r.lab_name || ''),
            report_no: String(r.report_no || ''),
            report_date: String(r.report_date || ''),
            next_due_date: String(r.next_due_date || ''),
            is_fail: intOr(r.is_fail),
            is_judged: intOr(r.is_judged, 1),
          })),
          prepare_note: '',
        });
      } catch (e: any) {
        console.error('[fssai/inspection-mode] water failed:', e?.message);
        sections.push(notAvailable('water', 'Water and ice', 'Water and ice checks, and the laboratory reports held.', 'This section could not be read.'));
      }
    }

    /* ══ 7. CORRECTIVE ACTIONS — the proof a problem was dealt with ════════ */
    if (!present.has('fssai_corrective_actions')) {
      sections.push(notAvailable('corrective', 'What was found and what was done', 'Each problem found, who fixed it, and who checked the fix.', NOT_IN_DB));
    } else {
      try {
        const totals = db.prepare(
          `SELECT COUNT(*) AS n,
                  SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END) AS verified,
                  SUM(CASE WHEN status IN ('open','in_progress') THEN 1 ELSE 0 END) AS still_open
             FROM fssai_corrective_actions WHERE status <> 'cancelled'`,
        ).get() as any;
        const rows = db.prepare(
          `SELECT id, ca_number, title, severity, status, owner_email, due_date,
                  action_taken, completed_at, completed_by, verified_by, verified_at, verify_note
             FROM fssai_corrective_actions
            WHERE status <> 'cancelled'
            ORDER BY (CASE WHEN status IN ('open','in_progress') THEN 0 ELSE 1 END) ASC,
                     (CASE WHEN due_date = '' THEN 1 ELSE 0 END) ASC, due_date ASC
            LIMIT ?`,
        ).all(RECENT_ROWS) as any[];
        sections.push({
          key: 'corrective',
          title: 'What was found and what was done',
          lead: 'Each problem a check found, what was done about it, and who checked that the fix was enough.',
          available: true,
          summary: [
            { label: 'On file', value: String(intOr(totals?.n)) },
            { label: 'Fixed and checked', value: String(intOr(totals?.verified)) },
            { label: 'Being worked on', value: String(intOr(totals?.still_open)) },
          ],
          rows: rows.map((r) => ({
            id: String(r.id),
            ca_number: String(r.ca_number || ''),
            title: String(r.title || ''),
            severity: String(r.severity || ''),
            status: String(r.status || ''),
            owner_email: String(r.owner_email || ''),
            due_date: String(r.due_date || ''),
            action_taken: String(r.action_taken || ''),
            completed_at: String(r.completed_at || ''),
            completed_by: String(r.completed_by || ''),
            verified_by: String(r.verified_by || ''),
            verified_at: String(r.verified_at || ''),
            verify_note: String(r.verify_note || ''),
            overdue: ['open', 'in_progress'].includes(String(r.status)) && !!String(r.due_date || '') && String(r.due_date) < today,
          })),
          prepare_note: '',
        });
      } catch (e: any) {
        console.error('[fssai/inspection-mode] corrective failed:', e?.message);
        sections.push(notAvailable('corrective', 'What was found and what was done', 'Each problem found and what was done.', 'This section could not be read.'));
      }
    }

    /* ══ 8. PREVIOUS VISITS ════════════════════════════════════════════════ */
    if (!present.has('fssai_inspections')) {
      sections.push(notAvailable('inspections', 'Previous visits', 'Earlier inspections and how each point was closed.', NOT_IN_DB));
    } else {
      try {
        const rows = db.prepare(
          `SELECT id, inspection_no, business_date, inspection_kind, authority, inspector_name,
                  score, score_max, grade, outcome, finding_count, open_count, status
             FROM fssai_inspections WHERE status <> 'void'
            ORDER BY business_date DESC LIMIT 12`,
        ).all() as any[];
        sections.push({
          key: 'inspections',
          title: 'Previous visits',
          lead: 'Earlier inspections and audits, with how many points each raised and how many are closed.',
          available: true,
          summary: [
            { label: 'Visits on file', value: String(rows.length) },
            { label: 'Points still open', value: String(rows.reduce((s, r) => s + intOr(r.open_count), 0)) },
          ],
          rows: rows.map((r) => ({
            id: String(r.id),
            inspection_no: String(r.inspection_no || ''),
            business_date: String(r.business_date || ''),
            inspection_kind: String(r.inspection_kind || ''),
            authority: String(r.authority || ''),
            inspector_name: String(r.inspector_name || ''),
            score: r.score === null || r.score === undefined ? null : Number(r.score),
            score_max: r.score_max === null || r.score_max === undefined ? null : Number(r.score_max),
            grade: String(r.grade || ''),
            outcome: String(r.outcome || ''),
            finding_count: intOr(r.finding_count),
            open_count: intOr(r.open_count),
            status: String(r.status || ''),
          })),
          prepare_note: '',
        });
      } catch (e: any) {
        console.error('[fssai/inspection-mode] inspections failed:', e?.message);
        sections.push(notAvailable('inspections', 'Previous visits', 'Earlier inspections and how each point was closed.', 'This section could not be read.'));
      }
    }

    /* ══ RECENT HANDOVERS — read from the app-wide trail ═══════════════════ */
    let handovers: any[] = [];
    try {
      handovers = db.prepare(
        `SELECT id, actor_email, note, after_json, created_at
           FROM audit_events
          WHERE entity_type = 'fssai_inspection_mode'
          ORDER BY created_at DESC LIMIT 10`,
      ).all() as any[];
    } catch { handovers = []; }

    /* Open inspections a handover can be attached to, so the note lands against
     * the visit rather than floating. */
    let openInspections: any[] = [];
    if (present.has('fssai_inspections')) {
      try {
        openInspections = db.prepare(
          `SELECT id, inspection_no, business_date, authority, inspector_name, status
             FROM fssai_inspections
            WHERE status IN ('planned','in_progress','open')
            ORDER BY business_date DESC LIMIT 20`,
        ).all() as any[];
      } catch { openInspections = []; }
    }

    return Response.json({
      today,
      days,
      since,
      business_name: businessName(db),
      opened_by: { email: String(me.email || ''), name: String(me.name || '') },
      sections,
      /* MANAGEMENT'S READINESS LIST. Everything that would otherwise have to be
       * said on the handover screen itself lives here instead. */
      prepare: {
        ready: sections.filter((s) => s.available).map((s) => s.key),
        not_in_handover: sections.filter((s) => !s.available).map((s) => ({ key: s.key, title: s.title, why: s.prepare_note })),
        warnings: sections.filter((s) => s.available && s.prepare_note).map((s) => ({ key: s.key, title: s.title, note: s.prepare_note })),
      },
      recent_handovers: handovers.map((h) => {
        let detail: any = null;
        try { detail = h.after_json ? JSON.parse(String(h.after_json)) : null; } catch { detail = null; }
        return {
          id: String(h.id),
          at: String(h.created_at || ''),
          by: String(h.actor_email || ''),
          note: String(h.note || ''),
          inspector_name: String(detail?.inspector_name || ''),
          authority: String(detail?.authority || ''),
          inspection_id: String(detail?.inspection_id || ''),
        };
      }),
      open_inspections: openInspections,
      generated_at: new Date().toISOString(),
    });
  } catch (e: any) {
    console.error('GET /api/fssai/inspection-mode failed:', e);
    return Response.json({ error: e?.message || 'Failed to assemble the handover' }, { status: 500 });
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * POST — note the handover. It changes no compliance record.
 * ══════════════════════════════════════════════════════════════════════════ */

export async function POST(request: Request) {
  const csrf = fssaiCsrfGuard(request);
  if (csrf) return csrf;

  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me as any;
  const deny = mgmtOnly(me);
  if (deny) return deny;

  let body: any = {};
  try { body = await request.json(); } catch { body = {}; }

  try {
    const db = getDb();
    const outletId = (await getCurrentOutletId()) || '';
    const inspectorName = str(body?.inspector_name);
    const authority = str(body?.authority);
    const note = str(body?.note);
    let inspectionId = str(body?.inspection_id);

    if (!inspectorName && !authority) {
      return Response.json(
        { error: 'Say who the screen is being shown to — the inspector’s name, the authority, or both. A handover with neither cannot be looked up later.' },
        { status: 400 },
      );
    }

    /* An inspection id is accepted only if that visit really exists. A note
     * pointing at nothing is worse than a note pointing at the trail alone. */
    if (inspectionId) {
      const exists = fssaiTablesPresent(db).has('fssai_inspections')
        ? (db.prepare(`SELECT id FROM fssai_inspections WHERE id = ?`).get(inspectionId) as any)
        : null;
      if (!exists) return Response.json({ error: 'That inspection does not exist.' }, { status: 400 });
    } else {
      inspectionId = '';
    }

    const detail = {
      inspector_name: inspectorName,
      authority,
      inspection_id: inspectionId,
      opened_by: String(me.email || ''),
      at: new Date().toISOString(),
    };
    const words = `Inspection Mode shown to ${[inspectorName, authority].filter(Boolean).join(' — ')}${note ? `. ${note}` : ''}`;

    /* The app-wide trail: exactly what logAuditEvent exists for, and it never
     * throws, so a handover can never be refused because a log row failed. */
    fssaiAppAudit(db, {
      event_type: 'fssai_inspection_mode_opened',
      entity_type: 'fssai_inspection_mode',
      entity_id: inspectionId || String(me.email || ''),
      actor_email: String(me.email || ''),
      after: detail,
      note: words,
    });

    /* And, when it belongs to a recorded visit, the compliance trail too — an
     * existing table from FSSAI_RECORD_TABLES, never an invented one. */
    if (inspectionId) {
      fssaiAuditBestEffort(db, {
        entity_table: 'fssai_inspections',
        entity_id: inspectionId,
        action: 'handover',
        field: 'inspection_mode',
        after: detail,
        reason: words,
        actor: { email: me.email || '', name: me.name || '' },
        outlet_id: outletId,
      });
    }

    return Response.json({
      noted: true,
      at: detail.at,
      linked_to_inspection: !!inspectionId,
      message: inspectionId
        ? 'Noted against that inspection, and in the application’s own trail.'
        : 'Noted in the application’s own trail. Record the visit under Inspection Reports to attach it to a visit as well.',
    });
  } catch (e: any) {
    console.error('POST /api/fssai/inspection-mode failed:', e);
    return Response.json({ error: e?.message || 'Could not note the handover' }, { status: 500 });
  }
}
