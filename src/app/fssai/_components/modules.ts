/**
 * The FSSAI Compliance screens, in the owner's own order, with the phase that
 * brings each one to life.
 *
 * It was twenty. It is TWENTY-TWO: the record modules needed two surfaces the
 * original list had nowhere to put — the change-and-void trail that owner §19
 * requires, and the equipment register every temperature verdict is judged
 * against (fssai_equipment holds 0 rows, so without it a cold room cannot even
 * be the target of a check). Both carry the same tier flags in page-catalog.ts.
 * Count them from this array, never from a sentence: the number in a comment
 * goes stale silently and this one already had.
 *
 * ONE LIST, THREE READERS. The Compliance Dashboard builds its tiles from here,
 * every sub-page reads its own row for its heading, icon and phase, and the
 * "Management only" / "Admin only" marks come from here too. That is deliberate:
 * the labels below are the SAME strings as the rows in src/components/Sidebar.tsx
 * and src/lib/page-catalog.ts, so a heading can never drift from the menu item
 * that leads to it. If a label changes, it changes in all three files.
 *
 * `access` MIRRORS the tier flag on the catalog row — it does NOT enforce
 * anything. The real gate is the tier flag in src/lib/page-catalog.ts plus each
 * API route's own check (canAccessPage fails open in four ways, so a screen must
 * never present its own label as security). It is here so the dashboard can be
 * honest about which screens a staff-tier phone will not open.
 *
 * Pure module — no DB import, no hooks — so a client component may import it.
 * Modelled on src/lib/tasks.ts (statusMeta/priorityMeta), which is the house
 * pattern for "metadata array + lookup with a fallback".
 */

import type { LucideIcon } from 'lucide-react';
import {
  BarChart3,
  Beaker,
  Boxes,
  Bug,
  CalendarClock,
  ClipboardList,
  Droplets,
  Eye,
  FileText,
  HardHat,
  History,
  LayoutDashboard,
  ListChecks,
  PackageCheck,
  Settings2,
  Snowflake,
  SprayCan,
  Sparkles,
  Thermometer,
  Utensils,
  Wrench,
} from 'lucide-react';

/** Who can open the screen. Mirrors the catalog tier flag; enforces nothing. */
export type FssaiAccess = 'everyone' | 'management' | 'admin';

/** Which band of the dashboard a screen sits in. */
export type FssaiGroup = 'dashboard' | 'checks' | 'records' | 'setup';

export interface FssaiModule {
  /** Must match the Sidebar href and the page-catalog path, character for character. */
  href: string;
  /** Must match the Sidebar label and the page-catalog label. Used as the page heading. */
  label: string;
  /** One line a restaurant manager can read: what the screen is for. */
  blurb: string;
  /** The phase that makes this screen do its job. Key into FSSAI_PHASES. */
  phase: number;
  /**
   * THE SCREEN IS ACTUALLY BUILT AND DOING ITS JOB NOW.
   *
   * WHY THIS EXISTS. The dashboard chip is rendered from `phase`, and every
   * phase from 4 up reads "After your review". That was true of all of them when
   * it was written. The moment a screen is finished ahead of its phase, the chip
   * becomes a false statement about a compliance module on the dashboard —
   * "After your review" printed under a screen the owner can use today.
   *
   * ADDITIVE AND OPT-IN. `phase` still says which stage of the plan OWNS the
   * screen, so FSSAI-BUILD-STATE.md still lines up; this only overrides the
   * word on the chip. A lane that finishes its own screen sets this on its own
   * row — nobody sets it on somebody else's, because only the lane that built it
   * knows whether it really works.
   */
  built?: true;
  icon: LucideIcon;
  access: FssaiAccess;
  group: FssaiGroup;
}

/**
 * What each stage of the build delivers, in plain English.
 *
 * NO "PHASE N" IN ANYTHING A PERSON READS. The build plan numbers its phases
 * P1-P11 and this module is keyed by those numbers — `FSSAI_MODULES[].phase: 4`
 * IS the plan's P4, so nothing is lost and a reader of FSSAI-BUILD-STATE.md §4
 * can still line the two up. But "Phase 8" told a chef or a manager nothing: the
 * word is defined nowhere in the app, and a grid of numbered badges on a
 * food-safety dashboard reads as an unfinished system. Every other word in this
 * module is restaurant English, which is exactly what made this one stand out.
 *
 * So the numbers stay in the DATA and never reach the SCREEN:
 *   · `when`   — the chip on a dashboard tile. Answers "when does this work?"
 *                the way the build plan actually answers it: the next two pieces
 *                of work, then everything else waits for the owner's review.
 *   · `brings` — finishes "This screen starts working when we build …", so it
 *                starts lower-case and carries no full stop.
 *
 * Reversible in one line if the owner would rather see the numbers: put
 * `name: 'Phase N'` back and render it instead of `when`.
 */
export const FSSAI_PHASES: Record<number, { when: string; brings: string }> = {
  1: { when: 'In place',       brings: 'the foundation — the records store, the menu, the permissions and these screens' },
  2: { when: 'Next',           brings: 'the checklist builder — sections, questions, and which answer counts as a pass' },
  3: { when: 'Next',           brings: 'the phone checklist — answer it, photograph, sign and submit' },
  4: { when: 'Being built',    brings: 'the receiving, temperature and cold-room records' },
  5: { when: 'Being built',    brings: 'the batch and expiry, oil and water records' },
  6: { when: 'Being built',    brings: 'pest control and the certificate cupboard' },
  7: { when: 'Being built',    brings: 'corrective actions, the follow-up tasks and the escalations' },
  8: { when: 'Being built',    brings: 'the fifteen ready-made checklists' },
  9: { when: 'Being built',    brings: 'the dashboard figures, Inspection Mode and the reports' },
  10: { when: 'Being built',   brings: 'the change-and-void trail behind every record' },
};

/**
 * The review gate, verbatim from FSSAI-BUILD-STATE.md §4: the build stops after
 * P3 so the owner can judge the phone checklist before eight more screens are
 * built on top of it. Every screen whose phase is 4 or later says so on the
 * screen — in words, not in a number — rather than implying it is merely next
 * in the queue.
 */
export const FSSAI_REVIEW_GATE_PHASE = 4;

/**
 * IS THE BUILD STILL STOPPED AT THAT GATE? Now **false**, and the reason is the
 * only thing that may ever change it.
 *
 * WHY IT EXISTS AS A FLAG RATHER THAN A DELETED PARAGRAPH. Until today every
 * screen from phase 4 up printed "That work is deliberately on hold… the build
 * stops once a checklist runs on a phone", which was true and was exactly what
 * the owner asked for on 2026-09-16. He has since instructed the build to carry
 * on and complete the module, so that sentence became a false statement about
 * his own project, printed on eighteen screens at once. The sentence is not
 * deleted — the gate is part of this build's history and the words are still
 * here, one line away — it is simply no longer asserted.
 *
 * ⚠️ WHAT THIS IS NOT. It has NOTHING to do with the DEPLOY gate, which stands
 * unchanged and is not a flag in any file: nothing in this module is deployed,
 * merged or pushed until the owner says "Deploy FSSAI". See
 * FSSAI-BUILD-STATE.md §0. Flipping this constant back to `true` restores the
 * hold paragraph and changes nothing else.
 */
export const FSSAI_BUILD_HELD_AT_REVIEW_GATE = false;

export const FSSAI_MODULES: FssaiModule[] = [
  {
    href: '/fssai',
    label: 'Dashboard',
    blurb: 'Everything at a glance: what is due today, what failed, what needs a signature.',
    phase: 9,
    built: true,
    icon: LayoutDashboard,
    access: 'everyone',
    group: 'dashboard',
  },
  {
    href: '/fssai/receiving',
    label: 'Receiving/Receivables Quality Check',
    blurb: 'Check a delivery at the door — temperature, packaging, weight, expiry — and accept or reject it.',
    phase: 4,
    built: true,
    icon: PackageCheck,
    access: 'everyone',
    group: 'checks',
  },
  {
    href: '/fssai/fifo',
    label: 'FIFO & Expiry Management',
    blurb: 'Oldest stock used first, and anything past its date flagged for disposal.',
    phase: 5,
    // Built: the expiry board, the expiry and disposal register, and the
    // shelf-life settings the board colours items from.
    built: true,
    icon: CalendarClock,
    access: 'everyone',
    group: 'checks',
  },
  {
    href: '/fssai/cold-rooms',
    label: 'Cold Room Climate Control',
    blurb: 'Every cold room, chiller and freezer with its safe range and its latest reading.',
    phase: 4,
    built: true,
    icon: Snowflake,
    access: 'everyone',
    group: 'checks',
  },
  {
    href: '/fssai/temperature',
    label: 'Temperature Logs',
    blurb: 'The running record of every temperature taken, and who took it.',
    phase: 4,
    built: true,
    icon: Thermometer,
    access: 'everyone',
    group: 'checks',
  },
  {
    href: '/fssai/food-quality',
    label: 'Food Quality Checks',
    blurb: 'Taste, smell, look and texture checked before food goes out.',
    phase: 8,
    // The screen is live: it lists the checklists that cover food quality, the
    // last round recorded against each, and leads to the runner or the builder.
    built: true,
    icon: Utensils,
    access: 'everyone',
    group: 'checks',
  },
  {
    href: '/fssai/pest-control',
    label: 'Pest Control Logs',
    blurb: 'Contractor visits, bait stations, and sightings your own staff report in between.',
    phase: 6,
    // Built. Three registers on one screen: the contractor's visits (management),
    // the sightings any member of staff can file from their own phone, and the
    // pest map (admin). 'Missed' is a first-class state, because a contract visit
    // that did not happen is the commonest pest-control finding there is.
    built: true,
    icon: Bug,
    access: 'everyone',
    group: 'checks',
  },
  {
    href: '/fssai/cleaning',
    label: 'Cleaning & Sanitation',
    blurb: 'Daily, weekly and deep-clean schedules, signed by whoever did the work.',
    phase: 8,
    built: true,
    icon: SprayCan,
    access: 'everyone',
    group: 'checks',
  },
  {
    href: '/fssai/hygiene',
    label: 'Personal Hygiene',
    blurb: 'The start-of-shift check on uniform, hands and health, filed by each person.',
    phase: 8,
    built: true,
    icon: Sparkles,
    access: 'everyone',
    group: 'checks',
  },
  {
    href: '/fssai/storage',
    label: 'Food Storage Checks',
    blurb: 'Raw apart from cooked, covered, labelled and dated, nothing on the floor.',
    phase: 8,
    built: true,
    icon: Boxes,
    access: 'everyone',
    group: 'checks',
  },
  {
    href: '/fssai/kitchen-safety',
    label: 'Kitchen Safety Checks',
    blurb: 'Gas, electricals, hood, extinguishers, first aid and the cutting equipment.',
    phase: 8,
    built: true,
    icon: HardHat,
    access: 'everyone',
    group: 'checks',
  },
  {
    href: '/fssai/water-ice',
    label: 'Water & Ice Checks',
    blurb: 'Drinking water and ice checked daily; filter changes and lab reports kept.',
    phase: 5,
    // Built: the daily readings, the filter and tank records, and the laboratory
    // certificates with their next-due dates.
    built: true,
    icon: Droplets,
    access: 'everyone',
    group: 'checks',
  },
  {
    href: '/fssai/oil-quality',
    label: 'Oil Quality Checks',
    blurb: 'Fryer oil judged by look, smell and meter, with filtering and changes recorded.',
    phase: 5,
    // Built: the oil checks and the used-oil collection register.
    built: true,
    icon: Beaker,
    access: 'everyone',
    group: 'checks',
  },
  {
    href: '/fssai/corrective-actions',
    label: 'Corrective Actions',
    blurb: 'Every failed check with an owner, a deadline and proof of what was done.',
    phase: 7,
    // Built ahead of its phase for owner §7 Q14 — a failed answer raises the
    // action, and the fix and its check are recorded there.
    built: true,
    icon: Wrench,
    access: 'everyone',
    group: 'records',
  },
  {
    href: '/fssai/checklists',
    label: 'FSSAI Checklists',
    blurb: 'The checklists the restaurant runs — and the screen staff tap to run one.',
    phase: 2,
    icon: ListChecks,
    access: 'everyone',
    group: 'records',
  },
  {
    href: '/fssai/inspections',
    label: 'Inspection Reports',
    blurb: 'Real inspections: what was observed, the deadline, and how each point was closed.',
    phase: 9,
    built: true,
    icon: ClipboardList,
    access: 'management',
    group: 'records',
  },
  {
    href: '/fssai/documents',
    label: 'Documents & Certificates',
    blurb: 'Licence, water tests, pest contract and medical certificates, with expiry warnings.',
    phase: 6,
    // Built. The expiry state is DERIVED on every read, never stored, and
    // renewing files a new version rather than overwriting the old one. What it
    // does NOT do, and says so on the screen: send a reminder anywhere.
    built: true,
    icon: FileText,
    access: 'management',
    group: 'records',
  },
  {
    href: '/fssai/reports',
    label: 'Reports & Downloads',
    blurb: 'Any date range, any department, as a table, a PDF or an Excel file.',
    phase: 9,
    built: true,
    icon: BarChart3,
    access: 'management',
    group: 'setup',
  },
  {
    href: '/fssai/audit-log',
    label: 'Record Changes & Voids',
    blurb: 'Who changed a record, from what to what, and the reason they gave for cancelling one.',
    phase: 10,
    // Built. The trail was always being written — this is the screen to read it
    // on, with the original beside the changed value, the reason, a CSV for an
    // inspector, and the photo-retention sweep that proves what it dropped.
    // Nothing on it can edit or delete a line: the route has no POST at all.
    built: true,
    icon: History,
    access: 'management',
    group: 'records',
  },
  {
    href: '/fssai/settings',
    label: 'Settings',
    blurb: 'Your standards: the checklists, the frequencies, the equipment and the safe ranges.',
    phase: 2,
    icon: Settings2,
    access: 'admin',
    group: 'setup',
  },
  {
    href: '/fssai/settings/equipment',
    label: 'Equipment & Cold Units',
    blurb: 'Every cold room, chiller, freezer and fryer, each with the safe range you set for it.',
    phase: 4,
    built: true,
    icon: Snowflake,
    access: 'admin',
    group: 'setup',
  },
  {
    href: '/fssai/inspection-mode',
    label: 'Inspection Mode',
    blurb: 'One read-only screen to hand an inspector, with the whole file behind it.',
    phase: 9,
    built: true,
    icon: Eye,
    access: 'management',
    group: 'setup',
  },
];

/**
 * Look a screen up by its path. Falls back to a neutral row rather than throwing
 * — a mistyped href must show a plain screen, never a crash (the statusMeta
 * fallback habit, src/lib/tasks.ts:64).
 */
export function fssaiModule(href: string): FssaiModule {
  return (
    FSSAI_MODULES.find((m) => m.href === href) || {
      href,
      label: 'FSSAI Compliance',
      blurb: '',
      phase: 1,
      icon: ListChecks,
      access: 'everyone',
      group: 'records',
    }
  );
}

/** The stage row, with a readable fallback for a number that has no entry. */
export function fssaiPhase(phase: number): { when: string; brings: string } {
  return FSSAI_PHASES[phase] || { when: 'Later', brings: 'this screen' };
}

/** The badge wording for a screen's access mark. '' = no mark. */
export function fssaiAccessLabel(access: FssaiAccess): string {
  if (access === 'admin') return 'Admin only';
  if (access === 'management') return 'Management only';
  return '';
}
