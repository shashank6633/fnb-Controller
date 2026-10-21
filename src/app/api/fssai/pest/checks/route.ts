/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentOutletId, isManagement } from '@/lib/auth';
import { canManageFssaiCa, fssaiToday, isISODate, FSSAI_CA_SEVERITIES } from '@/lib/fssai';
import { requireFssaiUser, fssaiCsrfGuard, str } from '@/lib/fssai-server';
import { fssaiVoidableRecord, fssaiVoidRefusalForRecord, voidFssaiRecord, fssaiTableExists } from '@/lib/fssai-void';
import { nextP6CaNumber, p6ConstraintMessage } from '../../p6-shared';
import {
  submitPestRound, readPestCheck, readPestRound, readPestMonitoringSheet, pestStationCoverage,
  readPestChemicalsApplied, raisePestCheckCa, PEST_CHECKER_KINDS,
} from '../_pest/monitoring';

/**
 * PEST CONTROL — THE MONITORING SHEET, STATION BY STATION (#113).
 * /api/fssai/pest/checks
 *
 * The rules a walk is refused on, and what it writes, are in
 * ../_pest/monitoring.ts — this route is the gate around them.
 *
 * WHO. Filing a walk is open to EVERY signed-in user, like a sighting: the
 * person who walks the stations at closing is usually a kitchen steward, and a
 * sheet only a manager may write is a sheet nobody writes. Voiding a line and
 * raising a corrective action are management, as everywhere else in FSSAI.
 *
 *   GET  ?round_id=<id>                    one walk, every line
 *   GET  ?id=<id>                          one line
 *   GET  ?sheet=1&from=&to=[&device_id=]   the printable sheet: lines, rounds, coverage
 *   GET  ?coverage=1                       every station in use and whether it is due
 *   GET  ?chemicals=1&from=&to=            the chemicals register (#78), for the print
 *   POST { action: 'submit_round', business_date, checked_at, checker_kind, service_id,
 *          initials, backdate_reason, checks: [{ device_id, activity, activity_kind,
 *          evidence_kind, severity, device_condition, action_taken, initials, note }] }
 *   POST { action: 'void', id, reason }    one line, through the module's shared void
 *   POST { action: 'raise_ca', id, owner_email, severity, title, description }
 *
 * NO DELETE (§19) — a route file that exports no DELETE answers 405.
 */
export const dynamic = 'force-dynamic';

const TABLE = 'fssai_pest_device_checks';

export async function GET(request: Request) {
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;
  try {
    const db = getDb();
    if (!fssaiTableExists(db, TABLE)) {
      return Response.json({ error: 'The monitoring sheet has not been set up on this database yet. Restart the app once so it can create it.' }, { status: 503 });
    }
    const url = new URL(request.url);
    const today = fssaiToday();
    const base = {
      can_record: true,
      can_void: canManageFssaiCa(me),
      can_raise: canManageFssaiCa(me),
      is_management: isManagement(me),
      me: me.email,
      today,
      checker_kinds: PEST_CHECKER_KINDS,
    };

    const id = str(url.searchParams.get('id'));
    if (id) {
      const row = readPestCheck(db, id);
      if (!row) return Response.json({ error: 'That station check is not on the sheet.' }, { status: 404 });
      return Response.json({ ...base, check: row });
    }
    const roundId = str(url.searchParams.get('round_id'));
    if (roundId) {
      const rows = readPestRound(db, roundId);
      if (!rows.length) return Response.json({ error: 'That walk is not on the sheet.' }, { status: 404 });
      return Response.json({ ...base, round_id: roundId, rows });
    }
    if (str(url.searchParams.get('coverage')) === '1') {
      return Response.json({ ...base, stations: pestStationCoverage(db, today) });
    }
    const from = str(url.searchParams.get('from'));
    const to = str(url.searchParams.get('to'));
    if ((from && !isISODate(from)) || (to && !isISODate(to))) {
      return Response.json({ error: 'Use the date pickers for the period.' }, { status: 400 });
    }
    if (from && to && from > to) return Response.json({ error: 'The period ends before it starts.' }, { status: 400 });
    if (str(url.searchParams.get('chemicals')) === '1') {
      return Response.json({ ...base, ...readPestChemicalsApplied(db, { from, to }) });
    }
    // Default (and ?sheet=1): the sheet for the period, last 30 days unless given.
    const sheet = readPestMonitoringSheet(db, { from, to, today, deviceId: str(url.searchParams.get('device_id')) });
    return Response.json({ ...base, sheet });
  } catch (e: any) {
    console.error('GET /api/fssai/pest/checks failed:', e);
    return Response.json({ error: e?.message || 'Failed to load the monitoring sheet' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const csrf = fssaiCsrfGuard(request);
  if (csrf) return csrf;
  const g = await requireFssaiUser();
  if ('resp' in g) return g.resp;
  const me = g.me;

  let body: any = {};
  try { body = await request.json(); } catch { body = {}; }
  const action = str(body.action);

  try {
    const db = getDb();
    if (!fssaiTableExists(db, TABLE)) {
      return Response.json({ error: 'The monitoring sheet has not been set up on this database yet. Restart the app once so it can create it.' }, { status: 503 });
    }
    const outletId = (await getCurrentOutletId()) || '';

    /* ── FILE A WALK — open to every signed-in user ──────────────────────── */
    if (action === 'submit_round') {
      const out = submitPestRound(db, { input: body, me: { email: me.email, name: me.name }, outletId });
      if ('error' in out) return Response.json({ error: out.error, line: out.line }, { status: out.status });
      return Response.json({
        ...out,
        advice: out.sightings_raised.length
          ? `Activity was found at ${out.sightings_raised.length} station${out.sightings_raised.length === 1 ? '' : 's'}. Each is now a sighting — a manager closes it, or raises a corrective action against it, on the Sightings tab.`
          : out.fails
            ? 'A station is not in order. A manager can raise a corrective action against that line.'
            : 'Walk filed. Every station on it is stamped as checked.',
      });
    }

    const id = str(body.id);
    if (!id) return Response.json({ error: 'Which line of the sheet?' }, { status: 400 });
    const row = db.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).get(id) as any;
    if (!row) return Response.json({ error: 'That station check is not on the sheet.' }, { status: 404 });

    /* ── VOID ONE LINE — the module's shared void, so the rule is one rule ── */
    if (action === 'void') {
      const desc = fssaiVoidableRecord(TABLE);
      if (!desc) {
        // FSSAI_RECORD_TABLES / fssai-void.ts EXTRA must name this table. If a
        // merge ever drops it, refuse in words rather than writing a void that
        // the audit surface cannot enumerate.
        return Response.json({ error: 'Station checks are not registered as a voidable record. Nothing was changed.' }, { status: 500 });
      }
      const reason = str(body.reason).trim();
      const refusal = fssaiVoidRefusalForRecord(me as any, row, reason, desc);
      if (refusal) return Response.json({ error: refusal }, { status: /already been voided/.test(refusal) ? 409 : 403 });
      const out = voidFssaiRecord(db, { desc, row, reason, actor: { email: me.email, name: me.name, role: me.role }, outletId });
      if ('conflict' in out) return Response.json({ error: out.conflict }, { status: 409 });
      return Response.json({
        check: readPestCheck(db, id),
        voided: true,
        note: str(row.sighting_id)
          ? 'The line is voided. The sighting it raised is its own record — void or close it on the Sightings tab if it too was a mistake.'
          : 'The line is voided; it stays on the sheet, marked, with your reason.',
      });
    }

    /* ── RAISE A CORRECTIVE ACTION FROM A FAILING LINE ───────────────────── */
    if (action === 'raise_ca') {
      if (!canManageFssaiCa(me)) return Response.json({ error: 'Only a manager, head of department or administrator can raise a corrective action.' }, { status: 403 });
      const check = readPestCheck(db, id)!;
      if (check.is_void) return Response.json({ error: 'That line has been voided.' }, { status: 409 });
      if (check.ca_id) return Response.json({ error: `Corrective action ${check.ca_number || ''} has already been raised for this line.` }, { status: 409 });
      if (!check.is_fail) return Response.json({ error: 'This station was in order with no activity, so there is nothing to correct.' }, { status: 409 });
      const severity = FSSAI_CA_SEVERITIES.some((s) => s.key === str(body.severity)) ? str(body.severity) : 'high';
      const out = db.transaction(() => {
        const caNumber = nextP6CaNumber(db, check.business_date || fssaiToday());
        return raisePestCheckCa(db, {
          check,
          title: str(body.title) || `Station ${check.device_code || '?'} — ${check.activity === 'yes' ? `${check.activity_kind_label} activity` : 'not in order'}`,
          description: [
            `Raised from the pest monitoring sheet: station ${check.device_code} (${check.location_label}) on ${check.business_date} ${check.checked_at}.`,
            check.activity === 'yes' ? `Activity: ${check.activity_kind_label}.` : '',
            check.device_condition === 'not_ok' ? 'The station was not in order.' : '',
            check.action_taken ? `Done at the time: ${check.action_taken}` : '',
            `Initials on the sheet: ${check.initials}.`,
            str(body.description),
          ].filter(Boolean).join('\n'),
          severity, owner_email: str(body.owner_email),
          me: { email: me.email, name: me.name }, outlet_id: outletId, ca_number: caNumber,
        });
      })();
      if ('error' in out) return Response.json({ error: out.error }, { status: out.status });
      return Response.json({ check: readPestCheck(db, id), raised: out });
    }

    return Response.json({ error: `"${action || '(none)'}" is not something this screen can do.` }, { status: 400 });
  } catch (e: any) {
    console.error('POST /api/fssai/pest/checks failed:', e);
    const msg = p6ConstraintMessage(e, '');
    if (msg) return Response.json({ error: msg }, { status: 409 });
    return Response.json({ error: e?.message || 'Could not save the monitoring sheet' }, { status: 500 });
  }
}
