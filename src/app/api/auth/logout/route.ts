import { cookies } from 'next/headers';
import { destroySession, SESSION_COOKIE } from '@/lib/auth';

export async function POST() {
  const c = await cookies();
  const token = c.get(SESSION_COOKIE)?.value;
  if (token) destroySession(token);
  c.delete(SESSION_COOKIE);
  c.delete('fnb_csrf');
  return Response.json({ success: true });
}
