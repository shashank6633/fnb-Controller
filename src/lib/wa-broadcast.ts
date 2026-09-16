/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Broadcast campaign engine — audience → queue → throttled drain → report.
 *
 * SIBLING of src/lib/ct/winback.ts (same claim discipline, same gates) with
 * the pieces a QUEUED broadcast needs on top:
 *
 *   • DURABLE QUEUE. All state lives in wa_campaigns / wa_campaign_recipients
 *     — nothing in memory — so a restart resumes exactly where it stopped.
 *     drainBroadcasts() is driven by the house scheduler tick and by
 *     POST /api/cron/refresh-parties (both best-effort), the same dual-driver
 *     shape as defer-due. It sends NOTHING unless a campaign was explicitly
 *     started by a management POST.
 *
 *   • THROTTLE = PER-TICK BUDGET, not sleeps (no job in this app sleeps).
 *     budget ≈ msgs_per_min × minutes-since-last-drain, elapsed capped at
 *     ELAPSED_CAP_MIN so a dormant queue can never blast a backlog at once.
 *
 *   • CONSENT AT CLAIM TIME. Every recipient is re-checked against
 *     wa_marketing_consent when their row is CLAIMED — a STOP that arrives
 *     after the audience was previewed/queued still excludes them
 *     (state 'skipped_optout'). Preview filtering is advisory only.
 *
 *   • CROSS-CAMPAIGN COOLDOWN at claim time, against the last marketing send
 *     recorded ANYWHERE (this rail AND the win-back rail) — a guest in two
 *     campaigns gets ONE message per cooldown window.
 *
 *   • DAILY CAP across all campaigns (IST calendar day, both rails counted).
 *
 *   • TWO-PHASE CLAIM 'queued' → 'sending' → terminal. A crash mid-send
 *     leaves 'sending' rows that are NEVER auto-retried (reported as
 *     unconfirmed) — an unconfirmed row is a human's decision, not a retry's.
 *
 *   • THE WAMID IS STORED per recipient AND the send is recorded into the
 *     inbox thread (recordOutbound), so the existing webhook ingest updates
 *     delivery/read/failed both on the thread message AND (via
 *     wa-campaign-hooks) on the recipient row — including honest
 *     capped-vs-failed classification.
 *
 * GATES. drainBroadcasts() sends only when ALL hold:
 *   • ct_settings.broadcast_enabled === '1' (absent → OFF)
 *   • campaign.state === 'sending' (re-read before EVERY message, so
 *     pause/cancel takes effect within one message, not one batch)
 *   • the WhatsApp provider is configured (skipped when a test sender is
 *     injected — the mock IS the transport then)
 *   • recipient passes consent + cooldown + daily cap at claim time.
 */
import type Database from 'better-sqlite3';
import { generateId } from '@/lib/db';
import { ctSetting, setCtSetting } from '@/lib/ct/settings';
import { norm10, buildLoyaltyMap, buildDiningMap, syntheticGuests } from '@/lib/ct/guest-unify';
import { normalizePhone } from '@/lib/ct/phone';
import { winbackSegment, coerceBucket, istDateStr } from '@/lib/ct/winback';
import {
  sendWhatsAppTemplate, isWaConfigured, normalizeWaNumber, type WaSendResult,
} from '@/lib/whatsapp';
import { recordOutbound, upsertConversation, utcString, guestDirectoryFor } from '@/lib/wa-inbox';
import { isOptedOut, consentMap } from '@/lib/wa-consent';
import {
  templateSendability, paramMappingCheck, templatePlaceholders, type MetaCategory,
} from '@/lib/wa-template-authoring';

type DB = Database.Database;

// ─── Constants ─────────────────────────────────────────────────────────────

/** Cap on recipients in one campaign (venue-sized list, mirrors win-back). */
export const BROADCAST_TARGET_MAX = 2000;
/** Absolute cap on messages one drain pass may attempt. */
export const SEND_SLICE_MAX = 200;
/** Elapsed-minutes cap for budget math — a dormant queue never bursts. */
export const ELAPSED_CAP_MIN = 5;
/**
 * Consecutive send failures within one campaign that halt it. Low enough that a
 * systemic fault costs a handful of messages instead of a 2,000-guest queue,
 * high enough that a couple of genuinely unreachable numbers in a row does not
 * stop a healthy campaign. A single success resets the counter.
 *
 * COUNTED ACROSS DRAIN PASSES, not within one — see trailingFailStreak(). A
 * per-pass counter cannot reach this threshold at any throttle below it, which
 * is precisely the throttle a cautious venue configures.
 */
export const CONSECUTIVE_FAIL_HALT = 5;
/** ct_settings watermark key: ms-epoch of the last budgeted drain. */
export const DRAIN_WATERMARK_KEY = 'broadcast_drain_last_at';

/** Master flag — absent/anything-but-'1' → OFF (mirrors winback_enabled). */
export const BROADCAST_FLAG = 'broadcast_enabled';

/**
 * WHAT A BROADCAST *IS*, to Meta. Not a setting and not a preference: an
 * unsolicited message to a list is marketing, and Meta only delivers marketing
 * from a template approved in the MARKETING category. A UTILITY or
 * AUTHENTICATION template is refused for EVERY recipient identically — so this
 * belongs with the approval gate, asked at create, at start, at resume and on
 * every drain pass, and never merely in a dropdown. (A dropdown is not a gate.)
 */
export const BROADCAST_CATEGORY: MetaCategory = 'MARKETING';

/**
 * THE NAME META KNOWS THIS TEMPLATE BY, when it is not the name saved here.
 * '' when the two agree, when nothing is recorded, or when the row has gone.
 *
 * A venue's own list can hold a template under one name while Meta holds it
 * under another (a re-submission, an import, a rename). A campaign built on the
 * LOCAL name then asks Meta for a template it does not have, and every message
 * fails — 100% of them, at ~5 messages a time until the failure counter stops
 * the campaign. Cheap to ask, and the answer is already in the row.
 */
export function providerAlias(db: DB, templateName: string): string {
  const name = String(templateName || '').trim();
  if (!name) return '';
  let row: any;
  try { row = db.prepare(`SELECT name, provider_template_name FROM whatsapp_templates WHERE name = ?`).get(name); }
  catch { return ''; }
  if (!row) return '';
  const alias = String(row.provider_template_name || '').trim();
  return alias && alias !== String(row.name || '').trim() ? alias : '';
}

/** One refusal for that, written once, so the screen and the server say the same thing. */
export function providerAliasReason(templateName: string, alias: string): string {
  return `This venue's copy of “${templateName}” says WhatsApp holds the same template under a different name: “${alias}”. A campaign sent as “${templateName}” asks WhatsApp for a template it does not have, so every single message fails — none are delivered, and the campaign stops itself after the first few. Build the campaign on “${alias}” instead, or refresh the template list on Settings → Integrations → WhatsApp → Templates so the two names agree.`;
}

/**
 * The one sendability question the broadcast rail asks, asked identically
 * everywhere — WITH the name-vs-Meta's-name check folded in, so start, resume
 * and the drain all refuse it too. A template can be learned to be aliased
 * AFTER a draft was built on it (that is exactly what a "Refresh templates"
 * does), and a draft created before that must not sail through Start.
 */
export function campaignSendability(db: DB, c: Pick<BroadcastCampaign, 'template_name' | 'language'>) {
  const base = templateSendability(db, c.template_name, c.language, { requireCategory: BROADCAST_CATEGORY });
  if (!base.ok) return base;
  const alias = providerAlias(db, c.template_name);
  if (alias) return { ...base, ok: false, reason: providerAliasReason(String(c.template_name || '').trim(), alias) };
  return base;
}

/* ═══════════════ The THIRD whole-queue gate: the header ═══════════════ */

export interface HeaderFill {
  /** May this rail send this template at all? */
  ok: boolean;
  /**
   * True only when Meta's own components actually DESCRIBED a header. A row
   * whose components were never recorded proves nothing about its header, so
   * it is not refused — the same evidence discipline templateSendability()
   * applies to status and category.
   */
  known: boolean;
  /** Meta's header format, uppercase: '' | TEXT | IMAGE | VIDEO | DOCUMENT | LOCATION. */
  format: string;
  /** Empty when ok. Written to be shown to an operator verbatim. */
  reason: string;
}

/**
 * WHAT THIS RAIL CAN ACTUALLY FILL — the third way a campaign fails for EVERY
 * recipient identically, and the one neither the approval nor the parameter
 * gate catches.
 *
 * The drain calls sendWhatsAppTemplate(to, name, lang, bodyParams) and NOTHING
 * else: no headerParams, no headerMedia (see the drain's `sender` default). So
 * a template Meta approved with
 *
 *   • a MEDIA header (IMAGE / VIDEO / DOCUMENT / LOCATION) — the common shape
 *     for a marketing offer — is sent with no header component at all, and
 *     whatsapp.ts refuses it before the wire the moment a media header is
 *     attempted without an uploaded media id;
 *   • a TEXT header carrying a {{n}} — is sent with that placeholder unfilled,
 *     which Meta rejects the same way a short body-parameter list is rejected.
 *
 * Either way the refusal is a property of the TEMPLATE, not of the recipient,
 * so it burns the whole queue exactly like an unapproved or wrong-category one.
 * It therefore lives here, beside the other two, and is asked at create, at
 * start, at resume and on every drain pass.
 *
 * A FIXED TEXT header is fine and stays fine: Meta renders it from the approved
 * template, and this rail has nothing to supply for it.
 *
 * Evidence: meta_components, which is the only record of a header this app
 * holds (the local `body` column is the body alone). No components → `known`
 * false → allowed, because refusing on no evidence would block every venue
 * whose rows predate the template lifecycle.
 */
export function templateHeaderFill(db: DB, templateName: string): HeaderFill {
  const none: HeaderFill = { ok: true, known: false, format: '', reason: '' };
  const name = String(templateName || '').trim();
  if (!name) return none;

  let row: any;
  try { row = db.prepare(`SELECT meta_components FROM whatsapp_templates WHERE name = ?`).get(name); }
  catch { return none; }
  if (!row) return none;

  let comps: unknown;
  try { comps = JSON.parse(String(row.meta_components || '[]')); }
  catch { return none; }
  if (!Array.isArray(comps) || !comps.length) return none;

  const header = comps.find((c: any) => String(c?.type ?? '').toUpperCase() === 'HEADER') as any;
  if (!header) return { ok: true, known: true, format: '', reason: '' };

  const format = String(header?.format ?? 'TEXT').trim().toUpperCase();
  if (format !== 'TEXT') {
    const kind = format.toLowerCase();
    const a = 'aeiou'.includes(kind[0] || '') ? 'an' : 'a';
    return {
      ok: false, known: true, format,
      reason: `"${name}" was approved with ${a} ${kind} heading, so Meta expects ${a} ${kind} attached to every message sent from it. A broadcast sends message text only and has no file to attach, so Meta would refuse this campaign for every guest on the list, not just some. Pick a template whose heading is fixed text, or has no heading at all.`,
    };
  }

  const text = String(header?.text ?? '');
  if (/\{\{\s*[^{}]*?\s*\}\}/.test(text)) {
    return {
      ok: false, known: true, format,
      reason: `"${name}" has a blank in its heading ("${text.trim()}") — Meta requires a value for it on every message. A broadcast fills blanks in the message body only, so this campaign would be refused for every guest on the list, not just some. Pick a template whose heading is fixed text.`,
    };
  }

  return { ok: true, known: true, format, reason: '' };
}

/** The header question for ONE campaign — asked identically at start, resume and drain. */
export function campaignHeaderFill(db: DB, c: Pick<BroadcastCampaign, 'template_name'>): HeaderFill {
  return templateHeaderFill(db, c.template_name);
}

/* ═════════ WHAT CAN SEND RIGHT NOW — the whole estate, one answer ═════════ */

export interface TemplateStanding {
  name: string;
  language: string;
  /** Could a MARKETING campaign go out on it — ALL of this rail's gates asked. */
  campaigns_ok: boolean;
  /** The refusal, in the gate's own words. Empty when campaigns_ok. */
  campaigns_reason: string;
  /** Could any WhatsApp message at all be sent from it (replies, alerts). */
  any_ok: boolean;
  any_reason: string;
  /**
   * WHAT WHATSAPP'S LIST SAID about it that is worth telling the owner and is
   * NOT a reason to stop him — it was not on the list, it is on hold, it was
   * turned down, it is approved as something other than an offer. Empty when
   * there is nothing to say. Never affects campaigns_ok / any_ok.
   */
  advisory?: string;
}

export interface CampaignStanding {
  id: string;
  name: string;
  template_name: string;
  state: string;
  /** Would Start / Resume let this exact campaign run? */
  ok: boolean;
  reason: string;
}

export interface SendabilitySnapshot {
  templates: TemplateStanding[];
  campaigns: CampaignStanding[];
  /**
   * A READ THIS SNAPSHOT NEEDED DID NOT WORK.
   *
   * measureSendability catches its own database errors and answers with whatever
   * it could see, deliberately: a lock race must not be able to take a refresh
   * down. The cost of that is that "I saw nothing" and "there is nothing" are
   * the same VALUE — and the refresh's everything-would-stop guard read the
   * empty one as "this venue has nothing to lose" and waved the refresh through
   * with a clean bill of health. So the failure is now SAID, and the caller
   * (wa-template-authoring's measure()) treats it as "nothing was measured".
   */
  failed?: boolean;
}

/** The shape the template-lifecycle module asks for. See measureSendability. */
export type SendabilityProbe = (db: DB) => SendabilitySnapshot;

/**
 * EVERY SENDABILITY ANSWER IN THIS APP, TAKEN AT ONE MOMENT, WITH THE REAL GATES.
 *
 * WHY IT EXISTS. "What will Refresh do to what I can send?" was answered by
 * asking ONE of the four whole-queue gates — templateSendability, the approval
 * and category one. The other three were not asked, and a refresh informs all of
 * them, because all of them read columns only a refresh writes:
 *
 *   MEASURED. A campaign on ct_winback started fine. Meta then answered the
 *   refresh with ct_winback APPROVED as MARKETING — and components carrying an
 *   IMAGE header. The before-you-refresh card said "keeps_working · Meta has this
 *   one approved as a marketing template, so nothing changes", the report's
 *   `stopped` list named nobody, and Start afterwards returned header_unfillable
 *   — a refusal no operator action on the campaign can clear. Three of four
 *   probes were silent losses this way (IMAGE header, a {{1}} in a TEXT header,
 *   and Meta's body carrying more blanks than the campaign maps). The losses
 *   happened in the GOOD case: Meta really holding his templates approved.
 *
 * So the question is answered by MEASURING, not by projecting: take this whole
 * snapshot, apply the refresh, take it again, and diff. Every answer comes from
 * the function a Start actually calls, so the card, the report and the start door
 * cannot drift apart — there is only one implementation of each gate and no
 * second copy of its rules living inside the reporting code.
 *
 * THE PARAMETER GATE, AT TEMPLATE LEVEL, IS ASKED ONLY WHERE THIS APP HOLDS A
 * MAPPING. paramMappingCheck compares a count against a campaign's mapping, and
 * a template on its own has no campaign; its stored param_order is the mapping
 * every campaign on it starts from (the wizard seeds the slots with it), so where
 * that list is non-empty it is the honest probe. Where it is empty there is
 * nothing to compare and the question belongs to the campaigns below, which are
 * measured individually.
 */
export function measureSendability(db: DB): SendabilitySnapshot {
  const out: SendabilitySnapshot = { templates: [], campaigns: [] };

  let rows: any[] = [];
  // Only ACTIVE rows: every picker that sends from this table filters
  // is_active = 1 (the broadcast picker, the inbox out-of-window picker,
  // notifyEvent), so an inactive row was not sending before either and calling
  // it a loss would be a false claim rather than caution.
  //
  // THE CATCH STAYS (a lock race must not take a refresh down) AND IT NOW SAYS
  // SO. MEASURED: one SQLITE_BUSY on THIS statement and nothing else turned a
  // refresh that is correctly refused as a total loss into a silent, applied,
  // "nothing would stop working" all-clear.
  try { rows = db.prepare(`SELECT * FROM whatsapp_templates WHERE is_active = 1 ORDER BY name`).all() as any[]; }
  catch { rows = []; out.failed = true; }

  for (const r of rows) {
    const name = String(r?.name || '').trim();
    if (!name) continue;
    const language = String(r?.provider_language || r?.language || '').trim();

    const camp = campaignSendability(db, { template_name: name, language } as any);
    const any = templateSendability(db, name, language);
    const hf = templateHeaderFill(db, name);

    let stored: string[] = [];
    try {
      const v = JSON.parse(String(r?.param_order || '[]'));
      if (Array.isArray(v)) stored = v.map((x: unknown) => String(x ?? '').trim()).filter(Boolean);
    } catch { stored = []; }
    const pm = stored.length ? paramMappingCheck(db, name, stored) : { ok: true, reason: '' };

    const campReason = !camp.ok ? camp.reason : !hf.ok ? hf.reason : !pm.ok ? pm.reason : '';
    out.templates.push({
      name, language,
      campaigns_ok: camp.ok && hf.ok && pm.ok,
      campaigns_reason: campReason,
      // Replies and alerts supply their own parameters and never send a header
      // component, so those two gates are not theirs to fail — approval is.
      any_ok: any.ok,
      any_reason: any.ok ? '' : any.reason,
      // WHAT WHATSAPP SAID, carried alongside rather than folded into the
      // verdict. The before-you-check card shows it so the owner learns that a
      // message is on hold or missing from the list — without that fact being
      // allowed to take the message away from him.
      advisory: String(camp.advisory || any.advisory || ''),
    });
  }

  let camps: any[] = [];
  try {
    camps = db.prepare(`
      SELECT id, name, state, template_name, language, param_order
      FROM wa_campaigns WHERE state IN ('draft', 'scheduled', 'sending', 'paused')
      ORDER BY created_at DESC
    `).all() as any[];
  } catch { camps = []; out.failed = true; }

  for (const c of camps) {
    const send = campaignSendability(db, c);
    const pm = send.ok ? campaignParamCheck(db, c) : { ok: true, reason: '' };
    const hf = send.ok && pm.ok ? campaignHeaderFill(db, c) : { ok: true, reason: '' };
    const reason = !send.ok ? send.reason : !pm.ok ? pm.reason : !hf.ok ? hf.reason : '';
    out.campaigns.push({
      id: String(c?.id || ''), name: String(c?.name || ''),
      template_name: String(c?.template_name || ''), state: String(c?.state || ''),
      ok: send.ok && pm.ok && hf.ok, reason,
    });
  }

  return out;
}

/**
 * THROW AWAY EVERY READING THAT ANSWERED FOR A SENTENCE THAT HAS JUST CHANGED.
 *
 * A confirmation is a record of one person reading ONE message. Re-point the
 * blanks of a template and that reading answers for a message this app no longer
 * sends — so it must stop counting, or the next campaign inherits a tick that was
 * given to a different sentence. Two records are voided:
 *
 *   • the venue's remembered reading for the template (F6's learned mapping),
 *     which otherwise makes the next campaign's blanks "already proven";
 *   • the per-campaign confirmation on every campaign that has not finished, so
 *     the start door asks again rather than matching a stale tick.
 *
 * Returns what it voided, for the caller to say out loud.
 */
export function forgetReadings(db: DB, templateName: string): { template: boolean; campaigns: string[] } {
  const name = String(templateName || '').trim();
  const out = { template: false, campaigns: [] as string[] };
  if (!name) return out;

  try { setCtSetting(db, CONFIRMED_MAP_PREFIX + name, ''); out.template = true; }
  catch { out.template = false; }

  let camps: any[] = [];
  try {
    camps = db.prepare(`
      SELECT id FROM wa_campaigns
      WHERE template_name = ? AND state IN ('draft', 'scheduled', 'sending', 'paused')
    `).all(name) as any[];
  } catch { camps = []; }
  for (const c of camps) {
    const id = String(c?.id || '');
    if (!id) continue;
    try {
      setCtSetting(db, ACK_PREFIX + id, '');
      setCtSetting(db, ACK_ORDER_PREFIX + id, '');
      out.campaigns.push(id);
    } catch { /* one campaign's record is not worth losing the rest */ }
  }
  return out;
}

/** Template vars a broadcast may map into {{1}},{{2}},… */
export const BROADCAST_VARS = ['name', 'venue', 'phone'] as const;
export type BroadcastVar = (typeof BROADCAST_VARS)[number];

/** What each broadcast variable is, in words an owner uses. */
export const BROADCAST_VAR_LABEL: Record<BroadcastVar, string> = {
  name: "the guest's name",
  venue: 'your venue name',
  phone: "the guest's phone number",
};

/**
 * WHICH BROADCAST VARIABLE — IF ANY — CAN FILL A BLANK CALLED THIS.
 *
 * A broadcast holds exactly three facts about one message: the guest's name,
 * the venue's name, and the guest's phone number (recipientVars()). A template
 * blank named anything else — {{day}}, {{open_time}}, {{answered_pct}} — has no
 * value this rail can put in it, and putting one of the three in anyway sends a
 * sentence that reads wrong to EVERY guest on the list. That is a whole-audience
 * failure Meta cannot catch: the parameter COUNT is right, so every message is
 * accepted and delivered, the circuit breaker never fires, and the cost is real.
 *
 * So the name is read as evidence of what a blank means, and only the three
 * meanings this rail can honour are accepted. `null` = "nothing here can fill
 * it", which the gate below turns into a refusal rather than a guess.
 *
 * VENUE IS TESTED FIRST — "venue_name" is a venue, not a name.
 *
 * DELIBERATELY NARROW. Stems that are ambiguous on their own are NOT here:
 * "number" (req_number is not a phone), "contact" (contact_person is a name),
 * "date", "time", "count". A false refusal costs one clear sentence on screen;
 * a false acceptance costs the whole audience.
 */
const BROADCAST_VAR_MATCH: ReadonlyArray<readonly [BroadcastVar, RegExp]> = [
  ['venue', /venue|restaurant|outlet|hotel|cafe|brandname|brand_name|businessname|business_name/i],
  ['phone', /phone|mobile|whatsapp|msisdn/i],
];

/**
 * A BLANK NAME BROKEN INTO WORDS — 'event_name' → ['event','name'],
 * 'guestName' → ['guest','name'], '{{ Full Name }}' → ['full','name'].
 *
 * The name rule below reads WORDS, not letters, because "name" as a bare
 * substring is the least specific stem in this file: it matches {{event_name}},
 * {{dish_name}} and {{offer_name}} just as happily as {{guest_name}}.
 */
function nameWords(name: string): string[] {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Words that ARE a person on their own, or as the thing a name belongs to. */
const PERSON_WORDS = new Set(['guest', 'customer', 'client', 'patron', 'member', 'recipient', 'diner', 'person']);
/** A qualifier that still leaves "…name" meaning A PERSON'S name. */
const PERSON_QUALIFIER = new Set([...PERSON_WORDS, 'first', 'last', 'full', 'given', 'sur', 'display', 'preferred', 'the']);
/** One-word spellings with no separator to split on. */
const PERSON_JOINED = new Set([
  'name', 'fullname', 'firstname', 'lastname', 'givenname', 'surname', 'guestname',
  'customername', 'clientname', 'patronname', 'membername', 'recipientname', 'dinername',
]);
/** Words that turn any of the above into a COUNT or an ID — never a person. */
const NOT_A_PERSON = new Set([
  'count', 'total', 'number', 'no', 'qty', 'quantity', 'id', 'code', 'pct', 'percent',
  'amount', 'value', 'date', 'time', 'day', 'month', 'year', 'list', 'type', 'status',
]);

/**
 * IS THIS BLANK A PERSON'S NAME? Asked in words, and narrowly.
 *
 * The old rule was the substring /name|guest|customer|client|patron/, which
 * reads {{event_name}}, {{dish_name}} and {{offer_name}} as the guest's name.
 * Putting the guest's name in one of those is the SAME whole-audience failure
 * the swap gate exists for — the parameter count is right, Meta accepts every
 * message, the breaker never fires, the cost is charged in full — and it slips
 * past unfillableBlanks() too, because a blank that "matched" is not refused.
 *
 * So: the last word must be "name" with a qualifier that is itself a person
 * ({{guest_name}}, {{first_name}}), or the whole name must be a person word.
 * Anything else qualifying a name — an event, a dish, an offer — is left
 * UNFILLABLE, which is the honest answer: a broadcast has no event name to put
 * there, and the existing refusal already says so in the owner's words.
 */
function isPersonName(raw: string): boolean {
  const w = nameWords(raw);
  if (!w.length) return false;
  if (w.some(x => NOT_A_PERSON.has(x))) return false;            // guest_count, name_id
  if (w.length === 1) return PERSON_JOINED.has(w[0]) || PERSON_WORDS.has(w[0]);
  if (w[w.length - 1] === 'name') return w.slice(0, -1).every(q => PERSON_QUALIFIER.has(q));
  return w.some(x => PERSON_WORDS.has(x));                       // contact_person, guest_full
}

/**
 * The broadcast variable a blank NAME asks for, or null when this rail has
 * nothing to put there. An EMPTY name is not "unfillable" — it is no evidence
 * at all (a positional {{1}}, or a var_spec row the author left unnamed), and
 * nothing is refused on no evidence.
 */
export function blankVar(name: unknown): BroadcastVar | null {
  const n = String(name ?? '').trim();
  if (!n) return null;
  for (const [v, re] of BROADCAST_VAR_MATCH) if (re.test(n)) return v;
  return isPersonName(n) ? 'name' : null;
}

/** Named blanks (position → name) this rail cannot fill. Unnamed ones never qualify. */
export function unfillableBlanks(names: readonly string[]): Array<{ position: number; name: string }> {
  const out: Array<{ position: number; name: string }> = [];
  (names || []).forEach((n, i) => {
    const nm = String(n ?? '').trim();
    if (nm && !blankVar(nm)) out.push({ position: i + 1, name: nm });
  });
  return out;
}

/**
 * A BLANK WHOSE OWN WORDING ASKS FOR ONE THING AND WHOSE MAPPING SUPPLIES
 * ANOTHER — the swapped campaign.
 *
 * The count gate cannot see this and neither can Meta. Map the guest's name
 * into {{venue}} and the venue into {{name}} and the campaign has exactly the
 * right number of values, in exactly the right shape; every message is
 * accepted, nothing fails, the breaker never counts, the cost is charged in
 * full and 2,000 guests read "Hi AKAN, it has been a while since your last
 * visit to Rahul Menon" and are locked out of another message for the cooldown.
 * It is two dropdown changes away, and every preview in this app agreed with it
 * because every preview substituted the mapping the operator chose.
 *
 * THE EVIDENCE IS ALREADY IN HAND, at exactly one place: `names[i]` is what the
 * template's author called blank i, and `paramOrder[i]` is what this campaign
 * will put there. blankVar() already reads the first into the vocabulary of the
 * second. Where they disagree that is a CONTRADICTION between two records of
 * the same template, not a guess about intent — so it is refused rather than
 * warned about, and it costs nothing to ask.
 *
 * ASKED ONLY WHERE THERE IS EVIDENCE:
 *   • an unnamed blank (a numbered {{1}}, or a name the author left empty) says
 *     nothing about what belongs there — skipped, never refused;
 *   • a name no broadcast variable matches ({{day}}) is a different fault with
 *     its own refusal — skipped here, caught by unfillableBlanks();
 *   • a mapped value outside name/venue/phone is the drop rule's business.
 *
 * POSITION-ALIGNED ARRAYS ONLY. The caller must pass two records of the SAME
 * shape of the template — the count gate above is what establishes that.
 */
export interface ContradictedBlank {
  /** 1-based blank number, the way Meta fills them. */
  position: number;
  /** What the wording calls this blank, e.g. 'venue'. */
  name: string;
  /** What that name asks for. */
  asks: BroadcastVar;
  /** What this campaign puts there instead. */
  mapped: BroadcastVar;
}

export function contradictedBlanks(
  names: readonly string[],
  paramOrder: readonly string[],
): ContradictedBlank[] {
  const out: ContradictedBlank[] = [];
  if (!Array.isArray(paramOrder)) return out;
  paramOrder.forEach((raw, i) => {
    const mapped = String(raw ?? '').trim();
    if (!(BROADCAST_VARS as readonly string[]).includes(mapped)) return;
    const nm = String((names || [])[i] ?? '').trim();
    const asks = blankVar(nm);
    if (!asks) return;                       // no evidence about this blank
    if (asks === mapped) return;             // the two records agree
    out.push({ position: i + 1, name: nm, asks, mapped: mapped as BroadcastVar });
  });
  return out;
}

/**
 * THE NAMES THE WORDING ITSELF GIVES ITS BLANKS — the only witness strong
 * enough to REFUSE a mapping on, position-aligned at `count`, '' where nothing
 * names that blank.
 *
 * Why not broadcastBlanks().names: that list is deliberately generous, and its
 * last resort is the stored VARIABLE list — this app's own record of what it
 * sends into each blank elsewhere. That is the same kind of statement as the
 * mapping under test, not an independent one, so a campaign that disagrees with
 * it may simply be a different (and legitimate) use of a numbered wording. A
 * blank the template's AUTHOR called {{venue}} is a different matter: he wrote
 * what belongs there, in the sentence itself.
 *
 * BOTH WORDINGS ARE ASKED, Meta's and the copy saved here, because a sync
 * writes Meta's body — which comes back with NUMBERED blanks — without touching
 * the saved one. Reading only Meta's would delete this check on the day someone
 * clicks "Refresh templates", which is exactly how the last hole in this area
 * was opened. Each is read ONLY at the count in question: a wording of a
 * different shape is aligned with nothing.
 */
function wordingBlankNames(db: DB, templateName: string, count: number): string[] {
  return blankMeanings(db, templateName, count).map(m => (m.refusable ? m.name : ''));
}

/* ═════════════ WHAT EACH BLANK MEANS, AND HOW WELL IT IS KNOWN ═════════════ */

/**
 * Where a blank's meaning came from. The ORDER is the strength order.
 *
 *   meta_named    — Meta's own approved BODY names the blank ({{venue}}). The
 *                   wording Meta will really send. Nothing outranks it.
 *   var_spec      — the variable spec authored in this app and submitted WITH
 *                   the template, position by position. Not a copy of anything:
 *                   it is the declaration itself, so Meta answering in the
 *                   numbered dialect is a difference of dialect, not of fact.
 *   saved_wording — the body column: this app's COPY of the approved wording.
 *                   Authoritative on its own — but not when Meta has handed
 *                   back a wording of the same shape that names nothing, because
 *                   then the two records genuinely disagree and the local one
 *                   may simply be out of date (see `authoritative` below).
 *   stored_order  — the variable list this app's OTHER rails send for this
 *                   template. Evidence about meaning, but a different campaign
 *                   may legitimately use a numbered wording differently, so it
 *                   never refuses on its own.
 *   none          — a numbered {{1}} nobody has named. No evidence at all.
 */
export type BlankEvidence = 'meta_named' | 'var_spec' | 'saved_wording' | 'stored_order' | 'owner_confirmed' | 'none';

export interface BlankMeaning {
  /** 1-based blank number, the way Meta fills them. */
  position: number;
  /** What that record calls this blank; '' when nothing names it. */
  name: string;
  /** Which broadcast variable that name asks for. */
  asks: BroadcastVar | null;
  evidence: BlankEvidence;
  /**
   * Agreement with this record PROVES the blank — no reading is asked for.
   */
  authoritative: boolean;
  /**
   * Disagreement with this record REFUSES the campaign outright.
   *
   * SEPARATE FROM `authoritative` because the owner's own confirmed reading is
   * both and neither: it is good enough to stop asking him the same question
   * every week (so it proves the blank), and it is NOT good enough to refuse a
   * campaign on (it records what one person read once, not what Meta approved).
   * Every record that existed before this distinction is both, exactly as it
   * was — F2 is unchanged for them: a check that cannot distinguish a swap
   * from a stale record must warn, never refuse.
   */
  refusable: boolean;
  /**
   * AGREEMENT WITH THIS RECORD SETTLES THE BLANK — no reading asked for.
   *
   * Almost always true, and deliberately so: a gate that asks about a blank the
   * app's own records already vouch for teaches the operator to tick without
   * reading. The exception is a record about a DIFFERENT SENTENCE.
   *
   * When Meta has handed back a wording of this shape that names nothing, and
   * that wording is not the sentence saved here, the saved names describe a copy
   * Meta no longer sends. Agreement with them then proves nothing about
   * position: if the edit at Meta REORDERED the blanks, "blank 1 is {{name}}"
   * is a true statement about the old sentence and a false one about the wire.
   * MEASURED before this flag: local "Hi {{name}}, … your last visit to
   * {{venue}}." against Meta's "Hi {{1}}, … you last visited {{2}}. Come back
   * soon!" — the mapping [name, venue] was CREATED silently on the strength of
   * the stale copy, and would have been created just as silently had Meta's
   * edit put the venue in blank 1.
   *
   * So on a drifted wording the names are still shown and still argue (soft),
   * but they no longer settle anything: the real sentence is read once, which is
   * exactly F4's rule for a blank nothing reliable names. The CLIENT mirror has
   * always counted a non-authoritative agreement as unproven — this is the
   * server converging on it, not a new idea.
   */
  proves: boolean;
  /**
   * ANOTHER LOCAL RECORD OF THIS ROW NAMES THIS BLANK SOMETHING ELSE.
   *
   * When it is set, the blank keeps its name (the strongest record still gets to
   * say what it thinks) but refuses nothing and settles nothing — the real
   * sentence is read once, which is this gate's rule for every blank nothing
   * reliable names. See blankMeanings for the measured attack it closes.
   */
  contradicted?: boolean;
}

/**
 * EVERY RECORD THIS APP HOLDS ABOUT WHAT EACH BLANK MEANS, position-aligned at
 * `count`, strongest first.
 *
 * Replaces a reading that asked only the two WORDINGS. That left two holes the
 * same size as the one this gate was built for:
 *
 *   • a template ADOPTED from Meta is written back with Meta's NUMBERED body in
 *     both wordings, so both witnesses were blank and a swapped mapping was
 *     approved with no comment at all — while its var_spec / stored variable
 *     list, sitting in the same row, said exactly what each position meant;
 *   • conversely, where Meta HAS handed back a numbered wording of the right
 *     shape, the local copy was treated as proof and hard-refused a mapping
 *     that is correct for the wording Meta will actually send.
 *
 * Read ONLY at `count`: a record of a different length describes a different
 * shape of the template, and position 2 there is not position 2 here.
 */
export function blankMeanings(
  db: DB,
  templateName: string,
  count: number,
  /**
   * `learned` — also consult what the OWNER HIMSELF confirmed for this exact
   * wording (F6). Passed by the create gate only. The re-checks that run after
   * a campaign exists (start, resume, every drain pass) deliberately leave it
   * off: their job is to compare the campaign AS IT IS NOW against the
   * confirmation STORED ON IT, and a learned record would answer that question
   * with a different campaign's reading.
   */
  opts: { learned?: boolean } = {},
): BlankMeaning[] {
  const n = Math.max(0, Math.floor(count) || 0);
  const out: BlankMeaning[] = Array.from({ length: n }, (_, i) =>
    ({ position: i + 1, name: '', asks: null, evidence: 'none' as BlankEvidence, authoritative: false, refusable: false, proves: false }));
  if (!n) return out;

  let row: any;
  try {
    row = db.prepare(`SELECT body, meta_components, var_spec, param_order FROM whatsapp_templates WHERE name = ?`)
      .get(String(templateName || '').trim());
  } catch { return out; }
  if (!row) return out;

  let metaBody = '';
  try {
    const comps = JSON.parse(String(row.meta_components || '[]'));
    if (Array.isArray(comps)) {
      metaBody = String(comps.find((c: any) => String(c?.type ?? '').toUpperCase() === 'BODY')?.text ?? '');
    }
  } catch { metaBody = ''; }

  const metaCensus = bodyBlanks(metaBody);
  const metaNames = metaCensus.count === n ? alignedNames(metaCensus) : [];
  /**
   * META ANSWERED WITH A WORDING OF THIS SHAPE AND NAMED NONE OF IT — and the
   * copy saved here is not the same sentence.
   *
   * That second half matters. A sync writes Meta's body over nothing, and Meta
   * returns the numbered dialect, so after a refresh the local named copy and
   * Meta's numbered one are usually THE SAME SENTENCE written two ways — the
   * local names then line up with Meta's numbers position for position and are
   * as good as Meta's own. Only where the two wordings genuinely differ is the
   * local copy possibly out of date, and only there is it demoted to something
   * the owner is asked to read rather than something a campaign is refused on.
   *
   * THE BLANK MARK IS A NUL AND NOT A SPACE, deliberately: the step after it
   * collapses runs of whitespace, so a space would give “Hi {{1}}!” and “Hi !” the
   * same skeleton and call two different wordings the same sentence. It is
   * written as the ESCAPE '\u0000' rather than as the raw byte it used to be:
   * an embedded NUL made grep, less and review diffs treat this entire file as
   * BINARY, which is a poor property for the file the swap gate lives in.
   * Same character, same comparison, a file the owner's own tools can read.
   */
  const skeleton = wordingSkeleton;   // ONE function, not two copies of the same rule
  const sameWording = skeleton(metaBody) !== '' && skeleton(metaBody) === skeleton(row.body);
  const metaNumbered = metaBody.trim() !== '' && metaCensus.count === n
    && metaNames.every(x => !String(x || '').trim()) && !sameWording;

  /* var_spec IS READ BY ITS OWN index, NOT BY ARRAY ORDER.
   *
   * Every other reader of this column sorts by `index`:
   * paramOrderFromVarSpec() (wa-template-authoring) sorts before deriving the
   * stored variable list, and buildMetaComponents() sorts before handing Meta
   * the examples — so Meta's {{1}} is the entry whose index is 1, wherever it
   * happens to sit in the array. Reading the array in order inverted the whole
   * gate on a spec written out of order: MEASURED — var_spec
   * [{index:2,venue},{index:1,name}] made the CORRECT mapping a hard refusal
   * (which cannot even be clicked through) and let the swap through silently.
   *
   * A spec whose indices are not a clean 1..n permutation SAYS NOTHING AT ALL
   * here — not array order, which is a guess. Array order was the old fallback,
   * and it inverts against paramOrderFromVarSpec(), which sorts by index
   * unconditionally: on [{index:9,venue},{index:7,name}] the stored variable list
   * came out ["name","venue"] while this reader said ["venue","name"], so the
   * honest mapping was HARD-refused and the swap was accepted and delivered
   * (MEASURED). No shipped write path can produce such a row — the create route
   * refuses it (examples are keyed by index), the sync writes '[]' and the submit
   * route writes no spec — so this costs nothing today and removes the one shape
   * where two readers of one column could contradict each other. With no names,
   * the next tier speaks, and if none does the blank is unproven and the real
   * sentence is read once, which is the rule for every blank nothing reliable
   * names. */
  let specNames: string[] = [];
  try {
    const spec = JSON.parse(String(row.var_spec || '[]'));
    if (Array.isArray(spec) && spec.length === n) {
      const idx = spec.map((v: any) => Number(v?.index));
      const byIndex = idx.every((i: number) => Number.isInteger(i) && i >= 1 && i <= n)
        && new Set(idx).size === n;
      if (byIndex) {
        const slots: string[] = Array.from({ length: n }, () => '');
        spec.forEach((v: any) => { slots[Number(v?.index) - 1] = String(v?.name ?? '').trim(); });
        specNames = slots;
      }
    }
  } catch { specNames = []; }

  const bodyCensus = bodyBlanks(row.body);
  const bodyNames = bodyCensus.count === n ? alignedNames(bodyCensus) : [];

  let orderNames: string[] = [];
  try {
    const v = JSON.parse(String(row.param_order || '[]'));
    if (Array.isArray(v) && v.length === n) orderNames = v.map((x: unknown) => String(x ?? '').trim());
  } catch { orderNames = []; }

  /* [evidence, names, authoritative, proves]
   *
   * `proves` differs from `authoritative` in exactly one place, and only because
   * the two questions are different ones:
   *   authoritative — is DISAGREEMENT with this record a refusal?
   *   proves        — does AGREEMENT with it settle the blank, or must the real
   *                   sentence still be read once?
   * A saved wording that Meta has since replaced with a different sentence
   * still argues, and settles nothing — see BlankMeaning.proves.
   *
   * THE STORED VARIABLE LIST NEITHER REFUSES NOR PROVES, and the second half of
   * that sentence is a FIX, not a preference. It used to prove, and that made it
   * the one record a campaign could confirm ITSELF with:
   *
   *   MEASURED. An adopted row (var_spec '[]', Meta's numbered body, so nothing
   *   names any blank) demanded a reading, exactly as designed — every blank
   *   unproven, needsAck true, the swapped mapping refused at create. One legacy
   *   PUT carrying nothing but `param_order: 'venue,name'` then wrote the swap
   *   into this very column; blankMeanings answered from it at tier 4 with
   *   proves:true, needsAck went true → FALSE, and the swapped campaign reached
   *   the transport with no reading asked of anyone: every guest read "Hi Akan,
   *   we would love to see you at Rahul Verma again soon." The honest mapping was
   *   refused in its place.
   *
   * The flaw is circularity, not strength. A campaign's paramOrder IS this list
   * (the wizard seeds the slots from it), so "the campaign agrees with the stored
   * order" says only that the campaign copied what was stored — it is the same
   * record twice, and agreement with yourself proves nothing about which blank
   * Meta will put the venue in. It still ARGUES (a mapping that contradicts this
   * app's own list for the template is worth a question), so the tier stays; it
   * just no longer answers the question on the mapping's behalf.
   *
   * It also ends a server/client disagreement: the CLIENT mirror
   * (crm-calls/broadcasts/page.tsx) counts every non-authoritative agreement as
   * unproven and always has, so the screen asked for a reading the server then
   * decided was unnecessary. Now both ask. */
  const tiers: ReadonlyArray<readonly [BlankEvidence, readonly string[], boolean, boolean]> = [
    ['meta_named', metaNames, true, true],
    ['var_spec', specNames, true, true],
    ['saved_wording', bodyNames, !metaNumbered, !metaNumbered],
    ['stored_order', orderNames, false, false],
  ];

  /* ══ TWO LOCAL RECORDS THAT DISAGREE SETTLE NOTHING AND REFUSE NOTHING ══
   *
   * The tiers are ranked, so the strongest record that names a blank answers for
   * it — and until now it answered with FULL authority even where a weaker
   * record of the same row said something different. That is the door the swap
   * walks through:
   *
   *   MEASURED on ct_winback exactly as production holds it (a free-form row,
   *   param_order ["name","venue"], named blanks in the saved wording). ONE admin
   *   PUT rewrote the saved wording with the two names exchanged — same sentence,
   *   nothing else touched. No confirmation was asked (the editor's
   *   meaning-change guard reads var_spec and the stored list, never the
   *   wording), and the gate INVERTED: the swapped mapping became proven
   *   (needsAck false) and the HONEST one was hard-refused in its place. The
   *   swapped campaign was created with no reading asked of anyone and reached
   *   'sending'.
   *
   * The count-level version of this contradiction has always been handled —
   * templatePlaceholders refuses outright when the stored list and the saved
   * wording disagree about HOW MANY blanks there are. This is the same rule at
   * name level, and it is deliberately softer: a contradiction is not evidence of
   * a swap, it is the absence of evidence either way. So the blank keeps its name
   * and loses its authority — the real sentence is read once, and BOTH mappings
   * are treated alike. Neither is refused; neither is waved through.
   *
   * META'S OWN RECORD IS IMMUNE. meta_named is what WhatsApp will actually send;
   * a local copy that disagrees with it is the local copy being wrong, and
   * letting it demote Meta's answer would hand the same door a second key. */
  for (let i = 0; i < n; i++) {
    for (const [evidence, names, authoritative, proves] of tiers) {
      const nm = String(names[i] ?? '').trim();
      if (!nm) continue;
      const contradicted = evidence !== 'meta_named' && tiers.some(([other, otherNames]) => {
        if (other === evidence || other === 'meta_named') return false;
        const on = String(otherNames[i] ?? '').trim();
        return !!on && on.toLowerCase() !== nm.toLowerCase();
      });
      out[i] = {
        position: i + 1, name: nm, asks: blankVar(nm), evidence,
        authoritative: authoritative && !contradicted,
        refusable: authoritative && !contradicted,
        proves: proves && !contradicted,
        ...(contradicted ? { contradicted: true } : {}),
      };
      break;
    }
  }

  /* WHAT THE OWNER HIMSELF ALREADY READ (F6) — an OVERLAY, never a tier.
   *
   * A template Meta numbered names nothing, so every blank in it is unproven
   * and every campaign on it demands the same reading of the same sentence.
   * MEASURED on the adopted estate: 6 of 6 legitimate multi-blank campaigns
   * asked, every campaign, forever — and a prompt that appears every single
   * time is a habit inside a month, which is the failure mode a confirmation
   * dies of. Once this venue has read the real message for THIS wording and
   * confirmed it word for word, that reading is a record: it answers the
   * question, so the question stops being asked.
   *
   * IT ONLY EVER SPEAKS WHERE NOTHING ELSE DOES. Applied over the tiers rather
   * than inside them, and only where the blank has no authoritative record, so
   * a hard refusal that exists today cannot be softened by anything an operator
   * confirmed — the strong records keep their exact meaning.
   *
   * AND IT NEVER REFUSES. It records what one person read once; a mapping that
   * disagrees with it is asked to be read (soft), not refused — that is what
   * closes the uniform-mapping hole on a second campaign without ever hard-
   * refusing an owner who genuinely changed his mind about a blank.
   *
   * Keyed to the WORDING, so an edit at Meta throws the memory away and the
   * next campaign reads the new sentence.
   */
  if (opts.learned) {
    const learned = confirmedMapping(db, templateName, metaBody || String(row.body || ''));
    if (learned.length === n) {
      for (let i = 0; i < n; i++) {
        const nm = String(learned[i] ?? '').trim();
        if (!nm || out[i].authoritative) continue;
        out[i] = {
          position: i + 1, name: nm, asks: blankVar(nm),
          evidence: 'owner_confirmed', authoritative: true, refusable: false, proves: true,
        };
      }
    }
  }
  return out;
}

/* ═════ THE READING THIS VENUE HAS ALREADY DONE ═════
 *
 * One row per template (ct_settings, the same shelf the per-campaign
 * confirmation lives on — no migration, and nothing in db.ts to keep in step).
 * The wording is stored WITH the mapping because the mapping only means
 * anything about that sentence: change the sentence and the record is void.
 */
const CONFIRMED_MAP_PREFIX = 'broadcast_read_map_';

/**
 * HOW LONG A READING ANSWERS FOR — and why it is not "forever".
 *
 * The memory exists so a correct campaign is not asked the same question every
 * week; that is its whole justification, and it is a good one. But it is ONE
 * person's reading of ONE sentence, and it silences the only gate standing
 * between a nameless adopted template and a swapped send. A record that never
 * expires means a single mis-read — or a single confirmation produced by
 * something that rendered the sentence without anybody looking at it — buys
 * silence for the life of the wording.
 *
 * At this venue's own settings (7-day per-guest cooldown, so roughly four
 * campaigns a month on one audience) 90 days is about one reading per wording
 * per quarter: far too rare to become the reflex the F6 requirement is about,
 * and far too often to call "forever".
 */
const CONFIRMED_MAP_MAX_DAYS = 90;

/** Blank-marked, whitespace-collapsed — see the note on skeleton() above. */
export function wordingSkeleton(s: string): string {
  return String(s || '').replace(/\{\{\s*[^{}]*?\s*\}\}/g, '\u0000').replace(/\s+/g, ' ').trim();
}

/** A reading this venue really made: the mapping, when, and by whom. */
export interface ConfirmedReading {
  order: string[];
  /** UTC string, as every other timestamp in this file. */
  at: string;
  /** Who confirmed it, as the create route knows them ('' on an older record). */
  by: string;
}

/**
 * THE READING THIS VENUE HAS ALREADY DONE for `templateName` — but only while it
 * still answers the question being asked.
 *
 * Three ways it stops answering, and each of them matters:
 *   • THE WORDING CHANGED. The mapping only ever meant something about that
 *     sentence; an edit at Meta makes the record void, not merely stale.
 *   • IT IS OLDER THAN CONFIRMED_MAP_MAX_DAYS. See above.
 *   • IT CARRIES NO DATE AT ALL. A record written before this file dated them
 *     cannot be aged, so it is treated as expired rather than as eternal — fail
 *     toward asking, which costs exactly one reading.
 */
export function confirmedReading(
  db: DB,
  templateName: string,
  wording: string,
  nowMs?: number,
): ConfirmedReading | null {
  const now = wordingSkeleton(wording);
  if (!now) return null;
  let raw = '';
  try { raw = String(ctSetting(db, CONFIRMED_MAP_PREFIX + String(templateName || '').trim()) || ''); }
  catch { return null; }
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object' || String(v.w ?? '') !== now) return null;
    const order = Array.isArray(v.o) ? v.o.map((x: unknown) => String(x ?? '').trim()) : [];
    if (!order.length) return null;
    const at = String(v.t ?? '').trim();
    // Stored by utcString() as 'YYYY-MM-DD HH:MM:SS' (UTC, no zone marker) —
    // parsed as UTC explicitly, or a machine west of Greenwich reads every
    // record as younger than it is.
    const ms = at ? Date.parse(at.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(at) ? '' : 'Z')) : NaN;
    if (!Number.isFinite(ms)) return null;                    // undated → expired
    const ageDays = ((nowMs ?? Date.now()) - ms) / 86_400_000;
    if (!(ageDays >= 0) || ageDays > CONFIRMED_MAP_MAX_DAYS) return null;
    return { order, at, by: String(v.by ?? '').trim() };
  } catch { return null; }
}

/**
 * The mapping this venue confirmed for `templateName`, [] when nothing still
 * stands. Thin reader over confirmedReading() — blankMeanings' overlay wants the
 * names and nothing else.
 */
export function confirmedMapping(db: DB, templateName: string, wording: string, nowMs?: number): string[] {
  return confirmedReading(db, templateName, wording, nowMs)?.order ?? [];
}

/**
 * RECORD A READING THAT REALLY HAPPENED — the create route calls this, and only
 * where `mappingAckCheck` reported `real: true`, i.e. the sentence handed back
 * named a guest who is genuinely on this campaign's list. A label form, or a
 * confirmation of a template nothing here holds a wording for, teaches nothing
 * and is never recorded.
 *
 * The wording is resolved HERE, from the same witness blankMeanings reads back
 * (`ownerWording` — Meta's own BODY where we hold it, the saved copy
 * otherwise), so the record cannot be filed against a sentence that is not the
 * one it will be compared with.
 *
 * `by` is kept because this record SUPPRESSES the gate for months: an owner who
 * finds a wording mapped the wrong way round needs to know whose reading decided
 * that and when, and a record that cannot answer those two questions is not an
 * audit trail. It decides nothing — it only says.
 */
export function rememberReadMapping(db: DB, templateName: string, paramOrder: readonly string[], by?: string): void {
  rememberConfirmedMapping(db, templateName, ownerWording(db, templateName), paramOrder, by);
}

/** Remember a reading that really happened — called only where one was made. */
export function rememberConfirmedMapping(
  db: DB,
  templateName: string,
  wording: string,
  paramOrder: readonly string[],
  by?: string,
): void {
  const w = wordingSkeleton(wording);
  const o = (Array.isArray(paramOrder) ? paramOrder : []).map(v => String(v ?? '').trim());
  if (!w || !o.length || o.some(v => !v)) return;
  try {
    setCtSetting(db, CONFIRMED_MAP_PREFIX + String(templateName || '').trim(),
      JSON.stringify({ w: w.slice(0, 1600), o, t: utcString(Date.now()), by: String(by ?? '').slice(0, 120) }));
  } catch { /* settings unavailable — the gate then keeps asking, which is the safe end */ }
}

/**
 * THE VERDICT ON ONE MAPPING — what is proved wrong, what is only suspected,
 * and what nothing can vouch for at all.
 *
 * SWAPPABLE USED TO GATE EVERY SOFT OUTCOME, and that was a hole the size of
 * the one this whole gate was built for. The reasoning was "a mapping that puts
 * the SAME variable in every blank has no PERMUTATION that changes a word, so
 * there is nothing to check" — true about permutations, and beside the point.
 * The question is not "could these values be in the wrong ORDER" but "is the
 * right thing going into each blank", and a mapping can be wrong without being
 * a rearrangement of itself.
 *
 * MEASURED on the owner's own data, every one of these was created, started and
 * delivered with nothing asked on the server or the screen:
 *     ['venue','venue'] on "Hi {{1}}, thank you for visiting {{2}} last week."
 *       → "Hi Akan, thank you for visiting Akan last week."
 *     ['name','name']   → "Hi Ishita Banerjee, your table at Ishita Banerjee…"
 *     ['phone','phone'], venue³ at three blanks, name⁴ at four.
 * On the SAME templates the CORRECT mapping was refused until it was read. All
 * the friction landed on correct campaigns and none on this class.
 *
 * So the reading is asked wherever a blank is unproven or a record disagrees,
 * whatever the mapping's shape. `swappable` survives only as a fact about the
 * mapping, used to WORD the refusal — never to decide whether to ask.
 *
 * The noise this was guarding against is answered by the OWNER'S OWN READING
 * instead (blankMeanings' `learned` overlay): the question is asked once per
 * wording, not once per campaign.
 */
export interface MappingVerdict {
  /** Position-aligned record of what each blank means. */
  meanings: BlankMeaning[];
  /** An authoritative record says this blank means something else — REFUSED. */
  hard: ContradictedBlank[];
  /** A weaker record disagrees — said out loud beside the real sentence. */
  soft: ContradictedBlank[];
  /**
   * 1-based blanks NO RECORD NAMES AT ALL — a numbered {{1}} on a template
   * adopted from Meta, with no var_spec and no stored variable list behind it.
   * Nothing can be inferred about them, which is exactly why they are read.
   *
   * It used to mean "no AUTHORITATIVE record agrees", which swept in every
   * blank whose own app record agreed with the mapping — asking about blanks
   * the app itself already vouched for, on every campaign, forever.
   */
  unproven: number[];
  /**
   * Two or more DIFFERENT variables are mapped, so the values could additionally
   * be in the wrong ORDER. Reported so the refusal can say so in the owner's
   * words — NEVER a condition on whether the reading is asked for.
   */
  swappable: boolean;
  /** The real sentence must be read and confirmed before this may be sent. */
  needsAck: boolean;
}

export function mappingVerdict(
  db: DB,
  templateName: string,
  paramOrder: readonly string[],
  /** `learned` — count what this venue has already read for this wording (F6). */
  opts: { learned?: boolean } = {},
): MappingVerdict {
  const order = (Array.isArray(paramOrder) ? paramOrder : []).map(v => String(v ?? '').trim());
  const meanings = blankMeanings(db, templateName, order.length, { learned: !!opts.learned });
  const hard: ContradictedBlank[] = [];
  const soft: ContradictedBlank[] = [];
  const unproven: number[] = [];

  order.forEach((mapped, i) => {
    if (!(BROADCAST_VARS as readonly string[]).includes(mapped)) return;   // the drop rule's business
    const m = meanings[i];
    const asks = m ? m.asks : null;
    /* NOTHING NAMES THIS BLANK AT ALL — the adopted-from-Meta shape. No record
     * to agree or disagree with, so no amount of checking can say what belongs
     * here and the only honest gate is a reading. */
    if (!asks) { unproven.push(i + 1); return; }
    /* A RECORD AGREES WITH THE MAPPING. Even a weak one (this app's own variable
     * list for the template) is evidence FOR this mapping rather than against
     * it, and a gate that asks anyway on every campaign teaches the operator to
     * tick without reading. Only a record that DISAGREES, or no record at all,
     * is worth a question. */
    if (asks === mapped) {
      /* IT AGREES — but with what? A record about the sentence Meta will really
       * send settles it. A record about a sentence Meta has since replaced does
       * not: the names may be right about the old wording and wrong about which
       * blank is which now, so the real message is read once. */
      if (m.proves) return;
      unproven.push(i + 1);
      return;
    }
    /* Split on `refusable`, NOT on `authoritative`. They are the same thing for
     * every record Meta or the author wrote — but the owner's own remembered
     * reading is deliberately authoritative-and-not-refusable: good enough to
     * stop asking the same question weekly, not good enough to refuse a
     * campaign on. Splitting on `authoritative` would turn one operator's
     * reading into a hard refusal nobody can click through. */
    (m.refusable ? hard : soft).push({ position: i + 1, name: m.name, asks, mapped: mapped as BroadcastVar });
  });

  const distinct = new Set(order.filter(v => (BROADCAST_VARS as readonly string[]).includes(v)));
  const swappable = distinct.size >= 2;
  // ASKED ON THE EVIDENCE, NOT ON THE SHAPE. A blank nothing vouches for, or one
  // a weaker record argues with, is a blank whose contents nobody here can
  // stand behind — whether or not some rearrangement of this mapping would have
  // produced a different sentence. A campaign with no blanks asks nothing.
  return { meanings, hard, soft, unproven, swappable, needsAck: unproven.length > 0 || soft.length > 0 };
}

/** The wording an owner is shown for a template: Meta's own body where we hold it. */
function ownerWording(db: DB, templateName: string): string {
  let row: any;
  try { row = db.prepare(`SELECT body, meta_components FROM whatsapp_templates WHERE name = ?`).get(String(templateName || '').trim()); }
  catch { return ''; }
  if (!row) return '';
  try {
    const comps = JSON.parse(String(row.meta_components || '[]'));
    if (Array.isArray(comps)) {
      const body = comps.find((c: any) => String(c?.type ?? '').toUpperCase() === 'BODY');
      const text = String(body?.text ?? '');
      if (text) return text;
    }
  } catch { /* unreadable — fall through to the saved body */ }
  return String(row.body || '');
}

/**
 * One wording with its blanks filled IN THE ORDER META FILLS THEM — numbered
 * blanks first by their number, then named blanks in the order they appear,
 * which is the same alignment every count in this file is built on.
 *
 * Both dialects are substituted from the SAME mapping, deliberately: reading a
 * named blank by its own name is what let a swapped campaign print the correct
 * sentence on screen while the wire carried the wrong one.
 */
export function fillBlanksInOrder(body: string, values: readonly string[]): string {
  const text = String(body || '');
  const census = bodyBlanks(text);
  const order = alignedNames(census);
  const at = (i: number) => (i >= 0 && i < values.length ? String(values[i] ?? '') : '');
  return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, raw: string) => {
    const inner = String(raw ?? '').trim();
    if (!inner) return whole;
    if (/^\d+$/.test(inner)) {
      const n = Number(inner);
      return n >= 1 && n <= census.positional ? at(n - 1) : whole;
    }
    const idx = order.findIndex((n, i) => i >= census.positional && n.toLowerCase() === inner.toLowerCase());
    return idx >= 0 ? at(idx) : whole;
  });
}

/**
 * THE NAME THIS VENUE PUTS IN A {{venue}} BLANK.
 *
 * `settings.business_name` first — the venue's own public name, and already
 * what every other WhatsApp rail in this app sends (wa-report-builders.ts).
 * The broadcast rail alone read `outlets ORDER BY id LIMIT 1`, which on this
 * install is the internal outlet label "Main", so every broadcast would have
 * told 2,000 guests "your last visit to Main." — the right shape of sentence
 * with the wrong word in it, accepted and charged for in full.
 *
 * The outlet name remains the fallback, so an install that never set a business
 * name is unchanged.
 */
export function broadcastVenue(db: DB): string {
  const one = (sql: string) => {
    try { return String((db.prepare(sql).get() as any)?.v ?? '').trim(); } catch { return ''; }
  };
  return one(`SELECT value AS v FROM settings WHERE key = 'business_name'`)
    || one(`SELECT name AS v FROM outlets ORDER BY id LIMIT 1`);
}

/**
 * THE SENTENCE THIS CAMPAIGN WOULD REALLY SEND, as one fixed string.
 *
 * Built from the wording Meta will use and from THIS campaign's blank order, so
 * it changes the moment any dropdown changes. The venue blank carries the real
 * venue name because that is the half of a swap that shows: "Happy birthday
 * Akan!" is read as wrong by anyone, where "[your venue name]" is read as right
 * whichever way round the blanks are.
 *
 * It is the acknowledgement token as well as the warning: a caller that has not
 * seen this sentence cannot produce it, so confirming it cannot be done by
 * accident or by a script that never rendered the message.
 */
/**
 * WHAT EACH MAPPED VARIABLE PRINTS AS in a sentence shown to the owner: the
 * venue's REAL name, and a bracketed label for the things that differ per
 * guest.
 *
 * ONE function, used by every sentence this file shows, because the venue half
 * is the half that makes a swap visible and it had already drifted: the
 * contradiction refusal wrote “Hi [your venue name], … your last visit to [the
 * guest's name].” — two labels, a sentence whose shape reads correctly either
 * way round, which is precisely the reading failure this gate exists to stop.
 * “Hi Akan, it has been a while since your last visit to [the guest's name].”
 * is the same fact and cannot be read as right.
 */
function labelValues(db: DB, paramOrder: readonly string[]): string[] {
  const venue = broadcastVenue(db) || 'your venue';
  return (Array.isArray(paramOrder) ? paramOrder : []).map(k => {
    const v = String(k ?? '').trim();
    if (v === 'venue') return venue;
    if (v === 'name') return "[the guest's name]";
    if (v === 'phone') return "[the guest's phone number]";
    return `[${v || 'nothing chosen'}]`;
  });
}

export function proofSentence(db: DB, templateName: string, paramOrder: readonly string[]): string {
  const wording = ownerWording(db, templateName);
  if (!wording.trim()) return '';
  return fillBlanksInOrder(wording, labelValues(db, paramOrder)).trim();
}

/** Whitespace-insensitive comparison, so a wrapped textarea still matches. */
export function normalizeAck(s: unknown): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/* ═════ THE SENTENCE WITH A REAL PERSON'S NAME IN IT (F4) ═════
 *
 * proofSentence() above writes "[the guest's name]" where the guest goes, and
 * that is the half of the confirmation that can be read past. "Welcome to [the
 * guest's name] — Akan, your table is ready." is a description of a message;
 * the eye slides over a bracketed label and accepts the shape of the sentence.
 * "Welcome to Lakshmi Devi — Akan, your table is ready." is a message, and it
 * is wrong in a way nobody can read past.
 *
 * It is also the only form of the confirmation a script cannot fabricate. The
 * bracketed sentence can be built from the template row alone — anything that
 * can read the wording can produce it, so confirming it proves only that the
 * caller read the template. Naming a guest who is really on THIS list proves
 * the audience was resolved and the message was rendered for a person.
 */

/** Regex-escape, so a wording's punctuation cannot become pattern syntax. */
function reEscape(s: string): string {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * THE MESSAGE ONE REAL GUEST RECEIVES, rendered exactly the way the drain
 * renders it: blank ORDER from this campaign's own mapping, the sender's own
 * 'there' fallback for an unnamed guest, and the real venue name.
 *
 * Deliberately the SAME code path as the wire (fillBlanksInOrder) — a
 * confirmation rendered by a second, friendlier renderer is how the preview
 * that lied was built in the first place.
 */
export function realProofSentence(
  db: DB,
  templateName: string,
  paramOrder: readonly string[],
  recipient: { name?: string; phone_e164?: string } | null | undefined,
): string {
  const wording = ownerWording(db, templateName);
  if (!wording.trim()) return '';
  const vars: Record<string, string> = {
    name: String(recipient?.name || '').trim() || 'there',
    venue: broadcastVenue(db) || 'your venue',
    phone: String(recipient?.phone_e164 || '').trim(),
  };
  return fillBlanksInOrder(wording, (Array.isArray(paramOrder) ? paramOrder : [])
    .map(k => vars[String(k ?? '').trim()] ?? '')).trim();
}

/**
 * THE GUEST THE CONFIRMATION IS WRITTEN ABOUT — a real, NAMED person from the
 * audience actually being built, preferred over an unnamed one so the sentence
 * shown carries a name rather than the 'there' fallback.
 *
 * FIRST from previewAudience()'s eligible sample, which is the same list the
 * wizard's preview step showed, so the screen and the server name the same
 * person.
 *
 * THEN FROM THE WHOLE LIST, and this half is not a nicety.
 *
 * That sample is ELIGIBLE-ONLY — it excludes everyone inside the 7-day
 * cooldown. A venue that ran a broadcast this week therefore has an EMPTY
 * sample for its next one, which is not an edge case but the ordinary state of
 * a rail whose whole point is repeated campaigns. With no recipient the
 * sentence falls back to the bracketed label — "Welcome to [the guest's name]
 * — Akan, your table is ready." — and that sentence can be produced by anything
 * that can read the template row, so the confirmation stops proving anything
 * and the swap walks through wearing a cooldown. MEASURED on the owner's real
 * audience: 27 of 27 guests in cooldown, sample 0, a swapped adopted template
 * created HTTP 201 and started, its 27 recipients waiting for the cooldown to
 * lapse on its own.
 *
 * The queue does not care about eligibility either: createBroadcast() queues
 * every resolved guest and consent/cooldown are re-checked per message at send
 * time, so a guest who is merely cooled-off is still someone this campaign will
 * message. realAckVerdict() already checks the confirmation against the FULL
 * resolved audience for exactly that reason — this makes the guest we ASK about
 * come from the same set we CHECK against.
 */
export function audienceProofRecipient(db: DB, def: AudienceDef): { name: string; phone_e164: string } | null {
  const named = (list: Array<{ name: string; phone_e164: string }>) =>
    list.find(g => String(g.name || '').trim()) || null;

  let sample: Array<{ name: string; phone_e164: string }> = [];
  try { sample = previewAudience(db, def).sample || []; } catch { sample = []; }
  const eligible = named(sample);
  if (eligible) return eligible;

  // Nobody eligible RIGHT NOW (or nobody eligible with a name on record). The
  // list itself still has members, and they are who this campaign will write to.
  try {
    const all = resolveAudience(db, def).guests.map(g => ({ name: g.name, phone_e164: g.phone_e164 }));
    return named(all) || sample[0] || all[0] || null;
  } catch { return sample[0] || null; }
}

/**
 * EVERY NAME AND NUMBER THIS AUDIENCE REALLY CONTAINS — the set a confirmation
 * is checked against.
 *
 * Not "the one guest the screen happened to show": an audience can shift
 * between the preview and the create (a guest opts out, a visit lands), and
 * refusing a sender whose reading was perfectly correct because the FIRST
 * eligible row changed underneath them is the false positive that gets a gate
 * clicked through. Any real member of the list proves the same thing.
 */
function audienceIdentities(db: DB, def: AudienceDef): { names: Set<string>; phones: Set<string> } {
  const names = new Set<string>(['there']);       // the sender's own fallback
  const phones = new Set<string>();
  try {
    for (const g of resolveAudience(db, def).guests) {
      const nm = normalizeAck(g.name);
      if (nm) names.add(nm.toLowerCase());
      const ph = normalizeAck(g.phone_e164);
      if (ph) phones.add(ph);
    }
  } catch { /* audience unreadable — the caller falls back to the written proof */ }
  return { names, phones };
}

/**
 * READ A FILLED-IN SENTENCE BACK APART, position by position.
 *
 * The wording is turned into a pattern whose fixed words must match exactly and
 * whose blanks capture whatever was put in them, walked in the SAME order
 * fillBlanksInOrder() fills them. So a confirmation is not compared with one
 * blessed string — it is taken apart and each piece is checked for what it
 * actually is.
 *
 * null means the fixed words themselves do not match: a different wording, a
 * different template, or an invented sentence.
 */
export function parseFilledWording(
  wording: string,
  filled: unknown,
  slotCount: number,
): string[] | null {
  const text = normalizeAck(wording);
  if (!text) return null;
  const census = bodyBlanks(text);
  const names = alignedNames(census);
  const slots: number[] = [];
  let src = '';
  let last = 0;
  for (const m of text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    const inner = String(m[1] ?? '').trim();
    const start = m.index ?? 0;
    src += reEscape(text.slice(last, start));
    last = start + m[0].length;
    let idx = -1;
    if (inner) {
      if (/^\d+$/.test(inner)) {
        const n = Number(inner);
        idx = n >= 1 && n <= census.positional ? n - 1 : -1;
      } else {
        idx = names.findIndex((nm, i) => i >= census.positional && nm.toLowerCase() === inner.toLowerCase());
      }
    }
    if (idx >= 0 && idx < slotCount) { src += '(.*?)'; slots.push(idx); }
    else src += reEscape(m[0]);
  }
  src += reEscape(text.slice(last));

  let hit: RegExpExecArray | null = null;
  try { hit = new RegExp(`^${src}$`).exec(normalizeAck(filled)); } catch { return null; }
  if (!hit) return null;

  const out: string[] = Array.from({ length: slotCount }, () => '');
  const seen = new Set<number>();
  for (let i = 0; i < slots.length; i++) {
    const at = slots[i];
    const v = String(hit[i + 1] ?? '');
    // The same blank filled twice must have been filled with the same thing.
    if (seen.has(at) && out[at] !== v) return null;
    seen.add(at);
    out[at] = v;
  }
  return out;
}

export interface RealAckVerdict {
  /** Was the sentence really rendered for a member of this audience? */
  ok: boolean;
  /** The name it was rendered for, when it was. */
  matched: string;
  /** Why not, in the owner's words — '' when ok. */
  reason: string;
}

/**
 * IS THIS CONFIRMATION THE MESSAGE A REAL GUEST ON THIS LIST WOULD READ?
 *
 * Every blank is checked for what the mapping says goes in it: a venue blank
 * must carry the venue's real name, a phone blank a number on the list, and a
 * name blank the name of somebody really in this audience. A bracketed label,
 * a made-up name, or the sentence with the halves put back the "right" way
 * round all fail — which is the point: the only way to satisfy it is to have
 * rendered the real message for a real person.
 */
export function realAckVerdict(
  db: DB,
  templateName: string,
  paramOrder: readonly string[],
  def: AudienceDef,
  supplied: unknown,
): RealAckVerdict {
  const wording = ownerWording(db, templateName);
  const order = (Array.isArray(paramOrder) ? paramOrder : []).map(v => String(v ?? '').trim());
  const values = parseFilledWording(wording, supplied, order.length);
  if (!values) {
    return { ok: false, matched: '', reason: 'That is not this template\'s wording.' };
  }
  const venue = normalizeAck(broadcastVenue(db) || 'your venue').toLowerCase();
  const who = audienceIdentities(db, def);
  let matched = '';
  for (let i = 0; i < order.length; i++) {
    const v = normalizeAck(values[i]);
    if (order[i] === 'venue') {
      if (v.toLowerCase() !== venue) {
        return { ok: false, matched: '', reason: `Blank ${i + 1} does not carry your venue name.` };
      }
    } else if (order[i] === 'name') {
      if (!v || !who.names.has(v.toLowerCase())) {
        return {
          ok: false,
          matched: '',
          reason: `Blank ${i + 1} does not carry the name of a guest on this list — ${v ? `“${v.slice(0, 60)}” is not one of them` : 'it is empty'}.`,
        };
      }
      matched = matched || v;
    } else if (order[i] === 'phone') {
      if (!v || !who.phones.has(v)) {
        return { ok: false, matched: '', reason: `Blank ${i + 1} does not carry a number on this list.` };
      }
    }
  }
  return { ok: true, matched, reason: '' };
}

/* ═════ WHAT IS SAVED AS "THE MESSAGE" (F2, second half) ═════ */

export interface PreviewBodyChoice {
  /** What to store in wa_campaigns.preview_body. */
  body: string;
  /** 'template' — taken from the wording this app holds; 'supplied' — the
   *  caller's text, kept because nothing here holds a wording and its blanks
   *  line up; 'discarded' — the caller's text disagreed and was dropped. */
  source: 'template' | 'supplied' | 'discarded' | 'none';
  /** Said out loud in the create reply when the caller's text was not kept. */
  note: string;
}

/**
 * PREVIEW_BODY IS A RECORD, NOT AN OPINION.
 *
 * It was stored verbatim from the request. That is the same fault as the thread
 * echo that recorded the opposite of what it sent: this column is what the
 * start dialog shows the owner as "the message", and what the echo falls back
 * to when nothing else holds the wording. A caller could therefore post an
 * honest-looking sentence and have the venue's own screens repeat it while the
 * wire carried something else — the swap, wearing a clean preview.
 *
 * So it is DERIVED wherever this app holds a wording (Meta's own components
 * first, then the saved copy), and the caller's text is simply not consulted.
 * Where nothing is held — a hand-typed name on an install that has never synced
 * — the caller's text is the only wording in existence, so it is kept, but only
 * if its blanks line up with the mapping; a wording of a different shape would
 * render a different sentence than the one that goes out, which is the very
 * thing this is closing.
 *
 * NEVER A REFUSAL. A bad preview body costs nothing to drop, and refusing a
 * campaign over a cosmetic field would be a gate people learn to route around.
 */
export function campaignPreviewBody(
  db: DB,
  templateName: string,
  supplied: unknown,
  slotCount: number,
): PreviewBodyChoice {
  const held = ownerWording(db, templateName).trim();
  const typed = String(supplied ?? '').slice(0, 2000);
  if (held) {
    return {
      body: held.slice(0, 2000),
      source: 'template',
      note: normalizeAck(typed) && normalizeAck(typed) !== normalizeAck(held)
        ? 'The message saved with this campaign is the approved wording this app holds for the template, not the text supplied with the request — what WhatsApp delivers is decided by the template, and the record has to say the same thing.'
        : '',
    };
  }
  if (!typed.trim()) return { body: '', source: 'none', note: '' };
  const census = bodyBlanks(typed);
  if (census.count === Math.max(0, Math.floor(slotCount) || 0)) {
    return { body: typed, source: 'supplied', note: '' };
  }
  return {
    body: '',
    source: 'discarded',
    note: `The message text supplied with this campaign has ${census.count} blank(s) but ${slotCount} variable(s) are mapped, so it is not the sentence this campaign would send. It has not been saved — the approved template at WhatsApp decides the wording.`,
  };
}

/**
 * WHAT THE SENTENCE ITSELF SUGGESTS BELONGS IN A BLANK — advisory only.
 *
 * Where a blank is numbered, no record names it and there is nothing to refuse
 * on. But the words immediately before it still say something an owner would
 * say out loud: a blank right after "Hi" or "Happy birthday" is a person, and
 * one right after "at" or "welcome to" is a place. Reported ONLY where the cue
 * disagrees with the mapping, and NEVER as a refusal — the vocabulary is tiny
 * and unverifiable against templates nobody has written yet, so its whole job
 * is to put a sentence in front of the owner, which costs nothing when wrong.
 */
const CUE_PERSON = /(?:\b(?:hi|hello|hey|dear|namaste|greetings)|\bbirthday|\bcongratulations)[\s,!:;.-]*$/i;
const CUE_PLACE = /(?:\bat|\bwelcome to|\bvisit to|\bback to|\bhere at|\bfrom)[\s,!:;.-]*$/i;

export function wordingCues(db: DB, templateName: string, paramOrder: readonly string[]): string[] {
  const wording = ownerWording(db, templateName);
  if (!wording.trim()) return [];
  const order = (Array.isArray(paramOrder) ? paramOrder : []).map(v => String(v ?? '').trim());
  const census = bodyBlanks(wording);
  const aligned = alignedNames(census);
  const out: string[] = [];
  let seen = 0;
  for (const m of wording.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    const inner = String(m[1] ?? '').trim();
    if (!inner) continue;
    const idx = /^\d+$/.test(inner)
      ? Number(inner) - 1
      : aligned.findIndex((nm, i) => i >= census.positional && nm.toLowerCase() === inner.toLowerCase());
    seen++;
    if (idx < 0 || idx >= order.length) continue;
    const before = wording.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0);
    const mapped = order[idx];
    if (CUE_PERSON.test(before) && mapped !== 'name') {
      out.push(`Blank ${idx + 1} comes straight after “${before.trim().split(/\s+/).slice(-2).join(' ')}”, which usually introduces a person — but this campaign puts ${BROADCAST_VAR_LABEL[mapped as BroadcastVar] || mapped} there.`);
    } else if (CUE_PLACE.test(before) && mapped !== 'venue') {
      out.push(`Blank ${idx + 1} comes straight after “${before.trim().split(/\s+/).slice(-2).join(' ')}”, which usually introduces a place — but this campaign puts ${BROADCAST_VAR_LABEL[mapped as BroadcastVar] || mapped} there.`);
    }
    if (seen > 20) break;
  }
  return out;
}

/* ═══════════ The acknowledgement: what cannot be proved must be READ ═══════ */

/** Where one campaign's acknowledged sentence is kept (streakFloor's pattern). */
const ACK_PREFIX = 'broadcast_read_real_';

export function campaignAck(db: DB, campaignId: string): string {
  try { return String(ctSetting(db, ACK_PREFIX + campaignId) || ''); } catch { return ''; }
}

export function setCampaignAck(db: DB, campaignId: string, sentence: string): void {
  try { setCtSetting(db, ACK_PREFIX + campaignId, normalizeAck(sentence).slice(0, 2000)); }
  catch { /* settings unavailable — the gate then refuses, which is the safe end */ }
}

/* ═════ THE MAPPING THE CONFIRMATION WAS MADE ABOUT ═════
 *
 * A SEPARATE KEY, WRITTEN ONLY BY CREATE, AND THAT IS THE WHOLE POINT.
 *
 * The confirmation used to be a sentence and nothing else, and the start door
 * would replace it with whatever a caller handed in. MEASURED end to end: create
 * a campaign honestly (real-guest sentence read back, HTTP 201, 27 queued),
 * PATCH its param_order to the swap (that route has no mapping gate), start it —
 * refused, but the refusal replies with `proof_sentence`, the LABEL form of the
 * new mapping. Echo that one field into a second start: HTTP 200, and the drain
 * put ["Akan","Rohan Mehta"] on the wire for 20 guests. The create gate cannot
 * see any of it; it all happens after the campaign exists.
 *
 * So the mapping is recorded WITH the reading, under a key create alone writes.
 * Change the mapping afterwards and no sentence can answer for it: the campaign
 * has to be built again, which is where the real-guest reading lives.
 *
 * Absent (a campaign created before this existed) → nothing is asserted and the
 * old sentence comparison stands on its own, exactly as it did.
 */
const ACK_ORDER_PREFIX = 'broadcast_read_order_';

export function setCampaignAckOrder(db: DB, campaignId: string, paramOrder: readonly string[]): void {
  try {
    setCtSetting(db, ACK_ORDER_PREFIX + campaignId,
      JSON.stringify((Array.isArray(paramOrder) ? paramOrder : []).map(v => String(v ?? '').trim())));
  } catch { /* settings unavailable — the check below then asserts nothing */ }
}

/** The mapping recorded with the confirmation; null when none was recorded. */
export function campaignAckOrder(db: DB, campaignId: string): string[] | null {
  let raw = '';
  try { raw = String(ctSetting(db, ACK_ORDER_PREFIX + campaignId) || ''); } catch { return null; }
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map((x: unknown) => String(x ?? '').trim()) : null;
  } catch { return null; }
}

export interface AckCheck {
  /** Does this mapping have to be confirmed against its real sentence? */
  required: boolean;
  /** Was it? (True whenever `required` is false.) */
  ok: boolean;
  /** 1-based blanks nothing can vouch for. */
  positions: number[];
  /** The exact sentence that must be confirmed. */
  sentence: string;
  /**
   * The sentence written with LABELS where the guest's details go — what start,
   * resume and every drain pass re-derive and compare the STORED confirmation
   * against. Kept separate from `sentence` because the sentence a person is
   * asked to read names a real guest (F4) and that guest is not a durable fact
   * about the campaign: they can opt out, or fall into a cooldown, between the
   * confirmation and the first message.
   */
  canonical: string;
  /** The real guest `sentence` was written about, when it was written about one. */
  recipient: { name: string; phone_e164: string } | null;
  /** Advisory notes from the wording itself — never a refusal on their own. */
  cues: string[];
  /** A weaker record actively disagrees with the mapping. */
  soft: ContradictedBlank[];
  /**
   * The confirmation that satisfied this check was the REAL one: a sentence
   * naming a guest genuinely on this campaign's list, checked blank by blank
   * against that list. False for the label form, and false when nothing was
   * required. Only a `real` reading is worth remembering (rememberReadMapping).
   */
  real: boolean;
  /**
   * A READING THIS VENUE MADE EARLIER is what answered for this mapping — so no
   * reading was asked for here (the F6 overlay), and the campaign was allowed on
   * the strength of somebody's word rather than on any record Meta or the author
   * wrote.
   *
   * Reported so the create route can SAY so. A suppression nobody can see is how
   * a gate quietly stops existing: the owner should be able to read "not asked,
   * because X confirmed this wording on DATE" in the campaign's own warnings and
   * go and look if that surprises him. null whenever the memory played no part.
   */
  provenByReading: { at: string; by: string } | null;
  reason: string;
}

/**
 * THE F2 GATE. A blank nothing names cannot be proved swapped and MUST NOT be
 * refused — a template may legitimately put the same constant in every copy.
 * What it gets instead is the message a real guest would read, in front of the
 * sender, confirmed word for word before a rupee is committed.
 *
 * ENFORCED ON THE SERVER, not on the screen. src/proxy.ts guards PAGES, never
 * API routes, so a tick that lives only in the browser is not a gate at all:
 * the same campaign could be created, started and delivered by one curl. The
 * confirmation is the SENTENCE itself rather than a boolean for exactly that
 * reason — a caller that never rendered the message cannot produce it.
 *
 * AND THE REFUSAL MUST NOT CONTAIN THE ANSWER. It used to quote the finished
 * sentence, and the create route put the same string in the reply as
 * `proof_sentence`, so the claim above was measurably false: call once, copy one
 * field, call again — a caller that read no template row, resolved no audience
 * and rendered nothing sent a swapped campaign in two requests. The refusal now
 * names the GUEST (so the sentence can be built, but only by building it) and
 * never writes the sentence out. `sentence` remains on the returned object for
 * in-process use — the screen renders it from the wording and the named guest —
 * and MUST NOT be echoed to a caller that has not produced it.
 */
export function mappingAckCheck(
  db: DB,
  templateName: string,
  paramOrder: readonly string[],
  supplied: unknown,
  /**
   * THE AUDIENCE THIS CAMPAIGN IS BEING BUILT FOR (F4). Given it, the sentence
   * that must be read carries a REAL guest's name and is accepted only when it
   * really was rendered for somebody on this list — so the confirmation cannot
   * be produced by a caller that never resolved the audience, and cannot be a
   * bracketed label the eye slides over.
   *
   * Omitted by the re-checks that happen after the campaign exists (start,
   * resume, every drain pass): those compare against the STORED confirmation,
   * which is the label form, because the guest who was named at create is not
   * guaranteed to still be eligible minutes later.
   */
  opts: {
    audience?: AudienceDef | null;
    /**
     * COUNT WHAT THIS VENUE HAS ALREADY READ (F6). Passed by the CREATE gate
     * only. The re-checks that run after a campaign exists (start, resume, every
     * drain pass) leave it off deliberately: their job is to compare the
     * campaign as it is NOW against the confirmation stored ON it, and a learned
     * record would answer a different campaign's question.
     */
    learned?: boolean;
  } = {},
): AckCheck {
  const name = String(templateName || '').trim();
  const v = mappingVerdict(db, name, paramOrder, { learned: !!opts.learned });
  const canonical = proofSentence(db, name, paramOrder);
  const cues = v.needsAck ? wordingCues(db, name, paramOrder) : [];
  // The real guest, and the message they would really read. Only asked for when
  // a confirmation is actually required — resolving an audience to decorate a
  // reply nobody reads is work for nothing.
  const recipient = v.needsAck && opts.audience ? audienceProofRecipient(db, opts.audience) : null;
  const real = recipient ? realProofSentence(db, name, paramOrder, recipient) : '';
  const sentence = real || canonical;
  /* DID AN EARLIER READING ANSWER THIS, RATHER THAN A RECORD? The overlay marks
   * exactly those blanks `owner_confirmed`, so the answer is in the meanings; the
   * date and the reader come from the record itself. Read only where the overlay
   * was consulted at all. */
  const provenByReading = opts.learned && v.meanings.some(m => m.evidence === 'owner_confirmed')
    ? (() => {
      const r = confirmedReading(db, name, ownerWording(db, name));
      return r ? { at: r.at, by: r.by } : null;
    })()
    : null;
  const none: AckCheck = {
    required: false, ok: true, positions: v.unproven, sentence, canonical, recipient, cues, soft: v.soft, real: false, provenByReading, reason: '',
  };
  if (!v.needsAck) return none;

  /* NOTHING HERE HOLDS THE WORDING — and that used to WAIVE the gate.
   *
   * `if (!sentence) return none;` with a comment saying the count gate above
   * already refuses a template this app holds no wording for. MEASURED: it does
   * not. For a template name with no local row, paramCheckFor() returns ok:true
   * (the lifecycle knows nothing, and there is no saved wording to count
   * against), mappingVerdict says every blank is unproven and needsAck is true —
   * and this line then returned required:false. One POST with a name that only
   * exists at Meta created, started and delivered a swapped campaign with no
   * gate firing at all: the C1 hole with an open side door.
   *
   * It is not fixable by checking harder. If this app holds no copy of the
   * wording there is no sentence to put in front of anybody, so the one honest
   * outcome is to refuse and say why. It fails CLOSED — nothing is created,
   * nothing is charged — and the way out is to sync the template (or author it
   * here), which is the thing that would have to happen for any of this to be
   * checkable at all.
   */
  if (!sentence) {
    return {
      required: true, ok: false, positions: v.unproven, sentence: '', canonical: '', recipient, cues, soft: v.soft, real: false, provenByReading,
      reason: `This app holds no copy of the wording for “${name}”, so the message these ${v.unproven.length || paramOrder.length} blank(s) would produce cannot be shown to you and cannot be checked. WhatsApp fills blanks strictly in order and accepts whatever arrives, so a campaign built on a wording nobody here has seen would be charged for in full whatever it said. Refresh the WhatsApp templates (or author this template here) so its approved wording is on record, then build the campaign again. Nothing has been created and nothing has been sent.`,
    };
  }

  /* THE REAL-GUEST CONFIRMATION. Not "does this string equal that string": the
   * sentence is taken apart and every blank is checked for what the mapping
   * claims goes in it, so any real member of this audience satisfies it and a
   * label, an invented name or the sentence written the other way round does
   * not. Tolerating any member of the list is deliberate — the audience can
   * shift between the preview and the create, and refusing a reading that was
   * perfectly correct is exactly the false positive that gets a gate clicked
   * through. */
  if (real && opts.audience) {
    const verdict = realAckVerdict(db, name, paramOrder, opts.audience, supplied);
    if (verdict.ok) {
      return { required: true, ok: true, positions: v.unproven, sentence, canonical, recipient, cues, soft: v.soft, real: true, provenByReading, reason: '' };
    }
  } else if (normalizeAck(supplied) === normalizeAck(sentence)) {
    return { required: true, ok: true, positions: v.unproven, sentence, canonical, recipient, cues, soft: v.soft, real: false, provenByReading, reason: '' };
  }

  /* WHY THIS BLANK CANNOT BE VOUCHED FOR — and the two reasons are not the same
   * sentence. A NUMBERED blank has no name anywhere. A blank that IS named here,
   * on a template whose wording Meta has since replaced with a different
   * sentence, has a name that describes the old copy and says nothing about
   * which blank is which now. Telling an owner "blank 1 is not named by its own
   * wording" when his own screen shows it named {{name}} reads as a bug in the
   * app, and an owner who thinks the gate is broken is an owner who clicks past
   * it. */
  /* A THIRD REASON A NAMED BLANK CAN BE UNVOUCHED FOR: this app holds two of its
   * own records of this template and they name the blank differently. That is
   * not Meta drift — Meta may have said nothing at all — so it must not be
   * described as Meta drift. An owner told "the wording WhatsApp returned is not
   * the wording saved here" about a template WhatsApp has never answered on is
   * being told something false, and an owner who thinks the gate is confused is
   * an owner who clicks past it. */
  const conflicted = v.unproven.filter(p => !!v.meanings[p - 1]?.contradicted);
  const stale = v.unproven.filter(p => !!(v.meanings[p - 1]?.name || '').trim() && !v.meanings[p - 1]?.contradicted);
  const nameless = v.unproven.filter(p => !(v.meanings[p - 1]?.name || '').trim());
  const list = (ps: number[]) => (ps.length === 1 ? `Blank ${ps[0]}` : `Blanks ${ps.join(', ')}`);
  const which = v.unproven.length
    ? [
      nameless.length
        ? `${list(nameless)} of “${name}” ${nameless.length === 1 ? 'is' : 'are'} not named by ${nameless.length === 1 ? 'its' : 'their'} own wording, so nothing here can tell whether the right ${nameless.length === 1 ? 'thing is' : 'things are'} going into ${nameless.length === 1 ? 'it' : 'them'}.`
        : '',
      conflicted.length
        ? `This app holds two records of “${name}” that name ${conflicted.length === 1 ? `blank ${conflicted[0]}` : `blanks ${conflicted.join(', ')}`} differently — the wording saved here and the saved variable list disagree — so neither can say which blank is which until somebody reads the message itself.`
        : '',
      stale.length
        ? `The wording WhatsApp returned for “${name}” is not the wording saved here, so the saved names for ${stale.length === 1 ? `blank ${stale[0]}` : `blanks ${stale.join(', ')}`} describe a sentence Meta no longer sends and cannot say which blank is now which.`
        : '',
    ].filter(Boolean).join(' ')
    : `The variables saved for “${name}” do not match the way this campaign fills its blanks.`;
  const disagree = v.soft.length
    ? ` ${v.soft.map(b => `This app's own record of this template calls blank ${b.position} “${b.name}”, which asks for ${BROADCAST_VAR_LABEL[b.asks]}, while this campaign puts ${BROADCAST_VAR_LABEL[b.mapped]} there.`).join(' ')}`
    : '';
  const cue = cues.length ? ` ${cues.join(' ')}` : '';

  // WHOSE MESSAGE IT IS. A real name in the sentence is the whole point of the
  // reading, so the refusal says who it belongs to — an owner who is told to
  // read "Welcome to Lakshmi Devi — Akan" and that Lakshmi Devi is on this list
  // has been handed the mistake, not a description of one.
  const whose = recipient
    ? ` ${recipient.name || 'A guest with no name on record'}${recipient.phone_e164 ? ` (${recipient.phone_e164})` : ''} is on this list.`
    : '';

  /* HOW IT CAN BE WRONG, IN THE OWNER'S WORDS.
   *
   * Two different variables can additionally be the wrong way ROUND. One
   * variable repeated cannot — but it can still be the WRONG variable, which is
   * the class that used to be waved through entirely: ['venue','venue'] on "Hi
   * {{1}}, thank you for visiting {{2}}" sends "Hi Akan, thank you for visiting
   * Akan" to 27 guests, at full price, and nothing fails. */
  const how = v.swappable
    ? 'This campaign puts two different things in its blanks, so they can be the wrong way round and nothing would fail'
    : 'Nothing here says what belongs in those blanks, so the wrong thing can go into every one of them and nothing would fail';

  return {
    required: true,
    ok: false,
    positions: v.unproven,
    sentence,
    canonical,
    recipient,
    cues,
    soft: v.soft,
    real: false,
    provenByReading,
    /* THE SENTENCE IS NOT WRITTEN OUT HERE. Quoting it made the refusal its own
     * answer: the create route returned this same string and one copied field
     * satisfied the retry. The guest is named instead — enough to build the
     * message, and only by building it. */
    reason: `${which} ${how}: WhatsApp fills blanks strictly in order, accepts every message, and the whole list is charged for and left unable to receive another offer until the cooldown ends.${disagree}${cue} Read the message this campaign would really send${recipient?.name ? ` to ${recipient.name}` : ''} — every word of it, as it would arrive — and confirm it back before starting.${whose} Nothing has been created and nothing has been sent.`,
  };
}

const KEY10_SQL = (col: string) =>
  `substr(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(${col},''),' ',''),'-',''),'+',''),'(',''),')',''),'.',''),'/',''), -10)`;

// ─── Settings ──────────────────────────────────────────────────────────────

export interface BroadcastSettings {
  enabled: boolean;
  msgs_per_min: number;
  cooldown_days: number;
  /** <= 0 → no daily cap. */
  daily_cap: number;
  /** ₹ per message — the configurable Meta marketing-conversation rate. */
  cost_per_msg: number;
  /**
   * Starting a campaign with MORE than this many eligible recipients makes the
   * UI demand a TYPED confirmation (not just a click). 0 → always typed.
   * UI-side friction only — the server gate is always confirm + expect_count.
   */
  confirm_threshold: number;
}

export const BROADCAST_SETTING_KEYS = {
  enabled: BROADCAST_FLAG,
  msgs_per_min: 'broadcast_msgs_per_min',
  cooldown_days: 'broadcast_cooldown_days',
  daily_cap: 'broadcast_daily_cap',
  cost_per_msg: 'broadcast_cost_per_msg',
  confirm_threshold: 'broadcast_confirm_threshold',
} as const;

/** Effective knobs. Read fresh every call (house norm — no caching). */
export function broadcastSettings(db: DB): BroadcastSettings {
  const num = (key: string, dflt: number, min: number, max: number) => {
    // ctSetting returns '' for an ABSENT key (it never throws for one), and
    // Number('') === 0 — so an unset knob must fall to its documented default,
    // not to a silent 0 (which for cooldown/daily-cap would mean "no limit").
    let raw = '';
    try { raw = ctSetting(db, key); } catch { raw = ''; }
    if (String(raw).trim() === '') return dflt;
    const v = Number(raw);
    if (!Number.isFinite(v)) return dflt;
    return Math.min(Math.max(v, min), max);
  };
  let enabled = false;
  try { enabled = ctSetting(db, BROADCAST_FLAG) === '1'; } catch { enabled = false; }
  return {
    enabled,
    msgs_per_min: Math.round(num(BROADCAST_SETTING_KEYS.msgs_per_min, 20, 1, 240)),
    cooldown_days: Math.round(num(BROADCAST_SETTING_KEYS.cooldown_days, 7, 0, 365)),
    daily_cap: Math.round(num(BROADCAST_SETTING_KEYS.daily_cap, 500, -1, 100000)),
    cost_per_msg: num(BROADCAST_SETTING_KEYS.cost_per_msg, 0.8, 0, 100),
    confirm_threshold: Math.round(num(BROADCAST_SETTING_KEYS.confirm_threshold, 50, 0, 100000)),
  };
}

export function setBroadcastSetting(db: DB, key: string, value: string): void {
  setCtSetting(db, key, value);
}

// ─── Audience ──────────────────────────────────────────────────────────────

/** Loyalty tiers (mirrors tierForPoints in src/lib/crm-guests.ts). */
export const BROADCAST_TIERS = ['Bronze', 'Silver', 'Gold'] as const;
export type BroadcastTier = (typeof BROADCAST_TIERS)[number];

export type AudienceDef =
  | { kind: 'all_guests' }
  | { kind: 'winback'; days: number; include_never?: boolean }
  | { kind: 'min_visits'; visits: number }
  | { kind: 'birthday_month'; month: number }   // 1–12 (calendar month of dob/birthday)
  | { kind: 'tier'; tier: BroadcastTier }       // loyalty tier (crm_guests points)
  | { kind: 'phones'; phones: string[] };

export function parseAudience(raw: unknown): AudienceDef | null {
  let v: any = raw;
  if (typeof raw === 'string') {
    try { v = JSON.parse(raw); } catch { return null; }
  }
  if (!v || typeof v !== 'object') return null;
  switch (v.kind) {
    case 'all_guests': return { kind: 'all_guests' };
    case 'winback': return { kind: 'winback', days: coerceBucket(v.days), include_never: v.include_never === true };
    case 'min_visits': {
      const n = Math.floor(Number(v.visits));
      if (!Number.isFinite(n) || n < 1) return null;
      return { kind: 'min_visits', visits: Math.min(n, 1000) };
    }
    case 'birthday_month': {
      const m = Math.floor(Number(v.month));
      if (!Number.isFinite(m) || m < 1 || m > 12) return null;
      return { kind: 'birthday_month', month: m };
    }
    case 'tier': {
      const t = String(v.tier || '').trim();
      const match = BROADCAST_TIERS.find(x => x.toLowerCase() === t.toLowerCase());
      if (!match) return null;
      return { kind: 'tier', tier: match };
    }
    case 'phones': {
      if (!Array.isArray(v.phones)) return null;
      const phones = v.phones.map((p: unknown) => String(p).trim()).filter(Boolean).slice(0, BROADCAST_TARGET_MAX * 2);
      if (!phones.length) return null;
      return { kind: 'phones', phones };
    }
    default: return null;
  }
}

export interface AudienceGuest {
  guest_id: string | null;   // ct_guests.id, or null (synthetic / raw phone)
  phone_e164: string;        // the number to dial
  phone_key: string;         // norm10
  name: string;
}

export interface AudienceResolution {
  guests: AudienceGuest[];
  total_candidates: number;
  no_phone: number;
  deduped: number;
}

/** Winback's send-to-the-number-we-stored rule (never re-country-code a full E.164). */
function dialableFor(stored: string, key: string): string {
  const s = String(stored || '').trim();
  return /^\+?\d{11,15}$/.test(s.replace(/[\s-]/g, '')) ? '+' + normalizeWaNumber(s).replace(/^\+/, '') : normalizePhone(key);
}

/**
 * Calendar month (1–12) out of a stored birthday string, or 0 when unreadable.
 * ct_guests.dob is ISO 'YYYY-MM-DD'; crm_guests.birthday is free text — accept
 * ISO, vCard '--MM-DD', and 'DD-MM' / 'DD/MM' (day first, the Indian habit).
 */
export function birthdayMonthOf(raw: unknown): number {
  const s = String(raw ?? '').trim();
  if (!s) return 0;
  let m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/.exec(s);          // YYYY-MM[-DD]
  if (m) { const n = Number(m[2]); return n >= 1 && n <= 12 ? n : 0; }
  m = /^--(\d{1,2})-(\d{1,2})$/.exec(s);                        // --MM-DD (vCard)
  if (m) { const n = Number(m[1]); return n >= 1 && n <= 12 ? n : 0; }
  m = /^(\d{1,2})[/-](\d{1,2})(?:[/-]\d{2,4})?$/.exec(s);       // DD-MM[-YYYY]
  if (m) { const n = Number(m[2]); return n >= 1 && n <= 12 ? n : 0; }
  return 0;
}

/** phone_key → birthday month (1–12), from ct_guests.dob + crm_guests.birthday. */
function birthdayMonthMap(db: DB): Map<string, number> {
  const map = new Map<string, number>();
  const fold = (rows: any[]) => {
    for (const r of rows) {
      const k = norm10(r.p);
      const mo = birthdayMonthOf(r.d);
      if (k && mo && !map.has(k)) map.set(k, mo);
    }
  };
  try { fold(db.prepare(`SELECT phone_e164 AS p, dob AS d FROM ct_guests WHERE COALESCE(dob,'') <> ''`).all() as any[]); } catch { /* table missing */ }
  try { fold(db.prepare(`SELECT mobile AS p, birthday AS d FROM crm_guests WHERE is_active = 1 AND COALESCE(birthday,'') <> ''`).all() as any[]); } catch { /* table missing */ }
  return map;
}

/**
 * Resolve an audience definition to a deduped, dialable guest list.
 * NO consent/cooldown filtering here — that is the SEND-TIME gate's job; this
 * is "who was asked for", so the report can say who was excluded and why.
 */
export function resolveAudience(db: DB, def: AudienceDef): AudienceResolution {
  const out: AudienceGuest[] = [];
  const seen = new Set<string>();
  let total = 0, noPhone = 0, deduped = 0;

  const push = (guestId: string | null, phone: string, key: string, name: string) => {
    if (!key) { noPhone++; return; }
    if (seen.has(key)) { deduped++; return; }
    seen.add(key);
    out.push({ guest_id: guestId, phone_e164: phone, phone_key: key, name: String(name || '').trim().slice(0, 120) });
  };

  if (def.kind === 'winback') {
    const seg = winbackSegment(db, { days: def.days, includeNever: !!def.include_never, limit: BROADCAST_TARGET_MAX });
    total = seg.guests.length;
    for (const g of seg.guests) {
      const key = g.key10 || norm10(g.phone_e164);
      push(g.synthetic ? null : g.guest_id, dialableFor(g.phone_e164, key), key, g.name);
    }
  } else if (def.kind === 'phones') {
    total = def.phones.length;
    const keys = def.phones.map(p => norm10(p));
    const dir = guestDirectoryFor(db, keys.filter(Boolean));
    def.phones.forEach((p, i) => {
      const key = keys[i];
      if (!key) { noPhone++; return; }
      const ref = dir.get(key);
      const guestId = ref && !ref.guest_handle.startsWith('phone:') ? ref.guest_handle : null;
      push(guestId, dialableFor(p, key), key, ref?.guest_name || '');
    });
  } else {
    // all_guests / min_visits / birthday_month / tier — the guest-unify
    // universe (ct_guests + synthetic loyalty/dining guests), the same walk
    // winbackSegment does without a band filter. min_visits uses max(loyalty,
    // dining) visit counts (bookings are a winback-internal aggregate; close
    // enough for an audience selector, and the preview shows the resulting
    // names to a human before any send). birthday_month reads ct_guests.dob +
    // crm_guests.birthday; tier reads the loyalty points ladder.
    const loyalty = buildLoyaltyMap(db);
    const dining = buildDiningMap(db, null);
    const birthdays = def.kind === 'birthday_month' ? birthdayMonthMap(db) : null;
    let ctRows: any[] = [];
    try { ctRows = db.prepare(`SELECT id, phone_e164, name FROM ct_guests`).all() as any[]; } catch { ctRows = []; }
    const ctKeys = new Set<string>();
    for (const r of ctRows) { const k = norm10(r.phone_e164); if (k) ctKeys.add(k); }
    const universe: Array<{ id: string | null; phone: string; key: string; name: string }> = ctRows.map(r => ({
      id: String(r.id), phone: String(r.phone_e164 || ''), key: norm10(r.phone_e164), name: String(r.name || ''),
    }));
    for (const s of syntheticGuests(ctKeys, loyalty, dining)) {
      universe.push({ id: null, phone: s.phone_e164, key: norm10(s.phone_e164), name: s.name });
    }
    total = universe.length;
    for (const u of universe) {
      if (def.kind === 'min_visits') {
        const visits = Math.max(loyalty.get(u.key)?.visit_count || 0, dining.get(u.key)?.visits || 0);
        if (visits < def.visits) { total--; continue; }
      } else if (def.kind === 'birthday_month') {
        if ((birthdays!.get(u.key) || 0) !== def.month) { total--; continue; }
      } else if (def.kind === 'tier') {
        if ((loyalty.get(u.key)?.tier || '') !== def.tier) { total--; continue; }
      }
      push(u.id, dialableFor(u.phone, u.key), u.key, u.name);
    }
  }

  if (out.length > BROADCAST_TARGET_MAX) out.length = BROADCAST_TARGET_MAX;
  return { guests: out, total_candidates: total, no_phone: noPhone, deduped };
}

// ─── Cooldown ──────────────────────────────────────────────────────────────

/**
 * The most recent marketing send to this phone on EITHER rail (broadcasts +
 * win-back) at/after `cutoff` (UTC 'YYYY-MM-DD HH:MM:SS'). Returns a display
 * string ('' when none) — truthiness is the cooldown verdict.
 */
export function lastMarketingSendSince(db: DB, phoneKey: string, cutoff: string): string {
  if (!phoneKey) return '';
  try {
    const r = db.prepare(`
      SELECT sent_at, campaign_id FROM wa_campaign_recipients
      WHERE phone_key = ? AND sent_at IS NOT NULL AND sent_at >= ?
      ORDER BY sent_at DESC LIMIT 1
    `).get(phoneKey, cutoff) as any;
    if (r) return `${r.sent_at} (broadcast ${r.campaign_id})`;
  } catch { /* table missing */ }
  try {
    const r = db.prepare(`
      SELECT sent_at, campaign_id FROM ct_campaign_targets
      WHERE ${KEY10_SQL('phone_e164')} = ? AND send_status = 'sent' AND sent_at IS NOT NULL
        AND REPLACE(sent_at, 'T', ' ') >= ?
      ORDER BY sent_at DESC LIMIT 1
    `).get(phoneKey, cutoff) as any;
    if (r) return `${String(r.sent_at).replace('T', ' ').slice(0, 19)} (win-back ${r.campaign_id})`;
  } catch { /* table missing */ }
  return '';
}

// ─── Campaign CRUD ─────────────────────────────────────────────────────────

export type CampaignState = 'draft' | 'scheduled' | 'sending' | 'paused' | 'done' | 'cancelled';

export interface BroadcastCampaign {
  id: string;
  name: string;
  template_name: string;
  language: string;
  param_order: string;    // JSON
  preview_body: string;
  audience: string;       // JSON
  state: CampaignState;
  throttle_per_min: number;
  cost_rate: number;
  cost_estimate: number;
  scheduled_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export function getCampaign(db: DB, id: string): BroadcastCampaign | undefined {
  return db.prepare(`SELECT * FROM wa_campaigns WHERE id = ?`).get(id) as BroadcastCampaign | undefined;
}

/** Exactly what the campaign stored, unfiltered. */
export function paramOrderRawOf(c: Pick<BroadcastCampaign, 'param_order'>): string[] {
  try {
    const v = JSON.parse(String(c.param_order || '[]'));
    return Array.isArray(v) ? v.map(x => String(x)) : [];
  } catch { return []; }
}

/** The mappable slots — what actually becomes {{1}},{{2}},… at send time.
 *
 *  NOTE the filter is LOSSY, and silently so: a stored variable this rail
 *  cannot fill DISAPPEARS, shortening the parameter list and shifting every
 *  slot after it. That is why paramMappingCheck() compares THIS list (not the
 *  raw one) against the template's placeholder count before anything is sent —
 *  see paramOrderRawOf for what was dropped. */
export function paramOrderOf(c: Pick<BroadcastCampaign, 'param_order'>): string[] {
  return paramOrderRawOf(c).filter(k => (BROADCAST_VARS as readonly string[]).includes(k));
}

/** Variables the campaign stored that this rail cannot fill (see above). */
export function droppedParamsOf(c: Pick<BroadcastCampaign, 'param_order'>): string[] {
  return paramOrderRawOf(c).filter(k => !(BROADCAST_VARS as readonly string[]).includes(k));
}

export interface CreateBroadcastInput {
  name: string;
  templateName: string;
  language?: string;
  paramOrder?: string[];
  previewBody?: string;
  audience: AudienceDef;
  throttlePerMin?: number;
  createdBy: string;
}

export interface CreateBroadcastResult {
  campaign: BroadcastCampaign;
  queued: number;
  no_phone: number;
  deduped: number;
}

/**
 * Create a DRAFT + queue its recipients. Writes only — never sends, and does
 * NOT filter by consent/cooldown: excluded guests must appear in the report
 * as skipped-with-reason, which requires their row to exist.
 */
export function createBroadcast(db: DB, input: CreateBroadcastInput): CreateBroadcastResult {
  const id = generateId();
  const res = resolveAudience(db, input.audience);
  const audienceMeta = {
    ...input.audience,
    resolved: { total_candidates: res.total_candidates, no_phone: res.no_phone, deduped: res.deduped, queued: res.guests.length },
  };

  const insertCampaign = db.prepare(`
    INSERT INTO wa_campaigns (id, name, template_name, language, param_order, preview_body, audience, state, throttle_per_min, created_by)
    VALUES (@id, @name, @template, @lang, @order, @preview, @audience, 'draft', @throttle, @by)
  `);
  const insertRecipient = db.prepare(`
    INSERT OR IGNORE INTO wa_campaign_recipients (id, campaign_id, guest_id, phone_e164, phone_key, name, state)
    VALUES (?, ?, ?, ?, ?, ?, 'queued')
  `);

  const tx = db.transaction(() => {
    insertCampaign.run({
      id,
      name: String(input.name || '').trim().slice(0, 200) || 'Broadcast',
      template: String(input.templateName || '').trim(),
      lang: String(input.language || 'en').trim() || 'en',
      order: JSON.stringify((input.paramOrder || []).map(String)),
      preview: String(input.previewBody || '').slice(0, 2000),
      audience: JSON.stringify(audienceMeta),
      throttle: Math.max(0, Math.min(Math.floor(Number(input.throttlePerMin) || 0), 240)),
      by: String(input.createdBy || '').slice(0, 200),
    });
    let queued = 0;
    for (const g of res.guests) {
      const r = insertRecipient.run(generateId(), id, g.guest_id, g.phone_e164, g.phone_key, g.name);
      if (r.changes > 0) queued++;
    }
    return queued;
  });
  const queued = tx();

  return {
    campaign: getCampaign(db, id)!,
    queued,
    no_phone: res.no_phone,
    deduped: res.deduped + (res.guests.length - queued),
  };
}

/**
 * THROW AWAY A DRAFT THAT QUEUED NOBODY.
 *
 * The create route answers 400 for an audience that resolves to no one — and
 * left the campaign row behind anyway, so a refused request half-succeeded and
 * an orphan draft appeared on the campaign screen with nothing in it. Harmless
 * today (a draft with no recipients cannot be started), but a create path that
 * reports failure while persisting its work is the exact shape the cost
 * confirmation must never take.
 *
 * Guarded on BOTH facts — still a draft, still empty — so it can never remove a
 * campaign that has recipients or has moved on.
 */
export function discardEmptyDraft(db: DB, id: string): boolean {
  try {
    return db.prepare(`
      DELETE FROM wa_campaigns
      WHERE id = ? AND state = 'draft'
        AND NOT EXISTS (SELECT 1 FROM wa_campaign_recipients WHERE campaign_id = ?)
    `).run(id, id).changes > 0;
  } catch { return false; }
}

// ─── Preview / cost ────────────────────────────────────────────────────────

export interface AudiencePreview {
  total_candidates: number;
  queued: number;             // rows a create would queue (deduped, dialable)
  eligible_now: number;       // of queued, would pass consent+cooldown TODAY
  excluded: { no_phone: number; deduped: number; opted_out: number; cooldown: number };
  sample: Array<{ name: string; phone_e164: string }>;
  cost: { rate: number; estimate: number };
  note: string;
}

/** Advisory numbers — consent + cooldown are RE-CHECKED at send time. */
export function previewAudience(db: DB, def: AudienceDef, nowMs?: number): AudiencePreview {
  const now = nowMs ?? Date.now();
  const s = broadcastSettings(db);
  const res = resolveAudience(db, def);
  const consent = consentMap(db, res.guests.map(g => g.phone_key));
  const cutoff = utcString(now - s.cooldown_days * 86_400_000);

  let optedOut = 0, cooldown = 0;
  const eligible: AudienceGuest[] = [];
  for (const g of res.guests) {
    if (consent.get(g.phone_key)?.status === 'opted_out') { optedOut++; continue; }
    if (s.cooldown_days > 0 && lastMarketingSendSince(db, g.phone_key, cutoff)) { cooldown++; continue; }
    eligible.push(g);
  }

  return {
    total_candidates: res.total_candidates,
    queued: res.guests.length,
    eligible_now: eligible.length,
    excluded: { no_phone: res.no_phone, deduped: res.deduped, opted_out: optedOut, cooldown },
    sample: eligible.slice(0, 10).map(g => ({ name: g.name, phone_e164: g.phone_e164 })),
    cost: { rate: s.cost_per_msg, estimate: Math.round(eligible.length * s.cost_per_msg * 100) / 100 },
    note: 'Advisory preview — consent, cooldown and the daily cap are re-checked server-side when each message is actually sent.',
  };
}

// ─── State transitions ─────────────────────────────────────────────────────

export type TransitionError =
  | 'not_found' | 'bad_state' | 'no_template' | 'nothing_queued' | 'template_not_approved'
  /** The campaign maps a different NUMBER of variables than its template has
   *  placeholders — a whole-queue failure, refused the same way. */
  | 'param_mismatch'
  /** The template's HEADER needs something this rail never sends (a media
   *  attachment, or a value for a {{n}} in the heading) — a whole-queue
   *  failure, refused the same way. See templateHeaderFill(). */
  | 'header_unfillable';

export interface TransitionResult {
  ok: boolean;
  error?: TransitionError;
  /** Human-readable specifics for errors that have them (the approval gate's
   *  reason names the template and its actual Meta status). */
  detail?: string;
  campaign?: BroadcastCampaign;
}

/** draft → sending. Captures the cost rate + estimate AT THIS MOMENT.
 *
 *  APPROVAL GATE. A campaign may only start from a template Meta has approved.
 *  This is the FIRST of two checks — the drain re-asks on every pass, because a
 *  template can be paused between starting and sending. */
/**
 * sending → paused WITH a machine reason. The honest state for an automatic
 * halt: the operator sees why, resume re-asks the gate, and a human pause
 * (which clears halt_reason) is never confused with this.
 */
function haltCampaign(db: DB, id: string, reason: string): void {
  db.prepare(`
    UPDATE wa_campaigns SET state = 'paused', halt_reason = ?, updated_at = datetime('now')
    WHERE id = ? AND state = 'sending'
  `).run(`Halted automatically: ${reason}`.slice(0, 500), id);
}

/* ═══ The blanks an UNMANAGED template needs — the fourth whole-queue gate ═══ */

/**
 * Every {{…}} a body marks, counted in both dialects.
 *
 * WHY BOTH. Meta numbers its placeholders — {{1}}, {{2}} — but this app's own
 * saved wordings are written with NAMES ({{name}}, {{venue}}), because the rails
 * that send them (win-back, the notification templates) map a stored
 * `param_order` onto those names positionally. Counting only {{n}} therefore
 * returns 0 for every template this venue actually owns, which reads as "this
 * message has no blanks" about a message with two of them.
 */
export interface BlankCensus {
  /** Highest positional index: 'Hi {{1}}, join {{3}}' → 3. */
  positional: number;
  /** Distinct named blanks, in first-appearance order. */
  named: string[];
  /** Both dialects appear in one body — each is still its own slot. */
  mixed: boolean;
  /** Total distinct blanks this wording marks. */
  count: number;
}

export function bodyBlanks(text: unknown): BlankCensus {
  const s = String(text ?? '');
  let positional = 0;
  const named: string[] = [];
  const seen = new Set<string>();
  for (const m of s.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    const inner = String(m[1] ?? '').trim();
    if (!inner) continue;
    if (/^\d+$/.test(inner)) {
      positional = Math.max(positional, Number(inner));
    } else if (!seen.has(inner.toLowerCase())) {
      seen.add(inner.toLowerCase());
      named.push(inner);
    }
  }
  return {
    positional, named,
    mixed: positional > 0 && named.length > 0,
    count: positional + named.length,
  };
}

/**
 * HOW MANY PARAMETERS THIS RAIL MUST SEND — asked for templates the Meta
 * lifecycle knows nothing about, which at an install that has never synced is
 * ALL of them.
 *
 * templatePlaceholders() deliberately treats an unmanaged row as no evidence,
 * and for its purposes that is right: it refuses nothing on a guess. But
 * "no evidence" was being read here as "zero blanks", and a campaign then left
 * with ZERO parameters for a template whose other rail in this same app sends
 * two. Meta refuses a short parameter list for every recipient identically, so
 * the whole audience burns after the owner has confirmed a cost — the exact
 * failure this module exists to prevent.
 *
 * So this asks the two things a never-synced row DOES record, and only trusts
 * them when they agree:
 *
 *   • `param_order` — the positional variable list every other rail in this app
 *     uses to send this very template. It is a contract, not a guess.
 *   • the saved `body` — the wording, whose blanks are countable.
 *
 * AGREEMENT IS THE PROOF. Two independent records of the same template landing
 * on the same number is evidence; one of them alone is not, because either can
 * be stale. When they DISAGREE the honest answer is that this app does not know
 * how many blanks Meta approved — and the caller refuses rather than sending
 * bare, which is what the owner asked for.
 */
export interface BroadcastBlanks {
  /** True only when the number rests on agreeing evidence. */
  known: boolean;
  count: number;
  /** Which evidence produced it — named in every refusal so it can be checked. */
  source: '' | 'lifecycle' | 'stored_param_order' | 'no_blanks';
  /** Position → the variable name this app's other rails put there. */
  names: string[];
  /**
   * META SETTLED THE COUNT AND THIS APP SUPPLIED THE NAMES — the shape a sync
   * leaves behind, because Meta returns numbered blanks. Said out loud in a
   * refusal, since it is the sentence that tells an owner where a name he
   * thinks is wrong actually comes from. See withLocalNames().
   *
   * False on the unmanaged paths below, where `source` already says the whole
   * answer is this app's own records.
   */
  names_local: boolean;
  /** Why the count could not be established. Empty when known. */
  reason: string;
}

/**
 * The exact wording templatePlaceholders() counted, so it can be counted again
 * in both dialects. Mirrors that function's evidence order — Meta's own BODY
 * component, else the stored body — and returns '' for var_spec (nothing to
 * re-read) or when the row has gone.
 */
function lifecycleWording(db: DB, templateName: string, source: string): string {
  if (source !== 'meta_components' && source !== 'body') return '';
  let row: any;
  try { row = db.prepare(`SELECT body, meta_components FROM whatsapp_templates WHERE name = ?`).get(templateName); }
  catch { return ''; }
  if (!row) return '';
  if (source === 'body') return String(row.body || '');
  try {
    const comps = JSON.parse(String(row.meta_components || '[]'));
    if (Array.isArray(comps)) {
      const body = comps.find((c: any) => String(c?.type ?? '').toUpperCase() === 'BODY');
      if (body) return String(body.text ?? '');
    }
  } catch { /* unreadable components — nothing to re-count */ }
  return '';
}

/**
 * WHAT EACH POSITION MEANS, where the lifecycle answered only HOW MANY.
 *
 * Meta hands a template's body back in the POSITIONAL dialect — 'Hi {{1}}, we
 * have tables free at {{2}} on {{3}}' — so a synced row's placeholder names are
 * empty. The count is then right and the MEANING is gone, and that combination
 * is the one whole-audience failure with no backstop anywhere behind it: three
 * blanks, three mapped, every message accepted by Meta, nothing failed, the
 * breaker silent, the cost charged, and every guest reading "tables free at
 * AKAN on AKAN". It is the same harm the named-blank refusal exists to stop,
 * reached by the one action the operator is told to take — "Refresh templates".
 *
 * This app holds two records of its own about what those positions mean: the
 * saved wording's named blanks, and the `param_order` its other rails send for
 * this very template. Neither is evidence about NUMBER here — the lifecycle has
 * already settled that — but both are position-aligned evidence about MEANING.
 *
 * READ ONLY AT THE LIFECYCLE'S OWN COUNT. A record of a different length
 * describes a different shape of the template and is aligned with nothing, so
 * it is ignored rather than slid onto the wrong blank. The wording is preferred
 * over the variable list where both fit, because it is what the preview on
 * screen is built from.
 *
 * A row adopted from Meta holds neither record (sync writes Meta's own body and
 * an empty param_order), so nothing is claimed about it — the blanks stay
 * unnamed and the mapping step shows each one in the sentence it sits in.
 *
 * NOT ASKED OF AN AUTHORED var_spec. That record names its blanks explicitly
 * and position by position, so a name left empty in it is a deliberate "no
 * evidence" rather than a gap to be filled from somewhere else — and
 * paramOrderFromVarSpec() drops unnamed rows anyway, so the two records could
 * not be aligned there in the first place.
 */
function withLocalNames(
  db: DB,
  templateName: string,
  count: number,
  names: readonly string[],
): { names: string[]; local: boolean } {
  const out = Array.from({ length: count }, (_, i) => String(names[i] ?? '').trim());
  if (!out.some(n => !n)) return { names: out, local: false };

  let row: any;
  try { row = db.prepare(`SELECT param_order, body FROM whatsapp_templates WHERE name = ?`).get(String(templateName || '').trim()); }
  catch { return { names: out, local: false }; }
  if (!row) return { names: out, local: false };

  const census = bodyBlanks(row.body);
  const fromBody = census.count === count ? alignedNames(census) : [];

  let stored: string[] = [];
  try {
    const v = JSON.parse(String(row.param_order || '[]'));
    if (Array.isArray(v)) stored = v.map((x: unknown) => String(x ?? '').trim()).filter(Boolean);
  } catch { stored = []; }
  const fromOrder = stored.length === count ? stored : [];

  let local = false;
  const filled = out.map((n, i) => {
    if (n) return n;
    const supplied = String(fromBody[i] ?? '').trim() || String(fromOrder[i] ?? '').trim();
    if (supplied) local = true;
    return supplied;
  });
  return { names: filled, local };
}

export function broadcastBlanks(db: DB, templateName: string): BroadcastBlanks {
  const name = String(templateName || '').trim();
  const unknown = (reason: string): BroadcastBlanks =>
    ({ known: false, count: 0, source: '', names: [], names_local: false, reason });
  if (!name) return unknown('This campaign has no template name, so nothing can say how many blanks it needs.');

  // The lifecycle's answer wins whenever it has one — a synced install is
  // unchanged by everything below.
  //
  // WITH ONE CORRECTION, AND ONLY UPWARDS. templatePlaceholders() counts a
  // wording with maxPlaceholderIndex(), which sees {{1}}-style blanks and
  // nothing else. That is right for the templates Meta writes that way, and
  // silently wrong for a MANAGED row whose approved body is written with NAMES:
  // it reports known/0 about 'Hi {{name}}, we miss you at {{venue}}!', the
  // wizard then offers no blanks, and the campaign leaves with zero parameters —
  // the exact bare send this function exists to prevent, re-opened the moment
  // anyone clicks "Refresh templates" (sync copies Meta's components in and
  // writes no var_spec).
  //
  // So the SAME wording the lifecycle counted is counted again in both dialects,
  // and the fuller answer is taken. Never the smaller one: a positional install
  // censuses identically (census.positional IS maxPlaceholderIndex), so nothing
  // that works today moves.
  const ph = templatePlaceholders(db, name);
  if (ph.known) {
    // NAMES STAY POSITION-ALIGNED (they used to be filter(Boolean)-ed, which
    // slid an unnamed var_spec row's neighbours onto the wrong blank).
    let count = ph.count;
    let names: string[] = ph.names.slice(0, ph.count);
    let local = false;
    // An authored var_spec names every blank explicitly — its own count is the
    // answer and re-reading a body cannot improve on it.
    if (ph.source !== 'var_spec') {
      const census = bodyBlanks(lifecycleWording(db, name, ph.source));
      if (census.count > count) {
        count = census.count;
        // Position-aligned: the positional slots come first and are unnamed.
        names = alignedNames(census);
      }
      // THE COUNT CAN BE SETTLED WHILE THE MEANING IS NOT — Meta answers in
      // numbered blanks. Fill the unnamed positions from this app's own records
      // of the same template, so a blank a broadcast cannot fill is still
      // refused after a sync. See withLocalNames().
      const named = withLocalNames(db, name, count, names);
      names = named.names;
      local = named.local;
    }
    return { known: true, count, source: 'lifecycle', names, names_local: local, reason: '' };
  }

  let row: any;
  try { row = db.prepare(`SELECT param_order, body FROM whatsapp_templates WHERE name = ?`).get(name); }
  catch { row = undefined; }
  if (!row) {
    return unknown(`"${name}" is not one of the templates saved here and Meta's list has never been checked, so nothing in this app can say how many blanks Meta approved it with. Sending it with none would be refused for every guest on the list, not just some. Refresh the template list on Settings → Integrations → WhatsApp → Templates, or pick a saved template instead.`);
  }

  let stored: string[] = [];
  try {
    const v = JSON.parse(String(row.param_order || '[]'));
    if (Array.isArray(v)) stored = v.map((x: unknown) => String(x ?? '').trim()).filter(Boolean);
  } catch { stored = []; }

  const body = String(row.body ?? '');
  const census = bodyBlanks(body);
  const hasBody = body.trim() !== '';

  if (!hasBody) {
    // No wording saved to cross-check against. The stored variable list is then
    // the only record there is — and it IS what the other rails send.
    if (stored.length) {
      return { known: true, count: stored.length, source: 'stored_param_order', names: stored, names_local: false, reason: '' };
    }
    return unknown(`Nothing saved here records the wording of "${name}" or the variables it takes, and Meta's list has never been checked — so this app cannot tell how many blanks Meta approved it with. Sending it with none would be refused for every guest on the list, not just some.`);
  }

  if (stored.length === census.count) {
    return {
      known: true,
      count: census.count,
      source: census.count === 0 ? 'no_blanks' : 'stored_param_order',
      names: stored,
      names_local: false,
      reason: '',
    };
  }

  const wording = census.count === 0
    ? 'its saved wording marks none'
    : `its saved wording marks ${census.count} (${[...census.named.map(n => `{{${n}}}`), ...(census.positional ? [`up to {{${census.positional}}}`] : [])].join(', ')})`;
  const list = stored.length
    ? `${stored.length} (${stored.map(s => `"${s}"`).join(', ')})`
    : 'none';
  return unknown(`This app holds two records of "${name}" and they disagree: its saved variable list has ${list}, but ${wording}. WhatsApp fills the blanks strictly in order and counts them, so until that is settled a campaign on this message could be turned down for every guest on the list, not just some. Press Refresh status on Settings → Integrations → WhatsApp → Templates so WhatsApp's own answer decides.`);
}

/**
 * Same shape as wa-template-authoring's ParamCheck, with `source` widened so
 * this rail's own evidence names can travel in it.
 */
export interface BroadcastParamCheck {
  ok: boolean;
  /** -1 when the template's shape is unknown. */
  expected: number;
  provided: number;
  source: string;
  reason: string;
}

/**
 * The parameter-count gate for one campaign, asked the same way everywhere:
 * create, start, resume and every drain pass — because a template can be EDITED
 * at Meta (an edit resets it to PENDING and can change its placeholders) after
 * the campaign was built against the old shape.
 *
 * It compares the EFFECTIVE list (what the drain will really send) against the
 * template's placeholders, and hands the dropped variables to the message so
 * the operator is told which one this rail cannot fill.
 *
 * THREE QUESTIONS, in order:
 *   1. HOW MANY blanks — broadcastBlanks(), which carries the lifecycle's own
 *      answer for a managed row (corrected upwards where Meta's wording uses
 *      named blanks the lifecycle cannot count) and this rail's reading of the
 *      two records an UNMANAGED row holds otherwise. paramMappingCheck() still
 *      writes the refusal wherever the lifecycle is the one that disagrees.
 *   2. A BARE list (zero mapped) against a template whose shape cannot be
 *      established at all — refused, because zero is what an empty mapping
 *      screen produces, not something an operator chose.
 *   3. CAN THIS RAIL FILL THEM — the blank NAMES, asked even when the count is
 *      right, because a correct count with a wrong meaning is delivered in full
 *      and charged in full. See unfillableBlanks().
 *
 * WHY A BARE LIST IS REFUSED AND A NON-EMPTY UNPROVABLE ONE IS NOT. Zero is not
 * an answer the operator gave — it is what an empty mapping screen produces when
 * nothing could be counted, so it is the shape that ships silently and burns an
 * audience. A count the operator actually mapped is an assertion this app holds
 * no evidence against, and refusing it would block templates that work today.
 */
export function paramCheckFor(
  db: DB,
  templateName: string,
  paramOrder: readonly string[],
  dropped: readonly string[] = [],
): BroadcastParamCheck {
  const provided = Array.isArray(paramOrder) ? paramOrder.length : 0;
  const name = String(templateName || '').trim();

  // ONE SOURCE FOR THE COUNT. broadcastBlanks() already carries the lifecycle's
  // answer (and corrects it upwards where the lifecycle can only count {{n}}),
  // so asking it FIRST is what closes the hole a synced, named-body template
  // opened: paramMappingCheck() alone answered "0 expected, 0 supplied — fine"
  // about a message with two blanks in it.
  const b = broadcastBlanks(db, templateName);
  const base = () => paramMappingCheck(db, templateName, paramOrder, { dropped, fillable: BROADCAST_VARS });

  if (!b.known) {
    const lifecycle = base();
    // Defensive: the lifecycle is folded into broadcastBlanks(), so it should
    // never speak where that is silent. If it ever does, it wins.
    if (lifecycle.expected >= 0) return lifecycle;
    if (provided === 0) {
      return { ok: false, expected: -1, provided, source: '', reason: b.reason };
    }
    /* HOW MANY is unknown; WHAT THEY MEAN need not be.
     *
     * The two records of an unmanaged row can disagree about the COUNT while
     * the saved wording still plainly asks for {{date}} and {{content}}. This
     * rail cannot fill either, so a campaign here — reachable by calling this
     * route directly, which is the whole reason the gate lives on the server —
     * would deliver a wrong sentence to the entire list at the right parameter
     * count, which Meta accepts and charges for. Names are evidence about
     * MEANING even where they are not evidence about number. */
    const savedNames = savedBlankNames(db, templateName);
    const cannot = unfillableBlanks(savedNames);
    if (cannot.length) {
      return {
        ok: false, expected: -1, provided, source: '',
        reason: `${unfillableReason(name, cannot)} (Nothing here can say how many blanks Meta approved "${name}" with either — refresh the template list on Settings → Integrations → WhatsApp → Templates so Meta's own answer decides.)`,
      };
    }
    /* And the same for a mapping that contradicts the wording. wordingBlankNames
     * aligns only at a wording that marks exactly as many blanks as this
     * campaign maps: at any other length the two records describe different
     * shapes of the template and position 2 here is not position 2 there, so
     * there is no contradiction to see — only a misalignment to imagine. */
    const written = wordingBlankNames(db, name, provided);
    const swapped = mappingVerdict(db, name, paramOrder).hard;
    if (swapped.length) {
      return {
        ok: false, expected: -1, provided, source: '',
        reason: contradictionReason(db, name, swapped, written, paramOrder, false),
      };
    }
    return { ok: true, expected: -1, provided, source: '', reason: '' };
  }

  if (b.count !== provided) {
    // Where the lifecycle itself is the one that disagrees, use ITS wording —
    // it names the evidence (var_spec / Meta's components / the stored body).
    const lifecycle = base();
    if (!lifecycle.ok && lifecycle.expected === b.count) return lifecycle;

    const where = b.source === 'stored_param_order'
      ? 'according to the variable list and the wording saved here, which agree'
      : b.source === 'lifecycle'
        ? 'in the wording Meta holds for it'
        : 'and nothing saved here marks a blank in it';
    const shortfall = b.count > provided
      ? ` Meta fills blanks strictly by position, so a message that supplies ${provided} for ${b.count} would arrive with ${b.count - provided} unfilled and be refused.`
      : '';
    const named = b.names.filter(Boolean);
    const namesHint = b.count > provided && named.length
      ? ` Its variables are ${named.map(n => `"${n}"`).join(', ')}, and a broadcast can fill only: ${BROADCAST_VARS.join(', ')}.`
      : '';
    const droppedHint = dropped.length
      ? ` The campaign also maps ${dropped.map(d => `"${d}"`).join(', ')}, which a broadcast cannot fill.`
      : '';

    return {
      ok: false,
      expected: b.count,
      provided,
      source: b.source,
      reason: `"${name}" has ${b.count} blank${b.count === 1 ? '' : 's'} ${where}, but this campaign supplies ${provided}.${shortfall}${namesHint}${droppedHint} Map one broadcast variable per blank before starting this campaign.`,
    };
  }

  /* ── THE COUNT AGREES. That is not the same as "this rail can fill them." ──
   *
   * A right-COUNT campaign on a template whose blanks mean things a broadcast
   * does not know — {{day}}, {{open_time}}, {{answered_pct}} — is the one
   * whole-audience failure with no backstop anywhere behind it: Meta accepts
   * every message (the count matches), the circuit breaker never fires (nothing
   * fails), the cost is charged, and every guest is left in a 7-day cooldown
   * having read a sentence like "tables free at AKAN on AKAN". The wizard's
   * first guess produced exactly that mapping, because a blank whose name
   * matches no rule fell back to name/venue by position.
   *
   * The knowledge that a broadcast can fill only name/venue/phone already
   * existed here — but only in the count-mismatch message, which by definition
   * cannot be reached when the counts agree. It is a fact about the template
   * either way, so it is asked either way. */
  /* THE WORDING OUTRANKS THE VARIABLE LIST ABOUT MEANING.
   *
   * broadcastBlanks() answers this branch's `names` from the stored variable
   * list whenever that list and the wording agree on the COUNT — which is right
   * for counting and wrong for meaning: a row whose wording says
   * '…book your table for {{event_name}} at {{venue}}' while its stored list
   * says ["name","name","venue"] reported three fillable blanks, and the blank
   * a broadcast cannot fill was never seen. So where a record AUTHORITATIVE
   * about meaning names a position, that name is the one asked about. */
  const meanings = blankMeanings(db, name, b.count);
  const meant = b.names.map((n, i) => (meanings[i]?.authoritative && meanings[i].name) || String(n ?? ''));
  const cannotFill = unfillableBlanks(meant);
  if (cannotFill.length) {
    return {
      ok: false,
      expected: b.count,
      provided,
      source: b.source,
      reason: unfillableReason(name, cannotFill, b.names_local),
    };
  }

  /* ── THE BLANKS CAN ALL BE FILLED. That is not the same as "filled with the
   *    RIGHT ONE." ──
   *
   * Asked LAST, deliberately: a blank this rail cannot fill at all is the older
   * and larger fault and keeps its own refusal wording, so nothing that reads
   * that message today reads a different one now. */
  const written = wordingBlankNames(db, name, b.count);
  const swapped = mappingVerdict(db, name, paramOrder).hard;
  if (swapped.length) {
    return {
      ok: false,
      expected: b.count,
      provided,
      source: b.source,
      reason: contradictionReason(db, name, swapped, written, paramOrder, b.names_local),
    };
  }

  return { ok: true, expected: b.count, provided, source: b.source, reason: '' };
}

/** The blanks the SAVED wording marks, position-aligned, whatever the count question did. */
function savedBlankNames(db: DB, templateName: string): string[] {
  let row: any;
  try { row = db.prepare(`SELECT body FROM whatsapp_templates WHERE name = ?`).get(String(templateName || '').trim()); }
  catch { return []; }
  return row ? alignedNames(bodyBlanks(row.body)) : [];
}

/** Census → one name per blank position: the positional slots first, unnamed. */
function alignedNames(census: BlankCensus): string[] {
  return [...Array(census.positional).fill(''), ...census.named];
}

/** One refusal, written once, so both branches say the same thing. */
function unfillableReason(
  name: string,
  cannot: Array<{ position: number; name: string }>,
  /** Meta numbered the blanks and this app named them — say where the name came from. */
  namesLocal = false,
): string {
  const many = cannot.length !== 1;
  const list = cannot.map(x => `blank ${x.position} (“${x.name}”)`).join(', ');
  const only = BROADCAST_VARS.map(v => BROADCAST_VAR_LABEL[v]).join(', ');
  // Meta returns a body with NUMBERED blanks, so after a sync the name is this
  // app's own — and an owner who thinks the name is wrong needs to be told
  // which record to correct rather than left refreshing a list that will keep
  // giving the same answer.
  const where = namesLocal
    ? ` Meta returns this template's wording with numbered blanks, so ${many ? 'those names come' : 'that name comes'} from the copy saved here — correct it on Settings → Integrations → WhatsApp → Templates if it is out of date.`
    : '';
  return `"${name}" has ${many ? 'blanks' : 'a blank'} a broadcast cannot fill — ${list}. A broadcast knows only three things it can put in a blank: ${only}. Putting one of those there would send the wrong sentence to every guest on the list — and because the NUMBER of blanks is right, Meta accepts all of it, nothing fails, and the whole audience is charged for and locked into a cooldown. Use a template whose blanks are only ${only}, or have this one re-written without ${many ? 'those blanks' : 'that blank'}.${where}`;
}

/**
 * THE SWAP, WRITTEN OUT AS THE GUEST WOULD READ IT.
 *
 * An operator who swapped two dropdowns did not make a spelling mistake — he
 * believes the mapping is right, and every preview in this app agreed with him.
 * So the refusal does not argue: it prints the SENTENCE, filled the way this
 * campaign would really fill it, and lets him read it. That is the one form of
 * this message nobody talks themselves past.
 */
function contradictionReason(
  db: DB,
  name: string,
  bad: ContradictedBlank[],
  names: readonly string[],
  paramOrder: readonly string[],
  /** Meta numbered the blanks and this app named them — say where the name came from. */
  namesLocal = false,
): string {
  const many = bad.length !== 1;
  const per = bad.map(x =>
    `blank ${x.position} is written as “${x.name}”, which asks for ${BROADCAST_VAR_LABEL[x.asks]}, but this campaign puts ${BROADCAST_VAR_LABEL[x.mapped]} in it`,
  ).join('; ');

  /* THE VENUE'S REAL NAME GOES IN, through the same labelValues() every other
   * sentence in this file uses. Two bracketed labels describe a swap; they do
   * not show one — “Hi [your venue name], … your last visit to [the guest's
   * name].” reads as a perfectly sensible template either way round. “Hi Akan,
   * … your last visit to [the guest's name].” is wrong on sight. */
  const wording = ownerWording(db, name);
  const asWritten = wording ? fillBlanksInOrder(wording, labelValues(db, paramOrder)) : '';
  const asMeant = wording
    ? fillBlanksInOrder(wording, labelValues(db, names.map((n, i) => blankVar(n) ?? String(paramOrder[i] ?? ''))))
    : '';
  const shown = asWritten && asWritten !== asMeant
    ? ` Every guest would read: “${asWritten.trim()}” — where the wording means: “${asMeant.trim()}”.`
    : '';

  const where = namesLocal
    ? ` WhatsApp returns this template's wording with numbered blanks, so ${many ? 'those names come' : 'that name comes'} from the copy saved here — correct it on Settings → Integrations → WhatsApp → Templates if it is out of date.`
    : '';

  return `“${name}” would go out with ${many ? 'its blanks' : 'a blank'} filled by the wrong thing — ${per}.${shown} WhatsApp fills blanks strictly in order and would accept every message, so nothing would fail, nothing would stop, and the whole list would be charged for and left unable to receive another offer until the cooldown ends. Set ${many ? 'those blanks' : 'that blank'} back to what the wording asks for before sending.${where}`;
}

/**
 * The mapping gate for one campaign, asked identically at start, at resume and
 * on every drain pass.
 *
 * WITH THE ACKNOWLEDGEMENT FOLDED IN when the campaign has an id, because a
 * blank nothing can vouch for is confirmed against the real sentence at create
 * time — and that confirmation has to survive everything that happens between
 * create and the first message. PATCH can rewrite a draft's param_order with no
 * mapping check of its own (that route is not this lane's file); a raw state
 * change can skip startBroadcast entirely. Both change the sentence, both
 * therefore no longer match what was confirmed, and both are refused here.
 */
export function campaignParamCheck(
  db: DB,
  c: Pick<BroadcastCampaign, 'param_order' | 'template_name'> & { id?: string },
): BroadcastParamCheck {
  const order = paramOrderOf(c);
  const base = paramCheckFor(db, c.template_name, order, droppedParamsOf(c));
  if (!base.ok || !c.id) return base;

  /* THE MAPPING MUST STILL BE THE ONE THAT WAS CONFIRMED.
   *
   * Checked BEFORE the sentence, because the sentence can be re-supplied at the
   * start door and the mapping cannot: /action replaces the stored confirmation
   * with whatever the request carries, so on a rewritten mapping the refusal's
   * own reply was the key to it. See setCampaignAckOrder. */
  const confirmedFor = campaignAckOrder(db, String(c.id));
  if (confirmedFor && (confirmedFor.length !== order.length || confirmedFor.some((v, i) => v !== order[i]))) {
    return {
      ...base,
      ok: false,
      reason: `The blanks of “${c.template_name}” were confirmed as ${confirmedFor.map(v => BROADCAST_VAR_LABEL[v as BroadcastVar] || v).join(', then ')}, and this campaign now fills them with ${order.map(v => BROADCAST_VAR_LABEL[v as BroadcastVar] || v).join(', then ')}. That is a different message to every guest on the list, and the reading that was done does not answer for it. Nothing has been sent — build the campaign again with the mapping you want, so the message it would really send can be read before the cost is confirmed.`,
    };
  }

  const ack = mappingAckCheck(db, c.template_name, order, campaignAck(db, String(c.id)));
  if (ack.ok) return base;
  return { ...base, ok: false, reason: ack.reason };
}

export function startBroadcast(db: DB, id: string, opts: { nowMs?: number } = {}): TransitionResult {
  const c = getCampaign(db, id);
  if (!c) return { ok: false, error: 'not_found' };
  if (c.state !== 'draft' && c.state !== 'scheduled') return { ok: false, error: 'bad_state', campaign: c };
  if (!String(c.template_name || '').trim()) return { ok: false, error: 'no_template', campaign: c };
  const send = campaignSendability(db, c);
  if (!send.ok) return { ok: false, error: 'template_not_approved', detail: send.reason, campaign: c };
  // Second gate: a campaign that maps the wrong NUMBER of variables fails for
  // every recipient, identically — same blast radius as an unapproved template.
  const pm = campaignParamCheck(db, c);
  if (!pm.ok) return { ok: false, error: 'param_mismatch', detail: pm.reason, campaign: c };
  // Third gate: a header this rail cannot fill is refused by Meta for every
  // recipient, identically — same blast radius, different cause.
  const hf = campaignHeaderFill(db, c);
  if (!hf.ok) return { ok: false, error: 'header_unfillable', detail: hf.reason, campaign: c };
  const queued = Number((db.prepare(
    `SELECT COUNT(*) AS n FROM wa_campaign_recipients WHERE campaign_id = ? AND state = 'queued'`,
  ).get(id) as any)?.n) || 0;
  if (queued === 0) return { ok: false, error: 'nothing_queued', campaign: c };

  const rate = broadcastSettings(db).cost_per_msg;
  db.prepare(`
    UPDATE wa_campaigns
    SET state = 'sending', started_at = ?, cost_rate = ?, cost_estimate = ?,
        halt_reason = '', updated_at = datetime('now')
    WHERE id = ? AND state IN ('draft', 'scheduled')
  `).run(utcString(opts.nowMs ?? Date.now()), rate, Math.round(queued * rate * 100) / 100, id);
  // A campaign starting for the first time has no attempts behind it, so the
  // circuit breaker counts from the beginning of the run.
  setStreakFloor(db, id, 0);
  return { ok: true, campaign: getCampaign(db, id) };
}

/** sending → paused. The drain re-reads state before EVERY message. */
export function pauseBroadcast(db: DB, id: string): TransitionResult {
  const c = getCampaign(db, id);
  if (!c) return { ok: false, error: 'not_found' };
  if (c.state !== 'sending') return { ok: false, error: 'bad_state', campaign: c };
  // A human pause carries no machine reason — clear any stale one so the UI
  // never attributes a person's decision to Meta.
  db.prepare(`UPDATE wa_campaigns SET state = 'paused', halt_reason = '', updated_at = datetime('now') WHERE id = ? AND state = 'sending'`).run(id);
  return { ok: true, campaign: getCampaign(db, id) };
}

/** paused → sending.
 *
 *  Re-asks the approval gate. A campaign the drain halted BECAUSE its template
 *  was paused at Meta must not be resumable by clicking Resume — that would
 *  just re-halt it (or, worse, burn the queue on failures) until Meta unpauses
 *  the template. Clearing halt_reason here is what marks the halt as resolved. */
export function resumeBroadcast(db: DB, id: string): TransitionResult {
  const c = getCampaign(db, id);
  if (!c) return { ok: false, error: 'not_found' };
  if (c.state !== 'paused') return { ok: false, error: 'bad_state', campaign: c };
  const send = campaignSendability(db, c);
  if (!send.ok) return { ok: false, error: 'template_not_approved', detail: send.reason, campaign: c };
  const pm = campaignParamCheck(db, c);
  if (!pm.ok) return { ok: false, error: 'param_mismatch', detail: pm.reason, campaign: c };
  const hf = campaignHeaderFill(db, c);
  if (!hf.ok) return { ok: false, error: 'header_unfillable', detail: hf.reason, campaign: c };
  // Resuming asserts the halt's cause is fixed, so the circuit breaker starts
  // its count again from here rather than from a streak already at the limit.
  setStreakFloor(db, id, attemptCount(db, id));
  db.prepare(`UPDATE wa_campaigns SET state = 'sending', halt_reason = '', updated_at = datetime('now') WHERE id = ? AND state = 'paused'`).run(id);
  return { ok: true, campaign: getCampaign(db, id) };
}

/** draft|scheduled|sending|paused → cancelled; remaining queued rows too. */
export function cancelBroadcast(db: DB, id: string): TransitionResult {
  const c = getCampaign(db, id);
  if (!c) return { ok: false, error: 'not_found' };
  if (!['draft', 'scheduled', 'sending', 'paused'].includes(c.state)) return { ok: false, error: 'bad_state', campaign: c };
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE wa_campaigns SET state = 'cancelled', finished_at = COALESCE(finished_at, datetime('now')), updated_at = datetime('now')
      WHERE id = ? AND state IN ('draft', 'scheduled', 'sending', 'paused')
    `).run(id);
    db.prepare(`UPDATE wa_campaign_recipients SET state = 'cancelled' WHERE campaign_id = ? AND state = 'queued'`).run(id);
  });
  tx();
  return { ok: true, campaign: getCampaign(db, id) };
}

// ─── Counts / progress ─────────────────────────────────────────────────────

export interface RecipientCounts {
  queued: number; sending: number; sent: number; delivered: number; read: number;
  replied: number; failed: number; capped: number;
  skipped_optout: number; skipped_cooldown: number; cancelled: number;
  total: number;
  /** sent + delivered + read + replied — messages that actually left. */
  sent_total: number;
}

export function recipientCounts(db: DB, campaignId: string): RecipientCounts {
  const out: RecipientCounts = {
    queued: 0, sending: 0, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, capped: 0,
    skipped_optout: 0, skipped_cooldown: 0, cancelled: 0, total: 0, sent_total: 0,
  };
  let rows: any[] = [];
  try {
    rows = db.prepare(`
      SELECT state AS s, COUNT(*) AS n FROM wa_campaign_recipients WHERE campaign_id = ? GROUP BY state
    `).all(campaignId) as any[];
  } catch { return out; }
  for (const r of rows) {
    const n = Number(r.n) || 0;
    if (r.s in out) (out as any)[r.s] = n;
    out.total += n;
  }
  out.sent_total = out.sent + out.delivered + out.read + out.replied;
  return out;
}

export function campaignProgress(db: DB, c: BroadcastCampaign) {
  const counts = recipientCounts(db, c.id);
  return {
    counts,
    unconfirmed: counts.sending,
    cost: {
      rate: Number(c.cost_rate) || 0,
      estimate: Number(c.cost_estimate) || 0,
      /** what the sends made so far actually cost at the captured rate */
      actual: Math.round(counts.sent_total * (Number(c.cost_rate) || 0) * 100) / 100,
    },
  };
}

// ─── The drain (scheduler/cron-driven) ─────────────────────────────────────

/** Injectable transport — the REAL one is sendWhatsAppTemplate. */
export type BroadcastSender = (
  to: string, templateName: string, languageCode: string, bodyParams: string[],
) => Promise<WaSendResult>;

export interface DrainResult {
  ran: boolean;
  reason?: 'disabled' | 'wa_not_configured' | 'no_sending_campaigns' | 'no_budget' | 'daily_cap';
  budget: number;
  attempted: number;
  sent: number;
  failed: number;
  skipped_optout: number;
  skipped_cooldown: number;
  campaigns_touched: string[];
  campaigns_finished: string[];
  /** Campaigns the drain stopped ITSELF because their template is no longer
   *  approved at Meta. They are left in 'paused' with halt_reason set. */
  campaigns_halted: Array<{ id: string; reason: string }>;
  cap_hit: boolean;
  errors: Array<{ phone: string; error: string }>;
}

function emptyDrain(reason?: DrainResult['reason']): DrainResult {
  return {
    ran: !reason, reason, budget: 0, attempted: 0, sent: 0, failed: 0,
    skipped_optout: 0, skipped_cooldown: 0, campaigns_touched: [], campaigns_finished: [],
    campaigns_halted: [], cap_hit: false, errors: [],
  };
}

/** Meta rejects positional params with newlines/tabs/long space runs. */
function cleanParam(v: unknown): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

function recipientVars(r: { name: string; phone_e164: string }, venue: string): Record<string, string> {
  return { name: r.name || 'there', venue, phone: r.phone_e164 };
}

/**
 * THE THREAD ECHO — the venue's own durable record of what it really sent.
 *
 * IT USED TO RECORD THE OPPOSITE OF THE TRUTH. renderTemplate() substituted
 * named blanks BY NAME, so {{venue}} always printed the venue whatever the
 * campaign actually put there: a campaign whose blanks were the wrong way round
 * carried the swapped sentence on the wire and wrote the CORRECT one into the
 * inbox. Every later attempt to find out what a guest was sent would have been
 * answered with the sentence nobody sent — the exact fault this gate exists to
 * remove, preserved in the one place an owner would go to check.
 *
 * So it renders the way WhatsApp renders: blank ORDER, from this campaign's own
 * mapping. And it renders the wording META will use where we hold it (`wording`
 * — the drain passes it once per campaign), because preview_body is whatever
 * the caller typed and is not authoritative about anything.
 *
 * AND IT NO LONGER FALLS BACK TO preview_body. That fallback was the same fault
 * in its last hiding place. preview_body is caller-controlled — POST derives it
 * now, but PATCH /api/crm-calls/broadcasts/[id] still stores it verbatim — so
 * whenever this app held no wording (a template name only Meta knows, a row
 * deleted or blanked between start and drain) the echo recorded the CALLER'S
 * sentence while the wire carried Meta's. MEASURED: wire "LAST CHANCE Rahul
 * Verma — our Akan Diwali menu closes tonight." against an inbox reading "Hi
 * Rahul Verma, here is 20% off your next visit to Akan." — the venue's own
 * durable record asserting the opposite of what it sent, which is exactly the
 * fault this function was rewritten to remove.
 *
 * With no wording there is no honest sentence to write, so it records the only
 * two things that are certainly true: which template Meta rendered, and the
 * exact parameters handed to it. Unreadable as prose, and correct.
 *
 * THE VALUES ARE CLEANED THE WAY THE WIRE CLEANS THEM. The drain sends
 * cleanParam(value) — Meta rejects newlines, tabs and long space runs in
 * positional parameters — so substituting the RAW value here made the record
 * disagree with the request for any guest whose name carries a newline or a
 * double space (the shape a WhatsApp push name or a CRM import supplies).
 * Same function, same string, byte for byte.
 */
export function renderCampaignBody(c: BroadcastCampaign, vars: Record<string, string>, wording?: string): string {
  const body = String(wording || '').trim();
  const params = paramOrderOf(c).map(k => cleanParam(vars[k] ?? ''));
  if (!body) {
    return params.length
      ? `[template] ${c.template_name} (${params.join(' | ')})`
      : `[template] ${c.template_name}`;
  }
  return fillBlanksInOrder(body, params);
}

/**
 * HOW MANY SENDS IN A ROW HAVE ALREADY FAILED on this campaign, read back from
 * the queue itself.
 *
 * WHY IT IS NOT A VARIABLE. The breaker used to count in a local that was born
 * and died inside ONE drain pass, so it could only ever reach the pass's budget.
 * At broadcast_msgs_per_min = 4 a pass attempts 4 messages, the counter reached
 * 4, the pass returned, and the next pass started again at zero — so a
 * 5-consecutive-failure breaker could not fire at ANY throttle below 5/min, and
 * a whole 2,000-guest audience burnt one tidy budget at a time. Measured on the
 * owner's own data at 4/min: 27 of 27 recipients attempted, breaker never fired.
 *
 * The queue is the durable record of what happened, so the streak is read from
 * it: the same thing survives a restart, a second concurrent drain, and any
 * throttle. Only 'sent' and 'failed' are ATTEMPTS — a row skipped for consent or
 * cooldown never reached the transport, so it neither counts nor clears.
 *
 * ORDER. The drain claims rows `ORDER BY queued_at, id`, so reversing exactly
 * that ordering walks the attempts newest-first without depending on
 * second-resolution timestamps (which tie when a fast transport sends several
 * within one second).
 */
export function trailingFailStreak(db: DB, campaignId: string, limit = CONSECUTIVE_FAIL_HALT): number {
  // Attempts made BEFORE this sending stint began do not count — see
  // streakFloor(). Measured in rows, not in timestamps: sent_at/failed_at have
  // second resolution, so a Resume in the same second as the halting failure
  // would otherwise still see that failure and re-halt on the next one.
  const inStint = attemptCount(db, campaignId) - streakFloor(db, campaignId);
  if (inStint <= 0) return 0;

  let rows: any[] = [];
  try {
    rows = db.prepare(`
      SELECT state FROM wa_campaign_recipients
      WHERE campaign_id = ? AND state IN ('sent', 'failed')
      ORDER BY queued_at DESC, id DESC
      LIMIT ?
    `).all(campaignId, Math.min(inStint, Math.max(1, limit))) as any[];
  } catch { return 0; }
  let streak = 0;
  for (const r of rows) {
    if (String(r?.state) !== 'failed') break;
    streak++;
  }
  return streak;
}

/** Rows that actually reached the transport (skips never did). */
export function attemptCount(db: DB, campaignId: string): number {
  try {
    return Number((db.prepare(`
      SELECT COUNT(*) AS n FROM wa_campaign_recipients
      WHERE campaign_id = ? AND state IN ('sent', 'failed')
    `).get(campaignId) as any)?.n) || 0;
  } catch { return 0; }
}

/**
 * How many attempts were already behind this campaign when its CURRENT sending
 * stint began. Everything before it is somebody else's stint and does not count
 * towards the breaker.
 *
 * A human who clicks Resume is asserting they fixed whatever the halt named, so
 * they get the full allowance again; without this the seeded streak would still
 * be sitting at the halt threshold and the very next unreachable number — an
 * ordinary event — would halt the campaign a second time. Stored in ct_settings
 * beside the drain watermark rather than as a column, because this lane does not
 * own the schema.
 */
const STREAK_FLOOR_PREFIX = 'broadcast_streak_floor_';

export function streakFloor(db: DB, campaignId: string): number {
  try {
    const raw = String(ctSetting(db, STREAK_FLOOR_PREFIX + campaignId) || '').trim();
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch { return 0; }
}

export function setStreakFloor(db: DB, campaignId: string, value: number): void {
  try { setCtSetting(db, STREAK_FLOOR_PREFIX + campaignId, String(Math.max(0, Math.floor(value)))); }
  catch { /* settings unavailable — the breaker just counts across the whole run */ }
}

/** UTC string of the IST calendar-day start containing `nowMs`. */
export function istDayStartUtc(nowMs: number): string {
  return utcString(Date.parse(`${istDateStr(nowMs)}T00:00:00Z`) - 330 * 60_000);
}

/** Marketing sends today (IST), across BOTH rails. */
export function sentTodayCount(db: DB, nowMs: number): number {
  const dayStart = istDayStartUtc(nowMs);
  let n = 0;
  try {
    n += Number((db.prepare(
      `SELECT COUNT(*) AS n FROM wa_campaign_recipients WHERE sent_at IS NOT NULL AND sent_at >= ?`,
    ).get(dayStart) as any)?.n) || 0;
  } catch { /* table missing */ }
  try {
    n += Number((db.prepare(
      `SELECT COUNT(*) AS n FROM ct_campaign_targets WHERE sent_at IS NOT NULL AND REPLACE(sent_at, 'T', ' ') >= ?`,
    ).get(dayStart) as any)?.n) || 0;
  } catch { /* table missing */ }
  return n;
}

export interface DrainOpts {
  nowMs?: number;
  /** Test seam — when provided, isWaConfigured() is NOT required (the mock IS the transport). */
  sender?: BroadcastSender;
  venue?: string;
}

/**
 * DEV/E2E ONLY — BROADCAST_FAKE_TRANSPORT=1 swaps the provider transport for
 * an in-process fake that "delivers" instantly with a wamid.fake.* id, so the
 * whole pipeline (queue → throttle → thread echo → status webhooks) can be
 * exercised in a browser against a database COPY without a single real
 * WhatsApp message. Dead in production builds by construction: the flag is
 * only honoured when NODE_ENV !== 'production'.
 */
function fakeTransportActive(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.BROADCAST_FAKE_TRANSPORT === '1';
}
let fakeWamidSeq = 0;
const fakeSender: BroadcastSender = async (to) => {
  fakeWamidSeq++;
  const wamid = `wamid.fake.${Date.now()}.${fakeWamidSeq}`;
  console.log(`[wa-broadcast] FAKE transport: pretending to send template to ${to} → ${wamid}`);
  return { ok: true, provider: 'fake', message_id: wamid } as WaSendResult;
};

/**
 * One budgeted drain pass. Safe to call from anywhere, any number of times:
 * it sends nothing unless the master flag is on AND a campaign is in
 * 'sending', and the per-row claim makes concurrent drains race-safe.
 */
export async function drainBroadcasts(db: DB, opts: DrainOpts = {}): Promise<DrainResult> {
  const now = opts.nowMs ?? Date.now();
  const s = broadcastSettings(db);
  if (!s.enabled) return emptyDrain('disabled');
  const fake = !opts.sender && fakeTransportActive();
  if (!opts.sender && !fake && !isWaConfigured()) return emptyDrain('wa_not_configured');

  const campaigns = db.prepare(`
    SELECT * FROM wa_campaigns WHERE state = 'sending' ORDER BY started_at, id
  `).all() as BroadcastCampaign[];
  if (!campaigns.length) return emptyDrain('no_sending_campaigns');

  // Budget = rate × minutes since the last budgeted drain (capped). The
  // watermark only advances when budget ≥ 1, so sub-minute ticks accumulate.
  let lastMs = NaN;
  try { lastMs = Number(ctSetting(db, DRAIN_WATERMARK_KEY)); } catch { lastMs = NaN; }
  const elapsedMin = Number.isFinite(lastMs) && lastMs > 0
    ? Math.min(Math.max((now - lastMs) / 60_000, 0), ELAPSED_CAP_MIN)
    : 1;
  let budget = Math.min(Math.floor(s.msgs_per_min * elapsedMin), SEND_SLICE_MAX);
  if (budget < 1) return emptyDrain('no_budget');

  // Daily cap (IST day, both rails). <=0 → uncapped.
  let capHit = false;
  if (s.daily_cap > 0) {
    const remaining = s.daily_cap - sentTodayCount(db, now);
    if (remaining <= 0) return { ...emptyDrain('daily_cap'), cap_hit: true };
    if (budget > remaining) { budget = remaining; capHit = true; }
  }

  // Budget is consumed whether sends succeed or fail — advance the watermark
  // now so a throwing provider can't grant a double budget next tick.
  setCtSetting(db, DRAIN_WATERMARK_KEY, String(now));

  const sender: BroadcastSender = opts.sender
    ?? (fake ? fakeSender : (to, t, l, p) => sendWhatsAppTemplate(to, t, l, p));
  // The venue's own public name (settings.business_name), the outlet label only
  // as a fallback — see broadcastVenue(). An injected `venue` still wins, which
  // is what the test harnesses use.
  const venue = String(opts.venue || '').trim() || broadcastVenue(db);

  const result = emptyDrain();
  result.budget = budget;
  result.cap_hit = capHit;
  const cutoff = utcString(now - s.cooldown_days * 86_400_000);

  const claim = db.prepare(`UPDATE wa_campaign_recipients SET state = 'sending' WHERE id = ? AND state = 'queued'`);
  const finishSkip = db.prepare(`UPDATE wa_campaign_recipients SET state = ?, error_detail = ? WHERE id = ?`);
  const finishSent = db.prepare(`UPDATE wa_campaign_recipients SET state = 'sent', sent_at = ?, wamid = ?, error_detail = '' WHERE id = ?`);
  const finishFail = db.prepare(`UPDATE wa_campaign_recipients SET state = 'failed', failed_at = ?, error_detail = ? WHERE id = ?`);

  let budgetLeft = budget;

  for (const camp of campaigns) {
    if (budgetLeft <= 0) break;

    // SEND-TIME APPROVAL GATE. The template was approved when this campaign
    // started; Meta can PAUSE or DISABLE it at any moment afterwards on quality
    // signals — and can RECATEGORISE it, which is why this asks for the
    // category too rather than trusting the answer create-time got. Without
    // this check every remaining recipient would be attempted and fail
    // identically, burning the queue and the daily cap on a template that
    // cannot deliver. Halting into 'paused' WITH a reason is the honest state:
    // the operator sees why, and resume refuses until it is fixed.
    const sendable = campaignSendability(db, camp);
    if (!sendable.ok) {
      haltCampaign(db, camp.id, sendable.reason);
      result.campaigns_halted.push({ id: camp.id, reason: sendable.reason });
      continue;
    }

    // SEND-TIME PARAMETER GATE. Approval is not the only whole-queue failure: a
    // campaign that maps fewer (or more) variables than the template has
    // placeholders is refused by Meta for EVERY recipient, identically. Halting
    // costs one paused campaign; not halting costs the entire audience, the
    // daily cap, and the venue's template quality rating.
    const params = campaignParamCheck(db, camp);
    if (!params.ok) {
      haltCampaign(db, camp.id, params.reason);
      result.campaigns_halted.push({ id: camp.id, reason: params.reason });
      continue;
    }

    // SEND-TIME HEADER GATE. The third whole-queue refusal, and the only one
    // the transport itself cannot survive: this loop calls the sender with body
    // parameters ONLY (see `sender` above), so a template Meta approved with a
    // media header, or with a blank in its heading, is refused for every
    // recipient identically. A template can also be EDITED at Meta after this
    // campaign was built — a fixed heading can gain a blank — so this is asked
    // on every pass rather than trusted from create time.
    const header = campaignHeaderFill(db, camp);
    if (!header.ok) {
      haltCampaign(db, camp.id, header.reason);
      result.campaigns_halted.push({ id: camp.id, reason: header.reason });
      continue;
    }

    result.campaigns_touched.push(camp.id);
    const paramOrder = paramOrderOf(camp);
    // The wording the thread echo must be written from — Meta's own where we
    // hold it, this app's saved copy otherwise. Read ONCE per campaign.
    const echoWording = ownerWording(db, String(camp.template_name || ''));
    // Meta's identity is the exact (name, language) pair, and sync may have
    // learned a spelling the campaign does not carry ('en_US' for our 'en').
    // Send what Meta actually has; fall back to the campaign's own value when
    // nothing is known about the template.
    const sendLang = String(sendable.language || camp.language || 'en');
    /**
     * Consecutive send failures — the circuit breaker (see below). SEEDED FROM
     * THE QUEUE, not from zero: the streak belongs to the campaign, not to this
     * pass, or a throttle below the threshold makes the breaker unreachable.
     */
    let consecutiveFails = trailingFailStreak(db, camp.id);
    // Per-campaign throttle (when set) caps THIS campaign's share of the tick.
    const campCap = camp.throttle_per_min > 0
      ? Math.max(Math.floor(camp.throttle_per_min * elapsedMin), 1)
      : Infinity;
    let campSends = 0;

    for (;;) {
      if (budgetLeft <= 0 || campSends >= campCap) break;

      // PAUSE/CANCEL GATE — re-read state before EVERY message.
      const live = db.prepare(`SELECT state FROM wa_campaigns WHERE id = ?`).get(camp.id) as any;
      if (String(live?.state) !== 'sending') break;

      const r = db.prepare(`
        SELECT * FROM wa_campaign_recipients
        WHERE campaign_id = ? AND state = 'queued'
        ORDER BY queued_at, id LIMIT 1
      `).get(camp.id) as any;

      if (!r) {
        // Nothing queued: campaign is done when no claims are outstanding.
        // ('sending' claims = crashed rows — NEVER auto-retried; the campaign
        // stays 'sending' and the report shows them as unconfirmed.)
        const c2 = recipientCounts(db, camp.id);
        if (c2.queued === 0 && c2.sending === 0) {
          db.prepare(`
            UPDATE wa_campaigns SET state = 'done', finished_at = COALESCE(finished_at, ?), updated_at = datetime('now')
            WHERE id = ? AND state = 'sending'
          `).run(utcString(now), camp.id);
          result.campaigns_finished.push(camp.id);
        }
        break;
      }

      // 1. CLAIM (conditional — concurrent drains can never double-claim).
      if (claim.run(r.id).changes === 0) continue;

      // 2. CONSENT — the send-time gate. A STOP after preview/queue wins here.
      if (isOptedOut(db, String(r.phone_key))) {
        finishSkip.run('skipped_optout', 'opted out of marketing messages', r.id);
        result.skipped_optout++;
        continue;
      }

      // 3. COOLDOWN — one marketing message per guest per window, both rails.
      if (s.cooldown_days > 0) {
        const prior = lastMarketingSendSince(db, String(r.phone_key), cutoff);
        if (prior) {
          finishSkip.run('skipped_cooldown', `already messaged ${prior}`.slice(0, 300), r.id);
          result.skipped_cooldown++;
          continue;
        }
      }

      // 4. SEND (budget is consumed by the attempt, success or not).
      budgetLeft--;
      campSends++;
      result.attempted++;
      const vars = recipientVars(r, venue);
      const params = paramOrder.map(k => cleanParam(vars[k] ?? ''));
      let res: WaSendResult;
      try {
        res = await sender(String(r.phone_e164), String(camp.template_name), sendLang, params);
      } catch (e: any) {
        res = { ok: false, reason: 'send_failed', detail: e?.message || 'unexpected error' };
      }

      const sentAt = utcString(opts.nowMs ?? Date.now());
      if (res.ok) {
        consecutiveFails = 0;
        const wamid = String(res.message_id || '').trim() || null;
        finishSent.run(sentAt, wamid, r.id);
        result.sent++;
        // Thread echo — the SAME recording the inbox reply path does, so the
        // status webhook updates delivery/read on the visible message too.
        try {
          const conv = upsertConversation(db, String(r.phone_e164));
          if (conv) {
            recordOutbound(db, {
              conversationId: conv.id,
              wamid,
              msgType: 'template',
              body: renderCampaignBody(camp, vars, echoWording),
              status: 'sent',
              sentBy: `campaign:${camp.id}`,
            });
          }
        } catch (e: any) {
          console.error('[wa-broadcast] thread echo failed (send already recorded):', e?.message);
        }
      } else {
        const detail = String((res as any).detail || (res as any).reason || 'send failed').slice(0, 500);
        finishFail.run(sentAt, detail, r.id);
        result.failed++;
        if (result.errors.length < 10) result.errors.push({ phone: String(r.phone_e164), error: detail });

        // CIRCUIT BREAKER — the backstop behind both gates above. A cause the
        // gates cannot see (a credential revoked mid-run, a template edited at
        // Meta seconds ago, a WABA suspended) fails EVERY recipient the same
        // way. Without this the loop calmly records each failure and moves on,
        // burning the whole queue and the daily cap on a fault the first few
        // messages already proved. Consecutive-only: a run of individually bad
        // numbers is a different thing, and a single success resets it.
        if (++consecutiveFails >= CONSECUTIVE_FAIL_HALT) {
          const reason = `${consecutiveFails} sends in a row failed — the last error was: ${detail}. Halted rather than attempting the rest of the queue, because a failure this consistent is a fault of the campaign or the WhatsApp configuration, not of individual recipients.`;
          haltCampaign(db, camp.id, reason);
          result.campaigns_halted.push({ id: camp.id, reason });
          break;
        }
      }
    }
  }

  return result;
}
