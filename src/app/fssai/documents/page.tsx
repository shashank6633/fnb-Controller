'use client';

/**
 * Documents & Certificates — Phase 6. Management only (page-catalog mgmtOnly).
 *
 * Honest shell. Management, not admin, on purpose: admin-only would mean nobody can
 * produce the licence unless the owner is in the building. HR already stores staff
 * documents with expiry dates and that is the model to copy — and possibly the place
 * medical certificates should stay, which is a question, not a decision.
 */

import PhaseShell from '../_components/PhaseShell';

export default function FssaiDocumentsPage() {
  return (
    <PhaseShell
      href="/fssai/documents"
      will={[
        'Hold the papers an inspector asks for first: the FSSAI licence, the water-test reports, the pest-control contract, staff medical fitness certificates, and equipment calibration certificates.',
        'Put an expiry date on each one and warn you well before it lapses, instead of the week after.',
        'Show at a glance what is valid, what is close to expiring and what has already lapsed.',
        'Let you open or download any of them in two taps while somebody is standing in front of you.',
        'Keep the older versions, so renewing a licence does not erase the one it replaced.',
      ]}
      today={{
        text:
          'Partly. HR already stores staff documents with expiry dates and warns before they run out — that is the pattern this screen will follow. Business licences and contracts have nowhere to live today.',
        links: [{ href: '/hr/documents', label: 'Employee Documents (admin only)' }],
      }}
      notes={[
        'A question for you: staff medical fitness certificates could stay in HR with the rest of their papers, or be copied here so the whole food-safety file is in one place. Keeping one copy in two places is the option we would avoid.',
        'This screen is management, not admin, deliberately — if only you could open it, nobody could produce the licence while you were away.',
      ]}
    />
  );
}
