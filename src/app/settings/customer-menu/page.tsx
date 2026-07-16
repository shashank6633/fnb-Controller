'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, apiJson } from '@/lib/api';

type Style = 'thumbnails' | 'chips';
type Mode = 'captain' | 'direct';
type OtpMode = 'off' | 'direct' | 'all';

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
  const [mode, setMode] = useState<Mode>('captain');
  const [otpMode, setOtpMode] = useState<OtpMode>('off');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await apiJson<{ value: string | null }>('/api/settings?key=customer_menu_design');
      try {
        const j = JSON.parse(d.value || '{}');
        if (j.categoryStyle === 'chips' || j.categoryStyle === 'thumbnails') setStyle(j.categoryStyle);
        if (j.orderMode === 'direct' || j.orderMode === 'captain') setMode(j.orderMode);
        if (j.otpMode === 'direct' || j.otpMode === 'all' || j.otpMode === 'off') setOtpMode(j.otpMode);
      } catch {}
    } catch (e: any) { setErr(e.message || 'Failed to load'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Persist the whole design object (categoryStyle + orderMode) in one setting.
  const save = async (next: { categoryStyle: Style; orderMode: Mode; otpMode: OtpMode }) => {
    setSaving(true); setErr(''); setSaved(false);
    try {
      await api('/api/settings', { method: 'PUT', body: { key: 'customer_menu_design', value: JSON.stringify(next) } });
      setSaved(true); setTimeout(() => setSaved(false), 2200);
    } catch (e: any) { setErr(e.message || 'Could not save'); }
    finally { setSaving(false); }
  };
  const chooseStyle = (s: Style) => { setStyle(s); save({ categoryStyle: s, orderMode: mode, otpMode }); };
  const chooseMode = (m: Mode) => { setMode(m); save({ categoryStyle: style, orderMode: m, otpMode }); };
  const chooseOtp = (o: OtpMode) => { setOtpMode(o); save({ categoryStyle: style, orderMode: mode, otpMode: o }); };

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '24px 20px 80px', fontFamily: SANS, color: C.ink }}>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link rel="stylesheet" href={FONTS_HREF} />

      <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 1.6, textTransform: 'uppercase', color: C.terra, fontWeight: 500 }}>Customer QR Menu</div>
      <h1 style={{ fontFamily: SERIF, fontSize: 34, fontWeight: 400, margin: '2px 0 6px', color: C.ink, lineHeight: 1.05 }}>Menu Page Design</h1>
      <p style={{ color: C.inkSoft, margin: '0 0 20px', fontSize: 14, lineHeight: 1.5, maxWidth: 620 }}>
        Control how the customer menu looks and how QR orders reach your kitchen (the page guests see after scanning their table QR).
        Changes apply instantly to every table.
      </p>

      {err && <div style={{ background: C.terraTint, color: C.terraDeep, padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 13 }}>{err}</div>}
      {saved && <div style={{ background: '#DCE8DE', color: C.forest, padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 13, fontWeight: 500 }}>✓ Saved — the customer menu now uses these settings.</div>}

      {loading ? <p style={{ color: C.inkMute }}>Loading…</p> : (
        <>
          {/* ── QR Ordering Mode ─────────────────────────────────────────── */}
          <SectionHead
            title="QR Ordering Mode"
            desc="Decide what happens when a guest taps Place Order. Switch anytime — the customer-facing menu doesn't change."
          />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 18, marginBottom: 34 }}>
            <Option
              active={mode === 'captain'} disabled={saving} onClick={() => chooseMode('captain')}
              title="Captain Confirmation" tagline="Recommended default"
              desc="Guest submits the cart → it lands in the Captain's queue as Pending. The captain checks with the table, tweaks/adds items, then sends the KOT. Fewer mistakes, more upsell."
              preview={<FlowPreview steps={['Guest cart', 'Captain reviews', 'Captain sends KOT', 'Kitchen']} highlight={1} />}
            />
            <Option
              active={mode === 'direct'} disabled={saving} onClick={() => chooseMode('direct')}
              title="Direct Ordering" tagline="Auto-send KOT"
              desc="Guest confirms on their phone (“send to kitchen?”) → the KOT prints straight to the right station instantly. Fully self-service, no captain step."
              preview={<FlowPreview steps={['Guest cart', 'Confirm popup', 'KOT fires', 'Kitchen']} highlight={2} />}
            />
          </div>
          {mode === 'direct' && (
            <div style={{ background: C.terraTint, color: C.terraDeep, padding: '10px 14px', borderRadius: 10, margin: '-22px 0 34px', fontSize: 12.5, lineHeight: 1.5 }}>
              <b>Heads up:</b> in Direct mode, customer orders fire to the kitchen without a captain checking them. Best for counters, food courts, or trusted regulars.
            </div>
          )}

          {/* ── WhatsApp OTP for self-orders ─────────────────────────────── */}
          <SectionHead
            title="WhatsApp OTP (Self-orders)"
            desc="Require a WhatsApp-verified mobile before a self-order is accepted, so an unpaid or abandoned bill always has a real number you can call."
          />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 18, marginBottom: 14 }}>
            <Option active={otpMode === 'off'} disabled={saving} onClick={() => chooseOtp('off')}
              title="Off" tagline="No OTP" desc="Guests order without verifying a number (current behaviour)." />
            <Option active={otpMode === 'direct'} disabled={saving} onClick={() => chooseOtp('direct')}
              title="Direct only" tagline="Recommended" desc="OTP required only for Direct (captain-less) orders — the ones with no staff checkpoint." />
            <Option active={otpMode === 'all'} disabled={saving} onClick={() => chooseOtp('all')}
              title="All QR orders" tagline="Strictest" desc="Every QR self-order needs a verified number, including captain-approval orders." />
          </div>
          {otpMode !== 'off' && (
            <div style={{ background: C.terraTint, color: C.terraDeep, padding: '10px 14px', borderRadius: 10, margin: '0 0 34px', fontSize: 12.5, lineHeight: 1.5 }}>
              <b>Needs WhatsApp:</b> connect WhatsApp and set an approved <b>OTP template</b> in Settings → Integrations → WhatsApp. Until that&apos;s live, self-orders safely fall back to captain approval — nothing breaks.
            </div>
          )}

          {/* ── Category display ─────────────────────────────────────────── */}
          <SectionHead
            title="Category Display"
            desc="How dish categories appear on the menu. Food, Beverages and Liquor each get their own tab automatically."
          />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 18 }}>
            <Option
              active={style === 'thumbnails'} disabled={saving} onClick={() => chooseStyle('thumbnails')}
              title="Thumbnails" tagline="Category cards with images"
              desc="Guests first see a grid of category cards, then tap one to browse its dishes. Feels premium and visual."
              preview={<ThumbPreview />}
            />
            <Option
              active={style === 'chips'} disabled={saving} onClick={() => chooseStyle('chips')}
              title="Chips" tagline="Quick filter pills"
              desc="All dishes on one scroll, with a sticky row of category pills to jump around. Fast and compact."
              preview={<ChipsPreview />}
            />
          </div>
        </>
      )}

      <p style={{ color: C.inkMute, fontSize: 12.5, marginTop: 20 }}>
        Tip: preview the live menu by scanning any table's standee, or open <b>Settings → QR Standees</b> to print them.
      </p>
    </div>
  );
}

function SectionHead({ title, desc }: { title: string; desc: string }) {
  return (
    <div style={{ margin: '0 0 14px' }}>
      <h2 style={{ fontFamily: SERIF, fontSize: 23, fontWeight: 400, margin: 0, color: C.ink }}>{title}</h2>
      <p style={{ color: C.inkSoft, fontSize: 13, lineHeight: 1.5, margin: '3px 0 0', maxWidth: 620 }}>{desc}</p>
    </div>
  );
}

function Option({ active, disabled, onClick, title, tagline, desc, preview }: {
  active: boolean; disabled: boolean; onClick: () => void; title: string; tagline: string; desc: string; preview?: React.ReactNode;
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
      {preview && <div style={{ borderRadius: 12, overflow: 'hidden', border: `1px solid ${C.ruleSoft}`, background: C.paper }}>{preview}</div>}
      <p style={{ color: C.inkSoft, fontSize: 13, lineHeight: 1.45, margin: '12px 2px 0' }}>{desc}</p>
    </button>
  );
}

// Small left-to-right flow strip for the ordering-mode previews.
function FlowPreview({ steps, highlight }: { steps: string[]; highlight: number }) {
  return (
    <div style={{ padding: '16px 12px', display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
      {steps.map((s, i) => (
        <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{
            fontFamily: MONO, fontSize: 9, letterSpacing: 0.4, padding: '5px 8px', borderRadius: 8, whiteSpace: 'nowrap',
            background: i === highlight ? C.terra : C.card, color: i === highlight ? '#fff' : C.inkSoft,
            border: `1px solid ${i === highlight ? C.terra : C.rule}`, fontWeight: i === highlight ? 600 : 400,
          }}>{s}</span>
          {i < steps.length - 1 && <span style={{ color: C.inkMute, fontSize: 11 }}>→</span>}
        </span>
      ))}
    </div>
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
