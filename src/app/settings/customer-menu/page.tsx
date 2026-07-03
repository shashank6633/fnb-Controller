'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, apiJson } from '@/lib/api';

type Style = 'thumbnails' | 'chips';

// QR-menu design tokens (QR Code menu/atoms.jsx `C`).
const C = {
  paper: '#F1E8D0', card: '#FBF4DF', cardElev: '#FFF8E2',
  ink: '#231C12', inkSoft: '#5B4F3A', inkMute: '#8E8166',
  rule: 'rgba(35,28,18,0.10)', ruleSoft: 'rgba(35,28,18,0.055)',
  terra: '#B4502E', terraDeep: '#8E3A1E', terraTint: '#E9C6AB', forest: '#2D4A3A',
};
const SERIF = '"Instrument Serif", Georgia, serif';
const SANS = '"Geist", system-ui, sans-serif';
const MONO = '"Geist Mono", ui-monospace, monospace';
const FONTS_HREF = 'https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500;600&display=swap';

export default function CustomerMenuDesignPage() {
  const [style, setStyle] = useState<Style>('thumbnails');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await apiJson<{ value: string | null }>('/api/settings?key=customer_menu_design');
      try { const j = JSON.parse(d.value || '{}'); if (j.categoryStyle === 'chips' || j.categoryStyle === 'thumbnails') setStyle(j.categoryStyle); } catch {}
    } catch (e: any) { setErr(e.message || 'Failed to load'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const choose = async (s: Style) => {
    if (s === style && !err) { /* still allow re-save */ }
    setStyle(s); setSaving(true); setErr(''); setSaved(false);
    try {
      await api('/api/settings', { method: 'PUT', body: { key: 'customer_menu_design', value: JSON.stringify({ categoryStyle: s }) } });
      setSaved(true); setTimeout(() => setSaved(false), 2200);
    } catch (e: any) { setErr(e.message || 'Could not save'); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '24px 20px 80px', fontFamily: SANS, color: C.ink }}>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link rel="stylesheet" href={FONTS_HREF} />

      <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 1.6, textTransform: 'uppercase', color: C.terra, fontWeight: 500 }}>Customer QR Menu</div>
      <h1 style={{ fontFamily: SERIF, fontSize: 34, fontWeight: 400, margin: '2px 0 6px', color: C.ink, lineHeight: 1.05 }}>Menu Page Design</h1>
      <p style={{ color: C.inkSoft, margin: '0 0 20px', fontSize: 14, lineHeight: 1.5, maxWidth: 620 }}>
        Choose how categories appear on the customer menu (the page guests see after scanning their table QR).
        Changes apply instantly to every table.
      </p>

      {err && <div style={{ background: C.terraTint, color: C.terraDeep, padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 13 }}>{err}</div>}
      {saved && <div style={{ background: '#DCE8DE', color: C.forest, padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 13, fontWeight: 500 }}>✓ Saved — the customer menu now uses this style.</div>}

      {loading ? <p style={{ color: C.inkMute }}>Loading…</p> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 18 }}>
          <Option
            active={style === 'thumbnails'} disabled={saving} onClick={() => choose('thumbnails')}
            title="Thumbnails" tagline="Category cards with images"
            desc="Guests first see a grid of category cards, then tap one to browse its dishes. Feels premium and visual."
            preview={<ThumbPreview />}
          />
          <Option
            active={style === 'chips'} disabled={saving} onClick={() => choose('chips')}
            title="Chips" tagline="Quick filter pills"
            desc="All dishes on one scroll, with a sticky row of category pills to jump around. Fast and compact."
            preview={<ChipsPreview />}
          />
        </div>
      )}

      <p style={{ color: C.inkMute, fontSize: 12.5, marginTop: 20 }}>
        Tip: preview the live menu by scanning any table's standee, or open <b>Settings → QR Standees</b> to print them.
        Food, Beverages and Liquor each get their own tab automatically.
      </p>
    </div>
  );
}

function Option({ active, disabled, onClick, title, tagline, desc, preview }: {
  active: boolean; disabled: boolean; onClick: () => void; title: string; tagline: string; desc: string; preview: React.ReactNode;
}) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      textAlign: 'left', cursor: disabled ? 'default' : 'pointer', background: C.card,
      border: `1px solid ${active ? C.terra : C.rule}`, boxShadow: active ? `0 0 0 3px ${C.terraTint}` : 'none',
      borderRadius: 18, padding: 16, transition: 'box-shadow .15s, border-color .15s', fontFamily: SANS, color: C.ink,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <div style={{ fontFamily: SERIF, fontSize: 24, lineHeight: 1 }}>{title}</div>
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', color: C.inkMute, marginTop: 4 }}>{tagline}</div>
        </div>
        <span style={{ width: 22, height: 22, borderRadius: '50%', border: `2px solid ${active ? C.terra : C.rule}`, background: active ? C.terra : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 13, flex: 'none' }}>{active ? '✓' : ''}</span>
      </div>
      <div style={{ borderRadius: 12, overflow: 'hidden', border: `1px solid ${C.ruleSoft}`, background: C.paper }}>{preview}</div>
      <p style={{ color: C.inkSoft, fontSize: 13, lineHeight: 1.45, margin: '12px 2px 0' }}>{desc}</p>
    </button>
  );
}

const box = (h: number, hue: string): React.CSSProperties => ({ height: h, borderRadius: 8, background: `linear-gradient(150deg, ${hue})` });
function ThumbPreview() {
  const hues = ['#DCB0A8,#C99', '#B7D8C4,#9Cc', '#CDB6DE,#B9a', '#E0C9A6,#Ca8'];
  return (
    <div style={{ padding: 12 }}>
      <div style={{ fontFamily: MONO, fontSize: 8, letterSpacing: 1, color: C.inkMute, marginBottom: 8 }}>KITCHEN · 22 DISHES ────</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9 }}>
        {hues.map((h, i) => (
          <div key={i} style={{ background: C.card, borderRadius: 10, padding: 6, border: `1px solid ${C.ruleSoft}` }}>
            <div style={box(38, h)} />
            <div style={{ fontFamily: SERIF, fontSize: 13, marginTop: 5 }}>{['Soups', 'Salads', 'Small Plates', 'Mains'][i]}</div>
            <div style={{ fontFamily: MONO, fontSize: 7.5, color: C.inkMute }}>{[4, 3, 5, 6][i]} ITEMS ›</div>
          </div>
        ))}
      </div>
    </div>
  );
}
function ChipsPreview() {
  return (
    <div style={{ padding: 12 }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        {['All', 'Soups', 'Salads', 'Mains'].map((c, i) => (
          <span key={c} style={{ fontFamily: MONO, fontSize: 9, padding: '4px 9px', borderRadius: 999, background: i === 0 ? C.terra : C.card, color: i === 0 ? '#fff' : C.inkSoft, border: `1px solid ${i === 0 ? C.terra : C.rule}` }}>{c}</span>
        ))}
      </div>
      {[['Tomato Basil Shorba', '#DCB0A8,#C99'], ['Charred Corn Salad', '#B7D8C4,#9CC'], ['Paneer Tikka', '#CDB6DE,#B9A']].map(([nm, h], i) => (
        <div key={i} style={{ display: 'flex', gap: 9, alignItems: 'center', padding: '6px 0', borderBottom: `1px solid ${C.ruleSoft}` }}>
          <div style={{ width: 34, height: 34, borderRadius: 8, background: `linear-gradient(150deg, ${h})`, flex: 'none' }} />
          <div style={{ flex: 1 }}><div style={{ fontFamily: SERIF, fontSize: 13 }}>{nm}</div></div>
          <span style={{ fontFamily: MONO, fontSize: 9, border: `1px solid ${C.terra}`, color: C.terra, borderRadius: 999, padding: '2px 8px' }}>ADD</span>
        </div>
      ))}
    </div>
  );
}
