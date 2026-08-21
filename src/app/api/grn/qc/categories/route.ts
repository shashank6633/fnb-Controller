import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { listCategoryCheckers, setCategoryCheckers, qcEscalationHours, qcSchemaHealth, QC_CHECKERS } from '@/lib/grn-qc';
import { WA_QC_EVENT_KEY, isWaQcNotifyEnabled, waQcRecipients } from '@/lib/grn-qc-notify';

/**
 * WHICH CATEGORIES NEED A QUALITY CHECK — the admin's map.
 *
 *   GET /api/grn/qc/categories → every live category with its count, its
 *                                checker, and whether it is ASSIGNED
 *   PUT /api/grn/qc/categories → { updates: [{ category, checker }], … }
 *
 * ADMIN ONLY ON BOTH VERBS, via requireRole('admin'), which fails closed (401
 * with no session, 403 for a non-admin). The READ is gated too, deliberately:
 * it carries `signer_audit`-adjacent configuration and the WhatsApp recipient
 * list, and its page is adminOnly, so a wider read would only serve a screen
 * nobody else can open. `can_edit` rides on the response so the page reads its
 * gate off THIS endpoint rather than off /api/auth/me — the gate on screen can
 * then never disagree with the gate on the write (the settings/station-
 * departments precedent).
 *
 * ── WHY A MAP AND NOT A LIST IN CODE ───────────────────────────────────────
 * The category names in this database are inconsistent — veg (117 materials),
 * vegetables (2) and english-vegetables (2) are three spellings of one thing —
 * and the owner chose the map over renaming 952 materials. So the map has to
 * carry every spelling, and the unassigned ones have to be LOUD.
 *
 * ── AN UNMAPPED CATEGORY IS 'none', AND IT IS SURFACED ─────────────────────
 * Defaulting a new category to "no check" is the safe direction: silently
 * BLOCKING an unmapped category would stop a delivery nobody meant to stop, at
 * the bay, with a vendor waiting. The risk it creates — a perishable category
 * added later and never mapped — is answered by `unassigned`, not by guessing.
 * `central_reachable` splits that count honestly: 118 bar materials are
 * store-mapped (TGBCL) and can never reach a central GRN at all, so a checker
 * on them could never fire, and reporting them as "escaping QC" would send an
 * admin hunting a problem that does not exist.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Settings this endpoint owns. All are read here and written here; none of
 *  them belongs in /api/settings, whose KEY_POLICY would have to grow a row
 *  each to keep a manager from PUTting them. */
const ESCALATION_KEY = 'qc_escalation_hours';

export async function GET() {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });
  try {
    const db = getDb();
    const rows = listCategoryCheckers(db);
    const unassigned = rows.filter(r => !r.assigned);
    return Response.json({
      rows,
      checkers: QC_CHECKERS,
      can_edit: true,
      escalation_hours: qcEscalationHours(db),
      // The two halves of "unassigned", never one number. Central-reachable is
      // the one an admin can act on; the rest is liquor that this gate can
      // never see.
      unassigned_total: unassigned.length,
      unassigned_central: unassigned.filter(r => r.central_reachable).length,
      unassigned_central_materials: unassigned
        .filter(r => r.central_reachable)
        .reduce((s, r) => s + r.material_count, 0),
      unassigned_store_only: unassigned.filter(r => !r.central_reachable).length,
      // The WhatsApp rail: BUILT AND DARK. Absent key reads '' which is not
      // '1', so it is off by construction and not by a default anyone can flip
      // by accident. `wa_key` is named so the screen can say which setting it is.
      wa_key: WA_QC_EVENT_KEY,
      wa_enabled: isWaQcNotifyEnabled(db),
      wa_recipients: waQcRecipients(db),
      // THE ALARM ON THE FAIL-OPEN DIRECTION. A missing column or a missing
      // qc_category_checkers table silently disarms the entire gate — every
      // delivery inwards immediately, the queue reads 0 and nothing anywhere
      // says so. This screen is the one place an admin can act on it, so it
      // reports the state in words rather than leaving it to be inferred from a
      // list of unassigned categories nobody opens daily.
      schema_health: qcSchemaHealth(db),
    });
  } catch (e: any) {
    console.error('[/api/grn/qc/categories GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });
  try {
    const db = getDb();
    const me = gate.user;
    const body = await request.json().catch(() => ({} as any));
    const out: Record<string, unknown> = { success: true };

    if (Array.isArray(body?.updates) && body.updates.length > 0) {
      // Upserts ONLY the keys sent, so a partial save never clears the rest —
      // the screen batches its whole diff into one PUT, and a half-sent batch
      // must not read as "everything else was set to No check".
      const res = setCategoryCheckers(db, body.updates, me?.email || '');
      if (res.invalid.length) {
        return Response.json({
          error: `Unknown checker on ${res.invalid.length} categor(ies): ${res.invalid.slice(0, 5).join(', ')}. Use one of ${QC_CHECKERS.join(' | ')}.`,
          invalid: res.invalid,
        }, { status: 400 });
      }
      out.updated = res.updated;
    }

    // ── The escalation clock ────────────────────────────────────────────────
    // Clamped 1…168 by qcEscalationHours on read as well, so a value written
    // straight into `settings` by some other route can neither spam the bell
    // every minute nor silence it for a month.
    if (body?.escalation_hours !== undefined && body.escalation_hours !== null && String(body.escalation_hours).trim() !== '') {
      const n = Number(body.escalation_hours);
      if (!Number.isFinite(n) || n < 1 || n > 168) {
        return Response.json({
          error: 'Escalation hours must be between 1 and 168 (one week). It is how long a delivery may sit unchecked before the head chef is pinged.',
          field: 'escalation_hours',
        }, { status: 400 });
      }
      db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(ESCALATION_KEY, String(Math.round(n)));
      out.escalation_hours = Math.round(n);
    }

    // ── The WhatsApp toggle — DEFAULT OFF, AND OFF BY CONSTRUCTION ──────────
    // db.ts never seeds this key, so "not set" is the only state it can be in
    // until an admin turns it on here. Writing '0' explicitly is also fine and
    // means the same thing. The master switch `wa_notifications_enabled` still
    // has to be on as well (isWaQcNotifyEnabled requires both), and it belongs
    // to /api/whatsapp/config — this endpoint deliberately does not touch it.
    if (body?.wa_enabled !== undefined) {
      db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(WA_QC_EVENT_KEY, body.wa_enabled ? '1' : '0');
      out.wa_enabled = isWaQcNotifyEnabled(db);
      // Stated back rather than assumed: with the master switch off, turning
      // this on changes nothing, and an admin who is not told that will believe
      // the pings are live.
      out.wa_master_switch = (db.prepare(`SELECT value FROM settings WHERE key = 'wa_notifications_enabled'`)
        .get() as any)?.value === '1';
    }

    // ── The WhatsApp recipient list ────────────────────────────────────────
    // The SAME `wa_notify_recipients` JSON every other event uses, under the
    // key `grn_qc_pending`, so one screen edits one list and Settings →
    // WhatsApp keeps working unchanged. Only this event's slot is rewritten;
    // every other event's list is carried through untouched. Capped at 10, as
    // setWaNotifyRecipients caps every other event.
    if (body?.wa_recipients !== undefined) {
      const list = Array.isArray(body.wa_recipients) ? body.wa_recipients : String(body.wa_recipients ?? '').split(',');
      const clean = list.map((m: unknown) => String(m).trim()).filter(Boolean).slice(0, 10);
      let merged: Record<string, unknown> = {};
      try {
        const raw = (db.prepare(`SELECT value FROM settings WHERE key = 'wa_notify_recipients'`).get() as any)?.value;
        const parsed = JSON.parse(raw || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) merged = parsed;
      } catch { /* malformed JSON ⇒ start from {} rather than refuse the save */ }
      merged.grn_qc_pending = clean;
      db.prepare(`INSERT INTO settings (key, value) VALUES ('wa_notify_recipients', ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(JSON.stringify(merged));
      out.wa_recipients = clean;
    }

    return Response.json(out);
  } catch (e: any) {
    console.error('[/api/grn/qc/categories PUT]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
