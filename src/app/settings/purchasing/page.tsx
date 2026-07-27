'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import Toggle from '@/components/Toggle';
import { ShoppingCart, Send, Loader2, AlertTriangle, ShieldCheck } from 'lucide-react';

/**
 * Settings → Purchasing: options for the Purchase Order flow.
 *
 * `po_require_admin_approval` (DEFAULT ON) decides whether a submitted PO waits
 * in Pending for an Admin. Off means submit approves the PO in the same request,
 * so whoever raised it can receive it — stock bump, last_purchase_price and
 * average_price rewrite — with no second pair of eyes. That is a spend control,
 * so the state is read FAIL-SAFE: only an explicit "0" reads as off, and a
 * missing row, a null value or a failed fetch leaves the switch showing ON.
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
 */
export default function PurchasingSettingsPage() {
  const [sendToVendor, setSendToVendor] = useState(false);
  // Starts ON, and every failure path below leaves it ON: this switch reports a
  // spend control, so a read that goes wrong must never render as "approval off".
  const [requireApproval, setRequireApproval] = useState(true);
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
      fetch('/api/settings?key=po_require_admin_approval').then(r => r.json())
        // FAIL-SAFE, and the mirror of requiresAdminApproval() on the server:
        // ONLY an explicit "0" is off. A missing row, a null, an unreadable value
        // or a 401 body (no `value` field) all leave this true = approval required.
        // Trimmed on purpose: if the server ever reads a padded " 0" as off, an
        // untrimmed compare here would show "on" over a switch that is actually
        // off — hiding a disabled spend control. Trimming can only over-warn.
        .then(d => setRequireApproval(String(d?.value ?? '').trim() !== '0')).catch(() => {}),
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
  // of their own POs. Client-side only — the API still accepts a manager PUT on
  // this key, so treat this as intent, not enforcement, until that gate lands.
  const canEditApproval = !!me && me.role === 'admin';
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
      else flash(true, on ? 'Admin approval required' : 'Admin approval turned OFF');
    } catch { setRequireApproval(prev); flash(false, 'Failed to save'); }
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
                  average price and cascade a free ingredient through every recipe. What you do lose is
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
        {!loading && meLoaded && !canEdit && <p className="text-xs text-[#8B7355]">Manager or Admin access is required to change these settings.</p>}
        {toast && <div className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg text-sm text-white ${toast.ok ? 'bg-emerald-600' : 'bg-red-600'}`}>{toast.msg}</div>}
      </div>
    </div>
  );
}
