'use client';

/**
 * Food Storage Checks (owner §10).
 *
 * The record for this area IS a checklist — FSSAI-BUILD-STATE.md §2, from the
 * owner's §24. Three ready-made ones cover it
 * (src/lib/fssai-checklist-pack.ts): the daily dry-store walk, the daily cold-
 * storage segregation and labelling round, and the weekly storage audit.
 *
 * ⚠️ WHERE THIS STOPS, so two screens do not record the same thing twice. These
 * checklists are about what is INSIDE the store — raw apart from cooked,
 * covered, labelled, dated, nothing on the floor. The TEMPERATURE of each cold
 * unit is a reading against a configured range and belongs to Temperature Logs
 * and Cold Room Climate Control, which have their own tables. The two
 * temperature questions here are the round's own observation ("the warmest
 * chiller I saw"), not the unit-by-unit log.
 */

import SeededModuleScreen from '../_components/SeededModuleScreen';

export default function FssaiStoragePage() {
  return (
    <SeededModuleScreen
      href="/fssai/storage"
      moduleKey="storage"
      covers={[
        'Raw meat, poultry and fish below and apart from ready-to-eat food — the single most common finding against a kitchen.',
        'Everything covered, labelled with what it is, and dated with the day it went in.',
        'Nothing on the floor, oldest at the front, and nothing past its date on a shelf.',
        'Chemicals and non-food stored separately, never above food.',
        'The weekly audit: opened-pack shelf lives being applied, thawing in a chiller, nothing refrozen, and the fabric of the store sound.',
      ]}
    />
  );
}
