'use client';

/**
 * Inspection Reports — Phase 9. Management only (page-catalog mgmtOnly).
 *
 * Honest shell. This holds a regulator's findings about the business, so the menu
 * row is management-only — but a manager must be able to open it during a visit,
 * which is why it is not admin-only.
 */

import PhaseShell from '../_components/PhaseShell';

export default function FssaiInspectionsPage() {
  return (
    <PhaseShell
      href="/fssai/inspections"
      will={[
        'Keep a record of every real inspection — the FSSAI officer, the health authority, a customer’s auditor, or your own internal audit.',
        'Record what was observed point by point, the score or grade given, and the deadline attached to each point.',
        'Record what you did about each point, with the proof, so a follow-up visit is a five-minute conversation.',
        'Hold the notice, the report and the closing letter as attachments against the visit.',
        'Show the history of visits on one screen — the thing that is impossible to assemble the morning an inspector arrives.',
      ]}
      today={{
        text:
          'Nowhere. Inspection paperwork lives outside the app today.',
      }}
      notes={[
        'This screen is for inspections that actually happened. It is not a self-assessment, and it will not be pre-filled with anything.',
      ]}
    />
  );
}
