'use client';

/**
 * FSSAI Checklists — Phase 2 (the library) and Phase 3 (the phone runner).
 *
 * THE SCREEN THE REVIEW GATE IS ABOUT. Every one of the eight record modules behind
 * the gate renders through the engine this page fronts, which is exactly why the
 * build stops after Phase 3: if the runner feels wrong in the hand, fixing it after
 * eight more phases have been stacked on top costs many times more.
 *
 * Two honest statements are load-bearing here and must not be softened:
 *  · the app has NO offline cache (ServiceWorkerRegister.tsx is a service-worker
 *    DISABLER, kept that way after a stale-bundle incident), so "works offline" is
 *    false today; and
 *  · production refuses any upload over one megabyte, so photo evidence is one
 *    compressed photo per request.
 */

import PhaseShell from '../_components/PhaseShell';

export default function FssaiChecklistsPage() {
  return (
    <PhaseShell
      href="/fssai/checklists"
      will={[
        'List every checklist the restaurant runs, how often it runs, which department owns it, and whether today’s one is done.',
        'Let a staff member tap one and run it on a phone: answer each question, take a photograph where the question demands one, add a remark, sign, and submit.',
        'Pick up a half-finished check where it was left, instead of starting it again and leaving two records of the same round.',
        'Lock a check once it is submitted, so the record cannot be quietly rewritten afterwards — a correction leaves the original visible with a reason.',
        'Send the finished check to a manager to verify, and show which ones are still waiting.',
      ]}
      today={{
        text:
          'There is a Daily Checklists screen in the Task Manager and it keeps working. It is not enough for food safety: it stores one record per checklist per day, overwrites it when saved again, and holds no signature, no shift, no area and no copy of the questions as they were on the day. The FSSAI checklists are built properly and sit alongside it; nothing is deleted.',
        links: [{ href: '/tasks/checklists', label: 'Daily Checklists' }],
      }}
      notes={[
        'This is the screen to judge at the review gate. Phase 2 builds the checklist — sections, questions, the eight kinds of answer, and which answer counts as a pass. Phase 3 makes it run on a phone. Then the build stops until you have tried it.',
        'Said plainly so it is not a surprise later: it needs a working internet connection. This app deliberately keeps no offline copy of itself, so a check cannot be filled in while the connection is down. If checks must work through an outage, that is a bigger piece of work and worth deciding before Phase 3, not after.',
        'Photographs will be shrunk on the phone before they are sent, because the server refuses anything over one megabyte — so one photo per question, not a gallery.',
      ]}
    />
  );
}
