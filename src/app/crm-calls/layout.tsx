'use client';

/**
 * /crm-calls layout — renders the page plus the TeleCMI screen-pop.
 *
 * DECISION (CRM_DECISIONS.md): the screen-pop lives on /crm-calls/* pages
 * ONLY, not app-wide. GREs keep a CRM tab open while working calls; popping
 * over KDS, cashier or inventory screens would interrupt unrelated staff.
 * The pop itself handles SSE + poll fallback, stacking, and disposition.
 */

import type { ReactNode } from 'react';
import CTScreenPop from '@/components/ct/CTScreenPop';

export default function CrmCallsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <CTScreenPop />
    </>
  );
}
