'use client';

/**
 * RequestModal — self-service repair/maintenance intake.
 *
 * A lightweight, portaled modal that lets ANY signed-in employee (not just
 * managers) raise a repair/maintenance request. It is deliberately NOT the full
 * TaskModal: the requester only supplies Title, Description, a narrow Category
 * (Repairs / Maintenance / Housekeeping / Safety), Priority and an OPTIONAL
 * photo. Submitting POSTs to /api/tasks/request, which routes the request to the
 * Maintenance team for a manager to triage/assign — the requester never chooses
 * an assignee, due date, department or status.
 *
 * Contract (owned by the /api/tasks/request slice):
 *   POST /api/tasks/request
 *     body { title*, description?, category?, priority?, photo_url? (data:image/* URI) }
 *     → 201 { ok, task } | { error } (4xx/5xx). Open to any authenticated user.
 *     Server FORCES status='assigned', source='request', created_by, department
 *     default 'Maintenance' — the body cannot set them.
 *
 * Portaled to <body> so no ancestor overflow can clip it; Escape / backdrop
 * close; native <select>s (render above everything, no clipping); labelled
 * inputs. Warm theme to match the module.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Loader2, Send, Wrench, X } from 'lucide-react';
import { api } from '@/lib/api';
import { TASK_PRIORITIES } from '@/lib/tasks';
import ImageUpload from './ImageUpload';

/** The narrow, self-service category set an employee may raise a request under
 *  (a curated subset of TASK_CATEGORIES). */
export const REQUEST_CATEGORIES: readonly string[] = ['Repairs', 'Maintenance', 'Housekeeping', 'Safety'] as const;

export interface RequestModalProps {
  /** Close the modal without submitting. */
  onClose: () => void;
  /** Called after a successful POST with a human success message. */
  onSubmitted: (message: string) => void;
}

export default function RequestModal({ onClose, onSubmitted }: RequestModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<string>('Repairs');
  const [priority, setPriority] = useState<string>('medium');
  const [photo, setPhoto] = useState<string>(''); // single data URI (optional)
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  // Focus the title on open; close on Escape.
  useEffect(() => {
    titleRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const submit = async () => {
    const t = title.trim();
    if (!t) { setError('Please add a short title for your request.'); titleRef.current?.focus(); return; }
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const payload: any = {
        title: t,
        description: description.trim(),
        category,
        priority,
      };
      // API validates & stores the attachment under `photo_url` (a data:image/*
      // URI — exactly what ImageUpload emits). Sending `photo` would be dropped.
      if (photo) payload.photo_url = photo;
      const res = await api('/api/tasks/request', { method: 'POST', body: payload });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(j.error || `HTTP ${res.status}`); return; }
      onSubmitted('Request sent to the Maintenance team');
    } catch (e: any) {
      setError(e?.message || 'Failed to send request');
    } finally {
      setBusy(false);
    }
  };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[150] bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={() => { if (!busy) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="request-modal-title"
    >
      <div
        className="bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl shadow-xl max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[#E8D5C4] sticky top-0 bg-white rounded-t-2xl">
          <div className="w-9 h-9 rounded-lg bg-[#af4408] text-white flex items-center justify-center shrink-0">
            <Wrench size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="request-modal-title" className="text-base font-bold text-[#2D1B0E] leading-tight">Raise a Request</h2>
            <p className="text-[11px] text-[#8B7355]">Report a repair or maintenance issue — the Maintenance team will triage it.</p>
          </div>
          <button
            type="button"
            onClick={() => { if (!busy) onClose(); }}
            aria-label="Close"
            className="shrink-0 text-[#8B7355] hover:text-[#2D1B0E] disabled:opacity-50"
            disabled={busy}
          >
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-3.5">
          {error && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2">
              <AlertCircle size={15} className="shrink-0 mt-0.5" /> <span>{error}</span>
            </div>
          )}

          {/* Title */}
          <div>
            <label htmlFor="rq-title" className="block text-xs font-semibold text-[#2D1B0E] mb-1">
              Title <span className="text-[#af4408]">*</span>
            </label>
            <input
              id="rq-title"
              ref={titleRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. AC not cooling in the private dining room"
              maxLength={160}
              className="w-full border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm bg-white text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
            />
          </div>

          {/* Description */}
          <div>
            <label htmlFor="rq-desc" className="block text-xs font-semibold text-[#2D1B0E] mb-1">Description</label>
            <textarea
              id="rq-desc"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What's wrong, where exactly, since when… (optional)"
              className="w-full border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm bg-white text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
            />
          </div>

          {/* Category + Priority (native selects — render above everything) */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="rq-cat" className="block text-xs font-semibold text-[#2D1B0E] mb-1">Category</label>
              <select
                id="rq-cat"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm bg-white text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
              >
                {REQUEST_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="rq-pri" className="block text-xs font-semibold text-[#2D1B0E] mb-1">Priority</label>
              <select
                id="rq-pri"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                className="w-full border border-[#E8D5C4] rounded-lg px-3 py-2 text-sm bg-white text-[#2D1B0E] focus:outline-none focus:border-[#af4408]"
              >
                {TASK_PRIORITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
            </div>
          </div>

          {/* Optional photo */}
          <div>
            <label className="block text-xs font-semibold text-[#2D1B0E] mb-1">Photo <span className="font-normal text-[#8B7355]">(optional)</span></label>
            <ImageUpload
              value={photo ? [photo] : []}
              onAdd={(u) => setPhoto(u)}
              onChange={(list) => setPhoto(list[0] || '')}
              label="Add photo"
              disabled={busy}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[#E8D5C4] sticky bottom-0 bg-white">
          <button
            type="button"
            onClick={() => { if (!busy) onClose(); }}
            disabled={busy}
            className="text-sm rounded-lg px-3.5 py-2 border border-[#E8D5C4] text-[#6B5744] hover:border-[#af4408] bg-white disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !title.trim()}
            className="inline-flex items-center gap-1.5 bg-[#af4408] hover:bg-[#8a3606] text-white text-sm rounded-lg px-4 py-2 disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Send request
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
