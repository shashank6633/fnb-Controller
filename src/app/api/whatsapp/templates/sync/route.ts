/* eslint-disable @typescript-eslint/no-explicit-any */
import { requireRole } from '@/lib/auth';
import { getDb } from '@/lib/db';
import {
  syncTemplateStatuses, syncPreflight, lastSyncAt, webhookSecurityState,
  undoLastSync, syncUndoAvailable,
} from '@/lib/wa-template-authoring';
import { measureSendability } from '@/lib/wa-broadcast';

/**
 * Reconcile local template rows against Meta's list (admin only).
 *
 *   POST /api/whatsapp/templates/sync
 *     → { ok:true, applied:true, updated[], adopted[], missing_at_meta[],
 *         stopped[], campaigns_stopped[], regressed[], name_conflicts[],
 *         fetched, checked_at, undo_available }
 *         `stopped` is the one to read: the before/after answer of EVERY send
 *         gate, measured by applying the refresh and asking the same functions
 *         the start door asks. `regressed` is kept for continuity and answers a
 *         narrower question (did a status move out of 'approved'), which sees
 *         nothing at all on a first check.
 *     → { ok:false, applied:false, needs_confirmation:true, stopped[], error }
 *         THE REFRESH WOULD HAVE STOPPED EVERYTHING and was rolled back. Nothing
 *         changed. Re-send with { confirm_stops: true } to apply it anyway.
 *     → { ok:false, error }   Meta's message, verbatim
 *
 *   POST /api/whatsapp/templates/sync?preview=1
 *     → { ok:true, preview:true, rows[], at_risk[], campaigns_at_risk[],
 *         new_at_meta[], total_loss, fetched, first_check }
 *     THE SAME REFRESH, PERFORMED AND ROLLED BACK, so it writes nothing. It
 *     answers "what will Refresh do to what I can send" before Refresh is
 *     pressed — which matters because every template here is sendable today only
 *     for want of that list, and the first successful refresh takes that reason
 *     away from all of them at once. POST (not GET) because it calls out to Meta.
 *
 *   POST /api/whatsapp/templates/sync?undo=1
 *     → { ok:true, restored, removed[], kept[], watermark }
 *     PUTS THE LAST REFRESH BACK. One undo point is kept, for the most recent
 *     refresh only, and using it consumes it.
 *
 *   GET  /api/whatsapp/templates/sync   → { synced_at, webhook_security, undo }  (no Meta call)
 *
 * THIS IS THE BACKSTOP that makes the broadcast approval gate trustworthy. A
 * template's status is not static: Meta approves after review, and can PAUSE or
 * DISABLE later on quality signals. Until a sync has run, `synced_at` is empty
 * and the gate stays permissive — it has no grounds to refuse a name it has
 * simply never heard of. After the first successful sync, absence from Meta's
 * list becomes a fact the gate can act on.
 *
 * WHY measureSendability IS PASSED IN. The lifecycle module cannot import
 * wa-broadcast (wa-broadcast imports it), and three of the four whole-queue gates
 * live there. Handing the measurement in is what lets a refresh report the losses
 * caused by the header and parameter gates as well as by approval — the ones a
 * report built on approval alone called "unaffected" while Start refused them.
 *
 * POST because it writes (statuses, adoptions) and calls out to Meta.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });
  const db = getDb();
  const synced = lastSyncAt(db);
  return Response.json({
    synced_at: synced,
    note: synced
      ? undefined
      : "Meta's template list has never been pulled. Until it is, template approval status is unverified and campaigns are allowed with a warning rather than refused.",
    /**
     * WEBHOOK SIGNATURE STATE — reported here because this is the lane's
     * admin-only WhatsApp diagnostics read, and because the answer must not be
     * silent: with no app secret, anything that reaches the webhook address is
     * believed. Carries no secret value, only whether one exists, where from, and
     * whether a real signed event has ever passed the check.
     */
    webhook_security: webhookSecurityState(db),
    /** Can the last refresh still be undone, and when did it run? */
    undo: syncUndoAvailable(db),
  });
}

export async function POST(request: Request) {
  try {
    const gate = await requireRole('admin');
    if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

    const db = getDb();
    const url = new URL(request.url);

    /* ── PUT IT BACK. No Meta call: this is a pure local reversal. ── */
    if (url.searchParams.get('undo') === '1') {
      const un = undoLastSync(db);
      if (!un.ok) return Response.json({ ok: false, error: un.error }, { status: 409 });
      /* THE COUNT IS OF ROWS THAT ACTUALLY MOVED, not of rows looked at. A
       * refresh that changed nothing has nothing to put back, and saying "put
       * back 0 rows" would read like a failure rather than the plain truth. */
      const bits: string[] = [
        un.restored
          ? `Put back ${un.restored} template row(s) exactly as they were before the refresh of ${un.taken_at || 'that moment'}.`
          : `That refresh of ${un.taken_at || 'that moment'} had not changed any template, so there was nothing to put back.`,
      ];
      if (un.removed.length) bits.push(`Removed the ${un.removed.length} template(s) that refresh had added: ${un.removed.map(n => `"${n}"`).join(', ')}.`);
      for (const k of un.kept) bits.push(`Kept "${k.name}": ${k.why}`);
      /* WHAT IT DID NOT PUT BACK, said out loud. An undo that silently discarded
       * a newer WhatsApp status was the defect; leaving that status alone is the
       * fix, and an owner who pressed "put it back" needs to be told which rows
       * it deliberately did not touch. */
      for (const s of un.skipped) bits.push(`Left "${s.name}" alone: ${s.why}`);
      bits.push(un.watermark
        ? `Statuses are back to the state they were checked in at ${un.watermark}.`
        : 'Meta\'s list now counts as never checked again — which is the state this app was in before the refresh, and the reason every template was usable then.');
      return Response.json({ ok: true, undo: un, note: bits.join(' ') });
    }

    /* DRY RUN. Applies the refresh inside a transaction and rolls it back, so
     * NOTHING is written — not one status, not one adoption, not the "last
     * checked" time — and the answer is the real one rather than a projection. */
    if (url.searchParams.get('preview') === '1') {
      const pre = await syncPreflight(db, { impact: measureSendability });
      if (!pre.ok) return Response.json({ ok: false, preview: true, error: pre.error }, { status: 502 });
      return Response.json({ ...pre, preview: true });
    }

    const body = await request.json().catch(() => ({} as any));
    const confirmStops = (body as any)?.confirm_stops === true;

    const res = await syncTemplateStatuses(db, { impact: measureSendability, allowStops: confirmStops });
    if (!res.ok) {
      // Verbatim Meta error, or the everything-would-stop refusal (which carries
      // needs_confirmation and the list, and changed nothing).
      return Response.json(
        { ok: false, error: res.error, needs_confirmation: res.needs_confirmation, applied: false, stopped: res.stopped, fetched: res.fetched },
        { status: res.needs_confirmation ? 409 : 502 },
      );
    }

    // THE CASE WORTH SHOUTING ABOUT: something that WAS usable no longer is.
    // Taken from `stopped`, which is the measured before/after answer of every
    // send gate — not from a status transition, which cannot see a first check at
    // all (every row starts at '' and never moves out of 'approved', so nothing
    // registers), and not from the approval gate alone, which is blind to a header
    // this rail cannot fill or a parameter count that no longer matches.
    const notes: string[] = [];
    if (!res.measured) {
      notes.push('This app could not work out what the refresh changed about sending, so the list below may be incomplete — check Broadcasts before you rely on it. The statuses themselves were reconciled normally.');
    }
    for (const s of res.stopped) {
      notes.push(s.scope === 'everything'
        ? `"${s.name}" can no longer send anything on WhatsApp. ${s.reason}`
        : `"${s.name}" can no longer be used for a campaign (replies and alerts still work). ${s.reason}`);
    }
    for (const c of res.campaigns_stopped) {
      notes.push(`The campaign "${c.name}" (${c.state}) can no longer be started. ${c.reason}`);
    }
    for (const c of res.name_conflicts) {
      notes.push(`Meta has "${c.name}" in ${c.meta_language}, and the local template of that name is ${c.local_language}. Local template names are unique, so only one language of a name can be tracked here — rename one of them if you need both. (A difference of spelling only — en vs en_US — is reconciled automatically and is not reported here.)`);
    }
    for (const m of res.missing_at_meta) {
      notes.push(`"${m.name}" was submitted from here but is not in Meta's list — it may have been deleted at Meta, or submitted against a different WhatsApp Business Account.`);
    }
    /* THE WAY BACK IS OFFERED WHENEVER THIS REFRESH CHANGED ANYTHING HE CAN SEE —
     * not only when something stopped sending.
     *
     * It used to be offered only on `stopped`/`campaigns_stopped`, which made
     * sense while an unrecognised name refused a send. Since the 2026-09-15
     * ruling it does not: the ordinary outcome of a refresh is now that nothing
     * stops and every message picks up a WARNING instead — and a wrong WhatsApp
     * account produces exactly that, on all of them at once, with `stopped`
     * empty. That is the case the owner most needs a way back from, and it was
     * the one case this sentence did not appear in. */
    if (res.stopped.length || res.campaigns_stopped.length
      || res.updated.length || res.adopted.length || res.missing_at_meta.length) {
      notes.push('If this is not what you expected, "Put it back the way it was" restores every status, every warning and the previous checked-at time exactly as they were.');
    }

    // res.ok is already true here (the !res.ok branch returned above).
    return Response.json({ ...res, notes });
  } catch (e: any) {
    console.error('[/api/whatsapp/templates/sync]', e);
    /* WHAT THE OWNER IS SHOWN WHEN THIS FAULTS — a sentence, not a stack trace.
     *
     * This is the banner text: TemplateStudio does onError(j.error || …), so
     * whatever is put here is what a restaurant owner reads. It used to be
     * `e?.message || 'Sync failed.'`, which is two problems in one line. The
     * fallback said "Sync" — a word from this codebase, not from his trade —
     * and said nothing he could act on. And the usual case never reached the
     * fallback at all: `e.message` is a raw internal fault, so what actually
     * landed on his screen was measured as "SQLITE_BUSY: database is locked".
     * The engineering detail belongs in console.error above, where it already
     * is, and nowhere else.
     *
     * TWO SENTENCES, because this catch covers two different actions. A
     * refresh and a preview DO ask WhatsApp; the undo above is a purely local
     * reversal that makes no WhatsApp call at all, and telling him "could not
     * check with WhatsApp" for a failed undo would name the wrong thing.
     *
     * "Nothing was changed" is a promise, so it is kept by construction rather
     * than by hope: every write on all three paths happens inside a
     * better-sqlite3 transaction (applyRefresh's tx, syncPreflight's rolled-back
     * tx, undoLastSync's tx), and a throw rolls that transaction back before it
     * reaches here. Measured: after a refresh forced to fault, all 11 rows are
     * byte-identical and the checked-at watermark is untouched. */
    const undoing = String(request.url || '').includes('undo=1');
    return Response.json({
      ok: false,
      error: undoing
        ? 'Could not put the last check back just now. Nothing was changed — try again in a minute.'
        : 'Could not check with WhatsApp just now. Nothing was changed — try again in a minute.',
    }, { status: 500 });
  }
}
