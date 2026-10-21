import type { ReactNode } from 'react';
import { assertFssaiPageAccess } from '@/lib/fssai-page-gate';

/**
 * The phone runner's own front door — the twin of the builder's.
 *
 * `/fssai/checklists` is open to any signed-in member of staff (they are
 * exactly who runs the checks), so this gate only has to answer the first
 * question: is anyone signed in at all? proxy.ts answers it for every real run
 * id, and does NOT for an id the caller invents containing `/print` or ending
 * `.json` — measured: a signed-out request for `/fssai/checklists/run/print-abc`
 * was served this page with HTTP 200. src/lib/fssai-page-gate.ts carries the
 * measurement.
 */
export default async function ChecklistRunLayout(
  { children, params }: { children: ReactNode; params: Promise<{ id: string }> },
) {
  const { id } = await params;
  await assertFssaiPageAccess(`/fssai/checklists/run/${id}`);
  return <>{children}</>;
}
