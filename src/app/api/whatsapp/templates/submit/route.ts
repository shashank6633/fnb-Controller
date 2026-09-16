/* eslint-disable @typescript-eslint/no-explicit-any */
import { requireRole } from '@/lib/auth';
import { getDb } from '@/lib/db';
import {
  submitTemplate, editTemplateAtMeta, validateTemplateDraft, draftFromRow,
  campaignsUsingTemplate, isManagedStatus,
} from '@/lib/wa-template-authoring';

/**
 * Send a locally-authored template to Meta for approval (admin only).
 *
 *   POST /api/whatsapp/templates/submit  { id, mode?: 'submit' | 'edit' }
 *     → { ok:true, status:'pending', meta_template_id }
 *     → { ok:false, error, errors? }
 *
 * mode 'submit' (default) creates the template at Meta. mode 'edit' updates an
 * ALREADY-REGISTERED template — which RESETS IT TO PENDING at Meta and is
 * rate-limited there, so any campaign currently sending from it will halt on
 * the next drain pass. That consequence is refused outright while a live
 * campaign depends on the template, and stated plainly in the response
 * otherwise: an edit is not a cosmetic act.
 *
 * ERRORS ARE VERBATIM. Whatever Meta says comes back unchanged, and is also
 * stored in meta_last_error. A paraphrased Graph error is an admin who cannot
 * tell why their template was refused.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const gate = await requireRole('admin');
    if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

    const b = await request.json().catch(() => ({}));
    const id = String(b?.id || '').trim();
    const mode = String(b?.mode || 'submit').trim();
    if (!id) return Response.json({ error: 'A template id is required.' }, { status: 400 });
    if (mode !== 'submit' && mode !== 'edit') {
      return Response.json({ error: "mode must be 'submit' or 'edit'." }, { status: 400 });
    }

    const db = getDb();
    const row = db.prepare('SELECT * FROM whatsapp_templates WHERE id = ?').get(id) as any;
    if (!row) return Response.json({ error: 'Template not found.' }, { status: 404 });

    if (!String(row.meta_category || '').trim()) {
      return Response.json({
        error: `"${row.name}" has no Meta category, so it is a local free-form template, not a submission draft. Set a Meta category (MARKETING / UTILITY / AUTHENTICATION) on it first — the choice is priced, roughly 7× between MARKETING and UTILITY.`,
      }, { status: 400 });
    }

    // Validate before spending a review cycle. Same check submitTemplate runs;
    // done here too so the response can carry EVERY problem at once.
    const v = validateTemplateDraft(draftFromRow(row));
    if (!v.ok) {
      return Response.json({
        error: `Not submitted — ${v.errors.length} problem(s) would get this template rejected by Meta.`,
        errors: v.errors,
      }, { status: 400 });
    }

    if (mode === 'edit') {
      if (!isManagedStatus(row.meta_status) || !String(row.meta_template_id || '').trim()) {
        return Response.json({
          error: `"${row.name}" has not been submitted to Meta yet, so there is nothing to edit there. Use mode 'submit' instead.`,
        }, { status: 400 });
      }
      // An edit resets the template to PENDING at Meta. A campaign mid-flight
      // would halt on the next drain pass — refuse rather than do that to it.
      const blocking = campaignsUsingTemplate(db, String(row.name));
      if (blocking.length) {
        return Response.json({
          error: `"${row.name}" is in use by ${blocking.length} unfinished campaign(s): ${blocking.map((c: any) => `"${c.name}" (${c.state})`).join(', ')}. Editing it at Meta resets it to PENDING, which would stop those campaigns mid-send. Cancel or finish them first.`,
          campaigns: blocking,
        }, { status: 409 });
      }
      const res = await editTemplateAtMeta(db, id);
      if (!res.ok) {
        return Response.json({ ok: false, error: res.error, errors: res.errors }, { status: 502 });
      }
      return Response.json({
        ok: true,
        status: res.status,
        meta_template_id: res.meta_template_id,
        note: `Edit accepted. "${row.name}" is back in PENDING review at Meta and cannot be used for a campaign until it is approved again. Meta rate-limits template edits.`,
      });
    }

    if (isManagedStatus(row.meta_status) && row.meta_status !== 'draft' && row.meta_status !== 'rejected') {
      return Response.json({
        error: `"${row.name}" is already registered with Meta (status: ${row.meta_status}). Submitting again would be refused as a duplicate name — use mode 'edit' to change it, or refresh the status list.`,
      }, { status: 409 });
    }

    const res = await submitTemplate(db, id);
    if (!res.ok) {
      // 502 = Meta refused; 400 = we refused locally before sending anything.
      const local = Array.isArray(res.errors) && res.errors.length > 0;
      return Response.json({ ok: false, error: res.error, errors: res.errors }, { status: local ? 400 : 502 });
    }

    return Response.json({
      ok: true,
      status: res.status,
      meta_template_id: res.meta_template_id,
      note: `Submitted. "${row.name}" is PENDING review at Meta — approval typically takes minutes but can take much longer. It cannot be used for a campaign until it is approved; refresh the template statuses to check.`,
    });
  } catch (e: any) {
    console.error('[/api/whatsapp/templates/submit]', e);
    return Response.json({ error: e?.message || 'Submission failed.' }, { status: 500 });
  }
}
