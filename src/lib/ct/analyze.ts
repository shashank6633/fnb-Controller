/**
 * Call-to-Table — AI call enhancement.
 *
 * Wires a TeleCMI call recording into the EXISTING production analysis engine
 * (src/lib/crm-audio.ts analyzeCallRecording — Gemini transcribes the audio,
 * Claude/Gemini produces the CallPilot-style scorecard) and persists the
 * result on the ct_calls row. No new AI: pure reuse.
 *
 * The scorecard shape (overall_score, 8-dimension radar, coaching, outcome,
 * tags, moments, speaker-labeled transcript, summary) is CallAnalysisStructured
 * and renders via the shared <CallAnalysisCard/> component.
 */
import type Database from 'better-sqlite3';
import { getDb } from '@/lib/db';
import { analyzeCallRecording, type CallAnalysisStructured } from '@/lib/crm-audio';
import { CrmRateLimitError } from '@/lib/crm-llm';
import { ctSetting } from './settings';
import { fetchRecordingBuffer } from './recording-fetch';

const MAX_AUDIO_BYTES = 14 * 1024 * 1024; // Gemini inline_data request limit

// In-process guard against a concurrent same-call Enhance in EPHEMERAL mode
// (which skips the DB 'pending' claim since it persists nothing). Single-process
// Next.js server, so a Set is sufficient double-charge protection.
const ephemeralInFlight = new Set<string>();

/** Scorecard retention mode (admin setting):
 *  'permanent' (default) — analyzed scorecards are saved on the call (cached,
 *    analyzed once, viewable anytime, auto-analyze allowed).
 *  'ephemeral' — compute-and-show only: Enhance returns the scorecard for
 *    viewing but NOTHING is written to the DB (re-runs each time; auto-analyze
 *    is disabled). Lets an admin peek without storing transcripts. */
export function isEphemeralRetention(db = getDb()): boolean {
  return ctSetting(db, 'analysis_retention') === 'ephemeral';
}
const STALE_PENDING_MS = 5 * 60 * 1000;   // a 'pending' older than this = crashed run, reclaimable

export interface CtCallRow {
  id: string;
  recording_url: string;
  analysis_status: string;
  analysis_json: string;
}

export interface AnalyzeResult {
  ok: boolean;
  status: 'done' | 'skipped' | 'error' | 'rate_limited';
  callId: string;
  analysis?: CallAnalysisStructured | null;
  score?: number | null;
  error?: string;
}

/** The scorecard payload stored on the call + returned to the client, shaped
 *  for the <CallAnalysisCard/> component ({kind:'call_analysis', ...}). */
export function storedAnalysis(db: Database.Database, callId: string): any | null {
  const row = db.prepare(`SELECT analysis_json FROM ct_calls WHERE id = ?`).get(callId) as { analysis_json: string } | undefined;
  if (!row || !row.analysis_json) return null;
  try { return JSON.parse(row.analysis_json); } catch { return null; }
}

/**
 * Analyze ONE call's recording and persist the scorecard. Idempotent-ish:
 * returns the existing analysis unless force=true. Never throws for expected
 * failures (no recording, too large, provider error) — records them in
 * analysis_status/analysis_error so the UI can show a clear state. Re-throws
 * nothing; a rate limit is returned as status:'rate_limited'.
 */
export async function analyzeCtCall(
  callId: string,
  opts: { actor?: string; force?: boolean; language?: string } = {},
): Promise<AnalyzeResult> {
  const db = getDb();
  const actor = opts.actor || 'auto';
  // Ephemeral mode: compute-and-show only, NEVER write the scorecard (or any
  // pending/error state) to the DB. `persist(fn)` is a no-op then.
  const ephemeral = isEphemeralRetention(db);
  const persist = (fn: () => void) => { if (!ephemeral) fn(); };
  const call = db.prepare(
    `SELECT id, recording_url, analysis_status, analysis_json FROM ct_calls WHERE id = ?`,
  ).get(callId) as CtCallRow | undefined;

  if (!call) return { ok: false, status: 'error', callId, error: 'Call not found' };

  // Already analyzed and not forced → return the stored scorecard (permanent
  // mode only — nothing is ever stored in ephemeral mode).
  if (!ephemeral && !opts.force && call.analysis_status === 'done' && call.analysis_json) {
    let analysis: CallAnalysisStructured | null = null;
    try { analysis = JSON.parse(call.analysis_json); } catch { /* corrupt → re-analyze below */ }
    if (analysis) return { ok: true, status: 'done', callId, analysis, score: analysis.overall_score };
  }

  if (!call.recording_url) {
    persist(() => db.prepare(`UPDATE ct_calls SET analysis_status = 'skipped', analysis_error = 'No recording for this call', analyzed_at = ?, analyzed_by = ? WHERE id = ?`)
      .run(new Date().toISOString(), actor, callId));
    return { ok: false, status: 'skipped', callId, error: 'No recording for this call' };
  }

  // ATOMIC claim so a concurrent manual+auto run (or a double-click) can't both
  // run the LLM and double-charge. better-sqlite3 is synchronous, so only ONE
  // caller flips a non-pending row to 'pending' (changes===1); a racing caller
  // sees changes===0 and bails BEFORE the expensive fetch+analyze. A row stuck
  // 'pending' from a crash/restart is reclaimable once it's older than
  // STALE_PENDING_MS (analyzed_at is stamped here so staleness is measurable).
  // Skipped in ephemeral mode (no persistence to guard).
  if (!ephemeral) {
    const staleCutoff = new Date(Date.now() - STALE_PENDING_MS).toISOString();
    const claim = db.prepare(
      `UPDATE ct_calls SET analysis_status = 'pending', analysis_error = '', analyzed_at = ?
       WHERE id = ? AND (analysis_status != 'pending' OR analyzed_at IS NULL OR analyzed_at < ?)`,
    ).run(new Date().toISOString(), callId, staleCutoff);
    if (claim.changes === 0) {
      return { ok: false, status: 'skipped', callId, error: 'Analysis already in progress' };
    }
  }

  // Ephemeral double-charge guard: no DB 'pending' claim exists in this mode,
  // so a same-call concurrent Enhance is blocked in-process instead.
  if (ephemeral) {
    if (ephemeralInFlight.has(callId)) {
      return { ok: false, status: 'skipped', callId, error: 'Analysis already in progress' };
    }
    ephemeralInFlight.add(callId);
  }
  try {

  let buffer: Buffer, mimeType: string;
  try {
    ({ buffer, mimeType } = await fetchRecordingBuffer(db, call.recording_url, { maxBytes: MAX_AUDIO_BYTES }));
  } catch (e: any) {
    const msg = e?.message || 'Failed to fetch recording';
    persist(() => db.prepare(`UPDATE ct_calls SET analysis_status = 'error', analysis_error = ?, analyzed_at = ?, analyzed_by = ? WHERE id = ?`)
      .run(String(msg).slice(0, 500), new Date().toISOString(), actor, callId));
    return { ok: false, status: 'error', callId, error: msg };
  }

  try {
    const result = await analyzeCallRecording({
      base64: buffer.toString('base64'),
      mimeType,
      language: opts.language || 'English',
      // Restaurant calls come in Telugu / Hindi / English (or a mix). Auto-detect
      // the spoken language but always store the transcript + scorecard in ENGLISH
      // so any manager can review it.
      outputLanguage: 'english',
    });
    const now = new Date().toISOString();
    const analysis = result.analysis;
    if (analysis) {
      persist(() => db.prepare(`
        UPDATE ct_calls SET
          analysis_json = ?, analysis_score = ?, analysis_outcome = ?, analysis_summary = ?,
          analysis_status = 'done', analysis_error = '', analyzed_at = ?, analyzed_by = ?
        WHERE id = ?
      `).run(
        JSON.stringify(analysis),
        analysis.overall_score ?? null,
        String(analysis.outcome || '').slice(0, 40),
        String(analysis.summary || '').slice(0, 1000),
        now, actor, callId,
      ));
      return { ok: true, status: 'done', callId, analysis, score: analysis.overall_score };
    }
    // Model didn't return the structured contract — store what we got so the
    // UI can show the score + raw text without a hard failure.
    persist(() => db.prepare(`
      UPDATE ct_calls SET
        analysis_json = ?, analysis_score = ?, analysis_summary = ?,
        analysis_status = 'done', analysis_error = 'Model returned unstructured output', analyzed_at = ?, analyzed_by = ?
      WHERE id = ?
    `).run(
      JSON.stringify({ kind: 'call_analysis', unstructured: true, content: result.content, overall_score: result.score ?? undefined }),
      result.score ?? null,
      String(result.content || '').slice(0, 1000),
      now, actor, callId,
    ));
    return { ok: true, status: 'done', callId, analysis: null, score: result.score };
  } catch (e: any) {
    if (e instanceof CrmRateLimitError) {
      // Transient — revert to the unanalyzed state (NOT terminal 'error') so the
      // auto-batch re-picks it and the Enhance button reappears; keep a note.
      persist(() => db.prepare(`UPDATE ct_calls SET analysis_status = '', analysis_error = 'AI provider rate limit — will retry' WHERE id = ?`).run(callId));
      return { ok: false, status: 'rate_limited', callId, error: 'AI provider rate limit — try again shortly' };
    }
    const msg = e?.message || 'AI analysis failed';
    persist(() => db.prepare(`UPDATE ct_calls SET analysis_status = 'error', analysis_error = ?, analyzed_at = ?, analyzed_by = ? WHERE id = ?`)
      .run(String(msg).slice(0, 500), new Date().toISOString(), actor, callId));
    return { ok: false, status: 'error', callId, error: msg };
  }

  } finally {
    if (ephemeral) ephemeralInFlight.delete(callId);
  }
}

/**
 * Analyze up to `limit` recorded calls (newest first). Sequential (LLM rate
 * limits); stops early on a rate limit. Used by the auto-analyze batch endpoint.
 * Picks calls that have a recording and are EITHER un-analyzed ('' status) OR
 * stuck 'pending' past STALE_PENDING_MS (a crashed run — reclaimed here).
 * Terminal 'error'/'done' rows are NOT retried automatically (a manual
 * re-analyze forces them).
 */
export async function analyzePendingBatch(limit = 3): Promise<{ analyzed: number; failed: number; rate_limited: boolean }> {
  const db = getDb();
  // Ephemeral retention keeps nothing — a background batch would just compute
  // and discard (pure waste), so it's a no-op in that mode.
  if (isEphemeralRetention(db)) return { analyzed: 0, failed: 0, rate_limited: false };
  const staleCutoff = new Date(Date.now() - STALE_PENDING_MS).toISOString();
  const rows = db.prepare(`
    SELECT id FROM ct_calls
    WHERE recording_url <> '' AND (
      COALESCE(analysis_status, '') = ''
      OR (analysis_status = 'pending' AND (analyzed_at IS NULL OR analyzed_at < ?))
    )
    ORDER BY COALESCE(ended_at, started_at, created_at) DESC
    LIMIT ?
  `).all(staleCutoff, Math.max(1, Math.min(20, limit))) as Array<{ id: string }>;

  let analyzed = 0, failed = 0;
  for (const r of rows) {
    const res = await analyzeCtCall(r.id, { actor: 'auto' });
    if (res.status === 'rate_limited') return { analyzed, failed, rate_limited: true };
    if (res.ok) analyzed++; else failed++;
  }
  return { analyzed, failed, rate_limited: false };
}
