'use client';

/**
 * AKAN CRM — CallPilot-style structured call-analysis scorecard.
 *
 * Renders the {kind:'call_analysis', ...} JSON payload produced by
 * /api/crm/chat/analyze-recording: header chips + big score, summary,
 * an 8-axis SVG radar chart of the quality dimensions, coaching bullets,
 * key moments, and the full speaker-labelled transcript.
 *
 * Self-contained on purpose — no imports from server-side CRM modules.
 */

const DIMENSION_AXES: { key: string; label: string }[] = [
  { key: 'tone', label: 'tone' },
  { key: 'greeting', label: 'greeting' },
  { key: 'listening', label: 'listening' },
  { key: 'accurate_info', label: 'accurate info' },
  { key: 'hold_etiquette', label: 'hold etiquette' },
  { key: 'upsell_attempt', label: 'upsell attempt' },
  { key: 'closing_next_step', label: 'closing next step' },
  { key: 'objection_handling', label: 'objection handling' },
];

export interface CallAnalysisData {
  kind?: string;
  language?: string;
  call_type?: string;
  outcome?: string;
  flags?: string[];
  tags?: string[];
  overall_score?: number;
  dimensions?: Record<string, number>;
  coaching?: string[];
  moments?: { type?: string; label?: string; at?: string | null }[];
  transcript?: { speaker?: string; text?: string }[];
  summary?: string;
  response_time_ms?: number;
}

/* ── radar chart (pure inline SVG) ────────────────────────────────────── */

const CX = 160;
const CY = 122;
const R = 80;
const LABEL_R = 96;

function axisPoint(i: number, radius: number): { x: number; y: number } {
  const a = ((45 * i - 90) * Math.PI) / 180; // start at top, clockwise
  return { x: CX + radius * Math.cos(a), y: CY + radius * Math.sin(a) };
}

function ringPoints(radius: number): string {
  return DIMENSION_AXES
    .map((_, i) => { const p = axisPoint(i, radius); return `${p.x.toFixed(1)},${p.y.toFixed(1)}`; })
    .join(' ');
}

/** Split long labels into at most 2 lines near the middle word boundary. */
function labelLines(label: string): string[] {
  if (label.length <= 10) return [label];
  const words = label.split(' ');
  if (words.length === 1) return [label];
  let first = words[0];
  let idx = 1;
  while (idx < words.length - 1 && (first.length + words[idx].length + 1) <= label.length / 2) {
    first += ' ' + words[idx];
    idx += 1;
  }
  return [first, words.slice(idx).join(' ')];
}

function RadarChart({ dimensions }: { dimensions: Record<string, number> }) {
  const valuePoints = DIMENSION_AXES
    .map((axis, i) => {
      const v = Math.min(10, Math.max(0, Number(dimensions[axis.key]) || 0));
      const p = axisPoint(i, (v / 10) * R);
      return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg
      viewBox="0 0 320 244"
      className="w-full max-w-[300px] mx-auto"
      role="img"
      aria-label="Call quality radar chart across 8 dimensions"
    >
      {/* 3 concentric octagon grid rings */}
      {[R / 3, (2 * R) / 3, R].map((r, i) => (
        <polygon key={i} points={ringPoints(r)} fill="none" stroke="#E8D5C4" strokeWidth={1} />
      ))}
      {/* axis spokes */}
      {DIMENSION_AXES.map((_, i) => {
        const p = axisPoint(i, R);
        return <line key={i} x1={CX} y1={CY} x2={p.x} y2={p.y} stroke="#F0E4D6" strokeWidth={1} />;
      })}
      {/* value polygon */}
      <polygon points={valuePoints} fill="rgba(139,92,246,.25)" stroke="#8b5cf6" strokeWidth={1.5} />
      {DIMENSION_AXES.map((axis, i) => {
        const v = Math.min(10, Math.max(0, Number(dimensions[axis.key]) || 0));
        const p = axisPoint(i, (v / 10) * R);
        return <circle key={axis.key} cx={p.x} cy={p.y} r={2.2} fill="#8b5cf6" />;
      })}
      {/* axis labels */}
      {DIMENSION_AXES.map((axis, i) => {
        const p = axisPoint(i, LABEL_R);
        const cos = Math.cos(((45 * i - 90) * Math.PI) / 180);
        const anchor = cos > 0.3 ? 'start' : cos < -0.3 ? 'end' : 'middle';
        const lines = labelLines(axis.label);
        const y0 = p.y - (lines.length - 1) * 5.5;
        return (
          <text
            key={axis.key}
            x={p.x}
            y={y0}
            textAnchor={anchor}
            dominantBaseline="middle"
            fontSize={10}
            fill="#8B7355"
          >
            {lines.map((line, li) => (
              <tspan key={li} x={p.x} dy={li === 0 ? 0 : 11}>{line}</tspan>
            ))}
          </text>
        );
      })}
    </svg>
  );
}

/* ── small helpers ────────────────────────────────────────────────────── */

function scoreColor(score: number): string {
  if (score >= 80) return 'text-emerald-600';
  if (score >= 60) return 'text-amber-600';
  return 'text-red-600';
}

function momentColor(type: string): string {
  if (type === 'good_save') return 'text-emerald-700';
  if (type === 'policy_error' || type === 'rude') return 'text-red-700';
  return 'text-amber-700';
}

function pretty(s: string): string {
  return s.replace(/_/g, ' ');
}

/* ── card ─────────────────────────────────────────────────────────────── */

export default function CallAnalysisCard({ data }: { data: CallAnalysisData }) {
  const score = Math.min(100, Math.max(0, Math.round(Number(data.overall_score) || 0)));
  const flags = Array.isArray(data.flags) ? data.flags : [];
  const tags = Array.isArray(data.tags) ? data.tags : [];
  const coaching = Array.isArray(data.coaching) ? data.coaching : [];
  const moments = Array.isArray(data.moments) ? data.moments : [];
  const transcript = Array.isArray(data.transcript) ? data.transcript : [];
  const dimensions = data.dimensions && typeof data.dimensions === 'object' ? data.dimensions : {};

  return (
    <div className="w-full bg-white border border-[#E8D5C4] rounded-xl p-4 text-left">
      {/* Header: chips + score */}
      <div className="flex flex-wrap items-center gap-2">
        {data.call_type && (
          <span className="inline-flex items-center bg-purple-50 text-purple-700 text-[11px] font-semibold uppercase tracking-wide rounded-full px-2.5 py-0.5">
            {pretty(data.call_type)}
          </span>
        )}
        {data.outcome && (
          <span className="text-xs text-[#6B5744]">
            outcome: <span className="font-semibold text-[#2D1B0E]">{pretty(data.outcome)}</span>
          </span>
        )}
        {flags.map((f, i) => (
          <span key={`f${i}`} className="inline-flex items-center bg-red-50 text-red-700 border border-red-200 text-[11px] rounded-full px-2 py-0.5">
            ► {f}
          </span>
        ))}
        {tags.map((t, i) => (
          <span key={`t${i}`} className="inline-flex items-center border border-[#E8D5C4] text-[#6B5744] text-[11px] rounded-full px-2 py-0.5">
            {t}
          </span>
        ))}
        <span className={`ml-auto font-mono text-2xl font-bold leading-none ${scoreColor(score)}`}>
          {score}<span className="text-sm font-semibold text-[#8B7355]">/100</span>
        </span>
      </div>

      {/* Summary */}
      {data.summary && (
        <p className="text-sm text-[#2D1B0E] mt-2.5">{data.summary}</p>
      )}
      {data.language && (
        <p className="text-[11px] text-[#8B7355] mt-1">Language: {data.language}</p>
      )}

      {/* Radar + coaching/moments */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
        <div className="flex items-center justify-center">
          <RadarChart dimensions={dimensions} />
        </div>

        <div className="min-w-0">
          {coaching.length > 0 && (
            <>
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[#8B7355] mb-1.5">Coaching</h3>
              <ul className="space-y-1.5">
                {coaching.map((c, i) => (
                  // flex-nowrap opts out of the mobile .flex.gap-2 auto-wrap in globals.css
                  <li key={i} className="text-sm text-[#2D1B0E] flex flex-nowrap gap-2">
                    <span className="text-[#af4408] shrink-0">•</span>
                    <span className="min-w-0 break-words">{c}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {moments.length > 0 && (
            <div className="mt-3 space-y-1.5">
              {moments.map((m, i) => (
                <div
                  key={i}
                  className="flex flex-nowrap items-baseline gap-2 border border-[#E8D5C4] rounded-lg px-2.5 py-1.5 text-xs"
                >
                  <span className={`font-semibold shrink-0 ${momentColor(m.type || '')}`}>
                    ► {pretty(m.type || 'note')}:
                  </span>
                  <span className="text-[#2D1B0E] min-w-0 break-words flex-1">{m.label}</span>
                  {m.at && <span className="font-mono text-[#8B7355] shrink-0">{m.at}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Transcript */}
      {transcript.length > 0 && (
        <div className="mt-4">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[#8B7355] mb-1.5">Transcript</h3>
          <div className="border border-[#E8D5C4] rounded-lg overflow-hidden max-h-80 overflow-y-auto">
            {transcript.map((t, i) => {
              const speaker = (t.speaker || 'AGENT').toUpperCase();
              const isGuest = speaker === 'GUEST' || speaker === 'CUSTOMER';
              return (
                <div key={i} className={`px-3 py-2 text-sm ${i % 2 === 0 ? 'bg-[#FFF8F0]' : 'bg-white'}`}>
                  <span className={`font-bold mr-2 ${isGuest ? 'text-emerald-700' : 'text-[#2D1B0E]'}`}>
                    {speaker}
                  </span>
                  <span className="text-[#2D1B0E] break-words">{t.text}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
