import path from 'path';
import fs from 'fs';
import PDFDocument from 'pdfkit';
import { PDFDocument as PDFLib, rgb, StandardFonts } from 'pdf-lib';
import QRCode from 'qrcode';
import { getDb, newQrToken } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/tables/qr/pdf?tables=<id,id>&base=<origin>&download=1[&size=A5]
 *
 * Generates the QR standees as a REAL PDF at the EXACT page size, one standee
 * per page — so the download is exactly the standee size regardless of the
 * browser's print-dialog paper setting.
 *
 * If public/standee-template.pdf exists (the user's uploaded Illustrator design,
 * exported to PDF), each page = that template UNCHANGED with the table's unique
 * QR stamped onto the QR card + the table number added. Otherwise it falls back
 * to a generated standee at the requested A4/A5/A6 size.
 */

// Design tokens (QR Code menu/atoms.jsx `C`) for the generated fallback.
const INK = '#231C12', INK_SOFT = '#5B4F3A', INK_MUTE = '#8E8166';
const CARD = '#FBF4DF', CARD_ELEV = '#FFF8E2', TERRA = '#B4502E', FOREST = '#2D4A3A';

// Placement for the uploaded "Akan 4×6" template, as fractions of the page so it
// is resolution-independent. Values validated against the design's cream QR card.
const TPL = {
  qrCxF: 0.5010,   // QR centre X (fraction of width)
  qrCyF: 0.6107,   // QR centre Y (fraction of height, from BOTTOM — pdf-lib origin)
  qrSizeF: 0.4653, // QR size (fraction of width) — covers the card's QR footprint
  labelYF: 0.3800, // "TABLE n" baseline (fraction of height, from bottom) — centred in the gap between the QR card and the "Scan to" line
  labelSizeF: 0.059, // label font size (fraction of width)
  cream: '#FBE8CF',  // the card colour (sampled) — the QR light modules blend into it
  dark: '#171008',   // QR dark modules
};

const SIZES: Record<string, 'A4' | 'A5' | 'A6'> = { A4: 'A4', A5: 'A5', A6: 'A6' };
const TEMPLATE_PATH = path.join(process.cwd(), 'public', 'standee-template.pdf');

function originFrom(req: Request, override?: string | null): string {
  if (override && /^https?:\/\//i.test(override)) return override.replace(/\/+$/, '');
  const host = req.headers.get('host') || 'localhost:3001';
  const proto = req.headers.get('x-forwarded-proto') || (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}
function hex(h: string) { h = h.replace('#', ''); return rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255); }

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
    const showNum = url.searchParams.get('num') !== '0';   // template mode: show TABLE n
    const idsParam = (url.searchParams.get('tables') || '').trim();
    const oneId = url.searchParams.get('one');              // preview a single table
    const wantIds = idsParam ? new Set(idsParam.split(',').map(s => s.trim()).filter(Boolean)) : null;

    const missing = db.prepare("SELECT id FROM restaurant_tables WHERE (qr_token IS NULL OR qr_token='') AND (outlet_id = ? OR outlet_id IS NULL)").all(outletId) as any[];
    if (missing.length) { const s = db.prepare("UPDATE restaurant_tables SET qr_token = ? WHERE id = ?"); for (const m of missing) s.run(newQrToken(), m.id); }

    let tables = db.prepare(`
      SELECT id, table_number, zone, qr_token FROM restaurant_tables
      WHERE is_active = 1 AND (outlet_id = ? OR outlet_id IS NULL)
      ORDER BY CAST(table_number AS INTEGER), table_number
    `).all(outletId) as any[];
    if (oneId) tables = tables.filter(t => t.id === oneId);
    else if (wantIds) tables = tables.filter(t => wantIds.has(t.id));
    if (!tables.length) return Response.json({ error: 'No tables selected' }, { status: 400 });

    const brandRow = db.prepare("SELECT value FROM settings WHERE key = 'business_name'").get() as any;
    const brand = (brandRow?.value || 'Akan').toString();

    const urlFor = (t: any) => `${base}/menu?t=${encodeURIComponent(t.qr_token)}`;
    const useTemplate = fs.existsSync(TEMPLATE_PATH);

    const pdf = useTemplate
      ? await buildFromTemplate(tables, urlFor, showNum)
      : await buildGenerated(tables, urlFor, brand, tagline, size);

    const suffix = useTemplate ? 'akan' : size;
    return new Response(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="table-qr-standees-${suffix}.pdf"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e: any) {
    console.error('[/api/tables/qr/pdf GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

// ── Overlay the QR + table number onto the user's uploaded template ──────────
async function buildFromTemplate(tables: any[], urlFor: (t: any) => string, showNum: boolean): Promise<Buffer> {
  const tplBytes = fs.readFileSync(TEMPLATE_PATH);
  const out = await PDFLib.create();
  const font = await out.embedFont(StandardFonts.HelveticaBold);
  // Embed the template artwork ONCE and reuse it on every page (keeps the file
  // small — otherwise the ~840KB template would be duplicated per table).
  const [tpl] = await out.embedPdf(tplBytes, [0]);
  const W = tpl.width, H = tpl.height;

  for (const t of tables) {
    const page = out.addPage([W, H]);
    page.drawPage(tpl, { x: 0, y: 0, width: W, height: H });

    // New QR on the cream card (its light modules match the card → seamless).
    const qrPng = await QRCode.toBuffer(urlFor(t), { type: 'png', margin: 1, width: 640, errorCorrectionLevel: 'M', color: { dark: TPL.dark, light: TPL.cream } });
    const qs = W * TPL.qrSizeF;
    page.drawImage(await out.embedPng(qrPng), { x: W * TPL.qrCxF - qs / 2, y: H * TPL.qrCyF - qs / 2, width: qs, height: qs });

    // Table number
    if (showNum) {
      const label = `TABLE ${t.table_number}`;
      const size = W * TPL.labelSizeF;
      const tw = font.widthOfTextAtSize(label, size);
      page.drawText(label, { x: (W - tw) / 2, y: H * TPL.labelYF, size, font, color: hex(TPL.cream) });
    }
  }
  return Buffer.from(await out.save());
}

// ── Generated fallback standee (used only if no template is uploaded) ────────
async function buildGenerated(tables: any[], urlFor: (t: any) => string, brand: string, tagline: string, size: 'A4' | 'A5' | 'A6'): Promise<Buffer> {
  const qrByTable = new Map<string, Buffer>();
  for (const t of tables) qrByTable.set(t.id, await QRCode.toBuffer(urlFor(t), { type: 'png', errorCorrectionLevel: 'M', margin: 1, width: 640, color: { dark: INK, light: CARD_ELEV } }));
  const fontBuf = fs.readFileSync(path.join(process.cwd(), 'public', 'fonts', 'InstrumentSerif-Regular.ttf'));

  return await new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size, margin: 0 });
    doc.registerFont('serif', fontBuf);
    const chunks: Buffer[] = [];
    doc.on('data', c => chunks.push(c as Buffer));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    tables.forEach((t, i) => { if (i > 0) doc.addPage({ size, margin: 0 }); drawGenerated(doc, brand, t, qrByTable.get(t.id)!, tagline); });
    doc.end();
  });
}

function drawGenerated(doc: PDFKit.PDFDocument, brand: string, t: any, qr: Buffer, tagline: string) {
  const W = doc.page.width, H = doc.page.height;
  const center = (str: string, y: number, opts: any = {}) => doc.text(str, W * 0.06, y, { width: W * 0.88, align: 'center', ...opts });
  doc.rect(0, 0, W, H).fill(CARD);
  doc.save().fillOpacity(0.06).fillColor(TERRA).circle(W * 0.12, H * 0.07, W * 0.55).fill().restore();
  doc.save().fillOpacity(0.07).fillColor(FOREST).circle(W * 0.9, H * 0.95, W * 0.55).fill().restore();
  doc.font('serif');
  doc.fontSize(W * 0.085).fillColor(INK); center(brand, H * 0.09);
  doc.fontSize(W * 0.028).fillColor(TERRA); center('TABLE', H * 0.275, { characterSpacing: W * 0.008 });
  doc.fontSize(W * 0.17).fillColor(INK); center(String(t.table_number), H * 0.30);
  if (t.zone) { doc.fontSize(W * 0.024).fillColor(INK_MUTE); center(String(t.zone).toUpperCase(), H * 0.455, { characterSpacing: W * 0.004 }); }
  const qs = W * 0.46, qx = (W - qs) / 2, qy = H * 0.49, pad = W * 0.022, r = W * 0.02;
  doc.roundedRect(qx - pad, qy - pad, qs + 2 * pad, qs + 2 * pad, r).fillColor(CARD_ELEV).fill();
  doc.save().lineWidth(0.6).strokeOpacity(0.12).strokeColor(INK).roundedRect(qx - pad, qy - pad, qs + 2 * pad, qs + 2 * pad, r).stroke().restore();
  doc.image(qr, qx, qy, { width: qs, height: qs });
  doc.fontSize(W * 0.05).fillColor(INK); center('Scan to view the menu & order', H * 0.85);
  doc.fontSize(W * 0.026).fillColor(INK_SOFT); doc.text(tagline, W * 0.1, H * 0.90, { width: W * 0.8, align: 'center' });
}
