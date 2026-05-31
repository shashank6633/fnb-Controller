'use client';

import { useEffect, useState, useCallback } from 'react';
import { api } from '@/lib/api';
import {
  Utensils,
  Plus,
  X,
  Loader2,
  Users,
  Trash2,
  CheckCircle,
  AlertCircle,
  Eye,
  IndianRupee,
  Sun,
  Moon,
  Coffee,
  ChefHat,
  Link2Off,
  Calendar,
} from 'lucide-react';

function formatCurrency(value: number): string {
  return '₹' + value.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

function todayString(): string {
  return new Date().toISOString().split('T')[0];
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

interface StaffMeal {
  id: string;
  date: string;
  meal_type: string;
  shift: string;
  staff_count: number;
  cooked_by: string;
  menu: string;
  status: string;
  notes: string;
  total_items: number;
  total_issued_value: number;
  total_returned_value: number;
  total_consumed_cost: number;
  open_items: number;
  closed_items: number;
}

interface MealItem {
  id: string;
  meal_id: string;
  item_name: string;
  material_id: string | null;
  category: string;
  quantity: number;
  issued_quantity: number;
  returned_quantity: number;
  unit: string;
  purchase_price: number;
  total_cost: number;
  status: string;
  notes: string;
}

interface RawMaterial {
  id: string;
  name: string;
  unit: string;
  average_price: number;
  category: string;
}

const MEAL_TYPES = [
  { value: 'breakfast', label: 'Breakfast', icon: Coffee },
  { value: 'lunch', label: 'Lunch', icon: Sun },
  { value: 'snacks', label: 'Snacks', icon: Coffee },
  { value: 'dinner', label: 'Dinner', icon: Moon },
];

const SHIFT_OPTIONS = ['Morning', 'Evening', 'Night', 'All Shifts'];

export default function StaffMealsPage() {
  const [meals, setMeals] = useState<StaffMeal[]>([]);
  const [summary, setSummary] = useState<any>({ total_meals: 0, total_staff_fed: 0, total_cost: 0 });
  const [materials, setMaterials] = useState<RawMaterial[]>([]);
  const [loading, setLoading] = useState(true);

  // Create
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    date: todayString(), meal_type: 'lunch', shift: 'All Shifts',
    staff_count: '', cooked_by: '', menu: '', notes: '',
  });
  const [formError, setFormError] = useState<string | null>(null);

  // Details
  const [selectedMeal, setSelectedMeal] = useState<StaffMeal | null>(null);
  const [mealItems, setMealItems] = useState<MealItem[]>([]);
  const [detailsLoading, setDetailsLoading] = useState(false);

  // Issue Items
  const [issueOpen, setIssueOpen] = useState(false);
  const [newRows, setNewRows] = useState<any[]>([{ item_name: '', material_id: '', quantity: '', unit: 'kg', purchase_price: '', notes: '' }]);
  const [issuing, setIssuing] = useState(false);
  const [issueResult, setIssueResult] = useState<any>(null);

  // Returns
  const [returnsOpen, setReturnsOpen] = useState(false);
  const [returnsDraft, setReturnsDraft] = useState<Record<string, { returned_quantity: string; notes: string }>>({});
  const [restoreInventory, setRestoreInventory] = useState(true);
  const [submittingReturns, setSubmittingReturns] = useState(false);
  const [returnsResult, setReturnsResult] = useState<any>(null);

  const [toast, setToast] = useState<string | null>(null);

  const fetchMeals = useCallback(async () => {
    try {
      const res = await fetch('/api/staff-meals');
      const json = await res.json();
      setMeals(json.meals || []);
      setSummary(json.summary || { total_meals: 0, total_staff_fed: 0, total_cost: 0 });
    } catch (_) {}
  }, []);

  const fetchMaterials = useCallback(async () => {
    try {
      const res = await fetch('/api/inventory');
      const json = await res.json();
      setMaterials(json.materials || []);
    } catch (_) {}
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await Promise.all([fetchMeals(), fetchMaterials()]);
      setLoading(false);
    })();
  }, [fetchMeals, fetchMaterials]);

  const createMeal = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!form.date || !form.meal_type) { setFormError('Date and meal type required'); return; }
    setCreating(true);
    try {
      const res = await api('/api/staff-meals', {
        method: 'POST',
        body: { ...form, staff_count: parseInt(form.staff_count) || 0 },
      });
      if (!res.ok) throw new Error('Failed');
      setCreateOpen(false);
      setForm({ date: todayString(), meal_type: 'lunch', shift: 'All Shifts', staff_count: '', cooked_by: '', menu: '', notes: '' });
      await fetchMeals();
      setToast('Staff meal created!');
      setTimeout(() => setToast(null), 3000);
    } catch (err: any) {
      setFormError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const viewMeal = async (meal: StaffMeal) => {
    setSelectedMeal(meal);
    setDetailsLoading(true);
    try {
      const res = await fetch(`/api/staff-meals/items?meal_id=${meal.id}`);
      const json = await res.json();
      setMealItems(json.items || []);
    } catch (_) {}
    setDetailsLoading(false);
  };

  const deleteMeal = async (id: string) => {
    if (!confirm('Delete this staff meal and restore any issued items to stock?')) return;
    await api(`/api/staff-meals?id=${id}`, { method: 'DELETE' });
    setSelectedMeal(null);
    await fetchMeals();
    setToast('Meal deleted');
    setTimeout(() => setToast(null), 3000);
  };

  const deleteItem = async (itemId: string) => {
    await api(`/api/staff-meals/items?id=${itemId}`, { method: 'DELETE' });
    if (selectedMeal) await viewMeal(selectedMeal);
    await fetchMeals();
  };

  // Issue
  const openIssue = () => {
    setIssueOpen(true);
    setIssueResult(null);
    setNewRows([{ item_name: '', material_id: '', quantity: '', unit: 'kg', purchase_price: '', notes: '' }]);
  };

  const updateRow = (idx: number, field: string, value: any) => {
    setNewRows(prev => {
      const copy = [...prev];
      copy[idx] = { ...copy[idx], [field]: value };
      if (field === 'material_id' && value) {
        const mat = materials.find(m => m.id === value);
        if (mat) {
          copy[idx].item_name = mat.name;
          copy[idx].unit = mat.unit;
          copy[idx].purchase_price = mat.average_price;
        }
      }
      return copy;
    });
  };

  const addRow = () => setNewRows(prev => [...prev, { item_name: '', material_id: '', quantity: '', unit: 'kg', purchase_price: '', notes: '' }]);
  const removeRow = (idx: number) => setNewRows(prev => prev.length === 1 ? prev : prev.filter((_, i) => i !== idx));

  const submitIssue = async () => {
    if (!selectedMeal) return;
    setIssuing(true);
    setIssueResult(null);
    try {
      const payload = newRows
        .filter(r => r.item_name.trim() && parseFloat(r.quantity) > 0)
        .map(r => ({
          meal_id: selectedMeal.id,
          item_name: r.item_name,
          material_id: r.material_id || null,
          issued_quantity: parseFloat(r.quantity),
          unit: r.unit,
          purchase_price: parseFloat(r.purchase_price) || 0,
          notes: r.notes,
        }));

      if (payload.length === 0) {
        setIssueResult({ success: 0, errors: ['No valid rows'] });
        return;
      }

      const res = await api('/api/staff-meals/items', {
        method: 'POST',
        body: { items: payload, deduct_inventory: true },
      });
      const json = await res.json();
      setIssueResult(json);
      if (json.success > 0) {
        setNewRows([{ item_name: '', material_id: '', quantity: '', unit: 'kg', purchase_price: '', notes: '' }]);
        await viewMeal(selectedMeal);
        await fetchMeals();
        await fetchMaterials();
      }
    } catch (err: any) {
      setIssueResult({ success: 0, errors: [err.message] });
    } finally {
      setIssuing(false);
    }
  };

  // Returns
  const openReturns = () => {
    const draft: Record<string, { returned_quantity: string; notes: string }> = {};
    for (const item of mealItems) {
      draft[item.id] = {
        returned_quantity: item.status === 'closed' ? String(item.returned_quantity) : '',
        notes: item.notes || '',
      };
    }
    setReturnsDraft(draft);
    setReturnsResult(null);
    setRestoreInventory(true);
    setReturnsOpen(true);
  };

  const updateReturn = (id: string, field: 'returned_quantity' | 'notes', value: string) => {
    setReturnsDraft(prev => ({ ...prev, [id]: { ...prev[id], [field]: value } }));
  };

  const submitReturns = async () => {
    if (!selectedMeal) return;
    setSubmittingReturns(true);
    setReturnsResult(null);
    try {
      const payload = mealItems
        .filter(i => returnsDraft[i.id]?.returned_quantity !== '')
        .map(i => ({
          id: i.id,
          returned_quantity: parseFloat(returnsDraft[i.id].returned_quantity) || 0,
          notes: returnsDraft[i.id].notes,
        }));

      if (payload.length === 0) {
        setReturnsResult({ success: 0, errors: ['Enter returned qty for at least one item'] });
        return;
      }

      const res = await api('/api/staff-meals/items', {
        method: 'PATCH',
        body: { returns: payload, restore_inventory: restoreInventory },
      });
      const json = await res.json();
      setReturnsResult(json);
      if (json.success > 0) {
        // Mark meal as closed if all items closed
        const allClosed = mealItems.every(i => payload.find((p: any) => p.id === i.id));
        if (allClosed) {
          await api('/api/staff-meals', {
            method: 'PUT',
            body: { id: selectedMeal.id, status: 'closed' },
          });
        }
        await viewMeal(selectedMeal);
        await fetchMeals();
        await fetchMaterials();
      }
    } catch (err: any) {
      setReturnsResult({ success: 0, errors: [err.message] });
    } finally {
      setSubmittingReturns(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] p-6 animate-pulse">
        <div className="max-w-7xl mx-auto space-y-6">
          <div className="h-9 w-64 bg-[#FFF1E3] rounded-lg" />
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 sm:gap-4">
            {[...Array(3)].map((_, i) => <div key={i} className="bg-white border border-[#E8D5C4] rounded-xl p-6 h-32" />)}
          </div>
        </div>
      </div>
    );
  }

  const totalConsumed = mealItems.reduce((s, i) => s + i.quantity * i.purchase_price, 0);
  const openItemsCount = mealItems.filter(i => i.status === 'issued').length;

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-3">
              <Utensils className="w-8 h-8" />
              Staff Meals
            </h1>
            <p className="text-[#8B7355] text-sm mt-1">Track ingredients issued for staff food & recover unused items</p>
          </div>
          <button
            onClick={() => setCreateOpen(true)}
            className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium transition-colors"
          >
            <Plus className="w-4 h-4" />
            New Staff Meal
          </button>
        </div>

        {/* Summary */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <SummaryCard icon={<Utensils className="w-4 h-4 text-purple-500" />} label="Total Meals" value={String(summary.total_meals || 0)} bg="bg-purple-50" />
          <SummaryCard icon={<Users className="w-4 h-4 text-blue-500" />} label="Total Staff Fed" value={Number(summary.total_staff_fed || 0).toLocaleString('en-IN')} bg="bg-blue-50" />
          <SummaryCard icon={<IndianRupee className="w-4 h-4 text-red-500" />} label="Total Cost" value={formatCurrency(summary.total_cost || 0)} bg="bg-red-50" />
          <SummaryCard
            icon={<ChefHat className="w-4 h-4 text-green-600" />}
            label="Avg Cost / Staff"
            value={summary.total_staff_fed > 0 ? formatCurrency(Math.round((summary.total_cost || 0) / summary.total_staff_fed)) : '₹0'}
            bg="bg-green-50"
          />
        </div>

        {/* Main grid */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* Meals List */}
          <div className="lg:col-span-2 space-y-3">
            <h2 className="text-lg font-semibold text-[#2D1B0E]">All Staff Meals</h2>
            {meals.length === 0 ? (
              <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center">
                <Utensils className="w-10 h-10 text-[#8B7355] mx-auto mb-3 opacity-40" />
                <p className="text-[#8B7355]">No staff meals yet</p>
                <p className="text-xs text-[#8B7355] mt-1">Click &quot;New Staff Meal&quot; to start</p>
              </div>
            ) : meals.map(m => (
              <div
                key={m.id}
                onClick={() => viewMeal(m)}
                className={`bg-white border rounded-xl p-4 shadow cursor-pointer transition-all hover:shadow-md ${selectedMeal?.id === m.id ? 'border-[#af4408] ring-1 ring-[#af4408]/30' : 'border-[#E8D5C4]'}`}
              >
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <h3 className="font-semibold text-[#2D1B0E] capitalize">{m.meal_type} • {formatDate(m.date)}</h3>
                    <p className="text-xs text-[#8B7355]">
                      {m.shift && `${m.shift} • `}{m.staff_count} staff{m.cooked_by && ` • Chef: ${m.cooked_by}`}
                    </p>
                  </div>
                  <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full border ${
                    m.open_items > 0 ? 'bg-blue-100 text-blue-700 border-blue-200' : 'bg-green-100 text-green-700 border-green-200'
                  }`}>
                    {m.open_items > 0 ? `${m.open_items} open` : 'Closed'}
                  </span>
                </div>
                {m.total_items > 0 && (
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div><span className="text-[#8B7355]">Items</span><p className="font-semibold text-[#2D1B0E]">{m.total_items}</p></div>
                    <div><span className="text-[#8B7355]">Consumed</span><p className="font-semibold text-red-500">{formatCurrency(m.total_consumed_cost)}</p></div>
                    <div><span className="text-[#8B7355]">Per Staff</span><p className="font-semibold text-[#af4408]">{m.staff_count > 0 ? formatCurrency(Math.round(m.total_consumed_cost / m.staff_count)) : '-'}</p></div>
                  </div>
                )}
                {m.menu && <p className="mt-2 text-[10px] text-[#8B7355] italic">Menu: {m.menu}</p>}
              </div>
            ))}
          </div>

          {/* Details Panel */}
          <div className="lg:col-span-3">
            {!selectedMeal ? (
              <div className="bg-white border border-[#E8D5C4] rounded-xl p-12 text-center">
                <Eye className="w-12 h-12 text-[#8B7355] mx-auto mb-3 opacity-30" />
                <p className="text-[#8B7355]">Select a staff meal to view details</p>
              </div>
            ) : detailsLoading ? (
              <div className="bg-white border border-[#E8D5C4] rounded-xl p-12 text-center">
                <Loader2 className="w-8 h-8 text-[#af4408] animate-spin mx-auto" />
              </div>
            ) : (
              <div className="space-y-4">
                {/* Meal Header */}
                <div className="bg-white border border-[#E8D5C4] rounded-xl p-5 shadow">
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <h2 className="text-xl font-bold text-[#2D1B0E] capitalize">{selectedMeal.meal_type} • {formatDate(selectedMeal.date)}</h2>
                      <p className="text-sm text-[#8B7355]">
                        {selectedMeal.shift && `${selectedMeal.shift}`} {selectedMeal.cooked_by && ` • Chef: ${selectedMeal.cooked_by}`} {selectedMeal.staff_count > 0 && ` • ${selectedMeal.staff_count} staff`}
                      </p>
                      {selectedMeal.menu && <p className="text-sm text-[#6B5744] mt-1 italic">Menu: {selectedMeal.menu}</p>}
                    </div>
                    <button onClick={() => deleteMeal(selectedMeal.id)} className="p-1.5 text-red-400 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>
                  </div>

                  {/* Cost Summary */}
                  {mealItems.length > 0 && (
                    <div className="grid grid-cols-3 gap-3 text-center bg-[#FFF8F0] border border-[#E8D5C4] rounded-lg p-3">
                      <div>
                        <p className="text-[10px] text-[#8B7355] uppercase">Issued Value</p>
                        <p className="text-lg font-bold text-[#af4408]">{formatCurrency(selectedMeal.total_issued_value)}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-[#8B7355] uppercase">Returned Value</p>
                        <p className="text-lg font-bold text-green-600">{formatCurrency(selectedMeal.total_returned_value)}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-[#8B7355] uppercase">Net Cost (Consumed)</p>
                        <p className="text-lg font-bold text-red-500">{formatCurrency(totalConsumed)}</p>
                      </div>
                    </div>
                  )}
                  {selectedMeal.staff_count > 0 && totalConsumed > 0 && (
                    <p className="text-xs text-[#8B7355] text-center mt-2">
                      Cost per staff: <span className="font-semibold text-[#af4408]">{formatCurrency(Math.round(totalConsumed / selectedMeal.staff_count))}</span>
                    </p>
                  )}
                </div>

                {/* Actions */}
                <div className="flex gap-2 flex-wrap">
                  <button onClick={openIssue} className="flex items-center gap-2 px-4 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium transition-colors">
                    <Plus className="w-4 h-4" />Issue Items (Opening)
                  </button>
                  {mealItems.length > 0 && (
                    <button onClick={openReturns} className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-medium transition-colors">
                      <Link2Off className="w-4 h-4" />Record Returns (Closing)
                    </button>
                  )}
                </div>

                {/* Items Table */}
                <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
                  <div className="px-4 py-3 border-b border-[#E8D5C4] flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-[#2D1B0E]">Ingredients ({mealItems.length})</h3>
                    {openItemsCount > 0 && <span className="text-xs text-blue-600 font-medium">{openItemsCount} open</span>}
                  </div>
                  {mealItems.length === 0 ? (
                    <div className="p-8 text-center text-[#8B7355] text-sm">
                      No ingredients issued yet. Click &quot;Issue Items&quot; to start tracking what the kitchen took out.
                    </div>
                  ) : (
                    <div className="overflow-x-auto max-h-96 overflow-y-auto">
                      <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-[#FFF1E3] z-10">
                          <tr className="text-[#8B7355]">
                            <th className="text-left py-2 px-3 font-medium">Item</th>
                            <th className="text-right py-2 px-3 font-medium">Issued</th>
                            <th className="text-right py-2 px-3 font-medium">Returned</th>
                            <th className="text-right py-2 px-3 font-medium">Consumed</th>
                            <th className="text-right py-2 px-3 font-medium">Cost/Unit</th>
                            <th className="text-right py-2 px-3 font-medium">Net Cost</th>
                            <th className="text-center py-2 px-2">Status</th>
                            <th className="py-2 px-2 w-8"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {mealItems.map(item => {
                            const isOpen = item.status === 'issued';
                            return (
                              <tr key={item.id} className={`border-t border-[#E8D5C4]/50 ${isOpen ? 'bg-blue-50/30' : ''}`}>
                                <td className="py-2 px-3 text-xs font-medium text-[#2D1B0E]">{item.item_name}</td>
                                <td className="py-2 px-3 text-right text-xs font-mono text-[#af4408] font-semibold">{item.issued_quantity} {item.unit}</td>
                                <td className="py-2 px-3 text-right text-xs font-mono text-green-600">{isOpen ? <span className="text-[#C4B09A]">—</span> : `${item.returned_quantity} ${item.unit}`}</td>
                                <td className="py-2 px-3 text-right text-xs font-mono text-red-500 font-semibold">{isOpen ? <span className="text-[#C4B09A]">pending</span> : `${item.quantity} ${item.unit}`}</td>
                                <td className="py-2 px-3 text-right text-xs font-mono text-[#6B5744]">{formatCurrency(item.purchase_price)}</td>
                                <td className="py-2 px-3 text-right text-xs font-mono text-red-500 font-semibold">{isOpen ? <span className="text-[#C4B09A]">—</span> : formatCurrency(item.total_cost)}</td>
                                <td className="py-2 px-2 text-center">
                                  {isOpen ? <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 border border-blue-200">Open</span> : <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-100 text-green-700 border border-green-200">Closed</span>}
                                </td>
                                <td className="py-2 px-1">
                                  <button onClick={() => deleteItem(item.id)} className="p-1 text-red-400 hover:text-red-600"><Trash2 className="w-3.5 h-3.5" /></button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3 px-5 py-3 bg-green-600 text-white rounded-lg shadow-lg">
          <span className="text-sm font-medium">{toast}</span>
          <button onClick={() => setToast(null)}><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* Create Modal */}
      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setCreateOpen(false)} />
          <div className="relative w-full max-w-lg bg-white border border-[#E8D5C4] rounded-2xl shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8D5C4]">
              <h2 className="text-lg font-semibold text-[#2D1B0E] flex items-center gap-2"><Utensils className="w-5 h-5 text-[#af4408]" />New Staff Meal</h2>
              <button onClick={() => setCreateOpen(false)} className="p-1.5 rounded-lg hover:bg-[#FFF1E3]"><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={createMeal} className="px-6 py-5 space-y-4">
              {formError && (
                <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">
                  <AlertCircle className="w-4 h-4" /> {formError}
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-[#6B5744] mb-1">Date *</label>
                  <input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm [color-scheme:light]" required />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[#6B5744] mb-1">Meal Type *</label>
                  <select value={form.meal_type} onChange={e => setForm(f => ({ ...f, meal_type: e.target.value }))} className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm" required>
                    {MEAL_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-[#6B5744] mb-1">Shift</label>
                  <select value={form.shift} onChange={e => setForm(f => ({ ...f, shift: e.target.value }))} className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm">
                    {SHIFT_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-[#6B5744] mb-1">Staff Count</label>
                  <input type="number" min="0" value={form.staff_count} onChange={e => setForm(f => ({ ...f, staff_count: e.target.value }))} placeholder="15" className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-[#6B5744] mb-1">Cooked By</label>
                <input type="text" value={form.cooked_by} onChange={e => setForm(f => ({ ...f, cooked_by: e.target.value }))} placeholder="Chef name" className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-[#6B5744] mb-1">Menu</label>
                <input type="text" value={form.menu} onChange={e => setForm(f => ({ ...f, menu: e.target.value }))} placeholder="Dal, Rice, Sabzi, Roti" className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-[#6B5744] mb-1">Notes</label>
                <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2} className="w-full px-3 py-2 bg-[#FFF1E3] border border-[#D4B896] rounded-lg text-sm resize-none" />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setCreateOpen(false)} className="px-4 py-2 text-sm text-[#6B5744] bg-[#FFF1E3] rounded-lg hover:bg-[#E8D5C4]">Cancel</button>
                <button type="submit" disabled={creating} className="flex items-center gap-2 px-5 py-2 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 text-white rounded-lg text-sm font-medium">
                  {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                  {creating ? 'Creating...' : 'Create Meal'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Issue Items Modal */}
      {issueOpen && selectedMeal && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-6 pb-6 overflow-y-auto">
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setIssueOpen(false)} />
          <div className="relative w-full max-w-5xl bg-white rounded-2xl shadow-xl border border-[#E8D5C4] mx-4">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8D5C4] sticky top-0 bg-white z-20">
              <div>
                <h2 className="text-lg font-semibold text-[#2D1B0E]">Issue Ingredients — {selectedMeal.meal_type}</h2>
                <p className="text-xs text-[#8B7355]">Bulk items kitchen is taking for cooking. Stock will deduct from main inventory.</p>
              </div>
              <button onClick={() => setIssueOpen(false)} className="p-1 text-[#8B7355] hover:text-[#2D1B0E]"><X className="w-5 h-5" /></button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div className="overflow-x-auto rounded-xl border border-[#E8D5C4]">
                <table className="w-full text-sm">
                  <thead className="bg-[#FFF1E3]">
                    <tr className="text-[#6B5744]">
                      <th className="text-left py-2.5 px-2 font-medium w-[35%]">Material</th>
                      <th className="text-right py-2.5 px-2 font-medium w-[12%]">Issue Qty *</th>
                      <th className="text-left py-2.5 px-2 font-medium w-[10%]">Unit</th>
                      <th className="text-right py-2.5 px-2 font-medium w-[14%]">Cost/Unit</th>
                      <th className="text-left py-2.5 px-2 font-medium w-[20%]">Notes</th>
                      <th className="py-2.5 px-2 w-8"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {newRows.map((row, idx) => (
                      <tr key={idx} className="border-t border-[#E8D5C4]/50">
                        <td className="py-2 px-2">
                          <select value={row.material_id} onChange={e => updateRow(idx, 'material_id', e.target.value)} className="w-full px-2 py-1.5 bg-white border border-[#D4B896] rounded text-xs focus:outline-none focus:ring-1 focus:ring-[#af4408]">
                            <option value="">Select from inventory...</option>
                            {materials.map(m => <option key={m.id} value={m.id}>{m.name} ({m.unit}) — ₹{m.average_price}</option>)}
                          </select>
                          <input type="text" value={row.item_name} onChange={e => updateRow(idx, 'item_name', e.target.value)} placeholder="Or enter name" className="w-full mt-1 px-2 py-1.5 bg-white border border-[#D4B896] rounded text-xs focus:outline-none focus:ring-1 focus:ring-[#af4408]" />
                        </td>
                        <td className="py-2 px-2">
                          <input type="number" step="0.01" min="0" value={row.quantity} onChange={e => updateRow(idx, 'quantity', e.target.value)} placeholder="0" className="w-full px-2 py-1.5 bg-white border border-[#D4B896] rounded text-xs text-right font-mono focus:outline-none focus:ring-1 focus:ring-[#af4408]" />
                        </td>
                        <td className="py-2 px-2">
                          <input type="text" value={row.unit} onChange={e => updateRow(idx, 'unit', e.target.value)} className="w-full px-2 py-1.5 bg-white border border-[#D4B896] rounded text-xs focus:outline-none focus:ring-1 focus:ring-[#af4408]" />
                        </td>
                        <td className="py-2 px-2">
                          <input type="number" step="0.01" min="0" value={row.purchase_price} onChange={e => updateRow(idx, 'purchase_price', e.target.value)} placeholder="0" className="w-full px-2 py-1.5 bg-white border border-[#D4B896] rounded text-xs text-right font-mono focus:outline-none focus:ring-1 focus:ring-[#af4408]" />
                        </td>
                        <td className="py-2 px-2">
                          <input type="text" value={row.notes} onChange={e => updateRow(idx, 'notes', e.target.value)} placeholder="Optional" className="w-full px-2 py-1.5 bg-white border border-[#D4B896] rounded text-xs focus:outline-none focus:ring-1 focus:ring-[#af4408]" />
                        </td>
                        <td className="py-2 px-1">
                          {newRows.length > 1 && <button onClick={() => removeRow(idx)} className="p-1 text-red-400 hover:text-red-600"><Trash2 className="w-3.5 h-3.5" /></button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex gap-3">
                <button onClick={addRow} className="flex items-center gap-1 px-3 py-2 text-xs font-medium text-[#af4408] border border-[#af4408] rounded-lg hover:bg-[#af4408]/10"><Plus className="w-3 h-3" /> Add Row</button>
                <button onClick={submitIssue} disabled={issuing} className="flex items-center gap-2 px-5 py-2 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 text-white rounded-lg text-sm font-medium">
                  {issuing ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                  {issuing ? 'Issuing...' : 'Issue Items'}
                </button>
              </div>
              {issueResult && <ResultBanner success={issueResult.success} errors={issueResult.errors} onDismiss={() => setIssueResult(null)} />}
            </div>
          </div>
        </div>
      )}

      {/* Returns Modal */}
      {returnsOpen && selectedMeal && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-6 pb-6 overflow-y-auto">
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setReturnsOpen(false)} />
          <div className="relative w-full max-w-5xl bg-white rounded-2xl shadow-xl border border-[#E8D5C4] mx-4">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8D5C4] sticky top-0 bg-white z-20">
              <div>
                <h2 className="text-lg font-semibold text-[#2D1B0E]">Record Returns — {selectedMeal.meal_type}</h2>
                <p className="text-xs text-[#8B7355]">Enter unused ingredients coming back from the kitchen</p>
              </div>
              <button onClick={() => setReturnsOpen(false)} className="p-1 text-[#8B7355] hover:text-[#2D1B0E]"><X className="w-5 h-5" /></button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <label className="flex items-center gap-2 cursor-pointer bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 w-fit">
                <input type="checkbox" checked={restoreInventory} onChange={e => setRestoreInventory(e.target.checked)} className="accent-[#af4408] w-4 h-4" />
                <span className="text-xs text-amber-800 font-medium">Restore returned qty to main inventory</span>
              </label>
              <div className="overflow-x-auto max-h-[55vh] overflow-y-auto rounded-lg border border-[#E8D5C4]">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-[#FFF1E3] z-10">
                    <tr className="text-[#8B7355]">
                      <th className="text-left py-2.5 px-3 font-medium">Item</th>
                      <th className="text-right py-2.5 px-3 font-medium">Issued</th>
                      <th className="text-right py-2.5 px-3 font-medium w-32">Returned *</th>
                      <th className="text-right py-2.5 px-3 font-medium">Consumed</th>
                      <th className="text-right py-2.5 px-3 font-medium">Cost</th>
                      <th className="text-left py-2.5 px-3 font-medium w-40">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mealItems.map(item => {
                      const draft = returnsDraft[item.id] || { returned_quantity: '', notes: '' };
                      const returnedVal = parseFloat(draft.returned_quantity);
                      const isValid = !isNaN(returnedVal) && returnedVal >= 0 && returnedVal <= item.issued_quantity;
                      const consumed = !isNaN(returnedVal) ? item.issued_quantity - returnedVal : null;
                      const costPreview = consumed !== null ? Math.round(consumed * item.purchase_price * 100) / 100 : null;
                      return (
                        <tr key={item.id} className="border-t border-[#E8D5C4]/50">
                          <td className="py-2 px-3 text-xs font-medium text-[#2D1B0E]">
                            {item.item_name}
                            {item.status === 'closed' && <span className="ml-1 text-[10px] text-green-600">(closed)</span>}
                          </td>
                          <td className="py-2 px-3 text-right text-xs font-mono text-[#af4408] font-semibold">{item.issued_quantity} {item.unit}</td>
                          <td className="py-2 px-2">
                            <input type="number" step="0.01" min="0" max={item.issued_quantity} value={draft.returned_quantity} onChange={e => updateReturn(item.id, 'returned_quantity', e.target.value)} placeholder="0" className={`w-full px-2 py-1 border rounded text-xs text-right font-mono focus:outline-none focus:ring-1 focus:ring-[#af4408] ${!isValid && draft.returned_quantity !== '' ? 'border-red-400 bg-red-50' : 'bg-white border-[#D4B896]'}`} />
                          </td>
                          <td className={`py-2 px-3 text-right text-xs font-mono font-semibold ${consumed !== null ? 'text-red-500' : 'text-[#C4B09A]'}`}>
                            {consumed !== null ? `${consumed} ${item.unit}` : '—'}
                          </td>
                          <td className="py-2 px-3 text-right text-xs font-mono text-red-500">
                            {costPreview !== null ? formatCurrency(costPreview) : '—'}
                          </td>
                          <td className="py-2 px-2">
                            <input type="text" value={draft.notes} onChange={e => updateReturn(item.id, 'notes', e.target.value)} placeholder="Optional" className="w-full px-2 py-1 bg-white border border-[#D4B896] rounded text-xs focus:outline-none focus:ring-1 focus:ring-[#af4408]" />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-end gap-3">
                <button onClick={() => setReturnsOpen(false)} className="px-4 py-2 text-sm text-[#6B5744] bg-[#FFF1E3] rounded-lg hover:bg-[#E8D5C4]">Cancel</button>
                <button onClick={submitReturns} disabled={submittingReturns} className="flex items-center gap-2 px-5 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium">
                  {submittingReturns ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                  {submittingReturns ? 'Saving...' : 'Close Meal & Save Returns'}
                </button>
              </div>
              {returnsResult && <ResultBanner success={returnsResult.success} errors={returnsResult.errors} onDismiss={() => setReturnsResult(null)} />}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryCard({ icon, label, value, bg }: { icon: React.ReactNode; label: string; value: string; bg: string }) {
  return (
    <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 shadow">
      <div className="flex items-center gap-2 mb-1">
        <div className={`p-1.5 rounded-lg ${bg}`}>{icon}</div>
        <span className="text-xs text-[#8B7355]">{label}</span>
      </div>
      <p className="text-xl font-bold text-[#2D1B0E]">{value}</p>
    </div>
  );
}

function ResultBanner({ success, errors, onDismiss }: { success: number; errors: string[]; onDismiss: () => void }) {
  return (
    <div className={`p-3 rounded-lg border ${errors?.length > 0 && success === 0 ? 'bg-red-50 border-red-200' : errors?.length > 0 ? 'bg-amber-50 border-amber-200' : 'bg-green-50 border-green-200'}`}>
      <div className="flex items-start gap-2 text-sm">
        {success > 0 ? <CheckCircle className="w-4 h-4 text-green-600 mt-0.5" /> : <AlertCircle className="w-4 h-4 text-red-500 mt-0.5" />}
        <div className="flex-1">
          {success > 0 && <p className="text-green-700">{success} item(s) saved!</p>}
          {errors?.map((e: string, i: number) => <p key={i} className="text-red-600 text-xs">{e}</p>)}
        </div>
        <button onClick={onDismiss} className="text-xs text-[#8B7355]">Dismiss</button>
      </div>
    </div>
  );
}
