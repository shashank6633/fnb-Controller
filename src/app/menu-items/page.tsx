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
  material_name?: string;
  material_cost?: number;
}

interface Summary {
  total: number; active: number; inactive: number;
  foods: number; liquors: number; beverages: number;
  withRecipe: number; withMaterial: number;
  noPrice: number; noCategory: number; noStation: number; noDietaryTag: number;
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

export default function MenuItemsPage() {
  const [items, setItems] = useState<MenuItem[]>([]);
  const [summary, setSummary] = useState<Summary>({ total: 0, active: 0, inactive: 0, foods: 0, liquors: 0, beverages: 0, withRecipe: 0, withMaterial: 0, noPrice: 0, noCategory: 0, noStation: 0, noDietaryTag: 0 });
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

  // Bulk category rename (admin only). The server gate on
  // /api/menu-items/rename-category is the real boundary — this only decides
  // whether to offer a button that a non-admin's click would always 403.
  const [renameOpen, setRenameOpen] = useState(false);
  const [me, setMe] = useState<{ role?: string } | null>(null);
  const isAdmin = me?.role === 'admin';

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
    } catch (_) {
      showToast('Failed to load menu items — check your connection', true);
    }
  }, [showToast]);

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

      // Issue filter
      if (issueFilter) {
        switch (issueFilter) {
          case 'noPrice': if (it.selling_price > 0) return false; break;
          case 'noCategory': if (it.category) return false; break;
          case 'noStation': if (it.station) return false; break;
          case 'noDietaryTag': if (normalizeType(it.item_type) !== 'foods' || it.dietary_tag) return false; break;
          case 'noRecipe': if (it.recipe_id || it.material_id) return false; break;
          case 'any': {
            const bad = !(it.selling_price > 0)
              || (normalizeType(it.item_type) === 'foods' && !it.dietary_tag)
              || (!it.recipe_id && !it.material_id);
            if (!bad) return false;
            break;
          }
        }
      }
      return true;
    });
  }, [items, searchQuery, categoryFilter, stationFilter, typeFilter, vegFilter, statusFilter, issueFilter]);

  // Attention counts — distinct items + per-issue (drives the banner)
  const attn = useMemo(() => {
    let noPrice = 0, noVeg = 0, noLink = 0; const bad = new Set<string>();
    for (const it of items) {
      let issue = false;
      if (!(it.selling_price > 0)) { noPrice++; issue = true; }
      if (normalizeType(it.item_type) === 'foods' && !it.dietary_tag) { noVeg++; issue = true; }
      if (!it.recipe_id && !it.material_id) { noLink++; issue = true; }
      if (issue) bad.add(it.id);
    }
    return { noPrice, noVeg, noLink, total: bad.size };
  }, [items]);

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
  useEffect(() => { setPage(1); }, [searchQuery, categoryFilter, stationFilter, typeFilter, vegFilter, statusFilter, issueFilter]);
  const pageCount = Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageItems = filteredItems.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // "/" focuses the search box (but never while a modal is open)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editItem || importOpen || renameOpen || manageCatsOpen) return;
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      if (e.key === '/' && tag !== 'input' && tag !== 'textarea' && tag !== 'select') {
        e.preventDefault(); searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editItem, importOpen, renameOpen, manageCatsOpen]);

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

      // Detect format: Akan POS export, AKAN Recipe Template, or generic
      let sheetName = wb.SheetNames.find(n => /existing.*product|products/i.test(n))
        || wb.SheetNames.find(n => /^menu.?items?$/i.test(n))
        || wb.SheetNames[0];
      const sheet = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json<any>(sheet, { header: 1, defval: null });

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
  const saveEdit = async (updates: Partial<MenuItem>): Promise<string | null> => {
    if (!editItem) return null;
    const isNew = !editItem.id;
    try {
      const res = await api('/api/menu-items', {
        method: isNew ? 'POST' : 'PUT',
        body: isNew ? updates : { id: editItem.id, ...updates },
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as any));
        return j.error || `Save failed (HTTP ${res.status})`;
      }
    } catch {
      return 'Save failed — check your connection';
    }
    setEditItem(null);
    await fetchItems();
    showToast(isNew ? 'Item created' : 'Saved');
    return null;
  };

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

        {/* Stat bar */}
        <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm overflow-hidden grid grid-cols-3 sm:grid-cols-6">
          <Stat label="Total" value={summary.total} className="text-[#2D1B0E]" />
          <Stat label="Active" value={summary.active} className="text-green-600" />
          <Stat label="Foods" value={summary.foods} className="text-orange-500" />
          <Stat label="Liquor" value={summary.liquors} className="text-purple-600" />
          <Stat label="Beverages" value={summary.beverages} className="text-[#B9A48C]" />
          <Stat label="With Recipe" value={summary.withRecipe} className="text-blue-600" />
        </div>

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
              {attn.noLink > 0 && <AttnPill tone="blue" count={attn.noLink} label="no recipe link" active={issueFilter === 'noRecipe'} onClick={() => reviewIssue('noRecipe')} />}
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
            <div className="hidden md:block bg-white border border-[#E8D5C4] rounded-2xl shadow-sm overflow-hidden">
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
                      <th className="text-left py-3 px-3 font-semibold">Link</th>
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
                          {it.recipe_cost ? formatCurrency(it.recipe_cost) : it.material_cost ? formatCurrency(it.material_cost) : <span className="text-[#C4B09A]">—</span>}
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          {it.recipe_food_cost_percent
                            ? <span className={`font-medium ${fcColor(it.recipe_food_cost_percent)}`}>{it.recipe_food_cost_percent}</span>
                            : <span className="text-[#C4B09A]">—</span>}
                        </td>
                        <td className="py-2.5 px-3"><LinkBadge item={it} /></td>
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
            <div className="md:hidden space-y-2.5">
              {pageItems.map((it) => (
                <MobileCard key={it.id} it={it} onEdit={() => setEditItem(it)} onDelete={() => deleteItem(it.id)} onToggle={() => toggleActive(it)} />
              ))}
            </div>

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
                       stationMaster={stationMaster} stationSentinels={stationSentinels} stationsLoaded={stationsLoaded} isAdmin={isAdmin} isNew={!editItem.id} />
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

function LinkBadge({ item }: { item: MenuItem }) {
  if (item.recipe_id) return <span className="text-[11px] font-medium px-2 py-0.5 rounded-md bg-blue-50 text-blue-700 border border-blue-200">Recipe</span>;
  if (item.material_id) return <span className="text-[11px] font-medium px-2 py-0.5 rounded-md bg-purple-50 text-purple-700 border border-purple-200">Direct</span>;
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

function MobileCard({ it, onEdit, onDelete, onToggle }: { it: MenuItem; onEdit: () => void; onDelete: () => void; onToggle: () => void }) {
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
            <LinkBadge item={it} />
            <span className="ml-auto font-bold text-[#2D1B0E]">{it.selling_price > 0 ? formatCurrency(it.selling_price) : <span className="text-red-400">₹0</span>}</span>
          </div>
          <div className="flex items-center justify-between mt-2 pt-2 border-t border-[#F0E4D6] text-[11px] text-[#8B7355]">
            <span>Cost {it.recipe_cost ? formatCurrency(it.recipe_cost) : it.material_cost ? formatCurrency(it.material_cost) : '—'}{it.recipe_food_cost_percent ? ` · FC ${it.recipe_food_cost_percent}%` : ''}</span>
            <span className="flex items-center gap-1.5">{it.is_active ? 'Active' : 'Inactive'}<RowToggle on={!!it.is_active} onClick={onToggle} /></span>
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

function EditItemModal({ item, onClose, onSave, menuCategories, stationMaster, stationSentinels, stationsLoaded, isAdmin, isNew }: { item: MenuItem; onClose: () => void; onSave: (updates: any) => Promise<string | null>; menuCategories: MenuCategory[]; stationMaster: StationMasterRow[]; stationSentinels: string[]; stationsLoaded: boolean; isAdmin: boolean; isNew: boolean }) {
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
  const save = async () => {
    setSaving(true);
    setError(null);
    const err = await onSave(form);
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
          <button onClick={save} disabled={saving || !form.name} className="flex items-center gap-2 px-5 py-2 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 text-white rounded-lg text-sm font-medium">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
