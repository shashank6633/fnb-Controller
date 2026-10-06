'use client';

/**
 * Personal Hygiene (owner §9).
 *
 * The record for this area IS a checklist — FSSAI-BUILD-STATE.md §2, from the
 * owner's §24. Two ready-made ones cover it
 * (src/lib/fssai-checklist-pack.ts): the start-of-shift check each food handler
 * files on themselves, and the monthly health and fitness declaration.
 *
 * ⚠️ THE ONE CONVENTION WORTH KNOWING, and it is provisional. Both are run
 * against A PERSON (`target_kind: 'person'`), which is what makes each member of
 * staff file their own round with no special case in the slot rule — the person
 * is part of the slot key. The person is identified by their `users.email`,
 * because `hr_employees` holds 0 rows (FSSAI-BUILD-STATE.md §3 / §7 Q18). If the
 * owner later populates HR, rounds already filed keep their email key.
 */

import SeededModuleScreen from '../_components/SeededModuleScreen';

export default function FssaiHygienePage() {
  return (
    <SeededModuleScreen
      href="/fssai/hygiene"
      moduleKey="hygiene"
      covers={[
        'Fit to handle food: no fever, cough, cold, skin infection, and nothing in the last 48 hours that should keep someone off food.',
        'Uniform and turnout — clean apron, hair fully covered, no watch, rings, bangles or chains, closed footwear.',
        'Hands: nails short and unvarnished, washed with soap for 20 seconds before starting.',
        'Filed by each person against their own name, once per shift, and it cannot be written up two days later.',
        'The monthly declaration, with the medical fitness certificate and the food-safety training confirmed as on file.',
      ]}
    />
  );
}
