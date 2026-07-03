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
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 20px 80px' }}>
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
            box-shadow: none !important; border: none !important;
            margin: 0 !important;
          }
          .standee:last-child { page-break-after: auto; }
        }
      `}</style>

      <div className="no-print">
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: '0 0 4px' }}>Table QR Standees</h1>
        <p style={{ color: '#666', margin: '0 0 20px', fontSize: 14 }}>
          Every table gets a unique QR code. Guests scan it to open the menu for that table and order —
          the table is identified automatically. Print these standees (one per page) or save as PDF.
        </p>

        {err && <div style={{ background: '#fee', color: '#a00', padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 13 }}>{err}</div>}

        {/* Controls */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end', background: '#f7f6f2', border: '1px solid #e7e4dc', borderRadius: 12, padding: 16, marginBottom: 20 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#555', flex: '1 1 320px' }}>
            Menu link base URL (the QR points here)
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={base} onChange={e => setBase(e.target.value)} placeholder="https://fnb.akanhyd.com"
                style={{ flex: 1, padding: '8px 10px', border: '1px solid #ccc', borderRadius: 8, fontSize: 13 }} />
              <button onClick={applyBase} style={btn('#333')}>Apply</button>
            </div>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#555' }}>
            Standee size
            <select value={size} onChange={e => setSize(e.target.value as Size)}
              style={{ padding: '8px 10px', border: '1px solid #ccc', borderRadius: 8, fontSize: 13 }}>
              <option value="A4">A4 (largest)</option>
              <option value="A5">A5 (default)</option>
              <option value="A6">A6 (compact)</option>
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#555', flex: '1 1 240px' }}>
            Tagline
            <input value={tagline} onChange={e => setTagline(e.target.value)}
              style={{ padding: '8px 10px', border: '1px solid #ccc', borderRadius: 8, fontSize: 13 }} />
          </label>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 20 }}>
          <button onClick={() => regenerate('missing')} disabled={!!busy} style={btn('#2d4a3a')}>
            {busy === 'missing' ? 'Working…' : 'Generate missing QR codes'}
          </button>
          <button onClick={() => regenerate('all')} disabled={!!busy} style={btn('#b4502e')}>
            {busy === 'all' ? 'Working…' : 'Regenerate all'}
          </button>
          <button onClick={() => window.print()} disabled={!chosen.length} style={btn('#1f6feb')}>
            Print / Download PDF ({chosen.length} standee{chosen.length === 1 ? '' : 's'})
          </button>
          <button onClick={() => setSel(Object.fromEntries(tables.map(t => [t.id, !allSelected])))}
            style={btn('#555')}>{allSelected ? 'Deselect all' : 'Select all'}</button>
        </div>

        {loading && <p style={{ color: '#888' }}>Loading tables…</p>}
        {!loading && !tables.length && <p style={{ color: '#888' }}>No active tables yet. Add tables under Dine-In → Tables first.</p>}
      </div>

      {/* ─── Standee sheet (preview grid on screen, one-per-page in print) ─── */}
      <div className="standee-sheet" style={{ display: 'flex', flexWrap: 'wrap', gap: 20, justifyContent: 'center' }}>
        {chosen.map(t => (
          <div key={t.id} className="standee" style={standeeStyle(dims)}>
            <label className="no-print" style={{ position: 'absolute', top: 8, left: 10, fontSize: 11, color: '#999', display: 'flex', gap: 5, alignItems: 'center' }}>
              <input type="checkbox" checked={!!sel[t.id]} onChange={e => setSel(s => ({ ...s, [t.id]: e.target.checked }))} /> include
            </label>

            <div style={{ fontFamily: 'Georgia, "Times New Roman", serif', fontSize: `${dims.w * 0.088}mm`, fontWeight: 600, letterSpacing: '0.3px', color: '#1f1a14', textAlign: 'center', lineHeight: 1.02, maxWidth: '92%' }}>
              {brand}
            </div>

            <div style={{ marginTop: '3mm', textAlign: 'center' }}>
              <div style={{ fontSize: `${dims.w * 0.028}mm`, letterSpacing: '3px', color: '#b4502e', textTransform: 'uppercase' }}>Table</div>
              <div style={{ fontFamily: 'Georgia, serif', fontSize: `${dims.w * 0.17}mm`, lineHeight: 1, color: '#1f1a14' }}>{t.table_number}</div>
              {t.zone && <div style={{ fontSize: `${dims.w * 0.026}mm`, color: '#999', marginTop: '1mm' }}>{t.zone}</div>}
            </div>

            <div style={{ width: `${dims.qr}mm`, height: `${dims.qr}mm`, margin: '4mm 0' }}
              dangerouslySetInnerHTML={{ __html: t.qr_svg }} />

            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: `${dims.w * 0.033}mm`, fontWeight: 600, color: '#1f1a14' }}>Scan to view the menu &amp; order</div>
              <div style={{ fontSize: `${dims.w * 0.026}mm`, color: '#888', marginTop: '1.5mm', maxWidth: `${dims.w * 0.8}mm` }}>{tagline}</div>
            </div>

            <div className="no-print" style={{ position: 'absolute', bottom: 6, fontSize: 10, color: '#bbb', wordBreak: 'break-all', padding: '0 8px', textAlign: 'center' }}>
              {t.menu_url}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function btn(bg: string): React.CSSProperties {
  return { background: bg, color: '#fff', border: 'none', borderRadius: 8, padding: '9px 14px', fontSize: 13, fontWeight: 500, cursor: 'pointer' };
}

function standeeStyle(dims: { w: number; h: number }): React.CSSProperties {
  return {
    position: 'relative',
    width: `${dims.w}mm`, height: `${dims.h}mm`,
    background: '#fbf4df',
    backgroundImage: 'radial-gradient(circle at 18% 10%, rgba(180,80,46,0.10), transparent 55%), radial-gradient(circle at 85% 92%, rgba(45,74,58,0.12), transparent 55%)',
    border: '1px solid #e7e4dc', borderRadius: 10,
    boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    padding: `${dims.w * 0.08}mm`, boxSizing: 'border-box',
  };
}
