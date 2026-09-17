'use client';

/**
 * Pest Control Logs — Phase 6.
 *
 * Honest shell. Pest Control ALREADY exists as a maintenance schedule in the Task
 * Manager (measured: maintenance_schedules holds it, alongside Water Filter
 * Inspection). Whether the two become one screen is an open question for the owner
 * — the provisional answer is that FSSAI reads the maintenance visits rather than
 * asking anyone to enter them twice. This page says that out loud instead of
 * quietly building a duplicate.
 */

import PhaseShell from '../_components/PhaseShell';

export default function FssaiPestControlPage() {
  return (
    <PhaseShell
      href="/fssai/pest-control"
      will={[
        'Hold the pest-control contractor’s visits: the date, what was treated, what was found, and the report they leave behind.',
        'Let your own staff log a sighting the minute they see something, from wherever they are standing — that immediacy is the whole value.',
        'Keep the bait-station and trap checks, station by station, so a missed station is visible.',
        'Warn you before the contract or the next visit is due.',
        'Turn a sighting into a corrective action, so it is closed and signed rather than mentioned and forgotten.',
      ]}
      today={{
        text:
          'Partly. Pest Control is already a maintenance schedule in the Task Manager, and so is the water filter inspection. The plan is that FSSAI reads those visits instead of asking anyone to enter them twice — but whether the two screens become one is a decision for you, not for us.',
        links: [{ href: '/tasks/maintenance', label: 'Maintenance' }],
      }}
      notes={[
        'Logging a sighting will be open to any staff member — a porter who sees something at 11pm must be able to record it. Recording a contractor’s visit is a management job. Those are two different rights on one screen.',
      ]}
    />
  );
}
