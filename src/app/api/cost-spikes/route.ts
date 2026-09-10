import { getDb } from '@/lib/db';
import { costSpikes } from '@/lib/cost-spikes';

/**
 * Cost-spike detector — ingredients where the latest purchase unit_price exceeds
 * the historical average by ≥ threshold% (default 10%).
 *
 * Query params:
 *   threshold_pct  default 10 (i.e. last >= avg × 1.10)
 *   min_purchases  default 2  (skip materials with only 1 purchase)
 *   limit          default 50
 *
 * The query itself now lives in src/lib/cost-spikes.ts so the price-hike
 * WhatsApp alert can send the SAME number this card shows. The response shape
 * is unchanged: { threshold_pct, min_purchases, count, spikes } with the same
 * per-row fields (two additive ones — purchase_unit, pack_size — ride along so
 * a caller that prints the rate can label its basis; nothing that read this
 * endpoint before reads them).
 */
export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    return Response.json(costSpikes(db, {
      thresholdPct: Number(url.searchParams.get('threshold_pct') || 10),
      minPurchases: Number(url.searchParams.get('min_purchases') || 2),
      limit: Number(url.searchParams.get('limit') || 50),
    }));
  } catch (error) {
    console.error('[/api/cost-spikes] error:', error);
    return Response.json({ error: (error as Error)?.message || 'Failed to read cost spikes' }, { status: 500 });
  }
}
