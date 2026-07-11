'use client';

/**
 * Daily Digest (/crm/digest) — the owner's AI morning briefing.
 *
 * Shows the stored digest for a chosen date (default today) rendered as
 * markdown-lite, with an explicit "Generate" button (LLM cost is only spent on
 * a tap — GET never auto-generates), WhatsApp share + copy, and a date picker
 * to read past digests.
 *
 * Client gate: admin or HOD (is_head_chef) — the digest quotes financial data.
 * The API enforces the same gate server-side. Warm theme, mobile-first.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle, ArrowLeft, Check, Copy, FileText, Loader2, RefreshCw, Share2,
  Sparkles, X,
} from 'lucide-react';
import { api } from '@/lib/api';

/* ── markdown-lite rendering (bold + line breaks + simple pipe tables) ──
   Same renderer style as /crm/analyst (kept local — it isn't exported). */

function boldParts(line: string, keyPrefix: string): React.ReactNode[] {
  const parts = line.split(/\*\*(.+?)\*\*/g);
  return parts.map((p, i) =>
    i % 2 === 1
      ? <strong key={`${keyPrefix}-${i}`} className="font-semibold">{p}</strong>
      : <span key={`${keyPrefix}-${i}`}>{p}</span>
  );
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-');
}

function splitCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map(c => c.trim());
}

function MarkdownLite({ text }: { text: string }) {
  const lines = text.split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith('|') && i + 1 < lines.length && lines[i + 1].trim().startsWith('|')) {
      const tbl: string[][] = [];
      let hasHeader = false;
      let j = i;
      while (j < lines.length && lines[j].trim().startsWith('|')) {
        if (isTableSeparator(lines[j])) { if (tbl.length === 1) hasHeader = true; }
        else tbl.push(splitCells(lines[j]));
        j++;
      }
      blocks.push(
        <div key={`t${key++}`} className="overflow-x-auto my-1.5">
          <table className="text-xs border-collapse">
            <tbody>
              {tbl.map((cells, ri) => (
                <tr key={ri} className={hasHeader && ri === 0 ? 'bg-[#FFF8F0] font-semibold' : ''}>
                  {cells.map((c, ci) => (
                    <td key={ci} className="border border-[#E8D5C4] px-2 py-1 whitespace-nowrap">
                      {boldParts(c, `t${key}-${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      i = j;
      continue;
    }
    const h = line.match(/^\s*#{1,6}\s+(.*)$/);
    blocks.push(
      <span key={`l${key++}`} className={h ? 'font-semibold' : undefined}>
        {i > 0 && <br />}
        {boldParts(h ? h[1] : line, `l${key}`)}
      </span>
    );
    i++;
  }
  return <>{blocks}</>;
}

function fmtStamp(iso: string | null): string {
  if (!iso) return '';
  try {
    const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('en-IN', {
      day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
    });
  } catch { return iso; }
}

const todayIso = () => new Date().toISOString().slice(0, 10);

interface DigestRow {
  content: string;
  generated_at: string | null;
}

export default function CrmDigestPage() {
  const router = useRouter();
  const [me, setMe] = useState<any>(undefined); // undefined = loading, null = signed out

  const [date, setDate] = useState<string>(todayIso());
  const [digest, setDigest] = useState<DigestRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  const allowed = !!me && (me.role === 'admin' || me.is_head_chef);
  const isToday = date === todayIso();

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.json())
      .then(d => setMe(d?.user ?? null))
      .catch(() => setMe(null));
  }, []);

  const load = useCallback((d: string) => {
    setLoading(true);
    setError(null);
    fetch(`/api/crm/digest?date=${encodeURIComponent(d)}`)
      .then(r => r.json())
      .then(j => {
        if (j.error) { setError(j.error); setDigest(null); return; }
        setDigest(j.exists ? { content: j.content, generated_at: j.generated_at } : null);
      })
      .catch(e => { setError(e?.message || 'Failed to load digest'); setDigest(null); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (allowed) load(date);
  }, [allowed, date, load]);

  /* 429 cooldown countdown */
  useEffect(() => {
    if (cooldown == null || cooldown <= 0) return;
    const t = setInterval(() => {
      setCooldown(c => {
        if (c == null || c <= 1) { clearInterval(t); return null; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  const generate = async () => {
    if (generating) return;
    setGenerating(true);
    setError(null);
    setCooldown(null);
    try {
      const r = await api('/api/crm/digest', { method: 'POST', body: { regenerate: true } });
      const j = await r.json().catch(() => ({}));
      if (r.status === 429) {
        setCooldown(Number(j.wait_seconds) || 30);
        return;
      }
      if (!r.ok) {
        setError(j.error || `HTTP ${r.status}`);
        return;
      }
      setDate(todayIso());          // jump back to today if viewing the past
      setDigest({ content: j.content || '', generated_at: j.generated_at || null });
    } catch (e: any) {
      setError(e?.message || 'Failed to generate digest');
    } finally {
      setGenerating(false);
    }
  };

  const copyDigest = async () => {
    if (!digest?.content) return;
    try {
      await navigator.clipboard.writeText(digest.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Copy failed — long-press to select the text instead.');
    }
  };

  /* ── gates ── */
  if (me === undefined) {
    return (
      <div className="p-8 text-center text-sm text-[#8B7355]">
        <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…
      </div>
    );
  }
  if (!allowed) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <button
          onClick={() => router.back()}
          className="inline-flex items-center gap-1 text-sm text-[#6B5744] hover:text-[#2D1B0E] transition-colors mb-3"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
          🔒 Admins and department heads only. The Daily Digest quotes financial data
          (sales, costs, margins) — ask an admin for access.
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-3xl mx-auto">
      {/* Header */}
      <div>
        <button
          onClick={() => router.back()}
          className="inline-flex items-center gap-1 text-sm text-[#6B5744] hover:text-[#2D1B0E] transition-colors mb-2"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-[#af4408] text-white flex items-center justify-center shrink-0">
            <FileText size={20} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl sm:text-2xl font-bold text-[#2D1B0E]">Daily Digest</h1>
            <p className="text-xs text-[#8B7355]">
              AI morning briefing — sales, food cost, stock, variances & approvals in ₹
            </p>
          </div>
        </div>
      </div>

      {/* Controls: date picker + generate */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs text-[#6B5744] bg-white border border-[#E8D5C4] rounded-lg px-3 py-2">
          Date
          <input
            type="date"
            value={date}
            max={todayIso()}
            onChange={e => e.target.value && setDate(e.target.value)}
            className="bg-transparent text-sm text-[#2D1B0E] focus:outline-none"
          />
        </label>
        {isToday && (
          <button
            onClick={generate}
            disabled={generating || cooldown != null}
            className="inline-flex items-center gap-1.5 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg px-3.5 py-2"
          >
            {generating
              ? <><Loader2 size={15} className="animate-spin" /> Writing your briefing…</>
              : <><Sparkles size={15} /> {digest ? 'Regenerate' : "Generate today's digest"}</>}
          </button>
        )}
        {digest && (
          <>
            <a
              href={`https://wa.me/?text=${encodeURIComponent(`AKAN Daily Digest — ${date}\n\n${digest.content}`)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 bg-[#25D366] hover:bg-[#1eb257] text-white text-sm font-medium rounded-lg px-3.5 py-2"
            >
              <Share2 size={15} /> WhatsApp
            </a>
            <button
              onClick={copyDigest}
              className="inline-flex items-center gap-1.5 bg-white border border-[#E8D5C4] hover:border-[#af4408] text-[#2D1B0E] text-sm rounded-lg px-3.5 py-2"
            >
              {copied ? <><Check size={15} className="text-green-600" /> Copied</> : <><Copy size={15} /> Copy</>}
            </button>
          </>
        )}
      </div>

      {/* Cooldown / error banners */}
      {cooldown != null && (
        <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-lg px-3 py-2">
          <AlertCircle size={15} className="shrink-0" />
          AI is cooling down, retry in {cooldown}s
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2">
          <AlertCircle size={15} className="shrink-0" />
          <span className="flex-1 break-words">{error}</span>
          <button onClick={() => setError(null)} className="shrink-0 p-0.5 hover:opacity-70" aria-label="Dismiss error">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Digest card */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-10 flex items-center justify-center text-[#8B7355] text-sm">
            <Loader2 size={20} className="animate-spin mr-2" /> Loading digest…
          </div>
        ) : digest ? (
          <>
            <div className="px-4 sm:px-5 py-2.5 border-b border-[#E8D5C4] bg-[#FFF8F0] flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-sm font-semibold text-[#2D1B0E]">{date}</span>
              {digest.generated_at && (
                <span className="text-[11px] text-[#8B7355]">
                  Generated {fmtStamp(digest.generated_at)}
                </span>
              )}
            </div>
            <div className="px-4 sm:px-5 py-4 text-sm text-[#2D1B0E] leading-relaxed break-words">
              <MarkdownLite text={digest.content} />
            </div>
          </>
        ) : (
          <div className="p-10 flex flex-col items-center justify-center text-center gap-3">
            <div className="w-14 h-14 rounded-full bg-[#FFF8F0] border border-[#E8D5C4] flex items-center justify-center">
              <FileText size={26} className="text-[#af4408]" />
            </div>
            <div className="text-sm font-semibold text-[#2D1B0E]">
              {isToday ? 'No digest yet for today' : `No digest was generated on ${date}`}
            </div>
            <p className="text-xs text-[#8B7355] max-w-xs">
              {isToday
                ? 'Tap the button above and the AI will write your morning briefing from live data.'
                : 'Digests are only stored when someone generated one that day.'}
            </p>
            {!isToday && (
              <button
                onClick={() => setDate(todayIso())}
                className="inline-flex items-center gap-1.5 text-sm text-[#af4408] hover:underline"
              >
                <RefreshCw size={14} /> Jump to today
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
