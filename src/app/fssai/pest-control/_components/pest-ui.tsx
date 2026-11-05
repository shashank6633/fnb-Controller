'use client';

/**
 * The small UI pieces every tab of Pest Control Logs shares — moved out of
 * page.tsx so the monitoring sheet and the print views use the SAME modal, badge
 * and file tile as the rest of the screen (a page.tsx may only export its
 * default, so they could not be imported from there).
 *
 * House idiom (RECON §1.3-1.6): #FFF8F0 page, #af4408 accents, white cards
 * bordered #E8D5C4. ⚠️ globals.css force-wraps any `.flex.gap-2|3|4`, so a row
 * that must keep its icon beside its text carries `flex-nowrap`; a modal overlay
 * MUST use a `bg-black/NN` class or globals.css will not lock the page scroll.
 */

import { useEffect, useState } from 'react';
import { Ban, Loader2, Printer, Wrench, X } from 'lucide-react';
import { apiJson } from '@/lib/api';
import { fmtIST } from '@/lib/format-date';
import { FSSAI_CA_SEVERITIES } from '@/lib/fssai';
import ImageUpload, { ImageThumb } from '@/app/tasks/_components/ImageUpload';

/** The server's own sentence for a failed call, or a fallback. */
export function errMsg(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

export const INPUT =
  'mt-1 w-full bg-white border border-[#D4B896] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]';
export const BTN_PRIMARY =
  'inline-flex flex-nowrap items-center gap-1.5 text-sm font-semibold bg-[#af4408] hover:bg-[#8a3606] text-white rounded-lg px-3 py-2 disabled:opacity-50';
export const BTN_PLAIN =
  'inline-flex flex-nowrap items-center gap-1.5 text-sm border border-[#E8D5C4] bg-white rounded-lg px-3 py-2 hover:bg-[#FFF1E3] disabled:opacity-50';
export const BTN_DANGER =
  'inline-flex flex-nowrap items-center gap-1.5 text-sm border border-red-200 text-red-700 bg-white rounded-lg px-3 py-2 hover:bg-red-50 disabled:opacity-50';
export const CARD = 'bg-white rounded-xl border border-[#E8D5C4]';
export const LABEL = 'text-xs text-[#6B5744]';
export const REQ = <span className="text-[#af4408]">*</span>;

export function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span className={`inline-flex flex-nowrap items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full border ${color}`}>
      {label}
    </span>
  );
}

export function Tile({ n, label, tone = 'plain' }: { n: number; label: string; tone?: 'plain' | 'good' | 'warn' | 'bad' }) {
  const colour =
    tone === 'bad' ? 'text-red-700' : tone === 'warn' ? 'text-amber-700' : tone === 'good' ? 'text-green-700' : 'text-[#2D1B0E]';
  return (
    <div className={`${CARD} p-3`}>
      <p className={`text-2xl font-bold ${colour}`}>{n}</p>
      <p className="text-[11px] text-[#8B7355]">{label}</p>
    </div>
  );
}

export function Field({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-[11px] text-[#8B7355]">{k}</dt>
      <dd className="text-sm">{v}</dd>
    </div>
  );
}

export function Para({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <p className="text-[11px] text-[#8B7355]">{k}</p>
      <p className="text-sm whitespace-pre-wrap">{v}</p>
    </div>
  );
}

/**
 * The house "safe modal" plus role="dialog", aria-modal and Escape. On a phone it
 * is a BOTTOM SHEET — the thumb is already there.
 */
export function Modal({
  title, onClose, children, footer, wide,
}: {
  title: string; onClose: () => void; children: React.ReactNode;
  footer?: React.ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-[110] bg-black/40 flex items-end sm:items-center justify-center sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className={`bg-white border border-[#E8D5C4] w-full ${wide ? 'sm:max-w-4xl' : 'sm:max-w-2xl'} shadow-xl flex flex-col overflow-hidden rounded-t-3xl sm:rounded-xl max-h-[88vh] sm:max-h-[90vh]`}
      >
        <div className="px-4 py-3 border-b border-[#E8D5C4] flex flex-nowrap items-center justify-between gap-2 shrink-0">
          <h2 className="font-bold text-[#2D1B0E] min-w-0 truncate">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="w-9 h-9 rounded-lg hover:bg-[#FFF1E3] shrink-0">
            <X size={16} className="mx-auto" />
          </button>
        </div>
        <div className="p-4 space-y-4 overflow-y-auto">{children}</div>
        {footer && (
          <div className="px-4 py-3 border-t border-[#E8D5C4] flex flex-wrap justify-end gap-2 shrink-0">{footer}</div>
        )}
      </div>
    </div>
  );
}

/* ── FILES ─────────────────────────────────────────────────────────────────── */

export interface FileRow {
  id: string; kind: string; kind_label: string; data_uri: string; has_image: boolean;
  filename: string; caption: string; size_bytes: number; image_dropped_at: string;
  status?: string; is_void?: boolean; voided_at?: string; voided_by?: string; void_reason?: string;
  created_by: string; created_at: string;
}

/**
 * The files on one record. A wrong file is VOIDED, never removed: it stays here,
 * greyed and stamped VOID with its reason, because on a food-safety record the
 * file that was there is part of the record (decision in
 * src/app/api/fssai/pest/_pest/files.ts). A voided file stops counting towards
 * the limit so the right one can be attached beside it.
 */
export function Files({
  files, limit, onAdd, onVoid, canAdd, canVoid, busy,
}: {
  files: FileRow[]; limit: number;
  onAdd: (dataUri: string) => void; onVoid: (id: string) => void;
  canAdd: boolean; canVoid: boolean; busy: boolean;
}) {
  const active = files.filter((f) => !f.is_void).length;
  const voided = files.length - active;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start gap-3">
        {files.map((f) => {
          return (
            <div key={f.id} className="w-20">
              <div className="relative">
                <div className={f.is_void ? 'opacity-40 grayscale' : ''}>
                  {f.has_image && f.data_uri ? (
                    <ImageThumb src={f.data_uri} alt={f.filename || f.kind_label} size={64} />
                  ) : (
                    <div
                      className="w-16 h-16 rounded-lg border border-[#E8D5C4] bg-[#FFF1E3] flex items-center justify-center text-[10px] text-center text-[#8B7355] px-1"
                      title={f.image_dropped_at ? `Image removed ${fmtIST(f.image_dropped_at)} by an earlier version of this screen. The record of it remains.` : f.filename}
                    >
                      {f.image_dropped_at ? 'image removed (earlier build)' : f.has_image ? 'open the record to view' : 'no image'}
                    </div>
                  )}
                </div>
                {f.is_void && (
                  <span className="absolute top-5 left-0 w-16 text-center text-[10px] font-bold tracking-wider text-red-700 bg-white/90 border border-red-300 rounded">
                    VOID
                  </span>
                )}
                {canVoid && !f.is_void && (
                  <button
                    onClick={() => onVoid(f.id)}
                    disabled={busy}
                    aria-label="Void this file"
                    title="Void this file — it stays on the record, marked, with your reason"
                    className="absolute -top-1.5 right-2 w-6 h-6 rounded-full bg-white border border-[#E8D5C4] shadow text-red-600"
                  >
                    <Ban size={11} className="mx-auto" />
                  </button>
                )}
              </div>
              {f.is_void && (
                <p className="text-[10px] text-red-800 mt-1 leading-tight" title={`${f.void_reason} — ${f.voided_by}, ${fmtIST(f.voided_at || '')}`}>
                  {f.void_reason}
                </p>
              )}
            </div>
          );
        })}
        {canAdd && active < limit && (
          <ImageUpload value={[]} onAdd={onAdd} label="Add photo" disabled={busy} thumbSize={64} />
        )}
      </div>
      <p className="text-[11px] text-[#8B7355]">
        {active} of {limit} files{voided ? ` · ${voided} voided (kept, marked)` : ''}. A wrong file is voided with a reason, never
        removed — it stays here, marked VOID. A file is voided by somebody other than the person who attached it (an administrator excepted).
      </p>
    </div>
  );
}

/* ── PRINT ─────────────────────────────────────────────────────────────────── */

/**
 * A print preview over the whole screen. While it is open it is the ONLY thing
 * that reaches paper: everything else on the page is hidden by visibility (so
 * the app's sidebar is not printed either), and the sheet is laid out at the
 * top of the first page. The same pattern as the roster print sheet.
 */
export function PrintOverlay({
  title, onClose, children, landscape,
}: { title: string; onClose: () => void; children: React.ReactNode; landscape?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="pest-print-root fixed inset-0 z-[130] bg-black/40 overflow-auto print:static print:bg-white">
      <style>{`
        @media print {
          @page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: 10mm }
          body * { visibility: hidden !important; }
          .pest-print-sheet, .pest-print-sheet * { visibility: visible !important; }
          .pest-print-sheet { position: absolute !important; left: 0; top: 0; width: 100%; box-shadow: none !important; border: 0 !important; margin: 0 !important; padding: 0 !important; }
          .pest-print-sheet table { page-break-inside: auto; }
          .pest-print-sheet tr { page-break-inside: avoid; }
        }
      `}</style>
      <div className="print:hidden sticky top-0 z-10 bg-[#FFF8F0] border-b border-[#E8D5C4] px-4 py-3 flex flex-wrap items-center gap-3">
        <span className="font-semibold text-[#2D1B0E]">Print preview — {title}</span>
        <div className="flex-1" />
        <button onClick={() => window.print()} className={BTN_PRIMARY}><Printer size={15} /> Print</button>
        <button onClick={onClose} className={BTN_PLAIN}><X size={15} /> Close</button>
      </div>
      <div className="pest-print-sheet bg-white text-black max-w-[1100px] mx-auto my-4 p-6 shadow-lg text-[12px] leading-snug">
        {children}
      </div>
    </div>
  );
}

/** A print table cell class — bordered, compact, legible on paper. */
export const PT = 'border border-gray-400 px-1.5 py-1 align-top text-left';
export const PTH = 'border border-gray-500 px-1.5 py-1 align-bottom text-left font-semibold bg-gray-100';

/* ── RAISING A CORRECTIVE ACTION ───────────────────────────────────────────── */

interface UsersResponse { users?: { email?: string; name?: string }[] }

/**
 * Raising a corrective action asks for an OWNER and never guesses one. An action
 * with nobody's name on it is the inert row this project has been bitten by four
 * times, so the server refuses a blank owner and this form will not submit one.
 */
export function RaiseCaForm({
  busy, defaultTitle, defaultSeverity, onCancel, onSubmit, note,
}: {
  busy: boolean; defaultTitle: string; defaultSeverity: string;
  onCancel: () => void;
  onSubmit: (p: { title: string; owner_email: string; severity: string; description: string }) => void;
  note?: string;
}) {
  const [title, setTitle] = useState(defaultTitle);
  const [severity, setSeverity] = useState(defaultSeverity);
  const [owner, setOwner] = useState('');
  const [description, setDescription] = useState('');
  const [users, setUsers] = useState<{ email: string; name: string }[]>([]);

  useEffect(() => {
    // /api/tasks/users is the house people list (RECON §1.2). FSSAI never builds
    // a second employee master.
    (async () => {
      try {
        const j = await apiJson<UsersResponse>('/api/tasks/users');
        setUsers((j.users || []).map((u) => ({ email: String(u.email || ''), name: String(u.name || u.email || '') })));
      } catch { /* the picker degrades to empty; the server validates the owner */ }
    })();
  }, []);

  return (
    <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg p-3 space-y-3">
      <p className="text-sm font-semibold">Raise a corrective action</p>
      <label className="block">
        <span className={LABEL}>What has to be done {REQ}</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} className={INPUT} />
      </label>
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block">
          <span className={LABEL}>Who will deal with it {REQ}</span>
          <select value={owner} onChange={(e) => setOwner(e.target.value)} className={INPUT}>
            <option value="">Choose somebody</option>
            {users.map((u) => <option key={u.email} value={u.email}>{u.name}</option>)}
          </select>
        </label>
        <label className="block">
          <span className={LABEL}>How serious</span>
          <select value={severity} onChange={(e) => setSeverity(e.target.value)} className={INPUT}>
            {FSSAI_CA_SEVERITIES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </label>
      </div>
      <label className="block">
        <span className={LABEL}>Anything to add</span>
        <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} className={INPUT} />
      </label>
      <p className="text-[11px] text-[#6B5744]">
        {note || 'The due date is set from the severity. The record itself does not change — the fix hangs off it, and closing the fix never makes the record read as if nothing happened.'}
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <button onClick={onCancel} className={BTN_PLAIN}>Cancel</button>
        <button
          disabled={busy || !owner || title.trim().length < 4}
          onClick={() => onSubmit({ title, owner_email: owner, severity, description })}
          className={BTN_PRIMARY}
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Wrench size={15} />} Raise it
        </button>
      </div>
    </div>
  );
}

/** Ask for a reason in words; null when the person cancelled or gave too little. */
export function askReason(question: string, say: (m: string) => void): string | null {
  const reason = window.prompt(question) || '';
  if (reason.trim().length < 4) {
    if (reason) say('A reason of at least four characters is needed.');
    return null;
  }
  return reason.trim();
}
