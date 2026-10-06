'use client';

/**
 * Record Changes & Voids — the owner's §19 surface.
 *
 * Honest shell, and the honest thing to say about it is unusual: THE TRAIL
 * ALREADY EXISTS AND IS ALREADY BEING WRITTEN. fssai_audit_log has been filled
 * on every checklist submit, signature, verification and corrective action since
 * the engine shipped — the frozen before/after values, the actor, the reason.
 * What does not exist is a screen to read it on. So this page does not say "no
 * records yet"; it says the records are there and nobody can see them, which is
 * a different and more useful statement.
 *
 * Why it is management-only is on the catalog row: this is a list of the moments
 * somebody's record was overridden.
 */

import PhaseShell from '../_components/PhaseShell';

export default function FssaiAuditLogPage() {
  return (
    <PhaseShell
      href="/fssai/audit-log"
      will={[
        'List every change made to a compliance record — what it was, what it became, who changed it and when.',
        'Show the reason given for every cancelled record, because a cancellation without a reason is not an audit trail.',
        'Let you filter by date, by department, by person and by which register the record belongs to.',
        'Open the record itself from any line, so a question about a change never ends at the change.',
        'Print or export the whole trail for a date range, for an inspector who asks what was altered.',
      ]}
      today={{
        text:
          'The trail itself is already being kept. Every checklist submitted, signed, verified or cancelled has written its own before-and-after entry, with the person and the reason, since the checklist engine started working — nothing has been lost waiting for this screen. What is missing is only the place to read it: today it can be seen in the database and nowhere else.',
      }}
      notes={[
        'Nothing in this module is ever deleted. A record entered by mistake is cancelled with a written reason and both the record and the reason stay in the file — that is what you asked for, and it is why this screen can exist at all.',
        'Only a manager, a head of department or an admin can cancel a record, and never the person who wrote it. The person who took a reading is exactly the person with a reason to want a bad one to disappear.',
      ]}
    />
  );
}
