/**
 * Brewery Production — owner ruling 114 (2026-11-05).
 *
 * "Create me Other Production Page as Kitchen Production for Brewery
 *  Production … same as kitchen just Batch Number should be manual for Brewery
 *  and hint for last batch for item below the item name."
 *
 * This is the Kitchen Production screen itself, not a copy: the component
 * reads the URL and, under /brewery-production, offers only items ticked as
 * "Brewery item" (Items), lists only their batches, and lets each item's own
 * setting decide the Batch Number box. Same API (/api/kitchen-production),
 * same table, same cards, labels, scan, dashboard, reports and FIFO — so a
 * fix to one screen is a fix to both. See src/app/kitchen-production/page.tsx
 * and src/lib/production-batch-number.ts.
 *
 * Access: the same as /kitchen-production — a normal page_access grant
 * (src/lib/page-catalog.ts, Production section; Sidebar.tsx carries the twin
 * row). A role with an explicit page list sees it only once the page is ticked
 * for that role.
 */
import KitchenProductionPage from '../kitchen-production/page';

export default function BreweryProductionPage() {
  return <KitchenProductionPage />;
}
