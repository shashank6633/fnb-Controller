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
      // 'no_code' and 'wrong_code' return the SAME message + reason: a public
      // endpoint must not reveal whether a given number has a live OTP at this
      // table (presence-enumeration oracle). Granular reasons stay server-side.
      const msg = res.reason === 'expired' ? 'That code has expired — request a new one.'
        : res.reason === 'too_many_attempts' ? 'Too many wrong tries — request a new code.'
        : 'Incorrect code — please try again.';
      const publicReason = (res.reason === 'expired' || res.reason === 'too_many_attempts') ? res.reason : 'invalid';
      return Response.json({ ok: false, verified: false, error: msg, reason: publicReason }, { status: 400 });
    }
    return Response.json({ ok: true, verified: true });
  } catch (e: any) {
    console.error('[/api/customer/otp/verify POST]', e);
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
