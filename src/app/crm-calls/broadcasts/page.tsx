'use client';

/**
 * CRM — WhatsApp Broadcasts (/crm-calls/broadcasts). Management only.
 *
 * The operator face of the queued-broadcast engine (src/lib/wa-broadcast.ts):
 *
 *   LIST     — every campaign with its state, honest per-state counts
 *              (sent/delivered/read/replied AND capped/failed/skipped) and the
 *              cost line (estimate captured at start → actual so far).
 *   WIZARD   — audience builder (all guests / lapsed window / regulars /
 *              birthday month / loyalty tier / pasted numbers) → LIVE preview
 *              with every exclusion itemised and why → approved-template picker
 *              with variable mapping and a rendered sample for a real guest →
 *              cost line → explicit confirmation, TYPED above the threshold.
 *   DETAIL   — live progress under the throttle, pause/resume/cancel (take
 *              effect within one message), per-recipient report with state
 *              filters, wamids, timestamps and the provider's error text.
 *   CONSENT  — the marketing opt-out register: look a number up, see the
 *              audit history, and the ONLY door back in after a STOP
 *              (inbound re-opt-in keywords are deliberately not honoured).
 *
 * SENDING IS ALWAYS A DELIBERATE ACT. Creating a campaign writes a draft;
 * starting one needs confirm + an expected-count the server re-checks (409 if
 * the list moved); delivery then happens from the scheduler-driven drain,
 * throttled, with consent/cooldown/daily-cap re-checked per message. Nothing
 * on this page sends on mount, on poll, or on tab change.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { formatPhone } from '@/lib/ct/phone';
import {
  Megaphone, Send, AlertCircle, Loader2, RefreshCw, CheckCircle, XCircle,
  ChevronLeft, ShieldAlert, Info, Trash2, MessageSquare, Users, Pause, Play,
  Ban, IndianRupee, Search, ShieldOff, ShieldCheck, Clock, FileText, Plus, Minus,
} from 'lucide-react';

/* ───────────────────────── types (mirror the APIs) ───────────────────────── */

interface Settings {
  enabled: boolean;
  msgs_per_min: number;
  cooldown_days: number;
  daily_cap: number;
  cost_per_msg: number;
  confirm_threshold: number;
}

interface Counts {
  queued: number; sending: number; sent: number; delivered: number; read: number;
  replied: number; failed: number; capped: number;
  skipped_optout: number; skipped_cooldown: number; cancelled: number;
  total: number; sent_total: number;
}

interface Cost { rate: number; estimate: number; actual: number }

interface AudienceMeta {
  kind?: string; days?: number; include_never?: boolean; visits?: number;
  month?: number; tier?: string; phones?: string[];
  resolved?: { total_candidates: number; no_phone: number; deduped: number; queued: number };
}

interface Campaign {
  id: string; name: string; template_name: string; language: string;
  param_order: string[]; preview_body: string; audience: AudienceMeta;
  state: 'draft' | 'scheduled' | 'sending' | 'paused' | 'done' | 'cancelled';
  throttle_per_min: number; cost_rate: number; cost_estimate: number;
  started_at: string | null; finished_at: string | null;
  created_by: string; created_at: string;
  /** Why the DRAIN stopped this campaign — an unapproved or wrong-category
   *  template, or the consecutive-failure breaker. Written by haltCampaign()
   *  and empty for a pause a person asked for. */
  halt_reason?: string;
  counts: Counts; unconfirmed: number; cost: Cost;
}

interface Tpl {
  id: string; name: string; category: string; language: string; body: string;
  provider_template_name: string; provider_language: string; param_order: string;
  send_as_template: number;
  /* Meta lifecycle — absent on a DB whose boot migration has not run yet, which
   * is why every read below is defensive. '' means "not managed by the
   * lifecycle": a local free-form row, exactly as before this existed. */
  meta_status?: string;
  meta_category?: string;
  meta_rejected_reason?: string;
  var_spec?: string;
  /** Raw JSON of Meta's components — the only source of header/footer/buttons. */
  meta_components?: string;
}

interface ListResp {
  campaigns?: Campaign[];
  flag?: { key: string; enabled: boolean };
  settings?: Settings;
  templates?: Tpl[];
  venue?: string;
  wa?: { configured: boolean };
  /** Empty = Meta's template list has never been pulled, so no status here is
   *  verified and the server's create gate stays permissive. */
  templates_synced_at?: string;
  can_configure?: boolean;
  error?: string;
}

interface Preview {
  total_candidates: number;
  queued: number;
  eligible_now: number;
  excluded: { no_phone: number; deduped: number; opted_out: number; cooldown: number };
  sample: Array<{ name: string; phone_e164: string }>;
  cost: { rate: number; estimate: number };
  note: string;
}

interface RecipRow {
  id: string; guest_id: string | null; phone_e164: string; phone_key: string; name: string;
  state: string; wamid: string | null; error_detail: string;
  queued_at: string; sent_at: string | null; delivered_at: string | null;
  read_at: string | null; replied_at: string | null; failed_at: string | null;
}

interface ConsentRow {
  phone_key: string; status: 'opted_out' | 'opted_in';
  source: string; detail: string; changed_by: string;
  /** Standing rows carry changed_at; audit-log rows carry created_at. */
  changed_at?: string; created_at?: string;
}

/* ───────────────────────── helpers ───────────────────────── */

const money = (n: number) => `₹${(Math.round((n || 0) * 100) / 100).toLocaleString('en-IN')}`;

function errMsg(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/**
 * THE SERVER BROKE AND DID NOT SAY WHY.
 *
 * Every call here reads `j.error` first — the API's own plain sentence, which on
 * this screen is usually the whole refusal (a blank count, a cooldown, an
 * acknowledgement that has not been given). This is only the fallback for a
 * response carrying no readable error at all, where the operator used to be shown
 * the literal words "HTTP 500". The status code goes to the console for us.
 *
 * It does not claim "nothing was saved" or "nothing was sent": the same fallback
 * covers starting a campaign, and this screen cannot know whether the start landed
 * before the response broke. Telling him to look is honest; telling him it is fine
 * is the kind of claim this module has been cleaned of.
 */
function serverTrouble(status: number, what: string, opts?: { short?: boolean }): string {
  console.error(`[Broadcasts] ${what} failed with HTTP ${status}`);
  return opts?.short
    ? 'something went wrong at our end.'
    : 'Something went wrong at our end. Reload this page to see where things stand, then try again.';
}

/** Server timestamps are UTC 'YYYY-MM-DD HH:MM:SS' — render in IST. */
function istDateTime(s: string | null | undefined): string {
  if (!s) return '—';
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? s.replace(' ', 'T') + 'Z' : s;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

/**
 * A BROADCAST IS MARKETING. Meta approves a template INTO a category and will
 * not deliver a marketing send from a UTILITY or AUTHENTICATION one — for every
 * recipient, identically. Mirrored from BROADCAST_CATEGORY in lib/wa-broadcast.
 */
const BROADCAST_CATEGORY = 'MARKETING';

/** Meta's own category for a row, uppercase. '' = never recorded here. */
function metaCategoryOf(t: Tpl | undefined): string {
  return String(t?.meta_category || '').trim().toUpperCase();
}

const MANAGED_STATUSES = ['draft', 'pending', 'approved', 'rejected', 'paused', 'disabled', 'unknown_at_meta'];

interface TplState {
  /**
   * Would the SERVER accept a campaign on this template? This is the ONLY
   * thing that may be called "cannot be used": ok:false means the create route
   * answers 409 and the drain would halt, both provably.
   */
  ok: boolean;
  /** Does the picker OFFER it? `ok`, and named the same here as at Meta. */
  offer: boolean;
  /** Positively known approved AND marketing — everything Meta could confirm. */
  proven: boolean;
  verified: boolean;
  /** A full sentence, safe to show verbatim. Empty when nothing is wrong. */
  reason: string;
  /** Row badge — a few words an owner can read at a glance. */
  short: string;
  /**
   * Offered, but on incomplete evidence — the honest sentence to put beside it
   * BEFORE a cost is confirmed, not in a warning list afterwards. Empty when
   * everything about this template is proven.
   */
  caveat: string;
}

interface HeaderVerdict { ok: boolean; short: string; reason: string }

/**
 * CLIENT MIRROR of templateHeaderFill() in lib/wa-broadcast.
 *
 * The drain sends BODY parameters and nothing else, so a template whose HEADER
 * needs something — a media file, or a value for a {{n}} in the heading — is
 * refused by Meta for EVERY recipient. That is a fact about the template, not
 * about its lifecycle position, so it is asked in every branch below. No
 * components recorded → no evidence → no refusal, exactly as on the server.
 */
function headerFill(t: Tpl | undefined): HeaderVerdict {
  const ok: HeaderVerdict = { ok: true, short: '', reason: '' };
  if (!t) return ok;
  const parts = metaComponents(t);
  if (!parts.hasComponents || !parts.hasHeader) return ok;

  if (parts.headerKind && parts.headerKind !== 'TEXT') {
    const kind = parts.headerKind.toLowerCase();
    return {
      ok: false,
      short: `needs ${'aeiou'.includes(kind[0]) ? 'an' : 'a'} ${kind} — a broadcast has none to send`,
      reason: `"${t.name}" was approved with ${'aeiou'.includes(kind[0]) ? 'an' : 'a'} ${kind} heading, so Meta expects ${'aeiou'.includes(kind[0]) ? 'an' : 'a'} ${kind} attached to every message sent from it. A broadcast sends message text only and has no file to attach, so Meta would refuse it for every guest on the list, not just some. Pick a template whose heading is fixed text, or has no heading at all.`,
    };
  }
  if (/\{\{\s*[^{}]*?\s*\}\}/.test(parts.header)) {
    return {
      ok: false,
      short: 'a blank in its heading — a broadcast cannot fill it',
      reason: `"${t.name}" has a blank in its heading ("${parts.header.trim()}"), and Meta requires a value for it on every message. A broadcast fills blanks in the message body only, so Meta would refuse it for every guest on the list, not just some. Pick a template whose heading is fixed text.`,
    };
  }
  return ok;
}

/**
 * CLIENT MIRROR of the NAME half of paramCheckFor() — can this rail fill the
 * blanks this template has?
 *
 * A broadcast knows three things and no others: the guest's name, your venue
 * name, the guest's phone number. A template whose wording asks for anything
 * else — {{day}}, {{open_time}}, {{answered_pct}} — cannot be sent honestly
 * from here, and this is the one failure Meta does NOT catch for us: the number
 * of blanks is right, so every message is accepted, delivered and charged, and
 * every guest reads a sentence with the wrong word in it.
 *
 * Asked in EVERY branch, like the heading, because it is a fact about the
 * template's wording rather than about its position in Meta's lifecycle. Only
 * where the blanks are actually established (blankNeed known) — nothing is
 * refused on a guess.
 */
function fillVerdict(t: Tpl | undefined): HeaderVerdict {
  const ok: HeaderVerdict = { ok: true, short: '', reason: '' };
  if (!t) return ok;
  const need = blankNeed(t);
  // HOW MANY may be unsettled while WHAT THEY MEAN is not: a row whose two
  // records disagree still plainly says {{date}} and {{content}} in its saved
  // wording, and this rail can fill neither. Same rule on the server.
  const census = bodyBlankCensus(String(t.body || ''));
  const base = need.known ? need.names : [...Array(census.positional).fill(''), ...census.named];
  // THE WORDING OUTRANKS THE VARIABLE LIST ABOUT MEANING — the same correction
  // paramCheckFor() makes on the server. blankNeed() answers `names` from the
  // stored variable list whenever it agrees on the COUNT, which is right for
  // counting and wrong for meaning: a row whose wording says {{event_name}}
  // while its list says ["name","name","venue"] looked entirely fillable.
  const meanings = blankMeanings(t, base.length);
  const names = base.map((n, i) => (meanings[i]?.authoritative && meanings[i].name) || String(n ?? ''));
  const cannot = unfillableBlanks(names);
  if (!cannot.length) return ok;
  const list = cannot.map(x => `“${x.name}”`).join(', ');
  const only = "the guest's name, your venue name, or their phone number";
  const many = cannot.length !== 1;
  // Meta returns a wording with NUMBERED blanks, so once a template is synced
  // the name shown here comes from the copy saved in this app. Say so, or an
  // owner who thinks the name is wrong refreshes the list forever.
  const where = need.known && need.namesLocal
    ? ` Meta returns this template's wording with numbered blanks, so ${many ? 'those names come' : 'that name comes'} from the copy saved here — correct it on Settings → Integrations → WhatsApp → Templates if it is out of date.`
    : '';
  return {
    ok: false,
    short: many
      ? `blanks a broadcast cannot fill — ${list}`
      : `a blank a broadcast cannot fill — ${list}`,
    reason: `“${t.name}” has ${many ? 'blanks' : 'a blank'} a broadcast cannot fill: ${cannot.map(x => `blank ${x.position} (${`“${x.name}”`})`).join(', ')}. A broadcast can only ever put three things in a blank — ${only} — so it would put one of those there and send the wrong sentence to every guest on the list. WhatsApp would not stop it either: the NUMBER of blanks is right, so every message is accepted and charged. Pick a template whose blanks are only ${only}, or have this one re-written without ${many ? 'those blanks' : 'that blank'}.${where}`,
  };
}

/**
 * CLIENT MIRROR of templateSendability(…, {requireCategory:'MARKETING'}) in
 * lib/wa-template-authoring.ts — shown so an operator is not led into building a
 * 2,000-guest audience around a template the server will refuse.
 *
 * IT IS NOT THE GATE. The server re-checks at create AND on every drain pass;
 * this only decides what the picker offers and what it says about the rest.
 * The rule it mirrors, exactly (see sendabilityFrom for the argument):
 *   • the HEADING first, in every branch — a message whose heading needs a file
 *     to be attached, or something filled in, cannot be sent from here whatever
 *     WhatsApp's list says about it. That is about what this app can put on the
 *     wire, so it REFUSES;
 *   • the same for what goes in the gaps in the wording — a message that asks
 *     for a day or a percentage would be sent with the wrong words in it, which
 *     WhatsApp accepts and charges for. That REFUSES too;
 *   • a message written here and never sent to WhatsApp for approval REFUSES —
 *     it is this app's own record of an unfinished job, not WhatsApp's answer;
 *   • EVERYTHING WHATSAPP'S LIST SAYS — not on the list, never checked, on
 *     hold, turned down, approved as something else — is a NOTE, never a locked
 *     door. Checking the list must never take a message away from the owner.
 *
 * THIS SCREEN MUST NOT BE STRICTER THAN THE SERVER. A row it hides is a message
 * the server would have sent, and hiding it pushes the operator into the
 * hand-typed name box, which is how a wrong name reaches WhatsApp.
 *
 * `ok` AND `offer` NOW AGREE WITH THE SERVER, deliberately. An earlier version
 * offered only PROVEN templates, which sounds safe and is not: at a venue whose
 * template list has never been synced — the shipped state of every install —
 * NOTHING is proven, so the picker offered nothing and pushed the operator into
 * the hand-typed name field, which is precisely how a wrong name reaches Meta.
 * So the picker offers everything the server would accept, and says on each row
 * exactly what is and is not proven about it (`proven`, `caveat`).
 */
function templateBlock(t: Tpl | undefined, syncedAt: string): TplState {
  const status = String(t?.meta_status || '').trim();
  const managed = MANAGED_STATUSES.includes(status);

  // THE HEADER, ASKED FIRST AND IN EVERY BRANCH. It is evidence Meta itself
  // gave us about the template's shape, and it refuses a campaign on its own —
  // an approved MARKETING template with an IMAGE heading is exactly as unusable
  // as an unapproved one, and used to be offered as "approved · marketing".
  const hdr = headerFill(t);
  if (t && !hdr.ok) {
    return { ok: false, offer: false, proven: false, verified: true, short: hdr.short, reason: hdr.reason, caveat: '' };
  }

  // THE BLANKS, ASKED THE SAME WAY AND FOR THE SAME REASON. A template whose
  // wording asks for a day, an opening time or a percentage is as unusable from
  // here as one with an image heading — and it is worse, because Meta accepts
  // it and delivers the wrong sentence rather than refusing. The create route
  // answers 409 on it, so "cannot be used for a broadcast" is a fact here.
  const fill = fillVerdict(t);
  if (t && !fill.ok) {
    return { ok: false, offer: false, proven: false, verified: true, short: fill.short, reason: fill.reason, caveat: '' };
  }

  if (t && managed) {
    if (status === 'approved') {
      const cat = metaCategoryOf(t);
      if (cat && cat !== BROADCAST_CATEGORY) {
        /* APPROVED, BUT AS SOMETHING ELSE — a note, not a locked door, and for
         * the same reason as the rest: it is WhatsApp's answer about state, an
         * answer read off the wrong Business Account gets it wrong for every
         * message at once, and being wrong the other way costs a send WhatsApp
         * refuses — nothing delivered, nothing charged. Mirrors the server. */
        return {
          ok: true, offer: true, proven: false, verified: true, reason: '',
          short: `approved as ${cat.toLowerCase()}, not as an offer`,
          caveat: `WhatsApp has approved "${t.name}", but as ${cat.toLowerCase()} rather than marketing. An offer sent to your guest list counts as marketing, and WhatsApp only delivers those from a message approved as marketing — so this one may be turned down for everyone on the list. If it is, no message goes out, no guest is contacted and nothing is charged. Use a message approved as marketing, or have this one approved again as marketing.`,
        };
      }
      if (!cat) {
        // Approved, but nothing here recorded WHICH category. The server ALLOWS
        // it (there is no evidence against it) and warns — so the picker offers
        // it and carries the same warning, rather than hiding a template the
        // server would happily accept behind a "cannot be used" heading.
        return {
          ok: true, offer: true, proven: false, verified: true,
          short: 'approved · category not recorded',
          reason: '',
          caveat: `Meta has approved "${t.name}", but its category was never recorded here, so nothing can confirm it is a marketing template. If it is not, Meta refuses every message in this campaign. An admin can record it by refreshing the template list on Settings → Integrations → WhatsApp → Templates.`,
        };
      }
      return { ok: true, offer: true, proven: true, verified: true, reason: '', caveat: '', short: 'approved · marketing' };
    }
    const detail = String(t.meta_rejected_reason || '').trim();

    /* NOT YET SENT FOR APPROVAL — the one status that still stops the campaign,
     * and the only one here that is not WhatsApp's answer. It is this app's own
     * record that the message was written here and never sent to WhatsApp, and
     * checking WhatsApp's list can never produce it. Mirrors the server. */
    if (status === 'draft') {
      return {
        ok: false, offer: false, proven: false, verified: true, caveat: '',
        short: 'not sent for approval yet',
        reason: `"${t.name}" has not been sent to WhatsApp for approval yet — it is still being written here. Send it for approval in Settings → Integrations → WhatsApp → Templates and wait for WhatsApp to approve it.`,
      };
    }

    /* EVERY OTHER THING WHATSAPP'S LIST SAYS IS A NOTE, NOT A LOCKED DOOR
     * (owner's ruling, 2026-09-15). Checking the list used to take messages
     * away — all 11 of this venue's, on one press — so what the list says is
     * now shown beside the message and the owner decides. The server does the
     * same; this screen must not be stricter than the door it mirrors, or it
     * hides a message the server would happily send. */
    const says: Record<string, string> = {
      pending: `WhatsApp has not finished reviewing "${t.name}", so it may not go out yet.`,
      rejected: `WhatsApp turned "${t.name}" down${detail ? ` — ${detail}` : ''}. Correct it and send it for approval again in Settings → Integrations → WhatsApp → Templates.`,
      paused: `WhatsApp has put "${t.name}" on hold${detail ? ` — ${detail}` : ''}, which usually happens when guests block or report messages.`,
      disabled: `WhatsApp has switched "${t.name}" off${detail ? ` — ${detail}` : ''}.`,
      unknown_at_meta: `"${t.name}" was sent to WhatsApp for approval from here, but it was not on the list the last time it was checked. It may have been deleted at WhatsApp, or approved on a different WhatsApp Business Account from the one set up here.`,
    };
    const shorts: Record<string, string> = {
      pending: 'WhatsApp is still reviewing it',
      rejected: 'WhatsApp turned it down',
      paused: 'WhatsApp has it on hold',
      disabled: 'WhatsApp switched it off',
      unknown_at_meta: 'not on WhatsApp’s list',
    };
    return {
      ok: true, offer: true, proven: false, verified: true, reason: '',
      short: shorts[status] || `WhatsApp lists it as "${status}"`,
      caveat: `${says[status] || `WhatsApp lists "${t.name}" as "${status}", which is not "approved".`} You can still send it — if WhatsApp turns it down, no message goes out, no guest is contacted and nothing is charged.`,
    };
  }
  if (!syncedAt) {
    // Meta's list has NEVER been pulled here, so nothing about this row is
    // proven either way — and the server says so too, by accepting it with an
    // "unverified" warning. The picker offers it and carries that warning to
    // the operator BEFORE the cost line, which is the only place it helps.
    return {
      ok: true, offer: true, proven: false, verified: false,
      short: 'not checked against Meta',
      reason: '',
      caveat: t
        ? `Meta's template list has never been checked from here, so nothing can confirm Meta has approved "${t.name}" — or in which category. If it is not an approved marketing template, every message in this campaign will fail. An admin can check by refreshing the list on Settings → Integrations → WhatsApp → Templates.`
        : '',
    };
  }
  /* CHECKED, AND THIS NAME WAS NOT ON THE LIST. This branch used to return
   * ok:false — the screen half of the single rule that took all 11 of this
   * venue's messages away the first time the list was checked. It is a note
   * now, exactly like the server's (owner's ruling, 2026-09-15). */
  return {
    ok: true, offer: true, proven: false, verified: true, short: 'not on WhatsApp’s list', reason: '',
    caveat: `The last check of WhatsApp's list (${istDateTime(syncedAt)}) did not find a message of this name. That can mean WhatsApp does not have it — or that it was approved after the check, or on a different WhatsApp Business Account from the one set up here. You can still send it: if WhatsApp turns it down, no message goes out, no guest is contacted and nothing is charged. Check the name, or check the list again in Settings → Integrations → WhatsApp → Templates.`,
  };
}

/**
 * CLIENT MIRROR of templatePlaceholders() — how many parameters Meta will
 * demand. Same evidence order (authored var_spec, then Meta's own components,
 * then the stored body), and the same refusal to guess: an unmanaged free-form
 * row proves nothing, so it returns null and nothing is claimed.
 */
function placeholderCount(t: Tpl | undefined): { count: number; names: string[]; authored?: boolean } | null {
  if (!t || !MANAGED_STATUSES.includes(String(t.meta_status || '').trim())) return null;
  try {
    const spec = JSON.parse(String(t.var_spec || '[]'));
    if (Array.isArray(spec) && spec.length) {
      /* NAMES BY `index`, NOT BY ARRAY ORDER — the same rule as the server's
       * templatePlaceholders() and blankMeanings(), and as
       * paramOrderFromVarSpec(), which sorts before deriving the stored variable
       * list. This reader alone did not, and it is the one that seeds the wizard:
       * MEASURED on a row the create route accepted with var_spec
       * [{index:2,venue},{index:1,name}] — this screen offered ["venue","name"]
       * as the DEFAULT mapping and labelled blank 1 "venue", while the server's
       * own check refused that mapping and said blank 1 is "name". First use of
       * such a template was a guaranteed false refusal with the screen and the
       * refusal contradicting each other.
       *
       * Indices that are not a clean 1..n permutation say nothing trustworthy
       * about position, so the names go quiet (the slots stay, unnamed) rather
       * than being guessed from array order — `authored` already means an empty
       * name here is a deliberate "no evidence", and an unnamed blank is one the
       * real sentence gets read for. */
      const idx = spec.map((v: { index?: unknown }) => Number(v?.index));
      const byIndex = idx.every((i: number) => Number.isInteger(i) && i >= 1 && i <= spec.length)
        && new Set(idx).size === spec.length;
      const names: string[] = Array.from({ length: spec.length }, () => '');
      if (byIndex) {
        spec.forEach((v: { index?: unknown; name?: unknown }) => {
          names[Number(v?.index) - 1] = String(v?.name ?? '');
        });
      }
      // `authored` — this record names its blanks explicitly, so an empty name
      // in it is a deliberate "no evidence", never a gap to fill from elsewhere.
      return { count: spec.length, names, authored: true };
    }
  } catch { /* fall through to Meta's components */ }
  // BOTH DIALECTS, on whichever wording is the evidence — the same correction
  // broadcastBlanks() applies on the server. maxBlank() alone sees {{1}}-style
  // blanks only, so a MANAGED row whose approved body is written with names
  // ('Hi {{name}}, we miss you at {{venue}}!' — what a sync copies in) reported
  // "0 blanks", this step offered nothing to map, and the campaign left with no
  // parameters at all. A sync writes no var_spec, so that is the shape every
  // row here takes the first time anyone refreshes the template list.
  const comps = metaComponents(t);
  if (comps.hasBody) return widestCensus(comps.body);
  const body = String(t.body || '');
  if (!body) return null;
  return widestCensus(body);
}

/** One wording counted in both dialects, positions kept aligned (unnamed first). */
function widestCensus(text: string): { count: number; names: string[] } {
  const census = bodyBlankCensus(text);
  const positional = Math.max(census.positional, maxBlank(text));
  return {
    count: Math.max(positional + census.named.length, maxBlank(text)),
    names: [...Array(positional).fill(''), ...census.named],
  };
}

/** Highest positional blank in a body: 'Hi {{1}}, join {{3}}' → 3. */
function maxBlank(text: string): number {
  let max = 0;
  for (const m of String(text || '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)) max = Math.max(max, Number(m[1]));
  return max;
}

/** CLIENT MIRROR of bodyBlanks() in lib/wa-broadcast — both dialects counted. */
function bodyBlankCensus(text: string): { positional: number; named: string[]; count: number } {
  let positional = 0;
  const named: string[] = [];
  const seen = new Set<string>();
  for (const m of String(text || '').matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    const inner = String(m[1] ?? '').trim();
    if (!inner) continue;
    if (/^\d+$/.test(inner)) positional = Math.max(positional, Number(inner));
    else if (!seen.has(inner.toLowerCase())) { seen.add(inner.toLowerCase()); named.push(inner); }
  }
  return { positional, named, count: positional + named.length };
}

/**
 * HOW MANY BLANKS THIS TEMPLATE NEEDS — the client mirror of broadcastBlanks()
 * in lib/wa-broadcast, and the number this step must offer.
 *
 * placeholderCount() alone returns null for an UNMANAGED row, and this screen
 * read that null as "no blanks": picking ct_winback offered nothing to map and
 * built a campaign that sent ZERO parameters, where the win-back rail in this
 * same app sends two. Meta refuses a short parameter list for every recipient
 * identically, so the whole audience burnt after the cost was confirmed.
 *
 * So when the lifecycle knows nothing, the two records a never-synced row DOES
 * hold are asked, and trusted only when they agree: the stored `param_order`
 * (what this app's other rails send for this very template) and the saved
 * wording's own blanks. Disagreement is not a number — it is "this app cannot
 * tell", and the step says so and refuses rather than sending bare.
 */
interface BlankNeed {
  known: boolean; count: number; names: string[];
  /** Meta settled the count and this screen supplied the names — see withLocalNames(). */
  namesLocal: boolean;
  reason: string;
}

/** The stored variable list, position-aligned, blanks dropped. */
function storedOrder(t: Tpl | undefined): string[] {
  try {
    const v = JSON.parse(String(t?.param_order || '[]'));
    return Array.isArray(v) ? v.map(x => String(x ?? '').trim()).filter(Boolean) : [];
  } catch { return []; }
}

/**
 * CLIENT MIRROR of withLocalNames() in lib/wa-broadcast — what each position
 * MEANS, where the lifecycle answered only how many.
 *
 * Meta hands a body back with NUMBERED blanks ('…tables free at {{2}} on
 * {{3}}'), so after a "Refresh templates" a synced row has the right count and
 * no names at all — and this screen then had nothing to refuse on, mapped the
 * venue name into {{day}} by position, and every guest read "tables free at
 * AKAN on AKAN" with Meta accepting and charging for all of it.
 *
 * The saved wording and the stored variable list are this app's own records of
 * what each position means. Read ONLY at the lifecycle's own count — a record
 * of a different length is a different shape of the template, aligned with
 * nothing — and the wording is preferred, because the preview is built from it.
 */
function withLocalNames(t: Tpl | undefined, count: number, names: readonly string[]): { names: string[]; local: boolean } {
  const out = Array.from({ length: count }, (_, i) => String(names[i] ?? '').trim());
  if (!t || !out.some(n => !n)) return { names: out, local: false };

  const census = bodyBlankCensus(String(t.body || ''));
  const fromBody = census.count === count ? [...Array(census.positional).fill(''), ...census.named] : [];
  const stored = storedOrder(t);
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

function blankNeed(t: Tpl | undefined): BlankNeed {
  const none = (reason: string): BlankNeed => ({ known: false, count: 0, names: [], namesLocal: false, reason });
  if (!t) return none('No template chosen yet.');

  // NAMES STAY POSITION-ALIGNED — an unnamed blank keeps its slot ('') rather
  // than sliding its neighbours onto the wrong sentence.
  const ph = placeholderCount(t);
  if (ph) {
    const aligned = ph.names.slice(0, ph.count);
    // An AUTHORED var_spec decides for itself — see placeholderCount().
    const named = ph.authored ? { names: aligned, local: false } : withLocalNames(t, ph.count, aligned);
    return { known: true, count: ph.count, names: named.names, namesLocal: named.local, reason: '' };
  }

  const stored = storedOrder(t);

  const body = String(t.body || '');
  if (!body.trim()) {
    if (stored.length) return { known: true, count: stored.length, names: stored, namesLocal: false, reason: '' };
    return none(`Nothing saved here records the wording of "${t.name}" or the variables it takes, and Meta's template list has never been checked — so this screen cannot tell how many blanks Meta approved it with. Sending it with none would be refused for every guest on the list, not just some.`);
  }

  const census = bodyBlankCensus(body);
  if (stored.length === census.count) {
    return { known: true, count: census.count, names: stored, namesLocal: false, reason: '' };
  }

  const wording = census.count === 0
    ? 'its saved wording marks none'
    : `its saved wording marks ${census.count} (${[...census.named.map(n => `{{${n}}}`), ...(census.positional ? [`up to {{${census.positional}}}`] : [])].join(', ')})`;
  const list = stored.length ? `${stored.length} (${stored.map(s => `“${s}”`).join(', ')})` : 'none';
  return none(`This app holds two records of “${t.name}” and they disagree: its saved variable list has ${list}, but ${wording}. Until that is settled nothing here can say how many blanks Meta approved it with, and a campaign built on it could be refused for every guest on the list. Refresh the template list on Settings → Integrations → WhatsApp → Templates so Meta's own answer decides.`);
}

interface WaParts {
  header: string; headerKind: string; body: string; footer: string; buttons: string[];
  hasBody: boolean;
  /** Meta's components were readable and non-empty — i.e. there is evidence here. */
  hasComponents: boolean;
  /** A HEADER component was present (headerKind '' with this true = no header). */
  hasHeader: boolean;
}

/**
 * Meta's components for a template — the ONLY place a header, footer or buttons
 * exist. The local `body` column holds the body alone, so a preview built from
 * it shows an owner less than the guest will actually receive.
 */
function metaComponents(t: Tpl | undefined): WaParts {
  const out: WaParts = {
    header: '', headerKind: '', body: '', footer: '', buttons: [],
    hasBody: false, hasComponents: false, hasHeader: false,
  };
  if (!t) return out;
  let comps: unknown;
  try { comps = JSON.parse(String(t.meta_components || '[]')); } catch { return out; }
  if (!Array.isArray(comps) || !comps.length) return out;
  out.hasComponents = true;
  for (const raw of comps) {
    const c = raw as { type?: unknown; format?: unknown; text?: unknown; buttons?: unknown };
    const type = String(c?.type ?? '').toUpperCase();
    if (type === 'HEADER') {
      const fmt = String(c?.format ?? 'TEXT').trim().toUpperCase();
      out.hasHeader = true;
      out.headerKind = fmt;
      out.header = fmt === 'TEXT' ? String(c?.text ?? '') : '';
    } else if (type === 'BODY') {
      out.body = String(c?.text ?? '');
      out.hasBody = true;
    } else if (type === 'FOOTER') {
      out.footer = String(c?.text ?? '');
    } else if (type === 'BUTTONS' && Array.isArray(c?.buttons)) {
      out.buttons = (c.buttons as Array<{ text?: unknown }>).map(b => String(b?.text ?? '')).filter(Boolean);
    }
  }
  return out;
}

/** The body an owner should be shown: Meta's own, whenever we hold it. */
function bodyOf(t: Tpl | undefined): string {
  if (!t) return '';
  const comps = metaComponents(t);
  return comps.hasBody && comps.body ? comps.body : String(t.body || '');
}

/**
 * The sentence around one blank, so "what goes here?" is a question about the
 * message rather than about {{2}}. ~34 characters either side, ellipsed, with
 * whitespace flattened so a multi-line body still reads as one fragment.
 */
function blankContext(body: string, n: number, name?: string): { before: string; after: string; found: boolean } {
  const text = String(body || '');
  // Positional first ({{2}}), then the NAME this app's other rails put in this
  // position ({{venue}}) — a saved wording written with names would otherwise
  // find nothing and claim "the wording here does not show a {{2}}", about a
  // sentence the operator can plainly see has a blank in it.
  let m = text.match(new RegExp(`\\{\\{\\s*${n}\\s*\\}\\}`));
  if ((!m || m.index === undefined) && name && /^[a-z0-9_]+$/i.test(name)) {
    m = text.match(new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, 'i'));
  }
  if (!m || m.index === undefined) return { before: '', after: '', found: false };
  const start = m.index;
  const end = start + m[0].length;
  const from = Math.max(0, start - 34);
  const to = Math.min(text.length, end + 34);
  const flat = (s: string) => s.replace(/\s+/g, ' ');
  return {
    before: (from > 0 ? '…' : '') + flat(text.slice(from, start)),
    after: flat(text.slice(end, to)) + (to < text.length ? '…' : ''),
    found: true,
  };
}

/**
 * CLIENT MIRROR of blankVar() in lib/wa-broadcast — the broadcast variable a
 * blank's NAME asks for, or null when this rail has nothing to put there.
 * 'venue' is tested before 'name' because "venue_name" is a venue. An empty
 * name is no evidence, not a refusal.
 */
function blankVar(name: string): BVar | null {
  const n = String(name || '').trim();
  if (!n) return null;
  if (/venue|restaurant|outlet|hotel|cafe|brandname|brand_name|businessname|business_name/i.test(n)) return 'venue';
  if (/phone|mobile|whatsapp|msisdn/i.test(n)) return 'phone';
  return isPersonName(n) ? 'name' : null;
}

/**
 * CLIENT MIRROR of isPersonName()/nameWords() in lib/wa-broadcast.
 *
 * "name" as a bare substring is the least specific stem there is: it reads
 * {{event_name}}, {{dish_name}} and {{offer_name}} as the guest's name, and
 * putting the guest's name in one of those sends the wrong sentence to the
 * whole list at the right parameter count — accepted, delivered and charged.
 * So the name is read in WORDS, and only a person's name counts.
 */
const PERSON_WORDS = new Set(['guest', 'customer', 'client', 'patron', 'member', 'recipient', 'diner', 'person']);
const PERSON_QUALIFIER = new Set([...PERSON_WORDS, 'first', 'last', 'full', 'given', 'sur', 'display', 'preferred', 'the']);
const PERSON_JOINED = new Set([
  'name', 'fullname', 'firstname', 'lastname', 'givenname', 'surname', 'guestname',
  'customername', 'clientname', 'patronname', 'membername', 'recipientname', 'dinername',
]);
const NOT_A_PERSON = new Set([
  'count', 'total', 'number', 'no', 'qty', 'quantity', 'id', 'code', 'pct', 'percent',
  'amount', 'value', 'date', 'time', 'day', 'month', 'year', 'list', 'type', 'status',
]);

function nameWords(name: string): string[] {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isPersonName(raw: string): boolean {
  const w = nameWords(raw);
  if (!w.length) return false;
  if (w.some(x => NOT_A_PERSON.has(x))) return false;
  if (w.length === 1) return PERSON_JOINED.has(w[0]) || PERSON_WORDS.has(w[0]);
  if (w[w.length - 1] === 'name') return w.slice(0, -1).every(q => PERSON_QUALIFIER.has(q));
  return w.some(x => PERSON_WORDS.has(x));
}

/**
 * CLIENT MIRROR of unfillableBlanks() — the blanks this screen must refuse to
 * map. A broadcast holds three facts and no others, so a blank called {{day}}
 * or {{open_time}} has no value it can be given; the old first guess handed it
 * name/venue by position, the count then matched, and every guest on the list
 * was really sent "tables free at AKAN on AKAN".
 */
function unfillableBlanks(names: string[]): Array<{ position: number; name: string }> {
  const out: Array<{ position: number; name: string }> = [];
  (names || []).forEach((n, i) => {
    const nm = String(n || '').trim();
    if (nm && !blankVar(nm)) out.push({ position: i + 1, name: nm });
  });
  return out;
}

/**
 * CLIENT MIRROR of contradictedBlanks() in lib/wa-broadcast — the blanks this
 * campaign would fill with the wrong thing.
 *
 * THE SWAP. Change two of the dropdowns below and "Hi Rahul … your last visit
 * to AKAN" becomes "Hi AKAN … your last visit to Rahul". The number of blanks
 * is still right, so WhatsApp accepts every message, nothing fails, nothing
 * stops, and the whole list is charged for and put into a cooldown. It is the
 * one mistake on this screen that costs the full amount and shows no symptom.
 *
 * The template's author already said what belongs in each blank — he called it
 * {{name}} or {{venue}} — so where that disagrees with the mapping, the two
 * records of the same template contradict each other and this is not a guess
 * about what the operator meant. A blank with no name says nothing and is
 * skipped; the cost step shows the real sentence for those instead.
 */
function contradictedBlanks(
  names: readonly string[],
  slots: readonly string[],
): Array<{ position: number; name: string; asks: BVar; mapped: BVar }> {
  const out: Array<{ position: number; name: string; asks: BVar; mapped: BVar }> = [];
  (slots || []).forEach((raw, i) => {
    const mapped = String(raw || '').trim();
    if (!(BROADCAST_VARS as readonly string[]).includes(mapped)) return;
    const nm = String((names || [])[i] || '').trim();
    const asks = blankVar(nm);
    if (!asks || asks === mapped) return;
    out.push({ position: i + 1, name: nm, asks, mapped: mapped as BVar });
  });
  return out;
}

/**
 * A blank's answer BEFORE the operator has given one: read off the name the
 * template's author wrote into the sentence, and left UNSET when he wrote no
 * name at all.
 *
 * THE POSITIONAL FALLBACK IS GONE, and it is the single most dangerous line
 * this screen ever had. It said "blank 1 is the guest, blank 2 is the venue",
 * which is true of the templates this venue happens to own today and is a
 * coin-flip on any template adopted from Meta — Meta hands wordings back with
 * NUMBERED blanks, so nothing names them, and a wording like
 *
 *     Welcome to {{1}} — {{2}}, your table is ready.
 *
 * (venue first, guest second) was DEFAULTED to [guest, venue]: the swap, fully
 * formed, with the operator having chosen nothing and changed nothing. Every
 * check downstream then measured a mapping nobody had made.
 *
 * A blank nothing names is a QUESTION. It arrives unanswered, the step will not
 * continue until it is answered, and the answer is the operator's.
 */
function guessVar(name: string): Slot {
  return blankVar(name) ?? '';
}

/* ═══ CLIENT MIRROR of blankMeanings()/mappingVerdict() in lib/wa-broadcast ═══
 *
 * Every record this app holds about what each blank MEANS, strongest first, so
 * this screen refuses exactly what the server refuses and asks for a reading of
 * the real sentence exactly where the server asks for one.
 *
 * The old mirror asked only the two WORDINGS, which left the same two holes the
 * server had: a template ADOPTED from Meta comes back with a NUMBERED body in
 * both wordings — nothing named, nothing refused, and the by-position first
 * guess above IS the swap — while its var_spec and its stored variable list,
 * sitting in the same row, say what each position means.
 */
type BEvidence = 'meta_named' | 'var_spec' | 'saved_wording' | 'stored_order' | 'none';

interface BMeaning {
  position: number; name: string; asks: BVar | null;
  evidence: BEvidence;
  /** Strong enough to REFUSE on. False → shown beside the real sentence instead. */
  authoritative: boolean;
}

/** The stored variable list POSITION-ALIGNED (storedOrder() drops empties). */
function rawOrder(t: Tpl | undefined): string[] {
  try {
    const v = JSON.parse(String(t?.param_order || '[]'));
    return Array.isArray(v) ? v.map(x => String(x ?? '').trim()) : [];
  } catch { return []; }
}

function blankMeanings(t: Tpl | undefined, count: number): BMeaning[] {
  const n = Math.max(0, count | 0);
  const out: BMeaning[] = Array.from({ length: n }, (_, i) =>
    ({ position: i + 1, name: '', asks: null, evidence: 'none' as BEvidence, authoritative: false }));
  if (!n || !t) return out;

  const aligned = (text: string) => {
    const c = bodyBlankCensus(text);
    return c.count === n ? [...Array(c.positional).fill(''), ...c.named] as string[] : [];
  };

  const comps = metaComponents(t);
  const metaBody = comps.hasBody ? comps.body : '';
  const metaNames = aligned(metaBody);
  // Meta answered with a wording of exactly this shape and named none of it —
  // so a local copy that DOES name them may simply be out of date, and a hard
  // refusal on it would refuse the mapping that is right for Meta's wording.
  // …and the copy saved here is not the SAME sentence. A sync writes Meta's
  // numbered body over a local named one, so the two are usually one wording in
  // two dialects — the local names then line up with Meta's numbers and are as
  // good as Meta's own. Only a genuinely different wording may be stale.
  /* THE BLANK MARK IS \u0000, NOT A SPACE — the server's wordingSkeleton() uses
   * exactly this and the two must agree or the screen and the gate disagree
   * about which wording is authoritative. The step after it collapses runs of
   * whitespace, so a space would give "Hi {{1}}!" and "Hi !" the same skeleton
   * and call two different wordings the same sentence. */
  const skeleton = (s: string) => String(s || '').replace(/\{\{\s*[^{}]*?\s*\}\}/g, '\u0000').replace(/\s+/g, ' ').trim();
  const sameWording = skeleton(metaBody) !== '' && skeleton(metaBody) === skeleton(String(t.body || ''));
  const metaNumbered = !!metaBody.trim() && metaNames.length === n
    && metaNames.every(x => !String(x || '').trim()) && !sameWording;

  /* var_spec IS READ BY ITS OWN index, NOT BY ARRAY ORDER — the same rule the
   * server uses (blankMeanings). Every other reader of this column sorts by
   * `index` before using it, so Meta's {{1}} is the entry whose index is 1
   * wherever it sits in the array; reading the array in order inverted the gate
   * on a spec written out of order. Indices that are not a clean 1..n
   * permutation say nothing about position, so this record goes SILENT rather
   * than falling back to array order — array order is a guess, and it inverts
   * against the stored variable list, which is always sorted by index. Same rule
   * as the server. */
  let specNames: string[] = [];
  try {
    const spec = JSON.parse(String(t.var_spec || '[]'));
    if (Array.isArray(spec) && spec.length === n) {
      const idx = spec.map((v: { index?: unknown }) => Number(v?.index));
      const byIndex = idx.every((i: number) => Number.isInteger(i) && i >= 1 && i <= n) && new Set(idx).size === n;
      if (byIndex) {
        const slotsOut: string[] = Array.from({ length: n }, () => '');
        spec.forEach((v: { index?: unknown; name?: unknown }) => {
          slotsOut[Number(v?.index) - 1] = String(v?.name ?? '').trim();
        });
        specNames = slotsOut;
      }
    }
  } catch { specNames = []; }

  const bodyNames = aligned(String(t.body || ''));
  const order = rawOrder(t);
  const orderNames = order.length === n ? order : [];

  const tiers: Array<[BEvidence, string[], boolean]> = [
    ['meta_named', metaNames, true],
    ['var_spec', specNames, true],
    ['saved_wording', bodyNames, !metaNumbered],
    ['stored_order', orderNames, false],
  ];
  for (let i = 0; i < n; i++) {
    for (const [evidence, names, authoritative] of tiers) {
      const nm = String(names[i] ?? '').trim();
      if (!nm) continue;
      out[i] = { position: i + 1, name: nm, asks: blankVar(nm), evidence, authoritative };
      break;
    }
  }
  return out;
}

interface MVerdict {
  meanings: BMeaning[];
  hard: Array<{ position: number; name: string; asks: BVar; mapped: BVar }>;
  soft: Array<{ position: number; name: string; asks: BVar; mapped: BVar }>;
  /** 0-based blanks no authoritative record agrees with. */
  unproven: number[];
  /** Two or more DIFFERENT variables mapped, so an order mistake is possible. */
  swappable: boolean;
  needsAck: boolean;
}

function mappingVerdict(meanings: BMeaning[], slots: readonly string[]): MVerdict {
  const hard: MVerdict['hard'] = [];
  const soft: MVerdict['soft'] = [];
  const unproven: number[] = [];
  slots.forEach((raw, i) => {
    const mapped = String(raw || '').trim();
    if (!(BROADCAST_VARS as readonly string[]).includes(mapped)) return;
    const m = meanings[i];
    const agrees = !!m && m.asks === mapped;
    if (m && m.asks && !agrees) {
      (m.authoritative ? hard : soft).push({ position: i + 1, name: m.name, asks: m.asks, mapped: mapped as BVar });
    }
    if (!(agrees && m?.authoritative)) unproven.push(i);
  });
  const distinct = new Set(slots.filter(v => (BROADCAST_VARS as readonly string[]).includes(v)));
  const swappable = distinct.size >= 2;
  /* NOT GATED ON `swappable` — see mappingVerdict() in lib/wa-broadcast. A
   * mapping that repeats one variable cannot be in the wrong ORDER, but it can
   * still put the wrong thing in every blank ("Hi Akan, thank you for visiting
   * Akan last week."), and that whole class used to pass with nothing asked. */
  return { meanings, hard, soft, unproven, swappable, needsAck: unproven.length > 0 || soft.length > 0 };
}

/* CLIENT MIRROR of wordingCues() — advisory only, never a refusal. Where a
 * blank is numbered there is nothing to refuse on, but the words right before
 * it still say something out loud: after "Hi" comes a person, after "at" comes
 * a place. Reported only where the sentence and the mapping disagree. */
const CUE_PERSON = /(?:\b(?:hi|hello|hey|dear|namaste|greetings)|\bbirthday|\bcongratulations)[\s,!:;.-]*$/i;
const CUE_PLACE = /(?:\bat|\bwelcome to|\bvisit to|\bback to|\bhere at|\bfrom)[\s,!:;.-]*$/i;

function wordingCues(body: string, slots: readonly string[]): string[] {
  const text = String(body || '');
  if (!text.trim()) return [];
  const census = bodyBlankCensus(text);
  const aligned: string[] = [...Array(census.positional).fill(''), ...census.named];
  const out: string[] = [];
  for (const m of text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    const inner = String(m[1] ?? '').trim();
    if (!inner) continue;
    const idx = /^\d+$/.test(inner)
      ? Number(inner) - 1
      : aligned.findIndex((nm, i) => i >= census.positional && nm.toLowerCase() === inner.toLowerCase());
    if (idx < 0 || idx >= slots.length) continue;
    const before = text.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0);
    const tail = before.trim().split(/\s+/).slice(-2).join(' ');
    const mapped = slots[idx];
    // WORD FOR WORD what wordingCues() says on the server — the screen and the
    // refusal must not describe the same fault in two different sentences.
    if (CUE_PERSON.test(before) && mapped !== 'name') {
      out.push(`Blank ${idx + 1} comes straight after “${tail}”, which usually introduces a person — but this campaign puts ${VAR_LABEL[mapped as BVar]?.toLowerCase() || mapped} there.`);
    } else if (CUE_PLACE.test(before) && mapped !== 'venue') {
      out.push(`Blank ${idx + 1} comes straight after “${tail}”, which usually introduces a place — but this campaign puts ${VAR_LABEL[mapped as BVar]?.toLowerCase() || mapped} there.`);
    }
  }
  return out;
}

/**
 * CLIENT MIRROR of proofSentence() — the exact string the server compares an
 * acknowledgement against, so a tick on this screen and the confirmation the
 * server demands are the same act rather than two that can drift apart.
 */
function proofSentence(body: string, slots: readonly string[], venue: string): string {
  if (!String(body || '').trim()) return '';
  const v = venue || 'your venue';
  return fillBlanksInOrder(
    body,
    slots.map(k => (k === 'venue' ? v
      : k === 'name' ? "[the guest's name]"
        : k === 'phone' ? "[the guest's phone number]" : `[${k || 'nothing chosen'}]`)),
    n => `[blank ${n} — nothing chosen]`,
  ).trim();
}

/** What a broadcast variable means to someone who runs a restaurant. */
const VAR_LABEL: Record<BVar, string> = {
  name: "The guest's name",
  venue: 'Your venue name',
  phone: "The guest's phone number",
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function audienceLabel(a: AudienceMeta | null | undefined): string {
  if (!a || !a.kind) return 'audience unknown';
  switch (a.kind) {
    case 'all_guests': return 'All guests';
    case 'winback': return `Lapsed ${a.days || 60}+ days${a.include_never ? ' (incl. never-visited)' : ''}`;
    case 'min_visits': return `Regulars — ${a.visits || 1}+ visits`;
    case 'birthday_month': return `${MONTHS[(a.month || 1) - 1]} birthdays`;
    case 'tier': return `${a.tier || ''} loyalty tier`;
    case 'phones': return `Pasted list (${a.phones?.length ?? a.resolved?.total_candidates ?? '?'} numbers)`;
    default: return a.kind;
  }
}

const BROADCAST_VARS = ['name', 'venue', 'phone'] as const;
type BVar = (typeof BROADCAST_VARS)[number];
/**
 * One blank's answer — or '' for a blank nobody has answered yet.
 *
 * The empty string is a real state, not a placeholder for one: a blank whose
 * own wording does not say what belongs in it starts here and stays here until
 * the operator says. See guessVar().
 */
type Slot = BVar | '';

/**
 * ONE WORDING, FILLED THE WAY WHATSAPP ACTUALLY FILLS IT — numbered blanks by
 * their number, then named blanks in the order they appear, and EVERY one of
 * them taking its value from this campaign's own mapping.
 *
 * THIS IS THE FIX FOR THE PREVIEW THAT LIED. The old renderer did a second
 * pass that replaced {{name}} with the guest's name and {{venue}} with the
 * venue name BY NAME — ignoring the mapping entirely. Every template this venue
 * owns is written with named blanks, so a campaign with the two blanks mapped
 * the wrong way round rendered the CORRECT sentence on screen, on the cost
 * dialog and in the chat history, while the wire carried the swapped one. The
 * preview did not merely fail to show the fault; it asserted the opposite, and
 * an operator checking his work carefully was shown a clean bill of health.
 *
 * WhatsApp is given a plain list of values in blank order and knows nothing
 * about their names, so blank order is the only truth there is — and it is now
 * the only thing this renders from.
 */
function fillBlanksInOrder(
  body: string,
  values: readonly string[],
  unmapped: (n: number) => string,
): string {
  const text = String(body || '');
  const census = bodyBlankCensus(text);
  const order: string[] = [...Array(census.positional).fill(''), ...census.named];
  const at = (i: number) => (i >= 0 && i < values.length ? String(values[i] ?? '') : unmapped(i + 1));
  return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole: string, raw: string) => {
    const inner = String(raw ?? '').trim();
    if (!inner) return whole;
    if (/^\d+$/.test(inner)) {
      const n = Number(inner);
      return n >= 1 && n <= census.positional ? at(n - 1) : whole;
    }
    const idx = order.findIndex((nm, i) => i >= census.positional && nm.toLowerCase() === inner.toLowerCase());
    return idx >= 0 ? at(idx) : whole;
  });
}

/**
 * The message exactly as a REAL guest receives it under THIS mapping.
 *
 * A blank nobody has answered yet ('' — see Slot) renders as the unanswered
 * marker rather than as an empty gap: the sentence must read as incomplete
 * while it IS incomplete, because a gap silently closes up and the wording
 * looks finished.
 */
function renderSample(body: string, slots: readonly string[], vars: Record<string, string>): string {
  return fillBlanksInOrder(
    body,
    slots.map((k, i) => (k ? (vars[k] ?? '') : `[blank ${i + 1} — nothing chosen]`)),
    n => `[blank ${n} — nothing chosen]`,
  );
}

const CAMP_STYLE: Record<string, string> = {
  draft: 'bg-[#EFEAE4] text-[#6B5744] border-[#DED3C6]',
  scheduled: 'bg-sky-50 text-sky-700 border-sky-200',
  sending: 'bg-amber-50 text-amber-800 border-amber-200',
  paused: 'bg-orange-50 text-orange-800 border-orange-200',
  done: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  cancelled: 'bg-red-50 text-red-700 border-red-200',
};

const REC_STATES = [
  'queued', 'sending', 'sent', 'delivered', 'read', 'replied',
  'failed', 'capped', 'skipped_optout', 'skipped_cooldown', 'cancelled',
] as const;

const REC_STYLE: Record<string, string> = {
  queued: 'bg-[#EFEAE4] text-[#6B5744] border-[#DED3C6]',
  sending: 'bg-amber-50 text-amber-800 border-amber-200',
  sent: 'bg-sky-50 text-sky-700 border-sky-200',
  delivered: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  read: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  replied: 'bg-violet-50 text-violet-700 border-violet-200',
  failed: 'bg-red-50 text-red-700 border-red-200',
  capped: 'bg-orange-50 text-orange-800 border-orange-200',
  skipped_optout: 'bg-red-50 text-red-600 border-red-100',
  skipped_cooldown: 'bg-[#FFF1E3] text-[#8a5a1f] border-[#F0D9BE]',
  cancelled: 'bg-[#EFEAE4] text-[#8B7355] border-[#DED3C6]',
};

const REC_LABEL: Record<string, string> = {
  queued: 'queued', sending: 'unconfirmed', sent: 'sent', delivered: 'delivered',
  read: 'read', replied: 'replied', failed: 'failed', capped: 'capped',
  skipped_optout: 'opted out', skipped_cooldown: 'cooldown', cancelled: 'cancelled',
};

/* ───────────────────────── page ───────────────────────── */

export default function BroadcastsPage() {
  const [tab, setTab] = useState<'campaigns' | 'consent'>('campaigns');
  const [data, setData] = useState<ListResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);

  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Campaign | null>(null);
  const [recips, setRecips] = useState<RecipRow[]>([]);
  const [recipFilter, setRecipFilter] = useState<string>('');
  const [showWizard, setShowWizard] = useState(false);

  const detailIdRef = useRef<string | null>(null);
  detailIdRef.current = detailId;

  // The recipient filter the poller should use — a ref so the 5s poll always
  // reads the CURRENT chip without re-arming the interval.
  const recipFilterRef = useRef('');
  recipFilterRef.current = recipFilter;

  const loadList = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      const res = await api('/api/crm-calls/broadcasts');
      const j: ListResp = await res.json();
      if (!res.ok) throw new Error(j.error || serverTrouble(res.status, 'loading the campaign list'));
      setData(j);
      // A SILENT refresh must never clear a message the operator has not read.
      // The 5s poll and the post-action reload both come through here, and
      // clearing unconditionally erased the server's refusal (an unapproved or
      // wrong-category template) milliseconds after it was set — leaving a
      // Start button that appeared to do nothing at all.
      if (!opts?.silent) setError('');
    } catch (e) {
      setError(errMsg(e, 'Could not load broadcasts'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (id: string, opts?: { silent?: boolean }) => {
    if (!opts?.silent) setBusy(true);
    try {
      const [dRes, rRes] = await Promise.all([
        api(`/api/crm-calls/broadcasts/${id}`),
        api(`/api/crm-calls/broadcasts/${id}/recipients${recipFilterRef.current ? `?state=${recipFilterRef.current}` : ''}`),
      ]);
      const d = await dRes.json();
      const r = await rRes.json();
      if (detailIdRef.current !== id) return;
      if (!dRes.ok) throw new Error(d.error || serverTrouble(dRes.status, 'loading the campaign'));
      setDetail({ ...d.campaign, counts: d.counts, unconfirmed: d.unconfirmed, cost: d.cost });
      if (rRes.ok) setRecips(Array.isArray(r.recipients) ? r.recipients : []);
      // Same rule as loadList: a silent reload does not speak for the operator.
      if (!opts?.silent) setError('');
    } catch (e) {
      if (detailIdRef.current === id && !opts?.silent) setError(errMsg(e, 'Could not load the campaign'));
    } finally {
      if (!opts?.silent) setBusy(false);
    }
  }, []);

  useEffect(() => { loadList(); }, [loadList]);

  useEffect(() => {
    if (!detailId) { setDetail(null); setRecips([]); setRecipFilter(''); return; }
    loadDetail(detailId);
  }, [detailId, loadDetail]);

  // Refetch recipients when the filter chip changes.
  useEffect(() => {
    if (detailId) loadDetail(detailId, { silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipFilter]);

  // Live progress: poll every 5s while the open campaign is actually moving.
  useEffect(() => {
    if (!detailId || !detail || (detail.state !== 'sending' && detail.counts.sending === 0)) return;
    const t = setInterval(() => {
      loadDetail(detailId, { silent: true });
      loadList({ silent: true });
    }, 5000);
    return () => clearInterval(t);
  }, [detailId, detail, loadDetail, loadList]);

  const doAction = useCallback(async (id: string, action: string, extra?: Record<string, unknown>) => {
    setBusy(true); setError(''); setNotice(''); setWarnings([]);
    try {
      const res = await api(`/api/crm-calls/broadcasts/${id}/action`, {
        method: 'POST', body: { action, ...(extra || {}) },
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || serverTrouble(res.status, `the "${action}" action`));
      if (Array.isArray(j.warnings) && j.warnings.length) setWarnings(j.warnings);
      if (j.note) setNotice(j.note);
      else setNotice(action === 'pause' ? 'Campaign paused — the drain stops within one message.'
        : action === 'resume' ? 'Campaign resumed.'
        : action === 'cancel' ? 'Campaign cancelled. Remaining queued guests will not be messaged.' : 'Done.');
      await loadDetail(id, { silent: true });
      await loadList({ silent: true });
      return true;
    } catch (e) {
      setError(errMsg(e, `Could not ${action}`));
      await loadDetail(id, { silent: true });
      return false;
    } finally {
      setBusy(false);
    }
  }, [loadDetail, loadList]);

  const deleteDraft = useCallback(async (id: string) => {
    if (!confirm('Discard this draft campaign? It has not messaged anyone.')) return;
    setBusy(true); setError('');
    try {
      const res = await api(`/api/crm-calls/broadcasts/${id}`, { method: 'DELETE' });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || serverTrouble(res.status, 'discarding the draft'));
      setDetailId(null);
      setNotice('Draft discarded.');
      await loadList({ silent: true });
    } catch (e) {
      setError(errMsg(e, 'Could not discard the draft'));
    } finally {
      setBusy(false);
    }
  }, [loadList]);

  /* ── render ── */

  if (loading && !data) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] p-6 animate-pulse">
        <div className="max-w-[100rem] mx-auto space-y-6">
          <div className="h-9 w-72 bg-[#FFF1E3] rounded-lg" />
          <div className="h-24 bg-white border border-[#E8D5C4] rounded-2xl" />
          <div className="bg-white border border-[#E8D5C4] rounded-2xl h-96" />
        </div>
      </div>
    );
  }

  const flagOn = !!data?.flag?.enabled;
  const waOk = !!data?.wa?.configured;
  const s = data?.settings;
  const campaigns = data?.campaigns || [];

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-[100rem] mx-auto px-3 sm:px-6 py-5 sm:py-6 space-y-4 sm:space-y-5">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold text-[#6B5744] uppercase tracking-wider">CRM · Call to Table</p>
            <h1 className="text-2xl sm:text-3xl font-bold mt-0.5 flex items-center gap-2">
              <Megaphone className="w-7 h-7 text-[#af4408]" /> WhatsApp Broadcasts
            </h1>
            <p className="text-sm text-[#6B5744] mt-1">
              Queued marketing campaigns — throttled, consent-checked on every message, and honest about what happened to each guest.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => (detailId ? loadDetail(detailId) : loadList({ silent: true }))}
              disabled={busy}
              className="flex items-center gap-2 px-3 py-2.5 bg-white border border-[#E0D0BE] hover:border-[#af4408] hover:bg-[#FFF1E3] text-[#6B5744] rounded-xl text-sm font-medium shadow-sm transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} /> Refresh
            </button>
            <button
              onClick={() => setShowWizard(true)}
              className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-xl text-sm font-semibold shadow-sm transition-colors"
            >
              <Megaphone className="w-4 h-4" /> New campaign
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 bg-white border border-[#E8D5C4] rounded-xl p-1 w-fit shadow-sm">
          {(['campaigns', 'consent'] as const).map(t => (
            <button
              key={t}
              onClick={() => { setTab(t); setDetailId(null); }}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
                tab === t ? 'bg-[#af4408] text-white' : 'text-[#6B5744] hover:bg-[#FFF1E3]'
              }`}
            >
              {t === 'campaigns' ? 'Campaigns' : 'Marketing consent'}
            </button>
          ))}
        </div>

        {/* Safety banner — the truth about whether anything can deliver */}
        <div className={`rounded-2xl border p-4 ${flagOn ? 'bg-amber-50 border-amber-200' : 'bg-white border-[#E8D5C4]'}`}>
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
            <div className="flex items-start gap-2.5">
              {flagOn ? <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" /> : <Info className="w-5 h-5 text-[#8B7355] shrink-0 mt-0.5" />}
              <div className="text-sm">
                <p className="font-semibold">
                  {flagOn ? 'Broadcast sending is ENABLED' : 'Broadcast sending is OFF'}
                </p>
                <p className="text-[#6B5744] mt-0.5">
                  {flagOn
                    ? 'Started campaigns drain from the queue — throttled, with consent, cooldown and the daily cap re-checked on every single message.'
                    : 'You can build, preview and even start campaigns; the queue will not move until an admin enables sending.'}
                  {' '}WhatsApp provider:{' '}
                  <span className={waOk ? 'text-emerald-700 font-medium' : 'text-red-700 font-medium'}>
                    {waOk ? 'configured' : 'not configured'}
                  </span>.
                </p>
                {s && (
                  <p className="text-xs text-[#8B7355] mt-1">
                    ~{s.msgs_per_min}/min · {s.cooldown_days}-day per-guest cooldown · {s.daily_cap > 0 ? `${s.daily_cap}/day cap` : 'no daily cap'} · {money(s.cost_per_msg)}/message · typed confirmation over {s.confirm_threshold} recipients
                  </p>
                )}
              </div>
            </div>
            {data?.can_configure ? (
              <a href="/settings/integrations/whatsapp" className="text-xs font-semibold text-[#af4408] hover:underline shrink-0">
                Broadcast settings →
              </a>
            ) : (
              <span className="text-xs text-[#8B7355] shrink-0">Only an admin can change these knobs</span>
            )}
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 p-4 bg-red-50 border border-red-200 rounded-xl">
            <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />
            <p className="text-sm text-red-700">{error}</p>
            <button onClick={() => setError('')} className="ml-auto text-red-700 text-xs underline shrink-0">dismiss</button>
          </div>
        )}
        {notice && (
          <div className="flex items-start gap-2 p-4 bg-emerald-50 border border-emerald-200 rounded-xl">
            <CheckCircle className="w-5 h-5 text-emerald-600 shrink-0" />
            <p className="text-sm text-emerald-800">{notice}</p>
            <button onClick={() => setNotice('')} className="ml-auto text-emerald-700 text-xs underline shrink-0">dismiss</button>
          </div>
        )}
        {warnings.map((w, i) => (
          <div key={i} className="flex items-start gap-2 p-4 bg-amber-50 border border-amber-200 rounded-xl">
            <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0" />
            <p className="text-sm text-amber-800">{w}</p>
          </div>
        ))}

        {/* ─── CAMPAIGNS ─── */}
        {tab === 'campaigns' && !detailId && (
          <CampaignList campaigns={campaigns} onOpen={id => setDetailId(id)} />
        )}

        {tab === 'campaigns' && detailId && detail && (
          <CampaignDetail
            campaign={detail}
            recips={recips}
            recipFilter={recipFilter}
            setRecipFilter={setRecipFilter}
            busy={busy}
            settings={s}
            venue={data?.venue || ''}
            tpl={(data?.templates || []).find(t => t.name === detail.template_name)}
            error={error}
            onBack={() => setDetailId(null)}
            onAction={doAction}
            onDelete={() => deleteDraft(detail.id)}
          />
        )}
        {tab === 'campaigns' && detailId && !detail && (
          <div className="bg-white border border-[#E8D5C4] rounded-2xl py-16 text-center">
            <Loader2 className="w-8 h-8 text-[#af4408] animate-spin mx-auto" />
          </div>
        )}

        {/* ─── CONSENT ─── */}
        {tab === 'consent' && <ConsentPanel />}
      </div>

      {showWizard && data && (
        <Wizard
          settings={data.settings!}
          templates={data.templates || []}
          syncedAt={data.templates_synced_at || ''}
          venue={data.venue || ''}
          canConfigure={!!data.can_configure}
          flagOn={flagOn}
          waOk={waOk}
          onClose={() => setShowWizard(false)}
          onDone={async (id, startedNote, warns) => {
            setShowWizard(false);
            setNotice(startedNote);
            setWarnings(warns);
            setTab('campaigns');
            setDetailId(id);
            await loadList({ silent: true });
          }}
        />
      )}
    </div>
  );
}

/* ───────────────────────── shared bits ───────────────────────── */

function Stat({ label, value, accent, sub }: { label: string; value: string; accent?: boolean; sub?: string }) {
  return (
    <div className={`rounded-xl border p-3 ${accent ? 'bg-[#FFF1E3] border-[#F0D9BE]' : 'bg-[#FFFBF6] border-[#EFE1D0]'}`}>
      <p className="text-[11px] uppercase tracking-wider text-[#8B7355]">{label}</p>
      <p className={`text-xl font-bold tabular-nums ${accent ? 'text-[#af4408]' : 'text-[#2D1B0E]'}`}>{value}</p>
      {sub && <p className="text-[11px] text-[#8B7355] mt-0.5">{sub}</p>}
    </div>
  );
}

function StateChip({ state }: { state: string }) {
  return (
    <span className={`inline-block px-2 py-0.5 rounded-lg border text-xs font-semibold ${CAMP_STYLE[state] || CAMP_STYLE.draft}`}>
      {state}
    </span>
  );
}

/** Stacked progress bar — every recipient lands in exactly one band. */
function ProgressBar({ counts }: { counts: Counts }) {
  const total = counts.total || 1;
  const bands: Array<[number, string, string]> = [
    [counts.sent_total, 'bg-emerald-500', 'left the building (sent/delivered/read/replied)'],
    [counts.sending, 'bg-amber-400', 'claimed, unconfirmed'],
    [counts.capped, 'bg-orange-400', 'capped by Meta limits'],
    [counts.failed, 'bg-red-500', 'failed'],
    [counts.skipped_optout + counts.skipped_cooldown, 'bg-[#C4B09A]', 'skipped (opt-out / cooldown)'],
    [counts.cancelled, 'bg-[#8B7355]', 'cancelled'],
  ];
  const processed = total - counts.queued;
  return (
    <div>
      <div className="flex h-3 w-full rounded-full overflow-hidden bg-[#F3EADF] border border-[#EFE1D0]">
        {bands.map(([n, cls, title], i) =>
          n > 0 ? <div key={i} className={cls} style={{ width: `${(n / total) * 100}%` }} title={`${n} ${title}`} /> : null,
        )}
      </div>
      <p className="text-[11px] text-[#8B7355] mt-1 tabular-nums">
        {processed} of {counts.total} processed · {counts.queued} still queued
      </p>
    </div>
  );
}

/* ───────────────────────── campaign list ───────────────────────── */

function CampaignList({ campaigns, onOpen }: { campaigns: Campaign[]; onOpen: (id: string) => void }) {
  if (campaigns.length === 0) {
    return (
      <div className="bg-white border border-[#E8D5C4] rounded-2xl py-16 text-center">
        <Megaphone className="w-10 h-10 text-[#D8C3A8] mx-auto mb-3" />
        <p className="text-[#6B5744] font-medium">No broadcast campaigns yet.</p>
        <p className="text-sm text-[#8B7355] mt-1">Press “New campaign” to build an audience and preview exactly who would hear from you.</p>
      </div>
    );
  }
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-[#FFF1E3] border-b border-[#E8D5C4]">
            <tr className="text-left text-[11px] uppercase tracking-wider text-[#6B5744]">
              <th className="px-3 py-3">Campaign</th>
              <th className="px-3 py-3">State</th>
              <th className="px-3 py-3 text-right">Recipients</th>
              <th className="px-3 py-3 text-right">Sent</th>
              <th className="px-3 py-3 text-right">Delivered</th>
              <th className="px-3 py-3 text-right">Read</th>
              <th className="px-3 py-3 text-right">Replied</th>
              <th className="px-3 py-3 text-right">Problems</th>
              <th className="px-3 py-3 text-right">Cost</th>
              <th className="px-3 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[#F0E4D6]">
            {campaigns.map(c => {
              const problems = c.counts.failed + c.counts.capped + c.unconfirmed;
              return (
                <tr key={c.id} className="hover:bg-[#FFFBF6] cursor-pointer" onClick={() => onOpen(c.id)}>
                  <td className="px-3 py-3">
                    <div className="font-medium">{c.name}</div>
                    <div className="text-xs text-[#8B7355]">
                      {audienceLabel(c.audience)} · template <code className="text-[#6B5744]">{c.template_name || '—'}</code> · {istDateTime(c.created_at)}
                    </div>
                  </td>
                  <td className="px-3 py-3"><StateChip state={c.state} /></td>
                  <td className="px-3 py-3 text-right tabular-nums">{c.counts.total}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{c.counts.sent_total}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{c.counts.delivered + c.counts.read + c.counts.replied}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{c.counts.read + c.counts.replied}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{c.counts.replied}</td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {problems > 0
                      ? <span className="text-red-700 font-medium">{problems}</span>
                      : <span className="text-[#B7A48C]">—</span>}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {c.state === 'draft'
                      ? <span className="text-[#B7A48C]">—</span>
                      : (
                        <div>
                          <div>{money(c.cost.actual)}</div>
                          <div className="text-[10px] text-[#8B7355]">est. {money(c.cost.estimate)}</div>
                        </div>
                      )}
                  </td>
                  <td className="px-3 py-3 text-right text-[#af4408] text-xs font-medium whitespace-nowrap">Open →</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ───────────────────────── campaign detail ───────────────────────── */

function CampaignDetail({
  campaign: c, recips, recipFilter, setRecipFilter, busy, settings, venue, tpl, error, onBack, onAction, onDelete,
}: {
  campaign: Campaign;
  recips: RecipRow[];
  recipFilter: string;
  setRecipFilter: (s: string) => void;
  busy: boolean;
  settings: Settings | undefined;
  /** This campaign's saved template row, so the start dialog can ask the SAME
   *  question the server asks: which of these blanks can anything vouch for? */
  tpl: Tpl | undefined;
  /** The venue name a venue blank is really filled with, so the start dialog
   *  can show the message as the guest reads it rather than describing it. */
  venue: string;
  /** The page-level failure text. The start dialog covers the page banner, so a
   *  refusal raised BY the dialog has to be readable inside it — otherwise the
   *  server's honest reason (an unapproved or wrong-category template) lands
   *  behind the modal and Start just appears to do nothing. */
  error: string;
  onBack: () => void;
  onAction: (id: string, action: string, extra?: Record<string, unknown>) => Promise<boolean>;
  onDelete: () => void;
}) {
  const [confirmStart, setConfirmStart] = useState(false);
  const counts = c.counts;
  const resolved = c.audience?.resolved;

  const chipsWithCounts = REC_STATES.map(st => ({ st, n: counts[st as keyof Counts] as number })).filter(x => x.n > 0);

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="flex items-center gap-1 text-sm text-[#af4408] hover:underline">
        <ChevronLeft className="w-4 h-4" /> All campaigns
      </button>

      <div className="bg-white border border-[#E8D5C4] rounded-2xl p-4 shadow-sm space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold flex items-center gap-2 flex-wrap">{c.name} <StateChip state={c.state} /></h2>
            <p className="text-sm text-[#6B5744] mt-0.5">
              {audienceLabel(c.audience)} · template <code>{c.template_name}</code> ({c.language})
              {c.param_order.length > 0 && <> · fills the blanks with {c.param_order.join(', ')}</>}
              {' '}· created by {c.created_by || 'unknown'}
            </p>
            <p className="text-xs text-[#8B7355] mt-0.5">
              {c.started_at ? `Started ${istDateTime(c.started_at)}` : 'Not started'}
              {c.finished_at ? ` · finished ${istDateTime(c.finished_at)}` : ''}
              {c.throttle_per_min > 0 ? ` · own throttle ${c.throttle_per_min}/min` : settings ? ` · global throttle ~${settings.msgs_per_min}/min` : ''}
            </p>
            {resolved && (
              <p className="text-xs text-[#8B7355] mt-0.5">
                Audience build: {resolved.total_candidates} candidate(s) → {resolved.queued} queued
                {resolved.no_phone > 0 && ` · ${resolved.no_phone} had no usable number`}
                {resolved.deduped > 0 && ` · ${resolved.deduped} duplicate number(s) collapsed`}
              </p>
            )}
            {/* THE HALT REASON. The drain stops a campaign rather than burning
                its queue on a fault every recipient would hit — an unapproved
                or wrong-category template, or a run of failures. That decision
                was being recorded and never shown: the operator saw "paused"
                and no cause, and Resume then refused for reasons equally
                invisible. */}
            {String(c.halt_reason || '').trim() && (
              <p className="text-xs text-red-800 bg-red-50 border border-red-200 rounded-xl p-2.5 mt-2 flex items-start gap-1.5 max-w-2xl">
                <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>{c.halt_reason}</span>
              </p>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {c.state === 'draft' && (
              <>
                <button onClick={onDelete} disabled={busy}
                        className="flex items-center gap-2 px-3 py-2.5 bg-white border border-[#E0D0BE] hover:border-red-400 hover:text-red-700 text-[#6B5744] rounded-xl text-sm font-medium disabled:opacity-50">
                  <Trash2 className="w-4 h-4" /> Discard draft
                </button>
                <button onClick={() => setConfirmStart(true)} disabled={busy || counts.queued === 0}
                        title={counts.queued === 0 ? 'Nothing queued to send' : ''}
                        className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-40 text-white rounded-xl text-sm font-semibold shadow-sm">
                  <Send className="w-4 h-4" /> Start campaign
                </button>
              </>
            )}
            {c.state === 'sending' && (
              <button onClick={() => onAction(c.id, 'pause')} disabled={busy}
                      className="flex items-center gap-2 px-4 py-2.5 bg-white border border-amber-300 hover:bg-amber-50 text-amber-800 rounded-xl text-sm font-semibold disabled:opacity-50">
                <Pause className="w-4 h-4" /> Pause
              </button>
            )}
            {c.state === 'paused' && (
              <button onClick={() => onAction(c.id, 'resume')} disabled={busy}
                      className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-xl text-sm font-semibold disabled:opacity-50">
                <Play className="w-4 h-4" /> Resume
              </button>
            )}
            {['sending', 'paused', 'scheduled'].includes(c.state) && (
              <button
                onClick={() => { if (confirm(`Cancel this campaign? ${counts.queued} queued guest(s) will NOT be messaged. Messages already sent cannot be recalled.`)) onAction(c.id, 'cancel'); }}
                disabled={busy}
                className="flex items-center gap-2 px-3 py-2.5 bg-white border border-[#E0D0BE] hover:border-red-400 hover:text-red-700 text-[#6B5744] rounded-xl text-sm font-medium disabled:opacity-50">
                <Ban className="w-4 h-4" /> Cancel
              </button>
            )}
          </div>
        </div>

        {(c.state === 'sending' || c.state === 'paused' || counts.total > counts.queued) && (
          <ProgressBar counts={counts} />
        )}

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <Stat label="Recipients" value={String(counts.total)} />
          <Stat label="Sent" value={String(counts.sent_total)} accent />
          <Stat label="Delivered" value={String(counts.delivered + counts.read + counts.replied)} />
          <Stat label="Read" value={String(counts.read + counts.replied)} />
          <Stat label="Replied" value={String(counts.replied)} />
          {c.state === 'draft'
            ? <Stat label="Est. cost" value={settings ? money(counts.queued * settings.cost_per_msg) : '—'} sub={settings ? `${counts.queued} × ${money(settings.cost_per_msg)}` : undefined} />
            : <Stat label="Cost so far" value={money(c.cost.actual)} sub={`estimated ${money(c.cost.estimate)} @ ${money(c.cost.rate)}/msg`} />}
        </div>

        {(counts.failed > 0 || counts.capped > 0 || counts.skipped_optout > 0 || counts.skipped_cooldown > 0) && (
          <div className="text-xs text-[#6B5744] bg-[#FFFBF6] border border-[#EFE1D0] rounded-xl p-3 space-y-1">
            <p className="font-semibold text-[#2D1B0E]">Not everyone was messaged — and that is the point:</p>
            {counts.skipped_optout > 0 && <p>· <strong>{counts.skipped_optout}</strong> skipped — opted out of marketing (STOP or manual). Never messaged by any campaign until manually opted back in.</p>}
            {counts.skipped_cooldown > 0 && <p>· <strong>{counts.skipped_cooldown}</strong> skipped — already got a marketing message inside the cooldown window, from any campaign.</p>}
            {counts.capped > 0 && <p>· <strong>{counts.capped}</strong> capped — Meta refused for rate/limit reasons (per-row error text below). These guests were NOT charged for.</p>}
            {counts.failed > 0 && <p>· <strong>{counts.failed}</strong> failed — the provider rejected the send; the exact error is on each row below.</p>}
          </div>
        )}

        {c.unconfirmed > 0 && c.state !== 'sending' && (
          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            {c.unconfirmed} message(s) were claimed but never confirmed (the provider call was interrupted mid-send). They are deliberately
            NOT retried automatically — a retry could double-message the guest. Check the provider log before deciding anything about them.
          </p>
        )}
      </div>

      {/* Recipient report */}
      <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm overflow-hidden">
        <div className="p-3 border-b border-[#F0E4D6] flex items-center gap-1.5 flex-wrap">
          <button
            onClick={() => setRecipFilter('')}
            className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-colors ${!recipFilter ? 'bg-[#af4408] text-white border-[#8a3506]' : 'bg-white text-[#6B5744] border-[#E0D0BE] hover:bg-[#FFF1E3]'}`}
          >
            All {counts.total}
          </button>
          {chipsWithCounts.map(({ st, n }) => (
            <button
              key={st}
              onClick={() => setRecipFilter(recipFilter === st ? '' : st)}
              className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-colors ${recipFilter === st ? 'bg-[#af4408] text-white border-[#8a3506]' : `${REC_STYLE[st]} hover:opacity-80`}`}
            >
              {REC_LABEL[st]} {n}
            </button>
          ))}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-[#FFF1E3] border-b border-[#E8D5C4]">
              <tr className="text-left text-[11px] uppercase tracking-wider text-[#6B5744]">
                <th className="px-3 py-2.5">Guest</th>
                <th className="px-3 py-2.5">State</th>
                <th className="px-3 py-2.5">Sent</th>
                <th className="px-3 py-2.5">Delivered</th>
                <th className="px-3 py-2.5">Read</th>
                <th className="px-3 py-2.5">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F0E4D6]">
              {recips.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-10 text-center text-sm text-[#8B7355]">
                  {recipFilter ? `No recipients in state “${REC_LABEL[recipFilter] || recipFilter}”.` : 'No recipients.'}
                </td></tr>
              )}
              {recips.map(r => (
                <tr key={r.id} className="hover:bg-[#FFFBF6]">
                  <td className="px-3 py-2.5">
                    <div className="font-medium">{r.name || 'Unnamed guest'}</div>
                    <div className="text-xs text-[#8B7355]">{formatPhone(r.phone_e164) || r.phone_e164}</div>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`inline-block px-2 py-0.5 rounded-lg border text-xs font-semibold ${REC_STYLE[r.state] || REC_STYLE.queued}`}>
                      {REC_LABEL[r.state] || r.state}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-[#6B5744] whitespace-nowrap">{istDateTime(r.sent_at)}</td>
                  <td className="px-3 py-2.5 text-xs text-[#6B5744] whitespace-nowrap">{istDateTime(r.delivered_at)}</td>
                  <td className="px-3 py-2.5 text-xs text-[#6B5744] whitespace-nowrap">{istDateTime(r.replied_at || r.read_at)}</td>
                  <td className="px-3 py-2.5 text-xs max-w-[24rem]">
                    {r.error_detail
                      ? <span className={r.state === 'failed' ? 'text-red-700' : 'text-[#8a5a1f]'} title={r.error_detail}>{r.error_detail}</span>
                      : r.wamid
                        ? <span className="text-[#B7A48C] font-mono text-[10px] break-all" title={r.wamid}>{r.wamid.slice(0, 28)}{r.wamid.length > 28 ? '…' : ''}</span>
                        : <span className="text-[#B7A48C]">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {confirmStart && settings && (
        <StartConfirm
          count={counts.queued}
          costRate={settings.cost_per_msg}
          threshold={settings.confirm_threshold}
          templateName={c.template_name}
          language={c.language}
          previewBody={c.preview_body}
          paramOrder={c.param_order}
          venue={venue}
          tpl={tpl}
          /* A guest who is actually about to be messaged, preferred over one
             already dealt with — the dialog is about what happens next. */
          guest={recips.find(r => r.state === 'queued') || recips[0]}
          busy={busy}
          error={error}
          onCancel={() => setConfirmStart(false)}
          onConfirm={async (proof: string) => {
            const ok = await onAction(c.id, 'start', {
              confirm: true, expect_count: counts.queued, confirm_message: proof,
            });
            if (ok) setConfirmStart(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * A blank shown to an OWNER, not to a developer.
 *
 * This dialog is the last thing read before a cost is confirmed, and it printed
 * the stored wording verbatim — so the owner was asked to approve a sentence
 * containing "{{1}}" and "{{name}}". Neither is a word he should have to decode.
 * Each blank is replaced by what will actually go in it, in his own vocabulary;
 * a blank this rail has no mapping for is named as an unfilled blank rather
 * than left as punctuation.
 */
function fillBlanksForOwner(body: string, paramOrder: string[]): string {
  const label: Record<string, string> = {
    name: "the guest's name",
    venue: 'your venue name',
    phone: "the guest's phone number",
  };
  // EVERY blank from the campaign's own mapping, in blank order — including the
  // named ones. Reading a named blank by its own name (so {{venue}} always
  // printed "your venue name") is what made this dialog agree with a swapped
  // campaign: it described the sentence the wording MEANT instead of the one
  // this campaign would actually send.
  return fillBlanksInOrder(
    body,
    paramOrder.map(k => `[${label[k] || k}]`),
    () => '[a blank this campaign does not fill]',
  );
}

/** The last gate before guests' phones buzz — typed above the threshold. */
function StartConfirm({
  count, costRate, threshold, templateName, language, previewBody, paramOrder,
  venue, tpl, guest, busy, error, onCancel, onConfirm,
}: {
  count: number; costRate: number; threshold: number;
  templateName: string; language: string; previewBody: string;
  /** The campaign's own blank mapping, so the preview says what fills each one. */
  paramOrder: string[];
  /** The venue name this campaign will really put in a venue blank. */
  venue: string;
  /** The saved template row — the same records the server reads when it decides
   *  whether anything can vouch for what goes in each blank. */
  tpl: Tpl | undefined;
  /** A REAL guest on this campaign's list — so the text below is the text that
   *  reaches a person, not a description of it. Absent only when the recipient
   *  list has not loaded (or is filtered to nothing), and then the dialog says
   *  in words what fills each blank instead of pretending to a real name. */
  guest?: { name: string; phone_e164: string };
  busy: boolean;
  /** Why the last attempt was refused — shown HERE because this dialog sits on
   *  top of the page's own error banner. */
  error: string;
  onCancel: () => void; onConfirm: (proof: string) => void;
}) {
  const needTyped = count > threshold;
  const phrase = `SEND ${count}`;
  const [typed, setTyped] = useState('');
  const [checked, setChecked] = useState(false);
  const [readReal, setReadReal] = useState(false);

  /* THE SAME ACKNOWLEDGEMENT THE WIZARD ASKS FOR — this dialog is the OTHER
   * door into sending, and it had no version of it at all. A draft can be
   * created correctly and then have its mapping rewritten (PATCH stores a
   * param_order without asking the mapping gate), so the blanks this dialog is
   * about are not necessarily the ones that were confirmed at create. The
   * server re-derives the sentence and refuses the start unless it is handed
   * back, so asking here is what keeps the two ends agreeing. */
  const ownerBody = bodyOf(tpl) || previewBody;
  const verdict = mappingVerdict(blankMeanings(tpl, paramOrder.length), paramOrder);
  const proof = proofSentence(ownerBody, paramOrder, venue);
  const needAck = verdict.needsAck && !!proof;
  const cueNotes = needAck ? wordingCues(ownerBody, paramOrder) : [];
  const confirmed = (needTyped ? typed.trim().toUpperCase() === phrase : checked)
    && (!needAck || readReal);

  // THE REAL SENTENCE, FOR A REAL PERSON ON THIS LIST. A description of the
  // message ("[the guest's name] … [your venue name]") reads correctly whether
  // the blanks are the right way round or not — which is exactly how a swapped
  // campaign gets confirmed. The words a guest will actually read do not.
  const guestVars: Record<string, string> = {
    name: guest?.name || 'there',
    venue: venue || 'your venue',
    phone: guest?.phone_e164 || '',
  };
  // Rendered from the wording META will send where this app holds it — the
  // stored preview_body is whatever the caller typed and is not authoritative
  // about a single word of the delivered message.
  const realText = guest && ownerBody ? renderSample(ownerBody, paramOrder, guestVars) : '';

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="bg-white rounded-2xl border border-[#E8D5C4] shadow-xl max-w-lg w-full p-5 space-y-4">
        <h3 className="text-lg font-bold flex items-center gap-2">
          <Send className="w-5 h-5 text-[#af4408]" /> Start sending to {count} guest{count === 1 ? '' : 's'}?
        </h3>

        {previewBody && (
          <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-xl p-3">
            <p className="text-[11px] uppercase tracking-wider text-[#8B7355] mb-1.5">
              {realText
                ? `Exactly what ${guest?.name || 'this guest'} receives`
                : 'The message'}
            </p>
            <p className="text-sm whitespace-pre-wrap">{realText || fillBlanksForOwner(ownerBody, paramOrder)}</p>
            <p className="text-[11px] text-[#8B7355] mt-1.5">
              {realText
                ? `Read it as ${guest?.name || 'this guest'} will — ${formatPhone(guest?.phone_e164 || '') || guest?.phone_e164} is on this list, and every other guest gets the same wording with their own details. If any part of it is in the wrong place, stop here.`
                : 'Anything in [square brackets] is filled in per guest.'}
            </p>
          </div>
        )}

        {/* THE BLANKS NOTHING CAN VOUCH FOR — the same question the wizard asks
            and the same one the server refuses to start without. Where the
            wording does not name a blank, no check anywhere can tell a swap
            from a deliberate constant, so the sentence above is the evidence
            and reading it is the gate. */}
        {needAck && (
          <div className="space-y-1.5">
            {verdict.soft.map(b => (
              <p key={`soft-${b.position}`} className="text-[11px] text-[#8a5a1f]">
                {`This app’s own record of “${templateName}” calls blank ${b.position} “${b.name}”, which asks for ${VAR_LABEL[b.asks].toLowerCase()} — but ${VAR_LABEL[b.mapped].toLowerCase()} is in it.`}
              </p>
            ))}
            {cueNotes.map((cnote, i) => (
              <p key={`cue-${i}`} className="text-[11px] text-[#8a5a1f]">{cnote}</p>
            ))}
            <label className="flex items-start gap-2 text-[12px] text-[#8a5a1f] bg-[#FFF8F0] border border-[#F0D9BE] rounded-xl p-2.5">
              <input type="checkbox" checked={readReal} onChange={e => setReadReal(e.target.checked)} className="accent-[#af4408] mt-0.5" />
              <span>
                {verdict.unproven.length === paramOrder.length
                  ? 'This template’s wording does not say what belongs in its blanks, so nothing here can check them for you. '
                  : `The wording does not say what belongs in ${verdict.unproven.length === 1 ? `blank ${verdict.unproven[0] + 1}` : `blanks ${verdict.unproven.map(i => i + 1).join(' and ')}`}, so nothing here can check ${verdict.unproven.length === 1 ? 'it' : 'them'} for you. `}
                I have read the message above and every part of it is in the right place.
              </span>
            </label>
          </div>
        )}

        <ul className="text-xs text-[#6B5744] space-y-1">
          <li>· Template <code className="text-[#2D1B0E]">{templateName}</code> ({language}) — must already be APPROVED (MARKETING) at the provider.</li>
          <li>· <strong>Meta will bill approximately {money(count * costRate)}</strong> ({count} × {money(costRate)}).</li>
          <li>· Delivery is queued and throttled — consent, cooldown and the daily cap are re-checked on every message, so the final sent count can be lower. That is by design.</li>
          <li>· Pause or cancel any time; it takes effect within one message.</li>
        </ul>

        {/* THE MONEY IS CONFIRMED SECOND. Where nothing can vouch for a blank,
            this control is inert until the message above has been read and
            ticked — the reading and the spend are two acts about two different
            things, and one reflex click must not be able to carry both. */}
        {needTyped ? (
          <label className="block">
            <span className="text-xs font-semibold text-[#6B5744] uppercase tracking-wider">
              This is over the {threshold}-recipient threshold — type <code className="text-[#af4408]">{phrase}</code> to confirm
            </span>
            <input
              value={typed}
              onChange={e => setTyped(e.target.value)}
              placeholder={phrase}
              autoFocus
              disabled={needAck && !readReal}
              className="mt-1 w-full px-3 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#af4408]/40 disabled:bg-[#F5EFE7] disabled:text-[#B9A894]"
            />
            {needAck && !readReal && (
              <span className="text-[11px] text-[#8a5a1f]">Read the message above and tick it first.</span>
            )}
          </label>
        ) : (
          <label className={`flex items-start gap-2 text-sm ${needAck && !readReal ? 'text-[#B9A894]' : 'text-[#2D1B0E]'}`}>
            <input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)}
                   disabled={needAck && !readReal}
                   className="accent-[#af4408] mt-0.5" />
            <span>
              I confirm sending this marketing broadcast to {count} guest{count === 1 ? '' : 's'}.
              {needAck && !readReal && ' (Read the message above and tick it first.)'}
            </span>
          </label>
        )}

        {error && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl p-3 flex items-start gap-2">
            <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </p>
        )}

        <div className="flex gap-2 justify-end">
          <button onClick={onCancel} className="px-4 py-2.5 text-sm font-medium text-[#6B5744] hover:bg-[#FFF1E3] rounded-xl">Cancel</button>
          <button
            onClick={() => onConfirm(proof)}
            disabled={!confirmed || busy}
            className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl text-sm font-semibold"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            Start campaign
          </button>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── wizard ───────────────────────── */

/**
 * The message as the GUEST will see it — a WhatsApp bubble, not a paragraph of
 * fields. Header, footer and buttons come from Meta's own components, so an
 * owner is looking at the whole message and not just its body; the body itself
 * is rendered with a REAL guest from the audience preview, and the caption says
 * which guest, because "Hi {{1}}" and "Hi Rahul" are not the same review.
 */
function MessagePreview({
  header, headerKind, body, footer, buttons, sample, hasTemplate,
}: {
  header: string;
  headerKind: string;
  body: string;
  footer: string;
  buttons: string[];
  sample: { name: string; phone_e164: string } | undefined;
  hasTemplate: boolean;
}) {
  const now = new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
  const media = headerKind && headerKind !== 'TEXT' ? headerKind.toLowerCase() : '';
  return (
    <div className="rounded-xl border border-[#E8D5C4] bg-white overflow-hidden">
      <p className="px-3 py-2 text-[11px] uppercase tracking-wider text-[#8B7355] flex items-center gap-1.5 border-b border-[#F0E4D6]">
        <MessageSquare className="w-3.5 h-3.5" /> What the guest sees
      </p>
      <div className="bg-[#ECE5DD] p-3">
        {hasTemplate ? (
          <div className="bg-white rounded-xl rounded-tl-sm shadow-sm px-2.5 py-2 text-[13px] leading-snug">
            {/* A MEDIA HEADING IS NOT SOMETHING THIS RAIL SENDS. Drawing a tidy
                "[image attachment]" box here read as "an image goes out with
                this", which is the opposite of the truth — the broadcast rail
                attaches no file, so Meta refuses the message. Such a template is
                no longer offered at all; if one is ever reached, this says what
                it actually is. */}
            {media && (
              <div className="mb-1.5 rounded-lg bg-red-50 border border-red-200 text-[11px] text-red-700 py-4 px-2 text-center">
                {`Meta expects ${'aeiou'.includes(media[0]) ? 'an' : 'a'} ${media} here — a broadcast sends none`}
              </div>
            )}
            {header && <p className="font-bold text-[#111B21] whitespace-pre-wrap mb-1">{header}</p>}
            {body
              ? <p className="text-[#111B21] whitespace-pre-wrap break-words">{body}</p>
              : <p className="text-[#667781] italic">No wording available to preview — Meta&apos;s approved template decides what is actually sent.</p>}
            {footer && <p className="text-[11px] text-[#667781] mt-1.5 whitespace-pre-wrap">{footer}</p>}
            <p className="text-[10px] text-[#667781] text-right mt-0.5">{now}</p>
            {buttons.length > 0 && (
              <div className="-mx-2.5 mt-1.5 border-t border-[#E9EDEF]">
                {buttons.map((b, i) => (
                  <p key={i} className={`text-center text-[13px] font-medium text-[#0a7cff] py-1.5 ${i ? 'border-t border-[#E9EDEF]' : ''}`}>{b}</p>
                ))}
              </div>
            )}
          </div>
        ) : (
          <p className="text-xs text-[#667781] italic py-6 text-center">Pick a template to see the message.</p>
        )}
      </div>
      <p className="px-3 py-2 text-[11px] text-[#8B7355] border-t border-[#F0E4D6]">
        {sample
          ? `Sampled with a real guest from this audience: ${sample.name || 'an unnamed guest'} · ${formatPhone(sample.phone_e164) || sample.phone_e164}`
          : 'No eligible guest in this audience to sample — the blanks show placeholder values.'}
      </p>
    </div>
  );
}

type AudKind = 'all_guests' | 'winback' | 'min_visits' | 'birthday_month' | 'tier' | 'phones';

function Wizard({
  settings, templates, syncedAt, venue, canConfigure, flagOn, waOk, onClose, onDone,
}: {
  settings: Settings;
  templates: Tpl[];
  syncedAt: string;
  venue: string;
  /** Admin — may actually reach Settings → Integrations → WhatsApp → Templates. */
  canConfigure: boolean;
  flagOn: boolean;
  waOk: boolean;
  onClose: () => void;
  onDone: (id: string, notice: string, warnings: string[]) => void;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // Step 1 — audience
  const [kind, setKind] = useState<AudKind>('winback');
  const [days, setDays] = useState(60);
  const [includeNever, setIncludeNever] = useState(false);
  const [minVisits, setMinVisits] = useState(3);
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [tier, setTier] = useState('Gold');
  const [phonesText, setPhonesText] = useState('');

  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewErr, setPreviewErr] = useState('');

  // Step 2 — the message.
  //
  // ONE decision, not four. Picking an approved template settles its name, its
  // language and its wording at once — those are facts about the template Meta
  // approved, not choices to be re-typed here, so they are shown as a summary
  // and never as inputs. The only real question left is which guest detail goes
  // in each blank.
  //
  // 'manual' is the escape hatch for a template approved at Meta but not yet
  // synced here. It is a deliberate second mode, labelled as such, and it warns
  // that the name it takes is unchecked — it is NOT the default path.
  const [mode, setMode] = useState<'picked' | 'manual'>('picked');
  const [pickedTpl, setPickedTpl] = useState('');
  const [manualName, setManualName] = useState('');
  const [manualLang, setManualLang] = useState('en');
  const [manualBody, setManualBody] = useState('');
  const [slots, setSlots] = useState<Slot[]>([]);

  // Step 3 — review
  const [name, setName] = useState(
    `Broadcast · ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}`,
  );
  const [throttleOverride, setThrottleOverride] = useState(0);
  const [typed, setTyped] = useState('');
  const [checked, setChecked] = useState(false);
  /** "I have read the real message" — required only where the wording cannot
   *  say what belongs in a blank, so nothing can prove the mapping is right. */
  const [readReal, setReadReal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');
  /**
   * WHAT THE SERVER SAYS ABOUT THIS EXACT CAMPAIGN — the guest its confirmation
   * is written about, and whether a reading is required at all.
   *
   * TWO THINGS THIS SCREEN CANNOT WORK OUT FOR ITSELF.
   *
   * The guest: the server resolves the WHOLE audience to write its confirmation
   * about a real person; this screen only ever sees the ELIGIBLE sample, which
   * is empty for any audience wholly inside the 7-day cooldown. Without the
   * server's guest the two would disagree with no way out — the screen offering
   * a bracketed label and the server refusing it forever, which is the false
   * positive that gets a gate removed.
   *
   * The requirement: a reading this venue has ALREADY done for this wording
   * settles the question for good, and that record lives on the server. A
   * client-side mirror cannot see it, so it asked on every campaign forever —
   * and a prompt that appears every single time is a reflex inside a month.
   *
   * IT IS NEVER THE SENTENCE. The server used to hand its own rendered sentence
   * back, which made the refusal its own answer: one copied field and a caller
   * that rendered nothing was through. The guest comes back instead and the
   * sentence is rendered HERE, from the wording and the mapping, by the same
   * renderer the wire uses.
   */
  const [serverProof, setServerProof] = useState<
    { required: boolean; recipient: { name: string; phone_e164: string } | null } | null
  >(null);

  const audienceDef = useMemo((): Record<string, unknown> | null => {
    switch (kind) {
      case 'all_guests': return { kind };
      case 'winback': return { kind, days, include_never: includeNever };
      case 'min_visits': return minVisits >= 1 ? { kind, visits: minVisits } : null;
      case 'birthday_month': return { kind, month };
      case 'tier': return { kind, tier };
      case 'phones': {
        const phones = phonesText.split(/[\n,;]+/).map(p => p.trim()).filter(Boolean);
        return phones.length ? { kind, phones } : null;
      }
    }
  }, [kind, days, includeNever, minVisits, month, tier, phonesText]);

  // Live preview — debounced 500ms on every audience change.
  const defJson = JSON.stringify(audienceDef);
  useEffect(() => {
    if (!audienceDef) { setPreview(null); setPreviewErr(''); return; }
    let cancelled = false;
    setPreviewBusy(true);
    const t = setTimeout(async () => {
      try {
        const res = await api('/api/crm-calls/broadcasts/preview', { method: 'POST', body: { audience: audienceDef } });
        const j = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(j.error || serverTrouble(res.status, 'the audience preview'));
        setPreview(j.preview);
        setPreviewErr('');
      } catch (e) {
        if (!cancelled) { setPreview(null); setPreviewErr(errMsg(e, 'Preview failed')); }
      } finally {
        if (!cancelled) setPreviewBusy(false);
      }
    }, 500);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defJson]);

  /**
   * WHICH SAVED TEMPLATES A BROADCAST MAY ACTUALLY BE SENT FROM.
   *
   * ONE resolution rule, and it is the server's: a row is judged by ITSELF,
   * under its own `name`, because `name` is exactly what the create route looks
   * up (`SELECT … WHERE name = ?`) and exactly what the drain hands to Meta as
   * the template to send. So the picker posts `t.name` — never
   * `provider_template_name` — and the row it shows a verdict for is the row
   * that verdict will be taken from. The old two-step (post the provider name,
   * judge some other row under it) could show one template's approval beside
   * another template's wording; there is no version of that which is safe.
   *
   * A row whose provider_template_name disagrees with its own name is the one
   * case where those two identities come apart. Sync writes them equal for every
   * managed row, so this is a legacy shape — it is WITHHELD from the picker and
   * says why. Withheld, not "cannot be used": the server has no such rule and
   * would create a campaign on it, so claiming otherwise on screen would be a
   * statement about this app's behaviour that this app contradicts.
   */
  const byName = useMemo(
    () => new Map(templates.map(t => [String(t.name).trim(), t])),
    [templates],
  );

  /**
   * THE ALIAS RULE, in ONE place so both paths obey it.
   *
   * A row whose provider_template_name disagrees with its own name is the one
   * case where those two identities come apart, and a campaign built on it asks
   * Meta for the wrong template. It used to be applied only while building the
   * PICKER map — so the very same row, reached by typing its name in the manual
   * field, skipped the rule entirely and could show a green "approved ·
   * marketing" tick it has not earned, on both the server's and the drain's
   * behalf. Same row, same question, so: same answer, whichever way it is
   * reached.
   */
  const aliasBlock = useCallback((t: Tpl | undefined): TplState | null => {
    if (!t) return null;
    const alias = String(t.provider_template_name || '').trim();
    if (!alias || alias === String(t.name).trim()) return null;
    // ok stays TRUE — the server judges this row by its own `name` and would
    // accept it. Only `offer` is false, and the copy says "not offered here",
    // never "cannot be used".
    return {
      ok: true, offer: false, proven: false, verified: true, caveat: '',
      short: `Meta knows this one as "${alias}"`,
      reason: `"${t.name}" is stored under a different name at Meta ("${alias}"), so a campaign built on it would ask Meta for the wrong template.${byName.has(alias) ? ` Pick "${alias}" instead — it is in this list.` : ' Refresh the template list on Settings → Integrations → WhatsApp → Templates.'}`,
    };
  }, [byName]);

  const tplState = useMemo(() => {
    const m = new Map<string, TplState>();
    for (const t of templates) {
      m.set(t.name, aliasBlock(t) ?? templateBlock(t, syncedAt));
    }
    return m;
  }, [templates, syncedAt, aliasBlock]);

  /**
   * THREE GROUPS, and each heading says only what is true of its group.
   *
   *   offeredTpls  — the server would accept a campaign on this row, so it is
   *                  in the picker. Proven ones first; each unproven one wears
   *                  its own badge and its caveat travels with the selection.
   *   blockedTpls  — ok:false. The create route answers 409 and the drain would
   *                  halt. "Cannot be used for a broadcast" is a fact here.
   *   withheldTpls — the server WOULD accept it, but this screen will not put a
   *                  campaign on it (today: a row Meta knows by another name).
   *                  Listed separately, because filing it under "cannot be
   *                  used" was a claim the same app disproved by accepting it.
   */
  const offeredTpls = useMemo(
    () => templates.filter(t => tplState.get(t.name)?.offer)
      .slice()
      .sort((a, b) => Number(!!tplState.get(b.name)?.proven) - Number(!!tplState.get(a.name)?.proven)),
    [templates, tplState],
  );
  const blockedTpls = useMemo(
    () => templates.filter(t => tplState.get(t.name)?.ok === false),
    [templates, tplState],
  );
  const withheldTpls = useMemo(
    () => templates.filter(t => { const s = tplState.get(t.name); return !!s && s.ok && !s.offer; }),
    [templates, tplState],
  );

  /**
   * Pick a template: settle name, language, wording AND the number of blanks in
   * one move. The blank count is a FACT of the approved template, so it is not
   * an add/remove control here — the operator answers "what goes in blank 2",
   * never "how many blanks should there be". Each blank's first answer is
   * guessed from the variable name the template's author used, and is shown
   * against the sentence it sits in so a wrong guess is obvious.
   */
  const pick = (tplName: string) => {
    setMode('picked');
    setPickedTpl(tplName);
    const t = templates.find(x => x.name === tplName);
    if (!t) { setSlots([]); return; }
    // blankNeed() is the same two-record rule the server applies. When it cannot
    // tell, NOTHING is offered and the step blocks — an empty mapping list is
    // never allowed to mean "this template takes no parameters" again.
    const need = blankNeed(t);
    const names = need.names;
    setSlots(need.known ? Array.from({ length: need.count }, (_, i) => guessVar(names[i] || '')) : []);
  };

  /* ── The three facts a campaign is actually built from. In 'picked' mode they
   *    are READ from the chosen template and are not editable; in 'manual' mode
   *    they are what the operator typed. One place, so the summary, the preview
   *    and the POST body can never disagree. ── */
  const chosen = mode === 'picked' ? byName.get(pickedTpl.trim()) : undefined;
  const templateName = mode === 'picked' ? String(chosen?.name || '') : manualName.trim();
  const language = mode === 'picked'
    ? String(chosen?.provider_language || chosen?.language || 'en').trim()
    : (manualLang.trim() || 'en');
  const previewBody = mode === 'picked' ? bodyOf(chosen) : manualBody;
  const parts = metaComponents(chosen);

  // The first NAMED guest of this audience, the same one the server writes its
  // confirmation about (audienceProofRecipient) — a real name is the half of
  // the sentence a swap shows up in, so an unnamed row is not preferred to one
  // that has a name.
  /* THE GUEST THE SENTENCE IS WRITTEN ABOUT.
   *
   * preview.sample is ELIGIBLE-ONLY — it leaves out everyone inside the 7-day
   * cooldown — so a venue that broadcast this week sees an EMPTY sample on its
   * next campaign and this screen has nobody to name. The server does not have
   * that blind spot (audienceProofRecipient falls back to the whole list), so
   * it would refuse a confirmation this screen could never produce. Where the
   * server has named the guest in a refusal, that guest is used here: the
   * screen then shows the same sentence the server is waiting for, instead of
   * a bracketed label that satisfies nothing. */
  const sample = serverProof?.recipient
    || preview?.sample?.find(g => String(g.name || '').trim())
    || preview?.sample?.[0];
  const sampleVars: Record<string, string> = {
    // A REAL guest from this very audience, with the same fallback the sender
    // uses for an unnamed one ('there'), so the words on screen are the words
    // on the wire. 'Guest' appears only when the audience has produced nobody
    // to show yet, and the caption below says so rather than claiming exactness.
    name: sample ? (sample.name || 'there') : 'Guest',
    // 'your venue' — the SAME fallback proofSentence() uses on the server, so
    // the sentence read here and the sentence the server checks are one string
    // even on an install that has never set a business name.
    venue: venue || 'your venue',
    phone: sample?.phone_e164 || '',
  };
  /** True when both halves of the sentence are the real ones. */
  const sampleIsReal = !!sample && !!venue;
  // WHAT IS READ IS WHAT IS SENT BACK. Where the server refused and supplied
  // its own sentence, that exact string is shown — the tick must be about the
  // words that will actually be checked, not a second rendering of them.
  // RENDERED HERE, from the wording and the mapping, for whichever guest is
  // known — the sample if this screen has one, the server's named guest if it
  // does not. The server no longer hands its sentence over (that made its own
  // refusal the key to itself), so the words on screen are built the same way
  // the wire builds them and the two agree because the inputs are the same.
  const rendered = renderSample(previewBody, slots, sampleVars);

  const templateNameOk = /^[a-z0-9_]{1,512}$/.test(templateName.trim());

  // MANUAL MODE ONLY. A typed name is free text, so judge THAT — with the same
  // lookup the server performs on it — rather than assuming it is unknown. A
  // name typed by hand can land on a template the lifecycle already knows to be
  // pending, rejected, or approved in the wrong category, and the operator
  // should read that here rather than in a 409 after confirming the spend.
  const typedRow = mode === 'manual' && templateName ? byName.get(templateName) : undefined;
  // THE ALIAS RULE APPLIES HERE TOO — see aliasBlock. A hand-typed name that
  // lands on an aliased row must not wear a tick the picker withholds.
  const typedState = mode === 'manual' && templateName
    ? (aliasBlock(typedRow) ?? templateBlock(typedRow, syncedAt))
    : null;

  /**
   * Blanks the template needs vs blanks mapped here. The create route REFUSES a
   * mismatch — Meta matches parameters by count and position, so every message
   * would be rejected, not some.
   *
   * It fires in BOTH modes now. It used to be "the manual path's backstop"
   * because in picked mode the count was taken to be the template's by
   * construction — true only while the count could be established at all. On an
   * install that has never synced it could not be, so picked mode silently
   * mapped nothing and the gap that mattered most was the one this never saw.
   */
  const paramGap = useMemo(() => {
    const row = mode === 'picked' ? chosen : typedRow;
    if (!row) return null;
    const need = blankNeed(row);
    if (!need.known) {
      // Unknowable. Only a BARE campaign is refused: zero is what an empty
      // mapping screen produces, not something the operator chose. A count they
      // did map is an assertion nothing here holds evidence against.
      return slots.length === 0
        ? { expected: -1, provided: 0, names: [] as string[], reason: need.reason }
        : null;
    }
    if (need.count === slots.length) return null;
    return { expected: need.count, provided: slots.length, names: need.names, reason: '' };
  }, [mode, chosen, typedRow, slots.length]);

  /**
   * THE HEADER, on whichever row is actually in play. templateBlock() already
   * folds this in, so in normal operation it never fires twice — it is computed
   * separately so the screen can SAY what is wrong (rather than only greying a
   * button), and so the button is still gated if the classification above ever
   * drifts from the server. A media-header template reaching this point used to
   * pass every check on this screen, be confirmed for cost, and then be refused
   * by Meta for every guest.
   */
  const headerGap = useMemo(() => {
    const row = mode === 'picked' ? chosen : typedRow;
    if (!row) return null;
    const h = headerFill(row);
    return h.ok ? null : h;
  }, [mode, chosen, typedRow]);

  /**
   * THE BLANKS THIS RAIL CANNOT FILL, on whichever row is actually in play —
   * and the reason this screen no longer decides anything by position alone.
   *
   * paramGap only ever asked HOW MANY. ct_slow_night has three blanks and three
   * were mapped, so it passed — with {{day}} quietly given the venue name,
   * accepted by Meta for all 2,000 guests, charged in full, and every one of
   * them left in a 7-day cooldown having read "tables free at AKAN on AKAN".
   * Nothing on this screen had ever said a broadcast can fill only three things.
   *
   * NOT OVERRIDABLE by changing a dropdown: the refusal is about what the blank
   * MEANS, not about which variable is selected against it.
   */
  const fillGap = useMemo(() => {
    const row = mode === 'picked' ? chosen : typedRow;
    if (!row) return null;
    const f = fillVerdict(row);
    return f.ok ? null : f;
  }, [mode, chosen, typedRow]);

  /**
   * WHAT THE WORDING ITSELF CALLS EACH BLANK, position by position — '' where
   * it does not name one. The only witness strong enough to refuse a mapping
   * on: the template's author wrote {{venue}} into the sentence, so he said
   * what belongs there. (Client mirror of wordingBlankNames() on the server —
   * deliberately NOT blankNeed().names, whose last resort is the stored
   * variable list, which is the same kind of statement as the mapping itself.)
   *
   * BOTH WORDINGS ARE ASKED — Meta's, and the copy saved here — because a
   * refresh writes Meta's body back with NUMBERED blanks and would otherwise
   * erase this the day someone clicks it.
   */
  const meanings = useMemo(
    () => blankMeanings(mode === 'picked' ? chosen : typedRow, slots.length),
    [mode, chosen, typedRow, slots.length],
  );

  /** What to CALL each blank on screen — '' where nothing names it. */
  const blankNames = useMemo(() => meanings.map(m => m.name), [meanings]);

  /**
   * THE PASTED WORDING, in manual mode only — a witness this screen has and the
   * server deliberately does not.
   *
   * The server never judges a mapping against preview_body: that text is
   * whatever the caller typed, and this very screen tells the operator that
   * "WhatsApp sends the approved wording, not this copy". But the operator
   * typed it about THIS template, so on THIS screen it is his own statement of
   * what the blanks mean, and blocking on it costs him one correction while
   * letting it through can cost the whole audience. Strictly stricter than the
   * server, never laxer — the server's own gate is unaffected either way.
   */
  const pastedNames = useMemo((): string[] => {
    if (mode !== 'manual' || !slots.length) return [];
    const census = bodyBlankCensus(previewBody);
    if (census.count !== slots.length) return [];
    return [...Array(census.positional).fill(''), ...census.named] as string[];
  }, [mode, previewBody, slots.length]);

  /**
   * THE SWAPPED MAPPING — the mistake that costs the whole amount and shows no
   * symptom. Two dropdowns changed and every guest reads "Hi AKAN … your last
   * visit to Rahul Menon": the number of blanks is still right, so WhatsApp
   * accepts all of it, nothing fails, and the entire list is charged for and
   * put into a cooldown.
   *
   * ITS OWN MEMO, WITH `slots` IN THE DEPS — deliberately not folded into
   * fillGap, whose verdict is about what a blank MEANS and must stay
   * un-overridable by a dropdown. This one is about the dropdown.
   *
   * blankNames is aligned to THIS mapping's length by construction, and carries
   * '' for every blank no wording names — those are skipped, never refused.
   */
  const verdict = useMemo(() => mappingVerdict(meanings, slots), [meanings, slots]);

  const swapGap = useMemo(() => {
    if (!slots.length) return null;
    // The server's own refusal, plus the pasted wording in manual mode.
    const bad = [...verdict.hard, ...contradictedBlanks(pastedNames, slots)];
    const seen = new Set<number>();
    const uniq = bad.filter(b => (seen.has(b.position) ? false : (seen.add(b.position), true)));
    return uniq.length ? uniq : null;
  }, [verdict, pastedNames, slots]);

  /**
   * THE BLANKS NOTHING CAN VOUCH FOR — a numbered {{1}} nobody named, or one
   * whose only record is this app's own variable list. The wording does not
   * prove what belongs there, so a swap in one of them cannot be proved and
   * must NOT be refused (some templates legitimately put the same thing in
   * every copy). What it gets instead is the real sentence, read and ticked
   * before the money is spent — and the server asks for the same sentence back,
   * so the tick is a gate rather than a decoration.
   *
   * NOT GATED ON `swappable` — and that gate is why this screen had to be
   * measured rather than read. It said "a mapping that puts the SAME variable in
   * every blank has no rearrangement that changes one word, so there is nothing
   * to check", which is true about rearrangements and beside the point: the
   * question is whether the RIGHT thing is in each blank, and ['venue','venue']
   * on "Hi {{1}}, thank you for visiting {{2}} last week." is wrong without
   * being a permutation of itself.
   *
   * The server dropped that gate (mappingVerdict in lib/wa-broadcast); this
   * copy kept it, and the two then disagreed about the one class the gate was
   * rebuilt for. MEASURED on the owner's own data, adopted template, audience
   * all_guests: ['venue','venue'] / ['name','name'] / ['phone','phone'] — the
   * server demanded a reading (required=true, unproven=[1,2]) while this screen
   * computed unprovenSlots=[] and showed NO TICK. The create then carried the
   * auto-filled confirmation below and 27 recipients were queued for "Hi Akan,
   * thank you for visiting Akan last week." with nobody having read anything.
   *
   * A reading is asked wherever the evidence is missing, whatever the shape of
   * the mapping. The noise this was guarding against is answered by the
   * server's own memory of what this venue has already read for this wording
   * (dry_run → serverProof), not by declining to ask.
   */
  const unprovenSlots = useMemo(() => verdict.unproven, [verdict]);

  /** What the app's weaker records say against this mapping — shown, not refused. */
  const softGap = useMemo(() => verdict.soft, [verdict]);

  /**
   * THE WORDING THE SERVER WILL JUDGE THIS BY — Meta's own where this app holds
   * it, the copy saved here otherwise, and only then the pasted text. The
   * acknowledgement is compared byte for byte against the server's own
   * rendering, so it has to be built from the server's own witness; building it
   * from a pasted body would answer the right question about the wrong sentence.
   */
  const ownerBody = mode === 'picked'
    ? bodyOf(chosen)
    : (bodyOf(typedRow) || previewBody);

  /** What the sentence itself suggests. Advisory — never blocks anything. */
  const cueNotes = useMemo(
    () => (unprovenSlots.length ? wordingCues(ownerBody, slots) : []),
    [unprovenSlots.length, ownerBody, slots],
  );

  /**
   * The LABEL form — "[the guest's name]" where the guest goes. Still needed:
   * it is what /action and every drain pass compare the stored confirmation
   * against, because the guest named below can opt out or fall into a cooldown
   * between this screen and the first message.
   */
  const proof = useMemo(
    () => proofSentence(ownerBody, slots, venue),
    [ownerBody, slots, venue],
  );

  /**
   * THE SENTENCE A REAL PERSON ON THIS LIST WOULD READ — what create() hands
   * back as the confirmation (F4).
   *
   * The label form cannot be the confirmation, because it reads correctly
   * whichever way round the blanks are: "Welcome to [the guest's name] — Akan"
   * and "Welcome to Akan — [the guest's name]" are both sentences the eye
   * accepts. "Welcome to Lakshmi Devi — Akan, your table is ready." is not. It
   * is also the only form a caller cannot fabricate without resolving the
   * audience, which is exactly what the server checks it for.
   *
   * Rendered from ownerBody (the wording WhatsApp will use), by the same
   * blank-order renderer the wire uses — never a second, friendlier one.
   */
  const realProof = useMemo(
    // Built here for whichever real guest is known — this screen's own sample,
    // or the one the server named when it refused. Never a string the server
    // handed over: a refusal that carries its own answer is not a gate.
    () => (sample ? renderSample(ownerBody, slots, sampleVars).trim() : ''),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ownerBody, slots, sample?.name, sample?.phone_e164, venue],
  );

  // A changed mapping is a different message. The tick is about the SENTENCE,
  // so it is withdrawn the moment that sentence changes by a single character —
  // and the server, which compares the sentence it is handed against its own,
  // would refuse a stale one anyway. The REAL sentence is in the list too: a
  // different guest is a different message, and the tick was about that guest's.
  // A sentence the SERVER supplied counts as a change like any other: it names
  // a guest this screen was not showing, so it must be read afresh.
  useEffect(() => { setReadReal(false); }, [slots, previewBody, proof, realProof, serverProof?.recipient?.phone_e164]);

  /* ═══ ASK THE GATE BEFORE OFFERING THE BUTTON (dry_run) ═══
   *
   * The server's answer is about ONE mapping of ONE template for ONE audience,
   * so it is dropped the moment any of the three changes and asked again.
   *
   * WHY ASK AT ALL, WHEN THE CREATE WOULD TELL US. Two reasons, and both are
   * failures this screen used to have:
   *
   *   • the mirror above judges the evidence from the template row alone, and
   *     cannot see a reading THIS VENUE HAS ALREADY DONE for this wording. On a
   *     template adopted from Meta it therefore showed the same tick on every
   *     campaign forever — a prompt at that frequency is a reflex inside a
   *     month, and a reflex is not a reading;
   *   • learning the demand from a 409 turns a question into an error. The
   *     operator meets "read this" after pressing the button that spends money,
   *     which is the worst possible moment to be asked to read carefully.
   *
   * It builds nothing: no campaign, no recipients, no cost. And it does NOT ask
   * for the sentence — the guest comes back and the sentence is rendered here.
   * Debounced with the same 500 ms as the preview, and only once the campaign is
   * actually describable (a template, an audience, and every blank answered).
   */
  const slotsJson = JSON.stringify(slots);
  useEffect(() => {
    setServerProof(null);
    if (step !== 3) return;
    if (!audienceDef || !templateNameOk || slots.some(s => !String(s || '').trim())) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await api('/api/crm-calls/broadcasts', {
          method: 'POST',
          body: {
            dry_run: true,
            name: name || 'draft',
            template_name: templateName.trim(),
            language: language.trim() || 'en',
            param_order: slots,
            audience: audienceDef,
          },
        });
        const j = await res.json();
        // A non-200 here is one of the OTHER gates (approval, count, header)
        // and the create call will say so in its own words. Nothing is claimed
        // about the reading, so the mirror above keeps deciding — the safe end.
        if (cancelled || !res.ok || j?.dry_run !== true) return;
        setServerProof({
          required: j.read_required === true,
          recipient: j.proof_recipient && j.proof_recipient.name !== undefined ? j.proof_recipient : null,
        });
      } catch { /* offline / refused — the client mirror decides, which asks more, not less */ }
    }, 500);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, defJson, slotsJson, templateName, templateNameOk, language]);

  /**
   * THE NAME META KNOWS IT BY. Mirror of the create route's refusal — a row
   * whose provider name differs from its own name would ask Meta for a template
   * it does not have, and every message fails. The picker already withholds
   * such a row; this is the hand-typed path, which used to show only an amber
   * caveat and let Continue through.
   */
  const aliasGap = useMemo(() => {
    const row = mode === 'picked' ? chosen : typedRow;
    if (!row) return null;
    const a = String(row.provider_template_name || '').trim();
    return a && a !== String(row.name || '').trim() ? a : null;
  }, [mode, chosen, typedRow]);

  /**
   * BLANKS NOBODY HAS ANSWERED (F3) — the state the by-position guess used to
   * hide. A template adopted from Meta names none of its blanks, so every one
   * of them starts here; continuing with one unanswered would send a parameter
   * list nobody chose, in an order nothing vouches for.
   */
  const unsetSlots = useMemo(
    () => slots.map((s, i) => (s ? -1 : i + 1)).filter(n => n > 0),
    [slots],
  );

  /** May this campaign be built on the template currently chosen or typed? */
  const templateOk = (mode === 'picked'
    ? !!chosen && !!tplState.get(chosen.name)?.offer
    : templateNameOk && typedState?.ok !== false) && !aliasGap;
  const messageOk = templateOk && !paramGap && !headerGap && !fillGap && !swapGap && unsetSlots.length === 0;

  /* WHAT IS CONFIRMED MUST BE WHAT IS STARTED.
   *
   * The rupee line and the typed phrase were built from eligible_now — the
   * number that passes consent and cooldown TODAY — while the campaign was
   * started with expect_count = queued, and the server arms and prices the
   * QUEUED list. Today those are the same number; the day an opt-out or a
   * cooldown exists they are not, and the owner would have confirmed one figure
   * and armed a larger one. So both the phrase and the money are the queued
   * list's, stated as the MOST that can be sent and billed, with the eligible
   * number kept beside it as the realistic figure. */
  const queuedNow = preview?.queued ?? 0;
  const eligible = preview?.eligible_now ?? 0;
  const needTyped = queuedNow > settings.confirm_threshold;
  const phrase = `SEND ${queuedNow}`;
  /**
   * MUST THE MESSAGE BE READ BEFORE THE MONEY IS CONFIRMED?
   *
   * Because this screen says so — a blank whose meaning nothing here can vouch
   * for — OR because the SERVER said so and handed back a sentence. The second
   * half is not redundant: the two sides judge the evidence from their own copy
   * of the template row, and where they disagree the server wins (it is the
   * only one that can actually refuse). Without it a server demand answered by
   * a second click would arm the campaign with no tick shown and nothing read,
   * which is the reflex-confirmation this whole gate exists to prevent.
   */
  const mustRead = serverProof ? serverProof.required : unprovenSlots.length > 0;
  const confirmed = (needTyped ? typed.trim().toUpperCase() === phrase : checked)
    && (!mustRead || readReal);

  const create = async (start: boolean) => {
    if (!audienceDef) return;
    setSubmitting(true); setErr('');
    try {
      const res = await api('/api/crm-calls/broadcasts', {
        method: 'POST',
        body: {
          name,
          template_name: templateName.trim(),
          language: language.trim() || 'en',
          param_order: slots,
          preview_body: previewBody,
          audience: audienceDef,
          throttle_per_min: throttleOverride,
          /* THE SENTENCE THAT WAS ON SCREEN, handed back word for word — the
             one with a REAL guest's name in it, which is what was actually
             read. The server takes it apart blank by blank and checks that the
             name in it belongs to somebody really on this list, so a caller
             that never resolved the audience cannot produce it and a bracketed
             label will not do. The label form goes with the START request,
             which is where the campaign's durable confirmation lives.

             SENT ONLY WHERE SOMEBODY REALLY TICKED IT (`readReal`), and that
             condition is the gate — not a tidy-up.

             It used to be attached to EVERY create. The server's demand was
             therefore answered by this screen on the operator's behalf, so the
             confirmation proved only that the wizard had rendered a sentence —
             which it does whether or not a human ever looked at it. MEASURED:
             on a uniform mapping the screen showed no tick at all (see
             unprovenSlots above) and the create still carried a valid
             confirmation — HTTP 201, 27 recipients queued for "Hi Akan, thank
             you for visiting Akan last week.", nothing read, nothing asked. The
             server then RECORDED that reading as genuine and stopped asking
             about this wording for good (rememberReadMapping), so one
             machine-made confirmation silenced the gate permanently.

             Withheld until the tick, the two ends cannot answer each other: if
             this screen is wrong about whether a reading is needed, the create
             comes back 409 naming the guest, the sentence appears, the tick is
             demanded, and the second attempt carries it. One extra round trip
             in the disagreement case, and no confirmation that nobody made. */
          ...(readReal ? { confirm_message: realProof || proof } : {}),
        },
      });
      const j = await res.json();
      if (!res.ok) {
        /* THE SERVER REFUSED THE READING AND NAMED THE GUEST IT IS ABOUT.
         *
         * It resolves the whole audience; this screen sees only the eligible
         * sample, which is empty for a list wholly inside the cooldown. Adopt
         * the GUEST — the sentence is rendered here from it — withdraw the tick
         * and say what to do, otherwise the two disagree forever and a correct
         * campaign cannot be built at all. The reading is not skipped: the
         * sentence on screen changes to that guest's and must be ticked again. */
        /* UNLESS THERE IS NO SENTENCE TO READ. The server also refuses when this
           app holds NO WORDING for the template at all (a name that exists only
           at Meta): that refusal carries the same confirm_field and the same
           guest, but nothing here can render a message, so adopting it would put
           up a tick above an empty box, ask the operator to read it, and refuse
           every attempt for ever — with "read this and confirm it" printed over a
           refusal whose actual remedy is to refresh the template list. Its own
           words are the honest thing to show. */
        if (j?.confirm_field === 'confirm_message' && j?.proof_recipient && j.proof_recipient.name !== undefined
          && !!ownerBody.trim()) {
          setServerProof({ required: true, recipient: j.proof_recipient });
          setReadReal(false);   // submitting is cleared by the finally below
          setErr(`${j.error} — the message below is now the one ${j.proof_recipient?.name || 'a guest on this list'} would receive. Read it, tick it, and create the campaign again.`);
          return;
        }
        throw new Error(j.error || serverTrouble(res.status, 'creating the campaign'));
      }
      const id: string = j.campaign.id;
      // The CREATE warnings are the ones that say what could not be verified
      // (an unsynced name, an approved template whose category was never
      // recorded). They must survive both exits — losing them on "Save as
      // draft" is how an unchecked template reaches a start button silently.
      const madeWarnings: string[] = Array.isArray(j.warnings) ? j.warnings : [];
      if (!start) {
        onDone(id, 'Draft created. Nothing has been sent — start it from the campaign screen when ready.', madeWarnings);
        return;
      }
      const sRes = await api(`/api/crm-calls/broadcasts/${id}/action`, {
        method: 'POST',
        /* expect_count IS THE NUMBER THAT WAS CONFIRMED, not the one the create
           happened to return. It was `j.queued` — taken from the same request
           the server had just answered — so the /action guard was comparing a
           number with itself and could never fire on this path. The figure in
           the typed phrase and in the rupee line is `queuedNow`; if the audience
           moved between the preview and the create, the start is refused with
           the real number instead of arming a list nobody confirmed. */
        body: { action: 'start', confirm: true, expect_count: queuedNow, confirm_message: proof },
      });
      const sj = await sRes.json();
      if (!sRes.ok) {
        onDone(id, '', [
          ...madeWarnings,
          `The draft was created but NOT started: ${sj.error || serverTrouble(sRes.status, 'starting the campaign', { short: true })} You can start it from the campaign screen.`,
        ]);
        return;
      }
      onDone(
        id,
        sj.note || 'Campaign started — the throttled queue is doing the rest.',
        [...madeWarnings, ...(Array.isArray(sj.warnings) ? sj.warnings : [])],
      );
    } catch (e) {
      setErr(errMsg(e, 'Could not create the campaign'));
    } finally {
      setSubmitting(false);
    }
  };

  // Step 2 no longer advances on a well-FORMED name; it advances on a template
  // this campaign may actually be built on. Letting the operator past a known
  // refusal only to collect a 409 after the cost line has been confirmed is the
  // shape of mistake this whole step exists to remove.
  const stepOk = step === 1
    ? !!audienceDef && !!preview && preview.queued > 0
    : step === 2
      ? messageOk
      : confirmed && !!name.trim();

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-start sm:items-center justify-center p-3 sm:p-4 overflow-y-auto" role="dialog" aria-modal="true">
      <div className="bg-white rounded-2xl border border-[#E8D5C4] shadow-xl max-w-3xl w-full my-4 sm:my-8">
        {/* Head */}
        <div className="p-4 sm:p-5 border-b border-[#F0E4D6] flex items-start justify-between gap-2">
          <div>
            <h3 className="text-lg font-bold flex items-center gap-2">
              <Megaphone className="w-5 h-5 text-[#af4408]" /> New broadcast campaign
            </h3>
            <div className="flex items-center gap-1.5 mt-2 text-[11px] font-semibold">
              {[1, 2, 3].map(n => (
                <span key={n} className={`px-2.5 py-1 rounded-full border ${step === n
                  ? 'bg-[#af4408] text-white border-[#8a3506]'
                  : step > n ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-[#FFF8F0] text-[#8B7355] border-[#EFE1D0]'}`}>
                  {n}. {n === 1 ? 'Audience' : n === 2 ? 'Message' : 'Review & confirm'}
                </span>
              ))}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg hover:bg-[#FFF1E3] text-[#6B5744]">
            <XCircle className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 sm:p-5 space-y-4">
          {(!flagOn || !waOk) && (
            <p className="text-xs text-[#8a4408] bg-[#FFF1E3] border border-[#F0D9BE] rounded-xl p-3">
              {!flagOn && <>Broadcast sending is currently <strong>OFF</strong> — you can build and even start this campaign, but the queue will not move until an admin enables sending. </>}
              {!waOk && <>The WhatsApp provider is <strong>not configured</strong> — nothing can deliver until Settings → Integrations → WhatsApp is completed.</>}
            </p>
          )}

          {/* ── STEP 1: AUDIENCE ── */}
          {step === 1 && (
            <div className="grid lg:grid-cols-2 gap-4">
              <div className="space-y-3">
                <p className="text-xs font-semibold text-[#6B5744] uppercase tracking-wider">Who should hear from you?</p>
                {([
                  ['winback', 'Lapsed guests', 'Not seen in a while — the win-back window'],
                  ['min_visits', 'Regulars', 'Guests with at least N visits (loyalty or dining)'],
                  ['birthday_month', 'Birthday month', 'Guests with a recorded birthday in a month'],
                  ['tier', 'Loyalty tier', 'Bronze / Silver / Gold by loyalty points'],
                  ['all_guests', 'All guests', 'Everyone we know with a phone number'],
                  ['phones', 'Paste numbers', 'A manual list, one per line'],
                ] as Array<[AudKind, string, string]>).map(([k, label, hint]) => (
                  <label key={k} className={`flex items-start gap-2.5 p-3 rounded-xl border cursor-pointer transition-colors ${kind === k ? 'bg-[#FFF1E3] border-[#af4408]' : 'bg-white border-[#E0D0BE] hover:border-[#af4408]/50'}`}>
                    <input type="radio" name="aud" checked={kind === k} onChange={() => setKind(k)} className="accent-[#af4408] mt-0.5" />
                    <span>
                      <span className="text-sm font-semibold block">{label}</span>
                      <span className="text-xs text-[#8B7355]">{hint}</span>
                    </span>
                  </label>
                ))}

                {kind === 'winback' && (
                  <div className="flex flex-wrap items-center gap-2 pl-1">
                    {[30, 60, 90, 120].map(b => (
                      <button key={b} onClick={() => setDays(b)}
                              className={`px-3 py-1.5 rounded-lg text-xs font-semibold border ${days === b ? 'bg-[#af4408] text-white border-[#8a3506]' : 'bg-white text-[#6B5744] border-[#E0D0BE] hover:bg-[#FFF1E3]'}`}>
                        {b}+ days
                      </button>
                    ))}
                    <label className="flex items-center gap-1.5 text-xs text-[#6B5744]">
                      <input type="checkbox" checked={includeNever} onChange={e => setIncludeNever(e.target.checked)} className="accent-[#af4408]" />
                      include never-visited
                    </label>
                  </div>
                )}
                {kind === 'min_visits' && (
                  <label className="block pl-1 text-xs text-[#6B5744]">
                    At least{' '}
                    <input type="number" min={1} max={1000} value={minVisits}
                           onChange={e => setMinVisits(Math.max(1, Math.min(1000, Number(e.target.value) || 1)))}
                           className="w-20 px-2 py-1.5 mx-1 bg-white border border-[#E0D0BE] rounded-lg text-sm" />
                    visits
                  </label>
                )}
                {kind === 'birthday_month' && (
                  <select value={month} onChange={e => setMonth(Number(e.target.value))}
                          className="ml-1 px-3 py-2 bg-white border border-[#E0D0BE] rounded-xl text-sm">
                    {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                  </select>
                )}
                {kind === 'tier' && (
                  <div className="flex gap-2 pl-1">
                    {['Bronze', 'Silver', 'Gold'].map(t => (
                      <button key={t} onClick={() => setTier(t)}
                              className={`px-3 py-1.5 rounded-lg text-xs font-semibold border ${tier === t ? 'bg-[#af4408] text-white border-[#8a3506]' : 'bg-white text-[#6B5744] border-[#E0D0BE] hover:bg-[#FFF1E3]'}`}>
                        {t}
                      </button>
                    ))}
                  </div>
                )}
                {kind === 'phones' && (
                  <textarea value={phonesText} onChange={e => setPhonesText(e.target.value)} rows={5}
                            placeholder={'One number per line:\n98490 12345\n+91 91234 56789'}
                            className="w-full px-3 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#af4408]/40" />
                )}
              </div>

              {/* Live preview panel */}
              <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-xl p-4 space-y-3 h-fit">
                <p className="text-xs font-semibold text-[#6B5744] uppercase tracking-wider flex items-center gap-1.5">
                  <Users className="w-3.5 h-3.5" /> Live audience preview
                  {previewBusy && <Loader2 className="w-3.5 h-3.5 animate-spin text-[#af4408]" />}
                </p>
                {previewErr && <p className="text-xs text-red-700">{previewErr}</p>}
                {!audienceDef && <p className="text-xs text-[#8B7355]">Complete the audience choice to see who it reaches.</p>}
                {preview && (
                  <>
                    <div>
                      <p className="text-3xl font-bold text-[#af4408] tabular-nums">{preview.eligible_now}</p>
                      <p className="text-xs text-[#6B5744]">would be messaged today</p>
                    </div>
                    <div className="text-xs text-[#6B5744] space-y-1">
                      <p className="font-semibold text-[#2D1B0E]">Excluded, and why:</p>
                      <p>· {preview.excluded.opted_out} opted out of marketing</p>
                      <p>· {preview.excluded.cooldown} inside the {settings.cooldown_days}-day cooldown (already messaged)</p>
                      <p>· {preview.excluded.no_phone} with no usable number</p>
                      <p>· {preview.excluded.deduped} duplicate number(s) collapsed</p>
                      <p className="text-[#8B7355]">{preview.total_candidates} candidate(s) → {preview.queued} queueable → {preview.eligible_now} eligible now</p>
                    </div>
                    <p className="text-sm font-semibold text-[#2D1B0E] flex items-center gap-1.5">
                      <IndianRupee className="w-4 h-4 text-[#af4408]" />
                      Meta will bill approximately {money(preview.cost.estimate)}
                      <span className="font-normal text-xs text-[#8B7355]">({preview.eligible_now} × {money(preview.cost.rate)})</span>
                    </p>
                    {preview.sample.length > 0 && (
                      <div className="text-xs text-[#6B5744]">
                        <p className="font-semibold text-[#2D1B0E] mb-0.5">Sample:</p>
                        {preview.sample.slice(0, 5).map((g, i) => (
                          <p key={i}>{g.name || 'Unnamed'} · {formatPhone(g.phone_e164) || g.phone_e164}</p>
                        ))}
                      </div>
                    )}
                    <p className="text-[10px] text-[#8B7355]">{preview.note}</p>
                  </>
                )}
                {preview && preview.queued === 0 && (
                  <p className="text-xs text-red-700">This audience resolves to nobody with a usable WhatsApp number — adjust it before continuing.</p>
                )}
              </div>
            </div>
          )}

          {/* ── STEP 2: THE MESSAGE ── */}
          {step === 2 && (
            <div className="grid lg:grid-cols-[minmax(0,1fr)_19rem] gap-4 items-start">
              {/* ─ Choose the template, then answer one question per blank ─ */}
              <div className="space-y-3 min-w-0">
                <div className="rounded-xl bg-[#FFF1E3] border border-[#F0D9BE] p-3 text-xs text-[#6B5744] space-y-1">
                  <p className="font-semibold text-[#8a4408]">A broadcast is a marketing message</p>
                  <p>
                    WhatsApp only delivers one from a message template Meta has approved for your
                    venue <strong>in the marketing category</strong>. Pick one below — its wording is
                    fixed by that approval, so all you choose here is what goes in the blanks.
                  </p>
                </div>

                {/* ── The picker: every template the server would accept, each
                     wearing exactly what is proven about it. A row Meta has
                     confirmed as marketing is green; one nothing has confirmed
                     yet is amber and carries its caveat into the selection. ── */}
                {offeredTpls.length > 0 ? (
                  <div>
                    <p className="text-xs font-semibold text-[#6B5744] uppercase tracking-wider mb-1.5">
                      Which message?
                    </p>
                    <div className="space-y-1.5 max-h-72 overflow-y-auto pr-0.5">
                      {offeredTpls.map(t => {
                        const preview1 = bodyOf(t).replace(/\s+/g, ' ').trim();
                        const on = mode === 'picked' && pickedTpl === t.name;
                        const st = tplState.get(t.name);
                        const badge = st?.proven
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                          : 'bg-[#FFF1E3] text-[#8a5a1f] border-[#F0D9BE]';
                        return (
                          <label key={t.name}
                                 className={`flex items-start gap-2.5 p-3 rounded-xl border cursor-pointer transition-colors ${on ? 'bg-[#FFF1E3] border-[#af4408]' : 'bg-white border-[#E0D0BE] hover:border-[#af4408]/50'}`}>
                            <input type="radio" name="tpl" checked={on} onChange={() => pick(t.name)}
                                   className="accent-[#af4408] mt-0.5 shrink-0" />
                            <span className="min-w-0">
                              <span className="flex flex-wrap items-center gap-1.5">
                                <span className="text-sm font-semibold font-mono break-all">{t.name}</span>
                                <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold border ${badge}`}>
                                  {st?.short || 'not checked against Meta'}
                                </span>
                                <span className="text-[10px] text-[#8B7355] uppercase">
                                  {String(t.provider_language || t.language || 'en')}
                                </span>
                              </span>
                              {preview1 && (
                                <span className="block text-xs text-[#8B7355] mt-0.5 line-clamp-2">{preview1}</span>
                              )}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  /* ── NOTHING TO SEND FROM. An empty dropdown with a red star is
                       not an answer: say what is missing, and who can fix it —
                       and say only what THIS install can actually know. With no
                       sync behind it, "Meta has not approved any" is not a fact
                       anyone here has checked, so it is not claimed. ── */
                  <div className="rounded-xl bg-red-50 border border-red-200 p-3 space-y-2">
                    <p className="text-sm font-semibold text-red-800 flex items-center gap-1.5">
                      <ShieldAlert className="w-4 h-4 shrink-0" />
                      {templates.length === 0
                        ? 'No WhatsApp templates saved yet'
                        : 'No template here can be used for a broadcast'}
                    </p>
                    <p className="text-xs text-[#6B5744]">
                      {templates.length === 0
                        ? 'This venue has no saved WhatsApp templates at all, so there is nothing a broadcast can be delivered from.'
                        : syncedAt
                          ? `Meta's template list (last checked ${istDateTime(syncedAt)}) has no approved marketing template for this venue that a broadcast can send — each one is listed below with its reason.`
                          : 'Every saved template is unusable for a different reason — each one is listed below with its reason.'}
                    </p>
                    <p className="text-xs text-[#6B5744]">
                      {canConfigure
                        ? 'Write one and submit it for approval on Settings → Integrations → WhatsApp → Templates. Meta usually answers within a few hours.'
                        : 'Ask an admin to write one and submit it for approval on Settings → Integrations → WhatsApp → Templates. Meta usually answers within a few hours.'}
                    </p>
                    {!syncedAt && (
                      <p className="text-xs text-[#6B5744]">
                        Meta&apos;s template list has also never been checked from here, so nothing on
                        this screen has been confirmed against Meta. If a marketing template was
                        approved directly in Meta&apos;s Business Manager, refreshing that list on the
                        same page will bring it in.
                      </p>
                    )}
                    {canConfigure && (
                      <a href="/settings/integrations/whatsapp"
                         className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#af4408] hover:underline">
                        <FileText className="w-3.5 h-3.5" /> Open WhatsApp templates
                      </a>
                    )}
                  </div>
                )}

                {/* ── What was picked, as FACTS. Name, language and wording belong
                     to Meta's approval — showing them as editable inputs invited
                     an operator to change one and quietly send a different (or
                     non-existent) template. ── */}
                {mode === 'picked' && chosen && (() => {
                  const st = tplState.get(chosen.name);
                  const lang = String(chosen.provider_language || chosen.language || 'en');
                  return (
                    <div className="rounded-xl bg-[#FFF8F0] border border-[#E8D5C4] p-3 space-y-1">
                      <p className="text-[11px] uppercase tracking-wider text-[#8B7355]">Sending from</p>
                      <p className="text-sm font-semibold font-mono break-all">{chosen.name}</p>
                      <p className="text-xs text-[#6B5744]">
                        {st?.proven
                          ? `Approved by Meta as a marketing template, in ${lang}.`
                          : `Will be sent to Meta as "${chosen.name}" in ${lang}.`}
                      </p>
                      {/* The caveat rides WITH the selection, on the step where the
                          template is chosen — not in a warnings list after the cost
                          has been confirmed and the campaign created. */}
                      {!!st?.caveat && (
                        <p className="text-[11px] text-[#8a5a1f] flex items-start gap-1">
                          <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
                          <span>{st.caveat}</span>
                        </p>
                      )}
                      <p className="text-[11px] text-[#8B7355]">
                        {st?.proven
                          ? 'The name, the language and the wording all come from that approval — they are not settings, and changing any of them would make it a different template that Meta would have to approve again.'
                          : 'The name, the language and the wording come from the saved template — they are not settings here, and Meta delivers whatever it has approved under this exact name.'}
                      </p>
                    </div>
                  );
                })()}

                {/* ── The one real question on this step ── */}
                {(mode === 'manual' || (mode === 'picked' && chosen)) && (
                  <div>
                    <p className="text-xs font-semibold text-[#6B5744] uppercase tracking-wider">
                      What goes in the blanks
                    </p>
                    {slots.length === 0 ? (
                      <p className="text-xs text-[#8B7355] mt-1">
                        {mode !== 'picked'
                          ? 'No blanks mapped. Add one for each blank in the wording below.'
                          /* A BLANK IS A BLANK, whichever dialect marks it.
                             This used to say "there is nothing to map here" about
                             a wording with two visible blanks, because it only
                             counted {{1}}-style ones — and the campaign then went
                             out with no parameters at all. It now either offers
                             one control per blank, or says plainly that it cannot
                             tell how many there are. */
                          : blankNeed(chosen).known
                            ? 'This message has no blanks — every guest receives exactly the wording shown.'
                            : 'This template cannot be used until the blanks it needs are settled — see below.'}
                      </p>
                    ) : (
                      <p className="text-xs text-[#8B7355] mt-0.5">
                        {`Each guest gets their own copy — choose what fills ${slots.length === 1 ? 'the blank' : 'each blank'}.`}
                      </p>
                    )}
                    <div className="mt-1.5 space-y-1.5">
                      {slots.map((slot, i) => {
                        const ctx = blankContext(previewBody, i + 1, blankNeed(mode === 'picked' ? chosen : typedRow).names[i]);
                        return (
                          <div key={i} className="rounded-xl border border-[#E0D0BE] bg-white p-2.5">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">
                                {`Blank ${i + 1}`}
                              </span>
                              {mode === 'manual' && (
                                <button onClick={() => setSlots(prev => prev.filter((_, j) => j !== i))}
                                        aria-label={`Remove blank ${i + 1}`}
                                        className="p-1 rounded-lg hover:bg-red-50 text-[#8B7355] hover:text-red-700">
                                  <Minus className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                            <div className="flex flex-wrap items-center gap-1.5 mt-1 text-sm">
                              {/* AN UNANSWERED BLANK LOOKS UNANSWERED. The
                                  option is "Choose…", it is selected, and the
                                  control is amber rather than wearing the same
                                  confident styling as a real answer — because
                                  this screen used to answer it by position and
                                  that guess is the swap on any template Meta
                                  numbered. See guessVar(). */}
                              {ctx.found ? (
                                <>
                                  <span className="text-[#8B7355]">{ctx.before}</span>
                                  <select value={slot} aria-label={`What goes in blank ${i + 1}`}
                                          onChange={e => setSlots(prev => prev.map((x, j) => (j === i ? e.target.value as Slot : x)))}
                                          className={`px-2 py-1 rounded-lg text-sm font-semibold ${slot ? 'bg-[#FFF8F0] border border-[#af4408]/50 text-[#af4408]' : 'bg-amber-50 border border-amber-400 text-amber-800'}`}>
                                    {!slot && <option value="">Choose…</option>}
                                    {BROADCAST_VARS.map(v => <option key={v} value={v}>{VAR_LABEL[v]}</option>)}
                                  </select>
                                  <span className="text-[#8B7355]">{ctx.after}</span>
                                </>
                              ) : (
                                <>
                                  <select value={slot} aria-label={`What goes in blank ${i + 1}`}
                                          onChange={e => setSlots(prev => prev.map((x, j) => (j === i ? e.target.value as Slot : x)))}
                                          className={`px-2 py-1 rounded-lg text-sm font-semibold ${slot ? 'bg-[#FFF8F0] border border-[#af4408]/50 text-[#af4408]' : 'bg-amber-50 border border-amber-400 text-amber-800'}`}>
                                    {!slot && <option value="">Choose…</option>}
                                    {BROADCAST_VARS.map(v => <option key={v} value={v}>{VAR_LABEL[v]}</option>)}
                                  </select>
                                  <span className="text-xs text-[#8B7355]">
                                    {`— the wording here does not show a {{${i + 1}}}, so this is sent by position.`}
                                  </span>
                                </>
                              )}
                            </div>
                          </div>
                        );
                      })}
                      {mode === 'manual' && slots.length < 5 && (
                        // Added UNANSWERED. A new blank is a question the
                        // operator has not been asked yet, and pre-filling it
                        // with "the guest's name" is the same guess by another
                        // route.
                        <button onClick={() => setSlots(prev => [...prev, ''])}
                                className="flex items-center gap-1 text-xs font-medium text-[#af4408] hover:underline">
                          <Plus className="w-3.5 h-3.5" /> Add a blank
                        </button>
                      )}
                    </div>
                    {/* UNANSWERED BLANKS. Blocking, and said in the words the
                        create route answers with, so the screen and the server
                        describe one fault the same way. */}
                    {unsetSlots.length > 0 && (
                      <p className="text-[11px] text-amber-800 mt-1.5 flex items-start gap-1">
                        <ShieldAlert className="w-3 h-3 mt-0.5 shrink-0" />
                        <span>
                          {unsetSlots.length === 1
                            ? `Blank ${unsetSlots[0]} has nothing chosen for it. This template’s wording does not say what belongs there, so nothing here can answer it for you — choose it before continuing.`
                            : `Blanks ${unsetSlots.join(', ')} have nothing chosen for them. This template’s wording does not say what belongs in them, so nothing here can answer them for you — choose each one before continuing.`}
                        </span>
                      </p>
                    )}
                    {paramGap && (
                      <p className="text-[11px] text-red-700 mt-1.5 flex items-start gap-1">
                        <ShieldAlert className="w-3 h-3 mt-0.5 shrink-0" />
                        <span>
                          {paramGap.expected < 0 ? paramGap.reason : (
                            <>
                              {`This template has ${paramGap.expected} blank${paramGap.expected === 1 ? '' : 's'}`}
                              {paramGap.names.length ? ` (${paramGap.names.join(', ')})` : ''}
                              {`, but ${paramGap.provided} ${paramGap.provided === 1 ? 'is' : 'are'} filled in here. WhatsApp fills blanks strictly in order, so every message would be refused — not just some. Fix this before continuing.`}
                            </>
                          )}
                        </span>
                      </p>
                    )}
                    {/* The heading. RED and blocking, not amber and advisory: a
                        heading this rail cannot fill is refused by Meta for the
                        whole audience, exactly like an unapproved template, and
                        the create route now answers 409 on it. */}
                    {headerGap && (
                      <p className="text-[11px] text-red-700 mt-1.5 flex items-start gap-1">
                        <ShieldAlert className="w-3 h-3 mt-0.5 shrink-0" />
                        <span>{headerGap.reason}</span>
                      </p>
                    )}
                    {/* A blank this rail cannot fill. RED and blocking, like the
                        heading — and the only one of the three whose failure is
                        INVISIBLE without it: WhatsApp accepts a right-count
                        campaign and delivers the wrong sentence to everybody. */}
                    {fillGap && (
                      <p className="text-[11px] text-red-700 mt-1.5 flex items-start gap-1">
                        <ShieldAlert className="w-3 h-3 mt-0.5 shrink-0" />
                        <span>{fillGap.reason}</span>
                      </p>
                    )}
                    {/* THE SWAP. RED and blocking, and it does not argue — it
                        prints the sentence the guest would read. The count is
                        right, so WhatsApp would deliver every one of these and
                        charge for all of them; nothing else in the app would
                        notice. The create route refuses it too. */}
                    {swapGap && (
                      <div className="mt-1.5 rounded-xl border border-red-300 bg-red-50 p-2.5 space-y-1.5">
                        <p className="text-[11px] font-semibold text-red-800 flex items-start gap-1">
                          <ShieldAlert className="w-3.5 h-3.5 mt-px shrink-0" />
                          {swapGap.length === 1
                            ? 'One blank is filled with the wrong thing.'
                            : 'The blanks are filled with the wrong things — they look swapped.'}
                        </p>
                        <ul className="text-[11px] text-red-700 space-y-0.5">
                          {swapGap.map(b => (
                            <li key={b.position}>
                              {`Blank ${b.position} is written as “${b.name}”, which asks for ${VAR_LABEL[b.asks].toLowerCase()} — but ${VAR_LABEL[b.mapped].toLowerCase()} is chosen for it.`}
                            </li>
                          ))}
                        </ul>
                        {!!rendered.trim() && (
                          <p className="text-[11px] text-red-800 bg-white border border-red-200 rounded-lg p-2 whitespace-pre-wrap">
                            {rendered}
                          </p>
                        )}
                        <p className="text-[11px] text-red-700">
                          That is what {sampleIsReal ? `${sampleVars.name} and everyone else on this list would read` : 'every guest on this list would read'}.
                          WhatsApp fills the blanks strictly in order, so it would accept and charge for
                          every message and nothing would fail. Put each blank back to what the wording asks for.
                        </p>
                      </div>
                    )}
                    {/* Said BEFORE anything goes wrong, not only in a refusal:
                        the three things a broadcast can put in a blank. This is
                        owner complaint #3 in a different dress — the rule
                        existed only inside an error message he had to trigger. */}
                    {slots.length > 0 && !fillGap && (
                      <p className="text-[11px] text-[#8B7355] mt-1.5">
                        A broadcast can put only three things in a blank: the guest&apos;s name,
                        your venue name, or their phone number.
                      </p>
                    )}
                  </div>
                )}

                {/* ── The escape hatch: a template approved at Meta that this app
                     has not synced yet. Deliberately a second door, labelled, and
                     honest that it verifies nothing. ── */}
                {mode === 'picked' ? (
                  <button onClick={() => { setMode('manual'); setPickedTpl(''); }}
                          className="text-xs font-medium text-[#af4408] hover:underline">
                    Not in the list? Enter a template name manually →
                  </button>
                ) : (
                  <div className="rounded-xl border border-[#E0D0BE] bg-white p-3 space-y-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs font-semibold text-[#6B5744] uppercase tracking-wider">
                        Template name entered by hand
                      </p>
                      <button onClick={() => { setMode('picked'); setSlots([]); }}
                              className="text-xs font-medium text-[#af4408] hover:underline shrink-0">
                        ← Back to the approved list
                      </button>
                    </div>
                    <p className="text-[11px] text-[#8a5a1f] flex items-start gap-1">
                      <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
                      Use this only for a template Meta has approved but this app has not pulled in
                      yet. Nothing here can check the name — if it is wrong, or not approved as
                      marketing, every message in the campaign fails.
                    </p>
                    <div className="grid sm:grid-cols-2 gap-2.5">
                      <label className="block">
                        <span className="text-[11px] font-semibold text-[#6B5744] uppercase tracking-wider">
                          Exact template name
                        </span>
                        <input value={manualName} onChange={e => setManualName(e.target.value)} placeholder="akan_offer_july"
                               className={`mt-1 w-full px-3 py-2.5 bg-white border rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#af4408]/40 ${manualName && !templateNameOk ? 'border-red-400' : 'border-[#E0D0BE]'}`} />
                        {manualName && !templateNameOk && (
                          <span className="text-[11px] text-red-700">
                            Lowercase letters, digits and underscores only — that is Meta&apos;s rule for template names.
                          </span>
                        )}
                      </label>
                      <label className="block">
                        <span className="text-[11px] font-semibold text-[#6B5744] uppercase tracking-wider">
                          Language it was approved in
                        </span>
                        <input value={manualLang} onChange={e => setManualLang(e.target.value)} placeholder="en"
                               className="mt-1 w-full px-3 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm" />
                        <span className="text-[11px] text-[#8B7355]">
                          Meta&apos;s own spelling — usually en, sometimes en_US.
                        </span>
                      </label>
                    </div>
                    {templateName && templateNameOk && typedState && (
                      typedState.proven ? (
                        <p className="text-[11px] text-emerald-700 flex items-start gap-1">
                          <CheckCircle className="w-3 h-3 mt-0.5 shrink-0" />
                          This name matches a template already approved here as marketing — you can
                          also pick it from the list.
                        </p>
                      ) : typedState.ok && !aliasGap ? (
                        <p className="text-[11px] text-[#8a5a1f] flex items-start gap-1">
                          <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
                          {typedState.caveat || typedState.reason || 'Nothing here can confirm this template is approved, or that it is a marketing template.'}
                        </p>
                      ) : (
                        /* An aliased row reached by TYPING its name used to show
                           an amber note and let Continue through — the refusal
                           lived only in the picker. It is a refusal either way
                           now, and the create route answers 409 on it. */
                        <p className="text-[11px] text-red-700 flex items-start gap-1">
                          <ShieldAlert className="w-3 h-3 mt-0.5 shrink-0" />
                          {`${typedState.reason} A campaign cannot be created on it.`}
                        </p>
                      )
                    )}
                    <label className="block">
                      <span className="text-[11px] font-semibold text-[#6B5744] uppercase tracking-wider">
                        The approved wording
                      </span>
                      <textarea value={manualBody} onChange={e => setManualBody(e.target.value)} rows={3}
                                placeholder="Hi {{1}}, we miss you at {{2}}! Show this message this week for a complimentary dessert."
                                className="mt-1 w-full px-3 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm" />
                      <span className="text-[11px] text-[#8B7355]">
                        Meta sends the approved wording, not this copy. Paste it here so the preview
                        is real and so the message shows up correctly in the guest&apos;s chat history.
                      </span>
                    </label>
                  </div>
                )}

                {/* ── Everything the picker did NOT offer, and why. Never hidden:
                     a template that has quietly vanished is the harder problem.
                     TWO groups, because they are two different statements and
                     only one of them is "cannot be used". A struck-through name
                     under a "cannot be used" heading is a claim about what this
                     app will do — so a row the create route would happily accept
                     may not appear there. ── */}
                {blockedTpls.length > 0 && (
                  <details open={offeredTpls.length === 0} className="rounded-xl border border-[#E8D5C4] bg-[#FFF8F0]">
                    <summary className="px-3 py-2 text-xs font-semibold text-[#6B5744] cursor-pointer select-none">
                      {`${blockedTpls.length} saved template${blockedTpls.length === 1 ? '' : 's'} cannot be used for a broadcast — see why`}
                    </summary>
                    <div className="px-3 pb-3 space-y-2">
                      {blockedTpls.map(t => {
                        const st = tplState.get(t.name);
                        return (
                          <div key={t.name} className="opacity-70">
                            <p className="flex flex-wrap items-center gap-1.5">
                              <span className="text-xs font-semibold font-mono break-all line-through decoration-[#8B7355]/50">{t.name}</span>
                              <span className="px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-[#EFEAE4] text-[#6B5744] border border-[#DED3C6]">
                                {st?.short || 'not available'}
                              </span>
                            </p>
                            {st?.reason && <p className="text-[11px] text-[#8B7355]">{st.reason}</p>}
                          </div>
                        );
                      })}
                    </div>
                  </details>
                )}

                {withheldTpls.length > 0 && (
                  <details className="rounded-xl border border-[#E8D5C4] bg-[#FFF8F0]">
                    <summary className="px-3 py-2 text-xs font-semibold text-[#6B5744] cursor-pointer select-none">
                      {`${withheldTpls.length} saved template${withheldTpls.length === 1 ? ' is' : 's are'} not offered here — see why`}
                    </summary>
                    <div className="px-3 pb-3 space-y-2">
                      {withheldTpls.map(t => {
                        const st = tplState.get(t.name);
                        return (
                          <div key={t.name} className="opacity-70">
                            <p className="flex flex-wrap items-center gap-1.5">
                              <span className="text-xs font-semibold font-mono break-all">{t.name}</span>
                              <span className="px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-[#EFEAE4] text-[#6B5744] border border-[#DED3C6]">
                                {st?.short || 'not offered'}
                              </span>
                            </p>
                            {st?.reason && <p className="text-[11px] text-[#8B7355]">{st.reason}</p>}
                          </div>
                        );
                      })}
                    </div>
                  </details>
                )}
              </div>

              {/* ─ The message as the guest will see it, beside the choices ─ */}
              <div className="lg:sticky lg:top-4">
                <MessagePreview
                  header={mode === 'picked' ? parts.header : ''}
                  headerKind={mode === 'picked' ? parts.headerKind : ''}
                  body={rendered}
                  footer={mode === 'picked' ? parts.footer : ''}
                  buttons={mode === 'picked' ? parts.buttons : []}
                  sample={sample}
                  hasTemplate={!!templateName}
                />
              </div>
            </div>
          )}

          {/* ── STEP 3: REVIEW ── */}
          {step === 3 && preview && (
            <div className="space-y-3">
              <label className="block">
                <span className="text-xs font-semibold text-[#6B5744] uppercase tracking-wider">Campaign name</span>
                <input value={name} onChange={e => setName(e.target.value)}
                       className="mt-1 w-full px-3 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]/40" />
              </label>

              <div className="grid sm:grid-cols-2 gap-3">
                <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-xl p-3 text-sm space-y-1.5">
                  <p className="text-[11px] uppercase tracking-wider text-[#8B7355]">Audience</p>
                  <p className="font-semibold">{audienceLabel(audienceDef as AudienceMeta)}</p>
                  <p className="text-xs text-[#6B5744]">
                    {preview.queued} will be queued · {preview.eligible_now} eligible today ·{' '}
                    {preview.excluded.opted_out + preview.excluded.cooldown} excluded (opt-out / cooldown), {preview.excluded.no_phone} no number, {preview.excluded.deduped} duplicates
                  </p>
                </div>
                <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-xl p-3 text-sm space-y-1.5">
                  <p className="text-[11px] uppercase tracking-wider text-[#8B7355]">Message</p>
                  <p className="font-semibold font-mono text-xs break-all">{`${templateName} (${language})`}</p>
                  <p className="text-xs text-[#6B5744]">
                    {slots.length === 0
                      ? 'Every guest receives exactly the same wording.'
                      : `${slots.length} blank${slots.length === 1 ? '' : 's'} filled in per guest — read the message below before confirming.`}
                  </p>
                </div>
              </div>

              {/* ── THE SENTENCE A REAL PERSON WILL READ ──
                  Not a description of it. "[the guest's name] … [your venue
                  name]" reads correctly whether the blanks are the right way
                  round or not, which is precisely how a swapped campaign gets
                  confirmed and delivered in full. A real name in the wrong half
                  of a real sentence does not read correctly to anybody. */}
              <div className="rounded-xl border border-[#E8D5C4] bg-white overflow-hidden">
                <p className="px-3 py-2 text-[11px] uppercase tracking-wider text-[#8B7355] flex items-center gap-1.5 border-b border-[#F0E4D6]">
                  <MessageSquare className="w-3.5 h-3.5" />
                  {sampleIsReal
                    ? `Exactly what ${sampleVars.name} receives`
                    : 'How this message reads for a guest'}
                </p>
                <div className="p-3 space-y-2">
                  <div className="bg-[#ECE5DD] rounded-xl p-2.5">
                    <p className="bg-white rounded-xl rounded-tl-sm shadow-sm px-2.5 py-2 text-[13px] leading-snug whitespace-pre-wrap break-words text-[#111B21]">
                      {rendered || 'The approved template at WhatsApp decides the wording.'}
                    </p>
                  </div>
                  {slots.length > 0 && (
                    <ul className="text-[11px] text-[#6B5744] space-y-0.5">
                      {slots.map((k, i) => (
                        <li key={i}>
                          {k
                            ? `Blank ${i + 1}${blankNames[i] ? ` (written as “${blankNames[i]}”)` : ''} → ${VAR_LABEL[k].toLowerCase()} → “${sampleVars[k]}”`
                            : `Blank ${i + 1}${blankNames[i] ? ` (written as “${blankNames[i]}”)` : ''} → nothing chosen yet`}
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="text-[11px] text-[#8B7355]">
                    {sampleIsReal
                      ? `${sampleVars.name} (${formatPhone(sample?.phone_e164 || '') || sample?.phone_e164}) is on this list. Every other guest gets the same wording with their own details.`
                      : 'The audience has not produced a guest to show yet — the wording above is filled in the same order every guest will receive it.'}
                  </p>
                  {/* WARN, NEVER REFUSE (see unprovenSlots): where the wording
                      does not name a blank, nothing can prove the mapping is
                      right OR wrong, and some templates legitimately put the
                      same words in every copy. So the message is read, not the
                      mapping argued about. */}
                  {mustRead && (
                    <div className="space-y-1.5">
                      {/* What this app's WEAKER records say against the mapping.
                          Not proof — the variable list belongs to another rail's
                          use of the same template — so it is read out rather
                          than refused. */}
                      {softGap.length > 0 && (
                        <ul className="text-[11px] text-[#8a5a1f] space-y-0.5">
                          {softGap.map(b => (
                            <li key={`soft-${b.position}`}>
                              {`This app’s own record of “${templateName}” calls blank ${b.position} “${b.name}”, which asks for ${VAR_LABEL[b.asks].toLowerCase()} — but ${VAR_LABEL[b.mapped].toLowerCase()} is chosen for it.`}
                            </li>
                          ))}
                        </ul>
                      )}
                      {/* What the SENTENCE suggests. Advisory only: the wording
                          around a blank is a hint, never a record, so it can
                          never block a campaign — it only makes sure the owner
                          is looking at the right half of the message. */}
                      {cueNotes.length > 0 && (
                        <ul className="text-[11px] text-[#8a5a1f] space-y-0.5">
                          {cueNotes.map((c, i) => <li key={`cue-${i}`}>{c}</li>)}
                        </ul>
                      )}
                      <label className="flex items-start gap-2 text-[12px] text-[#8a5a1f] bg-[#FFF8F0] border border-[#F0D9BE] rounded-xl p-2.5">
                        <input type="checkbox" checked={readReal} onChange={e => setReadReal(e.target.checked)} className="accent-[#af4408] mt-0.5" />
                        <span>
                          {unprovenSlots.length === 0
                            /* The SERVER asked for this reading, not this screen
                               — it judged the template row differently. Say so
                               plainly rather than describe blanks this side
                               believes are accounted for. */
                            ? 'This campaign could not be built until the message below had been read — it is the one a real guest on this list would receive. '
                            : unprovenSlots.length === slots.length
                              ? 'This template’s wording does not say what belongs in its blanks, so nothing here can check them for you. '
                              : `The wording does not say what belongs in ${unprovenSlots.length === 1 ? `blank ${unprovenSlots[0] + 1}` : `blanks ${unprovenSlots.map(i => i + 1).join(' and ')}`}, so nothing here can check ${unprovenSlots.length === 1 ? 'it' : 'them'} for you. `}
                          I have read the message above and every part of it is in the right place.
                        </span>
                      </label>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between bg-[#FFF1E3] border border-[#F0D9BE] rounded-xl p-3">
                {/* THE FIGURE CONFIRMED IS THE FIGURE ARMED. Starting queues
                    `queued` guests and prices them; eligible_now is how many of
                    those pass consent and cooldown today, and it can only be the
                    same or smaller. Confirming the smaller number while arming
                    the larger one is not a true confirmation. */}
                <p className="text-sm font-semibold flex flex-wrap items-center gap-1.5">
                  <IndianRupee className="w-4 h-4 text-[#af4408]" />
                  WhatsApp will bill at most {money(Math.round(queuedNow * preview.cost.rate * 100) / 100)}
                  <span className="font-normal text-xs text-[#8B7355]">
                    ({queuedNow} × {money(preview.cost.rate)}
                    {eligible !== queuedNow ? ` — ${eligible} of them can be sent today, the rest are held by opt-out or cooldown and are not billed` : ''})
                  </span>
                </p>
                <label className="text-xs text-[#6B5744] flex items-center gap-1.5">
                  Own throttle (0 = global {settings.msgs_per_min}/min):
                  <input type="number" min={0} max={240} value={throttleOverride}
                         onChange={e => setThrottleOverride(Math.max(0, Math.min(240, Number(e.target.value) || 0)))}
                         className="w-16 px-2 py-1 bg-white border border-[#E0D0BE] rounded-lg text-sm" />
                </label>
              </div>

              <ul className="text-xs text-[#6B5744] space-y-1">
                <li>· Consent, cooldown and the daily cap are re-checked when each message is actually sent — a STOP that arrives after this preview still wins.</li>
                <li>· You can pause or cancel while it runs; it takes effect within one message.</li>
              </ul>

              {/* THE COST IS CONFIRMED SECOND, AND IT CANNOT BE THE SAME CLICK.
                  Where nothing can vouch for a blank, the money control stays
                  inert until the message above has been read and ticked — two
                  acts, in that order, about two different things. A single
                  habitual click on "I confirm sending…" can no longer carry the
                  reading of the sentence with it, which is the only way a
                  confirmation survives being seen every week. */}
              {needTyped ? (
                <label className="block">
                  <span className="text-xs font-semibold text-[#6B5744] uppercase tracking-wider">
                    Over the {settings.confirm_threshold}-recipient threshold — type <code className="text-[#af4408]">{phrase}</code> to arm the Start button
                  </span>
                  <input value={typed} onChange={e => setTyped(e.target.value)} placeholder={phrase}
                         disabled={mustRead && !readReal}
                         className="mt-1 w-full px-3 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#af4408]/40 disabled:bg-[#F5EFE7] disabled:text-[#B9A894]" />
                  {mustRead && !readReal && (
                    <span className="text-[11px] text-[#8a5a1f]">Read the message above and tick it first.</span>
                  )}
                </label>
              ) : (
                <label className={`flex items-start gap-2 text-sm ${mustRead && !readReal ? 'text-[#B9A894]' : ''}`}>
                  <input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)}
                         disabled={mustRead && !readReal}
                         className="accent-[#af4408] mt-0.5" />
                  <span>
                    I confirm sending this marketing broadcast to up to {queuedNow} guest{queuedNow === 1 ? '' : 's'}.
                    {mustRead && !readReal && ' (Read the message above and tick it first.)'}
                  </span>
                </label>
              )}
            </div>
          )}

          {err && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl p-3">{err}</p>}
        </div>

        {/* Footer */}
        <div className="p-4 sm:p-5 border-t border-[#F0E4D6] flex items-center justify-between gap-2">
          <button
            onClick={() => (step === 1 ? onClose() : setStep((step - 1) as 1 | 2))}
            className="px-4 py-2.5 text-sm font-medium text-[#6B5744] hover:bg-[#FFF1E3] rounded-xl"
          >
            {step === 1 ? 'Cancel' : '← Back'}
          </button>
          <div className="flex items-center gap-2">
            {step === 3 && (
              <button
                onClick={() => create(false)}
                disabled={submitting || !name.trim() || !messageOk}
                className="px-4 py-2.5 bg-white border border-[#E0D0BE] hover:border-[#af4408] text-[#6B5744] rounded-xl text-sm font-medium disabled:opacity-40"
              >
                Save as draft
              </button>
            )}
            {step < 3 ? (
              <button
                onClick={() => setStep((step + 1) as 2 | 3)}
                disabled={!stepOk}
                className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl text-sm font-semibold"
              >
                Continue →
              </button>
            ) : (
              <button
                onClick={() => create(true)}
                disabled={submitting || !confirmed || !name.trim() || !messageOk}
                className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl text-sm font-semibold"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                Create &amp; start
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── consent panel ───────────────────────── */

function ConsentPanel() {
  const [rows, setRows] = useState<ConsentRow[]>([]);
  const [loadingRows, setLoadingRows] = useState(true);
  const [q, setQ] = useState('');
  const [lookup, setLookup] = useState<{ phone_key: string; opted_out: boolean; consent: ConsentRow | null; history: ConsentRow[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  // Inline reason form (never a native prompt — the reason lands in the audit log).
  const [flipAction, setFlipAction] = useState<'opt_out' | 'opt_in' | null>(null);
  const [flipReason, setFlipReason] = useState('');

  const loadRows = useCallback(async () => {
    setLoadingRows(true);
    try {
      const res = await api('/api/crm-calls/broadcasts/consent');
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || serverTrouble(res.status, 'loading the consent register'));
      setRows(Array.isArray(j.consent) ? j.consent : []);
    } catch (e) {
      setErr(errMsg(e, 'Could not load the consent register'));
    } finally {
      setLoadingRows(false);
    }
  }, []);

  useEffect(() => { loadRows(); }, [loadRows]);

  const search = async () => {
    if (!q.trim()) return;
    setBusy(true); setErr(''); setNote(''); setLookup(null); setFlipAction(null);
    try {
      const res = await api(`/api/crm-calls/broadcasts/consent?phone=${encodeURIComponent(q.trim())}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || serverTrouble(res.status, 'the consent lookup'));
      setLookup(j);
    } catch (e) {
      setErr(errMsg(e, 'Lookup failed'));
    } finally {
      setBusy(false);
    }
  };

  const flip = async () => {
    if (!lookup || !flipAction) return;
    setBusy(true); setErr(''); setNote('');
    try {
      const res = await api('/api/crm-calls/broadcasts/consent', {
        method: 'POST', body: { phone: lookup.phone_key, action: flipAction, reason: flipReason.trim() },
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || serverTrouble(res.status, 'changing the guest consent'));
      const done = flipAction;
      setFlipAction(null); setFlipReason('');
      await search();
      await loadRows();
      setNote(done === 'opt_out' ? 'Guest opted OUT — every broadcast now skips this number.' : 'Guest opted back IN.');
    } catch (e) {
      setErr(errMsg(e, 'Could not record the change'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-white border border-[#E8D5C4] rounded-2xl p-4 shadow-sm space-y-3">
        <p className="text-sm text-[#6B5744]">
          A guest with <strong>no entry here is messageable</strong> — rows exist only for explicit opt-outs (STOP, Meta error, manual)
          and manual opt-ins. Inbound “START” keywords are deliberately not honoured: the webhook is public, so the only road back in
          after a STOP is a manager recording the guest&apos;s own request here.
        </p>
        <div className="flex gap-2">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8B7355]" />
            <input
              value={q}
              onChange={e => setQ(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') search(); }}
              placeholder="Look up a phone number…"
              className="w-full pl-9 pr-3 py-2.5 bg-[#FFF8F0] border border-[#E0D0BE] rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]/40"
            />
          </div>
          <button onClick={search} disabled={busy || !q.trim()}
                  className="px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-40 text-white rounded-xl text-sm font-semibold">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Look up'}
          </button>
        </div>

        {err && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl p-3">{err}</p>}
        {note && <p className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl p-3">{note}</p>}

        {lookup && (
          <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-xl p-3 space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <p className="text-sm font-semibold flex items-center gap-2">
                {lookup.opted_out
                  ? <ShieldOff className="w-4 h-4 text-red-600" />
                  : <ShieldCheck className="w-4 h-4 text-emerald-600" />}
                {formatPhone('+91' + lookup.phone_key) || lookup.phone_key} —{' '}
                {lookup.opted_out ? <span className="text-red-700">opted OUT of marketing</span>
                  : lookup.consent ? <span className="text-emerald-700">explicitly opted in</span>
                  : <span className="text-[#6B5744]">default (messageable)</span>}
              </p>
              {lookup.opted_out ? (
                <button onClick={() => { setFlipAction('opt_in'); setFlipReason(''); }} disabled={busy}
                        className="px-3 py-1.5 bg-white border border-emerald-300 hover:bg-emerald-50 text-emerald-700 rounded-lg text-xs font-semibold disabled:opacity-50">
                  Opt back in (guest asked)
                </button>
              ) : (
                <button onClick={() => { setFlipAction('opt_out'); setFlipReason(''); }} disabled={busy}
                        className="px-3 py-1.5 bg-white border border-red-300 hover:bg-red-50 text-red-700 rounded-lg text-xs font-semibold disabled:opacity-50">
                  Opt out
                </button>
              )}
            </div>
            {flipAction && (
              <div className="bg-white border border-[#E0D0BE] rounded-lg p-2.5 space-y-2">
                <p className="text-xs text-[#6B5744]">
                  {flipAction === 'opt_in'
                    ? 'Record HOW the guest asked to hear from you again (goes into the audit log — this is the only road back in after a STOP):'
                    : 'Reason for opting this guest OUT of marketing (goes into the audit log):'}
                </p>
                <input
                  value={flipReason}
                  onChange={e => setFlipReason(e.target.value)}
                  placeholder={flipAction === 'opt_in' ? 'e.g. guest asked at the desk on 07 Sep' : 'e.g. guest complained on the phone'}
                  autoFocus
                  className="w-full px-3 py-2 bg-[#FFF8F0] border border-[#E0D0BE] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]/40"
                />
                <div className="flex gap-2 justify-end">
                  <button onClick={() => { setFlipAction(null); setFlipReason(''); }}
                          className="px-3 py-1.5 text-xs font-medium text-[#6B5744] hover:bg-[#FFF1E3] rounded-lg">Cancel</button>
                  <button onClick={flip} disabled={busy || !flipReason.trim()}
                          className={`px-3 py-1.5 rounded-lg text-xs font-semibold text-white disabled:opacity-40 ${flipAction === 'opt_in' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-red-600 hover:bg-red-700'}`}>
                    {busy ? 'Recording…' : flipAction === 'opt_in' ? 'Record opt-in' : 'Record opt-out'}
                  </button>
                </div>
              </div>
            )}
            {lookup.history.length > 0 && (
              <div className="text-xs text-[#6B5744]">
                <p className="font-semibold text-[#2D1B0E] mb-0.5 flex items-center gap-1"><Clock className="w-3 h-3" /> History</p>
                {lookup.history.map((h, i) => (
                  <p key={i}>
                    {istDateTime(h.created_at || h.changed_at)} · <strong>{h.status === 'opted_out' ? 'opted out' : 'opted in'}</strong> via {h.source}
                    {h.detail ? ` (${h.detail})` : ''}{h.changed_by ? ` — by ${h.changed_by}` : ''}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-[#F0E4D6] flex items-center gap-2">
          <FileText className="w-4 h-4 text-[#8B7355]" />
          <p className="text-sm font-semibold">Explicit consent register</p>
          <span className="text-xs text-[#8B7355]">({rows.length} row{rows.length === 1 ? '' : 's'})</span>
        </div>
        {loadingRows ? (
          <div className="py-10 text-center"><Loader2 className="w-6 h-6 text-[#af4408] animate-spin mx-auto" /></div>
        ) : rows.length === 0 ? (
          <p className="py-10 text-center text-sm text-[#8B7355]">No explicit opt-outs or opt-ins recorded yet — everyone is messageable by default.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[#FFF1E3] border-b border-[#E8D5C4]">
                <tr className="text-left text-[11px] uppercase tracking-wider text-[#6B5744]">
                  <th className="px-3 py-2.5">Phone</th>
                  <th className="px-3 py-2.5">Standing</th>
                  <th className="px-3 py-2.5">Via</th>
                  <th className="px-3 py-2.5">Detail</th>
                  <th className="px-3 py-2.5">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F0E4D6]">
                {rows.map(r => (
                  <tr key={r.phone_key} className="hover:bg-[#FFFBF6] cursor-pointer" onClick={() => { setQ(r.phone_key); setLookup(null); }}>
                    <td className="px-3 py-2.5 font-medium">{formatPhone('+91' + r.phone_key) || r.phone_key}</td>
                    <td className="px-3 py-2.5">
                      <span className={`inline-block px-2 py-0.5 rounded-lg border text-xs font-semibold ${r.status === 'opted_out' ? 'bg-red-50 text-red-700 border-red-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'}`}>
                        {r.status === 'opted_out' ? 'opted out' : 'opted in'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-[#6B5744]">{r.source}</td>
                    <td className="px-3 py-2.5 text-xs text-[#6B5744] max-w-[18rem] truncate" title={r.detail}>{r.detail || '—'}</td>
                    <td className="px-3 py-2.5 text-xs text-[#6B5744] whitespace-nowrap">{istDateTime(r.changed_at || r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
