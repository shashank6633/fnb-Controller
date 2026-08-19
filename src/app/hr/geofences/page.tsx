'use client';

/**
 * HR Geofences — Phase 2 attendance engine (contract: docs/HRMS_DECISIONS.md
 * §8.2/§8.5; D3 in §1).
 *
 * Geofences gate GPS check-ins per outlet. Radius, accuracy threshold and
 * grace are DATA on this page — never code (the evaluator in src/lib/hr-geo.ts
 * reads them per fence). The GPS *capture* UI itself (the employee CHECK IN
 * button) is deferred with employee self-service by owner ruling §8.3 — this
 * page only maintains the fences that flow will evaluate against.
 *
 * The page is adminOnly via its page-catalog flag; the API re-checks
 * (GET canManageHr, mutations canAdminHr) and the 403 is surfaced as friendly
 * copy instead of pretending the buttons will work. Soft delete only —
 * the Active toggle PUTs is_active; rows are never removed.
 *
 * Structure copied from src/app/vendors/page.tsx (the canonical CRUD page);
 * error/403 handling copied from src/app/hr/settings/page.tsx.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Edit,
  Info,
  Loader2,
  LocateFixed,
  Plus,
  Radar,
  Save,
  X,
} from 'lucide-react';
import { api } from '@/lib/api';
import Toggle from '@/components/Toggle';
import Combobox, { type ComboOption } from '@/components/Combobox';
import type { HrGeofence } from '@/lib/hr';

interface OutletRow {
  id: string;
  name: string;
  is_active?: number;
}

/** Modal form state — numbers stay strings while typing; parsed on save. */
interface GeofenceForm {
  id?: string;
  name: string;
  outlet_id: string;
  lat: string;
  lng: string;
  radius_m: string;
  accuracy_threshold_m: string;
  grace_seconds: string;
  is_active: number;
}

const emptyForm = (): GeofenceForm => ({
  name: '',
  outlet_id: '',
  lat: '',
  lng: '',
  // Mirror the schema defaults so a blank save produces the same row the DB would.
  radius_m: '100',
  accuracy_threshold_m: '50',
  grace_seconds: '300',
  is_active: 1,
});

const toForm = (g: HrGeofence): GeofenceForm => ({
  id: g.id,
  name: g.name,
  outlet_id: g.outlet_id || '',
  lat: String(g.lat),
  lng: String(g.lng),
  radius_m: String(g.radius_m),
  accuracy_threshold_m: String(g.accuracy_threshold_m),
  grace_seconds: String(g.grace_seconds),
  is_active: g.is_active,
});

/**
 * Client-side validation MIRRORS the API exactly (lat [-90,90], lng
 * [-180,180], radius_m > 0) so the user sees the message before the round
 * trip; the server remains the authority.
 */
function validateForm(f: GeofenceForm): string | null {
  if (!f.name.trim()) return 'Name is required.';
  const lat = Number(f.lat);
  if (f.lat.trim() === '' || !Number.isFinite(lat) || lat < -90 || lat > 90)
    return 'Latitude must be a number between -90 and 90.';
  const lng = Number(f.lng);
  if (f.lng.trim() === '' || !Number.isFinite(lng) || lng < -180 || lng > 180)
    return 'Longitude must be a number between -180 and 180.';
  const radius = Number(f.radius_m);
  if (f.radius_m.trim() === '' || !Number.isFinite(radius) || radius <= 0)
    return 'Radius must be a number greater than 0 (metres).';
  if (f.accuracy_threshold_m.trim() !== '') {
    const acc = Number(f.accuracy_threshold_m);
    if (!Number.isFinite(acc) || acc <= 0)
      return 'Accuracy threshold must be a number greater than 0 (metres).';
  }
  if (f.grace_seconds.trim() !== '') {
    const grace = Number(f.grace_seconds);
    if (!Number.isFinite(grace) || grace < 0 || !Number.isInteger(grace))
      return 'Grace must be a whole number of seconds (0 or more).';
  }
  return null;
}

export default function HrGeofencesPage() {
  const [geofences, setGeofences] = useState<HrGeofence[] | null>(null);
  const [outlets, setOutlets] = useState<OutletRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const [editing, setEditing] = useState<GeofenceForm | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [modalNote, setModalNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [locating, setLocating] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Bare fetch for GETs; outlets failing must not kill the page (the
      // outlet picker just degrades), so it gets its own catch.
      const [gRes, oRes] = await Promise.all([
        fetch('/api/hr/geofences?include_inactive=1'),
        fetch('/api/outlets').catch(() => null),
      ]);
      const gJson = await gRes.json().catch(() => null);
      if (!gRes.ok) {
        setError(
          gJson?.error ||
            (gRes.status === 403 ? 'Geofences is admin-only.' : 'Could not load geofences.'),
        );
        setGeofences(null);
        return;
      }
      setGeofences(Array.isArray(gJson?.geofences) ? gJson.geofences : []);
      if (oRes && oRes.ok) {
        const oJson = await oRes.json().catch(() => null);
        setOutlets(Array.isArray(oJson?.outlets) ? oJson.outlets : []);
      }
    } catch {
      setError('Could not load geofences. Check your connection and retry.');
      setGeofences(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const outletNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of outlets) m.set(o.id, o.name);
    return m;
  }, [outlets]);

  const outletOptions = useMemo<ComboOption[]>(
    () => [
      { value: '', label: 'Any outlet' },
      ...outlets
        .filter((o) => o.is_active !== 0)
        .map((o) => ({ value: o.id, label: o.name })),
    ],
    [outlets],
  );

  const visible = useMemo(() => {
    const list = geofences || [];
    return showInactive ? list : list.filter((g) => g.is_active);
  }, [geofences, showInactive]);

  const friendly = (status: number, serverMsg: string | undefined, fallback: string): string => {
    if (status === 403) return 'Only admins can change geofences — ask an admin to make this change.';
    return serverMsg || fallback;
  };

  const openModal = (form: GeofenceForm) => {
    setModalError(null);
    setModalNote(null);
    setEditing(form);
  };

  const save = async () => {
    if (!editing) return;
    const invalid = validateForm(editing);
    if (invalid) {
      setModalError(invalid);
      return;
    }
    setSaving(true);
    setModalError(null);
    try {
      const isNew = !editing.id;
      // Contract payload: POST { name, outlet_id?, lat, lng, radius_m?,
      // accuracy_threshold_m?, grace_seconds? } / PUT { id, ...fields }.
      const body: Record<string, unknown> = {
        name: editing.name.trim(),
        outlet_id: editing.outlet_id || '',
        lat: Number(editing.lat),
        lng: Number(editing.lng),
      };
      if (editing.radius_m.trim() !== '') body.radius_m = Number(editing.radius_m);
      if (editing.accuracy_threshold_m.trim() !== '')
        body.accuracy_threshold_m = Number(editing.accuracy_threshold_m);
      if (editing.grace_seconds.trim() !== '') body.grace_seconds = Number(editing.grace_seconds);
      if (!isNew) body.id = editing.id;
      const r = await api('/api/hr/geofences', { method: isNew ? 'POST' : 'PUT', body });
      if (!r.ok) {
        const j = await r.json().catch(() => null);
        setModalError(friendly(r.status, j?.error, 'Could not save the geofence. Try again.'));
        return;
      }
      setEditing(null);
      load();
    } catch {
      setModalError('Could not save the geofence. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  };

  const setActive = async (g: HrGeofence, next: boolean) => {
    if (!next) {
      const ok = confirm(
        `Deactivate "${g.name}"?\n\nGPS check-ins stop evaluating against it. Past attendance events keep their reference — the row is never deleted. You can reactivate it any time.`,
      );
      if (!ok) return;
    }
    setTogglingId(g.id);
    setActionError(null);
    try {
      const r = await api('/api/hr/geofences', {
        method: 'PUT',
        body: { id: g.id, is_active: next ? 1 : 0 },
      });
      if (!r.ok) {
        const j = await r.json().catch(() => null);
        setActionError(friendly(r.status, j?.error, 'Could not update the geofence.'));
      }
      load();
    } catch {
      setActionError('Could not update the geofence. Check your connection and try again.');
    } finally {
      setTogglingId(null);
    }
  };

  /** Fill lat/lng from the browser's geolocation — graceful when denied. */
  const useMyLocation = () => {
    setModalError(null);
    setModalNote(null);
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setModalNote('This browser does not offer location access — enter coordinates manually.');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const acc = Math.ceil(pos.coords.accuracy || 0);
        setEditing((prev) =>
          prev
            ? {
                ...prev,
                lat: pos.coords.latitude.toFixed(6),
                lng: pos.coords.longitude.toFixed(6),
                // Seed the threshold from the fix only when the field is blank —
                // never overwrite a value the admin already set.
                accuracy_threshold_m:
                  prev.accuracy_threshold_m.trim() === '' && acc > 0
                    ? String(acc)
                    : prev.accuracy_threshold_m,
              }
            : prev,
        );
        setModalNote(
          acc > 0
            ? `Filled from your device (fix accuracy ±${acc} m). Fine-tune before saving if you are not standing at the gate.`
            : 'Filled from your device. Fine-tune before saving if you are not standing at the gate.',
        );
      },
      (err) => {
        setLocating(false);
        setModalNote(
          err && err.code === err.PERMISSION_DENIED
            ? 'Location permission was denied — enter the coordinates manually (map apps show them on long-press).'
            : 'Could not get a location fix — enter the coordinates manually.',
        );
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  };

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-2">
              <Radar className="w-6 h-6" /> Geofences
            </h1>
            <p className="text-[#8B7355] text-sm mt-1">
              Location fences GPS check-ins evaluate against — one or more per outlet. Admin-only.
            </p>
          </div>
          <button
            onClick={() => openModal(emptyForm())}
            className="inline-flex items-center gap-2 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium"
          >
            <Plus className="w-4 h-4" /> New Geofence
          </button>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center justify-between gap-3">
            <span className="text-sm text-red-800 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> {error}
            </span>
            <button
              onClick={load}
              className="px-3 py-1.5 text-xs font-medium bg-white border border-red-200 text-red-700 rounded-lg hover:bg-red-50"
            >
              Retry
            </button>
          </div>
        )}

        {actionError && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-center justify-between gap-3">
            <span className="text-sm text-red-800 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> {actionError}
            </span>
            <button onClick={() => setActionError(null)} className="text-red-700 shrink-0" title="Dismiss">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Fences table */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
          <div className="px-5 py-4 border-b border-[#E8D5C4] flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold text-[#2D1B0E] flex items-center gap-2">
              <Radar className="w-5 h-5 text-[#af4408]" /> Fences
              <span className="text-xs font-normal text-[#8B7355]">
                radius, accuracy and grace are configuration — edit here, never in code
              </span>
            </h2>
            <label className="flex items-center gap-1.5 text-xs text-[#6B5744]">
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
              />
              Show inactive
            </label>
          </div>

          {loading && !geofences ? (
            <div className="p-8 text-center text-sm text-[#8B7355]">
              <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading...
            </div>
          ) : !geofences ? (
            <div className="p-8 text-center text-sm text-[#8B7355]">Geofences could not be loaded.</div>
          ) : visible.length === 0 ? (
            <p className="p-8 text-center text-sm text-[#8B7355]">
              {geofences.length === 0
                ? 'No geofences yet — add the venue gate as the first one.'
                : 'No active geofences — tick "Show inactive" to see the rest.'}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                  <tr>
                    <th className="text-left py-2 px-3 font-medium">Name</th>
                    <th className="text-left py-2 px-3 font-medium">Outlet</th>
                    <th className="text-right py-2 px-3 font-medium">Lat</th>
                    <th className="text-right py-2 px-3 font-medium">Lng</th>
                    <th className="text-right py-2 px-3 font-medium">Radius m</th>
                    <th className="text-right py-2 px-3 font-medium">Accuracy threshold</th>
                    <th className="text-right py-2 px-3 font-medium">Grace</th>
                    <th className="text-left py-2 px-3 font-medium">Active</th>
                    <th className="text-right py-2 px-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((g) => (
                    <tr
                      key={g.id}
                      className={`border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3] ${!g.is_active ? 'opacity-50' : ''}`}
                    >
                      <td className="py-2 px-3 font-medium text-[#2D1B0E]">{g.name}</td>
                      <td className="py-2 px-3 text-xs text-[#6B5744]">
                        {g.outlet_id ? (
                          outletNameById.get(g.outlet_id) || (
                            <span className="text-[#8B7355]">Unknown outlet</span>
                          )
                        ) : (
                          <span className="text-[#8B7355]">Any outlet</span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-right text-xs font-mono">{g.lat}</td>
                      <td className="py-2 px-3 text-right text-xs font-mono">{g.lng}</td>
                      <td className="py-2 px-3 text-right text-xs font-mono">{g.radius_m}</td>
                      <td className="py-2 px-3 text-right text-xs font-mono">{g.accuracy_threshold_m} m</td>
                      <td className="py-2 px-3 text-right text-xs font-mono">{g.grace_seconds}s</td>
                      <td className="py-2 px-3">
                        <Toggle
                          size="sm"
                          checked={!!g.is_active}
                          disabled={togglingId === g.id}
                          onChange={(next) => setActive(g, next)}
                          label={g.is_active ? `Deactivate ${g.name}` : `Reactivate ${g.name}`}
                        />
                      </td>
                      <td className="py-2 px-3 text-right">
                        <button
                          onClick={() => openModal(toForm(g))}
                          className="p-1 text-[#6B5744] hover:text-[#af4408]"
                          title="Edit"
                        >
                          <Edit className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* How geofences are used */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-5">
          <h3 className="font-semibold text-[#2D1B0E] flex items-center gap-2 mb-2">
            <Info className="w-5 h-5 text-[#af4408]" /> How geofences are used
          </h3>
          <p className="text-sm text-[#6B5744]">
            Geofences gate GPS check-ins per outlet: a punch from inside the radius counts as on-site,
            one from outside is flagged, and a fix less accurate than the threshold is treated as
            unknown rather than trusted. Radius, accuracy threshold and grace period are data on this
            page — never code — so tightening or loosening a fence never needs a deploy. The GPS
            check-in screen itself (the employee CHECK IN button) arrives with employee self-service,
            which the owner has deferred (ruling §8.3); until then these fences simply wait, and
            biometric or manual punches are unaffected by them.
          </p>
        </div>

        {/* Add / edit modal */}
        {editing && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
            {/* House safe-modal shell: card capped to viewport, body scrolls
                internally, so header + Save/Cancel stay on screen on phones. */}
            <div
              style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
              className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-lg shadow-xl flex flex-col overflow-hidden"
            >
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <h2 className="font-bold text-[#2D1B0E]">
                  {editing.id ? 'Edit Geofence' : 'New Geofence'}
                </h2>
                <button onClick={() => setEditing(null)} className="text-[#8B7355]" title="Close">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-3">
                <div>
                  <label className="text-xs text-[#6B5744]">Name *</label>
                  <input
                    value={editing.name}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    placeholder="e.g. Main Gate"
                    className="w-full px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="text-xs text-[#6B5744]">Outlet</label>
                  {/* Portaled Combobox — a plain absolute dropdown would clip inside this modal. */}
                  <Combobox
                    options={outletOptions}
                    value={
                      editing.outlet_id
                        ? outletNameById.get(editing.outlet_id) || 'Unknown outlet'
                        : 'Any outlet'
                    }
                    onChange={(v, opt) => {
                      if (opt) setEditing({ ...editing, outlet_id: opt.value });
                    }}
                    placeholder="Pick an outlet..."
                  />
                  <p className="text-[10px] text-[#8B7355] mt-1">
                    Which outlet this fence belongs to. &quot;Any outlet&quot; applies it everywhere.
                  </p>
                </div>
                <div>
                  <button
                    onClick={useMyLocation}
                    disabled={locating}
                    className="inline-flex items-center gap-2 px-3 py-2 border border-[#af4408] text-[#af4408] hover:bg-[#FFF1E3] rounded-lg text-sm font-medium disabled:opacity-50"
                    title="Fill latitude and longitude from this device's GPS — stand at the spot you want to fence."
                  >
                    {locating ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <LocateFixed className="w-4 h-4" />
                    )}
                    {locating ? 'Locating…' : 'Use my current location'}
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <NumField
                    label="Latitude *"
                    v={editing.lat}
                    onChange={(x) => setEditing({ ...editing, lat: x })}
                    placeholder="-90 to 90, e.g. 17.448500"
                  />
                  <NumField
                    label="Longitude *"
                    v={editing.lng}
                    onChange={(x) => setEditing({ ...editing, lng: x })}
                    placeholder="-180 to 180, e.g. 78.391200"
                  />
                  <NumField
                    label="Radius (m) *"
                    v={editing.radius_m}
                    onChange={(x) => setEditing({ ...editing, radius_m: x })}
                    placeholder="> 0, e.g. 100"
                    hint="How far from the point still counts as on-site."
                  />
                  <NumField
                    label="Accuracy threshold (m)"
                    v={editing.accuracy_threshold_m}
                    onChange={(x) => setEditing({ ...editing, accuracy_threshold_m: x })}
                    placeholder="e.g. 50"
                    hint="GPS fixes less accurate than this evaluate as unknown, not trusted."
                  />
                  <NumField
                    label="Grace (seconds)"
                    v={editing.grace_seconds}
                    onChange={(x) => setEditing({ ...editing, grace_seconds: x })}
                    placeholder="e.g. 300"
                    hint="How long someone may read as outside before it is flagged."
                  />
                </div>
                {modalNote && (
                  <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg p-3 text-xs text-[#6B5744] flex items-center gap-2">
                    <Info className="w-4 h-4 shrink-0 text-[#af4408]" /> {modalNote}
                  </div>
                )}
                {modalError && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 shrink-0" /> {modalError}
                  </div>
                )}
              </div>
              <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
                <button onClick={() => setEditing(null)} className="px-3 py-2 text-sm text-[#6B5744]">
                  Cancel
                </button>
                <button
                  onClick={save}
                  disabled={saving}
                  className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50"
                >
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}{' '}
                  Save
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── page-local helpers ─────────────────────────────────────────────────── */

function NumField({
  label,
  v,
  onChange,
  placeholder,
  hint,
}: {
  label: string;
  v: string;
  onChange: (s: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <div>
      <label className="text-xs text-[#6B5744]">{label}</label>
      <input
        type="text"
        inputMode="decimal"
        value={v}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm font-mono"
      />
      {hint && <p className="text-[10px] text-[#8B7355] mt-1">{hint}</p>}
    </div>
  );
}
