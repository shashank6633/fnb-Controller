/**
 * The twenty FSSAI Compliance screens, in the owner's own order, with the phase
 * that brings each one to life.
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
  1: { when: 'In place',          brings: 'the foundation — the records store, the menu, the permissions and these screens' },
  2: { when: 'Next',              brings: 'the checklist builder — sections, questions, and which answer counts as a pass' },
  3: { when: 'Next',              brings: 'the phone checklist — answer it, photograph, sign and submit' },
  4: { when: 'After your review', brings: 'the receiving, temperature and cold-room records' },
  5: { when: 'After your review', brings: 'the batch and expiry, oil and water records' },
  6: { when: 'After your review', brings: 'pest control and the certificate cupboard' },
  7: { when: 'After your review', brings: 'corrective actions, the follow-up tasks and the escalations' },
  8: { when: 'After your review', brings: 'the twelve ready-made checklists' },
  9: { when: 'After your review', brings: 'the dashboard figures, Inspection Mode and the reports' },
};

/**
 * The review gate, verbatim from FSSAI-BUILD-STATE.md §4: the build stops after
 * P3 so the owner can judge the phone checklist before eight more screens are
 * built on top of it. Every screen whose phase is 4 or later says so on the
 * screen — in words, not in a number — rather than implying it is merely next
 * in the queue.
 */
export const FSSAI_REVIEW_GATE_PHASE = 4;

export const FSSAI_MODULES: FssaiModule[] = [
  {
    href: '/fssai',
    label: 'Dashboard',
    blurb: 'Everything at a glance: what is due today, what failed, what needs a signature.',
    phase: 9,
    icon: LayoutDashboard,
    access: 'everyone',
    group: 'dashboard',
  },
  {
    href: '/fssai/receiving',
    label: 'Receiving/Receivables Quality Check',
    blurb: 'Check a delivery at the door — temperature, packaging, weight, expiry — and accept or reject it.',
    phase: 4,
    icon: PackageCheck,
    access: 'everyone',
    group: 'checks',
  },
  {
    href: '/fssai/fifo',
    label: 'FIFO & Expiry Management',
    blurb: 'Oldest stock used first, and anything past its date flagged for disposal.',
    phase: 5,
    icon: CalendarClock,
    access: 'everyone',
    group: 'checks',
  },
  {
    href: '/fssai/cold-rooms',
    label: 'Cold Room Climate Control',
    blurb: 'Every cold room, chiller and freezer with its safe range and its latest reading.',
    phase: 4,
    icon: Snowflake,
    access: 'everyone',
    group: 'checks',
  },
  {
    href: '/fssai/temperature',
    label: 'Temperature Logs',
    blurb: 'The running record of every temperature taken, and who took it.',
    phase: 4,
    icon: Thermometer,
    access: 'everyone',
    group: 'checks',
  },
  {
    href: '/fssai/food-quality',
    label: 'Food Quality Checks',
    blurb: 'Taste, smell, look and texture checked before food goes out.',
    phase: 8,
    icon: Utensils,
    access: 'everyone',
    group: 'checks',
  },
  {
    href: '/fssai/pest-control',
    label: 'Pest Control Logs',
    blurb: 'Contractor visits, bait stations, and sightings your own staff report in between.',
    phase: 6,
    icon: Bug,
    access: 'everyone',
    group: 'checks',
  },
  {
    href: '/fssai/cleaning',
    label: 'Cleaning & Sanitation',
    blurb: 'Daily, weekly and deep-clean schedules, signed by whoever did the work.',
    phase: 8,
    icon: SprayCan,
    access: 'everyone',
    group: 'checks',
  },
  {
    href: '/fssai/hygiene',
    label: 'Personal Hygiene',
    blurb: 'The start-of-shift check on uniform, hands and health, filed by each person.',
    phase: 8,
    icon: Sparkles,
    access: 'everyone',
    group: 'checks',
  },
  {
    href: '/fssai/storage',
    label: 'Food Storage Checks',
    blurb: 'Raw apart from cooked, covered, labelled and dated, nothing on the floor.',
    phase: 8,
    icon: Boxes,
    access: 'everyone',
    group: 'checks',
  },
  {
    href: '/fssai/kitchen-safety',
    label: 'Kitchen Safety Checks',
    blurb: 'Gas, electricals, hood, extinguishers, first aid and the cutting equipment.',
    phase: 8,
    icon: HardHat,
    access: 'everyone',
    group: 'checks',
  },
  {
    href: '/fssai/water-ice',
    label: 'Water & Ice Checks',
    blurb: 'Drinking water and ice checked daily; filter changes and lab reports kept.',
    phase: 5,
    icon: Droplets,
    access: 'everyone',
    group: 'checks',
  },
  {
    href: '/fssai/oil-quality',
    label: 'Oil Quality Checks',
    blurb: 'Fryer oil judged by look, smell and meter, with filtering and changes recorded.',
    phase: 5,
    icon: Beaker,
    access: 'everyone',
    group: 'checks',
  },
  {
    href: '/fssai/corrective-actions',
    label: 'Corrective Actions',
    blurb: 'Every failed check with an owner, a deadline and proof of what was done.',
    phase: 7,
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
    icon: ClipboardList,
    access: 'management',
    group: 'records',
  },
  {
    href: '/fssai/documents',
    label: 'Documents & Certificates',
    blurb: 'Licence, water tests, pest contract and medical certificates, with expiry warnings.',
    phase: 6,
    icon: FileText,
    access: 'management',
    group: 'records',
  },
  {
    href: '/fssai/reports',
    label: 'Reports & Downloads',
    blurb: 'Any date range, any department, as a table, a PDF or an Excel file.',
    phase: 9,
    icon: BarChart3,
    access: 'management',
    group: 'setup',
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
    href: '/fssai/inspection-mode',
    label: 'Inspection Mode',
    blurb: 'One read-only screen to hand an inspector, with the whole file behind it.',
    phase: 9,
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
