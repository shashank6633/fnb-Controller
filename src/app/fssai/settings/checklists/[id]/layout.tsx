import type { ReactNode } from 'react';
import { assertFssaiPageAccess } from '@/lib/fssai-page-gate';

/**
 * The builder's own front door.
 *
 * `/fssai/settings` is `adminOnly` in page-catalog.ts and proxy.ts enforces
 * that for every real checklist id — but not for an id the caller invents
 * containing `/print`, or ending `.json`/`.png`/… , because proxy.ts calls
 * those paths PUBLIC before it routes them. Measured: a signed-out request for
 * `/fssai/settings/checklists/print-abc` was served this page with HTTP 200.
 * See src/lib/fssai-page-gate.ts for the measurement and why the fix lives in
 * FSSAI's own files rather than in the shared proxy.
 *
 * Server component: the refusal happens before a byte of the builder is sent,
 * so there is no flash of the admin console. The route was already `ƒ`
 * (dynamic) in the build, so nothing about the build shape changes.
 */
export default async function ChecklistBuilderLayout(
  { children, params }: { children: ReactNode; params: Promise<{ id: string }> },
) {
  const { id } = await params;
  await assertFssaiPageAccess(`/fssai/settings/checklists/${id}`);
  return <>{children}</>;
}
