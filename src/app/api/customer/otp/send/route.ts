import { getDb } from '@/lib/db';
import { resolveTableByToken } from '@/lib/customer';
import { canSendOtp, createOtp, otpChannelReady, normMobile } from '@/lib/customer-otp';
import { getWaConfigRaw, sendWhatsAppTemplate } from '@/lib/whatsapp';

/**
 * POST /api/customer/otp/send { t, mobile } — send a WhatsApp OTP for a QR order.
 * Public (no auth — the customer is on their phone). If WhatsApp can't send
 * (not connected / no OTP template / provider error), returns fallback:true so
 * the client places the order as captain-approval — ordering never blocks.
 */
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const table = resolveTableByToken(String(body?.t || body?.table || ''));
    if (!table) return Response.json({ ok: false, error: 'Unknown table.' }, { status: 404 });
    const mobile = normMobile(body?.mobile);
    if (mobile.length < 10) return Response.json({ ok: false, error: 'Enter a valid mobile number.' }, { status: 400 });

    // Can't actually send → tell the client to fall back (order → captain approval).
    if (!otpChannelReady()) return Response.json({ ok: true, sent: false, fallback: true });

    const db = getDb();
    const rl = canSendOtp(db, table.id, mobile);
    if (!rl.ok) {
      return Response.json({ ok: false, error: `Please wait ${rl.retryAfter}s before requesting another code.`, retryAfter: rl.retryAfter }, { status: 429 });
    }

    const { code } = createOtp(db, { outletId: table.outlet_id, tableId: table.id, mobile });
    const raw = getWaConfigRaw();
    const tpl = String(raw.wa_otp_template || '').trim();
    const lang = String(raw.wa_otp_template_lang || 'en').trim() || 'en';
    const res = await sendWhatsAppTemplate(mobile, tpl, lang, [code], { otpButtonCode: code });
    if (!res.ok) {
      console.error('[/api/customer/otp/send] provider send failed:', res.reason, res.detail);
      return Response.json({ ok: true, sent: false, fallback: true }); // don't block ordering
    }
    return Response.json({ ok: true, sent: true });
  } catch (e: any) {
    console.error('[/api/customer/otp/send POST]', e);
    return Response.json({ ok: true, sent: false, fallback: true }); // never block on an OTP error
  }
}
