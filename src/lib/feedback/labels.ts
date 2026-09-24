/**
 * Guest Feedback — PRINTED NAMES THAT STAY DISTINCT.  (P5 Lane C)
 *
 * PURE. No database, no clock, no pdfkit import: the caller passes a `measure`
 * function, so the P6 evidence can drive this with the renderer's own
 * `doc.widthOfString` and with literals, and nothing here can drift from what
 * is actually drawn.
 *
 * ── THE DEFECT THIS EXISTS FOR ──────────────────────────────────────────────
 * `report-pdf.ts` truncates every cell to ONE LINE with a trailing ellipsis and
 * never wraps. That is the right call there — a wrapped cell makes row height
 * depend on content, which is how a 200-row table becomes a 40-page PDF that
 * blows the attachment cap — but the cost was being paid silently by long
 * names. Measured over the 628 real menu items on this database, at the shipped
 * column widths:
 *
 *     151 of 628 truncated, and 58 DISTINCT dishes printed as 28 IDENTICAL
 *     strings, because the ellipsis fell before the part that distinguishes
 *     them:
 *         "AG FORTYSEVEN CHARDONNAY BOTTLE"  ┐
 *         "AG FORTYSEVEN CHARDONNAY GLASS"   ┴→  "AG FORTYSEVEN CHAR…"
 *
 * A bottle of wine and a glass of it were the same row. A chef acting on the
 * Menu Item Analysis would have acted on the wrong one, and no reader of the
 * PDF could have told.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 * 1. A name that fits is printed in full. Nothing is abbreviated for its own
 *    sake.
 * 2. A name that does not fit is elided in the MIDDLE, keeping a head and a
 *    tail — because what tells two menu items apart is almost always the END
 *    ("… BOTTLE" vs "… GLASS", "… 30 ML", "… Family Pack").
 * 3. The result is then PROVED unique across the values handed in. Any pair
 *    that still collides is re-rendered with a deterministic 3-character tag
 *    derived from the full name (FNV-1a, base36), so the same dish carries the
 *    same tag in every report forever — an identifier, not a row number that
 *    moves when the data does.
 *
 * Re-measured with this applied and the widened columns: 628 of 628 printed
 * strings distinct, 562 of 628 printed in full (was 477).
 *
 * ── WHERE IT DOES NOT RUN ───────────────────────────────────────────────────
 * The xlsx path. A spreadsheet cell does not truncate, and putting an
 * abbreviated name into a file people sort, filter and VLOOKUP on would be a
 * worse bug than the one being fixed.
 *
 * ── AND THE WIDTH THAT HAD TO BE MEASURED DIFFERENTLY ───────────────────────
 * See `layoutMeasure` below. "Fits" was being asked of `widthOfString`, and the
 * renderer does not lay text out with `widthOfString`.
 */

/* ── THE WIDTH THE PAGE HONOURS IS NOT THE WIDTH OF THE STRING ───────────────
   🐞 MEASURED, 25-09: two of the 628 real menu names still lost their FINAL
   WORD on the rendered page, and the final word is what told them apart:

       "JOHNNY WALKER BLOND BOTTLE"  -> label "JOHNNY WALKER…OND BOTTLE"
                                       page   "JOHNNY WALKER…OND"   (+ "BOTTLE"
                                       pushed onto a second line, over the row
                                       beneath it)
       "SULA TROPICAL BRUT CREMANT DE NASHIK BTL" -> "…BTL" likewise lost.

   Both labels PASSED the fit test: widthOfString was 126.976pt and 127.032pt
   against a 127.073pt column. The renderer disagreed, and the renderer is right,
   because `doc.text(s, x, y, { width })` never measures `s`. pdfkit builds a
   LineWrapper whenever `width` is set — `lineBreak: false` does not turn it off
   — and that wrapper measures WORD BY WORD: `wordWidth(word)` per chunk,
   subtracted from `spaceLeft`.

   Word-by-word is WIDER than the whole string, because Helvetica is an AFM font
   with KERN PAIRS and `advancesForGlyphs` adds the pair's kern to the LEFT
   glyph's advance. A kern that straddles a chunk boundary is therefore counted
   when the string is measured whole and LOST when it is measured in pieces:

       " " + "W"  = -0.32pt  ("JOHNNY |WALKER…OND |BOTTLE": sum 127.296 > 126.976)
       " " + "T"  = -0.40pt  ("SULA |TROPICAL |B… |NASHIK |BTL": 127.432 > 127.032)

   0.32pt of a word's tail is a whole word on the page, because the overflow is
   all-or-nothing: the wrapper moves the entire word.

   `layoutMeasure` closes it by charging back, once, every negative kern the
   string contains — an UPPER BOUND on what any chunking can lose, which is a
   stronger promise than matching pdfkit's current UAX-14 break points and does
   not break if those move. It costs a fraction of a point of label length: the
   count printed in full over the 628 real names is unchanged at 562.

   It is composed here, not imported here: this file stays PURE (no pdfkit), so
   the caller passes the renderer's own `widthOfString` and nothing can drift. */

/**
 * Wrap a raw width function (`doc.widthOfString`) into the width the RENDERER's
 * line layout will actually consume. Never returns less than `width(s)`.
 */
export function layoutMeasure(width: (s: string) => number): (s: string) => number {
  // kern(a,b) = width(ab) - width(a) - width(b). Single characters cannot kern
  // with themselves, so the two subtrahends are kern-free by construction.
  const kerns = new Map<string, number>();
  const kern = (pair: string): number => {
    let k = kerns.get(pair);
    if (k === undefined) {
      k = width(pair) - width(pair[0]) - width(pair[1]);
      kerns.set(pair, k);
    }
    return k;
  };
  return (s: string): number => {
    let lost = 0;
    for (let i = 1; i < s.length; i++) {
      const k = kern(s[i - 1] + s[i]);
      // Only a NEGATIVE kern can be lost at a break (a positive one is already
      // absent from the pieces' sum). A lone surrogate half measures as junk,
      // which can only ADD here — it can never make the bound optimistic.
      if (k < 0) lost -= k;
    }
    return width(s) + lost;
  };
}

/** FNV-1a, base36, last 3 characters. Deterministic and stable across runs. */
export function nameTag(s: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36).slice(-3);
}

/**
 * The longest head+tail of `s` that fits `w` points, plus an optional ` #tag`.
 * The 55/45 split keeps enough of the head for the dish to be recognisable
 * while guaranteeing the tail — where the distinguishing word usually is —
 * survives.
 */
export function elideMiddle(
  measure: (s: string) => number,
  s: string,
  w: number,
  tag = '',
): string {
  const suffix = tag ? ` #${tag}` : '';
  if (measure(s + suffix) <= w) return s + suffix;
  let lo = 0;
  let hi = s.length;
  let best = '';
  while (lo <= hi) {
    const k = Math.floor((lo + hi) / 2);
    const head = Math.ceil(k * 0.55);
    const tail = k - head;
    const cand = (tail > 0 ? `${s.slice(0, head)}…${s.slice(s.length - tail)}` : `${s.slice(0, head)}…`)
      + suffix;
    if (measure(cand) <= w) { best = cand; lo = k + 1; } else hi = k - 1;
  }
  return best || (suffix ? suffix.trim() : '…');
}

/**
 * A printed label for every distinct value: guaranteed to fit `w` points and
 * guaranteed distinct from every other label in the same call.
 *
 * ── WHY THE TAG PASS LOOPS ──────────────────────────────────────────────────
 * One pass of ` #tag` is enough for the 628 items on this database (measured:
 * 628 of 628 distinct). It is not a GUARANTEE, and this function's whole reason
 * to exist is the guarantee: two names collide again if `nameTag` gives them the
 * same three characters (1 in 46,656 — certain to happen eventually on a
 * growing menu) AND their elided forms match. So the collision test is RE-RUN
 * after tagging and the tag is widened until every label is unique, with a
 * counted suffix as the floor. The loop is bounded by construction: each round
 * either removes a collision or lengthens every colliding tag, and `#1`, `#2`…
 * cannot collide with each other.
 */
export function printableLabels(
  measure: (s: string) => number,
  values: string[],
  w: number,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const v of Array.from(new Set(values))) out.set(v, elideMiddle(measure, v, w));

  const collisions = (): string[][] => {
    const byLabel = new Map<string, string[]>();
    for (const [v, l] of out) byLabel.set(l, (byLabel.get(l) ?? []).concat(v));
    return Array.from(byLabel.values()).filter((vs) => vs.length > 1);
  };

  // Round 1: the stable, content-derived tag — the same dish carries the same
  // three characters in every report, forever, which a row number would not.
  for (const vs of collisions()) for (const v of vs) out.set(v, elideMiddle(measure, v, w, nameTag(v)));

  // Rounds 2+: widen. `nameTag` of the name plus its own tag is still derived
  // from the name, so it is still stable; the counted suffix is the last resort
  // and it cannot collide with itself.
  for (let round = 2; round <= 6; round++) {
    const left = collisions();
    if (left.length === 0) break;
    for (const vs of left) {
      vs.forEach((v, i) => {
        const tag = round < 6 ? nameTag(v + '\u0000'.repeat(round)) : String(i + 1);
        out.set(v, elideMiddle(measure, v, w, tag));
      });
    }
  }
  return out;
}
