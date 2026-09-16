/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * WhatsApp template LIFECYCLE — author → validate → submit → track → gate.
 *
 * THE PROBLEM THIS SOLVES. Before this module, `whatsapp_templates` modelled a
 * template's TEXT but not its APPROVAL. An admin typed a provider template name
 * by hand; if Meta had not approved it (or had paused it since), nothing
 * noticed until send time, once per recipient, as an opaque Graph error. A
 * 2,000-recipient campaign could burn its whole queue failing identically.
 *
 * THE SHAPE OF THE FIX.
 *   • VALIDATE BEFORE SUBMITTING. Meta's review is slow (minutes to hours) and
 *     its rejection reasons are coarse (INVALID_FORMAT for a dozen different
 *     mistakes). Every rule we can check locally, we check locally, with a
 *     message that names the exact offending thing — see validateTemplateDraft.
 *   • VERBATIM ERRORS. Meta's error text is stored and surfaced UNCHANGED. An
 *     admin who cannot read the real reason cannot fix the template, so this
 *     module never paraphrases, truncates-to-nothing, or swallows a Graph error.
 *   • RECONCILE BY (name, language). That pair is Meta's identity for a
 *     template — the same name in two languages is two templates. Our local
 *     table has UNIQUE(name), which is NARROWER; syncTemplateStatuses reports
 *     the collision honestly instead of destroying a row (see name_conflicts).
 *   • GATE THE BROADCAST. templateSendability() is the one predicate the
 *     campaign rail asks, at create AND at every drain pass.
 *
 * BACKWARD COMPATIBILITY IS LOAD-BEARING. meta_status === '' means "this row is
 * a local free-form template, not managed by the Meta lifecycle" — the state
 * every pre-existing row is in after the migration. Nothing here changes such a
 * row's behaviour, and templateSendability() treats an unmanaged row exactly as
 * it treats an unknown name.
 *
 * ── PROVENANCE OF THE META CONTRACT (read before trusting a rule) ───────────
 * CONFIRMED IN-REPO (rules with a citation in the codebase or docs/):
 *   • name shape /^[a-z0-9_]{1,512}$/  — api/crm-calls/broadcasts/route.ts:99
 *   • body variables are POSITIONAL {{1}},{{2}},…  — lib/whatsapp.ts:246-248
 *   • a body may not START or END with a variable, and two variables may not be
 *     ADJACENT — docs/interakt-templates.md:25-27 (named there as the two
 *     formatting rules that cause most rejections)
 *   • params may not carry newlines/tabs/long space runs — whatsapp.ts:514-520
 *   • MARKETING vs UTILITY is a priced distinction, ~7× — docs/interakt-templates.md:11-19
 *   • a template object carries name/status/language/category/components
 *     — api/whatsapp/meta-templates/route.ts:36
 *
 * MODEL KNOWLEDGE, NOT REPO-PROVEN (no Graph API reference exists in this repo;
 * verify against Meta's docs for META_GRAPH_VERSION before relying on them):
 *   • the endpoint POST /{waba-id}/message_templates and its request body
 *   • component shapes and the `example` nesting (body_text is an array OF
 *     ARRAYS — a classic mistake that has moved between Graph versions)
 *   • the status vocabulary beyond APPROVED, and `rejected_reason`
 *   • length limits (1024 body / 60 header / 60 footer)
 *   • the webhook field name `message_template_status_update`
 * Each is marked UNVERIFIED at its use site. They are written defensively: a
 * shape that does not match is reported, never assumed.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import { generateId } from '@/lib/db';
import { getWaConfigRaw, META_GRAPH_VERSION } from '@/lib/whatsapp';
import { utcString } from '@/lib/wa-inbox';

type DB = Database.Database;

/* ═══════════════════════ Vocabulary ═══════════════════════ */

/** Meta's template categories. NOT the local `category` column's vocabulary. */
export const META_CATEGORIES = ['MARKETING', 'UTILITY', 'AUTHENTICATION'] as const;
export type MetaCategory = typeof META_CATEGORIES[number];

/**
 * Local lifecycle status. '' is the pre-existing / unmanaged state.
 * 'unknown_at_meta' is OURS, not Meta's: a row we submitted that Meta's list no
 * longer contains (deleted at Meta, or submitted against a different WABA).
 */
export type TemplateStatus =
  | '' | 'draft' | 'pending' | 'approved' | 'rejected' | 'paused' | 'disabled' | 'unknown_at_meta';

/** Statuses that mean "this row participates in the Meta lifecycle". */
const MANAGED: TemplateStatus[] = ['draft', 'pending', 'approved', 'rejected', 'paused', 'disabled', 'unknown_at_meta'];

export function isManagedStatus(s: unknown): boolean {
  return MANAGED.includes(String(s ?? '') as TemplateStatus);
}

/**
 * THE STATUSES META ITSELF CAN REPORT — and therefore the only ones an inbound
 * webhook may ever write.
 *
 * Two of the managed statuses are NOT Meta's words and must never arrive from
 * outside:
 *
 *   'draft'           — this app's record that the owner wrote a message here and
 *                       has not sent it for approval. It is the ONE status
 *                       sendabilityFrom still refuses outright.
 *   'unknown_at_meta' — this app's own conclusion after reading a whole list.
 *                       One event about one template is not that evidence.
 *
 *   MEASURED, and this is why the list exists: one unauthenticated POST to the
 *   public webhook carrying {"event":"DRAFT"} for each of this venue's 11 names
 *   moved every one of them to 'draft' and took sendable templates from 11/11 to
 *   0/11 — the exact total-estate loss the 2026-09-15 advisory ruling was made to
 *   end, re-entering through the one door that needs no session. mapMetaStatus
 *   keeps an unrecognised value verbatim (correctly: it must never read as
 *   'approved'), so the guard belongs at the door that accepts outside input, not
 *   in the mapper that several trusted callers share.
 */
const META_REPORTABLE: TemplateStatus[] = ['approved', 'pending', 'rejected', 'paused', 'disabled'];

export function isMetaReportableStatus(s: unknown): boolean {
  return META_REPORTABLE.includes(String(s ?? '') as TemplateStatus);
}

/** Meta status string → our lowercase status. An unrecognised value is kept
 *  verbatim (lowercased) rather than mapped to a lie — it must never read as
 *  'approved'. */
export function mapMetaStatus(metaStatus: unknown): TemplateStatus {
  const s = String(metaStatus ?? '').trim().toUpperCase();
  switch (s) {
    case 'APPROVED': return 'approved';
    case 'PENDING':
    case 'PENDING_DELETION':
    case 'IN_APPEAL': return 'pending';
    case 'REJECTED': return 'rejected';
    case 'PAUSED': return 'paused';
    case 'DISABLED':
    case 'DELETED': return 'disabled';
    default: return (s ? (s.toLowerCase() as TemplateStatus) : '');
  }
}

/** Settings key holding the UTC time of the last successful Meta list sync. */
export const SYNC_WATERMARK_KEY = 'wa_templates_last_sync_at';

export function lastSyncAt(db: DB): string {
  try {
    const r = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(SYNC_WATERMARK_KEY) as any;
    return String(r?.value || '').trim();
  } catch { return ''; }
}

function setLastSyncAt(db: DB, v: string): void {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(SYNC_WATERMARK_KEY, v);
}

/* ═══════════════════════ Draft shape ═══════════════════════ */

export interface TemplateVar {
  /** 1-based position — fills {{index}} in the body. */
  index: number;
  /** Variable name the broadcast wizard binds (name | venue | phone | …). */
  name: string;
  /** Example value. Meta REQUIRES one per placeholder or it rejects. */
  example: string;
}

export interface TemplateButton {
  type: 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER';
  text: string;
  url?: string;
  phone_number?: string;
}

export interface TemplateDraft {
  name: string;
  language: string;
  meta_category: string;
  /** Message text with POSITIONAL {{1}},{{2}},… placeholders. */
  body: string;
  /** Optional TEXT header (≤60 chars, at most one variable). */
  header?: string;
  /** Example for the header's single {{1}}, when it has one. */
  header_example?: string;
  /** Optional footer (≤60 chars, NO variables — Meta forbids them there). */
  footer?: string;
  buttons?: TemplateButton[];
  /** One entry per body placeholder, in index order. */
  var_spec?: TemplateVar[];
}

/* ═══════════════════════ Validation ═══════════════════════ */

export interface ValidationResult {
  ok: boolean;
  /** One specific, actionable message per problem. Never a generic "invalid". */
  errors: string[];
}

/** Meta name rule — confirmed in-repo (broadcasts/route.ts:99). */
export const TEMPLATE_NAME_RE = /^[a-z0-9_]{1,512}$/;
/** 'en' or 'en_US'. A mismatch here fails at SEND as a confusing
 *  "template not found" (docs/interakt-templates.md:174-176). */
export const LANGUAGE_RE = /^[a-z]{2,3}(_[A-Z]{2})?$/;

/** UNVERIFIED (model knowledge): Meta's component length limits. */
export const LIMIT_BODY = 1024;
export const LIMIT_HEADER = 60;
export const LIMIT_FOOTER = 60;
export const LIMIT_BUTTON_TEXT = 25;

/** Every {{…}} token in order, with its inner text and position. */
function tokens(s: string): Array<{ raw: string; inner: string; start: number; end: number }> {
  const out: Array<{ raw: string; inner: string; start: number; end: number }> = [];
  for (const m of String(s).matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)) {
    const start = m.index ?? 0;
    out.push({ raw: m[0], inner: m[1], start, end: start + m[0].length });
  }
  return out;
}

/** A single line, no tabs, no 4+ space runs — the param rule Meta enforces
 *  (whatsapp.ts:514-520) applied to the EXAMPLE too, since the example travels
 *  as a parameter value at submission. */
function badParamShape(v: string): string {
  if (/[\r\n]/.test(v)) return 'contains a line break';
  if (/\t/.test(v)) return 'contains a tab';
  if (/ {4,}/.test(v)) return 'contains a run of 4 or more spaces';
  return '';
}

/**
 * Everything we can prove wrong WITHOUT spending a Meta review cycle.
 *
 * Returns EVERY problem found, not just the first — an admin fixing one
 * rejection at a time, each costing a review round-trip, is the failure mode
 * this whole module exists to prevent.
 */
export function validateTemplateDraft(draft: TemplateDraft): ValidationResult {
  const errors: string[] = [];
  const name = String(draft?.name ?? '').trim();
  const language = String(draft?.language ?? '').trim();
  const category = String(draft?.meta_category ?? '').trim().toUpperCase();
  const body = String(draft?.body ?? '');
  const header = String(draft?.header ?? '').trim();
  const footer = String(draft?.footer ?? '').trim();
  const vars = Array.isArray(draft?.var_spec) ? draft.var_spec : [];

  /* — name — */
  if (!name) {
    errors.push('Template name is required.');
  } else if (!TEMPLATE_NAME_RE.test(name)) {
    const offenders = Array.from(new Set(name.split('').filter(ch => !/[a-z0-9_]/.test(ch))));
    errors.push(
      name.length > 512
        ? `Template name is ${name.length} characters; Meta allows at most 512.`
        : `Template name must be lowercase letters, digits and underscores only (Meta naming rule) — "${name}" contains ${offenders.map(c => `"${c}"`).join(', ')}.`,
    );
  }

  /* — category — */
  if (!category) {
    errors.push(`Category is required — one of ${META_CATEGORIES.join(', ')}. This is a PRICED choice: MARKETING costs roughly 7× UTILITY per conversation, and submitting the wrong one gets the template rejected or silently reclassified.`);
  } else if (!(META_CATEGORIES as readonly string[]).includes(category)) {
    errors.push(`Category must be one of ${META_CATEGORIES.join(', ')} — got "${category}". (This is Meta's category, not the local notification/marketing/approval/general label.)`);
  }

  /* — language — */
  if (!language) {
    errors.push("Language is required — a Meta language code such as 'en' or 'en_US'.");
  } else if (!LANGUAGE_RE.test(language)) {
    errors.push(`Language must be a Meta language code like 'en' or 'en_US' — got "${language}". A wrong code fails at SEND time with a "template not found" error that reads like a name problem.`);
  }

  /* — body: the one REQUIRED component — */
  if (!body.trim()) {
    errors.push('A template needs a BODY component — the message text is required.');
  } else {
    if (body.length > LIMIT_BODY) {
      errors.push(`Body is ${body.length} characters; Meta allows at most ${LIMIT_BODY}.`);
    }

    const toks = tokens(body);
    const named = toks.filter(t => !/^\d+$/.test(t.inner));
    if (named.length) {
      errors.push(`A submitted template's variables must be POSITIONAL — use {{1}}, {{2}}, … and give each one a name in the variable list. Found ${named.map(t => `"${t.raw}"`).join(', ')}.`);
    }

    const nums = toks.filter(t => /^\d+$/.test(t.inner)).map(t => Number(t.inner));
    const uniq = Array.from(new Set(nums)).sort((a, b) => a - b);
    if (uniq.length) {
      if (uniq[0] !== 1) {
        errors.push(`Body variables must start at {{1}} — the lowest here is {{${uniq[0]}}}.`);
      }
      const missing: number[] = [];
      for (let i = 1; i <= uniq[uniq.length - 1]; i++) if (!uniq.includes(i)) missing.push(i);
      if (missing.length) {
        errors.push(`Body variables must be numbered with no gaps — found ${uniq.map(n => `{{${n}}}`).join(', ')}, missing ${missing.map(n => `{{${n}}}`).join(', ')}.`);
      }
    }

    // The two formatting rules that cause most rejections
    // (docs/interakt-templates.md:25-27).
    if (toks.length) {
      const first = toks[0];
      const last = toks[toks.length - 1];
      if (body.slice(0, first.start).trim() === '') {
        errors.push(`A template body may not START with a variable — "${first.raw}" is the first thing in the body. Put a word before it (e.g. "Hi ${first.raw}").`);
      }
      if (body.slice(last.end).trim() === '') {
        errors.push(`A template body may not END with a variable — "${last.raw}" is the last thing in the body. Add text after it (e.g. "${last.raw}. See you soon!").`);
      }
      for (let i = 1; i < toks.length; i++) {
        if (body.slice(toks[i - 1].end, toks[i].start).trim() === '') {
          errors.push(`Two variables may not sit next to each other — "${toks[i - 1].raw}" is immediately followed by "${toks[i].raw}". Put text between them.`);
        }
      }
    }

    /* — examples: required for EVERY placeholder — */
    const byIndex = new Map<number, TemplateVar>();
    for (const v of vars) {
      const idx = Number((v as any)?.index);
      if (Number.isFinite(idx)) byIndex.set(idx, v);
    }
    for (const n of uniq) {
      const v = byIndex.get(n);
      const example = String(v?.example ?? '').trim();
      if (!example) {
        errors.push(`Every variable needs an example value — {{${n}}} has none. Meta rejects a submission whose placeholders carry no examples, and the rejection reason does not say which one was missing.`);
      } else {
        const bad = badParamShape(example);
        if (bad) errors.push(`The example for {{${n}}} ${bad}. Meta rejects parameter values that are not a single clean line.`);
      }
      if (v && !String(v.name ?? '').trim()) {
        errors.push(`Variable {{${n}}} needs a name so a campaign knows what to put there.`);
      }
    }
    for (const [idx] of byIndex) {
      if (!uniq.includes(idx)) {
        errors.push(`The variable list defines {{${idx}}}, but the body never uses it. Remove it or add {{${idx}}} to the body.`);
      }
    }
  }

  /* — header (optional, TEXT only here) — */
  if (header) {
    if (header.length > LIMIT_HEADER) {
      errors.push(`Header is ${header.length} characters; Meta allows at most ${LIMIT_HEADER}.`);
    }
    const ht = tokens(header);
    if (ht.length > 1) {
      errors.push(`A text header may contain at most ONE variable — found ${ht.length}.`);
    }
    if (ht.length === 1) {
      if (ht[0].inner !== '1') {
        errors.push(`A header's single variable must be {{1}} — found "${ht[0].raw}". (Header numbering is independent of the body's.)`);
      }
      const ex = String(draft?.header_example ?? '').trim();
      if (!ex) {
        errors.push('The header variable needs an example value — Meta rejects a header placeholder with no example.');
      } else {
        const bad = badParamShape(ex);
        if (bad) errors.push(`The header example ${bad}. Meta rejects parameter values that are not a single clean line.`);
      }
    }
  }

  /* — footer (optional, NEVER variables) — */
  if (footer) {
    if (footer.length > LIMIT_FOOTER) {
      errors.push(`Footer is ${footer.length} characters; Meta allows at most ${LIMIT_FOOTER}.`);
    }
    const ft = tokens(footer);
    if (ft.length) {
      errors.push(`A FOOTER may not contain variables — found ${ft.map(t => `"${t.raw}"`).join(', ')}.`);
    }
  }

  /* — buttons (optional) — */
  const buttons = Array.isArray(draft?.buttons) ? draft.buttons : [];
  buttons.forEach((b, i) => {
    const type = String(b?.type ?? '').trim().toUpperCase();
    const text = String(b?.text ?? '').trim();
    if (!['QUICK_REPLY', 'URL', 'PHONE_NUMBER'].includes(type)) {
      errors.push(`Button ${i + 1}: type must be QUICK_REPLY, URL or PHONE_NUMBER — got "${type}".`);
    }
    if (!text) errors.push(`Button ${i + 1}: button text is required.`);
    else if (text.length > LIMIT_BUTTON_TEXT) errors.push(`Button ${i + 1}: text is ${text.length} characters; Meta allows at most ${LIMIT_BUTTON_TEXT}.`);
    if (type === 'URL' && !String(b?.url ?? '').trim()) errors.push(`Button ${i + 1}: a URL button needs a url.`);
    if (type === 'PHONE_NUMBER' && !String(b?.phone_number ?? '').trim()) errors.push(`Button ${i + 1}: a phone button needs a phone_number.`);
  });

  return { ok: errors.length === 0, errors };
}

/* ═══════════════════════ Component building ═══════════════════════ */

/**
 * Draft → Meta components[].
 *
 * UNVERIFIED (model knowledge): the component shapes below, and in particular
 * that `example.body_text` is an ARRAY OF ARRAYS (one inner array per example
 * set). Getting this nesting wrong is a silent rejection, so it is isolated
 * here — one place to correct against Meta's docs for META_GRAPH_VERSION.
 */
export function buildMetaComponents(draft: TemplateDraft): any[] {
  const components: any[] = [];
  const header = String(draft?.header ?? '').trim();
  const footer = String(draft?.footer ?? '').trim();
  const body = String(draft?.body ?? '');
  const vars = (Array.isArray(draft?.var_spec) ? draft.var_spec : [])
    .slice()
    .sort((a, b) => Number(a?.index) - Number(b?.index));

  if (header) {
    const h: any = { type: 'HEADER', format: 'TEXT', text: header };
    if (tokens(header).length === 1) {
      h.example = { header_text: [String(draft?.header_example ?? '').trim()] };
    }
    components.push(h);
  }

  const b: any = { type: 'BODY', text: body };
  if (vars.length) {
    b.example = { body_text: [vars.map(v => String(v?.example ?? ''))] };
  }
  components.push(b);

  if (footer) components.push({ type: 'FOOTER', text: footer });

  const buttons = Array.isArray(draft?.buttons) ? draft.buttons : [];
  if (buttons.length) {
    components.push({
      type: 'BUTTONS',
      buttons: buttons.map(btn => {
        const type = String(btn?.type ?? '').trim().toUpperCase();
        const out: any = { type, text: String(btn?.text ?? '').trim() };
        if (type === 'URL') out.url = String(btn?.url ?? '').trim();
        if (type === 'PHONE_NUMBER') out.phone_number = String(btn?.phone_number ?? '').trim();
        return out;
      }),
    });
  }

  return components;
}

/** var_spec → the `param_order` JSON the EXISTING consumers already read.
 *  Keeping them derived from one source is what lets the broadcast wizard map
 *  a Meta-authored template without a second, divergent definition. */
export function paramOrderFromVarSpec(vars: TemplateVar[] | undefined): string {
  const list = (Array.isArray(vars) ? vars : [])
    .slice()
    .sort((a, b) => Number(a?.index) - Number(b?.index))
    .map(v => String(v?.name ?? '').trim())
    .filter(Boolean);
  return JSON.stringify(list);
}

export function parseVarSpec(raw: unknown): TemplateVar[] {
  try {
    const v = JSON.parse(String(raw || '[]'));
    if (!Array.isArray(v)) return [];
    return v
      .map((x: any) => ({ index: Number(x?.index), name: String(x?.name ?? ''), example: String(x?.example ?? '') }))
      .filter(x => Number.isFinite(x.index));
  } catch { return []; }
}

/**
 * WHAT THIS ROW SAYS EACH BLANK MEANS — position 1 first, lowercased.
 *
 * The record a campaign's mapping is checked against, and therefore the record
 * whose CHANGE re-points every message built on the template. Read exactly the
 * way the send side reads it: the authored var_spec by its own `index`, else the
 * stored variable list. A var_spec whose indices are not a clean 1..n permutation
 * claims nothing (it cannot be trusted about position), so it falls through to the
 * variable list rather than guessing at array order.
 *
 * Used by the template editor to notice that a save would silently change what
 * every guest reads — see PUT /api/whatsapp/templates.
 */
export function storedBlankMeaning(
  varSpecRaw: unknown,
  paramOrderRaw: unknown,
  /**
   * THE SAVED WORDING — the third record, and on this venue's whole estate the
   * one that actually decides.
   *
   * It was missing, and the send side reads it: blankMeanings ranks the named
   * blanks of the body ABOVE the stored variable list, so on all 11 live rows
   * (every one of which names its blanks in the body) the wording is what the
   * acknowledgement gate answers from.
   *
   *   MEASURED. One admin PUT that rewrote only the body — same sentence, the two
   *   blank names exchanged — re-pointed every blank with NO confirmation asked,
   *   because this function was never shown the column that had changed. The
   *   swapped mapping then read as proven and the honest one was refused in its
   *   place.
   *
   * Optional so existing callers keep compiling; pass it wherever the body is at
   * hand, which is every caller that matters.
   */
  bodyRaw?: unknown,
): string[] {
  const vars = parseVarSpec(varSpecRaw);
  if (vars.length) {
    const idx = vars.map(v => Number(v.index));
    const clean = idx.every(i => Number.isInteger(i) && i >= 1 && i <= vars.length)
      && new Set(idx).size === vars.length;
    if (clean) {
      return vars.slice().sort((a, b) => Number(a.index) - Number(b.index))
        .map(v => String(v.name || '').trim().toLowerCase());
    }
  }
  /* THE WORDING, read the way the send side reads it: only its NAMED blanks, in
   * the order they appear, and only where every blank in it carries a name. A
   * numbered wording ({{1}}, {{2}}) names nothing and must not be read as a
   * record — it would report "" for every position and make an ordinary edit
   * look like a change of meaning. */
  if (bodyRaw !== undefined) {
    const named = namedBlanksInOrder(bodyRaw);
    if (named.length) return named;
  }
  try {
    const v = JSON.parse(String(paramOrderRaw || '[]'));
    if (Array.isArray(v)) return v.map((x: unknown) => String(x ?? '').trim().toLowerCase());
  } catch { /* unreadable list — nothing is claimed */ }
  return [];
}

/**
 * The {{named}} blanks of a wording, in the order they appear, lowercased —
 * and NOTHING when any blank in it is numbered or unnamed, because a record that
 * cannot speak for every position cannot be position-aligned against another.
 */
function namedBlanksInOrder(bodyRaw: unknown): string[] {
  const out: string[] = [];
  for (const t of tokens(String(bodyRaw ?? ''))) {
    const inner = String(t.inner).trim();
    if (!inner || /^\d+$/.test(inner)) return [];
    out.push(inner.toLowerCase());
  }
  return out;
}

/**
 * WOULD THIS RECORD SEND A DIFFERENT MESSAGE?
 *
 * True only where the NEW record makes a claim about a blank that the old one did
 * not make: a position whose name changes to a different name (the swap), or a
 * position that gains a name where there was none (a declaration about Meta's
 * blanks that Meta did not make — and the exact vector of the legacy param_order
 * flip). Both of those change what every guest reads.
 *
 * LOSING a claim is deliberately NOT a change here. A blank that stops being named
 * becomes a blank nothing vouches for, and the gate then asks for the real sentence
 * to be read — stricter, never looser, so there is nothing to confirm. That also
 * keeps ordinary saves ordinary: an adopted row whose editor has no names to offer
 * must not demand a decision for writing down what was already unknown.
 */
export function blankMeaningChanged(before: readonly string[], after: readonly string[]): boolean {
  const n = Math.max(before.length, after.length);
  for (let i = 0; i < n; i++) {
    const a = String(after[i] ?? '').trim();
    const b = String(before[i] ?? '').trim();
    if (a && a !== b) return true;
  }
  return false;
}

/* ═══════════════════════ Meta I/O (injectable) ═══════════════════════ */

export type FetchImpl = (url: string, init?: any) => Promise<any>;

export interface MetaCreds {
  waba: string;
  token: string;
  provider: string;
}

/** Credentials for the authoring calls. Deliberately NOT isWaConfigured():
 *  that helper ignores the WABA id entirely (whatsapp.ts:79-84), so a venue can
 *  read "● Configured" while every template call here is impossible. */
export function metaCreds(): { ok: true; creds: MetaCreds } | { ok: false; error: string } {
  const raw = getWaConfigRaw();
  const provider = String(raw.wa_api_provider || '').trim();
  if (provider !== 'meta_cloud') {
    return { ok: false, error: `Template authoring is only available for the Meta Cloud provider — the configured provider is "${provider || 'none'}".` };
  }
  const waba = String(raw.wa_business_account_id || '').trim();
  const token = String(raw.wa_access_token || '').trim();
  if (!waba) return { ok: false, error: 'Set the WhatsApp Business Account ID (WABA) in Settings → Integrations → WhatsApp. Note the "Configured" badge does NOT cover the WABA id — sending works without it, template authoring does not.' };
  if (!token) return { ok: false, error: 'Set the Meta access token in Settings → Integrations → WhatsApp. It must carry the whatsapp_business_management scope for template calls.' };
  return { ok: true, creds: { waba, token, provider } };
}

function graphUrl(path: string): string {
  return `https://graph.facebook.com/${META_GRAPH_VERSION}/${path}`;
}

/** What a redacted secret is replaced with. Visible, so nobody thinks the
 *  message was truncated or that the credential simply wasn't in it. */
export const REDACTED = '[redacted credential]';

/**
 * SECRET REDACTION — the one thing "verbatim" must NOT mean.
 *
 * Meta's commonest credential failure quotes the token straight back:
 * OAuthException 190 "Malformed access token EAA…". Every Graph error this
 * module touches is STORED in whatsapp_templates.meta_last_error, re-served by
 * GET /api/whatsapp/templates to any management user, rendered in the Template
 * Studio, and copied into every DB backup. Forwarding that text unfiltered
 * turns a transient credential error into durable, readable secret state.
 *
 * So the message stays verbatim in every respect that helps an admin fix the
 * problem, and the credential itself — and nothing else — is replaced.
 */
export function redactSecrets(text: unknown): string {
  let s = String(text ?? '');
  if (!s) return '';

  // 1. The values we can name EXACTLY. Guarded on length so an empty or
  //    one-character setting can never blank out the whole message.
  try {
    const raw: any = getWaConfigRaw();
    for (const key of ['wa_access_token', 'wa_webhook_verify_token', 'wa_interakt_api_key']) {
      const v = String(raw?.[key] ?? '').trim();
      if (v.length >= 8 && s.includes(v)) s = s.split(v).join(REDACTED);
    }
  } catch { /* config unreadable — the shape rules below still apply */ }

  // 2. Anything token-SHAPED, which covers the token that was rotated between
  //    the failing call and this redaction (the error text is stored later than
  //    it is produced, and a rotated value would no longer match step 1).
  //    UNVERIFIED (model knowledge): Meta user/system tokens begin "EAA".
  s = s.replace(/EAA[A-Za-z0-9_\-.]{10,}/g, REDACTED);
  s = s.replace(/(access_token=)[^&\s"']{8,}/gi, `$1${REDACTED}`);
  s = s.replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`);
  return s;
}

/** Pull the Graph error out of a response body. Never invents text; never
 *  forwards a credential (see redactSecrets). */
function graphError(j: any, httpStatus: number): string {
  const e = j?.error;
  if (e) {
    const bits = [String(e.message ?? '').trim()];
    if (e.error_user_title) bits.push(String(e.error_user_title));
    if (e.error_user_msg) bits.push(String(e.error_user_msg));
    if (e.error_subcode) bits.push(`subcode ${e.error_subcode}`);
    const joined = bits.filter(Boolean).join(' — ');
    if (joined) return redactSecrets(joined);
  }
  return `Meta API HTTP ${httpStatus}`;
}

/** Transport/exception text — same redaction, since a thrown request error can
 *  carry the Authorization header or a token-bearing URL. */
function networkError(e: any): string {
  return redactSecrets(String(e?.message || 'Network error reaching Meta.'));
}

/* ═══════════════════════ Submission ═══════════════════════ */

export interface SubmitResult {
  ok: boolean;
  status?: TemplateStatus;
  meta_template_id?: string;
  /** Meta's message, VERBATIM. Present on every failure. */
  error?: string;
  /** Local validation problems, when the draft never left the building. */
  errors?: string[];
}

/** Header/footer/buttons live in meta_components between edits — read them back
 *  so a resubmit does not silently drop the parts the body column cannot hold. */
function readExtras(row: any): Partial<TemplateDraft> {
  const out: Partial<TemplateDraft> = {};
  try {
    const comps = JSON.parse(String(row?.meta_components || '[]'));
    if (!Array.isArray(comps)) return out;
    for (const c of comps) {
      const type = String(c?.type ?? '').toUpperCase();
      if (type === 'HEADER' && String(c?.format ?? 'TEXT').toUpperCase() === 'TEXT') {
        out.header = String(c?.text ?? '');
        const ex = c?.example?.header_text;
        if (Array.isArray(ex) && ex.length) out.header_example = String(ex[0] ?? '');
      } else if (type === 'FOOTER') {
        out.footer = String(c?.text ?? '');
      } else if (type === 'BUTTONS' && Array.isArray(c?.buttons)) {
        out.buttons = c.buttons.map((b: any) => ({
          type: String(b?.type ?? '').toUpperCase() as TemplateButton['type'],
          text: String(b?.text ?? ''),
          url: b?.url ? String(b.url) : undefined,
          phone_number: b?.phone_number ? String(b.phone_number) : undefined,
        }));
      }
    }
  } catch { /* components unreadable — submit from the body alone */ }
  return out;
}

/** The row as an authoring draft (body + whatever components hold). */
export function draftFromRow(row: any): TemplateDraft {
  return {
    name: String(row?.name || ''),
    language: String(row?.provider_language || row?.language || '').trim(),
    meta_category: String(row?.meta_category || ''),
    body: String(row?.body || ''),
    var_spec: parseVarSpec(row?.var_spec),
    ...readExtras(row),
  };
}

/**
 * Submit one local template row to Meta and record the outcome.
 *
 * UNVERIFIED (model knowledge): POST /{waba-id}/message_templates and the
 * request body below. A successful POST returns { id, status, category } with
 * status PENDING — approval arrives later, via syncTemplateStatuses() or the
 * webhook.
 *
 * Validation runs FIRST and refuses locally; nothing is sent until the draft is
 * clean. On a Meta refusal the verbatim error is stored in meta_last_error and
 * returned — the row stays where it was so it can be fixed and resubmitted.
 */
export async function submitTemplate(
  db: DB,
  templateId: string,
  opts: { fetchImpl?: FetchImpl; nowMs?: number } = {},
): Promise<SubmitResult> {
  const row = db.prepare(`SELECT * FROM whatsapp_templates WHERE id = ?`).get(templateId) as any;
  if (!row) return { ok: false, error: 'Template not found.' };

  const draft = draftFromRow(row);

  const v = validateTemplateDraft(draft);
  if (!v.ok) return { ok: false, errors: v.errors, error: v.errors[0] };

  const creds = metaCreds();
  if (!creds.ok) return { ok: false, error: creds.error };

  const components = buildMetaComponents(draft);
  const payload = {
    name: draft.name,
    category: draft.meta_category.toUpperCase(),
    language: draft.language,
    components,
    // Let Meta reclassify rather than hard-reject on a category judgement call.
    // UNVERIFIED (model knowledge): the allow_category_change flag.
    allow_category_change: true,
  };

  const doFetch: FetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  let r: any;
  let j: any = {};
  try {
    r = await doFetch(graphUrl(`${encodeURIComponent(creds.creds.waba)}/message_templates`), {
      method: 'POST',
      headers: { Authorization: `Bearer ${creds.creds.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    j = await r.json().catch(() => ({}));
  } catch (e: any) {
    const detail = networkError(e);
    db.prepare(`UPDATE whatsapp_templates SET meta_last_error = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(detail, templateId);
    return { ok: false, error: detail };
  }

  if (!r?.ok) {
    const detail = graphError(j, Number(r?.status) || 0);
    db.prepare(`
      UPDATE whatsapp_templates
      SET meta_last_error = ?, meta_components = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(detail, JSON.stringify(components), templateId);
    return { ok: false, error: detail };
  }

  const metaId = String(j?.id ?? '').trim();
  const status = mapMetaStatus(j?.status) || 'pending';
  const category = String(j?.category ?? draft.meta_category).toUpperCase();
  const now = utcString(opts.nowMs ?? Date.now());

  db.prepare(`
    UPDATE whatsapp_templates
    SET meta_template_id = ?, meta_status = ?, meta_category = ?, meta_components = ?,
        meta_submitted_at = ?, meta_status_checked_at = ?,
        meta_last_error = '', meta_rejected_reason = '',
        provider_template_name = ?, provider_language = ?,
        param_order = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    metaId, status, category, JSON.stringify(components),
    now, now,
    // The name/language Meta now knows. Written here (not only on approval) so
    // the row's provider identity always matches what was actually submitted.
    draft.name, draft.language,
    paramOrderFromVarSpec(draft.var_spec),
    templateId,
  );

  return { ok: true, status, meta_template_id: metaId };
}

/* ═══════════════════════ Status sync ═══════════════════════ */

export interface SyncResult {
  ok: boolean;
  error?: string;
  /** Rows whose status changed, with both ends of the move. */
  updated: Array<{ name: string; language: string; from: string; to: string; reason?: string }>;
  /** Present at Meta, absent locally — inserted so the venue can use them. */
  adopted: Array<{ name: string; language: string; status: string }>;
  /** Submitted here, Meta has never heard of it → marked unknown_at_meta. */
  missing_at_meta: Array<{ name: string; language: string }>;
  /** Statuses that went BACKWARDS (approved → paused/disabled/rejected/gone). */
  regressed: Array<{ name: string; language: string; from: string; to: string; reason?: string }>;
  /**
   * TEMPLATES THAT CAN NO LONGER SEND — measured by asking EVERY send gate
   * before and after this refresh, not by watching a status transition.
   *
   * `regressed` above answers a narrower question ("did a status move out of
   * approved") and is blind on a FIRST refresh, where every row starts at ''
   * and no such transition can occur. This is the list to show an operator.
   */
  stopped: SendabilityShift[];
  /** Campaigns that could have been started before this refresh and cannot after. */
  campaigns_stopped: Array<{ id: string; name: string; template_name: string; state: string; reason: string }>;
  /** Meta has this name in a language our UNIQUE(name) row cannot hold. */
  name_conflicts: Array<{ name: string; local_language: string; meta_language: string }>;
  fetched: number;
  checked_at: string;
  /**
   * DID THIS ACTUALLY LAND? False when the refresh was rolled back because it
   * would have stopped everything and nobody had confirmed that — `stopped` then
   * describes what WOULD have happened, and not one row was changed.
   */
  applied: boolean;
  /** The refresh is waiting for an explicit "yes, do it anyway". */
  needs_confirmation?: boolean;
  /** A one-press undo of this refresh is now available (see undoLastSync). */
  undo_available?: boolean;
  /**
   * The before/after measurement actually ran. False means the probe failed and
   * `stopped` is EMPTY BECAUSE NOTHING WAS MEASURED — not because nothing
   * stopped. A caller must not report "nothing stopped" on a false here.
   */
  measured: boolean;
}

function emptySync(): SyncResult {
  return {
    ok: true, updated: [], adopted: [], missing_at_meta: [], regressed: [], stopped: [],
    campaigns_stopped: [], name_conflicts: [], fetched: 0, checked_at: '', applied: false,
    measured: false,
  };
}

/**
 * WHAT A REFRESH NEEDS TO BE HONEST.
 *
 * `impact` is REQUIRED on purpose (see SendabilityProbe): it is the only way this
 * module can ask the gates that live in wa-broadcast, and a refresh that cannot
 * ask them cannot tell the operator what it took away. Optional would compile at
 * every call site and quietly report "nothing stopped".
 */
export interface SyncOptions {
  fetchImpl?: FetchImpl;
  nowMs?: number;
  /** How "what can send" is measured — pass measureSendability from wa-broadcast. */
  impact: SendabilityProbe;
  /**
   * The operator has been shown what stops and said do it anyway. Without it, a
   * refresh that would stop EVERY sendable message rolls itself back and reports
   * instead of applying — see isTotalLoss.
   */
  allowStops?: boolean;
}

/**
 * 'en_US' → 'en'. Meta's language codes are locale-qualified; ours are often
 * bare, and the two spellings name the SAME approval.
 */
export function baseLanguage(code: unknown): string {
  return String(code ?? '').trim().toLowerCase().split(/[_-]/)[0];
}

/**
 * Do two language codes describe the same template? Exact match, or a shared
 * base ('en' vs 'en_US').
 *
 * A SHARED BASE IS NOT INTERCHANGEABLE AT SEND TIME — Meta's identity is the
 * exact (name, language) pair, and sending 'en' for a template approved as
 * 'en_US' fails with "template name does not exist in the translation". So the
 * two are reconciled to ONE identity (Meta's spelling, learned at sync) rather
 * than treated as equivalent everywhere; see templateSendability().language.
 */
export function languagesMatch(a: unknown, b: unknown): boolean {
  const x = String(a ?? '').trim().toLowerCase();
  const y = String(b ?? '').trim().toLowerCase();
  if (!x || !y) return true;                 // nothing to disagree about
  if (x === y) return true;
  const bx = baseLanguage(x), by = baseLanguage(y);
  return !!bx && bx === by;
}

/**
 * Which of Meta's entries for one name is THIS local row's template?
 * Exact language first, then a base-language match, then an entry Meta listed
 * without a language at all (which is the pre-existing lenient behaviour).
 * `undefined` means Meta has the name but not in this row's language — a real
 * conflict, not a spelling difference.
 */
function pickLanguageMatch(entries: any[], localLang: string): any | undefined {
  if (!entries.length) return undefined;
  if (!localLang) return entries[0];
  const want = localLang.toLowerCase();
  const exact = entries.find(e => String(e?.language ?? '').trim().toLowerCase() === want);
  if (exact) return exact;
  const base = baseLanguage(want);
  const near = base ? entries.find(e => baseLanguage(e?.language) === base) : undefined;
  if (near) return near;
  return entries.find(e => !String(e?.language ?? '').trim());
}

/** Best-effort BODY text out of a components array (for an adopted row). */
function bodyFromComponents(components: unknown): string {
  if (!Array.isArray(components)) return '';
  for (const c of components) {
    if (String((c as any)?.type ?? '').toUpperCase() === 'BODY') return String((c as any)?.text ?? '');
  }
  return '';
}

/**
 * Pull Meta's WHOLE template list, all statuses, following paging.
 *
 * ONE copy, shared by the refresh and by the before-you-refresh check, so the
 * two can never be looking at different lists. UNVERIFIED (model knowledge):
 * the paging.next cursor shape.
 */
async function fetchMetaTemplateList(
  creds: MetaCreds,
  doFetch: FetchImpl,
): Promise<{ ok: true; data: any[] } | { ok: false; error: string }> {
  const fields = 'id,name,status,language,category,components,rejected_reason';
  let url = graphUrl(`${encodeURIComponent(creds.waba)}/message_templates?fields=${fields}&limit=100`);
  const remote: any[] = [];
  // A venue with >100 templates must not silently reconcile the first page only
  // — a template missing from a truncated list would be marked unknown_at_meta
  // and refused for broadcasts.
  for (let page = 0; page < 20 && url; page++) {
    let r: any;
    let j: any = {};
    try {
      r = await doFetch(url, { headers: { Authorization: `Bearer ${creds.token}` } });
      j = await r.json().catch(() => ({}));
    } catch (e: any) {
      return { ok: false, error: networkError(e) };
    }
    if (!r?.ok) return { ok: false, error: graphError(j, Number(r?.status) || 0) };
    const data = Array.isArray(j?.data) ? j.data : [];
    remote.push(...data);
    const next = String(j?.paging?.next ?? '').trim();
    url = next && next !== url ? next : '';
  }
  return { ok: true, data: remote };
}

/** Meta's list grouped by NAME, because our table is UNIQUE(name) and Meta is not. */
export function groupRemoteByName(remote: any[]): Map<string, any[]> {
  const out = new Map<string, any[]>();
  for (const t of remote) {
    const nm = String(t?.name ?? '').trim();
    if (!nm) continue;
    const list = out.get(nm);
    if (list) list.push(t); else out.set(nm, [t]);
  }
  return out;
}

/* THE SWEEP'S PROJECTION USED TO LIVE HERE — projectAfterSync() and sweptFacts(),
 * which computed "the row as a refresh would leave it" so the report could be
 * written without performing the refresh.
 *
 * Both are gone, deliberately. They were a SECOND copy of the write's rules, and a
 * second copy drifts: the report they fed called three stopped templates
 * unaffected, because the projection only ever described the one column this
 * module's own gate reads and said nothing about the header or the parameter count
 * the other gates read. The refresh is now performed and measured (see
 * applyRefresh + syncPreflight, which rolls it back), so there is exactly one
 * implementation of what a refresh does and nothing to keep in step with it.
 * Re-introducing a projection would re-introduce that class of defect. */


/** One template whose ability to send changes across a refresh. */
export interface SendabilityShift {
  name: string;
  language: string;
  /** 'campaigns' — still usable for replies and alerts, but a campaign is refused.
   *  'everything' — no WhatsApp message can be sent from it at all. */
  scope: 'campaigns' | 'everything';
  /** The gate's own words, so the report cannot drift from the refusal. */
  reason: string;
}

/* ═══════════ HOW "WHAT CAN SEND" IS MEASURED (injected, never guessed) ═══════════
 *
 * A refresh informs FOUR whole-queue gates, not one: the approval/category gate
 * that lives in this file, and — in wa-broadcast — the provider-name check, the
 * header the rail cannot fill, and the parameter count. All four read columns
 * only a refresh writes, so a report built on this file's gate alone called a
 * template "unaffected" and then Start refused it (MEASURED: Meta holding a
 * template APPROVED/MARKETING with an IMAGE header → header_unfillable, with the
 * card saying "nothing changes" and the report naming nobody).
 *
 * Those gates live in wa-broadcast, which imports this module — so asking them
 * from here directly would be an import cycle. Instead the caller hands in the
 * measurement, and the type makes it MANDATORY: a caller that forgets it does not
 * compile, rather than silently getting a weaker answer. The one production
 * caller (api/whatsapp/templates/sync) passes measureSendability(), which is the
 * very function the start door's gates are made of.
 */

/** What one template could send at the moment of measurement. */
export interface MeasuredTemplate {
  name: string;
  language: string;
  campaigns_ok: boolean;
  campaigns_reason: string;
  any_ok: boolean;
  any_reason: string;
  /**
   * WHAT WHATSAPP'S LIST SAID about this one, when it is worth telling the
   * owner and is not a reason to stop him. Empty when there is nothing to say.
   * It never affects campaigns_ok / any_ok — that is the point of it.
   */
  advisory?: string;
}

/** What one unfinished campaign could do at the moment of measurement. */
export interface MeasuredCampaign {
  id: string;
  name: string;
  template_name: string;
  state: string;
  ok: boolean;
  reason: string;
}

export interface SendabilityMeasurement {
  templates: MeasuredTemplate[];
  campaigns: MeasuredCampaign[];
  /**
   * THE PROBE COULD NOT SEE. Set by the probe itself when a read it needed
   * failed — an empty answer then means "nothing was measured", not "there is
   * nothing to lose". measureSendability catches its own database errors (so a
   * lock race cannot take the refresh down), which is right, and is exactly why
   * it must SAY so here: without this field an unreadable database and a venue
   * with no templates are the same value. See measure().
   */
  failed?: boolean;
}

/** `measureSendability` from wa-broadcast, passed in to avoid an import cycle. */
export type SendabilityProbe = (db: DB) => SendabilityMeasurement;

const EMPTY_MEASUREMENT: SendabilityMeasurement = { templates: [], campaigns: [] };

/**
 * A measurement that cannot take the refresh down. If the probe throws, the
 * refresh must still reconcile (that is the backstop the whole gate rests on) —
 * but it must NOT then report "nothing stopped", which would be a false clean
 * bill of health. A failed probe is reported as such by `probeFailed`.
 *
 * ── A THROW IS NOT THE FAILURE MODE THAT HAPPENS ───────────────────────────
 *
 * This function used to treat "the probe returned" as "the probe worked", and
 * the only production probe NEVER THROWS: measureSendability catches its own
 * database errors and returns an empty snapshot, deliberately, so that a lock
 * race cannot take a refresh down.
 *
 *   MEASURED, through the real HTTP route: one SQLITE_BUSY on the single
 *   `SELECT * FROM whatsapp_templates WHERE is_active = 1` — nothing else —
 *   turned a refresh that is correctly REFUSED as a total loss (409, rolled
 *   back, 11/11 intact) into `measured=true, stopped=0`, HTTP 200, applied, with
 *   the before-you-check card rendering emerald and headlined "Nothing you use
 *   would stop working". The flag whose whole job is to prevent a false clean
 *   bill of health was unreachable from production.
 *
 * So failure is established three ways, not one:
 *   1. the probe threw (the original case, still handled);
 *   2. the probe SAID it failed (`failed` on the snapshot — the direct fix);
 *   3. the probe answered with no templates while this database plainly has
 *      some. That cross-check is deliberately taken from a DIFFERENT statement
 *      than the probe's, so a probe that cannot read the table cannot also
 *      supply the number that would excuse it. If the cross-check itself cannot
 *      read, that too is a failure — an unreadable database is never a clean
 *      bill of health.
 */
function measure(probe: SendabilityProbe | undefined, db: DB): { m: SendabilityMeasurement; failed: boolean } {
  if (typeof probe !== 'function') return { m: EMPTY_MEASUREMENT, failed: true };
  let m: SendabilityMeasurement;
  try { m = probe(db); }
  catch { return { m: EMPTY_MEASUREMENT, failed: true }; }
  if (!m || !Array.isArray(m.templates) || !Array.isArray(m.campaigns)) {
    return { m: EMPTY_MEASUREMENT, failed: true };
  }
  if (m.failed) return { m, failed: true };
  if (!m.templates.length) {
    let liveRows = -1;
    try {
      const r = db.prepare(`SELECT COUNT(*) AS n FROM whatsapp_templates WHERE is_active = 1`).get() as any;
      liveRows = Number(r?.n ?? -1);
    } catch { liveRows = -1; }
    // -1 = the cross-check could not read either. >0 = the probe saw nothing the
    // database does have. Both are "nothing was measured".
    if (liveRows !== 0) return { m, failed: true };
  }
  return { m, failed: false };
}

/**
 * WHAT STOPPED — a diff of two measurements, and nothing else.
 *
 * Two questions per template, because a template serves two jobs: a campaign
 * (which Meta requires to be a MARKETING template, and which this rail must also
 * be able to fill) and the reply/alert messages (which only need approval). A row
 * that keeps the second but loses the first has still lost something worth
 * naming, and saying "it stopped" flat would be wrong.
 */
function stoppedBetween(before: SendabilityMeasurement, after: SendabilityMeasurement): SendabilityShift[] {
  const post = new Map(after.templates.map(t => [t.name, t]));
  const out: SendabilityShift[] = [];
  for (const b of before.templates) {
    const a = post.get(b.name);
    // Gone from the list entirely (deactivated mid-refresh): nothing to claim.
    if (!a) continue;
    if (b.any_ok && !a.any_ok) {
      out.push({ name: b.name, language: b.language, scope: 'everything', reason: a.any_reason });
      continue;
    }
    if (b.campaigns_ok && !a.campaigns_ok) {
      out.push({ name: b.name, language: b.language, scope: 'campaigns', reason: a.campaigns_reason });
    }
  }
  return out;
}

function campaignsStoppedBetween(
  before: SendabilityMeasurement,
  after: SendabilityMeasurement,
): SyncResult['campaigns_stopped'] {
  const post = new Map(after.campaigns.map(c => [c.id, c]));
  const out: SyncResult['campaigns_stopped'] = [];
  for (const b of before.campaigns) {
    const a = post.get(b.id);
    if (!a || !b.ok || a.ok) continue;
    out.push({ id: b.id, name: b.name, template_name: b.template_name, state: b.state, reason: a.reason });
  }
  return out;
}

/**
 * SHOULD THIS REFRESH PAUSE AND ASK, INSTEAD OF JUST LANDING?
 *
 * Two different things get asked here, and since the 2026-09-15 ruling they no
 * longer mean the same thing. Keeping them apart is the whole of `reason`:
 *
 *   'stops_all'  — every message this venue can send today would stop. After the
 *                  ruling only a STRUCTURAL fault can do that (a heading needing
 *                  a picture, a blank count that will not match), so this is rare
 *                  and it is real: `stopped` names every casualty.
 *
 *   'empty_list' — WhatsApp answered with no messages at all while this venue
 *                  plainly has some. NOTHING STOPS any more when that happens —
 *                  an unrecognised name is a warning now, not a refusal — so this
 *                  is no longer a loss to announce. It is still worth stopping
 *                  for, because an empty answer is the exact signature of the
 *                  WhatsApp Business Account ID or the access token pointing at
 *                  someone else's account, and saving it would paper every
 *                  message on the screen with a warning that is not true.
 *
 * WHY THE SPLIT EXISTS. Before it, 'empty_list' returned through the same door as
 * 'stops_all' and the owner was shown "this app currently sends 0: " followed by
 * the claim that every message would stop — a count of nothing, a list of nobody,
 * and an outcome this app no longer produces. Naming a consequence that will not
 * happen is the same defect the ruling was written to end, just pointing the
 * other way.
 *
 * ── TWO MORE, ADDED 2026-09-16 AFTER BOTH WERE MEASURED ────────────────────
 *
 *   'stops_all_campaigns'
 *                — every campaign this venue has would stop, while some template
 *                  survives. The guard used to count TEMPLATES ONLY and so did
 *                  not see this at all.
 *
 *                  MEASURED: Meta answering with ct_winback approved in `en`
 *                  against a campaign built in `te` stopped 1 of 1 campaigns —
 *                  100% of the estate — with needs_confirmation FALSE and the
 *                  refresh landing unasked. A campaign is the half of the estate
 *                  with a queue, a cost and a guest list attached; a guard whose
 *                  job is to stop before a total loss cannot be blind to it.
 *
 *   'not_measured'
 *                — the measurement failed, so this function has NO IDEA what
 *                  would stop. It used to read an empty measurement as "this
 *                  venue has nothing to lose" and wave the refresh through: the
 *                  empty_list and stops_all gates BOTH vanished on the one input
 *                  that means the guard cannot do its job. Fixing measure()'s
 *                  flag alone does not close this, because nothing here was ever
 *                  told the measurement failed — so it is now told.
 *
 * EVERY ONE OF THESE IS A PAUSE, NEVER A DEAD END. The refresh rolls back and
 * the owner is told what it could not vouch for; pressing Continue a second time
 * saves the same answer. Nothing here can refuse him twice.
 */
type PauseReason = '' | 'stops_all' | 'empty_list' | 'stops_all_campaigns' | 'not_measured';

function pauseAndAskReason(
  before: SendabilityMeasurement,
  stopped: SendabilityShift[],
  fetched: number,
  campaignsStopped: SyncResult['campaigns_stopped'],
  measured: boolean,
): PauseReason {
  if (!measured) return 'not_measured';
  const living = before.templates.filter(t => t.any_ok || t.campaigns_ok);
  const livingCampaigns = before.campaigns.filter(c => c.ok);
  if (!living.length && !livingCampaigns.length) return '';
  if (fetched === 0) return 'empty_list';
  const names = new Set(stopped.map(s => s.name));
  if (living.length && living.every(t => names.has(t.name))) return 'stops_all';
  const stoppedIds = new Set(campaignsStopped.map(c => c.id));
  if (livingCampaigns.length && livingCampaigns.every(c => stoppedIds.has(c.id))) return 'stops_all_campaigns';
  return '';
}

/** The messages this venue can send today — what an empty answer is measured against. */
function livingNames(before: SendabilityMeasurement): string[] {
  return before.templates.filter(t => t.any_ok || t.campaigns_ok).map(t => t.name);
}

/* ═══════════════════════ Undo the last refresh ═══════════════════════ */

/**
 * WHERE THE PREVIOUS STATE IS KEPT so a refresh is not a one-way door.
 *
 * Every column a refresh writes, for every row it could touch, plus the previous
 * watermark — captured inside the refresh's own transaction, so a refresh that
 * rolls back leaves no undo point and a refresh that lands leaves exactly one.
 * One row in `settings` (no schema change), overwritten by each refresh: the undo
 * is for the refresh you just pressed, not a history.
 */
export const SYNC_UNDO_KEY = 'wa_templates_sync_undo';

const UNDO_COLUMNS = [
  'meta_status', 'meta_category', 'meta_template_id', 'meta_components',
  'meta_rejected_reason', 'meta_status_checked_at', 'provider_template_name', 'provider_language',
] as const;

function captureUndoPoint(db: DB, rows: any[], watermarkBefore: string, takenAt: string): void {
  const snapshot = {
    taken_at: takenAt,
    watermark_before: watermarkBefore,
    rows: rows.map(r => {
      const o: any = { id: String(r.id), name: String(r.name || '') };
      for (const c of UNDO_COLUMNS) o[c] = r[c] === null || r[c] === undefined ? '' : String(r[c]);
      return o;
    }),
    adopted_ids: [] as string[],
  };
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(SYNC_UNDO_KEY, JSON.stringify(snapshot));
}

/** The 8 undoable columns of one row, as one comparable string. */
function undoFingerprint(row: any): string {
  return JSON.stringify(UNDO_COLUMNS.map(c => (row?.[c] === null || row?.[c] === undefined ? '' : String(row[c]))));
}

/**
 * WHAT THE REFRESH LEFT BEHIND, recorded so the undo can tell its own work from
 * somebody else's.
 *
 * The undo used to decide by TIMESTAMP — is meta_status_checked_at still the
 * refresh's? — and that is only as precise as the clock: utcString() writes
 * whole seconds, so a webhook arriving in the same second as the refresh is
 * indistinguishable from the refresh itself, and its status would be silently
 * overwritten. Comparing the VALUES has no resolution to lose. Written inside
 * the refresh's transaction, so a refresh that rolls back leaves nothing.
 */
function recordUndoAfterState(db: DB): void {
  try {
    const r = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(SYNC_UNDO_KEY) as any;
    const snap = JSON.parse(String(r?.value || '{}'));
    if (!snap || !Array.isArray(snap.rows)) return;
    const after: Record<string, string> = {};
    for (const row of snap.rows) {
      const cur = db.prepare(`SELECT * FROM whatsapp_templates WHERE id = ?`).get(String(row.id)) as any;
      if (cur) after[String(row.id)] = undoFingerprint(cur);
    }
    snap.after = after;
    db.prepare(`UPDATE settings SET value = ? WHERE key = ?`).run(JSON.stringify(snap), SYNC_UNDO_KEY);
  } catch {
    /* No after-state recorded → undoLastSync falls back to the timestamp rule,
     * which is weaker but never wrong in the direction of losing data. */
  }
}

function recordAdoption(db: DB, id: string): void {
  try {
    const r = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(SYNC_UNDO_KEY) as any;
    const snap = JSON.parse(String(r?.value || '{}'));
    if (!Array.isArray(snap.adopted_ids)) snap.adopted_ids = [];
    snap.adopted_ids.push(id);
    db.prepare(`UPDATE settings SET value = ? WHERE key = ?`).run(JSON.stringify(snap), SYNC_UNDO_KEY);
  } catch { /* an unrecorded adoption is a row the undo leaves in place, not a failure */ }
}

export interface UndoResult {
  ok: boolean;
  error?: string;
  /** When the refresh being undone ran. */
  taken_at: string;
  restored: number;
  removed: string[];
  /** Adopted rows left alone because a campaign now depends on them. */
  kept: Array<{ name: string; why: string }>;
  /**
   * ROWS SOMETHING ELSE HAS CHANGED SINCE THE REFRESH, left exactly as they are.
   * Undoing a refresh must not also undo a WhatsApp status that arrived after
   * it, or a template the owner submitted after it. Named so the answer can say
   * what it did NOT put back.
   */
  skipped: Array<{ name: string; why: string }>;
  /** The watermark the app is back to ('' = never checked, the original state). */
  watermark: string;
}

/**
 * PUT IT BACK THE WAY IT WAS.
 *
 * The refresh is the one action here that changes what the whole venue can send,
 * and until this existed nothing in the app could reverse it: `lastSyncAt` had a
 * writer and no eraser, the generic settings door refuses `wa_` keys, and the
 * WhatsApp config route writes only its own whitelist — so a single press was
 * final, recoverable only by hand-editing the production database. An informed
 * choice with no way back is still a trap.
 *
 * Restores every column the refresh wrote, removes the rows it adopted (except
 * any a campaign has since been built on — those are kept and named, because
 * deleting them would break the campaign), and puts the watermark back to what it
 * was. An empty watermark means "never checked", which is the permissive state
 * the app shipped in: undoing returns exactly there and claims nothing more.
 *
 * Consumes the undo point, so it cannot be applied twice.
 *
 * ── IT PUTS BACK THE REFRESH, NOT THE CLOCK (2026-09-16) ───────────────────
 *
 * The restore used to write the snapshot over every row UNCONDITIONALLY, which
 * is only correct while the refresh is the last thing that touched them. Two
 * other writers reach the same columns, and both were silently discarded:
 *
 *   MEASURED. A refresh recorded ct_birthday as approved; Meta then pushed
 *   DISABLED/SCAM by webhook and the broadcast picker showed it; the undo wiped
 *   the status, the reason and the checked-at time, said nothing about having
 *   done so, and left no app path able to re-apply it. Under the advisory design
 *   that is not just a lost value — it deletes the WARNING, which is the only
 *   thing the redesigned system still relies on, for a template WhatsApp killed.
 *
 *   MEASURED. A template SUBMITTED after the refresh came back to meta_status ''
 *   and meta_template_id '' while meta_submitted_at stayed — a torn row no other
 *   path can produce, on which the duplicate-name guard stops firing, so the next
 *   submit goes to Meta and returns a duplicate-name rejection.
 *
 * So each row is put back only where the REFRESH'S OWN STAMP is still the latest
 * one on it (meta_status_checked_at === the refresh's checked-at). Anything
 * newer is left untouched and named in `skipped`. Rows the refresh never changed
 * are left alone too, which also stops the undo bumping `updated_at` on rows it
 * has nothing to say about.
 */
export function undoLastSync(db: DB): UndoResult {
  const out: UndoResult = { ok: true, taken_at: '', restored: 0, removed: [], kept: [], skipped: [], watermark: '' };
  let snap: any;
  try {
    const r = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(SYNC_UNDO_KEY) as any;
    snap = JSON.parse(String(r?.value || 'null'));
  } catch { snap = null; }
  if (!snap || !Array.isArray(snap.rows)) {
    return {
      ...out, ok: false,
      error: 'There is no template refresh to undo. An undo point is kept only for the most recent refresh, and it is used up once it has been applied.',
    };
  }

  out.taken_at = String(snap.taken_at || '');
  out.watermark = String(snap.watermark_before || '');

  const restore = db.prepare(`
    UPDATE whatsapp_templates
    SET meta_status = ?, meta_category = ?, meta_template_id = ?, meta_components = ?,
        meta_rejected_reason = ?, meta_status_checked_at = ?,
        provider_template_name = ?, provider_language = ?, updated_at = datetime('now')
    WHERE id = ?
  `);

  const current = db.prepare(`SELECT * FROM whatsapp_templates WHERE id = ?`);
  /* WHAT THE REFRESH LEFT, per row. Absent only on an undo point written before
   * this existed, where the weaker timestamp rule is used instead. */
  const afterState: Record<string, string> | null =
    snap.after && typeof snap.after === 'object' ? snap.after : null;

  db.transaction(() => {
    for (const row of snap.rows) {
      const now = current.get(String(row.id)) as any;
      if (!now) continue;                       // deleted since — nothing to put back

      // Is this row still exactly as the snapshot left it? Then there is nothing
      // to undo on it, and writing would only move `updated_at`.
      const unchanged = UNDO_COLUMNS.every(c =>
        String(now[c] ?? '') === String(row[c] ?? ''));
      if (unchanged) continue;

      /* HAS ANYTHING WRITTEN TO THIS ROW SINCE THE REFRESH?
       *
       * Answered by comparing the row against what the refresh actually left on
       * it — not by its timestamp, which carries whole seconds and so cannot
       * separate a webhook that arrived in the same second as the refresh from
       * the refresh itself. A row that no longer matches is not the refresh's to
       * take back. */
      const expected = afterState ? afterState[String(row.id)] : undefined;
      const movedSince = expected !== undefined
        ? undoFingerprint(now) !== expected
        : String(now.meta_status_checked_at ?? '') !== String(snap.taken_at || '');
      if (movedSince) {
        out.skipped.push({
          name: String(now.name || row.name || ''),
          why: `It was changed again after that check — WhatsApp now says "${String(now.meta_status || '') || 'nothing'}"${now.meta_status_checked_at ? `, recorded ${istWhen(String(now.meta_status_checked_at))}` : ''} — so it has been left exactly as it is. Putting the old answer back would throw that newer one away.`,
        });
        continue;
      }

      const r = restore.run(
        String(row.meta_status ?? ''), String(row.meta_category ?? ''), String(row.meta_template_id ?? ''),
        String(row.meta_components ?? ''), String(row.meta_rejected_reason ?? ''),
        String(row.meta_status_checked_at ?? ''), String(row.provider_template_name ?? ''),
        String(row.provider_language ?? ''), String(row.id),
      );
      out.restored += r.changes;
    }
    for (const id of (Array.isArray(snap.adopted_ids) ? snap.adopted_ids : [])) {
      const row = db.prepare(`SELECT id, name FROM whatsapp_templates WHERE id = ?`).get(String(id)) as any;
      if (!row) continue;
      const users = campaignsUsingTemplate(db, String(row.name));
      if (users.length) {
        out.kept.push({
          name: String(row.name),
          why: `${users.length} campaign(s) have been built on it since the refresh: ${users.map(c => `"${c.name}" (${c.state})`).join(', ')}. Removing it would leave them pointing at nothing.`,
        });
        continue;
      }
      db.prepare(`DELETE FROM whatsapp_templates WHERE id = ?`).run(String(id));
      out.removed.push(String(row.name));
    }
    setLastSyncAt(db, out.watermark);
    db.prepare(`DELETE FROM settings WHERE key = ?`).run(SYNC_UNDO_KEY);
  })();

  return out;
}

/** Is a one-press undo of the last refresh still available? */
export function syncUndoAvailable(db: DB): { available: boolean; taken_at: string } {
  try {
    const r = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(SYNC_UNDO_KEY) as any;
    const snap = JSON.parse(String(r?.value || 'null'));
    if (snap && Array.isArray(snap.rows)) return { available: true, taken_at: String(snap.taken_at || '') };
  } catch { /* unreadable → no undo offered, never a crash */ }
  return { available: false, taken_at: '' };
}

/**
 * Reconcile every local lifecycle row against Meta's list.
 *
 * IDENTITY IS (name, language) — Meta's, not ours. Our table is UNIQUE(name),
 * which cannot hold the same template in two languages; that case is REPORTED
 * (name_conflicts) rather than resolved by overwriting a row.
 *
 * Requests ALL statuses (unlike /api/whatsapp/meta-templates, whose dropdown
 * only wants APPROVED) — a PAUSED or REJECTED template is exactly what this
 * needs to see. Also asks for `id` and `rejected_reason`, which that route
 * never requested.
 */
export async function syncTemplateStatuses(
  db: DB,
  opts: SyncOptions,
): Promise<SyncResult> {
  const creds = metaCreds();
  if (!creds.ok) return { ...emptySync(), ok: false, error: creds.error };

  const doFetch: FetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const list = await fetchMetaTemplateList(creds.creds, doFetch);
  if (!list.ok) return { ...emptySync(), ok: false, error: list.error };

  return applyRefresh(db, list.data, utcString(opts.nowMs ?? Date.now()), opts).result;
}

/**
 * THE REFRESH ITSELF — everything after the network call, synchronously.
 *
 * Split out for ONE reason: syncPreflight answers "what would this do?" by
 * running THIS function inside a transaction it then rolls back. The dry run and
 * the real thing are therefore the same code applied to the same database, and
 * the card cannot describe a different outcome from the one the report will show.
 * Projecting the write instead of performing it is exactly how three stopped
 * templates came to be reported as unaffected.
 *
 * Returns the two measurements alongside the result, because the dry run needs
 * the per-template before/after standing and the API response does not.
 */
interface RefreshRun {
  result: SyncResult;
  before: SendabilityMeasurement;
  after: SendabilityMeasurement;
}

function applyRefresh(
  db: DB,
  remote: any[],
  now: string,
  opts: { impact: SendabilityProbe; allowStops?: boolean },
): RefreshRun {
  const out = emptySync();
  out.fetched = remote.length;
  out.checked_at = now;
  let afterM: SendabilityMeasurement = EMPTY_MEASUREMENT;

  // Meta's list is grouped by NAME first, because our table is UNIQUE(name) and
  // Meta is not: the same name can appear in several languages, and which of
  // them a local row corresponds to cannot be decided one entry at a time.
  // Deciding it entry-by-entry is what produced two bugs at once — a row whose
  // language merely SPELLS differently (en vs en_US) was refused forever, and a
  // row whose language is genuinely gone from Meta kept a stale 'approved'.
  const remoteByName = groupRemoteByName(remote);
  const syncedBefore = lastSyncAt(db);

  /* WHAT CAN SEND RIGHT NOW — every gate, measured, before a single row moves.
   * Taken outside the transaction because the "before" side stops existing the
   * moment the write lands. */
  const before = measure(opts.impact, db);

  /* THE WRITE, THE MEASUREMENT AND THE VERDICT ARE ONE TRANSACTION.
   *
   * The refresh is applied, the watermark is stamped, and THEN the same
   * measurement is taken again — so "after" is the real state of the real
   * database as this refresh leaves it, answered by the same functions the start
   * door calls. No projection of what the write would have done, which is how a
   * report came to call three stopped templates unaffected.
   *
   * If that answer is that everything stopped and nobody confirmed it, the whole
   * transaction rolls back: the numbers were still measured, and not one row was
   * changed. */
  /* A BOX, not a bare `let`. TypeScript does not track assignments made inside a
   * callback, so a `let x: T | null = null` written to inside the transaction
   * narrows to `never` for every reader after it — and the refusal below would
   * have been dead code the compiler was happy with. */
  const refused: { shifts: SendabilityShift[] | null; reason: PauseReason } = { shifts: null, reason: '' };
  const ROLLBACK = new Error('__wa_sync_rollback__');

  const tx = db.transaction(() => {
    const locals = db.prepare(`SELECT * FROM whatsapp_templates`).all() as any[];
    const byName = new Map<string, any>();
    for (const l of locals) byName.set(String(l.name), l);

    /* THE WAY BACK, captured inside the transaction: a refresh that rolls back
     * leaves no undo point, and one that lands leaves exactly one. */
    captureUndoPoint(db, locals, syncedBefore, now);

    const seenLocalIds = new Set<string>();

    const updateRow = db.prepare(`
      UPDATE whatsapp_templates
      SET meta_status = ?, meta_category = ?, meta_template_id = ?, meta_components = ?,
          meta_rejected_reason = ?, meta_status_checked_at = ?,
          provider_template_name = ?, provider_language = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `);
    // ── PASS 1: reconcile every LOCAL row against its name's Meta entries ──
    for (const [name, entries] of remoteByName) {
      const local = byName.get(name);
      if (!local) continue;                       // adoption is pass 2

      const localLang = String(local.provider_language || local.language || '').trim();
      const match = pickLanguageMatch(entries, localLang);

      if (!match) {
        // Meta has this NAME, but only in languages this row is not. Identity
        // is (name, language), so from Meta's point of view this row's template
        // does not exist — and it MUST NOT keep whatever status it last had.
        // Leaving it out of seenLocalIds drops it into the sweep below, which
        // marks a managed row unknown_at_meta (an unmanaged, free-form row is
        // still left completely alone there).
        out.name_conflicts.push({
          name,
          local_language: localLang,
          meta_language: entries.map(e => String(e?.language ?? '').trim()).filter(Boolean).join(', '),
        });
        continue;
      }

      const language = String(match?.language ?? '').trim();
      const status = mapMetaStatus(match?.status);
      const category = String(match?.category ?? '').toUpperCase();
      const metaId = String(match?.id ?? '').trim();
      const reason = String(match?.rejected_reason ?? '').trim();
      const comps = JSON.stringify(Array.isArray(match?.components) ? match.components : []);

      // Other languages of the same name are still unstorable here (UNIQUE(name)).
      // Report them so an admin who needs both knows to rename one — but this is
      // now INFORMATIONAL: the row itself reconciled fine.
      for (const other of entries) {
        const ol = String(other?.language ?? '').trim();
        if (other !== match && ol && ol !== language) {
          out.name_conflicts.push({ name, local_language: language, meta_language: ol });
        }
      }

      seenLocalIds.add(String(local.id));

      const from = String(local.meta_status || '');
      if (from !== status || String(local.meta_rejected_reason || '') !== reason) {
        out.updated.push({ name, language, from, to: status, reason: reason || undefined });
        if (from === 'approved' && status !== 'approved') {
          out.regressed.push({ name, language, from, to: status, reason: reason || undefined });
        }
      }

      updateRow.run(
        status, category, metaId, comps, reason, now,
        // On approval the provider identity is what makes the row usable by the
        // EXISTING consumers (inbox picker, notifyEvent). Written for every
        // status so the row never claims an identity Meta does not have — and
        // when Meta spells the language differently (en_US for our en) THIS is
        // where the row learns Meta's spelling, which is the identity a send
        // must actually use.
        name, language || localLang,
        local.id,
      );
    }

    // ── PASS 2: ADOPT names Meta has that this app has never recorded ──
    for (const [name, entries] of remoteByName) {
      if (byName.has(name)) continue;
      const [first, ...rest] = entries;
      const language = String(first?.language ?? '').trim();
      const status = mapMetaStatus(first?.status);
      const category = String(first?.category ?? '').toUpperCase();
      const metaId = String(first?.id ?? '').trim();
      const reason = String(first?.rejected_reason ?? '').trim();
      const comps = JSON.stringify(Array.isArray(first?.components) ? first.components : []);

      // Adopting is what makes an externally-approved template usable here (and
      // visible to the inbox picker, which needs send_as_template=1 AND
      // provider_template_name).
      const id = generateId();
      db.prepare(`
        INSERT INTO whatsapp_templates
          (id, name, category, language, body, is_active,
           provider_template_name, provider_language, param_order, send_as_template,
           meta_template_id, meta_status, meta_category, meta_components,
           meta_rejected_reason, meta_status_checked_at, var_spec)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, name,
        // Local label mirrors Meta's category so the broadcast picker's
        // "marketing first" ordering keeps working for adopted rows.
        category === 'MARKETING' ? 'marketing' : 'notification',
        language || 'en',
        bodyFromComponents(first?.components) || `[adopted from Meta] ${name}`,
        1,
        name, language,
        '[]',
        status === 'approved' ? 1 : 0,
        metaId, status, category, comps,
        reason, now, '[]',
      );
      out.adopted.push({ name, language, status });
      // Remembered so an undo can take back exactly the rows this refresh added.
      recordAdoption(db, id);

      // The remaining languages of that name cannot be stored: UNIQUE(name).
      for (const other of rest) {
        const ol = String(other?.language ?? '').trim();
        if (ol && ol !== language) out.name_conflicts.push({ name, local_language: language, meta_language: ol });
      }
    }

    // Local rows that WE submitted but Meta's list does not contain. Only
    // managed rows: a pre-existing free-form row (meta_status = '') is not at
    // Meta by design and must NOT be touched.
    for (const l of locals) {
      if (seenLocalIds.has(String(l.id))) continue;
      const st = String(l.meta_status || '');
      if (!isManagedStatus(st)) continue;      // unmanaged → leave exactly as-is
      if (st === 'draft') continue;            // never submitted → not expected at Meta
      if (st === 'unknown_at_meta') continue;  // already marked
      db.prepare(`
        UPDATE whatsapp_templates
        SET meta_status = 'unknown_at_meta', meta_status_checked_at = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(now, l.id);
      const lang = String(l.provider_language || l.language || '');
      out.missing_at_meta.push({ name: String(l.name), language: lang });
      out.updated.push({ name: String(l.name), language: lang, from: st, to: 'unknown_at_meta' });
      if (st === 'approved') {
        out.regressed.push({ name: String(l.name), language: lang, from: st, to: 'unknown_at_meta' });
      }
    }

    setLastSyncAt(db, now);

    /* WHAT THIS REFRESH LEAVES BEHIND, so an undo can tell its own work from a
     * status that arrives afterwards. See recordUndoAfterState. */
    recordUndoAfterState(db);

    /* AND NOW ASK AGAIN — the same measurement, on the database as this refresh
     * has just left it, watermark included. The diff of the two is `stopped`. */
    const after = measure(opts.impact, db);
    afterM = after.m;
    out.stopped = stoppedBetween(before.m, after.m);
    out.campaigns_stopped = campaignsStoppedBetween(before.m, after.m);
    out.measured = !before.failed && !after.failed;

    const pause = opts.allowStops
      ? ''
      : pauseAndAskReason(before.m, out.stopped, out.fetched, out.campaigns_stopped, out.measured);
    if (pause) {
      refused.shifts = out.stopped;
      refused.reason = pause;
      throw ROLLBACK;                            // nothing above this line survives
    }
  });

  try {
    tx();
    out.applied = true;
    out.undo_available = true;
  } catch (e) {
    if (e !== ROLLBACK) throw e;
    out.applied = false;
  }

  const blocked = refused.shifts;
  if (blocked) {
    const names = blocked.map(s => `"${s.name}"`).join(', ');
    /* WHAT THIS VENUE CAN SEND TODAY — counted from the measurement, not from
     * `stopped`. On an empty answer `stopped` is correctly EMPTY (nothing stops
     * any more), and reading the count off it printed "currently sends 0: ". */
    const living = livingNames(before.m);
    const livingList = living.map(n => `"${n}"`).join(', ');
    const campNames = out.campaigns_stopped.map(c => `"${c.name}"`).join(', ');
    let error: string;
    switch (refused.reason) {
      case 'empty_list':
        error = `WhatsApp answered with no messages at all, though ${living.length} ${living.length === 1 ? 'is' : 'are'} set up here: ${livingList}. That usually means the WhatsApp Business Account ID or the access token on this page belongs to a different WhatsApp account than the one these were approved on — worth checking both before you save this answer. Nothing has been changed, and none of them would stop working either way: saving this would only mark every one of them with a warning that may not be true. If WhatsApp really does hold none of them, press Continue again to save it anyway.`;
        break;
      case 'stops_all_campaigns':
        /* THE HALF OF THE ESTATE THAT HAS A GUEST LIST ATTACHED. Every campaign
         * would stop while the messages themselves survive, so the sentence must
         * not claim the templates stopped — it names the campaigns and the gate's
         * own reason for each. */
        error = `Saving this answer would stop every campaign this venue has (${out.campaigns_stopped.length}: ${campNames}), even though the messages themselves keep working. ${out.campaigns_stopped.length === 1 ? 'The reason is' : 'The first reason is'}: ${out.campaigns_stopped[0]?.reason || 'the campaign no longer matches what WhatsApp holds.'} Nothing has been changed. Check that the WhatsApp Business Account ID and access token on this page belong to the account these were approved on — and if they do, press Continue again to save it anyway.`;
        break;
      case 'not_measured':
        /* THE HONEST ANSWER TO "WHAT WOULD THIS DO?" IS SOMETIMES "I COULD NOT
         * TELL". Saying nothing stopped would be the false clean bill of health
         * this whole path exists to prevent. */
        error = `This app could not work out what saving WhatsApp's answer would do to what you can send — the check that measures it did not complete, so nothing below can be trusted as a list of what would stop. Nothing has been changed. Try again in a moment; if it keeps happening, press Continue again to save the answer anyway — and you can still put it back afterwards.`;
        break;
      default:
        error = `Saving this answer would stop every message this venue can send (${blocked.length}: ${names}) — not because of anything WhatsApp said about them, but because each one needs something a broadcast cannot supply. Nothing has been changed. Check that the WhatsApp Business Account ID and access token on this page belong to the account these were approved on — and if they do, press Continue again to save it anyway.`;
    }
    return {
      result: { ...out, ok: false, needs_confirmation: true, error },
      before: before.m,
      after: afterM,
    };
  }

  return { result: out, before: before.m, after: afterM };
}

/* ═════════════ Before you refresh: what will this actually do? ═════════════ */

/** One template, as it stands and as a refresh would leave it. */
export interface PreflightRow {
  name: string;
  /** The language this app holds for it (the one campaigns are built with). */
  language: string;
  /** Does Meta's list contain this name at all? */
  at_meta: boolean;
  /** Meta's status for it, in this app's words ('' when Meta does not have it). */
  meta_status: string;
  /** Meta's category ('' when Meta does not have it). */
  meta_category: string;
  /** Can a CAMPAIGN send from it right now / after a refresh? */
  campaigns_now: boolean;
  campaigns_after: boolean;
  /** Can ANY WhatsApp message be sent from it right now / after a refresh? */
  any_now: boolean;
  any_after: boolean;
  verdict: 'keeps_working' | 'stops_campaigns' | 'stops_everything' | 'starts_working' | 'still_unusable';
  /** What to tell the owner about this row, in his words. */
  note: string;
  /**
   * WHAT WHATSAPP'S LIST SAYS about this one — shown, never acted on. A message
   * WhatsApp has on hold, or one its list does not contain, still sends from
   * here; this is how the owner finds out it may be turned down. Empty when
   * there is nothing to say.
   */
  advice: string;
}

export interface PreflightResult {
  ok: boolean;
  error?: string;
  /** How many templates Meta answered with. */
  fetched: number;
  /** True when Meta's list has never been pulled before — the risky press. */
  first_check: boolean;
  rows: PreflightRow[];
  /** The subset whose verdict takes something away. This is the "at risk" list. */
  at_risk: PreflightRow[];
  /** Campaigns that can be started now and could not be after the refresh. */
  campaigns_at_risk: Array<{ id: string; name: string; template_name: string; state: string; reason: string }>;
  /** Templates Meta has that this app has never recorded — a refresh adds them. */
  new_at_meta: Array<{ name: string; language: string; status: string }>;
  /**
   * THE REFRESH WILL STOP AND ASK, **AND** THE REASON IS ONE THE "every message
   * this venue can send" SENTENCE FITS. It is the flag the red banner is drawn
   * from, so it is deliberately NARROWER than `total_loss_reason`.
   *
   * READ `total_loss_reason` BEFORE WORDING ANYTHING OFF THIS FLAG. Since the
   * 2026-09-15 ruling the reasons mean different things to the reader, and a
   * screen that leads with "everything would stop" on the empty-list one is
   * describing something this app no longer does.
   *
   * TWO REASONS ARE DELIBERATELY EXCLUDED, because the banner's own words would
   * be false for them and a false red banner is a refusal by another route:
   *   'stops_all_campaigns' — the MESSAGES keep working; it is the campaigns
   *                           that stop, and `campaigns_at_risk` names them.
   *   'not_measured'        — nothing is known to stop; the check did not
   *                           answer, and `measured: false` is that story.
   * Both still make the refresh pause and ask — read `total_loss_reason` if you
   * need to say so on screen.
   */
  total_loss: boolean;
  /**
   * WHY it will stop and ask:
   *   'stops_all'  — every message really would stop, and `at_risk` names them.
   *                  Only a structural fault can do this now.
   *   'empty_list' — WhatsApp returned nothing at all while this venue has
   *                  messages set up. NOTHING STOPS; the answer itself looks
   *                  wrong (usually the wrong WhatsApp account), and saving it
   *                  would only mark every message with a warning that may be
   *                  untrue. `at_risk` is empty here, and that is correct.
   *   'stops_all_campaigns'
   *                — every CAMPAIGN would stop while the messages themselves
   *                  keep working. `at_risk` may be empty; `campaigns_at_risk`
   *                  is the list that matters here, and a screen that reads
   *                  "nothing would stop working" off `at_risk` alone is wrong.
   *   'not_measured'
   *                — the measurement did not complete, so NOTHING on this card
   *                  is a claim about what would stop. Never word this one as an
   *                  all-clear: `measured` is false and that is the headline.
   *   ''           — it will not stop and ask.
   */
  total_loss_reason: '' | 'stops_all' | 'empty_list' | 'stops_all_campaigns' | 'not_measured';
  /** The check itself ran end to end. False = do not read "nothing stops" into it. */
  measured: boolean;
  checked_at: string;
}

/**
 * WHAT WILL "REFRESH" DO TO WHAT I CAN SEND? — asked BEFORE anything is written.
 *
 * WHY THIS EXISTS — AND WHAT CHANGED UNDER IT (ruling 2026-09-15).
 *
 * It was built because a refresh could take the venue's whole ability to send.
 * Every template here was sendable for ONE reason — Meta's list had never been
 * pulled — and the first pull removed that reason for every row at once, so a
 * name the list did not contain stopped being usable. Pressing one button and
 * finding out afterwards which messages stopped is not an acceptable way to
 * learn that, so this card was written to say it in advance.
 *
 * THAT CAUSE IS NOW GONE at the root: absence from the list is a warning, never a
 * refusal (see sendabilityFrom). So this card's list is no longer the point of
 * the feature — most refreshes will name nothing at all, and that is the correct
 * answer rather than a broken one.
 *
 * IT STILL EARNS ITS PLACE, for two things the ruling did not touch:
 *   • A STRUCTURAL loss is real and a refresh can still cause one — Meta's
 *     components are what teach this app that a template has a picture heading,
 *     or more blanks than the campaign fills. Those refuse at Start whatever any
 *     list says, and they are exactly the losses that used to ship silently.
 *   • AN ANSWER THAT LOOKS WRONG. An empty list, or one from another WhatsApp
 *     account, is worth seeing before it is saved — not because it stops a send
 *     now, but because it would mark every message here with a warning that is
 *     not true. See `total_loss_reason`, which keeps those two apart.
 *
 * HOW IT ANSWERS: BY DOING IT AND UNDOING IT.
 *
 * The refresh is applied for real, inside a transaction, measured with the very
 * gates the start door uses, and then the transaction is ROLLED BACK. Nothing
 * survives it — no status, no adoption, not the "last checked" time — and the
 * suite proves that by comparing every column of every row, and the whole
 * settings table, before and after.
 *
 * It works this way because the alternative does not. The first version of this
 * card PROJECTED what the write would do and asked one of the four whole-queue
 * gates about the projection. Both halves failed: a template Meta held APPROVED
 * as MARKETING with an IMAGE header was reported "unaffected · nothing changes"
 * and then refused at Start with header_unfillable, and the projection was a
 * second copy of the write's rules that could drift from it. Performing the real
 * write and asking the real gates cannot drift from the real write and the real
 * gates.
 *
 * IT IS NOT A GUESS ABOUT META'S ANSWER. It is Meta's actual answer, applied to
 * the actual rules, before the actual write. The only way it can be wrong is if
 * Meta's list changes between this call and the refresh.
 */
export async function syncPreflight(
  db: DB,
  opts: SyncOptions,
): Promise<PreflightResult> {
  const out: PreflightResult = {
    ok: true, fetched: 0, first_check: !lastSyncAt(db), rows: [], at_risk: [],
    campaigns_at_risk: [], new_at_meta: [], total_loss: false, total_loss_reason: '', measured: false, checked_at: '',
  };
  const creds = metaCreds();
  if (!creds.ok) return { ...out, ok: false, error: creds.error };

  const doFetch: FetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const list = await fetchMetaTemplateList(creds.creds, doFetch);
  if (!list.ok) return { ...out, ok: false, error: list.error };

  const remote = list.data;
  out.fetched = remote.length;
  const remoteByName = groupRemoteByName(remote);

  // A refresh stamps a real time; any non-empty value produces the same gate
  // answer, and this one is never committed.
  const syncedAfter = utcString(opts.nowMs ?? Date.now());
  out.checked_at = syncedAfter;

  /* ── THE DRY RUN: the real refresh, then rolled back ──
   * allowStops is set because this is not the moment to refuse anything — the
   * whole point is to SHOW the losses, including the ones the real refresh will
   * then insist on having confirmed. */
  const run: { done: RefreshRun | null } = { done: null };
  const ROLLBACK = new Error('__wa_preflight_rollback__');
  try {
    db.transaction(() => {
      run.done = applyRefresh(db, remote, syncedAfter, { impact: opts.impact, allowStops: true });
      throw ROLLBACK;
    })();
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }

  const sim = run.done;
  if (!sim) {
    return {
      ...out, ok: false,
      error: 'The before-you-refresh check could not be completed, so nothing is being claimed about what a refresh would do. Nothing has been changed. Try again.',
    };
  }

  out.measured = sim.result.measured;
  const beforeBy = new Map(sim.before.templates.map(t => [t.name, t]));
  const afterBy = new Map(sim.after.templates.map(t => [t.name, t]));

  for (const [name, b] of beforeBy) {
    const a = afterBy.get(name);
    if (!a) continue;
    const entries = remoteByName.get(name) || [];
    const match = entries.length ? pickLanguageMatch(entries, b.language) : undefined;

    let verdict: PreflightRow['verdict'];
    let note: string;
    if (b.any_ok && !a.any_ok) {
      verdict = 'stops_everything';
      note = a.any_reason;
    } else if (b.campaigns_ok && !a.campaigns_ok) {
      verdict = 'stops_campaigns';
      note = a.campaigns_reason;
    } else if (!b.any_ok && a.any_ok) {
      verdict = 'starts_working';
      note = `Meta has this one approved, so after the check it can be used${a.campaigns_ok ? ', campaigns included' : ' for replies and alerts (a campaign still needs a marketing template)'}.`;
    } else if (a.any_ok) {
      verdict = 'keeps_working';
      /* SAY WHAT WHATSAPP ACTUALLY SAID, not merely that the name was on the
       * list. This line used to read "Meta has this one approved" whenever the
       * name appeared in the answer AT ALL — so a message WhatsApp had turned
       * down or put on hold was described to the owner as approved. Being on
       * the list and being approved are two different facts and only one of
       * them was ever checked here. */
      const said = match ? mapMetaStatus(match?.status) : '';
      note = !match
        ? 'Nothing changes.'
        : said === 'approved'
          ? `WhatsApp has approved this one${a.campaigns_ok ? ', offers included' : ''}, so nothing changes.`
          : said
            ? `WhatsApp has this one, and lists it as "${said}" rather than approved — that does not stop you sending it from here, but WhatsApp may turn it down.`
            : 'WhatsApp has this one. Nothing changes.';
      // A row that keeps replies but could not run a campaign before and cannot
      // after has not "stopped" — but saying "nothing changes" without saying it
      // is not usable for a campaign would be a half-truth on this screen.
      if (!a.campaigns_ok && a.campaigns_reason) note = `${note} It still cannot be used for an offer to your guest list: ${a.campaigns_reason}`;
    } else {
      verdict = 'still_unusable';
      note = a.any_reason || b.any_reason;
    }

    const row: PreflightRow = {
      name,
      language: b.language,
      at_meta: !!match,
      meta_status: match ? mapMetaStatus(match?.status) : '',
      meta_category: match ? String(match?.category ?? '').toUpperCase() : '',
      campaigns_now: b.campaigns_ok,
      campaigns_after: a.campaigns_ok,
      any_now: b.any_ok,
      any_after: a.any_ok,
      verdict,
      note,
      // The measurement's own note, taken from the gate that produced it — so
      // the screen cannot describe WhatsApp's answer differently from the way
      // the campaign screen will describe it.
      advice: String(a.advisory || ''),
    };
    out.rows.push(row);
    if (verdict === 'stops_everything' || verdict === 'stops_campaigns') out.at_risk.push(row);
  }

  out.campaigns_at_risk = sim.result.campaigns_stopped;
  /* ASKED WITH THE SAME ARGUMENTS THE REFRESH WILL ASK IT WITH, including the
   * campaigns and whether the measurement worked — otherwise the card promises a
   * quiet save and the refresh then stops and asks, which is the same drift the
   * whole measure-don't-project design was built to remove. */
  out.total_loss_reason = pauseAndAskReason(
    sim.before, sim.result.stopped, out.fetched, sim.result.campaigns_stopped, out.measured,
  );
  /* NARROWER THAN THE PAUSE, ON PURPOSE — see the note on `total_loss`. The two
   * reasons added on 2026-09-16 make the refresh stop and ask, but the banner
   * this flag draws says "this would stop EVERY message this venue can send",
   * and that sentence is false for both of them. A red banner that is not true
   * stops the owner pressing a button he should press, which is the same harm as
   * a refusal, pointed the other way. */
  out.total_loss = out.total_loss_reason === 'stops_all' || out.total_loss_reason === 'empty_list';

  /* THE CARD AND THE REPORT MUST NAME THE SAME THINGS. Both lists come from the
   * same simulation, so this is an invariant rather than a coincidence — but it
   * is asserted here because a future edit to either list should fail loudly. */
  const simStopped = new Set(sim.result.stopped.map(s => s.name));
  for (const r of out.at_risk) {
    if (!simStopped.has(r.name)) {
      out.rows = out.rows.map(x => (x.name === r.name ? { ...x, note: `${x.note} (reported by the screen only — the refresh report would not list this; please report this message)` } : x));
    }
  }

  const localNames = new Set(
    (db.prepare(`SELECT name FROM whatsapp_templates`).all() as any[]).map(r => String(r.name)),
  );
  for (const [name, entries] of remoteByName) {
    if (localNames.has(name)) continue;
    const first = entries[0];
    out.new_at_meta.push({
      name,
      language: String(first?.language ?? '').trim(),
      status: mapMetaStatus(first?.status),
    });
  }

  return out;
}

/* ═══════════════ Webhook authenticity (X-Hub-Signature-256) ═══════════════ */

/**
 * IS THIS WEBHOOK REALLY FROM META?
 *
 * The webhook URL is public by necessity — Meta has to be able to reach it
 * without a login. Until this check existed, anyone who learned the address
 * could POST whatever they liked into it: invented guest messages in the inbox,
 * invented delivery receipts against a real campaign, invented template status
 * changes. Every one of those is written to the venue's own records and read
 * back as fact.
 *
 * Meta signs each POST with `X-Hub-Signature-256: sha256=<hex>`, an HMAC-SHA256
 * of the REQUEST BODY'S RAW BYTES keyed by the app secret. Two traps live in
 * that sentence:
 *   • RAW BYTES. The digest must be taken before anything parses or re-encodes
 *     the body; JSON.parse → JSON.stringify changes key order, spacing and
 *     escaping, and every one of those changes the digest. The caller therefore
 *     hands us the bytes, not an object.
 *   • CONSTANT TIME. Comparing digests with === leaks, byte by byte, how much of
 *     a guessed signature was right. timingSafeEqual does not.
 *
 * WHERE THIS LIVES. It guards the whole webhook, not only the template half, so
 * its natural home is a wa-webhook module. It sits here because this is the one
 * WhatsApp webhook module this change is allowed to touch, and the route already
 * imports it for applyTemplateStatusWebhook.
 */

/** Meta's header name, lowercase (Request.headers.get is case-insensitive). */
export const SIGNATURE_HEADER = 'x-hub-signature-256';

/**
 * Where the app secret is read from, in order.
 *
 * ENVIRONMENT FIRST. The secret is a deployment credential, and the app's
 * WhatsApp settings writer has its own key whitelist which this change is not
 * allowed to extend — so an env var is the one place it can be supplied today.
 * A `wa_app_secret` row in `settings` is honoured as well, so the day a field
 * for it is added to Settings → Integrations → WhatsApp, this starts enforcing
 * with no further change here.
 */
export const APP_SECRET_ENV_KEYS = ['WA_APP_SECRET', 'META_APP_SECRET', 'WHATSAPP_APP_SECRET'] as const;
export const APP_SECRET_SETTING_KEY = 'wa_app_secret';

/**
 * WHERE THE SECRET CAME FROM — and, crucially, WHETHER WE COULD TELL.
 *
 * 'unknown' is the state this exists for. The first version of this lookup
 * returned a bare string and folded "the settings read threw" into "no secret is
 * configured", and no secret configured means ACCEPT (see verifyWebhookSignature).
 * So one failed read turned enforcement off:
 *
 *   MEASURED. With the secret present in `settings`, a database handle that threw
 *   SQLITE_BUSY for that ONE query made an unsigned forged event return 200, get
 *   archived, and land a fabricated guest message in the inbox. The same failure
 *   with the secret in the environment returned 401.
 *
 * "I cannot tell whether checking is on" is not the same as "checking is off",
 * and only one of the two is safe to act on. The caller is given the difference.
 */
export interface AppSecretLookup {
  secret: string;
  source: 'environment' | 'settings' | 'none';
  /** A configured secret could not be READ — never treat this as "none". */
  unreadable: boolean;
}

export function webhookAppSecretLookup(db?: DB): AppSecretLookup {
  for (const k of APP_SECRET_ENV_KEYS) {
    const v = String(process.env[k] ?? '').trim();
    if (v) return { secret: v, source: 'environment', unreadable: false };
  }
  if (db) {
    try {
      const r = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(APP_SECRET_SETTING_KEY) as any;
      const v = String(r?.value ?? '').trim();
      if (v) return { secret: v, source: 'settings', unreadable: false };
    } catch {
      // The row may or may not exist; what is certain is that we do not know.
      return { secret: '', source: 'none', unreadable: true };
    }
  }
  return { secret: '', source: 'none', unreadable: false };
}

/** The secret itself, for callers that only need the value. */
export function webhookAppSecret(db?: DB): string {
  return webhookAppSecretLookup(db).secret;
}

export type WebhookAuthState =
  /** No app secret anywhere — nothing can be checked. */
  | 'not_configured'
  /** Signed, and the signature is Meta's. */
  | 'verified'
  /** A secret is set and the request carried no signature header at all. */
  | 'missing_signature'
  /** Header present but not `sha256=<64 hex>`. */
  | 'malformed_signature'
  /** Header well-formed, digest does not match. */
  | 'bad_signature'
  /** We could not determine whether a secret is configured. Refused, not accepted. */
  | 'secret_unreadable';

export interface WebhookAuth {
  /** May the caller process this request? */
  ok: boolean;
  /** True when a secret is configured, i.e. the check actually has teeth. */
  enforced: boolean;
  state: WebhookAuthState;
  /** Operator-readable. Empty when verified. */
  reason: string;
}

/**
 * Verify one webhook POST.
 *
 * THE DECISION WHEN NO SECRET IS CONFIGURED: ACCEPT, AND SAY SO LOUDLY.
 *
 * Refusing everything would be the stricter choice and it is the wrong one
 * here. This venue's WhatsApp inbox is live and receiving real guest messages
 * today, with no app secret anywhere; a deploy that started refusing unsigned
 * posts would silently stop every inbound message, every delivery receipt and
 * every read receipt, and Meta disables a webhook that keeps erroring. The
 * failure would look like "WhatsApp is broken", days later, with nothing on any
 * screen connecting it to this change. So: the hole stays open until the secret
 * is supplied, and the state is reported — on the WhatsApp settings screen, in
 * the server log — rather than left silent. The moment a secret exists the
 * check is absolute: unsigned, malformed and mis-signed are all refused.
 */
export function verifyWebhookSignature(
  rawBody: Buffer | string,
  signatureHeader: string | null | undefined,
  secret: string,
  /**
   * `unreadable` — the secret lookup FAILED rather than came back empty. Refused:
   * accepting on a failed read is how one SQLITE_BUSY silently disarmed the whole
   * check (see AppSecretLookup). A 401 makes Meta retry the event; accepting it
   * writes a forgery nobody can distinguish afterwards.
   */
  opts: { unreadable?: boolean } = {},
): WebhookAuth {
  if (opts.unreadable) {
    return {
      ok: false, enforced: true, state: 'secret_unreadable',
      reason: 'This app could not read its own WhatsApp settings, so it cannot tell whether webhook signature checking is switched on. The request has been refused rather than believed, and nothing was recorded. Meta will retry it.',
    };
  }

  const key = String(secret ?? '').trim();
  if (!key) {
    return {
      ok: true, enforced: false, state: 'not_configured',
      reason: 'No WhatsApp app secret is configured, so this app cannot tell a real Meta webhook from a forged one. Anyone who knows the webhook address can post invented guest messages and delivery reports into the CRM. Add the app secret to close it.',
    };
  }

  const header = String(signatureHeader ?? '').trim();
  if (!header) {
    return {
      ok: false, enforced: true, state: 'missing_signature',
      reason: 'This request carried no WhatsApp signature, so it was not sent by Meta. It has been rejected and nothing was recorded.',
    };
  }

  const m = /^sha256=([0-9a-f]{64})$/i.exec(header);
  if (!m) {
    return {
      ok: false, enforced: true, state: 'malformed_signature',
      reason: 'This request\'s WhatsApp signature is not in the shape Meta sends, so it was not sent by Meta. It has been rejected and nothing was recorded.',
    };
  }

  // The digest is over the bytes EXACTLY as they arrived. A Buffer is passed
  // through untouched; a string is encoded as UTF-8, which is what Meta sends.
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8');
  const mine = createHmac('sha256', key).update(body).digest();
  const theirs = Buffer.from(m[1].toLowerCase(), 'hex');

  // Both are 32-byte SHA-256 digests, so the length guard can never fire — it is
  // here because timingSafeEqual THROWS on a length mismatch, and a crash in a
  // signature check fails open in the caller's catch.
  const same = mine.length === theirs.length && timingSafeEqual(mine, theirs);
  if (!same) {
    return {
      ok: false, enforced: true, state: 'bad_signature',
      reason: 'This request\'s WhatsApp signature does not match the app secret, so it was not sent by Meta (or the app secret here is the wrong one). It has been rejected and nothing was recorded.',
    };
  }
  return { ok: true, enforced: true, state: 'verified', reason: '' };
}

/* ═════════ IS THE CHECK ACTUALLY WORKING? (not just switched on) ═════════
 *
 * A green "signature checking is on" banner says the app HAS a secret. It does
 * not say the secret is the right one, and the difference is a silent outage:
 *
 *   MEASURED. With the app secret one character wrong, a genuine, correctly
 *   signed Meta event returned 401, nothing was archived, and the guest's message
 *   was gone with no trace anywhere — while the settings screen still said
 *   "Webhook signature checking is on". A refusal writes nothing BY DESIGN (a
 *   stored forgery is replayable), so the very property that makes the refusal
 *   safe is what makes a typo invisible.
 *
 * So two facts are kept: when a signature last VERIFIED, and when one was last
 * REFUSED and why. Persisted (a restart must not read as "never verified"),
 * throttled to once a minute per kind so a flood of forgeries cannot turn the
 * endpoint into a write amplifier, and reported on the settings screen: a secret
 * that has never verified anything is shown as a WARNING, not a reassurance.
 */
export const WEBHOOK_VERIFIED_KEY = 'wa_webhook_last_verified_at';
export const WEBHOOK_REFUSED_KEY = 'wa_webhook_last_refused';
const TELEMETRY_THROTTLE_MS = 60_000;
let lastVerifiedWrite = 0;
let lastRefusedWrite = 0;

/** Record the outcome of one webhook check. Never throws; never blocks a reply. */
export function recordWebhookCheck(db: DB, auth: WebhookAuth, nowMs?: number): void {
  if (!auth?.enforced) return;                       // nothing was checked
  const t = Number(nowMs ?? Date.now());
  const write = (key: string, value: string) => {
    try {
      db.prepare(`
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(key, value);
    } catch { /* telemetry must never break the webhook */ }
  };
  if (auth.state === 'verified') {
    if (t - lastVerifiedWrite < TELEMETRY_THROTTLE_MS) return;
    lastVerifiedWrite = t;
    write(WEBHOOK_VERIFIED_KEY, utcString(t));
    return;
  }
  if (t - lastRefusedWrite < TELEMETRY_THROTTLE_MS) return;
  lastRefusedWrite = t;
  write(WEBHOOK_REFUSED_KEY, JSON.stringify({ at: utcString(t), state: auth.state }));
}

/**
 * FORGET WHAT THE OLD SECRET DID. Called when the app secret changes: a
 * verification that happened under the previous secret says nothing about the new
 * one, and leaving it on screen would present a stale green tick for a secret
 * that has never checked anything. The in-process throttles are reset too, so the
 * very next real event re-records immediately instead of up to a minute later.
 */
export function resetWebhookTelemetry(db: DB): void {
  lastVerifiedWrite = 0;
  lastRefusedWrite = 0;
  try {
    db.prepare(`DELETE FROM settings WHERE key IN (?, ?)`).run(WEBHOOK_VERIFIED_KEY, WEBHOOK_REFUSED_KEY);
  } catch { /* nothing to forget */ }
}

function readTelemetry(db?: DB): { verified_at: string; refused_at: string; refused_state: string } {
  const out = { verified_at: '', refused_at: '', refused_state: '' };
  if (!db) return out;
  try {
    const v = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(WEBHOOK_VERIFIED_KEY) as any;
    out.verified_at = String(v?.value ?? '').trim();
    const r = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(WEBHOOK_REFUSED_KEY) as any;
    const parsed = JSON.parse(String(r?.value || '{}'));
    out.refused_at = String(parsed?.at ?? '').trim();
    out.refused_state = String(parsed?.state ?? '').trim();
  } catch { /* unreadable telemetry says nothing, and must not throw here */ }
  return out;
}

export interface WebhookSecurityState {
  signature_enforced: boolean;
  source: 'environment' | 'settings' | 'none';
  headline: string;
  detail: string;
  /** A secret can be typed into this app (it is not coming from the server env). */
  can_set_here: boolean;
  /** True when the check is on but nothing has verified, or refusals are the latest news. */
  warn: boolean;
  /** When a real, correctly-signed Meta event was last accepted ('' = never). */
  last_verified_at: string;
  /** When a request was last turned away, and which check it failed. */
  last_refused_at: string;
  last_refused_state: string;
}

/** The state to show an admin, with no secret value in it. */
export function webhookSecurityState(db?: DB): WebhookSecurityState {
  const look = webhookAppSecretLookup(db);
  const tel = readTelemetry(db);
  const base = {
    can_set_here: look.source !== 'environment',
    last_verified_at: tel.verified_at,
    last_refused_at: tel.refused_at,
    last_refused_state: tel.refused_state,
  };

  if (look.unreadable) {
    return {
      ...base,
      signature_enforced: true,
      source: 'none',
      can_set_here: false,
      warn: true,
      headline: 'This app cannot read its own WhatsApp settings',
      detail: 'Webhook requests are being refused rather than believed, because nothing here can tell whether signature checking is configured. Incoming WhatsApp is stopped while this lasts — Meta will retry what it could not deliver. This is a database problem, not a WhatsApp one.',
    };
  }

  if (!look.secret) {
    return {
      ...base,
      signature_enforced: false,
      source: 'none',
      warn: true,
      headline: 'Anyone who knows the webhook address can post fake WhatsApp activity',
      detail: `Meta signs every webhook it sends. Without the app secret this app cannot check that signature, so invented guest messages and invented delivery reports would be accepted and stored as real. Paste the app secret below (Meta App Dashboard → Settings → Basic → App secret), or set the ${APP_SECRET_ENV_KEYS[0]} environment variable on the server. Incoming WhatsApp keeps working either way — this only decides whether forgeries are turned away.`,
    };
  }

  /* ARMED BUT NEVER USED. The dangerous middle state: the secret is set, so the
   * check refuses everything it cannot verify — and if the secret is wrong, that
   * is everything, silently. Say so until one real event has verified. */
  const refusedIsLatest = !!tel.refused_at && (!tel.verified_at || tel.refused_at > tel.verified_at);
  if (!tel.verified_at) {
    return {
      ...base,
      signature_enforced: true,
      source: look.source,
      warn: true,
      headline: 'Webhook signature checking is on, but nothing has passed it yet',
      detail: `Unsigned and wrongly signed requests are now refused${look.source === 'settings' ? '' : ' (the secret comes from the server environment)'}. No real WhatsApp event has verified against this secret so far, so if it is not the right one, every genuine message from Meta is being turned away and nothing is being recorded. Send yourself a WhatsApp message to this number; this line will name the time it verified.${refusedIsLatest ? ` The last request was refused (${tel.refused_state}) at ${tel.refused_at} UTC.` : ''}`,
    };
  }

  if (refusedIsLatest) {
    return {
      ...base,
      signature_enforced: true,
      source: look.source,
      warn: true,
      headline: 'Webhook signature checking is on — and the last request was turned away',
      detail: `A real event last verified at ${tel.verified_at} UTC, and something has been refused since (${tel.refused_state}, at ${tel.refused_at} UTC). One refusal is normal if someone is probing the address; a continuous run of them means Meta's events are not getting in — check that the app secret here is the one from the same Meta app.`,
    };
  }

  return {
    ...base,
    signature_enforced: true,
    source: look.source,
    warn: false,
    headline: 'Webhook signature checking is on',
    detail: `Every incoming WhatsApp webhook is checked against the app secret before anything is recorded; anything unsigned or wrongly signed is turned away and never reaches the inbox, the campaign reports or the template statuses. A real Meta event last verified at ${tel.verified_at} UTC.`,
  };
}

/* ═══════════════════════ Webhook: status updates ═══════════════════════ */

/**
 * META'S REJECTION REASON, or nothing.
 *
 * Meta reports a rejection as one SCREAMING_SNAKE token (SCAM, ABUSIVE_CONTENT,
 * INCORRECT_CATEGORY, INVALID_FORMAT, TAG_CONTENT_MISMATCH, NONE…). A value that
 * is not one single word-token did not come from Meta, and this column is
 * rendered to the owner as "WhatsApp's own words" — so anything else is dropped
 * rather than repeated in this app's voice. Bounded at 64 characters, which is
 * longer than every token Meta is known to use.
 *
 * UNVERIFIED (model knowledge): the token vocabulary. The SHAPE is what is
 * enforced here, not membership of a list, so a token this app has never seen
 * still reaches the owner while a sentence never does.
 */
function metaReasonToken(raw: unknown): string {
  const s = String(raw ?? '').trim();
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(s) ? s : '';
}

/**
 * Apply Meta's `message_template_status_update` webhook, when one arrives.
 *
 * UNVERIFIED (model knowledge) — nothing in this repo proves the field name or
 * the value shape. It is therefore written as a PURE BONUS: it only ever acts
 * on a change whose field is exactly 'message_template_status_update' and whose
 * value names a template we already hold in the lifecycle. Any other payload is
 * ignored without error, and POLLING (syncTemplateStatuses) remains the
 * authoritative backstop — a venue that never receives this webhook loses
 * nothing but latency.
 *
 * The webhook subscription must ALSO be enabled in Meta's App Dashboard for
 * this field; subscribing is not something this code can do for you.
 *
 * ── WHO IS ALLOWED TO MOVE A TEMPLATE'S STATUS, 2026-09-16 ─────────────────
 *
 * NOBODY THIS APP CANNOT IDENTIFY. The webhook address is public by necessity
 * (Meta carries no session), so the only thing separating Meta from a stranger
 * is the signature — and where no app secret is configured there is no
 * signature, so `enforced` is false and every POST that reaches this function is
 * of unknown origin.
 *
 *   MEASURED. With no app secret set — which is production today — ONE
 *   unauthenticated POST naming this venue's 11 templates with event "DRAFT"
 *   took them from 11/11 sendable to 0/11, and the sync's one undo point does
 *   not cover a forgery. A second identical POST did it again with no way back
 *   in the app.
 *
 * Reading and writing are therefore separated: the INBOX still accepts unsigned
 * posts (refusing them would silently stop this venue's live guest messages —
 * see verifyWebhookSignature for that decision, which stands), but a WRITE that
 * changes what the venue can send requires a request this app could actually
 * check. Where it cannot, the event is counted and named in `untrusted` and
 * nothing is written. The cost is LATENCY ONLY and it is the cost the module was
 * designed around: polling (syncTemplateStatuses) is the authoritative
 * reconciliation and re-learns every status from Meta's own list.
 *
 * `opts.trusted` lets a caller that has already verified the request say so.
 * Default: a secret is configured, i.e. the route refused everything unsigned
 * before this function was ever reached.
 */
export function applyTemplateStatusWebhook(
  db: DB,
  payload: unknown,
  opts: { nowMs?: number; trusted?: boolean } = {},
): {
  applied: number;
  changes: Array<{ name: string; from: string; to: string }>;
  /** Events refused because the request could not be proven to be Meta's. */
  untrusted: number;
  /** Events refused because the status is not one Meta reports. */
  rejected: Array<{ name: string; status: string }>;
} {
  const out = {
    applied: 0,
    changes: [] as Array<{ name: string; from: string; to: string }>,
    untrusted: 0,
    rejected: [] as Array<{ name: string; status: string }>,
  };

  /* CAN THIS REQUEST BE ATTRIBUTED TO META AT ALL? Asked once, before anything
   * is parsed, so an untrusted payload cannot reach a single write. */
  let trusted = opts.trusted;
  if (trusted === undefined) {
    try {
      const look = webhookAppSecretLookup(db);
      // `unreadable` is NOT "no secret" — the same distinction the signature
      // check draws. Either way it is not trusted, which is the safe side.
      trusted = !!look.secret && !look.unreadable;
    } catch { trusted = false; }
  }

  let parsed: any = payload;
  if (typeof payload === 'string') {
    try { parsed = JSON.parse(payload); } catch { return out; }
  }
  const entries = Array.isArray(parsed?.entry) ? parsed.entry : [];
  const now = utcString(opts.nowMs ?? Date.now());

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const ch of changes) {
      if (String(ch?.field ?? '') !== 'message_template_status_update') continue;
      const v = ch?.value ?? {};
      const name = String(v?.message_template_name ?? '').trim();
      if (!name) continue;
      const status = mapMetaStatus(v?.event ?? v?.status);
      if (!status) continue;

      /* WHAT META CAN SAY, AND NOTHING ELSE. 'draft' and 'unknown_at_meta' are
       * this app's own words, and an unrecognised value is kept verbatim by
       * mapMetaStatus — so without this line any string at all could be written
       * into the column three gates read. See META_REPORTABLE. */
      if (!isMetaReportableStatus(status)) {
        out.rejected.push({ name, status });
        continue;
      }

      if (!trusted) { out.untrusted++; continue; }

      /* TEXT FROM OUTSIDE, SHOWN TO THE OWNER AS "WhatsApp's own words".
       *
       *   MEASURED. One unauthenticated POST wrote "Your WhatsApp account will be
       *   closed. Call +91 90000 00000 within 24 hours to restore it." into
       *   meta_rejected_reason, and listSaysAdvisory rendered it verbatim on the
       *   template screen AND in the campaign-create warnings — the line the
       *   owner is told is the strongest thing anyone here knows against a send.
       *
       * Meta's own reason is a short SCREAMING_SNAKE token (SCAM,
       * INCORRECT_CATEGORY, INVALID_FORMAT…), so anything that is not one is not
       * Meta's and is dropped rather than shown. Dropping it costs a clause of
       * detail; showing it hands a stranger a sentence in this app's voice. The
       * SYNC path is left free-form on purpose: that text comes back over this
       * app's own authenticated call to Meta. */
      const reason = metaReasonToken(v?.reason);
      // Meta's template ids are numeric strings. This one addresses "Edit at
      // Meta", so a value that is not an id is not written at all.
      const rawId = String(v?.message_template_id ?? '').trim();
      const metaId = /^[0-9]{1,32}$/.test(rawId) ? rawId : '';

      const row = db.prepare(`SELECT * FROM whatsapp_templates WHERE name = ?`).get(name) as any;
      // Only touch a row already in the lifecycle. A webhook must never conjure
      // a template, nor convert a local free-form row into a managed one —
      // that is sync's job, where the whole list is the evidence.
      if (!row || !isManagedStatus(row.meta_status)) continue;

      const from = String(row.meta_status || '');
      db.prepare(`
        UPDATE whatsapp_templates
        SET meta_status = ?,
            meta_rejected_reason = CASE WHEN ? <> '' THEN ? ELSE meta_rejected_reason END,
            meta_template_id = CASE WHEN ? <> '' THEN ? ELSE meta_template_id END,
            meta_status_checked_at = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(status, reason, reason, metaId, metaId, now, row.id);
      out.applied++;
      if (from !== status) out.changes.push({ name, from, to: status });
    }
  }
  return out;
}

/* ═══════════════════════ The broadcast gate ═══════════════════════ */

export interface Sendability {
  /** May a campaign use this template right now? */
  ok: boolean;
  /** Local lifecycle status ('' when the name is unknown to the lifecycle). */
  status: TemplateStatus | '';
  /** True when the answer rests on real Meta data (a sync has happened). */
  verified: boolean;
  /** Why not — plain enough to show an operator verbatim. Empty when ok. */
  reason: string;
  /**
   * META'S OWN CATEGORY for this template, uppercase — '' when nothing here has
   * recorded one. NOT the local `category` label column, which is a free-form
   * mirror an admin can type anything into.
   */
  category?: MetaCategory | '';
  /**
   * True only when `category` came from Meta (a sync or a submit response). A
   * caller that REQUIRES a category must treat false as "not proven" and warn,
   * not as "wrong" — the same evidence discipline as `verified`.
   */
  categoryVerified?: boolean;
  /**
   * THE LANGUAGE A SEND MUST ACTUALLY USE — Meta's own spelling for this
   * template, which is not always the one stored on the campaign. A venue types
   * 'en'; Meta approved it as 'en_US'. Identity is the exact (name, language)
   * pair, so sending the campaign's spelling would fail with "(#132001)
   * Template name does not exist in the translation" — a message that reads
   * like a NAME problem and sends the operator hunting the wrong bug. Empty
   * when nothing is known about the template (then the campaign's own value
   * stands, exactly as before).
   */
  language?: string;
  /**
   * WHAT THE OWNER SHOULD KNOW, when the answer is "yes, but".
   *
   * Everything this app learns from WhatsApp's own list — whether a name is on
   * it, what state it says the template is in, which category it was approved
   * into — is INFORMATION, not permission. It is put here and shown; it never
   * sets `ok` to false. See sendabilityFrom() for where the line is drawn and
   * why. Empty when there is nothing to say.
   */
  advisory?: string;
}

/**
 * THE predicate the broadcast rail asks, at campaign create AND on every drain
 * pass.
 *
 * ── THE OWNER'S RULING, 2026-09-15: CHECKING IS NOT DECIDING ────────────────
 *
 * This predicate used to treat WhatsApp's template list as ground truth and
 * REFUSE anything the list did not account for. That premise was measured
 * against this venue's real data and it does not hold:
 *
 *   • all 11 of this venue's templates are local, free-form rows (meta_status
 *     = '') and every one of them can send today, for the single reason that
 *     the list has never been pulled;
 *   • the first pull removes that reason for all 11 AT ONCE. Not because
 *     anything about a template changed — because "absent from a list we now
 *     have" became a fact the gate acted on;
 *   • so ONE button press turned 11 sendable templates and 16 legitimate
 *     campaign shapes into refusals, and nothing in the app put them back.
 *
 * A check that can take away everything a venue can send, from one answer, is
 * not a safety feature. So the list's answer is now INFORMATION: it is shown,
 * in the owner's own words, and it never refuses a send.
 *
 * ── WHERE THE LINE IS, AND WHY IT IS THERE ─────────────────────────────────
 *
 * ADVISORY — a "refusal" that is really an OPINION ABOUT STATE. Its ground is
 * something WhatsApp's list said about the template: we did not find this name;
 * we have never seen it; it says pending / rejected / paused / disabled; it says
 * the name is on the list but in a different category. Every one of these is a
 * mirror of a remote system that this app only ever reads, one way, never
 * reconciles, and cannot correct from here. Every one of them is exactly as
 * capable of stripping the estate as the absence case was — an answer pulled
 * from the wrong WhatsApp Business Account reports every template this venue
 * owns as missing OR rejected OR the wrong category, and the damage is
 * identical. So they warn (`advisory`) and return ok.
 *
 *   WHAT IT COSTS TO BE WRONG HERE: the send is attempted and WhatsApp refuses
 *   it. A refused message is never marked sent (wa-broadcast: finishFail writes
 *   failed_at, and only finishSent writes sent_at), and the 7-day per-guest
 *   cooldown and the cost line are both keyed on sent_at — so a wrongly-allowed
 *   status costs no money, burns no guest's cooldown, delivers nothing wrong,
 *   and the drain's circuit breaker halts the campaign after a handful of
 *   identical failures. It is recoverable. A wrongly-refused estate was not.
 *
 * STILL A REFUSAL — a refusal whose ground is WHAT THIS APP WOULD PUT ON THE
 * WIRE, which is true no matter what any list says:
 *
 *   • LANGUAGE (below). WhatsApp's identity for a template is the exact
 *     (name, language) pair. If this app holds the template in `en` and the
 *     campaign says `te`, one of two things happens and both are bad: the send
 *     fails as a name error, or it DELIVERS — in the wrong language, to the
 *     whole list, successfully, which charges for every message and locks every
 *     guest out for the cooldown. That is the one case in this function where
 *     letting it through can burn the audience instead of merely failing, so it
 *     stays a refusal. It is also not a stripping risk: it can only fire when
 *     the list AFFIRMATIVELY holds the template, in some language — an answer
 *     that omits a venue's templates cannot produce it. IT IS ASKED OF EVERY
 *     STATUS WHATSAPP HAS SPOKEN ABOUT, not only 'approved': it used to sit
 *     inside the approved branch, where the four statuses this ruling turned
 *     into advisories never reached it, and a `te` campaign on a `paused` `en`
 *     template armed and drained (MEASURED, 10 messages, `te` on the wire).
 *   • DRAFT. "You wrote this here and never sent it to WhatsApp for approval"
 *     is not WhatsApp's answer at all — it is this app's record of the owner's
 *     own unfinished action, one click from being fixed. Nothing outside this
 *     app can create it: a refresh skips 'draft' rows in the sweep, and the
 *     status webhook may only write statuses Meta itself reports — the guard
 *     added after one unauthenticated POST wrote 'draft' over all 11 templates
 *     and turned this branch into a total-estate refusal. A draft was never
 *     sendable before any refresh, so keeping it cannot take anything away from
 *     anybody.
 *
 * The other two whole-queue refusals live in wa-broadcast and are likewise
 * REAL, for the same reason — they are about what this rail can put on the
 * wire, not about what WhatsApp thinks: templateHeaderFill (a heading needing a
 * file this rail has no file for, or a blank it cannot fill) and
 * paramMappingCheck (a different number of blanks than the message will carry).
 * Those two still refuse, and the before-you-check card asks them (see
 * measureSendability / syncPreflight), so nothing that stops is unannounced.
 *
 * CATEGORY (opts.requireCategory). A template approved as UTILITY will not
 * deliver a marketing message — but that sentence is the list's opinion about
 * state, it strips exactly like the absence case, and being wrong about it
 * costs a failed send and nothing else. Advisory.
 */
/**
 * THE FACTS THE GATE DECIDES ON — nothing else about the row matters.
 *
 * Pulled out as its own shape so the SAME decision can be asked of a row as it
 * is now and of the row as a refresh would leave it. That is what lets the
 * refresh report name what actually stopped, instead of guessing from a status
 * transition: see stoppedBySync().
 */
export interface TemplateFacts {
  /** '' when nothing here holds this template at all. */
  present: boolean;
  meta_status: string;
  /** Meta's category, uppercase. '' = never recorded here. */
  meta_category: string;
  meta_rejected_reason: string;
  /** provider_language, else language. */
  language: string;
}

export function factsFromRow(row: any): TemplateFacts | undefined {
  if (!row) return undefined;
  return {
    present: true,
    meta_status: String(row.meta_status || ''),
    meta_category: String(row.meta_category || '').trim().toUpperCase(),
    meta_rejected_reason: String(row.meta_rejected_reason || '').trim(),
    language: String(row.provider_language || row.language || '').trim(),
  };
}

export function templateSendability(
  db: DB,
  templateName: string,
  language?: string,
  opts: { requireCategory?: MetaCategory } = {},
): Sendability {
  const name = String(templateName || '').trim();
  if (!name) {
    return { ok: false, status: '', verified: false, reason: 'No template name on this campaign — there is nothing Meta would deliver.' };
  }

  let row: any;
  try { row = db.prepare(`SELECT * FROM whatsapp_templates WHERE name = ?`).get(name); }
  catch { row = undefined; }

  return sendabilityFrom(name, factsFromRow(row), lastSyncAt(db), language, opts);
}

/**
 * A STORED TIME, ON THE OWNER'S CLOCK.
 *
 * Every timestamp in this module is written by utcString() as
 * 'YYYY-MM-DD HH:MM:SS' in UTC with no zone marker, which is right for storage
 * and wrong for a sentence: printed raw it told an owner in Hyderabad a time
 * five and a half hours before the clock on his wall, with nothing on the line
 * saying it was not his. The campaign screen already renders the SAME sentence
 * correctly (istDateTime, crm-calls/broadcasts/page.tsx), so this is also the
 * two screens agreeing rather than a new opinion. An unparseable value is
 * returned untouched — never a crash and never an invented time.
 */
function istWhen(stored: string): string {
  const s = String(stored || '').trim();
  if (!s) return '';
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return s;
  try {
    return d.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
  } catch { return s; }
}

/**
 * WHAT TO TELL THE OWNER when WhatsApp's list says something about a template
 * that is worth knowing and is not a reason to stop him sending.
 *
 * Written as sentences a person who runs a restaurant reads once and acts on:
 * what WhatsApp said, what it means for this message, and what to do about it.
 * `when` is the time the list was last checked, shown only when there is one.
 */
function listSaysAdvisory(
  name: string,
  status: TemplateStatus | '',
  detail: string,
  when: string,
): string {
  const because = detail ? ` WhatsApp's own words: ${detail}.` : '';
  const checked = when ? ` (last checked ${istWhen(when)})` : '';
  const tail = ' Nothing here is stopping you — if you send it and WhatsApp turns it down, no message goes out, no guest is contacted and nothing is charged.';
  switch (status) {
    case 'pending':
      return `WhatsApp has not finished reviewing "${name}" yet${checked}, so it may not go out.${tail}`;
    case 'rejected':
      return `WhatsApp turned "${name}" down${checked}, so it will not go out until it is corrected and sent for approval again.${because}${tail}`;
    case 'paused':
      return `WhatsApp has put "${name}" on hold${checked} — that usually happens when guests block or report messages. It will not go out while it is on hold.${because}${tail}`;
    case 'disabled':
      return `WhatsApp has switched "${name}" off${checked}, so it will not go out.${because}${tail}`;
    case 'unknown_at_meta':
      return `"${name}" was sent to WhatsApp for approval from here, but it was not on the list the last time it was checked${checked}. It may have been deleted at WhatsApp, or the WhatsApp Business Account set up on this app may not be the one it was approved on.${tail}`;
    case '':
      return `The last check of WhatsApp's list${checked} did not find a message called "${name}". That can mean WhatsApp does not have it — or that it was approved after the check, or on a different WhatsApp Business Account from the one set up here. Check the name, or check the list again on Settings → Integrations → WhatsApp → Templates.${tail}`;
    default:
      return `WhatsApp lists "${name}" as "${status}"${checked}, which is not "approved".${because}${tail}`;
  }
}

/**
 * The gate itself, over facts rather than over a database.
 *
 * `synced` is the time WhatsApp's list was last checked: empty means it has
 * never been checked. It no longer decides ANYTHING — it only dates the note
 * shown beside a template. That is the whole of the 2026-09-15 change: before
 * it, a non-empty value here turned every unrecognised name into a refusal, so
 * one press of Check-the-list took away every template this venue had.
 */
export function sendabilityFrom(
  templateName: string,
  facts: TemplateFacts | undefined,
  synced: string,
  language?: string,
  opts: { requireCategory?: MetaCategory } = {},
): Sendability {
  const name = String(templateName || '').trim();
  if (!name) {
    return { ok: false, status: '', verified: false, reason: 'No template name on this campaign — there is nothing Meta would deliver.' };
  }

  const row = facts?.present ? facts : undefined;
  const status = String(row?.meta_status || '') as TemplateStatus;
  /** Meta's own category, uppercase. '' = never recorded here (no evidence). */
  const category = String(row?.meta_category || '').trim().toUpperCase() as MetaCategory | '';
  const needCat = opts.requireCategory;

  if (row && isManagedStatus(status)) {
    const approvedLang = String(row.language || '').trim();
    const want = String(language || '').trim();

    /* DRAFT IS THE ONE STATUS THAT STILL REFUSES, and it is not WhatsApp's
     * answer: it is this app's own record that the owner wrote this message here
     * and has not yet sent it to WhatsApp for approval. Nothing outside this app
     * can now produce it — a refresh skips 'draft' rows in the sweep, and the
     * status webhook may only write the statuses META itself reports
     * (META_REPORTABLE), which was added the day one unauthenticated POST used
     * this very branch to refuse all 11 of this venue's templates at once. So
     * keeping it takes nothing away from anyone, and one click in the Templates
     * screen clears it.
     *
     * Asked BEFORE the language comparison below, deliberately: both refuse, and
     * for a message that was never sent for approval "you have not submitted it
     * yet" is the sentence that tells the owner what to do. */
    if (status === 'draft') {
      return {
        ok: false, status, verified: true, category, categoryVerified: !!category,
        reason: `"${name}" has not been sent to WhatsApp for approval yet — it is still being written here. Send it for approval from Settings → Integrations → WhatsApp → Templates and wait for WhatsApp to approve it before using it for a campaign.`,
      };
    }

    /* ══ LANGUAGE — ASKED OF EVERY STATUS WHATSAPP HAS SPOKEN ABOUT ══
     *
     * This comparison used to live inside the `status === 'approved'` block, and
     * before the 2026-09-15 ruling that was harmless BY ACCIDENT: every other
     * managed status returned ok:false anyway, so the language question could
     * never arise. The ruling turned four of those into advisories and the cover
     * went with them.
     *
     *   MEASURED. The same campaign — template held here in `en`, campaign built
     *   in `te` — is correctly refused on an approved row and ARMS AND DRAINS on
     *   pending, paused, rejected and disabled: 10 messages each, at `te` on the
     *   wire (the advisory branch returns no `language`, so wa-broadcast's
     *   `sendable.language || camp.language` takes the campaign's own value
     *   unchallenged). The control proves it was not merely passing but
     *   unreached: on a paused row, `te` and `en` returned identical answers.
     *
     * WHY IT IS STILL NOT A STRIPPING RISK, which is the test every refusal in
     * this function has to pass: it can only fire where WhatsApp's answer
     * AFFIRMATIVELY holds the template in some language. An answer that omits a
     * venue's templates cannot produce it — those rows become unknown_at_meta,
     * which is excluded below along with draft, because for both of them the
     * language on the row is this app's own word and not WhatsApp's.
     *
     * WHY IT REFUSES AT ALL, when everything else about WhatsApp's answer only
     * advises: a wrong category can only FAIL — the send is refused, nothing is
     * delivered, nothing is charged. A wrong language can SUCCEED: Meta keys
     * (name, language) as identity, so where it holds a `te` translation the
     * whole list is delivered in Telugu, charged for, and locked into the 7-day
     * cooldown, while every preview and every acknowledgement this app showed was
     * built from the English wording the operator actually read. That is the one
     * case here where letting it through burns the audience instead of merely
     * failing. */
    if (status !== 'unknown_at_meta' && want && approvedLang && !languagesMatch(want, approvedLang)) {
      // A DIFFERENT language is a refusal; a different SPELLING of the same
      // language is not. 'en' and 'en_US' are one approval Meta happens to
      // qualify with a locale — refusing that pair blocked an APPROVED template
      // permanently, with a reason the very same sync response contradicted.
      // The send still has to use Meta's exact spelling, which is what
      // `language` carries back to the caller.
      return {
        ok: false, status, verified: true, language: approvedLang, category, categoryVerified: !!category,
        reason: status === 'approved'
          ? `"${name}" is approved at Meta in ${approvedLang}, but this campaign would send it as ${want}. Meta treats (name, language) as the template's identity, so this send would fail with a "template not found" error that reads like a name problem.`
          : `WhatsApp holds "${name}" in ${approvedLang}, but this campaign would send it as ${want}. WhatsApp knows a message by its name AND its language together, so this would either fail for everyone with an error that reads like a name problem, or — if WhatsApp does hold a ${want} version — send every guest a different message from the one shown here, and charge for all of them. Build the campaign in ${approvedLang}, or have a ${want} version approved.`,
      };
    }

    if (status === 'approved') {
      // CATEGORY — ADVISORY (owner's ruling, 2026-09-15). WhatsApp will not
      // deliver a marketing message from a template it approved as UTILITY or
      // AUTHENTICATION. That is true, and it is still only WhatsApp's answer
      // about state: an answer read off the wrong Business Account reports the
      // wrong category for every template a venue owns, and refusing on it
      // strips the whole list exactly as the absence case did. Being wrong the
      // other way costs a send WhatsApp refuses — no delivery, no charge, no
      // guest locked into the cooldown. So it is said, not enforced.
      if (needCat && category && category !== needCat) {
        return {
          ok: true, status, verified: true, reason: '', language: approvedLang || want, category, categoryVerified: true,
          advisory: `WhatsApp has approved "${name}", but as ${category.toLowerCase()} rather than ${needCat.toLowerCase()}. An offer sent to your guest list counts as ${needCat.toLowerCase()}, and WhatsApp only delivers those from a message approved as ${needCat.toLowerCase()} — so this one may be turned down for everyone on the list. If it is, no message goes out, no guest is contacted and nothing is charged. Use a message approved as ${needCat.toLowerCase()}, or have this one approved again as ${needCat.toLowerCase()}.`,
        };
      }
      return { ok: true, status, verified: true, reason: '', language: approvedLang || want, category, categoryVerified: !!category };
    }

    const detail = String(row.meta_rejected_reason || '').trim();

    /* EVERY OTHER STATUS IS WHAT WHATSAPP'S LIST SAID, so it informs and does
     * not refuse. See the note on this function for the whole argument. */
    return {
      ok: true, status, verified: true, reason: '', category, categoryVerified: !!category,
      advisory: listSaysAdvisory(name, status, detail, synced),
    };
  }

  if (!synced) {
    return { ok: true, status: '', verified: false, reason: '', category: '', categoryVerified: false };
  }

  /* THE BRANCH THE WHOLE CHANGE IS ABOUT.
   *
   * This returned ok:false. It is the single line that turned all 11 of this
   * venue's templates — every one of them, the moment the list was first
   * checked — from sendable into refused, with nothing in the app able to put
   * them back. "We looked and did not find it" is a statement about a list, not
   * about the message, and it is now said rather than acted on. */
  return {
    ok: true, status: '', verified: true, reason: '', category: '', categoryVerified: false,
    advisory: listSaysAdvisory(name, '', '', synced),
  };
}

/* ═══════════════ The OTHER half of the gate: parameter count ═══════════════ */

export interface PlaceholderCount {
  /** True only when the number rests on evidence about THIS template. */
  known: boolean;
  /** How many {{n}} the template's BODY has. */
  count: number;
  /** Which evidence produced it — named in the refusal so it can be checked. */
  source: '' | 'var_spec' | 'meta_components' | 'body';
  /** The authored variable names in position order (var_spec only). */
  names: string[];
}

/** Highest positional index in a body: 'Hi {{1}}, join {{3}}' → 3. */
function maxPlaceholderIndex(text: unknown): number {
  let max = 0;
  for (const t of tokens(String(text ?? ''))) {
    const n = Number(String(t.inner).trim());
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max;
}

/**
 * How many parameters Meta will demand for this template.
 *
 * EVIDENCE ONLY, in descending authority: the authored var_spec, then the
 * components Meta itself returned at sync, then the submitted body. An
 * UNMANAGED (free-form) row is deliberately NOT evidence — its `body` column is
 * a local copy for previews, not the approved provider template, and treating
 * it as truth would refuse campaigns that work today. Same discipline as
 * templateSendability: strict exactly where there are grounds.
 */
export function templatePlaceholders(db: DB, templateName: string): PlaceholderCount {
  const none: PlaceholderCount = { known: false, count: 0, source: '', names: [] };
  const name = String(templateName || '').trim();
  if (!name) return none;

  let row: any;
  try { row = db.prepare(`SELECT * FROM whatsapp_templates WHERE name = ?`).get(name); }
  catch { return none; }
  if (!row || !isManagedStatus(String(row.meta_status || ''))) return none;

  const vars = parseVarSpec(row.var_spec);
  if (vars.length) {
    /* NAMES COME BACK BY `index`, NOT BY ARRAY ORDER.
     *
     * Everything else that reads this column sorts by index first —
     * paramOrderFromVarSpec() before deriving the stored variable list,
     * buildMetaComponents() before handing Meta the examples, and
     * blankMeanings() (wa-broadcast) before deciding what each blank means. This
     * reader did not, so a spec written out of order — [{index:2,venue},
     * {index:1,name}] — reported its names as venue, name while every other
     * reader had name, venue. The count is the same either way, so nothing was
     * refused wrongly; what it corrupted was the REFUSAL TEXT, which names the
     * variables to tell an operator what to fix, and named them in the wrong
     * order.
     *
     * A spec whose indices are not a clean 1..n permutation says nothing
     * trustworthy about position, so it now claims NOTHING — not array order,
     * which is a guess that inverts against paramOrderFromVarSpec()'s
     * unconditional sort and made the honest mapping the refused one. The COUNT
     * is order-independent and still stands; only the names go quiet, and a blank
     * nothing reliable names is one the real sentence is read for. */
    const idx = vars.map(v => Number(v.index));
    const clean = idx.every(i => Number.isInteger(i) && i >= 1 && i <= vars.length)
      && new Set(idx).size === vars.length;
    const names = clean
      ? vars.slice().sort((a, b) => Number(a.index) - Number(b.index)).map(v => String(v.name || ''))
      : [];
    return { known: true, count: vars.length, source: 'var_spec', names };
  }

  try {
    const comps = JSON.parse(String(row.meta_components || '[]'));
    if (Array.isArray(comps)) {
      const body = comps.find((c: any) => String(c?.type ?? '').toUpperCase() === 'BODY');
      if (body && String(body.text ?? '')) {
        return { known: true, count: maxPlaceholderIndex(body.text), source: 'meta_components', names: [] };
      }
    }
  } catch { /* unreadable components — fall through to the body column */ }

  const body = String(row.body || '');
  if (body) return { known: true, count: maxPlaceholderIndex(body), source: 'body', names: [] };
  return none;
}

export interface ParamCheck {
  ok: boolean;
  /** -1 when the template's shape is unknown (nothing was checked). */
  expected: number;
  provided: number;
  source: PlaceholderCount['source'];
  /** Empty when ok. Written to be shown to an operator verbatim. */
  reason: string;
}

/**
 * THE SECOND SEND-TIME GATE. Approval is not the only way a campaign can fail
 * identically for every recipient: Meta rejects a message whose parameter count
 * does not match its template's placeholders, once per recipient, until the
 * whole queue is burnt — the exact failure this module exists to prevent, with
 * a different cause.
 *
 * The count is compared as it will ACTUALLY be sent: the caller passes the
 * effective (filtered) list, plus whatever was dropped, so the refusal can name
 * the variable the broadcast rail cannot fill.
 *
 * UNVERIFIED (model knowledge): Meta's error for a count mismatch (132000). The
 * repo proves only that params are positional (whatsapp.ts:246-248) — that a
 * short list leaves {{n}} unfilled is a property of positional substitution,
 * not a claim about Meta's error code.
 */
export function paramMappingCheck(
  db: DB,
  templateName: string,
  paramOrder: readonly string[],
  opts: { dropped?: readonly string[]; fillable?: readonly string[] } = {},
): ParamCheck {
  const provided = Array.isArray(paramOrder) ? paramOrder.length : 0;
  const ph = templatePlaceholders(db, templateName);
  if (!ph.known) return { ok: true, expected: -1, provided, source: '', reason: '' };
  if (ph.count === provided) return { ok: true, expected: ph.count, provided, source: ph.source, reason: '' };

  const name = String(templateName || '').trim();
  const where = ph.source === 'var_spec' ? 'as written here'
    : ph.source === 'meta_components' ? 'in the wording WhatsApp sent back'
    : 'in the wording saved here';
  const dropped = (opts.dropped || []).filter(Boolean);
  const unfillable = dropped.length
    ? ` The campaign also fills in ${dropped.map(d => `"${d}"`).join(', ')}, which a broadcast has no value for${opts.fillable?.length ? ` — it knows only: ${opts.fillable.join(', ')}` : ''}.`
    : ph.count > provided && ph.names.length
      ? ` Its blanks ${where === 'as written here' ? 'are' : 'appear to be'} ${ph.names.map(n => `"${n}"`).join(', ')}${opts.fillable?.length ? `, and a broadcast can fill only: ${opts.fillable.join(', ')}` : ''}.`
      : '';

  /* PLAIN RESTAURANT ENGLISH. This is the highest-volume refusal in the whole
   * WhatsApp surface — it is the live reason for 7 of this venue's 11 templates
   * — and it used to read "Meta matches parameters to placeholders by POSITION
   * and count", which is four pieces of jargon and a shouted word in one
   * sentence. Same fact, said the way the rest of this module says it: WhatsApp
   * fills the blanks strictly in order and counts them. */
  return {
    ok: false,
    expected: ph.count,
    provided,
    source: ph.source,
    reason: `"${name}" has ${ph.count} blank${ph.count === 1 ? '' : 's'} ${where}, but this campaign gives ${provided}. WhatsApp fills the blanks strictly in order and counts them, so every message in this campaign would be turned down — not just some of them.${unfillable} Give this campaign one value for each blank, or change the blanks the message asks for.`,
  };
}

/**
 * The warning to show when a send is allowed only because nothing is known.
 *
 * IT FIRES ON EVERY CAMPAIGN THIS VENUE CREATES TODAY — the list has never been
 * checked, so `verified` is false for all 11 templates and the create route puts
 * this line in front of the owner every single time. It used to say "every
 * message in this campaign will fail", which is a prediction this app cannot
 * make and the scariest sentence in the system, guarding the very button the
 * 2026-09-15 ruling exists to make safe to press. What is actually true is what
 * it now says: nobody has looked yet, sending is still allowed, and being wrong
 * costs nothing — a message WhatsApp has not approved is turned down before it
 * reaches a guest, so no message goes out, nobody is contacted and nothing is
 * charged.
 */
export function unverifiedWarning(name: string): string {
  return `Nobody has checked yet what WhatsApp says about "${name}". You can still send this — if WhatsApp has not approved it, it turns every message down, no guest is contacted and nothing is charged. To find out first, press Refresh status on Settings → Integrations → WhatsApp → Templates.`;
}

/**
 * The warning for the narrow gap the category gate deliberately does not
 * refuse: an APPROVED template whose Meta category was never recorded here (a
 * row last touched by the status webhook, which carries no category). Allowed —
 * there is no evidence against it — but the operator is told that "approved"
 * was checked and "marketing" was not.
 */
export function categoryUnverifiedWarning(name: string, want: string): string {
  return `Template "${name}" is approved at Meta, but Meta's category for it has never been recorded here — so nothing could confirm it is a ${want} template. If it is not, Meta refuses every message in this campaign. Refresh the template list on Settings → Integrations → WhatsApp → Templates to record it.`;
}

/** Non-finished campaigns referencing a template name — the delete/edit guard. */
export function campaignsUsingTemplate(db: DB, templateName: string): Array<{ id: string; name: string; state: string }> {
  const name = String(templateName || '').trim();
  if (!name) return [];
  try {
    return db.prepare(`
      SELECT id, name, state FROM wa_campaigns
      WHERE template_name = ? AND state IN ('draft', 'scheduled', 'sending', 'paused')
      ORDER BY created_at DESC
    `).all(name) as any[];
  } catch { return []; }
}

/* ═══════════════════════ Delete / edit at Meta ═══════════════════════ */

/**
 * Delete a template at Meta.
 *
 * UNVERIFIED (model knowledge): DELETE /{waba-id}/message_templates?name=…
 * deletes BY NAME and removes EVERY language of that template — which is why
 * the caller must have already refused when a live campaign references it.
 */
export async function deleteTemplateAtMeta(
  name: string,
  opts: { fetchImpl?: FetchImpl } = {},
): Promise<{ ok: boolean; error?: string }> {
  const creds = metaCreds();
  if (!creds.ok) return { ok: false, error: creds.error };
  const doFetch: FetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  try {
    const r = await doFetch(
      graphUrl(`${encodeURIComponent(creds.creds.waba)}/message_templates?name=${encodeURIComponent(name)}`),
      { method: 'DELETE', headers: { Authorization: `Bearer ${creds.creds.token}` } },
    );
    const j: any = await r.json().catch(() => ({}));
    if (!r?.ok) return { ok: false, error: graphError(j, Number(r?.status) || 0) };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: networkError(e) };
  }
}

/**
 * Edit a template at Meta.
 *
 * UNVERIFIED (model knowledge): POST /{template-id} with components. AN EDIT
 * RESETS THE TEMPLATE TO PENDING and is rate-limited by Meta — the caller must
 * say so plainly, because an unexpected trip back to PENDING stops campaigns.
 *
 * CATEGORY IS SENT ONLY FOR A REJECTED TEMPLATE. "Wrong category" is the most
 * common rejection there is (a promotional body filed as UTILITY), so an edit
 * that carried only `components` made the single most likely fix impossible:
 * the admin corrects the category here, resubmits, and Meta re-reads the same
 * category it already refused. UNVERIFIED (model knowledge): Meta accepts
 * `category` on an edit while the template is REJECTED, and refuses to change
 * the category of an APPROVED one — which is why it is withheld in every other
 * state rather than sent unconditionally.
 */
export async function editTemplateAtMeta(
  db: DB,
  templateId: string,
  opts: { fetchImpl?: FetchImpl; nowMs?: number } = {},
): Promise<SubmitResult> {
  const row = db.prepare(`SELECT * FROM whatsapp_templates WHERE id = ?`).get(templateId) as any;
  if (!row) return { ok: false, error: 'Template not found.' };
  const metaId = String(row.meta_template_id || '').trim();
  if (!metaId) {
    return { ok: false, error: `"${row.name}" has no Meta template id, so there is nothing to edit at Meta. Submit it first.` };
  }

  const draft = draftFromRow(row);
  const v = validateTemplateDraft(draft);
  if (!v.ok) return { ok: false, errors: v.errors, error: v.errors[0] };

  const creds = metaCreds();
  if (!creds.ok) return { ok: false, error: creds.error };

  const components = buildMetaComponents(draft);
  // See the header note: the corrected category rides along only for a rejected
  // template, because that is the one state where Meta lets it change — and the
  // one state where withholding it would make the fix a dead end.
  const payload: { components: unknown[]; category?: string } = { components };
  if (String(row.meta_status || '') === 'rejected') {
    payload.category = draft.meta_category.toUpperCase();
  }
  const doFetch: FetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  let r: any;
  let j: any = {};
  try {
    r = await doFetch(graphUrl(encodeURIComponent(metaId)), {
      method: 'POST',
      headers: { Authorization: `Bearer ${creds.creds.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    j = await r.json().catch(() => ({}));
  } catch (e: any) {
    const detail = networkError(e);
    db.prepare(`UPDATE whatsapp_templates SET meta_last_error = ?, updated_at = datetime('now') WHERE id = ?`).run(detail, templateId);
    return { ok: false, error: detail };
  }
  if (!r?.ok) {
    const detail = graphError(j, Number(r?.status) || 0);
    db.prepare(`UPDATE whatsapp_templates SET meta_last_error = ?, updated_at = datetime('now') WHERE id = ?`).run(detail, templateId);
    return { ok: false, error: detail };
  }

  const now = utcString(opts.nowMs ?? Date.now());
  // An accepted edit sends the template back through review.
  db.prepare(`
    UPDATE whatsapp_templates
    SET meta_status = 'pending', meta_components = ?, meta_submitted_at = ?,
        meta_status_checked_at = ?, meta_last_error = '', meta_rejected_reason = '',
        param_order = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(JSON.stringify(components), now, now, paramOrderFromVarSpec(draft.var_spec), templateId);

  return { ok: true, status: 'pending', meta_template_id: metaId };
}
