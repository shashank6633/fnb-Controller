/**
 * VALET — per-outlet configuration, time helpers, normalisers and masks.
 * Pure (no db import) so the client settings screen and the server share it.
 *
 * Every field has a default and a clamp: a malformed config_json can never
 * produce a nonsensical rule (a 0-minute dwell, a negative capacity). parse()
 * is the ONLY way config is read.
 */

export interface ValetConfig {
  /** Name shown on the guest pass; '' → the outlet name. */
  venue_name: string;
  required: { plate: boolean; make: boolean; model: boolean; colour: boolean; guest_name: boolean; guest_mobile: boolean };
  photos: { min: number; max: number; allow_exception: boolean };
  pickup: { now: boolean; in5: boolean; in10: boolean; later: boolean; later_max_minutes: number; later_step_minutes: number };
  /** Service hours as 'HH:MM' IST. close < open means the night crosses midnight. */
  hours: { open: string; close: string };
  /** The IST clock time a new business day starts (e.g. '05:00'). */
  business_day_starts: string;
  dwell_minutes: number;
  default_retrieval_minutes: number;
  max_tasks_per_attendant: number;
  escalation: { unclaimed_min: number; fetching_min: number; outside_wait_min: number; dwell_overrun_min: number; no_staff: boolean };
  pending_checkin_minutes: number;
  pickup_gate_label: string;
  help_phone: string;
  language: 'en' | 'hi';
  /** Minutes without a ping before an attendant holding work is flagged "uncertain". */
  stale_device_minutes: number;
  retention_months: number;
  closing_rush: { enabled: boolean; lead_minutes: number; batch_size: number };
  paper: { enabled: boolean };
  notifications: { whatsapp: boolean };
  hardware: { nfc: boolean; rfid: boolean };
}

export const DWELL_CHOICES = [2, 3, 5, 10] as const;

export const DEFAULT_CONFIG: ValetConfig = {
  venue_name: '',
  required: { plate: true, make: false, model: false, colour: false, guest_name: false, guest_mobile: false },
  photos: { min: 0, max: 6, allow_exception: true },
  pickup: { now: true, in5: true, in10: true, later: true, later_max_minutes: 240, later_step_minutes: 15 },
  hours: { open: '11:00', close: '01:00' },
  business_day_starts: '05:00',
  dwell_minutes: 3,
  default_retrieval_minutes: 8,
  max_tasks_per_attendant: 1,
  escalation: { unclaimed_min: 5, fetching_min: 15, outside_wait_min: 5, dwell_overrun_min: 2, no_staff: true },
  pending_checkin_minutes: 15,
  pickup_gate_label: 'Main gate',
  help_phone: '',
  language: 'en',
  stale_device_minutes: 3,
  retention_months: 12,
  closing_rush: { enabled: false, lead_minutes: 40, batch_size: 5 },
  paper: { enabled: false },
  notifications: { whatsapp: false },
  hardware: { nfc: false, rfid: false },
};

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const int = (v: unknown, d: number, lo: number, hi: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return d;
  return Math.min(hi, Math.max(lo, Math.round(n)));
};
const str = (v: unknown, d: string, max = 80) => (typeof v === 'string' ? v.trim().slice(0, max) : d);
const hhmm = (v: unknown, d: string) => (typeof v === 'string' && HHMM.test(v.trim()) ? v.trim() : d);

/** Parse stored config (string or object) into a fully-defaulted, clamped config. */
export function parseConfig(raw: unknown): ValetConfig {
  let o: Record<string, any> = {};
  if (typeof raw === 'string') { try { o = JSON.parse(raw) || {}; } catch { o = {}; } }
  else if (raw && typeof raw === 'object' && !Array.isArray(raw)) o = raw as Record<string, any>;
  const D = DEFAULT_CONFIG;
  const r = o.required || {}, p = o.photos || {}, k = o.pickup || {}, h = o.hours || {};
  const e = o.escalation || {}, c = o.closing_rush || {};
  const maxPhotos = int(p.max, D.photos.max, 0, 6);
  const dwell = int(o.dwell_minutes, D.dwell_minutes, 1, 30);
  return {
    venue_name: str(o.venue_name, D.venue_name),
    required: {
      plate: bool(r.plate, D.required.plate), make: bool(r.make, D.required.make),
      model: bool(r.model, D.required.model), colour: bool(r.colour, D.required.colour),
      guest_name: bool(r.guest_name, D.required.guest_name), guest_mobile: bool(r.guest_mobile, D.required.guest_mobile),
    },
    photos: { min: Math.min(int(p.min, D.photos.min, 0, 6), maxPhotos), max: maxPhotos, allow_exception: bool(p.allow_exception, D.photos.allow_exception) },
    pickup: {
      now: bool(k.now, D.pickup.now), in5: bool(k.in5, D.pickup.in5), in10: bool(k.in10, D.pickup.in10),
      later: bool(k.later, D.pickup.later),
      later_max_minutes: int(k.later_max_minutes, D.pickup.later_max_minutes, 15, 720),
      later_step_minutes: int(k.later_step_minutes, D.pickup.later_step_minutes, 5, 60),
    },
    hours: { open: hhmm(h.open, D.hours.open), close: hhmm(h.close, D.hours.close) },
    business_day_starts: hhmm(o.business_day_starts, D.business_day_starts),
    dwell_minutes: (DWELL_CHOICES as readonly number[]).includes(dwell) ? dwell : D.dwell_minutes,
    default_retrieval_minutes: int(o.default_retrieval_minutes, D.default_retrieval_minutes, 2, 60),
    max_tasks_per_attendant: int(o.max_tasks_per_attendant, D.max_tasks_per_attendant, 1, 3),
    escalation: {
      unclaimed_min: int(e.unclaimed_min, D.escalation.unclaimed_min, 1, 60),
      fetching_min: int(e.fetching_min, D.escalation.fetching_min, 2, 120),
      outside_wait_min: int(e.outside_wait_min, D.escalation.outside_wait_min, 1, 60),
      dwell_overrun_min: int(e.dwell_overrun_min, D.escalation.dwell_overrun_min, 0, 30),
      no_staff: bool(e.no_staff, D.escalation.no_staff),
    },
    pending_checkin_minutes: int(o.pending_checkin_minutes, D.pending_checkin_minutes, 5, 60),
    pickup_gate_label: str(o.pickup_gate_label, D.pickup_gate_label) || D.pickup_gate_label,
    help_phone: str(o.help_phone, D.help_phone, 20).replace(/[^\d+ -]/g, ''),
    language: o.language === 'hi' ? 'hi' : 'en',
    stale_device_minutes: int(o.stale_device_minutes, D.stale_device_minutes, 1, 30),
    retention_months: int(o.retention_months, D.retention_months, 1, 12),
    closing_rush: {
      enabled: bool(c.enabled, D.closing_rush.enabled),
      lead_minutes: int(c.lead_minutes, D.closing_rush.lead_minutes, 30, 45),
      batch_size: int(c.batch_size, D.closing_rush.batch_size, 1, 50),
    },
    paper: { enabled: bool(o.paper?.enabled, D.paper.enabled) },
    notifications: { whatsapp: bool(o.notifications?.whatsapp, D.notifications.whatsapp) },
    hardware: { nfc: bool(o.hardware?.nfc, D.hardware.nfc), rfid: bool(o.hardware?.rfid, D.hardware.rfid) },
  };
}

// ── Time ─────────────────────────────────────────────────────────────────────

/** THE one writer of valet timestamps: ISO-8601 UTC with milliseconds. */
export function nowIso(now: Date = new Date()): string { return now.toISOString(); }
export function addMinutes(iso: string | Date, min: number): string {
  const t = typeof iso === 'string' ? Date.parse(iso) : iso.getTime();
  return new Date(t + min * 60_000).toISOString();
}
export function minutesBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null;
  const d = (Date.parse(b) - Date.parse(a)) / 60_000;
  return Number.isFinite(d) ? d : null;
}

const IST_OFFSET_MIN = 330;
/** Minutes past IST midnight for an instant. */
export function istMinuteOfDay(now: Date): number {
  const m = (now.getUTCHours() * 60 + now.getUTCMinutes() + IST_OFFSET_MIN) % 1440;
  return m < 0 ? m + 1440 : m;
}
function istDate(now: Date): string {
  return new Date(now.getTime() + IST_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
}
const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

/**
 * The venue's BUSINESS date for an instant. Before the configured day start
 * (e.g. 05:00 IST) it is still yesterday's service — a car parked at 00:40 on
 * the 10th belongs to the night of the 9th. This is what "business dates that
 * cross midnight" means, and reports group on it.
 */
export function businessDate(now: Date, cfg: Pick<ValetConfig, 'business_day_starts'>): string {
  const start = toMin(cfg.business_day_starts);
  if (istMinuteOfDay(now) < start) return istDate(new Date(now.getTime() - 86_400_000));
  return istDate(now);
}

/** Is an instant inside service hours? close < open spans midnight (11:00–01:00). */
export function withinServiceHours(at: Date, cfg: Pick<ValetConfig, 'hours'>): boolean {
  const o = toMin(cfg.hours.open), c = toMin(cfg.hours.close), m = istMinuteOfDay(at);
  if (o === c) return true;                         // 24-hour service
  return o < c ? (m >= o && m < c) : (m >= o || m < c);
}

/** The next closing instant at or after `at` (for later-time limits and closing rush). */
export function nextClose(at: Date, cfg: Pick<ValetConfig, 'hours'>): Date {
  const c = toMin(cfg.hours.close), m = istMinuteOfDay(at);
  let delta = c - m;
  if (delta <= 0) delta += 1440;
  return new Date(Math.floor(at.getTime() / 60_000) * 60_000 + delta * 60_000);
}

// ── Normalisers and masks ────────────────────────────────────────────────────

/** Plate key for duplicate detection: letters + digits only, upper-case. */
export function normPlate(p: string | null | undefined): string {
  return String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
}
/** Tag key: upper-case, no spaces/dashes, leading zeros kept ("042" ≠ "42" on a printed tag). */
export function normTagCode(c: string | null | undefined): string {
  return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}
/** Plate as shown to a guest: only the last four characters. */
export function maskPlate(p: string | null | undefined): string {
  const n = normPlate(p);
  if (n.length <= 4) return n ? '••' + n.slice(-2) : '';
  return '•••• ' + n.slice(-4);
}
/** Mobile as shown on the board: last four digits only. */
export function maskMobile(m: string | null | undefined): string {
  const d = String(m || '').replace(/\D/g, '');
  return d.length >= 4 ? '•••••' + d.slice(-4) : '';
}
/** Keep a typed mobile to digits and a leading +, max 15 digits. */
export function cleanMobile(m: unknown): string {
  const s = String(m ?? '').trim();
  const plus = s.startsWith('+') ? '+' : '';
  return (plus + s.replace(/\D/g, '')).slice(0, 16);
}
export function cleanText(v: unknown, max = 60): string {
  return String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
