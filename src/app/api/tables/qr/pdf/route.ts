import path from 'path';
import fs from 'fs';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { getDb, newQrToken } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/tables/qr/pdf?size=A5&tables=<id,id>&base=<origin>&tagline=<t>&download=1
 *
 * Generates the QR standees as a REAL PDF at the EXACT chosen page size (A4/A5/A6),
 * one standee per page — so the download is exactly the standee size regardless of
 * the browser's print-dialog paper setting (which ignores @page size on Safari).
 * Styled with the QR-menu design tokens + the embedded Instrument Serif font.
 */

// Exact QR-menu design tokens (QR Code menu/atoms.jsx `C`).
const INK = '#231C12', INK_SOFT = '#5B4F3A', INK_MUTE = '#8E8166';
const CARD = '#FBF4DF', CARD_ELEV = '#FFF8E2', TERRA = '#B4502E', FOREST = '#2D4A3A';

const SIZES: Record<string, 'A4' | 'A5' | 'A6'> = { A4: 'A4', A5: 'A5', A6: 'A6' };

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
    const url = new URL(req.url);

    const size = SIZES[(url.searchParams.get('size') || 'A5').toUpperCase()] || 'A5';
    const base = originFrom(req, url.searchParams.get('base'));
    const tagline = (url.searchParams.get('tagline') || 'Scan · Browse · Order from your table').slice(0, 120);
    const download = url.searchParams.get('download') === '1';
    const idsParam = (url.searchParams.get('tables') || '').trim();
    const wantIds = idsParam ? new Set(idsParam.split(',').map(s => s.trim()).filter(Boolean)) : null;

    // Backfill any missing token so every selected table has a working QR.
    const missing = db.prepare("SELECT id FROM restaurant_tables WHERE (qr_token IS NULL OR qr_token='') AND (outlet_id = ? OR outlet_id IS NULL)").all(outletId) as any[];
    if (missing.length) { const s = db.prepare("UPDATE restaurant_tables SET qr_token = ? WHERE id = ?"); for (const m of missing) s.run(newQrToken(), m.id); }

    let tables = db.prepare(`
      SELECT id, table_number, zone, qr_token FROM restaurant_tables
      WHERE is_active = 1 AND (outlet_id = ? OR outlet_id IS NULL)
      ORDER BY CAST(table_number AS INTEGER), table_number
    `).all(outletId) as any[];
    if (wantIds) tables = tables.filter(t => wantIds.has(t.id));
    if (!tables.length) return Response.json({ error: 'No tables selected' }, { status: 400 });

    const brandRow = db.prepare("SELECT value FROM settings WHERE key = 'business_name'").get() as any;
    const brand = (brandRow?.value || 'Akan').toString();

    // QR PNGs (dark ink modules on the near-white card — high-contrast + on-brand).
    const qrByTable = new Map<string, Buffer>();
    for (const t of tables) {
      const menuUrl = `${base}/menu?t=${encodeURIComponent(t.qr_token)}`;
      const png = await QRCode.toBuffer(menuUrl, { type: 'png', errorCorrectionLevel: 'M', margin: 1, width: 640, color: { dark: INK, light: CARD_ELEV } });
      qrByTable.set(t.id, png);
    }

    const fontBuf = fs.readFileSync(path.join(process.cwd(), 'public', 'fonts', 'InstrumentSerif-Regular.ttf'));

    const pdf: Buffer = await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size, margin: 0 });
      doc.registerFont('serif', fontBuf);
      const chunks: Buffer[] = [];
      doc.on('data', c => chunks.push(c as Buffer));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      tables.forEach((t, i) => {
        if (i > 0) doc.addPage({ size, margin: 0 });
        drawStandee(doc, brand, t, qrByTable.get(t.id)!, tagline);
      });
      doc.end();
    });

    const filename = `table-qr-standees-${size}.pdf`;
    return new Response(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e: any) {
    console.error('[/api/tables/qr/pdf GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

// A4/A5/A6 all share the 1:√2 aspect ratio, so one set of fractional positions
// lays out identically at every size.
function drawStandee(doc: PDFKit.PDFDocument, brand: string, t: any, qr: Buffer, tagline: string) {
  const W = doc.page.width, H = doc.page.height;
  const center = (str: string, y: number, opts: any = {}) => doc.text(str, W * 0.06, y, { width: W * 0.88, align: 'center', ...opts });

  // Warm card background + soft terra/forest corner washes (echo the menu).
  doc.rect(0, 0, W, H).fill(CARD);
  doc.save().fillOpacity(0.06).fillColor(TERRA).circle(W * 0.12, H * 0.07, W * 0.55).fill().restore();
  doc.save().fillOpacity(0.07).fillColor(FOREST).circle(W * 0.9, H * 0.95, W * 0.55).fill().restore();

  doc.font('serif');
  // Brand wordmark
  doc.fontSize(W * 0.085).fillColor(INK);
  center(brand, H * 0.09);
  // TABLE eyebrow
  doc.fontSize(W * 0.028).fillColor(TERRA);
  center('TABLE', H * 0.275, { characterSpacing: W * 0.008 });
  // Table number
  doc.fontSize(W * 0.17).fillColor(INK);
  center(String(t.table_number), H * 0.30);
  // Zone
  if (t.zone) { doc.fontSize(W * 0.024).fillColor(INK_MUTE); center(String(t.zone).toUpperCase(), H * 0.455, { characterSpacing: W * 0.004 }); }

  // QR, framed on the elevated card surface
  const qs = W * 0.46, qx = (W - qs) / 2, qy = H * 0.49, pad = W * 0.022, r = W * 0.02;
  doc.roundedRect(qx - pad, qy - pad, qs + 2 * pad, qs + 2 * pad, r).fillColor(CARD_ELEV).fill();
  doc.save().lineWidth(0.6).strokeOpacity(0.12).strokeColor(INK).roundedRect(qx - pad, qy - pad, qs + 2 * pad, qs + 2 * pad, r).stroke().restore();
  doc.image(qr, qx, qy, { width: qs, height: qs });

  // Call to action + tagline
  doc.fontSize(W * 0.05).fillColor(INK);
  center('Scan to view the menu & order', H * 0.85);
  doc.fontSize(W * 0.026).fillColor(INK_SOFT);
  doc.text(tagline, W * 0.1, H * 0.90, { width: W * 0.8, align: 'center' });
}
