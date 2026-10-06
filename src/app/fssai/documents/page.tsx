'use client';

/**
 * DOCUMENTS AND CERTIFICATES (owner §17) — the cupboard an inspector opens first.
 *
 * ── THE ONE THING THIS SCREEN IS FOR ────────────────────────────────────────
 * Somebody is standing in front of you asking for the licence. This screen has to
 * produce it in two taps, and it has to be honest about what has lapsed — because
 * the alternative is a manager confidently handing over a certificate that
 * expired in March.
 *
 * So the screen opens with four counts (EXPIRED, expiring, valid, no expiry) and
 * the list is sorted by expiry date with the blanks LAST. Every one of those
 * states is DERIVED on the server on every single read, never stored: a stored
 * 'expiring' goes stale at midnight with nothing to wake it, and a licence
 * rendering "Valid" the day after it lapsed is the worst row this module could
 * print.
 *
 * ── THE TWO THINGS IT SAYS OUT LOUD RATHER THAN IMPLYING ────────────────────
 *  1. NOTHING SENDS A REMINDER YET. The window is stored per document and the
 *     state is live, but no job wakes up to tell anybody — §7 Q7 is unruled and
 *     the sweep is a later phase. A screen that showed "expiring soon" without
 *     saying that would be read as "I will be warned", which is exactly how a
 *     licence lapses.
 *  2. RENEWING DOES NOT OVERWRITE. It files a NEW version that points at the old
 *     one, and the old row stays, so "were we covered in March" has an answer.
 *     The renewal form refuses an expiry date that is not later than the one it
 *     replaces, because that typo is indistinguishable from a lapse.
 *
 * ── ACCESS ──────────────────────────────────────────────────────────────────
 * Management, not admin, deliberately — admin-only would mean nobody can produce
 * the licence unless the owner is in the building. The API enforces it (the page
 * catalog is visibility, never security), and a staff phone gets the house
 * permission panel rather than an empty screen.
 *
 * House idiom per RECON §1.3-1.6. ⚠️ globals.css:279-283 force-wraps any
 * `.flex.gap-2|3|4`, so icon-beside-text rows carry `flex-nowrap`; a modal
 * overlay must use a `bg-black/NN` class or the page scrolls behind it.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, BadgeCheck, CalendarClock, Check, FileText, Info, Loader2,
  Plus, RefreshCw, RotateCw, Search, Trash2, X,
} from 'lucide-react';
import { apiJson } from '@/lib/api';
import { fmtIST, fmtISTDate } from '@/lib/format-date';
import ImageUpload, { ImageThumb } from '@/app/tasks/_components/ImageUpload';
import { FSSAI_DOC_TYPES, FSSAI_DOC_REMINDER_DAYS } from '@/lib/fssai';

/* ── shapes ───────────────────────────────────────────────────────────────── */

interface FileRow {
  id: string; kind: string; kind_label: string; data_uri: string; has_image: boolean;
  filename: string; caption: string; size_bytes: number; image_dropped_at: string;
  created_by: string; created_at: string;
}
interface Doc {
  id: string; doc_code: string; doc_type: string; doc_type_label: string;
  doc_scope: 'outlet' | 'vendor' | 'person' | 'equipment';
  title: string; reference_no: string; issuer: string;
  issued_on: string; valid_from: string; expiry_date: string;
  reminder_days: number; last_reminder_at: string;
  state: string; state_label: string; state_color: string;
  days_to_expiry: number | null;
  owner_email: string; department_id: string; department_name: string;
  vendor_id: string; vendor_name: string; person_email: string; equipment_id: string;
  supersedes_id: string;
  supersedes: { id: string; title: string; expiry_date: string; reference_no: string } | null;
  superseded_by_id: string; version: number; notes: string;
  status: string; status_label: string; is_active: boolean;
  voided_at: string; voided_by: string; void_reason: string;
  created_by: string; created_at: string; updated_at: string;
  file_count: number; files: FileRow[]; file_limit: number; is_editable: boolean;
}
interface Counts { expired: number; expiring: number; valid: number; no_expiry: number; all: number }

const INPUT =
  'mt-1 w-full bg-white border border-[#D4B896] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]';
const BTN_PRIMARY =
  'inline-flex flex-nowrap items-center gap-1.5 text-sm font-semibold bg-[#af4408] hover:bg-[#8a3606] text-white rounded-lg px-3 py-2 disabled:opacity-50';
const BTN_PLAIN =
  'inline-flex flex-nowrap items-center gap-1.5 text-sm border border-[#E8D5C4] bg-white rounded-lg px-3 py-2 hover:bg-[#FFF1E3] disabled:opacity-50';
const CARD = 'bg-white rounded-xl border border-[#E8D5C4]';
const LABEL = 'text-xs text-[#6B5744]';
const REQ = <span className="text-[#af4408]">*</span>;
const ZERO: Counts = { expired: 0, expiring: 0, valid: 0, no_expiry: 0, all: 0 };

/** An older version of a document, as the chain returns it. */
interface ChainRow {
  id: string; title: string; reference_no: string; issued_on: string;
  valid_from: string; expiry_date: string; version: number;
  is_active: number; voided_at: string;
}
interface DocListResponse {
  documents: Doc[]; counts: Counts; can_void: boolean; truncated: boolean;
}
interface DocOneResponse { document: Doc; chain: ChainRow[] }
interface DocSaveResponse { document?: Doc; advice?: string }
interface VendorsResponse { vendors?: { id: string; name: string }[]; rows?: { id: string; name: string }[] }
interface UsersResponse { users?: { email?: string; name?: string }[] }
interface MastersResponse { equipment?: { id?: string; name?: string }[] }

/**
 * The server's own sentence for a failed call, or a fallback.
 *
 * apiJson throws an Error carrying `.error` from the response body, which is
 * written for a restaurant manager rather than a developer (RECON §2.3) — so the
 * message is shown as it arrives and only replaced when there is none.
 */
function errMsg(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span className={`inline-flex flex-nowrap items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full border ${color}`}>
      {label}
    </span>
  );
}

function Modal({
  title, onClose, children, footer, wide,
}: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[110] bg-black/40 flex items-end sm:items-center justify-center sm:p-4" onClick={onClose}>
      <div
        role="dialog" aria-modal="true" aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className={`bg-white border border-[#E8D5C4] w-full ${wide ? 'sm:max-w-3xl' : 'sm:max-w-2xl'} shadow-xl flex flex-col overflow-hidden rounded-t-3xl sm:rounded-xl max-h-[88vh] sm:max-h-[90vh]`}
      >
        <div className="px-4 py-3 border-b border-[#E8D5C4] flex flex-nowrap items-center justify-between gap-2 shrink-0">
          <h2 className="font-bold text-[#2D1B0E] min-w-0 truncate">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="w-9 h-9 rounded-lg hover:bg-[#FFF1E3] shrink-0">
            <X size={16} className="mx-auto" />
          </button>
        </div>
        <div className="p-4 space-y-4 overflow-y-auto">{children}</div>
        {footer && <div className="px-4 py-3 border-t border-[#E8D5C4] flex flex-wrap justify-end gap-2 shrink-0">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * How a document's expiry reads in words.
 *
 * "Expires in 12 days" is a fact somebody can act on; "expiring" is a colour.
 * A lapsed document says HOW LONG AGO, because a licence three days out of date
 * and one three years out of date are different problems.
 */
function expiryWords(d: Doc): string {
  if (!d.expiry_date) return 'No expiry date recorded';
  if (d.days_to_expiry === null) return fmtISTDate(d.expiry_date);
  if (d.days_to_expiry < 0) return `Lapsed ${Math.abs(d.days_to_expiry)} day${Math.abs(d.days_to_expiry) === 1 ? '' : 's'} ago`;
  if (d.days_to_expiry === 0) return 'Expires today';
  return `Expires in ${d.days_to_expiry} day${d.days_to_expiry === 1 ? '' : 's'}`;
}

/* ══════════════════════════════════════════════════════════════════════════ */

export default function FssaiDocumentsPage() {
  const [rows, setRows] = useState<Doc[]>([]);
  const [counts, setCounts] = useState<Counts>(ZERO);
  const [canVoid, setCanVoid] = useState(false);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [err, setErr] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [toast, setToast] = useState('');

  const [state, setState] = useState('');
  const [docType, setDocType] = useState('');
  const [q, setQ] = useState('');
  const [includeSuperseded, setIncludeSuperseded] = useState(false);

  const [formFor, setFormFor] = useState<{ mode: 'create' | 'edit' | 'renew'; doc: Doc | null } | null>(null);
  const [detailId, setDetailId] = useState('');

  const say = useCallback((m: string) => {
    setToast(m);
    setTimeout(() => setToast(''), 5200);
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const sp = new URLSearchParams();
      if (state) sp.set('state', state);
      if (docType) sp.set('doc_type', docType);
      if (q.trim()) sp.set('q', q.trim());
      if (includeSuperseded) sp.set('include_superseded', '1');
      const j = await apiJson<DocListResponse>(`/api/fssai/documents?${sp.toString()}`);
      setRows(j.documents || []);
      setCounts(j.counts || ZERO);
      setCanVoid(!!j.can_void);
      setTruncated(!!j.truncated);
    } catch (e: unknown) {
      const msg = errMsg(e, '');
      // The server's own sentence for a staff phone. The house permission panel
      // (RECON §1.3) rather than an empty list, so nobody thinks the cupboard is
      // bare when it is simply not theirs.
      if (msg.includes('management only')) setForbidden(true);
      else setErr(msg || 'Could not load the documents');
    } finally { setLoading(false); }
  }, [state, docType, q, includeSuperseded]);

  useEffect(() => { load(); }, [load]);

  if (forbidden) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
            🔒 The licence and certificate cupboard is restricted to management. Ask an administrator for access.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">

        <div className="flex flex-wrap items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#af4408] text-white flex items-center justify-center shrink-0">
            <FileText size={20} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408]">Documents &amp; Certificates</h1>
            <p className="text-xs text-[#8B7355]">
              The licence, the water reports, the pest contract, medical and training certificates — and what has lapsed.
            </p>
          </div>
          <button onClick={load} disabled={loading} className={BTN_PLAIN}>
            {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Refresh
          </button>
          <button onClick={() => setFormFor({ mode: 'create', doc: null })} className={BTN_PRIMARY}>
            <Plus size={15} /> Add a document
          </button>
        </div>

        {/* EXPIRED FIRST, and loud. Everything else on this screen is secondary to
            the question "is anything out of date right now". */}
        {counts.expired > 0 && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-900 flex flex-nowrap items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span>
              <strong>{counts.expired}</strong> document{counts.expired === 1 ? ' has' : 's have'} already lapsed.
              Renew {counts.expired === 1 ? 'it' : 'them'} — a renewal keeps the old version, so the file still shows
              what you were covered by and when.
            </span>
          </div>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <button onClick={() => setState(state === 'expired' ? '' : 'expired')} className={`${CARD} p-3 text-left ${state === 'expired' ? 'ring-2 ring-[#af4408]' : ''}`}>
            <p className={`text-2xl font-bold ${counts.expired > 0 ? 'text-red-700' : 'text-[#2D1B0E]'}`}>{counts.expired}</p>
            <p className="text-[11px] text-[#8B7355]">Lapsed</p>
          </button>
          <button onClick={() => setState(state === 'expiring' ? '' : 'expiring')} className={`${CARD} p-3 text-left ${state === 'expiring' ? 'ring-2 ring-[#af4408]' : ''}`}>
            <p className={`text-2xl font-bold ${counts.expiring > 0 ? 'text-amber-700' : 'text-[#2D1B0E]'}`}>{counts.expiring}</p>
            <p className="text-[11px] text-[#8B7355]">Expiring soon</p>
          </button>
          <button onClick={() => setState(state === 'valid' ? '' : 'valid')} className={`${CARD} p-3 text-left ${state === 'valid' ? 'ring-2 ring-[#af4408]' : ''}`}>
            <p className="text-2xl font-bold text-green-700">{counts.valid}</p>
            <p className="text-[11px] text-[#8B7355]">Valid</p>
          </button>
          <button onClick={() => setState(state === 'no_expiry' ? '' : 'no_expiry')} className={`${CARD} p-3 text-left ${state === 'no_expiry' ? 'ring-2 ring-[#af4408]' : ''}`}>
            <p className="text-2xl font-bold text-[#6B5744]">{counts.no_expiry}</p>
            <p className="text-[11px] text-[#8B7355]">No expiry recorded</p>
          </button>
        </div>

        <div className={`${CARD} p-3 flex flex-wrap items-end gap-3`}>
          <label className="min-w-0 flex-1">
            <span className={LABEL}>Search</span>
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8B7355]" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="name, number, issuer, supplier" className={`${INPUT} !pl-8`} />
            </div>
          </label>
          <label>
            <span className={LABEL}>Kind</span>
            <select value={docType} onChange={(e) => setDocType(e.target.value)} className={INPUT}>
              <option value="">All kinds</option>
              {FSSAI_DOC_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
          </label>
          <label className="inline-flex flex-nowrap items-center gap-2 text-sm pb-2">
            <input
              type="checkbox" checked={includeSuperseded}
              onChange={(e) => setIncludeSuperseded(e.target.checked)}
              className="w-4 h-4 accent-[#af4408]"
            />
            Show older versions
          </label>
        </div>

        {err && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">{err}</div>}
        {truncated && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900">
            Showing the first 400. Narrow the search to see the rest.
          </div>
        )}

        <div className={`${CARD} overflow-hidden`}>
          {loading ? (
            <div className="p-10 text-center text-sm text-[#8B7355]">
              <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" /> Loading…
            </div>
          ) : rows.length === 0 ? (
            <div className="p-10 text-center">
              <p className="text-sm font-semibold">
                {state || docType || q ? 'Nothing matches that' : 'The cupboard is empty'}
              </p>
              <p className="text-xs text-[#8B7355] mt-1">
                {state || docType || q
                  ? 'Clear the filters to see everything on file.'
                  : 'Start with the FSSAI licence, the trade licence and the pest-control contract — the three an inspector asks for first.'}
              </p>
            </div>
          ) : (
            <>
              <div className="md:hidden divide-y divide-[#E8D5C4]">
                {rows.map((d) => (
                  <button key={d.id} onClick={() => setDetailId(d.id)} className="w-full text-left p-4 hover:bg-[#FFF8F0]">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="font-semibold text-sm min-w-0">{d.title}</p>
                      <Badge label={d.state_label} color={d.state_color} />
                    </div>
                    <p className="text-xs text-[#6B5744] mt-1">{d.doc_type_label}{d.reference_no ? ` · ${d.reference_no}` : ''}</p>
                    <p className={`text-[11px] mt-1 ${d.state === 'expired' ? 'text-red-700 font-semibold' : 'text-[#8B7355]'}`}>
                      {expiryWords(d)}
                    </p>
                    {!d.is_active && <p className="text-[11px] text-[#8B7355] mt-1">Older version, superseded by a renewal.</p>}
                  </button>
                ))}
              </div>
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-[#FFF1E3] text-[#6B5744]">
                    <tr>
                      <th className="text-left font-semibold px-3 py-2">Document</th>
                      <th className="text-left font-semibold px-3 py-2">Kind</th>
                      <th className="text-left font-semibold px-3 py-2">Number</th>
                      <th className="text-left font-semibold px-3 py-2">Whose</th>
                      <th className="text-left font-semibold px-3 py-2">Expires</th>
                      <th className="text-left font-semibold px-3 py-2">State</th>
                      <th className="text-right font-semibold px-3 py-2">Files</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E8D5C4]">
                    {rows.map((d) => (
                      <tr key={d.id} className={`hover:bg-[#FFF8F0] cursor-pointer ${d.is_active ? '' : 'opacity-60'}`} onClick={() => setDetailId(d.id)}>
                        <td className="px-3 py-2">
                          {d.title}
                          {d.version > 1 && <span className="text-[#8B7355] text-xs"> · v{d.version}</span>}
                        </td>
                        <td className="px-3 py-2 text-[#6B5744]">{d.doc_type_label}</td>
                        <td className="px-3 py-2 text-[#6B5744]">{d.reference_no || '—'}</td>
                        <td className="px-3 py-2 text-[#6B5744]">
                          {d.vendor_name || d.person_email || d.equipment_id || d.department_name || 'the restaurant'}
                        </td>
                        {/* The red is on the DATE CELL, which is the house
                            treatment for overdue (RECON §1.5) — not a new badge. */}
                        <td className={`px-3 py-2 whitespace-nowrap ${d.state === 'expired' ? 'text-red-700 font-semibold' : d.state === 'expiring' ? 'text-amber-700' : 'text-[#6B5744]'}`}>
                          {d.expiry_date ? `${fmtISTDate(d.expiry_date)} · ${expiryWords(d)}` : '—'}
                        </td>
                        <td className="px-3 py-2"><Badge label={d.state_label} color={d.state_color} /></td>
                        <td className="px-3 py-2 text-right text-[#6B5744]">{d.file_count || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        <div className={`${CARD} p-4 text-xs text-[#6B5744] space-y-1.5`}>
          <p className="flex flex-nowrap items-start gap-2">
            <CalendarClock size={14} className="mt-0.5 shrink-0 text-[#af4408]" />
            <span>
              <strong>Nothing sends you a reminder yet.</strong> Each document carries its own warning window, and the
              state above is worked out fresh every time this screen is opened — but no job wakes up on its own to tell
              anybody. Until it does, this screen is the reminder.
            </span>
          </p>
          <p className="flex flex-nowrap items-start gap-2">
            <RotateCw size={14} className="mt-0.5 shrink-0 text-[#af4408]" />
            <span>
              <strong>Renewing never overwrites.</strong> The new certificate is filed as a new version pointing at the
              one it replaces, and the old row stays — so &ldquo;were we covered in March&rdquo; always has an answer.
            </span>
          </p>
          <p className="flex flex-nowrap items-start gap-2">
            <Info size={14} className="mt-0.5 shrink-0 text-[#af4408]" />
            <span>
              Staff medical and training certificates can live here or stay in{' '}
              <a href="/hr/documents" className="text-[#af4408] underline">Employee Documents</a>. Keeping one copy in
              two places is the option to avoid — this is the owner&apos;s call, and nothing has been moved.
            </span>
          </p>
        </div>
      </div>

      {formFor && (
        <DocForm
          mode={formFor.mode}
          doc={formFor.doc}
          onClose={() => setFormFor(null)}
          onSaved={(m) => { setFormFor(null); say(m); load(); }}
        />
      )}
      {detailId && (
        <DocDetail
          id={detailId} canVoid={canVoid}
          onClose={() => setDetailId('')}
          onChanged={load}
          onEdit={(d) => { setDetailId(''); setFormFor({ mode: 'edit', doc: d }); }}
          onRenew={(d) => { setDetailId(''); setFormFor({ mode: 'renew', doc: d }); }}
          say={say}
        />
      )}

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[120] max-w-[92vw] bg-[#2D1B0E] text-white text-sm px-4 py-2.5 rounded-lg shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

/* ── the form: add, correct, renew ────────────────────────────────────────── */

function DocForm({
  mode, doc, onClose, onSaved,
}: { mode: 'create' | 'edit' | 'renew'; doc: Doc | null; onClose: () => void; onSaved: (m: string) => void }) {
  const isRenew = mode === 'renew';
  const isEdit = mode === 'edit';

  const [docType, setDocType] = useState(doc?.doc_type || 'fssai_licence');
  const [title, setTitle] = useState(doc?.title || '');
  const [referenceNo, setReferenceNo] = useState(isRenew ? '' : (doc?.reference_no || ''));
  const [issuer, setIssuer] = useState(doc?.issuer || '');
  const [issuedOn, setIssuedOn] = useState(isRenew ? '' : (doc?.issued_on || ''));
  const [validFrom, setValidFrom] = useState(isRenew ? '' : (doc?.valid_from || ''));
  const [expiry, setExpiry] = useState(isRenew ? '' : (doc?.expiry_date || ''));
  const [reminderDays, setReminderDays] = useState(String(doc?.reminder_days ?? FSSAI_DOC_REMINDER_DAYS));
  const [ownerEmail, setOwnerEmail] = useState(doc?.owner_email || '');
  const [vendorId, setVendorId] = useState(doc?.vendor_id || '');
  const [personEmail, setPersonEmail] = useState(doc?.person_email || '');
  const [equipmentId, setEquipmentId] = useState(doc?.equipment_id || '');
  const [notes, setNotes] = useState(isRenew ? '' : (doc?.notes || ''));
  const [reason, setReason] = useState('');
  const [photo, setPhoto] = useState('');

  const [vendors, setVendors] = useState<{ id: string; name: string }[]>([]);
  const [users, setUsers] = useState<{ email: string; name: string }[]>([]);
  const [equipment, setEquipment] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const scope = FSSAI_DOC_TYPES.find((t) => t.key === docType)?.scope || 'outlet';

  useEffect(() => {
    // Every list here is an EXISTING master, read and never written (owner §21 —
    // a new vendor, employee or item master inside this module is a critical
    // defect). A list that fails to load degrades to a plain field, and the
    // server validates whatever is sent.
    (async () => {
      try {
        const j = await apiJson<VendorsResponse>('/api/vendors');
        const list = j.vendors || j.rows || [];
        setVendors(list.map((v) => ({ id: String(v.id), name: String(v.name || '') })).filter((v) => v.name));
      } catch { /* degrade */ }
      try {
        const j = await apiJson<UsersResponse>('/api/tasks/users');
        setUsers((j.users || []).map((u) => ({ email: String(u.email || ''), name: String(u.name || u.email || '') })));
      } catch { /* degrade */ }
    })();
  }, []);

  useEffect(() => {
    if (scope !== 'equipment') return;
    (async () => {
      try {
        // /api/fssai/masters is admin-only and this screen is management, so a
        // manager will get a 403 here. That is not a defect to work around: the
        // equipment register is admin configuration. The catch below leaves the
        // list empty and the server's refusal names Settings → Equipment.
        const j = await apiJson<MastersResponse>('/api/fssai/masters');
        setEquipment((j.equipment || []).map((eq) => ({ id: String(eq.id), name: String(eq.name || '') })));
      } catch { setEquipment([]); }
    })();
  }, [scope]);

  async function save() {
    setBusy(true); setErr('');
    try {
      const j = await apiJson<DocSaveResponse>('/api/fssai/documents', {
        method: 'POST',
        body: {
          action: isRenew ? 'renew' : isEdit ? 'update' : 'create',
          id: doc?.id,
          doc_type: docType, title, reference_no: referenceNo, issuer,
          issued_on: issuedOn, valid_from: validFrom, expiry_date: expiry,
          reminder_days: reminderDays === '' ? null : reminderDays,
          owner_email: ownerEmail,
          vendor_id: scope === 'vendor' ? vendorId : '',
          person_email: scope === 'person' ? personEmail : '',
          equipment_id: scope === 'equipment' ? equipmentId : '',
          notes, reason,
        },
      });
      const id = String(j?.document?.id || '');
      if (id && photo) {
        try {
          await apiJson('/api/fssai/documents', {
            method: 'POST',
            body: { action: 'attach', id, data_uri: photo, kind: 'certificate' },
          });
        } catch (e: unknown) {
          onSaved(`Saved. The scan did not attach — open the document and try again. (${errMsg(e, '')})`);
          return;
        }
      }
      onSaved(
        // NOT String(j.advice) || fallback: String(undefined) is the TRUTHY string
        // "undefined", so the fallback could never be reached and the toast would
        // read "undefined" on every save that carried no advice.
        j.advice ||
        (isRenew ? 'Renewed. The old version is kept, marked superseded.' : isEdit ? 'Saved.' : 'Added to the cupboard.'),
      );
    } catch (e: unknown) { setErr(errMsg(e, 'Could not save the document')); }
    finally { setBusy(false); }
  }

  const expiryMoved = isEdit && !!doc && expiry !== doc.expiry_date && !!doc.expiry_date;
  const renewalTooEarly = isRenew && !!doc?.expiry_date && !!expiry && expiry <= doc.expiry_date;

  return (
    <Modal
      title={isRenew ? `Renew: ${doc?.title || ''}` : isEdit ? `Correct: ${doc?.title || ''}` : 'Add a document'}
      onClose={onClose}
      wide
      footer={
        <>
          <button onClick={onClose} className={BTN_PLAIN}>Cancel</button>
          <button
            onClick={save}
            disabled={
              busy || title.trim().length < 3 || renewalTooEarly ||
              (expiryMoved && reason.trim().length < 4) ||
              (scope === 'vendor' && !vendorId) ||
              (scope === 'person' && !personEmail) ||
              (scope === 'equipment' && !equipmentId)
            }
            className={BTN_PRIMARY}
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : isRenew ? <RotateCw size={15} /> : <Check size={15} />}
            {isRenew ? ' File the renewal' : ' Save'}
          </button>
        </>
      }
    >
      {err && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">{err}</div>}

      {isRenew && doc && (
        <div className="bg-[#FFF1E3] border border-[#E8D5C4] rounded-lg p-3 text-xs text-[#6B5744]">
          Replacing version {doc.version}
          {doc.reference_no ? `, number ${doc.reference_no}` : ''}
          {doc.expiry_date ? `, which expires ${fmtISTDate(doc.expiry_date)}` : ''}. The old version stays on file,
          marked superseded, so the history of this licence number remains readable.
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block">
          <span className={LABEL}>Kind of document {REQ}</span>
          <select value={docType} onChange={(e) => setDocType(e.target.value)} className={INPUT} disabled={isRenew}>
            {FSSAI_DOC_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        </label>
        <label className="block">
          <span className={LABEL}>What you would call it {REQ}</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="FSSAI licence — Jubilee Hills" className={INPUT} />
        </label>
      </div>

      {/* Only the field this KIND of document actually needs. Without the scope
          rule, a medical certificate could carry a supplier and a supplier licence
          could carry a staff email. */}
      {scope === 'vendor' && (
        <label className="block">
          <span className={LABEL}>Which supplier {REQ}</span>
          <select value={vendorId} onChange={(e) => setVendorId(e.target.value)} className={INPUT}>
            <option value="">Choose a supplier</option>
            {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </label>
      )}
      {scope === 'person' && (
        <label className="block">
          <span className={LABEL}>Whose certificate {REQ}</span>
          <select value={personEmail} onChange={(e) => setPersonEmail(e.target.value)} className={INPUT}>
            <option value="">Choose a member of staff</option>
            {users.map((u) => <option key={u.email} value={u.email}>{u.name}</option>)}
          </select>
          <span className="text-[11px] text-[#8B7355]">
            Staff are identified by their login, because the HR employee list is empty. If that changes, existing
            certificates keep what they have.
          </span>
        </label>
      )}
      {scope === 'equipment' && (
        <label className="block">
          <span className={LABEL}>Which piece of equipment {REQ}</span>
          <select value={equipmentId} onChange={(e) => setEquipmentId(e.target.value)} className={INPUT}>
            <option value="">Choose a unit</option>
            {equipment.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
          {equipment.length === 0 && (
            <span className="text-[11px] text-amber-800">
              The equipment register is empty, or only an administrator can read it. Add the unit under Settings →
              Equipment first.
            </span>
          )}
        </label>
      )}

      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block">
          <span className={LABEL}>Number as printed on it</span>
          <input value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} className={INPUT} />
        </label>
        <label className="block">
          <span className={LABEL}>Who issued it</span>
          <input value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="FSSAI, GHMC, the laboratory" className={INPUT} />
        </label>
      </div>

      <div className="grid sm:grid-cols-3 gap-3">
        <label className="block">
          <span className={LABEL}>Issued on</span>
          <input type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} className={INPUT} />
        </label>
        <label className="block">
          <span className={LABEL}>Valid from</span>
          <input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} className={INPUT} />
        </label>
        <label className="block">
          <span className={LABEL}>Expires</span>
          <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} className={INPUT} />
        </label>
      </div>

      {renewalTooEarly && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-900">
          This renewal expires on {expiry}, which is not after the {doc?.expiry_date} it replaces. Check the date — that
          typo would leave the file reading as if the licence had lapsed.
        </div>
      )}
      {!expiry && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900">
          With no expiry date this will sit under &ldquo;No expiry recorded&rdquo; and nothing will ever warn you about
          it. That is correct for a GST registration; it is not correct for a licence.
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block">
          <span className={LABEL}>Start warning this many days before</span>
          <input type="number" min={0} max={365} value={reminderDays} onChange={(e) => setReminderDays(e.target.value)} className={INPUT} />
          <span className="text-[11px] text-[#8B7355]">
            Changes when this screen calls it &ldquo;expiring soon&rdquo;. Nothing is sent anywhere yet.
          </span>
        </label>
        <label className="block">
          <span className={LABEL}>Who is responsible for renewing it</span>
          <select value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} className={INPUT}>
            <option value="">Nobody named</option>
            {users.map((u) => <option key={u.email} value={u.email}>{u.name}</option>)}
          </select>
        </label>
      </div>

      <label className="block">
        <span className={LABEL}>Notes</span>
        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className={INPUT} />
      </label>

      {expiryMoved && (
        <label className="block">
          <span className={LABEL}>
            Why is the expiry date changing, from {doc?.expiry_date} to {expiry || '(none)'}? {REQ}
          </span>
          <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className={INPUT} />
          <span className="text-[11px] text-[#8B7355]">
            That date decides whether the file says you were covered, so the change is recorded with its reason. If this
            is a NEW certificate rather than a correction, close this and use Renew instead.
          </span>
        </label>
      )}

      {!isEdit && (
        <div>
          <span className={LABEL}>Scan or photograph of the document</span>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {photo ? <ImageThumb src={photo} size={64} onRemove={() => setPhoto('')} /> : (
              <ImageUpload value={[]} onAdd={(u) => setPhoto(u)} label="Add the scan" thumbSize={64} />
            )}
          </div>
          <p className="text-[11px] text-[#8B7355] mt-1">
            Shrunk on this device before it is sent. More pages can be added after saving, one at a time.
          </p>
        </div>
      )}
    </Modal>
  );
}

/* ── the detail panel ─────────────────────────────────────────────────────── */

function DocDetail({
  id, canVoid, onClose, onChanged, onEdit, onRenew, say,
}: {
  id: string; canVoid: boolean; onClose: () => void; onChanged: () => void;
  onEdit: (d: Doc) => void; onRenew: (d: Doc) => void; say: (m: string) => void;
}) {
  const [row, setRow] = useState<Doc | null>(null);
  const [chain, setChain] = useState<ChainRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const j = await apiJson<DocOneResponse>(`/api/fssai/documents?id=${encodeURIComponent(id)}`);
      setRow(j.document); setChain(j.chain || []);
    } catch (e: unknown) { setErr(errMsg(e, 'Could not load the document')); }
    finally { setLoading(false); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function post(body: Record<string, unknown>, ok: string) {
    setBusy(true); setErr('');
    try {
      await apiJson('/api/fssai/documents', { method: 'POST', body: { ...body, id } });
      say(ok); await load(); onChanged();
    } catch (e: unknown) { setErr(errMsg(e, 'That did not work')); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={row?.title || 'Document'} onClose={onClose} wide>
      {loading ? (
        <div className="p-6 text-center text-sm text-[#8B7355]"><Loader2 className="w-5 h-5 animate-spin mx-auto" /></div>
      ) : !row ? (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">{err || 'Not found'}</div>
      ) : (
        <>
          {err && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">{err}</div>}

          <div className="flex flex-wrap gap-1.5">
            <Badge label={row.state_label} color={row.state_color} />
            <Badge label={row.doc_type_label} color="bg-slate-100 text-slate-600 border-slate-200" />
            {row.version > 1 && <Badge label={`version ${row.version}`} color="bg-slate-100 text-slate-600 border-slate-200" />}
            {!row.is_active && <Badge label="superseded" color="bg-gray-100 text-gray-600 border-gray-200" />}
          </div>

          {row.state === 'expired' && !row.voided_at && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-900">
              <p className="font-semibold">{expiryWords(row)}.</p>
              <p className="text-xs mt-0.5">
                Do not hand this over. Renew it — the new certificate is filed as a new version and this one stays on
                record for the period it covered.
              </p>
            </div>
          )}
          {row.voided_at && (
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm">
              <p className="font-semibold">This record was voided.</p>
              <p className="text-xs text-[#6B5744] mt-0.5">{row.void_reason} — {fmtIST(row.voided_at)} by {row.voided_by}</p>
            </div>
          )}

          <dl className="grid sm:grid-cols-2 gap-x-4 gap-y-2">
            <F k="Number" v={row.reference_no || 'not recorded'} />
            <F k="Issued by" v={row.issuer || 'not recorded'} />
            <F k="Issued on" v={row.issued_on ? fmtISTDate(row.issued_on) : 'not recorded'} />
            <F k="Valid from" v={row.valid_from ? fmtISTDate(row.valid_from) : 'not recorded'} />
            <F k="Expires" v={row.expiry_date ? `${fmtISTDate(row.expiry_date)} — ${expiryWords(row)}` : 'no expiry recorded'} />
            <F k="Warning window" v={`${row.reminder_days} days before`} />
            <F
              k="Whose"
              v={row.vendor_name || row.person_email || row.equipment_id || row.department_name || 'the restaurant'}
            />
            <F k="Responsible for renewing" v={row.owner_email || 'nobody named'} />
            <F k="Filed by" v={`${row.created_by} · ${fmtIST(row.created_at)}`} />
            <F k="Reminder last sent" v={row.last_reminder_at ? fmtIST(row.last_reminder_at) : 'never — nothing sends one yet'} />
          </dl>

          {row.notes && (
            <div>
              <p className="text-[11px] text-[#8B7355]">Notes</p>
              <p className="text-sm whitespace-pre-wrap">{row.notes}</p>
            </div>
          )}

          {chain.length > 0 && (
            <div>
              <p className={`${LABEL} mb-1`}>Earlier versions, oldest first</p>
              <ul className="text-sm space-y-1">
                {chain.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-2 text-[#6B5744]">
                    <span className="text-xs">v{c.version}</span>
                    <span>{c.reference_no || c.title}</span>
                    <span className="text-xs">
                      {c.expiry_date ? `expired ${fmtISTDate(c.expiry_date)}` : 'no expiry'}
                    </span>
                    {c.voided_at ? <span className="text-xs">(voided)</span> : null}
                  </li>
                ))}
              </ul>
              <p className="text-[11px] text-[#8B7355] mt-1">
                Kept on purpose. This is how &ldquo;were we covered on that date&rdquo; is answerable.
              </p>
            </div>
          )}
          {row.superseded_by_id && (
            <p className="text-xs text-[#8B7355]">A newer version of this document has been filed.</p>
          )}

          <div>
            <p className={`${LABEL} mb-1`}>The document itself</p>
            <div className="flex flex-wrap items-center gap-2">
              {row.files.map((f) => (
                <div key={f.id} className="relative">
                  {f.has_image ? (
                    <ImageThumb src={f.data_uri} alt={f.filename || row.title} size={72} />
                  ) : (
                    <div
                      className="w-[72px] h-[72px] rounded-lg border border-[#E8D5C4] bg-[#FFF1E3] flex items-center justify-center text-[10px] text-center text-[#8B7355] px-1"
                      title={`Image removed ${fmtIST(f.image_dropped_at)}. The record of it remains.`}
                    >
                      image kept 12 months
                    </div>
                  )}
                  {canVoid && f.has_image && (
                    <button
                      onClick={() => {
                        const reason = window.prompt('Why is this scan being removed? The record of it stays either way.');
                        if (!reason || reason.trim().length < 4) { say('A reason of at least four characters is needed.'); return; }
                        post({ action: 'remove_file', attachment_id: f.id, reason }, 'Scan removed; the record of it stays.');
                      }}
                      aria-label="Remove this scan"
                      className="absolute -top-1.5 -right-1.5 w-6 h-6 rounded-full bg-white border border-[#E8D5C4] shadow text-red-600"
                    >
                      <Trash2 size={11} className="mx-auto" />
                    </button>
                  )}
                </div>
              ))}
              {!row.voided_at && row.files.length < row.file_limit && (
                <ImageUpload
                  value={[]} thumbSize={72} label="Add a page" disabled={busy}
                  onAdd={(uri) => post({ action: 'attach', data_uri: uri, kind: 'certificate' }, 'Page attached.')}
                />
              )}
            </div>
            <p className="text-[11px] text-[#8B7355] mt-1">
              {row.files.length} of {row.file_limit} pages. The picture is kept for twelve months; the record that it
              existed, its size and its fingerprint are kept for good.
            </p>
          </div>

          <div className="flex flex-wrap gap-2 pt-2 border-t border-[#E8D5C4]">
            {row.is_editable && (
              <>
                <button disabled={busy} onClick={() => onRenew(row)} className={BTN_PRIMARY}>
                  <RotateCw size={15} /> Renew it
                </button>
                <button disabled={busy} onClick={() => onEdit(row)} className={BTN_PLAIN}>
                  <BadgeCheck size={15} /> Correct the details
                </button>
              </>
            )}
            {canVoid && !row.voided_at && (
              <button
                disabled={busy}
                onClick={() => {
                  const reason = window.prompt(
                    'Voiding is for a record entered IN ERROR. A document that has simply expired should be RENEWED, not voided.\n\nWhy is this being voided?',
                  ) || '';
                  if (reason.trim().length < 4) { say('A reason of at least four characters is needed.'); return; }
                  post({ action: 'void', reason }, 'Voided; the row stays with its reason.');
                }}
                className="inline-flex flex-nowrap items-center gap-1.5 text-sm border border-red-200 text-red-700 bg-white rounded-lg px-3 py-2 hover:bg-red-50 disabled:opacity-50"
              >
                <AlertTriangle size={15} /> Void it
              </button>
            )}
            {!row.is_active && !row.voided_at && (
              <p className="text-xs text-[#8B7355] self-center">
                This is an older version, kept because it was valid at the time. Open the current one to change anything.
              </p>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

function F({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-[11px] text-[#8B7355]">{k}</dt>
      <dd className="text-sm">{v}</dd>
    </div>
  );
}
