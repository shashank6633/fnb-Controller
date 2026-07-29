/**
 * Bill-level charge allocation for a PO receive (delivery + vendor discount).
 *
 * THE TWO RULINGS THIS MODULE ENCODES (owner decision):
 *   - DISCOUNT REDUCES COST. It is netted into the rate written to
 *     `purchases.unit_price`, because that column — and only that column — is
 *     what updateMaterialPrice() averages into raw_materials.average_price.
 *     `purchases.discount` is deliberately left 0 on that path, so the discount
 *     can never be subtracted twice.
 *   - DELIVERY IS RECORDED ONLY. It is stored per line and never touches any
 *     rate, average, or recipe cost.
 *
 * The receiver enters ONE bill-level figure for each; the server allocates it
 * across the accepted lines in proportion to their value at the GROSS rate.
 * Allocation is exact-sum (the last allocatable line takes the remainder), the
 * same technique as store-engine's bill charges — independently rounded shares
 * drift from the bill by a few paise, and this number is the cost basis of
 * stock, so it has to reconcile to the paisa.
 *
 * Pure + isomorphic on purpose: the receive route and the Receive modal both
 * import it, so the figure the receiver is shown is the figure that is booked.
 */

/** ₹ rounded to paise. */
export const r2 = (v: number): number => Math.round((Number(v) || 0) * 100) / 100;

/**
 * Floor for a line's NET rate. A line booked at ₹0 wipes the material's
 * average_price and cascades a "free" ingredient through every recipe that uses
 * it — the same failure the zero-price guard on the receive route exists to stop.
 */
export const MIN_NET_RATE = 0.01;

/** A discount above this share of the bill needs an admin to receive. */
export const NON_ADMIN_DISCOUNT_CAP_PCT = 25;

export interface ChargeLine {
  /** Stable identifier (PO item id) — echoed back on the allocation. */
  id: string;
  /** Accepted quantity, in PURCHASE units. */
  qty: number;
  /** GROSS ₹ per purchase unit — the rate the vendor billed / the PO locked. */
  rate: number;
  /** Optional label, used only to word errors. */
  name?: string;
}

export interface AllocatedLine {
  id: string;
  name: string;
  qty: number;
  /** GROSS rate — unchanged; this is what the GRN (the bill document) carries. */
  rate: number;
  gross: number;
  discount_share: number;
  delivery_share: number;
  /** gross − discount_share */
  net_total: number;
  /** NET ₹ per purchase unit — what purchases.unit_price gets. */
  net_rate: number;
}

export interface ChargeAllocation {
  /** Σ gross over allocatable lines. */
  subtotal: number;
  discount_requested: number;
  /** min(requested, subtotal) — a discount can never exceed the bill. */
  discount_applied: number;
  discount_clamped: boolean;
  delivery: number;
  lines: AllocatedLine[];
  /** Lines whose net rate would fall under MIN_NET_RATE (caller must refuse). */
  zero_cost_lines: AllocatedLine[];
  /** Σ net_total — the cost basis actually booked. */
  net_subtotal: number;
}

/**
 * Allocate bill-level discount + delivery across accepted lines.
 *
 * Lines with qty <= 0 or a non-finite rate are carried through untouched with
 * zero shares (they book nothing), so callers can pass the whole receive.
 */
export function allocateBillCharges(
  lines: ChargeLine[],
  charges: { discount?: number; delivery?: number },
): ChargeAllocation {
  const discountReq = Math.max(0, Number(charges?.discount) || 0);
  const delivery = Math.max(0, Number(charges?.delivery) || 0);

  const prepared = (lines || []).map(l => {
    const qty = Number(l?.qty) || 0;
    const rate = Number(l?.rate) || 0;
    const allocatable = qty > 0 && Number.isFinite(rate) && rate > 0;
    return { id: String(l?.id || ''), name: String(l?.name || ''), qty, rate, allocatable, gross: allocatable ? r2(qty * rate) : 0 };
  });

  const subtotal = r2(prepared.reduce((s, l) => s + l.gross, 0));
  const discountApplied = r2(Math.min(discountReq, subtotal));
  const discountClamped = discountReq - discountApplied > 0.005;

  const allocIdx = prepared.map((l, i) => (l.allocatable ? i : -1)).filter(i => i >= 0);
  const lastAlloc = allocIdx.length ? allocIdx[allocIdx.length - 1] : -1;

  let dRunning = 0, vRunning = 0;
  const out: AllocatedLine[] = prepared.map((l, i) => {
    let dShare = 0, vShare = 0;
    if (l.allocatable && subtotal > 0) {
      if (i === lastAlloc) {
        // Remainder — guarantees Σ shares === the bill figure exactly.
        dShare = r2(discountApplied - dRunning);
        vShare = r2(delivery - vRunning);
      } else {
        const share = l.gross / subtotal;
        dShare = r2(discountApplied * share);
        vShare = r2(delivery * share);
        dRunning = r2(dRunning + dShare);
        vRunning = r2(vRunning + vShare);
      }
    }
    const netTotal = r2(l.gross - dShare);
    // net_rate is derived from the NET LINE TOTAL, never from rate − something:
    // the share is a rupee figure, so dividing it back out is the only way the
    // line reconciles to qty × net_rate.
    const netRate = l.qty > 0 ? r2(netTotal / l.qty) : l.rate;
    return {
      id: l.id, name: l.name, qty: l.qty, rate: l.rate,
      gross: l.gross, discount_share: dShare, delivery_share: vShare,
      net_total: netTotal, net_rate: netRate,
    };
  });

  return {
    subtotal,
    discount_requested: r2(discountReq),
    discount_applied: discountApplied,
    discount_clamped: discountClamped,
    delivery: r2(delivery),
    lines: out,
    zero_cost_lines: out.filter(l => l.qty > 0 && l.rate > 0 && l.net_rate < MIN_NET_RATE),
    net_subtotal: r2(out.reduce((s, l) => s + l.net_total, 0)),
  };
}

/** Resolve a By-% / By-amount charge entry into rupees against a base. */
export function resolveCharge(mode: 'pct' | 'amt', value: string | number, base: number): number {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return mode === 'pct' ? r2((Math.max(0, base) * v) / 100) : r2(v);
}
