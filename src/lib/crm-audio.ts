/**
 * AKAN CRM — call-recording analysis (port of the Flask app's
 * analyze_call_recording + _transcribe_audio_gemini from
 * akan-crm/services/gemini_service.py).
 *
 * Gemini ALWAYS handles the audio itself (Claude has no audio input):
 * - provider = gemini → one inline_data call: audio + full analysis prompt.
 * - provider = claude → Gemini transcribes the audio first, then Claude does
 *   the coaching analysis on the transcript text via callCrmLlm().
 *
 * Audio travels as base64 inline_data (no Files API) — callers must enforce
 * the ~14MB inline-request limit before reaching this module.
 */
import {
  callCrmLlm,
  CrmRateLimitError,
  getCrmSetting,
  getGeminiKeys,
  getKnowledge,
  getProvider,
} from '@/lib/crm-llm';
import { buildCallAnalysisPrompt, formatKbForPrompt, parseCallAnalysis } from '@/lib/crm-prompts';

const TRANSCRIBE_PROMPT =
  "Transcribe this call recording verbatim. Label each speaker as STAFF or CUSTOMER. " +
  "Preserve the original language(s) spoken. Prefix the transcript with a first line " +
  "'Language: <detected language>'. Output only that line and the transcript, no commentary.";

/**
 * One Gemini generateContent call with inline audio + a text prompt.
 * Tries the configured model then the fallback; for each model every key is
 * tried once — a 429 (or RESOURCE_EXHAUSTED) rotates to the next key. If every
 * key is rate-limited, throws CrmRateLimitError.
 */
async function callGeminiAudio(base64: string, mimeType: string, textPrompt: string): Promise<string> {
  const keys = getGeminiKeys();
  if (!keys.length) throw new Error('No Gemini API key configured. Add one in CRM Settings.');

  const models = [getCrmSetting('crm_gemini_model', 'gemini-2.5-flash'), 'gemini-2.0-flash'];
  const body = JSON.stringify({
    contents: [{
      role: 'user',
      parts: [
        { inline_data: { mime_type: mimeType, data: base64 } },
        { text: textPrompt },
      ],
    }],
    generationConfig: { maxOutputTokens: 8192 },
  });

  let lastErr: any = null;
  for (const model of models) {
    let allRateLimited = true;
    for (const key of keys) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
        );
        if (res.status === 429) {
          lastErr = new CrmRateLimitError('Gemini rate limit', 30);
          continue; // next key
        }
        const j = await res.json();
        if (!res.ok) {
          const msg = j?.error?.message || `Gemini HTTP ${res.status}`;
          if (/RESOURCE_EXHAUSTED|quota/i.test(msg)) {
            lastErr = new CrmRateLimitError(msg, 30);
            continue; // quota dressed as 400/403 — next key
          }
          allRateLimited = false;
          lastErr = new Error(msg);
          break; // model-level problem (bad model id etc.) → next model
        }
        const cand = j?.candidates?.[0];
        const text = cand?.content?.parts?.map((p: any) => p.text || '').join('') || '';
        if (text) return text;
        allRateLimited = false;
        lastErr = new Error(`Gemini returned an empty response (finishReason: ${cand?.finishReason || 'none'})`);
        break; // empty output won't improve on another key → next model
      } catch (e: any) {
        if (e instanceof CrmRateLimitError) throw e;
        allRateLimited = false;
        lastErr = e;
      }
    }
    if (allRateLimited && lastErr instanceof CrmRateLimitError) throw lastErr;
  }
  if (lastErr instanceof CrmRateLimitError) throw lastErr;
  throw lastErr || new Error('Gemini audio analysis failed');
}

export interface CallAnalysisResult {
  content: string;
  score: number | null;
  language: string | null;
}

/**
 * Analyze a tele-call recording: transcript + quality score + coaching.
 * `base64` is the raw audio file, base64-encoded; `language` is the staff's
 * UI language preference (the prompt still auto-detects spoken language).
 */
export async function analyzeCallRecording(opts: {
  base64: string;
  mimeType: string;
  language: string;
}): Promise<CallAnalysisResult> {
  const { base64, mimeType, language } = opts;
  const kbText = formatKbForPrompt(getKnowledge());
  const prompt = buildCallAnalysisPrompt(kbText, language);

  let content: string;
  if (getProvider() === 'claude') {
    // Claude cannot ingest audio — Gemini transcribes, Claude coaches.
    const transcript = await callGeminiAudio(base64, mimeType, TRANSCRIBE_PROMPT);
    content = await callCrmLlm({
      messages: [{ role: 'user', content: 'CALL TRANSCRIPT:\n' + transcript }],
      system: prompt,
      maxTokens: 8192,
    });
  } else {
    content = await callGeminiAudio(base64, mimeType, prompt);
  }

  const { score, language: detected } = parseCallAnalysis(content);
  return { content, score, language: detected };
}
