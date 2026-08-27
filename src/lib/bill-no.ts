/**
 * THE ONE ANSWER TO "IS THERE A VENDOR BILL NUMBER HERE?"
 *
 * `.trim()` is the wrong emptiness test for this field and it was the test on
 * both sides of the mandatory gate. JavaScript's trim strips WhiteSpace and
 * LineTerminator only, so `"   "`, NBSP and the BOM collapse to '' — but a
 * ZERO WIDTH SPACE, a WORD JOINER, a LEFT-TO-RIGHT MARK, a SOFT HYPHEN, a
 * HANGUL FILLER and a BRAILLE BLANK do not. Proven on the running app before
 * this file existed: six such values were accepted by the receive route, stored
 * into goods_receipt_notes + po_vendor_bills + purchases, rendered as an empty
 * bill number on every screen, and were NOT counted by the app's own blank-bill
 * query (`WHERE TRIM(COALESCE(bill_no,'')) = ''`, whose SQL TRIM strips spaces
 * only). The receive modal used the identical `.trim()`, so Confirm went live on
 * a box that looked empty.
 *
 * So the test is not "does it trim to nothing", it is "is there anything here a
 * human can SEE". The invisible characters are REMOVED rather than merely
 * refused, which also stops one hiding INSIDE a real number: "INV<ZWSP>77" and
 * "INV77" must not be two different bills to `uq_po_vendor_bill` (byte-exact) or
 * to the duplicate-bill guards, or the same bill can be received twice.
 *
 * THIS FILE IMPORTS NOTHING, AND MUST KEEP IMPORTING NOTHING — not @/lib/db,
 * not a type-only import from a module that reaches better-sqlite3. It is
 * imported by src/app/purchase-orders/page.tsx, which is 'use client', and the
 * native driver must never reach the browser bundle. Same rule, same reason as
 * the header of @/lib/line-dedupe.
 *
 * DO NOT RESTATE THIS TEST INLINE. It exists in one place precisely so the
 * client gate and the server gate can never disagree about what "blank" means —
 * a disagreement is exactly how Confirm came to be enabled on an empty-looking
 * field while the route would have refused it.
 */

/** Characters that occupy no visible width: zero-width and word-joining marks,
 *  bidi controls and isolates, variation selectors, the soft hyphen, and the
 *  filler letters that render as blank (HANGUL FILLER, BRAILLE PATTERN BLANK).
 *  Written as \u escapes ON PURPOSE — pasted literally they are invisible in the
 *  editor too, and an unreviewable character class in the one file that decides
 *  whether a bill number exists is not a class anybody can check.
 *  Ordinary whitespace is NOT here — `.trim()` below still handles that. */
const INVISIBLE = new RegExp(
  '[\\u00ad\\u034f\\u061c\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f'
  + '\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u206f'
  + '\\u2800\\u3164\\ufe00-\\ufe0f\\ufeff\\uffa0]',
  'g',
);

/**
 * A vendor bill / invoice number as it should be stored and compared: invisible
 * characters removed, then trimmed. Returns '' when nothing visible is left,
 * which is what every mandatory gate tests.
 *
 * `String(v || '')`, NOT `?? ''` — deliberately. The falsy shapes a direct POST
 * can carry (`0`, `false`, `null`, `undefined`, `''`) must all read as "no bill
 * number"; `?? ''` would turn `0` into the perfectly acceptable bill number
 * "0". A genuine numeric bill number (`4471`) still stringifies normally.
 */
export function normalizeBillNo(v: unknown): string {
  return String(v || '').replace(INVISIBLE, '').trim();
}
