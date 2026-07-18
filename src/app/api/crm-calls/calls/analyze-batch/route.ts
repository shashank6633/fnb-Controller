/* eslint-disable @typescript-eslint/no-explicit-any */
import { requireRole } from '@/lib/auth';
import { analyzePendingBatch } from '@/lib/ct/analyze';

/**
 * CRM Call-to-Table — MANUAL batch analyze ("analyze recent recordings now").
 *
 * POST /api/crm-calls/calls/analyze-batch   body { limit?: number }
 *   → analyzes up to `limit` un-analyzed recorded calls (oldest→newest per the
 *     analyzer) via the EXISTING scorecard engine and returns
 *     { analyzed, failed, rate_limited }.
 *
 * ADMIN-ONLY (requireRole('admin')) — kept simple: the auto-analyze toggle is a
 * separate scheduled path; THIS endpoint is the manual admin trigger and runs
 * regardless of the ct_settings 'auto_analyze' value.
 *
 * `limit` defaults to 5 and is clamped to 1..20 (the analyzer additionally caps
 * per its own contract). Sequential LLM calls; stops early on a provider rate
 * limit (rate_limited: true in the response).
 */
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  let body: any = {};
  try { body = await req.json(); } catch { /* body optional */ }

  const raw = Number(body?.limit);
  const limit = Number.isFinite(raw) ? Math.max(1, Math.min(20, Math.trunc(raw))) : 5;

  const result = await analyzePendingBatch(limit);
  return Response.json({
    analyzed: result.analyzed,
    failed: result.failed,
    rate_limited: result.rate_limited,
  });
}
