'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, apiJson } from '@/lib/api';

interface QrTable {
  id: string;
  table_number: string;
  zone: string;
  seats: number;
  qr_token: string;
  menu_url: string;
  qr_svg: string;
}

type Size = 'A4' | 'A5' | 'A6';
const SIZE_MM: Record<Size, { w: number; h: number; qr: number }> = {
  A4: { w: 210, h: 297, qr: 110 },
  A5: { w: 148, h: 210, qr: 78 },
  A6: { w: 105, h: 148, qr: 56 },
};

// ── Exact tokens from the QR-menu design (QR Code menu/atoms.jsx `C`) ──
const C = {
  paper: '#F1E8D0', card: '#FBF4DF', cardElev: '#FFF8E2',
  ink: '#231C12', inkSoft: '#5B4F3A', inkMute: '#8E8166',
  rule: 'rgba(35,28,18,0.10)', ruleSoft: 'rgba(35,28,18,0.06)',
  terra: '#B4502E', terraDeep: '#8E3A1E', terraTint: '#E9C6AB',
  forest: '#2D4A3A', forestTint: '#C9D6CB',
};
const SERIF = '"Instrument Serif", Georgia, serif';
const SANS = '"Geist", system-ui, sans-serif';
const MONO = '"Geist Mono", ui-monospace, monospace';
const FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500;600&display=swap';

export default function QrStandeesPage() {
  const [tables, setTables] = useState<QrTable[]>([]);
  const [brand, setBrand] = useState('Akan');
  const [tagline, setTagline] = useState('Scan · Browse · Order from your table');
  const [base, setBase] = useState('');
  const [size, setSize] = useState<Size>('A5');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [sel, setSel] = useState<Record<string, boolean>>({});

  const load = useCallback(async (origin?: string) => {
    setLoading(true); setErr('');
    try {
      const q = origin ? `?base=${encodeURIComponent(origin)}` : '';
      const data = await apiJson<{ tables: QrTable[]; base: string; brand: string }>(`/api/tables/qr${q}`);
      setTables(data.tables);
      setBrand(data.brand || 'Akan');
      if (!origin) setBase(data.base);
      setSel(prev => {
        const next: Record<string, boolean> = {};
        for (const t of data.tables) next[t.id] = prev[t.id] ?? true;
        return next;
      });
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

  const applyBase = () => load(base ? base.replace(/\/+$/, '') : undefined);
  const dims = SIZE_MM[size];
  const chosen = tables.filter(t => sel[t.id]);
  const allSelected = tables.length > 0 && tables.every(t => sel[t.id]);

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 20px 80px', fontFamily: SANS, color: C.ink }}>
      {/* Load the exact design fonts (the app shell only ships Inter). */}
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link rel="stylesheet" href={FONTS_HREF} />

      {/* ─── Print CSS: one standee per page at the chosen paper size ─── */}
      <style>{`
        @media print {
          @page { size: ${size}; margin: 0; }
          body { background: #fff !important; }
          .no-print { display: none !important; }
          .standee-sheet { display: block !important; }
          .standee {
            width: ${dims.w}mm; height: ${dims.h}mm;
            page-break-after: always; break-after: page;
            box-shadow: none !important;
            margin: 0 !important;
          }
          .standee:last-child { page-break-after: auto; }
        }
      `}</style>

      <div className="no-print">
        <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 1.6, textTransform: 'uppercase', color: C.terra, fontWeight: 500 }}>
          Customer QR Menu
        </div>
        <h1 style={{ fontFamily: SERIF, fontSize: 34, fontWeight: 400, margin: '2px 0 6px', color: C.ink, lineHeight: 1.05 }}>Table QR Standees</h1>
        <p style={{ color: C.inkSoft, margin: '0 0 20px', fontSize: 14, lineHeight: 1.5, maxWidth: 640 }}>
          Every table gets a unique QR code. Guests scan it to open the menu for that table and order —
          the table is identified automatically. Print these standees (one per page) or save as PDF.
        </p>

        {err && <div style={{ background: C.terraTint, color: C.terraDeep, padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 13, fontFamily: SANS }}>{err}</div>}

        {/* Controls */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end', background: C.card, border: `1px solid ${C.rule}`, borderRadius: 12, padding: 16, marginBottom: 20 }}>
          <label style={labelStyle}>
            Menu link base URL (the QR points here)
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={base} onChange={e => setBase(e.target.value)} placeholder="https://fnb.akanhyd.com" style={inputStyle} />
              <button onClick={applyBase} style={btn(C.ink)}>Apply</button>
            </div>
          </label>
          <label style={{ ...labelStyle, flex: 'unset' }}>
            Standee size
            <select value={size} onChange={e => setSize(e.target.value as Size)} style={inputStyle}>
              <option value="A4">A4 (largest)</option>
              <option value="A5">A5 (default)</option>
              <option value="A6">A6 (compact)</option>
            </select>
          </label>
          <label style={{ ...labelStyle, flex: '1 1 240px' }}>
            Tagline
            <input value={tagline} onChange={e => setTagline(e.target.value)} style={inputStyle} />
          </label>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 20 }}>
          <button onClick={() => regenerate('missing')} disabled={!!busy} style={btn(C.forest)}>
            {busy === 'missing' ? 'Working…' : 'Generate missing QR codes'}
          </button>
          <button onClick={() => regenerate('all')} disabled={!!busy} style={btn(C.terra)}>
            {busy === 'all' ? 'Working…' : 'Regenerate all'}
          </button>
          <button onClick={() => window.print()} disabled={!chosen.length} style={btn(C.ink)}>
            Print / Download PDF ({chosen.length} standee{chosen.length === 1 ? '' : 's'})
          </button>
          <button onClick={() => setSel(Object.fromEntries(tables.map(t => [t.id, !allSelected])))} style={btnGhost()}>
            {allSelected ? 'Deselect all' : 'Select all'}
          </button>
        </div>

        {loading && <p style={{ color: C.inkMute, fontFamily: SANS }}>Loading tables…</p>}
        {!loading && !tables.length && <p style={{ color: C.inkMute, fontFamily: SANS }}>No active tables yet. Add tables under Dine-In → Tables first.</p>}
      </div>

      {/* ─── Standee sheet (preview grid on screen, one-per-page in print) ─── */}
      <div className="standee-sheet" style={{ display: 'flex', flexWrap: 'wrap', gap: 20, justifyContent: 'center' }}>
        {chosen.map(t => (
          <div key={t.id} className="standee" style={standeeStyle(dims)}>
            <label className="no-print" style={{ position: 'absolute', top: 8, left: 10, fontSize: 11, color: C.inkMute, fontFamily: SANS, display: 'flex', gap: 5, alignItems: 'center' }}>
              <input type="checkbox" checked={!!sel[t.id]} onChange={e => setSel(s => ({ ...s, [t.id]: e.target.checked }))} /> include
            </label>

            {/* Brand wordmark — Instrument Serif, like the menu */}
            <div style={{ fontFamily: SERIF, fontSize: `${dims.w * 0.088}mm`, fontWeight: 400, letterSpacing: '0.2px', color: C.ink, textAlign: 'center', lineHeight: 1.02, maxWidth: '92%' }}>
              {brand}
            </div>

            <div style={{ marginTop: '3mm', textAlign: 'center' }}>
              <div style={{ fontFamily: MONO, fontSize: `${dims.w * 0.026}mm`, letterSpacing: `${dims.w * 0.006}mm`, color: C.terra, textTransform: 'uppercase', fontWeight: 500 }}>Table</div>
              <div style={{ fontFamily: SERIF, fontSize: `${dims.w * 0.185}mm`, fontWeight: 400, lineHeight: 1, color: C.ink }}>{t.table_number}</div>
              {t.zone && <div style={{ fontFamily: MONO, fontSize: `${dims.w * 0.022}mm`, letterSpacing: `${dims.w * 0.003}mm`, color: C.inkMute, textTransform: 'uppercase', marginTop: '1.5mm' }}>{t.zone}</div>}
            </div>

            {/* QR — dark ink modules on the warm card, framed subtly */}
            <div style={{ width: `${dims.qr}mm`, height: `${dims.qr}mm`, margin: '4.5mm 0', padding: '2mm', background: C.cardElev, borderRadius: '2mm', border: `1px solid ${C.rule}`, boxSizing: 'border-box' }}
              dangerouslySetInnerHTML={{ __html: t.qr_svg }} />

            <div style={{ textAlign: 'center' }}>
              <div style={{ fontFamily: SERIF, fontSize: `${dims.w * 0.05}mm`, fontWeight: 400, color: C.ink, lineHeight: 1.1 }}>Scan to view the menu &amp; order</div>
              <div style={{ fontFamily: SANS, fontSize: `${dims.w * 0.026}mm`, color: C.inkSoft, marginTop: '1.5mm', maxWidth: `${dims.w * 0.8}mm`, lineHeight: 1.4 }}>{tagline}</div>
            </div>

            <div className="no-print" style={{ position: 'absolute', bottom: 6, fontSize: 10, color: C.inkMute, fontFamily: MONO, wordBreak: 'break-all', padding: '0 8px', textAlign: 'center' }}>
              {t.menu_url}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5, fontFamily: MONO, fontSize: 10, letterSpacing: 0.8, textTransform: 'uppercase', color: C.inkMute, flex: '1 1 320px' };
const inputStyle: React.CSSProperties = { flex: 1, padding: '8px 10px', border: `1px solid ${C.rule}`, borderRadius: 8, fontSize: 13, fontFamily: SANS, color: C.ink, background: C.cardElev };

function btn(bg: string): React.CSSProperties {
  return { background: bg, color: C.paper, border: 'none', borderRadius: 999, padding: '10px 16px', fontSize: 13.5, fontWeight: 500, fontFamily: SANS, cursor: 'pointer', letterSpacing: 0.2 };
}
function btnGhost(): React.CSSProperties {
  return { background: 'transparent', color: C.ink, border: `1px solid ${C.rule}`, borderRadius: 999, padding: '10px 16px', fontSize: 13.5, fontWeight: 500, fontFamily: SANS, cursor: 'pointer' };
}

function standeeStyle(dims: { w: number; h: number }): React.CSSProperties {
  return {
    position: 'relative',
    width: `${dims.w}mm`, height: `${dims.h}mm`,
    background: C.card,
    backgroundImage: 'radial-gradient(circle at 18% 10%, rgba(180,80,46,0.14), transparent 55%), radial-gradient(circle at 85% 92%, rgba(45,74,58,0.16), transparent 55%)',
    border: `1px solid ${C.rule}`, borderRadius: 10,
    boxShadow: '0 4px 20px rgba(35,28,18,0.10)',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    padding: `${dims.w * 0.08}mm`, boxSizing: 'border-box',
  };
}
