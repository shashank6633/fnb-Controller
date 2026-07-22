'use client';

import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  ChefHat,
  Plus,
  Search,
  Eye,
  Edit,
  Trash2,
  Calculator,
  Layers,
  X,
  Loader2,
  ArrowLeft,
  Download,
  Upload,
  FileSpreadsheet,
  CheckCircle,
  AlertCircle,
  AlertTriangle,
  Link2,
  Link2Off,
  CheckCircle2,
  RefreshCw,
  Copy,
  Tags,
  Pencil,
  LayoutGrid,
  List as ListIcon,
  ShieldAlert,
  ChevronDown,
  MoreVertical,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import Papa from 'papaparse';
import { allergenLabel, allergenEmoji } from '@/lib/allergens';
import { api } from '@/lib/api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Ingredient {
  id?: string;
  material_id: string;
  material_name?: string;
  quantity: number;
  unit: string;
  yield_percent: number;
  wastage_percent: number;
  is_default: number;
  brand_preference: string;
  average_price?: number;
  effective_cost?: number;
}

interface SubRecipeRef {
  id?: string;
  sub_recipe_id: string;
  sub_recipe_name?: string;
  quantity: number;
  unit: string;
  cost_per_unit?: number;
}

interface Recipe {
  id: string;
  name: string;
  category: string;
  selling_price: number;
  total_cost: number;
  food_cost_percent: number;
  version: number;
  is_active: number;
  ingredients: Ingredient[];
  sub_recipes: SubRecipeRef[];
  instructions?: string;   // Cookbook: cooking method
  image_url?: string;      // Cookbook: recipe photo
  yield_quantity?: number;
  yield_unit?: string;
  allergens?: string[];    // Cookbook: auto-detected allergen keys
  created_at: string;
  updated_at: string;
}

interface SubRecipe {
  id: string;
  name: string;
  category: string;
  yield_quantity: number;
  yield_unit: string;
  total_cost: number;
  cost_per_unit: number;
  version: number;
  is_active: number;
  ingredients: Ingredient[];
  created_at: string;
  updated_at: string;
}

interface RawMaterial {
  id: string;
  name: string;
  unit: string;
  average_price: number;
  category: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatCurrency(value: number): string {
  return '\u20B9' + value.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function foodCostColor(pct: number): string {
  // Spec: GPM < 65% (food cost > 35%) → red. Healthy ≤ 20% (GPM ≥ 80%) → green.
  if (pct <= 20) return 'text-green-600';
  if (pct <= 35) return 'text-amber-600';
  return 'text-red-600';
}

function foodCostBg(pct: number): string {
  if (pct <= 20) return 'bg-green-500/15 text-green-600';
  if (pct <= 35) return 'bg-amber-500/15 text-amber-700';
  return 'bg-red-500/15 text-red-600';
}

// Parse "(750ML)" → 750  ·  "1 LTR" → 1000
function parseMaterialVolumeMl(name?: string | null): number | null {
  if (!name) return null;
  const s = String(name).toUpperCase();
  const mMl = s.match(/(\d+(?:\.\d+)?)\s*ML\b/);
  if (mMl) return parseFloat(mMl[1]);
  const mLtr = s.match(/(\d+(?:\.\d+)?)\s*(?:LTR|LITRE|LITER|L)\b/);
  if (mLtr) return parseFloat(mLtr[1]) * 1000;
  return null;
}

// Convert a recipe ingredient qty into the material's stock unit (so cost = qty × price holds).
// packSize (recipe-units per purchase-unit) takes precedence over the name regex, matching the
// server engine's convertToMaterialUnit — keeps the live preview === the saved cost.
function convertQtyToMaterialUnit(qty: number, recipeUnit: string | null | undefined,
                                   materialUnit: string, materialName?: string, packSize?: number | null): number {
  const r = (recipeUnit || materialUnit || '').toLowerCase().trim();
  const m = (materialUnit || '').toLowerCase().trim();
  if (!r || r === m) return qty;
  const pack = packSize && packSize > 1 ? packSize : parseMaterialVolumeMl(materialName);
  if (r === 'pcs' && (m === 'ml' || m === 'l')) {
    if (pack) return m === 'l' ? (qty * pack) / 1000 : qty * pack;
  }
  if ((r === 'ml' || r === 'l') && m === 'pcs') {
    if (pack) return (r === 'l' ? qty * 1000 : qty) / pack;
  }
  if (r === 'l'  && m === 'ml') return qty * 1000;
  if (r === 'ml' && m === 'l')  return qty / 1000;
  if (r === 'kg' && m === 'g')  return qty * 1000;
  if (r === 'g'  && m === 'kg') return qty / 1000;
  return qty;
}

function computeIngredientCost(ing: {
  quantity: number; yield_percent: number; wastage_percent: number;
  average_price?: number; price?: number;
  unit?: string | null;
  material_unit?: string | null;
  material_name?: string | null;
  pack_size?: number | null;
}): number {
  const price = ing.average_price ?? (ing as any).price ?? 0;
  const effectiveYield = (ing.yield_percent || 100) / 100;
  const wastage = (ing.wastage_percent || 0) / 100;
  const matUnit = ing.material_unit || ing.unit || '';
  const qtyInMatUnit = convertQtyToMaterialUnit(ing.quantity, ing.unit, matUnit, ing.material_name || undefined, ing.pack_size);
  return (qtyInMatUnit * price * (1 + wastage)) / effectiveYield;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function RecipesPage() {
  // --- data state ---
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [subRecipes, setSubRecipes] = useState<SubRecipe[]>([]);
  const [materials, setMaterials] = useState<RawMaterial[]>([]);
  const [loading, setLoading] = useState(true);

  // --- UI state ---
  const [activeTab, setActiveTab] = useState<'main' | 'sub' | 'direct'>('main');
  const [recipeView, setRecipeView] = useState<'list' | 'gallery'>('list');  // Cookbook: card gallery
  const [recipePage, setRecipePage] = useState(1);       // list pagination
  const [showAllIssues, setShowAllIssues] = useState(false);  // health banner "+N more"
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  type SortKey = 'category' | 'name' | 'fcAsc' | 'fcDesc' | 'costDesc' | 'priceDesc';
  const [sortBy, setSortBy] = useState<SortKey>('category');
  const [selectedRecipe, setSelectedRecipe] = useState<Recipe | null>(null);
  const [scale, setScale] = useState(1);          // Cookbook: portion-scale factor
  const [scaleInput, setScaleInput] = useState('1');  // raw input string (allows typing "1.5")
  const setScaleTo = (n: number) => { setScale(n); setScaleInput(String(n)); };
  const [selectedSubRecipe, setSelectedSubRecipe] = useState<SubRecipe | null>(null);

  // --- modal state ---
  const [showRecipeModal, setShowRecipeModal] = useState(false);
  // Copy / Duplicate Recipe modal — for spawning Veg ↔ Non Veg variants in one click.
  const [copyFor, setCopyFor]               = useState<Recipe | null>(null);
  const [copyNewName, setCopyNewName]       = useState('');
  const [copyOriginalName, setCopyOriginalName] = useState('');
  const [copyDoRename, setCopyDoRename]     = useState(false);
  const [copyPrice, setCopyPrice]           = useState<number>(0);
  const [copySaving, setCopySaving]         = useState(false);
  const [copyError, setCopyError]           = useState<string | null>(null);
  const [showSubRecipeModal, setShowSubRecipeModal] = useState(false);
  const [editingRecipe, setEditingRecipe] = useState<Recipe | null>(null);
  const [editingSubRecipe, setEditingSubRecipe] = useState<SubRecipe | null>(null);
  const [saving, setSaving] = useState(false);

  // --- recipe form ---
  const [formName, setFormName] = useState('');
  const [formCategory, setFormCategory] = useState('');
  const [formSellingPrice, setFormSellingPrice] = useState<number>(0);
  const [formMenuItemId, setFormMenuItemId] = useState<string>('');   // link to menu_items.id
  const [formPosItemId, setFormPosItemId] = useState<string>('');     // POS item code (display only)
  const [formIngredients, setFormIngredients] = useState<Ingredient[]>([]);
  const [formSubRecipes, setFormSubRecipes] = useState<SubRecipeRef[]>([]);
  const [formInstructions, setFormInstructions] = useState('');   // Cookbook: cooking method
  const [formImageUrl, setFormImageUrl] = useState('');           // Cookbook: recipe photo URL

  // --- menu items (for recipe-name combobox) ---
  const [menuItems, setMenuItems] = useState<Array<{
    id: string; name: string; category: string; selling_price: number;
    item_code?: string; recipe_id?: string; item_type?: string;
  }>>([]);

  // --- bulk upload ---
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [bulkFileName, setBulkFileName] = useState<string | null>(null);
  const [bulkRows, setBulkRows] = useState<any[]>([]);
  const [bulkUploading, setBulkUploading] = useState(false);
  const [bulkOverwrite, setBulkOverwrite] = useState(false);
  const [bulkDragOver, setBulkDragOver] = useState(false);
  const [bulkResult, setBulkResult] = useState<any>(null);
  const bulkFileRef = useRef<HTMLInputElement>(null);

  // --- restore full book: Step 1 sub-recipes CSV (feeds /api/recipes/sub-bulk) ---
  const [subBulkFileName, setSubBulkFileName] = useState<string | null>(null);
  const [subBulkRows, setSubBulkRows] = useState<any[]>([]);
  const [subBulkUploading, setSubBulkUploading] = useState(false);
  const [subBulkOverwrite, setSubBulkOverwrite] = useState(true);
  const [subBulkDragOver, setSubBulkDragOver] = useState(false);
  const [subBulkResult, setSubBulkResult] = useState<any>(null);
  const subBulkFileRef = useRef<HTMLInputElement>(null);

  // --- Recipe health check filter ---
  const [issueFilter, setIssueFilter] = useState<string | null>(null);

  // --- Bar Costing import ---
  const [barModalOpen, setBarModalOpen] = useState(false);
  const [barFileName, setBarFileName] = useState<string | null>(null);
  const [barPreview, setBarPreview] = useState<any>(null);
  const [barPayload, setBarPayload] = useState<any>(null);
  const [barImporting, setBarImporting] = useState(false);
  const [barOverwrite, setBarOverwrite] = useState(true);
  const [barResult, setBarResult] = useState<any>(null);
  const barFileRef = useRef<HTMLInputElement>(null);

  // --- Food-Costing workbook import (Purchase Rates / Sub-Recipe Cards / Recipe Cost Cards) ---
  const [wbModalOpen, setWbModalOpen] = useState(false);
  const [wbFile, setWbFile] = useState<File | null>(null);
  const [wbFileName, setWbFileName] = useState<string | null>(null);
  const [wbPreview, setWbPreview] = useState<any>(null);
  const [wbPreviewing, setWbPreviewing] = useState(false);
  const [wbImporting, setWbImporting] = useState(false);
  const [wbOverwrite, setWbOverwrite] = useState(true);
  const [wbResult, setWbResult] = useState<any>(null);
  const wbFileRef = useRef<HTMLInputElement>(null);

  // --- Target food-cost % (fraction, e.g. 0.30). Drives "Menu Price @ Target". ---
  const [targetFcPct, setTargetFcPct] = useState<number>(0.30);

  // --- sub-recipe form ---
  const [srFormName, setSrFormName] = useState('');
  const [srFormCategory, setSrFormCategory] = useState('');
  const [srFormYieldQty, setSrFormYieldQty] = useState<number>(1);
  const [srFormYieldUnit, setSrFormYieldUnit] = useState('kg');
  const [srFormIngredients, setSrFormIngredients] = useState<Ingredient[]>([]);

  // -------------------------------------------------------------------------
  // Data fetching
  // -------------------------------------------------------------------------

  const fetchRecipes = useCallback(async () => {
    try {
      const res = await fetch('/api/recipes');
      const data = await res.json();
      setRecipes(data.recipes || []);
    } catch (e) {
      console.error('Failed to fetch recipes', e);
    }
  }, []);

  const fetchSubRecipes = useCallback(async () => {
    try {
      const res = await fetch('/api/sub-recipes');
      const data = await res.json();
      setSubRecipes(data.sub_recipes || []);
    } catch (e) {
      console.error('Failed to fetch sub-recipes', e);
    }
  }, []);

  const fetchMaterials = useCallback(async () => {
    try {
      const res = await fetch('/api/inventory');
      const data = await res.json();
      setMaterials(data.materials || []);
    } catch (e) {
      console.error('Failed to fetch materials', e);
    }
  }, []);

  const fetchMenuItems = useCallback(async () => {
    try {
      const res = await fetch('/api/menu-items');
      const data = await res.json();
      setMenuItems(data.items || []);
    } catch (e) {
      console.error('Failed to fetch menu items', e);
    }
  }, []);

  useEffect(() => {
    Promise.all([fetchRecipes(), fetchSubRecipes(), fetchMaterials(), fetchMenuItems()])
      .finally(() => setLoading(false));
  }, [fetchRecipes, fetchSubRecipes, fetchMaterials, fetchMenuItems]);

  // Load the persisted Target Food-Cost % (fraction) once.
  useEffect(() => {
    fetch('/api/settings?key=target_food_cost_pct')
      .then((r) => r.json())
      .then((d) => { const v = Number(d?.value); if (v > 0) setTargetFcPct(v); })
      .catch(() => {});
  }, []);

  // -------------------------------------------------------------------------
  // Computed / filtered
  // -------------------------------------------------------------------------

  const UNCAT = '__uncat__';
  const filteredRecipes = useMemo(() => {
    const filtered = recipes.filter((r) => {
      const matchSearch = !searchQuery || r.name.toLowerCase().includes(searchQuery.toLowerCase());
      const matchCategory = !categoryFilter
        || (categoryFilter === UNCAT ? !r.category || r.category.trim() === '' : r.category === categoryFilter);

      // Apply health issue filter if set
      let matchIssue = true;
      if (issueFilter) {
        const hasIngredients = (r.ingredients && r.ingredients.length > 0) || (r.sub_recipes && r.sub_recipes.length > 0);
        switch (issueFilter) {
          case 'noIngredients': matchIssue = !hasIngredients; break;
          case 'noPrice': matchIssue = !r.selling_price || r.selling_price === 0; break;
          case 'lossMaking': matchIssue = r.selling_price > 0 && r.total_cost > r.selling_price; break;
          case 'highFC':       matchIssue = r.food_cost_percent > 35 && r.selling_price > 0; break;  // GPM < 65%
          case 'borderlineFC': matchIssue = r.food_cost_percent > 20 && r.food_cost_percent <= 35 && r.selling_price > 0; break;  // GPM 65-80% — watch
          case 'suspicious': matchIssue = r.selling_price > 0 && r.food_cost_percent > 0 && r.food_cost_percent < 5; break;
          case 'noCategory': matchIssue = !r.category || r.category.trim() === '' || r.category === 'other'; break;
          case 'zeroCost': matchIssue = hasIngredients && (!r.total_cost || r.total_cost === 0); break;
          case 'noMenuLink': matchIssue = !menuItems.some(mi => mi.recipe_id === r.id); break;
          case 'priceless_ingredients': matchIssue = !!r.ingredients?.some((i: any) => !i.average_price || i.average_price === 0); break;
          case 'anyIssue': matchIssue = (
            !hasIngredients ||
            !r.selling_price || r.selling_price === 0 ||
            (r.selling_price > 0 && r.total_cost > r.selling_price) ||
            (r.food_cost_percent > 20 && r.selling_price > 0) ||
            (r.selling_price > 0 && r.food_cost_percent > 0 && r.food_cost_percent < 5) ||
            !r.category || r.category.trim() === '' || r.category === 'other' ||
            (hasIngredients && (!r.total_cost || r.total_cost === 0)) ||
            !menuItems.some(mi => mi.recipe_id === r.id) ||
            !!r.ingredients?.some((i: any) => !i.average_price || i.average_price === 0)
          ); break;
        }
      }

      return matchSearch && matchCategory && matchIssue;
    });

    const catOf = (r: any) => (r.category && r.category.trim()) || 'zzz_Uncategorised';
    const sorted = [...filtered];
    switch (sortBy) {
      case 'category':  sorted.sort((a, b) => catOf(a).localeCompare(catOf(b)) || a.name.localeCompare(b.name)); break;
      case 'name':      sorted.sort((a, b) => a.name.localeCompare(b.name)); break;
      case 'fcAsc':     sorted.sort((a, b) => (a.food_cost_percent || 0) - (b.food_cost_percent || 0)); break;
      case 'fcDesc':    sorted.sort((a, b) => (b.food_cost_percent || 0) - (a.food_cost_percent || 0)); break;
      case 'costDesc':  sorted.sort((a, b) => (b.total_cost || 0) - (a.total_cost || 0)); break;
      case 'priceDesc': sorted.sort((a, b) => (b.selling_price || 0) - (a.selling_price || 0)); break;
    }
    return sorted;
  }, [recipes, searchQuery, categoryFilter, issueFilter, sortBy]);

  // List pagination (25/page). Gallery view shows everything (photo grid).
  const R_PAGE_SIZE = 25;
  // Reset to page 1 when the filter/sort signature changes — done during render
  // (guarded by a ref) so the correct page paints in the SAME frame, with no
  // stale-page flash and no post-paint effect.
  const _recipeSig = `${searchQuery}|${categoryFilter}|${issueFilter}|${sortBy}|${activeTab}`;
  const _recipeSigRef = useRef(_recipeSig);
  if (_recipeSigRef.current !== _recipeSig) {
    _recipeSigRef.current = _recipeSig;
    if (recipePage !== 1) setRecipePage(1);
  }
  const recipePageCount = Math.max(1, Math.ceil(filteredRecipes.length / R_PAGE_SIZE));
  const recipeSafePage = Math.min(recipePage, recipePageCount);
  const pagedRecipes = recipeView === 'gallery'
    ? filteredRecipes
    : filteredRecipes.slice((recipeSafePage - 1) * R_PAGE_SIZE, recipeSafePage * R_PAGE_SIZE);

  const filteredSubRecipes = useMemo(() => {
    return subRecipes.filter((sr) => {
      return !searchQuery || sr.name.toLowerCase().includes(searchQuery.toLowerCase());
    });
  }, [subRecipes, searchQuery]);

  const recipeCategories = useMemo(() => {
    const cats = new Set(recipes.map((r) => r.category).filter(Boolean));
    return Array.from(cats).sort();
  }, [recipes]);

  const subRecipeCategories = useMemo(() => {
    const cats = new Set(subRecipes.map((s) => s.category).filter(Boolean));
    return Array.from(cats).sort();
  }, [subRecipes]);

  // Build a map: recipe_id → { count, names[] } so each card knows whether it's
  // linked to a menu item (and which one). A linked recipe shows a green ✓ badge;
  // an unlinked recipe shows an amber "no menu link" hint.
  const menuLinkMap = useMemo(() => {
    const m = new Map<string, { count: number; names: string[] }>();
    for (const mi of menuItems) {
      if (!mi.recipe_id) continue;
      const slot = m.get(mi.recipe_id) || { count: 0, names: [] };
      slot.count += 1;
      slot.names.push(mi.name);
      m.set(mi.recipe_id, slot);
    }
    return m;
  }, [menuItems]);

  // Summary stats
  const summaryStats = useMemo(() => {
    if (!recipes.length) return {
      total: 0, avgFoodCost: 0, mostProfitable: '-', mostProfitableGpm: 0, highestCost: '-', highestCostFc: 0,
      issues: { total: 0, noPrice: [], noIngredients: [], noCategory: [], highFC: [], borderlineFC: [], suspicious: [], lossMaking: [], zeroCost: [], noMenuLink: [], pricelessIngredients: [] }
    };
    const total = recipes.length;
    const avgFoodCost = recipes.reduce((s, r) => s + (r.food_cost_percent || 0), 0) / total;
    const sorted = [...recipes].sort((a, b) => {
      const pa = (a.selling_price || 0) - (a.total_cost || 0);
      const pb = (b.selling_price || 0) - (b.total_cost || 0);
      return pb - pa;
    });
    const mostProfitable = sorted[0]?.name || '-';
    const mp = sorted[0];
    const mostProfitableGpm = mp && mp.selling_price > 0 ? ((mp.selling_price - mp.total_cost) / mp.selling_price) * 100 : 0;
    const highestCostRecipe = [...recipes].sort((a, b) => (b.food_cost_percent || 0) - (a.food_cost_percent || 0));
    const highestCost = highestCostRecipe[0]?.name || '-';
    const highestCostFc = highestCostRecipe[0]?.food_cost_percent || 0;

    // Health check — recipes needing attention
    const noPrice = recipes.filter(r => !r.selling_price || r.selling_price === 0);
    const noIngredients = recipes.filter(r => (!r.ingredients || r.ingredients.length === 0) && (!r.sub_recipes || r.sub_recipes.length === 0));
    const noCategory = recipes.filter(r => !r.category || r.category.trim() === '' || r.category === 'other');
    // Spec: highlight margins below 65% GPM in red ⇒ food cost > 35% triggers red
    const highFC = recipes.filter(r => r.food_cost_percent > 35 && r.selling_price > 0);
    const borderlineFC = recipes.filter(r => r.food_cost_percent > 20 && r.food_cost_percent <= 35 && r.selling_price > 0);
    const lossMaking = recipes.filter(r => r.selling_price > 0 && r.total_cost > r.selling_price);
    const suspicious = recipes.filter(r => r.selling_price > 0 && r.food_cost_percent > 0 && r.food_cost_percent < 5); // Unusually cheap
    // Cost = 0 BUT ingredients exist → ingredient prices likely missing or never recalculated
    const zeroCost = recipes.filter(r => {
      const has = (r.ingredients?.length || 0) + (r.sub_recipes?.length || 0) > 0;
      return has && (!r.total_cost || r.total_cost === 0);
    });
    // Recipe not linked to any menu item → won't surface in POS sales
    const linkedRecipeIds = new Set(menuItems.filter(mi => mi.recipe_id).map(mi => mi.recipe_id));
    const noMenuLink = recipes.filter(r => !linkedRecipeIds.has(r.id));
    // Recipe ingredient with average_price = 0 → cost will be wrong
    const pricelessIngredients = recipes.filter(r =>
      (r.ingredients || []).some((i: any) => !i.average_price || i.average_price === 0)
    );

    // Dedupe recipes that appear in multiple issue categories
    const issueSet = new Set<string>();
    [...noPrice, ...noIngredients, ...noCategory, ...highFC, ...borderlineFC, ...lossMaking, ...suspicious,
     ...zeroCost, ...noMenuLink, ...pricelessIngredients].forEach(r => issueSet.add(r.id));

    return {
      total, avgFoodCost, mostProfitable, mostProfitableGpm, highestCost, highestCostFc,
      issues: {
        total: issueSet.size,
        noPrice, noIngredients, noCategory, highFC, borderlineFC, lossMaking, suspicious,
        zeroCost, noMenuLink, pricelessIngredients,
      }
    };
  }, [recipes, menuItems]);

  // Live cost calculator for recipe form
  const liveRecipeCost = useMemo(() => {
    let ingCost = 0;
    for (const ing of formIngredients) {
      const mat = materials.find((m) => m.id === ing.material_id);
      if (mat) {
        ingCost += computeIngredientCost({
          ...ing,
          average_price: mat.average_price,
          material_unit: mat.unit,
          material_name: mat.name,
        });
      }
    }
    let srCost = 0;
    for (const sr of formSubRecipes) {
      const sub = subRecipes.find((s) => s.id === sr.sub_recipe_id);
      if (sub) {
        srCost += sr.quantity * (sub.cost_per_unit || 0);
      }
    }
    const totalCost = ingCost + srCost;
    const profit = formSellingPrice - totalCost;
    const foodCostPct = formSellingPrice > 0 ? (totalCost / formSellingPrice) * 100 : 0;
    return { totalCost, profit, foodCostPct };
  }, [formIngredients, formSubRecipes, formSellingPrice, materials, subRecipes]);

  // Live cost calculator for sub-recipe form
  const liveSubRecipeCost = useMemo(() => {
    let total = 0;
    for (const ing of srFormIngredients) {
      const mat = materials.find((m) => m.id === ing.material_id);
      if (mat) {
        total += computeIngredientCost({
          ...ing,
          average_price: mat.average_price,
          material_unit: mat.unit,
          material_name: mat.name,
        });
      }
    }
    const costPerUnit = srFormYieldQty > 0 ? total / srFormYieldQty : 0;
    return { total, costPerUnit };
  }, [srFormIngredients, srFormYieldQty, materials]);

  // -------------------------------------------------------------------------
  // Bulk Upload helpers
  // -------------------------------------------------------------------------

  function downloadTemplate(withMaterials = false) {
    const url = `/api/recipes/template${withMaterials ? '?with_materials=true' : ''}`;
    window.open(url, '_blank');
  }

  function exportAllRecipes() {
    window.open('/api/recipes/export', '_blank');
  }

  // Bulk refresh — re-runs material price + recipe cost recomputation across
  // the catalog. Use when the recipe card numbers look stale (e.g. after a
  // pack_size fix, a vendor price update, or any bulk SQL change to materials).
  const [refreshing, setRefreshing] = useState(false);
  async function refreshAllCosts() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const r = await api('/api/admin/recompute-prices', { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { alert(j.error || `HTTP ${r.status}`); return; }
      await fetchRecipes();
      // Soft success toast (no extra dep — just an alert for now)
      alert(`✓ Recomputed costs on ${j.materials} materials, ${j.sub_recipes} sub-recipes, ${j.recipes} recipes.`);
    } finally { setRefreshing(false); }
  }

  // Restore prices from purchases — recomputes raw_materials.average_price
  // from the canonical source (purchases.unit_price) using the same logic
  // as updateMaterialPrice. Use this if a bad bulk action put prices into
  // the wrong scale. Safe — purely a source-of-truth recompute.
  const [normalizing, setNormalizing] = useState(false);
  async function restorePrices() {
    if (normalizing) return;
    if (!window.confirm(
      'Restore all material prices from the Purchases table?\n\n' +
      'This recomputes average_price for every material that has at least one purchase. ' +
      'Materials with no purchase history will be skipped (edit them manually).\n\n' +
      'Use this to recover from any bad bulk price action.'
    )) return;
    setNormalizing(true);
    try {
      const r = await api('/api/admin/restore-prices', { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { alert(j.error || `HTTP ${r.status}`); return; }
      await fetchRecipes();
      const lines = [`✓ ${j.summary}`];
      if (j.restored?.length) {
        lines.push('', 'Restored:');
        for (const n of j.restored.slice(0, 15)) {
          lines.push(`  ${n.name}: ${n.before} → ${n.after}`);
        }
        if (j.restored.length > 15) lines.push(`  …+${j.restored.length - 15} more`);
      }
      if (j.skipped_no_purchase?.length) {
        lines.push('', `${j.skipped_no_purchase.length} material(s) skipped — no purchase history (edit manually on /inventory).`);
      }
      alert(lines.join('\n'));
    } finally { setNormalizing(false); }
  }

  /**
   * Open the Copy modal for a given recipe. Pre-fills smart name suggestions:
   *   "Manchow Soup Veg / Non Veg" → original suggestion "Manchow Soup Veg",
   *                                  new copy suggestion  "Manchow Soup Non Veg"
   *   plain "Butter Chicken"      → original kept, new copy "Butter Chicken (copy)"
   */
  function openCopyRecipe(recipe: Recipe) {
    setCopyFor(recipe);
    setCopyError(null);
    setCopySaving(false);
    setCopyPrice(recipe.selling_price || 0);

    // Heuristic name split — try to detect dual-variant names like "X Veg / Non Veg"
    const m = recipe.name.match(/^(.+?)\s*(?:[/\-–—]|\bvs\b)\s*(.+)$/i);
    if (m) {
      // e.g. "Manchow Soup Veg / Non Veg" → "Manchow Soup Veg" + "Manchow Soup Non Veg"
      // We assume the trailing piece is the variant — find the shared prefix.
      const left  = m[1].trim();
      const right = m[2].trim();
      const words = left.split(/\s+/);
      // Strip the last token from `left` if it looks like a variant qualifier
      const variantTokens = /^(veg|non[\s-]?veg|nv|chicken|prawn|prawns|paneer|mutton|fish|lamb|egg|gluten[\s-]?free)$/i;
      const isVariant = variantTokens.test(words[words.length - 1] || '');
      const base = isVariant ? words.slice(0, -1).join(' ') : left;
      setCopyOriginalName(isVariant ? `${base} ${words[words.length - 1]}` : left);
      setCopyNewName(`${base} ${right}`.trim());
      setCopyDoRename(true);
    } else {
      setCopyOriginalName(recipe.name);
      setCopyNewName(`${recipe.name} (copy)`);
      setCopyDoRename(false);
    }
  }

  async function saveCopyRecipe() {
    if (!copyFor) return;
    if (!copyNewName.trim()) { setCopyError('New recipe name is required'); return; }
    setCopySaving(true); setCopyError(null);
    try {
      const r = await api(`/api/recipes/${copyFor.id}/duplicate`, {
        method: 'POST',
        body: {
          new_name: copyNewName.trim(),
          selling_price: copyPrice,
          category: copyFor.category,
          rename_original: copyDoRename && copyOriginalName.trim() !== copyFor.name
                            ? copyOriginalName.trim() : undefined,
        },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setCopyError(j.error || `HTTP ${r.status}`); return; }
      setCopyFor(null);
      await fetchRecipes();   // refresh recipe list
    } finally { setCopySaving(false); }
  }

  function openBulkModal() {
    setBulkModalOpen(true);
    setBulkFileName(null);
    setBulkRows([]);
    setBulkResult(null);
    setBulkOverwrite(false);
    setSubBulkFileName(null);
    setSubBulkRows([]);
    setSubBulkResult(null);
    setSubBulkOverwrite(true);
  }

  async function handleBulkFile(file: File) {
    setBulkResult(null);
    setBulkFileName(file.name);

    const mapRows = (rows: any[]) => {
      return rows
        .filter((r: any) => {
          const name = r.recipe_name || r['Recipe Name'] || r['RECIPE NAME'] || '';
          return name && !String(name).startsWith('#');
        })
        .map((r: any) => ({
          recipe_name: String(r.recipe_name || r['Recipe Name'] || r['RECIPE NAME'] || '').trim(),
          category: String(r.category || r.Category || '').trim() || 'other',
          selling_price: Number(r.selling_price || r['Selling Price'] || 0),
          ingredient_name: String(r.ingredient_name || r['Ingredient Name'] || r['INGREDIENT'] || '').trim(),
          quantity: Number(r.quantity || r.Quantity || 0),
          unit: String(r.unit || r.Unit || 'g').trim(),
          yield_percent: Number(r.yield_percent || r['Yield %'] || 100),
          wastage_percent: Number(r.wastage_percent || r['Wastage %'] || 0),
          notes: String(r.notes || r.Notes || '').trim(),
        }))
        .filter((r: any) => r.recipe_name && r.ingredient_name);
    };

    // A file that parses to ZERO usable rows must say so — silently showing the
    // filename with no preview/upload button reads as a broken page (and the
    // costing-workbook .xlsx lands here by mistake: its first sheet has none of
    // our columns, so everything filters out).
    const applyRows = (rows: ReturnType<typeof mapRows>) => {
      setBulkRows(rows);
      if (rows.length === 0) {
        setBulkResult({ errors: [
          `No usable rows found in "${file.name}" — this upload needs recipe_name / ingredient_name / quantity columns (the recipes-restore CSV, the template, or a flat Excel sheet).`,
          'The Food-Costing workbook (.xlsx with Purchase Rates / Cards sheets) is imported via “Import Recipe Workbook” instead.',
        ] });
      }
    };
    if (file.name.endsWith('.xlsx') || file.name.endsWith('.xls')) {
      const XLSX = await import('xlsx');
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<any>(sheet);
      applyRows(mapRows(rows));
    } else {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        comments: '#',
        complete: (results) => applyRows(mapRows(results.data as any[])),
      });
    }
  }

  async function submitBulkUpload() {
    setBulkUploading(true);
    setBulkResult(null);
    try {
      const res = await api('/api/recipes/bulk', {
        method: 'POST',
        body: { rows: bulkRows, overwrite_existing: bulkOverwrite },
      });
      const json = await res.json();
      // Non-OK responses carry a singular { error } — surface it in the pane's
      // errors list instead of rendering an empty "success" box.
      if (!res.ok) { setBulkResult({ errors: [json.error || `HTTP ${res.status}`] }); return; }
      setBulkResult(json);
      if (json.recipes_created > 0 || json.recipes_updated > 0) {
        await fetchRecipes();
      }
    } catch (err: any) {
      setBulkResult({ errors: [err.message] });
    } finally {
      setBulkUploading(false);
    }
  }

  // Count unique recipes in preview
  const previewRecipeCount = new Set(bulkRows.map(r => r.recipe_name)).size;

  // --- restore full book: Step 1 sub-recipes CSV ---

  function handleSubBulkFile(file: File) {
    setSubBulkResult(null);
    setSubBulkFileName(file.name);
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      comments: '#',
      complete: (results) => {
        const rows = (results.data as any[])
          .map((r: any) => ({
            sub_recipe_name: String(r.sub_recipe_name || r['Sub Recipe Name'] || '').trim(),
            yield_qty: Number(r.yield_qty || r['Yield Qty'] || 0),
            yield_unit: String(r.yield_unit || r['Yield Unit'] || '').trim(),
            ingredient_name: String(r.ingredient_name || r['Ingredient Name'] || '').trim(),
            quantity: Number(r.quantity || r.Quantity || 0),
            unit: String(r.unit || r.Unit || 'g').trim(),
          }))
          .filter((r: any) => r.sub_recipe_name && r.ingredient_name);
        setSubBulkRows(rows);
        // Zero usable rows must say so, not silently show a filename (same
        // guard as the recipes upload above).
        if (rows.length === 0) {
          setSubBulkResult({ errors: [
            `No usable rows found in "${file.name}" — Step 1 needs the sub-recipes-restore CSV with sub_recipe_name / ingredient_name / quantity columns.`,
          ] });
        }
      },
    });
  }

  async function submitSubBulkUpload() {
    setSubBulkUploading(true);
    setSubBulkResult(null);
    try {
      const res = await api('/api/recipes/sub-bulk', {
        method: 'POST',
        body: { rows: subBulkRows, overwrite_existing: subBulkOverwrite },
      });
      const json = await res.json();
      if (!res.ok) { setSubBulkResult({ errors: [json.error || `HTTP ${res.status}`] }); return; }
      setSubBulkResult(json);
      if (json.subs_created > 0 || json.subs_updated > 0) {
        // Sub-recipe costs roll up into recipe costs — refresh both lists.
        await Promise.all([fetchSubRecipes(), fetchRecipes()]);
        // Step 2 of a restore MUST overwrite the damaged recipes — pre-tick it
        // so the documented flow can't silently no-op with 140 "skipped".
        setBulkOverwrite(true);
      }
    } catch (err: any) {
      setSubBulkResult({ errors: [err.message] });
    } finally {
      setSubBulkUploading(false);
    }
  }

  // Count unique sub-recipes in preview
  const subBulkPreviewCount = new Set(subBulkRows.map(r => r.sub_recipe_name)).size;

  // -------------------------------------------------------------------------
  // Bar Costing Excel Importer (specialized — reads 3 sheets + auto-fixes)
  // -------------------------------------------------------------------------

  function openBarModal() {
    setBarModalOpen(true);
    setBarFileName(null);
    setBarPreview(null);
    setBarPayload(null);
    setBarResult(null);
  }

  async function handleBarFile(file: File) {
    setBarResult(null);
    setBarFileName(file.name);

    try {
      const XLSX = await import('xlsx');
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: 'array' });

      const liquorRawSheet = wb.Sheets['Liquor Raw'];
      const recipeSheet = wb.Sheets['Receipe'];
      const barProductSheet = wb.Sheets['BAR PRODUCTS'];

      if (!liquorRawSheet || !recipeSheet || !barProductSheet) {
        setBarResult({ error: 'Expected sheets: "Liquor Raw", "Receipe", "BAR PRODUCTS". Not all found.' });
        return;
      }

      // Parse Liquor Raw
      const liquorRows = XLSX.utils.sheet_to_json<any>(liquorRawSheet, { header: 1, defval: null });
      const liquor_raw: any[] = [];
      for (let i = 1; i < liquorRows.length; i++) {
        const r = liquorRows[i];
        if (!r || !r[1]) continue;
        liquor_raw.push({
          name: String(r[1]).trim(),
          rate: Number(r[4]) || 0,
          category: String(r[5] || '').trim(),
          purchaseUnit: String(r[6] || '').trim(),
          consumptionUnit: String(r[7] || '').trim(),
        });
      }

      // Parse Recipes
      const recipeRows = XLSX.utils.sheet_to_json<any>(recipeSheet, { header: 1, defval: null });
      const recipes: any[] = [];
      for (let i = 1; i < recipeRows.length; i++) {
        const r = recipeRows[i];
        if (!r || !r[1]) continue;
        const recipeName = String(r[1]).trim();
        const matName = r[3] ? String(r[3]).trim() : '';
        const qty = Number(r[4]) || 0;
        const unit = r[5] ? String(r[5]).trim() : '';
        const isSemi = r[12] === 'Yes';
        if (!matName || qty <= 0) continue;
        recipes.push({ recipeName, matName, qty, unit, isSemi });
      }

      // Parse BAR PRODUCTS
      const barRows = XLSX.utils.sheet_to_json<any>(barProductSheet, { header: 1, defval: null });
      const bar_products: any[] = [];
      for (let i = 1; i < barRows.length; i++) {
        const r = barRows[i];
        if (!r || !r[1]) continue;
        bar_products.push({
          name: String(r[1]).trim(),
          category: String(r[0] || '').trim(),
          sellingPrice: Number(r[5]) || 0,
          status: String(r[7] || '').trim(),
        });
      }

      // Count unique recipes with ingredients
      const recipeSet = new Set(recipes.map(r => r.recipeName));
      const brokenQty = recipes.filter(r => r.qty > 5000).length;
      const withSellingPrice = [...recipeSet].filter(n =>
        bar_products.some(p => p.name.toLowerCase() === n.toLowerCase() && p.sellingPrice > 0)
      ).length;

      setBarPreview({
        materials: liquor_raw.length,
        recipes: recipeSet.size,
        recipe_lines: recipes.length,
        products: bar_products.length,
        broken_quantities: brokenQty,
        recipes_with_price: withSellingPrice,
      });
      setBarPayload({ liquor_raw, recipes, bar_products });
    } catch (err: any) {
      setBarResult({ error: err.message });
    }
  }

  async function submitBarImport() {
    if (!barPayload) return;
    setBarImporting(true);
    setBarResult(null);
    try {
      const res = await api('/api/recipes/bar-import', {
        method: 'POST',
        body: { ...barPayload, overwrite_existing: barOverwrite, skip_beer_direct_sale: true },
      });
      const json = await res.json();
      setBarResult(json);
      if (json.recipes_created > 0 || json.recipes_updated > 0) {
        await fetchRecipes();
      }
    } catch (err: any) {
      setBarResult({ error: err.message });
    } finally {
      setBarImporting(false);
    }
  }

  // -------------------------------------------------------------------------
  // Food-Costing workbook importer (Purchase Rates → Sub-Recipes → Recipes)
  // Server-side parse: upload to /preview, then /commit. Uses the shared parser.
  // -------------------------------------------------------------------------

  function openWorkbookModal() {
    setWbModalOpen(true);
    setWbFile(null);
    setWbFileName(null);
    setWbPreview(null);
    setWbResult(null);
  }

  async function handleWorkbookFile(file: File) {
    setWbResult(null);
    setWbPreview(null);
    setWbFile(file);
    setWbFileName(file.name);
    setWbPreviewing(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await api('/api/recipe-workbook-import/preview', { method: 'POST', body: fd });
      const json = await res.json();
      if (!res.ok || json.error) setWbResult({ error: json.error || 'Failed to parse file' });
      else setWbPreview(json);
    } catch (err: any) {
      setWbResult({ error: err.message });
    } finally {
      setWbPreviewing(false);
    }
  }

  async function submitWorkbookImport() {
    if (!wbFile) return;
    setWbImporting(true);
    setWbResult(null);
    try {
      const fd = new FormData();
      fd.append('file', wbFile);
      fd.append('overwrite', wbOverwrite ? '1' : '0');
      const res = await api('/api/recipe-workbook-import/commit', { method: 'POST', body: fd });
      const json = await res.json();
      setWbResult(json);
      if (!json.error) {
        // Pull the workbook's target FC% into the UI and refresh everything that changed.
        if (wbPreview?.target_food_cost_pct) setTargetFcPct(Number(wbPreview.target_food_cost_pct));
        await Promise.all([fetchRecipes(), fetchSubRecipes(), fetchMaterials()]);
      }
    } catch (err: any) {
      setWbResult({ error: err.message });
    } finally {
      setWbImporting(false);
    }
  }

  // Persist the Target Food-Cost % (stored as a fraction string in settings).
  async function saveTargetFcPct(pctFraction: number) {
    setTargetFcPct(pctFraction);
    try {
      await api('/api/settings', { method: 'PUT', body: { key: 'target_food_cost_pct', value: String(pctFraction) } });
    } catch (e) {
      console.error('Failed to save target FC%', e);
    }
  }

  // --- Category manager (rename / merge) ---
  const [catModalOpen, setCatModalOpen] = useState(false);
  const [catRenaming, setCatRenaming] = useState<string | null>(null);
  async function renameCategory(from: string, to: string) {
    const toC = to.trim();
    if (!toC || toC === from) return;
    setCatRenaming(from);
    try {
      const res = await api('/api/recipes/rename-category', { method: 'POST', body: { from, to: toC } });
      const json = await res.json();
      if (json.error) { alert('Failed: ' + json.error); return; }
      await fetchRecipes();
      setCategoryFilter((cf) => (cf === from ? toC : cf));   // keep the active filter pointed at the renamed category
    } catch (e: any) {
      alert('Failed: ' + e.message);
    } finally {
      setCatRenaming(null);
    }
  }

  // Auto-assign categories from recipe names for any recipe that has none.
  const [categorizing, setCategorizing] = useState(false);
  async function autoCategorize() {
    if (!confirm('Auto-assign categories to recipes that have none (from their names)?\nManually-set categories are left untouched.')) return;
    setCategorizing(true);
    try {
      const res = await api('/api/recipes/auto-categorize', { method: 'POST', body: {} });
      const json = await res.json();
      if (json.error) alert('Failed: ' + json.error);
      else {
        await fetchRecipes();
        const dist = Object.entries(json.distribution || {}).map(([c, n]) => `${c}: ${n}`).join('\n');
        alert(`Categorised ${json.updated} recipe(s).\n\n${dist}`);
      }
    } catch (e: any) {
      alert('Failed: ' + e.message);
    } finally {
      setCategorizing(false);
    }
  }

  // -------------------------------------------------------------------------
  // Modal open helpers
  // -------------------------------------------------------------------------

  function openAddRecipe() {
    setEditingRecipe(null);
    setFormName('');
    setFormCategory('');
    setFormSellingPrice(0);
    setFormMenuItemId('');
    setFormPosItemId('');
    setFormIngredients([]);
    setFormSubRecipes([]);
    setFormInstructions('');
    setFormImageUrl('');
    setShowRecipeModal(true);
  }

  function openEditRecipe(recipe: Recipe) {
    setEditingRecipe(recipe);
    setFormName(recipe.name);
    setFormCategory(recipe.category);
    setFormSellingPrice(recipe.selling_price);
    setFormInstructions((recipe as any).instructions || '');
    setFormImageUrl((recipe as any).image_url || '');
    // Find any menu_item already linked to this recipe
    const linked = menuItems.find(mi => mi.recipe_id === recipe.id);
    setFormMenuItemId(linked?.id || '');
    setFormPosItemId(linked?.item_code || '');
    setFormIngredients(
      recipe.ingredients.map((i) => ({
        material_id: i.material_id,
        material_name: i.material_name,
        quantity: i.quantity,
        unit: i.unit,
        yield_percent: i.yield_percent,
        wastage_percent: i.wastage_percent,
        is_default: i.is_default,
        brand_preference: i.brand_preference || '',
        average_price: i.average_price,
      })),
    );
    setFormSubRecipes(
      recipe.sub_recipes.map((sr) => ({
        sub_recipe_id: sr.sub_recipe_id,
        sub_recipe_name: sr.sub_recipe_name,
        quantity: sr.quantity,
        unit: sr.unit,
        cost_per_unit: sr.cost_per_unit,
      })),
    );
    setSelectedRecipe(null);
    setShowRecipeModal(true);
  }

  function openAddSubRecipe() {
    setEditingSubRecipe(null);
    setSrFormName('');
    setSrFormCategory('');
    setSrFormYieldQty(1);
    setSrFormYieldUnit('kg');
    setSrFormIngredients([]);
    setShowSubRecipeModal(true);
  }

  function openEditSubRecipe(sr: SubRecipe) {
    setEditingSubRecipe(sr);
    setSrFormName(sr.name);
    setSrFormCategory(sr.category);
    setSrFormYieldQty(sr.yield_quantity);
    setSrFormYieldUnit(sr.yield_unit);
    setSrFormIngredients(
      sr.ingredients.map((i) => ({
        material_id: i.material_id,
        material_name: i.material_name,
        quantity: i.quantity,
        unit: i.unit,
        yield_percent: i.yield_percent,
        wastage_percent: i.wastage_percent,
        is_default: i.is_default,
        brand_preference: i.brand_preference || '',
        average_price: i.average_price,
      })),
    );
    setSelectedSubRecipe(null);
    setShowSubRecipeModal(true);
  }

  // -------------------------------------------------------------------------
  // Form ingredient helpers
  // -------------------------------------------------------------------------

  function addFormIngredient(setter: React.Dispatch<React.SetStateAction<Ingredient[]>>) {
    setter((prev) => [
      ...prev,
      {
        material_id: '',
        quantity: 0,
        unit: 'kg',
        yield_percent: 100,
        wastage_percent: 0,
        is_default: 1,
        brand_preference: '',
      },
    ]);
  }

  function updateFormIngredient(
    setter: React.Dispatch<React.SetStateAction<Ingredient[]>>,
    index: number,
    field: string,
    value: any,
  ) {
    setter((prev) => {
      const copy = [...prev];
      (copy[index] as any)[field] = value;
      return copy;
    });
  }

  function removeFormIngredient(setter: React.Dispatch<React.SetStateAction<Ingredient[]>>, index: number) {
    setter((prev) => prev.filter((_, i) => i !== index));
  }

  function addFormSubRecipe() {
    setFormSubRecipes((prev) => [
      ...prev,
      { sub_recipe_id: '', quantity: 0, unit: '' },
    ]);
  }

  function updateFormSubRecipe(index: number, field: string, value: any) {
    setFormSubRecipes((prev) => {
      const copy = [...prev];
      (copy[index] as any)[field] = value;
      // Costing everywhere is quantity × cost_per_unit, where cost_per_unit is
      // ₹ per yield_unit with NO unit conversion — so the row's unit must
      // always be the selected sub-recipe's yield unit.
      if (field === 'sub_recipe_id') {
        const sub = subRecipes.find((s) => s.id === value);
        if (sub) copy[index].unit = sub.yield_unit;
      }
      return copy;
    });
  }

  function removeFormSubRecipe(index: number) {
    setFormSubRecipes((prev) => prev.filter((_, i) => i !== index));
  }

  // -------------------------------------------------------------------------
  // Submit handlers
  // -------------------------------------------------------------------------

  async function handleSaveRecipe() {
    if (!formName.trim()) return;
    setSaving(true);
    try {
      const payload: any = {
        name: formName,
        category: formCategory,
        selling_price: formSellingPrice,
        instructions: formInstructions,
        image_url: formImageUrl,
        menu_item_id: formMenuItemId || undefined,  // link menu_items.recipe_id on save
        ingredients: formIngredients
          .filter((i) => i.material_id)
          .map((i) => ({
            material_id: i.material_id,
            quantity: Number(i.quantity),
            unit: i.unit,
            yield_percent: Number(i.yield_percent),
            wastage_percent: Number(i.wastage_percent),
            is_default: i.is_default,
            brand_preference: i.brand_preference,
          })),
        sub_recipes: formSubRecipes
          .filter((sr) => sr.sub_recipe_id)
          .map((sr) => ({
            sub_recipe_id: sr.sub_recipe_id,
            quantity: Number(sr.quantity),
            // Persist the sub's yield unit — costing is quantity × cost_per_unit
            // (₹ per yield_unit) with no conversion, so any other unit lies.
            unit: subRecipes.find((s) => s.id === sr.sub_recipe_id)?.yield_unit || sr.unit,
          })),
      };
      if (editingRecipe) {
        payload.id = editingRecipe.id;
        await api('/api/recipes', { method: 'PUT', body: payload });
      } else {
        await api('/api/recipes', { method: 'POST', body: payload });
      }
      setShowRecipeModal(false);
      await fetchRecipes();
    } catch (e) {
      console.error('Save recipe failed', e);
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveSubRecipe() {
    if (!srFormName.trim()) return;
    setSaving(true);
    try {
      const payload: any = {
        name: srFormName,
        category: srFormCategory,
        yield_quantity: Number(srFormYieldQty),
        yield_unit: srFormYieldUnit,
        ingredients: srFormIngredients
          .filter((i) => i.material_id)
          .map((i) => ({
            material_id: i.material_id,
            quantity: Number(i.quantity),
            unit: i.unit,
            yield_percent: Number(i.yield_percent),
            wastage_percent: Number(i.wastage_percent),
            is_default: i.is_default,
            brand_preference: i.brand_preference,
          })),
      };
      if (editingSubRecipe) {
        payload.id = editingSubRecipe.id;
        await api('/api/sub-recipes', { method: 'PUT', body: payload });
      } else {
        await api('/api/sub-recipes', { method: 'POST', body: payload });
      }
      setShowSubRecipeModal(false);
      await Promise.all([fetchSubRecipes(), fetchRecipes()]);
    } catch (e) {
      console.error('Save sub-recipe failed', e);
    } finally {
      setSaving(false);
    }
  }

  // Category-only quick update (list rows / cards / detail header).
  // PUT with just {id, category} — the API leaves name, price, ingredients
  // and sub-recipes untouched.
  async function quickSetCategory(recipeId: string, category: string) {
    await api('/api/recipes', { method: 'PUT', body: { id: recipeId, category } });
    setSelectedRecipe((prev) => (prev && prev.id === recipeId ? { ...prev, category } : prev));
    await fetchRecipes();
  }

  async function quickSetSubCategory(subId: string, category: string) {
    await api('/api/sub-recipes', { method: 'PUT', body: { id: subId, category } });
    setSelectedSubRecipe((prev) => (prev && prev.id === subId ? { ...prev, category } : prev));
    await fetchSubRecipes();
  }

  async function handleDeleteRecipe(id: string) {
    if (!confirm('Deactivate this recipe?')) return;
    await api(`/api/recipes?id=${id}`, { method: 'DELETE' });
    setSelectedRecipe(null);
    await fetchRecipes();
  }

  async function handleDeleteSubRecipe(id: string) {
    if (!confirm('Deactivate this sub-recipe?')) return;
    await api(`/api/sub-recipes?id=${id}`, { method: 'DELETE' });
    setSelectedSubRecipe(null);
    await fetchSubRecipes();
  }

  // -------------------------------------------------------------------------
  // Ingredient row renderer (shared by both modals)
  // -------------------------------------------------------------------------

  function renderIngredientRows(
    list: Ingredient[],
    setter: React.Dispatch<React.SetStateAction<Ingredient[]>>,
  ) {
    return list.map((ing, idx) => (
      <div key={idx} className="grid grid-cols-12 gap-2 items-end mb-2">
        {/* Material */}
        <div className="col-span-4">
          {idx === 0 && <label className="block text-xs text-[#8B7355] mb-1">Material</label>}
          <MaterialPicker
            value={ing.material_id}
            materials={materials}
            onChange={(id) => {
              // Auto-set the recipe unit to the material's stock unit (the
              // unit recipes are denominated in for that material). Saves the
              // user a click and prevents mismatches like picking 'kg' when
              // the material is denominated in 'g'.
              const mat = materials.find((m) => m.id === id);
              setter((prev) => {
                const copy = [...prev];
                copy[idx] = {
                  ...copy[idx],
                  material_id: id,
                  unit: mat?.unit || copy[idx].unit,
                };
                return copy;
              });
            }}
          />
        </div>
        {/* Qty */}
        <div className="col-span-1">
          {idx === 0 && <label className="block text-xs text-[#8B7355] mb-1">Qty</label>}
          <input
            type="number"
            step="any"
            className="w-full bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-2 py-2 text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
            value={ing.quantity || ''}
            onChange={(e) => updateFormIngredient(setter, idx, 'quantity', parseFloat(e.target.value) || 0)}
          />
        </div>
        {/* Unit */}
        <div className="col-span-1">
          {idx === 0 && <label className="block text-xs text-[#8B7355] mb-1">Unit</label>}
          <select
            className="w-full bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-2 py-2 text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
            value={ing.unit}
            onChange={(e) => updateFormIngredient(setter, idx, 'unit', e.target.value)}
          >
            <option value="kg">kg</option>
            <option value="g">g</option>
            <option value="l">l</option>
            <option value="ml">ml</option>
            <option value="pcs">pcs</option>
            <option value="dozen">dozen</option>
          </select>
        </div>
        {/* Yield % */}
        <div className="col-span-1">
          {idx === 0 && <label className="block text-xs text-[#8B7355] mb-1">Yield%</label>}
          <input
            type="number"
            className="w-full bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-2 py-2 text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
            value={ing.yield_percent}
            onChange={(e) => updateFormIngredient(setter, idx, 'yield_percent', parseFloat(e.target.value) || 100)}
          />
        </div>
        {/* Wastage % */}
        <div className="col-span-1">
          {idx === 0 && <label className="block text-xs text-[#8B7355] mb-1">Waste%</label>}
          <input
            type="number"
            className="w-full bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-2 py-2 text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
            value={ing.wastage_percent}
            onChange={(e) => updateFormIngredient(setter, idx, 'wastage_percent', parseFloat(e.target.value) || 0)}
          />
        </div>
        {/* Brand */}
        <div className="col-span-1">
          {idx === 0 && <label className="block text-xs text-[#8B7355] mb-1">Brand (opt)</label>}
          <input
            type="text"
            className="w-full bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-2 py-2 text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
            value={ing.brand_preference}
            onChange={(e) => updateFormIngredient(setter, idx, 'brand_preference', e.target.value)}
            placeholder="Opt"
          />
        </div>
        {/* Default toggle */}
        <div className="col-span-1 flex items-center gap-1">
          {idx === 0 && <label className="block text-xs text-[#8B7355] mb-1 w-full">Default</label>}
          <input
            type="checkbox"
            className="accent-[#af4408] w-4 h-4"
            checked={ing.is_default === 1}
            onChange={(e) => updateFormIngredient(setter, idx, 'is_default', e.target.checked ? 1 : 0)}
          />
        </div>
        {/* Cost display + remove */}
        <div className="col-span-2 flex items-center gap-2">
          {idx === 0 && <label className="block text-xs text-[#8B7355] mb-1 invisible">Actions</label>}
          <span className="text-xs text-[#8B7355] min-w-[60px]">
            {(() => {
              const mat = materials.find((m) => m.id === ing.material_id);
              if (!mat) return '-';
              return formatCurrency(computeIngredientCost({
                ...ing,
                average_price: mat.average_price,
                material_unit: mat.unit,
                material_name: mat.name,
              }));
            })()}
          </span>
          <button
            type="button"
            onClick={() => removeFormIngredient(setter, idx)}
            className="text-red-400 hover:text-red-300 p-1"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    ));
  }

  // -------------------------------------------------------------------------
  // RENDER
  // -------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-8 h-8 animate-spin text-[#af4408]" />
      </div>
    );
  }

  // ---- Recipe Detail View ----
  if (selectedRecipe) {
    const r = selectedRecipe;
    const profit = (r.selling_price || 0) - (r.total_cost || 0);
    const fcp = r.food_cost_percent || 0;
    return (
      <div>
        <button
          onClick={() => setSelectedRecipe(null)}
          className="flex items-center gap-2 text-[#8B7355] hover:text-[#3D2614] mb-6 transition-colors"
        >
          <ArrowLeft size={18} />
          <span>Back to Recipes</span>
        </button>

        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-[#2D1B0E]">{r.name}</h1>
            <div className="flex items-center gap-3 mt-2">
              <CategoryChip
                value={r.category || ''}
                categories={recipeCategories}
                onPick={(c) => quickSetCategory(r.id, c)}
              />
              <span className="badge badge-primary">v{r.version}</span>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => openEditRecipe(r)}
              className="flex items-center gap-2 bg-[#af4408] hover:bg-[#8a3506] text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            >
              <Edit size={16} /> Edit Recipe
            </button>
            <button
              onClick={() => handleDeleteRecipe(r.id)}
              className="flex items-center gap-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            >
              <Trash2 size={16} /> Delete
            </button>
          </div>
        </div>

        {/* Cookbook photo */}
        {r.image_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={r.image_url} alt={r.name} className="w-full max-h-60 object-cover rounded-xl border border-[#E8D5C4] mb-6"
               onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
        )}

        {/* Cost summary cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 mb-6">
          <div className="card">
            <p className="text-xs text-[#8B7355] uppercase tracking-wide">Selling Price</p>
            <p className="text-xl font-bold text-[#2D1B0E] mt-1">{formatCurrency(r.selling_price || 0)}</p>
          </div>
          <div className="card">
            <p className="text-xs text-[#8B7355] uppercase tracking-wide">Total Cost</p>
            <p className="text-xl font-bold text-[#2D1B0E] mt-1">{formatCurrency(r.total_cost || 0)}</p>
          </div>
          <div className="card">
            <p className="text-xs text-[#8B7355] uppercase tracking-wide">Profit</p>
            <p className={`text-xl font-bold mt-1 ${profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {formatCurrency(profit)}
            </p>
          </div>
          <div className="card">
            <p className="text-xs text-[#8B7355] uppercase tracking-wide">Food Cost %</p>
            <p className={`text-xl font-bold mt-1 ${foodCostColor(fcp)}`}>{fcp.toFixed(1)}%</p>
          </div>
        </div>

        {/* Cookbook: allergen roll-up (auto-detected from ingredient names) */}
        {(r.allergens && r.allergens.length > 0) ? (
          <div className="card mb-6 border-l-4 border-l-amber-400">
            <div className="flex items-start gap-2 flex-wrap">
              <h2 className="text-sm font-semibold text-[#2D1B0E] flex items-center gap-2">
                <ShieldAlert size={16} className="text-amber-500" /> Allergens
              </h2>
              <div className="flex flex-wrap gap-2 flex-1">
                {r.allergens.map((k) => (
                  <span key={k} className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-amber-50 text-amber-900 border border-amber-200">
                    <span aria-hidden>{allergenEmoji(k)}</span> {allergenLabel(k)}
                  </span>
                ))}
              </div>
            </div>
            <p className="text-[11px] text-[#8B7355] mt-2 leading-relaxed">
              Auto-detected from ingredient names — a kitchen aid, not a guarantee. Verify with the chef before relying on this for a guest allergy.
            </p>
          </div>
        ) : (
          <div className="card mb-6">
            <p className="text-xs text-[#8B7355] flex items-center gap-2">
              <ShieldAlert size={14} className="text-[#B9A48C]" /> No common allergens auto-detected from the ingredient names. This is advisory only — always confirm with the chef.
            </p>
          </div>
        )}

        {/* Ingredients table */}
        <div className="card mb-6">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <h2 className="text-lg font-semibold text-[#2D1B0E] flex items-center gap-2">
              <Layers size={18} /> Ingredients ({r.ingredients.length})
            </h2>
            {/* Cookbook: portion scaling — multiplies the prep quantities (and line
                costs) below. The summary cards above stay per base recipe. */}
            <div className="flex items-center gap-1.5 text-xs text-[#6B5744]">
              <span className="uppercase tracking-wide text-[#8B7355] mr-0.5">Scale</span>
              {[0.5, 1, 2, 4].map((s) => (
                <button key={s} onClick={() => setScaleTo(s)}
                        className={`px-2 py-1 rounded border ${scale === s ? 'bg-[#af4408] text-white border-[#af4408]' : 'bg-white border-[#E8D5C4] text-[#6B5744] hover:bg-[#FFF1E3]'}`}>×{s}</button>
              ))}
              {/* Mirror the raw string so mid-typing states like "1." survive; only
                  commit to `scale` when the parse is a positive number. */}
              <input type="number" min={0.1} step="any" value={scaleInput} aria-label="Scale factor"
                     onChange={(e) => {
                       setScaleInput(e.target.value);
                       const v = parseFloat(e.target.value);
                       if (Number.isFinite(v) && v > 0) setScale(v);
                     }}
                     onBlur={() => { const v = parseFloat(scaleInput); if (!Number.isFinite(v) || v <= 0) setScaleTo(1); }}
                     className="w-16 px-2 py-1 border border-[#E8D5C4] rounded text-right bg-white" />
              {r.yield_quantity ? <span className="text-[10px] text-[#8B7355] whitespace-nowrap">≈ {+(r.yield_quantity * scale).toFixed(2)} {r.yield_unit}</span> : null}
            </div>
          </div>
          {r.ingredients.length === 0 ? (
            <p className="text-[#8B7355] text-sm">No ingredients added.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[#8B7355] border-b border-[#E8D5C4]">
                    <th className="text-left py-2 px-2 font-medium">Material</th>
                    <th className="text-right py-2 px-2 font-medium">Qty</th>
                    <th className="text-left py-2 px-2 font-medium">Unit</th>
                    <th className="text-right py-2 px-2 font-medium">Yield%</th>
                    <th className="text-right py-2 px-2 font-medium">Wastage%</th>
                    <th className="text-right py-2 px-2 font-medium">Unit Price</th>
                    <th className="text-right py-2 px-2 font-medium">Eff. Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {r.ingredients.map((ing, i) => {
                    const effCost = computeIngredientCost(ing);
                    return (
                      <tr key={i} className="border-b border-[#E8D5C4]/50 hover:bg-[#FFF1E3]/30">
                        <td className="py-2 px-2 text-[#3D2614]">{ing.material_name || ing.material_id}</td>
                        <td className="py-2 px-2 text-right text-[#6B5744] tabular-nums">{+(Number(ing.quantity) * scale).toFixed(3)}</td>
                        <td className="py-2 px-2 text-[#8B7355]">{ing.unit}</td>
                        <td className="py-2 px-2 text-right text-[#6B5744]">{ing.yield_percent}%</td>
                        <td className="py-2 px-2 text-right text-[#6B5744]">{ing.wastage_percent}%</td>
                        <td className="py-2 px-2 text-right text-[#6B5744]">{formatCurrency(ing.average_price || 0)}</td>
                        <td className="py-2 px-2 text-right font-medium text-[#2D1B0E]">{formatCurrency(effCost * scale)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Cookbook: cooking method */}
        {(r.instructions || '').trim() && (
          <div className="card mb-6">
            <h2 className="text-lg font-semibold text-[#2D1B0E] mb-3 flex items-center gap-2">
              <ChefHat size={18} /> Method
            </h2>
            <div className="text-sm text-[#3D2614] whitespace-pre-wrap leading-relaxed">{r.instructions}</div>
          </div>
        )}

        {/* Sub-recipes used */}
        {r.sub_recipes.length > 0 && (
          <div className="card">
            <h2 className="text-lg font-semibold text-[#2D1B0E] mb-4 flex items-center gap-2">
              <ChefHat size={18} /> Sub-Recipes ({r.sub_recipes.length})
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[#8B7355] border-b border-[#E8D5C4]">
                    <th className="text-left py-2 px-2 font-medium">Sub-Recipe</th>
                    <th className="text-right py-2 px-2 font-medium">Qty</th>
                    <th className="text-left py-2 px-2 font-medium">Unit</th>
                    <th className="text-right py-2 px-2 font-medium">Cost/Unit</th>
                    <th className="text-right py-2 px-2 font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {r.sub_recipes.map((sr, i) => (
                    <tr key={i} className="border-b border-[#E8D5C4]/50 hover:bg-[#FFF1E3]/30">
                      <td className="py-2 px-2 text-[#3D2614]">{sr.sub_recipe_name || sr.sub_recipe_id}</td>
                      <td className="py-2 px-2 text-right text-[#6B5744]">{sr.quantity}</td>
                      <td className="py-2 px-2 text-[#8B7355]">{sr.unit}</td>
                      <td className="py-2 px-2 text-right text-[#6B5744]">{formatCurrency(sr.cost_per_unit || 0)}</td>
                      <td className="py-2 px-2 text-right font-medium text-[#2D1B0E]">{formatCurrency(sr.quantity * (sr.cost_per_unit || 0))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ---- Sub-Recipe Detail View ----
  if (selectedSubRecipe) {
    const sr = selectedSubRecipe;
    return (
      <div>
        <button
          onClick={() => setSelectedSubRecipe(null)}
          className="flex items-center gap-2 text-[#8B7355] hover:text-[#3D2614] mb-6 transition-colors"
        >
          <ArrowLeft size={18} />
          <span>Back to Sub-Recipes</span>
        </button>

        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-[#2D1B0E]">{sr.name}</h1>
            <div className="flex items-center gap-3 mt-2">
              <CategoryChip
                value={sr.category || ''}
                categories={subRecipeCategories}
                onPick={(c) => quickSetSubCategory(sr.id, c)}
              />
              <span className="badge badge-primary">v{sr.version}</span>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => openEditSubRecipe(sr)}
              className="flex items-center gap-2 bg-[#af4408] hover:bg-[#8a3506] text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            >
              <Edit size={16} /> Edit
            </button>
            <button
              onClick={() => handleDeleteSubRecipe(sr.id)}
              className="flex items-center gap-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            >
              <Trash2 size={16} /> Delete
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 sm:gap-4 mb-6">
          <div className="card">
            <p className="text-xs text-[#8B7355] uppercase tracking-wide">Yield</p>
            <p className="text-xl font-bold text-[#2D1B0E] mt-1">{sr.yield_quantity} {sr.yield_unit}</p>
          </div>
          <div className="card">
            <p className="text-xs text-[#8B7355] uppercase tracking-wide">Total Cost</p>
            <p className="text-xl font-bold text-[#2D1B0E] mt-1">{formatCurrency(sr.total_cost || 0)}</p>
          </div>
          <div className="card">
            <p className="text-xs text-[#8B7355] uppercase tracking-wide">Cost per Unit</p>
            <p className="text-xl font-bold text-[#af4408] mt-1">{formatCurrency(sr.cost_per_unit || 0)}</p>
          </div>
        </div>

        <div className="card">
          <h2 className="text-lg font-semibold text-[#2D1B0E] mb-4 flex items-center gap-2">
            <Layers size={18} /> Ingredients ({sr.ingredients.length})
          </h2>
          {sr.ingredients.length === 0 ? (
            <p className="text-[#8B7355] text-sm">No ingredients.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[#8B7355] border-b border-[#E8D5C4]">
                    <th className="text-left py-2 px-2 font-medium">Material</th>
                    <th className="text-right py-2 px-2 font-medium">Qty</th>
                    <th className="text-left py-2 px-2 font-medium">Unit</th>
                    <th className="text-right py-2 px-2 font-medium">Yield%</th>
                    <th className="text-right py-2 px-2 font-medium">Wastage%</th>
                  </tr>
                </thead>
                <tbody>
                  {sr.ingredients.map((ing, i) => (
                    <tr key={i} className="border-b border-[#E8D5C4]/50 hover:bg-[#FFF1E3]/30">
                      <td className="py-2 px-2 text-[#3D2614]">{ing.material_name || ing.material_id}</td>
                      <td className="py-2 px-2 text-right text-[#6B5744]">{ing.quantity}</td>
                      <td className="py-2 px-2 text-[#8B7355]">{ing.unit}</td>
                      <td className="py-2 px-2 text-right text-[#6B5744]">{ing.yield_percent}%</td>
                      <td className="py-2 px-2 text-right text-[#6B5744]">{ing.wastage_percent}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ---- Main List View ----
  return (
    <div>
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3 mb-5">
        <div>
          <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">Dine-In</p>
          <h1 className="text-2xl sm:text-3xl font-bold text-[#2D1B0E] mt-0.5">Recipe Management</h1>
          <p className="text-sm text-[#8B7355] mt-1">Recipes, ingredients &amp; food costing</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {activeTab === 'main' && (
            <>
              <label
                className="flex items-center gap-2 border border-[#E0D0BE] bg-white text-[#6B5744] px-3 py-2 rounded-xl text-sm font-medium shadow-sm"
                title="Target food-cost %. Drives the suggested 'Menu Price @ Target' and the high-FC flag."
              >
                Target FC%
                <input
                  type="number" min={1} max={99} step={1}
                  value={Math.round(targetFcPct * 100)}
                  onChange={(e) => { const p = Number(e.target.value); if (p > 0 && p < 100) saveTargetFcPct(p / 100); }}
                  className="w-14 px-2 py-1 border border-[#E8D5C4] rounded-lg text-sm text-right"
                />
              </label>
              <HeaderMenu label="Import" icon={<FileSpreadsheet size={16} />} items={[
                { label: 'Import Recipe Workbook', icon: <FileSpreadsheet size={15} />, onClick: openWorkbookModal },
                { label: 'Import Bar Costing Excel', icon: <FileSpreadsheet size={15} />, onClick: openBarModal },
                { label: 'Bulk Upload (CSV)', icon: <Upload size={15} />, onClick: openBulkModal },
                { label: 'Download CSV Template', icon: <Download size={15} />, onClick: () => downloadTemplate(true) },
              ]} />
              <HeaderMenu label="Tools" icon={<RefreshCw size={16} />} items={[
                { label: 'Export Recipe Book', icon: <Download size={15} />, onClick: exportAllRecipes },
                { label: refreshing ? 'Refreshing…' : 'Refresh All Costs', icon: <RefreshCw size={15} />, onClick: refreshAllCosts, disabled: refreshing },
                { label: normalizing ? 'Restoring…' : 'Restore Prices from Purchases', icon: <AlertTriangle size={15} />, onClick: restorePrices, disabled: normalizing },
                { label: categorizing ? 'Categorising…' : 'Auto-categorise', icon: <Tags size={15} />, onClick: autoCategorize, disabled: categorizing },
                { label: 'Manage Categories', icon: <Pencil size={15} />, onClick: () => setCatModalOpen(true) },
              ]} />
            </>
          )}
          {/* Direct items aren't created manually — they're auto-discovered from
              sales and linked to a raw material in the panel below. So only show
              the Add buttons on the Recipes / Sub-Recipes tabs. BOTH buttons show
              on both tabs: a single tab-morphing button made "Add Sub-Recipe"
              undiscoverable (owners on the Main tab never saw it existed). */}
          {activeTab !== 'direct' && (
            <>
              <button
                onClick={openAddSubRecipe}
                className="flex items-center gap-2 bg-white border border-[#af4408]/50 text-[#af4408] hover:bg-[#af4408]/10 px-4 py-2.5 rounded-xl text-sm font-semibold shadow-sm transition-colors"
              >
                <Plus size={16} />
                Add Sub-Recipe
              </button>
              <button
                onClick={openAddRecipe}
                className="flex items-center gap-2 bg-[#af4408] hover:bg-[#8a3506] text-white px-4 py-2.5 rounded-xl text-sm font-semibold shadow-sm transition-colors"
              >
                <Plus size={16} />
                Add Recipe
              </button>
            </>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-6 border-b border-[#E8D5C4] mb-5 overflow-x-auto">
        {([['main', 'Main Recipes', recipes.length], ['sub', 'Sub-Recipes', subRecipes.length], ['direct', 'Direct Items', null]] as const).map(([key, label, count]) => (
          <button
            key={key}
            onClick={() => { setActiveTab(key as any); setSearchQuery(''); setCategoryFilter(''); }}
            className={`relative pb-3 -mb-px text-sm font-semibold whitespace-nowrap transition-colors ${activeTab === key ? 'text-[#af4408]' : 'text-[#8B7355] hover:text-[#3D2614]'}`}
          >
            {label}{count != null && <span className="font-normal opacity-70"> · {count}</span>}
            {activeTab === key && <span className="absolute left-0 right-0 -bottom-px h-0.5 bg-[#af4408] rounded-full" />}
          </button>
        ))}
      </div>

      {activeTab === 'direct' && (
        <DirectItemsPanel materials={materials} />
      )}

      {/* Stat bar + health (main tab only) */}
      {activeTab === 'main' && (
        <>
          <div className="bg-white border border-[#E8D5C4] rounded-2xl shadow-sm grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 overflow-hidden mb-3">
            <div className="px-4 py-3.5 border-r border-b lg:border-b-0 border-[#F0E4D6]">
              <p className="text-[10px] sm:text-[11px] text-[#8B7355] uppercase tracking-wide">Active Recipes</p>
              <p className="text-2xl font-bold text-[#2D1B0E] mt-1">{summaryStats.total}</p>
            </div>
            <div className="px-4 py-3.5 border-r border-b lg:border-b-0 border-[#F0E4D6]">
              <p className="text-[10px] sm:text-[11px] text-[#8B7355] uppercase tracking-wide">Avg Food Cost</p>
              <div className="flex items-baseline gap-2 mt-1 flex-wrap">
                <span className={`text-2xl font-bold ${foodCostColor(summaryStats.avgFoodCost)}`}>{summaryStats.avgFoodCost.toFixed(1)}%</span>
                {summaryStats.total > 0 && summaryStats.avgFoodCost > Math.round(targetFcPct * 100) && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-50 text-red-600 whitespace-nowrap">{Math.round(summaryStats.avgFoodCost - Math.round(targetFcPct * 100))} pts over {Math.round(targetFcPct * 100)}% target</span>
                )}
              </div>
            </div>
            <div className="px-4 py-3.5 border-r border-b lg:border-b-0 border-[#F0E4D6]">
              <p className="text-[10px] sm:text-[11px] text-[#8B7355] uppercase tracking-wide">Most Profitable</p>
              <p className="text-sm font-bold text-green-600 mt-1.5 truncate">{summaryStats.mostProfitable}{summaryStats.mostProfitableGpm ? <span className="text-[#8B7355] font-normal"> · GPM {summaryStats.mostProfitableGpm.toFixed(0)}%</span> : null}</p>
            </div>
            <div className="px-4 py-3.5 border-r border-b md:border-b-0 border-[#F0E4D6]">
              <p className="text-[10px] sm:text-[11px] text-[#8B7355] uppercase tracking-wide">Highest Food Cost</p>
              <p className="text-sm font-bold text-red-500 mt-1.5 truncate">{summaryStats.highestCost}{summaryStats.highestCostFc ? <span className="text-[#8B7355] font-normal"> · FC {summaryStats.highestCostFc.toFixed(0)}%</span> : null}</p>
            </div>
            <div className={`px-4 py-3.5 col-span-2 md:col-span-1 lg:col-span-1 ${summaryStats.issues.total > 0 ? 'bg-amber-50' : 'bg-green-50'}`}>
              <p className="text-[10px] sm:text-[11px] text-[#8B7355] uppercase tracking-wide flex items-center gap-1"><AlertTriangle className="w-3 h-3 text-amber-500" /> Needs Attention</p>
              <p className={`text-2xl font-bold mt-1 ${summaryStats.issues.total > 0 ? 'text-amber-700' : 'text-green-700'}`}>{summaryStats.issues.total}<span className="text-xs font-normal text-[#8B7355]"> {summaryStats.issues.total > 0 ? `of ${summaryStats.total}` : 'all good'}</span></p>
            </div>
          </div>

          {/* Recipe health banner */}
          {summaryStats.issues.total > 0 && (() => {
            const all = [
              { key: 'noPrice', label: 'missing selling price', count: summaryStats.issues.noPrice.length, tone: 'amber' },
              { key: 'lossMaking', label: 'loss-making', count: summaryStats.issues.lossMaking.length, tone: 'red' },
              { key: 'highFC', label: 'below 65% GPM', count: summaryStats.issues.highFC.length, tone: 'orange' },
              { key: 'noMenuLink', label: 'no menu link', count: summaryStats.issues.noMenuLink.length, tone: 'blue' },
              { key: 'noIngredients', label: 'no ingredients', count: summaryStats.issues.noIngredients.length, tone: 'red' },
              { key: 'suspicious', label: 'suspiciously cheap', count: summaryStats.issues.suspicious.length, tone: 'blue' },
              { key: 'zeroCost', label: 'cost ₹0', count: summaryStats.issues.zeroCost.length, tone: 'red' },
              { key: 'borderlineFC', label: 'borderline margin', count: summaryStats.issues.borderlineFC.length, tone: 'amber' },
              { key: 'noCategory', label: 'missing category', count: summaryStats.issues.noCategory.length, tone: 'gray' },
              { key: 'priceless_ingredients', label: 'ingredient never purchased', count: summaryStats.issues.pricelessIngredients.length, tone: 'orange' },
            ].filter(x => x.count > 0);
            const shown = showAllIssues ? all : all.slice(0, 4);
            return (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 mb-5">
                <span className="flex items-center gap-2 text-sm font-semibold text-amber-900"><AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" /> Recipe health</span>
                <div className="flex flex-wrap items-center gap-2">
                  {shown.map(x => <HealthPill key={x.key} label={x.label} count={x.count} tone={x.tone} active={issueFilter === x.key} onClick={() => setIssueFilter(issueFilter === x.key ? null : x.key)} />)}
                  {!showAllIssues && all.length > 4 && (
                    <button onClick={() => setShowAllIssues(true)} className="text-xs font-medium text-[#6B5744] hover:underline">+{all.length - 4} more</button>
                  )}
                </div>
                <button onClick={() => setIssueFilter(issueFilter ? null : 'anyIssue')} className="ml-auto text-sm font-medium text-[#af4408] hover:underline whitespace-nowrap">{issueFilter ? 'Clear filter' : 'Review all →'}</button>
              </div>
            );
          })()}
        </>
      )}

      {/* Search + Filter + Sort */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8B7355]" size={18} />
          <input
            type="text"
            placeholder={`Search ${activeTab === 'main' ? 'recipes' : 'sub-recipes'}...`}
            className="w-full bg-white border border-[#E8D5C4] rounded-lg pl-10 pr-4 py-2.5 text-sm text-[#2D1B0E] placeholder-[#8B7355] focus:outline-none focus:border-[#af4408] transition-colors"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        {activeTab === 'main' && (
          <>
            {/* Category filter dropdown — works even when chips are too many */}
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="bg-white border border-[#E8D5C4] rounded-lg px-3 py-2.5 text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408] transition-colors"
              title="Filter by category"
            >
              <option value="">All categories ({recipeCategories.length})</option>
              {recipeCategories.map((c) => <option key={c} value={c}>{c}</option>)}
              {recipes.some((r) => !r.category || !r.category.trim()) && <option value={UNCAT}>Uncategorised</option>}
            </select>
            {/* Sort */}
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortKey)}
              className="bg-white border border-[#E8D5C4] rounded-lg px-3 py-2.5 text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408] transition-colors"
              title="Sort recipes"
            >
              <option value="category">Sort: Category (A–Z)</option>
              <option value="name">Sort: Name (A–Z)</option>
              <option value="fcDesc">Sort: Food Cost % (high → low)</option>
              <option value="fcAsc">Sort: Food Cost % (low → high)</option>
              <option value="costDesc">Sort: Cost (high → low)</option>
              <option value="priceDesc">Sort: Price (high → low)</option>
            </select>
            {/* Cookbook: list ⇄ photo-gallery toggle */}
            <div className="flex items-center rounded-lg border border-[#E8D5C4] overflow-hidden bg-white shrink-0" role="group" aria-label="Recipe view">
              <button
                type="button"
                onClick={() => setRecipeView('list')}
                aria-pressed={recipeView === 'list'}
                title="List view"
                className={`flex items-center gap-1 px-3 py-2.5 text-sm transition-colors ${recipeView === 'list' ? 'bg-[#af4408] text-white' : 'text-[#6B5744] hover:bg-[#FFF1E3]'}`}
              >
                <ListIcon size={16} /> <span className="hidden sm:inline">List</span>
              </button>
              <button
                type="button"
                onClick={() => setRecipeView('gallery')}
                aria-pressed={recipeView === 'gallery'}
                title="Gallery view"
                className={`flex items-center gap-1 px-3 py-2.5 text-sm transition-colors ${recipeView === 'gallery' ? 'bg-[#af4408] text-white' : 'text-[#6B5744] hover:bg-[#FFF1E3]'}`}
              >
                <LayoutGrid size={16} /> <span className="hidden sm:inline">Gallery</span>
              </button>
            </div>
          </>
        )}
      </div>

      {/* Active category filter pill (chips row removed — the dropdown above is
          the single, decluttered category control) */}
      {activeTab === 'main' && (categoryFilter || issueFilter) && (
        <div className="flex flex-wrap items-center gap-2 mb-1">
          {categoryFilter && (
            <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-[#af4408] text-white">
              {categoryFilter === UNCAT ? 'Uncategorised' : categoryFilter}
              <button onClick={() => setCategoryFilter('')} aria-label="Clear category" className="hover:opacity-80"><X size={12} /></button>
            </span>
          )}
          {issueFilter && (
            <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-amber-500 text-white">
              Health filter
              <button onClick={() => setIssueFilter(null)} aria-label="Clear health filter" className="hover:opacity-80"><X size={12} /></button>
            </span>
          )}
        </div>
      )}

      {/* ---- Main Recipes Grid ---- */}
      {activeTab === 'main' && (
        <>
          {filteredRecipes.length === 0 ? (
            <div className="card text-center py-12">
              <ChefHat className="w-12 h-12 text-[#D4B896] mx-auto mb-3" />
              <p className="text-[#8B7355]">No recipes found.</p>
              <button onClick={openAddRecipe} className="mt-3 text-[#af4408] hover:text-[#8a3506] text-sm font-medium">
                + Add your first recipe
              </button>
            </div>
          ) : recipeView === 'gallery' ? (
            /* ---- Cookbook photo-card gallery ---- */
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {filteredRecipes.map((recipe) => {
                const fcp = recipe.food_cost_percent || 0;
                const link = menuLinkMap.get(recipe.id);
                const isLinked = !!link && link.count > 0;
                const allg = recipe.allergens || [];
                return (
                  // Card is a real <article> so the recipe name stays an <h3> heading
                  // (matches List view for screen-reader heading nav); a stretched-link
                  // <button> overlay makes the whole card clickable without nesting flow
                  // content inside a <button>.
                  <article
                    key={recipe.id}
                    className="group relative text-left rounded-xl overflow-hidden border border-[#E8D5C4] bg-white hover:shadow-lg hover:border-[#af4408]/40 focus-within:ring-2 focus-within:ring-[#af4408]/40 transition-all flex flex-col"
                  >
                    {/* Photo (placeholder sits behind so a broken image simply reveals it) */}
                    <div className="relative h-36 sm:h-40 bg-gradient-to-br from-[#FFE9D5] to-[#F0D2B4] flex items-center justify-center overflow-hidden">
                      <ChefHat className="text-[#D9A679]" size={40} />
                      {recipe.image_url && (
                        // key on the URL → a corrected URL remounts a fresh <img> (so a
                        // previously error-hidden photo re-appears without a reload).
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          key={recipe.image_url}
                          src={recipe.image_url}
                          alt=""
                          className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                        />
                      )}
                      <span className={`absolute bottom-2 left-2 text-[11px] font-bold px-2 py-0.5 rounded-full shadow-sm ${foodCostBg(fcp)}`}>
                        {fcp.toFixed(0)}% FC
                      </span>
                      {isLinked
                        ? <span className="absolute top-2 right-2 bg-emerald-500 text-white rounded-full p-1 shadow-sm" title="Linked to menu"><CheckCircle2 size={12} /></span>
                        : <span className="absolute top-2 right-2 bg-amber-400 text-white rounded-full p-1 shadow-sm" title="No menu link"><AlertTriangle size={12} /></span>}
                    </div>
                    {/* Body */}
                    <div className="p-3 flex flex-col gap-1.5 flex-1">
                      <h3 className="text-sm font-semibold text-[#2D1B0E] line-clamp-2 leading-snug">{recipe.name}</h3>
                      <div className="flex items-center justify-between text-xs text-[#8B7355]">
                        <span>{recipe.category || 'Uncategorised'}</span>
                        <span className="font-medium text-[#3D2614]">{formatCurrency(recipe.selling_price || 0)}</span>
                      </div>
                      {allg.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-0.5" title={`Contains (auto-detected): ${allg.map(allergenLabel).join(', ')}`}>
                          {allg.slice(0, 6).map((k) => (
                            <span key={k} className="text-[13px] leading-none" aria-label={allergenLabel(k)}>{allergenEmoji(k)}</span>
                          ))}
                          {allg.length > 6 && <span className="text-[10px] text-[#8B7355]">+{allg.length - 6}</span>}
                        </div>
                      )}
                    </div>
                    {/* Stretched-link overlay: whole-card click target, name as its label */}
                    <button
                      type="button"
                      onClick={() => { setSelectedRecipe(recipe); setScaleTo(1); }}
                      aria-label={`Open ${recipe.name}`}
                      className="absolute inset-0 w-full h-full rounded-xl focus:outline-none"
                    />
                  </article>
                );
              })}
            </div>
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden md:block bg-white border border-[#E8D5C4] rounded-2xl shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-[11px] uppercase tracking-wide text-[#8B7355] border-b border-[#E8D5C4] bg-[#FFF8F0]">
                        <th className="text-left py-3 px-4 font-semibold">Recipe</th>
                        <th className="text-left py-3 px-3 font-semibold">Category</th>
                        <th className="text-left py-3 px-3 font-semibold">Menu Link</th>
                        <th className="text-right py-3 px-3 font-semibold">Sell ₹</th>
                        <th className="text-right py-3 px-3 font-semibold">Cost ₹</th>
                        <th className="text-left py-3 px-3 font-semibold w-56">FC% vs target {Math.round(targetFcPct * 100)}</th>
                        <th className="text-right py-3 px-3 font-semibold">GPM</th>
                        <th className="w-10" aria-label="Actions"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedRecipes.map((recipe) => {
                        const fcp = recipe.food_cost_percent || 0;
                        const gpm = recipe.selling_price > 0 ? ((recipe.selling_price - recipe.total_cost) / recipe.selling_price) * 100 : null;
                        const link = menuLinkMap.get(recipe.id);
                        const isLinked = !!link && link.count > 0;
                        const noPrice = !recipe.selling_price;
                        const ingCount = recipe.ingredients?.length || 0;
                        return (
                          <tr key={recipe.id} className="border-b border-[#F0E4D6] last:border-0 hover:bg-[#FFF8F0]">
                            <td className="py-2.5 px-4">
                              <p className="font-semibold text-[#2D1B0E] text-[13px] truncate max-w-[280px]">{recipe.name}</p>
                              <p className="text-[11px] text-[#8B7355]">v{recipe.version} · {ingCount} ingredient{ingCount === 1 ? '' : 's'}</p>
                            </td>
                            <td className="py-2.5 px-3 text-[13px] text-[#3D2614]">
                              <CategoryChip
                                value={recipe.category || ''}
                                categories={recipeCategories}
                                onPick={(c) => quickSetCategory(recipe.id, c)}
                              />
                            </td>
                            <td className="py-2.5 px-3">
                              {isLinked
                                ? <span className="text-[11px] font-medium px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200" title={link!.names.slice(0, 4).join(' · ')}>Linked{link!.count > 1 ? ` ×${link!.count}` : ''}</span>
                                : noPrice
                                  ? <button onClick={() => openEditRecipe(recipe)} className="text-[11px] font-semibold px-2 py-0.5 rounded-md bg-[#af4408] text-white hover:bg-[#8a3506]">Set price</button>
                                  : <span className="text-[11px] font-medium px-2 py-0.5 rounded-md bg-amber-50 text-amber-700 border border-amber-200">Not linked</span>}
                            </td>
                            <td className="py-2.5 px-3 text-right font-semibold text-[#2D1B0E]">{noPrice ? <span className="text-red-400 font-normal">—</span> : formatCurrency(recipe.selling_price)}</td>
                            <td className="py-2.5 px-3 text-right text-[#6B5744]">{formatCurrency(recipe.total_cost || 0)}</td>
                            <td className="py-2.5 px-3">
                              {noPrice
                                ? <span className="text-xs text-[#8B7355]">— needs selling price</span>
                                : <div className="flex items-center gap-2"><FcBar fc={fcp} target={Math.round(targetFcPct * 100)} /><span className={`text-xs font-bold shrink-0 ${foodCostColor(fcp)}`}>{fcp.toFixed(0)}%</span></div>}
                            </td>
                            <td className="py-2.5 px-3 text-right font-bold">{gpm == null ? <span className="text-[#C4B09A]">—</span> : <span className={gpm >= 65 ? 'text-green-600' : gpm >= 50 ? 'text-amber-600' : 'text-red-500'}>{gpm.toFixed(0)}%</span>}</td>
                            <td className="py-2.5 px-2 text-center whitespace-nowrap">
                              {/* Visible pencil first — Edit hidden behind ⋮ alone kept
                                  getting reported as "there is no edit option". */}
                              <button onClick={() => openEditRecipe(recipe)} title="Edit recipe"
                                      className="p-1.5 rounded-lg text-[#af4408] hover:bg-[#af4408]/10 align-middle">
                                <Edit size={15} />
                              </button>
                              <RRowMenu items={[
                                { label: 'View', icon: <Eye size={14} />, onClick: () => { setSelectedRecipe(recipe); setScaleTo(1); } },
                                { label: 'Edit', icon: <Edit size={14} />, onClick: () => openEditRecipe(recipe) },
                                { label: 'Copy', icon: <Copy size={14} />, onClick: () => openCopyRecipe(recipe) },
                              ]} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Mobile cards */}
              <div className="md:hidden space-y-2.5">
                {pagedRecipes.map((recipe) => {
                  const fcp = recipe.food_cost_percent || 0;
                  const gpm = recipe.selling_price > 0 ? ((recipe.selling_price - recipe.total_cost) / recipe.selling_price) * 100 : null;
                  const link = menuLinkMap.get(recipe.id);
                  const isLinked = !!link && link.count > 0;
                  const noPrice = !recipe.selling_price;
                  const ingCount = recipe.ingredients?.length || 0;
                  return (
                    <div key={recipe.id} className="bg-white border border-[#E8D5C4] rounded-2xl p-3 shadow-sm">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-semibold text-[#2D1B0E] text-sm leading-snug">{recipe.name}</p>
                          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                            <CategoryChip
                              value={recipe.category || ''}
                              categories={recipeCategories}
                              onPick={(c) => quickSetCategory(recipe.id, c)}
                            />
                            <span className="text-[11px] text-[#8B7355]">v{recipe.version} · {ingCount} ingredient{ingCount === 1 ? '' : 's'}</span>
                          </div>
                        </div>
                        <div className="flex items-center shrink-0">
                          <button onClick={() => openEditRecipe(recipe)} title="Edit recipe"
                                  className="p-1.5 rounded-lg text-[#af4408] hover:bg-[#af4408]/10">
                            <Edit size={15} />
                          </button>
                          <RRowMenu items={[
                            { label: 'View', icon: <Eye size={14} />, onClick: () => { setSelectedRecipe(recipe); setScaleTo(1); } },
                            { label: 'Edit', icon: <Edit size={14} />, onClick: () => openEditRecipe(recipe) },
                            { label: 'Copy', icon: <Copy size={14} />, onClick: () => openCopyRecipe(recipe) },
                          ]} />
                        </div>
                      </div>
                      <div className="flex items-center flex-wrap gap-2 mt-2">
                        {isLinked
                          ? <span className="text-[11px] font-medium px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200">Linked{link!.count > 1 ? ` ×${link!.count}` : ''}</span>
                          : noPrice
                            ? <button onClick={() => openEditRecipe(recipe)} className="text-[11px] font-semibold px-2 py-0.5 rounded-md bg-[#af4408] text-white">Set price</button>
                            : <span className="text-[11px] font-medium px-2 py-0.5 rounded-md bg-amber-50 text-amber-700 border border-amber-200">Not linked</span>}
                        <span className="ml-auto font-bold text-[#2D1B0E]">{noPrice ? <span className="text-red-400">—</span> : formatCurrency(recipe.selling_price)}</span>
                      </div>
                      <div className="flex items-center justify-between mt-2 pt-2 border-t border-[#F0E4D6] text-[11px] text-[#8B7355]">
                        <span>Cost {formatCurrency(recipe.total_cost || 0)}</span>
                        {!noPrice && (
                          <span className="flex items-center gap-2">
                            <span className={`font-bold ${foodCostColor(fcp)}`}>FC {fcp.toFixed(0)}%</span>
                            {gpm != null && <span className={`font-bold ${gpm >= 65 ? 'text-green-600' : gpm >= 50 ? 'text-amber-600' : 'text-red-500'}`}>GPM {gpm.toFixed(0)}%</span>}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* Pagination (list view only; gallery shows all) */}
          {recipeView === 'list' && filteredRecipes.length > 0 && (
            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 mt-4">
              <p className="text-xs text-[#8B7355]">Showing {(recipeSafePage - 1) * R_PAGE_SIZE + 1}–{Math.min(recipeSafePage * R_PAGE_SIZE, filteredRecipes.length)} of {filteredRecipes.length} recipes</p>
              <RPagination page={recipeSafePage} pageCount={recipePageCount} onPage={setRecipePage} />
            </div>
          )}
        </>
      )}

      {/* ---- Sub-Recipes Grid ---- */}
      {activeTab === 'sub' && (
        <>
          {filteredSubRecipes.length === 0 ? (
            <div className="card text-center py-12">
              <Layers className="w-12 h-12 text-[#D4B896] mx-auto mb-3" />
              <p className="text-[#8B7355]">No sub-recipes found.</p>
              <button onClick={openAddSubRecipe} className="mt-3 text-[#af4408] hover:text-[#8a3506] text-sm font-medium">
                + Add your first sub-recipe
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredSubRecipes.map((sr) => (
                <div key={sr.id} className="card card-hover flex flex-col">
                  <div className="mb-3">
                    <h3 className="text-lg font-semibold text-[#2D1B0E] truncate">{sr.name}</h3>
                    <div className="flex items-center gap-2 mt-1">
                      <CategoryChip
                        value={sr.category || ''}
                        categories={subRecipeCategories}
                        onPick={(c) => quickSetSubCategory(sr.id, c)}
                      />
                      <span className="text-xs text-[#8B7355]">v{sr.version}</span>
                    </div>
                  </div>

                  <div className="space-y-2 flex-1">
                    <div className="flex justify-between text-sm">
                      <span className="text-[#8B7355]">Yield</span>
                      <span className="text-[#3D2614] font-medium">{sr.yield_quantity} {sr.yield_unit}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-[#8B7355]">Cost per unit</span>
                      <span className="text-[#af4408] font-medium">{formatCurrency(sr.cost_per_unit || 0)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-[#8B7355]">Total Cost</span>
                      <span className="text-[#3D2614] font-medium">{formatCurrency(sr.total_cost || 0)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-[#8B7355]">Ingredients</span>
                      <span className="text-[#6B5744]">{sr.ingredients.length}</span>
                    </div>
                  </div>

                  <div className="flex gap-2 mt-4 pt-3 border-t border-[#E8D5C4]">
                    <button
                      onClick={() => setSelectedSubRecipe(sr)}
                      className="flex-1 flex items-center justify-center gap-1.5 bg-[#FFF1E3] hover:bg-[#FFF1E3] text-[#6B5744] hover:text-[#2D1B0E] px-3 py-2 rounded-lg text-sm transition-colors"
                    >
                      <Eye size={15} /> View
                    </button>
                    <button
                      onClick={() => openEditSubRecipe(sr)}
                      className="flex-1 flex items-center justify-center gap-1.5 bg-[#af4408]/15 hover:bg-[#af4408]/25 text-[#af4408] px-3 py-2 rounded-lg text-sm transition-colors"
                    >
                      <Edit size={15} /> Edit
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ================================================================= */}
      {/* ADD / EDIT RECIPE MODAL */}
      {/* ================================================================= */}
      {showRecipeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white border border-[#E8D5C4] rounded-xl w-full max-w-4xl max-h-[90vh] flex flex-col">
            {/* Modal header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8D5C4] shrink-0">
              <h2 className="text-lg font-bold text-[#2D1B0E]">
                {editingRecipe ? 'Edit Recipe' : 'Add New Recipe'}
              </h2>
              <button
                onClick={() => setShowRecipeModal(false)}
                className="text-[#8B7355] hover:text-[#3D2614] transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            {/* Modal body - scrollable */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
              {/* Menu item picker — auto-fills name + category + price */}
              <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3 space-y-2">
                <label className="block text-sm text-[#6B5744]">
                  <span className="font-semibold text-[#2D1B0E]">Pick from Menu Items</span>
                  <span className="ml-2 text-xs text-[#8B7355]">
                    (optional — typing a new name is fine for sub-recipes or un-listed items)
                  </span>
                </label>
                <MenuItemAutocomplete
                  value={formName}
                  menuItems={menuItems}
                  formMenuItemId={formMenuItemId}
                  formPosItemId={formPosItemId}
                  onTextChange={(typed) => {
                    setFormName(typed);
                    // Drop the link as soon as the user starts editing
                    setFormMenuItemId('');
                    setFormPosItemId('');
                  }}
                  onPick={(picked) => {
                    setFormName(picked.name);
                    setFormMenuItemId(picked.id);
                    setFormPosItemId(picked.item_code || '');
                    if (picked.category) setFormCategory(picked.category);
                    if (picked.selling_price && !formSellingPrice) setFormSellingPrice(picked.selling_price);
                  }}
                />
              </div>

              {/* Basic fields */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 sm:gap-4">
                <div>
                  <label className="block text-sm text-[#6B5744] mb-1">Recipe Name *</label>
                  <input
                    type="text"
                    className="w-full bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2.5 text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    placeholder="e.g. Butter Chicken"
                  />
                </div>
                <div>
                  <label className="block text-sm text-[#6B5744] mb-1">Category</label>
                  <input
                    type="text"
                    list="recipe-category-options"
                    className="w-full bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2.5 text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
                    value={formCategory}
                    onChange={(e) => setFormCategory(e.target.value)}
                    placeholder="Pick or type a category"
                  />
                  <datalist id="recipe-category-options">
                    {recipeCategories.map((c) => <option key={c} value={c} />)}
                  </datalist>
                  <p className="mt-1 text-[11px] text-[#8B7355]">Pick an existing category to keep filters tidy, or type a new one.</p>
                </div>
                <div>
                  <label className="block text-sm text-[#6B5744] mb-1">Selling Price (&#8377;)</label>
                  <input
                    type="number"
                    step="any"
                    className="w-full bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2.5 text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
                    value={formSellingPrice || ''}
                    onChange={(e) => setFormSellingPrice(parseFloat(e.target.value) || 0)}
                  />
                </div>
              </div>

              {/* Cookbook: photo + cooking method */}
              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-[#6B5744] mb-1">Photo URL (optional)</label>
                  <input
                    type="url"
                    className="w-full bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2.5 text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
                    value={formImageUrl}
                    onChange={(e) => setFormImageUrl(e.target.value)}
                    placeholder="https://…/dish.jpg"
                  />
                  {formImageUrl.trim() && (
                    // key on the URL → a corrected URL remounts a fresh <img>
                    // (so a previously-hidden broken preview re-appears).
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={formImageUrl} src={formImageUrl} alt="recipe" className="mt-2 h-24 w-full object-cover rounded-lg border border-[#E8D5C4]"
                         onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                  )}
                </div>
                <div>
                  <label className="block text-sm text-[#6B5744] mb-1">Method / Instructions</label>
                  <textarea
                    rows={4}
                    className="w-full bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2.5 text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408] resize-y"
                    value={formInstructions}
                    onChange={(e) => setFormInstructions(e.target.value)}
                    placeholder={'1. Prep…\n2. Cook…\n3. Plate…'}
                  />
                </div>
              </div>

              {/* Ingredients */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-[#3D2614] flex items-center gap-2">
                    <Layers size={16} /> Ingredients
                  </h3>
                  <button
                    type="button"
                    onClick={() => addFormIngredient(setFormIngredients)}
                    className="flex items-center gap-1 text-xs text-[#af4408] hover:text-[#8a3506] font-medium"
                  >
                    <Plus size={14} /> Add Ingredient
                  </button>
                </div>
                {formIngredients.length === 0 ? (
                  <p className="text-sm text-[#8B7355]">No ingredients yet. Click &quot;Add Ingredient&quot; to begin.</p>
                ) : (
                  <div className="overflow-x-auto">
                    {renderIngredientRows(formIngredients, setFormIngredients)}
                  </div>
                )}
              </div>

              {/* Sub-recipes */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-[#3D2614] flex items-center gap-2">
                    <ChefHat size={16} /> Sub-Recipes
                  </h3>
                  <button
                    type="button"
                    onClick={addFormSubRecipe}
                    className="flex items-center gap-1 text-xs text-[#af4408] hover:text-[#8a3506] font-medium"
                  >
                    <Plus size={14} /> Add Sub-Recipe
                  </button>
                </div>
                {formSubRecipes.length === 0 ? (
                  <p className="text-sm text-[#8B7355]">No sub-recipes yet.</p>
                ) : (
                  formSubRecipes.map((sr, idx) => (
                    <div key={idx} className="grid grid-cols-12 gap-2 items-end mb-2">
                      <div className="col-span-5">
                        {idx === 0 && <label className="block text-xs text-[#8B7355] mb-1">Sub-Recipe</label>}
                        <select
                          className="w-full bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-2 py-2 text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
                          value={sr.sub_recipe_id}
                          onChange={(e) => updateFormSubRecipe(idx, 'sub_recipe_id', e.target.value)}
                        >
                          <option value="">Select...</option>
                          {subRecipes.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name} ({formatCurrency(s.cost_per_unit || 0)}/{s.yield_unit})
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="col-span-2">
                        {idx === 0 && <label className="block text-xs text-[#8B7355] mb-1">Qty</label>}
                        <input
                          type="number"
                          step="any"
                          className="w-full bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-2 py-2 text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
                          value={sr.quantity || ''}
                          onChange={(e) => updateFormSubRecipe(idx, 'quantity', parseFloat(e.target.value) || 0)}
                        />
                      </div>
                      <div className="col-span-2">
                        {idx === 0 && <label className="block text-xs text-[#8B7355] mb-1">Unit</label>}
                        {/* Unit is locked to the sub-recipe's yield unit: cost math is
                            quantity × cost_per_unit (₹ per yield_unit), no conversion. */}
                        <div className="w-full bg-[#FFF1E3]/60 border border-[#D4B896] rounded-lg px-2 py-2 text-sm text-[#8B7355]">
                          {subRecipes.find((s) => s.id === sr.sub_recipe_id)?.yield_unit || sr.unit || '—'}
                        </div>
                      </div>
                      <div className="col-span-2 flex items-center gap-2">
                        <span className="text-xs text-[#8B7355]">
                          {(() => {
                            const sub = subRecipes.find((s) => s.id === sr.sub_recipe_id);
                            if (!sub) return '-';
                            return formatCurrency(sr.quantity * (sub.cost_per_unit || 0));
                          })()}
                        </span>
                      </div>
                      <div className="col-span-1 flex items-center">
                        <button
                          type="button"
                          onClick={() => removeFormSubRecipe(idx)}
                          className="text-red-400 hover:text-red-300 p-1"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* Live Cost Calculator */}
              <div className="bg-[#FFF1E3]/50 border border-[#D4B896] rounded-lg p-4">
                <h3 className="text-sm font-semibold text-[#3D2614] flex items-center gap-2 mb-3">
                  <Calculator size={16} /> Live Cost Calculator
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-center">
                  <div>
                    <p className="text-xs text-[#8B7355] uppercase">Total Cost</p>
                    <p className="text-lg font-bold text-[#2D1B0E] mt-1">{formatCurrency(liveRecipeCost.totalCost)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-[#8B7355] uppercase">Profit</p>
                    <p className={`text-lg font-bold mt-1 ${liveRecipeCost.profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {formatCurrency(liveRecipeCost.profit)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-[#8B7355] uppercase">Food Cost %</p>
                    <p className={`text-lg font-bold mt-1 ${foodCostColor(liveRecipeCost.foodCostPct)}`}>
                      {liveRecipeCost.foodCostPct.toFixed(1)}%
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-[#8B7355] uppercase">GPM %</p>
                    {(() => {
                      const gpm = formSellingPrice > 0 ? 100 - liveRecipeCost.foodCostPct : 0;
                      const cls = formSellingPrice === 0 ? 'text-[#8B7355]' :
                                  gpm >= 80 ? 'text-green-600' :
                                  gpm >= 65 ? 'text-amber-600' :
                                              'text-red-600';
                      return <p className={`text-lg font-bold mt-1 ${cls}`}>
                        {formSellingPrice > 0 ? gpm.toFixed(1) + '%' : '—'}
                      </p>;
                    })()}
                    {formSellingPrice > 0 && liveRecipeCost.foodCostPct > targetFcPct * 100 && (
                      <p className="text-[10px] text-red-600 mt-0.5">⚠ Above {Math.round(targetFcPct * 100)}% target</p>
                    )}
                  </div>
                </div>

                {/* Suggested menu price at the target food-cost % (like the workbook's "Menu Price @ Target") */}
                {liveRecipeCost.totalCost > 0 && (
                  <div className="mt-3 pt-3 border-t border-[#D4B896] flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="text-[#6B5744]">
                      Menu Price @ {Math.round(targetFcPct * 100)}% target:{' '}
                      <strong className="text-[#af4408]">{formatCurrency(liveRecipeCost.totalCost / targetFcPct)}</strong>
                    </span>
                    {formSellingPrice > 0 && liveRecipeCost.totalCost > formSellingPrice && (
                      <span className="text-[11px] font-medium text-red-600 bg-red-500/10 px-2 py-0.5 rounded">
                        ⚠ Loss-making — cost exceeds menu price
                      </span>
                    )}
                    {formSellingPrice === 0 && (
                      <button
                        type="button"
                        onClick={() => setFormSellingPrice(Math.round(liveRecipeCost.totalCost / targetFcPct))}
                        className="text-[11px] font-medium text-[#af4408] hover:underline"
                      >
                        Use suggested price →
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Modal footer */}
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[#E8D5C4] shrink-0">
              <button
                onClick={() => setShowRecipeModal(false)}
                className="px-4 py-2 text-sm text-[#8B7355] hover:text-[#3D2614] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveRecipe}
                disabled={saving || !formName.trim()}
                className="flex items-center gap-2 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 disabled:cursor-not-allowed text-white px-5 py-2 rounded-lg text-sm font-medium transition-colors"
              >
                {saving && <Loader2 size={16} className="animate-spin" />}
                {editingRecipe ? 'Update Recipe' : 'Create Recipe'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================================================================= */}
      {/* COPY / DUPLICATE RECIPE MODAL                                      */}
      {/* Use case: split "Manchow Soup Veg / Non Veg" into two real recipes. */}
      {/* ================================================================= */}
      {copyFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
             onClick={() => !copySaving && setCopyFor(null)}>
          <div className="bg-white border border-[#E8D5C4] rounded-xl w-full max-w-lg flex flex-col"
               onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8D5C4]">
              <h2 className="text-lg font-semibold text-[#2D1B0E] flex items-center gap-2">
                <Copy size={18} className="text-blue-700" /> Copy Recipe
              </h2>
              <button onClick={() => setCopyFor(null)} disabled={copySaving}
                      className="text-[#8B7355] hover:text-[#2D1B0E]"><X size={20} /></button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-xs text-blue-800">
                Copying <strong>{copyFor.name}</strong> · {copyFor.selling_price > 0 ? `₹${copyFor.selling_price}` : 'no price'} · cost ₹{Math.round(copyFor.total_cost || 0)}
                <div className="text-[10px] text-blue-700 mt-0.5">
                  Every ingredient + sub-recipe link will be copied. Edit either copy independently afterwards.
                </div>
              </div>

              {/* Rename original (for Veg / Non Veg split) */}
              <label className="flex items-start gap-2 text-sm text-[#2D1B0E]">
                <input type="checkbox" checked={copyDoRename}
                       onChange={e => setCopyDoRename(e.target.checked)}
                       className="mt-1" />
                <div className="flex-1">
                  <span className="font-medium">Also rename the original recipe</span>
                  <span className="block text-xs text-[#8B7355]">
                    Use this when splitting a dual-variant recipe (e.g. <em>Manchow Soup Veg / Non Veg</em>) into two.
                  </span>
                </div>
              </label>

              {copyDoRename && (
                <div>
                  <label className="block text-xs font-medium text-[#8B7355] mb-1">Rename original to</label>
                  <input type="text" value={copyOriginalName}
                         onChange={e => setCopyOriginalName(e.target.value)}
                         className="w-full bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2 text-sm" />
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-[#8B7355] mb-1">New copy name *</label>
                <input type="text" value={copyNewName} autoFocus
                       onChange={e => setCopyNewName(e.target.value)}
                       placeholder="e.g. Manchow Soup Non Veg"
                       className="w-full bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2 text-sm" />
              </div>

              <div>
                <label className="block text-xs font-medium text-[#8B7355] mb-1">Selling price for the copy (₹)</label>
                <input type="number" step="any" min={0} value={copyPrice}
                       onChange={e => setCopyPrice(Number(e.target.value) || 0)}
                       className="w-full bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2 text-sm font-mono" />
                <div className="text-[10px] text-[#8B7355] mt-0.5">Leave the same to keep parity; raise it for Non Veg variants.</div>
              </div>

              {/* Quick-set buttons for common Veg / Non Veg split */}
              <div className="flex flex-wrap gap-1.5 pt-1">
                <span className="text-[10px] text-[#8B7355] mr-1 self-center">Quick fill:</span>
                {['Veg', 'Non Veg', 'Chicken', 'Mutton', 'Prawn', 'Paneer', 'Fish'].map(tag => (
                  <button key={tag} type="button"
                          onClick={() => {
                            const base = copyFor.name.replace(/\s*\/.*$/, '').replace(/\s+(veg|non[\s-]?veg|chicken|prawn|mutton|paneer|fish)\b/i, '').trim();
                            setCopyNewName(`${base} ${tag}`);
                          }}
                          className="text-[10px] px-2 py-0.5 rounded-full bg-[#FFF1E3] hover:bg-[#F5EDE2] text-[#6B5744]">
                    {tag}
                  </button>
                ))}
              </div>

              {copyError && (
                <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700">{copyError}</div>
              )}
            </div>
            <div className="flex justify-end gap-2 px-6 py-3 border-t border-[#E8D5C4]">
              <button onClick={() => setCopyFor(null)} disabled={copySaving}
                      className="px-4 py-2 text-sm text-[#6B5744] hover:bg-[#FFF1E3] rounded-lg">Cancel</button>
              <button onClick={saveCopyRecipe} disabled={copySaving || !copyNewName.trim()}
                      className="flex items-center gap-1.5 px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-40">
                {copySaving ? <Loader2 size={14} className="animate-spin" /> : <Copy size={14} />}
                {copySaving ? 'Copying…' : copyDoRename ? 'Rename + Create Copy' : 'Create Copy'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================================================================= */}
      {/* ADD / EDIT SUB-RECIPE MODAL */}
      {/* ================================================================= */}
      {showSubRecipeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white border border-[#E8D5C4] rounded-xl w-full max-w-4xl max-h-[90vh] flex flex-col">
            {/* Modal header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8D5C4] shrink-0">
              <h2 className="text-lg font-bold text-[#2D1B0E]">
                {editingSubRecipe ? 'Edit Sub-Recipe' : 'Add New Sub-Recipe'}
              </h2>
              <button
                onClick={() => setShowSubRecipeModal(false)}
                className="text-[#8B7355] hover:text-[#3D2614] transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            {/* Modal body */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
                <div>
                  <label className="block text-sm text-[#6B5744] mb-1">Name *</label>
                  <input
                    type="text"
                    className="w-full bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2.5 text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
                    value={srFormName}
                    onChange={(e) => setSrFormName(e.target.value)}
                    placeholder="e.g. Tomato Gravy Base"
                  />
                </div>
                <div>
                  <label className="block text-sm text-[#6B5744] mb-1">Category</label>
                  <input
                    type="text"
                    list="subrecipe-category-options"
                    className="w-full bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2.5 text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
                    value={srFormCategory}
                    onChange={(e) => setSrFormCategory(e.target.value)}
                    placeholder="Pick or type a category"
                  />
                  <datalist id="subrecipe-category-options">
                    {[...new Set(subRecipes.map((s) => s.category).filter(Boolean))].sort().map((c) => <option key={c} value={c} />)}
                  </datalist>
                </div>
                <div>
                  <label className="block text-sm text-[#6B5744] mb-1">Yield Quantity</label>
                  <input
                    type="number"
                    step="any"
                    className="w-full bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2.5 text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
                    value={srFormYieldQty || ''}
                    onChange={(e) => setSrFormYieldQty(parseFloat(e.target.value) || 0)}
                  />
                </div>
                <div>
                  <label className="block text-sm text-[#6B5744] mb-1">Yield Unit</label>
                  <select
                    className="w-full bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2.5 text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
                    value={srFormYieldUnit}
                    onChange={(e) => setSrFormYieldUnit(e.target.value)}
                  >
                    <option value="kg">kg</option>
                    <option value="g">g</option>
                    <option value="l">l</option>
                    <option value="ml">ml</option>
                    <option value="pcs">pcs</option>
                    <option value="dozen">dozen</option>
                  </select>
                </div>
              </div>

              {/* Ingredients */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-[#3D2614] flex items-center gap-2">
                    <Layers size={16} /> Ingredients
                  </h3>
                  <button
                    type="button"
                    onClick={() => addFormIngredient(setSrFormIngredients)}
                    className="flex items-center gap-1 text-xs text-[#af4408] hover:text-[#8a3506] font-medium"
                  >
                    <Plus size={14} /> Add Ingredient
                  </button>
                </div>
                {srFormIngredients.length === 0 ? (
                  <p className="text-sm text-[#8B7355]">No ingredients yet. Click &quot;Add Ingredient&quot; to begin.</p>
                ) : (
                  <div className="overflow-x-auto">
                    {renderIngredientRows(srFormIngredients, setSrFormIngredients)}
                  </div>
                )}
              </div>

              {/* Live Cost */}
              <div className="bg-[#FFF1E3]/50 border border-[#D4B896] rounded-lg p-4">
                <h3 className="text-sm font-semibold text-[#3D2614] flex items-center gap-2 mb-3">
                  <Calculator size={16} /> Live Cost Calculator
                </h3>
                <div className="grid grid-cols-2 gap-4 text-center">
                  <div>
                    <p className="text-xs text-[#8B7355] uppercase">Total Cost</p>
                    <p className="text-lg font-bold text-[#2D1B0E] mt-1">{formatCurrency(liveSubRecipeCost.total)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-[#8B7355] uppercase">Cost per Unit</p>
                    <p className="text-lg font-bold text-[#af4408] mt-1">{formatCurrency(liveSubRecipeCost.costPerUnit)}</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Modal footer */}
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[#E8D5C4] shrink-0">
              <button
                onClick={() => setShowSubRecipeModal(false)}
                className="px-4 py-2 text-sm text-[#8B7355] hover:text-[#3D2614] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveSubRecipe}
                disabled={saving || !srFormName.trim()}
                className="flex items-center gap-2 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 disabled:cursor-not-allowed text-white px-5 py-2 rounded-lg text-sm font-medium transition-colors"
              >
                {saving && <Loader2 size={16} className="animate-spin" />}
                {editingSubRecipe ? 'Update Sub-Recipe' : 'Create Sub-Recipe'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* ========================================================= */}
      {/* BAR COSTING EXCEL IMPORTER (3-sheet specialized)          */}
      {/* ========================================================= */}
      {barModalOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-6 pb-6 overflow-y-auto">
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setBarModalOpen(false)} />
          <div className="relative w-full max-w-5xl bg-white rounded-2xl shadow-xl border border-[#E8D5C4] mx-4">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8D5C4] sticky top-0 bg-white rounded-t-2xl z-20">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-purple-100">
                  <FileSpreadsheet className="w-5 h-5 text-purple-600" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-[#2D1B0E]">Import Bar Costing Excel</h2>
                  <p className="text-xs text-[#8B7355]">Auto-imports raw materials + recipes from 3-sheet Bar Costing format</p>
                </div>
              </div>
              <button onClick={() => setBarModalOpen(false)} className="p-1 text-[#8B7355] hover:text-[#2D1B0E]"><X className="w-5 h-5" /></button>
            </div>

            <div className="px-6 py-5 space-y-4">
              {/* Instructions */}
              <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-xl p-4 text-sm">
                <p className="font-medium text-[#6B5744] mb-2">This importer will:</p>
                <ul className="list-disc list-inside space-y-1 text-[#6B5744] text-xs">
                  <li><strong>Liquor Raw</strong> → Create/update raw materials with purchase rates (auto-calculates cost per ml/g)</li>
                  <li><strong>Receipe</strong> → Create recipes with ingredients (auto-fixes broken 45,000+ quantities)</li>
                  <li><strong>BAR PRODUCTS</strong> → Matches selling prices to recipes by name</li>
                  <li>Normalizes units: BTL→ml, GMS→g, PINCH→g, DASHES→ml, TSPN→ml, LEAF→pcs, etc.</li>
                  <li>Fixes typos: VERMOTH→VERMOUTH, DECOCOTION→DECOCTION</li>
                  <li>Skips empty recipes (beer/wine sold as-is with no ingredients)</li>
                </ul>
              </div>

              {/* Drop zone */}
              <div
                onClick={() => barFileRef.current?.click()}
                className="border-2 border-dashed border-[#D4B896] hover:border-purple-600 hover:bg-purple-50/30 rounded-xl p-8 text-center cursor-pointer transition-colors"
              >
                <FileSpreadsheet className="w-10 h-10 text-purple-500 mx-auto mb-3" />
                <p className="text-[#6B5744] font-medium">{barFileName || 'Click to select Bar Costing.xlsx'}</p>
                <p className="text-xs text-[#8B7355] mt-1">Expects 3 sheets: Liquor Raw, Receipe, BAR PRODUCTS</p>
                <input
                  ref={barFileRef}
                  type="file"
                  accept=".xlsx,.xls"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleBarFile(f); }}
                  className="hidden"
                />
              </div>

              {/* Preview */}
              {barPreview && (
                <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 space-y-3">
                  <h3 className="text-sm font-semibold text-[#2D1B0E]">File Parsed Successfully ✓</h3>
                  <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
                    <StatBlock label="Materials" value={barPreview.materials} color="text-[#af4408]" />
                    <StatBlock label="Recipes" value={barPreview.recipes} color="text-purple-600" />
                    <StatBlock label="Recipe Lines" value={barPreview.recipe_lines} color="text-blue-500" />
                    <StatBlock label="Products" value={barPreview.products} color="text-green-600" />
                    <StatBlock label="With Price" value={barPreview.recipes_with_price} color="text-green-600" />
                    <StatBlock label="Broken Qty" value={barPreview.broken_quantities} color="text-red-500" />
                  </div>

                  {barPreview.broken_quantities > 0 && (
                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800 flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>
                        <strong>{barPreview.broken_quantities}</strong> ingredient rows have quantities &gt; 5,000 (Excel date-serial errors).
                        These will be auto-corrected with sensible defaults (mint/basil = 5g, cardamom/cloves = 2 pcs, cucumber = 50g, etc.)
                      </span>
                    </div>
                  )}

                  <label className="flex items-center gap-2 text-xs cursor-pointer">
                    <input type="checkbox" checked={barOverwrite} onChange={e => setBarOverwrite(e.target.checked)} className="accent-purple-600 w-4 h-4" />
                    <span className="text-[#6B5744]">Overwrite existing recipes with same name (recommended for re-import)</span>
                  </label>

                  <div className="flex gap-3">
                    <button
                      onClick={submitBarImport}
                      disabled={barImporting}
                      className="flex items-center gap-2 px-5 py-2.5 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
                    >
                      {barImporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                      {barImporting ? 'Importing...' : `Import ${barPreview.recipes} Recipes + ${barPreview.materials} Materials`}
                    </button>
                    <button
                      onClick={() => { setBarPreview(null); setBarPayload(null); setBarFileName(null); }}
                      className="px-4 py-2.5 bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm hover:bg-[#E8D5C4] transition-colors"
                    >
                      Clear
                    </button>
                  </div>
                </div>
              )}

              {/* Result */}
              {barResult && (
                <div className="space-y-3">
                  {barResult.error ? (
                    <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
                      <div className="flex items-start gap-2">
                        <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />
                        <div>
                          <p className="text-red-700 font-medium">Import failed</p>
                          <p className="text-red-600 text-xs mt-1">{barResult.error}</p>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
                        <div className="flex items-start gap-2 mb-2">
                          <CheckCircle className="w-5 h-5 text-green-600 shrink-0" />
                          <p className="text-green-700 font-medium">Import complete!</p>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                          {barResult.materials_created > 0 && <StatBlock label="Materials Created" value={barResult.materials_created} color="text-green-600" />}
                          {barResult.materials_price_updated > 0 && <StatBlock label="Prices Updated" value={barResult.materials_price_updated} color="text-blue-600" />}
                          {barResult.recipes_created > 0 && <StatBlock label="Recipes Created" value={barResult.recipes_created} color="text-green-600" />}
                          {barResult.recipes_updated > 0 && <StatBlock label="Recipes Updated" value={barResult.recipes_updated} color="text-blue-600" />}
                          {barResult.recipes_skipped_empty > 0 && <StatBlock label="Empty Skipped" value={barResult.recipes_skipped_empty} color="text-amber-600" />}
                          {barResult.recipes_skipped_exists > 0 && <StatBlock label="Already Exist" value={barResult.recipes_skipped_exists} color="text-amber-600" />}
                          {barResult.unit_conversions > 0 && <StatBlock label="Units Converted" value={barResult.unit_conversions} color="text-purple-600" />}
                          {barResult.fixes_applied?.length > 0 && <StatBlock label="Quantities Fixed" value={barResult.fixes_applied.length} color="text-red-500" />}
                        </div>
                      </div>

                      {barResult.fixes_applied?.length > 0 && (
                        <details className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs">
                          <summary className="cursor-pointer font-medium text-amber-800">
                            🔧 {barResult.fixes_applied.length} Auto-corrections Applied (click to expand)
                          </summary>
                          <div className="mt-2 max-h-48 overflow-y-auto bg-white rounded p-2 space-y-1">
                            {barResult.fixes_applied.map((fix: string, i: number) => (
                              <p key={i} className="text-amber-700">{fix}</p>
                            ))}
                          </div>
                        </details>
                      )}

                      {barResult.ingredients_not_matched?.length > 0 && (
                        <details className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs">
                          <summary className="cursor-pointer font-medium text-red-800">
                            ⚠️ {barResult.ingredients_not_matched.length} Ingredients Not Matched (click to expand)
                          </summary>
                          <div className="mt-2 max-h-48 overflow-y-auto bg-white rounded p-2 space-y-1">
                            {barResult.ingredients_not_matched.slice(0, 50).map((ing: string, i: number) => (
                              <p key={i} className="text-red-700">{ing}</p>
                            ))}
                            {barResult.ingredients_not_matched.length > 50 && (
                              <p className="text-red-500">...and {barResult.ingredients_not_matched.length - 50} more</p>
                            )}
                          </div>
                          <p className="mt-2 text-[10px] text-red-600">Tip: Add these materials to Raw Materials manually, then re-import.</p>
                        </details>
                      )}
                    </>
                  )}
                  <button onClick={() => setBarResult(null)} className="text-xs text-[#8B7355] hover:text-[#2D1B0E]">Dismiss</button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* FOOD-COSTING WORKBOOK IMPORT MODAL                        */}
      {/* ========================================================= */}
      {wbModalOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-6 pb-6 overflow-y-auto">
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setWbModalOpen(false)} />
          <div className="relative w-full max-w-5xl bg-white rounded-2xl shadow-xl border border-[#E8D5C4] mx-4">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8D5C4] sticky top-0 bg-white rounded-t-2xl z-20">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-[#af4408]/10">
                  <FileSpreadsheet className="w-5 h-5 text-[#af4408]" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-[#2D1B0E]">Import Recipe Workbook</h2>
                  <p className="text-xs text-[#8B7355]">Purchase Rates → Sub-Recipe Cards → Recipe Cost Cards → Recipe Summary</p>
                </div>
              </div>
              <button onClick={() => setWbModalOpen(false)} className="p-1 text-[#8B7355] hover:text-[#2D1B0E]"><X className="w-5 h-5" /></button>
            </div>

            <div className="px-6 py-5 space-y-4">
              <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-xl p-4 text-sm">
                <p className="font-medium text-[#6B5744] mb-2">This importer will:</p>
                <ul className="list-disc list-inside space-y-1 text-[#6B5744] text-xs">
                  <li><strong>Purchase Rates</strong> → create/update raw materials (₹ per base unit g/ml/pcs)</li>
                  <li><strong>Sub-Recipe Cards</strong> → sub-recipes with ingredients + cost/gram</li>
                  <li><strong>Recipe Cost Cards</strong> → recipes with ingredient lines and sub-recipe references</li>
                  <li><strong>Recipe Summary</strong> → menu price + target food-cost %</li>
                  <li>Recomputes every cost and validates against the workbook&apos;s food-cost column</li>
                </ul>
              </div>

              <div
                onClick={() => wbFileRef.current?.click()}
                className="border-2 border-dashed border-[#D4B896] hover:border-[#af4408] hover:bg-[#af4408]/5 rounded-xl p-8 text-center cursor-pointer transition-colors"
              >
                <FileSpreadsheet className="w-10 h-10 text-[#af4408] mx-auto mb-3" />
                <p className="text-[#6B5744] font-medium">{wbFileName || 'Click to select the Food-Costing .xlsx'}</p>
                <p className="text-xs text-[#8B7355] mt-1">{wbPreviewing ? 'Parsing…' : 'Sheets: Purchase Rates, Sub-Recipe Cards, Recipe Cost Cards, Recipe Summary'}</p>
                <input
                  ref={wbFileRef}
                  type="file"
                  accept=".xlsx,.xls"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleWorkbookFile(f); }}
                  className="hidden"
                />
              </div>

              {/* Preview */}
              {wbPreview && wbPreview.counts && (
                <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 space-y-3">
                  <h3 className="text-sm font-semibold text-[#2D1B0E]">File Parsed Successfully ✓ · Target FC {wbPreview.target_food_cost_pct ? Math.round(wbPreview.target_food_cost_pct * 100) + '%' : '—'}</h3>
                  <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
                    <StatBlock label="Materials (new)" value={wbPreview.counts.materials_new} color="text-[#af4408]" />
                    <StatBlock label="Sub-Recipes" value={wbPreview.counts.sub_recipes} color="text-purple-600" />
                    <StatBlock label="Recipes" value={wbPreview.counts.recipes} color="text-blue-600" />
                    <StatBlock label="Recipe Lines" value={wbPreview.counts.recipe_lines} color="text-blue-500" />
                    <StatBlock label="Matched" value={wbPreview.counts.ingredients_matched} color="text-green-600" />
                    <StatBlock label="Unmatched" value={wbPreview.counts.ingredients_unmatched} color="text-red-500" />
                  </div>

                  {wbPreview.counts.sub_in_sub_skipped > 0 && (
                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800 flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                      <span><strong>{wbPreview.counts.sub_in_sub_skipped}</strong> sub-recipe-within-sub-recipe references can&apos;t be modeled and will be skipped (those sub-recipes&apos; cost may be slightly low).</span>
                    </div>
                  )}

                  {wbPreview.unmatched_ingredients?.length > 0 && (
                    <details className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs">
                      <summary className="cursor-pointer font-medium text-red-800">⚠️ {wbPreview.counts.ingredients_unmatched} ingredient(s) won&apos;t cost until matched (click to expand)</summary>
                      <div className="mt-2 max-h-40 overflow-y-auto bg-white rounded p-2 space-y-1">
                        {wbPreview.unmatched_ingredients.map((n: string, i: number) => <p key={i} className="text-red-700">{n}</p>)}
                      </div>
                    </details>
                  )}

                  <label className="flex items-center gap-2 text-xs cursor-pointer">
                    <input type="checkbox" checked={wbOverwrite} onChange={(e) => setWbOverwrite(e.target.checked)} className="accent-[#af4408] w-4 h-4" />
                    <span className="text-[#6B5744]">Overwrite existing recipes / sub-recipes / prices with same name (recommended for re-import)</span>
                  </label>

                  <div className="flex gap-3">
                    <button
                      onClick={submitWorkbookImport}
                      disabled={wbImporting}
                      className="flex items-center gap-2 px-5 py-2.5 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
                    >
                      {wbImporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                      {wbImporting ? 'Importing…' : `Import ${wbPreview.counts.recipes} Recipes + ${wbPreview.counts.sub_recipes} Sub-Recipes`}
                    </button>
                    <button
                      onClick={() => { setWbPreview(null); setWbFile(null); setWbFileName(null); }}
                      className="px-4 py-2.5 bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm hover:bg-[#E8D5C4] transition-colors"
                    >
                      Clear
                    </button>
                  </div>
                </div>
              )}

              {/* Result */}
              {wbResult && (
                <div className="space-y-3">
                  {wbResult.error ? (
                    <div className="p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
                      <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />
                      <div>
                        <p className="text-red-700 font-medium">Import failed</p>
                        <p className="text-red-600 text-xs mt-1">{wbResult.error}</p>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
                        <div className="flex items-start gap-2 mb-2">
                          <CheckCircle className="w-5 h-5 text-green-600 shrink-0" />
                          <p className="text-green-700 font-medium">Import complete!</p>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                          {wbResult.materials_created > 0 && <StatBlock label="Materials Created" value={wbResult.materials_created} color="text-green-600" />}
                          {wbResult.materials_price_updated > 0 && <StatBlock label="Prices Updated" value={wbResult.materials_price_updated} color="text-blue-600" />}
                          {(wbResult.sub_recipes_created > 0 || wbResult.sub_recipes_updated > 0) && <StatBlock label="Sub-Recipes" value={wbResult.sub_recipes_created + wbResult.sub_recipes_updated} color="text-purple-600" />}
                          {(wbResult.recipes_created > 0 || wbResult.recipes_updated > 0) && <StatBlock label="Recipes" value={wbResult.recipes_created + wbResult.recipes_updated} color="text-green-600" />}
                        </div>
                      </div>

                      {wbResult.validation_summary && (
                        <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3 text-xs text-[#6B5744]">
                          <strong className="text-[#2D1B0E]">Food-cost check:</strong>{' '}
                          {wbResult.validation_summary.within_tolerance}/{wbResult.validation_summary.total} recipes match the workbook within ±₹0.50 / ±2%.
                          {wbResult.validation_summary.offenders?.length > 0 && (
                            <details className="mt-2">
                              <summary className="cursor-pointer font-medium text-amber-700">{wbResult.validation_summary.offenders.length} larger difference(s) — usually an unmatched ingredient</summary>
                              <div className="mt-2 max-h-40 overflow-y-auto bg-white rounded p-2 space-y-1">
                                {wbResult.validation_summary.offenders.map((o: any, i: number) => (
                                  <p key={i} className="text-[#6B5744]">{o.recipe}: computed ₹{o.computed} vs workbook ₹{o.workbook} (Δ {o.delta})</p>
                                ))}
                              </div>
                            </details>
                          )}
                        </div>
                      )}

                      {wbResult.ingredients_not_matched?.length > 0 && (
                        <details className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs">
                          <summary className="cursor-pointer font-medium text-red-800">⚠️ {wbResult.ingredients_not_matched.length} ingredient(s) not matched</summary>
                          <div className="mt-2 max-h-40 overflow-y-auto bg-white rounded p-2 space-y-1">
                            {wbResult.ingredients_not_matched.slice(0, 80).map((s: string, i: number) => <p key={i} className="text-red-700">{s}</p>)}
                          </div>
                        </details>
                      )}

                      {wbResult.sub_in_sub_not_imported?.length > 0 && (
                        <details className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs">
                          <summary className="cursor-pointer font-medium text-amber-800">{wbResult.sub_in_sub_not_imported.length} sub-in-sub reference(s) skipped</summary>
                          <div className="mt-2 max-h-40 overflow-y-auto bg-white rounded p-2 space-y-1">
                            {wbResult.sub_in_sub_not_imported.map((s: string, i: number) => <p key={i} className="text-amber-700">{s}</p>)}
                          </div>
                        </details>
                      )}

                      <button onClick={() => setWbResult(null)} className="text-xs text-[#8B7355] hover:text-[#2D1B0E]">Dismiss</button>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* CATEGORY MANAGER MODAL (rename / merge)                   */}
      {/* ========================================================= */}
      {catModalOpen && (
        <RecipeCategoryManager
          key={recipeCategories.join('|')}
          items={recipeCategories.map((c) => ({ name: c, count: recipes.filter((r) => r.category === c).length }))}
          renaming={catRenaming}
          onRename={renameCategory}
          onClose={() => setCatModalOpen(false)}
        />
      )}

      {/* ========================================================= */}
      {/* BULK UPLOAD MODAL                                         */}
      {/* ========================================================= */}
      {bulkModalOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-6 pb-6 overflow-y-auto">
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setBulkModalOpen(false)} />
          <div className="relative w-full max-w-5xl bg-white rounded-2xl shadow-xl border border-[#E8D5C4] mx-4">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8D5C4]">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-green-100">
                  <Upload className="w-5 h-5 text-green-600" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-[#2D1B0E]">Bulk Upload Recipes</h2>
                  <p className="text-xs text-[#8B7355]">Upload CSV/Excel with multiple recipes at once</p>
                </div>
              </div>
              <button onClick={() => setBulkModalOpen(false)} className="p-1 text-[#8B7355] hover:text-[#2D1B0E]">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-6 py-5 space-y-4">
              {/* Instructions */}
              <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-xl p-4 text-sm">
                <p className="font-medium text-[#6B5744] mb-2">How to use:</p>
                <ol className="list-decimal list-inside space-y-1 text-[#6B5744] text-xs">
                  <li>Click <strong>&quot;Download Template&quot;</strong> to get a CSV with sample bar recipes (pegs, cocktails, mocktails, house sodas) and your full materials list as reference</li>
                  <li>One row per ingredient. Repeat <code className="bg-white px-1 rounded">recipe_name</code>, <code className="bg-white px-1 rounded">category</code>, <code className="bg-white px-1 rounded">selling_price</code> for each ingredient of the same recipe</li>
                  <li>Ingredient names must match your inventory material names exactly (case-insensitive)</li>
                  <li>Upload the filled CSV/Excel below</li>
                </ol>
                <div className="mt-2 text-[10px] text-[#8B7355]">
                  Required columns: <code className="bg-white px-1 rounded">recipe_name</code>, <code className="bg-white px-1 rounded">ingredient_name</code>, <code className="bg-white px-1 rounded">quantity</code>.
                  Optional: <code className="bg-white px-1 rounded">category</code>, <code className="bg-white px-1 rounded">selling_price</code>, <code className="bg-white px-1 rounded">unit</code>, <code className="bg-white px-1 rounded">yield_percent</code>, <code className="bg-white px-1 rounded">wastage_percent</code>, <code className="bg-white px-1 rounded">notes</code>
                </div>
              </div>

              {/* Download Template Buttons */}
              <div className="flex gap-2 flex-wrap">
                <button
                  onClick={() => downloadTemplate(false)}
                  className="flex items-center gap-2 px-4 py-2 border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 rounded-lg text-sm font-medium transition-colors"
                >
                  <Download className="w-4 h-4" />
                  Download Template (Samples Only)
                </button>
                <button
                  onClick={() => downloadTemplate(true)}
                  className="flex items-center gap-2 px-4 py-2 border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 rounded-lg text-sm font-medium transition-colors"
                >
                  <Download className="w-4 h-4" />
                  Download Template (with Material Reference)
                </button>
              </div>

              {/* Drop Zone */}
              <div
                onDragOver={(e) => { e.preventDefault(); setBulkDragOver(true); }}
                onDragLeave={() => setBulkDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setBulkDragOver(false);
                  const f = e.dataTransfer.files?.[0];
                  if (f) handleBulkFile(f);
                }}
                onClick={() => bulkFileRef.current?.click()}
                className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
                  bulkDragOver ? 'border-green-500 bg-green-50' : 'border-[#D4B896] hover:border-green-600 hover:bg-[#FFF1E3]/30'
                }`}
              >
                <FileSpreadsheet className="w-10 h-10 text-[#8B7355] mx-auto mb-3" />
                <p className="text-[#6B5744] font-medium">
                  {bulkFileName ? bulkFileName : 'Drag & drop your recipe file, or click to browse'}
                </p>
                <p className="text-xs text-[#8B7355] mt-1">Accepts .csv, .xlsx, .xls</p>
                <input
                  ref={bulkFileRef}
                  type="file"
                  accept=".csv,.xlsx,.xls"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleBulkFile(f); }}
                  className="hidden"
                />
              </div>

              {/* Preview */}
              {bulkRows.length > 0 && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-[#2D1B0E]">
                      Preview: {previewRecipeCount} recipe(s) • {bulkRows.length} ingredient row(s)
                    </h3>
                    <label className="flex items-center gap-2 text-xs cursor-pointer">
                      <input
                        type="checkbox"
                        checked={bulkOverwrite}
                        onChange={(e) => setBulkOverwrite(e.target.checked)}
                        className="accent-green-600 w-4 h-4"
                      />
                      <span className="text-[#6B5744]">Overwrite existing recipes with same name</span>
                    </label>
                  </div>

                  <div className="overflow-x-auto max-h-72 overflow-y-auto rounded-lg border border-[#E8D5C4]">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-[#FFF1E3] z-10">
                        <tr className="text-[#8B7355]">
                          <th className="text-left py-2 px-2">#</th>
                          <th className="text-left py-2 px-2">Recipe</th>
                          <th className="text-left py-2 px-2">Category</th>
                          <th className="text-right py-2 px-2">Price</th>
                          <th className="text-left py-2 px-2">Ingredient</th>
                          <th className="text-right py-2 px-2">Qty</th>
                          <th className="text-left py-2 px-2">Unit</th>
                          <th className="text-right py-2 px-2">Yield%</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bulkRows.slice(0, 100).map((row, i) => (
                          <tr key={i} className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3]/30">
                            <td className="py-1.5 px-2 text-[#8B7355]">{i + 1}</td>
                            <td className="py-1.5 px-2 text-[#2D1B0E] font-medium">{row.recipe_name}</td>
                            <td className="py-1.5 px-2 text-[#6B5744]">{row.category}</td>
                            <td className="py-1.5 px-2 text-right text-[#6B5744] font-mono">{row.selling_price > 0 ? `₹${row.selling_price}` : '-'}</td>
                            <td className="py-1.5 px-2 text-[#6B5744]">{row.ingredient_name}</td>
                            <td className="py-1.5 px-2 text-right font-mono text-[#2D1B0E]">{row.quantity}</td>
                            <td className="py-1.5 px-2 text-[#6B5744]">{row.unit}</td>
                            <td className="py-1.5 px-2 text-right font-mono text-[#6B5744]">{row.yield_percent}%</td>
                          </tr>
                        ))}
                        {bulkRows.length > 100 && (
                          <tr><td colSpan={8} className="py-2 px-2 text-center text-[#8B7355]">... and {bulkRows.length - 100} more rows</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  <div className="flex gap-3">
                    <button
                      onClick={submitBulkUpload}
                      disabled={bulkUploading}
                      className="flex items-center gap-2 px-5 py-2.5 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
                    >
                      {bulkUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                      {bulkUploading ? 'Uploading...' : `Upload ${previewRecipeCount} Recipe(s)`}
                    </button>
                    <button
                      onClick={() => { setBulkRows([]); setBulkFileName(null); setBulkResult(null); }}
                      className="px-4 py-2.5 bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm hover:bg-[#E8D5C4] transition-colors"
                    >
                      Clear
                    </button>
                  </div>
                </div>
              )}

              {/* Result */}
              {bulkResult && (
                <div className={`p-4 rounded-lg border ${
                  (bulkResult.errors?.length > 0 || bulkResult.ingredients_not_found?.length > 0) && !bulkResult.recipes_created
                    ? 'bg-red-50 border-red-200'
                    : bulkResult.errors?.length > 0 || bulkResult.ingredients_not_found?.length > 0 || bulkResult.subs_not_found?.length > 0
                    ? 'bg-amber-50 border-amber-200'
                    : 'bg-green-50 border-green-200'
                }`}>
                  <div className="flex items-start gap-3">
                    {bulkResult.recipes_created > 0 || bulkResult.recipes_updated > 0
                      ? <CheckCircle className="w-5 h-5 text-green-600 mt-0.5 shrink-0" />
                      : <AlertCircle className="w-5 h-5 text-red-500 mt-0.5 shrink-0" />
                    }
                    <div className="flex-1 text-sm space-y-1">
                      {bulkResult.recipes_created > 0 && <p className="text-green-700 font-medium">{bulkResult.recipes_created} recipe(s) created</p>}
                      {bulkResult.recipes_updated > 0 && <p className="text-blue-700">{bulkResult.recipes_updated} recipe(s) updated</p>}
                      {bulkResult.recipes_skipped > 0 && <p className="text-amber-700">{bulkResult.recipes_skipped} recipe(s) skipped (already exist — enable overwrite to update)</p>}
                      {bulkResult.ingredients_added > 0 && <p className="text-[#6B5744]">{bulkResult.ingredients_added} ingredient(s) linked</p>}
                      {bulkResult.subs_linked > 0 && <p className="text-[#6B5744]">{bulkResult.subs_linked} sub-recipe link(s) restored</p>}

                      {bulkResult.ingredients_not_found?.length > 0 && (
                        <div className="mt-2">
                          <p className="text-amber-700 font-medium mb-1">
                            <AlertTriangle className="w-3 h-3 inline mr-1" />
                            {bulkResult.ingredients_not_found.length} ingredient(s) not found in inventory:
                          </p>
                          <div className="max-h-32 overflow-y-auto bg-white rounded border border-amber-200 p-2">
                            {bulkResult.ingredients_not_found.slice(0, 30).map((err: string, i: number) => (
                              <p key={i} className="text-xs text-amber-800">{err}</p>
                            ))}
                            {bulkResult.ingredients_not_found.length > 30 && (
                              <p className="text-[10px] text-amber-600 mt-1">...and {bulkResult.ingredients_not_found.length - 30} more</p>
                            )}
                          </div>
                          <p className="text-[10px] text-[#8B7355] mt-1">Add these materials to Raw Materials first, then re-upload.</p>
                        </div>
                      )}

                      {bulkResult.subs_not_found?.length > 0 && (
                        <div className="mt-2">
                          <p className="text-amber-700 font-medium mb-1">
                            <AlertTriangle className="w-3 h-3 inline mr-1" />
                            {bulkResult.subs_not_found.length} sub-recipe(s) not found:
                          </p>
                          <div className="max-h-32 overflow-y-auto bg-white rounded border border-amber-200 p-2">
                            {bulkResult.subs_not_found.slice(0, 30).map((err: string, i: number) => (
                              <p key={i} className="text-xs font-mono text-amber-800">{err}</p>
                            ))}
                            {bulkResult.subs_not_found.length > 30 && (
                              <p className="text-[10px] text-amber-600 mt-1">...and {bulkResult.subs_not_found.length - 30} more</p>
                            )}
                          </div>
                          <p className="text-[10px] text-[#8B7355] mt-1">Import these via Step 1 (sub-recipes CSV) below, then re-upload.</p>
                        </div>
                      )}

                      {bulkResult.errors?.length > 0 && (
                        <div className="mt-2">
                          {bulkResult.errors.slice(0, 10).map((err: string, i: number) => (
                            <p key={i} className="text-red-600 text-xs">{err}</p>
                          ))}
                          {bulkResult.errors.length > 10 && (
                            <p className="text-[10px] text-red-500 mt-1">...and {bulkResult.errors.length - 10} more</p>
                          )}
                        </div>
                      )}
                    </div>
                    <button onClick={() => setBulkResult(null)} className="text-[#8B7355] hover:text-[#2D1B0E] text-xs">
                      Dismiss
                    </button>
                  </div>
                </div>
              )}

              {/* ----------------------------------------------------- */}
              {/* RESTORE FULL BOOK (sub-recipes + recipes)             */}
              {/* ----------------------------------------------------- */}
              <div className="border-t border-[#E8D5C4] pt-4 space-y-3">
                <div>
                  <h3 className="text-sm font-semibold text-[#2D1B0E] flex items-center gap-2">
                    <RefreshCw className="w-4 h-4 text-[#af4408]" />
                    Restore full book (sub-recipes + recipes)
                  </h3>
                  <p className="text-xs text-[#8B7355] mt-1">
                    Restore order: Step 1 sub-recipes below, then Step 2 = the regular recipes upload above with
                    <b> “Overwrite existing recipes with same name” TICKED</b> (Step 1 pre-ticks it for you).
                    Use the two <i>restore CSVs</i> prepared for this (sub-recipes-restore…csv + recipes-restore…csv) — not the .xlsx export.
                  </p>
                </div>

                {/* Step 1 — Sub-recipes CSV */}
                <div
                  onDragOver={(e) => { e.preventDefault(); setSubBulkDragOver(true); }}
                  onDragLeave={() => setSubBulkDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setSubBulkDragOver(false);
                    const f = e.dataTransfer.files?.[0];
                    if (f) handleSubBulkFile(f);
                  }}
                  onClick={() => subBulkFileRef.current?.click()}
                  className={`border-2 border-dashed rounded-xl p-4 text-center cursor-pointer transition-colors ${
                    subBulkDragOver ? 'border-[#af4408] bg-[#FFF1E3]' : 'border-[#D4B896] hover:border-[#af4408] hover:bg-[#FFF1E3]/30'
                  }`}
                >
                  <p className="text-sm text-[#6B5744] font-medium">
                    Step 1 — Sub-recipes CSV: {subBulkFileName ? subBulkFileName : 'drag & drop, or click to browse'}
                  </p>
                  <p className="text-[10px] text-[#8B7355] mt-1">
                    Columns: sub_recipe_name, yield_qty, yield_unit, ingredient_name, quantity, unit
                  </p>
                  <input
                    ref={subBulkFileRef}
                    type="file"
                    accept=".csv"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) handleSubBulkFile(f); }}
                    className="hidden"
                  />
                </div>

                {subBulkRows.length > 0 && (
                  <div className="flex items-center justify-between flex-wrap gap-3">
                    <label className="flex items-center gap-2 text-xs cursor-pointer">
                      <input
                        type="checkbox"
                        checked={subBulkOverwrite}
                        onChange={(e) => setSubBulkOverwrite(e.target.checked)}
                        className="accent-[#af4408] w-4 h-4"
                      />
                      <span className="text-[#6B5744]">Replace existing compositions</span>
                    </label>
                    <div className="flex gap-3">
                      <button
                        onClick={submitSubBulkUpload}
                        disabled={subBulkUploading}
                        className="flex items-center gap-2 px-5 py-2.5 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
                      >
                        {subBulkUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                        {subBulkUploading ? 'Uploading...' : `Upload ${subBulkPreviewCount} Sub-Recipe(s) • ${subBulkRows.length} row(s)`}
                      </button>
                      <button
                        onClick={() => { setSubBulkRows([]); setSubBulkFileName(null); setSubBulkResult(null); }}
                        className="px-4 py-2.5 bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm hover:bg-[#E8D5C4] transition-colors"
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                )}

                {subBulkResult && (
                  <div className={`p-4 rounded-lg border ${
                    (subBulkResult.errors?.length > 0 || subBulkResult.ingredients_not_found?.length > 0) && !subBulkResult.subs_created && !subBulkResult.subs_updated
                      ? 'bg-red-50 border-red-200'
                      : subBulkResult.errors?.length > 0 || subBulkResult.ingredients_not_found?.length > 0
                      ? 'bg-amber-50 border-amber-200'
                      : 'bg-green-50 border-green-200'
                  }`}>
                    <div className="flex items-start gap-3">
                      {subBulkResult.subs_created > 0 || subBulkResult.subs_updated > 0
                        ? <CheckCircle className="w-5 h-5 text-green-600 mt-0.5 shrink-0" />
                        : <AlertCircle className="w-5 h-5 text-red-500 mt-0.5 shrink-0" />
                      }
                      <div className="flex-1 text-sm space-y-1">
                        {subBulkResult.subs_created > 0 && <p className="text-green-700 font-medium">{subBulkResult.subs_created} sub-recipe(s) created</p>}
                        {subBulkResult.subs_updated > 0 && <p className="text-blue-700">{subBulkResult.subs_updated} sub-recipe(s) updated</p>}
                        {subBulkResult.subs_skipped > 0 && <p className="text-amber-700">{subBulkResult.subs_skipped} sub-recipe(s) skipped (already exist — enable “Replace existing compositions”)</p>}
                        {subBulkResult.recipes_recosted > 0 && <p className="text-[#6B5744]">{subBulkResult.recipes_recosted} linked recipe(s) re-costed</p>}
                        {subBulkResult.error && <p className="text-red-600">{subBulkResult.error}</p>}
                        {subBulkResult.ingredients_added > 0 && <p className="text-[#6B5744]">{subBulkResult.ingredients_added} ingredient(s) linked</p>}

                        {subBulkResult.ingredients_not_found?.length > 0 && (
                          <div className="mt-2">
                            <p className="text-amber-700 font-medium mb-1">
                              <AlertTriangle className="w-3 h-3 inline mr-1" />
                              {subBulkResult.ingredients_not_found.length} ingredient(s) not found in inventory:
                            </p>
                            <div className="max-h-32 overflow-y-auto bg-white rounded border border-amber-200 p-2">
                              {subBulkResult.ingredients_not_found.slice(0, 30).map((err: string, i: number) => (
                                <p key={i} className="text-xs font-mono text-amber-800">{err}</p>
                              ))}
                              {subBulkResult.ingredients_not_found.length > 30 && (
                                <p className="text-[10px] text-amber-600 mt-1">...and {subBulkResult.ingredients_not_found.length - 30} more</p>
                              )}
                            </div>
                            <p className="text-[10px] text-[#8B7355] mt-1">Add these materials to Raw Materials first, then re-upload.</p>
                          </div>
                        )}

                        {subBulkResult.errors?.length > 0 && (
                          <div className="mt-2">
                            {subBulkResult.errors.slice(0, 10).map((err: string, i: number) => (
                              <p key={i} className="text-red-600 text-xs">{err}</p>
                            ))}
                          </div>
                        )}
                      </div>
                      <button onClick={() => setSubBulkResult(null)} className="text-[#8B7355] hover:text-[#2D1B0E] text-xs">
                        Dismiss
                      </button>
                    </div>
                  </div>
                )}

                <p className="text-[10px] text-[#8B7355]">
                  Step 2 — Recipes CSV: use the regular upload above <b>with “Overwrite existing recipes with same name” ticked</b> (a successful Step 1 ticks it for you — without it every existing recipe is skipped). It understands <code className="bg-white px-1 rounded">[SUB]</code> ingredient rows and re-links sub-recipes automatically.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
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


/** Rename / merge recipe categories across all recipes. */
function RecipeCategoryManager({ items, renaming, onRename, onClose }: {
  items: { name: string; count: number }[];
  renaming: string | null;
  onRename: (from: string, to: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>(
    () => Object.fromEntries(items.map((i) => [i.name, i.name])),
  );
  const existingNames = new Set(items.map((i) => i.name));

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-10 pb-6 overflow-y-auto">
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-white rounded-2xl shadow-xl border border-[#E8D5C4] mx-4">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8D5C4]">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-indigo-100"><Pencil className="w-5 h-5 text-indigo-600" /></div>
            <div>
              <h2 className="text-lg font-semibold text-[#2D1B0E]">Manage Categories</h2>
              <p className="text-xs text-[#8B7355]">Rename a category to update every recipe in it. Renaming to an existing name merges them.</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 text-[#8B7355] hover:text-[#2D1B0E]"><X className="w-5 h-5" /></button>
        </div>

        <div className="px-6 py-4 space-y-2 max-h-[60vh] overflow-y-auto">
          {items.length === 0 ? (
            <p className="text-sm text-[#8B7355] text-center py-6">No categories yet. Add one by typing it into a recipe&apos;s Category field.</p>
          ) : items.map((it) => {
            const val = draft[it.name] ?? it.name;
            const changed = val.trim() !== '' && val.trim() !== it.name;
            const willMerge = changed && existingNames.has(val.trim());
            return (
              <div key={it.name} className="flex items-center gap-2">
                <input
                  type="text"
                  value={val}
                  onChange={(e) => setDraft((d) => ({ ...d, [it.name]: e.target.value }))}
                  className="flex-1 bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2 text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
                />
                <span className="text-xs text-[#8B7355] w-14 text-right shrink-0">{it.count} item{it.count === 1 ? '' : 's'}</span>
                <button
                  onClick={() => onRename(it.name, val)}
                  disabled={!changed || renaming === it.name}
                  className="px-3 py-2 rounded-lg text-xs font-medium transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed bg-indigo-600 hover:bg-indigo-700 text-white"
                  title={willMerge ? `Merge into existing "${val.trim()}"` : 'Rename across all recipes'}
                >
                  {renaming === it.name ? <Loader2 className="w-4 h-4 animate-spin" /> : willMerge ? 'Merge' : 'Rename'}
                </button>
              </div>
            );
          })}
        </div>

        <div className="px-6 py-3 border-t border-[#E8D5C4] flex justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm text-[#8B7355] hover:text-[#3D2614]">Done</button>
        </div>
      </div>
    </div>
  );
}


// Header dropdown (Import ▾ / Tools ▾). Fixed-positioned menu so it never clips.
type MenuItemDef = { label: string; onClick: () => void; icon?: any; disabled?: boolean; danger?: boolean };
function HeaderMenu({ label, icon, items, primary }: { label: string; icon?: any; items: MenuItemDef[]; primary?: boolean }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const openMenu = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [open]);
  const base = primary
    ? 'bg-[#af4408] hover:bg-[#8a3506] text-white border-transparent'
    : 'bg-white hover:bg-[#FFF1E3] text-[#6B5744] border-[#E0D0BE]';
  return (
    <>
      <button ref={btnRef} onClick={() => (open ? setOpen(false) : openMenu())}
              className={`flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl border text-sm font-medium shadow-sm transition-colors ${base}`}>
        {icon}{label}<ChevronDown size={15} className="opacity-70" />
      </button>
      {open && pos && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div style={{ top: pos.top, right: pos.right }} className="fixed z-50 w-60 bg-white border border-[#E8D5C4] rounded-xl shadow-xl py-1 text-sm">
            {items.map((it, i) => (
              <button key={i} disabled={it.disabled} onClick={() => { setOpen(false); it.onClick(); }}
                      className={`w-full text-left px-3 py-2 flex items-center gap-2.5 disabled:opacity-40 ${it.danger ? 'text-red-600 hover:bg-red-50' : 'text-[#3D2614] hover:bg-[#FFF1E3]'}`}>
                {it.icon && <span className="shrink-0 text-[#8B7355]">{it.icon}</span>}
                <span className="truncate">{it.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}

// ⋮ per-row menu (View / Edit / Copy). Fixed-positioned to escape table overflow;
// flips UPWARD near the viewport bottom so it never runs off-screen, and sits
// z-[95] — above the floating notification bell (z-[90]) which used to overlap it.
function RRowMenu({ items }: { items: MenuItemDef[] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const computePos = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    // Trigger scrolled fully out of view → close instead of floating detached
    if (r.bottom < 0 || r.top > window.innerHeight) { setOpen(false); return; }
    const menuH = items.length * 34 + 10;            // ~34px per row + padding
    const below = r.bottom + 4;
    const top = below + menuH > window.innerHeight - 8
      ? Math.max(8, r.top - menuH - 4)               // flip above the trigger
      : below;
    setPos({ top, right: Math.max(8, window.innerWidth - r.right) });
  }, [items.length]);
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
            {items.map((it, i) => (
              <button key={i} onClick={() => { setOpen(false); it.onClick(); }}
                      className={`w-full text-left px-3 py-1.5 flex items-center gap-2 ${it.danger ? 'text-red-600 hover:bg-red-50' : 'text-[#2D1B0E] hover:bg-[#FFF1E3]'}`}>
                {it.icon}{it.label}
              </button>
            ))}
          </div>
        </>,
        document.body
      )}
    </>
  );
}

// FC% vs target progress bar (green under target, red well over) with a target tick.
function FcBar({ fc, target }: { fc: number; target: number }) {
  const w = Math.max(2, Math.min(100, fc));
  const t = Math.max(0, Math.min(100, target));
  const color = fc <= 0 ? 'bg-gray-300' : fc <= target ? 'bg-green-500' : fc <= 50 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="relative h-2 w-full min-w-[90px] rounded-full bg-[#EFE4D6]">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${w}%` }} />
      <div className="absolute -top-0.5 h-3 w-0.5 bg-[#2D1B0E]/60 rounded" style={{ left: `${t}%` }} title={`Target ${target}%`} />
    </div>
  );
}

function HealthPill({ label, count, tone, active, onClick }: { label: string; count: number; tone: string; active: boolean; onClick: () => void }) {
  const tones: Record<string, string> = {
    red: active ? 'bg-red-600 text-white border-red-600' : 'bg-white text-red-700 border-red-200 hover:bg-red-50',
    amber: active ? 'bg-amber-500 text-white border-amber-500' : 'bg-white text-amber-800 border-amber-300 hover:bg-amber-50',
    orange: active ? 'bg-orange-500 text-white border-orange-500' : 'bg-white text-orange-700 border-orange-200 hover:bg-orange-50',
    blue: active ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-blue-700 border-blue-200 hover:bg-blue-50',
    gray: active ? 'bg-gray-600 text-white border-gray-600' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50',
  };
  return (
    <button onClick={onClick} className={`text-xs font-medium px-2.5 py-1 rounded-full border transition-colors ${tones[tone] || tones.gray}`}>
      <span className="font-bold">{count}</span> {label}
    </button>
  );
}

function RPagination({ page, pageCount, onPage }: { page: number; pageCount: number; onPage: (n: number) => void }) {
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

/* ================================================================= */
/* Direct Items Panel — inline on Recipes page                        */
/* ================================================================= */

interface DirectItemMatch {
  item_name: string;
  category: string | null;
  qty_sold: number;
  revenue: number;
  matched: null | {
    material_id: string;
    material_name: string;
    unit: string;
    avg_price: number;
    current_stock: number;
    purchased_qty: number;
    score: number;
  };
  sold_in_mat_unit?: number;
  conversion_note?: string;
  diff_qty?: number;
  diff_value?: number;
  diff_in_sold_unit?: number;
  status?: 'leakage' | 'purchase_error' | 'reconciled';
  leakage_qty?: number;       // alias for diff_qty (backwards compat)
  leakage_value?: number;     // alias for diff_value
  purchased_in_sold_unit?: number;
  stock_in_sold_unit?: number;
  leakage_in_sold_unit?: number;   // alias for diff_in_sold_unit
  sold_unit_label?: string;
  finalized?: boolean;
  linked_material_id?: string | null;
  reviewed?: boolean;
  /** Set when user clicks Unlink/Dismiss — hides from active filters. */
  dismissed?: boolean;
}

function DirectItemsPanel({
  materials,
}: {
  materials: Array<{ id: string; name: string; unit?: string; average_price?: number }>;
}) {
  const [items, setItems] = useState<DirectItemMatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [minSold, setMinSold] = useState(20);
  const [filter, setFilter] = useState<'pending' | 'finalized' | 'dismissed' | 'unmatched' | 'all'>('pending');
  const [savingItem, setSavingItem] = useState<string | null>(null);
  // Manual "Add Direct Item" form — register a sold-item name → raw material link.
  const [showAdd, setShowAdd] = useState(false);
  const [addName, setAddName] = useState('');
  const [addMatId, setAddMatId] = useState('');
  const [addMatText, setAddMatText] = useState('');
  const [adding, setAdding] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      // include_dismissed=1 so the UI's "Dismissed" filter has rows to show.
      // The filter logic below decides which subset to display.
      const res = await fetch(`/api/direct-items?min_sold=${minSold}&limit=500&include_dismissed=1`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setItems(data.items || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [minSold]);

  useEffect(() => { load(); }, [load]);

  // Manually register a direct item: link a sold-item name → raw material, even
  // before it has ever sold. The GET surfaces it as a finalized row.
  const addDirectItem = async () => {
    const name = addName.trim();
    if (!name || !addMatId) { setError('Enter an item name and pick a raw material.'); return; }
    setAdding(true); setError(null);
    try {
      const res = await api('/api/direct-items', { method: 'POST', body: { item_name: name, material_id: addMatId } });
      if (!res.ok) throw new Error(await res.text());
      setAddName(''); setAddMatId(''); setAddMatText(''); setShowAdd(false);
      setFilter('finalized');
      await load();
    } catch (e: any) {
      setError(e.message || 'Failed to add');
    } finally { setAdding(false); }
  };

  /**
   * Save a link decision for a direct item.
   *
   *   materialId = <id>   → finalize the link (item ↔ raw material). Stays in direct-items as "finalized".
   *   materialId = null   → UNLINK + DISMISS in one step. The row is hidden from /direct-items
   *                         (dismissed=1) so the team treats this item via the main Recipes flow
   *                         instead. Decision can be reversed by changing the filter to "Dismissed"
   *                         and clicking the pill to re-link.
   *
   * Previously, passing null only cleared material_id without setting dismissed=1, which left the
   * row in a confusing "no link" state — that was the unlink bug being fixed here.
   */
  const saveLink = async (itemName: string, materialId: string | null) => {
    setSavingItem(itemName);
    const dismissedFlag = materialId === null;   // null link = user is dismissing
    // Optimistic UI — feedback is instant, even before the slow reload.
    setItems(prev => prev.map(i => i.item_name === itemName ? {
      ...i,
      linked_material_id: materialId,
      finalized: !!materialId && !!i.matched && i.matched.material_id === materialId,
      reviewed: true,
      dismissed: dismissedFlag,
    } : i));
    try {
      const res = await api('/api/direct-items', {
        method: 'POST',
        body: { item_name: itemName, material_id: materialId, dismissed: dismissedFlag },
      });
      if (!res.ok) throw new Error(await res.text());
      await load(true);   // silent reload — keeps the table visible
    } catch (e: any) {
      alert('Save failed: ' + e.message);
      await load(true);   // revert to server truth on error, still silent
    } finally {
      setSavingItem(null);
    }
  };

  const filtered = useMemo(() => {
    let list = items;
    if (search) {
      const s = search.toLowerCase();
      list = list.filter(i =>
        i.item_name.toLowerCase().includes(s) ||
        (i.matched?.material_name.toLowerCase().includes(s) ?? false)
      );
    }
    // Dismissed items are kept OUT of every filter except 'dismissed' itself + 'all'.
    // (Previously the proxy "reviewed && !finalized" lumped dismissed in with active
    // pending items, which made unlink feel broken.)
    if (filter === 'pending')    list = list.filter(i => i.matched && !i.finalized && !i.reviewed && !i.dismissed);
    if (filter === 'finalized')  list = list.filter(i => i.finalized && !i.dismissed);
    if (filter === 'dismissed')  list = list.filter(i => i.dismissed);
    if (filter === 'unmatched')  list = list.filter(i => !i.matched && !i.dismissed);
    if (filter === 'all')        list = list;
    return list;
  }, [items, search, filter]);

  const counts = useMemo(() => ({
    pending:    items.filter(i => i.matched && !i.finalized && !i.reviewed && !i.dismissed).length,
    finalized:  items.filter(i => i.finalized && !i.dismissed).length,
    dismissed:  items.filter(i => i.dismissed).length,
    unmatched:  items.filter(i => !i.matched && !i.dismissed).length,
  }), [items]);

  return (
    <div className="space-y-4">
      {/* Explainer */}
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-900 flex gap-2 items-start">
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
        <div>
          <span className="font-semibold">Direct items</span> are sold as-is from a purchased raw material —
          bottled water, beer, soft drinks, liquor pegs. Reviewing these first gives you accurate cost &amp; leakage
          without needing a full recipe. <span className="font-medium">Click Finalize</span> to save the match —
          it writes <code className="bg-white px-1 rounded">menu_items.material_id</code>, so every sale of that
          item flows through to the correct raw material.
        </div>
      </div>

      {/* Filter bar */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 shadow flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 flex-1 min-w-[220px]">
          <Search className="w-4 h-4 text-[#8B7355]" />
          <input value={search} onChange={e=>setSearch(e.target.value)}
                 placeholder="Search item or material…"
                 className="flex-1 px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
        </div>
        <div className="flex gap-1 bg-[#FFF1E3] rounded-lg p-1 text-xs">
          {([
            ['pending',   `Pending (${counts.pending})`,    'bg-amber-500'],
            ['finalized', `Finalized (${counts.finalized})`, 'bg-green-600'],
            ['dismissed', `Dismissed (${counts.dismissed})`, 'bg-rose-600'],
            ['unmatched', `Unmatched (${counts.unmatched})`, 'bg-gray-500'],
            ['all',       'All',                              'bg-[#af4408]'],
          ] as const).map(([v, label, activeBg]) => (
            <button key={v} onClick={()=>setFilter(v as any)}
                    className={`px-2.5 py-1 rounded-md font-medium transition-colors ${filter === v ? `${activeBg} text-white` : 'text-[#6B5744] hover:bg-white'}`}>
              {label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1 text-xs text-[#6B5744]">
          Min sold:
          <select value={minSold} onChange={e=>setMinSold(Number(e.target.value))}
                  className="px-2 py-1 rounded border border-[#E8D5C4] bg-white">
            <option value={5}>5</option>
            <option value={20}>20</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </label>
        <button onClick={() => load()} className="text-xs text-[#6B5744] hover:text-[#af4408] flex items-center gap-1">
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
        <button onClick={() => setShowAdd(v => !v)}
                className="text-xs text-white bg-[#af4408] hover:bg-[#8a3506] px-2.5 py-1.5 rounded-lg flex items-center gap-1">
          <Plus className="w-3 h-3" /> Add Direct Item
        </button>
      </div>

      {/* Manual add: register a direct item (sold-name -> raw material) before it ever sells */}
      {showAdd && (
        <div className="bg-white border border-[#af4408]/40 rounded-xl p-3 shadow flex flex-wrap items-end gap-3">
          <label className="text-xs text-[#6B5744] flex flex-col gap-1">
            Item name (as sold)
            <input value={addName} onChange={e => setAddName(e.target.value)}
                   placeholder="e.g. BUDWEISER (330ML)"
                   className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm w-56" />
          </label>
          <label className="text-xs text-[#6B5744] flex flex-col gap-1">
            Raw material
            <input list="di-mat-list" value={addMatText}
                   onChange={e => {
                     const v = e.target.value;
                     setAddMatText(v);
                     const m = materials.find(x => x.name.toLowerCase() === v.toLowerCase());
                     setAddMatId(m?.id || '');
                   }}
                   placeholder="type to search materials..."
                   className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm w-64" />
            <datalist id="di-mat-list">
              {materials.map(m => <option key={m.id} value={m.name} />)}
            </datalist>
          </label>
          <button onClick={addDirectItem} disabled={adding || !addName.trim() || !addMatId}
                  className="text-sm text-white bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-40 px-4 py-2 rounded-lg flex items-center gap-1.5">
            {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Save
          </button>
          <button onClick={() => { setShowAdd(false); setAddName(''); setAddMatId(''); setAddMatText(''); }}
                  className="text-sm text-[#6B5744] hover:bg-[#FFF1E3] px-3 py-2 rounded-lg">Cancel</button>
          {addMatText && !addMatId && <span className="text-[11px] text-amber-700 self-center">pick a material from the list</span>}
        </div>
      )}

      {/* List */}
      {loading ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 text-center text-xs text-[#8B7355] flex items-center justify-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Analysing sales…
        </div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">Error: {error}</div>
      ) : filtered.length === 0 ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 text-center text-sm text-[#8B7355]">
          {filter === 'pending' ? '✓ Nothing pending — every suggested match has been reviewed.' :
           filter === 'finalized' ? 'No finalized direct items yet. Start finalizing matches above!' :
           filter === 'dismissed' ? 'Nothing dismissed. Items you unlink will land here — they are hidden from active filters and should be handled via the main Recipes tab.' :
           filter === 'unmatched' ? '✓ All popular items have a suggested match.' :
           'No items match the current filters.'}
        </div>
      ) : (
        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                <tr>
                  <th className="text-left  py-2.5 px-3 font-medium">Sold item</th>
                  <th className="text-left  py-2.5 px-3 font-medium">Suggested raw material</th>
                  <th className="text-left  py-2.5 px-3 font-medium">Conversion</th>
                  <th className="text-right py-2.5 px-3 font-medium">Purchased</th>
                  <th className="text-right py-2.5 px-3 font-medium">Sold</th>
                  <th className="text-right py-2.5 px-3 font-medium">Diff (qty)</th>
                  <th className="text-right py-2.5 px-3 font-medium">Revenue</th>
                  <th className="text-right py-2.5 px-3 font-medium">Diff ₹</th>
                  <th className="text-right py-2.5 px-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((i, idx) => {
                  const canFinalize = i.matched && !i.finalized;
                  const isSaving = savingItem === i.item_name;
                  const diffVal = i.diff_value ?? i.leakage_value ?? 0;
                  const diffQty = i.diff_qty   ?? i.leakage_qty   ?? 0;
                  // status semantics (sign convention: diff = sold − purchased):
                  //   diff_qty < 0  → leakage      → RED   (purchased more than sold; shown −X)
                  //   diff_qty > 0  → purch error  → AMBER (sold more than purchased)
                  //   diff_qty ≈ 0  → reconciled   → GREEN
                  const status = i.status ?? (Math.abs(diffQty) < 0.5 ? 'reconciled' : diffQty < 0 ? 'leakage' : 'purchase_error');
                  const sign = !i.matched ? 'text-[#6B5744]' :
                    status === 'leakage'        ? 'text-red-600' :
                    status === 'purchase_error' ? 'text-indigo-600' :   // positive diff
                                                  'text-green-700';
                  return (
                    <tr key={idx} className={`border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3]/30 ${i.finalized ? 'bg-green-50/30' : ''}`}>
                      <td className="py-2.5 px-3 text-xs">
                        <div className="font-medium text-[#2D1B0E]">{i.item_name}</div>
                        {i.category && <div className="text-[10px] text-[#8B7355]">{i.category}</div>}
                      </td>
                      <td className="py-2.5 px-3 text-xs">
                        <DirectItemCell
                          item={i}
                          isSaving={isSaving}
                          materials={materials}
                          onLink={(matId) => saveLink(i.item_name, matId)}
                          onUnlink={() => saveLink(i.item_name, null)}
                        />
                      </td>
                      <td className="py-2.5 px-3 text-xs text-[#6B5744]">{i.conversion_note || '-'}</td>

                      {/* Purchased (in same unit as Sold, e.g. bottles) */}
                      <td className="py-2.5 px-3 text-xs text-right font-mono">
                        {i.matched && i.purchased_in_sold_unit !== undefined ? (
                          <div>
                            <div className="text-[#2D1B0E]">{Math.round(i.purchased_in_sold_unit).toLocaleString('en-IN')}</div>
                            <div className="text-[9px] text-[#8B7355]">
                              {Math.round(i.matched.purchased_qty).toLocaleString('en-IN')} {i.matched.unit}
                            </div>
                          </div>
                        ) : '-'}
                      </td>

                      {/* Sold (raw POS bottles/pegs) */}
                      <td className="py-2.5 px-3 text-xs text-right font-mono">
                        <div className="text-[#2D1B0E]">{Math.round(i.qty_sold).toLocaleString('en-IN')}</div>
                        {i.matched && i.sold_in_mat_unit !== undefined && (
                          <div className="text-[9px] text-[#8B7355]">
                            {Math.round(i.sold_in_mat_unit).toLocaleString('en-IN')} {i.matched.unit}
                          </div>
                        )}
                      </td>

                      {/* Diff (qty) — purchased − sold, in sold unit */}
                      <td className={`py-2.5 px-3 text-xs text-right font-mono font-semibold ${sign}`}>
                        {i.matched && (i.diff_in_sold_unit !== undefined || i.leakage_in_sold_unit !== undefined) ? (
                          <div>
                            <div>{((i.diff_in_sold_unit ?? i.leakage_in_sold_unit ?? 0) > 0 ? '+' : '')}{Math.round(i.diff_in_sold_unit ?? i.leakage_in_sold_unit ?? 0).toLocaleString('en-IN')}</div>
                            <div className="text-[9px] opacity-75">
                              {diffQty > 0 ? '+' : ''}{Math.round(diffQty).toLocaleString('en-IN')} {i.matched.unit}
                            </div>
                          </div>
                        ) : '-'}
                      </td>

                      <td className="py-2.5 px-3 text-xs text-right font-mono text-green-700">₹{Math.round(i.revenue).toLocaleString('en-IN')}</td>

                      {/* Diff ₹ */}
                      <td className={`py-2.5 px-3 text-xs text-right font-mono font-semibold ${sign}`}>
                        {i.matched ? (diffVal > 0 ? '+' : '') + '₹' + Math.round(diffVal).toLocaleString('en-IN') : '-'}
                      </td>

                      <td className="py-2.5 px-3 text-right">
                        <div className="flex flex-col items-end gap-1">
                          <StatusBadge
                            finalized={!!i.finalized}
                            reviewed={!!i.reviewed}
                            hasMatch={!!i.matched}
                          />
                          {i.matched && i.finalized && (
                            <ReconciliationBadge status={status} />
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- */
/* DirectItemCell — single cell for the Suggested column              */
/* ----------------------------------------------------------------- */
function DirectItemCell({
  item,
  isSaving,
  materials,
  onLink,
  onUnlink,
}: {
  item: DirectItemMatch;
  isSaving: boolean;
  materials: Array<{ id: string; name: string }>;
  onLink: (materialId: string) => void;
  onUnlink: () => void;
}) {
  const [showOverride, setShowOverride] = useState(false);
  const linkedId = item.linked_material_id;
  const linkedMat = linkedId ? materials.find(m => m.id === linkedId) : null;
  const isFinalized = !!item.finalized;

  // Determine the primary pill: what the user is currently linked to OR the suggestion
  const primaryMat = linkedMat ?? (item.matched ? { id: item.matched.material_id, name: item.matched.material_name } : null);
  const primaryIsSuggestion = primaryMat && item.matched && primaryMat.id === item.matched.material_id;

  if (!primaryMat) {
    // No suggestion and not linked — show manual link + dismiss options
    return (
      <div className="space-y-1">
        <span className="text-[10px] text-[#8B7355] italic flex items-center gap-1">
          <Link2Off className="w-3 h-3" /> No suggestion
        </span>
        {!showOverride ? (
          <div className="flex items-center gap-2 text-[10px]">
            <button onClick={() => setShowOverride(true)}
                    className="text-[#af4408] underline hover:text-[#8a3506]">
              Link manually…
            </button>
            <span className="text-[#E8D5C4]">·</span>
            <button onClick={onUnlink} disabled={isSaving}
                    className="text-rose-600 hover:text-rose-700 underline disabled:opacity-40"
                    title="Skip — mark reviewed without linking">
              {isSaving ? 'dismissing…' : 'dismiss'}
            </button>
          </div>
        ) : (
          <select
            autoFocus
            value=""
            onChange={(e) => { if (e.target.value) onLink(e.target.value); setShowOverride(false); }}
            disabled={isSaving}
            className="text-[10px] bg-white border border-[#E8D5C4] rounded px-1 py-0.5 max-w-[240px]"
          >
            <option value="">— Pick a raw material —</option>
            {materials.map(m => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {/* ONE big pill — click to link.  When linked, it's green and click does nothing (use unlink). */}
      <button
        type="button"
        onClick={() => { if (!linkedId || !primaryIsSuggestion) onLink(item.matched?.material_id || primaryMat.id); }}
        disabled={isSaving || isFinalized}
        title={
          isFinalized ? 'Already linked — click unlink below to dismiss' :
          linkedMat ? 'Click to re-link to the suggested material' :
          'Click to link this sold item to this raw material'
        }
        className={`inline-flex items-center gap-1.5 text-left font-medium rounded px-2.5 py-1.5 transition-colors max-w-full ${
          isFinalized
            ? 'bg-green-100 text-green-800 cursor-default'
            : linkedMat && !primaryIsSuggestion
              ? 'bg-amber-100 text-amber-900 hover:bg-amber-200 cursor-pointer'
              : 'bg-[#FFF1E3] text-[#2D1B0E] hover:bg-[#af4408] hover:text-white cursor-pointer'
        } disabled:opacity-60`}
      >
        {isSaving && !isFinalized ? <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" /> :
          isFinalized ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> :
          <Link2 className="w-3.5 h-3.5 shrink-0" />}
        <span className="truncate">{primaryMat.name}</span>
      </button>

      {/* Meta + action row */}
      <div className="flex items-center flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-[#8B7355]">
        {item.matched && (
          <>
            <span>score {(item.matched.score * 100).toFixed(0)}%</span>
            <span>·</span>
            <span>stock unit {item.matched.unit}</span>
            <span>·</span>
            <span>₹{item.matched.avg_price.toFixed(2)}</span>
          </>
        )}
      </div>

      {/* Action row:
          - Linked  → "unlink" (clears + marks dismissed)
          - Pending → "dismiss" (mark reviewed without linking) + "change" (override)
      */}
      <div className="flex items-center gap-2 text-[10px]">
        {linkedId ? (
          <button onClick={onUnlink} disabled={isSaving}
                  className="text-red-600 hover:text-red-700 underline disabled:opacity-40">
            {isSaving ? 'unlinking…' : 'unlink'}
          </button>
        ) : (
          <>
            <span className="text-[#8B7355] italic">Click pill to link</span>
            <span className="text-[#E8D5C4]">·</span>
            <button onClick={onUnlink} disabled={isSaving}
                    className="text-rose-600 hover:text-rose-700 underline disabled:opacity-40"
                    title="Skip — mark reviewed without linking (e.g. this isn't a direct item, it needs a recipe)">
              {isSaving ? 'dismissing…' : 'dismiss'}
            </button>
          </>
        )}
        {!isFinalized && (
          <>
            <span className="text-[#E8D5C4]">·</span>
            <button onClick={() => setShowOverride(s => !s)}
                    className="text-[#6B5744] hover:text-[#af4408] underline">
              {showOverride ? 'cancel' : 'change'}
            </button>
          </>
        )}
      </div>

      {showOverride && !isFinalized && (
        <select
          autoFocus
          value={linkedId || ''}
          onChange={(e) => { if (e.target.value) onLink(e.target.value); setShowOverride(false); }}
          disabled={isSaving}
          className="text-[10px] bg-white border border-[#E8D5C4] rounded px-1 py-0.5 max-w-[240px]"
        >
          <option value="">— Pick a different raw material —</option>
          {item.matched && (
            <option value={item.matched.material_id}>✓ Suggested: {item.matched.material_name}</option>
          )}
          <optgroup label="All materials">
            {materials.filter(m => !item.matched || m.id !== item.matched.material_id).map(m => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </optgroup>
        </select>
      )}
    </div>
  );
}

/* StatusBadge — replaces the old Action column button */
function StatusBadge({
  finalized, reviewed, hasMatch,
}: { finalized: boolean; reviewed: boolean; hasMatch: boolean }) {
  if (finalized) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-green-700 bg-green-100 rounded px-2 py-0.5">
        <CheckCircle2 className="w-3 h-3" /> Finalized
      </span>
    );
  }
  if (reviewed) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-rose-700 bg-rose-100 rounded px-2 py-0.5">
        Dismissed
      </span>
    );
  }
  if (hasMatch) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700 bg-amber-100 rounded px-2 py-0.5">
        Pending
      </span>
    );
  }
  return <span className="text-[10px] text-[#8B7355]">Unmatched</span>;
}

/* ReconciliationBadge — shows if a finalized direct item is leaking, error, or reconciled */
function ReconciliationBadge({ status }: { status: 'leakage' | 'purchase_error' | 'reconciled' }) {
  if (status === 'leakage') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-red-700 bg-red-100 rounded px-1.5 py-0.5"
            title="Purchased more than sold — possible waste, staff drinks or spillage">
        ⚠ Leakage
      </span>
    );
  }
  if (status === 'purchase_error') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-indigo-700 bg-indigo-100 rounded px-1.5 py-0.5"
            title="Sold more than purchased — likely missing inward entries / opening stock not captured">
        ⚠ Purchase error
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-green-700 bg-green-100 rounded px-1.5 py-0.5"
          title="Purchased ≈ sold — books reconcile">
      ✓ Reconciled
    </span>
  );
}

/* ----------------------------------------------------------------- */
/* MaterialPicker — searchable combobox showing SKU · Name · Unit · ₹  */
/* ----------------------------------------------------------------- */
function MaterialPicker({
  value,
  materials,
  onChange,
}: {
  value: string;
  materials: Array<{ id: string; name: string; unit: string; average_price: number; sku?: string; category?: string }>;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [onlyPurchased, setOnlyPurchased] = useState(false);  // show the FULL catalog by default; tick to hide ₹0 materials
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const selected = materials.find(m => m.id === value);

  // Position the dropdown using fixed coords so it escapes overflow:auto modal
  // parents — and keep it anchored to the trigger while the modal body or the
  // page scrolls (recompute on scroll/resize; close if the trigger leaves view).
  useEffect(() => {
    if (!open) return;
    const computePos = () => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) { setOpen(false); return; }
      const dropH = 380;
      const spaceBelow = window.innerHeight - r.bottom;
      const top = spaceBelow >= dropH || r.top < dropH ? r.bottom + 4 : r.top - dropH - 4;
      const width = Math.min(Math.max(r.width, 520), window.innerWidth - 16);
      let left = r.left;
      if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
      setPos({ top: Math.max(8, top), left: Math.max(8, left), width });
    };
    computePos();
    let raf = 0;
    const onMove = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(computePos); };
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open]);

  const filtered = useMemo(() => {
    let list = materials;
    if (onlyPurchased) list = list.filter(m => m.average_price > 0);
    const raw = query.toLowerCase().trim();
    if (raw) {
      // Tokenized substring match — same rules as MaterialTypeahead. Every
      // token (whitespace-separated) must appear somewhere in name/sku/
      // category/unit. Order-independent, so "oil 1l" matches "Sunflower Oil 1L".
      const tokens = raw.split(/\s+/).filter(Boolean);
      list = list.filter(m => {
        const hay = [
          m.name, m.sku, (m as any).category, (m as any).unit,
        ].filter(Boolean).join(' ').toLowerCase();
        return tokens.every(t => hay.includes(t));
      });
    }
    // Sort: bucket by relevance, then alphabetic.
    list = [...list].sort((a, b) => {
      const an = a.name.toLowerCase(); const bn = b.name.toLowerCase();
      if (raw) {
        const tokens = raw.split(/\s+/).filter(Boolean);
        const score = (m: any, name: string) => {
          if (name.startsWith(raw)) return 0;
          const words = name.split(/[^a-z0-9]+/);
          if (tokens.some(t => words.some((w: string) => w.startsWith(t)))) return 1;
          const skuWords = (m.sku || '').toLowerCase().split(/[^a-z0-9]+/);
          if (tokens.some(t => skuWords.some((w: string) => w.startsWith(t)))) return 2;
          return 3;
        };
        const sa = score(a, an), sb = score(b, bn);
        if (sa !== sb) return sa - sb;
      }
      return an.localeCompare(bn);
    });
    return list;  // no cap — the panel scrolls, search narrows
  }, [materials, query, onlyPurchased]);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full text-left bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-2 py-2 text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408] hover:bg-[#FFE9D4] flex items-center justify-between gap-2"
      >
        <span className="truncate" title={selected ? `${selected.sku ? selected.sku + ' · ' : ''}${selected.name}` : undefined}>
          {selected ? (
            <>
              <span className="text-[10px] font-mono text-[#8B7355] mr-1">{selected.sku || ''}</span>
              {selected.name}
            </>
          ) : (
            <span className="text-[#8B7355]">Select…</span>
          )}
        </span>
        <span className="text-xs text-[#8B7355]">▾</span>
      </button>

      {/* Portaled to <body> so ancestor transforms (modal animations, card
          hover-lift) can't re-anchor the fixed-position panel. */}
      {open && pos && typeof document !== 'undefined' && createPortal(
        <>
          {/* Click-outside backdrop */}
          <div className="fixed inset-0 z-[100]" onClick={() => setOpen(false)} />
          <div
            className="fixed z-[110] bg-white border border-[#D4B896] rounded-lg shadow-xl p-2 max-h-[380px] overflow-y-auto"
            style={{ top: pos.top, left: pos.left, width: pos.width }}
          >
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search by SKU or name… e.g. MAT-00042 or budweiser"
              className="w-full px-2 py-1.5 text-sm border border-[#E8D5C4] rounded-md focus:outline-none focus:border-[#af4408]"
            />
            <label className="flex items-center gap-1 mt-2 mb-1 text-[11px] text-[#6B5744]">
              <input type="checkbox" checked={onlyPurchased} onChange={e => setOnlyPurchased(e.target.checked)} />
              Show only materials with purchase history (price &gt; ₹0)
            </label>
            <div className="text-[10px] text-[#8B7355] px-1 mb-1">
              {filtered.length} of {materials.length} materials
            </div>
            <div className="space-y-0.5">
              {filtered.length === 0 ? (
                <div className="text-xs text-[#8B7355] text-center py-4">No matches</div>
              ) : filtered.map(m => (
                <button
                  type="button"
                  key={m.id}
                  onClick={() => { onChange(m.id); setOpen(false); setQuery(''); }}
                  className={`w-full text-left px-2 py-1.5 rounded text-xs flex items-center gap-2 hover:bg-[#FFF1E3] ${m.id === value ? 'bg-[#FFF1E3]' : ''}`}
                >
                  <span className="text-[10px] font-mono text-[#8B7355] w-16 shrink-0">{m.sku || '·'}</span>
                  <span className="flex-1 text-[#2D1B0E]" title={m.name}>{m.name}</span>
                  <span className="text-[10px] text-[#6B5744] shrink-0">{m.unit}</span>
                  <span className={`text-[10px] font-mono shrink-0 ${m.average_price > 0 ? 'text-[#6B5744]' : 'text-red-500'}`}>
                    ₹{m.average_price.toFixed(2)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </>,
        document.body
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- */
/* CategoryChip — click-to-edit category pill (list rows, cards,      */
/* detail header). Opens a fixed-position picker of existing          */
/* categories plus a free-text "New category" input.                  */
/* ----------------------------------------------------------------- */
function CategoryChip({
  value, categories, onPick,
}: {
  value: string;
  categories: string[];
  onPick: (category: string) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [custom, setCustom] = useState('');
  const [saving, setSaving] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  const MENU_W = 232;
  const computePos = useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Trigger scrolled fully out of view → close instead of floating detached
    if (r.bottom < 0 || r.top > window.innerHeight) { setOpen(false); return; }
    const menuH = Math.min(340, 96 + categories.length * 30);
    const below = r.bottom + 4;
    const top = below + menuH > window.innerHeight - 8 ? Math.max(8, r.top - menuH - 4) : below;
    let left = r.left;
    if (left + MENU_W > window.innerWidth - 8) left = window.innerWidth - MENU_W - 8;
    setPos({ top, left });
  }, [categories.length]);

  const openMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    computePos();
    setOpen(true);
  };

  // Keep the panel anchored to its trigger while the page (or any ancestor)
  // scrolls or the window resizes.
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    const onMove = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(computePos); };
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open, computePos]);

  const pick = async (c: string) => {
    const next = c.trim();
    if (!next || next === value) { setOpen(false); return; }
    setSaving(true);
    try {
      await onPick(next);
      setOpen(false);
      setCustom('');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={openMenu}
        title="Click to change category"
        className="inline-flex items-center gap-1 text-[12px] px-2 py-0.5 rounded-md bg-[#FFF1E3] border border-[#E8D5C4] text-[#6B5744] hover:border-[#af4408] hover:text-[#af4408] transition-colors"
      >
        <span className="truncate max-w-[160px]">{value || 'Set category'}</span>
        <Pencil size={11} className="shrink-0 opacity-60" />
      </button>
      {/* Portaled to <body>: the card under the cursor carries a hover-lift
          transform which would re-anchor position:fixed to the card. */}
      {open && pos && typeof document !== 'undefined' && createPortal(
        <>
          <div className="fixed inset-0 z-[100]" onClick={(e) => { e.stopPropagation(); setOpen(false); }} />
          <div
            className="fixed z-[110] bg-white border border-[#D4B896] rounded-lg shadow-xl p-2 w-[232px]"
            style={{ top: pos.top, left: pos.left }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[10px] font-semibold text-[#8B7355] uppercase tracking-wide px-1 mb-1">Change category</div>
            <div className="max-h-[220px] overflow-y-auto space-y-0.5">
              {categories.length === 0 && (
                <div className="text-xs text-[#8B7355] text-center py-2">No categories yet</div>
              )}
              {categories.map((c) => (
                <button
                  key={c}
                  type="button"
                  disabled={saving}
                  onClick={() => pick(c)}
                  className={`w-full text-left px-2 py-1.5 rounded text-xs hover:bg-[#FFF1E3] disabled:opacity-50 ${c === value ? 'bg-[#FFF1E3] font-semibold text-[#af4408]' : 'text-[#2D1B0E]'}`}
                >
                  {c}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1 mt-2 pt-2 border-t border-[#F0E4D6]">
              <input
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); pick(custom); } }}
                placeholder="New category…"
                className="flex-1 min-w-0 px-2 py-1.5 text-xs border border-[#E8D5C4] rounded-md focus:outline-none focus:border-[#af4408]"
              />
              <button
                type="button"
                disabled={saving || !custom.trim()}
                onClick={() => pick(custom)}
                className="text-xs px-2 py-1.5 rounded-md bg-[#af4408] text-white disabled:opacity-40"
              >
                {saving ? '…' : 'Set'}
              </button>
            </div>
          </div>
        </>,
        document.body
      )}
    </>
  );
}

/* ============================================================ */
/* Menu-item autocomplete — typeahead dropdown for recipe naming */
/* ============================================================ */
interface MenuItemLite {
  id: string; name: string; item_code?: string; category?: string;
  selling_price?: number; recipe_id?: string;
}

function MenuItemAutocomplete({
  value, menuItems, formMenuItemId, formPosItemId,
  onTextChange, onPick,
}: {
  value: string;
  menuItems: MenuItemLite[];
  formMenuItemId: string;
  formPosItemId: string;
  onTextChange: (typed: string) => void;
  onPick: (picked: MenuItemLite) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  // Filter list — case-insensitive contains across name + item_code + category.
  // Empty query shows everything (capped). One-letter query is the common
  // case the user wants supported — it just matches via .includes().
  const filtered = useMemo(() => {
    const q = value.trim().toLowerCase();
    const all = menuItems.filter(mi => {
      if (!q) return true;
      const hay = `${mi.name} ${mi.item_code || ''} ${mi.category || ''}`.toLowerCase();
      return hay.includes(q);
    });
    // Sort: items starting with the query first (alphabetic), then the rest
    if (q) {
      all.sort((a, b) => {
        const an = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bn = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        if (an !== bn) return an - bn;
        return a.name.localeCompare(b.name);
      });
    }
    return all.slice(0, 200); // cap to keep DOM light
  }, [menuItems, value]);

  // Reset highlight when filter changes
  useEffect(() => { setActiveIdx(0); }, [value, open]);

  const choose = (mi: MenuItemLite) => {
    onPick(mi);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      setOpen(true); e.preventDefault(); return;
    }
    if (!open) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') {
      if (filtered[activeIdx]) { e.preventDefault(); choose(filtered[activeIdx]); }
    }
    else if (e.key === 'Escape') { setOpen(false); }
  };

  return (
    <div ref={wrapRef} className="flex flex-col sm:flex-row gap-2 relative">
      <div className="flex-1 relative">
        <input
          type="text"
          autoComplete="off"
          className="w-full bg-white border border-[#D4B896] rounded-lg px-3 py-2.5 text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
          value={value}
          onChange={e => { onTextChange(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Type any letter to filter — Butter Chicken, Naan, B…"
        />
        {open && filtered.length > 0 && (
          <ul className="absolute z-30 mt-1 left-0 right-0 max-h-72 overflow-y-auto bg-white border border-[#D4B896] rounded-lg shadow-lg">
            {filtered.map((mi, i) => {
              const alreadyLinked = !!mi.recipe_id;
              const active = i === activeIdx;
              return (
                <li key={mi.id}
                    onMouseDown={(e) => { e.preventDefault(); choose(mi); }}
                    onMouseEnter={() => setActiveIdx(i)}
                    className={`px-3 py-2 text-sm cursor-pointer flex items-center justify-between gap-3 ${active ? 'bg-[#FFF1E3]' : 'hover:bg-[#FFF8F0]'}`}>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-[#2D1B0E] truncate">{mi.name}</div>
                    <div className="text-[10px] text-[#8B7355] flex gap-1.5 flex-wrap mt-0.5">
                      {mi.category && <span>{mi.category}</span>}
                      {mi.item_code && <span className="font-mono">#{mi.item_code}</span>}
                      {mi.selling_price ? <span>₹{mi.selling_price}</span> : null}
                    </div>
                  </div>
                  {alreadyLinked && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 whitespace-nowrap">
                      already linked
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {open && filtered.length === 0 && value.trim() && (
          <div className="absolute z-30 mt-1 left-0 right-0 bg-white border border-[#D4B896] rounded-lg shadow-lg p-3 text-xs text-[#8B7355]">
            No menu items match "{value}". You can still create the recipe with this name.
          </div>
        )}
      </div>
      {formMenuItemId && (
        <div className="text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2 flex items-center gap-1 whitespace-nowrap">
          ✓ Linked{formPosItemId && <span className="text-[#6B5744]">· POS #{formPosItemId}</span>}
        </div>
      )}
    </div>
  );
}
