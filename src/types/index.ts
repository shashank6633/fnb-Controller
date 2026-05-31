// ============================================================
// F&B Controller - Type Definitions
// ============================================================

export type CostingMethod = 'average' | 'fifo';
export type BillType = 'normal' | 'nc' | 'complimentary';
export type UserRole = 'admin' | 'manager' | 'kitchen';
export type UnitType = 'kg' | 'g' | 'ml' | 'l' | 'pcs' | 'bottle' | 'dozen' | 'bunch';
export type Category = 'veg' | 'non-veg' | 'bar' | 'grocery' | 'dairy' | 'bakery' | 'spices' | 'beverages' | 'packaging' | 'other';

// ---- RAW MATERIALS & PURCHASES ----
export interface RawMaterial {
  id: string;
  name: string;
  category: Category;
  unit: UnitType;
  current_stock: number;
  reorder_level: number;
  costing_method: CostingMethod;
  average_price: number;
  created_at: string;
  updated_at: string;
}

export interface Purchase {
  id: string;
  material_id: string;
  material_name?: string;
  vendor: string;
  brand: string;
  quantity: number;
  unit_price: number;
  total_price: number;
  date: string;
  notes?: string;
  created_at: string;
}

export interface Vendor {
  id: string;
  name: string;
  contact?: string;
  materials: string[];
}

// ---- INVENTORY ----
export interface InventoryItem extends RawMaterial {
  last_purchase_price: number;
  last_purchase_date: string;
  total_consumed: number;
  stock_value: number;
}

export interface StockAlert {
  material_id: string;
  material_name: string;
  current_stock: number;
  reorder_level: number;
  unit: UnitType;
  deficit: number;
}

// ---- RECIPES ----
export interface SubRecipe {
  id: string;
  name: string;
  category: string;
  yield_quantity: number;
  yield_unit: UnitType;
  cost_per_unit: number;
  total_cost: number;
  version: number;
  is_active: boolean;
  ingredients: SubRecipeIngredient[];
  created_at: string;
  updated_at: string;
}

export interface SubRecipeIngredient {
  id: string;
  sub_recipe_id: string;
  material_id: string;
  material_name?: string;
  quantity: number;
  unit: UnitType;
  yield_percent: number;
  wastage_percent: number;
  is_default: boolean;
  brand_preference?: string;
  effective_quantity?: number;
  cost?: number;
}

export interface Recipe {
  id: string;
  name: string;
  category: string;
  selling_price: number;
  total_cost: number;
  profit: number;
  food_cost_percent: number;
  version: number;
  is_active: boolean;
  ingredients: RecipeIngredient[];
  sub_recipes: RecipeSubRecipe[];
  created_at: string;
  updated_at: string;
}

export interface RecipeIngredient {
  id: string;
  recipe_id: string;
  material_id: string;
  material_name?: string;
  quantity: number;
  unit: UnitType;
  yield_percent: number;
  wastage_percent: number;
  is_default: boolean;
  brand_preference?: string;
  effective_quantity?: number;
  cost?: number;
}

export interface RecipeSubRecipe {
  id: string;
  recipe_id: string;
  sub_recipe_id: string;
  sub_recipe_name?: string;
  quantity: number;
  unit: UnitType;
  cost?: number;
}

// ---- MENU ITEMS ----
export interface MenuItem {
  id: string;
  name: string;
  recipe_id: string;
  category: string;
  selling_price: number;
  is_active: boolean;
}

// ---- SALES ----
export interface SaleRecord {
  id: string;
  item_name: string;
  recipe_id?: string;
  quantity_sold: number;
  bill_type: BillType;
  selling_price: number;
  total_revenue: number;
  total_cost: number;
  date: string;
  created_at: string;
}

export interface SalesUpload {
  item_name: string;
  quantity_sold: number;
  bill_type: BillType;
  date: string;
  selling_price?: number;
}

// ---- REPORTS ----
export interface ItemPnL {
  item_name: string;
  quantity_sold: number;
  revenue: number;
  cost: number;
  profit: number;
  food_cost_percent: number;
  nc_quantity: number;
  nc_cost: number;
}

export interface PeriodReport {
  period: string;
  total_sales: number;
  total_cost: number;
  gross_profit: number;
  gross_margin: number;
  nc_count: number;
  nc_cost: number;
  complimentary_count: number;
  complimentary_cost: number;
  operational_leakage: number;
  top_sellers: { name: string; quantity: number }[];
  most_profitable: { name: string; profit: number }[];
  loss_makers: { name: string; profit: number }[];
  high_food_cost: { name: string; percent: number }[];
}

// ---- DASHBOARD ----
export interface DashboardData {
  total_revenue: number;
  total_cost: number;
  gross_profit: number;
  gross_margin: number;
  nc_loss: number;
  total_items_sold: number;
  low_stock_count: number;
  active_recipes: number;
  daily_trend: { date: string; revenue: number; cost: number; profit: number }[];
  top_sellers: { name: string; quantity: number; revenue: number }[];
  most_profitable: { name: string; profit: number; margin: number }[];
  loss_makers: { name: string; profit: number; food_cost_percent: number }[];
  category_breakdown: { category: string; revenue: number; cost: number }[];
  nc_impact: { date: string; nc_cost: number; nc_count: number }[];
  stock_alerts: StockAlert[];
  consumption_trend: { material: string; consumed: number; remaining: number }[];
  // Purchase-vs-sale monthly comparison (top-of-dashboard chart)
  purchase_vs_sale?: {
    period: string;             // e.g. "2026-04"
    purchases: number;          // ₹ total purchase spend that month
    sales: number;              // ₹ revenue that month
    diff: number;               // sales - purchases
  }[];
  total_purchase_spend?: number;
  total_purchase_count?: number;
}
