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
 * The third card, `requisition_deduct_at_issue`, is the CUTOVER SWITCH for the
 * stock model itself, and it reads FAIL-SAFE IN THE OPPOSITE DIRECTION to the
 * approval switch: only an explicit "1" is ON. OFF is what the app does today,
 * so a missing row, a null, an unreadable value or a 401 body must all render
 * OFF — a card that over-reported ON would tell the owner the cutover had
 * already happened when the server is still deducting at KOT-complete, and they
 * would go looking for the second deduction that this page claimed was gone.
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
  // The stock-model cutover. Starts OFF and every failure path below leaves it
  // OFF, because OFF is the live behaviour: stock falls when a dish is SOLD, not
  // when the store issues it. There is deliberately no `deductRead` twin of
  // approvalRead here — an unreadable key and a genuine "not switched on yet"
  // describe the same live system, so there is nothing to warn about.
  const [deductAtIssue, setDeductAtIssue] = useState(false);
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
      // The exact mirror of issueDeductionEnabled() in src/lib/issue-stock.ts —
      // `String(row?.value ?? '0') === '1'`. Note what is NOT here: a .trim().
      // The switch above trims on purpose; this one must NOT, because the server
      // does not. A stored " 1 " is OFF to issue-stock.ts, and a trim here would
      // paint the card ON over a system still deducting at KOT-complete. Keeping
      // the two comparisons character-identical is the point — if you "tidy" this
      // into the trimmed form used two lines up, the page starts lying in the one
      // direction that matters.
      fetch('/api/settings?key=requisition_deduct_at_issue').then(r => r.json())
        .then(d => setDeductAtIssue(String(d?.value ?? '0') === '1')).catch(() => {}),
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
  // Same shape as canEditApproval, and for a bigger reason. This key changes WHEN
  // a gram leaves raw_materials.current_stock for the whole outlet; flipped at the
  // wrong moment it double-counts or under-counts every recipe material at once.
  // The real gate is the server's (KEY_POLICY write:'admin' in /api/settings) —
  // this is only its UI half. Keep the two in sync: a UI-only restriction with no
  // server counterpart is exactly the gap po_require_admin_approval sat in for a
  // whole release.
  const canEditDeductAtIssue = !!me && me.role === 'admin';
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

  // Its own optimistic set + revert, like the three above. The revert matters in
  // BOTH directions here: this switch decides which of two mutually exclusive
  // deduction points is live, so a switch stuck out of step with the server does
  // not merely mislead — it invites someone to "fix" the arithmetic they think is
  // running and remove the same gram twice.
  const saveDeductAtIssue = async (on: boolean) => {
    const prev = deductAtIssue;
    setDeductAtIssue(on); setSaving(true);
    try {
      const r = await api('/api/settings', { method: 'PUT', body: { key: 'requisition_deduct_at_issue', value: on ? '1' : '0' } });
      if (!r.ok) { setDeductAtIssue(prev); flash(false, (await r.json().catch(() => ({}))).error || 'Failed to save'); }
      else flash(true, on ? 'Stock now deducts when the store issues' : 'Stock deducts when a dish is sold');
    } catch { setDeductAtIssue(prev); flash(false, 'Failed to save'); }
    setSaving(false);
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

        {!loading && (
          <div className="bg-white rounded-xl border border-[#E8D5C4] divide-y divide-[#F0E6D8]">
            <div className="flex items-start justify-between gap-4 p-5">
              <div>
                <p className="font-semibold text-[#2D1B0E] flex items-center gap-1.5">
                  <PackageMinus className="w-4 h-4 text-[#af4408]" /> Deduct stock when the store issues it
                </p>
                <p className="text-sm text-[#8B7355] mt-0.5">
                  Decides <b>when</b> a gram leaves raw-material stock. It is only ever one of the two —
                  the point of this switch is that the same gram is never removed twice.
                </p>
                <p className="text-sm text-[#8B7355] mt-1.5">
                  <b>Off (today).</b> Stock falls when a <b>dish is sold</b> — the recipe is costed out at
                  KOT-complete. Issuing goods to a kitchen on a requisition records the issue but moves no
                  stock, so raw-material stock stands for everything the outlet holds, store and kitchens
                  together.
                </p>
                <p className="text-sm text-[#8B7355] mt-1.5">
                  <b>On.</b> Stock falls the moment goods <b>leave the store</b> on a requisition, for the
                  quantity the store actually issued. Recipe consumption at KOT-complete <b>stops deducting
                  a second time</b> — it is still recorded against every ingredient, and still drives the
                  <b> Variance</b> and <b>Sales vs Purchase</b> reports exactly as it does now. Nothing is
                  lost from those reports; the figure simply stops being a second withdrawal.
                </p>
                <p className="text-sm text-[#8B7355] mt-1.5">
                  What changes in meaning: raw-material stock becomes what the <b>central store</b> holds,
                  not what the outlet holds. What a kitchen holds moves to{' '}
                  <a href="/inventory/department-stock" className="underline">Inventory → Department Stock</a>.
                  That is the whole reason for the switch — the gap between what the store issued to a
                  department and what the recipes say should have been used is what tells you <i>where</i> a
                  loss happened.
                </p>
                <p className="text-sm text-[#8B7355] mt-1.5">
                  The <b>Issued Items Log</b> and department consumption already record the issued quantity
                  and are unaffected either way — this switch changes the stock arithmetic only.
                </p>
                {meLoaded && canEdit && !canEditDeductAtIssue && (
                  <p className="text-xs text-[#8B7355] mt-1.5">
                    Admin only — this changes how stock is counted for the whole outlet.
                  </p>
                )}
              </div>
              <Toggle checked={deductAtIssue} onChange={(v) => saveDeductAtIssue(v)} disabled={!canEditDeductAtIssue || saving}
                      label="Deduct stock when the store issues it" className="mt-1 shrink-0" />
            </div>

            {/* Neutral, NOT amber. Off is the correct, shipped state — an amber
                block here would read as a fault to be cleared and invite exactly
                the casual flip the note is warning against. */}
            {!deductAtIssue && (
              <div className="flex items-start gap-2 p-5 bg-[#FDF6EE]">
                <Info className="w-4 h-4 text-[#8B7355] mt-0.5 shrink-0" />
                <p className="text-sm text-[#8B7355]">
                  <b>This cannot be switched on casually.</b> It is a cutover, not a preference: take a full
                  central <b>closing count</b> first and clear the <b>variance-approval queue</b>, so the
                  opening figure on the new basis is a counted number rather than a carried-over one.
                  Read the day-of steps — including what happens to a requisition half-issued across the
                  boundary, and how to reverse it — in{' '}
                  <code className="text-xs bg-[#F0E6D8] px-1 py-0.5 rounded">docs/requisition-deduct-at-issue-cutover.md</code>.
                </p>
              </div>
            )}

            {deductAtIssue && (
              <div className="flex items-start gap-2 p-5 bg-amber-50">
                <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                <p className="text-sm text-amber-800">
                  <b>Stock figures now mean the central store only.</b> Inventory, Low Stock, the Buy List
                  and the Consolidated Stock board will all read <b>lower</b> than before — that is the
                  switch working, not stock going missing; the difference is sitting in the kitchens, on
                  Department Stock. Two things to know: <b>wastage and staff meals still debit central
                  stock</b>, even for goods already issued to a kitchen, so recording either against
                  something the store no longer holds will push central stock down again. And <b>do not
                  migrate the Liquor Store while this is on</b> — it keeps its own ledger and has not been
                  moved to this basis.
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
