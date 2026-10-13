/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser, isManagement } from '@/lib/auth';
import { startSchedulerOnce } from '@/lib/scheduler';
import { isWaConfigured } from '@/lib/whatsapp';
import {
  createBroadcast, parseAudience, campaignProgress, broadcastSettings,
  paramOrderOf, BROADCAST_VARS, BROADCAST_FLAG, BROADCAST_CATEGORY,
  templateHeaderFill, paramCheckFor, providerAlias, providerAliasReason,
  mappingAckCheck, setCampaignAck, discardEmptyDraft, broadcastVenue,
  campaignPreviewBody, rememberReadMapping, setCampaignAckOrder,
} from '@/lib/wa-broadcast';
import {
  templateSendability, lastSyncAt, unverifiedWarning, categoryUnverifiedWarning,
} from '@/lib/wa-template-authoring';

/**
 * CRM — WhatsApp broadcast campaigns (/api/crm-calls/broadcasts).
 *
 * GET  → every campaign with progress + cost roll-up.
 * POST → create a DRAFT + queue its recipients. Sends NOTHING — starting is a
 *        separate explicit POST to /api/crm-calls/broadcasts/:id/action, and
 *        actual delivery happens from the scheduler-driven drain, throttled,
 *        with consent/cooldown/daily-cap enforced per recipient at send time.
 *
 * Management-only (admin / manager / HOD), the win-back gate. Creating a draft
 * is allowed while the broadcast flag is OFF — build and review a list without
 * being able to send it; the flag is enforced inside the drain.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Arm the in-process drain driver: the scheduler otherwise starts only on the
// first /api/upcoming-parties request, so a management visit to the campaign
// screen must be enough to get a queued campaign draining after a restart.
// Idempotent (globalThis guard) — same one-liner as upcoming-parties/route.ts.
startSchedulerOnce();

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  if (!isManagement(me)) return Response.json({ error: 'Management access required' }, { status: 403 });

  const db = getDb();
  let rows: any[] = [];
  try {
    rows = db.prepare(`SELECT * FROM wa_campaigns ORDER BY created_at DESC LIMIT 200`).all() as any[];
  } catch { rows = []; }

  // The venue's stored template bodies — the wizard's picker (win-back's
  // embedding pattern, so a manager never needs the admin-only /api/whatsapp
  // routes). MARKETING templates are what Meta actually delivers a broadcast
  // from; the rest are listed after them for reference.
  let templates: any[] = [];
  try {
    // The 9 original columns are unchanged and in the same order — the wizard
    // reads them by name and keeps working byte-identically. The lifecycle
    // columns are ADDED so the picker can show why a template is unusable
    // BEFORE the operator builds a 2,000-guest audience around it.
    //
    // meta_components is the ONLY place a template's header, footer and buttons
    // live, and it is what the wizard's WhatsApp-bubble preview renders — the
    // local `body` column is a copy of the body alone. It is here rather than
    // fetched from /api/whatsapp/templates because THAT route is admin-only and
    // this page is management (admin | manager | HOD): a manager's wizard
    // cannot call it. Widening this projection is the in-lane way to give the
    // picker more truth.
    templates = db.prepare(`
      SELECT id, name, category, language, body, provider_template_name, provider_language,
             param_order, send_as_template,
             meta_status, meta_category, meta_rejected_reason, var_spec, meta_components
      FROM whatsapp_templates WHERE is_active = 1
      ORDER BY CASE WHEN category = 'marketing' THEN 0 ELSE 1 END, name
    `).all() as any[];
  } catch {
    // The lifecycle columns are added by a boot migration, so they exist in
    // practice. If that migration has not run (an older DB opened by a newer
    // build), fall back to the ORIGINAL projection rather than handing the
    // wizard an empty picker — an empty list looks like "no templates" and is
    // indistinguishable from a real problem.
    try {
      templates = db.prepare(`
        SELECT id, name, category, language, body, provider_template_name, provider_language,
               param_order, send_as_template
        FROM whatsapp_templates WHERE is_active = 1
        ORDER BY CASE WHEN category = 'marketing' THEN 0 ELSE 1 END, name
      `).all() as any[];
    } catch { templates = []; }
  }

  // The SAME string the drain will really put in a {{venue}} blank — the
  // venue's own business name, the outlet label only as a fallback. The wizard
  // renders its previews from this, so a preview that says "Akan" is a preview
  // of the message that is actually sent. See broadcastVenue().
  const venue = broadcastVenue(db);

  const s = broadcastSettings(db);
  return Response.json({
    campaigns: rows.map(c => ({
      ...c,
      param_order: paramOrderOf(c),
      audience: (() => { try { return JSON.parse(c.audience || '{}'); } catch { return {}; } })(),
      ...campaignProgress(db, c),
    })),
    flag: { key: BROADCAST_FLAG, enabled: s.enabled },
    settings: s,
    templates,
    venue,
    wa: { configured: isWaConfigured() },
    // Empty = Meta's template list has never been pulled, so no template's
    // approval status is verified and the create gate stays permissive.
    templates_synced_at: lastSyncAt(db),
    can_configure: me.role === 'admin',
  });
}

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  if (!isManagement(me)) return Response.json({ error: 'Management access required' }, { status: 403 });

  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return Response.json({ error: 'Body must be an object' }, { status: 400 });
  }

  const name = String(body.name ?? '').trim();
  if (!name) return Response.json({ error: 'Campaign name is required' }, { status: 400 });

  const templateName = String(body.template_name ?? '').trim();
  if (!templateName) {
    return Response.json({
      error: 'An approved WhatsApp template name is required. A broadcast is MARKETING — Meta only delivers it from a template your venue has had approved (MARKETING category).',
    }, { status: 400 });
  }
  if (!/^[a-z0-9_]{1,512}$/.test(templateName)) {
    return Response.json({ error: 'Template name must be lowercase letters, digits and underscores (Meta naming rules)' }, { status: 400 });
  }

  // APPROVAL + CATEGORY GATE (create-time half). Only a template Meta has
  // APPROVED, in the MARKETING category, may be put on a campaign — a broadcast
  // is unsolicited, so it is marketing whatever the operator calls it, and Meta
  // refuses a marketing send from a UTILITY/AUTHENTICATION template for every
  // recipient identically. The other half lives in the drain, because neither
  // fact is permanent: Meta pauses templates on quality signals and can
  // recategorise them, so a campaign that was legal to create can become
  // illegal to send minutes later.
  //
  // THIS IS THE GATE — not the wizard's picker. The picker mirrors it so an
  // operator is not led into a dead end, but a mirror can be bypassed (this
  // route is callable directly) and a mirror can drift, so the refusal has to
  // live here as well.
  const language = String(body.language ?? 'en').trim() || 'en';
  const db = getDb();
  const sendable = templateSendability(db, templateName, language, { requireCategory: BROADCAST_CATEGORY });
  if (!sendable.ok) {
    return Response.json({
      error: sendable.reason,
      template_status: sendable.status,
      template_category: sendable.category || '',
    }, { status: 409 });
  }

  // THE NAME GATE. A saved template can record that Meta holds it under a
  // DIFFERENT name — and a campaign built on the local name then asks Meta for
  // a template it does not have, so all of it fails: not some, all. The wizard
  // has always said so, but only in the browser, and this route is callable
  // directly (curl, Postman, a script, a stale tab). A check that lives only on
  // a screen is not a check — src/proxy.ts guards PAGES, never API routes — so
  // the refusal lives here, and the screen keeps its copy as the early warning.
  //
  // Asked AFTER approval so a template that is both unapproved and renamed
  // still reads the same refusal it read before; asked BEFORE the audience is
  // resolved, because refusing 2,000 rows we never built is the cheap end.
  const alias = providerAlias(db, templateName);
  if (alias) {
    return Response.json({
      error: providerAliasReason(templateName, alias),
      template_provider_name: alias,
    }, { status: 409 });
  }

  const audience = parseAudience(body.audience);
  if (!audience) {
    return Response.json({
      error: "audience must be one of: {kind:'all_guests'} | {kind:'winback', days} | {kind:'min_visits', visits} | {kind:'birthday_month', month} | {kind:'tier', tier} | {kind:'phones', phones:[…]}",
    }, { status: 400 });
  }

  let paramOrder: string[] = [];
  if (Array.isArray(body.param_order)) {
    const given = body.param_order.map((v: unknown) => String(v ?? '').trim());
    /* A BLANK LEFT UNSET IS A QUESTION, NOT A ZERO (F3).
     *
     * These entries used to be dropped silently, which shortened the list and
     * turned "I have not said what goes in blank 2" into "this template takes
     * one parameter" — a different campaign from the one the sender was
     * building, refused a step later with a count error that names the wrong
     * fault. The screen now leaves an unnamed blank UNSET rather than guessing
     * it by position, so the empty entry has a meaning and it is answered here
     * in the same words the screen uses. */
    const blank = given.findIndex((v: string) => !v);
    if (blank >= 0) {
      return Response.json({
        error: `Blank ${blank + 1} has nothing chosen for it. WhatsApp fills blanks strictly in order, so a blank nobody has answered cannot be guessed — choose what goes in it (${BROADCAST_VARS.join(', ')}) before this campaign can be built.`,
        unset_blank: blank + 1,
      }, { status: 400 });
    }
    const bad = given.find((v: string) => !(BROADCAST_VARS as readonly string[]).includes(v));
    if (bad) return Response.json({ error: `Unknown template variable '${bad}'. Available: ${BROADCAST_VARS.join(', ')}` }, { status: 400 });
    paramOrder = given;   // [] is legal — a template with no placeholders
  }

  // PARAMETER GATE (create-time half — the drain re-asks on every pass, because
  // a template can be edited at Meta after this campaign is built). Approval is
  // not the only way a campaign fails for EVERY recipient identically: Meta
  // matches parameters to placeholders by count and position, so an under- or
  // over-mapped campaign burns its whole queue. Refusing here, before an
  // audience is resolved, is the cheap end of that.
  //
  // paramCheckFor() is the SAME two-layer check start, resume and the drain ask
  // (lib/wa-broadcast). The second layer is what an install that has never
  // synced needs: the lifecycle knows nothing about any of its rows, so the
  // first layer says "unknown" for all of them, and a campaign mapping ZERO
  // variables against a template whose saved wording and saved variable list
  // both say two used to be created, started and burnt without one warning.
  const mapping = paramCheckFor(db, templateName, paramOrder);
  if (!mapping.ok) {
    return Response.json({
      error: mapping.reason,
      template_placeholders: mapping.expected,
      param_count: mapping.provided,
    }, { status: 409 });
  }

  // HEADER GATE (create-time half — the drain re-asks on every pass). The third
  // whole-queue failure, and the one the transport cannot survive at all: the
  // drain sends BODY parameters only, so a template approved with a media
  // header (IMAGE/VIDEO/DOCUMENT — the usual shape of a marketing offer) or
  // with a {{n}} in its heading is refused by Meta for EVERY recipient. Before
  // this gate such a campaign was created with no warning whatsoever, and the
  // owner discovered it one burnt message at a time after confirming the cost.
  const header = templateHeaderFill(db, templateName);
  if (!header.ok) {
    return Response.json({
      error: header.reason,
      template_header_format: header.format,
    }, { status: 409 });
  }

  // THE ACKNOWLEDGEMENT GATE — the blanks nothing here can vouch for.
  //
  // The gate above refuses a mapping that CONTRADICTS an authoritative record
  // of what a blank means. A template adopted from Meta has no such record:
  // Meta hands its wording back with numbered blanks, so both wordings this app
  // holds are {{1}} and {{2}} and nothing anywhere says which is the guest and
  // which is the venue. A mapping that is exactly the wrong way round is then
  // the RIGHT number of parameters in a valid shape — Meta accepts every
  // message, nothing fails, the breaker never counts, the whole list is charged
  // and put into a 7-day cooldown having read "Hi Akan … your last visit to
  // Rahul Menon". The wizard's own first guess for an unnamed blank is by
  // POSITION, so on such a template the swap can be the DEFAULT.
  //
  // It must not be REFUSED — some templates legitimately put a constant in a
  // slot, and a check that cannot tell the difference would block honest
  // campaigns. So it is confirmed instead: the caller must hand back the exact
  // sentence this campaign would really send. A sender who has read it has read
  // the mistake; a script that never rendered the message cannot produce it.
  //
  // ON THE SERVER, not on the screen, for the same reason as the name gate
  // above: src/proxy.ts guards PAGES, never API routes.
  //
  // AND IT IS A REAL PERSON'S MESSAGE THAT MUST BE READ, not a description of
  // one. Handing back "Welcome to [the guest's name] — Akan, your table is
  // ready." proves only that the caller read the template row; every bracketed
  // label reads correctly whichever way round the blanks are, which is the
  // whole reason the swap survives a careful review. So the audience is
  // resolved FIRST and the sentence is the one a named guest on this very list
  // would receive: "Welcome to Lakshmi Devi — Akan, your table is ready." is
  // read as wrong by anybody, and no caller that skipped the audience can
  // produce it. Any real member of the list satisfies it — see realAckVerdict.
  // `learned: true` — and ONLY here. A reading this venue has already done for
  // this exact wording answers the question for good; asking the same question
  // on every campaign is how a confirmation becomes a reflex click. The
  // re-checks after the campaign exists (start, resume, every drain pass) do NOT
  // pass it: they compare the campaign as it is now against the confirmation
  // stored on it, which is a different question.
  const ack = mappingAckCheck(db, templateName, paramOrder, body.confirm_message, { audience, learned: true });

  /* THE SAME GATES, ANSWERED WITHOUT BUILDING ANYTHING (dry_run).
   *
   * The screen has to know whether a reading is required BEFORE it offers the
   * button, or it learns it from a 409 and the operator meets the demand as an
   * error rather than as a question. It used to guess with a client-side mirror
   * of this logic, which cannot see what this venue has already read — so it
   * showed the tick on every campaign forever, which is the habit this is
   * trying not to create.
   *
   * It answers the question and creates NOTHING: no campaign, no recipients, no
   * cost. And it does NOT hand back the sentence — the caller is given the guest
   * and must render the message itself, exactly as at the refusal below. */
  if (body.dry_run === true) {
    return Response.json({
      dry_run: true,
      ok: ack.ok,
      read_required: ack.required && !ack.ok,
      proof_recipient: ack.recipient,
      unproven_blanks: ack.positions,
      wording_notes: ack.cues,
      soft_disagreements: ack.soft,
      confirm_field: 'confirm_message',
      reason: ack.ok ? '' : ack.reason,
    }, { status: 200 });
  }

  if (!ack.ok) {
    /* THE REFUSAL NO LONGER CARRIES ITS OWN ANSWER.
     *
     * It returned `proof_sentence` — the exact string the next request needs —
     * beside a comment claiming a caller that never rendered the message could
     * not produce it. MEASURED: a caller that read no template row, resolved no
     * audience and rendered nothing copied that one field out of the 409 and
     * created, started and delivered the swapped campaign in two requests.
     *
     * What is handed back instead is the GUEST. Rendering the sentence from the
     * wording, the mapping and that guest is the work the confirmation is
     * supposed to represent; the screen does it, and anything that does not do
     * it cannot answer. The label form goes back too — it is derivable from the
     * template row alone, so it gives nothing away, and it is what start,
     * resume and the drain compare the STORED confirmation against. */
    return Response.json({
      error: ack.reason,
      proof_recipient: ack.recipient,
      unproven_blanks: ack.positions,
      wording_notes: ack.cues,
      confirm_field: 'confirm_message',
    }, { status: 409 });
  }

  /* WHAT IS SAVED AS "THE MESSAGE" IS NOT WHAT THE CALLER SAYS IT IS (F2).
   *
   * preview_body was stored verbatim from the request, and it is not cosmetic:
   * the start dialog shows it to the owner as the message, and the thread echo
   * falls back to it. A caller could therefore post an honest-looking sentence
   * and have the venue's own screens and its own WhatsApp history repeat that
   * sentence while the wire carried a different one — the swap with a clean
   * preview over it. It is now DERIVED from the wording this app actually
   * holds, and the caller's text is kept only where no wording exists at all
   * and its blanks line up with the mapping. Never a refusal. */
  const preview = campaignPreviewBody(db, templateName, body.preview_body, paramOrder.length);

  const result = createBroadcast(db, {
    name,
    templateName,
    // Meta's identity is the exact (name, language) pair. When the lifecycle
    // knows this template, store the language META has it in — not the one that
    // happened to be typed — so a send is never refused as "not in the
    // translation" over a spelling difference (en vs en_US).
    language: String(sendable.language || language),
    paramOrder,
    previewBody: preview.body,
    audience,
    throttlePerMin: Number(body.throttle_per_min) || 0,
    createdBy: me.email || me.name || me.id,
  });

  if (result.queued === 0) {
    // A refused request must not leave its work behind. The draft queued
    // nobody, so it cannot be started — but an orphan row on the campaign
    // screen is a create that half-succeeded while reporting failure.
    discardEmptyDraft(db, result.campaign.id);
    return Response.json({ error: 'This audience resolves to nobody with a usable WhatsApp number.', ...result }, { status: 400 });
  }

  // THE CONFIRMATION IS KEPT, not just checked. Start, resume and every drain
  // pass re-derive this campaign's real sentence and compare it with what was
  // confirmed here — so a param_order rewritten afterwards (PATCH does not ask
  // the mapping gate) or a state flipped around startBroadcast no longer
  // matches, and is refused before a message is attempted.
  //
  // THE LABEL FORM IS WHAT IS STORED. What was READ here names a real guest,
  // and that guest is not a durable fact about the campaign — an opt-out or a
  // cooldown between now and the first message would make the stored sentence
  // unreproducible and refuse a campaign that nothing is wrong with. The label
  // form is derived from the template and the mapping alone, which is exactly
  // what the later checks are guarding: change either one and it no longer
  // matches. See AckCheck.canonical.
  //
  // STORED WHETHER OR NOT ONE WAS DEMANDED HERE. A campaign whose blanks were
  // proved by a reading this venue did EARLIER (the `learned` overlay above) is
  // not asked again — but start, resume and the drain re-check without that
  // overlay, on purpose, and would then find no confirmation at all and refuse a
  // campaign nothing is wrong with. The label form is derived from the template
  // and the mapping alone, so storing it asserts nothing that was not checked:
  // change either one afterwards and it stops matching, which is the whole point
  // of keeping it.
  if (ack.canonical) setCampaignAck(db, result.campaign.id, ack.canonical);
  // AND THE MAPPING IT WAS MADE ABOUT, under a key only this route writes. The
  // start door replaces the stored SENTENCE with whatever a caller hands it, so
  // on a param_order rewritten by PATCH the start refusal was its own answer —
  // measured: echo the refusal's proof_sentence back and 20 swapped messages
  // went out. The mapping cannot be re-supplied there, so it is what the
  // confirmation is pinned to. See setCampaignAckOrder / campaignParamCheck.
  setCampaignAckOrder(db, result.campaign.id, paramOrder);

  /* AND THE READING ITSELF IS REMEMBERED (F6).
   *
   * Only a REAL one: `ack.real` is true only where the sentence handed back
   * named a guest genuinely on this list and every blank in it carried what the
   * mapping claims. A label form, or a template whose wording nothing here
   * holds, teaches nothing and is not recorded.
   *
   * Keyed to the WORDING, so an edit at Meta voids it and the next campaign
   * reads the new sentence. Narrow by construction: it proves these blanks for
   * THIS mapping — map them differently and the disagreement is raised again. */
  if (ack.real) rememberReadMapping(db, templateName, paramOrder, me.email || me.name || me.id);

  return Response.json({
    success: true,
    campaign: result.campaign,
    queued: result.queued,
    no_phone: result.no_phone,
    deduped: result.deduped,
    // Allowed, but on no evidence. Say so rather than implying the template was
    // checked and passed. The two gaps are different and are named separately:
    // nothing known at all, vs approved-but-category-never-recorded.
    warnings: [
      /* WHAT WHATSAPP'S LIST SAID — the whole reason this campaign was allowed
       * to be created rather than refused (owner's ruling, 2026-09-15). The
       * list said the message is missing, on hold, turned down or approved as
       * something else; that is shown here, at the moment the campaign is
       * built, and it is the ONLY place it appears before the cost line. It is
       * first in the list on purpose: it is the strongest thing anyone here
       * knows against this send. */
      ...(sendable.advisory ? [sendable.advisory] : []),
      ...(sendable.verified ? [] : [unverifiedWarning(templateName)]),
      ...(sendable.verified && !sendable.categoryVerified
        ? [categoryUnverifiedWarning(templateName, BROADCAST_CATEGORY)]
        : []),
      // Said out loud rather than done quietly: the caller's own copy of the
      // wording was not what got saved, and a silent substitution in a field
      // the owner reads as "the message" is the fault this closes, not a fix.
      ...(preview.note ? [preview.note] : []),
      /* THE READING THAT WAS NOT ASKED FOR, AND WHY.
       *
       * Where this template's blanks are vouched for only by a reading somebody
       * here made earlier, that campaign went through on one person's word — no
       * wording, no var_spec, no variable list said anything about those blanks.
       * That is the whole point of the memory (a question asked every week is a
       * reflex inside a month), and it is also a suppression of the only gate
       * this rail has. A suppression nobody can see is how a gate stops
       * existing, so it is named here with its date and its author: if the
       * mapping is in fact the wrong way round, this line is what lets the owner
       * find out who decided otherwise and when. */
      ...(ack.provenByReading ? [
        `The blanks in “${templateName}” are not named by its own wording, so nothing could check them — this campaign was allowed because ${ack.provenByReading.by || 'somebody here'} read the real message for this exact wording on ${ack.provenByReading.at} UTC and confirmed it. No reading was asked for again. If that mapping is wrong, every campaign on this wording is wrong until the wording changes or that reading expires.`,
      ] : []),
    ],
    template_verified: sendable.verified,
    template_category: sendable.category || '',
    // The label form: what /action and the drain compare the stored
    // confirmation against, so a caller starting this draft knows which
    // sentence to hand back there. The REAL sentence is deliberately not here
    // either — see the refusal above; nothing needs this route to write it out.
    proof_sentence_written: ack.canonical,
    proof_recipient: ack.recipient,
    preview_body_source: preview.source,
    unproven_blanks: ack.positions,
    wording_notes: ack.cues,
    note: 'Draft created. Nothing has been sent — start the campaign explicitly, and the throttled queue (with consent, cooldown and the daily cap enforced per message) does the rest.',
  }, { status: 201 });
}
