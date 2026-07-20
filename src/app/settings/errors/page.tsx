'use client';

/**
 * Settings → App Errors (ADMIN only).
 *
 * The admin-facing side of crash-proofing: every captured production error
 * (web + captain + server), most-recent first, with occurrence counts, the
 * affected user/URL, and the stack. Admins resolve handled errors and can set an
 * optional WhatsApp number that gets pinged when a NEW error appears.
 *
 * GET   /api/error-report            → { errors, unresolved, alert_phone }
 * PATCH /api/error-report            → { action: 'resolve' | 'resolve_all' | 'set_alert_phone' }
 * Data is admin-gated server-side; the route is adminOnly in the page catalog.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import {
  AlertTriangle, RefreshCw, CheckCircle2, Loader2, ShieldAlert, Bell, Save,
  ChevronDown, ChevronRight, Globe, Server, Smartphone, Monitor, Lock,
} from 'lucide-react';

interface ErrorRow {
  id: string; digest: string; source: string; message: string; stack: string;
  url: string; user_email: string; user_role: string; user_agent: string;
  count: number; first_seen: string; last_seen: string;
  resolved_at: string | null; resolved_by: string; notified_at: string | null;
}

function istWhen(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso.includes('Z') || iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
}

const SOURCE_META: Record<string, { label: string; cls: string; Icon: typeof Globe }> = {
  web:     { label: 'Web',     cls: 'bg-blue-50 text-blue-700 border-blue-200',       Icon: Monitor },
  captain: { label: 'Captain', cls: 'bg-purple-50 text-purple-700 border-purple-200', Icon: Smartphone },
  server:  { label: 'Server',  cls: 'bg-amber-50 text-amber-800 border-amber-200',    Icon: Server },
  client:  { label: 'Client',  cls: 'bg-slate-100 text-slate-700 border-slate-200',   Icon: Globe },
};

export default function AppErrorsPage() {
  const [errors, setErrors] = useState<ErrorRow[]>([]);
  const [unresolved, setUnresolved] = useState(0);
  const [alertPhone, setAlertPhone] = useState('');
  const [phoneInput, setPhoneInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [savingPhone, setSavingPhone] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2500); };

  const load = useCallback(async () => {
    setLoading(true); setLoadError(null);
    try {
      const res = await fetch('/api/error-report', { cache: 'no-store' });
      if (res.status === 401 || res.status === 403) { setForbidden(true); return; }
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setLoadError(j?.error || `HTTP ${res.status}`); return; }
      setErrors(Array.isArray(j.errors) ? j.errors : []);
      setUnresolved(Number(j.unresolved) || 0);
      setAlertPhone(j.alert_phone || '');
      setPhoneInput(j.alert_phone || '');
    } catch {
      setLoadError('Network error — could not load errors');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const resolve = async (id: string) => {
    setBusy(id);
    try {
      const res = await api('/api/error-report', { method: 'PATCH', body: { action: 'resolve', id } });
      if (res.ok) { flash('Marked resolved'); await load(); }
      else flash('Could not resolve');
    } catch { flash('Could not resolve'); } finally { setBusy(null); }
  };

  const resolveAll = async () => {
    if (!window.confirm('Mark ALL open errors as resolved?')) return;
    setBusy('all');
    try {
      const res = await api('/api/error-report', { method: 'PATCH', body: { action: 'resolve_all' } });
      if (res.ok) { flash('All open errors resolved'); await load(); }
      else flash('Could not resolve all');
    } catch { flash('Could not resolve all'); } finally { setBusy(null); }
  };

  const savePhone = async () => {
    setSavingPhone(true);
    try {
      const res = await api('/api/error-report', { method: 'PATCH', body: { action: 'set_alert_phone', phone: phoneInput.trim() } });
      const j = await res.json().catch(() => ({}));
      if (res.ok) { setAlertPhone(j.alert_phone || ''); setPhoneInput(j.alert_phone || ''); flash('Alert number saved'); }
      else flash('Could not save number');
    } catch { flash('Could not save number'); } finally { setSavingPhone(false); }
  };

  const shown = showResolved ? errors : errors.filter(e => !e.resolved_at);

  if (forbidden) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] flex items-center justify-center p-6">
        <div className="max-w-sm text-center text-[#6B5744]">
          <Lock className="w-10 h-10 mx-auto mb-3 text-[#af4408]" />
          <h1 className="text-lg font-bold text-[#2D1B0E]">Admins only</h1>
          <p className="text-sm mt-1">The App Errors console is restricted to admin accounts.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-5xl mx-auto px-3 sm:px-6 py-5 sm:py-6 space-y-4">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold text-[#8B7355] uppercase tracking-wider">Settings</p>
            <h1 className="text-2xl sm:text-3xl font-bold mt-0.5 flex items-center gap-2.5">
              <ShieldAlert className="w-7 h-7 text-[#af4408]" />App Errors
            </h1>
            <p className="text-sm text-[#8B7355] mt-1">Production errors captured across the web app and Captain app. You&apos;re notified here automatically.</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={load} className="flex items-center gap-2 px-3 py-2.5 bg-white border border-[#E0D0BE] hover:bg-[#FFF1E3] text-[#6B5744] rounded-xl text-sm font-medium shadow-sm">
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />Refresh
            </button>
            {unresolved > 0 && (
              <button onClick={resolveAll} disabled={busy === 'all'} className="flex items-center gap-2 px-3 py-2.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-xl text-sm font-semibold shadow-sm disabled:opacity-60">
                {busy === 'all' ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}Resolve all
              </button>
            )}
          </div>
        </div>

        {/* Alert number */}
        <div className="bg-white border border-[#E8D5C4] rounded-2xl p-4 shadow-sm">
          <div className="flex items-center gap-2 text-sm font-semibold text-[#2D1B0E]"><Bell className="w-4 h-4 text-[#af4408]" />WhatsApp alert number (optional)</div>
          <p className="text-xs text-[#8B7355] mt-1">When a new error appears, ping this number (best-effort, throttled to avoid spam). Leave blank to rely on the in-app bell + this page only.</p>
          <div className="flex flex-wrap items-center gap-2 mt-2.5">
            <input value={phoneInput} onChange={e => setPhoneInput(e.target.value)} inputMode="tel" placeholder="e.g. 9198XXXXXXXX"
                   className="flex-1 min-w-[180px] px-3 py-2.5 bg-white border border-[#D4B896] rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]/40" />
            <button onClick={savePhone} disabled={savingPhone || phoneInput.trim() === alertPhone.trim()}
                    className="flex items-center gap-2 px-4 py-2.5 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 text-white rounded-xl text-sm font-semibold">
              {savingPhone ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}Save
            </button>
          </div>
        </div>

        {/* Filter */}
        <div className="flex items-center justify-between">
          <p className="text-sm text-[#6B5744]"><b className="text-[#2D1B0E]">{unresolved}</b> open{errors.length ? ` · ${errors.length} total` : ''}</p>
          <label className="flex items-center gap-2 text-sm text-[#6B5744] cursor-pointer">
            <input type="checkbox" checked={showResolved} onChange={e => setShowResolved(e.target.checked)} className="accent-[#af4408]" />
            Show resolved
          </label>
        </div>

        {loadError && (
          <div className="flex items-center gap-2 p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
            <AlertTriangle className="w-4 h-4 shrink-0" />{loadError}
          </div>
        )}

        {/* List */}
        {loading ? (
          <div className="bg-white border border-[#E8D5C4] rounded-2xl h-40 animate-pulse" />
        ) : shown.length === 0 ? (
          <div className="bg-white border border-[#E8D5C4] rounded-2xl py-16 text-center text-[#8B7355]">
            <CheckCircle2 className="w-10 h-10 mx-auto mb-3 text-green-500" />
            <p className="font-medium text-[#2D1B0E]">All clear — no {showResolved ? '' : 'open '}errors</p>
            <p className="text-xs mt-1">Captured production errors will appear here automatically.</p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {shown.map(e => {
              const meta = SOURCE_META[e.source] || SOURCE_META.web;
              const open = expanded === e.id;
              return (
                <div key={e.id} className={`bg-white border rounded-2xl shadow-sm overflow-hidden ${e.resolved_at ? 'border-[#F0E4D6] opacity-70' : 'border-[#E8D5C4]'}`}>
                  <div className="p-3.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${meta.cls}`}>
                            <meta.Icon className="w-3 h-3" />{meta.label}
                          </span>
                          {e.count > 1 && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-700 border border-red-200">×{e.count}</span>}
                          {e.resolved_at && <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-green-100 text-green-700 border border-green-200">Resolved</span>}
                        </div>
                        <p className="font-semibold text-[13px] text-[#2D1B0E] mt-1.5 break-words">{e.message}</p>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-[#8B7355] mt-1">
                          <span>Last: {istWhen(e.last_seen)}</span>
                          <span>First: {istWhen(e.first_seen)}</span>
                          {e.user_email && <span>User: {e.user_email}{e.user_role ? ` (${e.user_role})` : ''}</span>}
                          {e.url && <span className="truncate max-w-[240px]" title={e.url}>{e.url}</span>}
                          {e.notified_at && <span className="text-[#af4408]">WhatsApp sent</span>}
                        </div>
                      </div>
                      {!e.resolved_at && (
                        <button onClick={() => resolve(e.id)} disabled={busy === e.id}
                                className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 bg-white border border-[#E0D0BE] hover:border-green-400 hover:bg-green-50 hover:text-green-700 text-[#6B5744] rounded-lg text-xs font-semibold disabled:opacity-50">
                          {busy === e.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}Resolve
                        </button>
                      )}
                    </div>
                    {e.stack && (
                      <button onClick={() => setExpanded(open ? null : e.id)} className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-[#af4408] hover:underline">
                        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}{open ? 'Hide' : 'Show'} stack trace
                      </button>
                    )}
                  </div>
                  {open && e.stack && (
                    <pre className="bg-[#2D1B0E] text-[#F3E2D0] text-[11px] leading-relaxed px-4 py-3 overflow-x-auto whitespace-pre-wrap break-words">{e.stack}</pre>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-5 py-3 bg-white border border-[#E8D5C4] text-[#2D1B0E] rounded-xl shadow-lg text-sm font-medium">
          <CheckCircle2 className="w-4 h-4 text-green-600" />{toast}
        </div>
      )}
    </div>
  );
}
