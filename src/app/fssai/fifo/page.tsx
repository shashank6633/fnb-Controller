'use client';

/**
 * FIFO & EXPIRY MANAGEMENT — owner §3.
 *
 * ── THE THREE THINGS THIS SCREEN IS ─────────────────────────────────────────
 *   · USE FIRST — the kitchen's own batches, soonest date at the top. A read of
 *     stock that already exists; it writes nothing and it moves nothing.
 *   · REGISTER — one row per thing found near or past its date, and what was
 *     done about it. This is the module's own record and the thing an inspector
 *     reads.
 *   · SHELF LIFE — how long each item keeps. Administrators set it; everybody
 *     may read it, because the "use first" colour comes from it.
 *
 * ── THE SENTENCE THIS SCREEN SAYS OUT LOUD, TWICE ───────────────────────────
 * Recording a discard here does NOT change the stock figure. The material
 * movement flow is frozen (Central Store → requisition → Department Stock →
 * recipe consumption) and this module only observes it. Somebody who has just
 * written "20 kg discarded" will otherwise assume the inventory now agrees, and
 * two authorities on one quantity is how a stock figure becomes unexplainable.
 *
 * ── AND THE GAP IT REFUSES TO HIDE ──────────────────────────────────────────
 * Bought-in goods carry no batch number and no expiry date anywhere in this
 * system. The board therefore shows kitchen-made batches only, and it says so
 * with the live measured numbers rather than a comment — because the day the
 * owner fills the shelf-life table in, that sentence has to stop being true.
 *
 * Styling is the house skeleton as /fssai/corrective-actions and
 * /fssai/verification use it: the #FFF8F0 page, the #af4408 heading with an icon
 * tile, white cards bordered #E8D5C4, cards under md and a table from md up, a
 * per-page toast, a bg-black/40 overlay and a modal anchored to the BOTTOM of a
 * phone where the thumb already is. ⚠️ globals.css force-wraps any
 * `.flex.gap-2|3|4`, so rows that must keep an icon beside their text carry
 * `flex-nowrap`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, Boxes, CalendarClock, Check, Info, Loader2, Lock,
  PackageX, Pencil, Plus, RefreshCw, Search, ShieldCheck, Trash2, X,
} from 'lucide-react';
import { api, apiJson } from '@/lib/api';
import { fmtIST, fmtISTDate } from '@/lib/format-date';
import MaterialTypeahead, { type MaterialLite } from '@/components/MaterialTypeahead';
import ImageUpload, { ImageThumb } from '@/app/tasks/_components/ImageUpload';
import UserPicker from '@/app/tasks/_components/UserPicker';
import {
  FSSAI_EXPIRY_ACTIONS, FSSAI_EXPIRY_REASONS, FSSAI_STORAGE_CONDITIONS,
  fssaiExpiryStateMeta, fssaiRecordStatusMeta, fssaiToday,
} from '@/lib/fssai';

/* ------------------------------------------------------------------ *
 * What the routes send back
 * ------------------------------------------------------------------ */

interface BoardBatch {
  id: string;
  batch_number: string;
  barcode: string;
  item_name: string;
  category: string;
  production_date: string;
  expiry_date: string;
  remaining_quantity: number;
  unit: string;
  storage_location: string;
  kitchen_section: string;
  storage_condition: string;
  is_high_risk: boolean;
  near_days_used: number;
  expiry_state: string;
  expiry_state_label: string;
  time_left: string;
  days_to_expiry: number | null;
}

interface BoardResponse {
  view: 'board';
  today: string;
  near_days_default: number;
  batches: BoardBatch[];
  counts: { total: number; expired: number; near_expiry: number; in_date: number; no_date: number };
  purchased: {
    items_total: number;
    shelf_life_configured_here: number;
    shelf_life_on_item_master: number;
    note: string;
  };
  register_awaiting_decision: number;
  fifo_owner: { path: string; note: string };
  truncated: boolean;
}

interface Photo {
  id: string; kind: string; filename: string; mime: string;
  size_bytes: number; caption: string; image_dropped_at: string;
}

interface ExpiryItem {
  id: string;
  business_date: string;
  found_at: string;
  batch_label: string;
  material_id: string;
  material_name: string;
  lot_no: string;
  department_name: string;
  location_label: string;
  expiry_date: string;
  days_to_expiry: number | null;
  expiry_state_now: string;
  state: string;
  state_label: string;
  qty: number | null;
  uom: string;
  action_taken: string;
  action_label: string;
  discard_qty: number | null;
  discard_method: string;
  witnessed_by: string;
  ca_id: string;
  ca_number: string;
  ca_status: string;
  note: string;
  status: string;
  status_label: string;
  recorded_by: string;
  recorded_name: string;
  created_at: string;
  voided_at: string;
  voided_by: string;
  void_reason: string;
  photos?: Photo[];
}

interface RegisterResponse {
  view: 'register';
  today: string;
  items: ExpiryItem[];
  counts: { live: number; expired: number; near_expiry: number; awaiting_decision: number; void: number };
  can_record: boolean;
  is_management: boolean;
  me: string;
  truncated: boolean;
}

interface ShelfRow {
  id: string;
  material_id: string;
  material_name: string;
  material_name_now: string;
  material_exists: boolean;
  unit: string;
  category: string;
  storage_condition: string;
  storage_condition_label: string;
  shelf_life_days: number | null;
  opened_shelf_life_days: number | null;
  near_expiry_days: number | null;
  near_expiry_days_effective: number;
  storage_temp_min: number | null;
  storage_temp_max: number | null;
  temp_uom: string;
  label_rule: string;
  is_high_risk: boolean;
  notes: string;
  is_active: boolean;
}

interface ShelfResponse {
  rows: ShelfRow[];
  coverage: { items_total: number; configured: number; note: string };
  can_edit: boolean;
}

/** What a corrective action looks like when one is raised alongside a record. */
interface RaisedAction {
  id: string; ca_number: string; title: string; severity: string; due_date: string;
}

interface RecordResult {
  ok: boolean;
  item: ExpiryItem;
  corrective_action: RaisedAction | null;
  corrective_action_warning?: string;
  stock_unchanged: boolean;
}

/* ------------------------------------------------------------------ *
 * Chrome
 * ------------------------------------------------------------------ */

const INPUT =
  'w-full bg-white border border-[#D4B896] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]';

const TABS = [
  { key: 'board', label: 'Use first' },
  { key: 'register', label: 'Expiry register' },
  { key: 'shelf', label: 'Shelf life' },
] as const;

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-6xl mx-auto px-3 sm:px-4 py-4 sm:py-6 space-y-3 sm:space-y-4">
        <div className="flex flex-nowrap items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#af4408] text-white flex items-center justify-center shrink-0">
            <CalendarClock size={20} />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-bold text-[#af4408] leading-tight">FIFO &amp; Expiry Management</h1>
            <p className="text-xs sm:text-sm text-[#6B5744]">
              Oldest stock first, and anything past its date on the record
            </p>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

function StateChip({ state }: { state: string }) {
  const meta = fssaiExpiryStateMeta(state);
  return <span className={`text-[11px] px-1.5 py-0.5 rounded border ${meta.color}`}>{meta.label}</span>;
}

/** A number that may genuinely be "not recorded". NEVER prints 0 for a null. */
function Qty({ v, uom }: { v: number | null; uom?: string }) {
  if (v === null || v === undefined) return <span className="text-[#8B7355]">not recorded</span>;
  return <>{v}{uom ? ` ${uom}` : ''}</>;
}

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

export default function FssaiFifoPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('board');
  const [toast, setToast] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const onAuthError = useCallback((message: string) => {
    if (/sign in|401/i.test(message)) { setSignedOut(true); return true; }
    return false;
  }, []);

  if (signedOut) {
    return (
      <Shell>
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 text-center">
          <Lock className="w-6 h-6 mx-auto mb-2 text-[#8B7355]" />
          <p className="text-sm text-[#3D2614]">Please sign in to see the expiry records.</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      {/* ── the law of this screen, said once, at the top ─────────────────── */}
      <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-xl p-3 sm:p-4">
        <div className="flex flex-nowrap items-start gap-2.5">
          <Info size={16} className="text-[#af4408] shrink-0 mt-0.5" />
          <p className="text-[13px] text-[#3D2614] leading-relaxed">
            <strong>This is the food-safety record, not the stock figure.</strong> Writing down a
            discard here does not change what the inventory says you have — adjust that in the
            inventory screens as you normally would. Two places changing one quantity is how a stock
            number stops making sense.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`text-sm px-3 py-2 rounded-lg border font-medium min-h-[44px] ${
              tab === t.key
                ? 'bg-[#af4408] border-[#af4408] text-white'
                : 'bg-white border-[#E8D5C4] text-[#6B5744] hover:border-[#af4408]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'board' && <BoardTab onAuthError={onAuthError} onGoRegister={() => setTab('register')} />}
      {tab === 'register' && <RegisterTab onAuthError={onAuthError} onToast={setToast} />}
      {tab === 'shelf' && <ShelfTab onAuthError={onAuthError} onToast={setToast} />}

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] bg-[#2D1B0E] text-white text-sm px-4 py-2.5 rounded-xl shadow-lg max-w-[90vw]">
          {toast}
        </div>
      )}
    </Shell>
  );
}

/* ------------------------------------------------------------------ *
 * USE FIRST — the board
 * ------------------------------------------------------------------ */

function BoardTab({
  onAuthError, onGoRegister,
}: { onAuthError: (m: string) => boolean; onGoRegister: () => void }) {
  const [data, setData] = useState<BoardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [near, setNear] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const p = new URLSearchParams({ view: 'board' });
      if (near) p.set('near_days', near);
      setData(await apiJson<BoardResponse>(`/api/fssai/fifo?${p}`));
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Could not load the board';
      if (!onAuthError(m)) setErr(m);
    } finally { setLoading(false); }
  }, [near, onAuthError]);

  useEffect(() => { void load(); }, [load]);

  if (loading && !data) {
    return (
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center">
        <Loader2 className="w-6 h-6 mx-auto animate-spin text-[#af4408]" />
      </div>
    );
  }

  return (
    <>
      {err && <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-800">{err}</div>}

      {data && (
        <>
          {/* ── counts ────────────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {[
              { label: 'Past its date', n: data.counts.expired, tone: 'bg-red-50 border-red-200 text-red-800' },
              { label: 'Use first', n: data.counts.near_expiry, tone: 'bg-amber-50 border-amber-200 text-amber-900' },
              { label: 'In date', n: data.counts.in_date, tone: 'bg-green-50 border-green-200 text-green-800' },
              { label: 'No date on it', n: data.counts.no_date, tone: 'bg-gray-50 border-gray-200 text-gray-700' },
            ].map((c) => (
              <div key={c.label} className={`border rounded-xl p-3 ${c.tone}`}>
                <p className="text-2xl font-bold leading-none">{c.n}</p>
                <p className="text-xs mt-1">{c.label}</p>
              </div>
            ))}
          </div>

          {/* ── the measured gap, with live numbers ───────────────────────── */}
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 sm:p-4">
            <div className="flex flex-nowrap items-start gap-2.5">
              <Boxes size={16} className="text-[#8B7355] shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-[13px] text-[#3D2614] leading-relaxed">
                  This list is <strong>what the kitchen produced itself</strong> — every batch
                  Kitchen Production labels carries a production date and an expiry, and they are
                  ordered here with the soonest date at the top.
                </p>
                <p className="text-xs text-[#6B5744] mt-1.5">{data.purchased.note}</p>
                <p className="text-xs text-[#6B5744] mt-1.5">
                  Shelf life is set for{' '}
                  <strong className="text-[#2D1B0E]">
                    {data.purchased.shelf_life_configured_here} of {data.purchased.items_total}
                  </strong>{' '}
                  bought-in items. {data.purchased.shelf_life_configured_here === 0
                    ? 'Until some are set, nothing bought in can be ranked by date.'
                    : 'Those items can be judged against their own use-first window.'}
                </p>
                <p className="text-xs text-[#6B5744] mt-1.5">{data.fifo_owner.note}</p>
              </div>
            </div>
          </div>

          {data.register_awaiting_decision > 0 && (
            <button
              onClick={onGoRegister}
              className="w-full text-left bg-amber-50 border border-amber-200 rounded-xl p-3 hover:border-amber-400"
            >
              <div className="flex flex-nowrap items-start gap-2.5">
                <AlertTriangle size={16} className="text-amber-800 shrink-0 mt-0.5" />
                <p className="text-[13px] text-amber-900">
                  <strong>
                    {data.register_awaiting_decision} entr{data.register_awaiting_decision === 1 ? 'y' : 'ies'} on the
                    register {data.register_awaiting_decision === 1 ? 'does' : 'do'} not yet say what was done about
                    {data.register_awaiting_decision === 1 ? ' it' : ' them'}.
                  </strong>{' '}
                  Tap to open the register.
                </p>
              </div>
            </button>
          )}

          {/* ── the use-first window ──────────────────────────────────────── */}
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 flex flex-wrap items-end gap-2">
            <div className="min-w-[14rem]">
              <label className="block text-xs text-[#6B5744] mb-1">
                Warn me this many days ahead
              </label>
              <input
                value={near}
                onChange={(e) => setNear(e.target.value.replace(/\D/g, '').slice(0, 3))}
                inputMode="numeric"
                placeholder={`${data.near_days_default} (the default)`}
                className={INPUT}
              />
            </div>
            <p className="text-xs text-[#6B5744] flex-1 min-w-[14rem]">
              An item with its own window set on the Shelf life tab uses that instead of this one.
            </p>
            <button
              onClick={() => void load()}
              aria-label="Reload"
              className="w-11 h-11 rounded-lg border border-[#E8D5C4] bg-white hover:border-[#af4408] flex items-center justify-center"
            >
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>

          {data.batches.length === 0 ? (
            <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 text-center">
              <ShieldCheck className="w-6 h-6 mx-auto mb-2 text-[#8B7355]" />
              <p className="text-sm text-[#3D2614]">No kitchen batches are open right now.</p>
              <p className="text-xs text-[#6B5744] mt-1">
                A batch appears here while it still has quantity left. An empty list means nothing is
                in stock from Kitchen Production — not that nothing was checked.
              </p>
            </div>
          ) : (
            <>
              {/* cards under md */}
              <div className="md:hidden space-y-2">
                {data.batches.map((b) => (
                  <div key={b.id} className="bg-white border border-[#E8D5C4] rounded-xl p-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <StateChip state={b.expiry_state} />
                      {b.is_high_risk && (
                        <span className="text-[11px] px-1.5 py-0.5 rounded border bg-red-50 text-red-700 border-red-200">
                          High risk
                        </span>
                      )}
                      <span className="font-mono text-[11px] text-[#6B5744]">{b.barcode || b.batch_number}</span>
                    </div>
                    <p className="text-sm font-semibold mt-1.5">{b.item_name}</p>
                    <p className="text-xs text-[#6B5744] mt-0.5">
                      {b.remaining_quantity} {b.unit} left · {b.storage_location || 'no location recorded'}
                    </p>
                    <p className="text-xs mt-1">
                      {b.expiry_date
                        ? <>Expires {fmtISTDate(b.expiry_date)} — <strong>{b.time_left}</strong></>
                        : <span className="text-[#8B7355]">No expiry date on this batch.</span>}
                    </p>
                  </div>
                ))}
              </div>

              {/* table from md up */}
              <div className="hidden md:block bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-[#FFF1E3] text-[#6B5744]">
                    <tr>
                      <th className="text-left font-semibold px-4 py-2">State</th>
                      <th className="text-left font-semibold px-4 py-2">Item</th>
                      <th className="text-left font-semibold px-4 py-2">Batch</th>
                      <th className="text-left font-semibold px-4 py-2">Left</th>
                      <th className="text-left font-semibold px-4 py-2">Where</th>
                      <th className="text-left font-semibold px-4 py-2">Expires</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E8D5C4]">
                    {data.batches.map((b) => (
                      <tr key={b.id} className="hover:bg-[#FFF8F0]">
                        <td className="px-4 py-2 align-top">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <StateChip state={b.expiry_state} />
                            {b.is_high_risk && (
                              <span className="text-[11px] px-1.5 py-0.5 rounded border bg-red-50 text-red-700 border-red-200">
                                High risk
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-2 align-top">
                          <span className="text-[#2D1B0E]">{b.item_name}</span>
                          {b.category && <span className="block text-xs text-[#8B7355]">{b.category}</span>}
                        </td>
                        <td className="px-4 py-2 align-top font-mono text-xs text-[#6B5744]">
                          {b.barcode || b.batch_number || '—'}
                        </td>
                        <td className="px-4 py-2 align-top text-xs">{b.remaining_quantity} {b.unit}</td>
                        <td className="px-4 py-2 align-top text-xs text-[#6B5744]">
                          {b.storage_location || <span className="text-[#8B7355]">not recorded</span>}
                        </td>
                        <td className="px-4 py-2 align-top text-xs">
                          {b.expiry_date ? (
                            <>
                              {fmtISTDate(b.expiry_date)}
                              <span className={`block ${b.expiry_state === 'expired' ? 'text-red-700 font-semibold' : 'text-[#6B5744]'}`}>
                                {b.time_left}
                              </span>
                            </>
                          ) : <span className="text-[#8B7355]">no date</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {data.truncated && (
            <p className="text-xs text-[#8B7355]">
              Only the first batches are shown. Narrow the list in Kitchen Production for the full picture.
            </p>
          )}
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * THE REGISTER
 * ------------------------------------------------------------------ */

function RegisterTab({
  onAuthError, onToast,
}: { onAuthError: (m: string) => boolean; onToast: (m: string) => void }) {
  const [data, setData] = useState<RegisterResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState('live');
  const [state, setState] = useState('');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [openItem, setOpenItem] = useState<ExpiryItem | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const p = new URLSearchParams({ view: 'register', status });
      if (state) p.set('state', state);
      if (q.trim()) p.set('q', q.trim());
      if (from) p.set('from', from);
      if (to) p.set('to', to);
      setData(await apiJson<RegisterResponse>(`/api/fssai/fifo?${p}`));
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Could not load the register';
      if (!onAuthError(m)) setErr(m);
    } finally { setLoading(false); }
  }, [status, state, q, from, to, onAuthError]);

  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {[
          { key: 'live', label: 'On the register', n: data?.counts.live },
          { key: 'awaiting', label: 'Nothing decided yet', n: data?.counts.awaiting_decision },
          { key: 'void', label: 'Voided', n: data?.counts.void },
          { key: 'all', label: 'All' },
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => setStatus(t.key)}
            className={`text-sm px-3 py-2 rounded-lg border font-medium min-h-[44px] ${
              status === t.key
                ? 'bg-[#af4408] border-[#af4408] text-white'
                : 'bg-white border-[#E8D5C4] text-[#6B5744] hover:border-[#af4408]'
            }`}
          >
            {t.label}
            {typeof t.n === 'number' && (
              <span className={`ml-1.5 text-xs ${status === t.key ? 'text-white/80' : 'text-[#8B7355]'}`}>{t.n}</span>
            )}
          </button>
        ))}
        {data?.can_record && (
          <button
            onClick={() => setShowNew(true)}
            className="ml-auto min-h-[44px] px-3 rounded-lg bg-[#af4408] text-white text-sm font-medium flex flex-nowrap items-center gap-1.5"
          >
            <Plus size={16} /> Record a finding
          </button>
        )}
      </div>

      <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 grid grid-cols-1 sm:grid-cols-5 gap-2">
        <div className="sm:col-span-2 relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8B7355]" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Item, batch, lot, shelf, who found it"
            className={`${INPUT} pl-9`}
          />
        </div>
        <select value={state} onChange={(e) => setState(e.target.value)} className={INPUT}>
          <option value="">Any reason</option>
          {FSSAI_EXPIRY_REASONS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={INPUT} aria-label="From" />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={INPUT} aria-label="To" />
      </div>

      {err && <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-800">{err}</div>}

      {loading && !data ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center">
          <Loader2 className="w-6 h-6 mx-auto animate-spin text-[#af4408]" />
        </div>
      ) : (data?.items.length ?? 0) === 0 ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 text-center">
          <PackageX className="w-6 h-6 mx-auto mb-2 text-[#8B7355]" />
          <p className="text-sm text-[#3D2614]">
            {q || state || from || to
              ? 'Nothing here matches what you asked for.'
              : 'Nothing has been put on the expiry register yet.'}
          </p>
          <p className="text-xs text-[#6B5744] mt-1">
            {/* An empty compliance list has two very different meanings and the
              * reader is entitled to know which one this is. */}
            An empty register means nothing has been recorded — not that nothing was found. The
            register is only as good as the shelf walk behind it.
          </p>
        </div>
      ) : (
        <>
          <div className="md:hidden space-y-2">
            {data!.items.map((it) => (
              <button
                key={it.id}
                onClick={() => setOpenItem(it)}
                className="w-full text-left bg-white border border-[#E8D5C4] rounded-xl p-3 hover:border-[#af4408]"
              >
                <ItemPills it={it} />
                <p className="text-sm font-semibold mt-1.5">{it.material_name || it.batch_label || 'Unnamed item'}</p>
                <p className="text-xs text-[#6B5744] mt-0.5">
                  {fmtISTDate(it.business_date)}
                  {it.location_label ? ` · ${it.location_label}` : ''}
                  {it.qty !== null ? ` · ${it.qty} ${it.uom}` : ''}
                </p>
                <p className="text-xs mt-1">
                  {it.action_taken
                    ? <span className="text-[#3D2614]">{it.action_label}</span>
                    : <span className="text-amber-800">Nothing decided yet</span>}
                </p>
              </button>
            ))}
          </div>

          <div className="hidden md:block bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-[#FFF1E3] text-[#6B5744]">
                <tr>
                  <th className="text-left font-semibold px-4 py-2">Found</th>
                  <th className="text-left font-semibold px-4 py-2">Item</th>
                  <th className="text-left font-semibold px-4 py-2">Why</th>
                  <th className="text-left font-semibold px-4 py-2">How much</th>
                  <th className="text-left font-semibold px-4 py-2">What was done</th>
                  <th className="text-left font-semibold px-4 py-2">Who found it</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E8D5C4]">
                {data!.items.map((it) => (
                  <tr key={it.id} onClick={() => setOpenItem(it)} className="cursor-pointer hover:bg-[#FFF8F0]">
                    <td className="px-4 py-2 align-top text-xs">
                      {fmtISTDate(it.business_date)}
                      {it.found_at && <span className="block text-[#8B7355]">{it.found_at}</span>}
                    </td>
                    <td className="px-4 py-2 align-top max-w-[18rem]">
                      <span className="text-[#2D1B0E]">{it.material_name || it.batch_label || 'Unnamed item'}</span>
                      {it.batch_label && <span className="block font-mono text-xs text-[#8B7355]">{it.batch_label}</span>}
                      {it.expiry_date && (
                        <span className="block text-xs text-[#8B7355]">dated {fmtISTDate(it.expiry_date)}</span>
                      )}
                    </td>
                    <td className="px-4 py-2 align-top"><ItemPills it={it} /></td>
                    <td className="px-4 py-2 align-top text-xs"><Qty v={it.qty} uom={it.uom} /></td>
                    <td className="px-4 py-2 align-top text-xs">
                      {it.action_taken
                        ? <span className="text-[#3D2614]">{it.action_label}</span>
                        : <span className="text-amber-800">nothing decided yet</span>}
                      {it.discard_qty !== null && (
                        <span className="block text-[#8B7355]">{it.discard_qty} {it.uom} discarded</span>
                      )}
                    </td>
                    <td className="px-4 py-2 align-top text-xs text-[#6B5744]">
                      {it.recorded_name || it.recorded_by || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {data?.truncated && (
        <p className="text-xs text-[#8B7355]">
          Only the most recent entries are shown. Narrow the dates to see further back.
        </p>
      )}

      {showNew && (
        <NewFindingModal
          onClose={() => setShowNew(false)}
          onSaved={(msg) => { setShowNew(false); onToast(msg); void load(); }}
        />
      )}

      {openItem && (
        <ItemModal
          item={openItem}
          isManagement={!!data?.is_management}
          me={data?.me || ''}
          onClose={() => setOpenItem(null)}
          onChanged={(msg) => { setOpenItem(null); onToast(msg); void load(); }}
        />
      )}
    </>
  );
}

function ItemPills({ it }: { it: ExpiryItem }) {
  const st = fssaiRecordStatusMeta(it.status);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] px-1.5 py-0.5 rounded border bg-[#FFF1E3] text-[#6B5744] border-[#E8D5C4]">
        {it.state_label}
      </span>
      {it.status !== 'submitted' && (
        <span className={`text-[11px] px-1.5 py-0.5 rounded border ${st.color}`}>{st.label}</span>
      )}
      {it.ca_number && (
        <span className="text-[11px] px-1.5 py-0.5 rounded border bg-amber-50 text-amber-900 border-amber-200">
          {it.ca_number}
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * RECORD A FINDING
 * ------------------------------------------------------------------ */

function NewFindingModal({ onClose, onSaved }: { onClose: () => void; onSaved: (m: string) => void }) {
  const [materials, setMaterials] = useState<MaterialLite[]>([]);
  const [materialId, setMaterialId] = useState('');
  const [typedName, setTypedName] = useState('');
  const [businessDate, setBusinessDate] = useState(fssaiToday());
  const [foundAt, setFoundAt] = useState('');
  const [state, setState] = useState('');
  const [expiry, setExpiry] = useState('');
  const [lotNo, setLotNo] = useState('');
  const [location, setLocation] = useState('');
  const [qty, setQty] = useState('');
  const [uom, setUom] = useState('');
  const [actionTaken, setActionTaken] = useState('');
  const [discardQty, setDiscardQty] = useState('');
  const [discardMethod, setDiscardMethod] = useState('');
  const [witness, setWitness] = useState('');
  const [note, setNote] = useState('');
  const [raiseCa, setRaiseCa] = useState(false);
  const [photos, setPhotos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    /* The Item Master is the master — read it, never copy it. This is the same
     * endpoint every other material picker in the app uses. */
    fetch('/api/inventory')
      .then((r) => r.json())
      .then((j) => setMaterials(Array.isArray(j?.materials) ? j.materials : []))
      .catch(() => setMaterials([]));
  }, []);

  const picked = useMemo(() => materials.find((m) => m.id === materialId) || null, [materials, materialId]);
  useEffect(() => {
    if (picked && !uom) setUom(String(picked.purchase_unit || picked.unit || ''));
  }, [picked, uom]);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const j = await apiJson<RecordResult>('/api/fssai/fifo', {
        method: 'POST',
        body: {
          action: 'record',
          business_date: businessDate,
          found_at: foundAt,
          state,
          material_id: materialId,
          material_name: materialId ? '' : typedName,
          lot_no: lotNo,
          location_label: location,
          expiry_date: expiry,
          qty,
          uom,
          action_taken: actionTaken,
          discard_qty: discardQty,
          discard_method: discardMethod,
          witnessed_by: witness,
          note,
          raise_corrective_action: raiseCa ? 1 : 0,
          photos: photos.map((p) => ({ data_uri: p, kind: 'photo' })),
        },
      });
      onSaved(
        j?.corrective_action
          ? `Recorded. Corrective action ${j.corrective_action.ca_number} raised.`
          : 'Recorded on the expiry register. The stock figure is unchanged.',
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save the finding');
    } finally { setBusy(false); }
  };

  const discarding = actionTaken === 'discarded';

  return (
    <ModalFrame title="Record a finding" onClose={onClose}>
      <div className="space-y-3">
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 space-y-2">
          <Field label="Which item">
            <MaterialTypeahead
              materials={materials}
              value={materialId}
              onPick={(id) => setMaterialId(id)}
              placeholder="Type the item name, SKU or category…"
              compact={false}
              purchaseBasis
            />
            {!materialId && (
              <input
                value={typedName}
                onChange={(e) => setTypedName(e.target.value)}
                placeholder="…or type what it was, if it is not in the Item Master"
                className={`${INPUT} mt-2`}
              />
            )}
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <Field label="Date found">
              <input type="date" value={businessDate} onChange={(e) => setBusinessDate(e.target.value)} className={INPUT} />
            </Field>
            <Field label="Time (optional)">
              <input
                value={foundAt}
                onChange={(e) => setFoundAt(e.target.value)}
                placeholder="HH:MM"
                inputMode="numeric"
                className={INPUT}
              />
            </Field>
          </div>

          <Field label="Why it is on the register">
            <div className="grid grid-cols-2 gap-1.5">
              {FSSAI_EXPIRY_REASONS.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => setState(r.key)}
                  className={`min-h-[44px] text-sm px-2 rounded-lg border font-medium ${
                    state === r.key
                      ? 'bg-[#af4408] border-[#af4408] text-white'
                      : 'bg-white border-[#E8D5C4] text-[#6B5744]'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <Field label="Date on the pack">
              <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} className={INPUT} />
            </Field>
            <Field label="Lot or batch number">
              <input value={lotNo} onChange={(e) => setLotNo(e.target.value)} className={INPUT} />
            </Field>
          </div>

          <Field label="Where it was found">
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Cold Room 2, dry store rack 3, …"
              className={INPUT}
            />
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <Field label="How much">
              <input
                value={qty}
                onChange={(e) => setQty(e.target.value.replace(/[^\d.]/g, ''))}
                inputMode="decimal"
                placeholder="leave blank if not measured"
                className={INPUT}
              />
            </Field>
            <Field label="In what unit">
              <input value={uom} onChange={(e) => setUom(e.target.value)} placeholder="kg, L, pcs…" className={INPUT} />
            </Field>
          </div>
        </div>

        <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 space-y-2">
          <Field label="What was done about it">
            <select value={actionTaken} onChange={(e) => setActionTaken(e.target.value)} className={INPUT}>
              {FSSAI_EXPIRY_ACTIONS.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
            </select>
          </Field>

          {discarding && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <Field label="How much was discarded">
                  <input
                    value={discardQty}
                    onChange={(e) => setDiscardQty(e.target.value.replace(/[^\d.]/g, ''))}
                    inputMode="decimal"
                    className={INPUT}
                  />
                </Field>
                <Field label="How it left the building">
                  <input
                    value={discardMethod}
                    onChange={(e) => setDiscardMethod(e.target.value)}
                    placeholder="wet waste, collector, …"
                    className={INPUT}
                  />
                </Field>
              </div>
              <Field label="Who witnessed it">
                <UserPicker
                  value={witness}
                  onPick={(u) => setWitness(u.email)}
                  allowClear
                  onClear={() => setWitness('')}
                  placeholder="Search for a colleague…"
                />
                <p className="text-xs text-[#6B5744] mt-1">
                  A discard needs a witness, or a line below saying why there was nobody to witness
                  it. Either will do — an unrecorded discard is worse than one that explains itself.
                </p>
              </Field>
            </>
          )}

          <Field label="Note">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="Anything a reader would need to know"
              className={INPUT}
            />
          </Field>

          <Field label="Photographs">
            <ImageUpload multiple max={4} value={photos} onChange={setPhotos} label="Add a photo" />
          </Field>

          <label className="flex flex-nowrap items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={raiseCa}
              onChange={(e) => setRaiseCa(e.target.checked)}
              className="mt-1 w-4 h-4 shrink-0 accent-[#af4408]"
            />
            <span className="text-xs text-[#3D2614]">
              <strong>Raise a corrective action for this.</strong> Off by default — one out-of-date
              tub is a rotation slip, and a tracked action for every one of them would bury the ones
              that matter. Switch it on when something needs following up and checking.
            </span>
          </label>
        </div>

        {err && <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-800">{err}</div>}

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => void submit()}
            disabled={busy || !state || (!materialId && !typedName.trim())}
            className="flex-1 min-h-[48px] rounded-xl bg-[#af4408] text-white font-semibold disabled:opacity-50 flex flex-nowrap items-center justify-center gap-2"
          >
            {busy ? <Loader2 size={18} className="animate-spin" /> : <Check size={18} />}
            Record it
          </button>
          <button onClick={onClose} className="min-h-[48px] px-4 rounded-xl border border-[#E8D5C4] bg-white text-sm">
            Cancel
          </button>
        </div>
      </div>
    </ModalFrame>
  );
}

/* ------------------------------------------------------------------ *
 * ONE ENTRY
 * ------------------------------------------------------------------ */

function ItemModal({
  item, isManagement, me, onClose, onChanged,
}: {
  item: ExpiryItem;
  isManagement: boolean;
  me: string;
  onClose: () => void;
  onChanged: (m: string) => void;
}) {
  const [panel, setPanel] = useState<null | 'decide' | 'void'>(null);
  const [actionTaken, setActionTaken] = useState(item.action_taken);
  const [discardQty, setDiscardQty] = useState(item.discard_qty === null ? '' : String(item.discard_qty));
  const [discardMethod, setDiscardMethod] = useState(item.discard_method);
  const [witness, setWitness] = useState(item.witnessed_by);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const closed = item.status === 'void' || item.status === 'verified';

  const post = async (body: Record<string, unknown>, okMessage: string) => {
    setBusy(true); setErr(null);
    try {
      await apiJson('/api/fssai/fifo', { method: 'POST', body });
      onChanged(okMessage);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That did not save');
    } finally { setBusy(false); }
  };

  return (
    <ModalFrame title={item.material_name || item.batch_label || 'Expiry entry'} onClose={onClose}>
      <div className="space-y-3">
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
          <ItemPills it={item} />
          <p className="text-base font-semibold mt-1.5">{item.material_name || item.batch_label || 'Unnamed item'}</p>
          <p className="text-xs text-[#6B5744] mt-1">
            Found {fmtISTDate(item.business_date)}{item.found_at ? ` at ${item.found_at}` : ''}
            {item.location_label ? ` · ${item.location_label}` : ''}
            {item.department_name ? ` · ${item.department_name}` : ''}
          </p>
          <p className="text-xs text-[#6B5744] mt-0.5">
            Recorded by {item.recorded_name || item.recorded_by || 'unknown'} · {fmtIST(item.created_at)}
          </p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 mt-2 text-xs">
            <div><dt className="text-[#6B5744]">Date on the pack</dt>
              <dd>{item.expiry_date ? fmtISTDate(item.expiry_date) : <span className="text-[#8B7355]">none</span>}</dd></div>
            <div><dt className="text-[#6B5744]">Days left when found</dt>
              <dd><Qty v={item.days_to_expiry} /></dd></div>
            <div><dt className="text-[#6B5744]">Quantity</dt><dd><Qty v={item.qty} uom={item.uom} /></dd></div>
            <div><dt className="text-[#6B5744]">Lot or batch</dt>
              <dd>{item.lot_no || item.batch_label || <span className="text-[#8B7355]">none</span>}</dd></div>
          </dl>
          {/* FROZEN vs LIVE, labelled, because they are different facts and a
            * reader who confuses them misreads the whole register. */}
          {item.expiry_date && (
            <p className="text-xs text-[#6B5744] mt-2">
              “Days left when found” is frozen as it was on {fmtISTDate(item.business_date)}. Today
              this pack reads <strong>{fssaiExpiryStateMeta(item.expiry_state_now).label}</strong>.
            </p>
          )}
          {item.note && <p className="text-xs text-[#3D2614] mt-2 whitespace-pre-wrap">{item.note}</p>}
        </div>

        {(item.photos?.length ?? 0) > 0 && (
          <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
            <p className="text-xs font-semibold text-[#6B5744] mb-2">Photographs</p>
            <div className="flex flex-wrap gap-2">
              {item.photos!.map((p) => (
                <div key={p.id} className="text-center">
                  {p.image_dropped_at ? (
                    <div className="w-14 h-14 rounded-lg border border-[#E8D5C4] bg-[#FFF1E3] flex items-center justify-center">
                      <span className="text-[10px] text-[#8B7355] px-1">image aged out</span>
                    </div>
                  ) : (
                    <ImageThumb src={`/api/fssai/fifo/photo?id=${encodeURIComponent(p.id)}`} size={56} />
                  )}
                  {p.caption && <span className="block text-[10px] text-[#8B7355] max-w-[56px] truncate">{p.caption}</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
          <p className="text-xs font-semibold text-[#6B5744] mb-1">What was done</p>
          {item.action_taken ? (
            <>
              <p className="text-sm text-[#2D1B0E]">{item.action_label}</p>
              {item.discard_qty !== null && (
                <p className="text-xs text-[#6B5744] mt-0.5">
                  {item.discard_qty} {item.uom} discarded{item.discard_method ? ` · ${item.discard_method}` : ''}
                </p>
              )}
              {item.witnessed_by && <p className="text-xs text-[#6B5744] mt-0.5">Witnessed by {item.witnessed_by}</p>}
            </>
          ) : (
            <p className="text-sm text-amber-800">Nothing has been recorded yet.</p>
          )}
        </div>

        {item.void_reason && (
          <div className="bg-gray-50 border border-gray-200 rounded-xl p-3">
            <p className="text-xs font-semibold text-gray-700">Voided</p>
            <p className="text-sm text-gray-700 mt-0.5">{item.void_reason}</p>
            <p className="text-xs text-gray-500 mt-0.5">
              {item.voided_by} · {fmtIST(item.voided_at)}
            </p>
          </div>
        )}

        {err && <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-800">{err}</div>}

        {/* ── decide ───────────────────────────────────────────────────────── */}
        {panel === 'decide' && (
          <div className="bg-white border border-[#af4408] rounded-xl p-3 space-y-2">
            <Field label="What was done about it">
              <select value={actionTaken} onChange={(e) => setActionTaken(e.target.value)} className={INPUT}>
                {FSSAI_EXPIRY_ACTIONS.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
              </select>
            </Field>
            {actionTaken === 'discarded' && (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="How much">
                    <input value={discardQty} onChange={(e) => setDiscardQty(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" className={INPUT} />
                  </Field>
                  <Field label="How it left">
                    <input value={discardMethod} onChange={(e) => setDiscardMethod(e.target.value)} className={INPUT} />
                  </Field>
                </div>
                <Field label="Witnessed by">
                  <UserPicker
                    value={witness}
                    onPick={(u) => setWitness(u.email)}
                    allowClear
                    onClear={() => setWitness('')}
                    placeholder="Search for a colleague…"
                  />
                </Field>
              </>
            )}
            {item.action_taken && (
              <Field label="Why this is changing">
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={`It currently says “${item.action_label}”`}
                  className={INPUT}
                />
                <p className="text-xs text-[#6B5744] mt-1">
                  The file keeps both the old answer and the new one, with your reason between them.
                </p>
              </Field>
            )}
            <button
              onClick={() => void post(
                {
                  action: 'decide', id: item.id, action_taken: actionTaken,
                  discard_qty: discardQty, discard_method: discardMethod,
                  witnessed_by: witness, reason,
                },
                'Recorded what was done. The stock figure is unchanged.',
              )}
              disabled={busy || !actionTaken}
              className="w-full min-h-[48px] rounded-xl bg-[#af4408] text-white font-semibold disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}

        {/* ── void ─────────────────────────────────────────────────────────── */}
        {panel === 'void' && (
          <div className="bg-white border border-red-300 rounded-xl p-3 space-y-2">
            <p className="text-xs text-[#3D2614]">
              A voided entry stays in the file for ever with your reason on it. Nothing is deleted.
            </p>
            <Field label="Why is this being voided">
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Recorded against the wrong item, duplicate of another entry, …"
                className={INPUT}
              />
            </Field>
            <button
              onClick={() => void post({ action: 'void', id: item.id, reason }, 'Voided. The entry stays in the file.')}
              disabled={busy || reason.trim().length < 4}
              className="w-full min-h-[48px] rounded-xl bg-red-700 text-white font-semibold disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Void this entry'}
            </button>
          </div>
        )}

        {!panel && !closed && (
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setPanel('decide')}
              className="flex-1 min-h-[48px] px-3 rounded-xl bg-[#af4408] text-white font-semibold flex flex-nowrap items-center justify-center gap-2"
            >
              <Pencil size={16} /> {item.action_taken ? 'Change what was done' : 'Say what was done'}
            </button>
            {isManagement && (
              <button
                onClick={() => setPanel('void')}
                className="min-h-[48px] px-3 rounded-xl border border-red-300 bg-white text-red-700 text-sm font-medium flex flex-nowrap items-center gap-1.5"
              >
                <Trash2 size={15} /> Void
              </button>
            )}
          </div>
        )}

        {!isManagement && !closed && (
          <p className="text-xs text-[#6B5744]">
            {/* The refusal is shown rather than the button hidden: somebody who
              * cannot see why they are blocked assumes the screen is broken. */}
            Only a manager, head of department or administrator can void a compliance record — and
            not the person who recorded it.
          </p>
        )}
        {me && item.recorded_by.toLowerCase() === me.toLowerCase() && isManagement && !closed && (
          <p className="text-xs text-amber-800">
            You recorded this entry yourself. A void is meant to be somebody else&apos;s decision.
          </p>
        )}
      </div>
    </ModalFrame>
  );
}

/* ------------------------------------------------------------------ *
 * SHELF LIFE
 * ------------------------------------------------------------------ */

function ShelfTab({
  onAuthError, onToast,
}: { onAuthError: (m: string) => boolean; onToast: (m: string) => void }) {
  const [data, setData] = useState<ShelfResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<ShelfRow | 'new' | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const p = new URLSearchParams({ include_inactive: '1' });
      if (q.trim()) p.set('q', q.trim());
      setData(await apiJson<ShelfResponse>(`/api/fssai/fifo/shelf-life?${p}`));
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Could not load the shelf-life settings';
      if (!onAuthError(m)) setErr(m);
    } finally { setLoading(false); }
  }, [q, onAuthError]);

  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 sm:p-4">
        <div className="flex flex-nowrap items-start gap-2.5">
          <Info size={16} className="text-[#8B7355] shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-[13px] text-[#3D2614] leading-relaxed">
              How long each item keeps, and how many days ahead it should be flagged as{' '}
              <em>use first</em>. The Item Master is not changed by anything on this tab — this is a
              food-safety rule sitting alongside it.
            </p>
            {data && (
              <p className="text-xs text-[#6B5744] mt-1.5">
                Set for <strong className="text-[#2D1B0E]">{data.coverage.configured}</strong> of{' '}
                {data.coverage.items_total} items. {data.coverage.note}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 flex flex-wrap gap-2">
        <div className="relative flex-1 min-w-[14rem]">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8B7355]" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the items you have set" className={`${INPUT} pl-9`} />
        </div>
        {data?.can_edit && (
          <button
            onClick={() => setEditing('new')}
            className="min-h-[44px] px-3 rounded-lg bg-[#af4408] text-white text-sm font-medium flex flex-nowrap items-center gap-1.5"
          >
            <Plus size={16} /> Set an item
          </button>
        )}
      </div>

      {err && <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-800">{err}</div>}

      {loading && !data ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-8 text-center">
          <Loader2 className="w-6 h-6 mx-auto animate-spin text-[#af4408]" />
        </div>
      ) : (data?.rows.length ?? 0) === 0 ? (
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-6 text-center">
          <CalendarClock className="w-6 h-6 mx-auto mb-2 text-[#8B7355]" />
          <p className="text-sm text-[#3D2614]">No item has a shelf life set yet.</p>
          <p className="text-xs text-[#6B5744] mt-1">
            {data?.can_edit
              ? 'Start with the perishables — anything chilled, anything ready to eat. Those are the items a date matters on.'
              : 'An administrator sets these. Until some are set, nothing bought in can be ranked by date.'}
          </p>
        </div>
      ) : (
        <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-x-auto">
          <table className="w-full text-sm min-w-[42rem]">
            <thead className="bg-[#FFF1E3] text-[#6B5744]">
              <tr>
                <th className="text-left font-semibold px-4 py-2">Item</th>
                <th className="text-left font-semibold px-4 py-2">Kept</th>
                <th className="text-left font-semibold px-4 py-2">Keeps</th>
                <th className="text-left font-semibold px-4 py-2">Once opened</th>
                <th className="text-left font-semibold px-4 py-2">Use first from</th>
                <th className="text-left font-semibold px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E8D5C4]">
              {data!.rows.map((r) => (
                <tr key={r.id} className={`hover:bg-[#FFF8F0] ${r.is_active ? '' : 'opacity-60'}`}>
                  <td className="px-4 py-2 align-top">
                    <span className="text-[#2D1B0E]">{r.material_name_now || r.material_name}</span>
                    <span className="block text-xs text-[#8B7355]">
                      {r.category}
                      {r.is_high_risk ? ' · high risk' : ''}
                      {r.is_active ? '' : ' · retired'}
                    </span>
                    {!r.material_exists && (
                      <span className="block text-xs text-amber-800">
                        This item is no longer in the Item Master.
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 align-top text-xs">{r.storage_condition_label}</td>
                  <td className="px-4 py-2 align-top text-xs"><Qty v={r.shelf_life_days} uom="days" /></td>
                  <td className="px-4 py-2 align-top text-xs"><Qty v={r.opened_shelf_life_days} uom="days" /></td>
                  <td className="px-4 py-2 align-top text-xs">
                    {r.near_expiry_days_effective} days
                    {r.near_expiry_days === null && <span className="block text-[#8B7355]">the default</span>}
                  </td>
                  <td className="px-4 py-2 align-top text-right">
                    {data!.can_edit && (
                      <button
                        onClick={() => setEditing(r)}
                        className="w-10 h-10 rounded-lg border border-[#E8D5C4] bg-white hover:border-[#af4408] inline-flex items-center justify-center"
                        aria-label={`Edit ${r.material_name_now || r.material_name}`}
                      >
                        <Pencil size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <ShelfModal
          row={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(m) => { setEditing(null); onToast(m); void load(); }}
        />
      )}
    </>
  );
}

function ShelfModal({
  row, onClose, onSaved,
}: { row: ShelfRow | null; onClose: () => void; onSaved: (m: string) => void }) {
  const [materials, setMaterials] = useState<MaterialLite[]>([]);
  const [materialId, setMaterialId] = useState(row?.material_id || '');
  const [cond, setCond] = useState(row?.storage_condition || 'ambient');
  const [shelfDays, setShelfDays] = useState(row?.shelf_life_days === null || row === null ? '' : String(row.shelf_life_days));
  const [openedDays, setOpenedDays] = useState(row?.opened_shelf_life_days === null || row === null ? '' : String(row.opened_shelf_life_days));
  const [nearDays, setNearDays] = useState(row?.near_expiry_days === null || row === null ? '' : String(row.near_expiry_days));
  const [tMin, setTMin] = useState(row?.storage_temp_min === null || row === null ? '' : String(row.storage_temp_min));
  const [tMax, setTMax] = useState(row?.storage_temp_max === null || row === null ? '' : String(row.storage_temp_max));
  const [labelRule, setLabelRule] = useState(row?.label_rule || '');
  const [highRisk, setHighRisk] = useState(!!row?.is_high_risk);
  const [notes, setNotes] = useState(row?.notes || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (row) return;
    fetch('/api/inventory')
      .then((r) => r.json())
      .then((j) => setMaterials(Array.isArray(j?.materials) ? j.materials : []))
      .catch(() => setMaterials([]));
  }, [row]);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await apiJson('/api/fssai/fifo/shelf-life', {
        method: 'POST',
        body: {
          action: 'save',
          material_id: materialId,
          storage_condition: cond,
          shelf_life_days: shelfDays,
          opened_shelf_life_days: openedDays,
          near_expiry_days: nearDays,
          storage_temp_min: tMin,
          storage_temp_max: tMax,
          label_rule: labelRule,
          is_high_risk: highRisk ? 1 : 0,
          notes,
          is_active: row ? (row.is_active ? 1 : 0) : 1,
        },
      });
      onSaved('Saved. The Item Master is unchanged.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save');
    } finally { setBusy(false); }
  };

  const retire = async () => {
    if (!row) return;
    setBusy(true); setErr(null);
    try {
      await api('/api/fssai/fifo/shelf-life', {
        method: 'POST',
        body: { action: row.is_active ? 'retire' : 'restore', id: row.id },
      });
      onSaved(row.is_active ? 'Retired. The setting stays in the file.' : 'Back in use.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not change that');
    } finally { setBusy(false); }
  };

  return (
    <ModalFrame title={row ? (row.material_name_now || row.material_name) : 'Set an item'} onClose={onClose}>
      <div className="space-y-3">
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 space-y-2">
          {row ? (
            <p className="text-sm font-semibold">{row.material_name_now || row.material_name}</p>
          ) : (
            <Field label="Which item">
              <MaterialTypeahead
                materials={materials}
                value={materialId}
                onPick={setMaterialId}
                placeholder="Type the item name, SKU or category…"
                compact={false}
              />
            </Field>
          )}

          <Field label="How it is kept">
            <div className="grid grid-cols-2 gap-1.5">
              {FSSAI_STORAGE_CONDITIONS.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setCond(c.key)}
                  title={c.hint}
                  className={`min-h-[44px] text-sm px-2 rounded-lg border font-medium ${
                    cond === c.key ? 'bg-[#af4408] border-[#af4408] text-white' : 'bg-white border-[#E8D5C4] text-[#6B5744]'
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <Field label="Keeps (days, sealed)">
              <input value={shelfDays} onChange={(e) => setShelfDays(e.target.value.replace(/\D/g, '').slice(0, 4))} inputMode="numeric" placeholder="blank = not set" className={INPUT} />
            </Field>
            <Field label="Keeps (days, opened)">
              <input value={openedDays} onChange={(e) => setOpenedDays(e.target.value.replace(/\D/g, '').slice(0, 4))} inputMode="numeric" placeholder="blank = not set" className={INPUT} />
            </Field>
          </div>

          <Field label="Flag as “use first” this many days ahead">
            <input value={nearDays} onChange={(e) => setNearDays(e.target.value.replace(/\D/g, '').slice(0, 3))} inputMode="numeric" placeholder="blank = use the default" className={INPUT} />
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <Field label="Store no colder than (°C)">
              <input value={tMin} onChange={(e) => setTMin(e.target.value.replace(/[^\d.-]/g, ''))} inputMode="decimal" className={INPUT} />
            </Field>
            <Field label="Store no warmer than (°C)">
              <input value={tMax} onChange={(e) => setTMax(e.target.value.replace(/[^\d.-]/g, ''))} inputMode="decimal" className={INPUT} />
            </Field>
          </div>

          <Field label="What must be written on the label">
            <input value={labelRule} onChange={(e) => setLabelRule(e.target.value)} placeholder="Name, date opened, use-by, prepared by" className={INPUT} />
          </Field>

          <label className="flex flex-nowrap items-start gap-2.5 cursor-pointer">
            <input type="checkbox" checked={highRisk} onChange={(e) => setHighRisk(e.target.checked)} className="mt-1 w-4 h-4 shrink-0 accent-[#af4408]" />
            <span className="text-xs text-[#3D2614]">
              <strong>High risk</strong> — ready to eat, or anything that will not be cooked again
              before it is served. These sit at the top of the board.
            </span>
          </label>

          <Field label="Notes">
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={INPUT} />
          </Field>
        </div>

        {err && <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-800">{err}</div>}

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => void save()}
            disabled={busy || !materialId}
            className="flex-1 min-h-[48px] rounded-xl bg-[#af4408] text-white font-semibold disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
          {row && (
            <button
              onClick={() => void retire()}
              disabled={busy}
              className="min-h-[48px] px-4 rounded-xl border border-[#E8D5C4] bg-white text-sm"
            >
              {row.is_active ? 'Retire' : 'Put back in use'}
            </button>
          )}
        </div>
      </div>
    </ModalFrame>
  );
}

/* ------------------------------------------------------------------ *
 * Shared small pieces
 * ------------------------------------------------------------------ */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-[#6B5744] mb-1">{label}</label>
      {children}
    </div>
  );
}

/**
 * Anchored to the BOTTOM of a phone, where the thumb already is, and centred from
 * sm up — the same frame /fssai/corrective-actions and /fssai/verification use.
 */
function ModalFrame({
  title, onClose, children,
}: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div
        className="bg-[#FFF8F0] w-full sm:max-w-2xl sm:rounded-2xl rounded-t-2xl max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-[#FFF8F0] border-b border-[#E8D5C4] px-3 py-2.5 flex flex-nowrap items-center gap-2 z-10">
          <button
            onClick={onClose}
            aria-label="Back"
            className="sm:hidden w-10 h-10 rounded-lg border border-[#E8D5C4] bg-white flex items-center justify-center shrink-0"
          >
            <ArrowLeft size={16} />
          </button>
          <p className="font-semibold text-[#2D1B0E] truncate">{title}</p>
          <button
            onClick={onClose}
            aria-label="Close"
            className="ml-auto w-10 h-10 rounded-lg border border-[#E8D5C4] bg-white flex items-center justify-center shrink-0"
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-3 sm:p-4">{children}</div>
      </div>
    </div>
  );
}
