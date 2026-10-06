'use client';

/**
 * Equipment & Cold Units — the register every temperature verdict is judged
 * against.
 *
 * Honest shell. The place to register units was created with the foundation and
 * is still EMPTY: fssai_equipment holds 0 rows. That is not a cosmetic gap — a
 * checklist aimed at "a cold room" has nothing to aim at, and a reading has no
 * safe range to be judged against, so it is recorded and left unjudged rather
 * than silently passed. The four names below are the only cold units that exist
 * anywhere in this application today, and they are free text typed on kitchen
 * production labels (production_batches.storage_location), not a list.
 *
 * It sits under Settings and is admin-only for the reason on its catalog row: a
 * wrong safe range here re-grades every temperature record in the file, and it
 * does so quietly.
 */

import PhaseShell from '../../_components/PhaseShell';

export default function FssaiEquipmentSettingsPage() {
  return (
    <PhaseShell
      href="/fssai/settings/equipment"
      will={[
        'Let you name every cold room, chiller, freezer, hot cabinet, fryer and water filter once.',
        'Hold the safe range for each one — your numbers, never ours, because a walk-in and a dessert chiller are not the same thing.',
        'Say how often each unit is to be read, so a unit nobody checked can stand out instead of being forgotten.',
        'Keep a unit in the file after you stop using it, so its old readings still name what they were readings of.',
        'Record what happens to a unit as well as what it reads — defrosts, breakdowns, repairs, and the thermometer being checked against ice.',
      ]}
      today={{
        text:
          'Nowhere, and this is the gap that holds the temperature records back. Your cold units are not a list in this app: they exist only as words typed on kitchen production labels, where the four used so far are Cold Room 1, Cold Room 2, Cold Room 3 and walkin chiller 1. When you register them we will use those exact four names first, so the batches already labelled with them line up instead of starting a fresh list.',
        links: [{ href: '/kitchen-production', label: 'Kitchen Production' }],
      }}
      notes={[
        'No temperature is written into the software. Until a unit has a range, a reading taken on it is recorded and marked as not judged — it is never quietly counted as a pass.',
        'A range set on one unit beats the general rule for its type, so a single awkward chiller can have its own numbers without changing anything else.',
        'Changing a range does not re-grade the records already taken. Each reading keeps the range that was actually applied to it, so tightening a standard next month cannot retrospectively fail a fridge that passed.',
      ]}
    />
  );
}
