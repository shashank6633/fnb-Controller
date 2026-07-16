'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { BarChart3, Building2, Loader2 } from 'lucide-react';

/**
 * Settings → Dashboard: admin/manager preferences for the Sales Dashboard.
 * Currently a single toggle for the Floor Sales tab (settings key
 * `floor_sales_enabled`); more dashboard prefs can slot in here later.
 */
export default function DashboardSettingsPage() {
  const [floorSales, setFloorSales] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [me, setMe] = useState<{ role?: string } | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    api('/api/auth/me').then(r => r.json()).then(d => setMe(d?.user || null)).catch(() => {});
    fetch('/api/settings?key=floor_pnl_enabled').then(r => r.json())
      .then(d => setFloorSales(d?.value === '1')).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const canEdit = !!me && (me.role === 'admin' || me.role === 'manager');
  const flash = (ok: boolean, msg: string) => { setToast({ ok, msg }); setTimeout(() => setToast(null), 2500); };

  const save = async (on: boolean) => {
    const prev = floorSales;
    setFloorSales(on); setSaving(true);
    try {
      const r = await api('/api/settings', { method: 'PUT', body: { key: 'floor_pnl_enabled', value: on ? '1' : '0' } });
      if (!r.ok) { setFloorSales(prev); flash(false, (await r.json().catch(() => ({}))).error || 'Failed to save'); }
      else flash(true, on ? 'Floor P&L detail on' : 'Floor P&L detail off');
    } catch { setFloorSales(prev); flash(false, 'Failed to save'); }
    setSaving(false);
  };

  return (
    <div className="min-h-screen bg-[#FFF8F0]">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-[#af4408]/10 rounded-lg"><BarChart3 className="w-6 h-6 text-[#af4408]" /></div>
          <div>
            <h1 className="text-2xl font-bold text-[#af4408]">Dashboard Settings</h1>
            <p className="text-sm text-[#8B7355]">Control what appears on the Sales Dashboard.</p>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-[#8B7355] py-10 justify-center"><Loader2 className="w-5 h-5 animate-spin" /> Loading…</div>
        ) : (
          <div className="bg-white border border-[#E8D5C4] rounded-xl divide-y divide-[#F0E6D8]">
            <div className="flex items-start justify-between gap-4 p-5">
              <div>
                <p className="font-semibold text-[#2D1B0E] flex items-center gap-1.5"><Building2 className="w-4 h-4 text-[#af4408]" /> Floor P&amp;L detail</p>
                <p className="text-sm text-[#8B7355] mt-0.5">Show <b>Food Cost, Gross Profit and GP%</b> on the Sales-by-Floor breakdown (Daily Dashboard). Off shows sales only. Off by default.</p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer shrink-0 mt-1">
                <input type="checkbox" className="sr-only peer" checked={floorSales} disabled={!canEdit || saving} onChange={(e) => save(e.target.checked)} />
                <div className="w-11 h-6 bg-[#E8D5C4] rounded-full peer peer-checked:bg-[#af4408] peer-disabled:opacity-50 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-transform peer-checked:after:translate-x-5" />
              </label>
            </div>
          </div>
        )}
        {!loading && !canEdit && <p className="text-xs text-[#8B7355]">Manager or Admin access is required to change these settings.</p>}
        {toast && <div className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg text-sm text-white ${toast.ok ? 'bg-emerald-600' : 'bg-red-600'}`}>{toast.msg}</div>}
      </div>
    </div>
  );
}
