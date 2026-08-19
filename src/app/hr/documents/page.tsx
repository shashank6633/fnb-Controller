'use client';

/**
 * HR — Employee Documents vault (Phase 4). ADMIN-ONLY page.
 *
 * Contract: docs/HRMS_DECISIONS.md D4 (BLOBs in SQLite behind an HR-gated
 * route) + §2 (the API is the boundary — this page just renders what
 * canAdminHr lets through; a 403 renders the plain admin-only lock copy).
 *
 * Surfaces:
 *  · Employee Combobox filter + an "Expiring in 60 days" toggle chip
 *    (→ GET /api/hr/documents?expiring_days=60 — includes already-expired).
 *  · Table: employee, doc-type badge (HR_DOC_TYPES), number MASKED to the
 *    last 4 (identity numbers never sit fully visible in a list, even for
 *    admins), issue/expiry dates with a red badge once expired, size,
 *    verify status, uploaded by.
 *  · Upload modal: employee + type + number + dates + file input with the
 *    5 MB client check (the same cap the route enforces — the proxy would
 *    silently truncate a big body, so the client refuses first).
 *  · Download via a plain link to /api/hr/documents/[id]/file (the route
 *    forces attachment + private/no-store).
 *  · Verify / Reject → PATCH { id, action } (the hr/bank house shape);
 *    Delete asks for confirmation NAMING the file — it is a hard delete.
 *
 * Structure copied from src/app/hr/employees/page.tsx (fetch race guard,
 * pagination, modal shell, palette).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FileText,
  Upload,
  X,
  Loader2,
  Download,
  CheckCircle2,
  XCircle,
  Trash2,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { api, apiJson } from '@/lib/api';
import { fmtIST, fmtISTDate, todayIST } from '@/lib/format-date';
import Combobox, { type ComboOption } from '@/components/Combobox';
import Toggle from '@/components/Toggle';
import { HR_DOC_TYPES, docTypeMeta, type HrDocumentMeta } from '@/lib/hr';

const PAGE_SIZE = 25;

/** Client-side upload cap — mirrors HR_DOC_MAX_BYTES in src/lib/hr-files.ts
 *  (not imported: that module pulls in the server DB helpers). */
const MAX_FILE_BYTES = 5_000_000;
const TOO_LARGE_MSG = 'Document too large - 5MB max';

/** What the vault list API accepts (server re-checks its own allowlist). */
const FILE_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp';

/** One list row from GET /api/hr/documents — metadata + LEFT-JOINed names. */
interface DocRow extends HrDocumentMeta {
  employee_name: string | null;
  employee_code: string | null;
}

/** The slice of GET /api/hr/employees rows this page needs for pickers. */
interface EmpRow {
  id: string;
  employee_code: string;
  full_name: string;
}

interface UploadForm {
  employee_id: string;
  doc_type: string;
  doc_number: string;
  issue_date: string;
  expiry_date: string;
}

const emptyForm = (): UploadForm => ({
  employee_id: '',
  doc_type: '',
  doc_number: '',
  issue_date: '',
  expiry_date: '',
});

/** Mask an identity number to its last 4 characters ('' stays ''). */
function maskNumber(n: string): string {
  const v = (n || '').replace(/\s+/g, '');
  if (!v) return '';
  return `•••• ${v.slice(-4)}`;
}

/** Human-readable file size (B / KB / MB). */
function fmtSize(bytes: number): string {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Verify-status badge classes (unverified/verified/rejected). */
function verifyBadge(status: string): { label: string; color: string } {
  if (status === 'verified')
    return { label: 'Verified', color: 'bg-green-100 text-green-700 border-green-200' };
  if (status === 'rejected')
    return { label: 'Rejected', color: 'bg-red-100 text-red-700 border-red-200' };
  return { label: 'Unverified', color: 'bg-slate-100 text-slate-600 border-slate-200' };
}

export default function HrDocumentsPage() {
  // ── List state ──────────────────────────────────────────────────────────
  const [rows, setRows] = useState<DocRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true); // first paint only
  const [fetching, setFetching] = useState(false); // any in-flight list fetch
  const [error, setError] = useState<string | null>(null);

  // ── Filters ─────────────────────────────────────────────────────────────
  const [employeeId, setEmployeeId] = useState(''); // '' = all employees
  const [expiringOnly, setExpiringOnly] = useState(false); // → expiring_days=60

  // ── Employee picker data (filter card + upload modal) ───────────────────
  const [employees, setEmployees] = useState<EmpRow[]>([]);

  // ── Upload modal ────────────────────────────────────────────────────────
  const [showUpload, setShowUpload] = useState(false);
  const [form, setForm] = useState<UploadForm>(emptyForm());
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Row actions (verify / reject / delete) ──────────────────────────────
  const [busyId, setBusyId] = useState<string | null>(null); // `${id}:${action}`
  const [actionError, setActionError] = useState<string | null>(null);

  // Race guard: a stale response must never overwrite a newer one
  // (pattern copied from src/app/hr/employees/page.tsx).
  const fetchSeq = useRef(0);

  // Reset to page 1 whenever any filter changes
  useEffect(() => {
    setPage(1);
  }, [employeeId, expiringOnly]);

  const buildQuery = useCallback(
    (p: number) => {
      const sp = new URLSearchParams();
      if (employeeId) sp.set('employee_id', employeeId);
      if (expiringOnly) sp.set('expiring_days', '60');
      sp.set('page', String(p));
      sp.set('pageSize', String(PAGE_SIZE));
      return sp.toString();
    },
    [employeeId, expiringOnly],
  );

  const fetchDocs = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setFetching(true);
    setError(null);
    try {
      const res = await fetch(`/api/hr/documents?${buildQuery(page)}`);
      if (seq !== fetchSeq.current) return; // a newer fetch superseded this one
      if (!res.ok) {
        setError(
          res.status === 401 || res.status === 403
            ? 'Employee Documents is admin-only.'
            : "Couldn't load documents",
        );
        return;
      }
      const json = await res.json();
      if (seq !== fetchSeq.current) return;
      setRows(Array.isArray(json?.rows) ? json.rows : []);
      setTotal(Number(json?.total) || 0);
    } catch {
      // transient network error — keep last data, surface a retryable state
      if (seq === fetchSeq.current) setError("Couldn't load documents");
    } finally {
      if (seq === fetchSeq.current) {
        setFetching(false);
        setLoading(false);
      }
    }
  }, [buildQuery, page]);

  useEffect(() => {
    fetchDocs();
  }, [fetchDocs]);

  // Employee picker — one fetch on mount (bare fetch is fine for GETs)
  useEffect(() => {
    fetch('/api/hr/employees?pageSize=100')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j) => setEmployees(Array.isArray(j?.rows) ? j.rows : []))
      .catch(() => {});
  }, []);

  const empById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);

  const empFilterOptions = useMemo<ComboOption[]>(
    () => [
      { value: '', label: 'All employees' },
      ...employees.map((e) => ({ value: e.id, label: e.full_name, hint: e.employee_code })),
    ],
    [employees],
  );
  const empModalOptions = useMemo<ComboOption[]>(
    () => employees.map((e) => ({ value: e.id, label: e.full_name, hint: e.employee_code })),
    [employees],
  );

  // ── Expiry helpers (IST calendar dates, same arithmetic as the route) ───
  const today = useMemo(() => todayIST(), []);
  const soonThreshold = useMemo(() => {
    const base = new Date(`${todayIST()}T00:00:00Z`);
    base.setUTCDate(base.getUTCDate() + 60);
    return base.toISOString().slice(0, 10);
  }, []);

  // ── Upload ──────────────────────────────────────────────────────────────
  const openUpload = () => {
    setForm({ ...emptyForm(), employee_id: employeeId }); // pre-fill the filtered employee
    setFile(null);
    setUploadError(null);
    setShowUpload(true);
  };

  const onPickFile = (f: File | null) => {
    if (f && f.size > MAX_FILE_BYTES) {
      setFile(null);
      setUploadError(TOO_LARGE_MSG);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    setUploadError(null);
    setFile(f);
  };

  const saveUpload = async () => {
    if (!form.employee_id) {
      setUploadError('Pick an employee.');
      return;
    }
    if (!file) {
      setUploadError('Choose a file to upload.');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setUploadError(TOO_LARGE_MSG);
      return;
    }
    setSaving(true);
    setUploadError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('employee_id', form.employee_id);
      fd.append('doc_type', form.doc_type);
      fd.append('doc_number', form.doc_number.trim());
      fd.append('issue_date', form.issue_date);
      fd.append('expiry_date', form.expiry_date);
      // api() passes FormData through untouched and injects the CSRF header.
      const res = await api('/api/hr/documents', { method: 'POST', body: fd });
      if (!res.ok) {
        let msg = 'Could not upload the document';
        try {
          msg = (await res.json())?.error || msg;
        } catch {
          /* generic message stands */
        }
        throw new Error(msg);
      }
      setShowUpload(false);
      fetchDocs();
    } catch (e: unknown) {
      setUploadError(e instanceof Error ? e.message : 'Could not upload the document');
    } finally {
      setSaving(false);
    }
  };

  // ── Verify / Reject (PATCH { id, action } — the hr/bank house shape) ────
  const decide = async (row: DocRow, action: 'verify' | 'reject') => {
    setActionError(null);
    setBusyId(`${row.id}:${action}`);
    try {
      await apiJson('/api/hr/documents', { method: 'PATCH', body: { id: row.id, action } });
      await fetchDocs();
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : 'Could not update verification');
    } finally {
      setBusyId(null);
    }
  };

  // ── Delete (hard delete — the confirm names the file) ───────────────────
  const remove = async (row: DocRow) => {
    const name = row.filename || 'this document';
    if (
      !window.confirm(
        `Delete "${name}"? The stored file is permanently removed — this cannot be undone.`,
      )
    ) {
      return;
    }
    setActionError(null);
    setBusyId(`${row.id}:delete`);
    try {
      await apiJson('/api/hr/documents', { method: 'DELETE', body: { id: row.id } });
      // If we just emptied this page, step back one page (the effect refetches).
      if (rows.length === 1 && page > 1) setPage((p) => Math.max(1, p - 1));
      else await fetchDocs();
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : 'Could not delete the document');
    } finally {
      setBusyId(null);
    }
  };

  // ── Pagination derived ──────────────────────────────────────────────────
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const fromN = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const toN = Math.min(page * PAGE_SIZE, total);

  const inputCls = 'w-full px-2 py-1.5 border border-[#E8D5C4] rounded-lg bg-[#FFF8F0] text-sm';
  const iconBtnCls =
    'p-1.5 border border-[#E8D5C4] bg-white hover:bg-[#FFF1E3] rounded-lg disabled:opacity-40';

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408] flex items-center gap-2">
              <FileText className="w-6 h-6" /> Employee Documents
            </h1>
            <p className="text-[#8B7355] text-sm mt-1">
              Identity &amp; employment document vault
              {loading ? '' : ` — ${total} document${total === 1 ? '' : 's'}`}. Admin-only.
            </p>
          </div>
          <button
            onClick={openUpload}
            className="inline-flex items-center gap-2 px-3 py-2 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-medium"
          >
            <Upload className="w-4 h-4" /> Upload Document
          </button>
        </div>

        {/* Filters */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow p-3">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            <div className="w-full sm:w-72">
              <Combobox
                options={empFilterOptions}
                value={employeeId ? empById.get(employeeId)?.full_name || '' : ''}
                onChange={(v) => setEmployeeId(v)}
                placeholder="All employees"
              />
            </div>
            <label className="inline-flex items-center gap-2 cursor-pointer select-none">
              <Toggle
                checked={expiringOnly}
                onChange={setExpiringOnly}
                size="sm"
                label="Expiring in 60 days"
              />
              <span className="text-sm text-[#6B5744]">Expiring in 60 days</span>
            </label>
          </div>
        </div>

        {/* Load error / admin-only lock */}
        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm flex items-center justify-between gap-3">
            <span>{error}</span>
            <button
              onClick={() => fetchDocs()}
              className="shrink-0 px-3 py-1.5 border border-red-200 rounded-lg text-xs font-medium hover:bg-red-100"
            >
              Retry
            </button>
          </div>
        )}

        {/* Mutation error */}
        {actionError && (
          <div className="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm flex items-center justify-between gap-3">
            <span>{actionError}</span>
            <button onClick={() => setActionError(null)} className="shrink-0 text-red-700">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Table */}
        <div className="bg-white border border-[#E8D5C4] rounded-xl shadow overflow-hidden">
          {loading ? (
            <div className="p-6 flex items-center justify-center gap-2 text-[#8B7355] text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading...
            </div>
          ) : rows.length === 0 ? (
            <div className="p-6 text-center text-[#8B7355] text-sm">
              {employeeId || expiringOnly
                ? 'No documents match these filters.'
                : 'No documents in the vault yet — upload the first one.'}
            </div>
          ) : (
            <>
              <div className={`overflow-x-auto ${fetching ? 'opacity-60' : ''}`}>
                <table className="w-full text-sm">
                  <thead className="bg-[#FFF1E3] text-xs text-[#6B5744]">
                    <tr>
                      <th className="text-left py-2 px-3 font-medium">Employee</th>
                      <th className="text-left py-2 px-3 font-medium">Document</th>
                      <th className="text-left py-2 px-3 font-medium">Number</th>
                      <th className="text-left py-2 px-3 font-medium">Issued</th>
                      <th className="text-left py-2 px-3 font-medium">Expiry</th>
                      <th className="text-right py-2 px-3 font-medium">Size</th>
                      <th className="text-left py-2 px-3 font-medium">Verification</th>
                      <th className="text-left py-2 px-3 font-medium">Uploaded by</th>
                      <th className="text-right py-2 px-3 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const type = docTypeMeta(r.doc_type);
                      const vb = verifyBadge(r.verify_status);
                      const expired = !!r.expiry_date && r.expiry_date < today;
                      const expiringSoon =
                        !!r.expiry_date && !expired && r.expiry_date <= soonThreshold;
                      const busy = busyId !== null && busyId.startsWith(`${r.id}:`);
                      return (
                        <tr key={r.id} className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF1E3]">
                          <td className="py-2 px-3">
                            <div className="font-bold text-[#2D1B0E]">
                              {r.employee_name || <span className="text-[#8B7355] font-normal">—</span>}
                            </div>
                            {r.employee_code && (
                              <div className="text-[10px] font-mono text-[#8B7355]">{r.employee_code}</div>
                            )}
                          </td>
                          <td className="py-2 px-3">
                            <span
                              className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border ${type.color}`}
                            >
                              {type.label}
                            </span>
                            {r.filename && (
                              <div
                                className="text-[10px] text-[#8B7355] max-w-[180px] truncate"
                                title={r.filename}
                              >
                                {r.filename}
                              </div>
                            )}
                          </td>
                          <td className="py-2 px-3 text-xs font-mono whitespace-nowrap">
                            {maskNumber(r.doc_number) || <span className="text-[#8B7355]">—</span>}
                          </td>
                          <td className="py-2 px-3 text-xs whitespace-nowrap">
                            {r.issue_date ? fmtISTDate(r.issue_date) : <span className="text-[#8B7355]">—</span>}
                          </td>
                          <td className="py-2 px-3 text-xs whitespace-nowrap">
                            {r.expiry_date ? fmtISTDate(r.expiry_date) : <span className="text-[#8B7355]">—</span>}
                            {expired && (
                              <span className="ml-1.5 inline-flex px-1.5 py-0.5 rounded-full text-[10px] font-semibold border bg-red-100 text-red-700 border-red-200">
                                Expired
                              </span>
                            )}
                            {expiringSoon && (
                              <span className="ml-1.5 inline-flex px-1.5 py-0.5 rounded-full text-[10px] font-medium border bg-amber-100 text-amber-800 border-amber-200">
                                Expiring
                              </span>
                            )}
                          </td>
                          <td className="py-2 px-3 text-xs text-right whitespace-nowrap">
                            {fmtSize(r.size_bytes)}
                          </td>
                          <td className="py-2 px-3">
                            <span
                              className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border ${vb.color}`}
                            >
                              {vb.label}
                            </span>
                            {r.verify_status !== 'unverified' && r.verified_by && (
                              <div className="text-[10px] text-[#8B7355]">{r.verified_by}</div>
                            )}
                          </td>
                          <td className="py-2 px-3 text-xs">
                            <div className="truncate max-w-[160px]" title={r.uploaded_by}>
                              {r.uploaded_by || <span className="text-[#8B7355]">—</span>}
                            </div>
                            <div className="text-[10px] text-[#8B7355] whitespace-nowrap">
                              {fmtIST(r.created_at)}
                            </div>
                          </td>
                          <td className="py-2 px-3">
                            <div className="flex items-center justify-end gap-1.5">
                              <a
                                href={`/api/hr/documents/${r.id}/file`}
                                className={`${iconBtnCls} text-[#6B5744] inline-flex`}
                                title={`Download ${r.filename || 'document'}`}
                              >
                                <Download className="w-4 h-4" />
                              </a>
                              {r.verify_status !== 'verified' && (
                                <button
                                  onClick={() => decide(r, 'verify')}
                                  disabled={busy}
                                  className={`${iconBtnCls} text-green-700`}
                                  title="Mark verified"
                                >
                                  {busyId === `${r.id}:verify` ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                  ) : (
                                    <CheckCircle2 className="w-4 h-4" />
                                  )}
                                </button>
                              )}
                              {r.verify_status !== 'rejected' && (
                                <button
                                  onClick={() => decide(r, 'reject')}
                                  disabled={busy}
                                  className={`${iconBtnCls} text-amber-700`}
                                  title="Mark rejected"
                                >
                                  {busyId === `${r.id}:reject` ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                  ) : (
                                    <XCircle className="w-4 h-4" />
                                  )}
                                </button>
                              )}
                              <button
                                onClick={() => remove(r)}
                                disabled={busy}
                                className={`${iconBtnCls} text-red-600`}
                                title={`Delete ${r.filename || 'document'}`}
                              >
                                {busyId === `${r.id}:delete` ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  <Trash2 className="w-4 h-4" />
                                )}
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="px-3 py-2 border-t border-[#E8D5C4] flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-[#8B7355]">
                  Showing {fromN}–{toN} of {total}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1 || fetching}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-[#E8D5C4] bg-white hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-xs font-medium disabled:opacity-40"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" /> Prev
                  </button>
                  <span className="text-xs text-[#6B5744]">
                    Page {page} of {pageCount}
                  </span>
                  <button
                    onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                    disabled={page >= pageCount || fetching}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-[#E8D5C4] bg-white hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-xs font-medium disabled:opacity-40"
                  >
                    Next <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Upload modal — house safe-modal shell */}
        {showUpload && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
            <div
              style={{ maxHeight: 'calc(100vh - 1.5rem)' }}
              className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-lg shadow-xl flex flex-col overflow-hidden"
            >
              <div className="px-5 py-4 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
                <h2 className="font-bold text-[#2D1B0E]">Upload Document</h2>
                <button
                  onClick={() => {
                    if (!saving) setShowUpload(false);
                  }}
                  className="text-[#8B7355]"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
                {uploadError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">
                    {uploadError}
                  </div>
                )}

                <div>
                  <label className="text-xs text-[#6B5744]">Employee *</label>
                  <Combobox
                    options={empModalOptions}
                    value={form.employee_id ? empById.get(form.employee_id)?.full_name || '' : ''}
                    onChange={(v) => setForm({ ...form, employee_id: v })}
                    placeholder="Pick employee"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-[#6B5744]">Document type</label>
                    <select
                      value={form.doc_type}
                      onChange={(e) => setForm({ ...form, doc_type: e.target.value })}
                      className={inputCls}
                    >
                      <option value="">—</option>
                      {HR_DOC_TYPES.map((t) => (
                        <option key={t.key} value={t.key}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-[#6B5744]">Document number</label>
                    <input
                      value={form.doc_number}
                      onChange={(e) => setForm({ ...form, doc_number: e.target.value })}
                      placeholder="e.g. XXXX 1234"
                      className={inputCls}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-[#6B5744]">Issue date</label>
                    <input
                      type="date"
                      value={form.issue_date}
                      onChange={(e) => setForm({ ...form, issue_date: e.target.value })}
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-[#6B5744]">Expiry date</label>
                    <input
                      type="date"
                      value={form.expiry_date}
                      onChange={(e) => setForm({ ...form, expiry_date: e.target.value })}
                      className={inputCls}
                    />
                  </div>
                </div>

                <div>
                  <label className="text-xs text-[#6B5744]">File * (PDF / JPG / PNG / WEBP, max 5 MB)</label>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={FILE_ACCEPT}
                    onChange={(e) => onPickFile(e.target.files?.[0] || null)}
                    className={`${inputCls} file:mr-3 file:px-2.5 file:py-1 file:border-0 file:rounded-md file:bg-[#FFF1E3] file:text-[#af4408] file:text-xs file:font-medium`}
                  />
                  {file && (
                    <p className="text-[11px] text-[#8B7355] mt-1">
                      {file.name} — {fmtSize(file.size)}
                    </p>
                  )}
                </div>

                <p className="text-[11px] text-[#8B7355]">
                  Files are stored in the vault and served only to admins, always as a download.
                  New documents start as Unverified.
                </p>
              </div>

              <div className="px-5 py-3 border-t border-[#E8D5C4] flex items-center justify-end gap-2 shrink-0">
                <button
                  onClick={() => setShowUpload(false)}
                  disabled={saving}
                  className="px-3 py-2 text-sm text-[#6B5744] disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={saveUpload}
                  disabled={saving}
                  className="px-3 py-2 text-sm bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg inline-flex items-center gap-1 disabled:opacity-50"
                >
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}{' '}
                  Upload
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
