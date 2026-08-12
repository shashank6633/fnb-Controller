'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import {
  MapPin, LogOut, Users, AlertTriangle, CheckCircle2, Clock, RefreshCw, Building2, X,
} from 'lucide-react';

/**
 * THE FLOOR CHECK-IN — the owner's rule (a) on screen:
 *
 *   "When a Cashier Login they should have a dropdown or just after logging in
 *    it should ask for Floor Where the cashier is assigned to floor."
 *
 * Three surfaces in one component, because they are three views of one fact:
 *   1. THE ASK      — a prompt a cashier cannot miss when they hold no floor.
 *   2. THE STATUS    — which floor I hold, since when, and when it goes stale;
 *                      visible and changeable all shift, because cashiers move.
 *   3. THE BOARD     — requirement 3: every floor with its cashier, or the words
 *                      "No Cashier Logged In".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE ASK IS NOT IN THE LOGIN FLOW
 *
 * The owner said "just after logging in", but asking there would ask EVERYONE —
 * a storekeeper signing in to receive a delivery would be made to answer a
 * question about a cash counter they will never stand at. So the ask lives on
 * the Cashier console, which is reachable only by someone whose role grants
 * /cashier: the exact population rule (a) is about. For a cashier the console IS
 * the first thing they open, so it lands in the same moment the owner described.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT IS INSISTENT FOR A CASHIER AND QUIET FOR A MANAGER
 *
 * The consequences of skipping differ, so the prompt does too. Under the
 * OVERRIDE model (src/lib/settle-authority.ts): a STAFF cashier who holds no
 * floor gets no bill requests from captains and cannot settle any floor's
 * bills — a held floor refuses them outright, and an unmanned one answers
 * needs_check_in until they take it (takeaway/no-floor bills are the one
 * exception). Their floor reads as unmanned and a manager silently inherits
 * the till. So for a non-management user the ask opens as a modal over the
 * console. MANAGEMENT may always settle — an unmanned floor as a fallback, a
 * manned one as a recorded override — so for them it is a one-line bar:
 * opening a modal at a manager who does not need one is how prompts get
 * trained away.
 *
 * Everyone who can SEE this component may check in: the route behind it and
 * settle authority share the single tillCapable() predicate, so there is no
 * audience here for whom "pick your floor" is a dead end — the till-refused
 * (staff with no explicit /cashier grant) got this component's 403 and see
 * nothing.
 *
 * Nobody is trapped either way: the modal dismisses to a persistent amber bar
 * that keeps "Choose floor" one tap away.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE HEARTBEAT IS GATED ON REAL ACTIVITY
 *
 * A plain setInterval touch would defeat the staleness window entirely: a tab
 * left open on a locked PC would bump last_seen forever and hold that floor
 * until someone force-cleared it. So the poll only sends `touch` when the tab is
 * VISIBLE and the user has actually interacted within ACTIVE_WINDOW_MS. An
 * abandoned tab keeps polling (read-only GET, so the board and countdown stay
 * honest on screen) but stops extending the hold, and the floor frees itself.
 *
 * Server-truth only: this file holds no authorization logic. Everything it
 * shows comes from /api/dine-in/cashier-presence, which is gated on the same
 * tillCapable() predicate settle enforces, and `me.isManagement` on that wire
 * is the server's OWN tier test (isManagementTier — admin|manager, exported by
 * settle-authority), NOT auth.ts isManagement(): a staff-tier head chef is not
 * management for the till (D4/D10), and every promise this component renders
 * comes from that wire value so it cannot drift from what settle will do.
 */

/* Wire shapes — declared locally on purpose. This is a "use client" file and
 * these describe the JSON the route returns, not the server's internal types;
 * importing them from cashier-presence.ts would point a client bundle at a
 * module that talks to better-sqlite3. */
interface PresentCashier {
  userId: string;
  userName: string;
  floor: string;
  outletId: string;
  checkedInAt: string;
  lastSeen: string;
}
interface FloorRow {
  floor: string;
  label: string;
  activeTables: number;
  cashier: PresentCashier | null;
  expired: PresentCashier | null;
}
interface PresenceStatus {
  me: { id: string; name: string; isManagement: boolean };
  presence: PresentCashier | null;
  staleAt: string | null;
  staleInMinutes: number | null;
  timeoutMinutes: number;
  serverNow: string;
  floors: { floor: string; label: string }[];
  board: FloorRow[];
}

/** How often the console refreshes presence. */
const POLL_MS = 60_000;
/** Interaction older than this counts as "nobody is here" — no touch is sent. */
const ACTIVE_WINDOW_MS = 15 * 60_000;

/** SQLite UTC text → local clock time. */
function localTime(utc: string): string {
  if (!utc) return '';
  const d = new Date(utc.replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
/** 708 → "11h 48m". Minutes only under an hour. */
function humanMins(mins: number): string {
  const m = Math.max(0, Math.round(mins));
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

export interface CashierFloorPresenceProps {
  /** Session user from /api/auth/me. Nothing renders until it arrives. */
  me: { id?: string; name?: string } | null;
  /**
   * Increment to force the picker open — the settle path uses this so a refusal
   * carrying offerCheckIn becomes a floor prompt instead of a dead-end toast.
   */
  requestOpen?: number;
  /** Fired after any successful check-in / check-out / clear. */
  onChanged?: () => void;
}

export default function CashierFloorPresence({ me, requestOpen = 0, onChanged }: CashierFloorPresenceProps) {
  const [status, setStatus] = useState<PresenceStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [boardOpen, setBoardOpen] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; msg: string } | null>(null);

  const lastActivity = useRef<number>(Date.now());
  // Guards the one-time auto-open so a cashier who dismissed the modal is not
  // shown it again on every poll.
  const askedOnce = useRef(false);

  const flash = (ok: boolean, msg: string) => { setNote({ ok, msg }); setTimeout(() => setNote(null), 4000); };

  /** Read-only refresh. Never extends a hold — see the header note. */
  const load = useCallback(async () => {
    try {
      const r = await api('/api/dine-in/cashier-presence');
      if (r.status === 401 || r.status === 403) { setDenied(true); return; }
      const j = await r.json();
      if (r.ok) { setStatus(j); setDenied(false); }
    } catch { /* offline / transient — keep the last known state on screen */ }
    finally { setLoaded(true); }
  }, []);

  const send = useCallback(async (label: string, body: Record<string, unknown>, quiet = false) => {
    setBusy(label);
    try {
      const r = await api('/api/dine-in/cashier-presence', { method: 'POST', body });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { if (!quiet) flash(false, j.error || 'Could not update your floor.'); return false; }
      setStatus(j);
      if (!quiet && j.message) flash(true, j.message);
      if (!quiet) onChanged?.();
      return true;
    } catch (e: any) {
      if (!quiet) flash(false, e?.message || 'Could not update your floor.');
      return false;
    } finally { setBusy(''); }
  }, [onChanged]);

  useEffect(() => { if (me?.id) load(); }, [me?.id, load]);

  // Activity tracking for the heartbeat gate.
  useEffect(() => {
    const mark = () => { lastActivity.current = Date.now(); };
    const onVis = () => { if (document.visibilityState === 'visible') mark(); };
    window.addEventListener('pointerdown', mark, { passive: true });
    window.addEventListener('keydown', mark, { passive: true });
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('pointerdown', mark);
      window.removeEventListener('keydown', mark);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  // The poll. Touches ONLY when someone is demonstrably at the machine.
  useEffect(() => {
    if (!me?.id || denied) return;
    const t = setInterval(() => {
      const active =
        typeof document !== 'undefined' &&
        document.visibilityState === 'visible' &&
        Date.now() - lastActivity.current < ACTIVE_WINDOW_MS;
      // `quiet` — a heartbeat must never raise a toast or re-run parent loaders.
      if (active) send('beat', { action: 'touch' }, true);
      else load();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [me?.id, denied, send, load]);

  // THE ASK. Opens once, and only for someone who genuinely cannot work without
  // it — a manager settling an unmanned floor needs no check-in.
  useEffect(() => {
    if (!loaded || !status || askedOnce.current) return;
    if (!status.presence && !status.me.isManagement && status.floors.length > 0) {
      askedOnce.current = true;
      setPickerOpen(true);
    }
  }, [loaded, status]);

  // Externally forced open (a settle refused with offerCheckIn).
  useEffect(() => { if (requestOpen > 0) setPickerOpen(true); }, [requestOpen]);

  if (!me?.id || denied || !loaded || !status) return null;

  const p = status.presence;
  const floors = status.floors;
  const noFloors = floors.length === 0;

  const doCheckIn = async (floor: string) => {
    const ok = await send('in', { action: 'check_in', floor });
    if (ok) setPickerOpen(false);
  };
  const doCheckOut = async () => {
    const ok = await send('out', { action: 'check_out' });
    // Checking out is a deliberate end-of-shift act, so do NOT re-ask: the amber
    // bar is enough. Re-opening the modal here would make signing off a fight.
    if (ok) askedOnce.current = true;
  };
  const doClear = (floor: string) => send('clear', { action: 'force_clear', floor });

  return (
    <>
      {/* ── STATUS / WARNING BAR — always on screen, never collapses away ──── */}
      <div className={`rounded-xl border px-3 py-2.5 flex items-center gap-3 flex-wrap ${
        p ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-300'
      }`}>
        {p ? (
          <>
            <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-800">
              <CheckCircle2 className="w-4 h-4" /> Cashier on {p.floor === '' ? 'Floor' : p.floor}
            </span>
            <span className="text-xs text-emerald-700">
              since {localTime(p.checkedInAt)}
              {status.staleInMinutes != null && (
                <> · <Clock className="inline w-3 h-3" /> stays active for {humanMins(status.staleInMinutes)} unless you keep using this screen</>
              )}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <button onClick={() => setPickerOpen(true)} disabled={!!busy}
                className="text-xs font-medium border border-emerald-300 text-emerald-800 hover:bg-emerald-100 px-2.5 py-1.5 rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
                <MapPin className="w-3.5 h-3.5" /> Change floor
              </button>
              <button onClick={doCheckOut} disabled={!!busy}
                className="text-xs font-medium border border-emerald-300 text-emerald-800 hover:bg-emerald-100 px-2.5 py-1.5 rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
                <LogOut className="w-3.5 h-3.5" /> {busy === 'out' ? 'Checking out…' : 'Check out'}
              </button>
            </div>
          </>
        ) : (
          <>
            <span className="inline-flex items-center gap-1.5 font-semibold text-amber-900">
              <AlertTriangle className="w-4 h-4" /> You are not checked in to a floor
            </span>
            <span className="text-xs text-amber-800">
              {noFloors
                ? 'No floors are set up yet — add tables with a floor on the Tables page.'
                : status.me.isManagement
                  /* Management always settles: unmanned floors as a fallback,
                     manned ones as a recorded override — say both, promise
                     exactly what settle-authority will do. */
                  ? 'You can still settle any bill — settling a floor with its own cashier is recorded as a manager override. Check in to take a floor yourself.'
                  /* Staff: no floor bills at all until they hold a floor —
                     another cashier's floor refuses them even afterwards. */
                  /* "from captains' tables" is the honest scope: a NO-FLOOR
                     request (takeaway, or a deleted table) reaches every
                     till-capable user whether or not they hold a floor. */
                  : "Bill requests from captains' tables will not reach you, and you cannot settle bills on any floor, until you pick your floor."}
            </span>
            {!noFloors && (
              <button onClick={() => setPickerOpen(true)} disabled={!!busy}
                className="ml-auto text-xs font-semibold bg-amber-600 hover:bg-amber-700 text-white px-3 py-1.5 rounded-lg inline-flex items-center gap-1 disabled:opacity-50">
                <MapPin className="w-3.5 h-3.5" /> Choose floor
              </button>
            )}
          </>
        )}
      </div>

      {/* ── REQUIREMENT 3: THE FLOOR BOARD ─────────────────────────────────── */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        <button onClick={() => setBoardOpen(o => !o)}
          className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-[#FFF1E3]">
          <Building2 className="w-4 h-4 text-[#af4408]" />
          <span className="font-semibold text-[#2D1B0E] text-sm">Who is on each floor</span>
          <span className="text-xs text-[#8B7355]">
            {status.board.filter(f => f.cashier).length} of {status.board.length} floor
            {status.board.length === 1 ? '' : 's'} covered
          </span>
          {status.board.some(f => !f.cashier) && (
            <span className="text-[10px] uppercase font-bold text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">
              {status.board.filter(f => !f.cashier).length} uncovered
            </span>
          )}
          <span className="ml-auto text-xs text-[#8B7355]">{boardOpen ? 'Hide' : 'Show'}</span>
        </button>

        {boardOpen && (
          <div className="border-t border-[#E8D5C4] divide-y divide-[#F0E6D8]">
            {status.board.length === 0 && (
              <p className="px-4 py-6 text-sm text-[#8B7355] text-center">
                No floors yet. Add tables with a floor on the Tables page.
              </p>
            )}
            {status.board.map(f => {
              const mine = !!f.cashier && f.cashier.userId === status.me.id;
              return (
                <div key={f.floor} className="px-4 py-2.5 flex items-center gap-3 flex-wrap">
                  <div className="min-w-[7rem]">
                    <div className="font-semibold text-sm text-[#2D1B0E]">{f.label}</div>
                    <div className="text-[11px] text-[#8B7355]">
                      {f.activeTables} table{f.activeTables === 1 ? '' : 's'}
                    </div>
                  </div>

                  {f.cashier ? (
                    <span className="inline-flex items-center gap-1.5 text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-2.5 py-1">
                      <Users className="w-3.5 h-3.5" />
                      <span className="font-medium">{f.cashier.userName || 'Cashier'}{mine ? ' (you)' : ''}</span>
                      <span className="text-[11px] text-emerald-700">since {localTime(f.cashier.checkedInAt)}</span>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-sm text-amber-800 bg-amber-50 border border-amber-300 rounded-lg px-2.5 py-1">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      <span className="font-medium">No Cashier Logged In</span>
                    </span>
                  )}

                  {/* An expired hold is why a floor can read empty while a name is
                      still on the row — say so rather than pretend nobody came. */}
                  {!f.cashier && f.expired && (
                    <span className="text-[11px] text-[#8B7355]">
                      {f.expired.userName || 'A cashier'} checked in {localTime(f.expired.checkedInAt)}, not seen since {localTime(f.expired.lastSeen)}
                    </span>
                  )}

                  <div className="ml-auto flex items-center gap-2">
                    {!f.cashier && !mine && (
                      <button onClick={() => doCheckIn(f.floor)} disabled={!!busy}
                        className="text-xs font-medium border border-[#af4408]/40 text-[#af4408] hover:bg-[#af4408]/10 px-2.5 py-1.5 rounded-lg disabled:opacity-50">
                        Check in here
                      </button>
                    )}
                    {/* Force-clear: management only, and only where someone
                        else holds the floor. A live hold blocks OTHER STAFF
                        from settling there — management settles past it as a
                        recorded override — so clearing is housekeeping for a
                        cashier who went home, not the escape path. */}
                    {f.cashier && !mine && status.me.isManagement && (
                      <button onClick={() => doClear(f.floor)} disabled={!!busy}
                        title={'Clear ' + (f.cashier.userName || 'the cashier') + ' from ' + f.label + ' — use when they have gone home without checking out'}
                        className="text-xs font-medium border border-red-300 text-red-700 hover:bg-red-50 px-2.5 py-1.5 rounded-lg disabled:opacity-50">
                        Clear floor
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            <div className="px-4 py-2 flex items-center gap-2 bg-[#FAF4EC]">
              <button onClick={load} className="text-xs text-[#af4408] font-medium inline-flex items-center gap-1">
                <RefreshCw className="w-3 h-3" /> Refresh
              </button>
              <span className="text-[11px] text-[#8B7355]">
                A cashier stops holding their floor after {humanMins(status.timeoutMinutes)} with no activity.
              </span>
            </div>
          </div>
        )}
      </div>

      {/* ── THE ASK ────────────────────────────────────────────────────────── */}
      {pickerOpen && (
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-md p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3 mb-1">
              <h3 className="font-bold text-lg text-[#2D1B0E] inline-flex items-center gap-2">
                <MapPin className="w-5 h-5 text-[#af4408]" /> Which floor are you on?
              </h3>
              {/* Dismissible so nobody is trapped — the amber bar keeps it reachable. */}
              <button onClick={() => setPickerOpen(false)}
                aria-label="Close" className="text-[#8B7355] hover:text-[#af4408]">
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-sm text-[#8B7355] mb-4">
              {p
                ? <>You are on <b>{p.floor === '' ? 'Floor' : p.floor}</b>. Pick a different floor to move — your old floor is released automatically.</>
                : <>Bill requests from captains go to the cashier on their floor. Checking in also claims that floor, so nobody else settles its bills by mistake.</>}
            </p>

            {noFloors ? (
              <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                No floors are set up yet. Add tables with a floor on the Tables page, then check in here.
              </p>
            ) : (
              <div className="space-y-2">
                {floors.map(f => {
                  const held = status.board.find(b => b.floor === f.floor)?.cashier || null;
                  const isMine = !!p && p.floor === f.floor;
                  const heldByOther = !!held && held.userId !== status.me.id;
                  // EVICTION IS MANAGEMENT-ONLY (D6): the route answers a live
                  // held floor with a 409 for staff, so do not offer them the
                  // tap — a button that always errors is a lie with a hover
                  // state. An EXPIRED hold shows as cashier:null on the board
                  // and stays takeable by anyone here. isManagement is the
                  // server's own tier test off the wire, so this promise and
                  // the route's answer cannot drift (D10).
                  const canTake = !heldByOther || status.me.isManagement;
                  return (
                    <button key={f.floor} onClick={() => doCheckIn(f.floor)} disabled={!!busy || isMine || !canTake}
                      className={`w-full text-left rounded-lg border px-3 py-2.5 flex items-center gap-2 disabled:opacity-60 ${
                        isMine ? 'border-emerald-300 bg-emerald-50'
                        : !canTake ? 'border-[#E8D5C4] bg-[#FAF4EC] cursor-not-allowed'
                        : 'border-[#D4B896] hover:border-[#af4408] hover:bg-[#FFF1E3]'
                      }`}>
                      <span className="font-semibold text-[#2D1B0E]">{f.label}</span>
                      {isMine && <span className="text-[11px] text-emerald-700 font-medium">you are here</span>}
                      {/* Taking a manned floor is a management HANDOVER, and it
                          is recorded — say so before the tap, not after. Staff
                          are told who to ask instead of being offered a 409. */}
                      {heldByOther && (
                        <span className="text-[11px] text-amber-700">
                          {status.me.isManagement
                            ? (held!.userName || 'Another cashier') + ' is here — you will take over (recorded)'
                            : (held!.userName || 'Another cashier') + ' is here — ask them to check out, or a manager'}
                        </span>
                      )}
                      <span className="ml-auto text-xs text-[#af4408] font-medium">
                        {busy === 'in' ? '…' : isMine || !canTake ? '' : 'Check in'}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {!status.me.isManagement && !p && !noFloors && (
              <button onClick={() => setPickerOpen(false)}
                className="mt-4 w-full text-xs text-[#8B7355] hover:text-[#af4408] py-1">
                I&apos;m not working a floor right now
              </button>
            )}
          </div>
        </div>
      )}

      {note && (
        <div className={`fixed bottom-16 left-1/2 -translate-x-1/2 z-[70] px-4 py-2 rounded-lg text-sm text-white shadow-lg ${
          note.ok ? 'bg-emerald-600' : 'bg-red-600'
        }`}>{note.msg}</div>
      )}
    </>
  );
}
