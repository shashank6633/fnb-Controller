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

/** English-output transcription: auto-detect the spoken language (English /
 *  Telugu / Hindi / mix) but return the transcript TRANSLATED into English. */
const TRANSCRIBE_PROMPT_EN =
  "Transcribe this call recording. Label each speaker as STAFF or CUSTOMER. " +
  "Auto-detect the spoken language — it will be English, Telugu, or Hindi, or a mix. " +
  "Write the transcript TRANSLATED INTO NATURAL ENGLISH (translate meaning; do NOT " +
  "transliterate and do NOT keep Telugu/Devanagari script). Prefix with a first line " +
  "'Language: <detected spoken language>'. Output only that line and the English transcript, no commentary.";

/** Highest-priority language override appended to the analysis prompt when the
 *  caller wants an all-English scorecard (spoken language still auto-detected +
 *  reported in the `language` field). Used by the CRM Call-to-Table telephony
 *  analysis so managers always read English regardless of call language. */
const ENGLISH_OUTPUT_OVERRIDE =
  '\n\n## LANGUAGE — HIGHEST PRIORITY, OVERRIDES EVERY LANGUAGE INSTRUCTION ABOVE\n' +
  'The call may be in English, Telugu, or Hindi (or a mix). AUTO-DETECT the spoken language ' +
  'and report it in the "language" field. But write EVERYTHING you output — every "transcript" ' +
  'text entry, all "coaching", "summary", "moments" and "flags" — in ENGLISH. Translate any ' +
  'Telugu/Hindi speech into natural English; do NOT transliterate and do NOT keep the original script.';

/**
 * Hard override appended to buildCallAnalysisPrompt() so the model returns a
 * machine-parseable scorecard instead of markdown. If the model ignores it,
 * parseStructuredAnalysis() returns null and we fall back to the legacy
 * markdown behavior.
 */
const JSON_OUTPUT_INSTRUCTION =
  '\n\n## STRICT OUTPUT FORMAT — OVERRIDES THE "RESPONSE FORMAT" SECTION ABOVE\n' +
  'Respond ONLY with a JSON object, no markdown fences, exactly this shape: ' +
  '{"language":"English|Telugu|Hindi|…","call_type":"complaint|reservation|enquiry|event|takeaway|other",' +
  '"outcome":"resolved|escalate|follow_up|lost","flags":["review threat",…] (0-3 short red flags, empty if none),' +
  '"tags":["biryani",…] (0-3 topic tags),"overall_score":0-100,' +
  '"dimensions":{"tone":0-10,"greeting":0-10,"listening":0-10,"accurate_info":0-10,"hold_etiquette":0-10,' +
  '"upsell_attempt":0-10,"closing_next_step":0-10,"objection_handling":0-10},' +
  '"coaching":["…"] (3-5 specific bullets),' +
  '"moments":[{"type":"upsell_miss|good_save|policy_error|rude|hold_issue","label":"…","at":"m:ss or null"}] (0-4),' +
  '"transcript":[{"speaker":"GUEST|AGENT","text":"…"}],"summary":"one line"}';

export const CALL_DIMENSION_KEYS = [
  'tone',
  'greeting',
  'listening',
  'accurate_info',
  'hold_etiquette',
  'upsell_attempt',
  'closing_next_step',
  'objection_handling',
] as const;
export type CallDimensionKey = (typeof CALL_DIMENSION_KEYS)[number];

export interface CallAnalysisStructured {
  language: string;
  call_type: string;
  outcome: string;
  flags: string[];
  tags: string[];
  overall_score: number;
  dimensions: Record<CallDimensionKey, number>;
  coaching: string[];
  moments: { type: string; label: string; at: string | null }[];
  transcript: { speaker: string; text: string }[];
  summary: string;
}

function clampNum(v: unknown, min: number, max: number): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

function strArr(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .slice(0, max)
    .map((x) => x.trim());
}

/**
 * Strip fences if any → JSON.parse → validate dimension keys + clamp numbers.
 * Returns null on any structural failure (caller falls back to raw text).
 */
export function parseStructuredAnalysis(raw: string): CallAnalysisStructured | null {
  let text = raw.trim();
  const fenced = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/);
  if (fenced) text = fenced[1].trim();
  // Tolerate stray prose around the object: parse first "{" → last "}".
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let obj: any;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  const rawDims = obj.dimensions;
  if (!rawDims || typeof rawDims !== 'object' || Array.isArray(rawDims)) return null;
  const dimensions = {} as Record<CallDimensionKey, number>;
  for (const key of CALL_DIMENSION_KEYS) {
    const v = clampNum(rawDims[key], 0, 10);
    if (v === null) return null; // every dimension must be present + numeric
    dimensions[key] = Math.round(v * 10) / 10;
  }

  let overall = clampNum(obj.overall_score, 0, 100);
  if (overall === null) {
    // Derive from the (validated) dimensions rather than dropping the scorecard.
    const sum = CALL_DIMENSION_KEYS.reduce((acc, k) => acc + dimensions[k], 0);
    overall = (sum / CALL_DIMENSION_KEYS.length) * 10;
  }

  const moments = (Array.isArray(obj.moments) ? obj.moments : [])
    .filter((m: any) => m && typeof m === 'object' && typeof m.label === 'string')
    .slice(0, 4)
    .map((m: any) => ({
      type: typeof m.type === 'string' ? m.type : 'note',
      label: m.label,
      at: typeof m.at === 'string' && m.at.trim() ? m.at.trim() : null,
    }));

  const transcript = (Array.isArray(obj.transcript) ? obj.transcript : [])
    .filter((t: any) => t && typeof t === 'object' && typeof t.text === 'string' && t.text.trim())
    .map((t: any) => ({
      speaker: typeof t.speaker === 'string' && t.speaker.trim() ? t.speaker.trim().toUpperCase() : 'AGENT',
      text: t.text.trim(),
    }));

  return {
    language: typeof obj.language === 'string' && obj.language.trim() ? obj.language.trim() : 'Unknown',
    call_type: typeof obj.call_type === 'string' && obj.call_type.trim() ? obj.call_type.trim() : 'other',
    outcome: typeof obj.outcome === 'string' && obj.outcome.trim() ? obj.outcome.trim() : 'follow_up',
    flags: strArr(obj.flags, 3),
    tags: strArr(obj.tags, 3),
    overall_score: Math.round(overall),
    dimensions,
    coaching: strArr(obj.coaching, 5),
    moments,
    transcript,
    summary: typeof obj.summary === 'string' ? obj.summary.trim() : '',
  };
}

/**
 * One Gemini generateContent call with inline audio + a text prompt.
 * Tries the configured model then the fallback; for each model every key is
 * tried once — a 429 (or RESOURCE_EXHAUSTED) rotates to the next key. If every
 * key is rate-limited, throws CrmRateLimitError.
 */
async function callGeminiAudio(base64: string, mimeType: string, textPrompt: string, jsonOutput = false): Promise<string> {
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
    generationConfig: {
      maxOutputTokens: 8192,
      ...(jsonOutput ? { responseMimeType: 'application/json' } : {}),
    },
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
  /** Structured CallPilot-style scorecard, or null when the model ignored the JSON contract. */
  analysis: CallAnalysisStructured | null;
  content: string;
  score: number | null;
  language: string | null;
}

/**
 * Analyze a tele-call recording: structured scorecard (transcript + dimension
 * scores + coaching), falling back to the legacy markdown analysis when the
 * model does not return valid JSON.
 * `base64` is the raw audio file, base64-encoded; `language` is the staff's
 * UI language preference (the prompt still auto-detects spoken language).
 */
export async function analyzeCallRecording(opts: {
  base64: string;
  mimeType: string;
  language: string;
  /** 'english' → detect spoken language (English/Telugu/Hindi) but return the
   *  transcript + scorecard in English. Default 'auto' keeps the original
   *  language (unchanged behavior for existing callers). */
  outputLanguage?: 'auto' | 'english';
}): Promise<CallAnalysisResult> {
  const { base64, mimeType, language } = opts;
  const english = opts.outputLanguage === 'english';
  const kbText = formatKbForPrompt(getKnowledge());
  const prompt = buildCallAnalysisPrompt(kbText, language) + JSON_OUTPUT_INSTRUCTION + (english ? ENGLISH_OUTPUT_OVERRIDE : '');

  let content: string;
  if (getProvider() === 'claude') {
    // Claude cannot ingest audio — Gemini transcribes, Claude coaches.
    const transcript = await callGeminiAudio(base64, mimeType, english ? TRANSCRIBE_PROMPT_EN : TRANSCRIBE_PROMPT);
    content = await callCrmLlm({
      messages: [{ role: 'user', content: 'CALL TRANSCRIPT:\n' + transcript }],
      system: prompt,
      maxTokens: 8192,
    });
  } else {
    content = await callGeminiAudio(base64, mimeType, prompt, true);
  }

  const analysis = parseStructuredAnalysis(content);
  if (analysis) {
    return { analysis, content, score: analysis.overall_score, language: analysis.language };
  }

  // Legacy fallback — same behavior as before the structured upgrade.
  const { score, language: detected } = parseCallAnalysis(content);
  return { analysis: null, content, score, language: detected };
}
