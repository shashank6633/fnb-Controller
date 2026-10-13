/* eslint-disable @typescript-eslint/no-explicit-any */
import { requireRole } from '@/lib/auth';
import { getDb, generateId } from '@/lib/db';
import {
  validateTemplateDraft, buildMetaComponents, paramOrderFromVarSpec,
  campaignsUsingTemplate, deleteTemplateAtMeta, lastSyncAt, isManagedStatus,
  META_CATEGORIES, redactSecrets, storedBlankMeaning, blankMeaningChanged,
  type TemplateDraft, type TemplateVar,
} from '@/lib/wa-template-authoring';
import { forgetReadings } from '@/lib/wa-broadcast';

/**
 * WhatsApp message templates — CRUD (admin only).
 *
 *   GET    /api/whatsapp/templates            → { templates: [...] }
 *   POST   /api/whatsapp/templates            → create { name, category?, language?, body, is_active? }
 *   PUT    /api/whatsapp/templates            → update { id, ...fields }  (partial)
 *   DELETE /api/whatsapp/templates?id=...     → delete
 *
 * Bodies support {{placeholder}} vars, rendered by renderTemplate() at send
 * time. Nothing here talks to WhatsApp — templates are pure data, ready for
 * the provider whenever it's configured.
 *
 * Provider-template columns (all optional, backward-compatible):
 *   send_as_template       0|1 — 1 routes notifyEvent through the provider's
 *                          approved-template API instead of free-form text.
 *   provider_template_name exact approved template name at Meta/Interakt.
 *   provider_language      e.g. 'en_US' (Meta) / 'en' (Interakt); empty falls
 *                          back to the `language` column.
 *   param_order            JSON array string of var names in {{1}},{{2}}… order;
 *                          empty falls back to WA_EVENT_PARAM_ORDER in the lib.
 *
 * META LIFECYCLE (additive — src/lib/wa-template-authoring.ts):
 *   A request carrying `meta_category` is AUTHORING FOR META: the row is
 *   validated against Meta's rules, its components are staged, and its status
 *   becomes 'draft' — ready for POST /api/whatsapp/templates/submit. A request
 *   WITHOUT meta_category behaves exactly as it always has, and a row with
 *   meta_status '' stays a local free-form template. That is what keeps the 11
 *   pre-existing rows and all seven of their consumers unchanged.
 *
 *   Pass `validate_only: true` to get the validation verdict with NOTHING
 *   written — the cheap way to check a draft before spending a Meta review.
 */
export const dynamic = 'force-dynamic';

const CATEGORIES = ['notification', 'marketing', 'approval', 'general'];

/** Pull the authoring draft out of a request body. Returns null when the
 *  request is not authoring for Meta (no meta_category) — the legacy path. */
function readDraft(b: any, fallback: { name: string; body: string; language: string }): TemplateDraft | null {
  if (b?.meta_category === undefined || String(b?.meta_category ?? '').trim() === '') return null;
  const vars: TemplateVar[] = Array.isArray(b?.var_spec)
    ? b.var_spec.map((v: any, i: number) => ({
        index: Number.isFinite(Number(v?.index)) ? Number(v.index) : i + 1,
        name: String(v?.name ?? ''),
        example: String(v?.example ?? ''),
      }))
    : [];
  return {
    name: String(b?.name ?? fallback.name).trim(),
    // Meta's language for the template: provider_language wins, then language.
    language: String(b?.provider_language ?? b?.language ?? fallback.language ?? '').trim(),
    meta_category: String(b?.meta_category ?? '').trim().toUpperCase(),
    body: String(b?.body ?? fallback.body ?? ''),
    header: b?.header !== undefined ? String(b.header) : undefined,
    header_example: b?.header_example !== undefined ? String(b.header_example) : undefined,
    footer: b?.footer !== undefined ? String(b.footer) : undefined,
    buttons: Array.isArray(b?.buttons) ? b.buttons : undefined,
    var_spec: vars,
  };
}

/**
 * Coerce an incoming param_order into a stored JSON-array string (or '').
 * Accepts an array of strings, a JSON-array string, or a comma-separated list
 * of variable names (the form the editor's label/placeholder/hint show).
 * Returns { value } on success or { error } for anything else.
 */
function coerceParamOrder(input: unknown): { value: string } | { error: string } {
  if (input === undefined || input === null || input === '') return { value: '' };
  let arr: unknown = input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return { value: '' };
    let parsed: unknown;
    let jsonOk = false;
    try { parsed = JSON.parse(trimmed); jsonOk = true; } catch { /* not JSON — fall through to comma-separated */ }
    arr = jsonOk && Array.isArray(parsed)
      ? parsed
      : trimmed.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (!Array.isArray(arr) || !arr.every(v => typeof v === 'string')) {
    return { error: 'param_order must be a JSON array or comma-separated list of variable names.' };
  }
  return { value: JSON.stringify(arr) };
}

/**
 * Non-finished campaigns grouped by the template name they send from — so the
 * UI can show WHO depends on a template BEFORE offering Delete, instead of only
 * refusing afterwards with a 409. Keyed by wa_campaigns.template_name, which is
 * the PROVIDER name a campaign actually sends (for a managed row that equals
 * whatsapp_templates.name, which is what the DELETE guard checks).
 *
 * One grouped query, not one per template. Returns {} when wa_campaigns is
 * absent (an older DB) — this is a courtesy for the UI; the authority is still
 * campaignsUsingTemplate() inside DELETE, which runs at the moment of deletion.
 */
function campaignUsage(db: ReturnType<typeof getDb>): Record<string, Array<{ id: string; name: string; state: string }>> {
  const out: Record<string, Array<{ id: string; name: string; state: string }>> = {};
  try {
    const rows = db.prepare(`
      SELECT id, name, state, template_name FROM wa_campaigns
      WHERE state IN ('draft', 'scheduled', 'sending', 'paused')
      ORDER BY created_at DESC
    `).all() as any[];
    for (const r of rows) {
      const key = String(r?.template_name || '').trim();
      if (!key) continue;
      (out[key] ||= []).push({ id: String(r.id), name: String(r.name || ''), state: String(r.state || '') });
    }
  } catch { /* no wa_campaigns table — nothing can be using a template */ }
  return out;
}

export async function GET() {
  try {
    const gate = await requireRole('admin');
    if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });
    const db = getDb();
    // Original 12 columns first, unchanged; lifecycle columns appended. Adding
    // columns is safe for every consumer (they read by name) — renaming or
    // dropping one would silently empty three screens.
    const templates = db.prepare(`
      SELECT id, name, category, language, body, is_active,
             provider_template_name, provider_language, param_order, send_as_template,
             created_at, updated_at,
             meta_template_id, meta_status, meta_category, meta_components,
             meta_rejected_reason, meta_last_error, meta_submitted_at,
             meta_status_checked_at, var_spec
      FROM whatsapp_templates ORDER BY category, name
    `).all() as any[];
    return Response.json({
      // meta_last_error holds Meta's own words, and Meta's commonest credential
      // error quotes the access token back inside them. New errors are redacted
      // before they are stored (graphError); redacting on the way OUT as well
      // covers rows written before that existed — the column is durable state
      // and this response is the only place it is read.
      templates: templates.map(t => ({ ...t, meta_last_error: redactSecrets(t.meta_last_error) })),
      meta_categories: META_CATEGORIES,
      // Empty → Meta's list has never been pulled, so no status here is verified.
      synced_at: lastSyncAt(db),
      // template_name → unfinished campaigns sending from it (delete guard preview).
      usage: campaignUsage(db),
    });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const gate = await requireRole('admin');
    if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });
    const b = await request.json().catch(() => ({}));
    const name = String(b?.name || '').trim();
    const body = String(b?.body || '').trim();
    if (!name) return Response.json({ error: 'Template name is required.' }, { status: 400 });
    if (!body) return Response.json({ error: 'Template body is required.' }, { status: 400 });
    const category = CATEGORIES.includes(b?.category) ? b.category : 'general';
    const language = String(b?.language || 'en').trim() || 'en';
    const providerTemplateName = String(b?.provider_template_name || '').trim();
    const providerLanguage = String(b?.provider_language || '').trim();
    const sendAsTemplate = b?.send_as_template ? 1 : 0;
    if (sendAsTemplate && !providerTemplateName) {
      return Response.json({ error: 'Provider template name is required when "Send as approved template" is on.' }, { status: 400 });
    }
    const paramOrder = coerceParamOrder(b?.param_order);
    if ('error' in paramOrder) return Response.json({ error: paramOrder.error }, { status: 400 });

    // ── Meta authoring path (only when meta_category is supplied) ──────────
    const draft = readDraft(b, { name, body, language });
    let metaCategory = '';
    let metaComponents = '';
    let metaStatus = '';
    let varSpec = '';
    let effectiveParamOrder = paramOrder.value;
    if (draft) {
      const v = validateTemplateDraft(draft);
      if (b?.validate_only) return Response.json({ ok: v.ok, errors: v.errors, would_create: true });
      if (!v.ok) {
        return Response.json({
          error: `This template would be rejected by Meta. ${v.errors.length} problem(s) found — fix them before submitting, because a Meta rejection costs a review cycle and does not say which rule was broken.`,
          errors: v.errors,
        }, { status: 400 });
      }
      metaCategory = draft.meta_category.toUpperCase();
      metaComponents = JSON.stringify(buildMetaComponents(draft));
      metaStatus = 'draft';
      varSpec = JSON.stringify(draft.var_spec ?? []);
      // param_order is DERIVED from var_spec so the broadcast wizard and the
      // submitted template can never disagree about what {{1}} means.
      effectiveParamOrder = paramOrderFromVarSpec(draft.var_spec);
    } else if (b?.validate_only) {
      return Response.json({
        ok: false,
        errors: [`validate_only needs a meta_category (one of ${META_CATEGORIES.join(', ')}) — there is nothing to validate against Meta's rules without it.`],
      });
    }

    const db = getDb();
    const id = generateId();
    try {
      db.prepare(`
        INSERT INTO whatsapp_templates
          (id, name, category, language, body, is_active,
           provider_template_name, provider_language, param_order, send_as_template,
           meta_category, meta_components, meta_status, var_spec)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, name, category, language, body, b?.is_active === false ? 0 : 1,
             providerTemplateName, providerLanguage, effectiveParamOrder, sendAsTemplate,
             metaCategory, metaComponents, metaStatus, varSpec);
    } catch (e: any) {
      if (String(e?.message || '').includes('UNIQUE')) {
        return Response.json({ error: `A template named "${name}" already exists.` }, { status: 409 });
      }
      throw e;
    }
    const template = db.prepare('SELECT * FROM whatsapp_templates WHERE id = ?').get(id);
    return Response.json({ ok: true, template });
  } catch (e: any) {
    console.error('[/api/whatsapp/templates POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const gate = await requireRole('admin');
    if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });
    const b = await request.json().catch(() => ({}));
    const id = String(b?.id || '');
    const db = getDb();
    const existing = db.prepare('SELECT * FROM whatsapp_templates WHERE id = ?').get(id) as any;
    if (!existing) return Response.json({ error: 'Template not found.' }, { status: 404 });

    const name = b?.name !== undefined ? String(b.name).trim() : existing.name;
    const body = b?.body !== undefined ? String(b.body).trim() : existing.body;
    if (!name) return Response.json({ error: 'Template name is required.' }, { status: 400 });
    if (!body) return Response.json({ error: 'Template body is required.' }, { status: 400 });
    const category = b?.category !== undefined
      ? (CATEGORIES.includes(b.category) ? b.category : 'general')
      : existing.category;
    const language = b?.language !== undefined ? (String(b.language).trim() || 'en') : existing.language;
    const isActive = b?.is_active !== undefined ? (b.is_active ? 1 : 0) : existing.is_active;
    const providerTemplateName = b?.provider_template_name !== undefined
      ? String(b.provider_template_name).trim() : (existing.provider_template_name ?? '');
    const providerLanguage = b?.provider_language !== undefined
      ? String(b.provider_language).trim() : (existing.provider_language ?? '');
    const sendAsTemplate = b?.send_as_template !== undefined
      ? (b.send_as_template ? 1 : 0) : (existing.send_as_template ?? 0);
    if (sendAsTemplate && !providerTemplateName) {
      return Response.json({ error: 'Provider template name is required when "Send as approved template" is on.' }, { status: 400 });
    }
    let paramOrderValue = existing.param_order ?? '';
    if (b?.param_order !== undefined) {
      const coerced = coerceParamOrder(b.param_order);
      if ('error' in coerced) return Response.json({ error: coerced.error }, { status: 400 });
      paramOrderValue = coerced.value;
    }

    // A managed row's NAME is Meta's identity for the template. Renaming it
    // locally would silently orphan the link to the approved template at Meta —
    // and notifyEvent()/missed-call-ack both look templates up BY NAME.
    if (isManagedStatus(existing.meta_status) && name !== existing.name) {
      return Response.json({
        error: `"${existing.name}" is registered with Meta (status: ${existing.meta_status}); its name is Meta's identity for the template and cannot be changed here. Create a new template under the new name and submit that.`,
      }, { status: 409 });
    }

    // ── Meta authoring path (only when meta_category is supplied) ──────────
    const draft = readDraft(b, { name, body, language });
    let metaCategory = existing.meta_category ?? '';
    let metaComponents = existing.meta_components ?? '';
    let metaStatus = existing.meta_status ?? '';
    let varSpec = existing.var_spec ?? '';
    if (draft) {
      const v = validateTemplateDraft(draft);
      if (b?.validate_only) return Response.json({ ok: v.ok, errors: v.errors, would_update: id });
      if (!v.ok) {
        return Response.json({
          error: `This template would be rejected by Meta. ${v.errors.length} problem(s) found — fix them before submitting, because a Meta rejection costs a review cycle and does not say which rule was broken.`,
          errors: v.errors,
        }, { status: 400 });
      }
      metaCategory = draft.meta_category.toUpperCase();
      varSpec = JSON.stringify(draft.var_spec ?? []);
      paramOrderValue = paramOrderFromVarSpec(draft.var_spec);
      // A row already live at Meta keeps its real status: editing the local
      // draft does NOT change what Meta approved. Only /submit or an explicit
      // Meta edit moves the status, so the gate keeps telling the truth.
      if (!isManagedStatus(metaStatus)) metaStatus = 'draft';
      /* META'S OWN COMPONENTS ARE META'S RECORD, NOT A DRAFT OF OURS.
       *
       * meta_components is documented (and read by three gates) as "what Meta
       * returned for this template". For a row Meta has actually answered about,
       * rebuilding it from this form asserts an approval Meta never gave:
       * MEASURED — a PUT with the variable names reversed rewrote the stored
       * examples from ["Priya","AKAN"] to ["AKAN","Priya"] with meta_status still
       * 'approved' and no Meta round-trip, and the header/parameter gates then
       * believed it. So it is staged locally ONLY while the row is still a local
       * draft; once Meta has spoken, only a sync or a submit response may write it. */
      if (metaStatus === 'draft' || !isManagedStatus(metaStatus)) {
        metaComponents = JSON.stringify(buildMetaComponents(draft));
      }
    } else if (b?.validate_only) {
      return Response.json({
        ok: false,
        errors: [`validate_only needs a meta_category (one of ${META_CATEGORIES.join(', ')}) — there is nothing to validate against Meta's rules without it.`],
      });
    }

    /* ── WOULD THIS SAVE CHANGE WHAT EVERY GUEST READS? ──
     *
     * The blank-meaning record (var_spec by index, else the stored variable list)
     * is what decides which guest detail goes into {{1}}. Re-point it on a row
     * Meta has already approved and the template keeps its approval, its name and
     * its status while every campaign built on it starts sending a DIFFERENT
     * sentence — with nothing on screen saying so.
     *
     *   MEASURED. One PUT with the same body and the two variable names swapped
     *   returned 200 with the response keys ["ok","template"], left meta_status
     *   'approved', and the campaign that then went out read "Hi Akan, we would
     *   love to see you at Rahul Verma again soon." The honest mapping was refused
     *   in its place, quoting the CORRECT sentence as the fault. A legacy PUT
     *   carrying nothing but param_order did the same thing with even less on
     *   screen.
     *
     * So a save that re-points a Meta-approved template is REFUSED until it is
     * confirmed, and it names the campaigns that would change meaning — the same
     * courtesy DELETE has always had. Confirming it throws away every reading
     * that answered for the old sentence, so nobody inherits a tick given to a
     * message this app no longer sends. A row still local (draft or free-form) is
     * untouched by this: there is nothing approved to contradict. */
    /* THE SAVED WORDING IS READ TOO, because it is what the send side reads.
     *
     *   MEASURED. One PUT that changed ONLY the body — the same sentence with the
     *   two blank names exchanged — passed this guard without a word, because
     *   var_spec and the stored list were untouched. blankMeanings ranks the
     *   body's named blanks above the stored list, so the gate then treated the
     *   SWAPPED mapping as proven and hard-refused the honest one. Every one of
     *   this venue's 11 templates names its blanks in the body, so the column this
     *   guard could not see was the column that decides. */
    const meaningBefore = storedBlankMeaning(existing.var_spec, existing.param_order, existing.body);
    const meaningAfter = storedBlankMeaning(varSpec, paramOrderValue, body);
    const metaAnswered = isManagedStatus(existing.meta_status) && String(existing.meta_status) !== 'draft';
    let forgot: { template: boolean; campaigns: string[] } | null = null;
    if (metaAnswered && blankMeaningChanged(meaningBefore, meaningAfter)) {
      const affected = campaignsUsingTemplate(db, String(existing.name));
      const was = meaningBefore.length ? meaningBefore.map(v => `"${v}"`).join(', ') : 'nothing recorded';
      const now = meaningAfter.length ? meaningAfter.map(v => `"${v}"`).join(', ') : 'nothing recorded';
      if (b?.confirm_meaning_change !== true) {
        return Response.json({
          error: `This would change what the blanks of "${existing.name}" mean — from ${was} to ${now} — and Meta has already approved it as it stands (status: ${existing.meta_status}). Nothing is sent to Meta by this save, so the template keeps its approval while every message built on it starts saying something different. ${affected.length ? `${affected.length} unfinished campaign(s) use it: ${affected.map(c => `"${c.name}" (${c.state})`).join(', ')}. ` : 'No unfinished campaign uses it right now. '}If the wording really did change at Meta, submit the change to Meta (Edit at Meta) so its own record moves too. To save the re-ordering here anyway, send it again with confirm_meaning_change.`,
          meaning_change: { from: meaningBefore, to: meaningAfter },
          campaigns: affected,
          needs_confirmation: true,
        }, { status: 409 });
      }
      forgot = forgetReadings(db, String(existing.name));
    }

    try {
      db.prepare(`
        UPDATE whatsapp_templates
        SET name = ?, category = ?, language = ?, body = ?, is_active = ?,
            provider_template_name = ?, provider_language = ?, param_order = ?, send_as_template = ?,
            meta_category = ?, meta_components = ?, meta_status = ?, var_spec = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(name, category, language, body, isActive,
             providerTemplateName, providerLanguage, paramOrderValue, sendAsTemplate,
             metaCategory, metaComponents, metaStatus, varSpec, id);
    } catch (e: any) {
      if (String(e?.message || '').includes('UNIQUE')) {
        return Response.json({ error: `A template named "${name}" already exists.` }, { status: 409 });
      }
      throw e;
    }
    const template = db.prepare('SELECT * FROM whatsapp_templates WHERE id = ?').get(id);
    return Response.json({
      ok: true,
      template,
      // Said out loud, because the operator confirmed a change of MEANING and the
      // consequences are not visible in the row he gets back.
      ...(forgot ? {
        meaning_changed: { from: meaningBefore, to: meaningAfter },
        warning: `Saved. The blanks of "${String(existing.name)}" now mean ${meaningAfter.length ? meaningAfter.map(v => `"${v}"`).join(', ') : 'nothing recorded'}, and Meta has not been told — its own record still describes the old wording, so submit the change there too if the message really did change. ${forgot.campaigns.length ? `The reading confirmed on ${forgot.campaigns.length} unfinished campaign(s) has been cleared, so each will ask for the real message to be read again before it can start.` : 'Any campaign built on it from now on will ask for the new message to be read before it can start.'}`,
      } : {}),
    });
  } catch (e: any) {
    console.error('[/api/whatsapp/templates PUT]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

/**
 * DELETE /api/whatsapp/templates?id=…[&at_meta=1]
 *
 * REFUSES while a non-finished campaign (draft/scheduled/sending/paused) uses
 * this template — deleting it would leave that campaign pointing at nothing,
 * and a `sending` one would fail every remaining recipient one at a time.
 *
 * `at_meta=1` ALSO deletes it at Meta. That is by NAME and removes EVERY
 * language of the template — irreversible, and it cannot be undone by
 * re-creating the row here.
 */
export async function DELETE(request: Request) {
  try {
    const gate = await requireRole('admin');
    if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });
    const url = new URL(request.url);
    const id = url.searchParams.get('id') || '';
    const alsoMeta = ['1', 'true', 'yes'].includes(String(url.searchParams.get('at_meta') || '').toLowerCase());
    const db = getDb();

    const existing = db.prepare('SELECT * FROM whatsapp_templates WHERE id = ?').get(id) as any;
    if (!existing) return Response.json({ error: 'Template not found.' }, { status: 404 });

    const blocking = campaignsUsingTemplate(db, String(existing.name));
    if (blocking.length) {
      return Response.json({
        error: `"${existing.name}" is in use by ${blocking.length} campaign(s) that have not finished: ${blocking.map(c => `"${c.name}" (${c.state})`).join(', ')}. Cancel or finish them first — deleting the template now would leave those campaigns pointing at a template that no longer exists.`,
        campaigns: blocking,
      }, { status: 409 });
    }

    // Meta first: if that fails, the local row must survive so the operator can
    // retry. A local row with no Meta counterpart is recoverable; the reverse
    // (deleted at Meta, still listed here as approved) is a lie.
    let meta: { ok: boolean; error?: string } | undefined;
    if (alsoMeta) {
      if (!String(existing.meta_template_id || '').trim() && !isManagedStatus(existing.meta_status)) {
        return Response.json({
          error: `"${existing.name}" was never registered with Meta from here, so there is nothing to delete at Meta. Re-send without at_meta=1 to remove the local row only.`,
        }, { status: 400 });
      }
      meta = await deleteTemplateAtMeta(String(existing.name));
      if (!meta.ok) {
        return Response.json({
          error: `Meta refused to delete "${existing.name}": ${meta.error}`,
          meta_error: meta.error,
          note: 'The local template was NOT deleted — nothing has changed. Fix the cause and retry, or delete the local row only by re-sending without at_meta=1.',
        }, { status: 502 });
      }
    }

    const r = db.prepare('DELETE FROM whatsapp_templates WHERE id = ?').run(id);
    if (r.changes === 0) return Response.json({ error: 'Template not found.' }, { status: 404 });
    return Response.json({
      ok: true,
      deleted_at_meta: !!alsoMeta,
      note: alsoMeta
        ? `Deleted here and at Meta. Meta deletes BY NAME, so every language of "${existing.name}" is gone.`
        : (isManagedStatus(existing.meta_status)
            ? `Deleted the local row only — "${existing.name}" still exists at Meta and will reappear on the next template sync.`
            : undefined),
    });
  } catch (e: any) {
    console.error('[/api/whatsapp/templates DELETE]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
