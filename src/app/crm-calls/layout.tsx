'use client';

/**
 * /crm-calls layout — renders the page plus the TeleCMI screen-pop.
 *
 * DECISION (CRM_DECISIONS.md): the screen-pop lives on /crm-calls/* pages
 * ONLY, not app-wide. GREs keep a CRM tab open while working calls; popping
 * over KDS, cashier or inventory screens would interrupt unrelated staff.
 * The pop itself handles SSE + poll fallback, stacking, and disposition.
 *
 * It also captures the Captain-APK (TWA) flag early: document.referrer only
 * carries android-app://<pkg> on the entry document, so we persist it the
 * first time any CRM page mounts (enables the exact call-log callback bridge).
 */

import { type ReactNode, useEffect } from 'react';
import CTScreenPop from '@/components/ct/CTScreenPop';
import { markTwaIfReferred } from '@/lib/ct/twa';

export default function CrmCallsLayout({ children }: { children: ReactNode }) {
  useEffect(() => { markTwaIfReferred(); }, []);
  return (
    <>
      {children}
      <CTScreenPop />
    </>
  );
}
