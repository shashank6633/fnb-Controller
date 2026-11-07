import { effectiveBatchNumberMode } from './production-batch-number';

/**
 * Scan into New Brewery Batch — owner ruling 119 (2026-11-07).
 *
 * A Brewery batch number is the brewery's own number (ruling 114): typed in,
 * or a fixed serial code + a number ("ACB-248"). The brewery's tags carry that
 * number, so the New Brewery Batch form lets a camera or handheld scanner fill
 * the Batch Number box instead of typing it. This file turns what was read into
 * (item, Batch Number box text). It decides nothing about saving: the form's
 * live "Will be saved as …" line and the server still apply every rule
 * (length, hidden characters, duplicates refused) exactly as for typed text.
 *
 * Rules, in order:
 *   1. Nothing readable → refused.
 *   2. An app label (PROD + digits) → refused: that is a batch the app already
 *      made; looking it up is the Scan screen's job.
 *   3. The text starts with "<serial code>-" of a Brewery item that uses
 *      "serial code + number" → that item is picked (longest code wins, case
 *      ignored) and the box gets the part after the dash.
 *   4. Otherwise the item already picked on the form decides: typed-number
 *      items take the whole text; serial-code items take it as the number.
 *   5. No item picked and no code matched → refused ("pick the item first").
 *   An item whose numbers the app makes (Automatic) never takes a scan.
 */

export interface TagItem {
  id: string;
  name: string;
  is_brewery?: number | boolean | null;
  batch_number_mode?: string | null;
  batch_serial_code?: string | null;
}

export type TagRead =
  | { ok: true; itemId: string; entry: string; switchedItem: boolean }
  | { ok: false; error: string };

// Invisible / control characters a scanner can add around the payload
// (e.g. a trailing CR, a GS separator). Removed only at the ENDS here; anything
// left inside is caught by the form's own hidden-character check.
const EDGE_JUNK = /^[\p{C}\s]+|[\p{C}\s]+$/gu;

export function readBatchTag(raw: unknown, items: TagItem[], pickedId: string | null | undefined): TagRead {
  const text = String(raw ?? '').replace(EDGE_JUNK, '');
  if (!text) return { ok: false, error: 'Nothing was read from the tag — try again.' };
  if (/^PROD\d{3,}$/i.test(text)) {
    return {
      ok: false,
      error: `${text.toUpperCase()} is a label this app printed for a batch that already exists — use Scan to look it up. Scan the brewery's own batch tag here.`,
    };
  }

  const lower = text.toLowerCase();
  let best: { item: TagItem; code: string } | null = null;
  for (const it of items) {
    if (effectiveBatchNumberMode(it) !== 'manual_serial') continue;
    const code = String(it.batch_serial_code || '').trim();
    if (!code || !lower.startsWith(`${code.toLowerCase()}-`)) continue;
    if (!best || code.length > best.code.length) best = { item: it, code };
  }
  if (best) {
    const entry = text.slice(best.code.length + 1).trim();
    if (!entry) return { ok: false, error: `The tag reads "${text}" — there is no number after ${best.code}-.` };
    return { ok: true, itemId: best.item.id, entry, switchedItem: !!pickedId && pickedId !== best.item.id };
  }

  const picked = pickedId ? items.find((i) => i.id === pickedId) : undefined;
  if (!picked) {
    return { ok: false, error: `"${text}" doesn't start with any Brewery item's serial code — pick the item first, then scan.` };
  }
  const mode = effectiveBatchNumberMode(picked);
  if (mode === 'auto') {
    return { ok: false, error: `${picked.name}'s batch numbers are made by the app — there is nothing to scan in.` };
  }
  // A serial-code item would save "<its code>-<text>". A tag that carries some
  // OTHER code ("XYZ-12" on an "ACB" item) is the wrong tag, not a number.
  const otherCode = mode === 'manual_serial' ? text.match(/^([A-Za-z][A-Za-z0-9]*)-/) : null;
  if (otherCode) {
    const own = String(picked.batch_serial_code || '').trim();
    return { ok: false, error: `This tag starts with ${otherCode[1]}-, but ${picked.name} uses ${own}-. Check the tag or the item.` };
  }
  return { ok: true, itemId: picked.id, entry: text, switchedItem: false };
}
