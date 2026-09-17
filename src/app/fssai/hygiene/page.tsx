'use client';

/**
 * Personal Hygiene — Phase 8 (a seeded checklist, not a bespoke screen).
 *
 * THE SHARPEST PAGE IN THE MODULE, and the honesty matters. It holds health
 * declarations about named people, so it is the one screen with no management flag
 * on the menu row (a porter must be able to file his own before a shift) while the
 * API has to enforce own-record-or-management. That is a PROVISIONAL reading of the
 * owner's §7 Q10 — "staff see their own department" narrowed to "own record" for
 * health data — and it is reversible, so it is written on the screen rather than
 * buried in a commit message.
 */

import PhaseShell from '../_components/PhaseShell';

export default function FssaiHygienePage() {
  return (
    <PhaseShell
      href="/fssai/hygiene"
      will={[
        'Run the start-of-shift check: clean uniform, hair covered, nails, no jewellery or watch, hands washed, and any cut covered with a blue plaster.',
        'Let each person declare their own health before starting — stomach upset, fever, sore throat, skin or eye infection — in a few taps, in their own hands.',
        'Record anyone who is not fit to handle food that day, and what they were moved to instead.',
        'Keep the record per person per shift, so "everyone was checked" becomes a list of names rather than a claim.',
        'Remind you when a staff medical fitness certificate is about to run out.',
      ]}
      today={{
        text:
          'Partly, and not as health records. The Task Manager has a Hygiene Audits screen for scoring an area, and HR holds staff documents with expiry dates. Neither is a daily fitness-to-work declaration.',
        links: [
          { href: '/tasks/hygiene', label: 'Hygiene Audits' },
          { href: '/hr/documents', label: 'Employee Documents (admin only)' },
        ],
      }}
      notes={[
        'An assumption we have made and you can overturn: a health declaration is personal, so each person will be able to see and file their own, and only managers, head chefs and you will be able to read across everybody. It is a rule in the software, not a setting — say the word and it changes.',
        'A limitation to know now: the HR employee list is empty, so a check will be recorded against the staff member’s login rather than their HR record until you populate HR.',
      ]}
    />
  );
}
