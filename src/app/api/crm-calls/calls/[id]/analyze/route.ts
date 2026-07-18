/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser, isManagement } from '@/lib/auth';
import { analyzeCtCall, storedAnalysis } from '@/lib/ct/analyze';

/**
 * CRM Call-to-Table — AI call enhancement for ONE call.
 *
 * Reuses the EXISTING production scorecard engine (src/lib/ct/analyze.ts, which
 * wraps src/lib/crm-audio.ts). No AI is built here — this route only exposes the
 * stored scorecard and triggers the analyzer.
 *
 * GET  /api/crm-calls/calls/[id]/analyze  (authed)
 *   → the STORED scorecard state for the call:
 *     { status, score, outcome, summary, analyzed_at, analyzed_by, error, analysis }
 *   `analysis` is the CallAnalysisData object for <CallAnalysisCard/> (or null).
 *   404 if the call doesn't exist.
 *
 * POST /api/crm-calls/calls/[id]/analyze  (authed)  body { force?: boolean }
 *   → runs analyzeCtCall() for the call and returns the fresh result:
 *     { ok, status, score, analysis, error }.
 *   HTTP status mirrors the analyzer outcome:
 *     done → 200, skipped → 200 (message), rate_limited → 429, error → 502.
 *
 * The [id] segment accepts either the ct_calls.id or the telecmi_call_id — both
 * GET and POST resolve to the internal id first.
 */
export const dynamic = 'force-dynamic';

/** Resolve the internal ct_calls.id from either an id or a telecmi_call_id. */
function resolveCallId(id: string): { id: string } | null {
  const db = getDb();
  return db.prepare(
    `SELECT id FROM ct_calls WHERE id = ? OR telecmi_call_id = ? LIMIT 1`,
  ).get(id, id) as { id: string } | undefined ?? null;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: 'Not signed in' }, { status: 401 });
  const { id } = await params;

  const db = getDb();
  const call = db.prepare(`
    SELECT id, analysis_status, analysis_score, analysis_outcome, analysis_summary,
           analysis_error, analyzed_at, analyzed_by
    FROM ct_calls WHERE id = ? OR telecmi_call_id = ? LIMIT 1
  `).get(id, id) as any;
  if (!call) return Response.json({ error: 'Call not found' }, { status: 404 });

  return Response.json({
    status: call.analysis_status || '',
    score: call.analysis_score ?? null,
    outcome: call.analysis_outcome || '',
    summary: call.analysis_summary || '',
    analyzed_at: call.analyzed_at || null,
    analyzed_by: call.analyzed_by || '',
    error: call.analysis_error || '',
    analysis: storedAnalysis(db, call.id),
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: 'Not signed in' }, { status: 401 });
  // Running the analyzer costs LLM spend — gate the trigger to management
  // (admin / manager / HOD), same tier that controls the batch + settings.
  // GET (viewing a stored scorecard) stays open to any signed-in user.
  if (!isManagement(user)) {
    return Response.json({ error: 'Manager access required to run AI analysis' }, { status: 403 });
  }
  const { id } = await params;

  let body: any = {};
  try { body = await req.json(); } catch { /* body optional */ }
  const force = !!body?.force;

  const resolved = resolveCallId(id);
  if (!resolved) return Response.json({ error: 'Call not found' }, { status: 404 });

  const result = await analyzeCtCall(resolved.id, { actor: user.email, force });

  // Map the analyzer outcome to an HTTP status the client can branch on.
  const httpStatus =
    result.status === 'done' ? 200 :
    result.status === 'skipped' ? 200 :
    result.status === 'rate_limited' ? 429 :
    502; // 'error'

  return Response.json(
    {
      ok: result.ok,
      status: result.status,
      score: result.score ?? null,
      analysis: result.analysis ?? null,
      error: result.error,
      message:
        result.status === 'skipped'
          ? (result.error || 'Nothing to analyze for this call')
          : undefined,
    },
    { status: httpStatus },
  );
}
