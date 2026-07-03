import path from 'path';
import fs from 'fs';
import QRCode from 'qrcode';
import { getDb, newQrToken } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId, requireRole } from '@/lib/auth';

const TEMPLATE_PATH = path.join(process.cwd(), 'public', 'standee-template.pdf');
const LOGO_PATH = path.join(process.cwd(), 'public', 'akan-logo.png');

/**
 * Customer QR standee management (STAFF).
 *
 * GET  /api/tables/qr?base=<origin>  → every table with its qr_token, the full
 *      menu URL, and a ready-to-print SVG QR code. `base` defaults to the
 *      request's own origin (so the QR points back at whatever host staff use);
 *      pass ?base=https://fnb.akanhyd.com to print production standees from a
 *      testing environment.
 * POST /api/tables/qr  { mode: 'missing' | 'all' }  (admin) → (re)generate tokens.
 *      'missing' only fills blanks; 'all' rotates every token (invalidates any
 *      already-printed standees).
 */

function originFrom(req: Request, override?: string | null): string {
  if (override && /^https?:\/\//i.test(override)) return override.replace(/\/+$/, '');
  const host = req.headers.get('host') || 'localhost:3001';
  const proto = req.headers.get('x-forwarded-proto') || (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

export async function GET(req: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const outletId = await getCurrentOutletId();
    const base = originFrom(req, new URL(req.url).searchParams.get('base'));

    // Backfill any table still missing a token so the standee sheet is complete.
    const missing = db.prepare("SELECT id FROM restaurant_tables WHERE (qr_token IS NULL OR qr_token='') AND (outlet_id = ? OR outlet_id IS NULL)").all(outletId) as any[];
    if (missing.length) {
      const set = db.prepare("UPDATE restaurant_tables SET qr_token = ?, updated_at = datetime('now') WHERE id = ?");
      for (const m of missing) set.run(newQrToken(), m.id);
    }

    const rows = db.prepare(`
      SELECT id, table_number, zone, seats, qr_token
      FROM restaurant_tables
      WHERE is_active = 1 AND (outlet_id = ? OR outlet_id IS NULL)
      ORDER BY CAST(table_number AS INTEGER), table_number
    `).all(outletId) as any[];

    // When a template is uploaded, colour the preview QR like the template's
    // cream card so the on-page preview matches the printed standee.
    const hasTemplate = fs.existsSync(TEMPLATE_PATH);
    const qrColor = hasTemplate ? { dark: '#171008', light: '#FBE8CF' } : { dark: '#231C12', light: '#FFF8E2' };
    const tables = await Promise.all(rows.map(async (r) => {
      const menuUrl = `${base}/menu?t=${encodeURIComponent(r.qr_token)}`;
      const qrSvg = await QRCode.toString(menuUrl, {
        type: 'svg', margin: hasTemplate ? 1 : 0, errorCorrectionLevel: 'M', color: qrColor,
      });
      return {
        id: r.id,
        table_number: String(r.table_number),
        zone: r.zone || '',
        seats: r.seats,
        qr_token: r.qr_token,
        menu_url: menuUrl,
        qr_svg: qrSvg,
      };
    }));

    // Brand for the standee header.
    const brandRow = db.prepare("SELECT value FROM settings WHERE key = 'business_name'").get() as any;
    const brand = (brandRow?.value || 'Akan').toString();

    return Response.json({ tables, base, brand, hasTemplate, hasLogo: fs.existsSync(LOGO_PATH) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    console.error('[/api/tables/qr GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const gate = await requireRole('admin');
    if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });
    const db = getDb();
    const outletId = await getCurrentOutletId();
    const body = await req.json().catch(() => ({}));
    const mode = String(body?.mode || 'missing');

    const where = mode === 'all'
      ? "(outlet_id = ? OR outlet_id IS NULL)"
      : "(qr_token IS NULL OR qr_token='') AND (outlet_id = ? OR outlet_id IS NULL)";
    const rows = db.prepare(`SELECT id FROM restaurant_tables WHERE ${where}`).all(outletId) as any[];
    const set = db.prepare("UPDATE restaurant_tables SET qr_token = ?, updated_at = datetime('now') WHERE id = ?");
    const tx = db.transaction(() => { for (const r of rows) set.run(newQrToken(), r.id); });
    tx();

    return Response.json({ ok: true, updated: rows.length, mode });
  } catch (e: any) {
    console.error('[/api/tables/qr POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
