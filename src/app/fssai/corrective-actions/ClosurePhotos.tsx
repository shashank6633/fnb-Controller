'use client';

/**
 * CLOSURE PHOTOGRAPHS — the Hyderabad audit checklist's line #120, "Previous
 * audit report and closure evidence", on the two screens that close things:
 * Corrective Actions and Inspection Reports.
 *
 * WHAT IT SHOWS, IN THIS ORDER:
 *   · the LIVE photographs, each opening full size;
 *   · the VOIDED ones, below, greyed and marked void with who, when and why —
 *     still openable, because a void keeps its image. A void that hid the
 *     picture would be a deletion by another name.
 * WHAT IT DOES: add one photograph at a time (each upload is its own request —
 * production's nginx accepts about 1 MB and a photograph is shrunk to ~250 KB
 * on the phone first), and void one taken by mistake with a reason. It never
 * removes anything: there is no remove button because the server has no remove.
 *
 * The SERVER decides who may add and who may void, and says why not in words
 * (closure_rules on the GET). This component shows that sentence rather than
 * hiding the control without explanation.
 */

import { useState } from 'react';
import { Ban, Camera, Loader2 } from 'lucide-react';
import ImageUpload, { ImageThumb } from '@/app/tasks/_components/ImageUpload';
import { fmtIST } from '@/lib/format-date';
import type { FssaiClosureFile } from '@/app/api/fssai/_closure/lib';

export type ClosureFile = FssaiClosureFile;

/** SQLite's 'YYYY-MM-DD HH:MM:SS' (UTC) and an ISO stamp, made comparable. */
function stamp(v: string): number {
  const s = String(v || '').trim();
  if (!s) return NaN;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s.replace(' ', 'T') : `${s.replace(' ', 'T')}Z`;
  return new Date(iso).getTime();
}

/** True when the file was added after `closedAt` — said on the screen, not hidden. */
export function addedAfter(file: { created_at: string }, closedAt: string): boolean {
  const a = stamp(file.created_at);
  const b = stamp(closedAt);
  return Number.isFinite(a) && Number.isFinite(b) && a > b;
}

export default function ClosurePhotos({
  files,
  title = 'Closure evidence',
  hint,
  attachRefusal,
  voidRefusal,
  liveLimit = 8,
  onAttach,
  onVoid,
  closedAt,
  afterLabel = 'added after it was closed',
  addLabel = 'Add photo',
  emptyText = 'No photograph yet.',
}: {
  files: ClosureFile[];
  title?: string;
  hint?: string;
  /** '' = this person may add one now; otherwise the server's sentence. null hides the control. */
  attachRefusal: string | null;
  /** '' = this person may void one now; otherwise the server's sentence. null hides the control. */
  voidRefusal: string | null;
  liveLimit?: number;
  onAttach?: (dataUri: string) => Promise<void>;
  onVoid?: (attachmentId: string, reason: string) => Promise<void>;
  /** When the record was closed — photos added after it are marked so. */
  closedAt?: string;
  /** The words for a photo added after closedAt. */
  afterLabel?: string;
  addLabel?: string;
  emptyText?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [voiding, setVoiding] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const live = files.filter((f) => f.status !== 'void');
  const voided = files.filter((f) => f.status === 'void');
  const full = live.length >= liveLimit;

  async function add(uri: string) {
    if (!onAttach) return;
    setBusy(true); setErr('');
    try { await onAttach(uri); }
    catch (e) { setErr(e instanceof Error ? e.message : 'The photograph could not be added'); }
    finally { setBusy(false); }
  }

  async function confirmVoid(id: string) {
    if (!onVoid) return;
    setBusy(true); setErr('');
    try {
      await onVoid(id, reason);
      setVoiding(null); setReason('');
    } catch (e) { setErr(e instanceof Error ? e.message : 'That could not be voided'); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-nowrap items-center gap-1.5">
        <Camera size={14} className="text-[#af4408] shrink-0" />
        <p className="text-xs font-semibold text-[#6B5744]">
          {title}
          <span className="font-normal text-[#8B7355]">
            {' '}· {live.length} photograph{live.length === 1 ? '' : 's'}
            {voided.length ? ` · ${voided.length} voided` : ''}
          </span>
        </p>
      </div>
      {hint && <p className="text-[11px] text-[#8B7355]">{hint}</p>}

      {live.length === 0 && <p className="text-xs text-[#8B7355] italic">{emptyText}</p>}

      {live.length > 0 && (
        <ul className="flex flex-wrap gap-3">
          {live.map((f) => (
            <li key={f.attachment_id} className="w-[132px] space-y-1">
              {f.has_image ? (
                <ImageThumb src={f.url} alt={f.caption || f.filename || 'closure photograph'} size={72} />
              ) : (
                <div className="w-[72px] h-[72px] rounded-lg border border-dashed border-[#D4B896] bg-[#FFF8F0] text-[9px] text-[#8B7355] p-1 flex items-center text-center">
                  Image removed by an earlier build — its fingerprint is kept
                </div>
              )}
              {f.caption && <p className="text-[11px] text-[#3D2614] break-words">{f.caption}</p>}
              <p className="text-[10px] text-[#8B7355] break-words">
                {f.created_by || 'unknown'} · {fmtIST(f.created_at)}
              </p>
              {closedAt && addedAfter(f, closedAt) && (
                <p className="text-[10px] text-amber-800">{afterLabel}</p>
              )}
              {voidRefusal === '' && onVoid && (
                voiding === f.attachment_id ? (
                  <div className="space-y-1">
                    <textarea
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      rows={2}
                      autoFocus
                      placeholder="Why — e.g. wrong fridge"
                      className="w-full bg-white border border-[#D4B896] rounded px-1.5 py-1 text-[11px]"
                    />
                    <div className="flex flex-nowrap gap-1">
                      <button
                        type="button"
                        disabled={busy || reason.trim().length < 4}
                        onClick={() => void confirmVoid(f.attachment_id)}
                        className="text-[11px] px-2 py-1 rounded bg-red-700 text-white disabled:opacity-50"
                      >
                        {busy ? <Loader2 size={11} className="animate-spin inline" /> : 'Void it'}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setVoiding(null); setReason(''); }}
                        className="text-[11px] px-2 py-1 rounded border border-[#E8D5C4] bg-white"
                      >
                        Back
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => { setVoiding(f.attachment_id); setReason(''); }}
                    className="text-[11px] text-red-700 hover:underline inline-flex flex-nowrap items-center gap-1"
                  >
                    <Ban size={11} className="shrink-0" /> Taken by mistake
                  </button>
                )
              )}
            </li>
          ))}
        </ul>
      )}

      {attachRefusal === '' && onAttach && (
        full ? (
          <p className="text-[11px] text-amber-800">
            {liveLimit} photographs is the limit. Void one taken by mistake to add another.
          </p>
        ) : (
          <ImageUpload value={[]} onAdd={(u) => void add(u)} label={busy ? 'saving…' : addLabel} disabled={busy} thumbSize={72} />
        )
      )}
      {attachRefusal && <p className="text-[11px] text-[#8B7355]">{attachRefusal}</p>}
      {voidRefusal && live.length > 0 && voidRefusal !== attachRefusal && (
        <p className="text-[11px] text-[#8B7355]">{voidRefusal}</p>
      )}

      {voided.length > 0 && (
        <div className="border-t border-[#E8D5C4] pt-2 space-y-1.5">
          <p className="text-[11px] font-semibold text-[#8B7355]">
            Voided — kept on file, not counted as evidence
          </p>
          <ul className="flex flex-wrap gap-3">
            {voided.map((f) => (
              <li key={f.attachment_id} className="w-[132px] space-y-1">
                <div className="relative w-[72px] opacity-50 grayscale">
                  {f.has_image
                    ? <ImageThumb src={f.url} alt={`voided: ${f.caption || f.filename || 'photograph'}`} size={72} />
                    : <div className="w-[72px] h-[72px] rounded-lg border border-dashed border-[#D4B896]" />}
                  <span className="absolute top-1 left-1 text-[9px] font-bold bg-red-700 text-white px-1 rounded">VOID</span>
                </div>
                <p className="text-[10px] text-[#3D2614] break-words">“{f.void_reason}”</p>
                <p className="text-[10px] text-[#8B7355] break-words">
                  voided by {f.voided_by} · {fmtIST(f.voided_at)}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {err && <p className="text-[11px] text-red-700">{err}</p>}
    </div>
  );
}
