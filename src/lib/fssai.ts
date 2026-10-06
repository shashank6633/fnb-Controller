/**
 * FSSAI Compliance — shared contract module.
 *
 * THE single source of truth for the checklist ENGINE: the eight question
 * types, the frequency vocabulary, the status badge metadata, the permission
 * predicates, the pass/fail evaluator, the version-bump rule and the
 * one-run-per-slot rule. The API routes under src/app/api/fssai/** and the
 * screens under src/app/fssai/** both import from here, so a button and the
 * refusal behind it can never disagree (RECON §8, the variance-queue lesson).
 *
 * Pure module — no runtime DB import. It imports a *type* from ./auth (erased
 * at compile time) and the recurrence maths from ./tasks (itself pure), so it
 * is safe on both server and client. Model: src/lib/tasks.ts.
 *
 * WHY THE VOCABULARY IS FROZEN HERE AND NOWHERE ELSE (RECON §10 R1 — the
 * most likely failure of this build): twelve of the twenty sub-modules ship as
 * seeded template ROWS in P8. If the engine grows a question type or a
 * pass/fail rule after those rows are written, the seeds silently encode the
 * old shape, and because boot errors are swallowed and seeds are
 * INSERT OR IGNORE, a half-migrated template looks exactly like a correct one.
 * So: a template referencing a qtype this file does not declare must FAIL
 * LOUDLY (qtypeMeta returns null and the caller refuses), never render a blank
 * field.
 */

import type { SessionUser } from './auth';
import { nextRecurrence, type RecurrenceFrequency } from './tasks';

/* ------------------------------------------------------------------ *
 * 1. THE EIGHT QUESTION TYPES
 * ------------------------------------------------------------------ */

/**
 * The owner named these eight (FSSAI-BUILD-STATE.md §15 / the P2 brief) and
 * fssai_questions.qtype stores the key. There is deliberately NO CHECK
 * constraint on that column (db.ts) — the vocabulary is code-side, and this
 * array is it.
 */
export type FssaiQType =
  | 'yes_no'
  | 'pass_fail'
  | 'numeric'
  | 'temperature'
  | 'text'
  | 'photo'
  | 'multiple_choice'
  | 'signature';

export interface QTypeMeta {
  key: FssaiQType;
  label: string;
  /** Which fssai_responses column carries the answer. */
  value: 'bool' | 'num' | 'text' | 'evidence';
  /** Uses min_value / max_value / target_value / decimals / uom. */
  usesRange: boolean;
  /** Uses options_json + fail_options_json. */
  usesOptions: boolean;
  /** Uses expected_value (which answer passes). */
  usesExpected: boolean;
  /** One line an admin reads while choosing the type. */
  hint: string;
}

export const FSSAI_QTYPES: readonly QTypeMeta[] = [
  { key: 'yes_no',          label: 'Yes / No',         value: 'bool',     usesRange: false, usesOptions: false, usesExpected: true,  hint: 'Two buttons. You choose which answer counts as a pass.' },
  { key: 'pass_fail',       label: 'Pass / Fail',      value: 'bool',     usesRange: false, usesOptions: false, usesExpected: true,  hint: 'Two buttons. Normally Pass is the passing answer.' },
  { key: 'numeric',         label: 'Number',           value: 'num',      usesRange: true,  usesOptions: false, usesExpected: false, hint: 'A reading with an optional acceptable range and a unit.' },
  { key: 'temperature',     label: 'Temperature',      value: 'num',      usesRange: true,  usesOptions: false, usesExpected: false, hint: 'A temperature in °C with a minimum and a maximum. Never hard-coded in software.' },
  { key: 'text',            label: 'Text',             value: 'text',     usesRange: false, usesOptions: false, usesExpected: false, hint: 'Free text. Records words; it never fails on its own.' },
  { key: 'photo',           label: 'Photo',            value: 'evidence', usesRange: false, usesOptions: false, usesExpected: false, hint: 'A photograph is the answer. Fails if it is required and missing.' },
  { key: 'multiple_choice', label: 'Multiple choice',  value: 'text',     usesRange: false, usesOptions: true,  usesExpected: false, hint: 'A list of answers. You mark which of them count as a fail.' },
  { key: 'signature',       label: 'Signature',        value: 'text',     usesRange: false, usesOptions: false, usesExpected: false, hint: 'The signed-in person and the time (§7 Q6 provisional — no drawing).' },
] as const;

/** Metadata for a qtype, or null for a type this build does not know (R1). */
export function qtypeMeta(key: string | null | undefined): QTypeMeta | null {
  return FSSAI_QTYPES.find((t) => t.key === key) ?? null;
}

export function isFssaiQType(key: string | null | undefined): key is FssaiQType {
  return !!qtypeMeta(key);
}

/** Evidence rules — the same three values on photo_rule and note_rule. */
export type FssaiEvidenceRule = 'never' | 'on_fail' | 'always';
export const FSSAI_EVIDENCE_RULES: readonly { key: FssaiEvidenceRule; label: string }[] = [
  { key: 'never',   label: 'Not needed' },
  { key: 'on_fail', label: 'Only when it fails' },
  { key: 'always',  label: 'Always' },
] as const;
export function isEvidenceRule(v: string | null | undefined): v is FssaiEvidenceRule {
  return v === 'never' || v === 'on_fail' || v === 'always';
}

/* ------------------------------------------------------------------ *
 * 2. FREQUENCY
 * ------------------------------------------------------------------ */

/**
 * FSSAI needs a wider vocabulary than the Task module's
 * RecurrenceFrequency ('daily' | 'weekly' | 'monthly', tasks.ts:206). The
 * three it does cover DELEGATE to nextRecurrence — a second implementation of
 * that maths is an automatic drift defect (RECON §5, "rails FSSAI must not
 * rebuild").
 */
export type FssaiFrequency =
  | 'hourly'
  | 'per_shift'
  | 'twice_daily'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'quarterly'
  | 'yearly'
  | 'on_event';

export const FSSAI_FREQUENCIES: readonly { key: FssaiFrequency; label: string; hint: string }[] = [
  { key: 'hourly',      label: 'Every hour',      hint: 'Times of day are listed on the assignment.' },
  { key: 'per_shift',   label: 'Every shift',     hint: 'One run per shift named on the assignment.' },
  { key: 'twice_daily', label: 'Twice a day',     hint: 'Typically opening and closing.' },
  { key: 'daily',       label: 'Daily',           hint: 'Once every day.' },
  { key: 'weekly',      label: 'Weekly',          hint: 'On the chosen day of the week.' },
  { key: 'monthly',     label: 'Monthly',         hint: 'On the chosen day of the month.' },
  { key: 'quarterly',   label: 'Quarterly',       hint: 'Every three months, on the chosen day.' },
  { key: 'yearly',      label: 'Yearly',          hint: 'Once a year, on the chosen day.' },
  { key: 'on_event',    label: 'When it happens', hint: 'No schedule — run it at a delivery, a breakdown, an inspection.' },
] as const;

export function isFssaiFrequency(v: string | null | undefined): v is FssaiFrequency {
  return FSSAI_FREQUENCIES.some((f) => f.key === v);
}

/** How many runs a frequency expects in one day (0 = not daily-shaped). */
export function runsPerDay(freq: FssaiFrequency, timesCsv = ''): number {
  if (freq === 'hourly') {
    const n = timesCsv.split(',').map((s) => s.trim()).filter(Boolean).length;
    return n || 24;
  }
  if (freq === 'twice_daily') return 2;
  if (freq === 'per_shift' || freq === 'daily') return 1;
  return 0;
}

/**
 * Next due date (YYYY-MM-DD) strictly after fromISODate.
 *
 * daily / weekly / monthly are nextRecurrence verbatim. The four FSSAI-only
 * schedules are expressed in terms of it so there is still exactly one
 * implementation of the calendar maths:
 *   · hourly / per_shift / twice_daily  — several runs inside ONE day, so the
 *     next DATE is simply the next day (the time-of-day list lives in
 *     fssai_assignments.times_csv and is P3/P7's concern, not the date's).
 *   · quarterly / yearly — monthly, applied 3 / 12 times.
 *   · on_event — never scheduled; returns ''.
 */
export function fssaiNextDueDate(
  freq: FssaiFrequency,
  fromISODate: string,
  dayOfWeek?: number,
  dayOfMonth?: number,
): string {
  if (freq === 'on_event') return '';
  if (freq === 'hourly' || freq === 'per_shift' || freq === 'twice_daily' || freq === 'daily') {
    return nextRecurrence('daily' as RecurrenceFrequency, fromISODate, dayOfWeek, dayOfMonth);
  }
  if (freq === 'weekly') return nextRecurrence('weekly', fromISODate, dayOfWeek, dayOfMonth);
  if (freq === 'monthly') return nextRecurrence('monthly', fromISODate, dayOfWeek, dayOfMonth);
  const steps = freq === 'quarterly' ? 3 : 12;
  let cursor = fromISODate;
  for (let i = 0; i < steps; i++) {
    cursor = nextRecurrence('monthly', cursor, dayOfWeek, dayOfMonth);
    if (!cursor) return '';
  }
  return cursor;
}

/* ------------------------------------------------------------------ *
 * 3. THE REST OF THE VOCABULARY
 * ------------------------------------------------------------------ */

/** What one run is performed AGAINST. fssai_runs.target_kind / target_id. */
export type FssaiTargetKind = 'none' | 'equipment' | 'area' | 'department' | 'grn' | 'batch' | 'person';
export const FSSAI_TARGET_KINDS: readonly { key: FssaiTargetKind; label: string; hint: string }[] = [
  { key: 'none',       label: 'Nothing in particular', hint: 'One run per shift for the whole restaurant.' },
  { key: 'equipment',  label: 'A piece of equipment',  hint: 'A cold room, a chiller, a fryer — one run each.' },
  { key: 'area',       label: 'An area',               hint: 'A named place: the wash-up, the bin store.' },
  { key: 'department', label: 'A department',          hint: 'Kitchen, Bar, Housekeeping.' },
  { key: 'grn',        label: 'A delivery',            hint: 'Run at the door against one goods receipt.' },
  { key: 'batch',      label: 'A production batch',    hint: 'Against one prepared batch.' },
  // 'person' is what makes Personal Hygiene one record per person per shift
  // with NO special case in the slot rule — the person is IN the slot key.
  { key: 'person',     label: 'A person',              hint: 'One run per member of staff — personal hygiene.' },
] as const;
export function isFssaiTargetKind(v: string | null | undefined): v is FssaiTargetKind {
  return FSSAI_TARGET_KINDS.some((t) => t.key === v);
}

/** fssai_runs.shift / fssai_assignments.shift. '' = the whole day. */
export const FSSAI_SHIFTS: readonly { key: string; label: string }[] = [
  { key: '',          label: 'Any time' },
  { key: 'opening',   label: 'Opening' },
  { key: 'morning',   label: 'Morning' },
  { key: 'afternoon', label: 'Afternoon' },
  { key: 'evening',   label: 'Evening' },
  { key: 'closing',   label: 'Closing' },
  { key: 'night',     label: 'Night' },
] as const;
export function isFssaiShift(v: string | null | undefined): boolean {
  return FSSAI_SHIFTS.some((s) => s.key === (v ?? ''));
}

/**
 * Which of the twenty sub-modules owns a template
 * (fssai_templates.module_key). These are the FSSAI_MODULES hrefs in
 * src/app/fssai/_components/modules.ts with the '/fssai/' prefix removed —
 * restated as plain strings here so this module stays free of the icon import
 * and is safe to load on the server. '' = a checklist the owner wrote himself
 * that belongs to no record module.
 */
export const FSSAI_MODULE_KEYS: readonly string[] = [
  'receiving', 'fifo', 'cold-rooms', 'temperature', 'food-quality', 'pest-control',
  'cleaning', 'hygiene', 'storage', 'kitchen-safety', 'water-ice', 'oil-quality',
] as const;

/** fssai_equipment.kind — declared here so P4's Settings tab has one list. */
export const FSSAI_EQUIPMENT_KINDS: readonly { key: string; label: string }[] = [
  { key: 'cold_room',    label: 'Cold room' },
  { key: 'chiller',      label: 'Chiller' },
  { key: 'freezer',      label: 'Freezer' },
  { key: 'hot_holding',  label: 'Hot holding' },
  { key: 'fryer',        label: 'Fryer' },
  { key: 'dishwasher',   label: 'Dishwasher' },
  { key: 'water_filter', label: 'Water filter' },
  { key: 'other',        label: 'Other' },
] as const;

/* ------------------------------------------------------------------ *
 * 4. STATUS BADGES — the house metadata-array pattern (RECON §1.5)
 * ------------------------------------------------------------------ */

export interface FssaiStatusMeta { key: string; label: string; color: string }

/** fssai_templates.status */
export const FSSAI_TEMPLATE_STATUSES: readonly FssaiStatusMeta[] = [
  { key: 'draft',     label: 'Draft',     color: 'bg-gray-100 text-gray-700 border-gray-200' },
  { key: 'published', label: 'Published', color: 'bg-green-100 text-green-700 border-green-200' },
  { key: 'archived',  label: 'Archived',  color: 'bg-gray-100 text-gray-600 border-gray-200' },
] as const;

/** fssai_runs.status */
export const FSSAI_RUN_STATUSES: readonly FssaiStatusMeta[] = [
  { key: 'in_progress', label: 'In progress',  color: 'bg-amber-100 text-amber-800 border-amber-200' },
  { key: 'submitted',   label: 'Submitted',    color: 'bg-teal-100 text-teal-700 border-teal-200' },
  { key: 'verified',    label: 'Verified',     color: 'bg-green-100 text-green-700 border-green-200' },
  { key: 'rejected',    label: 'Sent back',    color: 'bg-red-100 text-red-700 border-red-200' },
  { key: 'void',        label: 'Voided',       color: 'bg-gray-100 text-gray-600 border-gray-200' },
] as const;

function metaFrom(list: readonly FssaiStatusMeta[], key: string | null | undefined): FssaiStatusMeta {
  const found = list.find((s) => s.key === key);
  if (found) return found;
  const k = String(key || '');
  return {
    key: k,
    label: k ? k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '—',
    color: 'bg-gray-100 text-gray-700 border-gray-200',
  };
}
export function fssaiTemplateStatusMeta(key: string | null | undefined): FssaiStatusMeta {
  return metaFrom(FSSAI_TEMPLATE_STATUSES, key);
}
export function fssaiRunStatusMeta(key: string | null | undefined): FssaiStatusMeta {
  return metaFrom(FSSAI_RUN_STATUSES, key);
}

/* ------------------------------------------------------------------ *
 * 5. PERMISSIONS
 * ------------------------------------------------------------------ */

/**
 * The subset of SessionUser the FSSAI gates read. Structural so a test can
 * pass a literal, and so nothing here needs the whole session object.
 */
export type FssaiActor = Pick<SessionUser, 'role' | 'is_head_chef'> & { email?: string };

/**
 * MAY CONFIGURE THE MODULE — create and edit checklists, sections, questions,
 * assignments and equipment.
 *
 * ADMIN ONLY, deliberately. Owner §20: only the administrator configures. This
 * is narrower than canManageTasks (admin | manager | head chef | store
 * manager) on purpose: a head chef editing the pass mark of the checklist his
 * own kitchen is measured by is the exact failure a food-safety record exists
 * to prevent (RECON §10 R4).
 *
 * §7 Q8 (PROVISIONAL DEFAULT, the owner has not ruled): FSSAI uses the three
 * tiers that exist — Staff / Manager / Admin. It NEVER creates a role;
 * production config is the owner's (HARD RULE 4).
 */
export function canAuthorFssai(me: FssaiActor | null | undefined): boolean {
  if (!me) return false;
  return me.role === 'admin';
}

/** MAY RUN A CHECK — any signed-in user. Staff are exactly who runs checks. */
export function canRunFssaiCheck(me: FssaiActor | null | undefined): boolean {
  return !!me;
}

/**
 * MAY VERIFY A SUBMITTED RUN.
 *
 * §7 Q3 (PROVISIONAL DEFAULT): any management may verify, but NEVER the person
 * who recorded the run. Strictly narrower than canApproveTasks, which is
 * identical to canManageTasks and would let a head chef sign off his own
 * kitchen (RECON §10 R4). The recorded_by test cannot live in the schema —
 * it is enforced here and re-checked in the route.
 */
export function canVerifyFssai(
  me: FssaiActor | null | undefined,
  recordedByEmail?: string | null,
): boolean {
  if (!me) return false;
  const isMgmt = me.role === 'admin' || me.role === 'manager' || !!me.is_head_chef;
  if (!isMgmt) return false;
  const mine = String(me.email || '').trim().toLowerCase();
  const ran = String(recordedByEmail || '').trim().toLowerCase();
  if (mine && ran && mine === ran) return false;
  return true;
}

/** MAY TAKE OVER SOMEONE ELSE'S OPEN RUN — management only, with a reason. */
export function canTakeOverFssaiRun(me: FssaiActor | null | undefined): boolean {
  if (!me) return false;
  return me.role === 'admin' || me.role === 'manager' || !!me.is_head_chef;
}

/* ------------------------------------------------------------------ *
 * 6. QUESTION VALIDATION — one validator, used by the API and the builder
 * ------------------------------------------------------------------ */

export interface FssaiQuestionInput {
  qtype?: string | null;
  prompt?: string | null;
  help_text?: string | null;
  uom?: string | null;
  min_value?: number | string | null;
  max_value?: number | string | null;
  target_value?: number | string | null;
  decimals?: number | string | null;
  expected_value?: string | null;
  options?: unknown;
  fail_options?: unknown;
  is_required?: unknown;
  is_critical?: unknown;
  allow_na?: unknown;
  photo_rule?: string | null;
  note_rule?: string | null;
  raise_ca_on_fail?: unknown;
  ca_severity?: string | null;
  code?: string | null;
}

export interface FssaiQuestionNormalized {
  qtype: FssaiQType;
  prompt: string;
  help_text: string;
  uom: string;
  min_value: number | null;
  max_value: number | null;
  target_value: number | null;
  decimals: number;
  expected_value: string;
  options: string[];
  fail_options: string[];
  is_required: 0 | 1;
  is_critical: 0 | 1;
  allow_na: 0 | 1;
  photo_rule: FssaiEvidenceRule;
  note_rule: FssaiEvidenceRule;
  raise_ca_on_fail: 0 | 1;
  ca_severity: string;
  code: string;
}

export type FssaiValidation<T> = { ok: true; value: T } | { ok: false; error: string };

const CA_SEVERITIES = ['low', 'medium', 'high', 'urgent'] as const;

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '') return null;                 // blank is NOT zero (RECON §6.4)
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;       // NaN = "they typed something that is not a number"
}

function bool01(v: unknown, dflt: 0 | 1): 0 | 1 {
  if (v === undefined || v === null || v === '') return dflt;
  if (typeof v === 'string') return v === '0' || v.toLowerCase() === 'false' ? 0 : 1;
  return v ? 1 : 0;
}

/**
 * Trim, drop blanks, drop duplicates, keep order.
 *
 * ONLY text and numbers are answers. An object used to be coerced with
 * String(), which stored the literal label "[object Object]" and offered it to
 * staff as a choosable answer on a compliance checklist (measured: POST
 * options:[{a:1},'Fine'] → options_json ["[object Object]","Fine"]). Anything
 * that is not a string or a finite number is DROPPED here and reported by
 * badFssaiOptionValue() below, so the admin gets a sentence instead of a
 * nonsense answer.
 */
export function cleanFssaiOptions(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (!isUsableOptionValue(raw)) continue;
    const s = String(raw).trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function isUsableOptionValue(raw: unknown): boolean {
  if (typeof raw === 'string') return true;
  if (typeof raw === 'number') return Number.isFinite(raw);
  return false;
}

/** The first element of an options list that is not text or a number, if any. */
export function badFssaiOptionValue(v: unknown): { index: number; kind: string } | null {
  if (!Array.isArray(v)) return null;
  for (let i = 0; i < v.length; i++) {
    const raw = v[i];
    if (raw === null || raw === undefined || raw === '') continue;   // blanks are dropped, not an error
    if (!isUsableOptionValue(raw)) {
      return { index: i, kind: Array.isArray(raw) ? 'a list' : typeof raw === 'object' ? 'a block of data' : typeof raw };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 6b. THE TWO-BUTTON ANSWER, IN WORDS
 * ------------------------------------------------------------------ */

/**
 * WHAT COUNTS AS "yes" / "no" WHEN THE ANSWER ARRIVES AS TEXT.
 *
 * MEASURED DEFECT (P2 adversarial probe). A Yes/No question answered
 * `value_text:'yes'` was recorded as a compliance FAILURE — HTTP 200, is_fail=1
 * frozen onto the response — because the evaluator read only value_bool and an
 * absent boolean means "not answered", which for a required question means a
 * fail. The frozen record then read "Door seal intact? = yes" next to a FAIL
 * verdict, which is what an inspector would have been shown.
 *
 * So the words live HERE, in the shared predicate, and both the evaluator and
 * the run route use them: a client that sends the word and a client that sends
 * the boolean must reach the same verdict. Anything outside these two lists is
 * NOT guessed at — it is refused by name (see evaluateFssaiAnswer and the
 * answer route), because silently treating "maybe" as a fail is the bug this
 * exists to prevent.
 */
const FSSAI_YES_WORDS: readonly string[] = ['yes', 'y', 'true', '1', 'pass', 'passed', 'ok', 'okay'];
const FSSAI_NO_WORDS: readonly string[] = ['no', 'n', 'false', '0', 'fail', 'failed', 'not ok'];

/** true / false for a recognised word, null for blank or anything unrecognised. */
export function fssaiBoolFromText(v: unknown): boolean | null {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  if (FSSAI_YES_WORDS.includes(s)) return true;
  if (FSSAI_NO_WORDS.includes(s)) return false;
  return null;
}

/** Is this a two-button question (its answer lives in value_bool)? */
export function isFssaiBoolQType(qtype: string | null | undefined): boolean {
  const meta = qtypeMeta(qtype);
  return !!meta && meta.value === 'bool';
}

/** The two words this particular question expects, for an error message. */
export function fssaiBoolWordsFor(qtype: string | null | undefined): string {
  return qtype === 'pass_fail' ? 'pass or fail' : 'yes or no';
}

/**
 * Round a reading to the decimal places the question declares.
 *
 * DISPLAY ONLY, deliberately. `decimals` is how the reading is written down and
 * shown; it is NEVER applied before the pass/fail test, because rounding first
 * can mask a genuinely out-of-range reading (5.4 °C on a 0–5 rule would round
 * to 5 and PASS). So the stored value stays exactly what was measured, the
 * verdict is taken on that value, and this is what a screen or a PDF prints.
 */
export function fssaiDisplayReading(value: number | null | undefined, decimals: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '';
  const d = Number(decimals);
  const places = Number.isFinite(d) && d >= 0 && d <= 3 ? Math.trunc(d) : 1;
  return Number(value).toFixed(places);
}

/**
 * Validate and normalise one question. EVERY type is checked for what it
 * actually needs, and the error text is written for a restaurant manager
 * (RECON §2.3 — apiJson surfaces it straight onto his screen).
 *
 * `existing` lets a PATCH-shaped edit merge over the stored row and then
 * validate the FINAL shape once — the HRMS idiom (api/hr/tests/route.ts:695),
 * so editing only the options still re-checks that the fail answers are still
 * members of the list.
 */
export function normalizeFssaiQuestion(
  input: FssaiQuestionInput,
  existing?: Partial<FssaiQuestionNormalized>,
): FssaiValidation<FssaiQuestionNormalized> {
  const pick = <K extends keyof FssaiQuestionInput>(k: K, fallback: unknown) =>
    input[k] !== undefined ? input[k] : fallback;

  const qtypeRaw = String(pick('qtype', existing?.qtype ?? 'yes_no') ?? '').trim();
  const meta = qtypeMeta(qtypeRaw);
  if (!meta) {
    return {
      ok: false,
      error:
        `"${qtypeRaw || '(blank)'}" is not a question type this system knows. ` +
        `The eight types are: ${FSSAI_QTYPES.map((t) => t.label).join(', ')}.`,
    };
  }
  const qtype = meta.key;

  const prompt = String(pick('prompt', existing?.prompt ?? '') ?? '').trim();
  if (!prompt) return { ok: false, error: 'Type the question staff will see.' };
  if (prompt.length > 400) return { ok: false, error: 'Keep the question under 400 characters.' };

  const help_text = String(pick('help_text', existing?.help_text ?? '') ?? '').trim();
  const code = String(pick('code', existing?.code ?? '') ?? '').trim();

  let uom = String(pick('uom', existing?.uom ?? '') ?? '').trim();
  let min_value: number | null = null;
  let max_value: number | null = null;
  let target_value: number | null = null;
  let decimals = 1;
  let expected_value = '';
  let options: string[] = [];
  let fail_options: string[] = [];

  /* ── the range types ── */
  if (meta.usesRange) {
    const mn = num(pick('min_value', existing?.min_value ?? null));
    const mx = num(pick('max_value', existing?.max_value ?? null));
    const tg = num(pick('target_value', existing?.target_value ?? null));
    if (Number.isNaN(mn)) return { ok: false, error: 'The lowest acceptable value must be a number, or left blank for no limit.' };
    if (Number.isNaN(mx)) return { ok: false, error: 'The highest acceptable value must be a number, or left blank for no limit.' };
    if (Number.isNaN(tg)) return { ok: false, error: 'The target value must be a number, or left blank.' };
    min_value = mn; max_value = mx; target_value = tg;

    if (min_value !== null && max_value !== null && min_value > max_value) {
      return {
        ok: false,
        error: `The lowest acceptable value (${min_value}) is higher than the highest (${max_value}). Nothing could ever pass this check.`,
      };
    }
    if (target_value !== null) {
      if (min_value !== null && target_value < min_value) {
        return { ok: false, error: `The target (${target_value}) is below the lowest acceptable value (${min_value}).` };
      }
      if (max_value !== null && target_value > max_value) {
        return { ok: false, error: `The target (${target_value}) is above the highest acceptable value (${max_value}).` };
      }
    }

    const d = num(pick('decimals', existing?.decimals ?? (qtype === 'temperature' ? 1 : 0)));
    if (d === null || Number.isNaN(d) || d < 0 || d > 3 || !Number.isInteger(d)) {
      return { ok: false, error: 'Decimal places must be a whole number between 0 and 3.' };
    }
    decimals = d;
    if (qtype === 'temperature' && !uom) uom = 'C';   // the degree sign is added at render/PDF time
    if (uom.length > 16) return { ok: false, error: 'Keep the unit short (16 characters or fewer).' };
  } else {
    uom = '';
    decimals = 1;
  }

  /* ── the two-button types ── */
  if (meta.usesExpected) {
    const allowed = qtype === 'yes_no' ? ['yes', 'no'] : ['pass', 'fail'];
    const raw = String(pick('expected_value', existing?.expected_value ?? allowed[0]) ?? '').trim().toLowerCase();
    const val = raw || allowed[0];
    if (!allowed.includes(val)) {
      return { ok: false, error: `The passing answer must be ${allowed[0]} or ${allowed[1]}.` };
    }
    expected_value = val;
  }

  /* ── multiple choice ── */
  if (meta.usesOptions) {
    const rawOptions = pick('options', existing?.options ?? []);
    const badOption = badFssaiOptionValue(rawOptions);
    if (badOption) {
      return {
        ok: false,
        error: `Answer ${badOption.index + 1} on the list is ${badOption.kind}, not something staff could read. Type the answer as words.`,
      };
    }
    const badFail = badFssaiOptionValue(pick('fail_options', existing?.fail_options ?? []));
    if (badFail) {
      return {
        ok: false,
        error: `Fail answer ${badFail.index + 1} is ${badFail.kind}, not something staff could read. Type the answer as words.`,
      };
    }
    options = cleanFssaiOptions(rawOptions);
    if (options.length < 2) {
      return { ok: false, error: 'A multiple-choice question needs at least 2 answers to choose from.' };
    }
    if (options.length > 12) {
      return { ok: false, error: 'A multiple-choice question can have at most 12 answers.' };
    }
    fail_options = cleanFssaiOptions(pick('fail_options', existing?.fail_options ?? []));
    const stray = fail_options.find((f) => !options.includes(f));
    if (stray) {
      return { ok: false, error: `"${stray}" is marked as a fail but is not one of the answers on the list.` };
    }
    if (fail_options.length === options.length) {
      return { ok: false, error: 'Every answer is marked as a fail, so this question could never pass. Leave at least one answer as a pass.' };
    }
  }

  /* ── evidence rules ── */
  let photo_rule = String(pick('photo_rule', existing?.photo_rule ?? 'never') ?? '').trim() as FssaiEvidenceRule;
  if (!isEvidenceRule(photo_rule)) return { ok: false, error: 'Photo requirement must be: not needed, only when it fails, or always.' };
  let note_rule = String(pick('note_rule', existing?.note_rule ?? 'never') ?? '').trim() as FssaiEvidenceRule;
  if (!isEvidenceRule(note_rule)) return { ok: false, error: 'Note requirement must be: not needed, only when it fails, or always.' };
  // A photo QUESTION whose answer is the photograph cannot be "photo not
  // needed" — that is a question with no answer. Corrected rather than
  // refused, because the admin's intent is unambiguous.
  if (qtype === 'photo' && photo_rule === 'never') photo_rule = 'always';
  // Text questions are how a regulation asks for words; if the answer is the
  // text itself, "note not needed" is equally meaningless only when the
  // question is required — left alone otherwise.
  if (qtype === 'text' && note_rule === 'on_fail') note_rule = 'never';

  const ca_severity = String(pick('ca_severity', existing?.ca_severity ?? 'medium') ?? '').trim() || 'medium';
  if (!(CA_SEVERITIES as readonly string[]).includes(ca_severity)) {
    return { ok: false, error: `Severity must be one of: ${CA_SEVERITIES.join(', ')}.` };
  }

  return {
    ok: true,
    value: {
      qtype, prompt, help_text, uom,
      min_value, max_value, target_value, decimals,
      expected_value, options, fail_options,
      is_required: bool01(pick('is_required', existing?.is_required ?? 1), 1),
      is_critical: bool01(pick('is_critical', existing?.is_critical ?? 0), 0),
      allow_na:    bool01(pick('allow_na',    existing?.allow_na    ?? 1), 1),
      photo_rule, note_rule,
      raise_ca_on_fail: bool01(pick('raise_ca_on_fail', existing?.raise_ca_on_fail ?? 0), 0),
      ca_severity, code,
    },
  };
}

/* ------------------------------------------------------------------ *
 * 7. THE VERSION RULE
 * ------------------------------------------------------------------ */

/**
 * WHICH TEMPLATE HEADER EDITS BUMP fssai_templates.version.
 *
 * The rule, in one sentence: bump when the edit changes WHAT WAS ASKED or HOW
 * IT WAS JUDGED; do not bump for a cosmetic or organisational change.
 *
 * Every section and question mutation bumps unconditionally (see
 * bumpTemplateVersion in the routes) — creating, editing, reordering,
 * retiring or reactivating one all change the paper. Header fields are the
 * only ones that need a list, and this is it. Exported so the API and the
 * builder screen cannot disagree about what counts as a structural change.
 */
export const FSSAI_VERSION_BUMPING_TEMPLATE_FIELDS: readonly string[] = [
  'pass_threshold_pct',     // how many answers must pass
  'target_kind',            // what the run is performed against
  'requires_signature',     // whether a signature is part of the record
  'requires_verification',  // whether someone else must sign it off
] as const;

/** True when this set of changed header fields must bump the version. */
export function templateEditBumpsVersion(changedFields: Iterable<string>): boolean {
  for (const f of changedFields) {
    if (FSSAI_VERSION_BUMPING_TEMPLATE_FIELDS.includes(f)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * 8. THE ONE-RUN-PER-SLOT RULE  (§7 Q12)
 * ------------------------------------------------------------------ */

/**
 * A SLOT is (template, business date, target, shift) — the
 * uq_fssai_runs_open index key MINUS recorded_by.
 *
 * WHY THE ROUTE OWNS THIS AND THE SCHEMA CANNOT. uq_fssai_runs_open ends in
 * recorded_by, so the DATABASE only guarantees one open run per slot PER
 * PERSON. Measured on a fixture during P1: two staff can open the same slot
 * concurrently, and three SUBMITTED runs accumulated on one slot. Two people
 * filling in the same hygiene checklist for the same shift leaves two
 * contradictory records of one round, which is precisely what a compliance
 * file must not contain.
 *
 * THE RULE CHOSEN, AND WHY (the four options were weighed in the P2 map):
 *   · ONE open run per slot, whoever opened it.
 *   · The same person re-opening it RESUMES — never a duplicate. (HRMS
 *     api/hr/tests/route.ts:383-392, verbatim in spirit.)
 *   · A DIFFERENT person is REFUSED with a plain 409 that names who has it
 *     open and how far they have got — never a silent second run, and never a
 *     raw SQLITE_CONSTRAINT, which reads to staff as a crash.
 *   · Once the slot holds a SUBMITTED or VERIFIED run it is closed: a second
 *     run for the same slot is refused. This is the cap uq_fssai_runs_open
 *     cannot express, because it is partial on status='in_progress'.
 *   · A REJECTED or VOID prior run does NOT close the slot — a check sent
 *     back must be redoable, and a voided one never happened.
 *   · Per-person checks (personal hygiene) are not an exception: they are
 *     target_kind='person' with target_id = the person's email, so the person
 *     is inside the slot key and the same rule yields one run each.
 *
 * HOW FAR THE STORAGE BACKSTOP ACTUALLY REACHES — say it plainly rather than
 * claim more than is true. uq_fssai_runs_open catches only the SAME PERSON
 * opening the same slot twice, because recorded_by is in its key; the route
 * maps that SQLITE_CONSTRAINT to the same 409. The cross-person rule is
 * enforced ONLY by the SELECT-then-INSERT below, which is atomic here because
 * better-sqlite3 is synchronous, getDb() caches one connection, and production
 * runs a single process (deploy/fnb-controller.service: `npm run start`,
 * Type=simple, no cluster directive). If this app were ever clustered, two
 * different people could race past that check and the index would NOT stop
 * them. Dropping recorded_by from the index would close it — that is a schema
 * change on a table that will hold audit history, so it is an owner decision
 * for P11, not something P2 does quietly.
 */
export interface FssaiRunSlot {
  template_id: string;
  business_date: string;
  target_id: string;
  shift: string;
}

/**
 * Separator for the slot key. An ASCII unit separator, written as an escape
 * so the source file stays plain text: a target label is free text and could
 * legitimately contain a pipe or a colon, which would let two different slots
 * collapse onto one key.
 */
const SLOT_SEP = '\u001f';

export function fssaiSlotKey(slot: FssaiRunSlot): string {
  return [slot.template_id, slot.business_date, slot.target_id || '', slot.shift || ''].join(SLOT_SEP);
}

/** The minimum a decision needs to know about a run already in the slot. */
export interface FssaiSlotRunRow {
  id: string;
  status: string;
  recorded_by: string;
  recorded_name?: string;
  started_at?: string;
  submitted_at?: string;
  answered_count?: number;
  total_count?: number;
  /** 'pass' | 'fail' | '' — a recorded FAILURE is refused in different words */
  outcome?: string | null;
  /** so the caller can say whether the blocked person may even open that record */
  department_id?: string | null;
}

export type FssaiSlotDecision =
  | { action: 'resume';  run_id: string }
  | { action: 'create' }
  | { action: 'refuse';  code: 'slot_open_elsewhere' | 'slot_already_recorded'; message: string; run_id: string };

/**
 * THE shared predicate. The "can I start this?" query and the POST route both
 * call it, so the button and the refusal can never disagree.
 *
 * @param openRun     the in_progress run in this slot, or null
 * @param decidedRun  a submitted/verified run in this slot, or null
 */
export function decideFssaiSlot(params: {
  meEmail: string;
  openRun: FssaiSlotRunRow | null;
  decidedRun: FssaiSlotRunRow | null;
}): FssaiSlotDecision {
  const me = String(params.meEmail || '').trim().toLowerCase();
  const open = params.openRun;
  if (open) {
    if (String(open.recorded_by || '').trim().toLowerCase() === me) {
      return { action: 'resume', run_id: open.id };
    }
    const who = open.recorded_name || open.recorded_by || 'Someone';
    const progress =
      open.total_count && open.total_count > 0
        ? ` ${open.answered_count ?? 0} of ${open.total_count} answered.`
        : '';
    return {
      action: 'refuse',
      code: 'slot_open_elsewhere',
      run_id: open.id,
      message:
        `${who} already has this check open.${progress} ` +
        `Two people filling in the same check for the same shift leaves two records of one round, so only one can be open at a time.`,
    };
  }
  const decided = params.decidedRun;
  if (decided) {
    const who = decided.recorded_name || decided.recorded_by
      ? ` by ${decided.recorded_name || decided.recorded_by}`
      : '';
    // A RECORDED FAILURE is refused in different words. Telling someone to
    // "open that record instead" when the record says the cold room failed
    // reads as though the software has not noticed, and the honest remedy is
    // not a second record — it is the manager's void if it was a mistake.
    // How a genuine RE-CHECK after a repair should be filed is the owner's
    // call: FSSAI-BUILD-STATE.md §7 Q14.
    const failed = String(decided.outcome || '').toLowerCase() === 'fail';
    return {
      action: 'refuse',
      code: 'slot_already_recorded',
      run_id: decided.id,
      message: failed
        ? `This check has already been recorded for this date and shift${who}, and it FAILED. ` +
          `A second record would hide that. Open the failed record; a manager can void it if it was entered by mistake.`
        : `This check has already been recorded for this date and shift${who}. ` +
          `Open that record instead — a second one would contradict it.`,
    };
  }
  return { action: 'create' };
}

/* ------------------------------------------------------------------ *
 * 8b. CONFIGURATION WARNINGS — said out loud, never enforced silently
 * ------------------------------------------------------------------ */

/**
 * Things about a checklist's SETUP that will surprise the owner once staff run
 * it. These are warnings, not refusals: the configuration is legitimate, it
 * simply behaves in a way the builder screen must say out loud (the same
 * predicate serves the API response and the screen, so they cannot disagree).
 *
 * MEASURED (P2 adversarial probe): a per-shift template with
 * target_kind='none' collapses its slot key to (checklist, date, shift), so
 * exactly ONE person in the restaurant can file that check per shift, and the
 * second person is refused by a record that may not even be theirs to open.
 * That is correct for "one round for the whole restaurant" and wrong for
 * "everyone does this" — only the owner knows which he meant, so it is said,
 * not decided.
 */
export function fssaiConfigWarnings(t: {
  target_kind?: string | null;
  frequency?: string | null;
  department_id?: string | null;
  requires_verification?: number | boolean | null;
}): string[] {
  const out: string[] = [];
  const kind = String(t.target_kind || 'none');
  const freq = String(t.frequency || '');
  if (kind === 'none' && (freq === 'per_shift' || freq === 'hourly' || freq === 'twice_daily' || freq === 'daily')) {
    out.push(
      'This checklist is not run against anything in particular, so ONE person files it for the whole restaurant each time it is due — ' +
      'whoever starts it first. If every member of staff (or every cold room) should file their own, choose what the check is run against: a person, a piece of equipment or an area.',
    );
  }
  if (kind === 'none' && !String(t.department_id || '')) {
    out.push(
      'No department is set, so this checklist and its records belong to the whole restaurant: any signed-in member of staff can see them.',
    );
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 9. THE PASS / FAIL EVALUATOR
 * ------------------------------------------------------------------ */

/**
 * The rule ACTUALLY APPLIED to one answer. These are the values the runner
 * freezes onto fssai_responses (min_used / max_used / expected_used), which
 * is what makes a submitted record self-describing and independent of the
 * live question row.
 */
export interface FssaiQuestionRule {
  qtype: string;
  is_required?: number | boolean;
  allow_na?: number | boolean;
  min_value?: number | null;
  max_value?: number | null;
  expected_value?: string | null;
  /** the answers on the list — an answer that is not one of them is a fail */
  options?: string[];
  fail_options?: string[];
  photo_rule?: string;
  note_rule?: string;
}

export interface FssaiAnswerInput {
  /** text | chosen option label | signature actor email */
  value_text?: string | null;
  /** numeric | temperature. null = NOT ANSWERED — never 0 (RECON §6.4). */
  value_num?: number | null;
  /** yes_no | pass_fail. null = not answered. */
  value_bool?: boolean | null;
  is_na?: boolean;
  /** the words typed alongside the answer (fssai_responses.note) */
  note?: string | null;
  /** how many evidence rows the runner attached to this answer */
  evidence_count?: number;
}

export interface FssaiVerdict {
  answered: boolean;
  is_fail: boolean;
  /** why it failed, for the runner's inline hint. '' when it passed. */
  reason: string;
  /** the question demands a photograph that is not attached yet */
  needs_photo?: boolean;
  /** the question demands a written note that has not been typed yet */
  needs_note?: boolean;
}

/**
 * Evaluate one answer against its question. PURE: the caller freezes the
 * result onto fssai_responses.is_fail and NEVER recomputes it on read — the
 * pass rule may legitimately change with a later template version, and
 * recomputing would rewrite history (risk R3).
 *
 * A blank numeric or temperature answer is NOT zero. Number('') === 0 stored
 * 793 phantom "we have zero" counts in the closing-stock module; here an
 * unanswered reading is value_num === null and `answered` is false.
 */
export function evaluateFssaiAnswer(q: FssaiQuestionRule, a: FssaiAnswerInput): FssaiVerdict {
  const meta = qtypeMeta(q.qtype);
  if (!meta) {
    // R1: an unknown type must fail loudly, never silently pass.
    return { answered: false, is_fail: true, reason: `Unknown question type "${q.qtype}".` };
  }
  const required = q.is_required === undefined ? true : !!Number(q.is_required);

  if (a.is_na) {
    const allowNa = q.allow_na === undefined ? true : !!Number(q.allow_na);
    // A question that does not apply needs no photograph and no note.
    return allowNa
      ? { answered: true, is_fail: false, reason: '' }
      : { answered: true, is_fail: true, reason: 'This question cannot be marked not-applicable.' };
  }

  return withFssaiEvidenceRules(q, a, meta.key, baseVerdict(q, a, meta.key, required));
}

function baseVerdict(
  q: FssaiQuestionRule,
  a: FssaiAnswerInput,
  key: FssaiQType,
  required: boolean,
): FssaiVerdict {
  switch (key) {
    case 'yes_no':
    case 'pass_fail': {
      // The answer may arrive as the BOOLEAN or as the WORD. Both must reach
      // the same verdict (see FSSAI_YES_WORDS — the measured defect where
      // value_text:'yes' was frozen as a compliance failure).
      let b: boolean | null = a.value_bool === null || a.value_bool === undefined ? null : !!a.value_bool;
      if (b === null) {
        b = fssaiBoolFromText(a.value_text);
        if (b === null) {
          const raw = String(a.value_text ?? '').trim();
          if (raw) {
            // Never guessed at, and never silently a fail: name it.
            return {
              answered: false,
              is_fail: required,
              reason: `"${raw}" is not an answer to this question — answer ${fssaiBoolWordsFor(key)}.`,
            };
          }
          return { answered: false, is_fail: required, reason: required ? 'Not answered.' : '' };
        }
      }
      const expectedRaw = String(q.expected_value || '').trim().toLowerCase();
      const expectTrue = expectedRaw === '' ? true : expectedRaw === 'yes' || expectedRaw === 'pass';
      const ok = b === expectTrue;
      return { answered: true, is_fail: !ok, reason: ok ? '' : `Expected ${expectedRaw || (key === 'yes_no' ? 'yes' : 'pass')}.` };
    }
    case 'numeric':
    case 'temperature': {
      const v = a.value_num;
      if (v === null || v === undefined || !Number.isFinite(v)) {
        return { answered: false, is_fail: required, reason: required ? 'No reading recorded.' : '' };
      }
      const mn = q.min_value ?? null;
      const mx = q.max_value ?? null;
      if (mn !== null && v < mn) return { answered: true, is_fail: true, reason: `Below the acceptable minimum of ${mn}.` };
      if (mx !== null && v > mx) return { answered: true, is_fail: true, reason: `Above the acceptable maximum of ${mx}.` };
      return { answered: true, is_fail: false, reason: '' };
    }
    case 'multiple_choice': {
      const chosen = String(a.value_text || '').trim();
      if (!chosen) return { answered: false, is_fail: required, reason: required ? 'Not answered.' : '' };
      // MEMBERSHIP LIVES IN THE PREDICATE, not only in the route. An answer
      // nobody offered used to come back is_fail=false here, so any second
      // caller (a bulk answer, an import, a seed backfill) got a silent pass
      // for a label that is not on the list.
      const options = Array.isArray(q.options) ? q.options.map((o) => String(o)) : [];
      if (options.length && !options.includes(chosen)) {
        return { answered: true, is_fail: true, reason: `"${chosen}" is not one of the answers on the list.` };
      }
      const fails = Array.isArray(q.fail_options) ? q.fail_options.map((o) => String(o)) : [];
      const bad = fails.includes(chosen);
      return { answered: true, is_fail: bad, reason: bad ? `"${chosen}" is recorded as a fail.` : '' };
    }
    case 'text':
    case 'signature': {
      const t = String(a.value_text || '').trim();
      if (!t) return { answered: false, is_fail: required, reason: required ? 'Not answered.' : '' };
      // Words never fail on their own — a text answer is a record, not a test.
      return { answered: true, is_fail: false, reason: '' };
    }
    case 'photo': {
      const n = a.evidence_count ?? 0;
      if (n <= 0) return { answered: false, is_fail: required, reason: required ? 'No photograph attached.' : '' };
      return { answered: true, is_fail: false, reason: '' };
    }
  }
}

/**
 * THE ADMIN'S "REQUIRED EVIDENCE" RULE, ACTUALLY APPLIED.
 *
 * MEASURED DEFECT (P2 adversarial probe): photo_rule and note_rule — one of the
 * eight things the brief says an admin must be able to set — were stored and
 * validated but never read by anything. A question marked "Photo: Always" plus
 * "Note: Always" was answered, submitted and PASSED with neither, so the tick
 * box was decoration.
 *
 * What the rule now does: an answer that still owes a photograph or a note is
 * NOT COMPLETE (`answered: false`), which is what the submit gate counts — so
 * the run cannot be submitted until the evidence is there, and the person
 * filling it in is told which answer is waiting for what. It is deliberately
 * NOT turned into a fail: the check may be perfectly in order, the paperwork is
 * simply unfinished, and recording a passing fridge as a failure would be a
 * worse lie than the one this fixes. A verdict that ALREADY failed keeps its
 * failure.
 *
 * WHY THIS IS CHECKED AND NOT REFUSED AT ENTRY: fssai_evidence.response_id
 * points at the answer row, so the answer must exist BEFORE a photograph can be
 * attached to it. Refusing the answer would make a photo question impossible to
 * ever answer.
 *
 * PHASE BOUNDARY, STATED PLAINLY: P2 ships no evidence-write route (that is
 * P3's), so today "Photo: Always" can only be satisfied by P3's runner. "Note:
 * Always" is satisfiable now — the note travels with the answer.
 */
function withFssaiEvidenceRules(
  q: FssaiQuestionRule,
  a: FssaiAnswerInput,
  key: FssaiQType,
  v: FssaiVerdict,
): FssaiVerdict {
  if (!v.answered) return v;                       // nothing to demand evidence for yet
  const photoRule = isEvidenceRule(q.photo_rule) ? q.photo_rule : 'never';
  const noteRule = isEvidenceRule(q.note_rule) ? q.note_rule : 'never';
  const photos = Number(a.evidence_count ?? 0);
  const note = String(a.note ?? '').trim();
  // On a `photo` question the photograph IS the answer and was already tested.
  const needPhoto = key !== 'photo' && (photoRule === 'always' || (photoRule === 'on_fail' && v.is_fail));
  const needNote = noteRule === 'always' || (noteRule === 'on_fail' && v.is_fail);
  const missingPhoto = needPhoto && photos <= 0;
  const missingNote = needNote && !note;
  if (!missingPhoto && !missingNote) return v;

  const wants: string[] = [];
  if (missingPhoto) wants.push('a photograph');
  if (missingNote) wants.push('a note saying what was seen');
  return {
    answered: false,
    is_fail: v.is_fail,
    reason: `${v.reason ? `${v.reason} ` : ''}This answer still needs ${wants.join(' and ')}.`,
    ...(missingPhoto ? { needs_photo: true } : {}),
    ...(missingNote ? { needs_note: true } : {}),
  };
}

/**
 * IS THERE AN ANSWER IN THIS BOX? — ONE predicate, type-aware, shared.
 *
 * MEASURED DEFECT (P2 adversarial probe): the run route had its own
 * isAnswered() that counted any non-empty value_text, while the evaluator could
 * call the same row unanswered — so a question the evaluator considered blank
 * slipped through the "N questions still need an answer" gate. Both now read
 * this.
 *
 * It answers only "is a value present", which is why it takes the FROZEN
 * response row: the qtype on the row is the type the answer was given under,
 * even if the live question has been changed since.
 */
export function fssaiResponseAnswered(
  r: { qtype?: string | null; value_text?: unknown; value_num?: unknown; value_bool?: unknown; is_na?: unknown },
  evidenceCount = 0,
): boolean {
  if (Number(r.is_na)) return true;
  const meta = qtypeMeta(r.qtype);
  const text = String(r.value_text ?? '').trim();
  if (!meta) {
    // Unknown type: any value at all counts as "something was written down".
    // The verdict is still a loud failure (evaluateFssaiAnswer, R1).
    return text !== '' || r.value_num !== null && r.value_num !== undefined
      || r.value_bool !== null && r.value_bool !== undefined;
  }
  if (meta.value === 'bool') {
    if (r.value_bool !== null && r.value_bool !== undefined && String(r.value_bool) !== '') return true;
    return fssaiBoolFromText(text) !== null;
  }
  if (meta.value === 'num') {
    return r.value_num !== null && r.value_num !== undefined && Number.isFinite(Number(r.value_num));
  }
  if (meta.value === 'evidence') return Number(evidenceCount) > 0;
  return text !== '';
}

/** One frozen response row, as the summariser reads it. */
export interface FssaiResponseFacts { is_fail: number | boolean; is_na: number | boolean; answered: boolean }

export interface FssaiRunSummary {
  total_count: number;
  answered_count: number;
  fail_count: number;
  na_count: number;
  pass_pct: number;
  outcome: 'pass' | 'fail';
}

/**
 * The run's frozen counters. Written once at submit onto fssai_runs and never
 * recomputed on read.
 *
 * pass_pct is measured over the questions that were actually judged — answered
 * and not marked not-applicable — because a checklist with three N/A questions
 * out of ten is not 70% compliant, it is 100% of what applied. A run with
 * nothing judgeable scores 0 and fails: an empty sheet is not a passed check.
 * criticalFailed short-circuits the threshold entirely (one critical failure
 * fails the whole run).
 */
export function summariseFssaiRun(
  rows: readonly FssaiResponseFacts[],
  passThresholdPct: number,
  criticalFailed = false,
): FssaiRunSummary {
  const total = rows.length;
  const na = rows.filter((r) => !!Number(r.is_na)).length;
  const answered = rows.filter((r) => r.answered).length;
  const fails = rows.filter((r) => !!Number(r.is_fail)).length;
  const judged = rows.filter((r) => r.answered && !Number(r.is_na)).length;
  const passed = judged - rows.filter((r) => r.answered && !Number(r.is_na) && Number(r.is_fail)).length;
  const pct = judged > 0 ? Math.round((passed / judged) * 1000) / 10 : 0;
  const threshold = Number.isFinite(passThresholdPct) ? passThresholdPct : 100;
  const outcome: 'pass' | 'fail' = criticalFailed || judged === 0 || pct < threshold ? 'fail' : 'pass';
  return {
    total_count: total,
    answered_count: answered,
    fail_count: fails,
    na_count: na,
    pass_pct: pct,
    outcome,
  };
}

/* ------------------------------------------------------------------ *
 * 10. EVIDENCE AND THE SIGNATURE — the numbers the phone and the server
 *     must agree on (P3)
 * ------------------------------------------------------------------ */

/**
 * WHY THESE NUMBERS ARE HERE AND NOT IN THE ROUTE.
 *
 * The phone shrinks the photograph; the server refuses one that is still too
 * big. If those two limits disagree, a member of staff standing in a cold room
 * gets "Payload too large" after a successful-looking compression and has no
 * idea what to do. So the cap lives in ONE module both halves import.
 *
 * THE REAL CONSTRAINT IS NOT THIS CAP — IT IS nginx (HARD RULE 14). A direct
 * probe of production measured `client_max_body_size` accepting about **1 MB**,
 * not the 25M `deploy/nginx.conf` claims: 900 KB reached the app and 1,100 KB
 * returned 413 before any route ran. A modern phone camera produces 3-8 MB, so
 * an uncompressed capture can never reach this module — the resize is not an
 * optimisation, it is the only way the feature works at all.
 *
 * THE BUDGET, deliberately conservative against that 1 MB wall:
 *   · FSSAI_PHOTO_TARGET_BYTES  250 KB — what the client aims for (the figure
 *     ImageUpload has used since the Task module shipped; ~1200 px longest edge
 *     at JPEG q0.7).
 *   · FSSAI_PHOTO_MAX_BYTES     400 KB — what the server will accept. Higher
 *     than the target so a stubborn photograph is not lost, and low enough that
 *     the base64 request body (~4/3 of this, ~533 KB, plus JSON) is barely half
 *     of nginx's real limit. ONE photograph per request, always.
 *   · the per-answer and per-run counts bound the rate: photographs live in-row
 *     as TEXT, so 4 a day is ~365 MB a year in a database file that is 15 MB
 *     today. A cap the owner can see beats silent growth he cannot.
 *
 * §7 Q13 IS NO LONGER UNDECIDED — the owner ruled on 2026-09-25: "in-row,
 * 12-month retention window." The caps above bound the RATE; the window below
 * bounds the TOTAL, so the file reaches a steady state instead of growing
 * forever. See FSSAI_PHOTO_RETENTION_MONTHS.
 */
export const FSSAI_PHOTO_TARGET_BYTES = 250 * 1024;
export const FSSAI_PHOTO_MAX_BYTES = 400 * 1024;
export const FSSAI_PHOTO_MAX_EDGE_PX = 1200;
export const FSSAI_EVIDENCE_MAX_PER_ANSWER = 4;
export const FSSAI_EVIDENCE_MAX_PER_RUN = 24;

/**
 * HOW LONG A PHOTOGRAPH'S IMAGE IS KEPT — owner §7 Q13, ruled 2026-09-25.
 *
 * "In-row, 12-month retention window. Keep photos full-size for 12 months, then
 * drop the IMAGE but KEEP the record, the fact a photo existed, and its digest.
 * Never delete the record."
 *
 * So this is a window on the IMAGE BYTES ONLY. After it passes, fssai_evidence
 * still holds the row: which answer it belonged to, who attached it, when, the
 * filename, the mime, the original size, and the sha256 of the image that was
 * there. An inspector a year later can still see that a photograph was taken
 * and what it hashed to — they simply cannot look at it any more.
 *
 * ⚠️ THE ROW IS NEVER DELETED, AND THAT IS NOT AN IMPLEMENTATION DETAIL. A
 * deleted row would change the answer to "was there a photograph?" from "yes,
 * and here is its fingerprint" to "no" — which on a food-safety record is the
 * difference between evidence that aged out and evidence that never existed.
 *
 * Steady state at the caps above: 24 photographs per run at 400 KB is at most
 * ~9.4 MB per run of image, and only the last 12 months of runs hold any image
 * at all. Nothing is dropped until the sweep runs — see
 * sweepFssaiPhotoRetention in src/lib/fssai-retention.ts, WHICH IS NOT YET
 * ARMED. Until somebody calls it, this constant describes an intention and the
 * file keeps growing; the sweep's own comment says so plainly rather than
 * letting a reader assume a cron exists.
 */
export const FSSAI_PHOTO_RETENTION_MONTHS = 12;

/** The only image types a data: URI may carry into fssai_evidence. */
export const FSSAI_PHOTO_MIMES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];

/** What a row of fssai_evidence can be. 'signature' is written by the sign act. */
export type FssaiEvidenceKind = 'photo' | 'file' | 'signature';

/** Human bytes for a screen: 412 KB, 1.8 MB. */
export function fssaiBytesLabel(n: number | null | undefined): string {
  const b = Number(n);
  if (!Number.isFinite(b) || b <= 0) return '0 KB';
  if (b < 1024) return `${Math.round(b)} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Decoded byte length of a base64 data: URI payload, without decoding it.
 * base64 is 4 characters per 3 bytes, minus the '=' padding. Same arithmetic
 * ImageUpload uses client-side, so the two halves measure the same thing.
 */
export function fssaiDataUriBytes(uri: string | null | undefined): number {
  const s = String(uri || '');
  const comma = s.indexOf(',');
  const b64 = comma >= 0 ? s.slice(comma + 1) : s;
  if (!b64) return 0;
  let pad = 0;
  if (b64.endsWith('==')) pad = 2;
  else if (b64.endsWith('=')) pad = 1;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

/**
 * Split a data: URI into its mime and its base64 payload, or say why not.
 *
 * STRICT ON PURPOSE. The stored string is handed straight back to a browser as
 * an <img src>, so `data:text/html;base64,…` in this column would be a stored
 * XSS with a food-safety record for a delivery vehicle. Only base64 images pass,
 * and the charset is checked rather than trusted.
 */
export function parseFssaiDataUri(
  uri: string | null | undefined,
):
  | { ok: true; mime: string; b64: string; bytes: number }
  /**
   * `code` exists so the ROUTE can pick the right HTTP status (413 for a
   * photograph that is merely too big, 400 for one that is not an image at all)
   * without matching on the wording of the sentence — which would break the
   * moment somebody improved the copy.
   */
  | { ok: false; error: string; code: 'missing' | 'not_a_data_uri' | 'bad_mime' | 'truncated' | 'empty' | 'too_big' } {
  const s = String(uri || '').trim();
  if (!s) return { ok: false, error: 'No photograph was sent.', code: 'missing' };
  const m = s.match(/^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!m) return { ok: false, error: 'That is not a photograph this app can store. Take the picture again from the camera button.', code: 'not_a_data_uri' };
  const mime = m[1].toLowerCase();
  const b64 = m[2].replace(/\s+/g, '');
  if (!FSSAI_PHOTO_MIMES.includes(mime)) {
    return { ok: false, error: `${mime} cannot be attached to a food-safety record. Use a JPG or PNG photograph.`, code: 'bad_mime' };
  }
  if (b64.length % 4 !== 0) return { ok: false, error: 'That photograph did not arrive whole. Try again.', code: 'truncated' };
  const bytes = fssaiDataUriBytes(s);
  if (bytes <= 0) return { ok: false, error: 'That photograph is empty.', code: 'empty' };
  if (bytes > FSSAI_PHOTO_MAX_BYTES) {
    return {
      ok: false,
      error: `That photograph is ${fssaiBytesLabel(bytes)}. A photograph attached to a record must be under ${fssaiBytesLabel(FSSAI_PHOTO_MAX_BYTES)} — the camera button shrinks it for you, so take it again from there rather than attaching the original file.`,
      code: 'too_big',
    };
  }
  return { ok: true, mime, b64, bytes };
}

/* ------------------------------------------------------------------ *
 * 11. WHAT A SIGNATURE IS — AND WHAT IT IS NOT
 * ------------------------------------------------------------------ */

/**
 * §7 Q6 (PROVISIONAL DEFAULT, the owner has not ruled): a signature is the
 * authenticated user plus a timestamp. No drawing, no biometrics.
 *
 * P3 makes that act EXPLICIT and binds it to the sheet. Submitting no longer
 * stamps a signature as a side effect — the person who did the work presses
 * "Sign", and the server records:
 *   · who   — the signed-in user, from the session cookie, never from the body;
 *   · when  — a server clock reading, never the phone's;
 *   · what  — a digest of every answer and every photograph AS THEY STOOD at
 *             that moment;
 *   · a statement in words, stored with the row.
 * If an answer changes afterwards the digest no longer matches, and submit
 * refuses until it is signed again. That is the whole non-repudiation claim.
 *
 * WHAT IT DOES NOT PROVE, stated so nobody claims more of it in an inspection:
 *   1. It does not prove WHO HELD THE PHONE. It proves which account was signed
 *      in. A shared login is a shared signature, and this app has no per-act
 *      re-authentication.
 *   2. It is not a cryptographic signature. The digest is a plain SHA-256 kept
 *      in the same database as the data; anyone with write access to the file
 *      can recompute both. It detects an edit made THROUGH THE APP — which is
 *      the case it is for — not tampering with the database.
 *   3. It is not a handwritten mark and is not an e-signature under the IT Act.
 *   4. It says the sheet was attested, not that the reading was true.
 */
export const FSSAI_SIGNATURE_STATEMENT =
  'I recorded these answers myself and they are true to the best of my knowledge.';

export function fssaiSignatureStatement(custom?: string | null): string {
  const s = String(custom || '').trim();
  return s || FSSAI_SIGNATURE_STATEMENT;
}

/**
 * HOW THE ATTESTATION WAS OBTAINED. Recorded, rather than assumed, because the
 * three are not equally strong and a record must never claim a stronger one.
 *
 *   'explicit'   — the person pressed Sign (POST /api/fssai/sign), then submitted
 *                  as a separate act. If an answer changed in between, submit
 *                  refused until they signed again, having seen what changed.
 *   'on_submit'  — the person pressed one button labelled "Sign and submit", with
 *                  the statement on screen above it. One tap, one act, no second
 *                  look at the sheet.
 *   'not_asked'  — NOBODY PRESSED ANYTHING. The client submitted with no `sign`
 *                  flag, the strict gate (FSSAI_REQUIRE_EXPLICIT_SIGNATURE) was
 *                  off, so the server attested on its own. It is the weakest of
 *                  the three and the only one where there was no act to
 *                  repudiate, so it must never be dressed up as either of the
 *                  others.
 *
 * ⚠️ THE THIRD VALUE IS WHY THIS IS AN ENUM AND NOT A BOOLEAN — owner Q17.
 * Until 2026-09-25 the submit route hardcoded `'on_submit'` for every signature
 * it wrote (`runs/route.ts:749`), so the un-asked case above was recorded, and
 * PRINTED on /fssai/verification, as "signed by pressing “Sign and submit”" —
 * a sentence describing a button nobody had pressed. The one-tap and two-step
 * paths were already labelled correctly; only this third state was not, because
 * the enum had nowhere to put it. Measured before the fix: 0 signatures existed
 * on this branch, so nothing had to be re-labelled.
 *
 * All three are the authenticated user plus a server timestamp plus the digest
 * (owner H-1: the signature IS the authenticated session). The difference is
 * only what the person did, and the verification screen says which in words so
 * nobody has to infer it.
 */
export type FssaiSignatureMode = 'explicit' | 'on_submit' | 'not_asked';

/**
 * READ A STORED MODE BACK WITHOUT EVER UPGRADING THE CLAIM.
 *
 * The mode is not a column — it lives inside the JSON of an append-only audit
 * row (fssai-server.ts, FSSAI_SIGN_ACTION), so what comes back is `unknown` and
 * has to be narrowed. The narrowing has one rule: WHEN IN DOUBT, THE WEAKER
 * CLAIM. Both defaults below follow from it:
 *
 *   · ABSENT → 'explicit'. A signature written before the mode existed can only
 *     have come from the sign route, which was the only path then. Reporting it
 *     as anything else would invent a fact about a real person's act.
 *   · PRESENT BUT UNRECOGNISED → 'not_asked'. A value from a newer build this
 *     one does not understand. Collapsing it to 'explicit' — which is what the
 *     old two-way narrowing did to EVERYTHING that was not 'on_submit' — would
 *     silently promote an unknown act to the strongest of the three.
 */
export function fssaiSignatureModeFrom(v: unknown): FssaiSignatureMode {
  const s = String(v ?? '').trim();
  if (s === 'explicit' || s === 'on_submit' || s === 'not_asked') return s;
  return s === '' ? 'explicit' : 'not_asked';
}

/** How a record should describe the way it was signed, in plain words. */
export function fssaiSignatureModeLabel(mode: FssaiSignatureMode | null | undefined): string {
  switch (fssaiSignatureModeFrom(mode)) {
    case 'on_submit': return 'signed by pressing “Sign and submit”';
    case 'not_asked': return 'attested on submission — nobody was asked to sign';
    default: return 'signed as a separate step, then submitted';
  }
}

/** The things a screen shows about a signature, in one shape. */
export interface FssaiSignature {
  signed_by: string;
  signed_name: string;
  signed_at: string;
  statement: string;
  sheet_digest: string;
  answers: number;
  photos: number;
  mode?: FssaiSignatureMode;
}

/**
 * MUST A CHECK BE SIGNED AS A SEPARATE ACT BEFORE IT MAY BE SUBMITTED?
 *
 * FALSE today, deliberately, and this is the reasoning rather than a shrug.
 *
 * The owner's §22 lists Sign and Submit as separate steps, and the strict reading
 * of that is: refuse a submit that was never signed. The strict gate is BUILT and
 * one line away — flip this to true and submit answers `code:'signature_required'`
 * with the endpoint to call.
 *
 * Instead of refusing, submit SIGNS and records `mode:'on_submit'`, and every
 * screen that shows a signature shows which kind it was. Nothing is invented
 * silently: the digest, the statement and the audit row are written either way,
 * which is what P2a never did. What is gone for good is the server signing when
 * nobody asked at all.
 *
 * ⚠️ THE ORIGINAL REASON FOR LEAVING IT OFF HAS EXPIRED — read this before the
 * next change. It was off because P3 Lane A's runner posted `{action:'submit'}`
 * with no `sign` flag, so the strict gate would have met the owner with an error
 * about the button he had just pressed. **Lane A has since conformed**
 * (`src/app/fssai/checklists/run/[id]/page.tsx`): it sends
 * `sign: needsSignature ? true : undefined`, it has a two-step path that POSTs
 * /api/fssai/sign, and it handles both `signature_required` and `signature_stale`
 * by putting the server's own sentence and statement on screen with a button that
 * signs and submits again. So the only caller is ready for the gate.
 *
 * ══ THE OWNER RULED ON THIS — Q17, 2026-09-25. DO NOT RE-LITIGATE. ══════════
 *
 *   "Fix the mode label NOW; strict refusal AFTER one real run on the phone."
 *
 * So the LABEL half is done (see FssaiSignatureMode above: the un-asked case is
 * now recorded and printed as 'not_asked', not as a button press), and this flag
 * stays FALSE on purpose, with his reason written down rather than inferred:
 *
 *   THE SIGNATURE PATH HAS NEVER BEEN THROUGH A REAL BROWSER. Every proof of the
 *   ON position was taken by HTTP against the route. The runner's sign UI is a
 *   static audit only — no browser has hydrated it. Turning the refusal on means
 *   that if the client's sign path has so much as a hydration bug, EVERY submit
 *   is blocked, for every member of staff, in the middle of service, with no way
 *   round it. An honest label costs nothing if it is wrong; a hard refusal on an
 *   unexercised path costs a shift.
 *
 * ⚠️ FLIPPING IT IS A FIVE-SECOND CHANGE AND NOTHING ELSE HAS TO MOVE. Change
 * `false` to `true` on the line below. Then:
 *   · an unsigned submit answers `code:'signature_required'` (runs/route.ts:752);
 *   · an answer changed after signing answers `code:'signature_stale'` (:766);
 *   · `{sign:true}` submits 200 as it does today;
 *   · the 'not_asked' mode becomes UNREACHABLE — `signNow === askedToSign` — so
 *     no new record can be written in the weakest kind at all.
 * The runner already handles both refusal codes (`run/[id]/page.tsx:593-599`),
 * and both positions were measured on an isolated instance before it was torn
 * down. Flip it once somebody has watched a real phone sign and submit once.
 */
export const FSSAI_REQUIRE_EXPLICIT_SIGNATURE = false;

/* ------------------------------------------------------------------ *
 * 12. VERIFICATION — who may, and what it may touch
 * ------------------------------------------------------------------ */

export type FssaiApprovalDecision = 'verified' | 'rejected';

/**
 * THE ONE RULE THAT MAKES A REGISTER A REGISTER: verifying a record may not
 * change what it says.
 *
 * This is the list of columns the verification route is allowed to write, and it
 * is exported so an assertion in a test and the UPDATE in the route read the
 * same line. Nothing here touches fssai_responses, so no verifier can edit an
 * answer — there is no route that would let them, and that is checked by a real
 * request in the P3 proofs, not by the absence of a button.
 */
export const FSSAI_VERIFY_WRITABLE_RUN_COLUMNS: readonly string[] = ['status', 'updated_at'];

/** Why this person cannot verify this record, in words, or '' if they can. */
export function fssaiVerifyRefusal(
  me: FssaiActor | null | undefined,
  run: { status?: string | null; recorded_by?: string | null; recorded_name?: string | null } | null,
): string {
  if (!me) return 'Sign in required';
  if (!run) return 'That check no longer exists.';
  const status = String(run.status || '');
  if (status === 'in_progress') return 'That check has not been submitted yet, so there is nothing to verify.';
  if (status === 'verified') return 'That check has already been verified.';
  if (status === 'rejected') return 'That check was sent back, so it has to be recorded again.';
  if (status === 'void') return 'That check was voided, so it never happened.';
  if (status !== 'submitted') return `A check with the status "${status}" cannot be verified.`;
  const mine = String(me.email || '').trim().toLowerCase();
  const ran = String(run.recorded_by || '').trim().toLowerCase();
  if (mine && ran && mine === ran) {
    // §7 Q3 provisional default. The point of a second pair of eyes is that they
    // are someone else's.
    return 'You recorded this check yourself, so somebody else has to verify it.';
  }
  if (!canVerifyFssai(me, run.recorded_by)) return 'Only a manager or an administrator can verify a recorded check.';
  return '';
}

/* ------------------------------------------------------------------ *
 * 12b. CORRECTIVE ACTIONS — the owner's §7 Q14 ruling, in vocabulary
 * ------------------------------------------------------------------ */

/**
 * WHAT Q14 ASKED AND WHAT THE OWNER ANSWERED.
 *
 * A cold room reads 9 °C at closing. The record is submitted and it FAILS. The
 * engineer mends it. The 11 pm re-check is refused — the slot is closed by the
 * failed record — so the only exit in the build was a manager VOIDING a true
 * observation to make room for a better number, and the file then read
 * "voided fail + fresh pass" instead of the true story.
 *
 * THE RULING: **corrective action against the failed record.** In his words:
 *
 *   "The failure STANDS. The fix and its verification hang off it via
 *    fssai_corrective_actions. NO change to the slot rule, no 'rejected'
 *    status, no voiding a true observation."
 *
 * Everything below follows from that one sentence, and so does one thing that
 * is NOT below: there is no vocabulary here for un-failing anything. A
 * corrective action cannot alter a run's status, its outcome, its pass_pct or
 * any answer on it, and the route that owns these rows holds no write against
 * fssai_runs or fssai_responses at all. A verified corrective action means the
 * fix was done and checked — never that the check passed after all.
 */
export type FssaiCaStatus = 'open' | 'in_progress' | 'done' | 'verified' | 'cancelled';

/**
 * The five states, in the order an action moves through them.
 *
 * 'done' vs 'verified' is the pair that matters and they are deliberately not
 * one state: 'done' is the person who did the work saying what they did, and
 * 'verified' is somebody else agreeing it was enough. An FSSAI file where those
 * are the same act, by the same person, proves nothing — which is exactly why
 * the run's own verification has the §7 Q3 rule, and why this one does too.
 *
 * 'cancelled' is the ONLY way out that is not a fix, it needs a written reason,
 * and it does not remove the row: the failed check keeps pointing at it.
 * (The schema comment also lists 'void' from the P1 spine; nothing writes it —
 * 'cancelled' is the one closing-without-a-fix state — and a legacy row
 * carrying it still renders, as "Cancelled", through fssaiCaStatusMeta.)
 */
export const FSSAI_CA_STATUSES: readonly FssaiStatusMeta[] = [
  { key: 'open', label: 'Open', color: 'bg-red-100 text-red-700 border-red-200' },
  { key: 'in_progress', label: 'Being fixed', color: 'bg-amber-100 text-amber-800 border-amber-200' },
  { key: 'done', label: 'Fixed — to check', color: 'bg-blue-100 text-blue-700 border-blue-200' },
  { key: 'verified', label: 'Fixed and checked', color: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  { key: 'cancelled', label: 'Cancelled', color: 'bg-slate-100 text-slate-600 border-slate-200' },
] as const;

export function fssaiCaStatusMeta(key: string | null | undefined): FssaiStatusMeta {
  const k = String(key || '');
  // 'void' is the P1 spine's synonym for a closed-without-a-fix row. Nothing
  // writes it; a row that already carries it must still render as something.
  if (k === 'void') return { key: 'void', label: 'Cancelled', color: 'bg-slate-100 text-slate-600 border-slate-200' };
  return FSSAI_CA_STATUSES.find((s) => s.key === k)
    ?? { key: k, label: k || 'Unknown', color: 'bg-slate-100 text-slate-600 border-slate-200' };
}

export function isFssaiCaStatus(v: string | null | undefined): v is FssaiCaStatus {
  return FSSAI_CA_STATUSES.some((s) => s.key === String(v || ''));
}

/** An action that is finished one way or the other, and takes no more work. */
export function fssaiCaIsClosed(status: string | null | undefined): boolean {
  const s = String(status || '');
  return s === 'verified' || s === 'cancelled' || s === 'void';
}

/**
 * HOW SERIOUS. The admin sets it per question (`fssai_questions.ca_severity`),
 * and the vocabulary is the Task Manager's TASK_PRIORITIES verbatim — low /
 * medium / high / urgent — because the schema comment says so and because the
 * fix is eventually meant to become a task in the list staff already use. A
 * second private word-list for the same idea is how two screens end up
 * disagreeing about the same action.
 */
export type FssaiCaSeverity = 'low' | 'medium' | 'high' | 'urgent';

export const FSSAI_CA_SEVERITIES: readonly FssaiStatusMeta[] = [
  { key: 'low', label: 'Low', color: 'bg-slate-100 text-slate-600 border-slate-200' },
  { key: 'medium', label: 'Medium', color: 'bg-blue-100 text-blue-700 border-blue-200' },
  { key: 'high', label: 'High', color: 'bg-orange-100 text-orange-700 border-orange-200' },
  { key: 'urgent', label: 'Urgent', color: 'bg-red-100 text-red-700 border-red-200' },
] as const;

export function fssaiCaSeverityMeta(key: string | null | undefined): FssaiStatusMeta {
  return FSSAI_CA_SEVERITIES.find((s) => s.key === String(key || ''))
    ?? { key: 'medium', label: 'Medium', color: 'bg-blue-100 text-blue-700 border-blue-200' };
}

export function isFssaiCaSeverity(v: string | null | undefined): v is FssaiCaSeverity {
  return FSSAI_CA_SEVERITIES.some((s) => s.key === String(v || ''));
}

/**
 * HOW LONG AN ACTION GETS BEFORE IT IS LATE — PROVISIONAL DEFAULT, the owner
 * has not ruled. It is a default and not a rule: a manager can set any due date
 * on the action, and the number below is only what it starts with, so nobody
 * has to type a date for the common case. Change these four numbers to change
 * the defaults; no other code reads them.
 */
export const FSSAI_CA_DUE_DAYS: Readonly<Record<FssaiCaSeverity, number>> = {
  urgent: 0,   // the same day — an urgent food-safety failure is not a tomorrow job
  high: 1,
  medium: 3,
  low: 7,
};

/** YYYY-MM-DD n days after the given date. '' if the date is not a real one. */
export function addDaysISO(iso: string, days: number): string {
  if (!isISODate(iso) || !Number.isFinite(days)) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + Math.trunc(days)));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/** The date an action of this severity is due, counting from the business date. */
export function fssaiCaDueDate(severity: string | null | undefined, fromISO: string): string {
  const key = (isFssaiCaSeverity(severity) ? severity : 'medium') as FssaiCaSeverity;
  return addDaysISO(fromISO, FSSAI_CA_DUE_DAYS[key]);
}

/** The shape every screen and route reads an action through. */
export interface FssaiCaActor {
  status?: string | null;
  owner_email?: string | null;
  completed_by?: string | null;
  due_date?: string | null;
  run_recorded_by?: string | null;
}

/**
 * IS IT LATE? Only an action still needing work can be — a verified or
 * cancelled one is finished, and calling a finished action "3 days overdue"
 * on a compliance screen is a lie that makes the whole list untrustworthy.
 */
export function fssaiCaIsOverdue(ca: FssaiCaActor | null | undefined, todayISO: string): boolean {
  if (!ca || fssaiCaIsClosed(ca.status)) return false;
  const due = String(ca.due_date || '');
  if (!isISODate(due) || !isISODate(todayISO)) return false;
  return daysBetweenISO(due, todayISO) > 0;
}

/**
 * MAY THIS PERSON RECORD WHAT WAS DONE? — '' if they may, the sentence to show
 * if they may not.
 *
 * PROVISIONAL DEFAULT (the owner has not ruled on this half): the assigned
 * owner, any management, or — while the action is still unassigned — anybody
 * who can see it. The last clause is deliberate: an unassigned action nobody is
 * allowed to touch is an action that never gets done, and the row records
 * `completed_by` whoever they were, so the file still names them. Assigning an
 * owner narrows it immediately.
 */
export function fssaiCaCompleteRefusal(
  me: FssaiActor | null | undefined,
  ca: FssaiCaActor | null,
): string {
  if (!me) return 'Sign in required';
  if (!ca) return 'That corrective action no longer exists.';
  const status = String(ca.status || '');
  if (status === 'verified') return 'That action has already been fixed and checked.';
  if (status === 'cancelled' || status === 'void') return 'That action was cancelled, so there is nothing to record against it.';
  if (status === 'done') {
    /* ONE-WAY UNTIL SOMEBODY SENDS IT BACK. A recorded fix is a statement on a
     * compliance record, not a draft, so it is not quietly editable by the
     * person who wrote it while a supervisor is reading it. If it was wrong or
     * not enough, a manager sends it back (`reopen`, with a written reason) and
     * BOTH the original attempt and the reason stay in the file — which is the
     * true story of the fault, and what a re-edit would have erased. */
    return 'The fix has already been written down and is waiting to be checked. A manager can send it back if it was not enough.';
  }
  const mine = String(me.email || '').trim().toLowerCase();
  const owner = String(ca.owner_email || '').trim().toLowerCase();
  const isMgmt = me.role === 'admin' || me.role === 'manager' || !!me.is_head_chef;
  if (isMgmt || !owner || (mine && mine === owner)) return '';
  return 'This action is assigned to somebody else. Ask them to record what they did, or ask a manager to reassign it.';
}

/**
 * MAY THIS PERSON CHECK THE FIX? — '' if they may, the sentence if they may not.
 *
 * THREE REFUSALS, AND EACH ONE IS THE POINT OF HAVING THE STATE AT ALL:
 *   1. Management only. Checking a food-safety fix is a supervisory act.
 *   2. NEVER the person who recorded the fix. Otherwise 'done' and 'verified'
 *      are one act wearing two names.
 *   3. NEVER the person who recorded the failed check. This is the assumption
 *      the module has been carrying in words since P1 ("the person who recorded
 *      a check may not be the person who verifies the fix") and it is enforced
 *      here rather than left as a note on a screen. It is REVERSIBLE — delete
 *      the third block below — but a food-safety record where the finder of the
 *      fault also signs off its repair is worth very little.
 */
export function fssaiCaVerifyRefusal(
  me: FssaiActor | null | undefined,
  ca: FssaiCaActor | null,
): string {
  if (!me) return 'Sign in required';
  if (!ca) return 'That corrective action no longer exists.';
  const status = String(ca.status || '');
  if (status === 'verified') return 'That action has already been checked.';
  if (status === 'cancelled' || status === 'void') return 'That action was cancelled, so there is nothing to check.';
  if (status !== 'done') {
    return 'Nobody has written down what was done yet, so there is nothing to check. The fix has to be recorded first.';
  }
  const isMgmt = me.role === 'admin' || me.role === 'manager' || !!me.is_head_chef;
  if (!isMgmt) return 'Only a manager or an administrator can check that a fix was enough.';
  const mine = String(me.email || '').trim().toLowerCase();
  const fixer = String(ca.completed_by || '').trim().toLowerCase();
  if (mine && fixer && mine === fixer) {
    return 'You recorded this fix yourself, so somebody else has to check it.';
  }
  const finder = String(ca.run_recorded_by || '').trim().toLowerCase();
  if (mine && finder && mine === finder) {
    return 'You recorded the check that failed, so somebody else has to check the fix.';
  }
  return '';
}

/**
 * ONE CORRECTIVE ACTION AS EVERY SCREEN READS IT.
 *
 * Declared here, in the module both the server and the screens import, and
 * `shapeFssaiCa` (fssai-server.ts) is typed as returning it — so the queue, the
 * record view and the route cannot drift into three shapes of the same row.
 */
export interface FssaiCaView {
  id: string;
  ca_number: string;
  source_kind: string;
  run_id: string;
  response_id: string;
  question_id: string;
  equipment_id: string;
  department_id: string;
  department_name: string;
  title: string;
  description: string;
  root_cause: string;
  severity: string;
  severity_label: string;
  status: string;
  status_label: string;
  owner_email: string;
  due_date: string;
  action_taken: string;
  completed_at: string;
  completed_by: string;
  verified_by: string;
  verified_at: string;
  verify_note: string;
  void_reason: string;
  voided_by: string;
  voided_at: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  is_overdue: boolean;
  /** The record it hangs off — null only for a source_kind that has no run. */
  run: {
    id: string;
    business_date: string;
    shift: string;
    target_label: string;
    status: string;
    outcome: string;
    recorded_by: string;
    recorded_name: string;
    template_name: string;
  } | null;
  /** The FROZEN answer that caused it, when the response row is still there. */
  answer: { prompt: string; text: string; uom: string; note: string } | null;
}

/** MAY THIS PERSON ASSIGN, REOPEN OR CANCEL AN ACTION? Management only. */
export function canManageFssaiCa(me: FssaiActor | null | undefined): boolean {
  if (!me) return false;
  return me.role === 'admin' || me.role === 'manager' || !!me.is_head_chef;
}

/**
 * AN ANSWER AS A PERSON READS IT, from the FROZEN response row and nothing else.
 *
 * Shared because a corrective action quotes the answer that caused it, and the
 * wording on the action must be the same wording the record shows — "Soiled" on
 * the sheet and "Soiled" in the action, never "Soiled" in one and "fail" in the
 * other. The order of the tests matters: `is_na` wins over everything (a
 * not-applicable answer has no value to print), and the boolean is read before
 * the number because a Yes/No answer carries 1/0 in value_bool, which would
 * otherwise print as "1".
 */
export function fssaiAnswerInWords(r: {
  is_na?: unknown; value_bool?: unknown; value_num?: unknown; value_text?: unknown;
} | null | undefined): string {
  if (!r) return '—';
  if (Number(r.is_na)) return 'Not applicable';
  if (r.value_bool !== null && r.value_bool !== undefined && String(r.value_bool) !== '') {
    return Number(r.value_bool) ? 'Yes' : 'No';
  }
  if (r.value_num !== null && r.value_num !== undefined && String(r.value_num) !== '') {
    return String(r.value_num);
  }
  if (r.value_text) return String(r.value_text);
  return '—';
}

/* ------------------------------------------------------------------ *
 * 13. SMALL SHARED HELPERS
 * ------------------------------------------------------------------ */

/**
 * Today in IST as YYYY-MM-DD — the business date a run belongs to.
 * Built from the UTC instant plus 5.5h so the answer does not depend on the
 * host timezone (a server in UTC and a phone in IST must agree on the date a
 * closing check belongs to).
 */
export function fssaiToday(now: Date = new Date()): string {
  const istDate = new Date(now.getTime() + 5.5 * 3600_000);
  const y = istDate.getUTCFullYear();
  const m = String(istDate.getUTCMonth() + 1).padStart(2, '0');
  const d = String(istDate.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** YYYY-MM-DD shape test. Rejects '', '2026-13-40' and anything else. */
export function isISODate(v: string | null | undefined): boolean {
  const s = String(v || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Whole days between two YYYY-MM-DD dates (b - a). NaN if either is invalid. */
export function daysBetweenISO(a: string, b: string): number {
  if (!isISODate(a) || !isISODate(b)) return NaN;
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

/* ================================================================== *
 * 14. THE RECORD MODULES (P4-P10) — THE SHARED VOCABULARY
 * ==================================================================
 *
 * Everything below is used by MORE THAN ONE phase, which is the only reason it
 * is here rather than in a route. Eight feature lanes build the record screens
 * in parallel and none of them may edit this file, so a vocabulary that two of
 * them touch has to exist before any of them starts. The alternative was
 * measured on this project and has a name: two lanes each wrote their own
 * sales-slice.ts with the same export signature, the pair disagreed silently,
 * and tsc pointed at the wrong one.
 *
 * THE RULE THAT MAKES THIS SAFE, same as §1 above: there is NO CHECK constraint
 * on any of these columns in db.ts, so the database will store a value this file
 * does not declare. The arrays below are therefore the WHOLE enforcement. A row
 * carrying an unknown value must render as itself and never as a blank — every
 * `*Meta` lookup here falls back to the raw key, exactly as fssaiCaStatusMeta
 * does, so an unrecognised status reads "pest_fumigation" on screen instead of
 * disappearing from a food-safety record.
 */

/* ------------------------------------------------------------------ *
 * 14.1 THE RECORD LIFECYCLE — shared by every P4-P6 record table
 * ------------------------------------------------------------------ */

/**
 * The status every NON-CHECKLIST record moves through.
 *
 * FOUR VALUES, NOT THE RUN'S FIVE, and the missing one is the point:
 * fssai_runs has 'rejected' because a checklist round can be sent back for a
 * redo (the slot reopens). A receiving inspection, a temperature reading or a
 * pest sighting is an OBSERVATION OF A MOMENT THAT HAS PASSED — there is
 * nothing to redo, and "send it back" would invite re-recording a reading
 * somebody did not like. A record that was entered in error is VOIDED with a
 * reason (§19), and a record whose subject needs fixing raises a corrective
 * action (owner's Q14 ruling). Do not add 'rejected' here without a ruling.
 *
 * 'draft' is deliberately the first value and NOT 'in_progress': these records
 * are typically filled in one sitting at the door or in front of the fridge,
 * and a half-typed row is a draft, not a round in progress.
 */
export type FssaiRecordStatus = 'draft' | 'submitted' | 'verified' | 'void';

export const FSSAI_RECORD_STATUSES: readonly FssaiStatusMeta[] = [
  { key: 'draft',     label: 'Draft',     color: 'bg-amber-100 text-amber-800 border-amber-200' },
  { key: 'submitted', label: 'Submitted', color: 'bg-teal-100 text-teal-700 border-teal-200' },
  { key: 'verified',  label: 'Verified',  color: 'bg-green-100 text-green-700 border-green-200' },
  { key: 'void',      label: 'Voided',    color: 'bg-gray-100 text-gray-600 border-gray-200' },
] as const;

export function fssaiRecordStatusMeta(key: string | null | undefined): FssaiStatusMeta {
  return metaFrom(FSSAI_RECORD_STATUSES, key);
}

export function isFssaiRecordStatus(v: string | null | undefined): v is FssaiRecordStatus {
  return FSSAI_RECORD_STATUSES.some((s) => s.key === String(v || ''));
}

/**
 * May this record still be edited in place?
 *
 * Only a draft. A submitted record is amended by voiding it with a reason and
 * filing a new one, which is what §19 means by "void, never delete" — the file
 * then shows both, and an inspector can see what changed and why. A verified
 * record is doubly closed: somebody else has already attested to it.
 */
export function fssaiRecordIsEditable(status: string | null | undefined): boolean {
  return String(status || 'draft') === 'draft';
}

/**
 * WHY THIS PERSON CANNOT VOID THIS RECORD, in words, or '' if they can.
 *
 * One helper for all of P4-P6 because §19 is a single rule and eight lanes
 * writing it eight times is eight chances to drop the reason check. Measured
 * precedent for why the reason matters: goods_receipt_notes is the only
 * complete void implementation in this codebase and its void_reason is
 * mandatory in the route, not in the schema — a schema cannot require it,
 * because ALTER cannot add a CHECK (db.ts header).
 *
 * MANAGEMENT ONLY, and deliberately NOT "whoever recorded it": the person who
 * wrote a failing reading is exactly the person with a motive to make it go
 * away. This mirrors canVerifyFssai's §7 Q3 reasoning on the other side of the
 * same record.
 */
export function fssaiVoidRefusal(
  me: FssaiActor | null | undefined,
  row: { status?: string | null; voided_at?: string | null } | null | undefined,
  reason: string | null | undefined,
): string {
  if (!me) return 'You are not signed in.';
  if (!canManageFssaiCa(me)) return 'Only a manager, head of department or admin may void a compliance record.';
  if (!row) return 'That record no longer exists.';
  if (String(row.status || '') === 'void' || String(row.voided_at || '')) return 'That record has already been voided.';
  if (String(reason || '').trim().length < 4) return 'Say in words why this record is being voided — a void with no reason is not an audit trail.';
  return '';
}

/**
 * The record tables P10 must be able to void and audit, with the words a screen
 * uses for one of their rows.
 *
 * ONE LIST, because §19 is "void, never delete" for ALL of them and the audit
 * surface has to enumerate them somewhere. It is also the allowlist a generic
 * void route validates `entity_table` against — without it, a caller-supplied
 * table name reaches SQL, and this module's own audit row would name a table
 * that does not exist.
 */
export const FSSAI_RECORD_TABLES: readonly { table: string; one: string; many: string; path: string }[] = [
  { table: 'fssai_runs',               one: 'checklist record',       many: 'Checklist records',       path: '/fssai/checklists' },
  { table: 'fssai_receiving_checks',   one: 'delivery inspection',    many: 'Delivery inspections',    path: '/fssai/receiving' },
  { table: 'fssai_temperature_logs',   one: 'temperature reading',    many: 'Temperature readings',    path: '/fssai/temperature' },
  { table: 'fssai_equipment_events',   one: 'equipment event',        many: 'Equipment events',        path: '/fssai/cold-rooms' },
  { table: 'fssai_expiry_items',       one: 'expiry entry',           many: 'Expiry and disposal',     path: '/fssai/fifo' },
  { table: 'fssai_oil_checks',         one: 'oil check',              many: 'Oil checks',              path: '/fssai/oil-quality' },
  { table: 'fssai_oil_disposals',      one: 'used-oil collection',    many: 'Used-oil collections',    path: '/fssai/oil-quality' },
  { table: 'fssai_water_tests',        one: 'water or ice test',      many: 'Water and ice tests',     path: '/fssai/water-ice' },
  { table: 'fssai_pest_services',      one: 'pest control visit',     many: 'Pest control visits',     path: '/fssai/pest-control' },
  { table: 'fssai_pest_sightings',     one: 'pest sighting',          many: 'Pest sightings',          path: '/fssai/pest-control' },
  { table: 'fssai_documents',          one: 'document',               many: 'Documents and certificates', path: '/fssai/documents' },
  { table: 'fssai_inspections',        one: 'inspection',             many: 'Inspections',             path: '/fssai/inspections' },
  { table: 'fssai_corrective_actions', one: 'corrective action',      many: 'Corrective actions',      path: '/fssai/corrective-actions' },
] as const;

export function fssaiRecordTable(table: string | null | undefined) {
  return FSSAI_RECORD_TABLES.find((t) => t.table === String(table || '')) || null;
}

/* ------------------------------------------------------------------ *
 * 14.2 THE THREE-WAY TICK-BOX — and the trap it exists to avoid
 * ------------------------------------------------------------------ */

/**
 * A named checkpoint on a record: not assessed, in order, not in order, or not
 * applicable.
 *
 * WHY THIS IS TEXT AND NOT AN INTEGER, which is the single most important
 * decision in this section. goods_receipt_notes carries six INTEGER tick-boxes
 * (qc_quality, qc_temperature, qc_expiry, qc_damage, qc_weight,
 * qc_invoice_match) and MEASURED on the live snapshot: 29 GRNs exist and all
 * six columns sum to 0 across every one of them. That 0 is unreadable. It means
 * either "the checker looked and it was wrong" or "nobody ticked anything", and
 * those are opposite statements about a delivery. An integer column with a
 * DEFAULT cannot tell them apart, so a report over it either over-counts
 * failures or silently treats an un-done check as a pass.
 *
 * '' is therefore "not assessed" and it is the default; 'ok' and 'not_ok' are
 * both deliberate acts; 'na' is a deliberate act too ("no cold items on this
 * delivery"). Only 'not_ok' is a failure — see fssaiCheckResultIsFail.
 */
export type FssaiCheckResult = '' | 'ok' | 'not_ok' | 'na';

export const FSSAI_CHECK_RESULTS: readonly { key: FssaiCheckResult; label: string; color: string }[] = [
  { key: '',       label: 'Not checked',  color: 'bg-gray-100 text-gray-500 border-gray-200' },
  { key: 'ok',     label: 'In order',     color: 'bg-green-100 text-green-700 border-green-200' },
  { key: 'not_ok', label: 'Not in order', color: 'bg-red-100 text-red-700 border-red-200' },
  { key: 'na',     label: 'Not applicable', color: 'bg-slate-100 text-slate-600 border-slate-200' },
] as const;

export function isFssaiCheckResult(v: string | null | undefined): v is FssaiCheckResult {
  return FSSAI_CHECK_RESULTS.some((r) => r.key === String(v ?? ''));
}

/** Only an explicit 'not_ok' is a failure. '' is unanswered, never a fail. */
export function fssaiCheckResultIsFail(v: string | null | undefined): boolean {
  return String(v ?? '') === 'not_ok';
}

/** Was this checkpoint actually assessed either way? '' and nothing else is no. */
export function fssaiCheckResultAnswered(v: string | null | undefined): boolean {
  const s = String(v ?? '');
  return s === 'ok' || s === 'not_ok' || s === 'na';
}

export function fssaiCheckResultLabel(v: string | null | undefined): string {
  return (FSSAI_CHECK_RESULTS.find((r) => r.key === String(v ?? ''))?.label) || String(v ?? '');
}

/* ------------------------------------------------------------------ *
 * 14.3 A READING AGAINST A RANGE — temperature, oil, water
 * ------------------------------------------------------------------ */

/** fssai_temperature_logs.uom and fssai_equipment.temp_uom. */
export const FSSAI_TEMP_UOMS: readonly { key: string; label: string }[] = [
  { key: 'C', label: '°C' },
  { key: 'F', label: '°F' },
] as const;

/**
 * A reading in Celsius, whatever unit it was taken in.
 *
 * Needed because the range on a piece of equipment and the reading on a
 * borrowed probe may not share a unit, and comparing 40 (F) against a 0-5 (C)
 * range passes a fridge that is actually at 4.4 C only by accident. Returns
 * null for anything that is not a finite number — never 0, which would read as
 * a freezing reading.
 */
export function fssaiTempInC(value: number | null | undefined, uom: string | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const v = Number(value);
  return String(uom || 'C').toUpperCase() === 'F' ? (v - 32) * (5 / 9) : v;
}

/**
 * IS THIS READING OUTSIDE ITS RANGE, and in which direction, in words.
 *
 * Shared by the temperature log, the oil check and the water test because all
 * three ask the identical question and all three must phrase the answer the
 * same way on the record and in the corrective action it raises.
 *
 * TWO THINGS IT DELIBERATELY DOES NOT DO:
 *   · It does not round. evaluateFssaiAnswer already carries this rule for
 *     checklist answers and the reason is written there: rounding 5.4 to 5 lets
 *     a failing fridge pass a 0-5 rule. `decimals` is for DISPLAY.
 *   · It does not treat a missing range as a pass or a fail. No range means the
 *     reading is recorded and nothing is judged — which is the honest answer
 *     before the owner has set his standards, and is why `judged` is separate
 *     from `out_of_range`.
 */
export function fssaiRangeCheck(
  value: number | null | undefined,
  min: number | null | undefined,
  max: number | null | undefined,
  uom = '',
): { judged: boolean; out_of_range: boolean; why: string } {
  const v = value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value);
  const lo = min === null || min === undefined || !Number.isFinite(Number(min)) ? null : Number(min);
  const hi = max === null || max === undefined || !Number.isFinite(Number(max)) ? null : Number(max);
  const u = uom ? ` ${uom}` : '';
  if (v === null) return { judged: false, out_of_range: false, why: 'No reading was entered.' };
  if (lo === null && hi === null) return { judged: false, out_of_range: false, why: 'No safe range has been set for this, so the reading is recorded but not judged.' };
  if (lo !== null && v < lo) return { judged: true, out_of_range: true, why: `${v}${u} is below the safe minimum of ${lo}${u}.` };
  if (hi !== null && v > hi) return { judged: true, out_of_range: true, why: `${v}${u} is above the safe maximum of ${hi}${u}.` };
  return { judged: true, out_of_range: false, why: `${v}${u} is within range.` };
}

/* ------------------------------------------------------------------ *
 * 14.4 P4 — RECEIVING QC
 * ------------------------------------------------------------------ */

/**
 * The named checkpoints on a received line.
 *
 * The first six are the SAME six the GRN already carries (goods_receipt_notes
 * qc_quality / qc_temperature / qc_expiry / qc_damage / qc_weight /
 * qc_invoice_match), so a delivery inspected here can be read beside the GRN
 * without a translation table. `label` is the seventh and is new: FSSAI
 * labelling (name, batch/lot, use-by, veg/non-veg mark) is a checkpoint the
 * purchasing module never had a reason to carry.
 *
 * `cold_only` marks the checkpoints that mean nothing on a sack of flour, so a
 * screen can offer 'na' as the obvious answer instead of an empty box.
 */
export const FSSAI_RECEIVING_CHECKPOINTS: readonly {
  key: string; column: string; label: string; hint: string; cold_only?: true;
}[] = [
  { key: 'quality',       column: 'chk_quality',       label: 'Quality',            hint: 'Look, smell and condition on arrival.' },
  { key: 'temperature',   column: 'chk_temperature',   label: 'Temperature',        hint: 'Probed or surface reading against the range for this item.', cold_only: true },
  { key: 'expiry',        column: 'chk_expiry',        label: 'Date code',          hint: 'Use-by or best-before, and enough shelf life left to use it.' },
  { key: 'damage',        column: 'chk_damage',        label: 'Packaging',          hint: 'Torn, crushed, leaking, swollen or opened packs.' },
  { key: 'weight',        column: 'chk_weight',        label: 'Weight or count',    hint: 'What arrived against what the bill says.' },
  { key: 'invoice_match', column: 'chk_invoice_match', label: 'Bill matches',       hint: 'Item, rate and quantity as ordered.' },
  { key: 'label',         column: 'chk_label',         label: 'Labelling',          hint: 'Name, lot or batch, date, and the veg / non-veg mark.' },
] as const;

/** What was decided about a received line. */
export type FssaiReceivingDecision = '' | 'accepted' | 'partially_accepted' | 'rejected';

export const FSSAI_RECEIVING_DECISIONS: readonly FssaiStatusMeta[] = [
  { key: '',                   label: 'Not decided',        color: 'bg-gray-100 text-gray-500 border-gray-200' },
  { key: 'accepted',           label: 'Accepted',           color: 'bg-green-100 text-green-700 border-green-200' },
  { key: 'partially_accepted', label: 'Partly accepted',    color: 'bg-amber-100 text-amber-800 border-amber-200' },
  { key: 'rejected',           label: 'Rejected',           color: 'bg-red-100 text-red-700 border-red-200' },
] as const;

export function fssaiReceivingDecisionMeta(key: string | null | undefined): FssaiStatusMeta {
  return metaFrom(FSSAI_RECEIVING_DECISIONS, key);
}

/**
 * The decision the QUANTITIES imply, so a screen can propose it and a report
 * can never show "Accepted" beside a rejected quantity.
 *
 * It is a PROPOSAL, not an override: the stored column is what the checker
 * decided, and a line may be rejected outright on quality with nothing sent
 * back yet. Returns '' when nothing has been entered, so an untouched line
 * never reads as accepted.
 */
export function fssaiReceivingDecisionFor(
  received: number | null | undefined,
  accepted: number | null | undefined,
): FssaiReceivingDecision {
  const r = Number(received);
  const a = Number(accepted);
  if (!Number.isFinite(r) || r <= 0 || !Number.isFinite(a)) return '';
  if (a <= 0) return 'rejected';
  if (a >= r) return 'accepted';
  return 'partially_accepted';
}

/**
 * Why a line was sent back. A CODED list, not free text, because §18's reports
 * ask "what do we reject this vendor for" and free text cannot be grouped.
 * 'other' keeps the free-text column honest instead of forcing a wrong code.
 */
export const FSSAI_REJECT_REASONS: readonly { key: string; label: string }[] = [
  { key: 'temperature',      label: 'Arrived too warm or too cold' },
  { key: 'expired',          label: 'Past its date' },
  { key: 'near_expiry',      label: 'Too little shelf life left' },
  { key: 'damaged',          label: 'Damaged or leaking packaging' },
  { key: 'short_weight',     label: 'Short weight or short count' },
  { key: 'poor_quality',     label: 'Poor quality — look, smell or condition' },
  { key: 'pest_evidence',    label: 'Signs of pests' },
  { key: 'no_label',         label: 'Missing or unreadable label' },
  { key: 'wrong_item',       label: 'Not what was ordered' },
  { key: 'no_supplier_licence', label: 'Supplier licence missing or expired' },
  { key: 'unhygienic_vehicle',  label: 'Vehicle or handler not hygienic' },
  { key: 'other',            label: 'Other — say why' },
] as const;

/* ------------------------------------------------------------------ *
 * 14.5 P4 — TEMPERATURE LOGS AND EQUIPMENT
 * ------------------------------------------------------------------ */

/**
 * WHAT a temperature reading is of. fssai_temperature_logs.log_kind.
 *
 * One table and a kind column, not nine tables: every one of these is the same
 * record — a number, a time, a range and a person — and §24's rule ("dynamic
 * and configurable rather than a separate table for every checklist") applies
 * with even more force to readings than to checklists.
 *
 * `direction` is what the screen needs to phrase a failure the right way round:
 * a chiller fails by being TOO WARM and hot holding fails by being TOO COOL, so
 * "above the maximum" is the alarming half for one and "below the minimum" for
 * the other. `window_minutes` marks the two kinds where the FSSAI rule is a
 * RATE, not a level — cooling and reheating are judged on reaching a
 * temperature within a time, which is why fssai_temp_standards carries
 * max_minutes.
 */
export type FssaiTempLogKind =
  | 'equipment'
  | 'food'
  | 'delivery'
  | 'hot_holding'
  | 'cooking'
  | 'cooling'
  | 'reheating'
  | 'thawing'
  | 'probe_calibration';

export const FSSAI_TEMP_LOG_KINDS: readonly {
  key: FssaiTempLogKind; label: string; hint: string; direction: 'cold' | 'hot' | 'either'; window_minutes?: true;
}[] = [
  { key: 'equipment',         label: 'Equipment',          hint: 'A cold room, chiller, freezer or hot cabinet read on its round.', direction: 'cold' },
  { key: 'food',              label: 'Food probe',         hint: 'A probe into the food itself, in storage or on the line.',        direction: 'either' },
  { key: 'delivery',          label: 'Delivery',           hint: 'Taken at the door as goods arrive.',                              direction: 'cold' },
  { key: 'hot_holding',       label: 'Hot holding',        hint: 'Food held hot for service.',                                      direction: 'hot' },
  { key: 'cooking',           label: 'Cooking',            hint: 'Core temperature at the end of cooking.',                         direction: 'hot' },
  { key: 'cooling',           label: 'Cooling',            hint: 'Cooked food on its way down, judged against the clock.',          direction: 'cold', window_minutes: true },
  { key: 'reheating',         label: 'Reheating',          hint: 'Food brought back up, judged against the clock.',                 direction: 'hot',  window_minutes: true },
  { key: 'thawing',           label: 'Thawing',            hint: 'Frozen food being brought up under control.',                     direction: 'cold' },
  { key: 'probe_calibration', label: 'Probe calibration',  hint: 'The thermometer checked against ice or boiling water.',            direction: 'either' },
] as const;

export function isFssaiTempLogKind(v: string | null | undefined): v is FssaiTempLogKind {
  return FSSAI_TEMP_LOG_KINDS.some((k) => k.key === String(v || ''));
}

export function fssaiTempLogKindLabel(v: string | null | undefined): string {
  return FSSAI_TEMP_LOG_KINDS.find((k) => k.key === String(v || ''))?.label || String(v || '');
}

/**
 * HOW a reading got into the log. fssai_temperature_logs.source_kind.
 *
 * It matters for the audit trail: a reading that came from a checklist answer
 * is covered by that round's signature and its sheet digest, while a reading
 * typed straight onto the temperature screen is not. A report that mixes them
 * without saying so overstates how much of the file is signed for.
 */
export const FSSAI_TEMP_SOURCES: readonly { key: string; label: string }[] = [
  { key: 'manual',    label: 'Entered directly' },
  { key: 'checklist', label: 'From a checklist answer' },
  { key: 'receiving', label: 'From a delivery inspection' },
  { key: 'device',    label: 'From a logging device' },
] as const;

/**
 * What happens TO a piece of equipment, as opposed to a reading off it.
 * fssai_equipment_events.event_kind.
 *
 * These are the entries an inspector asks for when a reading is out of range:
 * was the unit defrosted, was it repaired, was the thermometer ever checked.
 * 'calibration' is here rather than in its own table because the shape is
 * identical — a before value, a reference, an after value and a verdict.
 */
export const FSSAI_EQUIPMENT_EVENT_KINDS: readonly { key: string; label: string; hint: string }[] = [
  { key: 'defrost',       label: 'Defrost',             hint: 'Planned or forced defrost of a cold unit.' },
  { key: 'cleaning',      label: 'Deep clean',          hint: 'Beyond the daily wipe-down — a recorded clean of the unit.' },
  { key: 'breakdown',     label: 'Breakdown',           hint: 'The unit stopped holding temperature.' },
  { key: 'repair',        label: 'Repair or service',   hint: 'What was done, by whom, and when it is next due.' },
  { key: 'calibration',   label: 'Calibration',         hint: 'Thermometer or probe checked against a known reference.' },
  { key: 'out_of_service', label: 'Taken out of use',   hint: 'The unit is not to be loaded until it is back.' },
  { key: 'back_in_service', label: 'Back in use',       hint: 'Checked and loaded again.' },
  { key: 'filter_change', label: 'Filter change',       hint: 'Water or air filter replaced.' },
] as const;

/* ------------------------------------------------------------------ *
 * 14.6 P5 — FIFO / FEFO, EXPIRY AND DISPOSAL
 * ------------------------------------------------------------------ */

/**
 * How many days ahead counts as "near expiry" before the owner sets his own.
 *
 * A DEFAULT, NOT A RULE: it belongs on fssai_item_shelf_life.near_expiry_days
 * per item and in Settings globally, because a 7-day warning on milk is useless
 * and on canned tomatoes is noise. Nothing in the module may compare against a
 * literal — that is the §5 "never hard-coded" rule applied to dates.
 */
export const FSSAI_NEAR_EXPIRY_DAYS = 3;

export type FssaiExpiryState = 'none' | 'ok' | 'near_expiry' | 'expired';

export const FSSAI_EXPIRY_STATES: readonly FssaiStatusMeta[] = [
  { key: 'none',        label: 'No date',     color: 'bg-gray-100 text-gray-500 border-gray-200' },
  { key: 'ok',          label: 'In date',     color: 'bg-green-100 text-green-700 border-green-200' },
  { key: 'near_expiry', label: 'Use first',   color: 'bg-amber-100 text-amber-800 border-amber-200' },
  { key: 'expired',     label: 'Past date',   color: 'bg-red-100 text-red-700 border-red-200' },
] as const;

export function fssaiExpiryStateMeta(key: string | null | undefined): FssaiStatusMeta {
  return metaFrom(FSSAI_EXPIRY_STATES, key);
}

/**
 * The state of one dated item, from its expiry date alone.
 *
 * 'none' for a blank or malformed date and NEVER 'ok' — which is the whole
 * reason this is a shared helper. MEASURED on the live snapshot: all 952 items
 * carry a blank shelf life, so a FIFO screen that treats "no date" as "in date"
 * would paint the entire store green and say nothing at all. 'none' is what
 * makes the gap visible.
 */
export function fssaiExpiryState(
  expiryISO: string | null | undefined,
  todayISO: string,
  nearDays: number = FSSAI_NEAR_EXPIRY_DAYS,
): FssaiExpiryState {
  const e = String(expiryISO || '');
  if (!isISODate(e) || !isISODate(todayISO)) return 'none';
  const days = daysBetweenISO(todayISO, e);
  if (!Number.isFinite(days)) return 'none';
  if (days < 0) return 'expired';
  const window = Number.isFinite(Number(nearDays)) && Number(nearDays) >= 0 ? Number(nearDays) : FSSAI_NEAR_EXPIRY_DAYS;
  return days <= window ? 'near_expiry' : 'ok';
}

/** Why an item is on the expiry register. fssai_expiry_items.state. */
export const FSSAI_EXPIRY_REASONS: readonly { key: string; label: string }[] = [
  { key: 'near_expiry', label: 'Near its date' },
  { key: 'expired',     label: 'Past its date' },
  { key: 'damaged',     label: 'Damaged' },
  { key: 'spoiled',     label: 'Spoiled' },
  { key: 'unlabelled',  label: 'No label or date' },
  { key: 'recalled',    label: 'Recalled by the supplier' },
] as const;

/**
 * What was DONE about it. fssai_expiry_items.action_taken.
 *
 * ⚠️ NONE OF THESE MOVES STOCK. HARD RULE 5 freezes the material-movement flow
 * and FSSAI only observes it: 'discarded' here records that a discard happened
 * and who witnessed it, and the stock adjustment is still made in the inventory
 * module by whoever owns that number. A disposal register that silently wrote
 * stock would put two different authorities on one quantity.
 */
export const FSSAI_EXPIRY_ACTIONS: readonly { key: string; label: string }[] = [
  { key: '',           label: 'Not decided yet' },
  { key: 'use_first',  label: 'Moved to the front to use first' },
  { key: 'relabelled', label: 'Relabelled with its real date' },
  { key: 'segregated', label: 'Segregated and held' },
  { key: 'returned',   label: 'Returned to the supplier' },
  { key: 'discarded',  label: 'Discarded' },
] as const;

/** How an item is kept. fssai_item_shelf_life.storage_condition. */
export const FSSAI_STORAGE_CONDITIONS: readonly { key: string; label: string; hint: string }[] = [
  { key: 'ambient',  label: 'Ambient',  hint: 'Dry store, room temperature.' },
  { key: 'chilled',  label: 'Chilled',  hint: 'Cold room or chiller.' },
  { key: 'frozen',   label: 'Frozen',   hint: 'Freezer.' },
  { key: 'hot',      label: 'Hot held', hint: 'Held above the hot-holding minimum.' },
] as const;

/* ------------------------------------------------------------------ *
 * 14.7 P5 — OIL QUALITY
 * ------------------------------------------------------------------ */

/**
 * The FSSAI limit on total polar materials in frying oil: 25%. Oil above it
 * must not be used.
 *
 * A DEFAULT IN ONE PLACE, not a rule in the code: it seeds
 * fssai_temp_standards (code 'OIL-TPM') and every reader goes through the
 * standard, so the owner can tighten it without a deploy. Never compare a
 * reading against this constant directly — that is exactly the hard-coding §5
 * forbids.
 */
export const FSSAI_OIL_TPM_LIMIT_PCT = 25;

/** How the oil was judged. fssai_oil_checks.method. */
export const FSSAI_OIL_METHODS: readonly { key: string; label: string; hint: string }[] = [
  { key: 'tpm_meter',  label: 'TPM meter',   hint: 'A number from the meter — the one an inspector trusts.' },
  { key: 'test_strip', label: 'Test strip',  hint: 'Colour band read off the strip.' },
  { key: 'sensory',    label: 'Look and smell', hint: 'Colour, smoke, foam and smell. Honest, but not a measurement.' },
] as const;

/** What was done to the oil. fssai_oil_checks.action_taken. */
export const FSSAI_OIL_ACTIONS: readonly { key: string; label: string }[] = [
  { key: '',          label: 'Nothing — in use' },
  { key: 'topped_up', label: 'Topped up' },
  { key: 'filtered',  label: 'Filtered' },
  { key: 'changed',   label: 'Changed completely' },
  { key: 'withdrawn', label: 'Taken out of use' },
] as const;

/* ------------------------------------------------------------------ *
 * 14.8 P5 — WATER AND ICE
 * ------------------------------------------------------------------ */

/**
 * What kind of water or ice record this is. fssai_water_tests.test_kind.
 *
 * A lab report and a daily chlorine reading sit in ONE table because the
 * question an inspector asks is one question — "show me your water records" —
 * and splitting them means every report unions two tables. The lab report's
 * variable parameter list lives in parameters_json for the same reason
 * fssai_questions.options_json is JSON: ordered, variable-length, never
 * filtered in SQL.
 */
export const FSSAI_WATER_TEST_KINDS: readonly { key: string; label: string; hint: string; is_lab?: true }[] = [
  { key: 'lab_report',    label: 'Lab report',        hint: 'A potability certificate from a laboratory.', is_lab: true },
  { key: 'chlorine',      label: 'Residual chlorine', hint: 'Free chlorine at the tap, in ppm.' },
  { key: 'tds',           label: 'TDS',               hint: 'Total dissolved solids, in ppm.' },
  { key: 'ph',            label: 'pH',                hint: 'Acidity of the supply.' },
  { key: 'hardness',      label: 'Hardness',          hint: 'As CaCO3, in ppm.' },
  { key: 'ice_check',     label: 'Ice check',         hint: 'Ice machine, scoop and store — clean, covered, no bare hands.' },
  { key: 'tank_cleaning', label: 'Tank cleaning',     hint: 'Storage tank cleaned and the date it is next due.' },
  { key: 'filter_change', label: 'Filter change',     hint: 'RO or sediment filter replaced.' },
] as const;

export function fssaiWaterTestKind(v: string | null | undefined) {
  return FSSAI_WATER_TEST_KINDS.find((k) => k.key === String(v || '')) || null;
}

/* ------------------------------------------------------------------ *
 * 14.9 P6 — PEST CONTROL
 * ------------------------------------------------------------------ */

/** What was seen. fssai_pest_sightings.pest_type. */
export const FSSAI_PEST_TYPES: readonly { key: string; label: string }[] = [
  { key: 'rodent',    label: 'Rodent' },
  { key: 'cockroach', label: 'Cockroach' },
  { key: 'fly',       label: 'Fly' },
  { key: 'mosquito',  label: 'Mosquito' },
  { key: 'ant',       label: 'Ant' },
  { key: 'bird',      label: 'Bird' },
  { key: 'lizard',    label: 'Lizard' },
  { key: 'stored_product', label: 'Weevil or stored-product insect' },
  { key: 'other',     label: 'Other' },
] as const;

/**
 * What was actually seen, as opposed to the pest itself — droppings and gnaw
 * marks are evidence an inspector counts, and a log that only records live
 * sightings misses most of what staff actually find.
 */
export const FSSAI_PEST_EVIDENCE_KINDS: readonly { key: string; label: string }[] = [
  { key: 'live',       label: 'Live pest' },
  { key: 'dead',       label: 'Dead pest' },
  { key: 'droppings',  label: 'Droppings' },
  { key: 'gnaw_marks', label: 'Gnaw or chew marks' },
  { key: 'nesting',    label: 'Nesting material' },
  { key: 'smear',      label: 'Smear marks' },
  { key: 'device_catch', label: 'Caught in a device' },
] as const;

export const FSSAI_PEST_SEVERITIES: readonly FssaiStatusMeta[] = [
  { key: 'low',    label: 'One-off',   color: 'bg-yellow-100 text-yellow-800 border-yellow-200' },
  { key: 'medium', label: 'Recurring', color: 'bg-amber-100 text-amber-800 border-amber-200' },
  { key: 'high',   label: 'Infestation', color: 'bg-red-100 text-red-700 border-red-200' },
] as const;

export function fssaiPestSeverityMeta(key: string | null | undefined): FssaiStatusMeta {
  return metaFrom(FSSAI_PEST_SEVERITIES, key);
}

/** Why the contractor came. fssai_pest_services.service_kind. */
export const FSSAI_PEST_SERVICE_KINDS: readonly { key: string; label: string }[] = [
  { key: 'scheduled', label: 'Scheduled visit' },
  { key: 'follow_up', label: 'Follow-up' },
  { key: 'emergency', label: 'Called out' },
  { key: 'fogging',   label: 'Fogging' },
  { key: 'baiting',   label: 'Baiting' },
  { key: 'inspection', label: 'Inspection only' },
] as const;

/**
 * Where the visit stands. fssai_pest_services.status.
 *
 * 'missed' is the value that earns this its own vocabulary: a contract visit
 * that did not happen is the single most common pest-control finding, and a
 * schema with only planned/completed cannot record it — the row would either
 * sit as "planned" forever or be deleted, and §19 forbids the second.
 */
export const FSSAI_PEST_SERVICE_STATUSES: readonly FssaiStatusMeta[] = [
  { key: 'planned',   label: 'Planned',   color: 'bg-gray-100 text-gray-600 border-gray-200' },
  { key: 'completed', label: 'Completed', color: 'bg-green-100 text-green-700 border-green-200' },
  { key: 'missed',    label: 'Missed',    color: 'bg-red-100 text-red-700 border-red-200' },
  { key: 'cancelled', label: 'Cancelled', color: 'bg-slate-100 text-slate-600 border-slate-200' },
] as const;

export function fssaiPestServiceStatusMeta(key: string | null | undefined): FssaiStatusMeta {
  return metaFrom(FSSAI_PEST_SERVICE_STATUSES, key);
}

/** Monitoring points on the pest map. fssai_pest_devices.device_kind. */
export const FSSAI_PEST_DEVICE_KINDS: readonly { key: string; label: string }[] = [
  { key: 'bait_station', label: 'Bait station' },
  { key: 'glue_board',   label: 'Glue board' },
  { key: 'fly_unit',     label: 'Insect light trap' },
  { key: 'rodent_trap',  label: 'Rodent trap' },
  { key: 'pheromone',    label: 'Pheromone trap' },
  { key: 'air_curtain',  label: 'Air curtain' },
  { key: 'other',        label: 'Other' },
] as const;

/* ------------------------------------------------------------------ *
 * 14.10 P6 — DOCUMENTS AND CERTIFICATES
 * ------------------------------------------------------------------ */

/**
 * What kind of paper this is. fssai_documents.doc_type.
 *
 * `scope` is what tells the screen which other id the document hangs off:
 * 'vendor' needs a supplier, 'person' needs a staff email, 'equipment' needs a
 * unit, 'outlet' needs nothing. Without it, every document form would show
 * every field.
 */
export const FSSAI_DOC_TYPES: readonly {
  key: string; label: string; scope: 'outlet' | 'vendor' | 'person' | 'equipment'; renews?: true;
}[] = [
  { key: 'fssai_licence',      label: 'FSSAI licence or registration', scope: 'outlet',    renews: true },
  { key: 'trade_licence',      label: 'Trade licence',                 scope: 'outlet',    renews: true },
  { key: 'fire_noc',           label: 'Fire NOC',                      scope: 'outlet',    renews: true },
  { key: 'gst',                label: 'GST registration',              scope: 'outlet' },
  { key: 'insurance',          label: 'Insurance',                     scope: 'outlet',    renews: true },
  { key: 'water_test',         label: 'Water test report',             scope: 'outlet',    renews: true },
  { key: 'pest_contract',      label: 'Pest control contract',         scope: 'vendor',    renews: true },
  { key: 'supplier_licence',   label: 'Supplier FSSAI licence',        scope: 'vendor',    renews: true },
  { key: 'medical_fitness',    label: 'Medical fitness certificate',   scope: 'person',    renews: true },
  { key: 'food_handler_training', label: 'Food handler training',      scope: 'person',    renews: true },
  { key: 'calibration_certificate', label: 'Calibration certificate',  scope: 'equipment', renews: true },
  { key: 'amc',                label: 'Service contract (AMC)',        scope: 'equipment', renews: true },
  { key: 'lease',              label: 'Lease or premises document',    scope: 'outlet' },
  { key: 'other',              label: 'Other',                         scope: 'outlet' },
] as const;

export function fssaiDocType(key: string | null | undefined) {
  return FSSAI_DOC_TYPES.find((d) => d.key === String(key || '')) || null;
}

/** How many days before expiry the reminder starts, before the owner sets it. */
export const FSSAI_DOC_REMINDER_DAYS = 30;

export type FssaiDocState = 'no_expiry' | 'valid' | 'expiring' | 'expired';

export const FSSAI_DOC_STATES: readonly FssaiStatusMeta[] = [
  { key: 'no_expiry', label: 'No expiry',      color: 'bg-gray-100 text-gray-500 border-gray-200' },
  { key: 'valid',     label: 'Valid',          color: 'bg-green-100 text-green-700 border-green-200' },
  { key: 'expiring',  label: 'Expiring soon',  color: 'bg-amber-100 text-amber-800 border-amber-200' },
  { key: 'expired',   label: 'EXPIRED',        color: 'bg-red-100 text-red-700 border-red-200' },
] as const;

export function fssaiDocStateMeta(key: string | null | undefined): FssaiStatusMeta {
  return metaFrom(FSSAI_DOC_STATES, key);
}

/**
 * The expiry state of one document, DERIVED and never stored.
 *
 * Deliberately not a column: a stored 'expiring' goes stale at midnight with
 * nothing to wake it, and a licence that reads "Valid" the day after it lapsed
 * is the worst single row this module could render. Same shape as
 * fssaiExpiryState above, with the document's own reminder window.
 */
export function fssaiDocState(
  expiryISO: string | null | undefined,
  todayISO: string,
  reminderDays: number | null | undefined = FSSAI_DOC_REMINDER_DAYS,
): FssaiDocState {
  const e = String(expiryISO || '');
  if (!isISODate(e) || !isISODate(todayISO)) return 'no_expiry';
  const days = daysBetweenISO(todayISO, e);
  if (!Number.isFinite(days)) return 'no_expiry';
  if (days < 0) return 'expired';
  const w = Number.isFinite(Number(reminderDays)) && Number(reminderDays) >= 0 ? Number(reminderDays) : FSSAI_DOC_REMINDER_DAYS;
  return days <= w ? 'expiring' : 'valid';
}

/* ------------------------------------------------------------------ *
 * 14.11 P9 — INSPECTIONS AND FINDINGS
 * ------------------------------------------------------------------ */

/** Who inspected. fssai_inspections.inspection_kind. */
export const FSSAI_INSPECTION_KINDS: readonly { key: string; label: string; external?: true }[] = [
  { key: 'fssai_officer',  label: 'FSSAI officer',        external: true },
  { key: 'municipal',      label: 'Municipal or local body', external: true },
  { key: 'third_party',    label: 'Third-party audit',    external: true },
  { key: 'customer_audit', label: 'Customer or aggregator audit', external: true },
  { key: 'internal',       label: 'Internal audit' },
] as const;

export const FSSAI_INSPECTION_STATUSES: readonly FssaiStatusMeta[] = [
  { key: 'planned',     label: 'Planned',      color: 'bg-gray-100 text-gray-600 border-gray-200' },
  { key: 'in_progress', label: 'In progress',  color: 'bg-amber-100 text-amber-800 border-amber-200' },
  { key: 'open',        label: 'Points open',  color: 'bg-red-100 text-red-700 border-red-200' },
  { key: 'closed',      label: 'Closed',       color: 'bg-green-100 text-green-700 border-green-200' },
  { key: 'void',        label: 'Voided',       color: 'bg-gray-100 text-gray-600 border-gray-200' },
] as const;

export function fssaiInspectionStatusMeta(key: string | null | undefined): FssaiStatusMeta {
  return metaFrom(FSSAI_INSPECTION_STATUSES, key);
}

/**
 * How bad one finding is. The four words an audit report actually uses, in the
 * order an inspector ranks them — so a report can sort on severity_rank and a
 * screen can lead with what must be fixed first.
 */
export const FSSAI_FINDING_SEVERITIES: readonly (FssaiStatusMeta & { rank: number })[] = [
  { key: 'critical',    label: 'Critical',    rank: 1, color: 'bg-red-100 text-red-700 border-red-200' },
  { key: 'major',       label: 'Major',       rank: 2, color: 'bg-orange-100 text-orange-700 border-orange-200' },
  { key: 'minor',       label: 'Minor',       rank: 3, color: 'bg-amber-100 text-amber-800 border-amber-200' },
  { key: 'observation', label: 'Observation', rank: 4, color: 'bg-slate-100 text-slate-600 border-slate-200' },
] as const;

export function fssaiFindingSeverityMeta(key: string | null | undefined): FssaiStatusMeta {
  return metaFrom(FSSAI_FINDING_SEVERITIES, key);
}

export function fssaiFindingSeverityRank(key: string | null | undefined): number {
  return FSSAI_FINDING_SEVERITIES.find((s) => s.key === String(key || ''))?.rank ?? 9;
}

export const FSSAI_FINDING_STATUSES: readonly FssaiStatusMeta[] = [
  { key: 'open',        label: 'Open',        color: 'bg-red-100 text-red-700 border-red-200' },
  { key: 'in_progress', label: 'Being fixed', color: 'bg-amber-100 text-amber-800 border-amber-200' },
  { key: 'closed',      label: 'Closed',      color: 'bg-green-100 text-green-700 border-green-200' },
  { key: 'not_accepted', label: 'Not accepted', color: 'bg-slate-100 text-slate-600 border-slate-200' },
] as const;

export function fssaiFindingStatusMeta(key: string | null | undefined): FssaiStatusMeta {
  return metaFrom(FSSAI_FINDING_STATUSES, key);
}

/* ------------------------------------------------------------------ *
 * 14.12 ATTACHMENTS ON A RECORD THAT IS NOT A CHECKLIST RUN
 * ------------------------------------------------------------------ */

/**
 * WHY fssai_attachments EXISTS AND fssai_evidence COULD NOT BE REUSED — read
 * this before adding a photo to any P4-P6 screen.
 *
 * fssai_evidence.run_id is `TEXT NOT NULL` with a FOREIGN KEY to fssai_runs, so
 * a photograph of a rejected delivery or a rat sighting CANNOT be stored there:
 * there is no run to point at, and '' would throw with foreign_keys = ON. That
 * is not an oversight to fix — it is load-bearing. computeFssaiSheetDigest
 * hashes a run's evidence into the signature that covers the sheet, so every
 * row in that table is part of somebody's attestation. Widening it to accept
 * run-less rows would put unsigned photographs inside a signed set.
 *
 * So the record tables get their own store with the SAME budget
 * (FSSAI_PHOTO_* above), the SAME 12-month retention columns and the same
 * "the row outlives the image" rule. Two consequences the lanes must honour:
 *   1. The retention sweep must walk BOTH tables. One that only clears
 *      fssai_evidence silently keeps every delivery photograph forever.
 *   2. entity_table is validated against this list. A caller-supplied table
 *      name must never reach SQL, and an attachment pointing at a table that
 *      does not exist is an orphan nothing will ever show.
 */
export const FSSAI_ATTACHMENT_ENTITIES: readonly string[] = [
  'fssai_receiving_checks',
  'fssai_receiving_lines',
  'fssai_temperature_logs',
  'fssai_equipment',
  'fssai_equipment_events',
  'fssai_expiry_items',
  'fssai_oil_checks',
  'fssai_oil_disposals',
  'fssai_water_tests',
  'fssai_pest_services',
  'fssai_pest_sightings',
  'fssai_documents',
  'fssai_inspections',
  'fssai_inspection_findings',
  'fssai_corrective_actions',
] as const;

export function isFssaiAttachmentEntity(v: string | null | undefined): boolean {
  return FSSAI_ATTACHMENT_ENTITIES.includes(String(v || ''));
}

/** What an attachment is. Mirrors FssaiEvidenceKind, plus the paper documents. */
export const FSSAI_ATTACHMENT_KINDS: readonly { key: string; label: string }[] = [
  { key: 'photo',       label: 'Photograph' },
  { key: 'document',    label: 'Scanned document' },
  { key: 'certificate', label: 'Certificate' },
  { key: 'report',      label: 'Report' },
] as const;

/* ------------------------------------------------------------------ *
 * 14.13 P8 — THE SEED LOG
 * ------------------------------------------------------------------ */

/**
 * WHY A SEED NEEDS A LOG AT ALL, which is the one thing P8 must not get wrong.
 *
 * The HRMS block in db.ts records the rule in its own words: a seed that runs on
 * every boot RESURRECTS ROWS AN ADMIN DELETED. The twelve checklists are rows
 * (§24), the owner is meant to edit and retire them, and INSERT OR IGNORE keyed
 * on `code` cannot tell "never seeded" from "seeded and then deliberately
 * removed" — both look like an absent row.
 *
 * fssai_seed_log is the memory that closes that gap: a pack writes one row per
 * pack-version and one per item, and a pack whose marker row exists NEVER RUNS
 * AGAIN. It is also the only honest answer to "what did the seed actually do",
 * because the DDL's errors are swallowed per statement.
 */
export const FSSAI_SEED_ITEM_KINDS: readonly string[] = [
  'pack', 'template', 'section', 'question', 'equipment', 'standard', 'document_type',
] as const;

export const FSSAI_SEED_ACTIONS: readonly { key: string; label: string }[] = [
  { key: 'inserted', label: 'Created' },
  { key: 'skipped',  label: 'Already there — left alone' },
  { key: 'updated',  label: 'Updated' },
  { key: 'failed',   label: 'Failed' },
] as const;

/** The marker row's item_kind. A pack with this row present must not re-run. */
export const FSSAI_SEED_PACK_MARKER = 'pack';
