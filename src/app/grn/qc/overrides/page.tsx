'use client';

/**
 * INWARDED WITHOUT KITCHEN QC (/grn/qc/overrides) — management only.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS PAGE EXISTS BECAUSE TWO SCREENS ALREADY PROMISED IT
 * ═══════════════════════════════════════════════════════════════════════════
 * The owner's decision 2 is that an override IS allowed — goods must be able to
 * move when no checker is on the floor — but that "the GRN is PERMANENTLY marked
 * 'inwarded without kitchen QC' and appears on a report".
 *
 * Both halves of the marking shipped. `qc_override_by`, `qc_override_at` and
 * `qc_override_reason` are committed columns on goods_receipt_notes, written
 * inside the same transaction as the stock move (src/lib/grn-qc.ts:1610), and
 * GET /api/grn/qc/overrides has served that report since August.
 *
 * The REPORT never shipped. The route had no caller, no page, and no row in
 * page-catalog.ts or Sidebar.tsx — so the data accumulated where nobody could
 * read it, while /grn/qc told the person overriding, twice and to their face:
 *
 *   page.tsx:527  "…it is stamped on this bill permanently and appears on the
 *                  override report."
 *   page.tsx:943  "…reason, and appears on the override report."
 *
 * A promise made at the exact moment someone bypasses a food-safety check is a
 * bad one to leave unkept: the deterrent is the visibility, and there was none.
 * Found by an audit on 2026-10-05, after the same class of defect (a shipped
 * surface wired to nothing) was found in Guest Feedback.
 *
 * ── WHAT IT SHOWS, AND WHY THOSE COLUMNS ────────────────────────────────────
 * An override is only answerable if you can see WHO let it through, WHEN, WHY,
 * and WHAT MOVED. Reason is given the room to be read in full rather than
 * truncated — it is the one field a person wrote by hand, under obligation, and
 * a clipped reason is the same as no reason. `inwarded_value` is present because
 * "a small override" and "a lakh of stock" are different conversations.
 *
 * ── NO MONEY GATE OF ITS OWN ────────────────────────────────────────────────
 * The route is isManagement-gated and returns the inwarded value, so this page
 * carries the same gate and nothing weaker. It is registered mgmtOnly in BOTH
 * page-catalog.ts and Sidebar.tsx — both files, in the same commit, hrefs
 * matching character for character. A row in only one of them is the drift that
 * once hid /variance-approvals: catalog-only is gated but invisible,
 * sidebar-only is visible but ungated.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle, ArrowLeft, Download, Loader2, RefreshCw, ShieldAlert, PackageCheck,
} from 'lucide-react';

/* ── Shapes, exactly as GET /api/grn/qc/overrides returns them ─────────────── */

interface OverrideRow {
  id: string;
  grn_number: string;
  date: string;
  vendor: string;
  invoice_number: string;
  status: string;
  qc_checker: string;
  qc_override_by: string;
  qc_override_at: string;
  qc_override_reason: string;
  received_by: string;
  po_id: string | null;
  po_number: string | null;
  line_count: number;
  inwarded_value: number;
  categories?: string[];
}

interface OverridesResponse {
  rows: OverrideRow[];
  count: number;
  total_value: number;
}

/* ── Small helpers ────────────────────────────────────────────────────────── */

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Default window: the last 30 days. Long enough that a quiet week still shows
 *  something, short enough that the first paint is the recent picture rather
 *  than every override since the feature shipped. */
function defaultRange(): { from: string; to: string } {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - 30);
  return { from: iso(start), to: iso(now) };
}

const money = (n: unknown) =>
  `₹${(Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** 'YYYY-MM-DD HH:MM:SS' (UTC, as SQLite stores it) → a readable IST stamp.
 *  The override time is evidence, so it is shown to the minute and never
 *  reduced to "2 days ago" — "who was on shift at 23:40" is the question it
 *  gets asked. */
function istStamp(raw: unknown): string {
  const s = String(raw || '').trim();
  if (!s) return '—';
  const ms = Date.parse(s.replace(' ', 'T') + (/[Zz]|[+-]\d{2}:?\d{2}$/.test(s) ? '' : 'Z'));
  if (!Number.isFinite(ms)) return s;
  return new Date(ms).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

export default function QcOverridesPage() {
  const seed = useMemo(defaultRange, []);
  const [from, setFrom] = useState(seed.from);
  const [to, setTo] = useState(seed.to);
  const [data, setData] = useState<OverridesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');

  const qs = useCallback(
    (format: 'json' | 'csv') => new URLSearchParams({ from, to, format }).toString(),
    [from, to],
  );

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await fetch(`/api/grn/qc/overrides?${qs('json')}`, { cache: 'no-store' });
      // A failed load must never read as "no overrides happened". An empty
      // food-safety report that is really a 403 is how a manager concludes the
      // kitchen checked everything.
      if (res.status === 401) { setError('Sign in required.'); setData(null); return; }
      if (res.status === 403) {
        setError('Management only — this report names who bypassed a kitchen check, so it carries the same gate as the receiving money it reports.');
        setData(null); return;
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}) as any);
        setError(j?.error || `Failed to load the override report (HTTP ${res.status}).`);
        setData(null); return;
      }
      const j = (await res.json()) as OverridesResponse;
      setData({
        rows: Array.isArray(j.rows) ? j.rows : [],
        count: Number(j.count) || 0,
        total_value: Number(j.total_value) || 0,
      });
    } catch {
      setError('Network error — please try again.');
      setData(null);
    } finally { setLoading(false); }
  }, [qs]);

  useEffect(() => { load(); }, [load]);

  const download = async () => {
    setDownloading(true); setError('');
    try {
      const res = await fetch(`/api/grn/qc/overrides?${qs('csv')}`, { cache: 'no-store' });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}) as any);
        setError(j?.error || (res.status === 403 ? 'Management only — download refused.' : `Download failed (HTTP ${res.status}).`));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `GRN-inwarded-without-kitchen-QC-${from}_to_${to}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch { setError('Network error — download failed.'); }
    finally { setDownloading(false); }
  };

  const rows = data?.rows || [];

  return (
    <div className="min-h-screen bg-[#FDF8F3] p-4 sm:p-6">
      <div className="max-w-7xl mx-auto space-y-4">

        {/* ── Header ───────────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Link href="/grn/qc" className="inline-flex items-center gap-1.5 text-[13px] text-[#8B7355] hover:text-[#af4408] mb-1">
              <ArrowLeft className="w-3.5 h-3.5" /> Kitchen QC
            </Link>
            <h1 className="text-2xl font-bold text-[#2D1B0E] flex items-center gap-2">
              <ShieldAlert className="w-6 h-6 text-[#af4408]" />
              Inwarded without kitchen QC
            </h1>
            <p className="text-[13px] text-[#8B7355] mt-1 max-w-3xl">
              Every receipt released into stock without a kitchen check, with who allowed it and the
              reason they gave. This is the report the override prompt promises.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={load}
              disabled={loading}
              className="flex items-center gap-2 px-3 py-2 bg-white border border-[#E8D5C4] hover:border-[#af4408] disabled:opacity-60 rounded-xl text-sm text-[#2D1B0E] transition-colors"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Refresh
            </button>
            <button
              onClick={download}
              disabled={downloading || loading || rows.length === 0}
              className="flex items-center gap-2 px-4 py-2 bg-[#af4408] hover:bg-[#963a06] disabled:opacity-60 text-white rounded-xl text-sm font-semibold shadow-sm transition-colors"
            >
              {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              CSV
            </button>
          </div>
        </div>

        {/* ── Range ────────────────────────────────────────────────────── */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl p-3 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wide text-[#8B7355]">From</span>
            <input
              type="date" value={from} onChange={(e) => setFrom(e.target.value)}
              className="px-3 py-2 border border-[#E8D5C4] rounded-lg text-sm text-[#2D1B0E] bg-white"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wide text-[#8B7355]">To</span>
            <input
              type="date" value={to} onChange={(e) => setTo(e.target.value)}
              className="px-3 py-2 border border-[#E8D5C4] rounded-lg text-sm text-[#2D1B0E] bg-white"
            />
          </label>
          <p className="text-[11px] text-[#8B7355] ml-auto max-w-sm">
            Dated by the GRN&rsquo;s own date, not the moment of the override, so a backdated receipt
            sits in the period it belongs to.
          </p>
        </div>

        {/* ── Error ────────────────────────────────────────────────────── */}
        {error && (
          <div className="bg-amber-50 border border-amber-300 rounded-xl p-3 text-[13px] text-amber-900 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-px shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* ── Totals ───────────────────────────────────────────────────── */}
        {!error && data && (
          <div className="grid grid-cols-2 gap-3 max-w-md">
            <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
              <p className="text-[11px] uppercase tracking-wide text-[#8B7355]">Overrides</p>
              <p className="text-2xl font-bold text-[#2D1B0E]">{data.count.toLocaleString('en-IN')}</p>
            </div>
            <div className="bg-white border border-[#E8D5C4] rounded-xl p-3">
              <p className="text-[11px] uppercase tracking-wide text-[#8B7355]">Value inwarded</p>
              <p className="text-2xl font-bold text-[#2D1B0E]">{money(data.total_value)}</p>
            </div>
          </div>
        )}

        {/* ── The rows ─────────────────────────────────────────────────── */}
        {!error && (
          loading ? (
            <div className="bg-white border border-[#E8D5C4] rounded-xl p-10 text-center text-sm text-[#8B7355]">
              <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading&hellip;
            </div>
          ) : rows.length === 0 ? (
            /* An empty report here is GOOD NEWS and should read that way — but it
             * must still say what it looked at, or "nothing in this window" and
             * "the window is wrong" look identical. */
            <div className="bg-white border border-[#E8D5C4] rounded-xl p-10 text-center">
              <PackageCheck className="w-8 h-8 text-emerald-600 mx-auto mb-2" />
              <p className="text-sm font-semibold text-[#2D1B0E]">No receipt was inwarded without a kitchen check</p>
              <p className="text-[12px] text-[#8B7355] mt-1">
                Between {from} and {to}. Widen the dates to look further back.
              </p>
            </div>
          ) : (
            <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-[#FDF8F3] border-b border-[#E8D5C4]">
                    <tr className="text-left text-[11px] uppercase tracking-wide text-[#8B7355]">
                      <th className="px-3 py-2 font-medium">GRN</th>
                      <th className="px-3 py-2 font-medium">Date</th>
                      <th className="px-3 py-2 font-medium">Vendor</th>
                      <th className="px-3 py-2 font-medium">Allowed by</th>
                      <th className="px-3 py-2 font-medium">When</th>
                      <th className="px-3 py-2 font-medium text-right">Lines</th>
                      <th className="px-3 py-2 font-medium text-right">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} className="border-b border-[#F3E9DD] last:border-0 align-top">
                        <td className="px-3 py-2.5">
                          <Link href={`/grn/${r.id}`} className="font-medium text-[#af4408] hover:underline">
                            {r.grn_number || '—'}
                          </Link>
                          {r.invoice_number ? (
                            <p className="text-[11px] text-[#8B7355] mt-0.5">Bill {r.invoice_number}</p>
                          ) : null}
                          {r.po_number ? (
                            <p className="text-[11px] text-[#8B7355]">PO {r.po_number}</p>
                          ) : null}
                        </td>
                        <td className="px-3 py-2.5 text-[#2D1B0E] whitespace-nowrap">{r.date || '—'}</td>
                        <td className="px-3 py-2.5 text-[#2D1B0E]">{r.vendor || '—'}</td>
                        <td className="px-3 py-2.5 text-[#2D1B0E]">
                          {r.qc_override_by || '—'}
                          {r.received_by ? (
                            <p className="text-[11px] text-[#8B7355] mt-0.5">Received by {r.received_by}</p>
                          ) : null}
                        </td>
                        <td className="px-3 py-2.5 text-[#2D1B0E] whitespace-nowrap">{istStamp(r.qc_override_at)}</td>
                        <td className="px-3 py-2.5 text-right text-[#2D1B0E]">{r.line_count ?? '—'}</td>
                        <td className="px-3 py-2.5 text-right text-[#2D1B0E] whitespace-nowrap">{money(r.inwarded_value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* The reasons, in full. Given their own block rather than a table
               * cell on purpose: this is the one field a person wrote by hand
               * under obligation, and a reason clipped to fit a column is the
               * same as no reason at all. */}
              <div className="border-t border-[#E8D5C4] bg-[#FDF8F3] px-3 py-3 space-y-2">
                <p className="text-[11px] uppercase tracking-wide text-[#8B7355]">Reasons given</p>
                {rows.map((r) => (
                  <p key={`${r.id}-reason`} className="text-[12px] text-[#2D1B0E] leading-relaxed">
                    <span className="font-medium">{r.grn_number || r.id.slice(0, 8)}</span>
                    <span className="text-[#8B7355]"> · {r.qc_override_by || 'unknown'} · </span>
                    {r.qc_override_reason
                      ? r.qc_override_reason
                      : <span className="text-amber-700">no reason recorded — this receipt predates the written-reason rule</span>}
                  </p>
                ))}
              </div>
            </div>
          )
        )}

        <p className="text-[11px] text-[#8B7355] leading-relaxed max-w-3xl">
          An override is recorded on the bill itself, in the same transaction that moves the stock, so
          this list cannot disagree with what was received. It is a record, not an approval queue —
          nothing here can be undone from this page, and the goods are already in stock.
        </p>
      </div>
    </div>
  );
}
