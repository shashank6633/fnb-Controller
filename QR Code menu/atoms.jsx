// Akan Menu — shared UI atoms
// All exported to window so other JSX files can use them.

const C = {
  paper: '#F1E8D0',
  paperWarm: '#EFE3C5',
  card: '#FBF4DF',
  cardElev: '#FFF8E2',
  ink: '#231C12',
  inkSoft: '#5B4F3A',
  inkMute: '#8E8166',
  rule: 'rgba(35, 28, 18, 0.10)',
  ruleSoft: 'rgba(35, 28, 18, 0.06)',
  terra: '#B4502E',
  terraDeep: '#8E3A1E',
  terraTint: '#E9C6AB',
  forest: '#2D4A3A',
  forestDeep: '#1F362A',
  forestTint: '#C9D6CB',
  veg: '#0E8B5A',
  nonveg: '#B33A2E',
  egg: '#C9911E',
  chili: '#C0392B',
};
window.C = C;

// ─────── Veg / non-veg / egg dot (Indian standard square) ───────
function VegDot({ kind = 'v', size = 12 }) {
  const fill = kind === 'v' ? C.veg : kind === 'n' ? C.nonveg : C.egg;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: size, height: size, border: `1.5px solid ${fill}`,
      borderRadius: 2, flex: 'none',
    }}>
      <span style={{
        width: size * 0.45, height: size * 0.45, borderRadius: '50%', background: fill,
      }} />
    </span>
  );
}
window.VegDot = VegDot;

// ─────── Spice meter ───────
function SpiceMeter({ level = 0, size = 11 }) {
  if (level === 0) return null;
  return (
    <span style={{ display: 'inline-flex', gap: 1.5, alignItems: 'center' }} title={`Spice ${level}/3`}>
      {[0,1,2].map(i => (
        <svg key={i} width={size} height={size} viewBox="0 0 16 16" style={{ opacity: i < level ? 1 : 0.18 }}>
          <path d="M11 2c-0.6 0.8-0.8 1.8-0.4 2.6C8.5 5 6 7.4 5.2 10.4c-0.6 2 0.1 4 1.8 4.7 2.2 0.9 5-1 6.4-4.2 1.3-2.9 1-6-0.8-7.8-0.4-0.4-1-0.8-1.6-1.1z"
            fill={C.chili} stroke={C.terraDeep} strokeWidth="0.6"/>
          <path d="M11 2c0.3 0.4 0.6 0.9 0.8 1.4 0.2-0.6 0.6-1.2 1.2-1.6-0.7 0-1.4 0-2 0.2z" fill={C.forest}/>
        </svg>
      ))}
    </span>
  );
}
window.SpiceMeter = SpiceMeter;

// ─────── Badge: chef / popular ───────
function Badge({ kind }) {
  if (kind === 'chef') {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontFamily: 'Geist Mono, monospace', fontSize: 9.5, letterSpacing: 0.6,
        textTransform: 'uppercase', fontWeight: 500, whiteSpace: 'nowrap',
        background: C.forest, color: C.paper,
        padding: '3px 7px', borderRadius: 3, lineHeight: 1,
      }}>★ Chef's pick</span>
    );
  }
  if (kind === 'popular') {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontFamily: 'Geist Mono, monospace', fontSize: 9.5, letterSpacing: 0.6,
        textTransform: 'uppercase', fontWeight: 500, whiteSpace: 'nowrap',
        background: C.terra, color: '#FFF1DA',
        padding: '3px 7px', borderRadius: 3, lineHeight: 1,
      }}>Most ordered</span>
    );
  }
  return null;
}
window.Badge = Badge;

// ─────── Money ───────
function Rupee({ amount, size = 14, color }) {
  return (
    <span style={{
      fontFamily: 'Geist Mono, monospace', fontSize: size, fontWeight: 500,
      color: color || C.ink, letterSpacing: -0.2, fontVariantNumeric: 'tabular-nums',
    }}>₹{amount}</span>
  );
}
window.Rupee = Rupee;

// ─────── Photo placeholder ───────
// Striped SVG with monospace label per default aesthetic rules.
function Photo({ name, hue = 30, ratio = '1/1', radius = 10, label = true, style = {} }) {
  const id = React.useMemo(() => 'p' + Math.random().toString(36).slice(2, 8), []);
  // warm-shifted: keep chroma low, vary hue
  const base = `oklch(0.68 0.08 ${hue})`;
  const dark = `oklch(0.52 0.10 ${hue})`;
  const light = `oklch(0.85 0.05 ${hue})`;
  return (
    <div style={{
      position: 'relative', width: '100%', aspectRatio: ratio,
      borderRadius: radius, overflow: 'hidden',
      background: base, ...style,
    }}>
      <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, display: 'block' }} preserveAspectRatio="none">
        <defs>
          <pattern id={id} width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="14" height="14" fill={base}/>
            <rect width="7" height="14" fill={dark} opacity="0.28"/>
          </pattern>
          <radialGradient id={id + 'g'} cx="30%" cy="25%" r="80%">
            <stop offset="0%" stopColor={light} stopOpacity="0.6"/>
            <stop offset="100%" stopColor={dark} stopOpacity="0"/>
          </radialGradient>
        </defs>
        <rect width="100%" height="100%" fill={`url(#${id})`}/>
        <rect width="100%" height="100%" fill={`url(#${id}g)`}/>
      </svg>
      {label && (
        <div style={{
          position: 'absolute', left: 8, bottom: 8, right: 8,
          display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
          gap: 6, pointerEvents: 'none',
        }}>
          <span style={{
            fontFamily: 'Geist Mono, monospace', fontSize: 8, letterSpacing: 0.8,
            textTransform: 'uppercase', color: '#fff', opacity: 0.85,
            background: 'rgba(0,0,0,0.28)', padding: '2px 5px', borderRadius: 2,
            maxWidth: '85%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{name} · img</span>
        </div>
      )}
    </div>
  );
}
window.Photo = Photo;

// ─────── Inline icon set (stroke icons) ───────
const Icon = {
  search: (p) => <svg width={p.s||20} height={p.s||20} viewBox="0 0 24 24" fill="none" stroke={p.c||'currentColor'} strokeWidth="1.8" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>,
  back: (p) => <svg width={p.s||22} height={p.s||22} viewBox="0 0 24 24" fill="none" stroke={p.c||'currentColor'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>,
  close: (p) => <svg width={p.s||22} height={p.s||22} viewBox="0 0 24 24" fill="none" stroke={p.c||'currentColor'} strokeWidth="1.8" strokeLinecap="round"><path d="M6 6l12 12M18 6l-6 6-6 6"/></svg>,
  plus: (p) => <svg width={p.s||16} height={p.s||16} viewBox="0 0 24 24" fill="none" stroke={p.c||'currentColor'} strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>,
  minus: (p) => <svg width={p.s||16} height={p.s||16} viewBox="0 0 24 24" fill="none" stroke={p.c||'currentColor'} strokeWidth="2.2" strokeLinecap="round"><path d="M5 12h14"/></svg>,
  bag: (p) => <svg width={p.s||22} height={p.s||22} viewBox="0 0 24 24" fill="none" stroke={p.c||'currentColor'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 8h14l-1 12H6L5 8z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>,
  menu: (p) => <svg width={p.s||22} height={p.s||22} viewBox="0 0 24 24" fill="none" stroke={p.c||'currentColor'} strokeWidth="1.8" strokeLinecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>,
  bell: (p) => <svg width={p.s||22} height={p.s||22} viewBox="0 0 24 24" fill="none" stroke={p.c||'currentColor'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 8a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>,
  table: (p) => <svg width={p.s||22} height={p.s||22} viewBox="0 0 24 24" fill="none" stroke={p.c||'currentColor'} strokeWidth="1.8" strokeLinecap="round"><path d="M3 9h18l-2 3H5L3 9z"/><path d="M7 12v8M17 12v8M3 9V7M21 9V7"/></svg>,
  filter: (p) => <svg width={p.s||18} height={p.s||18} viewBox="0 0 24 24" fill="none" stroke={p.c||'currentColor'} strokeWidth="1.8" strokeLinecap="round"><path d="M4 6h16M7 12h10M10 18h4"/></svg>,
  qr: (p) => <svg width={p.s||40} height={p.s||40} viewBox="0 0 24 24" fill="none" stroke={p.c||'currentColor'} strokeWidth="1.5" strokeLinecap="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3M20 14v3M14 20h3M20 17v4M17 17v3"/></svg>,
  check: (p) => <svg width={p.s||18} height={p.s||18} viewBox="0 0 24 24" fill="none" stroke={p.c||'currentColor'} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7"/></svg>,
  waiter: (p) => <svg width={p.s||22} height={p.s||22} viewBox="0 0 24 24" fill="none" stroke={p.c||'currentColor'} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="6" r="2.5"/><path d="M5 21c1-5 3.5-7 7-7s6 2 7 7"/><path d="M12 11v3"/></svg>,
  water: (p) => <svg width={p.s||22} height={p.s||22} viewBox="0 0 24 24" fill="none" stroke={p.c||'currentColor'} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3s6 7 6 12a6 6 0 0 1-12 0c0-5 6-12 6-12z"/></svg>,
  bill: (p) => <svg width={p.s||22} height={p.s||22} viewBox="0 0 24 24" fill="none" stroke={p.c||'currentColor'} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>,
  spoon: (p) => <svg width={p.s||22} height={p.s||22} viewBox="0 0 24 24" fill="none" stroke={p.c||'currentColor'} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M7 3v8M11 3v8M7 11a4 4 0 0 0 8 0V3"/><path d="M17 3c2 2 2 6 0 8l-1 1v9"/></svg>,
  chevR: (p) => <svg width={p.s||18} height={p.s||18} viewBox="0 0 24 24" fill="none" stroke={p.c||'currentColor'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6"/></svg>,
  star: (p) => <svg width={p.s||14} height={p.s||14} viewBox="0 0 24 24" fill={p.c||'currentColor'}><path d="M12 2l3 6.5 7 1-5 5 1.2 7L12 18l-6.2 3.5L7 14.5l-5-5 7-1z"/></svg>,
};
window.Icon = Icon;

// ─────── Section header (paper rule) ───────
function PaperRule({ children, mono }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      fontFamily: mono ? 'Geist Mono, monospace' : 'Geist, sans-serif',
      fontSize: 10, letterSpacing: 1.4, textTransform: 'uppercase',
      color: C.inkMute, fontWeight: 500,
    }}>
      <span style={{ flex: 'none' }}>{children}</span>
      <span style={{ flex: 1, height: 1, background: C.rule }} />
    </div>
  );
}
window.PaperRule = PaperRule;

// ─────── Filter chip ───────
function Chip({ active, children, onClick, style = {} }) {
  return (
    <button onClick={onClick} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      height: 30, padding: '0 12px',
      borderRadius: 999,
      border: `1px solid ${active ? C.ink : C.rule}`,
      background: active ? C.ink : 'transparent',
      color: active ? C.paper : C.ink,
      fontFamily: 'Geist, sans-serif', fontSize: 12.5, fontWeight: 500,
      letterSpacing: -0.1, cursor: 'pointer', whiteSpace: 'nowrap',
      ...style,
    }}>{children}</button>
  );
}
window.Chip = Chip;
