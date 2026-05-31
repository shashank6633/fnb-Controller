import { ensureFirstUser, getCurrentUser } from '@/lib/auth';

export async function GET() {
  await ensureFirstUser();   // make sure default admin exists on first hit
  const user = await getCurrentUser();
  return Response.json({ user });
}
