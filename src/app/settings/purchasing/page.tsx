'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import Toggle from '@/components/Toggle';
import { ShoppingCart, Send, Loader2, AlertTriangle, ShieldCheck, ClipboardList, PackageMinus, Info } from 'lucide-react';

/**
 * Settings → Purchasing: options for the Purchase Order flow.
 *
 * `po_require_admin_approval` (DEFAULT ON) decides whether a submitted PO waits
 * in Pending for an Admin. Off means submit approves the PO in the same request,
 * so whoever raised it can receive it — stock bump, last_purchase_price and
 * average_price rewrite — with no second pair of eyes. That is a spend control,
 * so the state is read FAIL-SAFE: only an explicit "0" reads as off, and a
 * missing row, a null value or a failed fetch leaves the switch showing ON.
 * A failed read ALSO raises a "could not read this setting" row, so a default
 * ON is never mistaken for an ON the server actually confirmed.
 * The zero-rate gate is deliberately NOT part of this switch (see below).
 *
 * The other toggle is `po_send_to_vendor`. AKAN raises ONE combined internal
 * PO that spans several vendors and never sends it out, so the default is OFF and
 * the PO stays an internal approval/costing document. Turning it ON exposes the
 * per-vendor send action on an approved PO.
 *
 * Why the split matters: a PO can legitimately carry lines from several vendors,
 * and one sheet listing them all would show vendor A the rates negotiated with
 * vendor B. So the send action never sends a combined sheet — it produces one
 * document per vendor, carrying only that vendor's lines.
 *
 * THE THIRD CARD USED TO BE A SWITCH, AND IS NOW A STATUS LINE. It reported the
 * old deduct-at-issue settings key — the on/off gate for WHERE a gram left stock.
 * That gate is gone: the app now ALWAYS deducts central at the issue and always
 * draws recipe consumption from the receiving department's stock. Nothing reads
 * the key any more, so the switch is not merely redundant — a live control that
 * writes a key nothing reads is worse than no control at all, because an admin
 * flips it, sees the toast, and believes the stock model changed when it did
 * not. The settings ROW is deliberately left in place (admin-owned state is not
 * something a deploy rewrites), inert and ignored; do NOT re-add a reader.
 *
 * What replaces it is read-only and states the ONE thing that is still a
 * decision: whether the department opening balances have been counted and
 * recorded. That is an explicit admin action against
 * POST /api/department-ledger/cutover — never a boot migration — and until it
 * runs, department balances read "not counted yet" rather than 0. The date
 * shown here is settings.dept_ledger_cutover_at as reported by the cutover
 * route, i.e. the server's own stamp, never a date this page infers.
 */
export default function PurchasingSettingsPage() {
  const [sendToVendor, setSendToVendor] = useState(false);
  // Which items the BULK closing sheet carries. true = the whole raw-material
  // catalogue (the store's whole-building walk); false = only what each
  // department has ever requested. Default true — an item missing from the
  // sheet is an item nobody counts, which is the worse failure.
  const [bulkAllItems, setBulkAllItems] = useState(true);
  // Starts ON, and every failure path below leaves it ON: this switch reports a
  // spend control, so a read that goes wrong must never render as "approval off".
  const [requireApproval, setRequireApproval] = useState(true);
  // Whether the value above came from the server at all. Defaulting ON keeps the
  // control safe, but ON-because-we-could-not-read looks identical to
  // ON-because-the-server-says-so — and the second one suppresses the amber
  // "approval is OFF" banner. This flag tells the two apart on screen.
  const [approvalRead, setApprovalRead] = useState<'ok' | 'failed'>('ok');
  // The department opening cut-over, read from the server's own stamp. THREE
  // states, not two, and the third is the point: 'unread' must never collapse
  // into 'none'. "Opening balances not recorded yet" is a factual claim about
  // the ledger that sends an admin off to run a cut-over; if the read merely
  // failed, that claim is a guess, and a second cut-over run is answered 409
  // per (department, material) precisely because nobody should be guessing here.
  const [cutover, setCutover] = useState<{ state: 'none' | 'done' | 'unread'; at: string | null }>(
    { state: 'unread', at: null },
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [me, setMe] = useState<{ role?: string } | null>(null);
  // Tracked separately from `loading`: the settings fetch and the auth fetch race,
  // and gating only on the former made "Manager or Admin access is required"
  // flash on every load before /api/auth/me answered.
  const [meLoaded, setMeLoaded] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  // How many vendors we could actually reach — a send option is meaningless
  // while the vendor master carries no phone/email, so say so up front.
  const [reachable, setReachable] = useState<{ total: number; withContact: number } | null>(null);

  useEffect(() => {
    api('/api/auth/me').then(r => r.json()).then(d => setMe(d?.user || null))
      .catch(() => {}).finally(() => setMeLoaded(true));
    // Both keys gate the card, so hold `loading` until both answer — rendering
    // the approval switch on its default and flipping it a moment later is how a
    // spend control gets misread. Each fetch owns its catch, so one failing key
    // still reveals the other (and leaves its own state at the safe default).
    Promise.all([
      fetch('/api/settings?key=po_send_to_vendor').then(r => r.json())
        .then(d => setSendToVendor(d?.value === '1')).catch(() => {}),
      // Only an explicit 'requested' narrows the sheet. A missing row, an
      // unreadable value or a 401 body all leave it on ALL — the safe default,
      // because a short sheet silently drops items from the count.
      fetch('/api/settings?key=closing_sheet_bulk_scope').then(r => r.json())
        .then(d => setBulkAllItems(String(d?.value || 'all').trim() !== 'requested')).catch(() => {}),
      fetch('/api/settings?key=po_require_admin_approval').then(r => r.json())
        // FAIL-SAFE, and the mirror of requiresAdminApproval() on the server:
        // ONLY an explicit "0" is off. A missing row, a null, an unreadable value
        // or a 401 body (no `value` field) all leave this true = approval required
        // — and the last of those also marks the read failed, so the default is
        // labelled as a default rather than passed off as the server's answer.
        // Trimmed on purpose: if the server ever reads a padded " 0" as off, an
        // untrimmed compare here would show "on" over a switch that is actually
        // off — hiding a disabled spend control. Trimming can only over-warn.
        .then(d => {
          // A 200 is not proof of a read. GET /api/settings answers a real read
          // with a `value` field (null included — that is a genuine "no row yet",
          // which IS approval-required); a 401/500 body carries `error` instead.
          // Without this split, an unreadable key renders as a confident ON and
          // silently suppresses the amber banner below while the server may be
          // enforcing OFF — the one inversion this card exists to prevent.
          if (!d || typeof d !== 'object' || !('value' in d)) { setApprovalRead('failed'); return; }
          setRequireApproval(String(d.value ?? '').trim() !== '0');
        }).catch(() => setApprovalRead('failed')),
      // Asked of the cut-over route, NOT of /api/settings, even though the value
      // it reports IS settings.dept_ledger_cutover_at. The route is the owner of
      // that stamp — it is the only writer, it writes it once from the first
      // opening row's own timestamp, and it 503s with a "run the migration"
      // message when the ledger tables are absent. Reading the settings key
      // directly would answer null in that case and this line would then say
      // "not recorded yet" over a database that cannot record one. GET is
      // signed-in, not admin, so a Manager sees the same status an Admin does.
      fetch('/api/department-ledger/cutover').then(r => r.json())
        .then(d => {
          if (!d || typeof d !== 'object' || !('cutover_at' in d)) return; // stays 'unread'
          const at = String(d.cutover_at ?? '').trim();
          setCutover(at ? { state: 'done', at } : { state: 'none', at: null });
        }).catch(() => {}),
    ]).finally(() => setLoading(false));
    fetch('/api/vendors').then(r => r.json())
      .then(d => {
        const list = (d.vendors || []).filter((v: any) => v.is_active);
        setReachable({
          total: list.length,
          withContact: list.filter((v: any) => String(v.phone || '').trim() || String(v.email || '').trim()).length,
        });
      })
      .catch(() => {});
  }, []);

  const canEdit = !!me && (me.role === 'admin' || me.role === 'manager');
  // Stricter than canEdit for this ONE key, following the same reasoning as
  // purchase_backdate_limit_days in /api/settings: approving a PO is admin-only,
  // so a Manager who could switch this off would be handing themselves approval
  // of their own POs. Mirrors the real server gate in /api/settings PUT (and its
  // POST alias), which 403s a non-admin write of this key — this is the UI half
  // of an enforced rule, not intent. Keep the two in sync.
  const canEditApproval = !!me && me.role === 'admin';
  // There is no canEditDeductAtIssue any more, and no admin/manager split on the
  // stock-model status below: it is read-only for EVERY role, because there is
  // nothing left on this page to write. The one privileged action it points at —
  // recording the department opening balances — is admin-gated at
  // POST /api/department-ledger/cutover, which is where that check belongs.
  const flash = (ok: boolean, msg: string) => { setToast({ ok, msg }); setTimeout(() => setToast(null), 2500); };

  const save = async (on: boolean) => {
    const prev = sendToVendor;
    setSendToVendor(on); setSaving(true);
    try {
      const r = await api('/api/settings', { method: 'PUT', body: { key: 'po_send_to_vendor', value: on ? '1' : '0' } });
      if (!r.ok) { setSendToVendor(prev); flash(false, (await r.json().catch(() => ({}))).error || 'Failed to save'); }
      else flash(true, on ? 'Send to vendor enabled' : 'Send to vendor disabled');
    } catch { setSendToVendor(prev); flash(false, 'Failed to save'); }
    setSaving(false);
  };

  const saveBulkScope = async (on: boolean) => {
    const prev = bulkAllItems;
    setBulkAllItems(on); setSaving(true);
    try {
      const r = await api('/api/settings', {
        method: 'PUT',
        body: { key: 'closing_sheet_bulk_scope', value: on ? 'all' : 'requested' },
      });
      if (!r.ok) { setBulkAllItems(prev); flash(false, (await r.json().catch(() => ({}))).error || 'Failed to save'); }
      else flash(true, on ? 'Bulk sheet: all raw materials' : 'Bulk sheet: department-requested items only');
    } catch { setBulkAllItems(prev); flash(false, 'Failed to save'); }
    setSaving(false);
  };

  // Same optimistic set + revert as save(), kept as its own function so the two
  // switches never share a rollback. The revert matters most in one direction:
  // if a save fails the switch must snap back to what the SERVER still enforces,
  // because a stuck "on" would hide that approval is actually off.
  const saveApproval = async (on: boolean) => {
    const prev = requireApproval;
    setRequireApproval(on); setSaving(true);
    try {
      const r = await api('/api/settings', { method: 'PUT', body: { key: 'po_require_admin_approval', value: on ? '1' : '0' } });
      if (!r.ok) { setRequireApproval(prev); flash(false, (await r.json().catch(() => ({}))).error || 'Failed to save'); }
      // A save that lands tells us the server's value for certain, so it clears a
      // failed initial read — otherwise the "could not read" row would keep
      // warning about a value the admin just set from this page.
      else { setApprovalRead('ok'); flash(true, on ? 'Admin approval required' : 'Admin approval turned OFF'); }
    } catch { setRequireApproval(prev); flash(false, 'Failed to save'); }
    setSaving(false);
  };

  // There is deliberately NO saveDeductAtIssue here. The stock model is no longer
  // a preference, so this page has no write path to it — if a future change wants
  // one back, the question to answer first is which of the two deduction points
  // it would turn OFF, because both of them are now load-bearing at once.

  // 'YYYY-MM-DD HH:MM:SS' from SQLite, which `new Date()` reads as Invalid Date
  // unless the space becomes a T. Same helper as /department-variance, on purpose:
  // both surfaces are naming the SAME stamp and must not disagree by a day.
  const cutoverLabel = (s: string | null) => {
    if (!s) return '';
    const d = new Date(String(s).replace(' ', 'T'));
    return isNaN(d.getTime())
      ? String(s).slice(0, 10)
      : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  };

  return (
    <div className="min-h-screen bg-[#FFF8F0]">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-[#af4408]/10 rounded-lg"><ShoppingCart className="w-6 h-6 text-[#af4408]" /></div>
          <div>
            <h1 className="text-2xl font-bold text-[#af4408]">Purchasing Settings</h1>
            <p className="text-sm text-[#8B7355]">Options for the Purchase Order flow.</p>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-[#8B7355] py-10 justify-center"><Loader2 className="w-5 h-5 animate-spin" /> Loading…</div>
        ) : (
          <div className="bg-white border border-[#E8D5C4] rounded-xl divide-y divide-[#F0E6D8]">
            <div className="flex items-start justify-between gap-4 p-5">
              <div>
                <p className="font-semibold text-[#2D1B0E] flex items-center gap-1.5"><ShieldCheck className="w-4 h-4 text-[#af4408]" /> Require admin approval for POs</p>
                <p className="text-sm text-[#8B7355] mt-0.5">
                  On by default. A submitted PO waits at <b>Pending</b> until an Admin approves it, and
                  only an approved PO can be received.
                </p>
                <p className="text-sm text-[#8B7355] mt-1.5">
                  Switch it <b>off</b> and submitting a PO approves it immediately, in the same click.
                  Whoever raised it can then receive it straight away — booking the stock in and
                  rewriting the material&apos;s last purchase price and average price — with no Admin
                  ever looking at it. That removes the only check between raising an order and putting
                  the spend on the books.
                </p>
                <p className="text-sm text-[#8B7355] mt-1.5">
                  Two things do not change. The <b>zero-rate check still runs either way</b>: a line with
                  a missing or ₹0 rate is refused, because a ₹0 purchase would wipe that material&apos;s
                  average price and cascade a free ingredient through every recipe. And <b>editing an
                  already-approved PO still sends it back for Admin re-approval</b>, switch or no switch —
                  only the first submit is auto-approved, and an edited PO cannot be received again until
                  an Admin clears it. What you do lose is
                  the <b>Approval Review</b> panel — past purchases, current stock, consumption and its
                  flags (over-order, bought recently, price jump, already overstocked) are only shown
                  while a PO sits waiting for approval, so nothing surfaces them when this is off.
                </p>
                {meLoaded && canEdit && !canEditApproval && (
                  <p className="text-xs text-[#8B7355] mt-1.5">
                    Admin only — a Manager who could switch this off would be approving their own POs.
                  </p>
                )}
              </div>
              <Toggle checked={requireApproval} onChange={(v) => saveApproval(v)} disabled={!canEditApproval || saving} label="Require admin approval for POs" className="mt-1 shrink-0" />
            </div>

            {approvalRead === 'failed' && (
              <div className="flex items-start gap-2 p-5 bg-amber-50">
                <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                <p className="text-sm text-amber-800">
                  <b>Could not read this setting.</b> The switch above is showing its safe default
                  (approval required), not a value confirmed by the server — approval may in fact be
                  OFF right now. Reload before trusting it, or set it explicitly here.
                </p>
              </div>
            )}

            {!requireApproval && (
              <div className="flex items-start gap-2 p-5 bg-amber-50">
                <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                <p className="text-sm text-amber-800">
                  <b>Admin approval is OFF.</b> Every PO submitted from now on is approved on the spot,
                  so the same person can raise an order, receive it and move the material&apos;s average
                  price — unreviewed. Leave this off only if something outside this app controls who
                  raises POs.
                </p>
              </div>
            )}

            <div className="flex items-start justify-between gap-4 p-5">
              <div>
                <p className="font-semibold text-[#2D1B0E] flex items-center gap-1.5"><Send className="w-4 h-4 text-[#af4408]" /> Send PO to vendor</p>
                <p className="text-sm text-[#8B7355] mt-0.5">
                  Show a <b>Send to Vendor</b> action on an approved PO. Off by default — the PO stays an
                  internal approval and costing document.
                </p>
                <p className="text-sm text-[#8B7355] mt-1.5">
                  A PO may carry lines from several vendors. When it does, the send action produces
                  <b> one document per vendor</b> with only that vendor&apos;s lines — a combined sheet would
                  show one vendor the rates you negotiated with another.
                </p>
              </div>
              <Toggle checked={sendToVendor} onChange={(v) => save(v)} disabled={!canEdit || saving} label="Send PO to vendor" className="mt-1 shrink-0" />
            </div>

            {sendToVendor && reachable && reachable.withContact === 0 && (
              <div className="flex items-start gap-2 p-5 bg-amber-50">
                <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                <p className="text-sm text-amber-800">
                  None of your <b>{reachable.total}</b> active vendors has a phone number or email on file, so
                  a PO can only be printed or downloaded and shared by hand. Add contact details under{' '}
                  <a href="/vendors" className="underline">Vendors</a> to send directly.
                </p>
              </div>
            )}
            {sendToVendor && reachable && reachable.withContact > 0 && reachable.withContact < reachable.total && (
              <div className="flex items-start gap-2 p-5 bg-amber-50">
                <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                <p className="text-sm text-amber-800">
                  Only <b>{reachable.withContact}</b> of <b>{reachable.total}</b> active vendors has contact
                  details. The rest can only be printed or downloaded.
                </p>
              </div>
            )}
          </div>
        )}

        {!loading && (
          <div className="bg-white rounded-xl border border-[#E8D5C4] divide-y divide-[#E8D5C4]">
            <div className="flex items-start justify-between gap-4 p-5">
              <div>
                <p className="font-semibold text-[#2D1B0E] flex items-center gap-1.5">
                  <ClipboardList className="w-4 h-4 text-[#af4408]" /> Bulk closing sheet — all raw materials
                </p>
                <p className="text-sm text-[#8B7355] mt-0.5">
                  Controls the <b>Download blank template</b> and upload on the Department Closing Sheet.
                  <b> On</b> gives the store every raw material, because the store walks the whole building
                  and an item missing from the sheet is an item nobody counts.
                  <b> Off</b> narrows each department&rsquo;s columns to the items it has ever requested —
                  fewer rows on the walk, but anything never requested cannot be counted.
                </p>
                <p className="text-sm text-[#8B7355] mt-1.5">
                  This is the <b>bulk sheet only</b>. The on-screen Department Closing Sheet stays
                  department-scoped either way, and liquor is always excluded — it is counted in its own store.
                </p>
              </div>
              <Toggle checked={bulkAllItems} onChange={(v) => saveBulkScope(v)} disabled={!canEdit || saving}
                      label="All raw materials on the bulk sheet" className="mt-1 shrink-0" />
            </div>
          </div>
        )}

        {/* READ-ONLY BY DESIGN. This was a switch until the stock model stopped
            being optional. Do not put a Toggle back here: nothing on the server
            reads the old deduct-at-issue key any more, so a control here would
            write a key into `settings`, flash a green toast, and change nothing —
            which is how an owner ends up hunting for a second deduction that was
            never configurable in the first place. The settings row itself is left
            alone on purpose (a deploy does not rewrite admin-owned state); it is
            simply inert. */}
        {!loading && (
          <div className="bg-white rounded-xl border border-[#E8D5C4] divide-y divide-[#F0E6D8]">
            <div className="p-5">
              <p className="font-semibold text-[#2D1B0E] flex items-center gap-1.5">
                <PackageMinus className="w-4 h-4 text-[#af4408]" /> How stock is deducted
              </p>
              <p className="text-sm text-[#8B7355] mt-0.5">
                Stock is deducted when the store issues it to a department. Recipe consumption then
                draws on that department&apos;s stock. Department opening balances:{' '}
                {cutover.state === 'done'
                  ? <b className="text-[#2D1B0E]">recorded on {cutoverLabel(cutover.at)}</b>
                  : cutover.state === 'none'
                    ? <b className="text-[#2D1B0E]">not recorded yet</b>
                    /* NOT "not recorded yet". An unread status and a genuinely
                       un-run cut-over look the same on screen but send an admin
                       to two different places, and only one of them is a real
                       instruction. */
                    : <b className="text-[#2D1B0E]">could not be read</b>}.
              </p>
              <p className="text-sm text-[#8B7355] mt-1.5">
                A gram leaves the <b>central store</b> the moment it is issued on a requisition, for the
                quantity actually issued, and leaves the <b>department</b> when a recipe consumes it at
                KOT-complete. Never both — each gram moves exactly once at each step. Raw-material stock
                therefore means what the <b>central store</b> holds; what a kitchen holds is on{' '}
                <a href="/inventory/department-stock" className="underline">Inventory → Department Stock</a>.
              </p>
              <p className="text-sm text-[#8B7355] mt-1.5">
                Two carve-outs, both deliberate. <b>Liquor keeps its own ledger</b> — store-mapped
                materials are skipped by both legs and are counted in the Liquor Store, not here. And a
                sale from a station that has not been mapped to a department <b>deducts nothing</b>
                {' '}rather than guessing a kitchen; map it under{' '}
                <a href="/settings/station-departments" className="underline">Settings → Station Departments</a>.
              </p>
            </div>

            {/* Neutral, not amber, when the cut-over is outstanding: this is a
                task to schedule around a physical count, not a fault to clear. */}
            {cutover.state === 'none' && (
              <div className="flex items-start gap-2 p-5 bg-[#FDF6EE]">
                <Info className="w-4 h-4 text-[#8B7355] mt-0.5 shrink-0" />
                <p className="text-sm text-[#8B7355]">
                  <b>Department opening balances have not been recorded.</b> Until an Admin records them,
                  a department balance reads <b>not counted yet</b> rather than a number — that is
                  correct, not a fault. Issues from before the cut-over are shown separately and are never
                  added into a balance, so recording an opening is a physical count, not a catch-up.
                  The day-of steps are in{' '}
                  <code className="text-xs bg-[#F0E6D8] px-1 py-0.5 rounded">docs/requisition-deduct-at-issue-cutover.md</code>.
                </p>
              </div>
            )}

            {cutover.state === 'unread' && (
              <div className="flex items-start gap-2 p-5 bg-amber-50">
                <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                <p className="text-sm text-amber-800">
                  <b>Could not read the cut-over status.</b> The line above is not saying the opening
                  balances are missing — it is saying this page could not find out. Reload, or check{' '}
                  <a href="/inventory/department-stock" className="underline">Department Stock</a>, before
                  acting on it.
                </p>
              </div>
            )}
          </div>
        )}
        {!loading && meLoaded && !canEdit && <p className="text-xs text-[#8B7355]">Manager or Admin access is required to change these settings.</p>}
        {toast && <div className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg text-sm text-white ${toast.ok ? 'bg-emerald-600' : 'bg-red-600'}`}>{toast.msg}</div>}
      </div>
    </div>
  );
}
