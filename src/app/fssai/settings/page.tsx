'use client';

/**
 * FSSAI Settings — Phase 2. Admin only (page-catalog adminOnly).
 *
 * Honest shell. This is where the owner's §24 requirement lands: the checklists are
 * configuration, so the standards live here and never in the code. Admin-only, and
 * for the stated reason — a wrong value here does not announce itself, it surfaces
 * weeks later as a record an inspector rejects. Note also HARD RULE: this screen must
 * never create a role; roles are the owner's production configuration.
 */

import PhaseShell from '../_components/PhaseShell';

export default function FssaiSettingsPage() {
  return (
    <PhaseShell
      href="/fssai/settings"
      will={[
        'Build and edit the checklists yourself: sections, questions, the kind of answer each question takes, and which answer counts as a pass.',
        'Set how often each check runs, which department owns it, who is expected to do it and who signs it off.',
        'Register the cold rooms, chillers, freezers and fryers, and set the safe range or limit for each one.',
        'Say when a photograph is compulsory, when a remark is compulsory, and which failures raise a corrective action automatically.',
        'Nominate who is told when a check is missed, when one fails, and when a fix runs past its date.',
      ]}
      today={{
        text:
          'Nowhere. The place to store all of this is already built; the screens to edit it are the next piece of work.',
      }}
      notes={[
        'Every standard in this module is yours to set here. No temperature, no frequency and no pass mark is written into the software — if the rules change, or an inspector asks for something stricter, you change it here without waiting for a developer.',
        'What this screen will never do is create or change a staff role, a department or a station. Those are yours, set in your own settings screens, and this module only reads them.',
        'Once a checklist has been used, its questions are frozen onto the records already taken. Editing a question changes the checklist from today onward and cannot rewrite what staff answered last month.',
      ]}
    />
  );
}
