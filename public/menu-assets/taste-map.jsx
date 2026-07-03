// TasteMap — 4-axis radar: SOUR (top), SWEET (right), SPICY (bottom), TANGY (left)
// Values 0-4. Compact, paper-toned, terracotta fill.

function TasteMap({ taste, size = 220 }) {
  const C = window.C;
  const padX = 100; // generous room for "TANGY (4)" labels
  const padY = 8;
  const W = size + padX * 2;
  const H = size + padY * 2;
  const cx = W / 2, cy = H / 2;
  const max = 4;
  const r = (size / 2) - 6;
  const axes = [
    { key: 'sour',  label: 'Sour',  ang: -Math.PI / 2 },
    { key: 'sweet', label: 'Sweet', ang: 0 },
    { key: 'spicy', label: 'Spicy', ang:  Math.PI / 2 },
    { key: 'tangy', label: 'Tangy', ang:  Math.PI },
  ];
  const point = (ang, dist) => [cx + Math.cos(ang) * dist, cy + Math.sin(ang) * dist];

  const pts = axes.map(a => {
    const v = taste[a.key] || 0;
    return point(a.ang, (v / max) * r);
  });
  const poly = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

  const rings = [1, 2, 3, 4];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet"
      style={{ display: 'block', maxHeight: size + 24 }}>
      <defs>
        <radialGradient id="tm-bg" cx="50%" cy="50%" r="55%">
          <stop offset="0%" stopColor={C.cardElev} />
          <stop offset="100%" stopColor={C.card} />
        </radialGradient>
      </defs>

      {/* rings */}
      {rings.map(i => (
        <circle key={i} cx={cx} cy={cy} r={(i / max) * r}
          fill={i === max ? 'url(#tm-bg)' : 'none'}
          stroke={C.rule} strokeWidth="0.8"
          strokeDasharray={i < max ? '2 3' : '0'}
        />
      ))}

      {/* axes */}
      {axes.map(a => {
        const [x, y] = point(a.ang, r);
        return <line key={a.key} x1={cx} y1={cy} x2={x} y2={y} stroke={C.rule} strokeWidth="0.8" />;
      })}

      {/* polygon */}
      <polygon points={poly}
        fill={C.terra} fillOpacity="0.85"
        stroke={C.terraDeep} strokeWidth="1.2" strokeLinejoin="round" />

      {/* center dot */}
      <circle cx={cx} cy={cy} r="2" fill={C.terraDeep} />

      {/* labels */}
      {axes.map(a => {
        const [x, y] = point(a.ang, r + 12);
        const v = taste[a.key] || 0;
        const isVert = Math.abs(Math.cos(a.ang)) < 0.1;
        const anchor = isVert ? 'middle' : (Math.cos(a.ang) > 0 ? 'start' : 'end');
        const dy = isVert ? (Math.sin(a.ang) > 0 ? 14 : -4) : 4;
        return (
          <text key={a.key} x={x} y={y + dy} textAnchor={anchor}
            fontFamily="Geist Mono, monospace" fontSize="12" letterSpacing="1.6"
            fill={C.ink} fontWeight="500">
            {a.label.toUpperCase()} <tspan fill={C.inkMute} fontWeight="400">({v})</tspan>
          </text>
        );
      })}
    </svg>
  );
}
window.TasteMap = TasteMap;

// PairsWith — drink pairings. Resolves drink IDs to live menu items
// and renders them as tappable mini cards.
function PairsWith({ pairs = [], onOpen }) {
  const C = window.C;
  if (!pairs.length) return null;

  // Drink-category badge config
  const catFor = (subId) => {
    if (subId === 'wine') return { label: 'Wine & Cocktails', icon: 'wine', hue: 0 };
    if (subId === 'mock') return { label: 'Mocktail',          icon: 'mock', hue: 100 };
    if (subId === 'smooth') return { label: 'Smoothie',        icon: 'smoothie', hue: 38 };
    if (subId === 'hot') return { label: 'Hot',                icon: 'hot', hue: 28 };
    if (subId === 'cold') return { label: 'Cold',              icon: 'cold', hue: 36 };
    return { label: 'Drink', icon: 'mock', hue: 30 };
  };

  // Resolve IDs to {item, subId}
  const drinks = [];
  for (const id of pairs) {
    for (const s of window.MENU.bev.sub) {
      const it = s.items.find(i => i.id === id);
      if (it) { drinks.push({ item: it, subId: s.id }); break; }
    }
  }

  const drinkIcons = {
    wine: (
      <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M7 3h10c0 5-2 8-5 8s-5-3-5-8z"/>
        <path d="M12 11v7M8 21h8"/>
      </g>
    ),
    mock: (
      <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 4h14l-7 9zM12 13v7M8 20h8"/>
        <path d="M16 6l-2 2"/>
      </g>
    ),
    smoothie: (
      <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M7 8h10l-1 12a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2L7 8z"/>
        <path d="M9 4c1.5 0 1.5 2 3 2s1.5-2 3-2"/>
      </g>
    ),
    hot: (
      <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 9h12v7a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V9z"/>
        <path d="M17 10h2a2 2 0 0 1 0 6h-2"/>
        <path d="M9 3c0 1.5-1 1.5-1 3M13 3c0 1.5-1 1.5-1 3"/>
      </g>
    ),
    cold: (
      <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M7 4h10l-1 16a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2L7 4z"/>
        <path d="M8 12h8M10 7l4 0M9.5 17h5"/>
      </g>
    ),
  };

  return (
    <div style={{
      display: 'flex', gap: 10, overflowX: 'auto',
      margin: '0 -22px', padding: '4px 22px 6px',
      scrollSnapType: 'x mandatory',
    }}>
      {drinks.map(({ item, subId }) => {
        const cat = catFor(subId);
        const tint = `oklch(0.95 0.04 ${cat.hue})`;
        const inkTint = `oklch(0.45 0.10 ${cat.hue})`;
        return (
          <button key={item.id} onClick={() => onOpen && onOpen(item)} style={{
            flex: '0 0 168px', scrollSnapAlign: 'start',
            background: C.card, border: `1px solid ${C.rule}`,
            borderRadius: 14, padding: 10, textAlign: 'left',
            cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 8,
          }}>
            <div style={{ position: 'relative' }}>
              <window.Photo name={item.name} hue={item.hue} ratio="4/3" radius={8} label={false} />
              <span style={{
                position: 'absolute', top: 6, left: 6,
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '3px 7px 3px 5px', borderRadius: 999,
                background: tint, color: inkTint,
                fontFamily: 'Geist Mono, monospace', fontSize: 9, letterSpacing: 0.8,
                textTransform: 'uppercase', fontWeight: 500,
                border: `1px solid ${C.rule}`,
              }}>
                <svg width="11" height="11" viewBox="0 0 24 24">{drinkIcons[cat.icon]}</svg>
                {cat.label}
              </span>
            </div>
            <div style={{ padding: '0 2px' }}>
              <div style={{
                fontFamily: '"Instrument Serif", serif', fontSize: 16, lineHeight: 1.15,
                color: C.ink, height: 36, overflow: 'hidden',
              }}>{item.name}</div>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                marginTop: 4,
              }}>
                <span style={{
                  fontFamily: 'Geist Mono, monospace', fontSize: 12, fontWeight: 500,
                  color: C.ink, fontVariantNumeric: 'tabular-nums',
                }}>₹{item.price}</span>
                <window.Icon.chevR s={14} c={C.inkMute} />
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
window.PairsWith = PairsWith;
