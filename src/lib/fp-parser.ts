/**
 * AKAN Function Prospectus (FP) PDF parser.
 *
 * AKAN PDFs use a 2-column table layout that pdf-parse v1 flattens to a
 * line-by-line, top-to-bottom text stream. Labels and values appear on
 * SEPARATE lines (e.g. "Booking\n26-03-2026"). Menu categories interleave
 * across columns ("Veg Starters\nVeg Spring Roll\nNon-Veg Starters\nBhatti
 * ka Murgh\nAchari Paneer Tikka\nChicken Majestic\n…").
 *
 * The parser is defensive — missing fields return undefined / 0 / empty
 * arrays. The structured ParsedFP is then handed to fp-estimator which
 * derives the requisition material lines.
 */

// pdf-parse v1 — buffer in, { text } out. Loaded via runtime require so
// Next.js RSC bundling doesn't try to statically analyze it.
type PdfParseFn = (buffer: Buffer) => Promise<{ text: string; numpages?: number }>;

export interface ParsedFP {
  fp_number?: string;
  booking_date?: string;
  event_date?: string;
  event_day?: string;
  event_time?: string;
  area?: string;
  guest_count: number;
  guest_min?: number;
  guest_max?: number;
  guest_name?: string;
  guest_phone?: string;
  guest_company?: string;
  package_name?: string;
  reference?: string;
  payment_mode?: string;
  rate_per_head?: number;
  advance?: number;
  est_bill?: number;
  menu: {
    veg_starters:    string[];
    nonveg_starters: string[];
    veg_mains:       string[];
    nonveg_mains:    string[];
    rice:            string[];
    salad:           string[];
    dal:             string[];
    desserts:        string[];
    accompaniments:  string[];
  };
  bar: {
    brands: string[];
    cocktail_count: number;
    mocktail_count: number;
    has_aerated: boolean;
    serving_hours: number;
    notes?: string;
  };
  entertainment?: { dj?: boolean };
  raw_text: string;
}

// ────────────────────────────────── Helpers ──────────────────────────────────

function toIsoDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const trimmed = s.trim();
  // DD-MM-YYYY  or  DD/MM/YYYY
  const m = trimmed.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  // YYYY-MM-DD already
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return trimmed;
  return undefined;
}

function toIso24h(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const m = s.trim().match(/(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?/);
  if (!m) return undefined;
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ampm = (m[3] || '').toUpperCase();
  if (ampm === 'PM' && h < 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${min}`;
}

// "Rs.1,89,000" → 189000 ; "Rs.2100" → 2100 ; "-" → undefined
function toNumber(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const cleaned = s.replace(/[Rr]s\.?/g, '').replace(/[,\s₹]/g, '').trim();
  if (!cleaned || cleaned === '-') return undefined;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

function stripItemNumber(s: string): string {
  return s.replace(/^\s*\d+\.\s*/, '').replace(/\s*\*\s*$/, '').trim();
}

// ──────────────────────────── Line walker ────────────────────────────

/**
 * Booking section uses pure key/value pairs on alternating lines.
 * We build a lookup map by walking lines and pairing each known label
 * with the next non-empty non-label line.
 */
const BOOKING_LABELS = new Set([
  'Booking', 'Event Date', 'Day', 'Time', 'Area', 'Min Guar.', 'Min Guar',
  'Guest', 'Phone', 'Company', 'Package', 'Reference', 'Payment',
  'Rate/Head', 'Advance', 'Est. Bill',
]);

function buildBookingMap(lines: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const label = lines[i].trim().replace(/[.:]+$/, '');
    if (!BOOKING_LABELS.has(label) && !BOOKING_LABELS.has(label + '.')) continue;
    // Find next non-empty line that ISN'T also a label
    for (let j = i + 1; j < lines.length; j++) {
      const val = lines[j].trim();
      if (!val) continue;
      const valAsLabel = val.replace(/[.:]+$/, '');
      if (BOOKING_LABELS.has(valAsLabel) || BOOKING_LABELS.has(valAsLabel + '.')) break;
      // Stop at section headings so we don't grab menu items as values
      if (/^(MENU SELECTION|DRINKS & BAR|ENTERTAINMENT|SIGN-OFF|TERMS)/i.test(val)) break;
      // Stop if value looks like a heading itself (parens, all-caps with spaces)
      const norm = label === 'Min Guar.' ? 'Min Guar' : label;
      map.set(norm, val);
      break;
    }
  }
  return map;
}

// ──────────────────────────── Menu parser ────────────────────────────

// Recognised category headings (matched loosely — case-insensitive substring).
// Order matters: more specific ('Non-Veg Starters') before less ('Starters').
const MENU_HEADINGS = [
  { regex: /^Non[-\s]?Veg\s+Starters/i,        key: 'nonveg_starters'  as const, pair: 'veg_starters'    as const },
  { regex: /^Veg\s+Starters/i,                 key: 'veg_starters'     as const, pair: 'nonveg_starters' as const },
  { regex: /^Non[-\s]?Veg\s+Main(?:\s+Course)?/i, key: 'nonveg_mains' as const, pair: 'veg_mains'        as const },
  { regex: /^Veg\s+Main(?:\s+Course)?/i,       key: 'veg_mains'        as const, pair: 'nonveg_mains'    as const },
  { regex: /^Rice\b/i,                         key: 'rice'             as const, pair: null },
  { regex: /^Salad\b/i,                        key: 'salad'            as const, pair: null },
  { regex: /^Dal\b/i,                          key: 'dal'              as const, pair: null },
  { regex: /^Desserts?\b/i,                    key: 'desserts'         as const, pair: null },
  { regex: /^Accompaniments?\b/i,              key: 'accompaniments'   as const, pair: null },
];

type MenuKey = 'veg_starters' | 'nonveg_starters' | 'veg_mains' | 'nonveg_mains'
             | 'rice' | 'salad' | 'dal' | 'desserts' | 'accompaniments';

function matchHeading(line: string): { key: MenuKey; pair: MenuKey | null } | null {
  for (const h of MENU_HEADINGS) {
    if (h.regex.test(line.trim())) return { key: h.key, pair: h.pair };
  }
  return null;
}

/**
 * Parse the MENU SELECTION block.
 *
 * AKAN layout has paired columns (Veg Starters | Non-Veg Starters) followed
 * by single columns (Rice, Salad, …). pdf-parse linearises this to:
 *
 *   "Veg Starters (3/3)"             ← heading L
 *   "  1. Veg Spring Roll"           ← L item 1
 *   "Non-Veg Starters"               ← heading R (sometimes split across 2 lines)
 *   "(3/3)"
 *   "  1. Bhatti ka Murgh"           ← R item 1
 *   "  2. Achari Paneer Tikka"       ← L item 2
 *   "  2. Chicken Majestic"          ← R item 2
 *   "  3. Hara Bhara Sheekh Kebab *" ← L item 3
 *   "  3. Apollo Fish Fry"           ← R item 3
 *   "Veg Main Course"                ← next heading pair…
 *   "(2/2)"
 *   ...
 *
 * Approach:
 *   - Walk lines after "MENU SELECTION" until "DRINKS & BAR".
 *   - When we see a heading, set it as the current "left" target.
 *   - When we see a paired heading immediately after, set "right" target.
 *   - For each numbered item line ("  N. ..."), assign to left or right by
 *     position: when both columns are active, alternate; otherwise dump in
 *     the only active column.
 *   - Single-column sections (Rice, Salad, Dal, Desserts) clear the right
 *     target so subsequent items go only into left.
 *   - Accompaniments is a single comma-separated line, not numbered.
 */
function parseMenu(lines: string[], out: ParsedFP['menu']): void {
  // Find MENU SELECTION boundaries
  const start = lines.findIndex((l) => /^MENU\s+SELECTION/i.test(l.trim()));
  if (start < 0) return;
  const end = lines.findIndex((l, i) => i > start && /^DRINKS\s*&\s*BAR/i.test(l.trim()));
  const stop = end < 0 ? lines.length : end;

  let leftKey: MenuKey | null = null;
  let rightKey: MenuKey | null = null;
  let leftCount = 0;   // # items pushed to leftKey since heading set
  let rightCount = 0;

  // Helper to push an item, alternating columns when both are active
  const pushItem = (rawItem: string) => {
    const item = stripItemNumber(rawItem);
    if (!item) return;
    if (leftKey && rightKey) {
      // Alternate by position number
      if (leftCount <= rightCount) {
        out[leftKey].push(item); leftCount++;
      } else {
        out[rightKey].push(item); rightCount++;
      }
    } else if (leftKey) {
      out[leftKey].push(item); leftCount++;
    }
  };

  for (let i = start + 1; i < stop; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;

    // Sometimes a heading is split across 2 lines: "Non-Veg Starters" + "(3/3)"
    // Stitch them together for heading detection by looking at the prior heading
    // candidate without the count.
    const headingMatch = matchHeading(line);

    if (headingMatch) {
      // New heading detected.
      if (headingMatch.pair !== null) {
        // Paired heading — could be left or right depending on what's already set
        if (!leftKey || (leftKey && leftCount > 0 && !rightKey)) {
          // Either no left set, or left already accumulated → this is right
          if (!leftKey) {
            leftKey = headingMatch.key; leftCount = 0;
          } else {
            rightKey = headingMatch.key; rightCount = 0;
          }
        } else if (rightKey && rightCount > 0) {
          // Both sides have items → starting a new pair, reset both
          leftKey = headingMatch.key; leftCount = 0;
          rightKey = null; rightCount = 0;
        } else {
          // Fall through — assign to whichever side is empty
          if (!leftKey) { leftKey = headingMatch.key; leftCount = 0; }
          else { rightKey = headingMatch.key; rightCount = 0; }
        }
      } else {
        // Single-column heading (Rice/Salad/Dal/Desserts/Accompaniments)
        leftKey = headingMatch.key; leftCount = 0;
        rightKey = null; rightCount = 0;
      }
      continue;
    }

    // Skip the "(N/M)" line that follows a split heading
    if (/^\(\d+\/\d+\)$/.test(line)) continue;

    // Numbered item: "1. Veg Spring Roll" or "  2. Chicken Majestic"
    if (/^\d+\.\s+/.test(line)) {
      pushItem(line);
      continue;
    }

    // Accompaniments — single comma-separated line after the heading
    if (leftKey === 'accompaniments') {
      const parts = line.split(',').map(s => s.trim()).filter(Boolean);
      out.accompaniments.push(...parts);
      continue;
    }
  }
}

// ──────────────────────────── Bar parser ────────────────────────────

function parseBar(lines: string[], out: ParsedFP['bar']): void {
  const start = lines.findIndex((l) => /^DRINKS\s*&\s*BAR/i.test(l.trim()));
  if (start < 0) return;
  const end = lines.findIndex((l, i) => i > start && /^(ENTERTAINMENT|SIGN-OFF|TERMS)/i.test(l.trim()));
  const stop = end < 0 ? lines.length : end;

  let currentField: 'brands' | 'includes' | 'serving' | 'notes' | null = null;
  const buffers: Record<string, string[]> = { brands: [], includes: [], serving: [], notes: [] };
  const fieldLabels: Record<string, 'brands' | 'includes' | 'serving' | 'notes'> = {
    'Brands':   'brands',
    'Includes': 'includes',
    'Serving':  'serving',
    'Notes':    'notes',
    'Bar Start':'serving',
    'Bar End':  'serving',
  };

  for (let i = start + 1; i < stop; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) { currentField = null; continue; }

    // Switch field on a label line
    const labelKey = fieldLabels[line.replace(/[:.]+$/, '')];
    if (labelKey) { currentField = labelKey; continue; }

    if (currentField) buffers[currentField].push(line);
  }

  out.brands = buffers.brands
    .join(',')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const inc = buffers.includes.join(' ');
  const cocktailM = inc.match(/(\d+)\s+Barman\s+Special\s+Cocktails?/i);
  if (cocktailM) out.cocktail_count = parseInt(cocktailM[1], 10);
  const mocktailM = inc.match(/(\d+)\s+Barman\s+Special\s+Mocktails?/i);
  if (mocktailM) out.mocktail_count = parseInt(mocktailM[1], 10);
  out.has_aerated = /aerated/i.test(inc);

  const servingText = buffers.serving.join(' ');
  const hrs = servingText.match(/(\d+(?:\.\d+)?)\s*(?:hrs?|hours?)/i);
  if (hrs) out.serving_hours = parseFloat(hrs[1]);

  const notesText = buffers.notes.join(' ').trim();
  if (notesText) out.notes = notesText;
}

// ──────────────────────────── Entry point ────────────────────────────

export async function parseAkanFP(pdfBuffer: Buffer): Promise<ParsedFP> {
  // Lazy require so Next.js RSC bundling doesn't try to bundle pdf-parse.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pdfParse = require('pdf-parse') as PdfParseFn;
  const result = await pdfParse(pdfBuffer);
  const text = result.text || '';
  const lines = text.split(/\r?\n/);

  const out: ParsedFP = {
    guest_count: 0,
    menu: {
      veg_starters: [], nonveg_starters: [],
      veg_mains: [],    nonveg_mains: [],
      rice: [], salad: [], dal: [], desserts: [], accompaniments: [],
    },
    bar: {
      brands: [], cocktail_count: 0, mocktail_count: 0,
      has_aerated: false, serving_hours: 2.5,
    },
    raw_text: text,
  };

  // FP number — e.g. "FP-20260409-KNNR"
  const fpMatch = text.match(/\bFP[-\s]?(\d{4,8})[-\s]?([A-Z0-9]{2,8})\b/);
  if (fpMatch) out.fp_number = `FP-${fpMatch[1]}-${fpMatch[2]}`;

  // Booking + guest fields via label/value line pairing
  const m = buildBookingMap(lines);
  out.booking_date  = toIsoDate(m.get('Booking'));
  out.event_date    = toIsoDate(m.get('Event Date'));
  out.event_day     = m.get('Day');
  out.event_time    = toIso24h(m.get('Time'));
  out.area          = m.get('Area');
  out.guest_name    = m.get('Guest');
  out.guest_phone   = m.get('Phone');
  out.guest_company = m.get('Company');
  out.package_name  = m.get('Package');
  out.reference     = m.get('Reference');
  out.payment_mode  = m.get('Payment');
  out.rate_per_head = toNumber(m.get('Rate/Head'));
  out.advance       = toNumber(m.get('Advance'));
  out.est_bill      = toNumber(m.get('Est. Bill'));

  // Min Guar — "90-100" or single number
  const guarRaw = m.get('Min Guar');
  if (guarRaw) {
    const range = guarRaw.match(/(\d+)\s*[-–to]+\s*(\d+)/);
    if (range) {
      out.guest_min = parseInt(range[1], 10);
      out.guest_max = parseInt(range[2], 10);
      out.guest_count = out.guest_max;
    } else {
      const single = guarRaw.match(/(\d+)/);
      if (single) {
        out.guest_count = parseInt(single[1], 10);
        out.guest_min = out.guest_count;
        out.guest_max = out.guest_count;
      }
    }
  }

  // Menu sections
  parseMenu(lines, out.menu);

  // Bar block
  parseBar(lines, out.bar);

  // Entertainment
  const djMatch = text.match(/DJ\s*[\s\S]*?(YES|NO|Yes|No|yes|no)\b/);
  if (djMatch) out.entertainment = { dj: /yes/i.test(djMatch[1]) };

  return out;
}

// ─────────────────────── Manual smoke test (Node) ───────────────────────
// Run: `node -r ts-node/register src/lib/fp-parser.ts /path/to/fp.pdf`
if (typeof require !== 'undefined' && require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as typeof import('fs');
  const path = process.argv[2] || '/Users/shashankreddy/Downloads/09-04-2026_Kiran_Kumar.pdf';
  parseAkanFP(fs.readFileSync(path)).then((p) => {
    const { raw_text, ...rest } = p;
    console.log(JSON.stringify(rest, null, 2));
    console.log('\nraw_text length:', raw_text.length);
  }).catch((e) => console.error('PARSE ERROR:', e));
}
