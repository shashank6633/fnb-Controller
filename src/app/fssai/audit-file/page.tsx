'use client';

/**
 * THE ONE AUDIT FILE (/fssai/audit-file) — management only.
 *
 * The Hyderabad Food Safety Authority's section "Records You Should Keep Ready
 * in One Audit File": all 20 lines, in the authority's order and wording, each
 * PRESENT, EXPIRING or MISSING with the reason and a link to the real record.
 * The point is to know BEFORE the inspector arrives, so anything not PRESENT
 * leads the page in red or amber and its card is coloured to match.
 *
 * Every status comes from buildAuditFile() (src/app/api/fssai/audit-file/lib.ts),
 * the same function the PDF is drawn from — the screen and the paper cannot
 * disagree.
 *
 * TWO PDFs, ONE BUTTON TO HAND OVER. The audit-file PDF holds what is on file,
 * stated as facts, and says nothing about gaps (Inspection Mode's rule, §7 Q11),
 * so it is the one to print or give the inspector. The management copy has all
 * 20 with their status, and says on every page that it is not for handing over.
 * This page itself names every gap, so it is never the screen handed over.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle, CheckCircle2, Clock, Download, ExternalLink, FileWarning, FolderCheck, ImageIcon, Loader2, RefreshCw, XCircle,
} from 'lucide-react';
import { apiJson } from '@/lib/api';
import type { AuditFile, AuditFileItem, AuditFileStatus, AuditFileTable } from '@/app/api/fssai/audit-file/lib';

interface Payload extends AuditFile {
  business_name: string;
  pdf: { includes: number[]; leaves_out: number[] };
  generated_at: string;
}

const STATUS: Record<AuditFileStatus, { word: string; badge: string; card: string; bar: string; icon: typeof CheckCircle2; ink: string }> = {
  missing: {
    word: 'MISSING', badge: 'bg-red-600 text-white border-red-700', card: 'bg-red-50 border-red-300',
    bar: 'bg-red-600', icon: XCircle, ink: 'text-red-800',
  },
  expiring: {
    word: 'EXPIRING', badge: 'bg-amber-500 text-white border-amber-600', card: 'bg-amber-50 border-amber-300',
    bar: 'bg-amber-500', icon: Clock, ink: 'text-amber-900',
  },
  present: {
    word: 'PRESENT', badge: 'bg-green-700 text-white border-green-800', card: 'bg-white border-[#E8D5C4]',
    bar: 'bg-green-700', icon: CheckCircle2, ink: 'text-green-800',
  },
};

const FIELD = 'bg-white border border-[#D4B896] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]';
const DAY_CHOICES = [7, 30, 90];

export default function FssaiAuditFilePage() {
  const [data, setData] = useState<Payload | null>(null);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      setData(await apiJson<Payload>(`/api/fssai/audit-file?days=${days}`));
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e || '');
      if (m.includes('management only')) setForbidden(true);
      else setErr(m || 'Could not assemble the audit file');
    } finally { setLoading(false); }
  }, [days]);
  useEffect(() => { load(); }, [load]);

  if (forbidden) {
    return (
      <Shell>
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
          🔒 This page is restricted to management. Ask an administrator for access.
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-[#af4408] text-white flex items-center justify-center shrink-0">
          <FolderCheck size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408]">Audit File</h1>
          <p className="text-xs text-[#8B7355]">
            The 20 records the Hyderabad Food Safety Authority asks you to keep ready in one audit file — in its order and
            its words — and whether each one would satisfy the inspector today.
          </p>
        </div>
        <button
          onClick={load} disabled={loading}
          className="inline-flex items-center gap-1.5 text-sm border border-[#E8D5C4] bg-white rounded-lg px-3 py-2 hover:bg-[#FFF1E3] disabled:opacity-50"
        >
          {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Refresh
        </button>
      </div>

      {err && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">{err}</div>}
      {loading && !data && (
        <div className="bg-white rounded-xl border border-[#E8D5C4] p-10 text-center text-sm text-[#8B7355]">
          <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" /> Checking all 20 records&hellip;
        </div>
      )}

      {data && (
        <>
          <Readiness data={data} />

          {/* ── the PDF ─────────────────────────────────────────────────── */}
          <div className="bg-white rounded-xl border border-[#E8D5C4] p-4 space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <label className="block">
                <span className="text-xs text-[#6B5744]">Running logs to include</span>
                <select value={days} onChange={(e) => setDays(Number(e.target.value))} className={`mt-1 block ${FIELD}`}>
                  {DAY_CHOICES.map((d) => <option key={d} value={d}>The last {d} days</option>)}
                </select>
              </label>
              <a
                href={`/api/fssai/audit-file/pdf?days=${data.days}`}
                target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-sm font-semibold bg-[#af4408] hover:bg-[#8a3606] text-white rounded-lg px-4 py-2 min-h-[44px]"
              >
                <Download size={16} /> Download the audit file (PDF)
              </a>
              <a
                href={`/api/fssai/audit-file/pdf?days=${data.days}&copy=readiness`}
                target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm border border-[#E8D5C4] bg-white rounded-lg px-3 py-2 min-h-[44px] hover:bg-[#FFF1E3]"
              >
                <FileWarning size={15} /> Management copy, gaps marked
              </a>
            </div>
            <p className="text-xs text-[#6B5744]">
              The audit file PDF is the one to print or hand the inspector: one section per record, under the
              authority&apos;s number, with the copies of the licences and certificates on file and the logs from{' '}
              {data.since} to {data.today}. It states what is on file and says nothing about what is not.
              The management copy has all 20 with their status — it is for you, not the inspector.
            </p>
            {data.pdf.leaves_out.length > 0 && (
              <p className="text-xs font-semibold text-red-800">
                Not in the audit file PDF until something is filed ({data.pdf.leaves_out.length}):{' '}
                {data.pdf.leaves_out.map((n) => {
                  const it = data.items.find((x) => x.n === n);
                  return it ? `${n}. ${it.title}` : String(n);
                }).join(' · ')}
              </p>
            )}
          </div>

          {/* ── the 20 records ─────────────────────────────────────────── */}
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-[#8B7355]">{data.section}</p>
            <p className="text-xs text-[#8B7355] mt-0.5">
              Numbered and worded as on the authority&apos;s checklist. Checked against today, {data.today}.
            </p>
          </div>
          <div className="space-y-3">
            {data.items.map((it) => <RecordCard key={it.n} it={it} />)}
          </div>

          <p className="text-xs text-[#8B7355]">
            A document counts only with a copy of it attached — the inspector asks for the licence, not its number. Voided
            records and drafts never count. Every status is worked out again each time this page or the PDF is opened;
            nothing is stored. Records are read across all outlets together, as on the Reports screen.
          </p>
        </>
      )}
    </Shell>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
 * THE READINESS PANEL — missing and expiring, impossible to overlook
 * ══════════════════════════════════════════════════════════════════════════ */

function Readiness({ data }: { data: Payload }) {
  const missing = data.items.filter((i) => i.status === 'missing');
  const expiring = data.items.filter((i) => i.status === 'expiring');
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        <Tile n={data.counts.missing} label="Missing" tone="missing" />
        <Tile n={data.counts.expiring} label="Expiring" tone="expiring" />
        <Tile n={data.counts.present} label="Present" tone="present" />
      </div>

      {missing.length > 0 && (
        <div role="alert" className="rounded-xl border-2 border-red-600 bg-red-50 p-4">
          <p className="flex items-center gap-2 font-bold text-red-800">
            <XCircle className="w-5 h-5 shrink-0" />
            {missing.length} of 20 record{missing.length === 1 ? '' : 's'} would fail if the inspector asked today
          </p>
          <ul className="mt-2 space-y-1.5">
            {missing.map((i) => (
              <li key={i.n} className="text-sm">
                <a href={`#rec-${i.n}`} className="font-semibold text-red-900 underline underline-offset-2">{i.n}. {i.title}</a>
                <span className="text-red-800"> — {i.problems[0] || 'not on file'}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {expiring.length > 0 && (
        <div className="rounded-xl border-2 border-amber-500 bg-amber-50 p-4">
          <p className="flex items-center gap-2 font-bold text-amber-900">
            <AlertTriangle className="w-5 h-5 shrink-0" />
            {expiring.length} record{expiring.length === 1 ? '' : 's'} about to lapse
          </p>
          <ul className="mt-2 space-y-1.5">
            {expiring.map((i) => (
              <li key={i.n} className="text-sm">
                <a href={`#rec-${i.n}`} className="font-semibold text-amber-950 underline underline-offset-2">{i.n}. {i.title}</a>
                <span className="text-amber-900"> — {i.problems[0] || ''}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!missing.length && !expiring.length && (
        <div className="rounded-xl border-2 border-green-700 bg-green-50 p-4 flex items-center gap-2 font-bold text-green-800">
          <CheckCircle2 className="w-5 h-5 shrink-0" /> All 20 records are in the file and in date.
        </div>
      )}
    </div>
  );
}

function Tile({ n, label, tone }: { n: number; label: string; tone: AuditFileStatus }) {
  const st = STATUS[tone];
  const loud = n > 0 && tone !== 'present';
  return (
    <div className={`rounded-xl border p-3 ${loud ? st.card : 'bg-white border-[#E8D5C4]'}`}>
      <p className={`text-[11px] font-bold uppercase tracking-wider ${loud ? st.ink : 'text-[#8B7355]'}`}>{label}</p>
      <p className={`text-3xl font-bold mt-0.5 ${loud ? st.ink : tone === 'present' && n ? 'text-green-800' : 'text-[#2D1B0E]'}`}>
        {n}<span className="text-sm font-semibold text-[#8B7355]"> / 20</span>
      </p>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
 * ONE RECORD
 * ══════════════════════════════════════════════════════════════════════════ */

function RecordCard({ it }: { it: AuditFileItem }) {
  const st = STATUS[it.status];
  const Icon = st.icon;
  return (
    <section id={`rec-${it.n}`} className={`relative rounded-xl border overflow-hidden scroll-mt-4 ${st.card}`}>
      <div className={`absolute left-0 top-0 bottom-0 w-1.5 ${st.bar}`} aria-hidden />
      <div className="pl-5 pr-4 py-3 space-y-2.5">
        <div className="flex flex-wrap items-start gap-2">
          <span className="w-7 h-7 rounded-full bg-[#2D1B0E] text-white text-xs font-bold flex items-center justify-center shrink-0">{it.n}</span>
          <h2 className="font-bold text-base sm:text-lg leading-snug min-w-0 flex-1">{it.title}</h2>
          <span className={`inline-flex items-center gap-1 text-xs font-bold tracking-wider border rounded-md px-2 py-1 shrink-0 ${st.badge}`}>
            <Icon size={13} /> {st.word}
          </span>
        </div>
        <p className="text-sm text-[#3D2614]">{it.headline}</p>

        {it.problems.length > 0 && (
          <ul className={`space-y-1 text-sm ${st.ink}`}>
            {it.problems.map((p, i) => (
              <li key={i} className="flex gap-1.5"><span aria-hidden>•</span><span className="min-w-0">{p}</span></li>
            ))}
          </ul>
        )}
        {it.todo && (
          <p className="text-sm"><span className="font-semibold">To close it:</span> {it.todo}</p>
        )}

        {it.summary.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {it.summary.map((x, i) => (
              <span key={i} className="text-xs bg-white/70 border border-[#E8D5C4] rounded-md px-2 py-1">
                <span className="text-[#8B7355]">{x.label}:</span> <span className="font-semibold">{x.value || '—'}</span>
              </span>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {it.links.map((l) => (
            <Link
              key={l.href} href={l.href}
              className="inline-flex items-center gap-1 text-xs font-semibold border border-[#E8D5C4] bg-white rounded-lg px-2.5 py-1.5 min-h-[36px] hover:border-[#af4408]"
            >
              <ExternalLink size={12} /> {l.label}
            </Link>
          ))}
        </div>

        {it.scans.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {it.scans.slice(0, 12).map((sc) => sc.has_image ? (
              <a
                key={sc.attachment_id}
                href={`/api/fssai/audit-file/file?id=${encodeURIComponent(sc.attachment_id)}`}
                target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs border border-[#E8D5C4] bg-white rounded-lg px-2.5 py-1.5 hover:border-[#af4408] max-w-full"
              >
                <ImageIcon size={12} className="shrink-0" /> <span className="truncate">View copy: {sc.record_label}</span>
              </a>
            ) : (
              <span key={sc.attachment_id} className="inline-flex items-center gap-1 text-xs border border-red-200 bg-red-50 text-red-800 rounded-lg px-2.5 py-1.5 max-w-full">
                <ImageIcon size={12} className="shrink-0" />
                <span className="truncate">{sc.record_label}: image removed{sc.image_dropped_at ? ` ${sc.image_dropped_at.slice(0, 10)}` : ''}</span>
              </span>
            ))}
            {it.scans.length > 12 && <span className="text-xs text-[#8B7355] self-center">+{it.scans.length - 12} more</span>}
          </div>
        )}

        {it.tables.map((t, i) => <MiniTable key={i} t={t} />)}

        <details className="text-xs text-[#6B5744]">
          <summary className="cursor-pointer select-none">How this is judged</summary>
          <p className="mt-1">{it.basis}</p>
        </details>
      </div>
    </section>
  );
}

function MiniTable({ t }: { t: AuditFileTable }) {
  if (!t.rows.length) {
    return <p className="text-xs text-[#8B7355]"><span className="font-semibold">{t.title}:</span> {t.empty}</p>;
  }
  return (
    <div>
      <p className="text-xs font-semibold text-[#6B5744]">{t.title}</p>
      <div className="overflow-x-auto mt-1 bg-white rounded-lg border border-[#E8D5C4]">
        <table className="w-full text-xs">
          <thead className="text-[#6B5744] bg-[#FFF1E3]">
            <tr>
              {t.columns.map((c, i) => (
                <th key={i} className={`font-semibold px-2 py-1.5 whitespace-nowrap ${c.align === 'right' ? 'text-right' : 'text-left'}`}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[#E8D5C4]">
            {t.rows.map((r, ri) => (
              <tr key={ri} className={r.tone === 'bad' ? 'bg-red-50 text-red-900' : r.tone === 'warn' ? 'bg-amber-50 text-amber-950' : ''}>
                {r.cells.map((c, ci) => (
                  <td key={ci} className={`px-2 py-1.5 ${t.columns[ci]?.align === 'right' ? 'text-right' : 'text-left'} ${ci === 0 ? 'whitespace-nowrap' : ''}`}>
                    {ci === 0 && r.href ? <Link href={r.href} className="underline underline-offset-2">{c || '—'}</Link> : c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {t.more > 0 && <p className="text-[11px] text-[#8B7355] mt-1">…and {t.more} more in this period, listed in the PDF and on the record&apos;s own screen.</p>}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-5">{children}</div>
    </div>
  );
}
