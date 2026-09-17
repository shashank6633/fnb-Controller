'use client';

/**
 * Corrective Actions — Phase 7.
 *
 * Honest shell. The spine table exists from Phase 1 so nothing has to be migrated
 * later under live audit history, but there is no queue to show yet. The fix itself
 * becomes a row in the EXISTING Task Manager ('fssai' joins the task source list) —
 * this module must not grow a second to-do list.
 */

import PhaseShell from '../_components/PhaseShell';

export default function FssaiCorrectiveActionsPage() {
  return (
    <PhaseShell
      href="/fssai/corrective-actions"
      will={[
        'Put every failed check in one list: what failed, where, who owns the fix and by when.',
        'Create the fix as a task in the Task Manager your staff already use, rather than a second to-do list nobody opens.',
        'Refuse to close an action until somebody has written down what was actually done, and let a manager verify that close.',
        'Escalate an overdue action to whoever you nominate, after however long you choose.',
        'Show, for an inspector, that a failure was found, fixed, and signed off — which is the question that matters more than the failure itself.',
      ]}
      today={{
        text:
          'Partly. The Task Manager already handles jobs, owners, deadlines and approvals, and that is where the fixes will live. What does not exist is the link from a failed food-safety check to the job that fixes it.',
        links: [
          { href: '/tasks', label: 'Task Management' },
          { href: '/tasks/maintenance', label: 'Maintenance' },
        ],
      }}
      notes={[
        'Each action will carry a number of its own, in the style of the GRN and production numbers you already read, so it can be quoted in a letter.',
        'One rule we have assumed: the person who recorded a check may not be the person who verifies the fix. It is reversible, but a food-safety record where the same person does both is worth very little.',
      ]}
    />
  );
}
