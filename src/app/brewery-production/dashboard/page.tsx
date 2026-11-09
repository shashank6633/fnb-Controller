/**
 * Brewery Dashboard — owner ruling 122 (2026-11-09).
 *
 * "Separate Brewery Dashboard … Kitchen vs Brewery views, Brewery totals
 *  managers / HOD only."
 *
 * This is the Production Dashboard itself, not a copy: the component reads the
 * URL and, under /brewery-production, asks the dashboard API for kind=brewery
 * and links its tiles to Brewery Production — see
 * src/app/kitchen-production/dashboard/page.tsx. /kitchen-production/dashboard
 * counts Kitchen batches only.
 *
 * Access: admin, manager and HOD only — page-catalog.ts marks this path
 * mgmtOnly (so a grant of /brewery-production, which also matches this child
 * path, never opens it to staff), and the API answers 403 to anyone else on
 * its own. Sidebar.tsx carries the twin row.
 */
import KitchenProductionDashboardPage from '../../kitchen-production/dashboard/page';

export default function BreweryDashboardPage() {
  return <KitchenProductionDashboardPage />;
}
