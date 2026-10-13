'use client';

/**
 * BILL SUBMISSION QUALITY CHECK — THE BROWSER HALF
 * ===============================================
 *
 * Everything the two receiving screens and the store register need in the
 * browser, in ONE file, so the question asked at the delivery door and the list
 * read by the Store Manager can never drift apart.
 *
 * WHY THIS FILE EXISTS AT ALL. The owner's instruction was
 *   "IT SHOULD ASK IN QUALITY CHECK FOR STORE PERSON"
 * and there are TWO doors into the same three QC columns — the PO receive modal
 * (src/app/purchase-orders/page.tsx, 20 of the 29 live GRNs) and the ad-hoc
 * receipt (src/app/grn/page.tsx, ex-"Enter Full Bill"). grn-qc.ts already had to
 * learn this lesson: one helper gates both roads, or the two roads answer the
 * same question differently within a month. So the question, the wording, the
 * defaulting rule and the follow-up POST all live here and both screens call in.
 *
 * ── THE LABELS COME FROM THE SERVER'S OWN FILE ─────────────────────────────
 * BH_STATUS_LABEL / BH_STATUS_SHORT are imported from bill-handover-schema.ts
 * rather than retyped. They are the owner's own words for the three states
 * ("Pending Submission", "Submitted - Awaiting Accounts Confirmation",
 * "Received by Accounts") and a paraphrase on one screen is how a handover
 * report stops matching the conversation being had about it. That module is a
 * deliberate leaf: its only imports are `import type Database` (erased at build)
 * and ./format-date (pure), so it bundles into a client component safely.
 *
 * ── NOTHING HERE MAY THROW ─────────────────────────────────────────────────
 * Every function that runs after a goods receipt has been committed returns a
 * result object instead of throwing. A hiccup in the bill register must never
 * leave a storekeeper looking at a red error over a delivery that IS in stock —
 * the receipt is the important write and it has already happened. When a record
 * cannot be made, the honest outcome is a sentence naming where to finish it,
 * and billHandoverSummary().not_yet_recorded / GET /api/bill-submissions/
 * unrecorded catch it on the store screen regardless.
 */

import { api } from '@/lib/api';
import {
  BH_FILE_MAX_BYTES,
  BH_PENDING,
  BH_RECEIVED,
  BH_STATUS_LABEL,
  BH_STATUS_SHORT,
  BH_SUBMITTED,
  BH_VOID,
  type BillHandoverStatus,
} from '@/lib/bill-handover-schema';

export {
  BH_FILE_MAX_BYTES,
  BH_PENDING,
  BH_RECEIVED,
  BH_STATUS_LABEL,
  BH_STATUS_SHORT,
  BH_SUBMITTED,
  BH_VOID,
};
export type { BillHandoverStatus };

/* ════════════════════════════════════════════════════════════════════════════
   THE ANSWER THE STORE PERSON GIVES AT THE DOOR
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * Three answers, and no fourth.
 *
 *   'submitted'  the bill is being handed to Accounts right now  -> record it AND
 *                stamp the handover in one call (submit_now)
 *   'store'      the bill is in the store's hands, not yet handed over -> record
 *                it as Pending Submission. THE DEFAULT, because it is what is
 *                actually true at the instant a delivery is received: the paper
 *                is in the receiver's hand.
 *   'none'       this delivery came with no vendor bill -> record nothing
 *
 * A fourth state — "don't ask me" / unanswered — was deliberately NOT built. The
 * default already describes reality, so the common case costs zero taps, and a
 * skipped question cannot leave a bill unregistered.
 */
export type BhAnswerMode = 'submitted' | 'store' | 'none';

export interface BillHandoverAnswer {
  mode: BhAnswerMode;
  /** Optional free note carried onto the record (e.g. "given to Priya"). */
  note: string;
  /** Optional bill scan. Compressed in the browser before it is ever sent. */
  file: File | null;
}

/** The starting answer for a fresh receipt. See 'store' above for why. */
export const BH_ANSWER_DEFAULT: BillHandoverAnswer = { mode: 'store', note: '', file: null };

/**
 * The EFFECTIVE answer, given what the form actually holds.
 *
 * A receipt with no vendor bill number has nothing to hand over — on /grn that
 * is a declared state ("No vendor bill number — a cash market run, a sample, a
 * donation or a return"), and creating a handover row for it would put a bill
 * into the Accounts queue that does not exist on paper. So the absence of a bill
 * number OVERRIDES the chosen mode rather than being silently ignored.
 *
 * Both the component and the caller run this, so what is drawn on screen and
 * what is posted afterwards cannot disagree.
 */
export function resolveBhMode(answer: BillHandoverAnswer, hasBill: boolean): BhAnswerMode {
  if (!hasBill) return 'none';
  return answer.mode;
}

/* ════════════════════════════════════════════════════════════════════════════
   THE CUTOFF, AS THE SCREENS SEE IT
   ════════════════════════════════════════════════════════════════════════════ */

export interface BhCutoff {
  date: string | null;
  committed_at: string | null;
  ready: boolean;
  /** Plain words, written by the server. RENDER IT VERBATIM — see below. */
  notice: string;
}

/**
 * Is this receiving date inside the register?
 *
 * The owner: "DONT NEED TO REVIEW ANY PAST BILLS FROM THE NEXT DAY OF
 * DEPLOYMENT". The server refuses an out-of-range create with a 400 naming the
 * date; this is only so the screen does not ASK a question whose answer is going
 * to be refused. Both are needed: this one keeps the delivery door quiet, the
 * server's keeps the rule true for anything that posts directly.
 *
 * Comparison is on the RECEIVING date, never the date printed on the bill — a
 * bill printed on the 17th and delivered on the 20th is a bill received after
 * the cutoff and belongs in the register.
 */
export function bhDateInRange(cutoff: BhCutoff | null, receivedDate: string): boolean {
  if (!cutoff || !cutoff.ready || !cutoff.date) return false;
  const d = String(receivedDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  return d >= cutoff.date;
}

/* ════════════════════════════════════════════════════════════════════════════
   STATUS PRESENTATION — one tone per state, everywhere
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * Tailwind tones for the four states.
 *
 * ── THESE VALUES ARE DELIBERATELY IDENTICAL TO THE ACCOUNTS SCREENS ────────
 * They are copied from STATUS_STYLE in
 * src/app/bill-submissions/_components/bill-handover-ui.tsx, which the Accounts
 * queue and the shared history render from. The owner will look at the store
 * register and the Accounts view in the same sitting, and "Pending Submission"
 * being cream on one screen and amber on the other is the kind of small
 * disagreement that makes a reader doubt the two are the same record.
 *
 * Copied rather than imported on purpose: a client component under
 * src/components/ importing a page's private _components folder couples the
 * receiving screens to the Accounts lane's internals. The load-bearing half —
 * the LABELS — is already shared properly, from the server's own
 * bill-handover-schema.ts, so the two can never disagree about what a state is
 * CALLED. If these two tables ever drift, unify them by moving this one into
 * that schema file, which both sides already import.
 */
export const BH_STATUS_TONE: Record<BillHandoverStatus, string> = {
  [BH_PENDING]: 'bg-[#FFF8F0] border-[#E8D5C4] text-[#8B7355]',
  [BH_SUBMITTED]: 'bg-[#FFF1E3] border-[#D4B896] text-[#8a3506]',
  [BH_RECEIVED]: 'bg-emerald-50 border-emerald-200 text-emerald-800',
  [BH_VOID]: 'bg-[#F3EEE7] border-[#E0D0BE] text-[#B8A590]',
};

/**
 * The tone for a whole dashboard TILE.
 *
 * A tile is a target, not a label, so it carries a little more weight than the
 * chip above — but it stays the same hue family as its chip so the tile and the
 * rows it filters to are visibly the same thing.
 */
export const BH_STATUS_WASH: Record<BillHandoverStatus, string> = {
  [BH_PENDING]: 'bg-[#FFF8F0] border-[#D4B896] text-[#6B5744]',
  [BH_SUBMITTED]: 'bg-[#FFF1E3] border-[#D4B896] text-[#8a3506]',
  [BH_RECEIVED]: 'bg-emerald-50 border-emerald-200 text-emerald-900',
  [BH_VOID]: 'bg-[#F3EEE7] border-[#E0D0BE] text-[#8B7355]',
};

export const bhRupees = (v: number) =>
  '₹' + (Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

export const bhKb = (b: number) => `${Math.round((Number(b) || 0) / 1024)} KB`;

/* ════════════════════════════════════════════════════════════════════════════
   THE BILL SCAN — COMPRESSED IN THE BROWSER, BEFORE IT LEAVES THE PHONE
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * The wire budget, and why it is not the route's 600 KB exactly.
 *
 * The production proxy's measured ceiling is 1 MB (a 900 KB body reaches the
 * app, 1,100 KB is refused with a 413 — recorded at
 * src/app/crm-calls/database/page.tsx:81-85; the repo's own nginx.conf claims
 * 25M and the live box is not running it). The route caps a stored file at
 * BH_FILE_MAX_BYTES = 600 KB. This aims BELOW that so multipart framing and a
 * long filename cannot push a legal file over the route's own gate and turn a
 * good scan into a 413 the receiver cannot act on.
 */
const BH_WIRE_TARGET_BYTES = Math.floor(BH_FILE_MAX_BYTES * 0.92); // ~552 KB

/**
 * ASPECT-PRESERVING, unlike the menu-image ladder this is ported from.
 *
 * MenuImageUpload centre-crops to a square because every surface that renders a
 * dish photo is square. A BILL IS PORTRAIT AND THE TOTAL IS AT THE BOTTOM — a
 * square crop throws away the one number the whole feature exists to record. So
 * the long edge walks this ladder and the short edge follows it.
 *
 * 1600 px on the long edge keeps a printed bill's figures readable; the ladder
 * drops QUALITY first and only then SIZE, because a slightly softer 1600 px scan
 * is worth more than a crisp 1000 px one when someone is squinting at a rate.
 */
const BH_EDGE_LADDER = [2000, 1600, 1280, 1000];
const BH_Q_START = 0.85;
const BH_Q_STEP = 0.06;
const BH_Q_MIN = 0.5;

export interface BhCompressed {
  blob: Blob;
  filename: string;
  originalBytes: number;
  outBytes: number;
  edge: number;
  mime: string;
}

/** Can this browser actually ENCODE WebP on a canvas? Safari < 16.4 cannot and
 *  silently hands back a PNG, so test the returned string, not the call. */
function canEncodeWebp(): boolean {
  try {
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 1;
    return c.toDataURL('image/webp').startsWith('data:image/webp');
  } catch {
    return false;
  }
}

/** Decode a File honouring EXIF orientation — a phone photo of a bill held in
 *  one hand is routinely sideways, and a sideways bill is an unreadable bill. */
async function decodeImage(file: File): Promise<{ src: CanvasImageSource; w: number; h: number }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { src: bmp, w: bmp.width, h: bmp.height };
    } catch {
      /* fall through to the <img> path */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const el = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Could not read that photo.'));
      i.src = url;
    });
    return { src: el, w: el.naturalWidth, h: el.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function encodeScaled(
  src: CanvasImageSource,
  w: number,
  h: number,
  longEdge: number,
  mime: string,
  q: number,
): Promise<Blob | null> {
  // Never UPSCALE: a 900 px photo re-drawn at 2000 px is bigger bytes for the
  // same detail, which is the opposite of what this ladder is for.
  const scale = Math.min(1, longEdge / Math.max(w, h));
  const outW = Math.max(1, Math.round(w * scale));
  const outH = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot resize photos.');
  // White matte: a transparent PNG would otherwise go black under JPEG.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, outW, outH);
  ctx.drawImage(src, 0, 0, w, h, 0, 0, outW, outH);
  return new Promise(resolve => canvas.toBlob(b => resolve(b), mime, q));
}

/**
 * Bring a picked file under the wire budget, or explain why it cannot be.
 *
 * A PDF is passed through UNCHANGED — nothing in a browser can recompress one —
 * so an oversized PDF is refused here with the number in the message rather than
 * being posted and bounced by the proxy as an HTML 413 nobody can read.
 */
export async function compressBillScan(file: File): Promise<BhCompressed> {
  const type = (file.type || '').toLowerCase();
  const isPdf = type === 'application/pdf' || /\.pdf$/i.test(file.name || '');

  if (isPdf) {
    if (file.size > BH_FILE_MAX_BYTES) {
      throw new Error(
        `That PDF is ${bhKb(file.size)} and the limit is ${bhKb(BH_FILE_MAX_BYTES)}. ` +
          'A PDF cannot be shrunk in the browser — photograph the bill with the camera instead, ' +
          'which is compressed automatically.',
      );
    }
    return {
      blob: file,
      filename: file.name || 'bill.pdf',
      originalBytes: file.size,
      outBytes: file.size,
      edge: 0,
      mime: 'application/pdf',
    };
  }

  if (!type.startsWith('image/')) {
    throw new Error('Attach a photo of the bill (JPG, PNG or WEBP) or a PDF.');
  }

  const mime = canEncodeWebp() ? 'image/webp' : 'image/jpeg';
  const { src, w, h } = await decodeImage(file);
  if (!w || !h) throw new Error('That photo has no dimensions.');

  let best: { blob: Blob; edge: number } | null = null;
  const done = () => {
    if (typeof (src as ImageBitmap).close === 'function') (src as ImageBitmap).close();
  };

  for (const edge of BH_EDGE_LADDER) {
    for (let q = BH_Q_START; q >= BH_Q_MIN - 1e-9; q -= BH_Q_STEP) {
      const blob = await encodeScaled(src, w, h, edge, mime, Number(q.toFixed(2)));
      if (!blob) continue;
      // Keep the smallest thing seen, so a photo that cannot reach the budget
      // still yields the best available result instead of nothing.
      if (!best || blob.size < best.blob.size) best = { blob, edge };
      if (blob.size <= BH_WIRE_TARGET_BYTES) {
        done();
        const ext = mime === 'image/webp' ? 'webp' : 'jpg';
        return {
          blob,
          filename: (file.name || 'bill').replace(/\.[^.]+$/, '') + '.' + ext,
          originalBytes: file.size,
          outBytes: blob.size,
          edge,
          mime,
        };
      }
    }
  }

  done();
  if (!best) throw new Error('Could not process that photo.');
  if (best.blob.size > BH_FILE_MAX_BYTES) {
    throw new Error(
      `That photo is still ${bhKb(best.blob.size)} after compressing and the limit is ` +
        `${bhKb(BH_FILE_MAX_BYTES)}. Retake it closer to the bill, or in your camera's lower resolution.`,
    );
  }
  const ext = mime === 'image/webp' ? 'webp' : 'jpg';
  return {
    blob: best.blob,
    filename: (file.name || 'bill').replace(/\.[^.]+$/, '') + '.' + ext,
    originalBytes: file.size,
    outBytes: best.blob.size,
    edge: best.edge,
    mime,
  };
}

/**
 * Read an error body that MIGHT NOT BE JSON.
 *
 * THIS IS THE ONE CATCH THE HR VAULT IS MISSING, and it is the whole reason a
 * 4 MB Aadhaar scan there reports "Could not upload the document" with no size,
 * no cause and no remedy: nginx refuses an oversized body with an HTML 413
 * before the route ever runs, the client calls res.json() on that HTML inside a
 * try whose catch is empty, and the real reason is thrown away.
 *
 * So: try JSON, and when it is not JSON say plainly that the request never
 * reached the app — which is a different instruction to the user than any error
 * the app itself could return.
 */
export async function bhReadError(res: Response, fallback: string): Promise<string> {
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  if (ctype.includes('application/json')) {
    try {
      const j = await res.json();
      if (j && typeof j.error === 'string' && j.error.trim()) return j.error;
    } catch {
      /* fall through to the non-JSON path */
    }
  }
  if (res.status === 413) {
    return (
      `The upload was refused before it reached the app — the file is too large. ` +
      `Bill scans must be under ${bhKb(BH_FILE_MAX_BYTES)}.`
    );
  }
  if (res.status === 401) return 'Your session has expired. Sign in again.';
  if (res.status === 403) return 'You are not allowed to do that.';
  return `${fallback} (HTTP ${res.status})`;
}

/* ════════════════════════════════════════════════════════════════════════════
   THE WRITES
   ════════════════════════════════════════════════════════════════════════════ */

export interface BhAttachOutcome {
  ok: boolean;
  message: string;
}

/**
 * Attach one scan to an existing handover record. Compresses first, then POSTs.
 *
 * ALWAYS OPTIONAL. The owner wrote "invoice/bill attachment if applicable", and
 * a failed or skipped upload must never invalidate the handover — bill identity
 * is the evidence, the photo is corroboration. So this returns ok:false with a
 * sentence and the caller carries on.
 */
export async function attachBillScan(handoverId: string, file: File): Promise<BhAttachOutcome> {
  try {
    const c = await compressBillScan(file);
    const form = new FormData();
    form.append('file', c.blob, c.filename);
    form.append('filename', c.filename);
    const res = await api(`/api/bill-submissions/${handoverId}/attachment`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) {
      return { ok: false, message: await bhReadError(res, 'The bill scan could not be attached.') };
    }
    const saved =
      c.originalBytes > c.outBytes
        ? `Bill scan attached (${bhKb(c.originalBytes)} → ${bhKb(c.outBytes)}).`
        : `Bill scan attached (${bhKb(c.outBytes)}).`;
    return { ok: true, message: saved };
  } catch (e) {
    return { ok: false, message: (e as Error)?.message || 'The bill scan could not be attached.' };
  }
}

export interface BhRecordOutcome {
  /** false ONLY when something was meant to be recorded and was not. */
  ok: boolean;
  /** true when a handover row now exists for this receipt. */
  recorded: boolean;
  /** true when it was also stamped "Submitted to Accounts". */
  submitted: boolean;
  id: string;
  /** One sentence for the receipt's own notes. Never empty. */
  message: string;
  /** Present only when a scan was attempted. */
  attachmentMessage?: string;
}

/**
 * THE FOLLOW-UP WRITE, run straight after a goods receipt is committed.
 *
 * ── WHY THIS IS A SECOND CALL AND NOT PART OF THE RECEIVING TRANSACTION ────
 * The map's recommendation is that the handover row be written INSIDE the same
 * transaction that mints the GRN (receive/route.ts:1391-1497,
 * grn/route.ts:1420-1576), which makes forward-only true by construction. That
 * wiring is one line — recordBillHandoverForGrn(db, grnId, actor, opts) in
 * src/lib/bill-handover.ts:1101 exists for exactly it — and it is NOT done here
 * because both of those route files carry other lanes' uncommitted work and a
 * fourth editor in them is how a merge loses a stock write.
 *
 * Until it lands, this call is the recorder and the gap is COVERED, not hidden:
 * billHandoverSummary().not_yet_recorded counts any goods receipt on/after the
 * cutoff with no handover row, and GET /api/bill-submissions/unrecorded lists
 * them for the store screen to finish in one tap. A dropped network, a closed
 * tab or a stale CSRF cookie therefore produces a visible item of work, never a
 * silently missing bill.
 *
 * NEVER THROWS. The goods receipt is already committed and in stock; nothing
 * here may present itself as that having failed.
 */
export async function recordBillHandoverForReceipt(
  grnId: string,
  grnNumber: string,
  answer: BillHandoverAnswer,
  hasBill: boolean,
): Promise<BhRecordOutcome> {
  const mode = resolveBhMode(answer, hasBill);
  const where = 'Purchasing → Bill Handover to Accounts';

  if (mode === 'none') {
    return {
      ok: true,
      recorded: false,
      submitted: false,
      id: '',
      message: 'No vendor bill was recorded for this receipt — nothing is waiting for Accounts.',
    };
  }
  if (!grnId) {
    return {
      ok: false,
      recorded: false,
      submitted: false,
      id: '',
      message: `The bill handover could NOT be recorded — this receipt returned no GRN id. Record it at ${where}.`,
    };
  }

  try {
    const res = await api('/api/bill-submissions', {
      method: 'POST',
      body: {
        grn_id: grnId,
        // Identity (bill no, vendor, date, value) is read FROM the goods receipt
        // server-side and is deliberately NOT posted from here. The owner's
        // brief: "a store person retyping a number the system already knows is
        // how the two copies come to disagree."
        submit_now: mode === 'submitted',
        note: String(answer.note || '').trim(),
      },
    });
    if (!res.ok) {
      const err = await bhReadError(res, 'The bill handover could not be recorded.');
      return {
        ok: false,
        recorded: false,
        submitted: false,
        id: '',
        message: `The bill handover for ${grnNumber || 'this receipt'} was NOT recorded — ${err} The goods receipt is saved and in stock; record the bill at ${where}.`,
      };
    }
    const j = (await res.json().catch(() => ({}))) as { handover?: { id?: string } };
    const id = String(j?.handover?.id || '');

    let attachmentMessage: string | undefined;
    if (answer.file) {
      const at = await attachBillScan(id, answer.file);
      attachmentMessage = at.ok
        ? at.message
        : `The bill was recorded, but the scan was not attached — ${at.message} You can add it from ${where}.`;
    }

    return {
      ok: true,
      recorded: true,
      submitted: mode === 'submitted',
      id,
      message:
        mode === 'submitted'
          ? `Bill handover recorded and marked SUBMITTED TO ACCOUNTS. It now shows as "${BH_STATUS_LABEL[BH_SUBMITTED]}" until Accounts confirm they have it.`
          : `Bill handover recorded as "${BH_STATUS_LABEL[BH_PENDING]}". Mark it submitted at ${where} the moment the paper goes to Accounts.`,
      attachmentMessage,
    };
  } catch {
    return {
      ok: false,
      recorded: false,
      submitted: false,
      id: '',
      message: `The bill handover for ${grnNumber || 'this receipt'} was NOT recorded — the network dropped. The goods receipt is saved and in stock; record the bill at ${where}.`,
    };
  }
}
