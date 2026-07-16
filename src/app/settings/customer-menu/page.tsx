'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, apiJson } from '@/lib/api';

type Style = 'thumbnails' | 'chips';
type Mode = 'captain' | 'direct';
type OtpMode = 'off' | 'direct';
type ScopeKind = 'all' | 'zones' | 'sections' | 'tables';
interface OtpScope { kind: ScopeKind; zones: string[]; sections: string[]; tableIds: string[] }
interface TableRow { id: string; table_number: string; zone: string; section: string }

// Default guest-details-page copy (mirror of GUEST_TEXT_DEFAULTS in
// src/lib/customer.ts — that lib touches the DB so a client page can't import it).
const TXT_DEFAULTS = {
  guestHeading: 'A pleasure to host you',
  guestMessage: 'May we have your name and WhatsApp number? It’s just for our billing records — and so we can reach you if your order needs a quick word. Thank you!',
  guestFootnote: 'Your details stay with us — used only for this visit.',
};

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
  const [guestHeading, setGuestHeading] = useState('');
  const [guestMessage, setGuestMessage] = useState('');
  const [guestFootnote, setGuestFootnote] = useState('');
  const [textDirty, setTextDirty] = useState(false);
  const [scope, setScope] = useState<OtpScope>({ kind: 'all', zones: [], sections: [], tableIds: [] });
  const [tables, setTables] = useState<TableRow[]>([]);
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
        // Legacy 'all' → 'direct' (captain orders are no longer force-blocked).
        if (j.otpMode === 'off') setOtpMode('off');
        else if (j.otpMode === 'direct' || j.otpMode === 'all') setOtpMode('direct');
        setGuestHeading(String(j.guestHeading || ''));
        setGuestMessage(String(j.guestMessage || ''));
        setGuestFootnote(String(j.guestFootnote || ''));
        const sc = j.otpScope || {};
        if (sc.kind === 'zones' || sc.kind === 'sections' || sc.kind === 'tables' || sc.kind === 'all') {
          setScope({
            kind: sc.kind,
            zones: Array.isArray(sc.zones) ? sc.zones.map(String) : [],
            sections: Array.isArray(sc.sections) ? sc.sections.map(String) : [],
            tableIds: Array.isArray(sc.tableIds) ? sc.tableIds.map(String) : [],
          });
        }
      } catch {}
    } catch (e: any) { setErr(e.message || 'Failed to load'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Tables (with their floor/section) for the scope picker — every table, so the
  // admin can scope OTP to any floor or table set regardless of captain areas.
  useEffect(() => {
    apiJson<{ items: TableRow[] }>('/api/dine-in/tables?scope=all')
      .then(r => setTables((r.items || []).map(t => ({ id: t.id, table_number: String(t.table_number), zone: String(t.zone || ''), section: String(t.section || '') }))))
      .catch(() => {});
  }, []);

  // Persist the whole design object in one setting. Every save carries every
  // field (incl. the guest-page text) so a mode click never wipes the copy.
  const save = async (partial: Partial<{ categoryStyle: Style; orderMode: Mode; otpMode: OtpMode; guestHeading: string; guestMessage: string; guestFootnote: string; otpScope: OtpScope }>): Promise<boolean> => {
    setSaving(true); setErr(''); setSaved(false);
    const next = {
      categoryStyle: style, orderMode: mode, otpMode, otpScope: scope,
      guestHeading: guestHeading.trim(), guestMessage: guestMessage.trim(), guestFootnote: guestFootnote.trim(),
      ...partial,
    };
    try {
      const res = await api('/api/settings', { method: 'PUT', body: { key: 'customer_menu_design', value: JSON.stringify(next) } });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { msg = (await res.json()).error || msg; } catch {}
        throw new Error(msg);
      }
      setSaved(true); setTimeout(() => setSaved(false), 2200);
      return true;
    } catch (e: any) { setErr(e.message || 'Could not save'); return false; }
    finally { setSaving(false); }
  };
  const chooseStyle = (s: Style) => { setStyle(s); save({ categoryStyle: s }); };
  const chooseMode = (m: Mode) => { setMode(m); save({ orderMode: m }); };
  const chooseOtp = (o: OtpMode) => { setOtpMode(o); save({ otpMode: o }); };
  const chooseScopeKind = (kind: ScopeKind) => { const next = { ...scope, kind }; setScope(next); save({ otpScope: next }); };
  const toggleZone = (zone: string) => {
    const zones = scope.zones.includes(zone) ? scope.zones.filter(z => z !== zone) : [...scope.zones, zone];
    const next = { ...scope, zones }; setScope(next); save({ otpScope: next });
  };
  const toggleSection = (section: string) => {
    const sections = scope.sections.includes(section) ? scope.sections.filter(s => s !== section) : [...scope.sections, section];
    const next = { ...scope, sections }; setScope(next); save({ otpScope: next });
  };
  const toggleTable = (id: string) => {
    const tableIds = scope.tableIds.includes(id) ? scope.tableIds.filter(t => t !== id) : [...scope.tableIds, id];
    const next = { ...scope, tableIds }; setScope(next); save({ otpScope: next });
  };
  const allZones = [...new Set(tables.map(t => t.zone).filter(Boolean))];
  const allSections = [...new Set(tables.map(t => t.section).filter(Boolean))].sort();
  // Grouping list for the per-table picker INCLUDES unzoned ('') so those tables
  // can still be selected (otherwise they'd silently fire captain-less with no OTP).
  const groupZones = [...new Set(tables.map(t => t.zone))].sort();
  const hasUnzoned = tables.some(t => !t.zone);
  // Empty non-'all' scope means "no tables listed" → the server treats it as ALL
  // tables (safe: never leaves a direct table unverified). Surface that so the
  // admin isn't surprised.
  const scopeEmpty = (scope.kind === 'zones' && scope.zones.length === 0)
    || (scope.kind === 'sections' && scope.sections.length === 0)
    || (scope.kind === 'tables' && scope.tableIds.length === 0);
  // Only clear the dirty flag when the save actually landed — a failed save
  // must keep "Save text" active so the admin can retry.
  const saveTexts = async () => { if (await save({})) setTextDirty(false); };

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

          {/* ── WhatsApp OTP for direct self-orders ──────────────────────── */}
          <SectionHead
            title="WhatsApp OTP (Direct self-orders)"
            desc="For Direct ordering, require a WhatsApp-verified mobile before a captain-less order fires — so an unpaid or abandoned bill always has a real number you can call. Captain-Confirmation orders are never blocked: guests are politely asked for a number and can skip it."
          />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 18, marginBottom: 14 }}>
            <Option active={otpMode === 'off'} disabled={saving} onClick={() => chooseOtp('off')}
              title="Off" tagline="No OTP" desc="Guests order without sharing a number (current behaviour)." />
            <Option active={otpMode === 'direct'} disabled={saving} onClick={() => chooseOtp('direct')}
              title="On — Direct orders" tagline="Recommended" desc="Direct (captain-less) orders on the tables you choose below need a WhatsApp-verified number before they fire." />
          </div>
          {otpMode !== 'off' && (
            <div style={{ background: C.terraTint, color: C.terraDeep, padding: '10px 14px', borderRadius: 10, margin: '0 0 18px', fontSize: 12.5, lineHeight: 1.5 }}>
              <b>Needs WhatsApp:</b> connect WhatsApp and set an approved <b>OTP template</b> in Settings → Integrations → WhatsApp. Until that&apos;s live, in-scope direct orders safely fall back to captain approval — nothing breaks.
            </div>
          )}

          {/* ── OTP table scope (Direct-OTP only) ────────────────────────── */}
          {otpMode === 'direct' && (
            <div style={{ marginBottom: 34 }}>
              {mode !== 'direct' && (
                <div style={{ background: C.cardElev, color: C.inkSoft, border: `1px solid ${C.rule}`, padding: '10px 14px', borderRadius: 10, marginBottom: 14, fontSize: 12.5, lineHeight: 1.5 }}>
                  You&apos;re in <b>Captain Confirmation</b> mode, so nothing fires without a captain and OTP stays idle. Switch <b>QR Ordering Mode</b> to <b>Direct</b> for these tables to enforce it. Meanwhile guests are still asked (optionally) for their number.
                </div>
              )}
              <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 1.2, textTransform: 'uppercase', color: C.inkMute, marginBottom: 10 }}>Which tables need OTP?</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
                {([['all', 'All tables'], ['zones', 'By floor'], ['sections', 'By section'], ['tables', 'Specific tables']] as [ScopeKind, string][]).map(([k, label]) => (
                  <button key={k} onClick={() => chooseScopeKind(k)} disabled={saving} style={{
                    fontFamily: MONO, fontSize: 12, padding: '8px 16px', borderRadius: 999, cursor: saving ? 'default' : 'pointer',
                    background: scope.kind === k ? C.terra : C.card, color: scope.kind === k ? '#fff' : C.inkSoft,
                    border: `1px solid ${scope.kind === k ? C.terra : C.rule}`, fontWeight: scope.kind === k ? 600 : 400,
                  }}>{label}</button>
                ))}
              </div>

              {scopeEmpty && (
                <div style={{ background: C.terraTint, color: C.terraDeep, padding: '9px 13px', borderRadius: 10, marginBottom: 12, fontSize: 12.5, lineHeight: 1.5 }}>
                  Nothing selected yet — until you pick {scope.kind === 'zones' ? 'a floor' : scope.kind === 'sections' ? 'a section' : 'a table'}, OTP applies to <b>every table</b>. Pick some below, or choose <b>All tables</b>.
                </div>
              )}
              {scope.kind === 'zones' && (
                <div style={{ background: C.card, border: `1px solid ${C.rule}`, borderRadius: 16, padding: 16, maxWidth: 640 }}>
                  <div style={{ fontSize: 12.5, color: C.inkSoft, marginBottom: 10 }}>Tap the floors whose tables need OTP:</div>
                  {allZones.length === 0 ? <div style={{ color: C.inkMute, fontSize: 13 }}>No floors found — set a Floor on your tables (Dine-In → Tables) first.</div> : (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {allZones.map(z => {
                        const on = scope.zones.includes(z);
                        const n = tables.filter(t => t.zone === z).length;
                        return (
                          <button key={z} onClick={() => toggleZone(z)} disabled={saving} style={{
                            fontFamily: SANS, fontSize: 13.5, padding: '9px 15px', borderRadius: 12, cursor: 'pointer', textAlign: 'left',
                            background: on ? C.forest : C.cardElev, color: on ? '#fff' : C.ink, border: `1px solid ${on ? C.forest : C.rule}`,
                          }}>{on ? '✓ ' : ''}{z} <span style={{ fontFamily: MONO, fontSize: 10, opacity: 0.7 }}>· {n}</span></button>
                        );
                      })}
                    </div>
                  )}
                  {hasUnzoned && (
                    <div style={{ fontSize: 12, color: C.inkMute, marginTop: 12, lineHeight: 1.5 }}>
                      Some tables have no floor, so they can&apos;t be picked here. Use <b>Specific tables</b> to include them.
                    </div>
                  )}
                </div>
              )}

              {scope.kind === 'sections' && (
                <div style={{ background: C.card, border: `1px solid ${C.rule}`, borderRadius: 16, padding: 16, maxWidth: 640 }}>
                  <div style={{ fontSize: 12.5, color: C.inkSoft, marginBottom: 10 }}>Tap the sections whose tables need OTP (e.g. FA, SA):</div>
                  {allSections.length === 0 ? <div style={{ color: C.inkMute, fontSize: 13 }}>No sections found — add a Section to your tables on Dine-In → Tables first.</div> : (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {allSections.map(sec => {
                        const on = scope.sections.includes(sec);
                        const n = tables.filter(t => t.section === sec).length;
                        return (
                          <button key={sec} onClick={() => toggleSection(sec)} disabled={saving} style={{
                            fontFamily: MONO, fontSize: 13, padding: '9px 15px', borderRadius: 12, cursor: 'pointer',
                            background: on ? C.forest : C.cardElev, color: on ? '#fff' : C.ink, border: `1px solid ${on ? C.forest : C.rule}`, fontWeight: on ? 600 : 400,
                          }}>{on ? '✓ ' : ''}{sec} <span style={{ fontSize: 10, opacity: 0.7 }}>· {n}</span></button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {scope.kind === 'tables' && (
                <div style={{ background: C.card, border: `1px solid ${C.rule}`, borderRadius: 16, padding: 16, maxWidth: 640 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
                    <div style={{ fontSize: 12.5, color: C.inkSoft }}>Tap the exact tables that need OTP:</div>
                    <div style={{ fontFamily: MONO, fontSize: 10.5, color: C.terra }}>{scope.tableIds.length} selected</div>
                  </div>
                  {tables.length === 0 ? <div style={{ color: C.inkMute, fontSize: 13 }}>No tables found.</div> : groupZones.map(z => (
                    <div key={z || '__unzoned'} style={{ marginBottom: 14 }}>
                      <div style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: 1, textTransform: 'uppercase', color: C.inkMute, marginBottom: 7 }}>{z || 'No floor'}</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
                        {tables.filter(t => t.zone === z).map(t => {
                          const on = scope.tableIds.includes(t.id);
                          return (
                            <button key={t.id} onClick={() => toggleTable(t.id)} disabled={saving} style={{
                              fontFamily: MONO, fontSize: 13, minWidth: 42, padding: '9px 12px', borderRadius: 10, cursor: 'pointer',
                              background: on ? C.terra : C.cardElev, color: on ? '#fff' : C.ink, border: `1px solid ${on ? C.terra : C.rule}`, fontWeight: on ? 600 : 400,
                            }}>{t.table_number}</button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Guest details page — editable copy ───────────────────────── */}
          <SectionHead
            title="Guest Details Page — Text"
            desc="The wording on the page where guests share their name and WhatsApp number (shown after “View Menu” when OTP is on). The Table No., Name and WhatsApp number fields are fixed — you edit the message around them. Leave a box empty to use our default line."
          />
          <div style={{ background: C.card, border: `1px solid ${C.rule}`, borderRadius: 18, padding: 18, marginBottom: 10, maxWidth: 640 }}>
            <TextField
              label="Heading (top)" value={guestHeading} maxLength={60}
              placeholder={TXT_DEFAULTS.guestHeading}
              onChange={(v) => { setGuestHeading(v); setTextDirty(true); }}
            />
            <TextField
              label="Request message (below the heading)" value={guestMessage} maxLength={240} multiline
              placeholder={TXT_DEFAULTS.guestMessage}
              onChange={(v) => { setGuestMessage(v); setTextDirty(true); }}
            />
            <TextField
              label="Reassurance line (bottom)" value={guestFootnote} maxLength={120}
              placeholder={TXT_DEFAULTS.guestFootnote}
              onChange={(v) => { setGuestFootnote(v); setTextDirty(true); }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14 }}>
              <button onClick={saveTexts} disabled={saving || !textDirty} style={{
                background: textDirty ? C.terra : C.rule, color: textDirty ? '#fff' : C.inkMute,
                border: 'none', borderRadius: 999, padding: '10px 22px', fontSize: 14, fontWeight: 600,
                cursor: textDirty && !saving ? 'pointer' : 'default', fontFamily: SANS,
              }}>{saving ? 'Saving…' : 'Save text'}</button>
              <span style={{ fontSize: 12.5, color: C.inkMute }}>
                Preview it live: open any table&apos;s QR link with <b>&amp;preview_gate=1</b> added.
              </span>
            </div>
          </div>
          <div style={{ marginBottom: 34 }} />

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

function TextField({ label, value, placeholder, maxLength, multiline, onChange }: {
  label: string; value: string; placeholder: string; maxLength: number; multiline?: boolean; onChange: (v: string) => void;
}) {
  const common: React.CSSProperties = {
    width: '100%', background: C.cardElev, border: `1px solid ${C.rule}`, borderRadius: 12,
    padding: '11px 13px', fontSize: 14, color: C.ink, outline: 'none', fontFamily: SANS, resize: 'vertical',
  };
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <label style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 1.2, textTransform: 'uppercase', color: C.inkMute }}>{label}</label>
        <span style={{ fontFamily: MONO, fontSize: 10, color: value.length > maxLength - 15 ? C.terraDeep : C.inkMute }}>{value.length}/{maxLength}</span>
      </div>
      {multiline
        ? <textarea rows={3} value={value} placeholder={placeholder} maxLength={maxLength} onChange={(e) => onChange(e.target.value)} style={common} />
        : <input type="text" value={value} placeholder={placeholder} maxLength={maxLength} onChange={(e) => onChange(e.target.value)} style={common} />}
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
