/**
 * Brewery Production batch numbers — owner ruling 114 (2026-11-05).
 *
 * The brewery has been counting its batches since its first brew, so for a
 * Brewery item the batch number is the brewery's own number, not one the app
 * invents. Each Production Item carries one of three settings:
 *
 *   auto           the app makes it, exactly as Kitchen Production always has
 *                  (buildBatchNumber in /api/kitchen-production).
 *   manual         staff type the whole batch number on every batch.
 *   manual_serial  the item has a fixed serial code typed once in Items
 *                  (e.g. "ACB"); staff type only the number and the batch is
 *                  saved as "<code>-<number>" (e.g. "ACB-248").
 *
 * WHO DECIDES. The server reads the setting off the item row
 * (effectiveBatchNumberMode) — never off the request. A batch of an item that
 * is NOT ticked as a Brewery item is always 'auto', whatever its stored
 * setting says, so every Kitchen Production item behaves exactly as before.
 *
 * The barcode (PROD + 6 digits) is untouched by any of this: it stays
 * automatic for every batch, Brewery included, because the scanner, FIFO,
 * stock take and labels all key on it. batch_number is a display field.
 *
 * Shared by the API (validation + duplicate check) and the page (the live
 * "Will be saved as …" line), so the two can never disagree about what a
 * typed value becomes.
 */

export type BatchNumberMode = 'auto' | 'manual' | 'manual_serial';

export const BATCH_NUMBER_MODES: BatchNumberMode[] = ['auto', 'manual', 'manual_serial'];

/**
 * Longest batch number we keep (the whole saved value, serial code included).
 * 21 is what the "Batch:" line of the default 50×40 mm label prints in full
 * beside the QR code (src/lib/tspl-label.ts wraps the number onto its own
 * 21-character line there and cuts anything longer with "..."), so a typed
 * number is never shortened on the default label.
 */
export const BATCH_NUMBER_MAX = 21;
/** Longest serial code an item may carry. */
export const SERIAL_CODE_MAX = 12;

/** Plain words for the Items screen. */
export const BATCH_NUMBER_MODE_LABEL: Record<BatchNumberMode, string> = {
  auto: 'Automatic — the app makes it',
  manual: 'Typed by staff on every batch',
  manual_serial: 'Serial code + number',
};

export function normalizeBatchNumberMode(v: unknown): BatchNumberMode {
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'manual' || s === 'manual_serial' ? s : 'auto';
}

/** The setting the server applies: only a Brewery item can be anything but auto. */
export function effectiveBatchNumberMode(
  item: { is_brewery?: number | boolean | null; batch_number_mode?: string | null } | null | undefined,
): BatchNumberMode {
  if (!item || Number(item.is_brewery) !== 1) return 'auto';
  return normalizeBatchNumberMode(item.batch_number_mode);
}

// Control characters, format characters (zero-width space/joiners, bidi marks,
// soft hyphen, BOM), surrogates, private-use and unassigned code points, line /
// paragraph separators, and the "blank-looking" Hangul / Braille fillers. None
// of these can be seen on a screen or a label, so a batch number carrying one
// would look identical to another and still not match it.
const HIDDEN_CHARS = /[\p{C}\p{Zl}\p{Zp}ᅟᅠㅤﾠ⠀]/u;

export type CleanResult = { ok: true; value: string } | { ok: false; error: string };

/**
 * Tidy what someone typed: trim the ends, refuse anything invisible, and turn
 * every run of spaces inside into one ordinary space. '' means "nothing typed".
 */
export function cleanTypedValue(raw: unknown, what: string): CleanResult {
  const t = String(raw ?? '').trim();
  if (!t) return { ok: true, value: '' };
  if (HIDDEN_CHARS.test(t)) {
    return { ok: false, error: `${what} has a hidden or control character in it (this often comes from copy-paste). Clear the box and type it again.` };
  }
  return { ok: true, value: t.replace(/\p{Zs}+/gu, ' ') };
}

/** The value a batch is saved with, from the item's setting + what staff typed. */
export function composeBatchNumber(mode: BatchNumberMode, serialCode: string, typed: string): string {
  return mode === 'manual_serial' ? `${serialCode}-${typed}` : typed;
}

/**
 * How two batch numbers are compared for "already used": look-alike wide /
 * compatibility characters folded to plain ones (NFKC — "ＡＣＢ-２４８" is
 * "ACB-248"), ends trimmed, inner spaces collapsed, case ignored. "ACB-248",
 * "acb-248" and " ACB-248 " are one.
 */
export function batchNumberKey(s: unknown): string {
  return String(s ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Server-side: turn the request's typed entry into the batch number to save,
 * per the item's own setting. Returns batch_number null for 'auto' (the caller
 * then generates one exactly as today) — a typed value is ignored for auto.
 */
export function resolveTypedBatchNumber(
  item: { name: string; is_brewery?: number | boolean | null; batch_number_mode?: string | null; batch_serial_code?: string | null },
  entry: unknown,
): { mode: BatchNumberMode; batch_number: string | null; error?: string } {
  const mode = effectiveBatchNumberMode(item);
  if (mode === 'auto') return { mode, batch_number: null };

  // The Kitchen Production form never sends this field. An item ticked as a
  // Brewery item after a kitchen tablet loaded its list lands here — tell them
  // where it lives now rather than ask for a box their screen does not have.
  if (entry === undefined) {
    return { mode, batch_number: null, error: `"${item.name}" is a Brewery item with a typed batch number — record it on Brewery Production. Nothing was saved.` };
  }

  const code = String(item.batch_serial_code ?? '').trim();
  if (mode === 'manual_serial' && !code) {
    return { mode, batch_number: null, error: `"${item.name}" is set to "Serial code + number" but has no serial code yet — set one in Items first. Nothing was saved.` };
  }

  const cleaned = cleanTypedValue(entry, 'The batch number');
  if (!cleaned.ok) return { mode, batch_number: null, error: `${cleaned.error} Nothing was saved.` };
  if (!cleaned.value) {
    return {
      mode, batch_number: null,
      error: mode === 'manual_serial'
        ? `Type the batch number (the part after ${code}-) for "${item.name}". Nothing was saved.`
        : `Type the batch number for "${item.name}" — this item's batch numbers are typed in, not made by the app. Nothing was saved.`,
    };
  }

  const full = composeBatchNumber(mode, code, cleaned.value);
  if (full.length > BATCH_NUMBER_MAX) {
    return {
      mode, batch_number: null,
      error: `Batch number "${full}" is ${full.length} characters — keep it to ${BATCH_NUMBER_MAX} or fewer. Nothing was saved.`,
    };
  }
  return { mode, batch_number: full };
}
