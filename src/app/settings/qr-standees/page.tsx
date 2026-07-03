'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, apiJson } from '@/lib/api';

interface QrTable { id: string; table_number: string; zone: string; seats: number; qr_token: string; menu_url: string; qr_svg: string; }

// QR/label placement on the "Akan 4×6" template (fractions of the page) —
// kept in sync with TPL in /api/tables/qr/pdf so preview == printed output.
const TPL_QR = { left: 26.84, top: 23.42, width: 46.53 }; // %
const TPL_LABEL_TOP = 59.3;                               // %
type Size = 'A4' | 'A5' | 'A6';

// QR-menu design tokens (QR Code menu/atoms.jsx `C`).
const C = {
  paper: '#F1E8D0', card: '#FBF4DF', cardElev: '#FFF8E2',
  ink: '#231C12', inkSoft: '#5B4F3A', inkMute: '#8E8166',
  rule: 'rgba(35,28,18,0.10)', terra: '#B4502E', terraDeep: '#8E3A1E', terraTint: '#E9C6AB',
  forest: '#2D4A3A',
};
const SERIF = '"Instrument Serif", Georgia, serif';
const SANS = '"Geist", system-ui, sans-serif';
const MONO = '"Geist Mono", ui-monospace, monospace';
const FONTS_HREF = 'https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500;600&display=swap';

export default function QrStandeesPage() {
  const [tables, setTables] = useState<QrTable[]>([]);
  const [hasTemplate, setHasTemplate] = useState(false);
  const [tagline, setTagline] = useState('Scan · Browse · Order from your table');
  const [base, setBase] = useState('');
  const [size, setSize] = useState<Size>('A5');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [nonce, setNonce] = useState(0); // bump to force the preview iframe to reload

  const load = useCallback(async (origin?: string) => {
    setLoading(true); setErr('');
    try {
      const q = origin ? `?base=${encodeURIComponent(origin)}` : '';
      const data = await apiJson<{ tables: QrTable[]; base: string; hasTemplate: boolean }>(`/api/tables/qr${q}`);
      setTables(data.tables);
      setHasTemplate(!!data.hasTemplate);
      if (!origin) setBase(data.base);
      setSel(prev => { const next: Record<string, boolean> = {}; for (const t of data.tables) next[t.id] = prev[t.id] ?? true; return next; });
      setNonce(n => n + 1);
    } catch (e: any) { setErr(e.message || 'Failed to load'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const regenerate = async (mode: 'missing' | 'all') => {
    if (mode === 'all' && !confirm('Regenerate ALL QR codes? Any standees already printed will stop working and must be reprinted.')) return;
    setBusy(mode); setErr('');
    try {
      const r = await apiJson<{ updated: number }>('/api/tables/qr', { method: 'POST', body: { mode } });
      await load(base && base !== window.location.origin ? base : undefined);
      setBusy(''); alert(`${r.updated} QR code${r.updated === 1 ? '' : 's'} ${mode === 'all' ? 'regenerated' : 'generated'}.`);
    } catch (e: any) { setErr(e.message || 'Failed'); setBusy(''); }
  };

  const chosen = useMemo(() => tables.filter(t => sel[t.id]), [tables, sel]);
  const allSelected = tables.length > 0 && tables.every(t => sel[t.id]);
  const cleanBase = base ? base.replace(/\/+$/, '') : '';

  // The PDF endpoint auto-uses the uploaded template when present; size/tagline
  // only matter for the generated fallback.
  const pdfUrl = (opts: { dl?: boolean; one?: string }) => {
    const p = new URLSearchParams();
    if (!hasTemplate) { p.set('size', size); if (tagline) p.set('tagline', tagline); }
    if (opts.one) p.set('one', opts.one);
    else { const ids = chosen.map(t => t.id).join(','); if (ids) p.set('tables', ids); }
    if (cleanBase) p.set('base', cleanBase);
    if (opts.dl) p.set('download', '1');
    p.set('_', String(nonce));
    return `/api/tables/qr/pdf?${p.toString()}`;
  };
  const downloadPdf = () => { const a = document.createElement('a'); a.href = pdfUrl({ dl: true }); a.rel = 'noopener'; a.click(); };
  const previewUrl = chosen.length ? pdfUrl({ one: chosen[0].id }) : '';

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 20px 80px', fontFamily: SANS, color: C.ink }}>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link rel="stylesheet" href={FONTS_HREF} />

      <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 1.6, textTransform: 'uppercase', color: C.terra, fontWeight: 500 }}>Customer QR Menu</div>
      <h1 style={{ fontFamily: SERIF, fontSize: 34, fontWeight: 400, margin: '2px 0 6px', color: C.ink, lineHeight: 1.05 }}>Table QR Standees</h1>
      <p style={{ color: C.inkSoft, margin: '0 0 16px', fontSize: 14, lineHeight: 1.5, maxWidth: 640 }}>
        Every table gets a unique QR code. Guests scan it to open the menu for that table and order — the table is
        identified automatically. Each standee is one page in the PDF; print or save it at the exact size.
      </p>

      {hasTemplate && (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: C.cardElev, border: `1px solid ${C.rule}`, borderLeft: `3px solid ${C.terra}`, borderRadius: 8, padding: '8px 12px', marginBottom: 16, fontSize: 13 }}>
          <span style={{ fontSize: 15 }}>🎨</span>
          <span>Using <b>your uploaded design</b> (Akan standee, 4×6 in). Each table gets its own QR + number stamped onto it — nothing else changes.</span>
        </div>
      )}
      {err && <div style={{ background: C.terraTint, color: C.terraDeep, padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 13 }}>{err}</div>}

      {/* Controls */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end', background: C.card, border: `1px solid ${C.rule}`, borderRadius: 12, padding: 16, marginBottom: 16 }}>
        <label style={labelStyle}>
          Menu link base URL (the QR points here)
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={base} onChange={e => setBase(e.target.value)} placeholder="https://fnb.akanhyd.com" style={inputStyle} />
            <button onClick={() => load(cleanBase || undefined)} style={btn(C.ink)}>Apply</button>
          </div>
        </label>
        {!hasTemplate && (
          <>
            <label style={{ ...labelStyle, flex: 'unset' }}>
              Standee size
              <select value={size} onChange={e => { setSize(e.target.value as Size); setNonce(n => n + 1); }} style={inputStyle}>
                <option value="A4">A4 (largest)</option><option value="A5">A5 (default)</option><option value="A6">A6 (compact)</option>
              </select>
            </label>
            <label style={{ ...labelStyle, flex: '1 1 240px' }}>
              Tagline
              <input value={tagline} onChange={e => setTagline(e.target.value)} onBlur={() => setNonce(n => n + 1)} style={inputStyle} />
            </label>
          </>
        )}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 20 }}>
        <button onClick={() => regenerate('missing')} disabled={!!busy} style={btn(C.forest)}>{busy === 'missing' ? 'Working…' : 'Generate missing QR codes'}</button>
        <button onClick={() => regenerate('all')} disabled={!!busy} style={btn(C.terra)}>{busy === 'all' ? 'Working…' : 'Regenerate all'}</button>
        <button onClick={downloadPdf} disabled={!chosen.length} style={btn(C.ink)}>Download PDF ({chosen.length} table{chosen.length === 1 ? '' : 's'})</button>
        <button onClick={() => window.open(pdfUrl({}), '_blank')} disabled={!chosen.length} style={btnGhost()}>Print</button>
        <button onClick={() => setSel(Object.fromEntries(tables.map(t => [t.id, !allSelected])))} style={btnGhost()}>{allSelected ? 'Deselect all' : 'Select all'}</button>
      </div>

      {loading && <p style={{ color: C.inkMute }}>Loading tables…</p>}
      {!loading && !tables.length && <p style={{ color: C.inkMute }}>No active tables yet. Add tables under Dine-In → Tables first.</p>}

      {!!tables.length && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, 320px) 1fr', gap: 24, alignItems: 'start' }}>
          {/* Table selection */}
          <div>
            <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: 1.4, textTransform: 'uppercase', color: C.inkSoft, marginBottom: 8 }}>Tables ({chosen.length}/{tables.length})</div>
            <div style={{ border: `1px solid ${C.rule}`, borderRadius: 10, overflow: 'hidden' }}>
              {tables.map(t => (
                <label key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderBottom: `1px solid ${C.rule}`, cursor: 'pointer', background: chosen[0]?.id === t.id ? C.cardElev : 'transparent' }}>
                  <input type="checkbox" checked={!!sel[t.id]} onChange={e => setSel(s => ({ ...s, [t.id]: e.target.checked }))} />
                  <span style={{ fontFamily: SERIF, fontSize: 17 }}>Table {t.table_number}</span>
                  {t.zone && <span style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: 0.6, color: C.inkMute, textTransform: 'uppercase' }}>{t.zone}</span>}
                </label>
              ))}
            </div>
          </div>

          {/* WYSIWYG preview — the actual PDF for the first selected table */}
          <div>
            <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: 1.4, textTransform: 'uppercase', color: C.inkSoft, marginBottom: 8 }}>
              Preview {chosen[0] ? `· Table ${chosen[0].table_number}` : ''} <span style={{ textTransform: 'none', letterSpacing: 0, color: C.inkMute }}>— all {chosen.length} selected go in the PDF</span>
            </div>
            {!chosen[0] ? (
              <div style={{ color: C.inkMute, fontSize: 13, padding: 40, textAlign: 'center', border: `1px dashed ${C.rule}`, borderRadius: 10 }}>Select at least one table to preview.</div>
            ) : hasTemplate ? (
              // WYSIWYG overlay: your template image + this table's QR + number,
              // at the same positions the PDF stamps them.
              <div style={{ position: 'relative', width: 320, height: 480, backgroundImage: 'url(/standee-template-preview.png)', backgroundSize: 'cover', backgroundPosition: 'center', borderRadius: 10, border: `1px solid ${C.rule}`, overflow: 'hidden' }}>
                <img alt={`QR for table ${chosen[0].table_number}`} src={`data:image/svg+xml;utf8,${encodeURIComponent(chosen[0].qr_svg)}`}
                  style={{ position: 'absolute', left: `${TPL_QR.left}%`, top: `${TPL_QR.top}%`, width: `${TPL_QR.width}%`, aspectRatio: '1 / 1', display: 'block' }} />
                <div style={{ position: 'absolute', left: 0, right: 0, top: `${TPL_LABEL_TOP}%`, textAlign: 'center', color: '#FBE8CF', fontFamily: SANS, fontWeight: 700, fontSize: 19, letterSpacing: '0.04em' }}>TABLE {chosen[0].table_number}</div>
              </div>
            ) : (
              <iframe key={previewUrl} src={previewUrl} title="Standee preview" style={{ width: '100%', height: 620, border: `1px solid ${C.rule}`, borderRadius: 10, background: C.card }} />
            )}
            {chosen[0] && <div style={{ fontFamily: MONO, fontSize: 10.5, color: C.inkMute, marginTop: 6, wordBreak: 'break-all' }}>{chosen[0].menu_url}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

const labelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5, fontFamily: MONO, fontSize: 10, letterSpacing: 0.8, textTransform: 'uppercase', color: C.inkMute, flex: '1 1 320px' };
const inputStyle: React.CSSProperties = { flex: 1, padding: '8px 10px', border: `1px solid ${C.rule}`, borderRadius: 8, fontSize: 13, fontFamily: SANS, color: C.ink, background: C.cardElev };
function btn(bg: string): React.CSSProperties { return { background: bg, color: C.paper, border: 'none', borderRadius: 999, padding: '10px 16px', fontSize: 13.5, fontWeight: 500, fontFamily: SANS, cursor: 'pointer', letterSpacing: 0.2 }; }
function btnGhost(): React.CSSProperties { return { background: 'transparent', color: C.ink, border: `1px solid ${C.rule}`, borderRadius: 999, padding: '10px 16px', fontSize: 13.5, fontWeight: 500, fontFamily: SANS, cursor: 'pointer' }; }
