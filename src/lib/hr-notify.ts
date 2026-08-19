// HR notification producer (hr_notifications + best-effort web push) — the
// Phase 7 durable feed's ONLY writer entry point (HRMS_DECISIONS §4).
//
// notifyHrEmployee resolves the employee's LOGIN email via
// hr_employees.user_id -> users.email (contract D1: employees ≠ logins — an
// employee with no linked login has no bell, so the call is a SILENT no-op),
// inserts one hr_notifications row, then fires web push via sendPushToUser in
// a queueMicrotask so the HTTP response is never held up by push latency.
//
// CALL IT OUTSIDE / AFTER the caller's db.transaction() — it performs its own
// INSERT (better-sqlite3 is synchronous; nesting a second write path inside a
// decision transaction couples the decision's fate to the notification's).
// Callers wrap each call in its own try/catch: a notify failure must NEVER
// fail the decision it announces. This function also never throws by design,
// but the belt-and-braces try/catch at the call site is the house rule.
import type Database from 'better-sqlite3';
import { generateId } from './db';
import { sendPushToUser } from './push';

export interface HrNotifyInput {
  kind: string; // e.g. 'hr.leave.approve' — mirrors the audit event_type
  title: string;
  body: string;
  href: string; // in-app destination, e.g. '/hr/leave'
}

/**
 * Insert a durable hr_notifications row addressed to the employee's linked
 * login email and fire best-effort push. Silent no-op when the employee has
 * no linked login (or no longer exists). Never throws.
 */
export function notifyHrEmployee(
  db: Database.Database,
  employee_id: string,
  input: HrNotifyInput,
): void {
  try {
    if (!employee_id) return;
    const row = db
      .prepare(
        `SELECT u.email AS email
         FROM hr_employees e
         JOIN users u ON u.id = e.user_id
         WHERE e.id = ?`,
      )
      .get(employee_id) as { email?: string } | undefined;
    const email = String(row?.email || '').trim();
    if (!email) return; // no linked login — nobody to address (contract D1)

    db.prepare(
      `INSERT INTO hr_notifications (id, recipient_email, kind, title, body, href)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(generateId(), email, input.kind, input.title, input.body, input.href);

    // Push AFTER the row exists, off the request's critical path.
    // sendPushToUser never throws (its contract), so this microtask is safe.
    queueMicrotask(() => {
      void sendPushToUser(db, email, {
        title: input.title,
        body: input.body,
        url: input.href,
      });
    });
  } catch (e) {
    // Notifications are best-effort by contract — never let one break a flow.
    console.error('notifyHrEmployee failed (non-fatal):', e);
  }
}
