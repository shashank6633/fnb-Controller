'use client';

import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@/lib/api';
import TabScroller from '@/components/TabScroller';
import Toggle from '@/components/Toggle';
import MenuImageUpload from './_components/MenuImageUpload';
// The admin's view of the uploaded-photo blobs, and the ONLY place in the app
// that can delete one. It used to happen by itself on every upload, which cost
// live photos; it is a deliberate, previewed action now. See the component and
// src/lib/menu-image-store.ts.
import PhotoStorageModal from './_components/PhotoStorageModal';
// THE house normalisation, imported rather than re-typed. Every reader of a
// station joins on lower(trim()) — resolveStationDepartment() included — so the
// question "is this item's station the same station as that master row?" has
// exactly one right answer and it lives in station-master.ts. (Contrast
// sanitizeCategoryName/foldCategoryName below, which had to be DUPLICATED into
// this client because menu-category.ts imports from db.ts and cannot cross the
// server boundary. station-master.ts imports no value except BAR_STATIONS from
// the pure kot-section.ts, and settings/station-departments/page.tsx already
// imports it from a 'use client' page — so this one needs no twin, and adding
// one would be the drift the comment down there is fighting.)
import { normStationKey } from '@/lib/station-master';
// The sheet parser (was inline in handleImportFile). It decides which columns
// the file actually carried — the difference between "clear this" and "the file
// never mentioned it", which is what used to wipe menu_items.station.
import { parseMenuSheet, ALL_IMPORT_COLUMNS, COLUMN_LABEL } from './import-parse';
// THE MISSING DIRECTION. Before this, `grep href="/recipes"` in this file
// returned nothing: a recipe could reach a menu item (/recipes → "Pick from Menu
// Items") but a menu item could not reach a recipe, so the 479 unlinked listings
// had no route out of this screen at all. This modal is that route.
import QuickRecipeModal, { type QuickRecipeMaterial } from '@/components/QuickRecipeModal';
import {
  Utensils,
  Plus,
  Search,
  Upload,
  Download,
  X,
  Loader2,
  AlertTriangle,
  CheckCircle,
  AlertCircle,
  Edit,
  Trash2,
  FileSpreadsheet,
  ChevronDown,
  MoreVertical,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ListOrdered,
  EyeOff,
  Eye,
  HardDrive,
  // Aliased: `Link` is also next/link, and an unaliased import of it in a file
  // that may one day want the router component is a collision waiting to happen.
  Link2 as LinkIcon,
  ListChecks,
  RefreshCw,
} from 'lucide-react';

function formatCurrency(value: number): string {
  return '₹' + value.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

// Legacy rows carry dirty item_type values like 'beverages.' (trailing dot).
// Normalize (lowercase + strip trailing non-alphanumerics) wherever the page
// filters/groups/counts by item_type so those rows match the clean options.
function normalizeType(t: string): string {
  return (t || '').toLowerCase().trim().replace(/[^a-z0-9]+$/, '');
}

/**
 * THE ONE SENTENCE THIS PAGE IS ENTITLED TO SAY ABOUT A FIGURE IT KEPT.
 * --------------------------------------------------------------------
 * Four places on this screen print a closing line after a recipe warning — the
 * FC% tooltip, the Recipe badge, the Cost cell and the edit panel — and all four
 * said the same thing: "This is a small part of the cost, so the total is still
 * broadly right." That was written for ONE fault and then applied to every
 * non-fatal one.
 *
 * It is true of a UNIT note: 100 g of an oil stocked in ml is valued at the
 * engine's own density-1 figure, so the money is out by density — a few percent.
 * It is FALSE of a QUANTITY note: 700 g of sweet chilli sauce on one plate of
 * ASIAN GREEN SALAD is 48% of that recipe's cost, and correcting it to a
 * plausible 70 g moves the dish's food cost from 74.21% to about 42%. Printing
 * "still broadly right" over that is worse than printing nothing at all, because
 * it actively tells the reader not to look.
 *
 * So the three sentences live here, once, keyed on the kind /api/menu-items
 * reports. One rule, four call sites, nothing to drift.
 */
function warningHeadline(kind: MenuItem['recipe_cost_warning_kind']): string {
  if (kind === 'quantity') return 'A QUANTITY ON THIS RECIPE IS TOO LARGE FOR ONE PORTION';
  if (kind === 'no_quantity') return 'AN INGREDIENT ON THIS RECIPE HAS NO QUANTITY';
  return 'Small unit problem on this recipe';
}

/** The short badge/pill wording for the same three states. */
function warningLabel(kind: MenuItem['recipe_cost_warning_kind']): string {
  if (kind === 'quantity') return 'check quantity';
  if (kind === 'no_quantity') return 'missing quantity';
  return 'check units';
}

function warningClosing(kind: MenuItem['recipe_cost_warning_kind']): string {
  if (kind === 'quantity') {
    return 'This is NOT a rounding matter: a quantity that size is a large share of the cost, '
      + 'so the cost and the FC% on this row move a long way if it is wrong. Open the recipe and '
      + 'check it against the plate before pricing off it. If the recipe is written for a BATCH '
      + 'rather than one portion, it is correct as it stands.';
  }
  if (kind === 'no_quantity') {
    return 'That line adds nothing, so this dish is costed as though the ingredient were not in '
      + 'it. Open the recipe and type the quantity.';
  }
  return 'This is a small part of the cost, so the total is still broadly right — but open the '
    + 'recipe and correct it.';
}

interface MenuItem {
  id: string;
  name: string;
  category: string;
  station: string;
  item_type: string;
  dietary_tag: string;
  selling_price: number;
  listing_price: number;
  item_code: string;
  tax_value: number;
  cgst_percent: number;
  sgst_percent: number;
  prep_minutes: number;
  is_active: number;
  recipe_id: string | null;
  material_id: string | null;
  source: string;
  notes: string;
  pos_id: string;
  recipe_cost?: number;
  recipe_food_cost_percent?: number;
  /** The linked recipe's quantities are rough — see src/components/QuickRecipeModal.tsx.
   *  Served by /api/menu-items alongside the cost, because the cost and the FC%
   *  on this row are derived from that recipe and are therefore rough too. */
  recipe_is_approximate?: boolean;
  recipe_name?: string;
  material_name?: string;
  material_cost?: number;
  /**
   * Why the cost on this row cannot be trusted, in the cook's own words —
   * "PRAWNS 80/100: pcs cannot be converted to kg, so 100 pcs is being priced as
   * 100 kg". Served by /api/menu-items, which re-runs the unit check over the
   * linked recipe's lines. Null when the recipe's units all convert.
   *
   * This is NOT about stale prices. Every stored recipe cost on this database
   * reproduces exactly from today's purchase averages, so no figure here is
   * waiting on the price reconcile. The unit is the problem, and 11 of the 18
   * costed dishes have one.
   */
  recipe_cost_warning?: string | null;
  /** What to do about it, one line. */
  recipe_cost_warning_fix?: string | null;
  /**
   * WHAT KIND of fault the warning is — because this page was VOUCHING for the
   * total on the strength of it.
   *
   * Every non-unusable warning got the same closing sentence: "This is a small
   * part of the cost, so the total is still broadly right." True of 'unit' (a
   * weight entered against a volume: out by density, a few percent). FALSE of
   * 'quantity' — 700 g of sweet chilli sauce in one salad is 48% of that recipe's
   * cost and moves its food cost by 32 points. Printing the reassurance over that
   * is worse than printing nothing, so the kind travels with the message and the
   * page says only what it is entitled to say. Absent when there is no warning.
   */
  recipe_cost_warning_kind?: 'unit' | 'quantity' | 'no_quantity' | null;
  /**
   * True when the bad lines are more than a quarter of the cost, or cost more
   * than the dish sells for — i.e. the figure is noise rather than merely
   * imperfect. Gongura Prawns (₹63,000 of ₹63,012 on one line) is true; Thai
   * Green Curry (₹1.67 of ₹152.24) is false and gets a quiet note instead, so
   * the loud mark still means something by the time he reaches the prawns.
   */
  recipe_cost_unusable?: boolean;
  /**
   * The linked recipe has no ingredients and no sub-recipes in it at all, so this
   * dish is linked and costs ₹0.00 — which reads exactly like a costed dish and is
   * not one. LABANESE MIZZE PLATTER is that recipe on the live database.
   */
  recipe_empty?: boolean;
}

/**
 * A recipe, as the picker needs it. /api/recipes serves a great deal more per
 * row (every ingredient line, allergens, sanity findings); this names only the
 * handful the picker actually reads, so a change to the rest of that payload
 * cannot quietly change what this screen shows.
 */
interface RecipeLite {
  id: string;
  name: string;
  category?: string;
  total_cost?: number;
  is_approximate?: boolean;
  sanity_has_blocker?: boolean;
  /** The menu item this recipe is ALREADY costed against, if any. */
  linked_menu_item_id?: string | null;
  linked_menu_item_name?: string | null;
  /** How many listings point at it — >1 means it is already shared. */
  linked_menu_count?: number;
}

/** One row of the recipe backlog — see buildBacklog() in the API route. */
interface BacklogRow {
  id: string;
  name: string;
  category: string;
  item_type: string;
  selling_price: number;
  material_id: string | null;
  material_name: string | null;
  /** Portions that left the kitchen, every bill type — the ordering key. */
  portions: number;
  /** Of those, the ones nobody paid for. They cost the same to cook. */
  portions_free: number;
  revenue: number;
  /** False when the sales import has never carried this name — NOT "sold zero". */
  has_sales: boolean;
}

/** How much sales history the portions figures are drawn from. */
interface BacklogMeta {
  sales_days: number;
  sales_from: string | null;
  sales_to: string | null;
}

interface Summary {
  total: number; active: number; inactive: number;
  foods: number; liquors: number; beverages: number;
  withRecipe: number; withMaterial: number;
  noPrice: number; noCategory: number; noStation: number; noDietaryTag: number;
  /** Active foods + beverages with no recipe, and how many there are in all.
   *  Liquor is excluded on purpose — a peg poured from a bottle wants no recipe. */
  foodsNoRecipe: number; foodsTotal: number;
}

/**
 * A row of the CATEGORY MASTER (`menu_categories`, via
 * /api/menu-items/categories). This list decides what the item form OFFERS —
 * it is not where an item's category is stored. `menu_items.category` is still
 * the plain string, so an item can legitimately carry a name that is
 * deactivated here, or absent from here entirely.
 */
interface MenuCategory {
  id: string;
  name: string;
  sort_order: number;
  is_active: number;
  item_count: number;
  /** Distinct strings the items actually store, when they are NOT all exactly
   *  this row's name (a CSV import can create that drift). Empty when they agree. */
  spellings: string[];
}

/**
 * A row of the STATION MASTER (`station_departments`, via
 * /api/settings/station-departments?list=1).
 *
 * Same relationship to the item form as MenuCategory above — this decides what
 * is OFFERED, `menu_items.station` is still the plain string that gets stored —
 * but the stakes are different, and the difference is worth stating once here
 * because it drove every choice in the Station control below.
 *
 * A CATEGORY is a LABEL: get it wrong and a dish is mis-filed on the menu.
 * A STATION IS A KEY (src/lib/station-master.ts): kot-fire.ts groups a fired
 * order by it (one KOT per station), offline-print/print.ts picks the PHYSICAL
 * PRINTER by matching it against print_stations, kot-section.ts decides from it
 * whether the ticket shows on the Bar board or the Kitchen board, and
 * dept-ledger.ts turns it into the department whose stock the recipe leaves.
 * Get it wrong and a ticket never reaches the section that had to cook it.
 *
 * That is why this control locks the value set instead of merely suggesting it,
 * and equally why it must never rewrite a value it does not recognise.
 */
interface StationMasterRow {
  /** The stored string, exactly as the master holds it — this is what a save writes. */
  station: string;
  /** false = "stop deducting stock for this station". NOT "stop cooking here":
   *  KOTs still print and still reach the section. So a paused station stays
   *  offered and is MARKED — see the Station control in EditItemModal. */
  is_active: boolean;
}

const PAGE_SIZE = 25;
const TOP_CATS = 8;   // category chips shown inline before the "All N categories" dropdown

const NEW_ITEM: MenuItem = {
  id: '', name: '', category: '', station: '', item_type: 'foods', dietary_tag: '',
  selling_price: 0, listing_price: 0, item_code: '', tax_value: 5, cgst_percent: 2.5, sgst_percent: 2.5, prep_minutes: 15,
  is_active: 1, recipe_id: null, material_id: null, source: 'manual', notes: '', pos_id: '',
};

/**
 * ONE STRAY QUOTE ATE 497 OF 500 ROWS, AND THE IMPORT SAID "SUCCESS".
 * ------------------------------------------------------------------
 * A single unbalanced double quote in any cell — a name typed as `"Chef's Special`
 * — opens a quoted field that RFC 4180 says runs until the NEXT quote. There is
 * no next quote, so every following line is swallowed into that one cell. The
 * sheet that comes out is perfectly well formed: 3 rows instead of 500, the same
 * ten columns, `isTemplate` false. Nothing downstream can tell. Measured on a
 * 500-row file in the app's own export format:
 *
 *     leading quote in row 3 → 3 data rows, 497 lost, last cell 26,778 chars
 *     POST /api/menu-items/import → HTTP 200, errors: []
 *
 * Only the raw text knows, so it is checked here, before anything is previewed.
 *
 * THE TEST IS AN UNCLOSED QUOTE, NOT A NEWLINE IN A CELL — and it took a second
 * pass to get right, so the reasoning is kept here rather than re-derived.
 *
 * This guard used to refuse on "any cell contains a line break", justified by the
 * claim that no column this import accepts may legitimately hold one, "so a cell
 * that holds one is a broken file with no false-positive case to weigh". The
 * second half does not follow from the first. A CSV out of Excel or Google Sheets
 * may carry an EXTRA column the importer ignores entirely — the accepted set is
 * name + the ten in COLUMN_LABEL, so a "Notes" or "Description" column is read by
 * nothing — and a properly-closed quoted cell in it may contain a line break. The
 * parser handles that perfectly: measured on a 500-row file whose row 3 held a
 * valid two-line quoted Notes cell, XLSX produced all 500 rows and parseMenuSheet
 * returned 500 items — and this guard then refused the entire import, claiming an
 * unclosed quote "and nothing after it can be read". Nothing was wrong and
 * nothing was imported.
 *
 * The discriminator that actually separates the two cases was ALREADY COMPUTED
 * in this function and then thrown away: walk the text as a CSV reader (doubled
 * quotes are literal) and ask whether a quoted field is still OPEN at end of
 * file. True for the stray-quote file that ate 497 rows; false for a valid
 * multi-line cell; false for a clean file. That walk is now what decides, and
 * the newline scan is kept only to DESCRIBE the damage.
 *
 * Fails closed either way — nothing is imported while a refusal stands — and the
 * 497-row bug is still caught, which is the point: the fix narrows the refusal to
 * the fault, it does not soften it. .xlsx and .xls never reach this at all: the
 * caller passes csvText only for text files.
 *
 * Refused rather than warned. A warning on a 500-row import is a warning read
 * after the 3 rows have already gone in.
 */
function findCsvQuoteFault(text: string, rows: unknown[][]): string | null {
  // ── THE DECIDING TEST: is a quoted field still open at end of file? ────────
  // Walked exactly as a CSV reader does, so a doubled "" inside a quoted cell is
  // a literal quote and does not toggle the state.
  let inQuotes = false, line = 1, openedAtLine = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (inQuotes && text[i + 1] === '"') { i++; continue; }
      if (!inQuotes) openedAtLine = line;
      inQuotes = !inQuotes;
    } else if (c === '\n') {
      line++;
    }
  }
  // Balanced quotes ⇒ every quoted cell was closed ⇒ the parser read what the
  // file said, line breaks inside cells included. Nothing to refuse.
  if (!inQuotes) return null;

  // ── From here the file IS broken. The rest only describes how badly. ───────
  let worst: { rowIndex: number; colIndex: number; lines: number } | null = null;
  rows.forEach((row, rowIndex) => {
    if (!Array.isArray(row)) return;
    row.forEach((cell, colIndex) => {
      if (typeof cell !== 'string' || !/[\r\n]/.test(cell)) return;
      const lines = cell.split(/\r\n|\r|\n/).length;
      if (!worst || lines > worst.lines) worst = { rowIndex, colIndex, lines };
    });
  });
  // An unclosed quote at the very END of the file can leave no swallowed cell to
  // point at, so the message degrades to the fault itself rather than vanishing.
  const { rowIndex, colIndex, lines } = (worst ?? { rowIndex: -1, colIndex: -1, lines: 0 }) as
    { rowIndex: number; colIndex: number; lines: number };

  // Physical lines in the file vs rows the parser produced: the size of the hole.
  const physicalRows = text.split(/\r\n|\r|\n/).filter(l => l.trim() !== '').length;
  const lost = Math.max(0, physicalRows - rows.length);

  return [
    `This file has an unclosed double quote${openedAtLine ? ` — it starts on line ${openedAtLine}` : ''}, and nothing after it can be read.`,
    lost > 0 && lines > 0
      ? ` ${lost.toLocaleString('en-IN')} of the ${physicalRows.toLocaleString('en-IN')} lines in the file were swallowed into a single cell (row ${rowIndex + 1}, column ${colIndex + 1}, now ${lines.toLocaleString('en-IN')} lines long), so only ${Math.max(0, rows.length - 1).toLocaleString('en-IN')} items would have been imported.`
      : lines > 0
        ? ` One cell (row ${rowIndex + 1}, column ${colIndex + 1}) has swallowed ${lines.toLocaleString('en-IN')} lines of the file.`
        // No swallowed cell to point at — an unclosed quote right at the end of
        // the file. Say the count that is actually known instead of inventing a
        // cell reference of row 0, column 0.
        : ` The file has ${physicalRows.toLocaleString('en-IN')} lines and the parser could read ${rows.length.toLocaleString('en-IN')}.`,
    ' Nothing has been imported. Open the file, find the " that has no partner, and either remove it or double it ("") to keep it in the text — then upload again.',
  ].join('');
}

export default function MenuItemsPage() {
  const [items, setItems] = useState<MenuItem[]>([]);
  const [summary, setSummary] = useState<Summary>({ total: 0, active: 0, inactive: 0, foods: 0, liquors: 0, beverages: 0, withRecipe: 0, withMaterial: 0, noPrice: 0, noCategory: 0, noStation: 0, noDietaryTag: 0, foodsNoRecipe: 0, foodsTotal: 0 });
  const [categories, setCategories] = useState<string[]>([]);
  const [stations, setStations] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [stationFilter, setStationFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [vegFilter, setVegFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('active');
  const [issueFilter, setIssueFilter] = useState<string | null>(null);
  /**
   * RECIPE FILTER — '' | 'linked' | 'unlinked'.
   *
   * 479 of the 497 live listings have no recipe, so "which of these are costed?"
   * cannot be answered by scrolling; it needs a filter. This one is on the ADMIN
   * menu-items list and nowhere else. It does not, and must never, exist on a
   * surface a guest or a captain orders from: a dish with no recipe still
   * appears, still sells and still prints. It starts EMPTY (every item shown) and
   * only an explicit click narrows it.
   */
  const [linkFilter, setLinkFilter] = useState<'' | 'linked' | 'unlinked'>('');

  // Import
  const [importOpen, setImportOpen] = useState(false);
  const [importFileName, setImportFileName] = useState<string | null>(null);
  const [importPreview, setImportPreview] = useState<any>(null);
  const [importPayload, setImportPayload] = useState<any>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<any>(null);
  const [importSkipInactive, setImportSkipInactive] = useState(false);
  const [importSkipZero, setImportSkipZero] = useState(false);
  const [importOverwrite, setImportOverwrite] = useState(true);
  // EXPLICIT opt-in (default OFF) for the recipe template's category→station
  // map: only items with NO station get one, only names on the station master
  // are written, and the server refuses the rest. Off = a sheet with no
  // Station column touches no station at all.
  const [importFillStation, setImportFillStation] = useState(false);
  const importFileRef = useRef<HTMLInputElement>(null);

  // Edit modal
  const [editItem, setEditItem] = useState<MenuItem | null>(null);

  /**
   * QUICK RECIPE. The menu item whose recipe is being written, and the material
   * list that screen picks from.
   *
   * Materials are fetched LAZILY — only when the modal is first opened. This
   * page is the menu list; loading 952 materials on every visit to pay for a
   * modal most visits never open would be a regression for everyone.
   */
  const [quickFor, setQuickFor] = useState<MenuItem | null>(null);
  const [materials, setMaterials] = useState<QuickRecipeMaterial[]>([]);
  const [materialsState, setMaterialsState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  /**
   * Can a recipe be SAVED as approximate on this database? Served by
   * /api/menu-items. It is false when the recipes table has no "approximate"
   * column yet, and in that state a simple recipe must not be written at all: an
   * unmarked rough cost is worse than no cost, because it looks measured.
   */
  const [approximateSupported, setApproximateSupported] = useState(true);

  const openQuickRecipe = useCallback(async (item: MenuItem) => {
    setQuickFor(item);
    if (materialsState === 'ready' || materialsState === 'loading') return;
    setMaterialsState('loading');
    try {
      // Same endpoint and same envelope /recipes already reads for its own
      // ingredient picker (src/app/recipes/page.tsx:503), so the two screens
      // pick from one list rather than two that can disagree.
      const res = await fetch('/api/inventory');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      // RETIRED MATERIALS STAY OUT OF THE SEARCH. The suggestion chips already
      // skip them (src/lib/recipe-suggest.ts), but the "Add another material"
      // typeahead searched all 952 rows including the ones nobody buys any
      // more — so the two halves of one screen offered different lists, and the
      // half that offered more was the wrong one. `is_active` is only trusted
      // when the row actually carries it; a payload without the field is left
      // alone rather than filtered to nothing.
      const all = (j.materials || []) as QuickRecipeMaterial[];
      setMaterials(all.filter((m) => m.is_active === undefined || m.is_active === null || !!Number(m.is_active)));
      setMaterialsState('ready');
    } catch {
      setMaterialsState('error');
    }
  }, [materialsState]);

  // Bulk category rename (admin only). The server gate on
  // /api/menu-items/rename-category is the real boundary — this only decides
  // whether to offer a button that a non-admin's click would always 403.
  const [renameOpen, setRenameOpen] = useState(false);
  const [me, setMe] = useState<{ role?: string } | null>(null);
  const isAdmin = me?.role === 'admin';
  /**
   * May this person write a recipe? POST /api/recipes is manager/admin only, and
   * that server gate is the real boundary — this only decides whether to offer a
   * button. Without it a waiter could fill in a whole quick recipe and be told
   * "Manager or admin only" at the save, having lost the lot. The badge still
   * SAYS "no recipe" for everyone: knowing which dishes are uncosted is not a
   * privilege, writing the recipe is.
   */
  const canWriteRecipes = me?.role === 'admin' || me?.role === 'manager';

  // The CATEGORY MASTER. Loaded for EVERY user, not just admins: the item form's
  // dropdown is built from it, so a non-admin editing a price still needs it.
  // include_inactive=1 because a deactivated category must still be recognised —
  // an item sitting on one has to be shown its own value, marked, or opening the
  // item to change its price would silently change its category on save.
  const [menuCats, setMenuCats] = useState<MenuCategory[]>([]);
  const [catOrphans, setCatOrphans] = useState<{ name: string; item_count: number }[]>([]);
  const [manageCatsOpen, setManageCatsOpen] = useState(false);
  const [renameInitial, setRenameInitial] = useState('');

  // Dish-photo storage (admin only, like the category master beside it — the
  // /api/menu-items/image/orphans routes require admin and this only decides
  // whether to offer a button whose every click would otherwise 403).
  const [photoStorageOpen, setPhotoStorageOpen] = useState(false);

  // The STATION MASTER, for the item form's Station dropdown. Loaded for every
  // signed-in user for the same reason the category master is: a non-admin
  // editing a price still opens the form, and a form whose dropdown cannot show
  // the item's own station is a form that loses it on save.
  //
  // `stationsLoaded` is NOT a formality. If this fetch fails the offered list is
  // empty, and an empty list next to a stored value is exactly the situation
  // that rewrites data on save — so the control DISABLES itself rather than
  // guess. Failing closed here costs an admin one reload; failing open costs a
  // ticket that never printed.
  const [stationMaster, setStationMaster] = useState<StationMasterRow[]>([]);
  const [stationSentinels, setStationSentinels] = useState<string[]>([]);
  const [stationsLoaded, setStationsLoaded] = useState(false);

  /**
   * THE PROMPT. The menu item that was just created or just saved, waiting to be
   * asked about its recipe.
   *
   * It is set AFTER the save has already succeeded and the form has already
   * closed, which is the whole design: the item exists, it is on the menu, it
   * sells and it prints, and nothing about this prompt can change that. It is a
   * card in the corner, not a dialog — it covers nothing, blocks nothing, and
   * "Not now" costs exactly one click and nothing else. Someone adding a dish in
   * the middle of service is never held up by it.
   */
  /**
   * Held as an ID, not as the row. POST/PUT /api/menu-items return the raw
   * menu_items row, which has no `recipe_name` — that only exists on the GET's
   * join — so a card built from the response would have to say "the recipe it is
   * linked to" instead of naming it. The list is refetched a line earlier
   * anyway, so the row is resolved at render time from `items`, where it is
   * complete and stays current if anything else changes it.
   */
  const [recipePrompt, setRecipePrompt] = useState<{ id: string; created: boolean } | null>(null);

  /**
   * LINK AN EXISTING RECIPE. The menu item doing the claiming, and the recipe
   * book to claim from.
   *
   * The third answer to the prompt, and the one the owner's direction actually
   * requires. "Thecha Tandoori Murgh" may already have a recipe written under
   * "Tandoori Chicken"; writing a second one would leave this kitchen with two
   * recipes for one dish and two food costs to argue about. Linking is a PUT on
   * the MENU ITEM (recipe_id) — the menu item reaches out and claims the recipe.
   * The recipe still decides nothing about what is on the menu.
   *
   * Fetched lazily, like the materials above: the costed recipe book is not a
   * payload to load on every visit to a 628-row menu list.
   */
  const [linkFor, setLinkFor] = useState<MenuItem | null>(null);
  const [recipeBook, setRecipeBook] = useState<RecipeLite[]>([]);
  const [recipeBookState, setRecipeBookState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  const openLinkRecipe = useCallback(async (item: MenuItem) => {
    setLinkFor(item);
    if (recipeBookState === 'ready' || recipeBookState === 'loading') return;
    setRecipeBookState('loading');
    try {
      const res = await fetch('/api/recipes');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      setRecipeBook((j.recipes || []) as RecipeLite[]);
      setRecipeBookState('ready');
    } catch {
      setRecipeBookState('error');
    }
  }, [recipeBookState]);

  /**
   * THE BACKLOG. Active dishes with no recipe, worst first — the list the owner
   * works through.
   *
   * Served by /api/menu-items?backlog=1 and fetched only when the panel is
   * opened. The plain menu read stays exactly as fast as it was, which matters
   * because that same endpoint is what the captain POS and the dine-in order
   * pads call on a tablet over venue wifi.
   */
  const [backlogOpen, setBacklogOpen] = useState(false);
  const [backlog, setBacklog] = useState<BacklogRow[] | null>(null);
  const [backlogMeta, setBacklogMeta] = useState<BacklogMeta | null>(null);
  const [backlogState, setBacklogState] = useState<'idle' | 'loading' | 'ready' | 'error' | 'denied'>('idle');

  const [toast, setToast] = useState<{ msg: string; error?: boolean } | null>(null);

  const showToast = useCallback((msg: string, error = false) => {
    setToast({ msg, error });
    setTimeout(() => setToast(null), error ? 3500 : 2000);
  }, []);

  // Pagination + category dropdown + search focus
  const [page, setPage] = useState(1);
  const [catMenuOpen, setCatMenuOpen] = useState(false);
  const [catSearch, setCatSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const fetchItems = useCallback(async () => {
    try {
      const res = await fetch('/api/menu-items');
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as any));
        showToast(j.error || `Failed to load menu items (HTTP ${res.status})`, true);
        return;
      }
      const json = await res.json();
      setItems(json.items || []);
      setSummary(prev => json.summary || prev);
      setCategories(json.categories || []);
      setStations(json.stations || []);
      // Absent on an older server → assume it works, which is the behaviour this
      // page had before the flag existed.
      setApproximateSupported(json.approximate_supported !== false);
    } catch {
      showToast('Failed to load menu items — check your connection', true);
    }
  }, [showToast]);

  /**
   * Bumped whenever a dish gains a recipe — the quick recipe saving, or an
   * existing recipe being linked. The backlog reloads off it, so the row the
   * owner just finished leaves the list and the count drops, without every
   * caller of fetchItems() having to remember to refresh a panel it knows
   * nothing about.
   */
  const [recipeLinkNonce, setRecipeLinkNonce] = useState(0);

  /**
   * The backlog, loaded only while its panel is open.
   *
   * `cancelled` is not ceremony: opening the panel, finishing a dish and having
   * the nonce fire a second fetch leaves two responses in flight, and the slower
   * one is the STALE one — it would put the finished dish back on the list.
   */
  useEffect(() => {
    if (!backlogOpen) return;
    let cancelled = false;
    (async () => {
      setBacklogState(s => (s === 'ready' ? 'ready' : 'loading'));
      try {
        const res = await fetch('/api/menu-items?backlog=1');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        if (cancelled) return;
        if (j.backlog_denied || !Array.isArray(j.backlog)) {
          // The server declined to compute it (not a manager). Say so plainly
          // rather than showing an empty list that reads as "nothing left to do".
          setBacklogState(j.backlog_denied ? 'denied' : 'error');
          return;
        }
        setBacklog(j.backlog as BacklogRow[]);
        setBacklogMeta((j.backlog_meta as BacklogMeta) || null);
        // The same response carries the fresh summary and rows, so the count in
        // the panel header and the rows under it are from one read of the
        // database and cannot disagree with each other.
        if (j.summary) setSummary(j.summary);
        if (Array.isArray(j.items)) setItems(j.items);
        setBacklogState('ready');
      } catch {
        if (!cancelled) setBacklogState('error');
      }
    })();
    return () => { cancelled = true; };
  }, [backlogOpen, recipeLinkNonce]);

  // The category master. A failure here is NOT silent: without it the item
  // form's dropdown would be empty, and an empty dropdown next to a stored
  // category is exactly the situation that loses data on save.
  const fetchCats = useCallback(async () => {
    try {
      const res = await fetch('/api/menu-items/categories?include_inactive=1');
      if (!res.ok) {
        const j: { error?: string } = await res.json().catch(() => ({}));
        showToast(j.error || `Failed to load categories (HTTP ${res.status})`, true);
        return;
      }
      const json: { categories?: MenuCategory[]; orphans?: { name: string; item_count: number }[] } = await res.json();
      setMenuCats(json.categories || []);
      setCatOrphans(json.orphans || []);
    } catch {
      showToast('Failed to load categories — check your connection', true);
    }
  }, [showToast]);

  /**
   * The station master. `?list=1` asks for the master alone — no union with the
   * stations found in order/KOT data, and none of the settings dashboard's
   * aggregates. The union is right for the Settings screen (it makes an unmapped
   * station visible) and wrong here: it would re-offer any stray value already
   * in the data, which is the self-fulfilling list this dropdown replaces.
   *
   * Failure is LOUD and leaves stationsLoaded false, which disables the control.
   */
  const fetchStations = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/station-departments?list=1');
      if (!res.ok) {
        const j: { error?: string } = await res.json().catch(() => ({}));
        showToast(j.error || `Failed to load stations (HTTP ${res.status})`, true);
        return;
      }
      const json: { stations?: StationMasterRow[]; reserved?: { sentinel?: string[] } } = await res.json();
      setStationMaster(json.stations || []);
      setStationSentinels(json.reserved?.sentinel || []);
      setStationsLoaded(true);
    } catch {
      showToast('Failed to load stations — check your connection', true);
    }
  }, [showToast]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await Promise.all([fetchItems(), fetchCats(), fetchStations()]);
      setLoading(false);
    })();
  }, [fetchItems, fetchCats, fetchStations]);

  // Effective role — used ONLY to decide whether to show the "Rename category"
  // control. Failure is silent and simply hides it; the API's own 403 is the
  // boundary, never this.
  useEffect(() => {
    fetch('/api/auth/me').then(r => r.json()).then(d => setMe(d?.user || null)).catch(() => {});
  }, []);

  /**
   * DOES THIS ITEM WANT A RECIPE AT ALL?
   *
   * Foods and beverages do — they are cooked or made from stock. Liquor does not:
   * a peg is poured from a bottle and is costed on the store rail, so counting
   * 245 liquor rows as "missing a recipe" turns a real, actionable gap of 234
   * dishes into a wall of 479 that means nothing. One rule, used by the badge,
   * the filter and the counts alike, so all three always agree.
   */
  const wantsRecipe = useCallback((it: MenuItem) => {
    const t = normalizeType(it.item_type);
    return t === 'foods' || t === 'beverages';
  }, []);

  // Filtering
  const filteredItems = useMemo(() => {
    return items.filter((it) => {
      const q = searchQuery.toLowerCase().trim();
      if (q && !it.name.toLowerCase().includes(q) && !it.item_code.toLowerCase().includes(q)) return false;
      if (categoryFilter && it.category !== categoryFilter) return false;
      if (stationFilter && it.station !== stationFilter) return false;
      if (typeFilter && normalizeType(it.item_type) !== typeFilter) return false;
      if (vegFilter && it.dietary_tag !== vegFilter) return false;
      if (statusFilter === 'active' && !it.is_active) return false;
      if (statusFilter === 'inactive' && it.is_active) return false;

      // Linked / Not linked. An ADMIN view filter on an admin list — it changes
      // what this screen shows and nothing else. No menu, bill or KOT anywhere
      // consults a recipe to decide whether an item exists.
      if (linkFilter === 'linked' && !it.recipe_id) return false;
      if (linkFilter === 'unlinked' && (it.recipe_id || !wantsRecipe(it))) return false;

      // Issue filter
      if (issueFilter) {
        switch (issueFilter) {
          case 'noPrice': if (it.selling_price > 0) return false; break;
          case 'noCategory': if (it.category) return false; break;
          case 'noStation': if (it.station) return false; break;
          case 'noDietaryTag': if (normalizeType(it.item_type) !== 'foods' || it.dietary_tag) return false; break;
          // Matches the banner's count exactly: a DISH with no recipe. It used to
          // treat a material_id as "linked", which counted Butter Chicken pointed
          // at Butter as done — nothing in the sale path reads that mapping, so
          // the dish still costs ₹0.
          case 'noRecipe': if (it.recipe_id || !wantsRecipe(it)) return false; break;
          case 'any': {
            const bad = !(it.selling_price > 0)
              || (normalizeType(it.item_type) === 'foods' && !it.dietary_tag)
              || (wantsRecipe(it) && !it.recipe_id);
            if (!bad) return false;
            break;
          }
        }
      }
      return true;
    });
  }, [items, searchQuery, categoryFilter, stationFilter, typeFilter, vegFilter, statusFilter, issueFilter, linkFilter, wantsRecipe]);

  // Attention counts — distinct items + per-issue (drives the banner)
  const attn = useMemo(() => {
    let noPrice = 0, noVeg = 0, noLink = 0; const bad = new Set<string>();
    for (const it of items) {
      let issue = false;
      if (!(it.selling_price > 0)) { noPrice++; issue = true; }
      if (normalizeType(it.item_type) === 'foods' && !it.dietary_tag) { noVeg++; issue = true; }
      // DISHES only, and a recipe is the only thing that counts as linked — see
      // wantsRecipe above and the noRecipe filter that has to match this number.
      if (wantsRecipe(it) && !it.recipe_id) { noLink++; issue = true; }
      if (issue) bad.add(it.id);
    }
    return { noPrice, noVeg, noLink, total: bad.size };
  }, [items, wantsRecipe]);

  /**
   * Costed dishes whose cost is provably WRONG — the linked recipe contains a
   * quantity in a unit the system cannot convert, so the money on that line is
   * computed in the wrong unit (100 pcs of prawns priced as 100 kg). Counted over
   * everything loaded, not the current page, because the point is to say how many
   * there are before he trusts a single figure on this screen.
   */
  const untrustedCost = useMemo(
    () => items.filter(it => it.is_active && it.recipe_cost_unusable).length,
    [items],
  );

  // TRUE per-category counts, taken from the UNFILTERED list. The chip counts
  // further down are view-scoped (they honour the active/station/search
  // filters); a rename moves every row on the old string regardless, so the
  // rename dialog must quote these or it promises "12 items" and renames 30.
  const globalCatCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const it of items) { const k = it.category; if (k) m[k] = (m[k] || 0) + 1; }
    return m;
  }, [items]);

  // What the rename dialog may pick FROM, and what it treats as a clash: the
  // master's names UNION the strings items actually carry. Both halves are
  // needed. A master row with no items yet (just added, or emptied) has to be
  // renameable — the server allows it. A string that is on items but absent from
  // the master (a legacy value) has to be renameable too, and must still block a
  // rename onto it. Exact strings, never folded: the fold belongs to the clash
  // check, and picking a folded name would rename a different set of rows.
  const renameCandidates = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of menuCats) if (!seen.has(c.name)) { seen.add(c.name); out.push(c.name); }
    for (const c of categories) if (!seen.has(c)) { seen.add(c); out.push(c); }
    return out.sort((a, b) => a.localeCompare(b));
  }, [menuCats, categories]);

  // Activating a health filter also drops the active-only scope, so the drill-down
  // reveals every flagged item the banner counted (incl. inactive ones).
  const reviewIssue = (key: string) => {
    if (issueFilter === key) { setIssueFilter(null); }
    else { setIssueFilter(key); setStatusFilter('all'); }
  };

  // Pagination (reset to page 1 whenever the filtered set changes)
  useEffect(() => { setPage(1); }, [searchQuery, categoryFilter, stationFilter, typeFilter, vegFilter, statusFilter, issueFilter, linkFilter]);
  const pageCount = Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageItems = filteredItems.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // "/" focuses the search box (but never while a modal is open)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // `quickFor` belongs on this list as much as the others: the quick-recipe
      // screen's suggestion chips are <button>s, so with focus on one, "/" passed
      // the tag test and pulled focus to the search box BEHIND the backdrop —
      // typing then went nowhere the cook could see.
      if (editItem || importOpen || renameOpen || manageCatsOpen || quickFor) return;
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      if (e.key === '/' && tag !== 'input' && tag !== 'textarea' && tag !== 'select') {
        e.preventDefault(); searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editItem, importOpen, renameOpen, manageCatsOpen, quickFor]);

  // Import handling
  const openImport = () => {
    setImportOpen(true);
    setImportFileName(null);
    setImportPreview(null);
    setImportPayload(null);
    setImportResult(null);
  };

  const handleImportFile = async (file: File) => {
    setImportResult(null);
    setImportFileName(file.name);

    try {
      const XLSX = await import('xlsx');
      const buffer = await file.arrayBuffer();
      // Decode guard: xlsx treats BOM-less CSV text as CP1252, which mojibakes
      // UTF-8 bytes — our own exports carried no BOM until 2026-09, so files
      // downloaded before then corrupt non-ASCII names on reimport. If the
      // upload is not a binary workbook and its bytes strictly validate as
      // UTF-8, decode them ourselves and hand xlsx the string. Pure-ASCII text
      // decodes identically on both paths; genuine CP1252 (Excel "CSV (ANSI)")
      // fails the strict check and keeps the old path; .xlsx (PK zip) and .xls
      // (CFB) never reach the text decoder.
      const bytes = new Uint8Array(buffer);
      const isBinaryWorkbook =
        (bytes[0] === 0x50 && bytes[1] === 0x4b) || // .xlsx — zip magic "PK"
        (bytes[0] === 0xd0 && bytes[1] === 0xcf);   // .xls — CFB magic
      let decodedText: string | null = null;
      if (!isBinaryWorkbook) {
        try {
          decodedText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          decodedText = null; // not valid UTF-8 — let xlsx apply its default
        }
      }
      const wb = decodedText !== null
        ? XLSX.read(decodedText, { type: 'string' })
        : XLSX.read(buffer, { type: 'array' });
      // The text the CSV guard reads. For a CP1252 file (decodedText null but not
      // a workbook) decode it leniently — the guard only needs line positions.
      const csvText = isBinaryWorkbook
        ? null
        : (decodedText ?? new TextDecoder('windows-1252').decode(bytes));

      // Detect format: Akan POS export, AKAN Recipe Template, or generic
      let sheetName = wb.SheetNames.find(n => /existing.*product|products/i.test(n))
        || wb.SheetNames.find(n => /^menu.?items?$/i.test(n))
        || wb.SheetNames[0];
      const sheet = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json<any>(sheet, { header: 1, defval: null });

      // ── THE STRAY QUOTE. Checked BEFORE anything is previewed. ─────────────
      // One unbalanced double quote silently ate 497 of 500 rows and the import
      // still reported success. Nothing downstream can see it — the parser gets a
      // well-formed 3-row sheet and says so. Only the raw text knows.
      if (csvText !== null) {
        const fault = findCsvQuoteFault(csvText, rows);
        if (fault) {
          setImportPreview(null);
          setImportPayload(null);
          setImportResult({ error: fault });
          return;
        }
      }

      // The parser lives in ./import-parse so the "an absent column preserves,
      // it does not erase" rule can be executed and checked outside React.
      const { rows: parsedRows, isTemplate, presentColumns } = parseMenuSheet(rows);
      const has = (c: string) => presentColumns.includes(c);

      // Compute preview stats
      const active = parsedRows.filter(r => r.master_status?.toLowerCase() !== 'inactive').length;
      const withTypos = parsedRows.filter(r => /COSMOPOLTIAN|GLENMORNGIE|HEINKEIN|HOEGARDEN|BUDWISER|VERMOTH|EXPRESSO|TOBASCO|CARDMOM|BTTL/i.test(r.name)).length;
      const withExtraSpaces = parsedRows.filter(r => r.name !== r.name.replace(/\s+/g, ' ').trim() || /  /.test(r.name)).length;
      // Only meaningful when the sheet HAS the column: a file with no price
      // column has no ₹0 in it, and counting one per row read as "this import
      // will zero 600 prices" — which is exactly what it used to do. Counted as
      // LITERAL zeros only: a blank price cell is omitted by the parser and
      // preserves the item's price, so it is not a ₹0 the skip switch acts on.
      const withZeroPrice = has('selling_price') ? parsedRows.filter(r => r.selling_price === 0).length : 0;
      const foodsNoTag = has('dietary_tag') ? parsedRows.filter(r => r.item_type === 'foods' && !r.dietary_tag).length : 0;

      // In-file duplicates
      const nameCounts = new Map<string, number>();
      for (const r of parsedRows) {
        const key = r.name.toLowerCase().trim();
        nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
      }
      const dupes = [...nameCounts.entries()].filter(([, n]) => n > 1).length;

      setImportPreview({
        total: parsedRows.length,
        active, inactive: parsedRows.length - active,
        typos: withTypos, spaces: withExtraSpaces,
        zeroPrice: withZeroPrice, foodsNoTag, duplicates: dupes,
        categories: [...new Set(parsedRows.map(r => r.category).filter(Boolean))].length,
        // Columns this file does NOT have. Named BEFORE the upload, because
        // "what will this import leave alone?" is the question the Overwrite
        // switch actually asks.
        missingColumns: ALL_IMPORT_COLUMNS.filter(c => !presentColumns.includes(c)).map(c => COLUMN_LABEL[c]),
      });
      setImportPayload({ rows: parsedRows, isTemplate, present_columns: presentColumns });
    } catch (err: any) {
      setImportResult({ error: err.message });
    }
  };

  const submitImport = async () => {
    if (!importPayload) return;
    setImporting(true);
    setImportResult(null);
    try {
      const res = await api('/api/menu-items/import', {
        method: 'POST',
        body: {
          ...importPayload,
          overwrite_existing: importOverwrite,
          fix_typos: true,
          strip_spaces: true,
          skip_inactive: importSkipInactive,
          skip_zero_price: importSkipZero,
          // Food menus (template format) link to recipes only — never auto-link a
          // dish to a raw material by prefix (a soup must not become "TOMATO KETCHUP").
          link_materials: !importPayload.isTemplate,
          // The category→station map fill runs ONLY when its checkbox below is
          // ticked. Unticked (the default), a sheet with no Station column
          // leaves every station exactly as it is — new items included.
          fill_station_from_category: importFillStation,
        },
      });
      const json = await res.json();
      setImportResult(json);
      if (json.items_created > 0 || json.items_updated > 0) {
        await fetchItems();
      }
      // Independently of items: a file can add categories to the master (an
      // unknown category is accepted and created) even on a run where every row
      // was an unchanged update, so the picker must refresh either way.
      if (json.created_categories?.length) await fetchCats();
    } catch (err: any) {
      setImportResult({ error: err.message });
    } finally {
      setImporting(false);
    }
  };

  const deleteItem = async (id: string) => {
    if (!confirm('Delete this menu item?')) return;
    try {
      const res = await api(`/api/menu-items?id=${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as any));
        showToast(j.error || `Delete failed (HTTP ${res.status})`, true);
        return;
      }
    } catch {
      showToast('Delete failed — check your connection', true);
      return;
    }
    await fetchItems();
    showToast('Item deleted');
  };

  const toggleActive = async (item: MenuItem) => {
    try {
      const res = await api('/api/menu-items', {
        method: 'PUT',
        body: { id: item.id, is_active: !item.is_active },
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as any));
        showToast(j.error || `Update failed (HTTP ${res.status})`, true);
        return;
      }
    } catch {
      showToast('Update failed — check your connection', true);
      return;
    }
    await fetchItems();
  };

  // Handles both create (editItem.id === '') and update. Returns null on
  // success, or an error message — the modal stays open and shows it, so a
  // failed save never silently discards the user's edits.
  const saveEdit = async (updates: Partial<MenuItem>, then?: 'quick' | 'link'): Promise<string | null> => {
    if (!editItem) return null;
    const isNew = !editItem.id;
    let saved: MenuItem | null = null;
    try {
      const res = await api('/api/menu-items', {
        method: isNew ? 'POST' : 'PUT',
        body: isNew ? updates : { id: editItem.id, ...updates },
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as any));
        return j.error || `Save failed (HTTP ${res.status})`;
      }
      // The row as the SERVER stored it. Both handlers return { item }, and this
      // used to be thrown away — which is why a newly created dish could not be
      // offered a recipe: the screen did not have its id. A body that fails to
      // parse is not an error; the save already succeeded, we simply skip the
      // prompt rather than invent an id.
      const j = await res.json().catch(() => ({} as any));
      saved = (j?.item as MenuItem) || null;
    } catch {
      return 'Save failed — check your connection';
    }
    setEditItem(null);
    await fetchItems();
    showToast(isNew ? 'Item created' : 'Saved');

    /**
     * THE RECIPE PROMPT — raised here, AFTER the item is safely saved.
     *
     * The owner's rule is that the menu item comes first and the recipe is made
     * from it, so this is the only correct moment: the dish exists, it is on the
     * menu, it will sell and print whether or not anybody answers this. Every
     * path out of the prompt — "Not now", the ✕, ignoring it entirely — leaves
     * the saved item exactly as it is. There is no version of this that can
     * cost someone a dish during service.
     *
     * Only for items that WANT a recipe (a bottle of whisky does not), and only
     * for someone allowed to write one — the server lets managers and admins
     * write recipes, and offering the button to anyone else is offering a
     * refusal. Everyone still SEES the linked/not-linked state on the list.
     */
    if (saved && saved.id && wantsRecipe(saved) && canWriteRecipes) {
      /**
       * The editor's own recipe buttons come through here with `then` set: the
       * person has already ANSWERED the question this prompt asks, so asking it
       * again would be a card in the corner saying "shall we?" over the screen
       * that is already doing it. They go straight to the screen they chose.
       *
       * `saved` is the server's row for this id, so both screens are bound to
       * the item that was actually stored — not to the form that was typed.
       */
      if (then === 'quick') openQuickRecipe(saved);
      else if (then === 'link') openLinkRecipe(saved);
      else setRecipePrompt({ id: saved.id, created: isNew });
    }
    return null;
  };

  /**
   * LINK AN EXISTING RECIPE TO THIS MENU ITEM.
   *
   * Written as a PUT on the MENU ITEM, not a PUT on the recipe, and that is the
   * owner's direction expressed in the wire format: the menu item is the thing
   * that exists, and it reaches out and claims a recipe. PUT /api/menu-items
   * already does everything that has to happen — it reads the previous link
   * first and re-costs BOTH recipes, so the one that just lost this listing
   * falls back to its own price instead of keeping a food cost measured against
   * a menu price it no longer owns (src/app/api/menu-items/route.ts).
   *
   * Returns null on success or the error STRING, same contract as saveEdit, so
   * a refusal lands in the picker's own banner rather than vanishing behind a
   * closed dialog.
   */
  const linkRecipe = async (itemId: string, recipeId: string): Promise<string | null> => {
    try {
      const res = await api('/api/menu-items', { method: 'PUT', body: { id: itemId, recipe_id: recipeId } });
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as any));
        return j.error || `Could not link the recipe (HTTP ${res.status})`;
      }
    } catch {
      return 'Could not link the recipe — check your connection';
    }
    setLinkFor(null);
    await fetchItems();
    // The backlog is one dish shorter now. Bumping the nonce reloads it from the
    // server rather than splicing the row out client-side — the count on screen
    // is then the database's count, not this page's arithmetic about it.
    setRecipeLinkNonce(n => n + 1);
    return null;
  };

  /**
   * A backlog row, as the recipe screens want it.
   *
   * Prefers the real menu_items row already in `items` — it carries the station,
   * the tax fields and the current recipe link, and using it means the quick
   * recipe screen is looking at exactly what the list is looking at. The
   * synthesized fallback exists only for the case where the backlog response
   * arrived and the items array has not (the panel can be opened before the
   * plain list has settled); it carries every field those two screens actually
   * read, so nothing is guessed.
   */
  const itemForBacklogRow = useCallback((row: BacklogRow): MenuItem => {
    const real = items.find(i => i.id === row.id);
    if (real) return real;
    return {
      ...NEW_ITEM,
      id: row.id,
      name: row.name,
      category: row.category,
      item_type: row.item_type,
      selling_price: row.selling_price,
      material_id: row.material_id,
      material_name: row.material_name || undefined,
    };
  }, [items]);

  // Bulk category rename. Same contract as saveEdit: returns null on success or
  // an error STRING, so the server's refusal ("that name already exists") lands
  // in the dialog's error banner with the admin's typing intact instead of
  // vanishing into a toast behind a closed modal.
  const renameCategory = async (from: string, toRaw: string): Promise<string | null> => {
    const to = sanitizeCategoryName(toRaw);
    let renamed = 0;
    try {
      const res = await api('/api/menu-items/rename-category', { method: 'POST', body: { from, to } });
      const j = await res.json().catch(() => ({} as any));
      if (!res.ok) return j.error || `Rename failed (HTTP ${res.status})`;
      renamed = Number(j.renamed) || 0;
    } catch {
      return 'Rename failed — check your connection';
    }
    setRenameOpen(false);
    // Re-point the active filter at the new name. Without this the filter still
    // holds the old string, the grid goes empty and a phantom chip re-pins at
    // count 0 — which reads as data loss, not a rename.
    setCategoryFilter(cf => (cf === from ? to : cf));
    await Promise.all([fetchItems(), fetchCats()]);
    showToast(`Renamed "${from}" to "${to}" across ${renamed} item${renamed === 1 ? '' : 's'}`);
    return null;
  };

  /**
   * CATEGORY MASTER writes. Same contract as saveEdit/renameCategory: resolve to
   * null on success, or an error STRING that the manage screen shows inline —
   * a refused add ("that name already exists") must land next to the admin's
   * typing, not in a toast behind a closed dialog.
   *
   * None of these touch a menu item. Adding makes a name pickable; deactivating
   * stops it being offered and leaves every item that carries it untouched;
   * reordering only moves the picker. Renaming is NOT here — it goes through
   * renameCategory above and the one server route that may write
   * menu_items.category.
   */
  /** Exactly the three shapes the master route accepts. Spelled out rather
   *  than `any` so the compiler is the first thing that refuses a `name` here:
   *  a rename must go through renameCategory, never this path. */
  const catWrite = useCallback(async (
    body: { name: string } | { id: string; is_active: boolean } | { order: string[] },
    method: 'POST' | 'PUT',
  ): Promise<string | null> => {
    try {
      const res = await api('/api/menu-items/categories', { method, body });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) return j.error || `Failed (HTTP ${res.status})`;
    } catch {
      return 'Failed — check your connection';
    }
    await fetchCats();
    return null;
  }, [fetchCats]);

  const addCategory = useCallback(async (name: string) => {
    const err = await catWrite({ name }, 'POST');
    if (!err) showToast(`Added "${name.trim()}"`);
    return err;
  }, [catWrite, showToast]);

  const setCategoryActive = useCallback(async (c: MenuCategory, active: boolean) => {
    const err = await catWrite({ id: c.id, is_active: active }, 'PUT');
    if (err) showToast(err, true);
    else showToast(active
      ? `"${c.name}" is offered again`
      : `"${c.name}" is no longer offered — its ${c.item_count} item${c.item_count === 1 ? '' : 's'} keep it`);
    return err;
  }, [catWrite, showToast]);

  const reorderCategories = useCallback(async (order: string[]) => {
    const err = await catWrite({ order }, 'PUT');
    if (err) showToast(err, true);
    return err;
  }, [catWrite, showToast]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] p-6 animate-pulse">
        <div className="max-w-[100rem] mx-auto space-y-6">
          <div className="h-9 w-64 bg-[#FFF1E3] rounded-lg" />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
            {[...Array(4)].map((_, i) => <div key={i} className="bg-white border border-[#E8D5C4] rounded-xl p-6 h-32" />)}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-[100rem] mx-auto px-3 sm:px-6 py-5 sm:py-6 space-y-4 sm:space-y-5">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">Dine-In</p>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#2D1B0E] mt-0.5">Menu Items</h1>
            {/* THE ONE NUMBER THIS SCREEN OWES HIM, said in a sentence rather
                than left to be counted off a list of 628 rows. Dishes only —
                liquor is poured, not cooked. */}
            {summary.foodsTotal > 0 && (
              <p className="text-xs text-[#8B7355] mt-1">
                {/* "active" is load-bearing, not padding. The attention band
                    below carries its OWN no-recipe count over EVERY item,
                    delisted ones included (261 against this 234 on live data),
                    and two unqualified counts of "dishes with no recipe" sitting
                    a hand's width apart is how a number the owner is meant to
                    watch shrink stops being believed. Each now says its scope.
                    Labels only — neither count and neither filter moved. */}
                <b className="text-[#3D2614]">{summary.foodsTotal - summary.foodsNoRecipe}</b> of {summary.foodsTotal} active dishes have a recipe.
                {summary.foodsNoRecipe > 0 && (
                  <> The other <b className="text-[#3D2614]">{summary.foodsNoRecipe}</b> still sell — they just record no food cost.</>
                )}
                {/* THE WAY IN. The sentence states the backlog; this is the only
                    control on the page that lets him actually work through it in
                    the order that matters. Offered to managers and admins alone,
                    because every row's action is a recipe write and the server
                    would refuse anyone else — and because the panel carries what
                    each dish took at the till. */}
                {summary.foodsNoRecipe > 0 && canWriteRecipes && (
                  <>
                    {' '}
                    <button
                      onClick={() => setBacklogOpen(v => !v)}
                      className="text-[#af4408] font-semibold hover:underline"
                    >
                      {backlogOpen ? 'Hide the backlog' : 'Work through them →'}
                    </button>
                  </>
                )}
              </p>
            )}
            {/* WHY THE OTHER REPORT SAYS A MUCH BIGGER NUMBER. He has "Menu Items
                Without Recipe" in his sidebar and it reads 610 of 629 — because it
                counts liquor, which is poured from a bottle and costed in the
                store, and which no recipe will ever be written for. Two honest
                counts of different things, one of them in his sidebar, and
                nothing on this page reconciled them. */}
            {summary.liquors > 0 && summary.foodsTotal > 0 && (
              <p className="text-[11px] text-[#A08B73] mt-1">
                Dishes only — the {summary.liquors} liquor lines are poured from a bottle and costed in the store, so they are
                not counted here. The <b className="font-medium">Menu Items Without Recipe</b> report counts those too, which is
                why its total is far larger.
              </p>
            )}
          </div>
          <div className="flex gap-2">
            {/* Round-trip: download the CURRENT menu in the exact columns the
                Import accepts → edit in a spreadsheet → re-import with Overwrite. */}
            <a href="/api/menu-items/export" download
               className="flex items-center gap-2 px-3 sm:px-4 py-2.5 bg-white border border-[#E0D0BE] hover:border-[#af4408] hover:bg-[#af4408]/5 text-[#6B5744] rounded-xl text-sm font-medium shadow-sm transition-colors">
              <Download className="w-4 h-4" /><span className="hidden sm:inline">Download Menu (CSV)</span><span className="sm:hidden">Menu CSV</span>
            </a>
            <button onClick={openImport} className="flex items-center gap-2 px-3 sm:px-4 py-2.5 bg-white border border-[#E0D0BE] hover:border-purple-400 hover:bg-purple-50/40 text-purple-700 rounded-xl text-sm font-medium shadow-sm transition-colors">
              <Upload className="w-4 h-4" /><span className="hidden sm:inline">Import from Akan POS</span><span className="sm:hidden">Import</span>
            </button>
            <button onClick={() => setEditItem(NEW_ITEM)} className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-xl text-sm font-semibold shadow-sm transition-colors">
              <Plus className="w-4 h-4" />New Item
            </button>
          </div>
        </div>

        {/* THE BACKLOG. Opened from the sentence above; everything else on this
            page stays exactly where it was underneath it, so opening the panel
            never costs anyone the list they came for. */}
        {backlogOpen && canWriteRecipes && (
          <RecipeBacklogPanel
            rows={backlog}
            meta={backlogMeta}
            state={backlogState}
            remaining={summary.foodsNoRecipe}
            onClose={() => setBacklogOpen(false)}
            onRetry={() => setRecipeLinkNonce(n => n + 1)}
            onAddRecipe={(row) => openQuickRecipe(itemForBacklogRow(row))}
            onLinkExisting={(row) => openLinkRecipe(itemForBacklogRow(row))}
            onEdit={(row) => setEditItem(itemForBacklogRow(row))}
          />
        )}

        {/* Stat bar */}
        <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm overflow-hidden grid grid-cols-3 sm:grid-cols-6">
          <Stat label="Total" value={summary.total} className="text-[#2D1B0E]" />
          <Stat label="Active" value={summary.active} className="text-green-600" />
          <Stat label="Foods" value={summary.foods} className="text-orange-500" />
          <Stat label="Liquor" value={summary.liquors} className="text-purple-600" />
          <Stat label="Beverages" value={summary.beverages} className="text-[#B9A48C]" />
          <Stat label="With Recipe" value={summary.withRecipe} className="text-blue-600" />
        </div>

        {/* ── WHEN A COST ON THIS PAGE IS PROVABLY WRONG, SAY SO FIRST. ──────
            Not a guess and not a general disclaimer: each of these rows has a
            linked recipe carrying a quantity in a unit the system cannot convert,
            so that line's money is computed in the wrong unit. LOOSE PRAWNS shows
            ₹63,012 because 100 pcs of prawns is priced as 100 kg.

            Deliberately NOT worded as "these figures may be out of date". They
            are not: every stored recipe cost on this database reproduces to the
            paise from today's purchase averages, so nothing here is waiting on
            the price reconcile, and saying it was would send him to fix the wrong
            thing. The unit is the fault, and the unit is what it names. */}
        {untrustedCost > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 bg-red-50 border border-red-200 rounded-2xl px-4 py-3">
            <span className="flex items-start gap-2 text-sm text-red-900">
              <AlertTriangle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
              <span>
                <b>{untrustedCost} {untrustedCost === 1 ? 'dish has a cost that is wrong' : 'dishes have a cost that is wrong'}.</b>{' '}
                Most of what those costs are made of is a quantity in a unit the system cannot convert — for
                example 100 pcs of a material priced by the kilo, which gets valued as 100 kg. Do not price
                anything off those rows until the quantity or the unit is corrected. They are marked{' '}
                <b>cost is wrong</b> below.
              </span>
            </span>
            {/* LANDS ON THE ROWS, NOT ON THE LIST. A bare /recipes handed him 67
                recipes and left him to find the six; ?health= opens the recipe
                book with its own "cost is wrong" filter already applied. */}
            <a href="/recipes?health=costWrong" className="ml-auto text-sm font-medium text-red-800 hover:underline whitespace-nowrap">
              Fix in Recipes →
            </a>
          </div>
        )}

        {/* Attention banner */}
        {attn.total > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3">
            <span className="flex items-center gap-2 text-sm font-semibold text-amber-900">
              <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
              {attn.total} items need attention
            </span>
            <div className="flex flex-wrap items-center gap-2">
              {attn.noPrice > 0 && <AttnPill tone="red" count={attn.noPrice} label="no selling price" active={issueFilter === 'noPrice'} onClick={() => reviewIssue('noPrice')} />}
              {attn.noVeg > 0 && <AttnPill tone="amber" count={attn.noVeg} label="missing veg/non-veg" active={issueFilter === 'noDietaryTag'} onClick={() => reviewIssue('noDietaryTag')} />}
              {/* ITS SCOPE, AND THE SIZE OF THE GAP, IN WORDS.
                  This count covers EVERY dish (clicking it sets the status filter
                  to "all"), so it reads higher than the active backlog count in
                  the sentence at the top and on the Not-linked filter — 261
                  against 234 on live data. "Delisted too" named the scope but
                  left him to do the subtraction, and "delisted" is a word that
                  appears nowhere else in this app: its own controls say "Active
                  only" and "inactive". So the difference is stated outright. The
                  number and the filter are untouched; only the words changed. */}
              {attn.noLink > 0 && <AttnPill tone="blue" count={attn.noLink}
                              label={attn.noLink > summary.foodsNoRecipe
                                ? `dishes with no recipe, including ${attn.noLink - summary.foodsNoRecipe} no longer on the menu`
                                : 'dishes with no recipe'}
                              active={issueFilter === 'noRecipe'} onClick={() => reviewIssue('noRecipe')} />}
            </div>
            <button onClick={() => reviewIssue('any')} className="ml-auto text-sm font-medium text-[#af4408] hover:underline whitespace-nowrap">
              {issueFilter ? 'Clear filter' : 'Review all →'}
            </button>
          </div>
        )}

        {/* Search + filters */}
        <div className="flex flex-col lg:flex-row gap-2.5">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8B7355]" />
            <input ref={searchRef} type="text" placeholder="Search by name or item code…" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                   className="w-full pl-10 pr-9 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]/40 focus:border-[#af4408] shadow-sm" />
            <kbd className="hidden sm:flex absolute right-3 top-1/2 -translate-y-1/2 h-5 w-5 items-center justify-center rounded border border-[#E0D0BE] bg-[#FFF8F0] text-[11px] text-[#8B7355]">/</kbd>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select value={stationFilter} onChange={e => setStationFilter(e.target.value)} className="px-3 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm shadow-sm">
              <option value="">All Stations ({stations.length})</option>
              {stations.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} className="px-3 py-2.5 bg-white border border-[#E0D0BE] rounded-xl text-sm shadow-sm">
              <option value="">All Types</option>
              <option value="foods">Foods</option>
              <option value="liquors">Liquor</option>
              <option value="beverages">Beverages</option>
            </select>
            <SegmentedVeg value={vegFilter} onChange={setVegFilter} />
            {/* RECIPE: All / Linked / Not linked. The answer to "which of my
                dishes are costed?" on a 628-row list, one click away. An admin
                view filter — it narrows THIS table and nothing else; no menu,
                bill or ticket anywhere asks a recipe whether an item exists. */}
            <SegmentedLink
              value={linkFilter}
              onChange={setLinkFilter}
              /* THE COUNT, ON THE CONTROL. The owner's ask is to watch the
                 backlog shrink, and a number he has to go and find somewhere
                 else is a number he stops checking. This is the SERVER's count
                 (summary.foodsNoRecipe) — the very figure the backlog list is
                 built from, so the badge and the panel can never disagree.
                 Active dishes only, which is what the tooltip says. */
              unlinkedCount={summary.foodsNoRecipe}
              linkedCount={summary.foodsTotal - summary.foodsNoRecipe}
            />
            <ActiveToggle on={statusFilter === 'active'} onToggle={() => setStatusFilter(statusFilter === 'active' ? 'all' : 'active')} />
          </div>
        </div>

        {/* Category chips + "All N categories" dropdown */}
        {categories.length > 0 && (() => {
          const baseList = items.filter(it => {
            if (statusFilter === 'active'   && !it.is_active) return false;
            if (statusFilter === 'inactive' &&  it.is_active) return false;
            if (stationFilter && it.station !== stationFilter) return false;
            if (typeFilter    && normalizeType(it.item_type) !== typeFilter) return false;
            if (vegFilter     && it.dietary_tag !== vegFilter) return false;
            const q = searchQuery.toLowerCase().trim();
            if (q && !it.name.toLowerCase().includes(q) && !(it.item_code || '').toLowerCase().includes(q)) return false;
            return true;
          });
          const countByCat: Record<string, number> = {};
          for (const it of baseList) { const k = it.category; if (k) countByCat[k] = (countByCat[k] || 0) + 1; }
          const sortedCats = [...categories].sort((a, b) => (countByCat[b] || 0) - (countByCat[a] || 0));
          const inline = sortedCats.slice(0, TOP_CATS);
          if (categoryFilter && !inline.includes(categoryFilter)) inline.unshift(categoryFilter);
          return (
            <div className="flex items-center gap-2">
              <TabScroller className="gap-1.5 flex-1 min-w-0">
                <CatChip active={!categoryFilter} label="All" count={baseList.length} onClick={() => setCategoryFilter('')} />
                {inline.map(c => <CatChip key={c} active={categoryFilter === c} label={c} count={countByCat[c] || 0} onClick={() => setCategoryFilter(categoryFilter === c ? '' : c)} />)}
              </TabScroller>
              {/* The category master. Admin-only, because every write behind it
                  is (POST/PUT /api/menu-items/categories and the rename route
                  both require admin) — the server gate is the boundary, this
                  only avoids offering a button whose every click would 403. */}
              {isAdmin && (
                <button onClick={() => setManageCatsOpen(true)} title="Add, rename, reorder or retire the categories the item form offers"
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-[#E0D0BE] bg-white text-[#6B5744] hover:bg-[#FFF1E3] text-xs font-medium whitespace-nowrap transition-colors shrink-0">
                  <ListOrdered className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Manage categories</span><span className="sm:hidden">Categories</span>
                </button>
              )}
              {isAdmin && (
                <button onClick={() => setPhotoStorageOpen(true)} title="See how much space uploaded dish photos use, and reclaim the ones nothing points at"
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-[#E0D0BE] bg-white text-[#6B5744] hover:bg-[#FFF1E3] text-xs font-medium whitespace-nowrap transition-colors shrink-0">
                  <HardDrive className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Photo storage</span><span className="sm:hidden">Photos</span>
                </button>
              )}
              <div className="relative shrink-0">
                <button onClick={() => setCatMenuOpen(!catMenuOpen)} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium whitespace-nowrap transition-colors ${catMenuOpen ? 'bg-[#af4408] text-white border-[#af4408]' : 'bg-white text-[#6B5744] border-[#E0D0BE] hover:bg-[#FFF1E3]'}`}>
                  All {categories.length} categories <ChevronDown className="w-3.5 h-3.5" />
                </button>
                {catMenuOpen && (
                  <CategoryMenu categories={sortedCats} counts={countByCat} current={categoryFilter} search={catSearch} setSearch={setCatSearch}
                                onPick={(c) => { setCategoryFilter(c); setCatMenuOpen(false); setCatSearch(''); }}
                                onClose={() => { setCatMenuOpen(false); setCatSearch(''); }} />
                )}
              </div>
            </div>
          );
        })()}

        {/* ---- Items: table on desktop, cards on mobile ---- */}
        {filteredItems.length === 0 ? (
          <div className="bg-white border border-[#E8D5C4] rounded-2xl py-16 text-center text-[#8B7355]">
            <Utensils className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p>No menu items found</p>
            <p className="text-xs mt-1">Try clearing filters, or import from Akan POS</p>
          </div>
        ) : (
          <>
            {/* Desktop table */}
            {/* ── WHY xl, AND WHY lg WAS NOT ENOUGH ─────────────────────────
                Measured on the iPad his floor actually uses — 1024×768 landscape.
                At `md` that got the TABLE, and the RECIPE column was off-screen:
                the whole point of this screen ("every Menu Item should clearly
                indicate whether the recipe is Linked or Not Linked") sitting
                behind a sideways swipe on the one device carried around the
                restaurant.

                Moving to `lg` did not fix it, because Tailwind's lg is
                min-width:1024px — INCLUSIVE. 1024 is the measured width, so it
                landed on the table side of the line by one pixel. And 1024 is the
                worst width of all: at exactly 1024 the sidebar stops being a
                drawer and takes 374px, so the scroll container is 650px against a
                935px table. Measured in the browser at each width, RECIPE column
                at x 673–797:

                     1023 → cards, everything visible          (container = full)
                     1024 → table 935 in a 650 container       RECIPE HIDDEN
                     1280 → table 1102 in a 1102 container     RECIPE visible
                     1440 → table 1262 in a 1262 container     RECIPE visible

                The table first FITS at 1280, so that is where it starts. Every
                tablet — 1024, iPad Air 1180, iPad Pro 1194 — gets the card
                layout, which states the answer in words on every card. Neither
                layout changed; only which widths get which. */}
            <div className="hidden xl:block bg-white border border-[#E8D5C4] rounded-2xl shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-wide text-[#8B7355] border-b border-[#E8D5C4] bg-[#FFF8F0]">
                      <th className="text-left py-3 px-4 font-semibold">Name</th>
                      <th className="text-left py-3 px-3 font-semibold">Category / Station</th>
                      <th className="text-left py-3 px-3 font-semibold">Type</th>
                      <th className="text-left py-3 px-3 font-semibold">V/NV</th>
                      <th className="text-right py-3 px-3 font-semibold">Sell ₹</th>
                      <th className="text-right py-3 px-3 font-semibold">Cost ₹</th>
                      <th className="text-right py-3 px-3 font-semibold">FC %</th>
                      {/* "Link" named the mechanism. This column answers "does
                          this dish have a recipe?", so it says Recipe. */}
                      <th className="text-left py-3 px-3 font-semibold">Recipe</th>
                      <th className="text-center py-3 px-3 font-semibold">Active</th>
                      <th className="w-10" aria-label="Actions"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageItems.map((it) => (
                      <tr key={it.id} className={`border-b border-[#F0E4D6] last:border-0 hover:bg-[#FFF8F0] ${!it.is_active ? 'opacity-55' : ''}`}>
                        <td className="py-2.5 px-4">
                          <div className="flex items-center gap-3">
                            <Avatar name={it.name} type={it.item_type} />
                            <div className="min-w-0">
                              <p className="font-semibold text-[#2D1B0E] text-[13px] truncate max-w-[240px]">{it.name}</p>
                              {it.item_code && <p className="text-[11px] text-[#8B7355] font-mono">{it.item_code}</p>}
                            </div>
                          </div>
                        </td>
                        <td className="py-2.5 px-3">
                          <p className="text-[13px] text-[#3D2614]">{it.category || <span className="text-red-400">—</span>}</p>
                          {it.station && <p className="text-[11px] text-[#8B7355]">{it.station}</p>}
                        </td>
                        <td className="py-2.5 px-3"><TypeBadge type={it.item_type} /></td>
                        <td className="py-2.5 px-3"><VegSquare tag={it.dietary_tag} type={it.item_type} /></td>
                        <td className="py-2.5 px-3 text-right font-semibold text-[#2D1B0E]">
                          {it.selling_price > 0 ? formatCurrency(it.selling_price) : <span className="text-red-400 font-normal">₹0</span>}
                        </td>
                        <td className="py-2.5 px-3 text-right text-[#6B5744]">
                          {/* APPROXIMATE TRAVELS WITH THE MONEY. This cell and
                              the FC% beside it are derived from the linked
                              recipe; if that recipe's quantities are rough then
                              so are these, and this list is read to make pricing
                              decisions.

                              The test is "is there a RECIPE", not "is the cost
                              truthy". A linked recipe costing ₹0 is a real
                              answer — it means every ingredient on it is priced
                              at zero — and printing an em-dash for it hid that
                              behind the same glyph used for "no recipe at all". */}
                          <CostCell it={it} />
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          {/* DERIVED per row by /api/menu-items: the linked
                              recipe's cost ÷ THIS row's own SELL, so the three
                              numbers on this line always agree. It is never the
                              stored recipes.food_cost_percent — that column is a
                              cache and printed 19.47 (87.43 ÷ a stale ₹449)
                              beside ₹499. A recipe listed on several menu items
                              is costed against the cheapest listing for the
                              recipe book (src/lib/recipe-price.ts); each row
                              here still reports against its own price. */}
                          {/* `!= null`, not truthiness. A linked recipe whose cost
                              is ₹0 has a food cost of 0%, and printing an em-dash
                              for it put "no recipe at all" and "a recipe with
                              nothing in it" behind the same glyph — beside a
                              ₹0.00 in the Cost column, which reads as a costed
                              dish. The Cost cell fixed this; this one had not. */}
                          {typeof it.recipe_food_cost_percent === 'number'
                            ? <span
                                className={`font-medium ${it.recipe_cost_unusable ? 'text-red-600 line-through decoration-red-400/60' : it.recipe_cost_warning || it.recipe_is_approximate ? 'text-amber-800' : fcColor(it.recipe_food_cost_percent)}`}
                                title={`${it.recipe_cost_warning ? `${it.recipe_cost_unusable ? 'THIS PERCENTAGE IS WRONG' : warningHeadline(it.recipe_cost_warning_kind)} — ${it.recipe_cost_warning} ${it.recipe_cost_warning_fix || ''}\n\n` : ''}${it.recipe_is_approximate ? 'APPROXIMATE — the linked recipe\'s quantities are rough, so this percentage is an estimate. ' : ''}Linked recipe's food cost — its cost measured against the menu price. ${it.recipe_cost ? `Cost ${formatCurrency(it.recipe_cost)} ÷ ` : ''}${formatCurrency(it.selling_price)}`}
                              >{it.recipe_is_approximate && !it.recipe_cost_unusable && <span aria-label="approximate">≈</span>}{it.recipe_food_cost_percent}</span>
                            : <span className="text-[#C4B09A]">—</span>}
                        </td>
                        <td className="py-2.5 px-3"><LinkBadge item={it} onAddRecipe={openQuickRecipe} canWrite={canWriteRecipes} /></td>
                        <td className="py-2.5 px-3 text-center"><RowToggle on={!!it.is_active} onClick={() => toggleActive(it)} /></td>
                        <td className="py-2.5 px-2 text-center whitespace-nowrap">
                          {/* Visible pencil first — Edit hidden behind ⋮ alone kept
                              getting reported as "there is no edit option". */}
                          <button onClick={() => setEditItem(it)} title="Edit item"
                                  className="p-1.5 rounded-lg text-[#af4408] hover:bg-[#af4408]/10 align-middle">
                            <Edit className="w-4 h-4" />
                          </button>
                          <RowMenu onEdit={() => setEditItem(it)} onDelete={() => deleteItem(it.id)} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Mobile cards */}
            {/* Phones AND every tablet up to 1279 — see the note on the table
                above. Must stay the exact complement of the table's `xl`, or a
                width gets both layouts or neither. */}
            <div className="xl:hidden space-y-2.5">
              {pageItems.map((it) => (
                <MobileCard key={it.id} it={it} onEdit={() => setEditItem(it)} onDelete={() => deleteItem(it.id)} onToggle={() => toggleActive(it)} onAddRecipe={openQuickRecipe} canWrite={canWriteRecipes} />
              ))}
            </div>

            {/* THE KEY, in words, on the screen. A "≈" that only a tooltip
                explains is no warning at all on a tablet, where there is no
                hover — and this is a tablet-first operation. */}
            <p className="text-[11px] text-[#8B7355] leading-relaxed">
              <span className="text-amber-800 font-medium">≈ approx</span> — cost from a simple recipe covering only the main
              ingredients. Real, but an estimate; do not price off it as though it were measured.
              <span className="mx-1.5 text-[#D4B896]">·</span>
              <span className="text-red-600 font-medium">cost is wrong</span> — most of this cost is computed in a unit the
              system cannot convert, so the figure means nothing until the recipe is fixed.
              <span className="mx-1.5 text-[#D4B896]">·</span>
              <span className="text-amber-800 font-medium">check units</span> — one line is weighed in grams against a material
              stocked in millilitres (or the reverse). The total is right to within a few percent; fix the unit when you can.
              <span className="mx-1.5 text-[#D4B896]">·</span>
              {/* Listed because the badge can now say it, and a state with no key
                  entry is a state the reader has to guess at. Deliberately NOT
                  folded into "check units": that entry promises the total is right
                  to within a few percent, which is the opposite of what this one
                  means. */}
              <span className="text-orange-800 font-medium">check quantity</span> — one line uses more of a single ingredient than
              a portion plausibly holds (700 g of a sauce on one plate). The total is not a few percent out; it may be far out.
              Correct unless the recipe is written for a batch.
              <span className="mx-1.5 text-[#D4B896]">·</span>
              <span className="text-red-600 font-medium">empty</span> — the linked recipe has nothing in it, so the dish is
              linked and still costs ₹0.
              <span className="mx-1.5 text-[#D4B896]">·</span>
              A dish with no recipe still appears on the menu, still sells and still prints — it simply records no food cost.
            </p>

            {/* Pagination */}
            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-1">
              <p className="text-xs text-[#8B7355]">
                Showing {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filteredItems.length)} of {filteredItems.length} items
              </p>
              <Pagination page={safePage} pageCount={pageCount} onPage={setPage} />
            </div>
          </>
        )}
      </div>

      {/* ── THE RECIPE PROMPT ──────────────────────────────────────────────
          Raised after a menu item is created or saved; sits in the corner above
          the toast. Deliberately NOT a dialog: the item is already saved, so
          there is nothing to confirm and nothing to hold up. It takes no focus,
          and every way out of it — "Not now", the ✕, or simply carrying on —
          leaves the item exactly as saved.

          IT IS SUPPRESSED WHILE AN ITEM EDITOR IS OPEN, and that is not tidiness
          — IT WAS AN R7 DEFECT, MEASURED. This card is z-[95]; the New/Edit modal
          is below it. Under the `sm` breakpoint the card's own phone styling
          (`bottom-6 left-4 right-4`) makes it full-width at the bottom of the
          viewport, which is exactly where the modal's footer sits. At 390×844:

              document.elementFromPoint(save button centre)
                → "Add a simple recipe Link an existing recipeNot now"
                → isSave: false,  cancelHit.clickable: false

          So a manager who created one dish, left the prompt up and immediately
          typed a second one could not press Save at all — and the press landed on
          "Add a simple recipe" FOR THE PREVIOUS DISH, which silently discarded the
          dish being typed. Proved in the database: of 'ZZ R7 Overlap A' and
          'ZZ R7 Overlap B', only A existed. The boundary was exact — clickable at
          640px, not at 639px — because the card switches to `sm:bottom-20
          sm:right-6 sm:max-w-sm` at 640 and stops overlapping.

          Suppression rather than a lower z-index or a nudged position: a prompt
          about item A is noise while item B is being typed, whatever it covers.
          The state is KEPT, not cleared — close the editor and the prompt is
          there waiting, so nothing is lost either way.

          A comment here used to claim "It covers no control". Below 640px it
          covered the two most important ones on the page.

          EVERY dialog, not only the editor. The editor is the one that was proved
          to lose typed work, but the import modal and the backlog panel have
          footers in the same place and this card outranks both of them on z-index
          too, so the rule is "no dialog is open" rather than a list of the one
          that was caught. quickFor / linkFor cannot actually coexist with the
          prompt (opening either clears it — see onAddRecipe/onLinkExisting above)
          and are named anyway, so a future caller that opens one WITHOUT clearing
          the prompt does not silently reintroduce this. */}
      {recipePrompt && !editItem && !importOpen && !backlogOpen && !quickFor && !linkFor && (() => {
        // Resolved from the freshly-refetched list. If it is somehow not there,
        // nothing is shown — an absent prompt is a non-event, and the item is
        // saved either way.
        const it = items.find(i => i.id === recipePrompt.id);
        if (!it) return null;
        return (
          <RecipePromptCard
            item={it}
            created={recipePrompt.created}
            onAddRecipe={() => { setRecipePrompt(null); openQuickRecipe(it); }}
            onLinkExisting={() => { setRecipePrompt(null); openLinkRecipe(it); }}
            onDismiss={() => setRecipePrompt(null)}
          />
        );
      })()}

      {/* Toast — z above modal backdrops so error toasts stay visible */}
      {toast && (
        <div className={`fixed bottom-6 right-6 z-[96] flex items-center gap-3 px-5 py-3 ${toast.error ? 'bg-red-600' : 'bg-green-600'} text-white rounded-lg shadow-lg`}>
          {toast.error ? <AlertCircle className="w-4 h-4" /> : <CheckCircle className="w-4 h-4" />}
          <span className="text-sm font-medium">{toast.msg}</span>
        </div>
      )}

      {/* Import Modal */}
      {importOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-6 pb-6 overflow-y-auto">
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setImportOpen(false)} />
          <div className="relative w-full max-w-4xl bg-white rounded-2xl shadow-xl border border-[#E8D5C4] mx-4">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8D5C4] sticky top-0 bg-white z-20">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-purple-100"><FileSpreadsheet className="w-5 h-5 text-purple-600" /></div>
                <div>
                  <h2 className="text-lg font-semibold text-[#2D1B0E]">Import Menu Items from Akan POS</h2>
                  <p className="text-xs text-[#8B7355]">Auto-fixes typos, strips extra spaces, links to recipes</p>
                </div>
              </div>
              <button onClick={() => setImportOpen(false)} className="p-1 text-[#8B7355] hover:text-[#2D1B0E]"><X className="w-5 h-5" /></button>
            </div>

            <div className="px-6 py-5 space-y-4">
              <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-xl p-4 text-sm">
                <p className="text-[#6B5744] font-medium mb-2">This importer expects Akan Brewing Co Products format with columns:</p>
                <p className="text-xs text-[#8B7355]">Category Name, Product Name, Selling Price, Listing Price, Master Status, Item Type, Tax Value, Item Code, Station, Dietary Tag</p>
                <p className="text-xs text-[#8B7355] mt-2">Will auto-fix: COSMOPOLTIAN → COSMOPOLITAN, HEINKEIN → HEINEKEN, VERMOTH → VERMOUTH, etc. Plus extra-space cleanup.</p>
                <div className="flex flex-wrap gap-2 mt-3">
                  <a href="/api/menu-items/export" download
                     className="inline-flex items-center gap-1.5 text-xs font-medium text-[#af4408] border border-[#af4408]/40 hover:bg-[#af4408]/10 px-3 py-1.5 rounded-lg">
                    <Download className="w-3.5 h-3.5" /> Download current menu (CSV)
                  </a>
                  <a href="/api/menu-items/export?sample=1" download
                     className="inline-flex items-center gap-1.5 text-xs font-medium text-[#6B5744] border border-[#D4B896] hover:bg-[#FFF1E3] px-3 py-1.5 rounded-lg">
                    <Download className="w-3.5 h-3.5" /> Download sample template
                  </a>
                  <span className="text-[11px] text-[#8B7355] self-center">edit in a spreadsheet → re-upload here (Overwrite updates matching items)</span>
                </div>
              </div>

              {/* Drop zone */}
              <div onClick={() => importFileRef.current?.click()} className="border-2 border-dashed border-[#D4B896] hover:border-purple-600 hover:bg-purple-50/30 rounded-xl p-8 text-center cursor-pointer transition-colors">
                <FileSpreadsheet className="w-10 h-10 text-purple-500 mx-auto mb-3" />
                <p className="text-[#6B5744] font-medium">{importFileName || 'Click to select Excel / CSV file'}</p>
                <p className="text-xs text-[#8B7355] mt-1">Excel: looks for sheet "Existing Product" / "Products" · CSV: the downloaded menu format above</p>
                <input ref={importFileRef} type="file" accept=".xlsx,.xls,.csv" onChange={e => { const f = e.target.files?.[0]; if (f) handleImportFile(f); }} className="hidden" />
              </div>

              {importPreview && (
                <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 space-y-4">
                  <h3 className="text-sm font-semibold text-[#2D1B0E]">File Parsed ✓</h3>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <StatBlock label="Total Items" value={importPreview.total} color="text-[#af4408]" />
                    <StatBlock label="Active" value={importPreview.active} color="text-green-600" />
                    <StatBlock label="Inactive" value={importPreview.inactive} color="text-gray-500" />
                    <StatBlock label="Categories" value={importPreview.categories} color="text-blue-600" />
                    {importPreview.typos > 0 && <StatBlock label="Typos to Fix" value={importPreview.typos} color="text-amber-600" />}
                    {importPreview.spaces > 0 && <StatBlock label="Space Issues" value={importPreview.spaces} color="text-amber-600" />}
                    {importPreview.duplicates > 0 && <StatBlock label="In-File Dupes" value={importPreview.duplicates} color="text-red-500" />}
                    {importPreview.zeroPrice > 0 && <StatBlock label="Zero Price" value={importPreview.zeroPrice} color="text-red-500" />}
                  </div>

                  {/* Said BEFORE the upload, next to the Overwrite switch,
                      because "what will this file leave alone?" is the question
                      that switch is really asking. A column the sheet does not
                      have is not an instruction to erase the value. */}
                  {importPreview.missingColumns?.length > 0 && (
                    <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3 text-xs">
                      <p className="text-[#6B5744]">
                        No {importPreview.missingColumns.join(', ')} column{importPreview.missingColumns.length === 1 ? '' : 's'} in this file. Existing items KEEP what they already have there — only the columns above are written.
                      </p>
                    </div>
                  )}

                  <div className="space-y-2 text-xs">
                    <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={importOverwrite} onChange={e => setImportOverwrite(e.target.checked)} className="accent-purple-600 w-4 h-4" /><span className="text-[#6B5744]">Overwrite existing items with same name</span></label>
                    <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={importSkipInactive} onChange={e => setImportSkipInactive(e.target.checked)} className="accent-purple-600 w-4 h-4" /><span className="text-[#6B5744]">Skip inactive items ({importPreview.inactive} will be excluded)</span></label>
                    <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={importSkipZero} onChange={e => setImportSkipZero(e.target.checked)} className="accent-purple-600 w-4 h-4" /><span className="text-[#6B5744]">Skip items with ₹0 selling price ({importPreview.zeroPrice} will be excluded)</span></label>
                    {/* Offered ONLY when it could do anything: a template file
                        with no Station column. Default OFF — the map is a
                        hard-coded guess, so writing it must be asked for, and
                        the server refuses any map name the station list does
                        not have. */}
                    {importPayload?.isTemplate && !importPayload?.present_columns?.includes('station') && (
                      <label className="flex items-start gap-2 cursor-pointer"><input type="checkbox" checked={importFillStation} onChange={e => setImportFillStation(e.target.checked)} className="accent-purple-600 w-4 h-4 mt-0.5" /><span className="text-[#6B5744]">Give stations to items that have NONE, from the template’s category → station map (a guess — only names already on the station list are written; items that have a station always keep it)</span></label>
                    )}
                  </div>

                  <div className="flex gap-3">
                    <button onClick={submitImport} disabled={importing} className="flex items-center gap-2 px-5 py-2.5 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium">
                      {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                      {importing ? 'Importing...' : `Import ${importPreview.total} Items`}
                    </button>
                    <button onClick={() => { setImportPreview(null); setImportPayload(null); setImportFileName(null); }} className="px-4 py-2.5 bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm hover:bg-[#E8D5C4]">Clear</button>
                  </div>
                </div>
              )}

              {importResult && (
                <div className="space-y-3">
                  {importResult.error ? (
                    <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
                      <div className="flex items-start gap-2"><AlertCircle className="w-5 h-5 text-red-500" /><div><p className="text-red-700 font-medium">Import failed</p><p className="text-red-600 text-xs mt-1">{importResult.error}</p></div></div>
                    </div>
                  ) : (
                    <>
                      <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
                        <div className="flex items-start gap-2 mb-2"><CheckCircle className="w-5 h-5 text-green-600" /><p className="text-green-700 font-medium">Import complete!</p></div>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                          {importResult.items_created > 0 && <StatBlock label="Created" value={importResult.items_created} color="text-green-600" />}
                          {importResult.items_updated > 0 && <StatBlock label="Updated" value={importResult.items_updated} color="text-blue-600" />}
                          {importResult.items_reactivated > 0 && <StatBlock label="Re-activated" value={importResult.items_reactivated} color="text-amber-600" />}
                          {importResult.items_deactivated > 0 && <StatBlock label="Deactivated" value={importResult.items_deactivated} color="text-amber-600" />}
                          {importResult.items_linked_to_recipe > 0 && <StatBlock label="Linked to Recipes" value={importResult.items_linked_to_recipe} color="text-indigo-600" />}
                          {importResult.items_linked_to_material > 0 && <StatBlock label="Linked to Materials" value={importResult.items_linked_to_material} color="text-purple-600" />}
                          {importResult.items_skipped_inactive > 0 && <StatBlock label="Skipped Inactive" value={importResult.items_skipped_inactive} color="text-gray-500" />}
                          {importResult.items_skipped_zero_price > 0 && <StatBlock label="Skipped ₹0" value={importResult.items_skipped_zero_price} color="text-gray-500" />}
                          {importResult.items_skipped_duplicate > 0 && <StatBlock label="Skipped Duplicate" value={importResult.items_skipped_duplicate} color="text-amber-600" />}
                          {importResult.typos_fixed?.length > 0 && <StatBlock label="Typos Fixed" value={importResult.typos_fixed.length} color="text-amber-600" />}
                          {importResult.spaces_fixed > 0 && <StatBlock label="Spaces Fixed" value={importResult.spaces_fixed} color="text-amber-600" />}
                          {importResult.created_categories?.length > 0 && <StatBlock label="New Categories" value={importResult.created_categories.length} color="text-[#af4408]" />}
                          {importResult.stations_preserved > 0 && <StatBlock label="Kept Their Station" value={importResult.stations_preserved} color="text-[#8B5A2B]" />}
                          {importResult.stations_changed > 0 && <StatBlock label="Station Changed" value={importResult.stations_changed} color="text-amber-600" />}
                          {importResult.stations_cleared > 0 && <StatBlock label="Station Cleared" value={importResult.stations_cleared} color="text-red-600" />}
                        </div>
                      </div>
                      {/* WHAT THE FILE DID NOT SAY. A column the sheet does not
                          have is not an instruction to erase the value — and
                          "Updated: 9" used to be the only thing said about a run
                          that had just emptied nine stations. menu_items.station
                          is the KOT routing key, so name it first and by number. */}
                      {importResult.columns_absent?.length > 0 && (
                        <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3 text-xs">
                          <p className="font-medium text-[#8B5A2B]">
                            This file had no {importResult.columns_absent.join(', ')} column{importResult.columns_absent.length === 1 ? '' : 's'} — every item it updated KEPT what it already had there.
                          </p>
                          {importResult.stations_preserved > 0 && (
                            <p className="mt-1 text-[#6B5744]">
                              <b>{importResult.stations_preserved}</b> item{importResult.stations_preserved === 1 ? '' : 's'} kept {importResult.stations_preserved === 1 ? 'its' : 'their'} existing station, so no KOT changed printer.
                            </p>
                          )}
                          {Object.keys(importResult.fields_preserved || {}).length > 0 && (
                            <p className="mt-1 text-[#8B7355] break-words">
                              Left untouched: {Object.entries(importResult.fields_preserved as Record<string, number>).map(([k, v]) => `${k} (${v})`).join(' · ')}
                            </p>
                          )}
                        </div>
                      )}
                      {/* Columns the file HAS, on rows where the cell said
                          nothing. A blank cell is not a statement — it used to
                          be read as 'Active' / 'foods' / 0 / 5% and silently
                          rewrote real values (131 retired items re-activated,
                          ₹ prices zeroed, liquor GST invented). Those items
                          keep what they have; say so by count. */}
                      {Object.keys(importResult.blank_cells_preserved || {}).length > 0 && (
                        <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3 text-xs">
                          <p className="font-medium text-[#8B5A2B]">
                            Blank cells in this file changed nothing — a blank is not a statement, so those items kept their existing value:
                          </p>
                          <p className="mt-1 text-[#6B5744] break-words">
                            {Object.entries(importResult.blank_cells_preserved as Record<string, number>).map(([k, v]) => `${k} (${v})`).join(' · ')}
                          </p>
                        </div>
                      )}
                      {/* The other direction: the file HAD a Station column and
                          left cells blank. That IS an instruction to clear, and
                          a cleared station stops matching a station printer. */}
                      {importResult.stations_cleared > 0 && (
                        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs">
                          <p className="font-medium text-red-700">
                            {importResult.stations_cleared} item{importResult.stations_cleared === 1 ? '' : 's'} had {importResult.stations_cleared === 1 ? 'its' : 'their'} station CLEARED — this file has a Station column and those cells were blank.
                          </p>
                          <p className="mt-1 text-red-600">
                            An item with no station does not match a station printer: its KOT falls through to the floor’s food/bar printer. {importResult.items_without_station > 0 ? `${importResult.items_without_station} item${importResult.items_without_station === 1 ? '' : 's'} in this file now ${importResult.items_without_station === 1 ? 'has' : 'have'} no station.` : ''} Fix them in the item form, or re-import with the station filled in.
                          </p>
                        </div>
                      )}
                      {/* A station string that the station master does not have
                          routes nowhere — no printer matches it and no
                          department is debited. The import writes it anyway
                          (dropping it would be a new way to lose data) and
                          names it here. */}
                      {importResult.stations_not_in_master?.length > 0 && (
                        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs">
                          <p className="font-medium text-amber-800">
                            {importResult.stations_not_in_master.length} station name{importResult.stations_not_in_master.length === 1 ? '' : 's'} in this import {importResult.stations_not_in_master.length === 1 ? 'is' : 'are'} not in the station list:
                          </p>
                          <p className="mt-1 text-amber-700 break-words">{importResult.stations_not_in_master.join(' · ')}</p>
                          <p className="mt-1 text-amber-700">The items were written with {importResult.stations_not_in_master.length === 1 ? 'it' : 'them'}, but a station off the list matches no KOT printer and no department. Add or correct {importResult.stations_not_in_master.length === 1 ? 'it' : 'them'} under <b>Settings → Stations</b>.</p>
                        </div>
                      )}
                      {importResult.stations_filled_from_category > 0 && (
                        <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3 text-xs">
                          <p className="text-[#6B5744]">
                            {importResult.stations_filled_from_category} item{importResult.stations_filled_from_category === 1 ? '' : 's'} that had NO station were given one from the template’s category → station map, because you ticked the map option. Only names already on the station list were written.
                          </p>
                        </div>
                      )}
                      {/* Map names the fill REFUSED: the category → station map
                          is a hard-coded guess, and a name the station list
                          does not have routes nowhere — so it was skipped, not
                          written. */}
                      {importResult.station_fill_skipped_not_in_master?.length > 0 && (
                        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs">
                          <p className="font-medium text-amber-800">
                            The category → station map suggested {importResult.station_fill_skipped_not_in_master.length === 1 ? 'a station that is' : 'stations that are'} not on the station list, so {importResult.station_fill_skipped_not_in_master.length === 1 ? 'it was' : 'they were'} NOT written:
                          </p>
                          <p className="mt-1 text-amber-700 break-words">{importResult.station_fill_skipped_not_in_master.join(' · ')}</p>
                          <p className="mt-1 text-amber-700">Those items keep no station (their KOTs use the floor’s food/bar fallback printer). Add the station under <b>Settings → Stations</b> and re-import, or set it in the item form.</p>
                        </div>
                      )}
                      {/* An unknown category in the file is ACCEPTED and added to
                          the category list, so it can be corrected afterwards —
                          never refused, never silently dropped. Name them, or the
                          admin has no way to know what the file just added. */}
                      {importResult.created_categories?.length > 0 && (
                        <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3 text-xs">
                          <p className="font-medium text-[#8B5A2B]">
                            {importResult.created_categories.length} new categor{importResult.created_categories.length === 1 ? 'y was' : 'ies were'} added to the category list from this file:
                          </p>
                          <p className="mt-1 text-[#6B5744]">
                            {importResult.created_categories.map((c: { name: string }) => c.name).join(' · ')}
                          </p>
                          <p className="mt-1 text-[#8B7355]">Open <b>Manage categories</b> to rename, reorder or retire any of them. The items already carry the name either way.</p>
                        </div>
                      )}
                      {/* The file spelled a category the list already has, with
                          different capitalisation. No second entry is created —
                          the list treats the two as one name — but the ITEMS keep
                          the file's spelling, so they sit off the list's exact
                          string and the item form marks them. Say so: creating
                          nothing and saying nothing was how this hid. */}
                      {importResult.categories_spelled_differently?.length > 0 && (
                        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs">
                          <p className="font-medium text-amber-800">
                            {importResult.categories_spelled_differently.length} categor{importResult.categories_spelled_differently.length === 1 ? 'y is' : 'ies are'} spelled differently in this file than in the category list:
                          </p>
                          <p className="mt-1 text-amber-700 break-words">
                            {importResult.categories_spelled_differently.map((c: { file: string; list: string }) => `“${c.file}” (list has “${c.list}”)`).join(' · ')}
                          </p>
                          <p className="mt-1 text-amber-700">No duplicate entry was added — the list treats those as one category. The imported items kept the file’s spelling, so they show as “not in the category list” until you open one and pick the listed name.</p>
                        </div>
                      )}
                      {/* Only an admin may grow the category list (its own
                          endpoint is admin-only). The items were still written
                          with their category exactly as the file gave it. */}
                      {importResult.categories_need_admin?.length > 0 && (
                        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs">
                          <p className="font-medium text-amber-800">
                            {importResult.categories_need_admin.length} new categor{importResult.categories_need_admin.length === 1 ? 'y' : 'ies'} in this file {importResult.categories_need_admin.length === 1 ? 'is' : 'are'} not in the category list, and only an admin can add {importResult.categories_need_admin.length === 1 ? 'it' : 'them'}:
                          </p>
                          <p className="mt-1 text-amber-700 break-words">{importResult.categories_need_admin.join(' · ')}</p>
                          <p className="mt-1 text-amber-700">The items were imported and carry the name already — ask an admin to add {importResult.categories_need_admin.length === 1 ? 'it' : 'them'} under <b>Manage categories</b> so the item form offers {importResult.categories_need_admin.length === 1 ? 'it' : 'them'}.</p>
                        </div>
                      )}
                      {importResult.categories_too_long?.length > 0 && (
                        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs">
                          <p className="font-medium text-amber-800">
                            {importResult.categories_too_long.length} categor{importResult.categories_too_long.length === 1 ? 'y was' : 'ies were'} too long for the category list (over 60 characters), so {importResult.categories_too_long.length === 1 ? 'it was' : 'they were'} not added:
                          </p>
                          <p className="mt-1 text-amber-700 break-words">{importResult.categories_too_long.join(' · ')}</p>
                          <p className="mt-1 text-amber-700">The items still carry the name — they simply are not offered in the picker. Rename them to something shorter to fix that.</p>
                        </div>
                      )}
                      {importResult.typos_fixed?.length > 0 && (
                        <details className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs">
                          <summary className="cursor-pointer font-medium text-amber-800">🔧 {importResult.typos_fixed.length} typos fixed (click to view)</summary>
                          <div className="mt-2 max-h-48 overflow-y-auto bg-white rounded p-2 space-y-1">
                            {importResult.typos_fixed.map((t: string, i: number) => <p key={i} className="text-amber-700">{t}</p>)}
                          </div>
                        </details>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editItem && (
        // THE KEY IS LOAD-BEARING. EditItemModal seeds `form` with
        // useState({ ...item }), which runs ONLY on mount — so if this element
        // stays mounted while `editItem` changes from one row to another, React
        // reuses the instance and the form keeps showing, and SAVES, the
        // previous item's values against the new item's id.
        //
        // Mouse users cannot reach that: the modal is `fixed inset-0` over a
        // full-screen backdrop whose onClick is onClose, so any click aimed at
        // another row's Edit button closes this one first and the next open is a
        // fresh mount. KEYBOARD USERS CAN. Focus is not trapped in the card, so
        // Tab walks into the page behind and Enter on another row's Edit fires
        // setEditItem(other) with no unmount in between.
        //
        // Keying on the item's id makes the swap a remount, so `form` is reseeded
        // from the row actually being edited whatever route got us here. NEW_ITEM
        // has no id; 'new' keeps its key stable so typing into the add form does
        // not remount it out from under the user.
        <EditItemModal key={editItem.id || 'new'} item={editItem} onClose={() => setEditItem(null)} onSave={saveEdit} menuCategories={menuCats}
                       stationMaster={stationMaster} stationSentinels={stationSentinels} stationsLoaded={stationsLoaded} isAdmin={isAdmin} isNew={!editItem.id}
                       canWriteRecipes={canWriteRecipes} />
      )}

      {/* QUICK RECIPE. Keyed on the menu item id for the same reason
          EditItemModal is: the modal seeds its line state on mount, so swapping
          the target without a remount would carry one dish's ingredients onto
          another dish's id. */}
      {quickFor && materialsState === 'ready' && (
        <QuickRecipeModal
          key={quickFor.id}
          target={{
            id: quickFor.id,
            name: quickFor.name,
            category: quickFor.category,
            selling_price: quickFor.selling_price,
            item_type: quickFor.item_type,
          }}
          materials={materials}
          approximateSupported={approximateSupported}
          onClose={() => setQuickFor(null)}
          onSaved={() => {
            setQuickFor(null);
            // Re-read the list so the new cost, FC% and badge appear on the row
            // straight away, from the server's own numbers rather than a
            // client-side guess at what was just saved.
            fetchItems();
            // …and the backlog, which is now one dish shorter. Reloaded from the
            // server rather than spliced client-side, so the count the owner
            // watches is the database's count.
            setRecipeLinkNonce(n => n + 1);
            showToast(`Approximate recipe saved for ${quickFor.name}`);
          }}
        />
      )}
      {quickFor && materialsState === 'loading' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setQuickFor(null)} />
          <div className="relative bg-white border border-[#E8D5C4] rounded-2xl shadow-2xl px-6 py-5 flex items-center gap-3">
            <Loader2 className="w-4 h-4 animate-spin text-[#af4408]" />
            <span className="text-sm text-[#3D2614]">Loading materials…</span>
          </div>
        </div>
      )}
      {quickFor && materialsState === 'error' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setQuickFor(null)} />
          <div className="relative bg-white border border-[#E8D5C4] rounded-2xl shadow-2xl px-6 py-5 max-w-sm">
            <p className="text-sm text-[#3D2614] mb-3">Could not load the material list, so a recipe cannot be written right now.</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setQuickFor(null)} className="px-3 py-1.5 text-sm text-[#6B5744] hover:bg-[#FFF1E3] rounded-lg">Close</button>
              <button onClick={() => { setMaterialsState('idle'); openQuickRecipe(quickFor); }}
                      className="px-3 py-1.5 text-sm rounded-lg bg-[#af4408] text-white">Try again</button>
            </div>
          </div>
        </div>
      )}

      {/* LINK AN EXISTING RECIPE. Keyed on the menu item for the same reason the
          two modals above are — it seeds its search box on mount. */}
      {linkFor && recipeBookState === 'ready' && (
        <LinkRecipeModal
          key={linkFor.id}
          item={linkFor}
          recipes={recipeBook}
          onClose={() => setLinkFor(null)}
          onLink={(recipeId) => linkRecipe(linkFor.id, recipeId)}
          onLinked={(recipeName) => showToast(`“${linkFor.name}” now uses ${recipeName}`)}
        />
      )}
      {linkFor && recipeBookState === 'loading' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setLinkFor(null)} />
          <div className="relative bg-white border border-[#E8D5C4] rounded-2xl shadow-2xl px-6 py-5 flex items-center gap-3">
            <Loader2 className="w-4 h-4 animate-spin text-[#af4408]" />
            <span className="text-sm text-[#3D2614]">Loading the recipe book…</span>
          </div>
        </div>
      )}
      {linkFor && recipeBookState === 'error' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setLinkFor(null)} />
          <div className="relative bg-white border border-[#E8D5C4] rounded-2xl shadow-2xl px-6 py-5 max-w-sm">
            <p className="text-sm text-[#3D2614] mb-3">Could not load the recipe book, so nothing can be linked right now.</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setLinkFor(null)} className="px-3 py-1.5 text-sm text-[#6B5744] hover:bg-[#FFF1E3] rounded-lg">Close</button>
              <button onClick={() => { setRecipeBookState('idle'); openLinkRecipe(linkFor); }}
                      className="px-3 py-1.5 text-sm rounded-lg bg-[#af4408] text-white">Try again</button>
            </div>
          </div>
        </div>
      )}

      {/* Category master (admin) */}
      {manageCatsOpen && isAdmin && (
        <ManageCategoriesModal
          categories={menuCats}
          orphans={catOrphans}
          onClose={() => setManageCatsOpen(false)}
          onAdd={addCategory}
          onSetActive={setCategoryActive}
          onReorder={reorderCategories}
          onRename={(name) => { setRenameInitial(name); setRenameOpen(true); }}
        />
      )}

      {/* Bulk category rename (admin). Reached from the manage screen; it is the
          ONE path that writes menu_items.category, and the server moves the
          master row with the items in the same transaction. The picker list it
          is given merges the master with the strings items actually carry, so a
          category that exists only in one of the two is still renameable and
          still counts as a clash. */}
      {renameOpen && isAdmin && (
        <RenameCategoryModal
          categories={renameCandidates}
          counts={globalCatCounts}
          initial={renameInitial || categoryFilter}
          onClose={() => { setRenameOpen(false); setRenameInitial(''); }}
          onRename={renameCategory}
        />
      )}

      {/* Dish photo storage (admin). The one delete path for uploaded photos —
          dry run first, thumbnails of everything it proposes to remove, and a
          second click before anything goes. */}
      {photoStorageOpen && isAdmin && (
        <PhotoStorageModal
          onClose={() => setPhotoStorageOpen(false)}
          onToast={(msg, err) => showToast(msg, err)}
        />
      )}
    </div>
  );
}

function Stat({ label, value, className }: { label: string; value: number; className: string }) {
  return (
    <div className="px-2 sm:px-3 py-3 text-center border-r border-b sm:border-b-0 border-[#F0E4D6]">
      <p className="text-[10px] sm:text-[11px] text-[#8B7355] uppercase tracking-wide truncate">{label}</p>
      <p className={`text-xl sm:text-2xl font-bold mt-1 ${className}`}>{value}</p>
    </div>
  );
}

function fcColor(pct: number): string {
  return pct > 50 ? 'text-red-500' : pct > 30 ? 'text-amber-600' : 'text-green-600';
}

function Avatar({ name, type }: { name: string; type: string }) {
  const initials = (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
  const tone = type === 'liquors' ? 'bg-purple-100 text-purple-700'
    : type === 'beverages' ? 'bg-blue-100 text-blue-700'
    : 'bg-[#F3E2D0] text-[#a8632b]';
  return <div className={`w-9 h-9 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 ${tone}`}>{initials}</div>;
}

// FSSAI-style veg/non-veg marker. Shape (not just colour) distinguishes each state
// for colour-blind users: Veg = dot, Non-Veg = triangle, Egg = ring; plus role/aria
// so screen readers announce it. "?" when a food is missing its tag.
function VegSquare({ tag, type }: { tag: string; type: string }) {
  if (tag === 'Veg')
    return <span role="img" aria-label="Veg" title="Veg" className="inline-flex items-center justify-center w-[18px] h-[18px] rounded border-2 border-green-600"><span className="w-2 h-2 rounded-full bg-green-600" /></span>;
  if (tag === 'Non-Veg')
    return <span role="img" aria-label="Non-Veg" title="Non-Veg" className="inline-flex items-center justify-center w-[18px] h-[18px] rounded border-2 border-red-600"><span className="w-0 h-0 border-l-[4px] border-r-[4px] border-b-[7px] border-l-transparent border-r-transparent border-b-red-600" /></span>;
  if (tag === 'Egg')
    return <span role="img" aria-label="Egg" title="Egg" className="inline-flex items-center justify-center w-[18px] h-[18px] rounded border-2 border-amber-500"><span className="w-2 h-2 rounded-full border-2 border-amber-500" /></span>;
  if (type === 'foods')
    return <span role="img" aria-label="Veg/Non-Veg not set" className="inline-flex items-center justify-center w-[18px] h-[18px] rounded border-2 border-amber-400 text-[11px] font-bold text-amber-500 leading-none" title="Veg/Non-Veg not set">?</span>;
  return <span className="text-[#C4B09A]" aria-hidden>—</span>;
}

/**
 * "Not linked" is a STATE, not an em-dash.
 *
 * This column used to print `—` in #C4B09A — the app's "not applicable" grey,
 * the identical glyph the V/NV column prints for a liquor row. A dish with no
 * recipe therefore looked exactly like a dish for which the question does not
 * arise, and the owner's actual question ("which of my dishes are not costed?")
 * could not be answered by reading the screen.
 *
 * Three things changed:
 *   · A missing recipe on a FOOD item reads "No recipe" in amber and is a button
 *     that opens the quick-recipe screen. On a liquor row it stays a quiet dash,
 *     because a bottle pour genuinely does not want a recipe.
 *   · "Direct" no longer reads as done. 88 active food items carry a material_id
 *     and no recipe — Butter Chicken pointed at Butter — and nothing in the sale
 *     path reads menu_items.material_id, so they cost ₹0 and deduct nothing
 *     while reporting as linked. They are marked for what they are.
 *   · An approximate recipe says so here as well as on the cost.
 */
function LinkBadge({ item, onAddRecipe, canWrite = true }: { item: MenuItem; onAddRecipe?: (it: MenuItem) => void; canWrite?: boolean }) {
  if (item.recipe_id) {
    /**
     * LINKED — and now a way IN.
     *
     * Before this, a linked row was a dead end: the badge was a plain <span> and
     * `grep href="/recipes"` on this file found nothing, so a menu item could
     * never reach its own recipe. That is half of what the owner asked for —
     * editing an item should let him UPDATE its recipe, not only add one. The
     * recipe's name seeds the search on /recipes so the link lands on the recipe
     * itself rather than on a list of 67.
     */
    const href = `/recipes?search=${encodeURIComponent(item.recipe_name || item.name)}`;
    const base = 'text-[11px] font-medium px-2 py-0.5 rounded-md border whitespace-nowrap inline-block hover:underline';

    // LINKED TO AN EMPTY RECIPE. Not a cost that is wrong — no cost at all, on a
    // row that otherwise reads as done. This outranks everything below it,
    // because a dish whose recipe has nothing in it is exactly as uncosted as a
    // dish with no recipe, and only this badge can say so.
    if (item.recipe_empty) {
      return (
        <a href={href}
           title={`${item.recipe_cost_warning}\n\n${item.recipe_cost_warning_fix || ''}`}
           className={`${base} bg-red-50 text-red-700 border-red-300`}>Recipe · empty</a>
      );
    }
    // MOST of this cost is computed in the wrong unit, so the figure is noise.
    // This outranks "approximate": an estimate is useful, noise is not.
    if (item.recipe_cost_unusable) {
      return (
        <a href={href}
           title={`${item.recipe_cost_warning}\n\n${item.recipe_cost_warning_fix || ''}\n\nOpen the recipe to fix it — until then the cost and FC% on this row mean nothing.`}
           className={`${base} bg-red-50 text-red-700 border-red-300`}>Recipe · cost is wrong</a>
      );
    }
    // A bad line whose money the engine can still use — so the figure is KEPT and
    // the row is not struck. Named without shouting, because shouting here is what
    // would stop the shout above being heard.
    //
    // The wording is no longer fixed at "check units": a quantity fault gets its
    // own label and its own closing sentence, because the one this used to print
    // ("the total is still broadly right") is a false reassurance about 700 g of
    // sauce on one plate. See warningLabel / warningClosing.
    if (item.recipe_cost_warning) {
      const quantity = item.recipe_cost_warning_kind === 'quantity';
      return (
        <a href={href}
           title={`${item.recipe_cost_warning}\n\n${item.recipe_cost_warning_fix || ''}\n\n${warningClosing(item.recipe_cost_warning_kind)}`}
           className={`${base} ${quantity ? 'bg-orange-50 text-orange-800 border-orange-300' : 'bg-amber-50 text-amber-800 border-amber-300'}`}
        >Recipe · {warningLabel(item.recipe_cost_warning_kind)}</a>
      );
    }
    return item.recipe_is_approximate
      ? <a href={href}
           title={`Linked to a simple recipe${item.recipe_name ? ` (${item.recipe_name})` : ''} — only the main ingredients, with rough quantities. The cost and FC% on this row are estimates, not measured figures. Open it to finish the recipe.`}
           className={`${base} bg-amber-50 text-amber-800 border-amber-300`}>Recipe · approx</a>
      : <a href={href}
           title={`Linked to ${item.recipe_name ? `the recipe “${item.recipe_name}”` : 'a full recipe'}. The cost and FC% on this row come from it. Open it to change it.`}
           className={`${base} bg-emerald-50 text-emerald-700 border-emerald-200`}>Recipe</a>;
  }

  const isFood = normalizeType(item.item_type) === 'foods' || normalizeType(item.item_type) === 'beverages';

  if (!isFood) {
    // A peg is poured from a bottle: it is costed on the store rail and there is
    // nothing to write a recipe for. The old text ("Not applicable for this item
    // type") named a data model; this names the reason.
    return <span className="text-[#C4B09A]" title="Liquor is poured from a bottle and costed in the store — no recipe needed.">—</span>;
  }

  // NOT LINKED — the state 96% of this menu is in, so it is written calmly. It
  // is a gap to work through, not 234 alarms; red here would train the eye to
  // ignore the column, and the genuinely alarming state (a cost that is wrong)
  // is the one that gets red.
  const material = item.material_id
    // A cooked dish pointed at a single ingredient is not costed — it is a
    // cooked dish pointed at a single ingredient. Nothing in the sale path reads
    // menu_items.material_id, so it costs ₹0 and deducts nothing.
    ? ` It is mapped to the material “${item.material_name || ''}”, which does not cost or deduct anything when it sells.`
    : '';

  if (onAddRecipe && canWrite) {
    return (
      <button
        onClick={() => onAddRecipe(item)}
        title={`No recipe, so this dish records ₹0 food cost and deducts no stock when sold.${material} It still appears on the menu and still sells. Click to add a simple recipe.`}
        className="text-[11px] font-medium px-2 py-0.5 rounded-md bg-white text-[#6B5744] border border-[#D4B896] hover:border-[#af4408] hover:text-[#af4408] hover:bg-[#FFF1E3] inline-flex items-center gap-1 whitespace-nowrap"
      ><Plus className="w-3 h-3" />Not linked</button>
    );
  }

  // Same fact, no button — writing a recipe is a manager's job, so offering the
  // button to anyone else is offering a refusal.
  return (
    <span title={`No recipe, so this dish records ₹0 food cost when sold.${material} It still appears on the menu and still sells. A manager can add a recipe for it.`}
          className="text-[11px] font-medium px-2 py-0.5 rounded-md bg-white text-[#6B5744] border border-[#D4B896] whitespace-nowrap">Not linked</span>
  );
}

/**
 * The Cost cell — and the one rule it must never break: an estimate must never
 * look like a measured figure.
 *
 * Three states, in order of how badly they need saying:
 *   · the linked recipe's units do not convert → the number is WRONG, struck
 *     through and marked, because showing it plainly is how ₹63,012 got believed;
 *   · the recipe is a simple one → "≈", amber, with the row's Recipe badge
 *     spelling out "approx" beside it and the key under the table saying what
 *     that means in words (a tooltip alone is useless on a tablet);
 *   · a full recipe, or a direct material cost → the plain figure.
 *
 * Keyed on whether a RECIPE EXISTS, never on the cost being non-zero: a linked
 * recipe costing ₹0 is a real and important answer, and hiding it behind the
 * same em-dash as "no recipe at all" is how a dish with unpriced ingredients
 * disappears.
 */
function CostCell({ it }: { it: MenuItem }) {
  if (it.recipe_id) {
    const cost = Number(it.recipe_cost) || 0;
    // An empty recipe's ₹0.00 is ACCURATE — it is just not a cost. Printing it
    // plainly (which is what happened) put a costed-looking zero on a dish
    // nobody has costed, so the zero is shown with the reason attached.
    if (it.recipe_empty) {
      return (
        <span className="text-red-600" title={`${it.recipe_cost_warning}\n\n${it.recipe_cost_warning_fix || ''}`}>
          {formatCurrency(0)}
        </span>
      );
    }
    // Struck through ONLY when the figure is noise. A dish whose bad line is
    // ₹1.67 of ₹152 keeps its number and gets the quieter mark on its Recipe
    // badge — see LinkBadge, and the grading in /api/menu-items.
    if (it.recipe_cost_unusable) {
      return (
        <span className="text-red-600" title={`${it.recipe_cost_warning}\n\n${it.recipe_cost_warning_fix || ''}`}>
          <span className="line-through decoration-red-400/60">{formatCurrency(cost)}</span>
        </span>
      );
    }
    return (
      <span
        className={it.recipe_cost_warning ? 'text-amber-800' : it.recipe_is_approximate ? 'text-amber-800' : undefined}
        title={it.recipe_is_approximate
          ? `Approximate — from a simple recipe covering only the main ingredients. Treat ${formatCurrency(cost)} as an estimate, not a costed figure.`
          : undefined}
      >{it.recipe_is_approximate && <span aria-label="approximate">≈</span>}{formatCurrency(cost)}</span>
    );
  }
  if (it.material_cost) return <>{formatCurrency(it.material_cost)}</>;
  return <span className="text-[#C4B09A]">—</span>;
}

function RowToggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return <Toggle checked={on} onChange={() => onClick()} size="sm" label={on ? 'Active' : 'Inactive'} />;
}

// ⋮ row menu. The dropdown is fixed-positioned so it isn't clipped by the
// table's horizontal-scroll container.
function RowMenu({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const computePos = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    // Trigger scrolled fully out of view → close instead of floating detached
    if (r.bottom < 0 || r.top > window.innerHeight) { setOpen(false); return; }
    // Flip above the trigger near the viewport bottom (2 items ≈ 78px) so the
    // menu never runs off-screen — same fix as the recipes row menu.
    const menuH = 2 * 34 + 10;
    const below = r.bottom + 4;
    const top = below + menuH > window.innerHeight - 8 ? Math.max(8, r.top - menuH - 4) : below;
    setPos({ top, right: Math.max(8, window.innerWidth - r.right) });
  }, []);
  const openMenu = () => {
    computePos();
    setOpen(true);
  };
  // Follow the trigger on scroll/resize so the menu stays glued to its row.
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    const onMove = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(computePos); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, computePos]);
  return (
    <>
      <button ref={btnRef} onClick={() => (open ? setOpen(false) : openMenu())} className="p-1.5 rounded-lg text-[#8B7355] hover:bg-[#FFF1E3]" aria-label="Row actions">
        <MoreVertical className="w-4 h-4" />
      </button>
      {/* Portaled to <body>: ancestors carry transforms (card hover-lift,
          fade-up animations) which re-anchor position:fixed to the card. */}
      {open && pos && typeof document !== 'undefined' && createPortal(
        <>
          <div className="fixed inset-0 z-[94]" onClick={() => setOpen(false)} />
          <div style={{ top: pos.top, right: pos.right }} className="fixed z-[95] w-32 bg-white border border-[#E8D5C4] rounded-lg shadow-xl py-1 text-sm">
            <button onClick={() => { setOpen(false); onEdit(); }} className="w-full text-left px-3 py-1.5 hover:bg-[#FFF1E3] flex items-center gap-2 text-[#2D1B0E]"><Edit className="w-3.5 h-3.5" />Edit</button>
            <button onClick={() => { setOpen(false); onDelete(); }} className="w-full text-left px-3 py-1.5 hover:bg-red-50 flex items-center gap-2 text-red-600"><Trash2 className="w-3.5 h-3.5" />Delete</button>
          </div>
        </>,
        document.body
      )}
    </>
  );
}

function StatBlock({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-2 text-center">
      <p className="text-[10px] text-[#8B7355] uppercase tracking-wide">{label}</p>
      <p className={`text-lg font-bold ${color}`}>{value}</p>
    </div>
  );
}

function TypeBadge({ type }: { type: string }) {
  const map: Record<string, { bg: string; text: string; label: string }> = {
    foods: { bg: 'bg-orange-100', text: 'text-orange-700', label: 'Food' },
    liquors: { bg: 'bg-purple-100', text: 'text-purple-700', label: 'Liquor' },
    beverages: { bg: 'bg-blue-100', text: 'text-blue-700', label: 'Bev' },
    'beverages.': { bg: 'bg-blue-100', text: 'text-blue-700', label: 'Bev' },
  };
  const m = map[type] || { bg: 'bg-gray-100', text: 'text-gray-700', label: type || '—' };
  return <span className={`text-[10px] px-2 py-0.5 rounded-full ${m.bg} ${m.text} font-medium`}>{m.label}</span>;
}

function AttnPill({ tone, count, label, active, onClick }: { tone: 'red' | 'amber' | 'blue'; count: number; label: string; active: boolean; onClick: () => void }) {
  const tones: Record<string, string> = {
    red: active ? 'bg-red-600 text-white border-red-600' : 'bg-white text-red-700 border-red-200 hover:bg-red-50',
    amber: active ? 'bg-amber-500 text-white border-amber-500' : 'bg-white text-amber-800 border-amber-300 hover:bg-amber-50',
    blue: active ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-blue-700 border-blue-200 hover:bg-blue-50',
  };
  return (
    <button onClick={onClick} className={`text-xs font-medium px-2.5 py-1 rounded-full border transition-colors ${tones[tone]}`}>
      <span className="font-bold">{count}</span> {label}
    </button>
  );
}

function SegmentedVeg({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const opts: [string, string][] = [['', 'All'], ['Veg', 'Veg'], ['Non-Veg', 'Non-Veg']];
  return (
    <div className="inline-flex rounded-xl border border-[#E0D0BE] bg-white p-0.5 shadow-sm">
      {opts.map(([v, label]) => {
        const on = value === v;
        const activeCls = v === '' ? 'bg-[#af4408] text-white' : v === 'Veg' ? 'bg-green-600 text-white' : 'bg-red-600 text-white';
        const idleCls = v === 'Veg' ? 'text-green-700 hover:bg-[#FFF1E3]' : v === 'Non-Veg' ? 'text-red-600 hover:bg-[#FFF1E3]' : 'text-[#6B5744] hover:bg-[#FFF1E3]';
        return <button key={v || 'all'} onClick={() => onChange(v)} className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${on ? activeCls : idleCls}`}>{label}</button>;
      })}
    </div>
  );
}

/**
 * Linked / Not linked, as a filter.
 *
 * Same shape as the Veg control beside it so it reads as one more way of
 * narrowing the list, which is exactly what it is. "Not linked" means a DISH
 * with no recipe — liquor is never counted, because a poured peg does not want
 * one and folding 245 bottles in would bury the 234 dishes that do.
 *
 * Nothing about this reaches a menu. It filters an admin table.
 */
function SegmentedLink({ value, onChange, unlinkedCount, linkedCount }: {
  value: '' | 'linked' | 'unlinked';
  onChange: (v: '' | 'linked' | 'unlinked') => void;
  /**
   * THE BACKLOG NUMBER, carried on the control that filters to it.
   *
   * Both are the SERVER's counts, over ACTIVE dishes — the same needsRecipe()
   * predicate the backlog list is built from, so this badge and that panel are
   * two views of one number and cannot drift apart. Optional so the control
   * still renders before the first load has landed; the badge simply is not
   * there rather than flashing a zero that reads as "nothing left to do".
   */
  unlinkedCount?: number;
  linkedCount?: number;
}) {
  const counts: Record<string, number | undefined> = { '': undefined, linked: linkedCount, unlinked: unlinkedCount };
  const opts: ['' | 'linked' | 'unlinked', string, string][] = [
    ['', 'All', 'Every item, linked or not'],
    ['linked', 'Linked', 'Active dishes that have a recipe, so they record a food cost'],
    ['unlinked', 'Not linked', 'Active dishes with no recipe — they still sell, they just record no food cost. This is the backlog count.'],
  ];
  return (
    <div className="inline-flex rounded-xl border border-[#E0D0BE] bg-white p-0.5 shadow-sm">
      <span className="sr-only">Filter by recipe</span>
      {opts.map(([v, label, hint]) => {
        const on = value === v;
        const n = counts[v];
        return (
          <button key={v || 'all'} onClick={() => onChange(v)} title={hint}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors inline-flex items-center gap-1.5 ${
                    on ? (v === 'linked' ? 'bg-emerald-600 text-white' : v === 'unlinked' ? 'bg-[#6B5744] text-white' : 'bg-[#af4408] text-white')
                       : 'text-[#6B5744] hover:bg-[#FFF1E3]'}`}>
            {label}
            {typeof n === 'number' && (
              <span className={`text-[11px] font-bold tabular-nums px-1.5 py-px rounded ${
                on ? 'bg-white/25' : v === 'unlinked' ? 'bg-[#F0E4D6] text-[#6B5744]' : 'bg-emerald-50 text-emerald-700'}`}>
                {n}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * THE PROMPT, after a menu item is created or saved.
 *
 * It is a card in the corner and not a dialog, and that is the whole point. The
 * item is already on the menu by the time this appears. It has no backdrop, it
 * takes no focus, it covers no control, and dismissing it does nothing except
 * dismiss it. A dish added in the middle of service is never held up by it.
 *
 * Two shapes, because the owner asked for both halves: an unlinked dish is
 * offered a recipe; a linked one is shown what it is linked to and offered the
 * way to go and change it — which, before this, was a journey this screen could
 * not make at all.
 *
 * THREE ANSWERS on the unlinked shape, not two. "Write one" and "give up" is a
 * false choice in a kitchen that already holds 67 recipes: a new listing of
 * "Thecha Tandoori Murgh" may well be cooked from a recipe somebody wrote months
 * ago, and a prompt that only offers to write a NEW one is a prompt that
 * manufactures a second recipe for one dish — two ingredient lists to keep in
 * step and two food costs to argue about. So: add a simple recipe, link an
 * existing one, or not now.
 *
 * PROMPT, NOT BLOCK. The item was saved before this component was ever
 * rendered. Every one of the three answers — the ✕, ignoring it, walking away
 * — leaves it exactly as saved.
 */
function RecipePromptCard({ item, created, onAddRecipe, onLinkExisting, onDismiss }: {
  item: MenuItem; created: boolean; onAddRecipe: () => void; onLinkExisting: () => void; onDismiss: () => void;
}) {
  const linked = !!item.recipe_id;
  /**
   * ESCAPE DISMISSES IT. "Not now" and the ✕ already did, so this is a convention
   * rather than a fix for a block — but Escape is what a keyboard user presses to
   * make a prompt go away, and a key that does nothing reads as a stuck screen.
   *
   * Safe on this component specifically because dismissing is a pure no-op: the
   * menu item was saved before this card was ever rendered, so there is no path
   * where Escape here loses anything.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);
  return (
    <div className="fixed bottom-6 left-4 right-4 sm:left-auto sm:right-6 sm:bottom-20 z-[95] sm:max-w-sm bg-white border border-[#D4B896] rounded-2xl shadow-xl px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-[#2D1B0E]">
            {created ? `“${item.name}” is on the menu.` : `“${item.name}” saved.`}
          </p>
          {linked ? (
            <p className="text-[11px] text-[#6B5744] mt-1 leading-relaxed">
              It uses the recipe <b>{item.recipe_name || 'it is linked to'}</b>. Open it if the dish has changed — the
              food cost on this page comes from that recipe.
            </p>
          ) : (
            <p className="text-[11px] text-[#6B5744] mt-1 leading-relaxed">
              It has no recipe yet, so it will sell and print normally but record <b>₹0 food cost</b>. Adding even the
              two or three expensive ingredients gives it an approximate cost.
            </p>
          )}
          {/* Wraps on a phone, where three controls do not fit one row. */}
          <div className="flex items-center gap-2 mt-2.5 flex-wrap">
            {linked ? (
              // Seeded with the recipe's name so it lands ON the recipe rather
              // than on a list of 67 — /recipes reads ?search= on mount.
              <a href={`/recipes?search=${encodeURIComponent(item.recipe_name || item.name)}`}
                 className="px-3 py-1.5 text-[12px] font-medium rounded-lg bg-[#af4408] text-white hover:bg-[#8a3506]">
                Open recipe
              </a>
            ) : (
              <>
                <button onClick={onAddRecipe} className="px-3 py-1.5 text-[12px] font-medium rounded-lg bg-[#af4408] text-white hover:bg-[#8a3506] inline-flex items-center gap-1.5">
                  <Plus className="w-3.5 h-3.5" /> Add a simple recipe
                </button>
                {/* The answer that stops this kitchen growing a second recipe
                    for a dish it already has one for. */}
                <button onClick={onLinkExisting}
                        title="This dish may already be cooked from a recipe somebody wrote for another listing — link it instead of writing a second one."
                        className="px-3 py-1.5 text-[12px] font-medium rounded-lg border border-[#D4B896] text-[#6B5744] hover:border-[#af4408] hover:text-[#af4408] hover:bg-[#FFF1E3] inline-flex items-center gap-1.5">
                  <LinkIcon className="w-3.5 h-3.5" /> Link an existing recipe
                </button>
              </>
            )}
            {/* The exit. Costs one click and nothing else — the item is saved. */}
            <button onClick={onDismiss} className="px-3 py-1.5 text-[12px] font-medium rounded-lg text-[#6B5744] hover:bg-[#FFF1E3]">
              Not now
            </button>
          </div>
        </div>
        <button onClick={onDismiss} aria-label="Dismiss" className="p-1 rounded-lg text-[#8B7355] hover:bg-[#FFF1E3] shrink-0">
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

/**
 * LINK AN EXISTING RECIPE TO THIS MENU ITEM.
 *
 * The other half of the owner's direction. "Create a recipe from the item" is
 * the new-dish answer; this is the answer for the dish that is already cooked
 * from something in the book. Without it the only way to cost a re-listed dish
 * is to write its recipe a second time, and a kitchen with two recipes for one
 * dish has two ingredient lists to keep in step and two food costs to argue
 * about.
 *
 * WHAT IT WRITES: menu_items.recipe_id, via PUT /api/menu-items. The MENU ITEM
 * claims the recipe. Nothing here edits a recipe or decides what is on a menu.
 *
 * SHARING IS LEGAL, AND IS SAID OUT LOUD. A recipe may serve several listings —
 * the same dish on the à la carte menu and on a party menu. When that happens
 * the recipe's food cost is measured against the CHEAPEST live priced listing
 * (src/lib/recipe-price.ts), because FC% is a risk number and the cautious
 * reading is the right one. That is a real consequence of pressing this button,
 * so the row that is about to cause it says so before it is pressed, with the
 * arithmetic spelled out — not afterwards in a tooltip.
 */
function LinkRecipeModal({ item, recipes, onClose, onLink, onLinked }: {
  item: MenuItem;
  recipes: RecipeLite[];
  onClose: () => void;
  /** Returns null on success, or the server's refusal as a string. */
  onLink: (recipeId: string) => Promise<string | null>;
  onLinked: (recipeName: string) => void;
}) {
  const [q, setQ] = useState(item.name || '');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const price = Number(item.selling_price) || 0;

  /**
   * Ranked, not merely filtered. The recipe this dish wants is nearly always the
   * one whose name shares words with it, so an exact name match sorts first, a
   * prefix next, then any substring, then everything else alphabetically. The
   * box is SEEDED with the item's own name, so the likely answer is usually the
   * first row before anything is typed — and clearing the box still shows the
   * whole book, because a dish is not always named after its recipe.
   */
  const ranked = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const scored = recipes.map((r) => {
      const name = (r.name || '').toLowerCase();
      let score = 4;
      if (needle) {
        if (name === needle) score = 0;
        else if (name.startsWith(needle)) score = 1;
        else if (name.includes(needle)) score = 2;
        else if ((r.category || '').toLowerCase().includes(needle)) score = 3;
        else score = 9;  // filtered out below
      }
      return { r, score };
    });
    return scored
      .filter((s) => s.score < 9)
      .sort((a, b) => (a.score - b.score) || (a.r.name || '').localeCompare(b.r.name || ''))
      .slice(0, 60);
  }, [recipes, q]);

  const doLink = async (r: RecipeLite) => {
    setBusyId(r.id);
    setError(null);
    const err = await onLink(r.id);
    if (err) { setError(err); setBusyId(null); return; }
    onLinked(r.name);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
           className="relative w-full max-w-2xl bg-white border border-[#E8D5C4] rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        <div className="flex items-start justify-between px-5 sm:px-6 py-4 border-b border-[#E8D5C4] shrink-0">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-[#2D1B0E] truncate">Link a recipe — {item.name}</h2>
            <p className="text-[11px] text-[#8B7355] mt-0.5">
              Pick the recipe this dish is actually cooked from. Its cost becomes this item&rsquo;s food cost.
              {price > 0
                ? <> Measured against the <b>{formatCurrency(price)}</b> menu price.</>
                : <> This item has no price, so no food cost % can be shown for it.</>}
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[#FFF1E3] shrink-0"><X className="w-5 h-5" /></button>
        </div>

        <div className="px-5 sm:px-6 py-3 border-b border-[#F0E4D6] shrink-0">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8B7355]" />
            <input
              autoFocus value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Search the recipe book…"
              className="w-full pl-9 pr-3 py-2 bg-white border border-[#D4B896] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]/40"
            />
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 sm:px-6 py-4">
          {error && (
            <p className="text-[12px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">{error}</p>
          )}

          {recipes.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-sm text-[#6B5744]">There are no recipes yet.</p>
              <p className="text-[11px] text-[#8B7355] mt-1">Close this and choose &ldquo;Add a simple recipe&rdquo; instead.</p>
            </div>
          ) : ranked.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-sm text-[#6B5744]">No recipe matches &ldquo;{q}&rdquo;.</p>
              <button onClick={() => setQ('')} className="text-[11px] text-[#af4408] hover:underline mt-1">Show the whole book</button>
            </div>
          ) : (
            <div className="space-y-1.5">
              {ranked.map(({ r }) => {
                const cost = Number(r.total_cost) || 0;
                const fc = price > 0 && cost > 0 ? Math.round((cost / price) * 1000) / 10 : null;
                const sharedWith = r.linked_menu_item_id && r.linked_menu_item_id !== item.id
                  ? r.linked_menu_item_name || 'another menu item'
                  : null;
                const busy = busyId === r.id;
                return (
                  <button
                    key={r.id}
                    disabled={!!busyId}
                    onClick={() => doLink(r)}
                    className="w-full text-left rounded-lg border border-[#E8D5C4] bg-[#FFFBF6] hover:border-[#af4408] hover:bg-[#FFF1E3] disabled:opacity-50 px-3 py-2.5 transition-colors"
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[13px] font-medium text-[#2D1B0E] flex-1 min-w-[140px]">{r.name}</span>
                      {/* The recipe's OWN quality marks, carried onto the choice
                          rather than discovered after the link is made. */}
                      {r.sanity_has_blocker && (
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-red-50 text-red-700 border border-red-300">check units</span>
                      )}
                      {r.is_approximate && (
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-300">approx</span>
                      )}
                      <span className="text-[12px] text-[#6B5744] tabular-nums">{formatCurrency(cost)}</span>
                      {fc !== null && (
                        <span className={`text-[12px] tabular-nums ${fc > 100 ? 'text-red-600 font-semibold' : fc > 40 ? 'text-amber-700' : 'text-emerald-700'}`}>
                          {busy ? '' : `${fc}%`}
                        </span>
                      )}
                      {busy && <Loader2 className="w-3.5 h-3.5 animate-spin text-[#af4408]" />}
                    </div>
                    <p className="text-[10px] text-[#8B7355] mt-0.5">
                      {r.category || 'No category'}
                      {sharedWith && (
                        <span className="text-amber-800">
                          {' · '}already used by <b>{sharedWith}</b> — linking it here gives one recipe two listings, and its
                          food cost is then measured against whichever of them is cheaper
                        </span>
                      )}
                    </p>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-[#E8D5C4] px-5 sm:px-6 py-3 bg-[#FFFBF6] flex items-center justify-between gap-3">
          <p className="text-[10px] text-[#8B7355]">
            This links the dish to a recipe. It does not change the recipe, and it does not change the menu.
          </p>
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-[#6B5744] hover:bg-[#FFF1E3] rounded-lg shrink-0">Cancel</button>
        </div>
      </div>
    </div>
  );
}

/**
 * THE BACKLOG — the dishes with no recipe, in the order that costs the most to
 * leave alone.
 *
 * ORDERED BY PORTIONS SOLD, and the panel says so on its face, because an
 * unexplained order is an order nobody trusts. Revenue was the obvious key and
 * it is the wrong one on this data: 4,732 comped portions and 863 NC portions
 * carry quantity and zero revenue, and a comped plate costs the kitchen exactly
 * what a sold one costs. "Staff Roti" sells 331 portions at ₹0 — last of 234 by
 * money, eighth by food. The money still rides along on every row; it just does
 * not decide the order. See buildBacklog() in the API route.
 *
 * NOT A SECOND TABLE OF THE MENU. It is one job list with the two actions that
 * finish a row on it, and it shrinks as they are used.
 */
function RecipeBacklogPanel({ rows, meta, state, remaining, onClose, onRetry, onAddRecipe, onLinkExisting, onEdit }: {
  rows: BacklogRow[] | null;
  meta: BacklogMeta | null;
  state: 'idle' | 'loading' | 'ready' | 'error' | 'denied';
  /** The server's count of active dishes with no recipe — the same figure the filter badge carries. */
  remaining: number;
  onClose: () => void;
  onRetry: () => void;
  onAddRecipe: (row: BacklogRow) => void;
  onLinkExisting: (row: BacklogRow) => void;
  onEdit: (row: BacklogRow) => void;
}) {
  const [limit, setLimit] = useState(25);

  const shown = (rows || []).slice(0, limit);
  const sold = (rows || []).filter(r => r.portions > 0).length;

  return (
    <div className="bg-white border border-[#D4B896] rounded-2xl shadow-sm overflow-hidden">
      {/* flex-nowrap is the documented opt-out from house rule 9 in
          globals.css, which wraps every `main .flex.gap-*` so toolbar chips do
          not squish. This is a title-and-close row, not a toolbar: without the
          opt-out the ✕ dropped onto a second line at the LEFT edge on a 375px
          phone, which is not where a close button lives in any other dialog in
          this app. Measured, not guessed — getBoundingClientRect put it at
          x=41, y=462, below the paragraph. */}
      <div className="flex flex-nowrap items-start justify-between gap-3 px-4 sm:px-5 py-3.5 border-b border-[#F0E4D6] bg-[#FFFBF6]">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-[#2D1B0E] inline-flex items-center gap-2">
            <ListChecks className="w-4 h-4 text-[#af4408]" />
            Recipe backlog
            <span className="text-[12px] font-bold tabular-nums px-2 py-0.5 rounded-full bg-[#6B5744] text-white">{remaining}</span>
          </h2>
          <p className="text-[11px] text-[#8B7355] mt-1 leading-relaxed">
            Active dishes with no recipe, <b>most portions first</b> — a comped or NC plate costs the kitchen exactly what a
            sold one does, so portions, not revenue, decide the order.
            {meta && meta.sales_days > 0 && (
              <> Counted across <b>{meta.sales_days}</b> day{meta.sales_days === 1 ? '' : 's'} of imported sales
                {meta.sales_from && meta.sales_to ? <> ({meta.sales_from} to {meta.sales_to})</> : null}.</>
            )}
            {rows && rows.length > 0 && <> {sold} of these {rows.length} have a recorded sale.</>}
          </p>
        </div>
        <button onClick={onClose} aria-label="Close the backlog" className="p-1.5 rounded-lg text-[#8B7355] hover:bg-[#FFF1E3] shrink-0">
          <X className="w-4 h-4" />
        </button>
      </div>

      {state === 'loading' && (
        <div className="px-5 py-8 flex items-center justify-center gap-2 text-sm text-[#6B5744]">
          <Loader2 className="w-4 h-4 animate-spin text-[#af4408]" /> Working out which dishes cost the most to leave…
        </div>
      )}

      {state === 'denied' && (
        <div className="px-5 py-6 text-center">
          <p className="text-sm text-[#3D2614]">This list is for managers and admins.</p>
          <p className="text-[11px] text-[#8B7355] mt-1">
            It carries what each dish took at the till, and every action on it writes a recipe.
          </p>
        </div>
      )}

      {state === 'error' && (
        <div className="px-5 py-6 text-center">
          <p className="text-sm text-[#3D2614]">Could not load the backlog.</p>
          <button onClick={onRetry} className="mt-2 px-3 py-1.5 text-sm rounded-lg bg-[#af4408] text-white inline-flex items-center gap-1.5">
            <RefreshCw className="w-3.5 h-3.5" /> Try again
          </button>
        </div>
      )}

      {state === 'ready' && rows && rows.length === 0 && (
        <div className="px-5 py-8 text-center">
          <CheckCircle className="w-6 h-6 text-emerald-600 mx-auto" />
          <p className="text-sm font-medium text-[#2D1B0E] mt-2">Every active dish has a recipe.</p>
          <p className="text-[11px] text-[#8B7355] mt-1">Nothing on the menu is selling at ₹0 food cost.</p>
        </div>
      )}

      {state === 'ready' && rows && rows.length > 0 && (
        <>
          {/* Desktop */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[#FFF8F0] text-[11px] uppercase tracking-wide text-[#8B7355]">
                <tr>
                  <th className="text-left py-2 px-4 font-medium w-10">#</th>
                  <th className="text-left py-2 px-3 font-medium">Dish</th>
                  <th className="text-right py-2 px-3 font-medium" title="Portions that left the kitchen, every bill type — the order of this list.">Portions</th>
                  <th className="text-right py-2 px-3 font-medium" title="Taken at the till while recording no food cost at all.">Uncosted sales</th>
                  <th className="text-right py-2 px-3 font-medium">Price</th>
                  <th className="text-right py-2 px-4 font-medium">Recipe</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F5EDE4]">
                {shown.map((r, i) => (
                  <tr key={r.id} className="hover:bg-[#FFFBF6]">
                    <td className="py-2.5 px-4 text-[11px] text-[#B9A386] tabular-nums">{i + 1}</td>
                    <td className="py-2.5 px-3">
                      <button onClick={() => onEdit(r)} className="text-[13px] font-medium text-[#2D1B0E] hover:text-[#af4408] hover:underline text-left">
                        {r.name}
                      </button>
                      <p className="text-[10px] text-[#8B7355]">
                        {r.category || 'No category'}
                        {r.material_id && (
                          <span className="text-amber-800" title="Nothing in the sale path reads this mapping — it costs ₹0 and deducts no stock.">
                            {' · '}mapped to {r.material_name || 'a material'}, which costs nothing
                          </span>
                        )}
                      </p>
                    </td>
                    <td className="py-2.5 px-3 text-right tabular-nums">
                      {r.has_sales ? (
                        <>
                          <span className="text-[13px] text-[#2D1B0E] font-medium">{r.portions.toLocaleString('en-IN')}</span>
                          {r.portions_free > 0 && (
                            <p className="text-[10px] text-[#8B7355]" title="Comped and NC portions. Nobody paid, the kitchen still cooked them.">
                              {r.portions_free.toLocaleString('en-IN')} free
                            </p>
                          )}
                        </>
                      ) : (
                        <span className="text-[11px] text-[#C4B09A]" title="The sales import has never carried this item's name. That is not the same as never having sold.">no record</span>
                      )}
                    </td>
                    <td className="py-2.5 px-3 text-right tabular-nums text-[13px] text-[#3D2614]">
                      {r.revenue > 0 ? formatCurrency(r.revenue) : <span className="text-[#C4B09A]">—</span>}
                    </td>
                    <td className="py-2.5 px-3 text-right tabular-nums text-[13px] text-[#6B5744]">
                      {r.selling_price > 0 ? formatCurrency(r.selling_price) : <span className="text-amber-700 text-[11px]">no price</span>}
                    </td>
                    <td className="py-2.5 px-4">
                      <div className="flex items-center justify-end gap-1.5">
                        <button onClick={() => onAddRecipe(r)}
                                className="text-[11px] font-medium px-2 py-1 rounded-md bg-[#af4408] text-white hover:bg-[#8a3506] inline-flex items-center gap-1 whitespace-nowrap">
                          <Plus className="w-3 h-3" />Add recipe
                        </button>
                        <button onClick={() => onLinkExisting(r)}
                                title="Link a recipe that already exists, instead of writing a second one for the same dish."
                                className="text-[11px] font-medium px-2 py-1 rounded-md border border-[#D4B896] text-[#6B5744] hover:border-[#af4408] hover:text-[#af4408] inline-flex items-center gap-1 whitespace-nowrap">
                          <LinkIcon className="w-3 h-3" />Link
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile — the same rows, stacked. This is a tablet-first operation
              and a horizontally-scrolling six-column table is not workable on a
              phone held in one hand behind a counter. */}
          <div className="md:hidden divide-y divide-[#F5EDE4]">
            {shown.map((r, i) => (
              <div key={r.id} className="px-4 py-3">
                <div className="flex items-start gap-2">
                  <span className="text-[11px] text-[#B9A386] tabular-nums mt-0.5 w-5 shrink-0">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <button onClick={() => onEdit(r)} className="text-[13px] font-medium text-[#2D1B0E] text-left">{r.name}</button>
                    <p className="text-[10px] text-[#8B7355] mt-0.5">
                      {r.has_sales
                        ? <><b className="text-[#3D2614]">{r.portions.toLocaleString('en-IN')}</b> portions
                            {r.portions_free > 0 && <> ({r.portions_free.toLocaleString('en-IN')} free)</>}
                            {r.revenue > 0 && <> · {formatCurrency(r.revenue)} uncosted</>}</>
                        : 'No recorded sale'}
                      {r.selling_price > 0 ? <> · {formatCurrency(r.selling_price)}</> : <span className="text-amber-700"> · no price</span>}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 mt-2 pl-7">
                  <button onClick={() => onAddRecipe(r)}
                          className="text-[11px] font-medium px-2.5 py-1.5 rounded-md bg-[#af4408] text-white inline-flex items-center gap-1">
                    <Plus className="w-3 h-3" />Add recipe
                  </button>
                  <button onClick={() => onLinkExisting(r)}
                          className="text-[11px] font-medium px-2.5 py-1.5 rounded-md border border-[#D4B896] text-[#6B5744] inline-flex items-center gap-1">
                    <LinkIcon className="w-3 h-3" />Link existing
                  </button>
                </div>
              </div>
            ))}
          </div>

          {rows.length > shown.length && (
            <div className="px-4 sm:px-5 py-3 border-t border-[#F0E4D6] text-center">
              <button onClick={() => setLimit(n => n + 50)} className="text-[12px] text-[#af4408] font-medium hover:underline">
                Show 50 more — {rows.length - shown.length} left below this
              </button>
            </div>
          )}

          {/* THE OTHER VIEW OF THE SAME GAP, named rather than left to be
              stumbled on. /reports/menu-recipe-gap already exists and already
              lists these dishes; it does a different job — a date window, a
              name-matcher that proposes an existing recipe, and a tick-many-
              and-attach button — and it ranks by REVENUE, so its order will not
              match this one. What it cannot do is write a recipe for a dish
              that has none, which is the state 234 of these 253 dishes are in
              against a book of 69 recipes. Two lists that disagree about the
              order and never explain themselves is how both stop being read. */}
          <div className="px-4 sm:px-5 py-2.5 border-t border-[#F0E4D6] bg-[#FFFBF6]">
            <p className="text-[10px] text-[#8B7355] leading-relaxed">
              Looking for a date window, or to attach an existing recipe to many dishes at once?{' '}
              <a href="/reports/menu-recipe-gap" className="text-[#af4408] font-medium hover:underline">Menu Items Without Recipe</a>{' '}
              does that, over a chosen period and ranked by revenue rather than portions — so its order differs from this
              one on purpose.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

function ActiveToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <label className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-[#E0D0BE] bg-white text-sm text-[#6B5744] shadow-sm cursor-pointer">
      <Toggle checked={on} onChange={() => onToggle()} size="sm" label="Active only" />
      Active only
    </label>
  );
}

function CatChip({ active, label, count, onClick }: { active: boolean; label: string; count: number; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`text-xs px-3 py-1.5 rounded-full whitespace-nowrap transition-colors ${active ? 'bg-[#af4408] text-white' : 'bg-white border border-[#E8D5C4] text-[#6B5744] hover:bg-[#FFF1E3]'}`}>
      {label} <span className={active ? 'opacity-75' : 'text-[#8B7355]'}>· {count}</span>
    </button>
  );
}

function CategoryMenu({ categories, counts, current, search, setSearch, onPick, onClose }: {
  categories: string[]; counts: Record<string, number>; current: string; search: string;
  setSearch: (s: string) => void; onPick: (c: string) => void; onClose: () => void;
}) {
  const list = categories.filter(c => c.toLowerCase().includes(search.toLowerCase()));
  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div className="absolute right-0 top-full mt-2 z-40 w-64 max-w-[85vw] bg-white border border-[#E8D5C4] rounded-xl shadow-xl overflow-hidden">
        <div className="p-2 border-b border-[#F0E4D6]">
          <input autoFocus value={search} onChange={e => setSearch(e.target.value)} placeholder="Filter categories…"
                 className="w-full px-2.5 py-1.5 bg-[#FFF8F0] border border-[#E0D0BE] rounded-lg text-xs focus:outline-none focus:ring-1 focus:ring-[#af4408]" />
        </div>
        <div className="max-h-72 overflow-y-auto py-1 text-sm">
          <button onClick={() => onPick('')} className={`w-full text-left px-3 py-1.5 hover:bg-[#FFF1E3] ${!current ? 'text-[#af4408] font-semibold' : 'text-[#3D2614]'}`}>All categories</button>
          {list.map(c => (
            <button key={c} onClick={() => onPick(c)} className={`w-full flex items-center justify-between gap-2 px-3 py-1.5 hover:bg-[#FFF1E3] ${current === c ? 'text-[#af4408] font-semibold' : 'text-[#3D2614]'}`}>
              <span className="truncate">{c}</span><span className="text-[11px] text-[#8B7355] shrink-0">{counts[c] || 0}</span>
            </button>
          ))}
          {list.length === 0 && <p className="px-3 py-2 text-xs text-[#8B7355]">No matches</p>}
        </div>
      </div>
    </>
  );
}

function MobileCard({ it, onEdit, onDelete, onToggle, onAddRecipe, canWrite = true }: { it: MenuItem; onEdit: () => void; onDelete: () => void; onToggle: () => void; onAddRecipe?: (i: MenuItem) => void; canWrite?: boolean }) {
  return (
    <div className={`bg-white border border-[#E8D5C4] rounded-2xl p-3 shadow-sm ${!it.is_active ? 'opacity-60' : ''}`}>
      <div className="flex items-start gap-3">
        <Avatar name={it.name} type={it.item_type} />
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-semibold text-[#2D1B0E] text-sm leading-snug">{it.name}</p>
              <p className="text-[11px] text-[#8B7355] truncate">
                {it.category || '—'}{it.station ? ` · ${it.station}` : ''}{it.item_code ? ` · ${it.item_code}` : ''}
              </p>
            </div>
            <RowMenu onEdit={onEdit} onDelete={onDelete} />
          </div>
          <div className="flex items-center flex-wrap gap-2 mt-2">
            <TypeBadge type={it.item_type} />
            <VegSquare tag={it.dietary_tag} type={it.item_type} />
            <LinkBadge item={it} onAddRecipe={onAddRecipe} canWrite={canWrite} />
            <span className="ml-auto font-bold text-[#2D1B0E]">{it.selling_price > 0 ? formatCurrency(it.selling_price) : <span className="text-red-400">₹0</span>}</span>
          </div>
          <div className="flex items-center justify-between mt-2 pt-2 border-t border-[#F0E4D6] text-[11px] text-[#8B7355]">
            {/* Same rule as the desktop table, and it matters MORE here: there is
                no hover on a phone, so nothing a tooltip says can be read. The
                qualifier is therefore spelled out in words on the card itself —
                "estimate" and "cost is wrong" — never left to a "≈" alone. */}
            <span className={it.recipe_cost_unusable || it.recipe_empty ? 'text-red-600' : it.recipe_cost_warning || it.recipe_is_approximate ? 'text-amber-800' : undefined}>
              Cost <CostCell it={it} />
              {typeof it.recipe_food_cost_percent === 'number' ? ` · FC ${it.recipe_food_cost_percent}%` : ''}
              {it.recipe_empty
                ? <span className="block text-red-600">the linked recipe is empty — nothing in it, so nothing is costed</span>
                : it.recipe_cost_unusable
                  ? <span className="block text-red-600">this cost is wrong — the recipe uses a unit that cannot be converted</span>
                  : it.recipe_cost_warning
                    // Spelled out per KIND — on a phone there is no tooltip to
                    // carry the difference, and "small, but worth fixing" is the
                    // wrong thing to say about 700 g of sauce on one plate.
                    ? (it.recipe_cost_warning_kind === 'quantity'
                        ? <span className="block text-orange-700">one ingredient’s quantity is too large for one portion — check it before pricing off this</span>
                        : it.recipe_cost_warning_kind === 'no_quantity'
                          ? <span className="block text-orange-700">an ingredient has no quantity, so it adds nothing to this cost</span>
                          : <span className="block text-amber-800">one ingredient’s unit does not convert — small, but worth fixing</span>)
                    : it.recipe_is_approximate
                      ? <span className="block text-amber-800">estimate — simple recipe, main ingredients only</span>
                      : null}
            </span>
            <span className="flex items-center gap-1.5 shrink-0">{it.is_active ? 'Active' : 'Inactive'}<RowToggle on={!!it.is_active} onClick={onToggle} /></span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Pagination({ page, pageCount, onPage }: { page: number; pageCount: number; onPage: (n: number) => void }) {
  if (pageCount <= 1) return null;
  const set = new Set<number>([1, 2, 3, page - 1, page, page + 1, pageCount]);
  const nums = [...set].filter(n => n >= 1 && n <= pageCount).sort((a, b) => a - b);
  const items: (number | string)[] = [];
  nums.forEach((n, i) => { if (i > 0 && n - nums[i - 1] > 1) items.push(`gap${i}`); items.push(n); });
  return (
    <div className="flex items-center gap-1">
      <button disabled={page <= 1} onClick={() => onPage(page - 1)} className="h-9 w-9 flex items-center justify-center rounded-lg border border-[#E8D5C4] text-[#6B5744] disabled:opacity-40 hover:bg-[#FFF1E3]" aria-label="Previous page"><ChevronLeft className="w-4 h-4" /></button>
      {items.map((n) => typeof n === 'string'
        ? <span key={n} className="px-1 text-[#8B7355]">…</span>
        : <button key={n} onClick={() => onPage(n)} aria-current={n === page ? 'page' : undefined} className={`min-w-[36px] h-9 px-2 rounded-lg text-sm font-medium ${n === page ? 'bg-[#af4408] text-white' : 'border border-[#E8D5C4] text-[#6B5744] hover:bg-[#FFF1E3]'}`}>{n}</button>)}
      <button disabled={page >= pageCount} onClick={() => onPage(page + 1)} className="h-9 w-9 flex items-center justify-center rounded-lg border border-[#E8D5C4] text-[#6B5744] disabled:opacity-40 hover:bg-[#FFF1E3]" aria-label="Next page"><ChevronRight className="w-4 h-4" /></button>
    </div>
  );
}

// Options/variants <-> the admin textarea ("Label: a, b" per line).
function optionsToText(raw: any): string {
  let arr: any[] = [];
  if (Array.isArray(raw)) arr = raw;
  else { try { const j = JSON.parse(raw || '[]'); if (Array.isArray(j)) arr = j; } catch { /* ignore */ } }
  return arr.map((g: any) => `${g?.label || ''}: ${(g?.choices || []).join(', ')}`).join('\n');
}
function textToOptions(t: string): Array<{ label: string; choices: string[] }> {
  return t.split('\n').map(line => {
    const i = line.indexOf(':'); if (i < 0) return null;
    const label = line.slice(0, i).trim();
    const choices = line.slice(i + 1).split(',').map(c => c.trim()).filter(Boolean);
    return label && choices.length >= 2 ? { label, choices } : null;
  }).filter((x): x is { label: string; choices: string[] } => !!x);
}

/**
 * The dialog's copy of the server's name cleaning, kept character-for-character
 * in step with `sanitizeCategoryName` / `foldCategoryName` in
 * src/lib/menu-category.ts — the shared module the rename route, the category
 * master route and the CSV importer all import them from. (This is client code
 * and must not pull a server module in, which is why the copy exists at all.)
 * If the two ever drift the dialog starts promising something the endpoint
 * refuses (or worse, stops warning about a duplicate the endpoint will still
 * create) — the server is always the boundary, this only decides what the admin
 * is told before they press the button.
 *
 * Invisible characters are the whole reason this is not just `.trim()`: a
 * pasted zero-width space made "breads" and "breads<U+200B>" two different
 * categories that render identically, and neither the old client warning nor
 * the old server refusal noticed.
 */
const SPACEY_CAT = /[\p{Zs}\t\n\r\f\v]+/gu;
const FORMAT_OR_CONTROL_CAT = /[\p{Cf}\p{Cc}]/gu;
function sanitizeCategoryName(s: string): string {
  return String(s ?? '')
    .normalize('NFC')
    .replace(SPACEY_CAT, ' ')
    .replace(FORMAT_OR_CONTROL_CAT, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}
function foldCategoryName(s: string): string {
  return sanitizeCategoryName(s).normalize('NFKC').toLowerCase();
}

/**
 * THE CATEGORY MASTER SCREEN — add, rename, retire, reorder.
 *
 * It lives here as a dialog on Menu Items rather than as its own page, beside
 * the list it governs and behind the same admin gate. Every write goes to
 * /api/menu-items/categories except RENAME, which is handed back to the page so
 * it goes through /api/menu-items/rename-category — the one route allowed to
 * write `menu_items.category`, which moves the items and this master row in a
 * single transaction. There is deliberately no second rename path.
 *
 * WHAT DEACTIVATE MEANS, AND WHY IT IS NOT DELETE. Retiring a category stops it
 * being OFFERED. Every item already in it keeps the category, stays on the
 * guest QR menu, on the POS, and in every report — nothing is rewritten. That
 * is the honest behaviour: `menu_items.category` stores the string, so the only
 * alternatives would be orphaning those items or rewriting live menu data, and
 * rewriting is what Rename is for. The screen says so out loud, because "remove
 * from the list" reads like "delete" unless you are told otherwise.
 *
 * Reorder is ↑/↓ rather than drag-and-drop: it works with a keyboard, on a
 * phone, and inside a scrolling dialog, and it saves the WHOLE order after each
 * move so a half-applied sequence cannot survive a dropped connection.
 */
function ManageCategoriesModal({ categories, orphans, onClose, onAdd, onSetActive, onReorder, onRename }: {
  categories: MenuCategory[];
  orphans: { name: string; item_count: number }[];
  onClose: () => void;
  onAdd: (name: string) => Promise<string | null>;
  onSetActive: (c: MenuCategory, active: boolean) => Promise<string | null>;
  onReorder: (order: string[]) => Promise<string | null>;
  onRename: (name: string) => void;
}) {
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  // Server order, exactly as stored. Reorder saves the full list, so what is on
  // screen and what is in the table never drift.
  const ordered = useMemo(
    () => [...categories].sort((a, b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name)),
    [categories],
  );
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? ordered.filter(c => c.name.toLowerCase().includes(q)) : ordered;
  }, [ordered, filter]);

  const target = sanitizeCategoryName(newName);
  // Same fold as the server's refusal, so the button never promises an add the
  // endpoint will bounce. Inactive rows count — the answer there is Reactivate.
  const clash = target ? categories.find(c => foldCategoryName(c.name) === foldCategoryName(target)) : undefined;
  const canAdd = !!target && !clash && !busy;

  const add = async () => {
    if (!canAdd) return;
    setBusy(true); setError(null);
    const err = await onAdd(target);
    if (err) setError(err); else setNewName('');
    setBusy(false);
  };

  // Move one row and persist the WHOLE order. `ordered` is the full list even
  // when the search box is filtering, so moving a row while filtered still
  // produces a coherent order rather than shuffling the hidden ones.
  const move = async (id: string, dir: -1 | 1) => {
    const idx = ordered.findIndex(c => c.id === id);
    const to = idx + dir;
    if (idx < 0 || to < 0 || to >= ordered.length) return;
    const next = ordered.map(c => c.id);
    [next[idx], next[to]] = [next[to], next[idx]];
    setBusy(true); setError(null);
    const err = await onReorder(next);
    if (err) setError(err);
    setBusy(false);
  };

  const toggle = async (c: MenuCategory) => {
    setBusy(true); setError(null);
    const err = await onSetActive(c, !c.is_active);
    if (err) setError(err);
    setBusy(false);
  };

  const activeCount = categories.filter(c => c.is_active).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
           className="relative w-full max-w-2xl bg-white border border-[#E8D5C4] rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8D5C4] shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-[#af4408]/10"><ListOrdered className="w-5 h-5 text-[#af4408]" /></div>
            <div>
              <h2 className="text-lg font-semibold text-[#2D1B0E]">Menu Categories</h2>
              {/* ONE expression, not text-around-{}. As three children
                  ({n} offered · {n} retired — …) JSX dropped the space in front
                  of "retired" and the header read "1retired"; proven in the
                  rendered DOM, where the last text node arrived as
                  "retired — …". Building the whole sentence in a single
                  template literal leaves no JSX whitespace to lose. */}
              <p className="text-xs text-[#8B7355]">
                {`${activeCount} offered · ${categories.length - activeCount} retired — this is the list the item form offers, not where an item’s category is stored.`}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[#FFF1E3]"><X className="w-5 h-5" /></button>
        </div>

        <div className="px-6 pt-4 pb-2 shrink-0 space-y-2">
          <div className="flex gap-2">
            <input type="text" value={newName} autoFocus
                   onChange={e => { setNewName(e.target.value); setError(null); }}
                   onKeyDown={e => { if (e.key === 'Enter') add(); }}
                   placeholder="Add a category — e.g. small-plates-veg"
                   className="flex-1 min-w-0 px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm" />
            <button onClick={add} disabled={!canAdd}
                    className="flex items-center gap-1.5 px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium shrink-0">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}Add
            </button>
          </div>
          {clash && (
            <p className="text-[11px] text-red-600">
              “{clash.name}” is already in the list{clash.is_active ? '' : ' but retired — reactivate it instead of adding a second one'}. The check ignores capitalisation.
            </p>
          )}
          {categories.length > 8 && (
            <input type="text" value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter this list…"
                   className="w-full px-3 py-1.5 bg-white border border-[#E0D0BE] rounded-lg text-xs" />
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-4">
          <div className="divide-y divide-[#F0E4D6] border border-[#E8D5C4] rounded-xl overflow-hidden">
            {shown.map((c) => {
              const idx = ordered.findIndex(o => o.id === c.id);
              return (
                <div key={c.id} className={`flex items-center gap-2 px-3 py-2 ${c.is_active ? 'bg-white' : 'bg-[#FFFBF5]'}`}>
                  <div className="flex flex-col shrink-0">
                    <button onClick={() => move(c.id, -1)} disabled={busy || idx <= 0} aria-label={`Move ${c.name} up`}
                            className="p-0.5 text-[#8B7355] hover:text-[#af4408] disabled:opacity-25"><ChevronUp className="w-3.5 h-3.5" /></button>
                    <button onClick={() => move(c.id, 1)} disabled={busy || idx >= ordered.length - 1} aria-label={`Move ${c.name} down`}
                            className="p-0.5 text-[#8B7355] hover:text-[#af4408] disabled:opacity-25"><ChevronDown className="w-3.5 h-3.5" /></button>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className={`text-sm font-medium truncate ${c.is_active ? 'text-[#2D1B0E]' : 'text-[#8B7355] line-through decoration-[#D4B896]'}`}>{c.name}</p>
                    <p className="text-[11px] text-[#8B7355]">
                      {c.item_count} item{c.item_count === 1 ? '' : 's'}
                      {!c.is_active && ' · retired — they keep it, it is just not offered'}
                      {c.spellings.length > 0 && ` · items store it as: ${c.spellings.join(', ')}`}
                    </p>
                  </div>
                  <button onClick={() => onRename(c.name)} disabled={busy} title="Rename this category on every item in it"
                          className="p-1.5 rounded-lg text-[#af4408] hover:bg-[#af4408]/10 shrink-0 disabled:opacity-40"><Edit className="w-4 h-4" /></button>
                  <button onClick={() => toggle(c)} disabled={busy} title={c.is_active ? 'Stop offering this category' : 'Offer this category again'}
                          className={`p-1.5 rounded-lg shrink-0 disabled:opacity-40 ${c.is_active ? 'text-[#8B7355] hover:bg-[#FFF1E3]' : 'text-green-600 hover:bg-green-50'}`}>
                    {c.is_active ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              );
            })}
            {shown.length === 0 && (
              <p className="px-3 py-6 text-center text-xs text-[#8B7355]">
                {categories.length === 0 ? 'No categories yet — add the first one above.' : 'No categories match that filter.'}
              </p>
            )}
          </div>

          {orphans.length > 0 && (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3">
              <p className="text-[11px] font-semibold text-amber-800 uppercase tracking-wide">On items, but not in this list</p>
              <p className="text-[11px] text-amber-700 mt-1">
                These names are stored on menu items but are not categories anybody can pick. Rename one onto a name in the list above, or add it here.
              </p>
              <ul className="mt-2 text-[11px] text-amber-800 space-y-1">
                {orphans.map(o => (
                  <li key={o.name} className="flex items-center justify-between gap-2">
                    <span className="truncate">{o.name} <span className="text-amber-600">· {o.item_count} item{o.item_count === 1 ? '' : 's'}</span></span>
                    <button onClick={() => onRename(o.name)} className="shrink-0 text-[#af4408] hover:underline font-medium">Rename</button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-4 rounded-xl border border-[#E8D5C4] bg-[#FFFBF5] p-3 space-y-1.5">
            <p className="text-[11px] font-semibold text-[#8B5A2B] uppercase tracking-wide">What this list does</p>
            <ul className="text-[11px] text-[#6B5744] space-y-1 list-disc pl-4">
              <li>It decides what the <b>item form offers</b>. Items store the category as text, so nothing here rewrites a menu item.</li>
              <li><b>Retiring</b> a category leaves every item in it exactly as it is — on the guest menu, on the POS and in every report. It just stops being offered for new items, and an item already in it still shows its own value when you open it.</li>
              <li><b>Renaming</b> goes through the same tool as before: it moves every item onto the new name and moves this entry with them, in one step.</li>
              <li>The <b>order</b> here is the order of the dropdown. It is not the guest QR menu&apos;s section order, which is fixed in code.</li>
              <li>A <b>CSV import</b> that names a category this list does not have will add it here, so you can correct it afterwards.</li>
            </ul>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 mx-6 mb-3 px-3 py-2 bg-red-50 border border-red-200 rounded-lg shrink-0">
            <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
            <p className="text-xs text-red-700">{error}</p>
          </div>
        )}

        <div className="flex justify-end gap-3 px-6 py-3 border-t border-[#E8D5C4] shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm text-[#6B5744] bg-[#FFF1E3] rounded-lg hover:bg-[#E8D5C4]">Done</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Bulk-rename one menu category across every item in it.
 *
 * `counts` MUST be the unfiltered per-category totals (see globalCatCounts in
 * the page): the rename moves every row on the old string, active or inactive,
 * so quoting the view-scoped chip counts here would understate what happens.
 *
 * The dialog mirrors the server's refusal rather than pre-empting it: a target
 * name already in use — exactly or ignoring case — disables the button and says
 * why, and if the server refuses anyway (another admin created that name a
 * second ago, or the CSV import did) the message lands in the error banner with
 * the typing intact. It never offers to merge, because the endpoint will not.
 */
function RenameCategoryModal({ categories, counts, initial, onClose, onRename }: {
  categories: string[];
  counts: Record<string, number>;
  initial: string;
  onClose: () => void;
  onRename: (from: string, to: string) => Promise<string | null>;
}) {
  const [from, setFrom] = useState(() => (initial && categories.includes(initial) ? initial : categories[0] || ''));
  const [to, setTo] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const target = sanitizeCategoryName(to);
  const count = counts[from] || 0;
  // Source excluded on purpose: re-casing the SAME category ("Beer" → "BEER")
  // is a rename, not a collision with itself. The server applies the same rule.
  // Same fold as the server's refusal (see foldCategoryName above), so the
  // dialog and the endpoint never disagree about what counts as an existing
  // name — including names that differ only by invisible characters.
  const clash = target
    ? categories.find(c => c !== from && foldCategoryName(c) === foldCategoryName(target))
    : undefined;
  const unchanged = !!target && target === from;
  const canRename = !!from && !!target && !clash && !unchanged && !saving;

  const submit = async () => {
    if (!canRename) return;
    setSaving(true);
    setError(null);
    const err = await onRename(from, target);
    // On success the parent closes this dialog, so only the failure path has to
    // put the form back in a usable state.
    if (err) { setError(err); setSaving(false); }
  };

  return (
    /* z-[60], not z-50: this dialog is opened FROM the category master screen and
       has to sit above it. Still below the toast (z-96) so a server refusal is
       never hidden behind the dialog that caused it. */
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
           className="relative w-full max-w-lg bg-white border border-[#E8D5C4] rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8D5C4] shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-[#af4408]/10"><Edit className="w-5 h-5 text-[#af4408]" /></div>
            <div>
              <h2 className="text-lg font-semibold text-[#2D1B0E]">Rename Category</h2>
              <p className="text-xs text-[#8B7355]">Renames it on every item at once. Names already in use are refused, never merged.</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[#FFF1E3]"><X className="w-5 h-5" /></button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-[#6B5744] mb-1">Category to rename</label>
            <select value={from} onChange={e => { setFrom(e.target.value); setError(null); }}
                    className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm">
              {categories.map(c => <option key={c} value={c}>{c} · {counts[c] || 0} item{(counts[c] || 0) === 1 ? '' : 's'}</option>)}
            </select>
            <p className="text-[10px] text-[#8B7355] mt-0.5">
              {count} item{count === 1 ? '' : 's'} carry this category, active and inactive — all of them move.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-[#6B5744] mb-1">New name</label>
            <input type="text" value={to} autoFocus
                   onChange={e => { setTo(e.target.value); setError(null); }}
                   onKeyDown={e => { if (e.key === 'Enter') submit(); }}
                   placeholder="e.g. small-plates-veg"
                   className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm" />
            {clash && (
              <p className="text-[11px] text-red-600 mt-1">
                “{clash}” already exists ({counts[clash] || 0} item{(counts[clash] || 0) === 1 ? '' : 's'}). Renaming into it would merge the two categories, which this tool will not do — pick a name that is not in use. The check ignores capitalisation.
              </p>
            )}
            {unchanged && !clash && (
              <p className="text-[11px] text-[#8B7355] mt-1">That is already the name of this category.</p>
            )}
          </div>

          <div className="rounded-xl border border-[#E8D5C4] bg-[#FFFBF5] p-3 space-y-1.5">
            <p className="text-[11px] font-semibold text-[#8B5A2B] uppercase tracking-wide">What this changes</p>
            <ul className="text-[11px] text-[#6B5744] space-y-1 list-disc pl-4">
              <li>The <b>menu only</b>. Raw-material and liquor-store categories are a different list and are not touched, even where the name is identical.</li>
              <li>The entry in <b>Menu Categories</b> moves with the items in the same step, so the new name is the one the item form offers and the old one stops being offered. Whether it was retired stays as it was.</li>
              <li>Reports that read the live menu will show the new name for <b>past sales too</b> — that is what a rename means. Sales rows imported from the POS keep their own label, so the Sales page filter may still list the old one.</li>
              <li>The guest QR menu heading changes — and because the guest menu&apos;s section order is a fixed list in the code, a renamed section <b>drops to the end</b> of its part of that menu. Only a developer can put it back in place, so avoid renaming a section you are happy with the position of.</li>
              <li>Re-importing an <b>older menu CSV</b> puts the old name straight back on every item still listed in it (the import matches on Item ID and overwrites the category). Export a fresh CSV before your next import.</li>
              <li>KOT routing, the kitchen display and stock deduction are keyed on <b>station</b>, not category — they are unaffected.</li>
            </ul>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 mx-6 mt-3 px-3 py-2 bg-red-50 border border-red-200 rounded-lg shrink-0">
            <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
            <p className="text-xs text-red-700">{error}</p>
          </div>
        )}

        <div className="flex justify-end gap-3 px-6 py-3 border-t border-[#E8D5C4] shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm text-[#6B5744] bg-[#FFF1E3] rounded-lg hover:bg-[#E8D5C4]">Cancel</button>
          <button onClick={submit} disabled={!canRename}
                  className="flex items-center gap-2 px-5 py-2 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
            {/* A category can legitimately have NO items — one just added, or one
                whose items were moved away. "Rename 0 items" reads like a bug; it
                is a rename of the category-list entry alone, and says so. */}
            {saving ? 'Renaming…' : (count > 0 ? `Rename ${count} item${count === 1 ? '' : 's'}` : 'Rename category')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * IS THIS DISH COSTED? — asked and answered inside the item editor.
 *
 * The list has said this on every row for a while. The EDITOR never did, and
 * the editor is the one screen where somebody is looking at a single dish and
 * making decisions about it: you could open a ₹549 dish here, reprice it, and
 * walk away with no idea it records ₹0 food cost every time it sells.
 *
 * "Linked" alone is not enough and that is the point of the middle state. A
 * simple recipe produces a real cost through the real engine, but its
 * quantities are rough — so a dish linked to one must never read the same as a
 * dish linked to a measured recipe, or the estimate quietly becomes the number
 * somebody prices off. Four states, in the order they matter:
 *   · the linked recipe's units do not convert → the cost is WRONG, not rough;
 *   · linked to a simple recipe → costed, approximately, and it says so;
 *   · linked to a full recipe → costed;
 *   · not linked → sells at ₹0 food cost, with the two ways out right here.
 */
function ItemRecipeState({ item, isNew, canWriteRecipes, saving, onAddRecipe, onLinkExisting }: {
  item: MenuItem;
  isNew: boolean;
  canWriteRecipes: boolean;
  saving: boolean;
  onAddRecipe: () => void;
  onLinkExisting: () => void;
}) {
  const wants = normalizeType(item.item_type) === 'foods' || normalizeType(item.item_type) === 'beverages';

  // A brand-new item has no id yet, so there is nothing to link a recipe TO.
  // Saying so is better than offering buttons that cannot work, and it states
  // the owner's own rule: the item comes first, the recipe follows from it.
  if (isNew) {
    return (
      <div className="rounded-xl border border-[#E8D5C4] bg-[#FFFBF6] px-3.5 py-2.5">
        <p className="text-[11px] text-[#6B5744] leading-relaxed">
          <b className="text-[#3D2614]">Recipe:</b> this item does not exist yet. Save it first — it goes on the menu
          either way — and you will be offered a recipe for it straight afterwards.
        </p>
      </div>
    );
  }

  if (!wants) {
    return (
      <div className="rounded-xl border border-[#E8D5C4] bg-[#FFFBF6] px-3.5 py-2.5">
        <p className="text-[11px] text-[#8B7355] leading-relaxed">
          <b className="text-[#6B5744]">Recipe:</b> not needed — liquor is poured from a bottle and is costed in the store.
        </p>
      </div>
    );
  }

  if (item.recipe_id) {
    /**
     * THE SAME THREE WORDS THIS ROW USES EVERYWHERE ELSE.
     *
     * This panel graded on `recipe_cost_warning` — ANY unit note — while the list
     * row, the cost cell, the FC% cell and the mobile card all grade on
     * `recipe_cost_unusable`. So Thai Green Curry, whose suspect line is ₹1.67 of
     * ₹152.24, read "Recipe · check units — the total is still broadly right" in
     * the table and then, on the same dish, "Linked — but the cost is wrong … the
     * cost and FC% on this dish mean nothing" in this form. One of those two
     * sentences was going to be believed and it was a coin toss which.
     *
     * Now: red is `recipe_cost_unusable` (the figure is noise), amber is a note
     * that keeps its number, and the amber sentence is word-for-word the
     * tooltip the badge in the table already shows.
     */
    const unusable = !!item.recipe_cost_unusable;
    const note = !unusable && !!item.recipe_cost_warning;
    const empty = !!item.recipe_empty;
    const approx = !!item.recipe_is_approximate;
    const tone = unusable || empty
      ? 'border-red-300 bg-red-50'
      : note || approx ? 'border-amber-300 bg-amber-50' : 'border-emerald-200 bg-emerald-50';
    return (
      <div className={`rounded-xl border px-3.5 py-2.5 ${tone}`}>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <p className="text-[12px] font-semibold inline-flex items-center gap-1.5 flex-wrap">
              {empty ? (
                <><AlertTriangle className="w-3.5 h-3.5 text-red-700" /><span className="text-red-800">Linked — but the recipe is empty</span></>
              ) : unusable ? (
                <><AlertTriangle className="w-3.5 h-3.5 text-red-700" /><span className="text-red-800">Linked — but the cost is wrong</span></>
              ) : note ? (
                <><AlertTriangle className="w-3.5 h-3.5 text-amber-700" /><span className="text-amber-900">Linked — {warningLabel(item.recipe_cost_warning_kind) === 'check units' ? 'check the units' : warningLabel(item.recipe_cost_warning_kind)}</span></>
              ) : approx ? (
                <><AlertTriangle className="w-3.5 h-3.5 text-amber-700" /><span className="text-amber-900">Linked — approximate recipe</span></>
              ) : (
                <><CheckCircle className="w-3.5 h-3.5 text-emerald-700" /><span className="text-emerald-800">Linked — full recipe</span></>
              )}
              {item.recipe_name && <span className="font-normal text-[#6B5744]">· {item.recipe_name}</span>}
            </p>
            <p className={`text-[11px] mt-1 leading-relaxed ${unusable || empty ? 'text-red-800' : note || approx ? 'text-amber-900' : 'text-[#6B5744]'}`}>
              {empty
                ? <>{item.recipe_cost_warning} {item.recipe_cost_warning_fix}</>
                : unusable
                  ? <>{item.recipe_cost_warning} {item.recipe_cost_warning_fix} Until that is fixed, the cost and FC% on this dish mean nothing.</>
                  : note
                    ? <>{item.recipe_cost_warning} {item.recipe_cost_warning_fix}{' '}
                        {item.recipe_cost_warning_kind === 'unit'
                          // Only the UNIT note may vouch for the total. See warningClosing.
                          ? <>This is a small part of the cost, so the <b>{formatCurrency(Number(item.recipe_cost) || 0)}</b> total
                              is still broadly right — but open the recipe and correct it.</>
                          : <>The <b>{formatCurrency(Number(item.recipe_cost) || 0)}</b> total depends on
                              it. {warningClosing(item.recipe_cost_warning_kind)}</>}</>
                    : approx
                      ? <>Its quantities cover only the main ingredients, so the <b>{formatCurrency(Number(item.recipe_cost) || 0)}</b> cost
                          {typeof item.recipe_food_cost_percent === 'number' ? <> ({item.recipe_food_cost_percent}%)</> : null} is a real
                          figure but an estimate. Do not price off it as though it were measured — finish the recipe to clear the mark.</>
                      : <>Costs <b>{formatCurrency(Number(item.recipe_cost) || 0)}</b>
                          {typeof item.recipe_food_cost_percent === 'number' ? <> — {item.recipe_food_cost_percent}% of this item&rsquo;s price</> : null}.</>}
            </p>
          </div>
          <a href={`/recipes?search=${encodeURIComponent(item.recipe_name || item.name)}`}
             className="text-[11px] font-medium px-2.5 py-1 rounded-md border border-[#D4B896] bg-white text-[#6B5744] hover:border-[#af4408] hover:text-[#af4408] whitespace-nowrap shrink-0">
            Open recipe
          </a>
        </div>
        {canWriteRecipes && (
          <button onClick={onLinkExisting} disabled={saving}
                  className="mt-2 text-[11px] text-[#8B7355] hover:text-[#af4408] hover:underline disabled:opacity-50">
            Link a different recipe instead
          </button>
        )}
      </div>
    );
  }

  // NOT LINKED.
  return (
    <div className="rounded-xl border border-[#D4B896] bg-[#FFF1E3] px-3.5 py-2.5">
      <p className="text-[12px] font-semibold text-[#3D2614] inline-flex items-center gap-1.5">
        <AlertCircle className="w-3.5 h-3.5 text-[#af4408]" /> Not linked — no recipe
      </p>
      <p className="text-[11px] text-[#6B5744] mt-1 leading-relaxed">
        This dish sells and prints normally, and records <b>₹0 food cost</b> every time it does.
        {item.material_id && (
          <> It is mapped to the material <b>{item.material_name || ''}</b>, which nothing in the sale path reads — that
            mapping costs nothing and deducts nothing.</>
        )}
      </p>
      {canWriteRecipes ? (
        <>
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <button onClick={onAddRecipe} disabled={saving}
                    className="text-[11px] font-medium px-2.5 py-1.5 rounded-md bg-[#af4408] text-white hover:bg-[#8a3506] disabled:opacity-50 inline-flex items-center gap-1">
              <Plus className="w-3 h-3" />Add a simple recipe
            </button>
            <button onClick={onLinkExisting} disabled={saving}
                    className="text-[11px] font-medium px-2.5 py-1.5 rounded-md border border-[#D4B896] bg-white text-[#6B5744] hover:border-[#af4408] hover:text-[#af4408] disabled:opacity-50 inline-flex items-center gap-1">
              <LinkIcon className="w-3 h-3" />Link an existing recipe
            </button>
          </div>
          {/* Said plainly, because pressing either button leaves this form. */}
          <p className="text-[10px] text-[#8B7355] mt-1.5">
            Either one saves this item first, so nothing typed above is lost.
          </p>
        </>
      ) : (
        <p className="text-[10px] text-[#8B7355] mt-1.5">A manager or admin can add a recipe for it.</p>
      )}
    </div>
  );
}

function EditItemModal({ item, onClose, onSave, menuCategories, stationMaster, stationSentinels, stationsLoaded, isAdmin, isNew, canWriteRecipes }: { item: MenuItem; onClose: () => void; onSave: (updates: Partial<MenuItem>, then?: 'quick' | 'link') => Promise<string | null>; menuCategories: MenuCategory[]; stationMaster: StationMasterRow[]; stationSentinels: string[]; stationsLoaded: boolean; isAdmin: boolean; isNew: boolean; canWriteRecipes: boolean }) {
  // Normalize legacy dirty types ('beverages.') so the Type select never
  // renders blank — and a save writes the clean value back.
  const [form, setForm] = useState({ ...item, item_type: normalizeType(item.item_type) || item.item_type });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [optsText, setOptsText] = useState(() => optionsToText((item as any).options));
  const F = form as any;
  const tagArr: string[] = Array.isArray(F.tags) ? F.tags : (F.tags ? (() => { try { const j = JSON.parse(F.tags); return Array.isArray(j) ? j : String(F.tags).split(','); } catch { return String(F.tags).split(','); } })() : []);
  const toggleTag = (tg: string) => setForm({ ...form, tags: (tagArr.indexOf(tg) >= 0 ? tagArr.filter(x => x !== tg) : tagArr.concat(tg)) } as any);
  const TAGS: [string, string][] = [['most-ordered', 'Most Ordered'], ['chef', "Chef's"], ['bestseller', 'Bestseller'], ['popular', 'Popular']];

  // What the Category dropdown offers.
  const activeCategories = useMemo(
    () => menuCategories.filter(c => c.is_active),
    [menuCategories],
  );
  /**
   * The item's OWN category, when it is not among the active options.
   *
   * Returned so it can be added to the dropdown as an extra, clearly-marked
   * choice. Comparison is on the EXACT stored string, deliberately: if the
   * master says "Pizzas" and this row stores "PIZZAS", they are two different
   * values as far as every report and the guest menu are concerned, and quietly
   * selecting the master's spelling on the next save would rewrite live menu
   * data nobody asked to change.
   */
  const heldCategory = useMemo(() => {
    const value = form.category || '';
    if (!value) return null;
    if (activeCategories.some(c => c.name === value)) return null;
    const retired = menuCategories.find(c => c.name === value && !c.is_active);
    return {
      value,
      why: retired ? 'no longer offered (deactivated)' : 'not in the category list',
    };
  }, [form.category, activeCategories, menuCategories]);

  /**
   * The category the item HAD when this modal opened, kept selectable for as
   * long as it is open.
   *
   * `heldCategory` follows the CURRENT selection, which is right for the
   * marking but meant the held value vanished from the list the moment anything
   * else was picked: an item on a retired "shooters" showed 48 options, and one
   * stray pick dropped it to 47 with no way back except Cancel — which throws
   * away every other edit too. The old free-text box could simply be typed back
   * into. So the original is offered as well, always. Captured in state at
   * mount rather than derived, so the master reloading underneath (Manage
   * Categories can be open at the same time) cannot move it — and, unlike a
   * ref, it is a render-safe read.
   *
   * Strictly ADDITIVE: `heldCategory` above is untouched, so the guarantee that
   * the item's current value is always an option — the one that must not go
   * wrong — is exactly as it was.
   */
  const [openedWith] = useState<string>(item.category || '');
  const restorableOriginal = useMemo(() => {
    if (!openedWith || openedWith === (form.category || '')) return null;  // already selected & marked
    if (activeCategories.some(c => c.name === openedWith)) return null;    // already in the list
    return openedWith;
  }, [openedWith, form.category, activeCategories]);

  /* ── STATION: the same three pieces, and the one place they must differ ──
   *
   * What the Station dropdown OFFERS: every master row except the SENTINEL.
   *
   * 'kitchen' is not a station. It is kot-fire.ts's blank-station sentinel — a
   * fired line carrying no station of its own is written out as the literal
   * string 'kitchen' — and it is ALSO a real master row and a real department
   * (the main-kitchen roll-up). Offering it would let someone pick, out of a
   * dropdown, the one value the whole skip rule exists to keep OFF menu items:
   * every station-less line in the building already lands there, so an item
   * deliberately put on it becomes indistinguishable from a mistake. The list
   * comes from the server's own `reserved.sentinel` rather than a fourth
   * hard-coded copy of the string.
   *
   * PAUSED ROWS STAY OFFERED, marked. is_active on this master means "stop
   * deducting stock", not "stop cooking here" — the Settings screen promises
   * the owner that pausing does NOT change routing. Hiding them would make that
   * promise false. Nor is `effective`/unmapped filtered on: 'liquor' (293 live
   * items) is deliberately unmapped because it lives on the store rail, and a
   * picker that dropped it would strand more than a third of the menu.
   */
  const offeredStations = useMemo(() => {
    const sentinel = new Set(stationSentinels.map(normStationKey));
    return stationMaster.filter(s => !sentinel.has(normStationKey(s.station)));
  }, [stationMaster, stationSentinels]);

  /**
   * The item's OWN station, when no offered option carries that EXACT string.
   *
   * ── WHY EXACT, WHEN EVERY READER MATCHES ON THE KEY ──────────────────────
   * A <select> selects by exact option value. If the stored string were not an
   * option verbatim, the select would render with nothing selected and the
   * first careless click — or a browser that snaps to the first option — would
   * rewrite the STATION of an item somebody opened only to fix its PRICE. That
   * is not a mis-filed dish; that is a ticket that stops reaching the section
   * which has to cook it. So the stored bytes are always an option, and a save
   * returns the row exactly what it already had.
   *
   * The KEY still does real work — in the LABEL. Because production joins on
   * lower(trim()), an item storing 'Tandoor' routes identically to master row
   * 'tandoor', and calling that "not on the station list" would be a lie that
   * invites someone to "fix" a value that is not broken. So membership is
   * judged with normStationKey (the house normalisation, imported from
   * station-master.ts) and the option says "same station, different spelling".
   * The canonical row is offered directly below it, so canonicalising stays a
   * DELIBERATE pick and never a side effect of saving a price.
   *
   * This is the one place the mirror of the Category control diverges, and it
   * diverges because category is a label and station is a join key. Measured on
   * the live snapshot when this was written: 0 of 628 items store a station
   * that differs from lower(trim()) of itself, and 0 store a station with no
   * master row — so on today's data every branch below is unreachable and the
   * control is a pure no-op. They exist for the data that arrives tomorrow
   * through the two writers this master cannot reach (the CSV importer and the
   * offline replay path, both documented in station-master.ts).
   */
  const heldStation = useMemo(() => {
    const value = form.station || '';
    if (!value) return null;
    // THE LIST NEVER ARRIVED. offeredStations is empty, so every membership test
    // below would come back false and label a perfectly good station "not on the
    // station list" — a claim we have no evidence for, contradicted one line
    // down by the notice that says the list failed to load. Say only what is
    // true: we could not check. The option still carries the stored value, so
    // the select renders it selected and a save returns it unchanged.
    if (!stationsLoaded) return { value, why: 'station list unavailable — not checked' };
    if (offeredStations.some(s => s.station === value)) return null;   // exact option exists
    const key = normStationKey(value);
    if (stationSentinels.map(normStationKey).includes(key)) {
      return { value, why: 'the blank-station placeholder, not a real station' };
    }
    if (offeredStations.some(s => normStationKey(s.station) === key)) {
      return { value, why: 'same station, different spelling — kept exactly as stored' };
    }
    return { value, why: 'not on the station list' };
  }, [form.station, offeredStations, stationSentinels, stationsLoaded]);

  /** The station the item HAD when this modal opened — same undo as category. */
  const [stationOpenedWith] = useState<string>(item.station || '');
  const restorableStation = useMemo(() => {
    if (!stationOpenedWith || stationOpenedWith === (form.station || '')) return null;
    if (offeredStations.some(s => s.station === stationOpenedWith)) return null;
    return stationOpenedWith;
  }, [stationOpenedWith, form.station, offeredStations]);

  // onSave (parent saveEdit) handles both create and update, checks res.ok,
  // and returns an error message on failure — modal stays open with the
  // user's edits intact and the error shown.
  //
  // `then` is how the recipe block below reaches the recipe screens WITHOUT
  // costing anyone their edits. The naive version — close the editor, open the
  // quick-recipe modal — silently discards whatever was typed into this form,
  // and the field most likely to have been typed is the PRICE, which is the
  // very denominator the recipe about to be written is costed against. So those
  // buttons save first and travel on only if the save succeeded. On a failure
  // the modal stays open with the edits and the server's reason, exactly as
  // pressing Save would.
  const save = async (then?: 'quick' | 'link') => {
    setSaving(true);
    setError(null);
    const err = await onSave(form, then);
    if (err) setError(err);
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      {/* House safe-modal shell: card capped to viewport, body scrolls
          internally, so header + Save/Cancel stay on screen on phones. */}
      <div style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
           className="relative w-full max-w-2xl bg-white border border-[#E8D5C4] rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8D5C4] shrink-0">
          <h2 className="text-lg font-semibold text-[#2D1B0E]">{isNew ? 'New Menu Item' : 'Edit Menu Item'}</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[#FFF1E3]"><X className="w-5 h-5" /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-4">
          {/* LINKED / NOT LINKED, inside the editor.
              The list already says it on every row; this says it in the one
              place somebody is looking at a single dish and deciding things
              about it. Without it the editor was the only screen in this flow
              that could not answer "is this dish costed?" — you could reprice a
              ₹549 dish here with no idea it records ₹0 food cost. */}
          <ItemRecipeState
            item={item}
            isNew={isNew}
            canWriteRecipes={canWriteRecipes}
            saving={saving}
            onAddRecipe={() => save('quick')}
            onLinkExisting={() => save('link')}
          />
          <div>
            <label className="block text-xs font-medium text-[#6B5744] mb-1">Name *</label>
            <input type="text" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#6B5744] mb-1">Category</label>
              <select value={form.category || ''} onChange={e => setForm({ ...form, category: e.target.value })}
                      className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm">
                <option value="">— No category —</option>
                {/* THE ONE THAT MUST NOT GO WRONG. An item can sit on a category
                    that is now DEACTIVATED, or on a string with no master row at
                    all (a legacy value, or one a CSV brought in). If its own
                    value were not an option, the select would render with
                    nothing selected and the first careless click — or a browser
                    that snaps to the first option — would rewrite the category
                    of an item somebody opened only to fix its PRICE. So the
                    stored string is ALWAYS offered, matched EXACTLY (never
                    folded: "PIZZAS" and "Pizzas" are different stored strings
                    and saving must return the one the row already has), and
                    labelled with why it is not in the list. */}
                {heldCategory && (
                  <option value={heldCategory.value}>
                    {heldCategory.value} — {heldCategory.why}
                  </option>
                )}
                {/* And the value it had when this modal opened, so a stray pick
                    is undoable without Cancelling the whole edit. */}
                {restorableOriginal && (
                  <option value={restorableOriginal}>
                    {restorableOriginal} — put it back (its original category)
                  </option>
                )}
                {activeCategories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
              </select>
              {heldCategory && (
                <p className="text-[10px] text-amber-700 mt-0.5">
                  This item keeps “{heldCategory.value}” — {heldCategory.why}. Leave it alone and it stays exactly as it is; pick another only if you mean to move the item.
                </p>
              )}
              {!heldCategory && activeCategories.length === 0 && (
                <p className="text-[10px] text-[#8B7355] mt-0.5">No categories are active yet — an admin can add one under <b>Manage categories</b>.</p>
              )}
            </div>
            <div>
              <div className="flex items-baseline justify-between gap-2 mb-1">
                <label className="block text-xs font-medium text-[#6B5744]">Station</label>
                {/* A LINK, not a second modal. station_departments is the only
                    station master there is (a second one is how a station ends
                    up pickable in one screen and unroutable in the other), and
                    its screen is adminOnly in page-catalog.ts because every
                    write behind it is admin — so a non-admin is not offered a
                    door they cannot open. Contrast "Manage categories", which
                    can be a modal here because that master has a read path. */}
                {isAdmin && (
                  <a href="/settings/station-departments" target="_blank" rel="noopener noreferrer"
                     title="Add, rename or map the stations this list offers"
                     className="text-[11px] font-medium text-[#af4408] hover:underline">Manage stations ↗</a>
                )}
              </div>
              {/* THE ONE THAT MUST NOT GO WRONG, and it goes wrong louder than
                  category does. This string IS the routing: the KOT it joins,
                  the printer it prints on, the board it appears on, the
                  department it debits. It used to be a free-text box over a
                  datalist built from DISTINCT menu_items.station — a list that
                  offered back whatever had already been typed, so one typo
                  became a permanent option in its own suggestions. It is now
                  locked to the master, with the item's own value always
                  offered and marked. */}
              <select value={form.station || ''} disabled={!stationsLoaded}
                      onChange={e => setForm({ ...form, station: e.target.value })}
                      className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm disabled:opacity-60 disabled:cursor-not-allowed">
                <option value="">— No station —</option>
                {heldStation && (
                  <option value={heldStation.value}>
                    {heldStation.value} — {heldStation.why}
                  </option>
                )}
                {restorableStation && (
                  <option value={restorableStation}>
                    {restorableStation} — put it back (its original station)
                  </option>
                )}
                {offeredStations.map(s => (
                  <option key={s.station} value={s.station}>
                    {s.station}{s.is_active ? '' : ' — paused (stock deduction off)'}
                  </option>
                ))}
              </select>
              {!stationsLoaded ? (
                <p className="text-[10px] text-amber-700 mt-0.5">
                  Station list didn’t load, so this is locked — the item keeps “{form.station || 'no station'}”. Reload the page to change it.
                </p>
              ) : heldStation ? (
                <p className="text-[10px] text-amber-700 mt-0.5">
                  This item keeps “{heldStation.value}” — {heldStation.why}. Leave it alone and it routes exactly as it does today; pick another only if you mean to move the item to a different section.
                </p>
              ) : !form.station ? (
                <p className="text-[10px] text-amber-700 mt-0.5">
                  No station: this item’s KOT is filed under the “kitchen” placeholder and no department’s stock is deducted for it.
                </p>
              ) : offeredStations.length === 0 ? (
                <p className="text-[10px] text-[#8B7355] mt-0.5">No stations on the list yet — an admin can add one under <b>Manage stations</b>.</p>
              ) : null}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#6B5744] mb-1">Type</label>
              <select value={form.item_type}
                      onChange={e => { const t = e.target.value; const half = t === 'liquors' ? 0 : 2.5; setForm({ ...form, item_type: t, cgst_percent: half, sgst_percent: half, tax_value: half * 2 }); }}
                      className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm">
                <option value="foods">Foods</option>
                <option value="liquors">Liquor</option>
                <option value="beverages">Beverages</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[#6B5744] mb-1">Veg/Non-Veg</label>
              <select value={form.dietary_tag} onChange={e => setForm({ ...form, dietary_tag: e.target.value })} className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm">
                <option value="">—</option>
                <option value="Veg">Veg</option>
                <option value="Non-Veg">Non-Veg</option>
                <option value="Egg">Egg</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[#6B5744] mb-1">Item Code</label>
              <input type="text" value={form.item_code} onChange={e => setForm({ ...form, item_code: e.target.value })} className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#6B5744] mb-1">Selling Price (₹)</label>
              <input type="number" step="0.01" value={form.selling_price} onChange={e => setForm({ ...form, selling_price: Number(e.target.value) })} className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#6B5744] mb-1">Listing Price (₹)</label>
              <input type="number" step="0.01" value={form.listing_price} onChange={e => setForm({ ...form, listing_price: Number(e.target.value) })} className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#6B5744] mb-1">GST % (CGST + SGST)</label>
              <div className="flex gap-2">
                <input type="number" step="0.01" min="0" placeholder="CGST" aria-label="CGST %"
                       value={form.cgst_percent}
                       onChange={e => setForm({ ...form, cgst_percent: Number(e.target.value) })}
                       className="w-full px-2 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm" />
                <input type="number" step="0.01" min="0" placeholder="SGST" aria-label="SGST %"
                       value={form.sgst_percent}
                       onChange={e => setForm({ ...form, sgst_percent: Number(e.target.value) })}
                       className="w-full px-2 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm" />
              </div>
              <p className="text-[10px] text-[#8B7355] mt-0.5">
                Total GST {Math.round(((Number(form.cgst_percent) || 0) + (Number(form.sgst_percent) || 0)) * 100) / 100}% · added to the bill per item · Liquor 0%. Auto-set by Type.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#6B5744] mb-1">Prep time (minutes)</label>
              <input type="number" step="1" min="0" value={form.prep_minutes ?? 0} onChange={e => setForm({ ...form, prep_minutes: Number(e.target.value) })} className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm" />
            </div>
          </div>
          {/* Customer QR-menu presentation */}
          <div className="rounded-xl border border-[#E8D5C4] bg-[#FFFBF5] p-4 space-y-3">
            <p className="text-[11px] font-semibold text-[#8B5A2B] uppercase tracking-wide">Customer Menu (QR)</p>
            {/* Dish photo — two ways in, ONE field out. The uploader squares +
                shrinks the picked file in the browser and writes the URL it gets
                back into form.image_url; the input below writes the same field
                by hand for an externally-hosted image. Neither changes how the
                item is saved. */}
            <div>
              <label className="block text-xs font-medium text-[#6B5744] mb-1">Dish photo</label>
              <MenuImageUpload
                value={F.image_url || ''}
                itemId={item.id || ''}
                onChange={url => setForm(f => ({ ...f, image_url: url } as any))}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#6B5744] mb-1">…or paste an image URL</label>
              <input type="url" value={F.image_url || ''} onChange={e => setForm({ ...form, image_url: e.target.value } as any)} placeholder="https://…/paneer-tikka.jpg" className="w-full px-3 py-2 bg-white border border-[#D4B896] rounded-lg text-sm" />
              <p className="text-[10px] text-[#8B7355] mt-0.5">Uploading fills this in for you. Paste here only for an image already hosted somewhere else. Square works best — it’s cropped to fit the card thumbnails and the item photo.</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-[#6B5744] mb-1">Spice level</label>
                <select value={F.spice_level ?? 0} onChange={e => setForm({ ...form, spice_level: Number(e.target.value) } as any)} className="w-full px-3 py-2 bg-white border border-[#D4B896] rounded-lg text-sm">
                  <option value={0}>None</option><option value={1}>🌶️ Mild</option><option value={2}>🌶️🌶️ Medium</option><option value={3}>🌶️🌶️🌶️ Hot</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-[#6B5744] mb-1">Serves</label>
                <input type="text" value={F.serves || ''} onChange={e => setForm({ ...form, serves: e.target.value } as any)} placeholder="e.g. 1-2" className="w-full px-3 py-2 bg-white border border-[#D4B896] rounded-lg text-sm" />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-[#6B5744] mb-1">Tags</label>
              <div className="flex gap-2 flex-wrap">
                {TAGS.map(([id, label]) => {
                  const on = tagArr.indexOf(id) >= 0;
                  return <button type="button" key={id} onClick={() => toggleTag(id)} className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${on ? 'bg-[#af4408] text-white border-[#af4408]' : 'bg-white text-[#6B5744] border-[#D4B896] hover:bg-[#FFF1E3]'}`}>{label}</button>;
                })}
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-[#6B5744] mb-1">Taste profile <span className="text-[#8B7355] font-normal">(0–4 each — powers the radar chart)</span></label>
              <div className="grid grid-cols-4 gap-2">
                {(['sour', 'sweet', 'spicy', 'tangy'] as const).map(t => (
                  <div key={t}>
                    <span className="block text-[10px] uppercase tracking-wide text-[#8B7355] mb-1">{t}</span>
                    <input type="number" min={0} max={4} step={1} value={F['taste_' + t] ?? 0} onChange={e => setForm({ ...form, ['taste_' + t]: Math.max(0, Math.min(4, Number(e.target.value) || 0)) } as any)} className="w-full px-2 py-2 bg-white border border-[#D4B896] rounded-lg text-sm text-center" />
                  </div>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-[#6B5744] mb-1">Options / Variants <span className="text-[#8B7355] font-normal">(optional)</span></label>
              <textarea value={optsText} onChange={e => { setOptsText(e.target.value); setForm({ ...form, options: textToOptions(e.target.value) } as any); }} rows={2} placeholder="Temperature: Normal, Chilled" className="w-full px-3 py-2 bg-white border border-[#D4B896] rounded-lg text-sm font-mono" />
              <p className="text-[10px] text-[#8B7355] mt-0.5">One per line as <b>Label: choice1, choice2</b>. The guest picks one when ordering (e.g. a water bottle → <b>Temperature: Normal, Chilled</b>), and the choice prints on the KOT.</p>
            </div>
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={!!form.is_active} onChange={e => setForm({ ...form, is_active: e.target.checked ? 1 : 0 })} className="accent-[#af4408] w-4 h-4" />
            <span className="text-sm text-[#6B5744]">Active (shown on menu)</span>
          </label>
        </div>
        {error && (
          <div className="flex items-start gap-2 mx-6 mt-3 px-3 py-2 bg-red-50 border border-red-200 rounded-lg shrink-0">
            <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
            <p className="text-xs text-red-700">{error}</p>
          </div>
        )}
        <div className="flex justify-end gap-3 px-6 py-3 border-t border-[#E8D5C4] shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm text-[#6B5744] bg-[#FFF1E3] rounded-lg hover:bg-[#E8D5C4]">Cancel</button>
          {/* `() => save()` and not `save` — a bare handler hands React's
              MouseEvent straight into the `then` parameter, and a plain Save
              would be indistinguishable from one asking to go on to a recipe
              screen. */}
          <button onClick={() => save()} disabled={saving || !form.name} className="flex items-center gap-2 px-5 py-2 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 text-white rounded-lg text-sm font-medium">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
