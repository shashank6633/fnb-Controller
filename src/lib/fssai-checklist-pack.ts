/**
 * THE TWELVE READY-MADE CHECKLISTS (P8) — AS DATA, NEVER AS CODE.
 *
 * This file is the whole of P8's content. It is a pure module: no database
 * import, no hooks, no side effects — so the API route, the admin screen and a
 * throwaway probe can all read the same twelve checklists without booting
 * anything.
 *
 * WHY DATA AND NOT TWELVE SCREENS, settled in FSSAI-BUILD-STATE.md §2 from the
 * owner's §24: *"Design the backend so that checklists are dynamic and
 * configurable rather than creating a separate database table for every
 * checklist."* Food Quality (§6), Cleaning & Sanitation (§8), Personal Hygiene
 * (§9), Food Storage (§10) and Kitchen Safety (§11) are the same object — a
 * template with sections, typed questions, a frequency and pass/fail rules — so
 * they ship as ROWS in the engine P2a built. The owner then edits them in
 * Settings when a regulation or an SOP changes, with no developer and no deploy.
 *
 * ⚠️ THE RISK THIS FILE IS THE MITIGATION FOR (RECON §10 R1, "most likely
 * failure"): *"If the engine gains a question type, a pass/fail condition
 * grammar or a section rule after the seeds are written, the seeds silently
 * encode the old shape — and because boot errors are swallowed and seeds are
 * INSERT OR IGNORE, a half-migrated template looks exactly like a correct
 * one."* So every question below is pushed through `normalizeFssaiQuestion()`
 * — the engine's own validator, the same one the builder screen's POST uses —
 * BEFORE the seed opens a transaction. A question this build's engine cannot
 * render cannot be seeded: `validateFssaiChecklistPack()` names it and the
 * apply refuses. That is a test, not a comment; the probe in the P8 report runs
 * it.
 *
 * ⚠️ EVERY NUMBER HERE IS A ROW, NOT A CONSTANT. The owner's §5 is explicit
 * that temperature standards are configurable and never hard-coded. 65 °C hot
 * holding, 5 °C cold holding, 75 °C cooking core, −18 °C frozen, 82 °C final
 * rinse and 50–100 ppm sanitiser are seeded as `min_value` / `max_value` on
 * question ROWS, which is exactly what makes them editable. Nothing in this
 * module compares against a literal at runtime.
 *
 * WHAT IS DELIBERATELY NOT HERE, and why — these are the P8 assumptions:
 *   · **No assignments.** A template says WHAT is asked; `fssai_assignments`
 *     says who owes it and when, and that needs a person or a role. Roles and
 *     departments are the owner's (HARD RULE 4), and seeding a rota would start
 *     generating "overdue" against staff nobody rostered. The pack seeds the
 *     twelve checklists; the owner builds the rota.
 *   · **No department.** Live department names are messy ("Akan  Indian",
 *     "Akan Main Kitchen") and matching on a name is forbidden (RECON §5 row 5:
 *     match on id). So `department_id` is '' — restaurant-wide — unless the
 *     admin picks one on the seed screen, which resolves it BY ID against the
 *     live table.
 *   · **No `responsible_role_id`.** Same reason. FSSAI never creates a role.
 *   · **`target_kind` is only 'none' or 'person'.** Measured against the
 *     runner: 'equipment' / 'area' / 'grn' / 'batch' all need a target chosen
 *     from a register, and `fssai_equipment` holds 0 rows — a seeded
 *     cold-room-targeted checklist would be impossible to start on the phone
 *     (runs/route.ts:381 refuses a non-'none' kind with no `target_id`). Every
 *     one of the twelve is runnable the moment it is published. The owner can
 *     change a template to per-cold-room in the builder once the equipment
 *     register has rows.
 *   · **No `photo_rule: 'always'` on a non-photo question.** That rule makes an
 *     answer INCOMPLETE until a photograph exists (fssai.ts
 *     `withFssaiEvidenceRules`), so it would demand a camera on every passing
 *     shift. Evidence is demanded `on_fail`, where it is actually worth having,
 *     and each checklist carries one OPTIONAL photo question for "anything you
 *     were not happy with" (`is_required: 0`, which the submit gate does not
 *     block on — runs/route.ts:713).
 */

import {
  normalizeFssaiQuestion,
  isFssaiFrequency,
  isFssaiTargetKind,
  FSSAI_MODULE_KEYS,
  type FssaiQuestionInput,
  type FssaiQuestionNormalized,
} from './fssai';

/* ------------------------------------------------------------------ *
 * 1. THE SHAPE
 * ------------------------------------------------------------------ */

/**
 * One question in the pack. It is the engine's own input type plus the section
 * it belongs to — so this file cannot carry a field `fssai_questions` has no
 * column for, and `normalizeFssaiQuestion` is the only validator in play.
 */
export interface PackQuestion extends FssaiQuestionInput {
  /** Stable key, unique inside its template (uq_fssai_questions_code). */
  code: string;
  /** The `code` of the section this sits in. '' = ungrouped. */
  section: string;
}

export interface PackSection {
  /** Stable key, unique inside its template (uq_fssai_sections_code). */
  code: string;
  title: string;
  description?: string;
}

/**
 * One checklist. Every field maps to a real `fssai_templates` column — there is
 * no pack-only metadata, because a field with nowhere to land is a field that
 * silently disappears at seed time.
 */
export interface PackTemplate {
  /** Stable machine key — uq_fssai_templates_code(outlet_id, code). */
  code: string;
  name: string;
  /** Shown under the name. Carries the clause this came from, in words. */
  description: string;
  /** One of FSSAI_MODULE_KEYS — which food-safety screen owns it. */
  module_key: string;
  frequency: string;
  target_kind: string;
  category?: string;
  requires_signature?: 0 | 1;
  requires_verification?: 0 | 1;
  allow_backdate_days?: number;
  pass_threshold_pct?: number;
  sort_order: number;
  sections: PackSection[];
  questions: PackQuestion[];
}

export interface ChecklistPack {
  /** fssai_seed_log.pack_key. */
  key: string;
  /** fssai_seed_log.pack_version. Bump to ship a revised pack. */
  version: number;
  /** One line the admin reads before pressing the button. */
  title: string;
  templates: PackTemplate[];
}

/* ------------------------------------------------------------------ *
 * 2. SHORTHAND — so the twelve read like checklists, not like SQL
 * ------------------------------------------------------------------ */

/** Pass/Fail. `crit` marks the ones a single failure fails the whole round on. */
function pf(
  section: string,
  code: string,
  prompt: string,
  opts: Partial<PackQuestion> & { crit?: boolean } = {},
): PackQuestion {
  const { crit, ...rest } = opts;
  return {
    section, code, qtype: 'pass_fail', prompt, expected_value: 'pass',
    ...(crit ? { is_critical: 1, raise_ca_on_fail: 1, ca_severity: 'high', photo_rule: 'on_fail', note_rule: 'on_fail' } : {}),
    ...rest,
  };
}

/** Yes/No, where "yes" is the answer that passes unless told otherwise. */
function yn(
  section: string,
  code: string,
  prompt: string,
  opts: Partial<PackQuestion> & { crit?: boolean } = {},
): PackQuestion {
  const { crit, ...rest } = opts;
  return {
    section, code, qtype: 'yes_no', prompt, expected_value: 'yes',
    ...(crit ? { is_critical: 1, raise_ca_on_fail: 1, ca_severity: 'high', photo_rule: 'on_fail', note_rule: 'on_fail' } : {}),
    ...rest,
  };
}

/** A temperature with a safe range. min/max null = no bound on that side. */
function temp(
  section: string,
  code: string,
  prompt: string,
  min: number | null,
  max: number | null,
  opts: Partial<PackQuestion> & { crit?: boolean } = {},
): PackQuestion {
  const { crit, ...rest } = opts;
  return {
    section, code, qtype: 'temperature', prompt,
    min_value: min, max_value: max, uom: 'C', decimals: 1,
    ...(crit ? { is_critical: 1, raise_ca_on_fail: 1, ca_severity: 'high', photo_rule: 'on_fail', note_rule: 'on_fail' } : {}),
    ...rest,
  };
}

/** A plain number with a unit and an optional range. */
function num(
  section: string,
  code: string,
  prompt: string,
  uom: string,
  min: number | null,
  max: number | null,
  opts: Partial<PackQuestion> = {},
): PackQuestion {
  return { section, code, qtype: 'numeric', prompt, uom, min_value: min, max_value: max, decimals: 0, ...opts };
}

/** A list of answers, with the ones that count as a failure named. */
function choice(
  section: string,
  code: string,
  prompt: string,
  options: string[],
  fail_options: string[],
  opts: Partial<PackQuestion> = {},
): PackQuestion {
  return { section, code, qtype: 'multiple_choice', prompt, options, fail_options, ...opts };
}

/** Free text. Words never fail on their own — a text answer is a record. */
function words(section: string, code: string, prompt: string, opts: Partial<PackQuestion> = {}): PackQuestion {
  return { section, code, qtype: 'text', prompt, is_required: 0, ...opts };
}

/**
 * The optional "show me" question every one of the twelve ends with.
 *
 * `is_required: 0` is load-bearing: the submit gate blocks only on required
 * questions (runs/route.ts:713), so this invites a photograph without making a
 * camera a condition of filing a clean round.
 */
function optionalPhoto(section: string, code: string, prompt: string): PackQuestion {
  return { section, code, qtype: 'photo', prompt, is_required: 0, allow_na: 1 };
}

/* ------------------------------------------------------------------ *
 * 3. THE TWELVE
 * ------------------------------------------------------------------ */

const T_FQ_PRESERVICE: PackTemplate = {
  code: 'CHK-FQ-PRESERVICE',
  name: 'Food Quality — Pre-Service Check',
  description:
    'Taste, smell, look and texture of what is about to go out, plus the counter temperatures at the pass. ' +
    'Run once per shift before service starts. FSSAI Schedule 4 Part V — food handling and service.',
  module_key: 'food-quality',
  frequency: 'per_shift',
  target_kind: 'none',
  sort_order: 10,
  sections: [
    { code: 'SENSORY', title: 'Look, smell, taste, texture', description: 'Judged on the prepared items, before anything is plated for a guest.' },
    { code: 'COUNTER', title: 'Temperatures at the pass', description: 'Hot food stays hot and cold food stays cold, or it does not go out.' },
    { code: 'PRACTICE', title: 'How it was handled' },
    { code: 'REMARKS', title: 'Anything else' },
  ],
  questions: [
    pf('SENSORY', 'Q01', 'Appearance of each prepared dish — colour, garnish and plating as the standard recipe'),
    pf('SENSORY', 'Q02', 'Smell of each prepared item — nothing sour, musty, rancid or "off"', { crit: true, ca_severity: 'urgent' }),
    pf('SENSORY', 'Q03', 'Taste of each prepared item, tasted with a clean spoon that is not put back', { crit: true, ca_severity: 'urgent' }),
    choice('SENSORY', 'Q04', 'Texture of the main preparations',
      ['As it should be', 'Slightly off — usable', 'Clearly wrong'], ['Clearly wrong'],
      { note_rule: 'on_fail', raise_ca_on_fail: 1, ca_severity: 'medium' }),
    temp('COUNTER', 'Q05', 'Hot holding temperature at the pass', 65, null,
      { crit: true, help_text: 'Hot food must be held at 65 °C or above. Probe the thickest part, not the surface.' }),
    temp('COUNTER', 'Q06', 'Cold counter / salad section temperature', null, 5,
      { crit: true, help_text: 'Cold food must be held at 5 °C or below.' }),
    temp('COUNTER', 'Q07', 'Core temperature of the last item cooked from raw', 75, null,
      { crit: true, help_text: 'Cook to a core of 75 °C or above. Probe the centre of the thickest piece.' }),
    yn('PRACTICE', 'Q08', 'Separate boards, knives and gloves used for raw and for ready-to-eat food', { crit: true }),
    yn('PRACTICE', 'Q09', 'Every tasting spoon used once and sent to the wash-up'),
    yn('PRACTICE', 'Q10', 'Nothing prepared more than two hours ago still sitting out at room temperature', { crit: true }),
    words('REMARKS', 'Q11', 'Anything rejected, remade or held back this shift — what and why'),
    optionalPhoto('REMARKS', 'Q12', 'Photograph of anything you were not happy with'),
  ],
};

const T_FQ_HOLDING: PackTemplate = {
  code: 'CHK-FQ-HOLDING',
  name: 'Food Quality — Cooked & Held Food',
  description:
    'The food already cooked and waiting: how long it has been held, whether it was reheated properly, and what is being thrown. ' +
    'Run at the middle and the end of service. FSSAI Schedule 4 Part V — time and temperature control.',
  module_key: 'food-quality',
  frequency: 'twice_daily',
  target_kind: 'none',
  sort_order: 20,
  sections: [
    { code: 'HOLD', title: 'Food being held' },
    { code: 'REHEAT', title: 'Anything reheated' },
    { code: 'DISPOSE', title: 'What is being thrown' },
  ],
  questions: [
    yn('HOLD', 'Q01', 'Every tray of cooked food is labelled with the time it came off the heat', { crit: true }),
    temp('HOLD', 'Q02', 'Lowest hot-holding reading across all trays', 65, null, { crit: true }),
    num('HOLD', 'Q03', 'Longest time any cooked item has been held', 'hours', null, 4,
      { decimals: 1, is_critical: 1, raise_ca_on_fail: 1, ca_severity: 'high', note_rule: 'on_fail',
        help_text: 'Cooked food held hot for more than four hours is discarded, not re-served.' }),
    yn('HOLD', 'Q04', 'Nothing topped up on top of older food in the same tray', { crit: true }),
    choice('REHEAT', 'Q05', 'Was anything reheated this service?', ['No', 'Yes — once', 'Yes — more than once'], ['Yes — more than once'],
      { note_rule: 'on_fail', raise_ca_on_fail: 1, ca_severity: 'high',
        help_text: 'Food is reheated once only. A second reheat is a discard.' }),
    temp('REHEAT', 'Q06', 'Core temperature reached on reheating', 75, null,
      { crit: true, allow_na: 1, help_text: 'Mark not-applicable if nothing was reheated. Otherwise 75 °C or above throughout.' }),
    words('DISPOSE', 'Q07', 'What was discarded and why', { note_rule: 'never' }),
    num('DISPOSE', 'Q08', 'Approximate quantity discarded', 'kg', null, null, { decimals: 2, is_required: 0 }),
    optionalPhoto('DISPOSE', 'Q09', 'Photograph of what is being thrown'),
  ],
};

const T_CLEAN_KITCHEN_DAILY: PackTemplate = {
  code: 'CHK-CLEAN-KITCHEN-DAILY',
  name: 'Kitchen Cleaning — Daily',
  description:
    'The end-of-day clean, signed by whoever did the work: surfaces, equipment, floors, drains and bins. ' +
    'FSSAI Schedule 4 Part II — cleaning and sanitation schedule.',
  module_key: 'cleaning',
  frequency: 'daily',
  target_kind: 'none',
  sort_order: 30,
  sections: [
    { code: 'SURFACES', title: 'Surfaces and equipment' },
    { code: 'FLOORS', title: 'Floors, drains and waste' },
    { code: 'CHEMICAL', title: 'Cleaning chemicals' },
    { code: 'SIGNOFF', title: 'Sign-off' },
  ],
  questions: [
    pf('SURFACES', 'Q01', 'Work tables, counters and shelves cleaned and sanitised'),
    pf('SURFACES', 'Q02', 'Chopping boards washed, sanitised and stored upright, not stacked wet'),
    pf('SURFACES', 'Q03', 'Range, griddle and burners degreased'),
    pf('SURFACES', 'Q04', 'Extraction hood filters cleaned or changed', { allow_na: 1, help_text: 'Mark not-applicable on a day the filters are not due.' }),
    pf('SURFACES', 'Q05', 'Fridge and freezer handles, seals and interiors wiped'),
    pf('SURFACES', 'Q06', 'Can opener, slicer, mixer and blender stripped and cleaned', { crit: true, ca_severity: 'medium' }),
    pf('FLOORS', 'Q07', 'Floors swept and mopped, including under equipment'),
    pf('FLOORS', 'Q08', 'Drains and grease traps cleared — no standing water, no smell', { crit: true, ca_severity: 'medium' }),
    pf('FLOORS', 'Q09', 'Bins emptied, washed and relined; lids closing properly'),
    yn('FLOORS', 'Q10', 'Waste area cleared and nothing left out overnight', { crit: true, ca_severity: 'medium' }),
    num('CHEMICAL', 'Q11', 'Sanitiser strength on food-contact surfaces', 'ppm', 50, 100,
      { is_critical: 1, raise_ca_on_fail: 1, ca_severity: 'high', note_rule: 'on_fail',
        help_text: 'Chlorine sanitiser for food-contact surfaces: 50–100 ppm. Use a test strip, not a guess.' }),
    yn('CHEMICAL', 'Q12', 'Chemicals stored away from food, labelled, in their own containers', { crit: true }),
    temp('CHEMICAL', 'Q13', 'Dishwasher final rinse temperature', 82, null,
      { allow_na: 1, raise_ca_on_fail: 1, ca_severity: 'medium',
        help_text: 'Final rinse 82 °C or above. Mark not-applicable where washing is by hand.' }),
    words('SIGNOFF', 'Q14', 'Anything left for the morning team'),
    optionalPhoto('SIGNOFF', 'Q15', 'Photograph of the kitchen as you left it'),
  ],
};

const T_CLEAN_WASHROOM: PackTemplate = {
  code: 'CHK-CLEAN-WASHROOM',
  name: 'Washrooms & Guest Areas — Cleaning Round',
  description:
    'The round a guest notices: washrooms stocked and clean, dining area and service stations wiped down. ' +
    'Run at least twice a day. FSSAI Schedule 4 Part II — premises and sanitary facilities.',
  module_key: 'cleaning',
  frequency: 'twice_daily',
  target_kind: 'none',
  sort_order: 40,
  sections: [
    { code: 'WASHROOM', title: 'Washrooms' },
    { code: 'GUEST', title: 'Dining and service areas' },
  ],
  questions: [
    pf('WASHROOM', 'Q01', 'Pans, urinals and seats cleaned and disinfected'),
    pf('WASHROOM', 'Q02', 'Wash basins, taps and mirrors cleaned'),
    yn('WASHROOM', 'Q03', 'Soap available at every basin', { crit: true, ca_severity: 'medium' }),
    yn('WASHROOM', 'Q04', 'Hand drying available — paper or working dryer', { crit: true, ca_severity: 'medium' }),
    yn('WASHROOM', 'Q05', 'Running water at every tap', { crit: true }),
    pf('WASHROOM', 'Q06', 'Floor dry, no standing water, drain clear'),
    pf('WASHROOM', 'Q07', 'Bins emptied and lids working'),
    yn('WASHROOM', 'Q08', 'Hand-washing notice on the wall and readable'),
    pf('GUEST', 'Q09', 'Tables, chairs and high chairs wiped'),
    pf('GUEST', 'Q10', 'Service station, cutlery trays and water jugs clean'),
    pf('GUEST', 'Q11', 'No pests, droppings or webbing anywhere in the guest area', { crit: true, ca_severity: 'urgent' }),
    words('GUEST', 'Q12', 'Anything that needs a repair rather than a clean'),
    optionalPhoto('GUEST', 'Q13', 'Photograph of anything that needs attention'),
  ],
};

const T_CLEAN_DEEP_WEEKLY: PackTemplate = {
  code: 'CHK-CLEAN-DEEP-WEEKLY',
  name: 'Deep Cleaning — Weekly',
  description:
    'The weekly clean behind and underneath: equipment pulled out, cold rooms emptied and scrubbed, ducts and ' +
    'high-level surfaces done. FSSAI Schedule 4 Part II — documented cleaning schedule.',
  module_key: 'cleaning',
  frequency: 'weekly',
  target_kind: 'none',
  sort_order: 50,
  sections: [
    { code: 'BEHIND', title: 'Behind and underneath' },
    { code: 'COLD', title: 'Cold rooms and stores' },
    { code: 'HIGH', title: 'High level' },
  ],
  questions: [
    pf('BEHIND', 'Q01', 'Equipment moved out and the floor and wall behind it cleaned'),
    pf('BEHIND', 'Q02', 'Under-counter fridges pulled out, coils and trays cleaned'),
    pf('BEHIND', 'Q03', 'Grease trap opened, emptied and flushed', { crit: true, ca_severity: 'medium' }),
    pf('COLD', 'Q04', 'Cold rooms emptied, shelves washed, floor scrubbed and dried'),
    pf('COLD', 'Q05', 'Freezer defrosted or ice build-up cleared', { allow_na: 1 }),
    pf('COLD', 'Q06', 'Dry store shelves emptied in sections, wiped and restocked'),
    yn('COLD', 'Q07', 'Anything out of date or unlabelled found and removed', { expected_value: 'no', note_rule: 'on_fail', raise_ca_on_fail: 1, ca_severity: 'medium', help_text: 'Answer "no" if you found nothing. A "yes" records that something was pulled out.' }),
    pf('HIGH', 'Q08', 'Extraction ducts and canopy cleaned down'),
    pf('HIGH', 'Q09', 'Light fittings, fly screens and ceiling fans cleaned'),
    pf('HIGH', 'Q10', 'Walls and tiles above working height washed'),
    words('HIGH', 'Q11', 'Who did the work, and anything carried over to next week'),
    optionalPhoto('HIGH', 'Q12', 'Photograph of the finished deep clean'),
  ],
};

const T_HYG_SHIFT: PackTemplate = {
  code: 'CHK-HYG-SHIFT',
  name: 'Personal Hygiene — Start of Shift',
  description:
    'The check every food handler files on themselves before starting: uniform, hands, nails, hair, jewellery and health. ' +
    'FSSAI Schedule 4 Part II — personal hygiene of food handlers.',
  module_key: 'hygiene',
  frequency: 'per_shift',
  // 'person' is the one non-'none' target the runner can resolve without a
  // register: it fills the target from the signed-in account, so each member of
  // staff files their own round with no special case in the slot rule.
  target_kind: 'person',
  // A hygiene check describes the person at the start of THIS shift. It cannot
  // honestly be written up two days later, so backdating is off.
  allow_backdate_days: 0,
  sort_order: 60,
  sections: [
    { code: 'FIT', title: 'Fit to handle food' },
    { code: 'TURNOUT', title: 'Uniform and turnout' },
    { code: 'HANDS', title: 'Hands' },
  ],
  questions: [
    yn('FIT', 'Q01', 'Free of fever, cough, cold, sore throat or any skin infection', { crit: true, ca_severity: 'urgent', help_text: 'Anyone unwell does not handle food. Report it and be reassigned.' }),
    yn('FIT', 'Q02', 'No vomiting or loose motions in the last 48 hours', { crit: true, ca_severity: 'urgent' }),
    yn('FIT', 'Q03', 'Any cut or wound is covered with a coloured waterproof dressing', { crit: true, allow_na: 1, help_text: 'Mark not-applicable if you have no cut or wound.' }),
    pf('TURNOUT', 'Q04', 'Clean uniform or apron, changed today'),
    yn('TURNOUT', 'Q05', 'Hair fully covered — cap or hairnet on', { crit: true, ca_severity: 'medium' }),
    yn('TURNOUT', 'Q06', 'No watch, rings, bangles, chains or earrings', { crit: true, ca_severity: 'medium' }),
    pf('TURNOUT', 'Q07', 'Closed, non-slip footwear, clean'),
    yn('TURNOUT', 'Q08', 'Beard covered or clean-shaven as the section requires', { allow_na: 1 }),
    yn('HANDS', 'Q09', 'Nails short, clean and unvarnished', { crit: true, ca_severity: 'medium' }),
    yn('HANDS', 'Q10', 'Hands washed with soap for 20 seconds before starting', { crit: true }),
    yn('HANDS', 'Q11', 'No eating, chewing, smoking or spitting in the food area', { crit: true, ca_severity: 'high' }),
    words('HANDS', 'Q12', 'Anything the supervisor should know'),
  ],
};

const T_HYG_HEALTH_MONTHLY: PackTemplate = {
  code: 'CHK-HYG-HEALTH-MONTHLY',
  name: 'Food Handler Health & Fitness Declaration',
  description:
    'The monthly declaration each food handler signs, with their medical and training records confirmed. ' +
    'FSSAI Schedule 4 Part II — medical fitness and food-safety training records.',
  module_key: 'hygiene',
  frequency: 'monthly',
  target_kind: 'person',
  sort_order: 70,
  sections: [
    { code: 'HEALTH', title: 'Health' },
    { code: 'RECORDS', title: 'Records held for this person' },
    { code: 'DECLARE', title: 'Declaration' },
  ],
  questions: [
    yn('HEALTH', 'Q01', 'No illness in the last month that should have kept you off food handling', { crit: true, ca_severity: 'high' }),
    yn('HEALTH', 'Q02', 'No skin disease, boils, sores or discharging ear, eye or nose', { crit: true, ca_severity: 'high' }),
    choice('HEALTH', 'Q03', 'Days absent for illness this month', ['None', '1–2 days', '3 or more days'], [],
      { note_rule: 'never', help_text: 'Recorded, not judged — three or more days is worth a note, not a failure.' }),
    yn('RECORDS', 'Q04', 'Medical fitness certificate on file and not expired', { crit: true, ca_severity: 'high', help_text: 'The certificate itself is filed under Documents & Certificates.' }),
    yn('RECORDS', 'Q05', 'Typhoid vaccination record on file', { allow_na: 1 }),
    yn('RECORDS', 'Q06', 'Food-safety training (FoSTaC or in-house) completed and recorded'),
    words('DECLARE', 'Q07', 'Anything about your health that affects food handling'),
    {
      section: 'DECLARE', code: 'Q08', qtype: 'signature',
      prompt: 'Type your full name to declare that the answers above are true',
      help_text: 'Your account and the time are recorded with it.',
    },
  ],
};

const T_STORE_DRY_DAILY: PackTemplate = {
  code: 'CHK-STORE-DRY-DAILY',
  name: 'Dry Store — Daily Check',
  description:
    'The dry store walked daily: nothing on the floor, everything covered, labelled and dated, oldest at the front. ' +
    'FSSAI Schedule 4 Part II — storage of raw materials and food.',
  module_key: 'storage',
  frequency: 'daily',
  target_kind: 'none',
  sort_order: 80,
  sections: [
    { code: 'ORDER', title: 'Order and rotation' },
    { code: 'CONDITION', title: 'Condition of the store' },
  ],
  questions: [
    yn('ORDER', 'Q01', 'Nothing stored directly on the floor — everything on a pallet or a shelf', { crit: true, ca_severity: 'medium' }),
    yn('ORDER', 'Q02', 'Oldest stock at the front, newest behind it'),
    yn('ORDER', 'Q03', 'Every opened container covered, labelled and dated', { crit: true, ca_severity: 'medium' }),
    pf('ORDER', 'Q04', 'Nothing past its use-by or best-before date on the shelves', { crit: true, ca_severity: 'high' }),
    yn('ORDER', 'Q05', 'Non-food items and chemicals stored separately, never above food', { crit: true }),
    pf('CONDITION', 'Q06', 'Shelves, floor and corners clean and dust-free'),
    pf('CONDITION', 'Q07', 'No sign of pests — droppings, gnawing, webbing or insects', { crit: true, ca_severity: 'urgent' }),
    pf('CONDITION', 'Q08', 'No damp patch, leak or water stain'),
    temp('CONDITION', 'Q09', 'Dry store temperature', null, 25, { raise_ca_on_fail: 1, ca_severity: 'medium', help_text: 'A dry store should stay cool and ventilated — 25 °C or below.' }),
    yn('CONDITION', 'Q10', 'Any damaged, swollen, rusted or leaking pack found and set aside', { expected_value: 'no', note_rule: 'on_fail', raise_ca_on_fail: 1, ca_severity: 'medium', help_text: 'Answer "no" if you found nothing. A "yes" records that something was pulled out.' }),
    words('CONDITION', 'Q11', 'Anything set aside, and what you did with it'),
    optionalPhoto('CONDITION', 'Q12', 'Photograph of anything you were not happy with'),
  ],
};

const T_STORE_COLD_DAILY: PackTemplate = {
  code: 'CHK-STORE-COLD-DAILY',
  name: 'Cold Storage — Segregation, Cover & Label',
  description:
    'What is INSIDE the cold rooms and fridges: raw apart from cooked, covered, labelled, dated, nothing on the floor. ' +
    'The temperature of each unit is logged separately under Temperature Logs. FSSAI Schedule 4 Part II.',
  module_key: 'storage',
  frequency: 'daily',
  target_kind: 'none',
  sort_order: 90,
  sections: [
    { code: 'SEGREGATE', title: 'Keeping things apart' },
    { code: 'COVER', title: 'Covered, labelled, dated' },
    { code: 'UNIT', title: 'The units themselves' },
  ],
  questions: [
    yn('SEGREGATE', 'Q01', 'Raw meat, poultry and fish stored below and apart from ready-to-eat food', { crit: true, ca_severity: 'urgent' }),
    yn('SEGREGATE', 'Q02', 'Cooked food never stored below raw food', { crit: true, ca_severity: 'urgent' }),
    yn('SEGREGATE', 'Q03', 'Dairy, vegetables and prepared food each in their own place'),
    yn('SEGREGATE', 'Q04', 'Nothing stored on the cold room floor', { crit: true, ca_severity: 'medium' }),
    yn('COVER', 'Q05', 'Every container covered or wrapped', { crit: true, ca_severity: 'medium' }),
    yn('COVER', 'Q06', 'Every container labelled with what it is and the date it went in', { crit: true, ca_severity: 'medium' }),
    pf('COVER', 'Q07', 'Nothing past its date and nothing unidentifiable', { crit: true, ca_severity: 'high' }),
    yn('COVER', 'Q08', 'Prepared food used within its own shelf life, oldest first'),
    pf('UNIT', 'Q09', 'Doors closing properly, seals intact, no ice build-up on the seal'),
    pf('UNIT', 'Q10', 'Interiors clean — no spills, no blood, no standing water'),
    yn('UNIT', 'Q11', 'A working thermometer readable from outside each unit', { crit: true, ca_severity: 'medium' }),
    temp('UNIT', 'Q12', 'Coldest chiller reading seen on this round', null, 5, { raise_ca_on_fail: 1, ca_severity: 'high', help_text: 'A chiller runs at 0–5 °C. Record the warmest you saw if any unit is drifting; the full log is under Temperature Logs.' }),
    temp('UNIT', 'Q13', 'Freezer reading seen on this round', null, -18, { raise_ca_on_fail: 1, ca_severity: 'high', allow_na: 1, help_text: 'A freezer runs at −18 °C or colder. Mark not-applicable if there is no freezer on this round.' }),
    words('UNIT', 'Q14', 'Anything thrown, moved or reported'),
    optionalPhoto('UNIT', 'Q15', 'Photograph of anything you were not happy with'),
  ],
};

const T_STORE_WEEKLY: PackTemplate = {
  code: 'CHK-STORE-WEEKLY',
  name: 'Storage Discipline — Weekly Audit',
  description:
    'A harder look once a week: stock rotation actually working, shelf-life rules being followed, and the store ' +
    'in a condition an inspector would accept. FSSAI Schedule 4 Part II.',
  module_key: 'storage',
  frequency: 'weekly',
  target_kind: 'none',
  sort_order: 100,
  sections: [
    { code: 'ROTATION', title: 'Rotation and shelf life' },
    { code: 'FABRIC', title: 'The fabric of the store' },
    { code: 'COUNT', title: 'What the audit found' },
  ],
  questions: [
    pf('ROTATION', 'Q01', 'First-in first-out visibly working — nothing old hidden behind new'),
    pf('ROTATION', 'Q02', 'Opened-pack shelf lives being applied, not just the pack date', { crit: true, ca_severity: 'medium' }),
    pf('ROTATION', 'Q03', 'Decanted items carry the original pack information'),
    yn('ROTATION', 'Q04', 'Frozen food thawed in a chiller, never on the counter', { crit: true, ca_severity: 'high' }),
    yn('ROTATION', 'Q05', 'Nothing refrozen after thawing', { crit: true, ca_severity: 'urgent' }),
    pf('FABRIC', 'Q06', 'Walls, floor and ceiling sound — no flaking paint, no cracks, no gaps'),
    pf('FABRIC', 'Q07', 'Windows screened, doors closing, no gap under a door', { crit: true, ca_severity: 'medium' }),
    pf('FABRIC', 'Q08', 'Lighting adequate and fittings covered'),
    pf('FABRIC', 'Q09', 'Ventilation working, no condensation on the ceiling'),
    num('COUNT', 'Q10', 'Items removed from the store this week as out of date or unfit', 'items', null, null, { is_required: 0 }),
    num('COUNT', 'Q11', 'Items found unlabelled or undated', 'items', null, null, { is_required: 0 }),
    words('COUNT', 'Q12', 'What is being fixed, by whom, by when'),
    optionalPhoto('COUNT', 'Q13', 'Photograph of the audit finding'),
  ],
};

const T_SAFE_OPENING: PackTemplate = {
  code: 'CHK-SAFE-OPENING',
  name: 'Kitchen Safety — Opening Check',
  description:
    'The walk before the kitchen starts: gas, electricals, extraction, floors, guards and the first-aid point. ' +
    'FSSAI Schedule 4 Part II — equipment and premises safety.',
  module_key: 'kitchen-safety',
  frequency: 'daily',
  target_kind: 'none',
  sort_order: 110,
  sections: [
    { code: 'GAS', title: 'Gas and fire' },
    { code: 'POWER', title: 'Electricals and equipment' },
    { code: 'FLOOR', title: 'Floors and access' },
    { code: 'READY', title: 'Ready for an emergency' },
  ],
  questions: [
    pf('GAS', 'Q01', 'No smell of gas anywhere in the kitchen', { crit: true, ca_severity: 'urgent' }),
    pf('GAS', 'Q02', 'Gas pipes, hoses and regulators sound — no cracks, no perishing', { crit: true, ca_severity: 'urgent' }),
    yn('GAS', 'Q03', 'Cylinders upright, chained, stored away from heat', { crit: true, ca_severity: 'high' }),
    yn('GAS', 'Q04', 'Everyone on shift knows where the gas shut-off valve is', { crit: true, ca_severity: 'high' }),
    pf('GAS', 'Q05', 'Extraction hood running and grease filters not clogged', { crit: true, ca_severity: 'medium' }),
    pf('POWER', 'Q06', 'No exposed wire, taped joint or cracked socket', { crit: true, ca_severity: 'urgent' }),
    pf('POWER', 'Q07', 'No equipment plugged in with a wet hand or over a wet surface', { crit: true, ca_severity: 'high' }),
    pf('POWER', 'Q08', 'Guards and covers on the slicer, mixer and grinder in place', { crit: true, ca_severity: 'high' }),
    pf('POWER', 'Q09', 'Knives sharp, stored in a rack or a roll, not loose in a drawer'),
    pf('FLOOR', 'Q10', 'Floor dry, no oil or water, no trip hazard', { crit: true, ca_severity: 'medium' }),
    yn('FLOOR', 'Q11', 'Fire exit and gangway clear', { crit: true, ca_severity: 'urgent' }),
    yn('READY', 'Q12', 'Fire extinguishers and fire blanket in place and unobstructed', { crit: true, ca_severity: 'high' }),
    yn('READY', 'Q13', 'First-aid box present, stocked and in date', { crit: true, ca_severity: 'medium' }),
    words('READY', 'Q14', 'Anything reported for repair'),
    optionalPhoto('READY', 'Q15', 'Photograph of anything unsafe'),
  ],
};

const T_SAFE_MONTHLY: PackTemplate = {
  code: 'CHK-SAFE-MONTHLY',
  name: 'Fire, First Aid & Equipment Safety — Monthly',
  description:
    'The monthly safety audit: extinguisher servicing, suppression system, electrical testing, equipment ' +
    'servicing and staff drilled. FSSAI Schedule 4 Part II — maintenance and training records.',
  module_key: 'kitchen-safety',
  frequency: 'monthly',
  target_kind: 'none',
  sort_order: 120,
  sections: [
    { code: 'FIRE', title: 'Fire' },
    { code: 'EQUIP', title: 'Equipment and services' },
    { code: 'PEOPLE', title: 'People' },
  ],
  questions: [
    yn('FIRE', 'Q01', 'Every extinguisher within its service date', { crit: true, ca_severity: 'high', help_text: 'The service certificate is filed under Documents & Certificates.' }),
    num('FIRE', 'Q02', 'Number of extinguishers checked this month', 'units', 1, null, { raise_ca_on_fail: 1, ca_severity: 'medium' }),
    yn('FIRE', 'Q03', 'Hood suppression system serviced and in date', { allow_na: 1, crit: true, ca_severity: 'high' }),
    yn('FIRE', 'Q04', 'Smoke and heat detectors tested', { allow_na: 1 }),
    yn('FIRE', 'Q05', 'Emergency lighting and exit signs working'),
    pf('EQUIP', 'Q06', 'Electrical installation test certificate current', { crit: true, ca_severity: 'high' }),
    pf('EQUIP', 'Q07', 'Earthing and residual current device tested'),
    pf('EQUIP', 'Q08', 'Gas installation inspected by a competent person', { crit: true, ca_severity: 'high' }),
    pf('EQUIP', 'Q09', 'Cold rooms, fryers and ovens serviced to schedule'),
    yn('EQUIP', 'Q10', 'Thermometers and probes calibrated and the result recorded', { crit: true, ca_severity: 'medium' }),
    yn('PEOPLE', 'Q11', 'Fire drill or evacuation briefing done this month', { raise_ca_on_fail: 1, ca_severity: 'medium' }),
    yn('PEOPLE', 'Q12', 'Everyone on shift knows who the first-aiders are'),
    num('PEOPLE', 'Q13', 'Accidents or near misses recorded this month', 'incidents', null, null, { is_required: 0 }),
    words('PEOPLE', 'Q14', 'What is outstanding, who owns it, by when'),
    optionalPhoto('PEOPLE', 'Q15', 'Photograph of a certificate, a label or a defect'),
  ],
};

/* ------------------------------------------------------------------ *
 * 4. THE PACK
 * ------------------------------------------------------------------ */

/**
 * pack_key / pack_version are what `uq_fssai_seed_item` makes unique, and the
 * marker row keyed on them is what stops a second apply (and stops a cold start
 * resurrecting a checklist the owner retired). Bumping `version` ships a new
 * pack that may run once more; it NEVER rewrites what the first one created,
 * because the owner may have edited it since.
 */
export const FSSAI_CHECKLIST_PACK: ChecklistPack = {
  key: 'fssai.checklists',
  version: 1,
  title: 'Twelve ready-made FSSAI checklists',
  templates: [
    T_FQ_PRESERVICE,
    T_FQ_HOLDING,
    T_CLEAN_KITCHEN_DAILY,
    T_CLEAN_WASHROOM,
    T_CLEAN_DEEP_WEEKLY,
    T_HYG_SHIFT,
    T_HYG_HEALTH_MONTHLY,
    T_STORE_DRY_DAILY,
    T_STORE_COLD_DAILY,
    T_STORE_WEEKLY,
    T_SAFE_OPENING,
    T_SAFE_MONTHLY,
  ],
};

/* ------------------------------------------------------------------ *
 * 5. THE VALIDATOR — R1's mitigation, as a function and not a promise
 * ------------------------------------------------------------------ */

export interface PackProblem {
  template_code: string;
  item: string;
  problem: string;
}

export interface ValidatedPackQuestion {
  code: string;
  section: string;
  value: FssaiQuestionNormalized;
}

export interface ValidatedPackTemplate {
  template: PackTemplate;
  questions: ValidatedPackQuestion[];
}

export interface PackValidation {
  ok: boolean;
  problems: PackProblem[];
  templates: ValidatedPackTemplate[];
  counts: { templates: number; sections: number; questions: number };
}

/**
 * Push the whole pack through the engine's own rules and report anything this
 * build cannot render. Called by the seed route BEFORE it opens a transaction,
 * by the admin screen's GET so the owner sees a problem before pressing the
 * button, and by the P8 probe.
 *
 * It checks the things a seed uniquely gets wrong:
 *   · a question type, range, option list or evidence rule the engine refuses
 *     (delegated to normalizeFssaiQuestion — the builder's own validator);
 *   · a frequency, target kind or module key outside the vocabulary;
 *   · a duplicate template / section / question code, which `uq_fssai_*_code`
 *     would throw on halfway through the seed;
 *   · a question pointing at a section that is not in its template;
 *   · a `photo_rule: 'always'` on a REQUIRED non-photo question, which would
 *     make the round unsubmittable without a camera.
 */
export function validateFssaiChecklistPack(pack: ChecklistPack = FSSAI_CHECKLIST_PACK): PackValidation {
  const problems: PackProblem[] = [];
  const templates: ValidatedPackTemplate[] = [];
  const seenTemplateCodes = new Set<string>();
  let sectionCount = 0;
  let questionCount = 0;

  for (const t of pack.templates) {
    const where = t.code || '(no code)';
    if (!t.code) problems.push({ template_code: where, item: 'template', problem: 'A seeded checklist must have a code — it is the key the seed is idempotent on.' });
    if (seenTemplateCodes.has(t.code)) {
      problems.push({ template_code: where, item: 'template', problem: 'Two checklists in the pack share this code. uq_fssai_templates_code would refuse the second.' });
    }
    seenTemplateCodes.add(t.code);
    if (!t.name) problems.push({ template_code: where, item: 'template', problem: 'A checklist needs a name.' });
    if (!isFssaiFrequency(t.frequency)) problems.push({ template_code: where, item: 'template', problem: `"${t.frequency}" is not a frequency this engine knows.` });
    if (!isFssaiTargetKind(t.target_kind)) problems.push({ template_code: where, item: 'template', problem: `"${t.target_kind}" is not something a check can be run against.` });
    if (t.module_key && !FSSAI_MODULE_KEYS.includes(t.module_key)) {
      problems.push({ template_code: where, item: 'template', problem: `"${t.module_key}" is not one of the food-safety areas.` });
    }

    const sectionCodes = new Set<string>();
    for (const s of t.sections) {
      sectionCount++;
      if (!s.code) problems.push({ template_code: where, item: `section ${s.title}`, problem: 'A seeded section needs a code.' });
      if (sectionCodes.has(s.code)) {
        problems.push({ template_code: where, item: `section ${s.code}`, problem: 'Two sections share this code. uq_fssai_sections_code would refuse the second.' });
      }
      sectionCodes.add(s.code);
      if (!s.title) problems.push({ template_code: where, item: `section ${s.code}`, problem: 'A section needs a title.' });
    }

    const questionCodes = new Set<string>();
    const validated: ValidatedPackQuestion[] = [];
    for (const q of t.questions) {
      questionCount++;
      const item = `question ${q.code || '(no code)'}`;
      if (!q.code) problems.push({ template_code: where, item, problem: 'A seeded question needs a code.' });
      if (questionCodes.has(q.code)) {
        problems.push({ template_code: where, item, problem: 'Two questions share this code. uq_fssai_questions_code would refuse the second.' });
      }
      questionCodes.add(q.code);
      if (q.section && !sectionCodes.has(q.section)) {
        problems.push({ template_code: where, item, problem: `Section "${q.section}" is not one of this checklist's sections.` });
      }
      // THE ENGINE'S OWN VALIDATOR. This is the R1 mitigation: if the builder
      // would refuse this question, the seed refuses it too, with the same words.
      const v = normalizeFssaiQuestion(q);
      if (!v.ok) {
        problems.push({ template_code: where, item, problem: v.error });
        continue;
      }
      if (v.value.qtype !== 'photo' && v.value.photo_rule === 'always' && v.value.is_required) {
        problems.push({
          template_code: where, item,
          problem: 'A required question that always demands a photograph makes a clean round unsubmittable without a camera. Use "only when it fails".',
        });
      }
      validated.push({ code: q.code, section: q.section || '', value: v.value });
    }
    templates.push({ template: t, questions: validated });
  }

  return {
    ok: problems.length === 0,
    problems,
    templates,
    counts: { templates: pack.templates.length, sections: sectionCount, questions: questionCount },
  };
}

/** One pack template by its code, or null. */
export function fssaiPackTemplate(code: string, pack: ChecklistPack = FSSAI_CHECKLIST_PACK): PackTemplate | null {
  return pack.templates.find((t) => t.code === code) || null;
}

/** How many of the twelve belong to each food-safety area. */
export function fssaiPackByModule(pack: ChecklistPack = FSSAI_CHECKLIST_PACK): Map<string, PackTemplate[]> {
  const out = new Map<string, PackTemplate[]>();
  for (const t of pack.templates) {
    const list = out.get(t.module_key) || [];
    list.push(t);
    out.set(t.module_key, list);
  }
  return out;
}
