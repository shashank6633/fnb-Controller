import { getDb } from '@/lib/db';
import { resolveTableByToken } from '@/lib/customer';
import { verifyOtp, normMobile } from '@/lib/customer-otp';

/**
 * POST /api/customer/otp/verify { t, mobile, code } — verify a WhatsApp OTP.
 * On success the (mobile, table) pair is marked verified for the session so the
 * order can be placed with a confirmed number. Public (customer on their phone).
 */
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const table = resolveTableByToken(String(body?.t || body?.table || ''));
    if (!table) return Response.json({ ok: false, error: 'Unknown table.' }, { status: 404 });
    const mobile = normMobile(body?.mobile);
    const code = String(body?.code || '');

    const res = verifyOtp(getDb(), { tableId: table.id, mobile, code });
    if (!res.ok) {
      const msg = res.reason === 'expired' ? 'That code has expired — request a new one.'
        : res.reason === 'too_many_attempts' ? 'Too many wrong tries — request a new code.'
        : res.reason === 'no_code' ? 'No code was sent — request one first.'
        : 'Incorrect code — please try again.';
      return Response.json({ ok: false, verified: false, error: msg, reason: res.reason }, { status: 400 });
    }
    return Response.json({ ok: true, verified: true });
  } catch (e: any) {
    console.error('[/api/customer/otp/verify POST]', e);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
