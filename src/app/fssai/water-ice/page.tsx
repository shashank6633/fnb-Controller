'use client';

/**
 * Water & Ice Checks — Phase 5.
 *
 * Honest shell. Water Filter Inspection already exists as a maintenance schedule,
 * so this page points there rather than promising a second place to record the
 * same service visit.
 */

import PhaseShell from '../_components/PhaseShell';

export default function FssaiWaterIcePage() {
  return (
    <PhaseShell
      href="/fssai/water-ice"
      will={[
        'Hold the daily look-and-smell check on drinking water and on ice — clear, no smell, machine clean.',
        'Record filter changes, cartridge replacements and RO service dates, with the next one due.',
        'Keep the laboratory water-test certificates, and warn you before one runs out.',
        'Keep the ice-machine cleaning record, which is the part inspectors ask about most.',
        'Show the last twelve months on one screen, so the water file is a file and not a drawer.',
      ]}
      today={{
        text:
          'Partly. Water Filter Inspection is already a maintenance schedule in the Task Manager. The service visits belong there; what is missing is the daily check and the test certificates.',
        links: [{ href: '/tasks/maintenance', label: 'Maintenance' }],
      }}
      notes={[
        'Test certificates are files. Where the module keeps files — inside the app’s own database as it does for staff documents today, or somewhere else with a size limit — is a decision for Phase 3, because the server currently refuses any upload over one megabyte.',
      ]}
    />
  );
}
