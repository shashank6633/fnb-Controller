/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { callCrmLlm, CrmRateLimitError } from '@/lib/crm-llm';
import {
  salesSummary, foodCost, stockAlerts, varianceReport, wastageSummary,
  pendingApprovals,
} from '@/lib/crm-analyst-data';

/**
 * AI Daily Digest — the owner's morning briefing (/crm/digest).
 *
 * GET  /api/crm/digest?date=YYYY-MM-DD (default today)
 *        → stored digest row for that date, or { exists: false }.
 *        NEVER auto-generates — the explicit button is the only thing that
 *        spends LLM tokens (predictable cost).
 * POST /api/crm/digest  { regenerate?: true }
 *        → builds the deterministic data pack (sales / food cost / stock /
 *          variance / wastage / pending approvals — same builders as the AI
 *          Analyst), asks the LLM for TODAY's digest, upserts crm_digests.
 *          Without regenerate, an existing digest for today is returned as-is.
 *
 * Gate (both verbs): admin or HOD (is_head_chef) — the digest quotes revenue,
 * cost and margin figures, same audience as /crm/analyst.
 */
export const dynamic = 'force-dynamic';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);

async function gate(): Promise<{ me: any } | { resp: Response }> {
  const me = await getCurrentUser();
  if (!me) return { resp: Response.json({ error: 'Sign in required' }, { status: 401 }) };
  if (!(me.role === 'admin' || me.is_head_chef)) {
    return { resp: Response.json({ error: 'Not authorised' }, { status: 403 }) };
  }
  return { me };
}

export async function GET(request: Request) {
  const g = await gate();
  if ('resp' in g) return g.resp;
  try {
    const url = new URL(request.url);
    const date = url.searchParams.get('date') || today();
    if (!ISO_DATE.test(date)) {
      return Response.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 });
    }
    const row = getDb().prepare(`
      SELECT digest_date, content, generated_at, generated_by
      FROM crm_digests WHERE digest_date = ?
    `).get(date) as any;
    if (!row) return Response.json({ exists: false, date });
    return Response.json({
      exists: true,
      date: row.digest_date,
      content: row.content,
      generated_at: row.generated_at,
      generated_by: row.generated_by,
    });
  } catch (e: any) {
    console.error('GET /api/crm/digest failed:', e);
    return Response.json({ error: e?.message || 'Failed to load digest' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const g = await gate();
  if ('resp' in g) return g.resp;
  const me = g.me;

  let body: any = {};
  try { body = await request.json(); } catch { /* empty body is fine */ }
  const regenerate = body?.regenerate === true;

  try {
    const db = getDb();
    const date = today();

    // Idempotent default: an existing digest is only rewritten on explicit
    // regenerate — a double-tap of "Generate" never double-spends tokens.
    const existing = db.prepare(`
      SELECT content, generated_at FROM crm_digests WHERE digest_date = ?
    `).get(date) as any;
    if (existing && !regenerate) {
      return Response.json({
        content: existing.content, generated_at: existing.generated_at, date, cached: true,
      });
    }

    // Deterministic data pack — same grounded builders the AI Analyst uses.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const dataPack: Record<string, unknown> = {
      meta: { digest_for: date, yesterday, note: 'Freshness fields (as_of / latest_*_date) inside each view show how current the underlying data is.' },
      salesSummary: salesSummary(db),
      foodCost: foodCost(db),
      stockAlerts: stockAlerts(db),
      // The digest is cached per-date and shared (an HOD can read a copy generated
      // by an admin), so the shared artifact must NEVER contain the system figure /
      // variance. Always restricted here; admins see variance on the admin-only
      // Variance Approvals / Variance Report surfaces instead.
      varianceReport: varianceReport(db, false),
      wastageSummary: wastageSummary(db),
      pendingApprovals: pendingApprovals(db),
    };

    const system =
      `You are the AKAN F&B morning-briefing writer. Write TODAY'S owner digest in crisp markdown: ` +
      `1) Yesterday's sales & top items 2) Food cost signal 3) Stock alerts needing action today ` +
      `4) Variances/wastage worth a look 5) Pending approvals 6) One actionable recommendation. ` +
      `Use ONLY the data; INR ₹; if a section has no data say so in one line. ≤350 words. ` +
      `Today is ${date}.\n\n` +
      `DATA (JSON):\n` + JSON.stringify(dataPack);

    const content = await callCrmLlm({
      messages: [{ role: 'user', content: `Generate the owner's daily digest for ${date}.` }],
      system,
      maxTokens: 4096,
    });

    db.prepare(`
      INSERT INTO crm_digests (digest_date, content, data_json, generated_at, generated_by)
      VALUES (?, ?, ?, datetime('now'), ?)
      ON CONFLICT(digest_date) DO UPDATE SET
        content = excluded.content,
        data_json = excluded.data_json,
        generated_at = excluded.generated_at,
        generated_by = excluded.generated_by
    `).run(date, content, JSON.stringify(dataPack), me.email || '');

    const fresh = db.prepare(`SELECT generated_at FROM crm_digests WHERE digest_date = ?`).get(date) as any;
    return Response.json({ content, generated_at: fresh?.generated_at || null, date });
  } catch (e: any) {
    if (e instanceof CrmRateLimitError) {
      return Response.json({
        error: 'AI is busy right now. Please wait a moment and try again.',
        wait_seconds: e.waitSeconds,
      }, { status: 429 });
    }
    console.error('POST /api/crm/digest failed:', e);
    return Response.json({ error: e?.message || 'Failed to generate digest' }, { status: 500 });
  }
}
