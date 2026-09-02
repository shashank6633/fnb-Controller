import { ensureFirstUser, getCurrentUser } from '@/lib/auth';
import { readHodOnlyOverrides } from '@/lib/hod-overrides';

export async function GET() {
  await ensureFirstUser();   // make sure default admin exists on first hit
  const user = await getCurrentUser();
  // hod_only_overrides: the admin HOD-gate relaxations (owner pick 9B). The
  // Sidebar pushes this into page-catalog's client bundle so nav visibility
  // agrees with what the proxy enforces — without it a switched-off gate would
  // be reachable by URL but invisible in the sidebar (the exact
  // sidebar-vs-catalog drift that hid /variance-approvals once before). Only
  // for signed-in sessions; {} on any read problem (coded flags then stand).
  const hod_only_overrides = user ? readHodOnlyOverrides() : null;
  return Response.json({ user, hod_only_overrides });
}
