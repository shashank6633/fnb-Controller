'use client';

/**
 * Reports & Downloads — Phase 9. Management only (page-catalog mgmtOnly).
 *
 * Honest shell. Two measured limits of the existing PDF writer are stated here
 * rather than discovered by the owner on an inspector's sheet: a table cell is cut
 * off with an ellipsis instead of wrapping (report-pdf.ts), and the rupee sign does
 * not encode (the degree sign does). Excel and CSV have neither problem.
 */

import PhaseShell from '../_components/PhaseShell';

export default function FssaiReportsPage() {
  return (
    <PhaseShell
      href="/fssai/reports"
      will={[
        'Pull any date range, any department, any checklist, and read it on screen before downloading anything.',
        'Give the numbers that matter: how many checks were due, how many were done, how many failed, and how many were done late.',
        'Download as Excel or CSV for your own working, and as a PDF for handing over.',
        'Produce one inspection pack — the checks, the temperature records, the certificates and the closed corrective actions — as a single download.',
        'Keep staff to their own department’s figures while managers see across the restaurant.',
      ]}
      today={{
        text:
          'Nowhere for food safety. The app has strong sales, cost and stock reports, and this screen will follow the same shape — the same date pickers, the same Excel and CSV buttons — so it will not feel like a different program.',
        links: [{ href: '/reports/sales', label: 'Sales Reports' }],
      }}
      notes={[
        'One limit worth knowing before the reports are designed: in the PDFs this app generates today, a long remark inside a table cell is cut short rather than wrapped onto a second line. For a corrective-action report that matters, so Phase 9 will lay those out as paragraphs instead of table cells.',
      ]}
    />
  );
}
