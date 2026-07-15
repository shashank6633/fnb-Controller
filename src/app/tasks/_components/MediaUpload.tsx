'use client';

/**
 * MediaUpload — reusable CLIENT media attacher for the Task-Management module
 * (Phase 3). Unlike ImageUpload (which keeps small images inline as base64),
 * this component streams larger media into the server BLOB store and holds only
 * a lightweight reference back:
 *
 *   VIDEO — <input type=file accept="video/*"> → POST /api/tasks/files
 *   VOICE — record via MediaRecorder (start/stop) OR pick an audio file
 *   FILE  — <input type=file> for a generic document (pdf/text/office)
 *
 * Every pick / recording is uploaded to POST /api/tasks/files as multipart
 * form-data. The endpoint validates the mime, caps the size, stores the Buffer
 * and returns { id, url, mime, filename, kind }. On success `onAdd` fires with
 * a MediaItem the caller can persist into task_attachments (kind|url|filename).
 *
 * Controlled or fire-and-forget:
 *   • pass `value` + `onChange` to manage the whole list, and/or
 *   • pass `onAdd` to be notified of each newly-uploaded item.
 *
 * Previews render <video controls> / <audio controls> / a file chip, each with
 * a remove button. Size/type guards surface friendly inline messages.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiJson } from '@/lib/api';
import { FileUp, Loader2, Mic, Paperclip, Square, Trash2, Video } from 'lucide-react';

/* ── types ─────────────────────────────────────────────────────────────── */
export type MediaKind = 'video' | 'voice' | 'file' | 'image';

export interface MediaItem {
  /** task_attachments.kind — audio uploads map to "voice". */
  kind: MediaKind;
  /** Stored URL, e.g. "/api/tasks/files/<id>". */
  url: string;
  /** Original / friendly filename. */
  filename: string;
  /** Server-reported mime (optional). */
  mime?: string;
}

/** Server response shape from POST /api/tasks/files. */
interface UploadResult {
  id: string;
  url: string;
  mime: string;
  filename: string;
  size: number;
  kind: MediaKind;
}

export type MediaMode = 'video' | 'voice' | 'file';

export interface MediaUploadProps {
  /** Current attached items (controlled). */
  value?: MediaItem[];
  /** Called with the FULL new list after add/remove. */
  onChange?: (items: MediaItem[]) => void;
  /** Called once per newly-uploaded item. */
  onAdd?: (item: MediaItem) => void;
  /** Which pickers to show. Default: all three. */
  modes?: MediaMode[];
  /** Hard ceiling on kept items. Default 12. */
  max?: number;
  /** Disable all controls. */
  disabled?: boolean;
}

/* ── client-side caps (mirror the route; fail fast before uploading) ─────── */
const MB = 1024 * 1024;
const CAP_VIDEO = 20 * MB;
const CAP_AUDIO = 5 * MB;
const CAP_FILE = 10 * MB;

const ALLOWED_DOC_MIMES = new Set<string>([
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

let uidSeq = 0;

/** Pre-flight guard: returns an error string, or null if the blob is OK. */
function guard(mode: MediaMode, mime: string, size: number): string | null {
  const m = (mime || '').toLowerCase();
  if (mode === 'video') {
    if (!m.startsWith('video/')) return 'Please choose a video file.';
    if (size > CAP_VIDEO) return `Video too large (max ${CAP_VIDEO / MB}MB).`;
  } else if (mode === 'voice') {
    if (!m.startsWith('audio/')) return 'Please choose an audio file.';
    if (size > CAP_AUDIO) return `Audio too large (max ${CAP_AUDIO / MB}MB).`;
  } else {
    // generic file: allow images/video/audio too, but block unknown types
    const ok = m.startsWith('image/') || m.startsWith('video/') || m.startsWith('audio/') || ALLOWED_DOC_MIMES.has(m);
    if (!ok) return 'Unsupported file type.';
    if (size > CAP_FILE) return `File too large (max ${CAP_FILE / MB}MB).`;
  }
  return null;
}

/** Pick a MediaRecorder mime the browser actually supports. */
function pickRecorderMime(): string {
  const cand = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  const MR: any = typeof window !== 'undefined' ? (window as any).MediaRecorder : undefined;
  if (MR && typeof MR.isTypeSupported === 'function') {
    for (const c of cand) { if (MR.isTypeSupported(c)) return c; }
  }
  return '';
}

export default function MediaUpload({
  value = [],
  onChange,
  onAdd,
  modes = ['video', 'voice', 'file'],
  max = 12,
  disabled = false,
}: MediaUploadProps) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Recording state
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  // Stable ids so <label htmlFor> ↔ <input id> pairings stay unique per instance.
  const idRef = useRef<string>('');
  if (!idRef.current) idRef.current = `media-${++uidSeq}`;

  const atCap = value.length >= max;

  // Always append onto the LATEST list, not the one captured when an async
  // upload / recording started. Without this, an attachment added while a voice
  // recording is in flight is silently overwritten when the recording's stale
  // `onstop` closure fires with the old `value`.
  const valueRef = useRef<MediaItem[]>(value);
  useEffect(() => { valueRef.current = value; }, [value]);

  // Clean up any open mic stream on unmount.
  useEffect(() => () => { streamRef.current?.getTracks().forEach((t) => t.stop()); }, []);

  const pushItem = useCallback((item: MediaItem) => {
    onAdd?.(item);
    onChange?.([...valueRef.current, item]);
  }, [onAdd, onChange]);

  /** Upload a Blob/File to the server and register the returned item. */
  const upload = useCallback(async (blob: Blob, filename: string, mode: MediaMode) => {
    setMsg(null);
    if (atCap) { setMsg(`Limit reached (${max} attachments).`); return; }
    const err = guard(mode, blob.type, blob.size);
    if (err) { setMsg(err); return; }

    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', blob, filename);
      fd.append('filename', filename);
      const res = await apiJson<UploadResult>('/api/tasks/files', { method: 'POST', body: fd });
      pushItem({ kind: res.kind, url: res.url, filename: res.filename, mime: res.mime });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Upload failed.');
    } finally {
      setBusy(false);
    }
  }, [atCap, max, pushItem]);

  const onFileInput = useCallback((mode: MediaMode) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.currentTarget.value = '';
    if (file) void upload(file, file.name || `upload`, mode);
  }, [upload]);

  /* ── voice recording ─────────────────────────────────────────────────── */
  const startRecording = useCallback(async () => {
    setMsg(null);
    if (atCap) { setMsg(`Limit reached (${max} attachments).`); return; }
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setMsg('Recording is not supported on this device. Use "Audio file" instead.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = pickRecorderMime();
      const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (ev) => { if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data); };
      rec.onstop = () => {
        const type = rec.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type });
        chunksRef.current = [];
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        if (blob.size > 0) void upload(blob, `voice-${stamp}.${ext}`, 'voice');
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      setMsg('Microphone permission denied or unavailable.');
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, [atCap, max, upload]);

  const stopRecording = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') rec.stop();
    recorderRef.current = null;
    setRecording(false);
  }, []);

  const removeAt = (i: number) => {
    setMsg(null);
    onChange?.(value.filter((_, idx) => idx !== i));
  };

  const canAdd = !disabled && !busy && !atCap;
  const show = (m: MediaMode) => modes.includes(m);

  const btnCls =
    'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[#E8D5C4] ' +
    'bg-[#FFF8F0] text-[13px] text-[#6B5744] hover:border-[#af4408] hover:text-[#af4408] ' +
    'focus:outline-none focus:border-[#af4408] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer';

  return (
    <div className="space-y-2">
      {/* previews */}
      {value.length > 0 && (
        <ul className="space-y-2">
          {value.map((it, i) => (
            <li key={`${it.url}-${i}`} className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-2">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  {it.kind === 'video' ? (
                    <video controls preload="metadata" className="w-full max-h-56 rounded-md bg-black" src={it.url} />
                  ) : it.kind === 'voice' || (it.mime || '').startsWith('audio/') ? (
                    <audio controls preload="metadata" className="w-full" src={it.url} />
                  ) : (
                    <a
                      href={it.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-2 text-[13px] text-[#af4408] hover:underline break-all"
                    >
                      <Paperclip size={14} className="shrink-0" />
                      <span className="truncate">{it.filename || 'Attachment'}</span>
                    </a>
                  )}
                  {(it.kind === 'video' || it.kind === 'voice') && it.filename && (
                    <p className="mt-1 text-[11px] text-[#8B7355] truncate">{it.filename}</p>
                  )}
                </div>
                {!disabled && (
                  <button
                    type="button"
                    onClick={() => removeAt(i)}
                    aria-label={`Remove ${it.filename || 'attachment'}`}
                    title="Remove"
                    className="shrink-0 rounded-md p-1 text-[#8B7355] hover:text-red-700 hover:bg-red-50 focus:outline-none"
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* pickers */}
      <div className="flex flex-wrap items-center gap-2">
        {show('video') && (
          <>
            <input
              id={`${idRef.current}-video`}
              type="file"
              accept="video/*"
              className="sr-only"
              disabled={!canAdd}
              aria-label="Add video"
              onChange={onFileInput('video')}
            />
            <label htmlFor={`${idRef.current}-video`} className={btnCls} aria-disabled={!canAdd}
              style={!canAdd ? { pointerEvents: 'none', opacity: 0.5 } : undefined}>
              <Video size={15} /> Video
            </label>
          </>
        )}

        {show('voice') && (
          <>
            {!recording ? (
              <button type="button" className={btnCls} disabled={!canAdd} onClick={startRecording}>
                <Mic size={15} /> Record voice
              </button>
            ) : (
              <button
                type="button"
                onClick={stopRecording}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-red-300 bg-red-50 text-[13px] text-red-700 hover:bg-red-100 focus:outline-none cursor-pointer animate-pulse"
              >
                <Square size={13} /> Stop recording
              </button>
            )}
            <input
              id={`${idRef.current}-audio`}
              type="file"
              accept="audio/*"
              className="sr-only"
              disabled={!canAdd}
              aria-label="Add audio file"
              onChange={onFileInput('voice')}
            />
            <label htmlFor={`${idRef.current}-audio`} className={btnCls} aria-disabled={!canAdd}
              style={!canAdd ? { pointerEvents: 'none', opacity: 0.5 } : undefined}>
              <Mic size={15} /> Audio file
            </label>
          </>
        )}

        {show('file') && (
          <>
            <input
              id={`${idRef.current}-file`}
              type="file"
              className="sr-only"
              disabled={!canAdd}
              aria-label="Attach file"
              onChange={onFileInput('file')}
            />
            <label htmlFor={`${idRef.current}-file`} className={btnCls} aria-disabled={!canAdd}
              style={!canAdd ? { pointerEvents: 'none', opacity: 0.5 } : undefined}>
              <FileUp size={15} /> File
            </label>
          </>
        )}

        {busy && (
          <span className="inline-flex items-center gap-1 text-[12px] text-[#8B7355]">
            <Loader2 size={14} className="animate-spin" /> Uploading…
          </span>
        )}
      </div>

      {/* status / guard message */}
      {msg
        ? <p className="text-[11px] text-red-700" role="alert">{msg}</p>
        : <p className="text-[10px] text-[#8B7355]">
            Video ≤ {CAP_VIDEO / MB}MB, voice ≤ {CAP_AUDIO / MB}MB, files ≤ {CAP_FILE / MB}MB.
            {atCap ? ` Limit ${max} reached.` : ''}
          </p>}
    </div>
  );
}
