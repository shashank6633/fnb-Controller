/**
 * FREE-TEXT NAME CANONICALISATION — the invisible-character discipline, for the
 * free-text NAMES the duplicate guards match on (vendor names, material names).
 *
 * Bill numbers already have their own answer (src/lib/bill-no.ts) and station
 * names theirs (station-master.ts normStationInput) and menu categories theirs
 * (menu-category.ts sanitizeCategoryName) — all three exist because `.trim()`
 * accepts characters that occupy no visible width, and a string that LOOKS
 * identical to a stored one then fails every LOWER(TRIM(...)) match against it.
 *
 * PROVEN on a copy of the live DB (dev server, HEAD 34f1825) before this file
 * existed, against POST /api/grn's duplicate-bill guard and POST
 * /api/inventory's duplicate-name guard:
 *   · bill "ZWTEST-77" + U+200B          → 201, the same bill booked twice
 *   · vendor "ZWSP TEST VENDOR" + U+200B → 201, same bill booked twice
 *   · vendor with U+00A0 for the space   → 201, same bill booked twice
 *   · bill with an interior U+200D       → 201, same bill booked twice
 *   · material "ZWSP Probe Material"+ZWSP→ 201, look-identical second material
 * Each of those doubles stock and runs updateMaterialPrice's weighted average
 * twice for one delivery, while the two rows are indistinguishable on screen.
 *
 * THE DISCIPLINE IS sanitizeCategoryName's, VERBATIM (menu-category.ts) — that
 * is the shape the station fix and the category fix both settled on:
 *   · NFC first, so `café` typed as e + U+0301 is the same string as `café`;
 *   · every kind of whitespace (NBSP, U+3000, tab, newline) becomes one plain
 *     space — a name is a label, not a paragraph;
 *   · format and control characters (Unicode Cf and Cc: U+200B/200C/200D/2060,
 *     the BOM, the soft hyphen, bidi marks…) are removed outright — they are
 *     invisible, so nobody can have meant to type one;
 *   · runs of spaces the strip may have created collapse to one; then trim.
 * Case is NOT folded here — what is STORED keeps the case the person typed;
 * folding is the lookup's job and stays `.toLowerCase()` at the call sites, so
 * on clean ASCII input this is exactly the old behaviour.
 *
 * MATCH CLEAN, STORE CLEAN. Cleaning only the comparison would leave the dirty
 * string in the table, stranded on a spelling no later LOWER(TRIM()) predicate
 * can ever reach (the exact failure station-master.ts documents). Measured on
 * the live DB copy 2026-09-02: 0 of 29 goods_receipt_notes.vendor /
 * .invoice_number, 0 of 2,165 purchases.vendor / .bill_no and 0 of 952
 * raw_materials.name carry any Cf/Cc character, an NBSP or an untrimmed edge.
 *
 * BUT THIS FUNCTION IS **NOT** IDENTITY ON EVERYTHING STORED. The measurement
 * above never checked INTERIOR runs of plain ASCII spaces, and the `/ {2,}/g`
 * collapse below moves exactly those: 19 live raw_materials names carry an
 * interior double space ("GLENLIVET 12YRS  (700ML)"), 12 of them beside a
 * single-space TWIN already in the table. So any caller that compares
 * canonNameInput(input) against RAW stored bytes reads the modal's own echo of
 * such a name as a rename onto the twin. Canonicalise BOTH sides of every
 * comparison (the /api/inventory PUT rename gate does), and never rewrite a
 * stored non-canonical name in place when the user typed no rename — the
 * collapsed spelling would be byte-identical to its twin, the exact duplicate
 * the guards exist to prevent.
 *
 * `String(v || '')`, NOT `?? ''` — the falsy shapes a direct POST can carry
 * (0, false, null, undefined, '') must all read as "no name", exactly as the
 * `vendor || ''` binds this replaces always read them.
 *
 * THIS FILE IMPORTS NOTHING, AND MUST KEEP IMPORTING NOTHING — same rule and
 * same reason as @/lib/bill-no: it must stay importable from 'use client'
 * components without dragging better-sqlite3 toward the browser bundle.
 */

const SPACEY = /[\p{Zs}\t\n\r\f\v]+/gu;
const FORMAT_OR_CONTROL = /[\p{Cf}\p{Cc}]/gu;

/** A free-text name as it should be stored AND compared: NFC, all whitespace
 *  (NBSP included) folded to single plain spaces, invisible Cf/Cc characters
 *  removed, trimmed. Identity on every clean name; '' when nothing visible is
 *  left. */
export function canonNameInput(v: unknown): string {
  return String(v || '')
    .normalize('NFC')
    .replace(SPACEY, ' ')
    .replace(FORMAT_OR_CONTROL, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}
