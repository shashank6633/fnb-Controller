import { getCurrentUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { fail, outletsForUser, requireStaff } from '@/lib/valet/core';
import { hasValetCap } from '@/lib/valet/caps';
import { valetReport, reportCsv } from '@/lib/valet/reports';
import { rateLimit } from '@/lib/valet/credentials';
import { valetJson, NO_STORE } from '@/lib/valet/http';

/**
 * GET ?outlet=<id|all>&from=YYYY-MM-DD&to=YYYY-MM-DD[&shift_from=HH:MM&shift_to=HH:MM][&format=csv]
 * Valet Head (their assigned outlets) or admin (every outlet). 'all' means all
 * outlets THIS caller may see — never more. The CSV is formula-safe.
 */
export const dynamic = 'force-dynamic';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const csv = url.searchParams.get('format') === 'csv';
  return valetJson(async () => {
    const db = getDb();
    const user = await getCurrentUser();
    if (!user) fail(401, 'sign_in', 'Please sign in again.');
    if (!hasValetCap(user!, 'head')) fail(403, 'no_capability', 'Valet reports are for the Valet Head or the owner.');
    const outlet = url.searchParams.get('outlet') || '';
    let ids: string[];
    if (outlet === 'all') ids = outletsForUser(db, user!).map(o => o.id);
    else { requireStaff(db, user, outlet, 'head', { allowDisabled: true }); ids = [outlet]; }
    if (!ids.length) fail(403, 'not_assigned', 'You are not assigned to any outlet for valet.');
    const from = url.searchParams.get('from') || '', to = url.searchParams.get('to') || '';
    if (!DATE.test(from) || !DATE.test(to) || from > to) fail(400, 'dates', 'Choose a valid date range.');
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 370) fail(400, 'range', 'Choose at most one year.');
    const sf = url.searchParams.get('shift_from') || '', st = url.searchParams.get('shift_to') || '';
    const shift = HM.test(sf) && HM.test(st) ? { shiftFrom: sf, shiftTo: st } : {};
    if (!rateLimit(db, `valet-report:${user!.id}`, 30, 60)) fail(429, 'slow_down', 'Too many report requests. Wait a minute.');
    const r = valetReport(db, { outletIds: ids, from, to, ...shift });
    if (!r) fail(404, 'none', 'No outlet to report on.');
    if (csv) {
      return new Response('﻿' + reportCsv(r!), { headers: { ...NO_STORE, 'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="valet-report-${from}-to-${to}.csv"` } });
    }
    return r;
  });
}
