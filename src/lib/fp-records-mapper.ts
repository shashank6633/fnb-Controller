/**
 * Maps rows from the AKAN Party Manager sheet's "F&P Records" tab into our
 * internal UpcomingParty shape.
 *
 * The sheet has 66 columns. Most are operational notes / dept-flags we don't
 * need yet — we extract just the fields used to pre-fill a Party Requisition.
 * If a column is missing or named differently in some sheets, we tolerate it
 * (return undefined / default).
 */

export interface UpcomingParty {
  // Identity
  fp_id: string;                  // e.g. "FP-20260520-KKMR"
  party_unique_id?: string;
  status?: string;                // Draft | Confirmed | Done | Cancelled

  // Booking
  date_of_booking?: string;       // YYYY-MM-DD
  date_of_event: string;          // YYYY-MM-DD  (REQUIRED — null → row skipped)
  day_of_event?: string;
  time_of_event?: string;
  allocated_area?: string;

  // Guest + commercials
  guest_name?: string;
  contact_person?: string;
  phone?: string;
  company?: string;
  reference?: string;
  package_type?: string;
  mode_of_payment?: string;
  rate_per_head?: number;
  min_guarantee?: number;
  pax_expected?: number;
  approx_bill?: number;
  advance_payment?: number;

  // Menu (CSV strings — we keep them as text; FP estimator will tokenise)
  veg_starters?: string;
  nonveg_starters?: string;
  veg_mains?: string;
  nonveg_mains?: string;
  rice?: string;
  dal?: string;
  salad?: string;
  accompaniments?: string;
  desserts?: string;
  addon_extras?: string;
  preset_menu_text?: string;
  other_items?: string;

  // Bar
  bar_notes?: string;
  drinks_start_time?: string;
  drinks_end_time?: string;

  // Departments / responsibility
  fp_made_by?: string;
  manager_name?: string;
  kitchen_dept?: string;
  service_dept?: string;
  bar_dept?: string;
  stores_dept?: string;
  maintenance?: string;
  front_office?: string;

  // Entertainment + special diets
  dj?: string;
  mc?: string;
  mics?: string;
  decor?: string;
  seating?: string;
  entertainment_notes?: string;
  activities?: string;
  jain_food?: string;
  jain_food_pax?: number;
  vegan_food?: string;
  vegan_food_pax?: number;
  spice_level?: string;
  show_spice_levels?: string;

  // Bookkeeping
  created_at?: string;
  updated_at?: string;
  created_by?: string;
}

/** Coerce sheet cell → ISO date YYYY-MM-DD if recognisable. */
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
function toIsoDate(v: any): string | undefined {
  if (v == null || v === '') return undefined;
  // Excel / Google Sheets serial date number (days since 1899-12-30). Sheets
  // returns a raw number when a date cell is formatted as plain number/general —
  // that row previously failed String()-based parsing and got silently dropped.
  if (typeof v === 'number' && v > 59 && v < 100000) {
    const d = new Date(Math.round((v - 25569) * 86400000));
    return isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  if (!s) return undefined;
  // DD-MM-YYYY or DD/MM/YYYY
  let m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  // YYYY-MM-DD already (optionally followed by a time)
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // M/D/YYYY (US format)
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  // Month-name formats: "10 Jul 2026", "10-July-2026", "10 July 2026"
  const norm = s.toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  let mm = norm.match(/^(\d{1,2})[ -]([a-z]{3,})[ -](\d{4})$/);
  if (mm && MONTHS[mm[2].slice(0, 3)]) return `${mm[3]}-${String(MONTHS[mm[2].slice(0, 3)]).padStart(2,'0')}-${mm[1].padStart(2,'0')}`;
  // "Jul 10 2026" / "July 10, 2026"
  mm = norm.match(/^([a-z]{3,})[ -](\d{1,2})[ -](\d{4})$/);
  if (mm && MONTHS[mm[1].slice(0, 3)]) return `${mm[3]}-${String(MONTHS[mm[1].slice(0, 3)]).padStart(2,'0')}-${mm[2].padStart(2,'0')}`;
  return undefined;
}

function toNumber(v: any): number | undefined {
  if (v == null || v === '' || v === '-') return undefined;
  const cleaned = String(v).replace(/[Rr]s\.?/g, '').replace(/[,\s₹]/g, '').trim();
  if (!cleaned) return undefined;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

function s(v: any): string | undefined {
  if (v == null) return undefined;
  const str = String(v).trim();
  return str ? str : undefined;
}

/**
 * Column index map for the "F&P Records" tab. Indices are 0-based; if AKAN
 * ever reorders columns, update these once and everything downstream stays
 * working.
 *
 * Headers (in order, from user's paste):
 *  0  FP ID                       1  Party Unique ID            2  Created At
 *  3  Updated At                  4  Created By                 5  Status
 *  6  Date of Booking             7  Date of Event              8  Day of Event
 *  9  Time of Event              10  Advance Payment           11  Allocated Area
 * 12  Rate Per Head              13  Company                   14  Minimum Guarantee
 * 15  Contact Person             16  Pax Expected              17  Phone
 * 18  Package Type               19  Reference                 20  Mode of Payment
 * 21  Veg Starters               22  Non-Veg Starters          23  Veg Main Course
 * 24  Non-Veg Main Course        25  Rice                      26  Dal
 * 27  Salad                      28  Accompaniments            29  Desserts
 * 30  Addon Mutton Starters      31  Addon Mutton Main Course  32  Addon Prawns Starters
 * 33  Addon Prawns Main Course   34  Addon Extras              35  DJ
 * 36  MC                         37  Mics                      38  Decor
 * 39  Seating Arrangements       40  Bar Notes                 41  Manager Name
 * 42  Guest Name                 43  Drinks Start Time         44  Drinks End Time
 * 45  FP Made By                 46  Kitchen Dept              47  Service Dept
 * 48  Bar Dept                   49  Stores Dept               50  Maintenance
 * 51  Front Office               52  Preset Menu Text          53  Other Items
 * 54  Approx Bill Amount         55  Show Spice Levels         56  Spice Level
 * 57  Jain Food                  58  Jain Food Pax             59  Vegan Food
 * 60  Vegan Food Pax             61  Entertainment Notes       62  Activities
 * 63  Addon Veg Starters         64  Addon Veg Main Course     65  Addon Live Counter Veg
 * 66  Addon Live Counter Non-Veg
 */
export const FP_RECORDS_COLS = {
  fp_id: 0, party_unique_id: 1, created_at: 2, updated_at: 3, created_by: 4,
  status: 5,
  date_of_booking: 6, date_of_event: 7, day_of_event: 8, time_of_event: 9,
  advance_payment: 10, allocated_area: 11, rate_per_head: 12,
  company: 13, min_guarantee: 14, contact_person: 15, pax_expected: 16,
  phone: 17, package_type: 18, reference: 19, mode_of_payment: 20,
  veg_starters: 21, nonveg_starters: 22, veg_mains: 23, nonveg_mains: 24,
  rice: 25, dal: 26, salad: 27, accompaniments: 28, desserts: 29,
  addon_mutton_starters: 30, addon_mutton_mains: 31,
  addon_prawns_starters: 32, addon_prawns_mains: 33, addon_extras: 34,
  dj: 35, mc: 36, mics: 37, decor: 38, seating: 39, bar_notes: 40,
  manager_name: 41, guest_name: 42, drinks_start_time: 43, drinks_end_time: 44,
  fp_made_by: 45, kitchen_dept: 46, service_dept: 47, bar_dept: 48,
  stores_dept: 49, maintenance: 50, front_office: 51,
  preset_menu_text: 52, other_items: 53, approx_bill: 54,
  show_spice_levels: 55, spice_level: 56,
  jain_food: 57, jain_food_pax: 58, vegan_food: 59, vegan_food_pax: 60,
  entertainment_notes: 61, activities: 62,
  addon_veg_starters: 63, addon_veg_mains: 64,
  addon_live_counter_veg: 65, addon_live_counter_nonveg: 66,
} as const;

/**
 * Map a raw sheet row (array of cell values) → UpcomingParty struct.
 * Returns null if the row is empty or missing event date.
 */
export function mapRowToUpcomingParty(row: string[]): UpcomingParty | null {
  const c = FP_RECORDS_COLS;
  const pick = (i: number) => row[i] !== undefined ? row[i] : '';

  const eventDate = toIsoDate(pick(c.date_of_event));
  if (!eventDate) return null;   // skip rows without an event date

  const fpId = s(pick(c.fp_id));
  if (!fpId) return null;        // require FP ID as identity

  return {
    fp_id: fpId,
    party_unique_id: s(pick(c.party_unique_id)),
    status:          s(pick(c.status)),
    date_of_booking: toIsoDate(pick(c.date_of_booking)),
    date_of_event:   eventDate,
    day_of_event:    s(pick(c.day_of_event)),
    time_of_event:   s(pick(c.time_of_event)),
    allocated_area:  s(pick(c.allocated_area)),
    guest_name:      s(pick(c.guest_name)),
    contact_person:  s(pick(c.contact_person)),
    phone:           s(pick(c.phone)),
    company:         s(pick(c.company)),
    reference:       s(pick(c.reference)),
    package_type:    s(pick(c.package_type)),
    mode_of_payment: s(pick(c.mode_of_payment)),
    rate_per_head:   toNumber(pick(c.rate_per_head)),
    min_guarantee:   toNumber(pick(c.min_guarantee)),
    pax_expected:    toNumber(pick(c.pax_expected)),
    approx_bill:     toNumber(pick(c.approx_bill)),
    advance_payment: toNumber(pick(c.advance_payment)),
    veg_starters:    s(pick(c.veg_starters)),
    nonveg_starters: s(pick(c.nonveg_starters)),
    veg_mains:       s(pick(c.veg_mains)),
    nonveg_mains:    s(pick(c.nonveg_mains)),
    rice:            s(pick(c.rice)),
    dal:             s(pick(c.dal)),
    salad:           s(pick(c.salad)),
    accompaniments:  s(pick(c.accompaniments)),
    desserts:        s(pick(c.desserts)),
    addon_extras:    s(pick(c.addon_extras)),
    preset_menu_text:s(pick(c.preset_menu_text)),
    other_items:     s(pick(c.other_items)),
    bar_notes:       s(pick(c.bar_notes)),
    drinks_start_time: s(pick(c.drinks_start_time)),
    drinks_end_time: s(pick(c.drinks_end_time)),
    fp_made_by:      s(pick(c.fp_made_by)),
    manager_name:    s(pick(c.manager_name)),
    kitchen_dept:    s(pick(c.kitchen_dept)),
    service_dept:    s(pick(c.service_dept)),
    bar_dept:        s(pick(c.bar_dept)),
    stores_dept:     s(pick(c.stores_dept)),
    maintenance:     s(pick(c.maintenance)),
    front_office:    s(pick(c.front_office)),
    dj:              s(pick(c.dj)),
    mc:              s(pick(c.mc)),
    mics:            s(pick(c.mics)),
    decor:           s(pick(c.decor)),
    seating:         s(pick(c.seating)),
    entertainment_notes: s(pick(c.entertainment_notes)),
    activities:      s(pick(c.activities)),
    jain_food:       s(pick(c.jain_food)),
    jain_food_pax:   toNumber(pick(c.jain_food_pax)),
    vegan_food:      s(pick(c.vegan_food)),
    vegan_food_pax:  toNumber(pick(c.vegan_food_pax)),
    spice_level:     s(pick(c.spice_level)),
    show_spice_levels: s(pick(c.show_spice_levels)),
    created_at:      s(pick(c.created_at)),
    updated_at:      s(pick(c.updated_at)),
    created_by:      s(pick(c.created_by)),
  };
}
