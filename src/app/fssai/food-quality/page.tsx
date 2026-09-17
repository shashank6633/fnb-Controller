'use client';

/**
 * Food Quality Checks — Phase 8 (a seeded checklist, not a bespoke screen).
 *
 * Honest shell. Per the settled architecture (FSSAI-BUILD-STATE.md §2, owner's
 * §24) this check is CONFIGURATION, not code: it ships as a checklist the owner
 * can edit himself, and it runs on the Phase 2 builder and the Phase 3 phone
 * runner. That is why this page promises a checklist and not a new screen.
 */

import PhaseShell from '../_components/PhaseShell';

export default function FssaiFoodQualityPage() {
  return (
    <PhaseShell
      href="/fssai/food-quality"
      will={[
        'Check prepared food before it goes out: taste, smell, look, texture, and the serving temperature where it matters.',
        'Run once per shift per section, with the chef’s name against it and a signature at the end.',
        'Refuse to close a failed item until somebody has written down what was done about it.',
        'Let you photograph anything you are not happy with, so the same argument is not had twice.',
        'Build up the record that answers "how do you know the food leaving your kitchen is right?".',
      ]}
      today={{
        text:
          'Partly. There is a Daily Checklists screen in the Task Manager, but it keeps one record per checklist per day with no signature, no shift, no section and no version of the questions — which is not enough for a food-safety record. The FSSAI checklists are built properly and kept separate; nothing in the Task Manager is taken away.',
        links: [{ href: '/tasks/checklists', label: 'Daily Checklists' }],
      }}
      notes={[
        'This is one of twelve ready-made checklists, written once the checklist builder is in place. It is a list of questions you can change yourself in Settings — add one, reword one, change which answer counts as a fail — without waiting for a developer.',
        'Before any of the twelve are written down, the checklist builder has to settle the question types and the pass-or-fail rules. A checklist seeded before that would have to be rebuilt.',
      ]}
    />
  );
}
