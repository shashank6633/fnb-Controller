'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import Toggle from '@/components/Toggle';
import { Undo2, CalendarClock, ArrowLeftRight, PackageCheck, Loader2, AlertTriangle, Info, ShieldAlert } from 'lucide-react';

/**
 * Settings → Returns: the PO return window (requirement 75).
 *
 * ONE key lives here — `po_return_window_days` — and it is deliberately its own
 * page rather than a fourth card on Settings → Purchasing. Two reasons, and the
 * second is the load-bearing one:
 *
 *   1. /settings/purchasing is committed code, and the owner's standing rule is
 *      that committed behaviour is not edited without his approval. A new page
 *      is purely additive; it costs two nav entries and nothing else.
 *   2. That page already carries an in-file warning against re-adding a control
 *      for a retired key. It is not a page to grow a habit of appending to.
 *
 * WHAT THE KEY DOES, AND — much more importantly — WHAT IT DOES NOT DO.
 *
 * It does NOT close a purchase order. There is no closed status on
 * purchase_orders, no closed_at column, and nothing in scheduler or cron reads
 * that table. Adding a real closed status would break receive's
 * `status !== 'approved'` refusal and its in-transaction atomic claim, i.e. it
 * would make POs unreceivable. So this is a READ-TIME window and nothing else:
 * when a VENDOR return ticket is created, the server compares today against the
 * GRN's date and refuses the NEW ticket if the window has passed. Tickets that
 * already exist are untouched, POs are untouched, and a deploy or a restart
 * changes no row anywhere. Requirement 75's "or close it automatically" is
 * deliberately answered with a refusal rather than an unattended write — an
 * auto-close running on boot would retroactively shut real approved POs, which
 * is exactly the kind of silent change the owner has forbidden.
 *
 * WHY THE GRN DATE AND NOT received_at. A multi-vendor PO that is only
 * part-delivered leaves purchase_orders.received_at NULL (receive/route.ts) —
 * it is stamped only when the LAST vendor delivers. Measuring the window from
 * it would hold the window open indefinitely on a part-delivered PO and then
 * slam it shut the moment the final delivery lands, which is the opposite of
 * what anyone would expect. goods_receipt_notes.date is the day the goods
 * physically arrived, per GRN, so that is the clock.
 *
 * DEFAULT 0 = NO LIMIT, and that is exactly today's behaviour: POs are
 * currently open for returns forever. The key is NOT seeded — an absent row
 * reads as 0 — so installing this page changes nothing until an admin sets a
 * number on purpose.
 *
 * GATING. The switch and the field are admin-only in this UI. The server-side
 * admin-only write is NOT in place yet: it needs a KEY_POLICY entry in the
 * committed /api/settings route, which is an edit to committed code and is
 * waiting on the owner. Until then a Manager could still write this key
 * directly through the API, so the page says so out loud rather than implying
 * an enforcement that does not exist. (That exact gap — a UI restriction with
 * no server counterpart — is what left po_require_admin_approval unenforced for
 * a whole release; naming it beats repeating it.)
 */

/** Absent / unreadable / blank all mean 0 = no limit = today's behaviour. */
const NO_LIMIT = 0;
/**
 * Used ONLY when the switch is turned on while the box still reads 0. An "on"
 * switch over a window of zero days would be a control that says it is limiting
 * something and limits nothing, which is worse than being off.
 */
const SUGGESTED_DAYS = 7;
/**
 * Ten years. Not a policy, just a sanity rail on what this page will WRITE: a
 * fat-fingered 70000 is indistinguishable on screen from no limit at all, and a
 * window nobody can reach is a control that silently does nothing.
 *
 * A WRITE rail only — deliberately NOT applied when reading. getPoReturnWindowDays()
 * in src/lib/returns.ts does not clamp, so if a larger value ever reaches the
 * key by another route the server really does enforce it, and the number this
 * page prints beside "Currently enforced" has to be the server's number rather
 * than a prettier one. Clamping the read would understate a live block.
 */
const MAX_DAYS = 3650;

export default function ReturnsSettingsPage() {
  // The value the SERVER holds, as last read or last successfully written.
  // 0 = no limit. Never optimistic: `days` only moves when a save lands.
  const [days, setDays] = useState<number>(NO_LIMIT);
  // What is in the number box. Separate from `days` so typing does not read as
  // a saved change — this key refuses real return tickets, so "showing 7" and
  // "the server enforces 7" must not be the same pixel. It is seeded from, and
  // reset to, the ENFORCED value — so with no key present the box reads 0, not
  // a helpful-looking suggestion that nothing is actually applying.
  const [daysInput, setDaysInput] = useState<string>(String(NO_LIMIT));
  // Whether the initial GET actually answered. 0-because-no-row and
  // 0-because-we-could-not-read both render as "No limit", but only the first
  // is a fact — the second gets a banner instead of being passed off as one.
  const [readState, setReadState] = useState<'ok' | 'failed'>('ok');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [me, setMe] = useState<{ role?: string } | null>(null);
  // Tracked apart from `loading` because the settings fetch and the auth fetch
  // race; gating the "Admin access is required" line on `loading` alone makes it
  // flash on every load before /api/auth/me answers.
  const [meLoaded, setMeLoaded] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    api('/api/auth/me').then(r => r.json()).then(d => setMe(d?.user || null))
      .catch(() => {}).finally(() => setMeLoaded(true));

    fetch('/api/settings?key=po_return_window_days')
      .then(r => r.json())
      .then(d => {
        // A 200 is not proof of a read. GET /api/settings answers a real read
        // with a `value` field (null included — a genuine "no row yet", which
        // IS no limit); a 401/500 body carries `error` instead. Without this
        // split an unreadable key renders as a confident "No limit" and an
        // admin walks away believing returns are unrestricted while the server
        // may be refusing them at 7 days.
        if (!d || typeof d !== 'object' || !('value' in d)) { setReadState('failed'); return; }
        const raw = String(d.value ?? '').trim();
        // parseInt, NOT Number(), because getPoReturnWindowDays() in
        // src/lib/returns.ts uses parseInt and this line's whole job is to report
        // what that function will decide. They disagree on a value like "7abc",
        // which parseInt reads as 7 and Number() reads as NaN — and the direction
        // of that disagreement is the bad one: the server would be refusing
        // returns at 7 days while this page said "No limit". Blank, unparseable,
        // zero and negative all mean no limit in both. NOT clamped to MAX_DAYS
        // on the way in — see the constant.
        const n = parseInt(raw, 10);
        const eff = Number.isFinite(n) && n > 0 ? n : NO_LIMIT;
        setDays(eff);
        setDaysInput(String(eff));
      })
      .catch(() => setReadState('failed'))
      .finally(() => setLoading(false));
  }, []);

  // Admin only, for the same self-lift reasoning KEY_POLICY already applies to
  // purchase_backdate_limit_days: this key is a block, and whoever is subject to
  // a block must not be the one who can widen it. NOTE this is currently the UI
  // half of a rule the server does not yet enforce — see the page header.
  const canEdit = !!me && me.role === 'admin';
  const limited = days > 0;

  const flash = (ok: boolean, msg: string) => { setToast({ ok, msg }); setTimeout(() => setToast(null), 3000); };

  /**
   * The ONLY writer on this page. Takes the already-clamped whole number of days
   * (0 = no limit) so the switch and the Apply button cannot disagree about what
   * gets stored, and only advances local state once the server has accepted it.
   */
  const save = async (n: number) => {
    setSaving(true);
    try {
      const r = await api('/api/settings', {
        method: 'PUT',
        body: { key: 'po_return_window_days', value: String(n) },
      });
      if (!r.ok) {
        // Surface the SERVER's refusal verbatim when it gives one. Once the
        // KEY_POLICY entry lands, a Manager write will 403 with a specific
        // message, and swallowing it behind a generic "Failed to save" would
        // read as a network blip rather than a permission rule.
        const j: { error?: string } = await r.json().catch(() => ({}));
        flash(false, j?.error || 'Failed to save');
        return;
      }
      setDays(n);
      setDaysInput(String(n));
      // A save that lands tells us the server's value for certain, so it clears
      // a failed initial read — otherwise the "could not read" banner would keep
      // warning about a value the admin just set from this very page.
      setReadState('ok');
      flash(true, n > 0 ? `Return window set to ${n} day${n === 1 ? '' : 's'}` : 'Return window removed — no limit');
    } catch {
      flash(false, 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  // Switch ON writes a real number, never a placeholder: a window of 0 would be
  // an "on" switch that limits nothing, which reads as enforcement and is not.
  const toggleLimit = (on: boolean) => {
    if (!on) return save(NO_LIMIT);
    const typed = Math.floor(Number(daysInput));
    const n = Number.isFinite(typed) && typed > 0 ? Math.min(typed, MAX_DAYS) : SUGGESTED_DAYS;
    return save(n);
  };

  const applyDays = () => {
    const typed = Math.floor(Number(daysInput));
    if (!Number.isFinite(typed) || typed < 0) { flash(false, 'Enter a whole number of days (0 = no limit)'); return; }
    return save(Math.min(typed, MAX_DAYS));
  };

  const dirty = (() => {
    const typed = Math.floor(Number(daysInput));
    return limited && Number.isFinite(typed) && typed !== days;
  })();

  return (
    <div className="min-h-screen bg-[#FFF8F0]">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-[#af4408]/10 rounded-lg"><Undo2 className="w-6 h-6 text-[#af4408]" /></div>
          <div>
            <h1 className="text-2xl font-bold text-[#af4408]">Returns Settings</h1>
            <p className="text-sm text-[#8B7355]">How long a purchase order stays open for vendor returns.</p>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-[#8B7355] py-10 justify-center"><Loader2 className="w-5 h-5 animate-spin" /> Loading…</div>
        ) : (
          <>
            <div className="bg-white border border-[#E8D5C4] rounded-xl divide-y divide-[#F0E6D8]">
              <div className="flex items-start justify-between gap-4 p-5">
                <div>
                  <p className="font-semibold text-[#2D1B0E] flex items-center gap-1.5">
                    <CalendarClock className="w-4 h-4 text-[#af4408]" /> Limit how long a PO stays open for returns
                  </p>
                  <p className="text-sm text-[#8B7355] mt-0.5">
                    <b>Off is the default, and off is what the app does today</b> — a purchase order stays
                    open for vendor returns forever. Turn it on to set a number of days after which a new
                    vendor return can no longer be raised against that delivery.
                  </p>
                  <p className="text-sm text-[#8B7355] mt-1.5">
                    The clock runs from the <b>GRN date</b> — the day the goods actually arrived — and not
                    from the PO&apos;s received date. A PO that spans several vendors is stamped as received
                    only when the <i>last</i> vendor delivers, so measuring from it would leave the window
                    hanging open on a part-delivered order and then shut it the moment the final load lands.
                    A PO with three GRNs therefore has three separate windows, one per delivery, which is
                    what the goods themselves do.
                  </p>
                  <p className="text-sm text-[#8B7355] mt-1.5">
                    The last day counts. With a <b>7-day</b> window, goods received exactly 7 days ago can
                    still be returned; 8 days ago is refused. Days are counted on India time, not UTC.
                  </p>
                  <p className="text-sm text-[#8B7355] mt-1.5">
                    This applies to <b>vendor returns only</b>. An internal department return has no PO and
                    no GRN behind it — the goods were issued from the store, not bought that day — so it is
                    never blocked by this window.
                  </p>
                  <p className="text-sm text-[#8B7355] mt-1.5">
                    One knock-on worth knowing before you switch it on: while a window is in force, a vendor
                    return needs a <b>real receipt date</b>. A GRN with a missing or malformed date is
                    refused rather than waved through — a window that quietly exempts exactly the records
                    with the worst paperwork is not a window. With the setting off, those returns go through
                    as they always have.
                  </p>
                </div>
                <Toggle
                  checked={limited}
                  onChange={(v) => toggleLimit(v)}
                  disabled={!canEdit || saving}
                  label="Limit how long a PO stays open for returns"
                  className="mt-1 shrink-0"
                />
              </div>

              <div className="p-5">
                <label htmlFor="po-return-window-days" className="font-semibold text-[#2D1B0E] text-sm">
                  Return window (days after the GRN date)
                </label>
                <div className="flex flex-wrap items-center gap-2 mt-2">
                  <input
                    id="po-return-window-days"
                    type="number"
                    min={0}
                    max={MAX_DAYS}
                    step={1}
                    inputMode="numeric"
                    value={daysInput}
                    disabled={!canEdit || saving}
                    onChange={(e) => setDaysInput(e.target.value)}
                    className="w-28 px-3 py-2 rounded-lg border border-[#E8D5C4] bg-white text-[#2D1B0E] text-sm
                               outline-none focus:ring-2 focus:ring-[#af4408]/30 disabled:opacity-60"
                  />
                  <button
                    type="button"
                    onClick={applyDays}
                    disabled={!canEdit || saving}
                    className="px-3 py-2 rounded-lg bg-[#af4408] text-white text-sm font-medium
                               disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {saving ? 'Saving…' : 'Apply'}
                  </button>
                  <span className="text-sm text-[#8B7355]">
                    Currently enforced:{' '}
                    <b className="text-[#2D1B0E]">
                      {limited ? `${days} day${days === 1 ? '' : 's'}` : 'No limit'}
                    </b>
                  </span>
                </div>
                <p className="text-xs text-[#8B7355] mt-2">
                  <b>0 means no limit</b> — the same as switching the control above off, and the same as the
                  app&apos;s behaviour before this setting existed. Whole days only; anything you type above{' '}
                  {MAX_DAYS.toLocaleString('en-IN')} is saved as {MAX_DAYS.toLocaleString('en-IN')}, because a
                  window nobody can reach is a control that quietly does nothing. Switching the control above on while this box reads 0
                  starts you at <b>{SUGGESTED_DAYS} days</b> — an &ldquo;on&rdquo; switch with a zero-day
                  window would limit nothing while looking as though it did.
                </p>
                {dirty && (
                  <p className="text-xs text-amber-700 mt-1.5">
                    Typed, not saved. The server still enforces <b>{days} day{days === 1 ? '' : 's'}</b> until
                    you press Apply.
                  </p>
                )}
              </div>

              {readState === 'failed' && (
                <div className="flex items-start gap-2 p-5 bg-amber-50">
                  <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                  <p className="text-sm text-amber-800">
                    <b>Could not read this setting.</b> The value shown above is this page&apos;s safe
                    default (<b>no limit</b>), not a value confirmed by the server — a window may in fact be
                    in force right now, and a vendor return could be refused as out of window. Reload before
                    trusting it, or set it explicitly here.
                  </p>
                </div>
              )}
            </div>

            {/* Read-only, and here on purpose. The number above is the only thing
                this page writes, but the number is meaningless to whoever is
                setting it unless they know what a return actually does to stock —
                and the two kinds of return do OPPOSITE things. An admin who
                assumes "a return puts stock back" and then sets a window on the
                strength of that assumption is reasoning about the wrong movement
                half the time. State it where they will hit it. */}
            <div className="bg-white rounded-xl border border-[#E8D5C4] divide-y divide-[#F0E6D8]">
              <div className="p-5">
                <p className="font-semibold text-[#2D1B0E] flex items-center gap-1.5">
                  <PackageCheck className="w-4 h-4 text-[#af4408]" /> Stock moves only when the Store accepts
                </p>
                <p className="text-sm text-[#8B7355] mt-0.5">
                  A return ticket is raised by a department, approved by the Department Head or Manager, and
                  only then reaches the Store. <b>No stock moves at any of those steps.</b> Stock moves at
                  exactly one moment — when the <b>Store verifies and accepts</b> the line — and it moves
                  once. A line the Store rejects (with a mandatory reason) leaves stock exactly where it was,
                  and so does a ticket the Head rejects or the department cancels.
                </p>
                <p className="text-sm text-[#8B7355] mt-1.5">
                  Setting a window here does not change any of that. It only stops a <b>new</b> vendor return
                  ticket from being raised against an old delivery; a ticket already in the chain runs to its
                  end on the same rails.
                </p>
              </div>

              <div className="p-5">
                <p className="font-semibold text-[#2D1B0E] flex items-center gap-1.5">
                  <ArrowLeftRight className="w-4 h-4 text-[#af4408]" /> The two kinds of return pull opposite ways
                </p>
                <p className="text-sm text-[#8B7355] mt-0.5">
                  <b>Vendor return</b> — the goods go back out of the building to the supplier. Central store
                  stock <b>decreases</b>. Nothing is added back anywhere; what you are owed is a credit note,
                  which is recorded on the ticket for the record and never touches stock or costing.
                </p>
                <p className="text-sm text-[#8B7355] mt-1.5">
                  <b>Internal department return</b> — a kitchen sends issued goods back to the store. The
                  goods never leave the building: department stock <b>decreases</b> and central store stock{' '}
                  <b>increases</b> by the same quantity. Returned goods go back into the ordinary central
                  stock pool — there is no separate holding bin — and the ticket is the trail that says where
                  they came from.
                </p>
                <p className="text-sm text-[#8B7355] mt-1.5">
                  Because the two are opposites, a return marked as the wrong kind either invents stock the
                  building does not have or destroys stock it does. The kind is fixed when the ticket is
                  raised and cannot be changed afterwards.
                </p>
                <p className="text-sm text-[#8B7355] mt-1.5">
                  Goods that come back unusable are marked <b>Wastage</b> or <b>Disposal</b> on the line
                  instead. Those write the department&apos;s stock down and are <b>never</b> added back to
                  central — unusable goods must not re-enter the sellable pool.
                </p>
              </div>
            </div>

            <div className="bg-white rounded-xl border border-[#E8D5C4]">
              <div className="flex items-start gap-2 p-5">
                <Info className="w-4 h-4 text-[#8B7355] mt-0.5 shrink-0" />
                <p className="text-sm text-[#8B7355]">
                  <b>No purchase order is closed, reopened or altered by this setting.</b> There is no
                  &ldquo;closed&rdquo; state on a PO in this app and nothing here writes one. Restarting or
                  redeploying the app does not touch a single purchase order row either — the window is
                  checked when someone tries to raise a return, and at no other time.
                </p>
              </div>
            </div>

            {meLoaded && (
              <div className="flex items-start gap-2 p-4 rounded-xl border border-[#E8D5C4] bg-[#FDF6EE]">
                <ShieldAlert className="w-4 h-4 text-[#8B7355] mt-0.5 shrink-0" />
                <p className="text-sm text-[#8B7355]">
                  {!canEdit && <><b>Admin access is required to change this setting.</b> You can see what is
                  currently enforced.<br /></>}
                  <b>Enforcement note:</b> this page restricts the control to Admin, but the server does not
                  yet refuse a non-admin write of <code className="text-xs bg-[#F0E6D8] px-1 py-0.5 rounded">po_return_window_days</code>{' '}
                  — that needs a policy entry in the shared settings endpoint, which is pending the
                  owner&apos;s approval to touch committed code. Until it lands, treat the restriction here as
                  a convention rather than a guarantee.
                </p>
              </div>
            )}
          </>
        )}

        {toast && (
          <div className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg text-sm text-white ${toast.ok ? 'bg-emerald-600' : 'bg-red-600'}`}>
            {toast.msg}
          </div>
        )}
      </div>
    </div>
  );
}
