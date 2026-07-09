/**
 * Parent-Role / Section → KOT-station mapping.
 *
 * A user's `section` (Kitchen | Bar | Service | Maintenance | Store) filters the
 * Kitchen Display so staff only see their section's tickets. KOTs are grouped by
 * `menu_items.station` (free-text sub-stations like tandoor / liquor / cocktail),
 * so a section maps to a SET of those stations:
 *   - Bar     → the drink stations below
 *   - Kitchen → every other (food) station
 *   - Service / Maintenance / Store → no KOT surface → no filter (see all)
 *
 * Printing is already section-aware via print_stations (station → printer, with a
 * food/bar `kind` fallback), so this mapping only needs to gate the KDS view.
 */
export const BAR_STATIONS = [
  'liquor', 'cocktail', 'mocktail', 'bar', 'beer', 'wine', 'beverage', 'beverages',
];

export function isBarSection(section: string | null | undefined): boolean {
  return String(section || '').toLowerCase() === 'bar';
}
export function isKitchenSection(section: string | null | undefined): boolean {
  return String(section || '').toLowerCase() === 'kitchen';
}

/** Does a KOT with this station belong to the given section? (used by the SSE stream) */
export function sectionMatchesStation(section: string | null | undefined, station: string): boolean {
  const st = String(station || '').toLowerCase();
  if (isBarSection(section)) return BAR_STATIONS.includes(st);
  if (isKitchenSection(section)) return !BAR_STATIONS.includes(st);
  return true; // Service / Maintenance / Store / unset → no filter
}

/**
 * SQL fragment restricting a station column to the section's stations.
 * Returns an empty clause (no filter) for non-Kitchen/Bar sections.
 * `col` is the SQL expression for the (already lower-cased-safe) station column.
 */
export function sectionStationClause(
  section: string | null | undefined,
  col: string,
): { sql: string; params: string[] } {
  if (!isBarSection(section) && !isKitchenSection(section)) return { sql: '', params: [] };
  const placeholders = BAR_STATIONS.map(() => '?').join(',');
  const op = isBarSection(section) ? 'IN' : 'NOT IN';
  return { sql: ` AND LOWER(${col}) ${op} (${placeholders})`, params: [...BAR_STATIONS] };
}
