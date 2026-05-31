'use client';

import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  Upload,
  Plus,
  FileSpreadsheet,
  Trash2,
  CheckCircle,
  AlertCircle,
  Loader2,
  TrendingUp,
  TrendingDown,
  DollarSign,
  BarChart3,
  Package,
  Target,
  Clock,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, PieChart, Pie, Cell, Legend,
} from 'recharts';
import { Search, Calendar, Download, Filter as FilterIcon, ArrowUp, ArrowDown, ChevronLeft, ChevronRight, Flame } from 'lucide-react';
import Papa from 'papaparse';
import type { Recipe, SaleRecord, BillType } from '@/types';
import { api } from '@/lib/api';

function formatCurrency(value: number): string {
  return '\u20B9' + value.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function todayISO(): string {
  const d = new Date();
  return d.toISOString().split('T')[0];
}

function sevenDaysAgoISO(): string {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString().split('T')[0];
}

interface ManualRow {
  item_name: string;
  recipe_id: string;
  quantity_sold: number;
  bill_type: BillType;
  selling_price: number;
  date: string;
}

interface ParsedRow {
  item_name: string;
  quantity_sold: number;
  bill_type: string;
  date: string;
  selling_price: number;
  sale_time?: string;
  order_id?: string;
  category?: string;
  server?: string;
  order_type?: string;
  pos_item_id?: string;
  pos_item_name?: string;
  variant_name?: string;
}

function emptyRow(): ManualRow {
  return {
    item_name: '',
    recipe_id: '',
    quantity_sold: 1,
    bill_type: 'normal',
    selling_price: 0,
    date: todayISO(),
  };
}

function LoadingSkeleton() {
  return (
    <div className="min-h-screen bg-[#FFF8F0] p-6 animate-pulse">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="h-9 w-48 bg-[#FFF1E3] rounded-lg" />
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="bg-white border border-[#E8D5C4] rounded-xl p-6 h-28" />
          ))}
        </div>
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 h-64" />
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 h-80" />
      </div>
    </div>
  );
}

export default function SalesUploadPage() {
  const [activeTab, setActiveTab] = useState<'csv' | 'manual'>('csv');
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [recentSales, setRecentSales] = useState<SaleRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // CSV state
  const [parsedData, setParsedData] = useState<ParsedRow[]>([]);
  const [csvFileName, setCsvFileName] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<{ success: number; errors: string[] } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Manual state
  const [manualRows, setManualRows] = useState<ManualRow[]>([emptyRow()]);
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<{ success: number; errors: string[] } | null>(null);

  // Analytics period: 7d, 30d, 90d, all
  const [analyticsPeriod, setAnalyticsPeriod] = useState<'7d' | '30d' | '90d' | 'all'>('7d');

  // ===== New v2 state: filters, analytics, paginated list =====
  const [filterFrom, setFilterFrom]     = useState<string>(() => {
    const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().split('T')[0];
  });
  const [filterTo, setFilterTo]         = useState<string>(todayISO);
  const [filterBillType, setFilterBillType] = useState<string>('');
  const [filterCategory, setFilterCategory] = useState<string>('');
  const [filterSearch, setFilterSearch] = useState<string>('');
  const [recahoModalOpen, setRecahoModalOpen] = useState(false);
  // When the legacy CSV uploader detects a Recaho file, it stashes the File here
  // so the Recaho modal opens with it already selected — saves a re-pick.
  const [recahoPrefillFile, setRecahoPrefillFile] = useState<File | null>(null);

  const [v2Analytics, setV2Analytics] = useState<any>(null);
  const [v2Loading,   setV2Loading]   = useState<boolean>(false);
  const [v2Error,     setV2Error]     = useState<string | null>(null);

  // Paginated list
  const [listPage,    setListPage]    = useState<number>(0);
  const [listSort,    setListSort]    = useState<string>('date');
  const [listDir,     setListDir]     = useState<'asc' | 'desc'>('desc');
  const [listRows,    setListRows]    = useState<any[]>([]);
  const [listTotal,   setListTotal]   = useState<number>(0);
  const [listLoading, setListLoading] = useState<boolean>(false);
  const LIST_PAGE_SIZE = 50;

  const buildFilterQS = () => {
    const qs = new URLSearchParams();
    qs.set('from', filterFrom);
    qs.set('to',   filterTo);
    if (filterBillType) qs.set('bill_type', filterBillType);
    if (filterCategory) qs.set('category',  filterCategory);
    if (filterSearch)   qs.set('search',    filterSearch);
    return qs.toString();
  };

  const loadV2Analytics = useCallback(async () => {
    try {
      setV2Loading(true); setV2Error(null);
      const res = await fetch(`/api/sales/analytics?${buildFilterQS()}`);
      if (!res.ok) { const t = await res.text(); throw new Error(t); }
      const json = await res.json();
      setV2Analytics(json);
    } catch (e: any) { setV2Error(e.message); }
    finally { setV2Loading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterFrom, filterTo, filterBillType, filterCategory, filterSearch]);

  const loadV2List = useCallback(async () => {
    try {
      setListLoading(true);
      const qs = new URLSearchParams(buildFilterQS());
      qs.set('limit',  String(LIST_PAGE_SIZE));
      qs.set('offset', String(listPage * LIST_PAGE_SIZE));
      qs.set('sort',   listSort);
      qs.set('dir',    listDir);
      const res = await fetch(`/api/sales?${qs}`);
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json();
      setListRows(json.sales || []);
      setListTotal(json.total || 0);
    } catch (e: any) { /* swallow for now */ }
    finally { setListLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterFrom, filterTo, filterBillType, filterCategory, filterSearch, listPage, listSort, listDir]);

  useEffect(() => { loadV2Analytics(); }, [loadV2Analytics]);
  useEffect(() => { loadV2List(); }, [loadV2List]);
  // When filters change, reset pagination to page 0
  useEffect(() => { setListPage(0); },
    [filterFrom, filterTo, filterBillType, filterCategory, filterSearch]);

  const applyPreset = (preset: 'today' | '7d' | '30d' | '90d' | 'mtd' | 'last_month' | 'ytd') => {
    const today = new Date();
    const set = (f: Date, t: Date) => {
      setFilterFrom(f.toISOString().split('T')[0]);
      setFilterTo(t.toISOString().split('T')[0]);
    };
    if (preset === 'today')      set(today, today);
    else if (preset === '7d')    { const f = new Date(today); f.setDate(f.getDate() - 6);  set(f, today); }
    else if (preset === '30d')   { const f = new Date(today); f.setDate(f.getDate() - 29); set(f, today); }
    else if (preset === '90d')   { const f = new Date(today); f.setDate(f.getDate() - 89); set(f, today); }
    else if (preset === 'mtd')   { const f = new Date(today.getFullYear(), today.getMonth(), 1); set(f, today); }
    else if (preset === 'last_month') {
      const f = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const t = new Date(today.getFullYear(), today.getMonth(), 0);
      set(f, t);
    }
    else if (preset === 'ytd')   { const f = new Date(today.getFullYear(), 0, 1); set(f, today); }
  };

  const deleteSaleRow = async (id: string) => {
    if (!confirm('Delete this sale row? This cannot be undone.')) return;
    try {
      const res = await api(`/api/sales?id=${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text());
      // Reload
      loadV2List();
      loadV2Analytics();
    } catch (e: any) {
      alert('Delete failed: ' + e.message);
    }
  };

  const exportListCsv = () => {
    if (listRows.length === 0) return;
    const headers = ['date', 'sale_time', 'item_name', 'category', 'quantity_sold', 'selling_price', 'total_revenue', 'total_cost', 'bill_type', 'order_id', 'server'];
    const lines = [headers.join(',')];
    for (const r of listRows) {
      const vals = headers.map(h => {
        const v = (r as any)[h === 'category' ? 'resolved_category' : h];
        if (v === null || v === undefined) return '';
        const s = String(v).replace(/"/g, '""');
        return s.includes(',') ? `"${s}"` : s;
      });
      lines.push(vals.join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sales-${filterFrom}-to-${filterTo}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const toggleSort = (col: string) => {
    if (listSort === col) setListDir(listDir === 'asc' ? 'desc' : 'asc');
    else { setListSort(col); setListDir('desc'); }
  };

  // Summary
  const todaySales = recentSales.filter((s) => s.date === todayISO());
  const todayRevenue = todaySales.reduce((sum, s) => sum + s.total_revenue, 0);
  const todayNCCount = todaySales.filter((s) => s.bill_type === 'nc').length;
  const weekCutoff = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
  const weekSales = recentSales.filter((s) => s.date >= weekCutoff);
  const weekRevenue = weekSales.reduce((sum, s) => sum + s.total_revenue, 0);
  const weekNCLoss = weekSales
    .filter((s) => s.bill_type === 'nc')
    .reduce((sum, s) => sum + s.total_cost, 0);

  const fetchData = useCallback(async () => {
    // Do NOT block initial render on /api/recipes (it's slow with 105 recipes × ingredients joined).
    // Analytics + paginated list render immediately; recipes load in the background
    // and are only needed for the Manual Entry dropdown.
    setLoading(false);
    setError(null);
    setRecentSales([]);
    try {
      const recipesRes = await fetch('/api/recipes');
      if (!recipesRes.ok) return;
      const recipesJson = await recipesRes.json();
      setRecipes(recipesJson.recipes || []);
    } catch (_) { /* ignore — manual entry will show "Loading recipes…" until it arrives */ }
  }, []);

  // Analytics — filter sales by period and compute aggregates
  const analytics = useMemo(() => {
    const now = new Date();
    const daysBack = analyticsPeriod === '7d' ? 7 : analyticsPeriod === '30d' ? 30 : analyticsPeriod === '90d' ? 90 : 9999;
    const cutoff = new Date(now.getTime() - daysBack * 86400000).toISOString().split('T')[0];
    const periodSales = recentSales.filter(s => s.date >= cutoff);

    // Aggregate by item_name
    const byItem = new Map<string, {
      name: string; qty: number; revenue: number; cost: number;
      profit: number; margin: number; nc_count: number; nc_cost: number;
      bill_count: number;
    }>();

    for (const s of periodSales) {
      const key = s.item_name;
      if (!byItem.has(key)) {
        byItem.set(key, { name: s.item_name, qty: 0, revenue: 0, cost: 0, profit: 0, margin: 0, nc_count: 0, nc_cost: 0, bill_count: 0 });
      }
      const agg = byItem.get(key)!;
      agg.qty += s.quantity_sold;
      agg.revenue += s.total_revenue;
      agg.cost += s.total_cost;
      agg.bill_count += 1;
      if (s.bill_type === 'nc' || s.bill_type === 'complimentary') {
        agg.nc_count += 1;
        agg.nc_cost += s.total_cost;
      }
    }
    // Compute derived
    const items = [...byItem.values()].map(i => ({
      ...i,
      profit: Math.round((i.revenue - i.cost) * 100) / 100,
      margin: i.revenue > 0 ? Math.round(((i.revenue - i.cost) / i.revenue) * 1000) / 10 : 0,
    }));

    // Top sellers (by qty)
    const topByQty = [...items].sort((a, b) => b.qty - a.qty).slice(0, 10);
    // Top revenue
    const topByRevenue = [...items].sort((a, b) => b.revenue - a.revenue).slice(0, 10);
    // Most profitable
    const topByProfit = [...items].filter(i => i.revenue > 0).sort((a, b) => b.profit - a.profit).slice(0, 10);
    // Slow movers (sold but least)
    const slowMovers = [...items].filter(i => i.qty > 0).sort((a, b) => a.qty - b.qty).slice(0, 10);
    // Highest NC / Complimentary items (leakage)
    const topNC = [...items].filter(i => i.nc_count > 0).sort((a, b) => b.nc_cost - a.nc_cost).slice(0, 10);

    // Dead stock — menu items with NO sales in period
    const soldNames = new Set(items.map(i => i.name.toLowerCase()));
    const activeRecipes = recipes.filter(r => r.is_active);
    const deadStock = activeRecipes.filter(r => !soldNames.has(r.name.toLowerCase())).slice(0, 20);

    // Totals
    const totalRevenue = items.reduce((s, i) => s + i.revenue, 0);
    const totalCost = items.reduce((s, i) => s + i.cost, 0);
    const totalQty = items.reduce((s, i) => s + i.qty, 0);
    const uniqueItems = items.length;

    return {
      periodSales, items, topByQty, topByRevenue, topByProfit, slowMovers, topNC, deadStock,
      totalRevenue, totalCost, totalProfit: totalRevenue - totalCost,
      avgMargin: totalRevenue > 0 ? Math.round(((totalRevenue - totalCost) / totalRevenue) * 1000) / 10 : 0,
      totalQty, uniqueItems,
    };
  }, [recentSales, recipes, analyticsPeriod]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // ---- CSV / Excel parsing ----
  const handleFile = async (file: File) => {
    setUploadResult(null);
    setCsvFileName(file.name);

    // Helper: get value from row by trying multiple keys (case-insensitive, space-insensitive)
    const pickField = (row: any, patterns: (string | RegExp)[]): any => {
      if (!row) return undefined;
      const keys = Object.keys(row);
      // Exact string match first
      for (const p of patterns) {
        if (typeof p === 'string') {
          if (row[p] !== undefined && row[p] !== null && row[p] !== '') return row[p];
        }
      }
      // Then loose match — normalize whitespace/case
      for (const key of keys) {
        const normKey = String(key).toLowerCase().replace(/[\s_-]+/g, '').trim();
        for (const p of patterns) {
          const target = typeof p === 'string' ? p.toLowerCase().replace(/[\s_-]+/g, '').trim() : null;
          if (target && normKey === target) {
            if (row[key] !== undefined && row[key] !== null && row[key] !== '') return row[key];
          }
          if (p instanceof RegExp && p.test(String(key))) {
            if (row[key] !== undefined && row[key] !== null && row[key] !== '') return row[key];
          }
        }
      }
      return undefined;
    };

    const mapSaleRows = (rows: any[]): ParsedRow[] => {
      return rows.map((r: any) => {
        // Item name — prefer exact "Item Name" / "Product Name" / "Menu Item".
        // DO NOT fall back to /item/i (matches Item Type, Item Status, Item Unit).
        const itemName = pickField(r, [
          'item_name', 'itemname', 'item name',
          'product name', 'productname', 'product_name',
          'menu item', 'menuitem', 'menu_item',
          'dish name', 'dishname', 'dish',
          /^item\s*name$/i, /^product\s*name$/i, /^menu\s*item$/i, /^dish\s*name$/i,
        ]) || '';

        // Qty — avoid matching "Tax Quantity" etc. by using anchored patterns
        const qtySold = Number(pickField(r, [
          'quantity_sold', 'quantitysold', 'qty sold', 'qty_sold',
          'quantity', 'qty', 'count', 'units',
          /^qty$/i, /^quantity$/i,
        ]) || 0);

        // Bill type — avoid "Item Status", "Order Status"
        const billTypeRaw = pickField(r, [
          'bill_type', 'billtype', 'bill type',
          'bill status', 'billstatus',
          'sale type', 'saletype',
          /^bill[\s_-]*type$/i, /^bill[\s_-]*status$/i,
        ]) || 'normal';
        const billType = String(billTypeRaw).toLowerCase().trim();

        // Selling price — prefer Rate, then specific amount columns.
        // Avoid Tax Amount, Service Charge Amount, Discount Amount.
        let sellingPrice = Number(pickField(r, [
          'selling_price', 'saleprice', 'sale price',
          'unit price', 'unit_price', 'unitprice',
          'rate', 'net rate', 'netrate', 'net_rate',
          'price', 'mrp', 'list price',
          /^rate$/i, /^price$/i, /^unit\s*price$/i, /^selling\s*price$/i,
        ]) || 0);

        // Fallback: derive rate from Amount / Qty if rate wasn't present
        if (!sellingPrice) {
          const amount = Number(pickField(r, [
            'amount before tax', 'amountbeforetax', 'amount_before_tax',
            'net amount', 'netamount', 'net_amount',
            'total amount', 'totalamount', 'total_amount', 'total',
            'amount',
            /^amount\s*before\s*tax$/i, /^net\s*amount$/i, /^total\s*amount$/i, /^amount$/i,
          ]) || 0);
          if (amount && qtySold) sellingPrice = amount / qtySold;
          else sellingPrice = amount;
        }

        const dateRaw = pickField(r, [
          'date', 'sale date', 'saledate', 'bill date', 'billdate',
          'transaction date', 'invoice date',
          'order date', 'orderdate',
          'order date and time', 'orderdateandtime', 'date and time', 'dateandtime',
          /^date$/i, /^order\s*date/i, /^bill\s*date$/i, /^sale\s*date$/i, /date/i,
        ]) || '';
        let date: any = dateRaw;

        // Extract HH:MM time from the same field (many POS exports combine date+time)
        let saleTime: string | undefined = undefined;
        const dateStr = typeof dateRaw === 'string' ? dateRaw : '';
        // Common patterns: "21 Apr 2026 08:32 PM", "2026-04-21 20:32:00", "21/04/2026 20:32"
        const timeMatch =
          dateStr.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*([APap][Mm])/) ||
          dateStr.match(/(\d{1,2}):(\d{2})(?::\d{2})?/);
        if (timeMatch) {
          let h = parseInt(timeMatch[1], 10);
          const m = parseInt(timeMatch[2], 10);
          const mer = timeMatch[3]?.toUpperCase();
          if (mer === 'PM' && h < 12) h += 12;
          if (mer === 'AM' && h === 12) h = 0;
          saleTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        } else if (typeof dateRaw === 'number') {
          // Excel serial — may include fractional day for time
          const frac = dateRaw - Math.floor(dateRaw);
          if (frac > 0) {
            const totalMin = Math.round(frac * 24 * 60);
            const h = Math.floor(totalMin / 60);
            const m = totalMin % 60;
            saleTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
          }
        }
        if (date) {
          // Excel date serial
          if (typeof date === 'number') {
            const excelDate = new Date((date - 25569) * 86400 * 1000);
            date = excelDate.toISOString().split('T')[0];
          } else {
            const s = String(date).trim();
            // DD/MM/YYYY or DD-MM-YYYY
            const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
            if (dmy) {
              date = `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
            } else {
              // YYYY-MM-DD already good, or ISO datetime
              const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
              if (iso) date = `${iso[1]}-${iso[2]}-${iso[3]}`;
              else {
                // Try parsing as Date
                const d = new Date(s);
                if (!isNaN(d.getTime())) date = d.toISOString().split('T')[0];
              }
            }
          }
        }
        if (!date) date = todayISO();

        // Normalize bill_type
        let normalizedBillType = 'normal';
        if (billType.includes('nc') || billType.includes('non-charg') || billType.includes('noncharg')) normalizedBillType = 'nc';
        else if (billType.includes('comp') || billType.includes('complim') || billType.includes('free')) normalizedBillType = 'complimentary';

        // Extra POS fields (optional — power richer analytics)
        const orderId = String(pickField(r, [
          'order_id', 'orderid', 'order id', 'bill no', 'billno', 'bill_no', 'invoice no', 'invoiceno', 'invoice_no', 'kot no',
          /^order\s*id$/i, /^bill\s*no$/i, /^invoice\s*no$/i,
        ]) || '').trim() || undefined;

        const categoryRaw = String(pickField(r, [
          'category', 'category name', 'categoryname', 'display group',
          'item type', 'itemtype', 'item_type',
          /^category/i, /^display\s*group$/i,
        ]) || '').trim().toLowerCase();
        // Normalize common POS category buckets
        let category: string | undefined = undefined;
        if (categoryRaw) {
          if (categoryRaw.includes('liquor') || categoryRaw.includes('bar')) category = 'liquor';
          else if (categoryRaw.includes('beverage') || categoryRaw.includes('drink')) category = 'beverages';
          else if (categoryRaw.includes('food') || categoryRaw.includes('kitchen')) category = 'food';
          else category = categoryRaw;
        }

        const server = String(pickField(r, [
          'server', 'waiter', 'order created by', 'ordercreatedby', 'captain', 'staff',
          /created\s*by$/i, /^server$/i, /^waiter$/i, /^captain$/i,
        ]) || '').trim() || undefined;

        const orderType = String(pickField(r, [
          'order type', 'ordertype', 'order_type', 'sale type',
          /^order\s*type$/i, /^sale\s*type$/i,
        ]) || '').trim().toLowerCase() || undefined;

        // POS product id — stable key to link sales to menu_items / recipes
        // Recaho calls this "Mapped Code"; other POSes use "Item Code", "Product Code", "SKU", "Item ID"
        const posItemId = String(pickField(r, [
          'mapped code', 'mappedcode', 'mapped_code',
          'item code', 'itemcode', 'item_code',
          'product code', 'productcode', 'product_code',
          'pos id', 'posid', 'pos_id',
          'item id', 'itemid', 'item_id',
          'sku', 'hsn code', 'hsncode', 'hsn_code',
          /^mapped\s*code$/i, /^item\s*code$/i, /^product\s*code$/i, /^item\s*id$/i, /^sku$/i,
        ]) || '').trim() || undefined;

        // Product Name (pre-variant) + Variant
        const posItemName = String(pickField(r, [
          'product name', 'productname', 'product_name', /^product\s*name$/i,
        ]) || '').trim() || undefined;

        const variantName = String(pickField(r, [
          'variant name', 'variantname', 'variant_name', 'variant', /^variant/i,
        ]) || '').trim() || undefined;

        return {
          item_name: String(itemName).trim(),
          quantity_sold: qtySold,
          bill_type: normalizedBillType,
          date: String(date),
          selling_price: sellingPrice,
          sale_time: saleTime,
          order_id: orderId,
          category,
          server,
          order_type: orderType,
          pos_item_id: posItemId,
          pos_item_name: posItemName,
          variant_name: variantName,
        };
      }).filter((r) => r.item_name);
    };

    const lowerName = file.name.toLowerCase();
    if (lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls') || lowerName.endsWith('.vlsx')) {
      try {
        const XLSX = await import('xlsx');
        if (!XLSX || typeof XLSX.read !== 'function') {
          throw new Error('Excel library failed to load. Do a hard refresh: Cmd+Shift+R (Mac) or Ctrl+Shift+R (Windows)');
        }
        const buffer = await file.arrayBuffer();
        const workbook = XLSX.read(buffer, { type: 'array' });
        if (!workbook || !workbook.SheetNames || workbook.SheetNames.length === 0) {
          throw new Error('Excel file appears to be empty or corrupted');
        }

        // ----- Detect Recaho "Item Wise Sales Report" format -----
        // Signature: a sheet whose name contains "Item Wise Sales" AND the file
        // has 3+ sheets including "Complimentary" and/or "Non Chargeable".
        // Recaho ships an aggregated multi-sheet workbook that the legacy CSV
        // pipeline can't parse — route the user to the dedicated importer.
        const sheetNamesLower = workbook.SheetNames.map(n => n.toLowerCase());
        const isRecaho =
          sheetNamesLower.some(n => n.includes('item wise sales'))
          && (sheetNamesLower.some(n => n.includes('complimentary')) ||
              sheetNamesLower.some(n => n.includes('non chargeable')) ||
              sheetNamesLower.some(n => n.includes('variant wise')));
        if (isRecaho) {
          setRecahoModalOpen(true);
          setRecahoPrefillFile(file);
          setUploadResult({
            success: 0,
            errors: [
              `Detected Recaho "Item Wise Sales Report" format — opening the dedicated importer for it (preserves Complimentary + Non-Chargeable sheets).`,
            ],
          });
          setCsvFileName(null);
          return;
        }

        // Try each sheet to find the one with sales data
        let rows: any[] = [];
        let usedSheetName = workbook.SheetNames[0];
        for (const sheetName of workbook.SheetNames) {
          const sheet = workbook.Sheets[sheetName];
          // Try different header rows (0, 1, 2, 3) — some reports have title rows
          for (let headerRow = 0; headerRow < 5; headerRow++) {
            const tryRows = XLSX.utils.sheet_to_json<any>(sheet, { range: headerRow });
            if (tryRows.length === 0) continue;
            const mapped = mapSaleRows(tryRows);
            if (mapped.length > 0) {
              rows = tryRows;
              usedSheetName = sheetName;
              setParsedData(mapped);
              setUploadResult(null);
              return;
            }
          }
        }

        // If we reach here, nothing parsed — show helpful diagnostics
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const rawRows = XLSX.utils.sheet_to_json<any>(firstSheet);
        const firstRowKeys = rawRows.length > 0 ? Object.keys(rawRows[0]) : [];
        setUploadResult({
          success: 0,
          errors: [
            `Could not find sales data in ${workbook.SheetNames.length > 1 ? `any of the ${workbook.SheetNames.length} sheets` : 'the sheet'}.`,
            `Available sheets: ${workbook.SheetNames.join(', ')}`,
            `Columns in first sheet: ${firstRowKeys.length > 0 ? firstRowKeys.join(', ') : '(no data rows found)'}`,
            `Expected columns: item_name, quantity_sold, selling_price, date, bill_type (any of: Item Name, Product, Menu Item, Quantity, Qty, Price, Amount, Sale Date)`,
          ],
        });
        setCsvFileName(null);
      } catch (err: any) {
        setUploadResult({ success: 0, errors: [`Failed to parse Excel: ${err.message}`] });
        setCsvFileName(null);
      }
    } else {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          setParsedData(mapSaleRows(results.data as any[]));
        },
      });
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  const downloadSampleTemplate = () => {
    const today = todayISO();
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const header = 'item_name,quantity_sold,selling_price,date,bill_type';
    const sampleRows = [
      `Murgh Dum Biryani,1,659,${today},normal`,
      `Margherita Pizza,2,499,${today},normal`,
      `Classic Mojito,3,299,${today},normal`,
      `Fresh Lime,1,249,${yesterday},nc`,
      `Paneer Tikka,1,449,${yesterday},complimentary`,
    ];
    const csv = [header, ...sampleRows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sales-sample-${today}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const uploadCSV = async () => {
    try {
      setUploading(true);
      setUploadResult(null);
      const res = await api('/api/sales', {
        method: 'POST',
        body: { sales: parsedData },
      });
      const json = await res.json();
      if (!res.ok) {
        setUploadResult({ success: 0, errors: [json.error || 'Upload failed'] });
      } else {
        setUploadResult({ success: json.sales?.length || 0, errors: [] });
        setParsedData([]);
        setCsvFileName(null);
        fetchData();
      }
    } catch (err: any) {
      setUploadResult({ success: 0, errors: [err.message] });
    } finally {
      setUploading(false);
    }
  };

  // ---- Manual entry ----
  const updateManualRow = (idx: number, field: keyof ManualRow, value: any) => {
    setManualRows((prev) => {
      const copy = [...prev];
      copy[idx] = { ...copy[idx], [field]: value };

      // Auto-fill selling price from recipe
      if (field === 'recipe_id' && value) {
        const recipe = recipes.find((r) => r.id === value);
        if (recipe) {
          copy[idx].selling_price = recipe.selling_price;
          copy[idx].item_name = recipe.name;
        }
      }
      return copy;
    });
  };

  const addRow = () => setManualRows((prev) => [...prev, emptyRow()]);
  const removeRow = (idx: number) =>
    setManualRows((prev) => (prev.length === 1 ? [emptyRow()] : prev.filter((_, i) => i !== idx)));

  const submitManual = async () => {
    try {
      setSubmitting(true);
      setSubmitResult(null);
      const payload = manualRows
        .filter((r) => r.item_name.trim())
        .map((r) => ({
          item_name: r.item_name,
          recipe_id: r.recipe_id || undefined,
          quantity_sold: r.quantity_sold,
          bill_type: r.bill_type,
          selling_price: r.selling_price,
          date: r.date,
        }));

      if (payload.length === 0) {
        setSubmitResult({ success: 0, errors: ['No valid rows to submit'] });
        return;
      }

      const res = await api('/api/sales', {
        method: 'POST',
        body: { sales: payload },
      });
      const json = await res.json();
      if (!res.ok) {
        setSubmitResult({ success: 0, errors: [json.error || 'Submit failed'] });
      } else {
        setSubmitResult({ success: json.sales?.length || 0, errors: [] });
        setManualRows([emptyRow()]);
        fetchData();
      }
    } catch (err: any) {
      setSubmitResult({ success: 0, errors: [err.message] });
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <LoadingSkeleton />;

  if (error) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] flex items-center justify-center">
        <div className="text-center space-y-4">
          <AlertCircle className="w-12 h-12 text-red-500 mx-auto" />
          <p className="text-[#6B5744] text-lg">Error: {error}</p>
          <button
            onClick={() => fetchData()}
            className="px-4 py-2 bg-[#FFF1E3] text-[#2D1B0E] rounded-lg hover:bg-[#FFF1E3] transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408]">Sales Upload</h1>
            <p className="text-[#8B7355] text-sm mt-1">Upload sales data via CSV/Excel or enter manually</p>
          </div>
          <button onClick={() => setRecahoModalOpen(true)}
                  className="px-3 py-2 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm flex items-center gap-2">
            <Upload className="w-4 h-4" /> Import Recaho Item-Wise Sales
          </button>
        </div>
        {recahoModalOpen && (
          <RecahoSalesImportModal
            initialFile={recahoPrefillFile}
            onClose={() => { setRecahoModalOpen(false); setRecahoPrefillFile(null); }}
            onCommitted={() => fetchData()} />
        )}

        {/* ===== v2 FILTER BAR ===== */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 shadow space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <FilterIcon className="w-4 h-4 text-[#af4408]" />
            <span className="text-sm font-semibold text-[#2D1B0E]">Filters</span>
            <span className="text-xs text-[#8B7355]">· {listTotal.toLocaleString('en-IN')} rows match</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
            <label className="text-xs text-[#6B5744] flex flex-col gap-1">
              <span className="flex items-center gap-1"><Calendar className="w-3 h-3" /> From</span>
              <input type="date" value={filterFrom} onChange={e=>setFilterFrom(e.target.value)}
                     className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
            </label>
            <label className="text-xs text-[#6B5744] flex flex-col gap-1">
              <span className="flex items-center gap-1"><Calendar className="w-3 h-3" /> To</span>
              <input type="date" value={filterTo} onChange={e=>setFilterTo(e.target.value)}
                     className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
            </label>
            <label className="text-xs text-[#6B5744] flex flex-col gap-1">
              <span>Bill type</span>
              <select value={filterBillType} onChange={e=>setFilterBillType(e.target.value)}
                      className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm">
                <option value="">All</option>
                <option value="normal">Normal</option>
                <option value="nc">NC</option>
                <option value="complimentary">Complimentary</option>
              </select>
            </label>
            <label className="text-xs text-[#6B5744] flex flex-col gap-1">
              <span>Category</span>
              <select value={filterCategory} onChange={e=>setFilterCategory(e.target.value)}
                      className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm">
                <option value="">All</option>
                {(v2Analytics?.categories || []).map((c: string) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </label>
            <label className="text-xs text-[#6B5744] flex flex-col gap-1 sm:col-span-2">
              <span className="flex items-center gap-1"><Search className="w-3 h-3" /> Item search</span>
              <input value={filterSearch} onChange={e=>setFilterSearch(e.target.value)}
                     placeholder="e.g. biryani, pizza, mojito…"
                     className="px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm" />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-[#8B7355]">Quick:</span>
            {([
              ['today', 'Today'], ['7d','7d'], ['30d','30d'], ['90d','90d'],
              ['mtd','MTD'], ['last_month','Last month'], ['ytd','YTD'],
            ] as const).map(([k, label]) => (
              <button key={k} onClick={()=>applyPreset(k as any)}
                      className="px-2.5 py-1 text-xs rounded-md bg-[#FFF1E3] text-[#6B5744] hover:bg-[#af4408] hover:text-white transition-colors">
                {label}
              </button>
            ))}
            {(filterBillType || filterCategory || filterSearch) && (
              <button onClick={()=>{ setFilterBillType(''); setFilterCategory(''); setFilterSearch(''); }}
                      className="px-2.5 py-1 text-xs rounded-md border border-[#E8D5C4] text-[#af4408] hover:bg-[#FFF1E3]">
                Clear filters
              </button>
            )}
          </div>
        </div>

        {/* ===== v2 COMPARISON KPI CARDS ===== */}
        <ComparisonKPIs loading={v2Loading} analytics={v2Analytics} />

        {/* ===== v2 PEAK CALLOUTS ===== */}
        {v2Analytics && <PeakCallouts analytics={v2Analytics} />}

        {/* ===== v2 CATEGORY MIX + DAILY TREND ===== */}
        {v2Analytics && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 bg-white border border-[#E8D5C4] rounded-xl p-4 shadow">
              <h3 className="text-sm font-semibold text-[#2D1B0E] mb-3 flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-[#af4408]" />
                Daily Revenue & Cost Trend
              </h3>
              <ResponsiveContainer width="100%" height={240}>
                <LineChart data={v2Analytics.dailyTrend}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E8D5C4" />
                  <XAxis dataKey="date" stroke="#8B7355" fontSize={10}
                         tickFormatter={(v) => new Date(v).toLocaleDateString('en-IN', { day:'2-digit', month:'short' })} />
                  <YAxis stroke="#8B7355" fontSize={10} tickFormatter={v => `₹${(v/1000).toFixed(0)}k`} />
                  <Tooltip contentStyle={{ backgroundColor:'#fff', border:'1px solid #E8D5C4', borderRadius:8, fontSize:12 }}
                           formatter={(v: any) => formatCurrency(Number(v))} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line type="monotone" dataKey="revenue" name="Revenue" stroke="#10B981" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="cost"    name="Cost"    stroke="#DC2626" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="nc_cost" name="NC Cost" stroke="#D97706" strokeWidth={2} strokeDasharray="4 4" dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 shadow">
              <h3 className="text-sm font-semibold text-[#2D1B0E] mb-3 flex items-center gap-2">
                <Target className="w-4 h-4 text-[#af4408]" />
                Category Mix
              </h3>
              {v2Analytics.byCategory.length === 0 ? (
                <p className="text-center text-xs text-[#8B7355] py-8">No data</p>
              ) : (
                <>
                  <ResponsiveContainer width="100%" height={180}>
                    <PieChart>
                      <Pie data={v2Analytics.byCategory} dataKey="revenue" nameKey="category" cx="50%" cy="50%"
                           innerRadius={45} outerRadius={75}>
                        {v2Analytics.byCategory.map((_: any, i: number) => (
                          <Cell key={i} fill={['#af4408','#10B981','#F59E0B','#6366F1','#EC4899','#14B8A6','#8B5CF6'][i % 7]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(v: any) => formatCurrency(Number(v))}
                               contentStyle={{ fontSize:12, borderRadius:8 }} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="space-y-1 mt-2 max-h-32 overflow-y-auto">
                    {v2Analytics.byCategory.slice(0, 6).map((c: any, i: number) => (
                      <div key={i} className="flex items-center justify-between text-xs">
                        <div className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full" style={{ background: ['#af4408','#10B981','#F59E0B','#6366F1','#EC4899','#14B8A6','#8B5CF6'][i % 7] }} />
                          <span className="text-[#2D1B0E] capitalize">{c.category}</span>
                        </div>
                        <span className="font-mono text-[#6B5744]">{formatCurrency(c.revenue)}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* ===== v2 HOURLY × WEEKDAY HEATMAP ===== */}
        {v2Analytics && <HourlyHeatmap heatmap={v2Analytics.heatmap} />}

        {/* ===== v2 TOP ITEMS ===== */}
        {v2Analytics && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <TopItemsCard title="Top 10 by Revenue" icon={<DollarSign className="w-4 h-4 text-[#af4408]" />}
                          items={v2Analytics.topByRevenue} metric="revenue" />
            <TopItemsCard title="Top 10 by Quantity" icon={<TrendingUp className="w-4 h-4 text-green-600" />}
                          items={v2Analytics.topByQty} metric="qty" />
          </div>
        )}

        {/* ===== v2 NC LEAKAGE ===== */}
        {v2Analytics && v2Analytics.topNC.length > 0 && (
          <div className="bg-white border border-amber-200 rounded-xl p-4 shadow">
            <h3 className="text-sm font-semibold text-amber-800 mb-3 flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />
              Top NC / Complimentary Items — Leakage
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-[#8B7355]">
                  <tr><th className="text-left py-1 px-2 text-xs font-medium">Item</th>
                      <th className="text-right py-1 px-2 text-xs font-medium">NC Count</th>
                      <th className="text-right py-1 px-2 text-xs font-medium">NC Cost</th></tr>
                </thead>
                <tbody>
                  {v2Analytics.topNC.map((r: any, i: number) => (
                    <tr key={i} className="border-t border-[#E8D5C4]/50">
                      <td className="py-1.5 px-2 text-xs">{r.item_name}</td>
                      <td className="py-1.5 px-2 text-xs text-right font-mono text-amber-600">{r.nc_count}</td>
                      <td className="py-1.5 px-2 text-xs text-right font-mono text-red-600 font-semibold">{formatCurrency(r.nc_cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {v2Error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
            Analytics error: {v2Error}
          </div>
        )}

        {/* Tab Selector */}
        <div className="flex gap-2">
          <button
            onClick={() => setActiveTab('csv')}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              activeTab === 'csv'
                ? 'bg-[#af4408] text-white'
                : 'bg-white text-[#6B5744] border border-[#E8D5C4] hover:bg-[#FFF1E3]'
            }`}
          >
            <FileSpreadsheet className="w-4 h-4" />
            CSV / Excel Upload
          </button>
          <button
            onClick={() => setActiveTab('manual')}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              activeTab === 'manual'
                ? 'bg-[#af4408] text-white'
                : 'bg-white text-[#6B5744] border border-[#E8D5C4] hover:bg-[#FFF1E3]'
            }`}
          >
            <Plus className="w-4 h-4" />
            Manual Entry
          </button>
        </div>

        {/* CSV Upload Section */}
        {activeTab === 'csv' && (
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 shadow space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <h2 className="text-lg font-semibold text-[#2D1B0E] flex items-center gap-2">
                <FileSpreadsheet className="w-5 h-5 text-[#af4408]" />
                Upload CSV / Excel
              </h2>
              <button
                type="button"
                onClick={downloadSampleTemplate}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-[#D4B896] bg-[#FFF1E3] text-[#6B5744] hover:bg-[#FFE9D4] text-sm font-medium transition-colors"
                title="Download a sample CSV you can fill and re-upload"
              >
                <FileSpreadsheet className="w-4 h-4" />
                Download Sample CSV
              </button>
            </div>

            <div className="bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3 text-sm text-[#6B5744] space-y-2">
              <p>
                <span className="font-semibold text-[#2D1B0E]">How it works:</span>{' '}
                Drop any sales file below — the app auto-detects column names.
              </p>
              <ol className="list-decimal ml-5 space-y-1 text-xs text-[#8B7355]">
                <li>Download the sample CSV (or use your POS export directly).</li>
                <li>Fill in rows — one row per item sold.</li>
                <li>Drag the file into the upload area, review the preview, then click <span className="font-semibold text-[#af4408]">Submit</span>.</li>
              </ol>
              <p className="text-xs">
                <span className="font-semibold text-[#2D1B0E]">POS exports auto-detected</span> —
                Recaho / Petpooja / Posist / Urbanpiper "Item Wise Sale" reports work as-is.
                We read <code className="bg-[#FFF1E3] px-1 rounded">Item Name</code>,{' '}
                <code className="bg-[#FFF1E3] px-1 rounded">Qty</code>,{' '}
                <code className="bg-[#FFF1E3] px-1 rounded">Rate</code>/<code className="bg-[#FFF1E3] px-1 rounded">Amount</code>,{' '}
                <code className="bg-[#FFF1E3] px-1 rounded">Order Date</code>,{' '}
                <code className="bg-[#FFF1E3] px-1 rounded">Mapped Code</code> (as POS item id),{' '}
                <code className="bg-[#FFF1E3] px-1 rounded">Product Name</code>,{' '}
                <code className="bg-[#FFF1E3] px-1 rounded">Variant Name</code>. Extra columns are ignored.
              </p>
              <p className="text-xs text-green-700">
                ✓ New: each sale row now captures the POS Item ID (Mapped Code). This creates a stable link between sales and recipes, so renaming menu items on the POS side won&apos;t break your cost tracking.
              </p>
              <p className="text-xs">
                <span className="font-semibold text-[#2D1B0E]">Minimum columns:</span>{' '}
                <code className="bg-[#FFF1E3] px-1 rounded">item_name</code>,{' '}
                <code className="bg-[#FFF1E3] px-1 rounded">quantity_sold</code>,{' '}
                <code className="bg-[#FFF1E3] px-1 rounded">selling_price</code>,{' '}
                <code className="bg-[#FFF1E3] px-1 rounded">date</code>.{' '}
                Optional: <code className="bg-[#FFF1E3] px-1 rounded">bill_type</code> (normal/nc/complimentary) — defaults to <code className="bg-[#FFF1E3] px-1 rounded">normal</code>.
              </p>
            </div>

            {/* Drop zone */}
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-colors ${
                dragOver
                  ? 'border-[#af4408] bg-[#af4408]/10'
                  : 'border-[#D4B896] hover:border-[#D4B896] hover:bg-[#FFF1E3]/30'
              }`}
            >
              <Upload className="w-10 h-10 text-[#8B7355] mx-auto mb-3" />
              <p className="text-[#6B5744] font-medium">
                {csvFileName ? csvFileName : 'Drag & drop your file here, or click to browse'}
              </p>
              <p className="text-xs text-[#8B7355] mt-1">Accepts .csv and .xlsx files</p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.xlsx,.xls"
                onChange={handleFileInput}
                className="hidden"
              />
            </div>

            {/* Preview */}
            {parsedData.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-[#6B5744]">
                  Preview ({parsedData.length} rows)
                </h3>
                <div className="overflow-x-auto max-h-64 overflow-y-auto rounded-lg border border-[#E8D5C4]">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-[#FFF1E3]">
                      <tr className="text-[#8B7355]">
                        <th className="text-left py-2 px-3 font-medium">#</th>
                        <th className="text-left py-2 px-3 font-medium">Item Name</th>
                        <th className="text-right py-2 px-3 font-medium">Qty</th>
                        <th className="text-left py-2 px-3 font-medium">Bill Type</th>
                        <th className="text-left py-2 px-3 font-medium">Date</th>
                        <th className="text-right py-2 px-3 font-medium">Price</th>
                      </tr>
                    </thead>
                    <tbody>
                      {parsedData.map((row, i) => (
                        <tr key={i} className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3]/30">
                          <td className="py-2 px-3 text-[#8B7355]">{i + 1}</td>
                          <td className="py-2 px-3 text-[#3D2614]">{row.item_name}</td>
                          <td className="py-2 px-3 text-right text-[#3D2614] font-mono">{row.quantity_sold}</td>
                          <td className="py-2 px-3">
                            <BillBadge type={row.bill_type as BillType} />
                          </td>
                          <td className="py-2 px-3 text-[#6B5744]">{row.date}</td>
                          <td className="py-2 px-3 text-right text-[#3D2614] font-mono">
                            {formatCurrency(row.selling_price)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={uploadCSV}
                    disabled={uploading}
                    className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] disabled:bg-[#8a3506] disabled:opacity-60 text-white rounded-lg text-sm font-medium transition-colors"
                  >
                    {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                    {uploading ? 'Uploading...' : 'Upload'}
                  </button>
                  <button
                    onClick={() => {
                      setParsedData([]);
                      setCsvFileName(null);
                    }}
                    className="px-4 py-2.5 bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm font-medium hover:bg-[#FFF1E3] transition-colors"
                  >
                    Clear
                  </button>
                </div>
              </div>
            )}

            {/* Upload result */}
            {uploadResult && (
              <UploadResultBanner
                success={uploadResult.success}
                errors={uploadResult.errors}
                onDismiss={() => setUploadResult(null)}
              />
            )}
          </div>
        )}

        {/* Manual Entry Section */}
        {activeTab === 'manual' && (
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 shadow space-y-4">
            <h2 className="text-lg font-semibold text-[#2D1B0E] flex items-center gap-2">
              <Plus className="w-5 h-5 text-[#af4408]" />
              Manual Entry
            </h2>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[#8B7355] border-b border-[#E8D5C4]">
                    <th className="text-left py-2 px-2 font-medium">Item Name</th>
                    <th className="text-left py-2 px-2 font-medium">Recipe</th>
                    <th className="text-right py-2 px-2 font-medium">Qty</th>
                    <th className="text-left py-2 px-2 font-medium">Bill Type</th>
                    <th className="text-right py-2 px-2 font-medium">Price ({'\u20B9'})</th>
                    <th className="text-left py-2 px-2 font-medium">Date</th>
                    <th className="py-2 px-2" />
                  </tr>
                </thead>
                <tbody>
                  {manualRows.map((row, idx) => (
                    <tr key={idx} className="border-b border-[#E8D5C4]/50">
                      <td className="py-2 px-2">
                        <input
                          type="text"
                          value={row.item_name}
                          onChange={(e) => updateManualRow(idx, 'item_name', e.target.value)}
                          placeholder="Item name"
                          className="w-full bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2 text-sm text-[#2D1B0E] placeholder-[#8B7355] focus:outline-none focus:border-[#af4408]"
                        />
                      </td>
                      <td className="py-2 px-2">
                        <select
                          value={row.recipe_id}
                          onChange={(e) => updateManualRow(idx, 'recipe_id', e.target.value)}
                          className="w-full bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2 text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
                        >
                          <option value="">-- Select --</option>
                          {recipes.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-2 px-2">
                        <input
                          type="number"
                          min={1}
                          value={row.quantity_sold}
                          onChange={(e) => updateManualRow(idx, 'quantity_sold', Number(e.target.value))}
                          className="w-20 bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2 text-sm text-[#2D1B0E] text-right font-mono focus:outline-none focus:border-[#af4408]"
                        />
                      </td>
                      <td className="py-2 px-2">
                        <select
                          value={row.bill_type}
                          onChange={(e) => updateManualRow(idx, 'bill_type', e.target.value as BillType)}
                          className="w-full bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2 text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
                        >
                          <option value="normal">Normal</option>
                          <option value="nc">NC</option>
                          <option value="complimentary">Complimentary</option>
                        </select>
                      </td>
                      <td className="py-2 px-2">
                        <input
                          type="number"
                          min={0}
                          value={row.selling_price}
                          onChange={(e) => updateManualRow(idx, 'selling_price', Number(e.target.value))}
                          className="w-24 bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2 text-sm text-[#2D1B0E] text-right font-mono focus:outline-none focus:border-[#af4408]"
                        />
                      </td>
                      <td className="py-2 px-2">
                        <input
                          type="date"
                          value={row.date}
                          onChange={(e) => updateManualRow(idx, 'date', e.target.value)}
                          className="bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2 text-sm text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
                        />
                      </td>
                      <td className="py-2 px-2">
                        <button
                          onClick={() => removeRow(idx)}
                          className="p-2 text-[#8B7355] hover:text-red-400 transition-colors"
                          title="Remove row"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex gap-3">
              <button
                onClick={addRow}
                className="flex items-center gap-2 px-4 py-2.5 bg-[#FFF1E3] text-[#6B5744] rounded-lg text-sm font-medium hover:bg-[#FFF1E3] transition-colors"
              >
                <Plus className="w-4 h-4" />
                Add Row
              </button>
              <button
                onClick={submitManual}
                disabled={submitting}
                className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] disabled:bg-[#8a3506] disabled:opacity-60 text-white rounded-lg text-sm font-medium transition-colors"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                {submitting ? 'Submitting...' : 'Submit All'}
              </button>
            </div>

            {submitResult && (
              <UploadResultBanner
                success={submitResult.success}
                errors={submitResult.errors}
                onDismiss={() => setSubmitResult(null)}
              />
            )}
          </div>
        )}

        {/* ===== v2 Paginated / Sortable / Exportable Sales Table ===== */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-5 shadow">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h2 className="text-lg font-semibold text-[#2D1B0E]">
              Sales Rows
              <span className="ml-2 text-xs font-normal text-[#8B7355]">
                ({listTotal.toLocaleString('en-IN')} total · showing {listRows.length} on page {listPage + 1})
              </span>
            </h2>
            <div className="flex items-center gap-2">
              <button onClick={exportListCsv} disabled={listRows.length === 0}
                      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[#D4B896] bg-[#FFF1E3] text-[#6B5744] hover:bg-[#FFE9D4] text-xs font-medium disabled:opacity-40">
                <Download className="w-3.5 h-3.5" /> Export CSV
              </button>
            </div>
          </div>

          {listLoading ? (
            <p className="text-center text-xs text-[#8B7355] py-6">Loading…</p>
          ) : listRows.length === 0 ? (
            <p className="text-center text-sm text-[#8B7355] py-8">No sales match the current filters.</p>
          ) : (
            <>
              <div className="overflow-x-auto rounded-lg border border-[#E8D5C4] max-h-[32rem] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-[#FFF1E3] z-10">
                    <tr className="text-[#8B7355]">
                      <SortTh label="Date"      col="date"      currentSort={listSort} currentDir={listDir} onToggle={toggleSort} align="left" />
                      <SortTh label="Item"      col="item"      currentSort={listSort} currentDir={listDir} onToggle={toggleSort} align="left" />
                      <th className="text-left py-2 px-3 font-medium text-xs">Category</th>
                      <SortTh label="Qty"       col="qty"       currentSort={listSort} currentDir={listDir} onToggle={toggleSort} align="right" />
                      <SortTh label="Bill"      col="bill_type" currentSort={listSort} currentDir={listDir} onToggle={toggleSort} align="left" />
                      <SortTh label="Revenue"   col="revenue"   currentSort={listSort} currentDir={listDir} onToggle={toggleSort} align="right" />
                      <SortTh label="Cost"      col="cost"      currentSort={listSort} currentDir={listDir} onToggle={toggleSort} align="right" />
                      <th className="text-right py-2 px-3 font-medium text-xs">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {listRows.map((s: any) => (
                      <tr key={s.id}
                          className={`border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3]/30 ${s.bill_type !== 'normal' ? 'bg-amber-50/40' : ''}`}>
                        <td className="py-2 px-3 text-[#6B5744] text-xs whitespace-nowrap">
                          {formatDate(s.date)}
                          {s.sale_time && <span className="text-[10px] text-[#8B7355] ml-1">{s.sale_time}</span>}
                        </td>
                        <td className="py-2 px-3 text-[#2D1B0E] text-xs">{s.item_name}</td>
                        <td className="py-2 px-3 text-[#6B5744] text-xs capitalize">{s.resolved_category || '—'}</td>
                        <td className="py-2 px-3 text-right font-mono text-xs">{s.quantity_sold}</td>
                        <td className="py-2 px-3"><BillBadge type={s.bill_type} /></td>
                        <td className="py-2 px-3 text-right font-mono text-xs text-green-600">{formatCurrency(s.total_revenue)}</td>
                        <td className="py-2 px-3 text-right font-mono text-xs text-red-600">{formatCurrency(s.total_cost)}</td>
                        <td className="py-2 px-3 text-right">
                          <button onClick={() => deleteSaleRow(s.id)}
                                  className="text-red-500 hover:text-red-700 p-1 rounded hover:bg-red-50 transition-colors" title="Delete">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between mt-3 text-xs text-[#6B5744]">
                <span>
                  Showing {listPage * LIST_PAGE_SIZE + 1}
                  {'–'}
                  {Math.min((listPage + 1) * LIST_PAGE_SIZE, listTotal)}
                  {' of '}{listTotal.toLocaleString('en-IN')}
                </span>
                <div className="flex items-center gap-1">
                  <button onClick={() => setListPage(Math.max(0, listPage - 1))}
                          disabled={listPage === 0}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded border border-[#E8D5C4] hover:bg-[#FFF1E3] disabled:opacity-40">
                    <ChevronLeft className="w-3.5 h-3.5" /> Prev
                  </button>
                  <span className="px-2">Page {listPage + 1} / {Math.max(1, Math.ceil(listTotal / LIST_PAGE_SIZE))}</span>
                  <button onClick={() => setListPage(listPage + 1)}
                          disabled={(listPage + 1) * LIST_PAGE_SIZE >= listTotal}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded border border-[#E8D5C4] hover:bg-[#FFF1E3] disabled:opacity-40">
                    Next <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sub-components                                                      */
/* ------------------------------------------------------------------ */

function SummaryCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: 'green' | 'red' | 'blue' | 'amber';
}) {
  const accents: Record<string, { bg: string; text: string }> = {
    green: { bg: 'bg-green-500/10', text: 'text-green-400' },
    red: { bg: 'bg-red-500/10', text: 'text-red-400' },
    blue: { bg: 'bg-[#af4408]/10', text: 'text-[#af4408]' },
    amber: { bg: 'bg-amber-500/10', text: 'text-amber-400' },
  };
  const a = accents[color];
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-5 shadow">
      <p className="text-xs text-[#8B7355] mb-1">{label}</p>
      <p className={`text-2xl font-bold ${a.text}`}>{value}</p>
    </div>
  );
}

function BillBadge({ type }: { type: BillType | string }) {
  const styles: Record<string, string> = {
    normal: 'bg-green-500/15 text-green-400 border-green-500/30',
    nc: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    complimentary: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
  };
  return (
    <span className={`inline-block px-2 py-0.5 text-xs font-medium rounded-full border ${styles[type] || styles.normal}`}>
      {type === 'nc' ? 'NC' : type.charAt(0).toUpperCase() + type.slice(1)}
    </span>
  );
}

function UploadResultBanner({
  success,
  errors,
  onDismiss,
}: {
  success: number;
  errors: string[];
  onDismiss: () => void;
}) {
  const isError = errors.length > 0;
  return (
    <div
      className={`flex items-start gap-3 p-4 rounded-lg border ${
        isError
          ? 'bg-red-500/10 border-red-500/30 text-red-300'
          : 'bg-green-500/10 border-green-500/30 text-green-300'
      }`}
    >
      {isError ? <AlertCircle className="w-5 h-5 mt-0.5 flex-shrink-0" /> : <CheckCircle className="w-5 h-5 mt-0.5 flex-shrink-0" />}
      <div className="flex-1 text-sm">
        {success > 0 && <p>{success} sale(s) uploaded successfully.</p>}
        {errors.map((err, i) => (
          <p key={i} className="text-red-400">{err}</p>
        ))}
      </div>
      <button onClick={onDismiss} className="text-[#8B7355] hover:text-[#3D2614] text-sm">
        Dismiss
      </button>
    </div>
  );
}

/* ================================================================= */
/* v2 Insights sub-components                                         */
/* ================================================================= */

function formatCompactINR(v: number): string {
  if (Math.abs(v) >= 10000000) return '₹' + (v / 10000000).toFixed(2) + 'Cr';
  if (Math.abs(v) >= 100000)   return '₹' + (v / 100000).toFixed(2) + 'L';
  if (Math.abs(v) >= 1000)     return '₹' + (v / 1000).toFixed(1) + 'k';
  return '₹' + v.toFixed(0);
}

function pctChange(current: number, prev: number): { pct: number; trend: 'up' | 'down' | 'flat' } {
  if (prev === 0) return { pct: current === 0 ? 0 : 100, trend: current > 0 ? 'up' : 'flat' };
  const pct = ((current - prev) / Math.abs(prev)) * 100;
  return { pct, trend: pct > 0.5 ? 'up' : pct < -0.5 ? 'down' : 'flat' };
}

function Delta({ current, prev, invert = false }: { current: number; prev: number; invert?: boolean }) {
  const { pct, trend } = pctChange(current, prev);
  const good = invert ? trend === 'down' : trend === 'up';
  const color = trend === 'flat' ? 'text-[#8B7355]' : good ? 'text-green-600' : 'text-red-600';
  const Icon = trend === 'up' ? ArrowUp : trend === 'down' ? ArrowDown : null;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold ${color}`}>
      {Icon && <Icon className="w-3 h-3" />}
      {pct >= 0 ? '+' : ''}{pct.toFixed(1)}%
    </span>
  );
}

function ComparisonKPIs({ loading, analytics }: { loading: boolean; analytics: any }) {
  if (loading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="bg-white border border-[#E8D5C4] rounded-xl p-5 h-28 animate-pulse" />
        ))}
      </div>
    );
  }
  if (!analytics) return null;
  const t = analytics.totals; const p = analytics.prevTotals;
  const cards: Array<{ label: string; current: number; prev: number; value: string; invert?: boolean; color: string }> = [
    { label: 'Revenue',    current: t.total_revenue, prev: p.total_revenue, value: formatCompactINR(t.total_revenue), color: 'text-green-600' },
    { label: 'Orders',     current: t.order_count,   prev: p.order_count,   value: t.order_count.toLocaleString('en-IN'), color: 'text-[#af4408]' },
    { label: 'Items Sold', current: t.total_items,   prev: p.total_items,   value: t.total_items.toLocaleString('en-IN'), color: 'text-[#2D1B0E]' },
    { label: 'Avg Bill',   current: t.avg_bill,      prev: p.avg_bill,      value: formatCompactINR(t.avg_bill), color: 'text-indigo-600' },
    { label: 'NC Cost',    current: t.nc_cost,       prev: p.nc_cost,       value: formatCompactINR(t.nc_cost), invert: true, color: 'text-red-600' },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
      {cards.map((c, i) => (
        <div key={i} className="bg-white border border-[#E8D5C4] rounded-xl p-4 shadow">
          <p className="text-[10px] uppercase tracking-wider text-[#8B7355]">{c.label}</p>
          <p className={`text-2xl font-bold mt-1 ${c.color}`}>{c.value}</p>
          <div className="mt-2 flex items-center gap-2">
            <Delta current={c.current} prev={c.prev} invert={c.invert} />
            <span className="text-[10px] text-[#8B7355]">vs prev {analytics.range.days}d</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function PeakCallouts({ analytics }: { analytics: any }) {
  const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const peakDay = analytics.peakDay;
  const peakHour = analytics.peakHour;
  const topCat = analytics.byCategory[0];
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 shadow">
        <p className="text-[10px] uppercase tracking-wider text-[#8B7355] flex items-center gap-1">
          <Flame className="w-3 h-3 text-[#af4408]" /> Peak Day
        </p>
        {peakDay ? (
          <>
            <p className="text-lg font-bold text-[#2D1B0E] mt-1">{new Date(peakDay.date).toLocaleDateString('en-IN', { weekday:'short', day:'2-digit', month:'short' })}</p>
            <p className="text-xs text-[#8B7355]">{formatCompactINR(peakDay.revenue)} · {peakDay.orders} orders</p>
          </>
        ) : <p className="text-sm text-[#8B7355] mt-1">No data</p>}
      </div>
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 shadow">
        <p className="text-[10px] uppercase tracking-wider text-[#8B7355] flex items-center gap-1">
          <Clock className="w-3 h-3 text-[#af4408]" /> Peak Hour
        </p>
        {peakHour ? (
          <>
            <p className="text-lg font-bold text-[#2D1B0E] mt-1">
              {DOW_NAMES[peakHour.dow]} · {String(peakHour.hour).padStart(2,'0')}:00
            </p>
            <p className="text-xs text-[#8B7355]">{formatCompactINR(peakHour.revenue)} · {peakHour.count} lines</p>
          </>
        ) : <p className="text-sm text-[#8B7355] mt-1">No hourly data yet — re-upload POS file to capture sale time</p>}
      </div>
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 shadow">
        <p className="text-[10px] uppercase tracking-wider text-[#8B7355] flex items-center gap-1">
          <Target className="w-3 h-3 text-[#af4408]" /> Top Category
        </p>
        {topCat ? (
          <>
            <p className="text-lg font-bold text-[#2D1B0E] mt-1 capitalize">{topCat.category}</p>
            <p className="text-xs text-[#8B7355]">{formatCompactINR(topCat.revenue)} · {topCat.items} items</p>
          </>
        ) : <p className="text-sm text-[#8B7355] mt-1">No data</p>}
      </div>
    </div>
  );
}

function HourlyHeatmap({ heatmap }: { heatmap: any[] }) {
  const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  // Build matrix dow x hour → revenue
  const grid: Record<string, number> = {};
  let max = 0;
  for (const row of heatmap) {
    const key = `${row.dow}-${row.hour}`;
    grid[key] = row.revenue;
    if (row.revenue > max) max = row.revenue;
  }
  const intensity = (v: number) => {
    if (!max || !v) return 0;
    return Math.max(0.08, Math.min(1, v / max));
  };
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 shadow">
      <h3 className="text-sm font-semibold text-[#2D1B0E] mb-3 flex items-center gap-2">
        <Clock className="w-4 h-4 text-[#af4408]" />
        Hourly Heatmap · Weekday × Hour (revenue intensity)
      </h3>
      {max === 0 ? (
        <p className="text-xs text-[#8B7355] text-center py-6">
          No hourly data yet. Re-upload your POS export — the new parser captures sale time (HH:MM) from <code>Order Date and Time</code>.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="text-[10px] border-separate border-spacing-0.5">
            <thead>
              <tr>
                <th className="w-10"></th>
                {[...Array(24)].map((_, h) => (
                  <th key={h} className="w-7 text-[#8B7355] font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {DOW.map((name, dow) => (
                <tr key={dow}>
                  <th className="text-left pr-1 text-[#6B5744] font-medium">{name}</th>
                  {[...Array(24)].map((_, h) => {
                    const v = grid[`${dow}-${h}`] || 0;
                    const a = intensity(v);
                    return (
                      <td key={h} className="w-7 h-6 rounded"
                          style={{ backgroundColor: v ? `rgba(175, 68, 8, ${a})` : '#FFF8F0' }}
                          title={`${name} ${h}:00 · ₹${v.toFixed(0)}`} />
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TopItemsCard({ title, icon, items, metric }: { title: string; icon: React.ReactNode; items: any[]; metric: 'revenue' | 'qty' }) {
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden shadow">
      <div className="px-4 py-3 border-b border-[#E8D5C4] bg-[#FFF1E3]/50 flex items-center gap-2">
        {icon}
        <h3 className="text-sm font-semibold text-[#2D1B0E]">{title}</h3>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-[#FFF8F0]">
          <tr className="text-[#8B7355]">
            <th className="text-left py-2 px-3 text-xs font-medium">Item</th>
            <th className="text-right py-2 px-3 text-xs font-medium">Qty</th>
            <th className="text-right py-2 px-3 text-xs font-medium">Revenue</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr><td colSpan={3} className="py-6 text-center text-[#8B7355] text-xs">No data</td></tr>
          ) : items.map((i, idx) => (
            <tr key={idx} className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3]/40">
              <td className="py-2 px-3 text-xs text-[#2D1B0E]">{i.item_name}</td>
              <td className="py-2 px-3 text-right font-mono text-xs">{Number(i.qty).toLocaleString('en-IN')}</td>
              <td className={`py-2 px-3 text-right font-mono text-xs font-semibold ${metric === 'revenue' ? 'text-[#af4408]' : 'text-[#6B5744]'}`}>
                {formatCompactINR(i.revenue)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SortTh({ label, col, currentSort, currentDir, onToggle, align }:
  { label: string; col: string; currentSort: string; currentDir: 'asc' | 'desc'; onToggle: (c: string) => void; align: 'left' | 'right' }) {
  const active = currentSort === col;
  return (
    <th className={`py-2 px-3 font-medium text-xs cursor-pointer select-none hover:text-[#af4408] ${align === 'right' ? 'text-right' : 'text-left'}`}
        onClick={() => onToggle(col)}>
      <span className="inline-flex items-center gap-1">
        {label}
        {active && (currentDir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
      </span>
    </th>
  );
}

/* ============================================================ */
/* Recaho "Item Wise Sales Report" import modal                  */
/* ============================================================ */
function RecahoSalesImportModal({ onClose, onCommitted, initialFile }: {
  onClose: () => void; onCommitted: () => void; initialFile?: File | null;
}) {
  const [file, setFile]       = useState<File | null>(initialFile || null);
  const [busy, setBusy]       = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const [committed, setCommitted] = useState<any>(null);
  const [anchor, setAnchor]   = useState<'end' | 'start'>('end');
  const [error, setError]     = useState<string | null>(null);
  const [autoPreviewed, setAutoPreviewed] = useState(false);
  // When ON, every Commit also auto-creates any unmatched PRODUCT NAMEs as
  // menu_items (so the second-time import for a new outlet is a single click).
  const [autoCreateOnCommit, setAutoCreateOnCommit] = useState(true);

  const send = async (mode: 'preview' | 'commit' | 'create_menu') => {
    if (!file) { alert('Pick a Recaho .xlsx first'); return; }
    setBusy(true); setError(null);
    try {
      const fd = new FormData();
      fd.set('file', file);
      fd.set('anchor_date', anchor);
      if (mode === 'commit') {
        fd.set('commit', 'true');
        if (autoCreateOnCommit) fd.set('create_missing_menu_items', 'true');
      }
      if (mode === 'create_menu') fd.set('create_missing_menu_items', 'true');
      const r = await api('/api/sales-import', { method: 'POST', body: fd });
      const j = await r.json();
      if (!r.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      if (mode === 'commit')      { setCommitted(j); onCommitted(); }
      else if (mode === 'create_menu') {
        // Re-run preview so the unmatched count drops in place.
        const fd2 = new FormData(); fd2.set('file', file); fd2.set('anchor_date', anchor);
        const r2 = await api('/api/sales-import', { method: 'POST', body: fd2 });
        if (r2.ok) setPreview(await r2.json());
        const head = (j.created_items || []).slice(0, 8).map((x: any) => `· ${x.name} — ₹${x.selling_price}`).join('\n');
        alert(`Created ${j.created_count} menu item(s).\n\n${head}${j.created_count > 8 ? `\n…and ${j.created_count - 8} more` : ''}\n\nReview them on /menu-items, link recipes if needed, then commit the sales.`);
      } else { setPreview(j); }
    } finally { setBusy(false); }
  };

  // If the modal opened with a file already attached (from the auto-detect path
  // in the legacy CSV uploader), kick off a preview immediately.
  useEffect(() => {
    if (file && !autoPreviewed && !preview && !committed) {
      setAutoPreviewed(true);
      send('preview');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-3xl my-8 shadow-xl">
        <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between">
          <h2 className="font-bold text-[#2D1B0E] flex items-center gap-2">
            <Upload className="w-5 h-5" /> Import Recaho Item-Wise Sales
          </h2>
          <button onClick={onClose} className="text-[#8B7355]">✕</button>
        </div>
        <div className="p-5 space-y-3 text-sm">
          <p className="text-[#6B5744] text-xs">
            Upload the <code className="px-1 py-0.5 bg-[#FFF1E3] rounded">item_wise_sales_report</code> .xlsx
            from Recaho. The file is aggregated per item over a date range — each line becomes one
            <code className="px-1 mx-0.5 bg-[#FFF1E3] rounded">sales</code> row dated at the period boundary.
            Items with a recipe will recipe-deduct ingredients automatically.
          </p>

          <div className="flex items-center gap-2">
            <input type="file" accept=".xlsx,.xls"
                   onChange={e => { setFile(e.target.files?.[0] || null); setPreview(null); setCommitted(null); setError(null); }}
                   className="text-xs flex-1" />
            <select value={anchor} onChange={e => setAnchor(e.target.value as any)}
                    className="px-2 py-1 border border-[#E8D5C4] rounded text-xs bg-[#FFF8F0]">
              <option value="end">Anchor: End date</option>
              <option value="start">Anchor: Start date</option>
            </select>
            <button onClick={() => send('preview')} disabled={!file || busy || !!committed}
                    className="px-3 py-1.5 text-xs bg-white border border-[#E8D5C4] rounded hover:bg-[#FFF1E3] disabled:opacity-50">
              {busy && !preview ? 'Parsing…' : 'Preview'}
            </button>
          </div>

          {error && (
            <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">{error}</div>
          )}

          {preview && !committed && (
            <div className="border border-[#E8D5C4] rounded-lg p-3 bg-[#FFF8F0] text-xs space-y-2">
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[#6B5744]">
                {preview.business_name && <span><b>Business:</b> {preview.business_name}</span>}
                <span><b>Range:</b> {preview.date_range.start} → {preview.date_range.end}</span>
                <span><b>Anchor:</b> {preview.date_range.anchor}</span>
                <span><b>Lines:</b> <span className="font-mono">{preview.line_count}</span></span>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                {(['normal', 'comp', 'nc'] as const).map(t => {
                  const stats = preview.totals_by_bill_type?.[t] || { lines: 0, qty: 0, amount: 0 };
                  return (
                    <div key={t} className={`p-2 rounded border ${
                      t === 'normal' ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                      : t === 'comp' ? 'bg-amber-50 border-amber-200 text-amber-800'
                                     : 'bg-rose-50 border-rose-200 text-rose-800'
                    }`}>
                      <div className="text-[10px] uppercase tracking-wide">{
                        t === 'normal' ? 'Normal' : t === 'comp' ? 'Complimentary' : 'Non-Chargeable'
                      }</div>
                      <div className="font-semibold">{stats.lines} lines · {stats.qty} qty</div>
                      <div className="font-mono">₹{Math.round(stats.amount).toLocaleString('en-IN')}</div>
                    </div>
                  );
                })}
              </div>
              <div className="flex flex-wrap gap-3 mt-1">
                <span className="text-emerald-700">✓ {preview.matched_count} matched</span>
                <span className="text-emerald-900">({preview.matched_with_recipe} with recipe → will deduct)</span>
                <span className="text-[#6B5744]">{preview.matched_no_recipe} matched but no recipe</span>
                {preview.unmatched_count > 0 && (
                  <span className="text-amber-800">⚠ {preview.unmatched_count} unmatched (will skip)</span>
                )}
              </div>
              {preview.unmatched_count > 0 && (
                <div className="border border-amber-200 rounded-lg p-3 bg-amber-50/60 mt-2">
                  <div className="flex items-start gap-3">
                    <div className="flex-1">
                      <div className="font-semibold text-amber-900">
                        ⚠ {preview.unmatched_count} unmatched product name(s)
                      </div>
                      <div className="text-amber-800 mt-0.5">
                        These show up in the Recaho file but aren't in your <a href="/menu-items" className="underline">Menu Items</a> master.
                        Auto-create them now — name / category / station / item type / mapped code come from the file, and
                        selling price = AMOUNT ÷ TOTAL QTY (period average). They start with no recipe linked, so they'll
                        record sales but won't recipe-deduct ingredients until you wire a recipe.
                      </div>
                    </div>
                    <button onClick={() => send('create_menu')} disabled={busy}
                            className="shrink-0 px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-700 text-white rounded disabled:opacity-50">
                      Create {preview.unmatched_count} menu items
                    </button>
                  </div>
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[10px] text-amber-800 hover:underline">Show item names</summary>
                    <div className="mt-1 max-h-40 overflow-y-auto bg-white border border-[#E8D5C4] rounded p-2 text-[10px] text-[#6B5744] font-mono">
                      {preview.unmatched_items.map((u: any, i: number) => (
                        <div key={i}>· {u.product_name} {u.mapped_code ? `[${u.mapped_code}]` : ''} — {u.qty} qty, ₹{Math.round(u.amount)}</div>
                      ))}
                    </div>
                  </details>
                </div>
              )}
            </div>
          )}

          {committed && (
            <div className="border border-emerald-200 rounded-lg p-3 bg-emerald-50 text-xs space-y-1">
              <div className="font-semibold text-emerald-800">✓ Imported</div>
              <ul className="text-emerald-900 space-y-0.5">
                <li>Created {committed.summary.sales_created} sales rows ({committed.summary.qty_total} total qty, ₹{Math.round(committed.summary.revenue_total).toLocaleString('en-IN')} revenue)</li>
                <li>{committed.summary.recipe_deducted_count} of those recipe-deducted ingredients</li>
                <li>Anchor date: <code>{committed.anchor_date}</code></li>
                <li>By bill_type: normal {committed.summary.bill_types.normal || 0} · comp {committed.summary.bill_types.comp || 0} · nc {committed.summary.bill_types.nc || 0}</li>
                {committed.auto_created_menu_items && committed.auto_created_menu_items.count > 0 && (
                  <li className="text-blue-800">
                    Auto-created {committed.auto_created_menu_items.count} menu item{committed.auto_created_menu_items.count === 1 ? '' : 's'} from unmatched product names.
                    Head to <a href="/menu-items" className="underline">Menu Items</a> to review &amp; link recipes.
                  </li>
                )}
                {committed.summary.skipped_unmatched > 0 && (
                  <li className="text-amber-800">Skipped {committed.summary.skipped_unmatched} unmatched product names</li>
                )}
              </ul>
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-between gap-2">
          {preview && !committed ? (
            <label className="flex items-center gap-2 text-xs text-[#6B5744] cursor-pointer select-none">
              <input type="checkbox" checked={autoCreateOnCommit}
                     onChange={e => setAutoCreateOnCommit(e.target.checked)} />
              <span>
                Auto-create missing menu items
                {preview.unmatched_count > 0 && <span className="text-amber-700 font-semibold"> ({preview.unmatched_count} pending)</span>}
              </span>
            </label>
          ) : <div />}
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm text-[#6B5744]">{committed ? 'Close' : 'Cancel'}</button>
            {preview && !committed && (
              <button onClick={() => send('commit')}
                      disabled={busy || (preview.matched_count === 0 && !autoCreateOnCommit)}
                      className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white text-sm rounded-lg disabled:opacity-50 inline-flex items-center gap-1.5">
                {busy ? 'Committing…'
                  : autoCreateOnCommit && preview.unmatched_count > 0
                    ? `Create ${preview.unmatched_count} items + commit ${preview.matched_count + preview.unmatched_count} sales`
                    : `Commit ${preview.matched_count} sales`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
